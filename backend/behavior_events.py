"""学习行为埋点写入层（CEFR M2 #7：lookup / replay / rate / visibility）。

四类事件复用现有 append-only 的 ``learning_events`` 表（不新建表）：

- ``dict_lookup``：打开词查/点词。只存规范化后的 word/lemma + 来源 + 内容
  引用；**绝不存 context / 句子 / 用户自由文本**。
- ``video_replay``：回看/拖动回退。只接受 ``toSeconds < fromSeconds``（正常
  前进不上报），method 区分点击/键盘/循环/seek。
- ``playback_rate``：倍速变化（fromRate → toRate）。
- ``tab_visibility``：页面 hidden/visible；只存匿名 sessionId 与可见秒数，
  不存页面内容。

写入约束（与 ``reports.record_watch_events`` 同一套口径）：

- 单批 **最多 20 条**；任一条非法 → 整批 400，不写半批；
- ``eventId`` 幂等：迁移 0017 的
  ``ux_learning_events_user_type_client(user_id, event_type, client_event_id)``
  部分唯一索引 + ``INSERT OR IGNORE``；
- ``dict_lookup`` 同一归属下同一 word **60 秒内去重**（服务端兜底；前端也做
  了一层节流）；
- 幂等键/字段长度/数值范围在落库前全部校验，payload 只由白名单字段重建；
- 表/列/索引缺失 → ``BehaviorUnavailable``（路由 503，提示先跑迁移）；
- 前端失败静默：本模块的写失败只影响事件，不会阻断学习主流程。

实现同步（标准库 sqlite3，与 reports.py 一致）；单条事件价值低、批量小，
不开异步线程池。
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import sqlite3
import time
import unicodedata
from typing import Iterable

import config
import events

logger = logging.getLogger("linguatrek.behavior_events")

MAX_EVENTS_PER_BATCH = 20
MAX_WORD_CHARS = 64
MAX_CONTENT_REF_CHARS = 200
MAX_CLIENT_EVENT_ID_CHARS = 128
MAX_SESSION_ID_CHARS = 128
MAX_RAW_EVENT_CHARS = 4096
MAX_SECONDS = 86_400.0
MIN_RATE = 0.25
MAX_RATE = 4.0
FUTURE_TOLERANCE_MS = 5 * 60 * 1000
DEDUP_WINDOW_MS = 60_000
DEDUP_LOOKBACK_ROWS = 200

BEHAVIOR_EVENT_TYPES = (
    "dict_lookup",
    "video_replay",
    "playback_rate",
    "tab_visibility",
)

DICT_SOURCES = ("transcript", "reader", "book", "sentence", "other")
REPLAY_METHODS = ("click", "keyboard", "loop", "seek")
VISIBILITY_STATES = ("hidden", "visible")

_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9._:-]+$")
_INSERT_SQL = (
    "INSERT OR IGNORE INTO learning_events "
    "(user_id, device_id, session_id, event_type, content_ref, payload, "
    "occurred_at, created_at, pseudonym_id, client_event_id) "
    "VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)"
)
_REQUIRED_INDEX = "ux_learning_events_user_type_client"


class BehaviorError(Exception):
    """行为事件模块的领域错误基类。"""


class InvalidBehaviorEvents(BehaviorError):
    """事件批次不合法（HTTP 400）；消息带 events[i] 下标。"""


class BehaviorUnavailable(BehaviorError):
    """事件表/列/索引未迁移或库不可写（HTTP 503）。"""


# ---------------------------------------------------------------------------
# 时钟 / 连接
# ---------------------------------------------------------------------------

def now_ms() -> int:
    """服务端当前毫秒时间戳（测试 monkeypatch 这里注入时钟）。"""
    return int(time.time() * 1000)


def _db_path() -> str:
    return config.AUTH_DB_PATH


def _connect() -> sqlite3.Connection:
    path = _db_path()
    if not os.path.exists(path):
        raise BehaviorUnavailable(
            f"数据库文件不存在：{path}（先运行 alembic upgrade head）"
        )
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _table_names(conn: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def _require_schema(conn: sqlite3.Connection) -> None:
    """确认 0017 已迁移：表在、幂等键列在、部分唯一索引在。"""
    if "learning_events" not in _table_names(conn):
        raise BehaviorUnavailable(
            "数据库缺少 learning_events 表（先运行 alembic upgrade head，"
            "0017_behavior_events）。"
        )
    columns = {
        row[1] for row in conn.execute("PRAGMA table_info(learning_events)")
    }
    if "client_event_id" not in columns:
        raise BehaviorUnavailable(
            "learning_events 缺少 client_event_id 列（先运行 alembic upgrade head，"
            "0017_behavior_events）。"
        )
    indexes = {
        row[1] for row in conn.execute("PRAGMA index_list(learning_events)")
    }
    if _REQUIRED_INDEX not in indexes:
        raise BehaviorUnavailable(
            "learning_events 缺少幂等索引 ux_learning_events_user_type_client"
            "（先运行 alembic upgrade head，0017_behavior_events）。"
        )


# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------

def _first(mapping: dict, *keys: str):
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return None


def _error(index: int, message: str) -> InvalidBehaviorEvents:
    return InvalidBehaviorEvents(f"events[{index}]：{message}")


def _as_text(
    value,
    index: int,
    field: str,
    *,
    max_length: int,
    pattern: re.Pattern[str] | None = None,
) -> str:
    if not isinstance(value, str):
        raise _error(index, f"{field} 必须是字符串。")
    text = value.strip()
    if not text:
        raise _error(index, f"{field} 不能为空。")
    if len(text) > max_length:
        raise _error(index, f"{field} 太长（最多 {max_length} 字符）。")
    if "\x00" in text or any(ord(char) < 32 for char in text):
        raise _error(index, f"{field} 不能包含控制字符。")
    if pattern is not None and not pattern.match(text):
        raise _error(index, f"{field} 含非法字符。")
    return text


def _as_id(value, index: int, field: str, *, max_length: int) -> str:
    return _as_text(
        value, index, field, max_length=max_length, pattern=_SAFE_ID_RE
    )


def _as_content_ref(value, index: int) -> str:
    text = _as_text(
        value,
        index,
        "contentRef",
        max_length=MAX_CONTENT_REF_CHARS,
    )
    if "\\" in text or any(char.isspace() for char in text):
        raise _error(index, "contentRef 不能包含空白或路径分隔符。")
    return text


def _as_word(value, index: int, field: str) -> str:
    text = _as_text(value, index, field, max_length=MAX_WORD_CHARS)
    # 只存可检索的规范化词形：折叠空白、小写；NFC 防止同形不同码点。
    text = unicodedata.normalize("NFC", text)
    return re.sub(r"\s+", " ", text).strip().lower()


def _as_number(value, index: int, field: str, *, minimum: float, maximum: float) -> float:
    if value is None:
        raise _error(index, f"缺少 {field}。")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _error(index, f"{field} 必须是数字。")
    number = float(value)
    if not math.isfinite(number):
        raise _error(index, f"{field} 必须是有限数字。")
    if number < minimum or number > maximum:
        raise _error(index, f"{field} 必须在 {minimum}–{maximum} 之间。")
    return number


def _as_seconds(value, index: int, field: str) -> float:
    return _as_number(value, index, field, minimum=0.0, maximum=MAX_SECONDS)


def _as_int(value, index: int, field: str) -> int:
    if value is None:
        raise _error(index, f"缺少 {field}。")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _error(index, f"{field} 必须是整数毫秒时间戳。")
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise _error(index, f"{field} 必须是整数毫秒时间戳。")
    return int(value)


def declared_event_type(raw) -> str | None:
    """读事件的声明类型（用于路由分流）；不是对象/没有 type 返回 None。"""
    if not isinstance(raw, dict):
        return None
    value = _first(raw, "type", "eventType")
    return value.strip() if isinstance(value, str) and value.strip() else None


def _normalize_event(raw, index: int, now_value: int) -> dict:
    """校验单条行为事件 → 可落库字段（payload 由白名单字段重建）。"""
    if not isinstance(raw, dict):
        raise _error(index, "必须是对象。")

    try:
        raw_size = len(json.dumps(raw, ensure_ascii=False, separators=(",", ":")))
    except (TypeError, ValueError) as exc:
        raise _error(index, "必须是可 JSON 序列化的对象。") from exc
    if raw_size > MAX_RAW_EVENT_CHARS:
        raise _error(index, f"事件体太大（最多 {MAX_RAW_EVENT_CHARS} 字符）。")

    event_type = declared_event_type(raw)
    if event_type not in BEHAVIOR_EVENT_TYPES:
        raise _error(
            index,
            "type 只能是 dict_lookup / video_replay / playback_rate / tab_visibility。",
        )

    client_event_id = _as_id(
        _first(raw, "eventId", "clientEventId", "client_event_id"),
        index,
        "eventId",
        max_length=MAX_CLIENT_EVENT_ID_CHARS,
    )

    session_raw = _first(raw, "sessionId", "session_id")
    session_id = (
        None
        if session_raw is None
        else _as_id(
            session_raw, index, "sessionId", max_length=MAX_SESSION_ID_CHARS
        )
    )

    occurred_raw = _first(raw, "occurredAt", "occurred_at")
    occurred_at = now_value if occurred_raw is None else _as_int(
        occurred_raw, index, "occurredAt"
    )
    if occurred_at < 0:
        raise _error(index, "occurredAt 不能是负数。")
    if occurred_at > now_value + FUTURE_TOLERANCE_MS:
        raise _error(index, "occurredAt 不能比服务端时间晚超过 5 分钟。")

    content_raw = _first(raw, "contentRef", "content_ref")
    content_ref: str | None = None
    if content_raw is not None:
        content_ref = _as_content_ref(content_raw, index)

    if event_type == "dict_lookup":
        word = _as_word(_first(raw, "word"), index, "word")
        lemma_raw = _first(raw, "lemma")
        lemma = None if lemma_raw is None else _as_word(lemma_raw, index, "lemma")
        source = _first(raw, "source")
        if source is None:
            source = "other"
        if not isinstance(source, str) or source not in DICT_SOURCES:
            raise _error(
                index, "source 只能是 " + " / ".join(DICT_SOURCES) + "。"
            )
        payload = {"word": word, "source": source}
        if lemma is not None:
            payload["lemma"] = lemma
    elif event_type == "video_replay":
        if content_ref is None:
            raise _error(index, "video_replay 缺少 contentRef。")
        from_seconds = _as_seconds(
            _first(raw, "fromSeconds", "from_seconds"), index, "fromSeconds"
        )
        to_seconds = _as_seconds(
            _first(raw, "toSeconds", "to_seconds"), index, "toSeconds"
        )
        # 只记回退/重复观看：正常前进（to >= from）不是回看事件。
        if to_seconds >= from_seconds:
            raise _error(index, "video_replay 只接受回退（toSeconds < fromSeconds）。")
        method = _first(raw, "method")
        if method is None:
            method = "seek"
        if not isinstance(method, str) or method not in REPLAY_METHODS:
            raise _error(
                index, "method 只能是 " + " / ".join(REPLAY_METHODS) + "。"
            )
        payload = {
            "fromSeconds": round(from_seconds, 3),
            "toSeconds": round(to_seconds, 3),
            "method": method,
        }
    elif event_type == "playback_rate":
        if content_ref is None:
            raise _error(index, "playback_rate 缺少 contentRef。")
        from_rate = _as_number(
            _first(raw, "fromRate", "from_rate"),
            index,
            "fromRate",
            minimum=MIN_RATE,
            maximum=MAX_RATE,
        )
        to_rate = _as_number(
            _first(raw, "toRate", "to_rate"),
            index,
            "toRate",
            minimum=MIN_RATE,
            maximum=MAX_RATE,
        )
        if abs(to_rate - from_rate) < 1e-6:
            raise _error(index, "倍速没有变化（fromRate == toRate）。")
        payload = {"fromRate": from_rate, "toRate": to_rate}
    else:  # tab_visibility
        state = _first(raw, "state")
        if not isinstance(state, str) or state not in VISIBILITY_STATES:
            raise _error(
                index, "state 只能是 " + " / ".join(VISIBILITY_STATES) + "。"
            )
        if session_id is None:
            raise _error(index, "tab_visibility 缺少 sessionId。")
        visible_seconds = _as_seconds(
            _first(raw, "visibleSeconds", "visible_seconds"),
            index,
            "visibleSeconds",
        )
        payload = {
            "state": state,
            "visibleSeconds": round(visible_seconds, 1),
        }

    return {
        "event_type": event_type,
        "client_event_id": client_event_id,
        "session_id": session_id,
        "content_ref": content_ref,
        "payload": payload,
        "occurred_at": occurred_at,
    }


def normalize_behavior_events(
    raw_events: Iterable, *, now: int | None = None
) -> list[dict]:
    """批量校验（路由在写任何一张表之前先调用，避免混合批只写一半）。"""
    now_value = now_ms() if now is None else int(now)
    if not isinstance(raw_events, list):
        raise InvalidBehaviorEvents("events 必须是数组。")
    if len(raw_events) > MAX_EVENTS_PER_BATCH:
        raise InvalidBehaviorEvents(
            f"单次最多上报 {MAX_EVENTS_PER_BATCH} 条行为事件"
            f"（收到 {len(raw_events)} 条）。"
        )
    return [
        _normalize_event(event, index, now_value)
        for index, event in enumerate(raw_events)
    ]


# ---------------------------------------------------------------------------
# 写入
# ---------------------------------------------------------------------------

def _payload_json(payload: dict) -> str:
    return json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )


def _recent_lookup_words(
    conn: sqlite3.Connection, identity: str, now_value: int
) -> set[str]:
    """取 60s 内该归属已落的 dict_lookup word（服务端去重兜底）。"""
    rows = conn.execute(
        "SELECT payload FROM learning_events "
        "WHERE user_id = ? AND event_type = 'dict_lookup' "
        "AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?",
        (identity, now_value - DEDUP_WINDOW_MS, DEDUP_LOOKBACK_ROWS),
    ).fetchall()
    words: set[str] = set()
    for row in rows:
        try:
            payload = json.loads(row["payload"]) if row["payload"] else None
        except (TypeError, ValueError):
            continue
        if isinstance(payload, dict) and isinstance(payload.get("word"), str):
            words.add(payload["word"].lower())
    return words


def _existing_event_ids(
    conn: sqlite3.Connection, identity: str, normalized_events: list[dict]
) -> set[tuple[str, str]]:
    """本批 eventId 在该归属下是否已存在（按 (event_type, eventId) 判重）。"""
    pairs = {
        (item["event_type"], item["client_event_id"])
        for item in normalized_events
    }
    if not pairs:
        return set()
    event_types = sorted({event_type for event_type, _ in pairs})
    placeholders = ", ".join("?" for _ in event_types)
    ids = sorted({event_id for _, event_id in pairs})
    id_placeholders = ", ".join("?" for _ in ids)
    rows = conn.execute(
        "SELECT event_type, client_event_id FROM learning_events "
        f"WHERE user_id = ? AND event_type IN ({placeholders}) "
        f"AND client_event_id IN ({id_placeholders})",
        (identity, *event_types, *ids),
    ).fetchall()
    return {
        (row["event_type"], row["client_event_id"])
        for row in rows
        if row["client_event_id"]
    }


def record_behavior_events(
    identity: str,
    normalized_events: list[dict],
    *,
    now: int | None = None,
) -> dict:
    """写入已校验的行为事件；返回 ``{received, accepted, duplicated, deduplicated}``。

    ``normalized_events`` 必须来自 :func:`normalize_behavior_events`；直接传
    原始 dict 会 KeyError（保持"先全量校验、再开事务"的调用约定）。
    """
    if not isinstance(identity, str) or not identity.strip():
        raise InvalidBehaviorEvents("缺少上报身份。")
    identity = identity.strip()
    now_value = now_ms() if now is None else int(now)

    received = len(normalized_events)
    accepted = 0
    duplicated = 0
    deduplicated = 0

    conn = _connect()
    try:
        _require_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        recent_words = _recent_lookup_words(conn, identity, now_value)
        existing_ids = _existing_event_ids(conn, identity, normalized_events)
        pseudo = events.pseudonym_for(identity)
        created = events.now_ms()
        for item in normalized_events:
            id_key = (item["event_type"], item["client_event_id"])
            # 幂等优先于词去重：同 eventId 的重试计 duplicated，不计 deduplicated。
            if id_key in existing_ids:
                duplicated += 1
                continue
            if item["event_type"] == "dict_lookup":
                word = item["payload"]["word"]
                if word in recent_words:
                    deduplicated += 1
                    continue
            cursor = conn.execute(
                _INSERT_SQL,
                (
                    identity,
                    item["session_id"],
                    item["event_type"],
                    item["content_ref"],
                    _payload_json(item["payload"]),
                    item["occurred_at"],
                    created,
                    pseudo,
                    item["client_event_id"],
                ),
            )
            if cursor.rowcount:
                accepted += 1
                existing_ids.add(id_key)
                if item["event_type"] == "dict_lookup":
                    recent_words.add(item["payload"]["word"])
            else:
                duplicated += 1
        conn.commit()
    except sqlite3.OperationalError as exc:
        conn.rollback()
        raise BehaviorUnavailable(
            f"行为事件暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return {
        "received": received,
        "accepted": accepted,
        "duplicated": duplicated,
        "deduplicated": deduplicated,
    }


# ---------------------------------------------------------------------------
# 管理员只读查询
# ---------------------------------------------------------------------------

def list_recent_events(
    *,
    event_type: str | None = None,
    limit: int = 50,
    since_ms: int | None = None,
) -> dict:
    """管理员只读：最近事件（已脱敏，不返回 user_id / device_id）。"""
    if event_type is not None:
        allowed = set(BEHAVIOR_EVENT_TYPES) | set(events.KNOWN_EVENT_TYPES)
        if event_type not in allowed:
            raise InvalidBehaviorEvents("type 不是已知事件类型。")
    limit = max(1, min(int(limit), 200))
    rows = events.query_events(
        event_type=event_type, since_ms=since_ms, limit=limit
    )
    items = []
    for row in rows:
        items.append(
            {
                "id": row["id"],
                "type": row["event_type"],
                "contentRef": row["content_ref"],
                "payload": row["payload"],
                "occurredAt": row["occurred_at"],
                "createdAt": row["created_at"],
                "sessionId": row["session_id"],
                "pseudonymId": row["pseudonym_id"],
            }
        )
    return {"count": len(items), "events": items}
