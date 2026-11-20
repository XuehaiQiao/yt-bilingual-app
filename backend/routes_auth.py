"""认证路由：注册 / 登录 / 登出 / 当前用户 / 游客认领。

契约（前端并行开发，不要改字段与状态码）：

- POST /api/auth/signup  {"email","password","username"?,"inviteCode"?} -> 201
  {"user":{"id","email","username","credits","status"}} + Cookie
  新客户端必须带 username（2–24 字符，中文/英文/数字/下划线/连字符）；
  完全不传该字段的旧客户端回落 email 前缀（兼容，不校验长度/字符集）。
  `REGISTRATION_OPEN=false`（默认）时 `inviteCode` 必填；错误响应带稳定
  `code`：`invite_required` / `invite_invalid` / `registration_closed`；
  公开注册开启后缺省不要求邀请码，但传了非法码仍拒绝（见 specs/032）。
- POST /api/auth/login   {"email","password"} -> 200 同上 user + Cookie；
  已封禁账号密码正确时 403 {"detail":"账号已被停用"}
- POST /api/auth/logout                        -> 200 {"ok": true} + 清除 Cookie
- GET  /api/auth/me                            -> 200 {"user":{...},"isAdmin":bool}
                                                  或 200 {"user": null, "guest": true}
- POST /api/auth/claim-guest（需登录）          -> 200 {"ok":true,"claimed":bool,
                                                  "merged":{history,favorites,subscriptions},
                                                  "skipped":{...},"guestFiles":int}
                                                  未登录 -> 401 {"detail":"未登录"}
- GET  /api/auth/registration                   -> 200 {registrationOpen,
                                                  inviteSignupEnabled, inviteRequired,
                                                  registrationClosed}
                                                  公开只读；注册页据此决定是否显示邀请码。

Cookie：`ln_session`，httpOnly、SameSite=Lax、Path=/、Max-Age 30 天；
`Secure` 由 `COOKIE_SECURE=1` 控制（本地 HTTP 默认关）。游客 Cookie `ln_guest`
由 `main.py` 的中间件下发/校验（见 guest.py），本模块只在认领成功后清除它。

封禁：登录时 403；已存在的会话由 `main.py` 身份中间件按 `users.status` 拦截
（下一次请求即 403，不需要删会话——解封后原 Cookie 恢复）。
"""
import logging
import re
import threading
import time

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import AliasChoices, BaseModel, Field

import account
import auth_db
import auth_lockout
import config
import guest
import invites
import ability
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
    # 用 object 而不是 str|None：非字符串（数字/数组/对象）也走 400，而不是
    # pydantic 的 422。缺省 None 用于识别「旧客户端完全没传 username」；
    # 传了 null/空串按非法 400。
    username: object = None
    # 邀请码（camelCase 契约；同时接受 snake_case 便于脚本/旧测试）。同样用
    # object 识别「没传」与「传了 null/数字」，不允许非字符串静默通过。
    invite_code: object = Field(
        default=None,
        validation_alias=AliasChoices("inviteCode", "invite_code"),
    )


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
    return account.public_user(user)


def _signup_error(status_code: int, code: str, detail: str) -> JSONResponse:
    """注册错误统一带稳定 `code`（前端据此做 i18n，不解析中文文案）。"""
    return JSONResponse(
        status_code=status_code,
        content={"detail": detail, "code": code},
        headers={"Cache-Control": "no-store"},
    )


@router.get("/registration")
def registration():
    """公开注册能力：前端只在 `inviteRequired` 时强制邀请码。"""
    return invites.registration_status()


@router.post("/signup", status_code=201)
def signup(credentials: Credentials, response: Response):
    email = _validate_signup(credentials.email, credentials.password)
    # 新契约 username 必填（校验失败 400）；旧客户端完全不传该字段时回落 email
    # 前缀，保证老版本升级后还能注册。区分「没传」与「传了空/null」用
    # model_fields_set，避免把空字符串静默当成没传。
    if "username" in credentials.model_fields_set:
        try:
            username = account.validate_username(credentials.username)
        except account.InvalidUsername as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    else:
        username = auth_db.email_prefix_username(email)

    # ── 注册开关 / 邀请码（specs/032） ──────────────────────────────────
    # 完全关闭：REGISTRATION_OPEN=false 且 INVITE_SIGNUP_ENABLED=false。
    if not config.REGISTRATION_OPEN and not config.INVITE_SIGNUP_ENABLED:
        return _signup_error(
            403, "registration_closed", "注册暂未开放，请稍后再试。"
        )

    invite_present = "invite_code" in credentials.model_fields_set
    invite_code = credentials.invite_code
    if invite_present:
        if invite_code is None:
            invite_present = False
        else:
            try:
                normalized = invites.normalize_code(invite_code)
            except invites.InviteError:
                return _signup_error(
                    400, "invite_invalid", "邀请码格式不正确。"
                )
            if not normalized:
                invite_present = False
            else:
                invite_code = normalized

    if not config.REGISTRATION_OPEN and not invite_present:
        return _signup_error(
            403,
            "invite_required",
            "本次内测为邀请制，请填写邀请码。",
        )

    if invite_present:
        # Argon2 在事务外算好；事务内只做短写（见 invites.register_with_invite）。
        password_hash = auth_db.hash_password(credentials.password)
        try:
            user, token = invites.register_with_invite(
                email, password_hash, username, invite_code
            )
        except invites.InviteError as exc:
            # 真实原因只进服务端日志；对外统一文案，避免泄露码是否存在。
            logger.info("注册邀请码校验失败：reason=%s", exc.reason)
            return _signup_error(
                403,
                "invite_invalid",
                "邀请码无效或不可用，请向邀请人确认。",
            )
        except invites.InviteUnavailable:
            logger.warning("注册失败：邀请码表不存在（未跑 0023 迁移）")
            return _signup_error(
                503,
                "registration_unavailable",
                "注册服务暂不可用：请先运行数据库迁移。",
            )
        except invites.InviteBusy:
            logger.warning("注册失败：SQLite 写锁繁忙")
            return JSONResponse(
                status_code=503,
                content={
                    "detail": "注册请求繁忙，请稍后重试。",
                    "code": "registration_busy",
                },
                headers={
                    "Cache-Control": "no-store",
                    "Retry-After": "5",
                },
            )
        except auth_db.EmailExistsError:
            # 事务已回滚，邀请码没有被消耗。
            raise HTTPException(status_code=409, detail="邮箱已注册。")
        set_session_cookie(response, token)
        return {"user": _public_user(user)}

    # ── 公开注册（REGISTRATION_OPEN=true 且没有邀请码） ────────────────
    try:
        user = auth_db.create_user(email, credentials.password, username=username)
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
    # 封禁账号：密码正确才走到这里，用 403 明确告知「账号已被停用」；
    # 先清失败计数，避免解封后还被之前的失败锁定影响。
    _clear_login_failures(ip)
    auth_lockout.clear(email, ip)
    if (user.get("status") or account.STATUS_ACTIVE) == account.STATUS_BANNED:
        raise HTTPException(status_code=403, detail="账号已被停用")
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

    游客态不返回 401——前端据此直接进入游客模式（不拦登录页），并在需要
    保存/收藏时提示登录。`ln_guest` 由 main.py 的中间件在首次访问时下发。

    `user` 自 0013 起包含 ``username`` / ``credits`` / ``status``（注册/登录
    同契约）；`isAdmin` 只加在登录分支的**顶层**，不塞进 user 对象。
    管理员名单来自 ``config.ADMIN_EMAILS``。
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
    if (
        user.get("status") or account.STATUS_ACTIVE
    ) == account.STATUS_DELETION_PENDING:
        # 冷静期只允许取消/导出；认领会写学习数据，必须阻断。
        return JSONResponse(
            status_code=403,
            content={
                "detail": "账号正在删除冷静期，仅可取消删除或导出数据。",
                "code": "account_pending_deletion",
            },
            headers={"Cache-Control": "no-store"},
        )

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
        try:
            moved_ability = sum(
                max(0, int(value or 0))
                for value in ability.claim_guest(guest_hash, user["id"]).values()
            )
        except ability.AbilityError:
            # 能力表未迁移（老库）不应阻断游客目录认领；下次迁移后可再认领。
            moved_ability = 0
        result = guest.claim_guest_data(guest_hash, user["id"])
        result.setdefault("merged", {})["placement"] = moved_placement
        # 能力新表的认领是兼容扩展，不改变旧响应字段（merged 仍只列旧四类）。
        _ = moved_ability
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
