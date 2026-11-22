"""``scripts/build_word_families.py`` 的隔离单测（固定小样本，不下载 WordNet）。

覆盖 specs/041 的规则 E 生成逻辑：

- 人工清单形状：17 条黑名单 / 22 条 allowlist、类别/分组合法、无重复/重叠；
- 清单漂移：黑名单边不存在、allowlist 边已存在、allowlist 两侧不在 10k → 报错；
- 构图：≥2 成员且 ≥1 个 10k 成员才成族；10k 外成员保留且 level/rank=null；
  无族词（the/at）不写入；head = 10k 内 rank 最小者，id 按 head rank 升序；
- 黑名单删边会拆族/踢出成员；allowlist 补边会把单例并入族；
- 文档溯源：source/license/ruleVersion/blacklist/allowlist + integrity；
- 输出确定性（无时间戳，两次 dump 字节一致）；
- 已提交数据与规则 E 验收数字一致、integrity 可复算。

所有用例只喂假数据；唯一读取仓库文件的是「已提交数据」契约测试。
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

import build_word_families as build  # noqa: E402
import word_family_open_audit as audit  # noqa: E402

ANCHORS = ((1000, "A1"), (2000, "A2"), (4000, "B1"), (7000, "B2"), (10000, "C1"))
DATA_PATH = REPO_ROOT / "content/wordlist/word-families.v1.json"

RANKS = {
    "run": 100,
    "decide": 494,
    "strong": 900,
    "critical": 1486,
    "reflect": 1645,
    "decision": 603,
    "decisive": 7294,
    "reflection": 3622,
    "reflective": 9839,
    "strength": 950,
    "critic": 3000,
    "runner": 2000,
    "crisis": 2113,
    "the": 1,
    "at": 5,
}

RECORDS = (
    ("decide", "decision", "decide.v.01", "v"),
    ("decide", "decisive", "decide.v.01", "v"),
    ("reflect", "reflective", "reflect.v.04", "v"),
    ("critical", "crisis", "crisis.n.01", "n"),
    ("critical", "critic", "critical.a.01", "a"),
    ("run", "running", "run.v.01", "v"),
    ("running", "runner", "running.n.01", "n"),
    ("foo", "bar", "foo.n.01", "n"),
)

BLACKLIST = ({
    "a": "critical", "b": "crisis", "category": "semantic_split",
    "group": "new", "reason": "测试用坏边",
},)
ALLOWLIST = (
    {"a": "reflect", "b": "reflection", "reason": "测试用缺失边"},
    {"a": "strong", "b": "strength", "reason": "测试用缺失边"},
)


def make_index(records=RECORDS) -> audit.EdgeIndex:
    return audit.build_edge_index(records)


def make_cefr(ranks=RANKS) -> audit.CefrInput:
    return audit.CefrInput(
        lemmas=tuple(ranks),
        ranks=dict(ranks),
        anchors=ANCHORS,
        sha256="f" * 64,
        counts={"lemmas": len(ranks)},
    )


def build_document(records=RECORDS, ranks=RANKS, blacklist=BLACKLIST,
                   allowlist=ALLOWLIST) -> dict:
    return build.build_family_document(
        make_index(records),
        make_cefr(ranks),
        blacklist=blacklist,
        allowlist=allowlist,
        provider_version="3.0",
        frequency_path=DATA_PATH,
        frequency_version="test",
    )


def family_by_head(document: dict, head: str) -> dict:
    return next(family for family in document["families"] if family["head"] == head)


# ---------------------------------------------------------------------------
# 人工清单
# ---------------------------------------------------------------------------

def test_manual_lists_shape() -> None:
    assert len(build.BLACKLIST) == 17
    assert len(build.ALLOWLIST) == 22
    black = [(entry["a"], entry["b"]) for entry in build.BLACKLIST]
    allow = [(entry["a"], entry["b"]) for entry in build.ALLOWLIST]
    assert len(set(black)) == 17
    assert len(set(allow)) == 22
    assert not set(black) & set(allow)
    assert {entry["category"] for entry in build.BLACKLIST} == {
        "semantic_split", "clear_error",
    }
    assert {entry["group"] for entry in build.BLACKLIST} == {
        "inherited", "opened", "new",
    }
    for entry in (*build.BLACKLIST, *build.ALLOWLIST):
        assert entry["a"] == entry["a"].strip().lower()
        assert entry["b"] == entry["b"].strip().lower()
        assert entry["a"] != entry["b"]
        assert "_" not in entry["a"] and "_" not in entry["b"]
        assert entry["reason"].strip()
    # 卡里点名的几条必须在清单里。
    assert ("judge", "adjudicate") in set(black)
    assert ("critical", "crisis") in set(black)
    assert ("reflect", "reflection") in set(allow)
    assert ("difficult", "difficulty") in set(allow)


def test_manual_list_validation_and_drift() -> None:
    index = make_index()
    black, allow = build.validate_manual_lists(
        index.pairs, blacklist=BLACKLIST, allowlist=ALLOWLIST)
    assert len(black) == len(BLACKLIST)
    assert len(allow) == len(ALLOWLIST)

    with pytest.raises(audit.AuditError, match="BLACKLIST"):
        build.validate_manual_lists(
            index.pairs,
            blacklist=({"a": "no-such", "b": "edge-pair",
                        "category": "clear_error", "group": "new",
                        "reason": "x"},),
            allowlist=(),
        )
    with pytest.raises(audit.AuditError, match="ALLOWLIST"):
        build.validate_manual_lists(
            index.pairs,
            blacklist=(),
            allowlist=({"a": "decide", "b": "decision", "reason": "已存在"},),
        )
    with pytest.raises(build.BuildError, match="重复"):
        build.validate_manual_lists(
            index.pairs,
            blacklist=(BLACKLIST[0], BLACKLIST[0]),
            allowlist=(),
        )
    with pytest.raises(build.BuildError, match="重复"):
        build.validate_manual_lists(
            index.pairs,
            blacklist=(),
            allowlist=(ALLOWLIST[0], ALLOWLIST[0]),
        )


def test_allowlist_requires_both_sides_in_cefr() -> None:
    with pytest.raises(build.BuildError, match="两侧都在 10k"):
        build.build_family_document(
            make_index(),
            make_cefr(),
            blacklist=(),
            allowlist=({"a": "the", "b": "zzz-not-in-10k", "reason": "x"},),
            frequency_path=DATA_PATH,
        )


# ---------------------------------------------------------------------------
# 构图
# ---------------------------------------------------------------------------

def test_document_counts_and_family_contract() -> None:
    document = build_document()
    counts = document["counts"]
    assert counts["families"] == 5
    assert counts["members"] == 13
    assert counts["cefrMembers"] == 12
    assert counts["outsideMembers"] == 1
    assert counts["maxFamilySize"] == 3
    assert counts["cefrWithoutFamily"] == 3  # crisis（黑名单后）/ the / at
    assert counts["blacklistEdges"] == 1
    assert counts["allowlistEdges"] == 2
    assert [family["id"] for family in document["families"]] == [
        "F0001", "F0002", "F0003", "F0004", "F0005",
    ]
    assert [family["head"] for family in document["families"]] == [
        "run", "decide", "strong", "critical", "reflect",
    ]
    for family in document["families"]:
        assert len(family["members"]) >= 2
        assert family["head"] == family["members"][0]["lemma"]
        assert family["headRank"] == family["members"][0]["rank"]
        assert family["headLevel"] == family["members"][0]["level"]
        assert any(member["level"] for member in family["members"])
        assert family["levels"] == [
            level for level in ("A1", "A2", "B1", "B2", "C1")
            if any(member["level"] == level for member in family["members"])
        ]


def test_cross_boundary_member_kept_with_empty_level() -> None:
    document = build_document()
    run = family_by_head(document, "run")
    assert [member["lemma"] for member in run["members"]] == [
        "run", "runner", "running",
    ]
    outside = run["members"][-1]
    assert outside == {"lemma": "running", "level": None, "rank": None}
    assert run["levels"] == ["A1", "A2"]


def test_allowlist_merges_and_blacklist_splits() -> None:
    with_allow = build_document()
    reflect = family_by_head(with_allow, "reflect")
    assert [member["lemma"] for member in reflect["members"]] == [
        "reflect", "reflection", "reflective",
    ]
    assert "reflection" in {member["lemma"] for member in reflect["members"]}

    # 黑名单把 crisis 从 critical 族踢出（10k 但无族 → 不写入）。
    critical = family_by_head(with_allow, "critical")
    assert [member["lemma"] for member in critical["members"]] == [
        "critical", "critic",
    ]
    all_members = {
        member["lemma"]
        for family in with_allow["families"]
        for member in family["members"]
    }
    assert "crisis" not in all_members
    assert "the" not in all_members
    assert "at" not in all_members

    without_blacklist = build_document(blacklist=())
    critical_before = family_by_head(without_blacklist, "critical")
    assert [member["lemma"] for member in critical_before["members"]] == [
        "critical", "crisis", "critic",
    ]
    assert without_blacklist["counts"]["members"] == 14
    assert without_blacklist["counts"]["cefrMembers"] == 13


# ---------------------------------------------------------------------------
# 文档溯源与确定性
# ---------------------------------------------------------------------------

def test_document_provenance_and_integrity() -> None:
    document = build_document()
    assert document["schema"] == "linguatrek.word-family.v1"
    assert document["ruleVersion"] == "E"
    assert document["generatedBy"] == "scripts/build_word_families.py"
    assert "WordNet" in document["license"]
    assert document["source"]["wordnet"]["version"] == "3.0"
    assert document["source"]["frequencyBands"]["sha256"] == "f" * 64
    integrity = document["integrity"]
    assert integrity["algorithm"] == "sha256"
    assert integrity["scope"] == "counts+families+blacklist+allowlist"
    assert integrity["sha256"] == build.integrity_sha256(
        build.canonical_payload(document))
    assert len(document["blacklist"]) == 1
    assert len(document["allowlist"]) == 2


def test_render_is_deterministic_and_timestamp_free() -> None:
    first = build.dump_json(build_document())
    second = build.dump_json(build_document())
    assert first == second
    assert first.endswith("\n")
    assert "generatedAt" not in first
    assert "timestamp" not in first.lower()
    document = json.loads(first)
    assert document["counts"]["members"] == 13


def test_expected_counts_guard_rejects_drift() -> None:
    with pytest.raises(build.BuildError, match="规则 E 验收数字不符"):
        build.assert_expected_counts(build_document())
    # 已提交数据的计数必须通过同一守卫（在契约测试里由真实文件覆盖）。


# ---------------------------------------------------------------------------
# 已提交数据契约（不依赖 WordNet；只读文件）
# ---------------------------------------------------------------------------

def test_committed_data_matches_rule_e_contract() -> None:
    assert DATA_PATH.exists()
    document = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    build.assert_expected_counts(document)
    assert document["ruleVersion"] == "E"
    assert len(document["blacklist"]) == 17
    assert len(document["allowlist"]) == 22
    assert document["integrity"]["sha256"] == build.integrity_sha256(
        build.canonical_payload(document))
    members = {
        member["lemma"]
        for family in document["families"]
        for member in family["members"]
    }
    assert "the" not in members
    assert "at" not in members
    assert "reflection" in members
    assert "adjudicate" not in {
        member["lemma"]
        for member in family_by_head(document, "judge")["members"]
    }
