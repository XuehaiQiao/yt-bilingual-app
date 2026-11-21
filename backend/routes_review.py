"""复习引擎 HTTP 路由（计划书 §13.2 M2 / specs/013）。

全部端点**需登录**：游客/未登录统一 **403**（M2 的复习数据必须归属账号，
否则换设备后无法恢复）。校验/调度/落库都在 `srs.py`，本模块只做参数校验、
错误码映射与序列化。

端点（契约见 specs/013-review-engine/spec.md）：

- ``POST /api/review/words``           加词（幂等，不重置进度）
- ``PATCH /api/review/words``          标记 / 撤销「已掌握」（幂等 upsert）
- ``GET  /api/review/words``           列出词状态；``?mastered=1`` = 已掌握列表，
  ``?state=`` 按状态筛选
- ``GET  /api/review/queue``           到期词 + 新词队列
- ``POST /api/review/answer``          作答（again/hard/good/easy）
- ``GET  /api/review/stats``           今日到期/已复习/新词/连续天数
- ``POST /api/review/suspend``         手工暂停
- ``DELETE /api/review/suspend``       手工恢复
- ``GET  /api/vocabulary/seen``        单词本「见过次数」（本应属词表路由，
  为避免与并行修改的 ``routes_vocabulary.py`` 冲突临时落在这里；README /
  前端消费方只看路径，见 specs/005 API 契约）

错误语义：

- 400：参数非法（语言代码、评分、空 lemma、负数 elapsedMs）；
- 403：游客/未登录；
- 404：词不在生词本；
- 409：词已暂停（先恢复再作答）；
- 503：数据库表缺失（未跑 0006 迁移）或 fsrs 未安装。
"""
from __future__ import annotations

import logging
import sqlite3

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import AliasChoices, BaseModel, Field

import events
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


class SetMasteredRequest(BaseModel):
    """``PATCH /api/review/words``：标记 / 撤销「已掌握」。

    ``mastered`` 用 ``object`` 接，非法值由路由映射成 400（而不是 pydantic 的
    422），与复习模块其它参数错误口径一致；``source`` 形状由
    ``srs.normalize_source`` 校验。
    """

    lemma: str
    target_lang: str | None = Field(
        default=None,
        validation_alias=AliasChoices("targetLang", "target_lang"),
    )
    mastered: object = None
    source: object = None


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


def _states_or_400(state: str | None) -> tuple[str, ...] | None:
    """``?state=new,review`` → 规范化状态 tuple；省略 = None（不过滤）；非法 400。"""
    if state is None:
        return None
    try:
        return srs.normalize_states(state)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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


@router.patch("/api/review/words")
def set_review_word_mastered(payload: SetMasteredRequest, request: Request):
    """标记 / 撤销「已掌握」（specs/013 v1.1，幂等）。

    词不在生词本时**建行**（等价加词）；已存在只改 ``mastered``，FSRS 参数 /
    ``reps`` / ``dueAt`` 都不动。``mastered=true`` 后该词不进复习队列、不计
    ``newWords`` / ``dueToday``，统计里出现在 ``masteredWords``。
    """
    user = _require_login(request)
    lang = _target_lang_or_400(payload.target_lang)
    if not isinstance(payload.mastered, bool):
        raise HTTPException(
            status_code=400, detail="mastered 必须是布尔值（true/false）。"
        )
    try:
        word = srs.set_mastered(
            user["id"],
            payload.lemma,
            lang,
            payload.mastered,
            now=srs.now_ms(),
            source=payload.source,
        )
    except Exception as exc:  # noqa: BLE001 - 统一映射领域错误
        _raise_review_error(exc)
        raise  # pragma: no cover - _raise_review_error 必抛

    return {"status": "ok", "word": srs.to_public_word(word)}


@router.get("/api/review/words")
def list_review_words(
    request: Request,
    state: str | None = Query(
        default=None,
        description=(
            "逗号分隔的状态子集（new/learning/review/relearning/suspended）；"
            "省略 = 不过滤"
        ),
    ),
    mastered: str | None = Query(
        default=None,
        description="0=未掌握、1=已掌握；省略 = 不过滤（返回全部词）",
    ),
    targetLang: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=200),
):
    """列出词状态：缺省全部词，``?mastered=1`` 即登录用户的「已掌握」列表。

    - 需登录；游客/未登录 403；
    - ``state`` 可逗号分隔（``new/learning/review/relearning/suspended`` 的
      子集，大小写与首尾空白不敏感）；省略 = 不过滤；非法值或空值 **400**；
    - ``mastered`` **只接受 ``0`` / ``1``**（字符串），其它值 400；省略 = 不过滤；
    - ``state`` 与 ``mastered`` / ``targetLang`` 组合生效（AND）；
    - ``targetLang`` 省略 = 全部语言；``limit`` 1–200（默认 100）；
    - **没有分页/offset**：``limit`` 只截断 ``words``，``total`` 是过滤后的总数
      （不受 ``limit`` 影响）；排序 ``COALESCE(last_reviewed_at, created_at)``
      倒序、``id`` 兜底，与暂停词列表一致；
    - 列表读的是与 ``PATCH`` 同一份 ``word_states.mastered``：前端不需要再用
      localStorage 镜像当「已掌握」的真相。
    """
    user = _require_login(request)
    lang = _optional_target_lang_or_400(targetLang)
    states = _states_or_400(state)
    if mastered is not None and mastered not in ("0", "1"):
        raise HTTPException(status_code=400, detail="mastered 只能是 0 或 1。")
    try:
        data = srs.list_words(
            user["id"],
            lang,
            None if mastered is None else int(mastered),
            states=states,
            limit=limit,
            now=srs.now_ms(),
        )
    except Exception as exc:  # noqa: BLE001 - 统一映射领域错误
        _raise_review_error(exc)
        raise  # pragma: no cover - _raise_review_error 必抛

    return {
        "targetLang": data["target_lang"],
        "now": data["now"],
        "total": data["total"],
        "words": [srs.to_public_word(word) for word in data["words"]],
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


# ---------------------------------------------------------------------------
# 单词本辅助：见过次数（GET /api/vocabulary/seen）
# ---------------------------------------------------------------------------
# 归属说明：路径属于「词表」家族（specs/005 API 契约），理想位置是
# ``routes_vocabulary.py``；本轮那个文件正被并行改动（git diff 可见 classify
# 端点），为避免互相覆盖先落在这里。路径与契约不变，前端 / README 不受影响；
# 后续可整段搬回 ``routes_vocabulary.py``。
#
# 与词表公开端点不同，这个端点**需登录**（游客 403）：它读的是当前账号自己的
# learning_events。``/api/vocabulary/`` 在 main.py 属于公开前缀（不签发游客
# Cookie），所以登录闸在路由里显式做。

MAX_SEEN_WORDS = 100


def _parse_seen_words(words: list[str] | None) -> list[str]:
    """``words=a,b,c`` / 重复 ``words=`` 两种写法都接，保持传入顺序去空串。"""
    tokens: list[str] = []
    for raw in words or []:
        for chunk in str(raw).split(","):
            token = chunk.strip()
            if token:
                tokens.append(token)
    return tokens


@router.get("/api/vocabulary/seen")
def get_vocabulary_seen(
    request: Request,
    words: list[str] | None = Query(
        None,
        description="逗号分隔的单词（≤100；也可重复传 words=...）",
    ),
):
    """单词本「见过次数」：按小写词形聚合当前用户的 ``dict_lookup`` 次数。

    - 需登录；游客 403（读的是账号自己的学习事件）；
    - 每批 ≤100 个词；空参数 / 超量 422；
    - 返回 ``{word: count}``：键保留传入词形，计数按小写词形归并（大小写 /
      多余空白的变体合并计数）；没有查词记录的词返回 0 而不是缺省；
    - 事件表未迁移（库没跑到 0002）返回 503，不静默给全 0。
    """
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(
            status_code=403,
            detail="「见过次数」需要登录后使用（数据归属账号，游客不聚合）。",
        )
    tokens = _parse_seen_words(words)
    if not tokens:
        raise HTTPException(status_code=422, detail="words 不能为空。")
    if len(tokens) > MAX_SEEN_WORDS:
        raise HTTPException(
            status_code=422,
            detail=(
                f"words 最多 {MAX_SEEN_WORDS} 个（收到 {len(tokens)} 个）。"
            ),
        )
    try:
        counts = events.lookup_counts(user["id"], tokens)
    except sqlite3.OperationalError as exc:
        detail = str(exc).lower()
        if (
            "no such table" in detail
            or "no such column" in detail
            or "no such function" in detail
        ):
            raise HTTPException(
                status_code=503,
                detail=(
                    "学习事件表不存在（先运行 "
                    "`backend/venv/bin/alembic upgrade head`）。"
                ),
            ) from exc
        raise
    return {
        token: counts.get(events.normalize_lookup_word(token), 0)
        for token in tokens
    }
