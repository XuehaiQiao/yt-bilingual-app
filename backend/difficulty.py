"""内容难度向量（``difficulty.v1``）——CEFR M2 的离线规则管线（0 LLM）。

对应计划书 §6（内容难度向量）、§7.2（``content_difficulty`` 表）与
§10.2（M2 清单），specs/026。

设计要点
--------
1. **运行期只读自建频表**：``content/wordlist/frequency_bands.v1.json``
   （wordfreq CC BY-SA 4.0 数据派生的 lemma 频带；许可与局限见
   ``content/wordlist/README.md``）。不读 CEFR-J / Octanove / SUBTLEX 等
   仅研究用途词表。
2. **0 LLM**：词表覆盖率（UTR）、句长、从句近似、语速、习语密度全部是
   可复现的规则；文化负载先置 0（M3 人工标注）。
3. **不可用即 null**：自动字幕 / 无标点时 ``asl`` / ``clause_density`` /
   ``passive_per_1k`` 置 null 且 ``available=false``，不参与判带（§6.8）。
4. **判带**：词汇覆盖分位 + 语速（视频）决策表。M2 v1 用 **p90** 作为读向
   判带统计量（原因见 ``READ_PERCENTILE`` 注释）；p90/p95/p98 三档都写入
   features 供 §6.7 锚集校准后重定阈值。
5. **旧 level 回退**：难度行缺失/表未迁移时，API 用内容自身的编辑等级
   （``level``）兜底，不 503。

对外错误语义（路由层映射）：``DifficultyNotFound`` → 404；
``DifficultyUnavailable`` → 503；``DifficultyInvalid`` → 400/422。
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import sqlite3
import threading
import time
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

import config

logger = logging.getLogger("linguatrek.difficulty")

SCHEMA = "difficulty.v1"
METHOD = "rule.v1"
DB_METHOD = "rule"  # content_difficulty.method CHECK: manual/rule/hybrid/llm
ROW_VERSION = "v1"
ALGORITHM_VERSION = "rule.v1+freq.p90.v1"
DIFFICULTY_TABLE = "content_difficulty"

CEFR_LEVELS = ("A1", "A2", "B1", "B2", "C1")
LEVEL_OUTPUTS = ("A1", "A2", "B1", "B2", "C1", "C1+")
LEVEL_INDEX = {level: index for index, level in enumerate(LEVEL_OUTPUTS)}
CONTENT_KINDS = ("video", "article", "curated", "local_show")
FEATURE_KIND = {
    "video": "video",
    "curated": "video",
    "local_show": "video",
    "article": "article",
}
CONTENT_KIND_LABEL = {
    "video": "本地视频",
    "article": "原创文章",
    "curated": "精选视频",
    "local_show": "本地剧集",
}

# 读向判带统计量：M2 v1 用 90% 覆盖（p90）。
#
# 计划书 §6.2 的伪代码写 p95，但那套阈值是给「CEFR-J 标注的词汇」用的。
# K18 改成自建频表后，CEFR 只能由频率秩代理：真实文本的 95 分位几乎必然
# 落到最高锚点（自有 6 条 serving 全部 ≥B2、3 篇 A2–B2 文章全部 B2），
# p95 失去区分度。§6.8 冻结的决策特征本来也是 ``utr_static@5k`` 而不是
# p95。因此 v1 用 p90 判带（6/6 serving 与编辑标注 ±1 带内），p95/p98
# 仍完整记录；60–100 条锚集（§6.7）到位后按校准结果切回或重定阈值。
READ_PERCENTILE = "p90"

# 语速 → 听力带（计划书 §6.2，单位 wpm_net）
WPM_BANDS = ((110, "A2"), (140, "B1"), (165, "B2"))

# 句长 → 句法带（仅在 asl 可用时输出；§6.2 基准 A2 8 / B1 12 / B2 16 / C1 20）
ASL_BANDS = ((10, "A2"), (14, "B1"), (18, "B2"), (24, "C1"))

# 内容侧硬闸（§6.4）：读 >8% / 听 >5% 不进主推荐
READ_HARD_GATE = 0.08
LISTEN_HARD_GATE = 0.05

# 生词率桶（「生词约 X%（桶）」，不显示精确小数）
NOVELTY_BUCKETS: tuple[tuple[float, str], ...] = (
    (0.01, "<1%"),
    (0.03, "1–3%"),
    (0.05, "3–5%"),
    (0.08, "5–8%"),
    (math.inf, ">8%"),
)

# 功能词闭集（约 130 词）：冠词/介词/代词/助动词/be/do/have/连词/限定词。
FUNCTION_WORDS = frozenset(
    """
    a an the and or but if because although though while when where who whom
    whose which what why how this these that those he him his she her hers it
    its they them their theirs we us our ours you your yours i me my mine is am
    are was were be been being do does did done doing have has had having can
    could will would shall should may might must not no nor so than then there
    here as at by for from in into of on onto out over under up down off about
    with without within between among through during before after above below
    to too very just also only even still all any both each every few many more
    most much some such own same other another either neither per via vs
    """.split()
)

# 从属连词 / 关系词（从句密度近似；experimental）
_CLAUSE_WORDS = frozenset(
    """
    that which who whom whose because although though while whereas unless
    since if when where after before as once until whether
    """.split()
)

# 常见习语 / 短语动词（自建短语表，experimental）。只用于「地道度」参考，
# 不参与 M2 判带；短语匹配不做 token 级替换（计划书 K8/§4.2）。
IDIOM_PHRASES: tuple[str, ...] = (
    "a piece of cake",
    "at the end of the day",
    "break down",
    "break up",
    "bring up",
    "by and large",
    "call off",
    "carry out",
    "catch up",
    "come across",
    "come up with",
    "cut down",
    "deal with",
    "drop out",
    "end up",
    "fall apart",
    "figure out",
    "find out",
    "get along",
    "get away with",
    "get over",
    "get rid of",
    "give up",
    "go on",
    "grow up",
    "hang out",
    "hold on",
    "in the long run",
    "in the meantime",
    "keep up",
    "kind of",
    "lead to",
    "let down",
    "look after",
    "look forward to",
    "look into",
    "look up",
    "make up",
    "make sense",
    "no matter what",
    "of course",
    "on the other hand",
    "once in a while",
    "pick up",
    "point out",
    "put off",
    "put up with",
    "run into",
    "set up",
    "show up",
    "so far",
    "sort of",
    "take care of",
    "take off",
    "take on",
    "take over",
    "the other day",
    "turn down",
    "turn out",
    "up to you",
    "work out",
    "wrap up",
    "you know",
)

_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z'\-\u2019]*")
_WORD_RE = re.compile(r"^[a-z]+$")
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")
_PUNCT_END_RE = re.compile(r"[.!?]")
_PASSIVE_RE = re.compile(
    r"\b(?:be|is|are|was|were|been|being|get|gets|got)\s+"
    r"(?:[a-z]+ed|known|made|done|given|taken|seen|shown|written|built|held)\b",
    re.IGNORECASE,
)
# n't 缩略的基词（stem → 功能词）；"won't"/"can't"/"shan't" 特殊。
_NT_STEMS = {
    "ca": "can",
    "wo": "will",
    "sha": "shall",
    "ai": "be",
}
_NEGATIVE_LEMMAS = {
    "do": "do",
    "does": "do",
    "did": "do",
    "is": "be",
    "are": "be",
    "was": "be",
    "were": "be",
    "has": "have",
    "have": "have",
    "had": "have",
    "could": "can",
    "would": "will",
    "should": "should",
    "must": "must",
    "might": "might",
    "need": "need",
}
_CONTRACTIONS = {
    "i'm": "i",
    "i've": "have",
    "i'll": "will",
    "i'd": "would",
    "you're": "you",
    "you've": "have",
    "you'll": "will",
    "you'd": "would",
    "he's": "he",
    "he'll": "he",
    "she's": "she",
    "she'll": "she",
    "it's": "it",
    "it'll": "it",
    "we're": "we",
    "we've": "have",
    "we'll": "will",
    "we'd": "would",
    "they're": "they",
    "they've": "have",
    "they'll": "will",
    "they'd": "would",
    "that's": "that",
    "there's": "there",
    "what's": "what",
    "who's": "who",
    "where's": "where",
    "how's": "how",
    "let's": "let",
}


# ---------------------------------------------------------------------------
# 错误
# ---------------------------------------------------------------------------

class DifficultyError(Exception):
    """内容难度领域错误基类。"""


class DifficultyUnavailable(DifficultyError):
    """词表/数据库不可用（HTTP 503；读路径不因此失败）。"""

    status_code = 503


class DifficultyNotFound(DifficultyError):
    """内容不存在（HTTP 404；不泄露存在性）。"""

    status_code = 404


class DifficultyInvalid(DifficultyError):
    """参数/内容形状非法（HTTP 400/422）。"""

    status_code = 400


# ---------------------------------------------------------------------------
# 频表加载
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Wordlist:
    """运行期词→频带映射（只读、线程安全）。"""

    path: str
    schema: str
    version: str
    license: str
    band_size: int
    ranks: Mapping[str, int]
    forms: Mapping[str, str]
    anchors: tuple[tuple[int, str], ...]
    cefr_probs: Mapping[str, Mapping[str, float]]
    counts: Mapping[str, Any]
    integrity: str

    def level_for_rank(self, rank: int) -> str:
        for cut, level in self.anchors:
            if rank <= cut:
                return level
        return self.anchors[-1][1]

    def cutoff_for_level(self, level: str) -> int:
        for cut, candidate in self.anchors:
            if candidate == level:
                return cut
        return self.anchors[-1][0]

    def lemma_for(self, token: str) -> str | None:
        """token → lemma；未收录返回 None。"""
        normalized = normalize_token(token)
        for candidate in _lookup_forms(normalized):
            if candidate in self.forms:
                candidate = self.forms[candidate]
            if candidate in self.ranks:
                return candidate
            for stripped in candidate_lemmas(candidate):
                folded = self.forms.get(stripped, stripped)
                if folded in self.ranks:
                    return folded
        return None

    def rank_of(self, token: str) -> int | None:
        lemma = self.lemma_for(token)
        if lemma is None:
            return None
        return self.ranks.get(lemma)


_WORDLIST_LOCK = threading.Lock()
_WORDLIST_CACHE: dict[str, tuple[tuple[int, int], Wordlist]] = {}


def wordlist_path() -> str:
    return os.path.abspath(getattr(config, "WORDLIST_PATH", ""))


def reset_wordlist_cache() -> None:
    with _WORDLIST_LOCK:
        _WORDLIST_CACHE.clear()


def _payload_sha256(document: Mapping[str, Any]) -> str:
    payload = {
        "entries": document["entries"],
        "forms": document["forms"],
        "band_size": document["band_size"],
        "cefr_anchors": document["cefr_anchors"],
        "limit": document["counts"]["lemmas"],
        "version": document["version"],
    }
    material = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def load_wordlist(path: str | None = None) -> Wordlist:
    """加载并校验自建频表；缺失/损坏 → ``DifficultyUnavailable``（503）。"""
    target = os.path.abspath(path or wordlist_path())
    try:
        stat = os.stat(target)
    except OSError as exc:
        raise DifficultyUnavailable(
            f"频表不存在：{target}（content/wordlist/frequency_bands.v1.json 应随仓库分发）"
        ) from exc
    signature = (stat.st_mtime_ns, stat.st_size)
    with _WORDLIST_LOCK:
        cached = _WORDLIST_CACHE.get(target)
        if cached is not None and cached[0] == signature:
            return cached[1]
    try:
        with open(target, "r", encoding="utf-8") as handle:
            document = json.load(handle)
    except (OSError, ValueError) as exc:
        raise DifficultyUnavailable(f"频表无法解析：{exc}") from exc
    if not isinstance(document, dict) or document.get("schema") != "linguatrek.wordlist.v1":
        raise DifficultyUnavailable("频表 schema 不是 linguatrek.wordlist.v1")
    if document.get("license") != "CC-BY-SA-4.0":
        raise DifficultyUnavailable(
            f"频表许可不是 CC-BY-SA-4.0：{document.get('license')!r}"
        )
    integrity = document.get("integrity")
    if not isinstance(integrity, dict) or integrity.get("sha256") != _payload_sha256(
        document
    ):
        raise DifficultyUnavailable("频表完整性校验失败（integrity.sha256 不匹配）")
    entries = document.get("entries")
    forms = document.get("forms")
    anchors_raw = document.get("cefr_anchors")
    if not isinstance(entries, list) or not entries or not isinstance(forms, dict):
        raise DifficultyUnavailable("频表 entries/forms 形状不对")
    ranks: dict[str, int] = {}
    for entry in entries:
        if not (isinstance(entry, list) and len(entry) == 2):
            raise DifficultyUnavailable("频表 entries 条目形状不对")
        lemma, rank = entry
        if not isinstance(lemma, str) or not isinstance(rank, int):
            raise DifficultyUnavailable("频表 entries 条目类型不对")
        ranks[lemma] = rank
    anchors: list[tuple[int, str]] = []
    if isinstance(anchors_raw, list):
        for item in anchors_raw:
            if not isinstance(item, dict):
                continue
            cut = item.get("max_rank")
            level = item.get("level")
            if isinstance(cut, int) and isinstance(level, str):
                anchors.append((cut, level))
    if not anchors:
        raise DifficultyUnavailable("频表缺少 cefr_anchors")
    wordlist = Wordlist(
        path=target,
        schema=str(document["schema"]),
        version=str(document.get("version") or ""),
        license=str(document["license"]),
        band_size=int(document.get("band_size") or 1000),
        ranks=ranks,
        forms={str(key): str(value) for key, value in forms.items()},
        anchors=tuple(anchors),
        cefr_probs={
            str(key): {str(k): float(v) for k, v in value.items()}
            for key, value in (document.get("cefr_probs") or {}).items()
            if isinstance(value, dict)
        },
        counts=dict(document.get("counts") or {}),
        integrity=str(integrity.get("sha256") or ""),
    )
    with _WORDLIST_LOCK:
        _WORDLIST_CACHE[target] = (signature, wordlist)
    return wordlist


def wordlist_meta() -> dict:
    """给 API/报告用的频表元信息（不暴露全量词表）。"""
    info = load_wordlist()
    return {
        "schema": info.schema,
        "version": info.version,
        "license": info.license,
        "counts": dict(info.counts),
        "integrity": info.integrity,
    }


# ---------------------------------------------------------------------------
# 词形归一化（与 scripts/build_wordlist.py 的构建规则保持一致）
# ---------------------------------------------------------------------------

def normalize_token(raw: str) -> str:
    return raw.replace("\u2019", "'").lower()


def candidate_lemmas(token: str) -> set[str]:
    """由屈折后缀生成候选 lemma（运行时规则剥离，与构建脚本同构）。"""
    out: set[str] = set()
    n = len(token)
    if token.endswith("ies") and n > 4:
        out.add(token[:-3] + "y")
    if token.endswith("es") and n > 3:
        out.add(token[:-2])
        out.add(token[:-1])
    if token.endswith("s") and not token.endswith("ss") and n > 3:
        out.add(token[:-1])
    if token.endswith("ied") and n > 4:
        out.add(token[:-3] + "y")
    if token.endswith("ed") and n > 4:
        out.add(token[:-2])
        out.add(token[:-1])
        stem = token[:-3]
        if len(stem) >= 3 and stem[-1] == stem[-2] and stem[-1] not in "aeiou":
            out.add(stem[:-1])
    if token.endswith("ing") and n > 5:
        out.add(token[:-3])
        out.add(token[:-3] + "e")
        stem = token[:-3]
        if len(stem) >= 3 and stem[-1] == stem[-2] and stem[-1] not in "aeiou":
            out.add(stem[:-1])
    return {
        candidate
        for candidate in out
        if len(candidate) >= 2 and _WORD_RE.fullmatch(candidate)
    }


def _lookup_forms(token: str) -> list[str]:
    """token 的查找候选（缩略词、连字符复合词拆成词头/词尾）。"""
    candidates: list[str] = []
    normalized = normalize_token(token)
    if not normalized:
        return candidates
    if normalized in _CONTRACTIONS:
        candidates.append(_CONTRACTIONS[normalized])
    if normalized.endswith("n't"):
        stem = normalized[:-3]
        candidates.append(_NT_STEMS.get(stem, stem))
    elif "'" in normalized:
        head = normalized.split("'", 1)[0]
        if head:
            candidates.append(head)
    if "-" in normalized:
        parts = [part for part in normalized.split("-") if part]
        candidates.extend(parts)
        candidates.extend(reversed(parts))
    candidates.append(normalized)
    seen: set[str] = set()
    ordered: list[str] = []
    for candidate in candidates:
        if candidate and candidate not in seen:
            seen.add(candidate)
            ordered.append(candidate)
    return ordered


# ---------------------------------------------------------------------------
# 文本分析
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class TokenRecord:
    surface: str
    normalized: str
    rank: int | None
    lemma: str | None
    proper: bool
    function: bool


def _tokens_with_context(text: str) -> list[TokenRecord]:
    """token 化 + 专名/句首判定（专名：非句首大写）。"""
    records: list[TokenRecord] = []
    wordlist = load_wordlist()
    last_end = 0
    for match in _TOKEN_RE.finditer(text):
        gap = text[last_end : match.start()]
        sentence_start = last_end == 0 or bool(_PUNCT_END_RE.search(gap))
        raw = match.group(0)
        normalized = normalize_token(raw)
        proper = raw[0].isupper() and not sentence_start
        lemma = wordlist.lemma_for(normalized)
        rank = wordlist.ranks.get(lemma) if lemma is not None else None
        function = normalized in FUNCTION_WORDS or (
            lemma is not None and lemma in FUNCTION_WORDS
        )
        records.append(
            TokenRecord(
                surface=raw,
                normalized=normalized,
                rank=rank,
                lemma=lemma,
                proper=proper,
                function=function,
            )
        )
        last_end = match.end()
    return records


def _content_tokens(records: Sequence[TokenRecord]) -> list[TokenRecord]:
    return [record for record in records if not record.function and not record.proper]


def _rate(records: Sequence[TokenRecord], predicate) -> float:
    if not records:
        return 0.0
    return sum(1 for record in records if predicate(record)) / len(records)


def _percentile(sorted_values: Sequence[float], fraction: float) -> float | None:
    if not sorted_values:
        return None
    index = min(len(sorted_values) - 1, int(round((len(sorted_values) - 1) * fraction)))
    return sorted_values[index]


def _coverage_level(
    content: Sequence[TokenRecord], fraction: float, wordlist: Wordlist
) -> str:
    """覆盖 fraction 实词所需等级；超出最后锚点记为 ``C1+``。"""
    if not content:
        return "C1+"
    counts: dict[str, int] = {level: 0 for level in LEVEL_OUTPUTS}
    for record in content:
        level = (
            wordlist.level_for_rank(record.rank)
            if record.rank is not None
            else "C1+"
        )
        counts[level] = counts.get(level, 0) + 1
    covered = 0
    total = len(content)
    for level in LEVEL_OUTPUTS:
        covered += counts.get(level, 0)
        if covered / total >= fraction - 1e-9:
            return level
    return "C1+"


def _cefr_mix(content: Sequence[TokenRecord], wordlist: Wordlist) -> dict[str, float]:
    """表内实词占比（A1…C1 + beyond）；beyond = 表外/超出最后锚点。"""
    counts: dict[str, int] = {level: 0 for level in LEVEL_OUTPUTS}
    for record in content:
        level = (
            wordlist.level_for_rank(record.rank)
            if record.rank is not None
            else "C1+"
        )
        counts[level] = counts.get(level, 0) + 1
    total = len(content) or 1
    mix = {
        level: round(counts.get(level, 0) / total, 4)
        for level in CEFR_LEVELS
    }
    mix["beyond"] = round(counts.get("C1+", 0) / total, 4)
    return mix


def _utr(records: Sequence[TokenRecord], cutoff: int) -> float:
    if not records:
        return 0.0
    unknown = sum(
        1 for record in records if record.rank is None or record.rank > cutoff
    )
    return unknown / len(records)


def _utr_band_map(records: Sequence[TokenRecord], wordlist: Wordlist) -> dict[str, float]:
    """按用户带上界（A1..C1）截断的「高于该带的词占比」（utr_band，§6.4 K17）。"""
    return {
        level: round(_utr(records, wordlist.cutoff_for_level(level)), 4)
        for level in CEFR_LEVELS
    }


def _sentence_lengths(text: str) -> list[int]:
    """按 ``[.!?]`` 切句 → 句长（词数）；无标点返回空。"""
    if len(_PUNCT_END_RE.findall(text)) < 2:
        return []
    parts = [part.strip() for part in _SENTENCE_SPLIT_RE.split(text) if part.strip()]
    lengths = [
        len(_TOKEN_RE.findall(part)) for part in parts if _TOKEN_RE.search(part)
    ]
    return [length for length in lengths if length > 0]


def _clause_density(records: Sequence[TokenRecord]) -> float:
    if not records:
        return 0.0
    hits = sum(1 for record in records if record.normalized in _CLAUSE_WORDS)
    return round(hits / len(records) * 100, 3)


def _passive_per_1k(text: str) -> float:
    tokens = len(_TOKEN_RE.findall(text))
    if not tokens:
        return 0.0
    hits = len(_PASSIVE_RE.findall(text))
    return round(hits / tokens * 1000, 3)


def _idiom_density(text: str) -> float:
    tokens = len(_TOKEN_RE.findall(text))
    if not tokens:
        return 0.0
    lowered = text.lower()
    hits = sum(1 for phrase in IDIOM_PHRASES if phrase in lowered)
    return round(hits / tokens * 100, 3)


def _msttr(records: Sequence[TokenRecord], window: int = 100) -> float | None:
    """滑动窗口 TTR（非重叠 100 token 窗口的 TTR 均值；experimental）。"""
    if not records:
        return None
    windows = [
        records[index : index + window] for index in range(0, len(records), window)
    ]
    ratios = [
        len({record.lemma or record.normalized for record in chunk}) / len(chunk)
        for chunk in windows
        if chunk
    ]
    if not ratios:
        return None
    return round(sum(ratios) / len(ratios), 4)


def _video_speed(
    blocks: Sequence[Mapping[str, Any]],
) -> tuple[int | None, int | None, int | None, int | None]:
    """返回 (wpm, wpm_net, window_p90_wpm, duration_s)。

    - ``wpm``：全 token ÷ 首末时间戳跨度；决定真实听力负担；
    - ``wpm_net``：扣掉相邻块 >2s 的停顿后重算（§6.3）；
    - ``window_p90_wpm``：每 300 秒一个窗口，末窗 <120s 并入前窗；窗口 <2 个不报。
    """
    if not blocks:
        return None, None, None, None
    ordered = sorted(
        (
            {
                "start": float(block.get("start") or 0.0),
                "end": float(block.get("end") or 0.0),
                "tokens": len(_TOKEN_RE.findall(str(block.get("text") or ""))),
            }
            for block in blocks
        ),
        key=lambda block: block["start"],
    )
    tokens = sum(block["tokens"] for block in ordered)
    start_min = ordered[0]["start"]
    end_max = max(block["end"] for block in ordered)
    duration = max(0.0, end_max - start_min)
    if tokens <= 0 or duration <= 0:
        return None, None, None, int(round(duration)) if duration else None
    wpm = int(round(tokens / duration * 60))
    gap_total = sum(
        max(0.0, next_block["start"] - previous["end"])
        for previous, next_block in zip(ordered, ordered[1:])
        if next_block["start"] - previous["end"] > 2.0
    )
    net_seconds = max(1.0, duration - gap_total)
    wpm_net = int(round(tokens / net_seconds * 60))

    windows: list[dict[str, float]] = []
    window_start = start_min
    window_end = start_min
    window_tokens = 0
    for block in ordered:
        if (
            windows or window_tokens
        ) and block["start"] - window_start >= 300:
            windows.append(
                {
                    "start": window_start,
                    "end": max(window_end, window_start),
                    "tokens": window_tokens,
                }
            )
            window_start = block["start"]
            window_end = block["end"]
            window_tokens = block["tokens"]
            continue
        window_end = max(window_end, block["end"])
        window_tokens += block["tokens"]
    if window_tokens:
        windows.append({"start": window_start, "end": window_end, "tokens": window_tokens})
    if len(windows) >= 2 and windows[-1]["end"] - windows[-1]["start"] < 120:
        last = windows.pop()
        windows[-1]["end"] = max(windows[-1]["end"], last["end"])
        windows[-1]["tokens"] += last["tokens"]
    rates = sorted(
        window["tokens"] / max(1.0, window["end"] - window["start"]) * 60
        for window in windows
        if window["end"] > window["start"]
    )
    window_p90 = int(round(_percentile(rates, 0.90) or 0)) if rates else None
    return wpm, wpm_net, window_p90, int(round(duration))


def _confidence(
    *, tokens: int, kind: str, subtitle: str, text_available: bool
) -> float:
    if not text_available or tokens <= 0:
        return 0.0
    if tokens < 80:
        base = 0.3
    elif tokens < 300:
        base = 0.55
    else:
        base = 0.8
    if kind == "video":
        factor = {"human": 1.0, "auto": 0.8}.get(subtitle, 0.4)
        base *= factor
    return round(min(0.95, max(0.0, base)), 2)


def _read_band(p_level: Mapping[str, str]) -> str | None:
    value = p_level.get(READ_PERCENTILE)
    if value is None:
        return None
    if value in ("A1", "A2"):
        return "A2"  # 内容带下限 A2（§6.2 决策表）
    if value in ("B1", "B2", "C1"):
        return value
    return "C1+"


def _listen_band(wpm_net: int | None, read_band: str | None) -> str | None:
    if wpm_net is None:
        return None
    wpm_band = "C1+"
    for cutoff, level in WPM_BANDS:
        if wpm_net <= cutoff:
            wpm_band = level
            break
    if read_band is None:
        return wpm_band
    return max((read_band, wpm_band), key=lambda level: LEVEL_INDEX.get(level, 0))


def _syntax_band(asl: float | None) -> str | None:
    if asl is None:
        return None
    band = "C1+"
    for cutoff, level in ASL_BANDS:
        if asl <= cutoff:
            band = level
            break
    return band


def _features_document(
    *,
    kind: str,
    text: str,
    records: Sequence[TokenRecord],
    wordlist: Wordlist,
    support: Mapping[str, Any],
    editorial_level: str | None,
    duration_s: int | None,
    speed: tuple[int | None, int | None, int | None],
    sentence_lengths: Sequence[int],
    asl_available: bool,
    text_available: bool,
) -> dict[str, Any]:
    content = _content_tokens(records)
    content_tokens = len(content)
    tokens = len(records)
    lemmas = {record.lemma or record.normalized for record in records}

    p_level = {
        percentile: _coverage_level(content, fraction, wordlist)
        for percentile, fraction in (("p90", 0.90), ("p95", 0.95), ("p98", 0.98))
    }
    read_band = _read_band(p_level) if text_available and content_tokens else None
    speed = tuple(speed) + (None,) * max(0, 4 - len(speed))
    wpm, wpm_net, window_p90, computed_duration = speed[:4]
    listen_band = _listen_band(wpm_net, read_band) if kind == "video" else None
    # cefr_input 用「文本理解带」：本地应用默认配字幕/译文，词汇负担是主难度轴；
    # 听向带（wpm_net 与文本取高）单独记在 est_cefr.listen，M3 接听向匹配。
    cefr_input = read_band or listen_band

    asl = (
        round(sum(sentence_lengths) / len(sentence_lengths), 2)
        if asl_available and sentence_lengths
        else None
    )
    p90_len = (
        round(_percentile(sorted(sentence_lengths), 0.90) or 0, 2)
        if asl_available and sentence_lengths
        else None
    )
    syntax_available = bool(asl_available and sentence_lengths)
    duration = duration_s if duration_s is not None else computed_duration

    features: dict[str, Any] = {
        "schema": SCHEMA,
        "kind": kind,
        "size": {
            "tokens": tokens,
            "content_tokens": content_tokens,
            "lemmas": len(lemmas),
            "duration_s": duration,
        },
        # 固定 1k/2k/5k 口径（计划书 §6.1）；与 CEFR 锚点阈值解耦。
        "utr": {
            "w1k": round(_utr(records, 1000), 4),
            "w2k": round(_utr(records, 2000), 4),
            "w5k": round(_utr(records, 5000), 4),
        },
        "utr_content": {
            "w1k": round(_utr(content, wordlist.cutoff_for_level("A1")), 4),
            "w3k": round(_utr(content, 3000), 4),
            "w5k": round(_utr(content, 5000), 4),
        },
        # 派生字段：按用户低带（A1..C1）截断的带级量 utr_band（K17）。
        "utr_band": _utr_band_map(records, wordlist),
        "cefr_mix": _cefr_mix(content, wordlist),
        "p_level": p_level,
        "proper_noun_rate": round(
            sum(1 for record in records if record.proper) / tokens, 4
        )
        if tokens
        else 0.0,
        "speed": {
            "wpm": wpm,
            "wpm_net": wpm_net,
            "window_p90_wpm": window_p90,
        },
        "syntax": {
            "asl": asl,
            "p90_len": p90_len,
            "clause_density": round(_clause_density(records), 3) if syntax_available else None,
            "passive_per_1k": round(_passive_per_1k(text), 3) if syntax_available else None,
        },
        "available": {
            "wpm": wpm is not None,
            "wpm_net": wpm_net is not None,
            "asl": syntax_available,
            "clause_density": syntax_available,
            "passive_per_1k": syntax_available,
            "idiom_density": True,
        },
        "lex": {"msttr": _msttr(records) if text_available else None},
        "pragmatics": {
            "idiom_density": _idiom_density(text) if text_available else 0.0,
            # 文化负载：M2 先置 0（占位），等 M3 人工/规则标注；不伪造分数。
            "cultural_load": 0.0,
            "cultural_load_method": "placeholder",
        },
        "support": dict(support),
        "est_cefr": {
            "read": read_band,
            "listen": listen_band,
        },
        "editorial_level": editorial_level,
        "label_confidence": _confidence(
            tokens=tokens,
            kind=kind,
            subtitle=str(support.get("subtitle") or "none"),
            text_available=text_available,
        ),
        "method": METHOD,
        "algorithm": ALGORITHM_VERSION,
        "computed_at": int(time.time() * 1000),
    }
    features["_bands"] = {
        "cefr_input": cefr_input,
        "lexical_band": read_band,
        "syntax_band": _syntax_band(asl),
        "discourse_band": None,
    }
    return features


# ---------------------------------------------------------------------------
# 两种内容入口
# ---------------------------------------------------------------------------

def compute_article_features(
    paragraphs: Sequence[str],
    *,
    editorial_level: str | None = None,
    support: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """文章入口：正文段落 → difficulty.v1 features（无句法可用性降级规则）。"""
    wordlist = load_wordlist()
    texts = [str(paragraph).strip() for paragraph in paragraphs if str(paragraph).strip()]
    text = "\n\n".join(texts)
    records = _tokens_with_context(text) if text else []
    sentence_lengths = _sentence_lengths(text)
    support_document = {
        "subtitle": "none",
        "translation": bool((support or {}).get("translation", False)),
        "glossary": bool((support or {}).get("glossary", False)),
        "text": True,
    }
    features = _features_document(
        kind="article",
        text=text,
        records=records,
        wordlist=wordlist,
        support=support_document,
        editorial_level=editorial_level,
        duration_s=None,
        speed=(None, None, None, None),
        sentence_lengths=sentence_lengths,
        asl_available=bool(sentence_lengths),
        text_available=bool(text),
    )
    return features


def compute_video_features(
    blocks: Sequence[Mapping[str, Any]],
    *,
    duration_s: int | None = None,
    subtitle_source: str = "human",
    support: Mapping[str, Any] | None = None,
    editorial_level: str | None = None,
) -> dict[str, Any]:
    """视频入口：字幕块（start/end/text）→ difficulty.v1 features。"""
    wordlist = load_wordlist()
    normalized_blocks: list[dict[str, Any]] = []
    for block in blocks:
        if not isinstance(block, Mapping):
            continue
        text = str(block.get("text") or block.get("en_text") or "").strip()
        if not text:
            continue
        normalized_blocks.append(
            {
                "start": float(block.get("start") or 0.0),
                "end": float(block.get("end") or 0.0),
                "text": text,
            }
        )
    text = " ".join(block["text"] for block in normalized_blocks)
    records = _tokens_with_context(text) if text else []
    source = subtitle_source if subtitle_source in ("human", "auto") else "none"
    # 句法字段只在「人工字幕 + 有标点」时可用（§6.8）；自动字幕一律 null。
    punctuated = bool(_sentence_lengths(text))
    sentence_lengths = _sentence_lengths(text) if source == "human" else []
    asl_available = source == "human" and punctuated
    support_document = {
        "subtitle": source,
        "translation": bool((support or {}).get("translation", False)),
        "glossary": bool((support or {}).get("glossary", True)),
        "text": True,
    }
    speed = _video_speed(normalized_blocks)
    features = _features_document(
        kind="video",
        text=text,
        records=records,
        wordlist=wordlist,
        support=support_document,
        editorial_level=editorial_level,
        duration_s=duration_s,
        speed=speed,
        sentence_lengths=sentence_lengths,
        asl_available=asl_available,
        text_available=bool(text),
    )
    return features


# ---------------------------------------------------------------------------
# 内容解析（只读 content/ 与 data/ 缓存，不联网）
# ---------------------------------------------------------------------------

def _library_dir() -> str:
    return os.path.abspath(getattr(config, "LIBRARY_DIR", ""))


def _curated_path() -> str:
    return os.path.abspath(getattr(config, "CURATED_CONTENT_PATH", ""))


def curated_subtitles_dir() -> str:
    return os.path.abspath(getattr(config, "CURATED_SUBTITLES_DIR", ""))


def _read_json(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError as exc:
        raise DifficultyNotFound(f"内容文件不存在：{os.path.basename(path)}") from exc
    except OSError as exc:
        raise DifficultyUnavailable(f"读取内容失败：{exc}") from exc
    except ValueError as exc:
        raise DifficultyUnavailable(f"内容不是合法 JSON：{exc}") from exc
    if not isinstance(data, dict):
        raise DifficultyUnavailable("内容顶层必须是 JSON 对象")
    return data


def _curated_items() -> list[dict]:
    try:
        data = _read_json(_curated_path())
    except DifficultyNotFound:
        return []
    items = data.get("items")
    return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []


_LEVEL_SET = frozenset(CEFR_LEVELS)


def _normalize_level(value: Any) -> str | None:
    return value if isinstance(value, str) and value in _LEVEL_SET else None


def resolve_content(kind: str, ref: str) -> dict | None:
    """读取内容源；不存在返回 None（调用方决定 404）。只读、不联网。"""
    if kind not in CONTENT_KINDS or not isinstance(ref, str) or not ref.strip():
        return None
    ref = ref.strip()
    if kind == "article":
        path = os.path.join(_library_dir(), "articles", f"{ref}.json")
        if not os.path.isfile(path):
            return None
        data = _read_json(path)
        paragraphs = data.get("paragraphs")
        if not isinstance(paragraphs, list):
            return None
        texts = [
            str(paragraph.get("en") or "").strip()
            for paragraph in paragraphs
            if isinstance(paragraph, dict)
        ]
        translations = [
            str(paragraph.get("zh") or "").strip()
            for paragraph in paragraphs
            if isinstance(paragraph, dict)
        ]
        return {
            "kind": kind,
            "ref": ref,
            "title": data.get("title"),
            "editorial_level": _normalize_level(data.get("level")),
            "paragraphs": [text for text in texts if text],
            "source": "library",
            "support": {
                "subtitle": "none",
                "translation": bool(any(translations)),
                "glossary": False,
                "text": True,
            },
        }
    if kind == "video":
        path = os.path.join(_library_dir(), "videos", f"{ref}.json")
        if not os.path.isfile(path):
            return None
        data = _read_json(path)
        blocks = data.get("blocks")
        if not isinstance(blocks, list):
            return None
        subtitle_source = data.get("subtitleSource")
        if subtitle_source not in ("manual", "auto"):
            subtitle_source = "human" if subtitle_source == "manual" else "auto"
        subtitle = "human" if subtitle_source == "manual" else subtitle_source
        return {
            "kind": kind,
            "ref": ref,
            "title": data.get("title"),
            "editorial_level": _normalize_level(data.get("level")),
            "duration_s": data.get("duration")
            if isinstance(data.get("duration"), int)
            else None,
            "subtitle_source": subtitle,
            "blocks": [
                {
                    "start": block.get("start"),
                    "end": block.get("end"),
                    "text": block.get("en_text") or block.get("text") or "",
                }
                for block in blocks
                if isinstance(block, dict)
            ],
            "source": "library",
            "support": {
                "subtitle": subtitle,
                "translation": any(
                    isinstance(block, dict) and str(block.get("zh_text") or "").strip()
                    for block in blocks
                ),
                "glossary": True,
                "text": True,
            },
        }
    if kind == "curated":
        item = next(
            (entry for entry in _curated_items() if entry.get("videoId") == ref), None
        )
        if item is None:
            return None
        cache_path = os.path.join(curated_subtitles_dir(), f"{ref}.json")
        subtitle_source = None
        blocks: list[dict] = []
        if os.path.isfile(cache_path):
            cached = _read_json(cache_path)
            raw_kind = cached.get("subtitleSource")
            subtitle_source = "human" if raw_kind == "manual" else (
                "auto" if raw_kind == "auto" else None
            )
            raw_blocks = cached.get("blocks")
            if isinstance(raw_blocks, list):
                blocks = [
                    {
                        "start": block.get("start"),
                        "end": block.get("end"),
                        "text": block.get("text") or block.get("en_text") or "",
                    }
                    for block in raw_blocks
                    if isinstance(block, dict)
                ]
        return {
            "kind": kind,
            "ref": ref,
            "title": item.get("title"),
            "editorial_level": _normalize_level(item.get("level")),
            "duration_s": item.get("duration")
            if isinstance(item.get("duration"), int)
            else None,
            "subtitle_source": subtitle_source or "none",
            "blocks": blocks,
            "source": "curated",
            "support": {
                "subtitle": subtitle_source or "none",
                "translation": False,
                "glossary": False,
                "text": bool(blocks),
            },
        }
    # local_show：M2 未接入（SRT 解析与字幕版权在既有运行时缓存里，不在本轮范围）
    return None


def content_exists(kind: str, ref: str) -> bool:
    try:
        return resolve_content(kind, ref) is not None
    except DifficultyUnavailable:
        return False


def compute_for_content(content: Mapping[str, Any]) -> dict[str, Any]:
    """已解析内容 → features（供回填脚本/重算复用）。"""
    kind = str(content["kind"])
    if kind == "article":
        return compute_article_features(
            content.get("paragraphs") or [],
            editorial_level=content.get("editorial_level"),
            support=content.get("support"),
        )
    source = str(content.get("subtitle_source") or "none")
    if source == "none" or not content.get("blocks"):
        raise DifficultyInvalid("缺少英文字幕，无法计算词法难度（内容只会回退旧等级）")
    return compute_video_features(
        content.get("blocks") or [],
        duration_s=content.get("duration_s"),
        subtitle_source=source,
        support=content.get("support"),
        editorial_level=content.get("editorial_level"),
    )


# ---------------------------------------------------------------------------
# SQLite
# ---------------------------------------------------------------------------

def _db_path() -> str:
    return config.AUTH_DB_PATH


def _connect(*, readonly: bool = True) -> sqlite3.Connection:
    path = _db_path()
    if not os.path.exists(path):
        raise DifficultyUnavailable(
            f"数据库文件不存在：{path}（先运行 alembic upgrade head）"
        )
    try:
        conn = sqlite3.connect(path, timeout=10)
    except sqlite3.Error as exc:
        raise DifficultyUnavailable(f"困难度数据库不可用：{exc}") from exc
    conn.row_factory = sqlite3.Row
    if readonly:
        conn.execute("PRAGMA query_only = ON")
    return conn


def _table_names(conn: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def table_available(conn: sqlite3.Connection | None = None) -> bool:
    try:
        own = conn is None
        connection = _connect() if own else conn
        try:
            return DIFFICULTY_TABLE in _table_names(connection)
        finally:
            if own:
                connection.close()
    except DifficultyUnavailable:
        return False


def _safe_json(raw: Any) -> Any:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        logger.info("content_difficulty 的 JSON 字段损坏，按缺失处理")
        return None


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "contentRef": row["content_ref"],
        "contentKind": row["content_kind"],
        "version": row["version"],
        "level": row["level"],
        "cefrInput": row["cefr_input"],
        "cefrTask": row["cefr_task"],
        "lexicalBand": row["lexical_band"],
        "syntaxBand": row["syntax_band"],
        "discourseBand": row["discourse_band"],
        "features": _safe_json(row["features"]),
        "support": _safe_json(row["support"]),
        "method": row["method"],
        "confidence": row["confidence"],
        "reviewer": row["reviewer"],
        "reviewedAt": row["reviewed_at"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def get_row(
    kind: str, ref: str, *, version: str = ROW_VERSION, conn: sqlite3.Connection | None = None
) -> dict[str, Any] | None:
    """读一条内容难度；表不存在/库缺失时返回 None（API 回退旧 level）。"""
    try:
        own = conn is None
        connection = _connect() if own else conn
        try:
            if DIFFICULTY_TABLE not in _table_names(connection):
                return None
            row = connection.execute(
                "SELECT * FROM content_difficulty "
                "WHERE content_ref = ? AND content_kind = ? AND version = ?",
                (ref, kind, version),
            ).fetchone()
            return _row_to_dict(row) if row is not None else None
        finally:
            if own:
                connection.close()
    except (DifficultyUnavailable, sqlite3.Error) as exc:
        logger.info("读取内容难度失败，按旧等级回退：%s", exc)
        return None


def get_rows(
    items: Sequence[tuple[str, str]], *, version: str = ROW_VERSION
) -> dict[tuple[str, str], dict[str, Any]]:
    """批量读（kind, ref）→ 行；缺失/未迁移返回空 dict。"""
    if not items:
        return {}
    try:
        conn = _connect()
    except DifficultyUnavailable:
        return {}
    try:
        if DIFFICULTY_TABLE not in _table_names(conn):
            return {}
        result: dict[tuple[str, str], dict[str, Any]] = {}
        for kind, ref in items:
            row = conn.execute(
                "SELECT * FROM content_difficulty "
                "WHERE content_ref = ? AND content_kind = ? AND version = ?",
                (ref, kind, version),
            ).fetchone()
            if row is not None:
                result[(kind, ref)] = _row_to_dict(row)
        return result
    except sqlite3.Error as exc:
        logger.info("批量读取内容难度失败，按旧等级回退：%s", exc)
        return {}
    finally:
        conn.close()


def _upsert_row(conn: sqlite3.Connection, payload: Mapping[str, Any]) -> None:
    now = int(time.time() * 1000)
    row = (
        payload["content_ref"],
        payload["content_kind"],
        payload["version"],
        payload.get("level"),
        payload.get("cefr_input"),
        payload.get("cefr_task"),
        payload.get("lexical_band"),
        payload.get("syntax_band"),
        payload.get("discourse_band"),
        json.dumps(payload["features"], ensure_ascii=False, sort_keys=True),
        json.dumps(payload.get("support") or {}, ensure_ascii=False, sort_keys=True),
        payload.get("method") or DB_METHOD,
        payload.get("confidence"),
        payload.get("reviewer"),
        payload.get("reviewed_at"),
    )
    conn.execute(
        """
        INSERT INTO content_difficulty (
            content_ref, content_kind, version, level, cefr_input, cefr_task,
            lexical_band, syntax_band, discourse_band, features, support,
            method, confidence, reviewer, reviewed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(content_ref, content_kind, version) DO UPDATE SET
            level = excluded.level,
            cefr_input = excluded.cefr_input,
            cefr_task = excluded.cefr_task,
            lexical_band = excluded.lexical_band,
            syntax_band = excluded.syntax_band,
            discourse_band = excluded.discourse_band,
            features = excluded.features,
            support = excluded.support,
            method = excluded.method,
            confidence = excluded.confidence,
            reviewer = excluded.reviewer,
            reviewed_at = excluded.reviewed_at,
            updated_at = excluded.updated_at
        """,
        (*row, now, now),
    )


def payload_from_features(
    kind: str, ref: str, features: Mapping[str, Any], *, editorial_level: str | None
) -> dict[str, Any]:
    bands = features.get("_bands") or {}
    support = features.get("support") or {}
    return {
        "content_ref": ref,
        "content_kind": kind,
        "version": ROW_VERSION,
        "level": editorial_level,
        "cefr_input": bands.get("cefr_input"),
        "cefr_task": None,
        "lexical_band": bands.get("lexical_band"),
        "syntax_band": bands.get("syntax_band"),
        "discourse_band": bands.get("discourse_band"),
        "features": {key: value for key, value in features.items() if key != "_bands"},
        "support": support,
        "method": DB_METHOD,
        "confidence": features.get("label_confidence"),
        "reviewer": None,
        "reviewed_at": None,
    }


def recompute(kind: str, ref: str, *, conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    """重算并 upsert 一条内容难度（幂等）。"""
    content = resolve_content(kind, ref)
    if content is None:
        raise DifficultyNotFound(f"内容不存在：{kind}:{ref}")
    features = compute_for_content(content)
    payload = payload_from_features(
        kind, ref, features, editorial_level=content.get("editorial_level")
    )
    own = conn is None
    connection = _connect(readonly=False) if own else conn
    try:
        if DIFFICULTY_TABLE not in _table_names(connection):
            raise DifficultyUnavailable("数据库缺少 content_difficulty 表（迁移 0016）")
        _upsert_row(connection, payload)
        if own:
            connection.commit()
    finally:
        if own:
            connection.close()
    return payload_to_public(payload)


def upsert_payloads(payloads: Sequence[Mapping[str, Any]]) -> int:
    """批量 upsert（回填脚本用；单事务）。"""
    if not payloads:
        return 0
    conn = _connect(readonly=False)
    try:
        if DIFFICULTY_TABLE not in _table_names(conn):
            raise DifficultyUnavailable("数据库缺少 content_difficulty 表（迁移 0016）")
        for payload in payloads:
            _upsert_row(conn, payload)
        conn.commit()
        return len(payloads)
    finally:
        conn.close()


def payload_for_content(kind: str, ref: str) -> dict[str, Any]:
    """计算一条内容但不落库（回填脚本的 dry-run/预览用）。"""
    content = resolve_content(kind, ref)
    if content is None:
        raise DifficultyNotFound(f"内容不存在：{kind}:{ref}")
    features = compute_for_content(content)
    return payload_from_features(
        kind, ref, features, editorial_level=content.get("editorial_level")
    )


# ---------------------------------------------------------------------------
# 对外 payload / 生词桶
# ---------------------------------------------------------------------------

def novelty_bucket(rate: float | None) -> str | None:
    if rate is None:
        return None
    for upper, label in NOVELTY_BUCKETS:
        if rate < upper:
            return label
    return NOVELTY_BUCKETS[-1][1]


def utr_band_for(features: Mapping[str, Any] | None, band: str | None) -> float | None:
    """按用户词汇带（取该带上界 A1..C1）取 utr_band；无数据返回 None。

    ``utr_band`` 是「高于用户整个区间」的带级词占比（K17），不是逐词画像。
    """
    if not isinstance(features, Mapping) or band not in CEFR_LEVELS:
        return None
    values = features.get("utr_band")
    if not isinstance(values, Mapping):
        return None
    value = values.get(band)
    return float(value) if isinstance(value, (int, float)) else None


def payload_to_public(payload: Mapping[str, Any], *, band: str | None = None) -> dict[str, Any]:
    """DB 行（camel）或 upsert payload（snake）→ 对外统一形状。"""

    def pick(snake: str, camel: str) -> Any:
        if snake in payload:
            return payload[snake]
        return payload.get(camel)

    features = payload.get("features")
    rate = utr_band_for(features, band)
    return {
        "schema": SCHEMA,
        "kind": pick("content_kind", "contentKind"),
        "ref": pick("content_ref", "contentRef"),
        "version": payload.get("version"),
        "level": payload.get("level"),
        "cefrInput": pick("cefr_input", "cefrInput"),
        "cefrTask": pick("cefr_task", "cefrTask"),
        "lexicalBand": pick("lexical_band", "lexicalBand"),
        "syntaxBand": pick("syntax_band", "syntaxBand"),
        "discourseBand": pick("discourse_band", "discourseBand"),
        "confidence": payload.get("confidence"),
        "method": payload.get("method"),
        "support": payload.get("support"),
        "features": features,
        "utrBand": rate,
        "bucket": novelty_bucket(rate),
        "estimated": True,
        "source": "computed",
    }


def legacy_payload(
    kind: str, ref: str, *, level: str | None, band: str | None = None
) -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "kind": kind,
        "ref": ref,
        "version": None,
        "level": level,
        "cefrInput": None,
        "cefrTask": None,
        "lexicalBand": None,
        "syntaxBand": None,
        "discourseBand": None,
        "confidence": None,
        "method": "legacy",
        "support": None,
        "features": None,
        "utrBand": None,
        "bucket": None,
        "estimated": False,
        "source": "legacy",
    }


def difficulty_payload(kind: str, ref: str, *, band: str | None = None) -> dict[str, Any]:
    """单条内容难度：优先 content_difficulty，缺失回退内容旧 level。"""
    normalized_band = band if band in CEFR_LEVELS else None
    row = get_row(kind, ref)
    if row is not None:
        return payload_to_public(row, band=normalized_band)
    content = resolve_content(kind, ref)
    if content is None:
        raise DifficultyNotFound(f"内容不存在：{kind}:{ref}")
    return legacy_payload(
        kind, ref, level=content.get("editorial_level"), band=normalized_band
    )


def batch_payload(
    items: Sequence[tuple[str, str]], *, band: str | None = None
) -> list[dict[str, Any]]:
    """批量：最多 50 条（路由层限制）；逐条 404 由调用方处理。"""
    normalized_band = band if band in CEFR_LEVELS else None
    rows = get_rows(items)
    payloads: list[dict[str, Any]] = []
    for kind, ref in items:
        row = rows.get((kind, ref))
        if row is not None:
            payloads.append(payload_to_public(row, band=normalized_band))
            continue
        content = resolve_content(kind, ref)
        if content is None:
            raise DifficultyNotFound(f"内容不存在：{kind}:{ref}")
        payloads.append(
            legacy_payload(
                kind, ref, level=content.get("editorial_level"), band=normalized_band
            )
        )
    return payloads


def score_support(support: Mapping[str, Any] | None) -> float:
    """匹配用支持度：人工字幕 1.0 / 自动字幕 0.8 / 无字幕文章 0.9 / 其它 0.3。"""
    if not isinstance(support, Mapping):
        return 0.3
    subtitle = support.get("subtitle")
    if subtitle == "human":
        return 1.0
    if subtitle == "auto":
        return 0.8
    if support.get("text"):
        return 0.9
    return 0.3
