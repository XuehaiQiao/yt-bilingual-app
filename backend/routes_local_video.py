"""Browser-local video subtitle processing.

The video file never leaves the browser. The client sends only the parsed
subtitle blocks; this route translates them with the normal translation
pipeline and, for signed-in users, generates the same language-points /
contextual-gloss analysis used by other content.

No subtitle text is persisted: the analysis cache stores only
``content_teaching_analysis`` (language points/glosses keyed by content hash),
never the transcript itself.
"""
from __future__ import annotations

import hashlib
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import ai_auth
import billing
import languages
import teaching_analysis
import translate
import translation_batching
from ai import quota
from ai.ledger import QuotaExceeded

logger = logging.getLogger("linguatrek.local_video")

router = APIRouter(tags=["local-video"])

MAX_BLOCKS = 2000
MAX_TEXT_CHARS = 500_000
MAX_TITLE_CHARS = 200


class LocalBlock(BaseModel):
    id: int
    start: float
    end: float
    en: str


class LocalVideoRequest(BaseModel):
    blocks: list[LocalBlock]
    level: str | None = None
    targetLang: str | None = Field(default=None, validation_alias="targetLang")


def _clean_text(value: str) -> str:
    return " ".join(str(value or "").replace("\x00", " ").split())[:20_000]


def _hash_blocks(blocks: list[dict]) -> str:
    digest = hashlib.sha256()
    for block in blocks:
        digest.update(str(block["id"]).encode())
        digest.update(b"\x1f")
        digest.update(str(block["en_text"]).encode("utf-8"))
        digest.update(b"\x1e")
    return digest.hexdigest()[:32]


@router.post("/api/local-video/process")
async def process_local_video(payload: LocalVideoRequest, request: Request):
    """Translate local subtitle blocks and optionally attach language points."""
    # M7a：本地视频字幕翻译/分析都会调用 AI，仅登录用户可用。
    user_id = ai_auth.require_ai_user_id(request)
    blocks = payload.blocks
    if not blocks:
        raise HTTPException(status_code=400, detail="字幕为空。")
    if len(blocks) > MAX_BLOCKS:
        raise HTTPException(status_code=413, detail="字幕段落过多。")

    normalized = []
    total_chars = 0
    for index, block in enumerate(blocks):
        en = _clean_text(block.en)
        if not en:
            continue
        if not (0 <= block.start <= block.end):
            raise HTTPException(status_code=400, detail="字幕时间轴非法。")
        total_chars += len(en)
        if total_chars > MAX_TEXT_CHARS:
            raise HTTPException(status_code=413, detail="字幕文本过长。")
        normalized.append({
            "id": block.id if block.id else index,
            "text": en,
            "start": float(block.start),
            "end": float(block.end),
        })
    if not normalized:
        raise HTTPException(status_code=400, detail="字幕没有可翻译的英文内容。")

    try:
        lang = languages.resolve_target_lang(payload.targetLang)
    except languages.UnsupportedLanguage as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # P2-33/P2-36：与视频共用 token-aware 切批——首批 ≤10 blocks 抢首屏、
    # 稳定期 ≤40 blocks、单批 ≤2,000 源 token（单条超预算仍单独成批）。
    batches = translation_batching.chunk_by_budget(
        normalized,
        lambda block: block["text"],
        translation_batching.VIDEO_FIRST_BATCH_SIZE,
        translation_batching.VIDEO_STEADY_BATCH_SIZE,
        translation_batching.VIDEO_MAX_SOURCE_TOKENS,
    )
    # P2-34/P2-36：1 单位 = 100 blocks，按累计 blocks 给每批分配单位（合计 =
    # ceil(总 blocks/100)，如 120 blocks = 2 单位），不再按批各取整。
    batch_units = quota.units_per_batch(
        "translate", [len(batch) for batch in batches]
    )

    translated: list[dict] = []
    try:
        for batch, units in zip(batches, batch_units):
            result = await translate.process_llm_batch(
                batch,
                vocab_level=payload.level,
                feature="translate",
                user_id=user_id,
                target_lang=lang,
                quota_units=units,
            )
            translated.extend(result)
    except billing.BillingError:
        raise  # 402/409 交给全局处理器（前端读 code=insufficient_balance）
    except QuotaExceeded:
        # 429 + code=quota_exceeded 由 main.py 统一映射（M7a 稳定错误码）。
        raise
    except Exception as exc:  # noqa: BLE001 - model pipeline has its own fallbacks
        logger.exception("local subtitle translation failed")
        raise HTTPException(status_code=502, detail="字幕翻译暂时不可用。") from exc

    # Keep the response in the exact block order, even if a model omitted one.
    by_id = {str(item.get("id")): item for item in translated if isinstance(item, dict)}
    output_blocks: list[dict] = []
    for item in normalized:
        result = by_id.get(str(item["id"]), {})
        output_blocks.append({
            "id": item["id"],
            "start": item["start"],
            "end": item["end"],
            "en_text": item["text"],
            "zh_text": result.get("zh_text") or translate.UNTRANSLATED_MARKER,
        })

    analysis: dict | None = None
    analysis_error: str | None = None
    if user_id:
        try:
            level = teaching_analysis.normalize_level(payload.level)
            analysis = await teaching_analysis.ensure_analysis(
                [
                    {
                        "id": item["id"],
                        "en_text": item["en_text"],
                        "zh_text": item["zh_text"],
                    }
                    for item in output_blocks
                ],
                level,
                lang,
                content_ref=f"local-video:{_hash_blocks(output_blocks)}",
                user_id=user_id,
            )
        except QuotaExceeded:
            analysis_error = "quota"
        except Exception as exc:  # noqa: BLE001 - analysis is an enhancement
            logger.warning("local subtitle analysis failed: %s", exc)
            analysis_error = "failed"

    return {
        "blocks": output_blocks,
        "targetLang": lang,
        "analysisVersion": (analysis or {}).get("analysisVersion"),
        "analysisLevel": (analysis or {}).get("level"),
        "highlights": (analysis or {}).get("highlights") or {},
        "idioms": (analysis or {}).get("idioms") or [],
        "culture": (analysis or {}).get("culture") or [],
        "analysisError": analysis_error,
    }
