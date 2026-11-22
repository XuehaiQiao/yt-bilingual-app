#!/usr/bin/env python3
"""WordNet 3.0 **开放词族**（open word family）审计 —— 只读，不调模型（P1-04）。

为什么有这个脚本
----------------
P1-03（``scripts/word_family_audit.py``）只保留「两侧都在 CEFR 10k 内」的派生边，
覆盖率 26.21%、1,145 个词族、7,379 个单例。负责人新规则：

    **族内可含 10k 外的词；只要族内至少一个成员在 10k 内，就是一个词族；
    无族词（the / at 等）不进入词族表。**

本脚本按该规则重算词族，产出候选映射与坏边清单，供实现前定黑名单 / allowlist。
它**不修改** P1-03 的脚本、应用代码或数据文件。

构图口径
--------
1. 节点：WordNet 3.0 全部**单字** lemma（NFC + 小写；含下划线的多词 lemma 不参与，
   只统计其「桥接」效应）。
2. 边：``derivationally_related_forms()`` 的**无向**边。自指丢弃；同一对 (a, b)
   在不同 synset / 不同方向出现只保留一条，并记录出现过的 ``(synset, pos)`` 作为
   证据。
3. 词族：连通分量；只保留 **≥2 成员且至少 1 个成员 ∈ CEFR 10k** 的分量。
4. 成员：分量内全部单字词。10k 内成员带 CEFR 等级；10k 外成员等级留空（``None``）。
5. head：族内 CEFR rank 最小（最高频）的成员；family id 按 head rank 升序
   ``F0001…``。head 一定存在（族筛选条件保证）。
6. 无族词（the / at 等）不进 ``families`` / ``mapping``，只计数并抽样。

坏边与 allowlist
----------------
构图不判断语义，所以坏边是**人工审阅清单**（脚本内置，逐条做存在性校验，数据
漂移会直接报错），分三类：

- ``semantic_split``：语义已分化（同源但现代释义不能互推）
- ``pos_conversion``：词性转换（良性，不建议删；单独放 ``BENIGN_EDGES``）
- ``clear_error``：明显错误（WordNet 指针/义项与现代词义不符）

建议黑名单 = ``BAD_EDGES`` 全部（semantic_split + clear_error）。allowlist 用来补
WordNet 3.0 缺失的派生边（``reflect – reflection``，以及 ``strong – strength``
这类不规则派生词整批缺失）。两者都只是**建议**，产品确认后才进数据。

只读与确定性
------------
只读频表 / 释义 JSON 与 WordNet 语料；跑前跑后各算一次 SHA-256 并断言一致。唯一
写盘是 ``--out``（默认 ``/tmp/word-family-open-candidates.json``，不在仓库内）。
输出不含时间戳，两次运行**逐字节一致**；耗时只打到 stdout（性能数字来自日志，
不进 JSON，避免破坏确定性）。

用法::

    python3 scripts/word_family_open_audit.py --wordnet-dir /tmp/nltk_data
    python3 scripts/word_family_open_audit.py --wordnet-dir /tmp/nltk_data --json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Mapping, Optional, Sequence
from typing import Set, Tuple

SCHEMA = "linguatrek.word-family-open-audit.v1"
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FREQUENCY = REPO_ROOT / "content/wordlist/frequency_bands.v1.json"
DEFAULT_LEXICON = REPO_ROOT / "content/wordlists/lexicon.v1.json"
DEFAULT_OUT = Path("/tmp/word-family-open-candidates.json")
DEFAULT_WORDNET_DIR = Path("/tmp/nltk_data")
REPORT_PATH = "docs/reports/word-family-open-audit-2026-11-23.md"

DEFAULT_ANCHORS: Tuple[Tuple[int, str], ...] = (
    (1000, "A1"), (2000, "A2"), (4000, "B1"), (7000, "B2"), (10000, "C1"),
)
#: 10k 外成员的等级：留空（JSON 输出为 null）。
NO_LEVEL: Optional[str] = None
_LAST_RANK = 10 ** 9  # 排序用：10k 外成员排在族内最后，再按字母序

# 语义类别（报告里再翻中文；键保持稳定，便于 JSON / 单测）。
SEMANTIC_SPLIT = "semantic_split"
POS_CONVERSION = "pos_conversion"
CLEAR_ERROR = "clear_error"
BAD_CATEGORIES: Mapping[str, str] = {
    SEMANTIC_SPLIT: "语义已分化",
    POS_CONVERSION: "词性转换（良性）",
    CLEAR_ERROR: "明显错误",
}


class AuditError(RuntimeError):
    """审计前置条件不满足（文件结构 / 数据缺失 / 人工清单漂移）。"""


class WordNetUnavailable(AuditError):
    """找不到可用的 WordNet 3.0 语料（缺目录 / 缺 nltk）。"""


# ---------------------------------------------------------------------------
# 人工审阅清单（写死在脚本里，逐条校验存在性；数据漂移时直接报错）
# ---------------------------------------------------------------------------

# group: inherited = P1-03 已在 10k 图内确认；opened = 放开 10k 边界后才出现；
#        new = 本次开放图人工审阅新发现。
BAD_EDGES: Tuple[Mapping[str, str], ...] = (
    # ---- 语义已分化（10 条，P1-03 已确认；开放图里依然存在） ----
    {"a": "critical", "b": "crisis", "category": SEMANTIC_SPLIT, "group": "inherited",
     "reason": "批评的/关键的 vs 危机；链接走 critical.s.05「处于危机边缘」"},
    {"a": "elect", "b": "eligible", "category": SEMANTIC_SPLIT, "group": "inherited",
     "reason": "选举 vs 有资格的；elect.v.01 ↔ eligible.a.01"},
    {"a": "contain", "b": "continent", "category": SEMANTIC_SPLIT, "group": "inherited",
     "reason": "包含 vs 大陆；走 hold.v.11「能控制排泄」冷僻义"},
    {"a": "contain", "b": "content", "category": SEMANTIC_SPLIT, "group": "inherited",
     "reason": "包含 vs 内容/满足；hold.v.11 ↔ capacity.n.03"},
    {"a": "receive", "b": "receptor", "category": SEMANTIC_SPLIT, "group": "inherited",
     "reason": "收到 vs 受体（专业术语）；pick_up.v.09 ↔ sense_organ.n.01"},
    {"a": "commit", "b": "committee", "category": SEMANTIC_SPLIT, "group": "inherited",
     "reason": "委托/犯罪 vs 委员会；entrust.v.01 ↔ committee.n.01"},
    {"a": "major", "b": "majority", "category": SEMANTIC_SPLIT, "group": "inherited",
     "reason": "主要的/主修 vs 多数；同 POS 也挡不住"},
    {"a": "signify", "b": "significant", "category": SEMANTIC_SPLIT, "group": "inherited",
     "reason": "表示 vs 重要的；signify.v.02 ↔ meaning.s.01"},
    {"a": "grave", "b": "gravity", "category": SEMANTIC_SPLIT, "group": "inherited",
     "reason": "坟墓 vs 重力；走 grave.s.01「严肃」义项"},
    {"a": "calculate", "b": "calculus", "category": SEMANTIC_SPLIT, "group": "inherited",
     "reason": "计算 vs 微积分/结石；calculate.v.01 ↔ calculus.n.03"},
    # ---- 明显错误（3 条，P1-03 已确认） ----
    {"a": "tow", "b": "tower", "category": CLEAR_ERROR, "group": "inherited",
     "reason": "拖 vs 塔；tower → tow 走 tugboat.n.01（拖船）"},
    {"a": "tie", "b": "tier", "category": CLEAR_ERROR, "group": "inherited",
     "reason": "WordNet 用 tier「打平的人/系东西的人」冷僻义"},
    {"a": "grade", "b": "gradual", "category": CLEAR_ERROR, "group": "inherited",
     "reason": "走「坡度 → 不陡的」，现代英语无派生关系"},
    # ---- 放开 10k 边界后才出现的坏边 ----
    {"a": "judge", "b": "adjudicate", "category": CLEAR_ERROR, "group": "opened",
     "reason": "现代英语非派生；judge.n.01 → adjudicate，P1-03 被 10k 边界挡住，开放图重新引入"},
    # ---- 本次开放图人工审阅新发现 ----
    {"a": "tend", "b": "tender", "category": SEMANTIC_SPLIT, "group": "new",
     "reason": "倾向/照料 vs 温柔的/投标；走 tender.n.03「看护者」与 attendant.n.01"},
    {"a": "industry", "b": "industrious", "category": SEMANTIC_SPLIT, "group": "new",
     "reason": "工业/行业 vs 勤奋的；走 industry.n.02「勤勉」义项"},
    {"a": "stand", "b": "standard", "category": SEMANTIC_SPLIT, "group": "new",
     "reason": "站立 vs 标准；走 standard.n.05「支柱/旗杆」冷僻义"},
)

# 良性「词性转换」：列出来是为了不把它们误算进误合并率（不建议删）。
BENIGN_EDGES: Tuple[Mapping[str, str], ...] = (
    {"a": "decide", "b": "decision", "reason": "决定 vs 决定；释义透明"},
    {"a": "decide", "b": "decisive", "reason": "决定 vs 决定性的；释义透明"},
    {"a": "reflect", "b": "reflective", "reason": "反映 vs 反思的；释义透明"},
    {"a": "protect", "b": "protective", "reason": "保护 vs 保护性的；释义透明"},
    {"a": "differ", "b": "difference", "reason": "不同 vs 差异；释义透明"},
)

# 人工 allowlist（建议首批）：WordNet 3.0 缺失 / 不对称、但形态与语义都明确的边。
# 每条都要求「两侧 ∈ CEFR 10k」且「WordNet 图里确实没有这条边」，否则报错。
ALLOWLIST: Tuple[Mapping[str, str], ...] = (
    # P1-03 已提出、本次仍缺（WordNet 3.0 里 reflection 的 8 个 synset 全无派生指针）
    {"a": "reflect", "b": "reflection", "reason": "同源 -tion 派生；WordNet 3.0 缺指针"},
    # 不规则派生词整批缺失：形容词/动词 → 抽象名词（WordNet 3.0 系统性缺口）
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
# 基础工具
# ---------------------------------------------------------------------------

def normalize_word(raw: object) -> str:
    """NFC + 去首尾空白 + 小写；空 / None 返回空串（与 backend 词形口径一致）。"""
    text = unicodedata.normalize("NFC", str(raw if raw is not None else ""))
    return text.strip().lower()


def file_sha256(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_anchors(items: Iterable[Tuple[object, object]]) -> Tuple[Tuple[int, str], ...]:
    ordered = tuple(sorted((int(cap), str(level).upper()) for cap, level in items))
    if not ordered:
        raise AuditError("cefr_anchors 为空，无法派生 CEFR 等级")
    return ordered


def level_for_rank(rank: int, anchors: Sequence[Tuple[int, str]]) -> str:
    for cap, level in anchors:
        if rank <= cap:
            return level
    return anchors[-1][1]


def edge_pair(first: object, second: object) -> Optional[Tuple[str, str]]:
    """规范化成无向边端点；自指 / 多词 / 空串返回 ``None``。"""
    left = normalize_word(first)
    right = normalize_word(second)
    if not left or not right or left == right:
        return None
    if "_" in left or "_" in right:
        return None
    return (left, right) if left <= right else (right, left)


# ---------------------------------------------------------------------------
# 输入（只读）
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CefrInput:
    lemmas: Tuple[str, ...]
    ranks: Mapping[str, int]
    anchors: Tuple[Tuple[int, str], ...]
    sha256: str
    counts: Mapping[str, object]


def load_cefr(path: str | Path) -> CefrInput:
    """读频表并校验结构；只读，不写缓存。"""
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    entries = document.get("entries") if isinstance(document, dict) else None
    if not isinstance(entries, list):
        raise AuditError(f"{path}: 缺少 entries 数组")
    lemmas: List[str] = []
    ranks: Dict[str, int] = {}
    for entry in entries:
        if not (isinstance(entry, (list, tuple)) and len(entry) >= 2):
            raise AuditError(f"{path}: entries 行不是 [lemma, rank]")
        lemma = normalize_word(entry[0])
        try:
            rank = int(entry[1])
        except (TypeError, ValueError) as exc:
            raise AuditError(f"{path}: rank 非整数：{entry!r}") from exc
        if not lemma:
            raise AuditError(f"{path}: 空 lemma")
        if lemma in ranks:
            raise AuditError(f"{path}: lemma 重复：{lemma}")
        lemmas.append(lemma)
        ranks[lemma] = rank
    anchors_raw = document.get("cefr_anchors")
    if isinstance(anchors_raw, list) and anchors_raw:
        anchors = parse_anchors([
            (item.get("max_rank"), item.get("level"))
            for item in anchors_raw if isinstance(item, dict)
        ])
    else:
        anchors = DEFAULT_ANCHORS
    return CefrInput(
        lemmas=tuple(lemmas),
        ranks=ranks,
        anchors=anchors,
        sha256=file_sha256(path),
        counts=dict(document.get("counts") or {}),
    )


# ---------------------------------------------------------------------------
# WordNet 适配层（懒加载；测试可在无 WordNet 的环境跑纯逻辑）
# ---------------------------------------------------------------------------

class WordNetProvider:
    """WordNet 3.0 派生指针提供者；数据目录必须显式存在，缺失时给可操作错误。"""

    def __init__(self, wordnet_dir: str | Path | None = None):
        self.root: Optional[Path] = None
        self.wordnet_dir = str(wordnet_dir) if wordnet_dir else None
        self.version = "unknown"
        self._wn = None
        if self.wordnet_dir:
            self.root = Path(self.wordnet_dir).expanduser().resolve()
            self._check_dir(self.root)
        self._load()

    def _check_dir(self, root: Path) -> None:
        candidates = (
            root / "corpora" / "wordnet",
            root / "corpora" / "wordnet.zip",
            root / "wordnet",
            root / "wordnet.zip",
        )
        if not any(candidate.exists() for candidate in candidates):
            raise WordNetUnavailable(
                f"未在 {root} 找到 WordNet 语料（期望 {root}/corpora/wordnet 或 "
                f"{root}/corpora/wordnet.zip）。请用 --wordnet-dir 指向 NLTK 数据目录"
                f"（如 --wordnet-dir /tmp/nltk_data），或先安装："
                f"python3 -m nltk.downloader -d {root} wordnet"
            )

    def _load(self) -> None:
        try:
            import nltk
        except ImportError as exc:
            raise WordNetUnavailable(
                "系统 python3 缺少 nltk；请安装 nltk 3.6.1+ 并下载 wordnet，"
                "或用 --wordnet-dir 指向已有 WordNet 数据目录。"
            ) from exc
        if self.root is not None:
            base = self.root.parent if self.root.name == "corpora" else self.root
            if str(base) not in nltk.data.path:
                nltk.data.path.insert(0, str(base))
        from nltk.corpus import wordnet as wn
        try:
            wn.ensure_loaded()
        except (LookupError, OSError) as exc:
            raise WordNetUnavailable(
                "WordNet 数据未加载：请检查 --wordnet-dir（NLTK 需要 "
                "corpora/wordnet 或 corpora/wordnet.zip），"
                "或运行 python3 -m nltk.downloader -d /tmp/nltk_data wordnet。"
            ) from exc
        self._wn = wn
        try:
            self.version = str(wn.get_version())
        except Exception:  # pragma: no cover - 极端数据损坏时才触发
            self.version = "unknown"

    def derivation_pointers(self) -> Iterator[Tuple[str, str, str, str]]:
        """遍历全部 synset 的全部派生指针 → ``(source, target, synset, pos)``。

        只遍历一次 ``all_synsets()``，避免按词重复查表（全库约 5–8s）。
        """
        if self._wn is None:
            raise WordNetUnavailable("WordNet 尚未加载")
        for synset in self._wn.all_synsets():
            name = synset.name()
            pos = synset.pos()
            for wordnet_lemma in synset.lemmas():
                source = wordnet_lemma.name()
                for related in wordnet_lemma.derivationally_related_forms():
                    yield source, related.name(), name, pos


# ---------------------------------------------------------------------------
# 全量派生图（纯函数，单测直接喂假数据）
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class EdgeIndex:
    """无向边 → 证据 synset 集合；附带构图口径的原始计数。"""

    edges: Mapping[Tuple[str, str], Tuple[Tuple[str, str], ...]]
    nodes: Tuple[str, ...]
    raw_pointers: int
    self_pointers: int
    multiword_pointers: int
    multiword_pairs: Tuple[Tuple[str, str], ...]
    multiword_nodes: Tuple[str, ...]
    case_altered_pointers: int

    @property
    def edge_count(self) -> int:
        return len(self.edges)

    @property
    def pairs(self) -> Set[Tuple[str, str]]:
        return set(self.edges)


def build_edge_index(records: Iterable[Tuple[str, str, str, str]]) -> EdgeIndex:
    """把原始派生指针折叠成去重无向边，并记录证据 synset。

    - 自指（WordNet 会把词自己列进派生表）与含下划线的多词 lemma 不计入边；
    - 同一对在多个 synset / 两个方向出现只保留一条，证据集合并；
    - 输出全部排序，保证逐字节确定性。
    """
    evidence: Dict[Tuple[str, str], Set[Tuple[str, str]]] = defaultdict(set)
    multiword_pairs: Set[Tuple[str, str]] = set()
    multiword_nodes: Set[str] = set()
    raw = self_links = multiword = altered = 0
    for source, target, synset, pos in records:
        raw += 1
        left_raw = unicodedata.normalize(
            "NFC", str(source if source is not None else "")).strip()
        right_raw = unicodedata.normalize(
            "NFC", str(target if target is not None else "")).strip()
        left = left_raw.lower()
        right = right_raw.lower()
        if left != left_raw or right != right_raw:
            altered += 1
        if not left or not right:
            continue
        if left == right:
            self_links += 1
            continue
        if "_" in left or "_" in right:
            multiword += 1
            multiword_pairs.add((left.replace("_", " "), right.replace("_", " ")))
            multiword_nodes.update(name for name in (left, right) if "_" in name)
            continue
        key = (left, right) if left <= right else (right, left)
        evidence[key].add((str(synset), str(pos)))
    edges = {key: tuple(sorted(evidence[key])) for key in sorted(evidence)}
    nodes = sorted({word for key in edges for word in key})
    return EdgeIndex(
        edges=edges,
        nodes=tuple(nodes),
        raw_pointers=raw,
        self_pointers=self_links,
        multiword_pointers=multiword,
        multiword_pairs=tuple(sorted(multiword_pairs)),
        multiword_nodes=tuple(sorted(multiword_nodes)),
        case_altered_pointers=altered,
    )


class UnionFind:
    def __init__(self) -> None:
        self.parent: Dict[str, str] = {}

    def find(self, item: str) -> str:
        self.parent.setdefault(item, item)
        root = item
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[item] != item:
            self.parent[item], item = root, self.parent[item]
        return root

    def union(self, first: str, second: str) -> None:
        root_a = self.find(first)
        root_b = self.find(second)
        if root_a != root_b:
            self.parent[root_b] = root_a


def connected_components(pairs: Iterable[Tuple[str, str]]) -> List[Tuple[str, ...]]:
    """无向图连通分量；每个分量内按字母序排序，分量按首词排序（确定性）。"""
    finder = UnionFind()
    for first, second in pairs:
        finder.union(first, second)
    groups: Dict[str, List[str]] = defaultdict(list)
    for node in sorted(finder.parent):
        groups[finder.find(node)].append(node)
    return sorted(
        (tuple(sorted(members)) for members in groups.values()),
        key=lambda members: (members[0], len(members)),
    )


# ---------------------------------------------------------------------------
# 词族（开放边界）
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FamilyMember:
    word: str
    rank: Optional[int]
    level: Optional[str]

    @property
    def in_cefr(self) -> bool:
        return self.rank is not None

    def to_json(self) -> Mapping[str, object]:
        return {"w": self.word, "rank": self.rank, "level": self.level}


@dataclass(frozen=True)
class Family:
    id: str
    head: str
    head_rank: int
    head_level: str
    members: Tuple[FamilyMember, ...]

    @property
    def size(self) -> int:
        return len(self.members)

    @property
    def cefr_members(self) -> Tuple[FamilyMember, ...]:
        return tuple(member for member in self.members if member.in_cefr)

    def to_json(self) -> Mapping[str, object]:
        return {
            "id": self.id,
            "head": self.head,
            "headLevel": self.head_level,
            "size": self.size,
            "cefrMembers": len(self.cefr_members),
            "members": [member.to_json() for member in self.members],
        }


@dataclass(frozen=True)
class FamilyRef:
    family: str
    head: str
    size: int

    def to_json(self) -> Mapping[str, object]:
        return {"family": self.family, "head": self.head, "size": self.size}


@dataclass(frozen=True)
class FamilyTable:
    families: Tuple[Family, ...]
    mapping: Mapping[str, FamilyRef]
    component_count: int
    components_without_cefr: int

    def family_of(self, word: str) -> Optional[Family]:
        ref = self.mapping.get(normalize_word(word))
        if ref is None:
            return None
        for family in self.families:
            if family.id == ref.family:
                return family
        return None  # pragma: no cover - 映射与族列表由同一函数生成


def build_families(pairs: Iterable[Tuple[str, str]],
                   ranks: Mapping[str, int],
                   anchors: Sequence[Tuple[int, str]]) -> FamilyTable:
    """按开放规则建词族。

    - 连通分量 ≥2 成员，且**至少 1 个成员 ∈ ranks（CEFR 10k）**才算一个词族；
    - 族内保留全部成员，10k 外成员 ``rank=None`` / ``level=None``；
    - head = 族内 rank 最小者，family id 按 head rank 升序编号。
    """
    edge_pairs = sorted({edge_pair(first, second) for first, second in pairs
                         if edge_pair(first, second) is not None})
    components = connected_components(edge_pairs)
    pending: List[Tuple[int, str, Tuple[FamilyMember, ...]]] = []
    outside_only = 0
    for component in components:
        if len(component) < 2:  # pragma: no cover - 分量只由边端点构成，不会为 1
            continue
        anchored = [word for word in component if word in ranks]
        if not anchored:
            outside_only += 1
            continue
        members = tuple(sorted(
            (
                FamilyMember(
                    word=word,
                    rank=ranks.get(word),
                    level=(level_for_rank(ranks[word], anchors)
                           if word in ranks else NO_LEVEL),
                )
                for word in component
            ),
            key=lambda member: (
                member.rank if member.rank is not None else _LAST_RANK,
                member.word,
            ),
        ))
        head = members[0]
        if head.rank is None:  # pragma: no cover - anchored 非空保证 head 在 10k 内
            raise AuditError(f"族 head 不在 10k 内：{component!r}")
        pending.append((head.rank, head.word, members))
    pending.sort(key=lambda item: (item[0], item[1]))

    families: List[Family] = []
    mapping: Dict[str, FamilyRef] = {}
    for index, (_rank, _head_word, members) in enumerate(pending, start=1):
        family = Family(
            id=f"F{index:04d}",
            head=members[0].word,
            head_rank=members[0].rank or 0,
            head_level=members[0].level or "",
            members=members,
        )
        families.append(family)
        ref = FamilyRef(family=family.id, head=family.head, size=family.size)
        for member in family.members:
            mapping[member.word] = ref
    return FamilyTable(
        families=tuple(families),
        mapping=mapping,
        component_count=len(components),
        components_without_cefr=outside_only,
    )


# ---------------------------------------------------------------------------
# 统计
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Coverage:
    edges: int
    families: int
    members: int
    cefr_members: int
    outside_members: int
    max_size: int
    median_size: float
    size_distribution: Mapping[int, int]
    cefr_without_family: int
    families_with_multiple_cefr: int
    cefr_coverage_pct: float

    def to_json(self) -> Mapping[str, object]:
        return {
            "edges": self.edges,
            "families": self.families,
            "members": self.members,
            "cefrMembers": self.cefr_members,
            "outsideMembers": self.outside_members,
            "maxFamilySize": self.max_size,
            "medianFamilySize": self.median_size,
            "sizeDistribution": {
                str(size): count
                for size, count in sorted(self.size_distribution.items())
            },
            "cefrWithoutFamily": self.cefr_without_family,
            "familiesWithMultipleCefr": self.families_with_multiple_cefr,
            "cefrCoveragePct": self.cefr_coverage_pct,
        }


def median_of(values: Sequence[int]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[middle])
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def coverage_for(pairs: Iterable[Tuple[str, str]],
                 ranks: Mapping[str, int],
                 anchors: Sequence[Tuple[int, str]]) -> Coverage:
    """给定边集算词族覆盖（纯函数；规则对比 / 单测复用）。"""
    edge_pairs = sorted(set(pairs))
    table = build_families(edge_pairs, ranks, anchors)
    sizes = [family.size for family in table.families]
    cefr_members = sum(len(family.cefr_members) for family in table.families)
    members = sum(sizes)
    return Coverage(
        edges=len(edge_pairs),
        families=len(table.families),
        members=members,
        cefr_members=cefr_members,
        outside_members=members - cefr_members,
        max_size=max(sizes) if sizes else 0,
        median_size=median_of(sizes),
        size_distribution=dict(Counter(sizes)),
        cefr_without_family=len(ranks) - cefr_members,
        families_with_multiple_cefr=sum(
            1 for family in table.families if len(family.cefr_members) >= 2),
        cefr_coverage_pct=round(100.0 * cefr_members / len(ranks), 2) if ranks else 0.0,
    )


def families_containing(pairs: Iterable[Tuple[str, str]],
                        table: FamilyTable) -> Tuple[str, ...]:
    """给定边集命中的词族 id（两端在同一族才算；升序）。"""
    hit: Set[str] = set()
    for first, second in pairs:
        ref_a = table.mapping.get(first)
        ref_b = table.mapping.get(second)
        if ref_a is not None and ref_b is not None and ref_a.family == ref_b.family:
            hit.add(ref_a.family)
    return tuple(sorted(hit))


# ---------------------------------------------------------------------------
# 人工清单校验 & 规则对比
# ---------------------------------------------------------------------------

def validate_edge_list(entries: Iterable[Mapping[str, str]],
                       edge_pairs: Set[Tuple[str, str]],
                       *,
                       label: str,
                       must_exist: bool = True) -> Tuple[Tuple[str, str], ...]:
    """校验人工清单里的边：成对合法、类别已知、存在性符合预期。"""
    validated: List[Tuple[str, str]] = []
    for entry in entries:
        pair = edge_pair(entry.get("a"), entry.get("b"))
        if pair is None:
            raise AuditError(f"{label}: 端点非法：{entry!r}")
        category = entry.get("category")
        if category is not None and category not in BAD_CATEGORIES:
            raise AuditError(f"{label}: 未知类别 {category!r}（{pair[0]}/{pair[1]}）")
        present = pair in edge_pairs
        if must_exist and not present:
            raise AuditError(
                f"{label}: WordNet 图里找不到 {pair[0]}/{pair[1]} —— "
                f"人工清单与数据漂移，请先复核再改报告"
            )
        if not must_exist and present:
            raise AuditError(
                f"{label}: {pair[0]}/{pair[1]} 已经有 WordNet 派生边，"
                f"不该放进 allowlist（会重复）"
            )
        validated.append(pair)
    return tuple(validated)


def rule_matrix(index: EdgeIndex,
                ranks: Mapping[str, int],
                anchors: Sequence[Tuple[int, str]],
                bad_pairs: Sequence[Tuple[str, str]],
                allow_pairs: Sequence[Tuple[str, str]]) -> List[Mapping[str, object]]:
    """5 条规则的覆盖对比（基线 / 开放 / allowlist / 黑名单 / 建议）。"""
    all_pairs = index.pairs
    insider = {pair for pair in all_pairs if pair[0] in ranks and pair[1] in ranks}
    bad = set(bad_pairs)
    rows: List[Mapping[str, object]] = []

    def row(key: str, label: str, pairs: Set[Tuple[str, str]]) -> None:
        coverage = coverage_for(pairs, ranks, anchors)
        table = build_families(sorted(pairs), ranks, anchors)
        payload = dict(coverage.to_json())
        payload["key"] = key
        payload["label"] = label
        payload["familiesWithBadEdge"] = len(families_containing(bad & pairs, table))
        payload["badEdgesPresent"] = len(bad & pairs)
        rows.append(payload)

    row("A", "仅 10k 内（P1-03 基线）", insider)
    row("B", "全量派生图（开放边界）", all_pairs)
    row("C", "B + allowlist", all_pairs | set(allow_pairs))
    row("D", "B − 黑名单", all_pairs - bad)
    row("E", "B + allowlist − 黑名单（建议）", (all_pairs | set(allow_pairs)) - bad)
    return rows


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

@dataclass
class AuditResult:
    document: Mapping[str, object]
    timings: Mapping[str, float]
    family_table: FamilyTable


def _top_families(table: FamilyTable, limit: int = 10) -> List[Mapping[str, object]]:
    ordered = sorted(
        table.families,
        key=lambda family: (-family.size, family.head_rank, family.head),
    )[:limit]
    return [
        {
            "id": family.id,
            "head": family.head,
            "size": family.size,
            "cefrMembers": len(family.cefr_members),
            "members": [member.word for member in family.members],
        }
        for family in ordered
    ]


def _example_family(table: FamilyTable,
                    word: str,
                    edges: Mapping[Tuple[str, str], Tuple[Tuple[str, str], ...]],
                    ) -> Mapping[str, object]:
    family = table.family_of(word)
    if family is None:
        return {"word": word, "family": None, "size": 0, "members": [], "edges": []}
    member_set = {member.word for member in family.members}
    evidence = [
        {"a": pair[0], "b": pair[1],
         "synsets": [f"{name}:{pos}" for name, pos in synsets]}
        for pair, synsets in edges.items()
        if pair[0] in member_set and pair[1] in member_set
    ]
    return {
        "word": word,
        "family": family.id,
        "head": family.head,
        "size": family.size,
        "cefrMembers": len(family.cefr_members),
        "members": [member.to_json() for member in family.members],
        "edges": sorted(evidence, key=lambda item: (item["a"], item["b"])),
    }


def measure_multiword_bridge(index: EdgeIndex) -> Mapping[str, int]:
    """多词 lemma 被排除后，是否会少合并单字分量（桥接效应）。

    把多词节点临时加进图，再只看单字节点：统计原本分开的单字分量被并起来的次数。
    """
    base = connected_components(sorted(index.pairs))
    base_root: Dict[str, int] = {}
    for position, component in enumerate(base):
        for word in component:
            base_root[word] = position
    extended = connected_components(
        sorted(set(index.pairs) | set(index.multiword_pairs)))
    # 多词节点在 multiword_pairs 里已被 ``_`` → 空格；用集合精确排除，不要用下划线判断。
    multiword_names = {
        name for pair in index.multiword_pairs for name in pair if " " in name
    }
    merged = 0
    for component in extended:
        singles = [word for word in component if word not in multiword_names]
        if len(singles) < 2:
            continue
        base_ids = {base_root.get(word) for word in singles}
        if len(base_ids) > 1:
            merged += len(base_ids) - 1
    return {
        "singleWordComponentsBefore": len(base),
        "componentsMergedIfIncluded": merged,
    }


def run_audit(cefr: CefrInput,
              provider: WordNetProvider,
              *,
              frequency_path: str | Path = DEFAULT_FREQUENCY,
              lexicon_path: str | Path = DEFAULT_LEXICON,
              bad_edges: Sequence[Mapping[str, str]] = BAD_EDGES,
              benign_edges: Sequence[Mapping[str, str]] = BENIGN_EDGES,
              allowlist: Sequence[Mapping[str, str]] = ALLOWLIST,
              ) -> AuditResult:
    """跑完整审计，返回可序列化文档 + 耗时。

    人工清单可注入（单测用固定小样本，不依赖真实 WordNet 数据）。
    """
    ranks = cefr.ranks
    anchors = cefr.anchors
    timings: Dict[str, float] = {}
    started = time.perf_counter()

    scan_started = time.perf_counter()
    records = list(provider.derivation_pointers())
    timings["scan"] = round(time.perf_counter() - scan_started, 2)

    build_started = time.perf_counter()
    index = build_edge_index(records)
    timings["build"] = round(time.perf_counter() - build_started, 2)

    family_started = time.perf_counter()
    table = build_families(sorted(index.pairs), ranks, anchors)
    timings["families"] = round(time.perf_counter() - family_started, 2)

    bad_pairs = validate_edge_list(bad_edges, index.pairs, label="BAD_EDGES")
    benign_pairs = validate_edge_list(benign_edges, index.pairs, label="BENIGN_EDGES")
    allow_pairs = validate_edge_list(
        allowlist, index.pairs, label="ALLOWLIST", must_exist=False)
    # 黑名单 = 坏边清单全部；良性词性转换只记录、不删。
    blacklist = {pair for pair in bad_pairs if pair not in set(benign_pairs)}

    bad_json: List[Mapping[str, object]] = []
    for entry, pair in zip(bad_edges, bad_pairs):
        bad_json.append({
            "a": pair[0],
            "b": pair[1],
            "category": entry["category"],
            "categoryLabel": BAD_CATEGORIES[entry["category"]],
            "group": entry["group"],
            "reason": entry["reason"],
            "bothInCefr": pair[0] in ranks and pair[1] in ranks,
            "ranks": [ranks.get(pair[0]), ranks.get(pair[1])],
            "synsets": [f"{name}:{pos}" for name, pos in index.edges.get(pair, ())],
        })
    benign_json = [
        {"a": pair[0], "b": pair[1], "reason": entry["reason"]}
        for entry, pair in zip(benign_edges, benign_pairs)
    ]
    allow_json = [
        {"a": pair[0], "b": pair[1], "reason": entry["reason"],
         "ranks": [ranks.get(pair[0]), ranks.get(pair[1])]}
        for entry, pair in zip(allowlist, allow_pairs)
    ]

    open_coverage = coverage_for(sorted(index.pairs), ranks, anchors)
    rows = rule_matrix(index, ranks, anchors, sorted(blacklist), allow_pairs)
    bad_family_ids = families_containing(sorted(blacklist), table)

    no_family = sorted(
        (word for word in ranks if word not in table.mapping),
        key=lambda word: (ranks[word], word),
    )
    reflect_family = table.family_of("reflect")
    comprehend_family = table.family_of("comprehend")
    largest = max(table.families, key=lambda family: (family.size, -family.head_rank))
    assertions = {
        "theInAnyFamily": "the" in table.mapping,
        "atInAnyFamily": "at" in table.mapping,
        "reflectionInReflectFamily": bool(
            reflect_family
            and any(member.word == "reflection" for member in reflect_family.members)
        ),
        "extendInComprehendFamily": bool(
            comprehend_family
            and any(member.word == "extend" for member in comprehend_family.members)
        ),
        "largestFamilyHead": largest.head if table.families else None,
        "largestFamilyIsComprehend": bool(table.families and largest.head == "comprehend"),
        "mappingEqualsFamilyMembers": len(table.mapping) == open_coverage.members,
        "cefrInMappingIsFamiliedWords": sum(
            1 for word in table.mapping if word in ranks) == open_coverage.cefr_members,
    }

    document = {
        "schema": SCHEMA,
        "rules": {
            "nodes": "WordNet 3.0 全部单字 lemma（NFC+小写）",
            "edges": "derivationally_related_forms() 无向边；自指/多词丢弃，同对多 synset 去重",
            "family": "连通分量 ≥2 成员，且 ≥1 成员 ∈ CEFR 10k",
            "members": "分量全部成员；10k 内带 CEFR 等级，10k 外等级为 null",
            "head": "族内 CEFR rank 最小者；family id 按 head rank 升序 F0001…",
            "noFamily": "无族词不进 families/mapping，只计数",
            "showOnly": "只输出有族词（≥1 个 10k 成员），不输出单例",
        },
        "source": {
            "wordnet": {
                "version": provider.version,
                "dataDir": provider.wordnet_dir or "(nltk default)",
                "license": "WordNet 3.0 License (Princeton University, 2006)",
            },
            "frequencyBands": {
                "path": _repo_relative(frequency_path),
                "sha256": cefr.sha256,
                "lemmas": len(ranks),
                "counts": dict(cefr.counts),
            },
            "lexicon": {
                "path": _repo_relative(lexicon_path),
                "sha256": (file_sha256(lexicon_path)
                           if Path(lexicon_path).exists() else None),
                "role": "只做只读哈希证明，不参与构图",
            },
        },
        "graph": {
            "nodes": len(index.nodes),
            "edges": index.edge_count,
            "rawPointers": index.raw_pointers,
            "selfPointers": index.self_pointers,
            "caseAlteredPointers": index.case_altered_pointers,
            "multiwordPointers": index.multiword_pointers,
            "multiwordPairs": len(index.multiword_pairs),
            "multiwordNodes": len(index.multiword_nodes),
            "components": table.component_count,
            "componentsWithoutCefr": table.components_without_cefr,
            "edgeClasses": {
                "bothCefr": sum(1 for pair in index.pairs
                                if pair[0] in ranks and pair[1] in ranks),
                "crossBoundary": sum(1 for pair in index.pairs
                                     if (pair[0] in ranks) != (pair[1] in ranks)),
                "outsideOnly": sum(1 for pair in index.pairs
                                   if pair[0] not in ranks and pair[1] not in ranks),
            },
            "multiwordBridge": measure_multiword_bridge(index),
        },
        "coverage": open_coverage.to_json(),
        "topFamilies": _top_families(table),
        "ruleComparison": rows,
        "badEdges": bad_json,
        "benignEdges": benign_json,
        "blacklist": {
            "edges": [{"a": pair[0], "b": pair[1]} for pair in sorted(blacklist)],
            "effect": next(row for row in rows if row["key"] == "D"),
        },
        "allowlist": {
            "edges": allow_json,
            "effect": next(row for row in rows if row["key"] == "C"),
        },
        "recommended": next(row for row in rows if row["key"] == "E"),
        "badEdgeFamilies": list(bad_family_ids),
        "examples": {
            word: _example_family(table, word, index.edges)
            for word in ("decide", "reflect", "judge", "critical", "comprehend")
        },
        "assertions": assertions,
        "noFamily": {
            "count": len(no_family),
            "pct": round(100.0 * len(no_family) / len(ranks), 2) if ranks else 0.0,
            "sample": no_family[:15],
            "note": "无族词不进 families/mapping；sample 是 rank 最小的 15 个",
        },
        "families": [family.to_json() for family in table.families],
        "mapping": {word: ref.to_json() for word, ref in sorted(table.mapping.items())},
    }
    timings["total"] = round(time.perf_counter() - started, 2)
    return AuditResult(document=document, timings=timings, family_table=table)


def _repo_relative(path: str | Path) -> str:
    resolved = Path(path)
    try:
        return str(resolved.resolve().relative_to(REPO_ROOT))
    except (ValueError, OSError):
        return str(path)


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------

def dump_json(document: Mapping[str, object]) -> str:
    """确定性序列化：无时间戳、紧凑分隔符 + 结尾换行。"""
    return json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n"


def render_stdout(document: Mapping[str, object],
                  timings: Mapping[str, float],
                  out_path: str | Path) -> Tuple[str, ...]:
    """人读摘要（报告里的数字都从这里抄）。"""
    coverage = document["coverage"]
    graph = document["graph"]
    lines: List[str] = []
    add = lines.append
    add(f"schema            : {document['schema']}")
    add(f"WordNet           : {document['source']['wordnet']['version']} "
        f"@ {document['source']['wordnet']['dataDir']}")
    add(f"CEFR              : "
        f"{coverage['cefrMembers'] + coverage['cefrWithoutFamily']:,} lemma"
        f"（frequency sha256 {document['source']['frequencyBands']['sha256'][:12]}…）")
    add("")
    add("== 图（全量 WordNet 派生图，不限 10k） ==")
    add(f"  节点 / 边        : {graph['nodes']:,} / {graph['edges']:,}")
    add(f"  原始指针          : {graph['rawPointers']:,}"
        f"（自指 {graph['selfPointers']:,}，多词 {graph['multiwordPointers']:,}，"
        f"大小写归一 {graph['caseAlteredPointers']:,}）")
    add(f"  边分类            : 10k–10k {graph['edgeClasses']['bothCefr']:,} / "
        f"跨边界 {graph['edgeClasses']['crossBoundary']:,} / "
        f"全在 10k 外 {graph['edgeClasses']['outsideOnly']:,}")
    add(f"  连通分量          : {graph['components']:,}"
        f"（其中 {graph['componentsWithoutCefr']:,} 个没有 10k 成员 → 不成族）")
    add(f"  多词桥接          : 排除 {graph['multiwordPairs']:,} 对；"
        f"若纳入会合并 "
        f"{graph['multiwordBridge']['componentsMergedIfIncluded']} 个单字分量")
    add("")
    add("== 词族（≥2 成员且 ≥1 个在 CEFR 10k） ==")
    add(f"  词族数            : {coverage['families']:,}")
    add(f"  成员总数          : {coverage['members']:,}"
        f"（10k 内 {coverage['cefrMembers']:,} / 10k 外 {coverage['outsideMembers']:,}）")
    add(f"  最大族 / 中位     : {coverage['maxFamilySize']} / {coverage['medianFamilySize']}")
    add(f"  10k 有族 / 无族   : {coverage['cefrMembers']:,}"
        f" / {coverage['cefrWithoutFamily']:,}"
        f"（覆盖率 {coverage['cefrCoveragePct']}%）")
    add(f"  含 ≥2 个 10k 成员: {coverage['familiesWithMultipleCefr']:,} 族")
    add("  族大小分布        : " + "、".join(
        f"{size}人×{count:,}" for size, count in sorted(
            ((int(key), value)
             for key, value in coverage["sizeDistribution"].items()))))
    add("")
    add("== 最大 10 族 ==")
    for item in document["topFamilies"]:
        add(f"  {item['id']} {item['head']:<12} {item['size']:>2}人"
            f"（10k {item['cefrMembers']}）: " + "、".join(item["members"]))
    add("")
    add("== 示例族 ==")
    for word in ("decide", "reflect", "judge", "critical", "comprehend"):
        example = document["examples"][word]
        if not example.get("family"):
            add(f"  {word:<12} 无族")
            continue
        members = "、".join(
            f"{member['w']}"
            + (f"({member['level']})" if member["level"] else "(10k外)")
            for member in example["members"])
        add(f"  {word:<12} {example['family']} {example['size']}人: {members}")
    add("")
    add("== 坏边（人工清单，已逐条校验存在） ==")
    by_category: Counter = Counter()
    by_group: Counter = Counter()
    for item in document["badEdges"]:
        by_category[item["category"]] += 1
        by_group[item["group"]] += 1
    add("  分类              : " + "、".join(
        f"{BAD_CATEGORIES[category]}={count}"
        for category, count in sorted(by_category.items())))
    add("  分组              : " + "、".join(
        f"{group}={count}" for group, count in sorted(by_group.items())))
    add(f"  命中词族          : {len(document['badEdgeFamilies'])} 个"
        f"（{', '.join(document['badEdgeFamilies'])}）")
    add(f"  良性词性转换      : {len(document['benignEdges'])} 条（不删）")
    add("")
    add("== 规则对比 ==")
    add(f"  {'规则':<30}{'边':>7}{'词族':>7}{'成员':>8}{'10k内':>8}"
        f"{'最大':>5}{'无族':>8}{'坏边':>5}{'含坏边族':>9}{'覆盖':>8}")
    for row in document["ruleComparison"]:
        add(f"  {row['key']}. {row['label']:<27}{row['edges']:>7}"
            f"{row['families']:>7}{row['members']:>8}{row['cefrMembers']:>8}"
            f"{row['maxFamilySize']:>5}{row['cefrWithoutFamily']:>8}"
            f"{row['badEdgesPresent']:>5}{row['familiesWithBadEdge']:>9}"
            f"{row['cefrCoveragePct']:>7}%")
    add("")
    add("== 建议 ==")
    add(f"  黑名单            : {len(document['blacklist']['edges'])} 条边"
        f"（semantic_split + clear_error；pos_conversion 保留）")
    add(f"  allowlist         : {len(document['allowlist']['edges'])} 条"
        f"（两侧都在 10k、WordNet 无该边）")
    add(f"  建议规则 E        : {document['recommended']['families']:,} 族 / "
        f"{document['recommended']['cefrMembers']:,} 个 10k 词 / "
        f"最大族 {document['recommended']['maxFamilySize']} / "
        f"坏边 {document['recommended']['badEdgesPresent']}")
    add("")
    add("== 无族词 ==")
    add(f"  数量              : {document['noFamily']['count']:,}"
        f"（{document['noFamily']['pct']}%）")
    add(f"  高频抽样          : {', '.join(document['noFamily']['sample'])}")
    add(f"  the 在任何族？     : {document['assertions']['theInAnyFamily']}")
    add(f"  at  在任何族？     : {document['assertions']['atInAnyFamily']}")
    add("")
    add("== 性能 ==")
    add("  " + "、".join(f"{key}={value}s" for key, value in timings.items()))
    add("")
    add(f"报告：{REPORT_PATH}")
    add(f"候选：{out_path}")
    return tuple(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="WordNet 3.0 开放词族审计（只读；P1-04）",
    )
    parser.add_argument("--frequency", default=str(DEFAULT_FREQUENCY),
                        help="CEFR 频表（默认 content/wordlist/frequency_bands.v1.json）")
    parser.add_argument("--lexicon", default=str(DEFAULT_LEXICON),
                        help="释义索引（只做只读哈希证明）")
    parser.add_argument("--wordnet-dir", default=str(DEFAULT_WORDNET_DIR),
                        help="NLTK 数据目录（默认 /tmp/nltk_data）")
    parser.add_argument("--out", default=str(DEFAULT_OUT),
                        help="候选 JSON 输出（默认 /tmp，不提交）")
    parser.add_argument("--json", action="store_true",
                        help="只输出机器可读摘要")
    parser.add_argument("--no-write", action="store_true",
                        help="只打印，不写候选 JSON")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    frequency_path = Path(args.frequency)
    lexicon_path = Path(args.lexicon)
    out_path = Path(args.out)

    try:
        cefr = load_cefr(frequency_path)
        hashes_before = {
            "frequency": file_sha256(frequency_path),
            "lexicon": file_sha256(lexicon_path) if lexicon_path.exists() else None,
        }
        provider = WordNetProvider(args.wordnet_dir)
        result = run_audit(cefr, provider, frequency_path=frequency_path,
                           lexicon_path=lexicon_path)
    except WordNetUnavailable as exc:
        print(f"[word-family-open-audit] WordNet 不可用：{exc}", file=sys.stderr)
        return 2
    except AuditError as exc:
        print(f"[word-family-open-audit] 审计失败：{exc}", file=sys.stderr)
        return 3

    hashes_after = {
        "frequency": file_sha256(frequency_path),
        "lexicon": file_sha256(lexicon_path) if lexicon_path.exists() else None,
    }
    if hashes_before != hashes_after:
        print("[word-family-open-audit] 输入文件在运行期间被改动，拒绝出报告",
              file=sys.stderr)
        return 4

    text = dump_json(result.document)
    written = 0
    if not args.no_write:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text, encoding="utf-8")
        written = len(text.encode("utf-8"))
    if args.json:
        print(text, end="")
    else:
        for line in render_stdout(result.document, result.timings, out_path):
            print(line)
        if written:
            print(f"已写入 {out_path}（{written:,} B）")
        else:
            print("未写盘（--no-write）")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
