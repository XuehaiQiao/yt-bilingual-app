"""P1-18 视频翻译批次并行 + 计时日志的离线验收。

覆盖：

1. 并发数配置：默认 2，``VIDEO_TRANSLATION_CONCURRENCY`` 可调、夹在 1–3；
2. mock 延迟下 wall time 证明批次确实并行（并发 2 明显快于并发 1），且 block
   顺序不变、每个批次只调用一次（不重复调用）；
3. provider 限流：``llm.batch_pause`` 仍在批次之间生效；
4. 失败批次回退 mock 语义不变（非限流错误不重试、只该批回退）；
5. 计费/配额硬闸仍直接抛出，且不会落到 mock、不会重复调用；
6. ``/api/process-video`` 端点走并行路径，并打出 ``feature=video_translation``
   / ``feature=video_analysis`` 计时日志；
7. SSE 流式路径保持原样：batch 事件顺序/进度/逐批落盘（断点恢复）不变。

全部离线：字幕/元数据/LLM 均 monkeypatch，目录在 tmp_path。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time

import pytest

import billing
import llm
import routes_videos
import teaching_analysis
import translate

URL = "https://www.youtube.com/watch?v=vitest12345"
VIDEO_ID = "vitest12345"
METADATA = {
    "title": "Pipeline Test Video",
    "channel": "Test Channel",
    "upload_date": "20240101",
    "thumbnail": "",
}


def _blocks(count: int) -> list[dict]:
    """模拟 group_transcript_blocks 的产物：id 由端点补，这里先不带 id。"""
    return [
        {
            "id": index,
            "start": float(index),
            "end": float(index) + 1.0,
            "text": f"Sentence number {index}.",
        }
        for index in range(1, count + 1)
    ]


def _translated(blocks: list[dict], *, prefix: str = "译文") -> list[dict]:
    return [
        {
            "id": block["id"],
            "start": block["start"],
            "end": block["end"],
            "en_text": block["text"],
            "zh_text": f"{prefix}{block['id']}",
            "highlights": [],
        }
        for block in blocks
    ]


def _install_batch_fake(
    monkeypatch,
    *,
    calls: list[list[int]],
    state: dict | None = None,
    sleep: float = 0.0,
    fail_when_first_id: int | None = None,
    billing_when_first_id: int | None = None,
):
    """替换 routes_videos.process_llm_batch：记录批次、可加延迟/失败/硬闸。"""
    state = state if state is not None else {}

    async def fake(blocks, model=None, user_id=None, target_lang=None):
        index = len(calls)
        calls.append([block["id"] for block in blocks])
        state["inflight"] = state.get("inflight", 0) + 1
        state["peak"] = max(state.get("peak", 0), state["inflight"])
        try:
            if sleep:
                await asyncio.sleep(sleep)
            first_id = blocks[0]["id"]
            if billing_when_first_id is not None and first_id == billing_when_first_id:
                raise billing.LoginRequired("测试硬闸")
            if fail_when_first_id is not None and first_id == fail_when_first_id:
                raise RuntimeError("malformed JSON from provider")
            return _translated(blocks)
        finally:
            state["inflight"] -= 1

    monkeypatch.setattr(routes_videos, "process_llm_batch", fake)
    return fake


# ---------------------------------------------------------------------------
# 1. 并发配置
# ---------------------------------------------------------------------------

def test_translation_concurrency_default_and_clamp(monkeypatch):
    monkeypatch.delenv("VIDEO_TRANSLATION_CONCURRENCY", raising=False)
    assert routes_videos._video_translation_concurrency() == 2

    cases = {
        "1": 1,
        "2": 2,
        "3": 3,
        "0": 1,
        "9": 3,
        "-4": 1,
        "abc": 2,
        "  ": 2,
    }
    for raw, expected in cases.items():
        monkeypatch.setenv("VIDEO_TRANSLATION_CONCURRENCY", raw)
        assert routes_videos._video_translation_concurrency() == expected, raw


# ---------------------------------------------------------------------------
# 2. 并行 wall time + 顺序 + 不重复调用
# ---------------------------------------------------------------------------

def test_parallel_batches_speed_up_wall_time_and_keep_order(monkeypatch):
    blocks = _blocks(61)  # P2-33：3 批：10 / 40 / 11
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)

    calls: list[list[int]] = []
    state: dict = {}
    _install_batch_fake(monkeypatch, calls=calls, state=state, sleep=0.12)

    monkeypatch.setenv("VIDEO_TRANSLATION_CONCURRENCY", "2")
    started = time.perf_counter()
    parallel = asyncio.run(
        routes_videos._translate_video_blocks(
            [dict(block) for block in blocks],
            model="deepseek-chat",
            user_id="u-1",
            lang="zh-CN",
        )
    )
    parallel_elapsed = time.perf_counter() - started
    assert state["peak"] == 2, "并发 2 时同一时刻应有两个批次在途"

    # 顺序：输出 block id 严格按输入顺序，不是完成顺序。
    assert [block["id"] for block in parallel] == list(range(1, 62))
    # 每批只送一次（3 批），批次之间无重叠 id。
    flattened = [block_id for batch in calls for block_id in batch]
    assert len(calls) == 3
    assert [len(call) for call in calls] == [10, 40, 11]
    assert sorted(flattened) == list(range(1, 62))

    # 同参数下串行（并发 1）作基线：并行 wall time 应明显更短。
    calls.clear()
    state.clear()
    monkeypatch.setenv("VIDEO_TRANSLATION_CONCURRENCY", "1")
    started = time.perf_counter()
    serial = asyncio.run(
        routes_videos._translate_video_blocks(
            [dict(block) for block in blocks],
            model="deepseek-chat",
            user_id="u-1",
            lang="zh-CN",
        )
    )
    serial_elapsed = time.perf_counter() - started
    assert state["peak"] == 1

    assert [block["id"] for block in serial] == [block["id"] for block in parallel]
    assert parallel_elapsed < serial_elapsed * 0.8, (
        f"并发未生效：parallel={parallel_elapsed:.3f}s serial={serial_elapsed:.3f}s"
    )


# ---------------------------------------------------------------------------
# 3. provider 限流：batch_pause 仍在批次之间生效
# ---------------------------------------------------------------------------

def test_batch_pause_still_paces_parallel_batches(monkeypatch):
    blocks = _blocks(41)  # 2 批：10 / 31，并发 2
    monkeypatch.setenv("VIDEO_TRANSLATION_CONCURRENCY", "2")
    pause_calls: list = []

    def fake_batch_pause(model=None):
        pause_calls.append(model)
        return 0.12

    monkeypatch.setattr(llm, "batch_pause", fake_batch_pause)
    calls: list[list[int]] = []
    _install_batch_fake(monkeypatch, calls=calls, sleep=0.02)

    started = time.perf_counter()
    out = asyncio.run(
        routes_videos._translate_video_blocks(
            [dict(block) for block in blocks],
            model="deepseek-chat",
            user_id="u-1",
            lang="zh-CN",
        )
    )
    elapsed = time.perf_counter() - started

    assert [block["id"] for block in out] == list(range(1, 42))
    # 批 1 跑完后停一拍再领下一批；批 2 是最后一批，不再停。
    assert pause_calls == ["deepseek-chat"]
    assert elapsed >= 0.12, "batch_pause 的限流等待没有生效"


# ---------------------------------------------------------------------------
# 4. 失败批次回退 mock：语义不变、只回退该批、不重试非限流错误
# ---------------------------------------------------------------------------

def test_failed_batch_falls_back_to_mock_without_retry(monkeypatch):
    blocks = _blocks(41)  # 2 批：10 / 31；批 2 的首个 id 是 11
    monkeypatch.setenv("VIDEO_TRANSLATION_CONCURRENCY", "2")
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)
    calls: list[list[int]] = []
    _install_batch_fake(monkeypatch, calls=calls, fail_when_first_id=11)

    mock_calls: list[list[int]] = []

    async def fake_mock(batch, target_lang=None):
        mock_calls.append([block["id"] for block in batch])
        return _translated(batch, prefix="mock-")

    monkeypatch.setattr(routes_videos, "mock_llm_processing", fake_mock)

    out = asyncio.run(
        routes_videos._translate_video_blocks(
            [dict(block) for block in blocks],
            model="deepseek-chat",
            user_id="u-1",
            lang="zh-CN",
        )
    )

    assert [block["id"] for block in out] == list(range(1, 42))
    assert len(calls) == 2, "每个批次只调用一次（非 429 错误不重试）"
    assert mock_calls == [list(range(11, 42))], "只有失败的批次回退 mock"
    zh_by_id = {block["id"]: block["zh_text"] for block in out}
    assert zh_by_id[1] == "译文1"
    assert zh_by_id[10] == "译文10"
    assert zh_by_id[11] == "mock-11"
    assert zh_by_id[41] == "mock-41"


# ---------------------------------------------------------------------------
# 5. 计费/配额硬闸：直接抛出，不落 mock，不重复调用
# ---------------------------------------------------------------------------

def test_billing_hard_gate_aborts_without_mock(monkeypatch):
    blocks = _blocks(61)  # 3 批：10 / 40 / 11；批 2 的首个 id 是 11
    monkeypatch.setenv("VIDEO_TRANSLATION_CONCURRENCY", "2")
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)
    calls: list[list[int]] = []
    _install_batch_fake(monkeypatch, calls=calls, billing_when_first_id=11)

    mock_calls: list = []

    async def fake_mock(batch, target_lang=None):
        mock_calls.append(batch)
        return _translated(batch, prefix="mock-")

    monkeypatch.setattr(routes_videos, "mock_llm_processing", fake_mock)

    with pytest.raises(billing.LoginRequired):
        asyncio.run(
            routes_videos._translate_video_blocks(
                [dict(block) for block in blocks],
                model="deepseek-chat",
                user_id="u-1",
                lang="zh-CN",
            )
        )

    assert mock_calls == [], "计费硬闸不能被 mock 兜底吞掉"
    sent = [block_id for batch in calls for block_id in batch]
    assert len(sent) == len(set(sent)), "同一批次不能被重复送进模型"
    assert len(calls) <= 3


# ---------------------------------------------------------------------------
# 6. 端点集成 + 计时日志
# ---------------------------------------------------------------------------

def _install_endpoint_fakes(monkeypatch, blocks: list[dict], calls: list[list[int]]):
    """process-video 端点：字幕/元数据/切句/总结/教学分析全部打桩。"""
    monkeypatch.setattr(
        routes_videos, "fetch_english_transcript", lambda _video_id: list(blocks)
    )
    monkeypatch.setattr(routes_videos, "get_video_metadata", lambda _url: dict(METADATA))
    monkeypatch.setattr(
        routes_videos,
        "group_transcript_blocks",
        lambda _raw: [dict(block) for block in blocks],
    )

    async def fake_batch(blocks, model=None, user_id=None, target_lang=None):
        calls.append([block["id"] for block in blocks])
        await asyncio.sleep(0.02)
        return _translated(blocks)

    async def fake_summary(_blocks, model=None, **_kwargs):
        return "测试总结"

    async def fake_analysis(payload, **kwargs):
        return None

    monkeypatch.setattr(routes_videos, "process_llm_batch", fake_batch)
    monkeypatch.setattr(routes_videos, "summarize_video_transcript", fake_summary)
    monkeypatch.setattr(teaching_analysis, "attach_to_payload", fake_analysis)
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)


def _timing_records(caplog) -> list[dict]:
    records: list[dict] = []
    for record in caplog.records:
        if record.name != "linguatrek.routes_videos":
            continue
        if not record.getMessage().startswith("{"):
            continue
        records.append(json.loads(record.getMessage()))
    return records


def test_process_video_runs_batches_parallel_and_logs_timing(
    client, monkeypatch, caplog
):
    blocks = _blocks(41)  # P2-33：2 批：10 / 31
    calls: list[list[int]] = []
    _install_endpoint_fakes(monkeypatch, blocks, calls)
    monkeypatch.setenv("VIDEO_TRANSLATION_CONCURRENCY", "2")
    caplog.set_level(logging.INFO, logger="linguatrek.routes_videos")

    response = client.post("/api/process-video", json={"url": URL})
    assert response.status_code == 200, response.text
    payload = response.json()

    assert [block["id"] for block in payload["transcript"]] == list(range(1, 42))
    assert len(calls) == 2
    assert payload["summary"] == "测试总结"

    timing = _timing_records(caplog)
    totals = [
        item
        for item in timing
        if item["feature"] == "video_translation" and item.get("event") == "total"
    ]
    assert len(totals) == 1
    total = totals[0]
    assert total["batch_count"] == 2
    assert total["concurrency"] == 2
    assert len(total["batch_durations_ms"]) == 2
    assert total["total_ms"] > 0
    assert total["ok"] is True

    batch_lines = [
        item
        for item in timing
        if item["feature"] == "video_translation" and item.get("event") == "batch"
    ]
    assert len(batch_lines) == 2
    assert sorted(item["batch"] for item in batch_lines) == [1, 2]
    assert all(item["duration_ms"] >= 0 for item in batch_lines)
    assert all(item["concurrency"] == 2 for item in batch_lines)

    analysis_lines = [item for item in timing if item["feature"] == "video_analysis"]
    assert len(analysis_lines) == 1
    assert analysis_lines[0]["total_ms"] >= 0
    assert analysis_lines[0]["content_ref"] == VIDEO_ID


# ---------------------------------------------------------------------------
# 7. SSE 流式路径：顺序/进度/逐批落盘不变
# ---------------------------------------------------------------------------

def test_sse_stream_keeps_batch_order_progress_and_cache(client, history_dir, monkeypatch):
    blocks = _blocks(41)

    async def fake_batch(
        batch,
        model=None,
        vocab_level=None,
        *,
        feature="translate",
        user_id=None,
        target_lang=None,
    ):
        return _translated(batch)

    async def fake_summary(_blocks, model=None, **_kwargs):
        return "测试总结"

    async def fake_analysis(payload, **kwargs):
        return None

    monkeypatch.setattr(translate, "process_llm_batch", fake_batch)
    monkeypatch.setattr(
        routes_videos, "fetch_english_transcript", lambda _video_id: list(blocks)
    )
    monkeypatch.setattr(routes_videos, "get_video_metadata", lambda _url: dict(METADATA))
    monkeypatch.setattr(
        routes_videos,
        "group_transcript_blocks",
        lambda _raw: [dict(block) for block in blocks],
    )
    monkeypatch.setattr(routes_videos, "summarize_video_transcript", fake_summary)
    monkeypatch.setattr(teaching_analysis, "attach_to_payload", fake_analysis)
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)

    with client.stream(
        "POST", "/api/process-video-stream", json={"url": URL}
    ) as response:
        assert response.status_code == 200
        lines = list(response.iter_lines())

    events: list[tuple[str, dict]] = []
    current = None
    for line in lines:
        if line.startswith("event: "):
            current = line.split(": ", 1)[1]
        elif line.startswith("data: ") and current:
            events.append((current, json.loads(line[len("data: "):])))
            current = None

    names = [name for name, _ in events]
    assert names == ["meta", "batch", "batch", "stage", "summary", "done"]
    batches = [payload for name, payload in events if name == "batch"]
    assert [item["progress"]["done"] for item in batches] == [10, 41]
    streamed_ids = [block["id"] for item in batches for block in item["blocks"]]
    assert streamed_ids == list(range(1, 42))

    # 逐批落盘：缓存文件里 41 句全部是译文，不再是 [未翻译] 标记（断点恢复口径）。
    cache_files = list(history_dir.glob(f"*_{VIDEO_ID}.json"))
    assert len(cache_files) == 1
    cached = json.loads(cache_files[0].read_text(encoding="utf-8"))
    assert [block["id"] for block in cached["transcript"]] == list(range(1, 42))
    assert all(block["zh_text"].startswith("译文") for block in cached["transcript"])
