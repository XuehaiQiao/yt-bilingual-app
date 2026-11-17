"""单词本词表服务：CEFR 频带 + GRE/CET4/CET6 考试词表 + 词级 CEFR 映射。

数据来源（都随仓库分发、运行期只读、无数据库、无迁移）：

- ``content/wordlist/frequency_bands.v1.json``：10,000 lemma 频表
  （wordfreq 3.1.1 数据，CC BY-SA 4.0），CEFR A1–C1 由累计秩锚点派生；
  复用 :func:`difficulty.load_wordlist` 的加载与完整性校验。
- ``content/wordlists/exam-bands.v1.json``：GRE / CET4 / CET6 索引，
  ``word -> [tagMask, rank]``，标签来自 ECDICT 官方 CSV 的 ``tag`` 列。
- ``content/wordlists/lexicon.v1.json``：上述词 + CEFR lemma 的
  ``word -> [phonetic, translation]`` 紧凑释义索引。

诚实口径
--------
- CEFR A1–C1 是**频带估计**，不是官方 CEFR 词表；C2 没有词表，目录里标
  ``available:false``，``/lists/cefr-c2`` 返回 404，不拿 GRE 冒充。
- 考试词表成员来自 ECDICT 的整理标签，不是考试机构官方发布；但**不是**
  用词频近似，因此 ``approximate:false``。若将来只能拿到频带数据，必须在
  产物 metadata 标 ``approximate:true`` 并写明「不是官方词表」。
- 词表条目的 ``cefrLevel`` 为 ``null`` 表示该词不在 10k CEFR 频表；展开
  显示时由 ``/api/vocabulary/level`` 统一给 ``C1+``。

错误语义（路由层映射）：文件缺失/损坏/完整性失败 → 503；词表 id 不存在
或 C2 未建模 → 404；分页/搜索/等级参数非法 → 400（FastAPI 的 Query 约束
错误为 422）。
"""
from __future__ import annotations

import bisect
import hashlib
import json
import os
import re
import threading
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

import config
import difficulty

SCHEMA_EXAM = "linguatrek.exam-bands.v1"
SCHEMA_LEXICON = "linguatrek.lexicon.v1"

CEFR_LEVELS: Tuple[str, ...] = ("A1", "A2", "B1", "B2", "C1")
CEFR_BEYOND = "C1+"
MAX_LEVEL_WORDS = 100
MAX_PAGE_SIZE = 200
DEFAULT_PAGE_SIZE = 50
MAX_QUERY_CHARS = 64
MAX_TOKEN_CHARS = 64

# 词表顺序按产品需求：CEFR A1–C2，然后 GRE / CET4 / CET6。
CEFR_LIST_IDS: Tuple[str, ...] = (
    "cefr-a1",
    "cefr-a2",
    "cefr-b1",
    "cefr-b2",
    "cefr-c1",
    "cefr-c2",
)
CEFR_LIST_LEVELS: Dict[str, str] = {
    "cefr-a1": "A1",
    "cefr-a2": "A2",
    "cefr-b1": "B1",
    "cefr-b2": "B2",
    "cefr-c1": "C1",
}
EXAM_LIST_IDS: Tuple[str, ...] = ("gre", "cet4", "cet6")
EXAM_LIST_TAGS: Dict[str, str] = {"gre": "gre", "cet4": "cet4", "cet6": "cet6"}
EXAM_LIST_LABELS: Dict[str, str] = {
    "gre": "GRE",
    "cet4": "CET-4",
    "cet6": "CET-6",
}
LIST_IDS: Tuple[str, ...] = CEFR_LIST_IDS + EXAM_LIST_IDS

TAG_BITS: Dict[str, int] = {"cet4": 1, "cet6": 2, "gre": 4}
CEFR_NOTICE = "content/wordlist/NOTICE.md"
EXAM_NOTICE = "content/wordlists/NOTICE.md"

EXAM_FILENAME = "exam-bands.v1.json"
LEXICON_FILENAME = "lexicon.v1.json"

_WORD_RE = re.compile(r"^[A-Za-z]+$")
_TOKEN_RE = re.compile(r"^[A-Za-z][A-Za-z'\-]*$")


class VocabularyError(Exception):
    """单词本领域错误基类；路由层据此映射 HTTP 状态。"""

    status_code = 500


class VocabularyUnavailable(VocabularyError):
    """词表文件缺失/损坏/完整性失败（503）。"""

    status_code = 503


class VocabularyNotFound(VocabularyError):
    """词表 id 不存在，或 C2 未建模（404）。"""

    status_code = 404


class VocabularyInvalid(VocabularyError):
    """参数非法（400）。"""

    status_code = 400


@dataclass(frozen=True)
class ExamBands:
    """运行期只读的考试词表索引。"""

    path: str
    signature: Tuple[int, int]
    version: str
    license: str
    notice: str
    counts: Mapping[str, int]
    tag_bits: Mapping[str, int]
    entries: Tuple[Tuple[str, int, int], ...]
    by_bit: Mapping[int, Tuple[Tuple[str, int, int], ...]]
    integrity: str


@dataclass(frozen=True)
class Lexicon:
    """运行期只读的词 → [phonetic, translation] 索引。"""

    path: str
    signature: Tuple[int, int]
    version: str
    license: str
    notice: str
    entries: Mapping[str, Tuple[str, str]]
    integrity: str


_CACHE_LOCK = threading.Lock()
_EXAM_CACHE: Dict[str, Tuple[Tuple[int, int], ExamBands]] = {}
_LEXICON_CACHE: Dict[str, Tuple[Tuple[int, int], Lexicon]] = {}
_ITEM_LOCK = threading.Lock()
_ITEM_CACHE: Dict[Tuple[Any, ...], Tuple[Dict[str, Any], ...]] = {}


# ---------------------------------------------------------------------------
# 路径与缓存
# ---------------------------------------------------------------------------

def data_dir() -> str:
    """词表目录：``VOCABULARY_DIR`` 优先，默认 ``content/wordlists``。"""
    return os.path.abspath(
        getattr(
            config,
            "VOCABULARY_DIR",
            os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "content", "wordlists"),
        )
    )


def exam_path() -> str:
    return os.path.join(data_dir(), EXAM_FILENAME)


def lexicon_path() -> str:
    return os.path.join(data_dir(), LEXICON_FILENAME)


def reset_cache() -> None:
    """清空词表/条目缓存（测试或换数据文件后调用）。"""
    with _CACHE_LOCK:
        _EXAM_CACHE.clear()
        _LEXICON_CACHE.clear()
    with _ITEM_LOCK:
        _ITEM_CACHE.clear()


def _signature(path: str, label: str) -> Tuple[int, int]:
    try:
        stat = os.stat(path)
    except OSError as exc:
        raise VocabularyUnavailable(
            f"{label}不存在：{path}（应由 scripts/build_word_lists.py 生成并随仓库分发）"
        ) from exc
    return (stat.st_mtime_ns, stat.st_size)


def _read_json(path: str, label: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            document = json.load(handle)
    except (OSError, ValueError) as exc:
        raise VocabularyUnavailable(f"{label}无法解析：{exc}") from exc
    if not isinstance(document, dict):
        raise VocabularyUnavailable(f"{label}不是 JSON 对象")
    return document


def _payload_sha256(payload: Any) -> str:
    material = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def _exam_payload_sha256(document: Mapping[str, Any]) -> str:
    return _payload_sha256(
        {
            "entries": document["entries"],
            "counts": document["counts"],
            "tagBits": document["tagBits"],
            "version": document["version"],
            "sourceCsvSha256": document["source"]["csvSha256"],
        }
    )


def _lexicon_payload_sha256(document: Mapping[str, Any]) -> str:
    return _payload_sha256(
        {
            "entries": document["entries"],
            "counts": document["counts"],
            "version": document["version"],
            "sourceCsvSha256": document["source"]["csvSha256"],
        }
    )


def _integrity_ok(document: Mapping[str, Any], expected: str) -> bool:
    integrity = document.get("integrity")
    return (
        isinstance(integrity, dict)
        and integrity.get("sha256") == expected
    )


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise VocabularyUnavailable(message)


# ---------------------------------------------------------------------------
# 考试词表 / 释义索引
# ---------------------------------------------------------------------------

def load_exam_bands() -> ExamBands:
    """加载并校验考试词表；缺失/损坏/哈希不符 → ``VocabularyUnavailable``。"""
    path = exam_path()
    signature = _signature(path, "考试词表")
    with _CACHE_LOCK:
        cached = _EXAM_CACHE.get(path)
        if cached is not None and cached[0] == signature:
            return cached[1]

    document = _read_json(path, "考试词表")
    _require(
        document.get("schema") == SCHEMA_EXAM,
        f"考试词表 schema 不是 {SCHEMA_EXAM}",
    )
    _require(bool(document.get("version")), "考试词表缺少 version")
    source = document.get("source")
    _require(isinstance(source, dict), "考试词表缺少 source")
    _require(
        isinstance(source.get("csvSha256"), str)
        and len(source.get("csvSha256", "")) == 64,
        "考试词表 source.csvSha256 缺失/格式不对",
    )
    _require(bool(document.get("license")), "考试词表缺少 license")
    _require(document.get("notice") == "NOTICE.md", "考试词表 notice 必须是 NOTICE.md")
    tag_bits = document.get("tagBits")
    _require(tag_bits == TAG_BITS, "考试词表 tagBits 与后端约定不一致")
    try:
        expected_integrity = _exam_payload_sha256(document)
    except (KeyError, TypeError, ValueError) as exc:
        raise VocabularyUnavailable(f"考试词表完整性字段缺失：{exc}") from exc
    _require(
        _integrity_ok(document, expected_integrity),
        "考试词表完整性校验失败（integrity.sha256 不匹配）",
    )

    raw_entries = document.get("entries")
    _require(isinstance(raw_entries, list) and bool(raw_entries), "考试词表 entries 必须是非空数组")
    entries: List[Tuple[str, int, int]] = []
    seen: set = set()
    counts = {tag: 0 for tag in TAG_BITS}
    by_bit: Dict[int, List[Tuple[str, int, int]]] = {bit: [] for bit in TAG_BITS.values()}
    for index, raw in enumerate(raw_entries):
        _require(
            isinstance(raw, list) and len(raw) == 3,
            f"考试词表 entries[{index}] 必须是 [word, tagMask, rank]",
        )
        word, mask, rank = raw
        _require(isinstance(word, str) and bool(_WORD_RE.fullmatch(word)),
                 f"考试词表 entries[{index}] word 非法")
        _require(isinstance(mask, int) and 1 <= mask <= 7,
                 f"考试词表 entries[{index}] tagMask 非法")
        _require(isinstance(rank, int) and 1 <= rank <= 999_999,
                 f"考试词表 entries[{index}] rank 非法")
        lower = word.lower()
        _require(lower not in seen, f"考试词表 word 重复：{word}")
        seen.add(lower)
        item = (word, mask, rank)
        entries.append(item)
        for tag, bit in TAG_BITS.items():
            if mask & bit:
                counts[tag] += 1
                by_bit[bit].append(item)
    counts["unique"] = len(entries)
    document_counts = document.get("counts")
    _require(
        isinstance(document_counts, dict)
        and all(document_counts.get(key) == value for key, value in counts.items()),
        "考试词表 counts 与 entries 不一致",
    )

    bands = ExamBands(
        path=path,
        signature=signature,
        version=str(document["version"]),
        license=str(document["license"]),
        notice=str(document["notice"]),
        counts=counts,
        tag_bits={str(key): int(value) for key, value in tag_bits.items()},
        entries=tuple(entries),
        by_bit={bit: tuple(items) for bit, items in by_bit.items()},
        integrity=expected_integrity,
    )
    with _CACHE_LOCK:
        _EXAM_CACHE[path] = (signature, bands)
    return bands


def load_lexicon() -> Lexicon:
    """加载并校验释义索引；缺失/损坏/哈希不符 → ``VocabularyUnavailable``。"""
    path = lexicon_path()
    signature = _signature(path, "释义索引")
    with _CACHE_LOCK:
        cached = _LEXICON_CACHE.get(path)
        if cached is not None and cached[0] == signature:
            return cached[1]

    document = _read_json(path, "释义索引")
    _require(
        document.get("schema") == SCHEMA_LEXICON,
        f"释义索引 schema 不是 {SCHEMA_LEXICON}",
    )
    _require(bool(document.get("version")), "释义索引缺少 version")
    source = document.get("source")
    _require(isinstance(source, dict), "释义索引缺少 source")
    _require(
        isinstance(source.get("csvSha256"), str)
        and len(source.get("csvSha256", "")) == 64,
        "释义索引 source.csvSha256 缺失/格式不对",
    )
    _require(bool(document.get("license")), "释义索引缺少 license")
    _require(document.get("notice") == "NOTICE.md", "释义索引 notice 必须是 NOTICE.md")
    try:
        expected_integrity = _lexicon_payload_sha256(document)
    except (KeyError, TypeError, ValueError) as exc:
        raise VocabularyUnavailable(f"释义索引完整性字段缺失：{exc}") from exc
    _require(
        _integrity_ok(document, expected_integrity),
        "释义索引完整性校验失败（integrity.sha256 不匹配）",
    )

    raw_entries = document.get("entries")
    _require(isinstance(raw_entries, dict) and bool(raw_entries), "释义索引 entries 必须是非空对象")
    entries: Dict[str, Tuple[str, str]] = {}
    for word, value in raw_entries.items():
        _require(
            isinstance(word, str) and bool(re.fullmatch(r"[a-z]+", word)),
            "释义索引键必须是小写纯字母",
        )
        _require(
            isinstance(value, list) and len(value) == 2
            and isinstance(value[0], str) and isinstance(value[1], str),
            f"释义索引 entries[{word}] 必须是 [phonetic, translation]",
        )
        entries[word] = (value[0], value[1])
    counts = document.get("counts")
    _require(
        isinstance(counts, dict) and counts.get("entries") == len(entries),
        "释义索引 counts.entries 与 entries 不一致",
    )

    lexicon = Lexicon(
        path=path,
        signature=signature,
        version=str(document["version"]),
        license=str(document["license"]),
        notice=str(document["notice"]),
        entries=entries,
        integrity=expected_integrity,
    )
    with _CACHE_LOCK:
        _LEXICON_CACHE[path] = (signature, lexicon)
    return lexicon


# ---------------------------------------------------------------------------
# CEFR 频表
# ---------------------------------------------------------------------------

def _load_wordlist() -> difficulty.Wordlist:
    try:
        return difficulty.load_wordlist()
    except difficulty.DifficultyUnavailable as exc:
        raise VocabularyUnavailable(f"CEFR 频表不可用：{exc}") from exc


def _cefr_ranges(wordlist: difficulty.Wordlist) -> List[Tuple[str, int, int]]:
    """锚点 → [(level, prev_cut, cut)]；缺级/乱序视为数据不可用。"""
    anchors = sorted(wordlist.anchors, key=lambda item: item[0])
    ranges: List[Tuple[str, int, int]] = []
    previous = 0
    seen: List[str] = []
    for cut, level in anchors:
        if level not in CEFR_LEVELS:
            continue
        if cut <= previous:
            raise VocabularyUnavailable("CEFR 频表锚点不是严格递增")
        ranges.append((level, previous, cut))
        previous = cut
        seen.append(level)
    if tuple(seen) != CEFR_LEVELS:
        raise VocabularyUnavailable(
            "CEFR 频表缺少 A1–C1 锚点（实际：" + ", ".join(seen) + "）"
        )
    return ranges


def _cefr_counts(wordlist: difficulty.Wordlist) -> Dict[str, int]:
    ranks = sorted(wordlist.ranks.values())
    counts: Dict[str, int] = {}
    for level, lower, upper in _cefr_ranges(wordlist):
        counts[level] = bisect.bisect_right(ranks, upper) - bisect.bisect_right(
            ranks, lower
        )
    return counts


def _level_for_word(wordlist: difficulty.Wordlist, word: str) -> Optional[str]:
    rank = wordlist.rank_of(word)
    if rank is None:
        return None
    return wordlist.level_for_rank(rank)


# ---------------------------------------------------------------------------
# 词表目录
# ---------------------------------------------------------------------------

def _cefr_entry(
    level: str,
    count: int,
    version: str,
    license_text: str,
) -> Dict[str, Any]:
    return {
        "id": f"cefr-{level.lower()}",
        "label": f"CEFR {level}",
        "count": count,
        "source": "wordfreq 3.1.1 → frequency_bands.v1.json",
        "license": license_text,
        "notice": CEFR_NOTICE,
        "approximate": True,
        "available": True,
        "version": version,
        "note": (
            "按 10k lemma 频表的累计秩映射（A1≤1k / A2≤2k / B1≤4k / B2≤7k / "
            "C1≤10k）；是频带估计，不是官方 CEFR 词表。"
        ),
    }


def _exam_entry(
    list_id: str,
    count: int,
    version: str,
    license_text: str,
) -> Dict[str, Any]:
    tag = EXAM_LIST_TAGS[list_id]
    return {
        "id": list_id,
        "label": EXAM_LIST_LABELS[list_id],
        "count": count,
        "source": f"ECDICT tag={tag}",
        "license": license_text,
        "notice": EXAM_NOTICE,
        "approximate": False,
        "available": True,
        "version": version,
        "note": (
            f"ECDICT 的 {tag} 标签（词表整理库，非考试机构官方发布）；"
            "按 ECDICT frq/bnc 频次排序；同一词可属于多个考试词表。"
        ),
    }


def list_catalog() -> List[Dict[str, Any]]:
    """``GET /api/vocabulary/lists`` 的数据（按产品顺序）。"""
    wordlist = _load_wordlist()
    exam = load_exam_bands()
    load_lexicon()  # 目录也要求释义索引存在，保证两个端点可用性一致
    cefr_counts = _cefr_counts(wordlist)
    catalog: List[Dict[str, Any]] = []

    for level in CEFR_LEVELS:
        catalog.append(
            _cefr_entry(
                level,
                cefr_counts.get(level, 0),
                wordlist.version,
                wordlist.license,
            )
        )
    catalog.append(
        {
            "id": "cefr-c2",
            "label": "CEFR C2",
            "count": 0,
            "source": None,
            "license": None,
            "notice": CEFR_NOTICE,
            "approximate": False,
            "available": False,
            "version": "",
            "note": "C2 未建模：没有可用 C2 词表；不拿 GRE 冒充 C2。",
        }
    )
    for list_id in EXAM_LIST_IDS:
        tag = EXAM_LIST_TAGS[list_id]
        catalog.append(
            _exam_entry(
                list_id,
                int(exam.counts.get(tag, 0)),
                exam.version,
                exam.license,
            )
        )
    return catalog


# ---------------------------------------------------------------------------
# 分页列表
# ---------------------------------------------------------------------------

def _build_cefr_items(
    level: str,
    wordlist: difficulty.Wordlist,
    lexicon: Lexicon,
) -> Tuple[Dict[str, Any], ...]:
    lower, upper = 0, 0
    for candidate, start, end in _cefr_ranges(wordlist):
        if candidate == level:
            lower, upper = start, end
            break
    ranked = sorted(
        (rank, lemma)
        for lemma, rank in wordlist.ranks.items()
        if lower < rank <= upper
    )
    items: List[Dict[str, Any]] = []
    for _rank, lemma in ranked:
        phonetic, translation = lexicon.entries.get(lemma, ("", ""))
        items.append(
            {
                "word": lemma,
                "phonetic": phonetic,
                "translation": translation,
                "cefrLevel": level,
            }
        )
    return tuple(items)


def _build_exam_items(
    list_id: str,
    exam: ExamBands,
    wordlist: difficulty.Wordlist,
    lexicon: Lexicon,
) -> Tuple[Dict[str, Any], ...]:
    tag = EXAM_LIST_TAGS[list_id]
    bit = exam.tag_bits[tag]
    items: List[Dict[str, Any]] = []
    for word, _mask, _rank in exam.by_bit.get(bit, ()):
        phonetic, translation = lexicon.entries.get(word.lower(), ("", ""))
        items.append(
            {
                "word": word,
                "phonetic": phonetic,
                "translation": translation,
                "cefrLevel": _level_for_word(wordlist, word),
            }
        )
    return tuple(items)


def _cached_items(
    list_id: str,
    wordlist: difficulty.Wordlist,
    lexicon: Lexicon,
    exam: Optional[ExamBands],
) -> Tuple[Dict[str, Any], ...]:
    key = (
        list_id,
        wordlist.path,
        wordlist.integrity,
        lexicon.integrity,
        exam.integrity if exam is not None else "",
    )
    with _ITEM_LOCK:
        cached = _ITEM_CACHE.get(key)
        if cached is not None:
            return cached
        if list_id in CEFR_LIST_LEVELS:
            items = _build_cefr_items(CEFR_LIST_LEVELS[list_id], wordlist, lexicon)
        else:
            if exam is None:
                raise VocabularyUnavailable("考试词表未加载")
            items = _build_exam_items(list_id, exam, wordlist, lexicon)
        _ITEM_CACHE[key] = items
        return items


def _filter_items(
    items: Sequence[Dict[str, Any]], query: str
) -> List[Dict[str, Any]]:
    """大小写不敏感搜索：前缀匹配优先，其次包含匹配，组内保持原顺序。"""
    needle = query.strip().casefold()
    if not needle:
        return list(items)
    prefix: List[Dict[str, Any]] = []
    contains: List[Dict[str, Any]] = []
    for item in items:
        word = str(item["word"]).casefold()
        if word.startswith(needle):
            prefix.append(item)
        elif needle in word:
            contains.append(item)
    return prefix + contains


def list_page(
    list_id: str,
    page: int,
    page_size: int,
    query: Optional[str] = None,
) -> Dict[str, Any]:
    """``GET /api/vocabulary/lists/{id}`` 的分页/搜索实现。"""
    if list_id == "cefr-c2":
        raise VocabularyNotFound("C2 未建模（available:false），没有可列出的词表。")
    if list_id not in LIST_IDS:
        raise VocabularyNotFound("词表不存在。")
    if page < 1 or page_size < 1 or page_size > MAX_PAGE_SIZE:
        raise VocabularyInvalid(
            f"page 必须 ≥1；pageSize 必须在 1–{MAX_PAGE_SIZE} 之间。"
        )
    q = (query or "").strip()
    if len(q) > MAX_QUERY_CHARS:
        raise VocabularyInvalid(f"q 最长 {MAX_QUERY_CHARS} 个字符。")

    wordlist = _load_wordlist()
    lexicon = load_lexicon()
    exam = None
    if list_id in EXAM_LIST_IDS:
        exam = load_exam_bands()
    items = _cached_items(list_id, wordlist, lexicon, exam)
    filtered = _filter_items(items, q)
    total = len(filtered)
    start = (page - 1) * page_size
    end = start + page_size
    page_items = filtered[start:end] if start < total else []
    return {
        "items": page_items,
        "total": total,
        "page": page,
        "pageSize": page_size,
        "hasMore": start + len(page_items) < total,
    }


# ---------------------------------------------------------------------------
# 词级 CEFR 等级
# ---------------------------------------------------------------------------

def _rank_for_level_token(
    wordlist: difficulty.Wordlist, token: str
) -> Optional[int]:
    """词级判级用的秩查找。

    无连字符时复用 ``difficulty`` 的 forms/缩略词折叠（running→run）；
    **连字符复合词不拆部件**——否则 ``state-of-the-art`` 会按 ``state``
    被判成 A1。复合词只查精确词/forms/后缀候选，查不到就是 C1+。
    """
    normalized = difficulty.normalize_token(token)
    if "-" not in normalized:
        return wordlist.rank_of(normalized)
    rank = wordlist.ranks.get(normalized)
    if rank is not None:
        return rank
    folded = wordlist.forms.get(normalized)
    if folded is not None:
        return wordlist.ranks.get(folded)
    for candidate in difficulty.candidate_lemmas(normalized):
        rank = wordlist.ranks.get(candidate)
        if rank is not None:
            return rank
        folded = wordlist.forms.get(candidate)
        if folded is not None and folded in wordlist.ranks:
            return wordlist.ranks[folded]
    return None


def level_for_words(words: Sequence[str]) -> Dict[str, Optional[str]]:
    """把词映射到 A1–C1 / C1+ / null。

    - 在 CEFR 10k 频表（含屈折 forms 折回 lemma）→ A1–C1；
    - 合法英文词但不在频表 → ``C1+``（**不查 ECDICT**，所以本地词典缺失时
      行为一致；在频表但不在词典仍按频表给 A1–C1；不在频表也不在词典同样
      ``C1+``）；
    - 非法 token（空、含数字/符号、超长）→ ``null``。

    响应键保留用户输入的大小写与词形；同一键重复时后者覆盖。
    """
    tokens = [str(word).strip() for word in words if str(word).strip()]
    if not tokens:
        raise VocabularyInvalid("words 不能为空。")
    if len(tokens) > MAX_LEVEL_WORDS:
        raise VocabularyInvalid(
            f"words 最多 {MAX_LEVEL_WORDS} 个（收到 {len(tokens)} 个）。"
        )
    wordlist = _load_wordlist()
    result: Dict[str, Optional[str]] = {}
    for token in tokens:
        if len(token) > MAX_TOKEN_CHARS or not _TOKEN_RE.fullmatch(token):
            result[token] = None
            continue
        rank = _rank_for_level_token(wordlist, token)
        result[token] = CEFR_BEYOND if rank is None else wordlist.level_for_rank(rank)
    return result
