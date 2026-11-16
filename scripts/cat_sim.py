#!/usr/bin/env python3
"""Rasch/EAP 设计检查模拟：固定参数、固定种子、一张三列表。

**这份报告只证明「算法按设计工作」，不是效度证据，也不是准确率证据。**
任何对外数字都不得引用本脚本的百分比（计划书 §5.11 / §9.9 / K16）。

固定参数（与正文 §5.1 对齐，禁止在脚本里另起一套）：

- 猜测率 ``c=0.15``；
- EAP 先验 ``N(0, 1.2²)``；
- 真实能力 ``θ ~ N(0, 1.1²)``（连续，不是整数带）；
- 题目难度 ``b = 带中心 + N(0, 0.4²)``；
- 24 / 44 题 × 5 带（A1–C1），固定 seed。

用法：

    cd backend && venv/bin/python ../scripts/cat_sim.py
    # 或：python3 scripts/cat_sim.py --trials 500

输出列：题量 / 平均 SE / 点带命中 / ±1 带覆盖。
"""
from __future__ import annotations

import argparse
import random
import statistics
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import assessment  # noqa: E402

DEFAULT_TRIALS = 400
DEFAULT_SEED = 20261117
ITEM_COUNTS = (16, 24, 32, 44, 60)
BANDS = ("A1", "A2", "B1", "B2", "C1")
ITEM_DIFFICULTY_SD = 0.4
TRUE_THETA_SD = 1.1
GUESS = assessment.GUESS


def _quotas(item_count: int) -> dict[str, int]:
    """把题量尽量平均分到 5 带（余数从 A1 起依次 +1）。"""
    base, remainder = divmod(item_count, len(BANDS))
    quotas = {band: base for band in BANDS}
    for band in BANDS[:remainder]:
        quotas[band] += 1
    return quotas


def _true_band(theta: float) -> str:
    return min(BANDS, key=lambda band: abs(assessment.BAND_CENTERS[band] - theta))


def run_trial(rng: random.Random, item_count: int) -> dict:
    theta = rng.gauss(0.0, TRUE_THETA_SD)
    responses: list[tuple[str, int]] = []
    for band, quota in _quotas(item_count).items():
        for _ in range(quota):
            difficulty = assessment.BAND_CENTERS[band] + rng.gauss(
                0.0, ITEM_DIFFICULTY_SD
            )
            probability = GUESS + (1.0 - GUESS) * assessment.sigmoid(
                theta - difficulty
            )
            correct = 1 if rng.random() < probability else 0
            responses.append((band, correct))
    estimated = assessment.estimate(responses, bands=BANDS)
    true_band = _true_band(theta)
    true_index = BANDS.index(true_band)
    low_index = BANDS.index(estimated["interval"]["low"])
    high_index = BANDS.index(estimated["interval"]["high"])
    return {
        "theta": theta,
        "estimate": estimated["theta"],
        "se": estimated["se"],
        "point_hit": estimated["band"] == true_band,
        "interval_hit": low_index <= true_index <= high_index,
    }


def summarize(item_count: int, trials: int, seed: int) -> dict:
    rng = random.Random(f"cat_sim.v1:{seed}:{item_count}")
    results = [run_trial(rng, item_count) for _ in range(trials)]
    errors = [item["estimate"] - item["theta"] for item in results]
    return {
        "items": item_count,
        "se": statistics.fmean(item["se"] for item in results),
        "rmse": (statistics.fmean(error * error for error in errors)) ** 0.5,
        "point_hit": statistics.fmean(1.0 if item["point_hit"] else 0.0 for item in results),
        "interval_hit": statistics.fmean(
            1.0 if item["interval_hit"] else 0.0 for item in results
        ),
    }


def render(rows: list[dict], *, trials: int, seed: int) -> str:
    lines = [
        "# cat_sim 设计检查（不是效度证据）",
        "",
        "参数固定：c=0.15；先验 N(0, 1.2²)；θ~N(0, 1.1²)；"
        "b=带中心+N(0, 0.4²)；A1–C1 五带；"
        f"seed={seed}；trials={trials}。",
        "",
        "| 题量 | 平均 SE | 点带命中 | ±1 带覆盖 |",
        "|---:|---:|---:|---:|",
    ]
    for row in rows:
        lines.append(
            f"| {row['items']} | {row['se']:.3f} | "
            f"{row['point_hit'] * 100:.1f}% | {row['interval_hit'] * 100:.1f}% |"
        )
    lines += [
        "",
        "> 这是模型自洽性检查：它回答「算法是否按设计工作」，不回答"
        "「真实用户身上是否成立」。后者要靠 30–50 人 pilot 的平行卷/重测，"
        "本表任何百分比都不得写进用户界面或对外文案。",
    ]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Rasch/EAP 设计检查模拟")
    parser.add_argument(
        "--trials", type=int, default=DEFAULT_TRIALS, help="每个题量的模拟次数"
    )
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="固定随机种子")
    parser.add_argument(
        "--items",
        type=str,
        default=",".join(str(value) for value in ITEM_COUNTS),
        help="题量列表（逗号分隔）",
    )
    args = parser.parse_args(argv)
    if args.trials <= 0:
        parser.error("--trials 必须为正整数")
    item_counts = [int(value) for value in args.items.split(",") if value.strip()]
    if not item_counts or any(value <= 0 for value in item_counts):
        parser.error("--items 必须是正整数列表")

    rows = [summarize(item_count, args.trials, args.seed) for item_count in item_counts]
    print(render(rows, trials=args.trials, seed=args.seed), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
