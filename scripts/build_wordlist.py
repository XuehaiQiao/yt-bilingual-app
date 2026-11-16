#!/usr/bin/env python3
"""构建自建英语频表（frequency bands）——语途 CEFR M2，计划书 §4.2 / K18。

产物 ``content/wordlist/frequency_bands.v1.json`` 是**运行期唯一**的词→频带
映射来源：内容难度管线（``backend/difficulty.py``）只读它，不读 CEFR-J /
Octanove / 任何仅研究用途的词表。产物自带 ``version / license / integrity``，
随仓库分发。

数据源（必须可商用 / 许可明确）
--------------------------------
默认 ``--from-wordfreq``：用 [wordfreq](https://pypi.org/project/wordfreq/)
3.1.1 的英语词频。wordfreq 代码 MIT、**数据 CC BY-SA 4.0**——允许商用，
义务是署名 + 衍生数据同协议开放。因此本产物整体按 **CC BY-SA 4.0** 分发，
署名见 ``content/wordlist/NOTICE.md``。

*不使用* CEFR-J（商用需书面许可）、Octanove（CC BY-SA 但仅 C1/C2 研究用
补口）、SUBTLEX-US（无正式许可字符串）等仅研究用途来源。

离线 / 测试
-----------
``--freq-tsv PATH`` 从 ``word<TAB>count`` 快照构建（不依赖 wordfreq），
用于 CI 与单元测试；正式产物用 ``--from-wordfreq``。

词形归一化
----------
用**自写规则 + 内置不规则表**把屈折形式折回 lemma（running→run、went→go、
children→child…），**不引入 ECDICT 的词形数据**——让产物的许可链只有
wordfreq 一个来源。ECDICT 仍只用于运行期查词释义（既有功能），与本产物无关。

用法
----
    python3 scripts/build_wordlist.py --from-wordfreq \
        --out content/wordlist/frequency_bands.v1.json --write-sidecar
    python3 scripts/build_wordlist.py --check            # 只校验已提交产物
    python3 scripts/build_wordlist.py --freq-tsv /tmp/tiny.tsv --limit 50 \
        --out /tmp/tiny-wordlist.json                    # 离线/测试

退出码：0 成功；1 校验失败/构建失败；2 参数错误。
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "content" / "wordlist" / "frequency_bands.v1.json"
DEFAULT_SIDECAR = ROOT / "content" / "wordlist" / "SHA256SUMS"

SCHEMA = "linguatrek.wordlist.v1"
DEFAULT_LIMIT = 10_000
DEFAULT_BAND_SIZE = 1_000
ARTIFACT_VERSION = "2026.11.17"
SOURCE_NAME = "wordfreq"
SOURCE_VERSION = "3.1.1"
SOURCE_URL = "https://pypi.org/project/wordfreq/3.1.1/"
DATA_LICENSE = "CC-BY-SA-4.0"
LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/"

# 频带秩 → CEFR 锚点：按「惯例词汇量区间」的下界切（计划书 §4.3 归一化累计
# 1,042 / 2,243 / 4,331 / 6,713 / 7,623 的量级，向下取整到 1k 档）。
# 这是 v1 先验，不是教学等级；M2 的锚集校准（§6.7）会重估这些阈值。
CEFR_ANCHORS: tuple[tuple[int, str], ...] = (
    (1_000, "A1"),
    (2_000, "A2"),
    (4_000, "B1"),
    (7_000, "B2"),
    (10_000, "C1"),
)
CEFR_LEVELS = tuple(level for _cut, level in CEFR_ANCHORS)

# 词表只收纯字母词：带撇号/连字符的词交给运行期 tokenizer 的缩略/复合词
# 归一化，避免产物里出现 `don't`、`well-known` 这类不稳定条目。
_WORD_RE = re.compile(r"^[a-z]+$")
_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z'\-\u2019]*")
_VOWELS = set("aeiou")

# 候选词过滤：1–2 字母只留常见功能词；去掉字幕语料里的缩写/噪声 token。
# 专名（colin/julie…）不在这里硬删——wordfreq 是大小写归一的语料频次，
# 内容侧另用「非句首大写」过滤专名；词表的已知局限见 README。
_SHORT_OK = frozenset(
    "a i am an as at be by do go he hi if in is it me my no of on or so to up us we ok".split()
)
_JUNK = frozenset("et ll mm mos vi wi fl fr blu govt fcc ngo phd".split())

# 不规则屈折 → lemma。只收「折回后频带不乱」的常见不规则形式；表由本脚本
# 维护（英语不规则屈折的一般知识），不来自任何受许可限制的词表。
_IRREGULAR_GROUPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("be", ("am", "is", "are", "was", "were", "been", "being")),
    ("have", ("has", "had", "having")),
    ("do", ("does", "did", "done", "doing")),
    ("go", ("goes", "went", "gone", "going")),
    ("say", ("says", "said", "saying")),
    ("make", ("makes", "made", "making")),
    ("take", ("takes", "took", "taken", "taking")),
    ("come", ("comes", "came", "coming")),
    ("see", ("sees", "saw", "seen", "seeing")),
    ("know", ("knows", "knew", "known", "knowing")),
    ("get", ("gets", "got", "gotten", "getting")),
    ("give", ("gives", "gave", "given", "giving")),
    ("find", ("finds", "found", "finding")),
    ("think", ("thinks", "thought", "thinking")),
    ("tell", ("tells", "told", "telling")),
    ("become", ("becomes", "became", "becoming")),
    ("leave", ("leaves", "left", "leaving")),
    ("feel", ("feels", "felt", "feeling")),
    ("put", ("puts", "putting")),
    ("bring", ("brings", "brought", "bringing")),
    ("begin", ("begins", "began", "begun", "beginning")),
    ("keep", ("keeps", "kept", "keeping")),
    ("hold", ("holds", "held", "holding")),
    ("write", ("writes", "wrote", "written", "writing")),
    ("stand", ("stands", "stood", "standing")),
    ("hear", ("hears", "heard", "hearing")),
    ("mean", ("means", "meant", "meaning")),
    ("meet", ("meets", "met", "meeting")),
    ("run", ("runs", "ran", "running")),
    ("pay", ("pays", "paid", "paying")),
    ("sit", ("sits", "sat", "sitting")),
    ("speak", ("speaks", "spoke", "spoken", "speaking")),
    ("lie", ("lies", "lay", "lain", "lying")),
    ("lead", ("leads", "led", "leading")),
    ("grow", ("grows", "grew", "grown", "growing")),
    ("lose", ("loses", "lost", "losing")),
    ("fall", ("falls", "fell", "fallen", "falling")),
    ("send", ("sends", "sent", "sending")),
    ("build", ("builds", "built", "building")),
    ("understand", ("understands", "understood", "understanding")),
    ("draw", ("draws", "drew", "drawn", "drawing")),
    ("break", ("breaks", "broke", "broken", "breaking")),
    ("spend", ("spends", "spent", "spending")),
    ("cut", ("cuts", "cutting")),
    ("rise", ("rises", "rose", "risen", "rising")),
    ("drive", ("drives", "drove", "driven", "driving")),
    ("buy", ("buys", "bought", "buying")),
    ("wear", ("wears", "wore", "worn", "wearing")),
    ("choose", ("chooses", "chose", "chosen", "choosing")),
    ("eat", ("eats", "ate", "eaten", "eating")),
    ("drink", ("drinks", "drank", "drunk", "drinking")),
    ("sleep", ("sleeps", "slept", "sleeping")),
    ("wake", ("wakes", "woke", "woken", "waking")),
    ("win", ("wins", "won", "winning")),
    ("sing", ("sings", "sang", "sung", "singing")),
    ("swim", ("swims", "swam", "swum", "swimming")),
    ("throw", ("throws", "threw", "thrown", "throwing")),
    ("fly", ("flies", "flew", "flown", "flying")),
    ("forget", ("forgets", "forgot", "forgotten", "forgetting")),
    ("freeze", ("freezes", "froze", "frozen", "freezing")),
    ("hide", ("hides", "hid", "hidden", "hiding")),
    ("ride", ("rides", "rode", "ridden", "riding")),
    ("ring", ("rings", "rang", "rung", "ringing")),
    ("shake", ("shakes", "shook", "shaken", "shaking")),
    ("shine", ("shines", "shone", "shining")),
    ("shoot", ("shoots", "shot", "shooting")),
    ("shut", ("shuts", "shutting")),
    ("sink", ("sinks", "sank", "sunk", "sinking")),
    ("steal", ("steals", "stole", "stolen", "stealing")),
    ("stick", ("sticks", "stuck", "sticking")),
    ("strike", ("strikes", "struck", "striking")),
    ("swear", ("swears", "swore", "sworn", "swearing")),
    ("sweep", ("sweeps", "swept", "sweeping")),
    ("tear", ("tears", "tore", "torn", "tearing")),
    ("weep", ("weeps", "wept", "weeping")),
    ("wind", ("winds", "wound", "winding")),
    ("bend", ("bends", "bent", "bending")),
    ("bite", ("bites", "bit", "bitten", "biting")),
    ("blow", ("blows", "blew", "blown", "blowing")),
    ("catch", ("catches", "caught", "catching")),
    ("dig", ("digs", "dug", "digging")),
    ("feed", ("feeds", "fed", "feeding")),
    ("fight", ("fights", "fought", "fighting")),
    ("flee", ("flees", "fled", "fleeing")),
    ("forbid", ("forbids", "forbade", "forbidden", "forbidding")),
    ("forgive", ("forgives", "forgave", "forgiven", "forgiving")),
    ("hang", ("hangs", "hung", "hanging")),
    ("lay", ("lays", "laid", "laying")),
    ("lend", ("lends", "lent", "lending")),
    ("light", ("lights", "lit", "lighting")),
    ("mistake", ("mistakes", "mistook", "mistaken", "mistaking")),
    ("seek", ("seeks", "sought", "seeking")),
    ("sell", ("sells", "sold", "selling")),
    ("teach", ("teaches", "taught", "teaching")),
    ("withdraw", ("withdraws", "withdrew", "withdrawn", "withdrawing")),
    ("arise", ("arises", "arose", "arisen", "arising")),
    ("awake", ("awakes", "awoke", "awoken", "awaking")),
    ("bear", ("bears", "bore", "born", "bearing")),
    ("beat", ("beats", "beaten", "beating")),
    ("bind", ("binds", "bound", "binding")),
    ("breed", ("breeds", "bred", "breeding")),
    ("cast", ("casts", "casting")),
    ("cling", ("clings", "clung", "clinging")),
    ("creep", ("creeps", "crept", "creeping")),
    ("deal", ("deals", "dealt", "dealing")),
    ("dream", ("dreams", "dreamt", "dreaming")),
    ("dwell", ("dwells", "dwelt", "dwelling")),
    ("kneel", ("kneels", "knelt", "kneeling")),
    ("lean", ("leans", "leant", "leaning")),
    ("leap", ("leaps", "leapt", "leaping")),
    ("spit", ("spits", "spat", "spitting")),
    ("split", ("splits", "splitting")),
    ("spread", ("spreads", "spreading")),
    ("spring", ("springs", "sprang", "sprung", "springing")),
    ("sting", ("stings", "stung", "stinging")),
    ("stink", ("stinks", "stank", "stunk", "stinking")),
    ("stride", ("strides", "strode", "striding")),
    ("string", ("strings", "strung", "stringing")),
    ("swing", ("swings", "swung", "swinging")),
    ("undergo", ("undergoes", "underwent", "undergone", "undergoing")),
    ("uphold", ("upholds", "upheld", "upholding")),
    ("upset", ("upsets", "upsetting")),
    ("weave", ("weaves", "wove", "woven", "weaving")),
    # 不规则复数
    ("child", ("children",)),
    ("man", ("men",)),
    ("woman", ("women",)),
    ("person", ("people",)),
    ("foot", ("feet",)),
    ("tooth", ("teeth",)),
    ("mouse", ("mice",)),
    ("goose", ("geese",)),
    ("ox", ("oxen",)),
    ("life", ("lives",)),
    ("wife", ("wives",)),
    ("knife", ("knives",)),
    ("leaf", ("leaves",)),
    ("half", ("halves",)),
    ("shelf", ("shelves",)),
    ("wolf", ("wolves",)),
    ("thief", ("thieves",)),
    ("self", ("selves",)),
    ("loaf", ("loaves",)),
    ("calf", ("calves",)),
    ("elf", ("elves",)),
    # 不规则比较级/最高级
    ("good", ("better", "best")),
    ("bad", ("worse", "worst")),
    ("far", ("further", "furthest", "farther", "farthest")),
    ("little", ("less", "least")),
    ("much", ("more", "most")),
)
IRREGULAR: dict[str, str] = {
    form: lemma for lemma, forms in _IRREGULAR_GROUPS for form in forms
}


# ---------------------------------------------------------------------------
# 纯函数（测试直接调用）
# ---------------------------------------------------------------------------

def is_candidate(word: str) -> bool:
    """词表候选：纯字母、1–2 字母只留功能词、去掉已知噪声 token。"""
    if not _WORD_RE.fullmatch(word) or word in _JUNK:
        return False
    if len(word) <= 2 and word not in _SHORT_OK:
        return False
    return True


def normalize_token(raw: str) -> str:
    """内容 token → 小写裸词（保留内部撇号/连字符，供运行期归一化使用）。"""
    return raw.replace("\u2019", "'").lower()


def candidate_lemmas(token: str) -> set[str]:
    """由屈折后缀生成候选 lemma（规则剥离，不保证正确性）。"""
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
        if len(stem) >= 3 and stem[-1] == stem[-2] and stem[-1] not in _VOWELS:
            out.add(stem[:-1])
    if token.endswith("ing") and n > 5:
        out.add(token[:-3])
        out.add(token[:-3] + "e")
        stem = token[:-3]
        if len(stem) >= 3 and stem[-1] == stem[-2] and stem[-1] not in _VOWELS:
            out.add(stem[:-1])
    return {
        candidate
        for candidate in out
        if len(candidate) >= 2 and _WORD_RE.fullmatch(candidate)
    }


def fold_lemma(token: str, zipf: dict[str, float], *, tolerance: float = 1.0) -> str:
    """把屈折形式折回 lemma；拿不准就保留原词（频带不受影响）。

    规则：
    1. 内置不规则表优先（went→go）；
    2. 后缀规则生成候选，只接受「候选本身在词表中且频次不低于原词
       ``tolerance`` 个 zipf」的候选，避免 running→runn、news→new 之类误折；
    3. 多个候选取频次最高者。
    """
    token_zipf = zipf.get(token)
    if token_zipf is None:
        return token
    candidates: list[str] = []
    irregular = IRREGULAR.get(token)
    if irregular:
        candidates.append(irregular)
    candidates.extend(candidate_lemmas(token))
    best: str | None = None
    best_zipf = -1.0
    for candidate in candidates:
        candidate_zipf = zipf.get(candidate)
        if candidate_zipf is None:
            continue
        if candidate_zipf < token_zipf - tolerance:
            continue
        if candidate_zipf > best_zipf:
            best = candidate
            best_zipf = candidate_zipf
    return best or token


def cefr_for_rank(rank: int) -> str:
    """秩 → CEFR 锚点；超出最后锚点（>10k）返回 ``C1``（调用方用 beyond 桶）。"""
    for cut, level in CEFR_ANCHORS:
        if rank <= cut:
            return level
    return CEFR_LEVELS[-1]


def band_for_rank(rank: int, band_size: int) -> int:
    return (rank - 1) // band_size + 1


def band_counts(ranks: int, band_size: int) -> dict[int, int]:
    total = ranks
    full, rest = divmod(total, band_size)
    counts = {band: band_size for band in range(1, full + 1)}
    if rest:
        counts[full + 1] = rest
    return counts


def cefr_probs(limit: int, band_size: int) -> dict[str, dict[str, float]]:
    """频带 → CEFR 概率（表外词的推断层；§4.5 的「不给硬标签」）。

    每个等级以锚点区间中点为均值、半宽为 σ 做高斯权重，再按带内平均归一。
    """
    import math

    intervals: list[tuple[str, float, float]] = []
    previous = 0
    for cut, level in CEFR_ANCHORS:
        center = (previous + 1 + min(cut, limit)) / 2.0
        sigma = max(1.0, (min(cut, limit) - previous) / 2.0)
        intervals.append((level, center, sigma))
        previous = cut
    result: dict[str, dict[str, float]] = {}
    band = 1
    start = 1
    while start <= limit:
        end = min(limit, start + band_size - 1)
        midpoint = (start + end) / 2.0
        raw = {
            level: math.exp(-((midpoint - center) ** 2) / (2 * sigma**2))
            for level, center, sigma in intervals
        }
        total = sum(raw.values()) or 1.0
        result[str(band)] = {
            level: round(weight / total, 4) for level, weight in raw.items()
        }
        band += 1
        start = end + 1
    return result


def canonical_payload(document: dict) -> bytes:
    """参与完整性哈希的规范载荷（不含 integrity 自身与展示元数据）。"""
    payload = {
        "entries": document["entries"],
        "forms": document["forms"],
        "band_size": document["band_size"],
        "cefr_anchors": document["cefr_anchors"],
        "limit": document["counts"]["lemmas"],
        "version": document["version"],
    }
    return json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def payload_sha256(document: dict) -> str:
    return hashlib.sha256(canonical_payload(document)).hexdigest()


# ---------------------------------------------------------------------------
# 数据源
# ---------------------------------------------------------------------------

def load_from_wordfreq(limit: int) -> tuple[list[tuple[str, float]], dict[str, Any]]:
    """用 wordfreq 生成 (word, relative_frequency) 列表（按频次降序）。"""
    try:
        from wordfreq import top_n_list, zipf_frequency  # type: ignore
    except ImportError as exc:  # pragma: no cover - 由调用方/README 覆盖
        raise SystemExit(
            "未安装 wordfreq。请先 `python3 -m pip install wordfreq==3.1.1`，"
            "或用 --freq-tsv 从离线快照构建。"
        ) from exc
    try:
        version = importlib.metadata.version("wordfreq")
    except importlib.metadata.PackageNotFoundError:  # pragma: no cover
        version = SOURCE_VERSION
    # 多留 6 倍候选，折叠屈折后仍能取到 limit 个 lemma；大词表覆盖更全。
    candidate_count = min(200_000, max(limit * 6, 60_000))
    words = [
        word
        for word in top_n_list("en", candidate_count, wordlist="large")
        if is_candidate(word)
    ]
    zipf = {word: zipf_frequency(word, "en") for word in words}
    # zipf = log10(每十亿词频次) → 相对频次
    frequencies = {word: 10 ** (zipf[word] - 9) for word in words}
    ordered = sorted(words, key=lambda word: (-frequencies[word], word))
    meta = {
        "name": SOURCE_NAME,
        "version": version,
        "candidate_words": len(words),
        "wordlist": "large",
    }
    return [(word, frequencies[word]) for word in ordered], {"zipf": zipf, **meta}


def load_from_tsv(
    path: Path, limit: int
) -> tuple[list[tuple[str, float]], dict[str, Any]]:
    """从 ``word<TAB>count`` 快照生成列表（离线/测试路径）。"""
    words: list[tuple[str, float]] = []
    seen: set[str] = set()
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) != 2:
                raise SystemExit(f"{path}:{line_number} 需要 word<TAB>count")
            word, raw_count = parts[0].strip().lower(), parts[1].strip()
            if not is_candidate(word):
                continue
            if word in seen:
                continue
            try:
                count = float(raw_count)
            except ValueError as exc:
                raise SystemExit(
                    f"{path}:{line_number} count 不是数字：{raw_count!r}"
                ) from exc
            if count <= 0:
                continue
            seen.add(word)
            words.append((word, count))
    words.sort(key=lambda row: (-row[1], row[0]))
    # 快照路径下「可比频次」就是原始 count；fold_lemma 只做相对比较。
    zipf = {word: count for word, count in words}
    return words, {
        "name": f"tsv:{path.name}",
        "version": "snapshot",
        "candidate_words": len(words),
        "wordlist": "custom",
        "zipf": zipf,
    }


# ---------------------------------------------------------------------------
# 构建
# ---------------------------------------------------------------------------

def build_document(
    ranked_source: Iterable[tuple[str, float]],
    *,
    limit: int = DEFAULT_LIMIT,
    band_size: int = DEFAULT_BAND_SIZE,
    source_meta: dict[str, Any] | None = None,
    version: str = ARTIFACT_VERSION,
    require_full: bool = True,
) -> dict:
    """把 (word, frequency) 列表折叠成 lemma 频带，返回产物文档。"""
    source = list(ranked_source)
    if require_full and len(source) < limit:
        raise SystemExit(f"候选词不足：{len(source)} < {limit}")
    zipf: dict[str, float] = dict((source_meta or {}).get("zipf") or {})
    if not zipf:
        # TSV 快照：zipf 表就是原始频次（比较用相对大小即可）。
        zipf = {word: frequency for word, frequency in source}

    lemma_of: dict[str, str] = {}
    aggregated: dict[str, float] = {}
    for word, frequency in source:
        lemma = fold_lemma(word, zipf)
        lemma_of[word] = lemma
        aggregated[lemma] = aggregated.get(lemma, 0.0) + frequency

    ranked = sorted(aggregated, key=lambda lemma: (-aggregated[lemma], lemma))[:limit]
    rank = {lemma: index + 1 for index, lemma in enumerate(ranked)}
    entries = [[lemma, rank[lemma]] for lemma in ranked]

    forms: dict[str, str] = {}
    for word in sorted(lemma_of):
        lemma = lemma_of[word]
        if word != lemma and lemma in rank:
            forms[word] = lemma

    by_cefr = {level: 0 for level in CEFR_LEVELS}
    by_band: dict[str, int] = {}
    for lemma, position in rank.items():
        by_cefr[cefr_for_rank(position)] += 1
        band = band_for_rank(position, band_size)
        by_band[str(band)] = by_band.get(str(band), 0) + 1

    document: dict[str, Any] = {
        "schema": SCHEMA,
        "version": version,
        "license": DATA_LICENSE,
        "licenseUrl": LICENSE_URL,
        "source": {
            "name": SOURCE_NAME if source_meta is None else source_meta["name"],
            "version": (
                SOURCE_VERSION if source_meta is None else str(source_meta["version"])
            ),
            "url": SOURCE_URL,
            "dataLicense": DATA_LICENSE,
            "method": (
                "wordfreq zipf_frequency → 相对频次；自写屈折规则 + 内置不规则表"
                "折叠 lemma；按 lemma 聚合频次排序取前 N；每 band_size 一个频带。"
                "不包含 ECDICT 词形数据。"
            ),
        },
        "counts": {
            "lemmas": len(entries),
            "forms": len(forms),
            "bands": len(by_band),
            "candidates": len(source),
            "by_cefr": by_cefr,
            "by_band": dict(sorted(by_band.items(), key=lambda item: int(item[0]))),
        },
        "band_size": band_size,
        "limit": limit,
        "cefr_anchors": [
            {"max_rank": cut, "level": level} for cut, level in CEFR_ANCHORS
        ],
        "cefr_probs": cefr_probs(limit, band_size),
        "entries": entries,
        "forms": forms,
    }
    document["integrity"] = {
        "algorithm": "sha256",
        "scope": "entries+forms+band_size+cefr_anchors+limit+version",
        "sha256": payload_sha256(document),
    }
    return document


def serialize(document: dict) -> str:
    return json.dumps(document, ensure_ascii=False, indent=1) + "\n"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_document(document: dict, *, expected_limit: int | None = None) -> list[str]:
    """机器可检的产物契约；返回问题列表（空 = 通过）。"""
    problems: list[str] = []

    def require(condition: bool, message: str) -> None:
        if not condition:
            problems.append(message)

    require(document.get("schema") == SCHEMA, f"schema 必须是 {SCHEMA}")
    require(bool(document.get("version")), "缺少 version")
    require(document.get("license") == DATA_LICENSE, f"license 必须是 {DATA_LICENSE}")
    source = document.get("source")
    require(isinstance(source, dict), "缺少 source")
    if isinstance(source, dict):
        require(bool(source.get("name")), "source.name 缺失")
        require(bool(source.get("version")), "source.version 缺失")
        require(bool(source.get("url")), "source.url 缺失")
        require(bool(source.get("method")), "source.method 缺失")
    entries = document.get("entries")
    require(isinstance(entries, list) and bool(entries), "entries 必须是非空数组")
    if not isinstance(entries, list):
        return problems
    limit = expected_limit or int(document.get("limit") or len(entries))
    require(len(entries) == limit, f"entries 数量 {len(entries)} != limit {limit}")
    ranks = []
    seen: set[str] = set()
    for index, entry in enumerate(entries):
        if not (isinstance(entry, list) and len(entry) == 2):
            problems.append(f"entries[{index}] 必须是 [lemma, rank]")
            return problems
        lemma, rank = entry
        if not isinstance(lemma, str) or not _WORD_RE.fullmatch(lemma):
            problems.append(f"entries[{index}] lemma 非法：{lemma!r}")
            return problems
        if lemma in seen:
            problems.append(f"lemma 重复：{lemma}")
            return problems
        seen.add(lemma)
        if not isinstance(rank, int) or rank != index + 1:
            problems.append(f"entries[{index}] rank 必须连续且等于 {index + 1}")
            return problems
        ranks.append(rank)
    forms = document.get("forms")
    require(isinstance(forms, dict), "forms 必须是对象")
    if isinstance(forms, dict):
        known = set(seen)
        bad = [
            f"{form}->{lemma}"
            for form, lemma in forms.items()
            if not isinstance(form, str)
            or not isinstance(lemma, str)
            or lemma not in known
            or not _WORD_RE.fullmatch(form)
            or form == lemma
        ]
        require(not bad, f"forms 有非法映射（示例：{bad[:5]}）")
    band_size = document.get("band_size")
    require(isinstance(band_size, int) and band_size >= 100, "band_size 必须 ≥100")
    if isinstance(band_size, int) and isinstance(entries, list):
        require(
            len(entries) % band_size == 0 or len(entries) > band_size,
            "频带划分异常",
        )
    anchors = document.get("cefr_anchors")
    require(
        isinstance(anchors, list) and [a.get("level") for a in anchors if isinstance(a, dict)]
        == list(CEFR_LEVELS),
        "cefr_anchors 等级序列必须是 " + "/".join(CEFR_LEVELS),
    )
    integrity = document.get("integrity")
    require(isinstance(integrity, dict), "缺少 integrity")
    if isinstance(integrity, dict):
        require(
            integrity.get("sha256") == payload_sha256(document),
            "integrity.sha256 与内容不一致",
        )
    return problems


def write_artifact(document: dict, out: Path, *, sidecar: Path | None = None) -> str:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(serialize(document), encoding="utf-8")
    digest = file_sha256(out)
    if sidecar is not None:
        sidecar.write_text(f"{digest}  {out.name}\n", encoding="utf-8")
    return digest


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="构建语途自建英语频表")
    source = parser.add_mutually_exclusive_group()
    source.add_argument(
        "--from-wordfreq",
        action="store_true",
        help="从 wordfreq（CC BY-SA 4.0 数据）构建（默认）",
    )
    source.add_argument(
        "--freq-tsv",
        type=Path,
        help="从 word<TAB>count 快照构建（离线/测试）",
    )
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--sidecar", type=Path, default=None)
    parser.add_argument("--write-sidecar", action="store_true")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--band-size", type=int, default=DEFAULT_BAND_SIZE)
    parser.add_argument("--version", default=ARTIFACT_VERSION)
    parser.add_argument(
        "--check",
        action="store_true",
        help="只校验已提交产物（不重建），退出码 0/1",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.limit < 100:
        print("--limit 至少 100（避免把测试产物误当正式频表）", file=sys.stderr)
        return 2
    if args.band_size < 100:
        print("--band-size 至少 100", file=sys.stderr)
        return 2

    if args.check:
        if not args.out.exists():
            print(f"产物不存在：{args.out}", file=sys.stderr)
            return 1
        try:
            document = json.loads(args.out.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"无法解析产物：{exc}", file=sys.stderr)
            return 1
        problems = validate_document(document)
        if problems:
            for problem in problems:
                print(f"ERR  {problem}", file=sys.stderr)
            return 1
        print(
            f"OK  {args.out.name}: {document['counts']['lemmas']} lemmas, "
            f"{document['counts']['bands']} bands, license={document['license']}, "
            f"sha256={document['integrity']['sha256'][:16]}…"
        )
        return 0

    if args.freq_tsv is not None:
        if not args.freq_tsv.exists():
            print(f"频次快照不存在：{args.freq_tsv}", file=sys.stderr)
            return 2
        source_rows, source_meta = load_from_tsv(args.freq_tsv, args.limit)
        require_full = False
    else:
        source_rows, source_meta = load_from_wordfreq(args.limit)
        require_full = True

    document = build_document(
        source_rows,
        limit=args.limit,
        band_size=args.band_size,
        source_meta=source_meta,
        version=args.version,
        require_full=require_full,
    )
    problems = validate_document(document)
    if problems:
        for problem in problems:
            print(f"ERR  {problem}", file=sys.stderr)
        return 1
    sidecar = args.sidecar or (DEFAULT_SIDECAR if args.write_sidecar else None)
    digest = write_artifact(document, args.out, sidecar=sidecar)
    counts = document["counts"]
    print(
        f"已写入 {args.out}：{counts['lemmas']} lemmas / {counts['forms']} forms / "
        f"{counts['bands']} bands；license={document['license']}；"
        f"文件 sha256={digest[:16]}…"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
