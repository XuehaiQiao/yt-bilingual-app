"""公版书阅读库 HTTP 路由（用户需求：公版书系列阅读库）。

端点：

- ``GET /api/books``                         系列分组 + 每本可读章节数；
- ``GET /api/books/{book_id}``               单本元数据 + 已导入章节索引 + 同系列书目；
- ``GET /api/books/{book_id}/chapters/{n}``  **实时抓取**公版源原文，按段落与本地
  中译文/全局译文缓存对齐返回 ``paragraphs: [{index, en, zh}]``；译文缺失段落
  ``zh: null``，并用 ``translationStatus`` 标记 ``cached`` / ``partial`` /
  ``missing``（无译文的默认状态，保持兼容）。可选 ``?level=``：登录用户额外
  生成/缓存该高亮档的教学分析（highlights/idioms/culture，缓存命中零模型）；
- ``POST /api/books/{book_id}/chapters/{n}/translate``  公开/游客可用的**按需
  翻译**：只翻缺失段落，写全局缓存 ``book_chapter_translations``，返回完整章节
  （``cached: false``）；再次调用命中缓存返回 ``cached: true``，不调模型、不扣费。

目标语言：查询参数 ``lang``（兼容 ``targetLang``），缺省 ``zh-CN``；非法代码 400。
本地书稿只有中文，所以其他目标语言的译文只来自全局缓存。

身份与缓存：

- 公开只读、免登录；``/api/books*`` 在 ``main.py`` 的公开白名单里，中间件不创建
  游客身份、不下发 Cookie（与 /api/library 一致）；
- 书单/详情是本地元数据，可缓存 5 分钟；**章节含实时抓取的英文原文，一律
  ``Cache-Control: no-store``**，不把公版源正文交给浏览器缓存；
- 章节抓取按 IP 限速（``RATE_LIMIT_BOOKS_PER_MINUTE``）；按需翻译额外限制
  **每 IP 每天 N 章**（``RATE_LIMIT_BOOK_TRANSLATE_PER_DAY``，默认 20），
  命中缓存不占名额；翻译成本记入 ``ai_usage``（feature=books），缓存命中不计费。

错误语义：

- 400：目标语言不支持；
- 404：书 id/章节号非法或未导入；
- 413：章节过大，暂不支持整章自动翻译；
- 429：每 IP 每日翻译章节数用完；
- 502：模型没有返回任何可用译文（不写半成品，可重试）；
- 503：书单/译文缓存损坏、没有可用模型，或公版源抓取失败；
- 504：整章翻译超时（已成功的段落已保存，可重试补缺）。
"""
from __future__ import annotations

import logging
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import AliasChoices, BaseModel, Field

import ai_auth
import book_translation
import books
import languages
import teaching_analysis

logger = logging.getLogger("linguatrek.books.routes")

router = APIRouter(tags=["books"])


class TranslateRequest(BaseModel):
    """POST 可选的 JSON body：兼容 `{"targetLang": "vi-VN"}` 写法。"""

    target_lang: str | None = Field(
        default=None,
        validation_alias=AliasChoices("targetLang", "target_lang"),
    )


def _json(payload: dict, *, max_age: int | None) -> JSONResponse:
    headers: dict[str, str] = {}
    if max_age is None:
        headers["Cache-Control"] = "no-store, max-age=0"
        headers["Pragma"] = "no-cache"
    else:
        headers["Cache-Control"] = f"public, max-age={max_age}"
    return JSONResponse(content=payload, headers=headers)


def _manifest_or_503() -> dict:
    try:
        return books.load_manifest()
    except books.BooksUnavailable as exc:
        logger.warning("读取公版书单失败：%s", exc)
        raise HTTPException(status_code=503, detail="公版书库暂时不可用。") from exc


def _target_lang_or_400(raw: str | None) -> str:
    try:
        return languages.resolve_target_lang(raw)
    except languages.UnsupportedLanguage as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _query_lang(lang: str | None, target_lang: str | None) -> str:
    """``?lang=`` 优先；兼容导入书已有的 ``?targetLang=`` 写法。"""
    return _target_lang_or_400(lang if lang is not None else target_lang)


def _rate_limit_key(request: Request) -> str:
    """按 IP 记账（公开路径没有游客身份）；反代后的真实 IP 由反代层处理。"""
    host = request.client.host if request.client else "unknown"
    return f"ip:{host}"


@router.get("/api/books")
def get_books():
    """公版书系列清单；公开、无需登录、不抓取源站。"""
    manifest = _manifest_or_503()
    return _json(books.manifest_summary(manifest), max_age=300)


@router.get("/api/books/{book_id}")
def get_book(book_id: str):
    """单本元数据 + 已导入章节索引 + 同系列全部书目（含 coming_soon）。"""
    manifest = _manifest_or_503()
    try:
        book = books.find_book(manifest, book_id)
    except books.BookNotFound:
        raise HTTPException(status_code=404, detail="书籍不存在。") from None

    series = next(item for item in manifest["series"] if item["id"] == book["seriesId"])
    payload = {
        **books.book_summary(book),
        "series": {
            **books.series_summary(series),
            "books": [books.book_summary(item) for item in series["books"]],
        },
        "chapters": [
            {
                "n": chapter["n"],
                "title": chapter["title"],
                "titleZh": chapter.get("titleZh"),
                "translated": chapter.get("translated", False),
            }
            for chapter in book["chapters"]
        ],
    }
    if book["status"] == "coming_soon":
        payload["message"] = book.get("contentNote") or "这本书已列入系列计划，暂不提供正文。"
    return _json(payload, max_age=300)


async def _attach_chapter_analysis(
    payload: dict, request: Request, lang: str, level: str | None
) -> dict:
    """可选：给章节段落合并教学分析（specs/028）。

    分析有 AI 成本，因此只有显式传 ``level`` 且已登录时才执行；失败静默
    跳过（读书链路不能因为增强功能挂掉）。缓存命中零模型调用。

    B1：分析是增强层，必须在读者已拿到正文之后才执行/等待——调用方（前端
    首屏）先渲染无 level 的章节，再单独请求本函数的结果；本函数只负责把
    结果并进已渲染的 payload，失败也保留正文（P0-04）。每次真正尝试都记
    ``feature=book_analysis total_ms``，便于区分「翻译慢」还是「分析慢」。
    """
    if not level:
        return payload
    started = time.perf_counter()
    book_id = payload.get("bookId") or ""
    chapter_no = payload.get("chapter")
    status = "failed"
    try:
        # 教学分析会调用 AI：M7a 起只有登录用户可用（403 login_required）。
        user = ai_auth.require_ai_user(request)
        try:
            teaching_analysis.normalize_level(level)
        except teaching_analysis.AnalysisInvalidRequest as exc:
            status = "invalid_level"
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        paragraphs = payload.get("paragraphs") or []
        if (
            int(payload.get("missingTranslations") or 0) > 0
            or not paragraphs
            or any(
                not isinstance(paragraph, dict)
                or not isinstance(paragraph.get("zh"), str)
                or not paragraph["zh"].strip()
                for paragraph in paragraphs
            )
        ):
            # Do not cache empty contextual glosses for a chapter that is still
            # being auto-translated; the next open/fetch generates them properly.
            status = "skipped_untranslated"
            return payload
        wrapper = {"transcript": paragraphs}
        unavailable: dict = {}
        analysis = await teaching_analysis.attach_to_payload(
            wrapper,
            level=level,
            target_lang=lang,
            content_ref=f"book:{book_id}:{chapter_no}",
            user_id=user["id"],
            unavailable_out=unavailable,
        )
        # P0-04：失败原因可见（正文仍 200 可读）；成功时 unavailable 为空。
        payload.update(unavailable)
        if analysis is not None:
            payload["paragraphs"] = wrapper["transcript"]
            payload["idioms"] = wrapper.get("idioms") or []
            payload["culture"] = wrapper.get("culture") or []
            payload["analysisVersion"] = (
                wrapper.get("analysisVersion") or teaching_analysis.ANALYSIS_VERSION
            )
            payload["analysisLevel"] = analysis.get("level") or level
            status = "ready"
        else:
            status = "unavailable"
        return payload
    finally:
        logger.info(
            "feature=book_analysis book=%s chapter=%s lang=%s level=%s "
            "status=%s total_ms=%.1f",
            book_id,
            chapter_no,
            lang,
            level,
            status,
            (time.perf_counter() - started) * 1000,
        )


@router.get("/api/books/{book_id}/chapters/{number}")
async def get_book_chapter(
    book_id: str,
    number: int,
    request: Request,
    lang: str | None = None,
    targetLang: str | None = None,
    level: str | None = None,
):
    """实时抓取公版源章节，并与本地中译文/全局译文缓存按段落对齐；不缓存原文。"""
    resolved = _query_lang(lang, targetLang)
    manifest = _manifest_or_503()
    try:
        payload = books.build_chapter_payload(
            manifest, book_id, number, target_lang=resolved
        )
    except books.BookNotFound:
        raise HTTPException(status_code=404, detail="章节不存在或尚未导入。") from None
    except books.BooksUnavailable as exc:
        logger.warning("读取公版书译文失败（%s/%s）：%s", book_id, number, exc)
        raise HTTPException(status_code=503, detail="本地译文损坏，暂时无法打开。") from exc
    except books.BookSourceUnavailable as exc:
        logger.warning("公版源抓取失败（%s/%s）：%s", book_id, number, exc)
        raise HTTPException(
            status_code=503,
            detail="公版源暂时不可用，无法获取本章原文，请稍后重试。",
            headers={"Retry-After": "60"},
        ) from exc

    # 只有数据库里确实有该语言缓存时才合并；表未迁移/库不存在时按无缓存处理，
    # 读者页保持与原行为完全兼容（不因缓存基础设施缺失而 503）。
    cached = book_translation.load_cache_soft(book_id, number, resolved)
    if cached is not None:
        books.merge_cached_translations(
            payload,
            cached["paragraphs"],
            model=cached.get("model"),
            updated_at=cached.get("updated_at"),
        )
    payload = await _attach_chapter_analysis(payload, request, resolved, level)
    return _json(payload, max_age=None)


@router.post("/api/books/{book_id}/chapters/{number}/translate")
async def translate_book_chapter(
    book_id: str,
    number: int,
    request: Request,
    payload: TranslateRequest | None = None,
    lang: str | None = None,
    targetLang: str | None = None,
):
    """按需翻译缺失段落（公开/游客可用，每 IP 每天限额），返回完整章节。

    目标语言优先取查询参数 ``lang`` / ``targetLang``，其次取 JSON body 的
    ``targetLang`` / ``target_lang``；都缺省按 ``zh-CN``。
    """
    # 会触发 AI 翻译：M7a 起仅登录用户可用（游客/匿名 403 login_required）。
    user_id = ai_auth.require_ai_user_id(request)
    raw_lang = lang if lang is not None else targetLang
    if raw_lang is None and payload is not None:
        raw_lang = payload.target_lang
    resolved = _target_lang_or_400(raw_lang)
    manifest = _manifest_or_503()
    try:
        payload = await book_translation.translate_chapter_with_timeout(
            manifest,
            book_id,
            number,
            resolved,
            rate_limit_key=_rate_limit_key(request),
            user_id=user_id,
        )
    except books.BookNotFound:
        raise HTTPException(status_code=404, detail="章节不存在或尚未导入。") from None
    except books.BooksUnavailable as exc:
        logger.warning("读取公版书译文失败（%s/%s）：%s", book_id, number, exc)
        raise HTTPException(status_code=503, detail="本地译文损坏，暂时无法打开。") from exc
    except books.BookSourceUnavailable as exc:
        logger.warning("公版源抓取失败（%s/%s）：%s", book_id, number, exc)
        raise HTTPException(
            status_code=503,
            detail="公版源暂时不可用，无法获取本章原文，请稍后重试。",
            headers={"Retry-After": "60"},
        ) from exc
    except book_translation.BookTranslationRateLimited as exc:
        raise HTTPException(
            status_code=429,
            detail=str(exc),
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc
    except book_translation.BookTranslationTooLarge as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except book_translation.BookTranslationBusy as exc:
        raise HTTPException(
            status_code=503, detail=str(exc), headers={"Retry-After": "5"}
        ) from exc
    except book_translation.BookTranslationTimeout as exc:
        raise HTTPException(
            status_code=504, detail=str(exc), headers={"Retry-After": "30"}
        ) from exc
    except book_translation.BookTranslationFailed as exc:
        raise HTTPException(
            status_code=502, detail=str(exc), headers={"Retry-After": "30"}
        ) from exc
    except book_translation.BookTranslationUnavailable as exc:
        logger.warning("公版书按需翻译不可用（%s/%s）：%s", book_id, number, exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return _json(payload, max_age=None)
