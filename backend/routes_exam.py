"""考试练习 HTTP 路由（V2 用户需求 #11 / specs/022）。

端点：

- ``GET  /api/exam/types``：可用题型（当前 cet4，label「CET-4 风格练习」，
  ``itemCount=30``，每次练习 10 题）。
- ``POST /api/exam/start``：``{type}``；抽 10 题并创建/复用未提交会话，卷面
  **不含答案与解析**。
- ``POST /api/exam/submit``：``{sessionId, answers:[{itemId, chosenIndex}],
  durationMs}``；评分并保存，返回逐题对错/正确答案/解析/未答标记；重复提交
  幂等返回首次结果。
- ``GET  /api/exam/history?limit=20``：历史练习（日期/题型/正确数/总数），
  不出现任何成绩字段。

身份选择：**全部需登录，游客/未登录 403**（与复习/理解题/读文章一致）：
练习记录要归属账号，供周报与画像后续使用；游客态只用 Cookie，换设备就丢。

错误语义：

- 400：type 不支持、answers/chosenIndex/durationMs/sessionId 非法，或 itemId
  不在本次卷面；
- 403：游客/未登录；
- 404：会话不存在或属于其他用户（不泄露存在性）；
- 409：会话状态已变化（并发提交/已有其他类型未提交会话）；
- 422：请求体结构不符合 Pydantic 模型、limit 越界；
- 503：未跑 ``0012_exam`` 迁移，或题库缺失/损坏。

业务逻辑都在 ``exam.py``；本模块只做参数绑定、身份与错误映射。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import AliasChoices, BaseModel, Field

import exam

router = APIRouter(tags=["exam"])


class StartRequest(BaseModel):
    """开始练习：``{type}``（当前只接受 cet4）。"""

    exam_type: str = Field(
        default="",
        validation_alias=AliasChoices("type", "examType", "exam_type"),
    )


class AnswerIn(BaseModel):
    """单题作答：``chosenIndex`` 省略/null = 未作答（不计入已答）。"""

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


def _require_login(request: Request) -> dict:
    """考试练习必须归属登录账号；游客/未登录 403。"""
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(
            status_code=403,
            detail="考试练习需要登录后使用（练习记录保存在账号下）。",
        )
    return user


def _raise_exam_error(exc: Exception) -> None:
    """把 exam 的领域异常映射成 HTTP 错误。"""
    if isinstance(exc, exam.ExamUnavailable):
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if isinstance(exc, exam.ExamNotFound):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, exam.ExamConflict):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if isinstance(exc, exam.ExamInvalid):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if isinstance(exc, exam.ExamError):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise exc


@router.get("/api/exam/types")
def exam_types(request: Request):
    """可用题型；静态题库，不读写数据库。"""
    _require_login(request)
    try:
        return exam.list_types()
    except Exception as exc:  # noqa: BLE001 - 统一映射领域错误
        _raise_exam_error(exc)
        raise  # pragma: no cover - _raise_exam_error 必抛


@router.post("/api/exam/start")
def start_exam(payload: StartRequest, request: Request):
    """开始/复用未提交会话；返回 10 题，卷面不含答案与解析。"""
    user = _require_login(request)
    try:
        return exam.start(user["id"], payload.exam_type)
    except Exception as exc:  # noqa: BLE001
        _raise_exam_error(exc)
        raise  # pragma: no cover


@router.post("/api/exam/submit")
def submit_exam(payload: SubmitRequest, request: Request):
    """提交作答；服务端评分并保存，重复提交幂等返回首次结果。"""
    user = _require_login(request)
    answers = [
        {"itemId": answer.item_id, "chosenIndex": answer.chosen_index}
        for answer in payload.answers
    ]
    try:
        return exam.submit(
            user["id"],
            payload.session_id,
            answers,
            payload.duration_ms,
        )
    except Exception as exc:  # noqa: BLE001
        _raise_exam_error(exc)
        raise  # pragma: no cover


@router.get("/api/exam/history")
def exam_history(
    request: Request,
    limit: int = Query(
        default=exam.HISTORY_DEFAULT_LIMIT,
        ge=1,
        le=exam.HISTORY_MAX_LIMIT,
    ),
):
    """历史练习（只含已提交）；不返回成绩、预测或通过口径。"""
    user = _require_login(request)
    try:
        return exam.history(user["id"], limit)
    except Exception as exc:  # noqa: BLE001
        _raise_exam_error(exc)
        raise  # pragma: no cover
