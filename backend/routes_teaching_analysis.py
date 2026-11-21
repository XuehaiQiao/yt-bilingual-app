"""AI 教学分析只读接口（specs/028）。

``GET /api/teaching-analysis/{content_ref}?level=&targetLang=&contentHash=``

- 解析 ``content_ref`` 指向的**已有双语字幕缓存**（YouTube videoId 或本地剧集
  ``<show>-S01E01``），拿英文正文 + 现有译文；
- 按 ``(content_hash, level, target_lang, analysis.v5)`` 取缓存：
  命中直接返回（零模型调用、不占配额）；未命中才调用模型生成并落库；
- 返回 ``highlights``（按 block id）/ ``idioms`` / ``culture`` /
  ``analysisVersion``。**不生成题目**：题目走既有 ``/api/lesson/*``（quiz.py，
  已按内容+语言缓存）。

权限与成本（specs/028 v1.1 §1.3「访问策略统一」）：

- **缓存命中是只读、公开的**：全局表 ``content_teaching_analysis`` 已有可复用
  行（``content_hash + level + target_lang + ANALYSIS_VERSION``）时，游客也返回
  200——零模型调用、不占配额、不写 ``ai_usage``；
- **只有需要生成时才要求登录**：游客拿不到可复用行 → 403 ``login_required``
  （specs/036 的稳定错误码）。游客在这里只会看到 200（缓存命中）或 403：
  参数非法/内容不可见/缓存表缺失都不会被当成「请求有问题」暴露给游客，因为
  对游客而言下一步永远是同一个动作——登录；
- 登录用户行为不变：命中免费、未命中按 ``feature=analysis`` 配额生成
  （``AI_DAILY_QUOTA_ANALYSIS``）；错误语义仍是 400/404/429/502/503；
- **同一数据源、同一可见性**：合并进 per-user payload 的分析走
  ``teaching_analysis.attach_to_payload`` → ``ensure_analysis``；本端点的缓存
  命中探测与它读**同一张全局表、同一个缓存键、同一套可复用判定**（见
  :func:`_reusable_cached`）。因此游客从视频 payload 能读到的分析，本端点也能
  读到，不会出现「一条路能读、另一条 403」。
"""
from __future__ import annotations

import asyncio
import json
import os
import re

from fastapi import APIRouter, HTTPException, Request

import ai_auth
import storage
import teaching_analysis
import translate
from ai.ledger import QuotaExceeded

router = APIRouter(tags=["teaching-analysis"])

# 本地剧集引用：show_id-S01E01 / show_id_S01E01 / show_id/S01E01（与 quiz 一致）。
_LOCAL_SHOW_REF_RE = re.compile(
    r"^(?P<show>[A-Za-z0-9][A-Za-z0-9_.-]*?)[-_/]"
    r"S(?P<season>\d{1,2})E(?P<episode>\d{1,3})$",
    re.IGNORECASE,
)

MAX_CONTENT_REF_CHARS = 200


class AnalysisContentNotFound(teaching_analysis.TeachingAnalysisError):
    """找不到该内容在该目标语言下的双语字幕缓存（404）。"""

    status_code = 404
    code = "content_not_found"


def _require_login(request: Request) -> dict:
    """**生成**教学分析必须登录（缓存命中的只读路径不经过这里）。"""
    return ai_auth.require_ai_user(
        request, detail="教学分析需要登录后使用。"
    )


def _history_path(content_ref: str, target_lang: str) -> str | None:
    """content_ref → 该目标语言下的历史缓存文件（视频/本地剧集）。"""
    path = translate.find_history_file_for_video(
        content_ref, target_lang=target_lang
    )
    if path:
        return path
    match = _LOCAL_SHOW_REF_RE.match(content_ref)
    if not match:
        return None
    filename = (
        f"{match.group('show')}_S{int(match.group('season')):02d}"
        f"E{int(match.group('episode')):02d}.json"
    )
    candidate = os.path.join(storage.history_dir(target_lang), filename)
    return candidate if os.path.isfile(candidate) else None


def _load_blocks(content_ref: str, target_lang: str) -> tuple[str, list[dict]]:
    """读内容缓存，返回 ``(content_ref, transcript)``；不存在/语言不符 404。"""
    ref = (content_ref or "").strip()
    if not ref or len(ref) > MAX_CONTENT_REF_CHARS:
        raise AnalysisContentNotFound("内容引用为空或过长。")
    path = _history_path(ref, target_lang)
    if not path:
        raise AnalysisContentNotFound(
            f"没有找到该内容在 {target_lang} 下的双语字幕缓存，请先完成字幕生成。"
        )
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError) as exc:
        raise AnalysisContentNotFound("内容缓存已损坏，请重新生成字幕。") from exc
    if not isinstance(payload, dict):
        raise AnalysisContentNotFound("内容缓存格式非法。")
    if translate.payload_target_lang(payload) != target_lang:
        raise AnalysisContentNotFound(
            f"该缓存不是 {target_lang} 版本，请重新生成字幕。"
        )
    transcript = payload.get("transcript")
    if not isinstance(transcript, list) or not transcript:
        raise AnalysisContentNotFound("内容缓存缺少字幕正文。")
    return ref, transcript


def _analysis_response(content_ref: str, analysis: dict, target_lang: str) -> dict:
    """分析 payload → 端点响应体（缓存命中与生成共用，保证两条路同形）。"""
    return {
        "contentRef": content_ref,
        "level": analysis.get("level"),
        "targetLang": analysis.get("targetLang", target_lang),
        "contentHash": analysis.get("contentHash"),
        "analysisVersion": analysis.get(
            "analysisVersion", teaching_analysis.ANALYSIS_VERSION
        ),
        "highlights": analysis.get("highlights") or {},
        "idioms": analysis.get("idioms") or [],
        "culture": analysis.get("culture") or [],
        "model": analysis.get("model"),
        "createdAt": analysis.get("createdAt"),
    }


def _reusable_cached(
    transcript: list[dict], level: str, target_lang: str
) -> dict | None:
    """只读探测全局分析缓存；返回可直接对外返回的 payload，未命中 None。

    **零模型调用、不占配额、不写 ``ai_usage``**（只读 SQLite + 纯计算）。
    判定与 ``teaching_analysis.ensure_analysis`` 的缓存命中完全一致：同一张
    ``content_teaching_analysis`` 表、同一个缓存键、同一套「可复用」判定
    （``_cache_is_stale``：旧版本 / 空释义行不算命中——它们会走生成路径，因此
    游客也看不到「登录用户会被重新生成」的旧行）。合并进 per-user payload 的
    分析与本端点因此同源、同可见性。
    """
    hash_value = teaching_analysis.content_hash_of(transcript)
    cached = teaching_analysis.load_cached(hash_value, level, target_lang)
    if not isinstance(cached, dict):
        return None
    normalized = teaching_analysis.normalize_blocks(transcript)
    if teaching_analysis._cache_is_stale(cached, normalized, level):
        return None
    return cached


def _guest_cached_view(
    content_ref: str,
    level: str | None,
    target_lang: str | None,
    content_hash: str | None,
) -> dict | None:
    """游客的只读路径：能拿到可复用缓存就返回响应体，否则 None（→ 403）。

    游客不生成分析（specs/036），所以这里只做「读内容缓存 → 算哈希 → 查全局
    分析表」：不调模型、不占配额、不写用量。参数非法/内容不可见/缓存表缺失/
    缓存未命中一律返回 None，由调用方统一抛 403 ``login_required``——
    游客的下一步永远是登录，不把「做不到」伪装成 400/404。
    """
    try:
        lang = teaching_analysis.canonical_target_lang(target_lang)
        analysis_level = teaching_analysis.normalize_level(level)
        ref, transcript = _load_blocks(content_ref, lang)
        provided = (content_hash or "").strip()
        if provided and provided != teaching_analysis.content_hash_of(transcript):
            return None
        cached = _reusable_cached(transcript, analysis_level, lang)
    except teaching_analysis.TeachingAnalysisError:
        return None
    if not isinstance(cached, dict):
        return None
    return _analysis_response(ref, cached, lang)


@router.get("/api/teaching-analysis/{content_ref}")
async def get_teaching_analysis(
    content_ref: str,
    request: Request,
    level: str | None = None,
    targetLang: str | None = None,
    contentHash: str | None = None,
):
    """读取/生成一份内容的教学分析（缓存命中游客可读；生成需登录）。"""
    user = ai_auth.ai_user(request)
    if user is None:
        # 游客：先试只读的全局缓存命中（specs/028 v1.1 §1.3）。SQLite 读放到
        # 线程里，与 ensure_analysis 一样不在事件循环里做阻塞 IO。
        cached_view = await asyncio.to_thread(
            _guest_cached_view, content_ref, level, targetLang, contentHash
        )
        if cached_view is not None:
            return cached_view
        # 需要生成 → 登录闸（specs/036：403 + code=login_required）。
        user = _require_login(request)
    try:
        lang = teaching_analysis.canonical_target_lang(targetLang)
        ref, transcript = _load_blocks(content_ref, lang)
        analysis = await teaching_analysis.ensure_analysis(
            transcript,
            level,
            lang,
            content_ref=ref,
            content_hash=contentHash,
            user_id=user["id"],
        )
    except QuotaExceeded:
        # 429 + code=quota_exceeded 由 main.py 统一映射（M7a 稳定错误码）。
        raise
    except teaching_analysis.TeachingAnalysisError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    return _analysis_response(ref, analysis, lang)
