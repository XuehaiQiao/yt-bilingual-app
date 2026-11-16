"""能力定位测试（M4，计划书 §13.2 M4 / §4.3、specs/016）。

一次 12 分钟定位测：24 道词汇题 + 5 道阅读题，另混入 3 道**伪词题**（不存在的
词）。结果只给 **CEFR 区间 + 置信度 + 强弱项 + 1 条建议**，不承诺考试分数。

设计要点（规格见 ``specs/016-placement/spec.md``）：

- **题库只读**：``content/placement/{vocab,reading,pseudo}.json``，启动后懒加载并
  做结构校验；文件缺失/损坏抛 :class:`PlacementUnavailable`（路由 503），不静默
  降级成空题。
- **只存会话，不存整卷**：每次会话按 ``seed = "placement.serve.v1:<sessionId>"``
  确定性地抽题（词频带分层：A1 5 / A2 5 / B1 5 / B2 5 / C1 4，再从 3–5 个伪词里
  抽 3 个，5 篇阅读全出）并打乱。开始和提交用同一个 sessionId 重算，得到同一份
  题面；接口只下发卷面，不下发答案。
- **不下发银行 id**：对外的 ``itemId`` 是会话内编号 ``q-01``…``q-32``，伪词和
  真词外观完全一致（都是 vocab 题面、4 个选项），避免从 id 看出真假。
- **不认识就跳过**：``chosenIndex = -1``（或省略）表示「不认识」。真词跳过 = 答错；
  伪词跳过 = 诚实作答。伪词选任一选项 = 声称认识（overclaiming），用于猜测检测。
  计划书 §4.3 的「4 选 1 + 1 个不认识选项」在接口里由 ``-1`` 承载。
- **加权计分**：按难度带 A1=0.5 / A2=1.0 / B1=1.5 / B2=2.0 / C1=2.5 加权，伪词
  不参与得分。加权正确率 → 点估计带 → 区间 = 点估计 ±1 带（A1/C1 处截断）。
- **置信度**：完成度 + 用时合理性 - 伪词过度声称惩罚；低于阈值显示「低」。
- **样本口径**：完成过定位测的**不同用户数 < 100** 时 ``preliminary=True``，文案
  明确「初步估计」。门槛常量见 :data:`PRELIMINARY_SAMPLE_THRESHOLD`。
- **幂等**：同一会话重复提交直接返回首次结果（不重复写答案、不重复更新画像）。
  同一用户未完成会话由 ``GET /api/placement/start`` 复用；``POST /api/placement/reset``
  只把未完成会话标为 abandoned，已完成历史与画像保留。
- **归属**：登录用户 = ``users.id``；游客 = ``guest:<sha256>``（``guest.guest_id``），
  与 watch_events 同一套口径。游客结果不跨设备：换设备/Cookie 就是另一个身份。

表由 ``0009_placement`` 迁移创建，运行时不建表；表缺失抛
:class:`PlacementUnavailable`（路由 503）。
"""
from __future__ import annotations

import json
import logging
import os
import random
import sqlite3
import time
import uuid
from dataclasses import dataclass
from functools import lru_cache
from typing import Mapping, Sequence

import ability
import assessment
import config

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 常量（规格冻结；改这些值要同步 specs/016 与测试）
# ---------------------------------------------------------------------------

CEFR_BANDS: tuple[str, ...] = ("A1", "A2", "B1", "B2", "C1")
BAND_INDEX: dict[str, int] = {band: index for index, band in enumerate(CEFR_BANDS)}
BAND_WEIGHTS: dict[str, float] = {
    "A1": 0.5,
    "A2": 1.0,
    "B1": 1.5,
    "B2": 2.0,
    "C1": 2.5,
}

ITEM_TYPES: tuple[str, ...] = ("vocab", "reading", "pseudo")
SESSION_STATUSES: tuple[str, ...] = ("in_progress", "submitted", "abandoned")

SERVED_VOCAB = 24
SERVED_PSEUDO = 3
SERVED_READING = 5
SERVED_TOTAL = SERVED_VOCAB + SERVED_PSEUDO + SERVED_READING  # 32

# 计划书 §4.3：10–12 分钟。服务端只做「记录 + 展示」，超时不禁考（用户可能中途
# 接电话），但用时明显异常会折减置信度。
DURATION_LIMIT_MS = 12 * 60 * 1000
MAX_DURATION_MS = 24 * 60 * 60 * 1000

# n < 100 一律标「初步估计」（计划书 §4.3 / §13.2 M4 验收②）。
PRELIMINARY_SAMPLE_THRESHOLD = 100

DISCLAIMER = (
    "这是定位估计，不是考试分数：区间表示不确定范围；"
    f"完成过定位测的用户不足 {PRELIMINARY_SAMPLE_THRESHOLD} 人前，结果一律标为初步估计。"
)

# 词汇量是「按 lemma 计的粗略区间中值」，不是精确计数；UI 必须带「约」。
VOCAB_ESTIMATES: dict[str, int] = {
    "A1": 1500,
    "A2": 3000,
    "B1": 5000,
    "B2": 8000,
    "C1": 12000,
}

# 启发式校准（heuristic.v1）：加权正确率 → 点估计带。阈值按「本带约 90% 掌握、
# 高一带约 40%、更高带接近随机」的离线估计定，**不是 IRT/CAT 标定结果**；
# 计划书要求的 CAT 离线模拟（1 人日）与教研审校后再调。改阈值请同时改
# specs/016 与 tests/test_placement.py 的区间断言。
CALIBRATION = assessment.CALIBRATION_VERSION
# 固定 24 题卷只出 A1–C1 题目；输出带也限制在 A1–C1，避免全对被报成 C2。
OUTPUT_BANDS: tuple[str, ...] = ("A1", "A2", "B1", "B2", "C1")
OVERALL_THRESHOLDS: dict[str, float] = {
    "A1": 0.00,
    "A2": 0.27,
    "B1": 0.44,
    "B2": 0.60,
    "C1": 0.78,
}
VOCAB_THRESHOLDS: dict[str, float] = {
    "A1": 0.00,
    "A2": 0.27,
    "B1": 0.43,
    "B2": 0.60,
    "C1": 0.79,
}

MEASURED_DOMAINS: tuple[str, ...] = ("vocab",)
# 本测不测听/说/写：听力是行为弱测（不在这 12 分钟里），说/写明确「未测」。
NOT_MEASURED_DOMAINS: tuple[str, ...] = ("listening", "speaking", "writing")

PLACEMENT_TABLES: tuple[str, ...] = (
    "placement_sessions",
    "placement_answers",
    "user_profiles",
)

_VOCAB_QUOTAS: dict[str, int] = {"A1": 5, "A2": 5, "B1": 5, "B2": 5, "C1": 4}

# 置信度标签（中文给 UI，英文给接口/测试）。
CONFIDENCE_LABELS: tuple[tuple[float, str, str], ...] = (
    (0.70, "high", "高"),
    (0.45, "medium", "中"),
    (0.00, "low", "低"),
)

# 答案表里的选择：-1 = 不认识/跳过，0–3 = 四个选项。
UNKNOWN_INDEX = -1


# ---------------------------------------------------------------------------
# 异常（路由映射：Unavailable→503 / NotFound→404 / Conflict→409 / Invalid→400）
# ---------------------------------------------------------------------------

class PlacementError(Exception):
    """定位测领域错误基类。"""


class PlacementUnavailable(PlacementError):
    """题库或数据库表不可用（未跑 0009 迁移 / 题池文件损坏）。"""


class PlacementInvalid(PlacementError):
    """请求参数或会话内容非法。"""


class PlacementNotFound(PlacementError):
    """会话不存在，或不属于当前用户（不泄露存在性）。"""


class PlacementConflict(PlacementError):
    """会话状态已变化（并发提交/已作废），需要重新开始。"""


# ---------------------------------------------------------------------------
# 题库加载
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Item:
    """一道题（内部模型；正确项只留在服务端）。"""

    id: str
    type: str  # vocab / reading / pseudo
    band: str
    prompt: str  # 词汇题=英文词；阅读题=题干
    options: tuple[str, ...]
    answer_index: int | None  # 伪词为 None（没有正确答案）
    passage: str | None = None
    example: str | None = None


@dataclass(frozen=True)
class Bank:
    """三份题库文件合并后的只读视图。"""

    vocab: tuple[Item, ...]
    reading: tuple[Item, ...]
    pseudo: tuple[Item, ...]

    @property
    def all_items(self) -> tuple[Item, ...]:
        return self.vocab + self.reading + self.pseudo


def load_bank() -> Bank:
    """加载并缓存 ``config.PLACEMENT_DIR`` 下的题库（按绝对路径缓存）。"""
    return _load_bank(os.path.abspath(config.PLACEMENT_DIR))


@lru_cache(maxsize=4)
def _load_bank(directory: str) -> Bank:
    """从目录读三份 JSON，校验结构与题目契约；失败抛 PlacementUnavailable。"""
    vocab = _read_items(os.path.join(directory, "vocab.json"), "vocab", expected=30)
    reading = _read_items(
        os.path.join(directory, "reading.json"), "reading", expected=5
    )
    pseudo = _read_items(
        os.path.join(directory, "pseudo.json"), "pseudo", expected=(3, 5)
    )

    seen: set[str] = set()
    for item in vocab + reading + pseudo:
        if item.id in seen:
            raise PlacementUnavailable(f"定位测题库 id 重复：{item.id}")
        seen.add(item.id)

    return Bank(vocab=vocab, reading=reading, pseudo=pseudo)


def _read_items(path: str, kind: str, *, expected) -> tuple[Item, ...]:
    """读一份题库文件；``expected`` 为精确数量或 (min, max) 区间。"""
    try:
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError as exc:
        raise PlacementUnavailable(
            f"定位测题库文件不存在：{path}（content/placement/ 应随仓库分发）"
        ) from exc
    except (OSError, ValueError) as exc:
        raise PlacementUnavailable(f"定位测题库读取失败：{path}：{exc}") from exc

    meta = payload.get("_meta") if isinstance(payload, dict) else None
    if not isinstance(meta, dict):
        raise PlacementUnavailable(f"定位测题库缺少 _meta：{path}")
    notice = str(meta.get("notice") or "")
    if "待教研审校" not in notice:
        # 未标草稿的题库不允许直接上线：这是内容安全/效度闸门，不是格式检查。
        raise PlacementUnavailable(
            f"定位测题库未标「草稿，待教研审校」：{path}"
        )

    raw_items = payload.get("items")
    if not isinstance(raw_items, list):
        raise PlacementUnavailable(f"定位测题库 items 必须是数组：{path}")

    if isinstance(expected, tuple):
        low, high = expected
        if not low <= len(raw_items) <= high:
            raise PlacementUnavailable(
                f"定位测题库 {kind} 数量应为 {low}–{high}，实际 {len(raw_items)}：{path}"
            )
    elif len(raw_items) != expected:
        raise PlacementUnavailable(
            f"定位测题库 {kind} 数量应为 {expected}，实际 {len(raw_items)}：{path}"
        )

    items = tuple(_parse_item(raw, kind, path, index) for index, raw in enumerate(raw_items))
    return items


def _parse_item(raw, kind: str, path: str, index: int) -> Item:
    """校验单题字段并转成 Item；任何问题都视为题库损坏（503）。"""
    where = f"{path} items[{index}]"
    if not isinstance(raw, dict):
        raise PlacementUnavailable(f"{where} 必须是对象")

    item_id = raw.get("id")
    band = raw.get("band")
    options = raw.get("options")
    if not isinstance(item_id, str) or not item_id.strip():
        raise PlacementUnavailable(f"{where} 缺少 id")
    if band not in BAND_WEIGHTS:
        raise PlacementUnavailable(f"{where} 难度带非法：{band!r}")
    if (
        not isinstance(options, list)
        or len(options) != 4
        or not all(isinstance(option, str) and option.strip() for option in options)
    ):
        raise PlacementUnavailable(f"{where} 需要 4 个非空中文选项")
    if len(set(options)) != 4:
        raise PlacementUnavailable(f"{where} 选项重复")

    if kind == "reading":
        passage = raw.get("passage")
        question = raw.get("question")
        if not isinstance(passage, str) or not passage.strip():
            raise PlacementUnavailable(f"{where} 缺少 passage")
        if not isinstance(question, str) or not question.strip():
            raise PlacementUnavailable(f"{where} 缺少 question")
        prompt = question.strip()
        extra = {"passage": passage.strip()}
    else:
        word = raw.get("word")
        if not isinstance(word, str) or not word.strip():
            raise PlacementUnavailable(f"{where} 缺少 word")
        prompt = word.strip()
        extra = {"example": raw.get("example") or None}

    answer_index = raw.get("answerIndex")
    if kind == "pseudo":
        if answer_index is not None:
            raise PlacementUnavailable(f"{where} 伪词不应有 answerIndex")
        answer_index = None
    else:
        if (
            isinstance(answer_index, bool)
            or not isinstance(answer_index, int)
            or not 0 <= answer_index <= 3
        ):
            raise PlacementUnavailable(f"{where} answerIndex 必须是 0–3 的整数")

    return Item(
        id=item_id.strip(),
        type=kind,
        band=band,
        prompt=prompt,
        options=tuple(option.strip() for option in options),
        answer_index=answer_index,
        **extra,
    )


# ---------------------------------------------------------------------------
# 会话内抽题（确定性：begin/submit 用同一 sessionId 重算同一份卷）
# ---------------------------------------------------------------------------

def sample_items(session_id: str) -> list[Item]:
    """按 sessionId 确定性抽题并打乱；同一 sessionId 永远得到同一份卷。"""
    bank = load_bank()
    rng = random.Random(f"placement.serve.v1:{session_id}")

    vocab: list[Item] = []
    for band in CEFR_BANDS:
        pool = [item for item in bank.vocab if item.band == band]
        take = min(_VOCAB_QUOTAS[band], len(pool))
        vocab.extend(rng.sample(pool, take))

    # 理论上 24 题正好由分层配额凑满；题库调整后若某带不足，从剩余题补齐，
    # 保证卷面始终 24 道词汇题（否则总题数/进度会漂移）。
    if len(vocab) < SERVED_VOCAB:
        remaining = [item for item in bank.vocab if item not in vocab]
        rng.shuffle(remaining)
        vocab.extend(remaining[: SERVED_VOCAB - len(vocab)])

    pseudo = list(rng.sample(bank.pseudo, min(SERVED_PSEUDO, len(bank.pseudo))))
    items = vocab + pseudo + list(bank.reading)
    rng.shuffle(items)
    return items[:SERVED_TOTAL]


def served_item_id(index: int) -> str:
    """对外 itemId（会话内编号；不暴露银行 id 与真假）。"""
    return f"q-{index:02d}"


def _served_map(session_id: str) -> dict[str, Item]:
    items = sample_items(session_id)
    return {
        served_item_id(index): item for index, item in enumerate(items, start=1)
    }


def _public_item(item_id: str, item: Item) -> dict:
    """下发卷面：只给题干/选项/难度带，**绝不含 answerIndex**。"""
    payload = {
        "itemId": item_id,
        "type": "reading" if item.type == "reading" else "vocab",
        "band": item.band,
        "prompt": item.prompt,
        "options": list(item.options),
        # 计划书 §4.3 的「不认识」选项：用 chosenIndex=-1 提交，不占 4 个选项位。
        "skippable": True,
    }
    if item.passage:
        payload["passage"] = item.passage
    return payload


# ---------------------------------------------------------------------------
# 评分（纯函数，便于单测）
# ---------------------------------------------------------------------------

def _band_from_score(score: float, thresholds: Mapping[str, float]) -> str:
    band = "A1"
    for candidate in CEFR_BANDS:
        if score >= thresholds[candidate]:
            band = candidate
    return band


def _domain_stats(items: Sequence[Item], chosen: Mapping[str, int]) -> dict:
    """一个维度的题量/答对/加权正确率/分带明细（伪词调用方不要传进来）。"""
    total = len(items)
    answered = 0
    correct = 0
    earned = 0.0
    total_weight = 0.0
    bands = {band: {"correct": 0, "total": 0} for band in CEFR_BANDS}

    for item in items:
        weight = BAND_WEIGHTS[item.band]
        total_weight += weight
        bands[item.band]["total"] += 1
        picked = int(chosen.get(item.id, UNKNOWN_INDEX))
        if picked >= 0:
            answered += 1
        if item.answer_index is not None and picked == item.answer_index:
            correct += 1
            earned += weight
            bands[item.band]["correct"] += 1

    return {
        "total": total,
        "answered": answered,
        "correct": correct,
        "accuracy": round(correct / total, 4) if total else 0.0,
        "weightedScore": round(earned / total_weight, 4) if total_weight else 0.0,
        "bands": {
            band: stats for band, stats in bands.items() if stats["total"] > 0
        },
    }


def _duration_factor(duration_ms: int) -> float:
    """用时是否像认真作答：太快像乱点，太慢可能被打断。"""
    if duration_ms < 60_000:
        return 0.40
    if duration_ms < 180_000:
        return 0.75
    if duration_ms <= DURATION_LIMIT_MS + 60_000:
        return 1.00
    if duration_ms <= 20 * 60 * 1000:
        return 0.75
    return 0.50


def _confidence_label(value: float) -> tuple[str, str]:
    for threshold, english, chinese in CONFIDENCE_LABELS:
        if value >= threshold:
            return english, chinese
    return "low", "低"


def _advice(band: str | None, *, suspicion: float) -> str:
    """规则生成 1 条建议（与能力档案 shim 共用同一段文案，保证两页一致）。"""
    return ability.advice_for_vocabulary(band, suspicion=suspicion)


def _validity_flags(
    real_items: Sequence[Item],
    chosen: Mapping[str, int],
    *,
    duration_ms: int,
    suspicion: float,
    elapsed_ms: Mapping[str, int | None],
) -> list[str]:
    """作答可信度标记（只影响 validity，不进 θ；计划书 §5.8/§5.10）。"""
    flags: list[str] = []
    flags.append("pseudo_overclaim" if suspicion > 1.0 / 3.0 else "pseudo_ok")
    if duration_ms < 60_000:
        flags.append("duration_short")
    elif duration_ms > 20 * 60 * 1000:
        flags.append("duration_long")
    else:
        flags.append("duration_ok")
    answered_real = sum(
        1 for item in real_items if int(chosen.get(item.id, UNKNOWN_INDEX)) >= 0
    )
    ratio = answered_real / len(real_items) if real_items else 0.0
    flags.append("completion_ok" if ratio >= 0.6 else "completion_low")
    timed = [
        value
        for item in real_items
        for value in [elapsed_ms.get(item.id)]
        if isinstance(value, int) and value >= 0
    ]
    if timed and sum(1 for value in timed if value < 2_000) > len(timed) / 2:
        flags.append("answers_too_fast")
    return flags


def score_session(
    served: Sequence[Item],
    chosen: Mapping[str, int],
    *,
    duration_ms: int,
    sample_size: int,
    elapsed_ms: Mapping[str, int | None] | None = None,
) -> dict:
    """给一份卷面与选择打分，返回可直接落库/返回的结果。

    ``chosen`` 以 **Item.id（银行 id）** 为键，值 -1 表示不认识/跳过。
    伪词不参与得分，只统计 claimed（选任一选项 = 过度声称）。

    M1 起 CEFR 只从**词汇识别**用 Rasch/EAP 估计（计划书 §5.1）：阅读 5 题
    证据不足，不给带；强弱项/建议也不再含 reading 维度。
    """
    elapsed_by_item = elapsed_ms or {}
    vocab_items = [item for item in served if item.type == "vocab"]
    reading_items = [item for item in served if item.type == "reading"]
    pseudo_items = [item for item in served if item.type == "pseudo"]
    real_items = vocab_items + reading_items

    vocab = _domain_stats(vocab_items, chosen)
    reading = _domain_stats(reading_items, chosen)
    overall = _domain_stats(real_items, chosen)

    claimed = sum(
        1 for item in pseudo_items if int(chosen.get(item.id, UNKNOWN_INDEX)) >= 0
    )
    pseudo_total = len(pseudo_items)
    suspicion = round(claimed / pseudo_total, 4) if pseudo_total else 0.0

    # 词汇识别 → Rasch/EAP；输出带限制在 A1–C1（本题库只有这 5 个带）。
    vocab_pairs = [
        (item.band, int(chosen.get(item.id, UNKNOWN_INDEX)) == item.answer_index)
        for item in vocab_items
        if item.answer_index is not None
    ]
    calibration = assessment.estimate(
        vocab_pairs, bands=OUTPUT_BANDS, compute_vocabulary=True
    )
    band = calibration["band"]
    interval = calibration["interval"]
    vocab_estimate = calibration["vocabulary"]
    precision = calibration["precision"]
    cefr = {
        "point": band,
        "low": interval["low"],
        "high": interval["high"],
        "label": interval["label"],
    }

    flags = _validity_flags(
        real_items,
        chosen,
        duration_ms=duration_ms,
        suspicion=suspicion,
        elapsed_ms=elapsed_by_item,
    )
    validity = {"label": assessment.validity_label(flags), "flags": flags}
    confidence = round(
        min(
            float(precision["value"]),
            assessment.validity_value(validity["label"]),
        ),
        4,
    )
    confidence_label, confidence_label_zh = _confidence_label(confidence)
    preliminary = sample_size < PRELIMINARY_SAMPLE_THRESHOLD

    strengths = [f"词汇识别（{band}）"] if band else []
    weaknesses: list[str] = []
    advice = _advice(band, suspicion=suspicion)
    answered_real = sum(1 for item in real_items if int(chosen.get(item.id, -1)) >= 0)
    answered_all = sum(1 for item in served if int(chosen.get(item.id, -1)) >= 0)
    completion = round(answered_real / len(real_items), 4) if real_items else 0.0

    breakdown = {
        "version": "placement.v2",
        "calibration": CALIBRATION,
        "calibrationVersion": CALIBRATION,
        "vocab": {
            **vocab,
            "band": band,
            "theta": calibration["theta"],
            "se": calibration["se"],
            "ci95": calibration["ci95"],
            "ci80": calibration["ci80"],
            "interval": interval,
            "bandPosterior": calibration["bandPosterior"],
            "estimate": vocab_estimate,
            "precision": precision,
        },
        # 阅读：只留原始统计与「证据不足」状态，**不出现 band**（契约 A1）。
        "reading": {
            **reading,
            "status": "insufficient",
            "items": len(reading_items),
            "method": "reading.5item.v1",
            "note": "题量少，不足以单独评级；下一版 20 题小测。",
        },
        "pseudo": {
            "total": pseudo_total,
            "claimed": claimed,
            "skipped": pseudo_total - claimed,
            "suspicion": suspicion,
        },
        "overall": overall,
        "answered": answered_all,
        "skipped": len(served) - answered_all,
        "completionRatio": completion,
        "durationMs": int(duration_ms),
        "precision": precision,
        "validity": validity,
        "strengths": strengths,
        "weaknesses": weaknesses,
        "advice": advice,
        "measuredDomains": list(MEASURED_DOMAINS),
        "notMeasured": list(NOT_MEASURED_DOMAINS),
        "sampleSize": int(sample_size),
        "preliminary": preliminary,
        "disclaimer": DISCLAIMER,
    }

    return {
        "score": round(overall["weightedScore"] * 100, 1),
        "cefr": cefr,
        "confidence": confidence,
        "confidenceLabel": confidence_label,
        "confidenceLabelZh": confidence_label_zh,
        "pseudoWordSuspicion": suspicion,
        "preliminary": preliminary,
        "sampleSize": int(sample_size),
        "durationMs": int(duration_ms),
        "calibration": {
            "version": CALIBRATION,
            "theta": calibration["theta"],
            "se": calibration["se"],
            "ci95": calibration["ci95"],
            "ci80": calibration["ci80"],
            "band": band,
            "bandPosterior": calibration["bandPosterior"],
            "interval": interval,
            "precision": precision,
            "validity": validity,
            "confidence": confidence,
            "vocabulary": vocab_estimate,
        },
        "breakdown": breakdown,
        "disclaimer": DISCLAIMER,
    }


# ---------------------------------------------------------------------------
# SQLite 读写（表只由 0009_placement 创建）
# ---------------------------------------------------------------------------

def now_ms() -> int:
    return int(time.time() * 1000)


def _db_path() -> str:
    return config.AUTH_DB_PATH


def _connect() -> sqlite3.Connection:
    """连库（不建库、不建目录：schema 只由迁移创建）。"""
    path = _db_path()
    if not os.path.exists(path):
        raise PlacementUnavailable(
            f"数据库文件不存在：{path}（先运行 alembic upgrade head）"
        )
    try:
        conn = sqlite3.connect(path, timeout=10)
    except sqlite3.Error as exc:
        raise PlacementUnavailable(f"定位测数据库不可用：{exc}") from exc
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _table_names(conn: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def _require_tables(conn: sqlite3.Connection) -> None:
    existing = _table_names(conn)
    missing = [table for table in PLACEMENT_TABLES if table not in existing]
    if missing:
        raise PlacementUnavailable(
            f"数据库缺少表 {missing}（先运行 alembic upgrade head；"
            "定位测需要 0009_placement 及更早迁移）。"
        )


def _sample_size(conn: sqlite3.Connection) -> int:
    """完成过定位测的不同用户数（游客按 ``guest:<sha256>`` 计）。"""
    row = conn.execute(
        "SELECT COUNT(DISTINCT user_id) AS total FROM placement_sessions "
        "WHERE status = 'submitted'"
    ).fetchone()
    return int(row["total"] or 0)


def _predicted_sample_size(conn: sqlite3.Connection, identity: str) -> int:
    """本次提交后的样本量（同一用户重复完成不重复计数）。"""
    total = _sample_size(conn)
    already = conn.execute(
        "SELECT 1 FROM placement_sessions "
        "WHERE user_id = ? AND status = 'submitted' LIMIT 1",
        (identity,),
    ).fetchone()
    return total if already else total + 1


def _find_active(
    conn: sqlite3.Connection, identity: str
) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM placement_sessions "
        "WHERE user_id = ? AND status = 'in_progress' "
        "ORDER BY started_at DESC, rowid DESC LIMIT 1",
        (identity,),
    ).fetchone()


def _load_row(conn: sqlite3.Connection, session_id: str, identity: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM placement_sessions WHERE id = ? AND user_id = ?",
        (session_id, identity),
    ).fetchone()


def adopt_guest_session(session_id: str, guest_hash: str, user_id: str) -> bool:
    """把「游客开始的定位测会话」转给刚登录的用户（幂等）。

    只在该会话当前归属 ``guest:<hash>`` 时生效；用于「先做定位测、做到一半
    登录/注册」的场景。转移后提交按登录用户评分。
    """
    if not session_id or not guest_hash or not user_id:
        return False
    owner = "guest:" + guest_hash
    try:
        conn = _connect()
    except PlacementUnavailable:
        return False
    try:
        try:
            _require_tables(conn)
        except PlacementUnavailable:
            # 定位测表还没迁移（例如只跑了旧迁移）：认领不应因此 500。
            return False
        with conn:
            cur = conn.execute(
                "UPDATE placement_sessions SET user_id = ?, guest_hash = NULL "
                "WHERE id = ? AND user_id = ?",
                (user_id, session_id, owner),
            )
        return cur.rowcount > 0
    finally:
        conn.close()


def claim_guest_sessions(guest_hash: str, user_id: str) -> int:
    """把游客名下的定位测会话与画像迁移到登录账号（登录认领时调用）。"""
    if not guest_hash or not user_id:
        return 0
    owner = "guest:" + guest_hash
    try:
        conn = _connect()
    except PlacementUnavailable:
        return 0
    try:
        try:
            _require_tables(conn)
        except PlacementUnavailable:
            return 0
        with conn:
            cur = conn.execute(
                "UPDATE placement_sessions SET user_id = ?, guest_hash = NULL "
                "WHERE user_id = ?",
                (user_id, owner),
            )
            moved = int(cur.rowcount or 0)
            conn.execute(
                "UPDATE user_profiles SET user_id = ? "
                "WHERE user_id = ? AND NOT EXISTS "
                "(SELECT 1 FROM user_profiles WHERE user_id = ?)",
                (user_id, owner, user_id),
            )
        return moved
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 对外用例：start / submit / profile / reset
# ---------------------------------------------------------------------------

def start(identity: str, guest_hash: str | None = None, *, now: int | None = None) -> dict:
    """开始（或复用）一次定位测；返回卷面，不含答案。"""
    if not identity:
        raise PlacementInvalid("缺少定位测身份。")
    # 先验证题库：题库坏了就不该落一条永远无法提交的 in_progress 会话。
    load_bank()
    stamp = int(now) if now is not None else now_ms()
    conn = _connect()
    try:
        _require_tables(conn)
        try:
            ability.require_tables(conn)
        except ability.AbilityUnavailable as exc:
            raise PlacementUnavailable(str(exc)) from exc
        row = _find_active(conn, identity)
        resumed = row is not None
        if row is None:
            session_id = uuid.uuid4().hex
            try:
                with conn:
                    conn.execute(
                        "INSERT INTO placement_sessions "
                        "(id, user_id, guest_hash, status, started_at) "
                        "VALUES (?, ?, ?, 'in_progress', ?)",
                        (session_id, identity, guest_hash, stamp),
                    )
            except sqlite3.IntegrityError:
                # 并发 start：另一个请求已建了未完成会话，直接复用。
                row = _find_active(conn, identity)
                if row is None:
                    raise
                resumed = True
            else:
                row = _load_row(conn, session_id, identity)
                if row is None:  # pragma: no cover - 插后即查，理论不可达
                    raise PlacementConflict("定位测会话创建失败，请重试。")

        attempt = int(
            conn.execute(
                "SELECT COUNT(*) AS total FROM placement_sessions WHERE user_id = ?",
                (identity,),
            ).fetchone()["total"]
        )
        sample_size = _sample_size(conn)
        items = sample_items(row["id"])
        served = [
            _public_item(served_item_id(index), item)
            for index, item in enumerate(items, start=1)
        ]
        return {
            "sessionId": row["id"],
            "status": "in_progress",
            "resumed": resumed,
            "attempt": attempt,
            "startedAt": int(row["started_at"]),
            "durationLimitMs": DURATION_LIMIT_MS,
            "itemCount": len(served),
            "totals": {
                "vocab": SERVED_VOCAB + SERVED_PSEUDO,
                "reading": SERVED_READING,
                "all": SERVED_TOTAL,
            },
            "instructions": (
                "选择最接近的中文释义；不确定就选「不认识」（提交 chosenIndex: -1）。"
                "12 分钟内完成即可，结果只给区间，不是考试分数。"
            ),
            "items": served,
            "preliminary": sample_size < PRELIMINARY_SAMPLE_THRESHOLD,
            "sampleSize": sample_size,
            "disclaimer": DISCLAIMER,
        }
    except sqlite3.OperationalError as exc:
        raise PlacementUnavailable(
            f"定位测暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()


def _normalize_answers(answers) -> dict[str, dict]:
    """校验并规范化 ``[{itemId, chosenIndex, elapsedMs?}]``。

    返回 ``{servedId: {"chosenIndex": -1..3, "elapsedMs": int|None}}``。
    ``elapsedMs`` 缺省为 None（旧客户端/批量写），不因此惩罚该题。
    """
    if not isinstance(answers, (list, tuple)):
        raise PlacementInvalid("answers 必须是数组。")
    if len(answers) > SERVED_TOTAL:
        raise PlacementInvalid(f"answers 最多 {SERVED_TOTAL} 条。")

    normalized: dict[str, dict] = {}
    for index, raw in enumerate(answers):
        if not isinstance(raw, dict):
            raise PlacementInvalid(f"answers[{index}] 必须是对象。")
        item_id = raw.get("itemId", raw.get("item_id"))
        if not isinstance(item_id, str) or not item_id.strip():
            raise PlacementInvalid(f"answers[{index}] 缺少 itemId。")
        item_id = item_id.strip()
        if item_id in normalized:
            raise PlacementInvalid(f"answers[{index}]：itemId 重复（{item_id}）。")

        value = raw.get("chosenIndex", raw.get("chosen_index"))
        if value is None:
            value = UNKNOWN_INDEX
        if isinstance(value, bool) or not isinstance(value, int):
            raise PlacementInvalid(
                f"answers[{index}]：chosenIndex 必须是 -1–3 的整数。"
            )
        if not UNKNOWN_INDEX <= value <= 3:
            raise PlacementInvalid(
                f"answers[{index}]：chosenIndex 必须在 -1–3（-1 = 不认识）。"
            )

        elapsed = raw.get("elapsedMs", raw.get("elapsed_ms"))
        if elapsed is None:
            elapsed = None
        elif isinstance(elapsed, bool) or not isinstance(elapsed, int):
            raise PlacementInvalid(
                f"answers[{index}]：elapsedMs 必须是整数毫秒或省略。"
            )
        elif elapsed < 0 or elapsed > MAX_DURATION_MS:
            raise PlacementInvalid(
                f"answers[{index}]：elapsedMs 超出合理范围。"
            )
        normalized[item_id] = {"chosenIndex": value, "elapsedMs": elapsed}
    return normalized


def _normalize_duration(
    duration_ms, *, started_at: int, now: int
) -> int:
    if duration_ms is None:
        # 服务端回算：会话放太久（>24h）时截到上限，避免写库触发 CHECK。
        duration = min(MAX_DURATION_MS, max(0, now - int(started_at)))
    else:
        if isinstance(duration_ms, bool) or not isinstance(duration_ms, int):
            raise PlacementInvalid("durationMs 必须是整数毫秒。")
        duration = duration_ms
    if duration < 0:
        raise PlacementInvalid("durationMs 不能为负数。")
    if duration > MAX_DURATION_MS:
        raise PlacementInvalid("durationMs 超出合理范围（最长 24 小时）。")
    return int(duration)


def submit(
    identity: str,
    guest_hash: str | None,
    session_id: str,
    answers,
    duration_ms: int | None = None,
    *,
    now: int | None = None,
) -> dict:
    """提交作答并评分；同一会话重复提交幂等返回首次结果。"""
    if not identity:
        raise PlacementInvalid("缺少定位测身份。")
    if not isinstance(session_id, str) or not session_id.strip():
        raise PlacementInvalid("缺少 sessionId。")
    session_id = session_id.strip()
    stamp = int(now) if now is not None else now_ms()
    provided = _normalize_answers(answers)

    conn = _connect()
    try:
        _require_tables(conn)
        try:
            ability.require_tables(conn)
        except ability.AbilityUnavailable as exc:
            raise PlacementUnavailable(str(exc)) from exc
        row = _load_row(conn, session_id, identity)
        if row is None:
            raise PlacementNotFound("定位测会话不存在或不属于当前用户。")
        if row["status"] == "submitted":
            return _result_from_row(conn, row, identity, reused=True)
        if row["status"] != "in_progress":
            raise PlacementConflict("该定位测会话已结束，请重新开始一次。")

        duration = _normalize_duration(
            duration_ms, started_at=int(row["started_at"]), now=stamp
        )
        served_by_id = _served_map(session_id)
        unknown = [item_id for item_id in provided if item_id not in served_by_id]
        if unknown:
            raise PlacementInvalid(f"未知 itemId：{unknown[0]}（不在本次卷面中）。")

        chosen_by_bank = {
            served_by_id[item_id].id: value["chosenIndex"]
            for item_id, value in provided.items()
        }
        elapsed_by_bank = {
            served_by_id[item_id].id: value["elapsedMs"]
            for item_id, value in provided.items()
        }
        items = list(served_by_id.values())
        sample_size = _predicted_sample_size(conn, identity)
        result = score_session(
            items,
            chosen_by_bank,
            duration_ms=duration,
            sample_size=sample_size,
            elapsed_ms=elapsed_by_bank,
        )
        submitted_at = stamp
        stored = json.dumps(result, ensure_ascii=False, sort_keys=True)

        try:
            with conn:
                for index, item_id in enumerate(served_by_id, start=1):
                    item = served_by_id[item_id]
                    picked = int(chosen_by_bank.get(item.id, UNKNOWN_INDEX))
                    correct = int(
                        item.answer_index is not None
                        and picked == item.answer_index
                    )
                    conn.execute(
                        "INSERT INTO placement_answers "
                        "(session_id, item_id, item_type, chosen_index, correct, "
                        "difficulty_band, answered_at, elapsed_ms) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            session_id,
                            item.id,
                            item.type,
                            picked,
                            correct,
                            item.band,
                            submitted_at,
                            elapsed_by_bank.get(item.id),
                        ),
                    )
                cursor = conn.execute(
                    "UPDATE placement_sessions SET status = 'submitted', "
                    "submitted_at = ?, duration_ms = ?, score = ?, cefr = ?, "
                    "confidence = ?, breakdown = ? "
                    "WHERE id = ? AND status = 'in_progress'",
                    (
                        submitted_at,
                        duration,
                        result["score"],
                        result["cefr"]["label"],
                        result["confidence"],
                        stored,
                        session_id,
                    ),
                )
                if cursor.rowcount != 1:
                    raise PlacementConflict(
                        "定位测会话状态已变化（可能已在另一处提交），请刷新结果。"
                    )
                _upsert_profile(conn, identity, result, submitted_at)
                ability.record_placement_result(
                    conn,
                    identity,
                    session_id,
                    items,
                    chosen_by_bank,
                    elapsed_by_bank,
                    result,
                    stamp=submitted_at,
                )
        except sqlite3.IntegrityError:
            # 并发重复提交：另一个请求已写入，回滚本次事务并返回首次结果。
            row = _load_row(conn, session_id, identity)
            if row is not None and row["status"] == "submitted":
                return _result_from_row(conn, row, identity, reused=True)
            raise PlacementConflict("定位测提交冲突，请重试。")

        row = _load_row(conn, session_id, identity)
        if row is None:  # pragma: no cover - 刚写入，理论不可达
            raise PlacementConflict("定位测会话状态异常，请重试。")
        return _result_from_row(conn, row, identity, reused=False)
    except sqlite3.OperationalError as exc:
        raise PlacementUnavailable(
            f"定位测暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()


def _upsert_profile(
    conn: sqlite3.Connection, identity: str, result: dict, updated_at: int
) -> None:
    """把本次结果写成当前画像（同一用户只留最新一份）。"""
    breakdown = result["breakdown"]
    cefr = result["cefr"]
    conn.execute(
        "INSERT INTO user_profiles "
        "(user_id, cefr, level_band_low, level_band_high, vocab_estimate, "
        "reading_estimate, confidence, pseudo_word_suspicion, updated_at, source) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'placement') "
        "ON CONFLICT(user_id) DO UPDATE SET "
        "cefr = excluded.cefr, level_band_low = excluded.level_band_low, "
        "level_band_high = excluded.level_band_high, "
        "vocab_estimate = excluded.vocab_estimate, "
        "reading_estimate = excluded.reading_estimate, "
        "confidence = excluded.confidence, "
        "pseudo_word_suspicion = excluded.pseudo_word_suspicion, "
        "updated_at = excluded.updated_at, source = excluded.source",
        (
            identity,
            cefr["label"],
            cefr["low"],
            cefr["high"],
            int(breakdown["vocab"]["estimate"]["point"]),
            None,
            float(result["confidence"]),
            float(result["pseudoWordSuspicion"]),
            updated_at,
        ),
    )


def _sanitize_stored_result(
    stored: dict, row: sqlite3.Row
) -> dict:
    """把旧版（或新旧混合）结果修成 M1 契约：阅读无带、建议不含阅读判断。

    用户可能重放一个 M1 之前提交的旧会话；数据库里的 JSON 仍带
    ``breakdown.reading.band`` 与「阅读短板」建议。这里在响应层做一次
    有意的破坏性降级，保证任何用户可见 payload 都不再出现阅读带（A1/A2）。
    """
    if not isinstance(stored, dict):
        stored = {}
    breakdown = stored.get("breakdown")
    if not isinstance(breakdown, dict):
        breakdown = {}
        stored["breakdown"] = breakdown

    reading = breakdown.get("reading")
    if isinstance(reading, dict) and "band" in reading:
        reading.pop("band", None)
    if not isinstance(reading, dict):
        breakdown["reading"] = {
            "total": SERVED_READING,
            "answered": 0,
            "correct": 0,
            "accuracy": 0.0,
            "weightedScore": 0.0,
            "bands": {},
        }
        reading = breakdown["reading"]
    reading["status"] = "insufficient"
    reading["items"] = int(reading.get("total") or SERVED_READING)
    reading["method"] = "reading.5item.v1"
    reading["note"] = "题量少，不足以单独评级；下一版 20 题小测。"

    vocab = breakdown.get("vocab")
    band = vocab.get("band") if isinstance(vocab, dict) else None
    if band not in BAND_INDEX:
        label = row["cefr"] or "A1–A2"
        low, _, high = label.partition("–")
        band = high if high in BAND_INDEX else (low if low in BAND_INDEX else "A1")
        if isinstance(vocab, dict):
            vocab.setdefault("band", band)
    interval = assessment.band_interval(band, bands=OUTPUT_BANDS)
    stored["cefr"] = {"point": band, **interval}

    breakdown["measuredDomains"] = list(MEASURED_DOMAINS)
    breakdown["notMeasured"] = list(NOT_MEASURED_DOMAINS)
    breakdown["strengths"] = [
        item for item in breakdown.get("strengths", []) if "阅读" not in str(item)
    ]
    breakdown["weaknesses"] = [
        item for item in breakdown.get("weaknesses", []) if "阅读" not in str(item)
    ]
    suspicion = stored.get("pseudoWordSuspicion")
    try:
        suspicion = float(suspicion or 0.0)
    except (TypeError, ValueError):
        suspicion = 0.0
    breakdown["advice"] = _advice(band, suspicion=suspicion)
    return stored


def _result_from_row(
    conn: sqlite3.Connection, row: sqlite3.Row, identity: str, *, reused: bool
) -> dict:
    """从已提交的会话行重建响应（重复提交/GET 共用同一形状）。"""
    try:
        stored = json.loads(row["breakdown"] or "{}")
    except (TypeError, ValueError):
        stored = {}
    if not isinstance(stored, dict):
        stored = {}
    stored = _sanitize_stored_result(stored, row)

    payload = {
        "sessionId": row["id"],
        "status": row["status"],
        "reused": reused,
        "profile": ability.legacy_profile(identity).get("profile"),
    }
    payload.update(stored)
    # 兼容极端情况：breakdown 损坏时至少给出库里已有的列，不让接口 500。
    payload.setdefault("score", row["score"])
    payload.setdefault("confidence", row["confidence"])
    payload.setdefault("preliminary", True)
    payload.setdefault("sampleSize", _sample_size(conn))
    payload.setdefault("disclaimer", DISCLAIMER)
    return payload


def get_profile(identity: str) -> dict:
    """旧 ``GET /api/placement/profile``；现为 ability 的兼容 shim。"""
    if not identity:
        raise PlacementInvalid("缺少定位测身份。")
    try:
        return ability.legacy_profile(identity)
    except ability.AbilityInvalid as exc:
        raise PlacementInvalid(str(exc)) from exc
    except ability.AbilityUnavailable as exc:
        raise PlacementUnavailable(str(exc)) from exc


def reset(identity: str) -> dict:
    """允许重测：把未完成会话标 abandoned；已提交历史与画像保留。"""
    if not identity:
        raise PlacementInvalid("缺少定位测身份。")
    conn = _connect()
    try:
        _require_tables(conn)
        with conn:
            cursor = conn.execute(
                "UPDATE placement_sessions SET status = 'abandoned' "
                "WHERE user_id = ? AND status = 'in_progress'",
                (identity,),
            )
            abandoned = int(cursor.rowcount)
        return {
            "reset": True,
            "abandonedSessions": abandoned,
            "profileKept": True,
            "message": (
                "下一次 start 会创建新会话；已完成的历史会话与当前能力画像保留，"
                "新结果提交后画像才会更新。"
            ),
        }
    except sqlite3.OperationalError as exc:
        raise PlacementUnavailable(
            f"定位测暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()
