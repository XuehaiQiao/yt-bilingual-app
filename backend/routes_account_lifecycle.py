"""账号生命周期 HTTP：删除冷静期 / 取消 / 导出（M2a / specs/033）。

所有端点都需要登录。``deletion_pending`` 账号仍可访问 ``/api/account/*``
（取消/导出），其它业务端点由 ``main.py`` 身份中间件 403。

错误响应统一 ``{"detail": "...", "code": "稳定错误码"}``；限流额外带
``Retry-After``。密码确认失败计入进程内限流（``account_lifecycle``）。

端点：

- ``GET  /api/account/deletion``        当前状态 / 到期日 / 最近申请
- ``POST /api/account/deletion``        密码 + 用户名 + ``DELETE`` → 202 pending
- ``POST /api/account/deletion/cancel`` 密码 → active
- ``POST /api/account/export``          密码 → 202 queued + 一次性下载 token
- ``GET  /api/account/exports``         导出任务列表（不含 token/路径）
- ``GET  /api/account/export/{id}``     会话 + token → 流式 ZIP
- ``DELETE /api/account/export/{id}``   删除临时 ZIP（幂等；任务行标记 expired）
"""
from __future__ import annotations

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

import account_export
import account_lifecycle
import routes_auth

router = APIRouter(prefix="/api/account", tags=["account-lifecycle"])

_NO_STORE = {"Cache-Control": "no-store"}


class DeletionRequestIn(BaseModel):
    password: str
    username: str
    confirm: str
    reason: str | None = None


class PasswordIn(BaseModel):
    password: str


class ExportRequestIn(BaseModel):
    password: str


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
        status_code=status_code,
        content=payload,
        headers=response_headers,
    )


def _error_from(exc: account_lifecycle.LifecycleError) -> JSONResponse:
    headers: dict[str, str] = {}
    extra = dict(exc.extra)
    retry_after = extra.get("retryAfter")
    if retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    return _error(
        exc.status_code,
        exc.code,
        str(exc),
        headers=headers,
        extra=extra or None,
    )


def _login(request: Request) -> dict | None:
    return getattr(request.state, "user", None)


def _unauthorized() -> JSONResponse:
    return _error(401, "auth_required", "未登录。")


def _request_id(request: Request) -> str | None:
    return getattr(request.state, "request_id", None)


@router.get("/deletion")
def get_deletion(request: Request):
    """当前账号删除状态；pending 时含到期日与最近一次申请。"""
    user = _login(request)
    if not user:
        return _unauthorized()
    try:
        return account_lifecycle.get_deletion_state(user["id"])
    except account_lifecycle.LifecycleError as exc:
        return _error_from(exc)


@router.post("/deletion", status_code=202)
def submit_deletion(payload: DeletionRequestIn, request: Request):
    """提交删除申请：密码 + 用户名 + 确认词 DELETE；立即踢掉所有会话。"""
    user = _login(request)
    if not user:
        return _unauthorized()
    try:
        result = account_lifecycle.request_deletion(
            user,
            payload.password,
            payload.username,
            payload.confirm,
            reason=payload.reason,
            request_id=_request_id(request),
        )
    except account_lifecycle.LifecycleError as exc:
        return _error_from(exc)
    response = JSONResponse(
        status_code=202, content=result, headers=dict(_NO_STORE)
    )
    # 全部会话已在库里删除；同时清掉浏览器 Cookie，避免带着失效会话继续用。
    routes_auth.clear_session_cookie(response)
    return response


@router.post("/deletion/cancel")
def cancel_deletion(payload: PasswordIn, request: Request):
    """冷静期内取消删除（密码确认），恢复 active。"""
    user = _login(request)
    if not user:
        return _unauthorized()
    try:
        return account_lifecycle.cancel_deletion(
            user,
            payload.password,
            request_id=_request_id(request),
        )
    except account_lifecycle.LifecycleError as exc:
        return _error_from(exc)


@router.get("/exports")
def list_exports(request: Request):
    """该用户的导出任务列表（脱敏：不含 token hash / 文件路径）。"""
    user = _login(request)
    if not user:
        return _unauthorized()
    try:
        return account_export.list_exports(user["id"])
    except account_lifecycle.LifecycleError as exc:
        return _error_from(exc)


@router.post("/export", status_code=202)
def create_export(payload: ExportRequestIn, request: Request):
    """密码确认 + 限流后创建后台导出；202 返回只出现一次的下载 token。"""
    user = _login(request)
    if not user:
        return _unauthorized()
    try:
        result = account_export.create_export_job(
            user,
            payload.password,
            http_request_id=_request_id(request),
        )
    except account_lifecycle.LifecycleError as exc:
        return _error_from(exc)
    return JSONResponse(status_code=202, content=result, headers=dict(_NO_STORE))


@router.get("/export/{job_id}")
def download_export(
    job_id: str,
    request: Request,
    token: str | None = Query(default=None),
):
    """会话 + 一次性 token 下载 ZIP；过期 410，token 错 403。"""
    user = _login(request)
    if not user:
        return _unauthorized()
    try:
        resolved = account_export.get_export_for_download(user["id"], job_id, token)
    except account_lifecycle.LifecycleError as exc:
        return _error_from(exc)
    account_export.mark_downloaded(job_id)
    return FileResponse(
        resolved["path"],
        media_type="application/zip",
        filename=resolved["filename"],
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.delete("/export/{job_id}")
def delete_export(job_id: str, request: Request):
    """删除临时 ZIP 文件（幂等）；任务行保留为 expired。"""
    user = _login(request)
    if not user:
        return _unauthorized()
    try:
        return account_export.delete_export(user["id"], job_id)
    except account_lifecycle.LifecycleError as exc:
        return _error_from(exc)
