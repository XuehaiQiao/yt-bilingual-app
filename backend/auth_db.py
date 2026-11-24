"""用户与会话的 SQLite 存储 + Argon2 密码哈希。

表结构（契约定死）：

- `users(id TEXT PK, email TEXT UNIQUE, password_hash TEXT, created_at INT,
  username TEXT NULL, credits INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active')`
- `sessions(token_hash TEXT PK, user_id TEXT, expires_at INT, created_at INT)`

`username` / `credits` / `status` 由迁移 `0013_user_profile` 引入（见
`account.py` / specs/023）。这里保留的「连库即建表 + 补列」仍是旧部署/测试的
兼容路径，**新表一律走 Alembic**。

约定：

- email 统一 `strip().lower()` 后入库/查询；
- Cookie 里放 `secrets.token_urlsafe(32)` 生成的随机 token（>= 32 字节熵），
  库里只存它的 sha256 十六进制串——库泄露也拿不到可用的会话；
- 密码只存 Argon2id 哈希，任何日志都不打印密码；
- 会话过期行在写入新会话与读取到过期行时顺手清理。
"""
import contextlib
import hashlib
import os
import secrets
import sqlite3
import threading
import time
import uuid

import config
from argon2 import PasswordHasher
from argon2.exceptions import Argon2Error, InvalidHashError

# 30 天，与 Cookie Max-Age 保持一致。
SESSION_MAX_AGE = config.SESSION_MAX_AGE

# 登录时若邮箱不存在，也跑一次真实的 Argon2 校验，避免用响应时间探测账号是否存在。
# 这是一个固定的合法 Argon2id 哈希（明文不对应任何真实密码）。
_DUMMY_PASSWORD_HASH = (
    "$argon2id$v=19$m=65536,t=3,p=4$vsAausD0h7db0QPhyiScUg$"
    "vJww3r+C3yQgO9WdRerMyDztvKDAqbpzbOZGkomWN3g"
)

_hasher = PasswordHasher()

_schema_lock = threading.Lock()
_initialized_paths: set[str] = set()

_cleanup_lock = threading.Lock()
_last_cleanup = 0.0
_CLEANUP_INTERVAL_SECONDS = 60


class EmailExistsError(Exception):
    """注册时邮箱已存在（并发注册也由 UNIQUE 约束兜底）。"""


def hash_token(token: str) -> str:
    """会话 token 的入库形式：sha256 十六进制串。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def normalize_email(email: str) -> str:
    """邮箱统一小写（并去首尾空白），保证同一邮箱只有一种存储形式。"""
    return email.strip().lower()


def email_prefix_username(email: str) -> str:
    """旧客户端（注册不传 username）的回落显示名：email 的 `@` 前缀。

    不做长度/字符校验：这是兼容路径，不是新用户可主动选择的用户名；新注册
    带 username 时由 ``account.validate_username`` 严格校验。
    """
    local = normalize_email(email).split("@", 1)[0]
    return local or "user"


def connect() -> sqlite3.Connection:
    """打开数据库连接（含兼容建表/补列）；调用方负责 commit 与 close。"""
    return _connect()


def _db_path() -> str:
    return config.AUTH_DB_PATH


def _connect() -> sqlite3.Connection:
    path = _db_path()
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    _init_schema(conn, path)
    return conn


def _ensure_user_profile_columns(conn: sqlite3.Connection) -> None:
    """旧库兼容：补上 0013 三列 + 0025 余额列 + 0033 邮箱验证列（迁移仍是真源）。

    `CREATE TABLE IF NOT EXISTS` 不会改已存在的表；旧部署不跑迁移时直接 SELECT
    /INSERT 新列会报 "no such column"。这里只做幂等的 ADD COLUMN，保证「不跑
    迁移也能登录/注册」的兼容路径不断；生产仍应先 `alembic upgrade head`。
    """
    columns = {row[1] for row in conn.execute("PRAGMA table_info(users)")}
    if not columns:
        return
    if "username" not in columns:
        conn.execute("ALTER TABLE users ADD COLUMN username TEXT")
    if "credits" not in columns:
        conn.execute(
            "ALTER TABLE users ADD COLUMN credits INTEGER NOT NULL DEFAULT 0"
        )
    if "status" not in columns:
        conn.execute(
            "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"
        )
    # 0025（M3a）：余额列。旧部署不跑迁移也要能读余额/开户（迁移仍是真源）。
    if "balance_micro_usd" not in columns:
        conn.execute(
            "ALTER TABLE users ADD COLUMN balance_micro_usd "
            "INTEGER NOT NULL DEFAULT 0"
        )
    # 0033（v1.1）：邮箱验证时间列。旧库不跑迁移也要能登录/读 me（NULL =
    # 未验证；不强制验证），迁移仍是 schema 真源。
    if "email_verified_at" not in columns:
        conn.execute("ALTER TABLE users ADD COLUMN email_verified_at INTEGER")
    # 旧行回填显示名（与 0013 迁移同一口径）；新库/新用户不受影响。
    conn.execute(
        "UPDATE users SET username = CASE "
        "WHEN instr(email, '@') > 1 THEN substr(email, 1, instr(email, '@') - 1) "
        "ELSE email END "
        "WHERE username IS NULL"
    )


def _init_schema(conn: sqlite3.Connection, path: str) -> None:
    """users / sessions 的「连库即建表 + 补列」兼容路径。

    M1 起 schema 由 Alembic 管理（backend/migrations/，基线 0001_baseline 与本函数
    保持一致）。这里保留 `CREATE TABLE IF NOT EXISTS` 只为旧部署/测试/脚本不跑
    迁移也能工作；**新增表不要再加在这里**，否则迁移体系会出现两套真源。
    列级别的兼容例外是 0013 的 username/credits/status（见上）。
    """
    key = os.path.abspath(path)
    with _schema_lock:
        if key in _initialized_paths:
            return
        conn.executescript(
            """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                username TEXT,
                credits INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'active'
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_expires
                ON sessions(expires_at);
            """
        )
        _ensure_user_profile_columns(conn)
        conn.commit()
        _initialized_paths.add(key)


@contextlib.contextmanager
def _db():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    """显式建表（应用启动或运维自检时可以调用；连接时也会自动建）。"""
    _connect().close()


# ---------------------------------------------------------------------------
# 密码
# ---------------------------------------------------------------------------

def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """常量时间校验 Argon2 哈希；哈希损坏一律按失败处理（fail closed）。"""
    try:
        return bool(_hasher.verify(password_hash, password))
    except (Argon2Error, InvalidHashError, ValueError):
        return False


def _verify_dummy_password(password: str) -> None:
    """邮箱不存在时也消耗一次真实校验时间，避免账号枚举。"""
    verify_password(password, _DUMMY_PASSWORD_HASH)


# ---------------------------------------------------------------------------
# 用户
# ---------------------------------------------------------------------------

_USER_FIELDS = (
    "id, email, password_hash, username, credits, status, created_at, "
    "balance_micro_usd, email_verified_at"
)


def create_user(email: str, password: str, username: str | None = None) -> dict:
    """创建用户并返回用户行；邮箱重复抛 EmailExistsError。

    ``username`` 省略时回落 email 前缀（旧客户端/测试兼容；新注册的严格校验
    在 ``routes_auth.signup`` 里做）。

    这是**不带开户奖励**的底层建号（测试/脚本/旧路径）。需要 $2.00 开户奖励
    与同一事务流水的注册路径请用 :func:`create_user_with_bonus`（公开注册）
    或 ``invites.register_with_invite``（邀请码注册）。
    """
    email = normalize_email(email)
    user_id = uuid.uuid4().hex
    created_at = int(time.time())
    password_hash = hash_password(password)
    if username is None:
        username = email_prefix_username(email)
    try:
        with _db() as conn:
            conn.execute(
                "INSERT INTO users "
                "(id, email, password_hash, created_at, username, credits, status) "
                "VALUES (?, ?, ?, ?, ?, 0, 'active')",
                (user_id, email, password_hash, created_at, username),
            )
    except sqlite3.IntegrityError as exc:
        if "users.email" in str(exc) or "UNIQUE" in str(exc).upper():
            raise EmailExistsError(email) from exc
        raise
    return {
        "id": user_id,
        "email": email,
        "username": username,
        "credits": 0,
        "status": "active",
        "created_at": created_at,
    }


def create_user_with_bonus(
    email: str,
    password: str,
    username: str | None = None,
    *,
    with_session: bool = True,
) -> tuple[dict, str | None]:
    """公开注册的原子开户：建用户 + 发 $2.00 + 写流水（+ 建会话）。

    与 ``invites.register_with_invite`` 同一口径（项目提案 §5.3）：用户行、
    ``users.balance_micro_usd``、``account_ledger(signup_bonus)``、会话都在
    **同一个 ``BEGIN IMMEDIATE`` 事务**里提交；任何一步失败整笔回滚，不会出现
    「用户建了但余额没发」或「会话无效」。

    密码哈希在事务外算好（Argon2 慢，不能持有 SQLite 写锁）。返回
    ``(user, token|None)``；邮箱重复抛 :class:`EmailExistsError`。
    若数据库还没跑到 0025，``billing.ensure_schema_compat()`` 会先幂等补表
    （旧部署/测试兼容；生产仍应先跑迁移）。
    """
    from billing import ensure_schema_compat, signup_balance_micro_usd

    email = normalize_email(email)
    user_id = uuid.uuid4().hex
    created_at = int(time.time())
    password_hash = hash_password(password)
    if username is None:
        username = email_prefix_username(email)
    bonus = signup_balance_micro_usd()
    token = secrets.token_urlsafe(32) if with_session else None
    if with_session:
        # 低频注册顺便清过期会话（独立连接，别持有开户事务的写锁）。
        cleanup_expired_sessions(force=True)

    # 先保证金额表存在（幂等；已迁移库是 no-op）。
    ensure_schema_compat()

    from billing import write_signup_bonus

    now_ms = int(time.time() * 1000)
    conn = _connect()
    try:
        conn.isolation_level = None
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "INSERT INTO users "
                "(id, email, password_hash, created_at, username, credits, "
                "status, balance_micro_usd) "
                "VALUES (?, ?, ?, ?, ?, 0, 'active', ?)",
                (user_id, email, password_hash, created_at, username, bonus),
            )
            write_signup_bonus(conn, user_id, now_ms_value=now_ms)
            if token is not None:
                expires_at = created_at + SESSION_MAX_AGE
                conn.execute(
                    "INSERT INTO sessions "
                    "(token_hash, user_id, expires_at, created_at) "
                    "VALUES (?, ?, ?, ?)",
                    (hash_token(token), user_id, expires_at, created_at),
                )
            conn.execute("COMMIT")
        except sqlite3.IntegrityError as exc:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            if "users.email" in str(exc) or "UNIQUE" in str(exc).upper():
                raise EmailExistsError(email) from exc
            raise
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
    finally:
        conn.close()
    return (
        {
            "id": user_id,
            "email": email,
            "username": username,
            "credits": 0,
            "balance_micro_usd": bonus,
            "status": "active",
            "created_at": created_at,
        },
        token,
    )


def get_user_by_email(email: str) -> dict | None:
    with _db() as conn:
        row = conn.execute(
            f"SELECT {_USER_FIELDS} FROM users WHERE email = ?",
            (normalize_email(email),),
        ).fetchone()
    return dict(row) if row else None


def get_user_by_id(user_id: str) -> dict | None:
    with _db() as conn:
        row = conn.execute(
            f"SELECT {_USER_FIELDS} FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    return dict(row) if row else None


def authenticate(email: str, password: str) -> dict | None:
    """校验邮箱密码；成功返回公开用户字段 + ``status``，失败返回 None。

    ``status == 'banned'`` 的账号也会正常返回（密码正确时），由路由决定是否
    403——这样封禁文案不会与「密码错误」混在一起，也便于登录审计。
    """
    user = get_user_by_email(email)
    if user is None:
        # 账号不存在也做一次等价耗时的校验，响应时间不泄露邮箱是否注册。
        _verify_dummy_password(password)
        return None
    if not verify_password(password, user["password_hash"]):
        return None
    # 参数升级后自动重哈希（例如以后调高 Argon2 成本参数）。
    try:
        if _hasher.check_needs_rehash(user["password_hash"]):
            with _db() as conn:
                conn.execute(
                    "UPDATE users SET password_hash = ? WHERE id = ?",
                    (hash_password(password), user["id"]),
                )
    except (Argon2Error, InvalidHashError, ValueError):
        pass
    return {
        "id": user["id"],
        "email": user["email"],
        "username": user["username"],
        "credits": user["credits"],
        "balance_micro_usd": user.get("balance_micro_usd"),
        "status": user["status"],
        "email_verified_at": user.get("email_verified_at"),
    }


# ---------------------------------------------------------------------------
# 会话
# ---------------------------------------------------------------------------

def cleanup_expired_sessions(force: bool = False) -> None:
    """删除已过期会话；默认最多每 60 秒跑一次（避免每个请求都写库）。"""
    global _last_cleanup
    now = time.time()
    with _cleanup_lock:
        if not force and now - _last_cleanup < _CLEANUP_INTERVAL_SECONDS:
            return
        _last_cleanup = now
    with _db() as conn:
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(now),))


def create_session(user_id: str, max_age: int | None = None) -> str:
    """为用户创建会话，返回放进 Cookie 的原始 token（库里只存 sha256）。"""
    # 登录/注册是低频写操作，顺手强制清一次过期会话，避免过期行长期堆积。
    cleanup_expired_sessions(force=True)
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    expires_at = now + (SESSION_MAX_AGE if max_age is None else int(max_age))
    with _db() as conn:
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) "
            "VALUES (?, ?, ?, ?)",
            (hash_token(token), user_id, expires_at, now),
        )
    return token


def get_session(token: str) -> dict | None:
    """用原始 token 查会话；有效则返回当前用户公开字段，过期/不存在返回 None。

    返回的 dict 带 ``status``，身份中间件据此拒绝已封禁账号的旧会话（403）。
    """
    if not token:
        return None
    token_hash = hash_token(token)
    now = int(time.time())
    with _db() as conn:
        row = conn.execute(
            "SELECT s.user_id, s.expires_at, u.email, u.username, u.credits, "
            "u.status, u.balance_micro_usd, u.email_verified_at "
            "FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token_hash = ?",
            (token_hash,),
        ).fetchone()
        if row is None:
            return None
        if int(row["expires_at"]) <= now:
            conn.execute(
                "DELETE FROM sessions WHERE token_hash = ?", (token_hash,)
            )
            return None
    cleanup_expired_sessions()
    return {
        "id": row["user_id"],
        "email": row["email"],
        "username": row["username"],
        "credits": row["credits"],
        "balance_micro_usd": row["balance_micro_usd"],
        "status": row["status"],
        "email_verified_at": row["email_verified_at"],
    }


def delete_session(token: str) -> None:
    """登出：删除该 token 对应的会话行（重复登出不报错）。"""
    if not token:
        return
    with _db() as conn:
        conn.execute(
            "DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),)
        )


def delete_user_sessions(
    user_id: str, conn: sqlite3.Connection | None = None
) -> int:
    """删除某用户的全部会话，返回删除行数（M2a 删除申请/硬删除用）。

    传入 ``conn`` 时在调用方事务内执行（删除申请要与 users.status/审计同事务）；
    不传则自己开短事务。历史调用方忽略返回值即可。
    """
    if conn is not None:
        cursor = conn.execute(
            "DELETE FROM sessions WHERE user_id = ?", (user_id,)
        )
        return max(0, int(cursor.rowcount or 0))
    with _db() as own_conn:
        cursor = own_conn.execute(
            "DELETE FROM sessions WHERE user_id = ?", (user_id,)
        )
        return max(0, int(cursor.rowcount or 0))


# ---------------------------------------------------------------------------
# 账号找回 / 邮箱验证 token（v1.1 P0，迁移 0033_v1_1_launch）
#
# 表：``auth_tokens(id, user_id, purpose, token_hash, expires_at_ms,
# used_at_ms, created_at_ms, email)``。口径与 sessions 一致：
#
# - 明文 token 只出现在邮件/链接里，库里只存 ``sha256(token)``；
# - **单次消费**：``used_at_ms IS NULL`` 才可用，消费用条件 UPDATE 原子占位，
#   并发的两次确认只有一次成功（另一次按「已使用」拒绝）；
# - **过期**：``expires_at_ms <= now`` 拒绝；过期行在签发新 token 时顺手清理；
# - **限流**：路由按 IP/用户做内存限速，这里提供按邮箱的窗口计数（跨进程
#   仍有效的第二道闸）；
# - 表由 Alembic 管理（**不**在 ``_init_schema`` 里建）：未迁移的旧库调用这些
#   函数会抛 :class:`AuthTokensUnavailable`，由路由降级为「不发送但不报错/503」，
#   绝不让账号找回把登录/注册一起带崩。
# ---------------------------------------------------------------------------

PURPOSE_PASSWORD_RESET = "password_reset"
PURPOSE_EMAIL_VERIFY = "email_verify"
TOKEN_PURPOSES = (PURPOSE_PASSWORD_RESET, PURPOSE_EMAIL_VERIFY)

# 密码重置链接 30 分钟内有效；邮箱验证链接 24 小时。
PASSWORD_RESET_TTL_MS = 30 * 60 * 1000
EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000


class AuthTokensUnavailable(Exception):
    """``auth_tokens`` 表不存在（未跑 0033 迁移）；路由据此降级，不 500。"""


class AuthTokenInvalid(Exception):
    """token 不存在 / 用途不符 / 已使用。"""


class AuthTokenExpired(AuthTokenInvalid):
    """token 过期（HTTP 映射为 410，提示重新申请）。"""


def now_ms() -> int:
    """当前毫秒时间戳（账号找回相关时间列统一口径）。"""
    return int(time.time() * 1000)


def _require_auth_tokens(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = 'auth_tokens'"
    ).fetchone()
    if row is None:
        raise AuthTokensUnavailable(
            "auth_tokens 表未迁移（缺 0033_v1_1_launch）；"
            "请先运行 backend/venv/bin/alembic upgrade head。"
        )


def _cleanup_expired_auth_tokens(conn: sqlite3.Connection, now: int) -> None:
    """删除过期 token 行；未过期但已使用的行保留到过期（防重放）。"""
    conn.execute("DELETE FROM auth_tokens WHERE expires_at_ms <= ?", (now,))


def create_auth_token(
    email: str,
    purpose: str,
    user_id: str,
    *,
    ttl_ms: int,
) -> str:
    """签发一次性 token，返回明文（只发给邮件，不入库/不进日志）。

    调用方负责已经确认用户存在；``email`` 会规范化后与 user_id 一起入库。
    签发前顺手清理过期行。未迁移库抛 :class:`AuthTokensUnavailable`。
    """
    if purpose not in TOKEN_PURPOSES:
        raise ValueError(f"未知 token 用途：{purpose}")
    normalized = normalize_email(email)
    now = now_ms()
    raw = secrets.token_urlsafe(32)
    conn = _connect()
    try:
        _require_auth_tokens(conn)
        _cleanup_expired_auth_tokens(conn, now)
        conn.execute(
            "INSERT INTO auth_tokens "
            "(user_id, purpose, token_hash, expires_at_ms, used_at_ms, "
            "created_at_ms, email) "
            "VALUES (?, ?, ?, ?, NULL, ?, ?)",
            (
                user_id,
                purpose,
                hash_token(raw),
                now + max(0, int(ttl_ms)),
                now,
                normalized,
            ),
        )
        conn.commit()
    finally:
        conn.close()
    return raw


def count_recent_auth_tokens(
    email: str, purpose: str, *, window_ms: int
) -> int:
    """统计窗口内为该邮箱签发的 token 数（请求限流；跨进程有效）。"""
    normalized = normalize_email(email)
    cutoff = now_ms() - max(0, int(window_ms))
    conn = _connect()
    try:
        _require_auth_tokens(conn)
        row = conn.execute(
            "SELECT COUNT(*) FROM auth_tokens "
            "WHERE email = ? AND purpose = ? AND created_at_ms >= ?",
            (normalized, purpose, cutoff),
        ).fetchone()
        return int(row[0]) if row else 0
    finally:
        conn.close()


def consume_auth_token(token: str, purpose: str) -> dict:
    """原子消费 token；成功返回 ``{user_id, email, id}``。

    失败抛 :class:`AuthTokenInvalid`（不存在/用途不符/已使用）或
    :class:`AuthTokenExpired`（过期），未迁移库抛 :class:`AuthTokensUnavailable`。
    返回的 ``email`` 是签发时快照（用户可能已改邮箱，改密/验证请用 user_id）。
    """
    if not isinstance(token, str) or not token:
        raise AuthTokenInvalid("token 为空")
    token_hash = hash_token(token.strip())
    now = now_ms()
    conn = _connect()
    try:
        _require_auth_tokens(conn)
        row = conn.execute(
            "SELECT id, user_id, email, expires_at_ms, used_at_ms "
            "FROM auth_tokens WHERE token_hash = ? AND purpose = ?",
            (token_hash, purpose),
        ).fetchone()
        if row is None:
            raise AuthTokenInvalid("token 不存在")
        if row["used_at_ms"] is not None:
            raise AuthTokenInvalid("token 已使用")
        if int(row["expires_at_ms"]) <= now:
            raise AuthTokenExpired("token 已过期")
        cursor = conn.execute(
            "UPDATE auth_tokens SET used_at_ms = ? "
            "WHERE id = ? AND used_at_ms IS NULL",
            (now, row["id"]),
        )
        if int(cursor.rowcount or 0) == 0:
            # 并发消费：另一次请求抢到了。
            raise AuthTokenInvalid("token 已使用")
        conn.commit()
        return {
            "id": row["id"],
            "user_id": row["user_id"],
            "email": row["email"],
        }
    finally:
        conn.close()


def set_password_hash(
    user_id: str, password_hash: str, *, invalidate_sessions: bool = True
) -> bool:
    """写新密码哈希；``invalidate_sessions=True`` 时删除该用户全部会话。

    只影响被重置密码的这个用户，**不做全局会话批量失效**（其它用户不受影响）。
    返回用户行是否存在（并发硬删除后可能为 False）。
    """
    conn = _connect()
    try:
        cursor = conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (password_hash, user_id),
        )
        existed = bool(cursor.rowcount)
        conn.commit()
    finally:
        conn.close()
    if existed and invalidate_sessions:
        delete_user_sessions(user_id)
    return existed


def mark_email_verified(user_id: str) -> bool:
    """标记邮箱已验证；已有时间戳不覆盖，返回本次是否新写入。"""
    now = now_ms()
    conn = _connect()
    try:
        cursor = conn.execute(
            "UPDATE users SET email_verified_at = ? "
            "WHERE id = ? AND email_verified_at IS NULL",
            (now, user_id),
        )
        updated = bool(cursor.rowcount)
        conn.commit()
    finally:
        conn.close()
    return updated
