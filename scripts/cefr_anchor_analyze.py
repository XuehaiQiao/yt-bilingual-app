#!/usr/bin/env python3
"""分析 CEFR M2 60 条锚的人工双评结果（κ / 人工一致 / 自动基线 vs 人工）。

重要
----
- 本脚本**不会**生成任何标注：只读两份评审答案表与 truth；
- 两份表未填完 → 只输出 ``pending``（人工评审未完成 → 校准未完成），不计算 κ；
- 两份表填完但分歧未仲裁 → 输出 ``awaiting_adjudication``，不拿不一致的子集冒充一致率；
- 本脚本**不做**阈值调参；调参是后续工程任务（只允许在 40 条 calibration 上做）。
- κ 全部按独立标签计算；仲裁标签只用于「自动基线 vs 人工 consensus」的准确率，
  不用它去修饰 κ。

用法
----
    backend/venv/bin/python scripts/cefr_anchor_analyze.py \
        --truth docs/reports/cefr-anchor-truth-2026-11-17.json \
        --rater-a path/to/rater-a.csv \
        --rater-b path/to/rater-b.csv \
        [--adjudicated path/to/adjudicated.csv] \
        [--output /tmp/cefr-anchor-analysis.json]

CSV 列（至少有）：
- rater: ``anon_id,band[,confidence]``
- adjudicated: ``anon_id,band`` 或 ``anon_id,adjudicated_band``
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import random
import sys
from collections import Counter, defaultdict
from typing import Any, Mapping, Sequence

BANDS = ("A1", "A2", "B1", "B2", "C1")
BAND_INDEX = {band: index for index, band in enumerate(BANDS)}
AUTO_LEVEL_INDEX = {level: index for index, level in enumerate(("A1", "A2", "B1", "B2", "C1", "C1+"))}
BOOTSTRAP_SEED = 20261117
BOOTSTRAP_ROUNDS = 2000


def fold_band(band: str) -> str:
    return "A2" if band == "A1" else band


def read_csv_rows(path: str) -> list[dict[str, str]]:
    with open(path, "r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = [{str(key).strip(): (value or "").strip() for key, value in row.items() if key}
                for row in reader]
    return rows


def read_labels(path: str, *, band_column: str) -> dict[str, dict[str, Any]]:
    rows = read_csv_rows(path)
    if not rows:
        raise ValueError(f"空表：{path}")
    fieldnames = set(rows[0])
    if "anon_id" not in fieldnames:
        raise ValueError(f"{path} 缺少 anon_id 列")
    if band_column not in fieldnames:
        # 允许 adjudicated 表用带 band 的任意单列名
        band_columns = [name for name in fieldnames if "band" in name.lower()]
        if len(band_columns) != 1:
            raise ValueError(f"{path} 缺少 {band_column} 列（找到 {band_columns}）")
        band_column = band_columns[0]
    labels: dict[str, dict[str, Any]] = {}
    for row in rows:
        anon_id = row.get("anon_id", "").strip()
        if not anon_id:
            continue
        band = row.get(band_column, "").strip().upper()
        if band.endswith("+"):
            band = band[:-1]  # C1+ → C1（rubric 要求 C1，备注可写 C1+）
        confidence = row.get("confidence", "").strip()
        if anon_id in labels:
            raise ValueError(f"{path} 的 anon_id 重复：{anon_id}")
        if band and band not in BANDS:
            raise ValueError(f"{path} 的 {anon_id} band 非法：{band!r}（允许 A1/A2/B1/B2/C1）")
        if confidence and confidence not in ("1", "2", "3"):
            raise ValueError(f"{path} 的 {anon_id} confidence 非法：{confidence!r}")
        labels[anon_id] = {"band": band, "confidence": confidence, "notes": row.get("notes", "")}
    return labels


def load_truth(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as handle:
        truth = json.load(handle)
    items = truth.get("items")
    if not isinstance(items, list) or len(items) != 60:
        raise ValueError("truth 必须含 60 条 items")
    anon_ids = [str(item.get("anonId")) for item in items]
    if len(set(anon_ids)) != 60:
        raise ValueError("truth 的 anonId 不唯一")
    if sorted(anon_ids) != [f"M2-{index:03d}" for index in range(1, 61)]:
        raise ValueError("truth 的 anonId 不是 M2-001…M2-060")
    return truth


def cohen_kappa(a: Sequence[str], b: Sequence[str]) -> dict[str, Any]:
    if len(a) != len(b) or not a:
        raise ValueError("κ 需要等长、非空的两列")
    total = len(a)
    observed = sum(1 for left, right in zip(a, b) if left == right) / total
    counts_a = Counter(a)
    counts_b = Counter(b)
    expected = sum((counts_a[band] / total) * (counts_b[band] / total) for band in BANDS)
    if abs(1.0 - expected) < 1e-12:
        return {"kappa": None, "observedAgreement": round(observed, 4),
                "expectedAgreement": round(expected, 4), "n": total,
                "note": "p_e≈1，κ 不可定义（两列完全同一类）"}
    kappa = (observed - expected) / (1.0 - expected)
    return {
        "kappa": round(kappa, 4),
        "observedAgreement": round(observed, 4),
        "expectedAgreement": round(expected, 4),
        "n": total,
    }


def bootstrap_kappa_ci(a: Sequence[str], b: Sequence[str]) -> list[float] | None:
    rng = random.Random(BOOTSTRAP_SEED)
    values: list[float] = []
    total = len(a)
    for _ in range(BOOTSTRAP_ROUNDS):
        indices = [rng.randrange(total) for _ in range(total)]
        left = [a[index] for index in indices]
        right = [b[index] for index in indices]
        result = cohen_kappa(left, right)
        if result["kappa"] is not None:
            values.append(float(result["kappa"]))
    if len(values) < BOOTSTRAP_ROUNDS // 2:
        return None
    values.sort()
    low = values[int(0.025 * (len(values) - 1))]
    high = values[int(0.975 * (len(values) - 1))]
    return [round(low, 4), round(high, 4)]


def band_distance(left: str, right: str, *, fold_a1: bool) -> int | None:
    left_value = fold_band(left) if fold_a1 else left
    right_value = fold_band(right) if fold_a1 else right
    if left_value not in AUTO_LEVEL_INDEX or right_value not in AUTO_LEVEL_INDEX:
        return None
    return abs(AUTO_LEVEL_INDEX[left_value] - AUTO_LEVEL_INDEX[right_value])


def agreement_report(items: Sequence[Mapping[str, Any]], labels: Mapping[str, str]) -> dict[str, Any]:
    distances: Counter[int] = Counter()
    for item in items:
        human = labels.get(str(item["anonId"]), "")
        auto = str(item.get("autoBand") or "")
        if not human or not auto:
            continue
        distance = band_distance(human, auto, fold_a1=True)
        if distance is not None:
            distances[distance] += 1
    total = sum(distances.values())
    exact = distances.get(0, 0)
    within1 = exact + distances.get(1, 0)
    return {
        "n": total,
        "exact": exact,
        "exactRate": round(exact / total, 4) if total else None,
        "within1": within1,
        "within1Rate": round(within1 / total, 4) if total else None,
        "distance": {str(distance): count for distance, count in sorted(distances.items())},
        "a1Policy": "人工 A1 折叠为 A2（与 difficulty.v1 内容带下限一致）",
    }


def wilson_interval(successes: int, total: int, z: float = 1.959963984540054) -> list[float] | None:
    if total <= 0:
        return None
    p = successes / total
    denominator = 1.0 + z * z / total
    center = (p + z * z / (2.0 * total)) / denominator
    half = z * math.sqrt(p * (1.0 - p) / total + z * z / (4.0 * total * total)) / denominator
    return [round(max(0.0, center - half), 4), round(min(1.0, center + half), 4)]


def split_agreement(items: Sequence[Mapping[str, Any]], labels: Mapping[str, str], split: str) -> dict[str, Any]:
    subset = [item for item in items if item.get("split") == split]
    report = agreement_report(subset, labels)
    report["split"] = split
    if report["n"]:
        report["within1Wilson95"] = wilson_interval(report["within1"], report["n"])
        report["exactWilson95"] = wilson_interval(report["exact"], report["n"])
    return report


def confusion_matrix(items: Sequence[Mapping[str, Any]], labels: Mapping[str, str]) -> dict[str, dict[str, int]]:
    matrix: dict[str, dict[str, int]] = {}
    for item in items:
        human = labels.get(str(item["anonId"]), "")
        auto = str(item.get("autoBand") or "")
        if not human or not auto:
            continue
        human = fold_band(human)
        auto = fold_band(auto)
        matrix.setdefault(human, {})
        matrix[human][auto] = matrix[human].get(auto, 0) + 1
    return matrix


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--truth", required=True)
    parser.add_argument("--rater-a", required=True)
    parser.add_argument("--rater-b", required=True)
    parser.add_argument("--adjudicated", default=None)
    parser.add_argument("--output", default=None, help="输出 JSON；省略则打印到 stdout")
    args = parser.parse_args(argv)

    truth = load_truth(args.truth)
    items = truth["items"]
    ids = [str(item["anonId"]) for item in items]
    rater_a = read_labels(args.rater_a, band_column="band")
    rater_b = read_labels(args.rater_b, band_column="band")
    for name, labels in (("rater-a", rater_a), ("rater-b", rater_b)):
        missing = [anon_id for anon_id in ids if anon_id not in labels]
        extra = [anon_id for anon_id in labels if anon_id not in set(ids)]
        if missing or extra:
            raise ValueError(f"{name} 的 anon_id 与 truth 不一致：缺少 {missing[:5]}…，多余 {extra[:5]}…")
        filled = sum(1 for anon_id in ids if labels[anon_id]["band"])
        if filled != 60:
            result = {
                "schema": "cefr-anchor-analysis.v1",
                "status": "pending",
                "reason": "人工评审未完成 → 校准未完成；不计算 κ/一致率。",
                "filled": {"raterA": filled, "raterB": sum(1 for anon_id in ids if rater_b[anon_id]['band']), "total": 120},
                "metrics": None,
            }
            text = json.dumps(result, ensure_ascii=False, indent=2)
            if args.output:
                with open(args.output, "w", encoding="utf-8") as handle:
                    handle.write(text + "\n")
            print(text)
            return 0

    a = [rater_a[anon_id]["band"] for anon_id in ids]
    b = [rater_b[anon_id]["band"] for anon_id in ids]
    kappa = cohen_kappa(a, b)
    kappa["bootstrap95"] = bootstrap_kappa_ci(a, b)
    exact_human = sum(1 for left, right in zip(a, b) if left == right)
    within1_human = sum(
        1 for left, right in zip(a, b)
        if band_distance(left, right, fold_a1=False) is not None
        and band_distance(left, right, fold_a1=False) <= 1
    )
    disagreements = [
        {"anonId": anon_id, "raterA": rater_a[anon_id]["band"], "raterB": rater_b[anon_id]["band"]}
        for anon_id in ids
        if rater_a[anon_id]["band"] != rater_b[anon_id]["band"]
    ]

    adjudicated: dict[str, dict[str, Any]] = {}
    if args.adjudicated:
        adjudicated = read_labels(args.adjudicated, band_column="band")
        missing = [anon_id for anon_id in ids if anon_id not in adjudicated]
        if missing:
            raise ValueError(f"adjudicated 缺少 {len(missing)} 条（如 {missing[:5]}）")
        empty = [anon_id for anon_id in ids if not adjudicated[anon_id]["band"]]
        if empty:
            raise ValueError(f"adjudicated 仍有空 band：{empty[:5]}")
    else:
        unresolved = [
            entry for entry in disagreements
        ]
        if unresolved:
            result = {
                "schema": "cefr-anchor-analysis.v1",
                "status": "awaiting_adjudication",
                "reason": "两位评审已完成，但仍有分歧未仲裁；不拿不一致子集冒充一致率。",
                "humanHuman": {
                    "n": 60,
                    "exact": exact_human,
                    "exactRate": round(exact_human / 60, 4),
                    "within1": within1_human,
                    "within1Rate": round(within1_human / 60, 4),
                    "kappa": kappa,
                    "disagreements": disagreements,
                },
                "metrics": None,
            }
            text = json.dumps(result, ensure_ascii=False, indent=2)
            if args.output:
                with open(args.output, "w", encoding="utf-8") as handle:
                    handle.write(text + "\n")
            print(text)
            return 0

    # consensus band：有仲裁用仲裁；无仲裁则用两位一致标签。
    consensus: dict[str, str] = {}
    for anon_id in ids:
        if args.adjudicated:
            consensus[anon_id] = adjudicated[anon_id]["band"]
        elif rater_a[anon_id]["band"] == rater_b[anon_id]["band"]:
            consensus[anon_id] = rater_a[anon_id]["band"]
        else:
            raise ValueError(f"{anon_id} 有分歧但未提供仲裁")
    calibration = split_agreement(items, consensus, "calibration")
    holdout = split_agreement(items, consensus, "holdout")
    overall = agreement_report(items, consensus)
    overall["wilson95"] = wilson_interval(overall["within1"], overall["n"]) if overall["n"] else None
    result = {
        "schema": "cefr-anchor-analysis.v1",
        "status": "analysis_complete_not_calibrated",
        "notice": (
            "本脚本只做信度/对照统计；没有做阈值调参，也不宣称内容难度已校准。"
            "holdout 的 ±1 用人工 consensus 标签计算，必须与 n、CI 一起报告。"
        ),
        "humanHuman": {
            "n": 60,
            "exact": exact_human,
            "exactRate": round(exact_human / 60, 4),
            "within1": within1_human,
            "within1Rate": round(within1_human / 60, 4),
            "kappa": kappa,
            "targetKappa": 0.70,
            "meetsTarget": kappa["kappa"] is not None and kappa["kappa"] >= 0.70,
            "disagreements": disagreements,
        },
        "autoVsHuman": {
            "overall": overall,
            "calibration": calibration,
            "holdout": holdout,
            "confusion": confusion_matrix(items, consensus),
            "interpretation": "只允许用 calibration 调阈值；holdout 只用于验收，调参后必须重新冻结。",
        },
        "calibrationStatus": "not_tuned",
        "nextStep": "在 40 条 calibration 上调 p90/p95/wpm 阈值 → 冻结 → 只在 20 条 holdout 上验收 ±1≥80% + CI。",
    }
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
