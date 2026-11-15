"""自动生成英文字幕抓取 / yt-dlp 回退（全离线）。

覆盖用户需求 4：
- list() 探测轨道：手动 en 优先，其次自动生成 en；
- 只有自动 en（含 en-US / en-GB / en-orig 前缀码）也能抓；
- API 限流/无轨/超时 → yt-dlp 下载自动字幕 VTT 并解析；
- VTT 滚动重复行、行内时间标签、多行 cue 清洗；
- 确实无英文轨 422；超时 504、大小/块数超限 400；回退失败还原原错误；
- metadata 与缓存 payload 带 auto_generated / subtitle_source。

所有 YouTube / yt-dlp 调用都被替换成假实现；conftest 的 offline_guard 还会
在别的用例里把真实抓取函数换成断言桩。
"""
import json
from pathlib import Path

import pytest
import requests
import yt_dlp

import llm
import routes_videos
import transcripts

VIDEO_ID = "autoSubs001"
URL = f"https://www.youtube.com/watch?v={VIDEO_ID}"

# conftest 的 offline_guard 会把模块属性换成断言桩；先在 import 时拿住真函数。
_REAL_FETCH = transcripts.fetch_english_transcript

METADATA = {
    "title": "Auto Subtitle Video",
    "channel": "Auto Channel",
    "upload_date": "20260101",
    "thumbnail": "",
}


class _FakeSnippet:
    def __init__(self, text, start=0.0, duration=1.0):
        self.text = text
        self.start = start
        self.duration = duration


class _FakeTrack:
    """youtube-transcript-api 的 Transcript 替身。"""

    def __init__(self, language_code, snippets=(), *, generated=False, error=None):
        self.language_code = language_code
        self.language = language_code
        self.is_generated = generated
        self.snippets = list(snippets)
        self.error = error
        self.fetched = False

    def fetch(self, preserve_formatting=False):
        self.fetched = True
        if self.error is not None:
            raise self.error
        return list(self.snippets)


class _FakeTranscriptApi:
    tracks = []
    list_error = None

    def __init__(self, proxy_config=None, http_client=None):
        self.http_client = http_client

    def list(self, video_id):
        if type(self).list_error is not None:
            raise type(self).list_error
        return list(type(self).tracks)


class _FakeYoutubeDL:
    """yt-dlp 替身：第一实例返回 track 元数据，第二实例把 VTT 写到 outtmpl。"""

    info = {}
    vtt = ""
    extract_error = None
    download_error = None
    opts_seen = []
    downloads = 0

    def __init__(self, opts):
        self.opts = opts
        type(self).opts_seen.append(dict(opts))

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def extract_info(self, url, download=False):
        if type(self).extract_error is not None:
            raise type(self).extract_error
        return dict(type(self).info)

    def download(self, urls):
        type(self).downloads += 1
        if type(self).download_error is not None:
            raise type(self).download_error
        language = self.opts.get("subtitleslangs", ["en"])[0]
        outtmpl = self.opts["outtmpl"]
        path = outtmpl.replace("%(id)s", VIDEO_ID).replace(
            "%(ext)s", f"{language}.vtt"
        )
        Path(path).write_text(type(self).vtt, encoding="utf-8")


@pytest.fixture(autouse=True)
def _offline_fakes(monkeypatch):
    """每个用例都用假 API / 假 yt-dlp；需要真实函数时显式换回。"""
    monkeypatch.setattr(transcripts, "fetch_english_transcript", _REAL_FETCH)
    _FakeTranscriptApi.tracks = []
    _FakeTranscriptApi.list_error = None
    monkeypatch.setattr(transcripts, "YouTubeTranscriptApi", _FakeTranscriptApi)

    _FakeYoutubeDL.info = {}
    _FakeYoutubeDL.vtt = ""
    _FakeYoutubeDL.extract_error = None
    _FakeYoutubeDL.download_error = None
    _FakeYoutubeDL.opts_seen = []
    _FakeYoutubeDL.downloads = 0
    monkeypatch.setattr(yt_dlp, "YoutubeDL", _FakeYoutubeDL)


def _fetch_error() -> transcripts.HTTPException:
    with pytest.raises(transcripts.HTTPException) as exc_info:
        transcripts.fetch_english_transcript(VIDEO_ID)
    return exc_info.value


# ---------------------------------------------------------------------------
# 1. list() 轨道选择
# ---------------------------------------------------------------------------


def test_manual_en_preferred_over_auto():
    manual = _FakeTrack("en", [_FakeSnippet("Manual line.")], generated=False)
    auto = _FakeTrack("en", [_FakeSnippet("Auto line.")], generated=True)
    _FakeTranscriptApi.tracks = [auto, manual]

    result = transcripts.fetch_english_transcript(VIDEO_ID)

    assert [snippet.text for snippet in result] == ["Manual line."]
    assert result.subtitle_source == "manual"
    assert result.auto_generated is False
    assert manual.fetched is True
    assert auto.fetched is False, "手动轨存在时不应抓自动轨"


def test_manual_variant_preferred_over_auto_en():
    manual = _FakeTrack("en-US", [_FakeSnippet("Manual US.")], generated=False)
    auto = _FakeTrack("en", [_FakeSnippet("Auto.")], generated=True)
    _FakeTranscriptApi.tracks = [auto, manual]

    result = transcripts.fetch_english_transcript(VIDEO_ID)

    assert [snippet.text for snippet in result] == ["Manual US."]
    assert result.subtitle_source == "manual"


def test_only_auto_en_is_allowed():
    auto = _FakeTrack("en", [_FakeSnippet("Auto only.")], generated=True)
    _FakeTranscriptApi.tracks = [auto]

    result = transcripts.fetch_english_transcript(VIDEO_ID)

    assert [snippet.text for snippet in result] == ["Auto only."]
    assert result.subtitle_source == "auto"
    assert result.auto_generated is True


@pytest.mark.parametrize("language_code", ["en-US", "en-GB", "en-orig", "en-auto"])
def test_auto_english_prefix_codes_match(language_code):
    """旧 fetch(['en']) 只做精确匹配；en-* 自动轨必须靠 list() 前缀匹配。"""
    auto = _FakeTrack(
        language_code, [_FakeSnippet(f"Auto {language_code}.")], generated=True
    )
    _FakeTranscriptApi.tracks = [auto]

    result = transcripts.fetch_english_transcript(VIDEO_ID)

    assert [snippet.text for snippet in result] == [f"Auto {language_code}."]
    assert result.subtitle_source == "auto"
    assert result.auto_generated is True
    assert auto.fetched is True


# ---------------------------------------------------------------------------
# 2. yt-dlp 回退
# ---------------------------------------------------------------------------

ROLLING_VTT = """WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.000
Hello<00:00:00.500><c> world</c>

00:00:02.000 --> 00:00:02.010
Hello world

00:00:02.010 --> 00:00:04.000
Hello world
This is the next sentence.
"""


def test_api_blocked_falls_back_to_ytdlp_and_parses_vtt():
    _FakeTranscriptApi.list_error = transcripts.RequestBlocked(VIDEO_ID)
    _FakeYoutubeDL.info = {
        "subtitles": {},
        "automatic_captions": {"en-orig": [{"ext": "vtt"}]},
    }
    _FakeYoutubeDL.vtt = ROLLING_VTT

    result = transcripts.fetch_english_transcript(VIDEO_ID)

    assert [snippet.text for snippet in result] == [
        "Hello world",
        "This is the next sentence.",
    ]
    assert result.subtitle_source == "auto-ytdlp"
    assert result.auto_generated is True
    assert _FakeYoutubeDL.downloads == 1

    download_opts = next(
        opts for opts in _FakeYoutubeDL.opts_seen if "outtmpl" in opts
    )
    assert download_opts["writeautomaticsub"] is True
    assert download_opts["writesubtitles"] is False
    assert download_opts["subtitleslangs"] == ["en-orig"]
    assert download_opts["subtitlesformat"] == "vtt"
    assert download_opts["skip_download"] is True


def test_api_no_transcript_found_falls_back_to_ytdlp():
    _FakeTranscriptApi.list_error = transcripts.NoTranscriptFound(
        VIDEO_ID, ["en"], None
    )
    _FakeYoutubeDL.info = {
        "subtitles": {},
        "automatic_captions": {"en": [{"ext": "vtt"}]},
    }
    _FakeYoutubeDL.vtt = ROLLING_VTT

    result = transcripts.fetch_english_transcript(VIDEO_ID)

    assert [snippet.text for snippet in result] == [
        "Hello world",
        "This is the next sentence.",
    ]
    assert result.subtitle_source == "auto-ytdlp"


def test_no_en_track_in_api_but_ytdlp_auto_works():
    _FakeTranscriptApi.tracks = [
        _FakeTrack("de", [_FakeSnippet("Deutsch.")], generated=False)
    ]
    _FakeYoutubeDL.info = {
        "subtitles": {"de": [{"ext": "vtt"}]},
        "automatic_captions": {"en": [{"ext": "vtt"}]},
    }
    _FakeYoutubeDL.vtt = ROLLING_VTT

    result = transcripts.fetch_english_transcript(VIDEO_ID)

    assert [snippet.text for snippet in result] == [
        "Hello world",
        "This is the next sentence.",
    ]
    assert result.subtitle_source == "auto-ytdlp"


def test_ytdlp_manual_track_is_marked_manual_ytdlp():
    _FakeTranscriptApi.list_error = requests.Timeout("api timeout")
    _FakeYoutubeDL.info = {
        "subtitles": {"en": [{"ext": "vtt"}]},
        "automatic_captions": {},
    }
    _FakeYoutubeDL.vtt = ROLLING_VTT

    result = transcripts.fetch_english_transcript(VIDEO_ID)

    assert result.subtitle_source == "manual-ytdlp"
    assert result.auto_generated is False
    download_opts = next(
        opts for opts in _FakeYoutubeDL.opts_seen if "outtmpl" in opts
    )
    assert download_opts["writesubtitles"] is True
    assert download_opts["writeautomaticsub"] is False


def test_no_english_track_anywhere_returns_422():
    _FakeTranscriptApi.tracks = [
        _FakeTrack("de", [_FakeSnippet("Deutsch.")], generated=False)
    ]
    _FakeYoutubeDL.info = {
        "subtitles": {"de": [{"ext": "vtt"}]},
        "automatic_captions": {"de": [{"ext": "vtt"}]},
    }

    error = _fetch_error()

    assert error.status_code == 422
    assert "含自动生成" in error.detail
    assert _FakeYoutubeDL.downloads == 0


def test_ytdlp_failure_restores_original_api_error():
    _FakeTranscriptApi.list_error = transcripts.RequestBlocked(VIDEO_ID)
    _FakeYoutubeDL.extract_error = RuntimeError("yt-dlp boom")

    error = _fetch_error()

    assert error.status_code == 429, "回退失败应还原 API 的限流错误，而不是 502"
    assert "限制" in error.detail


def test_api_timeout_with_failed_fallback_returns_504():
    _FakeTranscriptApi.list_error = requests.Timeout("read timed out")
    _FakeYoutubeDL.extract_error = RuntimeError("yt-dlp down")

    error = _fetch_error()

    assert error.status_code == 504


def test_api_oversize_does_not_fall_back():
    _FakeTranscriptApi.list_error = transcripts._ResponseTooLarge(10)
    _FakeYoutubeDL.extract_error = AssertionError("超限时不应再下载一遍字幕")

    error = _fetch_error()

    assert error.status_code == 400
    assert "响应体超过上限" in error.detail


def test_auto_transcript_block_limit_returns_400(monkeypatch):
    monkeypatch.setattr(transcripts, "MAX_TRANSCRIPT_BLOCKS", 2)
    _FakeTranscriptApi.tracks = [
        _FakeTrack(
            "en",
            [_FakeSnippet(f"line {index}.") for index in range(3)],
            generated=True,
        )
    ]

    error = _fetch_error()

    assert error.status_code == 400
    assert "字幕块数超过上限" in error.detail


# ---------------------------------------------------------------------------
# 3. WebVTT 解析
# ---------------------------------------------------------------------------


def test_parse_vtt_dedupes_rolling_lines_and_inline_tags():
    content = """WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.000
Hello<00:00:00.500><c> world</c>

00:00:02.000 --> 00:00:02.010
Hello world

00:00:02.010 --> 00:00:04.000
Hello world
Tom &amp; Jerry<00:00:03.000><c> are</c> here.

00:00:04.000 --> 00:00:06.000
Tom & Jerry are here.
Second line of the same cue.

00:00:06.000 --> 00:00:08.000
A brand new line
and another brand new line
"""

    cues = transcripts.parse_vtt(content)

    assert [cue["text"] for cue in cues] == [
        "Hello world",
        "Tom & Jerry are here.",
        "Second line of the same cue.",
        "A brand new line and another brand new line",
    ]
    assert cues[0]["start"] == 0.0
    assert cues[0]["end"] == 2.0
    assert "<" not in cues[1]["text"]
    assert "&amp;" not in cues[1]["text"]


def test_parse_vtt_handles_settings_and_mm_ss_timestamps():
    content = """WEBVTT

00:01.000 --> 00:03.000 align:start position:0%
First cue.

00:03.000 --> 00:05.000
Second cue.
"""

    cues = transcripts.parse_vtt(content)

    assert [cue["text"] for cue in cues] == ["First cue.", "Second cue."]
    assert cues[0]["start"] == 1.0
    assert cues[1]["end"] == 5.0


# ---------------------------------------------------------------------------
# 4. metadata / 缓存 payload
# ---------------------------------------------------------------------------


def _auto_transcript(text="Hello world."):
    return transcripts.EnglishTranscript(
        [_FakeSnippet(text, 0.0, 1.0)], subtitle_source="auto"
    )


def test_estimate_metadata_carries_auto_generated(client, monkeypatch):
    monkeypatch.setattr(
        routes_videos, "fetch_english_transcript", lambda _video_id: _auto_transcript()
    )
    monkeypatch.setattr(
        routes_videos, "get_video_metadata", lambda _url: dict(METADATA)
    )

    response = client.get("/api/estimate-cost", params={"url": URL})

    assert response.status_code == 200, response.text
    metadata = response.json()["metadata"]
    assert metadata["auto_generated"] is True
    assert metadata["subtitle_source"] == "auto"


def _mock_llm(monkeypatch):
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)
    monkeypatch.setattr(
        llm,
        "generate_json",
        lambda prompt, model=None: json.dumps(
            {"blocks": [{"id": 1, "zh_text": "你好，世界。", "highlights": []}]},
            ensure_ascii=False,
        ),
    )
    monkeypatch.setattr(llm, "generate_text", lambda prompt, model=None: "测试总结。")


def test_process_video_cache_payload_carries_auto_generated(
    client, history_dir, monkeypatch
):
    monkeypatch.setattr(
        routes_videos, "fetch_english_transcript", lambda _video_id: _auto_transcript()
    )
    monkeypatch.setattr(
        routes_videos, "get_video_metadata", lambda _url: dict(METADATA)
    )
    _mock_llm(monkeypatch)

    response = client.post(
        "/api/process-video", json={"url": URL, "model": "deepseek-chat"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["metadata"]["auto_generated"] is True

    files = list(history_dir.glob("*.json"))
    assert len(files) == 1
    saved = json.loads(files[0].read_text(encoding="utf-8"))
    assert saved["metadata"]["auto_generated"] is True
    assert saved["metadata"]["subtitle_source"] == "auto"


def test_stream_meta_carries_auto_generated(client, monkeypatch):
    monkeypatch.setattr(
        routes_videos, "fetch_english_transcript", lambda _video_id: _auto_transcript()
    )
    monkeypatch.setattr(
        routes_videos, "get_video_metadata", lambda _url: dict(METADATA)
    )
    _mock_llm(monkeypatch)

    with client.stream(
        "POST",
        "/api/process-video-stream",
        json={"url": URL, "model": "deepseek-chat"},
    ) as response:
        assert response.status_code == 200
        lines = list(response.iter_lines())

    meta_payload = None
    current_event = None
    for line in lines:
        if line.startswith("event: "):
            current_event = line.split(": ", 1)[1]
        elif line.startswith("data: ") and current_event == "meta":
            meta_payload = json.loads(line[len("data: "):])
            break

    assert meta_payload is not None
    assert meta_payload["metadata"]["auto_generated"] is True
    assert meta_payload["metadata"]["subtitle_source"] == "auto"
