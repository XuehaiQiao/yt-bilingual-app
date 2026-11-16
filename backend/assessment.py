"""能力标定的测量底座：1PL/Rasch + EAP 区间估计（计划书 §5，specs/025）。

本模块**只有纯函数**：不连库、不读文件、不联网。输入是一组
``(难度带, 是否答对)``，输出是固定网格上的 EAP 点估计、标准误、后验区间、
CEFR 带与词汇量区间。所有数字都可由同一份输入确定性地复现——这是
``calibration_version='rasch.eap.v1'`` 的含义。

模型（与计划书 §5.1 逐项对齐）：

- ``p(答对 | θ, b) = c + (1 − c) · σ(θ − b)``，``c = 0.15``（4 选 1 + 不认识）；
- ``b`` = 题带中心：A1 −2.0 / A2 −1.2 / B1 −0.4 / B2 +0.4 / C1 +1.2 / C2 +2.0；
- 先验 ``N(0, 1.2²)``；网格 −4…+4、步长 0.05（161 点）；
- ``θ̂ = EAP``（后验均值），``SE = 后验 SD``，95% 区间 = ``θ̂ ± 1.96·SE``；
- 点带 = 后验质量最大的带；显示区间 = 点带 ±1 带（A1/C2 处截断）；
- 80% 最高后验密度区间（HPD）另存，宽度不足 1 带时按 1 带展开；
- 词汇量：``E[known] = Σ_band N_band · σ(θ − b_band)``，按后验分布给 80%
  区间，再收敛到「±2,000–2,500（lemma）」的展示口径。

为什么用 EAP 不用 MLE：24 题的固定卷太短，全对/全错时 MLE 会发散到 ±∞；
EAP 向先验收缩，天然给出有限区间。两端偏保守，但两端本来就没有信息。
"""
from __future__ import annotations

import math
from typing import Iterable, Mapping, Sequence

# ---------------------------------------------------------------------------
# 公开常量（版本号改动必须同步迁移、specs/025 与测试）
# ---------------------------------------------------------------------------

CALIBRATION_VERSION = "rasch.eap.v1"
SCHEMA_VERSION = "ability.v1"

CEFR_BANDS: tuple[str, ...] = ("A1", "A2", "B1", "B2", "C1", "C2")
BAND_INDEX: dict[str, int] = {band: index for index, band in enumerate(CEFR_BANDS)}

# 题带中心（logit）。A1–C1 是现行 24 题卷实际使用的 5 个值；C2 只用于
# 未来的扩展卷与 can-do 展示，不改变现有题目的 b。
BAND_CENTERS: dict[str, float] = {
    "A1": -2.0,
    "A2": -1.2,
    "B1": -0.4,
    "B2": 0.4,
    "C1": 1.2,
    "C2": 2.0,
}

GUESS = 0.15
PRIOR_SD = 1.2
GRID_MIN = -4.0
GRID_MAX = 4.0
GRID_STEP = 0.05

BAND_WIDTH = 0.8  # 1 band ≈ 0.8 logit；用于 HPD 最小宽度与带边界
CI95_Z = 1.96
HPD_MASS = 0.80

# 词汇量锚点：CEFR 各带的「累计 lemma」惯例中点（计划书 §4.3 对外区间中点）。
# 只用于把 θ 映射成用户能看懂的「约 X–Y 词」，不是精确计数。
VOCAB_ANCHORS: dict[str, int] = {
    "A1": 1250,
    "A2": 2500,
    "B1": 4250,
    "B2": 7000,
    "C1": 11000,
    "C2": 18000,
}
VOCAB_UNIT = "lemma"
VOCAB_MIN_HALF_WIDTH = 2000
VOCAB_MAX_HALF_WIDTH = 2500

# 精度分档（只由题目信息量决定，与作答可信度分开；计划书 §5.8）。
PRECISION_HIGH_MAX_SE = 0.45
PRECISION_MEDIUM_MAX_SE = 0.60
PRECISION_VALUE_HIGH = 0.90
PRECISION_VALUE_MEDIUM = 0.75
PRECISION_VALUE_LOW = 0.55


class AssessmentError(ValueError):
    """输入不合同一模型（未知带、空响应结构等）。"""


# ---------------------------------------------------------------------------
# 基础数学
# ---------------------------------------------------------------------------

def sigmoid(value: float) -> float:
    """数值稳定的 logistic。"""
    if value >= 0:
        return 1.0 / (1.0 + math.exp(-value))
    exp_value = math.exp(value)
    return exp_value / (1.0 + exp_value)


def band_center(band: str) -> float:
    try:
        return BAND_CENTERS[band]
    except KeyError as exc:
        raise AssessmentError(f"未知 CEFR 带：{band}") from exc


def _grid() -> tuple[float, ...]:
    """−4…+4、步长 0.05 的固定网格（161 个点）。"""
    count = int(round((GRID_MAX - GRID_MIN) / GRID_STEP)) + 1
    return tuple(round(GRID_MIN + index * GRID_STEP, 4) for index in range(count))


GRID: tuple[float, ...] = _grid()


def _normalize_responses(
    responses: Iterable[object],
) -> list[tuple[str, int]]:
    """接受 ``[(band, correct)]`` / ``[{'band':…, 'correct':…}]`` 两种形状。"""
    pairs: list[tuple[str, int]] = []
    for index, raw in enumerate(responses):
        if isinstance(raw, Mapping):
            band = raw.get("band")
            correct = raw.get("correct")
        elif isinstance(raw, (tuple, list)) and len(raw) == 2:
            band, correct = raw
        else:
            raise AssessmentError(f"responses[{index}] 必须含 band/correct。")
        if not isinstance(band, str) or band not in BAND_CENTERS:
            raise AssessmentError(f"responses[{index}] 的 band 非法：{band!r}")
        if isinstance(correct, bool):
            correct = int(correct)
        if correct not in (0, 1):
            raise AssessmentError(f"responses[{index}] 的 correct 必须是 0/1。")
        pairs.append((band, int(correct)))
    return pairs


def _item_probability(theta: float, band: str) -> float:
    """该带题目在 θ 处答对的概率（含猜测）。"""
    return GUESS + (1.0 - GUESS) * sigmoid(theta - band_center(band))


def _knowledge_probability(theta: float, band: str) -> float:
    """该带词「认识」的概率：去掉猜测后的 σ(θ−b)。

    词汇量映射用认识概率而不是答对概率：4 选 1 蒙对的词不能算「认识」，
    否则选项猜测会把词汇量整体抬高。
    """
    return sigmoid(theta - band_center(band))


# ---------------------------------------------------------------------------
# 后验
# ---------------------------------------------------------------------------

def posterior(
    responses: Sequence[object],
    *,
    grid: Sequence[float] = GRID,
    prior_mean: float = 0.0,
    prior_sd: float = PRIOR_SD,
) -> list[float]:
    """归一化后验密度（与 ``grid`` 等长）；纯函数、确定性。"""
    pairs = _normalize_responses(responses)
    if prior_sd <= 0:
        raise AssessmentError("prior_sd 必须为正。")
    log_post: list[float] = []
    for theta in grid:
        log_density = -0.5 * ((theta - prior_mean) / prior_sd) ** 2
        for band, correct in pairs:
            probability = _item_probability(theta, band)
            log_density += math.log(probability if correct else 1.0 - probability)
        log_post.append(log_density)
    peak = max(log_post)
    weights = [math.exp(value - peak) for value in log_post]
    total = sum(weights)
    if not math.isfinite(total) or total <= 0:  # pragma: no cover - 数学上不可达
        raise AssessmentError("后验归一化失败。")
    return [value / total for value in weights]


def _posterior_moments(
    grid: Sequence[float], density: Sequence[float]
) -> tuple[float, float]:
    mean = sum(theta * weight for theta, weight in zip(grid, density))
    variance = sum(
        (theta - mean) ** 2 * weight for theta, weight in zip(grid, density)
    )
    return mean, math.sqrt(max(0.0, variance))


def _hpd_interval(
    grid: Sequence[float], density: Sequence[float], mass: float = HPD_MASS
) -> tuple[float, float]:
    """最高后验密度区间：从最高密度点向外扩到累计 ``mass``；宽度至少 1 带。"""
    order = sorted(range(len(grid)), key=lambda index: density[index], reverse=True)
    accumulated = 0.0
    selected: list[int] = []
    for index in order:
        selected.append(index)
        accumulated += density[index]
        if accumulated >= mass:
            break
    low = min(grid[index] for index in selected)
    high = max(grid[index] for index in selected)
    if high - low < BAND_WIDTH:
        midpoint = (high + low) / 2.0
        low = midpoint - BAND_WIDTH / 2.0
        high = midpoint + BAND_WIDTH / 2.0
    return low, high


def _clamp_band(band: str, bands: Sequence[str]) -> str:
    if band in bands:
        return band
    target = BAND_CENTERS[band]
    return min(bands, key=lambda candidate: abs(BAND_CENTERS[candidate] - target))


def band_posterior(
    grid: Sequence[float],
    density: Sequence[float],
    *,
    bands: Sequence[str] = CEFR_BANDS,
) -> dict[str, float]:
    """把后验质量分到各带（按最近带中心归属；输出带之外折叠到最近带）。"""
    if not bands:
        raise AssessmentError("bands 不能为空。")
    for band in bands:
        band_center(band)
    masses = {band: 0.0 for band in bands}
    for theta, weight in zip(grid, density):
        # 只在「输出的带」里找最近中心：24 题卷不含 C2 题，全对不应被报成 C2；
        # 网格两端的尾部质量归到最近的输出带（A1/C1），不丢失也不伪造新带。
        nearest = min(
            bands,
            key=lambda band: (abs(BAND_CENTERS[band] - theta), BAND_INDEX[band]),
        )
        masses[nearest] += weight
    total = sum(masses.values())
    if total > 0:
        masses = {band: value / total for band, value in masses.items()}
    return masses


def _point_band(masses: Mapping[str, float], bands: Sequence[str]) -> str:
    """后验质量最大的带；并列时取较低带（确定性）。"""
    best = bands[0]
    best_value = -1.0
    for band in bands:
        value = masses.get(band, 0.0)
        if value > best_value + 1e-12:
            best = band
            best_value = value
    return best


def band_interval(band: str, *, bands: Sequence[str] = CEFR_BANDS) -> dict:
    """点带 ±1 带（A1/C2 处截断），返回 ``{low, high, label}``。"""
    if band not in bands:
        band = _clamp_band(band, bands)
    index = bands.index(band)
    low = bands[max(0, index - 1)]
    high = bands[min(len(bands) - 1, index + 1)]
    return {"low": low, "high": high, "label": f"{low}–{high}"}


# ---------------------------------------------------------------------------
# 词汇量映射
# ---------------------------------------------------------------------------

def vocabulary_estimate(theta: float) -> float:
    """``E[known]``：各带词族分段 × 该带词被认识的概率。"""
    cumulative = 0
    total = 0.0
    for band in CEFR_BANDS:
        anchor = VOCAB_ANCHORS[band]
        segment = max(0, anchor - cumulative)
        cumulative = anchor
        total += segment * _knowledge_probability(theta, band)
    return total


def vocab_interval(
    theta: float,
    grid: Sequence[float],
    density: Sequence[float],
    *,
    half_width: float | None = None,
) -> dict:
    """词汇量点估计 + 80% 区间，收敛到「约 X–Y 词（lemma）」口径。

    - 点估计 = ``E[known]`` 在 θ̂ 处的值；
    - 区间先取后验 10%–90% 分位，再按最小值/最大值收敛到 ±2,000–2,500；
    - 上下界取整到百位，避免「4,237 词」这种精确错觉。
    """
    point = vocabulary_estimate(theta)
    if half_width is not None:
        half = max(VOCAB_MIN_HALF_WIDTH, min(VOCAB_MAX_HALF_WIDTH, half_width))
    else:
        estimates = [
            (value, weight)
            for value, weight in (
                (vocabulary_estimate(grid[index]), density[index])
                for index in range(len(grid))
            )
        ]
        estimates.sort(key=lambda pair: pair[0])
        cumulative = 0.0
        low_value = estimates[0][0]
        high_value = estimates[-1][0]
        for value, weight in estimates:
            cumulative += weight
            if cumulative >= 0.10:
                low_value = value
                break
        cumulative = 0.0
        for value, weight in reversed(estimates):
            cumulative += weight
            if cumulative >= 0.10:
                high_value = value
                break
        half = (high_value - low_value) / 2.0
        half = max(VOCAB_MIN_HALF_WIDTH, min(VOCAB_MAX_HALF_WIDTH, half))
    low = max(100, int(round((point - half) / 100.0)) * 100)
    high = max(low + 100, int(round((point + half) / 100.0)) * 100)
    return {
        "point": int(round(point / 100.0)) * 100,
        "low": low,
        "high": high,
        "unit": VOCAB_UNIT,
        "method": "lemma_band_extrapolation",
    }


# ---------------------------------------------------------------------------
# 对外的两个入口
# ---------------------------------------------------------------------------

def estimate(
    responses: Sequence[object],
    *,
    bands: Sequence[str] = CEFR_BANDS,
    compute_vocabulary: bool = True,
    grid: Sequence[float] = GRID,
) -> dict:
    """给定作答，返回 EAP θ/SE/区间/CEFR 带/词汇量区间。

    ``bands`` 限定**输出**带：固定 24 题卷只有 A1–C1 题目，调用方传
    ``bands=('A1','A2','B1','B2','C1')`` 就不会把「全对」报成 C2。

    空响应也能跑：后验退化为先验（θ=0、SE=1.2、B1），调用方用
    ``n == 0`` 判断「没有证据」，不要展示成测量结果。
    """
    pairs = _normalize_responses(responses)
    output_bands = tuple(bands)
    if not output_bands:
        raise AssessmentError("bands 不能为空。")
    for band in output_bands:
        band_center(band)

    density = posterior(pairs, grid=grid)
    theta, se = _posterior_moments(grid, density)
    ci_low = max(GRID_MIN, theta - CI95_Z * se)
    ci_high = min(GRID_MAX, theta + CI95_Z * se)
    hpd_low, hpd_high = _hpd_interval(grid, density)
    masses = band_posterior(grid, density, bands=output_bands)
    point = _point_band(masses, output_bands)
    interval = band_interval(point, bands=output_bands)

    result = {
        "calibrationVersion": CALIBRATION_VERSION,
        "n": len(pairs),
        "correct": sum(correct for _band, correct in pairs),
        "theta": round(theta, 4),
        "se": round(se, 4),
        "ci95": {"low": round(ci_low, 4), "high": round(ci_high, 4)},
        "ci80": {"low": round(hpd_low, 4), "high": round(hpd_high, 4)},
        "band": point,
        "bandPosterior": {
            band: round(value, 4) for band, value in masses.items()
        },
        "interval": interval,
        "precision": {
            "label": precision_label(se),
            "se": round(se, 4),
            "value": precision_value(se),
        },
    }
    if compute_vocabulary:
        result["vocabulary"] = vocab_interval(theta, grid, density)
    return result


def precision_label(se: float) -> str:
    """精度三档：高（SE≤0.45）/ 中（0.45–0.60）/ 低（>0.60）。"""
    if se <= PRECISION_HIGH_MAX_SE:
        return "high"
    if se <= PRECISION_MEDIUM_MAX_SE:
        return "medium"
    return "low"


def precision_value(se: float) -> float:
    return {
        "high": PRECISION_VALUE_HIGH,
        "medium": PRECISION_VALUE_MEDIUM,
        "low": PRECISION_VALUE_LOW,
    }[precision_label(se)]


def validity_label(flags: Sequence[str]) -> str:
    """作答可信度三档（只反映作答行为，不反映精度）。

    ``flags`` 约定：``pseudo_ok/pseudo_overclaim``、``duration_ok/
    duration_short/duration_long/duration_unknown``、``completion_ok/
    completion_low``。出现两个及以上负面标记 → 低；一个 → 中。
    """
    flags = list(flags)
    # 伪词过度声称是「明知不确定还声称认识」，单独出现也直接判低。
    if "pseudo_overclaim" in flags:
        return "low"
    negatives = [flag for flag in flags if flag in _NEGATIVE_VALIDITY_FLAGS]
    if len(negatives) >= 2:
        return "low"
    if negatives:
        return "medium"
    return "high"


_NEGATIVE_VALIDITY_FLAGS = frozenset(
    {
        "pseudo_overclaim",
        "duration_short",
        "duration_long",
        "completion_low",
        "answers_too_fast",
    }
)

VALIDITY_VALUE = {"high": 0.90, "medium": 0.65, "low": 0.35}


def validity_value(label: str) -> float:
    return VALIDITY_VALUE.get(label, 0.35)


def confidence_value(precision: Mapping, validity: Mapping) -> float:
    """旧字段 ``confidence`` = min(precision, validity)（计划书 §5.8）。"""
    precision_score = precision.get("value")
    if precision_score is None:
        precision_score = precision_value(float(precision.get("se") or 0.6))
    validity_score = validity.get("value")
    if validity_score is None:
        validity_score = validity_value(str(validity.get("label") or "low"))
    return round(min(float(precision_score), float(validity_score)), 4)


def band_label(interval: Mapping) -> str | None:
    low = interval.get("low")
    high = interval.get("high")
    if not low or not high:
        return None
    return f"{low}–{high}"
