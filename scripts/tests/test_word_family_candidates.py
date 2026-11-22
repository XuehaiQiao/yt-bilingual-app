"""Unit tests for the read-only word-family candidate heuristics."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("wfc", ROOT / "scripts/word_family_candidates.py")
wfc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wfc)


def family(members, levels=None):
    return {"members": [{"lemma": w, "level": (levels or {}).get(w)} for w in members]}


def test_normal_family_has_no_reason():
    assert wfc.family_reasons(family(["run", "runs"]), {}) == []


def test_large_family():
    reasons = wfc.family_reasons(family(["a", "b", "c", "d", "e", "f"]), {})
    assert "large" in reasons


def test_outside_heavy_needs_ratio_and_count():
    members = ["x1", "x2", "x3", "x4", "inside"]
    reasons = wfc.family_reasons(family(members, {"inside": "A1"}), {})
    assert "outside-heavy" in reasons
    members2 = ["x1", "x2", "inside1", "inside2"]
    assert "outside-heavy" not in wfc.family_reasons(family(members2, {"inside1": "A1", "inside2": "A1"}), {})


def test_word_shape_flags_space_and_uppercase():
    assert "word-shape" in wfc.family_reasons(family(["ice cream", "icy"]), {})
    assert "word-shape" in wfc.family_reasons(family(["London", "londoner"]), {})


def test_rank_spread_needs_four_members():
    members = ["a", "b", "c"]
    fam = {"members": [
        {"lemma": "a", "rank": 1}, {"lemma": "b", "rank": 2}, {"lemma": "c", "rank": 9999},
    ]}
    assert "rank-spread" not in wfc.family_reasons(fam, {})
    fam["members"].append({"lemma": "d", "rank": 10000})
    assert "rank-spread" in wfc.family_reasons(fam, {})
