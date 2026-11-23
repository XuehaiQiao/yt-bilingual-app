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
- P1-11（2026-11-23）在规则 E 之上应用 AI 审计的 **23 条高置信变更**：13 条
  ``trim``（删指定成员及其所有边，共 24 个成员）+ 10 条 ``split``（删指定桥边，
  共 11 条边——``large`` 族由两条桥边串起三簇）。清单写死为 ``TRIM_MEMBERS`` /
  ``SPLIT_EDGES``，逐条对着规则 E 族表校验族 id/head/成员/边存在；中/低置信
  11 条不应用（``HELD_AUDIT_ITEMS`` 校验它们仍留在原族）。

成员释义（P1-07 / P1-12）：每个成员从 ``content/wordlists/lexicon.v1.json`` 补
``phonetic`` / ``translation``（head 的释义仍由后端按同一词典在运行期补充；
成员字段写进静态数据，展开成员表不再需要额外请求）。lexicon 缺该项时回退本地
ECDICT（``data/ecdict.db``，以 ``mode=ro&immutable=1`` 只读打开、按批 ``IN``
查询；音标/释义归一化沿用 lexicon 构建口径，见 ``build_word_lists.clean_*``）；
仍缺者留 ``""``，不编造。ECDICT 只补 lexicon 缺的字段，已有值一律不覆盖。

成员词性（P1-13）：每个成员带 ``pos``——该 lemma 在 WordNet 3.0 全部 synset 的
POS 集合，按 ``n/v/a/s/r`` 规范顺序去重；该词没有任何 synset 时为 ``[]``。
POS 只作为**展示分组**依据（动词/名词/形容词/副词/其他），不参与构图、不改族
成员数；集合里 ``s`` 是 WordNet 的 satellite adjective，前端与 ``a`` 同归形容词。

确定性：同一 WordNet 语料 + 同一频表 + 同一 lexicon + 同一 ECDICT 库 → 逐字节
一致的 JSON（无时间戳/耗时）。运行期不依赖 nltk/WordNet：应用只读生成的 JSON。

用法::

    python3 scripts/build_word_families.py --wordnet-dir /tmp/nltk_data
    python3 scripts/build_word_families.py --wordnet-dir /tmp/nltk_data --check
    python3 scripts/build_word_families.py --wordnet-dir /tmp/nltk_data \\
        --ecdict data/ecdict.db --no-write

退出码：0 正常；2 WordNet 依赖/语料不可用；3 人工清单漂移 / 数据契约不符 /
ECDICT 不可用；4 输入文件在运行期间被改动。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from collections import Counter
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import word_family_open_audit as audit  # noqa: E402  （同目录只读审计脚本）
# 音标/释义归一化与 lexicon.v1.json 同源：首个含中文行、压缩空白、超 120 字符
# 截断。复用 build_word_lists 的实现，避免两套口径。
from build_word_lists import (  # noqa: E402
    TRANSLATION_LIMIT,
    clean_phonetic,
    clean_translation,
    file_sha256,
)

SCHEMA = "linguatrek.word-family.v1"
VERSION = "2026.11.23"
RULE_VERSION = "E"

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FREQUENCY = REPO_ROOT / "content/wordlist/frequency_bands.v1.json"
DEFAULT_LEXICON = REPO_ROOT / "content/wordlists/lexicon.v1.json"
DEFAULT_ECDICT = REPO_ROOT / "data/ecdict.db"
DEFAULT_OUT = REPO_ROOT / "content/wordlist/word-families.v1.json"
DEFAULT_WORDNET_DIR = Path("/tmp/nltk_data")
SCHEMA_LEXICON = "linguatrek.lexicon.v1"
# SQLite 单条语句的变量数上限默认 999（旧版本）；900 留余量，避免撞上限。
ECDICT_BATCH_SIZE = 900
ECDICT_TABLE = "stardict"

LICENSE = "WordNet 3.0 License (Princeton University, 2006)"
LICENSE_URL = "https://wordnet.princeton.edu/"
SOURCE_DRIVEN = "WordNet 3.0"

# 规则 E + P1-11 AI 审计 23 条变更后的验收数字（specs/041 §1/§4）。
# 若词表、WordNet 语料或审计清单变更导致数字变化，必须先更新审计报告与 spec，
# 再改这里。
EXPECTED_COUNTS: Mapping[str, object] = {
    "families": 3704,
    "members": 11534,
    "cefrMembers": 5233,
    "outsideMembers": 6301,
    "maxFamilySize": 14,
    "cefrWithoutFamily": 4767,
    "cefrCoveragePct": 52.33,
    "blacklistEdges": 17,
    "allowlistEdges": 22,
    # P1-13：每个成员在 WordNet 都能查到至少一个 synset；无 POS 的成员为 0。
    "membersWithPos": 11534,
    "membersWithoutPos": 0,
}

# CEFR 等级展示顺序（与频表锚点一致；数据里 levels 按此排序）。
LEVEL_ORDER: Tuple[str, ...] = ("A1", "A2", "B1", "B2", "C1")

# WordNet synset POS 字符的规范顺序（数据里 pos 按此排序；前端同一口径分组）。
# n=名词 v=动词 a=形容词 s=卫星形容词（与 a 同组） r=副词。
POS_ORDER: Tuple[str, ...] = ("n", "v", "a", "s", "r")


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
# P1-11：2026-11-23 AI 审计的 23 条高置信变更（写死；逐条校验存在性）
# ---------------------------------------------------------------------------
# 来源：docs/reports/word-family-ai-audit-summary-2026-11-23.md 与
# docs/reports/word-family-ai-audit/batch-*.json（436 族审阅结果）。
# `family` / `head` 是**应用前**（规则 E）的审计族 id，只用于定位与校验；
# 应用后 family id 会按 head rank 重新编号，别在别处引用这些 id。
# trim（13 条，24 个成员）：删成员及其所有边；
# split（10 条，11 条桥边）：只删桥边（large 族由两条桥边串起三簇）。
# 中/低置信 11 条不应用；HELD_AUDIT_ITEMS 只断言它们仍在原族。
TRIM_MEMBERS: Tuple[Mapping[str, object], ...] = (
    {"family": "F0900", "head": "digital", "members": ("digitalis",),
     "reason": "digitalis（毛地黄/洋地黄制剂）是植物—药物名，只经 digitalize.v.02「投予洋地黄」入族；与 digit 数字义不同根"},
    {"family": "F0370", "head": "industry", "members": ("diligence", "diligent"),
     "reason": "拉丁 diligere vs industria；WordNet 只经 industry.n.02「勤勉」义把 diligence 的同义名词挂进来"},
    {"family": "F1710", "head": "vital",
     "members": ("indispensability", "indispensable", "indispensableness"),
     "reason": "词根拉丁 dispensare（分配/免除）；只靠「必需＝不可或缺」近义入族（indispensable.s.01 / vitalness.n.01）"},
    {"family": "F2473", "head": "vent", "members": ("venter", "ventral"),
     "reason": "venter 是词形枢纽（「发泄的人」/「腹」）；ventral 拉丁 venter「腹」与 vent 拉丁 ventus 不同根"},
    {"family": "F2524", "head": "splash",
     "members": ("ostentate", "ostentation", "ostentatious", "ostentatiousness"),
     "reason": "拉丁 ostendere「展示」vs splash 拟声词根；只经 splashiness＝ostentation 近义入族"},
    {"family": "F1842", "head": "aggressive", "members": ("pugnacious", "pugnacity"),
     "reason": "拉丁 aggredi vs pugnare；只经 aggressiveness.n.03 同义名词（pugnacity）串接"},
    {"family": "F0064", "head": "use",
     "members": ("serviceability", "serviceable", "serviceableness"),
     "reason": "serviceable 源出 service（拉丁 servire），非 use 派生；经 useableness–serviceable 同义桥入族"},
    {"family": "F0039", "head": "life", "members": ("livery",),
     "reason": "liver–livery 走 WordNet 形容词 livery「胆汁的」（bilious.s.02）；数据里 livery 是「制服」，词形巧合"},
    {"family": "F0312", "head": "clear", "members": ("limpid", "limpidity"),
     "reason": "拉丁 limpidus vs clarus；limpidity 与 clarity 同义项串接，非 clear 派生"},
    {"family": "F0441", "head": "enter", "members": ("entrancement",),
     "reason": "entrancement 来自动词 entrance「使入迷」（en-+trance），与名词 entrance（拉丁 intrare）同形异源"},
    {"family": "F0383", "head": "page", "members": ("pager",),
     "reason": "pager 走 page.v.01「寻呼」，来自 page.n.04「男童/男侍」同形异源，与「书页」不同根"},
    {"family": "F1393", "head": "angle", "members": ("angler",),
     "reason": "angler 源自古英语 angel「鱼钩」，与 angle 拉丁 angulus「角」同形异源"},
    {"family": "F2407", "head": "frost", "members": ("frostian",),
     "reason": "frostian 源自诗人姓氏 Frost，与 frost「霜」仅词形相同、词源无关"},
)

SPLIT_EDGES: Tuple[Mapping[str, str], ...] = (
    {"family": "F0264", "head": "large", "a": "comprehensive", "b": "largeness",
     "reason": "largeness.n.01「breadth（理解面广）」近义 comprehensive；large（largus）与 comprehend（prehendere）不同根"},
    {"family": "F0264", "head": "large", "a": "extensiveness", "b": "large",
     "reason": "extensiveness.n.01 释义「large or extensive in breadth」，近义串接；extend（tendere）与 large（largus）不同根"},
    {"family": "F1709", "head": "strain", "a": "strain", "b": "strenuous",
     "reason": "strain 拉丁 stringere「拉紧」vs strenuous 拉丁 strenuus「精力充沛」；只凭「费力/紧张」义桥接"},
    {"family": "F2751", "head": "sour", "a": "sour", "b": "tartness",
     "reason": "tartness→sour 是同义关系（sour.n.02 味觉义），非派生；sour 日耳曼语源、tart 不同根"},
    {"family": "F1578", "head": "curious", "a": "curious", "b": "inquisitiveness",
     "reason": "curious 拉丁 cura「关心」（cur-）vs inquiry/inquisitive 拉丁 quaerere「寻求」；同义串接"},
    {"family": "F0202", "head": "drive", "a": "drive", "b": "drift",
     "reason": "只靠 drift.n.07「矿井水平巷道」↔drive.v.19「水平挖掘」冷僻义；现代英语已非透明派生"},
    {"family": "F0474", "head": "fly", "a": "flee", "b": "flight",
     "reason": "flight 兼「飞行」与「逃走」：flight–fly（allowlist，飞行义）与 flight–flee（flight.n.01 escape）把 flee 串进 fly"},
    {"family": "F1548", "head": "vacation", "a": "vacate", "b": "vacation",
     "reason": "走 vacation.n.02「法律上使无效/撤销」冷僻义（revoke.v.02），不是「假期」义"},
    {"family": "F0845", "head": "advantage", "a": "advantageous", "b": "profitableness",
     "reason": "profitableness 兼「有利/盈利」两义；advantage（古法语 avantage）与 profit（拉丁 profectus）不同根"},
    {"family": "F0090", "head": "bad", "a": "bad", "b": "severeness",
     "reason": "badness.n.02（疼痛/天气等不良程度）同义集把 severeness→bad；bad 日耳曼语源 vs severe 拉丁 severus"},
    {"family": "F1259", "head": "bright", "a": "bright", "b": "luminousness",
     "reason": "bright/brightness 日耳曼语源（OE beorht）vs luminous 拉丁 lumen；luminousness 是近义指回，不是派生"},
)

# 中/低置信 11 条：P1-11 不应用；这里只做「仍在原族/原边」断言，防止日后误删。
HELD_AUDIT_ITEMS: Tuple[Mapping[str, object], ...] = (
    {"family": "F0045", "head": "game", "verdict": "trim", "members": ("gameness",)},
    {"family": "F3586", "head": "agony", "verdict": "trim", "members": ("agonist", "agonistic")},
    {"family": "F1461", "head": "impress", "verdict": "trim", "members": ("impressment",)},
    {"family": "F0213", "head": "create", "verdict": "trim", "members": ("creature",)},
    {"family": "F2021", "head": "spoil", "verdict": "trim", "members": ("spoilation", "spoliation")},
    {"family": "F0252", "head": "sound", "verdict": "trim", "members": ("sonant",)},
    {"family": "F1186", "head": "urban", "verdict": "trim", "members": ("urbane",)},
    {"family": "F1453", "head": "deposit", "verdict": "split",
     "edges": (("depose", "deposition"),)},
    {"family": "F1623", "head": "dump", "verdict": "split", "edges": (("dump", "dumpy"),)},
    {"family": "F2880", "head": "foil", "verdict": "split", "edges": (("foil", "foliate"),)},
    {"family": "F0624", "head": "wind", "verdict": "trim", "members": ("winder",)},
)


# ---------------------------------------------------------------------------
# 构建（纯函数；单测不依赖 WordNet）
# ---------------------------------------------------------------------------

def _require(condition: bool, message: str) -> None:
    if not condition:
        raise BuildError(message)


def _audit_word_list(raw: object, label: str) -> Tuple[str, ...]:
    """校验审计清单里的词形列表（小写单字、无下划线）；空列表合法。"""
    if raw is None:
        return ()
    _require(isinstance(raw, (list, tuple)), f"{label}: members 必须是数组")
    words: List[str] = []
    for word in raw:
        _require(isinstance(word, str), f"{label}: 成员必须是字符串：{word!r}")
        normalized = word.strip().lower()
        _require(
            normalized == word and "_" not in normalized,
            f"{label}: 成员必须是小写单字：{word!r}",
        )
        words.append(normalized)
    return tuple(words)


def _audit_family(table: audit.FamilyTable, family_id: object, head: object,
                  label: str) -> audit.Family:
    """按应用前（规则 E）的审计族 id 定位族，并校验 head 一致。"""
    family = next(
        (item for item in table.families if item.id == family_id), None)
    _require(family is not None, f"{label}: 族 id {family_id!r} 不在规则 E 族表里")
    _require(
        family.head == head,
        f"{label}: 族 {family_id} 的 head 不是 {head!r}（实际 {family.head!r}）",
    )
    return family


def resolve_trim_members(
    table: audit.FamilyTable,
    entries: Sequence[Mapping[str, object]] = TRIM_MEMBERS,
) -> Tuple[str, ...]:
    """校验 trim 清单：族 id/head/成员都必须存在于应用前（规则 E）族表。"""
    resolved: List[str] = []
    seen: set = set()
    for entry in entries:
        label = f"TRIM_MEMBERS[{entry.get('family')}]"
        _require(str(entry.get("reason") or "").strip(), f"{label} 缺理由")
        family = _audit_family(table, entry.get("family"), entry.get("head"), label)
        members = _audit_word_list(entry.get("members"), label)
        _require(bool(members), f"{label}: members 不能为空")
        family_words = {member.word for member in family.members}
        for word in members:
            _require(
                word in family_words,
                f"{label}: 成员 {word} 不在 {family.id}/{family.head} 族里（数据漂移）",
            )
            _require(word not in seen, f"{label}: 成员重复：{word}")
            seen.add(word)
            resolved.append(word)
    return tuple(resolved)


def resolve_split_edges(
    table: audit.FamilyTable,
    edge_pairs: Iterable[Tuple[str, str]],
    entries: Sequence[Mapping[str, str]] = SPLIT_EDGES,
    *,
    allowlist_pairs: Iterable[Tuple[str, str]] = (),
) -> Tuple[Tuple[str, str], ...]:
    """校验 split 清单：边必须存在于应用前图、两端同属审计族，且不是 allowlist 边。"""
    existing = set(edge_pairs)
    allowed = set(allowlist_pairs)
    resolved: List[Tuple[str, str]] = []
    seen: set = set()
    for entry in entries:
        label = f"SPLIT_EDGES[{entry.get('family')}]"
        _require(str(entry.get("reason") or "").strip(), f"{label} 缺理由")
        family = _audit_family(table, entry.get("family"), entry.get("head"), label)
        pair = audit.edge_pair(entry.get("a"), entry.get("b"))
        _require(
            pair is not None,
            f"{label}: 端点非法：{entry.get('a')!r}/{entry.get('b')!r}",
        )
        _require(
            pair in existing,
            f"{label}: 边 {pair[0]}/{pair[1]} 不在规则 E 图里（数据漂移）",
        )
        _require(
            pair not in allowed,
            f"{label}: {pair[0]}/{pair[1]} 是 allowlist 边，不能当桥边删除",
        )
        family_words = {member.word for member in family.members}
        _require(
            pair[0] in family_words and pair[1] in family_words,
            f"{label}: 边 {pair[0]}/{pair[1]} 两端不在同一审计族 "
            f"{family.id}/{family.head}",
        )
        _require(pair not in seen, f"{label}: 边重复：{pair[0]}/{pair[1]}")
        seen.add(pair)
        resolved.append(pair)
    return tuple(resolved)


def resolve_held_items(
    table: audit.FamilyTable,
    edge_pairs: Iterable[Tuple[str, str]],
    entries: Sequence[Mapping[str, object]] = HELD_AUDIT_ITEMS,
) -> Tuple[Tuple[str, ...], Tuple[Tuple[str, str], ...]]:
    """校验中/低置信 11 条：成员仍在审计族、边仍在应用前图里（未应用）。"""
    existing = set(edge_pairs)
    members: List[str] = []
    edges: List[Tuple[str, str]] = []
    for entry in entries:
        label = f"HELD_AUDIT_ITEMS[{entry.get('family')}]"
        family = _audit_family(table, entry.get("family"), entry.get("head"), label)
        family_words = {member.word for member in family.members}
        for word in _audit_word_list(entry.get("members"), label):
            _require(word in family_words, f"{label}: 成员 {word} 不在原族")
            members.append(word)
        raw_edges = entry.get("edges") or ()
        _require(isinstance(raw_edges, (list, tuple)), f"{label}: edges 必须是数组")
        for raw_edge in raw_edges:
            _require(
                isinstance(raw_edge, (list, tuple)) and len(raw_edge) == 2,
                f"{label}: 边必须是二元组：{raw_edge!r}",
            )
            pair = audit.edge_pair(raw_edge[0], raw_edge[1])
            _require(pair is not None, f"{label}: 端点非法：{raw_edge!r}")
            _require(
                pair in existing,
                f"{label}: 边 {pair[0]}/{pair[1]} 不在规则 E 图里",
            )
            _require(
                pair[0] in family_words and pair[1] in family_words,
                f"{label}: 边 {pair[0]}/{pair[1]} 两端不在原族",
            )
            edges.append(pair)
    return tuple(members), tuple(edges)


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


def _ecdict_uri(path: Path) -> str:
    """只读 SQLite URI：绝对路径 + ``mode=ro&immutable=1``（不建库、不写库）。"""
    return f"{path.resolve().as_uri()}?mode=ro&immutable=1"


def load_ecdict_entries(
    words: Iterable[str],
    path: str | Path = DEFAULT_ECDICT,
    *,
    batch_size: int = ECDICT_BATCH_SIZE,
) -> Tuple[Dict[str, Tuple[str, str]], Dict[str, object]]:
    """按批 ``IN`` 查本地 ECDICT ``stardict``，返回 ``(entries, source)``。

    只读打开（``mode=ro&immutable=1``），不建表、不写库、不联网。音标/释义
    归一化复用 ``build_word_lists.clean_phonetic/clean_translation``，与
    ``lexicon.v1.json`` 同一口径（首个含中文行、压缩空白、超 120 字符截断）。
    ``word`` 按**精确小写**匹配：ECDICT 里只有大写形式的专名/派生（Flemish、
    Americanization 等）不作为小写 lemma 的释义来源，避免把专名义项错挂到
    普通词上；查不到的词不出现在返回字典里（调用方保留空串）。没有待查词时
    不打开数据库。
    """
    db_path = Path(path)
    queried = tuple(sorted({word for word in words if word}))
    source: Dict[str, object] = {
        "path": _repo_relative(db_path),
        "translationLimit": TRANSLATION_LIMIT,
        "queried": len(queried),
        "found": 0,
        "sha256": "",
    }
    if not queried:
        return {}, source
    _require(
        db_path.is_file(),
        f"ECDICT 不可用：{db_path} 不存在（--ecdict 指向本地 data/ecdict.db）",
    )
    source["sha256"] = file_sha256(db_path)
    entries: Dict[str, Tuple[str, str]] = {}
    try:
        connection = sqlite3.connect(_ecdict_uri(db_path), uri=True)
        try:
            columns = {
                str(row[1]) for row in connection.execute(
                    f"PRAGMA table_info({ECDICT_TABLE})")
            }
            _require(
                {"word", "phonetic", "translation"} <= columns,
                f"ECDICT 表 {ECDICT_TABLE} 缺列（实际：{sorted(columns)}）",
            )
            for start in range(0, len(queried), batch_size):
                chunk = queried[start:start + batch_size]
                placeholders = ",".join("?" * len(chunk))
                rows = connection.execute(
                    f"SELECT word, phonetic, translation FROM {ECDICT_TABLE} "
                    f"WHERE word IN ({placeholders})",
                    chunk,
                )
                for word, phonetic, translation in rows:
                    entries[str(word)] = (
                        clean_phonetic(phonetic),
                        clean_translation(translation),
                    )
        finally:
            connection.close()
    except sqlite3.Error as exc:
        raise BuildError(f"ECDICT 不可用：{db_path}（{exc}）") from exc
    source["found"] = len(entries)
    return entries, source


def load_wordnet_pos(
    words: Iterable[str],
    wordnet_dir: str | Path = DEFAULT_WORDNET_DIR,
) -> Tuple[Dict[str, Tuple[str, ...]], Dict[str, object]]:
    """按 lemma 收集 WordNet 3.0 synset POS 集合，返回 ``(pos, source)``。

    每个词的集合 = 该 lemma 在 WordNet 全部 synset 里的 ``pos()``，按
    ``POS_ORDER``（n/v/a/s/r）去重排序；WordNet 查不到的词出现在返回字典里
    且值为空元组（前端归「其他」，数据仍写 ``[]``）。只读、不联网；目录/语料
    不可用时抛 :class:`audit.WordNetUnavailable`（与构图同一个 WordNet 源，
    因此版本与 ``source.wordnet`` 一致）。
    """
    provider = audit.WordNetProvider(wordnet_dir)
    from nltk.corpus import wordnet as wn  # noqa: PLC0415  （依赖 audit 校验过目录）
    try:
        wn.ensure_loaded()
    except (LookupError, OSError) as exc:  # pragma: no cover - audit 已先校验
        raise audit.WordNetUnavailable(
            f"WordNet 数据未加载：{exc}") from exc
    queried = tuple(sorted({word for word in words if word}))
    positions: Dict[str, Tuple[str, ...]] = {}
    for word in queried:
        present = {synset.pos() for synset in wn.synsets(word)}
        positions[word] = tuple(code for code in POS_ORDER if code in present)
    # 不写 WordNet 数据目录的本地路径：数据随仓库分发且要求跨机器逐字节可复现
    # （--check），版本已由 source.wordnet.version 记录。
    return positions, {
        "version": str(provider.version),
        "posOrder": "/".join(POS_ORDER),
        "queried": len(queried),
        "withPos": sum(1 for value in positions.values() if value),
    }


def _member_pos(
    lemma: str,
    pos: Optional[Mapping[str, Sequence[str]]],
) -> Tuple[str, ...]:
    """成员 ``pos``：按 ``POS_ORDER`` 规范化的去重元组；无映射/无词条为 ``()``。

    输入来自 :func:`load_wordnet_pos`（或单测的假映射）；未知字符直接报错，
    防止把拼错的 POS 写进静态数据。
    """
    if pos is None:
        return ()
    raw = pos.get(lemma) or ()
    _require(
        isinstance(raw, (list, tuple, set, frozenset)),
        f"{lemma}: pos 必须是 POS 字符序列",
    )
    unknown = [code for code in raw if code not in POS_ORDER]
    _require(not unknown, f"{lemma}: 未知 POS 字符 {unknown!r}（只允许 n/v/a/s/r）")
    present = set(raw)
    return tuple(code for code in POS_ORDER if code in present)


def _lexicon_fields(
    lemma: str,
    lexicon: Optional[Mapping[str, Tuple[str, str]]],
) -> Tuple[str, str]:
    """成员在 lexicon 里的 ``(phonetic, translation)``；缺条目为两个空串。"""
    phonetic, translation = (lexicon or {}).get(lemma, ("", ""))
    return str(phonetic), str(translation)


def _member_fields(
    lemma: str,
    lexicon: Optional[Mapping[str, Tuple[str, str]]],
    ecdict: Optional[Mapping[str, Tuple[str, str]]] = None,
) -> Dict[str, str]:
    """一个成员的 ``phonetic`` / ``translation``。

    lexicon 优先；某字段缺失才用 ECDICT 同名字段；两边都缺留空串，不编造。
    ``lexicon`` 与 ``ecdict`` 都为 ``None`` 时不写这两个字段（纯图结构测试）。
    """
    if lexicon is None and ecdict is None:
        return {}
    lex_phonetic, lex_translation = _lexicon_fields(lemma, lexicon)
    ec_phonetic, ec_translation = (ecdict or {}).get(lemma, ("", ""))
    return {
        "phonetic": lex_phonetic or str(ec_phonetic),
        "translation": lex_translation or str(ec_translation),
    }


def _missing_lexicon_words(
    table: audit.FamilyTable,
    lexicon: Optional[Mapping[str, Tuple[str, str]]],
) -> Tuple[str, ...]:
    """成员里 lexicon 未同时有音标与释义的词（去重、排序；ECDICT 只查这些）。"""
    missing = set()
    for family in table.families:
        for member in family.members:
            phonetic, translation = _lexicon_fields(member.word, lexicon)
            if not phonetic or not translation:
                missing.add(member.word)
    return tuple(sorted(missing))


def build_family_document(
    index: audit.EdgeIndex,
    cefr: audit.CefrInput,
    *,
    blacklist: Sequence[Mapping[str, str]] = BLACKLIST,
    allowlist: Sequence[Mapping[str, str]] = ALLOWLIST,
    trim_members: Sequence[Mapping[str, object]] = TRIM_MEMBERS,
    split_edges: Sequence[Mapping[str, str]] = SPLIT_EDGES,
    held_items: Sequence[Mapping[str, object]] = HELD_AUDIT_ITEMS,
    provider_version: str = SOURCE_DRIVEN,
    frequency_path: str | Path = DEFAULT_FREQUENCY,
    frequency_version: str = "",
    lexicon: Optional[Mapping[str, Tuple[str, str]]] = None,
    lexicon_source: Optional[Mapping[str, object]] = None,
    ecdict: Optional[Mapping[str, Tuple[str, str]]] = None,
    ecdict_source: Optional[Mapping[str, object]] = None,
    ecdict_provider: Optional[
        Callable[[Sequence[str]],
                 Tuple[Mapping[str, Tuple[str, str]], Mapping[str, object]]]
    ] = None,
    pos: Optional[Mapping[str, Sequence[str]]] = None,
    pos_source: Optional[Mapping[str, object]] = None,
    pos_provider: Optional[
        Callable[[Sequence[str]],
                 Tuple[Mapping[str, Sequence[str]], Mapping[str, object]]]
    ] = None,
) -> Dict[str, object]:
    """按规则 E + P1-11 审计变更建词族文档（不写盘、不读 WordNet）。

    ``lexicon``（``lemma -> (phonetic, translation)``）非空时给每个成员补
    ``phonetic`` / ``translation``；``None`` 保留纯图结构（隔离单测用），
    CLI 总会传入。``ecdict`` 是已查好的 ECDICT 结果（同形状，缺项回退用）；
    ``ecdict_provider`` 接收「lexicon 缺音标或释义」的成员词列表，返回
    ``(entries, source)`` —— CLI 用它做只读批量查询，单测可喂假的。两者
    互斥，缺项仍缺时留空串。

    ``pos``（``lemma -> POS 字符序列``；见 :func:`load_wordnet_pos`）非空时给
    每个成员写 ``pos``（按 n/v/a/s/r 规范化，查不到的 lemma 写 ``[]``）；
    ``None`` 不写该字段（纯图结构测试）。``pos_provider`` 接收全部成员词列表，
    返回 ``(pos, source)``，CLI 注入 WordNet 查询，单测可喂假的；与 ``pos`` /
    ``pos_source`` 互斥。``trim_members`` / ``split_edges`` / ``held_items``
    默认取模块内写死的审计清单；隔离单测喂自造小图时传 ``()`` 关闭。
    """
    black_pairs, allow_pairs = validate_manual_lists(index.pairs, blacklist, allowlist)
    # allowlist 的规则前提：两侧都在 CEFR 10k（否则是产品口径变化，先复核审计）。
    for left, right in allow_pairs:
        _require(
            left in cefr.ranks and right in cefr.ranks,
            f"ALLOWLIST 边不满足「两侧都在 10k」：{left}/{right}",
        )
    black_set = set(black_pairs)
    base_pairs = (set(index.pairs) | set(allow_pairs)) - black_set
    _require(
        not (base_pairs & black_set),
        "黑名单边仍在规则 E 边集里（不应发生）",
    )
    # AI 审计清单必须逐条对上应用前（规则 E）族表；应用后再断言效果。
    base_table = audit.build_families(
        sorted(base_pairs), cefr.ranks, cefr.anchors)
    trimmed_members = resolve_trim_members(base_table, trim_members)
    split_pairs = resolve_split_edges(
        base_table, base_pairs, split_edges, allowlist_pairs=allow_pairs)
    held_members, held_edges = resolve_held_items(
        base_table, base_pairs, held_items)
    trimmed_set = set(trimmed_members)
    final_pairs = {
        (left, right) for left, right in base_pairs
        if left not in trimmed_set and right not in trimmed_set
    } - set(split_pairs)

    table = audit.build_families(sorted(final_pairs), cefr.ranks, cefr.anchors)
    # trim 后成员必须消失；split 边两端必须不再同族；中/低置信 11 条必须原样保留。
    leaked = sorted(trimmed_set & set(table.mapping))
    _require(not leaked, f"TRIM_MEMBERS 成员仍在族里：{', '.join(leaked)}")
    for left, right in split_pairs:
        left_ref = table.mapping.get(left)
        right_ref = table.mapping.get(right)
        _require(
            left_ref is None or right_ref is None
            or left_ref.family != right_ref.family,
            f"SPLIT_EDGES 拆族失败：{left}/{right} 仍在同一族",
        )
    missing_held = [word for word in held_members if word not in table.mapping]
    _require(
        not missing_held,
        f"未应用（中/低置信）成员从族里消失：{', '.join(missing_held)}",
    )
    missing_edges = [
        f"{left}/{right}" for left, right in held_edges
        if (left, right) not in final_pairs
    ]
    _require(
        not missing_edges,
        f"未应用（中/低置信）边被删除：{', '.join(missing_edges)}",
    )
    coverage = audit.coverage_for(sorted(final_pairs), cefr.ranks, cefr.anchors)
    level_order = tuple(level for _cap, level in sorted(cefr.anchors))
    rank_of_level = {level: rank for rank, level in enumerate(level_order)}

    # ECDICT 只查 lexicon 缺音标或释义的成员；查询结果只补缺项，不覆盖 lexicon。
    if ecdict_provider is not None:
        _require(
            ecdict is None and ecdict_source is None,
            "ecdict / ecdict_source 与 ecdict_provider 只能给一种",
        )
        missing_words = _missing_lexicon_words(table, lexicon)
        if missing_words:
            ecdict, ecdict_source = ecdict_provider(missing_words)
            _require(
                hasattr(ecdict, "get"),
                "ECDICT 查询结果必须是 word -> (phonetic, translation) 映射",
            )

    # 词性只用于前端展示分组：覆盖全部族成员，不改构图/成员数。
    if pos_provider is not None:
        _require(
            pos is None and pos_source is None,
            "pos / pos_source 与 pos_provider 只能给一种",
        )
        member_words = tuple(sorted(
            {member.word for family in table.families for member in family.members}))
        pos, pos_source = pos_provider(member_words)
        _require(hasattr(pos, "get"), "POS 查询结果必须是 word -> POS 序列映射")

    phonetic_fills = 0
    translation_fills = 0
    members_with_pos = 0
    families: List[Mapping[str, object]] = []
    for family in table.families:
        members: List[Mapping[str, object]] = []
        for member in family.members:
            fields = _member_fields(member.word, lexicon, ecdict)
            if fields:
                lex_phonetic, lex_translation = _lexicon_fields(
                    member.word, lexicon)
                if fields["phonetic"] and not lex_phonetic:
                    phonetic_fills += 1
                if fields["translation"] and not lex_translation:
                    translation_fills += 1
            member_pos = _member_pos(member.word, pos)
            if member_pos:
                members_with_pos += 1
            record: Dict[str, object] = {
                "lemma": member.word,
                "level": member.level,
                "rank": member.rank,
            }
            if pos is not None:
                record["pos"] = list(member_pos)
            record.update(fields)
            members.append(record)
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

    source_ecdict: Dict[str, object] = dict(ecdict_source or {})
    if ecdict is not None:
        source_ecdict["phoneticFills"] = phonetic_fills
        source_ecdict["translationFills"] = translation_fills
    source_pos: Dict[str, object] = dict(pos_source or {})
    if pos is not None:
        source_pos["membersWithoutPos"] = coverage.members - members_with_pos

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
        if lexicon is not None or ecdict is not None:
            _require(
                all(
                    isinstance(member.get("phonetic"), str)
                    and isinstance(member.get("translation"), str)
                    for member in members
                ),
                f"{family['id']} 成员缺 phonetic/translation 字段",
            )
        if pos is not None:
            _require(
                all(
                    isinstance(member.get("pos"), list)
                    and all(code in POS_ORDER for code in member["pos"])
                    and member["pos"] == list(dict.fromkeys(member["pos"]))
                    for member in members
                ),
                f"{family['id']} 成员 pos 不是规范的 n/v/a/s/r 去重数组",
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
    if pos is not None:
        counts["membersWithPos"] = members_with_pos
        counts["membersWithoutPos"] = coverage.members - members_with_pos
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
            **({"ecdict": source_ecdict} if source_ecdict else {}),
            **({"pos": source_pos} if pos is not None else {}),
        },
        "rules": {
            "graph": "WordNet 3.0 派生图：全部单字 lemma，无向边；自指/多词丢弃，同对去重",
            "family": "连通分量 ≥2 成员，且 ≥1 成员 ∈ CEFR 10k",
            "crossBoundary": "族内保留 10k 外成员，level/rank 为 null（等级留空）",
            "noFamily": "无族词（the/at 等）不写入数据；不写单例/无锚定分量",
            "head": "族内 CEFR rank 最小者；family id 按 head rank 升序 F0001…",
            "blacklist": "17 条人工确认坏边从图中删除（semantic_split + clear_error）",
            "allowlist": "22 条 WordNet 缺失/不对称的人工边加入图中（两侧都在 10k）",
            "aiAudit": "P1-11 应用 2026-11-23 AI 审计 23 条高置信变更：13 条 trim（删 24 个成员及其边）+ 10 条 split（删 11 条桥边）；中/低置信 11 条未应用",
            "memberFields": "成员 phonetic/translation 优先 lexicon.v1.json；缺项用本地 ECDICT 补（只读、精确小写匹配、首个含中文行、≤120 字符）；仍缺为空串，不编造",
            "memberPos": "成员 pos = 该 lemma 在 WordNet 3.0 全部 synset 的 POS 集合（n/v/a/s/r 规范顺序去重；无 synset 为 []）；只用于展开区按词性分组与折叠行词性徽章，不参与构图",
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


def check_output_error(out_path: str | Path, text: str) -> Optional[str]:
    """``--check`` 判定：已提交文件必须存在且与现场生成逐字节一致。

    返回 ``None`` 表示通过；否则返回可直接打印给用户的错误说明。同一输入
    重复生成得到的 ``text`` 字节一致，因此 ``--check`` 幂等。
    """
    path = Path(out_path)
    if not path.exists():
        return f"{path} 不存在"
    try:
        current = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return f"{path} 读取失败：{exc}"
    if current != text:
        return f"{path} 与现场生成不一致，请重跑并 diff 后更新"
    return None


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
    parser.add_argument("--ecdict", default=str(DEFAULT_ECDICT),
                        help="本地 ECDICT 只读库（默认 data/ecdict.db；"
                             "lexicon 缺音标/释义时按批 IN 查询）")
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
    ecdict_path = Path(args.ecdict)
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
            ecdict_provider=lambda words: load_ecdict_entries(words, ecdict_path),
            pos_provider=lambda words: load_wordnet_pos(words, args.wordnet_dir),
        )
        assert_expected_counts(document)
    except audit.WordNetUnavailable as exc:
        print(f"[word-families] WordNet 不可用：{exc}", file=sys.stderr)
        return 2
    except (audit.AuditError, BuildError) as exc:
        print(f"[word-families] 生成失败：{exc}", file=sys.stderr)
        return 3

    source_ecdict = document["source"].get("ecdict") or {}
    if audit.file_sha256(frequency_path) != sha_before:
        print("[word-families] 频表在运行期间被改动，拒绝写数据", file=sys.stderr)
        return 4
    if audit.file_sha256(lexicon_path) != lexicon_sha_before:
        print("[word-families] 释义索引在运行期间被改动，拒绝写数据", file=sys.stderr)
        return 4
    if source_ecdict.get("sha256") and file_sha256(ecdict_path) != source_ecdict["sha256"]:
        print("[word-families] ECDICT 在运行期间被改动，拒绝写数据", file=sys.stderr)
        return 4

    text = dump_json(document)
    counts = document["counts"]
    members = [member for family in document["families"] for member in family["members"]]
    with_phonetic = sum(1 for member in members if member["phonetic"])
    with_translation = sum(1 for member in members if member["translation"])
    phonetic_fills = int(source_ecdict.get("phoneticFills", 0) or 0)
    translation_fills = int(source_ecdict.get("translationFills", 0) or 0)
    print(f"schema            : {SCHEMA}")
    print(f"WordNet           : {document['source']['wordnet']['version']}")
    print(f"频表              : {document['source']['frequencyBands']['path']}"
          f"（{cefr.sha256[:12]}…）")
    print(f"释义索引          : {document['source']['lexicon']['path']}"
          f"（{document['source']['lexicon']['sha256'][:12]}…）")
    if source_ecdict:
        print(f"ECDICT            : {source_ecdict.get('path', '')}"
              f"（{str(source_ecdict.get('sha256', ''))[:12]}…；"
              f"查询 {int(source_ecdict.get('queried', 0) or 0):,} / "
              f"命中 {int(source_ecdict.get('found', 0) or 0):,}）")
    else:
        print("ECDICT            : 未使用（无缺失项）")
    print(f"规则              : {RULE_VERSION}")
    print(f"词族 / 成员       : {counts['families']:,} / {counts['members']:,}"
          f"（10k 内 {counts['cefrMembers']:,} / 10k 外 {counts['outsideMembers']:,}）")
    print(f"成员音标 / 释义   : {with_phonetic:,} / {with_translation:,}"
          f"（仍缺 {counts['members'] - with_phonetic:,} / "
          f"{counts['members'] - with_translation:,}"
          f"；ECDICT 补 {phonetic_fills:,} / {translation_fills:,}）")
    print(f"成员词性 POS      : {counts.get('membersWithPos', 0):,} / {counts['members']:,}"
          f"（无 POS {counts.get('membersWithoutPos', 0):,}；"
          f"顺序 {'/'.join(POS_ORDER)}）")
    print(f"最大族 / 覆盖     : {counts['maxFamilySize']} / {counts['cefrCoveragePct']}%")
    print(f"黑名单 / allowlist: {counts['blacklistEdges']} / {counts['allowlistEdges']}")
    print(f"AI 审计变更        : {len(TRIM_MEMBERS)} trim / {len(SPLIT_EDGES)} 条桥边 / "
          f"{len(HELD_AUDIT_ITEMS)} 条中低置信未应用")
    print(f"完整性 sha256     : {document['integrity']['sha256']}")

    if args.check:
        problem = check_output_error(out_path, text)
        if problem is not None:
            print(f"[word-families] --check：{problem}", file=sys.stderr)
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
