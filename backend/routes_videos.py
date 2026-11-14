"""视频路由：估价、处理（经典/流式）、历史记录、频道更新。

流式端点是产品核心（详见 specs/001-streaming-pipeline/）：
英文字幕先到先给，翻译逐批推送并落盘，中断自愈。
"""
import asyncio
import contextlib
import datetime
import json
import os
import re
import time
from collections import OrderedDict

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import AliasChoices, BaseModel, Field

from config import (
    MODEL_CATALOG,
    PREFETCH_CACHE_MAX_ENTRIES,
    PREFETCH_CACHE_TTL_SECONDS,
    SSE_HEARTBEAT_SECONDS,
)
import languages
import llm
import local_shows
import storage
from transcripts import (
    canonical_watch_url,
    extract_video_id,
    fetch_english_transcript,
    get_video_metadata,
    group_transcript_blocks,
    _asr_available,
    _transcribe_audio_with_whisper,
)
from translate import (
    PROMPT_VERSIONS,
    UNTRANSLATED_MARKER,
    _stream_translate,
    find_history_file_for_video,
    mock_llm_processing,
    needs_retranslation,
    payload_target_lang,
    process_llm_batch,
    retranslate_marked_blocks,
    stamp_payload_language,
    summarize_video_transcript,
    summary_needs_refresh,
)

router = APIRouter()


class VideoRequest(BaseModel):
    url: str
    model: str | None = None
    vocab_level: str | None = None
    # specs/012 §5.3：请求参数用 camelCase；同时接受 snake_case 以兼容脚本/旧客户端。
    target_lang: str | None = Field(
        default=None,
        validation_alias=AliasChoices("targetLang", "target_lang"),
    )


def _target_lang_or_400(raw: str | None) -> str:
    """请求参数 → canonical 语言；缺省 zh-CN，非法 400（不暴露文件系统路径）。"""
    try:
        return languages.resolve_target_lang(raw)
    except languages.UnsupportedLanguage as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
def list_models(targetLang: str | None = None):
    """全局模型选择器的数据源：所有目录模型 + 该目标语言的默认/推荐模型。

    省略 ``targetLang`` 时按 zh-CN（旧前端行为不变）；``recommended`` 是该语言
    路线中「Key/端点已配置」的模型 id 序列（规格 §5.5）。
    """
    lang = _target_lang_or_400(targetLang)
    return {
        "models": [_model_option(model_id) for model_id in MODEL_CATALOG],
        "default": llm.resolve_model_for_target(None, lang),
        "targetLang": lang,
        "recommended": llm.recommended_models_for_target(lang),
    }


# Metadata + transcript fetched during cost estimation, reused on confirm
# so the user doesn't wait for yt-dlp twice.
#
# 安全最小集（M1 ⑦）：估价一次就抓一份完整字幕，若不限容量，反复估价会把
# 内存撑爆。这里用 OrderedDict 做 LRU：容量上限 + TTL（默认 200 条 / 10 分钟，
# 环境变量见 config.PREFETCH_CACHE_MAX_ENTRIES / PREFETCH_CACHE_TTL_SECONDS）；
# 超容量淘汰最久未用，过期条目在读写时清理。0 = 关闭缓存。
_prefetch_cache: "OrderedDict[str, tuple[float, dict, list]]" = OrderedDict()


def _prefetch_prune(now: float | None = None) -> None:
    """清掉过期条目，并把容量压回上限（LRU：最久未用先淘汰）。"""
    moment = time.time() if now is None else now
    if PREFETCH_CACHE_MAX_ENTRIES <= 0 or PREFETCH_CACHE_TTL_SECONDS <= 0:
        _prefetch_cache.clear()
        return
    expired = [
        video_id
        for video_id, (fetched_at, _metadata, _transcript) in _prefetch_cache.items()
        if moment - fetched_at >= PREFETCH_CACHE_TTL_SECONDS
    ]
    for video_id in expired:
        _prefetch_cache.pop(video_id, None)
    while len(_prefetch_cache) > PREFETCH_CACHE_MAX_ENTRIES:
        _prefetch_cache.popitem(last=False)


def _prefetch_store(
    video_id: str,
    metadata: dict,
    transcript: list,
    *,
    now: float | None = None,
) -> None:
    """写入估价预取结果；重复 id 视为最新使用（移到队尾）。"""
    if PREFETCH_CACHE_MAX_ENTRIES <= 0 or PREFETCH_CACHE_TTL_SECONDS <= 0:
        _prefetch_cache.clear()
        return
    moment = time.time() if now is None else now
    _prefetch_cache[video_id] = (moment, metadata, transcript)
    _prefetch_cache.move_to_end(video_id)
    _prefetch_prune(moment)


def _prefetch_take(
    video_id: str, *, now: float | None = None
) -> tuple[float, dict, list] | None:
    """取出并消费预取结果（一次性）；过期视为未命中并顺便删除。"""
    entry = _prefetch_cache.pop(video_id, None)
    if entry is None:
        return None
    moment = time.time() if now is None else now
    if moment - entry[0] >= PREFETCH_CACHE_TTL_SECONDS:
        return None
    return entry


@router.get("/api/estimate-cost")
async def estimate_cost(url: str, targetLang: str | None = None):
    lang = _target_lang_or_400(targetLang)
    try:
        video_id = extract_video_id(url)
    except ValueError:
        raise HTTPException(status_code=400, detail="无效的 YouTube 链接，请检查后重试。")

    try:
        # yt-dlp 是同步阻塞调用，必须放到线程里，别卡住事件循环。只把**重建后**
        # 的规范 watch URL 交给 yt-dlp，用户原始 query（list= 等）不会带进去。
        metadata = await asyncio.to_thread(
            get_video_metadata, canonical_watch_url(video_id)
        )
    except Exception as e:
        print(f"Failed to fetch metadata for estimate: {e}")
        metadata = {"title": "Unknown Title", "channel": "Unknown Channel", "thumbnail": ""}

    # Fetch English transcript to calculate length
    transcript = await asyncio.to_thread(fetch_english_transcript, video_id)

    # Reuse this fetch when the user confirms processing right after
    _prefetch_store(video_id, metadata, transcript)

    # Calculate rough token estimate. (English word ~ 1.3 tokens).
    # We also have the system prompt and target-language output.
    full_text = " ".join([t.text for t in transcript])
    word_count = len(full_text.split())

    # Rough estimates:
    input_tokens = int(word_count * 1.5)  # input text + prompt overhead
    output_tokens = int(word_count * 2.0)  # target-language translation + JSON overhead

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
        "targetLang": lang,
        # 该目标语言路线中第一个可用的模型；价格未知时不估算（前端显示"待定"）。
        "recommendedModel": llm.resolve_model_for_target(None, lang),
        "transcriptStats": {
            "wordCount": word_count,
            "estimatedInputTokens": input_tokens,
            "estimatedOutputTokens": output_tokens
        },
        "models": models
    }


@router.post("/api/process-video")
async def process_video(request: VideoRequest):
    lang = _target_lang_or_400(request.target_lang)
    try:
        video_id = extract_video_id(request.url)
    except ValueError:
        raise HTTPException(status_code=400, detail="无效的 YouTube 链接，请检查后重试。")

    model = llm.resolve_model_for_target(request.model, lang)

    # Already processed? Serve the cached result for **this target language**
    # (repairing any failed translations) instead of re-fetching/re-paying.
    cached_path = find_history_file_for_video(video_id, target_lang=lang)
    if cached_path:
        print(f"Serving cached result for {video_id} [{lang}]: {os.path.basename(cached_path)}")
        try:
            with open(cached_path, "r", encoding="utf-8") as f:
                cached_data = json.load(f)
            if payload_target_lang(cached_data) != lang:
                # 语言不一致视为未命中（规格 §5.4）：不返回错误语言的译文。
                print(f"Cached payload language mismatch, reprocessing: {cached_path}")
            else:
                cached_data = stamp_payload_language(cached_data, lang)
                repaired = any(needs_retranslation(b.get("zh_text", "")) for b in cached_data.get("transcript", []))
                cached_data = await retranslate_marked_blocks(
                    cached_data, cached_path, model=model, target_lang=lang
                )
                refreshed = summary_needs_refresh(cached_data.get("summary", ""))
                if refreshed:
                    cached_data["summary"] = await summarize_video_transcript(
                        [{"text": b["en_text"]} for b in cached_data.get("transcript", [])],
                        model=model,
                        target_lang=lang,
                    )
                # 只有真正用这次选的模型重跑过，才更新缓存里的模型标记。
                if not cached_data.get("model") and (repaired or refreshed):
                    cached_data["model"] = model
                _bump_study(cached_data, cached_path)
                return cached_data
        except (json.JSONDecodeError, KeyError) as e:
            print(f"Cache file corrupt, reprocessing: {e}")

    try:
        metadata = await asyncio.to_thread(
            get_video_metadata, canonical_watch_url(video_id)
        )
    except Exception as e:
        print(f"Failed to fetch metadata: {e}")
        metadata = {
            "title": "Unknown Title",
            "channel": "Unknown Channel",
            "upload_date": datetime.datetime.now().strftime("%Y%m%d"),
            "thumbnail": ""
        }

    # Fetch English transcript
    transcript = await asyncio.to_thread(fetch_english_transcript, video_id)

    # Group transcript snippets into sentences/blocks
    blocks = group_transcript_blocks(transcript)

    # Assign global unique IDs
    for idx, b in enumerate(blocks):
        b["id"] = idx + 1

    # Process blocks in batches of 20 to stay within limits and ensure quality JSON
    processed_blocks = []
    batch_size = 20

    print(f"Processing {len(blocks)} blocks in batches of {batch_size} [{lang}]...")

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
                batch_result = await process_llm_batch(
                    batch, model=model, target_lang=lang
                )
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
            mock_result = await mock_llm_processing(batch, target_lang=lang)
            processed_blocks.extend(mock_result)

    # Generate summary based on original English blocks
    print("Generating video summary...")
    summary_text = await summarize_video_transcript(blocks, model=model, target_lang=lang)

    # Save to history (per target language directory)
    safe_channel = "".join([c for c in metadata["channel"] if c.isalpha() or c.isdigit() or c == ' ']).rstrip()
    if not safe_channel:
        safe_channel = "Unknown"
    date_str = metadata["upload_date"]
    filename = f"{safe_channel}_{date_str}_{video_id}.json".replace(" ", "_")

    result_payload = stamp_payload_language({
        "videoId": video_id,
        "metadata": metadata,
        "transcript": processed_blocks,
        "summary": summary_text,
        "model": model,
        "studyCount": 1,
    }, lang)

    file_path = os.path.join(storage.history_dir(lang), filename)
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


# SSE 注释行：浏览器 EventSource 与前端 consumeSseStream 都会忽略它（没有 data 行），
# 但反向代理会把它算作流量，从而避免 60–100s 空闲超时切断长任务流。
SSE_HEARTBEAT_COMMENT = ": ping\n\n"


async def _with_heartbeat(events, interval: float = SSE_HEARTBEAT_SECONDS):
    """转发事件流；超过 interval 秒没有事件时插入一行 SSE 心跳注释。

    生产者把原始生成器的事件按顺序写进队列，消费者逐条 yield——事件结构与
    顺序保持不变，只是空闲间隙多了 `: ping` 注释行。LLM 调用、字幕抓取都在
    线程里跑（P0‑1），事件循环因此有能力按时发心跳。
    """
    queue: asyncio.Queue = asyncio.Queue()

    async def pump():
        try:
            async for event in events:
                await queue.put(("event", event))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # 生成器自己已兜底；这里再兜一层，别让流挂死
            await queue.put(("error", exc))
        finally:
            await queue.put(("end", None))

    producer = asyncio.create_task(pump())
    try:
        while True:
            try:
                kind, payload = await asyncio.wait_for(queue.get(), timeout=interval)
            except asyncio.TimeoutError:
                yield SSE_HEARTBEAT_COMMENT
                continue
            if kind == "end":
                break
            if kind == "error":
                raise payload
            yield payload
    finally:
        # 客户端断开时，消费端会被取消；顺手停掉生产者，别让它在后台继续跑 LLM。
        producer.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await producer


@router.post("/api/process-video-stream")
async def process_video_stream(request: VideoRequest):
    # 语言/URL 校验放在流外：非法输入直接 400，而不是先 200 再在流里报错。
    lang = _target_lang_or_400(request.target_lang)
    try:
        video_id = extract_video_id(request.url)
    except ValueError:
        raise HTTPException(status_code=400, detail="无效的 YouTube 链接，请检查后重试。")

    def _event(name: str, data: dict) -> str:
        """所有 SSE 事件都带 targetLang（规格 §5.3 / §6.3）。"""
        return _sse(name, {**data, "targetLang": lang})

    async def gen():
        try:
            # 先解析模型：缓存路径的自愈（补译/重生成总结）也要用用户选中的模型，
            # 否则换成 DeepSeek 后仍会拿默认 Gemini 去重试。路线按目标语言选。
            model = llm.resolve_model_for_target(request.model, lang)

            # --- Cached video: send everything we have, then repair gaps ---
            cached_path = find_history_file_for_video(video_id, target_lang=lang)
            cached = None
            if cached_path:
                try:
                    with open(cached_path, "r", encoding="utf-8") as f:
                        cached = json.load(f)
                except json.JSONDecodeError:
                    cached = None
                if cached is not None and payload_target_lang(cached) != lang:
                    # 语言不一致视为未命中：不把错误语言的译文发给前端。
                    print(f"Cached payload language mismatch, reprocessing: {cached_path}")
                    cached = None

            if cached and cached.get("transcript"):
                cached = stamp_payload_language(cached, lang)
                transcript = cached["transcript"]
                yield _event("meta", {
                    "videoId": cached.get("videoId", video_id),
                    "metadata": cached.get("metadata", {}),
                    "blocks": transcript,
                    "cached": True,
                    "sourceLang": languages.SOURCE_LANG,
                    "promptVersion": PROMPT_VERSIONS["translate"],
                })
                pending = [i for i, b in enumerate(transcript) if needs_retranslation(b.get("zh_text", ""))]
                if pending:
                    async for update in _stream_translate(
                        transcript, pending, cached, cached_path,
                        model=model, target_lang=lang,
                    ):
                        yield _event("batch", update)

                # 上次失败留下的"无法生成总结"占位不能就这么回给用户：用这次选的模型重试一次。
                summary = cached.get("summary", "")
                refreshed = summary_needs_refresh(summary)
                if refreshed:
                    yield _event("stage", {"stage": "summary"})
                    summary = await summarize_video_transcript(
                        [{"text": b["en_text"]} for b in transcript],
                        model=model,
                        target_lang=lang,
                    )
                    if not summary_needs_refresh(summary):
                        cached["summary"] = summary

                # 只有真正重跑过翻译/总结，才把缓存的模型标记更新成这次用的模型。
                if not cached.get("model") and (pending or refreshed):
                    cached["model"] = model
                cached["studyCount"] = int(cached.get("studyCount") or 0) + 1
                with open(cached_path, "w", encoding="utf-8") as f:
                    json.dump(cached, f, ensure_ascii=False, indent=2)

                yield _event("summary", {"summary": summary})
                yield _event("done", {"cached": True})
                return

            # --- Fresh video ---

            # Reuse the fetch from a just-run cost estimation when possible
            prefetched = _prefetch_take(video_id)
            if prefetched is not None:
                metadata, raw_transcript = prefetched[1], prefetched[2]
            else:
                try:
                    raw_transcript = await asyncio.to_thread(fetch_english_transcript, video_id)
                except HTTPException as e:
                    # No captions? Fall back to local ASR when available.
                    if e.status_code == 422 and _asr_available():
                        yield _event("stage", {"stage": "asr"})
                        try:
                            raw_transcript = await asyncio.to_thread(
                                _transcribe_audio_with_whisper,
                                canonical_watch_url(video_id),
                            )
                        except Exception as asr_err:
                            yield _event("error", {"detail": f"该视频无字幕，本地转写也失败了:{asr_err}"})
                            return
                        if not raw_transcript:
                            yield _event("error", {"detail": "本地转写未识别出任何语音内容。"})
                            return
                    elif e.status_code == 422:
                        yield _event("error", {
                            "detail": e.detail + " 提示：安装本地转写组件后可支持无字幕视频"
                                                "（backend 环境运行 pip install faster-whisper）。"
                        })
                        return
                    else:
                        yield _event("error", {"detail": e.detail})
                        return

                try:
                    metadata = await asyncio.to_thread(
                        get_video_metadata, canonical_watch_url(video_id)
                    )
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

            payload = stamp_payload_language({
                "videoId": video_id,
                "metadata": metadata,
                "transcript": transcript,
                "summary": "",
                "model": model,
                "studyCount": 1,
            }, lang)
            save_path = os.path.join(
                storage.history_dir(lang), _history_filename(metadata, video_id)
            )
            with open(save_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)

            # English is ready — let the user start watching now
            yield _event("meta", {
                "videoId": video_id,
                "metadata": metadata,
                "blocks": transcript,
                "cached": False,
                "sourceLang": languages.SOURCE_LANG,
                "promptVersion": PROMPT_VERSIONS["translate"],
            })

            async for update in _stream_translate(
                transcript, list(range(len(transcript))), payload, save_path,
                model=model, vocab_level=request.vocab_level, target_lang=lang,
            ):
                yield _event("batch", update)

            yield _event("stage", {"stage": "summary"})
            summary_text = await summarize_video_transcript(
                [{"text": b["en_text"]} for b in transcript],
                model=model,
                target_lang=lang,
            )
            payload["summary"] = summary_text
            stamp_payload_language(payload, lang)
            with open(save_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)

            yield _event("summary", {"summary": summary_text})
            yield _event("done", {"cached": False})

        except Exception as e:
            print(f"Stream processing error: {e}")
            yield _event("error", {"detail": f"处理失败：{e}"})

    return StreamingResponse(
        _with_heartbeat(gen(), SSE_HEARTBEAT_SECONDS),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/api/history")
def list_history(targetLang: str | None = None):
    """只列**当前目标语言**目录里的视频/剧集缓存。

    ``zh-CN`` → ``history/`` 根目录；其他语言 → ``history/<code>/``。
    省略参数按 zh-CN（旧前端/旧移动端行为不变）。根目录里的元数据文件
    （收藏/订阅/词典缓存）永远不当历史卡片；遍历时跳过目录（vi-VN 是目录）。
    """
    lang = _target_lang_or_400(targetLang)
    files = []
    history_root = storage.history_dir(lang)
    if os.path.exists(history_root):
        for f in os.listdir(history_root):
            if not f.endswith('.json') or f in HISTORY_META_FILES:
                continue
            file_path = os.path.join(history_root, f)
            if not os.path.isfile(file_path):
                continue  # 语言子目录（vi-VN/ 等）不参与列表
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
                        "mtime": mtime,
                        "targetLang": lang,
                    })
            except Exception as e:
                print(f"Error reading history file {f}: {e}")
                files.append({"filename": f, "metadata": {}, "targetLang": lang})

    # Sort files by the local processing time (mtime), descending
    files.sort(key=lambda x: x.get("mtime", 0), reverse=True)
    return files


@router.get("/api/history/{filename}")
async def get_history(
    filename: str,
    model: str | None = None,
    targetLang: str | None = None,
):
    """在**当前目标语言**目录里解析裸文件名；语言不一致视为未命中。"""
    lang = _target_lang_or_400(targetLang)
    # Guard against path traversal — only bare filenames inside the language dir
    if os.path.basename(filename) != filename:
        raise HTTPException(status_code=404, detail="History file not found")
    file_path = os.path.join(storage.history_dir(lang), filename)
    if not os.path.exists(file_path) or not filename.endswith('.json'):
        raise HTTPException(status_code=404, detail="History file not found")

    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict) and payload_target_lang(data) != lang:
        # 规格 §5.4：读取时校验 payload 的 target_lang；不一致视为缓存未命中。
        raise HTTPException(status_code=404, detail="History file not found")
    # Self-heal mock/failed translations left over from rate-limited runs,
    # using the model the frontend sent with the request and this language.
    if isinstance(data, dict) and data.get("transcript"):
        data = stamp_payload_language(data, lang)
        chosen_model = llm.resolve_model_for_target(model, lang)
        repaired = any(needs_retranslation(b.get("zh_text", "")) for b in data["transcript"])
        data = await retranslate_marked_blocks(
            data, file_path, model=chosen_model, target_lang=lang
        )
        refreshed = summary_needs_refresh(data.get("summary", ""))
        if refreshed:
            data["summary"] = await summarize_video_transcript(
                [{"text": b["en_text"]} for b in data["transcript"]],
                model=chosen_model,
                target_lang=lang,
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
async def delete_history(filename: str, targetLang: str | None = None):
    """只删**当前目标语言**的一份缓存；同一视频的另一语言缓存保留。"""
    lang = _target_lang_or_400(targetLang)
    # Guard against path traversal and against deleting non-video metadata files
    if os.path.basename(filename) != filename or not filename.endswith('.json'):
        raise HTTPException(status_code=404, detail="History file not found")
    if filename in HISTORY_META_FILES:
        raise HTTPException(status_code=400, detail="该文件不是视频缓存，不能删除。")
    file_path = os.path.join(storage.history_dir(lang), filename)
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="History file not found")
    os.remove(file_path)
    return {"ok": True, "filename": filename, "targetLang": lang}


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
async def get_channel_updates(request: ChannelUpdatesRequest):
    channels = [c for c in request.channels if c]
    if not channels:
        return {"updates": []}
    # 频道列表走 yt-dlp（同步阻塞），放到线程里并发拉取；保留原先最多 8 个并发的上限。
    semaphore = asyncio.Semaphore(8)

    async def fetch_one(channel_url: str) -> list:
        async with semaphore:
            return await asyncio.to_thread(_fetch_channel_videos, channel_url)

    results = await asyncio.gather(*(fetch_one(c) for c in channels))
    return {"updates": [u for channel_updates in results for u in channel_updates]}
