"""CEFR 词族表（word family）只读服务（specs/041-word-family-list）。

数据来源（随仓库分发、运行期只读、无数据库、无迁移、不装 nltk/WordNet）：

- ``content/wordlist/word-families.v1.json``：规则 E 预生成的词族
  （WordNet 3.0 派生图 + 17 条黑名单坏边 + 22 条 allowlist 缺失边）。
  生成脚本 ``scripts/build_word_families.py``；文件带 ``integrity.sha256``。
- ``content/wordlists/lexicon.v1.json``：head 的 ``phonetic/translation``；
  复用 :func:`vocabulary.load_lexicon`。

口径（与审计报告 ``docs/reports/word-family-open-audit-2026-11-23.md`` 一致）：

- 行 = 族；每族 ≥2 成员且至少 1 个成员在 CEFR 10k；
- 10k 外成员 ``level/rank`` 为 ``None``（等级留空，UI 显示 ``—``）；
- 无族词（the/at 等）不写入数据，也不出现在任何响应里；
- ``q`` 匹配**任一成员**（大小写不敏感子串）；``level`` 命中族内任一成员；
- ``sort=rank``（默认，按 head 的 CEFR rank）/ ``alpha``（按 head 字母）。

参数非法（page/pageSize/level/sort/q 长度）→ 400；文件缺失/损坏/完整性失败
→ 503。游客可读、不调 AI、不写库。响应字段见 :func:`word_family_page`：

``{total, page, pageSize, hasMore, items:[{id, head, headRank, headLevel,
headPhonetic, headTranslation, levels, members:[{lemma, level, rank}]}]}``
"""
from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

import vocabulary

SCHEMA = "linguatrek.word-family.v1"
RULE_VERSION = "E"
INTEGRITY_SCOPE = "counts+families+blacklist+allowlist"
CEFR_LEVELS: Tuple[str, ...] = vocabulary.CEFR_LEVELS
SORTS: Tuple[str, ...] = ("rank", "alpha")
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200
MAX_QUERY_CHARS = vocabulary.MAX_QUERY_CHARS

# 模块级路径（测试用 monkeypatch 指向坏/缺失文件；不新增 config 项，
# 与 content/wordlist 的静态数据同仓分发）。
WORD_FAMILIES_PATH = str(
    Path(__file__).resolve().parents[1] / "content/wordlist/word-families.v1.json"
)


class WordFamilyError(Exception):
    """词族领域错误基类；路由层据此映射 HTTP 状态。"""

    status_code = 500


class WordFamilyUnavailable(WordFamilyError):
    """词族/释义文件缺失、损坏或完整性失败（503）。"""

    status_code = 503


class WordFamilyInvalid(WordFamilyError):
    """分页/搜索/等级/排序参数非法（400）。"""

    status_code = 400


@dataclass(frozen=True)
class FamilyMember:
    """族内一个词；10k 外成员 level/rank 均为 ``None``。"""

    lemma: str
    level: Optional[str]
    rank: Optional[int]


@dataclass(frozen=True)
class Family:
    """一行词族：head + 成员 + 等级集合（已按 CEFR 顺序）。"""

    id: str
    head: str
    head_rank: int
    head_level: str
    levels: Tuple[str, ...]
    members: Tuple[FamilyMember, ...]
    phonetic: str
    translation: str


@dataclass(frozen=True)
class FamilyIndex:
    """进程内只读索引：按 head rank 升序（文件顺序即 F0001…）。"""

    key: Tuple[str, Tuple[int, int]]
    families: Tuple[Family, ...]


_LOCK = threading.Lock()
_CACHE: Dict[Tuple[str, Tuple[int, int]], FamilyIndex] = {}


def reset_cache() -> None:
    """清空进程内索引缓存（测试/热更新用；生产只读，不调用）。"""
    with _LOCK:
        _CACHE.clear()


# ---------------------------------------------------------------------------
# 加载与校验
# ---------------------------------------------------------------------------

def _require(condition: bool, message: str) -> None:
    if not condition:
        raise WordFamilyUnavailable(message)


def _signature(path: Path) -> Tuple[int, int]:
    try:
        stat = path.stat()
    except OSError as exc:
        raise WordFamilyUnavailable(f"词族数据不存在或不可读：{path}") from exc
    return (stat.st_mtime_ns, stat.st_size)


def _payload_sha256(document: Mapping[str, object]) -> str:
    payload = {
        "counts": document.get("counts"),
        "families": document.get("families"),
        "blacklist": document.get("blacklist"),
        "allowlist": document.get("allowlist"),
    }
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _as_member(raw: object, family_id: str, levels: Sequence[str]) -> FamilyMember:
    _require(isinstance(raw, dict), f"{family_id}: 成员必须是对象")
    lemma = str(raw.get("lemma") or "").strip()
    _require(
        bool(lemma) and lemma == lemma.lower() and "_" not in lemma,
        f"{family_id}: 成员 lemma 非法：{raw!r}",
    )
    level = raw.get("level")
    rank = raw.get("rank")
    if level is None:
        _require(rank is None, f"{family_id}/{lemma}: 无等级成员必须 rank=null")
    else:
        _require(
            level in CEFR_LEVELS,
            f"{family_id}/{lemma}: 非法等级 {level!r}",
        )
        _require(
            isinstance(rank, int) and not isinstance(rank, bool) and rank >= 1,
            f"{family_id}/{lemma}: 10k 成员必须有正整数 rank",
        )
    return FamilyMember(
        lemma=lemma,
        level=level if isinstance(level, str) else None,
        rank=rank if isinstance(rank, int) and not isinstance(rank, bool) else None,
    )


def _parse_family(raw: object, expected_id: str) -> Family:
    _require(isinstance(raw, dict), f"families[{expected_id}] 必须是对象")
    family_id = str(raw.get("id") or "")
    _require(family_id == expected_id, f"families id 顺序/值不一致：{family_id}")
    head = str(raw.get("head") or "").strip()
    head_rank = raw.get("headRank")
    head_level = raw.get("headLevel")
    _require(bool(head), f"{family_id}: 缺少 head")
    _require(
        isinstance(head_rank, int) and not isinstance(head_rank, bool) and head_rank >= 1,
        f"{family_id}: headRank 非法",
    )
    _require(head_level in CEFR_LEVELS, f"{family_id}: headLevel 非法")

    raw_levels = raw.get("levels")
    _require(
        isinstance(raw_levels, list) and bool(raw_levels),
        f"{family_id}: levels 必须是非空数组",
    )
    levels = tuple(
        level for level in CEFR_LEVELS if level in set(raw_levels))
    _require(
        list(levels) == list(raw_levels)
        and all(level in CEFR_LEVELS for level in raw_levels),
        f"{family_id}: levels 必须是 CEFR 顺序的去重数组",
    )

    raw_members = raw.get("members")
    _require(
        isinstance(raw_members, list) and len(raw_members) >= 2,
        f"{family_id}: 成员必须 ≥2",
    )
    members = tuple(
        _as_member(member, family_id, levels) for member in raw_members
    )
    _require(
        any(member.level is not None for member in members),
        f"{family_id}: 必须有至少 1 个 CEFR 10k 成员",
    )
    first = members[0]
    _require(
        first.lemma == head and first.rank == head_rank and first.level == head_level,
        f"{family_id}: head 必须是 members[0]（10k 内 rank 最小者）",
    )
    member_levels = {member.level for member in members if member.level is not None}
    _require(
        set(levels) == member_levels,
        f"{family_id}: levels 与成员等级集合不一致",
    )
    return Family(
        id=family_id,
        head=head,
        head_rank=head_rank,
        head_level=head_level,
        levels=levels,
        members=members,
        phonetic="",
        translation="",
    )


def _validate_counts(document: Mapping[str, object], families: Sequence[Family]) -> None:
    counts = document.get("counts")
    _require(isinstance(counts, dict), "词族数据缺少 counts")
    members = sum(len(family.members) for family in families)
    cefr_members = sum(
        1 for family in families for member in family.members
        if member.level is not None
    )
    expected = {
        "families": len(families),
        "members": members,
        "cefrMembers": cefr_members,
        "outsideMembers": members - cefr_members,
        "maxFamilySize": max((len(family.members) for family in families), default=0),
        "blacklistEdges": len(document.get("blacklist") or []),
        "allowlistEdges": len(document.get("allowlist") or []),
    }
    for key, value in expected.items():
        _require(
            counts.get(key) == value,
            f"词族数据 counts.{key} 与内容不一致：{counts.get(key)!r} != {value!r}",
        )
    _require(
        isinstance(counts.get("cefrWithoutFamily"), int),
        "词族数据缺少 counts.cefrWithoutFamily",
    )


def _build_index(document: Mapping[str, object], *, key: Tuple[str, Tuple[int, int]]
                 ) -> FamilyIndex:
    path, signature = key
    _require(
        document.get("schema") == SCHEMA,
        f"词族数据 schema 不是 {SCHEMA}",
    )
    _require(bool(document.get("version")), "词族数据缺少 version")
    _require(
        document.get("ruleVersion") == RULE_VERSION,
        f"词族数据 ruleVersion 不是 {RULE_VERSION}（人工清单/构图规则变化需重新审阅）",
    )
    _require(bool(document.get("license")), "词族数据缺少 license")
    _require(isinstance(document.get("source"), dict), "词族数据缺少 source")
    _require(
        isinstance(document.get("blacklist"), list)
        and isinstance(document.get("allowlist"), list),
        "词族数据缺少 blacklist/allowlist（规则 E 溯源）",
    )
    integrity = document.get("integrity")
    _require(isinstance(integrity, dict), "词族数据缺少 integrity")
    _require(
        integrity.get("algorithm") == "sha256"
        and integrity.get("scope") == INTEGRITY_SCOPE,
        "词族数据 integrity 口径不符",
    )
    _require(
        integrity.get("sha256") == _payload_sha256(document),
        "词族数据完整性校验失败（integrity.sha256 不匹配）",
    )

    raw_families = document.get("families")
    _require(
        isinstance(raw_families, list) and bool(raw_families),
        "词族数据 families 必须是非空数组",
    )
    families: List[Family] = []
    seen_ids: set = set()
    for index, raw in enumerate(raw_families, start=1):
        family = _parse_family(raw, f"F{index:04d}")
        _require(family.id not in seen_ids, f"词族 id 重复：{family.id}")
        seen_ids.add(family.id)
        families.append(family)
    _validate_counts(document, families)

    # head 音标/释义来自释义索引；缺条目时留空，不编造。释义文件坏 → 503。
    try:
        lexicon = vocabulary.load_lexicon()
    except vocabulary.VocabularyUnavailable as exc:
        raise WordFamilyUnavailable(str(exc)) from exc
    families = [
        Family(
            id=family.id,
            head=family.head,
            head_rank=family.head_rank,
            head_level=family.head_level,
            levels=family.levels,
            members=family.members,
            phonetic=lexicon.entries.get(family.head.casefold(), ("", ""))[0],
            translation=lexicon.entries.get(family.head.casefold(), ("", ""))[1],
        )
        for family in families
    ]
    # 文件本身按 head rank 升序（F0001…）；显式排序防止手改数据后顺序漂移。
    families.sort(key=lambda family: (family.head_rank, family.head))
    return FamilyIndex(key=key, families=tuple(families))


def load_index() -> FamilyIndex:
    """返回进程内索引；首次调用构建（缺文件/坏数据 → 503）。"""
    path = Path(WORD_FAMILIES_PATH)
    signature = _signature(path)
    key = (str(path), signature)
    with _LOCK:
        cached = _CACHE.get(key)
        if cached is not None:
            return cached
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WordFamilyUnavailable(f"词族数据读取失败：{exc}") from exc
    if not isinstance(document, dict):
        raise WordFamilyUnavailable("词族数据必须是 JSON 对象")
    index = _build_index(document, key=key)
    with _LOCK:
        # 同一份数据并发首次构建时后写覆盖前写，两者内容等价，无副作用。
        _CACHE[key] = index
    return index


def warmup() -> None:
    """启动时预建索引（routes_vocabulary 导入即进程启动）。

    只读、幂等。数据缺失/损坏**不阻断应用启动**：索引留给请求期再试，
    由路由映射 503（与 /lists 的错误语义一致）。
    """
    try:
        load_index()
    except WordFamilyError:
        pass


# ---------------------------------------------------------------------------
# 查询
# ---------------------------------------------------------------------------

def _normalize_level(level: Optional[str]) -> Optional[str]:
    if level is None:
        return None
    value = str(level).strip().upper()
    if not value:
        return None
    if value not in CEFR_LEVELS:
        raise WordFamilyInvalid(
            "level 必须是 " + "/".join(CEFR_LEVELS) + " 之一。"
        )
    return value


def _normalize_sort(sort: Optional[str]) -> str:
    if sort is None:
        return "rank"
    value = str(sort).strip().lower()
    if not value:
        return "rank"
    if value not in SORTS:
        raise WordFamilyInvalid("sort 必须是 " + "/".join(SORTS) + " 之一。")
    return value


def _validate_paging(page: int, page_size: int) -> None:
    if not isinstance(page, int) or isinstance(page, bool) or page < 1:
        raise WordFamilyInvalid("page 必须是 ≥1 的整数。")
    if (
        not isinstance(page_size, int)
        or isinstance(page_size, bool)
        or not 1 <= page_size <= MAX_PAGE_SIZE
    ):
        raise WordFamilyInvalid(f"pageSize 必须在 1–{MAX_PAGE_SIZE} 之间。")


def word_family_page(
    page: int,
    page_size: int,
    query: Optional[str] = None,
    level: Optional[str] = None,
    sort: Optional[str] = None,
) -> Dict[str, object]:
    """``GET /api/vocabulary/word-families`` 的分页/搜索/等级/排序实现。

    - ``q``：大小写不敏感子串，匹配**族内任一成员**（含 10k 外成员）。
    - ``level``：A1/A2/B1/B2/C1；族内任一成员命中该级即返回（成员自身等级保留）。
    - ``sort``：``rank``（默认，head 词频升序）/ ``alpha``（head 字母序）。
    """
    _validate_paging(page, page_size)
    needle = (query or "").strip().casefold()
    if len(needle) > MAX_QUERY_CHARS:
        raise WordFamilyInvalid(f"q 最长 {MAX_QUERY_CHARS} 个字符。")
    normalized_level = _normalize_level(level)
    normalized_sort = _normalize_sort(sort)

    index = load_index()
    items: Sequence[Family] = index.families
    if normalized_level is not None:
        items = tuple(
            family for family in items
            if any(member.level == normalized_level for member in family.members)
        )
    if needle:
        items = tuple(
            family for family in items
            if any(needle in member.lemma for member in family.members)
        )
    if normalized_sort == "alpha":
        items = tuple(sorted(
            items, key=lambda family: (family.head, family.head_rank)))

    total = len(items)
    start = (page - 1) * page_size
    end = start + page_size
    page_items = items[start:end] if start < total else ()
    return {
        "total": total,
        "page": page,
        "pageSize": page_size,
        "hasMore": start + len(page_items) < total,
        "items": [
            {
                "id": family.id,
                "head": family.head,
                "headRank": family.head_rank,
                "headLevel": family.head_level,
                "headPhonetic": family.phonetic,
                "headTranslation": family.translation,
                "levels": list(family.levels),
                "members": [
                    {"lemma": member.lemma, "level": member.level,
                     "rank": member.rank}
                    for member in family.members
                ],
            }
            for family in page_items
        ],
    }
