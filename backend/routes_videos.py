"""视频路由：估价、处理（经典/流式）、历史记录、频道更新。

流式端点是产品核心（详见 specs/001-streaming-pipeline/）：
英文字幕先到先给，翻译逐批推送并落盘，中断自愈。
"""
import asyncio
import datetime
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from config import DEFAULT_MODEL, HISTORY_DIR, MODEL_CATALOG, resolve_model
import llm
import local_shows
from transcripts import (
    extract_video_id,
    fetch_english_transcript,
    get_video_metadata,
    group_transcript_blocks,
    _asr_available,
    _transcribe_audio_with_whisper,
)
from translate import (
    UNTRANSLATED_MARKER,
    _stream_translate,
    find_history_file_for_video,
    mock_llm_processing,
    needs_retranslation,
    process_llm_batch,
    retranslate_marked_blocks,
    summarize_video_transcript,
    summary_needs_refresh,
)

router = APIRouter()


class VideoRequest(BaseModel):
    url: str
    model: str | None = None
    vocab_level: str | None = None


def _model_option(model_id: str) -> dict:
    """全局模型栏的一项：目录里的基础信息 + 当前 Key 是否可用。

    没配 Key 时把 quotaInfo 换成"需要配置哪个环境变量"，前端置灰的同时
    能直接告诉用户缺什么，不必再猜。
    """
    spec = MODEL_CATALOG[model_id]
    available = llm.is_available(model_id)
    return {
        "id": model_id,
        "name": spec["name"],
        "provider": spec["provider"],
        "available": available,
        "quotaInfo": spec["quotaInfo"] if available else f"需要配置 {spec.get('api_key_env', 'API Key')}",
    }


@router.get("/api/models")
def list_models():
    """全局模型选择器的数据源：所有目录模型 + 默认模型，与具体视频无关。"""
    return {
        "models": [_model_option(model_id) for model_id in MODEL_CATALOG],
        "default": DEFAULT_MODEL,
    }


# Metadata + transcript fetched during cost estimation, reused on confirm
# so the user doesn't wait for yt-dlp twice.
_prefetch_cache: dict = {}  # video_id -> (fetched_at, metadata, transcript)
PREFETCH_CACHE_TTL_SECONDS = 600


@router.get("/api/estimate-cost")
def estimate_cost(url: str):
    try:
        video_id = extract_video_id(url)
    except ValueError:
        raise HTTPException(status_code=400, detail="无效的 YouTube 链接，请检查后重试。")

    try:
        metadata = get_video_metadata(url)
    except Exception as e:
        print(f"Failed to fetch metadata for estimate: {e}")
        metadata = {"title": "Unknown Title", "channel": "Unknown Channel", "thumbnail": ""}

    # Fetch English transcript to calculate length
    transcript = fetch_english_transcript(video_id)

    # Reuse this fetch when the user confirms processing right after
    _prefetch_cache[video_id] = (time.time(), metadata, transcript)

    # Calculate rough token estimate. (English word ~ 1.3 tokens).
    # We also have the system prompt and Chinese output.
    full_text = " ".join([t.text for t in transcript])
    word_count = len(full_text.split())

    # Rough estimates:
    input_tokens = int(word_count * 1.5)  # input text + prompt overhead
    output_tokens = int(word_count * 2.0)  # chinese translation + JSON overhead

    def calc_cost(model_id):
        rates = MODEL_CATALOG[model_id]
        # 价格未知（None）时不估算：前端显示"待定"，绝不假装知道单价。
        if rates.get("in") is None or rates.get("out") is None:
            return None
        in_cost = (input_tokens / 1_000_000) * rates["in"]
        out_cost = (output_tokens / 1_000_000) * rates["out"]
        return round(in_cost + out_cost, 6)

    def model_entry(model_id):
        entry = _model_option(model_id)
        entry["estimatedCost"] = calc_cost(model_id)
        return entry

    models = [model_entry(model_id) for model_id in MODEL_CATALOG]

    return {
        "videoId": video_id,
        "metadata": metadata,
        "transcriptStats": {
            "wordCount": word_count,
            "estimatedInputTokens": input_tokens,
            "estimatedOutputTokens": output_tokens
        },
        "models": models
    }


@router.post("/api/process-video")
async def process_video(request: VideoRequest):
    try:
        video_id = extract_video_id(request.url)
    except ValueError:
        raise HTTPException(status_code=400, detail="无效的 YouTube 链接，请检查后重试。")

    model = resolve_model(request.model)

    # Already processed? Serve the cached result (repairing any failed
    # translations) instead of re-fetching and re-paying for the whole video.
    cached_path = find_history_file_for_video(video_id)
    if cached_path:
        print(f"Serving cached result for {video_id}: {os.path.basename(cached_path)}")
        try:
            with open(cached_path, "r", encoding="utf-8") as f:
                cached_data = json.load(f)
            repaired = any(needs_retranslation(b.get("zh_text", "")) for b in cached_data.get("transcript", []))
            cached_data = await retranslate_marked_blocks(cached_data, cached_path, model=model)
            refreshed = summary_needs_refresh(cached_data.get("summary", ""))
            if refreshed:
                cached_data["summary"] = await summarize_video_transcript(
                    [{"text": b["en_text"]} for b in cached_data.get("transcript", [])], model=model
                )
            # 只有真正用这次选的模型重跑过，才更新缓存里的模型标记。
            if not cached_data.get("model") and (repaired or refreshed):
                cached_data["model"] = model
            _bump_study(cached_data, cached_path)
            return cached_data
        except (json.JSONDecodeError, KeyError) as e:
            print(f"Cache file corrupt, reprocessing: {e}")

    try:
        metadata = get_video_metadata(request.url)
    except Exception as e:
        print(f"Failed to fetch metadata: {e}")
        metadata = {
            "title": "Unknown Title",
            "channel": "Unknown Channel",
            "upload_date": datetime.datetime.now().strftime("%Y%m%d"),
            "thumbnail": ""
        }

    # Fetch English transcript
    transcript = fetch_english_transcript(video_id)

    # Group transcript snippets into sentences/blocks
    blocks = group_transcript_blocks(transcript)

    # Assign global unique IDs
    for idx, b in enumerate(blocks):
        b["id"] = idx + 1

    # Process blocks in batches of 20 to stay within limits and ensure quality JSON
    processed_blocks = []
    batch_size = 20

    print(f"Processing {len(blocks)} blocks in batches of {batch_size}...")

    # Limit removed to allow processing of full-length videos
    blocks_to_process = blocks

    for i in range(0, len(blocks_to_process), batch_size):
        batch = blocks_to_process[i:i + batch_size]
        print(f"Processing batch {i//batch_size + 1}/{(len(blocks_to_process)-1)//batch_size + 1}")

        max_retries = 3
        retry_delay = 10  # Start with 10s delay if rate limited
        success = False

        for attempt in range(max_retries):
            try:
                batch_result = await process_llm_batch(batch, model=model)
                processed_blocks.extend(batch_result)
                await asyncio.sleep(llm.batch_pause(model))  # 按 provider 限流节奏
                success = True
                break  # Break out of retry loop
            except Exception as e:
                error_msg = str(e).lower()
                if "429" in error_msg or "quota" in error_msg or "exhausted" in error_msg:
                    if attempt < max_retries - 1:
                        print(f"Rate limit hit (429). Retrying in {retry_delay}s... (Attempt {attempt + 1}/{max_retries})")
                        await asyncio.sleep(retry_delay)
                        retry_delay *= 2  # Exponential backoff: 10s, 20s, etc.
                    else:
                        print(f"Rate limit hit persistently. Falling back to mock for this batch. Error: {e}")
                else:
                    print(f"Batch {i//batch_size + 1} failed with non-retryable error: {e}")
                    break  # Don't retry for other types of errors (e.g. malformed JSON)

        if not success:
            mock_result = await mock_llm_processing(batch)
            processed_blocks.extend(mock_result)

    # Generate summary based on original English blocks
    print("Generating video summary...")
    summary_text = await summarize_video_transcript(blocks, model=model)

    # Save to history
    safe_channel = "".join([c for c in metadata["channel"] if c.isalpha() or c.isdigit() or c == ' ']).rstrip()
    if not safe_channel:
        safe_channel = "Unknown"
    date_str = metadata["upload_date"]
    filename = f"{safe_channel}_{date_str}_{video_id}.json".replace(" ", "_")

    result_payload = {
        "videoId": video_id,
        "metadata": metadata,
        "transcript": processed_blocks,
        "summary": summary_text,
        "model": model,
        "studyCount": 1,
    }

    file_path = os.path.join(HISTORY_DIR, filename)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(result_payload, f, ensure_ascii=False, indent=2)

    return result_payload


# ====================================================
# Streaming processing (SSE) — English subtitles appear immediately,
# translations fill in batch by batch, partial progress is persisted so
# a cancelled run resumes (self-heals) on the next load.
# ====================================================

def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _history_filename(metadata: dict, video_id: str) -> str:
    safe_channel = "".join([c for c in metadata.get("channel", "") if c.isalpha() or c.isdigit() or c == ' ']).rstrip()
    if not safe_channel:
        safe_channel = "Unknown"
    return f"{safe_channel}_{metadata.get('upload_date', '')}_{video_id}.json".replace(" ", "_")


# History files that are not videos — never list or delete them through /api/history.
HISTORY_META_FILES = {"favorites.json", "subscriptions.json", "dictionary_cache.json"}

# 本地剧集缓存文件名：<show_id>_S01E01.json（见 routes_content.process_subtitle）。
# show_id 本身可能带下划线，所以用贪婪匹配 `.+`，从右边锁住季/集。
_LOCAL_EPISODE_FILENAME_RE = re.compile(
    r"^(?P<show_id>.+)_S(?P<season>\d{2})E(?P<episode>\d{2})\.json$"
)


def _local_episode_from_filename(filename: str) -> tuple[str, int, int] | None:
    """从本地剧集缓存文件名解析 (show_id, season, episode)；不是该格式返回 None。"""
    match = _LOCAL_EPISODE_FILENAME_RE.match(filename)
    if not match:
        return None
    return (
        match.group("show_id"),
        int(match.group("season")),
        int(match.group("episode")),
    )


def _model_display_name(model_id: str | None) -> str:
    """模型 id → 展示名；老缓存没有记录就如实说 Not recorded。"""
    if not model_id:
        return "Not recorded"
    spec = MODEL_CATALOG.get(model_id)
    return spec["name"] if spec else model_id


def _bump_study(data: dict, path: str) -> None:
    """打开一次缓存视频 = 一次学习，计数并落盘。"""
    data["studyCount"] = int(data.get("studyCount") or 0) + 1
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


@router.post("/api/process-video-stream")
async def process_video_stream(request: VideoRequest):
    async def gen():
        try:
            try:
                video_id = extract_video_id(request.url)
            except ValueError:
                yield _sse("error", {"detail": "无效的 YouTube 链接，请检查后重试。"})
                return

            # 先解析模型：缓存路径的自愈（补译/重生成总结）也要用用户选中的模型，
            # 否则换成 DeepSeek 后仍会拿默认 Gemini 去重试。
            model = resolve_model(request.model)

            # --- Cached video: send everything we have, then repair gaps ---
            cached_path = find_history_file_for_video(video_id)
            cached = None
            if cached_path:
                try:
                    with open(cached_path, "r", encoding="utf-8") as f:
                        cached = json.load(f)
                except json.JSONDecodeError:
                    cached = None

            if cached and cached.get("transcript"):
                transcript = cached["transcript"]
                yield _sse("meta", {
                    "videoId": cached.get("videoId", video_id),
                    "metadata": cached.get("metadata", {}),
                    "blocks": transcript,
                    "cached": True,
                })
                pending = [i for i, b in enumerate(transcript) if needs_retranslation(b.get("zh_text", ""))]
                if pending:
                    async for update in _stream_translate(transcript, pending, cached, cached_path, model=model):
                        yield _sse("batch", update)

                # 上次失败留下的"无法生成总结"占位不能就这么回给用户：用这次选的模型重试一次。
                summary = cached.get("summary", "")
                refreshed = summary_needs_refresh(summary)
                if refreshed:
                    yield _sse("stage", {"stage": "summary"})
                    summary = await summarize_video_transcript(
                        [{"text": b["en_text"]} for b in transcript], model=model
                    )
                    if not summary_needs_refresh(summary):
                        cached["summary"] = summary

                # 只有真正重跑过翻译/总结，才把缓存的模型标记更新成这次用的模型。
                if not cached.get("model") and (pending or refreshed):
                    cached["model"] = model
                cached["studyCount"] = int(cached.get("studyCount") or 0) + 1
                with open(cached_path, "w", encoding="utf-8") as f:
                    json.dump(cached, f, ensure_ascii=False, indent=2)

                yield _sse("summary", {"summary": summary})
                yield _sse("done", {"cached": True})
                return

            # --- Fresh video ---

            # Reuse the fetch from a just-run cost estimation when possible
            prefetched = _prefetch_cache.pop(video_id, None)
            if prefetched and time.time() - prefetched[0] < PREFETCH_CACHE_TTL_SECONDS:
                metadata, raw_transcript = prefetched[1], prefetched[2]
            else:
                try:
                    raw_transcript = fetch_english_transcript(video_id)
                except HTTPException as e:
                    # No captions? Fall back to local ASR when available.
                    if e.status_code == 422 and _asr_available():
                        yield _sse("stage", {"stage": "asr"})
                        try:
                            raw_transcript = await asyncio.to_thread(_transcribe_audio_with_whisper, request.url)
                        except Exception as asr_err:
                            yield _sse("error", {"detail": f"该视频无字幕，本地转写也失败了:{asr_err}"})
                            return
                        if not raw_transcript:
                            yield _sse("error", {"detail": "本地转写未识别出任何语音内容。"})
                            return
                    elif e.status_code == 422:
                        yield _sse("error", {
                            "detail": e.detail + " 提示：安装本地转写组件后可支持无字幕视频"
                                                "（backend 环境运行 pip install faster-whisper）。"
                        })
                        return
                    else:
                        yield _sse("error", {"detail": e.detail})
                        return

                try:
                    metadata = get_video_metadata(request.url)
                except Exception as e:
                    print(f"Failed to fetch metadata: {e}")
                    metadata = {
                        "title": "Unknown Title",
                        "channel": "Unknown Channel",
                        "upload_date": datetime.datetime.now().strftime("%Y%m%d"),
                        "thumbnail": ""
                    }
            if "upload_date" not in metadata or not metadata.get("upload_date"):
                metadata["upload_date"] = datetime.datetime.now().strftime("%Y%m%d")

            en_blocks = group_transcript_blocks(raw_transcript)
            transcript = []
            for idx, b in enumerate(en_blocks):
                transcript.append({
                    "id": idx + 1,
                    "start": b["start"],
                    "end": b["end"],
                    "en_text": b["text"].replace("\n", " ").strip(),
                    "zh_text": UNTRANSLATED_MARKER,
                    "highlights": [],
                })

            payload = {
                "videoId": video_id,
                "metadata": metadata,
                "transcript": transcript,
                "summary": "",
                "model": model,
                "studyCount": 1,
            }
            save_path = os.path.join(HISTORY_DIR, _history_filename(metadata, video_id))
            with open(save_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)

            # English is ready — let the user start watching now
            yield _sse("meta", {
                "videoId": video_id,
                "metadata": metadata,
                "blocks": transcript,
                "cached": False,
            })

            async for update in _stream_translate(transcript, list(range(len(transcript))), payload, save_path, model=model, vocab_level=request.vocab_level):
                yield _sse("batch", update)

            yield _sse("stage", {"stage": "summary"})
            summary_text = await summarize_video_transcript([{"text": b["en_text"]} for b in transcript], model=model)
            payload["summary"] = summary_text
            with open(save_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)

            yield _sse("summary", {"summary": summary_text})
            yield _sse("done", {"cached": False})

        except Exception as e:
            print(f"Stream processing error: {e}")
            yield _sse("error", {"detail": f"处理失败：{e}"})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/api/history")
def list_history():
    files = []
    if os.path.exists(HISTORY_DIR):
        for f in os.listdir(HISTORY_DIR):
            if f.endswith('.json') and f not in HISTORY_META_FILES:
                file_path = os.path.join(HISTORY_DIR, f)
                try:
                    with open(file_path, "r", encoding="utf-8") as file:
                        data = json.load(file)
                        mtime = os.path.getmtime(file_path)
                        files.append({
                            "filename": f,
                            "videoId": data.get("videoId"),
                            "metadata": data.get("metadata", {}),
                            "model": data.get("model"),
                            "modelName": _model_display_name(data.get("model")),
                            "studyCount": int(data.get("studyCount") or 0),
                            "mtime": mtime
                        })
                except Exception as e:
                    print(f"Error reading history file {f}: {e}")
                    files.append({"filename": f, "metadata": {}})

    # Sort files by the local processing time (mtime), descending
    files.sort(key=lambda x: x.get("mtime", 0), reverse=True)
    return files


@router.get("/api/history/{filename}")
async def get_history(filename: str, model: str | None = None):
    # Guard against path traversal — only bare filenames inside HISTORY_DIR
    if os.path.basename(filename) != filename:
        raise HTTPException(status_code=404, detail="History file not found")
    file_path = os.path.join(HISTORY_DIR, filename)
    if not os.path.exists(file_path) or not filename.endswith('.json'):
        raise HTTPException(status_code=404, detail="History file not found")

    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    # Self-heal mock/failed translations left over from rate-limited runs,
    # using the model the frontend sent with the request.
    if isinstance(data, dict) and data.get("transcript"):
        chosen_model = resolve_model(model)
        repaired = any(needs_retranslation(b.get("zh_text", "")) for b in data["transcript"])
        data = await retranslate_marked_blocks(data, file_path, model=chosen_model)
        refreshed = summary_needs_refresh(data.get("summary", ""))
        if refreshed:
            data["summary"] = await summarize_video_transcript(
                [{"text": b["en_text"]} for b in data["transcript"]], model=chosen_model
            )
        if not data.get("model") and (repaired or refreshed):
            data["model"] = chosen_model
        _bump_study(data, file_path)
    # 本地剧集缓存：从 episodes.json 现取 YouTube 映射补进返回的 metadata，
    # 与 process-subtitle 缓存命中的行为一致；不写回缓存文件，避免映射更新后
    # 缓存里留下旧 id。普通 YouTube 缓存（无 is_local_subtitle）完全不受影响。
    if isinstance(data, dict):
        metadata = data.get("metadata")
        if isinstance(metadata, dict) and metadata.get("is_local_subtitle") is True:
            episode = _local_episode_from_filename(filename)
            if episode:
                local_shows.enrich_metadata(metadata, *episode)
    return data


@router.delete("/api/history/{filename}")
async def delete_history(filename: str):
    # Guard against path traversal and against deleting non-video metadata files
    if os.path.basename(filename) != filename or not filename.endswith('.json'):
        raise HTTPException(status_code=404, detail="History file not found")
    if filename in HISTORY_META_FILES:
        raise HTTPException(status_code=400, detail="该文件不是视频缓存，不能删除。")
    file_path = os.path.join(HISTORY_DIR, filename)
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="History file not found")
    os.remove(file_path)
    return {"ok": True, "filename": filename}


class ChannelUpdatesRequest(BaseModel):
    channels: list[str]


# Channel feeds change slowly; cache per-channel results so revisiting the
# dashboard doesn't re-run yt-dlp for every subscription.
_channel_cache: dict = {}  # channel_url -> (fetched_at, updates)
CHANNEL_CACHE_TTL_SECONDS = 900


def _fetch_channel_videos(channel_url: str) -> list:
    """Fetch the latest videos for one channel (blocking, run in a thread)."""
    import yt_dlp

    cached = _channel_cache.get(channel_url)
    if cached and time.time() - cached[0] < CHANNEL_CACHE_TTL_SECONDS:
        return cached[1]

    updates = []
    ydl_opts = {
        'extract_flat': 'in_playlist',
        'playlistend': 5,  # Top 5 recent videos per channel
        'quiet': True,
    }
    try:
        target_url = channel_url.rstrip("/") + "/videos" if not channel_url.endswith("/videos") else channel_url
        # One YoutubeDL instance per call: instances are not thread-safe
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(target_url, download=False)

        channel_name = info.get('uploader', info.get('title', 'Unknown Channel'))
        for entry in info.get('entries') or []:
            if not entry:
                continue
            video_id = entry.get('id')
            title = entry.get('title')
            if video_id and title:
                updates.append({
                    "videoId": video_id,
                    "title": title,
                    "channel": channel_name,
                    "thumbnail": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
                })
        _channel_cache[channel_url] = (time.time(), updates)
    except Exception as e:
        print(f"Error fetching updates for {channel_url}: {e}")
    return updates


@router.post("/api/channel-updates")
def get_channel_updates(request: ChannelUpdatesRequest):
    channels = [c for c in request.channels if c]
    if not channels:
        return {"updates": []}
    # Fetch all subscribed channels concurrently instead of one-by-one
    with ThreadPoolExecutor(max_workers=min(8, len(channels))) as pool:
        results = pool.map(_fetch_channel_videos, channels)
    return {"updates": [u for channel_updates in results for u in channel_updates]}
