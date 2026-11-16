#!/usr/bin/env python3
"""按仲裁结果重算 CEFR M2 锚校准指标（QWK / ±1 / Wilson CI / holdout），只报门槛、不改阈值。

这个脚本解决什么问题
--------------------
上一轮的 `consensus` 指标（`consensus vs 编辑`、`consensus vs 自动`）用的 15 条仲裁标签
**没有落盘**：评审答案表不含仲裁列，`cefr-anchor-baseline-2026-11-17.csv` 的 `adjudicated_band`
列也是空的。没有标签就没有可复现的 consensus，
所以仲裁包 + 空白仲裁表（`cefr-anchor-adjudication-sheet-2026-11-17.csv`）必须由人填完后，
再跑本脚本得到可复现的数字。

三条硬规则
----------
1. **空表 → `pending`**：不计算任何 κ/一致率/CI，不拿 A/B 之一冒充 consensus，不伪造数字。
2. **只填一部分 → `partial_adjudication`**：列出缺的 id，仍不出数字。
3. **不改阈值**：本脚本只读 + 只写一个 JSON 结果文件；不碰 `difficulty.py`、不改
   `content/`、不写 `.env`、不 git 提交。阈值是否调整、怎么调，是人类在 calibration 集上的决定。

门槛（照抄复核计划 §5，本脚本只报告不解释为通过）
------------------------------------------------
| 步骤 | 门槛 | 备注 |
|---|---|---|
| 2 信度 | 未加权 Cohen's κ ≥ 0.70（5 类 A1–C1） | 计划原文是**未加权** κ；报告 §5.2 改用了 QWK 0.879。两者都报，别混淆 |
| 4 调参 | calibration ±1 ≥ 80% | 只允许在 40 条 calibration 上调阈值 |
| 5 holdout | holdout ±1 ≥ 80%，并写 Wilson 95% CI | 严格口径见下 |

**n=20 的算术事实**：Wilson 95% 区间下限要 ≥80%，只有 20/20 才成立（下限 83.9%）；
19/20 的下限是 76.4%，16/20 是 58.4%。也就是说「点估计 ≥80% 且 CI 下限 ≥80%」在 n=20 上
几乎不可达——不是本批数据的问题，是样本量的问题。要确认「真实值 ≥80%」，观测值需到约
88%–90% 且 n≈100。所以即使 15 条仲裁全部填完、holdout 仍 16/20，结论依然是**未通过**。

用法
----
    backend/venv/bin/python scripts/recompute_cefr_anchor.py                  # 空表 → pending
    backend/venv/bin/python scripts/recompute_cefr_anchor.py \\
        --adjudication docs/reports/cefr-anchor-adjudication-sheet-2026-11-17.csv \\
        --output docs/reports/cefr-anchor-recalibration-2026-11-17.json

参数默认全部指向仓库内文件，可省略；`--dry-run` 只打印不写文件。
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any, Mapping, Sequence

REPO_ROOT = Path(__file__).resolve().parents[1]
REPORTS = REPO_ROOT / "docs" / "reports"

TRUTH_PATH = REPORTS / "cefr-anchor-truth-2026-11-17.json"
RATER_A_PATH = REPORTS / "cefr-anchor-answer-sheet-rater-a-2026-11-17.csv"
RATER_B_PATH = REPORTS / "cefr-anchor-answer-sheet-rater-b-2026-11-17.csv"
ADJUDICATION_PATH = REPORTS / "cefr-anchor-adjudication-sheet-2026-11-17.csv"
OUTPUT_PATH = REPORTS / "cefr-anchor-recalibration-2026-11-17.json"

DATE = "2026-11-17"
SCHEMA = "cefr-anchor-recalibration.v1"
LEVELS = ("A1", "A2", "B1", "B2", "C1", "C1+")
LEVEL_INDEX = {level: index for index, level in enumerate(LEVELS)}
CONSENSUS_LEVELS = ("A2", "B1", "B2", "C1")
Z_95 = 1.959963984540054

GATE_DEFINITION = {
    "raterKappaUnweighted": {
        "threshold": 0.70,
        "comparison": ">=",
        "source": "复核计划 §5 步骤 2：未加权 Cohen's κ（A1–C1），κ ≥ 0.70",
        "required": True,
    },
    "raterQwk": {
        "threshold": 0.70,
        "comparison": ">=",
        "source": "报告 §5.2 实际采用的口径：二次加权 κ（QWK）0.879",
        "required": False,
        "note": "加权与未加权不是同一个统计量；计划的原文是未加权 κ。口径需要人类确认，本脚本两者都报。",
    },
    "calibrationWithin1": {
        "threshold": 0.80,
        "comparison": ">=",
        "source": "复核计划 §5 步骤 4：只允许在 40 条 calibration 上调阈值，调参集 ±1 ≥ 80%",
        "required": True,
    },
    "holdoutWithin1": {
        "threshold": 0.80,
        "comparison": ">=",
        "source": "复核计划 §5 步骤 5：holdout ±1 ≥ 80%",
        "required": True,
    },
    "holdoutWilsonLower": {
        "threshold": 0.80,
        "comparison": ">=",
        "source": "复核计划 §5 步骤 5 的严格口径：同时报告 Wilson 95% CI，且不能用点估计确认门槛",
        "required": True,
        "note": "n=20 时只有 20/20 能让下限 ≥0.80（83.9%）；19/20 = 76.4%、16/20 = 58.4%。",
    },
}


# ---------------------------------------------------------------- 读取


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return [
            {str(key).strip(): (value or "").strip() for key, value in row.items() if key}
            for row in reader
        ]


def fold(level: str) -> str:
    return "A2" if level == "A1" else level


def load_truth(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        truth = json.load(handle)
    items = truth.get("items")
    if not isinstance(items, list) or len(items) != 60:
        raise SystemExit(f"truth 必须含 60 条 items：{path}")
    ids = [str(item.get("anonId")) for item in items]
    if sorted(ids) != [f"M2-{index:03d}" for index in range(1, 61)]:
        raise SystemExit("truth 的 anonId 不是 M2-001…M2-060")
    return truth


def read_labels(path: Path) -> dict[str, dict[str, str]]:
    labels: dict[str, dict[str, str]] = {}
    for row in read_csv_rows(path):
        anon_id = row.get("anon_id", "")
        if not anon_id:
            continue
        if anon_id in labels:
            raise SystemExit(f"{path.name} 的 anon_id 重复：{anon_id}")
        band = row.get("band", "").upper()
        if band.endswith("+"):
            band = band[:-1]
        labels[anon_id] = {"band": band, "confidence": row.get("confidence", ""), "notes": row.get("notes", "")}
    return labels


def read_adjudication(path: Path, dispute_ids: Sequence[str]) -> dict[str, Any]:
    """读仲裁表；只认 anon_id 与 adjudicated_band（其余列用于完整性提示）。"""
    if not path.exists():
        return {"exists": False, "rows": [], "path": str(path)}
    rows = read_csv_rows(path)
    fieldnames = set(rows[0]) if rows else set()
    required = {"anon_id", "adjudicated_band"}
    missing_columns = required - fieldnames
    if missing_columns:
        raise SystemExit(f"{path.name} 缺少列：{sorted(missing_columns)}")
    table: dict[str, dict[str, str]] = {}
    order: list[str] = []
    for row in rows:
        anon_id = row.get("anon_id", "")
        if not anon_id:
            continue
        if anon_id not in dispute_ids:
            raise SystemExit(f"{path.name} 含不属于 15 条分歧的 anon_id：{anon_id}")
        if anon_id in table:
            raise SystemExit(f"{path.name} 的 anon_id 重复：{anon_id}")
        band = row.get("adjudicated_band", "").upper()
        if band.endswith("+"):
            band = band[:-1]
        if band and band not in ("A1", "A2", "B1", "B2", "C1"):
            raise SystemExit(f"{path.name} 的 {anon_id} adjudicated_band 非法：{band!r}")
        table[anon_id] = {
            "band": band,
            "adjudicator": row.get("adjudicator", ""),
            "reason": row.get("reason", ""),
            "confidence": row.get("confidence", ""),
        }
        order.append(anon_id)
    return {"exists": True, "rows": table, "order": order, "path": str(path), "rowCount": len(rows)}


# ---------------------------------------------------------------- 统计


def level_pairs(pairs: Sequence[tuple[str, str]]) -> tuple[list[int], list[int]]:
    return ([LEVEL_INDEX[fold(left)] for left, _right in pairs],
            [LEVEL_INDEX[fold(right)] for _left, right in pairs])


def kappa(left: Sequence[int], right: Sequence[int], *, quadratic: bool) -> float | None:
    if len(left) != len(right) or not left:
        raise ValueError("κ 需要等长、非空两列")
    total = len(left)
    size = len(LEVELS)
    observed = [[0] * size for _ in range(size)]
    for i, j in zip(left, right):
        observed[i][j] += 1
    rows = [sum(observed[i]) for i in range(size)]
    cols = [sum(observed[i][j] for i in range(size)) for j in range(size)]
    numerator = 0.0
    denominator = 0.0
    for i in range(size):
        for j in range(size):
            weight = ((i - j) ** 2) if quadratic else (0.0 if i == j else 1.0)
            numerator += weight * observed[i][j]
            denominator += weight * rows[i] * cols[j] / total
    if denominator == 0:
        return None
    return round(1.0 - numerator / denominator, 4)


def agreement(left: Sequence[int], right: Sequence[int]) -> dict[str, Any]:
    total = len(left)
    exact = sum(1 for i, j in zip(left, right) if i == j)
    within1 = sum(1 for i, j in zip(left, right) if abs(i - j) <= 1)
    return {
        "n": total,
        "exact": exact,
        "exactRate": round(exact / total, 4) if total else None,
        "within1": within1,
        "within1Rate": round(within1 / total, 4) if total else None,
    }


def wilson_interval(successes: int, total: int, z: float = Z_95) -> list[float] | None:
    if total <= 0:
        return None
    p = successes / total
    denominator = 1.0 + z * z / total
    center = (p + z * z / (2.0 * total)) / denominator
    half = z * math.sqrt(p * (1.0 - p) / total + z * z / (4.0 * total * total)) / denominator
    return [round(max(0.0, center - half), 4), round(min(1.0, center + half), 4)]


def paired_block(
    items: Sequence[Mapping[str, Any]],
    labels: Mapping[str, str],
    split: str | None = None,
    *,
    field: str = "autoBand",
) -> dict[str, Any]:
    subset = [item for item in items if split is None or item.get("split") == split]
    pairs = [(labels[str(item["anonId"])], str(item[field])) for item in subset if labels.get(str(item["anonId"]))]
    left, right = level_pairs(pairs)
    report = agreement(left, right)
    report["qwk"] = kappa(left, right, quadratic=True)
    report["kappaUnweighted"] = kappa(left, right, quadratic=False)
    if report["n"]:
        report["wilson95"] = wilson_interval(report["within1"], report["n"])
        report["exactWilson95"] = wilson_interval(report["exact"], report["n"])
    if split:
        report["split"] = split
    return report


def distribution(bands: Sequence[str]) -> dict[str, int]:
    return {band: count for band, count in sorted(Counter(bands).items())}


# ---------------------------------------------------------------- 结果封装


def pending_result(reason: str, adjudication: Mapping[str, Any], missing: Sequence[str], filled: int, total: int) -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "date": DATE,
        "status": "pending",
        "reason": reason,
        "filled": {"adjudicated": filled, "expected": total, "missing": list(missing)},
        "metrics": None,
        "gates": None,
        "verdict": {"passed": False, "label": "未完成（pending）", "failed": [], "pending": [reason]},
        "thresholdChangeAllowed": False,
        "gateDefinition": GATE_DEFINITION,
        "notice": "仲裁表为空/不完整 → 只输出 pending，不计算任何一致性、κ 或 CI 数字。不伪造、不用 A/B 之一冒充 consensus。",
        "adjudicationPath": adjudication.get("path"),
        "output": None,
    }


def compute(
    truth: Mapping[str, Any],
    labels_a: Mapping[str, Mapping[str, str]],
    labels_b: Mapping[str, Mapping[str, str]],
    adjudication: Mapping[str, Any],
    dispute_ids: Sequence[str],
) -> dict[str, Any]:
    items = truth["items"]
    ids = [str(item["anonId"]) for item in items]
    table = adjudication["rows"]

    consensus: dict[str, str] = {}
    off_band: list[dict[str, str]] = []
    for anon_id in ids:
        band_a = labels_a[anon_id]["band"]
        band_b = labels_b[anon_id]["band"]
        if band_a == band_b:
            consensus[anon_id] = band_a
            continue
        chosen = table[anon_id]["band"]
        consensus[anon_id] = chosen
        if chosen not in (band_a, band_b):
            off_band.append({"anonId": anon_id, "adjudicated": chosen, "bandA": band_a, "bandB": band_b})

    left, right = level_pairs([(labels_a[anon_id]["band"], labels_b[anon_id]["band"]) for anon_id in ids])
    rater = agreement(left, right)
    rater["qwk"] = kappa(left, right, quadratic=True)
    rater["kappaUnweighted"] = kappa(left, right, quadratic=False)
    rater["disagreements"] = len(dispute_ids)

    consensus_bands = {anon_id: consensus[anon_id] for anon_id in ids}
    vs_editorial = paired_block(items, consensus_bands, field="editorialBand")
    vs_auto_overall = paired_block(items, consensus_bands, field="autoBand")
    vs_auto_calibration = paired_block(items, consensus_bands, "calibration", field="autoBand")
    vs_auto_holdout = paired_block(items, consensus_bands, "holdout", field="autoBand")
    editorial_bands = {str(item["anonId"]): str(item["editorialBand"]) for item in items}
    editorial_vs_auto_holdout = paired_block(items, editorial_bands, "holdout", field="autoBand")

    # 敏感性：把 15 条分歧统一按「低带 / 高带」解，看结论区间（仲裁结果之外的边界）
    def resolve(prefer: str) -> dict[str, str]:
        resolved = {}
        for anon_id in ids:
            band_a = labels_a[anon_id]["band"]
            band_b = labels_b[anon_id]["band"]
            if band_a == band_b:
                resolved[anon_id] = band_a
            else:
                low, high = sorted((band_a, band_b), key=lambda band: LEVEL_INDEX[band])
                resolved[anon_id] = low if prefer == "lower" else high
        return resolved

    sensitivity = {}
    for label in ("lower", "higher"):
        resolved = resolve(label)
        holdout = paired_block(items, resolved, "holdout", field="autoBand")
        overall = paired_block(items, resolved, field="autoBand")
        sensitivity[f"all{label.capitalize()}"] = {
            "consensusVsAutoHoldoutWithin1": holdout["within1"],
            "consensusVsAutoHoldoutRate": holdout["within1Rate"],
            "consensusVsAutoOverallWithin1": overall["within1"],
            "consensusVsAutoOverallRate": overall["within1Rate"],
        }
    sensitivity["adjudicated"] = {
        "consensusVsAutoHoldoutWithin1": vs_auto_holdout["within1"],
        "consensusVsAutoHoldoutRate": vs_auto_holdout["within1Rate"],
        "consensusVsAutoOverallWithin1": vs_auto_overall["within1"],
        "consensusVsAutoOverallRate": vs_auto_overall["within1Rate"],
    }
    sensitivity["note"] = "敏感性只显示「若争议统一取低/高带」的区间；仲裁结果落在两者之间或之外都正常。"

    gates = {
        "raterKappaUnweighted": {
            **GATE_DEFINITION["raterKappaUnweighted"],
            "value": rater["kappaUnweighted"],
            "passed": rater["kappaUnweighted"] is not None and rater["kappaUnweighted"] >= 0.70,
        },
        "raterQwk": {
            **GATE_DEFINITION["raterQwk"],
            "value": rater["qwk"],
            "passed": rater["qwk"] is not None and rater["qwk"] >= 0.70,
        },
        "calibrationWithin1": {
            **GATE_DEFINITION["calibrationWithin1"],
            "value": vs_auto_calibration["within1Rate"],
            "k": vs_auto_calibration["within1"],
            "n": vs_auto_calibration["n"],
            "passed": vs_auto_calibration["within1Rate"] is not None and vs_auto_calibration["within1Rate"] >= 0.80,
        },
        "holdoutWithin1": {
            **GATE_DEFINITION["holdoutWithin1"],
            "value": vs_auto_holdout["within1Rate"],
            "k": vs_auto_holdout["within1"],
            "n": vs_auto_holdout["n"],
            "wilson95": vs_auto_holdout.get("wilson95"),
            "passed": vs_auto_holdout["within1Rate"] is not None and vs_auto_holdout["within1Rate"] >= 0.80,
        },
        "holdoutWilsonLower": {
            **GATE_DEFINITION["holdoutWilsonLower"],
            "value": (vs_auto_holdout.get("wilson95") or [None, None])[0],
            "wilson95": vs_auto_holdout.get("wilson95"),
            "passed": bool(vs_auto_holdout.get("wilson95") and vs_auto_holdout["wilson95"][0] >= 0.80),
        },
    }
    failed = [name for name, gate in gates.items() if gate.get("required") and not gate["passed"]]
    verdict = {
        "passed": not failed,
        "label": "通过计划门槛" if not failed else "未通过计划门槛",
        "failed": failed,
        "summary": (
            "所有必需门槛均满足；仍需人类在 calibration 上明确阈值变更（本脚本不改阈值）。"
            if not failed
            else "未通过：" + "；".join(f"{name}（{gates[name].get('value')} < {gates[name]['threshold']}）" for name in failed)
        ),
    }

    adjudicators = sorted({entry["adjudicator"] for entry in table.values() if entry.get("adjudicator")})
    missing_reason = [anon_id for anon_id in dispute_ids if not table[anon_id].get("reason")]
    missing_adjudicator = [anon_id for anon_id in dispute_ids if not table[anon_id].get("adjudicator")]

    return {
        "schema": SCHEMA,
        "date": DATE,
        "status": "computed",
        "adjudication": {
            "n": len(dispute_ids),
            "filled": len(dispute_ids),
            "adjudicators": adjudicators,
            "offBandChoices": off_band,
            "missingReason": missing_reason,
            "missingAdjudicator": missing_adjudicator,
            "path": adjudication.get("path"),
        },
        "metrics": {
            "raterAgreement": {
                **rater,
                "note": "κ / QWK 只用评审 A/B 的独立标签，仲裁结果不会修饰信度。",
            },
            "consensusVsEditorial": vs_editorial,
            "consensusVsAuto": {
                "overall": vs_auto_overall,
                "calibration": vs_auto_calibration,
                "holdout": vs_auto_holdout,
            },
            "editorialVsAutoReference": {
                "holdout": editorial_vs_auto_holdout,
                "note": "这一组与仲裁无关，只用于核对 truth/自动标签没被改动。",
            },
            "distribution": {
                "consensus": distribution([consensus[anon_id] for anon_id in ids]),
                "editorial": distribution([fold(str(item["editorialBand"])) for item in items]),
                "auto": distribution([fold(str(item["autoBand"])) for item in items]),
            },
            "adjudicationSensitivity": sensitivity,
        },
        "gates": gates,
        "verdict": verdict,
        "thresholdChangeAllowed": False,
        "gateDefinition": GATE_DEFINITION,
        "notice": "只重算指标与门槛；未改 difficulty.py 阈值、未改 content/、未写 .env、未 git 提交。",
        "nextStep": (
            "阈值变更需人类决定：只在 40 条 calibration 上重调 → 冻结 → 重跑 20 条 holdout → "
            "扩样到 100+ 后再报 CI。"
        ),
    }


# ---------------------------------------------------------------- 打印


def print_summary(result: Mapping[str, Any]) -> None:
    print(f"status: {result['status']}")
    if result["status"] != "computed":
        filled = result.get("filled", {})
        print(f"filled: {filled.get('adjudicated')}/{filled.get('expected')}")
        if filled.get("missing"):
            print(f"missing: {', '.join(filled['missing'])}")
        print(f"reason: {result['reason']}")
        print("门槛（未计算，仅定义）：")
        for name, gate in GATE_DEFINITION.items():
            print(f"  - {name}: {gate['threshold']:.0%}（{gate['comparison']}）{gate['source']}")
        return
    metrics = result["metrics"]
    rater = metrics["raterAgreement"]
    print(
        f"评审间：exact {rater['exact']}/{rater['n']}（{rater['exactRate']:.1%}），"
        f"±1 {rater['within1']}/{rater['n']}（{rater['within1Rate']:.1%}），"
        f"QWK {rater['qwk']}，未加权 κ {rater['kappaUnweighted']}"
    )
    for label, block in (
        ("consensus vs 编辑", metrics["consensusVsEditorial"]),
        ("consensus vs 自动（40 调参）", metrics["consensusVsAuto"]["calibration"]),
        ("consensus vs 自动（20 holdout）", metrics["consensusVsAuto"]["holdout"]),
        ("consensus vs 自动（60 总体）", metrics["consensusVsAuto"]["overall"]),
    ):
        wilson = block.get("wilson95")
        interval = f"，Wilson {wilson[0]:.1%}–{wilson[1]:.1%}" if wilson else ""
        print(
            f"{label}：±1 {block['within1']}/{block['n']}（{block['within1Rate']:.1%}）"
            f"，exact {block['exactRate']:.1%}，QWK {block['qwk']}{interval}"
        )
    print("门槛：")
    for name, gate in result["gates"].items():
        status = "PASS" if gate["passed"] else "FAIL"
        value = gate["value"]
        shown = f"{value}" if isinstance(value, (int, str)) or value is None else f"{value}"
        print(f"  [{status}] {name}: {shown} vs {gate['threshold']:.2f}（{gate['source']}）")
    print(f"判定：{result['verdict']['label']} — {result['verdict']['summary']}")
    sensitivity = metrics["adjudicationSensitivity"]
    print(
        "敏感性（holdout ±1）："
        f"统一低带 {sensitivity['allLower']['consensusVsAutoHoldoutRate']:.1%} / "
        f"仲裁结果 {sensitivity['adjudicated']['consensusVsAutoHoldoutRate']:.1%} / "
        f"统一高带 {sensitivity['allHigher']['consensusVsAutoHoldoutRate']:.1%}"
    )


# ---------------------------------------------------------------- 主流程


def emit(result: dict[str, Any], args: argparse.Namespace) -> int:
    """统一出口：写 JSON（除非 --dry-run）+ 打印摘要。"""
    result["output"] = None if args.dry_run else str(args.output)
    if not args.dry_run:
        Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print_summary(result)
    if not args.dry_run:
        print(f"已写出 {args.output}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--truth", default=str(TRUTH_PATH))
    parser.add_argument("--rater-a", default=str(RATER_A_PATH))
    parser.add_argument("--rater-b", default=str(RATER_B_PATH))
    parser.add_argument("--adjudication", "--adjudicated", dest="adjudication", default=str(ADJUDICATION_PATH))
    parser.add_argument("--output", default=str(OUTPUT_PATH))
    parser.add_argument("--dry-run", action="store_true", help="只打印，不写 JSON")
    args = parser.parse_args(argv)

    truth = load_truth(Path(args.truth))
    items = truth["items"]
    ids = [str(item["anonId"]) for item in items]
    if not Path(args.rater_a).exists() or not Path(args.rater_b).exists():
        return emit(pending_result("评审答案表不存在", {"path": str(args.adjudication)}, ids, 0, len(ids)), args)

    labels_a = read_labels(Path(args.rater_a))
    labels_b = read_labels(Path(args.rater_b))
    missing_labels = [anon_id for anon_id in ids if anon_id not in labels_a or anon_id not in labels_b]
    if missing_labels:
        raise SystemExit(f"答案表缺少 {len(missing_labels)} 条：{missing_labels[:5]}…")
    unfilled = [anon_id for anon_id in ids if not labels_a[anon_id]["band"] or not labels_b[anon_id]["band"]]
    if unfilled:
        return emit(
            pending_result(
                f"评审答案表仍有 {len(unfilled)} 条空 band → 人工评审未完成",
                {"path": str(args.adjudication)},
                unfilled,
                0,
                len(unfilled),
            ),
            args,
        )

    dispute_ids = [
        anon_id for anon_id in ids if labels_a[anon_id]["band"] != labels_b[anon_id]["band"]
    ]
    for anon_id in dispute_ids:
        gap = abs(LEVEL_INDEX[labels_a[anon_id]["band"]] - LEVEL_INDEX[labels_b[anon_id]["band"]])
        if gap != 1:
            raise SystemExit(f"{anon_id} 的评审差为 {gap} 带（应只有相邻带分歧）")

    adjudication = read_adjudication(Path(args.adjudication), dispute_ids)
    if not adjudication["exists"]:
        result = pending_result(
            f"仲裁表不存在：{args.adjudication}（预期 {len(dispute_ids)} 行）",
            adjudication,
            dispute_ids,
            0,
            len(dispute_ids),
        )
    else:
        table = adjudication["rows"]
        filled_ids = [anon_id for anon_id in dispute_ids if table.get(anon_id, {}).get("band")]
        missing_ids = [anon_id for anon_id in dispute_ids if not table.get(anon_id, {}).get("band")]
        if len(filled_ids) == 0:
            result = pending_result(
                f"仲裁表为空（0/{len(dispute_ids)} 已填）→ 校准仍未通过；不计算任何数字",
                adjudication,
                dispute_ids,
                0,
                len(dispute_ids),
            )
        elif missing_ids:
            result = pending_result(
                f"仲裁表只填了 {len(filled_ids)}/{len(dispute_ids)} 条 → 不计算任何数字",
                adjudication,
                missing_ids,
                len(filled_ids),
                len(dispute_ids),
            )
            result["status"] = "partial_adjudication"
            result["verdict"]["label"] = "未完成（partial_adjudication）"
        else:
            result = compute(truth, labels_a, labels_b, adjudication, dispute_ids)

    return emit(result, args)


if __name__ == "__main__":
    raise SystemExit(main())
