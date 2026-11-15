"""字幕获取与切句：YouTube 字幕（手动/自动 + yt-dlp 回退）、yt-dlp 元数据、
SRT/VTT 解析、Whisper 转写兜底。

产出统一的"片段"结构（text/start/duration 或 start/end），
供 translate.py 分批翻译。
"""
import datetime
import html
import os
import re
import tempfile
from dataclasses import dataclass
from urllib.parse import parse_qs, urlsplit

import requests
import yt_dlp
from urllib3.exceptions import ReadTimeoutError as _Urllib3ReadTimeoutError
from fastapi import HTTPException
from youtube_transcript_api import (
    YouTubeTranscriptApi,
    TranscriptsDisabled,
    NoTranscriptFound,
    VideoUnavailable,
    IpBlocked,
    RequestBlocked,
)

from config import FETCH_TIMEOUT_SECONDS, MAX_FETCH_BYTES, MAX_TRANSCRIPT_BLOCKS


# YouTube videoId 固定 11 位 base64url 字符；白名单锚定（计划书 §7.6）：
# 只接受 youtube.com/watch、youtu.be、youtube.com/embed、youtube.com/shorts 四种
# 形态。**不做 re.search 子串匹配**——那会把 `https://evil.com/youtu.be/ID` 也
# 当成合法链接。
_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_ALLOWED_HOSTS = frozenset(
    {
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "youtu.be",
        "www.youtu.be",
        "m.youtu.be",
    }
)
_MAX_URL_LENGTH = 2048
# 控制字符/换行不只破坏解析，也常被用来夹带第二个 URL；
# 反斜杠在浏览器与部分客户端里等价于 `/`，统一拒绝。
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")


def _validate_video_id(candidate: str) -> str:
    if not _VIDEO_ID_RE.fullmatch(candidate or ""):
        raise ValueError("Invalid YouTube URL")
    return candidate


def extract_video_id(url: str) -> str:
    """从 YouTube 链接取出 11 位 videoId；不合法一律抛 ``ValueError``。

    接受的锚定形态（scheme 可省略，仅 http/https；主机仅 youtube.com 及
    www./m. 前缀、youtu.be 及 www./m. 前缀）：

    - ``https://www.youtube.com/watch?v=<id>``（可带其它 query）
    - ``https://youtu.be/<id>``（可带 ``?si=…``）
    - ``https://www.youtube.com/embed/<id>``
    - ``https://www.youtube.com/shorts/<id>``

    明确拒绝：userinfo（``http://user@youtube.com``）、非 http(s) scheme、
    显式端口、多个/空 ``v``、非 11 位/含非法字符的 id、把 YouTube 链接藏在
    其它域名/路径里的字符串。路由层把 ``ValueError`` 转成 400。
    """
    if not isinstance(url, str):
        raise ValueError("Invalid YouTube URL")
    candidate = url.strip()
    if not candidate or len(candidate) > _MAX_URL_LENGTH:
        raise ValueError("Invalid YouTube URL")
    if _CONTROL_CHARS_RE.search(candidate) or "\\" in candidate:
        raise ValueError("Invalid YouTube URL")
    # 协议相对 URL（//youtu.be/...）没有明确 scheme，按白名单拒绝。
    if candidate.startswith("//"):
        raise ValueError("Invalid YouTube URL")
    if "://" not in candidate:
        candidate = "https://" + candidate

    parsed = urlsplit(candidate)  # 非法 IPv6 等会抛 ValueError，由调用方转 400
    if parsed.scheme.lower() not in ("http", "https"):
        raise ValueError("Invalid YouTube URL")
    # userinfo 是最常见的「看起来是 YouTube、其实不是」绕过手法。
    if not parsed.netloc or "@" in parsed.netloc:
        raise ValueError("Invalid YouTube URL")
    try:
        port = parsed.port
    except ValueError:
        raise ValueError("Invalid YouTube URL") from None
    if port is not None:
        raise ValueError("Invalid YouTube URL")
    host = (parsed.hostname or "").lower()
    if host not in _ALLOWED_HOSTS:
        raise ValueError("Invalid YouTube URL")

    if host.endswith("youtu.be"):
        path_parts = [part for part in parsed.path.split("/") if part]
        if len(path_parts) != 1:
            raise ValueError("Invalid YouTube URL")
        return _validate_video_id(path_parts[0])

    if parsed.path == "/watch":
        values = parse_qs(parsed.query, keep_blank_values=True).get("v", [])
        if len(values) != 1:
            raise ValueError("Invalid YouTube URL")
        return _validate_video_id(values[0])

    path_parts = [part for part in parsed.path.split("/") if part]
    if len(path_parts) == 2 and path_parts[0] in ("embed", "shorts"):
        return _validate_video_id(path_parts[1])

    raise ValueError("Invalid YouTube URL")


# 频道 URL 也来自客户端（订阅列表），同样只能交给 yt-dlp 抓取 YouTube 自身。
# 这里复用视频白名单的主机集合，但 youtu.be 没有频道路径，故排除。
_CHANNEL_ALLOWED_HOSTS = frozenset({"youtube.com", "www.youtube.com", "m.youtube.com"})
_CHANNEL_HANDLE_RE = re.compile(r"^@[A-Za-z0-9._-]{1,100}$")
_CHANNEL_ID_RE = re.compile(r"^UC[A-Za-z0-9_-]{22}$")
_CHANNEL_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
_CHANNEL_TABS = frozenset({"videos"})


def _valid_channel_path(parts: list[str]) -> bool:
    """只接受 /@handle、/channel/UC…、/c/name、/user/name（可选 /videos）。"""
    if not parts:
        return False
    if parts[0].startswith("@"):
        valid = bool(_CHANNEL_HANDLE_RE.fullmatch(parts[0]))
        rest = parts[1:]
    elif parts[0] == "channel" and len(parts) >= 2:
        valid = bool(_CHANNEL_ID_RE.fullmatch(parts[1]))
        rest = parts[2:]
    elif parts[0] in ("c", "user") and len(parts) >= 2:
        valid = bool(_CHANNEL_NAME_RE.fullmatch(parts[1]))
        rest = parts[2:]
    else:
        return False
    if not valid:
        return False
    return not rest or (len(rest) == 1 and rest[0] in _CHANNEL_TABS)


def validate_channel_url(url: str) -> str:
    """校验 `/api/channel-updates` 交给 yt-dlp 的频道 URL；不合法抛 ``ValueError``。

    与视频 URL 用同一套「锚定主机」思路：只允许 http/https + YouTube 主机 +
    已知频道路径，拒绝 userinfo、显式端口、query/fragment、控制字符/反斜杠与
    其它域名。这样 `/api/channel-updates` 的 ``channels`` 就不能把 yt-dlp
    引到内网/``file://``/任意站点（计划书 §7.6 的抓取面）。
    """
    if not isinstance(url, str):
        raise ValueError("Invalid YouTube channel URL")
    candidate = url.strip()
    if not candidate or len(candidate) > _MAX_URL_LENGTH:
        raise ValueError("Invalid YouTube channel URL")
    if _CONTROL_CHARS_RE.search(candidate) or "\\" in candidate:
        raise ValueError("Invalid YouTube channel URL")
    if candidate.startswith("//"):
        raise ValueError("Invalid YouTube channel URL")
    if "://" not in candidate:
        candidate = "https://" + candidate

    parsed = urlsplit(candidate)
    if parsed.scheme.lower() not in ("http", "https"):
        raise ValueError("Invalid YouTube channel URL")
    if not parsed.netloc or "@" in parsed.netloc:
        raise ValueError("Invalid YouTube channel URL")
    try:
        port = parsed.port
    except ValueError:
        raise ValueError("Invalid YouTube channel URL") from None
    if port is not None:
        raise ValueError("Invalid YouTube channel URL")
    host = (parsed.hostname or "").lower()
    if host not in _CHANNEL_ALLOWED_HOSTS:
        raise ValueError("Invalid YouTube channel URL")
    if parsed.query or parsed.fragment:
        raise ValueError("Invalid YouTube channel URL")
    path_parts = [part for part in parsed.path.split("/") if part]
    if not _valid_channel_path(path_parts):
        raise ValueError("Invalid YouTube channel URL")
    return candidate


def canonical_watch_url(video_id: str) -> str:
    """把校验过的 videoId 还原成唯一规范的 watch URL。

    下游 yt-dlp（元数据/Whisper 下载）只接收这个重建后的 URL，不接收用户
    原始输入：即使原链接带 ``list=`` 播放列表等参数，也不会被当成播放列表抓取。
    """
    return f"https://www.youtube.com/watch?v={_validate_video_id(video_id)}"


# ====================================================
# 英文字幕来源：手动 / 自动生成 / yt-dlp 回退
# ====================================================
#
# 用户需求：只要视频有**自动生成的英文字幕**就允许播放。youtube-transcript-api
# 的 ``fetch(languages=['en'])`` 只做精确语言码匹配，遇到 ``en-US`` / ``en-GB`` /
# ``en-orig`` 就会误报 NoTranscriptFound；被限流时也会直接失败。因此抓取分两层：
#   1. ``list()`` 探测轨道：手动 en 优先，其次自动生成 en（``en`` 前缀匹配）；
#   2. API 失败（无轨/限流/超时等）→ yt-dlp 下载自动字幕并解析 WebVTT。
# 返回值带 ``subtitle_source`` / ``auto_generated``，由路由写进 metadata 缓存。

# 精确码优先于区域码；``en-orig`` 是原声自动轨，通常比机翻的 en-US/en-GB 更准。
_EN_LANG_PREFERENCE = {"en": 0, "en-orig": 1, "en-us": 2, "en-gb": 3}


def _english_language_rank(language_code: str | None) -> int | None:
    """``en`` 前缀语言码 → 优先级数字；不是英文轨返回 ``None``。"""
    code = (language_code or "").strip().lower()
    if code != "en" and not code.startswith("en-"):
        return None
    return _EN_LANG_PREFERENCE.get(code, 4)


@dataclass(frozen=True)
class _Snippet:
    """yt-dlp 解析出的字幕片段；与 FetchedTranscriptSnippet 同形（text/start/duration）。"""

    text: str
    start: float
    duration: float


class EnglishTranscript(list):
    """字幕片段列表 + 来源标记（list 子类，调用方按原方式迭代/取长度）。

    - ``subtitle_source``：``manual`` / ``auto``（API）/ ``manual-ytdlp`` /
      ``auto-ytdlp``（yt-dlp 回退）；
    - ``auto_generated``：是否自动生成字幕；UI 可据此显示「自动生成字幕」。
    """

    def __init__(
        self,
        snippets,
        *,
        subtitle_source: str,
        auto_generated: bool | None = None,
    ):
        super().__init__(snippets)
        self.subtitle_source = subtitle_source
        self.auto_generated = (
            subtitle_source in ("auto", "auto-ytdlp")
            if auto_generated is None
            else bool(auto_generated)
        )


class _NoEnglishTranscript(Exception):
    """轨道列表 / yt-dlp 元数据里确实没有任何英文字幕轨。"""


def _pick_english_track(tracks) -> object | None:
    """从 ``YouTubeTranscriptApi.list()`` 的轨道里选手动 en，其次自动 en。

    手动轨整体优先于自动轨；同类里按 ``_EN_LANG_PREFERENCE`` 取最具体的
    ``language_code``。没有英文轨返回 ``None``（由调用方决定是否回退）。
    """
    manual: list[tuple[int, object]] = []
    generated: list[tuple[int, object]] = []
    for track in tracks:
        rank = _english_language_rank(getattr(track, "language_code", None))
        if rank is None:
            continue
        bucket = generated if getattr(track, "is_generated", False) else manual
        bucket.append((rank, track))
    if manual:
        return min(manual, key=lambda item: item[0])[1]
    if generated:
        return min(generated, key=lambda item: item[0])[1]
    return None


def _fetch_with_track_list(api, video_id: str) -> EnglishTranscript:
    """``list()`` 探测 + 用具体 language_code 对应的轨道 ``fetch()``。"""
    track = _pick_english_track(api.list(video_id))
    if track is None:
        raise _NoEnglishTranscript(f"{video_id}: no English caption track")
    # 直接 fetch 探测到的轨道：不再调一次 list()，也避免 fetch(['en']) 的
    # 精确匹配把 en-US/en-orig 漏掉；仍受同一个 _BoundedSession 超时/大小上限约束。
    fetched = track.fetch()
    source = "auto" if getattr(track, "is_generated", False) else "manual"
    return EnglishTranscript(fetched, subtitle_source=source)


def _fetch_legacy_api(api, video_id: str) -> EnglishTranscript:
    """旧版 youtube-transcript-api（没有 ``list()``）的兼容路径。"""
    fetched = api.fetch(video_id, languages=["en"])
    source = "auto" if getattr(fetched, "is_generated", False) else "manual"
    return EnglishTranscript(fetched, subtitle_source=source)


# ====================================================
# 抓取边界：超时与响应体大小上限（M1 ⑦ 残余项）
# ====================================================

class _ResponseTooLarge(Exception):
    """HTTP 响应体超过 ``MAX_FETCH_BYTES``。"""

    def __init__(self, limit: int):
        self.limit = limit
        super().__init__(f"response body exceeds {limit} bytes")


class _BoundedSession(requests.Session):
    """给 youtube-transcript-api 用的 requests.Session：

    - 所有请求注入 ``FETCH_TIMEOUT_SECONDS`` 的 connect/read 超时；
    - 读取响应体时按 ``MAX_FETCH_BYTES`` 分块计数，超限立即失败——不会先把
      整个响应读进内存再检查（否则大小上限就失去意义）。
    """

    def request(self, method, url, **kwargs):
        if FETCH_TIMEOUT_SECONDS > 0:
            kwargs.setdefault("timeout", FETCH_TIMEOUT_SECONDS)
        return super().request(method, url, **kwargs)

    def send(self, request, **kwargs):
        limit = MAX_FETCH_BYTES
        if limit <= 0:
            return super().send(request, **kwargs)
        # 强制流式读取；requests 默认会在 adapter 里把整个 body 读完。
        kwargs["stream"] = True
        response = super().send(request, **kwargs)
        try:
            chunks = []
            total = 0
            for chunk in response.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > limit:
                    raise _ResponseTooLarge(limit)
                chunks.append(chunk)
            response._content = b"".join(chunks)  # noqa: SLF001 - 让 .text/.json() 复用已读内容
            response._content_consumed = True
            return response
        except requests.exceptions.ConnectionError as exc:
            # 正文读到一半超时：requests 会把 urllib3 的 ReadTimeoutError 包成
            # ConnectionError；转回 requests.Timeout，路由才能稳定映射 504。
            if isinstance(exc.__context__, _Urllib3ReadTimeoutError) or "timed out" in str(exc).lower():
                raise requests.Timeout(str(exc)) from exc
            raise
        finally:
            response.close()


def _format_bytes(value: int) -> str:
    if value >= 1024 * 1024 and value % (1024 * 1024) == 0:
        return f"{value // (1024 * 1024)} MB"
    return f"{value} 字节"


def _split_at_sentence_boundaries(text: str) -> list:
    """Split text at sentence boundaries: .!? followed by a space and uppercase letter."""
    parts = []
    last = 0
    for m in re.finditer(r'[.!?]\s+(?=[A-Z])', text):
        end = m.start() + 1  # include the .!? character
        parts.append(text[last:end])
        last = m.end()  # skip the whitespace
    parts.append(text[last:])
    return [p for p in parts if p.strip()]


def group_transcript_blocks(transcript: list) -> list:
    """Group short transcript snippets into complete sentences.

    Two-phase approach:
    1. Split each raw snippet at internal sentence boundaries (e.g. "okay. Most" -> "okay." + "Most")
    2. Accumulate sub-snippets until we hit a sentence-ending boundary.
    3. Safety cutoff at 300 chars with intelligent clause-boundary splitting.
    """
    # Phase 1: Split raw snippets at internal sentence boundaries
    split_items = []

    for item in transcript:
        text = item.text.replace('\n', ' ') if hasattr(item, 'text') else item['text'].replace('\n', ' ')
        start = item.start if hasattr(item, 'start') else item['start']
        duration = item.duration if hasattr(item, 'duration') else item['duration']

        parts = _split_at_sentence_boundaries(text)

        if len(parts) <= 1:
            split_items.append({"text": text, "start": start, "duration": duration, "end": start + duration})
        else:
            total_chars = sum(len(p) for p in parts)
            current_start = start
            for p in parts:
                frac = len(p) / total_chars if total_chars > 0 else 1
                part_dur = duration * frac
                split_items.append({"text": p, "start": current_start, "duration": part_dur, "end": current_start + part_dur})
                current_start += part_dur

    # Phase 2: Accumulate split items into sentence blocks
    blocks = []
    current_block = None

    for i, item in enumerate(split_items):
        text = item["text"]

        if current_block is None:
            current_block = {"start": item["start"], "end": item["end"], "text": text}
        else:
            current_block["text"] += " " + text
            current_block["end"] = item["end"]

        text_so_far = current_block["text"].strip()
        text_len = len(text_so_far)

        # Primary: sentence-ending punctuation
        if re.search(r'[.!?]\s*$', text_so_far):
            blocks.append(current_block)
            current_block = None
            continue

        # Secondary: natural boundaries (only if enough text accumulated)
        has_long_pause = False
        if i + 1 < len(split_items):
            if split_items[i+1]["start"] - item["end"] > 1.2:
                has_long_pause = True

        starts_new_sentence = False
        if i + 1 < len(split_items):
            next_text = split_items[i+1]["text"].strip()
            if next_text and next_text[0].isupper():
                starts_new_sentence = True

        if text_len > 60 and (has_long_pause or starts_new_sentence):
            blocks.append(current_block)
            current_block = None
            continue

        # Safety cutoff at 300 chars
        if text_len > 300:
            best_break = -1
            for sep in [', and ', ', but ', ', so ', '; ', ', ']:
                pos = text_so_far.rfind(sep, text_len // 3)
                if pos > best_break:
                    best_break = pos + len(sep)

            if best_break > text_len // 3:
                first_part = text_so_far[:best_break].strip()
                remainder = text_so_far[best_break:].strip()
                blocks.append({"start": current_block["start"], "end": current_block["end"], "text": first_part})
                current_block = {"start": current_block["end"], "end": current_block["end"], "text": remainder} if remainder else None
            else:
                blocks.append(current_block)
                current_block = None

    if current_block:
        blocks.append(current_block)

    return blocks


def _ytdlp_caption_opts() -> dict:
    """yt-dlp 公共选项：静音、不下载媒体、带 socket 超时。"""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "skip_download": True,
    }
    if FETCH_TIMEOUT_SECONDS > 0:
        opts["socket_timeout"] = FETCH_TIMEOUT_SECONDS
    return opts


def _ranked_english_caption_codes(captions) -> list[str]:
    """yt-dlp ``subtitles`` / ``automatic_captions`` 里的英文语言码，按优先级排序。"""
    ranked: list[tuple[int, str]] = []
    for code in (captions or {}):
        rank = _english_language_rank(code)
        if rank is not None:
            ranked.append((rank, code))
    return [code for _rank, code in sorted(ranked, key=lambda item: (item[0], item[1]))]


def _select_ytdlp_caption(info: dict) -> tuple[str, str] | None:
    """从 yt-dlp 元数据选英文轨：手动优先，其次自动；返回 (语言码, manual/auto)。"""
    if not isinstance(info, dict):
        return None
    manual = _ranked_english_caption_codes(info.get("subtitles"))
    if manual:
        return manual[0], "manual"
    automatic = _ranked_english_caption_codes(info.get("automatic_captions"))
    if automatic:
        return automatic[0], "auto"
    return None


def _find_downloaded_vtt(tmpdir: str, language_code: str) -> str | None:
    """在临时目录找 yt-dlp 写出的 VTT；优先语言码精确匹配，再放宽到 en。"""
    paths = sorted(
        os.path.join(tmpdir, name)
        for name in os.listdir(tmpdir)
        if name.lower().endswith(".vtt")
    )
    if not paths:
        return None
    marker = f".{language_code.lower()}."
    for path in paths:
        if marker in os.path.basename(path).lower():
            return path
    for path in paths:
        if ".en" in os.path.basename(path).lower():
            return path
    return paths[0]


def _fetch_english_transcript_with_ytdlp(video_id: str) -> EnglishTranscript:
    """youtube-transcript-api 失败后的回退：用 yt-dlp 下载英文（自动）字幕。

    先 ``extract_info(download=False)`` 看 ``subtitles`` / ``automatic_captions``
    选轨；再 ``download=True``（``skip_download`` 只写字幕）+ ``writeautomaticsub``
    下载 VTT 到临时目录，解析后返回与 API 同形的片段列表。
    """
    url = canonical_watch_url(video_id)

    with yt_dlp.YoutubeDL(_ytdlp_caption_opts()) as ydl:
        info = ydl.extract_info(url, download=False) or {}
    selected = _select_ytdlp_caption(info)
    if selected is None:
        raise _NoEnglishTranscript(f"{video_id}: no English caption track in yt-dlp")
    language_code, kind = selected

    with tempfile.TemporaryDirectory(prefix="linguatrek-subs-") as tmpdir:
        opts = _ytdlp_caption_opts()
        opts.update(
            {
                # 选中的是手动轨就只要 subtitles，是自动轨就只要自动字幕；
                # 不让同名两种轨互相覆盖，来源标记才可信。
                "writesubtitles": kind == "manual",
                "writeautomaticsub": kind == "auto",
                "subtitleslangs": [language_code],
                "subtitlesformat": "vtt",
                "outtmpl": os.path.join(tmpdir, "%(id)s.%(ext)s"),
            }
        )
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([url])

        path = _find_downloaded_vtt(tmpdir, language_code)
        if path is None:
            raise RuntimeError("yt-dlp 未写出任何 VTT 字幕文件")
        if MAX_FETCH_BYTES > 0:
            actual_size = os.path.getsize(path)
            if actual_size > MAX_FETCH_BYTES:
                raise _ResponseTooLarge(MAX_FETCH_BYTES)
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()

    cues = parse_vtt(content)
    snippets = [
        _Snippet(
            text=cue["text"],
            start=float(cue["start"]),
            duration=max(0.0, float(cue["end"]) - float(cue["start"])),
        )
        for cue in cues
    ]
    if not snippets:
        raise _NoEnglishTranscript(f"{video_id}: downloaded caption file is empty")
    source = "auto-ytdlp" if kind == "auto" else "manual-ytdlp"
    return EnglishTranscript(snippets, subtitle_source=source)


def _transcript_error(exc: Exception) -> HTTPException:
    """原始抓取异常 → 稳定的 HTTP 错误（文案保持既有契约）。"""
    if isinstance(exc, _ResponseTooLarge):
        return HTTPException(
            status_code=400,
            detail=f"字幕抓取响应体超过上限（{_format_bytes(exc.limit)}），无法处理该视频。",
        )
    if isinstance(exc, requests.Timeout):
        if FETCH_TIMEOUT_SECONDS > 0:
            detail = f"抓取字幕超时（超过 {FETCH_TIMEOUT_SECONDS:g} 秒），请稍后再试。"
        else:
            detail = "抓取字幕超时，请稍后再试。"
        return HTTPException(status_code=504, detail=detail)
    if isinstance(exc, TranscriptsDisabled):
        return HTTPException(status_code=422, detail="该视频关闭了字幕功能，无法获取英文字幕。")
    if isinstance(exc, (NoTranscriptFound, _NoEnglishTranscript)):
        return HTTPException(status_code=422, detail="该视频没有英文字幕（含自动生成）。")
    if isinstance(exc, VideoUnavailable):
        return HTTPException(status_code=404, detail="视频不可用：可能已删除、设为私密或有地区限制。")
    if isinstance(exc, (IpBlocked, RequestBlocked)):
        return HTTPException(
            status_code=429,
            detail="YouTube 暂时限制了当前 IP 的字幕请求，请稍后再试。",
        )
    return HTTPException(status_code=502, detail=f"获取字幕失败：{exc}")


def fetch_english_transcript(video_id: str) -> EnglishTranscript:
    """Fetch the English transcript, mapping failures to actionable errors.

    抓取链（用户需求 4）：

    1. ``list()`` 探测轨道：手动 en 优先，其次自动生成 en（含 en-US/en-GB/
       en-orig 等前缀）；用探测到的具体语言码的轨道 ``fetch()``。
    2. API 抛 NoTranscriptFound / IpBlocked / RequestBlocked / 超时 / 其他异常
       → yt-dlp 回退：``extract_info`` 选 en 轨 → 下载自动字幕 VTT →
       ``parse_vtt`` 清洗。回退仍失败时**还原 API 的原始错误**（限流仍 429、
       无轨仍 422），不让用户看到两层叠加的错误。
    3. 返回 ``EnglishTranscript``，携带 ``subtitle_source`` / ``auto_generated``。

    边界（M1 ⑦ 残余项）：

    - 超时 → 504（不是 500；不触发流式路径的「无字幕 → Whisper」兜底）；
    - 响应体超过 ``MAX_FETCH_BYTES``、块数超过 ``MAX_TRANSCRIPT_BLOCKS``
      → 400。这里不用 422：流式路径把 422 当作「无字幕」去走 Whisper 兜底，
      用 400 可以避免为超大字幕再下载一遍音频。
    """
    session = _BoundedSession()
    try:
        api = YouTubeTranscriptApi(http_client=session)
        supports_track_list = hasattr(api, "list")
        try:
            if supports_track_list:
                transcript = _fetch_with_track_list(api, video_id)
            else:
                # 旧版库/测试替身没有 list()：退回旧行为，也无法做 yt-dlp 回退。
                transcript = _fetch_legacy_api(api, video_id)
        except _ResponseTooLarge:
            raise
        except Exception as api_error:
            if not supports_track_list:
                raise
            try:
                transcript = _fetch_english_transcript_with_ytdlp(video_id)
            except _ResponseTooLarge:
                raise
            except Exception as fallback_error:
                print(f"yt-dlp caption fallback failed for {video_id}: {fallback_error}")
                raise api_error
    except _ResponseTooLarge as exc:
        raise _transcript_error(exc) from exc
    except requests.Timeout as exc:
        raise _transcript_error(exc) from exc
    except TranscriptsDisabled as exc:
        raise _transcript_error(exc) from exc
    except (NoTranscriptFound, _NoEnglishTranscript) as exc:
        raise _transcript_error(exc) from exc
    except VideoUnavailable as exc:
        raise _transcript_error(exc) from exc
    except (IpBlocked, RequestBlocked) as exc:
        raise _transcript_error(exc) from exc
    except Exception as exc:
        raise _transcript_error(exc) from exc
    finally:
        session.close()

    if MAX_TRANSCRIPT_BLOCKS > 0 and len(transcript) > MAX_TRANSCRIPT_BLOCKS:
        raise HTTPException(
            status_code=400,
            detail=f"字幕块数超过上限（{MAX_TRANSCRIPT_BLOCKS} 块），无法处理该视频。",
        )
    return transcript


def get_video_metadata(url: str):
    """Fetch video metadata using yt-dlp（带 socket 超时，避免线程被永久占住）。"""
    ydl_opts = {
        'quiet': True,
        'skip_download': True,
    }
    if FETCH_TIMEOUT_SECONDS > 0:
        ydl_opts['socket_timeout'] = FETCH_TIMEOUT_SECONDS
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        return {
            "title": info.get('title', 'Unknown Title'),
            "channel": info.get('uploader', 'Unknown Channel'),
            "channel_url": info.get('channel_url', info.get('uploader_url', '')),
            "upload_date": info.get('upload_date', datetime.datetime.now().strftime("%Y%m%d")),
            "thumbnail": info.get('thumbnail', '')
        }


# ====================================================
# 本地 SRT 解析（供本地剧集使用）
# ====================================================

def parse_srt(content: str) -> list:
    """Parse SRT subtitle content into a list of blocks with start, end, text."""
    blocks = []
    # Split by double newline to get individual subtitle entries
    entries = re.split(r'\n\s*\n', content.strip())

    for entry in entries:
        lines = entry.strip().split('\n')
        if len(lines) < 3:
            continue

        # Parse timestamp line (format: 00:01:07,317 --> 00:01:09,194)
        time_match = re.match(
            r'(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})',
            lines[1]
        )
        if not time_match:
            continue

        h1, m1, s1, ms1, h2, m2, s2, ms2 = time_match.groups()
        start = int(h1) * 3600 + int(m1) * 60 + int(s1) + int(ms1) / 1000
        end = int(h2) * 3600 + int(m2) * 60 + int(s2) + int(ms2) / 1000

        # Join remaining lines as the subtitle text
        text = ' '.join(lines[2:]).strip()
        # Remove HTML tags sometimes found in SRT files
        text = re.sub(r'<[^>]+>', '', text)

        if text:
            blocks.append({"start": start, "end": end, "text": text})

    return blocks


# ====================================================
# WebVTT 解析（yt-dlp 回退下载的自动字幕）
# ====================================================

_VTT_TIMESTAMP_RE = re.compile(
    r"(?:(?P<hours>\d{1,2}):)?(?P<minutes>\d{1,2}):(?P<seconds>\d{2})[.,](?P<millis>\d{3})"
)
# YouTube 自动字幕的行内时间标签：<00:00:19.039><c> word</c> / <c.colorE5E5E5>…
_VTT_INLINE_TAG_RE = re.compile(r"<[^>]*>")


def _vtt_timestamp_to_seconds(value: str) -> float:
    """``00:00:01.200`` / ``01:02.345`` → 秒；非法格式抛 ``ValueError``。"""
    match = _VTT_TIMESTAMP_RE.fullmatch(value.strip())
    if not match:
        raise ValueError(f"invalid WebVTT timestamp: {value!r}")
    hours = int(match.group("hours") or 0)
    minutes = int(match.group("minutes"))
    seconds = int(match.group("seconds"))
    millis = int(match.group("millis"))
    return hours * 3600 + minutes * 60 + seconds + millis / 1000


def _clean_vtt_text(line: str) -> str:
    """去行内时间/样式标签、HTML 实体与多余空白；空行返回空串。"""
    text = _VTT_INLINE_TAG_RE.sub("", line)
    text = html.unescape(text)
    text = text.replace("\u200b", "").replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()


def _parse_vtt_timing(line: str) -> tuple[float, float] | None:
    """解析 ``start --> end [settings]``；不是合法时间行返回 ``None``。"""
    if "-->" not in line:
        return None
    start_raw, _, rest = line.partition("-->")
    end_raw = rest.strip().split()[0] if rest.strip() else ""
    try:
        return (
            _vtt_timestamp_to_seconds(start_raw),
            _vtt_timestamp_to_seconds(end_raw),
        )
    except ValueError:
        return None


def parse_vtt(content: str) -> list:
    """Parse WebVTT into cleaned ``{start,end,text}`` cues.

    YouTube 自动字幕的滚动窗口会让同一行在相邻 cue 里重复出现（整行重复，
    或在下一 cue 首行回显上一句）。这里按「上一 cue 已出现过的行」去重：
    只保留本 cue 新增的行，空 cue / 纯重复 cue 不更新已见集合，避免把上文
    清空后又把同一句吐一遍。行内 ``<00:00:01.234>`` / ``<c>`` 标签与
    ``align:start position:0%`` 设置行都会被剥掉；同一 cue 的多行合并成一句。
    """
    if not isinstance(content, str) or not content.strip():
        return []

    normalized = content.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    # 一行一行扫，避免把 cue 内「只有空格」的文本行误当成 cue 分隔符
    # （YouTube 自动字幕的 cue 首行经常就是一个空格）。
    raw_cues: list[dict] = []
    current: dict | None = None
    for raw_line in normalized.split("\n"):
        if "-->" in raw_line:
            timing = _parse_vtt_timing(raw_line)
            if timing is not None:
                if current is not None:
                    raw_cues.append(current)
                current = {"start": timing[0], "end": timing[1], "lines": []}
                continue
        if raw_line == "":
            if current is not None:
                raw_cues.append(current)
                current = None
            continue
        if current is not None:
            current["lines"].append(raw_line)
    if current is not None:
        raw_cues.append(current)

    cues: list[dict] = []
    previous_lines: set[str] = set()

    for cue in raw_cues:
        start, end = cue["start"], cue["end"]
        cleaned_lines = [
            cleaned for cleaned in (_clean_vtt_text(raw) for raw in cue["lines"]) if cleaned
        ]
        if not cleaned_lines:
            continue

        new_lines: list[str] = []
        for line in cleaned_lines:
            if line in previous_lines or line in new_lines:
                continue
            new_lines.append(line)
        # 本 cue 全是上一 cue 的回显（滚动字幕的冻结帧）：不产出、也不更新
        # previous_lines——下一 cue 还会带着这行，届时能正确只取新增部分。
        if not new_lines:
            continue

        text = " ".join(new_lines).strip()
        previous_lines = set(cleaned_lines)
        if cues and cues[-1]["text"] == text:
            continue
        cues.append({"start": start, "end": end, "text": text})

    return cues


def group_srt_blocks(blocks: list) -> list:
    """Group short SRT subtitle snippets into complete sentence-level blocks.

    Two-phase: split at internal sentence boundaries first, then accumulate.
    """
    # Phase 1: Split at internal sentence boundaries
    split_blocks = []
    for block in blocks:
        text = block["text"].strip()
        parts = _split_at_sentence_boundaries(text)

        if len(parts) <= 1:
            split_blocks.append(block)
        else:
            total_chars = sum(len(p) for p in parts)
            dur = block["end"] - block["start"]
            current_start = block["start"]
            for p in parts:
                frac = len(p) / total_chars if total_chars > 0 else 1
                part_dur = dur * frac
                split_blocks.append({"start": current_start, "end": current_start + part_dur, "text": p})
                current_start += part_dur

    # Phase 2: Accumulate
    grouped = []
    current = None

    for idx, block in enumerate(split_blocks):
        text = block["text"].strip()

        if current is None:
            current = {"start": block["start"], "end": block["end"], "text": text}
        else:
            current["text"] += " " + text
            current["end"] = block["end"]

        text_so_far = current["text"].strip()
        text_len = len(text_so_far)

        if re.search(r'[.!?]\s*$', text_so_far):
            grouped.append(current)
            current = None
            continue

        has_pause = False
        if idx + 1 < len(split_blocks):
            if split_blocks[idx + 1]["start"] - block["end"] > 1.5:
                has_pause = True

        if text_len > 40 and has_pause:
            grouped.append(current)
            current = None
            continue

        if text_len > 300:
            best_break = -1
            for sep in [', and ', ', but ', ', so ', '; ', ', ']:
                pos = text_so_far.rfind(sep, text_len // 3)
                if pos > best_break:
                    best_break = pos + len(sep)

            if best_break > text_len // 3:
                first_part = text_so_far[:best_break].strip()
                remainder = text_so_far[best_break:].strip()
                grouped.append({"start": current["start"], "end": current["end"], "text": first_part})
                current = {"start": current["end"], "end": current["end"], "text": remainder} if remainder else None
            else:
                grouped.append(current)
                current = None

    if current:
        grouped.append(current)

    return grouped


# ====================================================
# Whisper 转写兜底（可选依赖，无字幕视频用）
# ====================================================

def _asr_available() -> bool:
    """True if the optional faster-whisper dependency is installed."""
    try:
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def _transcribe_audio_with_whisper(url: str) -> list:
    """Download the audio track and transcribe it locally with faster-whisper.

    Used as a fallback for videos without English captions. Returns snippet
    dicts compatible with group_transcript_blocks. Blocking — run in a thread.
    """
    from faster_whisper import WhisperModel

    with tempfile.TemporaryDirectory() as tmpdir:
        audio_path = os.path.join(tmpdir, "audio.m4a")
        ydl_opts = {
            "format": "bestaudio[ext=m4a]/bestaudio",
            "outtmpl": audio_path,
            "quiet": True,
        }
        if FETCH_TIMEOUT_SECONDS > 0:
            ydl_opts["socket_timeout"] = FETCH_TIMEOUT_SECONDS
        if MAX_FETCH_BYTES > 0:
            # yt-dlp 在选格式阶段就跳过超限文件；下面再按实际落盘大小复核。
            ydl_opts["max_filesize"] = MAX_FETCH_BYTES
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        if not os.path.exists(audio_path):
            raise RuntimeError("音频下载失败，或文件超过大小上限，已跳过本地转写。")
        if MAX_FETCH_BYTES > 0:
            actual_size = os.path.getsize(audio_path)
            if actual_size > MAX_FETCH_BYTES:
                raise RuntimeError(
                    f"音频文件超过 {_format_bytes(MAX_FETCH_BYTES)} 上限，已跳过本地转写。"
                )

        model_size = os.environ.get("WHISPER_MODEL", "base")
        model = WhisperModel(model_size, device="auto", compute_type="int8")
        segments, _info = model.transcribe(audio_path, language="en", vad_filter=True)
        return [
            {"text": seg.text.strip(), "start": seg.start, "duration": seg.end - seg.start}
            for seg in segments if seg.text.strip()
        ]
