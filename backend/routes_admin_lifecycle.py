"""管理员：删除请求列表 / 到期执行 / 审计（M2a / specs/033）。

身份沿用 ``routes_admin.require_admin``：``ADMIN_EMAILS`` 名单，未登录 401、
非管理员 403；最后管理员保护由 ``account_lifecycle`` 在申请/执行时再次检查。

- ``GET  /api/admin/deletion-requests``（别名 ``/api/admin/deletions``）
- ``POST /api/admin/deletion-requests/{id}/execute`` 二次确认 ``DELETE`` + 原因；
  冷静期未满需显式 ``force=true``（用户明确要求立即删除的书面场景）。
- ``GET  /api/admin/audit`` 最小审计列表（删除/调账/封禁/邀请码/设置）。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

import account_lifecycle
from routes_admin import require_admin

router = APIRouter(prefix="/api/admin", tags=["admin-lifecycle"])

_NO_STORE = {"Cache-Control": "no-store"}


class ExecuteDeletionIn(BaseModel):
    confirm: str
    reason: str
    force: bool = False


def _error(
    status_code: int,
    code: str,
    detail: str,
    *,
    headers: dict | None = None,
    extra: dict | None = None,
) -> JSONResponse:
    payload = {"detail": detail, "code": code}
    if extra:
        payload.update(extra)
    response_headers = dict(_NO_STORE)
    if headers:
        response_headers.update(headers)
    return JSONResponse(
        status_code=status_code, content=payload, headers=response_headers
    )


def _error_from(exc: account_lifecycle.LifecycleError) -> JSONResponse:
    headers: dict[str, str] = {}
    extra = dict(exc.extra)
    retry_after = extra.get("retryAfter")
    if retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    if exc.code == "deletion_failed":
        extra.setdefault("requestStatus", "failed")
    return _error(
        exc.status_code,
        exc.code,
        str(exc),
        headers=headers,
        extra=extra or None,
    )


def _request_id(request: Request) -> str | None:
    return getattr(request.state, "request_id", None)


@router.get("/deletion-requests")
def admin_list_deletion_requests(
    status: str = Query(default="all"),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=100_000),
    _user: dict = Depends(require_admin),
):
    """删除请求列表（脱敏）：pending 行带 email/username，完成后只留 hash。"""
    try:
        return account_lifecycle.list_deletion_requests(
            status=status, limit=limit, offset=offset
        )
    except account_lifecycle.LifecycleError as exc:
        return _error_from(exc)


@router.get("/deletions")
def admin_list_deletions_alias(
    status: str = Query(default="all"),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=100_000),
    _user: dict = Depends(require_admin),
):
    """``/api/admin/deletions`` 兼容别名（提案 §6 草案路径）。"""
    return admin_list_deletion_requests(
        status=status, limit=limit, offset=offset, _user=_user
    )


@router.post("/deletion-requests/{request_id}/execute")
def admin_execute_deletion(
    request_id: str,
    payload: ExecuteDeletionIn,
    request: Request,
    user: dict = Depends(require_admin),
):
    """执行硬删除；失败返回 5xx 并保留 failed 申请与可诊断错误。"""
    if payload.confirm.strip() != account_lifecycle.DELETE_CONFIRM_WORD:
        return _error(
            400,
            "confirmation_invalid",
            f"请输入确认词 {account_lifecycle.DELETE_CONFIRM_WORD}。",
        )
    try:
        result = account_lifecycle.execute_deletion(
            request_id,
            user["id"],
            reason=payload.reason,
            force=payload.force,
            http_request_id=_request_id(request),
        )
    except account_lifecycle.LifecycleError as exc:
        return _error_from(exc)
    return result


@router.get("/audit")
def admin_audit(
    action: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=100_000),
    _user: dict = Depends(require_admin),
):
    """最小审计列表：谁、何时、对谁、做了什么；``detail`` 已解析为对象。"""
    try:
        return account_lifecycle.list_audit(
            limit=limit, offset=offset, action=action
        )
    except account_lifecycle.LifecycleError as exc:
        return _error_from(exc)
