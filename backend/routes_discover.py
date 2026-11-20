"""内容发现 HTTP 路由（V1 主题搜索，见 specs/017-discover）。

``POST /api/discover``：自然语言（中/英）→ 2–3 个英文检索词 → YouTube 搜索 →
去重/时长过滤 → 英文字幕探测 → LLM 重排 3–5 个候选（标题/频道/时长/缩略图/
难度估计/一句理由/是否有英文字幕）。用户选中后仍走现有估价流程。

身份与限速：

- **需登录**：游客/未登录返回 403（中间件仍会下发游客 Cookie，但本端点不服务游客）；
- **5 次/分钟/用户**：由 ``ratelimit`` 的 ``/api/discover`` 桶在中间件层执行，
  超限统一 429 + ``Retry-After``（见 ``config.RATE_LIMIT_DISCOVER_PER_MINUTE``）。

错误语义：

- 400：query 为空/超 200 字/像 YouTube 链接、targetLang 非法；
- 403：未登录/游客；
- 429：限速；
- 503：搜索全部失败（yt-dlp 不可用）；
- 504：整体预算耗尽且没有可用候选。

搜索/探测/LLM 都在 ``discover.py``；本模块只做参数校验、身份与错误映射。
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request
from pydantic import AliasChoices, BaseModel, Field

import discover
import ai_auth
import languages

router = APIRouter(tags=["discover"])


class DiscoverRequest(BaseModel):
    query: str = ""
    target_lang: str | None = Field(
        default=None,
        validation_alias=AliasChoices("targetLang", "target_lang"),
    )
    force: bool = False


def _require_login(request: Request) -> dict:
    """内容发现（AI 改写/重排）需要登录用户；游客/未登录 403 login_required。"""
    return ai_auth.require_ai_user(
        request, detail="内容发现需要登录后使用。"
    )


@router.post("/api/discover")
async def discover_content(payload: DiscoverRequest, request: Request):
    """按自然语言主题发现 3–5 个有英文字幕的 YouTube 候选。"""
    user = _require_login(request)

    query = discover.normalize_query(payload.query)
    if not query:
        raise HTTPException(status_code=400, detail="请输入 1–200 个字符的学习主题。")
    if len(query) > 200:
        raise HTTPException(status_code=400, detail="请输入 1–200 个字符的学习主题。")
    if discover.looks_like_youtube_url(query):
        raise HTTPException(
            status_code=400,
            detail="这看起来是 YouTube 链接。请直接粘贴完整链接，或换一个主题描述。",
        )

    try:
        target_lang = languages.resolve_target_lang(payload.target_lang)
    except languages.UnsupportedLanguage as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # 外层兜底比内部总预算多 1 秒：正常情况由 discover.py 的 deadline 返回部分结果；
    # 这里只防「某个同步调用卡死」时请求无限挂着。
    outer_timeout = discover.total_timeout_seconds() + 1.0
    try:
        return await asyncio.wait_for(
            discover.discover(
                query,
                target_lang,
                user_id=user.get("id"),
                force=bool(payload.force),
            ),
            timeout=outer_timeout,
        )
    except discover.DiscoverTimeout as exc:
        raise HTTPException(status_code=504, detail=exc.detail) from exc
    except discover.DiscoverUnavailable as exc:
        raise HTTPException(status_code=503, detail=exc.detail) from exc
    except asyncio.TimeoutError as exc:
        raise HTTPException(
            status_code=504,
            detail="发现服务超时（>20s）。请重试，或直接粘贴 YouTube 链接。",
        ) from exc
