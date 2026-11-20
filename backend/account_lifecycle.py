"""账号生命周期：删除冷静期、到期硬删除、管理员审计（M2a / specs/033）。

设计口径见 ``docs/项目提案-上线功能.md`` §4 与 ``specs/033-account-lifecycle``：

- 删除申请落 ``account_deletion_requests``，只存 ``sha256(user_id)``（不存明文
  user id）；7 天冷静期内可取消/导出，到期由管理员或安全脚本执行硬删除。
- 提交申请即把 ``users.status`` 改为 ``deletion_pending`` 并删除全部会话；
  登录仍允许（用于取消/导出），但其它 ``/api/*`` 由 ``main.py`` 的中间件 403。
- 硬删除顺序：sessions → 业务表 → 文件目录 → users 最后。SQLite 事务覆盖
  前两步；文件删除失败会把申请标 ``failed`` 并保留可诊断错误，用户行保留，
  可修好权限后重试，**不假装成功**。
- 备份（``backups/`` / 离机副本）不按用户改写；文案必须披露删除后最长 30 天
  残留。公共缓存（``content_difficulty`` / ``content_teaching_analysis`` /
  ``book_chapter_translations`` / ``data/subtitles`` / ``data/ecdict.db``）没有
  可靠 user_id，按公共数据保留，边界写在 spec。
- 游客目录 ``data/guests/<hash>`` 没有 user→guest 的持久映射；不猜、不删。
- 本模块只做服务层；HTTP 在 ``routes_account_lifecycle.py`` 与
  ``routes_admin_lifecycle.py``，导出在 ``account_export.py``。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import shutil
import sqlite3
import threading
import time
import uuid

import account
import auth_db
import config
import events
import storage

logger = logging.getLogger("linguatrek.account_lifecycle")

# D-1：7 天冷静期；D-2：备份最长 30 天残留（只用于文案，不在这里删备份）。
COOLDOWN_DAYS = 7
COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000
BACKUP_RETENTION_DAYS = 30

DELETE_CONFIRM_WORD = "DELETE"
MAX_REASON_CHARS = 200
MAX_ERROR_CHARS = 1000

STATUS_PENDING = "pending"
STATUS_CANCELLED = "cancelled"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"
REQUEST_STATUSES = (
    STATUS_PENDING,
    STATUS_CANCELLED,
    STATUS_COMPLETED,
    STATUS_FAILED,
)

VERIFIED_SESSION_PASSWORD = "session_password"
VERIFIED_SUPPORT_MANUAL = "support_manual"
VERIFIED_VIA = (VERIFIED_SESSION_PASSWORD, VERIFIED_SUPPORT_MANUAL)

# 密码确认失败限流（进程内存；与登录锁定分开，避免账号密码爆破同时打账号页）。
PASSWORD_FAILURE_WINDOW_SECONDS = 15 * 60
PASSWORD_MAX_FAILURES = 5

# 硬删除串行化：两个管理员同时点「立即执行」时，只有第一个真正删除。
_EXECUTE_LOCK = threading.Lock()

_TABLE_DELETION = "account_deletion_requests"
_TABLE_EXPORT = "data_export_jobs"
_TABLE_AUDIT = "admin_audit_log"
_REQUIRED_TABLES = (_TABLE_DELETION, _TABLE_EXPORT, _TABLE_AUDIT)

_failures: dict[str, list[float]] = {}
_failures_lock = threading.Lock()


# ---------------------------------------------------------------------------
# 异常（HTTP 路由按 code / status_code / extra 映射，稳定错误码）
# ---------------------------------------------------------------------------

class LifecycleError(Exception):
    """账号生命周期错误的基类；路由用 ``code`` 生成稳定响应。"""

    code = "account_lifecycle_error"
    status_code = 400

    def __init__(self, message: str, **extra: object) -> None:
        super().__init__(message)
        self.extra = extra


class LifecycleUnavailable(LifecycleError):
    code = "lifecycle_unavailable"
    status_code = 503


class UserNotFound(LifecycleError):
    code = "user_not_found"
    status_code = 404


class DeletionNotFound(LifecycleError):
    code = "deletion_not_found"
    status_code = 404


class DeletionAlreadyPending(LifecycleError):
    code = "deletion_already_pending"
    status_code = 409


class DeletionNotPending(LifecycleError):
    code = "deletion_not_pending"
    status_code = 409


class DeletionCompleted(LifecycleError):
    code = "deletion_completed"
    status_code = 409


class DeletionNotDue(LifecycleError):
    code = "deletion_not_due"
    status_code = 409


class ConfirmationInvalid(LifecycleError):
    code = "confirmation_invalid"
    status_code = 400


class InvalidReason(LifecycleError):
    code = "invalid_reason"
    status_code = 400


class PasswordInvalid(LifecycleError):
    code = "password_invalid"
    status_code = 401


class PasswordRateLimited(LifecycleError):
    code = "password_rate_limited"
    status_code = 429


class LastAdmin(LifecycleError):
    code = "last_admin"
    status_code = 409


class DeletionFailed(LifecycleError):
    code = "deletion_failed"
    status_code = 500


# ---------------------------------------------------------------------------
# 时间 / 标识 / 表结构
# ---------------------------------------------------------------------------

def now_ms() -> int:
    return int(time.time() * 1000)


def hash_user_id(user_id: str) -> str:
    """删除申请/审计/导出 manifest 用的用户标识摘要（不存明文）。"""
    return hashlib.sha256(str(user_id).encode("utf-8")).hexdigest()


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?", (table,)
    ).fetchone()
    return row is not None


def _require_tables(conn: sqlite3.Connection) -> None:
    missing = [name for name in _REQUIRED_TABLES if not _table_exists(conn, name)]
    if missing:
        raise LifecycleUnavailable(
            "账号删除/导出表未迁移（缺 "
            + ", ".join(missing)
            + "）；请先运行 backend/venv/bin/alembic upgrade head（0024）。"
        )


def ensure_schema(conn: sqlite3.Connection) -> None:
    """其它模块（导出/路由）复用的迁移检查；缺表抛 ``LifecycleUnavailable``。"""
    _require_tables(conn)


# ---------------------------------------------------------------------------
# 密码校验 + 失败限流
# ---------------------------------------------------------------------------

def verify_password(user: dict, password: object) -> bool:
    """只校验当前登录用户自己的密码；失败/非字符串一律 False。

    复用 ``auth_db.authenticate``（含不存在账号的等价耗时路径），但额外要求
    返回的 id 与当前会话用户一致——绝不用别人邮箱做密码确认。
    """
    if not isinstance(password, str) or not password:
        return False
    email = user.get("email")
    user_id = user.get("id")
    if not email or not user_id:
        return False
    authenticated = auth_db.authenticate(email, password)
    return bool(authenticated and authenticated.get("id") == user_id)


def _failure_key(action: str, user_id: str) -> str:
    return f"{action}:{user_id}"


def password_retry_after(action: str, user_id: str) -> int | None:
    """该操作是否因连续密码错误被限流；返回建议 Retry-After（秒）。"""
    now = time.monotonic()
    horizon = now - PASSWORD_FAILURE_WINDOW_SECONDS
    key = _failure_key(action, user_id)
    with _failures_lock:
        attempts = [ts for ts in _failures.get(key, []) if ts > horizon]
        if attempts:
            _failures[key] = attempts
        else:
            _failures.pop(key, None)
        if len(attempts) < PASSWORD_MAX_FAILURES:
            return None
        return max(1, int(attempts[0] + PASSWORD_FAILURE_WINDOW_SECONDS - now) + 1)


def record_password_failure(action: str, user_id: str) -> None:
    now = time.monotonic()
    horizon = now - PASSWORD_FAILURE_WINDOW_SECONDS
    key = _failure_key(action, user_id)
    with _failures_lock:
        attempts = [ts for ts in _failures.get(key, []) if ts > horizon]
        attempts.append(now)
        _failures[key] = attempts


def clear_password_failures(action: str, user_id: str) -> None:
    with _failures_lock:
        _failures.pop(_failure_key(action, user_id), None)


def reset_password_throttle() -> None:
    """清空进程内密码失败计数（测试/运维排障用）。"""
    with _failures_lock:
        _failures.clear()


def check_password_or_raise(action: str, user: dict, password: object) -> None:
    """路由共用的密码确认：限流 → 校验 → 成功清零；失败抛稳定错误。"""
    retry_after = password_retry_after(action, user["id"])
    if retry_after is not None:
        raise PasswordRateLimited(
            "密码错误次数过多，请稍后再试。",
            retryAfter=retry_after,
        )
    if not verify_password(user, password):
        record_password_failure(action, user["id"])
        raise PasswordInvalid("密码不正确。")
    clear_password_failures(action, user["id"])


# ---------------------------------------------------------------------------
# 审计
# ---------------------------------------------------------------------------

def write_audit(
    actor_id: str,
    action: str,
    *,
    target_type: str | None = None,
    target_id: str | None = None,
    detail: object | None = None,
    request_id: str | None = None,
    conn: sqlite3.Connection | None = None,
    required: bool = False,
) -> str | None:
    """写一条 ``admin_audit_log``；表缺失时按 ``required`` 决定失败还是降级。

    删除/导出路径 ``required=True``（迁移缺失应整体失败）；既有管理台写操作
    （调余额/封禁/邀请码/设置）用 ``required=False``，旧库未迁移时只告警，
    不影响原功能。
    """
    audit_id = f"aud-{uuid.uuid4().hex}"
    if detail is None:
        detail_json = None
    else:
        try:
            detail_json = json.dumps(detail, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):
            detail_json = json.dumps(
                {"unserializable": type(detail).__name__}, separators=(",", ":")
            )
        if len(detail_json) > 8000:
            detail_json = detail_json[:8000]
    params = (
        audit_id,
        str(actor_id),
        str(action),
        target_type,
        target_id,
        detail_json,
        request_id,
        now_ms(),
    )
    sql = (
        "INSERT INTO admin_audit_log "
        "(id, actor_id, action, target_type, target_id, detail_json, "
        "request_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    if conn is not None:
        conn.execute(sql, params)
        return audit_id

    new_conn = auth_db.connect()
    try:
        try:
            new_conn.execute(sql, params)
            new_conn.commit()
        except sqlite3.Error as exc:
            if "no such table" in str(exc).lower():
                if required:
                    raise LifecycleUnavailable(
                        "审计表未迁移（admin_audit_log）；请先运行 alembic upgrade head（0024）。"
                    ) from exc
                logger.warning("审计表未迁移，跳过审计写入：%s", action)
                return None
            if not required:
                logger.warning("审计写入失败（已降级，不影响原操作）：%s", exc)
                return None
            raise
    finally:
        new_conn.close()
    return audit_id


def list_audit(
    limit: int = 50,
    offset: int = 0,
    action: str | None = None,
) -> dict:
    """管理员审计列表；``detail_json`` 解析成对象，损坏时保留原始字符串。"""
    limit = max(1, min(int(limit), 100))
    offset = max(0, min(int(offset), 100_000))
    conn = auth_db.connect()
    try:
        _require_tables(conn)
        where = ""
        params: list[object] = []
        if action:
            where = " WHERE action = ?"
            params.append(action)
        total = int(
            conn.execute(
                f"SELECT COUNT(*) FROM admin_audit_log{where}", tuple(params)
            ).fetchone()[0]
            or 0
        )
        rows = conn.execute(
            f"SELECT id, actor_id, action, target_type, target_id, detail_json, "
            f"request_id, created_at_ms FROM admin_audit_log{where} "
            "ORDER BY created_at_ms DESC, id DESC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
    finally:
        conn.close()
    entries = []
    for row in rows:
        detail = None
        if row["detail_json"]:
            try:
                detail = json.loads(row["detail_json"])
            except (TypeError, ValueError):
                detail = row["detail_json"]
        entries.append(
            {
                "id": row["id"],
                "actorId": row["actor_id"],
                "action": row["action"],
                "targetType": row["target_type"],
                "targetId": row["target_id"],
                "detail": detail,
                "requestId": row["request_id"],
                "createdAt": row["created_at_ms"],
            }
        )
    return {
        "entries": entries,
        "total": total,
        "limit": limit,
        "offset": offset,
        "hasMore": offset + len(entries) < total,
    }


# ---------------------------------------------------------------------------
# 删除申请
# ---------------------------------------------------------------------------

def _find_user_id_by_hash(conn: sqlite3.Connection, user_hash: str) -> str | None:
    """从 users 里反查 ``sha256(id)``；不保留反向表，单机用户量足够小。"""
    if not user_hash:
        return None
    for row in conn.execute("SELECT id FROM users"):
        candidate = str(row["id"])
        if hmac.compare_digest(hash_user_id(candidate), user_hash):
            return candidate
    return None


def _is_last_active_admin(conn: sqlite3.Connection, user_row: sqlite3.Row) -> bool:
    """目标是否管理员且是唯一仍为 active 的管理员（删除后无人能进后台）。"""
    if not config.is_admin_email(user_row["email"]):
        return False
    others = 0
    for row in conn.execute("SELECT id, email, status FROM users"):
        if row["id"] == user_row["id"]:
            continue
        if config.is_admin_email(row["email"]) and (
            row["status"] or account.STATUS_ACTIVE
        ) == account.STATUS_ACTIVE:
            others += 1
    return others == 0


def _validate_reason(reason: object) -> str | None:
    if reason is None:
        return None
    if not isinstance(reason, str):
        raise InvalidReason("删除原因必须是字符串。")
    reason = reason.strip()
    if len(reason) > MAX_REASON_CHARS:
        raise InvalidReason(f"删除原因最多 {MAX_REASON_CHARS} 个字符。")
    return reason or None


def _request_public(row: sqlite3.Row, *, include_error: bool = True) -> dict:
    counts = None
    if row["counts_json"]:
        try:
            counts = json.loads(row["counts_json"])
        except (TypeError, ValueError):
            counts = None
    error = row["error"]
    if not include_error and error:
        # 只有 failed 才向用户显示通用失败文案；cancelled 后不残留错误。
        error = (
            "删除处理失败，请联系支持。"
            if row["status"] == STATUS_FAILED
            else None
        )
    return {
        "id": row["id"],
        "status": row["status"],
        "requestedAt": int(row["requested_at_ms"]),
        "dueAt": int(row["due_at_ms"]),
        "verifiedVia": row["verified_via"],
        "reason": row["reason"],
        "completedAt": (
            int(row["completed_at_ms"]) if row["completed_at_ms"] is not None else None
        ),
        "counts": counts,
        "error": error,
    }


def request_deletion(
    user: dict,
    password: object,
    username: object,
    confirm: object,
    *,
    reason: object = None,
    request_id: str | None = None,
) -> dict:
    """提交删除申请：校验密码/用户名/确认词，进入 7 天冷静期并踢掉所有会话。"""
    if not isinstance(confirm, str) or confirm.strip() != DELETE_CONFIRM_WORD:
        raise ConfirmationInvalid(f"请输入确认词 {DELETE_CONFIRM_WORD}。")
    expected_username = user.get("username") or ""
    if not isinstance(username, str) or username.strip() != expected_username:
        raise ConfirmationInvalid("用户名或确认词不正确。")
    reason_text = _validate_reason(reason)
    check_password_or_raise("deletion_request", user, password)

    requested_at = now_ms()
    due_at = requested_at + COOLDOWN_MS
    conn = auth_db.connect()
    try:
        _require_tables(conn)
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT id, email, username, status, created_at FROM users "
                "WHERE id = ?",
                (user["id"],),
            ).fetchone()
            if row is None:
                raise UserNotFound("用户不存在。")
            current_status = row["status"] or "active"
            if current_status == "deletion_pending":
                raise DeletionAlreadyPending("删除申请已在冷静期中。")
            if current_status == "banned":
                raise DeletionNotPending("账号已被停用，无法提交删除申请。")
            if _is_last_active_admin(conn, row):
                raise LastAdmin("不能删除最后一个管理员；请先调整 ADMIN_EMAILS。")

            request_row_id = f"del-{uuid.uuid4().hex}"
            conn.execute(
                "INSERT INTO account_deletion_requests "
                "(id, user_id_hash, requested_at_ms, due_at_ms, status, "
                "verified_via, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    request_row_id,
                    hash_user_id(user["id"]),
                    requested_at,
                    due_at,
                    STATUS_PENDING,
                    VERIFIED_SESSION_PASSWORD,
                    reason_text,
                ),
            )
            conn.execute(
                "UPDATE users SET status = ? WHERE id = ?",
                ("deletion_pending", user["id"]),
            )
            # 立即断线：所有旧 Cookie 失效；用户重新登录后才能取消/导出。
            deleted_sessions = auth_db.delete_user_sessions(
                user["id"], conn=conn
            )
            write_audit(
                user["id"],
                "account.deletion.request",
                target_type="user",
                target_id=hash_user_id(user["id"]),
                detail={
                    "requestId": request_row_id,
                    "dueAt": due_at,
                    "verifiedVia": VERIFIED_SESSION_PASSWORD,
                    "sessionsRevoked": int(deleted_sessions or 0),
                },
                request_id=request_id,
                conn=conn,
                required=True,
            )
            conn.commit()
        except sqlite3.IntegrityError as exc:
            conn.rollback()
            if "account_deletion_requests" in str(exc) or "UNIQUE" in str(exc).upper():
                raise DeletionAlreadyPending("删除申请已在冷静期中。") from exc
            raise
        except Exception:
            conn.rollback()
            raise
    finally:
        conn.close()

    return {
        "status": "deletion_pending",
        "requestedAt": requested_at,
        "dueAt": due_at,
        "sessionsRevoked": True,
        "cooldownDays": COOLDOWN_DAYS,
        "backupRetentionDays": BACKUP_RETENTION_DAYS,
        "deletion": {
            "id": request_row_id,
            "status": STATUS_PENDING,
            "requestedAt": requested_at,
            "dueAt": due_at,
            "verifiedVia": VERIFIED_SESSION_PASSWORD,
            "reason": reason_text,
            "completedAt": None,
            "counts": None,
            "error": None,
        },
    }


def get_deletion_state(user_id: str) -> dict:
    """当前账号的删除状态与最近一次申请（登录用户查看到期日/取消入口）。"""
    conn = auth_db.connect()
    try:
        _require_tables(conn)
        user = conn.execute(
            "SELECT id, status FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if user is None:
            raise UserNotFound("用户不存在。")
        row = conn.execute(
            "SELECT id, status, requested_at_ms, due_at_ms, verified_via, reason, "
            "completed_at_ms, counts_json, error FROM account_deletion_requests "
            "WHERE user_id_hash = ? "
            "ORDER BY requested_at_ms DESC, id DESC LIMIT 1",
            (hash_user_id(user_id),),
        ).fetchone()
    finally:
        conn.close()

    user_status = user["status"] or "active"
    deletion = _request_public(row, include_error=False) if row is not None else None
    due_at = (
        deletion["dueAt"]
        if deletion is not None and user_status == "deletion_pending"
        else None
    )
    return {
        "status": user_status,
        "dueAt": due_at,
        "deletion": deletion,
        "cooldownDays": COOLDOWN_DAYS,
        "backupRetentionDays": BACKUP_RETENTION_DAYS,
        "notice": (
            "删除有 7 天冷静期，提交后立即停止 AI 调用与学习数据写入；"
            "到期执行后不可恢复。历史备份最长可能有 30 天残留，"
            "备份到期后才会自然消失。"
        ),
    }


def cancel_deletion(
    user: dict,
    password: object,
    *,
    request_id: str | None = None,
) -> dict:
    """冷静期内取消删除：密码确认 → 恢复 active；返回取消后的状态。"""
    check_password_or_raise("deletion_cancel", user, password)
    now = now_ms()
    conn = auth_db.connect()
    try:
        _require_tables(conn)
        try:
            conn.execute("BEGIN IMMEDIATE")
            # 只允许取消尚未执行过的 pending；failed 可能已删掉部分业务数据，
            # 恢复 active 会造成“账号回来了但数据没了”，交由管理员重试/支持处理。
            row = conn.execute(
                "SELECT id, status FROM account_deletion_requests "
                "WHERE user_id_hash = ? AND status = ? "
                "ORDER BY requested_at_ms DESC, id DESC LIMIT 1",
                (hash_user_id(user["id"]), STATUS_PENDING),
            ).fetchone()
            if row is None:
                user_row = conn.execute(
                    "SELECT status FROM users WHERE id = ?", (user["id"],)
                ).fetchone()
                if user_row is None:
                    raise UserNotFound("用户不存在。")
                raise DeletionNotPending("当前没有可取消的删除申请。")
            request_row_id = row["id"]
            previous_status = row["status"]
            conn.execute(
                "UPDATE account_deletion_requests "
                "SET status = ?, completed_at_ms = ? WHERE id = ?",
                (STATUS_CANCELLED, now, request_row_id),
            )
            conn.execute(
                "UPDATE users SET status = 'active' WHERE id = ?", (user["id"],)
            )
            write_audit(
                user["id"],
                "account.deletion.cancel",
                target_type="deletion_request",
                target_id=request_row_id,
                detail={"previousStatus": previous_status, "cancelledAt": now},
                request_id=request_id,
                conn=conn,
                required=True,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    finally:
        conn.close()
    return {
        "status": "active",
        "cancelledAt": now,
        "cooldownDays": COOLDOWN_DAYS,
        "backupRetentionDays": BACKUP_RETENTION_DAYS,
    }


# ---------------------------------------------------------------------------
# 管理员列表 / 到期执行
# ---------------------------------------------------------------------------

def list_deletion_requests(
    status: str = "all",
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """管理台删除请求列表：pending 行带 email/username，完成后只留 hash。"""
    status = (status or "all").strip().lower()
    if status != "all" and status not in REQUEST_STATUSES:
        raise LifecycleError("未知的删除申请状态。")
    limit = max(1, min(int(limit), 100))
    offset = max(0, min(int(offset), 100_000))

    conn = auth_db.connect()
    try:
        _require_tables(conn)
        where = "" if status == "all" else " WHERE status = ?"
        params: list[object] = [] if status == "all" else [status]
        total = int(
            conn.execute(
                f"SELECT COUNT(*) FROM account_deletion_requests{where}",
                tuple(params),
            ).fetchone()[0]
            or 0
        )
        rows = conn.execute(
            "SELECT id, user_id_hash, requested_at_ms, due_at_ms, status, "
            "verified_via, reason, operator_id, completed_at_ms, counts_json, error "
            f"FROM account_deletion_requests{where} "
            "ORDER BY requested_at_ms DESC, id DESC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
        users_by_hash: dict[str, dict] = {}
        for user_row in conn.execute(
            "SELECT id, email, username, status FROM users"
        ):
            users_by_hash[hash_user_id(str(user_row["id"]))] = {
                "email": user_row["email"],
                "username": user_row["username"],
                "status": user_row["status"],
                "userId": user_row["id"],
            }
    finally:
        conn.close()

    requests: list[dict] = []
    now = now_ms()
    for row in rows:
        item = _request_public(row)
        item["userIdHash"] = row["user_id_hash"]
        item["operatorId"] = row["operator_id"]
        item["overdue"] = (
            row["status"] == STATUS_PENDING and int(row["due_at_ms"]) <= now
        )
        # 明文 user id 只给管理员在「用户仍存在」时用于识别；完成后不留。
        item["user"] = users_by_hash.get(row["user_id_hash"])
        requests.append(item)
    return {
        "requests": requests,
        "total": total,
        "limit": limit,
        "offset": offset,
        "hasMore": offset + len(requests) < total,
        "serverTime": now,
    }


def list_due_deletions(now: int | None = None, limit: int = 100) -> list[dict]:
    """安全脚本用：已到期的 pending 申请（只返回 id/hash/时间）。"""
    moment = now_ms() if now is None else int(now)
    limit = max(1, min(int(limit), 500))
    conn = auth_db.connect()
    try:
        _require_tables(conn)
        rows = conn.execute(
            "SELECT id, user_id_hash, requested_at_ms, due_at_ms "
            "FROM account_deletion_requests "
            "WHERE status = ? AND due_at_ms <= ? "
            "ORDER BY due_at_ms ASC, id ASC LIMIT ?",
            (STATUS_PENDING, moment, limit),
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "id": row["id"],
            "userIdHash": row["user_id_hash"],
            "requestedAt": int(row["requested_at_ms"]),
            "dueAt": int(row["due_at_ms"]),
        }
        for row in rows
    ]


def _safe_delete_tree(root: str, target: str) -> dict:
    """删除 root 下的 target（realpath 必须仍在 root 内）；不跟随符号链接。

    返回 ``{files, bytes}``；目标不存在返回 0。路径越界/符号链接指向外部时
    抛 ``ValueError``，调用方负责转成可诊断错误。
    """
    root_real = os.path.realpath(root)
    target_real = os.path.realpath(target)
    if target_real == root_real or not target_real.startswith(root_real + os.sep):
        raise ValueError(f"拒绝删除数据目录外的路径：{target}")
    files = 0
    size = 0
    if os.path.islink(target):
        os.unlink(target)
        return {"files": 0, "bytes": 0}
    if os.path.isdir(target):
        for dirpath, dirnames, filenames in os.walk(target, followlinks=False):
            dirnames[:] = [
                name
                for name in dirnames
                if not os.path.islink(os.path.join(dirpath, name))
            ]
            for name in filenames:
                path = os.path.join(dirpath, name)
                try:
                    if os.path.islink(path):
                        files += 1
                    elif os.path.isfile(path):
                        files += 1
                        size += os.path.getsize(path)
                except OSError:
                    files += 1
        shutil.rmtree(target)
        return {"files": files, "bytes": size}
    if os.path.exists(target):
        try:
            size = os.path.getsize(target)
        except OSError:
            size = 0
        os.remove(target)
        return {"files": 1, "bytes": size}
    return {"files": 0, "bytes": 0}


def safe_export_path(relative_path: object) -> str:
    """把 ``data_export_jobs.file_path`` 解析成 EXPORTS_DIR 内的绝对路径。

    只接受相对路径；**不接收客户端路径**。任何绝对路径、``..`` 或 realpath
    越界都抛 ``ValueError``。
    """
    if not isinstance(relative_path, str) or not relative_path.strip():
        raise ValueError("导出文件路径为空。")
    if os.path.isabs(relative_path):
        raise ValueError("导出文件路径必须是相对路径。")
    root = os.path.realpath(config.EXPORTS_DIR)
    candidate = os.path.realpath(os.path.join(root, relative_path))
    if candidate == root or not candidate.startswith(root + os.sep):
        raise ValueError("导出文件路径越界。")
    return candidate


def _delete_export_files(user_id: str) -> dict:
    """删除该用户的导出临时文件与目录；返回文件数/字节与错误列表。"""
    result = {"files": 0, "bytes": 0, "errors": []}
    conn = auth_db.connect()
    try:
        if _table_exists(conn, _TABLE_EXPORT):
            rows = conn.execute(
                "SELECT id, file_path FROM data_export_jobs WHERE user_id = ?",
                (user_id,),
            ).fetchall()
        else:
            rows = []
    finally:
        conn.close()

    for row in rows:
        path = row["file_path"]
        if not path:
            continue
        try:
            absolute = safe_export_path(path)
        except ValueError as exc:
            result["errors"].append(f"job {row['id']}: {exc}")
            continue
        try:
            if os.path.isfile(absolute) or os.path.islink(absolute):
                try:
                    size = os.lstat(absolute).st_size
                except OSError:
                    size = 0
                os.remove(absolute)
                result["files"] += 1
                result["bytes"] += max(0, size)
        except OSError as exc:
            result["errors"].append(f"job {row['id']}: {exc}")

    try:
        measured = _safe_delete_tree(
            config.EXPORTS_DIR, os.path.join(config.EXPORTS_DIR, user_id)
        )
        result["files"] += measured["files"]
        result["bytes"] += measured["bytes"]
    except (OSError, ValueError) as exc:
        result["errors"].append(f"exports dir: {exc}")
    return result


def _delete_user_files(user_id: str) -> dict:
    """删除 ``data/users/<id>/`` 与 ``data/exports/<id>/``；备份/公共目录不动。"""
    result = {"files": 0, "bytes": 0, "errors": []}
    try:
        measured = _safe_delete_tree(
            config.USER_DATA_DIR, storage.user_data_dir(user_id)
        )
        result["files"] += measured["files"]
        result["bytes"] += measured["bytes"]
    except (OSError, ValueError) as exc:
        result["errors"].append(f"user dir: {exc}")

    export_result = _delete_export_files(user_id)
    result["files"] += export_result["files"]
    result["bytes"] += export_result["bytes"]
    result["errors"].extend(export_result["errors"])
    return result


def _count_delete(
    conn: sqlite3.Connection,
    counts: dict[str, int],
    table: str,
    sql: str,
    params: tuple,
) -> None:
    if not _table_exists(conn, table):
        counts[table] = counts.get(table, 0)
        return
    cursor = conn.execute(sql, params)
    counts[table] = counts.get(table, 0) + max(0, int(cursor.rowcount or 0))


def _delete_business_rows(
    conn: sqlite3.Connection, user_id: str
) -> dict[str, int]:
    """删除该用户可定位的业务行（不含 users / data_export_jobs）。

    顺序按依赖：先会话与子表，再父表；显式按 id/session 删除，不依赖 FK 级联。
    """
    counts: dict[str, int] = {}
    pseudo = events.pseudonym_for(user_id)

    # 1) 会话先断线（复用 auth_db.delete_user_sessions，与提交删除同一条路径）。
    counts["sessions"] = auth_db.delete_user_sessions(user_id, conn=conn)
    _count_delete(
        conn,
        counts,
        "invite_redemptions",
        "DELETE FROM invite_redemptions WHERE user_id = ?",
        (user_id,),
    )

    # 2) AI 用量 / 配额 / 余额流水与预占（M3a；余额属个人数据，随账号删除）。
    for table in ("ai_usage", "ai_quota", "account_ledger", "credit_holds"):
        _count_delete(
            conn,
            counts,
            table,
            f"DELETE FROM {table} WHERE user_id = ?",
            (user_id,),
        )

    # 3) 学习事件：明文 user_id 与假名双口径，避免迁移到纯假名后漏删。
    if _table_exists(conn, "learning_events"):
        if pseudo:
            cursor = conn.execute(
                "DELETE FROM learning_events "
                "WHERE user_id = ? OR pseudonym_id = ?",
                (user_id, pseudo),
            )
        else:
            cursor = conn.execute(
                "DELETE FROM learning_events WHERE user_id = ?", (user_id,)
            )
        counts["learning_events"] = max(0, int(cursor.rowcount or 0))

    # 4) 观看 / 周报。
    for table in ("watch_events", "weekly_reports"):
        _count_delete(
            conn,
            counts,
            table,
            f"DELETE FROM {table} WHERE user_id = ?",
            (user_id,),
        )

    # 5) 复习：word_sources 无 user_id，按 word_state_id 显式删。
    if _table_exists(conn, "word_sources") and _table_exists(conn, "word_states"):
        cursor = conn.execute(
            "DELETE FROM word_sources WHERE word_state_id IN "
            "(SELECT id FROM word_states WHERE user_id = ?)",
            (user_id,),
        )
        counts["word_sources"] = max(0, int(cursor.rowcount or 0))
    else:
        counts["word_sources"] = 0
    for table in ("review_logs", "word_states"):
        _count_delete(
            conn,
            counts,
            table,
            f"DELETE FROM {table} WHERE user_id = ?",
            (user_id,),
        )

    # 6) 理解题/练习：attempts → questions（按用户 content_item）→ content_items。
    _count_delete(
        conn, counts, "attempts", "DELETE FROM attempts WHERE user_id = ?", (user_id,)
    )
    if _table_exists(conn, "questions") and _table_exists(conn, "content_items"):
        cursor = conn.execute(
            "DELETE FROM questions WHERE content_item_id IN "
            "(SELECT id FROM content_items WHERE user_id = ?)",
            (user_id,),
        )
        counts["questions"] = max(0, int(cursor.rowcount or 0))
    else:
        counts["questions"] = 0
    _count_delete(
        conn,
        counts,
        "content_items",
        "DELETE FROM content_items WHERE user_id = ?",
        (user_id,),
    )

    # 7) 考试：answers 无 user_id，按 session 删。
    if _table_exists(conn, "exam_answers") and _table_exists(conn, "exam_sessions"):
        cursor = conn.execute(
            "DELETE FROM exam_answers WHERE session_id IN "
            "(SELECT id FROM exam_sessions WHERE user_id = ?)",
            (user_id,),
        )
        counts["exam_answers"] = max(0, int(cursor.rowcount or 0))
    else:
        counts["exam_answers"] = 0
    _count_delete(
        conn,
        counts,
        "exam_sessions",
        "DELETE FROM exam_sessions WHERE user_id = ?",
        (user_id,),
    )

    # 8) 定位测：answers 无 user_id，按 session 删。
    if _table_exists(conn, "placement_answers") and _table_exists(
        conn, "placement_sessions"
    ):
        cursor = conn.execute(
            "DELETE FROM placement_answers WHERE session_id IN "
            "(SELECT id FROM placement_sessions WHERE user_id = ?)",
            (user_id,),
        )
        counts["placement_answers"] = max(0, int(cursor.rowcount or 0))
    else:
        counts["placement_answers"] = 0
    for table in ("placement_sessions", "assessment_sessions"):
        _count_delete(
            conn,
            counts,
            table,
            f"DELETE FROM {table} WHERE user_id = ?",
            (user_id,),
        )

    # 9) 能力画像 / 证据。
    for table in ("skill_evidence", "user_skill_profiles", "user_profiles"):
        _count_delete(
            conn,
            counts,
            table,
            f"DELETE FROM {table} WHERE user_id = ?",
            (user_id,),
        )

    # 10) 阅读：译文/段落无 user_id，按用户文章 id 删。
    if _table_exists(conn, "articles"):
        for table in ("article_translations", "article_paragraphs"):
            if _table_exists(conn, table):
                cursor = conn.execute(
                    f"DELETE FROM {table} WHERE article_id IN "
                    "(SELECT id FROM articles WHERE user_id = ?)",
                    (user_id,),
                )
                counts[table] = max(0, int(cursor.rowcount or 0))
            else:
                counts[table] = 0
        _count_delete(
            conn,
            counts,
            "article_progress",
            "DELETE FROM article_progress WHERE user_id = ?",
            (user_id,),
        )
        _count_delete(
            conn,
            counts,
            "articles",
            "DELETE FROM articles WHERE user_id = ?",
            (user_id,),
        )
    else:
        for table in (
            "article_translations",
            "article_paragraphs",
            "article_progress",
            "articles",
        ):
            counts[table] = 0

    # 11) 导入书：译文按 book_id 先删；用户上传 EPUB 的私有目录在文件阶段删。
    if _table_exists(conn, "imported_book_translations") and _table_exists(
        conn, "imported_books"
    ):
        cursor = conn.execute(
            "DELETE FROM imported_book_translations WHERE book_id IN "
            "(SELECT id FROM imported_books WHERE user_id = ?)",
            (user_id,),
        )
        counts["imported_book_translations"] = max(0, int(cursor.rowcount or 0))
    else:
        counts["imported_book_translations"] = 0
    _count_delete(
        conn,
        counts,
        "imported_books",
        "DELETE FROM imported_books WHERE user_id = ?",
        (user_id,),
    )

    # 12) 课程：事件 → attempt → 本人生成课程（owner_user_id，非公共缓存）。
    for table in ("course_events", "course_attempts"):
        _count_delete(
            conn,
            counts,
            table,
            f"DELETE FROM {table} WHERE user_id = ?",
            (user_id,),
        )
    if _table_exists(conn, "generated_courses"):
        cursor = conn.execute(
            "DELETE FROM generated_courses WHERE owner_user_id = ?", (user_id,)
        )
        counts["generated_courses"] = max(0, int(cursor.rowcount or 0))
    else:
        counts["generated_courses"] = 0

    # 13) 任务 / 发现缓存 / 旧流水。
    for table in ("jobs", "discover_queries", "credit_transactions"):
        _count_delete(
            conn,
            counts,
            table,
            f"DELETE FROM {table} WHERE user_id = ?",
            (user_id,),
        )

    return counts


def _mark_failed(
    request_row_id: str,
    error: str,
    *,
    actor_id: str,
    counts: dict | None = None,
    http_request_id: str | None = None,
) -> None:
    """把申请标 failed（不覆盖 completed/cancelled），保留可诊断错误。"""
    error = (error or "unknown")[:MAX_ERROR_CHARS]
    conn = auth_db.connect()
    try:
        try:
            conn.execute("BEGIN IMMEDIATE")
            params: list[object] = [now_ms(), error]
            if counts is not None:
                counts_json = json.dumps(
                    counts, ensure_ascii=False, separators=(",", ":")
                )
                conn.execute(
                    "UPDATE account_deletion_requests "
                    "SET status = ?, completed_at_ms = ?, error = ?, "
                    "operator_id = COALESCE(operator_id, ?), counts_json = ? "
                    "WHERE id = ? AND status IN (?, ?)",
                    (
                        STATUS_FAILED,
                        *params,
                        actor_id,
                        counts_json,
                        request_row_id,
                        STATUS_PENDING,
                        STATUS_FAILED,
                    ),
                )
            else:
                conn.execute(
                    "UPDATE account_deletion_requests "
                    "SET status = ?, completed_at_ms = ?, error = ?, "
                    "operator_id = COALESCE(operator_id, ?) "
                    "WHERE id = ? AND status IN (?, ?)",
                    (
                        STATUS_FAILED,
                        *params,
                        actor_id,
                        request_row_id,
                        STATUS_PENDING,
                        STATUS_FAILED,
                    ),
                )
            write_audit(
                actor_id,
                "account.deletion.execute.failed",
                target_type="deletion_request",
                target_id=request_row_id,
                detail={"error": error[:MAX_ERROR_CHARS]},
                request_id=http_request_id,
                conn=conn,
                required=False,
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    finally:
        conn.close()


def _public_request_by_id(request_row_id: str) -> dict | None:
    conn = auth_db.connect()
    try:
        if not _table_exists(conn, _TABLE_DELETION):
            return None
        row = conn.execute(
            "SELECT id, status, requested_at_ms, due_at_ms, verified_via, reason, "
            "completed_at_ms, counts_json, error FROM account_deletion_requests "
            "WHERE id = ?",
            (request_row_id,),
        ).fetchone()
    finally:
        conn.close()
    return _request_public(row) if row is not None else None


def execute_deletion(
    request_row_id: str,
    operator_id: str,
    *,
    reason: str,
    force: bool = False,
    http_request_id: str | None = None,
) -> dict:
    """执行硬删除；失败标 failed 并抛 ``DeletionFailed``，绝不假装成功。

    ``force=False`` 时必须在 7 天冷静期到期后执行；管理员为用户明确要求
    立即删除时可传 ``force=True``（仍需填写原因，审计留痕）。
    """
    reason = (reason or "").strip() if isinstance(reason, str) else ""
    if not 1 <= len(reason) <= MAX_REASON_CHARS:
        raise InvalidReason(f"执行原因需要 1–{MAX_REASON_CHARS} 个字符。")

    with _EXECUTE_LOCK:
        conn = auth_db.connect()
        try:
            _require_tables(conn)
            request_row = conn.execute(
                "SELECT id, user_id_hash, requested_at_ms, due_at_ms, status "
                "FROM account_deletion_requests WHERE id = ?",
                (request_row_id,),
            ).fetchone()
            if request_row is None:
                raise DeletionNotFound("删除申请不存在。")
            if request_row["status"] == STATUS_COMPLETED:
                raise DeletionCompleted("删除申请已完成。")
            if request_row["status"] == STATUS_CANCELLED:
                raise DeletionNotPending("删除申请已取消，不能执行。")
            if (
                not force
                and int(request_row["due_at_ms"]) > now_ms()
            ):
                raise DeletionNotDue(
                    "冷静期尚未结束；如用户明确要求立即删除，请传 force=true。",
                    dueAt=int(request_row["due_at_ms"]),
                )
            user_id = _find_user_id_by_hash(conn, request_row["user_id_hash"])
            if user_id is None:
                _mark_failed(
                    request_row_id,
                    "user_not_found",
                    actor_id=operator_id,
                    http_request_id=http_request_id,
                )
                raise DeletionFailed("目标用户不存在，申请已标记 failed。")
            user_row = conn.execute(
                "SELECT id, email, username, status FROM users WHERE id = ?",
                (user_id,),
            ).fetchone()
            if user_row is None:
                _mark_failed(
                    request_row_id,
                    "user_not_found",
                    actor_id=operator_id,
                    http_request_id=http_request_id,
                )
                raise DeletionFailed("目标用户不存在，申请已标记 failed。")
            if (user_row["status"] or "active") != "deletion_pending":
                _mark_failed(
                    request_row_id,
                    f"user_status_not_pending:{user_row['status']}",
                    actor_id=operator_id,
                    http_request_id=http_request_id,
                )
                raise DeletionNotPending("用户已不在删除冷静期，申请标记为 failed。")
            if _is_last_active_admin(conn, user_row):
                _mark_failed(
                    request_row_id,
                    "last_admin",
                    actor_id=operator_id,
                    http_request_id=http_request_id,
                )
                raise LastAdmin("不能删除最后一个管理员；申请标记为 failed。")
        finally:
            conn.close()

        # ── 阶段 1：sessions + 业务表（一个事务） ─────────────────────────
        counts: dict = {}
        conn = auth_db.connect()
        try:
            try:
                conn.execute("BEGIN IMMEDIATE")
                # 事务内再次校验状态，避免和取消操作竞争。
                fresh_request = conn.execute(
                    "SELECT status FROM account_deletion_requests WHERE id = ?",
                    (request_row_id,),
                ).fetchone()
                if fresh_request is None or fresh_request["status"] not in (
                    STATUS_PENDING,
                    STATUS_FAILED,
                ):
                    raise DeletionNotPending("删除申请状态已变化，请刷新后重试。")
                fresh_user = conn.execute(
                    "SELECT status FROM users WHERE id = ?", (user_id,)
                ).fetchone()
                if fresh_user is None or (fresh_user["status"] or "active") != (
                    "deletion_pending"
                ):
                    raise DeletionNotPending("用户已不在删除冷静期。")
                counts = _delete_business_rows(conn, user_id)
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        except DeletionNotPending:
            _mark_failed(
                request_row_id,
                "state_changed",
                actor_id=operator_id,
                http_request_id=http_request_id,
            )
            raise
        except sqlite3.Error as exc:
            _mark_failed(
                request_row_id,
                f"db_business_delete_failed: {exc}",
                actor_id=operator_id,
                counts=counts,
                http_request_id=http_request_id,
            )
            raise DeletionFailed(f"删除业务数据失败：{exc}") from exc
        finally:
            conn.close()

        # ── 阶段 2：文件目录（失败可重试，不删 users） ───────────────────
        try:
            file_result = _delete_user_files(user_id)
        except Exception as exc:  # noqa: BLE001 - 文件错误必须转可诊断失败
            file_result = {"files": 0, "bytes": 0, "errors": [str(exc)]}
        counts["files"] = int(file_result["files"])
        counts["fileBytes"] = int(file_result["bytes"])
        if file_result["errors"]:
            error = "file_delete_failed: " + "; ".join(file_result["errors"])
            _mark_failed(
                request_row_id,
                error,
                actor_id=operator_id,
                counts=counts,
                http_request_id=http_request_id,
            )
            raise DeletionFailed(
                "文件目录删除失败，账号与申请保留为待重试：" + "; ".join(file_result["errors"])
            )

        # ── 阶段 3：导出任务行 + users 最后（一个事务） ──────────────────
        conn = auth_db.connect()
        try:
            try:
                conn.execute("BEGIN IMMEDIATE")
                fresh_request = conn.execute(
                    "SELECT status FROM account_deletion_requests WHERE id = ?",
                    (request_row_id,),
                ).fetchone()
                if fresh_request is None or fresh_request["status"] not in (
                    STATUS_PENDING,
                    STATUS_FAILED,
                ):
                    raise DeletionNotPending("删除申请状态已变化，请刷新后重试。")
                export_rows = conn.execute(
                    "DELETE FROM data_export_jobs WHERE user_id = ?", (user_id,)
                ).rowcount
                counts["data_export_jobs"] = max(0, int(export_rows or 0))
                deleted_user = conn.execute(
                    "DELETE FROM users WHERE id = ?", (user_id,)
                ).rowcount
                counts["users"] = max(0, int(deleted_user or 0))
                completed_at = now_ms()
                counts_json = json.dumps(
                    counts, ensure_ascii=False, separators=(",", ":")
                )
                conn.execute(
                    "UPDATE account_deletion_requests "
                    "SET status = ?, completed_at_ms = ?, operator_id = ?, "
                    "counts_json = ?, error = NULL, reason = NULL "
                    "WHERE id = ? AND status IN (?, ?)",
                    (
                        STATUS_COMPLETED,
                        completed_at,
                        operator_id,
                        counts_json,
                        request_row_id,
                        STATUS_PENDING,
                        STATUS_FAILED,
                    ),
                )
                write_audit(
                    operator_id,
                    "account.deletion.execute.completed",
                    target_type="deletion_request",
                    target_id=request_row_id,
                    detail={
                        "reason": reason,
                        "force": bool(force),
                        "completedAt": completed_at,
                        "counts": {
                            key: value
                            for key, value in counts.items()
                            if not key.startswith("_")
                        },
                    },
                    request_id=http_request_id,
                    conn=conn,
                    required=True,
                )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        except sqlite3.Error as exc:
            _mark_failed(
                request_row_id,
                f"db_final_delete_failed: {exc}",
                actor_id=operator_id,
                counts=counts,
                http_request_id=http_request_id,
            )
            raise DeletionFailed(f"删除最终数据失败：{exc}") from exc
        finally:
            conn.close()

    return {
        "status": STATUS_COMPLETED,
        "userIdHash": request_row["user_id_hash"],
        "counts": counts,
        "request": _public_request_by_id(request_row_id),
    }
