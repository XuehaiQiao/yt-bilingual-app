"""Anki ``.apkg`` 只读解析（specs/046-apkg-import §2）。

设计边界：

- **只读**：ZIP 里只读取 ``collection.anki21b`` → ``collection.anki21`` →
  ``collection.anki2`` 中优先级最高的那一个成员；媒体（成员名通常是
  ``0``/``1``/... 与 ``media``）一律不解压。SQLite 临时文件用
  ``mode=ro`` + ``PRAGMA query_only`` 打开，绝不写回。
- **限额**：上传 ≤ :data:`MAX_UPLOAD_BYTES`（50 MB，路由负责流式判断）；
  collection 解压后 ≤ :data:`MAX_COLLECTION_BYTES`（200 MB）；最多返回
  :data:`MAX_NOTES`（10000）条 notes，超出截断并标记 ``truncated``。
- **zip bomb / 路径防护**：限制成员数、拒绝加密成员与绝对路径/``..`` 路径，
  读取 collection 时按块累计字节，不信任 ZIP 中央目录里的 ``file_size``。
- **两种 collection**：legacy（``col.models``/``col.decks`` JSON）与新版
  schema（``notetypes``/``fields``/``decks``/``notes``/``cards`` 表）；其它
  结构明确报「不支持的格式」。
- **清洗**：``<br>`` → 空格、去标签、去 ``[sound:…]``、还原 HTML entity、
  压缩空白；返回的 ``fields`` 已清洗，并额外给出字段映射：
  ``word``（单词/word/Front…）、``translation``（解释/释义/meaning/Back…）、
  ``phonetic``（音标/IPA…，没有则为空串）。

错误都用 :class:`ApkgError` 的子类携带 HTTP 语义，路由只做映射：

- :class:`ApkgInvalid` / :class:`ApkgEmpty` / :class:`ApkgUnsupported` → 400
- :class:`ApkgTooLarge` → 413
- :class:`ApkgUnavailable` → 503（缺 ``zstandard`` 依赖）
"""
from __future__ import annotations

import html
import io
import json
import logging
import os
import re
import sqlite3
import tempfile
import urllib.parse
import zipfile
import zlib

logger = logging.getLogger("linguatrek.apkg_import")

# 上传大小（路由流式读取时判断）；真实 GRE 包 30 MB，留出余量。
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
# collection 解压后上限：防止压缩炸弹（50 MB 上传理论上可膨胀很远）。
MAX_COLLECTION_BYTES = 200 * 1024 * 1024
# APKG 成员数上限（真实包 7k 左右；超过视为异常，避免用成员表做 DoS）。
MAX_MEMBERS = 100_000
# 单次响应返回的 notes 上限；total/truncated 反映全量。
MAX_NOTES = 10_000

COLLECTION_MEMBERS = (
    "collection.anki21b",
    "collection.anki21",
    "collection.anki2",
)
ANKI21B = "collection.anki21b"

NOTE_FIELD_SEP = "\x1f"
_READ_CHUNK = 1024 * 1024
_SQLITE_MAGIC = b"SQLite format 3\x00"

# 字段名 → 语义映射；字段名先做大小写/空白/下划线归一化再比较。
_WORD_FIELD_NAMES = (
    "word",
    "单词",
    "front",
    "正面",
    "term",
    "expression",
    "english",
)
_TRANSLATION_FIELD_NAMES = (
    "translation",
    "meaning",
    "definition",
    "解释",
    "释义",
    "意思",
    "back",
    "背面",
    "中文",
)
_PHONETIC_FIELD_NAMES = (
    "phonetic",
    "phonetics",
    "ipa",
    "音标",
    "发音",
)
_FIELD_NAME_STRIP_RE = re.compile(r"[\s_\-]+")

_SOUND_RE = re.compile(r"\[sound:[^\]]*\]", re.IGNORECASE)
_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
# 块级标签直接去掉会粘词（"a<br>b" 已由 _BR_RE 处理），其余也换空格。
_BLOCK_TAG_RE = re.compile(
    r"</?(?:div|p|li|ul|ol|tr|td|th|table|tbody|thead|h[1-6]|blockquote|pre)\b[^>]*>",
    re.IGNORECASE,
)
_TAG_RE = re.compile(r"<[^>]*>")
_ZERO_WIDTH = ("\u200b", "\u200c", "\u200d", "\ufeff")
_WS_RE = re.compile(r"\s+")


class ApkgError(Exception):
    """APKG 解析错误基类；``status_code`` 供路由映射 HTTP 状态。"""

    status_code = 400

    def __init__(self, detail: str):
        self.detail = detail
        super().__init__(detail)


class ApkgInvalid(ApkgError):
    """不是合法 APKG / ZIP 损坏 / collection 损坏。"""


class ApkgEmpty(ApkgError):
    """APKG 里没有 notes。"""


class ApkgUnsupported(ApkgError):
    """collection 结构不是支持的 legacy / 新 schema。"""


class ApkgTooLarge(ApkgError):
    """上传或解压后的 collection 超过限额。"""

    status_code = 413


class ApkgUnavailable(ApkgError):
    """解析所需依赖缺失（``zstandard``）。"""

    status_code = 503


def max_upload_bytes() -> int:
    """路由读取上传文件时使用的字节上限（测试可 monkeypatch 常量）。"""
    return MAX_UPLOAD_BYTES


def display_filename(filename: str | None) -> str:
    """把上传文件名收敛成可回显的单段文件名（不用于磁盘路径）。"""
    base = os.path.basename(str(filename or "").replace("\\", "/")).strip()
    base = "".join(ch for ch in base if ch >= " " and ch != "\x7f")
    return base or "import.apkg"


# ---------------------------------------------------------------------------
# ZIP 层
# ---------------------------------------------------------------------------

def _validate_member(info: zipfile.ZipInfo) -> None:
    """拒绝加密成员、绝对路径与 ``..`` 穿越；媒体不读但名字也要安全。"""
    name = info.filename.replace("\\", "/")
    if info.flag_bits & 0x1:
        raise ApkgInvalid("APKG 含加密成员，暂不支持。")
    if not name or name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        raise ApkgInvalid("APKG 内含非法成员路径。")
    if "\x00" in name or ".." in name.split("/"):
        raise ApkgInvalid("APKG 内含非法成员路径。")


def _pick_collection(infos: list[zipfile.ZipInfo]) -> zipfile.ZipInfo:
    by_name = {info.filename: info for info in infos if not info.is_dir()}
    for member in COLLECTION_MEMBERS:
        info = by_name.get(member)
        if info is not None:
            return info
    raise ApkgInvalid(
        "APKG 里没有 collection.anki21b / collection.anki21 / collection.anki2。"
    )


def _read_collection(zf: zipfile.ZipFile, info: zipfile.ZipInfo) -> bytes:
    """按块读取 collection，边读边限长，不信任中央目录的 file_size。"""
    if info.file_size > MAX_COLLECTION_BYTES:
        raise ApkgTooLarge(
            f"collection 解压后超过 {MAX_COLLECTION_BYTES // (1024 * 1024)}MB 上限。"
        )
    chunks: list[bytes] = []
    total = 0
    try:
        with zf.open(info, "r") as handle:
            while True:
                block = handle.read(_READ_CHUNK)
                if not block:
                    break
                total += len(block)
                if total > MAX_COLLECTION_BYTES:
                    raise ApkgTooLarge(
                        f"collection 解压后超过 {MAX_COLLECTION_BYTES // (1024 * 1024)}MB 上限。"
                    )
                chunks.append(block)
    except ApkgError:
        raise
    except (zipfile.BadZipFile, RuntimeError, EOFError, OSError, ValueError, zlib.error) as exc:
        raise ApkgInvalid("读取 APKG 内的 collection 失败（压缩包损坏）。") from exc
    if total == 0:
        raise ApkgInvalid("APKG 内的 collection 是空文件。")
    return b"".join(chunks)


# ---------------------------------------------------------------------------
# zstd（.anki21b）
# ---------------------------------------------------------------------------

def _load_zstd():
    """延迟导入 zstandard；缺依赖 → 503，不拖垮其它导入功能。"""
    try:
        import zstandard  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - 环境装了依赖时走不到
        raise ApkgUnavailable(
            "服务器缺少 zstandard 依赖，暂时无法解析 collection.anki21b；"
            "请改用 .anki21/.anki2 导出，或让管理员安装 zstandard。"
        ) from exc
    return zstandard


def _decompress_anki21b(raw: bytes) -> bytes:
    zstandard = _load_zstd()
    chunks: list[bytes] = []
    total = 0
    try:
        with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw)) as reader:
            while True:
                block = reader.read(_READ_CHUNK)
                if not block:
                    break
                total += len(block)
                if total > MAX_COLLECTION_BYTES:
                    raise ApkgTooLarge(
                        f"collection.anki21b 解压后超过 "
                        f"{MAX_COLLECTION_BYTES // (1024 * 1024)}MB 上限。"
                    )
                chunks.append(block)
    except ApkgError:
        raise
    except Exception as exc:  # zstandard.ZstdError 等
        raise ApkgInvalid("collection.anki21b 解压失败（文件损坏或格式不支持）。") from exc
    if total == 0:
        raise ApkgInvalid("collection.anki21b 解压后为空。")
    return b"".join(chunks)


# ---------------------------------------------------------------------------
# SQLite 层
# ---------------------------------------------------------------------------

def _temp_sqlite(data: bytes) -> str:
    fd, path = tempfile.mkstemp(prefix="apkg-", suffix=".sqlite")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
    except Exception:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise
    return path


def _open_readonly(path: str) -> sqlite3.Connection:
    uri = "file:" + urllib.parse.quote(os.path.abspath(path), safe="/") + "?mode=ro&immutable=1"
    conn = sqlite3.connect(uri, uri=True, timeout=5)
    conn.execute("PRAGMA query_only = ON")
    return conn


def _table_names(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    return {str(row[0]) for row in rows}


def _sort_key(value: str):
    return (0, int(value)) if value.isdigit() else (1, value)


def _json_object(raw, label: str) -> dict:
    try:
        value = json.loads(raw or "{}")
    except (TypeError, json.JSONDecodeError) as exc:
        raise ApkgUnsupported(f"collection 的 {label} 不是合法 JSON。") from exc
    if not isinstance(value, dict):
        raise ApkgUnsupported(f"collection 的 {label} 结构无法识别。")
    return value


def _legacy_models(col_models: dict) -> list[dict]:
    models = []
    for key, model in col_models.items():
        if not isinstance(model, dict):
            continue
        raw_fields = model.get("flds") or []
        if not isinstance(raw_fields, list):
            raw_fields = []
        ordered = [item for item in raw_fields if isinstance(item, dict)]
        if all(isinstance(item.get("ord"), int) for item in ordered if ordered):
            ordered.sort(key=lambda item: item.get("ord") or 0)
        fields = [str(item.get("name") or "").strip() for item in ordered]
        model_id = str(model.get("id") or key)
        models.append(
            {"id": model_id, "name": str(model.get("name") or "").strip(), "fields": fields}
        )
    models.sort(key=lambda item: _sort_key(item["id"]))
    return models


def _deck_rows(raw_decks: dict) -> list[dict]:
    decks = []
    for key, deck in raw_decks.items():
        if not isinstance(deck, dict):
            continue
        decks.append(
            {
                "id": str(deck.get("id") or key),
                "name": str(deck.get("name") or "").strip(),
                "noteCount": 0,
            }
        )
    decks.sort(key=lambda item: _sort_key(item["id"]))
    return decks


def _deck_note_counts(conn: sqlite3.Connection) -> dict[str, int]:
    rows = conn.execute(
        "SELECT did, COUNT(DISTINCT nid) FROM cards GROUP BY did"
    ).fetchall()
    counts: dict[str, int] = {}
    for did, count in rows:
        if did is None:
            continue
        counts[str(did)] = int(count)
    return counts


def _note_rows(conn: sqlite3.Connection) -> tuple[int, list[tuple]]:
    total = int(conn.execute("SELECT COUNT(*) FROM notes").fetchone()[0])
    rows = conn.execute(
        "SELECT n.mid, n.flds, "
        "(SELECT c.did FROM cards c WHERE c.nid = n.id ORDER BY c.id LIMIT 1) "
        "FROM notes n ORDER BY n.id LIMIT ?",
        (MAX_NOTES,),
    ).fetchall()
    return total, rows


def _parse_legacy(conn: sqlite3.Connection) -> tuple[list[dict], list[dict]]:
    try:
        row = conn.execute("SELECT models, decks FROM col LIMIT 1").fetchone()
    except sqlite3.OperationalError as exc:
        raise ApkgUnsupported("不支持的 APKG collection 格式（col 表结构异常）。") from exc
    if row is None:
        raise ApkgUnsupported("collection 的 col 表为空。")
    models = _legacy_models(_json_object(row[0], "models"))
    decks = _deck_rows(_json_object(row[1], "decks"))
    counts = _deck_note_counts(conn)
    for deck in decks:
        deck["noteCount"] = counts.get(deck["id"], 0)
    return models, decks


def _parse_new_schema(conn: sqlite3.Connection) -> tuple[list[dict], list[dict]]:
    try:
        model_rows = conn.execute(
            "SELECT id, name FROM notetypes ORDER BY id"
        ).fetchall()
        field_rows = conn.execute(
            "SELECT ntid, ord, name FROM fields ORDER BY ntid, ord"
        ).fetchall()
        deck_rows = conn.execute("SELECT id, name FROM decks ORDER BY id").fetchall()
    except sqlite3.OperationalError as exc:
        raise ApkgUnsupported(
            "不支持的 APKG collection 格式（notetypes/fields/decks 表结构异常）。"
        ) from exc

    fields_by_model: dict[str, list[str]] = {}
    for ntid, _ord, name in sorted(field_rows, key=lambda item: (item[0], item[1])):
        fields_by_model.setdefault(str(ntid), []).append(str(name or "").strip())
    models = [
        {
            "id": str(model_id),
            "name": str(name or "").strip(),
            "fields": fields_by_model.get(str(model_id), []),
        }
        for model_id, name in model_rows
    ]
    decks = [
        {"id": str(deck_id), "name": str(name or "").strip(), "noteCount": 0}
        for deck_id, name in deck_rows
    ]
    counts = _deck_note_counts(conn)
    for deck in decks:
        deck["noteCount"] = counts.get(deck["id"], 0)
    return models, decks


# ---------------------------------------------------------------------------
# HTML 清洗 / 字段映射
# ---------------------------------------------------------------------------

def clean_html(value) -> str:
    """Anki 字段 HTML → 纯文本（spec §2 清洗规则）。"""
    if value is None:
        return ""
    text = str(value)
    text = _SOUND_RE.sub(" ", text)
    text = _BR_RE.sub(" ", text)
    text = _BLOCK_TAG_RE.sub(" ", text)
    text = _TAG_RE.sub("", text)
    text = html.unescape(text)
    for ch in _ZERO_WIDTH:
        text = text.replace(ch, "")
    return _WS_RE.sub(" ", text).strip()


def _field_key(name: str) -> str:
    return _FIELD_NAME_STRIP_RE.sub("", str(name or "")).lower()


def _find_field(fields: list[str], candidates: tuple[str, ...]) -> int | None:
    keys = [_field_key(name) for name in fields]
    for candidate in candidates:
        key = _field_key(candidate)
        if key in keys:
            return keys.index(key)
    return None


def _nth_nonempty(values: list[str], n: int, skip: set[int]) -> str:
    seen = 0
    for index, value in enumerate(values):
        if index in skip or not value:
            continue
        if seen == n:
            return value
        seen += 1
    return ""


def _map_fields(fields: list[str], values: list[str]) -> dict[str, str]:
    word_index = _find_field(fields, _WORD_FIELD_NAMES)
    translation_index = _find_field(fields, _TRANSLATION_FIELD_NAMES)
    phonetic_index = _find_field(fields, _PHONETIC_FIELD_NAMES)

    if word_index is not None and word_index < len(values):
        word = values[word_index]
    else:
        word = _nth_nonempty(values, 0, set())
    skip = {word_index} if word_index is not None else {values.index(word)} if word in values else set()
    if translation_index is not None and translation_index < len(values):
        translation = values[translation_index]
    else:
        translation = _nth_nonempty(values, 0, skip)
    phonetic = ""
    if phonetic_index is not None and phonetic_index < len(values):
        phonetic = values[phonetic_index]
    return {"word": word, "translation": translation, "phonetic": phonetic}


def _build_notes(rows, models: list[dict]) -> list[dict]:
    model_fields = {model["id"]: model["fields"] for model in models}
    notes = []
    for mid, raw_fields, did in rows:
        model_id = str(mid)
        raw_values = str(raw_fields or "").split(NOTE_FIELD_SEP)
        values = [clean_html(item) for item in raw_values]
        notes.append(
            {
                "deckId": "" if did is None else str(did),
                "modelId": model_id,
                "fields": values,
                **_map_fields(model_fields.get(model_id, []), values),
            }
        )
    return notes


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def _parse_collection(raw: bytes, filename: str | None) -> dict:
    if not raw.startswith(_SQLITE_MAGIC):
        raise ApkgInvalid("APKG 内的 collection 不是 SQLite 数据库。")
    path = _temp_sqlite(raw)
    conn = None
    try:
        try:
            conn = _open_readonly(path)
            tables = _table_names(conn)
            if {"notetypes", "fields", "decks", "notes", "cards"} <= tables:
                models, decks = _parse_new_schema(conn)
            elif {"col", "notes", "cards"} <= tables:
                models, decks = _parse_legacy(conn)
            else:
                raise ApkgUnsupported("不支持的 APKG collection 格式（未识别的表结构）。")
            total, rows = _note_rows(conn)
        except sqlite3.DatabaseError as exc:
            raise ApkgInvalid("APKG 内的 collection 不是有效的 SQLite 数据库。") from exc
        finally:
            if conn is not None:
                conn.close()
    finally:
        try:
            os.unlink(path)
        except OSError:
            logger.warning("apkg 临时文件清理失败：%s", path)

    if total <= 0:
        raise ApkgEmpty("APKG 里没有可导入的 notes。")
    return {
        "fileName": display_filename(filename),
        "decks": decks,
        "models": models,
        "notes": _build_notes(rows, models),
        "total": total,
        "truncated": total > MAX_NOTES,
    }


def parse_apkg(data: bytes, filename: str | None = None) -> dict:
    """解析 ``.apkg`` 字节，返回 decks/models/notes/total/truncated。

    - 只读 collection 成员，不解压媒体；临时 SQLite 用完即删；
    - 无 notes → :class:`ApkgEmpty`；结构不认识 → :class:`ApkgUnsupported`；
    - 超限 → :class:`ApkgTooLarge`；缺 zstd → :class:`ApkgUnavailable`。
    """
    if not isinstance(data, (bytes, bytearray)) or not data:
        raise ApkgInvalid("APKG 文件为空。")
    try:
        zf = zipfile.ZipFile(io.BytesIO(bytes(data)))
    except (zipfile.BadZipFile, OSError) as exc:
        raise ApkgInvalid("不是有效的 APKG（ZIP）文件。") from exc

    with zf:
        infos = zf.infolist()
        if len(infos) > MAX_MEMBERS:
            raise ApkgInvalid("APKG 成员数量异常，已拒绝解析。")
        for info in infos:
            _validate_member(info)
        info = _pick_collection(infos)
        raw = _read_collection(zf, info)
        member_name = info.filename

    if member_name == ANKI21B:
        raw = _decompress_anki21b(raw)
    return _parse_collection(raw, filename)
