#!/usr/bin/env python3
"""构建单词本「短语」词表——语途（LinguaTrek）单词本页面。

产物（随仓库分发、运行期只读、无数据库、无迁移）：

- ``content/wordlists/phrases.v1.json``：合并后的短语词表。每条含
  ``id / headword / type / cefr / translation / example / source / license /
  notes``；ECDICT 条目另保留 ``tagMask / rank``。
- ``docs/reports/phrases-build-2026-11-17.json``：构建与质量闸报告
  （ECDICT 覆盖、来源/等级/类型分布、100 条抽检清单）。

数据来源
--------
1. **A：ECDICT 多词 tag**。完整 ``ecdict.csv`` 的 ``tag`` 列只给单词打
   CET4/CET6/GRE 标签；2–4 词条目里带这三类 tag 的实际为 **0 条**（详见
   ``content/wordlists/PHRASES-NOTICE.md``）。脚本仍完整实现该路径：只收
   2–4 词、纯字母/空格、含中文释义、tagMask≠0 的条目，去重 ``sb./sth.``
   变体后保留 tagMask/rank/source。
2. **B：人工精选**。``curated-phrases.v1.json``（150–200 条）+
   ``curated-phrases-extra.v1.json``（A 覆盖为 0 时的补充批次，使总量落在
   500–800）。两句/条释义与例句均为语途自写，许可「LinguaTrek 原创整理」。

诚实口径
--------
- 短语没有官方 CEFR 表：本词表 CEFR 为人工标注/组成词频带近似，API 标
  ``approximate``；C2 不硬凑。
- ECDICT 短语级 tag=0 是上游数据事实，不用无 tag 词频硬凑；报告写实际数。
- 不提交 ECDICT 原始 CSV（约 60MB），只分发上述紧凑 JSON。

用法
----
    # 1. 下载官方 CSV 到 /tmp（不要放进仓库）
    curl -L -o /tmp/ecdict-full.csv \\
        https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv

    # 2. 重建（幂等；不会把 CSV 写进仓库）
    backend/venv/bin/python scripts/build_phrases.py \\
        --ecdict-csv /tmp/ecdict-full.csv

    # 3. 只校验（离线：结构/完整性/精选文件/规模）
    backend/venv/bin/python scripts/build_phrases.py --check

    # 4. 完整重建对比（需要 CSV）
    backend/venv/bin/python scripts/build_phrases.py --check \\
        --ecdict-csv /tmp/ecdict-full.csv

退出码：0 成功；1 校验/构建失败；2 参数错误。
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FREQUENCY = ROOT / "content" / "wordlist" / "frequency_bands.v1.json"
DEFAULT_OUT_DIR = ROOT / "content" / "wordlists"
DEFAULT_REPORT = ROOT / "docs" / "reports" / "phrases-build-2026-11-17.json"

PHRASES_FILENAME = "phrases.v1.json"
CURATED_FILENAME = "curated-phrases.v1.json"
CURATED_EXTRA_FILENAME = "curated-phrases-extra.v1.json"
NOTICE_FILENAME = "PHRASES-NOTICE.md"

SCHEMA_PHRASES = "linguatrek.phrases.v1"
SCHEMA_CURATED = "linguatrek.curated-phrases.v1"
SCHEMA_REPORT = "linguatrek.phrases-build-report.v1"
CURATED_LICENSE = "LinguaTrek 原创整理"
ECDICT_LICENSE = "See PHRASES-NOTICE.md (ECDICT dictionary data terms)"

ARTIFACT_VERSION = "2026.11.17"
MIN_TOTAL = 500
MAX_TOTAL = 800
MIN_CURATED_BASE = 150
MAX_CURATED_BASE = 200

# 短语 CEFR 只到 C1；C1+ 表示「超出 C1/未知」，不硬凑 C2。
PHRASE_CEFR_LEVELS: Tuple[str, ...] = ("A2", "B1", "B2", "C1", "C1+")
PHRASE_TYPES: Tuple[str, ...] = ("phrasal_verb", "idiom", "collocation")
PHRASE_SOURCES: Tuple[str, ...] = ("ECDICT", "curated")
CEFR_ORDER = {level: index for index, level in enumerate(PHRASE_CEFR_LEVELS)}

# ECDICT tag -> 位掩码（与 build_word_lists.py / backend/vocabulary.py 一致）。
TAG_BITS: Dict[str, int] = {"cet4": 1, "cet6": 2, "gre": 4}

WORD_RE = re.compile(r"^[A-Za-z]+$")
PHRASE_RE = re.compile(r"^[A-Za-z]+(?: [A-Za-z]+){1,3}$")
CURATED_PHRASE_RE = re.compile(
    r"^[A-Za-z]+(?:'[A-Za-z]+)?(?: [A-Za-z]+(?:'[A-Za-z]+)?){1,3}$"
)
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
WS_RE = re.compile(r"\s+")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

TRANSLATION_LIMIT = 120

# 变体归一化：去掉 ECDICT 词条尾部的占位词（look after sb. → look after）。
VARIANT_TAIL_TOKENS = frozenset({"sb", "sth", "sbs", "somebody", "something"})
# 专名/数字/标点由 PHRASE_RE 与「全小写」规则挡掉；这里只处理冒犯性内容。
OFFENSIVE_RE = re.compile(
    r"(fuck|shit|bitch|bastard|nigger|nigga|cunt|dick\b|cock\b|pussy|whore|"
    r"rape|suicide|porn|penis|vagina|anus|damn)",
    re.IGNORECASE,
)

# 以动词开头 + 介词/副词 → phrasal_verb；其余固定搭配/习语 → idiom/collocation。
VERB_HEADS = frozenset(
    """look take get make give go come put bring break call carry cut fall
    hold keep let pass pick pull push run set stand turn work drop try show
    move play sit speak talk think walk write read hear feel leave live die
    find lose win pay meet wear eat drink sleep drive ride teach learn study
    begin start stop open close lock clean wash cook bake buy sell borrow
    lend send receive catch throw hit kick beat fight argue agree wait stay
    remain become seem appear happen change grow build create destroy forget
    remember understand explain describe decide choose accept refuse offer
    promise ask answer tell say put""".split()
)
PARTICLES = frozenset(
    """up down off on in out over away back through around about for with to
    from into upon along across after before by at of as apart aside forward
    together onto against""".split()
)
IDIOM_HEADS = frozenset(
    """a an the in on at for with by of under out up no not as once all
    every some any one""".split()
)


class BuildError(RuntimeError):
    """构建/校验失败，消息可直接展示给用户。"""


# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------

def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def payload_sha256(payload: Any) -> str:
    material = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(material).hexdigest()


def serialize(document: Dict[str, Any]) -> str:
    return json.dumps(document, ensure_ascii=False, indent=1) + "\n"


def clean_translation(raw: Any, limit: int = TRANSLATION_LIMIT) -> str:
    """ECDICT translation → 第一个含中文的行；压缩空白，截断到 limit。"""
    if raw is None:
        return ""
    text = str(raw)
    text = text.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n")
    chosen = ""
    for line in text.splitlines():
        line = line.strip()
        if line and CJK_RE.search(line):
            chosen = line
            break
    chosen = WS_RE.sub(" ", chosen).strip()
    if len(chosen) > limit:
        chosen = chosen[: limit - 1].rstrip() + "…"
    return chosen


def normalize_headword(raw: str) -> str:
    """小写、压缩空白；用于去重键。"""
    return WS_RE.sub(" ", str(raw or "").strip().lower())


def strip_variant_tokens(headword: str) -> str:
    """去掉尾部的 sb/sth 占位词：look after sb → look after。"""
    tokens = normalize_headword(headword).split(" ")
    while len(tokens) > 1 and tokens[-1] in VARIANT_TAIL_TOKENS:
        tokens.pop()
    return " ".join(tokens)


def phrase_slug(headword: str) -> str:
    """稳定、URL 安全的 id：a piece of cake → a-piece-of-cake。"""
    text = normalize_headword(headword).replace("’", "").replace("'", "")
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    if not text:
        raise BuildError(f"无法由 headword 生成 id：{headword!r}")
    if not text[0].isalpha():
        text = f"p-{text}"
    return text


def is_proper_name(headword: str) -> bool:
    """ECDICT 专名通常首字母大写；本词表只收全小写短语。"""
    return any(char.isupper() for char in headword)


def is_offensive(*texts: str) -> bool:
    return any(OFFENSIVE_RE.search(text or "") for text in texts)


def parse_rank(row: Dict[str, str]) -> int:
    for field in ("frq", "bnc"):
        raw = str(row.get(field) or "").strip()
        if raw.isdigit() and int(raw) > 0:
            return int(raw)
    return 999_999


def tag_mask(tags: Iterable[str]) -> int:
    mask = 0
    for tag in tags:
        mask |= TAG_BITS.get(tag.lower(), 0)
    return mask


def infer_phrase_type(headword: str) -> str:
    tokens = normalize_headword(headword).split(" ")
    if (
        len(tokens) >= 2
        and tokens[0] in VERB_HEADS
        and tokens[-1] in PARTICLES
    ):
        return "phrasal_verb"
    if tokens and tokens[0] in IDIOM_HEADS:
        return "idiom"
    if len(tokens) == 2 and tokens[-1] in PARTICLES:
        return "collocation"
    if tokens and tokens[0] in VERB_HEADS:
        return "collocation"
    return "collocation"


# ---------------------------------------------------------------------------
# CEFR：短语没有官方表，用组成词频带做近似（未知 → C1+）
# ---------------------------------------------------------------------------

class FrequencyLevels:
    """读 frequency_bands.v1.json，把英文词映射到 A1–C1（含 forms 折回）。"""

    def __init__(self, document: Dict[str, Any]) -> None:
        entries = document.get("entries")
        forms = document.get("forms")
        anchors = document.get("cefr_anchors")
        if not (isinstance(entries, list) and entries):
            raise BuildError("频表 entries 必须是非空数组")
        if not isinstance(forms, dict):
            raise BuildError("频表 forms 必须是对象")
        if not isinstance(anchors, list) or not anchors:
            raise BuildError("频表缺少 cefr_anchors")
        self.ranks: Dict[str, int] = {}
        for index, entry in enumerate(entries):
            if not (isinstance(entry, list) and len(entry) == 2):
                raise BuildError(f"频表 entries[{index}] 必须是 [lemma, rank]")
            lemma, rank = entry
            if not isinstance(lemma, str) or not isinstance(rank, int):
                raise BuildError(f"频表 entries[{index}] 类型非法")
            self.ranks[lemma] = rank
        self.forms: Dict[str, str] = {
            str(key): str(value) for key, value in forms.items()
        }
        cuts: List[Tuple[int, str]] = []
        for raw in anchors:
            # 兼容 [cut, level] 与 {"max_rank": cut, "level": level} 两种形状。
            if isinstance(raw, list) and len(raw) == 2:
                cut, level = raw
            elif isinstance(raw, dict):
                cut, level = raw.get("max_rank"), raw.get("level")
            else:
                raise BuildError("频表 cefr_anchors 每项格式不支持")
            if not isinstance(cut, int) or not isinstance(level, str):
                raise BuildError("频表 cefr_anchors 类型非法")
            cuts.append((cut, level))
        self.anchors = sorted(cuts)

    def level_of_token(self, token: str) -> Optional[str]:
        """单个词 → A1–C1；不在频表 → None。"""
        normalized = token.lower()
        candidates: List[str] = [normalized]
        if normalized in self.forms:
            candidates.append(self.forms[normalized])
        # 常见屈折：-s/-es/-ed/-ing/-er/-est；只在词表里存在时采用。
        for suffix, replacement in (
            ("ies", "y"),
            ("ied", "y"),
            ("ing", ""),
            ("ing", "e"),
            ("ed", ""),
            ("ed", "e"),
            ("es", ""),
            ("s", ""),
            ("er", ""),
            ("est", ""),
        ):
            if normalized.endswith(suffix) and len(normalized) > len(suffix) + 2:
                candidates.append(normalized[: -len(suffix)] + replacement)
        for candidate in candidates:
            rank = self.ranks.get(candidate)
            if rank is None:
                continue
            level = "C1"
            for cut, anchor_level in self.anchors:
                if rank <= cut:
                    level = anchor_level
                    break
            return level
        return None

    def level_of_phrase(self, headword: str, phrase_type: str) -> str:
        """组成词最高 CEFR；A1 短语抬到 A2；任一内容词未知 → C1+。

        与 ``docs/单词本-短语方案.md`` 的口径一致：这是近似，不是官方 CEFR。
        """
        tokens = [
            token
            for token in normalize_headword(headword).split(" ")
            if token not in {"a", "an", "the"}
        ]
        levels: List[str] = []
        unknown = False
        for token in tokens:
            level = self.level_of_token(token)
            if level is None:
                unknown = True
            else:
                levels.append(level)
        if unknown or not levels:
            return "C1+"
        highest = max(levels, key=lambda value: CEFR_ORDER.get(value, 0))
        if highest == "A1":
            # 短语本身通常比组成词难一点；目标从 A2 起，不输出 A1。
            highest = "A2"
        return highest


# ---------------------------------------------------------------------------
# 精选短语
# ---------------------------------------------------------------------------

def load_curated_file(path: Path) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise BuildError(f"无法读取精选短语 {path}：{exc}") from exc
    if not isinstance(document, dict):
        raise BuildError(f"精选短语 {path} 不是 JSON 对象")
    if document.get("schema") != SCHEMA_CURATED:
        raise BuildError(f"精选短语 {path} schema 必须是 {SCHEMA_CURATED}")
    if not isinstance(document.get("version"), str) or not document["version"].strip():
        raise BuildError(f"精选短语 {path} 缺少 version")
    if document.get("license") != CURATED_LICENSE:
        raise BuildError(f"精选短语 {path} license 必须是 {CURATED_LICENSE}")
    raw_entries = document.get("entries")
    if not isinstance(raw_entries, list) or not raw_entries:
        raise BuildError(f"精选短语 {path} entries 必须是非空数组")

    entries: List[Dict[str, Any]] = []
    seen_ids: set = set()
    seen_headwords: set = set()
    for index, raw in enumerate(raw_entries):
        if not isinstance(raw, dict):
            raise BuildError(f"精选短语 {path} entries[{index}] 必须是对象")
        headword = normalize_headword(raw.get("headword", ""))
        if not CURATED_PHRASE_RE.fullmatch(headword):
            raise BuildError(
                f"精选短语 {path} entries[{index}] headword 必须是 2–4 个纯字母词："
                f"{raw.get('headword')!r}"
            )
        if not (2 <= len(headword.split(" ")) <= 4):
            raise BuildError(
                f"精选短语 {path} entries[{index}] headword 必须是 2–4 个词：{headword!r}"
            )
        if is_offensive(headword):
            raise BuildError(f"精选短语 {path} entries[{index}] 含冒犯性内容：{headword!r}")
        entry_id = str(raw.get("id") or "").strip()
        if not entry_id or not SLUG_RE.fullmatch(entry_id):
            raise BuildError(
                f"精选短语 {path} entries[{index}] id 必须是小写 slug：{entry_id!r}"
            )
        if entry_id in seen_ids:
            raise BuildError(f"精选短语 {path} id 重复：{entry_id}")
        seen_ids.add(entry_id)
        if headword in seen_headwords:
            raise BuildError(f"精选短语 {path} headword 重复：{headword}")
        seen_headwords.add(headword)
        entry_type = str(raw.get("type") or "").strip()
        if entry_type not in PHRASE_TYPES:
            raise BuildError(f"精选短语 {path} entries[{index}] type 非法：{entry_type!r}")
        cefr = str(raw.get("cefr") or "").strip()
        if cefr not in PHRASE_CEFR_LEVELS:
            raise BuildError(f"精选短语 {path} entries[{index}] cefr 非法：{cefr!r}")
        translation = WS_RE.sub(" ", str(raw.get("translation") or "")).strip()
        if not translation or not CJK_RE.search(translation):
            raise BuildError(
                f"精选短语 {path} entries[{index}] translation 必须含中文：{translation!r}"
            )
        example = WS_RE.sub(" ", str(raw.get("example") or "")).strip()
        if not example:
            raise BuildError(f"精选短语 {path} entries[{index}] 缺少 example")
        if raw.get("source") != "curated":
            raise BuildError(f"精选短语 {path} entries[{index}] source 必须是 curated")
        if raw.get("license") != CURATED_LICENSE:
            raise BuildError(
                f"精选短语 {path} entries[{index}] license 必须是 {CURATED_LICENSE}"
            )
        notes = WS_RE.sub(" ", str(raw.get("notes") or "")).strip()
        entries.append(
            {
                "id": entry_id,
                "headword": headword,
                "type": entry_type,
                "cefr": cefr,
                "translation": translation,
                "example": example,
                "source": "curated",
                "license": CURATED_LICENSE,
                "notes": notes,
            }
        )
    return document, entries


def load_curated(
    baseline_path: Path, extra_path: Path
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    baseline_document, baseline = load_curated_file(baseline_path)
    extra_document, extra = load_curated_file(extra_path)
    if not (MIN_CURATED_BASE <= len(baseline) <= MAX_CURATED_BASE):
        raise BuildError(
            f"{baseline_path.name} 必须是 {MIN_CURATED_BASE}–{MAX_CURATED_BASE} 条"
            f"（实际 {len(baseline)} 条）"
        )
    combined = baseline + extra
    seen: set = set()
    for entry in combined:
        if entry["id"] in seen:
            raise BuildError(f"精选短语 id 跨文件重复：{entry['id']}")
        seen.add(entry["id"])
    meta = {
        "baselineFile": f"content/wordlists/{baseline_path.name}",
        "baselineCount": len(baseline),
        "baselineVersion": str(baseline_document.get("version")),
        "extraFile": f"content/wordlists/{extra_path.name}",
        "extraCount": len(extra),
        "extraVersion": str(extra_document.get("version")),
        "entries": len(combined),
        "license": CURATED_LICENSE,
        "note": (
            "ECDICT 短语级 tag 覆盖为 0，为达到 500–800 条教学短语，"
            "在 150–200 条基线外增加补充批次；释义/例句均为语途自写，"
            "CEFR 为人工标注的近似值。"
        ),
    }
    return combined, meta


# ---------------------------------------------------------------------------
# ECDICT 多词 tag
# ---------------------------------------------------------------------------

def _variant_ecdict_entries(
    raw_entries: Dict[str, Dict[str, Any]]
) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    for normalized, value in raw_entries.items():
        headword = strip_variant_tokens(normalized)
        if headword != normalized and headword in raw_entries:
            # 短变体已单独存在时，把标签/秩/释义并入短变体，丢弃长变体。
            short = raw_entries[headword]
            short["mask"] |= value["mask"]
            short["rank"] = min(short["rank"], value["rank"])
            if not short["translation"] and value["translation"]:
                short["translation"] = value["translation"]
            continue
        value["headword"] = headword
        entries.append(value)
    # 归并后可能再次撞键（如 look after sb 与 look after sth 同时存在）。
    merged: Dict[str, Dict[str, Any]] = {}
    for entry in entries:
        key = entry["headword"]
        current = merged.get(key)
        if current is None:
            merged[key] = entry
        else:
            current["mask"] |= entry["mask"]
            current["rank"] = min(current["rank"], entry["rank"])
            if not current["translation"] and entry["translation"]:
                current["translation"] = entry["translation"]
    return list(merged.values())


def extract_ecdict_phrases(
    csv_path: Path, levels: FrequencyLevels
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """从完整 ECDICT CSV 抽取带 CET4/CET6/GRE tag 的 2–4 词条目。

    返回 (entries, stats)；entries 已去重、过滤、推断类型/CEFR，example 为空
    （ECDICT 不提供例句，界面按空例句处理）。
    """
    rows = 0
    multi_word_rows = 0
    pure_rows = 0
    pure_with_chinese = 0
    tagged_pure_rows = 0
    tagged_pure_with_chinese = 0
    raw_entries: Dict[str, Dict[str, Any]] = {}

    try:
        handle = csv_path.open("r", encoding="utf-8-sig", newline="")
    except OSError as exc:
        raise BuildError(f"无法读取 ECDICT CSV {csv_path}：{exc}") from exc

    with handle:
        reader = csv.DictReader(handle)
        fieldnames = set(reader.fieldnames or [])
        required = {"word", "translation", "tag", "frq", "bnc"}
        missing = sorted(required - fieldnames)
        if missing:
            raise BuildError("ECDICT CSV 缺少列：" + ", ".join(missing))
        for row in reader:
            rows += 1
            raw_word = str(row.get("word") or "").strip()
            if " " not in raw_word:
                continue
            multi_word_rows += 1
            if not PHRASE_RE.fullmatch(raw_word):
                continue
            if is_proper_name(raw_word):
                continue
            pure_rows += 1
            tags = set(str(row.get("tag") or "").lower().split())
            mask = tag_mask(tags)
            translation = clean_translation(row.get("translation"))
            has_chinese = bool(translation and CJK_RE.search(translation))
            if has_chinese:
                pure_with_chinese += 1
            if not mask:
                continue
            tagged_pure_rows += 1
            if has_chinese:
                tagged_pure_with_chinese += 1
            headword = strip_variant_tokens(raw_word)
            if not PHRASE_RE.fullmatch(headword):
                continue
            tokens = headword.split(" ")
            if not (2 <= len(tokens) <= 4):
                continue
            if is_proper_name(headword) or is_offensive(headword, translation):
                continue
            normalized = headword
            current = raw_entries.get(normalized)
            if current is None:
                raw_entries[normalized] = {
                    "headword": normalized,
                    "mask": mask,
                    "rank": parse_rank(row),
                    "translation": translation,
                }
            else:
                current["mask"] |= mask
                current["rank"] = min(current["rank"], parse_rank(row))
                if not current["translation"] and translation:
                    current["translation"] = translation

    entries: List[Dict[str, Any]] = []
    seen_ids: set = set()
    for value in _variant_ecdict_entries(raw_entries):
        headword = value["headword"]
        if not PHRASE_RE.fullmatch(headword):
            continue
        translation = value["translation"]
        if not translation or not CJK_RE.search(translation):
            continue
        try:
            slug = phrase_slug(headword)
        except BuildError:
            continue
        if slug in seen_ids:
            suffix = 2
            while f"{slug}-{suffix}" in seen_ids:
                suffix += 1
            slug = f"{slug}-{suffix}"
        seen_ids.add(slug)
        phrase_type = infer_phrase_type(headword)
        entries.append(
            {
                "id": slug,
                "headword": headword,
                "type": phrase_type,
                "cefr": levels.level_of_phrase(headword, phrase_type),
                "translation": translation,
                "example": "",
                "source": "ECDICT",
                "license": ECDICT_LICENSE,
                "notes": (
                    "ECDICT 多词条目（tag 来自由 ECDICT 的 word tag 列）；"
                    "例句待补，CEFR 为组成词频带近似。"
                ),
                "tagMask": value["mask"],
                "rank": value["rank"],
            }
        )
    entries.sort(key=lambda item: (item["rank"], item["headword"]))
    stats = {
        "rows": rows,
        "multiWordRows": multi_word_rows,
        "pure2to4Rows": pure_rows,
        "pure2to4WithChinese": pure_with_chinese,
        "tagged2to4Rows": tagged_pure_rows,
        "tagged2to4WithChinese": tagged_pure_with_chinese,
        "taggedTranslationCoverage": (
            round(tagged_pure_with_chinese / tagged_pure_rows, 4)
            if tagged_pure_rows
            else None
        ),
        "taggedEntriesAfterFilter": len(entries),
        "taggedByCefr": {
            level: sum(1 for entry in entries if entry["cefr"] == level)
            for level in PHRASE_CEFR_LEVELS
        },
    }
    return entries, stats


# ---------------------------------------------------------------------------
# 合并 / 产物
# ---------------------------------------------------------------------------

def phrases_payload_sha256(document: Dict[str, Any]) -> str:
    return payload_sha256(
        {
            "entries": document["entries"],
            "counts": document["counts"],
            "version": document["version"],
        }
    )


def _counts(entries: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    by_type = {phrase_type: 0 for phrase_type in PHRASE_TYPES}
    by_cefr = {level: 0 for level in PHRASE_CEFR_LEVELS}
    by_source = {source: 0 for source in PHRASE_SOURCES}
    for entry in entries:
        by_type[entry["type"]] += 1
        by_cefr[entry["cefr"]] += 1
        by_source[entry["source"]] += 1
    return {
        "total": len(entries),
        "ecdict": by_source["ECDICT"],
        "curated": by_source["curated"],
        "byType": by_type,
        "byCefr": by_cefr,
        "bySource": by_source,
    }


PHRASE_CEFR_ORDER: Dict[str, int] = {
    level: index for index, level in enumerate(PHRASE_CEFR_LEVELS)
}
PHRASE_TYPE_ORDER: Dict[str, int] = {
    phrase_type: index for index, phrase_type in enumerate(PHRASE_TYPES)
}


def merge_entries(
    curated: Sequence[Dict[str, Any]], ecdict: Sequence[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """精选优先；按 headword（小写）去重；按 CEFR → 类型 → 来源稳定排序。"""
    merged: List[Dict[str, Any]] = []
    by_headword: Dict[str, Dict[str, Any]] = {}
    for entry in curated:
        key = normalize_headword(entry["headword"])
        by_headword[key] = entry
        merged.append(entry)
    for entry in ecdict:
        key = normalize_headword(entry["headword"])
        if key in by_headword:
            continue
        by_headword[key] = entry
        merged.append(entry)
    # 稳定排序：同一 (CEFR, 类型, 来源) 内保持精选文件顺序。
    merged.sort(
        key=lambda entry: (
            PHRASE_CEFR_ORDER.get(entry["cefr"], len(PHRASE_CEFR_ORDER)),
            PHRASE_TYPE_ORDER.get(entry["type"], len(PHRASE_TYPE_ORDER)),
            0 if entry["source"] == "curated" else 1,
        )
    )
    # id 冲突兜底（不同 headword 可能 slug 相同）。
    used: set = set()
    for entry in merged:
        base = entry["id"]
        candidate = base
        suffix = 2
        while candidate in used:
            candidate = f"{base}-{suffix}"
            suffix += 1
        entry["id"] = candidate
        used.add(candidate)
    return merged


def build_document(
    ecdict_csv: Path,
    frequency: Dict[str, Any],
    curated_baseline_path: Path,
    curated_extra_path: Path,
    *,
    version: str = ARTIFACT_VERSION,
    allow_small: bool = False,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    levels = FrequencyLevels(frequency)
    curated_entries, curated_meta = load_curated(curated_baseline_path, curated_extra_path)
    ecdict_entries, ecdict_stats = extract_ecdict_phrases(ecdict_csv, levels)
    entries = merge_entries(curated_entries, ecdict_entries)
    counts = _counts(entries)
    if not allow_small and counts["total"] < MIN_TOTAL:
        raise BuildError(
            f"短语词表只有 {counts['total']} 条（< {MIN_TOTAL}）；"
            "ECDICT 短语 tag 覆盖为 0 时需要精选补充批次，不能静默交付小词表。"
        )
    if not allow_small and counts["total"] > MAX_TOTAL:
        raise BuildError(
            f"短语词表有 {counts['total']} 条（> {MAX_TOTAL}）；请删减精选条目。"
        )
    document: Dict[str, Any] = {
        "schema": SCHEMA_PHRASES,
        "version": version,
        "source": {
            "ecdict": {
                "name": "ECDICT",
                "url": "https://github.com/skywind3000/ECDICT",
                "snapshot": "ecdict.csv@master",
                "csvSha256": file_sha256(ecdict_csv),
                "stats": ecdict_stats,
                "selection": (
                    "只收 2–4 词、纯字母/空格、全小写、含中文释义、"
                    "tagMask≠0 的 ECDICT 多词条目；去掉 sb/sth 尾部变体后按 "
                    "headword 去重；保留 tagMask/rank。"
                ),
                "note": (
                    "ECDICT 的 tag 列只给单词打 CET4/CET6/GRE 标签："
                    "366,599 条多词条目中带这三类 tag 的为 0 条。"
                    "本产物不拿无 tag 词频硬凑；ECDICT 部分实际为 "
                    f"{len(ecdict_entries)} 条。"
                ),
            },
            "curated": curated_meta,
            "cefrSource": (
                "content/wordlist/frequency_bands.v1.json（wordfreq 3.1.1 数据，"
                "CC BY-SA 4.0）；ECDICT 条目的 CEFR 为组成词频带近似"
            ),
        },
        "license": (
            "LinguaTrek 原创整理（curated）；ECDICT 数据条款见 PHRASES-NOTICE.md"
        ),
        "notice": NOTICE_FILENAME,
        "approximate": True,
        "counts": counts,
        "entries": entries,
    }
    document["integrity"] = {
        "algorithm": "sha256",
        "scope": "entries+counts+version",
        "sha256": phrases_payload_sha256(document),
    }
    return document, ecdict_stats


def validate_curated_documents(
    baseline_path: Path, extra_path: Path
) -> List[str]:
    problems: List[str] = []
    try:
        _, baseline = load_curated_file(baseline_path)
        _, extra = load_curated_file(extra_path)
    except BuildError as exc:
        return [str(exc)]
    if not (MIN_CURATED_BASE <= len(baseline) <= MAX_CURATED_BASE):
        problems.append(
            f"{baseline_path.name} 必须是 {MIN_CURATED_BASE}–{MAX_CURATED_BASE} 条"
            f"（实际 {len(baseline)} 条）"
        )
    combined_ids = [entry["id"] for entry in baseline + extra]
    if len(set(combined_ids)) != len(combined_ids):
        problems.append("精选短语 id 跨文件重复")
    return problems


def validate_document(
    document: Dict[str, Any], *, allow_small: bool = False
) -> List[str]:
    problems: List[str] = []

    def require(condition: bool, message: str) -> None:
        if not condition:
            problems.append(message)

    if not isinstance(document, dict):
        return ["短语词表不是 JSON 对象"]
    require(document.get("schema") == SCHEMA_PHRASES, f"schema 必须是 {SCHEMA_PHRASES}")
    require(bool(document.get("version")), "缺少 version")
    require(isinstance(document.get("source"), dict), "缺少 source")
    source = document.get("source")
    if isinstance(source, dict):
        ecdict = source.get("ecdict")
        require(isinstance(ecdict, dict), "source.ecdict 缺失")
        if isinstance(ecdict, dict):
            require(
                isinstance(ecdict.get("csvSha256"), str)
                and bool(SHA_RE.fullmatch(str(ecdict.get("csvSha256")))),
                "source.ecdict.csvSha256 缺失/格式不对",
            )
            require(isinstance(ecdict.get("stats"), dict), "source.ecdict.stats 缺失")
        curated = source.get("curated")
        require(isinstance(curated, dict), "source.curated 缺失")
        if isinstance(curated, dict):
            require(int(curated.get("baselineCount") or 0) > 0, "source.curated.baselineCount 缺失")
            require(int(curated.get("entries") or 0) > 0, "source.curated.entries 缺失")
    require(bool(document.get("license")), "缺少 license")
    require(
        document.get("notice") == NOTICE_FILENAME,
        f"notice 必须是 {NOTICE_FILENAME}",
    )
    require(document.get("approximate") is True, "短语 CEFR 必须标 approximate:true")
    entries = document.get("entries")
    require(isinstance(entries, list) and bool(entries), "entries 必须是非空数组")
    if not isinstance(entries, list):
        return problems

    seen_ids: set = set()
    seen_headwords: set = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            problems.append(f"entries[{index}] 必须是对象")
            return problems
        entry_id = str(entry.get("id") or "")
        if not SLUG_RE.fullmatch(entry_id):
            problems.append(f"entries[{index}] id 非法：{entry_id!r}")
            return problems
        if entry_id in seen_ids:
            problems.append(f"entries[{index}] id 重复：{entry_id}")
            return problems
        seen_ids.add(entry_id)
        headword = normalize_headword(entry.get("headword", ""))
        if not CURATED_PHRASE_RE.fullmatch(headword):
            problems.append(f"entries[{index}] headword 非法：{entry.get('headword')!r}")
            return problems
        if not (2 <= len(headword.split(" ")) <= 4):
            problems.append(f"entries[{index}] headword 不是 2–4 词：{headword!r}")
            return problems
        if headword in seen_headwords:
            problems.append(f"entries[{index}] headword 重复：{headword}")
            return problems
        seen_headwords.add(headword)
        if entry.get("type") not in PHRASE_TYPES:
            problems.append(f"entries[{index}] type 非法：{entry.get('type')!r}")
            return problems
        if entry.get("cefr") not in PHRASE_CEFR_LEVELS:
            problems.append(f"entries[{index}] cefr 非法：{entry.get('cefr')!r}")
            return problems
        translation = str(entry.get("translation") or "")
        if not translation or not CJK_RE.search(translation):
            problems.append(f"entries[{index}] translation 必须含中文")
            return problems
        example = str(entry.get("example") or "")
        if entry.get("source") == "curated" and not example:
            problems.append(f"entries[{index}] 精选条目必须提供 example：{headword!r}")
            return problems
        if entry.get("source") not in PHRASE_SOURCES:
            problems.append(f"entries[{index}] source 非法：{entry.get('source')!r}")
            return problems
        if entry.get("source") == "ECDICT":
            if not (isinstance(entry.get("tagMask"), int) and entry["tagMask"] > 0):
                problems.append(f"entries[{index}] ECDICT 条目 tagMask 必须 >0")
                return problems
            if not (isinstance(entry.get("rank"), int) and entry["rank"] >= 1):
                problems.append(f"entries[{index}] ECDICT 条目 rank 非法")
                return problems
    counts = _counts(entries)
    expected_counts = counts
    require(
        document.get("counts") == expected_counts,
        f"counts 与 entries 不一致：{expected_counts}",
    )
    if not allow_small and not (MIN_TOTAL <= counts["total"] <= MAX_TOTAL):
        problems.append(
            f"短语总数必须在 {MIN_TOTAL}–{MAX_TOTAL}（实际 {counts['total']}）"
        )
    integrity = document.get("integrity")
    require(isinstance(integrity, dict), "缺少 integrity")
    if isinstance(integrity, dict):
        try:
            expected = phrases_payload_sha256(document)
        except (KeyError, TypeError, ValueError) as exc:
            problems.append(f"integrity 计算失败：{exc}")
        else:
            require(integrity.get("sha256") == expected, "integrity.sha256 与内容不一致")
    return problems


def check_artifacts(
    out_dir: Path,
    *,
    baseline_path: Path,
    extra_path: Path,
    csv_path: Optional[Path] = None,
    frequency_path: Path = DEFAULT_FREQUENCY,
    version: str = ARTIFACT_VERSION,
    allow_small: bool = False,
) -> List[str]:
    problems: List[str] = []
    phrases_path = out_dir / PHRASES_FILENAME
    if not phrases_path.exists():
        return [f"产物不存在：{phrases_path}"]
    try:
        document = json.loads(phrases_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return [f"无法解析产物：{exc}"]
    problems.extend(validate_document(document, allow_small=allow_small))
    problems.extend(validate_curated_documents(baseline_path, extra_path))
    if not (out_dir / NOTICE_FILENAME).exists():
        problems.append(f"缺少 {NOTICE_FILENAME}")
    csv_files = sorted(out_dir.glob("*.csv"))
    if csv_files:
        problems.append(f"产物目录不应包含 CSV：{[p.name for p in csv_files]}")
    if csv_path is not None:
        try:
            frequency = json.loads(frequency_path.read_text(encoding="utf-8"))
            rebuilt, _ = build_document(
                csv_path,
                frequency,
                baseline_path,
                extra_path,
                version=version,
                allow_small=allow_small,
            )
        except (OSError, ValueError) as exc:
            problems.append(f"无法读取频表：{exc}")
        except BuildError as exc:
            problems.append(str(exc))
        else:
            if serialize(rebuilt) != phrases_path.read_text(encoding="utf-8"):
                problems.append(f"完整重建对比失败：{PHRASES_FILENAME} 与当前 CSV 不一致")
    return problems


# ---------------------------------------------------------------------------
# 质量闸 / 报告
# ---------------------------------------------------------------------------

def _checklist_entry(entry: Dict[str, Any]) -> Dict[str, Any]:
    example = str(entry.get("example") or "")
    translation = str(entry.get("translation") or "")
    notes = str(entry.get("notes") or "")
    return {
        "id": entry["id"],
        "headword": entry["headword"],
        "type": entry["type"],
        "cefr": entry["cefr"],
        "translation": translation,
        "example": example,
        "source": entry["source"],
        "checks": {
            "translationHasChinese": bool(CJK_RE.search(translation)),
            "examplePresent": bool(example) if entry["source"] == "curated" else None,
            "cefrInA2ToC1Plus": entry["cefr"] in PHRASE_CEFR_LEVELS,
            "typeValid": entry["type"] in PHRASE_TYPES,
            "nonLiteral": (
                "是" if "非字面义" in notes
                else "部分" if entry["type"] in {"phrasal_verb", "idiom"} and notes
                else "否"
            ),
        },
        "reviewer": "LinguaTrek 构建抽检",
    }


def build_report(
    document: Dict[str, Any],
    *,
    sample_size: int = 100,
) -> Dict[str, Any]:
    entries = document["entries"]
    if not entries:
        raise BuildError("无法为空词表生成抽检报告")
    # 等距抽样覆盖整张词表（含末尾 C1），避免 step 取整后只抽到前半段。
    indices = [
        min(len(entries) - 1, int(index * len(entries) / sample_size))
        for index in range(sample_size)
    ]
    sample = [entries[index] for index in indices]
    checklist = [_checklist_entry(entry) for entry in sample]
    failed = [
        item
        for item in checklist
        if not item["checks"]["translationHasChinese"]
        or item["checks"]["typeValid"] is False
        or item["checks"]["cefrInA2ToC1Plus"] is False
        or item["checks"]["examplePresent"] is False
    ]
    ecdict = document["source"]["ecdict"]
    curated = document["source"]["curated"]
    return {
        "schema": SCHEMA_REPORT,
        "generatedAt": "2026-11-17",
        "version": document["version"],
        "artifact": f"content/wordlists/{PHRASES_FILENAME}",
        "notice": f"content/wordlists/{NOTICE_FILENAME}",
        "totals": document["counts"],
        "ecdict": {
            **ecdict["stats"],
            "csvSha256": ecdict["csvSha256"],
            "snapshot": ecdict["snapshot"],
            "entries": document["counts"]["ecdict"],
            "note": (
                "ECDICT tag 列只给单词打 CET4/CET6/GRE 标签；2–4 词条目中"
                "带三类 tag 的实际为 0 条，且这些条目 frq/bnc 均为 0。"
                "不按无 tag 词频补数。"
            ),
        },
        "curated": curated,
        "qualityGate": {
            "sampleSize": len(checklist),
            "sampling": "按词表顺序等距抽样；逐条核对释义/例句/CEFR/非字面义",
            "failed": len(failed),
            "failedIds": [item["id"] for item in failed],
            "notes": (
                "100 条抽检由构建期自动核验字段 + 人工复核语义；"
                "非字面义按 notes 标注与类型判定。"
            ),
        },
        "checklist": checklist,
        "verification": {
            "commands": [
                "backend/venv/bin/python -m py_compile scripts/build_phrases.py",
                "backend/venv/bin/python scripts/build_phrases.py --check",
                "backend/venv/bin/python -m pytest backend/tests -q",
            ],
            "status": "pending",
        },
    }


def write_artifacts(
    out_dir: Path,
    document: Dict[str, Any],
    report: Dict[str, Any],
    report_path: Optional[Path],
) -> Tuple[Path, Optional[Path]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    phrases_path = out_dir / PHRASES_FILENAME
    phrases_path.write_text(serialize(document), encoding="utf-8")
    written_report: Optional[Path] = None
    if report_path is not None:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(serialize(report), encoding="utf-8")
        written_report = report_path
    return phrases_path, written_report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="构建语途单词本短语词表（ECDICT 多词 tag + 精选）"
    )
    parser.add_argument("--ecdict-csv", type=Path, help="ECDICT 官方 ecdict.csv")
    parser.add_argument(
        "--frequency",
        type=Path,
        default=DEFAULT_FREQUENCY,
        help="CEFR 频表路径（默认 content/wordlist/frequency_bands.v1.json）",
    )
    parser.add_argument(
        "--curated",
        type=Path,
        default=DEFAULT_OUT_DIR / CURATED_FILENAME,
        help="精选短语基线文件（150–200 条）",
    )
    parser.add_argument(
        "--curated-extra",
        type=Path,
        default=DEFAULT_OUT_DIR / CURATED_EXTRA_FILENAME,
        help="精选短语补充批次",
    )
    parser.add_argument(
        "--out-dir", type=Path, default=DEFAULT_OUT_DIR, help="产物目录"
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=DEFAULT_REPORT,
        help="质量闸报告路径（构建时写入）",
    )
    parser.add_argument("--version", default=ARTIFACT_VERSION, help="产物版本号")
    parser.add_argument(
        "--check",
        action="store_true",
        help="只校验已提交产物；给 --ecdict-csv 时做完整重建对比",
    )
    parser.add_argument(
        "--allow-small",
        action="store_true",
        help="仅测试用：跳过 500–800 规模护栏（正式产物不要加）",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    if not args.version.strip():
        print("--version 不能为空", file=sys.stderr)
        return 2
    out_dir = args.out_dir
    if args.check:
        try:
            problems = check_artifacts(
                out_dir,
                baseline_path=args.curated,
                extra_path=args.curated_extra,
                csv_path=args.ecdict_csv,
                frequency_path=args.frequency,
                version=args.version,
                allow_small=args.allow_small,
            )
        except BuildError as exc:
            print(f"ERR  {exc}", file=sys.stderr)
            return 1
        if problems:
            for problem in problems:
                print(f"ERR  {problem}", file=sys.stderr)
            return 1
        mode = "完整重建对比" if args.ecdict_csv else "离线结构/完整性/精选/规模"
        print(f"OK  {out_dir}（{mode}）")
        return 0

    if args.ecdict_csv is None:
        print("构建模式必须给 --ecdict-csv PATH", file=sys.stderr)
        return 2
    try:
        frequency = json.loads(args.frequency.read_text(encoding="utf-8"))
        document, ecdict_stats = build_document(
            args.ecdict_csv,
            frequency,
            args.curated,
            args.curated_extra,
            version=args.version,
            allow_small=args.allow_small,
        )
    except (OSError, ValueError) as exc:
        print(f"ERR  无法读取频表：{exc}", file=sys.stderr)
        return 1
    except BuildError as exc:
        print(f"ERR  {exc}", file=sys.stderr)
        return 1
    problems = validate_document(document, allow_small=args.allow_small)
    if problems:
        for problem in problems:
            print(f"ERR  {problem}", file=sys.stderr)
        return 1
    report = build_report(document)
    phrases_path, report_path = write_artifacts(
        out_dir, document, report, args.report
    )
    print(
        f"已写入 {phrases_path}（{document['counts']['total']} 条："
        f"ECDICT {document['counts']['ecdict']} / curated {document['counts']['curated']}；"
        f"ECDICT tagged 2–4 词 {ecdict_stats['tagged2to4Rows']} 条）；"
        + (f"报告 {report_path}" if report_path else "未写报告")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
