"""导入自定义词表的读写层（specs/038-custom-wordlists §2–§6）。

职责边界：

- **只做数据与校验**：HTTP 参数/错误码映射在 ``routes_wordlists.py``；本模块
  不 import FastAPI。表由 Alembic ``0028_user_wordlists`` 创建，运行时不建表。
- **服务端也校验**：客户端向导会先过滤一遍，但服务端必须独立判定——否则直接
  调接口就能把中文/数字/超长词写进词表。校验规则与 spec §2 一一对应。
- **事务性**：一次导入 = 一张词表 + 全部条目，写在同一个
  ``BEGIN IMMEDIATE`` 事务里；任何一步失败整笔回滚，绝不落半张表。
- **删除级联**：删除词表时显式先删条目再删表（不依赖连接是否开
  ``PRAGMA foreign_keys``；迁移里的 ``ON DELETE CASCADE`` 是第二道保险）。
- **编辑**：重命名（同用户唯一）与按 id 批量删条目都是整笔事务；删条目先
  校验全部 id 都属于该词表再删，删后重新统计 ``item_count``（不靠减法推算）。
- **去重键**：``NFC + casefold``（保留第一条的原词形）。``café`` / ``CAFÉ`` /
  分解写法的 ``cafe\u0301`` 视为同一个词。
- **释义快照不在这里**：加入复习时由 ``srs.add_word(definition=...)`` 写入
  ``word_states.definition``，本模块只负责词表存储。

常量与限额（spec §6）：每人 ≤10 张表、每表 ≤10000 词、name ≤80 字、
单词 ≤40 字符且 ≤5 个词的短语。
"""
from __future__ import annotations

import os
import re
import sqlite3
import unicodedata
import uuid
from datetime import datetime, timezone

import config
import languages

MAX_LISTS = 10
MAX_ITEMS = 10000
MAX_NAME_LENGTH = 80
MAX_WORD_LENGTH = 40
MAX_WORD_TOKENS = 5
MAX_DELETE_ITEMS = 500
DEFAULT_NAME = "导入词表"
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200

# 允许的 CEFR 档位（spec §2：其它值忽略，不猜）。
CEFR_LEVELS = ("A1", "A2", "B1", "B2", "C1")

# 拉丁字母范围：ASCII + Latin-1 Supplement + Latin Extended-A/B +
# Latin Extended Additional / C / D（覆盖 café / naïve / Ångström / tiếng 等）。
_LETTER = (
    "A-Za-z"
    "\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u00ff"
    "\u0100-\u024f"
    "\u1e00-\u1eff"
    "\u2c60-\u2c7f"
    "\ua720-\ua7ff"
)
# 组合变音符号：NFC 之后大部分会预组合，少数（多重重音）仍以组合字符存在。
_MARK = "\u0300-\u036f"
# 一个 token：以字母开头，可含字母/组合符号，允许内部连字符或撇号连接
# （don't / mother-in-law / rock’n’roll），不允许首尾/连续标点。
_TOKEN_RE = re.compile(
    rf"^[{_LETTER}][{_LETTER}{_MARK}]*"
    rf"(?:['\u2019\u2011-][{_LETTER}][{_LETTER}{_MARK}]*)*$"
)
_WHITESPACE_RE = re.compile(r"\s+")


class WordlistError(Exception):
    """词表模块错误基类。"""


class WordlistUnavailable(WordlistError):
    """库/表不存在（未跑 0028 迁移）：路由应返回 503。"""


class WordlistNotFound(WordlistError):
    """词表不存在或不属于当前用户（路由 404）。"""


class WordlistValidationError(WordlistError, ValueError):
    """参数/内容非法（路由 400）。"""


# ---------------------------------------------------------------------------
# 时间 / 基础校验
# ---------------------------------------------------------------------------

def now_ms() -> int:
    """服务端当前毫秒时间戳（测试可 monkeypatch）。"""
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _coerce_ms(now) -> int:
    if now is None:
        return now_ms()
    if isinstance(now, datetime):
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        return int(round(now.timestamp() * 1000))
    try:
        return int(now)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"非法时间戳：{now!r}") from exc


def _db_path() -> str:
    return config.AUTH_DB_PATH


def _connect() -> sqlite3.Connection:
    path = _db_path()
    if not os.path.exists(path):
        raise WordlistUnavailable(
            f"数据库文件不存在：{path}（先运行 `backend/venv/bin/alembic upgrade head`）。"
        )
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _translate_db_error(exc: sqlite3.Error) -> None:
    """表/列缺失 → WordlistUnavailable（503）；其余错误原样抛。"""
    text = str(exc).lower()
    if "no such table" in text or "no such column" in text:
        raise WordlistUnavailable(
            "词表数据表不存在（未跑 0028_user_wordlists 迁移）。"
            "请先运行 `backend/venv/bin/alembic upgrade head`。"
        ) from exc


def _require_user_id(user_id: str) -> str:
    if not isinstance(user_id, str) or not user_id.strip():
        raise WordlistValidationError("user_id 不能为空。")
    return user_id.strip()


# ---------------------------------------------------------------------------
# 词条校验（spec §2）
# ---------------------------------------------------------------------------

def normalize_word(raw) -> str:
    """校验并规范单个词/短语；非法抛 :class:`WordlistValidationError`。

    - NFC + 去首尾空白 + 连续空白折叠成单空格；
    - 必须含拉丁字母（允许重音、连字符、撇号）；纯中文/日文/韩文/数字/符号
      一律拒绝；
    - ≤40 字符、≤5 个词的短语（按空格切分）。
    """
    if not isinstance(raw, str):
        raise WordlistValidationError("单词必须是字符串。")
    value = _WHITESPACE_RE.sub(" ", languages.normalize(raw).strip())
    if not value:
        raise WordlistValidationError("单词不能为空。")
    if len(value) > MAX_WORD_LENGTH:
        raise WordlistValidationError(
            f"单词太长（最多 {MAX_WORD_LENGTH} 字符）：{value[:20]}…"
        )
    tokens = value.split(" ")
    if len(tokens) > MAX_WORD_TOKENS:
        raise WordlistValidationError(
            f"短语最多 {MAX_WORD_TOKENS} 个词：{value[:20]}…"
        )
    for token in tokens:
        if not _TOKEN_RE.fullmatch(token):
            raise WordlistValidationError(f"不是英文单词：{token[:20]}")
    return value


def word_key(word: str) -> str:
    """去重键：``NFC + casefold``（保留原词形，只用于比较）。"""
    return unicodedata.normalize("NFC", word).casefold()


def normalize_cefr(raw) -> str | None:
    """CEFR 只接受 A1/A2/B1/B2/C1；其它（含 C2/D1、空值）一律 None。"""
    if not isinstance(raw, str):
        return None
    value = raw.strip().upper()
    return value if value in CEFR_LEVELS else None


def _clean_optional_text(raw) -> str | None:
    """释义/音标/例句：非字符串或空白 → None；字符串去首尾空白保留原样。"""
    if not isinstance(raw, str):
        return None
    value = raw.strip()
    return value or None


def validate_item(item) -> dict | None:
    """单个条目 → 清洗后的字段字典；无效返回 None。

    ``word`` 保留导入时的原词形（NFC/空白规范化后）；``word_key`` 另存。
    """
    if not isinstance(item, dict):
        return None
    try:
        word = normalize_word(item.get("word"))
    except WordlistValidationError:
        return None
    return {
        "word": word,
        "word_key": word_key(word),
        "translation": _clean_optional_text(item.get("translation")),
        "phonetic": _clean_optional_text(item.get("phonetic")),
        "cefr": normalize_cefr(item.get("cefr")),
        "example": _clean_optional_text(item.get("example")),
    }


# ---------------------------------------------------------------------------
# 名称
# ---------------------------------------------------------------------------

def _sanitize_filename(filename) -> str | None:
    """存进 ``source_filename`` 的展示名：只留 basename、去控制字符、≤255。"""
    if not isinstance(filename, str) or not filename.strip():
        return None
    base = filename.replace("\\", "/").rsplit("/", 1)[-1].strip()
    base = _WHITESPACE_RE.sub(" ", base)
    base = "".join(ch for ch in base if ch.isprintable()).strip()
    return base[:255] or None


def normalize_name(raw) -> str:
    """校验并规范词表名称（重命名用）：空白折叠、去控制字符、≤80 字符。

    空名/非字符串/超长 → :class:`WordlistValidationError`（路由 400）。
    与导入的 ``_base_name`` 不同：导入是「宽松截断」，重命名是用户显式输入，
    超长必须报错而不是悄悄截掉。
    """
    if not isinstance(raw, str):
        raise WordlistValidationError("词表名称必须是字符串。")
    value = _WHITESPACE_RE.sub(" ", raw.strip())
    value = "".join(ch for ch in value if ch.isprintable()).strip()
    if not value:
        raise WordlistValidationError("词表名称不能为空。")
    if len(value) > MAX_NAME_LENGTH:
        raise WordlistValidationError(
            f"词表名称最多 {MAX_NAME_LENGTH} 个字符（收到 {len(value)} 个）。"
        )
    return value


def _base_name(name, filename) -> str:
    """请求里的 name 优先；否则用文件名（去扩展名）；再否则默认名。"""
    candidate = None
    if isinstance(name, str) and name.strip():
        candidate = _WHITESPACE_RE.sub(" ", name.strip())
    elif isinstance(filename, str) and filename.strip():
        base = filename.replace("\\", "/").rsplit("/", 1)[-1].strip()
        stem = os.path.splitext(base)[0].strip()
        candidate = _WHITESPACE_RE.sub(" ", stem or base)
    if not candidate:
        candidate = DEFAULT_NAME
    candidate = "".join(ch for ch in candidate if ch.isprintable()).strip()
    return candidate[:MAX_NAME_LENGTH].strip() or DEFAULT_NAME


def _unique_name(conn: sqlite3.Connection, user_id: str, base: str) -> str:
    """同名自动加 ``(2)`` / ``(3)``…，结果仍 ≤80 字。"""
    existing = {
        row["name"]
        for row in conn.execute(
            "SELECT name FROM user_wordlists WHERE user_id = ?", (user_id,)
        )
    }
    if base not in existing:
        return base
    index = 2
    while True:
        suffix = f" ({index})"
        candidate = base[: max(1, MAX_NAME_LENGTH - len(suffix))].rstrip() + suffix
        if candidate not in existing:
            return candidate
        index += 1


# ---------------------------------------------------------------------------
# 导入
# ---------------------------------------------------------------------------

def _prepare_items(items) -> tuple[list[dict], int, int]:
    """校验 + 去重；返回 ``(有效条目, 总行数, 校验失败行数)``。

    重复行（同表同 ``word_key``）只留第一条，计入 ``skipped`` 但**不算**
    校验失败——否则一张「100 个词 + 100 个重复」的正常词表会被误判成
    「看起来不是英文词表」。
    """
    try:
        rows = list(items or [])
    except TypeError as exc:
        raise WordlistValidationError("items 必须是数组。") from exc
    if len(rows) > MAX_ITEMS:
        raise WordlistValidationError(
            f"单次最多导入 {MAX_ITEMS} 个词条（收到 {len(rows)} 行）。"
        )
    cleaned: list[dict] = []
    seen: set[str] = set()
    invalid = 0
    for row in rows:
        item = validate_item(row)
        if item is None:
            invalid += 1
            continue
        if item["word_key"] in seen:
            continue
        seen.add(item["word_key"])
        cleaned.append(item)
    return cleaned, len(rows), invalid


def import_wordlist(
    user_id: str,
    name=None,
    filename=None,
    items=(),
    now=None,
) -> dict:
    """导入一张词表（整笔事务）。

    返回 ``{"list": {id,name,itemCount,createdAt}, "skipped": N}``。
    失败抛 :class:`WordlistValidationError`（400）/ :class:`WordlistUnavailable`。

    - 有效行 0 → 400；校验失败行 > 50% → 400（不落库）；
    - 每人表数达到 :data:`MAX_LISTS` 时 400；
    - 同名自动加 ``(2)``；返回的 ``skipped`` = 无效行 + 重复行。
    """
    user_id = _require_user_id(user_id)
    cleaned, total, invalid = _prepare_items(items)
    if not cleaned:
        raise WordlistValidationError("没有可导入的有效词条（全部无效或为空）。")
    if total and invalid * 2 > total:
        raise WordlistValidationError(
            f"无效行过多（{invalid}/{total}，超过 50%），这看起来不是英文词表。"
        )
    skipped = total - len(cleaned)
    now_value = _coerce_ms(now)
    source_filename = _sanitize_filename(filename)

    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        count = int(
            conn.execute(
                "SELECT COUNT(*) AS n FROM user_wordlists WHERE user_id = ?",
                (user_id,),
            ).fetchone()["n"]
            or 0
        )
        if count >= MAX_LISTS:
            raise WordlistValidationError(
                f"每人最多 {MAX_LISTS} 个自定义词表（当前 {count} 个），"
                "请先删除不再使用的词表。"
            )
        list_id = uuid.uuid4().hex
        list_name = _unique_name(conn, user_id, _base_name(name, filename))
        conn.execute(
            "INSERT INTO user_wordlists "
            "(id, user_id, name, source_filename, item_count, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (list_id, user_id, list_name, source_filename, len(cleaned), now_value),
        )
        conn.executemany(
            "INSERT INTO user_wordlist_items "
            "(id, list_id, word, word_key, translation, phonetic, cefr, example, "
            "position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    uuid.uuid4().hex,
                    list_id,
                    item["word"],
                    item["word_key"],
                    item["translation"],
                    item["phonetic"],
                    item["cefr"],
                    item["example"],
                    position,
                )
                for position, item in enumerate(cleaned, start=1)
            ],
        )
        conn.commit()
    except sqlite3.OperationalError as exc:
        conn.rollback()
        _translate_db_error(exc)
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return {
        "list": {
            "id": list_id,
            "name": list_name,
            "itemCount": len(cleaned),
            "createdAt": now_value,
        },
        "skipped": skipped,
    }


# ---------------------------------------------------------------------------
# 读取
# ---------------------------------------------------------------------------

def _public_list(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "itemCount": int(row["item_count"] or 0),
        "createdAt": int(row["created_at"] or 0),
    }


def list_wordlists(user_id: str) -> dict:
    """当前用户的全部词表，按创建时间升序（新导入的排在最后）。"""
    user_id = _require_user_id(user_id)
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT id, name, item_count, created_at FROM user_wordlists "
            "WHERE user_id = ? ORDER BY created_at ASC, rowid ASC",
            (user_id,),
        ).fetchall()
    except sqlite3.OperationalError as exc:
        _translate_db_error(exc)
        raise
    finally:
        conn.close()
    return {"lists": [_public_list(row) for row in rows]}


def _positive_int(value, field: str) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise WordlistValidationError(f"{field} 必须是整数。") from exc
    if number < 1:
        raise WordlistValidationError(f"{field} 必须 ≥ 1。")
    return number


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def get_wordlist(
    user_id: str,
    list_id: str,
    page: int = 1,
    page_size: int = DEFAULT_PAGE_SIZE,
    q=None,
) -> dict:
    """词表详情（分页 + 搜索）。

    - 返回 ``{id,name,items,total,page,pageSize,hasMore}``；``items`` 每项含
      ``id/word/translation/phonetic/cefr/example``（``id`` 可直接用于
      ``DELETE /api/wordlists/{id}/items`` 的 ``itemIds``）；
    - ``q`` 同时匹配单词（``word_key``）与释义（大小写不敏感子串）；
    - 词表不存在或不属于当前用户 → :class:`WordlistNotFound`（越权不泄露
      存在性）。
    """
    user_id = _require_user_id(user_id)
    page = _positive_int(page, "page")
    page_size = _positive_int(page_size, "pageSize")
    if page_size > MAX_PAGE_SIZE:
        raise WordlistValidationError(f"pageSize 最大 {MAX_PAGE_SIZE}。")
    if not isinstance(list_id, str) or not list_id.strip():
        raise WordlistNotFound("词表不存在。")
    list_id = list_id.strip()

    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id, name, item_count, created_at FROM user_wordlists "
            "WHERE id = ? AND user_id = ?",
            (list_id, user_id),
        ).fetchone()
        if row is None:
            raise WordlistNotFound("词表不存在。")
        where = "list_id = ?"
        args: list = [list_id]
        query = q.strip() if isinstance(q, str) else ""
        if query:
            query_key = unicodedata.normalize("NFC", query).casefold()
            word_pattern = f"%{_escape_like(query_key)}%"
            text_pattern = f"%{_escape_like(query)}%"
            where += (
                " AND (word_key LIKE ? ESCAPE '\\' "
                "OR COALESCE(translation, '') LIKE ? ESCAPE '\\')"
            )
            args.extend([word_pattern, text_pattern])
        total = int(
            conn.execute(
                f"SELECT COUNT(*) AS n FROM user_wordlist_items WHERE {where}",
                tuple(args),
            ).fetchone()["n"]
            or 0
        )
        offset = (page - 1) * page_size
        rows = conn.execute(
            "SELECT id, word, translation, phonetic, cefr, example "
            f"FROM user_wordlist_items WHERE {where} "
            "ORDER BY position ASC, rowid ASC LIMIT ? OFFSET ?",
            (*args, page_size, offset),
        ).fetchall()
    except sqlite3.OperationalError as exc:
        _translate_db_error(exc)
        raise
    finally:
        conn.close()

    return {
        "id": row["id"],
        "name": row["name"],
        "items": [
            {
                "id": item["id"],
                "word": item["word"],
                "translation": item["translation"],
                "phonetic": item["phonetic"],
                "cefr": item["cefr"],
                "example": item["example"],
            }
            for item in rows
        ],
        "total": total,
        "page": page,
        "pageSize": page_size,
        "hasMore": offset + len(rows) < total,
    }


# ---------------------------------------------------------------------------
# 删除
# ---------------------------------------------------------------------------

def delete_wordlist(user_id: str, list_id: str) -> dict:
    """删除词表与全部条目（显式先删子表；FK 级联是第二道保险）。

    只删词表数据；已加入收藏/复习的词状态（``word_states``）不受影响。
    词表不存在或不属于当前用户 → :class:`WordlistNotFound`。
    """
    user_id = _require_user_id(user_id)
    if not isinstance(list_id, str) or not list_id.strip():
        raise WordlistNotFound("词表不存在。")
    list_id = list_id.strip()

    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT 1 FROM user_wordlists WHERE id = ? AND user_id = ?",
            (list_id, user_id),
        ).fetchone()
        if row is None:
            conn.rollback()
            raise WordlistNotFound("词表不存在。")
        conn.execute(
            "DELETE FROM user_wordlist_items WHERE list_id = ?", (list_id,)
        )
        conn.execute("DELETE FROM user_wordlists WHERE id = ?", (list_id,))
        conn.commit()
    except sqlite3.OperationalError as exc:
        conn.rollback()
        _translate_db_error(exc)
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return {"deleted": True}


# ---------------------------------------------------------------------------
# 重命名
# ---------------------------------------------------------------------------

def rename_wordlist(user_id: str, list_id: str, name) -> dict:
    """重命名词表；返回 ``{"list": {id,name,itemCount,createdAt}}``。

    - ``name`` 走 :func:`normalize_name`：空/非字符串/>80 字符 → 400；
    - 同用户重名 → :class:`WordlistValidationError`（400）；改成当前同名
      视为成功（幂等，不触发唯一约束）；
    - 词表不存在或不属于当前用户 → :class:`WordlistNotFound`（404）；
    - 只改 ``name``，不动条目与 ``created_at``。
    """
    user_id = _require_user_id(user_id)
    new_name = normalize_name(name)
    if not isinstance(list_id, str) or not list_id.strip():
        raise WordlistNotFound("词表不存在。")
    list_id = list_id.strip()

    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT id, name, item_count, created_at FROM user_wordlists "
            "WHERE id = ? AND user_id = ?",
            (list_id, user_id),
        ).fetchone()
        if row is None:
            raise WordlistNotFound("词表不存在。")
        if new_name != row["name"]:
            duplicate = conn.execute(
                "SELECT 1 FROM user_wordlists "
                "WHERE user_id = ? AND name = ? AND id <> ?",
                (user_id, new_name, list_id),
            ).fetchone()
            if duplicate is not None:
                raise WordlistValidationError(f"同名词表已存在：{new_name}")
            conn.execute(
                "UPDATE user_wordlists SET name = ? WHERE id = ? AND user_id = ?",
                (new_name, list_id, user_id),
            )
        conn.commit()
    except sqlite3.IntegrityError as exc:
        # 先查后写之间被并发改名抢先时，唯一约束兜底。
        conn.rollback()
        raise WordlistValidationError(f"同名词表已存在：{new_name}") from exc
    except sqlite3.OperationalError as exc:
        conn.rollback()
        _translate_db_error(exc)
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return {
        "list": {
            "id": row["id"],
            "name": new_name,
            "itemCount": int(row["item_count"] or 0),
            "createdAt": int(row["created_at"] or 0),
        }
    }


# ---------------------------------------------------------------------------
# 批量删除条目
# ---------------------------------------------------------------------------

def _require_item_ids(item_ids) -> list[str]:
    """校验 ``itemIds``：1–500 个非空字符串；同 id 去重（保留首次顺序）。

    去重后仍按「原始个数」判 1–500（一次请求最多 500 个 id，重复不放大配额）。
    非法 → :class:`WordlistValidationError`（400）。
    """
    if item_ids is None:
        raise WordlistValidationError("itemIds 不能为空。")
    if not isinstance(item_ids, (list, tuple)):
        raise WordlistValidationError("itemIds 必须是数组。")
    if not item_ids:
        raise WordlistValidationError("itemIds 不能为空。")
    if len(item_ids) > MAX_DELETE_ITEMS:
        raise WordlistValidationError(
            f"单次最多删除 {MAX_DELETE_ITEMS} 个词条（收到 {len(item_ids)} 个）。"
        )
    unique: list[str] = []
    seen: set[str] = set()
    for raw in item_ids:
        if not isinstance(raw, str) or not raw.strip():
            raise WordlistValidationError("itemIds 必须是非空字符串数组。")
        item_id = raw.strip()
        if item_id not in seen:
            seen.add(item_id)
            unique.append(item_id)
    return unique


def delete_wordlist_items(user_id: str, list_id: str, item_ids) -> dict:
    """按 id 批量删除词表条目（整笔事务），并同步 ``item_count``。

    - 词表不存在或不属于当前用户 → :class:`WordlistNotFound`（404）；
    - ``itemIds`` 1–500 个且**全部属于该词表**，否则 400 且整笔不删；不区分
      「不存在」与「属于别的词表」，避免泄露其它词表的存在性；
    - 删除后重新 ``COUNT(*)`` 回写 ``item_count``（不信 ``旧值 - N``）；
    - 返回 ``{status:"ok",deleted:N,itemCount:M}``；删到空表时词表仍保留。
    """
    user_id = _require_user_id(user_id)
    item_ids = _require_item_ids(item_ids)
    if not isinstance(list_id, str) or not list_id.strip():
        raise WordlistNotFound("词表不存在。")
    list_id = list_id.strip()

    placeholders = ",".join("?" for _ in item_ids)
    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT 1 FROM user_wordlists WHERE id = ? AND user_id = ?",
            (list_id, user_id),
        ).fetchone()
        if row is None:
            raise WordlistNotFound("词表不存在。")
        found = {
            item["id"]
            for item in conn.execute(
                "SELECT id FROM user_wordlist_items "
                f"WHERE list_id = ? AND id IN ({placeholders})",
                (list_id, *item_ids),
            )
        }
        if len(found) != len(item_ids):
            raise WordlistValidationError(
                f"有 {len(item_ids) - len(found)} 个词条不存在或不属于该词表"
                "（整笔未删除）。"
            )
        conn.execute(
            "DELETE FROM user_wordlist_items "
            f"WHERE list_id = ? AND id IN ({placeholders})",
            (list_id, *item_ids),
        )
        item_count = int(
            conn.execute(
                "SELECT COUNT(*) AS n FROM user_wordlist_items WHERE list_id = ?",
                (list_id,),
            ).fetchone()["n"]
            or 0
        )
        conn.execute(
            "UPDATE user_wordlists SET item_count = ? WHERE id = ? AND user_id = ?",
            (item_count, list_id, user_id),
        )
        conn.commit()
    except sqlite3.OperationalError as exc:
        conn.rollback()
        _translate_db_error(exc)
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return {"status": "ok", "deleted": len(item_ids), "itemCount": item_count}
