"""按能力画像推荐内容的 HTTP 路由（用户需求 #10 / specs/018）。

``GET /api/recommendations?limit=6&targetLang=zh-CN&seed=0``

- **登录用户**：用当前 ``user_profiles`` 的 CEFR 区间；没有画像默认 A2–B1；
- **游客**：按任务口径一律默认 A2–B1（不使用游客自己的定位测画像）；
- 已看/已缓存的 videoId 从历史缓存读取并排除；
- 不调用 LLM、不联网，读 ``content/curated.json`` + 当前用户 history 缓存；
- 结果在进程内缓存 10 分钟（历史/画像变化会让缓存键失效），响应带
  ``Cache-Control: private, max-age=600``；
- 游客可用：本端点不是需要登录的写入/付费动作。

错误语义：

- 400：``targetLang`` 非法；
- 422：``limit`` / ``seed`` 不是合法整数或越界（FastAPI 参数校验）；
- 503：``content/curated.json`` 缺失/损坏/未标「待运营复核」。

``seed`` 是给前端「换一批」用的确定性轮转参数（默认 0），不改变筛选规则。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

import guest
import languages
import recommend

router = APIRouter(tags=["recommend"])


@router.get("/api/recommendations")
def get_recommendations(
    request: Request,
    limit: int = Query(recommend.DEFAULT_LIMIT, ge=1, le=recommend.MAX_LIMIT),
    targetLang: str | None = None,
    seed: int = Query(0, ge=0, le=9999),
):
    """按画像区间 + 已看历史返回 1–12 条人工精选视频（默认 6 条）。"""
    try:
        lang = languages.resolve_target_lang(targetLang)
    except languages.UnsupportedLanguage as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    user = getattr(request.state, "user", None)
    guest_hash = getattr(request.state, "guest_hash", None)
    if user:
        identity = user.get("id")
        is_guest = False
    else:
        identity = guest.guest_id(guest_hash) if guest_hash else None
        is_guest = True

    try:
        payload = recommend.recommend(
            identity,
            is_guest=is_guest,
            target_lang=lang,
            limit=limit,
            seed=seed,
        )
    except recommend.RecommendationUnavailable as exc:
        raise HTTPException(status_code=503, detail=exc.detail) from exc

    return JSONResponse(
        content=payload,
        headers={"Cache-Control": "private, max-age=600"},
    )
