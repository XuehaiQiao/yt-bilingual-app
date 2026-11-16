"""周报聚合与观看事件上报（计划书 §13.2 M5 / §15）。

本模块只做两件事：

1. **收事件**：``record_watch_events`` 把前端批量上报的 ``watch`` 事件写进
   ``watch_events``（幂等键 ``(user_id, client_event_id)``），返回
   ``accepted`` / ``duplicated``。校验全部在落库前完成，任一条非法则整批
   **不写**（400），避免半批数据。
2. **算周报**：``week_report`` 用 SQL 聚合本周事实，生成「3 个数字 + 1 句
   事实 + 1 个下一步 + 1 段证据」，并把首份结果快照写进 ``weekly_reports``
   （``UNIQUE(user_id, week_start)`` + ``INSERT OR IGNORE``，同周只写一次）。

设计口径（与 specs/015-weekly-report 一致）：

- **周界 = UTC 周一 00:00**，区间左闭右开 ``[week_start, week_start + 7d)``；
  请求传的任意日期先归一到所在周的周一。
- 归属键 ``identity``：登录用户为 ``users.id``，游客为 ``guest:<sha256>``
  （``guest.guest_id()``）。游客事件写 ``watch_events.user_id`` 为游客身份、
  ``guest_hash`` 为 sha256，因此游客也能周报且不丢幂等性。
- 三个数字：被动学习分钟（``watch_events.watched_seconds`` 求和）、复习
  词数（``review_logs`` distinct lemma）、理解题正确率（``attempts``）；
  没有作答时正确率是 **null**，不是 0。
- 数字全由 SQL 算，叙述也由规则模板生成，**不调用模型**（计划书：数字用
  SQL 算，模型只写叙述；M5 后端先不做模型叙述）。
- 证据优先取本周**答错题**的 evidence block（带字幕句子；读当前身份的
  字幕缓存，读不到句子时句子为 null，但时间点仍返回）；没有错题则取最近
  一次观看，按进度截 **5 秒**回看窗口。
- ``streakDays``：有任意 watch / quiz / review 的 UTC 日连续天数；今天没有
  记录时从昨天往回数（与 ``srs.get_stats`` 的连续天数口径一致），最多回溯
  400 天。
- 表缺失（未跑 ``0008_weekly_report``）抛 :class:`ReportUnavailable`，路由
  转 **503**；运行时不建表。

时钟可注入：测试 monkeypatch :func:`now_ms`，路由每次请求调用一次。
"""
from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import time
from datetime import date, datetime, timedelta, timezone

import config
import guest
import languages
import storage

MS_PER_DAY = 86_400_000
MAX_EVENTS_PER_BATCH = 50
MAX_EVENT_SECONDS = 86_400
MAX_CONTENT_REF_LENGTH = 200
MAX_CLIENT_EVENT_ID_LENGTH = 128
FUTURE_TOLERANCE_MS = 5 * 60 * 1000
STREAK_LOOKBACK_DAYS = 400
REPORT_VERSION = 1
DUE_STATES = ("learning", "review", "relearning")

KINDS = ("video", "local_show")

# 与 quiz.py 的 contentRef 规则保持一致：video 是 videoId；local_show 接受
# show_id-S01E01 / show_id_S01E01 / show_id/S01E01，统一成 <show>-SxxEyy。
_LOCAL_SHOW_REF_RE = re.compile(
    r"^(?P<show>[A-Za-z0-9][A-Za-z0-9_.-]*?)[-_/]"
    r"S(?P<season>\d{1,2})E(?P<episode>\d{1,3})$",
    re.IGNORECASE,
)
_CANONICAL_LOCAL_REF_RE = re.compile(
    r"^(?P<show>[A-Za-z0-9][A-Za-z0-9_.-]*)-S(?P<season>\d{2,3})E(?P<episode>\d{2,3})$"
)
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

_INSERT_WATCH_SQL = (
    "INSERT OR IGNORE INTO watch_events "
    "(user_id, guest_hash, content_ref, kind, target_lang, watched_seconds, "
    "position_seconds, occurred_at, client_event_id) "
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


# ---------------------------------------------------------------------------
# 异常（路由映射：400 / 503）
# ---------------------------------------------------------------------------

class ReportError(Exception):
    """周报/事件模块的领域错误基类。"""


class InvalidEvents(ReportError):
    """事件批次不合法（400）；消息直接给用户看，带 events[i] 下标。"""


class InvalidWeekStart(ReportError):
    """weekStart 不是合法 YYYY-MM-DD（400）。"""


class ReportUnavailable(ReportError):
    """表未迁移 / 库不可写（503）。"""


# ---------------------------------------------------------------------------
# 时钟 / 身份 / 连接
# ---------------------------------------------------------------------------

def now_ms() -> int:
    """服务端当前毫秒 UTC（测试 monkeypatch 这里注入时钟）。"""
    return int(time.time() * 1000)


def _coerce_ms(value) -> int:
    """接受毫秒整数或 aware datetime，统一成毫秒整数。"""
    if value is None:
        return now_ms()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return int(round(value.timestamp() * 1000))
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ReportError(f"非法时间戳：{value!r}") from exc


def _db_path() -> str:
    return config.AUTH_DB_PATH


def _connect() -> sqlite3.Connection:
    """连库（不建库、不建目录：schema 只由迁移创建）。"""
    path = _db_path()
    if not os.path.exists(path):
        raise ReportUnavailable(
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


def _require_tables(conn: sqlite3.Connection, tables: tuple[str, ...]) -> None:
    existing = _table_names(conn)
    missing = [table for table in tables if table not in existing]
    if missing:
        raise ReportUnavailable(
            f"数据库缺少表 {missing}（先运行 alembic upgrade head，"
            "周报需要 0008_weekly_report 及更早迁移）。"
        )


def _raise_unavailable(exc: sqlite3.OperationalError) -> None:
    """把 SQLite 的表/列缺失翻成 503；其它 OperationalError 也按不可用处理。"""
    raise ReportUnavailable(
        f"周报暂时不可用：{exc}（先运行 alembic upgrade head）"
    ) from exc


# ---------------------------------------------------------------------------
# 事件校验
# ---------------------------------------------------------------------------

def _first(mapping: dict, *keys: str):
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return None


def _event_error(index: int, message: str) -> InvalidEvents:
    return InvalidEvents(f"events[{index}]：{message}")


def _as_text(value, index: int, field: str, *, max_length: int) -> str:
    if not isinstance(value, str):
        raise _event_error(index, f"{field} 必须是字符串。")
    text = value.strip()
    if not text:
        raise _event_error(index, f"{field} 不能为空。")
    if len(text) > max_length:
        raise _event_error(index, f"{field} 太长（最多 {max_length} 字符）。")
    if "\x00" in text:
        raise _event_error(index, f"{field} 不能包含 NUL 字符。")
    return text


def _as_seconds(value, index: int, field: str) -> int:
    """秒数：接受 0–86400 的数字，落库取整；bool/NaN/负数/超大一律 400。"""
    if value is None:
        raise _event_error(index, f"缺少 {field}。")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _event_error(index, f"{field} 必须是数字。")
    if isinstance(value, float) and not math.isfinite(value):
        raise _event_error(index, f"{field} 必须是有限数字。")
    if value < 0 or value > MAX_EVENT_SECONDS:
        raise _event_error(
            index, f"{field} 必须在 0–{MAX_EVENT_SECONDS} 秒之间。"
        )
    return int(round(value))


def _as_int(value, index: int, field: str) -> int:
    if value is None:
        raise _event_error(index, f"缺少 {field}。")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _event_error(index, f"{field} 必须是整数毫秒时间戳。")
    if isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise _event_error(index, f"{field} 必须是整数毫秒时间戳。")
    return int(value)


def _normalize_content_ref(kind: str, raw, index: int) -> str:
    """校验并规范化 contentRef（规则与 quiz 一致）。"""
    if not isinstance(raw, str):
        raise _event_error(index, "contentRef 不能为空。")
    ref = raw.strip()
    if not ref:
        raise _event_error(index, "contentRef 不能为空。")
    if len(ref) > MAX_CONTENT_REF_LENGTH:
        raise _event_error(
            index, f"contentRef 太长（最多 {MAX_CONTENT_REF_LENGTH} 字符）。"
        )
    if "\x00" in ref or "\\" in ref:
        raise _event_error(index, "contentRef 不能包含路径分隔符。")

    if kind == "video":
        if "/" in ref:
            raise _event_error(index, "video 的 contentRef 不能包含路径分隔符。")
        return ref

    match = _LOCAL_SHOW_REF_RE.match(ref)
    if not match:
        raise _event_error(
            index,
            "local_show 的 contentRef 需要形如 <show_id>-S01E01"
            "（也接受 _S01E01、/S01E01 写法）。",
        )
    show = match.group("show")
    season = int(match.group("season"))
    episode = int(match.group("episode"))
    if not show or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", show):
        raise _event_error(index, "contentRef 的 show_id 含非法字符。")
    return f"{show}-S{season:02d}E{episode:02d}"


def _normalize_event(raw, index: int, now_value: int) -> dict:
    """校验单条事件 → 可以直接落库的字段字典。"""
    if not isinstance(raw, dict):
        raise _event_error(index, "必须是对象。")

    event_type = _first(raw, "type", "eventType")
    if event_type != "watch":
        raise _event_error(index, "type 目前只支持 'watch'。")

    kind = _first(raw, "kind")
    if kind not in KINDS:
        raise _event_error(index, "kind 只能是 video 或 local_show。")

    content_ref = _normalize_content_ref(
        kind, _first(raw, "contentRef", "content_ref"), index
    )
    client_event_id = _as_text(
        _first(raw, "clientEventId", "client_event_id"),
        index,
        "clientEventId",
        max_length=MAX_CLIENT_EVENT_ID_LENGTH,
    )

    raw_lang = _first(raw, "targetLang", "target_lang")
    try:
        target_lang = languages.resolve_target_lang(raw_lang)
    except languages.UnsupportedLanguage as exc:
        raise _event_error(index, str(exc)) from exc

    watched_seconds = _as_seconds(
        _first(raw, "watchedSeconds", "watched_seconds"),
        index,
        "watchedSeconds",
    )
    position_raw = _first(raw, "positionSeconds", "position_seconds")
    position_seconds = (
        0 if position_raw is None else _as_seconds(position_raw, index, "positionSeconds")
    )
    occurred_raw = _first(raw, "occurredAt", "occurred_at")
    occurred_at = _as_int(occurred_raw, index, "occurredAt")
    if occurred_at < 0:
        raise _event_error(index, "occurredAt 不能是负数。")
    if occurred_at > now_value + FUTURE_TOLERANCE_MS:
        raise _event_error(index, "occurredAt 不能比服务端时间晚超过 5 分钟。")

    return {
        "content_ref": content_ref,
        "kind": kind,
        "target_lang": target_lang,
        "watched_seconds": watched_seconds,
        "position_seconds": position_seconds,
        "occurred_at": occurred_at,
        "client_event_id": client_event_id,
    }


# ---------------------------------------------------------------------------
# 事件写入
# ---------------------------------------------------------------------------

def normalize_watch_events(events, *, now=None) -> list[dict]:
    """校验 watch 批次但不写库（路由用于"先全量校验、再开事务"）。"""
    now_value = _coerce_ms(now)
    if not isinstance(events, list):
        raise InvalidEvents("events 必须是数组。")
    if len(events) > MAX_EVENTS_PER_BATCH:
        raise InvalidEvents(
            f"单次最多上报 {MAX_EVENTS_PER_BATCH} 条事件（收到 {len(events)} 条）。"
        )
    return [
        _normalize_event(event, index, now_value) for index, event in enumerate(events)
    ]


def write_watch_events(
    identity: str,
    guest_hash: str | None,
    normalized: list[dict],
) -> dict:
    """写入已校验的 watch 事件；返回 ``{received, accepted, duplicated}``。

    - 幂等：``UNIQUE(user_id, client_event_id)`` + ``INSERT OR IGNORE``，重复
      上报计入 ``duplicated``，不重复计数；
    - 表缺失 → :class:`ReportUnavailable`（路由 503）。
    """
    if not isinstance(identity, str) or not identity.strip():
        raise InvalidEvents("缺少上报身份。")
    identity = identity.strip()

    conn = _connect()
    try:
        _require_tables(conn, ("watch_events",))
        conn.execute("BEGIN IMMEDIATE")
        accepted = 0
        duplicated = 0
        for event in normalized:
            cursor = conn.execute(
                _INSERT_WATCH_SQL,
                (
                    identity,
                    guest_hash,
                    event["content_ref"],
                    event["kind"],
                    event["target_lang"],
                    event["watched_seconds"],
                    event["position_seconds"],
                    event["occurred_at"],
                    event["client_event_id"],
                ),
            )
            if cursor.rowcount:
                accepted += 1
            else:
                duplicated += 1
        conn.commit()
    except sqlite3.OperationalError as exc:
        conn.rollback()
        _raise_unavailable(exc)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return {
        "received": len(normalized),
        "accepted": accepted,
        "duplicated": duplicated,
    }


def record_watch_events(
    identity: str,
    guest_hash: str | None,
    events,
    *,
    now=None,
) -> dict:
    """批量写入 watch 事件；返回 ``{received, accepted, duplicated}``。

    - 最多 ``MAX_EVENTS_PER_BATCH`` 条；超限/任一条非法 → :class:`InvalidEvents`
      （整批不写）；
    - 幂等：``UNIQUE(user_id, client_event_id)`` + ``INSERT OR IGNORE``，重复
      上报计入 ``duplicated``，不重复计数；
    - 表缺失 → :class:`ReportUnavailable`（路由 503）。
    """
    if not isinstance(identity, str) or not identity.strip():
        raise InvalidEvents("缺少上报身份。")
    normalized = normalize_watch_events(events, now=now)
    return write_watch_events(identity.strip(), guest_hash, normalized)


# ---------------------------------------------------------------------------
# 周界
# ---------------------------------------------------------------------------

def _resolve_week_start(value, now_value: int) -> date:
    """weekStart（YYYY-MM-DD）→ 所在周周一；缺省取当前 UTC 周的周一。"""
    if value is None or (isinstance(value, str) and not value.strip()):
        raw_date = datetime.fromtimestamp(now_value / 1000, tz=timezone.utc).date()
    else:
        if not isinstance(value, str) or not _DATE_RE.match(value.strip()):
            raise InvalidWeekStart("weekStart 必须是 YYYY-MM-DD 格式的日期。")
        try:
            raw_date = date.fromisoformat(value.strip())
        except ValueError as exc:
            raise InvalidWeekStart("weekStart 不是合法日期。") from exc
    return raw_date - timedelta(days=raw_date.weekday())


def _date_to_ms(value: date) -> int:
    return int(
        datetime(value.year, value.month, value.day, tzinfo=timezone.utc).timestamp()
        * 1000
    )


# ---------------------------------------------------------------------------
# 聚合
# ---------------------------------------------------------------------------

def _watch_aggregate(
    conn: sqlite3.Connection, identity: str, start_ms: int, end_ms: int
) -> dict:
    row = conn.execute(
        "SELECT COALESCE(SUM(watched_seconds), 0) AS seconds, "
        "COUNT(DISTINCT CASE WHEN watched_seconds > 0 THEN content_ref END) "
        "AS watched_items, "
        "COUNT(DISTINCT CASE WHEN watched_seconds > 0 AND kind = 'video' "
        "THEN content_ref END) AS videos, "
        "COUNT(DISTINCT CASE WHEN watched_seconds > 0 AND kind = 'local_show' "
        "THEN content_ref END) AS shows "
        "FROM watch_events WHERE user_id = ? AND occurred_at >= ? AND occurred_at < ?",
        (identity, start_ms, end_ms),
    ).fetchone()
    return {
        "seconds": int(row["seconds"] or 0),
        "watched_items": int(row["watched_items"] or 0),
        "videos": int(row["videos"] or 0),
        "shows": int(row["shows"] or 0),
    }


def _attempt_aggregate(
    conn: sqlite3.Connection, identity: str, start_ms: int, end_ms: int
) -> dict:
    row = conn.execute(
        "SELECT COUNT(*) AS attempts, COALESCE(SUM(is_correct), 0) AS correct "
        "FROM attempts WHERE user_id = ? AND answered_at >= ? AND answered_at < ?",
        (identity, start_ms, end_ms),
    ).fetchone()
    return {
        "attempts": int(row["attempts"] or 0),
        "correct": int(row["correct"] or 0),
    }


def _review_aggregate(
    conn: sqlite3.Connection, identity: str, start_ms: int, end_ms: int
) -> dict:
    row = conn.execute(
        "SELECT COUNT(DISTINCT lemma) AS words, COUNT(*) AS reviews "
        "FROM review_logs WHERE user_id = ? AND reviewed_at >= ? AND reviewed_at < ?",
        (identity, start_ms, end_ms),
    ).fetchone()
    return {
        "words": int(row["words"] or 0),
        "reviews": int(row["reviews"] or 0),
    }


def _word_aggregate(
    conn: sqlite3.Connection,
    identity: str,
    start_ms: int,
    end_ms: int,
    now_value: int,
    reviewed_words: int,
) -> dict:
    new_row = conn.execute(
        "SELECT COUNT(DISTINCT lemma) AS new_words FROM word_states "
        "WHERE user_id = ? AND created_at >= ? AND created_at < ?",
        (identity, start_ms, end_ms),
    ).fetchone()
    # dueTomorrow = 到明天结束前所有该复习的词（含已到期未复习的），与
    # srs.get_stats 的 due_today 口径同源：只算 learning/review/relearning。
    today_start = (now_value // MS_PER_DAY) * MS_PER_DAY
    tomorrow_end = today_start + 2 * MS_PER_DAY
    placeholders = ", ".join("?" for _ in DUE_STATES)
    due_row = conn.execute(
        f"SELECT COUNT(*) AS due FROM word_states "
        f"WHERE user_id = ? AND state IN ({placeholders}) AND due_at < ?",
        (identity, *DUE_STATES, tomorrow_end),
    ).fetchone()
    return {
        "new": int(new_row["new_words"] or 0),
        "reviewed": reviewed_words,
        "due_tomorrow": int(due_row["due"] or 0),
    }


def _streak_days(
    conn: sqlite3.Connection, identity: str, now_value: int, tables: set[str]
) -> int:
    """有任意 watch/quiz/review 的 UTC 日连续天数（今天没有从昨天数）。"""
    cutoff = now_value - STREAK_LOOKBACK_DAYS * MS_PER_DAY
    days: set[int] = set()
    sources = (
        ("watch_events", "occurred_at"),
        ("attempts", "answered_at"),
        ("review_logs", "reviewed_at"),
    )
    for table, column in sources:
        if table not in tables:
            continue
        rows = conn.execute(
            f"SELECT DISTINCT CAST({column} / ? AS INTEGER) AS day "
            f"FROM {table} WHERE user_id = ? AND {column} >= ?",
            (MS_PER_DAY, identity, cutoff),
        ).fetchall()
        days.update(int(row["day"]) for row in rows)

    current_day = now_value // MS_PER_DAY
    cursor = current_day if current_day in days else current_day - 1
    streak = 0
    while cursor in days and streak < STREAK_LOOKBACK_DAYS:
        streak += 1
        cursor -= 1
    return streak


# ---------------------------------------------------------------------------
# 证据（错题 block / 最近观看）
# ---------------------------------------------------------------------------

def _history_root_for(identity: str) -> str | None:
    """按归属键找 history 根目录（只读，不创建目录）。"""
    guest_hash = guest.parse_guest_id(identity)
    if guest_hash:
        return guest.guest_history_dir(guest_hash)
    return os.path.join(storage.user_data_dir(identity), "history")


def _language_history_dir(identity: str, target_lang: str) -> str | None:
    root = _history_root_for(identity)
    if root is None:
        return None
    if target_lang == languages.DEFAULT_TARGET_LANG:
        return root
    return os.path.join(root, target_lang)


def _find_content_file(identity: str, kind: str, content_ref: str, target_lang: str):
    directory = _language_history_dir(identity, target_lang)
    if not directory or not os.path.isdir(directory):
        return None
    if kind == "video":
        suffix = f"_{content_ref}.json"
        try:
            names = os.listdir(directory)
        except OSError:
            return None
        for name in names:
            if name.endswith(suffix) and os.path.isfile(os.path.join(directory, name)):
                return os.path.join(directory, name)
        return None

    match = _CANONICAL_LOCAL_REF_RE.match(content_ref)
    if not match:
        return None
    filename = (
        f"{match.group('show')}_S{int(match.group('season')):02d}"
        f"E{int(match.group('episode')):02d}.json"
    )
    path = os.path.join(directory, filename)
    return path if os.path.isfile(path) else None


def _load_blocks(path: str | None) -> list[dict]:
    """读取字幕缓存里的 transcript 块（失败一律返回空列表，不影响周报）。"""
    if not path:
        return []
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
        return []
    transcript = payload.get("transcript") if isinstance(payload, dict) else None
    if not isinstance(transcript, list):
        return []

    blocks: list[dict] = []
    for raw in transcript:
        if not isinstance(raw, dict):
            continue
        text = raw.get("en_text") or raw.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        try:
            start_ms = int(round(float(raw.get("start")) * 1000))
        except (TypeError, ValueError):
            continue
        try:
            end_ms = int(round(float(raw.get("end")) * 1000))
        except (TypeError, ValueError):
            end_ms = start_ms
        if end_ms < start_ms:
            end_ms = start_ms
        blocks.append(
            {
                "id": str(raw.get("id")) if raw.get("id") is not None else None,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "sentence": text.strip(),
            }
        )
    return blocks


def _match_block(
    blocks: list[dict], block_id, at_ms: int | None
) -> dict | None:
    """按 block id 优先匹配；没有 id 时按时间点找包含它的块。"""
    if block_id is not None:
        wanted = str(block_id)
        for block in blocks:
            if block["id"] == wanted:
                return block
    if at_ms is not None:
        for block in blocks:
            if block["start_ms"] <= at_ms <= block["end_ms"]:
                return block
        nearest = None
        nearest_distance = None
        for block in blocks:
            distance = abs(block["start_ms"] - at_ms)
            if nearest_distance is None or distance < nearest_distance:
                nearest = block
                nearest_distance = distance
        if nearest is not None and nearest_distance is not None:
            if nearest_distance <= 1500:
                return nearest
    return None


def _resolve_block(
    identity: str,
    kind: str,
    content_ref: str,
    target_lang: str,
    *,
    block_id=None,
    at_ms: int | None = None,
) -> dict | None:
    path = _find_content_file(identity, kind, content_ref, target_lang)
    blocks = _load_blocks(path)
    if not blocks:
        return None
    return _match_block(blocks, block_id, at_ms)


def _seconds(value_ms) -> float | None:
    if value_ms is None:
        return None
    return round(int(value_ms) / 1000, 3)


def _public_block_id(value):
    """证据 block id 与理解题 API 保持一致：数字串返回 int，其余原样。"""
    if value is None:
        return None
    text = str(value)
    try:
        return int(text)
    except ValueError:
        return text


def _wrong_attempt_evidence(
    conn: sqlite3.Connection, identity: str, start_ms: int, end_ms: int
) -> dict | None:
    row = conn.execute(
        "SELECT a.id AS attempt_id, a.answered_at, q.id AS question_id, "
        "q.evidence_block_id, q.evidence_start, q.evidence_end, "
        "ci.content_ref, ci.kind, ci.target_lang "
        "FROM attempts a "
        "JOIN questions q ON q.id = a.question_id "
        "JOIN content_items ci ON ci.id = q.content_item_id "
        "AND ci.user_id = a.user_id "
        "WHERE a.user_id = ? AND a.answered_at >= ? AND a.answered_at < ? "
        "AND a.is_correct = 0 "
        "AND q.evidence_start IS NOT NULL AND q.evidence_end IS NOT NULL "
        "ORDER BY a.answered_at DESC, a.id DESC LIMIT 1",
        (identity, start_ms, end_ms),
    ).fetchone()
    if row is None:
        return None

    block_start = int(row["evidence_start"])
    block_end = int(row["evidence_end"])
    if block_end <= block_start:
        block_end = block_start + 1
    block = _resolve_block(
        identity,
        row["kind"],
        row["content_ref"],
        row["target_lang"],
        block_id=row["evidence_block_id"],
        at_ms=block_start,
    )
    return {
        "source": "quiz_wrong",
        "contentRef": row["content_ref"],
        "kind": row["kind"],
        "targetLang": row["target_lang"],
        "start": _seconds(block_start),
        "end": _seconds(block_end),
        "startMs": block_start,
        "endMs": block_end,
        "durationSeconds": round((block_end - block_start) / 1000, 3),
        "sentence": block["sentence"] if block else None,
        "blockId": _public_block_id(block["id"] if block else row["evidence_block_id"]),
        "questionId": row["question_id"],
        "attemptId": int(row["attempt_id"]),
        "answeredAt": int(row["answered_at"]),
    }


def _recent_watch_evidence(
    conn: sqlite3.Connection, identity: str, start_ms: int, end_ms: int
) -> dict | None:
    row = conn.execute(
        "SELECT content_ref, kind, target_lang, watched_seconds, "
        "position_seconds, occurred_at FROM watch_events "
        "WHERE user_id = ? AND occurred_at >= ? AND occurred_at < ? "
        "ORDER BY occurred_at DESC, id DESC LIMIT 1",
        (identity, start_ms, end_ms),
    ).fetchone()
    if row is None:
        return None

    position_ms = int(row["position_seconds"]) * 1000
    # 5 秒回看窗口：以离开时的进度为中心；开头不足 2.5 秒时从 0 起算。
    start = max(0, position_ms - 2500)
    end = start + 5000
    block = _resolve_block(
        identity,
        row["kind"],
        row["content_ref"],
        row["target_lang"],
        at_ms=position_ms,
    )
    return {
        "source": "watch",
        "contentRef": row["content_ref"],
        "kind": row["kind"],
        "targetLang": row["target_lang"],
        "start": _seconds(start),
        "end": _seconds(end),
        "startMs": start,
        "endMs": end,
        "durationSeconds": 5.0,
        "sentence": block["sentence"] if block else None,
        "blockId": _public_block_id(block["id"] if block else None),
        "positionSeconds": int(row["position_seconds"]),
        "watchedSeconds": int(row["watched_seconds"]),
        "occurredAt": int(row["occurred_at"]),
    }


# ---------------------------------------------------------------------------
# 叙述（事实 / 下一步，全部规则生成、不调用模型）
# ---------------------------------------------------------------------------

def _fact_text(
    videos: int, shows: int, attempts: int, reviewed_words: int
) -> str:
    """一句中文事实；没有记录时也明确说「没有记录」。"""
    if videos == 0 and shows == 0 and attempts == 0 and reviewed_words == 0:
        return "这周还没有可统计的学习记录。"
    parts: list[str] = []
    if videos and shows:
        parts.append(f"看了 {videos} 个视频和 {shows} 集剧集")
    elif videos:
        parts.append(f"看了 {videos} 个视频")
    elif shows:
        parts.append(f"看了 {shows} 集剧集")
    if attempts:
        parts.append(f"完成 {attempts} 道题")
    if reviewed_words:
        parts.append(f"复习了 {reviewed_words} 个词")
    return "你本周" + "，".join(parts) + "。"


def _next_step(
    *,
    videos: int,
    shows: int,
    attempts: int,
    reviewed_words: int,
    due_tomorrow: int,
    accuracy: float | None,
) -> str:
    """一个下一步（按优先级取第一条可执行的规则）。"""
    watched = videos + shows
    if watched == 0 and attempts == 0 and reviewed_words == 0:
        return "明天先看一个 10 分钟的视频"
    if attempts == 0:
        return "明天做一次理解练习"
    if due_tomorrow > 0:
        return f"复习 {due_tomorrow} 个到期词"
    if watched == 0:
        return "看一个 10 分钟的视频"
    if reviewed_words == 0:
        return "把本周遇到的生词加进复习"
    if accuracy is not None and accuracy < 0.6 and attempts >= 4:
        return "再做一次理解练习，答错的句子回听一遍"
    return "保持这个节奏，明天学 10 分钟"


# ---------------------------------------------------------------------------
# 周报
# ---------------------------------------------------------------------------

def _persist_snapshot(
    conn: sqlite3.Connection,
    identity: str,
    week_start: date,
    report: dict,
    now_value: int,
) -> bool:
    """首份周报快照落库（同周只写一次）；返回是否真的插入。"""
    payload = json.dumps(
        {
            "version": REPORT_VERSION,
            "generatedAt": now_value,
            "report": report,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    cursor = conn.execute(
        "INSERT OR IGNORE INTO weekly_reports "
        "(user_id, week_start, payload, created_at) VALUES (?, ?, ?, ?)",
        (identity, week_start.isoformat(), payload, now_value),
    )
    return bool(cursor.rowcount)


def week_report(identity: str, week_start=None, *, now=None) -> dict:
    """生成某一 UTC 周的事实周报，并写首份快照（同周不覆盖）。

    参数：
    - ``identity``：登录用户 id 或游客 ``guest:<sha256>``；
    - ``week_start``：``YYYY-MM-DD``；任意日期归一到所在周周一，缺省本周一；
    - ``now``：毫秒时间戳/aware datetime，缺省 :func:`now_ms`（测试注入）。
    """
    if not isinstance(identity, str) or not identity.strip():
        raise ReportError("缺少周报身份。")
    identity = identity.strip()
    now_value = _coerce_ms(now)
    start_date = _resolve_week_start(week_start, now_value)
    start_ms = _date_to_ms(start_date)
    end_ms = start_ms + 7 * MS_PER_DAY

    conn = _connect()
    try:
        _require_tables(conn, ("watch_events", "weekly_reports"))
        tables = _table_names(conn)

        watch = _watch_aggregate(conn, identity, start_ms, end_ms)
        if "attempts" in tables:
            quiz_stats = _attempt_aggregate(conn, identity, start_ms, end_ms)
        else:
            quiz_stats = {"attempts": 0, "correct": 0}
        if "review_logs" in tables:
            review = _review_aggregate(conn, identity, start_ms, end_ms)
        else:
            review = {"words": 0, "reviews": 0}
        if "word_states" in tables:
            words = _word_aggregate(
                conn, identity, start_ms, end_ms, now_value, review["words"]
            )
        else:
            words = {"new": 0, "reviewed": review["words"], "due_tomorrow": 0}

        accuracy = (
            round(quiz_stats["correct"] / quiz_stats["attempts"], 4)
            if quiz_stats["attempts"]
            else None
        )
        streak = _streak_days(conn, identity, now_value, tables)
        evidence = None
        if "attempts" in tables and "questions" in tables and "content_items" in tables:
            evidence = _wrong_attempt_evidence(conn, identity, start_ms, end_ms)
        if evidence is None:
            evidence = _recent_watch_evidence(conn, identity, start_ms, end_ms)

        report = {
            "version": REPORT_VERSION,
            "weekStart": start_date.isoformat(),
            "weekEnd": (start_date + timedelta(days=7)).isoformat(),
            "timezone": "UTC",
            "generatedAt": now_value,
            "numbers": {
                "passiveMinutes": round(watch["seconds"] / 60, 1),
                "reviewedWords": review["words"],
                "quizAccuracy": accuracy,
            },
            "fact": _fact_text(
                watch["videos"], watch["shows"], quiz_stats["attempts"], review["words"]
            ),
            "nextStep": _next_step(
                videos=watch["videos"],
                shows=watch["shows"],
                attempts=quiz_stats["attempts"],
                reviewed_words=review["words"],
                due_tomorrow=words["due_tomorrow"],
                accuracy=accuracy,
            ),
            "evidence": evidence,
            "streakDays": streak,
            "quiz": {
                "attempts": quiz_stats["attempts"],
                "correct": quiz_stats["correct"],
            },
            "words": {
                "new": words["new"],
                "reviewed": words["reviewed"],
                "dueTomorrow": words["due_tomorrow"],
            },
        }
        _persist_snapshot(conn, identity, start_date, report, now_value)
        conn.commit()
        return report
    except sqlite3.OperationalError as exc:
        conn.rollback()
        _raise_unavailable(exc)
    finally:
        conn.close()
