"""能力档案 HTTP 路由（M1 CEFR 标定，计划书 §7.4 / specs/025）。

端点：

- ``GET  /api/ability/profile``：登录/游客的分技能画像（词汇区间、阅读证据不足、
  听说语法未测、写作自评 ``cefr=null``、can-do、冲突、样本口径与免责声明）。
- ``POST /api/ability/self-assess``：20 条自评（0–3），只作先验、不改能力带；
  ``clientRequestId`` 幂等，10 次/天。
- ``GET  /api/ability/can-do?level=B1&skill=reading&lang=zh-CN``：公开的通用
  can-do 描述（A1–C1 × 4 技能，zh/vi，含 ``basis``）。

错误语义：400 参数/越界；403 无身份；404 内容不存在（不泄露存在性）；409
状态冲突；422 Pydantic；429 自评日限（带 Retry-After）；503 未迁移/内容损坏。

缓存：``profile`` 为 ``private, max-age=60``；``can-do`` 为
``public, max-age=3600``。**任何响应都不含阅读带或 overall.cefr**。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import AliasChoices, BaseModel, Field

import ability
import guest

router = APIRouter(tags=["ability"])

PROFILE_CACHE_HEADERS = {
    "Cache-Control": "private, max-age=60",
    "Vary": "Cookie",
}
CAN_DO_CACHE_HEADERS = {"Cache-Control": "public, max-age=3600"}


class SelfAssessAnswerIn(BaseModel):
    """单条自评：``rating`` 0=做不到 / 1=很勉强 / 2=基本可以 / 3=轻松；-1=跳过。"""

    item_id: str = Field(validation_alias=AliasChoices("itemId", "item_id"))
    rating: int


class SelfAssessRequest(BaseModel):
    """提交 20 条自评：``{clientRequestId, answers, durationMs, lang?}``。"""

    client_request_id: str = Field(
        validation_alias=AliasChoices("clientRequestId", "client_request_id")
    )
    answers: list[SelfAssessAnswerIn]
    duration_ms: int = Field(
        validation_alias=AliasChoices("durationMs", "duration_ms")
    )
    lang: str = "zh-CN"


def _identity(request: Request) -> tuple[str, str | None]:
    """请求身份 → (归属键, 游客 sha256)；登录用户优先。"""
    user = getattr(request.state, "user", None)
    if user:
        return user["id"], None
    guest_hash = getattr(request.state, "guest_hash", None)
    if guest_hash:
        return guest.guest_id(guest_hash), guest_hash
    raise HTTPException(status_code=403, detail="缺少能力档案身份（请启用 Cookie）。")


def _guest_hash_any(request: Request) -> str | None:
    """登录用户也取出游客 Cookie 的 hash（用于中途登录的幂等认领）。"""
    state_guest = getattr(request.state, "guest_hash", None)
    if state_guest:
        return state_guest
    token = request.cookies.get(guest.COOKIE_NAME)
    if guest.is_valid_token(token):
        return guest.hash_token(token)
    return None


def _claim_if_logged_in(request: Request) -> None:
    user = getattr(request.state, "user", None)
    if not user:
        return
    guest_hash = _guest_hash_any(request)
    if guest_hash:
        try:
            ability.claim_guest(guest_hash, user["id"])
        except ability.AbilityError:  # pragma: no cover - 认领失败不应阻断读接口
            pass


def _raise_ability_error(exc: Exception):
    if isinstance(exc, ability.AbilityUnavailable):
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if isinstance(exc, ability.AbilityNotFound):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, ability.AbilityConflict):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if isinstance(exc, ability.AbilityRateLimited):
        return JSONResponse(
            status_code=429,
            content={
                "detail": str(exc),
                "retryAfter": exc.retry_after,
            },
            headers={
                "Retry-After": str(exc.retry_after),
                "Cache-Control": "no-store",
            },
        )
    if isinstance(exc, ability.AbilityInvalid):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise exc


@router.get("/api/ability/profile")
def get_ability_profile(
    request: Request,
    lang: str = Query(default="zh-CN"),
):
    """分技能能力画像；登录与游客同一形状。"""
    identity, _guest_hash = _identity(request)
    _claim_if_logged_in(request)
    try:
        payload = ability.profile(identity, lang=lang)
    except Exception as exc:  # noqa: BLE001 - 统一映射领域错误
        mapped = _raise_ability_error(exc)
        if mapped is not None:
            return mapped
        raise  # pragma: no cover
    return JSONResponse(content=payload, headers=PROFILE_CACHE_HEADERS)


@router.post("/api/ability/self-assess")
def submit_self_assess(payload: SelfAssessRequest, request: Request):
    """提交自评；只写证据与自评先验，不改任何能力带。"""
    identity, guest_hash = _identity(request)
    _claim_if_logged_in(request)
    answers = [
        {"itemId": answer.item_id, "rating": answer.rating}
        for answer in payload.answers
    ]
    try:
        result = ability.self_assess(
            identity,
            guest_hash,
            payload.client_request_id,
            answers,
            payload.duration_ms,
            lang=payload.lang,
        )
    except Exception as exc:  # noqa: BLE001
        mapped = _raise_ability_error(exc)
        if mapped is not None:
            return mapped
        raise  # pragma: no cover
    return JSONResponse(
        content=result,
        headers={"Cache-Control": "no-store"},
    )


@router.get("/api/ability/can-do")
def get_can_do(
    level: str = Query(...),
    skill: str = Query(...),
    lang: str = Query(default="zh-CN"),
):
    """公开的 can-do 描述；不读用户身份，不创建游客 Cookie（见 main.py）。"""
    try:
        payload = ability.can_do(level, skill, lang)
    except Exception as exc:  # noqa: BLE001
        mapped = _raise_ability_error(exc)
        if mapped is not None:
            return mapped
        raise  # pragma: no cover
    return JSONResponse(content=payload, headers=CAN_DO_CACHE_HEADERS)
