"""复习引擎 HTTP 路由（计划书 §13.2 M2 / specs/013）。

全部端点**需登录**：游客/未登录统一 **403**（M2 的复习数据必须归属账号，
否则换设备后无法恢复）。校验/调度/落库都在 `srs.py`，本模块只做参数校验、
错误码映射与序列化。

端点（契约见 specs/013-review-engine/spec.md）：

- ``POST /api/review/words``           加词（幂等，不重置进度）
- ``GET  /api/review/queue``           到期词 + 新词队列
- ``POST /api/review/answer``          作答（again/hard/good/easy）
- ``GET  /api/review/stats``           今日到期/已复习/新词/连续天数
- ``POST /api/review/suspend``         手工暂停
- ``DELETE /api/review/suspend``       手工恢复

错误语义：

- 400：参数非法（语言代码、评分、空 lemma、负数 elapsedMs）；
- 403：游客/未登录；
- 404：词不在生词本；
- 409：词已暂停（先恢复再作答）；
- 503：数据库表缺失（未跑 0006 迁移）或 fsrs 未安装。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import AliasChoices, BaseModel, Field

import srs

logger = logging.getLogger(__name__)

router = APIRouter(tags=["review"])

DEFAULT_TARGET_LANG = "zh-CN"


# ---------------------------------------------------------------------------
# 请求模型
# ---------------------------------------------------------------------------

class AddWordRequest(BaseModel):
    lemma: str
    target_lang: str | None = Field(
        default=None,
        validation_alias=AliasChoices("targetLang", "target_lang"),
    )
    # 来源形状由 srs.normalize_source 校验（str / dict / null），这里用 Any
    # 是为了把非法形状映射成 400 而不是 pydantic 的 422。
    source: object = None


class AnswerRequest(BaseModel):
    lemma: str
    rating: str
    target_lang: str | None = Field(
        default=None,
        validation_alias=AliasChoices("targetLang", "target_lang"),
    )
    elapsed_ms: int | None = Field(
        default=None,
        validation_alias=AliasChoices("elapsedMs", "elapsed_ms"),
    )


class SuspendRequest(BaseModel):
    lemma: str
    target_lang: str | None = Field(
        default=None,
        validation_alias=AliasChoices("targetLang", "target_lang"),
    )


# ---------------------------------------------------------------------------
# 公共校验 / 错误映射
# ---------------------------------------------------------------------------

def _require_login(request: Request) -> dict:
    """复习数据必须归属登录账号；游客/未登录 403。"""
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(
            status_code=403,
            detail="复习功能需要登录后使用（游客数据不跨设备同步）。",
        )
    return user


def _target_lang_or_400(raw: str | None) -> str:
    try:
        return srs.canonical_target_lang(raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _optional_target_lang_or_400(raw: str | None) -> str | None:
    """统计端点：省略/空串 = 全部语言；给了就校验。"""
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None
    return _target_lang_or_400(raw)


def _raise_review_error(exc: Exception) -> None:
    """把 srs 的领域异常映射成 HTTP 错误。"""
    if isinstance(exc, srs.ReviewUnavailable):
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if isinstance(exc, srs.WordNotFound):
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if isinstance(exc, srs.WordSuspended):
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if isinstance(exc, ValueError):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    raise exc


# ---------------------------------------------------------------------------
# 加词
# ---------------------------------------------------------------------------

@router.post("/api/review/words")
def add_review_word(
    payload: AddWordRequest, request: Request, response: Response
):
    """把词加入生词本：已存在返回 200 且不重置进度，新建返回 201。

    ``source`` 可传 ``{contentRef, sentenceId}``（也接受 snake_case / videoId），
    用于回答「这个词从哪来」；同一来源重复提交不会产生重复行。
    """
    user = _require_login(request)
    lang = _target_lang_or_400(payload.target_lang)
    try:
        word = srs.add_word(
            user["id"],
            payload.lemma,
            lang,
            payload.source,
            now=srs.now_ms(),
        )
    except Exception as exc:  # noqa: BLE001 - 统一映射领域错误
        _raise_review_error(exc)
        raise  # pragma: no cover - _raise_review_error 必抛

    created = bool(word.get("created"))
    response.status_code = 201 if created else 200
    return {
        "status": "ok",
        "created": created,
        "word": srs.to_public_word(word),
    }


# ---------------------------------------------------------------------------
# 队列 / 作答 / 统计
# ---------------------------------------------------------------------------

@router.get("/api/review/queue")
def get_review_queue(
    request: Request,
    limit: int = Query(default=20, ge=1, le=100),
    newLimit: int = Query(default=10, ge=0, le=100),
    targetLang: str = Query(default=DEFAULT_TARGET_LANG),
):
    """到期队列 + 新词（总条数受 ``limit`` 限制，新词另有 ``newLimit``）。

    到期词按 ``due_at`` 升序在前，新词按 ``created_at`` 升序在后；
    不返回释义，前端按需再调 ``/api/define``。
    """
    user = _require_login(request)
    lang = _target_lang_or_400(targetLang)
    try:
        queue = srs.get_due(
            user["id"],
            limit=limit,
            now=srs.now_ms(),
            target_lang=lang,
            new_limit=newLimit,
        )
    except Exception as exc:  # noqa: BLE001
        _raise_review_error(exc)
        raise  # pragma: no cover

    return srs.to_public_queue(queue)


@router.post("/api/review/answer")
def answer_review(payload: AnswerRequest, request: Request):
    """记录一次作答并推进 FSRS 状态。

    连续第 3 次 ``again`` 会自动 suspend，响应 ``autoSuspended=true``；
    之后作答返回 409，需先 ``DELETE /api/review/suspend`` 恢复。
    """
    user = _require_login(request)
    lang = _target_lang_or_400(payload.target_lang)
    try:
        result = srs.record_answer(
            user["id"],
            payload.lemma,
            payload.rating,
            lang,
            elapsed_ms=payload.elapsed_ms,
            now=srs.now_ms(),
        )
    except Exception as exc:  # noqa: BLE001
        _raise_review_error(exc)
        raise  # pragma: no cover

    word = srs.to_public_word(result["word"])
    return {
        "status": "ok",
        "word": word,
        "suspended": word["state"] == srs.STATE_SUSPENDED,
        "autoSuspended": bool(result["auto_suspended"]),
        "dueAt": word["dueAt"],
    }


@router.get("/api/review/stats")
def review_stats(
    request: Request,
    targetLang: str | None = Query(default=None),
):
    """今日到期 / 今日已复习 / 新词 / 连续天数。

    「今日」按 **UTC 日界**（``due_at`` 等字段也是毫秒 UTC，展示时区由前端
    决定）；省略 ``targetLang`` 时统计全部语言。
    """
    user = _require_login(request)
    lang = _optional_target_lang_or_400(targetLang)
    try:
        stats = srs.get_stats(user["id"], target_lang=lang, now=srs.now_ms())
    except Exception as exc:  # noqa: BLE001
        _raise_review_error(exc)
        raise  # pragma: no cover

    return srs.to_public_stats(stats)


# ---------------------------------------------------------------------------
# 暂停 / 恢复
# ---------------------------------------------------------------------------

@router.get("/api/review/suspended")
def list_suspended_review_words(
    request: Request,
    targetLang: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=200),
):
    """暂停中的词列表（恢复入口用）；省略 targetLang 时覆盖全部语言。"""
    user = _require_login(request)
    lang = _optional_target_lang_or_400(targetLang)
    try:
        data = srs.list_suspended(user["id"], lang, limit=limit)
    except Exception as exc:  # noqa: BLE001
        _raise_review_error(exc)
        raise  # pragma: no cover
    return {
        "targetLang": data["target_lang"],
        "now": data["now"],
        "total": data["total"],
        "words": [srs.to_public_word(word) for word in data["words"]],
    }


@router.post("/api/review/suspend")
def suspend_review(payload: SuspendRequest, request: Request):
    """手工暂停一个词（幂等）：不进队列，作答返回 409。"""
    user = _require_login(request)
    lang = _target_lang_or_400(payload.target_lang)
    try:
        word = srs.set_suspended(
            user["id"], payload.lemma, lang, suspended=True, now=srs.now_ms()
        )
    except Exception as exc:  # noqa: BLE001
        _raise_review_error(exc)
        raise  # pragma: no cover

    return {
        "status": "ok",
        "suspended": True,
        "word": srs.to_public_word(word),
    }


@router.delete("/api/review/suspend")
async def restore_review_suspend(
    request: Request,
    lemma: str | None = Query(default=None),
    targetLang: str | None = Query(default=None),
    target_lang: str | None = Query(default=None),
):
    """手工恢复一个被暂停的词（幂等）。

    ``lemma`` 可放 query（``?lemma=hello&targetLang=zh-CN``），也兼容 JSON body
    （``{"lemma": "...", "targetLang": "..."}``）；恢复后失败计数清零。
    """
    user = _require_login(request)
    body: dict = {}
    if not targetLang:
        targetLang = target_lang
    if not lemma:
        try:
            parsed = await request.json()
        except Exception:  # noqa: BLE001 - 空 body / 非 JSON 都按缺参处理
            parsed = None
        if isinstance(parsed, dict):
            body = parsed
        lemma = body.get("lemma") if lemma is None else lemma
        if not targetLang:
            targetLang = body.get("targetLang") or body.get("target_lang")
    if not lemma or not str(lemma).strip():
        raise HTTPException(status_code=400, detail="缺少 lemma。")

    lang = _target_lang_or_400(targetLang)
    try:
        word = srs.set_suspended(
            user["id"], str(lemma), lang, suspended=False, now=srs.now_ms()
        )
    except Exception as exc:  # noqa: BLE001
        _raise_review_error(exc)
        raise  # pragma: no cover

    return {
        "status": "ok",
        "suspended": False,
        "word": srs.to_public_word(word),
    }
