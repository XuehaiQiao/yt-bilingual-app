#!/usr/bin/env python3
"""G1 10 人 concierge 观察表汇总：三项门槛 + 流失/原因/时长。

用法：
    backend/venv/bin/python scripts/g1_report.py \
        --input docs/reports/g1-observation.csv \
        --out-json docs/reports/g1-summary.json \
        --out-md docs/reports/g1-summary.md

规则（见 docs/课程引擎G1-Concierge方案.md §1）：
- 走完主体 ≥6/10
- 真实预约第二节 ≥5/10
- 提交产出 ≥3/10
三项同时满足才算 pass；只有两项为 conditional；少于 10 行时标记数据不足。
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from collections import Counter
from pathlib import Path

MIN_COMPLETE = 6
MIN_BOOKED = 5
MIN_SUBMITTED = 3
EXPECTED_ROWS = 10
DROP_STAGES = ("S0", "S1", "S2", "S3", "S4", "S5", "none")
REASONS = ("太麻烦", "太难", "没意思", "没时间", "其他")


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "y", "✅", "是"}


def _number(value: str | None) -> float | None:
    try:
        if value is None or not str(value).strip():
            return None
        return float(str(value).strip())
    except ValueError:
        return None


_DATA_FIELDS = (
    "completed_main", "output_submitted", "second_booked", "willingness_1_5",
    "duration_min", "drop_stage", "top_reason", "quote", "notes",
)


def _has_observation(row: dict[str, str]) -> bool:
    """空的模板行（只有 participant_id）不算一条观察记录。"""
    return any((row.get(field) or "").strip() for field in _DATA_FIELDS)


def load_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = [
            row for row in csv.DictReader(handle)
            if (row.get("participant_id") or "").strip() and _has_observation(row)
        ]
    return rows


def summarize(rows: list[dict[str, str]]) -> dict:
    complete = [r for r in rows if _truthy(r.get("completed_main"))]
    booked = [r for r in rows if _truthy(r.get("second_booked"))]
    submitted = [r for r in rows if _truthy(r.get("output_submitted"))]
    willing = [r for r in rows if (_number(r.get("willingness_1_5")) or 0) >= 4]
    durations = [d for r in rows if (d := _number(r.get("duration_min"))) is not None]
    words = [w for r in rows if (w := _number(r.get("output_words"))) is not None]

    drop = Counter((r.get("drop_stage") or "none").strip() for r in rows if not _truthy(r.get("completed_main")))
    reasons = Counter((r.get("top_reason") or "其他").strip() for r in rows)
    thresholds = {
        "complete": MIN_COMPLETE,
        "booked": MIN_BOOKED,
        "submitted": MIN_SUBMITTED,
    }
    met = [
        len(complete) >= MIN_COMPLETE,
        len(booked) >= MIN_BOOKED,
        len(submitted) >= MIN_SUBMITTED,
    ]
    enough = len(rows) >= EXPECTED_ROWS
    passed = enough and all(met)
    conditional = enough and sum(met) == 2
    return {
        "row_count": len(rows),
        "expected_rows": EXPECTED_ROWS,
        "enough_data": enough,
        "completed": {"count": len(complete), "threshold": MIN_COMPLETE, "met": met[0]},
        "booked": {"count": len(booked), "threshold": MIN_BOOKED, "met": met[1]},
        "submitted": {"count": len(submitted), "threshold": MIN_SUBMITTED, "met": met[2]},
        "willing_ge_4": len(willing),
        "median_duration_min": round(statistics.median(durations), 1) if durations else None,
        "median_output_words": round(statistics.median(words), 1) if words else None,
        "drop_stages": {k: drop.get(k, 0) for k in DROP_STAGES},
        "reasons": {k: reasons.get(k, 0) for k in REASONS},
        "verdict": "pass" if passed else ("conditional" if conditional else "fail"),
        "insufficient_data": not enough,
        "participants": [
            {
                "id": r.get("participant_id", ""),
                "completed": _truthy(r.get("completed_main")),
                "booked": _truthy(r.get("second_booked")),
                "submitted": _truthy(r.get("output_submitted")),
                "willingness": _number(r.get("willingness_1_5")),
                "drop_stage": r.get("drop_stage") or "none",
                "top_reason": r.get("top_reason") or "其他",
            }
            for r in rows
        ],
    }


def to_markdown(summary: dict) -> str:
    def row(label: str, item: dict) -> str:
        return f"| {label} | {item['count']}/{summary['row_count']} | {item['threshold']} | {'✅' if item['met'] else '❌'} |"
    lines = [
        "# G1 Concierge 汇总",
        "",
        f"- 有效记录：**{summary['row_count']}**（目标 10）",
        f"- 判定：**{summary['verdict']}**" + ("（数据不足）" if summary["insufficient_data"] else ""),
        "",
        "| 指标 | 实际 | 门槛 | 结论 |",
        "|---|---:|---:|---|",
        row("走完主体", summary["completed"]),
        row("预约第二节", summary["booked"]),
        row("提交产出", summary["submitted"]),
        "",
        f"- 愿意度 ≥4：{summary['willing_ge_4']}/{summary['row_count']}",
        f"- 时长中位数：{summary['median_duration_min']} 分钟",
        f"- 产出词数中位数：{summary['median_output_words']}",
        "",
        "## 流失阶段",
        "",
        "| 阶段 | 人数 |",
        "|---|---:|",
    ]
    lines += [f"| {k} | {v} |" for k, v in summary["drop_stages"].items() if v]
    lines += ["", "## 主要原因", "", "| 原因 | 人数 |", "|---|---:|"]
    lines += [f"| {k} | {v} |" for k, v in summary["reasons"].items() if v]
    lines += ["", "> 判定口径：三项同时满足 pass；两项满足 conditional；少于 10 行为数据不足。"]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="汇总 G1 观察表")
    parser.add_argument("--input", default="docs/reports/g1-observation.csv")
    parser.add_argument("--out-json", default="docs/reports/g1-summary.json")
    parser.add_argument("--out-md", default="docs/reports/g1-summary.md")
    args = parser.parse_args()
    path = Path(args.input)
    if not path.exists():
        parser.error(f"输入文件不存在：{path}")
    summary = summarize(load_rows(path))
    Path(args.out_json).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out_json).write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    Path(args.out_md).write_text(to_markdown(summary), encoding="utf-8")
    print(to_markdown(summary))
    return 0 if not summary["insufficient_data"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
