#!/usr/bin/env python3
"""抓取 30 条 curated 视频的英文字幕并回填 content_difficulty（M2，计划书 §7.3）。

与 ``fetch_curated_subtitles.py`` 的区别：

- 直接复用运行期的 ``backend/transcripts.fetch_english_transcript``（YouTube
  字幕 API + yt-dlp 回退），**不落任何字幕原文**：抓到后只在内存里算
  ``difficulty.v1``，随即写 ``content_difficulty``；
- 抓不到字幕/超时/限流时，写一条 ``available=false`` 的占位行（``cefr_input``
  为空、features.available 全 false），不伪造等级；报告里保留失败原因；
- 默认跳过已有可算行；``--refresh`` 强制重抓。已有可算行在抓取失败时保留
  （记 ``kept``），不会被网络故障降级成占位行。

用法（仓库根目录）：

    backend/venv/bin/python scripts/backfill_curated_transcripts.py
    backend/venv/bin/python scripts/backfill_curated_transcripts.py --refresh
    backend/venv/bin/python scripts/backfill_curated_transcripts.py --limit 3 --dry-run

退出码：0 全部成功或有明确不可用行；1 有网络/解析失败（已写占位行）；2 环境问题。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import config  # noqa: E402
import difficulty  # noqa: E402
import transcripts  # noqa: E402


def curated_items(path: Path | None = None) -> list[dict[str, Any]]:
    target = path or Path(config.CURATED_CONTENT_PATH)
    with target.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    items = data.get("items") if isinstance(data, dict) else None
    return [item for item in items or [] if isinstance(item, dict) and isinstance(item.get("videoId"), str)]


def _snippet_value(snippet: Any, key: str, default: Any = None) -> Any:
    if isinstance(snippet, dict):
        return snippet.get(key, default)
    return getattr(snippet, key, default)


def transcript_blocks(transcript: Any) -> list[dict[str, Any]]:
    """EnglishTranscript / snippet 列表 → difficulty 的 blocks（不保留原文）。"""
    blocks: list[dict[str, Any]] = []
    for snippet in transcript or []:
        text = str(_snippet_value(snippet, "text", "") or "").strip()
        if not text:
            continue
        start = float(_snippet_value(snippet, "start", 0.0) or 0.0)
        duration = float(_snippet_value(snippet, "duration", 0.0) or 0.0)
        blocks.append({"start": round(start, 3), "end": round(start + max(0.0, duration), 3), "text": text})
    return blocks


def subtitle_source(transcript: Any) -> str:
    """manual / manual-ytdlp → human；auto / auto-ytdlp → auto。"""
    raw = str(getattr(transcript, "subtitle_source", "") or "").lower()
    if raw.startswith("manual"):
        return "human"
    if raw.startswith("auto"):
        return "auto"
    # 测试替身/旧结构没有来源标记时按人工字幕处理，并在报告里保留提示。
    return "human"


def unavailable_payload(item: dict[str, Any]) -> dict[str, Any]:
    """无字幕占位行：不写 cefr_input，features.available 全 false。"""
    video_id = str(item["videoId"])
    editorial = item.get("level") if item.get("level") in difficulty.CEFR_LEVELS else None
    duration = item.get("duration") if isinstance(item.get("duration"), int) else None
    features = difficulty.compute_video_features(
        [],
        duration_s=duration,
        subtitle_source="none",
        support={"subtitle": "none", "translation": False, "glossary": False, "text": False},
        editorial_level=editorial,
    )
    return difficulty.payload_from_features(
        "curated", video_id, features, editorial_level=editorial
    )


def payload_for_transcript(item: dict[str, Any], transcript: Any) -> dict[str, Any]:
    blocks = transcript_blocks(transcript)
    if not blocks:
        raise difficulty.DifficultyInvalid("字幕为空，无法计算难度")
    subtitle = subtitle_source(transcript)
    editorial = item.get("level") if item.get("level") in difficulty.CEFR_LEVELS else None
    duration = item.get("duration") if isinstance(item.get("duration"), int) else None
    features = difficulty.compute_video_features(
        blocks,
        duration_s=duration,
        subtitle_source=subtitle,
        support={"subtitle": subtitle, "translation": False, "glossary": False, "text": True},
        editorial_level=editorial,
    )
    return difficulty.payload_from_features(
        "curated", str(item["videoId"]), features, editorial_level=editorial
    )


def _failure_reason(exc: Exception) -> str:
    status = getattr(exc, "status_code", None)
    if status == 422:
        return "no_english_subtitles"
    if status == 429:
        return "rate_limited"
    if status == 504:
        return "timeout"
    if status == 404:
        return "video_unavailable"
    if isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, difficulty.DifficultyInvalid):
        return "empty_transcript"
    return "fetch_failed"


def _failure_detail(exc: Exception) -> str:
    detail = getattr(exc, "detail", None)
    if isinstance(detail, str) and detail.strip():
        return detail.strip()
    return f"{type(exc).__name__}: {exc}"


def _unchanged(existing: dict[str, Any] | None, payload: dict[str, Any]) -> bool:
    if existing is None:
        return False
    old_features = dict(existing.get("features") or {})
    new_features = dict(payload.get("features") or {})
    old_features.pop("computed_at", None)
    new_features.pop("computed_at", None)
    return (
        old_features == new_features
        and existing.get("cefrInput") == payload.get("cefr_input")
        and existing.get("level") == payload.get("level")
        and existing.get("method") == payload.get("method")
    )


def backfill(
    items: list[dict[str, Any]],
    *,
    refresh: bool = False,
    dry_run: bool = False,
) -> dict[str, Any]:
    started = time.time()
    results: list[dict[str, Any]] = []
    payloads: list[dict[str, Any]] = []
    for item in items:
        video_id = str(item["videoId"])
        entry: dict[str, Any] = {
            "kind": "curated",
            "ref": video_id,
            "title": item.get("title"),
            "available": False,
        }
        existing = None if dry_run else difficulty.get_row("curated", video_id)
        if not refresh and existing and existing.get("cefrInput"):
            entry.update(
                status="skipped",
                available=True,
                cefrInput=existing.get("cefrInput"),
                level=existing.get("level"),
            )
            results.append(entry)
            continue
        try:
            transcript = transcripts.fetch_english_transcript(video_id)
            payload = payload_for_transcript(item, transcript)
            entry.update(
                status="computed" if not _unchanged(existing, payload) else "skipped",
                cefrInput=payload.get("cefr_input"),
                level=payload.get("level"),
                subtitleSource=(payload.get("support") or {}).get("subtitle"),
                available=True,
            )
            if entry["status"] == "computed" and not dry_run:
                payloads.append(payload)
        except Exception as exc:  # noqa: BLE001 - 报告要保留每一条的真实原因
            # 已有可算行时，网络失败不能把好数据降级成 available=false；
            # 保留旧行并记 kept，等下次成功抓取再更新（自愈，不自毁）。
            if existing and existing.get("cefrInput"):
                entry.update(
                    status="kept",
                    available=True,
                    cefrInput=existing.get("cefrInput"),
                    level=existing.get("level"),
                    reason=_failure_reason(exc),
                    error=_failure_detail(exc),
                )
                results.append(entry)
                continue
            payload = unavailable_payload(item)
            unchanged = _unchanged(existing, payload)
            entry.update(
                status="skipped" if unchanged else "unavailable",
                available=False,
                reason=_failure_reason(exc),
                error=_failure_detail(exc),
                cefrInput=None,
                level=payload.get("level"),
            )
            if not unchanged and not dry_run:
                payloads.append(payload)
        results.append(entry)

    written = 0
    if payloads and not dry_run:
        written = difficulty.upsert_payloads(payloads)

    computed = sum(1 for item in results if item["status"] == "computed")
    skipped = sum(1 for item in results if item["status"] == "skipped")
    kept = sum(1 for item in results if item["status"] == "kept")
    unavailable = [item for item in results if item.get("available") is False]
    by_reason: dict[str, int] = {}
    for item in unavailable:
        by_reason[item["reason"]] = by_reason.get(item["reason"], 0) + 1
    kept_reasons: dict[str, int] = {}
    for item in results:
        if item["status"] == "kept":
            kept_reasons[item["reason"]] = kept_reasons.get(item["reason"], 0) + 1
    return {
        "schema": "curated-transcripts-backfill.v1",
        "generatedAt": int(time.time() * 1000),
        "durationMs": int((time.time() - started) * 1000),
        "dryRun": dry_run,
        "refresh": refresh,
        "source": "backend/transcripts.fetch_english_transcript",
        "subtitlesStored": False,
        "total": len(results),
        "computed": computed,
        "skipped": skipped,
        "kept": kept,
        "unavailable": len(unavailable),
        "written": written,
        "byReason": by_reason,
        "keptReasons": kept_reasons,
        "failures": [
            {
                "kind": item["kind"],
                "ref": item["ref"],
                "available": False,
                "reason": item["reason"],
                "error": item.get("error"),
            }
            for item in unavailable
        ],
        "items": results,
    }


def print_report(report: dict[str, Any]) -> None:
    print(
        f"curated 字幕回填 {report['total']} 条：computed={report['computed']} "
        f"skipped={report['skipped']} kept={report['kept']} "
        f"unavailable={report['unavailable']} written={report['written']}"
    )
    if report["byReason"]:
        print("不可用原因：", json.dumps(report["byReason"], ensure_ascii=False))
    for failure in report["failures"]:
        print(f" - {failure['ref']} [{failure['reason']}] {failure['error']}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="抓取 curated 字幕并回填内容难度")
    parser.add_argument("--refresh", action="store_true", help="强制重抓所有条目")
    parser.add_argument("--limit", type=int, default=0, help="只处理前 N 条（调试）")
    parser.add_argument("--dry-run", action="store_true", help="只抓取/计算，不写库")
    parser.add_argument(
        "--report",
        type=Path,
        default=ROOT / "data" / "reports" / "curated-transcripts-backfill.json",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        items = curated_items()
    except FileNotFoundError:
        print("找不到 content/curated.json", file=sys.stderr)
        return 2
    if args.limit > 0:
        items = items[: args.limit]
    if not items:
        print("curated 池为空", file=sys.stderr)
        return 2
    report = backfill(items, refresh=args.refresh, dry_run=args.dry_run)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print_report(report)
    print(f"报告已写入：{args.report}")
    return 0 if report["unavailable"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
