"""读文章 HTTP 路由（V1 用户需求 #3，规格见 ``specs/019-reading``）。

端点：

- ``POST /api/article/import``               URL 抓取或粘贴正文 → 标题/段落
- ``POST /api/article/{id}/translate``       逐段翻译（幂等，只补缺失段）
- ``GET  /api/article/{id}?targetLang=``     标题/段落/已有译文/进度
- ``GET  /api/articles``                     当前用户的文章列表
- ``DELETE /api/article/{id}``               删除文章（段落/译文/进度级联）
- ``PUT  /api/article/{id}/progress``        保存阅读进度

身份选择：**全部需登录，游客/未登录 403**（与复习/理解题/内容发现一致）。
理由：文章与阅读进度要「保存回历史」，必须归属账号；游客态只用 Cookie，
换设备/清 Cookie 就丢，不做游客文章系统。导入在 ``ratelimit`` 里单独限速
（默认 10 次/分钟/用户），翻译走 ``feature=reading`` 的日配额。

错误语义：

- 400：url/text 都缺或同给、正文为空、targetLang/语言非法、paragraphIdx 越界；
- 403：游客/未登录；
- 404：文章不存在或不属于当前用户（不泄露存在性）；
- 422：URL 非 http(s)/SSRF/抓取失败/超大/重定向过多/没抽到正文；
- 429：文章配额或「读文章」AI 日配额用完；
- 503：数据库/0011 表缺失（先跑 alembic upgrade head）。

业务逻辑都在 ``reading.py``；本模块只做参数校验、身份与错误映射。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import AliasChoices, BaseModel, Field

import languages
import reading
from ai import quota

router = APIRouter(tags=["reading"])


class ImportRequest(BaseModel):
    url: str | None = None
    text: str | None = None
    title: str | None = None


class TranslateRequest(BaseModel):
    target_lang: str | None = Field(
        default=None,
        validation_alias=AliasChoices("targetLang", "target_lang"),
    )


class ProgressRequest(BaseModel):
    paragraph_idx: int = Field(
        validation_alias=AliasChoices("paragraphIdx", "paragraph_idx"),
    )


def _require_login(request: Request) -> dict:
    """读文章必须归属登录账号；游客/未登录 403。"""
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(
            status_code=403,
            detail="读文章需要登录后使用（文章与阅读进度保存在账号下）。",
        )
    return user


def _target_lang_or_400(raw: str | None) -> str:
    try:
        return languages.resolve_target_lang(raw)
    except languages.UnsupportedLanguage as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _raise_reading_error(exc: Exception) -> None:
    if isinstance(exc, quota.QuotaExceeded):
        raise HTTPException(
            status_code=getattr(exc, "status_code", 429), detail=str(exc)
        ) from exc
    if isinstance(exc, languages.UnsupportedLanguage):
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if isinstance(exc, reading.ReadingError):
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    raise exc


# ---------------------------------------------------------------------------
# 导入
# ---------------------------------------------------------------------------

@router.post("/api/article/import")
async def import_article(payload: ImportRequest, request: Request):
    """URL 或正文二选一；同用户同 URL 幂等复用。"""
    user = _require_login(request)
    try:
        return await reading.import_article(
            user["id"],
            url=payload.url,
            text=payload.text,
            title=payload.title,
        )
    except Exception as exc:  # noqa: BLE001 - 统一映射领域错误
        _raise_reading_error(exc)
        raise  # pragma: no cover - _raise_reading_error 必抛


# ---------------------------------------------------------------------------
# 翻译
# ---------------------------------------------------------------------------

@router.post("/api/article/{article_id}/translate")
async def translate_article(
    article_id: str, payload: TranslateRequest, request: Request
):
    """逐段翻译到目标语言；已有译文不重译，失败段标 [未翻译] 可重试。"""
    user = _require_login(request)
    lang = _target_lang_or_400(payload.target_lang)
    try:
        return await reading.translate_article(user["id"], article_id, lang)
    except Exception as exc:  # noqa: BLE001 - 统一映射领域错误
        _raise_reading_error(exc)
        raise  # pragma: no cover


# ---------------------------------------------------------------------------
# 读 / 列表 / 删除 / 进度
# ---------------------------------------------------------------------------

@router.get("/api/article/{article_id}")
def get_article(
    article_id: str, request: Request, targetLang: str | None = None
):
    """标题 + 段落（含已有译文）+ 当前用户进度。"""
    user = _require_login(request)
    lang = _target_lang_or_400(targetLang)
    try:
        return reading.get_article_detail(user["id"], article_id, lang)
    except Exception as exc:  # noqa: BLE001
        _raise_reading_error(exc)
        raise  # pragma: no cover


@router.get("/api/articles")
def get_articles(request: Request):
    """当前用户的文章列表（最新在前，带段数与进度）。"""
    user = _require_login(request)
    try:
        return reading.list_articles(user["id"])
    except Exception as exc:  # noqa: BLE001
        _raise_reading_error(exc)
        raise  # pragma: no cover


@router.delete("/api/article/{article_id}")
def delete_article(article_id: str, request: Request):
    """删除文章；段落/译文/进度一并清理。"""
    user = _require_login(request)
    try:
        reading.delete_article(user["id"], article_id)
    except Exception as exc:  # noqa: BLE001
        _raise_reading_error(exc)
        raise  # pragma: no cover
    return {"ok": True, "articleId": article_id}


@router.put("/api/article/{article_id}/progress")
def save_article_progress(
    article_id: str, payload: ProgressRequest, request: Request
):
    """保存阅读到第几段（0-based，必须在 0..段数-1 内）。"""
    user = _require_login(request)
    try:
        progress = reading.save_progress(
            user["id"], article_id, payload.paragraph_idx
        )
    except Exception as exc:  # noqa: BLE001
        _raise_reading_error(exc)
        raise  # pragma: no cover
    return {"ok": True, **progress}
