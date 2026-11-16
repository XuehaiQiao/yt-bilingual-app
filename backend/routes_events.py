"""学习事件上报 + 周报 HTTP 路由（计划书 §13.2 M5 / specs/015）。

端点：

- ``POST /api/events``：批量上报观看事件（``type=watch``，单次最多 50 条）与
  CEFR M2 行为事件（``dict_lookup`` / ``video_replay`` / ``playback_rate`` /
  ``tab_visibility``，单次最多 20 条；见 specs/027）；
- ``GET  /api/report/week?weekStart=YYYY-MM-DD``：本周事实周报。

两者都**游客可用**：登录用户归属 ``users.id``，游客归属
``guest:<sha256>``（见 ``guest.guest_id``）。watch 事件写 ``watch_events``，
行为事件复用 append-only 的 ``learning_events``（计划书 §7.3 的事件口径）。
校验/聚合在 ``reports.py`` / ``behavior_events.py``，本模块只做分流、参数绑定、
身份解析与错误码映射。

错误语义：

- 400：事件字段非法（未知 type/负数/超 24h/未来时间过远/重复键缺失/批量超限）；
- 403：既不是登录用户也不是游客（正常请求中间件一定会下发游客 Cookie）；
- 503：未跑对应迁移（``0008_weekly_report`` / ``0017_behavior_events``）。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

import behavior_events
import guest
import reports

router = APIRouter(tags=["reports"])


class EventsRequest(BaseModel):
    """批量上报的请求体：``{events:[{type:'watch', …}, {type:'dict_lookup', …}]}``。"""

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
    """把 reports / behavior_events 的领域异常映射成 HTTP 错误。"""
    if isinstance(
        exc, (reports.ReportUnavailable, behavior_events.BehaviorUnavailable)
    ):
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if isinstance(
        exc,
        (
            reports.InvalidEvents,
            reports.InvalidWeekStart,
            reports.ReportError,
            behavior_events.InvalidBehaviorEvents,
            behavior_events.BehaviorError,
        ),
    ):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise exc


def _split_events(raw_events: list[dict]) -> tuple[list[dict], list[dict]]:
    """按 type 分流；任一未知类型整批 400（不猜、不丢事件）。"""
    watch_events: list[dict] = []
    behavior: list[dict] = []
    for index, raw in enumerate(raw_events):
        if not isinstance(raw, dict):
            raise HTTPException(
                status_code=400, detail=f"events[{index}]：必须是对象。"
            )
        event_type = behavior_events.declared_event_type(raw)
        if event_type is None:
            raise HTTPException(
                status_code=400, detail=f"events[{index}]：缺少 type。"
            )
        if event_type == "watch":
            watch_events.append(raw)
        elif event_type in behavior_events.BEHAVIOR_EVENT_TYPES:
            behavior.append(raw)
        else:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"events[{index}]：type 只支持 watch / "
                    "dict_lookup / video_replay / playback_rate / tab_visibility。"
                ),
            )
    return watch_events, behavior


@router.post("/api/events")
def report_events(payload: EventsRequest, request: Request):
    """批量写入学习事件；重复幂等键只落一次，非法批次整批 400。"""
    identity, guest_hash = _identity(request)
    raw_events = payload.events

    # 总批量沿用 M5 的 50 条上限；行为事件另有 20 条上限（M2 #7）。
    if len(raw_events) > reports.MAX_EVENTS_PER_BATCH:
        raise HTTPException(
            status_code=400,
            detail=(
                f"单次最多上报 {reports.MAX_EVENTS_PER_BATCH} 条事件"
                f"（收到 {len(raw_events)} 条）。"
            ),
        )
    watch_raw, behavior_raw = _split_events(raw_events)
    if len(behavior_raw) > behavior_events.MAX_EVENTS_PER_BATCH:
        raise HTTPException(
            status_code=400,
            detail=(
                f"单次最多上报 {behavior_events.MAX_EVENTS_PER_BATCH} 条行为事件"
                f"（收到 {len(behavior_raw)} 条）。"
            ),
        )

    now_value = reports.now_ms()
    try:
        # 先全量校验（两类都通过）再写，避免混合批只落一半。
        watch_normalized = (
            reports.normalize_watch_events(watch_raw, now=now_value)
            if watch_raw
            else []
        )
        behavior_normalized = (
            behavior_events.normalize_behavior_events(behavior_raw, now=now_value)
            if behavior_raw
            else []
        )
        result = {
            "received": len(raw_events),
            "accepted": 0,
            "duplicated": 0,
        }
        if watch_normalized:
            watch_result = reports.write_watch_events(
                identity, guest_hash, watch_normalized
            )
            result["accepted"] += watch_result["accepted"]
            result["duplicated"] += watch_result["duplicated"]
        if behavior_normalized:
            behavior_result = behavior_events.record_behavior_events(
                identity, behavior_normalized, now=now_value
            )
            result["accepted"] += behavior_result["accepted"]
            result["duplicated"] += behavior_result["duplicated"]
            # 仅在批次含行为事件时附加去重计数，保持 watch-only 的 M5 响应不变。
            result["deduplicated"] = behavior_result["deduplicated"]
        return result
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
