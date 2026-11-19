"""本地 EPUB 上传：解析、安全校验与账号私有存储（specs/031 M1）。

产品边界：

- 只接受**英文**、**无 DRM/加密**的 EPUB（EPUB2 / EPUB3）；不做 DRM 绕过，
  也不做 PDF/MOBI/AZW3/TXT；
- 只抽纯文本段落（``p`` / ``h1``–``h3`` / ``li``），绝不保留或渲染 EPUB 里的
  HTML/脚本/样式/外链；插图只取封面，其余丢弃；
- 章节文件落在 ``USER_DATA_DIR/<user_id>/imported-books/<book_id>/``，
  所有路径由服务端生成，客户端不能传路径；
- preview 阶段把原始文件暂存到账号目录下的 ``.upload-staging/<token>/``
  （5 分钟 TTL，不写数据库），确认导入时重新解析再原子写入正式目录。

安全边界：

- ZIP：拒绝加密条目、``..``/绝对路径/盘符、条目数与解压总量超限；
  每个实际读取的条目都按上限截断（不信任 central directory 声明的大小）；
- XML：只用 ``xml.etree.ElementTree``，它不加载外部 DTD/实体，也不解析远程
  资源；XHTML 正文用标准库 ``html.parser`` 抽文本；
- 大小：单文件 30MB、解压总量 200MB、单章正文 1MB、章节数 300、
  封面 2MB（超限封面直接放弃，不影响正文导入）；
- 语言：``dc:language`` 缺失按 ``en`` 处理，非英文直接 422。

本模块只做解析与文件系统，不碰数据库；数据库读写与路由分别在
``book_import.py`` / ``routes_book_upload.py``。
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import os
import posixpath
import re
import secrets
import shutil
import time
import uuid
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import unquote

import config
import storage

logger = logging.getLogger("linguatrek.local_epub")

# ---------------------------------------------------------------------------
# 边界常量（默认值可由 config 覆盖；测试可 monkeypatch config / 本模块）
# ---------------------------------------------------------------------------

DEFAULT_MAX_EPUB_BYTES = 30 * 1024 * 1024
DEFAULT_MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
DEFAULT_MAX_ENTRIES = 2000
DEFAULT_MAX_CHAPTERS = 300
DEFAULT_MAX_CHAPTER_CHARS = 1_000_000
DEFAULT_MAX_COVER_BYTES = 2 * 1024 * 1024
DEFAULT_MAX_BOOKS_PER_USER = 20
DEFAULT_MAX_TEXT_BYTES = 100 * 1024 * 1024

MAX_METADATA_BYTES = 8 * 1024 * 1024  # container/OPF/nav/NCX 单文件上限
MAX_XHTML_BYTES = 8 * 1024 * 1024  # 单章 XHTML 原始字节上限（正文文本另限 1MB）
MAX_TITLE_CHARS = 300
MAX_AUTHOR_CHARS = 200
MAX_FILENAME_CHARS = 200
MAX_PARAGRAPH_CHARS = 4000
STAGING_TTL_SECONDS = 300
COVER_EXTENSIONS = ("jpg", "jpeg", "png", "gif", "webp")

_BLOCK_TAGS = frozenset({"p", "h1", "h2", "h3", "li"})
_SKIP_TAGS = frozenset({"script", "style", "head", "title", "noscript", "template"})
_XHTML_MEDIA_TYPES = frozenset({"application/xhtml+xml", "text/html", "application/xml"})
_IMAGE_MIME = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
}
_BOOK_ID_RE = re.compile(r"^epub-[a-f0-9]{32}$")
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_XML_ENCODING_RE = re.compile(rb"""encoding\s*=\s*["']([A-Za-z0-9_.:-]+)["']""")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_WHITESPACE_RE = re.compile(r"\s+")


class LocalEpubError(RuntimeError):
    """本地 EPUB 领域错误；路由按 ``status_code`` 映射。"""

    status_code = 400

    def __init__(self, detail: str, *, status_code: int | None = None) -> None:
        super().__init__(detail)
        self.detail = detail
        if status_code is not None:
            self.status_code = status_code


class InvalidEpub(LocalEpubError):
    """不是 EPUB / ZIP 损坏 / 结构不合法 / 缺文件。"""

    status_code = 400


class EpubTooLarge(LocalEpubError):
    """单文件、解压总量、章节数或单章正文超过上限。"""

    status_code = 413


class EpubUnsupported(LocalEpubError):
    """DRM/加密、非英文、没有可读正文（产品边界外）。"""

    status_code = 422


class LocalBookNotFound(LocalEpubError):
    """书/章节不在当前账号目录下。"""

    status_code = 404


class LocalEpubUnavailable(LocalEpubError):
    """本地书库读写失败（磁盘/权限），可重试或需要人工处理。"""

    status_code = 503


@dataclass(frozen=True)
class EpubChapter:
    n: int
    title: str
    paragraphs: tuple[str, ...]


@dataclass(frozen=True)
class EpubCover:
    data: bytes
    mime: str
    extension: str


@dataclass(frozen=True)
class ParsedEpub:
    title: str
    author: str | None
    language: str
    chapters: tuple[EpubChapter, ...]
    cover: EpubCover | None
    sha256: str
    size_bytes: int
    original_filename: str

    @property
    def text_bytes(self) -> int:
        """正文的 UTF-8 字节数（配额按文本口径估算，不含封面/元数据）。"""
        return sum(
            len(paragraph.encode("utf-8"))
            for chapter in self.chapters
            for paragraph in chapter.paragraphs
        )


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def _int_attr(name: str, default: int) -> int:
    try:
        value = getattr(config, name, default)
        return default if value is None else max(0, int(value))
    except (TypeError, ValueError):
        return default


def max_upload_bytes() -> int:
    return _int_attr("MAX_LOCAL_EPUB_BYTES", DEFAULT_MAX_EPUB_BYTES)


def max_uncompressed_bytes() -> int:
    return _int_attr("MAX_LOCAL_EPUB_UNCOMPRESSED_BYTES", DEFAULT_MAX_UNCOMPRESSED_BYTES)


def max_entries() -> int:
    return _int_attr("MAX_LOCAL_EPUB_ENTRIES", DEFAULT_MAX_ENTRIES)


def max_chapters() -> int:
    return _int_attr("MAX_LOCAL_EPUB_CHAPTERS", DEFAULT_MAX_CHAPTERS)


def max_chapter_chars() -> int:
    return _int_attr("MAX_LOCAL_EPUB_CHAPTER_CHARS", DEFAULT_MAX_CHAPTER_CHARS)


def max_cover_bytes() -> int:
    return _int_attr("MAX_LOCAL_EPUB_COVER_BYTES", DEFAULT_MAX_COVER_BYTES)


def max_books_per_user() -> int:
    return _int_attr("MAX_LOCAL_BOOKS_PER_USER", DEFAULT_MAX_BOOKS_PER_USER)


def max_text_bytes_per_user() -> int:
    return _int_attr("MAX_LOCAL_BOOK_TEXT_BYTES", DEFAULT_MAX_TEXT_BYTES)


def _local_name(tag: object) -> str:
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1].lower()


def _clean_text(value: object) -> str:
    if not isinstance(value, str):
        return ""
    value = value.replace("\ufeff", "").replace("\u00a0", " ")
    value = _CONTROL_RE.sub("", value)
    return _WHITESPACE_RE.sub(" ", value).strip()


def _truncate(value: str, limit: int) -> str:
    value = _clean_text(value)
    if limit > 0 and len(value) > limit:
        return value[:limit].rstrip()
    return value


def _detect_image(data: bytes) -> tuple[str, str] | None:
    """只按魔数识别常见位图；SVG 等可执行/可注入格式一律不接受。"""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", "jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", "png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif", "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", "webp"
    return None


def _decode_bytes(raw: bytes) -> str:
    """按 BOM/XML 声明/UTF-8/CP1252 顺序解码；坏字节最后用替换字符兜底。"""
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig", "replace")
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16", "replace")
    candidates: list[str] = []
    match = _XML_ENCODING_RE.search(raw[:2048])
    if match:
        try:
            candidates.append(match.group(1).decode("ascii"))
        except UnicodeDecodeError:
            pass
    candidates.extend(("utf-8", "cp1252", "latin-1"))
    for codec in candidates:
        try:
            return raw.decode(codec)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", "replace")


def _split_long_paragraphs(
    paragraphs: list[str], limit: int = MAX_PARAGRAPH_CHARS
) -> list[str]:
    """把超长段落按句子/空格边界切开（与公版书导入同一思路，便于翻译/点词）。"""
    if limit <= 0:
        return [paragraph for paragraph in paragraphs if paragraph]
    output: list[str] = []
    for paragraph in paragraphs:
        text = paragraph.strip()
        if not text:
            continue
        if len(text) <= limit:
            output.append(text)
            continue
        remaining = text
        while len(remaining) > limit:
            window = remaining[:limit]
            position = max(
                window.rfind(". "),
                window.rfind("! "),
                window.rfind("? "),
            )
            if position < limit // 3:
                position = window.rfind(" ")
            if position < limit // 3:
                position = limit - 1
            chunk = remaining[: position + 1].strip()
            if chunk:
                output.append(chunk)
            remaining = remaining[position + 1 :].lstrip()
        if remaining.strip():
            output.append(remaining.strip())
    return output


# ---------------------------------------------------------------------------
# ZIP / XML 安全读取
# ---------------------------------------------------------------------------

def _validate_entry_name(name: str) -> None:
    """拒绝路径穿越、绝对路径、Windows 盘符和 NUL。"""
    if not name or "\x00" in name:
        raise InvalidEpub("EPUB 内部包含非法文件路径。")
    normalized = name.replace("\\", "/")
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        raise InvalidEpub("EPUB 内部包含绝对路径，已拒绝。")
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise InvalidEpub("EPUB 内部包含路径穿越（..），已拒绝。")


def _open_zip(data: bytes) -> zipfile.ZipFile:
    if not data:
        raise InvalidEpub("文件为空，不是有效的 EPUB。")
    if len(data) > max_upload_bytes():
        raise EpubTooLarge(
            f"文件超过 {max_upload_bytes() // (1024 * 1024)}MB 上限。"
        )
    if not data.startswith(b"PK\x03\x04"):
        raise InvalidEpub("不是有效的 EPUB 文件（缺少 ZIP 头）。")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, OSError, ValueError) as exc:
        raise InvalidEpub("不是有效的 EPUB 文件（ZIP 解析失败）。") from exc
    try:
        infos = zf.infolist()
        if not infos:
            raise InvalidEpub("EPUB 是空压缩包。")
        if len(infos) > max_entries():
            raise EpubTooLarge(
                f"EPUB 内部文件过多（{len(infos)} 个，上限 {max_entries()} 个）。"
            )
        # Adobe/Apple 等 DRM 的加密清单：直接拒绝，不做任何绕过。
        if any(info.filename.lower() == "meta-inf/encryption.xml" for info in infos):
            raise EpubUnsupported("这本书是加密/DRM EPUB，无法上传。")
        total = 0
        for info in infos:
            if info.flag_bits & 0x1:
                raise EpubUnsupported("这本书是加密/DRM EPUB，无法上传。")
            _validate_entry_name(info.filename)
            total += max(0, int(info.file_size or 0))
            if total > max_uncompressed_bytes():
                raise EpubTooLarge(
                    "EPUB 解压后体积超过上限，已拒绝（可能是压缩炸弹）。"
                )
    except Exception:
        zf.close()
        raise
    return zf


def _find_entry(zf: zipfile.ZipFile, name: str) -> zipfile.ZipInfo | None:
    try:
        return zf.getinfo(name)
    except KeyError:
        pass
    lowered = name.lower()
    for info in zf.infolist():
        if info.filename.lower() == lowered:
            return info
    return None


def _read_entry(
    zf: zipfile.ZipFile, name: str, *, limit: int, what: str
) -> bytes:
    info = _find_entry(zf, name)
    if info is None:
        raise InvalidEpub(f"EPUB 缺少{what}（{name}）。")
    if info.flag_bits & 0x1:
        raise EpubUnsupported("这本书是加密/DRM EPUB，无法上传。")
    if int(info.file_size or 0) > limit:
        raise EpubTooLarge(f"{what}超过单个文件上限。")
    try:
        with zf.open(info) as handle:
            data = handle.read(limit + 1)
    except (zipfile.BadZipFile, RuntimeError, OSError, ValueError) as exc:
        raise InvalidEpub(f"读取{what}失败（EPUB 可能已损坏）。") from exc
    if len(data) > limit:
        raise EpubTooLarge(f"{what}超过单个文件上限。")
    return data


def _parse_xml(data: bytes, what: str) -> ET.Element:
    # ElementTree 不加载外部 DTD/实体；这里再拒绝内部实体声明，避免
    # 「billion laughs」式的实体膨胀（EPUB2 的 DOCTYPE 外链本身不会被读取）。
    if b"<!ENTITY" in data:
        raise InvalidEpub(f"EPUB 结构损坏（{what}含不允许的实体声明）。")
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise InvalidEpub(f"EPUB 结构损坏（{what}解析失败）。") from exc


def _normalize_epub_path(base_dir: str, href: object) -> str | None:
    """把 manifest/nav 里的相对 href 规范成 ZIP 内路径；越界返回 None。"""
    if not isinstance(href, str):
        return None
    raw = unquote(href.split("#", 1)[0].split("?", 1)[0]).strip()
    if not raw:
        return None
    normalized_raw = raw.replace("\\", "/")
    if normalized_raw.startswith("/"):
        joined = normalized_raw.lstrip("/")
    else:
        joined = posixpath.join(base_dir, normalized_raw) if base_dir else normalized_raw
    normalized = posixpath.normpath(joined)
    if normalized in ("", ".", "..") or normalized.startswith("../"):
        return None
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        return None
    return normalized


# ---------------------------------------------------------------------------
# 正文抽取
# ---------------------------------------------------------------------------

class _ContentParser(HTMLParser):
    """抽 ``p``/``h1``–``h3``/``li`` 文本；丢弃脚本、样式、head。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.paragraphs: list[str] = []
        self.heading: str | None = None
        self.fallback: list[str] = []
        self._current: list[str] | None = None
        self._heading_ref: list[str] | None = None
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
            return
        if tag == "br":
            if self._current is not None:
                self._current.append(" ")
            return
        if tag in _BLOCK_TAGS:
            # 嵌套块（如 li > p）先落外层，避免文本重复/丢失。
            if self._current is not None:
                self._flush_paragraph()
            self._current = []
            if tag in ("h1", "h2", "h3") and self._heading_ref is None:
                self._heading_ref = self._current

    def handle_startendtag(self, tag: str, attrs) -> None:
        self.handle_starttag(tag, attrs)
        if tag.lower() in _BLOCK_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if tag in _BLOCK_TAGS:
            self._flush_paragraph()

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        if self._current is not None:
            self._current.append(data)
        elif data.strip():
            self.fallback.append(data)

    def close(self) -> None:
        super().close()
        self._flush_paragraph()

    def _flush_paragraph(self) -> None:
        if self._current is None:
            return
        buffer = self._current
        self._current = None
        text = _clean_text("".join(buffer))
        if not text:
            return
        self.paragraphs.append(text)
        if self._heading_ref is buffer and self.heading is None:
            self.heading = _truncate(text, MAX_TITLE_CHARS)


class _NavParser(HTMLParser):
    """收集 ``<nav>`` 里的链接，用于 EPUB3 导航目录。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.navs: list[dict] = []
        self._stack: list[dict] = []
        self._link: dict | None = None
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        attrs_map = {str(key).lower(): (value or "") for key, value in attrs}
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
            return
        if tag == "nav":
            markers = " ".join(
                attrs_map.get(key, "") for key in ("epub:type", "type", "role")
            ).lower()
            nav = {
                "toc": "toc" in markers,
                "hint": (attrs_map.get("id", "") + " " + attrs_map.get("class", "")).lower(),
                "links": [],
            }
            self._stack.append(nav)
            self.navs.append(nav)
        elif tag == "a" and self._stack:
            self._link = {"href": attrs_map.get("href", ""), "text": []}

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if tag == "a" and self._link is not None:
            href = self._link.get("href") or ""
            text = _clean_text("".join(self._link.get("text") or []))
            if self._stack and href and text:
                self._stack[-1]["links"].append((href, text))
            self._link = None
        elif tag == "nav" and self._stack:
            self._stack.pop()

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        if self._link is not None:
            self._link["text"].append(data)

    def toc_links(self) -> list[tuple[str, str]]:
        if not self.navs:
            return []
        for nav in self.navs:
            if nav["toc"]:
                return nav["links"]
        for nav in self.navs:
            hint = nav["hint"]
            if "toc" in hint or "contents" in hint:
                return nav["links"]
        return self.navs[0]["links"]


def _extract_content(html_text: str) -> tuple[list[str], str | None]:
    parser = _ContentParser()
    try:
        parser.feed(html_text)
        parser.close()
    except Exception:  # noqa: BLE001 - HTMLParser 对畸形输入尽量容错
        logger.warning("EPUB 章节 HTML 解析异常，按已抽取内容处理", exc_info=True)
    paragraphs = list(parser.paragraphs)
    if not paragraphs:
        fallback = _clean_text("".join(parser.fallback))
        if fallback:
            paragraphs = [fallback]
    paragraphs = _split_long_paragraphs(paragraphs)
    return paragraphs, parser.heading


# ---------------------------------------------------------------------------
# OPF / 目录 / 封面
# ---------------------------------------------------------------------------

def _opf_path(container_bytes: bytes) -> str:
    root = _parse_xml(container_bytes, "container.xml")
    for elem in root.iter():
        if _local_name(elem.tag) != "rootfile":
            continue
        full_path = elem.get("full-path") or elem.get("fullpath")
        path = _normalize_epub_path("", full_path)
        if path and path.lower().endswith(".opf"):
            return path
    raise InvalidEpub("EPUB 缺少 OPF 包信息（container.xml 无 rootfile）。")


def _manifest_and_spine(package: ET.Element, package_dir: str):
    manifest: dict[str, dict] = {}
    for elem in package.iter():
        if _local_name(elem.tag) != "item":
            continue
        item_id = (elem.get("id") or "").strip()
        path = _normalize_epub_path(package_dir, elem.get("href"))
        if not item_id or not path:
            continue
        manifest[item_id] = {
            "path": path,
            "media_type": (elem.get("media-type") or "").strip().lower(),
            "properties": (elem.get("properties") or "").split(),
        }
    spine: list[str] = []
    toc_id: str | None = None
    for elem in package.iter():
        if _local_name(elem.tag) != "spine":
            continue
        toc_id = (elem.get("toc") or "").strip() or None
        for child in elem:
            if _local_name(child.tag) != "itemref":
                continue
            idref = (child.get("idref") or "").strip()
            if idref:
                spine.append(idref)
        break
    return manifest, spine, toc_id


def _metadata(package: ET.Element) -> dict[str, list[str]]:
    values: dict[str, list[str]] = {"title": [], "creator": [], "language": []}
    for elem in package.iter():
        name = _local_name(elem.tag)
        if name not in values:
            continue
        text = _clean_text(elem.text)
        if text:
            values[name].append(text)
    return values


def _check_language(languages: list[str]) -> str:
    for raw in languages:
        value = _clean_text(raw).lower().replace("_", "-")
        if not value:
            continue
        primary = re.split(r"[-;,/\s]+", value)[0]
        if primary in {"en", "eng"}:
            return "en"
        raise EpubUnsupported(
            f"目前只支持英文 EPUB（检测到语言：{_truncate(value, 16)}）。"
        )
    return "en"


def _nav_toc(nav_bytes: bytes, nav_path: str) -> dict[str, str]:
    parser = _NavParser()
    try:
        parser.feed(_decode_bytes(nav_bytes))
        parser.close()
    except Exception:  # noqa: BLE001
        logger.warning("EPUB3 nav 解析失败，回退到标题/spine", exc_info=True)
        return {}
    base_dir = posixpath.dirname(nav_path)
    toc: dict[str, str] = {}
    for href, text in parser.toc_links():
        path = _normalize_epub_path(base_dir, href)
        if path and path not in toc:
            toc[path] = _truncate(text, MAX_TITLE_CHARS)
    return toc


def _ncx_toc(ncx_bytes: bytes, ncx_path: str) -> dict[str, str]:
    root = _parse_xml(ncx_bytes, "NCX 目录")
    base_dir = posixpath.dirname(ncx_path)
    toc: dict[str, str] = {}
    for elem in root.iter():
        if _local_name(elem.tag) != "navpoint":
            continue
        label = ""
        src = ""
        for child in elem.iter():
            name = _local_name(child.tag)
            if name == "text" and not label:
                label = _clean_text(child.text)
            elif name == "content" and not src:
                src = child.get("src") or ""
        path = _normalize_epub_path(base_dir, src)
        if path and label and path not in toc:
            toc[path] = _truncate(label, MAX_TITLE_CHARS)
    return toc


def _load_toc(
    zf: zipfile.ZipFile,
    manifest: dict[str, dict],
    toc_id: str | None,
) -> dict[str, str]:
    nav_item = next(
        (item for item in manifest.values() if "nav" in item["properties"]), None
    )
    if nav_item is not None:
        try:
            data = _read_entry(
                zf, nav_item["path"], limit=MAX_METADATA_BYTES, what="EPUB 导航"
            )
            toc = _nav_toc(data, nav_item["path"])
            if toc:
                return toc
        except LocalEpubError as exc:
            logger.warning("读取 EPUB3 导航失败：%s", exc.detail)
    ncx_item = manifest.get(toc_id) if toc_id else None
    if ncx_item is None:
        ncx_item = next(
            (
                item
                for item in manifest.values()
                if item["media_type"] == "application/x-dtbncx+xml"
            ),
            None,
        )
    if ncx_item is not None:
        try:
            data = _read_entry(
                zf, ncx_item["path"], limit=MAX_METADATA_BYTES, what="EPUB2 NCX 目录"
            )
            return _ncx_toc(data, ncx_item["path"])
        except LocalEpubError as exc:
            logger.warning("读取 EPUB2 NCX 失败：%s", exc.detail)
    return {}


def _cover(
    zf: zipfile.ZipFile,
    package: ET.Element,
    manifest: dict[str, dict],
) -> EpubCover | None:
    candidates: list[dict] = []
    for item in manifest.values():
        if "cover-image" in item["properties"]:
            candidates.append(item)
    cover_id = None
    for elem in package.iter():
        if _local_name(elem.tag) == "meta" and (elem.get("name") or "").lower() == "cover":
            cover_id = (elem.get("content") or "").strip()
            break
    if cover_id and cover_id in manifest:
        candidates.append(manifest[cover_id])
    for item_id, item in manifest.items():
        if item_id.lower() in {"cover", "cover-image", "coverimg"}:
            candidates.append(item)
    if not candidates:
        candidates = [
            item
            for item in manifest.values()
            if item["media_type"].startswith("image/") and "cover" in item["path"].lower()
        ]
    seen: set[str] = set()
    for item in candidates:
        path = item["path"]
        if path in seen:
            continue
        seen.add(path)
        if not item["media_type"].startswith("image/") and not path.lower().endswith(
            tuple(f".{ext}" for ext in COVER_EXTENSIONS)
        ):
            continue
        try:
            data = _read_entry(zf, path, limit=max_cover_bytes(), what="封面")
        except LocalEpubError as exc:
            logger.info("跳过 EPUB 封面（%s）：%s", path, exc.detail)
            continue
        detected = _detect_image(data)
        if detected is None:
            logger.info("跳过不支持的 EPUB 封面格式：%s", path)
            continue
        mime, extension = detected
        return EpubCover(data=data, mime=mime, extension=extension)
    return None


def _chapters(
    zf: zipfile.ZipFile,
    manifest: dict[str, dict],
    spine: list[str],
    toc: dict[str, str],
) -> tuple[EpubChapter, ...]:
    if spine:
        refs = list(spine)
    else:
        refs = [
            item_id
            for item_id, item in manifest.items()
            if item["media_type"] in _XHTML_MEDIA_TYPES
        ]
    seen: set[str] = set()
    chapters: list[EpubChapter] = []
    for idref in refs:
        item = manifest.get(idref)
        if item is None:
            continue
        media_type = item["media_type"]
        if media_type and media_type not in _XHTML_MEDIA_TYPES:
            continue
        if "nav" in item["properties"]:
            continue
        path = item["path"]
        if path in seen:
            continue
        seen.add(path)
        try:
            raw = _read_entry(
                zf, path, limit=MAX_XHTML_BYTES, what="章节正文"
            )
        except InvalidEpub as exc:
            logger.warning("跳过缺失的章节文件 %s：%s", path, exc.detail)
            continue
        paragraphs, heading = _extract_content(_decode_bytes(raw))
        if not paragraphs:
            continue
        if sum(len(paragraph) for paragraph in paragraphs) > max_chapter_chars():
            raise EpubTooLarge(
                f"第 {len(chapters) + 1} 章正文超过单章 "
                f"{max_chapter_chars() // 1024}KB 上限。"
            )
        number = len(chapters) + 1
        title = toc.get(path) or heading or f"Chapter {number}"
        chapters.append(
            EpubChapter(
                n=number,
                title=_truncate(title, MAX_TITLE_CHARS),
                paragraphs=tuple(paragraphs),
            )
        )
        if len(chapters) > max_chapters():
            raise EpubTooLarge(
                f"章节数超过 {max_chapters()} 章上限，暂不支持导入。"
            )
    if not chapters:
        raise EpubUnsupported(
            "这本书没有可读正文（可能是纯图片/扫描版，或 EPUB 结构不完整）。"
        )
    return tuple(chapters)


# ---------------------------------------------------------------------------
# 入口：解析
# ---------------------------------------------------------------------------

def parse_epub(data: bytes, *, filename: str | None = None) -> ParsedEpub:
    """解析 EPUB 字节；失败抛 ``InvalidEpub`` / ``EpubTooLarge`` / ``EpubUnsupported``。"""
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise InvalidEpub("上传内容不是文件数据。")
    payload = bytes(data)
    if len(payload) > max_upload_bytes():
        raise EpubTooLarge(
            f"文件超过 {max_upload_bytes() // (1024 * 1024)}MB 上限。"
        )
    safe_name = safe_filename(filename) if filename else "book.epub"
    with _open_zip(payload) as zf:
        container = _read_entry(
            zf,
            "META-INF/container.xml",
            limit=MAX_METADATA_BYTES,
            what="EPUB 容器信息",
        )
        opf_path = _opf_path(container)
        opf_bytes = _read_entry(
            zf, opf_path, limit=MAX_METADATA_BYTES, what="EPUB 包信息"
        )
        package = _parse_xml(opf_bytes, "OPF")
        package_dir = posixpath.dirname(opf_path)
        manifest, spine, toc_id = _manifest_and_spine(package, package_dir)
        if not manifest:
            raise InvalidEpub("EPUB 清单为空，无法识别章节。")
        metadata = _metadata(package)
        language = _check_language(metadata["language"])
        fallback_title = os.path.splitext(safe_name)[0]
        title = (
            _truncate(metadata["title"][0], MAX_TITLE_CHARS)
            if metadata["title"]
            else ""
        ) or _truncate(fallback_title, MAX_TITLE_CHARS) or "Untitled"
        author = None
        if metadata["creator"]:
            unique: list[str] = []
            for value in metadata["creator"]:
                if value not in unique:
                    unique.append(value)
            author = _truncate(", ".join(unique), MAX_AUTHOR_CHARS) or None
        toc = _load_toc(zf, manifest, toc_id)
        chapters = _chapters(zf, manifest, spine, toc)
        cover = _cover(zf, package, manifest)
    return ParsedEpub(
        title=title,
        author=author,
        language=language,
        chapters=chapters,
        cover=cover,
        sha256=hashlib.sha256(payload).hexdigest(),
        size_bytes=len(payload),
        original_filename=safe_name,
    )


def cover_data_url(cover: EpubCover | None) -> str | None:
    if cover is None:
        return None
    encoded = base64.b64encode(cover.data).decode("ascii")
    return f"data:{cover.mime};base64,{encoded}"


# ---------------------------------------------------------------------------
# 文件名 / 目录 / 存储
# ---------------------------------------------------------------------------

def safe_filename(raw: object) -> str:
    """只保留 basename，去掉控制字符与路径分隔符（客户端名字不参与拼路径）。"""
    if not isinstance(raw, str):
        return "book.epub"
    name = os.path.basename(raw.replace("\\", "/"))
    name = _CONTROL_RE.sub("", name).strip()
    if not name:
        return "book.epub"
    return name[:MAX_FILENAME_CHARS]


def _validate_book_id(book_id: object) -> str:
    if not isinstance(book_id, str) or not _BOOK_ID_RE.match(book_id):
        raise LocalBookNotFound("书不存在。")
    return book_id


def user_books_dir(user_id: str) -> str:
    return storage.user_books_dir(user_id)


def book_dir(user_id: str, book_id: str) -> str:
    return os.path.join(user_books_dir(user_id), _validate_book_id(book_id))


def chapter_rel_path(number: int) -> str:
    return f"chapters/{number:04d}.json"


def is_valid_chapter_file(path: object, number: int) -> bool:
    return isinstance(path, str) and path == chapter_rel_path(number)


def _chapters_json(parsed: ParsedEpub) -> str:
    payload = {
        "version": 2,
        "provider": "local_epub",
        "originalFilename": parsed.original_filename,
        "sha256": parsed.sha256,
        "chapters": [
            {
                "n": chapter.n,
                "title": chapter.title,
                "file": chapter_rel_path(chapter.n),
                "chars": sum(len(paragraph) for paragraph in chapter.paragraphs),
            }
            for chapter in parsed.chapters
        ],
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def save_book(
    user_id: str,
    book_id: str,
    parsed: ParsedEpub,
) -> str:
    """把解析结果原子写入正式目录；返回入库用的 ``chapters_json``（v2）。"""
    _validate_book_id(book_id)
    chapters_json = _chapters_json(parsed)
    root = user_books_dir(user_id)
    temp_dir = os.path.join(root, f".{book_id}.tmp-{uuid.uuid4().hex[:8]}")
    final_dir = os.path.join(root, book_id)
    try:
        os.makedirs(os.path.join(temp_dir, "chapters"), exist_ok=True)
        meta = {
            "version": 1,
            "title": parsed.title,
            "author": parsed.author,
            "language": parsed.language,
            "originalFilename": parsed.original_filename,
            "sha256": parsed.sha256,
            "chapterCount": len(parsed.chapters),
            "createdAt": int(time.time() * 1000),
        }
        if parsed.cover is not None:
            meta["cover"] = f"cover.{parsed.cover.extension}"
            meta["coverMime"] = parsed.cover.mime
        _write_json(os.path.join(temp_dir, "meta.json"), meta)
        for chapter in parsed.chapters:
            _write_json(
                os.path.join(temp_dir, chapter_rel_path(chapter.n)),
                {"title": chapter.title, "paragraphs": list(chapter.paragraphs)},
            )
        if parsed.cover is not None:
            cover_path = os.path.join(temp_dir, f"cover.{parsed.cover.extension}")
            with open(cover_path, "wb") as handle:
                handle.write(parsed.cover.data)
        if os.path.exists(final_dir):
            raise LocalEpubUnavailable("书目目录已存在，请稍后重试。")
        os.replace(temp_dir, final_dir)
    except LocalEpubError:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    except OSError as exc:
        shutil.rmtree(temp_dir, ignore_errors=True)
        logger.warning("写入本地书库失败（%s/%s）：%s", user_id, book_id, exc)
        raise LocalEpubUnavailable("写入本地书库失败，请稍后重试。") from exc
    return chapters_json


def _write_json(path: str, payload: dict) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))


def read_chapter(user_id: str, book_id: str, number: int) -> list[str]:
    """读一章纯文本段落；文件缺失/损坏抛 503（数据侧问题，可重试/需重导）。"""
    if not isinstance(number, int) or isinstance(number, bool) or number < 1:
        raise LocalBookNotFound("章节不存在。")
    path = os.path.join(book_dir(user_id, book_id), chapter_rel_path(number))
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError as exc:
        raise LocalEpubUnavailable(
            "本地章节文件缺失，请删除后重新导入这本书。"
        ) from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise LocalEpubUnavailable("本地章节文件损坏，无法读取。") from exc
    paragraphs = data.get("paragraphs") if isinstance(data, dict) else None
    if (
        not isinstance(paragraphs, list)
        or not paragraphs
        or not all(isinstance(item, str) and item.strip() for item in paragraphs)
    ):
        raise LocalEpubUnavailable("本地章节文件损坏，无法读取。")
    return list(paragraphs)


def cover_file_path(user_id: str, book_id: str) -> str | None:
    directory = book_dir(user_id, book_id)
    for extension in COVER_EXTENSIONS:
        candidate = os.path.join(directory, f"cover.{extension}")
        if os.path.isfile(candidate):
            return candidate
    return None


def has_cover(user_id: str, book_id: str) -> bool:
    return cover_file_path(user_id, book_id) is not None


def read_cover(user_id: str, book_id: str) -> tuple[bytes, str] | None:
    path = cover_file_path(user_id, book_id)
    if path is None:
        return None
    extension = path.rsplit(".", 1)[-1].lower()
    mime = _IMAGE_MIME.get(extension)
    if mime is None:
        return None
    try:
        with open(path, "rb") as handle:
            return handle.read(), mime
    except OSError as exc:
        raise LocalEpubUnavailable("读取本地封面失败。") from exc


def delete_book(user_id: str, book_id: str) -> None:
    """删除整本书的本地目录；目录不存在视为成功（幂等）。"""
    path = book_dir(user_id, book_id)
    if not os.path.isdir(path):
        return
    try:
        shutil.rmtree(path)
    except OSError as exc:
        logger.warning("删除本地书目录失败（%s/%s）：%s", user_id, book_id, exc)
        raise LocalEpubUnavailable("删除本地文件失败，请稍后重试。") from exc


def book_usage(user_id: str) -> tuple[int, int]:
    """返回 ``(本地书数量, 章节 JSON 总字节数)``（配额统计，跳过临时目录）。"""
    root = user_books_dir(user_id)
    if not os.path.isdir(root):
        return 0, 0
    count = 0
    total = 0
    try:
        entries = list(os.scandir(root))
    except OSError:
        return 0, 0
    for entry in entries:
        if entry.name.startswith(".") or not entry.is_dir():
            continue
        count += 1
        chapters_dir = os.path.join(entry.path, "chapters")
        if not os.path.isdir(chapters_dir):
            continue
        try:
            files = list(os.scandir(chapters_dir))
        except OSError:
            continue
        for item in files:
            if not item.is_file() or not item.name.endswith(".json"):
                continue
            try:
                total += item.stat().st_size
            except OSError:
                continue
    return count, total


# ---------------------------------------------------------------------------
# 预览暂存（5 分钟 TTL，不落库；确认导入后删除）
# ---------------------------------------------------------------------------

def staging_dir(user_id: str) -> str:
    return os.path.join(storage.user_data_dir(user_id), ".upload-staging")


def sweep_staging(user_id: str, *, now: float | None = None) -> int:
    root = staging_dir(user_id)
    if not os.path.isdir(root):
        return 0
    moment = time.time() if now is None else now
    removed = 0
    try:
        entries = list(os.scandir(root))
    except OSError:
        return 0
    for entry in entries:
        try:
            mtime = entry.stat().st_mtime
        except OSError:
            continue
        if moment - mtime > STAGING_TTL_SECONDS:
            shutil.rmtree(entry.path, ignore_errors=True)
            removed += 1
    return removed


def stage_upload(user_id: str, data: bytes, filename: str) -> str:
    """把上传文件暂存到账号目录，返回 ``uploadToken``（5 分钟有效）。"""
    root = staging_dir(user_id)
    try:
        os.makedirs(root, exist_ok=True)
    except OSError as exc:
        raise LocalEpubUnavailable("暂时无法保存上传文件，请稍后重试。") from exc
    sweep_staging(user_id)
    token = secrets.token_urlsafe(24)
    temp_dir = os.path.join(root, f".{token}.tmp")
    target_dir = os.path.join(root, token)
    try:
        os.makedirs(temp_dir, exist_ok=False)
        with open(os.path.join(temp_dir, "book.epub"), "wb") as handle:
            handle.write(data)
        _write_json(os.path.join(temp_dir, "meta.json"), {"fileName": filename})
        os.replace(temp_dir, target_dir)
    except OSError as exc:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise LocalEpubUnavailable("暂时无法保存上传文件，请稍后重试。") from exc
    return token


def discard_staged_upload(user_id: str, token: str) -> None:
    if not isinstance(token, str) or not _TOKEN_RE.match(token):
        return
    shutil.rmtree(os.path.join(staging_dir(user_id), token), ignore_errors=True)


def take_staged_upload(user_id: str, token: object) -> tuple[bytes, str]:
    """取出预览暂存的文件并立即删除；过期/无效抛 400。"""
    if not isinstance(token, str) or not _TOKEN_RE.match(token):
        raise InvalidEpub("上传凭证无效，请重新选择文件。")
    path = os.path.join(staging_dir(user_id), token)
    if not os.path.isdir(path):
        raise InvalidEpub("预览已过期，请重新选择文件。")
    try:
        age = time.time() - os.path.getmtime(path)
    except OSError:
        age = STAGING_TTL_SECONDS + 1
    if age > STAGING_TTL_SECONDS:
        shutil.rmtree(path, ignore_errors=True)
        raise InvalidEpub("预览已过期，请重新选择文件。")
    try:
        with open(os.path.join(path, "book.epub"), "rb") as handle:
            data = handle.read()
        try:
            with open(os.path.join(path, "meta.json"), encoding="utf-8") as handle:
                meta = json.load(handle)
        except (OSError, json.JSONDecodeError):
            meta = {}
    except FileNotFoundError as exc:
        shutil.rmtree(path, ignore_errors=True)
        raise InvalidEpub("预览文件已失效，请重新选择文件。") from exc
    except OSError as exc:
        raise LocalEpubUnavailable("读取预览文件失败，请稍后重试。") from exc
    finally:
        shutil.rmtree(path, ignore_errors=True)
    filename = safe_filename(meta.get("fileName") if isinstance(meta, dict) else None)
    return data, filename


__all__ = [
    "COVER_EXTENSIONS",
    "EpubChapter",
    "EpubCover",
    "EpubTooLarge",
    "EpubUnsupported",
    "InvalidEpub",
    "LocalBookNotFound",
    "LocalEpubError",
    "LocalEpubUnavailable",
    "ParsedEpub",
    "book_dir",
    "book_usage",
    "chapter_rel_path",
    "cover_data_url",
    "cover_file_path",
    "delete_book",
    "discard_staged_upload",
    "has_cover",
    "is_valid_chapter_file",
    "max_books_per_user",
    "max_chapter_chars",
    "max_chapters",
    "max_text_bytes_per_user",
    "max_upload_bytes",
    "parse_epub",
    "read_chapter",
    "read_cover",
    "safe_filename",
    "save_book",
    "stage_upload",
    "staging_dir",
    "sweep_staging",
    "take_staged_upload",
    "user_books_dir",
]
