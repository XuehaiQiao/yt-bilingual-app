#!/usr/bin/env python3
"""WordNet 3.0 词族（word family）审计 —— **只读**，不写应用数据、不调模型（P1-03）。

审计对象
--------
- ``content/wordlist/frequency_bands.v1.json``：CEFR 10,000 lemma（只读）
- ``content/wordlists/lexicon.v1.json``：``word → [phonetic, translation]``（只读，
  只用于给误合并候选补中文释义线索，不参与构图）
- WordNet 3.0 语料（系统 ``nltk`` 3.6.1；数据目录用 ``--wordnet-dir`` 指定，
  例如 ``/tmp/nltk_data``；**不随仓库分发、不提交数据文件**）

构图口径
--------
1. lemma 取频表原样，NFC + 小写；只查单词形（WordNet 多词 lemma 不参与）。
2. 对每个 10k lemma 的每个 synset 的 ``lemma.derivationally_related_forms()``
   建**无向**边；只有两侧都在 10k 内的边进入产品可用图（跨出链接单独计数）。
3. 连通分量 = 候选词族；head = 族内 rank 最小（频次最高）的 lemma；
   family id 按 head 的 rank 升序编号（``F0001`` ...）。
4. 单例（无 10k 内派生链接）不强行编族；映射里 family 为 ``null``。

误合并候选
----------
自动构图不会判断语义，因此「误合并候选」是**人工审阅清单**（脚本内置并校验
每条都真实存在于 WordNet 边/跨出链接中），分三类：语义已分化 / 词性转换 /
明显错误。报告只统计清单内条目，不把启发式当全量结论。

只读证明
--------
脚本只读两个 JSON，跑前跑后各算一次 SHA-256 并断言一致；唯一写盘是
``--out``（默认 ``/tmp/word-family-candidates.json``，不在仓库内）。

用法::

    python3 scripts/word_family_audit.py --wordnet-dir /tmp/nltk_data
    python3 scripts/word_family_audit.py --wordnet-dir /tmp/nltk_data --json
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import sys
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, FrozenSet, Iterable, List, Mapping, Optional
from typing import Sequence, Set, Tuple

SCHEMA = "linguatrek.word-family-audit.v1"
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FREQUENCY = REPO_ROOT / "content/wordlist/frequency_bands.v1.json"
DEFAULT_LEXICON = REPO_ROOT / "content/wordlists/lexicon.v1.json"
DEFAULT_OUT = Path("/tmp/word-family-candidates.json")
DEFAULT_WORDNET_DIR = Path("/tmp/nltk_data")
REPORT_PATH = "docs/reports/word-family-audit-2026-11-23.md"
CEFR_LEVELS: Tuple[str, ...] = ("A1", "A2", "B1", "B2", "C1")
DEFAULT_ANCHORS: Tuple[Tuple[int, str], ...] = (
    (1000, "A1"), (2000, "A2"), (4000, "B1"), (7000, "B2"), (10000, "C1"),
)

# 语义类别（报告里再翻中文；键保持稳定，便于 JSON/单测）。
SEMANTIC_SPLIT = "semantic_split"
POS_CONVERSION = "pos_conversion"
CLEAR_ERROR = "clear_error"
CATEGORY_LABELS: Mapping[str, str] = {
    SEMANTIC_SPLIT: "语义已分化",
    POS_CONVERSION: "词性转换",
    CLEAR_ERROR: "明显错误",
}

# 人工 allowlist：WordNet 3.0 数据缺失/不对称，但教学上明确同族的链接。
# 每条都要在报告里说明依据；这里只放“补回缺失边”，不改语义判断。
ALLOWLIST: Tuple[Tuple[str, str], ...] = (("reflect", "reflection"),)


class AuditError(RuntimeError):
    """审计前置条件不满足（文件结构/数据缺失）。"""


class WordNetUnavailable(AuditError):
    """找不到可用的 WordNet 3.0 语料（缺目录/缺 nltk）。"""


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def normalize_word(raw: object) -> str:
    """NFC + 去首尾空白 + 小写；空/None 返回空串（与 backend 词形口径一致）。"""
    text = unicodedata.normalize("NFC", str(raw if raw is not None else ""))
    return text.strip().lower()


def file_sha256(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def edge_key(first: str, second: str) -> FrozenSet[str]:
    return frozenset((first, second))


def parse_levels(anchors: Sequence[Tuple[int, str]]) -> Tuple[Tuple[int, str], ...]:
    ordered = tuple(sorted((int(cap), str(level).upper()) for cap, level in anchors))
    if not ordered:
        raise AuditError("cefr_anchors 为空，无法派生 CEFR 等级")
    return ordered


def level_for_rank(rank: int, anchors: Sequence[Tuple[int, str]]) -> str:
    for cap, level in anchors:
        if rank <= cap:
            return level
    return anchors[-1][1]


def level_index(level: str, anchors: Sequence[Tuple[int, str]]) -> int:
    for index, (_cap, name) in enumerate(anchors):
        if name == level:
            return index
    raise AuditError(f"未知 CEFR 等级：{level}")


def cjk_chars(text: str) -> Set[str]:
    return {char for char in (text or "") if "\u4e00" <= char <= "\u9fff"}


# ---------------------------------------------------------------------------
# 输入加载（只读）
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CefrInput:
    lemmas: Tuple[str, ...]
    ranks: Mapping[str, int]
    anchors: Tuple[Tuple[int, str], ...]
    sha256: str
    counts: Mapping[str, object]


@dataclass(frozen=True)
class LexiconInput:
    translations: Mapping[str, str]
    sha256: str
    counts: Mapping[str, object]


def load_cefr(path: str | Path) -> CefrInput:
    """读频表并校验结构；不改文件、不写缓存。"""
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
        anchors = parse_levels([
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


def load_lexicon(path: str | Path) -> LexiconInput:
    """读紧凑释义索引；只保留中文释义串（缺失 → ""）。"""
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    entries = document.get("entries") if isinstance(document, dict) else None
    if not isinstance(entries, dict):
        raise AuditError(f"{path}: 缺少 entries 对象")
    translations: Dict[str, str] = {}
    for word, value in entries.items():
        key = normalize_word(word)
        if not key or not isinstance(value, (list, tuple)) or len(value) < 2:
            continue
        translations[key] = str(value[1] or "")
    return LexiconInput(
        translations=translations,
        sha256=file_sha256(path),
        counts=dict(document.get("counts") or {}),
    )


# ---------------------------------------------------------------------------
# WordNet 适配层（懒加载；测试可在缺 nltk 的环境跑）
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Relation:
    source: str
    target: str
    synset: str
    pos: str


class WordNetProvider:
    """WordNet 3.0 派生关系提供者；数据目录必须显式存在，缺失时给可操作错误。"""

    def __init__(self, wordnet_dir: str | Path | None = None):
        self.wordnet_dir = str(wordnet_dir) if wordnet_dir else None
        self._base: Optional[Path] = None
        self._wn = None
        self._relations: Dict[str, Tuple[Relation, ...]] = {}
        self._pos: Dict[str, FrozenSet[str]] = {}
        self.version = "unknown"
        self.synsets_missing: List[str] = []
        # WordNet 同一 synset 会重复列出同一派生词（如 judge.n.01 里 judicial
        # 出现 3 次）；这里统计去重前的原始指针数，报告里区分口径。
        self.raw_pointer_count = 0
        if self.wordnet_dir:
            self._check_dir(Path(self.wordnet_dir).expanduser().resolve())
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
        self._prepare_base(root)

    def _load(self) -> None:
        try:
            import nltk  # noqa: F401  (延迟导入：无 nltk 环境也可测纯逻辑)
        except ImportError as exc:
            raise WordNetUnavailable(
                "系统 python3 缺少 nltk；请安装 nltk 3.6.1+ 并下载 wordnet，"
                "或用 --wordnet-dir 指向已有 WordNet 数据目录。"
            ) from exc
        if self._base is not None:
            base = str(self._base)
            if base not in nltk.data.path:
                nltk.data.path.insert(0, base)
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

    def _prepare_base(self, root: Path) -> None:
        self._base = root.parent if root.name == "corpora" else root

    def relations(self, lemma: str) -> Tuple[Relation, ...]:
        cached = self._relations.get(lemma)
        if cached is not None:
            return cached
        if self._wn is None:
            raise WordNetUnavailable("WordNet 尚未加载")
        result: List[Relation] = []
        seen: Set[Tuple[str, str, str]] = set()
        for synset in self._wn.synsets(lemma):
            for wordnet_lemma in synset.lemmas():
                if normalize_word(wordnet_lemma.name()) != lemma:
                    continue
                for related in wordnet_lemma.derivationally_related_forms():
                    self.raw_pointer_count += 1
                    target = normalize_word(related.name().replace("_", " "))
                    if not target:
                        continue
                    key = (target, synset.name(), synset.pos())
                    if key in seen:
                        continue
                    seen.add(key)
                    result.append(
                        Relation(lemma, target, synset.name(), synset.pos())
                    )
        ordered = tuple(sorted(result, key=lambda rel: (
            rel.target, rel.synset, rel.pos)))
        self._relations[lemma] = ordered
        return ordered

    def pos(self, word: str) -> FrozenSet[str]:
        cached = self._pos.get(word)
        if cached is not None:
            return cached
        if self._wn is None:
            raise WordNetUnavailable("WordNet 尚未加载")
        value = frozenset(synset.pos() for synset in self._wn.synsets(word))
        self._pos[word] = value
        return value

    def synset_count(self, word: str) -> int:
        if self._wn is None:
            raise WordNetUnavailable("WordNet 尚未加载")
        return len(self._wn.synsets(word))


# ---------------------------------------------------------------------------
# 图与连通分量
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Edge:
    a: str
    b: str
    relations: Tuple[Relation, ...]


@dataclass(frozen=True)
class RawLinks:
    links: Tuple[Relation, ...]
    no_synset: Tuple[str, ...]
    total_occurrences: int
    self_links: int
    multiword_links: int


def collect_links(lemmas: Sequence[str],
                  relations_of: Callable[[str], Iterable[Relation]],
                  synset_count: Optional[Callable[[str], int]] = None,
                  ) -> RawLinks:
    """收集 10k lemma 出发的全部单字派生链接（不区分目标是否在 10k 内）。"""
    links: List[Relation] = []
    no_synset: List[str] = []
    total = 0
    self_links = 0
    multiword = 0
    for lemma in lemmas:
        if synset_count is not None and synset_count(lemma) == 0:
            no_synset.append(lemma)
        for relation in relations_of(lemma):
            total += 1
            target = relation.target
            if target == lemma:
                self_links += 1
                continue
            if " " in target:
                multiword += 1
                continue
            links.append(relation)
    return RawLinks(
        links=tuple(links),
        no_synset=tuple(no_synset),
        total_occurrences=total,
        self_links=self_links,
        multiword_links=multiword,
    )


@dataclass
class Graph:
    lemmas: Tuple[str, ...]
    ranks: Mapping[str, int]
    edges: Dict[FrozenSet[str], Edge]
    dropped_links: int
    dropped_targets: Counter
    dropped_pairs: Set[Tuple[str, str]]
    dropped_relations: Dict[Tuple[str, str], Tuple[Relation, ...]]

    @property
    def edge_keys(self) -> Set[FrozenSet[str]]:
        return set(self.edges)


def build_graph(raw: RawLinks, lemmas: Sequence[str], ranks: Mapping[str, int],
                *, vocab_only: bool = True) -> Graph:
    """按 ``vocab_only`` 建无向边；跨出 10k 的链接只统计、不进图。"""
    relation_cache: Dict[FrozenSet[str], List[Relation]] = defaultdict(list)
    dropped_links = 0
    dropped_targets: Counter = Counter()
    dropped_pairs: Set[Tuple[str, str]] = set()
    dropped_relations: Dict[Tuple[str, str], List[Relation]] = defaultdict(list)
    for relation in raw.links:
        if relation.target not in ranks:
            dropped_links += 1
            dropped_targets[(relation.source, relation.target)] += 1
            dropped_pairs.add((relation.source, relation.target))
            dropped_relations[(relation.source, relation.target)].append(relation)
            if vocab_only:
                continue
        key = edge_key(relation.source, relation.target)
        relation_cache[key].append(relation)
    edges: Dict[FrozenSet[str], Edge] = {}
    for key in sorted(relation_cache, key=lambda item: tuple(sorted(item))):
        members = tuple(sorted(key))
        edge = Edge(
            a=members[0],
            b=members[1],
            relations=tuple(sorted(
                relation_cache[key],
                key=lambda rel: (rel.source, rel.synset, rel.pos, rel.target),
            )),
        )
        edges[key] = edge
    return Graph(
        lemmas=tuple(lemmas),
        ranks=ranks,
        edges=edges,
        dropped_links=dropped_links,
        dropped_targets=dropped_targets,
        dropped_pairs=dropped_pairs,
        dropped_relations={
            key: tuple(value) for key, value in dropped_relations.items()
        },
    )


class UnionFind:
    def __init__(self) -> None:
        self.parent: Dict[str, str] = {}
        self.rank: Dict[str, int] = {}

    def find(self, item: str) -> str:
        self.parent.setdefault(item, item)
        self.rank.setdefault(item, 0)
        root = item
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[item] != item:
            self.parent[item], item = root, self.parent[item]
        return root

    def union(self, first: str, second: str) -> None:
        root_a = self.find(first)
        root_b = self.find(second)
        if root_a == root_b:
            return
        rank_a = self.rank[root_a]
        rank_b = self.rank[root_b]
        if rank_a < rank_b:
            self.parent[root_a] = root_b
        elif rank_a > rank_b:
            self.parent[root_b] = root_a
        else:
            self.parent[root_b] = root_a
            self.rank[root_a] += 1


@dataclass(frozen=True)
class Family:
    id: str
    head: str
    members: Tuple[str, ...]
    size: int
    level: str


def build_families(graph: Graph,
                   anchors: Sequence[Tuple[int, str]]
                   ) -> Tuple[Tuple[Family, ...], Dict[str, Family]]:
    """连通分量 → 词族；只保留 ≥2 个 10k 成员的分量，按 head rank 编号。"""
    union = UnionFind()
    for edge in graph.edges.values():
        union.union(edge.a, edge.b)
    groups: Dict[str, List[str]] = defaultdict(list)
    for lemma in graph.lemmas:
        groups[union.find(lemma)].append(lemma)
    families: List[Family] = []
    for members in groups.values():
        if len(members) < 2:
            continue
        ordered = tuple(sorted(
            members, key=lambda word: (graph.ranks[word], word)))
        head = ordered[0]
        families.append(Family(
            id="",
            head=head,
            members=ordered,
            size=len(ordered),
            level=level_for_rank(graph.ranks[head], anchors),
        ))
    families.sort(key=lambda family: (graph.ranks[family.head], family.head))
    numbered = tuple(
        Family(
            id=f"F{index:04d}",
            head=family.head,
            members=family.members,
            size=family.size,
            level=family.level,
        )
        for index, family in enumerate(families, start=1)
    )
    by_member = {
        member: family for family in numbered for member in family.members
    }
    return numbered, by_member


def family_stats(families: Sequence[Family], total_lemmas: int) -> Dict[str, object]:
    covered = sum(family.size for family in families)
    sizes = Counter(family.size for family in families)
    # families 已按 head rank 升序；max 稳定返回第一个最大族。
    biggest = max(families, key=lambda family: family.size) if families else None
    return {
        "lemmas": total_lemmas,
        "lemmas_in_family": covered,
        "coverage_ratio": round(covered / total_lemmas, 4) if total_lemmas else 0.0,
        "families": len(families),
        "singletons": total_lemmas - covered,
        "max_family_size": biggest.size if biggest else 0,
        "max_family_id": biggest.id if biggest else None,
        "max_family_head": biggest.head if biggest else None,
        "size_distribution": {
            str(size): count for size, count in sorted(sizes.items())
        },
    }


def family_members(payload: Dict[str, object], word: str) -> List[str]:
    """调试辅助：从序列化 payload 里取成员（单测/报告核对用）。"""
    mapping = payload.get("mapping") or {}
    entry = mapping.get(word) if isinstance(mapping, dict) else None
    if not entry or not entry.get("family"):
        return [word]
    families = payload.get("families") or []
    for family in families:
        if family.get("id") == entry["family"]:
            return list(family.get("members") or [])
    return [word]


# ---------------------------------------------------------------------------
# 误合并候选（人工审阅清单）
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CuratedMerge:
    a: str
    b: str
    category: str
    note: str


# 审阅口径：这些都是 WordNet 3.0 里真实存在的派生边（或跨出边），
# 但按"教学词族"看，学习者无法由一边直接推出另一边。分类是人工判断，
# 不是自动分类器；追加条目必须同时改报告 §4。
CURATED_MERGES: Tuple[CuratedMerge, ...] = (
    CuratedMerge("critical", "crisis", SEMANTIC_SPLIT,
                 "adj 批评的/关键的 vs n 危机；链接走 critical.s.05"
                 "「being in or verging on a state of crisis」这一次要义项"),
    CuratedMerge("elect", "eligible", SEMANTIC_SPLIT,
                 "v 选举 vs a 有资格的；eligible 原义「可被选中的」，"
                 "现代学习者的主要释义已分化"),
    CuratedMerge("contain", "continent", SEMANTIC_SPLIT,
                 "v 包含 vs n 大陆；链接走 continent.a.01"
                 "「having control over urination」这一冷僻义项"),
    CuratedMerge("contain", "content", SEMANTIC_SPLIT,
                 "v 包含 vs n 内容/满足；链接走「可容纳的量」义项"),
    CuratedMerge("receive", "receptor", SEMANTIC_SPLIT,
                 "v 收到 vs n 受体/感受器；专业术语，不能由日常义推出"),
    CuratedMerge("commit", "committee", SEMANTIC_SPLIT,
                 "v 委托/犯罪 vs n 委员会；链接走 entrust「委托」义项"),
    CuratedMerge("major", "majority", SEMANTIC_SPLIT,
                 "a 主要的/主修 vs n 多数；链接走「数量更多」义项，"
                 "同 POS 但学习者难互推"),
    CuratedMerge("signify", "significant", SEMANTIC_SPLIT,
                 "v 表示 vs a 重要的；sign 族里 significant 的「重要」义"
                 "已不是「符号」义"),
    CuratedMerge("grave", "gravity", SEMANTIC_SPLIT,
                 "n 坟墓 vs n 重力；链接走 grave.s.03「严肃的」义项，"
                 "与 gravity 的物理义分离"),
    CuratedMerge("calculate", "calculus", SEMANTIC_SPLIT,
                 "v 计算 vs n 微积分/结石；专业义项，不能由 calculate 推出"),
    CuratedMerge("decide", "decision", POS_CONVERSION,
                 "v→n 决定；释义透明，属于可接受跨词性链接"),
    CuratedMerge("decide", "decisive", POS_CONVERSION,
                 "v→a 决定性的；释义透明，可接受"),
    CuratedMerge("reflect", "reflective", POS_CONVERSION,
                 "v→a 反射的/反映的；释义透明，可接受"),
    CuratedMerge("protect", "protective", POS_CONVERSION,
                 "v→a 保护的；释义透明，可接受"),
    CuratedMerge("differ", "difference", POS_CONVERSION,
                 "v→n 不同/差异；释义透明，可接受"),
    CuratedMerge("tow", "tower", CLEAR_ERROR,
                 "v 拖 vs n 塔；WordNet 在 tow.v.01 下挂 tower，"
                 "现代英语无派生关系（数据疑点）"),
    CuratedMerge("tie", "tier", CLEAR_ERROR,
                 "v 系/打平 vs n 层/等级；WordNet 用 tier「打平的人/"
                 "系东西的人」冷僻义，与常用义无关"),
    CuratedMerge("grade", "gradual", CLEAR_ERROR,
                 "n 年级/成绩 vs a 逐渐的；链接走 grade.n.03「坡度」→"
                 " gradual.a.02「不陡的」，不是现代派生关系"),
    CuratedMerge("judge", "adjudicate", CLEAR_ERROR,
                 "judge n/v vs adjudicate v 判决；adjudicate 不在 10k 内，"
                 "该链接被 10k 边界丢弃；若放开边界会把两词并族"),
)
CURATED_BY_PAIR: Mapping[FrozenSet[str], CuratedMerge] = {
    edge_key(item.a, item.b): item for item in CURATED_MERGES
}
CATEGORY_ORDER: Tuple[str, ...] = (SEMANTIC_SPLIT, POS_CONVERSION, CLEAR_ERROR)


def candidate_category(first: str, second: str) -> Optional[str]:
    """查人工清单里的分类；不在清单内 → None（未复核）。"""
    item = CURATED_BY_PAIR.get(edge_key(normalize_word(first),
                                        normalize_word(second)))
    return item.category if item else None


def collect_merge_candidates(graph: Graph, graph_pos: Mapping[str, FrozenSet[str]],
                             translations: Mapping[str, str],
                             ranks: Mapping[str, int],
                             anchors: Sequence[Tuple[int, str]],
                             by_member: Mapping[str, Family],
                             ) -> Tuple[List[Dict[str, object]], Dict[str, object]]:
    """把人工清单落成带特征的记录；清单里每条都必须能在图/跨出链接中找到。"""
    records: List[Dict[str, object]] = []
    missing: List[str] = []
    for item in CURATED_MERGES:
        first, second = normalize_word(item.a), normalize_word(item.b)
        key = edge_key(first, second)
        edge = graph.edges.get(key)
        in_graph = edge is not None
        dropped = (
            (first, second) in graph.dropped_pairs
            or (second, first) in graph.dropped_pairs
        )
        if not in_graph and not dropped:
            missing.append(f"{first}/{second}")
            continue
        pos_a = graph_pos.get(first, frozenset())
        pos_b = graph_pos.get(second, frozenset())
        same_pos = bool(pos_a & pos_b)
        shared_gloss = len(
            cjk_chars(translations.get(first, ""))
            & cjk_chars(translations.get(second, ""))
        )
        level_gap = 0
        if first in ranks and second in ranks:
            level_gap = abs(
                level_index(level_for_rank(ranks[first], anchors), anchors)
                - level_index(level_for_rank(ranks[second], anchors), anchors)
            )
        morph_ratio = round(
            difflib.SequenceMatcher(None, first, second).ratio(), 3)
        family = by_member.get(first) or by_member.get(second)
        evidence = []
        if edge is not None:
            for relation in edge.relations:
                evidence.append({
                    "from": relation.source,
                    "to": relation.target,
                    "synset": relation.synset,
                    "pos": relation.pos,
                })
        elif dropped:
            dropped_relations = (
                graph.dropped_relations.get((first, second))
                or graph.dropped_relations.get((second, first), ())
            )
            for relation in dropped_relations:
                evidence.append({
                    "from": relation.source,
                    "to": relation.target,
                    "synset": relation.synset,
                    "pos": relation.pos,
                })
        records.append({
            "a": first,
            "b": second,
            "category": item.category,
            "categoryLabel": CATEGORY_LABELS[item.category],
            "note": item.note,
            "inGraph": in_graph,
            "samePos": same_pos,
            "posA": sorted(pos_a),
            "posB": sorted(pos_b),
            "sharedGlossChars": shared_gloss,
            "levelGap": level_gap,
            "morphSimilarity": morph_ratio,
            "familyId": family.id if family else None,
            "familyHead": family.head if family else None,
            "evidence": evidence,
        })
    if missing:
        raise AuditError(
            "人工误合并清单中的词对不在 WordNet 图/跨出链接里（数据或清单漂移）："
            + "、".join(missing)
        )
    summary = {
        "total": len(records),
        "inGraph": sum(1 for row in records if row["inGraph"]),
        "droppedOnly": sum(1 for row in records if not row["inGraph"]),
        "byCategory": {
            category: {
                "label": CATEGORY_LABELS[category],
                "total": sum(1 for row in records if row["category"] == category),
                "inGraph": sum(
                    1 for row in records
                    if row["category"] == category and row["inGraph"]
                ),
            }
            for category in CATEGORY_ORDER
        },
        "affectedFamilies": sorted({
            row["familyId"] for row in records
            if row["familyId"] is not None and row["inGraph"]
        }),
        "badAffectedFamilies": sorted({
            row["familyId"] for row in records
            if row["familyId"] is not None and row["inGraph"]
            and row["category"] != POS_CONVERSION
        }),
        "droppedOnlyPairs": [
            f"{row['a']}/{row['b']}" for row in records if not row["inGraph"]
        ],
    }
    return records, summary


# ---------------------------------------------------------------------------
# 规则评估
# ---------------------------------------------------------------------------

def _component_sizes(edge_keys: Iterable[FrozenSet[str]],
                     lemmas: Sequence[str]) -> Tuple[List[int], UnionFind]:
    union = UnionFind()
    for key in edge_keys:
        members = tuple(key)
        if len(members) != 2:
            raise AuditError(f"边不是二元组：{sorted(key)}")
        union.union(members[0], members[1])
    sizes: Counter = Counter()
    for lemma in lemmas:
        sizes[union.find(lemma)] += 1
    return list(sizes.values()), union


def evaluate_edges(name: str, description: str,
                   edges: Mapping[FrozenSet[str], Edge],
                   graph: Graph,
                   by_member: Mapping[str, Family]) -> Dict[str, object]:
    """评估一条构图规则的覆盖与误合并候选存活情况。"""
    sizes, union = _component_sizes(edges.keys(), graph.lemmas)
    in_family = sum(size for size in sizes if size >= 2)
    families = sum(1 for size in sizes if size >= 2)
    max_size = max(sizes) if sizes else 0
    singletons = sum(1 for size in sizes if size == 1)
    covered = set()
    for key in edges:
        for word in key:
            if word in graph.ranks:
                covered.add(word)
    suspect_records = [
        item for item in CURATED_MERGES
        if edge_key(item.a, item.b) in edges
    ]
    roots = set()
    for item in suspect_records:
        for word in (normalize_word(item.a), normalize_word(item.b)):
            if word in graph.ranks:
                roots.add(union.find(word))
    suspect_families = sum(
        1 for root in roots if sum(
            1 for lemma in graph.lemmas if union.find(lemma) == root) >= 2
    )
    suspect_bad = [
        item for item in suspect_records if item.category != POS_CONVERSION
    ]
    bad_roots = set()
    for item in suspect_bad:
        for word in (normalize_word(item.a), normalize_word(item.b)):
            if word in graph.ranks:
                bad_roots.add(union.find(word))
    suspect_bad_families = sum(
        1 for root in bad_roots if sum(
            1 for lemma in graph.lemmas if union.find(lemma) == root) >= 2
    )
    return {
        "name": name,
        "description": description,
        "edges": len(edges),
        "lemmasWithLink": len(covered),
        "lemmasInFamily": in_family,
        "coverageRatio": round(in_family / len(graph.lemmas), 4),
        "families": families,
        "maxFamilySize": max_size,
        "singletons": singletons,
        "suspectEdges": len(suspect_records),
        "suspectBadEdges": len(suspect_bad),
        "suspectFamilies": suspect_families,
        "suspectBadFamilies": suspect_bad_families,
        "suspectPairs": [
            f"{item.a}/{item.b}" for item in suspect_records
        ],
    }


def _filter_edges(edges: Mapping[FrozenSet[str], Edge],
                  pos_map: Mapping[str, FrozenSet[str]],
                  *, same_pos: bool) -> Dict[FrozenSet[str], Edge]:
    if not same_pos:
        return dict(edges)
    filtered: Dict[FrozenSet[str], Edge] = {}
    for key, edge in edges.items():
        if pos_map.get(edge.a, frozenset()) & pos_map.get(edge.b, frozenset()):
            filtered[key] = edge
    return filtered


def _allowlist_edges(graph: Graph) -> Dict[FrozenSet[str], Edge]:
    added: Dict[FrozenSet[str], Edge] = {}
    for first, second in ALLOWLIST:
        key = edge_key(first, second)
        if key in graph.edges:
            continue
        if first not in graph.ranks or second not in graph.ranks:
            raise AuditError(f"allowlist 词不在 10k：{first}/{second}")
        added[key] = Edge(
            a=first if first < second else second,
            b=second if first < second else first,
            relations=(Relation(first, second, "allowlist", "manual"),),
        )
    return added


def _blocklist_keys() -> Set[FrozenSet[str]]:
    return {
        edge_key(item.a, item.b)
        for item in CURATED_MERGES
        if item.category in (SEMANTIC_SPLIT, CLEAR_ERROR)
    }


# ---------------------------------------------------------------------------
# 示例（指定词族）
# ---------------------------------------------------------------------------

def _edge_evidence(edge: Optional[Edge]) -> List[Dict[str, str]]:
    if edge is None:
        return []
    return [
        {
            "from": relation.source,
            "to": relation.target,
            "synset": relation.synset,
            "pos": relation.pos,
        }
        for relation in edge.relations
    ]


def describe_words(graph: Graph,
                   by_member: Mapping[str, Family],
                   words: Sequence[str]) -> Dict[str, object]:
    result: Dict[str, object] = {
        "query": list(words),
        "sameFamily": False,
        "family": None,
        "words": {},
    }
    families_by_id = {
        by_member[word].id: by_member[word]
        for word in words if word in by_member
    }
    if len(families_by_id) == 1 and all(word in by_member for word in words):
        family = next(iter(families_by_id.values()))
        result["sameFamily"] = True
        result["family"] = {
            "id": family.id,
            "head": family.head,
            "size": family.size,
            "members": list(family.members),
        }
    for first in words:
        item: Dict[str, object] = {
            "inVocabulary": first in graph.ranks,
            "rank": graph.ranks.get(first),
            "familyId": by_member[first].id if first in by_member else None,
            "familyHead": by_member[first].head if first in by_member else None,
            "familyMembers": (
                list(by_member[first].members) if first in by_member else [first]
            ),
            "relations": [],
        }
        for second in words:
            if first >= second:
                continue
            edge = graph.edges.get(edge_key(first, second))
            item["relations"].append({
                "with": second,
                "linked": edge is not None,
                "evidence": _edge_evidence(edge),
            })
        result["words"][first] = item
    return result


# ---------------------------------------------------------------------------
# 审计主流程
# ---------------------------------------------------------------------------

def audit(frequency_path: str | Path = DEFAULT_FREQUENCY,
          lexicon_path: str | Path = DEFAULT_LEXICON,
          wordnet_dir: str | Path | None = DEFAULT_WORDNET_DIR,
          *, provider: Optional[WordNetProvider] = None,
          ) -> Dict[str, object]:
    """执行完整审计并返回可 JSON 序列化的 payload；不写仓库文件。"""
    cefr = load_cefr(frequency_path)
    lexicon = load_lexicon(lexicon_path)
    provider = provider or WordNetProvider(wordnet_dir)

    raw = collect_links(
        cefr.lemmas, provider.relations,
        synset_count=provider.synset_count,
    )
    graph = build_graph(raw, cefr.lemmas, cefr.ranks, vocab_only=True)
    full_graph = build_graph(raw, cefr.lemmas, cefr.ranks, vocab_only=False)

    families, by_member = build_families(graph, cefr.anchors)
    stats = family_stats(families, len(cefr.lemmas))

    # 按 CEFR 等级拆覆盖率（只统计进族成员；单例不算覆盖）。
    level_totals: Counter = Counter(
        level_for_rank(cefr.ranks[word], cefr.anchors) for word in cefr.lemmas
    )
    level_covered: Counter = Counter(
        level_for_rank(cefr.ranks[word], cefr.anchors)
        for family in families for word in family.members
    )
    by_level = {
        level: {
            "lemmas": level_totals[level],
            "inFamily": level_covered[level],
            "coverageRatio": round(
                level_covered[level] / level_totals[level], 4
            ) if level_totals[level] else 0.0,
        }
        for _cap, level in cefr.anchors
    }
    # 跨级词族：同一族跨 A1–C1 时，产品需要决定是否按用户等级过滤展示。
    level_set_distribution: Counter = Counter()
    mixed_level = 0
    spanning_three = 0
    for family in families:
        family_levels = {
            level_for_rank(cefr.ranks[member], cefr.anchors)
            for member in family.members
        }
        level_set_distribution[len(family_levels)] += 1
        if len(family_levels) > 1:
            mixed_level += 1
        if len(family_levels) >= 3:
            spanning_three += 1
    family_levels_summary = {
        "familiesWithMixedLevels": mixed_level,
        "familiesSpanning3PlusLevels": spanning_three,
        "levelSetDistribution": {
            str(count): number
            for count, number in sorted(level_set_distribution.items())
        },
    }

    # 候选误合并：先确保外部端点也有 POS。
    needed_words = set(cefr.lemmas)
    for source_graph in (graph, full_graph):
        for edge in source_graph.edges.values():
            needed_words.update((edge.a, edge.b))
    for item in CURATED_MERGES:
        needed_words.update((normalize_word(item.a), normalize_word(item.b)))
    pos_map = {word: provider.pos(word) for word in sorted(needed_words)}
    merge_records, merge_summary = collect_merge_candidates(
        graph, pos_map, lexicon.translations, cefr.ranks, cefr.anchors,
        by_member,
    )

    # 规则对比。
    allow = _allowlist_edges(graph)
    block = _blocklist_keys()
    recommended = {
        key: edge for key, edge in graph.edges.items() if key not in block
    }
    recommended.update(allow)
    variants = [
        ("A_10k", "仅保留两侧都在 10k 的链接（基线）", graph.edges),
        ("B_10k_same_pos", "10k 内 + 两 lemma 至少共享一个 POS",
         _filter_edges(graph.edges, pos_map, same_pos=True)),
        ("C_full", "放开 10k 边界（任意一端可跨出；诊断用）",
         full_graph.edges),
        ("D_full_same_pos", "放开边界 + 同 POS",
         _filter_edges(full_graph.edges, pos_map, same_pos=True)),
        ("E_10k_allowlist", "10k 内 + 人工 allowlist（补 WordNet 缺边）",
         {**graph.edges, **allow}),
        ("F_recommended", "10k 内 + allowlist − 人工黑名单（建议）",
         recommended),
    ]
    rules = [
        evaluate_edges(name, description, edges, graph, by_member)
        for name, description, edges in variants
    ]

    examples = {
        "decide_decision_decisive": describe_words(
            graph, by_member, ("decide", "decision", "decisive")),
        "reflect_reflection_reflective": describe_words(
            graph, by_member, ("reflect", "reflection", "reflective")),
        "critical_crisis": describe_words(
            graph, by_member, ("critical", "crisis")),
        "judge_adjudicate": describe_words(
            graph, by_member, ("judge", "adjudicate")),
    }

    dropped_examples = [
        {"source": source, "target": target, "count": count}
        for (source, target), count in sorted(
            graph.dropped_targets.items(),
            key=lambda item: (-item[1], item[0][0], item[0][1]),
        )[:30]
    ]

    # 映射：全部 10k 都给出（无族 → null），便于产品侧判断覆盖。
    mapping = {}
    for lemma in cefr.lemmas:
        family = by_member.get(lemma)
        mapping[lemma] = {
            "family": family.id if family else None,
            "head": family.head if family else None,
            "size": family.size if family else 1,
        }

    payload: Dict[str, object] = {
        "schema": SCHEMA,
        "inputs": {
            "frequency": {
                "path": str(frequency_path),
                "sha256": cefr.sha256,
                "lemmas": len(cefr.lemmas),
                "anchors": [
                    {"maxRank": cap, "level": level}
                    for cap, level in cefr.anchors
                ],
                "counts": dict(cefr.counts),
            },
            "lexicon": {
                "path": str(lexicon_path),
                "sha256": lexicon.sha256,
                "entries": len(lexicon.translations),
                "counts": dict(lexicon.counts),
            },
            "wordnet": {
                "version": provider.version,
                "dataDir": provider.wordnet_dir or "(nltk 默认路径)",
                "nltk": "nltk 3.6.1（运行时）",
                "license": "WordNet 3.0 License（Princeton University，BSD 风格）",
                "source": "https://wordnet.princeton.edu/",
            },
        },
        "graph": {
            "wordnetRawPointers": provider.raw_pointer_count,
            "rawLinkOccurrences": raw.total_occurrences,
            "singleWordLinks": len(raw.links),
            "selfLinks": raw.self_links,
            "multiwordLinks": raw.multiword_links,
            "noSynsetLemmas": len(raw.no_synset),
            "noSynsetExamples": list(raw.no_synset[:12]),
            "inVocabEdges": len(graph.edges),
            "inVocabLinkOccurrences": sum(
                1 for relation in raw.links
                if relation.target in cefr.ranks
            ),
            "droppedLinks": graph.dropped_links,
            "droppedTargets": len({target for _source, target
                                   in graph.dropped_targets}),
            "droppedTargetExamples": dropped_examples,
        },
        "coverage": {
            **stats,
            "byLevel": by_level,
            "familyLevels": family_levels_summary,
        },
        "examples": examples,
        "mergeCandidates": {
            "method": "人工审阅清单（WordNet 边/跨出边逐条校验），"
                      "非自动全量分类；分类为语义判断。",
            "summary": merge_summary,
            "items": merge_records,
        },
        "rules": rules,
        "allowlist": [
            {
                "a": first,
                "b": second,
                "reason": "WordNet 3.0 中 reflection 的 8 个 synset 均无 "
                          "derivationally_related_forms 指针，reflect 侧也只挂 "
                          "reflective/reflector；按教学词族补回。",
            }
            for first, second in ALLOWLIST
        ],
        "families": [
            {
                "id": family.id,
                "head": family.head,
                "level": family.level,
                "size": family.size,
                "members": list(family.members),
            }
            for family in families
        ],
        "mapping": mapping,
        "reproduce": (
            "python3 scripts/word_family_audit.py "
            "--wordnet-dir /tmp/nltk_data"
        ),
    }

    # 只读证明：处理完再算一次 SHA-256，必须与读入时一致。
    frequency_after = file_sha256(frequency_path)
    lexicon_after = file_sha256(lexicon_path)
    payload["integrity"] = {
        "frequency": {
            "before": cefr.sha256,
            "after": frequency_after,
            "unchanged": cefr.sha256 == frequency_after,
        },
        "lexicon": {
            "before": lexicon.sha256,
            "after": lexicon_after,
            "unchanged": lexicon.sha256 == lexicon_after,
        },
        "repoFilesWritten": [],
    }
    if frequency_after != cefr.sha256 or lexicon_after != lexicon.sha256:
        raise AuditError("只读校验失败：输入文件 SHA-256 在审计期间发生变化")
    return payload


def summary_payload(payload: Mapping[str, object]) -> Dict[str, object]:
    """CLI ``--json`` 的紧凑视图（不含 10k mapping / 全量词族）。"""
    coverage = payload["coverage"]
    return {
        "schema": payload["schema"],
        "inputs": payload["inputs"],
        "graph": payload["graph"],
        "coverage": coverage,
        "examples": payload["examples"],
        "mergeCandidates": payload["mergeCandidates"]["summary"],
        "rules": payload["rules"],
        "allowlist": payload["allowlist"],
        "integrity": payload["integrity"],
        "reproduce": payload["reproduce"],
    }


# ---------------------------------------------------------------------------
# 文本渲染 / CLI
# ---------------------------------------------------------------------------

def render_text(payload: Mapping[str, object]) -> str:
    coverage = payload["coverage"]
    graph = payload["graph"]
    merges = payload["mergeCandidates"]["summary"]
    lines = [
        f"WordNet 3.0 词族审计（{payload['schema']}）",
        f"WordNet {payload['inputs']['wordnet']['version']}；"
        f"10k lemma = {coverage['lemmas']}",
        f"WordNet 原始指针 {graph['wordnetRawPointers']}；按 "
        f"(source,target,synset,pos) 去重后 {graph['rawLinkOccurrences']} "
        f"（自指 {graph['selfLinks']} / 多词 {graph['multiwordLinks']}）",
        f"单字链接 {graph['singleWordLinks']} 条，其中 10k 内 "
        f"{graph['inVocabLinkOccurrences']} 条 → {graph['inVocabEdges']} 条无向边；"
        f"跨出 {graph['droppedLinks']} 条（{graph['droppedTargets']} 个目标词）",
        f"有 10k 内派生链接的 lemma：{coverage['lemmas_in_family']} / "
        f"{coverage['lemmas']}（{coverage['coverage_ratio']:.1%}）",
        f"词族（≥2）：{coverage['families']}；最大族 "
        f"{coverage['max_family_size']}（{coverage['max_family_head']}）；"
        f"单例 {coverage['singletons']}",
        f"误合并候选（人工清单）：{merges['total']} 条 "
        f"（图内 {merges['inGraph']} / 仅跨出 {merges['droppedOnly']}）；"
        + "，".join(
            f"{row['label']} {row['total']}"
            for row in merges["byCategory"].values()
        ),
        "规则对比（保留边 / 进族 lemma / 词族 / 单例 / 候选存活）：",
    ]
    for rule in payload["rules"]:
        lines.append(
            f"  {rule['name']}: {rule['edges']} / "
            f"{rule['lemmasInFamily']} / {rule['families']} / "
            f"{rule['singletons']} / {rule['suspectEdges']}"
        )
    decide = payload["examples"]["decide_decision_decisive"]
    reflect = payload["examples"]["reflect_reflection_reflective"]
    lines.append(
        "指定词族：decide/decision/decisive "
        f"{'同族' if decide['sameFamily'] else '不同族'}"
        f"（{decide['family']['members'] if decide['family'] else []}）"
    )
    lines.append(
        "指定词族：reflect/reflection/reflective "
        f"{'同族' if reflect['sameFamily'] else '不同族'}"
        f"（reflection 单独）"
    )
    lines.append(
        f"只读：frequency {payload['integrity']['frequency']['unchanged']}，"
        f"lexicon {payload['integrity']['lexicon']['unchanged']}"
    )
    lines.append(f"候选映射：{DEFAULT_OUT}")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="CEFR 10k × WordNet 3.0 词族只读审计（不写数据、不调模型）",
    )
    parser.add_argument(
        "--frequency", default=str(DEFAULT_FREQUENCY),
        help="频表 JSON（默认仓库 content/wordlist/frequency_bands.v1.json）")
    parser.add_argument(
        "--lexicon", default=str(DEFAULT_LEXICON),
        help="释义索引 JSON（默认仓库 content/wordlists/lexicon.v1.json）")
    parser.add_argument(
        "--wordnet-dir", default=str(DEFAULT_WORDNET_DIR),
        help="NLTK 数据目录（默认 /tmp/nltk_data）")
    parser.add_argument(
        "--out", default=str(DEFAULT_OUT),
        help="候选 word→family 映射输出路径（默认 /tmp/word-family-candidates.json）")
    parser.add_argument("--json", action="store_true", help="输出紧凑 JSON 摘要")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        payload = audit(
            frequency_path=args.frequency,
            lexicon_path=args.lexicon,
            wordnet_dir=args.wordnet_dir,
        )
    except (AuditError, json.JSONDecodeError, OSError) as exc:
        print(f"[word-family-audit] 失败：{exc}", file=sys.stderr)
        return 2
    output = Path(args.out)
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except OSError as exc:
        print(f"[word-family-audit] 无法写入 {output}：{exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(summary_payload(payload), ensure_ascii=False, indent=2))
    else:
        print(render_text(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
