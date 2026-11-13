"""P0 上线阻塞项回归：事件循环不被同步调用卡住 + SSE 心跳。

- P0-1：两个并发 SSE 流里各有一次 0.5s 的同步 LLM 调用。断言等待期间
  事件循环仍在调度（/health 秒回、调度间隔小），且同步调用都跑在 worker
  线程而不是事件循环线程。
- P0-2：慢 LLM 期间 SSE 响应里出现 `: ping` 注释行（无 data 行，前端
  consumeSseStream 会忽略），且事件顺序保持 meta → batch → stage →
  summary → done 不变。

全部离线：字幕抓取 / yt-dlp 元数据 / LLM 全部 monkeypatch。
"""
import asyncio
import json
import threading
import time
from types import SimpleNamespace

import httpx

import config
import llm
import routes_videos

URL_TEMPLATE = "https://www.youtube.com/watch?v={video_id}"

TRANSCRIPT = [SimpleNamespace(text="Hello world.", start=0.0, duration=1.0)]
METADATA = {
    "title": "Stream Test",
    "channel": "Test Channel",
    "upload_date": "20240101",
    "thumbnail": "",
}


def _install_slow_fakes(monkeypatch, *, llm_delay: float, fetch_delay: float = 0.0, meta_delay: float = 0.0):
    """把外部依赖换成记录线程 id 的同步桩；LLM 桩按真实 SDK 那样阻塞。"""
    thread_ids = {"fetch": [], "meta": [], "json": [], "text": []}

    def fake_fetch(_video_id):
        thread_ids["fetch"].append(threading.get_ident())
        time.sleep(fetch_delay)
        return list(TRANSCRIPT)

    def fake_metadata(_url):
        thread_ids["meta"].append(threading.get_ident())
        time.sleep(meta_delay)
        return dict(METADATA)

    def fake_generate_json(_prompt, model=None):
        thread_ids["json"].append(threading.get_ident())
        time.sleep(llm_delay)
        return json.dumps(
            {"blocks": [{"id": 1, "zh_text": "你好，世界。", "highlights": []}]},
            ensure_ascii=False,
        )

    def fake_generate_text(_prompt, model=None):
        thread_ids["text"].append(threading.get_ident())
        return "测试总结"

    monkeypatch.setattr(routes_videos, "fetch_english_transcript", fake_fetch)
    monkeypatch.setattr(routes_videos, "get_video_metadata", fake_metadata)
    monkeypatch.setattr(llm, "generate_json", fake_generate_json)
    monkeypatch.setattr(llm, "generate_text", fake_generate_text)
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)
    return thread_ids


def test_two_concurrent_streams_do_not_block_event_loop(client, monkeypatch):
    """P0-1：一个流的慢 LLM 不能卡住另一个流/健康检查。"""
    llm_delay = 0.5
    thread_ids = _install_slow_fakes(
        monkeypatch, llm_delay=llm_delay, fetch_delay=0.05, meta_delay=0.05
    )
    token = client.cookies.get("ln_session")
    assert token, "认证夹具应已登录"
    main_thread = threading.get_ident()

    async def scenario():
        import main

        headers = {"x-api-key": config.API_AUTH_KEY} if config.API_AUTH_KEY else {}
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
            headers=headers,
            cookies={"ln_session": token},
        ) as async_client:
            stop = asyncio.Event()
            gaps: list[float] = []

            async def ticker():
                """每 10ms 记一次实际调度间隔；事件循环被卡住时间隔会变大。"""
                last = time.perf_counter()
                while not stop.is_set():
                    await asyncio.sleep(0.01)
                    now = time.perf_counter()
                    gaps.append(now - last)
                    last = now

            async def stream_once(video_id: str):
                started = time.perf_counter()
                response = await async_client.post(
                    "/api/process-video-stream",
                    json={
                        "url": URL_TEMPLATE.format(video_id=video_id),
                        "model": "deepseek-chat",
                    },
                )
                return response, time.perf_counter() - started

            ticker_task = asyncio.create_task(ticker())
            started_all = time.perf_counter()
            streams = [
                asyncio.create_task(stream_once(video_id))
                for video_id in ("concurrentA1", "concurrentB2")
            ]
            # fetch 0.05s + metadata 0.05s 后两条流进入 0.5s 的慢 LLM 调用，
            # 此时探活/调度才是对事件循环是否被阻塞的真正检验。
            await asyncio.sleep(0.2)
            probe_started = time.perf_counter()
            probe = await async_client.get("/health")
            probe_latency = time.perf_counter() - probe_started

            results = await asyncio.gather(*streams)
            total_elapsed = time.perf_counter() - started_all
            stop.set()
            await ticker_task
            return results, probe, probe_latency, total_elapsed, max(gaps)

    results, probe, probe_latency, total_elapsed, max_gap = asyncio.run(scenario())

    assert probe.status_code == 200
    assert probe.json() == {"status": "ok"}
    for response, elapsed in results:
        assert response.status_code == 200
        assert "event: done" in response.text
        assert elapsed >= llm_delay * 0.8, f"慢 LLM 桩应真的耗时（{elapsed:.2f}s）"

    # 事件循环在 0.5s 的同步调用期间仍必须能每几十毫秒调度一次。
    assert max_gap < 0.3, f"事件循环被阻塞：最大调度间隔 {max_gap:.3f}s"
    assert probe_latency < 0.3, f"慢 LLM 期间 /health 被拖慢到 {probe_latency:.3f}s"
    # 两个流应重叠：总耗时接近单条，而不是两条相加。
    assert total_elapsed < sum(elapsed for _, elapsed in results), (
        f"两个流没有并发：total={total_elapsed:.2f}s, "
        f"sum={sum(elapsed for _, elapsed in results):.2f}s"
    )

    # 同步网络/SDK 调用必须在 worker 线程，而不是事件循环所在线程。
    for key in ("fetch", "meta", "json"):
        assert thread_ids[key], f"{key} 桩没有被调用"
        assert main_thread not in thread_ids[key], f"{key} 仍在事件循环线程里同步执行"


def test_sse_stream_sends_heartbeat_comments_during_slow_llm(client, monkeypatch):
    """P0-2：慢 LLM 等待期间有 `: ping` 注释行，且事件结构/顺序不变。"""
    _install_slow_fakes(monkeypatch, llm_delay=0.45)
    monkeypatch.setattr(routes_videos, "SSE_HEARTBEAT_SECONDS", 0.05)

    with client.stream(
        "POST",
        "/api/process-video-stream",
        json={
            "url": URL_TEMPLATE.format(video_id="heartbeat1"),
            "model": "deepseek-chat",
        },
    ) as response:
        assert response.status_code == 200
        lines = list(response.iter_lines())

    heartbeats = [line for line in lines if line.startswith(":")]
    assert heartbeats, "慢 LLM 期间必须出现 SSE 心跳注释行"
    assert all(line.strip() == ": ping" for line in heartbeats)
    # 注释行不能带 data 行：前端 parseSseEvent 对无 data 的事件返回 null。
    assert all("data:" not in line for line in heartbeats)

    # 心跳不能改变事件结构或顺序。
    events = [line.split(": ", 1)[1] for line in lines if line.startswith("event:")]
    assert events == ["meta", "batch", "stage", "summary", "done"]

    # 心跳发生在「已发 meta、还在等首批翻译」的窗口内。
    first_batch = lines.index("event: batch")
    assert any(line.startswith(":") for line in lines[:first_batch]), (
        "等待首批翻译期间应有心跳"
    )

    # 事件 data 行仍然是完整 JSON（心跳没有混进 data）。
    for line in lines:
        if line.startswith("data:"):
            json.loads(line[len("data:"):].strip())


def test_sse_heartbeat_interval_env_override(monkeypatch):
    """心跳间隔可用环境变量覆盖；非法值回落默认 15s。"""
    assert config.SSE_HEARTBEAT_SECONDS > 0
    assert config._positive_float_env("P0_HEARTBEAT_MISSING", 15.0) == 15.0
    monkeypatch.setenv("P0_HEARTBEAT_TEST", "2.5")
    assert config._positive_float_env("P0_HEARTBEAT_TEST", 15.0) == 2.5
    monkeypatch.setenv("P0_HEARTBEAT_TEST", "not-a-number")
    assert config._positive_float_env("P0_HEARTBEAT_TEST", 15.0) == 15.0
    monkeypatch.setenv("P0_HEARTBEAT_TEST", "0")
    assert config._positive_float_env("P0_HEARTBEAT_TEST", 15.0) == 15.0
