"""任务表 ``jobs`` 的读写层 + 单进程执行互斥（计划书 M1 ⑤ / §7.3 A-4）。

任务表把「处理一个视频」从一次 HTTP 连接里解耦出来：生成到哪一句、状态是什么
落进 DB，刷新/断网后前端先 ``GET /api/jobs/{id}`` 再带 ``jobId + from`` 续传，
已生成的字幕直接从缓存复用（不再调模型）。

契约（表结构由 Alembic ``0005_jobs`` 创建，运行时不建表）：

- 状态机::

      queued --开始--> running --每批落盘--> running（cursor 前进）
      running --正常结束--> done
      running --断线/取消--> partial（cursor>0）| queued（还没生成）
      queued/running/partial --显式错误--> failed

- **幂等**：同一 ``(user_id, kind, content_ref, target_lang)`` 同时最多一个
  未完成 job。进程内 ``_CREATE_LOCK`` 串行化查找+插入，数据库部分唯一索引
  ``ux_jobs_active`` 兜底跨进程并发；插入撞唯一约束时回读已存在的那条。
- **并发执行**：``try_acquire(job_id)`` 是进程内的执行权锁——同一 job 同时只
  允许一条流在生成，第二个请求直接 409，不会重复付费。锁只在生成期间持有，
  断线后在 ``finally`` 释放。
- **降级**：库文件或表不存在（旧库没跑迁移）时，所有写操作变成 no-op、读操作
  返回 ``None``，只告警一次；视频处理/SSE 仍按旧行为工作，只是没有断线续传。
- **不丢进度**：``cursor`` 只增不减（SQL ``MAX(cursor, ?)``），乱序/重复上报
  都不会把「已生成到第几句」改小。

实现是同步的（标准库 sqlite3，与 ``auth_db.py`` / ``events.py`` 一致）；每次
写操作都是一条短事务，不放在请求主链路的热点上。
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
import uuid

import config

logger = logging.getLogger(__name__)

# 任务类型：与计划书 §8.1 的 jobs.kind 对齐。local_show 先占位，M1 只接视频。
KIND_PROCESS_VIDEO = "process_video"
KIND_LOCAL_SHOW = "local_show"
KNOWN_KINDS = (KIND_PROCESS_VIDEO, KIND_LOCAL_SHOW)

STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_PARTIAL = "partial"
STATUS_DONE = "done"
STATUS_FAILED = "failed"
KNOWN_STATUSES = (
    STATUS_QUEUED,
    STATUS_RUNNING,
    STATUS_PARTIAL,
    STATUS_DONE,
    STATUS_FAILED,
)
# 未完成 = 可复用（新请求接着用）且可续传。
ACTIVE_STATUSES = (STATUS_QUEUED, STATUS_RUNNING, STATUS_PARTIAL)
RESUMABLE_STATUSES = ACTIVE_STATUSES
TERMINAL_STATUSES = (STATUS_DONE, STATUS_FAILED)

_SELECT_SQL = (
    "SELECT id, user_id, kind, content_ref, target_lang, status, cursor, payload, "
    "error, created_at, updated_at FROM jobs"
)

# 进程内执行权：job_id → 正在被哪条流处理。只在本进程内有效（单进程部署，
# 见计划书「独立 worker 进程现在不建」）。
_ACTIVE_LOCK = threading.Lock()
_ACTIVE_JOBS: set[str] = set()

# 串行化「查找未完成任务 + 插入新任务」，避免同进程并发请求各插一条。
_CREATE_LOCK = threading.Lock()

_warned_unavailable = False


def now_ms() -> int:
    """服务端当前时间的毫秒时间戳（与 events/ledger 同口径）。"""
    return int(time.time() * 1000)


def _db_path() -> str:
    return config.AUTH_DB_PATH


def _warn_unavailable(message: str) -> None:
    """库/表不可用只告警一次，避免每个请求刷屏。"""
    global _warned_unavailable
    if not _warned_unavailable:
        _warned_unavailable = True
        logger.warning(message)


def reset_warned_state() -> None:
    """清掉「只告警一次」标记（测试用）。"""
    global _warned_unavailable
    _warned_unavailable = False


def _connect() -> sqlite3.Connection | None:
    """连库；库文件不存在返回 ``None``（绝不顺手建一个空库）。"""
    path = _db_path()
    if not os.path.exists(path):
        _warn_unavailable(
            f"数据库文件不存在：{path}（先运行 alembic upgrade head）；"
            "任务绑定本次降级为无操作。"
        )
        return None
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def _is_missing_schema(exc: sqlite3.Error) -> bool:
    text = str(exc).lower()
    return "no such table" in text or "no such column" in text


def _handle_db_error(exc: sqlite3.Error, action: str) -> None:
    if _is_missing_schema(exc):
        _warn_unavailable(
            f"jobs 表不存在（未跑 0005_jobs 迁移），{action} 跳过；"
            "视频处理照常，但刷新后不能断线续传。"
        )
    else:
        logger.warning("jobs %s 失败：%s", action, exc)


def _row_to_job(row: sqlite3.Row) -> dict:
    raw_payload = row["payload"]
    payload: dict = {}
    if raw_payload:
        try:
            loaded = json.loads(raw_payload)
        except (TypeError, ValueError):
            loaded = None
        if isinstance(loaded, dict):
            payload = loaded
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "kind": row["kind"],
        "content_ref": row["content_ref"],
        "target_lang": row["target_lang"] or "zh-CN",
        "status": row["status"],
        "cursor": int(row["cursor"] or 0),
        "payload": payload,
        "error": row["error"],
        "created_at": int(row["created_at"] or 0),
        "updated_at": int(row["updated_at"] or 0),
    }


def get(job_id: str) -> dict | None:
    """按 id 取一条任务；不存在/库表不可用返回 ``None``。"""
    if not job_id:
        return None
    conn = _connect()
    if conn is None:
        return None
    try:
        row = conn.execute(f"{_SELECT_SQL} WHERE id = ?", (job_id,)).fetchone()
    except sqlite3.Error as exc:
        _handle_db_error(exc, "读取任务")
        return None
    finally:
        conn.close()
    return _row_to_job(row) if row is not None else None


def _find_active(
    user_id: str, kind: str, content_ref: str, target_lang: str
) -> dict | None:
    conn = _connect()
    if conn is None:
        return None
    placeholders = ", ".join("?" for _ in ACTIVE_STATUSES)
    try:
        row = conn.execute(
            f"{_SELECT_SQL} WHERE user_id = ? AND kind = ? AND content_ref = ? "
            f"AND target_lang = ? AND status IN ({placeholders}) "
            "ORDER BY created_at DESC LIMIT 1",
            (user_id, kind, content_ref, target_lang, *ACTIVE_STATUSES),
        ).fetchone()
    except sqlite3.Error as exc:
        _handle_db_error(exc, "查找未完成任务")
        return None
    finally:
        conn.close()
    return _row_to_job(row) if row is not None else None


def create_or_reuse(
    *,
    user_id: str | None,
    kind: str,
    content_ref: str,
    target_lang: str,
    payload: dict | None = None,
) -> dict | None:
    """取同用户+同内容+同语言的未完成 job，没有就新建一条。

    幂等：并发调用最多产生一条未完成任务（进程内锁 + 部分唯一索引）。
    返回 ``None`` 表示任务绑定不可用（未登录 / 库表缺失），调用方照常处理。
    """
    if not user_id or not content_ref:
        return None
    with _CREATE_LOCK:
        existing = _find_active(user_id, kind, content_ref, target_lang)
        if existing is not None:
            return existing

        job_id = uuid.uuid4().hex
        now = now_ms()
        encoded = json.dumps(payload or {}, ensure_ascii=False)
        conn = _connect()
        if conn is None:
            return None
        try:
            conn.execute(
                "INSERT INTO jobs (id, user_id, kind, content_ref, target_lang, "
                "status, cursor, payload, error, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)",
                (
                    job_id,
                    user_id,
                    kind,
                    content_ref,
                    target_lang,
                    STATUS_QUEUED,
                    encoded,
                    now,
                    now,
                ),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            # 另一个进程刚插入了同一内容的未完成任务：复用它，不报错。
            return _find_active(user_id, kind, content_ref, target_lang)
        except sqlite3.Error as exc:
            _handle_db_error(exc, "创建任务")
            return None
        finally:
            conn.close()
        return get(job_id)


def _update(
    job_id: str,
    *,
    cursor: int | None = None,
    status: str | None = None,
    error: str | None = None,
    set_error: bool = False,
    payload: dict | None = None,
) -> None:
    """内部更新入口：只写有变化的列 + ``updated_at``。"""
    fields: list[str] = []
    values: list[object] = []
    if cursor is not None:
        # cursor 只增不减：重复/乱序上报不会把进度改小。
        fields.append("cursor = MAX(cursor, ?)")
        values.append(max(0, int(cursor)))
    if status is not None:
        fields.append("status = ?")
        values.append(status)
    if set_error:
        fields.append("error = ?")
        values.append(error[:500] if error else None)
    if payload is not None:
        fields.append("payload = ?")
        values.append(json.dumps(payload, ensure_ascii=False))
    if not fields:
        return
    fields.append("updated_at = ?")
    values.append(now_ms())
    values.append(job_id)

    conn = _connect()
    if conn is None:
        return
    try:
        conn.execute(f"UPDATE jobs SET {', '.join(fields)} WHERE id = ?", values)
        conn.commit()
    except sqlite3.Error as exc:
        _handle_db_error(exc, "更新任务")
    finally:
        conn.close()


def update_progress(
    job_id: str,
    cursor: int | None = None,
    *,
    total: int | None = None,
    status: str | None = None,
) -> None:
    """落盘一批后推进游标（可选同时更新 total / 状态）。"""
    payload = None
    if total is not None:
        job = get(job_id)
        if job is None:
            return
        payload = {**(job.get("payload") or {}), "total": max(0, int(total))}
    _update(job_id, cursor=cursor, status=status, payload=payload)


def mark_running(job_id: str, total: int | None = None) -> None:
    """开始生成：queued/partial → running。"""
    payload = None
    if total is not None:
        job = get(job_id)
        payload = {**((job or {}).get("payload") or {}), "total": max(0, int(total))}
    _update(job_id, status=STATUS_RUNNING, payload=payload)


def mark_done(job_id: str, cursor: int | None = None) -> None:
    """正常结束：status=done，清掉历史错误。"""
    _update(job_id, cursor=cursor, status=STATUS_DONE, error=None, set_error=True)


def mark_failed(job_id: str, reason: str) -> None:
    """终态失败（无字幕/产物缺失等）；失败原因只给人看。"""
    _update(job_id, status=STATUS_FAILED, error=reason, set_error=True)


def settle_interrupted(job_id: str) -> None:
    """断线/取消后的收尾：未完结的任务转成 partial（有进度）或 queued（无进度）。

    幂等：已经 done/failed 的任务不再改动——正常结束的流在 ``finally`` 里调用
    也不会把 done 覆盖成 partial。
    """
    job = get(job_id)
    if job is None or job["status"] not in ACTIVE_STATUSES:
        return
    status = STATUS_PARTIAL if job["cursor"] > 0 else STATUS_QUEUED
    _update(job_id, status=status)


# ---------------------------------------------------------------------------
# 单进程执行权（同一 job 同时只允许一条生成流）
# ---------------------------------------------------------------------------

def try_acquire(job_id: str) -> bool:
    """尝试取得 job 的执行权；已被本进程另一条流持有时返回 ``False``。"""
    with _ACTIVE_LOCK:
        if job_id in _ACTIVE_JOBS:
            return False
        _ACTIVE_JOBS.add(job_id)
        return True


def release(job_id: str) -> None:
    """释放执行权（生成流的 ``finally`` 必须调用，幂等）。"""
    with _ACTIVE_LOCK:
        _ACTIVE_JOBS.discard(job_id)


def is_active(job_id: str) -> bool:
    """本进程是否正在生成这个 job（GET /api/jobs 用来标记 canResume）。"""
    with _ACTIVE_LOCK:
        return job_id in _ACTIVE_JOBS


def active_count() -> int:
    """当前进程内正在生成的任务数（可观测/测试用）。"""
    with _ACTIVE_LOCK:
        return len(_ACTIVE_JOBS)


def reset_active_jobs() -> None:
    """清空执行权（测试用；不应在运行中调用）。"""
    with _ACTIVE_LOCK:
        _ACTIVE_JOBS.clear()


__all__ = [
    "KIND_PROCESS_VIDEO",
    "KIND_LOCAL_SHOW",
    "STATUS_QUEUED",
    "STATUS_RUNNING",
    "STATUS_PARTIAL",
    "STATUS_DONE",
    "STATUS_FAILED",
    "KNOWN_STATUSES",
    "ACTIVE_STATUSES",
    "RESUMABLE_STATUSES",
    "TERMINAL_STATUSES",
    "now_ms",
    "get",
    "create_or_reuse",
    "update_progress",
    "mark_running",
    "mark_done",
    "mark_failed",
    "settle_interrupted",
    "try_acquire",
    "release",
    "is_active",
    "active_count",
    "reset_active_jobs",
    "reset_warned_state",
]
