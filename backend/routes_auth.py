"""认证路由：注册 / 登录 / 登出 / 当前用户 / 游客认领。

冻结契约（前端并行开发，不要改字段与状态码）：

- POST /api/auth/signup  {"email","password"} -> 201 {"user":{"id","email"}} + Cookie
- POST /api/auth/login   {"email","password"} -> 200 {"user":{"id","email"}} + Cookie
- POST /api/auth/logout                        -> 200 {"ok": true} + 清除 Cookie
- GET  /api/auth/me                            -> 200 {"user":{"id","email"}}
                                                  或 200 {"user": null, "guest": true}
- POST /api/auth/claim-guest（需登录）          -> 200 {"ok":true,"claimed":bool,
                                                  "merged":{history,favorites,subscriptions},
                                                  "skipped":{...},"guestFiles":int}
                                                  未登录 -> 401 {"detail":"未登录"}

Cookie：`ln_session`，httpOnly、SameSite=Lax、Path=/、Max-Age 30 天；
`Secure` 由 `COOKIE_SECURE=1` 控制（本地 HTTP 默认关）。游客 Cookie `ln_guest`
由 `main.py` 的中间件下发/校验（见 guest.py），本模块只在认领成功后清除它。
"""
import logging
import re
import threading
import time

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

import auth_db
import auth_lockout
import config
import guest
import placement

logger = logging.getLogger("linguatrek.auth")

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
    """清空限流与失败锁定状态（测试用；运维也可在排查误封时调用）。"""
    with _login_lock:
        _login_failures.clear()
    auth_lockout.reset()


def _lockout_error(status: auth_lockout.LockStatus) -> HTTPException:
    """锁定响应统一 429 + Retry-After；账号/IP 两个维度用同一文案。"""
    return HTTPException(
        status_code=429,
        detail=f"登录尝试次数过多，已暂时锁定，请 {status.retry_after} 秒后再试。",
        headers={
            "Retry-After": str(status.retry_after),
            "Cache-Control": "no-store",
        },
    )


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
        # 与全局限速中间件保持同一契约：429 必须带 Retry-After（固定窗口整窗）。
        raise HTTPException(
            status_code=429,
            detail="尝试过于频繁，请稍后再试。",
            headers={"Retry-After": str(LOGIN_WINDOW_SECONDS)},
        )
    email = auth_db.normalize_email(credentials.email)

    # 连续失败锁定（账号 + IP）：先于密码校验，锁定期间即使密码正确也拒绝。
    # 不存在的邮箱同样计数/锁定，响应与真实账号一致，不泄露账号是否存在。
    locked = auth_lockout.check(email, ip)
    if locked is not None:
        raise _lockout_error(locked)

    user = auth_db.authenticate(email, credentials.password)
    if user is None:
        _record_login_failure(ip)
        auth_lockout.record_failure(email, ip)
        raise HTTPException(status_code=401, detail="邮箱或密码错误。")
    _clear_login_failures(ip)
    auth_lockout.clear(email, ip)
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
    """当前身份：登录用户返回 user + isAdmin；否则游客态 `{user:null, guest:true}`。

    游客态不再返回 401——前端据此直接进入游客模式（不拦登录页），并在需要
    保存/收藏时提示登录。`ln_guest` 由 main.py 的中间件在首次访问时下发。

    `isAdmin` 只加在登录分支的**顶层**（不塞进 user 对象，保持
    ``{"user":{"id","email"}}`` 冻结契约不变）；游客分支也保持原样，避免
    给公开响应增加字段。管理员名单来自 ``config.ADMIN_EMAILS``。
    """
    user = getattr(request.state, "user", None)
    if not user:
        return {"user": None, "guest": True}
    return {
        "user": _public_user(user),
        "isAdmin": config.is_admin_email(user["email"]),
    }


@router.post("/claim-guest")
def claim_guest(request: Request, response: Response):
    """把 `ln_guest` 对应的游客数据幂等认领到当前登录账号。

    合并 `history/`、`favorites.json`、`subscriptions.json`：同 videoId / 同收藏
    指纹 / 同订阅键去重，**用户数据优先**；成功后删除游客目录并清 `ln_guest`。
    重复调用（目录已不存在）返回 `claimed:false` + 全 0，不报错。
    """
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="未登录")

    token = request.cookies.get(guest.COOKIE_NAME)
    empty = {
        "claimed": False,
        "merged": {"history": 0, "favorites": 0, "subscriptions": 0, "placement": 0},
        "skipped": {"history": 0, "favorites": 0, "subscriptions": 0},
        "guestFiles": 0,
    }
    if not guest.is_valid_token(token):
        # 没有游客 Cookie（直接注册/登录）或值非法：没有可认领的数据。
        if token:
            guest.clear_guest_cookie(response)
        return {"ok": True, **empty}

    guest_hash = guest.hash_token(token)
    try:
        # 定位测会话存在数据库里（不在游客目录），与文件合并分开迁移；
        # 中途登录后仍能接着提交，不会因「归属不同」整卷作废。
        moved_placement = placement.claim_guest_sessions(guest_hash, user["id"])
        result = guest.claim_guest_data(guest_hash, user["id"])
        result.setdefault("merged", {})["placement"] = moved_placement
    except guest.GuestClaimError:
        # 游客目录保留（合并是幂等的，下次登录可重试）；不删 Cookie。
        logger.exception("游客数据认领失败：guest=%s user=%s", guest_hash[:12], user["id"])
        raise HTTPException(
            status_code=500,
            detail="游客数据合并未完成，游客记录已保留，请稍后重试。",
        )

    # 成功（或游客目录本来就不存在 = 已认领过）：清掉客户端 Cookie，避免
    # 下次登录又去认领一个空目录。
    guest.clear_guest_cookie(response)
    return {"ok": True, **result}
