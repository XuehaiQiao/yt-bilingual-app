#!/usr/bin/env python3
"""lemma 归并影响审计（P1-01）——**只读**、不调 AI、不写任何用户数据。

审计对象
--------
- ``data/users/*/favorites.json``（``type=vocabulary`` 的「我的单词」）
- ``data/app.db`` 的 ``word_states`` / ``learning_events(dict_lookup)`` /
  ``review_logs`` / ``weekly_reports`` / ``user_wordlists`` / ``user_wordlist_items``
- ``data/ecdict.db`` 的 ``stardict.exchange``（唯一 lemma 规则来源）
- ``content/wordlist/frequency_bands.v1.json``（CEFR A1–C1）
- ``content/wordlists/{exam-bands,phrases}.v1.json``（GRE/CET4/CET6、短语）
- ``content/library/{videos,articles}``（高亮筛选的公共语料）

lemma 规则（与任务卡一致）
--------------------------
1. 词形先 NFC + 去首尾空白 + 小写（与 ``backend/srs.normalize_lemma`` 同口径）。
2. 在 ``stardict.exchange`` 中找 ``0:<base>`` → base 为基形；没有 ``0:`` → 回退原词。
3. 多词短语、专名、歧义（axes/leaves 等）**不自动合并**，单独列人工复核清单。
4. ECDICT 覆盖不到的词一律回退原词，并计入未覆盖比例。

只读证明
--------
- SQLite 一律 ``file:<path>?mode=ro&immutable=1`` 打开；脚本没有写库/写文件分支。
- 跑前跑后对 ``data/app.db``、``data/ecdict.db`` 与读到的每个 ``favorites.json``
  计算 SHA-256，结果写进 JSON/报告（``integrity.unchanged``）。
- 不调用任何模型；全部是词表与 SQL 聚合。

用法::

    python3 scripts/lemma_impact_audit.py --json
    python3 scripts/lemma_impact_audit.py --json --include-events
    python3 scripts/lemma_impact_audit.py --user-id <uid> --include-events
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

SCHEMA = "linguatrek.lemma-impact-audit.v1"
DEFAULT_USER_ID = "581d15fe48e44d24be36f06f9926a014"
DEFAULT_DB = "data/app.db"
DEFAULT_ECDICT = "data/ecdict.db"
DEFAULT_USER_DATA_DIR = "data/users"
DEFAULT_FREQUENCY = "content/wordlist/frequency_bands.v1.json"
DEFAULT_EXAM = "content/wordlists/exam-bands.v1.json"
DEFAULT_PHRASES = "content/wordlists/phrases.v1.json"
DEFAULT_LIBRARY = "content/library"
REPORT_PATH = "docs/reports/lemma-impact-2026-11-23.md"

TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z'\-]*")
NAME_MARKER_RE = re.compile(
    r"[（(](?:男子名|女子名|姓氏|地名|山名|河名|国名|州名|城市名)[）)]"
)
# 行首大写 + 释义里出现“州/市/国/人/语/宗教/星球……”才当专名候选；
# 全大写缩写（ABC/API）与 North/South 这类被 ECDICT 大写的普通词不算。
PROPER_TRANSLATION_RE = re.compile(
    r"(男子名|女子名|人名|姓氏|地名|山名|河名|国名|州名|城市名|"
    r"州|市|国|首都|星球|火星|土星|圣经|耶稣|基督|犹太教|"
    r"语|人|节日|星期|昵称|神话|希腊|罗马)"
)
EXAM_TAGS = (("cet4", 1), ("cet6", 2), ("gre", 4))
CEFR_LEVELS = (("A1", 1000), ("A2", 2000), ("B1", 4000), ("B2", 7000), ("C1", 10000))
# ECDICT 没有交换字段，但语义上不是“同形同义”的词。只用于人工复核提示，
# 不进入自动合并。完整人工清单见报告 §6。
CURATED_HOMOGRAPHS: Mapping[str, str] = {
    "axes": "axis 的复数 vs axe/ax 的复数（ECDICT 0:ax 只覆盖后者）",
    "leaves": "leaf 的复数 vs leave 的第三人称单数（ECDICT 0:leave 只覆盖后者）",
    "lives": "life 的复数 vs live 的第三人称单数",
    "knives": "knife 的复数 vs 同形动词",
    "wives": "wife 的复数 vs 同形动词",
    "halves": "half 的复数 vs halve 的第三人称单数",
    "wolves": "wolf 的复数 vs 同形动词",
    "shelves": "shelf 的复数 vs shelve 的第三人称单数",
    "selves": "self 的复数 vs 同形动词",
    "calves": "calf 的复数 vs 同形动词",
    "elves": "elf 的复数 vs 同形动词",
    "loaves": "loaf 的复数 vs 同形动词",
    "thieves": "thief 的复数 vs thieve 的第三人称单数",
    "number": "numb 的比较级 vs 名词/动词 number（ECDICT 0:numb 是错标）",
    "bit": "bite 的过去式 vs 名词 bit（少量/钻头/比特）",
    "ground": "grind 的过去式/过去分词 vs 名词/动词 ground",
    "lay": "lie 的过去式 vs 动词 lay（放置）",
    "shot": "shoot 的过去式/过去分词 vs 名词 shot",
    "born": "bear 的过去分词 vs 形容词 born（天生的）",
    "means": "mean 的第三人称单数 vs 名词 means（手段）",
    "feeling": "feel 的现在分词 vs 名词 feeling（感觉）",
    "living": "live 的现在分词 vs 形容词/名词 living（生活）",
    "understanding": "understand 的现在分词 vs 名词 understanding（理解）",
    "learning": "learn 的现在分词 vs 名词 learning（学习/学问）",
    "building": "build 的现在分词 vs 名词 building（建筑物）",
    "writing": "write 的现在分词 vs 名词 writing（写作/文字）",
    "finding": "find 的现在分词 vs 名词 finding（发现）",
    "dealing": "deal 的现在分词 vs 名词 dealing（交易/交往）",
    "beginning": "begin 的现在分词 vs 名词 beginning（开始）",
    "sophisticated": "sophisticate 的过去分词 vs 形容词 sophisticated（复杂的）",
    "informed": "inform 的过去分词 vs 形容词 informed（见多识广的）",
    "fixed": "fix 的过去分词 vs 形容词 fixed（固定的）",
    "lower": "low 的比较级 vs 动词 lower（降低）",
    "later": "late 的比较级 vs 副词 later（后来）",
    "better": "good/well 的比较级（ECDICT 只连 good）",
    "best": "good/well 的最高级（ECDICT 只连 good）",
    "worse": "bad/ill 的比较级（ECDICT 只连 bad）",
    "worst": "bad/ill 的最高级（ECDICT 只连 bad）",
    "criteria": "criterion 的复数；同时是高频独立复数名词",
    "bacteria": "bacterium 的复数；同时是高频独立复数名词",
    "laden": "lade 的过去分词 vs load 的过去分词（ECDICT 同词两基形）",
    "weed": "ECDICT 误标为 wee 的变形；本身是独立名词/动词（杂草/除草）",
    "does": "do 的第三人称单数 vs doe 的复数（ECDICT 0:doe）",
}
# ECDICT 明确错标的样本（报告中用于说明“不能只信 0:”）。
ECDICT_SUSPECTS: Mapping[str, dict] = {
    "number": {"base": "numb", "why": "number 是名词/动词；0:numb 只比较级义"},
    "weed": {"base": "wee", "why": "weed 是独立名词/动词；wee 的 d 形不成立"},
    "axes": {"base": "ax", "why": "axis 的复数是 axes；0:ax 只覆盖 ax/axe"},
    "laden": {"base": "load", "why": "lade 与 load 都列 laden，反查有多基形"},
    "does": {"base": "doe", "why": "do 的第三人称单数；doe 的复数同形"},
}
# 只做“反查”的交换码：s=复数 i=现在分词 p=过去式 d=过去分词 3=第三人称
# r=比较级 t=最高级 f=另一种复数写法。1 是“本行属于哪些变形类型”的码表，
# 0 是基形指针，都不是词形值。
FORM_CODES = frozenset("sipd3rtf")
MS_PER_DAY = 24 * 60 * 60 * 1000


class AuditError(RuntimeError):
    """审计前置条件不满足（缺文件/表结构不对）。"""


# ---------------------------------------------------------------------------
# 词形与 exchange 解析
# ---------------------------------------------------------------------------

def normalize_word(raw: Any) -> str:
    """NFC + 去首尾空白 + 小写；非字符串先转字符串。空串返回空串。"""
    text = unicodedata.normalize("NFC", str(raw if raw is not None else ""))
    return text.strip().lower()


def split_exchange(exchange: str | None) -> list[tuple[str, str]]:
    """把 ``0:base/1:dp/s:leaves`` 拆成 ``[(code, value), ...]``（保留顺序）。"""
    if not exchange or not isinstance(exchange, str):
        return []
    parts: list[tuple[str, str]] = []
    for chunk in exchange.split("/"):
        if ":" not in chunk:
            continue
        code, value = chunk.split(":", 1)
        code = code.strip()
        if not code:
            continue
        parts.append((code, value))
    return parts


def parse_exchange_base(exchange: str | None) -> str | None:
    """返回第一个 ``0:<base>`` 的归一化 base；没有/为空返回 None。"""
    for code, value in split_exchange(exchange):
        if code != "0":
            continue
        base = normalize_word(value)
        return base or None
    return None


def parse_exchange_forms(exchange: str | None) -> list[tuple[str, str]]:
    """返回 ``[(code, form), ...]``，只含真实词形值（不含 0/1 等元数据）。"""
    forms: list[tuple[str, str]] = []
    for code, value in split_exchange(exchange):
        if code not in FORM_CODES:
            continue
        form = normalize_word(value)
        if form:
            forms.append((code, form))
    return forms


def file_sha256(path: str | os.PathLike[str]) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def open_readonly(path: str | os.PathLike[str]) -> sqlite3.Connection:
    """SQLite 只读 + immutable；不会建库、不会尝试回滚日志。"""
    resolved = os.path.abspath(os.fspath(path))
    if not os.path.exists(resolved):
        raise AuditError(f"数据库不存在：{resolved}")
    uri = Path(resolved).as_uri() + "?mode=ro&immutable=1"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?", (name,)
    ).fetchone()
    return row is not None


def table_count(conn: sqlite3.Connection, name: str) -> int | None:
    if not table_exists(conn, name):
        return None
    try:
        return int(conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0])
    except sqlite3.Error:
        return None


# ---------------------------------------------------------------------------
# ECDICT 索引
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class WordInfo:
    word: str                      # 归一化后的查询词
    covered: bool                  # stardict 是否有行（NOCASE）
    ecdict_word: str | None        # 命中行的原始拼写（保留大小写）
    base: str | None               # 0:base（已归一化）；无/等于自身 -> None
    candidates: tuple[str, ...]    # 0:base + 反查基形，去重排序
    translation: str
    exchange: str
    proper: bool                   # 专名候选（行首大写或释义含“（男子名）”等）


class EcdictIndex:
    """只读 ECDICT 词形索引；只保留审计需要的词，内存可控。"""

    def __init__(self, path: str, needed: Iterable[str]):
        self.path = os.path.abspath(path)
        self.needed = {normalize_word(word) for word in needed if normalize_word(word)}
        self._rows: dict[str, list[tuple[str, str, str]]] = defaultdict(list)
        self._form_bases: dict[str, set[str]] = defaultdict(set)
        self.duplicate_rows = 0
        conn = open_readonly(path)
        try:
            for row in conn.execute(
                "SELECT word, exchange, translation FROM stardict"
            ):
                raw_word, exchange, translation = (
                    str(row[0] or ""),
                    str(row[1] or ""),
                    str(row[2] or ""),
                )
                key = normalize_word(raw_word)
                if not key:
                    continue
                if key in self.needed:
                    self._rows[key].append((raw_word, exchange, translation))
                # 反查：只有“基形行”（全文没有 0:）才登记它列出的变形。
                if exchange and parse_exchange_base(exchange) is None:
                    for _code, form in parse_exchange_forms(exchange):
                        if form in self.needed:
                            self._form_bases[form].add(key)
        finally:
            conn.close()
        for rows in self._rows.values():
            if len(rows) > 1:
                self.duplicate_rows += 1
        self._cache: dict[str, WordInfo] = {}

    # -- 查询 ---------------------------------------------------------
    def inspect(self, word: Any) -> WordInfo:
        key = normalize_word(word)
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        rows = self._rows.get(key, [])
        if not rows:
            info = WordInfo(key, False, None, None, (), "", "", False)
            self._cache[key] = info
            return info
        raw_word, exchange, translation = rows[0]
        bases: set[str] = set(self._form_bases.get(key, ()))
        base = parse_exchange_base(exchange)
        if base and base != key:
            bases.add(base)
        elif base == key:
            base = None
        proper = bool(
            NAME_MARKER_RE.search(translation)
            or (
                raw_word != raw_word.lower()
                and not raw_word.isupper()
                and PROPER_TRANSLATION_RE.search(translation)
            )
        )
        info = WordInfo(
            word=key,
            covered=True,
            ecdict_word=raw_word,
            base=base,
            candidates=tuple(sorted(bases)),
            translation=translation.replace("\n", " ").strip(),
            exchange=exchange,
            proper=proper,
        )
        self._cache[key] = info
        return info

    def lemma(self, word: Any) -> str:
        info = self.inspect(word)
        return info.base or info.word

    def reverse_bases(self, word: Any) -> tuple[str, ...]:
        return tuple(sorted(self._form_bases.get(normalize_word(word), ())))

    def ambiguity(self, word: Any) -> tuple[str, ...]:
        """多基形候选（0:base + 反查）；长度 >1 视为数据层面歧义。"""
        info = self.inspect(word)
        return info.candidates


# ---------------------------------------------------------------------------
# 单条词记录
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class WordRecord:
    dataset: str            # favorites / word_states / dict_lookup / wordlist / phrase
    user_id: str
    surface: str            # 原始存储词形（用于大小写等人工线索）
    word: str               # 归一化词形
    lemma: str              # 按规则得到的基形
    covered: bool
    base: str | None
    candidates: tuple[str, ...]
    proper: bool
    phrase: bool
    homograph_reason: str | None
    blockers: tuple[str, ...]   # phrase/proper/ambiguous/homograph/uncovered
    meta: Mapping[str, Any]

    @property
    def auto_merge_ok(self) -> bool:
        return bool(self.base) and not self.blockers

    @property
    def safe_key(self) -> str:
        return self.lemma if self.auto_merge_ok else self.word


def build_record(dataset: str, user_id: str, surface: Any, idx: EcdictIndex,
                 meta: Mapping[str, Any] | None = None) -> WordRecord:
    raw = str(surface or "")
    word = normalize_word(raw)
    info = idx.inspect(word)
    candidates = info.candidates
    ambiguous = bool(info.base) and len(candidates) > 1
    phrase = bool(word) and any(ch.isspace() for ch in word)
    homograph = CURATED_HOMOGRAPHS.get(word)
    blockers: list[str] = []
    if phrase:
        blockers.append("phrase")
    if not info.covered:
        blockers.append("uncovered")
    if info.proper:
        blockers.append("proper")
    if ambiguous:
        blockers.append("ambiguous")
    if homograph:
        blockers.append("homograph")
    return WordRecord(
        dataset=dataset,
        user_id=user_id,
        surface=raw,
        word=word,
        lemma=info.base or word,
        covered=info.covered,
        base=info.base,
        candidates=candidates,
        proper=info.proper,
        phrase=phrase,
        homograph_reason=homograph,
        blockers=tuple(blockers),
        meta=dict(meta or {}),
    )


# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------

def _round_ratio(value: int, total: int) -> float:
    return round(value / total, 4) if total else 0.0


def summarize_records(records: Sequence[WordRecord], *, sample_limit: int = 8) -> dict:
    """单一口径的归并量：记录数 / 去重后条数 / 可归并组 / 未覆盖比例。"""
    total = len(records)
    surfaces = {r.word for r in records}
    lemma_groups: dict[str, list[WordRecord]] = defaultdict(list)
    safe_groups: dict[str, list[WordRecord]] = defaultdict(list)
    for record in records:
        lemma_groups[record.lemma].append(record)
        safe_groups[record.safe_key].append(record)
    mergeable = {
        lemma: rows
        for lemma, rows in lemma_groups.items()
        if len({r.word for r in rows}) > 1
    }
    mergeable_safe = {
        key: rows
        for key, rows in safe_groups.items()
        if len({r.word for r in rows}) > 1
    }
    uncovered = [r for r in records if not r.covered]
    key_rewrites = [r for r in records if r.base]
    safe_rewrites = [r for r in records if r.auto_merge_ok]
    blocked = [r for r in records if r.blockers]
    blocked_with_base = [r for r in blocked if r.base]

    def _samples(rows: Iterable[WordRecord]) -> list[dict]:
        out = []
        for record in list(rows)[:sample_limit]:
            out.append({
                "surface": record.surface,
                "word": record.word,
                "lemma": record.lemma,
                "blockers": list(record.blockers),
            })
        return out

    return {
        "records": total,
        "distinct_surface_forms": len(surfaces),
        "distinct_lemmas_rule": len(lemma_groups),
        "distinct_keys_safe": len(safe_groups),
        "mergeable_groups_rule": len(mergeable),
        "mergeable_rows_rule": sum(len(rows) for rows in mergeable.values()),
        "mergeable_groups_safe": len(mergeable_safe),
        "mergeable_rows_safe": sum(len(rows) for rows in mergeable_safe.values()),
        "groups_with_any_rewrite": len({r.word for r in key_rewrites}),
        "rows_with_any_rewrite": len(key_rewrites),
        "rows_safe_rewrite": len(safe_rewrites),
        "covered_distinct": len(surfaces) - len({r.word for r in uncovered}),
        "blocked_rows": len(blocked),
        "blocked_with_base_rows": len(blocked_with_base),
        "blocked_by": dict(Counter(
            blocker for record in blocked for blocker in record.blockers
        )),
        "uncovered_rows": len(uncovered),
        "uncovered_distinct": len({r.word for r in uncovered}),
        "uncovered_ratio": _round_ratio(len({r.word for r in uncovered}),
                                        len(surfaces)),
        "phrase_rows": sum(1 for r in records if r.phrase),
        "proper_rows": sum(1 for r in records if r.proper),
        "examples_mergeable": [
            {
                "lemma": lemma,
                "forms": sorted({r.word for r in rows}),
                "count": len(rows),
            }
            for lemma, rows in sorted(mergeable.items())[:sample_limit]
        ],
        "examples_key_rewrites": _samples(key_rewrites),
        "examples_uncovered": _samples(uncovered),
        "examples_blocked": _samples(blocked),
        "examples_blocked_with_base": _samples(blocked_with_base),
    }


def _describe_favorite(item: Mapping[str, Any]) -> dict:
    return {
        "id": item.get("id"),
        "en_text": item.get("en_text"),
        "source_kind": item.get("source_kind"),
        "source_ref": item.get("source_ref"),
        "source_title": item.get("source_title"),
        "added_at": item.get("added_at"),
        "added_at_iso": _iso_from_ms(item.get("added_at")),
    }


def _describe_state(row: Mapping[str, Any]) -> dict:
    return {
        "id": row.get("id"),
        "lemma": row.get("lemma"),
        "target_lang": row.get("target_lang"),
        "state": row.get("state"),
        "reps": row.get("reps"),
        "lapses": row.get("lapses"),
        "due_at": row.get("due_at"),
        "due_at_iso": _iso_from_ms(row.get("due_at")),
        "last_reviewed_at": row.get("last_reviewed_at"),
        "last_reviewed_at_iso": _iso_from_ms(row.get("last_reviewed_at")),
        "mastered": bool(row.get("mastered")),
        "definition": row.get("definition"),
        "created_at": row.get("created_at"),
        "created_at_iso": _iso_from_ms(row.get("created_at")),
    }


def _iso_from_ms(value: Any) -> str | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    if number <= 0:
        return None
    return datetime.fromtimestamp(number / 1000, tz=timezone.utc).isoformat()


def _state_recommendation(rows: Sequence[Mapping[str, Any]]) -> dict:
    """多条 word_states 同 lemma 时的保留建议（复习次数多 → 最近复习）。"""
    enriched = [(row, int(row.get("reps") or 0),
                 int(row.get("last_reviewed_at") or 0),
                 int(row.get("mastered") or 0)) for row in rows]
    keep = max(enriched, key=lambda item: (item[1], item[2], item[3]))
    return {
        "keep_id": keep[0].get("id"),
        "rule": "reps 最多 → last_reviewed_at 最新 → mastered=1 优先",
        "fields_to_merge": [
            "definition（非空优先）",
            "sources（word_sources 取并集）",
            "created_at（取最早）",
            "mastered（任一为 1 则保留 1，不静默取消掌握）",
        ],
    }


# ---------------------------------------------------------------------------
# 数据加载
# ---------------------------------------------------------------------------

def load_favorites(user_data_dir: str) -> tuple[dict[str, list[dict]], list[dict]]:
    """读取全部用户 favorites.json；返回 (按用户分组的 vocabulary 条目, 文件哈希)。"""
    root = Path(user_data_dir)
    by_user: dict[str, list[dict]] = {}
    hashes: list[dict] = []
    if not root.is_dir():
        return by_user, hashes
    for path in sorted(root.glob("*/favorites.json")):
        user_id = path.parent.name
        hashes.append({"path": str(path), "sha256": file_sha256(path)})
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(payload, list):
            continue
        by_user[user_id] = [
            item for item in payload
            if isinstance(item, dict) and item.get("type") == "vocabulary"
        ]
    return by_user, hashes


def load_word_states(db_path: str) -> tuple[list[dict], list[str]]:
    conn = open_readonly(db_path)
    warnings: list[str] = []
    try:
        if not table_exists(conn, "word_states"):
            warnings.append("app.db 缺少 word_states 表（未迁移？）")
            return [], warnings
        rows = [
            dict(row) for row in conn.execute(
                "SELECT id, user_id, lemma, target_lang, state, reps, lapses, "
                "due_at, last_reviewed_at, mastered, definition, created_at "
                "FROM word_states"
            )
        ]
        return rows, warnings
    finally:
        conn.close()


def load_events(db_path: str, *, include_events: bool) -> tuple[list[dict], list[str]]:
    conn = open_readonly(db_path)
    warnings: list[str] = []
    try:
        if not include_events:
            return [], ["未包含 learning_events（--include-events 未开启）"]
        if not table_exists(conn, "learning_events"):
            warnings.append("app.db 缺少 learning_events 表")
            return [], warnings
        events: list[dict] = []
        for row in conn.execute(
            "SELECT id, user_id, event_type, payload, occurred_at "
            "FROM learning_events WHERE event_type = 'dict_lookup' "
            "ORDER BY occurred_at, id"
        ):
            payload = row["payload"]
            try:
                data = json.loads(payload) if payload else None
            except (TypeError, json.JSONDecodeError):
                data = None
            word = data.get("word") if isinstance(data, dict) else None
            events.append({
                "id": row["id"],
                "user_id": row["user_id"],
                "word": word,
                "occurred_at": row["occurred_at"],
            })
        return events, warnings
    finally:
        conn.close()


def load_custom_wordlists(db_path: str) -> tuple[dict, list[str]]:
    conn = open_readonly(db_path)
    warnings: list[str] = []
    try:
        lists = table_count(conn, "user_wordlists")
        items = table_count(conn, "user_wordlist_items")
        rows: list[dict] = []
        if items is not None:
            rows = [
                dict(row) for row in conn.execute(
                    "SELECT i.id, i.list_id, i.word, i.word_key, l.user_id "
                    "FROM user_wordlist_items i "
                    "LEFT JOIN user_wordlists l ON l.id = i.list_id"
                )
            ]
        if lists is None or items is None:
            warnings.append("app.db 缺少自定义词表表（未迁移？）")
        return {"lists": lists, "items": items, "rows": rows}, warnings
    finally:
        conn.close()


def load_weekly_reports(db_path: str, user_id: str) -> tuple[list[dict], list[str]]:
    conn = open_readonly(db_path)
    warnings: list[str] = []
    try:
        if not table_exists(conn, "weekly_reports"):
            warnings.append("app.db 缺少 weekly_reports 表")
            return [], warnings
        rows = []
        for row in conn.execute(
            "SELECT week_start, payload, created_at FROM weekly_reports "
            "WHERE user_id = ? ORDER BY week_start",
            (user_id,),
        ):
            try:
                data = json.loads(row["payload"]) if row["payload"] else None
            except (TypeError, json.JSONDecodeError):
                data = None
            rows.append({
                "week_start": row["week_start"],
                "payload": data,
                "created_at": row["created_at"],
            })
        return rows, warnings
    finally:
        conn.close()


def load_review_logs(db_path: str, user_id: str) -> tuple[list[dict], list[str]]:
    conn = open_readonly(db_path)
    warnings: list[str] = []
    try:
        if not table_exists(conn, "review_logs"):
            warnings.append("app.db 缺少 review_logs 表")
            return [], warnings
        rows = [
            dict(row) for row in conn.execute(
                "SELECT id, lemma, target_lang, reviewed_at FROM review_logs "
                "WHERE user_id = ? ORDER BY reviewed_at",
                (user_id,),
            )
        ]
        return rows, warnings
    finally:
        conn.close()


def load_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def load_wordlists(repo_root: str) -> tuple[dict, list[str]]:
    warnings: list[str] = []
    frequency = load_json(os.path.join(repo_root, DEFAULT_FREQUENCY))
    exam = load_json(os.path.join(repo_root, DEFAULT_EXAM))
    phrases = load_json(os.path.join(repo_root, DEFAULT_PHRASES))
    for name, document in (("frequency_bands", frequency), ("exam-bands", exam),
                           ("phrases", phrases)):
        if not isinstance(document, dict) or not isinstance(document.get("entries"), (list, dict)):
            raise AuditError(f"{name} 词表结构不符合预期")
    forms = frequency.get("forms") if isinstance(frequency.get("forms"), dict) else {}
    examples = phrases["entries"]
    if not isinstance(examples, list):
        raise AuditError("phrases entries 必须是数组")
    return {
        "frequency_entries": frequency["entries"],
        "frequency_forms": forms,
        "exam_entries": exam["entries"],
        "exam_words_original": [
            str(entry[0]) for entry in exam["entries"]
            if isinstance(entry, (list, tuple)) and entry
        ],
        "phrase_entries": examples,
        "frequency_meta": {
            "schema": frequency.get("schema"),
            "version": frequency.get("version"),
            "counts": frequency.get("counts"),
        },
        "exam_meta": {
            "schema": exam.get("schema"),
            "version": exam.get("version"),
            "counts": exam.get("counts"),
        },
        "phrases_meta": {
            "schema": phrases.get("schema"),
            "version": phrases.get("version"),
            "counts": phrases.get("counts"),
            "approximate": phrases.get("approximate"),
        },
    }, warnings


def load_library(repo_root: str) -> tuple[Counter, dict, list[str]]:
    """收回公共内容语料里的英文 token（小写），用于高亮筛选差集。"""
    library_root = Path(repo_root) / DEFAULT_LIBRARY
    counter: Counter = Counter()
    files = {"videos": 0, "articles": 0}
    warnings: list[str] = []
    if not library_root.is_dir():
        return counter, files, ["content/library 不存在，跳过高亮语料"]
    for path in sorted((library_root / "videos").glob("*.json")):
        try:
            document = load_json(str(path))
        except (OSError, json.JSONDecodeError):
            continue
        files["videos"] += 1
        for block in document.get("blocks", []) or []:
            if isinstance(block, dict):
                _count_tokens(block.get("en_text"), counter)
    for path in sorted((library_root / "articles").glob("*.json")):
        try:
            document = load_json(str(path))
        except (OSError, json.JSONDecodeError):
            continue
        files["articles"] += 1
        for block in document.get("paragraphs", []) or []:
            if isinstance(block, dict):
                _count_tokens(block.get("en"), counter)
    return counter, files, warnings


def _count_tokens(text: Any, counter: Counter) -> None:
    if not isinstance(text, str):
        return
    for match in TOKEN_RE.finditer(text):
        token = match.group(0).strip("'-")
        key = normalize_word(token)
        if key:
            counter[key] += 1


# ---------------------------------------------------------------------------
# 各模块分析
# ---------------------------------------------------------------------------

def analyze_favorites(favorites: Mapping[str, list[dict]], idx: EcdictIndex,
                      focus_user: str) -> dict:
    per_user: dict[str, dict] = {}
    all_records: list[WordRecord] = []
    details: list[dict] = []
    for user_id, items in sorted(favorites.items()):
        records = [
            build_record("favorites", user_id, item.get("en_text"), idx,
                         meta=_describe_favorite(item))
            for item in items
        ]
        all_records.extend(records)
        per_user[user_id] = summarize_records(records)
        if user_id == focus_user:
            details = [
                {
                    **_describe_favorite(item),
                    "word": record.word,
                    "lemma": record.lemma,
                    "blockers": list(record.blockers),
                    "covered": record.covered,
                }
                for item, record in zip(items, records)
            ]
    return {
        "focus_user_id": focus_user,
        "users_with_vocabulary": sorted(per_user),
        "per_user": per_user,
        "all_users": summarize_records(all_records),
        "focus_details": details,
    }


def analyze_word_states(states: Sequence[Mapping[str, Any]], idx: EcdictIndex,
                        focus_user: str) -> dict:
    per_user: dict[str, dict] = {}
    records_by_user: dict[str, list[WordRecord]] = defaultdict(list)
    for row in states:
        user_id = str(row.get("user_id") or "")
        record = build_record("word_states", user_id, row.get("lemma"), idx,
                              meta=_describe_state(row))
        records_by_user[user_id].append(record)
    all_records = [record for rows in records_by_user.values() for record in rows]
    for user_id, records in sorted(records_by_user.items()):
        per_user[user_id] = summarize_records(records)
    focus_rows = [row for row in states if str(row.get("user_id")) == focus_user]
    return {
        "focus_user_id": focus_user,
        "per_user": per_user,
        "all_users": summarize_records(all_records),
        "focus_rows": [_describe_state(row) for row in focus_rows],
    }


def analyze_events(events: Sequence[Mapping[str, Any]], idx: EcdictIndex,
                   focus_user: str) -> dict:
    records_by_user: dict[str, list[WordRecord]] = defaultdict(list)
    for event in events:
        word = event.get("word")
        if word is None or not str(word).strip():
            continue
        user_id = str(event.get("user_id") or "")
        records_by_user[user_id].append(
            build_record("dict_lookup", user_id, word, idx, meta={
                "event_id": event.get("id"),
                "occurred_at": event.get("occurred_at"),
            })
        )
    focus_records = records_by_user.get(focus_user, [])
    all_records = [record for rows in records_by_user.values() for record in rows]
    surface_counts = Counter(record.word for record in focus_records)

    def _counts(records: Sequence[WordRecord]) -> dict:
        surface = Counter(record.word for record in records)
        lemma = Counter(record.lemma for record in records)
        changed = []
        for word in sorted(set(surface) | set(lemma)):
            lemma_key = idx.lemma(word)
            if surface.get(word, 0) != lemma.get(lemma_key, 0):
                changed.append({
                    "surface": word,
                    "surface_count": surface.get(word, 0),
                    "lemma": lemma_key,
                    "lemma_count": lemma.get(lemma_key, 0),
                })
        return {
            "events": len(records),
            "distinct_surface": len(surface),
            "distinct_lemma": len(lemma),
            "changed_keys": len(changed),
            "changed_examples": changed[:12],
            "duplicate_surface_groups": [
                {"word": word, "count": count}
                for word, count in surface.most_common()
                if count > 1
            ][:10],
        }

    return {
        "focus_user_id": focus_user,
        "per_user": {
            user_id: {
                **summarize_records(records),
                "seen_counts": _counts(records),
            }
            for user_id, records in sorted(records_by_user.items())
        },
        "all_users": {
            **summarize_records(all_records),
            "seen_counts": _counts(all_records),
        },
        "focus_counts": _counts(focus_records),
        "focus_duplicate_surface_groups": [
            {"word": word, "count": count}
            for word, count in surface_counts.most_common()
            if count > 1
        ],
    }


def analyze_wordlists(wordlists: Mapping[str, Any], idx: EcdictIndex) -> dict:
    frequency_entries = wordlists["frequency_entries"]
    exam_entries = wordlists["exam_entries"]
    phrase_entries = wordlists["phrase_entries"]
    forms_map = wordlists["frequency_forms"]

    def _analyze_words(words: Sequence[str], rank_of: Mapping[str, int] | None = None) -> dict:
        rows = [str(word) for word in words]
        inflected = [w for w in rows if idx.inspect(w).base]
        safe = [
            w for w in inflected
            if not build_record("wordlist", "", w, idx).blockers
        ]
        ambiguous = [w for w in inflected if len(idx.ambiguity(w)) > 1]
        proper = [w for w in inflected if idx.inspect(w).proper]
        homographs = [w for w in inflected if normalize_word(w) in CURATED_HOMOGRAPHS]
        # 复核线索：ECDICT 的 0: 与运行期频表 forms 冲突 / 频表把该词形当独立 lemma。
        conflicts = [
            w for w in inflected
            if forms_map.get(normalize_word(w)) is not None
            and forms_map.get(normalize_word(w)) != idx.lemma(w)
        ]
        missing_forms = [w for w in inflected if normalize_word(w) not in forms_map]
        frequency_lemma = [w for w in inflected if normalize_word(w) in ranks]
        examples = [
            {"word": w, "base": idx.inspect(w).base, "proper": idx.inspect(w).proper}
            for w in inflected[:10]
        ]
        by_level: dict[str, int] = {}
        if rank_of is not None:
            for word in inflected:
                rank = rank_of.get(normalize_word(word))
                if rank is None:
                    continue
                for level, cap in CEFR_LEVELS:
                    if rank <= cap:
                        by_level[level] = by_level.get(level, 0) + 1
                        break
        return {
            "rows": len(rows),
            "inflected_rows": len(inflected),
            "inflected_ratio": _round_ratio(len(inflected), len(rows)),
            "auto_merge_safe_rows": len(safe),
            "blocked_rows": len(inflected) - len(safe),
            "blocked_ambiguous": len(ambiguous),
            "blocked_proper": len(proper),
            "blocked_homograph": len(homographs),
            "forms_map_conflict_rows": len(conflicts),
            "forms_map_missing_rows": len(missing_forms),
            "frequency_treats_as_lemma_rows": len(frequency_lemma),
            "inflected_by_cefr_level": by_level,
            "examples_inflected": examples,
            "examples_ambiguous": [
                {"word": w, "candidates": list(idx.ambiguity(w))} for w in ambiguous[:8]
            ],
            "examples_forms_map_conflict": [
                {"word": w, "base": idx.lemma(w),
                 "forms_map": forms_map.get(normalize_word(w))}
                for w in conflicts[:8]
            ],
            "examples_frequency_treats_as_lemma": [
                {"word": w, "base": idx.lemma(w)} for w in frequency_lemma[:8]
            ],
        }

    ranks = {}
    for entry in frequency_entries:
        if isinstance(entry, (list, tuple)) and len(entry) >= 2:
            ranks[normalize_word(entry[0])] = int(entry[1])
    cefr_words = [entry[0] for entry in frequency_entries
                  if isinstance(entry, (list, tuple)) and entry]
    exam_words = [entry[0] for entry in exam_entries
                  if isinstance(entry, (list, tuple)) and entry]
    tag_masks = {
        normalize_word(entry[0]): int(entry[1]) if len(entry) > 1 else 0
        for entry in exam_entries if isinstance(entry, (list, tuple)) and entry
    }

    exam = {}
    for tag, bit in EXAM_TAGS:
        words = [word for word, mask in tag_masks.items() if mask & bit]
        exam[tag] = _analyze_words(words)
    unique_exam = list(tag_masks)
    exam["unique"] = _analyze_words(unique_exam)

    cefr = _analyze_words(cefr_words, ranks)
    # 内置词表里的专名行：考试词表按原始拼写有 59 个首字母大写项。
    # 词表行本身的首字母大写（不是 ECDICT 行）：考试词表 59 行、
    # CEFR 0 行；这些行是专名/国籍/语言，不能按变形合并。
    exam_upper = list(dict.fromkeys(
        word for word in wordlists.get("exam_words_original", [])
        if word != word.lower()
    ))
    cefr_upper = [word for word in cefr_words if word != word.lower()]

    phrases = []
    for entry in phrase_entries:
        if isinstance(entry, dict) and entry.get("headword"):
            phrases.append(str(entry["headword"]))
    phrase_records = [
        build_record("phrase", "", headword, idx) for headword in phrases
    ]
    phrase_summary = summarize_records(phrase_records)
    phrase_summary.update({
        "multiword_rows": sum(1 for r in phrase_records if r.phrase),
        "covered_rows": sum(1 for r in phrase_records if r.covered),
        "auto_merge_candidates": sum(1 for r in phrase_records if r.auto_merge_ok),
        "expected_merge": 0,
    })
    return {
        "cefr": {**cefr, "uppercase_rows": len(cefr_upper)},
        "exam": {
            **exam,
            "uppercase_rows": len(exam_upper),
            "uppercase_examples": exam_upper[:12],
        },
        "phrases": phrase_summary,
        "meta": {
            "frequency": wordlists["frequency_meta"],
            "exam": wordlists["exam_meta"],
            "phrases": wordlists["phrases_meta"],
            "cross_map_note": (
                "review_cross_map_rows：ECDICT 0: 基形与 "
                "frequency_bands.forms 不一致（后者只覆盖 10k 频表可解释的变形，"
                "缺项不等于 ECDICT 一定错，只作人工复核线索）。"
            ),
        },
    }


def analyze_custom_wordlists(custom: Mapping[str, Any], idx: EcdictIndex) -> dict:
    rows = custom.get("rows") or []
    records = [
        build_record("custom_wordlist", str(row.get("user_id") or ""),
                     row.get("word"), idx, meta={
                         "list_id": row.get("list_id"),
                         "word_key": row.get("word_key"),
                     })
        for row in rows
    ]
    summary = summarize_records(records)
    summary.update({
        "lists": custom.get("lists"),
        "items": custom.get("items"),
        "note": "当前库 user_wordlists/user_wordlist_items 均为 0 行；"
                "导入时只做 NFC+casefold 去重（wordlists.py），不写 lemma。",
    })
    return summary


def analyze_highlight(library_tokens: Counter, favorites: Mapping[str, list[dict]],
                      states: Sequence[Mapping[str, Any]], idx: EcdictIndex,
                      focus_user: str) -> dict:
    vocabulary = favorites.get(focus_user, [])
    favorite_words = {normalize_word(item.get("en_text")) for item in vocabulary}
    mastered_words = {
        normalize_word(row.get("lemma")) for row in states
        if str(row.get("user_id")) == focus_user and int(row.get("mastered") or 0) == 1
    }
    known_surface = favorite_words | mastered_words
    known_lemma = {idx.lemma(word) for word in known_surface}

    def _diff(surface_set: set[str]) -> dict:
        lemma_set = {idx.lemma(word) for word in surface_set}
        gain: list[dict] = []
        lose: list[dict] = []
        for token, occurrences in library_tokens.items():
            matched_surface = token in surface_set
            matched_lemma = idx.lemma(token) in lemma_set
            if matched_surface == matched_lemma:
                continue
            item = {
                "token": token,
                "occurrences": occurrences,
                "surface_match": matched_surface,
                "lemma_match": matched_lemma,
                "lemma": idx.lemma(token),
            }
            (gain if matched_lemma else lose).append(item)
        return {
            "known_surface_forms": len(surface_set),
            "known_lemmas": len(lemma_set),
            "gain_forms": len(gain),
            "gain_occurrences": sum(item["occurrences"] for item in gain),
            "lose_forms": len(lose),
            "lose_occurrences": sum(item["occurrences"] for item in lose),
            "examples_gain": sorted(gain, key=lambda item: (-item["occurrences"], item["token"]))[:12],
            "examples_lose": sorted(lose, key=lambda item: (-item["occurrences"], item["token"]))[:12],
        }

    return {
        "corpus": {
            "tokens_distinct": len(library_tokens),
            "tokens_total": sum(library_tokens.values()),
        },
        "favorites": _diff(favorite_words),
        "mastered": _diff(mastered_words),
        "union": _diff(known_surface),
        "known_surface_forms": sorted(known_surface),
        "known_lemmas": sorted(known_lemma),
        "note": "高亮“已掌握不标”在 ignoredWords.ts 里用精确小写词形匹配；"
                "词表的星标/对勾同样按存储词形。这里用公共 content/library "
                "语料模拟“面形 vs lemma”的匹配差集。",
    }


def analyze_seen(events_analysis: Mapping[str, Any], idx: EcdictIndex) -> dict:
    return {
        "focus": events_analysis["focus_counts"],
        "all_users": events_analysis["all_users"]["seen_counts"],
        "note": "events.py 的 lookup_counts 目前按小写词形 GROUP BY；"
                "改为 lemma 后，同一词的不同变形次数会合并且返回键变化。",
    }


def analyze_weekly(reports: Sequence[Mapping[str, Any]],
                   review_logs: Sequence[Mapping[str, Any]],
                   events: Sequence[Mapping[str, Any]], idx: EcdictIndex,
                   focus_user: str) -> dict:
    # 按 UTC ISO 周（周一为起点）聚合 review_logs 与 dict_lookup。
    def _week_start(ms: Any) -> str | None:
        try:
            stamp = int(ms)
        except (TypeError, ValueError):
            return None
        day = datetime.fromtimestamp(stamp / 1000, tz=timezone.utc).date()
        return (day.fromordinal(day.toordinal() - day.weekday())).isoformat()

    logs_by_week: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for row in review_logs:
        week = _week_start(row.get("reviewed_at"))
        if week:
            logs_by_week[week].append(row)
    events_by_week: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for event in events:
        if str(event.get("user_id")) != focus_user:
            continue
        week = _week_start(event.get("occurred_at"))
        if week:
            events_by_week[week].append(event)

    report_rows = []
    for report in reports:
        week = str(report.get("week_start"))
        payload = report.get("payload") or {}
        body = payload.get("report") if isinstance(payload, dict) else None
        numbers = (body or {}).get("numbers") or {}
        words = (body or {}).get("words") or {}
        logs = logs_by_week.get(week, [])
        computed = {
            "reviewedWords": len({str(row.get("lemma")) for row in logs}),
            "reviews": len(logs),
        }
        # review_logs.lemma 在写入时已归一化；把同一批日志再按 ECDICT 规则
        # 重算，若键不变则 lemma 对周报的额外影响为 0。
        recanonicalized = len({
            idx.lemma(str(row.get("lemma"))) for row in logs
        })
        report_rows.append({
            "week_start": week,
            "stored": {
                "reviewedWords": numbers.get("reviewedWords"),
                "new": words.get("new"),
                "reviewed": words.get("reviewed"),
                "dueTomorrow": words.get("dueTomorrow"),
            },
            "recomputed_now_from_review_logs": computed,
            "lemma_effect_if_recanonicalized": recanonicalized - computed["reviewedWords"],
            "snapshot_drift": (
                (numbers.get("reviewedWords") or 0) - computed["reviewedWords"]
                if numbers.get("reviewedWords") is not None else None
            ),
            "snapshot_drift_note": "周报是生成时快照，drift 来自“快照后新写入的复习”，"
                                   "不是 lemma 的影响；lemma 影响看 "
                                   "lemma_effect_if_recanonicalized。",
        })

    event_rows = []
    for week, rows in sorted(events_by_week.items()):
        surfaces = {normalize_word(row.get("word")) for row in rows}
        lemmas = {idx.lemma(word) for word in surfaces}
        event_rows.append({
            "week_start": week,
            "events": len(rows),
            "distinct_surface": len(surfaces),
            "distinct_lemma": len(lemmas),
            "delta": len(lemmas) - len(surfaces),
        })
    review_log_lemmas = [str(row.get("lemma")) for row in review_logs]
    return {
        "focus_user_id": focus_user,
        "weekly_reports": report_rows,
        "review_logs": {
            "rows": len(review_logs),
            "distinct_lemma": len(set(review_log_lemmas)),
            "key_rewrites_if_recanonicalized": sum(
                1 for lemma in review_log_lemmas
                if idx.inspect(lemma).base and idx.inspect(lemma).base != normalize_word(lemma)
            ),
        },
        "dict_lookup_events_by_week": event_rows,
        "note": "周报 reviewedWords = COUNT(DISTINCT review_logs.lemma)，"
                "word_states.new = COUNT(DISTINCT word_states.lemma)；"
                "两者本来已按 lemma 去重，只有“同一周出现同一 lemma 的多个变形”时才会变。",
    }


def collect_candidates(records: Sequence[WordRecord], idx: EcdictIndex,
                       wordlists: Mapping[str, Any],
                       library_tokens: Mapping[str, int] | None = None) -> dict:
    """误合并候选：歧义 / 专名 / 短语 / 未覆盖 / ECDICT 疑似错标 / 规则盲区。"""
    USER_DATASETS = {"favorites", "word_states", "dict_lookup", "custom_wordlist"}
    ambiguous: dict[str, dict] = {}
    proper: dict[str, dict] = {}
    phrases: set[str] = set()
    uncovered: dict[str, dict] = {}
    homographs: dict[str, dict] = {}
    suspects: list[dict] = []
    reverse_only: dict[str, list[str]] = {}
    datasets_by_word: dict[str, set[str]] = defaultdict(set)

    for record in records:
        datasets_by_word[record.word].add(record.dataset)
    # 词表行也纳入候选（不进 records 汇总，但同样会受 lemma 影响）。
    wordlist_words: set[str] = set()
    for entry in wordlists["frequency_entries"]:
        if isinstance(entry, (list, tuple)) and entry:
            wordlist_words.add(normalize_word(entry[0]))
    for entry in wordlists["exam_entries"]:
        if isinstance(entry, (list, tuple)) and entry:
            wordlist_words.add(normalize_word(entry[0]))
    for word in wordlist_words:
        datasets_by_word[word].add("builtin_wordlist")
    for entry in wordlists["phrase_entries"]:
        if isinstance(entry, dict) and entry.get("headword"):
            datasets_by_word[normalize_word(entry["headword"])].add("phrase_list")
    for word in (library_tokens or {}):
        datasets_by_word[word].add("library_corpus")

    for word, datasets in datasets_by_word.items():
        info = idx.inspect(word)
        origins = sorted(datasets)
        if any(ch.isspace() for ch in word):
            phrases.add(word)
        if info.proper and any(origin in USER_DATASETS for origin in origins):
            proper[word] = {
                "word": word,
                "ecdict_word": info.ecdict_word,
                "translation": info.translation[:80],
                "origins": origins,
            }
        if not info.covered:
            uncovered[word] = {"word": word, "origins": origins}
        if info.base and len(info.candidates) > 1:
            ambiguous[word] = {
                "word": word,
                "ecdict_base": info.base,
                "candidates": list(info.candidates),
                "origins": origins,
            }
        if (info.base is None and info.covered and info.candidates):
            reverse_only[word] = {
                "word": word,
                "reverse_bases": list(info.candidates),
                "origins": origins,
            }
        if word in CURATED_HOMOGRAPHS:
            homographs[word] = {
                "word": word,
                "reason": CURATED_HOMOGRAPHS[word],
                "ecdict_base": info.base,
                "origins": origins,
            }
        if word in ECDICT_SUSPECTS:
            suspects.append({
                "word": word,
                "ecdict_base": ECDICT_SUSPECTS[word]["base"],
                **ECDICT_SUSPECTS[word],
                "origins": origins,
            })

    uncovered_by_origin = Counter()
    for word, info in uncovered.items():
        for origin in info["origins"]:
            uncovered_by_origin[origin] += 1
    wordlist_upper = []
    for entry in wordlists["exam_entries"]:
        if isinstance(entry, (list, tuple)) and entry and str(entry[0]) != str(entry[0]).lower():
            wordlist_upper.append(str(entry[0]))
    for entry in wordlists["frequency_entries"]:
        if isinstance(entry, (list, tuple)) and entry and str(entry[0]) != str(entry[0]).lower():
            wordlist_upper.append(str(entry[0]))
    library_only = sum(1 for info in uncovered.values()
                       if set(info["origins"]) == {"library_corpus"})
    return {
        "ambiguous_multi_base": {
            "count": len(ambiguous),
            "examples": list(ambiguous.values())[:20],
        },
        "user_data_uncovered": {
            "count": sum(1 for info in uncovered.values()
                         if any(origin in USER_DATASETS for origin in info["origins"])),
            "examples": [info for info in uncovered.values()
                         if any(origin in USER_DATASETS for origin in info["origins"])][:20],
        },
        "builtin_wordlist_uppercase_rows": {
            "count": len(wordlist_upper),
            "examples": wordlist_upper[:20],
            "note": "GRE/CET4/CET6 词表里有 59 行首字母大写（专名/国籍/语言）；"
                    "CEFR 频表 0 行。这些行不进入自动合并。",
        },
        "proper_noun_candidates": {
            "count": len(proper),
            "examples": list(proper.values())[:20],
        },
        "phrase_candidates": {
            "count": len(phrases),
            "examples": sorted(phrases)[:20],
        },
        "uncovered_words": {
            "count": len(uncovered),
            "by_origin": dict(uncovered_by_origin),
            "library_only_count": library_only,
            "examples": list(uncovered.values())[:30],
        },
        "curated_homograph_candidates": {
            "count": len(homographs),
            "examples": list(homographs.values())[:30],
        },
        "ecd_suspect_bases": {
            "count": len(suspects),
            "examples": suspects[:20],
        },
        "rule_blind_spots": {
            "reverse_only_count": len(reverse_only),
            "by_origin": dict(Counter(
                origin for item in reverse_only.values() for origin in item["origins"]
            )),
            "user_data_count": sum(
                1 for item in reverse_only.values()
                if any(origin in USER_DATASETS for origin in item["origins"])
            ),
            "examples": list(reverse_only.values())[:20],
            "note": "没有 0:<base> 但被基形行的 s/i/p/d/3/r/t/f 反查命中；"
                    "按任务规则仍回退原词，但说明规则会漏掉这部分不规则变形。",
        },
    }


def analyze_guest_data(repo_root: str, events: Sequence[Mapping[str, Any]]) -> dict:
    guests_dir = Path(repo_root) / "data" / "guests"
    guest_dirs = 0
    nonempty = 0
    favorite_files = 0
    history_files = 0
    if guests_dir.is_dir():
        for entry in guests_dir.iterdir():
            if not entry.is_dir():
                continue
            guest_dirs += 1
            children = list(entry.iterdir())
            if children:
                nonempty += 1
            if (entry / "favorites.json").exists():
                favorite_files += 1
            history = entry / "history"
            if history.is_dir():
                history_files += sum(1 for item in history.iterdir() if item.is_file())
    guest_events = [event for event in events if str(event.get("user_id", "")).startswith("guest:")]
    return {
        "guest_dirs": guest_dirs,
        "nonempty_guest_dirs": nonempty,
        "guest_favorites_files": favorite_files,
        "guest_history_files": history_files,
        "guest_dict_lookup_events": len(guest_events),
        "guest_event_users": len({str(e.get("user_id")) for e in guest_events}),
        "client_storage": {
            "guest_favorites": "localStorage yt_bilingual_favorites",
            "guest_mastered_words": "localStorage yt_bilingual_guest_mastered_words",
            "ignored_words": "localStorage yt_bilingual_ignored_words",
        },
        "server_side_auditable": False,
        "note": "游客目录只有 subscriptions.json / history（历史观看），"
                "没有 favorites.json；游客收藏/已掌握只存在浏览器 localStorage"
                "（yt_bilingual_favorites、yt_bilingual_guest_mastered_words），"
                "服务端无法逐条审计。能看到的只有游客 pseudonym 下的 dict_lookup "
                "事件（本次 2 条，无法与本地收藏关联）。需要客户端归一化。",
    }


def analyze_conflicts(favorites: Mapping[str, list[dict]],
                      states: Sequence[Mapping[str, Any]], events_analysis: Mapping[str, Any],
                      focus_user: str, idx: EcdictIndex) -> dict:
    favorite_groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for user_id, items in favorites.items():
        for item in items:
            word = normalize_word(item.get("en_text"))
            favorite_groups[(user_id, idx.lemma(word))].append(item)
    favorite_conflicts = []
    for (user_id, lemma), items in sorted(favorite_groups.items()):
        if len({normalize_word(item.get("en_text")) for item in items}) < 2:
            continue
        favorite_conflicts.append({
            "user_id": user_id,
            "lemma": lemma,
            "forms": [
                {
                    **_describe_favorite(item),
                    "word": normalize_word(item.get("en_text")),
                    "blockers": list(build_record("favorites", user_id,
                                                  item.get("en_text"), idx).blockers),
                }
                for item in items
            ],
        })

    state_groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in states:
        state_groups[(str(row.get("user_id")), idx.lemma(row.get("lemma")))].append(row)
    state_conflicts = []
    for (user_id, lemma), rows in sorted(state_groups.items()):
        if len(rows) < 2:
            continue
        state_conflicts.append({
            "user_id": user_id,
            "lemma": lemma,
            "forms": [str(row.get("lemma")) for row in rows],
            "rows": [_describe_state(row) for row in rows],
            "suggestion": _state_recommendation(rows),
        })

    favorite_words = {
        normalize_word(item.get("en_text"))
        for item in favorites.get(focus_user, [])
    }
    state_words = {
        normalize_word(row.get("lemma")) for row in states
        if str(row.get("user_id")) == focus_user
    }
    cross_source = []
    for word in sorted(favorite_words & state_words):
        items = [item for item in favorites.get(focus_user, [])
                 if normalize_word(item.get("en_text")) == word]
        rows = [row for row in states
                if str(row.get("user_id")) == focus_user
                and normalize_word(row.get("lemma")) == word]
        cross_source.append({
            "word": word,
            "lemma": idx.lemma(word),
            "favorites": [_describe_favorite(item) for item in items],
            "word_states": [_describe_state(row) for row in rows],
            "note": "ADR-0001 允许 favorites 与未掌握 word_states 并存；若走方案 A，"
                    "这是需要选择“保留哪条主记录”的 3 处重叠。",
        })

    duplicates = events_analysis.get("focus_duplicate_surface_groups", [])
    return {
        "favorites_same_lemma": {
            "count": len(favorite_conflicts),
            "groups": favorite_conflicts,
        },
        "word_states_same_lemma": {
            "count": len(state_conflicts),
            "groups": state_conflicts,
        },
        "cross_source_same_lemma": {
            "count": len(cross_source),
            "groups": cross_source,
        },
        "dict_lookup_duplicate_surfaces": {
            "count": len(duplicates),
            "groups": duplicates,
        },
    }


def build_plans(favorites: Mapping[str, Any], states: Mapping[str, Any],
                events: Mapping[str, Any], highlight: Mapping[str, Any],
                conflicts: Mapping[str, Any], candidates: Mapping[str, Any]) -> dict:
    favorite_all = favorites["all_users"]
    state_all = states["all_users"]
    event_all = events.get("all_users") or {
        "records": 0,
        "distinct_surface_forms": 0,
        "distinct_lemmas_rule": 0,
        "mergeable_groups_rule": 0,
        "rows_with_any_rewrite": 0,
        "blocked_rows": 0,
        "blocked_with_base_rows": 0,
    }
    event_counts = (event_all.get("seen_counts") or {
        "distinct_surface": 0,
        "distinct_lemma": 0,
    })
    cross_source_count = conflicts["cross_source_same_lemma"]["count"]
    blocked = (favorite_all["blocked_rows"] + state_all["blocked_rows"]
               + event_all["blocked_rows"])
    plan_a_records = (favorite_all["records"] + state_all["records"]
                      + event_all["records"])
    plan_a_rewrites = (favorite_all["rows_with_any_rewrite"]
                       + state_all["rows_with_any_rewrite"]
                       + event_all["rows_with_any_rewrite"])
    plan_a_store_dedup = (
        (favorite_all["records"] - favorite_all["distinct_lemmas_rule"])
        + (state_all["records"] - state_all["distinct_lemmas_rule"])
    )
    event_distinct_reduction = (
        event_counts["distinct_surface"] - event_counts["distinct_lemma"]
    )
    would_merge_blocked = (favorite_all["blocked_with_base_rows"]
                           + state_all["blocked_with_base_rows"]
                           + event_all["blocked_with_base_rows"])
    return {
        "A": {
            "name": "主记录 + forms 合并（写路径归一化，收藏/状态/事件统一按 lemma）",
            "affected_records": plan_a_records,
            "key_rewrites": plan_a_rewrites,
            "records_removed_by_dedup_in_stores": plan_a_store_dedup,
            "event_distinct_reduction": event_distinct_reduction,
            "wrong_merge_risk_rows": would_merge_blocked,
            "distinct_after": {
                "favorites": favorite_all["distinct_lemmas_rule"],
                "word_states": state_all["distinct_lemmas_rule"],
                "dict_lookup": event_counts["distinct_lemma"],
            },
            "cross_store_collisions": cross_source_count,
            "blocked_records": blocked,
            "blocked_records_with_base": would_merge_blocked,
            "risks": [
                f"当前 {plan_a_records} 条源记录中 {plan_a_rewrites} 条键会变；"
                f"收藏/状态去重 {plan_a_store_dedup} 条，事件聚合后去重后条数少 "
                f"{event_distinct_reduction} 条（事件本身不删）。",
                f"{blocked} 条记录命中歧义/专名/短语/同形词（其中 "
                f"{would_merge_blocked} 条本来会被合并），不能自动合并；"
                "ECDICT 的 0: 有已知错标（number→numb、weed→wee）。",
                f"跨源同 lemma {cross_source_count} 处（收藏 vs 复习）需要选主记录；"
                "合并有损，必须备份 + 审计日志 + 回滚。",
                "需新增 forms 表/字段并重建事件派生统计（见过次数、周报、词表标色）。",
            ],
            "recommended_phase": "第三阶段（歧义清单与 forms 回填完成后再做）",
        },
        "B": {
            "name": "仅状态按 lemma 对齐（favorites/事件保留面形，读时统一）",
            "affected_records": state_all["records"] + event_all["records"],
            "key_rewrites": (state_all["rows_with_any_rewrite"]
                             + event_all["rows_with_any_rewrite"]),
            "records_removed_by_dedup_in_stores": (
                state_all["records"] - state_all["distinct_lemmas_rule"]
            ),
            "event_distinct_reduction": event_distinct_reduction,
            "favorites_untouched": favorite_all["records"],
            "highlight_gain_forms": highlight["union"]["gain_forms"],
            "blocked_records": state_all["blocked_rows"] + event_all["blocked_rows"],
            "blocked_records_with_base": (
                state_all["blocked_with_base_rows"] + event_all["blocked_with_base_rows"]
            ),
            "risks": [
                "不删收藏、不改历史事件，风险最低；但收藏里同一 lemma 的两条仍会保留，"
                "“我的单词”计数不会因此减少。",
                "读时归一化必须覆盖所有消费方（复习队列、周报、见过次数、词表标色、"
                "高亮筛选），否则同一数字再次分叉。",
                "歧义词若直接按 lemma 对齐，仍会把 axes/leaves/number 等错误合并；"
                "必须先落人工 allowlist（本报告 §6 清单）。",
            ],
            "recommended_phase": "第一阶段（先读时统计，不迁移数据）",
        },
        "recommendation": [
            "0. 先落人工 allowlist（§6），并给 ECDICT 错标词（number/weed/axes/"
            "laden/does）加显式黑名单；" + f"当前命中 {candidates['curated_homograph_candidates']['count']} 个候选。",
            "1. 方案 B：word_states / review_logs / 见过次数 / 周报读时按 lemma 对齐，"
            "事件保留原词形并加 lemma 快照；不删任何行。",
            "2. 收藏新增时写入 lemma + 原词形（只影响新数据），老数据先不合并。",
            "3. 观测一个版本后，再评估方案 A 的 forms 表与历史事件迁移。",
            "4. 游客端在 localStorage 层做同样的 NFC+lower+lemma（客户端），"
            "并明确“本地数据无法服务端审计”。",
        ],
    }


def _integrity_snapshot(paths: Sequence[str]) -> dict:
    snapshot = {}
    for path in paths:
        if os.path.exists(path):
            snapshot[path] = {
                "sha256": file_sha256(path),
                "size": os.path.getsize(path),
            }
        else:
            snapshot[path] = {"sha256": None, "size": None, "missing": True}
    return snapshot


def _diff_integrity(before: Mapping[str, Any], after: Mapping[str, Any]) -> dict:
    changed = []
    unchanged = []
    for path, value in before.items():
        current = after.get(path, {})
        if value.get("sha256") == current.get("sha256"):
            unchanged.append(path)
        else:
            changed.append(path)
    return {
        "unchanged": unchanged,
        "changed": changed,
        "all_unchanged": not changed,
    }


# ---------------------------------------------------------------------------
# 主审计
# ---------------------------------------------------------------------------

def audit(repo_root: str, *, user_id: str = DEFAULT_USER_ID,
          db_path: str | None = None, ecdict_path: str | None = None,
          user_data_dir: str | None = None,
          include_events: bool = False) -> dict:
    repo = os.path.abspath(repo_root)
    db = db_path or os.path.join(repo, DEFAULT_DB)
    ecdict = ecdict_path or os.path.join(repo, DEFAULT_ECDICT)
    user_data = user_data_dir or os.path.join(repo, DEFAULT_USER_DATA_DIR)
    warnings: list[str] = []

    if not os.path.exists(db):
        raise AuditError(f"app.db 不存在：{db}")
    if not os.path.exists(ecdict):
        raise AuditError(f"ecdict.db 不存在：{ecdict}")

    favorites, favorite_hashes = load_favorites(user_data)
    states, state_warnings = load_word_states(db)
    events, event_warnings = load_events(db, include_events=include_events)
    custom, custom_warnings = load_custom_wordlists(db)
    reports, report_warnings = load_weekly_reports(db, user_id)
    review_logs, review_warnings = load_review_logs(db, user_id)
    wordlists, wordlist_warnings = load_wordlists(repo)
    library_tokens, library_files, library_warnings = load_library(repo)
    warnings.extend(state_warnings + event_warnings + custom_warnings
                    + report_warnings + review_warnings + wordlist_warnings
                    + library_warnings)

    # SQLite 打开前记录哈希（app.db/ecdict 与全部 favorites）。
    integrity_paths = [db, ecdict] + [item["path"] for item in favorite_hashes]
    before = _integrity_snapshot(integrity_paths)
    for item in favorite_hashes:
        item["sha256_before"] = before[item["path"]]["sha256"]

    needed: set[str] = set()
    for items in favorites.values():
        needed.update(normalize_word(item.get("en_text")) for item in items)
    needed.update(normalize_word(row.get("lemma")) for row in states)
    needed.update(normalize_word(event.get("word")) for event in events
                  if event.get("word"))
    needed.update(normalize_word(row.get("word")) for row in (custom.get("rows") or []))
    for entry in wordlists["frequency_entries"]:
        if isinstance(entry, (list, tuple)) and entry:
            needed.add(normalize_word(entry[0]))
    for entry in wordlists["exam_entries"]:
        if isinstance(entry, (list, tuple)) and entry:
            needed.add(normalize_word(entry[0]))
    for entry in wordlists["phrase_entries"]:
        if isinstance(entry, dict) and entry.get("headword"):
            needed.add(normalize_word(entry["headword"]))
    needed.update(library_tokens)
    needed.discard("")

    idx = EcdictIndex(ecdict, needed)
    favorites_analysis = analyze_favorites(favorites, idx, user_id)
    states_analysis = analyze_word_states(states, idx, user_id)
    events_analysis = analyze_events(events, idx, user_id) if include_events else {
        "focus_user_id": user_id, "per_user": {}, "focus_counts": None,
        "all_users": None, "focus_duplicate_surface_groups": [],
    }
    wordlists_analysis = analyze_wordlists(wordlists, idx)
    custom_analysis = analyze_custom_wordlists(custom, idx)
    highlight = analyze_highlight(library_tokens, favorites, states, idx, user_id)
    seen = analyze_seen(events_analysis, idx) if include_events else None
    weekly = analyze_weekly(reports, review_logs, events, idx, user_id)
    guest = analyze_guest_data(repo, events)

    # 所有审计记录（词表行不进按记录汇总，但进候选清单）。
    audited_records: list[WordRecord] = []
    for user_id_key, items in favorites.items():
        audited_records.extend(
            build_record("favorites", user_id_key, item.get("en_text"), idx)
            for item in items
        )
    audited_records.extend(
        build_record("word_states", str(row.get("user_id")), row.get("lemma"), idx)
        for row in states
    )
    audited_records.extend(
        build_record("dict_lookup", str(event.get("user_id")), event.get("word"), idx)
        for event in events if event.get("word")
    )
    audited_records.extend(
        build_record("custom_wordlist", str(row.get("user_id") or ""), row.get("word"), idx)
        for row in (custom.get("rows") or [])
    )
    conflicts = analyze_conflicts(favorites, states, events_analysis, user_id, idx)
    candidates = collect_candidates(audited_records, idx, wordlists, library_tokens)
    plans = build_plans(favorites_analysis, states_analysis, events_analysis,
                        highlight, conflicts, candidates)

    after = _integrity_snapshot(integrity_paths)
    integrity = {
        "sqlite_open_mode": "file:<path>?mode=ro&immutable=1",
        "before": before,
        "after": after,
        "diff": _diff_integrity(before, after),
        "favorites_sha256": [
            {
                "user_id": Path(item["path"]).parent.name,
                "path": item["path"],
                "before": item.get("sha256_before"),
                "after": after[item["path"]]["sha256"],
            }
            for item in favorite_hashes
        ],
        "read_only_guarantees": [
            "所有 SQLite 连接 mode=ro&immutable=1；脚本无写库/写文件分支。",
            "跑前跑后 SHA-256 全量对比，见 diff.all_unchanged。",
            "未调用任何模型（无 AI 请求）。",
        ],
    }
    if integrity["diff"]["changed"]:
        warnings.append("审计期间有文件哈希变化，请停掉写入方后重跑："
                        + ", ".join(integrity["diff"]["changed"]))
    for name in ("app.db-wal", "app.db-shm"):
        if os.path.exists(os.path.join(repo, "data", name)):
            warnings.append(f"检测到 {name}：immutable=1 读的是主库快照，"
                            "可能看不到 WAL 中未 checkpoint 的写入。")

    return {
        "schema": SCHEMA,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "repoRoot": repo,
        "reportPath": REPORT_PATH,
        "params": {
            "userId": user_id,
            "includeEvents": include_events,
            "dbPath": db,
            "ecdictPath": ecdict,
            "userDataDir": user_data,
        },
        "lemmaRule": {
            "normalization": "Unicode NFC + trim + lowercase",
            "base": "stardict.exchange 的 0:<base>；无 base 回退原词",
            "no_auto_merge": ["多词短语", "专名", "歧义/同形词（人工 allowlist）"],
            "note": "多词短语/专名/歧义只列入候选，不进入自动合并；"
                    "ECDICT 0: 有已知错标，见 candidates.ecd_suspect_bases。",
        },
        "datasets": {
            "favorites": favorites_analysis,
            "wordStates": states_analysis,
            "dictLookupEvents": events_analysis if include_events else {
                "skipped": True,
                "reason": "未开启 --include-events",
            },
            "customWordlists": custom_analysis,
        },
        "coverage": {
            "favorites": favorites_analysis["all_users"],
            "wordStates": states_analysis["all_users"],
            "dictLookupEvents": (events_analysis["all_users"]
                                 if include_events else None),
            "customWordlists": custom_analysis,
        },
        "conflicts": conflicts,
        "crossModule": {
            "builtinWordlists": wordlists_analysis,
            "customWordlists": custom_analysis,
            "phrases": wordlists_analysis["phrases"],
            "highlight": highlight,
            "libraryCorpus": library_files,
            "seenCounts": seen,
            "weeklyAndEvents": weekly,
        },
        "misMergeCandidates": candidates,
        "guestData": guest,
        "plans": plans,
        "samples": {
            "favoritesFocus": favorites_analysis["focus_details"],
            "wordStatesFocus": states_analysis["focus_rows"],
            "eventsFocus": (events_analysis.get("focus_counts")
                            if include_events else None),
        },
        "ecdictIndex": {
            "needed_words": len(needed),
            "duplicate_normalized_rows": idx.duplicate_rows,
        },
        "integrity": integrity,
        "warnings": warnings,
    }


def render_text(result: Mapping[str, Any]) -> str:
    coverage = result["coverage"]
    fav = coverage["favorites"]
    states = coverage["wordStates"]
    events = coverage["dictLookupEvents"]
    conflicts = result["conflicts"]
    candidates = result["misMergeCandidates"]
    lines = [
        f"lemma 影响审计（{result['schema']}）",
        f"用户：{result['params']['userId']}    "
        f"事件：{'含' if result['params']['includeEvents'] else '不含'}",
        "",
        "覆盖/归并：",
        f"  收藏 vocabulary：{fav['records']} 条 / {fav['distinct_surface_forms']} 面形"
        f" → lemma {fav['distinct_lemmas_rule']}；可归并组 {fav['mergeable_groups_rule']}",
        f"  word_states：{states['records']} 条 → lemma {states['distinct_lemmas_rule']}；"
        f"可归并组 {states['mergeable_groups_rule']}",
    ]
    if events:
        lines.append(
            f"  dict_lookup：{events['seen_counts']['events']} 事件 / "
            f"{events['seen_counts']['distinct_surface']} 面形 → "
            f"{events['seen_counts']['distinct_lemma']} lemma；"
            f"可归并组 {events['mergeable_groups_rule']}"
        )
    lines += [
        "",
        f"冲突：收藏同 lemma {conflicts['favorites_same_lemma']['count']} 组，"
        f"word_states 同 lemma {conflicts['word_states_same_lemma']['count']} 组，"
        f"跨源 {conflicts['cross_source_same_lemma']['count']} 处",
        f"误合并候选：歧义 {candidates['ambiguous_multi_base']['count']}，"
        f"专名 {candidates['proper_noun_candidates']['count']}，"
        f"短语 {candidates['phrase_candidates']['count']}，"
        f"未覆盖 {candidates['uncovered_words']['count']}",
        f"零写入：{'是' if result['integrity']['diff']['all_unchanged'] else '否'}",
        f"报告：{result['reportPath']}",
    ]
    if result["warnings"]:
        lines.append("警告：" + "；".join(result["warnings"]))
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="lemma 归并影响只读审计（不写数据、不调 AI）",
    )
    parser.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    parser.add_argument("--user-id", default=DEFAULT_USER_ID,
                        help=f"重点用户 ID（默认当前用户 {DEFAULT_USER_ID}）")
    parser.add_argument("--include-events", action="store_true",
                        help="包含 learning_events 的 dict_lookup 事件")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]),
                        help="仓库根目录（默认脚本上一级）")
    parser.add_argument("--db", default=None, help="覆盖 app.db 路径")
    parser.add_argument("--ecdict", default=None, help="覆盖 ecdict.db 路径")
    parser.add_argument("--user-data-dir", default=None, help="覆盖 data/users 路径")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = audit(
            args.root,
            user_id=args.user_id,
            db_path=args.db,
            ecdict_path=args.ecdict,
            user_data_dir=args.user_data_dir,
            include_events=args.include_events,
        )
    except AuditError as exc:
        print(f"审计失败：{exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(render_text(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
