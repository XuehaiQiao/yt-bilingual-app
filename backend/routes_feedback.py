"""反馈/纠错 HTTP（v1.1 P0 / P2-39，specs/048）。

端点：

- ``POST /api/feedback``：**登录用户与游客都可提交**。登录用户记 ``user_id``，
  游客记 NULL（0033 的表专门允许）。受理分类/描述/来源页/相关 id/联系方式；
  成功后 ``{id, status, requestId}``：``id`` 与表主键同值但以**字符串**返回
  （前端 ``FeedbackReceipt.id`` 的类型就是 ``string``，避免整型被判成 null）；
  管理端列表与 PATCH 路径仍用整数主键。
  - body 同时接受 ``message`` 与前端在用的 ``description``（字段别名）；正文
    去首尾空白后 5–2000 字符（与前端 ``FEEDBACK_DESCRIPTION_MIN/MAX`` 同口径）；
  - ``requestId`` 未给时回落到中间件的 request_id（来自 ``X-Request-ID`` 头），
    保证任何受理都能和访问日志对上；
  - 分类/正文/联系方式非法 → 400；未跑迁移 → 503；按身份限流 → 429；
  - 游客与登录用户用**不同的限流桶上限**（默认 3 / 5 次每分钟），与其它
    业务桶同口径（进程内固定窗口，见 ``ratelimit.py``）。配置项
    ``RATE_LIMIT_FEEDBACK_PER_MINUTE`` / ``RATE_LIMIT_GUEST_FEEDBACK_PER_MINUTE``
    目前不在 ``config.py`` 里（本卡写域不含它），这里用模块默认值兜底：
    以后在 config 加上同名属性即生效，运维无需改代码；
- ``GET /api/admin/feedback?status=&limit=``：管理员列表，最近优先；可按状态
  过滤（未知状态 400），``limit`` 1–200（默认 50）。载荷只有反馈本身
  （分类/正文/联系方式/状态/时间/相关 id），不含密码、会话、token 之类的账号
  敏感字段；
- ``PATCH /api/admin/feedback/{id}``：管理员改 ``{status, adminNote}``（至少一项；
  ``adminNote: null`` = 清空）；未知 id 404、非法状态/空对象 400；写
  ``admin_audit_log``（``admin.feedback.update``），未迁移时降级为日志
  （与其它管理台写操作一致）。

为什么游客也能提交：反馈是产品出口，不该因为没注册就丢失；成本侧没有 AI
调用，只有一条 SQLite INSERT，限流足够兜底。游客没有 user_id 可回联，所以
``requestId`` 与访问日志是唯一排查线索——这也是它在响应里被回显的原因。
"""
from __future__ import annotations

import logging
from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import AliasChoices, BaseModel, Field

import account_lifecycle
import config
import feedback
import ratelimit
from routes_admin import require_admin

logger = logging.getLogger("linguatrek.feedback")

router = APIRouter(tags=["feedback"])

#: 限流桶名（与 ``ratelimit`` 的命名风格一致；不注册到中间件路径表，
#: 因为本端点需要区分登录/游客两档上限，直接在路由里计数）。
RATE_LIMIT_BUCKET = "feedback"

#: 默认上限：登录 5 次/分钟、游客 3 次/分钟（0 = 关闭限流）。
DEFAULT_USER_LIMIT_PER_MINUTE = 5
DEFAULT_GUEST_LIMIT_PER_MINUTE = 3


class FeedbackCreateRequest(BaseModel):
    """``POST /api/feedback`` 的请求体；全部字段都按 object 收，非法类型走 400。

    用 ``object`` 而不是 ``str``：类型不对时应返回统一的 400 中文提示，而不是
    FastAPI 的 422 校验载荷（前端只处理 detail 文本）。
    """

    category: object = None
    message: object = Field(
        default=None, validation_alias=AliasChoices("message", "description")
    )
    page: object = None
    request_id: object = Field(
        default=None,
        validation_alias=AliasChoices("requestId", "request_id"),
    )
    contact: object = None


class FeedbackUpdateRequest(BaseModel):
    """``PATCH /api/admin/feedback/{id}``：状态与处理备注，至少提供一项。"""

    status: object = None
    admin_note: object = Field(
        default=None, validation_alias=AliasChoices("adminNote", "admin_note")
    )


# ---------------------------------------------------------------------------
# 身份 / 限流
# ---------------------------------------------------------------------------

def _identity(request: Request) -> tuple[str, bool]:
    """反馈归属的身份键与是否游客：登录用户优先，其次游客，最后按 IP 兜底。"""
    user = getattr(request.state, "user", None)
    if isinstance(user, dict) and user.get("id"):
        return f"user:{user['id']}", False
    guest_hash = getattr(request.state, "guest_hash", None)
    if guest_hash:
        return f"guest:{guest_hash}", True
    host = request.client.host if request.client else "unknown"
    return f"ip:{host}", True


def _rate_limit(is_guest: bool) -> int:
    """每分钟上限：config 有同名属性时优先（可在部署侧调），否则用模块默认。"""
    attr = (
        "RATE_LIMIT_GUEST_FEEDBACK_PER_MINUTE"
        if is_guest
        else "RATE_LIMIT_FEEDBACK_PER_MINUTE"
    )
    default = (
        DEFAULT_GUEST_LIMIT_PER_MINUTE if is_guest else DEFAULT_USER_LIMIT_PER_MINUTE
    )
    try:
        return max(0, int(getattr(config, attr, default) or 0))
    except (TypeError, ValueError):
        return default


def _request_id(request: Request, body_value: object) -> str | None:
    """相关 id：body 的 requestId 优先，否则用中间件的 request_id（含请求头）。"""
    try:
        from_body = feedback.normalize_request_id(body_value)
    except feedback.InvalidFeedback:
        from_body = None
    if from_body:
        return from_body
    context_id = getattr(request.state, "request_id", None)
    if isinstance(context_id, str) and context_id.strip():
        return context_id.strip()[: feedback.REQUEST_ID_MAX]
    header_id = request.headers.get("x-request-id")
    if header_id and header_id.strip():
        return header_id.strip()[: feedback.REQUEST_ID_MAX]
    return None


def _raise_feedback_error(exc: feedback.FeedbackError) -> NoReturn:
    """领域异常 → HTTP：400 校验 / 404 不存在 / 503 表不可用。"""
    if isinstance(exc, feedback.InvalidFeedback):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if isinstance(exc, feedback.FeedbackNotFound):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    raise HTTPException(status_code=503, detail=str(exc)) from exc


def _audit_update(
    request: Request,
    actor: dict,
    feedback_id: int,
    changes: dict,
) -> None:
    """管理台写操作的最小审计（表未迁移时降级为日志，与既有约定一致）。"""
    account_lifecycle.write_audit(
        actor["id"],
        "admin.feedback.update",
        target_type="feedback",
        target_id=str(feedback_id),
        detail={"changes": changes},
        request_id=getattr(request.state, "request_id", None),
        required=False,
    )


# ---------------------------------------------------------------------------
# 端点
# ---------------------------------------------------------------------------

@router.post("/api/feedback")
def submit_feedback(payload: FeedbackCreateRequest, request: Request):
    """提交反馈/纠错（登录或游客均可）；返回 ``{id, status, requestId}``。

    ``id`` 是表主键的字符串形式（前端回执类型为 ``string``）；其余端点用整数。
    """
    identity, is_guest = _identity(request)
    retry_after = ratelimit.consume(
        RATE_LIMIT_BUCKET, identity, _rate_limit(is_guest)
    )
    if retry_after is not None:
        logger.warning(
            "反馈提交被限流：identity=%s guest=%s retry_after=%s",
            identity,
            is_guest,
            retry_after,
        )
        return ratelimit.rate_limited_response(retry_after)

    user = getattr(request.state, "user", None)
    user_id = user["id"] if isinstance(user, dict) and user.get("id") else None
    # page 是诊断字段（0033 无 page 列）：校验/截断后只进日志，不落库。
    try:
        page = feedback.normalize_page(payload.page)
    except feedback.InvalidFeedback as exc:
        _raise_feedback_error(exc)

    try:
        record = feedback.create(
            user_id=user_id,
            category=payload.category,
            message=payload.message,
            request_id=_request_id(request, payload.request_id),
            contact=payload.contact,
        )
    except feedback.FeedbackError as exc:
        _raise_feedback_error(exc)

    logger.info(
        "收到反馈：id=%s category=%s guest=%s page=%r request_id=%s",
        record["id"],
        record["category"],
        user_id is None,
        page,
        record["requestId"],
    )
    return {
        "id": str(record["id"]),
        "status": record["status"],
        "requestId": record["requestId"],
    }


@router.get("/api/admin/feedback")
def admin_list_feedback(
    status: str | None = Query(default=None),
    limit: int = Query(default=feedback.DEFAULT_LIST_LIMIT, ge=1, le=feedback.MAX_LIST_LIMIT),
    _user: dict = Depends(require_admin),
):
    """反馈列表（最近优先）：``status`` 可选（``all``/空 = 不过滤）。"""
    try:
        return feedback.list_recent(status=status, limit=limit)
    except feedback.FeedbackError as exc:
        _raise_feedback_error(exc)


@router.patch("/api/admin/feedback/{feedback_id}")
def admin_update_feedback(
    feedback_id: int,
    payload: FeedbackUpdateRequest,
    request: Request,
    user: dict = Depends(require_admin),
):
    """改处理状态/备注；写审计。返回更新后的反馈（含 changes 之外的全量字段）。"""
    fields = payload.model_fields_set
    if not ({"status", "admin_note"} & set(fields)):
        raise HTTPException(status_code=400, detail="请至少提供 status 或 adminNote。")
    try:
        result = feedback.update(
            feedback_id,
            status=payload.status,
            admin_note=payload.admin_note,
            has_status="status" in fields,
            has_admin_note="admin_note" in fields,
        )
    except feedback.FeedbackError as exc:
        _raise_feedback_error(exc)

    _audit_update(request, user, feedback_id, result["changes"])
    return result["feedback"]
