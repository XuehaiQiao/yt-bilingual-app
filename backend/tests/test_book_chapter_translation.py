"""内置公版书库「按需翻译 + 全局缓存」的离线验收（用户需求 1）。

覆盖：

1. 迁移 0019：全局缓存表 ``book_chapter_translations`` 的列/三列主键/索引/回滚；
2. GET：无缓存 ``zh:null`` + ``translationStatus=missing``（兼容旧行为）；
   本地书稿命中 ``cached``；目标语言隔离；非法语言 400；
3. POST：只翻缺失段、按段落下标对齐、写全局缓存、返回完整章节 + ``cached``；
   再 POST 命中缓存不调模型/不再记账；翻译成功后 GET 自动带 zh；
4. 段落对齐：模型乱序/多返/漏返都不错位；漏返段落留 null 可重试且只补缺失段；
5. 失败恢复：模型全部失败 502 且不写半成品；重试成功；源站失败 503 不花钱；
6. 目标语言：vi-VN 与 zh-CN 缓存隔离；vi 输出中文（CJK）判失败；
7. 并发：同一 (book, chapter, lang) 同时请求只调一次模型，后到者复用结果；
8. 限流：每 IP 每天 N 章；缓存命中不占名额；超限 429 + Retry-After；
9. 大小/超时：超长章节 413 不调模型；整章超时 504；
10. 账本：真实 LLM 路径下成本记入 ``ai_usage``（feature=books），缓存命中不计费；
11. 原文不落库、不写 content/books；缓存表不可用时 GET 照常可读、POST 提示迁移；
12. 公开/游客可用，且不下发游客 Cookie。

全部离线：公版源抓取替换 ``books.fetch_source_text``，模型替换
``book_translation._call_llm``（账本用例替换 provider 底层函数走真实账本链路）；
数据库在 conftest 的 tmp_path 下用真实 Alembic CLI 迁移。
"""
from __future__ import annotations

import asyncio
import json
import re
import shutil
import sqlite3
from pathlib import Path

import pytest

import billing
import book_translation
import books
import config
import llm
from tests.migration_utils import (
    assert_alembic_ok,
    columns,
    index_names,
    revision,
    run_alembic,
    table_names,
)

TEMPLATE_DB = "book-translation-template"
SOURCE_URL = "https://www.gutenberg.org/cache/epub/999/pg999.txt"
HEAD = "0029_word_state_definition"

# 四个章节：1 有完整本地中译；2/3 完全未译；4 只有第一段本地中译。
SOURCE = """*** START OF THE PROJECT GUTENBERG EBOOK TEST BOOK ***

Chapter One

One alpha.

One beta.

Chapter Two

Two alpha.

Two beta.

Chapter Three

Three alpha.

Three beta.

Chapter Four

Four alpha.

Four beta.

*** END OF THE PROJECT GUTENBERG EBOOK TEST BOOK ***
"""


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------


def _manifest() -> dict:
    book = {
        "id": "test-book",
        "title": "Test Book",
        "titleZh": "测试书",
        "author": "Test Author",
        "year": 1900,
        "level": "B1",
        "status": "available",
        "source": "Project Gutenberg",
        "license": "Public domain in the US",
        "publicDomainBasis": "First published in 1900; US public domain as of 2026.",
        "sourceUrl": SOURCE_URL,
        "catalogUrl": "https://www.gutenberg.org/ebooks/999",
        "gutenbergId": 999,
        "words": 100,
        "totalChapters": 4,
        "parser": {"mode": "anchors"},
        "chapters": [
            {"n": 1, "title": "Chapter One", "anchor": "Chapter One"},
            {"n": 2, "title": "Chapter Two", "anchor": "Chapter Two"},
            {"n": 3, "title": "Chapter Three", "anchor": "Chapter Three"},
            {"n": 4, "title": "Chapter Four", "anchor": "Chapter Four"},
        ],
    }
    return {
        "_meta": {"schema": "books.v2"},
        "series": [
            {
                "id": "test-series",
                "title": "测试系列",
                "author": "Test Author",
                "description": "用于离线测试的系列。",
                "excluded": [],
                "books": [book],
            }
        ],
    }


def _write_local(chapter_dir: Path, number: int, title: str, paragraphs: list[str]) -> None:
    payload = {
        "schema": "books.chapter.zh.v1",
        "bookId": "test-book",
        "chapter": number,
        "title": title,
        "paragraphs": paragraphs,
        "meta": {"promptVersion": "books-zh.v1", "model": "bundled-test"},
    }
    (chapter_dir / f"{number}.zh.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


def _write_fixture(root: Path) -> Path:
    directory = root / "books"
    chapter_dir = directory / "test-book" / "chapters"
    chapter_dir.mkdir(parents=True, exist_ok=True)
    (directory / "books.json").write_text(
        json.dumps(_manifest(), ensure_ascii=False), encoding="utf-8"
    )
    _write_local(
        chapter_dir, 1, "第一章 测试", ["第一章第一段译文。", "第一章第二段译文。"]
    )
    _write_local(chapter_dir, 4, "第四章 测试", ["第四章第一段译文。"])
    return directory


@pytest.fixture(scope="module")
def migrated_template_db(tmp_path_factory):
    path = tmp_path_factory.mktemp(TEMPLATE_DB) / "app.db"
    assert_alembic_ok(run_alembic(path, "upgrade", "head"), "upgrade head")
    return path


@pytest.fixture(autouse=True)
def isolated_book_translation(
    isolated_data, tmp_path, migrated_template_db, monkeypatch
):
    """每个用例：隔离书单/数据库/进程锁，公版源与模型调用全部离线替换。"""
    directory = _write_fixture(tmp_path)
    monkeypatch.setattr(config, "BOOKS_DIR", str(directory), raising=False)
    # 每个用例一份真实迁移过的库（模板库复制，避免重复跑 Alembic）。
    target = Path(config.AUTH_DB_PATH)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(migrated_template_db, target)
    books.reset_cache()
    book_translation.reset_locks()
    book_translation._warned_unavailable = False
    monkeypatch.setattr(
        books,
        "fetch_source_text",
        lambda url, timeout=None: (SOURCE, url),
    )
    # 测试里不真的按 provider 节奏停顿。
    monkeypatch.setattr(llm, "batch_pause", lambda model: 0.0)
    yield directory
    books.reset_cache()
    book_translation.reset_locks()


@pytest.fixture()
def public_client(isolated_book_translation, make_client):
    """公开路由客户端：不登录、不注册，验证游客/匿名路径的可用性。"""
    with make_client() as client:
        yield client


@pytest.fixture()
def logged_in_client(isolated_book_translation, make_client):
    with make_client() as client:
        response = client.post(
            "/api/auth/signup",
            json={"email": "books-user@example.com", "password": "test-password-123"},
        )
        assert response.status_code == 201, response.text
        client.user_id = response.json()["user"]["id"]
        yield client


class LLMStub:
    """按 prompt 里的 ``idx`` 返回译文；可配置乱序/多返/漏返/失败/延迟。"""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.reply: str | None = None
        self.fail = False
        self.delay = 0.0
        self.drop: set[int] = set()
        self.extra = False
        self.shuffle = False

    async def __call__(self, prompt: str, model: str) -> str:
        self.calls.append(prompt)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            raise RuntimeError("fake LLM unavailable")
        if self.reply is not None:
            return self.reply
        indices = sorted({int(value) for value in re.findall(r'"idx":\s*(\d+)', prompt)})
        vietnamese = "Vietnamese" in prompt
        items = []
        for index in indices:
            if index in self.drop:
                continue
            text = f"Bản dịch đoạn {index}" if vietnamese else f"译文段落 {index}"
            items.append({"idx": index, "text": text})
        if self.extra:
            items.append({"idx": 999, "text": "多出来的译文"})
        if self.shuffle:
            items.reverse()
        return json.dumps({"translations": items}, ensure_ascii=False)


@pytest.fixture()
def llm_stub(monkeypatch):
    stub = LLMStub()
    monkeypatch.setattr(book_translation, "_call_llm", stub)
    return stub


def _cache_rows() -> list[sqlite3.Row]:
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(
            "SELECT * FROM book_chapter_translations "
            "ORDER BY chapter_no, target_lang"
        ).fetchall()


def _cache_paragraphs(number: int, lang: str = "zh-CN") -> list[str | None]:
    rows = _cache_rows()
    row = next(
        (
            item
            for item in rows
            if item["chapter_no"] == number and item["target_lang"] == lang
        ),
        None,
    )
    assert row is not None, f"缺少缓存：chapter={number} lang={lang}"
    return json.loads(row["paragraphs_json"])


def _usage_rows(feature: str = "books") -> list[tuple]:
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        return conn.execute(
            "SELECT feature, calls, target_lang, user_id, input_tokens, output_tokens "
            "FROM ai_usage WHERE feature = ? ORDER BY id",
            (feature,),
        ).fetchall()


# ---------------------------------------------------------------------------
# 1. 迁移 0019
# ---------------------------------------------------------------------------


def test_migration_0019_schema_pk_index_and_downgrade(tmp_path):
    db = tmp_path / "schema.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    assert revision(db) == HEAD
    assert "book_chapter_translations" in table_names(db)

    cache_columns = columns(db, "book_chapter_translations")
    assert list(cache_columns) == [
        "book_id",
        "chapter_no",
        "target_lang",
        "paragraphs_json",
        "model",
        "created_at",
        "updated_at",
    ]
    assert [
        cache_columns[name]["pk"] for name in ("book_id", "chapter_no", "target_lang")
    ] == [1, 2, 3]
    for required in (
        "book_id",
        "chapter_no",
        "target_lang",
        "paragraphs_json",
        "created_at",
        "updated_at",
    ):
        assert cache_columns[required]["notnull"] == 1, required
    assert cache_columns["model"]["notnull"] == 0
    assert "ix_book_chapter_translations_book_lang" in index_names(
        db, "book_chapter_translations"
    )

    # 原文不落库：本表没有任何 en/source 正文列。
    assert not any(
        "en" == name or name.startswith("en_") or "source" in name
        for name in cache_columns
    )

    # 三列主键：重复行写不进去（应用层用 UPSERT 覆盖）。
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO book_chapter_translations "
            "(book_id, chapter_no, target_lang, paragraphs_json, model, "
            "created_at, updated_at) VALUES ('b1', 1, 'zh-CN', '[\"译文\"]', "
            "'m', 1, 1)"
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO book_chapter_translations "
                "(book_id, chapter_no, target_lang, paragraphs_json, model, "
                "created_at, updated_at) VALUES ('b1', 1, 'zh-CN', '[\"另一条\"]', "
                "'m', 2, 2)"
            )
        conn.rollback()

    # 0019 单独回滚：只删缓存表，0018 的导入书表保留。
    assert_alembic_ok(
        run_alembic(db, "downgrade", "0018_imported_books"), "downgrade 0018"
    )
    assert revision(db) == "0018_imported_books"
    remaining = table_names(db)
    assert "book_chapter_translations" not in remaining
    assert "imported_books" in remaining
    assert "imported_book_translations" in remaining


# ---------------------------------------------------------------------------
# 2. GET：无缓存 / 本地译文 / 目标语言
# ---------------------------------------------------------------------------


def test_get_untranslated_chapter_marks_missing(public_client):
    response = public_client.get("/api/books/test-book/chapters/2")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["targetLang"] == "zh-CN"
    assert payload["translationStatus"] == "missing"
    assert payload["translated"] is False
    assert payload["missingTranslations"] == 2
    assert [item["en"] for item in payload["paragraphs"]] == [
        "Two alpha.",
        "Two beta.",
    ]
    assert all(item["zh"] is None for item in payload["paragraphs"])
    assert "no-store" in response.headers.get("cache-control", "")


def test_get_with_level_requires_login_but_plain_get_is_public(public_client):
    """M7a：纯读取公开；带 ?level= 会生成教学分析 → 游客 403 login_required。"""
    plain = public_client.get("/api/books/test-book/chapters/1")
    assert plain.status_code == 200
    assert plain.json()["translationStatus"] == "cached"

    generated = public_client.get("/api/books/test-book/chapters/1?level=orbit")
    assert generated.status_code == 403, generated.text
    assert generated.json()["code"] == "login_required"


def test_get_uses_bundled_translation_and_keeps_original_text(public_client):
    response = public_client.get("/api/books/test-book/chapters/1")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["translationStatus"] == "cached"
    assert payload["translationSource"] == "bundled"
    assert payload["translated"] is True
    assert payload["missingTranslations"] == 0
    assert [item["en"] for item in payload["paragraphs"]] == [
        "One alpha.",
        "One beta.",
    ]
    assert [item["zh"] for item in payload["paragraphs"]] == [
        "第一章第一段译文。",
        "第一章第二段译文。",
    ]


def test_get_other_target_language_does_not_leak_bundled_chinese(public_client):
    response = public_client.get("/api/books/test-book/chapters/1?lang=vi-VN")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["targetLang"] == "vi-VN"
    assert payload["translationStatus"] == "missing"
    assert all(item["zh"] is None for item in payload["paragraphs"])


def test_get_invalid_target_language_is_400(public_client):
    response = public_client.get("/api/books/test-book/chapters/1?lang=xx-XX")
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# 3. POST：翻译、缓存、幂等
# ---------------------------------------------------------------------------


def test_post_translates_missing_paragraphs_and_writes_global_cache(
    logged_in_client, llm_stub
):
    response = logged_in_client.post("/api/books/test-book/chapters/2/translate")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["cached"] is False
    assert payload["status"] == "done"
    assert payload["translationStatus"] == "cached"
    assert payload["targetLang"] == "zh-CN"
    assert payload["batches"] == 1
    assert payload["failedParagraphs"] == 0
    assert payload["translatedParagraphs"] == 2
    assert payload["model"]
    assert [item["en"] for item in payload["paragraphs"]] == [
        "Two alpha.",
        "Two beta.",
    ]
    assert [item["zh"] for item in payload["paragraphs"]] == [
        "译文段落 0",
        "译文段落 1",
    ]
    assert len(llm_stub.calls) == 1

    rows = _cache_rows()
    assert len(rows) == 1
    row = rows[0]
    assert (row["book_id"], row["chapter_no"], row["target_lang"]) == (
        "test-book",
        2,
        "zh-CN",
    )
    assert json.loads(row["paragraphs_json"]) == ["译文段落 0", "译文段落 1"]
    assert row["model"] == payload["model"]
    assert int(row["created_at"]) > 0
    assert int(row["updated_at"]) >= int(row["created_at"])


def test_get_after_post_automatically_returns_translation(logged_in_client, llm_stub):
    assert (
        logged_in_client.post("/api/books/test-book/chapters/2/translate").status_code
        == 200
    )
    response = logged_in_client.get("/api/books/test-book/chapters/2")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["translationStatus"] == "cached"
    assert payload["translationSource"] == "cache"
    assert payload["translated"] is True
    assert [item["zh"] for item in payload["paragraphs"]] == [
        "译文段落 0",
        "译文段落 1",
    ]


def test_second_post_is_cached_without_model_call_or_new_row(logged_in_client, llm_stub):
    first = logged_in_client.post("/api/books/test-book/chapters/2/translate")
    assert first.status_code == 200
    calls_after_first = len(llm_stub.calls)
    created_at = _cache_rows()[0]["created_at"]

    second = logged_in_client.post("/api/books/test-book/chapters/2/translate")
    assert second.status_code == 200, second.text
    payload = second.json()
    assert payload["cached"] is True
    assert payload["status"] == "cached"
    assert payload["batches"] == 0
    assert len(llm_stub.calls) == calls_after_first
    rows = _cache_rows()
    assert len(rows) == 1
    assert rows[0]["created_at"] == created_at


def test_translate_requires_login_but_cached_read_stays_public(
    make_client, llm_stub
):
    """M7a：未登录不能触发 AI 翻译（403 login_required），但已缓存章节仍可公开读。"""
    with make_client() as client:
        response = client.post("/api/books/test-book/chapters/2/translate")
        assert response.status_code == 403, response.text
        assert response.json()["code"] == "login_required"
        assert llm_stub.calls == []
        assert _cache_rows() == []
        # 公开只读路径不因「未登录」被拦，也不签发游客 Cookie。
        read = client.get("/api/books/test-book/chapters/2")
        assert read.status_code == 200
        assert "ln_guest" not in read.headers.get("set-cookie", "")


def test_translate_only_fills_missing_paragraphs_of_partial_chapter(
    logged_in_client, llm_stub
):
    before = logged_in_client.get("/api/books/test-book/chapters/4").json()
    assert before["translationStatus"] == "partial"
    assert [item["zh"] for item in before["paragraphs"]] == [
        "第四章第一段译文。",
        None,
    ]

    response = logged_in_client.post("/api/books/test-book/chapters/4/translate")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "done"
    assert payload["translationSource"] == "mixed"
    assert [item["zh"] for item in payload["paragraphs"]] == [
        "第四章第一段译文。",
        "译文段落 1",
    ]
    # 只把缺失的 idx=1 送给模型，已翻的 idx=0 不重复付费。
    assert len(llm_stub.calls) == 1
    assert '"idx": 1' in llm_stub.calls[0]
    assert '"idx": 0' not in llm_stub.calls[0]


# ---------------------------------------------------------------------------
# 4. 段落对齐 / 失败恢复
# ---------------------------------------------------------------------------


def test_model_output_is_aligned_by_idx_when_shuffled_with_extra_items(
    logged_in_client, llm_stub
):
    llm_stub.shuffle = True
    llm_stub.extra = True
    response = logged_in_client.post("/api/books/test-book/chapters/2/translate")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert [item["zh"] for item in payload["paragraphs"]] == [
        "译文段落 0",
        "译文段落 1",
    ]
    assert _cache_paragraphs(2) == ["译文段落 0", "译文段落 1"]


def test_model_missing_paragraph_stays_null_and_retry_only_fills_it(
    logged_in_client, llm_stub
):
    llm_stub.drop = {1}
    first = logged_in_client.post("/api/books/test-book/chapters/2/translate")
    assert first.status_code == 200, first.text
    payload = first.json()
    assert payload["status"] == "partial"
    assert payload["failedParagraphs"] == 1
    assert payload["failedIndices"] == [1]
    assert [item["zh"] for item in payload["paragraphs"]] == ["译文段落 0", None]
    assert _cache_paragraphs(2) == ["译文段落 0", None]
    assert len(llm_stub.calls) == 1

    llm_stub.drop = set()
    second = logged_in_client.post("/api/books/test-book/chapters/2/translate")
    assert second.status_code == 200, second.text
    assert second.json()["status"] == "done"
    assert len(llm_stub.calls) == 2
    retry_prompt = llm_stub.calls[-1]
    assert '"idx": 1' in retry_prompt
    assert '"idx": 0' not in retry_prompt
    assert _cache_paragraphs(2) == ["译文段落 0", "译文段落 1"]


def test_llm_total_failure_is_502_without_half_written_row(logged_in_client, llm_stub):
    llm_stub.fail = True
    response = logged_in_client.post("/api/books/test-book/chapters/2/translate")
    assert response.status_code == 502, response.text
    assert "重试" in response.json()["detail"]
    assert _cache_rows() == []
    assert logged_in_client.get("/api/books/test-book/chapters/2").json()[
        "translationStatus"
    ] == "missing"

    llm_stub.fail = False
    retry = logged_in_client.post("/api/books/test-book/chapters/2/translate")
    assert retry.status_code == 200, retry.text
    assert retry.json()["status"] == "done"
    assert len(_cache_rows()) == 1


def test_llm_invalid_json_is_502(logged_in_client, llm_stub):
    llm_stub.reply = "这不是 JSON"
    response = logged_in_client.post("/api/books/test-book/chapters/2/translate")
    assert response.status_code == 502
    assert _cache_rows() == []


def test_source_failure_is_503_without_model_call_or_cache(
    logged_in_client, llm_stub, monkeypatch
):
    def _fail(url, timeout=None):
        raise books.BookSourceUnavailable("源站超时")

    monkeypatch.setattr(books, "fetch_source_text", _fail)
    response = logged_in_client.post("/api/books/test-book/chapters/2/translate")
    assert response.status_code == 503
    assert response.headers.get("retry-after") == "60"
    assert llm_stub.calls == []
    assert _cache_rows() == []


# ---------------------------------------------------------------------------
# 5. 目标语言
# ---------------------------------------------------------------------------


def test_vietnamese_translation_is_stored_separately(logged_in_client, llm_stub):
    response = logged_in_client.post(
        "/api/books/test-book/chapters/2/translate?lang=vi-VN"
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["targetLang"] == "vi-VN"
    assert payload["status"] == "done"
    assert [item["zh"] for item in payload["paragraphs"]] == [
        "Bản dịch đoạn 0",
        "Bản dịch đoạn 1",
    ]
    assert _cache_paragraphs(2, "vi-VN") == ["Bản dịch đoạn 0", "Bản dịch đoạn 1"]
    # 两种语言各自一行；中文仍是未翻译。
    rows = _cache_rows()
    assert [(row["target_lang"]) for row in rows] == ["vi-VN"]
    zh = logged_in_client.get("/api/books/test-book/chapters/2")
    assert zh.json()["translationStatus"] == "missing"

    vi = logged_in_client.get("/api/books/test-book/chapters/2?lang=vi-VN")
    assert vi.json()["translationStatus"] == "cached"
    assert [item["zh"] for item in vi.json()["paragraphs"]] == [
        "Bản dịch đoạn 0",
        "Bản dịch đoạn 1",
    ]


def test_vietnamese_output_with_cjk_is_rejected(logged_in_client, llm_stub):
    llm_stub.reply = json.dumps(
        {
            "translations": [
                {"idx": 0, "text": "中文泄漏一"},
                {"idx": 1, "text": "中文泄漏二"},
            ]
        },
        ensure_ascii=False,
    )
    response = logged_in_client.post(
        "/api/books/test-book/chapters/2/translate?lang=vi-VN"
    )
    assert response.status_code == 502
    assert _cache_rows() == []


def test_post_invalid_target_language_is_400(logged_in_client):
    response = logged_in_client.post(
        "/api/books/test-book/chapters/2/translate?targetLang=xx-XX"
    )
    assert response.status_code == 400


def test_post_accepts_target_lang_in_json_body(logged_in_client, llm_stub):
    response = logged_in_client.post(
        "/api/books/test-book/chapters/2/translate",
        json={"targetLang": "vi-VN"},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["targetLang"] == "vi-VN"
    assert payload["paragraphs"][0]["zh"].startswith("Bản dịch")
    assert _cache_paragraphs(2, "vi-VN")[0].startswith("Bản dịch")


# ---------------------------------------------------------------------------
# 6. 并发 / 限流 / 大小 / 超时
# ---------------------------------------------------------------------------


def test_concurrent_requests_call_model_only_once(isolated_book_translation, llm_stub):
    async def scenario():
        manifest = books.load_manifest()
        return await asyncio.gather(
            book_translation.translate_chapter(
                manifest, "test-book", 2, "zh-CN",
                rate_limit_key="ip:testclient", user_id="concurrent-user",
            ),
            book_translation.translate_chapter(
                manifest, "test-book", 2, "zh-CN",
                rate_limit_key="ip:testclient", user_id="concurrent-user",
            ),
        )

    llm_stub.delay = 0.1
    first, second = asyncio.run(scenario())
    # 并发只允许一次真实翻译（后到者等锁后命中缓存）。
    assert len(llm_stub.calls) == 1
    assert [item["zh"] for item in first["paragraphs"]] == [
        "译文段落 0",
        "译文段落 1",
    ]
    assert [item["zh"] for item in second["paragraphs"]] == [
        "译文段落 0",
        "译文段落 1",
    ]
    assert second["translationStatus"] == "cached"
    assert len(_cache_rows()) == 1


def test_daily_rate_limit_per_ip_and_cache_hit_is_free(
    logged_in_client, llm_stub, monkeypatch
):
    monkeypatch.setattr(config, "RATE_LIMIT_BOOK_TRANSLATE_PER_DAY", 2)
    assert (
        logged_in_client.post("/api/books/test-book/chapters/2/translate").status_code
        == 200
    )
    # 缓存命中不占日限。
    cached = logged_in_client.post("/api/books/test-book/chapters/2/translate")
    assert cached.status_code == 200
    assert cached.json()["cached"] is True
    assert (
        logged_in_client.post("/api/books/test-book/chapters/3/translate").status_code
        == 200
    )
    limited = logged_in_client.post("/api/books/test-book/chapters/4/translate")
    assert limited.status_code == 429, limited.text
    assert "每 IP 每天 2 章" in limited.json()["detail"]
    assert limited.headers.get("retry-after")
    # 被限流的章节没有写缓存、没有额外调模型。
    assert {
        (row["chapter_no"], row["target_lang"]) for row in _cache_rows()
    } == {(2, "zh-CN"), (3, "zh-CN")}


def test_oversized_chapter_is_413_without_calling_model(
    logged_in_client, llm_stub, monkeypatch
):
    monkeypatch.setattr(config, "MAX_BOOK_TRANSLATE_CHARS", 10)
    response = logged_in_client.post("/api/books/test-book/chapters/2/translate")
    assert response.status_code == 413
    assert llm_stub.calls == []
    assert _cache_rows() == []


def test_translate_timeout_is_504(logged_in_client, llm_stub, monkeypatch):
    monkeypatch.setattr(config, "BOOK_TRANSLATE_TIMEOUT_SECONDS", 0.3)
    llm_stub.delay = 2.0
    response = logged_in_client.post("/api/books/test-book/chapters/2/translate")
    assert response.status_code == 504, response.text
    assert response.headers.get("retry-after")
    assert _cache_rows() == []


# ---------------------------------------------------------------------------
# 7. 成本账本 / 原文边界 / 迁移缺失
# ---------------------------------------------------------------------------


def test_translation_cost_goes_to_usage_ledger_and_cache_hit_is_free(
    logged_in_client, monkeypatch
):
    def fake_provider(prompt, spec, json_mode):
        indices = sorted(
            {int(value) for value in re.findall(r'"idx":\s*(\d+)', prompt)}
        )
        text = json.dumps(
            {
                "translations": [
                    {"idx": index, "text": f"账本译文 {index}"}
                    for index in indices
                ]
            },
            ensure_ascii=False,
        )
        return text, {"input_tokens": 120, "output_tokens": 60}

    # 走真实 llm.generate -> 预占/结算链路，只替换 provider 传输层。
    monkeypatch.setattr(llm, "_generate_openai_compatible", fake_provider)

    balance_before = billing.get_balance(logged_in_client.user_id)["balanceMicroUsd"]
    first = logged_in_client.post("/api/books/test-book/chapters/2/translate")
    assert first.status_code == 200, first.text
    balance_after = billing.get_balance(logged_in_client.user_id)["balanceMicroUsd"]
    assert balance_after < balance_before, "M7a：登录用户触发书籍翻译必须扣余额"
    rows = _usage_rows()
    assert len(rows) == 1
    feature, calls, target_lang, user_id, input_tokens, output_tokens = rows[0]
    assert feature == "books"
    assert calls == 1
    assert target_lang == "zh-CN"
    assert user_id == logged_in_client.user_id
    assert input_tokens == 120 and output_tokens == 60

    second = logged_in_client.post("/api/books/test-book/chapters/2/translate")
    assert second.status_code == 200
    assert second.json()["cached"] is True
    assert len(_usage_rows()) == 1  # 缓存命中不记账
    assert (
        billing.get_balance(logged_in_client.user_id)["balanceMicroUsd"]
        == balance_after
    ), "缓存命中不得再扣费"


def test_no_english_source_is_persisted_to_db_or_books_dir(
    logged_in_client, llm_stub, isolated_book_translation
):
    files_before = sorted(
        str(path.relative_to(isolated_book_translation))
        for path in isolated_book_translation.rglob("*")
        if path.is_file()
    )
    response = logged_in_client.post("/api/books/test-book/chapters/2/translate")
    assert response.status_code == 200

    db_bytes = Path(config.AUTH_DB_PATH).read_bytes()
    assert b"Two alpha." not in db_bytes
    assert b"Two beta." not in db_bytes
    cache_columns = columns(config.AUTH_DB_PATH, "book_chapter_translations")
    assert not any(
        "en" == name or name.startswith("en_") or "source" in name
        for name in cache_columns
    )

    files_after = sorted(
        str(path.relative_to(isolated_book_translation))
        for path in isolated_book_translation.rglob("*")
        if path.is_file()
    )
    assert files_after == files_before


def test_get_keeps_working_without_cache_table_and_post_explains_migration(
    public_client, logged_in_client,
):
    # 只删译文缓存表（整库删掉会连会话表一起没了，M7a 的登录态读不了）。
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        conn.execute("DROP TABLE book_chapter_translations")
    read = public_client.get("/api/books/test-book/chapters/2")
    assert read.status_code == 200
    assert read.json()["translationStatus"] == "missing"
    bundled = public_client.get("/api/books/test-book/chapters/1")
    assert bundled.status_code == 200
    assert bundled.json()["translationStatus"] == "cached"

    response = logged_in_client.post("/api/books/test-book/chapters/2/translate")
    assert response.status_code == 503
    assert "0019_book_chapter_translations" in response.json()["detail"]


def test_unknown_book_or_chapter_is_404(public_client, logged_in_client):
    for path in (
        "/api/books/no-such-book/chapters/1/translate",
        "/api/books/test-book/chapters/99/translate",
    ):
        assert logged_in_client.post(path).status_code == 404, path
    for path in (
        "/api/books/no-such-book/chapters/1",
        "/api/books/test-book/chapters/99",
    ):
        assert public_client.get(path).status_code == 404, path
