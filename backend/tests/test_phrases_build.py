"""短语词表构建/产物契约（scripts/build_phrases.py）。

全部离线：迷你 ECDICT CSV + 仓库内真实频表/精选副本；不联网、不写仓库内容目录。
覆盖 ECDICT 多词 tag（含/不含 tag、去重变体、专名/数字/冒犯过滤）、类型推断、
精选优先合并、规模护栏、完整性校验、`--check` 与 100 条抽检报告。
"""
from __future__ import annotations

import csv
import json
import shutil
from pathlib import Path

import pytest

from tests.vocab_fixtures import (
    REAL_CURATED,
    REAL_CURATED_EXTRA,
    ROOT,
    TINY_COLUMNS,
    copy_frequency,
    load_phrases_builder,
    write_tiny_ecdict,
)

builder = load_phrases_builder()

PHRASE_ROWS = [
    {
        "word": "look after",
        "translation": "v. 照顾",
        "tag": "cet4",
        "frq": "",
        "bnc": "",
    },
    {
        "word": "look after sb",
        "translation": "v. 照顾某人",
        "tag": "gre",
        "frq": "100",
        "bnc": "",
    },
    {
        "word": "give up",
        "translation": "v. 放弃",
        "tag": "cet6 gre",
        "frq": "",
        "bnc": "120",
    },
    {
        "word": "in spite of",
        "translation": "不管",
        "tag": "cet4",
        "frq": "",
        "bnc": "",
    },
    {
        "word": "New York",
        "translation": "纽约",
        "tag": "cet4",
        "frq": "",
        "bnc": "",
    },
    {
        "word": "in fact",
        "translation": "事实上",
        "tag": "",
        "frq": "",
        "bnc": "",
    },
    {
        "word": "make up",
        "translation": "",
        "tag": "cet4",
        "frq": "",
        "bnc": "",
    },
    {
        "word": "one two three four five",
        "translation": "五个词",
        "tag": "cet4",
        "frq": "",
        "bnc": "",
    },
    {
        "word": "e-mail",
        "translation": "电子邮件",
        "tag": "cet4",
        "frq": "",
        "bnc": "",
    },
    {
        "word": "fuck off",
        "translation": "滚开",
        "tag": "cet4",
        "frq": "",
        "bnc": "",
    },
    {
        "word": "ice cream",
        "translation": "冰淇淋",
        "tag": "zk",
        "frq": "",
        "bnc": "",
    },
    {
        "word": "answer up",
        "translation": "迅速回答",
        "tag": "cet4",
        "frq": "",
        "bnc": "",
    },
]


def write_phrase_ecdict(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=TINY_COLUMNS)
        writer.writeheader()
        for row in PHRASE_ROWS:
            payload = {column: "" for column in TINY_COLUMNS}
            payload.update(row)
            writer.writerow(payload)
    return path


def _frequency(path: Path):
    copied = copy_frequency(path)
    return copied, json.loads(copied.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# 纯函数
# ---------------------------------------------------------------------------

def test_normalize_variant_and_slug():
    assert builder.strip_variant_tokens("look after sb") == "look after"
    assert builder.strip_variant_tokens("look after sth") == "look after"
    assert builder.strip_variant_tokens("look after") == "look after"
    assert builder.phrase_slug("look after") == "look-after"
    assert builder.phrase_slug("make up one's mind") == "make-up-ones-mind"
    assert builder.phrase_slug("a piece of cake") == "a-piece-of-cake"


def test_infer_phrase_type():
    assert builder.infer_phrase_type("look after") == "phrasal_verb"
    assert builder.infer_phrase_type("put up with") == "phrasal_verb"
    assert builder.infer_phrase_type("in spite of") == "idiom"
    assert builder.infer_phrase_type("ice cream") == "collocation"
    assert builder.infer_phrase_type("heavy rain") == "collocation"


def test_clean_translation_keeps_first_chinese_line():
    assert builder.clean_translation("to become less\\nvt. 减弱") == "vt. 减弱"
    assert builder.clean_translation("only english") == ""


# ---------------------------------------------------------------------------
# ECDICT 多词 tag
# ---------------------------------------------------------------------------

def test_extract_ecdict_phrases_filters_tags_variants_and_counts(tmp_path):
    _, frequency = _frequency(tmp_path / "frequency.json")
    levels = builder.FrequencyLevels(frequency)
    csv_path = write_phrase_ecdict(tmp_path / "ecdict.csv")

    entries, stats = builder.extract_ecdict_phrases(csv_path, levels)

    assert [entry["headword"] for entry in entries] == [
        "look after",
        "give up",
        "answer up",
        "in spite of",
    ]
    by_word = {entry["headword"]: entry for entry in entries}
    # look after + look after sb 合并：tag 取并集、rank 取更小值。
    assert by_word["look after"]["tagMask"] == 5
    assert by_word["look after"]["rank"] == 100
    assert by_word["give up"]["tagMask"] == 6
    assert by_word["give up"]["rank"] == 120
    assert by_word["in spite of"]["tagMask"] == 1
    assert by_word["answer up"]["tagMask"] == 1
    for entry in entries:
        assert entry["source"] == "ECDICT"
        assert entry["example"] == ""
        assert entry["type"] in builder.PHRASE_TYPES
        assert entry["cefr"] in builder.PHRASE_CEFR_LEVELS
        assert builder.CJK_RE.search(entry["translation"])
    # 5 词 / 无 tag / 无中文 / 专名 / 冒犯 / 非纯字母都被过滤。
    assert stats["tagged2to4Rows"] == 7
    assert stats["tagged2to4WithChinese"] == 6
    assert stats["taggedEntriesAfterFilter"] == 4
    assert stats["taggedTranslationCoverage"] == pytest.approx(6 / 7, abs=1e-4)


def test_extract_ecdict_phrases_without_tags_yields_nothing(tmp_path):
    _, frequency = _frequency(tmp_path / "frequency.json")
    levels = builder.FrequencyLevels(frequency)
    csv_path = write_tiny_ecdict(tmp_path / "ecdict.csv")

    entries, stats = builder.extract_ecdict_phrases(csv_path, levels)

    assert entries == []
    assert stats["tagged2to4Rows"] == 0
    assert stats["taggedTranslationCoverage"] is None


def test_extract_rejects_csv_missing_columns(tmp_path):
    csv_path = tmp_path / "bad.csv"
    csv_path.write_text("word,translation\nlook after,照顾\n", encoding="utf-8")
    _, frequency = _frequency(tmp_path / "frequency.json")
    levels = builder.FrequencyLevels(frequency)
    with pytest.raises(builder.BuildError, match="缺少列"):
        builder.extract_ecdict_phrases(csv_path, levels)


# ---------------------------------------------------------------------------
# 合并 / 规模
# ---------------------------------------------------------------------------

def test_build_document_uses_curated_priority_and_keeps_ecdict_extras(tmp_path):
    frequency_path, frequency = _frequency(tmp_path / "frequency.json")
    csv_path = write_phrase_ecdict(tmp_path / "ecdict.csv")

    document, stats = builder.build_document(
        csv_path,
        frequency,
        REAL_CURATED,
        REAL_CURATED_EXTRA,
    )

    assert builder.validate_document(document) == []
    assert document["counts"]["curated"] == 570
    # look after / give up 已在精选中，被去重；
    # answer up / in spite of 不在精选中，作为 ECDICT 条目保留。
    assert document["counts"]["ecdict"] == 2
    assert document["counts"]["total"] == 572
    ecdict_entries = [
        entry for entry in document["entries"] if entry["source"] == "ECDICT"
    ]
    assert [entry["headword"] for entry in ecdict_entries] == [
        "answer up",
        "in spite of",
    ]
    assert ecdict_entries[0]["tagMask"] == 1
    assert stats["taggedEntriesAfterFilter"] == 4
    assert document["source"]["ecdict"]["stats"]["tagged2to4Rows"] == 7
    assert document["integrity"]["sha256"] == builder.phrases_payload_sha256(document)


def test_build_without_tagged_phrases_still_meets_scale(tmp_path):
    frequency_path, frequency = _frequency(tmp_path / "frequency.json")
    csv_path = write_tiny_ecdict(tmp_path / "ecdict.csv")

    document, stats = builder.build_document(
        csv_path,
        frequency,
        REAL_CURATED,
        REAL_CURATED_EXTRA,
    )

    assert document["counts"] == {
        "total": 570,
        "ecdict": 0,
        "curated": 570,
        "byType": {"phrasal_verb": 302, "idiom": 203, "collocation": 65},
        "byCefr": {"A2": 107, "B1": 176, "B2": 221, "C1": 66, "C1+": 0},
        "bySource": {"ECDICT": 0, "curated": 570},
    }
    assert stats["tagged2to4Rows"] == 0
    assert 500 <= document["counts"]["total"] <= 800


def test_small_curated_batches_fail_scale_guard(tmp_path):
    frequency_path, frequency = _frequency(tmp_path / "frequency.json")
    csv_path = write_tiny_ecdict(tmp_path / "ecdict.csv")
    baseline = json.loads(REAL_CURATED.read_text(encoding="utf-8"))
    extra = json.loads(REAL_CURATED_EXTRA.read_text(encoding="utf-8"))
    baseline["entries"] = baseline["entries"][:150]
    extra["entries"] = extra["entries"][:1]
    small_baseline = tmp_path / "curated-small.json"
    small_extra = tmp_path / "curated-extra-small.json"
    small_baseline.write_text(json.dumps(baseline, ensure_ascii=False), encoding="utf-8")
    small_extra.write_text(json.dumps(extra, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(builder.BuildError, match="500"):
        builder.build_document(
            csv_path, frequency, small_baseline, small_extra
        )
    # --allow-small 供测试构建小产物。
    document, _ = builder.build_document(
        csv_path, frequency, small_baseline, small_extra, allow_small=True
    )
    assert document["counts"]["total"] == 151


def test_curated_file_validation_catches_missing_example_and_duplicates(tmp_path):
    document = json.loads(REAL_CURATED.read_text(encoding="utf-8"))
    document["entries"][0]["example"] = ""
    broken = tmp_path / "broken.json"
    broken.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(builder.BuildError, match="example"):
        builder.load_curated_file(broken)

    document = json.loads(REAL_CURATED.read_text(encoding="utf-8"))
    document["entries"][1]["headword"] = document["entries"][0]["headword"]
    duplicate = tmp_path / "duplicate.json"
    duplicate.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(builder.BuildError, match="headword 重复"):
        builder.load_curated_file(duplicate)


# ---------------------------------------------------------------------------
# 产物 / --check / 报告
# ---------------------------------------------------------------------------

def _build_into(tmp_path: Path):
    frequency_path, frequency = _frequency(tmp_path / "frequency.json")
    csv_path = write_phrase_ecdict(tmp_path / "ecdict.csv")
    out_dir = tmp_path / "wordlists"
    report_path = tmp_path / "report.json"
    code = builder.main(
        [
            "--ecdict-csv",
            str(csv_path),
            "--frequency",
            str(frequency_path),
            "--curated",
            str(REAL_CURATED),
            "--curated-extra",
            str(REAL_CURATED_EXTRA),
            "--out-dir",
            str(out_dir),
            "--report",
            str(report_path),
        ]
    )
    assert code == 0
    return out_dir, report_path, csv_path, frequency_path


def test_check_artifacts_accepts_clean_build_and_rejects_tampering(tmp_path):
    out_dir, _report, csv_path, frequency_path = _build_into(tmp_path)
    shutil.copyfile(ROOT / "content" / "wordlists" / "PHRASES-NOTICE.md", out_dir / "PHRASES-NOTICE.md")

    args = [
        "--check",
        "--curated",
        str(REAL_CURATED),
        "--curated-extra",
        str(REAL_CURATED_EXTRA),
        "--out-dir",
        str(out_dir),
    ]
    assert builder.main(args) == 0
    assert builder.main(args + ["--ecdict-csv", str(csv_path), "--frequency", str(frequency_path)]) == 0

    phrases_path = out_dir / "phrases.v1.json"
    document = json.loads(phrases_path.read_text(encoding="utf-8"))
    document["entries"][0]["cefr"] = "B2"
    phrases_path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
    assert builder.main(args) == 1


def test_check_requires_notice_and_no_csv(tmp_path, capsys):
    out_dir, _report, _csv_path, _frequency_path = _build_into(tmp_path)
    args = [
        "--check",
        "--curated",
        str(REAL_CURATED),
        "--curated-extra",
        str(REAL_CURATED_EXTRA),
        "--out-dir",
        str(out_dir),
    ]
    assert builder.main(args) == 1
    assert "PHRASES-NOTICE.md" in capsys.readouterr().err

    shutil.copyfile(ROOT / "content" / "wordlists" / "PHRASES-NOTICE.md", out_dir / "PHRASES-NOTICE.md")
    (out_dir / "leak.csv").write_text("x", encoding="utf-8")
    assert builder.main(args) == 1
    assert "CSV" in capsys.readouterr().err


def test_report_has_100_sample_checklist_and_totals(tmp_path):
    out_dir, report_path, _csv_path, _frequency_path = _build_into(tmp_path)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    document = json.loads((out_dir / "phrases.v1.json").read_text(encoding="utf-8"))

    assert report["schema"] == builder.SCHEMA_REPORT
    assert report["totals"] == document["counts"]
    assert report["ecdict"]["tagged2to4Rows"] == 7
    assert report["ecdict"]["entries"] == 2
    assert len(report["checklist"]) == 100
    assert report["qualityGate"]["failed"] == 0
    assert all(
        item["checks"]["translationHasChinese"]
        and item["checks"]["typeValid"]
        and item["checks"]["cefrInA2ToC1Plus"]
        for item in report["checklist"]
    )
    curated_items = [
        item for item in report["checklist"] if item["source"] == "curated"
    ]
    assert curated_items and all(
        item["checks"]["examplePresent"] for item in curated_items
    )


# ---------------------------------------------------------------------------
# 仓库内产物
# ---------------------------------------------------------------------------

def test_committed_phrases_artifact_passes_check():
    assert builder.main(["--check"]) == 0


def test_committed_curated_files_are_valid():
    _, baseline = builder.load_curated_file(REAL_CURATED)
    _, extra = builder.load_curated_file(REAL_CURATED_EXTRA)
    assert 150 <= len(baseline) <= 200
    assert len(extra) > 0
    assert len({entry["id"] for entry in baseline + extra}) == len(baseline) + len(extra)


def test_validate_document_reports_invalid_type_instead_of_crashing():
    """产物被手工篡改时返回校验问题，而不是抛 KeyError。"""
    document = json.loads(
        (ROOT / "content" / "wordlists" / "phrases.v1.json").read_text(
            encoding="utf-8"
        )
    )
    document["entries"][0]["type"] = "not_a_type"
    problems = builder.validate_document(document)
    assert problems
    assert any("type" in problem for problem in problems)
