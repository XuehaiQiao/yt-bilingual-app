#!/usr/bin/env python3
"""构建单词本词表（CEFR + GRE/CET4/CET6）——语途（LinguaTrek）单词本页面。

产物（随仓库分发、运行期只读）：

- ``content/wordlists/exam-bands.v1.json``：GRE / CET4 / CET6 词表索引，
  ``word -> [tagMask, rank]``。标签来自 ECDICT 官方 ``ecdict.csv`` 的 ``tag``
  列（不是拿词频冒充考试词表）；排序用 ``frq``（缺失回退 ``bnc``）。
- ``content/wordlists/lexicon.v1.json``：上述考试词 + CEFR 10k lemma 的
  ``word -> [phonetic, translation]`` 释义索引。中文释义取 ECDICT
  ``translation`` 里第一个含中文的行，截断到 120 字符；音标原样保留。
- ``content/wordlists/SHA256SUMS``：两个产物的文件哈希。

CEFR A1–C1 的成员**不**在本脚本里复制：运行期直接读已有
``content/wordlist/frequency_bands.v1.json``（wordfreq 3.1.1 数据，CC BY-SA
4.0），按现有锚点 A1≤1k / A2≤2k / B1≤4k / B2≤7k / C1≤10k 派生。C2 没有
词表，API 标 ``available:false``，不拿 GRE 冒充。

数据源与许可
------------
ECDICT（<https://github.com/skywind3000/ECDICT>）仓库代码 MIT；词典数据由
作者从 EDictAZ、cdict-1.0-1.rpm、四六级/GRE 词表、BNC 语料库等多来源整理，
各来源授权状况不一。本仓库只分发紧凑的「词 → 标签/秩」与「词 → 音标/首行
中文释义」派生数据，不提交 60MB CSV；对外分发/商用前请复核 ECDICT 数据授权。
详见 ``content/wordlists/NOTICE.md``。

用法
----
    # 1. 下载官方 CSV 到 /tmp（不要放进仓库）
    curl -L -o /tmp/ecdict-full.csv \\
        https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv

    # 2. 重建（幂等；不会把 CSV 写进仓库）
    backend/venv/bin/python scripts/build_word_lists.py \\
        --ecdict-csv /tmp/ecdict-full.csv

    # 3. 只校验（离线：结构/完整性/频表覆盖）
    backend/venv/bin/python scripts/build_word_lists.py --check

    # 4. 完整重建对比（需要 CSV；CI 有快照时用）
    backend/venv/bin/python scripts/build_word_lists.py --check \\
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

EXAM_FILENAME = "exam-bands.v1.json"
LEXICON_FILENAME = "lexicon.v1.json"
SIDECAR_FILENAME = "SHA256SUMS"
NOTICE_FILENAME = "NOTICE.md"
README_FILENAME = "README.md"

SCHEMA_EXAM = "linguatrek.exam-bands.v1"
SCHEMA_LEXICON = "linguatrek.lexicon.v1"
FREQUENCY_SCHEMA = "linguatrek.wordlist.v1"
FREQUENCY_LICENSE = "CC-BY-SA-4.0"

# 产物版本：跟频表版本同一日期；重建时可用 --version 覆盖。
ARTIFACT_VERSION = "2026.11.17"

# ECDICT tag -> 紧凑位掩码。只收单词本需要的三类；zk/gk/ky/toefl/ielts 不
# 进入本产物（需要时另开词表，不在这里偷偷扩语义）。
TAG_BITS: Dict[str, int] = {"cet4": 1, "cet6": 2, "gre": 4}
TAG_NAMES: Dict[int, str] = {bit: tag for tag, bit in TAG_BITS.items()}

# 生产构建的规模护栏：防止拿错文件/空 tag 列静默生成「空词表」。
MIN_EXAM_UNIQUE = 8_000
MIN_TAG_COUNTS = {"cet4": 3_000, "cet6": 4_000, "gre": 6_000}

WORD_RE = re.compile(r"^[A-Za-z]+$")
LOWER_WORD_RE = re.compile(r"^[a-z]+$")
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
WS_RE = re.compile(r"\s+")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")

TRANSLATION_LIMIT = 120


class BuildError(RuntimeError):
    """构建/校验失败，消息可直接展示给用户。"""


# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------

def file_sha256(path: Path) -> str:
    """文件 SHA-256（分块读，不把 60MB CSV 读进内存）。"""
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


def clean_phonetic(raw: Any) -> str:
    return WS_RE.sub(" ", str(raw or "").strip())


def clean_translation(raw: Any, limit: int = TRANSLATION_LIMIT) -> str:
    """ECDICT translation → 第一个含中文的行；保留词性前缀，截断到 limit。"""
    if raw is None:
        return ""
    text = str(raw)
    # ECDICT CSV 把多义项写成字面量 "\\n"（反斜杠 + n），也兼容真换行。
    text = text.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    chosen = ""
    for line in lines:
        if CJK_RE.search(line):
            chosen = line
            break
    # 没有中文的 translation 对中文词表没有价值（与 local_dict 的口径一致）。
    chosen = WS_RE.sub(" ", chosen).strip()
    if len(chosen) > limit:
        chosen = chosen[: limit - 1].rstrip() + "…"
    return chosen


def parse_rank(row: Dict[str, str]) -> int:
    """ECDICT 当代语料库 frq 优先，缺失回退 BNC；都没有排到最后。"""
    for field in ("frq", "bnc"):
        raw = str(row.get(field) or "").strip()
        if raw.isdigit():
            value = int(raw)
            if value > 0:
                return value
    return 999_999


def tag_mask(tags: Iterable[str]) -> int:
    mask = 0
    for tag in tags:
        bit = TAG_BITS.get(tag)
        if bit:
            mask |= bit
    return mask


# ---------------------------------------------------------------------------
# 频表（CEFR 来源）加载/校验
# ---------------------------------------------------------------------------

def frequency_payload_sha256(document: Dict[str, Any]) -> str:
    """与 backend/difficulty.py 的 integrity 口径保持一致。"""
    payload = {
        "entries": document["entries"],
        "forms": document["forms"],
        "band_size": document["band_size"],
        "cefr_anchors": document["cefr_anchors"],
        "limit": document["counts"]["lemmas"],
        "version": document["version"],
    }
    return payload_sha256(payload)


def validate_frequency_document(document: Dict[str, Any]) -> List[str]:
    problems: List[str] = []

    def require(condition: bool, message: str) -> None:
        if not condition:
            problems.append(message)

    if not isinstance(document, dict):
        return ["频表不是 JSON 对象"]
    require(document.get("schema") == FREQUENCY_SCHEMA, f"频表 schema 必须是 {FREQUENCY_SCHEMA}")
    require(document.get("license") == FREQUENCY_LICENSE, f"频表 license 必须是 {FREQUENCY_LICENSE}")
    entries = document.get("entries")
    forms = document.get("forms")
    require(isinstance(entries, list) and bool(entries), "频表 entries 必须是非空数组")
    require(isinstance(forms, dict), "频表 forms 必须是对象")
    if isinstance(entries, list):
        seen: set = set()
        for index, entry in enumerate(entries):
            if not (isinstance(entry, list) and len(entry) == 2):
                problems.append(f"频表 entries[{index}] 必须是 [lemma, rank]")
                return problems
            lemma, rank = entry
            if not isinstance(lemma, str) or not LOWER_WORD_RE.fullmatch(lemma):
                problems.append(f"频表 entries[{index}] lemma 非法：{lemma!r}")
                return problems
            if lemma in seen:
                problems.append(f"频表 lemma 重复：{lemma}")
                return problems
            seen.add(lemma)
            if not isinstance(rank, int) or rank != index + 1:
                problems.append(f"频表 entries[{index}] rank 必须连续且等于 {index + 1}")
                return problems
    integrity = document.get("integrity")
    require(isinstance(integrity, dict), "频表缺少 integrity")
    if isinstance(integrity, dict):
        try:
            expected = frequency_payload_sha256(document)
        except (KeyError, TypeError, ValueError) as exc:
            problems.append(f"频表 integrity 计算失败：{exc}")
        else:
            require(integrity.get("sha256") == expected, "频表 integrity.sha256 与内容不一致")
    return problems


def load_frequency(path: Path) -> Dict[str, Any]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise BuildError(f"无法读取频表 {path}：{exc}") from exc
    problems = validate_frequency_document(document)
    if problems:
        raise BuildError("频表校验失败：" + "；".join(problems[:5]))
    return document


def frequency_lemmas(document: Dict[str, Any]) -> List[str]:
    return [entry[0] for entry in document["entries"]]


# ---------------------------------------------------------------------------
# 构建
# ---------------------------------------------------------------------------

def _load_ecdict(
    csv_path: Path, cefr_lemmas: Iterable[str], *, allow_small: bool
) -> Tuple[Dict[str, List[Any]], Dict[str, List[str]], Dict[str, Any]]:
    """一遍流式扫 CSV：考试标签 + 所需词的音标/中文首行。

    只保留 ``^[A-Za-z]+$`` 词条；返回 (exam, details, source_meta)。
    ``exam`` 的键是小写词，值是 ``[displayWord, tagMask, rank]``。
    """
    cefr_set = set(cefr_lemmas)
    exam: Dict[str, List[Any]] = {}
    details: Dict[str, List[str]] = {}
    rows = 0
    tagged_rows = 0
    exam_tagged_rows = 0

    try:
        handle = csv_path.open("r", encoding="utf-8-sig", newline="")
    except OSError as exc:
        raise BuildError(f"无法读取 ECDICT CSV {csv_path}：{exc}") from exc

    with handle:
        reader = csv.DictReader(handle)
        fieldnames = set(reader.fieldnames or [])
        required = {"word", "phonetic", "translation", "tag", "frq", "bnc"}
        missing = sorted(required - fieldnames)
        if missing:
            raise BuildError(
                "ECDICT CSV 缺少列：" + ", ".join(missing)
                + "。本脚本只支持官方带 tag 的快照；没有 tag 时不要用频带近似"
                "冒充官方考试词表（若确需近似，应另写带 approximate:true 的构建路径）。"
            )
        for row in reader:
            rows += 1
            raw_word = str(row.get("word") or "").strip()
            if not WORD_RE.fullmatch(raw_word):
                continue
            lower = raw_word.lower()
            tags = set(str(row.get("tag") or "").lower().split())
            if tags:
                tagged_rows += 1
            mask = tag_mask(tags)
            if mask:
                exam_tagged_rows += 1
            rank = parse_rank(row)
            if mask:
                existing = exam.get(lower)
                if existing is None:
                    exam[lower] = [raw_word, mask, rank]
                else:
                    existing[1] |= mask
                    if rank < existing[2]:
                        existing[2] = rank
            if mask or lower in cefr_set:
                phonetic = clean_phonetic(row.get("phonetic"))
                translation = clean_translation(row.get("translation"))
                current = details.get(lower)
                if current is None:
                    details[lower] = [phonetic, translation]
                else:
                    if not current[0] and phonetic:
                        current[0] = phonetic
                    if not current[1] and translation:
                        current[1] = translation

    for lemma in cefr_set:
        details.setdefault(lemma, ["", ""])
    for word in exam:
        details.setdefault(word, ["", ""])

    if not allow_small:
        if len(exam) < MIN_EXAM_UNIQUE:
            raise BuildError(
                f"考试词表只有 {len(exam)} 个词（< {MIN_EXAM_UNIQUE}），"
                "疑似 CSV 不对或 tag 列全空；确认是官方快照后才加 --allow-small。"
            )
        missing_tags = [
            tag
            for tag, minimum in MIN_TAG_COUNTS.items()
            if sum(1 for _, mask, _ in exam.values() if mask & TAG_BITS[tag]) < minimum
        ]
        if missing_tags:
            raise BuildError(
                "以下考试标签词数低于护栏：" + ", ".join(missing_tags)
                + "；疑似 CSV 不对，确认后才加 --allow-small。"
            )

    source_meta = {
        "name": "ECDICT",
        "url": "https://github.com/skywind3000/ECDICT",
        "snapshot": "ecdict.csv@master",
        "csvSha256": file_sha256(csv_path),
        "rows": rows,
        "taggedRows": tagged_rows,
        "examTaggedRows": exam_tagged_rows,
        "tagField": "tag",
        "rankField": "frq（缺失时 bnc，再缺省 999999）",
        "wordFilter": "^[A-Za-z]+$",
        "translationRule": (
            f"translation 第一个含中文的行；压缩空白；超过 {TRANSLATION_LIMIT} 字符截断"
        ),
        "note": (
            "GRE/CET4/CET6 来自 ECDICT tag 列；ECDICT 是词表整理库，"
            "不是考试机构官方发布。不提交原始 CSV。"
        ),
    }
    return exam, details, source_meta


def exam_payload_sha256(document: Dict[str, Any]) -> str:
    payload = {
        "entries": document["entries"],
        "counts": document["counts"],
        "tagBits": document["tagBits"],
        "version": document["version"],
        "sourceCsvSha256": document["source"]["csvSha256"],
    }
    return payload_sha256(payload)


def lexicon_payload_sha256(document: Dict[str, Any]) -> str:
    payload = {
        "entries": document["entries"],
        "counts": document["counts"],
        "version": document["version"],
        "sourceCsvSha256": document["source"]["csvSha256"],
    }
    return payload_sha256(payload)


def build_documents(
    csv_path: Path,
    frequency: Dict[str, Any],
    *,
    version: str = ARTIFACT_VERSION,
    allow_small: bool = False,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    lemmas = frequency_lemmas(frequency)
    exam, details, source_meta = _load_ecdict(
        csv_path, lemmas, allow_small=allow_small
    )

    ordered_exam = sorted(exam.items(), key=lambda item: (item[1][2], item[0]))
    exam_entries = [[value[0], value[1], value[2]] for _, value in ordered_exam]
    exam_counts: Dict[str, int] = {
        tag: sum(1 for _, mask, _ in exam.values() if mask & bit)
        for tag, bit in TAG_BITS.items()
    }
    exam_counts["unique"] = len(exam)
    if any(count <= 0 for count in exam_counts.values()):
        raise BuildError("考试词表存在空标签（tag 位没有对应词条）")

    exam_source = dict(source_meta)
    exam_source["note"] = (
        "GRE/CET4/CET6 来自 ECDICT tag 列；ECDICT 是词表整理库，"
        "不是考试机构官方发布。中文释义/音标另见 lexicon.v1.json；"
        "不提交原始 CSV。"
    )
    exam_document: Dict[str, Any] = {
        "schema": SCHEMA_EXAM,
        "version": version,
        "source": exam_source,
        "license": (
            "MIT (ECDICT repository code); ECDICT dictionary data compiled from "
            "multiple sources — see NOTICE.md"
        ),
        "notice": NOTICE_FILENAME,
        "tagBits": dict(TAG_BITS),
        "counts": exam_counts,
        "entries": exam_entries,
    }
    exam_document["integrity"] = {
        "algorithm": "sha256",
        "scope": "entries+counts+tagBits+version+source.csvSha256",
        "sha256": exam_payload_sha256(exam_document),
    }

    lexicon_entries: Dict[str, List[str]] = {
        word: [details[word][0], details[word][1]] for word in sorted(details)
    }
    lexicon_document: Dict[str, Any] = {
        "schema": SCHEMA_LEXICON,
        "version": version,
        "source": {
            "name": "ECDICT",
            "url": "https://github.com/skywind3000/ECDICT",
            "snapshot": "ecdict.csv@master",
            "csvSha256": exam_source["csvSha256"],
            "cefrSource": (
                "content/wordlist/frequency_bands.v1.json（wordfreq 3.1.1 数据，"
                "CC BY-SA 4.0）"
            ),
            "note": (
                "只含词 → [phonetic, translation] 的紧凑释义索引，不含原 CSV、"
                "英文释义、例句或音频繁表；中文释义截断到首个含中文行。"
            ),
        },
        "license": (
            "See NOTICE.md — ECDICT data terms (code MIT); CEFR frequency bands "
            "CC-BY-SA-4.0"
        ),
        "notice": NOTICE_FILENAME,
        "counts": {
            "entries": len(lexicon_entries),
            "withPhonetic": sum(1 for value in lexicon_entries.values() if value[0]),
            "withTranslation": sum(1 for value in lexicon_entries.values() if value[1]),
            "cefrLemmas": len(lemmas),
            "examWords": len(exam),
            "translationLimit": TRANSLATION_LIMIT,
        },
        "entries": lexicon_entries,
    }
    lexicon_document["integrity"] = {
        "algorithm": "sha256",
        "scope": "entries+counts+version+source.csvSha256",
        "sha256": lexicon_payload_sha256(lexicon_document),
    }
    return exam_document, lexicon_document


# ---------------------------------------------------------------------------
# 产物校验
# ---------------------------------------------------------------------------

def validate_exam_document(document: Dict[str, Any]) -> List[str]:
    problems: List[str] = []

    def require(condition: bool, message: str) -> None:
        if not condition:
            problems.append(message)

    if not isinstance(document, dict):
        return ["exam-bands 不是 JSON 对象"]
    require(document.get("schema") == SCHEMA_EXAM, f"schema 必须是 {SCHEMA_EXAM}")
    require(bool(document.get("version")), "缺少 version")
    require(isinstance(document.get("source"), dict), "缺少 source")
    source = document.get("source")
    if isinstance(source, dict):
        require(bool(source.get("name")), "source.name 缺失")
        require(bool(source.get("url")), "source.url 缺失")
        require(
            isinstance(source.get("csvSha256"), str)
            and bool(SHA_RE.fullmatch(str(source.get("csvSha256")))),
            "source.csvSha256 缺失/格式不对",
        )
    require(bool(document.get("license")), "缺少 license")
    require(document.get("notice") == NOTICE_FILENAME, f"notice 必须是 {NOTICE_FILENAME}")
    require(document.get("tagBits") == TAG_BITS, f"tagBits 必须是 {TAG_BITS}")
    entries = document.get("entries")
    require(isinstance(entries, list) and bool(entries), "entries 必须是非空数组")
    if not isinstance(entries, list):
        return problems
    seen: set = set()
    ordered_keys: List[Tuple[int, str]] = []
    counts = {tag: 0 for tag in TAG_BITS}
    for index, entry in enumerate(entries):
        if not (isinstance(entry, list) and len(entry) == 3):
            problems.append(f"entries[{index}] 必须是 [word, tagMask, rank]")
            return problems
        word, mask, rank = entry
        if not isinstance(word, str) or not WORD_RE.fullmatch(word):
            problems.append(f"entries[{index}] word 非法：{word!r}")
            return problems
        lower = word.lower()
        if lower in seen:
            problems.append(f"entries[{index}] word 重复：{word}")
            return problems
        seen.add(lower)
        if not isinstance(mask, int) or not (1 <= mask <= 7):
            problems.append(f"entries[{index}] tagMask 非法：{mask!r}")
            return problems
        for tag, bit in TAG_BITS.items():
            if mask & bit:
                counts[tag] += 1
        if not isinstance(rank, int) or not (1 <= rank <= 999_999):
            problems.append(f"entries[{index}] rank 非法：{rank!r}")
            return problems
        ordered_keys.append((rank, lower))
    require(ordered_keys == sorted(ordered_keys), "entries 必须按 (rank, 小写词) 升序")
    expected_counts: Dict[str, int] = dict(counts)
    expected_counts["unique"] = len(entries)
    require(document.get("counts") == expected_counts, f"counts 与 entries 不一致：{expected_counts}")
    integrity = document.get("integrity")
    require(isinstance(integrity, dict), "缺少 integrity")
    if isinstance(integrity, dict):
        try:
            expected = exam_payload_sha256(document)
        except (KeyError, TypeError, ValueError) as exc:
            problems.append(f"integrity 计算失败：{exc}")
        else:
            require(integrity.get("sha256") == expected, "integrity.sha256 与内容不一致")
    return problems


def validate_lexicon_document(
    document: Dict[str, Any],
    frequency: Dict[str, Any],
    exam_document: Optional[Dict[str, Any]] = None,
) -> List[str]:
    problems: List[str] = []

    def require(condition: bool, message: str) -> None:
        if not condition:
            problems.append(message)

    if not isinstance(document, dict):
        return ["lexicon 不是 JSON 对象"]
    require(document.get("schema") == SCHEMA_LEXICON, f"schema 必须是 {SCHEMA_LEXICON}")
    require(bool(document.get("version")), "缺少 version")
    require(isinstance(document.get("source"), dict), "缺少 source")
    source = document.get("source")
    if isinstance(source, dict):
        require(bool(source.get("name")), "source.name 缺失")
        require(
            isinstance(source.get("csvSha256"), str)
            and bool(SHA_RE.fullmatch(str(source.get("csvSha256")))),
            "source.csvSha256 缺失/格式不对",
        )
    require(bool(document.get("license")), "缺少 license")
    require(document.get("notice") == NOTICE_FILENAME, f"notice 必须是 {NOTICE_FILENAME}")
    entries = document.get("entries")
    require(isinstance(entries, dict) and bool(entries), "entries 必须是非空对象")
    if not isinstance(entries, dict):
        return problems
    keys = list(entries)
    require(keys == sorted(keys), "entries 必须按词升序")
    with_phonetic = 0
    with_translation = 0
    for word, value in entries.items():
        if not isinstance(word, str) or not LOWER_WORD_RE.fullmatch(word):
            problems.append(f"entries 键必须是小写纯字母：{word!r}")
            return problems
        if not (isinstance(value, list) and len(value) == 2):
            problems.append(f"entries[{word}] 必须是 [phonetic, translation]")
            return problems
        if not isinstance(value[0], str) or not isinstance(value[1], str):
            problems.append(f"entries[{word}] 的 phonetic/translation 必须是字符串")
            return problems
        if value[0]:
            with_phonetic += 1
        if value[1]:
            with_translation += 1
    expected_counts = {
        "entries": len(entries),
        "withPhonetic": with_phonetic,
        "withTranslation": with_translation,
        "cefrLemmas": len(frequency_lemmas(frequency)),
        "examWords": len(exam_document["entries"]) if exam_document else None,
        "translationLimit": TRANSLATION_LIMIT,
    }
    counts = document.get("counts")
    require(isinstance(counts, dict), "缺少 counts")
    if isinstance(counts, dict):
        for key, expected in expected_counts.items():
            if expected is None:
                continue
            require(counts.get(key) == expected, f"counts.{key} 应为 {expected}")
    missing_cefr = [lemma for lemma in frequency_lemmas(frequency) if lemma not in entries]
    require(not missing_cefr, f"CEFR lemma 未覆盖（示例：{missing_cefr[:5]}）")
    if exam_document is not None:
        missing_exam = [
            str(entry[0]).lower()
            for entry in exam_document["entries"]
            if str(entry[0]).lower() not in entries
        ]
        require(not missing_exam, f"考试词未覆盖（示例：{missing_exam[:5]}）")
    integrity = document.get("integrity")
    require(isinstance(integrity, dict), "缺少 integrity")
    if isinstance(integrity, dict):
        try:
            expected = lexicon_payload_sha256(document)
        except (KeyError, TypeError, ValueError) as exc:
            problems.append(f"integrity 计算失败：{exc}")
        else:
            require(integrity.get("sha256") == expected, "integrity.sha256 与内容不一致")
    return problems


def read_sidecar(path: Path) -> Dict[str, str]:
    """读 SHA256SUMS；返回 {文件名: 哈希}，格式错误抛 BuildError。"""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise BuildError(f"无法读取 {path}：{exc}") from exc
    hashes: Dict[str, str] = {}
    for line in lines:
        if not line.strip():
            continue
        parts = line.split()
        if len(parts) != 2 or not SHA_RE.fullmatch(parts[0]):
            raise BuildError(f"SHA256SUMS 行格式不对：{line!r}")
        hashes[parts[1]] = parts[0]
    return hashes


def check_artifacts(
    frequency_path: Path,
    out_dir: Path,
    *,
    csv_path: Optional[Path] = None,
    version: str = ARTIFACT_VERSION,
    allow_small: bool = False,
) -> List[str]:
    problems: List[str] = []
    frequency = load_frequency(frequency_path)

    exam_path = out_dir / EXAM_FILENAME
    lexicon_path = out_dir / LEXICON_FILENAME
    sidecar_path = out_dir / SIDECAR_FILENAME
    for path in (exam_path, lexicon_path):
        if not path.exists():
            problems.append(f"产物不存在：{path}")
    if problems:
        return problems

    try:
        exam_document = json.loads(exam_path.read_text(encoding="utf-8"))
        lexicon_document = json.loads(lexicon_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return [f"无法解析产物：{exc}"]

    problems.extend(validate_exam_document(exam_document))
    problems.extend(
        validate_lexicon_document(lexicon_document, frequency, exam_document)
    )

    try:
        sidecar = read_sidecar(sidecar_path)
    except BuildError as exc:
        problems.append(str(exc))
    else:
        expected_names = {EXAM_FILENAME, LEXICON_FILENAME}
        if set(sidecar) != expected_names:
            problems.append(
                "SHA256SUMS 条目必须正好是 "
                + ", ".join(sorted(expected_names))
                + f"（实际：{sorted(sidecar)}）"
            )
        for path in (exam_path, lexicon_path):
            if path.name in sidecar and sidecar[path.name] != file_sha256(path):
                problems.append(f"SHA256SUMS 哈希不匹配：{path.name}")

    if not (out_dir / NOTICE_FILENAME).exists():
        problems.append(f"缺少 {NOTICE_FILENAME}")
    if not (out_dir / README_FILENAME).exists():
        problems.append(f"缺少 {README_FILENAME}")
    csv_files = sorted(out_dir.glob("*.csv"))
    if csv_files:
        problems.append(f"产物目录不应包含 CSV：{[p.name for p in csv_files]}")

    if csv_path is not None:
        try:
            rebuilt_exam, rebuilt_lexicon = build_documents(
                csv_path, frequency, version=version, allow_small=allow_small
            )
        except BuildError as exc:
            problems.append(str(exc))
        else:
            if serialize(rebuilt_exam) != exam_path.read_text(encoding="utf-8"):
                problems.append(f"完整重建对比失败：{EXAM_FILENAME} 与当前 CSV 不一致")
            if serialize(rebuilt_lexicon) != lexicon_path.read_text(encoding="utf-8"):
                problems.append(f"完整重建对比失败：{LEXICON_FILENAME} 与当前 CSV 不一致")
    return problems


def write_artifacts(
    out_dir: Path, exam_document: Dict[str, Any], lexicon_document: Dict[str, Any]
) -> Tuple[Path, Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    exam_path = out_dir / EXAM_FILENAME
    lexicon_path = out_dir / LEXICON_FILENAME
    sidecar_path = out_dir / SIDECAR_FILENAME
    exam_path.write_text(serialize(exam_document), encoding="utf-8")
    lexicon_path.write_text(serialize(lexicon_document), encoding="utf-8")
    lines = [
        f"{file_sha256(exam_path)}  {exam_path.name}",
        f"{file_sha256(lexicon_path)}  {lexicon_path.name}",
    ]
    sidecar_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return exam_path, lexicon_path, sidecar_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="构建语途单词本词表（GRE/CET4/CET6 + CEFR 释义索引）"
    )
    parser.add_argument(
        "--ecdict-csv",
        type=Path,
        help="ECDICT 官方 ecdict.csv（构建必需；--check 可省略做离线校验）",
    )
    parser.add_argument(
        "--frequency",
        type=Path,
        default=DEFAULT_FREQUENCY,
        help="CEFR 频表路径（默认 content/wordlist/frequency_bands.v1.json）",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT_DIR,
        help="产物目录（默认 content/wordlists/）",
    )
    parser.add_argument("--version", default=ARTIFACT_VERSION, help="产物版本号")
    parser.add_argument(
        "--check",
        action="store_true",
        help="只校验已提交产物，不写入；给 --ecdict-csv 时做完整重建对比",
    )
    parser.add_argument(
        "--allow-small",
        action="store_true",
        help="仅测试用：跳过考试词表规模护栏（正式产物不要加）",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    if not args.version.strip():
        print("--version 不能为空", file=sys.stderr)
        return 2

    if args.check:
        try:
            problems = check_artifacts(
                args.frequency,
                args.out_dir,
                csv_path=args.ecdict_csv,
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
        mode = "完整重建对比" if args.ecdict_csv else "离线结构/完整性/频表覆盖"
        print(f"OK  {args.out_dir}（{mode}）")
        return 0

    if args.ecdict_csv is None:
        print("构建模式必须给 --ecdict-csv PATH", file=sys.stderr)
        return 2
    try:
        frequency = load_frequency(args.frequency)
        exam_document, lexicon_document = build_documents(
            args.ecdict_csv,
            frequency,
            version=args.version,
            allow_small=args.allow_small,
        )
    except BuildError as exc:
        print(f"ERR  {exc}", file=sys.stderr)
        return 1
    problems = validate_exam_document(exam_document) + validate_lexicon_document(
        lexicon_document, frequency, exam_document
    )
    if problems:
        for problem in problems:
            print(f"ERR  {problem}", file=sys.stderr)
        return 1
    exam_path, lexicon_path, sidecar_path = write_artifacts(
        args.out_dir, exam_document, lexicon_document
    )
    print(
        f"已写入 {exam_path}（{exam_document['counts']['unique']} 词："
        + " / ".join(
            f"{tag} {exam_document['counts'][tag]}" for tag in TAG_BITS
        )
        + f"）；{lexicon_path}（{lexicon_document['counts']['entries']} 条释义）；"
        f"{sidecar_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
