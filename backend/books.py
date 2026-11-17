"""公版书系列阅读库（用户需求：公版书系列阅读库）。

架构约定（用户明确要求）：

- 仓库只存 **书单元数据 + 本地中译文**（``content/books/``），**不存英文原文**；
- 打开某一章时，后端按 ``sourceUrl`` **实时抓取公版源**（Project Gutenberg /
  Standard Ebooks 等），解析成段落，再与本地译文按下标对齐返回 ``{en, zh}``；
- 正常请求每次都抓取；抓取失败时只允许用进程内 5 分钟缓存降级，
  绝不写磁盘、不建原文表。
- 本地没有译文时，调用方可以把全局译文缓存（``book_chapter_translations``，
  由 ``book_translation.py`` 读写）按下标传进来，用
  :func:`merge_cached_translations` 合并；本模块仍然不 import ``llm``、不连
  数据库。

本模块只负责「书单校验 + 公版源抓取/解析/对齐」。HTTP 语义在
``routes_books.py``；不 import ``llm``、不连数据库、不写任何状态文件。

源站抓取边界（与 ``transcripts.py`` 的抓取纪律一致）：

- 只允许竖名单内的公版站点（https、无 userinfo/端口、重定向后仍须在名单内）；
- 连接/读取超时、流式读取的响应体大小上限；
- 明确 User-Agent，先读 robots.txt；robots 无法读取（404/网络故障）时按
  「站点未声明限制」处理，但保留告警日志；
- 源站 404/超时/内容损坏统一抛 ``BookSourceUnavailable``，路由层转 503。
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

import requests

import config
import languages

logger = logging.getLogger("linguatrek.books")

MAX_ID_CHARS = 80
MAX_TITLE_CHARS = 300
MAX_AUTHOR_CHARS = 160
MAX_DESCRIPTION_CHARS = 600
MAX_URL_CHARS = 2048
MAX_CHAPTERS = 200
MAX_ANCHOR_CHARS = 300
MAX_PARAGRAPHS = 500
MAX_PARAGRAPH_CHARS = 12000
MAX_SERIES = 50
MAX_BOOKS = 200
MAX_TRANSLATION_CHARS = 16000
MAX_ROBOTS_BYTES = 128 * 1024

LEVELS = frozenset({"A1", "A2", "B1", "B2", "C1", "C2"})
STATUSES = frozenset({"available", "coming_soon"})
LICENSE = "Public domain in the US"

# 公版源主机白名单。GitHub 等任意 URL 一律不碰（SSRF 最小面）。
_ALLOWED_SOURCE_HOSTS = frozenset(
    {
        "www.gutenberg.org",
        "gutenberg.org",
        "gutenberg.pglaf.org",
        "aleph.gutenberg.org",
        "standardebooks.org",
        "www.standardebooks.org",
    }
)
# Project Gutenberg 主站维护时的官方镜像（同路径回退）；仍属于 PG 公版源。
_GUTENBERG_MIRROR_HOSTS = ("gutenberg.pglaf.org",)

USER_AGENT = (
    "LinguaTrekBooks/1.0 (+https://github.com/XuehaiQiao/yt-bilingual-app; "
    "public-domain reading; contact: local app)"
)

_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_ROBOTS_TOKEN = "linguatrekbooks"
_START_RE = re.compile(
    r"^\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*?\*\*\*\s*$",
    re.MULTILINE,
)
_END_RE = re.compile(
    r"^\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*?\*\*\*\s*$",
    re.MULTILINE,
)
# Gutenberg 小说正文标题：`Chapter I` / `CHAPTER I.`，标题文字在下一行。
# 目录里的 `Chapter I. The Cyclone` 因为同行还有标题，不会命中这个锚定正则。
_CHAPTER_HEADING_RE = re.compile(
    r"^[ \t]*(?:CHAPTER|Chapter)[ \t]+([IVXLCDM]+)\.?[ \t]*$",
    re.MULTILINE,
)
_ILLUSTRATION_RE = re.compile(r"^\[?\s*illustration\s*\]?$", re.IGNORECASE)
_EMPHASIS_RE = re.compile(r"_([^_\n]+)_")
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class BooksUnavailable(RuntimeError):
    """书单/译文损坏，HTTP 503。"""


class BookNotFound(KeyError):
    """书或章节不存在，HTTP 404。"""


class BookSourceUnavailable(RuntimeError):
    """公版源抓取/解析失败，HTTP 503。"""


class _ResponseTooLarge(BookSourceUnavailable):
    pass


@dataclass(frozen=True)
class ParsedChapter:
    number: int
    title: str
    paragraphs: list[str]


@dataclass(frozen=True)
class SourceResult:
    chapters: list[ParsedChapter]
    final_url: str
    fetched_at: float
    degraded: bool


# 只在进程内、只用于降级/去重；key = (book_id, chapter_number) 便于按章粗粒度复用。
_cache: "OrderedDict[tuple[str, int], SourceResult]" = OrderedDict()
_cache_lock = threading.Lock()
_robots_cache: dict[str, tuple[float, bool, str]] = {}
_robots_lock = threading.Lock()


def books_dir() -> Path:
    return Path(config.BOOKS_DIR)


def reset_cache() -> None:
    """测试/运维用：清空进程内源站缓存与 robots 判定。"""
    with _cache_lock:
        _cache.clear()
    with _robots_lock:
        _robots_cache.clear()


# ---------------------------------------------------------------------------
# 书单校验
# ---------------------------------------------------------------------------


def _ensure(condition: bool, message: str) -> None:
    if not condition:
        raise BooksUnavailable(message)


def _year(value: Any, where: str) -> int:
    _ensure(
        isinstance(value, int) and not isinstance(value, bool) and 1000 <= value <= 2100,
        f"{where} 非法",
    )
    return value


def _text(data: dict, key: str, *, limit: int, where: str, default: str | None = None) -> str:
    raw = data.get(key, default)
    _ensure(isinstance(raw, str) and bool(raw.strip()), f"{where} 缺少 {key}")
    value = raw.strip()
    _ensure(len(value) <= limit, f"{where} 的 {key} 过长")
    return value


def _valid_id(value: Any) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= MAX_ID_CHARS
        and _ID_RE.fullmatch(value) is not None
    )


def validate_source_url(raw: Any, *, where: str) -> str:
    """只接受白名单公版站点的 https 直链；供运行期抓取与书单校验共用。"""
    _ensure(isinstance(raw, str) and raw.strip(), f"{where} 缺少 sourceUrl")
    value = raw.strip()
    _ensure(len(value) <= MAX_URL_CHARS, f"{where} 的 sourceUrl 过长")
    _ensure(not _CONTROL_RE.search(value), f"{where} 的 sourceUrl 含控制字符")
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise BooksUnavailable(f"{where} 的 sourceUrl 非法") from exc
    _ensure(parsed.scheme == "https", f"{where} 的 sourceUrl 必须是 https")
    _ensure(bool(parsed.netloc) and "@" not in parsed.netloc, f"{where} 的 sourceUrl 非法")
    try:
        port = parsed.port
    except ValueError as exc:
        raise BooksUnavailable(f"{where} 的 sourceUrl 端口非法") from exc
    _ensure(port in (None, 443), f"{where} 的 sourceUrl 不允许自定义端口")
    host = (parsed.hostname or "").lower()
    _ensure(host in _ALLOWED_SOURCE_HOSTS, f"{where} 的 sourceUrl 不是公版源白名单站点")
    _ensure(bool(parsed.path) and parsed.path != "/", f"{where} 的 sourceUrl 缺少路径")
    return value


def _optional_url(data: dict, key: str, *, where: str) -> str | None:
    raw = data.get(key)
    if raw is None:
        return None
    return validate_source_url(raw, where=f"{where} 的 {key}")


def _chapter_list(book: dict, where: str) -> list[dict]:
    raw = book.get("chapters", [])
    _ensure(isinstance(raw, list), f"{where} 的 chapters 必须是数组")
    _ensure(len(raw) <= MAX_CHAPTERS, f"{where} 的章节过多")
    result: list[dict] = []
    seen: set[int] = set()
    for index, item in enumerate(raw):
        item_where = f"{where} 第 {index + 1} 个章节"
        _ensure(isinstance(item, dict), f"{item_where} 必须是对象")
        number = item.get("n")
        _ensure(
            isinstance(number, int) and not isinstance(number, bool) and 1 <= number <= MAX_CHAPTERS,
            f"{item_where} 的 n 非法",
        )
        _ensure(number not in seen, f"{item_where} 的 n 重复")
        seen.add(number)
        chapter = {
            "n": number,
            "title": _text(item, "title", limit=MAX_TITLE_CHARS, where=item_where),
        }
        anchor = item.get("anchor")
        if anchor is not None:
            _ensure(
                isinstance(anchor, str) and bool(anchor.strip()),
                f"{item_where} 的 anchor 非法",
            )
            anchor = " ".join(anchor.replace("_", " ").split())
            _ensure(
                len(anchor) <= MAX_ANCHOR_CHARS,
                f"{item_where} 的 anchor 过长",
            )
            chapter["anchor"] = anchor
        skip_title = item.get("skipTitle")
        if skip_title is not None:
            _ensure(isinstance(skip_title, bool), f"{item_where} 的 skipTitle 非法")
            chapter["skipTitle"] = skip_title
        occurrence = item.get("occurrence")
        if occurrence is not None:
            _ensure(
                isinstance(occurrence, int)
                and not isinstance(occurrence, bool)
                and 1 <= occurrence <= 50,
                f"{item_where} 的 occurrence 非法",
            )
            chapter["occurrence"] = occurrence
        result.append(chapter)
    result.sort(key=lambda chapter: chapter["n"])
    return result


def _book(data: dict, series_id: str, where: str) -> dict:
    _ensure(isinstance(data, dict), f"{where} 必须是对象")
    book_id = data.get("id")
    _ensure(_valid_id(book_id), f"{where} 的 id 非法")
    status = data.get("status")
    _ensure(status in STATUSES, f"{where} 的 status 非法")
    year = data.get("year")
    _ensure(
        isinstance(year, int) and not isinstance(year, bool) and 1000 <= year <= 2100,
        f"{where} 的 year 非法",
    )
    level = data.get("level")
    _ensure(level in LEVELS, f"{where} 的 level 必须是 A1–C2")
    source = _text(data, "source", limit=MAX_AUTHOR_CHARS, where=where)
    license_ = _text(data, "license", limit=MAX_TITLE_CHARS, where=where)
    _ensure(
        license_ == LICENSE,
        f"{where} 的 license 必须是 “{LICENSE}”（逐本核对公版状态）",
    )
    public_domain_basis = _text(
        data, "publicDomainBasis", limit=600, where=f"{where} 的公版依据"
    )
    source_url = validate_source_url(data.get("sourceUrl"), where=where)
    catalog_url = _optional_url(data, "catalogUrl", where=where)

    total_raw = data.get("totalChapters")
    if status == "available":
        _ensure(
            isinstance(total_raw, int)
            and not isinstance(total_raw, bool)
            and 1 <= total_raw <= MAX_CHAPTERS,
            f"{where} 的 totalChapters 非法",
        )
        total_chapters = total_raw
        chapters = _chapter_list(data, where)
        _ensure(bool(chapters), f"{where} 还没有可读章节，却标成了 available")
        _ensure(
            all(chapter["n"] <= total_chapters for chapter in chapters),
            f"{where} 的章节号超过 totalChapters",
        )
        _ensure(
            len(chapters) == total_chapters,
            f"{where} 的章节索引不完整（{len(chapters)}/{total_chapters}）",
        )
    else:
        total_chapters = total_raw if isinstance(total_raw, int) and not isinstance(total_raw, bool) else 0
        _ensure(total_chapters >= 0, f"{where} 的 totalChapters 非法")
        chapters = []

    book = {
        "id": book_id,
        "seriesId": series_id,
        "title": _text(data, "title", limit=MAX_TITLE_CHARS, where=where),
        "titleZh": _text(data, "titleZh", limit=MAX_TITLE_CHARS, where=where),
        "author": _text(data, "author", limit=MAX_AUTHOR_CHARS, where=where),
        "year": year,
        "level": level,
        "status": status,
        "source": source,
        "license": license_,
        "publicDomainBasis": public_domain_basis,
        "sourceUrl": source_url,
        "totalChapters": total_chapters,
        "chapters": chapters,
        "readableChapters": len(chapters),
    }
    words = data.get("words")
    if words is not None:
        _ensure(
            isinstance(words, int) and not isinstance(words, bool) and 0 <= words <= 20_000_000,
            f"{where} 的 words 非法",
        )
        book["words"] = words
    if catalog_url:
        book["catalogUrl"] = catalog_url
    for optional in ("gutenbergId",):
        value = data.get(optional)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            book[optional] = value
    content_note = data.get("contentNote")
    if isinstance(content_note, str) and content_note.strip():
        _ensure(
            len(content_note.strip()) <= MAX_DESCRIPTION_CHARS,
            f"{where} 的 contentNote 过长",
        )
        book["contentNote"] = content_note.strip()
    parser_config = data.get("parser")
    if parser_config is not None:
        _ensure(isinstance(parser_config, dict), f"{where} 的 parser 必须是对象")
        mode = parser_config.get("mode")
        _ensure(mode in ("anchors", "chapters", "single"), f"{where} 的 parser.mode 非法")
        clean_parser: dict[str, Any] = {"mode": mode}
        body_start = parser_config.get("bodyStart")
        if body_start is not None:
            _ensure(
                isinstance(body_start, str) and 0 < len(body_start.strip()) <= 200,
                f"{where} 的 parser.bodyStart 非法",
            )
            clean_parser["bodyStart"] = body_start.strip()
        body_end = parser_config.get("bodyEnd")
        if body_end is not None:
            _ensure(
                isinstance(body_end, str) and 0 < len(body_end.strip()) <= 200,
                f"{where} 的 parser.bodyEnd 非法",
            )
            clean_parser["bodyEnd"] = body_end.strip()
        if mode == "single":
            _ensure(
                "bodyStart" in clean_parser,
                f"{where} 的 parser.mode=single 必须给 bodyStart",
            )
        if mode == "anchors":
            _ensure(
                bool(chapters)
                and all("anchor" in chapter for chapter in chapters),
                f"{where} 的 parser.mode=anchors 要求每章都有 anchor",
            )
        drop_captions = parser_config.get("dropCaptions")
        if drop_captions is not None:
            _ensure(isinstance(drop_captions, bool), f"{where} 的 parser.dropCaptions 非法")
            clean_parser["dropCaptions"] = drop_captions
        book["parser"] = clean_parser
    return book


def _series(data: dict, where: str) -> dict:
    _ensure(isinstance(data, dict), f"{where} 必须是对象")
    series_id = data.get("id")
    _ensure(_valid_id(series_id), f"{where} 的 id 非法")
    books_raw = data.get("books")
    _ensure(isinstance(books_raw, list) and books_raw, f"{where} 缺少 books")
    _ensure(len(books_raw) <= MAX_BOOKS, f"{where} 的书籍过多")
    books: list[dict] = []
    for index, item in enumerate(books_raw):
        books.append(_book(item, series_id, f"{where} 第 {index + 1} 本"))
    ids = [book["id"] for book in books]
    _ensure(len(ids) == len(set(ids)), f"{where} 含重复的书籍 id")
    excluded_raw = data.get("excluded", [])
    _ensure(isinstance(excluded_raw, list), f"{where} 的 excluded 必须是数组")
    _ensure(len(excluded_raw) <= 80, f"{where} 的 excluded 条目过多")
    excluded: list[dict] = []
    for index, item in enumerate(excluded_raw):
        item_where = f"{where} 排除清单第 {index + 1} 项"
        _ensure(isinstance(item, dict), f"{item_where} 必须是对象")
        excluded.append(
            {
                "title": _text(item, "title", limit=MAX_TITLE_CHARS, where=item_where),
                "year": _year(item.get("year"), f"{item_where} 的 year"),
                "reason": _text(
                    item, "reason", limit=MAX_DESCRIPTION_CHARS, where=item_where
                ),
            }
        )
    series = {
        "id": series_id,
        "title": _text(data, "title", limit=MAX_TITLE_CHARS, where=where),
        "author": _text(data, "author", limit=MAX_AUTHOR_CHARS, where=where),
        "description": _text(
            data, "description", limit=MAX_DESCRIPTION_CHARS, where=where
        ),
        "excluded": excluded,
        "books": books,
    }
    try:
        order = data.get("readingOrder")
        if isinstance(order, list) and order:
            _ensure(
                len(order) == len(books) and set(order) == set(ids),
                f"{where} 的 readingOrder 必须恰好覆盖全部书籍",
            )
            by_id = {book["id"]: book for book in books}
            series["books"] = [by_id[book_id] for book_id in order]
    except BooksUnavailable:
        raise
    return series


def load_manifest() -> dict:
    """读 ``content/books/books.json`` 并校验；返回 series/book 索引结构。"""
    path = books_dir() / "books.json"
    if not path.is_file():
        raise BooksUnavailable("books.json 不存在")
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise BooksUnavailable(f"读取 books.json 失败：{exc}") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise BooksUnavailable(f"books.json 不是合法 JSON：{exc}") from exc
    _ensure(isinstance(data, dict), "books.json 顶层必须是对象")
    series_raw = data.get("series")
    _ensure(isinstance(series_raw, list), "books.json 缺少 series 数组")
    _ensure(len(series_raw) <= MAX_SERIES, "books.json 系列过多")
    series = [_series(item, f"系列 {index + 1}") for index, item in enumerate(series_raw)]
    series_ids = [item["id"] for item in series]
    _ensure(len(series_ids) == len(set(series_ids)), "books.json 含重复的系列 id")

    book_index: dict[str, dict] = {}
    for item in series:
        for book in item["books"]:
            _ensure(book["id"] not in book_index, f"书籍 id 重复：{book['id']}")
            _enrich_translations(book)
            book_index[book["id"]] = book

    return {"series": series, "_bookIndex": book_index}


def _scan_chapter_translation(book: dict, number: int) -> tuple[bool, str | None]:
    """只做“存在 + 可读标题”检查，不把整章译文读进内存。"""
    path = _chapter_path(book["id"], number)
    if not path.is_file():
        return False, None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("章节译文损坏，按未翻译处理：%s", path)
        return False, None
    if not isinstance(data, dict) or data.get("schema") != "books.chapter.zh.v1":
        return False, None
    title = data.get("title")
    return True, title.strip() if isinstance(title, str) and title.strip() else None


def _enrich_translations(book: dict) -> None:
    translated = 0
    for chapter in book["chapters"]:
        exists, title = _scan_chapter_translation(book, chapter["n"])
        chapter["translated"] = exists
        chapter["titleZh"] = title
        translated += 1 if exists else 0
    book["translatedChapters"] = translated


def series_summary(series: dict) -> dict:
    books = series["books"]
    available = [book for book in books if book["status"] == "available"]
    return {
        "id": series["id"],
        "title": series["title"],
        "author": series["author"],
        "description": series["description"],
        "totalBooks": len(books),
        "availableBooks": len(available),
        "readableChapters": sum(book["readableChapters"] for book in available),
        "translatedChapters": sum(book["translatedChapters"] for book in available),
        "excluded": series["excluded"],
    }


def book_summary(book: dict) -> dict:
    payload = {
        "id": book["id"],
        "seriesId": book["seriesId"],
        "title": book["title"],
        "titleZh": book["titleZh"],
        "author": book["author"],
        "year": book["year"],
        "level": book["level"],
        "status": book["status"],
        "source": book["source"],
        "license": book["license"],
        "publicDomainBasis": book["publicDomainBasis"],
        "sourceUrl": book["sourceUrl"],
        "totalChapters": book["totalChapters"],
        "readableChapters": book["readableChapters"],
        "translatedChapters": book["translatedChapters"],
    }
    for key in ("catalogUrl", "contentNote", "gutenbergId", "words"):
        if key in book:
            payload[key] = book[key]
    return payload


def manifest_summary(manifest: dict) -> dict:
    series_payload = []
    book_total = 0
    available_total = 0
    readable_total = 0
    translated_total = 0
    for series in manifest["series"]:
        summary = series_summary(series)
        series_payload.append(
            {
                **summary,
                "books": [book_summary(book) for book in series["books"]],
            }
        )
        book_total += summary["totalBooks"]
        available_total += summary["availableBooks"]
        readable_total += summary["readableChapters"]
        translated_total += summary["translatedChapters"]
    return {
        "series": series_payload,
        "counts": {
            "series": len(series_payload),
            "books": book_total,
            "availableBooks": available_total,
            "readableChapters": readable_total,
            "translatedChapters": translated_total,
        },
    }


def find_book(manifest: dict, book_id: str) -> dict:
    if not _valid_id(book_id):
        raise BookNotFound(book_id)
    book = manifest["_bookIndex"].get(book_id)
    if book is None:
        raise BookNotFound(book_id)
    return book


# ---------------------------------------------------------------------------
# 本地中译文
# ---------------------------------------------------------------------------


def _chapter_path(book_id: str, number: int) -> Path:
    return books_dir() / book_id / "chapters" / f"{number}.zh.json"


def load_translation(book: dict, number: int) -> dict:
    """读一章本地中译文；不存在/损坏抛 503（不把半章内容交给前端）。"""
    path = _chapter_path(book["id"], number)
    if not path.is_file():
        raise BooksUnavailable(f"章节译文不存在：{path.name}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BooksUnavailable(f"章节译文损坏：{path.name}") from exc
    _ensure(isinstance(data, dict), f"{path.name} 顶层必须是对象")
    _ensure(data.get("schema") == "books.chapter.zh.v1", f"{path.name} 的 schema 非法")
    _ensure(data.get("bookId") == book["id"], f"{path.name} 的 bookId 不一致")
    _ensure(data.get("chapter") == number, f"{path.name} 的 chapter 不一致")
    title = data.get("title")
    _ensure(isinstance(title, str) and bool(title.strip()), f"{path.name} 缺少中文标题")
    _ensure(len(title.strip()) <= MAX_TITLE_CHARS, f"{path.name} 的标题过长")
    paragraphs_raw = data.get("paragraphs")
    _ensure(isinstance(paragraphs_raw, list), f"{path.name} 缺少 paragraphs 数组")
    _ensure(len(paragraphs_raw) <= MAX_PARAGRAPHS, f"{path.name} 的段落过多")
    paragraphs: list[str | None] = []
    for index, value in enumerate(paragraphs_raw):
        if value is None:
            paragraphs.append(None)
            continue
        _ensure(isinstance(value, str), f"{path.name} 第 {index + 1} 段译文类型非法")
        if not value.strip():
            paragraphs.append(None)
            continue
        _ensure(
            len(value) <= MAX_TRANSLATION_CHARS,
            f"{path.name} 第 {index + 1} 段译文过长",
        )
        paragraphs.append(value.strip())
    meta = data.get("meta")
    return {
        "title": title.strip(),
        "paragraphs": paragraphs,
        "meta": meta if isinstance(meta, dict) else {},
    }


# ---------------------------------------------------------------------------
# 公版源抓取
# ---------------------------------------------------------------------------


def _decode_source(raw: bytes, charset: str | None) -> str:
    """按声明的 charset 解码；无声明时依次尝试 UTF-8 / cp1252。

    不使用 requests 的 ``response.encoding``：它对 ``text/plain`` 默认猜
    ISO-8859-1，会把 UTF-8 公版文本解成乱码。也不静默用 replace 掩盖问题。
    """
    candidates: list[str] = []
    if charset:
        candidates.append(charset.strip().strip('"').lower())
    candidates.extend(["utf-8-sig", "utf-8", "cp1252", "latin-1"])
    seen: set[str] = set()
    for encoding in candidates:
        if not encoding or encoding in seen:
            continue
        seen.add(encoding)
        try:
            return raw.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            continue
    raise BookSourceUnavailable("公版源文本无法解码（既不支持声明的 charset，也不是 UTF-8/cp1252）")


def _charset_from_content_type(content_type: str) -> str | None:
    match = re.search(r"charset\s*=\s*([^;\s]+)", content_type or "", re.IGNORECASE)
    return match.group(1).strip() if match else None


def _mirror_urls(url: str) -> list[str]:
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower()
    if host not in ("www.gutenberg.org", "gutenberg.org"):
        return []
    urls = []
    for mirror in _GUTENBERG_MIRROR_HOSTS:
        urls.append(f"https://{mirror}{parsed.path}" + (f"?{parsed.query}" if parsed.query else ""))
    return urls


def _origin(url: str) -> str:
    parsed = urlsplit(url)
    return f"{parsed.scheme}://{parsed.netloc}"


def _robots_allows(url: str) -> bool:
    """读 robots.txt 并检查本 UA；读不到（404/网络故障）按未声明限制处理。

    只对白名单公版站点调用。结果按 origin 缓存 1 小时，避免每章都抓 robots。
    """
    origin = _origin(url)
    now = time.monotonic()
    with _robots_lock:
        cached = _robots_cache.get(origin)
        if cached and cached[0] > now:
            return cached[1]
    allowed = True
    robots_url = origin + "/robots.txt"
    try:
        response = requests.get(
            robots_url,
            timeout=(min(5, config.BOOKS_SOURCE_TIMEOUT_SECONDS), min(10, config.BOOKS_SOURCE_TIMEOUT_SECONDS)),
            headers={"User-Agent": USER_AGENT, "Accept": "text/plain"},
            stream=True,
            allow_redirects=True,
        )
        try:
            if response.status_code == 200:
                raw = b""
                for chunk in response.iter_content(chunk_size=8192):
                    raw += chunk
                    if len(raw) > MAX_ROBOTS_BYTES:
                        break
                parser = RobotFileParser()
                parser.set_url(robots_url)
                parser.parse(raw.decode("utf-8", errors="replace").splitlines())
                allowed = parser.can_fetch(_ROBOTS_TOKEN, url)
                if not allowed:
                    logger.warning("robots.txt 禁止抓取：%s", url)
            elif response.status_code == 404:
                allowed = True
            else:
                logger.warning(
                    "robots.txt 返回 %s，按未声明限制处理：%s",
                    response.status_code,
                    robots_url,
                )
        finally:
            response.close()
    except requests.RequestException as exc:
        logger.warning("robots.txt 读取失败，按未声明限制处理：%s（%s）", robots_url, exc)
        allowed = True
    with _robots_lock:
        _robots_cache[origin] = (now + 3600.0, allowed, url)
    return allowed


def fetch_source_text(url: str, *, timeout: float | None = None) -> tuple[str, str]:
    """抓取一个公版源文本；成功返回 ``(text, final_url)``。

    重定向后的最终 URL 必须仍落在白名单内；响应体按流式读取并限制大小。
    """
    try:
        validate_source_url(url, where="抓取地址")
    except BooksUnavailable as exc:
        raise BookSourceUnavailable(str(exc)) from exc
    if not _robots_allows(url):
        raise BookSourceUnavailable("robots.txt 不允许抓取该公版源")
    read_timeout = timeout or config.BOOKS_SOURCE_TIMEOUT_SECONDS
    try:
        response = requests.get(
            url,
            timeout=(min(6, read_timeout), read_timeout),
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/plain; charset=utf-8, text/plain;q=0.9",
            },
            stream=True,
            allow_redirects=True,
        )
    except requests.Timeout as exc:
        raise BookSourceUnavailable("公版源请求超时") from exc
    except requests.RequestException as exc:
        raise BookSourceUnavailable(f"公版源请求失败：{exc}") from exc

    try:
        final_url = str(response.url or url)
        try:
            validate_source_url(final_url, where="公版源重定向地址")
        except BooksUnavailable as exc:
            raise BookSourceUnavailable(str(exc)) from exc
        if response.status_code != 200:
            raise BookSourceUnavailable(f"公版源返回 HTTP {response.status_code}")
        content_type = response.headers.get("Content-Type", "")
        if content_type and not re.match(r"^\s*text/(plain|html)", content_type, re.IGNORECASE):
            raise BookSourceUnavailable(f"公版源返回了非文本内容：{content_type[:80]}")
        limit = config.MAX_BOOK_SOURCE_BYTES
        raw = bytearray()
        for chunk in response.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            raw.extend(chunk)
            if limit > 0 and len(raw) > limit:
                raise _ResponseTooLarge(f"公版源响应超过 {limit} 字节上限")
        text = _decode_source(bytes(raw), _charset_from_content_type(content_type))
        if not text.strip():
            raise BookSourceUnavailable("公版源返回了空文本")
        return text, final_url
    except requests.Timeout as exc:
        raise BookSourceUnavailable("公版源读取超时") from exc
    except requests.RequestException as exc:
        raise BookSourceUnavailable(f"公版源读取失败：{exc}") from exc
    finally:
        response.close()


# ---------------------------------------------------------------------------
# 文本解析
# ---------------------------------------------------------------------------


def _gutenberg_body(text: str) -> str:
    # Gutenberg 官方 .txt 是 CRLF；统一成 LF 后再做行锚定正则。
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    start = _START_RE.search(text)
    end = _END_RE.search(text)
    if not start or not end or end.start() <= start.end():
        raise BookSourceUnavailable("公版源缺少 Gutenberg START/END 标记，无法安全切分")
    return text[start.end() : end.start()]


def split_paragraphs(text: str, *, drop_captions: bool = False) -> list[str]:
    """把 Gutenberg 硬换行纯文本切成自然段。

    - 空行分段，段内硬换行合并为一个空格；
    - 丢弃 ``[Illustration]`` 占位；
    - 去掉 ``_italic_`` 强调标记（保留文字本身）；
    - 丢弃 ``THE END`` / Gutenberg 尾注行，避免把版权页当正文。
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\ufeff", "")
    text = _EMPHASIS_RE.sub(r"\1", text)
    paragraphs: list[str] = []
    for block in re.split(r"\n[ \t]*\n", text):
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if not lines:
            continue
        if len(lines) == 1 and _ILLUSTRATION_RE.fullmatch(lines[0]):
            continue
        value = re.sub(r"\s+", " ", " ".join(lines)).strip()
        if not value or _ILLUSTRATION_RE.fullmatch(value):
            continue
        if drop_captions and re.match(r"^\[illustration", value, re.IGNORECASE):
            continue
        if value.upper() == "THE END" or value.startswith("End of Project Gutenberg"):
            break
        # Gutenberg 的章节分隔星号（``* * * * *``）不是正文段落，不能送去翻译。
        if re.fullmatch(r"[*∗•·\s]+", value):
            continue
        paragraphs.append(value)
    return paragraphs


def _first_nonempty_line(lines: list[str], start: int) -> tuple[str, int]:
    for index in range(start, len(lines)):
        if lines[index].strip():
            return lines[index].strip(), index + 1
    return "", start


def _parse_chaptered(text: str) -> list[ParsedChapter]:
    body = _gutenberg_body(text)
    headings = list(_CHAPTER_HEADING_RE.finditer(body))
    if not headings:
        raise BookSourceUnavailable("公版源里没有识别到章节标题")
    if len(headings) > MAX_CHAPTERS:
        raise BookSourceUnavailable("公版源章节数超过上限")
    chapters: list[ParsedChapter] = []
    for index, match in enumerate(headings):
        segment_end = headings[index + 1].start() if index + 1 < len(headings) else len(body)
        segment = body[match.end() : segment_end]
        lines = segment.splitlines()
        title, body_start = _first_nonempty_line(lines, 0)
        if not title:
            raise BookSourceUnavailable(f"第 {index + 1} 章缺少标题")
        paragraphs = split_paragraphs("\n".join(lines[body_start:]))
        if not paragraphs:
            raise BookSourceUnavailable(f"第 {index + 1} 章没有正文段落")
        chapters.append(ParsedChapter(number=index + 1, title=title, paragraphs=paragraphs))
    return chapters


def _parse_single(text: str, parser: dict, fallback_title: str) -> list[ParsedChapter]:
    body_start = parser.get("bodyStart")
    if not body_start:
        raise BookSourceUnavailable("单章公版书缺少 bodyStart 锚点")
    paragraphs = split_paragraphs(
        _gutenberg_body(text), drop_captions=bool(parser.get("dropCaptions"))
    )
    anchor = next(
        (index for index, paragraph in enumerate(paragraphs) if paragraph.startswith(body_start)),
        None,
    )
    if anchor is None:
        raise BookSourceUnavailable("公版源正文锚点未命中（源文本可能已更新）")
    paragraphs = paragraphs[anchor:]
    body_end = parser.get("bodyEnd")
    if body_end:
        end = next(
            (
                index
                for index, paragraph in enumerate(paragraphs)
                if paragraph.endswith(body_end)
            ),
            None,
        )
        if end is None:
            raise BookSourceUnavailable("公版源结尾锚点未命中（源文本可能已更新）")
        paragraphs = paragraphs[: end + 1]
    if not paragraphs:
        raise BookSourceUnavailable("公版源正文为空")
    return [ParsedChapter(number=1, title=fallback_title, paragraphs=paragraphs)]


def _anchor_line(line: str) -> str:
    return " ".join(line.replace("_", " ").split())


def _fold(value: str) -> str:
    value = value.casefold().replace("’", "'").replace("‘", "'")
    value = " ".join(re.sub(r"[^a-z0-9]+", " ", value).split())
    return " ".join(
        token for token in value.split() if token not in {"a", "an", "the"}
    )


_HEADING_TRAILER_RE = re.compile(
    r"^(?:(?:CHAPTER|Chapter)\s+(?:\d+|[IVXLCDM]+|[A-Za-z-]+)[.:]?|"
    r"[IVXLCDM]+\.?|\d+\.?)$"
)


def _parse_anchors(text: str, book: dict) -> list[ParsedChapter]:
    """按 books.json 里的 anchor/occurrence 切章。

    公版源每次实时抓取；anchor 是构建期从同一版本源文本里取出的标题/首行，
    occurrence 处理目录与正文重复。源站若更新文本导致锚点找不到，返回 503。
    """
    parser = book.get("parser") or {}
    drop_captions = bool(parser.get("dropCaptions"))
    body = _gutenberg_body(text)
    lines = body.splitlines()
    positions: list[int] = []
    for chapter in book["chapters"]:
        target = _anchor_line(chapter.get("anchor", ""))
        matches = [
            index
            for index, line in enumerate(lines)
            if _anchor_line(line) == target
        ]
        occurrence = chapter.get("occurrence", 1)
        if len(matches) < occurrence:
            if matches:
                logger.warning(
                    "章节锚点只出现 %s 次（期望第 %s 次），退回最后一次：%s 第 %s 章",
                    len(matches),
                    occurrence,
                    book["id"],
                    chapter["n"],
                )
                positions.append(matches[-1])
                continue
            raise BookSourceUnavailable(
                f"公版源里找不到第 {chapter['n']} 章的锚点（源文本可能已更新）"
            )
        positions.append(matches[occurrence - 1])
    if positions != sorted(positions) or len(set(positions)) != len(positions):
        raise BookSourceUnavailable("公版源章节锚点顺序异常（源文本可能已更新）")

    chapters: list[ParsedChapter] = []
    for index, chapter in enumerate(book["chapters"]):
        start = positions[index] + 1
        end = positions[index + 1] if index + 1 < len(positions) else len(lines)
        paragraphs = split_paragraphs(
            "\n".join(lines[start:end]), drop_captions=drop_captions
        )
        title = chapter["title"]
        if paragraphs and (
            chapter.get("skipTitle") or _fold(paragraphs[0]) == _fold(title)
        ):
            paragraphs = paragraphs[1:]
        while paragraphs and (
            _HEADING_TRAILER_RE.match(" ".join(paragraphs[-1].split()))
            or _fold(paragraphs[-1]) == _fold(title)
        ):
            paragraphs = paragraphs[:-1]
        if not paragraphs:
            raise BookSourceUnavailable(f"公版源第 {chapter['n']} 章正文为空")
        chapters.append(
            ParsedChapter(number=chapter["n"], title=title, paragraphs=paragraphs)
        )
    return chapters


def parse_book(text: str, book: dict) -> list[ParsedChapter]:
    parser = book.get("parser") or {"mode": "chapters"}
    mode = parser.get("mode", "chapters")
    if mode == "anchors":
        return _parse_anchors(text, book)
    if mode == "single":
        return _parse_single(text, parser, book["title"])
    return _parse_chaptered(text)


# ---------------------------------------------------------------------------
# 抓取 + 缓存 + 对齐
# ---------------------------------------------------------------------------


def _fetch_book_source(book: dict) -> SourceResult:
    urls = [book["sourceUrl"], *_mirror_urls(book["sourceUrl"])]
    errors: list[str] = []
    for url in urls:
        try:
            text, final_url = fetch_source_text(url)
            chapters = parse_book(text, book)
            return SourceResult(
                chapters=chapters,
                final_url=final_url,
                fetched_at=time.time(),
                degraded=False,
            )
        except (BookSourceUnavailable, BooksUnavailable) as exc:
            errors.append(f"{url}: {exc}")
            logger.warning("公版源抓取失败（%s）：%s", book["id"], exc)
    raise BookSourceUnavailable("；".join(errors) or "公版源抓取失败")


def get_chapter_source(book: dict, number: int) -> SourceResult:
    """取某章英文原文：**每次请求都抓取**，内存缓存只用于源站故障降级。

    成功抓取后把解析结果放进进程内缓存（不落盘）；正常请求不会直接命中缓存，
    保证“原文每次按需从公版源抓取”。若抓取失败且缓存仍在 TTL 内，返回缓存
    并标 ``degraded=True``；超过 TTL 一律 503。
    """
    key = (book["id"], number)
    try:
        result = _fetch_book_source(book)
    except BookSourceUnavailable:
        now = time.time()
        with _cache_lock:
            cached = _cache.get(key)
        if cached is not None and now - cached.fetched_at <= config.BOOKS_SOURCE_CACHE_SECONDS:
            logger.warning("公版源不可用，使用内存缓存降级：%s 第 %s 章", book["id"], number)
            chapter = next((item for item in cached.chapters if item.number == number), None)
            if chapter is not None:
                return SourceResult(
                    chapters=cached.chapters,
                    final_url=cached.final_url,
                    fetched_at=cached.fetched_at,
                    degraded=True,
                )
        raise
    with _cache_lock:
        _cache[key] = result
        while len(_cache) > 64:
            _cache.popitem(last=False)
    chapter = next((item for item in result.chapters if item.number == number), None)
    if chapter is None:
        raise BookSourceUnavailable(f"公版源没有第 {number} 章")
    return result

def translation_status(values: Sequence[str | None]) -> str:
    """按段落译文的完整度返回 ``cached`` / ``partial`` / ``missing``。

    - ``cached``：每个英文段落都有非空译文（本地书稿或全局缓存）；
    - ``partial``：只有一部分段落有译文（其余 ``zh: null``，可重试补齐）；
    - ``missing``：整章都还没有译文。

    这三个值直接出现在章节 payload 的 ``translationStatus`` 字段里，前端据此
    决定是否调用 ``POST .../translate``；缺省（历史行为）等价于 ``missing``。
    """
    total = len(values)
    if total == 0:
        return "missing"
    present = sum(
        1 for value in values if isinstance(value, str) and bool(value.strip())
    )
    if present == total:
        return "cached"
    if present == 0:
        return "missing"
    return "partial"


def merge_cached_translations(
    payload: dict,
    cached_paragraphs: Sequence[str | None] | None,
    *,
    model: str | None = None,
    updated_at: int | None = None,
) -> dict:
    """把全局译文缓存（按段落下标对齐）合并进章节 payload。

    - payload 里**已有**的译文（本地书稿 ``content/books/.../*.zh.json``）优先，
      缓存只补 ``zh: null`` 的段落；
    - 合并后重算 ``missingTranslations`` / ``translationStatus`` / ``translated``；
    - 带 ``model`` / ``updated_at`` 时写入 ``translationModel`` /
      ``translationUpdatedAt``（UTC ISO8601），用于前端/运维追溯；
    - 本函数不做 IO，缓存内容由 ``book_translation.py`` 读出后传入。
    """
    if cached_paragraphs is None:
        return payload
    paragraphs = payload.get("paragraphs")
    if not isinstance(paragraphs, list):
        return payload

    used_cache = 0
    for index, item in enumerate(paragraphs):
        if not isinstance(item, dict):
            continue
        existing = item.get("zh")
        if isinstance(existing, str) and existing.strip():
            continue
        value = (
            cached_paragraphs[index] if index < len(cached_paragraphs) else None
        )
        if isinstance(value, str) and value.strip():
            item["zh"] = value.strip()
            used_cache += 1

    values = [
        item.get("zh") if isinstance(item, dict) else None for item in paragraphs
    ]
    status = translation_status(values)
    payload["missingTranslations"] = sum(
        1
        for value in values
        if not (isinstance(value, str) and value.strip())
    )
    payload["translationStatus"] = status
    # 兼容旧字段：只要本章已经有完整译文，就允许客户端按「已翻译」渲染。
    if status == "cached":
        payload["translated"] = True
    if used_cache:
        payload["translationSource"] = (
            "mixed" if payload.get("translationSource") == "bundled" else "cache"
        )
    if model is not None:
        payload["translationModel"] = model
    if updated_at is not None:
        payload["translationUpdatedAt"] = time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime(updated_at / 1000)
        )
    return payload


def build_chapter_payload(
    manifest: dict,
    book_id: str,
    number: int,
    *,
    target_lang: str = languages.DEFAULT_TARGET_LANG,
) -> dict:
    """抓取一章原文并与本地译文对齐；``target_lang`` 决定使用哪份本地译文。

    本地书稿目前只有中文（``*.zh.json``），因此只有 ``target_lang=zh-CN`` 时
    才会读取它；其他目标语言由调用方合并全局缓存（见
    :func:`merge_cached_translations`）。字段 ``translationStatus`` 为
    ``cached`` / ``partial`` / ``missing``，无译文时保持历史兼容的 ``zh: null``。
    """
    lang = languages.resolve_target_lang(target_lang)
    book = find_book(manifest, book_id)
    if book["status"] != "available":
        raise BookNotFound(book_id)
    if number < 1 or number > book["totalChapters"]:
        raise BookNotFound(f"{book_id}/{number}")
    chapter_meta = next((item for item in book["chapters"] if item["n"] == number), None)
    if chapter_meta is None:
        raise BookNotFound(f"{book_id}/{number}")

    translation_path = _chapter_path(book["id"], number)
    translation = (
        load_translation(book, number)
        if lang == languages.DEFAULT_TARGET_LANG and translation_path.is_file()
        else None
    )
    source = get_chapter_source(book, number)
    parsed = next((item for item in source.chapters if item.number == number), None)
    if parsed is None:
        raise BookSourceUnavailable(f"公版源没有第 {number} 章")

    zh_list = translation["paragraphs"] if translation else []
    if len(zh_list) > len(parsed.paragraphs):
        logger.warning(
            "章节译文比英文原文多（源文本可能已更新）：%s 第 %s 章 zh=%s en=%s",
            book_id,
            number,
            len(zh_list),
            len(parsed.paragraphs),
        )
    paragraphs = []
    missing = 0
    for index, en in enumerate(parsed.paragraphs):
        zh = zh_list[index] if index < len(zh_list) else None
        if not isinstance(zh, str) or not zh.strip():
            zh = None
            missing += 1
        paragraphs.append({"index": index, "en": en, "zh": zh})

    status = translation_status([item["zh"] for item in paragraphs])
    series = next(item for item in manifest["series"] if item["id"] == book["seriesId"])
    return {
        "bookId": book["id"],
        "bookTitle": book["title"],
        "bookTitleZh": book["titleZh"],
        "author": book["author"],
        "level": book["level"],
        "license": book["license"],
        "chapter": number,
        "chapterTitle": translation["title"] if translation else chapter_meta["title"],
        "sourceTitle": chapter_meta["title"],
        "translated": translation is not None,
        "translatedChapters": book["translatedChapters"],
        "totalChapters": book["totalChapters"],
        "importedChapters": book["readableChapters"],
        "seriesId": book["seriesId"],
        "seriesTitle": series["title"],
        "contentNote": book.get("contentNote"),
        "translationMeta": translation["meta"] if translation else {},
        "targetLang": lang,
        "translationStatus": status,
        "translationSource": "bundled" if translation else "none",
        "translationModel": None,
        "translationUpdatedAt": None,
        "source": {
            "provider": book["source"],
            "url": book.get("catalogUrl") or book["sourceUrl"],
            "fetchedAt": time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime(source.fetched_at)
            ),
            "degraded": source.degraded,
        },
        "paragraphs": paragraphs,
        "missingTranslations": missing,
    }
