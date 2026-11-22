"""``scripts/word_family_open_audit.py`` 的隔离单测（固定小样本，不下载 WordNet）。

覆盖 P1-04 的核心规则：
- 锚定过滤：分量里没有 CEFR 10k 成员 → 不成族；
- 跨边界成员：族内保留 10k 外词，等级留空；
- 两个 10k 词可以只靠一个 10k 外词桥接成同一族；
- 无族词（the / at）不进 families / mapping；
- 坏边分类、人工清单漂移校验、allowlist 去重校验；
- 黑名单删边会拆族；
- 输出确定性（无时间戳、两次 dump 字节一致）。

所有用例只喂假数据（``FakeProvider`` / 手写边集），不读取仓库数据、不联网。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import word_family_open_audit as audit  # noqa: E402


ANCHORS = ((1000, "A1"), (2000, "A2"), (4000, "B1"), (7000, "B2"), (10000, "C1"))


class FakeProvider:
    """最小 WordNet 替身：直接给派生指针记录，不碰 nltk。"""

    version = "3.0"
    wordnet_dir = "(fake)"

    def __init__(self, records=None):
        self._records = tuple(records or ())

    def derivation_pointers(self):
        return iter(self._records)


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def test_normalize_word_case_nfc_and_spaces() -> None:
    assert audit.normalize_word("  Decide ") == "decide"
    assert audit.normalize_word("e\u0301") == "\u00e9"  # e + 组合重音 → NFC
    assert audit.normalize_word(None) == ""
    assert audit.normalize_word(123) == "123"


def test_edge_pair_filters_self_multiword_and_empty() -> None:
    assert audit.edge_pair("judge", "adjudicate") == ("adjudicate", "judge")
    assert audit.edge_pair("Adjudicate", "JUDGE") == ("adjudicate", "judge")
    assert audit.edge_pair("judge", "judge") is None
    assert audit.edge_pair("ad_hoc", "ad") is None
    assert audit.edge_pair("ad", "ad_hoc") is None
    assert audit.edge_pair("", "judge") is None
    assert audit.edge_pair(None, "judge") is None


def test_level_for_rank_boundaries() -> None:
    assert audit.level_for_rank(1, ANCHORS) == "A1"
    assert audit.level_for_rank(1000, ANCHORS) == "A1"
    assert audit.level_for_rank(1001, ANCHORS) == "A2"
    assert audit.level_for_rank(7000, ANCHORS) == "B2"
    assert audit.level_for_rank(7001, ANCHORS) == "C1"
    assert audit.level_for_rank(10000, ANCHORS) == "C1"
    assert audit.level_for_rank(10001, ANCHORS) == "C1"


def test_median_of() -> None:
    assert audit.median_of([]) == 0.0
    assert audit.median_of([2]) == 2.0
    assert audit.median_of([2, 3]) == 2.5
    assert audit.median_of([3, 2, 3]) == 3.0


# ---------------------------------------------------------------------------
# 构图：去重 / 自指 / 多词 / 证据
# ---------------------------------------------------------------------------

def test_build_edge_index_dedupes_and_records_evidence() -> None:
    records = (
        ("judge", "adjudicate", "judge.n.01", "n"),
        ("adjudicate", "judge", "decide.v.02", "v"),   # 反向，同一条无向边
        ("judge", "judicial", "judge.n.01", "n"),
        ("judge", "judge", "judge.n.01", "n"),          # 自指
        ("ad_hoc", "hot", "ad_hoc.s.01", "s"),          # 多词
        ("Judge", "Judgment", "judge.n.01", "n"),       # 大小写归一
    )
    index = audit.build_edge_index(records)

    assert index.edge_count == 3
    assert index.nodes == ("adjudicate", "judge", "judgment", "judicial")
    assert index.edges[("adjudicate", "judge")] == (
        ("decide.v.02", "v"), ("judge.n.01", "n"))
    assert index.raw_pointers == 6
    assert index.self_pointers == 1
    assert index.multiword_pointers == 1
    assert index.case_altered_pointers == 1
    # 多词对规范化成带空格的词，只用于桥接统计，不进边集
    assert index.multiword_pairs == (("ad hoc", "hot"),)
    assert ("hot", "judge") not in index.pairs


def test_multiword_bridge_effect_is_measured_separately() -> None:
    records = (
        ("a", "c", "s.01", "n"),
        ("b", "d", "s.02", "n"),
        ("x_y", "c", "s.03", "n"),
        ("x_y", "d", "s.03", "n"),
    )
    index = audit.build_edge_index(records)
    assert index.edge_count == 2
    effect = audit.measure_multiword_bridge(index)
    assert effect["singleWordComponentsBefore"] == 2
    assert effect["componentsMergedIfIncluded"] == 1


# ---------------------------------------------------------------------------
# 词族规则
# ---------------------------------------------------------------------------

def test_component_without_cefr_anchor_is_not_a_family() -> None:
    ranks = {"the": 1}
    table = audit.build_families(
        [("alpha", "beta"), ("beta", "gamma")], ranks, ANCHORS)
    assert table.families == ()
    assert table.component_count == 1
    assert table.components_without_cefr == 1
    assert table.mapping == {}


def test_cross_boundary_member_kept_with_empty_level() -> None:
    ranks = {"decide": 10, "decision": 20}
    table = audit.build_families(
        [("decide", "deciding"), ("decision", "deciding")], ranks, ANCHORS)

    assert len(table.families) == 1
    family = table.families[0]
    assert family.head == "decide"
    assert family.head_level == "A1"
    assert family.size == 3
    assert [member.word for member in family.members] == [
        "decide", "decision", "deciding"]
    outside = family.members[-1]
    assert (outside.rank, outside.level, outside.in_cefr) == (None, None, False)
    # 10k 外成员也进映射（候选文件要能查到），head 仍是 10k 内那个
    ref = table.mapping["deciding"]
    assert (ref.family, ref.head, ref.size) == (family.id, "decide", 3)


def test_two_cefr_words_bridged_by_outside_lemma_share_one_family() -> None:
    """P1-04 的关键新规则：10k 外的 pivot 可以把两个 10k 词并进同一族。"""
    ranks = {"sign": 5, "significant": 6}
    table = audit.build_families(
        [("sign", "signify"), ("significant", "signify")], ranks, ANCHORS)
    assert len(table.families) == 1
    family = table.families[0]
    assert family.size == 3
    assert {member.word for member in family.cefr_members} == {"sign", "significant"}
    assert family.head == "sign"


def test_no_family_words_are_excluded_everywhere() -> None:
    ranks = {"the": 1, "at": 2, "decide": 3, "decision": 4}
    table = audit.build_families([("decide", "decision")], ranks, ANCHORS)
    assert "the" not in table.mapping
    assert "at" not in table.mapping
    assert {member.word for family in table.families for member in family.members} == {
        "decide", "decision"}
    coverage = audit.coverage_for([("decide", "decision")], ranks, ANCHORS)
    assert coverage.cefr_members == 2
    assert coverage.cefr_without_family == 2
    assert coverage.cefr_coverage_pct == 50.0


def test_head_is_lowest_rank_and_family_ids_follow_head_rank() -> None:
    ranks = {"beta": 200, "alpha": 100, "gamma": 300}
    table = audit.build_families(
        [("beta", "outsideb"), ("alpha", "outsidea"), ("gamma", "outsidea")],
        ranks, ANCHORS)
    # alpha 族（head rank 100）先编号；gamma 与 alpha 同族（rank 300 不是 head）
    assert [family.id for family in table.families] == ["F0001", "F0002"]
    assert [family.head for family in table.families] == ["alpha", "beta"]
    assert table.mapping["gamma"].family == "F0001"


def test_family_members_sorted_by_rank_then_alphabetical() -> None:
    ranks = {"a": 100, "b": 200}
    table = audit.build_families([("a", "b"), ("a", "zout"), ("a", "cout")],
                                 ranks, ANCHORS)
    assert [member.word for member in table.families[0].members] == [
        "a", "b", "cout", "zout"]


def test_family_ids_are_stable_across_calls() -> None:
    pairs = [("decide", "deciding"), ("judge", "adjudicate"), ("sign", "signify")]
    ranks = {"decide": 1, "judge": 2, "sign": 3}
    first = audit.build_families(pairs, ranks, ANCHORS)
    second = audit.build_families(list(reversed(pairs)), ranks, ANCHORS)
    assert [f.to_json() for f in first.families] == [
        f.to_json() for f in second.families]


# ---------------------------------------------------------------------------
# 统计
# ---------------------------------------------------------------------------

def test_coverage_counts_sizes_and_distribution() -> None:
    ranks = {"a": 1, "b": 2, "c": 3, "d": 4}
    pairs = [("a", "b"), ("c", "d"), ("c", "out1")]
    coverage = audit.coverage_for(pairs, ranks, ANCHORS)
    assert coverage.edges == 3
    assert coverage.families == 2
    assert coverage.members == 5          # a,b + c,d,out1
    assert coverage.cefr_members == 4
    assert coverage.outside_members == 1
    assert coverage.max_size == 3
    assert coverage.median_size == 2.5
    assert coverage.size_distribution == {2: 1, 3: 1}
    assert coverage.families_with_multiple_cefr == 2
    assert coverage.cefr_without_family == 0
    assert coverage.cefr_coverage_pct == 100.0


# ---------------------------------------------------------------------------
# 坏边 / 黑名单 / allowlist
# ---------------------------------------------------------------------------

def test_bad_edge_validation_and_drift_detection() -> None:
    edges = {("crisis", "critical"), ("adjudicate", "judge")}
    entries = (
        {"a": "critical", "b": "crisis", "category": audit.SEMANTIC_SPLIT},
        {"a": "judge", "b": "adjudicate", "category": audit.CLEAR_ERROR},
    )
    validated = audit.validate_edge_list(entries, edges, label="test")
    assert validated == (("crisis", "critical"), ("adjudicate", "judge"))

    with pytest.raises(audit.AuditError, match="找不到"):
        audit.validate_edge_list(
            ({"a": "critical", "b": "crisis", "category": audit.SEMANTIC_SPLIT},),
            set(), label="test")

    with pytest.raises(audit.AuditError, match="未知类别"):
        audit.validate_edge_list(
            ({"a": "critical", "b": "crisis", "category": "nonsense"},),
            edges, label="test")

    with pytest.raises(audit.AuditError, match="已经有 WordNet 派生边"):
        audit.validate_edge_list(
            ({"a": "critical", "b": "crisis"},), edges,
            label="test", must_exist=False)


def test_families_containing_counts_only_same_family_edges() -> None:
    ranks = {"a": 1, "b": 2, "c": 3, "d": 4}
    table = audit.build_families(
        [("a", "b"), ("c", "d"), ("a", "out")], ranks, ANCHORS)
    assert audit.families_containing(
        [("a", "b"), ("a", "out")], table) == (table.mapping["a"].family,)
    # 两端不同族 → 不计
    assert audit.families_containing(
        [("a", "c")], table) == ()


def test_allowlist_adds_missing_member_and_blacklist_splits_family() -> None:
    ranks = {"reflect": 1, "reflective": 2, "reflection": 3}
    base = [("reflect", "reflective")]

    before = audit.coverage_for(base, ranks, ANCHORS)
    after = audit.coverage_for(base + [("reflect", "reflection")], ranks, ANCHORS)
    assert (before.families, before.cefr_members) == (1, 2)
    assert (after.families, after.cefr_members) == (1, 3)

    # 黑名单删掉唯一一条边 → 族消失，两个词变无族
    removed = audit.coverage_for([], ranks, ANCHORS)
    assert (removed.families, removed.cefr_without_family) == (0, 3)


def test_rule_matrix_rows_are_ordered_and_labelled() -> None:
    records = (
        ("crisis", "critical", "crisis.n.01", "n"),
        ("decide", "decision", "decide.v.01", "v"),
    )
    index = audit.build_edge_index(records)
    ranks = {"critical": 1, "crisis": 2, "decide": 3, "decision": 4}
    bad = (("crisis", "critical"),)
    allow = (("decide", "decision"),)  # 注：这里有边，只用于行数检查
    rows = audit.rule_matrix(index, ranks, ANCHORS, bad, allow)
    assert [row["key"] for row in rows] == ["A", "B", "C", "D", "E"]
    baseline, opened, with_allow, with_black, recommended = rows
    assert baseline["edges"] == 2 and baseline["badEdgesPresent"] == 1
    assert opened["families"] == 2
    assert with_black["badEdgesPresent"] == 0
    assert with_black["families"] == 1        # 删掉 crisis/critical 后只剩一族
    assert recommended["families"] == 1


# ---------------------------------------------------------------------------
# 端到端（假 WordNet），输出确定性
# ---------------------------------------------------------------------------

def _write_frequency(tmp_path: Path) -> Path:
    document = {
        "schema": "linguatrek.wordlist.v1",
        "entries": [
            ["decide", 1], ["decision", 2], ["judge", 3], ["crisis", 4],
            ["critical", 5], ["the", 6], ["at", 7],
        ],
        "cefr_anchors": [
            {"max_rank": 1000, "level": "A1"},
            {"max_rank": 2000, "level": "A2"},
        ],
        "counts": {"lemmas": 7},
    }
    path = tmp_path / "frequency.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def test_run_audit_end_to_end_is_deterministic_and_timestamp_free(
        tmp_path: Path) -> None:
    frequency = _write_frequency(tmp_path)
    lexicon = tmp_path / "lexicon.json"
    lexicon.write_text(json.dumps({"entries": {}}), encoding="utf-8")
    records = (
        ("decide", "decision", "decide.v.01", "v"),
        ("judge", "adjudicate", "judge.n.01", "n"),
        ("crisis", "critical", "crisis.n.01", "n"),
    )
    result = audit.run_audit(
        audit.load_cefr(frequency),
        FakeProvider(records),
        frequency_path=frequency,
        lexicon_path=lexicon,
        bad_edges=(
            {"a": "judge", "b": "adjudicate", "category": audit.CLEAR_ERROR,
             "group": "opened", "reason": "fake"},
        ),
        benign_edges=(),
        allowlist=(),
    )
    document = result.document
    assert document["coverage"]["families"] == 3
    assert document["coverage"]["cefrMembers"] == 5
    assert document["coverage"]["cefrWithoutFamily"] == 2   # the / at
    assert document["coverage"]["outsideMembers"] == 1
    assert document["assertions"]["theInAnyFamily"] is False
    assert document["assertions"]["atInAnyFamily"] is False
    assert "the" not in document["mapping"] and "at" not in document["mapping"]
    assert document["badEdges"][0]["a"] == "adjudicate"
    assert set(document["families"][0]) == {
        "id", "head", "headLevel", "size", "cefrMembers", "members"}

    text = audit.dump_json(document)
    assert text == audit.dump_json(document)
    assert set(document).isdisjoint({"timings", "generatedAt", "elapsed"})
    assert "timings" not in json.loads(text)
    # 报告耗时只在 stdout，不进 JSON
    assert set(result.timings) == {"scan", "build", "families", "total"}


def test_stdout_render_contains_key_sections(tmp_path: Path) -> None:
    frequency = _write_frequency(tmp_path)
    lexicon = tmp_path / "lexicon.json"
    lexicon.write_text(json.dumps({"entries": {}}), encoding="utf-8")
    result = audit.run_audit(
        audit.load_cefr(frequency),
        FakeProvider((("decide", "decision", "decide.v.01", "v"),)),
        frequency_path=frequency,
        lexicon_path=lexicon,
        bad_edges=(), benign_edges=(), allowlist=(),
    )
    lines = audit.render_stdout(result.document, result.timings, "/tmp/x.json")
    text = "\n".join(lines)
    for section in ("== 图", "== 词族", "== 示例族", "== 规则对比",
                    "== 无族词", "== 性能"):
        assert section in text
    assert "3,694" not in text  # 假数据不该出现真实审计数字


# ---------------------------------------------------------------------------
# 输入校验 / CLI
# ---------------------------------------------------------------------------

def test_load_cefr_rejects_duplicate_lemma(tmp_path: Path) -> None:
    path = tmp_path / "dup.json"
    path.write_text(json.dumps({"entries": [["a", 1], ["A", 2]]}), encoding="utf-8")
    with pytest.raises(audit.AuditError, match="lemma 重复"):
        audit.load_cefr(path)


def test_load_cefr_requires_entries_array(tmp_path: Path) -> None:
    path = tmp_path / "bad.json"
    path.write_text(json.dumps({"nope": []}), encoding="utf-8")
    with pytest.raises(audit.AuditError, match="entries"):
        audit.load_cefr(path)


def test_cli_missing_wordnet_returns_2(tmp_path: Path) -> None:
    frequency = _write_frequency(tmp_path)
    code = audit.main([
        "--frequency", str(frequency),
        "--lexicon", str(tmp_path / "missing.json"),
        "--wordnet-dir", str(tmp_path / "no-such-wordnet"),
        "--no-write",
    ])
    assert code == 2
