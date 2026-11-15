"""学习事件上报 + 周报 HTTP 路由（计划书 §13.2 M5 / specs/015）。

端点：

- ``POST /api/events``：批量上报观看事件（单次最多 50 条）；
- ``GET  /api/report/week?weekStart=YYYY-MM-DD``：本周事实周报。

两者都**游客可用**：登录用户归属 ``users.id``，游客归属
``guest:<sha256>``（见 ``guest.guest_id``）。校验/聚合/快照都在
``reports.py``，本模块只做参数绑定、身份解析与错误码映射。

错误语义：

- 400：事件字段非法（负数/超 24h/未来时间过远/重复键缺失等）或 weekStart
  格式非法；
- 403：既不是登录用户也不是游客（正常请求中间件一定会下发游客 Cookie）；
- 503：未跑 ``0008_weekly_report`` 迁移（表缺失）。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

import guest
import reports

router = APIRouter(tags=["reports"])


class EventsRequest(BaseModel):
    """批量上报的请求体：``{events:[{type:'watch', …}]}``。"""

    events: list[dict]


def _identity(request: Request) -> tuple[str, str | None]:
    """请求身份 → (归属键, 游客 sha256)；登录用户优先。"""
    user = getattr(request.state, "user", None)
    if user:
        return user["id"], None
    guest_hash = getattr(request.state, "guest_hash", None)
    if guest_hash:
        return guest.guest_id(guest_hash), guest_hash
    raise HTTPException(status_code=403, detail="缺少学习身份（请启用 Cookie）。")


def _raise_report_error(exc: Exception) -> None:
    """把 reports 的领域异常映射成 HTTP 错误。"""
    if isinstance(exc, reports.ReportUnavailable):
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if isinstance(
        exc, (reports.InvalidEvents, reports.InvalidWeekStart, reports.ReportError)
    ):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise exc


@router.post("/api/events")
def report_events(payload: EventsRequest, request: Request):
    """批量写入观看事件；重复 ``clientEventId`` 只落一次。"""
    identity, guest_hash = _identity(request)
    try:
        return reports.record_watch_events(
            identity,
            guest_hash,
            payload.events,
            now=reports.now_ms(),
        )
    except Exception as exc:  # noqa: BLE001 - 统一映射领域错误
        _raise_report_error(exc)
        raise  # pragma: no cover - _raise_report_error 必抛


@router.get("/api/report/week")
def get_week_report(
    request: Request,
    weekStart: str | None = Query(default=None),
):
    """本周事实周报（UTC 周一为界；weekStart 任意日期会归一到所在周周一）。"""
    identity, _guest_hash = _identity(request)
    try:
        return reports.week_report(
            identity, weekStart, now=reports.now_ms()
        )
    except Exception as exc:  # noqa: BLE001
        _raise_report_error(exc)
        raise  # pragma: no cover
