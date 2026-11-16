"""Rasch/EAP 估计器的离线验收（计划书 §5.1 / §7.6，specs/025）。

6 组纯函数用例：后验归一、给定响应复现 θ/SE、全对/全错不发散、确定性、
词汇量区间口径、带区间与精度/可信度分档。不连库、不联网。
"""
from __future__ import annotations

import math

import pytest

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


# ---------------------------------------------------------------------------
# M2：rasch.eap.v2（题级 b + 锚题 + form offset）
# ---------------------------------------------------------------------------

def _v2_responses(correct: bool = True) -> list[dict]:
    return [
        {
            "band": band,
            "correct": 1 if correct else 0,
            "b": assessment.BAND_CENTERS[band],
            "anchor": band in ("A1", "B2"),
        }
        for band in BANDS
        for _ in range(5)
    ]


def test_v2_uses_item_difficulty_and_keeps_v1_reader():
    easy = [{"band": "B1", "correct": 1, "b": -1.5, "anchor": True} for _ in range(6)]
    hard = [{"band": "B1", "correct": 1, "b": 1.5, "anchor": True} for _ in range(6)]
    easy_result = assessment.estimate_v2(easy, bands=BANDS, form="A")
    hard_result = assessment.estimate_v2(hard, bands=BANDS, form="B")
    assert easy_result["calibrationVersion"] == "rasch.eap.v2"
    assert hard_result["calibrationVersion"] == "rasch.eap.v2"
    # 同样答对「更难的题」→ θ 更高；v1 只用带中心，两套输入读数相同。
    assert hard_result["theta"] > easy_result["theta"]
    v1_easy = assessment.estimate([(item["band"], item["correct"]) for item in easy], bands=BANDS)
    v1_hard = assessment.estimate([(item["band"], item["correct"]) for item in hard], bands=BANDS)
    assert v1_easy["theta"] == v1_hard["theta"]
    assert v1_easy["calibrationVersion"] == "rasch.eap.v1"


def test_v2_forms_share_theta_scale_via_common_anchors():
    responses = _v2_responses()
    form_a = assessment.estimate_v2(responses, bands=BANDS, form="A")
    form_b = assessment.estimate_v2(responses, bands=BANDS, form="B")
    assert form_a["theta"] == form_b["theta"]
    assert form_a["se"] == form_b["se"]
    assert form_a["band"] == form_b["band"]
    assert form_a["anchorCount"] == form_b["anchorCount"] == 10
    assert form_a["scale"]["method"] == "common_anchor"
    assert form_a["scale"]["status"] == "uncalibrated"
    assert form_a["formOffset"] == 0.0


def test_v2_form_offset_direction_and_validation():
    responses = _v2_responses()
    base = assessment.estimate_v2(responses, bands=BANDS)
    easier = assessment.estimate_v2(responses, bands=BANDS, form_offset=-0.5)
    harder = assessment.estimate_v2(responses, bands=BANDS, form_offset=0.5)
    # 正 offset = 卷面更难（offset 与 item b 同向）→ 同样答对时 θ 读数更高。
    assert easier["theta"] < base["theta"] < harder["theta"]
    assert harder["formOffset"] == 0.5
    with pytest.raises(assessment.AssessmentError):
        assessment.estimate_v2(responses, bands=BANDS, form_offset=10.0)


def test_v2_all_correct_and_all_wrong_do_not_diverge():
    all_correct = assessment.estimate_v2(_v2_responses(True), bands=BANDS, form="A")
    all_wrong = assessment.estimate_v2(_v2_responses(False), bands=BANDS, form="B")
    for result in (all_correct, all_wrong):
        assert math.isfinite(result["theta"])
        assert math.isfinite(result["se"])
        assert result["se"] > 0
        assert result["ci95"]["low"] < result["theta"] < result["ci95"]["high"]
        assert result["interval"]["low"] <= result["band"] <= result["interval"]["high"]
        assert abs(sum(result["bandPosterior"].values()) - 1.0) < 1e-6
    assert all_correct["band"] == "C1"
    assert all_wrong["band"] == "A1"


def test_v2_response_validation():
    with pytest.raises(assessment.AssessmentError):
        assessment.estimate_v2([( "A1", 1)], bands=BANDS)  # v2 必须是对象
    with pytest.raises(assessment.AssessmentError):
        assessment.estimate_v2([{"band": "Z9", "correct": 1}], bands=BANDS)
    with pytest.raises(assessment.AssessmentError):
        assessment.estimate_v2([{"band": "A1", "correct": 1, "b": True}], bands=BANDS)
    with pytest.raises(assessment.AssessmentError):
        assessment.estimate_v2([{"band": "A1", "correct": 1, "b": 99}], bands=BANDS)
    with pytest.raises(assessment.AssessmentError):
        assessment.estimate_v2([{"band": "A1", "correct": 2}], bands=BANDS)


def test_v1_and_v2_have_same_result_shape():
    v1 = assessment.estimate(_v2_responses(), bands=BANDS)
    v2 = assessment.estimate_v2(_v2_responses(), bands=BANDS, form="A")
    for key in (
        "n",
        "correct",
        "theta",
        "se",
        "ci95",
        "ci80",
        "band",
        "bandPosterior",
        "interval",
        "precision",
        "vocabulary",
    ):
        assert key in v1 and key in v2
    assert v1["n"] == v2["n"] == 25
    assert v1["correct"] == v2["correct"] == 25
