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
    """旧库兼容：补上 0013 引入的三列（迁移仍是 schema 真源）。

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

_USER_FIELDS = "id, email, password_hash, username, credits, status, created_at"


def create_user(email: str, password: str, username: str | None = None) -> dict:
    """创建用户并返回用户行；邮箱重复抛 EmailExistsError。

    ``username`` 省略时回落 email 前缀（旧客户端/测试兼容；新注册的严格校验
    在 ``routes_auth.signup`` 里做）。余额默认 0、状态默认 active。
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
        "status": user["status"],
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
            "u.status "
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
        "status": row["status"],
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
