"""学习事件日志（learning_events）的写入层 —— append-only。

设计约束（对应计划书 §7.3 A-1 / §8.4）：

- **只追加**：本模块只做 INSERT 与只读 SELECT，不提供原地修改、删除或清空入口。
  表的建/删由 Alembic 迁移 ``0002_learning_events`` 负责，运行时不建表、不改表。
- **写入不阻断主流程**：``emit_event`` 捕获所有异常、记日志并返回 ``None``；
  学习行为不会因为埋点失败而失败（事件表未迁移时同样如此）。
- **失败可诊断**：表缺失、库不可写等会留下带 ``event_type`` 的日志，不静默丢数据。
- **假名化**：有 ``user_id`` 时同时写 ``pseudonym_id = HMAC-SHA256(salt, user_id)``。
  删除权口径（D-10）/逐用户盐表尚未定稿，所以 M1a 先明文 ``user_id`` + 假名并存，
  定稿后按 §8.4 表级矩阵迁移（事件表最终只靠 ``pseudonym_id`` 归属）。
- ``occurred_at`` 是客户端上报的毫秒时间戳（缺省用服务端时间）；``created_at`` 是
  服务端落库的毫秒时间戳；``payload`` 存 JSON 文本（UTF-8，dict/list 均可）。

实现是同步的（标准库 sqlite3，与 auth_db.py 一致）。async 调用方如果在意事件
循环，用 ``await asyncio.to_thread(events.emit_event, ...)`` 包一层即可。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import sqlite3
import time
from urllib.parse import quote

import config

logger = logging.getLogger(__name__)

# 事件类型目前不设 CHECK 约束（事件字典 v1 还没定稿）。这里只是文档用的示例集合，
# 写入层不校验——新增类型不需要改表，也不该因为拼错就丢事件。
KNOWN_EVENT_TYPES = (
    "video_open",
    "block_visible",
    "quiz_answer",
    "word_review",
)

# 未配置 EVENTS_PSEUDONYM_SALT 时的开发默认盐：能让本地与测试跑起来，
# 但用户 id 空间小、可被枚举反推，**不可用于生产**。
_DEV_PSEUDONYM_SALT = "lingua-nova-dev-insecure-pseudonym-salt"
_warned_default_salt = False

_INSERT_SQL = (
    "INSERT INTO learning_events ("
    "user_id, device_id, session_id, event_type, content_ref, payload, "
    "occurred_at, created_at, pseudonym_id"
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
)

_SELECT_SQL = (
    "SELECT id, user_id, device_id, session_id, event_type, content_ref, payload, "
    "occurred_at, created_at, pseudonym_id FROM learning_events"
)

_MAX_QUERY_LIMIT = 1000


def now_ms() -> int:
    """服务端当前时间的毫秒时间戳。"""
    return int(time.time() * 1000)


def _db_path() -> str:
    return config.AUTH_DB_PATH


def _connect() -> sqlite3.Connection:
    """连库（不建库、不建目录：schema 只由迁移创建）。"""
    conn = sqlite3.connect(_db_path(), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _require_db() -> str:
    """确认库文件已存在；不存在时返回明确错误（避免 sqlite 顺手建出空库）。"""
    path = _db_path()
    if not os.path.exists(path):
        raise sqlite3.OperationalError(
            f"数据库文件不存在：{path}（先运行 alembic upgrade head）"
        )
    return path


def pseudonym_for(user_id: str | None) -> str | None:
    """user_id → 假名 id；没有 user_id 时返回 ``None``。

    假名 = HMAC-SHA256(盐, user_id) 的十六进制串。盐取 ``config.EVENTS_PSEUDONYM_SALT``
    （环境变量 ``EVENTS_PSEUDONYM_SALT``）；未配置时退回开发默认盐并告警一次。
    """
    if not user_id:
        return None
    salt = config.EVENTS_PSEUDONYM_SALT
    if not salt:
        global _warned_default_salt
        if not _warned_default_salt:
            _warned_default_salt = True
            logger.warning(
                "EVENTS_PSEUDONYM_SALT 未设置：learning_events.pseudonym_id 使用开发"
                "默认盐，生产环境必须设置该环境变量后再收集事件。"
            )
        salt = _DEV_PSEUDONYM_SALT
    return hmac.new(
        salt.encode("utf-8"), user_id.encode("utf-8"), hashlib.sha256
    ).hexdigest()


def emit_event(
    event_type: str,
    *,
    user_id: str | None = None,
    device_id: str | None = None,
    session_id: str | None = None,
    content_ref: str | None = None,
    payload: dict | list | None = None,
    occurred_at: int | None = None,
    pseudonym_id: str | None = None,
) -> int | None:
    """追加一条学习事件，返回新行 id；任何失败都只记日志并返回 ``None``。

    参数：

    - ``event_type``：事件类型（如 ``video_open`` / ``block_visible`` /
      ``quiz_answer`` / ``word_review``），空字符串视为调用方 bug，丢弃并告警；
    - ``user_id`` / ``device_id`` / ``session_id``：归属与来源标识，均可空；
    - ``content_ref``：内容 id（videoId 等），可空；
    - ``payload``：自由字段（自动 ``json.dumps``；不可序列化时置空并告警，
      事件本身照常写入）；
    - ``occurred_at``：客户端毫秒时间戳，缺省用服务端当前时间；
    - ``pseudonym_id``：一般不用传，缺省由 ``user_id`` 计算。

    单条插入（不开事务批处理）：事件是低价值高频写，失败隔离比分批更重要。
    """
    if not isinstance(event_type, str) or not event_type.strip():
        logger.warning(
            "emit_event 收到空/非法 event_type（%r），已丢弃（调用方应检查埋点参数）。",
            event_type,
        )
        return None
    event_type = event_type.strip()

    payload_json: str | None = None
    if payload is not None:
        try:
            payload_json = json.dumps(
                payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            )
        except (TypeError, ValueError) as exc:
            logger.warning(
                "emit_event 的 payload 不可 JSON 序列化，事件照常写入但 payload 置空：%s",
                exc,
            )

    if occurred_at is None:
        occurred = now_ms()
    else:
        try:
            occurred = int(occurred_at)
        except (TypeError, ValueError):
            logger.warning(
                "emit_event 的 occurred_at 不是整数（%r），改用服务端时间。", occurred_at
            )
            occurred = now_ms()
    created = now_ms()

    try:
        pseudo = pseudonym_id if pseudonym_id is not None else pseudonym_for(user_id)
        _require_db()
        conn = _connect()
        try:
            cursor = conn.execute(
                _INSERT_SQL,
                (
                    user_id,
                    device_id,
                    session_id,
                    event_type,
                    content_ref,
                    payload_json,
                    occurred,
                    created,
                    pseudo,
                ),
            )
            conn.commit()
            return int(cursor.lastrowid)
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 - 埋点失败绝不能影响学习主流程
        logger.exception(
            "learning_events 写入失败（已忽略，不阻断主流程）：event_type=%r", event_type
        )
        return None


def _row_to_dict(row: sqlite3.Row) -> dict:
    item = dict(row)
    raw = item.get("payload")
    if not raw:
        item["payload"] = None
        return item
    try:
        item["payload"] = json.loads(raw)
    except (TypeError, ValueError):
        # 历史脏数据：保留原文，调用方自己决定怎么处理，不让查询整体失败。
        item["payload_parse_error"] = True
    return item


def query_events(
    *,
    user_id: str | None = None,
    pseudonym_id: str | None = None,
    event_type: str | None = None,
    content_ref: str | None = None,
    session_id: str | None = None,
    since_ms: int | None = None,
    until_ms: int | None = None,
    limit: int = 100,
) -> list[dict]:
    """只读查询事件（**仅开发/测试用**，刻意不挂任何 HTTP 端点）。

    过滤条件为 ``None`` 时忽略；按 ``(occurred_at, id)`` 升序；``limit`` 夹在
    ``1..1000``。返回的 ``payload`` 已解析为 dict/list（解析失败时保留原文并标记
    ``payload_parse_error``）。

    表不存在或库读不了时抛 ``sqlite3.Error``——这是开发/测试辅助函数，让问题
    直接暴露；生产写入路径用 ``emit_event``，不会走到这里。
    """
    limit = max(1, min(int(limit), _MAX_QUERY_LIMIT))

    clauses: list[str] = []
    params: list[object] = []
    for column, value in (
        ("user_id", user_id),
        ("pseudonym_id", pseudonym_id),
        ("event_type", event_type),
        ("content_ref", content_ref),
        ("session_id", session_id),
    ):
        if value is not None:
            clauses.append(f"{column} = ?")
            params.append(value)
    if since_ms is not None:
        clauses.append("occurred_at >= ?")
        params.append(int(since_ms))
    if until_ms is not None:
        clauses.append("occurred_at <= ?")
        params.append(int(until_ms))

    sql = _SELECT_SQL
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    sql += " ORDER BY occurred_at ASC, id ASC LIMIT ?"
    params.append(limit)

    _require_db()
    conn = _connect()
    try:
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()
    return [_row_to_dict(row) for row in rows]


def schema_status() -> dict:
    """只读检查迁移状态（不建库、不建表、不加写锁）。

    返回 ``{db_path, db_exists, events_table, alembic_revision, ready}``；
    ``ready`` 为真表示库已纳管（有 ``alembic_version`` 记录）且 ``learning_events``
    已建好，可以安全写入事件。
    """
    path = os.path.abspath(_db_path())
    status = {
        "db_path": path,
        "db_exists": os.path.exists(path),
        "events_table": False,
        "alembic_revision": None,
        "ready": False,
    }
    if not status["db_exists"]:
        return status

    try:
        # mode=ro：只读连接，不会因为一次自检就在磁盘上建出空库。
        conn = sqlite3.connect(f"file:{quote(path)}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error as exc:
        logger.warning("打开数据库做迁移自检失败：%s", exc)
        return status

    try:
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        status["events_table"] = "learning_events" in tables
        if "alembic_version" in tables:
            row = conn.execute("SELECT version_num FROM alembic_version").fetchone()
            status["alembic_revision"] = row[0] if row else None
        status["ready"] = bool(status["events_table"] and status["alembic_revision"])
    except sqlite3.Error as exc:
        logger.warning("读取数据库迁移状态失败：%s", exc)
    finally:
        conn.close()
    return status


def log_schema_status() -> dict:
    """启动时调用：把迁移状态写进日志（只告警，从不抛错、不阻断启动）。"""
    status = schema_status()
    if status["ready"]:
        logger.info(
            "learning_events 就绪（alembic revision=%s）", status["alembic_revision"]
        )
    elif status["db_exists"]:
        logger.warning(
            "数据库已存在但学习事件表未就绪（learning_events=%s, alembic=%s）。"
            "请在 backend/ 下运行 `venv/bin/alembic upgrade head`（旧库可直接跑，"
            "或先 `venv/bin/alembic stamp 0001_baseline`）；事件写入会先被跳过，"
            "不影响其它功能。",
            status["events_table"],
            status["alembic_revision"],
        )
    return status
