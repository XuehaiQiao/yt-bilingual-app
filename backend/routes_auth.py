"""认证路由：注册 / 登录 / 登出 / 当前用户。

冻结契约（前端并行开发，不要改字段与状态码）：

- POST /api/auth/signup  {"email","password"} -> 201 {"user":{"id","email"}} + Cookie
- POST /api/auth/login   {"email","password"} -> 200 {"user":{"id","email"}} + Cookie
- POST /api/auth/logout                        -> 200 {"ok": true} + 清除 Cookie
- GET  /api/auth/me                            -> 200 {"user":{"id","email"}} / 401 {"detail":"未登录"}

Cookie：`ln_session`，httpOnly、SameSite=Lax、Path=/、Max-Age 30 天；
`Secure` 由 `COOKIE_SECURE=1` 控制（本地 HTTP 默认关）。
"""
import re
import threading
import time

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

import auth_db
import config

router = APIRouter(prefix="/api/auth", tags=["auth"])

COOKIE_NAME = "ln_session"

# 登录失败限流：每个 IP 60 秒内最多失败这么多次（内存实现，进程重启即清空）。
LOGIN_WINDOW_SECONDS = 60
LOGIN_MAX_FAILURES = 10

_login_failures: dict[str, list[float]] = {}
_login_lock = threading.Lock()

# 只做「像邮箱」的基本校验，不引入 email-validator 依赖；不追求 RFC 全量。
_EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@"
    r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$"
)

MIN_PASSWORD_LENGTH = 8


class Credentials(BaseModel):
    email: str
    password: str


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _prune_failures(ip: str, now: float) -> list[float]:
    cutoff = now - LOGIN_WINDOW_SECONDS
    attempts = [ts for ts in _login_failures.get(ip, []) if ts > cutoff]
    if attempts:
        _login_failures[ip] = attempts
    else:
        _login_failures.pop(ip, None)
    return attempts


def _is_rate_limited(ip: str) -> bool:
    now = time.time()
    with _login_lock:
        return len(_prune_failures(ip, now)) >= LOGIN_MAX_FAILURES


def _record_login_failure(ip: str) -> None:
    now = time.time()
    with _login_lock:
        _login_failures.setdefault(ip, []).append(now)
        _prune_failures(ip, now)


def _clear_login_failures(ip: str) -> None:
    with _login_lock:
        _login_failures.pop(ip, None)


def reset_login_throttle() -> None:
    """清空限流计数（测试用；运维也可在排查时调用）。"""
    with _login_lock:
        _login_failures.clear()


def _validate_signup(email: str, password: str) -> str:
    """注册参数校验：邮箱格式 / 密码 >= 8；返回规范化后的邮箱。"""
    email = auth_db.normalize_email(email)
    if (
        not email
        or len(email) > 254
        or "@" not in email
        or not _EMAIL_RE.match(email)
    ):
        raise HTTPException(status_code=400, detail="邮箱格式不正确。")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(status_code=400, detail="密码至少需要 8 个字符。")
    return email


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=auth_db.SESSION_MAX_AGE,
        httponly=True,
        secure=config.COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=COOKIE_NAME,
        path="/",
        httponly=True,
        secure=config.COOKIE_SECURE,
        samesite="lax",
    )


def _public_user(user: dict) -> dict:
    """只暴露契约里的字段，绝不把 password_hash 带出。"""
    return {"id": user["id"], "email": user["email"]}


@router.post("/signup", status_code=201)
def signup(credentials: Credentials, response: Response):
    email = _validate_signup(credentials.email, credentials.password)
    try:
        user = auth_db.create_user(email, credentials.password)
    except auth_db.EmailExistsError:
        raise HTTPException(status_code=409, detail="邮箱已注册。")
    token = auth_db.create_session(user["id"])
    set_session_cookie(response, token)
    return {"user": _public_user(user)}


@router.post("/login")
def login(credentials: Credentials, request: Request, response: Response):
    # 登录不校验邮箱格式：格式错误/账号不存在/密码错误统一 401，不泄露账号状态。
    ip = _client_ip(request)
    if _is_rate_limited(ip):
        raise HTTPException(status_code=429, detail="尝试过于频繁，请稍后再试。")
    email = auth_db.normalize_email(credentials.email)
    user = auth_db.authenticate(email, credentials.password)
    if user is None:
        _record_login_failure(ip)
        raise HTTPException(status_code=401, detail="邮箱或密码错误。")
    _clear_login_failures(ip)
    token = auth_db.create_session(user["id"])
    set_session_cookie(response, token)
    return {"user": _public_user(user)}


@router.post("/logout")
def logout(request: Request, response: Response):
    auth_db.delete_session(request.cookies.get(COOKIE_NAME, ""))
    clear_session_cookie(response)
    return {"ok": True}


@router.get("/me")
def me(request: Request):
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="未登录")
    return {"user": _public_user(user)}
