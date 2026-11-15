"""能力定位测试 HTTP 路由（计划书 §13.2 M4 / specs/016）。

端点：

- ``GET  /api/placement/start``：开始/复用一次 12 分钟定位测，返回 24 词 + 5 阅读
  + 混入的伪词（**不含答案**；伪词按词汇题外观下发）。
- ``POST /api/placement/submit``：提交作答 → 服务端加权评分、CEFR 区间、置信度、
  强弱项、1 条建议；写 session + 当前画像。重复提交幂等返回首次结果。
- ``GET  /api/placement/profile``：当前能力画像；没有则 ``profile: null``。
- ``POST /api/placement/reset``：允许重测（未完成会话标 abandoned；历史与画像保留）。

**游客可用**：登录用户归属 ``users.id``，游客归属 ``guest:<sha256>``（见
``guest.guest_id``）。游客结果不跨设备——换设备/Cookie 就是新的游客身份。
校验/抽题/评分/落库都在 ``placement.py``，本模块只做身份解析与错误码映射。

错误语义：

- 400：answers/chosenIndex/durationMs/sessionId 非法，或 itemId 不在本次卷面；
- 403：既不是登录用户也不是游客（正常请求中间件一定会下发游客 Cookie）；
- 404：会话不存在或属于其他用户（不泄露存在性）；
- 409：会话已作废/并发状态变化；
- 422：请求体结构不符合 Pydantic 模型；
- 503：未跑 ``0009_placement`` 迁移，或题库文件缺失/损坏。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import AliasChoices, BaseModel, Field

import guest
import placement

router = APIRouter(tags=["placement"])


class AnswerIn(BaseModel):
    """单题作答：``chosenIndex=-1``（或省略）= 不认识/跳过。"""

    item_id: str = Field(
        validation_alias=AliasChoices("itemId", "item_id")
    )
    chosen_index: int | None = Field(
        default=None,
        validation_alias=AliasChoices("chosenIndex", "chosen_index"),
    )


class SubmitRequest(BaseModel):
    """提交整卷：``{sessionId, answers, durationMs?}``。"""

    session_id: str = Field(
        validation_alias=AliasChoices("sessionId", "session_id")
    )
    answers: list[AnswerIn]
    duration_ms: int | None = Field(
        default=None,
        validation_alias=AliasChoices("durationMs", "duration_ms"),
    )


def _identity(request: Request) -> tuple[str, str | None]:
    """请求身份 → (归属键, 游客 sha256)；登录用户优先。"""
    user = getattr(request.state, "user", None)
    if user:
        return user["id"], None
    guest_hash = getattr(request.state, "guest_hash", None)
    if guest_hash:
        return guest.guest_id(guest_hash), guest_hash
    raise HTTPException(status_code=403, detail="缺少定位测身份（请启用 Cookie）。")


def _raise_placement_error(exc: Exception) -> None:
    """把 placement 的领域异常映射成 HTTP 错误。"""
    if isinstance(exc, placement.PlacementUnavailable):
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if isinstance(exc, placement.PlacementNotFound):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, placement.PlacementConflict):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if isinstance(exc, placement.PlacementInvalid):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise exc


@router.get("/api/placement/start")
def start_placement(request: Request):
    """开始或复用定位测；同一用户未完成的会话会被复用。"""
    identity, guest_hash = _identity(request)
    try:
        return placement.start(identity, guest_hash)
    except Exception as exc:  # noqa: BLE001 - 统一映射领域错误
        _raise_placement_error(exc)
        raise  # pragma: no cover - _raise_placement_error 必抛


@router.post("/api/placement/submit")
def submit_placement(payload: SubmitRequest, request: Request):
    """提交作答；服务端评分并保存会话与画像。"""
    identity, guest_hash = _identity(request)
    answers = [
        {"itemId": answer.item_id, "chosenIndex": answer.chosen_index}
        for answer in payload.answers
    ]
    try:
        return placement.submit(
            identity,
            guest_hash,
            payload.session_id,
            answers,
            payload.duration_ms,
        )
    except Exception as exc:  # noqa: BLE001
        _raise_placement_error(exc)
        raise  # pragma: no cover


@router.get("/api/placement/profile")
def placement_profile(request: Request):
    """当前能力画像；没有完成过定位测时 ``profile`` 为 null。"""
    identity, _guest_hash = _identity(request)
    try:
        return placement.get_profile(identity)
    except Exception as exc:  # noqa: BLE001
        _raise_placement_error(exc)
        raise  # pragma: no cover


@router.post("/api/placement/reset")
def reset_placement(request: Request):
    """允许重测：中止未完成会话，保留已提交历史与当前画像。"""
    identity, _guest_hash = _identity(request)
    try:
        return placement.reset(identity)
    except Exception as exc:  # noqa: BLE001
        _raise_placement_error(exc)
        raise  # pragma: no cover
