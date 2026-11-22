#!/usr/bin/env python3
"""生成只读词族静态数据 ``content/wordlist/word-families.v1.json``（specs/041）。

规则 E（审计定稿，见 ``docs/reports/word-family-open-audit-2026-11-23.md`` §5）::

    E = 全量 WordNet 3.0 派生图 + allowlist − 黑名单

- 图：WordNet 3.0 ``derivationally_related_forms()`` 无向边，**全量单字 lemma**
  （不限制 CEFR 10k）；自指 / 多词 lemma 丢弃，同一对去重。
- 族：连通分量 **≥2 成员** 且 **至少 1 个成员在 CEFR 10k**；10k 外成员保留、
  ``level/rank`` 为 ``null``（等级留空）。无族词（the/at 等）**不写入**数据。
- head：族内 CEFR rank 最小者；family id 按 head rank 升序 ``F0001…``。
- 人工清单：17 条黑名单坏边（从图中删除）+ 22 条 allowlist 缺失边（加入图中）。
  两份清单**写死在本脚本**，逐条校验存在性（黑名单必须存在于 WordNet 图、
  allowlist 必须不存在于图），数据漂移直接报错，防止清单与真实图脱节。

成员释义（P1-07）：每个成员从 ``content/wordlists/lexicon.v1.json`` 补
``phonetic`` / ``translation``（head 的释义仍由后端按同一词典在运行期补充；
成员字段写进静态数据，展开成员表不再需要额外请求）。词典缺该词时两者为 ``""``，
不编造。

确定性：同一 WordNet 语料 + 同一频表 + 同一释义索引 → 逐字节一致的 JSON
（无时间戳/耗时）。运行期不依赖 nltk/WordNet：应用只读生成的 JSON。

用法::

    python3 scripts/build_word_families.py --wordnet-dir /tmp/nltk_data
    python3 scripts/build_word_families.py --wordnet-dir /tmp/nltk_data --check
    python3 scripts/build_word_families.py --out /tmp/word-families.json --no-write

退出码：0 正常；2 WordNet 依赖/语料不可用；3 人工清单漂移 / 数据契约不符；
4 输入文件在运行期间被改动。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import word_family_open_audit as audit  # noqa: E402  （同目录只读审计脚本）

SCHEMA = "linguatrek.word-family.v1"
VERSION = "2026.11.23"
RULE_VERSION = "E"

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FREQUENCY = REPO_ROOT / "content/wordlist/frequency_bands.v1.json"
DEFAULT_LEXICON = REPO_ROOT / "content/wordlists/lexicon.v1.json"
DEFAULT_OUT = REPO_ROOT / "content/wordlist/word-families.v1.json"
DEFAULT_WORDNET_DIR = Path("/tmp/nltk_data")
SCHEMA_LEXICON = "linguatrek.lexicon.v1"

LICENSE = "WordNet 3.0 License (Princeton University, 2006)"
LICENSE_URL = "https://wordnet.princeton.edu/"
SOURCE_DRIVEN = "WordNet 3.0"

# 规则 E 的验收数字（specs/041 §1/§4；来自 P1-04 审计 §5 的 E 行）。
# 若词表或 WordNet 语料变更导致数字变化，必须先更新审计报告与 spec，再改这里。
EXPECTED_COUNTS: Mapping[str, object] = {
    "families": 3696,
    "members": 11567,
    "cefrMembers": 5233,
    "outsideMembers": 6334,
    "maxFamilySize": 18,
    "cefrWithoutFamily": 4767,
    "cefrCoveragePct": 52.33,
    "blacklistEdges": 17,
    "allowlistEdges": 22,
}

# CEFR 等级展示顺序（与频表锚点一致；数据里 levels 按此排序）。
LEVEL_ORDER: Tuple[str, ...] = ("A1", "A2", "B1", "B2", "C1")


class BuildError(RuntimeError):
    """生成前置条件/数据契约不满足。"""


# ---------------------------------------------------------------------------
# 人工审阅清单（写死；与 P1-04 审计报告 §4.2 / ALLOWLIST 逐条一致）
# ---------------------------------------------------------------------------

# 17 条黑名单坏边：semantic_split 13 + clear_error 4；pos_conversion 是良性、
# 不删（审计报告 §4.4）。每条都必须存在于 WordNet 全量图，否则脚本报错。
BLACKLIST: Tuple[Mapping[str, str], ...] = (
    # ---- 语义已分化（10 条，P1-03 已在 10k 图内确认） ----
    {"a": "critical", "b": "crisis", "category": "semantic_split", "group": "inherited",
     "reason": "批评的/关键的 vs 危机；链接走 critical.s.05「处于危机边缘」"},
    {"a": "elect", "b": "eligible", "category": "semantic_split", "group": "inherited",
     "reason": "选举 vs 有资格的；elect.v.01 ↔ eligible.a.01"},
    {"a": "contain", "b": "continent", "category": "semantic_split", "group": "inherited",
     "reason": "包含 vs 大陆；走 hold.v.11「能控制排泄」冷僻义"},
    {"a": "contain", "b": "content", "category": "semantic_split", "group": "inherited",
     "reason": "包含 vs 内容/满足；hold.v.11 ↔ capacity.n.03"},
    {"a": "receive", "b": "receptor", "category": "semantic_split", "group": "inherited",
     "reason": "收到 vs 受体（专业术语）；pick_up.v.09 ↔ sense_organ.n.01"},
    {"a": "commit", "b": "committee", "category": "semantic_split", "group": "inherited",
     "reason": "委托/犯罪 vs 委员会；entrust.v.01 ↔ committee.n.01"},
    {"a": "major", "b": "majority", "category": "semantic_split", "group": "inherited",
     "reason": "主要的/主修 vs 多数；同 POS 也挡不住"},
    {"a": "signify", "b": "significant", "category": "semantic_split", "group": "inherited",
     "reason": "表示 vs 重要的；signify.v.02 ↔ meaning.s.01"},
    {"a": "grave", "b": "gravity", "category": "semantic_split", "group": "inherited",
     "reason": "坟墓 vs 重力；走 grave.s.01「严肃」义项"},
    {"a": "calculate", "b": "calculus", "category": "semantic_split", "group": "inherited",
     "reason": "计算 vs 微积分/结石；calculate.v.01 ↔ calculus.n.03"},
    # ---- 明显错误（3 条，P1-03 已确认） ----
    {"a": "tow", "b": "tower", "category": "clear_error", "group": "inherited",
     "reason": "拖 vs 塔；tower → tow 走 tugboat.n.01（拖船）"},
    {"a": "tie", "b": "tier", "category": "clear_error", "group": "inherited",
     "reason": "WordNet 用 tier「打平的人/系东西的人」冷僻义"},
    {"a": "grade", "b": "gradual", "category": "clear_error", "group": "inherited",
     "reason": "走「坡度 → 不陡的」，现代英语无派生关系"},
    # ---- 放开 10k 边界后才出现的坏边 ----
    {"a": "judge", "b": "adjudicate", "category": "clear_error", "group": "opened",
     "reason": "现代英语非派生；judge.n.01 → adjudicate，P1-03 被 10k 边界挡住"},
    # ---- 本次开放图人工审阅新发现 ----
    {"a": "tend", "b": "tender", "category": "semantic_split", "group": "new",
     "reason": "倾向/照料 vs 温柔的/投标；走 tender.n.03「看护者」与 attendant.n.01"},
    {"a": "industry", "b": "industrious", "category": "semantic_split", "group": "new",
     "reason": "工业/行业 vs 勤奋的；走 industry.n.02「勤勉」义项"},
    {"a": "stand", "b": "standard", "category": "semantic_split", "group": "new",
     "reason": "站立 vs 标准；走 standard.n.05「支柱/旗杆」冷僻义"},
)

# 22 条 allowlist：WordNet 3.0 缺失/不对称、但形态与语义都明确的边。
# 每条都必须「两侧 ∈ CEFR 10k」且「WordNet 图里不存在」，否则脚本报错。
ALLOWLIST: Tuple[Mapping[str, str], ...] = (
    {"a": "reflect", "b": "reflection", "reason": "同源 -tion 派生；WordNet 3.0 缺指针"},
    {"a": "strong", "b": "strength", "reason": "不规则名词化 -ngth"},
    {"a": "high", "b": "height", "reason": "不规则名词化 -ght"},
    {"a": "wide", "b": "width", "reason": "不规则名词化 -th"},
    {"a": "deep", "b": "depth", "reason": "不规则名词化 -th"},
    {"a": "warm", "b": "warmth", "reason": "不规则名词化 -th"},
    {"a": "true", "b": "truth", "reason": "不规则名词化 -th"},
    {"a": "young", "b": "youth", "reason": "不规则名词化"},
    {"a": "long", "b": "length", "reason": "不规则名词化"},
    {"a": "live", "b": "life", "reason": "不规则名词化（元音变化）"},
    {"a": "lose", "b": "loss", "reason": "不规则名词化（元音变化）"},
    {"a": "choose", "b": "choice", "reason": "不规则名词化（元音变化）"},
    {"a": "sell", "b": "sale", "reason": "不规则名词化"},
    {"a": "advise", "b": "advice", "reason": "不规则名词化 -ce"},
    {"a": "breathe", "b": "breath", "reason": "不规则名词化"},
    {"a": "heal", "b": "health", "reason": "不规则名词化 -th"},
    {"a": "weigh", "b": "weight", "reason": "不规则名词化 -ght"},
    {"a": "fly", "b": "flight", "reason": "不规则名词化 -ght"},
    {"a": "free", "b": "freedom", "reason": "-dom 派生"},
    {"a": "wise", "b": "wisdom", "reason": "-dom 派生"},
    {"a": "hate", "b": "hatred", "reason": "-red 派生"},
    {"a": "difficult", "b": "difficulty", "reason": "-ty 派生"},
)


# ---------------------------------------------------------------------------
# 构建（纯函数；单测不依赖 WordNet）
# ---------------------------------------------------------------------------

def _require(condition: bool, message: str) -> None:
    if not condition:
        raise BuildError(message)


def validate_manual_lists(
    edge_pairs: Iterable[Tuple[str, str]],
    blacklist: Sequence[Mapping[str, str]] = BLACKLIST,
    allowlist: Sequence[Mapping[str, str]] = ALLOWLIST,
) -> Tuple[Tuple[Tuple[str, str], ...], Tuple[Tuple[str, str], ...]]:
    """逐条校验人工清单：黑名单必须存在于图、allowlist 必须不存在，且不重复/不重叠。"""
    existing = set(edge_pairs)
    black = audit.validate_edge_list(blacklist, existing, label="BLACKLIST")
    allow = audit.validate_edge_list(
        allowlist, existing, label="ALLOWLIST", must_exist=False)
    _require(len(black) == len(set(black)), "BLACKLIST 有重复边")
    _require(len(allow) == len(set(allow)), "ALLOWLIST 有重复边")
    _require(not (set(black) & set(allow)), "同一对边不能同时在黑名单与 allowlist")
    return black, allow


def load_lexicon_entries(path: str | Path) -> Tuple[Dict[str, str], Dict[str, str], Dict[str, object]]:
    """读取释义索引，返回 ``(phonetics, translations, source)``。

    只校验生成所需的最小契约（schema/entries 形状）；完整性哈希由运行期
    ``backend/vocabulary.py`` 复核，这里不重复实现。键必须是词典里的小写词。
    """
    lexicon_path = Path(path)
    try:
        document = json.loads(lexicon_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BuildError(f"释义索引读取失败：{exc}") from exc
    _require(isinstance(document, dict), "释义索引必须是 JSON 对象")
    _require(
        document.get("schema") == SCHEMA_LEXICON,
        f"释义索引 schema 不是 {SCHEMA_LEXICON}",
    )
    raw_entries = document.get("entries")
    _require(
        isinstance(raw_entries, dict) and bool(raw_entries),
        "释义索引 entries 必须是非空对象",
    )
    phonetics: Dict[str, str] = {}
    translations: Dict[str, str] = {}
    for word, value in raw_entries.items():
        _require(
            isinstance(word, str) and word == word.lower(),
            f"释义索引键必须是小写词：{word!r}",
        )
        _require(
            isinstance(value, list) and len(value) == 2
            and isinstance(value[0], str) and isinstance(value[1], str),
            f"释义索引 entries[{word}] 必须是 [phonetic, translation]",
        )
        phonetics[word] = value[0]
        translations[word] = value[1]
    source: Dict[str, object] = {
        "path": _repo_relative(lexicon_path),
        "version": str(document.get("version") or ""),
        "sha256": hashlib.sha256(lexicon_path.read_bytes()).hexdigest(),
        "entries": len(phonetics),
    }
    return phonetics, translations, source


def _lexicon_fields(
    lemma: str,
    lexicon: Optional[Mapping[str, Tuple[str, str]]],
) -> Dict[str, str]:
    """一个成员的 ``phonetic`` / ``translation``；词典缺失时留空串。"""
    if lexicon is None:
        return {}
    phonetic, translation = lexicon.get(lemma, ("", ""))
    return {"phonetic": str(phonetic), "translation": str(translation)}


def build_family_document(
    index: audit.EdgeIndex,
    cefr: audit.CefrInput,
    *,
    blacklist: Sequence[Mapping[str, str]] = BLACKLIST,
    allowlist: Sequence[Mapping[str, str]] = ALLOWLIST,
    provider_version: str = SOURCE_DRIVEN,
    frequency_path: str | Path = DEFAULT_FREQUENCY,
    frequency_version: str = "",
    lexicon: Optional[Mapping[str, Tuple[str, str]]] = None,
    lexicon_source: Optional[Mapping[str, object]] = None,
) -> Dict[str, object]:
    """按规则 E 建词族文档（不写盘、不读 WordNet）。

    ``lexicon``（``lemma -> (phonetic, translation)``）非空时给每个成员补
    ``phonetic`` / ``translation``；``None`` 保留纯图结构（隔离单测用），
    CLI 总会传入。
    """
    black_pairs, allow_pairs = validate_manual_lists(index.pairs, blacklist, allowlist)
    # allowlist 的规则前提：两侧都在 CEFR 10k（否则是产品口径变化，先复核审计）。
    for left, right in allow_pairs:
        _require(
            left in cefr.ranks and right in cefr.ranks,
            f"ALLOWLIST 边不满足「两侧都在 10k」：{left}/{right}",
        )
    black_set = set(black_pairs)
    final_pairs = (set(index.pairs) | set(allow_pairs)) - black_set
    _require(
        not (final_pairs & black_set),
        "黑名单边仍在最终边集里（不应发生）",
    )

    table = audit.build_families(sorted(final_pairs), cefr.ranks, cefr.anchors)
    coverage = audit.coverage_for(sorted(final_pairs), cefr.ranks, cefr.anchors)
    level_order = tuple(level for _cap, level in sorted(cefr.anchors))
    rank_of_level = {level: rank for rank, level in enumerate(level_order)}

    families: List[Mapping[str, object]] = []
    for family in table.families:
        members = [
            {
                "lemma": member.word,
                "level": member.level,
                "rank": member.rank,
                **_lexicon_fields(member.word, lexicon),
            }
            for member in family.members
        ]
        levels = sorted(
            {member.level for member in family.members if member.level},
            key=lambda level: rank_of_level.get(str(level), len(rank_of_level)),
        )
        families.append({
            "id": family.id,
            "head": family.head,
            "headRank": family.head_rank,
            "headLevel": family.head_level,
            "levels": levels,
            "members": members,
        })

    # 数据契约（与 specs/041 §2 响应形状一致；后端加载时再校验一遍）。
    for family in families:
        members = family["members"]
        _require(len(members) >= 2, f"{family['id']} 成员数 <2")
        _require(
            any(member["level"] is not None for member in members),
            f"{family['id']} 没有 10k 成员（不应成为族）",
        )
        _require(
            family["head"] == members[0]["lemma"]
            and family["headRank"] == members[0]["rank"]
            and family["headLevel"] == members[0]["level"],
            f"{family['id']} head 不是 members[0]",
        )
        _require(bool(family["levels"]), f"{family['id']} 缺等级集合")
        if lexicon is not None:
            _require(
                all(
                    isinstance(member.get("phonetic"), str)
                    and isinstance(member.get("translation"), str)
                    for member in members
                ),
                f"{family['id']} 成员缺 phonetic/translation 字段",
            )

    # allowlist 效果：加入的边两端必须落在同一族；黑名单按规则 E 只保证「边不在
    # 最终图里」（审计的「坏边 0」口径就是边计数，不保证两端不被其它合法边连起来）。
    allow_missing = [
        f"{left}/{right}" for left, right in allow_pairs
        if table.mapping.get(left) is None
        or table.mapping.get(right) is None
        or table.mapping[left].family != table.mapping[right].family
    ]
    _require(not allow_missing, f"allowlist 边两端未同族：{', '.join(allow_missing)}")
    _require("the" not in table.mapping, "the 不应出现在任何族（无族词不写入）")
    _require("at" not in table.mapping, "at 不应出现在任何族（无族词不写入）")

    counts: Dict[str, object] = {
        "families": coverage.families,
        "members": coverage.members,
        "cefrMembers": coverage.cefr_members,
        "outsideMembers": coverage.outside_members,
        "maxFamilySize": coverage.max_size,
        "cefrWithoutFamily": coverage.cefr_without_family,
        "cefrCoveragePct": coverage.cefr_coverage_pct,
        "blacklistEdges": len(black_pairs),
        "allowlistEdges": len(allow_pairs),
    }
    size_distribution = {
        str(size): count for size, count in sorted(Counter(
            len(family["members"]) for family in families).items())
    }
    payload: Dict[str, object] = {
        "counts": counts,
        "families": families,
        "blacklist": [
            {"a": left, "b": right, "category": entry["category"],
             "group": entry["group"], "reason": entry["reason"]}
            for entry, (left, right) in zip(blacklist, black_pairs)
        ],
        "allowlist": [
            {"a": left, "b": right, "reason": entry["reason"]}
            for entry, (left, right) in zip(allowlist, allow_pairs)
        ],
    }
    document: Dict[str, object] = {
        "schema": SCHEMA,
        "version": VERSION,
        "ruleVersion": RULE_VERSION,
        "generatedBy": "scripts/build_word_families.py",
        "license": LICENSE,
        "licenseUrl": LICENSE_URL,
        "source": {
            "wordnet": {
                "version": provider_version,
                "derivation": "derivationally_related_forms()，无向边，全量单字 lemma",
                "license": "WordNet 3.0 License (Princeton University, 2006)",
                "url": LICENSE_URL,
            },
            "frequencyBands": {
                "path": _repo_relative(frequency_path),
                "version": frequency_version,
                "sha256": cefr.sha256,
                "lemmas": len(cefr.ranks),
            },
            **({"lexicon": dict(lexicon_source)} if lexicon_source else {}),
        },
        "rules": {
            "graph": "WordNet 3.0 派生图：全部单字 lemma，无向边；自指/多词丢弃，同对去重",
            "family": "连通分量 ≥2 成员，且 ≥1 成员 ∈ CEFR 10k",
            "crossBoundary": "族内保留 10k 外成员，level/rank 为 null（等级留空）",
            "noFamily": "无族词（the/at 等）不写入数据；不写单例/无锚定分量",
            "head": "族内 CEFR rank 最小者；family id 按 head rank 升序 F0001…",
            "blacklist": "17 条人工确认坏边从图中删除（semantic_split + clear_error）",
            "allowlist": "22 条 WordNet 缺失/不对称的人工边加入图中（两侧都在 10k）",
            "memberFields": "成员 phonetic/translation 来自 lexicon.v1.json；缺条目为空串，不编造",
        },
        "counts": counts,
        "sizeDistribution": size_distribution,
        "blacklist": payload["blacklist"],
        "allowlist": payload["allowlist"],
        "families": families,
    }
    document["integrity"] = {
        "algorithm": "sha256",
        "scope": "counts+families+blacklist+allowlist",
        "sha256": integrity_sha256(payload),
    }
    return document


def canonical_payload(document: Mapping[str, object]) -> Dict[str, object]:
    """完整性哈希覆盖的字段（与 backend/word_family.py 保持一致）。"""
    return {
        "counts": document["counts"],
        "families": document["families"],
        "blacklist": document["blacklist"],
        "allowlist": document["allowlist"],
    }


def integrity_sha256(payload: Mapping[str, object]) -> str:
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def assert_expected_counts(document: Mapping[str, object]) -> None:
    """验收数字必须与审计规则 E 一致；不一致即失败（不静默改数据）。"""
    counts = document["counts"]
    problems = [
        f"{key}: 期望 {expected}，实际 {counts.get(key)}"
        for key, expected in EXPECTED_COUNTS.items()
        if counts.get(key) != expected
    ]
    _require(not problems, "规则 E 验收数字不符：" + "；".join(problems))


def dump_json(document: Mapping[str, object]) -> str:
    """确定性序列化：无时间戳、紧凑分隔符 + 结尾换行。"""
    return json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n"


def _repo_relative(path: str | Path) -> str:
    resolved = Path(path)
    try:
        return str(resolved.resolve().relative_to(REPO_ROOT))
    except (ValueError, OSError):
        return str(path)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="生成只读词族静态数据（specs/041，规则 E）",
    )
    parser.add_argument("--frequency", default=str(DEFAULT_FREQUENCY),
                        help="CEFR 频表（默认 content/wordlist/frequency_bands.v1.json）")
    parser.add_argument("--lexicon", default=str(DEFAULT_LEXICON),
                        help="释义索引（默认 content/wordlists/lexicon.v1.json）")
    parser.add_argument("--wordnet-dir", default=str(DEFAULT_WORDNET_DIR),
                        help="NLTK 数据目录（默认 /tmp/nltk_data）")
    parser.add_argument("--out", default=str(DEFAULT_OUT),
                        help="输出 JSON（默认 content/wordlist/word-families.v1.json）")
    parser.add_argument("--check", action="store_true",
                        help="只校验已提交数据与现场生成是否逐字节一致（不写盘）")
    parser.add_argument("--no-write", action="store_true",
                        help="只打印摘要，不写盘")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    frequency_path = Path(args.frequency)
    lexicon_path = Path(args.lexicon)
    out_path = Path(args.out)

    try:
        frequency_document = json.loads(frequency_path.read_text(encoding="utf-8"))
        cefr = audit.load_cefr(frequency_path)
        frequency_version = str(frequency_document.get("version") or "")
        sha_before = audit.file_sha256(frequency_path)
        lexicon_sha_before = audit.file_sha256(lexicon_path)
        phonetics, translations, lexicon_source = load_lexicon_entries(lexicon_path)
        lexicon = {word: (phonetics[word], translations[word]) for word in phonetics}
        provider = audit.WordNetProvider(args.wordnet_dir)
        records = list(provider.derivation_pointers())
        index = audit.build_edge_index(records)
        document = build_family_document(
            index,
            cefr,
            provider_version=str(provider.version),
            frequency_path=frequency_path,
            frequency_version=frequency_version,
            lexicon=lexicon,
            lexicon_source=lexicon_source,
        )
        assert_expected_counts(document)
    except audit.WordNetUnavailable as exc:
        print(f"[word-families] WordNet 不可用：{exc}", file=sys.stderr)
        return 2
    except (audit.AuditError, BuildError) as exc:
        print(f"[word-families] 生成失败：{exc}", file=sys.stderr)
        return 3

    if audit.file_sha256(frequency_path) != sha_before:
        print("[word-families] 频表在运行期间被改动，拒绝写数据", file=sys.stderr)
        return 4
    if audit.file_sha256(lexicon_path) != lexicon_sha_before:
        print("[word-families] 释义索引在运行期间被改动，拒绝写数据", file=sys.stderr)
        return 4

    text = dump_json(document)
    counts = document["counts"]
    members = [member for family in document["families"] for member in family["members"]]
    with_phonetic = sum(1 for member in members if member["phonetic"])
    with_translation = sum(1 for member in members if member["translation"])
    print(f"schema            : {SCHEMA}")
    print(f"WordNet           : {document['source']['wordnet']['version']}")
    print(f"频表              : {document['source']['frequencyBands']['path']}"
          f"（{cefr.sha256[:12]}…）")
    print(f"释义索引          : {document['source']['lexicon']['path']}"
          f"（{document['source']['lexicon']['sha256'][:12]}…）")
    print(f"规则              : {RULE_VERSION}")
    print(f"词族 / 成员       : {counts['families']:,} / {counts['members']:,}"
          f"（10k 内 {counts['cefrMembers']:,} / 10k 外 {counts['outsideMembers']:,}）")
    print(f"成员音标 / 释义   : {with_phonetic:,} / {with_translation:,}"
          f"（缺条目留空 {counts['members'] - with_translation:,}）")
    print(f"最大族 / 覆盖     : {counts['maxFamilySize']} / {counts['cefrCoveragePct']}%")
    print(f"黑名单 / allowlist: {counts['blacklistEdges']} / {counts['allowlistEdges']}")
    print(f"完整性 sha256     : {document['integrity']['sha256']}")

    if args.check:
        if not out_path.exists():
            print(f"[word-families] --check：{out_path} 不存在", file=sys.stderr)
            return 3
        current = out_path.read_text(encoding="utf-8")
        if current != text:
            print(f"[word-families] --check：{out_path} 与现场生成不一致，"
                  f"请重跑并 diff 后更新", file=sys.stderr)
            return 3
        print(f"--check 通过：{out_path} 与现场生成逐字节一致")
        return 0

    if not args.no_write:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text, encoding="utf-8")
        print(f"已写入 {_repo_relative(out_path)}（{len(text.encode('utf-8')):,} B）")
    else:
        print("未写盘（--no-write）")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
