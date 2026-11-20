"""邀请码（M1 G1 邀请制）——生成、校验、兑换、管理与审计。

设计来源：`docs/项目提案-上线功能.md` §6 与 `specs/032-invite-registration`。

安全约定：

- 码由服务端 `secrets.choice` 生成，12 位 Crockford Base32（去掉 I/L/O/U），
  约 60 bit 熵；格式 `LN-XXXX-XXXX-XXXX`，人眼可读；
- 数据库只存 `HMAC-SHA256(INVITE_CODE_PEPPER, normalized)` 十六进制摘要；
  明文只在创建响应里出现一次，绝不写日志/不提供找回；
- 兑换用 `BEGIN IMMEDIATE` 串行化「校验 → used_count+1 → 插入 user →
  插入 redemption → 插入 session」，并发下不超发；任何一步失败整笔回滚，
  邀请码不会被消耗；
- 对外错误统一：缺码 `invite_required`、无效/过期/撤销/用尽/重复兑换
  `invite_invalid`；真实原因 `InviteError.reason` 只进服务端日志；
- 审计走结构化日志（`linguatrek.invites`），不建 `admin_audit` 大表；日志只
  含 actor / invite id / 前缀 / 次数 / 过期时间，不含明文码。

表由迁移 `0023_invite_registration` 创建；运行时**不建表**。未迁移的旧库调用
本模块抛 `InviteUnavailable`，路由转 503 并提示先跑迁移。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import secrets
import sqlite3
import time
import uuid
from typing import Any

import auth_db
import config

logger = logging.getLogger("linguatrek.invites")

# Crockford Base32：去掉 I/L/O/U，避免看错。32 个字符 = 5 bit/位。
CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE_CORE_LENGTH = 12  # 12 × 5 = 60 bit
PREFIX_LENGTH = 6  # 含 "LN" 前缀，管理台只用来辨认
CODE_INPUT_MAX = 64
LABEL_MAX_CHARS = 120
COUNT_MIN, COUNT_MAX = 1, 10
USES_MIN, USES_MAX = 1, 10
DAYS_MIN, DAYS_MAX = 1, 90
LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX = 20, 100

STATUSES = ("active", "used", "expired", "revoked")
STATUS_ALL = "all"

_INVITE_RE = re.compile(r"^LN[0-9A-Z]+$")

_CODES = "invite_codes"
_REDEMPTIONS = "invite_redemptions"


# ---------------------------------------------------------------------------
# 异常与配置
# ---------------------------------------------------------------------------

class InviteUnavailable(Exception):
    """邀请码表不存在（旧库没跑 0023 迁移）。"""


class InviteNotFound(Exception):
    """管理员按 id 操作时邀请码不存在。"""


class InviteBusy(Exception):
    """SQLite 在等待窗口内仍拿不到写锁；路由转 503，提示稍后再试。"""


class InviteError(Exception):
    """兑换失败；``reason`` 是稳定的内部错误码（不直接暴露给客户端）。

    可能值：``invalid_format`` / ``not_found`` / ``revoked`` / ``expired`` /
    ``exhausted`` / ``duplicate_redemption``。
    """

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def registration_status() -> dict[str, bool]:
    """公开的注册开关状态（不含任何密钥），供注册页/管理台只读展示。"""
    return {
        "registrationOpen": bool(config.REGISTRATION_OPEN),
        "inviteSignupEnabled": bool(config.INVITE_SIGNUP_ENABLED),
        "inviteRequired": bool(
            not config.REGISTRATION_OPEN and config.INVITE_SIGNUP_ENABLED
        ),
        "registrationClosed": bool(
            not config.REGISTRATION_OPEN and not config.INVITE_SIGNUP_ENABLED
        ),
    }


# ---------------------------------------------------------------------------
# 码的生成 / 归一化 / 哈希
# ---------------------------------------------------------------------------

def generate_code() -> str:
    """生成一个人类可读的邀请码明文（只在创建响应用一次）。"""
    core = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_CORE_LENGTH))
    return "LN-" + "-".join(core[i:i + 4] for i in range(0, len(core), 4))


def normalize_code(raw: object) -> str:
    """归一化：大写、去空格/连字符；缺少 ``LN`` 前缀时补上。

    非法输入抛 :class:`InviteError`（``invalid_format``）。归一化结果同时用于
    哈希与展示前缀，不会保存明文。
    """
    if not isinstance(raw, str):
        raise InviteError("invalid_format")
    compact = re.sub(r"[\s-]+", "", raw).upper()
    if not compact:
        return ""
    if not compact.startswith("LN"):
        compact = "LN" + compact
    if len(compact) > CODE_INPUT_MAX or not _INVITE_RE.fullmatch(compact):
        raise InviteError("invalid_format")
    return compact


def hash_code(normalized: str) -> str:
    """邀请码的入库摘要：HMAC-SHA256(pepper, normalized) 十六进制。"""
    pepper = (config.INVITE_CODE_PEPPER or "").encode("utf-8")
    return hmac.new(pepper, normalized.encode("utf-8"), hashlib.sha256).hexdigest()


def code_prefix(normalized: str) -> str:
    """前 6 位（含 LN），仅供管理台人工辨认。"""
    return normalized[:PREFIX_LENGTH]


# ---------------------------------------------------------------------------
# SQLite 连接 / 表存在性
# ---------------------------------------------------------------------------

def _connect() -> sqlite3.Connection:
    return auth_db.connect()


def _table_names(conn: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name IN (?, ?)",
            (_CODES, _REDEMPTIONS),
        )
    }


def _require_tables(conn: sqlite3.Connection) -> None:
    if {_CODES, _REDEMPTIONS} <= _table_names(conn):
        return
    raise InviteUnavailable("邀请码表不存在：请先运行 alembic upgrade head（0023）")


def _now_ms(now_ms: int | None = None) -> int:
    return int(time.time() * 1000) if now_ms is None else int(now_ms)


# ---------------------------------------------------------------------------
# 参数校验
# ---------------------------------------------------------------------------

def _as_int(value: object, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} 必须是整数。")
    if value < minimum or value > maximum:
        raise ValueError(f"{name} 必须在 {minimum}–{maximum} 之间。")
    return value


def _clean_label(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("label 必须是字符串。")
    label = value.strip()
    if not label:
        return None
    if len(label) > LABEL_MAX_CHARS:
        raise ValueError(f"label 最多 {LABEL_MAX_CHARS} 个字符。")
    return label


def _public_row(row: sqlite3.Row, now_ms: int) -> dict[str, Any]:
    """管理台可见字段：不含 code_hash / 完整码。"""
    revoked_at = row["revoked_at_ms"]
    expires_at = row["expires_at_ms"]
    used_count = int(row["used_count"] or 0)
    max_uses = int(row["max_uses"] or 0)
    if revoked_at is not None:
        status = "revoked"
    elif expires_at is not None and expires_at <= now_ms:
        status = "expired"
    elif used_count >= max_uses:
        status = "used"
    else:
        status = "active"
    return {
        "id": row["id"],
        "prefix": row["code_prefix"],
        "label": row["label"],
        "maxUses": max_uses,
        "usedCount": used_count,
        "status": status,
        "createdBy": row["created_by"],
        "createdAt": int(row["created_at_ms"]),
        "expiresAt": None if expires_at is None else int(expires_at),
        "revokedAt": None if revoked_at is None else int(revoked_at),
        "revokedBy": row["revoked_by"],
        "lastUsedAt": (
            None if row["last_used_at_ms"] is None else int(row["last_used_at_ms"])
        ),
    }


def _audit(event: str, **fields: Any) -> None:
    """结构化审计日志；message 是 JSON，便于 observability 摊平成一行。"""
    payload = {"event": event, **fields}
    logger.info(json.dumps(payload, ensure_ascii=False, default=str))


# ---------------------------------------------------------------------------
# 管理员：创建 / 列表 / 撤销
# ---------------------------------------------------------------------------

def create_invites(
    created_by: str,
    *,
    count: int = 1,
    label: object = None,
    max_uses: object = None,
    expires_in_days: object = None,
    now_ms: int | None = None,
) -> list[dict[str, Any]]:
    """创建 1–10 个邀请码；返回**仅此一次**的明文列表。

    默认值来自 ``INVITE_CODE_TTL_DAYS`` / ``INVITE_CODE_MAX_USES``。
    """
    if not isinstance(created_by, str) or not created_by.strip():
        raise ValueError("created_by 不能为空。")
    count = _as_int(count, "count", COUNT_MIN, COUNT_MAX)
    max_uses = _as_int(
        config.INVITE_CODE_MAX_USES if max_uses is None else max_uses,
        "maxUses",
        USES_MIN,
        USES_MAX,
    )
    expires_in_days = _as_int(
        config.INVITE_CODE_TTL_DAYS
        if expires_in_days is None
        else expires_in_days,
        "expiresInDays",
        DAYS_MIN,
        DAYS_MAX,
    )
    note = _clean_label(label)
    now = _now_ms(now_ms)
    expires_at = now + expires_in_days * 24 * 60 * 60 * 1000

    # 先全部生成再进事务：减少锁持有时长，也便于一次审计。
    generated: list[dict[str, Any]] = []
    for _ in range(count):
        code = generate_code()
        normalized = normalize_code(code)
        generated.append(
            {
                "id": f"inv-{uuid.uuid4().hex}",
                "code": code,
                "code_hash": hash_code(normalized),
                "prefix": code_prefix(normalized),
            }
        )

    conn = _connect()
    try:
        _require_tables(conn)
        conn.isolation_level = None
        try:
            conn.execute("BEGIN IMMEDIATE")
            for item in generated:
                conn.execute(
                    "INSERT INTO invite_codes "
                    "(id, code_hash, code_prefix, label, max_uses, used_count, "
                    " expires_at_ms, revoked_at_ms, revoked_by, created_by, "
                    " created_at_ms, last_used_at_ms) "
                    "VALUES (?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?, NULL)",
                    (
                        item["id"],
                        item["code_hash"],
                        item["prefix"],
                        note,
                        max_uses,
                        expires_at,
                        created_by.strip(),
                        now,
                    ),
                )
            conn.execute("COMMIT")
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
    except sqlite3.OperationalError as exc:
        if "locked" in str(exc).lower() or "busy" in str(exc).lower():
            raise InviteBusy(str(exc)) from exc
        raise
    finally:
        conn.close()

    _audit(
        "admin.invite.create",
        actor=created_by.strip(),
        count=count,
        ids=[item["id"] for item in generated],
        prefixes=[item["prefix"] for item in generated],
        maxUses=max_uses,
        expiresAt=expires_at,
        label=note,
    )
    return [
        {
            "id": item["id"],
            "code": item["code"],
            "prefix": item["prefix"],
            "label": note,
            "maxUses": max_uses,
            "usedCount": 0,
            "createdAt": now,
            "expiresAt": expires_at,
        }
        for item in generated
    ]


def _status_where(status: str, now_ms: int) -> tuple[str, tuple[Any, ...]]:
    """状态筛选 SQL（撤销优先于过期，过期优先于已用完）。"""
    if status == STATUS_ALL:
        return "1=1", ()
    if status == "revoked":
        return "revoked_at_ms IS NOT NULL", ()
    if status == "expired":
        return (
            "revoked_at_ms IS NULL AND expires_at_ms IS NOT NULL "
            "AND expires_at_ms <= ?",
            (now_ms,),
        )
    if status == "used":
        return (
            "revoked_at_ms IS NULL "
            "AND (expires_at_ms IS NULL OR expires_at_ms > ?) "
            "AND used_count >= max_uses",
            (now_ms,),
        )
    if status == "active":
        return (
            "revoked_at_ms IS NULL "
            "AND (expires_at_ms IS NULL OR expires_at_ms > ?) "
            "AND used_count < max_uses",
            (now_ms,),
        )
    raise ValueError("status 必须是 all/active/used/expired/revoked。")


def list_invites(
    *,
    status: str = STATUS_ALL,
    limit: int = LIST_LIMIT_DEFAULT,
    offset: int = 0,
    now_ms: int | None = None,
) -> dict[str, Any]:
    """管理台列表：只返回脱敏字段；支持状态过滤与分页。"""
    if status not in (*STATUSES, STATUS_ALL):
        raise ValueError("status 必须是 all/active/used/expired/revoked。")
    limit = _as_int(limit, "limit", 1, LIST_LIMIT_MAX)
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError("offset 必须是 >= 0 的整数。")
    now = _now_ms(now_ms)
    where, params = _status_where(status, now)

    conn = _connect()
    try:
        _require_tables(conn)
        counts: dict[str, int] = {}
        for name in STATUSES:
            count_where, count_params = _status_where(name, now)
            row = conn.execute(
                f"SELECT COUNT(*) FROM {_CODES} WHERE {count_where}", count_params
            ).fetchone()
            counts[name] = int(row[0] or 0)
        total_row = conn.execute(
            f"SELECT COUNT(*) FROM {_CODES} WHERE {where}", params
        ).fetchone()
        total = int(total_row[0] or 0)
        rows = conn.execute(
            f"SELECT * FROM {_CODES} WHERE {where} "
            "ORDER BY created_at_ms DESC, id DESC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
    finally:
        conn.close()

    invites = [_public_row(row, now) for row in rows]
    return {
        "invites": invites,
        "total": total,
        "limit": limit,
        "offset": offset,
        "hasMore": offset + len(invites) < total,
        "status": status,
        "counts": counts,
    }


def revoke_invite(
    invite_id: str,
    revoked_by: str,
    *,
    now_ms: int | None = None,
) -> dict[str, Any]:
    """撤销邀请码（幂等）。已撤销时返回 ``alreadyRevoked: true``。"""
    if not isinstance(invite_id, str) or not invite_id.strip():
        raise ValueError("invite_id 不能为空。")
    if not isinstance(revoked_by, str) or not revoked_by.strip():
        raise ValueError("revoked_by 不能为空。")
    now = _now_ms(now_ms)
    conn = _connect()
    try:
        _require_tables(conn)
        conn.isolation_level = None
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                f"SELECT * FROM {_CODES} WHERE id = ?", (invite_id.strip(),)
            ).fetchone()
            if row is None:
                raise InviteNotFound(invite_id)
            already = row["revoked_at_ms"] is not None
            if not already:
                conn.execute(
                    f"UPDATE {_CODES} SET revoked_at_ms = ?, revoked_by = ? "
                    "WHERE id = ?",
                    (now, revoked_by.strip(), invite_id.strip()),
                )
                row = conn.execute(
                    f"SELECT * FROM {_CODES} WHERE id = ?", (invite_id.strip(),)
                ).fetchone()
            conn.execute("COMMIT")
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
    except sqlite3.OperationalError as exc:
        if "locked" in str(exc).lower() or "busy" in str(exc).lower():
            raise InviteBusy(str(exc)) from exc
        raise
    finally:
        conn.close()

    _audit(
        "admin.invite.revoke",
        actor=revoked_by.strip(),
        id=invite_id.strip(),
        prefix=row["code_prefix"],
        already=already,
    )
    return {
        "invite": _public_row(row, now),
        "alreadyRevoked": bool(already),
    }


# ---------------------------------------------------------------------------
# 注册兑换（事务内调用）
# ---------------------------------------------------------------------------

def redeem_invite(
    conn: sqlite3.Connection,
    invite_code: object,
    user_id: str,
    *,
    now_ms: int | None = None,
) -> dict[str, Any]:
    """在调用方的 ``BEGIN IMMEDIATE`` 事务里校验并占用一个邀请码。

    成功返回邀请码行（含 ``id`` / ``code_prefix``），并把 ``used_count`` 原子
    加一；**不**插入 redemption（那是 user 创建成功之后的事），也**不** commit。
    任何失败抛 :class:`InviteError`，由调用方回滚整笔事务。
    """
    normalized = normalize_code(invite_code)
    if not normalized:
        raise InviteError("invalid_format")
    now = _now_ms(now_ms)
    digest = hash_code(normalized)
    row = conn.execute(
        f"SELECT * FROM {_CODES} WHERE code_hash = ?", (digest,)
    ).fetchone()
    if row is None:
        raise InviteError("not_found")

    invite_id = row["id"]
    if row["revoked_at_ms"] is not None:
        raise InviteError("revoked")
    expires_at = row["expires_at_ms"]
    if expires_at is not None and int(expires_at) <= now:
        raise InviteError("expired")
    if int(row["used_count"] or 0) >= int(row["max_uses"] or 0):
        raise InviteError("exhausted")
    duplicate = conn.execute(
        f"SELECT 1 FROM {_REDEMPTIONS} WHERE invite_id = ? AND user_id = ?",
        (invite_id, user_id),
    ).fetchone()
    if duplicate is not None:
        raise InviteError("duplicate_redemption")

    updated = conn.execute(
        f"UPDATE {_CODES} SET used_count = used_count + 1, last_used_at_ms = ? "
        "WHERE id = ? AND revoked_at_ms IS NULL AND used_count < max_uses "
        "AND (expires_at_ms IS NULL OR expires_at_ms > ?)",
        (now, invite_id, now),
    )
    if updated.rowcount != 1:
        # 并发下另一个事务先占用了最后一个名额。
        raise InviteError("exhausted")
    return dict(row)


def register_with_invite(
    email: str,
    password_hash: str,
    username: str,
    invite_code: object,
    *,
    now_ms: int | None = None,
) -> tuple[dict[str, Any], str]:
    """原子注册：占用邀请码 → 建 user → 写 redemption → 建 session。

    密码哈希由调用方在事务外算好（Argon2 慢，不能持有 SQLite 写锁）。
    邮箱重复抛 :class:`auth_db.EmailExistsError`；邀请码失败抛
    :class:`InviteError`。两类失败都会回滚，邀请码不会被消耗。
    """
    email = auth_db.normalize_email(email)
    now = _now_ms(now_ms)
    user_id = uuid.uuid4().hex
    token = secrets.token_urlsafe(32)
    token_hash = auth_db.hash_token(token)
    now_seconds = now // 1000
    expires_at = now_seconds + auth_db.SESSION_MAX_AGE
    username = username or auth_db.email_prefix_username(email)

    # 低频注册顺便清理过期会话（独立连接，别持有邀请码事务锁）。
    auth_db.cleanup_expired_sessions(force=True)

    conn = _connect()
    try:
        _require_tables(conn)
        conn.isolation_level = None
        try:
            conn.execute("BEGIN IMMEDIATE")
            redeemed = redeem_invite(
                conn, invite_code, user_id, now_ms=now
            )
            try:
                conn.execute(
                    "INSERT INTO users "
                    "(id, email, password_hash, created_at, username, credits, status) "
                    "VALUES (?, ?, ?, ?, ?, 0, 'active')",
                    (user_id, email, password_hash, now_seconds, username),
                )
            except sqlite3.IntegrityError as exc:
                raise auth_db.EmailExistsError(email) from exc
            conn.execute(
                f"INSERT INTO {_REDEMPTIONS} "
                "(id, invite_id, user_id, redeemed_at_ms) VALUES (?, ?, ?, ?)",
                (f"red-{uuid.uuid4().hex}", redeemed["id"], user_id, now),
            )
            conn.execute(
                "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) "
                "VALUES (?, ?, ?, ?)",
                (token_hash, user_id, expires_at, now_seconds),
            )
            conn.execute("COMMIT")
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
    except sqlite3.OperationalError as exc:
        if "locked" in str(exc).lower() or "busy" in str(exc).lower():
            raise InviteBusy(str(exc)) from exc
        raise
    finally:
        conn.close()

    return (
        {
            "id": user_id,
            "email": email,
            "username": username,
            "credits": 0,
            "status": "active",
            "created_at": now_seconds,
            "invite_prefix": redeemed["code_prefix"],
        },
        token,
    )
