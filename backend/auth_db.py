"""用户与会话的 SQLite 存储 + Argon2 密码哈希。

表结构（契约定死）：

- `users(id TEXT PK, email TEXT UNIQUE, password_hash TEXT, created_at INT)`
- `sessions(token_hash TEXT PK, user_id TEXT, expires_at INT, created_at INT)`

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


def _init_schema(conn: sqlite3.Connection, path: str) -> None:
    """users / sessions 的「连库即建表」兼容路径。

    M1 起 schema 由 Alembic 管理（backend/migrations/，基线 0001_baseline 与本函数
    保持一致）。这里保留 `CREATE TABLE IF NOT EXISTS` 只为旧部署/测试/脚本不跑
    迁移也能工作；**新增表不要再加在这里**，否则迁移体系会出现两套真源。
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
                created_at INTEGER NOT NULL
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

def create_user(email: str, password: str) -> dict:
    """创建用户并返回 {id, email, created_at}；邮箱重复抛 EmailExistsError。"""
    email = normalize_email(email)
    user_id = uuid.uuid4().hex
    created_at = int(time.time())
    password_hash = hash_password(password)
    try:
        with _db() as conn:
            conn.execute(
                "INSERT INTO users (id, email, password_hash, created_at) "
                "VALUES (?, ?, ?, ?)",
                (user_id, email, password_hash, created_at),
            )
    except sqlite3.IntegrityError as exc:
        if "users.email" in str(exc) or "UNIQUE" in str(exc).upper():
            raise EmailExistsError(email) from exc
        raise
    return {"id": user_id, "email": email, "created_at": created_at}


def get_user_by_email(email: str) -> dict | None:
    with _db() as conn:
        row = conn.execute(
            "SELECT id, email, password_hash, created_at FROM users WHERE email = ?",
            (normalize_email(email),),
        ).fetchone()
    return dict(row) if row else None


def get_user_by_id(user_id: str) -> dict | None:
    with _db() as conn:
        row = conn.execute(
            "SELECT id, email, password_hash, created_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    return dict(row) if row else None


def authenticate(email: str, password: str) -> dict | None:
    """校验邮箱密码，成功返回 {id, email}；失败返回 None（不区分哪种失败）。"""
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
    return {"id": user["id"], "email": user["email"]}


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
    """用原始 token 查会话；有效则返回 {id, email}，过期/不存在返回 None。"""
    if not token:
        return None
    token_hash = hash_token(token)
    now = int(time.time())
    with _db() as conn:
        row = conn.execute(
            "SELECT s.user_id, s.expires_at, u.email "
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
    return {"id": row["user_id"], "email": row["email"]}


def delete_session(token: str) -> None:
    """登出：删除该 token 对应的会话行（重复登出不报错）。"""
    if not token:
        return
    with _db() as conn:
        conn.execute(
            "DELETE FROM sessions WHERE token_hash = ?", (hash_token(token),)
        )


def delete_user_sessions(user_id: str) -> None:
    """删除某用户的全部会话（改密/封禁等场景备用）。"""
    with _db() as conn:
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
