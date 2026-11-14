"""内容路由：本地剧集（SRT）+ 句子精背。

本地剧集复用与 YouTube 完全相同的翻译/缓存/自愈逻辑；
句子精背只读 content/sentences/ 下的静态 JSON（specs/009）。
"""
import asyncio
import json
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import llm
import local_shows
import storage
from config import SENTENCES_DIR, SUBTITLES_DIR, resolve_model
from transcripts import group_srt_blocks, parse_srt
from translate import (
    mock_llm_processing,
    needs_retranslation,
    process_llm_batch,
    retranslate_marked_blocks,
)

router = APIRouter()

# ====================================================
# Local Subtitle (SRT) Integration
# ====================================================

# Show metadata for display purposes
SHOW_METADATA = {
    "house-of-cards": {
        "title": "House of Cards",
        "title_zh": "纸牌屋",
        "thumbnail": "/images/house-of-cards.png",
        "seasons": {1: 13, 2: 13, 3: 13, 4: 13, 5: 13, 6: 8}
    }
}


def _read_show_meta_file(show_id: str) -> dict:
    """读取 subtitles/<show_id>/meta.json（导入播放列表时生成，可选）。

    文件损坏或格式不对时只打日志并忽略，不能让一个坏 meta.json 拖垮整个列表。
    """
    meta_path = os.path.join(SUBTITLES_DIR, show_id, "meta.json")
    if not os.path.exists(meta_path):
        return {}
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as exc:
        print(f"⚠️  忽略无法读取的 {meta_path}：{exc}")
        return {}
    return data if isinstance(data, dict) else {}


def _resolve_show_meta(show_id: str, default_title: str, default_title_zh: str) -> dict:
    """合并本地剧集展示元数据，优先级：meta.json > SHOW_METADATA > 自动标题。

    meta.json 只覆盖 title / title_zh / thumbnail，且空字符串不生效；
    没有 meta.json 时返回的字段与改动前完全一致。
    """
    meta = {
        "title": default_title,
        "title_zh": default_title_zh,
        "thumbnail": "",
    }
    meta.update(SHOW_METADATA.get(show_id, {}))
    file_meta = _read_show_meta_file(show_id)
    for key in ("title", "title_zh", "thumbnail"):
        value = file_meta.get(key)
        if isinstance(value, str) and value.strip():
            meta[key] = value.strip()
    return meta


@router.get("/api/shows")
def list_shows():
    """List available local shows with subtitles."""
    shows = []
    if os.path.exists(SUBTITLES_DIR):
        for show_dir in sorted(os.listdir(SUBTITLES_DIR)):
            show_path = os.path.join(SUBTITLES_DIR, show_dir)
            if os.path.isdir(show_path):
                meta = _resolve_show_meta(
                    show_dir,
                    show_dir.replace("-", " ").title(),
                    show_dir,
                )

                # Count actual available seasons and episodes
                seasons_available = {}
                for season_dir in sorted(os.listdir(show_path)):
                    season_path = os.path.join(show_path, season_dir)
                    if os.path.isdir(season_path) and season_dir.startswith("S"):
                        season_num = int(season_dir[1:])
                        episodes = [f for f in os.listdir(season_path) if f.endswith('.srt')]
                        if episodes:
                            seasons_available[season_num] = len(episodes)

                if seasons_available:
                    shows.append({
                        "id": show_dir,
                        "title": meta["title"],
                        "title_zh": meta["title_zh"],
                        "thumbnail": meta["thumbnail"],
                        "seasons_available": seasons_available,
                        "total_episodes": sum(seasons_available.values())
                    })

    return {"shows": shows}


@router.get("/api/shows/{show_id}/seasons")
def list_seasons(show_id: str):
    """List available seasons for a show."""
    show_path = os.path.join(SUBTITLES_DIR, show_id)
    if not os.path.exists(show_path):
        raise HTTPException(status_code=404, detail="Show not found")

    meta = _resolve_show_meta(show_id, show_id, "")
    seasons = []

    for season_dir in sorted(os.listdir(show_path)):
        season_path = os.path.join(show_path, season_dir)
        if os.path.isdir(season_path) and season_dir.startswith("S"):
            season_num = int(season_dir[1:])
            episodes = sorted([f for f in os.listdir(season_path) if f.endswith('.srt')])
            seasons.append({
                "season": season_num,
                "episode_count": len(episodes),
                "episodes": [int(e.replace("E", "").replace(".srt", "")) for e in episodes]
            })

    return {
        "show_id": show_id,
        "title": meta.get("title", show_id),
        "title_zh": meta.get("title_zh", ""),
        "seasons": seasons
    }


class SubtitleRequest(BaseModel):
    show_id: str
    season: int
    episode: int
    model: str | None = None


@router.post("/api/process-subtitle")
async def process_subtitle(request: SubtitleRequest):
    """Process a local SRT subtitle file through the selected model's translation."""
    # 模型名经 resolve_model 校验；不存在时回落到默认模型。没配 Key 的模型
    # 会在调用层失败，走原有的批次降级逻辑，不会让接口直接 500/502。
    model = resolve_model(request.model)
    srt_path = os.path.join(
        SUBTITLES_DIR, request.show_id,
        f"S{request.season:02d}", f"E{request.episode:02d}.srt"
    )

    if not os.path.exists(srt_path):
        raise HTTPException(status_code=404, detail="Subtitle file not found")

    # Check if already processed (cached in history)
    cache_filename = f"{request.show_id}_S{request.season:02d}E{request.episode:02d}.json"
    cache_path = os.path.join(storage.history_dir(), cache_filename)

    if os.path.exists(cache_path):
        print(f"Loading cached subtitles: {cache_filename}")
        with open(cache_path, "r", encoding="utf-8") as f:
            cached_data = json.load(f)
        # 缓存里记录的 `model` 是「生成这批翻译时实际使用的模型」，命中时
        # 原样返回，供历史列表显示，不因这次请求换了模型而覆盖。
        # 旧缓存（本字段出现之前生成）没有记录：不臆测当时用的模型；只有
        # 这次确实用 `model` 补译过失败块，才记上本次模型（与 YouTube
        # 缓存自愈的语义一致，见 routes_videos.process_video）。
        repaired = any(
            needs_retranslation(b.get("zh_text", "")) for b in cached_data.get("transcript", [])
        )
        if repaired and not cached_data.get("model"):
            cached_data["model"] = model
        cached_data = await retranslate_marked_blocks(
            cached_data, cache_path, model=model, feature="local_show"
        )
        # 缓存里可能没有 YouTube 映射（老缓存，或 episodes.json 后来才补上）：
        # 每次命中都从映射现取，只改返回的 payload，不重写缓存文件。
        local_shows.enrich_metadata(
            cached_data.get("metadata"),
            request.show_id,
            request.season,
            request.episode,
        )
        return cached_data

    # Parse SRT file
    with open(srt_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()

    raw_blocks = parse_srt(content)
    blocks = group_srt_blocks(raw_blocks)

    # Assign IDs
    for idx, b in enumerate(blocks):
        b["id"] = idx + 1

    # Get show metadata（meta.json > SHOW_METADATA > 自动标题）
    meta = _resolve_show_meta(request.show_id, request.show_id, "")
    show_title = meta.get("title", request.show_id)
    show_title_zh = meta.get("title_zh", "")

    metadata = {
        "title": f"{show_title} S{request.season:02d}E{request.episode:02d}",
        "channel": show_title_zh or show_title,
        "upload_date": "",
        "thumbnail": meta.get("thumbnail", ""),
        "is_local_subtitle": True
    }
    # 有 episodes.json 映射的剧集带上真实 YouTube 视频 id，前端可复用视频播放器；
    # 没有映射时 payload 形状与改动前完全一致。
    local_shows.enrich_metadata(
        metadata, request.show_id, request.season, request.episode
    )

    # Process through Gemini translation (same batching as YouTube)
    processed_blocks = []
    batch_size = 20
    has_mock_fallback = False  # Track if any batch used mock

    print(f"Processing {len(blocks)} subtitle blocks for {show_title} S{request.season:02d}E{request.episode:02d}...")

    for i in range(0, len(blocks), batch_size):
        batch = blocks[i:i + batch_size]
        print(f"Processing batch {i//batch_size + 1}/{(len(blocks)-1)//batch_size + 1}")

        max_retries = 5
        retry_delay = 15
        success = False

        for attempt in range(max_retries):
            try:
                # 本地剧集翻译单独归到 local_show：账本要能回答「花在哪个功能」。
                batch_result = await process_llm_batch(
                    batch, model=model, feature="local_show"
                )
                processed_blocks.extend(batch_result)
                # 批间停顿按 provider 的限流节奏走（Gemini 4s / DeepSeek 1s），
                # 不再固定 6 秒把 DeepSeek 也拖慢。
                await asyncio.sleep(llm.batch_pause(model))
                success = True
                break
            except Exception as e:
                error_msg = str(e).lower()
                if "429" in error_msg or "quota" in error_msg or "exhausted" in error_msg:
                    if attempt < max_retries - 1:
                        print(f"Rate limit hit. Retrying in {retry_delay}s... (Attempt {attempt + 1}/{max_retries})")
                        await asyncio.sleep(retry_delay)
                        retry_delay *= 2
                    else:
                        print(f"Rate limit hit persistently. Falling back to mock.")
                else:
                    print(f"Batch failed: {e}")
                    break

        if not success:
            has_mock_fallback = True
            mock_result = await mock_llm_processing(batch)
            processed_blocks.extend(mock_result)

    result_payload = {
        "videoId": f"{request.show_id}-S{request.season:02d}E{request.episode:02d}",
        "metadata": metadata,
        "transcript": processed_blocks,
        # 本地剧集的 summary 是固定集名标签，不是模型生成的总结；
        # 模型只作用于翻译与缓存自愈补译。
        "summary": f"📺 {show_title_zh} 第{request.season}季 第{request.episode}集",
        # 记录这批翻译实际使用的模型（resolve 后的 id），历史列表据此显示；
        # 随 payload 一起落盘，缓存命中时原样返回。
        "model": model,
    }

    # Only cache if all batches succeeded (no mock fallback)
    if not has_mock_fallback:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(result_payload, f, ensure_ascii=False, indent=2)
        print(f"Cached result: {cache_filename}")
    else:
        print(f"⚠️ Result contains mock translations, NOT caching. Retry later for full translation.")

    return result_payload


# --- Processed episodes lookup ---
@router.get("/api/shows/{show_id}/processed")
def get_processed_episodes(show_id: str):
    """Return a list of processed episode keys like ['S02E01', 'S04E03'] for a show."""
    prefix = f"{show_id}_S"
    processed = []
    history_root = storage.history_dir()
    for filename in os.listdir(history_root):
        if filename.startswith(prefix) and filename.endswith(".json"):
            # e.g. "house-of-cards_S02E01.json" -> "S02E01"
            key = filename[len(show_id) + 1:].replace(".json", "")
            processed.append(key)
    return {"processed": processed}


# ====================================================
# Sentence Packs（句子精背）— 静态精选句子，按级提供
# 详见 specs/009-sentence-packs/
# ====================================================

@router.get("/api/sentences/levels")
def list_sentence_levels():
    """各级索引：[{ id, title, subtitle, count, days }]"""
    index_path = os.path.join(SENTENCES_DIR, "index.json")
    if not os.path.exists(index_path):
        return []
    with open(index_path, "r", encoding="utf-8") as f:
        return json.load(f)


@router.get("/api/sentences/level/{level_id}")
def get_sentence_level(level_id: int):
    """某一级的全部句子。"""
    path = os.path.join(SENTENCES_DIR, f"level-{int(level_id)}.json")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="该级句子不存在。")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)
