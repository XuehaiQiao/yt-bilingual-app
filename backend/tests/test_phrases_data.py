"""仓库内短语词表的数据完整性验收（content/wordlists/*）。

不依赖测试构建：直接读已提交产物，防止「测试能过、交付物坏了」。
覆盖规模、ID/headword 唯一、type/CEFR 合法、精选例句、ECDICT 覆盖记录、
报告与 NOTICE、无 CSV 泄漏。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import vocabulary

ROOT = Path(__file__).resolve().parents[2]
WORDLISTS = ROOT / "content" / "wordlists"
PHRASES = WORDLISTS / "phrases.v1.json"
CURATED = WORDLISTS / "curated-phrases.v1.json"
CURATED_EXTRA = WORDLISTS / "curated-phrases-extra.v1.json"
REPORT = ROOT / "docs" / "reports" / "phrases-build-2026-11-17.json"
PHRASE_RE = re.compile(r"^[a-z]+(?:'[a-z]+)?(?: [a-z]+(?:'[a-z]+)?){1,3}$")
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")


def _document() -> dict:
    return json.loads(PHRASES.read_text(encoding="utf-8"))


def test_phrases_artifact_schema_and_scale():
    document = _document()
    assert document["schema"] == "linguatrek.phrases.v1"
    assert document["version"] == "2026.11.17"
    assert document["notice"] == "PHRASES-NOTICE.md"
    assert document["approximate"] is True
    assert 500 <= len(document["entries"]) <= 800
    assert document["counts"]["total"] == len(document["entries"])
    assert document["counts"]["curated"] + document["counts"]["ecdict"] == len(
        document["entries"]
    )
    assert document["integrity"]["scope"] == "entries+counts+version"


def test_phrases_entries_are_unique_and_valid():
    entries = _document()["entries"]
    ids = [entry["id"] for entry in entries]
    headwords = [entry["headword"] for entry in entries]
    assert len(ids) == len(set(ids))
    assert len(headwords) == len(set(headwords))
    for entry in entries:
        assert PHRASE_RE.fullmatch(entry["headword"]), entry
        assert entry["id"]
        assert entry["type"] in {"phrasal_verb", "idiom", "collocation"}
        assert entry["cefr"] in {"A2", "B1", "B2", "C1", "C1+"}
        assert CJK_RE.search(entry["translation"])
        assert entry["source"] in {"ECDICT", "curated"}
        if entry["source"] == "curated":
            assert entry["example"].strip()
            assert entry["license"] == "LinguaTrek 原创整理"
        else:
            assert isinstance(entry.get("tagMask"), int) and entry["tagMask"] > 0
            assert isinstance(entry.get("rank"), int) and entry["rank"] >= 1


def test_phrases_counts_match_entries():
    document = _document()
    entries = document["entries"]
    counts = document["counts"]
    by_type = {
        phrase_type: sum(1 for e in entries if e["type"] == phrase_type)
        for phrase_type in vocabulary.PHRASE_TYPES
    }
    by_cefr = {
        level: sum(1 for e in entries if e["cefr"] == level)
        for level in vocabulary.PHRASE_LEVELS
    }
    by_source = {
        source: sum(1 for e in entries if e["source"] == source)
        for source in vocabulary.PHRASE_SOURCES
    }
    assert counts["byType"] == by_type
    assert counts["byCefr"] == by_cefr
    assert counts["bySource"] == by_source
    assert counts["ecdict"] == by_source["ECDICT"]
    assert counts["curated"] == by_source["curated"]


def test_ecdict_coverage_is_recorded_honestly():
    source = _document()["source"]["ecdict"]
    stats = source["stats"]
    assert source["csvSha256"] == (
        "d1ecbdf9ee2b920afb6f430ca6b6bb9f559588cf0dff86e04bd255f9390843cc"
    )
    assert stats["rows"] == 770_611
    assert stats["multiWordRows"] == 366_599
    # 上游 tag 列不给多词条目打 CET4/CET6/GRE 标签：实际为 0。
    assert stats["tagged2to4Rows"] == 0
    assert stats["tagged2to4WithChinese"] == 0
    assert stats["taggedTranslationCoverage"] is None
    assert _document()["counts"]["ecdict"] == 0


def test_curated_files_are_within_agreed_shape():
    baseline = json.loads(CURATED.read_text(encoding="utf-8"))
    extra = json.loads(CURATED_EXTRA.read_text(encoding="utf-8"))
    assert baseline["schema"] == "linguatrek.curated-phrases.v1"
    assert extra["schema"] == "linguatrek.curated-phrases.v1"
    assert baseline["license"] == "LinguaTrek 原创整理"
    assert 150 <= len(baseline["entries"]) <= 200
    assert len(extra["entries"]) > 0
    all_entries = baseline["entries"] + extra["entries"]
    assert len({entry["id"] for entry in all_entries}) == len(all_entries)
    for entry in all_entries:
        assert set(entry) == {
            "id",
            "headword",
            "type",
            "cefr",
            "translation",
            "example",
            "source",
            "license",
            "notes",
        }
        assert entry["source"] == "curated"
        assert entry["example"].strip()
        assert entry["notes"].strip()


def test_quality_report_matches_artifact():
    report = json.loads(REPORT.read_text(encoding="utf-8"))
    document = _document()
    assert report["schema"] == "linguatrek.phrases-build-report.v1"
    assert report["artifact"] == "content/wordlists/phrases.v1.json"
    assert report["totals"] == document["counts"]
    assert report["ecdict"]["tagged2to4Rows"] == 0
    assert report["ecdict"]["entries"] == 0
    assert report["qualityGate"]["sampleSize"] == 100
    assert report["qualityGate"]["failed"] == 0
    checklist = report["checklist"]
    assert len(checklist) == 100
    by_id = {entry["id"]: entry for entry in document["entries"]}
    for row in checklist:
        entry = by_id[row["id"]]
        assert row["headword"] == entry["headword"]
        assert row["checks"]["translationHasChinese"] is True
        assert row["checks"]["typeValid"] is True
        assert row["checks"]["cefrInA2ToC1Plus"] is True
        if entry["source"] == "curated":
            assert row["checks"]["examplePresent"] is True


def test_notice_and_no_csv_in_wordlists():
    notice = (WORDLISTS / "PHRASES-NOTICE.md").read_text(encoding="utf-8")
    assert "实际覆盖为 0" in notice
    assert "LinguaTrek 原创整理" in notice
    assert "C2" in notice
    assert not sorted(WORDLISTS.glob("*.csv"))


def test_committed_artifact_loads_through_backend():
    phrases = vocabulary.load_phrases()
    assert phrases.counts["total"] == 570
    assert phrases.notice == "PHRASES-NOTICE.md"
    assert len(phrases.by_id) == 570
    assert phrases.by_id["look-after"]["headword"] == "look after"


def test_committed_artifact_passes_builder_check():
    import importlib.util

    script = ROOT / "scripts" / "build_phrases.py"
    spec = importlib.util.spec_from_file_location("committed_build_phrases", script)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    assert module.main(["--check"]) == 0
