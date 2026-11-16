"""自建频表构建与产物契约（M2，计划书 §4.2 / K18，specs/026）。

全部离线：构建用 tmp TSV 快照；已提交产物只读 `content/wordlist/`。
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

import difficulty

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_wordlist.py"
ARTIFACT = ROOT / "content" / "wordlist" / "frequency_bands.v1.json"
NOTICE = ROOT / "content" / "wordlist" / "NOTICE.md"
README = ROOT / "content" / "wordlist" / "README.md"


def _load_builder():
    spec = importlib.util.spec_from_file_location("build_wordlist", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


builder = _load_builder()


def _tsv(tmp_path: Path, words: list[tuple[str, float]]) -> Path:
    path = tmp_path / "freq.tsv"
    path.write_text(
        "\n".join(f"{word}\t{count}" for word, count in words) + "\n",
        encoding="utf-8",
    )
    return path


def _fake_word(index: int) -> str:
    """纯字母的唯一伪词（频表候选只收 ^[a-z]+$）。"""
    return "zz" + chr(97 + index // 26) + chr(97 + index % 26)


def _tiny_rows(count: int = 260) -> list[tuple[str, float]]:
    words = [("the", 100_000.0), ("and", 90_000.0), ("run", 8_000.0), ("running", 3_000.0)]
    words.extend((_fake_word(index), 1_000.0 - index) for index in range(count))
    return words


# ---------------------------------------------------------------------------
# 纯函数 / 构建
# ---------------------------------------------------------------------------

def test_candidate_filter_rejects_subtitle_junk_and_keeps_function_words():
    assert builder.is_candidate("the")
    assert builder.is_candidate("ok")
    assert builder.is_candidate("a")
    assert not builder.is_candidate("ll")
    assert not builder.is_candidate("govt")
    assert not builder.is_candidate("x")
    assert not builder.is_candidate("don't")


def test_fold_lemma_uses_irregular_table_and_avoids_bad_stems():
    zipf = {"run": 6.0, "running": 5.5, "news": 6.0, "new": 6.5, "business": 5.2}
    assert builder.fold_lemma("running", zipf) == "run"
    # news→new 是频带相邻的良性误折（词表只用于频带，不承载语义）。
    assert builder.fold_lemma("news", zipf) in {"news", "new"}
    assert builder.fold_lemma("business", zipf) == "business"


def test_build_document_is_deterministic_and_self_consistent():
    rows = _tiny_rows()
    first = builder.build_document(
        rows, limit=200, band_size=100, source_meta={"name": "test", "version": "1"}
    )
    second = builder.build_document(
        rows, limit=200, band_size=100, source_meta={"name": "test", "version": "1"}
    )
    assert builder.serialize(first) == builder.serialize(second)
    assert builder.validate_document(first) == []
    assert first["counts"]["lemmas"] == 200
    assert first["counts"]["bands"] == 2
    assert first["license"] == "CC-BY-SA-4.0"
    assert first["source"]["name"] == "test"
    assert first["integrity"]["sha256"] == builder.payload_sha256(first)


def test_build_document_records_forms_and_cefr_anchors():
    rows = _tiny_rows()
    document = builder.build_document(
        rows, limit=200, band_size=100, source_meta={"name": "test", "version": "1"}
    )
    assert document["forms"].get("running") == "run"
    assert [item["level"] for item in document["cefr_anchors"]] == [
        "A1",
        "A2",
        "B1",
        "B2",
        "C1",
    ]
    assert set(document["cefr_probs"]) == {"1", "2"}
    assert abs(sum(document["cefr_probs"]["1"].values()) - 1.0) < 0.01


def test_validate_document_catches_tampering():
    document = builder.build_document(
        _tiny_rows(), limit=200, band_size=100, source_meta={"name": "test", "version": "1"}
    )
    tampered = json.loads(json.dumps(document))
    tampered["entries"][0][0] = "tampered"
    problems = builder.validate_document(tampered)
    assert any("integrity" in problem or "rank" in problem for problem in problems)

    broken = json.loads(json.dumps(document))
    broken["entries"][3][1] = 99
    assert builder.validate_document(broken)


def test_cli_build_is_idempotent_and_check_mode(tmp_path, capsys):
    source = _tsv(tmp_path, _tiny_rows())
    out = tmp_path / "wordlist.json"
    argv = [
        "--freq-tsv",
        str(source),
        "--limit",
        "200",
        "--band-size",
        "100",
        "--out",
        str(out),
    ]
    assert builder.main(argv) == 0
    first = out.read_bytes()
    assert builder.main(argv) == 0
    assert out.read_bytes() == first
    assert builder.main(["--check", "--out", str(out)]) == 0
    assert "OK" in capsys.readouterr().out

    damaged = json.loads(out.read_text(encoding="utf-8"))
    damaged["entries"][0][0] = "zzz"
    out.write_text(json.dumps(damaged), encoding="utf-8")
    assert builder.main(["--check", "--out", str(out)]) == 1


def test_cli_rejects_tiny_limit(tmp_path):
    source = _tsv(tmp_path, _tiny_rows())
    assert builder.main(["--freq-tsv", str(source), "--limit", "50"]) == 2


# ---------------------------------------------------------------------------
# 已提交产物
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def artifact() -> dict:
    return json.loads(ARTIFACT.read_text(encoding="utf-8"))


def test_committed_artifact_contract(artifact):
    assert builder.validate_document(artifact) == []
    assert artifact["schema"] == "linguatrek.wordlist.v1"
    assert artifact["license"] == "CC-BY-SA-4.0"
    assert artifact["licenseUrl"].startswith("https://creativecommons.org/licenses/by-sa/4.0")
    assert artifact["source"]["name"] == "wordfreq"
    assert artifact["source"]["version"] == "3.1.1"
    assert artifact["source"]["dataLicense"] == "CC-BY-SA-4.0"
    assert artifact["band_size"] == 1000
    lemmas = artifact["counts"]["lemmas"]
    assert 8_000 <= lemmas <= 10_000
    assert artifact["counts"]["bands"] == 10
    assert all(count == 1000 for count in artifact["counts"]["by_band"].values())
    assert artifact["integrity"]["sha256"] == builder.payload_sha256(artifact)


def test_committed_artifact_covers_function_words_and_forms(artifact):
    ranks = {lemma: rank for lemma, rank in artifact["entries"]}
    for word in ("the", "and", "of", "to", "be", "have", "go", "run", "child"):
        assert word in ranks, word
    forms = artifact["forms"]
    assert forms.get("running") == "run"
    assert forms.get("went") == "go"
    assert forms.get("children") == "child"
    assert forms.get("asked") == "ask"


def test_committed_sidecar_hash_matches_file():
    sidecar = ROOT / "content" / "wordlist" / "SHA256SUMS"
    assert sidecar.is_file()
    line = sidecar.read_text(encoding="utf-8").strip()
    expected, name = line.split()
    assert name == ARTIFACT.name
    assert expected == builder.file_sha256(ARTIFACT)


def test_notice_and_readme_document_license_and_limits():
    notice = NOTICE.read_text(encoding="utf-8")
    assert "CC BY-SA 4.0" in notice or "CC-BY-SA-4.0" in notice
    assert "wordfreq" in notice
    assert "3.1.1" in notice
    assert "署名" in notice or "Attribution" in notice
    readme = README.read_text(encoding="utf-8")
    assert "wordfreq" in readme
    assert "CEFR-J" in readme and "Octanove" in readme
    assert "商用" in readme
    assert "局限" in readme or "limitation" in readme.lower()


def test_difficulty_module_loads_committed_wordlist():
    difficulty.reset_wordlist_cache()
    wordlist = difficulty.load_wordlist()
    assert wordlist.license == "CC-BY-SA-4.0"
    assert wordlist.version
    assert 1 <= wordlist.rank_of("the") <= 5
    assert wordlist.lemma_for("running") == "run"
    assert wordlist.lemma_for("went") == "go"
    assert wordlist.lemma_for("zzzzunknown") is None
