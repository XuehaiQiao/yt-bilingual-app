"""P1-19 SSE 流式翻译批次并行 + 计时日志的离线验收。

覆盖：

1. 并发配置 ``SSE_TRANSLATE_CONCURRENCY``：默认 2，1–3 生效，非法值回落 2；
2. 3 批延迟 mock（0.24 / 0.12 / 0.04s，完成顺序与批序相反）：
   - wall time ≈ 最慢一批（串行应为三者之和），证明批次确实并行；
   - ``batch`` 事件仍按批序（1–20 / 21–40 / 41–45）产出，前端按 id 合并无需改；
3. 每批完成即落盘（写锁串行），中途取消后未翻译块仍标记、续跑只补缺失；
4. 取消：在途批次被取消，没有泄漏 task；
5. 402/额度硬闸：立即中断所有在途批次并透传（不落 mock、不等前一批）；
6. provider 节奏：``batch_pause`` 变成按「批开始时间」的全局限速；
7. 端点集成：``/api/process-video-stream`` 的 batch 顺序/进度不变，402 → SSE
   error 事件带稳定 code；
8. 计时日志：``feature=sse_translate``，每批 batch_index/queue_wait_ms/batch_ms/
   concurrency，收尾 total_ms/first_batch_ms。

全部离线：字幕/元数据/LLM 均 monkeypatch，目录在 tmp_path。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from types import SimpleNamespace

import pytest

import billing
import llm
import routes_videos
import teaching_analysis
import translate
from ai.ledger import QuotaExceeded

URL = "https://www.youtube.com/watch?v=ssetest0001"
VIDEO_ID = "ssetest0001"
METADATA = {
    "title": "SSE Pipeline Test",
    "channel": "Test Channel",
    "upload_date": "20240101",
    "thumbnail": "",
}
BATCH = 20


# ---------------------------------------------------------------------------
# 夹具 / 桩
# ---------------------------------------------------------------------------

def _transcript(count: int) -> list[dict]:
    """流式路径里的 transcript：id 从 1 开始、未翻译标记原样。"""
    return [
        {
            "id": index,
            "start": float(index),
            "end": float(index) + 1.0,
            "en_text": f"Sentence number {index}.",
            "zh_text": translate.UNTRANSLATED_MARKER,
            "highlights": [],
        }
        for index in range(1, count + 1)
    ]


def _payload(transcript: list[dict]) -> dict:
    return {
        "videoId": VIDEO_ID,
        "metadata": dict(METADATA),
        "transcript": transcript,
        "summary": "",
        "studyCount": 1,
    }


def _batch_index(blocks: list[dict]) -> int:
    """批下标（0 起）：id 1–20 → 0，21–40 → 1……"""
    return (int(blocks[0]["id"]) - 1) // BATCH


async def _translate_blocks(blocks: list[dict], prefix: str = "译文") -> list[dict]:
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
    delays: dict[int, float] | None = None,
    failures: dict[int, BaseException] | None = None,
    state: dict | None = None,
):
    """替换 ``translate.process_llm_batch``：按批下标加延迟 / 抛异常并记录并发。"""
    delays = delays or {}
    failures = failures or {}
    state = state if state is not None else {}
    state.setdefault("calls", [])
    state.setdefault("starts", [])
    state.setdefault("inflight", 0)
    state.setdefault("peak", 0)
    state.setdefault("cancelled", 0)

    async def fake(
        blocks,
        model=None,
        vocab_level=None,
        *,
        feature="translate",
        user_id=None,
        target_lang=None,
    ):
        index = _batch_index(blocks)
        state["calls"].append([block["id"] for block in blocks])
        state["starts"].append(time.perf_counter())
        state["inflight"] += 1
        state["peak"] = max(state["peak"], state["inflight"])
        try:
            delay = delays.get(index, 0)
            if delay:
                await asyncio.sleep(delay)
            failure = failures.get(index)
            if failure is not None:
                raise failure
            return await _translate_blocks(blocks)
        except asyncio.CancelledError:
            state["cancelled"] += 1
            raise
        finally:
            state["inflight"] -= 1

    monkeypatch.setattr(translate, "process_llm_batch", fake)
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)
    return state


def _persist_counter(monkeypatch) -> list[str]:
    """记录每次落盘的目标路径（仍调用真实写盘）。"""
    calls: list[str] = []
    real = translate._persist_stream_payload

    def counting(payload, save_path):
        calls.append(save_path)
        return real(payload, save_path)

    monkeypatch.setattr(translate, "_persist_stream_payload", counting)
    return calls


def _sse_events(response) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    current = None
    for line in response.text.splitlines():
        if line.startswith("event: "):
            current = line[len("event: "):]
        elif line.startswith("data: ") and current:
            events.append((current, json.loads(line[len("data: "):])))
            current = None
    return events


def _timing_records(caplog) -> list[dict]:
    records: list[dict] = []
    for record in caplog.records:
        if record.name != "linguatrek.translate":
            continue
        if not record.getMessage().startswith("{"):
            continue
        records.append(json.loads(record.getMessage()))
    return records


def _install_endpoint_fakes(monkeypatch, blocks: list[dict], batch_fake):
    """让 /api/process-video-stream 走真实路由，只把外部依赖打桩。"""
    raw = [
        SimpleNamespace(
            text=block.get("text") or block["en_text"],
            start=block["start"],
            duration=0.9,
        )
        for block in blocks
    ]

    async def fake_summary(_blocks, model=None, **_kwargs):
        return "测试总结"

    async def fake_analysis(payload, **kwargs):
        return None

    monkeypatch.setattr(translate, "process_llm_batch", batch_fake)
    monkeypatch.setattr(
        routes_videos,
        "fetch_english_transcript",
        lambda _video_id: list(raw),
    )
    monkeypatch.setattr(routes_videos, "get_video_metadata", lambda _url: dict(METADATA))
    monkeypatch.setattr(
        routes_videos,
        "group_transcript_blocks",
        lambda _raw: [
            {
                "id": block["id"],
                "start": block["start"],
                "end": block["end"],
                "text": block.get("text") or block["en_text"],
            }
            for block in blocks
        ],
    )
    monkeypatch.setattr(routes_videos, "summarize_video_transcript", fake_summary)
    monkeypatch.setattr(teaching_analysis, "attach_to_payload", fake_analysis)
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)


def _delay_fake(monkeypatch, delays: dict[int, float], state: dict | None = None):
    """端点用：按批下标延迟的 process_llm_batch。"""
    state = state if state is not None else {}
    state.setdefault("peak", 0)
    state.setdefault("inflight", 0)

    async def fake(blocks, model=None, vocab_level=None, **_kwargs):
        index = _batch_index(blocks)
        state["inflight"] += 1
        state["peak"] = max(state["peak"], state["inflight"])
        try:
            await asyncio.sleep(delays.get(index, 0))
            return await _translate_blocks(blocks)
        finally:
            state["inflight"] -= 1

    return fake


# ---------------------------------------------------------------------------
# 1. 并发配置
# ---------------------------------------------------------------------------

def test_stream_translate_concurrency_config(monkeypatch):
    monkeypatch.delenv("SSE_TRANSLATE_CONCURRENCY", raising=False)
    assert translate._stream_translate_concurrency() == 2

    cases = {
        "1": 1,
        "2": 2,
        "3": 3,
        "0": 2,
        "9": 2,
        "-1": 2,
        "abc": 2,
        "  ": 2,
    }
    for raw, expected in cases.items():
        monkeypatch.setenv("SSE_TRANSLATE_CONCURRENCY", raw)
        assert translate._stream_translate_concurrency() == expected, raw


# ---------------------------------------------------------------------------
# 2. 并行 wall time + 按批序产出（完成顺序与批序相反）
# ---------------------------------------------------------------------------

def test_parallel_batches_keep_order_and_persist(monkeypatch, tmp_path, caplog):
    monkeypatch.setenv("SSE_TRANSLATE_CONCURRENCY", "3")
    caplog.set_level(logging.INFO, logger="linguatrek.translate")

    transcript = _transcript(45)  # 3 批：20 / 20 / 5
    payload = _payload(transcript)
    save_path = tmp_path / "cache.json"
    save_path.write_text(json.dumps(payload), encoding="utf-8")
    # 批 1 最慢、批 3 最快：完成顺序 3 → 2 → 1，事件必须仍按 1 → 2 → 3。
    state = _install_batch_fake(
        monkeypatch, delays={0: 0.24, 1: 0.12, 2: 0.04}
    )
    persisted = _persist_counter(monkeypatch)

    async def scenario():
        updates = []
        async for update in translate._stream_translate(
            transcript,
            list(range(len(transcript))),
            payload,
            str(save_path),
            model="deepseek-chat",
            target_lang="zh-CN",
        ):
            updates.append(update)
        return updates

    started = time.perf_counter()
    updates = asyncio.run(scenario())
    elapsed = time.perf_counter() - started

    # 并发 3：总耗时 ≈ 最慢一批（0.24s），串行应为 0.40s。
    assert state["peak"] == 3, "并发 3 时三批应同时在途"
    assert elapsed < 0.34, f"批次没有并行：{elapsed:.3f}s（串行约 0.40s）"

    # batch 事件按批序；block 顺序与串行路径完全一致。
    ids = [block["id"] for update in updates for block in update["blocks"]]
    assert ids == list(range(1, 46))
    assert [len(update["blocks"]) for update in updates] == [20, 20, 5]
    assert [update["progress"] for update in updates] == [
        {"done": 20, "total": 45},
        {"done": 40, "total": 45},
        {"done": 45, "total": 45},
    ]
    assert [update["translated"] for update in updates] == [20, 40, 45]

    # 每批完成即落盘（3 次），最终缓存全量译文。
    assert len(persisted) == 3
    saved = json.loads(save_path.read_text(encoding="utf-8"))
    assert all(block["zh_text"].startswith("译文") for block in saved["transcript"])

    # 计时日志：每批 + 一条收尾汇总。
    timing = _timing_records(caplog)
    batch_lines = [line for line in timing if line.get("event") == "batch"]
    totals = [line for line in timing if line.get("event") == "total"]
    assert [line["batch_index"] for line in batch_lines] == [0, 1, 2]
    assert all(line["feature"] == "sse_translate" for line in timing)
    assert all(line["concurrency"] == 3 for line in batch_lines)
    assert all(line["batch_count"] == 3 for line in batch_lines)
    # 后完成批次先落盘，但事件按序等前一批：批 2/3 的排队等待明显 > 0。
    assert batch_lines[1]["queue_wait_ms"] > 40
    assert batch_lines[2]["queue_wait_ms"] > 80
    assert batch_lines[0]["batch_ms"] > batch_lines[1]["batch_ms"] > batch_lines[2]["batch_ms"]

    assert len(totals) == 1
    total = totals[0]
    assert total["feature"] == "sse_translate"
    assert total["batch_count"] == 3
    assert total["concurrency"] == 3
    assert total["first_batch_ms"] >= 200
    assert total["total_ms"] >= total["first_batch_ms"]
    assert total["total_ms"] < 340
    assert total["outcome"] == "done"
    assert total["translated"] == 45


def test_default_concurrency_is_two(monkeypatch, tmp_path):
    monkeypatch.delenv("SSE_TRANSLATE_CONCURRENCY", raising=False)
    transcript = _transcript(45)
    payload = _payload(transcript)
    save_path = tmp_path / "cache.json"
    save_path.write_text(json.dumps(payload), encoding="utf-8")
    state = _install_batch_fake(
        monkeypatch, delays={0: 0.15, 1: 0.15, 2: 0.15}
    )

    async def scenario():
        async for _update in translate._stream_translate(
            transcript,
            list(range(len(transcript))),
            payload,
            str(save_path),
            model="deepseek-chat",
            target_lang="zh-CN",
        ):
            pass

    started = time.perf_counter()
    asyncio.run(scenario())
    elapsed = time.perf_counter() - started

    # 3 批 × 0.15s：默认 2 路两波完成（≈0.30s），串行 0.45s。
    assert state["peak"] == 2
    assert elapsed < 0.42, f"默认并发 2 未生效：{elapsed:.3f}s"


# ---------------------------------------------------------------------------
# 3. provider 限速：按批开始时间的全局节奏
# ---------------------------------------------------------------------------

def test_batch_pause_paces_batch_starts(monkeypatch, tmp_path):
    monkeypatch.setenv("SSE_TRANSLATE_CONCURRENCY", "3")
    transcript = _transcript(45)
    payload = _payload(transcript)
    save_path = tmp_path / "cache.json"
    save_path.write_text(json.dumps(payload), encoding="utf-8")
    state = _install_batch_fake(monkeypatch, delays={0: 0.01, 1: 0.01, 2: 0.01})
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0.12)

    async def scenario():
        async for _update in translate._stream_translate(
            transcript,
            list(range(len(transcript))),
            payload,
            str(save_path),
            model="deepseek-chat",
            target_lang="zh-CN",
        ):
            pass

    asyncio.run(scenario())

    gaps = [
        state["starts"][index + 1] - state["starts"][index]
        for index in range(len(state["starts"]) - 1)
    ]
    # 3 批：批与批开始时间至少间隔 batch_pause（允许调度误差）。
    assert len(gaps) == 2
    assert all(gap >= 0.1 for gap in gaps), f"批开始未按全局节奏：{gaps}"


# ---------------------------------------------------------------------------
# 4. 取消：在途批次取消、无 task 泄漏、已落盘进度保留
# ---------------------------------------------------------------------------

def test_cancel_cancels_inflight_and_resume_only_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("SSE_TRANSLATE_CONCURRENCY", "2")
    transcript = _transcript(45)
    payload = _payload(transcript)
    save_path = tmp_path / "cache.json"
    save_path.write_text(json.dumps(payload), encoding="utf-8")
    # 批 1 很快完成；批 2 长时间挂着（用来在取消时制造在途批次）。
    state = _install_batch_fake(
        monkeypatch, delays={0: 0.02, 1: 5.0, 2: 5.0}
    )
    persisted = _persist_counter(monkeypatch)

    async def first_run():
        generator = translate._stream_translate(
            transcript,
            list(range(len(transcript))),
            payload,
            str(save_path),
            model="deepseek-chat",
            target_lang="zh-CN",
        )
        first = await generator.__anext__()
        # 让第二批真正进入模型调用，再模拟客户端断开。
        for _ in range(50):
            if state["inflight"]:
                break
            await asyncio.sleep(0.01)
        assert state["inflight"] >= 1, "取消前应有在途批次"
        closed_at = time.perf_counter()
        await generator.aclose()
        close_elapsed = time.perf_counter() - closed_at
        await asyncio.sleep(0)
        leaked = [
            task
            for task in asyncio.all_tasks()
            if task is not asyncio.current_task()
        ]
        return first, close_elapsed, leaked

    first, close_elapsed, leaked = asyncio.run(first_run())

    # 取消立即生效（不用等 5s 的在途批次跑完），且没有遗留 task。
    assert close_elapsed < 1.0, f"取消后仍等了 {close_elapsed:.2f}s"
    assert leaked == [], f"取消后泄漏 task：{leaked}"
    assert state["cancelled"] >= 1, "在途批次没有被取消"
    assert [block["id"] for block in first["blocks"]] == list(range(1, 21))
    # 只有第 1 批完成落盘；其余块仍是未翻译标记（可自愈）。
    assert len(persisted) == 1
    saved = json.loads(save_path.read_text(encoding="utf-8"))
    markers = [
        block["id"]
        for block in saved["transcript"]
        if translate.needs_retranslation(block["zh_text"])
    ]
    assert markers == list(range(21, 46))

    # 续跑：只把缺失块送模型，已翻好的 20 句一个都不再送。
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)
    state["calls"].clear()
    pending = [
        index
        for index, block in enumerate(transcript)
        if translate.needs_retranslation(block.get("zh_text", ""))
    ]

    async def resume():
        async for _update in translate._stream_translate(
            transcript,
            pending,
            payload,
            str(save_path),
            model="deepseek-chat",
            target_lang="zh-CN",
        ):
            pass

    asyncio.run(resume())
    resumed_ids = [block_id for batch in state["calls"] for block_id in batch]
    assert sorted(resumed_ids) == list(range(21, 46))

    final = json.loads(save_path.read_text(encoding="utf-8"))
    assert all(
        not translate.needs_retranslation(block["zh_text"])
        for block in final["transcript"]
    )


# ---------------------------------------------------------------------------
# 5. 402/额度硬闸：立即中断并透传，不等前一批、不落 mock
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "failure",
    [
        billing.InsufficientBalance(
            balance_micro_usd=0,
            required_micro_usd=1000,
            feature="translate",
        ),
        QuotaExceeded(
            "translate",
            day="2026-11-23",
            used_units=10,
            limit_units=10,
        ),
    ],
    ids=["insufficient_balance_402", "quota_exceeded_429"],
)
def test_billing_error_aborts_immediately(monkeypatch, tmp_path, failure):
    monkeypatch.setenv("SSE_TRANSLATE_CONCURRENCY", "2")
    transcript = _transcript(45)
    payload = _payload(transcript)
    save_path = tmp_path / "cache.json"
    save_path.write_text(json.dumps(payload), encoding="utf-8")
    # 批 1 挂 5s，批 2 立刻抛硬闸：必须 402 立即中断，而不是等批 1。
    state = _install_batch_fake(
        monkeypatch,
        delays={0: 5.0},
        failures={1: failure},
    )
    persisted = _persist_counter(monkeypatch)

    async def scenario():
        generator = translate._stream_translate(
            transcript,
            list(range(len(transcript))),
            payload,
            str(save_path),
            model="deepseek-chat",
            target_lang="zh-CN",
        )
        started = time.perf_counter()
        with pytest.raises(type(failure)):
            await generator.__anext__()
        elapsed = time.perf_counter() - started
        await asyncio.sleep(0)
        leaked = [
            task
            for task in asyncio.all_tasks()
            if task is not asyncio.current_task()
        ]
        return elapsed, leaked

    elapsed, leaked = asyncio.run(scenario())

    assert elapsed < 0.5, f"硬闸没有立即中断：等了 {elapsed:.2f}s"
    assert leaked == [], f"硬闸中断后泄漏 task：{leaked}"
    assert state["cancelled"] >= 1, "在途批次没有被取消"
    assert persisted == [], "硬闸批次不应落盘成成功"


# ---------------------------------------------------------------------------
# 6. 单批失败：该批保持未翻译标记，其余批次正常，不中断整条流
# ---------------------------------------------------------------------------

def test_failed_batch_stays_untranslated_and_heals(monkeypatch, tmp_path):
    monkeypatch.setenv("SSE_TRANSLATE_CONCURRENCY", "2")
    transcript = _transcript(45)
    payload = _payload(transcript)
    save_path = tmp_path / "cache.json"
    save_path.write_text(json.dumps(payload), encoding="utf-8")
    state = _install_batch_fake(
        monkeypatch,
        failures={1: RuntimeError("malformed JSON from provider")},
    )
    persisted = _persist_counter(monkeypatch)

    async def scenario():
        updates = []
        async for update in translate._stream_translate(
            transcript,
            list(range(len(transcript))),
            payload,
            str(save_path),
            model="deepseek-chat",
            target_lang="zh-CN",
        ):
            updates.append(update)
        return updates

    updates = asyncio.run(scenario())

    assert [block["id"] for update in updates for block in update["blocks"]] == list(
        range(1, 46)
    )
    assert [update["translated"] for update in updates] == [20, 20, 25]
    assert [update["progress"]["done"] for update in updates] == [20, 40, 45]
    # 失败批也「完成即写盘」（内容是该批未翻译标记），次数仍为批数。
    assert len(persisted) == 3
    saved = json.loads(save_path.read_text(encoding="utf-8"))
    markers = [
        block["id"]
        for block in saved["transcript"]
        if translate.needs_retranslation(block["zh_text"])
    ]
    assert markers == list(range(21, 41))

    # 自愈：下次只补失败的那一批。
    state["calls"].clear()
    pending = [
        index
        for index, block in enumerate(transcript)
        if translate.needs_retranslation(block.get("zh_text", ""))
    ]

    async def resume():
        async for _update in translate._stream_translate(
            transcript,
            pending,
            payload,
            str(save_path),
            model="deepseek-chat",
            target_lang="zh-CN",
        ):
            pass

    asyncio.run(resume())
    assert [block_id for batch in state["calls"] for block_id in batch] == list(
        range(21, 41)
    )


# ---------------------------------------------------------------------------
# 7. 端点集成：SSE batch 顺序/进度不变（前端合并无需改）
# ---------------------------------------------------------------------------

def test_sse_endpoint_keeps_batch_order_with_parallel_batches(
    client, history_dir, monkeypatch, caplog
):
    blocks = _transcript(45)
    state: dict = {}
    # 批 1 最慢、批 3 最快 —— 完成顺序反着来，SSE 仍须按批序。
    _install_endpoint_fakes(
        monkeypatch, blocks, _delay_fake(monkeypatch, {0: 0.2, 1: 0.05, 2: 0.01}, state)
    )
    monkeypatch.setenv("SSE_TRANSLATE_CONCURRENCY", "3")
    caplog.set_level(logging.INFO, logger="linguatrek.translate")

    response = client.post("/api/process-video-stream", json={"url": URL})
    assert response.status_code == 200, response.text
    events = _sse_events(response)
    names = [name for name, _ in events]
    assert names == ["meta", "batch", "batch", "batch", "stage", "summary", "done"]

    batches = [data for name, data in events if name == "batch"]
    assert [data["progress"]["done"] for data in batches] == [20, 40, 45]
    assert [data["cursor"] for data in batches] == [20, 40, 45]
    assert [
        block["id"] for data in batches for block in data["blocks"]
    ] == list(range(1, 46))
    assert all(
        block["zh_text"].startswith("译文")
        for data in batches
        for block in data["blocks"]
    )

    # 缓存全量落盘。
    cache_files = list(history_dir.glob(f"*_{VIDEO_ID}.json"))
    assert len(cache_files) == 1
    cached = json.loads(cache_files[0].read_text(encoding="utf-8"))
    assert all(
        not translate.needs_retranslation(block["zh_text"])
        for block in cached["transcript"]
    )

    timing = _timing_records(caplog)
    assert [line["batch_index"] for line in timing if line.get("event") == "batch"] == [0, 1, 2]
    assert any(line.get("event") == "total" for line in timing)


def test_sse_endpoint_402_emits_error_event(client, monkeypatch):
    blocks = _transcript(45)
    failure = billing.InsufficientBalance(
        balance_micro_usd=0,
        required_micro_usd=1000,
        feature="translate",
    )

    # 批 2 立刻抛 402：流不能等批 1 跑完。
    async def failing(blocks_, **kwargs):
        if _batch_index(blocks_) == 1:
            raise failure
        await asyncio.sleep(5.0)
        return await _translate_blocks(blocks_)

    _install_endpoint_fakes(monkeypatch, blocks, failing)
    monkeypatch.setenv("SSE_TRANSLATE_CONCURRENCY", "2")

    started = time.perf_counter()
    response = client.post("/api/process-video-stream", json={"url": URL})
    elapsed = time.perf_counter() - started
    assert response.status_code == 200
    events = _sse_events(response)
    assert [name for name, _ in events] == ["meta", "error"]
    assert events[1][1]["code"] == "insufficient_balance"
    assert elapsed < 2.0, f"402 没有立即中断：{elapsed:.2f}s"
