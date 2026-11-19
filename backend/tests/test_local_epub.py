"""本地 EPUB 上传（specs/031 M1）离线验收。

覆盖：

1. 解析：合法 EPUB3（nav 目录）/ EPUB2（NCX）/ 无 TOC（回退标题）/ 单章 /
   元数据缺失回退 / 封面（EPUB3 cover-image、EPUB2 meta cover）；
2. 拒绝：非 ZIP、损坏 ZIP、DRM/encryption.xml、非英文、无正文、zip bomb、
   路径穿越、条目数/章节数/单章上限；
3. API：preview（不落库、不可访问游客 401）、token 确认、直接文件确认、
   权利声明必填、token 过期/伪造、幂等（同 SHA-256 同书、不占日限）、
   日限/书数/总文本配额、超大文件 413、限流 429；
4. 阅读：列表/详情/按章读文件、封面接口、跨用户隔离；
5. 翻译：本地章节走同一条翻译/配额/缓存路径，缓存命中不扣费；
6. 删除：DB + 章节文件 + 封面 + 译文全部清理；失败不假成功。

全部离线：EPUB 由标准库在内存里构造；LLM 替换 ``book_import._call_llm``；
数据库在 conftest 的 tmp_path 下用真实 Alembic CLI 迁移到 head。
"""
from __future__ import annotations

import io
import json
import shutil
import sqlite3
import zipfile
from html import escape
from pathlib import Path

import pytest

import book_import
import config
import local_epub
from tests.conftest import (
    SECOND_USER_EMAIL,
    SECOND_USER_PASSWORD,
    TEST_USER_EMAIL,
    TEST_USER_PASSWORD,
)
from tests.migration_utils import assert_alembic_ok, run_alembic

TEMPLATE_DB = "local-epub-template"

PARA_1 = (
    "It is a truth universally acknowledged, that a single man in possession of a "
    "good fortune, must be in want of a wife."
)
PARA_2 = (
    "Mr. Bennet was among the earliest of those who waited on Mr. Bingley. He had "
    "always intended to visit him."
)
PARA_3 = (
    "Not all that Mrs. Bennet, however, with the assistance of her five daughters, "
    "could ask on the subject, was sufficient."
)
PARA_4 = (
    "Vanity and pride are different things, though the words are often used "
    "synonymously."
)

TEST_CHAPTERS = [
    ("Chapter One", "CHAPTER I", [PARA_1, PARA_2]),
    ("Chapter Two", "CHAPTER II", [PARA_3, PARA_4]),
]

FAKE_JPEG = b"\xff\xd8\xff\xe0" + b"fake-cover-bytes" * 8

CONTAINER_XML = """<?xml version="1.0" encoding="utf-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"""


# ---------------------------------------------------------------------------
# EPUB 构造器（全部在内存里，离线）
# ---------------------------------------------------------------------------

def _xhtml(heading: str | None, paragraphs: list[str]) -> str:
    heading_html = f"<h1>{escape(heading)}</h1>" if heading else ""
    body = "".join(f"<p>{escape(paragraph)}</p>" for paragraph in paragraphs)
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<html xmlns="http://www.w3.org/1999/xhtml">'
        f"<head><title>{escape(heading or 'Chapter')}</title></head>"
        f"<body>{heading_html}{body}</body></html>"
    )


def _nav_xhtml(chapters: list[tuple[str, str | None, list[str]]]) -> str:
    links = "".join(
        f'<li><a href="chapter{index}.xhtml">{escape(toc_title)}</a></li>'
        for index, (toc_title, _heading, _paragraphs) in enumerate(chapters, start=1)
    )
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<html xmlns="http://www.w3.org/1999/xhtml" '
        'xmlns:epub="http://www.idpf.org/2007/ops">'
        f'<body><nav epub:type="toc"><h2>Contents</h2><ol>{links}</ol></nav></body>'
        "</html>"
    )


def _opf3(
    *,
    title: str | None,
    author: str | None,
    language: str,
    items: list[str],
    spine: list[str],
) -> str:
    title_xml = f"<dc:title>{escape(title)}</dc:title>" if title else ""
    author_xml = f"<dc:creator>{escape(author)}</dc:creator>" if author else ""
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
        'unique-identifier="bookid">'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
        '<dc:identifier id="bookid">urn:uuid:test-book</dc:identifier>'
        f"{title_xml}{author_xml}<dc:language>{escape(language)}</dc:language>"
        "</metadata>"
        f"<manifest>{''.join(items)}</manifest>"
        f"<spine>{''.join(spine)}</spine>"
        "</package>"
    )


def _ncx(chapters: list[tuple[str, str | None, list[str]]]) -> str:
    points = "".join(
        f'<navPoint id="np{index}" playOrder="{index}">'
        f"<navLabel><text>{escape(toc_title)}</text></navLabel>"
        f'<content src="chapter{index}.xhtml"/>'
        "</navPoint>"
        for index, (toc_title, _heading, _paragraphs) in enumerate(chapters, start=1)
    )
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">'
        f"<navMap>{points}</navMap></ncx>"
    )


def _zip(files: dict[str, str | bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        info = zipfile.ZipInfo("mimetype")
        info.compress_type = zipfile.ZIP_STORED
        archive.writestr(info, "application/epub+zip")
        for name, data in files.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def build_epub3(
    *,
    title: str | None = "The Test Book",
    author: str | None = "Test Author",
    language: str = "en-US",
    chapters: list[tuple[str, str | None, list[str]]] | None = None,
    cover: bytes | None = None,
    nav: bool = True,
    encryption: bool = False,
    extra_files: dict[str, str | bytes] | None = None,
) -> bytes:
    chapters = TEST_CHAPTERS if chapters is None else chapters
    files: dict[str, str | bytes] = {"META-INF/container.xml": CONTAINER_XML}
    items: list[str] = []
    spine: list[str] = []
    if nav:
        items.append(
            '<item id="nav" href="nav.xhtml" '
            'media-type="application/xhtml+xml" properties="nav"/>'
        )
        files["OEBPS/nav.xhtml"] = _nav_xhtml(chapters)
    for index, (_toc_title, heading, paragraphs) in enumerate(chapters, start=1):
        items.append(
            f'<item id="c{index}" href="chapter{index}.xhtml" '
            'media-type="application/xhtml+xml"/>'
        )
        files[f"OEBPS/chapter{index}.xhtml"] = _xhtml(heading, paragraphs)
        spine.append(f'<itemref idref="c{index}"/>')
    if cover is not None:
        files["OEBPS/cover.jpg"] = cover
        items.append(
            '<item id="cover-img" href="cover.jpg" media-type="image/jpeg" '
            'properties="cover-image"/>'
        )
    files["OEBPS/content.opf"] = _opf3(
        title=title,
        author=author,
        language=language,
        items=items,
        spine=spine,
    )
    if encryption:
        files["META-INF/encryption.xml"] = (
            '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"/>'
        )
    files.update(extra_files or {})
    return _zip(files)


def build_epub2(
    *,
    title: str | None = "The Test Book",
    author: str | None = "Test Author",
    language: str = "en",
    chapters: list[tuple[str, str | None, list[str]]] | None = None,
    cover: bytes | None = None,
) -> bytes:
    chapters = TEST_CHAPTERS if chapters is None else chapters
    files: dict[str, str | bytes] = {"META-INF/container.xml": CONTAINER_XML}
    items: list[str] = [
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
    ]
    spine: list[str] = []
    for index, (_toc_title, heading, paragraphs) in enumerate(chapters, start=1):
        items.append(
            f'<item id="c{index}" href="chapter{index}.xhtml" '
            'media-type="application/xhtml+xml"/>'
        )
        files[f"OEBPS/chapter{index}.xhtml"] = _xhtml(heading, paragraphs)
        spine.append(f'<itemref idref="c{index}"/>')
    cover_meta = ""
    if cover is not None:
        files["OEBPS/cover.jpg"] = cover
        items.append(
            '<item id="cover-img" href="cover.jpg" media-type="image/jpeg"/>'
        )
        cover_meta = '<meta name="cover" content="cover-img"/>'
    title_xml = f"<dc:title>{escape(title)}</dc:title>" if title else ""
    author_xml = f"<dc:creator>{escape(author)}</dc:creator>" if author else ""
    files["OEBPS/content.opf"] = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" '
        'unique-identifier="bookid">'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
        '<dc:identifier id="bookid">urn:uuid:test-book-2</dc:identifier>'
        f"{title_xml}{author_xml}<dc:language>{escape(language)}</dc:language>"
        f"{cover_meta}</metadata>"
        f"<manifest>{''.join(items)}</manifest>"
        f'<spine toc="ncx">{"".join(spine)}</spine>'
        "</package>"
    )
    files["OEBPS/toc.ncx"] = _ncx(chapters)
    return _zip(files)


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def migrated_template_db(tmp_path_factory):
    path = tmp_path_factory.mktemp(TEMPLATE_DB) / "app.db"
    assert_alembic_ok(run_alembic(path, "upgrade", "head"), "upgrade head")
    return path


@pytest.fixture()
def upload_client(migrated_template_db, make_client):
    """已登录 + 已迁移到 head 的客户端（每个用例独立数据库）。"""
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
def second_client(upload_client, make_client):
    with make_client() as test_client:
        response = test_client.post(
            "/api/auth/signup",
            json={"email": SECOND_USER_EMAIL, "password": SECOND_USER_PASSWORD},
        )
        assert response.status_code == 201, response.text
        test_client.user_id = response.json()["user"]["id"]
        yield test_client


class LLMStub:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def __call__(self, prompt: str, model: str) -> str:
        import re

        self.calls.append(prompt)
        indices = sorted({int(value) for value in re.findall(r'"idx":\s*(\d+)', prompt)})
        return json.dumps(
            {
                "translations": [
                    {"idx": index, "text": f"译文段落 {index}"} for index in indices
                ]
            },
            ensure_ascii=False,
        )


@pytest.fixture()
def llm_stub(monkeypatch):
    stub = LLMStub()
    monkeypatch.setattr(book_import, "_call_llm", stub)
    return stub


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def preview(client, data: bytes, filename: str = "book.epub"):
    return client.post(
        "/api/books/upload/preview",
        files={"file": (filename, data, "application/epub+zip")},
    )


def upload_via_token(client, data: bytes, filename: str = "book.epub") -> dict:
    response = preview(client, data, filename)
    assert response.status_code == 200, response.text
    token = response.json()["uploadToken"]
    result = client.post(
        "/api/books/upload",
        data={"uploadToken": token, "rightsAccepted": "true"},
    )
    return result


def upload_direct(client, data: bytes, filename: str = "book.epub"):
    return client.post(
        "/api/books/upload",
        files={"file": (filename, data, "application/epub+zip")},
        data={"rightsAccepted": "true"},
    )


def import_book_or_fail(client, data: bytes) -> dict:
    response = upload_via_token(client, data)
    assert response.status_code == 200, response.text
    return response.json()


def db_counts() -> tuple[int, int]:
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        books = conn.execute("SELECT COUNT(*) FROM imported_books").fetchone()[0]
        translations = conn.execute(
            "SELECT COUNT(*) FROM imported_book_translations"
        ).fetchone()[0]
    return int(books), int(translations)


def quota_used(db_path: Path, user_id: str, feature: str = "reading") -> int:
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT used_units FROM ai_quota WHERE user_id = ? AND feature = ?",
            (user_id, feature),
        ).fetchone()
    return int(row[0]) if row else 0


def book_root(user_id: str, book_id: str) -> Path:
    return Path(config.USER_DATA_DIR) / user_id / "imported-books" / book_id


# ---------------------------------------------------------------------------
# 解析：合法 EPUB
# ---------------------------------------------------------------------------

def test_parse_epub3_metadata_chapters_and_nav():
    data = build_epub3()
    parsed = local_epub.parse_epub(data, filename="my-book.epub")

    assert parsed.title == "The Test Book"
    assert parsed.author == "Test Author"
    assert parsed.language == "en"
    assert parsed.sha256 == __import__("hashlib").sha256(data).hexdigest()
    assert parsed.size_bytes == len(data)
    assert parsed.original_filename == "my-book.epub"
    assert [chapter.n for chapter in parsed.chapters] == [1, 2]
    assert [chapter.title for chapter in parsed.chapters] == ["Chapter One", "Chapter Two"]
    assert parsed.chapters[0].paragraphs[0] == "CHAPTER I"
    assert PARA_1 in parsed.chapters[0].paragraphs
    assert PARA_4 in parsed.chapters[1].paragraphs


def test_parse_epub2_uses_ncx_toc():
    parsed = local_epub.parse_epub(build_epub2(), filename="old-book.epub")
    assert parsed.title == "The Test Book"
    assert parsed.language == "en"
    assert [chapter.title for chapter in parsed.chapters] == ["Chapter One", "Chapter Two"]


def test_parse_without_toc_falls_back_to_spine_headings():
    parsed = local_epub.parse_epub(build_epub3(nav=False), filename="no-toc.epub")
    assert [chapter.title for chapter in parsed.chapters] == ["CHAPTER I", "CHAPTER II"]


def test_parse_single_chapter_without_toc():
    chapters = [("Solo", None, [PARA_1])]
    parsed = local_epub.parse_epub(
        build_epub3(chapters=chapters, nav=False), filename="single.epub"
    )
    assert len(parsed.chapters) == 1
    assert parsed.chapters[0].title == "Chapter 1"


def test_parse_metadata_fallbacks_to_filename_and_en():
    parsed = local_epub.parse_epub(
        build_epub3(title=None, author=None), filename="pride-and-prejudice.epub"
    )
    assert parsed.title == "pride-and-prejudice"
    assert parsed.author is None
    assert parsed.language == "en"


def test_parse_cover_epub3_cover_image():
    parsed = local_epub.parse_epub(build_epub3(cover=FAKE_JPEG), filename="cover.epub")
    assert parsed.cover is not None
    assert parsed.cover.mime == "image/jpeg"
    assert parsed.cover.extension == "jpg"
    assert parsed.cover.data == FAKE_JPEG
    data_url = local_epub.cover_data_url(parsed.cover)
    assert data_url and data_url.startswith("data:image/jpeg;base64,")


def test_parse_cover_epub2_meta_cover():
    parsed = local_epub.parse_epub(build_epub2(cover=FAKE_JPEG), filename="cover2.epub")
    assert parsed.cover is not None
    assert parsed.cover.data == FAKE_JPEG
    assert local_epub.cover_data_url(None) is None


def test_parse_strips_scripts_styles_and_nav_text():
    files = {
        "META-INF/container.xml": CONTAINER_XML,
        "OEBPS/content.opf": _opf3(
            title="T",
            author="A",
            language="en",
            items=['<item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>'],
            spine=['<itemref idref="c1"/>'],
        ),
        "OEBPS/chapter1.xhtml": (
            '<html><head><style>p{color:red}</style></head><body>'
            "<nav><a href='x'>Should not appear</a></nav>"
            "<script>alert('x')</script>"
            "<p>Real&nbsp;text &amp; more.</p>"
            "</body></html>"
        ),
    }
    parsed = local_epub.parse_epub(_zip(files), filename="dirty.epub")
    paragraphs = parsed.chapters[0].paragraphs
    assert paragraphs == ("Real text & more.",)
    assert all("alert" not in item for item in paragraphs)


# ---------------------------------------------------------------------------
# 解析：拒绝
# ---------------------------------------------------------------------------

def test_rejects_not_a_zip():
    with pytest.raises(local_epub.InvalidEpub):
        local_epub.parse_epub(b"this is not an epub", filename="x.epub")
    with pytest.raises(local_epub.InvalidEpub):
        local_epub.parse_epub(b"", filename="x.epub")


def test_rejects_corrupt_zip():
    with pytest.raises(local_epub.InvalidEpub):
        local_epub.parse_epub(b"PK\x03\x04" + b"garbage" * 10, filename="x.epub")


def test_rejects_drm_encryption_xml():
    with pytest.raises(local_epub.EpubUnsupported) as excinfo:
        local_epub.parse_epub(build_epub3(encryption=True), filename="drm.epub")
    assert "DRM" in str(excinfo.value) or "加密" in str(excinfo.value)


def test_rejects_non_english_language():
    with pytest.raises(local_epub.EpubUnsupported) as excinfo:
        local_epub.parse_epub(build_epub3(language="fr-FR"), filename="fr.epub")
    assert "英文" in str(excinfo.value)


def test_rejects_book_without_body():
    chapters = [("Empty", None, [])]
    data = build_epub3(chapters=chapters)
    with pytest.raises(local_epub.EpubUnsupported) as excinfo:
        local_epub.parse_epub(data, filename="empty.epub")
    assert "正文" in str(excinfo.value)


def test_rejects_zip_bomb_by_uncompressed_total(monkeypatch):
    monkeypatch.setattr(config, "MAX_LOCAL_EPUB_UNCOMPRESSED_BYTES", 100)
    with pytest.raises(local_epub.EpubTooLarge):
        local_epub.parse_epub(build_epub3(), filename="bomb.epub")


def test_rejects_too_many_zip_entries(monkeypatch):
    monkeypatch.setattr(config, "MAX_LOCAL_EPUB_ENTRIES", 2)
    with pytest.raises(local_epub.EpubTooLarge):
        local_epub.parse_epub(build_epub3(), filename="many.epub")


def test_rejects_path_traversal_entries():
    data = build_epub3(extra_files={"../evil.txt": "owned"})
    with pytest.raises(local_epub.InvalidEpub) as excinfo:
        local_epub.parse_epub(data, filename="evil.epub")
    assert "路径" in str(excinfo.value)

    data = build_epub3(extra_files={"/abs/evil.txt": "owned"})
    with pytest.raises(local_epub.InvalidEpub):
        local_epub.parse_epub(data, filename="evil2.epub")


def test_rejects_xml_entity_declarations():
    files = {
        "META-INF/container.xml": CONTAINER_XML,
        "OEBPS/content.opf": (
            '<?xml version="1.0"?>'
            '<!DOCTYPE package [<!ENTITY boom "boom">]>'
            '<package xmlns="http://www.idpf.org/2007/opf" version="3.0">'
            "<metadata><title>&boom;</title></metadata></package>"
        ),
    }
    with pytest.raises(local_epub.InvalidEpub) as excinfo:
        local_epub.parse_epub(_zip(files), filename="entity.epub")
    assert "实体" in str(excinfo.value)


def test_rejects_too_many_chapters(monkeypatch):
    monkeypatch.setattr(config, "MAX_LOCAL_EPUB_CHAPTERS", 1)
    with pytest.raises(local_epub.EpubTooLarge):
        local_epub.parse_epub(build_epub3(), filename="many-chapters.epub")


def test_rejects_overlong_chapter(monkeypatch):
    monkeypatch.setattr(config, "MAX_LOCAL_EPUB_CHAPTER_CHARS", 10)
    with pytest.raises(local_epub.EpubTooLarge):
        local_epub.parse_epub(build_epub3(), filename="long.epub")


def test_rejects_oversized_upload(monkeypatch):
    monkeypatch.setattr(config, "MAX_LOCAL_EPUB_BYTES", 100)
    with pytest.raises(local_epub.EpubTooLarge):
        local_epub.parse_epub(build_epub3(), filename="big.epub")


# ---------------------------------------------------------------------------
# 本地存储：读写 / 删除
# ---------------------------------------------------------------------------

def test_save_read_and_delete_book_files(upload_client):
    data = build_epub3(cover=FAKE_JPEG)
    parsed = local_epub.parse_epub(data, filename="stored.epub")
    user_id = upload_client.user_id
    book_id = "epub-" + "a" * 32
    chapters_json = local_epub.save_book(user_id, book_id, parsed)

    payload = json.loads(chapters_json)
    assert payload["version"] == 2
    assert payload["provider"] == "local_epub"
    assert payload["sha256"] == parsed.sha256
    assert payload["chapters"][0]["file"] == "chapters/0001.json"
    assert "url" not in payload["chapters"][0]

    root = book_root(user_id, book_id)
    assert (root / "meta.json").is_file()
    assert (root / "chapters" / "0001.json").is_file()
    assert (root / "cover.jpg").is_file()
    assert local_epub.has_cover(user_id, book_id) is True
    assert local_epub.read_chapter(user_id, book_id, 1)[0] == "CHAPTER I"
    cover = local_epub.read_cover(user_id, book_id)
    assert cover is not None and cover[1] == "image/jpeg"

    count, text_bytes = local_epub.book_usage(user_id)
    assert count == 1 and text_bytes > 0

    local_epub.delete_book(user_id, book_id)
    assert not root.exists()
    # 幂等：再删一次不报错。
    local_epub.delete_book(user_id, book_id)


def test_read_missing_chapter_file_raises_503(upload_client):
    user_id = upload_client.user_id
    book_id = "epub-" + "b" * 32
    Path(config.USER_DATA_DIR, user_id, "imported-books", book_id).mkdir(parents=True)
    with pytest.raises(local_epub.LocalEpubUnavailable):
        local_epub.read_chapter(user_id, book_id, 1)


def test_staging_token_is_single_use_and_expires(upload_client, monkeypatch):
    user_id = upload_client.user_id
    data = build_epub3()
    token = local_epub.stage_upload(user_id, data, "staged.epub")
    taken, filename = local_epub.take_staged_upload(user_id, token)
    assert taken == data and filename == "staged.epub"
    with pytest.raises(local_epub.InvalidEpub):
        local_epub.take_staged_upload(user_id, token)

    token = local_epub.stage_upload(user_id, data, "expired.epub")
    monkeypatch.setattr(local_epub, "STAGING_TTL_SECONDS", -1)
    with pytest.raises(local_epub.InvalidEpub):
        local_epub.take_staged_upload(user_id, token)


# ---------------------------------------------------------------------------
# API：preview
# ---------------------------------------------------------------------------

def test_preview_returns_metadata_without_writing_db(upload_client):
    response = preview(upload_client, build_epub3(cover=FAKE_JPEG))
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["uploadToken"]
    assert payload["fileName"] == "book.epub"
    assert payload["title"] == "The Test Book"
    assert payload["author"] == "Test Author"
    assert payload["language"] == "en"
    assert payload["chapterCount"] == 2
    assert [chapter["n"] for chapter in payload["chapters"]] == [1, 2]
    assert payload["coverDataUrl"].startswith("data:image/jpeg;base64,")
    assert payload["sizeBytes"] > 0

    # 预览不落库、不建正式书目录（只暂存原始文件）。
    assert db_counts() == (0, 0)
    books_dir = Path(config.USER_DATA_DIR, upload_client.user_id, "imported-books")
    assert not books_dir.exists() or list(books_dir.iterdir()) == []


def test_preview_requires_login(make_client):
    with make_client() as client:
        response = preview(client, build_epub3())
    assert response.status_code == 401
    assert "登录" in response.json()["detail"]


def test_preview_rejects_non_epub_filename(upload_client):
    response = preview(upload_client, build_epub3(), filename="book.pdf")
    assert response.status_code == 400
    assert ".epub" in response.json()["detail"]


def test_preview_rejects_corrupt_file(upload_client):
    response = preview(upload_client, b"PK\x03\x04broken")
    assert response.status_code == 400


def test_preview_rejects_drm(upload_client):
    response = preview(upload_client, build_epub3(encryption=True))
    assert response.status_code == 422
    assert "DRM" in response.json()["detail"] or "加密" in response.json()["detail"]


def test_preview_rejects_non_english(upload_client):
    response = preview(upload_client, build_epub3(language="de-DE"))
    assert response.status_code == 422
    assert "英文" in response.json()["detail"]


def test_preview_rejects_too_large(upload_client, monkeypatch):
    monkeypatch.setattr(config, "MAX_LOCAL_EPUB_BYTES", 100)
    response = preview(upload_client, build_epub3())
    assert response.status_code == 413
    assert "上限" in response.json()["detail"]


def test_preview_rejects_too_many_chapters(upload_client, monkeypatch):
    monkeypatch.setattr(config, "MAX_LOCAL_EPUB_CHAPTERS", 1)
    response = preview(upload_client, build_epub3())
    assert response.status_code == 413


def test_preview_rate_limited(upload_client, monkeypatch):
    monkeypatch.setattr(config, "RATE_LIMIT_BOOKS_PER_MINUTE", 1)
    assert preview(upload_client, build_epub3()).status_code == 200
    response = preview(upload_client, build_epub3())
    assert response.status_code == 429
    assert response.headers.get("Retry-After")


# ---------------------------------------------------------------------------
# API：确认导入 / 幂等 / 配额
# ---------------------------------------------------------------------------

def test_upload_from_token_creates_local_book(upload_client):
    data = build_epub3(cover=FAKE_JPEG)
    response = upload_via_token(upload_client, data)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["bookId"].startswith("epub-")
    assert payload["title"] == "The Test Book"
    assert payload["author"] == "Test Author"
    assert payload["chapterCount"] == 2
    assert payload["sourceType"] == "local_epub"
    assert payload["existing"] is False

    book_id = payload["bookId"]
    assert book_root(upload_client.user_id, book_id).is_dir()
    assert db_counts() == (1, 0)

    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        row = conn.execute(
            "SELECT source_type, source_url, external_id, chapters_json "
            "FROM imported_books WHERE id = ?",
            (book_id,),
        ).fetchone()
    assert row[0] == "local_epub"
    assert row[1] == f"local://{__import__('hashlib').sha256(data).hexdigest()}"
    assert row[2] == f"epub:{__import__('hashlib').sha256(data).hexdigest()}"
    chapters_json = json.loads(row[3])
    assert chapters_json["version"] == 2
    assert chapters_json["originalFilename"] == "book.epub"
    assert chapters_json["chapters"][0]["file"] == "chapters/0001.json"
    assert PARA_1 not in row[3]

    listing = upload_client.get("/api/books/imported").json()["books"]
    assert len(listing) == 1
    book = listing[0]
    assert book["sourceType"] == "local_epub"
    assert book["local"] is True
    assert book["coverUrl"] == f"/api/books/imported/{book_id}/cover"
    assert book["sourceUrl"] is None
    assert book["source"]["url"] is None
    assert book["source"]["provider"] == "Local EPUB"
    assert book["chapterCount"] == 2

    detail = upload_client.get(f"/api/books/imported/{book_id}").json()
    assert [chapter["title"] for chapter in detail["chapters"]] == [
        "Chapter One",
        "Chapter Two",
    ]
    assert detail["coverUrl"] == f"/api/books/imported/{book_id}/cover"

    chapter = upload_client.get(f"/api/books/imported/{book_id}/chapters/1").json()
    assert chapter["chapterTitle"] == "Chapter One"
    assert chapter["chapterCount"] == 2
    assert chapter["paragraphs"][0]["en"] == "CHAPTER I"
    assert PARA_1 in [paragraph["en"] for paragraph in chapter["paragraphs"]]
    assert chapter["paragraphs"][0]["zh"] is None
    assert chapter["source"]["provider"] == "Local EPUB"
    assert chapter["source"]["url"] is None
    assert chapter["sourceUrl"] is None
    assert chapter["translated"] is False


def test_upload_direct_file_without_preview(upload_client):
    response = upload_direct(upload_client, build_epub3())
    assert response.status_code == 200, response.text
    assert response.json()["sourceType"] == "local_epub"
    assert response.json()["existing"] is False


def test_upload_requires_rights_confirmation(upload_client):
    data = build_epub3()
    token = preview(upload_client, data).json()["uploadToken"]
    response = upload_client.post(
        "/api/books/upload", data={"uploadToken": token}
    )
    assert response.status_code == 400
    assert "使用权" in response.json()["detail"]

    response = upload_client.post(
        "/api/books/upload",
        data={"uploadToken": token, "rightsAccepted": "false"},
    )
    assert response.status_code == 400
    assert db_counts() == (0, 0)


def test_upload_accepts_rights_true(upload_client):
    data = build_epub3()
    token = preview(upload_client, data).json()["uploadToken"]
    response = upload_client.post(
        "/api/books/upload",
        data={"uploadToken": token, "rightsAccepted": "true"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["existing"] is False


def test_upload_missing_file_and_token_is_400(upload_client):
    response = upload_client.post(
        "/api/books/upload", data={"rightsAccepted": "true"}
    )
    assert response.status_code == 400


def test_upload_invalid_token_is_400(upload_client):
    response = upload_client.post(
        "/api/books/upload",
        data={"uploadToken": "not-a-real-token", "rightsAccepted": "true"},
    )
    assert response.status_code == 400
    assert "上传凭证" in response.json()["detail"] or "预览" in response.json()["detail"]


def test_upload_expired_token_is_400(upload_client, monkeypatch):
    data = build_epub3()
    token = preview(upload_client, data).json()["uploadToken"]
    monkeypatch.setattr(local_epub, "STAGING_TTL_SECONDS", -1)
    response = upload_client.post(
        "/api/books/upload",
        data={"uploadToken": token, "rightsAccepted": "true"},
    )
    assert response.status_code == 400
    assert "过期" in response.json()["detail"]


def test_upload_requires_login(make_client):
    with make_client() as client:
        response = client.post(
            "/api/books/upload", data={"rightsAccepted": "true"}
        )
    assert response.status_code == 401


def test_repeat_upload_is_idempotent_and_keeps_quota(upload_client, monkeypatch):
    monkeypatch.setattr(config, "RATE_LIMIT_BOOK_UPLOAD_PER_DAY", 1)
    data = build_epub3()
    first = import_book_or_fail(upload_client, data)
    second = import_book_or_fail(upload_client, data)

    assert second["bookId"] == first["bookId"]
    assert second["existing"] is True
    assert db_counts()[0] == 1
    # 同账号同 SHA-256 的重复上传不额外占日限；写一本不同的书才会 429。
    different = build_epub3(title="Another Book", chapters=[("Only", "Only", [PARA_4])])
    response = upload_via_token(upload_client, different)
    assert response.status_code == 429
    assert "上传次数" in response.json()["detail"]
    assert response.headers.get("Retry-After")


def test_upload_daily_limit(upload_client, monkeypatch):
    monkeypatch.setattr(config, "RATE_LIMIT_BOOK_UPLOAD_PER_DAY", 1)
    assert upload_via_token(upload_client, build_epub3()).status_code == 200
    other = build_epub3(title="Second", chapters=[("Only", "Only", [PARA_3])])
    response = upload_via_token(upload_client, other)
    assert response.status_code == 429
    assert "上传次数" in response.json()["detail"]


def test_upload_book_count_quota(upload_client, monkeypatch):
    monkeypatch.setattr(config, "MAX_LOCAL_BOOKS_PER_USER", 1)
    assert upload_via_token(upload_client, build_epub3()).status_code == 200
    other = build_epub3(title="Second", chapters=[("Only", "Only", [PARA_3])])
    response = upload_via_token(upload_client, other)
    assert response.status_code == 429
    assert "上限" in response.json()["detail"]


def test_upload_text_quota(upload_client, monkeypatch):
    monkeypatch.setattr(config, "MAX_LOCAL_BOOK_TEXT_BYTES", 10)
    response = upload_via_token(upload_client, build_epub3())
    assert response.status_code == 429
    assert "上限" in response.json()["detail"]
    assert db_counts() == (0, 0)


# ---------------------------------------------------------------------------
# API：封面 / 权限 / 删除 / 翻译
# ---------------------------------------------------------------------------

def test_cover_endpoint_returns_bytes(upload_client):
    book_id = import_book_or_fail(upload_client, build_epub3(cover=FAKE_JPEG))["bookId"]
    response = upload_client.get(f"/api/books/imported/{book_id}/cover")
    assert response.status_code == 200
    assert response.content == FAKE_JPEG
    assert response.headers["content-type"] == "image/jpeg"
    assert "private" in response.headers["cache-control"]


def test_cover_endpoint_404_without_cover(upload_client):
    book_id = import_book_or_fail(upload_client, build_epub3())["bookId"]
    response = upload_client.get(f"/api/books/imported/{book_id}/cover")
    assert response.status_code == 404
    assert "封面" in response.json()["detail"]


def test_cover_is_isolated_per_user(upload_client, second_client):
    book_id = import_book_or_fail(upload_client, build_epub3(cover=FAKE_JPEG))["bookId"]
    assert (
        second_client.get(f"/api/books/imported/{book_id}/cover").status_code == 404
    )
    # 原书封面仍可被所有者读取。
    assert (
        upload_client.get(f"/api/books/imported/{book_id}/cover").status_code == 200
    )


def test_cover_requires_login(make_client):
    with make_client() as client:
        response = client.get("/api/books/imported/whatever/cover")
    assert response.status_code == 401


def test_second_user_cannot_read_or_delete_local_book(upload_client, second_client):
    book_id = import_book_or_fail(upload_client, build_epub3(cover=FAKE_JPEG))["bookId"]

    assert second_client.get("/api/books/imported").json()["books"] == []
    assert second_client.get(f"/api/books/imported/{book_id}").status_code == 404
    assert (
        second_client.get(f"/api/books/imported/{book_id}/chapters/1").status_code
        == 404
    )
    assert second_client.delete(f"/api/books/imported/{book_id}").status_code == 404
    # 原书仍在。
    assert upload_client.get(f"/api/books/imported/{book_id}").status_code == 200


def test_delete_cleans_db_files_cover_and_translations(
    upload_client, llm_stub
):
    book_id = import_book_or_fail(upload_client, build_epub3(cover=FAKE_JPEG))["bookId"]
    root = book_root(upload_client.user_id, book_id)
    assert root.is_dir()

    translated = upload_client.post(
        f"/api/books/imported/{book_id}/chapters/1/translate", json={}
    )
    assert translated.status_code == 200, translated.text
    assert db_counts() == (1, 1)

    response = upload_client.delete(f"/api/books/imported/{book_id}")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "bookId": book_id}
    assert not root.exists()
    assert db_counts() == (0, 0)
    assert upload_client.get(f"/api/books/imported/{book_id}").status_code == 404


def test_translate_local_chapter_uses_cache_and_quota(
    upload_client, llm_stub
):
    book_id = import_book_or_fail(upload_client, build_epub3())["bookId"]

    first = upload_client.post(
        f"/api/books/imported/{book_id}/chapters/1/translate", json={}
    )
    assert first.status_code == 200, first.text
    payload = first.json()
    assert payload["status"] == "done"
    assert payload["total"] == 3  # h1 + 2 段
    assert payload["translated"] == 3
    assert payload["batches"] == 1
    assert len(llm_stub.calls) == 1
    assert quota_used(Path(config.AUTH_DB_PATH), upload_client.user_id) == 1

    chapter = upload_client.get(f"/api/books/imported/{book_id}/chapters/1").json()
    assert chapter["translated"] is True
    assert chapter["paragraphs"][0]["zh"] == "译文段落 0"

    second = upload_client.post(
        f"/api/books/imported/{book_id}/chapters/1/translate", json={}
    )
    assert second.status_code == 200, second.text
    assert second.json()["status"] == "cached"
    assert len(llm_stub.calls) == 1
    assert quota_used(Path(config.AUTH_DB_PATH), upload_client.user_id) == 1


def test_translate_second_chapter_reads_local_file(upload_client, llm_stub):
    book_id = import_book_or_fail(upload_client, build_epub3())["bookId"]
    response = upload_client.post(
        f"/api/books/imported/{book_id}/chapters/2/translate", json={}
    )
    assert response.status_code == 200, response.text
    chapter = upload_client.get(f"/api/books/imported/{book_id}/chapters/2").json()
    assert chapter["chapterTitle"] == "Chapter Two"
    assert chapter["paragraphs"][-1]["en"] == PARA_4
    assert chapter["paragraphs"][-1]["zh"] == "译文段落 2"


def test_local_chapter_file_missing_is_503_not_fake_success(upload_client):
    book_id = import_book_or_fail(upload_client, build_epub3())["bookId"]
    chapter_file = book_root(upload_client.user_id, book_id) / "chapters" / "0001.json"
    chapter_file.unlink()
    response = upload_client.get(f"/api/books/imported/{book_id}/chapters/1")
    assert response.status_code == 503
    assert response.json()["detail"]
