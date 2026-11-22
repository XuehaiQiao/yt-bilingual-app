"""``scripts/word_family_audit.py`` 的隔离单测（固定小样本，不下载 WordNet）。

覆盖：频表/释义加载、链接收集（自指/多词过滤）、10k 边界、并查集族合并、
head/族号稳定性、规则过滤、误合并清单计数与漂移校验、缺 WordNet 的错误信息。
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

import word_family_audit as audit  # noqa: E402


ANCHORS = ((1000, "A1"), (2000, "A2"), (4000, "B1"), (7000, "B2"), (10000, "C1"))


class FakeProvider:
    """最小 WordNet 替身：手工 relations / POS / synset 数。"""

    version = "3.0"
    wordnet_dir = "(fake)"

    def __init__(self, relations=None, pos=None, synsets=None):
        self._relations = relations or {}
        self._pos = pos or {}
        self._synsets = synsets or {}

    def relations(self, lemma):
        return tuple(self._relations.get(lemma, ()))

    def pos(self, word):
        return frozenset(self._pos.get(word, ()))

    def synset_count(self, word):
        return self._synsets.get(word, 1)


def make_graph(provider: FakeProvider, lemmas, ranks):
    raw = audit.collect_links(
        lemmas, provider.relations, synset_count=provider.synset_count)
    return raw, audit.build_graph(raw, lemmas, ranks, vocab_only=True)


def rel(source, target, pos="n", synset=None):
    return audit.Relation(source, target, synset or f"{source}.{pos}.01", pos)


# ---------------------------------------------------------------------------
# 输入加载
# ---------------------------------------------------------------------------

def test_load_cefr_and_lexicon_fixture(tmp_path: Path) -> None:
    frequency = {
        "schema": "linguatrek.wordlist.v1",
        "version": "test",
        "counts": {"lemmas": 4},
        "cefr_anchors": [
            {"max_rank": 2, "level": "A1"},
            {"max_rank": 4, "level": "A2"},
        ],
        "entries": [["Decide", 1], ["decision", 2], ["reflect", 3], ["x", 4]],
    }
    lexicon = {
        "schema": "linguatrek.lexicon.v1",
        "counts": {"entries": 2},
        "entries": {"decide": ["dɪ", "v. 决定"], "decision": ["dɪ", "n. 决定"]},
    }
    frequency_path = tmp_path / "frequency.json"
    lexicon_path = tmp_path / "lexicon.json"
    frequency_path.write_text(json.dumps(frequency), encoding="utf-8")
    lexicon_path.write_text(json.dumps(lexicon), encoding="utf-8")

    cefr = audit.load_cefr(frequency_path)
    assert cefr.lemmas == ("decide", "decision", "reflect", "x")
    assert cefr.ranks["decide"] == 1
    assert cefr.anchors == ((2, "A1"), (4, "A2"))
    assert audit.level_for_rank(2, cefr.anchors) == "A1"
    assert audit.level_for_rank(3, cefr.anchors) == "A2"
    assert audit.level_for_rank(999, cefr.anchors) == "A2"
    assert len(cefr.sha256) == 64
    lexicon = audit.load_lexicon(lexicon_path)
    assert len(lexicon.sha256) == 64
    assert lexicon.translations["decision"] == "n. 决定"


def test_load_cefr_rejects_duplicate_lemma(tmp_path: Path) -> None:
    frequency = {"entries": [["a", 1], ["a", 2]]}
    path = tmp_path / "frequency.json"
    path.write_text(json.dumps(frequency), encoding="utf-8")
    with pytest.raises(audit.AuditError, match="lemma 重复"):
        audit.load_cefr(path)


# ---------------------------------------------------------------------------
# 链接收集 / 构图
# ---------------------------------------------------------------------------

def test_collect_links_filters_self_and_multiword() -> None:
    provider = FakeProvider(
        relations={
            "a": [
                rel("a", "a"),            # 自指 → self_links
                rel("a", "multi word"),   # 多词 → multiword_links
                rel("a", "b"),            # 保留
                rel("a", "b"),            # 重复仍计数（collect 不去重）
            ],
            "b": [rel("b", "a")],
        },
        synsets={"a": 2, "b": 1, "c": 0},
    )
    raw = audit.collect_links(["a", "b", "c"], provider.relations,
                              synset_count=provider.synset_count)
    assert raw.total_occurrences == 5
    assert raw.self_links == 1
    assert raw.multiword_links == 1
    assert len(raw.links) == 3
    assert raw.no_synset == ("c",)


def test_build_graph_keeps_in_10k_edges_and_counts_dropped() -> None:
    provider = FakeProvider(
        relations={
            "a": [rel("a", "b"), rel("a", "outside")],
            "b": [rel("b", "c")],
        },
    )
    lemmas = ("a", "b", "c")
    ranks = {"a": 3, "b": 2, "c": 1}
    raw, graph = make_graph(provider, lemmas, ranks)
    assert {tuple(sorted(key)) for key in graph.edges} == {
        ("a", "b"), ("b", "c")}
    assert graph.dropped_links == 1
    assert ("a", "outside") in graph.dropped_pairs
    assert graph.dropped_targets[("a", "outside")] == 1

    full = audit.build_graph(raw, lemmas, ranks, vocab_only=False)
    assert len(full.edges) == 3
    assert full.dropped_links == 1


# ---------------------------------------------------------------------------
# 族合并 / head / 统计
# ---------------------------------------------------------------------------

def make_chain_graph():
    provider = FakeProvider(
        relations={
            "alpha": [rel("alpha", "beta", pos="v")],
            "beta": [rel("beta", "gamma", pos="v")],
            "gamma": [rel("gamma", "delta", pos="v")],
        },
    )
    lemmas = ("alpha", "beta", "gamma", "delta", "solo")
    ranks = {"alpha": 10, "beta": 5, "gamma": 30, "delta": 40, "solo": 50}
    return make_graph(provider, lemmas, ranks)[1]


def test_family_merge_is_transitive_and_head_is_most_frequent() -> None:
    graph = make_chain_graph()
    families, by_member = audit.build_families(graph, ANCHORS)
    assert len(families) == 1
    family = families[0]
    assert family.head == "beta"          # rank 5 最小
    assert family.members == ("beta", "alpha", "gamma", "delta")
    assert by_member["gamma"].id == family.id
    stats = audit.family_stats(families, len(graph.lemmas))
    assert stats["families"] == 1
    assert stats["lemmas_in_family"] == 4
    assert stats["singletons"] == 1
    assert stats["size_distribution"] == {"4": 1}


def test_family_ids_follow_head_rank() -> None:
    provider = FakeProvider(
        relations={
            "later": [rel("later", "latest")],
            "early": [rel("early", "earlier")],
        },
    )
    lemmas = ("early", "later", "earlier", "latest")
    ranks = {"early": 1, "later": 2, "earlier": 3, "latest": 4}
    _, graph = make_graph(provider, lemmas, ranks)
    families, _by_member = audit.build_families(graph, ANCHORS)
    assert [family.id for family in families] == ["F0001", "F0002"]
    assert [family.head for family in families] == ["early", "later"]


def test_describe_words_requires_every_query_word_in_family() -> None:
    graph = make_chain_graph()
    families, by_member = audit.build_families(graph, ANCHORS)
    same = audit.describe_words(graph, by_member, ("alpha", "beta"))
    assert same["sameFamily"] is True
    assert same["family"]["head"] == "beta"
    partial = audit.describe_words(graph, by_member, ("alpha", "solo"))
    assert partial["sameFamily"] is False
    unknown = audit.describe_words(graph, by_member, ("alpha", "not-in-10k"))
    assert unknown["sameFamily"] is False


# ---------------------------------------------------------------------------
# 规则
# ---------------------------------------------------------------------------

def test_same_pos_filter_drops_cross_pos_links() -> None:
    provider = FakeProvider(
        relations={
            "decide": [rel("decide", "decision", pos="v")],
            "major": [rel("major", "majority", pos="a")],
        },
        pos={"decide": ("v",), "decision": ("n",),
             "major": ("a", "n"), "majority": ("n",)},
    )
    lemmas = ("decide", "decision", "major", "majority")
    ranks = {"decide": 1, "decision": 2, "major": 3, "majority": 4}
    _, graph = make_graph(provider, lemmas, ranks)
    pos_map = {word: provider.pos(word) for word in lemmas}
    filtered = audit._filter_edges(graph.edges, pos_map, same_pos=True)
    assert len(graph.edges) == 2
    assert len(filtered) == 1
    assert audit.edge_key("decide", "decision") not in filtered
    assert audit.edge_key("major", "majority") in filtered


def test_evaluate_edges_reports_suspects() -> None:
    provider = FakeProvider(
        relations={
            "critical": [rel("critical", "crisis", pos="a")],
            "decide": [rel("decide", "decision", pos="v")],
        },
        pos={"critical": ("a",), "crisis": ("n",),
             "decide": ("v",), "decision": ("n",)},
    )
    lemmas = ("critical", "crisis", "decide", "decision")
    ranks = {word: index + 1 for index, word in enumerate(lemmas)}
    _, graph = make_graph(provider, lemmas, ranks)
    families, by_member = audit.build_families(graph, ANCHORS)
    result = audit.evaluate_edges(
        "tmp", "tmp", graph.edges, graph, by_member)
    # critical/crisis 与 decide/decision 都在人工清单里，但这次图里两条都存活。
    assert result["suspectEdges"] == 2
    assert result["suspectBadEdges"] == 1  # 只有 critical/crisis 是坏候选
    assert result["families"] == 2
    assert result["lemmasInFamily"] == 4
    assert result["coverageRatio"] == 1.0


def test_allowlist_bridges_wordnet_gap() -> None:
    provider = FakeProvider(
        relations={"reflect": [rel("reflect", "reflective", pos="v")]},
        pos={"reflect": ("v",), "reflective": ("a",), "reflection": ("n",)},
    )
    lemmas = ("reflect", "reflection", "reflective")
    ranks = {"reflect": 1, "reflection": 2, "reflective": 3}
    _, graph = make_graph(provider, lemmas, ranks)
    families, _by_member = audit.build_families(graph, ANCHORS)
    assert families[0].members == ("reflect", "reflective")
    added = audit._allowlist_edges(graph)
    assert audit.edge_key("reflect", "reflection") in added
    merged = audit.build_graph(
        audit.RawLinks(
            links=tuple(
                list(audit.collect_links(lemmas, provider.relations).links)
                + [audit.Relation("reflect", "reflection", "allowlist", "manual")]
            ),
            no_synset=(), total_occurrences=2, self_links=0, multiword_links=0,
        ),
        lemmas, ranks, vocab_only=True,
    )
    merged_families, _ = audit.build_families(merged, ANCHORS)
    assert merged_families[0].members == ("reflect", "reflection", "reflective")


# ---------------------------------------------------------------------------
# 误合并候选清单
# ---------------------------------------------------------------------------

def _curated_fixture_graph():
    """把人工清单里的 18 条图内边 + 1 条跨出边做成小图。"""
    in_graph = [
        item for item in audit.CURATED_MERGES if item.b != "adjudicate"
    ]
    lemmas = sorted({item.a for item in in_graph} | {item.b for item in in_graph})
    ranks = {word: index + 1 for index, word in enumerate(lemmas)}
    grouped = {}
    for item in in_graph:
        grouped.setdefault(item.a, []).append(rel(item.a, item.b, pos="n"))
    provider = FakeProvider(relations=grouped, pos={word: ("n",) for word in lemmas})
    raw = audit.collect_links(lemmas, provider.relations)
    assert raw.self_links == 0
    raw = audit.RawLinks(
        links=tuple(list(raw.links) + [
            audit.Relation("judge", "adjudicate", "judge.v.05", "v"),
        ]),
        no_synset=raw.no_synset,
        total_occurrences=raw.total_occurrences + 1,
        self_links=raw.self_links,
        multiword_links=raw.multiword_links,
    )
    graph = audit.build_graph(raw, lemmas, ranks, vocab_only=True)
    families, by_member = audit.build_families(graph, ANCHORS)
    return graph, families, by_member, lemmas, ranks


def test_curated_merge_ledger_is_consistent() -> None:
    assert len(audit.CURATED_MERGES) == 19
    assert len({audit.edge_key(item.a, item.b) for item in audit.CURATED_MERGES}) == 19
    assert audit.candidate_category("critical", "crisis") == audit.SEMANTIC_SPLIT
    assert audit.candidate_category("decide", "decision") == audit.POS_CONVERSION
    assert audit.candidate_category("tie", "tier") == audit.CLEAR_ERROR
    assert audit.candidate_category("critical", "critic") is None


def test_collect_merge_candidates_counts_and_validation() -> None:
    graph, _families, by_member, _lemmas, ranks = _curated_fixture_graph()
    pos_map = {word: frozenset(("n",)) for word in ranks}
    records, summary = audit.collect_merge_candidates(
        graph, pos_map, {"decide": "v. 决定", "decision": "n. 决定"},
        ranks, ANCHORS, by_member,
    )
    assert summary["total"] == 19
    assert summary["inGraph"] == 18
    assert summary["droppedOnly"] == 1
    assert summary["byCategory"]["semantic_split"]["total"] == 10
    assert summary["byCategory"]["pos_conversion"]["total"] == 5
    assert summary["byCategory"]["clear_error"]["total"] == 4
    assert summary["byCategory"]["clear_error"]["inGraph"] == 3
    assert summary["droppedOnlyPairs"] == ["judge/adjudicate"]
    ties = [row for row in records if row["a"] == "tie"][0]
    assert ties["morphSimilarity"] > 0
    assert ties["inGraph"] is True


def test_collect_merge_candidates_raises_on_missing_pair() -> None:
    graph, _families, by_member, _lemmas, ranks = _curated_fixture_graph()
    # 删掉 tie/tier 这条边 → 清单漂移必须显式报错，而不是静默少一条。
    edges = {
        key: edge for key, edge in graph.edges.items()
        if key != audit.edge_key("tie", "tier")
    }
    graph.edges = edges
    with pytest.raises(audit.AuditError, match="不在 WordNet"):
        audit.collect_merge_candidates(
            graph, {word: frozenset(("n",)) for word in ranks}, {},
            ranks, ANCHORS, by_member,
        )


# ---------------------------------------------------------------------------
# WordNet 缺失 / CLI
# ---------------------------------------------------------------------------

def test_missing_wordnet_dir_has_actionable_error(tmp_path: Path) -> None:
    with pytest.raises(audit.WordNetUnavailable, match="--wordnet-dir"):
        audit.WordNetProvider(str(tmp_path / "empty"))


def test_cli_missing_wordnet_returns_2(tmp_path: Path,
                                      capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "out.json"
    code = audit.main([
        "--wordnet-dir", str(tmp_path / "empty"),
        "--out", str(out),
        "--frequency", str(REPO_ROOT / "content/wordlist/frequency_bands.v1.json"),
        "--lexicon", str(REPO_ROOT / "content/wordlists/lexicon.v1.json"),
    ])
    assert code == 2
    assert "失败" in capsys.readouterr().err
    assert not out.exists()  # 前置失败不写任何输出
