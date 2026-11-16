#!/usr/bin/env python3
"""抓取 30 条 curated 视频的英文字幕，落构建期缓存（M2，计划书 §7.3）。

运行期不联网、不跑这个脚本；它只在「要回填 content_difficulty / 换字幕源」时
手动执行一次。产物写 `data/curated-subtitles/<videoId>.json`（data/ 已
gitignore，不入库、不随产品分发），只含字幕块与来源标记，不下载视频。

用法（仓库根目录）：

    backend/venv/bin/python scripts/fetch_curated_subtitles.py
    backend/venv/bin/python scripts/fetch_curated_subtitles.py StEB_wntlZ0 6MK6tuZ7Rws
    backend/venv/bin/python scripts/fetch_curated_subtitles.py --refresh

幂等：已有非空缓存默认跳过（`--refresh` 强制重抓）。优先人工英文字幕，
没有再退自动字幕；记录 `subtitleSource: manual|auto` 供难度管线降级句法字段。

依赖：`yt-dlp`（已在 backend/venv 里；仅在联网机器上运行）。失败不中断整批，
最后汇总失败清单并以非 0 退出。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CURATED = ROOT / "content" / "curated.json"
CACHE = ROOT / "data" / "curated-subtitles"
RAW = ROOT / "data" / ".curated-subtitles-raw"

TS_RE = re.compile(
    r"^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})"
)
TAG_RE = re.compile(r"<[^>]+>")
CUE_NUM_RE = re.compile(r"^\d+$")
_HTML_ESCAPES = (("&amp;", "&"), ("&#39;", "'"), ("&quot;", '"'), ("&lt;", "<"), ("&gt;", ">"))


def parse_vtt(path: Path) -> list[dict]:
    """VTT → [{start,end,text}]；去掉重复 cue（自动字幕会重叠）。"""
    blocks: list[dict] = []
    current: dict | None = None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        stripped = line.strip()
        if not stripped:
            if current and current["text"]:
                blocks.append(current)
            current = None
            continue
        match = TS_RE.match(stripped)
        if match:
            if current and current["text"]:
                blocks.append(current)
            values = [int(match.group(index)) for index in range(1, 9)]
            start = values[0] * 3600 + values[1] * 60 + values[2] + values[3] / 1000
            end = values[4] * 3600 + values[5] * 60 + values[6] + values[7] / 1000
            current = {"start": round(start, 3), "end": round(end, 3), "text": ""}
            continue
        if current is None or CUE_NUM_RE.match(stripped) or stripped.upper() == "WEBVTT":
            continue
        cleaned = TAG_RE.sub("", stripped)
        for source, target in _HTML_ESCAPES:
            cleaned = cleaned.replace(source, target)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if not cleaned:
            continue
        current["text"] = f"{current['text']} {cleaned}".strip() if current["text"] else cleaned
    if current and current["text"]:
        blocks.append(current)
    return [block for block in blocks if block["text"]]


def _cached(cache: Path, video_id: str) -> dict | None:
    path = cache / f"{video_id}.json"
    if not path.is_file() or path.stat().st_size < 100:
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return None


def download_one(video_id: str, *, raw_dir: Path) -> dict:
    """用 yt-dlp 下载一条视频的英文 VTT（人工优先），解析成缓存 payload。"""
    try:
        import yt_dlp
    except ImportError as exc:  # pragma: no cover - 运行环境问题
        raise SystemExit("需要 yt-dlp：backend/venv/bin/python -m pip install yt-dlp") from exc

    workdir = raw_dir / video_id
    workdir.mkdir(parents=True, exist_ok=True)
    options = {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["en", "en-US", "en-GB", "en-orig", "en-en", "en-en-GB"],
        "subtitlesformat": "vtt",
        "outtmpl": str(workdir / "%(id)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "ignoreerrors": True,
        "socket_timeout": 30,
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(
            f"https://www.youtube.com/watch?v={video_id}", download=True
        )
    if not isinstance(info, dict):
        raise RuntimeError("yt-dlp 没有返回视频信息")
    manual = set((info.get("subtitles") or {}).keys())
    files = sorted(workdir.glob(f"{video_id}*.vtt"))
    if not files:
        raise RuntimeError("没有下载到英文 VTT")

    def rank(path: Path) -> tuple:
        language = path.name.split(".")[1] if "." in path.name else ""
        is_manual = language in manual or language.split("-")[0] in manual
        return (0 if is_manual else 1, 0 if language in ("en", "en-US", "en-GB") else 1, path.name)

    files.sort(key=rank)
    chosen = files[0]
    language = chosen.name.split(".")[1]
    blocks = parse_vtt(chosen)
    if not blocks:
        raise RuntimeError(f"VTT 解析不到字幕：{chosen.name}")
    kind = "manual" if (language in manual or language.split("-")[0] in manual) else "auto"
    return {
        "videoId": video_id,
        "title": info.get("title"),
        "channel": info.get("channel"),
        "duration": info.get("duration"),
        "language": language,
        "subtitleSource": kind,
        "fetchedAt": int(time.time() * 1000),
        "blockCount": len(blocks),
        "blocks": blocks,
    }


def curated_ids() -> list[str]:
    data = json.loads(CURATED.read_text(encoding="utf-8"))
    return [
        item["videoId"]
        for item in data.get("items") or []
        if isinstance(item, dict) and isinstance(item.get("videoId"), str)
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="抓取 curated 视频英文字幕缓存")
    parser.add_argument("video_ids", nargs="*", help="默认抓 content/curated.json 全部 30 条")
    parser.add_argument("--refresh", action="store_true", help="忽略已有缓存强制重抓")
    parser.add_argument("--cache", type=Path, default=CACHE)
    parser.add_argument("--raw", type=Path, default=RAW)
    args = parser.parse_args(argv)
    args.cache.mkdir(parents=True, exist_ok=True)
    args.raw.mkdir(parents=True, exist_ok=True)

    ids = args.video_ids or curated_ids()
    failures: list[tuple[str, str]] = []
    for index, video_id in enumerate(ids, start=1):
        cached = None if args.refresh else _cached(args.cache, video_id)
        if cached is not None:
            print(f"[{index}/{len(ids)}] {video_id} cached", flush=True)
            continue
        try:
            payload = download_one(video_id, raw_dir=args.raw)
            (args.cache / f"{video_id}.json").write_text(
                json.dumps(payload, ensure_ascii=False), encoding="utf-8"
            )
            print(
                f"[{index}/{len(ids)}] {video_id} OK {payload['subtitleSource']} "
                f"blocks={payload['blockCount']} dur={payload['duration']}",
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001 - 汇总报告需要真实原因
            failures.append((video_id, str(exc)))
            print(f"[{index}/{len(ids)}] {video_id} FAIL {exc}", flush=True)
        time.sleep(0.5)
    print(f"完成：成功 {len(ids) - len(failures)} / {len(ids)}；失败 {len(failures)}")
    for video_id, error in failures:
        print(f" - {video_id}: {error}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
