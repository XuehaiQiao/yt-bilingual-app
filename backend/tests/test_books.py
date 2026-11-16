"""公版书系列阅读库的离线验收。

覆盖：

1. 仓库书单：8 个系列 / 75 本 / 71 本可读 / 1164 章索引 / 48 章译文；
   逐本有 source/license/publicDomainBasis/sourceUrl；系列有 excluded 清单；
   仓库中没有任何英文原文文件（只有 books.json 与 *.zh.json）。
2. 公开只读：/api/books 免登录、不下发游客 Cookie；详情/章节同样。
3. 章节对齐：mock 公版源成功 → paragraphs 的 en 来自源站、zh 来自本地译文；
   未翻译章节返回 200 且 zh 全为 null（原文可读）；只有损坏译文才 503。
4. 源站失败：404 / 超时 / 超大 / 编码 → 503（或解码正确）；最近 5 分钟内存
   缓存只用于降级；锚点缺失 503。
5. 404 / 503 / 限流：未知书、未索引章节、坏书单、429。
6. 解析器：anchor/occurrence 处理目录重复、skipTitle、single bodyStart/bodyEnd。
7. 零 LLM/零数据库：模块源码不 import llm / sqlite3，请求期间 LLM 无调用。

全部离线：公版源抓取在用例里 mock，不联网。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import books
import config
import llm
import routes_books

REPO_ROOT = Path(__file__).resolve().parents[2]
BOOKS_DIR = REPO_ROOT / "content" / "books"
SOURCE_URL = "https://www.gutenberg.org/cache/epub/999/pg999.txt"

FAKE_SOURCE = """*** START OF THE PROJECT GUTENBERG EBOOK TEST BOOK ***

The Test

First paragraph of the source.

Second paragraph of the source.

Third paragraph of the source.

Another

Chapter two text.

*** END OF THE PROJECT GUTENBERG EBOOK TEST BOOK ***
"""


def _manifest(book_overrides: dict | None = None, series_extra: dict | None = None) -> dict:
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
        "totalChapters": 2,
        "parser": {"mode": "anchors"},
        "chapters": [
            {"n": 1, "title": "The Test", "anchor": "The Test", "occurrence": 1},
            {"n": 2, "title": "Another", "anchor": "Another", "occurrence": 1},
        ],
    }
    if book_overrides:
        book.update(book_overrides)
    series = {
        "id": "test-series",
        "title": "测试系列",
        "author": "Test Author",
        "description": "用于离线测试的系列。",
        "excluded": [
            {"title": "Not Public Domain", "year": 1936, "reason": "版权未到期。"}
        ],
        "books": [book],
    }
    if series_extra:
        series.update(series_extra)
    return {
        "_meta": {"schema": "books.v2"},
        "series": [series],
    }


def _write_fixture(
    root: Path,
    *,
    manifest: dict | None = None,
    translations: list | None = None,
    chapter: int = 1,
) -> Path:
    directory = root / "books"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "books.json").write_text(
        json.dumps(manifest or _manifest(), ensure_ascii=False), encoding="utf-8"
    )
    chapter_dir = directory / "test-book" / "chapters"
    chapter_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": "books.chapter.zh.v1",
        "bookId": "test-book",
        "chapter": chapter,
        "title": "第一章 测试",
        "paragraphs": translations if translations is not None else ["第一段译文。", "第二段译文。"],
        "meta": {"promptVersion": "books-zh.v1", "model": "test"},
    }
    (chapter_dir / f"{chapter}.zh.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )
    return directory


@pytest.fixture(autouse=True)
def books_fixture(monkeypatch):
    """默认读仓库真实内容；需要异常分支的用例再指向 tmp 副本。"""
    monkeypatch.setattr(config, "BOOKS_DIR", str(BOOKS_DIR), raising=False)
    books.reset_cache()
    yield
    books.reset_cache()


# ---------------------------------------------------------------------------
# 1. 仓库书单与「不存英文原文」
# ---------------------------------------------------------------------------


def test_repo_manifest_has_all_series_and_expected_counts():
    manifest = books.load_manifest()
    summary = books.manifest_summary(manifest)
    assert summary["counts"] == {
        "series": 8,
        "books": 75,
        "availableBooks": 71,
        "readableChapters": 1164,
        "translatedChapters": 48,
    }
    by_id = {series["id"]: series for series in summary["series"]}
    assert set(by_id) == {
        "oz",
        "peter-rabbit",
        "alice",
        "sherlock-holmes",
        "anne",
        "five-children",
        "doctor-dolittle",
        "tarzan",
    }
    assert by_id["oz"]["totalBooks"] == 14
    assert by_id["peter-rabbit"]["totalBooks"] == 23
    assert by_id["alice"]["totalBooks"] == 2
    assert by_id["sherlock-holmes"]["totalBooks"] == 9
    assert by_id["anne"]["totalBooks"] == 6
    assert by_id["five-children"]["totalBooks"] == 3
    assert by_id["doctor-dolittle"]["totalBooks"] == 5
    assert by_id["tarzan"]["totalBooks"] == 13
    assert by_id["oz"]["translatedChapters"] == 6
    assert by_id["peter-rabbit"]["translatedChapters"] == 21
    assert by_id["alice"]["translatedChapters"] == 6
    assert by_id["sherlock-holmes"]["translatedChapters"] == 3
    assert by_id["anne"]["translatedChapters"] == 3
    assert by_id["five-children"]["translatedChapters"] == 3
    assert by_id["doctor-dolittle"]["translatedChapters"] == 3
    assert by_id["tarzan"]["translatedChapters"] == 3


def test_repo_books_have_public_domain_metadata():
    manifest = books.load_manifest()
    allowed_hosts = set(books._ALLOWED_SOURCE_HOSTS)
    for series in manifest["series"]:
        for book in series["books"]:
            assert book["source"].strip(), book["id"]
            assert book["license"] == "Public domain in the US", book["id"]
            assert book["publicDomainBasis"].strip(), book["id"]
            assert book["sourceUrl"].startswith("https://"), book["id"]
            assert book["sourceUrl"].split("/")[2] in allowed_hosts, book["id"]
            if book["status"] == "available":
                assert book["chapters"], book["id"]
                assert book["totalChapters"] == book["readableChapters"], book["id"]
                assert book["totalChapters"] >= book["translatedChapters"], book["id"]
                if book.get("parser", {}).get("mode") == "anchors":
                    assert all(chapter.get("anchor") for chapter in book["chapters"]), book["id"]
                for chapter in book["chapters"]:
                    path = BOOKS_DIR / book["id"] / "chapters" / f"{chapter['n']}.zh.json"
                    if not path.is_file():
                        assert chapter["translated"] is False, book["id"]
                        continue
                    payload = json.loads(path.read_text(encoding="utf-8"))
                    assert payload["schema"] == "books.chapter.zh.v1"
                    assert payload["bookId"] == book["id"]
                    assert payload["chapter"] == chapter["n"]
                    assert payload["title"].strip()
                    assert payload["paragraphs"], path
                    assert all(isinstance(item, str) and item.strip() for item in payload["paragraphs"]), path
                    assert payload["meta"]["promptVersion"] == "books-zh.v1"
                    assert payload["meta"]["generatedAt"]


def test_excluded_lists_are_explicit():
    manifest = books.load_manifest()
    by_id = {series["id"]: series for series in manifest["series"]}
    anne = {item["title"]: item for item in by_id["anne"]["excluded"]}
    assert anne["Anne of Windy Poplars"]["year"] == 1936
    assert anne["Anne of Ingleside"]["year"] == 1939
    assert "版权未到期" in anne["Anne of Windy Poplars"]["reason"]
    oz_titles = {item["title"] for item in by_id["oz"]["excluded"]}
    assert "The Royal Book of Oz" in oz_titles
    assert all(item["reason"] for item in by_id["oz"]["excluded"])
    tarzan_years = [item["year"] for item in by_id["tarzan"]["excluded"]]
    assert tarzan_years and min(tarzan_years) >= 1931
    dolittle_titles = {item["title"] for item in by_id["doctor-dolittle"]["excluded"]}
    assert "Doctor Dolittle's Return" in dolittle_titles


def test_repo_stores_no_english_source_text():
    """仓库只允许 books.json 与 *.zh.json；不得出现 .txt/.html 或 `en` 字段。"""
    files = [path for path in BOOKS_DIR.rglob("*") if path.is_file()]
    assert files, "content/books 不能为空"
    for path in files:
        if path == BOOKS_DIR / "README.md":
            continue
        assert path.suffix == ".json", f"仓库里出现了非 JSON 文件：{path}"
        assert path.name == "books.json" or path.name.endswith(".zh.json"), path
        payload = json.loads(path.read_text(encoding="utf-8"))
        if path.name.endswith(".zh.json"):
            assert "en" not in payload
            assert all(isinstance(paragraph, str) for paragraph in payload["paragraphs"])
    # 译文文件里不得出现整段英文原文：抽查是否存在连续 12 个英文单词。
    import re

    english_run = re.compile(r"[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*){11,}")
    for path in files:
        if not path.name.endswith(".zh.json"):
            continue
        text = path.read_text(encoding="utf-8")
        assert not english_run.search(text), f"{path} 里疑似有英文原文"


# ---------------------------------------------------------------------------
# 2. 公开只读 / 形状
# ---------------------------------------------------------------------------


def test_books_are_public_and_do_not_issue_guest_cookie(make_client):
    with make_client() as client:
        for path in (
            "/api/books",
            "/api/books/oz-the-wonderful-wizard-of-oz",
        ):
            response = client.get(path)
            assert response.status_code == 200, (path, response.text)
            assert "ln_guest" not in response.headers.get("set-cookie", "")


def test_books_index_is_grouped_by_series(make_client):
    with make_client() as client:
        response = client.get("/api/books")
    assert response.status_code == 200
    payload = response.json()
    assert payload["counts"]["series"] == 8
    assert payload["counts"]["books"] == 75
    for series in payload["series"]:
        assert {
            "id",
            "title",
            "author",
            "totalBooks",
            "availableBooks",
            "readableChapters",
            "translatedChapters",
            "excluded",
            "books",
        } <= set(series)
        assert len(series["books"]) == series["totalBooks"]
        for book in series["books"]:
            assert {
                "id",
                "title",
                "level",
                "status",
                "readableChapters",
                "translatedChapters",
                "publicDomainBasis",
            } <= set(book)
            assert book["status"] in {"available", "coming_soon"}
    assert "max-age=300" in response.headers.get("cache-control", "")


def test_book_detail_lists_all_indexed_chapters_and_translation_flags(make_client):
    with make_client() as client:
        response = client.get("/api/books/oz-the-wonderful-wizard-of-oz")
    assert response.status_code == 200
    payload = response.json()
    assert payload["title"] == "The Wonderful Wizard of Oz"
    assert payload["license"] == "Public domain in the US"
    assert payload["publicDomainBasis"].strip()
    assert payload["readableChapters"] == 24
    assert payload["translatedChapters"] == 6
    assert [chapter["n"] for chapter in payload["chapters"]] == list(range(1, 25))
    assert all(chapter["translated"] for chapter in payload["chapters"][:6])
    assert all(not chapter["translated"] for chapter in payload["chapters"][6:])
    assert all(chapter["titleZh"] for chapter in payload["chapters"][:6])
    assert len(payload["series"]["books"]) == 14
    assert payload["series"]["excluded"]


def test_untranslated_book_has_readable_original(make_client):
    with make_client() as client:
        response = client.get("/api/books/alice-through-the-looking-glass")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "available"
    assert payload["readableChapters"] == 12
    assert payload["translatedChapters"] == 0
    assert all(not chapter["translated"] for chapter in payload["chapters"])


def test_coming_soon_book_detail_is_readable_metadata(make_client):
    with make_client() as client:
        response = client.get("/api/books/pr-appley-dapplys-nursery-rhymes")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "coming_soon"
    assert payload["chapters"] == []
    assert payload["readableChapters"] == 0
    assert payload["translatedChapters"] == 0
    assert payload["message"]


# ---------------------------------------------------------------------------
# 3. 章节抓取 mock + 段落对齐
# ---------------------------------------------------------------------------


def test_chapter_fetch_aligns_paragraphs_and_marks_missing_translation(
    tmp_path, monkeypatch, make_client
):
    directory = _write_fixture(tmp_path)
    monkeypatch.setattr(config, "BOOKS_DIR", str(directory), raising=False)
    monkeypatch.setattr(
        books, "fetch_source_text", lambda url, timeout=None: (FAKE_SOURCE, url)
    )
    with make_client() as client:
        response = client.get("/api/books/test-book/chapters/1")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["chapter"] == 1
    assert payload["chapterTitle"] == "第一章 测试"
    assert payload["sourceTitle"] == "The Test"
    assert payload["translated"] is True
    assert payload["translatedChapters"] == 1
    assert [item["en"] for item in payload["paragraphs"]] == [
        "First paragraph of the source.",
        "Second paragraph of the source.",
        "Third paragraph of the source.",
    ]
    assert payload["paragraphs"][0]["zh"] == "第一段译文。"
    assert payload["paragraphs"][1]["zh"] == "第二段译文。"
    assert payload["paragraphs"][2]["zh"] is None
    assert payload["missingTranslations"] == 1
    assert "no-store" in response.headers.get("cache-control", "")
    assert payload["source"]["provider"] == "Project Gutenberg"
    assert payload["source"]["degraded"] is False


def test_untranslated_chapter_returns_original_text(
    tmp_path, monkeypatch, make_client
):
    directory = _write_fixture(tmp_path)
    monkeypatch.setattr(config, "BOOKS_DIR", str(directory), raising=False)
    monkeypatch.setattr(
        books, "fetch_source_text", lambda url, timeout=None: (FAKE_SOURCE, url)
    )
    with make_client() as client:
        response = client.get("/api/books/test-book/chapters/2")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["translated"] is False
    assert payload["chapterTitle"] == "Another"
    assert [item["en"] for item in payload["paragraphs"]] == ["Chapter two text."]
    assert all(item["zh"] is None for item in payload["paragraphs"])
    assert payload["translatedChapters"] == 1


def test_missing_translation_file_is_not_an_error(
    tmp_path, monkeypatch, make_client
):
    directory = _write_fixture(tmp_path)
    (directory / "test-book" / "chapters" / "1.zh.json").unlink()
    monkeypatch.setattr(config, "BOOKS_DIR", str(directory), raising=False)
    monkeypatch.setattr(
        books, "fetch_source_text", lambda url, timeout=None: (FAKE_SOURCE, url)
    )
    with make_client() as client:
        detail = client.get("/api/books/test-book")
        chapter = client.get("/api/books/test-book/chapters/1")
    assert detail.status_code == 200
    assert detail.json()["translatedChapters"] == 0
    assert chapter.status_code == 200
    assert all(item["zh"] is None for item in chapter.json()["paragraphs"])


def test_chapter_cache_degrades_when_source_fails(tmp_path, monkeypatch, make_client):
    directory = _write_fixture(tmp_path)
    monkeypatch.setattr(config, "BOOKS_DIR", str(directory), raising=False)
    monkeypatch.setattr(
        books, "fetch_source_text", lambda url, timeout=None: (FAKE_SOURCE, url)
    )
    with make_client() as client:
        first = client.get("/api/books/test-book/chapters/1")
        assert first.status_code == 200
        assert first.json()["source"]["degraded"] is False

        def _fail(url, timeout=None):
            raise books.BookSourceUnavailable("源站超时")

        monkeypatch.setattr(books, "fetch_source_text", _fail)
        second = client.get("/api/books/test-book/chapters/1")
    assert second.status_code == 200, second.text
    assert second.json()["source"]["degraded"] is True


# ---------------------------------------------------------------------------
# 4. 源站失败：404 / 超时 / 编码 / 大小 / 锚点
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(
        self,
        body: bytes,
        *,
        status: int = 200,
        content_type: str = "text/plain; charset=utf-8",
        url: str = SOURCE_URL,
    ):
        self._body = body
        self.status_code = status
        self.headers = {"Content-Type": content_type}
        self.url = url
        self.closed = False

    def iter_content(self, chunk_size: int = 65536):
        for start in range(0, len(self._body), chunk_size):
            yield self._body[start : start + chunk_size]

    def close(self):
        self.closed = True


def _mock_requests(monkeypatch, **kwargs):
    response = _FakeResponse(**kwargs)

    def _get(*_args, **_kwargs):
        return response

    monkeypatch.setattr(books.requests, "get", _get)
    monkeypatch.setattr(books, "_robots_allows", lambda _url: True)
    return response


def test_fetch_source_decodes_declared_charset(monkeypatch):
    # ISO-8859-1 的 ’（0x92）在 UTF-8 下会解码失败；必须按 charset 解码。
    body = "*** START OF THE PROJECT GUTENBERG EBOOK T ***\nIt’s fine.\n*** END OF THE PROJECT GUTENBERG EBOOK T ***".encode(
        "cp1252"
    )
    _mock_requests(monkeypatch, body=body, content_type="text/plain; charset=windows-1252")
    text, final_url = books.fetch_source_text(SOURCE_URL)
    assert "It’s fine." in text
    assert final_url == SOURCE_URL


def test_fetch_source_falls_back_to_cp1252_without_charset(monkeypatch):
    body = "*** START OF THE PROJECT GUTENBERG EBOOK T ***\nIt’s fine.\n*** END OF THE PROJECT GUTENBERG EBOOK T ***".encode(
        "cp1252"
    )
    _mock_requests(monkeypatch, body=body, content_type="text/plain")
    text, _final_url = books.fetch_source_text(SOURCE_URL)
    assert "It’s fine." in text


def test_fetch_source_timeout_is_source_unavailable(monkeypatch):
    def _timeout(*_args, **_kwargs):
        raise books.requests.Timeout("read timed out")

    monkeypatch.setattr(books.requests, "get", _timeout)
    monkeypatch.setattr(books, "_robots_allows", lambda _url: True)
    with pytest.raises(books.BookSourceUnavailable):
        books.fetch_source_text(SOURCE_URL)


def test_fetch_source_404_is_source_unavailable(monkeypatch):
    _mock_requests(monkeypatch, body=b"not found", status=404)
    with pytest.raises(books.BookSourceUnavailable):
        books.fetch_source_text(SOURCE_URL)


def test_fetch_source_size_limit(monkeypatch):
    monkeypatch.setattr(config, "MAX_BOOK_SOURCE_BYTES", 64, raising=False)
    _mock_requests(monkeypatch, body=b"x" * 1024)
    with pytest.raises(books._ResponseTooLarge):
        books.fetch_source_text(SOURCE_URL)


def test_fetch_source_rejects_redirect_outside_allowlist(monkeypatch):
    _mock_requests(monkeypatch, body=b"text", url="https://evil.example/x.txt")
    with pytest.raises(books.BookSourceUnavailable):
        books.fetch_source_text(SOURCE_URL)


def test_source_failure_maps_to_503(tmp_path, monkeypatch, make_client):
    directory = _write_fixture(tmp_path)
    monkeypatch.setattr(config, "BOOKS_DIR", str(directory), raising=False)

    def _fail(url, timeout=None):
        raise books.BookSourceUnavailable("404")

    monkeypatch.setattr(books, "fetch_source_text", _fail)
    with make_client() as client:
        response = client.get("/api/books/test-book/chapters/1")
    assert response.status_code == 503
    assert response.headers.get("retry-after") == "60"


def test_missing_anchor_in_source_is_503(tmp_path, monkeypatch, make_client):
    manifest = _manifest()
    manifest["series"][0]["books"][0]["chapters"][0]["anchor"] = "No Such Heading"
    directory = _write_fixture(tmp_path, manifest=manifest)
    monkeypatch.setattr(config, "BOOKS_DIR", str(directory), raising=False)
    monkeypatch.setattr(
        books, "fetch_source_text", lambda url, timeout=None: (FAKE_SOURCE, url)
    )
    with make_client() as client:
        response = client.get("/api/books/test-book/chapters/1")
    assert response.status_code == 503


# ---------------------------------------------------------------------------
# 5. 解析器：目录重复 / skipTitle / single bodyEnd
# ---------------------------------------------------------------------------


def test_anchor_occurrence_picks_body_not_toc(tmp_path, monkeypatch, make_client):
    source = """*** START OF THE PROJECT GUTENBERG EBOOK T ***

The Test

Contents duplicate.

The Test

Real chapter body.

Another

Second chapter.

*** END OF THE PROJECT GUTENBERG EBOOK T ***
"""
    manifest = _manifest()
    manifest["series"][0]["books"][0]["chapters"][0]["occurrence"] = 2
    directory = _write_fixture(tmp_path, manifest=manifest)
    monkeypatch.setattr(config, "BOOKS_DIR", str(directory), raising=False)
    monkeypatch.setattr(
        books, "fetch_source_text", lambda url, timeout=None: (source, url)
    )
    with make_client() as client:
        response = client.get("/api/books/test-book/chapters/1")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert [item["en"] for item in payload["paragraphs"]] == ["Real chapter body."]
    assert payload["paragraphs"][0]["zh"] == "第一段译文。"


def test_skip_title_drops_heading_line(tmp_path, monkeypatch, make_client):
    source = """*** START OF THE PROJECT GUTENBERG EBOOK T ***

CHAPTER I

The Test

Body paragraph.

Another

Second chapter.

*** END OF THE PROJECT GUTENBERG EBOOK T ***
"""
    manifest = _manifest()
    book = manifest["series"][0]["books"][0]
    book["parser"] = {"mode": "anchors"}
    book["chapters"] = [
        {
            "n": 1,
            "title": "The Test",
            "anchor": "CHAPTER I",
            "occurrence": 1,
            "skipTitle": True,
        },
        {"n": 2, "title": "Another", "anchor": "Another", "occurrence": 1},
    ]
    directory = _write_fixture(tmp_path, manifest=manifest)
    monkeypatch.setattr(config, "BOOKS_DIR", str(directory), raising=False)
    monkeypatch.setattr(
        books, "fetch_source_text", lambda url, timeout=None: (source, url)
    )
    with make_client() as client:
        response = client.get("/api/books/test-book/chapters/1")
    assert response.status_code == 200, response.text
    assert [item["en"] for item in response.json()["paragraphs"]] == [
        "Body paragraph."
    ]


def test_single_parser_honours_body_end(tmp_path, monkeypatch, make_client):
    source = """*** START OF THE PROJECT GUTENBERG EBOOK T ***

Once upon a time there was a story.

Middle paragraph.

The end of the story.

This footer is not part of the story.

*** END OF THE PROJECT GUTENBERG EBOOK T ***
"""
    manifest = _manifest()
    book = manifest["series"][0]["books"][0]
    book["parser"] = {
        "mode": "single",
        "bodyStart": "Once upon a time",
        "bodyEnd": "The end of the story.",
    }
    book["totalChapters"] = 1
    book["chapters"] = [{"n": 1, "title": "Test Book"}]
    directory = _write_fixture(tmp_path, manifest=manifest)
    monkeypatch.setattr(config, "BOOKS_DIR", str(directory), raising=False)
    monkeypatch.setattr(
        books, "fetch_source_text", lambda url, timeout=None: (source, url)
    )
    with make_client() as client:
        response = client.get("/api/books/test-book/chapters/1")
    assert response.status_code == 200, response.text
    assert [item["en"] for item in response.json()["paragraphs"]] == [
        "Once upon a time there was a story.",
        "Middle paragraph.",
        "The end of the story.",
    ]


# ---------------------------------------------------------------------------
# 6. 404 / 503 / 限流 / 零 LLM
# ---------------------------------------------------------------------------


def test_unknown_book_and_unindexed_chapter_are_404(make_client):
    with make_client() as client:
        for path in (
            "/api/books/does-not-exist",
            "/api/books/UPPER-CASE",
            "/api/books/oz-the-wonderful-wizard-of-oz/chapters/25",
            "/api/books/pr-appley-dapplys-nursery-rhymes/chapters/1",
        ):
            response = client.get(path)
            assert response.status_code == 404, (path, response.text)


def test_corrupt_manifest_is_503(tmp_path, monkeypatch, make_client):
    directory = _write_fixture(
        tmp_path,
        manifest=_manifest({"license": "Copyrighted"}),
    )
    monkeypatch.setattr(config, "BOOKS_DIR", str(directory), raising=False)
    with make_client() as client:
        assert client.get("/api/books").status_code == 503
        assert client.get("/api/books/test-book").status_code == 503


def test_invalid_excluded_entry_is_503(tmp_path, monkeypatch, make_client):
    manifest = _manifest()
    manifest["series"][0]["excluded"] = [{"title": "X", "year": "1936", "reason": "r"}]
    directory = _write_fixture(tmp_path, manifest=manifest)
    monkeypatch.setattr(config, "BOOKS_DIR", str(directory), raising=False)
    with make_client() as client:
        assert client.get("/api/books").status_code == 503


def test_books_endpoint_is_rate_limited(tmp_path, monkeypatch, make_client):
    directory = _write_fixture(tmp_path)
    monkeypatch.setattr(config, "BOOKS_DIR", str(directory), raising=False)
    monkeypatch.setattr(config, "RATE_LIMIT_BOOKS_PER_MINUTE", 2, raising=False)
    with make_client() as client:
        assert client.get("/api/books").status_code == 200
        assert client.get("/api/books").status_code == 200
        limited = client.get("/api/books")
    assert limited.status_code == 429
    assert limited.headers.get("retry-after")


def test_requests_never_call_llm(tmp_path, monkeypatch, make_client):
    directory = _write_fixture(tmp_path)
    monkeypatch.setattr(config, "BOOKS_DIR", str(directory), raising=False)
    monkeypatch.setattr(
        books, "fetch_source_text", lambda url, timeout=None: (FAKE_SOURCE, url)
    )
    calls: list[str] = []

    def _record(*args, **kwargs):
        calls.append("llm")
        raise AssertionError("公版书库不允许调用 LLM")

    monkeypatch.setattr(llm, "generate_text", _record)
    monkeypatch.setattr(llm, "generate_json", _record)
    with make_client() as client:
        assert client.get("/api/books").status_code == 200
        assert client.get("/api/books/test-book").status_code == 200
        assert client.get("/api/books/test-book/chapters/1").status_code == 200
    assert calls == []


def test_modules_have_no_llm_or_database_dependency():
    for module in (routes_books, books):
        source = Path(module.__file__).read_text(encoding="utf-8")
        for forbidden in ("import llm", "import sqlite3", "auth_db", "routes_videos"):
            assert forbidden not in source, module.__name__
