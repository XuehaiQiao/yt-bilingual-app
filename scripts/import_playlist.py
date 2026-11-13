#!/usr/bin/env python3
"""把 YouTube 播放列表导入为「本地剧集」（Local Shows）字幕。

本地剧集以字幕与时间轴为主：应用读取 `subtitles/<show_id>/S<季>/E<集>.srt`，
走与 YouTube 视频相同的翻译链路；有 `episodes.json` 映射的集还能复用
「看视频」的 YouTube 播放器。

本脚本只做四件事：
1. 用 yt-dlp 列出播放列表条目（不下载视频），得到标题与视频 id；
2. 用 youtube-transcript-api 拉每个视频的英文轨道，转成标准 SRT；
3. 写入 `subtitles/<show_id>/S01/E01.srt`（按播放列表顺序两位编号）；
4. 生成/更新 `subtitles/<show_id>/meta.json` 与 `episodes.json`
   （集 → 真实 videoId 的映射，供应用复用 YouTube 播放器）。

不做翻译、不调用任何大模型——翻译在应用里第一次打开某一集时才发生。
幂等：已存在的剧集默认跳过；`episodes.json` 每次运行都按播放列表重建/合并，
不受 SRT 是否已存在影响，已有正确映射保留。单集失败不会中断，最后打印汇总与
可操作提示。字幕是版权内容，仅供本机自用；`subtitles/` 已 gitignore，不入库。

用法（在仓库根目录执行）：
    backend/venv/bin/python scripts/import_playlist.py \
        --playlist-url "https://www.youtube.com/playlist?list=..."

常用参数：
    --show-id ID     手动指定 show_id（默认用播放列表标题生成稳定 slug）
    --title-zh 文本  中文展示标题（默认沿用已有 meta / 播放列表标题）
    --limit N        只导入播放列表前 N 集（便于试跑）
    --force          已存在的 SRT 也重新抓取覆盖
    --dry-run        只打印计划，不写文件、不拉字幕
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import time
from dataclasses import dataclass

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SUBTITLES_DIR = os.environ.get(
    "SUBTITLES_DIR", os.path.join(_ROOT, "subtitles")
)

SEASON = 1
LANGUAGE = "en"
EPISODES_FILENAME = "episodes.json"
# 单集请求之间的间隔，降低触发 YouTube 限流的概率。
REQUEST_INTERVAL = 2.0
# 限流/临时错误的重试次数与初始退避秒数（之后每次翻倍）。
MAX_ATTEMPTS = 3
RETRY_BASE_DELAY = 5.0


try:
    import yt_dlp
except ImportError:  # pragma: no cover - 只在依赖没装时走到
    sys.exit(
        "缺少依赖 yt-dlp。请用后端虚拟环境运行：\n"
        "  backend/venv/bin/python scripts/import_playlist.py --help\n"
        "依赖清单见 backend/requirements.txt。"
    )

try:
    from youtube_transcript_api import (
        CouldNotRetrieveTranscript,
        IpBlocked,
        NoTranscriptFound,
        RequestBlocked,
        TranscriptsDisabled,
        VideoUnavailable,
        YouTubeTranscriptApi,
    )
except ImportError:  # pragma: no cover
    sys.exit(
        "缺少依赖 youtube-transcript-api。请用后端虚拟环境运行：\n"
        "  backend/venv/bin/python scripts/import_playlist.py --help\n"
        "依赖清单见 backend/requirements.txt。"
    )

try:
    # 这些细分类在较新的 1.x 里才有；旧版本缺失时退化成永不抛出的占位类，
    # 实际的失败仍会被下面的 CouldNotRetrieveTranscript 兜住。
    from youtube_transcript_api import (
        AgeRestricted,
        PoTokenRequired,
        VideoUnplayable,
        YouTubeDataUnparsable,
        YouTubeRequestFailed,
    )
except ImportError:  # pragma: no cover
    class _NeverRaised(Exception):
        pass

    AgeRestricted = PoTokenRequired = VideoUnplayable = _NeverRaised
    YouTubeDataUnparsable = YouTubeRequestFailed = _NeverRaised


# ----------------------------------------------------
# 数据结构与异常
# ----------------------------------------------------

@dataclass
class PlaylistEntry:
    position: int          # 播放列表中的序号，从 1 开始
    video_id: str | None
    title: str


@dataclass
class PlaylistInfo:
    title: str
    entries: list[PlaylistEntry]
    thumbnail: str


class PlaylistError(Exception):
    """播放列表本身读不到（不是单集失败）。"""


class TranscriptFetchError(Exception):
    """单集字幕抓取失败，带可操作提示。"""

    def __init__(self, reason: str, hint: str):
        super().__init__(reason)
        self.reason = reason
        self.hint = hint


# ----------------------------------------------------
# 播放列表 / 标题
# ----------------------------------------------------

def slugify(text: str) -> str:
    """把播放列表标题变成稳定的 show_id。

    小写；空白转连字符；去掉非字母数字/汉字等字符；折叠多余连字符。
    同一标题永远得到同一个 id，因此重复导入会命中同一目录。
    """
    text = (text or "").strip().lower()
    text = re.sub(r"\s+", "-", text)
    text = "".join(
        ch for ch in text if ch.isalnum() or ch == "-"
    )
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return text[:80].strip("-") or "youtube-playlist"


def validate_show_id(show_id: str) -> str:
    """拒绝空 id 与路径穿越；show_id 直接作为目录名使用。"""
    show_id = (show_id or "").strip()
    if not show_id or show_id in {".", ".."}:
        raise PlaylistError("show_id 不能为空，也不能是 . 或 ..")
    if "/" in show_id or "\\" in show_id or os.sep in show_id:
        raise PlaylistError("show_id 不能包含路径分隔符")
    return show_id


def _pick_thumbnail(info: dict, entries: list[PlaylistEntry]) -> str:
    """封面：优先用播放列表第一支视频的固定封面，其次用 yt-dlp 给的播放列表封面。"""
    first_id = next((e.video_id for e in entries if e.video_id), None)
    if first_id:
        # 不带签名参数的固定地址，不会过期。
        return f"https://i.ytimg.com/vi/{first_id}/hqdefault.jpg"

    thumbs = info.get("thumbnails") or []
    if thumbs:
        best = max(
            thumbs,
            key=lambda t: (t.get("width") or 0) * (t.get("height") or 0),
        )
        return best.get("url") or ""
    return ""


def fetch_playlist(url: str) -> PlaylistInfo:
    """用 yt-dlp 的 flat 模式列出播放列表，不逐支视频抓元数据、不下载视频。"""
    ydl_opts = {
        "quiet": True,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "no_warnings": True,
        "ignoreerrors": True,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:  # yt-dlp 的异常类型很杂，统一给出可操作信息
        raise PlaylistError(str(exc)) from exc

    if not info:
        raise PlaylistError("yt-dlp 没有返回任何信息")
    if info.get("_type") not in (None, "playlist") and info.get("entries") is None:
        raise PlaylistError("这个 URL 不是播放列表（看起来像单个视频）")

    raw_entries = info.get("entries") or []
    entries: list[PlaylistEntry] = []
    for position, item in enumerate(raw_entries, start=1):
        if not item:
            entries.append(PlaylistEntry(position, None, "(不可用的条目)"))
            continue
        entries.append(
            PlaylistEntry(
                position=position,
                video_id=item.get("id"),
                title=item.get("title") or item.get("id") or "(无标题)",
            )
        )

    title = info.get("title") or "YouTube Playlist"
    return PlaylistInfo(
        title=title,
        entries=entries,
        thumbnail=_pick_thumbnail(info, entries),
    )


# ----------------------------------------------------
# 字幕 -> SRT
# ----------------------------------------------------

def format_timestamp(seconds: float) -> str:
    """秒 -> SRT 时间戳 HH:MM:SS,mmm。"""
    total_ms = max(0, int(round(float(seconds) * 1000)))
    hours, rem = divmod(total_ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def _clean_text(text: str) -> str:
    """字幕文本压成单行；时间轴之外的空行会破坏 SRT 结构。"""
    text = (text or "").replace("\u200b", "")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def snippets_to_srt(snippets: list) -> str:
    """把 youtube-transcript-api 的片段转成标准 SRT。

    时间轴处理：按 start 排序；end = start + duration；若与下一条重叠，
    截止到下一条开始（至少保留 1ms），保证解析后 start/end 单调不倒退。
    """
    cleaned = []
    for snippet in snippets:
        text = _clean_text(getattr(snippet, "text", "") or "")
        if not text:
            continue
        start = max(0.0, float(getattr(snippet, "start", 0) or 0))
        duration = float(getattr(snippet, "duration", 0) or 0)
        cleaned.append((start, duration, text))

    cleaned.sort(key=lambda item: item[0])

    lines = []
    for index, (start, duration, text) in enumerate(cleaned):
        end = start + (duration if duration > 0 else 0.5)
        if index + 1 < len(cleaned):
            next_start = cleaned[index + 1][0]
            if end > next_start:
                end = max(next_start, start + 0.001)
        if end <= start:
            end = start + 0.001
        lines.append(
            f"{index + 1}\n"
            f"{format_timestamp(start)} --> {format_timestamp(end)}\n"
            f"{text}\n"
        )
    return "\n".join(lines)


def fetch_transcript(video_id: str) -> list:
    """拉英文轨道；限流/临时网络错误自动退避重试，其余错误直接给可操作提示。"""
    last_error: Exception | None = None
    api = YouTubeTranscriptApi()

    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return list(api.fetch(video_id, languages=[LANGUAGE]))
        except (IpBlocked, RequestBlocked, YouTubeRequestFailed, YouTubeDataUnparsable) as exc:
            last_error = exc
            if attempt < MAX_ATTEMPTS:
                delay = RETRY_BASE_DELAY * (2 ** (attempt - 1))
                print(
                    f"   ⚠️  请求被限流/临时失败（{type(exc).__name__}），"
                    f"{delay:.0f}s 后重试（{attempt}/{MAX_ATTEMPTS - 1}）"
                )
                time.sleep(delay)
        except TranscriptsDisabled as exc:
            raise TranscriptFetchError(
                "作者关闭了该视频的字幕",
                "换一个有字幕的视频；本地已导入的 SRT 不受影响。",
            ) from exc
        except NoTranscriptFound as exc:
            raise TranscriptFetchError(
                "没有英文字幕（含自动生成字幕）",
                "在 YouTube 页面确认有 CC/自动字幕；或换视频后重试。",
            ) from exc
        except (VideoUnavailable, VideoUnplayable) as exc:
            raise TranscriptFetchError(
                "视频不可用（已删除、私享或有地区限制）",
                "在浏览器确认视频能播放；若仅登录可见，需要另外提供 cookies。",
            ) from exc
        except AgeRestricted as exc:
            raise TranscriptFetchError(
                "视频有年龄限制，拿不到字幕",
                "登录后确认可看；或换一个视频。",
            ) from exc
        except PoTokenRequired as exc:
            raise TranscriptFetchError(
                "YouTube 要求 PO token（反爬校验），当前请求被拒",
                "稍后换网络重试；或改用 yt-dlp 的字幕通路。",
            ) from exc
        except CouldNotRetrieveTranscript as exc:
            raise TranscriptFetchError(
                f"获取字幕失败：{exc}",
                "稍后重试；若持续失败，检查视频是否可播放、yt-dlp 是否需要更新。",
            ) from exc
        except Exception as exc:  # 网络超时等未知错误
            last_error = exc
            if attempt < MAX_ATTEMPTS:
                delay = RETRY_BASE_DELAY * (2 ** (attempt - 1))
                print(
                    f"   ⚠️  未知错误（{type(exc).__name__}: {exc}），"
                    f"{delay:.0f}s 后重试（{attempt}/{MAX_ATTEMPTS - 1}）"
                )
                time.sleep(delay)

    raise TranscriptFetchError(
        f"重试 {MAX_ATTEMPTS} 次仍失败：{last_error}",
        "可能是 YouTube 限流或网络不稳；等几分钟后重跑，已导入的集会自动跳过。",
    )


# ----------------------------------------------------
# 落盘
# ----------------------------------------------------

def atomic_write_text(path: str, text: str) -> None:
    """同目录临时文件 + os.replace：中途失败不会留下半截 SRT/meta。"""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)


def write_meta(
    show_dir: str,
    playlist_title: str,
    title_zh: str | None,
    thumbnail: str,
) -> str:
    """写/更新 meta.json；保留已有文件里的其他字段与已有中文标题。"""
    meta_path = os.path.join(show_dir, "meta.json")
    existing: dict = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as handle:
                loaded = json.load(handle)
            if isinstance(loaded, dict):
                existing = loaded
        except (OSError, ValueError):
            existing = {}

    resolved_title_zh = (
        title_zh.strip()
        if title_zh and title_zh.strip()
        else existing.get("title_zh") or playlist_title
    )
    meta = dict(existing)
    meta.update(
        {
            "title": playlist_title,
            "title_zh": resolved_title_zh,
            "thumbnail": thumbnail,
        }
    )
    atomic_write_text(
        meta_path, json.dumps(meta, ensure_ascii=False, indent=2) + "\n"
    )
    return meta_path


def episode_key(position: int) -> str:
    """播放列表序号 -> episodes.json 的键（S01E01）。"""
    return f"S{SEASON:02d}E{position:02d}"


def read_episodes(show_dir: str) -> dict:
    """读已有 episodes.json；缺失/损坏都当作空映射，不中断导入。"""
    path = os.path.join(show_dir, EPISODES_FILENAME)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            loaded = json.load(handle)
    except (OSError, ValueError) as exc:
        print(f"⚠️  忽略无法读取的 {path}：{exc}")
        return {}
    if not isinstance(loaded, dict):
        print(f"⚠️  忽略格式不正确的 {path}：顶层应为对象")
        return {}
    return loaded


def write_episodes(show_dir: str, entries: list[PlaylistEntry]) -> tuple[str, int, int]:
    """写/更新 episodes.json：集 -> YouTube videoId 映射。

    - 每次运行都按本次 yt-dlp 列表更新，与 SRT 是否已存在无关；
    - 合并而非覆盖：已有映射（包括本次 --limit 之外的集）保留；
    - 同一集在新播放列表里换了视频，则以新列表为准；
    - 没有 video id 的条目跳过（保留该集原有映射，如果有）。

    返回 (路径, 总映射数, 本次新增/更新的条数)。
    """
    path = os.path.join(show_dir, EPISODES_FILENAME)
    episodes = read_episodes(show_dir)
    changed = 0
    for entry in entries:
        if not entry.video_id:
            continue
        key = episode_key(entry.position)
        value = {"videoId": entry.video_id, "title": entry.title}
        if episodes.get(key) != value:
            changed += 1
        episodes[key] = value

    ordered = {key: episodes[key] for key in sorted(episodes)}
    atomic_write_text(
        path, json.dumps(ordered, ensure_ascii=False, indent=2) + "\n"
    )
    return path, len(ordered), changed


# ----------------------------------------------------
# 主流程
# ----------------------------------------------------

def _positive_int(value: str) -> int:
    try:
        number = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("必须是整数") from exc
    if number <= 0:
        raise argparse.ArgumentTypeError("必须大于 0")
    return number


def run(args: argparse.Namespace) -> int:
    try:
        playlist = fetch_playlist(args.playlist_url)
    except PlaylistError as exc:
        print(f"❌ 无法读取播放列表：{exc}", file=sys.stderr)
        print(
            "   请确认：链接可公开访问、网络能连 YouTube、yt-dlp 已更新；"
            "若播放列表是私享/会员内容，需要 cookies（本脚本未内置）。",
            file=sys.stderr,
        )
        return 2

    try:
        show_id = validate_show_id(args.show_id or slugify(playlist.title))
    except PlaylistError as exc:
        print(f"❌ {exc}", file=sys.stderr)
        return 2
    entries = playlist.entries
    total = len(entries)
    if args.limit is not None:
        entries = entries[: args.limit]

    show_dir = os.path.join(DEFAULT_SUBTITLES_DIR, show_id)
    season_dir = os.path.join(show_dir, f"S{SEASON:02d}")

    print(f"📋 播放列表：{playlist.title}")
    print(f"🆔 show_id：{show_id}")
    print(f"📁 目标目录：{season_dir}/")
    print(
        f"🎬 共 {total} 集"
        + (f"，本次处理前 {len(entries)} 集" if args.limit is not None else "")
    )

    if args.dry_run:
        print("\n🔍 dry-run：只打印计划，不写文件、不请求字幕")
        for entry in entries:
            path = os.path.join(season_dir, f"E{entry.position:02d}.srt")
            if os.path.exists(path) and not args.force:
                print(f"   ⏭️  S01E{entry.position:02d} 已存在：{entry.title}")
            else:
                print(f"   ⬇️  S01E{entry.position:02d} ← {entry.video_id}：{entry.title}")
        mapped = sum(1 for entry in entries if entry.video_id)
        print(f"   🗂️  episodes.json（计划）：{mapped} 集映射")
        print(f"   📝 meta.json（计划）：title={playlist.title!r}，thumbnail={playlist.thumbnail!r}")
        return 0

    # 映射与 SRT 是否已存在无关：每次运行都写，已有正确映射会被保留。
    episodes_path, mapped_count, updated_count = write_episodes(show_dir, entries)
    print(
        f"🗂️  episodes.json：{episodes_path}"
        f"（共 {mapped_count} 集映射，本次新增/更新 {updated_count}）"
    )

    successful: list[PlaylistEntry] = []
    skipped: list[PlaylistEntry] = []
    failed: list[tuple[PlaylistEntry, TranscriptFetchError]] = []

    for offset, entry in enumerate(entries):
        episode = entry.position
        episode_name = f"S{SEASON:02d}E{episode:02d}"
        srt_path = os.path.join(season_dir, f"E{episode:02d}.srt")

        if os.path.exists(srt_path) and os.path.getsize(srt_path) > 0 and not args.force:
            skipped.append(entry)
            print(f"⏭️  {episode_name} 已存在，跳过（{entry.title}）")
            continue

        if not entry.video_id:
            error = TranscriptFetchError(
                "播放列表条目不可用（没有视频 id）",
                "可能是已删除/私享视频；在 YouTube 页面确认后重试。",
            )
            failed.append((entry, error))
            print(f"❌ {episode_name} 失败：{error.reason}")
            continue

        try:
            print(f"⬇️  {episode_name} ← {entry.video_id}（{entry.title}）")
            snippets = fetch_transcript(entry.video_id)
            srt_text = snippets_to_srt(snippets)
            if not srt_text.strip():
                raise TranscriptFetchError(
                    "英文字幕轨为空（没有任何文本片段）",
                    "换一个视频，或稍后重试。",
                )
            atomic_write_text(srt_path, srt_text)
            successful.append(entry)
            print(f"✅ {episode_name} 已写入（{srt_text.count('-->')} 条字幕）")
        except TranscriptFetchError as exc:
            failed.append((entry, exc))
            print(f"❌ {episode_name} 失败：{exc.reason}")
        except OSError as exc:
            error = TranscriptFetchError(
                f"写入文件失败：{exc}",
                "检查磁盘空间与目录权限后重试。",
            )
            failed.append((entry, error))
            print(f"❌ {episode_name} 失败：{error.reason}")
        except Exception as exc:  # 单集兜底：任何意外都不该中断整批导入
            error = TranscriptFetchError(
                f"处理字幕时出错：{type(exc).__name__}: {exc}",
                "稍后重试；若持续失败，检查该视频的字幕格式。",
            )
            failed.append((entry, error))
            print(f"❌ {episode_name} 失败：{error.reason}")

        if offset + 1 < len(entries):
            time.sleep(REQUEST_INTERVAL)

    meta_path = write_meta(show_dir, playlist.title, args.title_zh, playlist.thumbnail)

    print(
        f"\n📊 汇总：成功 {len(successful)}，跳过 {len(skipped)}，"
        f"失败 {len(failed)}（共 {len(entries)} 集）"
    )
    print(f"📝 meta.json：{meta_path}")
    print(f"🗂️  episodes.json：{episodes_path}（{mapped_count} 集映射）")

    if failed:
        print("\n失败明细与处理建议：")
        for entry, error in failed:
            print(f" - S{SEASON:02d}E{entry.position:02d}（{entry.video_id}）：{error.reason}")
            print(f"   建议：{error.hint}")
        print("\n已成功的集会保留；重跑同一条命令会自动跳过它们，只重试失败的集。")

    return 1 if failed else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="把 YouTube 播放列表的英文字幕导入为本地剧集（不下载视频、不翻译）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  backend/venv/bin/python scripts/import_playlist.py \\\n"
            '      --playlist-url "https://www.youtube.com/playlist?list=..."\n'
        ),
    )
    parser.add_argument(
        "--playlist-url",
        required=True,
        help="YouTube 播放列表 URL",
    )
    parser.add_argument(
        "--show-id",
        default=None,
        help="手动指定 show_id（默认由播放列表标题生成稳定 slug）",
    )
    parser.add_argument(
        "--title-zh",
        default=None,
        help="meta.json 里的中文展示标题（默认沿用已有 meta 或播放列表标题）",
    )
    parser.add_argument(
        "--limit",
        type=_positive_int,
        default=None,
        metavar="N",
        help="只导入播放列表前 N 集（按播放列表顺序编号）",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="已存在的 SRT 也重新抓取覆盖",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只打印计划，不写文件、不拉字幕",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
