"""本地剧集 ↔ YouTube 视频映射。

目录约定（详见 specs/006-local-shows/）：

    subtitles/<show_id>/episodes.json
    {"S01E01": {"videoId": "3dT8Wm5oI_o", "title": "Lecture 1: ..."}, ...}

`episodes.json` 由 `scripts/import_playlist.py` 生成/更新，让每一集能带上
真实的 YouTube 视频 id，前端即可复用「看视频」的播放器；没有映射的剧集
（纯 SRT）行为完全不变。

读取一律容错：文件缺失、损坏、字段不合法都返回 {} 并打日志，绝不抛异常
拖垮列表/历史接口。所有路径限制在 `config.SUBTITLES_DIR` 内，`show_id`
不接受路径分隔符或越界目录（含符号链接）。
"""
from __future__ import annotations

import json
import os
import re

import config

EPISODES_FILENAME = "episodes.json"

# 规范键为 S%02dE%02d；读取时也接受 S1E1 这类没补零的写法，统一成规范键。
_EPISODE_KEY_RE = re.compile(r"^S(\d{1,2})E(\d{1,2})$")


def episode_key(season: int, episode: int) -> str:
    """季/集号 -> episodes.json 的键（S01E01）。"""
    return f"S{int(season):02d}E{int(episode):02d}"


def _warn(message: str) -> None:
    print(f"⚠️  本地剧集映射：{message}")


def _show_dir(show_id: str) -> str | None:
    """返回 SUBTITLES_DIR 内的剧集目录；非法/越界时返回 None。

    先按字符拒绝路径分隔符，再用 realpath + commonpath 兜住符号链接等
    间接越界，保证读取范围不会跑出 SUBTITLES_DIR。
    """
    show_id = (show_id or "").strip()
    if (
        not show_id
        or show_id in {".", ".."}
        or "/" in show_id
        or "\\" in show_id
        or os.sep in show_id
    ):
        _warn(f"忽略非法的 show_id：{show_id!r}")
        return None

    subtitles_dir = os.path.realpath(config.SUBTITLES_DIR)
    show_dir = os.path.realpath(os.path.join(subtitles_dir, show_id))
    if show_dir == subtitles_dir or os.path.commonpath([subtitles_dir, show_dir]) != subtitles_dir:
        _warn(f"忽略越界的 show_id：{show_id!r}")
        return None
    return show_dir


def _normalize_episode_key(key: str) -> str | None:
    """把键统一成 S%02dE%02d；不符合格式的返回 None。"""
    if not isinstance(key, str):
        return None
    match = _EPISODE_KEY_RE.match(key.strip())
    if not match:
        return None
    return episode_key(int(match.group(1)), int(match.group(2)))


def episode_video_map(show_id: str) -> dict:
    """读取 subtitles/<show_id>/episodes.json，返回 {S01E01: {...}}。

    - 文件缺失、JSON 损坏、顶层不是对象：返回 {} 并打日志；
    - 单条映射缺 videoId / 类型不对：跳过该条（同样打日志），不影响其他集；
    - 键统一规范成 S%02dE%02d。

    每次调用都读文件，避免导入脚本更新后还要重启后端；文件很小，开销可忽略。
    """
    show_dir = _show_dir(show_id)
    if show_dir is None:
        return {}

    path = os.path.join(show_dir, EPISODES_FILENAME)
    if not os.path.exists(path):
        _warn(f"没有 {path}（该剧没有视频映射，按纯字幕使用）")
        return {}

    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError) as exc:
        _warn(f"忽略无法读取的 {path}：{exc}")
        return {}

    if not isinstance(raw, dict):
        _warn(f"忽略格式不正确的 {path}：顶层应为对象")
        return {}

    result: dict = {}
    for key, value in raw.items():
        normalized = _normalize_episode_key(key)
        if normalized is None:
            _warn(f"忽略无法识别的集键 {key!r}（应为 S01E01 这种格式）")
            continue
        if not isinstance(value, dict):
            _warn(f"忽略 {normalized} 的映射：值应为对象")
            continue
        video_id = value.get("videoId")
        if not isinstance(video_id, str) or not video_id.strip():
            _warn(f"忽略 {normalized} 的映射：缺少有效的 videoId")
            continue
        entry = {"videoId": video_id.strip()}
        title = value.get("title")
        if isinstance(title, str) and title.strip():
            entry["title"] = title.strip()
        result[normalized] = entry
    return result


def lookup_episode_video(show_id: str, season: int, episode: int) -> dict | None:
    """查某一季某一集对应的 YouTube 视频；没有映射时返回 None。"""
    try:
        key = episode_key(season, episode)
    except (TypeError, ValueError):
        _warn(f"忽略非法的季/集号：{season!r}/{episode!r}")
        return None
    return episode_video_map(show_id).get(key)


def enrich_metadata(metadata: dict | None, show_id: str, season: int, episode: int) -> dict | None:
    """给 payload.metadata 补上 youtube_video_id（有映射时含 youtube_title）。

    - 没有映射 / metadata 不是对象：原样返回，不添加任何字段；
    - 有映射：以 episodes.json 为准（即使缓存里残留旧 id 也覆盖）。
    """
    if not isinstance(metadata, dict):
        return metadata
    info = lookup_episode_video(show_id, season, episode)
    if not info:
        return metadata
    metadata["youtube_video_id"] = info["videoId"]
    if info.get("title"):
        metadata["youtube_title"] = info["title"]
    return metadata
