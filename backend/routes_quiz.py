"""理解题 HTTP 路由（计划书 §13.2 M3 / specs/014）。

端点（契约见 specs/014-quiz/spec.md）：

- ``POST /api/lesson/start``        确保内容项 + 生成/复用 3 道题
- ``GET  /api/lesson/{id}/questions`` 取某 lesson 的已通过题目
- ``POST /api/lesson/answer``       记录作答并返回判分 + 证据时间点
- ``GET  /api/lesson/{id}/result``  对/错/正确率 + 错题证据列表

全部**需登录**：游客/未登录统一 403（理解题记录要归属账号，供周报与能力
评估使用）。校验/生成/落库都在 ``quiz.py``，本模块只做参数绑定、错误码映射
与登录校验。

错误语义：

- 400：kind / contentRef / targetLang / chosenIndex / elapsedMs 非法；
- 403：游客/未登录；
- 404：字幕缓存不存在、lesson/question 不存在或是别人的；
- 422：双语字幕太短、模型生成失败或全部未通过 QC；
- 429：理解题日配额/预算用完（feature=quiz）；
- 503：数据库表缺失（未跑 0007_quiz 迁移）。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import AliasChoices, BaseModel, Field

import quiz
from ai import quota

router = APIRouter(tags=["lesson"])


# ---------------------------------------------------------------------------
# 请求模型
# ---------------------------------------------------------------------------

class StartLessonRequest(BaseModel):
    kind: str = ""
    content_ref: str = Field(
        default="",
        validation_alias=AliasChoices("contentRef", "content_ref"),
    )
    target_lang: str | None = Field(
        default=None,
        validation_alias=AliasChoices("targetLang", "target_lang"),
    )


class AnswerRequest(BaseModel):
    question_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("questionId", "question_id"),
    )
    chosen_index: int | None = Field(
        default=None,
        validation_alias=AliasChoices("chosenIndex", "chosen_index"),
    )
    elapsed_ms: int | None = Field(
        default=None,
        validation_alias=AliasChoices("elapsedMs", "elapsed_ms"),
    )


# ---------------------------------------------------------------------------
# 公共校验 / 错误映射
# ---------------------------------------------------------------------------

def _require_login(request: Request) -> dict:
    """理解题必须归属登录账号；游客/未登录 403。"""
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(
            status_code=403,
            detail="理解题需要登录后使用（答题记录不跨设备同步）。",
        )
    return user


def _raise_quiz_error(exc: Exception) -> None:
    """把 quiz 的领域异常映射成 HTTP 错误。"""
    if isinstance(exc, quiz.QuizUnavailable):
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if isinstance(exc, quiz.QuizNotFound):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, quiz.ContentNotFound):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, (quiz.ContentTooShort, quiz.GenerationFailed)):
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if isinstance(exc, quiz.InvalidRequest):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if isinstance(exc, quiz.QuizError):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise exc


# ---------------------------------------------------------------------------
# 端点
# ---------------------------------------------------------------------------

@router.post("/api/lesson/start")
async def start_lesson(payload: StartLessonRequest, request: Request):
    """确保一条内容项 + 3 道理解题；缓存命中不重复调用模型。"""
    user = _require_login(request)
    try:
        return await quiz.start_lesson(
            user["id"], payload.kind, payload.content_ref, payload.target_lang
        )
    except quota.QuotaExceeded as exc:
        raise HTTPException(
            status_code=getattr(exc, "status_code", 429), detail=str(exc)
        ) from exc
    except Exception as exc:  # noqa: BLE001 - 统一映射领域错误
        _raise_quiz_error(exc)
        raise  # pragma: no cover - _raise_quiz_error 必抛


@router.get("/api/lesson/{lesson_id}/questions")
def get_lesson_questions(lesson_id: str, request: Request):
    """取 lesson 的已通过题目；别人的 lesson 返回 404，不泄露存在性。"""
    user = _require_login(request)
    try:
        return quiz.get_questions(user["id"], lesson_id)
    except Exception as exc:  # noqa: BLE001
        _raise_quiz_error(exc)
        raise  # pragma: no cover


@router.post("/api/lesson/answer")
def answer_lesson_question(payload: AnswerRequest, request: Request):
    """记录一次作答：判分 + 正确答案 + 解释 + 证据 block/时间点。"""
    user = _require_login(request)
    if not payload.question_id:
        raise HTTPException(status_code=400, detail="缺少 questionId。")
    try:
        return quiz.answer_question(
            user["id"],
            payload.question_id,
            payload.chosen_index,
            payload.elapsed_ms,
        )
    except Exception as exc:  # noqa: BLE001
        _raise_quiz_error(exc)
        raise  # pragma: no cover


@router.get("/api/lesson/{lesson_id}/result")
def get_lesson_result(lesson_id: str, request: Request):
    """结果统计：答对/答错/正确率 + 错题证据列表。"""
    user = _require_login(request)
    try:
        return quiz.get_result(user["id"], lesson_id)
    except Exception as exc:  # noqa: BLE001
        _raise_quiz_error(exc)
        raise  # pragma: no cover
