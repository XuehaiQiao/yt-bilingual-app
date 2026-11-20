"""AI 教学分析只读接口（specs/028）。

``GET /api/teaching-analysis/{content_ref}?level=&targetLang=&contentHash=``

- 解析 ``content_ref`` 指向的**已有双语字幕缓存**（YouTube videoId 或本地剧集
  ``<show>-S01E01``），拿英文正文 + 现有译文；
- 按 ``(content_hash, level, target_lang, analysis.v1)`` 取缓存：
  命中直接返回（零模型调用、不占配额）；未命中才调用模型生成并落库；
- 返回 ``highlights``（按 block id）/ ``idioms`` / ``culture`` /
  ``analysisVersion``。**不生成题目**：题目走既有 ``/api/lesson/*``（quiz.py，
  已按内容+语言缓存）。

权限与成本：分析会产生 AI 成本，因此本端点**需登录**（游客 403），且生成时
沿用现有三层配额（feature=``analysis``，``AI_DAILY_QUOTA_ANALYSIS``）；缓存
命中免费。内部翻译/播放链路通过 ``teaching_analysis.attach_to_payload`` 复用
同一套缓存，不经过本路由。
"""
from __future__ import annotations

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
    """教学分析有 AI 成本，只对登录用户开放（缓存命中也不向游客暴露）。"""
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


@router.get("/api/teaching-analysis/{content_ref}")
async def get_teaching_analysis(
    content_ref: str,
    request: Request,
    level: str | None = None,
    targetLang: str | None = None,
    contentHash: str | None = None,
):
    """读取/生成一份内容的教学分析（登录；缓存命中零模型调用）。"""
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
    return {
        "contentRef": ref,
        "level": analysis.get("level"),
        "targetLang": analysis.get("targetLang", lang),
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
