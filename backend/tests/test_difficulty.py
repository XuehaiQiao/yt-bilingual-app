"""内容难度规则管线离线验收（M2，计划书 §6 / specs/026）。

覆盖：difficulty.v1 字段契约、A2/B1/C1 golden 判带、空/超长/无标点边界、
自动字幕降级、视频语速（毛/净/window_p90）、lemma/专名/缩略词、UTR 单调性、
生词桶与旧 level 回退 payload。全部离线（只读仓库内频表和 content/）。
"""
from __future__ import annotations

from pathlib import Path

import pytest

import difficulty

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "difficulty_golden"


def _golden(name: str) -> str:
    return (FIXTURES / f"{name}.txt").read_text(encoding="utf-8")


def _article(text: str, **kwargs):
    return difficulty.compute_article_features(
        [text], editorial_level=kwargs.pop("editorial_level", None), **kwargs
    )


# ---------------------------------------------------------------------------
# golden 判带（A2 / B1 / C1）
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("fixture", "expected"),
    [("a2", "A2"), ("b1", "B1"), ("c1", "C1")],
)
def test_golden_read_band(fixture, expected):
    features = _article(_golden(fixture))
    assert features["p_level"]["p90"] == expected
    assert features["est_cefr"]["read"] == expected
    assert features["_bands"]["cefr_input"] == expected
    assert features["_bands"]["lexical_band"] == expected


def test_golden_levels_are_ordered():
    index = {"A2": 1, "B1": 2, "C1": 4}
    bands = [
        _article(_golden(name))["_bands"]["cefr_input"] for name in ("a2", "b1", "c1")
    ]
    assert index[bands[0]] < index[bands[1]] < index[bands[2]]


# ---------------------------------------------------------------------------
# 字段契约 / 边界
# ---------------------------------------------------------------------------

def test_features_contract_and_frozen_fields():
    features = _article(_golden("b1"), editorial_level="B1", support={"translation": True})
    assert features["schema"] == "difficulty.v1"
    assert features["kind"] == "article"
    assert features["method"] == "rule.v1"
    for key in ("size", "utr", "utr_content", "utr_band", "cefr_mix", "p_level",
                "proper_noun_rate", "speed", "syntax", "available", "lex",
                "pragmatics", "support", "est_cefr", "editorial_level",
                "label_confidence", "computed_at"):
        assert key in features, key
    assert features["editorial_level"] == "B1"
    assert 0.0 <= features["label_confidence"] <= 1.0
    assert features["available"]["asl"] is True
    assert features["support"]["translation"] is True
    assert set(features["cefr_mix"]) == {"A1", "A2", "B1", "B2", "C1", "beyond"}
    assert abs(sum(features["cefr_mix"].values()) - 1.0) < 0.001
    assert difficulty.READ_PERCENTILE == "p90"


def test_empty_text_is_uncalibrated_but_does_not_crash():
    features = _article("")
    assert features["size"]["tokens"] == 0
    assert features["size"]["content_tokens"] == 0
    assert features["est_cefr"]["read"] is None
    assert features["_bands"]["cefr_input"] is None
    assert features["p_level"]["p90"] == "C1+"  # 无证据时保守
    assert features["label_confidence"] == 0.0
    assert features["utr"]["w1k"] == 0.0


def test_no_punctuation_sets_syntax_unavailable():
    text = "we saw a film about a boy who could fly and he met a girl in a small town"
    features = _article(text)
    assert features["syntax"]["asl"] is None
    assert features["syntax"]["p90_len"] is None
    assert features["syntax"]["clause_density"] is None
    assert features["syntax"]["passive_per_1k"] is None
    assert features["available"]["asl"] is False
    assert features["available"]["clause_density"] is False
    assert features["_bands"]["syntax_band"] is None


def test_very_long_text_is_bounded_and_monotonic():
    text = " ".join([_golden("a2")] * 50)
    features = _article(text)
    assert features["size"]["tokens"] > 2000
    utr = features["utr"]
    assert utr["w1k"] >= utr["w2k"] >= utr["w5k"]
    bands = features["utr_band"]
    assert bands["A1"] >= bands["A2"] >= bands["B1"] >= bands["B2"] >= bands["C1"]
    assert features["_bands"]["cefr_input"] is not None


def test_contractions_are_function_words_and_known():
    text = "Don't worry, it's fine. I'm sure we'll find it. Can't be that hard."
    features = _article(text)
    # 缩略词不应被当成实词生词：实词计数只包含 worry/fine/sure/find/hard。
    assert features["size"]["content_tokens"] <= 8
    assert features["size"]["tokens"] >= 12
    assert features["utr"]["w1k"] < 0.2


def test_proper_nouns_are_excluded_from_content_words():
    text = "Mary and John visited London and Paris last summer."
    records = difficulty._tokens_with_context(text)
    proper = {record.normalized for record in records if record.proper}
    # Mary 是句首大写（不判专名）；John/London/Paris 判专名并排除出实词。
    assert proper == {"john", "london", "paris"}
    features = _article(text)
    assert features["proper_noun_rate"] > 0.3
    assert features["size"]["content_tokens"] == 4  # mary/visited/last/summer


def test_support_confidence_auto_is_lower_than_human():
    blocks = [
        {"start": 0.0, "end": 4.0, "text": "The quick brown fox jumps over the lazy dog."},
        {"start": 4.0, "end": 8.0, "text": "It was a very good day for the whole family."},
    ]
    human = difficulty.compute_video_features(blocks, subtitle_source="human")
    auto = difficulty.compute_video_features(blocks, subtitle_source="auto")
    assert human["available"]["asl"] is True
    assert auto["available"]["asl"] is False
    assert auto["syntax"]["asl"] is None
    assert auto["label_confidence"] < human["label_confidence"]


# ---------------------------------------------------------------------------
# 视频：语速 / 停顿 / 窗口
# ---------------------------------------------------------------------------

def test_video_speed_gross_net_and_gap_handling():
    # 60 词 / 60 秒 = 60 wpm；中间 10 秒空洞 >2s → 净值升高。
    blocks = [
        {"start": 0.0, "end": 20.0, "text": " ".join(["the"] * 20)},
        {"start": 30.0, "end": 50.0, "text": " ".join(["the"] * 20)},
        {"start": 50.0, "end": 60.0, "text": " ".join(["the"] * 20)},
    ]
    features = difficulty.compute_video_features(blocks, subtitle_source="human")
    assert features["speed"]["wpm"] == 60
    assert features["speed"]["wpm_net"] == 72  # 60s - 10s 空洞 = 50s
    assert features["available"]["wpm"] is True
    assert features["available"]["wpm_net"] is True
    assert features["size"]["duration_s"] == 60


def test_video_window_p90_needs_two_windows():
    blocks = [
        {"start": 0.0, "end": 300.0, "text": " ".join(["word"] * 300)},
        {"start": 300.0, "end": 600.0, "text": " ".join(["word"] * 900)},
    ]
    features = difficulty.compute_video_features(blocks, subtitle_source="auto")
    assert features["speed"]["window_p90_wpm"] is not None
    assert features["speed"]["window_p90_wpm"] > features["speed"]["wpm"]


def test_video_without_blocks_has_no_speed():
    features = difficulty.compute_video_features([], subtitle_source="none")
    assert features["size"]["tokens"] == 0
    assert features["speed"]["wpm"] is None
    assert features["available"]["wpm"] is False
    assert features["_bands"]["cefr_input"] is None


# ---------------------------------------------------------------------------
# 生词桶 / 旧 level 回退 / 支持度
# ---------------------------------------------------------------------------

def test_novelty_bucket_boundaries():
    assert difficulty.novelty_bucket(0.0) == "<1%"
    assert difficulty.novelty_bucket(0.005) == "<1%"
    assert difficulty.novelty_bucket(0.015) == "1–3%"
    assert difficulty.novelty_bucket(0.035) == "3–5%"
    assert difficulty.novelty_bucket(0.06) == "5–8%"
    assert difficulty.novelty_bucket(0.2) == ">8%"
    assert difficulty.novelty_bucket(None) is None


def test_utr_band_and_public_payload():
    features = _article(_golden("c1"))
    rate = difficulty.utr_band_for(features, "A2")
    assert rate is not None and 0 <= rate <= 1
    payload = difficulty.payload_from_features(
        "article", "x", features, editorial_level="C1"
    )
    public = difficulty.payload_to_public(payload, band="A2")
    assert public["schema"] == "difficulty.v1"
    assert public["cefrInput"] == "C1"
    assert public["utrBand"] == rate
    assert public["bucket"] == difficulty.novelty_bucket(rate)
    assert public["estimated"] is True
    assert public["source"] == "computed"
    assert public["method"] == "rule"


def test_legacy_payload_shape():
    legacy = difficulty.legacy_payload("video", "abc", level="B1")
    assert legacy["source"] == "legacy"
    assert legacy["cefrInput"] is None
    assert legacy["level"] == "B1"
    assert legacy["estimated"] is False
    assert legacy["bucket"] is None


def test_score_support_values():
    assert difficulty.score_support({"subtitle": "human"}) == 1.0
    assert difficulty.score_support({"subtitle": "auto"}) == 0.8
    assert difficulty.score_support({"subtitle": "none", "text": True}) == 0.9
    assert difficulty.score_support(None) == 0.3


def test_gutenberg_articles_are_resolvable_and_banded():
    """34 篇公版短文：有正文、有译文，全部能算出 difficulty.v1。"""
    import json

    manifest_path = Path(__file__).resolve().parents[2] / "content" / "library" / "gutenberg-manifest.json"
    items = json.loads(manifest_path.read_text(encoding="utf-8"))["items"]
    assert len(items) == 34
    for item in items:
        content = difficulty.resolve_content("article", item["id"])
        assert content is not None, item["id"]
        assert content["support"]["translation"] is True
        features = difficulty.compute_for_content(content)
        payload = difficulty.payload_from_features(
            "article", item["id"], features, editorial_level=content.get("editorial_level")
        )
        assert payload["cefr_input"] in difficulty.LEVEL_OUTPUTS, item["id"]
        assert payload["confidence"] and payload["confidence"] > 0, item["id"]
        assert features["size"]["tokens"] > 0
        assert 250 <= features["size"]["tokens"] <= 400


def test_unavailable_video_payload_is_not_estimated():
    """无字幕占位行：available=false、cefrInput 为空、estimated=false。"""
    features = difficulty.compute_video_features(
        [],
        subtitle_source="none",
        support={"subtitle": "none", "translation": False, "glossary": False, "text": False},
    )
    assert features["available"]["asl"] is False
    assert features["available"]["wpm"] is False
    assert features["support"]["text"] is False
    payload = difficulty.payload_from_features("curated", "missing", features, editorial_level="B1")
    public = difficulty.payload_to_public(payload)
    assert public["cefrInput"] is None
    assert public["estimated"] is False
    assert public["bucket"] is None
