"""单词本词表构建/产物契约（scripts/build_word_lists.py）。

全部离线：迷你 ECDICT CSV + 仓库内真实频表副本；不联网、不写仓库内容目录。
"""
from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest

from tests.vocab_fixtures import (
    REAL_FREQUENCY,
    ROOT,
    copy_frequency,
    load_builder,
    write_tiny_ecdict,
)

builder = load_builder()
COMMITTED = ROOT / "content" / "wordlists"


def _build_tiny(tmp_path: Path) -> tuple[Path, Path, Path]:
    frequency = copy_frequency(tmp_path / "frequency_bands.v1.json")
    csv_path = write_tiny_ecdict(tmp_path / "ecdict.csv")
    out_dir = tmp_path / "wordlists"
    code = builder.main(
        [
            "--ecdict-csv",
            str(csv_path),
            "--frequency",
            str(frequency),
            "--out-dir",
            str(out_dir),
            "--allow-small",
        ]
    )
    assert code == 0
    for name in ("NOTICE.md", "README.md"):
        shutil.copyfile(COMMITTED / name, out_dir / name)
    return frequency, csv_path, out_dir


# ---------------------------------------------------------------------------
# 纯函数
# ---------------------------------------------------------------------------

def test_clean_translation_prefers_first_chinese_line_and_truncates():
    assert builder.clean_translation("to become less\\nvt. 减弱") == "vt. 减弱"
    assert builder.clean_translation("n. 斑马") == "n. 斑马"
    assert builder.clean_translation("") == ""
    assert builder.clean_translation("only english") == ""
    long_text = "很长的释义" * 40
    cleaned = builder.clean_translation(long_text)
    assert len(cleaned) == builder.TRANSLATION_LIMIT
    assert cleaned.endswith("…")


def test_parse_rank_falls_back_from_frq_to_bnc():
    assert builder.parse_rank({"frq": "123", "bnc": "456"}) == 123
    assert builder.parse_rank({"frq": "", "bnc": "456"}) == 456
    assert builder.parse_rank({"frq": "0", "bnc": ""}) == 999_999


def test_tag_mask_is_compact_and_ignores_unused_tags():
    assert builder.tag_mask(["cet4", "cet6", "gre"]) == 7
    assert builder.tag_mask(["zk", "gk", "ky", "toefl", "ielts"]) == 0
    assert builder.tag_mask(["gre"]) == 4


# ---------------------------------------------------------------------------
# 构建
# ---------------------------------------------------------------------------

def test_build_documents_from_tiny_csv_has_expected_counts_and_details(tmp_path):
    frequency = copy_frequency(tmp_path / "frequency_bands.v1.json")
    csv_path = write_tiny_ecdict(tmp_path / "ecdict.csv")
    freq_doc = builder.load_frequency(frequency)
    exam_doc, lexicon_doc = builder.build_documents(
        csv_path, freq_doc, allow_small=True
    )

    assert exam_doc["schema"] == builder.SCHEMA_EXAM
    assert exam_doc["counts"] == {"cet4": 4, "cet6": 2, "gre": 4, "unique": 8}
    assert exam_doc["tagBits"] == {"cet4": 1, "cet6": 2, "gre": 4}
    assert exam_doc["notice"] == "NOTICE.md"
    assert exam_doc["source"]["csvSha256"] == builder.file_sha256(csv_path)
    assert not builder.validate_exam_document(exam_doc)

    entries = {entry[0].lower(): entry for entry in exam_doc["entries"]}
    assert entries["abandon"] == ["abandon", 7, 2182]
    assert entries["abate"][1] == 4
    assert entries["running"][1] == 4
    assert entries["africa"][0] == "Africa"  # 展示大小写保留
    assert "e-mail" not in entries
    # 排序：rank 升序（ability 783 在 abandon 2182 之前）
    words = [entry[0] for entry in exam_doc["entries"]]
    assert words[:3] == ["ability", "abandon", "Africa"]

    assert lexicon_doc["schema"] == builder.SCHEMA_LEXICON
    assert lexicon_doc["counts"]["cefrLemmas"] == 10_000
    assert lexicon_doc["counts"]["examWords"] == 8
    assert lexicon_doc["counts"]["entries"] == 10_005
    assert lexicon_doc["entries"]["abandon"][1] == "vt. 放弃, 抛弃"
    assert lexicon_doc["entries"]["abate"][1] == "vt. 减弱, 减轻"
    assert lexicon_doc["entries"]["qwerty"] == ["", "n. 键盘布局"]
    assert lexicon_doc["entries"]["africa"][1] == "n. 非洲"
    assert not builder.validate_lexicon_document(lexicon_doc, freq_doc, exam_doc)


def test_build_is_byte_idempotent_and_full_check_passes(tmp_path):
    frequency, csv_path, out_dir = _build_tiny(tmp_path)
    second_dir = tmp_path / "wordlists-2"
    code = builder.main(
        [
            "--ecdict-csv",
            str(csv_path),
            "--frequency",
            str(frequency),
            "--out-dir",
            str(second_dir),
            "--allow-small",
        ]
    )
    assert code == 0
    for name in (builder.EXAM_FILENAME, builder.LEXICON_FILENAME, builder.SIDECAR_FILENAME):
        assert (out_dir / name).read_bytes() == (second_dir / name).read_bytes()

    full_check = builder.main(
        [
            "--check",
            "--ecdict-csv",
            str(csv_path),
            "--frequency",
            str(frequency),
            "--out-dir",
            str(out_dir),
            "--allow-small",
        ]
    )
    assert full_check == 0
    offline_check = builder.main(
        ["--check", "--frequency", str(frequency), "--out-dir", str(out_dir)]
    )
    assert offline_check == 0


def test_check_detects_tampered_artifact_and_sidecar(tmp_path):
    frequency, csv_path, out_dir = _build_tiny(tmp_path)
    exam_path = out_dir / builder.EXAM_FILENAME
    document = json.loads(exam_path.read_text(encoding="utf-8"))
    document["entries"][0][2] += 1
    exam_path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")

    assert (
        builder.main(
            ["--check", "--frequency", str(frequency), "--out-dir", str(out_dir)]
        )
        == 1
    )
    assert (
        builder.main(
            [
                "--check",
                "--ecdict-csv",
                str(csv_path),
                "--frequency",
                str(frequency),
                "--out-dir",
                str(out_dir),
                "--allow-small",
            ]
        )
        == 1
    )


def test_build_rejects_tiny_csv_without_allow_small(tmp_path):
    frequency = copy_frequency(tmp_path / "frequency_bands.v1.json")
    csv_path = write_tiny_ecdict(tmp_path / "ecdict.csv")
    code = builder.main(
        [
            "--ecdict-csv",
            str(csv_path),
            "--frequency",
            str(frequency),
            "--out-dir",
            str(tmp_path / "out"),
        ]
    )
    assert code == 1


def test_build_rejects_csv_without_tag_column(tmp_path):
    csv_path = tmp_path / "no-tag.csv"
    csv_path.write_text("word,translation\nability,能力\n", encoding="utf-8")
    with pytest.raises(builder.BuildError, match="缺少列"):
        builder.build_documents(
            csv_path,
            builder.load_frequency(REAL_FREQUENCY),
            allow_small=True,
        )


# ---------------------------------------------------------------------------
# 已提交产物
# ---------------------------------------------------------------------------

def test_committed_artifacts_pass_offline_check_and_have_contract_fields():
    assert builder.main(["--check"]) == 0
    exam = json.loads((COMMITTED / builder.EXAM_FILENAME).read_text(encoding="utf-8"))
    lexicon = json.loads(
        (COMMITTED / builder.LEXICON_FILENAME).read_text(encoding="utf-8")
    )
    assert exam["counts"] == {"cet4": 3_837, "cet6": 5_396, "gre": 7_479, "unique": 11_307}
    assert lexicon["counts"]["entries"] == 15_807
    assert lexicon["counts"]["cefrLemmas"] == 10_000
    assert lexicon["counts"]["examWords"] == 11_307
    assert exam["source"]["csvSha256"] == (
        "d1ecbdf9ee2b920afb6f430ca6b6bb9f559588cf0dff86e04bd255f9390843cc"
    )
    assert exam["source"]["rows"] == 770_611
    for document in (exam, lexicon):
        assert document["license"]
        assert document["notice"] == "NOTICE.md"
        assert document["integrity"]["algorithm"] == "sha256"
    assert (COMMITTED / "NOTICE.md").exists()
    assert (COMMITTED / "README.md").exists()


def test_committed_artifacts_are_small_and_do_not_include_csv():
    for path in COMMITTED.iterdir():
        assert path.suffix != ".csv", f"不应提交原始 CSV：{path}"
        if path.is_file():
            assert path.stat().st_size < 5 * 1024 * 1024, f"产物过大：{path}"


def test_committed_sidecar_hashes_match_files():
    sidecar = COMMITTED / "SHA256SUMS"
    lines = [line.split() for line in sidecar.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert {name for _, name in lines} == {builder.EXAM_FILENAME, builder.LEXICON_FILENAME}
    for digest, name in lines:
        actual = hashlib.sha256((COMMITTED / name).read_bytes()).hexdigest()
        assert actual == digest


def test_committed_exam_lists_include_known_words_and_masks():
    exam = json.loads((COMMITTED / builder.EXAM_FILENAME).read_text(encoding="utf-8"))
    entries = {entry[0].lower(): entry for entry in exam["entries"]}
    assert entries["abandon"][1] == 7  # CET4 + CET6 + GRE
    assert entries["abate"][1] == 4  # GRE
    assert entries["zebra"][1] == 3  # CET4 + CET6（zebra 也是 gk/zk，但本产物只收三类）
    assert entries["africa"][0] == "Africa"  # 保留展示大小写
    assert "a" not in entries  # 常见功能词未被误标为 GRE/CET
