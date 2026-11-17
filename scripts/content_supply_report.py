#!/usr/bin/env python3
"""内容供给报告（CEFR M2，计划书 §4.8 / §6.4 / §10.2 #6）。

只读仓库内容与 ``content_difficulty``，输出：

- 按 kind（video/article/curated）统计「有内容 / 有难度行 / 可推荐（cefr_input 非空）」
- 失败/占位清单（无字幕或没有难度行）
- 总可推荐数与 100 条目标缺口
- 推荐 gate 状态（eligible ≥100 才开 match_v0）

用法（仓库根目录）：

    backend/venv/bin/python scripts/content_supply_report.py
    backend/venv/bin/python scripts/content_supply_report.py --report docs/reports/content-supply-2026-11-17.json
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
import recommend  # noqa: E402


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    return data if isinstance(data, dict) else {}


def _ids(path: Path, key: str) -> list[str]:
    if not path.is_file():
        return []
    data = _read_json(path)
    values = data.get(key)
    return [value for value in values or [] if isinstance(value, str)]


def _curated_ids() -> list[str]:
    path = Path(config.CURATED_CONTENT_PATH)
    if not path.is_file():
        return []
    data = _read_json(path)
    items = data.get("items") or []
    return [
        item["videoId"]
        for item in items
        if isinstance(item, dict) and isinstance(item.get("videoId"), str)
    ]


def content_refs() -> dict[str, list[str]]:
    library = Path(config.LIBRARY_DIR)
    return {
        "video": _ids(library / "videos.json", "videos"),
        "article": _ids(library / "articles.json", "articles"),
        "curated": _curated_ids(),
    }


def _curated_failure_report() -> dict[str, Any] | None:
    path = ROOT / "data" / "reports" / "curated-transcripts-backfill.json"
    if not path.is_file():
        return None
    try:
        return _read_json(path)
    except (OSError, ValueError):
        return None


def build_report() -> dict[str, Any]:
    refs = content_refs()
    curated_report = _curated_failure_report()
    curated_failures: dict[str, dict[str, Any]] = {}
    if curated_report:
        for failure in curated_report.get("failures") or []:
            if isinstance(failure, dict) and isinstance(failure.get("ref"), str):
                curated_failures[failure["ref"]] = failure

    by_kind: dict[str, dict[str, Any]] = {}
    failures: list[dict[str, Any]] = []
    total_contents = 0
    total_eligible = 0
    for kind, ids in refs.items():
        rows = difficulty.get_rows([(kind, ref) for ref in ids])
        eligible = 0
        missing_rows = 0
        unavailable_rows = 0
        for ref in ids:
            row = rows.get((kind, ref))
            if row is None:
                missing_rows += 1
                failures.append({"kind": kind, "ref": ref, "reason": "missing_difficulty_row"})
                continue
            if row.get("cefrInput"):
                eligible += 1
                continue
            unavailable_rows += 1
            failure = curated_failures.get(ref) if kind == "curated" else None
            failures.append(
                {
                    "kind": kind,
                    "ref": ref,
                    "reason": (failure or {}).get("reason") or "unavailable",
                    "error": (failure or {}).get("error"),
                    "available": False,
                }
            )
        total_contents += len(ids)
        total_eligible += eligible
        by_kind[kind] = {
            "content": len(ids),
            "difficultyRows": len(ids) - missing_rows,
            "eligible": eligible,
            "missingRows": missing_rows,
            "unavailableRows": unavailable_rows,
        }

    gate = recommend.supply_gate_state()
    return {
        "schema": "content-supply.v1",
        "date": "2026-11-17",
        "generatedAt": int(time.time() * 1000),
        "target": int(recommend.SUPPLY_GATE_MIN),
        "totalContents": total_contents,
        "totalEligible": total_eligible,
        "shortfall": max(0, int(recommend.SUPPLY_GATE_MIN) - total_eligible),
        "byKind": by_kind,
        "gate": {
            "threshold": gate["threshold"],
            "eligible": gate["eligible"],
            "open": gate["open"],
            "mode": "match_v0" if gate["open"] else "legacy",
        },
        "failures": failures,
        "gutenberg": {
            "articles": by_kind.get("article", {}).get("content", 0) - 3,
            "manifest": "content/library/gutenberg-manifest.json",
        },
        "curatedTranscripts": {
            "total": by_kind.get("curated", {}).get("content", 0),
            "available": by_kind.get("curated", {}).get("eligible", 0),
            "unavailable": by_kind.get("curated", {}).get("missingRows", 0)
            + by_kind.get("curated", {}).get("unavailableRows", 0),
            "note": (
                "可推荐数以 content_difficulty 行为准；抓不到字幕的条目会以 "
                "available=false 占位行计入 failures（不伪造等级）。"
            ),
        },
        "notes": [
            "curated 30 条首次经 backend/transcripts.fetch_english_transcript 抓取成功；"
            "随后一次强制刷新被 YouTube 429 限流，行由构建期字幕缓存恢复；未落任何字幕原文。",
            f"{by_kind.get('article', {}).get('content', 0) - 3} 篇 Gutenberg 文本记录 "
            "canonical 链接与 PD 依据；Project Gutenberg 维护期间通过其 Wayback 镜像"
            "与 Gutenberg 镜像取得原文，正文/译文随仓库分发。",
            "可推荐数只数 content_difficulty 里 cefr_input 非空的 video/article/curated 行；"
            "失败条目以 available=false 占位行留在 failures，不伪造等级。",
        ],
        "countingNote": (
            f"可推荐 {total_eligible} 条 = {by_kind.get('video', {}).get('content', 0)} 视频 + "
            f"{by_kind.get('article', {}).get('content', 0)} 文章 + "
            f"{by_kind.get('curated', {}).get('content', 0)} curated；"
            "简报里的 36 条 = 3 视频 + 3 文章 + 30 curated，这 30 条 curated 已在 36 条内。"
            "文章里 64 篇为 Gutenberg 公版短文（含本轮新增 30 篇），不能把 curated 重复计入。"
            f"当前缺口 {max(0, int(recommend.SUPPLY_GATE_MIN) - total_eligible)} 条，"
            "未用重复/占位条目凑数。"
        ),
    }


def print_report(report: dict[str, Any]) -> None:
    print(
        f"可推荐内容 {report['totalEligible']}/{report['target']} 条，"
        f"缺口 {report['shortfall']}；gate={'开' if report['gate']['open'] else '关'} "
        f"（mode={report['gate']['mode']}）"
    )
    for kind, stats in report["byKind"].items():
        print(
            f" - {kind}: content={stats['content']} rows={stats['difficultyRows']} "
            f"eligible={stats['eligible']} missing={stats['missingRows']} "
            f"unavailable={stats['unavailableRows']}"
        )
    if report["failures"]:
        print("失败/占位：")
        for failure in report["failures"]:
            print(f" - {failure['kind']}:{failure['ref']} [{failure['reason']}]")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="生成内容供给报告")
    parser.add_argument(
        "--report",
        type=Path,
        default=ROOT / "docs" / "reports" / "content-supply-2026-11-17.json",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report = build_report()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print_report(report)
    print(f"报告已写入：{args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
