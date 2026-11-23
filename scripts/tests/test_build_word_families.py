"""``scripts/build_word_families.py`` 的隔离单测（固定小样本，不下载 WordNet）。

覆盖 specs/041 的规则 E 生成逻辑 + P1-11 的 AI 审计变更 + P1-12 成员补全：

- 人工清单形状：17 条黑名单 / 22 条 allowlist、类别/分组合法、无重复/重叠；
- 清单漂移：黑名单边不存在、allowlist 边已存在、allowlist 两侧不在 10k → 报错；
- 构图：≥2 成员且 ≥1 个 10k 成员才成族；10k 外成员保留且 level/rank=null；
  无族词（the/at）不写入；head = 10k 内 rank 最小者，id 按 head rank 升序；
- 黑名单删边会拆族/踢出成员；allowlist 补边会把单例并入族；
- P1-11 审计变更：13 条 trim（24 个成员）/ 10 条 split（11 条桥边）/ 中低 11 条
  保留；族 id/head/成员/边逐条校验存在性，数据漂移报错；
- P1-12 成员字段：lexicon 优先不覆盖、缺项回退 ECDICT（逐字段）、两边都缺留
  空串；ECDICT 只读批量查询/归一化/不可用报错；provider 只收缺失词；
- P1-13 成员词性：pos = WordNet synset POS 集合（n/v/a/s/r 规范顺序、去重、无则
  []）；非法 POS 字符报错；pos_provider 收全部成员词、与 pos 互斥；已提交数据
  每个成员都带合法 pos；
- 文档溯源：source/license/ruleVersion/blacklist/allowlist + integrity + ECDICT；
- 输出确定性（无时间戳，两次 dump 字节一致）；
- 已提交数据与规则 E + 23 条变更后的验收数字一致、integrity 可复算、
  成员字段符合「lexicon 优先 → ECDICT 补缺」。

所有用例只喂假数据；读仓库文件的只有「已提交数据」契约测试。
"""

from __future__ import annotations

import json
import sqlite3
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
LEXICON_PATH = REPO_ROOT / "content/wordlists/lexicon.v1.json"
ECDICT_PATH = REPO_ROOT / "data/ecdict.db"

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

# P1-11 审计变更的隔离样本：trim 删整点、split 只删桥边。
TRIM_RECORDS = (
    ("digit", "digital", "digit.n.01", "n"),
    ("digit", "digitalize", "digit.n.01", "n"),
    ("digitalis", "digitalize", "digitalis.n.01", "n"),
)
TRIM_RANKS = {"digit": 100, "digital": 300, "digitalize": 500}
TRIM_ENTRY = ({
    "family": "F0001", "head": "digit", "members": ("digitalis",),
    "reason": "测试用 trim",
},)

SPLIT_RECORDS = (
    ("drive", "driver", "drive.v.01", "v"),
    ("drive", "drift", "drive.v.02", "v"),
    ("drift", "drifter", "drift.v.01", "v"),
)
SPLIT_RANKS = {"drive": 100, "driver": 200, "drift": 300, "drifter": 400}
SPLIT_ENTRY = ({
    "family": "F0001", "head": "drive", "a": "drive", "b": "drift",
    "reason": "测试用 split",
},)


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
                   allowlist=ALLOWLIST, trim_members=(), split_edges=(),
                   held_items=(), lexicon=None, lexicon_source=None,
                   ecdict=None, ecdict_source=None, ecdict_provider=None,
                   pos=None, pos_source=None, pos_provider=None) -> dict:
    return build.build_family_document(
        make_index(records),
        make_cefr(ranks),
        blacklist=blacklist,
        allowlist=allowlist,
        trim_members=trim_members,
        split_edges=split_edges,
        held_items=held_items,
        provider_version="3.0",
        frequency_path=DATA_PATH,
        frequency_version="test",
        lexicon=lexicon,
        lexicon_source=lexicon_source,
        ecdict=ecdict,
        ecdict_source=ecdict_source,
        ecdict_provider=ecdict_provider,
        pos=pos,
        pos_source=pos_source,
        pos_provider=pos_provider,
    )


def family_by_head(document: dict, head: str) -> dict:
    return next(family for family in document["families"] if family["head"] == head)


def _lemmas(document: dict, head: str) -> set:
    return {
        member["lemma"]
        for member in family_by_head(document, head)["members"]
    }


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


def test_ai_audit_lists_shape() -> None:
    """P1-11：13 条 trim（24 成员）+ 11 条 split 桥边（10 条变更）+ 中低 11 条。"""
    assert len(build.TRIM_MEMBERS) == 13
    assert len(build.SPLIT_EDGES) == 11
    assert len(build.HELD_AUDIT_ITEMS) == 11

    trimmed = [word for entry in build.TRIM_MEMBERS for word in entry["members"]]
    assert len(trimmed) == 24
    assert len(set(trimmed)) == 24
    split_findings = {(entry["family"], entry["head"]) for entry in build.SPLIT_EDGES}
    assert len(split_findings) == 10, "10 条 split；large 族由两条桥边串起三簇"
    assert ("F0264", "large") in split_findings
    for entry in (*build.TRIM_MEMBERS, *build.SPLIT_EDGES):
        assert entry["family"].startswith("F")
        assert entry["head"] == entry["head"].strip().lower()
        assert entry["reason"].strip()

    assert {entry["verdict"] for entry in build.HELD_AUDIT_ITEMS} == {"trim", "split"}
    assert sum(
        1 for entry in build.HELD_AUDIT_ITEMS if entry["verdict"] == "trim") == 8
    assert sum(
        1 for entry in build.HELD_AUDIT_ITEMS if entry["verdict"] == "split") == 3
    held_members = [
        word for entry in build.HELD_AUDIT_ITEMS
        for word in (entry.get("members") or ())
    ]
    assert len(held_members) == 10
    # 点名的高置信条目必须在清单里（防止清单被整体替换）。
    assert {entry["head"] for entry in build.TRIM_MEMBERS} >= {
        "digital", "industry", "vital", "vent", "splash", "aggressive", "use",
        "life", "clear", "enter", "page", "angle", "frost",
    }
    assert {entry["head"] for entry in build.SPLIT_EDGES} == {
        "large", "strain", "sour", "curious", "drive", "fly", "vacation",
        "advantage", "bad", "bright",
    }


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
# P1-11 审计变更（trim / split / 中低保留）
# ---------------------------------------------------------------------------

def test_trim_members_removes_vertex_and_all_edges() -> None:
    document = build_document(
        records=TRIM_RECORDS, ranks=TRIM_RANKS, blacklist=(), allowlist=(),
        trim_members=TRIM_ENTRY)
    assert [family["head"] for family in document["families"]] == ["digit"]
    assert [m["lemma"] for m in document["families"][0]["members"]] == [
        "digit", "digital", "digitalize",
    ]
    assert document["counts"]["families"] == 1
    assert document["counts"]["members"] == 3


def test_split_edges_disconnects_family() -> None:
    document = build_document(
        records=SPLIT_RECORDS, ranks=SPLIT_RANKS, blacklist=(), allowlist=(),
        split_edges=SPLIT_ENTRY)
    assert [family["head"] for family in document["families"]] == [
        "drive", "drift",
    ]
    assert [m["lemma"] for m in document["families"][0]["members"]] == [
        "drive", "driver",
    ]
    assert [m["lemma"] for m in document["families"][1]["members"]] == [
        "drift", "drifter",
    ]
    assert document["counts"]["families"] == 2
    assert document["counts"]["members"] == 4


def test_audit_changes_validate_existence() -> None:
    def trim(entry):
        return build_document(
            records=TRIM_RECORDS, ranks=TRIM_RANKS, blacklist=(), allowlist=(),
            trim_members=(entry,))

    with pytest.raises(build.BuildError, match="不在规则 E 族表里"):
        trim({"family": "F9999", "head": "digit",
              "members": ("digitalis",), "reason": "x"})
    with pytest.raises(build.BuildError, match="head 不是"):
        trim({"family": "F0001", "head": "digital",
              "members": ("digitalis",), "reason": "x"})
    with pytest.raises(build.BuildError, match="不在 F0001/digit 族里"):
        trim({"family": "F0001", "head": "digit",
              "members": ("livery",), "reason": "x"})
    with pytest.raises(build.BuildError, match="缺理由"):
        trim({"family": "F0001", "head": "digit", "members": ("digitalis",)})

    with pytest.raises(build.BuildError, match="不在规则 E 图里"):
        build_document(
            records=SPLIT_RECORDS, ranks=SPLIT_RANKS, blacklist=(), allowlist=(),
            split_edges=({"family": "F0001", "head": "drive", "a": "drive",
                          "b": "driverz", "reason": "x"},),
        )

    # 同一对边不能既 allowlist 又 split。
    index = make_index()
    table = audit.build_families(sorted(index.pairs), RANKS, ANCHORS)
    with pytest.raises(build.BuildError, match="allowlist 边"):
        build.resolve_split_edges(
            table, index.pairs,
            ({"family": "F0001", "head": "run", "a": "run", "b": "running",
              "reason": "x"},),
            allowlist_pairs=(("run", "running"),),
        )


def test_held_items_must_stay_in_place() -> None:
    held = ({"family": "F0001", "head": "digit", "members": ("digitalis",)},)
    with pytest.raises(build.BuildError, match="未应用（中/低置信）成员"):
        build_document(
            records=TRIM_RECORDS, ranks=TRIM_RANKS, blacklist=(), allowlist=(),
            trim_members=TRIM_ENTRY, held_items=held,
        )


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
# P1-12 成员字段：lexicon 优先 → ECDICT 补缺 → 空串
# ---------------------------------------------------------------------------

LEXICON = {
    "run": ("run-ph", "run-tr"),
    "runner": ("", "runner-lex-tr"),
    "decide": ("decide-ph", "decide-tr"),
}
ECDICT = {
    "run": ("ec-run-ph", "ec-run-tr"),
    "runner": ("ec-runner-ph", "ec-runner-tr"),
    "running": ("ec-run-ph", "ec-run-tr"),
}


def member_by_lemma(document: dict, lemma: str) -> dict:
    for family in document["families"]:
        for member in family["members"]:
            if member["lemma"] == lemma:
                return member
    raise AssertionError(f"成员不存在：{lemma}")


def _member_lemmas(document: dict) -> list:
    return [
        member["lemma"]
        for family in document["families"]
        for member in family["members"]
    ]


def test_member_fields_lexicon_priority_then_ecdict() -> None:
    document = build_document(
        lexicon=LEXICON, ecdict=ECDICT,
        ecdict_source={"path": "test/ecdict.db", "queried": 3, "found": 3})
    # lexicon 已有值一律保留（即使 ECDICT 同词有不同值）。
    run = member_by_lemma(document, "run")
    assert (run["phonetic"], run["translation"]) == ("run-ph", "run-tr")
    decide = member_by_lemma(document, "decide")
    assert (decide["phonetic"], decide["translation"]) == (
        "decide-ph", "decide-tr")
    # 逐字段回退：接口音标缺 → ECDICT，释义沿用 lexicon。
    runner = member_by_lemma(document, "runner")
    assert runner["phonetic"] == "ec-runner-ph"
    assert runner["translation"] == "runner-lex-tr"
    # 两边只有 ECDICT：两个字段都补。
    running = member_by_lemma(document, "running")
    assert (running["phonetic"], running["translation"]) == (
        "ec-run-ph", "ec-run-tr")
    # 两边都没有：字段仍在、值为空串（不省略、不编造）。
    decision = member_by_lemma(document, "decision")
    assert (decision["phonetic"], decision["translation"]) == ("", "")
    # 补全统计与溯源写进 source.ecdict（不覆盖 lexicon 计数）。
    source = document["source"]["ecdict"]
    assert source["path"] == "test/ecdict.db"
    assert source["queried"] == 3
    assert source["phoneticFills"] == 2  # runner / running
    assert source["translationFills"] == 1  # running
    assert "ECDICT" in document["rules"]["memberFields"]


def test_member_fields_all_empty_strings_without_any_source() -> None:
    document = build_document(lexicon={}, ecdict={})
    for family in document["families"]:
        for member in family["members"]:
            assert set(member) == {
                "lemma", "level", "rank", "phonetic", "translation"}
            assert member["phonetic"] == ""
            assert member["translation"] == ""


def test_ecdict_provider_receives_only_missing_words() -> None:
    seen = []

    def provider(words):
        seen.append(tuple(words))
        return (
            {"runner": ("ec-runner-ph", "ec-runner-tr")},
            {"path": "fake/ecdict.db", "queried": len(words), "found": 1},
        )

    document = build_document(lexicon=LEXICON, ecdict_provider=provider)
    assert len(seen) == 1
    queried = seen[0]
    assert list(queried) == sorted(queried), "查询词必须排序（确定性）"
    assert "run" not in queried  # lexicon 两字段齐全 → 不查
    assert "decide" not in queried
    assert "runner" in queried  # 缺音标
    assert "running" in queried  # 两边都缺
    # provider 返回的只补缺项：runner 现在有音标（释义仍来自 lexicon）。
    runner = member_by_lemma(document, "runner")
    assert runner["phonetic"] == "ec-runner-ph"
    assert runner["translation"] == "runner-lex-tr"
    # provider 没返回的成员保持空串。
    running = member_by_lemma(document, "running")
    assert (running["phonetic"], running["translation"]) == ("", "")
    assert document["source"]["ecdict"]["phoneticFills"] == 1


def test_ecdict_provider_contract_errors() -> None:
    with pytest.raises(build.BuildError, match="只能给一种"):
        build_document(
            lexicon=LEXICON, ecdict=ECDICT,
            ecdict_provider=lambda words: ({}, {}))
    with pytest.raises(build.BuildError, match="映射"):
        build_document(
            lexicon=LEXICON,
            ecdict_provider=lambda words: (None, {}))


def make_ecdict_db(tmp_path: Path, rows) -> Path:
    """造一个最小 ECDICT 库（与真实库同名表/列，便于 loader 复用）。"""
    path = tmp_path / "ecdict.db"
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE stardict (word TEXT PRIMARY KEY, sw INTEGER, "
        "phonetic TEXT, definition TEXT, translation TEXT, exchange TEXT)")
    connection.executemany(
        "INSERT INTO stardict (word, phonetic, translation) VALUES (?, ?, ?)",
        rows,
    )
    connection.commit()
    connection.close()
    return path


def test_load_ecdict_entries_batched_readonly_and_normalized(
        tmp_path: Path) -> None:
    long_translation = "n. " + "很" * 130
    db_path = make_ecdict_db(tmp_path, (
        ("runner", "  'rʌnə  ", "n. 奔跑者\\n[法] 赛跑者"),
        ("running", "", "n. 跑步, 奔跑"),
        ("longword", "'lɔŋ", long_translation),
        ("nocjk", "'x", "english only"),
    ))
    sha_before = build.file_sha256(db_path)
    entries, source = build.load_ecdict_entries(
        ["runner", "running", "longword", "nocjk", "absent"],
        db_path,
        batch_size=2,
    )
    assert set(entries) == {"runner", "running", "longword", "nocjk"}
    assert entries["runner"] == ("'rʌnə", "n. 奔跑者")  # 首个含中文行
    assert entries["running"] == ("", "n. 跑步, 奔跑")  # 音标缺 → 空串
    assert len(entries["longword"][1]) == build.TRANSLATION_LIMIT
    assert entries["longword"][1].endswith("…")
    assert entries["nocjk"][1] == ""  # 无中文行 → 空串
    assert "absent" not in entries
    assert source["queried"] == 5
    assert source["found"] == 4
    assert source["translationLimit"] == build.TRANSLATION_LIMIT
    assert Path(source["path"]).name == "ecdict.db"
    assert source["sha256"] == sha_before
    # 只读打开：库文件字节不变，不产生 journal/wal 旁路文件。
    assert build.file_sha256(db_path) == sha_before
    assert not (tmp_path / "ecdict.db-journal").exists()
    assert not (tmp_path / "ecdict.db-wal").exists()


def test_load_ecdict_entries_skips_empty_query(tmp_path: Path) -> None:
    entries, source = build.load_ecdict_entries(
        [], tmp_path / "missing.db")
    assert entries == {}
    assert source["queried"] == 0
    assert source["found"] == 0
    assert source["sha256"] == ""


def test_load_ecdict_entries_unavailable(tmp_path: Path) -> None:
    with pytest.raises(build.BuildError, match="ECDICT 不可用"):
        build.load_ecdict_entries(["runner"], tmp_path / "missing.db")

    broken = tmp_path / "broken.db"
    broken.write_text("not a sqlite database", encoding="utf-8")
    with pytest.raises(build.BuildError, match="ECDICT 不可用"):
        build.load_ecdict_entries(["runner"], broken)

    wrong_schema = tmp_path / "wrong.db"
    connection = sqlite3.connect(wrong_schema)
    connection.execute("CREATE TABLE other (word TEXT)")
    connection.commit()
    connection.close()
    with pytest.raises(build.BuildError, match="缺列"):
        build.load_ecdict_entries(["runner"], wrong_schema)


def test_document_with_ecdict_is_deterministic() -> None:
    first = build.dump_json(build_document(lexicon=LEXICON, ecdict=ECDICT))
    second = build.dump_json(build_document(lexicon=LEXICON, ecdict=ECDICT))
    assert first == second
    assert len(_member_lemmas(json.loads(first))) == 13


# ---------------------------------------------------------------------------
# P1-13 成员词性 POS：WordNet synset 集合 → 数据里的 pos
# ---------------------------------------------------------------------------

POS_MAP = {
    "run": ("v",),
    "runner": ("n",),
    "decide": ("v",),
    "decision": ("n",),
    "decisive": ("a", "s"),
    "reflect": ("v", "n"),
    "reflection": ("n",),
    "critical": ("a",),
    "crisis": ("n",),
}


def test_member_pos_written_normalized_and_ordered() -> None:
    document = build_document(pos=POS_MAP)
    # 集合去重 + n/v/a/s/r 规范顺序（输入乱序也按此输出）。
    assert member_by_lemma(document, "decisive")["pos"] == ["a", "s"]
    assert member_by_lemma(document, "reflect")["pos"] == ["n", "v"]
    # 映射里没有的成员（假图里的 running）写空数组，而不是编造。
    assert member_by_lemma(document, "running")["pos"] == []
    # pos 与成员字段共存：纯图结构（不传 pos）时不写 pos 键。
    assert "pos" not in member_by_lemma(build_document(), "run")


def test_member_pos_rejects_unknown_codes() -> None:
    with pytest.raises(build.BuildError, match="未知 POS 字符"):
        build_document(pos={"run": ("v", "x")})
    with pytest.raises(build.BuildError, match="pos 必须是 POS 字符序列"):
        build_document(pos={"run": "v"})


def test_document_with_pos_counts_and_source() -> None:
    document = build_document(
        pos=POS_MAP,
        pos_source={"version": "3.0", "posOrder": "n/v/a/s/r",
                    "queried": 9, "withPos": 9},
    )
    members = [
        member for family in document["families"]
        for member in family["members"]
    ]
    with_pos = sum(1 for member in members if member["pos"])
    # 假图里能对上 POS_MAP 的成员：run/runner/decide/decision/decisive/
    # reflect/critical/crisis（reflection 不在假图里）。
    assert with_pos == 8
    assert document["counts"]["membersWithPos"] == with_pos
    assert document["counts"]["membersWithoutPos"] == len(members) - with_pos
    assert document["source"]["pos"]["version"] == "3.0"
    assert document["source"]["pos"]["membersWithoutPos"] == (
        len(members) - with_pos)
    assert document["rules"]["memberPos"].startswith("成员 pos")
    # 不传 pos 时不写 counts/source（纯图结构测试保持旧形状）。
    plain = build_document()
    assert "membersWithPos" not in plain["counts"]
    assert "pos" not in plain["source"]


def test_pos_provider_gets_all_member_words_and_is_exclusive() -> None:
    seen: list = []

    def provider(words):
        seen.append(tuple(words))
        return {word: ("v",) for word in words}, {"version": "3.0"}

    document = build_document(pos_provider=provider)
    assert len(seen) == 1
    assert set(seen[0]) == set(_member_lemmas(document))
    assert all(
        member["pos"] == ["v"]
        for family in document["families"]
        for member in family["members"]
    )
    with pytest.raises(build.BuildError, match="只能给一种"):
        build_document(pos=POS_MAP, pos_provider=provider)


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

    # P1-11：13 条 trim 的 24 个成员必须全部消失（含边），中/低 11 条仍在。
    trimmed = {word for entry in build.TRIM_MEMBERS for word in entry["members"]}
    assert len(trimmed) == 24
    assert not (trimmed & members)
    for entry in build.HELD_AUDIT_ITEMS:
        for member in entry.get("members") or ():
            assert member in _lemmas(document, entry["head"]), (
                f"未应用条目 {entry['head']} 丢了成员 {member}")

    # 每条 split 桥边两端必须已不在同一族（按成员 → head 反查）。
    head_of = {
        member["lemma"]: family["head"]
        for family in document["families"]
        for member in family["members"]
    }
    for entry in build.SPLIT_EDGES:
        left, right = entry["a"], entry["b"]
        # 桥边另一端所在子组可能因无 10k 锚点整体消失；只要没「仍同族」即可。
        assert not (
            left in head_of and right in head_of
            and head_of[left] == head_of[right]
        ), f"{left}/{right} 仍在同一族"

    # 拆出来的组：large 2 / extend 9 / comprehensive 7；不再互相粘连。
    assert _lemmas(document, "large") == {"large", "largeness"}
    assert {"extend", "extension", "extensive", "extent"} <= _lemmas(
        document, "extend")
    assert "large" not in _lemmas(document, "extend")
    assert {"comprehend", "comprehensive", "comprehension"} <= _lemmas(
        document, "comprehensive")
    assert not ({"large", "extend"} & _lemmas(document, "comprehensive"))
    # 其余 split：拆后子组（无 10k 锚点的组整体消失）。
    assert _lemmas(document, "strain") == {"strain", "strainer", "straining"}
    assert "strenuous" not in members
    assert _lemmas(document, "sour") == {"sour", "souring", "sourness"}
    assert "tart" not in members
    assert "inquisitiveness" not in _lemmas(document, "curious")
    assert "inquisitiveness" in _lemmas(document, "inquiry")
    assert _lemmas(document, "drive") == {"drive", "driver", "driving"}
    assert _lemmas(document, "drift") == {"drift", "driftage", "drifter", "drifting"}
    assert "flight" in _lemmas(document, "fly")
    assert _lemmas(document, "flee") == {"flee", "fleer"}
    assert _lemmas(document, "vacation") == {
        "vacation", "vacationer", "vacationing", "vacationist"}
    assert _lemmas(document, "vacancy") == {"vacancy", "vacant", "vacate"}
    assert _lemmas(document, "advantage") == {
        "advantage", "advantageous", "advantageousness"}
    assert _lemmas(document, "profitable") == {
        "profitable", "profitability", "profitableness"}
    assert _lemmas(document, "bad") == {"bad", "badness"}
    assert _lemmas(document, "severe") == {"severe", "severity", "severeness"}
    assert _lemmas(document, "bright") == {"bright", "brightness"}
    assert "luminousness" not in members
    # 最大族从 large（18）变成 sense（14）。
    assert max(len(family["members"]) for family in document["families"]) == 14
    assert len(family_by_head(document, "sense")["members"]) == 14

    # P1-13 成员词性：每个成员都带 pos，按 n/v/a/s/r 去重排序；覆盖数字一致。
    pos_order = build.POS_ORDER
    with_pos = 0
    for family in document["families"]:
        for member in family["members"]:
            raw = member["pos"]
            assert isinstance(raw, list), member["lemma"]
            assert all(code in pos_order for code in raw), member["lemma"]
            assert raw == [code for code in pos_order if code in set(raw)]
            with_pos += 1 if raw else 0
    assert document["counts"]["membersWithPos"] == with_pos == 11534
    assert document["counts"]["membersWithoutPos"] == 0
    # 指定族的词性（前端分组/徽章口径的锚点）。
    decide_pos = {
        member["lemma"]: member["pos"]
        for member in family_by_head(document, "decide")["members"]
    }
    assert decide_pos == {
        "decide": ["v"], "decision": ["n"], "decisive": ["a", "s"],
        "deciding": ["n", "v", "s"], "decisiveness": ["n"],
    }
    assert family_by_head(document, "large")["members"][0]["pos"] == [
        "n", "a", "s", "r"]


def test_committed_member_fields_preserve_lexicon_values() -> None:
    """已提交数据里，成员在 lexicon 非空的值必须逐条保留（ECDICT 不得覆盖）。"""
    document = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    phonetics, translations, _source = build.load_lexicon_entries(LEXICON_PATH)
    for family in document["families"]:
        for member in family["members"]:
            lemma = member["lemma"]
            if phonetics.get(lemma):
                assert member["phonetic"] == phonetics[lemma], lemma
            if translations.get(lemma):
                assert member["translation"] == translations[lemma], lemma


@pytest.mark.skipif(
    not ECDICT_PATH.is_file(), reason="本机无 data/ecdict.db，跳过 ECDICT 补全契约")
def test_committed_member_fields_fill_from_ecdict() -> None:
    """lexicon 缺项用 ECDICT 补、两边都缺留空串；溯源 sha 与本地库一致。"""
    document = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    members = [
        member for family in document["families"]
        for member in family["members"]
    ]
    phonetics, translations, _source = build.load_lexicon_entries(LEXICON_PATH)
    missing = [
        member["lemma"] for member in members
        if not phonetics.get(member["lemma"])
        or not translations.get(member["lemma"])
    ]
    ecdict, ecdict_source = build.load_ecdict_entries(missing, ECDICT_PATH)
    for member in members:
        lemma = member["lemma"]
        expected_phonetic = (
            phonetics.get(lemma) or ecdict.get(lemma, ("", ""))[0])
        expected_translation = (
            translations.get(lemma) or ecdict.get(lemma, ("", ""))[1])
        assert member["phonetic"] == expected_phonetic, lemma
        assert member["translation"] == expected_translation, lemma
    # 溯源：committed 数据的 ECDICT 快照必须就是本机这一份库。
    assert document["source"]["ecdict"]["sha256"] == ecdict_source["sha256"]
    assert document["source"]["ecdict"]["queried"] == len(missing)
    # P1-12 覆盖率（regenerate 时如变化，连同报告/spec 一起更新）。
    with_phonetic = sum(1 for member in members if member["phonetic"])
    with_translation = sum(1 for member in members if member["translation"])
    assert len(members) == 11534
    assert with_phonetic == 10466
    assert with_translation == 11419
    assert sum(
        1 for member in members
        if not member["phonetic"] and not member["translation"]) == 109


def test_check_output_detects_missing_and_drift(tmp_path: Path) -> None:
    """`--check` 语义：同一生成结果幂等通过；缺文件/差一字节即失败。"""
    text = build.dump_json(build_document(lexicon=LEXICON, ecdict=ECDICT))
    target = tmp_path / "word-families.json"
    assert "不存在" in build.check_output_error(target, text)

    target.write_text(text, encoding="utf-8")
    assert build.check_output_error(target, text) is None
    # 再跑一次「现场生成」仍逐字节一致（确定性 → --check 幂等）。
    again = build.dump_json(build_document(lexicon=LEXICON, ecdict=ECDICT))
    assert build.check_output_error(target, again) is None

    target.write_text(text + " ", encoding="utf-8")
    assert "不一致" in build.check_output_error(target, text)
