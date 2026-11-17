"""课程 MVP HTTP 路由（specs/029）。

端点（全部需登录，游客/未登录 401）：

- ``GET  /api/course/lessons``：课程列表（只给元数据）；
- ``GET  /api/course/lessons/{lesson_id}``：课程详情（脱敏：题目不含
  ``answer``/``explain``）；
- ``POST /api/course/attempts``：开始/恢复一次尝试（``{lessonId}``）；
- ``GET  /api/course/attempts/{attempt_id}``：恢复进度（仅本人，否则 404）；
- ``POST /api/course/attempts/{attempt_id}/answer``：首次作答
  （``{questionId, choice}``；重复同 choice 幂等，换 choice 409）；
- ``POST /api/course/attempts/{attempt_id}/step``：更新当前步骤（非法步骤 400，
  完成后 409）；
- ``POST /api/course/attempts/{attempt_id}/output``：保存产出
  （``{text}``，≤2000 字符，服务端算 ``wordCount``）；
- ``POST /api/course/attempts/{attempt_id}/complete``：评分完成（未答完/产出为空
  409 ``incomplete``）；
- ``POST /api/course/attempts/{attempt_id}/events``：埋点（204；非法 event 400；
  payload ≤2KB）。

错误语义：

- 400：lessonId/stepId/text 缺失，题目/选项/步骤/event 非法，payload 过大；
- 401：游客/未登录（学习进度要归属账号）；
- 404：课程不存在（``lesson_not_found``）或 attempt 不存在/属于别人
  （``attempt_not_found``，不泄露存在性）；
- 409：换答案、课程已完成、未答完/无产出；
- 503：课程包损坏/缺失、数据库缺表（未跑 ``0021_course_mvp``）。

业务逻辑都在 ``course.py``；本模块只做参数绑定、身份与错误映射。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import AliasChoices, BaseModel, Field

import course

router = APIRouter(tags=["course"])


# ---------------------------------------------------------------------------
# 请求模型
# ---------------------------------------------------------------------------

class StartAttemptRequest(BaseModel):
    lesson_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("lessonId", "lesson_id"),
    )


class AnswerRequest(BaseModel):
    question_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("questionId", "question_id"),
    )
    choice: str | None = None


class StepRequest(BaseModel):
    step_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("stepId", "step_id"),
    )


class OutputRequest(BaseModel):
    text: str | None = None


class EventRequest(BaseModel):
    event: str | None = None
    step_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("stepId", "step_id"),
    )
    payload: Any = None


# ---------------------------------------------------------------------------
# 公共校验 / 错误映射
# ---------------------------------------------------------------------------

def _require_login(request: Request) -> dict:
    """课程学习必须归属登录账号；游客/未登录 401。"""
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(
            status_code=401,
            detail="课程学习需要登录（学习进度保存在账号下）。",
        )
    return user


def _raise_course_error(exc: Exception) -> None:
    """把 course 的领域异常映射成 HTTP 错误。"""
    if isinstance(exc, course.CourseUnavailable):
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if isinstance(exc, (course.LessonNotFound, course.AttemptNotFound)):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, course.CourseConflict):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if isinstance(exc, course.InvalidRequest):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if isinstance(exc, course.CourseError):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise exc


# ---------------------------------------------------------------------------
# 端点
# ---------------------------------------------------------------------------

@router.get("/api/course/lessons")
def course_lessons(request: Request):
    """课程列表：只给 id/标题/等级/时长/状态/version。"""
    _require_login(request)
    try:
        return course.list_lessons()
    except Exception as exc:  # noqa: BLE001 - 统一映射领域错误
        _raise_course_error(exc)
        raise  # pragma: no cover - _raise_course_error 必抛


@router.get("/api/course/lessons/{lesson_id}")
def course_lesson(lesson_id: str, request: Request):
    """课程详情：题目只含 id/prompt/options，不含答案与解析。"""
    _require_login(request)
    try:
        return course.get_lesson(lesson_id)
    except Exception as exc:  # noqa: BLE001
        _raise_course_error(exc)
        raise  # pragma: no cover


@router.post("/api/course/attempts")
def course_start_attempt(payload: StartAttemptRequest, request: Request):
    """开始/恢复尝试：已有 in_progress 时返回它并标 ``resumed:true``。"""
    user = _require_login(request)
    lesson_id = (payload.lesson_id or "").strip()
    if not lesson_id:
        raise HTTPException(status_code=400, detail="lessonId 不能为空。")
    try:
        return course.start_attempt(user["id"], lesson_id)
    except Exception as exc:  # noqa: BLE001
        _raise_course_error(exc)
        raise  # pragma: no cover


@router.get("/api/course/attempts/{attempt_id}")
def course_get_attempt(attempt_id: str, request: Request):
    """恢复进度：仅本人，别人的 attempt 与不存在一样返回 404。"""
    user = _require_login(request)
    try:
        return course.get_attempt(user["id"], attempt_id)
    except Exception as exc:  # noqa: BLE001
        _raise_course_error(exc)
        raise  # pragma: no cover


@router.post("/api/course/attempts/{attempt_id}/answer")
def course_answer(attempt_id: str, payload: AnswerRequest, request: Request):
    """记录首次答案：重复同 choice 幂等，换 choice 409。"""
    user = _require_login(request)
    question_id = (payload.question_id or "").strip()
    if not question_id:
        raise HTTPException(status_code=400, detail="questionId 不能为空。")
    choice = (payload.choice or "").strip()
    if not choice:
        raise HTTPException(status_code=400, detail="choice 不能为空。")
    try:
        return course.answer_question(user["id"], attempt_id, question_id, choice)
    except Exception as exc:  # noqa: BLE001
        _raise_course_error(exc)
        raise  # pragma: no cover


@router.post("/api/course/attempts/{attempt_id}/step")
def course_step(attempt_id: str, payload: StepRequest, request: Request):
    """更新 current_step_id。"""
    user = _require_login(request)
    step_id = (payload.step_id or "").strip()
    if not step_id:
        raise HTTPException(status_code=400, detail="stepId 不能为空。")
    try:
        return course.update_step(user["id"], attempt_id, step_id)
    except Exception as exc:  # noqa: BLE001
        _raise_course_error(exc)
        raise  # pragma: no cover


@router.post("/api/course/attempts/{attempt_id}/output")
def course_output(attempt_id: str, payload: OutputRequest, request: Request):
    """保存产出；服务端返回 wordCount，最长 2000 字符。"""
    user = _require_login(request)
    if payload.text is None:
        raise HTTPException(status_code=400, detail="text 不能为空。")
    try:
        return course.save_output(user["id"], attempt_id, payload.text)
    except Exception as exc:  # noqa: BLE001
        _raise_course_error(exc)
        raise  # pragma: no cover


@router.post("/api/course/attempts/{attempt_id}/complete")
def course_complete(attempt_id: str, request: Request):
    """完成课程并评分：所有题已答 + 产出非空，否则 409 ``incomplete``。"""
    user = _require_login(request)
    try:
        return course.complete_attempt(user["id"], attempt_id)
    except Exception as exc:  # noqa: BLE001
        _raise_course_error(exc)
        raise  # pragma: no cover


@router.post("/api/course/attempts/{attempt_id}/events", status_code=204)
def course_event(attempt_id: str, payload: EventRequest, request: Request):
    """课程埋点：204；非法 event/步骤/payload（>2KB）400。"""
    user = _require_login(request)
    event = (payload.event or "").strip()
    if not event:
        raise HTTPException(status_code=400, detail="event 不能为空。")
    try:
        course.record_event(
            user["id"],
            attempt_id,
            event,
            payload.step_id,
            payload.payload,
        )
    except Exception as exc:  # noqa: BLE001
        _raise_course_error(exc)
        raise  # pragma: no cover
    return Response(status_code=204)
