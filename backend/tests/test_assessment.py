"""Rasch/EAP 估计器的离线验收（计划书 §5.1 / §7.6，specs/025）。

6 组纯函数用例：后验归一、给定响应复现 θ/SE、全对/全错不发散、确定性、
词汇量区间口径、带区间与精度/可信度分档。不连库、不联网。
"""
from __future__ import annotations

import math

import assessment

BANDS = ("A1", "A2", "B1", "B2", "C1")


def _mixed_b1() -> list[tuple[str, int]]:
    """24 题里 B1 及以下多数答对、B2/C1 多数答错。"""
    responses: list[tuple[str, int]] = []
    for band in BANDS:
        quota = 5 if band != "C1" else 4
        for index in range(quota):
            correct = 1 if (band in ("A1", "A2", "B1") and index < 4) else 0
            if band == "B1" and index == 4:
                correct = 1
            responses.append((band, correct))
    return responses


def test_posterior_is_normalized_and_deterministic():
    responses = _mixed_b1()
    first = assessment.posterior(responses)
    second = assessment.posterior(responses)
    assert first == second
    assert len(first) == len(assessment.GRID) == 161
    assert all(value >= 0 for value in first)
    assert math.isclose(sum(first), 1.0, rel_tol=0.0, abs_tol=1e-9)


def test_estimate_recovers_mid_band():
    result = assessment.estimate(_mixed_b1(), bands=BANDS)
    assert result["calibrationVersion"] == "rasch.eap.v1"
    assert result["n"] == 24
    assert -1.2 < result["theta"] < 0.8
    assert 0 < result["se"] < 1.2
    assert result["ci95"]["low"] < result["theta"] < result["ci95"]["high"]
    assert result["band"] in BANDS
    assert result["interval"]["low"] <= result["band"] <= result["interval"]["high"]
    assert result["precision"]["label"] in ("high", "medium", "low")
    assert abs(sum(result["bandPosterior"].values()) - 1.0) < 1e-6


def test_all_correct_does_not_diverge_and_caps_at_c1():
    responses = [(band, 1) for band in BANDS for _ in range(5)]
    result = assessment.estimate(responses, bands=BANDS)
    assert math.isfinite(result["theta"])
    assert math.isfinite(result["se"])
    assert result["theta"] > 1.0
    assert result["band"] == "C1"
    assert result["interval"] == {"low": "B2", "high": "C1", "label": "B2–C1"}
    assert result["bandPosterior"]["C1"] > 0.8


def test_all_wrong_does_not_diverge_and_caps_at_a1():
    responses = [(band, 0) for band in BANDS for _ in range(5)]
    result = assessment.estimate(responses, bands=BANDS)
    assert math.isfinite(result["theta"])
    assert math.isfinite(result["se"])
    assert result["theta"] < -1.0
    assert result["band"] == "A1"
    assert result["interval"] == {"low": "A1", "high": "A2", "label": "A1–A2"}


def test_vocabulary_interval_uses_lemma_and_2000_to_2500_margin():
    result = assessment.estimate(_mixed_b1(), bands=BANDS)
    vocab = result["vocabulary"]
    assert vocab["unit"] == "lemma"
    assert vocab["low"] < vocab["point"] < vocab["high"]
    half_low = vocab["point"] - vocab["low"]
    half_high = vocab["high"] - vocab["point"]
    assert 2_000 <= half_low <= 2_600
    assert 2_000 <= half_high <= 2_600
    assert vocab["point"] % 100 == 0 and vocab["low"] % 100 == 0


def test_band_interval_helpers_and_precision_validity_labels():
    assert assessment.band_interval("A1", bands=BANDS)["low"] == "A1"
    assert assessment.band_interval("C1", bands=BANDS)["high"] == "C1"
    assert assessment.band_interval("B1", bands=BANDS)["label"] == "A2–B2"
    assert assessment.precision_label(0.40) == "high"
    assert assessment.precision_label(0.53) == "medium"
    assert assessment.precision_label(0.70) == "low"
    assert assessment.validity_label([]) == "high"
    assert assessment.validity_label(["duration_short"]) == "medium"
    assert assessment.validity_label(["pseudo_overclaim"]) == "low"
    assert assessment.confidence_value(
        {"label": "medium", "se": 0.53},
        {"label": "high", "flags": []},
    ) == 0.75
