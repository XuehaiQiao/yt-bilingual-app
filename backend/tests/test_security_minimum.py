"""M1 ⑦ 安全最小集：限速 / 全局 LLM 并发闸 / URL 白名单 / 预估缓存上限。

全部离线：LLM、字幕、元数据都用桩；不依赖 Redis、不联网。
"""
import asyncio
import json
import threading
import time
from types import SimpleNamespace

import httpx
import pytest

import config
import llm
import main
import ratelimit
import routes_user
import routes_videos
import transcripts

VIDEO_ID = "dQw4w9WgXcQ"  # 11 位，合法
VALID_URL = f"https://www.youtube.com/watch?v={VIDEO_ID}"

TRANSCRIPT = [
    SimpleNamespace(text="Hello world.", start=0.0, duration=1.0),
    SimpleNamespace(text="Learning English is fun.", start=1.0, duration=2.0),
]
METADATA = {
    "title": "Security Test",
    "channel": "Test Channel",
    "upload_date": "20260101",
    "thumbnail": "",
}
TRANSLATION_PAYLOAD = {
    "blocks": [
        {
            "id": 1,
            "en_text": "Hello world.",
            "zh_text": "你好，世界。",
            "highlights": [],
        },
        {
            "id": 2,
            "en_text": "Learning English is fun.",
            "zh_text": "学英语很有趣。",
            "highlights": [],
        },
    ]
}
DICT_PAYLOAD = {
    "word": "alpha",
    "pos": "n.",
    "zh": "阿尔法",
    "definition_en": "The first letter.",
}


def _install_video_fakes(monkeypatch):
    monkeypatch.setattr(
        routes_videos, "fetch_english_transcript", lambda _video_id: list(TRANSCRIPT)
    )
    monkeypatch.setattr(routes_videos, "get_video_metadata", lambda _url: dict(METADATA))
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)
    monkeypatch.setattr(
        llm,
        "generate_json",
        lambda prompt, model=None: json.dumps(TRANSLATION_PAYLOAD, ensure_ascii=False),
    )
    monkeypatch.setattr(llm, "generate_text", lambda prompt, model=None: "测试总结")


# ---------------------------------------------------------------------------
# 1. 限速：固定窗口、429 + Retry-After、按 IP/用户隔离、0 = 关闭
# ---------------------------------------------------------------------------


def test_consume_fixed_window_and_retry_after():
    ratelimit.reset_rate_limits()
    now = 1000.0
    key = "ip:198.51.100.7"

    assert ratelimit.consume("auth", key, 2, now=now) is None
    assert ratelimit.consume("auth", key, 2, now=now + 1) is None
    # 窗口内已 2 次：第 3 次拒绝，Retry-After = 最早那次 60 秒后过期（剩 58s）。
    assert ratelimit.consume("auth", key, 2, now=now + 2) == 58
    # 其他键互不影响
    assert ratelimit.consume("auth", "ip:198.51.100.8", 2, now=now + 2) is None
    # 窗口滑过后恢复
    assert ratelimit.consume("auth", key, 2, now=now + 61) is None
    # limit=0 表示关闭，不计数也不拒绝
    for _ in range(5):
        assert ratelimit.consume("auth", key, 0, now=now + 100) is None


def test_rate_limit_bucket_routing():
    assert ratelimit.bucket_for("/api/auth/signup").name == "auth"
    assert ratelimit.bucket_for("/api/auth/login").scope == "ip"
    assert ratelimit.bucket_for("/api/estimate-cost").name == "estimate"
    assert ratelimit.bucket_for("/api/process-video").name == "process_video"
    assert ratelimit.bucket_for("/api/process-video-stream").name == "process_video"
    assert ratelimit.bucket_for("/api/define").name == "define"
    assert ratelimit.bucket_for("/api/models") is None
    assert ratelimit.bucket_for("/health") is None


def test_signup_is_rate_limited_by_ip(make_client, monkeypatch):
    monkeypatch.setattr(config, "RATE_LIMIT_AUTH_PER_MINUTE", 2)
    ratelimit.reset_rate_limits()

    with make_client() as client:
        for index in range(2):
            created = client.post(
                "/api/auth/signup",
                json={"email": f"limit-{index}@example.com", "password": "password-123"},
            )
            assert created.status_code == 201, created.text

        limited = client.post(
            "/api/auth/signup",
            json={"email": "limit-2@example.com", "password": "password-123"},
        )

    assert limited.status_code == 429
    assert int(limited.headers["Retry-After"]) >= 1
    assert "频繁" in limited.json()["detail"]
    assert limited.json()["retryAfter"] == int(limited.headers["Retry-After"])


def test_estimate_cost_is_rate_limited_per_user(client, monkeypatch):
    monkeypatch.setattr(config, "RATE_LIMIT_ESTIMATE_COST_PER_MINUTE", 1)
    ratelimit.reset_rate_limits()
    _install_video_fakes(monkeypatch)

    first = client.get("/api/estimate-cost", params={"url": VALID_URL})
    assert first.status_code == 200, first.text

    limited = client.get("/api/estimate-cost", params={"url": VALID_URL})
    assert limited.status_code == 429
    assert int(limited.headers["Retry-After"]) >= 1
    # 其它接口不受该桶影响
    assert client.get("/api/models").status_code == 200


def test_process_video_is_rate_limited_per_user(client, monkeypatch):
    monkeypatch.setattr(config, "RATE_LIMIT_PROCESS_VIDEO_PER_MINUTE", 1)
    ratelimit.reset_rate_limits()
    _install_video_fakes(monkeypatch)

    first = client.post("/api/process-video", json={"url": VALID_URL})
    assert first.status_code == 200, first.text

    limited = client.post("/api/process-video", json={"url": VALID_URL})
    assert limited.status_code == 429
    assert int(limited.headers["Retry-After"]) >= 1
    # /api/process-video-stream 与经典端点共用同一个桶
    streaming = client.post("/api/process-video-stream", json={"url": VALID_URL})
    assert streaming.status_code == 429


def test_process_video_limit_is_per_user_not_ip(make_client, monkeypatch):
    monkeypatch.setattr(config, "RATE_LIMIT_PROCESS_VIDEO_PER_MINUTE", 1)
    ratelimit.reset_rate_limits()

    def _signup(client, email):
        response = client.post(
            "/api/auth/signup",
            json={"email": email, "password": "password-123"},
        )
        assert response.status_code == 201, response.text

    with make_client() as alice, make_client() as bob:
        _signup(alice, "alice-limit@example.com")
        _signup(bob, "bob-limit@example.com")
        invalid = "https://evil.example.com/watch?v=" + VIDEO_ID

        # 同一个 IP（TestClient 的 client.host 都是 testclient），但按用户分桶。
        assert alice.post("/api/process-video", json={"url": invalid}).status_code == 400
        assert alice.post("/api/process-video", json={"url": invalid}).status_code == 429
        assert bob.post("/api/process-video", json={"url": invalid}).status_code == 400


def test_define_is_rate_limited_per_user(client, monkeypatch):
    monkeypatch.setattr(config, "RATE_LIMIT_DEFINE_PER_MINUTE", 1)
    ratelimit.reset_rate_limits()
    monkeypatch.setattr(
        routes_user, "_dict_models_for_request", lambda preferred, lang=None: ["deepseek-chat"]
    )
    monkeypatch.setattr(
        llm,
        "generate_json",
        lambda prompt, model=None: json.dumps(DICT_PAYLOAD, ensure_ascii=False),
    )

    first = client.post("/api/define", json={"word": "alpha"})
    assert first.status_code == 200, first.text

    limited = client.post("/api/define", json={"word": "beta"})
    assert limited.status_code == 429
    assert int(limited.headers["Retry-After"]) >= 1


def test_zero_limit_disables_rate_limiting(client, monkeypatch):
    monkeypatch.setattr(config, "RATE_LIMIT_DEFINE_PER_MINUTE", 0)
    ratelimit.reset_rate_limits()

    # 空词会走到路由内 400；若限速生效则第 2 次起会是 429。
    for _ in range(3):
        response = client.post("/api/define", json={"word": ""})
        assert response.status_code == 400


# ---------------------------------------------------------------------------
# 2. URL 白名单（锚定；拒绝 userinfo / 奇怪 scheme / 非 YouTube 域名）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        f"https://www.youtube.com/watch?v={VIDEO_ID}",
        f"http://youtube.com/watch?v={VIDEO_ID}&t=10",
        f"youtube.com/watch?v={VIDEO_ID}",
        f"https://youtu.be/{VIDEO_ID}",
        f"https://youtu.be/{VIDEO_ID}?si=tracking",
        f"https://www.youtube.com/embed/{VIDEO_ID}",
        f"https://m.youtube.com/embed/{VIDEO_ID}?autoplay=1",
        f"https://www.youtube.com/shorts/{VIDEO_ID}",
        f"https://m.youtube.com/shorts/{VIDEO_ID}",
        f"  https://WWW.YOUTUBE.COM/watch?v={VIDEO_ID}  ",
    ],
)
def test_extract_video_id_accepts_whitelisted_forms(url):
    assert transcripts.extract_video_id(url) == VIDEO_ID


@pytest.mark.parametrize(
    "url",
    [
        # 非 YouTube 域名 / 域名伪装
        f"https://evil.example.com/watch?v={VIDEO_ID}",
        f"https://youtube.com.evil.example.com/watch?v={VIDEO_ID}",
        f"https://evil.example.com/youtu.be/{VIDEO_ID}",
        f"https://evil.example.com/?next=https://youtube.com/watch?v={VIDEO_ID}",
        # userinfo 绕过
        f"https://user@youtube.com/watch?v={VIDEO_ID}",
        f"https://user:pass@youtube.com/watch?v={VIDEO_ID}",
        f"https://youtube.com@evil.example.com/watch?v={VIDEO_ID}",
        # 奇怪 scheme / 端口 / 协议相对
        f"ftp://youtube.com/watch?v={VIDEO_ID}",
        f"javascript:alert('https://youtube.com/watch?v={VIDEO_ID}')",
        f"file:///youtube.com/watch?v={VIDEO_ID}",
        f"https://youtube.com:443/watch?v={VIDEO_ID}",
        f"//youtube.com/watch?v={VIDEO_ID}",
        # videoId 必须 11 位且只含 [A-Za-z0-9_-]
        "https://youtube.com/watch?v=short",
        "https://youtube.com/watch?v=dQw4w9WgXcQextra",
        "https://youtube.com/watch?v=dQw4w9WgXc!",
        "https://youtube.com/watch?v=",
        # 路径必须锚定
        "https://youtube.com/watch",
        f"https://youtube.com/watch/?v={VIDEO_ID}",
        f"https://youtube.com/watch/extra?v={VIDEO_ID}",
        f"https://youtube.com/embed/{VIDEO_ID}/extra",
        f"https://youtube.com/shorts/{VIDEO_ID}/extra",
        f"https://youtube.com/v/{VIDEO_ID}",
        # 多个/重复 v 参数
        f"https://youtube.com/watch?v={VIDEO_ID}&v=AAAAAAAAAAA",
        # 控制字符/反斜杠夹带
        f"https://youtube.com/watch?v={VIDEO_ID}\nhttps://evil.example.com",
        f"https://youtube.com\\@evil.example.com/watch?v={VIDEO_ID}",
    ],
)
def test_extract_video_id_rejects_non_whitelisted_forms(url):
    with pytest.raises(ValueError):
        transcripts.extract_video_id(url)


def test_canonical_watch_url_is_rebuilt_from_id():
    assert (
        transcripts.canonical_watch_url(VIDEO_ID)
        == f"https://www.youtube.com/watch?v={VIDEO_ID}"
    )
    with pytest.raises(ValueError):
        transcripts.canonical_watch_url("not-valid")


def test_invalid_url_returns_400(client, monkeypatch):
    _install_video_fakes(monkeypatch)
    bad = "https://evil.example.com/watch?v=" + VIDEO_ID

    assert client.get("/api/estimate-cost", params={"url": bad}).status_code == 400
    assert client.post("/api/process-video", json={"url": bad}).status_code == 400
    # 流式端点也在开流前校验：非法 URL 直接 400，而不是 200 + error 事件。
    assert client.post("/api/process-video-stream", json={"url": bad}).status_code == 400


def test_metadata_fetch_uses_canonical_url(client, monkeypatch):
    seen_urls = []

    def fake_metadata(url):
        seen_urls.append(url)
        return dict(METADATA)

    monkeypatch.setattr(routes_videos, "get_video_metadata", fake_metadata)
    monkeypatch.setattr(
        routes_videos, "fetch_english_transcript", lambda _video_id: list(TRANSCRIPT)
    )

    response = client.get(
        "/api/estimate-cost",
        params={"url": f"https://youtu.be/{VIDEO_ID}?si=tracking&list=PLevil"},
    )
    assert response.status_code == 200, response.text
    # yt-dlp 只拿重建后的规范 URL，不能携带用户原始 query（防止播放列表抓取等）。
    assert seen_urls == [f"https://www.youtube.com/watch?v={VIDEO_ID}"]


# ---------------------------------------------------------------------------
# 3. 预估缓存：容量上限淘汰最久未用 + TTL
# ---------------------------------------------------------------------------


def _entry(marker: str):
    return ({"title": marker}, [marker])


def test_prefetch_cache_capacity_evicts_oldest(monkeypatch):
    routes_videos._prefetch_cache.clear()
    monkeypatch.setattr(routes_videos, "PREFETCH_CACHE_MAX_ENTRIES", 2)
    monkeypatch.setattr(routes_videos, "PREFETCH_CACHE_TTL_SECONDS", 600)

    routes_videos._prefetch_store("aaa", *_entry("a"), now=100.0)
    routes_videos._prefetch_store("bbb", *_entry("b"), now=101.0)
    routes_videos._prefetch_store("ccc", *_entry("c"), now=102.0)

    assert list(routes_videos._prefetch_cache) == ["bbb", "ccc"]
    assert routes_videos._prefetch_take("aaa", now=103.0) is None
    assert routes_videos._prefetch_take("ccc", now=103.0)[1] == {"title": "c"}


def test_prefetch_cache_ttl_and_single_use(monkeypatch):
    routes_videos._prefetch_cache.clear()
    monkeypatch.setattr(routes_videos, "PREFETCH_CACHE_MAX_ENTRIES", 10)
    monkeypatch.setattr(routes_videos, "PREFETCH_CACHE_TTL_SECONDS", 600)

    routes_videos._prefetch_store("ttl", *_entry("x"), now=100.0)
    # TTL 内命中，且取用后即消费（确认处理不再重复使用）。
    assert routes_videos._prefetch_take("ttl", now=699.0) is not None
    assert routes_videos._prefetch_take("ttl", now=699.0) is None

    routes_videos._prefetch_store("expired", *_entry("y"), now=100.0)
    assert routes_videos._prefetch_take("expired", now=701.0) is None
    assert "expired" not in routes_videos._prefetch_cache


def test_prefetch_cache_can_be_disabled(monkeypatch):
    routes_videos._prefetch_cache.clear()
    monkeypatch.setattr(routes_videos, "PREFETCH_CACHE_MAX_ENTRIES", 0)
    monkeypatch.setattr(routes_videos, "PREFETCH_CACHE_TTL_SECONDS", 600)

    routes_videos._prefetch_store("off", *_entry("z"), now=100.0)
    assert routes_videos._prefetch_cache == {}


# ---------------------------------------------------------------------------
# 4. 全局 LLM 并发闸：上限、直方图日志、0 = 不限
# ---------------------------------------------------------------------------


def test_llm_concurrency_gate_caps_parallel_calls(monkeypatch):
    monkeypatch.setattr(config, "LLM_MAX_CONCURRENCY", 2)
    llm.reset_concurrency_gate()

    lock = threading.Lock()
    state = {"active": 0, "peak": 0}

    def slow_generate(_prompt, model=None):
        with lock:
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
        time.sleep(0.1)
        with lock:
            state["active"] -= 1
        return "ok"

    monkeypatch.setattr(llm, "generate_json", slow_generate)

    async def scenario():
        started = time.perf_counter()
        results = await asyncio.gather(
            *[llm.generate_json_async(f"p{i}", model="deepseek-chat") for i in range(6)]
        )
        return results, time.perf_counter() - started

    results, elapsed = asyncio.run(scenario())

    assert results == ["ok"] * 6
    assert state["peak"] == 2, f"并发闸应限制在 2，实际峰值 {state['peak']}"
    assert elapsed >= 0.3, "6 个 0.1s 的调用在并发 2 下至少需要 3 波"
    snapshot = llm.concurrency_snapshot()
    assert snapshot["limit"] == 2
    assert snapshot["acquired"] == 6
    assert snapshot["peak"] == 2
    assert snapshot["active"] == 0
    assert sum(snapshot["wait_ms_histogram"].values()) == 6
    assert snapshot["waited"] >= 1, "排队过的请求应计入 waited"


def test_llm_concurrency_gate_zero_means_unlimited(monkeypatch):
    monkeypatch.setattr(config, "LLM_MAX_CONCURRENCY", 0)
    llm.reset_concurrency_gate()

    lock = threading.Lock()
    state = {"active": 0, "peak": 0}

    def slow_generate(_prompt, model=None):
        with lock:
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
        time.sleep(0.1)
        with lock:
            state["active"] -= 1
        return "ok"

    monkeypatch.setattr(llm, "generate_json", slow_generate)

    async def scenario():
        started = time.perf_counter()
        await asyncio.gather(
            *[llm.generate_json_async(f"p{i}", model="deepseek-chat") for i in range(6)]
        )
        return time.perf_counter() - started

    elapsed = asyncio.run(scenario())

    assert state["peak"] == 6, "LLM_MAX_CONCURRENCY=0 时不应限并发"
    assert elapsed < 0.4


def test_define_route_goes_through_concurrency_gate(client, monkeypatch):
    """路由层确实走 generate_json_async，而不是绕过闸门直接 to_thread。"""
    monkeypatch.setattr(config, "LLM_MAX_CONCURRENCY", 1)
    llm.reset_concurrency_gate()
    monkeypatch.setattr(
        routes_user, "_dict_models_for_request", lambda preferred, lang=None: ["deepseek-chat"]
    )

    lock = threading.Lock()
    state = {"active": 0, "peak": 0}

    def slow_generate(_prompt, model=None):
        with lock:
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
        time.sleep(0.1)
        with lock:
            state["active"] -= 1
        return json.dumps(DICT_PAYLOAD, ensure_ascii=False)

    monkeypatch.setattr(llm, "generate_json", slow_generate)

    token = client.cookies.get("ln_session")
    assert token, "认证夹具应已登录"

    async def scenario():
        headers = {"x-api-key": config.API_AUTH_KEY} if config.API_AUTH_KEY else {}
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
            headers=headers,
            cookies={"ln_session": token},
        ) as async_client:
            started = time.perf_counter()
            responses = await asyncio.gather(
                async_client.post("/api/define", json={"word": "alpha"}),
                async_client.post("/api/define", json={"word": "beta"}),
            )
            return responses, time.perf_counter() - started

    responses, elapsed = asyncio.run(scenario())

    assert [response.status_code for response in responses] == [200, 200], [
        response.text for response in responses
    ]
    assert state["peak"] == 1, "同一时刻只允许 1 个 LLM 调用"
    assert elapsed >= 0.18, "两个 0.1s 调用应被串行执行"
    snapshot = llm.concurrency_snapshot()
    assert snapshot["acquired"] == 2
    assert snapshot["waited"] >= 1
