"""CEFR 10k 词形表（lemma list）只读服务（specs/040-cefr-lemma-list）。

数据来源（随仓库分发、运行期只读、无数据库、无迁移）：

- ``content/wordlist/frequency_bands.v1.json``：10,000 个 ``[lemma, rank]``
  与 10,848 条 ``form → lemma`` 映射，CEFR A1–C1 由累计秩锚点派生；
  复用 :func:`difficulty.load_wordlist` 的加载与完整性校验（单一事实源）。
- ``content/wordlists/lexicon.v1.json``：``word → [phonetic, translation]``
  紧凑释义索引；复用 :func:`vocabulary.load_lexicon`。

本模块**只**用上面两个文件组索引：不做 ECDICT 推断、不合并别的词表、
不写用户数据、不调模型。lemma 口径以频表原样为准（词形 → 其映射的 lemma），
避免 ECDICT exchange 带来的错标/歧义（P1-01 审计结论）。

索引第一次请求时构建并缓存到进程内（只读、线程安全）；文件被替换/损坏时
由底层 loader 抛 503，不会带着半份索引继续服务。响应字段见
:func:`lemma_list_page`：

``{total, page, pageSize, hasMore, items:[{lemma, rank, level, phonetic,
translation, forms:[form…]}]}``

参数非法（page/pageSize/level/sort/q 长度）→ 400。
"""
from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

import difficulty
import vocabulary

CEFR_LEVELS: Tuple[str, ...] = vocabulary.CEFR_LEVELS
SORTS: Tuple[str, ...] = ("rank", "alpha")
DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200
MAX_QUERY_CHARS = vocabulary.MAX_QUERY_CHARS * 1  # 与 /lists 的 q 上限一致（64）
# 搜索 haystack 的分隔符：lemma 与各词形之间不再互相拼成假子串。
_SEARCH_SEP = "\x00"


class LemmaListError(Exception):
    """词形表领域错误基类；路由层据此映射 HTTP 状态。"""

    status_code = 500


class LemmaListUnavailable(LemmaListError):
    """频表/释义文件缺失、损坏或完整性失败（503）。"""

    status_code = 503


class LemmaListInvalid(LemmaListError):
    """分页/搜索/等级/排序参数非法（400）。"""

    status_code = 400


@dataclass(frozen=True)
class LemmaEntry:
    """一个 lemma 的只读展示字段（forms 已按字母序）。"""

    lemma: str
    rank: int
    level: str
    phonetic: str
    translation: str
    forms: Tuple[str, ...]
    # lemma + 全部词形的小写检索串（NUL 分隔，避开跨边界假子串）。
    haystack: str


@dataclass(frozen=True)
class LemmaIndex:
    """进程内只读索引：频表 + 释义，按 rank 升序。"""

    key: Tuple[str, str, str]
    entries: Tuple[LemmaEntry, ...]
    by_lemma: Mapping[str, LemmaEntry]


_INDEX_LOCK = threading.Lock()
_INDEX_CACHE: Dict[Tuple[str, str, str], LemmaIndex] = {}


def reset_cache() -> None:
    """清空进程内索引缓存（测试/热更新用；生产只读，不调用）。"""
    with _INDEX_LOCK:
        _INDEX_CACHE.clear()


def _build_index(
    wordlist: difficulty.Wordlist,
    lexicon: vocabulary.Lexicon,
) -> LemmaIndex:
    forms_by_lemma: Dict[str, List[str]] = {}
    for form, lemma in wordlist.forms.items():
        forms_by_lemma.setdefault(lemma, []).append(form)

    entries: List[LemmaEntry] = []
    for lemma, rank in wordlist.ranks.items():
        forms = tuple(sorted(forms_by_lemma.get(lemma, ())))
        phonetic, translation = lexicon.entries.get(lemma.casefold(), ("", ""))
        haystack = _SEARCH_SEP.join((lemma.casefold(), *(form.casefold() for form in forms)))
        entries.append(
            LemmaEntry(
                lemma=lemma,
                rank=rank,
                level=wordlist.level_for_rank(rank),
                phonetic=phonetic,
                translation=translation,
                forms=forms,
                haystack=haystack,
            )
        )
    # rank 是频表唯一的稳定顺序；alpha 排序只改变展示顺序，不改变 total。
    entries.sort(key=lambda entry: (entry.rank, entry.lemma))
    return LemmaIndex(
        key=(wordlist.path, wordlist.integrity, lexicon.integrity),
        entries=tuple(entries),
        by_lemma={entry.lemma: entry for entry in entries},
    )


def load_index() -> LemmaIndex:
    """返回进程内索引；首次调用构建（底层 loader 失败 → 503）。"""
    try:
        wordlist = difficulty.load_wordlist()
        lexicon = vocabulary.load_lexicon()
    except (difficulty.DifficultyUnavailable, vocabulary.VocabularyUnavailable) as exc:
        raise LemmaListUnavailable(str(exc)) from exc
    key = (wordlist.path, wordlist.integrity, lexicon.integrity)
    with _INDEX_LOCK:
        cached = _INDEX_CACHE.get(key)
        if cached is not None:
            return cached
    index = _build_index(wordlist, lexicon)
    with _INDEX_LOCK:
        # 同一份数据并发首次构建时后写覆盖前写，两者内容等价，无副作用。
        _INDEX_CACHE[key] = index
    return index


def warmup() -> None:
    """启动时预建索引（routes_vocabulary 导入即进程启动）。

    只读、幂等。数据缺失/损坏**不阻断应用启动**：索引留给请求期再试，
    由路由映射 503（与 /lists 的错误语义一致）。
    """
    try:
        load_index()
    except LemmaListError:
        pass


def _normalize_level(level: Optional[str]) -> Optional[str]:
    """空 → 不筛选；A1–C1（大小写不敏感）；其余 400（C2 未建模）。"""
    if level is None:
        return None
    value = str(level).strip().upper()
    if not value:
        return None
    if value not in CEFR_LEVELS:
        raise LemmaListInvalid(
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
        raise LemmaListInvalid("sort 必须是 " + "/".join(SORTS) + " 之一。")
    return value


def _validate_paging(page: int, page_size: int) -> None:
    if not isinstance(page, int) or page < 1:
        raise LemmaListInvalid("page 必须是 ≥1 的整数。")
    if not isinstance(page_size, int) or not 1 <= page_size <= MAX_PAGE_SIZE:
        raise LemmaListInvalid(
            f"pageSize 必须在 1–{MAX_PAGE_SIZE} 之间。"
        )


def lemma_list_page(
    page: int,
    page_size: int,
    query: Optional[str] = None,
    level: Optional[str] = None,
    sort: Optional[str] = None,
) -> Dict[str, object]:
    """``GET /api/vocabulary/lemma-list`` 的分页/搜索/等级/排序实现。

    - ``q``：大小写不敏感子串，匹配 lemma **或任一词形**；命中词形返回其 lemma。
    - ``level``：A1/A2/B1/B2/C1；非法 → 400（C2 未建模）。
    - ``sort``：``rank``（默认，词频升序）/ ``alpha``（字母序）。
    - 空/缺释义：``phonetic``/``translation`` 为 ``""``，不编造。
    """
    _validate_paging(page, page_size)
    needle = (query or "").strip().casefold()
    if len(needle) > MAX_QUERY_CHARS:
        raise LemmaListInvalid(f"q 最长 {MAX_QUERY_CHARS} 个字符。")
    normalized_level = _normalize_level(level)
    normalized_sort = _normalize_sort(sort)

    index = load_index()
    items: Sequence[LemmaEntry] = index.entries
    if normalized_level is not None:
        items = tuple(entry for entry in items if entry.level == normalized_level)
    if needle:
        items = tuple(entry for entry in items if needle in entry.haystack)
    if normalized_sort == "alpha":
        items = tuple(sorted(items, key=lambda entry: (entry.lemma.casefold(), entry.rank)))

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
                "lemma": entry.lemma,
                "rank": entry.rank,
                "level": entry.level,
                "phonetic": entry.phonetic,
                "translation": entry.translation,
                "forms": list(entry.forms),
            }
            for entry in page_items
        ],
    }
