#!/usr/bin/env python3
"""构建 CEFR M2 内容锚的 60 条盲评包（40 调参 / 20 holdout）。

用途
----
- 从 ``content_difficulty`` 36 条回填、定位测原创短文、公版书节选中抽取 60 条；
- 生成**盲评包**（匿名 id、打乱顺序、隐藏 difficulty.v1 预测与编辑标注）；
- 生成**truth 文件**（含来源、编辑标注、自动基线；禁止交给评审）；
- 生成自动基线对照表（人工列留空）与最终报告；
- 不调用 LLM、不生成任何人工标注、不修改业务代码/content/books/.env。

复现
----
    cd <repo>
    backend/venv/bin/python scripts/build_cefr_anchor_packet.py

输入（全部只读）：
- docs/reports/content-difficulty-backfill-2026-11-17.json（36 条的内容级预测）
- content/placement/**.json（11 条原创定位测短文；去掉与 form 重复的 legacy 版本）
- scripts/cefr_anchor_book_excerpts.json（13 条公版书节选快照）
- content/library/**、content/curated.json、data/curated-subtitles/**（视频元数据/时间窗）
- content/wordlist/frequency_bands.v1.json（difficulty.v1 词表）

输出：
- docs/reports/cefr-anchor-packet-2026-11-17.md
- docs/reports/cefr-anchor-answer-sheet-rater-a-2026-11-17.csv
- docs/reports/cefr-anchor-answer-sheet-rater-b-2026-11-17.csv
- docs/reports/cefr-anchor-truth-2026-11-17.json
- docs/reports/cefr-anchor-baseline-2026-11-17.csv
- docs/reports/cefr-anchor-baseline-2026-11-17.json
- docs/reports/cefr-anchor-report-2026-11-17.md
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Sequence

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(ROOT, "backend")
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

import difficulty  # noqa: E402  （只在 backend/venv/bin/python 下可导入 config）

BUILD_DATE = "2026-11-17"
SEED = "cefr-anchor-2026-11-17"
SCHEMA_PACKET = "cefr-anchor-packet.v1"
SCHEMA_TRUTH = "cefr-anchor-truth.v1"
SCHEMA_BASELINE = "cefr-anchor-baseline.v1"
TOTAL = 60
CALIBRATION_TARGET = 40
HOLDOUT_TARGET = 20

LEVELS = ("A1", "A2", "B1", "B2", "C1", "C1+")
LEVEL_INDEX = {level: index for index, level in enumerate(LEVELS)}
EDITORIAL_LEVELS = ("A2", "B1", "B2", "C1")  # 内容带下限 A2；A1 只作为评审兜底选项
BAND_RE = re.compile(r"\b(?:A1|A2|B1|B2|C1\+?)\b")

BACKFILL_REPORT = os.path.join(
    ROOT, "docs", "reports", "content-difficulty-backfill-2026-11-17.json"
)
BOOK_EXCERPTS = os.path.join(ROOT, "scripts", "cefr_anchor_book_excerpts.json")
CURATED = os.path.join(ROOT, "content", "curated.json")
CURATED_SUBTITLES = os.path.join(ROOT, "data", "curated-subtitles")
LIBRARY = os.path.join(ROOT, "content", "library")
PLACEMENT_FILES = [
    os.path.join(ROOT, "content", "placement", "reading.json"),
    os.path.join(ROOT, "content", "placement", "forms", "form-a", "reading.json"),
    os.path.join(ROOT, "content", "placement", "forms", "form-b", "reading.json"),
]
# 去掉与 form-a/form-b 高度重复的 legacy 版本：
# r-02 是 fb-p2 的前半段；r-05 是 fa-p3 的前半段。
PLACEMENT_KEEP = [
    "r-01",
    "r-03",
    "r-04",
    "fa-p1",
    "fa-p2",
    "fa-p3",
    "fa-p4",
    "fb-p1",
    "fb-p2",
    "fb-p3",
    "fb-p4",
]

# 40 调参 / 20 holdout：按 kind × band 分层，配额在代码里固定并校验。
# 每个分层内再按来源（36 / placement / book）做比例分配，避免 holdout 全是同一类。
HOLDOUT_BY_STRATUM = {
    ("video", "A2"): 1,
    ("video", "B1"): 4,
    ("video", "B2"): 4,
    ("video", "C1"): 2,
    ("article", "A2"): 4,
    ("article", "B1"): 2,
    ("article", "B2"): 2,
    ("article", "C1"): 1,
}

RUBRIC = """\
## 评分 rubric（A1–C1）

先判断**语言本身的难度**，不要考虑话题你是否熟悉、是否有中文字幕/译文、也不要用标题、作者或频道去猜等级。
内容集合按 A2 以上设计；如果你认为某条低于 A2，可选 A1（分析时折叠为 A2，与 `difficulty.v1` 的内容带下限一致）。
如果你认为某条明显高于 C1，选 C1，并在备注写 `C1+`。

| 带 | 词汇 | 句法 | 篇章 / 信息 | 听力（仅视频） |
|---|---|---|---|---|
| **A1** | 高频具体词；孤立词、固定短语 | 一般现在时、be/have/do、简单问句；句子很短 | 单句或极短通知；信息点少且直接 | 语速很慢、吐字清晰、停顿多；常需重复 |
| **A2** | 日常高频词；少量高频短语 | 简单句 + 基础连接（and/but/because）；常见时态 | 2–5 句的短段落；直接信息；结构可预测 | 慢速、清晰、标准口音；话题日常 |
| **B1** | 常见词为主；少量抽象词、短语动词 | 主从复合句；常见连接词；叙事/说明有层次 | 多段短文；主旨 + 若干细节；有明确结构 | 正常偏慢；清晰标准口音；少量习语/连读 |
| **B2** | 词汇较丰富；抽象/专业词增多 | 多重从句、非谓语、被动等复杂结构 | 长段落；观点、论证、隐含关系；需推断 | 正常语速；有连读/弱读；话题抽象或专业 |
| **C1** | 词汇广；习语、隐喻、语域变化 | 复杂句法、省略、倒装、名词化等 | 长而密集；隐含意义、立场、修辞；需综合理解 | 接近自然语速；口音/语域变化；信息密度高 |

**判定顺序（建议）**

1. **词汇**：目标带学习者不查词能否覆盖主要内容？生词是高频还是低频/抽象？
2. **句法**：平均句长、从句层数、非谓语/被动/倒装是否构成负担？
3. **篇章**：信息是直接陈述，还是要推断观点、关系、态度？
4. **听力**（视频）：语速、连读/弱读、口音、背景音、信息密度；可用字幕辅助听懂，但评级按**听**的难度。
5. 选“最贴合”的一带；若在相邻两带之间摇摆，选较低的一带并标置信度 1（表示这是边界判断）。

**置信度**：3 = 确定；2 = 比较确定；1 = 在相邻带之间摇摆。
**不要**查资料找原始等级标注；**不要**与其他评审讨论；**不要**参考同一条的其他评分。
"""


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def order_key(source_key: str) -> str:
    return sha256_text(f"{SEED}:order:{source_key}")


def split_key(source_key: str) -> str:
    return sha256_text(f"{SEED}:split:{source_key}")


def fold_band(band: str) -> str:
    return "A2" if band == "A1" else band


def band_distance(editorial: str, auto: str) -> int:
    return abs(LEVEL_INDEX[fold_band(editorial)] - LEVEL_INDEX[fold_band(auto)])


def load_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def word_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z][A-Za-z'\-\u2019]*", text))


def fmt_clock(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def youtube_link(video_id: str, start_seconds: float | None = None) -> str:
    base = f"https://www.youtube.com/watch?v={video_id}"
    if start_seconds is None:
        return base
    return f"{base}&t={max(0, int(round(start_seconds)))}s"


def excerpt_paragraphs(paragraphs: Sequence[str], max_words: int = 120) -> str:
    """整段拼接，不超过 max_words；若首段就超长，按句号截到不超过上限。"""
    cleaned = [re.sub(r"\s+", " ", str(p)).strip() for p in paragraphs if str(p).strip()]
    picked: list[str] = []
    total = 0
    for paragraph in cleaned:
        count = word_count(paragraph)
        if total + count <= max_words:
            picked.append(paragraph)
            total += count
            continue
        if not picked:
            sentences = re.split(r"(?<=[.!?])\s+", paragraph)
            for sentence in sentences:
                sentence_count = word_count(sentence)
                if total + sentence_count > max_words:
                    break
                picked.append(sentence)
                total += sentence_count
        break
    if not picked:
        # 兜底：按词截断（不应发生）
        picked = [" ".join(cleaned[0].split()[:max_words])]
    return " ".join(picked)


# ---------------------------------------------------------------------------
# 视频时间窗
# ---------------------------------------------------------------------------

def _library_blocks(ref: str) -> tuple[int | None, list[dict[str, Any]]]:
    path = os.path.join(LIBRARY, "videos", f"{ref}.json")
    data = load_json(path)
    blocks = [
        {
            "start": float(block.get("start") or 0.0),
            "end": float(block.get("end") or 0.0),
            "text": str(block.get("en_text") or block.get("text") or ""),
        }
        for block in data.get("blocks") or []
        if isinstance(block, Mapping)
    ]
    duration = data.get("duration")
    return (int(duration) if isinstance(duration, (int, float)) else None), blocks


def _curated_blocks(ref: str) -> tuple[int | None, list[dict[str, Any]]]:
    path = os.path.join(CURATED_SUBTITLES, f"{ref}.json")
    if not os.path.isfile(path):
        return None, []
    data = load_json(path)
    blocks = [
        {
            "start": float(block.get("start") or 0.0),
            "end": float(block.get("end") or 0.0),
            "text": str(block.get("text") or ""),
        }
        for block in data.get("blocks") or []
        if isinstance(block, Mapping)
    ]
    duration = data.get("duration")
    return (int(duration) if isinstance(duration, (int, float)) else None), blocks


def _best_window(
    blocks: Sequence[Mapping[str, Any]], duration: float, target: float, low: float, high: float
) -> dict[str, Any] | None:
    best: tuple[int, float, float] | None = None
    for block in blocks:
        start = float(block["start"])
        if start < low or start > high:
            continue
        end = min(duration, start + target)
        tokens = sum(
            len(re.findall(r"[A-Za-z][A-Za-z'\-\u2019]*", str(block.get("text") or "")))
            for block in blocks
            if start <= float(block["start"]) < end
        )
        if best is None or tokens > best[0]:
            best = (tokens, start, end)
    if best is None:
        return None
    return {"start": round(best[1], 2), "end": round(best[2], 2), "tokens": best[0]}


def select_windows(
    blocks: Sequence[Mapping[str, Any]], duration: int | None
) -> list[dict[str, Any]]:
    """挑 2 个不重叠、语音较密的时间窗；无字幕时按时长比例兜底。"""
    duration_value = float(duration or 0)
    if duration_value <= 0:
        return []
    target = 60.0 if duration_value < 360 else (75.0 if duration_value <= 900 else 90.0)
    if not blocks:
        # 字幕缓存缺失：按比例给两个近似时间窗，包内会明确标「估计」。
        first_start = max(5.0, 0.10 * duration_value)
        first_end = min(duration_value, first_start + target)
        second_start = max(first_end + 5.0, 0.55 * duration_value)
        second_end = min(duration_value, second_start + target)
        windows = []
        for start, end in ((first_start, first_end), (second_start, second_end)):
            if end - start < 20.0:
                continue
            windows.append(
                {
                    "start": round(start, 2),
                    "end": round(end, 2),
                    "tokens": 0,
                    "estimated": True,
                }
            )
        for window in windows:
            window["startLabel"] = fmt_clock(window["start"])
            window["endLabel"] = fmt_clock(window["end"])
            window["seconds"] = int(round(window["end"] - window["start"]))
        return windows
    first = _best_window(
        blocks, duration_value, target, 0.03 * duration_value, 0.45 * duration_value
    )
    windows: list[dict[str, Any]] = []
    if first:
        windows.append(first)
    second_low = max(0.50 * duration_value, (first["end"] + 5.0) if first else 0.50 * duration_value)
    second = _best_window(
        blocks, duration_value, target, second_low, 0.93 * duration_value
    )
    if second and (not first or second["start"] >= first["end"] + 2.0):
        windows.append(second)
    for window in windows:
        window["startLabel"] = fmt_clock(window["start"])
        window["endLabel"] = fmt_clock(window["end"])
        window["seconds"] = int(round(window["end"] - window["start"]))
    return windows


# ---------------------------------------------------------------------------
# 条目装配
# ---------------------------------------------------------------------------

def _content36_items() -> list[dict[str, Any]]:
    report = load_json(BACKFILL_REPORT)
    curated_items = {item["videoId"]: item for item in load_json(CURATED).get("items", [])}
    items: list[dict[str, Any]] = []
    for entry in report.get("items", []):
        raw_kind = str(entry.get("kind"))
        ref = str(entry.get("ref"))
        if raw_kind == "article":
            data = load_json(os.path.join(LIBRARY, "articles", f"{ref}.json"))
            paragraphs = [
                str(paragraph.get("en") or "").strip()
                for paragraph in data.get("paragraphs") or []
                if isinstance(paragraph, Mapping)
            ]
            full_text = "\n\n".join(p for p in paragraphs if p)
            excerpt = excerpt_paragraphs(paragraphs, 120)
            item = {
                "sourceSet": "content_difficulty_36",
                "sourceKey": f"content36:article:{ref}",
                "kind": "article",
                "contentType": "原创文章节选",
                "sourceRef": ref,
                "title": data.get("title") or ref,
                "attribution": "LinguaTrek 编辑部原创，随仓库分发",
                "editorialBand": str(entry.get("level")),
                "editorialLabelLevel": "item_level",
                "autoBand": str(entry.get("cefrInput")),
                "autoSource": "docs/reports/content-difficulty-backfill-2026-11-17.json#cefrInput",
                "wordCount": len(full_text.split()),
                "text": excerpt,
                "excerptWords": len(excerpt.split()),
                "fullTextWords": len(full_text.split()),
                "textSha256": sha256_text(excerpt),
                "autoFeatures": {"cefrInput": str(entry.get("cefrInput"))},
                "notes": "内容级 difficulty.v1 预测（对全文计算）；包内为 ≤120 词节选，二者不完全同构。",
            }
        elif raw_kind == "video":
            data = load_json(os.path.join(LIBRARY, "videos", f"{ref}.json"))
            duration, blocks = _library_blocks(ref)
            video_id = str(data.get("youtubeId") or "")
            full_text = " ".join(str(block.get("text") or "") for block in blocks)
            item = {
                "sourceSet": "content_difficulty_36",
                "sourceKey": f"content36:video:{ref}",
                "kind": "video",
                "contentType": "视频（YouTube 嵌入）",
                "sourceRef": ref,
                "videoId": video_id,
                "title": data.get("title") or ref,
                "channel": data.get("channel") or "",
                "url": youtube_link(video_id) if video_id else "",
                "durationSec": duration,
                "windows": select_windows(blocks, duration),
                "editorialBand": str(entry.get("level")),
                "editorialLabelLevel": "item_level",
                "autoBand": str(entry.get("cefrInput")),
                "autoSource": "docs/reports/content-difficulty-backfill-2026-11-17.json#cefrInput",
                "wordCount": word_count(full_text),
                "textSha256": sha256_text(full_text),
                "autoFeatures": {"cefrInput": str(entry.get("cefrInput"))},
                "notes": "内容级 difficulty.v1 预测；包内只给链接 + 时间窗，不给字幕全文。",
            }
        elif raw_kind == "curated":
            meta = curated_items.get(ref)
            if meta is None:
                raise ValueError(f"curated.json 缺少 {ref}")
            duration, blocks = _curated_blocks(ref)
            full_text = " ".join(str(block.get("text") or "") for block in blocks)
            video_id = str(meta.get("videoId") or ref)
            item = {
                "sourceSet": "content_difficulty_36",
                "sourceKey": f"content36:curated:{ref}",
                "kind": "video",
                "contentType": "精选视频（YouTube 嵌入）",
                "sourceRef": ref,
                "videoId": video_id,
                "title": meta.get("title") or ref,
                "channel": meta.get("channel") or "",
                "url": youtube_link(video_id),
                "durationSec": int(meta.get("duration") or duration or 0) or duration,
                "windows": select_windows(blocks, int(meta.get("duration") or duration or 0) or duration),
                "editorialBand": str(meta.get("level") or entry.get("level")),
                "editorialLabelLevel": "item_level",
                "autoBand": str(entry.get("cefrInput")),
                "autoSource": "docs/reports/content-difficulty-backfill-2026-11-17.json#cefrInput",
                "wordCount": word_count(full_text),
                "textSha256": sha256_text(full_text),
                "autoFeatures": {"cefrInput": str(entry.get("cefrInput"))},
                "notes": "内容级 difficulty.v1 预测；包内只给链接 + 时间窗，不给字幕全文。",
            }
        else:
            raise ValueError(f"未知内容类型：{raw_kind}")
        if item["editorialBand"] not in EDITORIAL_LEVELS:
            raise ValueError(f"编辑等级异常：{item}")
        if item["autoBand"] not in LEVELS:
            raise ValueError(f"预测等级异常：{item}")
        items.append(item)
    return items


def _placement_items() -> list[dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    for path in PLACEMENT_FILES:
        data = load_json(path)
        for entry in data.get("items", []):
            passage_id = str(entry.get("passageId") or entry.get("id"))
            if passage_id in found:
                continue
            if passage_id not in PLACEMENT_KEEP:
                continue
            found[passage_id] = entry
    missing = [key for key in PLACEMENT_KEEP if key not in found]
    if missing:
        raise ValueError(f"定位测短文缺失：{missing}")
    items: list[dict[str, Any]] = []
    for passage_id in PLACEMENT_KEEP:
        entry = found[passage_id]
        text = re.sub(r"\s+", " ", str(entry.get("passage") or "")).strip()
        band = str(entry.get("band"))
        features = difficulty.compute_article_features([text], editorial_level=band)
        auto_band = str(features["_bands"]["cefr_input"])
        if band not in EDITORIAL_LEVELS:
            raise ValueError(f"定位测 band 异常：{band}")
        if len(text.split()) > 120:
            raise ValueError(f"定位测短文超过 120 词：{passage_id}")
        items.append(
            {
                "sourceSet": "placement_11",
                "sourceKey": f"placement:{passage_id}",
                "kind": "article",
                "contentType": "原创定位测短文（草稿）",
                "sourceRef": passage_id,
                "title": f"定位测短文 {passage_id}",
                "attribution": "LinguaTrek 自写短文（定位测题库草稿，未经 pilot）；包内给全文。",
                "editorialBand": band,
                "editorialLabelLevel": "passage_level",
                "autoBand": auto_band,
                "autoSource": "difficulty.v1 compute_article_features(passage)",
                "wordCount": len(text.split()),
                "text": text,
                "excerptWords": len(text.split()),
                "fullTextWords": len(text.split()),
                "textSha256": sha256_text(text),
                "autoFeatures": {
                    "cefrInput": auto_band,
                    "p90": features.get("p_level", {}).get("p90"),
                    "p95": features.get("p_level", {}).get("p95"),
                    "utr5k": features.get("utr", {}).get("w5k"),
                    "asl": features.get("syntax", {}).get("asl"),
                    "labelConfidence": features.get("label_confidence"),
                },
                "notes": "内容级 difficulty.v1 预测；短文仅 44–99 词，p90 不稳定。",
            }
        )
    return items


def _book_items() -> list[dict[str, Any]]:
    data = load_json(BOOK_EXCERPTS)
    items: list[dict[str, Any]] = []
    for entry in data.get("items", []):
        text = re.sub(r"\s+", " ", str(entry.get("text") or "")).strip()
        band = str(entry.get("level"))
        if band not in EDITORIAL_LEVELS:
            raise ValueError(f"书籍等级异常：{entry.get('id')}")
        if len(text.split()) > 120:
            raise ValueError(f"公版书节选超过 120 词：{entry.get('id')}")
        features = difficulty.compute_article_features([text], editorial_level=band)
        auto_band = str(features["_bands"]["cefr_input"])
        items.append(
            {
                "sourceSet": "public_domain_book_13",
                "sourceKey": f"book:{entry['id']}",
                "kind": "article",
                "contentType": "公版书节选（Project Gutenberg）",
                "sourceRef": entry["id"],
                "title": entry.get("title") or entry["id"],
                "author": entry.get("author") or "",
                "year": entry.get("year"),
                "gutenbergId": entry.get("gutenbergId"),
                "sourceUrl": entry.get("sourceUrl"),
                "catalogUrl": entry.get("catalogUrl"),
                "attribution": (
                    f"{entry.get('author') or ''}《{entry.get('title') or ''}》"
                    f"（{entry.get('year') or '公版'}），Project Gutenberg #{entry.get('gutenbergId')}；"
                    "美国公版，包内节选 ≤120 词。"
                ),
                "editorialBand": band,
                "editorialLabelLevel": "book_level",
                "autoBand": auto_band,
                "autoSource": "difficulty.v1 compute_article_features(excerpt)",
                "wordCount": len(text.split()),
                "text": text,
                "excerptWords": len(text.split()),
                "fullTextWords": len(text.split()),
                "textSha256": sha256_text(text),
                "autoFeatures": {
                    "cefrInput": auto_band,
                    "p90": features.get("p_level", {}).get("p90"),
                    "p95": features.get("p_level", {}).get("p95"),
                    "utr5k": features.get("utr", {}).get("w5k"),
                    "asl": features.get("syntax", {}).get("asl"),
                    "labelConfidence": features.get("label_confidence"),
                },
                "notes": "编辑标注意义是「书级」而非节选级；预测是对节选文本计算。",
            }
        )
    return items


# ---------------------------------------------------------------------------
# 分层与盲化
# ---------------------------------------------------------------------------

def assign_split(items: Sequence[dict[str, Any]]) -> None:
    strata: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        strata[(item["kind"], item["editorialBand"])].append(item)
    if sum(HOLDOUT_BY_STRATUM.values()) != HOLDOUT_TARGET:
        raise ValueError("holdout 配额不是 20")
    if len(items) != TOTAL:
        raise ValueError(f"条目数不是 {TOTAL}：{len(items)}")
    holdout_total = 0
    for key, group in sorted(strata.items()):
        quota = HOLDOUT_BY_STRATUM.get(key)
        if quota is None:
            raise ValueError(f"缺少分层配额：{key}")
        if not (0 < quota < len(group)):
            raise ValueError(f"分层配额非法：{key} n={len(group)} q={quota}")
        by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for item in group:
            by_source[item["sourceSet"]].append(item)
        # 按来源比例分配 holdout，最大余数法；保证总和 = quota。
        raw = {source: quota * len(rows) / len(group) for source, rows in by_source.items()}
        counts = {source: int(value) for source, value in raw.items()}
        remaining = quota - sum(counts.values())
        order_sources = sorted(by_source, key=lambda source: (-(raw[source] - counts[source]), source))
        index = 0
        while remaining > 0:
            source = order_sources[index % len(order_sources)]
            counts[source] += 1
            remaining -= 1
            index += 1
        # 不允许一个来源被全部拿走（除非 strata 只有一个来源且 quota 只占一部分）。
        for source, rows in by_source.items():
            if counts[source] > len(rows):
                counts[source] = len(rows)
        # 修正配额（正常不会触发）。
        diff = sum(counts.values()) - quota
        while diff > 0:
            source = max(by_source, key=lambda s: counts[s])
            counts[source] -= 1
            diff -= 1
        for source, rows in by_source.items():
            ranked = sorted(rows, key=lambda item: split_key(item["sourceKey"]))
            for item in ranked[: counts[source]]:
                item["split"] = "holdout"
                holdout_total += 1
            for item in ranked[counts[source] :]:
                item["split"] = "calibration"
    if holdout_total != HOLDOUT_TARGET:
        raise ValueError(f"holdout 实际 {holdout_total}，期望 {HOLDOUT_TARGET}")
    calibration_total = sum(1 for item in items if item["split"] == "calibration")
    if calibration_total != CALIBRATION_TARGET:
        raise ValueError(f"calibration 实际 {calibration_total}，期望 {CALIBRATION_TARGET}")


def assign_anon_ids(items: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(items, key=lambda item: order_key(item["sourceKey"]))
    for index, item in enumerate(ordered, start=1):
        item["order"] = index
        item["anonId"] = f"M2-{index:03d}"
    return ordered


# ---------------------------------------------------------------------------
# 渲染
# ---------------------------------------------------------------------------

def _packet_item_block(item: Mapping[str, Any]) -> str:
    lines: list[str] = []
    header_bits = [item["anonId"], item["contentType"]]
    if item["kind"] == "video":
        duration = int(item.get("durationSec") or 0)
        header_bits.append(f"时长 {fmt_clock(duration)}")
        windows = item.get("windows") or []
        total_seconds = sum(int(window["seconds"]) for window in windows)
        header_bits.append(f"{len(windows)} 个时间窗，共 {fmt_clock(total_seconds)}")
    else:
        header_bits.append(f"{item['excerptWords']} 词")
    lines.append("### " + " ｜ ".join(header_bits))
    lines.append("")
    if item["kind"] == "video":
        lines.append(f"- **标题**：{item['title']}")
        if item.get("channel"):
            lines.append(f"- **频道**：{item['channel']}")
        lines.append(f"- **链接**：{item['url']}")
        for index, window in enumerate(item.get("windows") or [], start=1):
            link = youtube_link(item["videoId"], window["start"]) if item.get("videoId") else item["url"]
            lines.append(
                f"- **时间窗 {index}**：{window['startLabel']}–{window['endLabel']} "
                f"（约 {window['seconds']} 秒，{window['tokens']} 词"
                f"{'，无字幕缓存，按比例估计' if window.get('estimated') else ''}）— {link}"
            )
        if not item.get("windows"):
            lines.append("- **时间窗**：字幕缓存缺失；请按视频时长均匀抽 2–3 分钟判断整段。")
        lines.append(
            "- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，"
            "但不要用字幕稿的等级标注）。"
        )
    else:
        if item.get("author"):
            lines.append(f"- **作者**：{item['author']}")
        if item.get("sourceUrl") or item.get("catalogUrl"):
            lines.append(f"- **来源**：{item['attribution']}")
            lines.append(f"- **原文链接**：{item.get('catalogUrl') or item['sourceUrl']}")
        else:
            lines.append(f"- **来源**：{item['attribution']}")
        lines.append("")
        lines.append("> " + item["text"].replace("\n", " "))
    lines.append("")
    lines.append(
        "- **我的评分**：band ____｜"
        "置信度 ____（1–3）｜备注：____________________"
    )
    lines.append("")
    return "\n".join(lines)


def render_packet(items: Sequence[Mapping[str, Any]], counts: Mapping[str, Any]) -> str:
    lines: list[str] = [
        "# CEFR M2 内容锚盲评包（60 条）",
        "",
        f"> 版本：{BUILD_DATE} ｜ schema：`{SCHEMA_PACKET}` ｜ 状态：**人工双评未完成（校准未完成）**",
        "",
        "本包只含**待评条目 + 评分 rubric + 空白评分栏**；**不含**任何难度等级、`difficulty.v1` 预测、"
        "编辑标注、调参/holdout 归属，也不含任何人工评分结果。",
        "",
        "## 怎么用这个包",
        "",
        "1. 将本包与你的**个人答案表**（`cefr-anchor-answer-sheet-rater-a-2026-11-17.csv` 或 "
        "`...-rater-b...`）一起使用；两位评审独立完成，**在双方都提交前不讨论**。",
        "2. 按顺序评 60 条。每条只给一个 band（A1–C1）+ 置信度（1–3）；"
        "可选填目标生词率桶（`<1%` / `1–3%` / `3–5%` / `5–8%` / `>8%`）。",
        "3. 视频条目只给标题/频道/链接/时间窗，**不给字幕全文**；请观看时间窗后判断整段视频。"
        "第三方视频版权归原频道，包内不转载字幕。",
        "4. 文本条目给的是节选/全文（公版或语途原创），≤120 词；请只根据**看到的这段文本**判断。",
        "5. 不要搜索原始等级、不要看 `cefr-anchor-truth-*`、不要参考另一位评审的评分。",
        "6. 预计 3.5–4 小时；可分段完成，但请保持同一套 rubric。",
        "",
        "## 60 条构成（评审可见的只是类型与长度）",
        "",
        f"- 总数：**{counts['total']}** 条；视频 **{counts['video']}** 条、文章/短文/公版节选 **{counts['article']}** 条。",
        f"- 其中 **{counts['calibration']} 条用于调参、{counts['holdout']} 条用于 holdout**；"
        "具体哪条属于哪边已隐藏，不影响逐条评分。",
        "",
        "## 交付与保密",
        "",
        "- 只提交 band/置信度/备注，不提交猜测的原文来源等级；",
        "- 答案表用评审代号，不写真实姓名；",
        "- 任何「看起来像 A2」的标题/频道/作者都不是评分依据。",
        "",
        RUBRIC,
        "",
        "---",
        "",
        "## 待评条目（顺序已打乱）",
        "",
    ]
    for item in items:
        block = _packet_item_block(item)
        # 盲化自检：条目块内不能出现任何 CEFR 带标签。
        if BAND_RE.search(block):
            raise ValueError(f"盲评包条目泄露等级：{item['anonId']} :: {BAND_RE.findall(block)}")
        lines.append(block)
    lines.extend(
        [
            "---",
            "",
            "## 提交前检查",
            "",
            "- [ ] 60 条都填了 band；",
            "- [ ] 60 条都填了置信度（1–3）；",
            "- [ ] 没有和另一位评审讨论过；",
            "- [ ] 没有查看 `cefr-anchor-truth-2026-11-17.json`。",
            "",
            "> 人工评审未完成 → 校准未完成。不得把本包的自动基线当作效度证据，"
            "也不得在人工标签齐备前宣称 κ 或一致率。",
            "",
        ]
    )
    return "\n".join(lines)


def render_truth(
    items: Sequence[Mapping[str, Any]], counts: Mapping[str, Any], generated_at: str
) -> dict[str, Any]:
    return {
        "schema": SCHEMA_TRUTH,
        "version": BUILD_DATE,
        "generatedAt": generated_at,
        "status": "human_review_pending",
        "notice": (
            "NOT FOR RATERS. 本文件含编辑标注、difficulty.v1 预测、调参/holdout 归属与来源；"
            "只用于分析与复核，禁止交给评审。人工标签为 0/120，κ 与一致率尚未计算。"
        ),
        "design": {
            "total": TOTAL,
            "calibration": CALIBRATION_TARGET,
            "holdout": HOLDOUT_TARGET,
            "seed": SEED,
            "anonOrderRule": "sort by sha256(seed + ':order:' + sourceKey)",
            "splitRule": "40/20 by kind × editorial band; within stratum proportional by source set, hash-ranked",
            "strata": counts["strata"],
            "rubricVersion": "2026-11-17",
            "humanLabels": "pending (0/120)",
        },
        "sourceFiles": {
            "backfill": "docs/reports/content-difficulty-backfill-2026-11-17.json",
            "placement": [
                "content/placement/reading.json",
                "content/placement/forms/form-a/reading.json",
                "content/placement/forms/form-b/reading.json",
            ],
            "books": "scripts/cefr_anchor_book_excerpts.json",
            "wordlist": "content/wordlist/frequency_bands.v1.json",
            "curated": "content/curated.json",
            "library": "content/library/",
            "curatedSubtitles": "data/curated-subtitles/ (gitignored; 只用于时间窗选择)",
        },
        "items": [
            {
                "anonId": item["anonId"],
                "order": item["order"],
                "split": item["split"],
                "sourceSet": item["sourceSet"],
                "sourceKey": item["sourceKey"],
                "sourceRef": item["sourceRef"],
                "kind": item["kind"],
                "contentType": item["contentType"],
                "title": item.get("title"),
                "channel": item.get("channel"),
                "author": item.get("author"),
                "year": item.get("year"),
                "url": item.get("url"),
                "sourceUrl": item.get("sourceUrl"),
                "gutenbergId": item.get("gutenbergId"),
                "durationSec": item.get("durationSec"),
                "windows": item.get("windows"),
                "wordCount": item.get("wordCount"),
                "excerptWords": item.get("excerptWords"),
                "fullTextWords": item.get("fullTextWords"),
                "textSha256": item.get("textSha256"),
                "editorialBand": item["editorialBand"],
                "editorialLabelLevel": item["editorialLabelLevel"],
                "autoBand": item["autoBand"],
                "autoDistance": band_distance(item["editorialBand"], item["autoBand"]),
                "autoWithin1": band_distance(item["editorialBand"], item["autoBand"]) <= 1,
                "autoSource": item["autoSource"],
                "autoFeatures": item.get("autoFeatures"),
                "notes": item.get("notes"),
            }
            for item in items
        ],
    }


def render_answer_sheet(items: Sequence[Mapping[str, Any]], rater: str) -> str:
    import io

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["anon_id", "order", "rater", "band", "confidence", "utr_bucket", "notes"])
    for item in items:
        writer.writerow([item["anonId"], item["order"], rater, "", "", "", ""])
    return buffer.getvalue()


def _baseline_rows(items: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for item in items:
        distance = band_distance(item["editorialBand"], item["autoBand"])
        rows.append(
            {
                "anon_id": item["anonId"],
                "order": item["order"],
                "split": item["split"],
                "source_set": item["sourceSet"],
                "kind": item["kind"],
                "editorial_band": item["editorialBand"],
                "auto_band": item["autoBand"],
                "auto_distance": distance,
                "within_1": "yes" if distance <= 1 else "no",
                "rater_a_band": "",
                "rater_a_confidence": "",
                "rater_b_band": "",
                "rater_b_confidence": "",
                "adjudicated_band": "",
                "notes": item.get("notes") or "",
            }
        )
    return rows


def render_baseline_csv(items: Sequence[Mapping[str, Any]]) -> str:
    import io

    buffer = io.StringIO()
    writer = csv.DictWriter(
        buffer,
        fieldnames=[
            "anon_id",
            "order",
            "split",
            "source_set",
            "kind",
            "editorial_band",
            "auto_band",
            "auto_distance",
            "within_1",
            "rater_a_band",
            "rater_a_confidence",
            "rater_b_band",
            "rater_b_confidence",
            "adjudicated_band",
            "notes",
        ],
    )
    writer.writeheader()
    writer.writerows(_baseline_rows(items))
    return buffer.getvalue()


def _agreement(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    counts: Counter[int] = Counter(int(row["auto_distance"]) for row in rows)
    exact = counts.get(0, 0)
    within1 = exact + counts.get(1, 0)
    total = len(rows)
    return {
        "n": total,
        "exact": exact,
        "exactRate": round(exact / total, 4) if total else None,
        "within1": within1,
        "within1Rate": round(within1 / total, 4) if total else None,
        "distance": {str(distance): count for distance, count in sorted(counts.items())},
    }


def baseline_summary(items: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    rows = _baseline_rows(items)

    def grouped(key: str) -> dict[str, Any]:
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            groups[str(row[key])].append(row)
        return {key_value: _agreement(group) for key_value, group in sorted(groups.items())}

    confusion: dict[str, dict[str, int]] = {}
    for row in rows:
        confusion.setdefault(str(row["editorial_band"]), {})
        confusion[str(row["editorial_band"])][str(row["auto_band"])] = (
            confusion[str(row["editorial_band"])].get(str(row["auto_band"]), 0) + 1
        )
    return {
        "overall": _agreement(rows),
        "bySplit": grouped("split"),
        "bySourceSet": grouped("source_set"),
        "byKind": grouped("kind"),
        "byEditorialBand": grouped("editorial_band"),
        "confusion": confusion,
    }


def render_baseline_json(
    items: Sequence[Mapping[str, Any]], counts: Mapping[str, Any], generated_at: str
) -> dict[str, Any]:
    return {
        "schema": SCHEMA_BASELINE,
        "version": BUILD_DATE,
        "generatedAt": generated_at,
        "status": "human_labels_pending",
        "notice": (
            "自动基线 = difficulty.v1 预测 vs 现有编辑标注（不是人工真值，不是效度证据）。"
            "人工标签 0/120，κ/一致率未计算；holdout 人类验收未完成。"
        ),
        "method": {
            "prediction": "difficulty.v1 的 cefr_input（p90 实词覆盖判带；视频以词法带为内容级主输出）",
            "editorial": "content_difficulty.level / 定位测 band / books.json level",
            "distance": "A1 折叠为 A2 后，按 A1<A2<B1<B2<C1<C1+ 的序号取绝对差",
            "unit": "每条锚 1 个 band；不按题目/字数加权",
        },
        "counts": counts,
        "agreement": baseline_summary(items),
        "humanLabels": {"filled": 0, "total": 120, "status": "pending"},
        "caveats": [
            "编辑标注不是独立人工真值；36 条来自已有的编辑等级回填，11 条来自定位测草稿，13 条来自 books.json 的书级等级。",
            "13 条公版书条目的编辑标注是「书级」，预测是对 ≤120 词节选计算；二者不完全同构。",
            "3 条原创文章条目的预测对全文计算，包内是 94–107 词节选；二者不完全同构。",
            "短文本（44–120 词）的 p90 不稳定，label_confidence 仅 0.3–0.55。",
            "视频条目的 cefr_input 是词法/文本带，不是听力带（est_cefr.listen）；人工评审若按整体难度评，二者不完全同轴。",
            "n=60 很小，且视频锚只给时间窗；不得把本表当 holdout 验收或对外准确率。",
        ],
    }


def render_report(
    items: Sequence[Mapping[str, Any]],
    counts: Mapping[str, Any],
    summary: Mapping[str, Any],
    generated_at: str,
) -> str:
    overall = summary["overall"]
    by_source = summary["bySourceSet"]
    by_kind = summary["byKind"]
    by_band = summary["byEditorialBand"]
    by_split = summary["bySplit"]
    strata_rows = counts["strata"]

    def rate(value: Mapping[str, Any]) -> str:
        return f"{value['within1']}/{value['n']}（{value['within1Rate']:.1%}）"

    def exact(value: Mapping[str, Any]) -> str:
        return f"{value['exact']}/{value['n']}（{value['exactRate']:.1%}）"

    lines: list[str] = [
        "# CEFR M2 内容难度锚校准报告（60 条准备）",
        "",
        f"> 版本：{BUILD_DATE} ｜ 生成：{generated_at} ｜ 状态：**人工评审未完成 → 校准未完成**",
        "",
        "## 结论（先说清楚没做什么）",
        "",
        "本报告完成了 **60 条盲评锚包、匿名化、rubric、truth 分离、自动基线对照**；"
        "**没有**完成人工双评，因此**没有计算或宣称 κ、人工一致率、人工 holdout ±1 覆盖率**，"
        "也**没有**据此改动 `difficulty.py` 阈值。",
        "",
        "自动基线只是「用 `difficulty.v1` 预测对照现有编辑标注」的参考数，**不是效度证据**，"
        "也不是 holdout 验收。60 条里的 20 条 holdout 人类标签仍为空。",
        "",
        "## 1. 60 条构成",
        "",
        "| 维度 | 数量 |",
        "|---|---:|",
        f"| 总数 | {counts['total']} |",
        f"| 40 条调参 / 20 条 holdout | {counts['calibration']} / {counts['holdout']} |",
        f"| 视频（YouTube 链接 + 时间窗） | {counts['video']} |",
        f"| 文章/短文/公版节选 | {counts['article']} |",
        f"| 来自 content_difficulty 36 条 | {counts['sourceSets'].get('content_difficulty_36', 0)} |",
        f"| 来自定位测原创短文 | {counts['sourceSets'].get('placement_11', 0)} |",
        f"| 来自公版书节选 | {counts['sourceSets'].get('public_domain_book_13', 0)} |",
        "",
        "**按编辑带 × 类型分层：**",
        "",
        "| 类型 | A2 | B1 | B2 | C1 | 调参/ holdout |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for kind in ("video", "article"):
        band_counts = {band: 0 for band in EDITORIAL_LEVELS}
        for row in strata_rows:
            if row["kind"] == kind:
                band_counts[row["band"]] = row["n"]
        totals = [row for row in strata_rows if row["kind"] == kind]
        cal = sum(row["calibration"] for row in totals)
        hold = sum(row["holdout"] for row in totals)
        lines.append(
            f"| {kind} | {band_counts['A2']} | {band_counts['B1']} | {band_counts['B2']} | "
            f"{band_counts['C1']} | {cal} / {hold} |"
        )
    lines.extend(
        [
            "",
            "> 视频 33 条 = 30 条精选 + 3 条本地库；文章 27 条 = 3 条原创文章 + 11 条定位测短文 + 13 条公版书节选。"
            "公版书节选在包内给全文（≤120 词），第三方视频只给链接 + 时间窗，不给字幕全文。"
            "定位测原有 13 条不同短文，去掉 2 条与 form 版本重叠的 legacy 版本（r-02 是 fb-p2 的前半段、"
            "r-05 是 fa-p3 的前半段），避免同一文本被同一位评审看到两次，故为 11 条。"
            "编辑带分布 A2 13 / B1 19 / B2 18 / C1 10；B1/B2 偏多是现有内容池的结构，扩到 100 条时再补 A2/C1。"
            "13 条公版书节选来自 `content/books/books.json` 已收录书目；英文原文按 books 运行期同一公版源"
            "（Project Gutenberg，美国公版）抓取，未改 `content/books/`，节选快照在 "
            "`scripts/cefr_anchor_book_excerpts.json`。",
            "",
            "## 2. 盲化与 truth 分离",
            "",
            "| 文件 | 用途 | 能不能给评审 |",
            "|---|---|---|",
            "| `cefr-anchor-packet-2026-11-17.md` | 60 条盲评包 + rubric + 空白评分栏 | ✅ 可以 |",
            "| `cefr-anchor-answer-sheet-rater-a-2026-11-17.csv` | 评审 A 的空白答案表 | ✅ 只给 A |",
            "| `cefr-anchor-answer-sheet-rater-b-2026-11-17.csv` | 评审 B 的空白答案表 | ✅ 只给 B |",
            "| `cefr-anchor-truth-2026-11-17.json` | 来源、编辑带、预测、调参/holdout 归属 | ❌ 不可以 |",
            "| `cefr-anchor-baseline-2026-11-17.csv` | 自动基线与人工列（空）对照表 | ❌ 不可以 |",
            "",
            "处理方式：① 60 条按 `sha256(seed + ':order:' + sourceKey)` 排序后发匿名 id `M2-001`…`M2-060`；"
            "② difficulty.v1 预测、编辑带、split 全部只写 truth；③ 包内条目块经机器断言不含任何 CEFR 带标签；"
            "④ 答案表按评审分文件，120 行全空。",
            "",
            "## 3. 自动基线（difficulty.v1 预测 vs 现有编辑标注）",
            "",
            "**方法**：预测取 `difficulty.v1` 的 `cefr_input`（p90 实词覆盖判带，`rule.v1+freq.p90.v1`）。"
            "36 条读已提交回填报告；11 条定位测短文与 13 条公版书节选在脚本内重算 `compute_article_features`。"
            "距离按 A1 折叠为 A2 后的 `A1<A2<B1<B2<C1<C1+` 序号绝对差；±1 = 距离 ≤1。",
            "",
            "| 汇总 | ±1 带 | 完全一致 | 样本 |",
            "|---|---:|---:|---:|",
            f"| **60 条总体** | **{rate(overall)}** | {exact(overall)} | {overall['n']} |",
        ]
    )
    for source in ("content_difficulty_36", "placement_11", "public_domain_book_13"):
        value = by_source.get(source)
        if value:
            lines.append(f"| {source} | {rate(value)} | {exact(value)} | {value['n']} |")
    for kind in ("video", "article"):
        value = by_kind.get(kind)
        if value:
            lines.append(f"| {kind} | {rate(value)} | {exact(value)} | {value['n']} |")
    for band in EDITORIAL_LEVELS:
        value = by_band.get(band)
        if value:
            lines.append(f"| 编辑带 {band} | {rate(value)} | {exact(value)} | {value['n']} |")
    if by_split.get("calibration") and by_split.get("holdout"):
        lines.append(
            f"| 调参 40 / holdout 20（参考，不是验收） | {rate(by_split['calibration'])} / "
            f"{rate(by_split['holdout'])} | {exact(by_split['calibration'])} / "
            f"{exact(by_split['holdout'])} | 40 / 20 |"
        )
    confusion = summary.get("confusion") or {}
    confusion_columns = ["A2", "B1", "B2", "C1", "C1+"]
    lines.extend(
        [
            "",
            "**混淆矩阵（行 = 编辑标注，列 = difficulty.v1 预测；A1 已折叠为 A2）：**",
            "",
            "| 编辑 → 预测 | " + " | ".join(confusion_columns) + " |",
            "|---|" + "---:|" * len(confusion_columns),
        ]
    )
    for editorial in EDITORIAL_LEVELS:
        values = confusion.get(editorial, {})
        lines.append(
            f"| {editorial} | " + " | ".join(str(values.get(column, 0)) for column in confusion_columns) + " |"
        )
    lines.extend(
        [
            "",
            f"**读法**：60 条总体 ±1 为 {overall['within1Rate']:.1%}，"
            f"与 36 条内容的 {by_source['content_difficulty_36']['within1Rate']:.1%}"
            f"（{by_source['content_difficulty_36']['within1']}/{by_source['content_difficulty_36']['n']}）接近；A2 组只有 5/13，"
            "主要来自公版书节选——词频代理把 1900 年前后的儿童文学判高 2–4 带。"
            "这既可能是编辑标注偏低，也可能是频表/阈值在叙事文本上的偏差，**必须由人工锚裁定**，"
            "本报告不判定谁对谁错。定位测短文体量小（44–99 词），10/11 落 ±1，但 p90 不稳定、置信度 0.3–0.55。"
            "**n=60 很小，编辑标注不是独立人工双评；本表不能当 holdout 验收，也不能对外宣称准确率。**",
            "",
            "## 4. 可复现",
            "",
            "```bash",
            "cd /Users/piece/Desktop/Me/EnglishLearning/yt-bilingual-app",
            "backend/venv/bin/python scripts/build_cefr_anchor_packet.py",
            "```",
            "",
            "- 输入只读；不写 `content/books/`、不改 `difficulty.py`、不写 `.env`、不 git 提交。",
            "- **全流程 0 LLM**：条目筛选、匿名化、基线计算都是脚本/规则；没有用 LLM 生成任何人工标注。",
            "- 36 条预测直接来自已提交的回填报告；11 + 13 条文本用 `content/wordlist/frequency_bands.v1.json` 重算。",
            "- 视频时间窗需要 `data/curated-subtitles/`（gitignored）；缺缓存时脚本回退为按比例时间窗，"
            "但不会改基线数字。",
            "- 词表 sha256：" + counts["wordlistSha256"][:16] + "…（完整值见 baseline JSON）。",
            "",
            "## 5. 复核计划（人工双评，未完成）",
            "",
            "| 步骤 | 做法 | 通过线 |",
            "|---|---|---|",
            "| 1 评审 | 2 名有 CEFR 经验的教研/教师，各自独立评 60 条；先不看 truth | — |",
            "| 2 信度 | 对 5 类 band 算未加权 Cohen's κ（A1–C1） | **κ ≥ 0.70** |",
            "| 3 分歧 | abs(A−B) ≥1 的条目交第三位评审/教研 owner 仲裁；κ 仍按独立标签报，不用仲裁后的标签掩盖 | — |",
            "| 4 调参 | 只用 40 条 calibration 做混淆矩阵与阈值调整；20 条 holdout 不参与调参 | 调参集 ±1 ≥80% |",
            "| 5 holdout | 用仲裁后/共识标签在 20 条 holdout 上报 ±1 覆盖率 + Wilson 95% CI | **±1 ≥80%**，并写 CI |",
            "| 6 失败处理 | κ<0.70 或 holdout<80% → 按计划书 §9.7 降级；不宣称已校准 | — |",
            "",
            "分析脚本：`scripts/cefr_anchor_analyze.py`。它只在 A/B 两表 60 条都填完时计算；"
            "缺标签时只输出 `pending`，不生成任何数字。κ 达标前，不对外说「已校准/准确率 X%」。",
            "",
            "```bash",
            "backend/venv/bin/python scripts/cefr_anchor_analyze.py \\",
            "  --truth docs/reports/cefr-anchor-truth-2026-11-17.json \\",
            "  --rater-a path/to/rater-a.csv --rater-b path/to/rater-b.csv \\",
            "  [--adjudicated path/to/adjudicated.csv] [--output /tmp/analysis.json]",
            "```",
            "",
            f"> {BUILD_DATE} 用空白答案表试跑分析脚本：`status=pending`，`filled=0/120`，`metrics=null`；"
            "未计算 κ，也没有生成任何人工标签。",
            "",
            "## 6. 待办（明确未完成）",
            "",
            "- [ ] 招募 2 名独立评审，发 packet + 各自答案表；",
            "- [ ] 回收 120 条人工 band（60×2），检查完整性与独立性声明；",
            "- [ ] 跑 `cefr_anchor_analyze.py`：κ、人工-人工 ±1、混淆矩阵；",
            "- [ ] 对 |A−B|≥1 的条目做第三人仲裁，形成 consensus band；",
            "- [ ] 只在 40 条 calibration 上调 p90/p95/wpm 阈值；冻结后跑 20 条 holdout；",
            "- [ ] 写 holdout ±1 + Wilson 95% CI；不达标按 §9.7 降级；",
            "- [ ] 达标后才更新 `difficulty.py` 阈值、golden 与 §6.7/§10.2 进度（本轮不改）。",
            "",
            "## 7. 验收对照",
            "",
            "| 验收项 | 状态 |",
            "|---|---|",
            "| 盲评包可独立使用 | ✅ packet + rubric + 空白答案表 |",
            "| truth 与盲评包分离 | ✅ 两个文件；包内无等级断言 |",
            "| 自动基线数字可复现 | ✅ 脚本 + 只读输入；36 条来自提交报告 |",
            "| 报告明确未完成 | ✅ 状态与待办已写明；κ/一致率未计算 |",
            "| 人工结果留空 | ✅ 120 行空白；分析脚本 pending |",
            "",
            "> 一句话：**包已就绪，人还没评；在两位评审完成前，这不是一次已完成的校准。**",
            "",
        ]
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def build(out_dir: str) -> dict[str, Any]:
    items = _content36_items() + _placement_items() + _book_items()
    if len(items) != TOTAL:
        raise ValueError(f"条目总数 {len(items)}，期望 {TOTAL}")
    keys = [item["sourceKey"] for item in items]
    if len(set(keys)) != len(keys):
        raise ValueError("sourceKey 重复")
    assign_split(items)
    ordered = assign_anon_ids(items)

    # counts / strata
    strata_counter: dict[tuple[str, str], dict[str, int]] = {}
    for item in ordered:
        key = (item["kind"], item["editorialBand"])
        row = strata_counter.setdefault(key, {"n": 0, "calibration": 0, "holdout": 0})
        row["n"] += 1
        row[item["split"]] += 1
    strata_rows = [
        {
            "kind": key[0],
            "band": key[1],
            "n": value["n"],
            "calibration": value["calibration"],
            "holdout": value["holdout"],
        }
        for key, value in sorted(strata_counter.items())
    ]
    wordlist_path = os.path.join(ROOT, "content", "wordlist", "frequency_bands.v1.json")
    with open(wordlist_path, "rb") as handle:
        wordlist_bytes = handle.read()
    counts = {
        "total": len(ordered),
        "calibration": sum(1 for item in ordered if item["split"] == "calibration"),
        "holdout": sum(1 for item in ordered if item["split"] == "holdout"),
        "video": sum(1 for item in ordered if item["kind"] == "video"),
        "article": sum(1 for item in ordered if item["kind"] == "article"),
        "sourceSets": dict(Counter(item["sourceSet"] for item in ordered)),
        "strata": strata_rows,
        "wordlistSha256": hashlib.sha256(wordlist_bytes).hexdigest(),
    }
    if counts["calibration"] != CALIBRATION_TARGET or counts["holdout"] != HOLDOUT_TARGET:
        raise ValueError(f"split 计数异常：{counts}")
    generated_at = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")

    os.makedirs(out_dir, exist_ok=True)
    paths = {
        "packet": os.path.join(out_dir, f"cefr-anchor-packet-{BUILD_DATE}.md"),
        "answer_a": os.path.join(out_dir, f"cefr-anchor-answer-sheet-rater-a-{BUILD_DATE}.csv"),
        "answer_b": os.path.join(out_dir, f"cefr-anchor-answer-sheet-rater-b-{BUILD_DATE}.csv"),
        "truth": os.path.join(out_dir, f"cefr-anchor-truth-{BUILD_DATE}.json"),
        "baseline_csv": os.path.join(out_dir, f"cefr-anchor-baseline-{BUILD_DATE}.csv"),
        "baseline_json": os.path.join(out_dir, f"cefr-anchor-baseline-{BUILD_DATE}.json"),
        "report": os.path.join(out_dir, f"cefr-anchor-report-{BUILD_DATE}.md"),
    }
    packet = render_packet(ordered, counts)
    truth = render_truth(ordered, counts, generated_at)
    baseline = render_baseline_json(ordered, counts, generated_at)
    summary = baseline["agreement"]
    report = render_report(ordered, counts, {**counts, **summary}, generated_at)

    with open(paths["packet"], "w", encoding="utf-8") as handle:
        handle.write(packet)
    with open(paths["answer_a"], "w", encoding="utf-8-sig") as handle:
        handle.write(render_answer_sheet(ordered, "A"))
    with open(paths["answer_b"], "w", encoding="utf-8-sig") as handle:
        handle.write(render_answer_sheet(ordered, "B"))
    with open(paths["truth"], "w", encoding="utf-8") as handle:
        json.dump(truth, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    with open(paths["baseline_csv"], "w", encoding="utf-8-sig") as handle:
        handle.write(render_baseline_csv(ordered))
    with open(paths["baseline_json"], "w", encoding="utf-8") as handle:
        json.dump(baseline, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    with open(paths["report"], "w", encoding="utf-8") as handle:
        handle.write(report)

    return {
        "counts": counts,
        "agreement": summary,
        "paths": paths,
        "generatedAt": generated_at,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out-dir",
        default=os.path.join(ROOT, "docs", "reports"),
        help="输出目录（默认 docs/reports）",
    )
    args = parser.parse_args(argv)
    result = build(args.out_dir)
    print(json.dumps(result["counts"], ensure_ascii=False, indent=2))
    print(json.dumps(result["agreement"], ensure_ascii=False, indent=2))
    print("wrote:")
    for name, path in result["paths"].items():
        print(f"  {name}: {os.path.relpath(path, ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
