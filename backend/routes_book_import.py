"""用户导入公版书的 HTTP 路由（产品化：Gutenberg / Standard Ebooks 链接导入）。

端点：

- ``POST /api/books/import/preview``                       预览元数据/章节（不落库）；
- ``POST /api/books/import``                               导入到「我的书」（幂等）；
- ``GET  /api/books/imported``                             当前用户的导入书列表；
- ``GET  /api/books/imported/{id}``                        详情 + 章节索引；
- ``GET  /api/books/imported/{id}/chapters/{n}``           **实时抓取**原文 + 已缓存译文；
  可选 ``?level=``：显式生成/读取该章教学分析（specs/028），额外返回
  ``glosses`` / ``languagePoints`` / ``analysisLevel``（缓存命中零模型零扣费）；
- ``POST /api/books/imported/{id}/chapters/{n}/translate`` 按章翻译（AI 配额，缓存幂等）；
- ``DELETE /api/books/imported/{id}``                      删除书目与译文。

身份：**全部需登录**（未登录/游客 401，提示登录）。原因：导入书目与译文缓存
必须归属账号，游客换设备/清 Cookie 就丢，不做游客导入。

限流：

- 预览/导入共用 ``/api/books/*`` 的每分钟 IP 桶（见 main.py 中间件）；
- 真正导入每用户 10 本/天（``config.RATE_LIMIT_BOOK_IMPORT_PER_DAY``）；重复导入
  同一本不占日限（先查重再计数）；
- 翻译复用 ``feature=reading`` 的现有 AI 日配额：缓存命中不调模型、不扣配额，
  每个模型批次占 1 个配额；超限 429。

错误语义：

- 400：url 缺失/非 https/带查询串/章节页链接；或 ``level`` 不是支持的高亮档；
- 401：未登录/游客；
- 404：书目/章节不存在或不属于当前用户（不泄露存在性）；
- 422：链接不是白名单公版源、DRM/EPUB、抓取/解析失败（预览/导入）；
- 429：导入日限或 AI 日配额用完；
- 503：数据库/0018 表缺失、没有可用模型、读章时源站暂时不可用。

业务逻辑全部在 ``book_import.py``；本模块只做参数校验、身份与错误映射。
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import AliasChoices, BaseModel, Field

import book_import
import ai_auth
import languages
import ratelimit
import config
import teaching_analysis
from ai import quota

logger = logging.getLogger("linguatrek.book_import.routes")

router = APIRouter(tags=["books"])


class ImportRequest(BaseModel):
    url: str


class TranslateRequest(BaseModel):
    target_lang: str | None = Field(
        default=None,
        validation_alias=AliasChoices("targetLang", "target_lang"),
    )


def _require_login(request: Request) -> dict:
    """导入公版书/翻译必须归属登录账号；游客/未登录 403 login_required。"""
    return ai_auth.require_ai_user(
        request,
        detail="导入公版书需要登录（「我的书」与译文缓存保存在账号下）。",
    )


def _target_lang_or_400(raw: str | None) -> str:
    try:
        return languages.resolve_target_lang(raw)
    except languages.UnsupportedLanguage as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _raise_book_error(exc: Exception, *, chapter: bool = False) -> None:
    """领域错误 → HTTP。读章的源站失败给 503（可重试），预览/导入给 422。"""
    if isinstance(exc, quota.QuotaExceeded):
        # 429 + code=quota_exceeded 由 main.py 统一映射（M7a）。
        raise exc
    if isinstance(exc, languages.UnsupportedLanguage):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if isinstance(exc, book_import.BookSourceError):
        status_code = 503 if chapter else getattr(exc, "status_code", 422)
        headers = {"Retry-After": "60"} if status_code == 503 else None
        raise HTTPException(
            status_code=status_code, detail=exc.detail, headers=headers
        ) from exc
    if isinstance(exc, book_import.BookImportError):
        raise HTTPException(
            status_code=getattr(exc, "status_code", 400), detail=exc.detail
        ) from exc
    raise exc


# ---------------------------------------------------------------------------
# 预览 / 导入
# ---------------------------------------------------------------------------

@router.post("/api/books/import/preview")
def preview_import(payload: ImportRequest, request: Request):
    """解析链接并抓取元数据/章节索引；只读，不写数据库、不返回原文。"""
    _require_login(request)
    try:
        return book_import.preview_book(payload.url)
    except Exception as exc:  # noqa: BLE001 - 统一映射领域错误
        _raise_book_error(exc)
        raise  # pragma: no cover


@router.post("/api/books/import")
def import_public_domain_book(
    payload: ImportRequest, request: Request, targetLang: str | None = None
):
    """导入到当前用户「我的书」；同一本书重复导入返回已有记录。"""
    user = _require_login(request)
    lang = _target_lang_or_400(targetLang)
    try:
        ref = book_import.parse_book_url(payload.url)
        existing = book_import.find_imported_by_ref(user["id"], ref, lang)
        if existing is not None:
            return {**existing, "status": "ok"}
        limit = max(0, int(getattr(config, "RATE_LIMIT_BOOK_IMPORT_PER_DAY", 10) or 0))
        retry_after = ratelimit.consume_daily(
            "book_import", f"user:{user['id']}", limit
        )
        if retry_after is not None:
            raise HTTPException(
                status_code=429,
                detail=f"今天的导入次数已用完（每天 {limit} 本），请明天再试。",
                headers={"Retry-After": str(retry_after)},
            )
        return {
            **book_import.import_book(user["id"], payload.url, lang),
            "status": "ok",
        }
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        _raise_book_error(exc)
        raise  # pragma: no cover


# ---------------------------------------------------------------------------
# 我的导入：列表 / 详情 / 原文 + 译文
# ---------------------------------------------------------------------------

@router.get("/api/books/imported")
def list_imported_books(request: Request, targetLang: str | None = None):
    user = _require_login(request)
    lang = _target_lang_or_400(targetLang)
    try:
        return book_import.list_imported_books(user["id"], lang)
    except Exception as exc:  # noqa: BLE001
        _raise_book_error(exc)
        raise  # pragma: no cover


@router.get("/api/books/imported/{book_id}")
def get_imported_book(book_id: str, request: Request, targetLang: str | None = None):
    user = _require_login(request)
    lang = _target_lang_or_400(targetLang)
    try:
        return book_import.get_imported_book(user["id"], book_id, lang)
    except Exception as exc:  # noqa: BLE001
        _raise_book_error(exc)
        raise  # pragma: no cover


async def _attach_chapter_analysis(
    payload: dict, user_id: str, lang: str, level: str | None
) -> dict:
    """可选：给导入书章节补教学分析（specs/028，与公版书同一份缓存）。

    只有显式传 ``level`` 才执行——导入书可能几十章，不能打开就逐章生成
    （D5-1：按钮显式按需生成）。调用路径与 ``routes_books`` 的公版书一致：
    同一个 ``teaching_analysis.attach_to_payload``，缓存键仍是
    ``(content_hash, level, target_lang, analysis_version)``，命中时零模型
    零扣费；计费/配额沿用 028 的既有 ``feature=analysis`` 路径。

    与公版书同样的保护：本章译文不齐或内容为空时跳过（不在未翻译章节里
    缓存空释义）。分析失败由 ``attach_to_payload`` 静默兜底，读书不受影响。
    """
    if not level:
        return payload
    try:
        teaching_analysis.normalize_level(level)
    except teaching_analysis.AnalysisInvalidRequest as exc:
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
        return payload
    wrapper = {"transcript": paragraphs}
    analysis = await teaching_analysis.attach_to_payload(
        wrapper,
        level=level,
        target_lang=lang,
        content_ref=f"book:{payload.get('bookId') or ''}:{payload.get('chapter')}",
        user_id=user_id,
    )
    if analysis is None:
        return payload
    payload.update(book_import.chapter_analysis_fields(wrapper))
    payload["analysisVersion"] = (
        wrapper.get("analysisVersion") or teaching_analysis.ANALYSIS_VERSION
    )
    payload["analysisLevel"] = analysis.get("level") or level
    return payload


@router.get("/api/books/imported/{book_id}/chapters/{number}")
async def get_imported_book_chapter(
    book_id: str,
    number: int,
    request: Request,
    targetLang: str | None = None,
    level: str | None = None,
):
    """按章实时抓原文；已有译文返回 ``zh``，没有则 ``zh: null``（可手动翻译）。

    可选 ``?level=``（高亮档）：显式生成本章教学分析并附带 ``glosses`` /
    ``languagePoints``；不传时返回形状与旧版本完全一致。
    """
    user = _require_login(request)
    lang = _target_lang_or_400(targetLang)
    try:
        payload = await asyncio.to_thread(
            book_import.build_chapter_payload, user["id"], book_id, number, lang
        )
    except Exception as exc:  # noqa: BLE001
        _raise_book_error(exc, chapter=True)
        raise  # pragma: no cover
    return await _attach_chapter_analysis(payload, user["id"], lang, level)


# ---------------------------------------------------------------------------
# 翻译 / 删除
# ---------------------------------------------------------------------------

@router.post("/api/books/imported/{book_id}/chapters/{number}/translate")
async def translate_imported_book_chapter(
    book_id: str, number: int, payload: TranslateRequest, request: Request
):
    """翻译一章（只补缺失段）；缓存命中不调模型/不扣配额，失败可重试。"""
    user = _require_login(request)
    lang = _target_lang_or_400(payload.target_lang)
    try:
        return await book_import.translate_chapter(
            user["id"], book_id, number, lang
        )
    except Exception as exc:  # noqa: BLE001
        _raise_book_error(exc, chapter=True)
        raise  # pragma: no cover


@router.delete("/api/books/imported/{book_id}")
def delete_imported_book(book_id: str, request: Request):
    user = _require_login(request)
    try:
        book_import.delete_imported_book(user["id"], book_id)
    except Exception as exc:  # noqa: BLE001
        _raise_book_error(exc)
        raise  # pragma: no cover
    return {"ok": True, "bookId": book_id}
