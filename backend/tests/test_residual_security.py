"""M1 ⑦ 残余安全项：登录失败锁定 + 抓取边界（全离线）。

覆盖：
- 账号 / IP 连续失败 5 次 → 锁 15 分钟；锁定期间正确密码仍 429 + Retry-After；
- 锁定到期可登录、成功登录清零、0 = 关闭、未知邮箱同样锁定（不泄露存在性）；
- 字幕响应超时 → 504；响应体超限 / 字幕块数超限 → 400（不是 500）；
- ``_BoundedSession`` 在读取响应体时按字节上限中断；timeout 注入；
- yt-dlp 元数据/频道列表带 socket_timeout；单频道最多 200 条上限；
- 频道 URL 只允许 YouTube 频道形态（防止把 yt-dlp 引到内网/任意站点）。
"""
from types import SimpleNamespace

import pytest
import requests
import yt_dlp

import auth_lockout
import config
import routes_auth
import routes_videos
import transcripts

VIDEO_ID = "dQw4w9WgXcQ"
VALID_URL = f"https://www.youtube.com/watch?v={VIDEO_ID}"
EMAIL = "lock-me@example.com"
PASSWORD = "correct-horse-battery"

# 必须在 conftest 的 offline_guard 之前拿住真实函数（fixture 会把模块属性换成
# “禁止外部调用”的桩；测试里再临时换回来）。
_REAL_FETCH = transcripts.fetch_english_transcript
_REAL_METADATA = transcripts.get_video_metadata


@pytest.fixture(autouse=True)
def _isolate_channel_cache():
    routes_videos._channel_cache.clear()
    yield
    routes_videos._channel_cache.clear()


@pytest.fixture
def fake_clock(monkeypatch):
    """可控单调时钟：测试锁定到期不用真的 sleep 15 分钟。"""
    clock = [1000.0]
    monkeypatch.setattr(auth_lockout, "_now", lambda: clock[0])
    return clock


@pytest.fixture
def lock_settings(monkeypatch):
    """默认锁定参数 + 把旧的 60 秒/IP 限流调高，避免干扰锁定断言。"""
    monkeypatch.setattr(config, "AUTH_LOCK_THRESHOLD", 5)
    monkeypatch.setattr(config, "AUTH_LOCK_MINUTES", 15)
    monkeypatch.setattr(routes_auth, "LOGIN_MAX_FAILURES", 1000, raising=False)
    # 同样避开全局限速桶（auth 10 次/分钟），否则连续登录用例会先撞 429。
    monkeypatch.setattr(config, "RATE_LIMIT_AUTH_PER_MINUTE", 1000)


def _signup(client, email: str = EMAIL, password: str = PASSWORD):
    response = client.post(
        "/api/auth/signup", json={"email": email, "password": password}
    )
    assert response.status_code == 201, response.text


def _login(client, email: str, password: str):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def _fail_login(client, email: str, password: str, times: int = 5):
    for _ in range(times):
        response = _login(client, email, password)
        assert response.status_code == 401, response.text


# ---------------------------------------------------------------------------
# 1. 登录失败锁定
# ---------------------------------------------------------------------------


def test_account_lockout_blocks_correct_password(make_client, lock_settings, fake_clock):
    with make_client() as setup:
        _signup(setup)

    with make_client() as attacker:
        _fail_login(attacker, EMAIL, "definitely-wrong")
        locked = _login(attacker, EMAIL, PASSWORD)

    assert locked.status_code == 429, locked.text
    assert locked.headers["Retry-After"] == "900"
    assert "锁定" in locked.json()["detail"]
    assert "不存在" not in locked.json()["detail"]


def test_lockout_expires_and_allows_login_again(make_client, lock_settings, fake_clock):
    with make_client() as setup:
        _signup(setup)

    with make_client() as attacker:
        _fail_login(attacker, EMAIL, "definitely-wrong")
        assert _login(attacker, EMAIL, PASSWORD).status_code == 429

        fake_clock[0] += 15 * 60 + 1
        ok = _login(attacker, EMAIL, PASSWORD)

    assert ok.status_code == 200, ok.text
    assert ok.json()["user"]["email"] == EMAIL


def test_successful_login_clears_failures(make_client, lock_settings, fake_clock):
    with make_client() as setup:
        _signup(setup)

    with make_client() as client:
        _fail_login(client, EMAIL, "wrong-one", times=4)
        assert _login(client, EMAIL, PASSWORD).status_code == 200

        # 成功后账号与 IP 的失败计数都清零：再来 4 次也不会锁。
        _fail_login(client, EMAIL, "wrong-two", times=4)
        assert _login(client, EMAIL, PASSWORD).status_code == 200


def test_ip_lockout_blocks_other_accounts(make_client, lock_settings, fake_clock):
    with make_client() as setup:
        _signup(setup, email=EMAIL)

    # 用 5 个不同账号（含不存在的）把同一个 TestClient IP 打到锁定。
    with make_client() as attacker:
        for index in range(5):
            response = _login(attacker, f"unknown-{index}@example.com", "wrong")
            assert response.status_code == 401, response.text

    with make_client() as alice:
        locked = _login(alice, EMAIL, PASSWORD)
    assert locked.status_code == 429, locked.text
    assert int(locked.headers["Retry-After"]) >= 1


def test_account_dimension_is_independent_of_ip(lock_settings, fake_clock):
    for index in range(5):
        auth_lockout.record_failure("victim@example.com", f"198.51.100.{index}")

    status = auth_lockout.check("victim@example.com", "203.0.113.9")
    assert status is not None, "账号维度应独立于 IP 生效"
    assert "account" in status.scopes
    assert status.retry_after == 900


def test_unknown_email_locks_with_same_message(make_client, lock_settings, fake_clock):
    unknown = "nobody@example.com"
    with make_client() as client:
        _fail_login(client, unknown, "wrong")
        locked = _login(client, unknown, PASSWORD)

    assert locked.status_code == 429
    assert locked.json()["detail"] == (
        "登录尝试次数过多，已暂时锁定，请 900 秒后再试。"
    )


def test_lockout_can_be_disabled(make_client, monkeypatch, fake_clock):
    monkeypatch.setattr(config, "AUTH_LOCK_THRESHOLD", 0)
    monkeypatch.setattr(config, "AUTH_LOCK_MINUTES", 15)
    monkeypatch.setattr(routes_auth, "LOGIN_MAX_FAILURES", 1000, raising=False)
    monkeypatch.setattr(config, "RATE_LIMIT_AUTH_PER_MINUTE", 1000)
    # 同样避开全局限速桶（auth 10 次/分钟），否则连续登录用例会先撞 429。
    monkeypatch.setattr(config, "RATE_LIMIT_AUTH_PER_MINUTE", 1000)

    with make_client() as setup:
        _signup(setup)

    with make_client() as client:
        _fail_login(client, EMAIL, "wrong", times=8)
        assert _login(client, EMAIL, PASSWORD).status_code == 200


# ---------------------------------------------------------------------------
# 2. 字幕抓取边界
# ---------------------------------------------------------------------------


def _fake_transcript(count: int):
    return [
        SimpleNamespace(text=f"line {index}.", start=float(index), duration=1.0)
        for index in range(count)
    ]


class _FakeTranscriptApi:
    """替身：记录收到的 http_client，并返回预设结果/异常。"""

    result = None
    error = None
    seen_http_client = None

    def __init__(self, proxy_config=None, http_client=None):
        type(self).seen_http_client = http_client

    def fetch(self, video_id, languages=("en",)):
        if type(self).error is not None:
            raise type(self).error
        return type(self).result


def _use_real_fetch(monkeypatch):
    monkeypatch.setattr(transcripts, "fetch_english_transcript", _REAL_FETCH)
    monkeypatch.setattr(routes_videos, "fetch_english_transcript", _REAL_FETCH)


def _install_fake_api(monkeypatch, *, result=None, error=None):
    _FakeTranscriptApi.result = result
    _FakeTranscriptApi.error = error
    _FakeTranscriptApi.seen_http_client = None
    monkeypatch.setattr(transcripts, "YouTubeTranscriptApi", _FakeTranscriptApi)


def test_transcript_block_limit_returns_400(client, monkeypatch):
    _use_real_fetch(monkeypatch)
    monkeypatch.setattr(transcripts, "MAX_TRANSCRIPT_BLOCKS", 2)
    _install_fake_api(monkeypatch, result=_fake_transcript(3))

    response = client.get("/api/estimate-cost", params={"url": VALID_URL})

    assert response.status_code == 400, response.text
    assert "字幕块数超过上限" in response.json()["detail"]
    assert isinstance(_FakeTranscriptApi.seen_http_client, transcripts._BoundedSession)


def test_transcript_timeout_returns_504(client, monkeypatch):
    _use_real_fetch(monkeypatch)
    monkeypatch.setattr(transcripts, "FETCH_TIMEOUT_SECONDS", 15.0)
    _install_fake_api(monkeypatch, error=requests.Timeout("read timed out"))

    response = client.get("/api/estimate-cost", params={"url": VALID_URL})

    assert response.status_code == 504, response.text
    assert "超时" in response.json()["detail"]
    assert "15" in response.json()["detail"]


def test_transcript_oversize_maps_to_400(client, monkeypatch):
    _use_real_fetch(monkeypatch)
    monkeypatch.setattr(transcripts, "MAX_FETCH_BYTES", 5 * 1024 * 1024)
    _install_fake_api(
        monkeypatch, error=transcripts._ResponseTooLarge(5 * 1024 * 1024)
    )

    response = client.get("/api/estimate-cost", params={"url": VALID_URL})

    assert response.status_code == 400, response.text
    assert "响应体超过上限" in response.json()["detail"]


class _FakeResponse:
    def __init__(self, chunks):
        self._chunks = chunks
        self.closed = False
        self._content = None
        self._content_consumed = False

    def iter_content(self, chunk_size=64 * 1024):
        yield from self._chunks

    def close(self):
        self.closed = True


def test_bounded_session_stops_oversized_body(monkeypatch):
    monkeypatch.setattr(transcripts, "MAX_FETCH_BYTES", 10)
    response = _FakeResponse([b"123456", b"789012"])

    def fake_send(_self, _request, **kwargs):
        assert kwargs.get("stream") is True, "大小上限必须靠流式读取，不能先全读进内存"
        return response

    monkeypatch.setattr(requests.Session, "send", fake_send)

    with pytest.raises(transcripts._ResponseTooLarge):
        transcripts._BoundedSession().get("https://example.invalid/transcript")
    assert response.closed, "超限后必须立即关闭连接"


def test_bounded_session_injects_timeout(monkeypatch):
    monkeypatch.setattr(transcripts, "FETCH_TIMEOUT_SECONDS", 12.5)
    monkeypatch.setattr(transcripts, "MAX_FETCH_BYTES", 0)
    captured = {}

    def fake_send(_self, _request, **kwargs):
        captured.update(kwargs)
        return _FakeResponse([b"ok"])

    monkeypatch.setattr(requests.Session, "send", fake_send)

    transcripts._BoundedSession().get("https://example.invalid/transcript")

    assert captured["timeout"] == 12.5


# ---------------------------------------------------------------------------
# 3. yt-dlp / 频道列表边界
# ---------------------------------------------------------------------------


def test_metadata_uses_socket_timeout(monkeypatch):
    monkeypatch.setattr(transcripts, "get_video_metadata", _REAL_METADATA)
    monkeypatch.setattr(transcripts, "FETCH_TIMEOUT_SECONDS", 9.0)
    captured = {}

    class FakeYDL:
        def __init__(self, opts):
            captured.update(opts)

        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return False

        def extract_info(self, _url, download=False):
            return {
                "title": "Meta",
                "uploader": "Channel",
                "upload_date": "20260101",
                "thumbnail": "",
            }

    monkeypatch.setattr(transcripts.yt_dlp, "YoutubeDL", FakeYDL)

    metadata = transcripts.get_video_metadata(VALID_URL)

    assert captured["socket_timeout"] == 9.0
    assert metadata["title"] == "Meta"


def test_channel_videos_capped_per_channel(monkeypatch):
    monkeypatch.setattr(routes_videos, "MAX_CHANNEL_VIDEOS", 200)
    monkeypatch.setattr(routes_videos, "FETCH_TIMEOUT_SECONDS", 15.0)
    seen_opts = {}
    entries = [{"id": f"vid{index:08d}", "title": f"title {index}"} for index in range(250)]

    class FakeYDL:
        def __init__(self, opts):
            seen_opts.update(opts)

        def __enter__(self):
            return self

        def __exit__(self, *exc_info):
            return False

        def extract_info(self, _url, download=False):
            return {"uploader": "Big Channel", "entries": entries}

    monkeypatch.setattr(yt_dlp, "YoutubeDL", FakeYDL)

    updates = routes_videos._fetch_channel_videos(
        "https://www.youtube.com/@big-channel"
    )

    assert len(updates) == 200
    assert updates[0]["videoId"] == "vid00000000"
    assert updates[-1]["videoId"] == "vid00000199"
    assert seen_opts["socket_timeout"] == 15.0


# ---------------------------------------------------------------------------
# 4. 频道 URL 白名单（/api/channel-updates 不能把 yt-dlp 引到任意站点）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://www.youtube.com/@linguatrek",
        "https://youtube.com/@linguatrek/videos",
        "https://m.youtube.com/channel/UC" + "a" * 22,
        "https://www.youtube.com/c/Some_Name-1",
    ],
)
def test_validate_channel_url_accepts_youtube_forms(url):
    assert transcripts.validate_channel_url(url) == url


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example.com/@linguatrek",
        "http://169.254.169.254/latest/meta-data",
        "file:///etc/passwd",
        "https://youtube.com@evil.example.com/@linguatrek",
        "https://youtu.be/@linguatrek",
        "https://www.youtube.com/@linguatrek?next=http://evil.example.com",
    ],
)
def test_validate_channel_url_rejects_non_youtube_forms(url):
    with pytest.raises(ValueError):
        transcripts.validate_channel_url(url)


def test_channel_fetch_rejects_bad_url_without_calling_ytdlp(monkeypatch):
    routes_videos._channel_cache.clear()

    class BoomYDL:
        def __init__(self, _opts):
            raise AssertionError("非法频道 URL 不应调用 yt-dlp")

    monkeypatch.setattr(yt_dlp, "YoutubeDL", BoomYDL)

    assert routes_videos._fetch_channel_videos("http://169.254.169.254/latest/meta-data") == []
    assert routes_videos._fetch_channel_videos("file:///etc/passwd") == []
    assert routes_videos._channel_cache == {}


def test_bounded_session_maps_body_read_timeout_to_timeout(monkeypatch):
    """正文读到一半超时时 requests 包成 ConnectionError，边界层要转回 Timeout（→504）。"""
    from urllib3.exceptions import ReadTimeoutError

    monkeypatch.setattr(transcripts, "MAX_FETCH_BYTES", 1024)

    class SlowResponse(_FakeResponse):
        def iter_content(self, chunk_size=64 * 1024):
            error = requests.ConnectionError("Read timed out.")
            error.__context__ = ReadTimeoutError(None, "/transcript", "timed out")
            raise error

    def fake_send(_self, _request, **kwargs):
        return SlowResponse([])

    monkeypatch.setattr(requests.Session, "send", fake_send)

    with pytest.raises(requests.Timeout):
        transcripts._BoundedSession().get("https://example.invalid/transcript")
