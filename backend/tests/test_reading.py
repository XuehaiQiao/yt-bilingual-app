"""读文章（V1 用户需求 #3 / specs/019）离线验收。

全部离线：URL 抓取用注入的 FakeClient（不建真实连接），LLM 用 ``reading._call_llm``
的异步桩；数据库在 conftest 的 tmp_path 下由真实 Alembic CLI 迁移（模块级模板库
复制到每个用例，避免重复跑迁移）。

覆盖：

1. 迁移 0011：四表/列/主键/索引/部分唯一索引/FK 级联/升级回滚；
2. 导入：粘贴正文（切段/标题/词数/上限）、URL 抽取（三级降级优先 trafilatura）、
   去重、跨用户隔离；
3. SSRF：私网/回环/链路本地/元数据/非 http(s)/域名解析到内网/重定向到内网；
4. 抓取边界：重定向 ≤3、2MB 上限、超时/非网页 → 422；
5. 翻译：zh/vi 分语言、幂等、只补缺失、失败标 ``[未翻译]`` 可重试、
   无可用模型、配额 429、非法语言 400；
6. 进度、列表、删除级联、跨用户 404、游客 403、未迁移 503；
7. 工具函数：词数、粘贴标题、模型输出容错解析。
"""
from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path

import httpx
import pytest

import config
import reading
import teaching_analysis
from ai import quota
from tests.conftest import SECOND_USER_EMAIL, SECOND_USER_PASSWORD, TEST_USER_EMAIL, TEST_USER_PASSWORD
from tests.migration_utils import (
    assert_alembic_ok,
    columns,
    index_names,
    revision,
    run_alembic,
    table_names,
)

TEMPLATE_DB = "reading-template"


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def migrated_template_db(tmp_path_factory):
    """模块级模板库：upgrade head（含 0011）后每个用例复制一份。"""
    path = tmp_path_factory.mktemp(TEMPLATE_DB) / "app.db"
    assert_alembic_ok(run_alembic(path, "upgrade", "head"), "upgrade head")
    return path


@pytest.fixture()
def reading_client(migrated_template_db, make_client):
    """已登录 + 已迁移到 head 的客户端（每个用例独立库）。"""
    target = Path(config.AUTH_DB_PATH)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(migrated_template_db, target)
    with make_client() as test_client:
        response = test_client.post(
            "/api/auth/signup",
            json={"email": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD},
        )
        assert response.status_code == 201, response.text
        test_client.user_id = response.json()["user"]["id"]
        yield test_client


@pytest.fixture()
def second_client(reading_client, make_client):
    """第二个登录用户（同一个临时库）。"""
    with make_client() as test_client:
        response = test_client.post(
            "/api/auth/signup",
            json={"email": SECOND_USER_EMAIL, "password": SECOND_USER_PASSWORD},
        )
        assert response.status_code == 201, response.text
        test_client.user_id = response.json()["user"]["id"]
        yield test_client


class _FakeResponse:
    def __init__(
        self,
        *,
        status_code: int = 200,
        headers: dict | None = None,
        body: bytes = b"",
        url: str = "https://example.com/article",
    ) -> None:
        self.status_code = status_code
        self.headers = dict(headers or {})
        self._body = body
        self.url = url
        self.charset_encoding = "utf-8"

    def iter_bytes(self, chunk_size: int = 65536):
        for start in range(0, len(self._body), chunk_size):
            yield self._body[start : start + chunk_size]


class _FakeStream:
    def __init__(self, response: _FakeResponse) -> None:
        self._response = response

    def __enter__(self) -> _FakeResponse:
        return self._response

    def __exit__(self, *exc) -> bool:
        return False


class _FakeClient:
    """只实现 reading.fetch_url 用到的接口：stream + 上下文管理。"""

    def __init__(self, responses: list[_FakeResponse]) -> None:
        self.responses = list(responses)
        self.urls: list[str] = []

    def __enter__(self) -> "_FakeClient":
        return self

    def __exit__(self, *exc) -> bool:
        return False

    def stream(self, method: str, url: str) -> _FakeStream:
        self.urls.append(str(url))
        if not self.responses:
            raise AssertionError(f"FakeClient 没有更多响应：{url}")
        return _FakeStream(self.responses.pop(0))


class _RaisingClient:
    def __init__(self, error: Exception) -> None:
        self.error = error

    def __enter__(self) -> "_RaisingClient":
        return self

    def __exit__(self, *exc) -> bool:
        return False

    def stream(self, method: str, url: str):
        raise self.error


@pytest.fixture()
def public_dns(monkeypatch):
    """所有域名都解析到一个公网 IP，避免测试联网做 DNS。"""
    monkeypatch.setattr(
        reading, "_resolve_host_ips", lambda host, port=None: ["93.184.216.34"]
    )


@pytest.fixture()
def fake_http(monkeypatch):
    def install(responses: list[_FakeResponse]) -> _FakeClient:
        client = _FakeClient(responses)
        monkeypatch.setattr(reading, "_new_http_client", lambda: client)
        return client

    return install


@pytest.fixture()
def force_builtin(monkeypatch):
    """强制走标准库抽取器（测试结果不依赖 trafilatura/bs4 是否安装）。"""
    monkeypatch.setattr(
        reading, "_extract_with_trafilatura", lambda html, url: None
    )
    monkeypatch.setattr(
        reading, "_extract_with_readability", lambda html, url: None
    )


class _LLMStub:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.response = _translations(0, 1, 2)
        self.error: Exception | None = None

    async def __call__(self, prompt: str, model: str) -> str:
        self.calls.append((prompt, model))
        if self.error is not None:
            raise self.error
        return self.response


@pytest.fixture()
def llm_stub(monkeypatch):
    stub = _LLMStub()
    monkeypatch.setattr(reading, "_call_llm", stub)
    monkeypatch.setattr(
        reading.quota,
        "degradation_chain",
        lambda feature=None, preferred_model=None: ["deepseek-chat"],
    )
    return stub


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------

ARTICLE_HTML = """<!doctype html>
<html><head><title>How Coffee Works | Example</title></head>
<body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<article>
  <h1>How Coffee Works</h1>
  <p>The coffee bean is actually a seed inside a bright red cherry.</p>
  <p>Roasting turns green beans brown and releases hundreds of aromas.</p>
</article>
<footer>Copyright 2026 Example</footer>
</body></html>"""


def _translations(*indices: int, text: str = "中文译文") -> str:
    return json.dumps(
        {
            "translations": [
                {"idx": index, "text": f"{text}（第 {index + 1} 段）"}
                for index in indices
            ]
        },
        ensure_ascii=False,
    )


def _vi_translations(*indices: int) -> str:
    return json.dumps(
        {
            "translations": [
                {"idx": index, "text": f"Bản dịch tiếng Việt đoạn {index + 1}."}
                for index in indices
            ]
        },
        ensure_ascii=False,
    )


def _paragraphs(count: int = 3) -> list[str]:
    return [
        f"Paragraph {index + 1} explains an idea in plain English with enough words."
        for index in range(count)
    ]


def _import_text(client, paragraphs: list[str] | None = None, title: str | None = None):
    body: dict = {"text": "\n\n".join(paragraphs or _paragraphs())}
    if title is not None:
        body["title"] = title
    return client.post("/api/article/import", json=body)


def _article_id(client, paragraphs: list[str] | None = None) -> str:
    response = _import_text(client, paragraphs)
    assert response.status_code == 200, response.text
    return response.json()["articleId"]


def _translate(client, article_id: str, lang: str = "zh-CN"):
    return client.post(
        f"/api/article/{article_id}/translate", json={"targetLang": lang}
    )


def _db_scalar(sql: str, params: tuple = ()) -> int:
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        row = conn.execute(sql, params).fetchone()
    return int(row[0]) if row else 0


def _prompt_indices(prompt: str) -> list[int]:
    payload = prompt.split("Input paragraphs:", 1)[1].strip()
    return [item["idx"] for item in json.loads(payload)]


# ---------------------------------------------------------------------------
# 1. 迁移
# ---------------------------------------------------------------------------

def test_migration_0011_schema_and_downgrade(tmp_path):
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")

    # head 已推进到 0024_account_lifecycle；0011 的四张表仍应齐全。
    assert revision(db) == "0032_pipeline_timing"
    assert {
        "articles",
        "article_paragraphs",
        "article_translations",
        "article_progress",
    } <= table_names(db)

    articles = columns(db, "articles")
    assert list(articles) == [
        "id",
        "user_id",
        "source_url",
        "title",
        "site",
        "lang",
        "word_count",
        "created_at",
    ]
    assert articles["id"]["pk"] == 1
    assert articles["user_id"]["notnull"] == 1
    assert articles["source_url"]["notnull"] == 0, "粘贴正文的 source_url 必须可空"
    assert "ix_articles_user_created" in index_names(db, "articles")
    assert "ux_articles_user_url" in index_names(db, "articles")

    paragraphs = columns(db, "article_paragraphs")
    assert paragraphs["article_id"]["pk"] == 1
    assert paragraphs["idx"]["pk"] == 2
    assert paragraphs["text"]["notnull"] == 1

    translations = columns(db, "article_translations")
    assert translations["article_id"]["pk"] == 1
    assert translations["idx"]["pk"] == 2
    assert translations["target_lang"]["pk"] == 3
    assert translations["model"]["notnull"] == 0
    assert "ix_article_translations_article_lang" in index_names(
        db, "article_translations"
    )

    progress = columns(db, "article_progress")
    assert progress["user_id"]["pk"] == 1
    assert progress["article_id"]["pk"] == 2
    assert progress["paragraph_idx"]["notnull"] == 1

    assert_alembic_ok(run_alembic(db, "downgrade", "0010_discover"), "downgrade 0010")
    assert revision(db) == "0010_discover"
    remaining = table_names(db)
    assert not {
        "articles",
        "article_paragraphs",
        "article_translations",
        "article_progress",
    } & remaining


def test_migration_cascade_and_per_user_url_uniqueness(tmp_path):
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")

    with sqlite3.connect(db) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute(
            "INSERT INTO articles (id, user_id, source_url, title, site, lang, "
            "word_count, created_at) VALUES "
            "('a1', 'u1', 'https://example.com/x', 'T', 'example.com', 'en', 2, 1)"
        )
        conn.execute(
            "INSERT INTO article_paragraphs (article_id, idx, text) VALUES ('a1', 0, 'p')"
        )
        conn.execute(
            "INSERT INTO article_translations "
            "(article_id, idx, target_lang, text, model, created_at) "
            "VALUES ('a1', 0, 'zh-CN', '译', 'deepseek-chat', 1)"
        )
        conn.execute(
            "INSERT INTO article_progress (user_id, article_id, paragraph_idx, updated_at) "
            "VALUES ('u1', 'a1', 0, 1)"
        )
        conn.commit()

        # 同 user 同 URL 唯一（部分唯一索引）
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO articles (id, user_id, source_url, title, lang, "
                "word_count, created_at) VALUES "
                "('a2', 'u1', 'https://example.com/x', 'T2', 'en', 1, 2)"
            )
        conn.rollback()

        # NULL source_url（粘贴正文）可以有多篇
        conn.execute(
            "INSERT INTO articles (id, user_id, source_url, title, lang, "
            "word_count, created_at) VALUES ('a3', 'u1', NULL, 'Paste 1', 'en', 1, 3)"
        )
        conn.execute(
            "INSERT INTO articles (id, user_id, source_url, title, lang, "
            "word_count, created_at) VALUES ('a4', 'u1', NULL, 'Paste 2', 'en', 1, 4)"
        )
        conn.commit()

        conn.execute("DELETE FROM articles WHERE id = 'a1'")
        conn.commit()
        assert conn.execute(
            "SELECT COUNT(*) FROM article_paragraphs WHERE article_id='a1'"
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM article_translations WHERE article_id='a1'"
        ).fetchone()[0] == 0
        assert conn.execute(
            "SELECT COUNT(*) FROM article_progress WHERE article_id='a1'"
        ).fetchone()[0] == 0


# ---------------------------------------------------------------------------
# 2. 导入（粘贴正文 / URL / 去重 / 上限）
# ---------------------------------------------------------------------------

def test_import_pasted_text_contract(reading_client):
    paragraphs = [
        "Learning to read English every day builds a steady habit.",
        "Short articles are easier to finish than long novels.",
    ]
    response = _import_text(reading_client, paragraphs, title="  My Reading  ")
    assert response.status_code == 200, response.text
    data = response.json()

    assert data["articleId"]
    assert data["title"] == "My Reading"
    assert data["site"] is None
    assert data["sourceUrl"] is None
    assert data["lang"] == "en"
    assert data["reused"] is False
    assert [item["text"] for item in data["paragraphs"]] == paragraphs
    assert [item["idx"] for item in data["paragraphs"]] == [0, 1]
    assert data["wordCount"] == sum(reading.count_words(p) for p in paragraphs)
    assert data["wordCount"] > 0

    detail = reading_client.get(f"/api/article/{data['articleId']}").json()
    assert detail["title"] == "My Reading"
    assert detail["targetLang"] == "zh-CN"
    assert detail["paragraphs"][0]["translation"] is None
    assert detail["stats"] == {"total": 2, "translated": 0, "untranslated": 2}
    assert detail["progress"] is None


def test_import_pasted_title_falls_back_to_first_paragraph(reading_client):
    response = _import_text(
        reading_client,
        ["A short first line", "A second paragraph that is a bit longer."],
    )
    assert response.status_code == 200
    assert response.json()["title"] == "A short first line"


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"text": "   "},
        {"url": "", "text": ""},
        {"url": "https://example.com/a", "text": "both"},
    ],
)
def test_import_rejects_missing_or_conflicting_input(reading_client, body):
    response = reading_client.post("/api/article/import", json=body)
    assert response.status_code == 400, response.text


def test_import_paragraph_and_char_limits(reading_client, monkeypatch):
    monkeypatch.setattr(config, "READING_MAX_PARAGRAPHS", 2, raising=False)
    monkeypatch.setattr(config, "READING_MAX_PARAGRAPH_CHARS", 40, raising=False)

    paragraphs = [
        "This paragraph is deliberately much longer than forty characters.",
        "This one is also deliberately much longer than forty characters.",
        "This third paragraph should be dropped by the paragraph cap.",
    ]
    response = _import_text(reading_client, paragraphs)
    assert response.status_code == 200, response.text
    data = response.json()
    assert len(data["paragraphs"]) == 2
    for paragraph in data["paragraphs"]:
        assert len(paragraph["text"]) <= 40
        assert paragraph["text"].endswith("…")


def test_extract_builtin_filters_navigation_and_link_dense(force_builtin):
    title, paragraphs, extractor = reading.extract_article(
        """
        <html><head><title>Site</title>
        <meta property="og:title" content="Real Title"></head><body>
        <nav><p>Home</p><p>About</p></nav>
        <header><p>Header text</p></header>
        <div class="sidebar"><p>Sidebar</p></div>
        <article>
          <p>This is the first real paragraph with plenty of words in it.</p>
          <p><a href="/x">click here</a><a href="/y">and here</a></p>
          <p>This is the second real paragraph, also with enough words.</p>
        </article>
        <footer><p>Footer</p></footer></body></html>
        """,
        "https://example.com/post",
    )
    assert extractor == "builtin"
    assert title == "Real Title"
    assert paragraphs == [
        "This is the first real paragraph with plenty of words in it.",
        "This is the second real paragraph, also with enough words.",
    ]


def test_extract_prefers_trafilatura_then_readability(monkeypatch):
    monkeypatch.setattr(
        reading,
        "_extract_with_trafilatura",
        lambda html, url: ("Trafilatura Title", ["first", "second"]),
    )
    title, paragraphs, extractor = reading.extract_article(
        "<html><body><p>fallback</p></body></html>", "https://example.com/a"
    )
    assert (title, paragraphs, extractor) == (
        "Trafilatura Title",
        ["first", "second"],
        "trafilatura",
    )

    monkeypatch.setattr(reading, "_extract_with_trafilatura", lambda html, url: None)
    monkeypatch.setattr(
        reading,
        "_extract_with_readability",
        lambda html, url: ("Readability Title", ["only one"]),
    )
    title, paragraphs, extractor = reading.extract_article(
        "<html><body><p>fallback</p></body></html>", "https://example.com/a"
    )
    assert (title, paragraphs, extractor) == (
        "Readability Title",
        ["only one"],
        "readability",
    )

    monkeypatch.setattr(reading, "_extract_with_readability", lambda html, url: None)
    title, paragraphs, extractor = reading.extract_article(
        "<html><head><title>Fallback</title></head><body><p>One real paragraph.</p></body></html>",
        "https://example.com/a",
    )
    assert extractor == "builtin"
    assert title == "Fallback"
    assert paragraphs == ["One real paragraph."]


def test_import_url_extracts_and_dedups(reading_client, public_dns, fake_http, force_builtin):
    client = fake_http(
        [
            _FakeResponse(
                body=ARTICLE_HTML.encode("utf-8"),
                headers={"content-type": "text/html; charset=utf-8"},
                url="https://example.com/article",
            )
        ]
    )
    body = {"url": "https://example.com/article#comments"}

    response = reading_client.post("/api/article/import", json=body)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["title"] == "How Coffee Works"
    assert data["site"] == "example.com"
    assert data["sourceUrl"] == "https://example.com/article"
    assert data["reused"] is False
    assert [p["text"] for p in data["paragraphs"]] == [
        "The coffee bean is actually a seed inside a bright red cherry.",
        "Roasting turns green beans brown and releases hundreds of aromas.",
    ]
    assert data["wordCount"] > 10
    assert client.urls == ["https://example.com/article"]

    db_count = _db_scalar("SELECT COUNT(*) FROM articles")
    assert db_count == 1

    # 重复 import：直接复用，不再发 HTTP。
    again = reading_client.post("/api/article/import", json=body)
    assert again.status_code == 200, again.text
    assert again.json()["articleId"] == data["articleId"]
    assert again.json()["reused"] is True
    assert len(client.urls) == 1, "重复 import 不应再次抓取"
    assert _db_scalar("SELECT COUNT(*) FROM articles") == 1


def test_import_url_dedups_by_final_redirected_url(
    reading_client, public_dns, fake_http, force_builtin
):
    client = fake_http(
        [
            _FakeResponse(
                status_code=302,
                headers={"location": "https://example.com/new"},
                url="https://example.com/old",
            ),
            _FakeResponse(
                body=ARTICLE_HTML.encode("utf-8"),
                headers={"content-type": "text/html"},
                url="https://example.com/new",
            ),
        ]
    )
    first = reading_client.post(
        "/api/article/import", json={"url": "https://example.com/old"}
    )
    assert first.status_code == 200, first.text
    assert first.json()["sourceUrl"] == "https://example.com/new"
    assert len(client.urls) == 2

    second = reading_client.post(
        "/api/article/import", json={"url": "https://example.com/new"}
    )
    assert second.status_code == 200, second.text
    assert second.json()["articleId"] == first.json()["articleId"]
    assert second.json()["reused"] is True
    assert len(client.urls) == 2, "最终 URL 已存在时不应重新抓取"


def test_import_url_same_url_different_users_are_isolated(
    reading_client, second_client, public_dns, fake_http, force_builtin
):
    client = fake_http(
        [
            _FakeResponse(
                body=ARTICLE_HTML.encode("utf-8"),
                headers={"content-type": "text/html"},
                url="https://example.com/article",
            ),
            _FakeResponse(
                body=ARTICLE_HTML.encode("utf-8"),
                headers={"content-type": "text/html"},
                url="https://example.com/article",
            ),
        ]
    )
    body = {"url": "https://example.com/article"}
    first = reading_client.post("/api/article/import", json=body)
    second = second_client.post("/api/article/import", json=body)
    assert first.status_code == second.status_code == 200
    assert first.json()["articleId"] != second.json()["articleId"]
    assert len(client.urls) == 2

    # 第二个用户看不到第一个用户的文章。
    assert second_client.get(f"/api/article/{first.json()['articleId']}").status_code == 404
    listed = second_client.get("/api/articles").json()["articles"]
    assert [item["articleId"] for item in listed] == [second.json()["articleId"]]


# ---------------------------------------------------------------------------
# 3. SSRF / 抓取失败
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/secret",
        "http://10.1.2.3/secret",
        "http://192.168.1.10/secret",
        "http://169.254.169.254/latest/meta-data/",
        "http://100.64.0.1/secret",
        "http://[::1]/secret",
        "http://[fc00::1]/secret",
        "http://0.0.0.0/secret",
        "https://metadata.google.internal/computeMetadata/v1/",
        "file:///etc/passwd",
        "ftp://example.com/a",
    ],
)
def test_import_url_rejects_ssrf_and_bad_scheme(reading_client, url):
    response = reading_client.post("/api/article/import", json={"url": url})
    assert response.status_code == 422, response.text
    assert _db_scalar("SELECT COUNT(*) FROM articles") == 0


def test_import_url_rejects_hostname_resolving_to_private(reading_client, monkeypatch):
    monkeypatch.setattr(
        reading, "_resolve_host_ips", lambda host, port=None: ["10.0.0.5"]
    )
    response = reading_client.post(
        "/api/article/import", json={"url": "http://intranet.example/article"}
    )
    assert response.status_code == 422, response.text
    assert "内网" in response.json()["detail"]


def test_import_url_rejects_redirect_to_private(reading_client, monkeypatch, fake_http):
    def dns(host, port=None):
        return ["93.184.216.34"] if host == "example.com" else ["127.0.0.1"]

    monkeypatch.setattr(reading, "_resolve_host_ips", dns)
    client = fake_http(
        [
            _FakeResponse(
                status_code=302,
                headers={"location": "http://127.0.0.1/secret"},
                url="https://example.com/start",
            )
        ]
    )
    response = reading_client.post(
        "/api/article/import", json={"url": "https://example.com/start"}
    )
    assert response.status_code == 422, response.text
    assert len(client.urls) == 1, "重定向目标应在发请求前被拒绝"


def test_import_url_redirect_limit(reading_client, public_dns, fake_http):
    redirects = [
        _FakeResponse(
            status_code=301,
            headers={"location": f"https://example.com/step-{index + 1}"},
        )
        for index in range(4)
    ]
    client = fake_http(redirects)
    response = reading_client.post(
        "/api/article/import", json={"url": "https://example.com/start"}
    )
    assert response.status_code == 422, response.text
    assert "重定向次数超过 3 次" in response.json()["detail"]
    assert len(client.urls) == 4


def test_import_url_size_limit(reading_client, public_dns, fake_http, monkeypatch):
    monkeypatch.setattr(config, "READING_MAX_FETCH_BYTES", 1024, raising=False)
    fake_http(
        [
            _FakeResponse(
                body=b"<html><body>" + b"x" * 2048 + b"</body></html>",
                headers={"content-type": "text/html"},
            )
        ]
    )
    response = reading_client.post(
        "/api/article/import", json={"url": "https://example.com/big"}
    )
    assert response.status_code == 422, response.text
    assert "上限" in response.json()["detail"]


def test_import_url_timeout_and_non_html(reading_client, public_dns, monkeypatch):
    monkeypatch.setattr(
        reading,
        "_new_http_client",
        lambda: _RaisingClient(httpx.ReadTimeout("timed out")),
    )
    timeout = reading_client.post(
        "/api/article/import", json={"url": "https://example.com/slow"}
    )
    assert timeout.status_code == 422, timeout.text
    assert "网络错误" in timeout.json()["detail"]

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def stream(self, method, url):
            return _FakeStream(
                _FakeResponse(
                    headers={"content-type": "application/pdf"},
                    body=b"%PDF-1.4",
                )
            )

    monkeypatch.setattr(reading, "_new_http_client", lambda: _Client())
    pdf = reading_client.post(
        "/api/article/import", json={"url": "https://example.com/file.pdf"}
    )
    assert pdf.status_code == 422, pdf.text
    assert "Content-Type" in pdf.json()["detail"]


def test_import_url_without_extractable_paragraphs(reading_client, public_dns, fake_http, force_builtin):
    fake_http(
        [
            _FakeResponse(
                body=b"<html><head><title>Empty</title></head><body><nav>Home</nav></body></html>",
                headers={"content-type": "text/html"},
            )
        ]
    )
    response = reading_client.post(
        "/api/article/import", json={"url": "https://example.com/empty"}
    )
    assert response.status_code == 422, response.text
    assert "没有抽取到正文段落" in response.json()["detail"]


# ---------------------------------------------------------------------------
# 4. 翻译
# ---------------------------------------------------------------------------

def test_translate_zh_then_get(reading_client, llm_stub):
    article_id = _article_id(reading_client)

    response = _translate(reading_client, article_id, "zh-CN")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["articleId"] == article_id
    assert data["targetLang"] == "zh-CN"
    assert data["status"] == "done"
    assert data["total"] == 3
    assert data["translated"] == 3
    assert data["failed"] == 0
    assert data["failedIndices"] == []
    assert data["batches"] == 1
    assert data["model"]
    assert len(llm_stub.calls) == 1
    assert _prompt_indices(llm_stub.calls[0][0]) == [0, 1, 2]

    assert _db_scalar("SELECT COUNT(*) FROM article_translations") == 3

    detail = reading_client.get(
        f"/api/article/{article_id}?targetLang=zh-CN"
    ).json()
    assert detail["stats"] == {"total": 3, "translated": 3, "untranslated": 0}
    for index, paragraph in enumerate(detail["paragraphs"]):
        assert paragraph["translation"] == f"中文译文（第 {index + 1} 段）"
        assert paragraph["translationFailed"] is False
        assert paragraph["translationModel"]


def test_translate_is_idempotent(reading_client, llm_stub):
    article_id = _article_id(reading_client)
    assert _translate(reading_client, article_id).status_code == 200
    assert len(llm_stub.calls) == 1

    again = _translate(reading_client, article_id)
    assert again.status_code == 200, again.text
    data = again.json()
    assert data["status"] == "cached"
    assert data["batches"] == 0
    assert data["translated"] == 3
    assert data["failed"] == 0
    assert len(llm_stub.calls) == 1, "已有译文不得重译"


def test_translate_vi_is_isolated_from_zh(reading_client, llm_stub):
    article_id = _article_id(reading_client)
    assert _translate(reading_client, article_id, "zh-CN").status_code == 200

    llm_stub.response = _vi_translations(0, 1, 2)
    response = _translate(reading_client, article_id, "vi-VN")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "done"
    assert len(llm_stub.calls) == 2
    assert _db_scalar(
        "SELECT COUNT(*) FROM article_translations WHERE target_lang='zh-CN'"
    ) == 3
    assert _db_scalar(
        "SELECT COUNT(*) FROM article_translations WHERE target_lang='vi-VN'"
    ) == 3

    vi = reading_client.get(
        f"/api/article/{article_id}?targetLang=vi-VN"
    ).json()
    assert vi["paragraphs"][0]["translation"].startswith("Bản dịch")
    zh = reading_client.get(
        f"/api/article/{article_id}?targetLang=zh-CN"
    ).json()
    assert zh["paragraphs"][0]["translation"].startswith("中文译文")


def test_translate_article_first_batch_small_then_steady(reading_client, llm_stub):
    """P2-33：20 段 → 首批 5 段 + 稳定批 15 段，每批仍各扣 1 次配额。"""
    paragraphs = _paragraphs(20)
    article_id = _article_id(reading_client, paragraphs)
    llm_stub.response = _translations(*range(20))

    response = _translate(reading_client, article_id)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["status"] == "done"
    assert data["total"] == 20
    assert data["translated"] == 20
    assert data["failed"] == 0
    assert data["batches"] == 2
    assert len(llm_stub.calls) == 2
    assert _prompt_indices(llm_stub.calls[0][0]) == list(range(5)), "首批 5 段"
    assert _prompt_indices(llm_stub.calls[1][0]) == list(range(5, 20))

    detail = reading_client.get(
        f"/api/article/{article_id}?targetLang=zh-CN"
    ).json()
    assert detail["stats"] == {"total": 20, "translated": 20, "untranslated": 0}


def test_translate_only_fills_missing_paragraphs(reading_client, llm_stub):
    article_id = _article_id(reading_client)
    assert _translate(reading_client, article_id).status_code == 200
    assert len(llm_stub.calls) == 1

    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        conn.execute(
            "UPDATE article_translations SET text = ? "
            "WHERE article_id = ? AND idx = 1 AND target_lang = 'zh-CN'",
            (reading.UNTRANSLATED_MARKER, article_id),
        )
        conn.commit()

    llm_stub.response = _translations(1)
    response = _translate(reading_client, article_id)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["status"] == "done"
    assert data["translated"] == 3
    assert data["failed"] == 0
    assert len(llm_stub.calls) == 2
    assert _prompt_indices(llm_stub.calls[1][0]) == [1], "只应翻译缺失段"

    # 已有两段没被覆盖
    detail = reading_client.get(f"/api/article/{article_id}").json()
    assert detail["paragraphs"][0]["translation"] == "中文译文（第 1 段）"
    assert detail["paragraphs"][1]["translation"] == "中文译文（第 2 段）"
    assert detail["paragraphs"][2]["translation"] == "中文译文（第 3 段）"


def test_translate_failure_marks_untranslated_and_retries(reading_client, llm_stub):
    article_id = _article_id(reading_client)
    llm_stub.error = RuntimeError("provider down")

    first = _translate(reading_client, article_id)
    assert first.status_code == 200, first.text
    data = first.json()
    assert data["status"] == "partial"
    assert data["failed"] == 3
    assert data["failedIndices"] == [0, 1, 2]
    assert data["batches"] == 1
    assert _db_scalar(
        "SELECT COUNT(*) FROM article_translations "
        f"WHERE text = '{reading.UNTRANSLATED_MARKER}'"
    ) == 3
    rows = sqlite3.connect(config.AUTH_DB_PATH).execute(
        "SELECT model FROM article_translations"
    ).fetchall()
    assert all(row[0] is None for row in rows)

    llm_stub.error = None
    llm_stub.response = _translations(0, 1, 2)
    second = _translate(reading_client, article_id)
    assert second.status_code == 200, second.text
    assert second.json()["status"] == "done"
    assert len(llm_stub.calls) == 2
    assert _db_scalar(
        "SELECT COUNT(*) FROM article_translations "
        f"WHERE text = '{reading.UNTRANSLATED_MARKER}'"
    ) == 0


def test_translate_without_available_model_marks_markers(reading_client, llm_stub, monkeypatch):
    article_id = _article_id(reading_client)
    monkeypatch.setattr(
        reading.quota,
        "degradation_chain",
        lambda feature=None, preferred_model=None: [],
    )

    first = _translate(reading_client, article_id)
    assert first.status_code == 200, first.text
    data = first.json()
    assert data["status"] == "partial"
    assert data["failed"] == 3
    assert data["batches"] == 0
    assert data["model"] is None
    assert len(llm_stub.calls) == 0
    assert _db_scalar(
        "SELECT COUNT(*) FROM article_translations "
        f"WHERE text = '{reading.UNTRANSLATED_MARKER}'"
    ) == 3

    monkeypatch.setattr(
        reading.quota,
        "degradation_chain",
        lambda feature=None, preferred_model=None: ["deepseek-chat"],
    )
    second = _translate(reading_client, article_id)
    assert second.status_code == 200
    assert second.json()["status"] == "done"
    assert second.json()["translated"] == 3


def test_translate_quota_exceeded_returns_429(reading_client, llm_stub, monkeypatch):
    article_id = _article_id(reading_client)

    def _raise(*args, **kwargs):
        raise quota.QuotaExceeded(
            "reading", day="2026-11-15", used_units=60, limit_units=60
        )

    monkeypatch.setattr(reading.quota, "check_and_consume_quota", _raise)
    response = _translate(reading_client, article_id)
    assert response.status_code == 429, response.text
    assert "额度" in response.json()["detail"]
    assert len(llm_stub.calls) == 0
    assert _db_scalar("SELECT COUNT(*) FROM article_translations") == 0


def test_translate_invalid_target_lang_is_400(reading_client, llm_stub):
    article_id = _article_id(reading_client)
    response = _translate(reading_client, article_id, "fr-FR")
    assert response.status_code == 400, response.text
    assert "不支持的语言" in response.json()["detail"]


def test_translation_parser_tolerates_fences_and_partial_output():
    raw = """```json
    {"translations": [
      {"idx": 0, "text": "第一段"},
      {"index": "2", "translation": "第三段"},
      {"idx": 9, "text": "越界段"},
      {"idx": 1, "text": "  "}
    ]}
    ```"""
    parsed = reading._parse_translation_json(raw, {0, 1, 2}, "zh-CN")
    assert parsed == {0: "第一段", 2: "第三段"}

    # 越南语输出含 CJK → 该段丢弃（等重试）
    assert reading._parse_translation_json(
        '{"translations":[{"idx":0,"text":"中文泄漏"}]}', {0}, "vi-VN"
    ) == {}
    # 数组形态也接受
    assert reading._parse_translation_json(
        '[{"idx":0,"text":"Đoạn văn."}]', {0}, "vi-VN"
    ) == {0: "Đoạn văn."}


# ---------------------------------------------------------------------------
# 5. 进度 / 列表 / 删除 / 身份隔离
# ---------------------------------------------------------------------------

def test_articles_list_newest_first(reading_client):
    first = _import_text(reading_client, ["First article paragraph."], title="First")
    second = _import_text(reading_client, ["Second article paragraph."], title="Second")
    assert first.status_code == second.status_code == 200
    listed = reading_client.get("/api/articles").json()["articles"]
    assert [item["title"] for item in listed] == ["Second", "First"]


def test_progress_save_get_and_list(reading_client):
    article_id = _article_id(reading_client)
    response = reading_client.put(
        f"/api/article/{article_id}/progress", json={"paragraphIdx": 1}
    )
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["ok"] is True
    assert saved["articleId"] == article_id
    assert saved["paragraphIdx"] == 1
    assert saved["updatedAt"] > 0

    detail = reading_client.get(f"/api/article/{article_id}").json()
    assert detail["progress"]["paragraphIdx"] == 1
    assert detail["progress"]["updatedAt"] == saved["updatedAt"]

    listed = reading_client.get("/api/articles").json()["articles"]
    assert len(listed) == 1
    assert listed[0]["articleId"] == article_id
    assert listed[0]["paragraphCount"] == 3
    assert listed[0]["progress"]["paragraphIdx"] == 1

    # 覆盖写
    second = reading_client.put(
        f"/api/article/{article_id}/progress", json={"paragraph_idx": 0}
    )
    assert second.status_code == 200, second.text
    assert reading_client.get(f"/api/article/{article_id}").json()["progress"][
        "paragraphIdx"
    ] == 0


@pytest.mark.parametrize("paragraph_idx", [-1, 3, 999])
def test_progress_out_of_range_is_400(reading_client, paragraph_idx):
    article_id = _article_id(reading_client)
    response = reading_client.put(
        f"/api/article/{article_id}/progress", json={"paragraphIdx": paragraph_idx}
    )
    assert response.status_code == 400, response.text


def test_progress_missing_field_is_422(reading_client):
    article_id = _article_id(reading_client)
    response = reading_client.put(f"/api/article/{article_id}/progress", json={})
    assert response.status_code == 422


def test_cross_user_isolation_and_delete_cascade(
    reading_client, second_client, llm_stub
):
    article_id = _article_id(reading_client)
    assert _translate(reading_client, article_id).status_code == 200
    reading_client.put(
        f"/api/article/{article_id}/progress", json={"paragraphIdx": 2}
    )

    # 另一个用户：读/译/进度/删一律 404，不泄露存在性。
    assert second_client.get(f"/api/article/{article_id}").status_code == 404
    assert _translate(second_client, article_id).status_code == 404
    assert second_client.put(
        f"/api/article/{article_id}/progress", json={"paragraphIdx": 0}
    ).status_code == 404
    assert second_client.delete(f"/api/article/{article_id}").status_code == 404
    assert second_client.get("/api/articles").json()["articles"] == []

    # 本人删除：段落/译文/进度一并清理。
    deleted = reading_client.delete(f"/api/article/{article_id}")
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {"ok": True, "articleId": article_id}
    assert reading_client.get(f"/api/article/{article_id}").status_code == 404
    assert _db_scalar("SELECT COUNT(*) FROM articles") == 0
    assert _db_scalar("SELECT COUNT(*) FROM article_paragraphs") == 0
    assert _db_scalar("SELECT COUNT(*) FROM article_translations") == 0
    assert _db_scalar("SELECT COUNT(*) FROM article_progress") == 0


def test_guests_and_anonymous_are_403(make_client):
    with make_client() as guest:
        assert guest.post(
            "/api/article/import", json={"text": "Hello world. This is a test."}
        ).status_code == 403
        assert guest.get("/api/articles").status_code == 403
        assert guest.post(
            "/api/article/abc/translate", json={"targetLang": "zh-CN"}
        ).status_code == 403


def test_unmigrated_database_returns_503(client):
    response = client.post(
        "/api/article/import", json={"text": "A paragraph before migrations."}
    )
    assert response.status_code == 503, response.text
    assert "0011_reading" in response.json()["detail"]


def test_count_words_and_pasted_title():
    assert reading.count_words("Hello world. It's 2026 — well-written!") == 5
    assert reading.count_words("") == 0
    title = reading.fallback_pasted_title(
        ["A very long first paragraph " + "word " * 40]
    )
    assert title.endswith("…")
    assert len(title) <= 81


# ---------------------------------------------------------------------------
# 8. 教学分析失败可见（P0-04）
# ---------------------------------------------------------------------------

def _translated_article(client, llm_stub) -> str:
    """导入并译完三段的文章（分析的前置条件：每个段落都有译文）。"""
    article_id = _article_id(client)
    response = _translate(client, article_id, "zh-CN")
    assert response.status_code == 200, response.text
    return article_id


def _raise_analysis_quota(user_id, feature, units=1, **kwargs):
    raise quota.QuotaExceeded(
        "analysis",
        day="2026-11-22",
        used_units=30,
        limit_units=30,
        user_id=user_id,
    )


def test_article_analysis_quota_failure_is_visible_not_silent(
    reading_client, llm_stub, monkeypatch
):
    """配额 429 在 payload 里给出原因；接口仍 200，正文/译文完整。"""
    article_id = _translated_article(reading_client, llm_stub)
    monkeypatch.setattr(quota, "check_and_consume_quota", _raise_analysis_quota)

    response = reading_client.get(
        f"/api/article/{article_id}",
        params={"targetLang": "zh-CN", "level": "moonwalk"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()

    assert payload["analysisUnavailableReason"] == "quota_exceeded"
    assert payload["analysisUsed"] == 30
    assert payload["analysisLimit"] == 30
    assert payload["analysisResetAt"].startswith("2026-11-23T00:00:00")
    # 正文/译文没有被失败连带：仍然完整可读。
    assert len(payload["paragraphs"]) == 3
    assert payload["paragraphs"][0]["translation"] == "中文译文（第 1 段）"
    # 失败不能伪装成「有分析」。
    assert "analysisLevel" not in payload
    assert "idioms" not in payload


def test_article_analysis_budget_failure_is_visible(
    reading_client, llm_stub, monkeypatch
):
    """预算 429 → budget_exceeded（与功能配额区分，前端文案不同）。"""
    article_id = _translated_article(reading_client, llm_stub)

    def raise_budget(user_id, feature, units=1, **kwargs):
        raise quota.BudgetExceeded(
            "user", day="2026-11-22", spend_usd=1.2, limit_usd=1.0, user_id=user_id
        )

    monkeypatch.setattr(quota, "check_and_consume_quota", raise_budget)

    payload = reading_client.get(
        f"/api/article/{article_id}",
        params={"targetLang": "zh-CN", "level": "moonwalk"},
    ).json()
    assert payload["analysisUnavailableReason"] == "budget_exceeded"
    assert payload["analysisResetAt"].startswith("2026-11-23T00:00:00")
    assert "analysisUsed" not in payload
    assert len(payload["paragraphs"]) == 3


def test_article_analysis_model_failure_is_visible_and_retryable(
    reading_client, llm_stub, monkeypatch
):
    """模型失败 → model_error；同一请求修好模型后可成功（不写半成品）。"""
    article_id = _translated_article(reading_client, llm_stub)

    # 第一次：模型全挂 → 原因可见。
    async def failing_generate(prompt, model=None):
        raise RuntimeError("model unavailable")

    monkeypatch.setattr(teaching_analysis.llm, "generate_json_async", failing_generate)
    first = reading_client.get(
        f"/api/article/{article_id}",
        params={"targetLang": "zh-CN", "level": "moonwalk"},
    )
    assert first.status_code == 200, first.text
    assert first.json()["analysisUnavailableReason"] == "model_error"
    assert first.json()["paragraphs"][0]["translation"]

    # 重试（第二次 GET）走同一路径：模型恢复后分析合并、原因消失。
    async def ok_generate(prompt, model=None):
        payload = first.json()["paragraphs"]
        return json.dumps({
            "highlights": [],
            "idioms": [{
                "blockId": payload[0]["idx"],
                "phrase": "Paragraph 1",
                "meaning": "第一段",
                "quote": payload[0]["text"],
            }],
            "culture": [],
        }, ensure_ascii=False)

    monkeypatch.setattr(teaching_analysis.llm, "generate_json_async", ok_generate)
    second = reading_client.get(
        f"/api/article/{article_id}",
        params={"targetLang": "zh-CN", "level": "moonwalk"},
    )
    assert second.status_code == 200, second.text
    retried = second.json()
    assert "analysisUnavailableReason" not in retried
    assert retried["analysisLevel"] == "moonwalk"
    assert retried["idioms"][0]["phrase"] == "Paragraph 1"


def test_article_analysis_cache_hit_costs_no_quota_and_hides_reason(
    reading_client, llm_stub
):
    """缓存命中：零模型/零配额，payload 无失败原因（免费库同款路径）。"""
    article_id = _translated_article(reading_client, llm_stub)
    detail = reading_client.get(
        f"/api/article/{article_id}?targetLang=zh-CN"
    ).json()
    blocks = [
        {"id": p["idx"], "text": p["text"], "translation": p["translation"]}
        for p in detail["paragraphs"]
    ]
    normalized = teaching_analysis.normalize_blocks(blocks)
    level = "liftoff"
    # 缓存命中判定会按该等级的候选词重新核对：必须有可核对的 zh_word，
    # 否则视为旧规则产出的过期高亮。这里按真实候选生成一份「有效」缓存。
    candidates = teaching_analysis._candidate_words_for_blocks(normalized, level)
    highlights = {
        str(block["id"]): [
            {"en_word": word, "zh_word": block["zh"][:2] or "--"}
            for word in candidates.get(str(block["id"]), [])
        ]
        for block in normalized
    }
    teaching_analysis.save_cached(
        f"article:{article_id}",
        teaching_analysis.content_hash(normalized),
        level,
        "zh-CN",
        {
            "analysisVersion": teaching_analysis.ANALYSIS_VERSION,
            "level": level,
            "targetLang": "zh-CN",
            "highlights": highlights,
            "idioms": [{
                "blockId": 0,
                "phrase": "Paragraph 1",
                "meaning": "第一段",
                "quote": detail["paragraphs"][0]["text"],
            }],
            "culture": [],
        },
    )

    payload = reading_client.get(
        f"/api/article/{article_id}",
        params={"targetLang": "zh-CN", "level": level},
    ).json()
    assert payload["analysisLevel"] == level
    assert payload["idioms"][0]["phrase"] == "Paragraph 1"
    assert "analysisUnavailableReason" not in payload
    assert _db_scalar(
        "SELECT COUNT(*) FROM ai_quota WHERE feature = 'analysis'"
    ) == 0


# ---------------------------------------------------------------------------
# 4d. 配额单位（P2-34）：1 单位 = 10 段，多批按累计段数分配
# ---------------------------------------------------------------------------

def _quota_used(user_id: str, feature: str) -> int:
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        row = conn.execute(
            "SELECT used_units FROM ai_quota WHERE user_id = ? AND feature = ?",
            (user_id, feature),
        ).fetchone()
    return int(row[0]) if row else 0


@pytest.mark.parametrize(("count", "expected_units"), [(10, 1), (11, 2), (20, 2)])
def test_translate_article_charges_units_by_paragraphs(
    reading_client, llm_stub, count, expected_units
):
    """10 段 = 1 单位、11 段 = 2 单位；首批 5 段 + 稳定 15 段不重复取整。"""
    paragraphs = _paragraphs(count)
    article_id = _article_id(reading_client, paragraphs)
    llm_stub.response = _translations(*range(count))

    response = _translate(reading_client, article_id)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["status"] == "done"
    assert data["translated"] == count
    # 10 段切成 5+5 两批，但只占 1 单位；11 段 = 5+6 → 2 单位。
    assert data["batches"] == (2 if count > 5 else 1)
    assert _quota_used(reading_client.user_id, "reading") == expected_units


def test_translate_cached_article_charges_no_extra_units(reading_client, llm_stub):
    article_id = _article_id(reading_client, _paragraphs(20))
    llm_stub.response = _translations(*range(20))

    first = _translate(reading_client, article_id)
    assert first.status_code == 200
    assert first.json()["batches"] == 2
    used = _quota_used(reading_client.user_id, "reading")
    assert used == 2

    again = _translate(reading_client, article_id)
    assert again.status_code == 200
    assert again.json()["status"] == "cached"
    assert again.json()["batches"] == 0
    assert _quota_used(reading_client.user_id, "reading") == used
    assert len(llm_stub.calls) == 2, "只调用两批，不重译"
