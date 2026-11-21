"""用户导入公版书（Gutenberg / Standard Ebooks）离线验收。

全部离线：源站抓取替换 ``book_import._request_text``（不建真实连接），LLM 替换
``book_import._call_llm``；数据库在 conftest 的 tmp_path 下用真实 Alembic CLI
迁移（模块级模板库复制到每个用例，避免重复跑迁移）。

覆盖：

1. 迁移 0018：两张表/列/PK/唯一约束/索引/级联/升级回滚；
2. URL 白名单：Gutenberg 三种地址、Standard Ebooks 书目页、archive.org/任意站/
   DRM/EPUB/非 https/查询串/章节页全部拒绝；错误文案说明仅支持两个源；
3. 抓取边界：白名单外 URL 不发请求、重定向到站外拒绝、重定向次数、大小上限、
   非文本 Content-Type、字符集解码；
4. 解析：Gutenberg CHAPTER/目录过滤/罗马数字/单章回退/超长段落切块；
   Standard Ebooks 元数据/目录链接/前后附件过滤/无章节报错；
5. 预览：元数据/章节数/来源；不落库、不返回原文；
6. 导入：幂等（重复返回已有、不占日限）、每日 10 本上限、跨用户隔离；
7. 读章：实时抓原文、译文缺失 zh=null、源站失败 503、越界 404；
8. 翻译：写入缓存、重复不调模型/不扣配额、失败可重试、vi 隔离、配额 429；
9. 删除：级联删译文、跨用户 404；原文不落库/不落文件；
10. 路由顺序：``/api/books/imported`` 不被公开的 ``/api/books/{id}`` 吞掉。
"""
from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path

import pytest

import book_import
import config
from ai import quota
from tests.conftest import (
    SECOND_USER_EMAIL,
    SECOND_USER_PASSWORD,
    TEST_USER_EMAIL,
    TEST_USER_PASSWORD,
)
from tests.migration_utils import (
    assert_alembic_ok,
    columns,
    index_names,
    revision,
    run_alembic,
    table_names,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
TEMPLATE_DB = "book-import-template"

GUTENBERG_ID = "1342"
GUTENBERG_OTHER_ID = "999"
GUTENBERG_URL = f"https://www.gutenberg.org/ebooks/{GUTENBERG_ID}"
GUTENBERG_TEXT_URL = f"https://www.gutenberg.org/cache/epub/{GUTENBERG_ID}/pg{GUTENBERG_ID}.txt"
GUTENBERG_MIRROR_URL = f"https://gutenberg.pglaf.org/cache/epub/{GUTENBERG_ID}/pg{GUTENBERG_ID}.txt"

PARA_1 = (
    "It is a truth universally acknowledged, that a single man in possession of a good "
    "fortune, must be in want of a wife. However little known the feelings or views of "
    "such a man may be on his first entering a neighbourhood, this truth is so well fixed "
    "in the minds of the surrounding families that he is considered the rightful property "
    "of some one or other of their daughters."
)
PARA_2 = (
    "Mr. Bennet was among the earliest of those who waited on Mr. Bingley. He had always "
    "intended to visit him, though to the last always assuring his wife that he should not "
    "go; and till the evening after the visit was paid she had no knowledge of it. It was "
    "then disclosed in the following manner."
)
PARA_3 = (
    "Not all that Mrs. Bennet, however, with the assistance of her five daughters, could "
    "ask on the subject, was sufficient to draw from her husband any satisfactory "
    "description of Mr. Bingley. They attacked him in various ways: with barefaced "
    "questions, ingenious suppositions, and distant surmises; but he eluded the skill of "
    "them all."
)
PARA_4 = (
    "Vanity and pride are different things, though the words are often used synonymously. "
    "A person may be proud without being vain. Pride relates more to our opinion of "
    "ourselves, vanity to what we would have others think of us."
)

GUTENBERG_TEXT = f"""The Project Gutenberg eBook of The Test Book

This eBook is for the use of anyone anywhere in the United States.

Title: The Test Book

Author: Author, Test

Language: English

*** START OF THE PROJECT GUTENBERG EBOOK THE TEST BOOK ***

CHAPTER I

{PARA_1}

{PARA_2}

CHAPTER II

{PARA_3}

{PARA_4}

*** END OF THE PROJECT GUTENBERG EBOOK THE TEST BOOK ***
"""

GUTENBERG_OTHER_TEXT = GUTENBERG_TEXT.replace(
    "The Test Book", "Another Test Book"
).replace("CHAPTER I", "Chapter I").replace("CHAPTER II", "Chapter II")

SE_BOOK_URL = "https://standardebooks.org/ebooks/test-author/the-test-book"
SE_BOOK_PAGE = """<html xmlns="http://www.w3.org/1999/xhtml" lang="en-US"><head>
<title>The Test Book, by Test Author - Free ebook download - Standard Ebooks</title>
</head><body>
<h1 property="schema:name">The Test Book</h1>
<a property="schema:author" href="/ebooks/test-author">
  <span property="schema:name">Test Author</span>
</a>
<p>Read online: <a href="/ebooks/test-author/the-test-book/text">table of contents</a></p>
</body></html>"""
SE_TOC = """<html xmlns="http://www.w3.org/1999/xhtml" lang="en-US"><body>
<header><nav><ul><li><a href="/ebooks/test-author/the-test-book/text">Table of contents</a></li></ul></nav></header>
<main epub:type="frontmatter">
<nav aria-labelledby="toc-title" id="toc" epub:type="toc"><h2 id="toc-title">Table of Contents</h2><ol>
<li><a href="text/titlepage">Titlepage</a></li>
<li><a href="text/imprint">Imprint</a></li>
<li><a href="text/chapter-1" epub:type="z3998:roman">I</a></li>
<li><a href="text/chapter-2" epub:type="z3998:roman">II</a></li>
<li><a href="text/endnotes">Endnotes</a></li>
</ol></nav></main></body></html>"""
SE_CHAPTER_1 = f"""<html xmlns="http://www.w3.org/1999/xhtml" lang="en-US"><body>
<header><nav><a href="/">Standard Ebooks</a></nav></header>
<main epub:type="bodymatter"><section id="chapter-1" epub:type="chapter">
<h2 epub:type="z3998:roman">I</h2>
<p>{PARA_1}</p>
<p>{PARA_2}</p>
</section></main>
<footer><p>Footer navigation</p></footer></body></html>"""
SE_CHAPTER_2 = f"""<html xmlns="http://www.w3.org/1999/xhtml" lang="en-US"><body>
<main><section id="chapter-2"><h2>II</h2><p>{PARA_3}</p><p>{PARA_4}</p></section></main>
</body></html>"""


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def migrated_template_db(tmp_path_factory):
    path = tmp_path_factory.mktemp(TEMPLATE_DB) / "app.db"
    assert_alembic_ok(run_alembic(path, "upgrade", "head"), "upgrade head")
    return path


@pytest.fixture()
def book_client(migrated_template_db, make_client):
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
def second_client(book_client, make_client):
    with make_client() as test_client:
        response = test_client.post(
            "/api/auth/signup",
            json={"email": SECOND_USER_EMAIL, "password": SECOND_USER_PASSWORD},
        )
        assert response.status_code == 201, response.text
        test_client.user_id = response.json()["user"]["id"]
        yield test_client


class FakeWeb:
    def __init__(self, pages: dict[str, str | Exception] | None = None) -> None:
        self.pages = dict(pages or {})
        self.calls: list[str] = []

    def __call__(self, url: str, **_kwargs):
        self.calls.append(url)
        result = self.pages.get(url)
        if result is None:
            raise book_import.BookSourceError(f"fake 没有该地址：{url}")
        if isinstance(result, Exception):
            raise result
        return result, url


def default_pages() -> dict[str, str | Exception]:
    return {
        GUTENBERG_TEXT_URL: GUTENBERG_TEXT,
        GUTENBERG_MIRROR_URL: GUTENBERG_TEXT,
        f"https://www.gutenberg.org/cache/epub/{GUTENBERG_OTHER_ID}/pg{GUTENBERG_OTHER_ID}.txt": GUTENBERG_OTHER_TEXT,
        f"https://gutenberg.pglaf.org/cache/epub/{GUTENBERG_OTHER_ID}/pg{GUTENBERG_OTHER_ID}.txt": GUTENBERG_OTHER_TEXT,
        SE_BOOK_URL: SE_BOOK_PAGE,
        SE_BOOK_URL + "/text": SE_TOC,
        SE_BOOK_URL + "/text/chapter-1": SE_CHAPTER_1,
        SE_BOOK_URL + "/text/chapter-2": SE_CHAPTER_2,
    }


@pytest.fixture()
def web(monkeypatch):
    fake = FakeWeb(default_pages())
    monkeypatch.setattr(book_import, "_request_text", fake)
    return fake


class LLMStub:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.reply: str | None = None
        self.fail = False

    async def __call__(self, prompt: str, model: str) -> str:
        import re

        self.calls.append(prompt)
        if self.fail:
            return "not json at all"
        if self.reply is not None:
            return self.reply
        indices = sorted({int(value) for value in re.findall(r'"idx":\s*(\d+)', prompt)})
        vietnamese = "Vietnamese" in prompt
        return json.dumps(
            {
                "translations": [
                    {
                        "idx": index,
                        "text": (
                            f"Bản dịch đoạn {index}"
                            if vietnamese
                            else f"译文段落 {index}"
                        ),
                    }
                    for index in indices
                ]
            },
            ensure_ascii=False,
        )


@pytest.fixture()
def llm_stub(monkeypatch):
    stub = LLMStub()
    monkeypatch.setattr(book_import, "_call_llm", stub)
    return stub


def import_url(client, url: str = GUTENBERG_URL) -> dict:
    response = client.post("/api/books/import", json={"url": url})
    assert response.status_code == 200, response.text
    return response.json()


def quota_used(db_path: Path, user_id: str, feature: str = "reading") -> int:
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT used_units FROM ai_quota WHERE user_id = ? AND feature = ?",
            (user_id, feature),
        ).fetchone()
    return int(row[0]) if row else 0


# ---------------------------------------------------------------------------
# 迁移
# ---------------------------------------------------------------------------

def test_migration_0018_schema_and_downgrade(tmp_path):
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    assert revision(db) == "0026_seed_band_fix"

    tables = table_names(db)
    assert "imported_books" in tables
    assert "imported_book_translations" in tables

    book_columns = columns(db, "imported_books")
    assert set(book_columns) == {
        "id",
        "user_id",
        "source_type",
        "source_url",
        "external_id",
        "title",
        "author",
        "language",
        "chapters_json",
        "created_at",
        "updated_at",
    }
    assert book_columns["id"]["pk"] == 1
    assert book_columns["author"]["notnull"] == 0
    assert book_columns["chapters_json"]["notnull"] == 1
    assert {"ux_imported_books_user_source", "ix_imported_books_user_created"} <= index_names(
        db, "imported_books"
    )

    translation_columns = columns(db, "imported_book_translations")
    assert set(translation_columns) == {
        "book_id",
        "chapter_index",
        "lang",
        "paragraphs_json",
        "model",
        "created_at",
    }
    assert {
        name
        for name, info in translation_columns.items()
        if info["pk"]
    } == {"book_id", "chapter_index", "lang"}

    # 原文不落库：本功能没有存放正文的表/列（article_paragraphs 属于读文章）。
    assert "imported_book_paragraphs" not in tables
    assert "imported_book_source" not in tables
    assert "source_text" not in book_columns

    assert_alembic_ok(run_alembic(db, "downgrade", "0017_behavior_events"), "downgrade")
    assert revision(db) == "0017_behavior_events"
    assert "imported_books" not in table_names(db)
    assert "imported_book_translations" not in table_names(db)


def test_migration_0018_unique_and_cascade(tmp_path):
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    with sqlite3.connect(db) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute(
            "INSERT INTO imported_books (id, user_id, source_type, source_url, "
            "external_id, title, language, chapters_json, created_at, updated_at) "
            "VALUES ('b1', 'u1', 'gutenberg', 'https://www.gutenberg.org/ebooks/1', "
            "'gutenberg:1', 'T', 'en', '{\"version\": 1, \"chapters\": "
            "[{\"n\": 1, \"title\": \"I\", \"url\": null}]}', 1, 1)"
        )
        conn.execute(
            "INSERT INTO imported_book_translations "
            "(book_id, chapter_index, lang, paragraphs_json, model, created_at) "
            "VALUES ('b1', 1, 'zh-CN', '[\"译文\"]', 'm', 1)"
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO imported_books (id, user_id, source_type, source_url, "
                "external_id, title, language, chapters_json, created_at, updated_at) "
                "VALUES ('b2', 'u1', 'gutenberg', 'https://www.gutenberg.org/ebooks/1', "
                "'gutenberg:1', 'T', 'en', '{}', 1, 1)"
            )
        conn.execute("DELETE FROM imported_books WHERE id = 'b1'")
        remaining = conn.execute(
            "SELECT COUNT(*) FROM imported_book_translations"
        ).fetchone()[0]
    assert remaining == 0


# ---------------------------------------------------------------------------
# URL 白名单
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "url, source_type, external_id",
    [
        (
            "https://www.gutenberg.org/ebooks/1342",
            "gutenberg",
            "gutenberg:1342",
        ),
        (
            "https://www.gutenberg.org/ebooks/1342/",
            "gutenberg",
            "gutenberg:1342",
        ),
        (
            "https://gutenberg.org/cache/epub/1342/pg1342.txt",
            "gutenberg",
            "gutenberg:1342",
        ),
        (
            "https://www.gutenberg.org/files/1342/1342.txt",
            "gutenberg",
            "gutenberg:1342",
        ),
        (
            "https://www.gutenberg.org/files/1342/1342-0.txt",
            "gutenberg",
            "gutenberg:1342",
        ),
        (
            "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice",
            "standard_ebooks",
            "standard_ebooks:jane-austen/pride-and-prejudice",
        ),
        (
            "https://www.standardebooks.org/ebooks/jane-austen/pride-and-prejudice/",
            "standard_ebooks",
            "standard_ebooks:jane-austen/pride-and-prejudice",
        ),
    ],
)
def test_parse_book_url_accepts_whitelist(url, source_type, external_id):
    ref = book_import.parse_book_url(url)
    assert ref.source_type == source_type
    assert ref.external_id == external_id
    assert ref.canonical_url.startswith("https://")


@pytest.mark.parametrize(
    "url",
    [
        "https://archive.org/details/pride-and-prejudice",
        "https://archive.org/download/foo/bar.txt",
        "https://www.gutenberg.org/ebooks/1342.epub",
        "https://www.gutenberg.org/ebooks/1342.kf8.images",
        "https://www.gutenberg.org/files/1342/1342.zip",
        "https://example.com/novel/1",
        "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/text/chapter-1",
        "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/x.epub",
    ],
)
def test_parse_book_url_rejects_non_whitelist_and_drm(url):
    with pytest.raises(book_import.BookImportError) as excinfo:
        book_import.parse_book_url(url)
    detail = str(excinfo.value)
    if "archive.org" in url or "example.com" in url or "downloads" in url:
        assert "仅支持 Project Gutenberg 与 Standard Ebooks" in detail
    elif "/text/" in url:
        assert "书目页链接" in detail
    else:
        assert "EPUB" in detail or "纯文本" in detail


@pytest.mark.parametrize(
    "url, fragment",
    [
        ("http://www.gutenberg.org/ebooks/1342", "https"),
        ("https://www.gutenberg.org/ebooks/1342?x=1", "查询参数"),
        ("https://user:pass@www.gutenberg.org/ebooks/1342", "账号密码"),
        ("https://www.gutenberg.org:8443/ebooks/1342", "端口"),
        ("https://www.gutenberg.org/", "路径"),
        ("", "请粘贴"),
    ],
)
def test_parse_book_url_rejects_bad_shape(url, fragment):
    with pytest.raises(book_import.InvalidBookUrl) as excinfo:
        book_import.parse_book_url(url)
    assert fragment in str(excinfo.value)


# ---------------------------------------------------------------------------
# 抓取边界（真实 _request_text 实现）
# ---------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, status_code=200, headers=None, body=b"", url="https://www.gutenberg.org/ebooks/1342"):
        self.status_code = status_code
        self.headers = dict(headers or {})
        self._body = body
        self.url = url

    def iter_content(self, chunk_size=65536):
        for start in range(0, len(self._body), chunk_size):
            yield self._body[start : start + chunk_size]

    def close(self):
        pass


def test_request_text_rejects_non_whitelisted_url_without_network(monkeypatch):
    called = []

    def _get(*args, **kwargs):
        called.append(args)

    monkeypatch.setattr(book_import.requests, "get", _get)
    with pytest.raises(book_import.BookSourceError):
        book_import._request_text("https://example.com/novel.txt")
    assert called == []


def test_request_text_rejects_redirect_outside_whitelist(monkeypatch):
    responses = [
        FakeResponse(
            status_code=302,
            headers={"Location": "https://evil.example/secret.txt"},
        )
    ]
    monkeypatch.setattr(book_import.requests, "get", lambda *a, **k: responses.pop(0))
    with pytest.raises(book_import.BookSourceError) as excinfo:
        book_import._request_text(GUTENBERG_TEXT_URL)
    assert "重定向" in str(excinfo.value)


def test_request_text_redirect_limit(monkeypatch):
    responses = [
        FakeResponse(status_code=302, headers={"Location": GUTENBERG_TEXT_URL})
        for _ in range(book_import.MAX_REDIRECTS + 2)
    ]
    monkeypatch.setattr(book_import.requests, "get", lambda *a, **k: responses.pop(0))
    with pytest.raises(book_import.BookSourceError) as excinfo:
        book_import._request_text(GUTENBERG_TEXT_URL)
    assert "重定向" in str(excinfo.value)


def test_request_text_size_limit(monkeypatch):
    body = b"x" * 500
    monkeypatch.setattr(
        book_import.requests,
        "get",
        lambda *a, **k: FakeResponse(body=body),
    )
    with pytest.raises(book_import.BookSourceError) as excinfo:
        book_import._request_text(GUTENBERG_TEXT_URL, max_bytes=100)
    assert "上限" in str(excinfo.value)


def test_request_text_rejects_html_for_text_fetch(monkeypatch):
    monkeypatch.setattr(
        book_import.requests,
        "get",
        lambda *a, **k: FakeResponse(
            headers={"Content-Type": "text/html; charset=utf-8"}, body=b"<html></html>"
        ),
    )
    with pytest.raises(book_import.BookSourceError) as excinfo:
        book_import._request_text(GUTENBERG_TEXT_URL)
    assert "非文本" in str(excinfo.value)


def test_decode_source_handles_declared_and_fallback_charsets():
    assert book_import._decode_source("café".encode("utf-8"), "utf-8") == "café"
    assert book_import._decode_source("café".encode("cp1252"), None) == "café"


# ---------------------------------------------------------------------------
# 解析
# ---------------------------------------------------------------------------

def test_split_gutenberg_chapters_finds_chapters_and_paragraphs():
    chapters = book_import.split_gutenberg_chapters(GUTENBERG_TEXT)
    assert [chapter.n for chapter in chapters] == [1, 2]
    assert chapters[0].title == "CHAPTER I"
    assert chapters[0].paragraphs[0].startswith("It is a truth")
    assert chapters[1].paragraphs[0].startswith("Not all that")


def test_split_gutenberg_filters_contents_lines():
    contents = "\n".join(
        f"CHAPTER {roman}. The Title ..... {page}" for roman, page in
        (("I", 1), ("II", 9), ("III", 17), ("IV", 25))
    )
    text = f"""*** START OF THE PROJECT GUTENBERG EBOOK TOC TEST ***
CONTENTS

{contents}

CHAPTER I

{PARA_1}

{PARA_2}

CHAPTER II

{PARA_3}

{PARA_4}
*** END OF THE PROJECT GUTENBERG EBOOK TOC TEST ***
"""
    chapters = book_import.split_gutenberg_chapters(text)
    assert len(chapters) == 2
    assert chapters[0].paragraphs[0].startswith("It is a truth")


def test_split_gutenberg_roman_numeral_fallback():
    text = f"""*** START OF THE PROJECT GUTENBERG EBOOK ROMAN TEST ***
PREFACE

Some preface text.

I.

{PARA_1}

II.

{PARA_2}
*** END OF THE PROJECT GUTENBERG EBOOK ROMAN TEST ***
"""
    chapters = book_import.split_gutenberg_chapters(text)
    assert len(chapters) == 2
    assert chapters[0].title == "I"
    assert chapters[1].title == "II"


def test_split_gutenberg_single_chapter_fallback():
    text = f"""*** START OF THE PROJECT GUTENBERG EBOOK SHORT ***
{PARA_1}

{PARA_2}
*** END OF THE PROJECT GUTENBERG EBOOK SHORT ***
"""
    chapters = book_import.split_gutenberg_chapters(text)
    assert len(chapters) == 1
    assert chapters[0].title == "Full text"


def test_split_gutenberg_splits_overlong_paragraphs():
    long_paragraph = " ".join([PARA_1] * 12)
    text = f"""*** START OF THE PROJECT GUTENBERG EBOOK LONG ***
CHAPTER I

{long_paragraph}
*** END OF THE PROJECT GUTENBERG EBOOK LONG ***
"""
    chapters = book_import.split_gutenberg_chapters(text)
    assert all(len(paragraph) <= book_import.MAX_PARAGRAPH_CHARS for paragraph in chapters[0].paragraphs)
    assert len(chapters[0].paragraphs) >= 2


def test_split_gutenberg_requires_markers():
    with pytest.raises(book_import.BookSourceError):
        book_import.split_gutenberg_chapters("No markers here")


def test_standard_ebooks_chapters_exclude_front_and_back_matter():
    ref = book_import.parse_book_url(SE_BOOK_URL)
    chapters = book_import._standard_ebooks_chapters(ref, SE_TOC, SE_BOOK_URL + "/text")
    assert [chapter.n for chapter in chapters] == [1, 2]
    assert [chapter.title for chapter in chapters] == ["I", "II"]
    assert chapters[0].url == SE_BOOK_URL + "/text/chapter-1"


def test_standard_ebooks_chapters_require_links():
    ref = book_import.parse_book_url(SE_BOOK_URL)
    empty_toc = "<html><body><nav id='toc'><ol></ol></nav></body></html>"
    with pytest.raises(book_import.BookSourceError) as excinfo:
        book_import._standard_ebooks_chapters(ref, empty_toc, SE_BOOK_URL + "/text")
    assert "没有找到章节链接" in str(excinfo.value)


# ---------------------------------------------------------------------------
# 预览 / 导入
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "method, path",
    [
        ("post", "/api/books/import/preview"),
        ("post", "/api/books/import"),
        ("get", "/api/books/imported"),
        ("get", "/api/books/imported/abc"),
        ("get", "/api/books/imported/abc/chapters/1"),
        ("post", "/api/books/imported/abc/chapters/1/translate"),
        ("delete", "/api/books/imported/abc"),
    ],
)
def test_import_endpoints_require_login(make_client, method, path):
    with make_client() as client:
        kwargs = {"json": {"url": GUTENBERG_URL}} if method == "post" else {}
        response = getattr(client, method)(path, **kwargs)
    assert response.status_code == 403
    assert response.json().get("code") == "login_required"
    assert "登录" in response.json()["detail"]


def test_preview_gutenberg(book_client, web):
    response = book_client.post(
        "/api/books/import/preview", json={"url": GUTENBERG_URL}
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["sourceType"] == "gutenberg"
    assert payload["title"] == "The Test Book"
    assert payload["author"] == "Test Author"
    assert payload["language"] == "en"
    assert payload["chapterCount"] == 2
    assert [chapter["n"] for chapter in payload["chapters"]] == [1, 2]
    assert payload["source"]["provider"] == "Project Gutenberg"
    assert "paragraphs" not in payload
    # 预览不落库。
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        assert conn.execute("SELECT COUNT(*) FROM imported_books").fetchone()[0] == 0


def test_preview_standard_ebooks(book_client, web):
    response = book_client.post(
        "/api/books/import/preview", json={"url": SE_BOOK_URL}
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["sourceType"] == "standard_ebooks"
    assert payload["title"] == "The Test Book"
    assert payload["author"] == "Test Author"
    assert payload["chapterCount"] == 2
    assert payload["source"]["provider"] == "Standard Ebooks"


def test_preview_rejects_archive_and_drm(book_client):
    response = book_client.post(
        "/api/books/import/preview",
        json={"url": "https://archive.org/details/pride-and-prejudice"},
    )
    assert response.status_code == 400
    assert "仅支持 Project Gutenberg 与 Standard Ebooks" in response.json()["detail"]

    response = book_client.post(
        "/api/books/import/preview",
        json={"url": "https://www.gutenberg.org/ebooks/1342.epub"},
    )
    assert response.status_code == 400
    assert "EPUB" in response.json()["detail"]


def test_preview_source_failure_is_422(book_client, web):
    web.pages = {}
    response = book_client.post(
        "/api/books/import/preview", json={"url": GUTENBERG_URL}
    )
    assert response.status_code == 422
    assert "源站" in response.json()["detail"]


def test_import_gutenberg_and_duplicate_is_idempotent(book_client, web):
    first = import_url(book_client)
    assert first["reused"] is False
    assert first["bookId"]
    assert first["chapterCount"] == 2
    assert first["status"] == "ok"

    web.calls.clear()
    second = import_url(book_client)
    assert second["reused"] is True
    assert second["bookId"] == first["bookId"]
    # 重复导入不重新抓源站。
    assert web.calls == []

    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        rows = conn.execute("SELECT id, chapters_json FROM imported_books").fetchall()
    assert len(rows) == 1
    chapters_json = rows[0][1]
    assert PARA_1 not in chapters_json
    assert "paragraphs" not in chapters_json
    assert "text" not in json.loads(chapters_json)


def test_import_daily_limit(book_client, web, monkeypatch):
    monkeypatch.setattr(config, "RATE_LIMIT_BOOK_IMPORT_PER_DAY", 1)
    import_url(book_client)
    # 同一本重复导入不占日限。
    import_url(book_client)
    response = book_client.post(
        "/api/books/import",
        json={"url": f"https://www.gutenberg.org/ebooks/{GUTENBERG_OTHER_ID}"},
    )
    assert response.status_code == 429
    assert "导入次数" in response.json()["detail"]
    assert response.headers.get("Retry-After")


def test_import_second_user_is_isolated(book_client, second_client, web):
    first = import_url(book_client)
    assert second_client.get("/api/books/imported").json()["books"] == []
    second = import_url(second_client)
    assert second["bookId"] != first["bookId"]
    assert second["reused"] is False


def test_list_and_detail_include_chapter_index(book_client, web):
    imported = import_url(book_client)
    book_id = imported["bookId"]

    listing = book_client.get("/api/books/imported").json()["books"]
    assert [book["bookId"] for book in listing] == [book_id]
    assert listing[0]["chapterCount"] == 2
    assert listing[0]["translatedChapters"] == 0
    assert listing[0]["sourceType"] == "gutenberg"

    detail = book_client.get(f"/api/books/imported/{book_id}").json()
    assert detail["bookId"] == book_id
    assert [chapter["title"] for chapter in detail["chapters"]] == ["CHAPTER I", "CHAPTER II"]
    assert all(chapter["translated"] is False for chapter in detail["chapters"])
    assert detail["quota"]["feature"] == "reading"


def test_imported_detail_route_is_not_swallowed_by_public_books(book_client):
    response = book_client.get("/api/books/imported/does-not-exist")
    assert response.status_code == 404
    assert response.json()["detail"] == "书不存在。"


def test_import_non_english_book_is_rejected(book_client, web):
    pages = dict(web.pages)
    pages[SE_BOOK_URL] = SE_BOOK_PAGE.replace('lang="en-US"', 'lang="fr-FR"')
    web.pages = pages
    response = book_client.post("/api/books/import/preview", json={"url": SE_BOOK_URL})
    assert response.status_code == 422
    assert "英文" in response.json()["detail"]


# ---------------------------------------------------------------------------
# 读章
# ---------------------------------------------------------------------------

def test_read_gutenberg_chapter_fetches_live_and_translation_is_null(book_client, web):
    book_id = import_url(book_client)["bookId"]
    web.calls.clear()
    response = book_client.get(f"/api/books/imported/{book_id}/chapters/1")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["chapter"] == 1
    assert payload["chapterTitle"] == "CHAPTER I"
    assert payload["translated"] is False
    assert payload["missingTranslations"] == len(payload["paragraphs"])
    assert payload["paragraphs"][0]["en"].startswith("It is a truth")
    assert all(paragraph["zh"] is None for paragraph in payload["paragraphs"])
    assert payload["source"]["provider"] == "Project Gutenberg"
    # 每次读章都重新抓公版源。
    assert any(GUTENBERG_ID in url for url in web.calls)


def test_read_standard_ebooks_chapter(book_client, web):
    book_id = import_url(book_client, SE_BOOK_URL)["bookId"]
    response = book_client.get(f"/api/books/imported/{book_id}/chapters/2")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["chapterTitle"] == "II"
    assert payload["paragraphs"][0]["en"].startswith("Not all that")
    assert payload["source"]["url"] == SE_BOOK_URL + "/text/chapter-2"


def test_read_chapter_source_failure_is_503(book_client, web):
    book_id = import_url(book_client)["bookId"]
    web.pages = {}
    response = book_client.get(f"/api/books/imported/{book_id}/chapters/1")
    assert response.status_code == 503
    assert response.json()["detail"]
    assert response.headers.get("Retry-After") == "60"


def test_read_chapter_out_of_range_is_404(book_client, web):
    book_id = import_url(book_client)["bookId"]
    response = book_client.get(f"/api/books/imported/{book_id}/chapters/99")
    assert response.status_code == 404


def test_read_chapter_belongs_to_current_user(book_client, second_client, web):
    book_id = import_url(book_client)["bookId"]
    assert second_client.get(f"/api/books/imported/{book_id}").status_code == 404
    assert (
        second_client.get(f"/api/books/imported/{book_id}/chapters/1").status_code
        == 404
    )


# ---------------------------------------------------------------------------
# 翻译（缓存 / 配额 / 失败重试）
# ---------------------------------------------------------------------------

def test_translate_chapter_writes_cache_and_uses_quota(
    book_client, web, llm_stub
):
    book_id = import_url(book_client)["bookId"]
    response = book_client.post(
        f"/api/books/imported/{book_id}/chapters/1/translate", json={}
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "done"
    assert payload["total"] == 2
    assert payload["translated"] == 2
    assert payload["batches"] == 1
    assert len(llm_stub.calls) == 1
    assert quota_used(config.AUTH_DB_PATH, book_client.user_id) == 1

    chapter = book_client.get(f"/api/books/imported/{book_id}/chapters/1").json()
    assert chapter["translated"] is True
    assert [paragraph["zh"] for paragraph in chapter["paragraphs"]] == [
        "译文段落 0",
        "译文段落 1",
    ]


def test_translate_cache_hit_does_not_call_model_or_quota(
    book_client, web, llm_stub
):
    book_id = import_url(book_client)["bookId"]
    first = book_client.post(
        f"/api/books/imported/{book_id}/chapters/1/translate", json={}
    )
    assert first.status_code == 200
    calls = len(llm_stub.calls)
    response = book_client.post(
        f"/api/books/imported/{book_id}/chapters/1/translate", json={}
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "cached"
    assert len(llm_stub.calls) == calls
    assert quota_used(config.AUTH_DB_PATH, book_client.user_id) == 1


def test_translate_vietnamese_is_stored_separately(book_client, web, llm_stub):
    book_id = import_url(book_client)["bookId"]
    response = book_client.post(
        f"/api/books/imported/{book_id}/chapters/1/translate",
        json={"targetLang": "vi-VN"},
    )
    assert response.status_code == 200, response.text
    chapter_vi = book_client.get(
        f"/api/books/imported/{book_id}/chapters/1?targetLang=vi-VN"
    ).json()
    assert chapter_vi["paragraphs"][0]["zh"].startswith("Bản dịch")
    chapter_zh = book_client.get(f"/api/books/imported/{book_id}/chapters/1").json()
    assert chapter_zh["paragraphs"][0]["zh"] is None


def test_translate_failure_can_be_retried(book_client, web, llm_stub):
    book_id = import_url(book_client)["bookId"]
    llm_stub.fail = True
    response = book_client.post(
        f"/api/books/imported/{book_id}/chapters/1/translate", json={}
    )
    assert response.status_code == 502
    chapter = book_client.get(f"/api/books/imported/{book_id}/chapters/1").json()
    assert chapter["translated"] is False

    llm_stub.fail = False
    retry = book_client.post(
        f"/api/books/imported/{book_id}/chapters/1/translate", json={}
    )
    assert retry.status_code == 200, retry.text
    assert retry.json()["status"] == "done"
    chapter = book_client.get(f"/api/books/imported/{book_id}/chapters/1").json()
    assert chapter["translated"] is True


def test_translate_quota_exceeded_returns_429(
    book_client, web, llm_stub, monkeypatch
):
    book_id = import_url(book_client)["bookId"]
    monkeypatch.setattr(config, "AI_DAILY_QUOTA_READING_BATCHES", 0)
    response = book_client.post(
        f"/api/books/imported/{book_id}/chapters/1/translate", json={}
    )
    assert response.status_code == 429
    assert "额度" in response.json()["detail"]
    assert llm_stub.calls == []


def test_translate_invalid_target_lang_is_400(book_client, web):
    book_id = import_url(book_client)["bookId"]
    response = book_client.post(
        f"/api/books/imported/{book_id}/chapters/1/translate",
        json={"targetLang": "xx-XX"},
    )
    assert response.status_code == 400


def test_translate_requires_login(make_client):
    with make_client() as client:
        response = client.post("/api/books/imported/abc/chapters/1/translate", json={})
    assert response.status_code == 403
    assert response.json().get("code") == "login_required"


# ---------------------------------------------------------------------------
# 删除 / 原文不落库
# ---------------------------------------------------------------------------

def test_delete_removes_book_and_translations(book_client, web, llm_stub):
    book_id = import_url(book_client)["bookId"]
    assert (
        book_client.post(
            f"/api/books/imported/{book_id}/chapters/1/translate", json={}
        ).status_code
        == 200
    )
    response = book_client.delete(f"/api/books/imported/{book_id}")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "bookId": book_id}
    assert book_client.get("/api/books/imported").json()["books"] == []
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        assert conn.execute("SELECT COUNT(*) FROM imported_books").fetchone()[0] == 0
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM imported_book_translations"
            ).fetchone()[0]
            == 0
        )


def test_delete_other_users_book_is_404(book_client, second_client, web):
    book_id = import_url(book_client)["bookId"]
    assert second_client.delete(f"/api/books/imported/{book_id}").status_code == 404
    assert book_client.get(f"/api/books/imported/{book_id}").status_code == 200


def test_no_english_source_is_persisted_to_db_or_disk(book_client, web):
    book_id = import_url(book_client)["bookId"]
    book_client.get(f"/api/books/imported/{book_id}/chapters/1")

    db_bytes = Path(config.AUTH_DB_PATH).read_bytes()
    marker = b"single man in possession of a good fortune"
    assert marker not in db_bytes
    tables = table_names(config.AUTH_DB_PATH)
    assert not any(table.startswith("imported_book_paragraph") for table in tables)

    # 仓库 content/books/ 不被写入（本功能不落任何原文文件）。
    imported_files = [
        path
        for path in (REPO_ROOT / "content" / "books").rglob("*")
        if book_id in path.name
    ]
    assert imported_files == []


def test_article_importer_redirects_public_domain_book_links(book_client):
    """读文章入口收到公版书链接时给出可执行提示，而不是误导性的抓取失败。"""
    for url in (GUTENBERG_URL, SE_BOOK_URL, GUTENBERG_TEXT_URL):
        response = book_client.post("/api/article/import", json={"url": url})
        assert response.status_code == 422, (url, response.text)
        assert "导入公版书" in response.json()["detail"]


def test_public_domain_book_url_detection():
    import reading

    assert reading.is_public_domain_book_url(GUTENBERG_URL)
    assert reading.is_public_domain_book_url(GUTENBERG_TEXT_URL)
    assert reading.is_public_domain_book_url(SE_BOOK_URL)
    assert not reading.is_public_domain_book_url("https://example.com/article")
    assert not reading.is_public_domain_book_url(
        "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/text/chapter-1"
    )


def test_public_books_series_still_works(make_client):
    """公开只读公版书系列不受导入路由影响。"""
    with make_client() as client:
        response = client.get("/api/books")
    assert response.status_code == 200
    assert response.json()["series"]
