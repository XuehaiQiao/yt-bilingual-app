"""课程生成（specs/030）：把已有内容转成一节 12 分钟课程。

两种源：

- **YouTube**：只读**当前用户**在该目标语言下已处理好的双语字幕
  （``translate.find_history_file_for_video``），按连续字幕块组成「源段落」，
  英文与已有译文都来自缓存；源不存在/未翻译完 → :class:`SourceNotReady`
  （HTTP 409 ``source_not_ready``）。
- **小说**：Project Gutenberg #1342《Pride and Prejudice》，按
  ``CHAPTER I.`` … ``CHAPTER LXI.`` 切成 61 章，取第 1–61 章正文前若干段作
  素材；正文用 :func:`books.fetch_source_text` 抓取（超时/大小/白名单由
  books 统一保证），成功后在进程内缓存。段落译文由**同一次**模型调用给出
  （``machine_translation``）。

生成纪律（与 quiz / teaching_analysis 同一套）：

- 一次模型调用产出整节课的原始 JSON，服务端组装成 ``linguatrek.course-lesson.v1``
  （step id/题目 id/元数据由服务端定，模型只给内容）；
- 严格校验：3 个精读段（每段 1–2 段原文，总英文 200–450 词，prompt 目标
  250–350）、4 词 + 1 形式点且都能在对应原文找到、6 主测 + 2 离场且答案
  合法、evidence 必须是原文子串；任一不过整批重试 1 次，仍不过抛
  :class:`GenerationFailed`（HTTP 502），**不写半成品**；
- 缓存键 ``(owner_user_id, source_kind, source_ref, content_hash, level,
  target_lang, course-gen.v1)``；命中零模型调用、不占配额；同 key 并发在
  进程内单飞（后到者等锁后重查缓存）；
- 表由 Alembic ``0022_generated_courses`` 创建，运行时不建表；缺表抛
  :class:`course.CourseUnavailable`（路由 503）。

对外入口：:func:`generate_course`；测试用 :func:`reset_caches` 清进程内状态。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass, replace
from typing import Any

import books
import config
import course
import languages
import llm
import translate
from ai import quota
from teaching_analysis import DEFAULT_LEVEL, LEGACY_LEVELS, LEVEL_IDS

logger = logging.getLogger("linguatrek.course_generator")

# prompt/校验口径版本：缓存键的一部分；改 prompt 或校验规则时递增，旧课自动
# 失效重生成（旧行保留，便于回滚/排查）。
PROMPT_VERSION = "course-gen.v1"

# 账本/配额功能名（ai/ledger.KNOWN_FEATURES / ai/quota._FEATURE_LIMIT_ATTRS）。
FEATURE = "course_generation"

TABLE = "generated_courses"
UNIQUE_CACHE_KEY = "ux_generated_courses_cache"

SOURCE_YOUTUBE = "youtube"
SOURCE_NOVEL = "novel"
SOURCE_KINDS = (SOURCE_YOUTUBE, SOURCE_NOVEL)
STATUS_READY = "ready"

# Project Gutenberg #1342《Pride and Prejudice》。主站维护时官方镜像同路径
# 回退（books 的公版源白名单已包含镜像）。
GUTENBERG_ID = 1342
GUTENBERG_URL = "https://www.gutenberg.org/cache/epub/1342/pg1342.txt"
GUTENBERG_MIRROR_URLS = (
    "https://gutenberg.pglaf.org/cache/epub/1342/pg1342.txt",
)
NOVEL_CHAPTERS = 61
NOVEL_LICENSE = "Public domain in the US"
NOVEL_TITLE = "Pride and Prejudice"
NOVEL_SOURCE_URL = f"https://www.gutenberg.org/ebooks/{GUTENBERG_ID}"

# YouTube 字幕块经此分组后作为「源段落」给模型：一段 ≈ 45–70 词。
YOUTUBE_PARAGRAPH_TARGET_WORDS = 50
YOUTUBE_PARAGRAPH_MAX_BLOCKS = 4
MAX_HISTORY_BYTES = 8 * 1024 * 1024

# 素材上限：给模型足够选择空间（250–350 词的精读段），但 prompt 不无限长。
# 段落数上限要允许 P&P 第 1 章这种「短对话 + 插图占位」的开头（前 12 段可能
# 只有 160 词），所以按累计词数（700）先截断，段落数只做兜底。
MAX_MATERIAL_WORDS = 700
MAX_MATERIAL_PARAGRAPHS = 30
MIN_MATERIAL_WORDS = 220

# 小说原文的自然段常常很短（P&P 第 1 章有 1–5 词的对话行）；直接一段一个
# 源单元会让「每步 1–2 段」无法凑到 250–350 词。按累计约 60 词合并相邻
# 自然段成一个「源单元」，既保留原文完整句子，又让模型的选择空间合理。
NOVEL_UNIT_TARGET_WORDS = 60

# 成课校验：specs/030 §5 的硬闸（prompt 目标 250–350 词）。
READ_STEP_COUNT = 3
PARAGRAPHS_PER_STEP = (1, 2)
WORDS_PER_LESSON = 4
FORMS_PER_LESSON = 1
MAIN_QUESTIONS = 6
EXIT_QUESTIONS = 2
QUESTIONS_PER_READ_STEP = 2
QUESTION_OPTIONS = 4
MIN_TOTAL_WORDS = 200
MAX_TOTAL_WORDS = 450
TARGET_WORDS = (250, 350)
MIN_SENTENCES_SAMPLE = 2

MAX_TITLE_CHARS = 120
MAX_PROMPT_CHARS = 600
MAX_OPTION_CHARS = 300
MAX_EXPLAIN_CHARS = 1000
MAX_EVIDENCE_CHARS = 600
MAX_MEANING_CHARS = 200
MAX_EXAMPLE_CHARS = 400
MAX_NOTE_CHARS = 400
MAX_RUBRIC_ITEMS = 6
MAX_RUBRIC_CHARS = 300
MAX_SAMPLE_CHARS = 1200
MAX_PARAGRAPH_CHARS = 2000

_WORD_RE = re.compile(r"[A-Za-z]+(?:['\-][A-Za-z]+)*")
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]")
_YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
_CHAPTER_HEADING_RE = re.compile(
    r"(?m)^[ \t]*(?:CHAPTER|Chapter)[ \t]+([IVXLCDM]+)\.?[ \t]*\]?[ \t]*$"
)
_START_RE = re.compile(
    r"^\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*?\*\*\*\s*$",
    re.MULTILINE,
)
_END_RE = re.compile(
    r"^\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*?\*\*\*\s*$",
    re.MULTILINE,
)
_ROMAN_VALUES = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}

# specs/030 §3：level 可以是高亮档 id，也可以是 CEFR 标签（A1–C2）。
CEFR_LEVELS = ("A1", "A2", "B1", "B2", "C1", "C2")

# 进程内同 key 单飞锁（loop id 进 key，避免 asyncio.Lock 跨事件循环绑定）。
_generation_locks: dict[tuple[int, tuple], asyncio.Lock] = {}

# 公版小说正文进程内缓存：成功抓取后按 TTL 复用（不落盘）。
_novel_cache: dict[tuple, tuple[float, str]] = {}
_novel_cache_lock = threading.Lock()


# ---------------------------------------------------------------------------
# 错误类型（路由按类型映射 400/409/429/502/503）
# ---------------------------------------------------------------------------

class CourseGenerationError(Exception):
    """课程生成领域错误基类。"""

    code = "course_generation_error"


class InvalidRequest(CourseGenerationError):
    """参数非法（路由 400）。"""

    code = "invalid_request"


class SourceNotReady(CourseGenerationError):
    """源内容不存在/未处理完（路由 409 ``source_not_ready``）。"""

    code = "source_not_ready"


class GenerationFailed(CourseGenerationError):
    """抓取/模型/校验失败（路由 502 ``generation_failed``）。"""

    code = "generation_failed"


class _ValidationFailed(Exception):
    """模型输出未通过校验（内部重试用，不对外）。"""

    def __init__(self, issues: list[str]) -> None:
        super().__init__("；".join(issues[:6]) or "课程内容未通过校验")
        self.issues = issues


class _ParseFailure(ValueError):
    """模型响应不是可用 JSON。"""


# ---------------------------------------------------------------------------
# 数据形状
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SourceParagraph:
    """一个「源段落」：YouTube 是连续字幕块，小说是 Gutenberg 自然段。"""

    id: str
    en: str
    zh: str | None


@dataclass(frozen=True)
class SourceMaterial:
    """生成一节课需要的全部源信息。"""

    kind: str
    ref: str
    title: str
    paragraphs: tuple[SourceParagraph, ...]
    content_hash: str
    source_url: str
    license: str
    chapter: int | None = None
    video_id: str | None = None


# ---------------------------------------------------------------------------
# 进程内状态（测试隔离用）
# ---------------------------------------------------------------------------

def reset_caches() -> None:
    """清空单飞锁与小说抓取缓存（测试隔离用；长期运行请勿调用）。"""
    _generation_locks.clear()
    with _novel_cache_lock:
        _novel_cache.clear()


def _lock_for(key: tuple) -> asyncio.Lock:
    loop_key = (id(asyncio.get_running_loop()), key)
    lock = _generation_locks.get(loop_key)
    if lock is None:
        lock = asyncio.Lock()
        _generation_locks[loop_key] = lock
    return lock


# ---------------------------------------------------------------------------
# 参数归一化
# ---------------------------------------------------------------------------

def normalize_level(level: str | None) -> str:
    """高亮档归一化：缺省 ``orbit``；支持六档 + 旧考试 id，非法 400。"""
    raw = (level or "").strip() if isinstance(level, str) else ""
    if not raw:
        return DEFAULT_LEVEL
    if raw.upper() in CEFR_LEVELS:
        return raw.upper()
    lowered = raw.lower()
    if lowered in LEVEL_IDS:
        return lowered
    if lowered in LEGACY_LEVELS:
        return LEGACY_LEVELS[lowered]
    raise InvalidRequest(
        f"invalid_level：不支持的等级 {level!r}（可用：{', '.join(LEVEL_IDS)}）。"
    )


def normalize_target_lang(target_lang: str | None) -> str:
    """目标语言归一化；缺省 zh-CN，非法抛 ``languages.UnsupportedLanguage``。"""
    return languages.resolve_target_lang(target_lang)


def _clean_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:limit]


def _norm_ws(value: str) -> str:
    return " ".join(str(value or "").split())


def _contains(haystack: str, needle: str) -> bool:
    """大小写不敏感、空白归一化后的子串判断（evidence 原文子串校验）。"""
    text = _norm_ws(haystack).casefold()
    fragment = _norm_ws(needle).casefold()
    return bool(fragment) and fragment in text


def _has_cjk(value: str) -> bool:
    return bool(_CJK_RE.search(value or ""))


def _word_in_text(word: str, text: str) -> bool:
    """词/短语是否是原文里的独立出现（避免 cat 命中 cattle）。"""
    fragment = _norm_ws(word)
    if not fragment:
        return False
    pattern = re.compile(r"(?<![A-Za-z])" + re.escape(fragment) + r"(?![A-Za-z])", re.I)
    return pattern.search(text) is not None


def _count_words(text: str) -> int:
    return len(_WORD_RE.findall(text or ""))


def _normalize_source_text(text: str) -> str:
    return _norm_ws(text)


def content_hash_of(text: str) -> str:
    """源文本规范化 sha256 前 32 位（与迁移注释一致）。"""
    return hashlib.sha256(_normalize_source_text(text).encode("utf-8")).hexdigest()[:32]


# ---------------------------------------------------------------------------
# 小说源：抓取 / 切章 / 素材
# ---------------------------------------------------------------------------

def _gutenberg_body(text: str) -> str:
    """去掉 Gutenberg 头尾声明，只留正文（与 books 同口径）。"""
    normalized = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    start = _START_RE.search(normalized)
    end = _END_RE.search(normalized)
    if not start or not end or end.start() <= start.end():
        raise GenerationFailed(
            "generation_failed：公版源缺少 Gutenberg START/END 标记，无法安全切分。"
        )
    return normalized[start.end() : end.start()]


def _roman_to_int(value: str) -> int:
    total = 0
    previous = 0
    for char in reversed((value or "").upper()):
        current = _ROMAN_VALUES.get(char)
        if current is None:
            raise GenerationFailed(f"generation_failed：无法解析章节号 {value!r}。")
        if current < previous:
            total -= current
        else:
            total += current
            previous = current
    return total


def split_novel_chapters(text: str) -> dict[int, tuple[str, list[str]]]:
    """把 #1342 正文切成 61 章，返回 ``{章号: (标题, 段落列表)}``。

    标题匹配容忍 Gutenberg 文本里的历史排版差异：``CHAPTER I.``、
    ``Chapter I.]``、``CHAPTER XIII``（无句点）都接受；章号必须是 I–LXI
    且连续，否则视为源版本异常（502）。
    """
    body = _gutenberg_body(text)
    matches = list(_CHAPTER_HEADING_RE.finditer(body))
    if len(matches) != NOVEL_CHAPTERS:
        raise GenerationFailed(
            f"generation_failed：公版源章节数异常（期望 {NOVEL_CHAPTERS}，"
            f"实际 {len(matches)}），源文本可能已更新。"
        )
    chapters: dict[int, tuple[str, list[str]]] = {}
    for index, match in enumerate(matches):
        number = _roman_to_int(match.group(1))
        if number in chapters:
            raise GenerationFailed(
                f"generation_failed：公版源章节号重复（{match.group(1)}）。"
            )
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        paragraphs = [
            _norm_ws(paragraph)[:MAX_PARAGRAPH_CHARS]
            for paragraph in books.split_paragraphs(body[match.end() : end])
            if paragraph.strip()
            # 插图说明/版权行不是正文，不能占素材段落名额。
            and not paragraph.lstrip().lower().startswith("[illustration")
            and not paragraph.lstrip().lower().startswith("[copyright")
        ]
        if not paragraphs:
            raise GenerationFailed(
                f"generation_failed：第 {number} 章没有正文段落。"
            )
        title = f"Chapter {match.group(1).upper()}"
        chapters[number] = (title, paragraphs)
    expected = set(range(1, NOVEL_CHAPTERS + 1))
    if set(chapters) != expected:
        missing = sorted(expected - set(chapters))
        raise GenerationFailed(
            f"generation_failed：公版源章节不完整（缺 {missing[:5]}）。"
        )
    return chapters


def _fetch_novel_text() -> str:
    """抓取 #1342 纯文本：主站失败时回退官方镜像；都失败 = 502。"""
    errors: list[str] = []
    for url in (GUTENBERG_URL, *GUTENBERG_MIRROR_URLS):
        try:
            text, _final_url = books.fetch_source_text(url)
            if text.strip():
                return text
            errors.append(f"{url}: 空文本")
        except (books.BookSourceUnavailable, books.BooksUnavailable) as exc:
            errors.append(f"{url}: {exc}")
            logger.warning("课程小说源抓取失败（%s）：%s", url, exc)
    raise GenerationFailed(
        "generation_failed：Project Gutenberg #1342 抓取失败："
        + "；".join(errors[:2])
    )


def _load_novel_text() -> str:
    """带 TTL 的进程内缓存；缓存只在成功抓取后写入，不落盘。

    ``COURSE_NOVEL_CACHE_SECONDS=0`` 表示每次重新抓取（运维/测试可关闭缓存）。
    缓存键带上抓取函数身份：测试 monkeypatch ``books.fetch_source_text`` 后
    不会误用上一个 fixture 缓存的正文。
    """
    ttl = max(0, int(getattr(config, "COURSE_NOVEL_CACHE_SECONDS", 0) or 0))
    cache_key = (id(books.fetch_source_text), GUTENBERG_URL)
    now = time.time()
    if ttl > 0:
        with _novel_cache_lock:
            cached = _novel_cache.get(cache_key)
        if cached is not None and now - cached[0] <= ttl:
            return cached[1]
    text = _fetch_novel_text()
    if ttl > 0:
        with _novel_cache_lock:
            _novel_cache[cache_key] = (time.time(), text)
    return text


def _group_novel_paragraphs(paragraphs: list[str]) -> list[str]:
    """把相邻自然段合并成约 ``NOVEL_UNIT_TARGET_WORDS`` 词的源单元。

    只做分段聚合，不改写原文：单元内的段之间用双换行保留，evidence 仍是
    原文子串。短对话行因此能和上下文组成一个可读的「段」。
    """
    units: list[str] = []
    current: list[str] = []
    current_words = 0
    for paragraph in paragraphs:
        text = _norm_ws(paragraph)
        if not text:
            continue
        current.append(text)
        current_words += _count_words(text)
        if current_words >= NOVEL_UNIT_TARGET_WORDS:
            units.append("\n\n".join(current))
            current, current_words = [], 0
    if current:
        units.append("\n\n".join(current))
    return units


def _build_novel_source(gutenberg_id: int, chapter: int) -> SourceMaterial:
    if gutenberg_id != GUTENBERG_ID:
        raise InvalidRequest(
            f"invalid_source：目前只支持 Project Gutenberg #{GUTENBERG_ID}。"
        )
    if not isinstance(chapter, int) or isinstance(chapter, bool):
        raise InvalidRequest("invalid_source：chapter 必须是整数。")
    if not 1 <= chapter <= NOVEL_CHAPTERS:
        raise InvalidRequest(
            f"invalid_source：chapter 必须在 1–{NOVEL_CHAPTERS} 之间。"
        )
    chapters = split_novel_chapters(_load_novel_text())
    title, paragraphs = chapters[chapter]
    material: list[SourceParagraph] = []
    words = 0
    for unit in _group_novel_paragraphs(paragraphs):
        if len(material) >= MAX_MATERIAL_PARAGRAPHS or words >= MAX_MATERIAL_WORDS:
            break
        unit_words = _count_words(unit)
        if unit_words <= 0:
            continue
        material.append(
            SourceParagraph(id=f"P{len(material) + 1}", en=unit, zh=None)
        )
        words += unit_words
    if words < MIN_MATERIAL_WORDS:
        raise GenerationFailed(
            f"generation_failed：第 {chapter} 章可用的英文内容不足"
            f"（{words} 词，至少需要 {MIN_MATERIAL_WORDS} 词）。"
        )
    chapter_text = "\n\n".join(paragraphs)
    return SourceMaterial(
        kind=SOURCE_NOVEL,
        ref=f"gutenberg:{GUTENBERG_ID}:chapter:{chapter}",
        title=f"{NOVEL_TITLE} · {title}",
        paragraphs=tuple(material),
        content_hash=content_hash_of(chapter_text),
        source_url=f"{NOVEL_SOURCE_URL}#chapter-{chapter}",
        license=NOVEL_LICENSE,
        chapter=chapter,
    )


# ---------------------------------------------------------------------------
# YouTube 源：读当前用户双语字幕 → 连续块分组
# ---------------------------------------------------------------------------

def _read_history_payload(path: str) -> dict:
    try:
        size = os.path.getsize(path)
    except OSError as exc:
        raise SourceNotReady(f"source_not_ready：字幕缓存不可读（{exc}）。") from exc
    if size > MAX_HISTORY_BYTES:
        raise SourceNotReady("source_not_ready：字幕缓存过大，无法生成课程。")
    try:
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError) as exc:
        raise SourceNotReady(
            f"source_not_ready：字幕缓存损坏，请重新处理视频（{exc}）。"
        ) from exc
    if not isinstance(payload, dict):
        raise SourceNotReady("source_not_ready：字幕缓存格式异常，请重新处理视频。")
    return payload


def _youtube_paragraphs(payload: dict) -> list[SourceParagraph]:
    transcript = payload.get("transcript")
    if not isinstance(transcript, list):
        raise SourceNotReady("source_not_ready：该视频还没有可用的双语字幕。")
    blocks: list[dict] = []
    for item in transcript:
        if not isinstance(item, dict):
            continue
        en = _clean_text(item.get("en_text"), MAX_PARAGRAPH_CHARS)
        zh = _clean_text(item.get("zh_text"), MAX_PARAGRAPH_CHARS)
        if not en or not zh or translate.needs_retranslation(zh):
            continue
        blocks.append({"en": en, "zh": zh})
    if not blocks:
        raise SourceNotReady(
            "source_not_ready：该视频还没有可用的双语字幕，请先完成字幕生成/翻译。"
        )

    paragraphs: list[SourceParagraph] = []
    current_en: list[str] = []
    current_zh: list[str] = []
    current_words = 0
    for block in blocks:
        current_en.append(block["en"])
        current_zh.append(block["zh"])
        current_words += _count_words(block["en"])
        if (
            current_words >= YOUTUBE_PARAGRAPH_TARGET_WORDS
            or len(current_en) >= YOUTUBE_PARAGRAPH_MAX_BLOCKS
        ):
            paragraphs.append(
                SourceParagraph(
                    id=f"P{len(paragraphs) + 1}",
                    en=_norm_ws(" ".join(current_en)),
                    zh=_norm_ws(" ".join(current_zh)),
                )
            )
            current_en, current_zh, current_words = [], [], 0
    if current_en:
        paragraphs.append(
            SourceParagraph(
                id=f"P{len(paragraphs) + 1}",
                en=_norm_ws(" ".join(current_en)),
                zh=_norm_ws(" ".join(current_zh)),
            )
        )
    return paragraphs


def _build_youtube_source(video_id: str, target_lang: str) -> SourceMaterial:
    video_id = (video_id or "").strip()
    if not _YOUTUBE_ID_RE.match(video_id):
        raise InvalidRequest("invalid_source：videoId 格式非法。")
    path = translate.find_history_file_for_video(video_id, target_lang)
    if not path:
        raise SourceNotReady(
            "source_not_ready：当前账号还没有该视频在"
            f" {target_lang} 下的双语字幕，请先完成字幕生成/翻译。"
        )
    payload = _read_history_payload(path)
    if translate.payload_target_lang(payload) != target_lang:
        raise SourceNotReady(
            "source_not_ready：该字幕缓存不是请求的目标语言版本，请重新生成字幕。"
        )
    paragraphs = _youtube_paragraphs(payload)
    material: list[SourceParagraph] = []
    words = 0
    for paragraph in paragraphs:
        if len(material) >= MAX_MATERIAL_PARAGRAPHS or words >= MAX_MATERIAL_WORDS:
            break
        material.append(paragraph)
        words += _count_words(paragraph.en)
    if words < MIN_MATERIAL_WORDS:
        raise SourceNotReady(
            f"source_not_ready：该视频双语字幕只有 {words} 词，"
            f"至少需要 {MIN_MATERIAL_WORDS} 词才能生成 12 分钟课程。"
        )
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    title = _clean_text(metadata.get("title"), 200) or f"YouTube 课程（{video_id}）"
    transcript_text = "\n\n".join(
        _clean_text(block.get("en_text"), MAX_PARAGRAPH_CHARS)
        for block in payload.get("transcript") or []
        if isinstance(block, dict)
    )
    return SourceMaterial(
        kind=SOURCE_YOUTUBE,
        ref=video_id,
        title=title,
        paragraphs=tuple(material),
        content_hash=content_hash_of(transcript_text),
        source_url=f"https://www.youtube.com/watch?v={video_id}",
        license="用户自己的 YouTube 双语字幕（仅本人可见）",
        video_id=video_id,
    )


# ---------------------------------------------------------------------------
# 缓存 / 配额 / 落库
# ---------------------------------------------------------------------------

def _connect() -> sqlite3.Connection:
    path = config.AUTH_DB_PATH
    if not os.path.exists(path):
        raise course.CourseUnavailable(
            f"数据库文件不存在：{path}（先运行 alembic upgrade head）"
        )
    try:
        conn = sqlite3.connect(path, timeout=10)
    except sqlite3.Error as exc:
        raise course.CourseUnavailable(f"课程数据库不可用：{exc}") from exc
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _require_table(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (TABLE,),
    ).fetchone()
    if row is None:
        raise course.CourseUnavailable(
            f"数据库缺少表 {TABLE}（先运行 alembic upgrade head；"
            "课程生成需要 0022_generated_courses 迁移）。"
        )


def _cache_key(
    user_id: str,
    source_kind: str,
    source_ref: str,
    content_hash: str,
    level: str,
    target_lang: str,
) -> tuple:
    return (
        user_id,
        source_kind,
        source_ref,
        content_hash,
        level,
        target_lang,
        PROMPT_VERSION,
    )


def _load_cached(key: tuple) -> sqlite3.Row | None:
    conn = _connect()
    try:
        _require_table(conn)
        return conn.execute(
            f"SELECT * FROM {TABLE} WHERE owner_user_id = ? AND source_kind = ? "
            "AND source_ref = ? AND content_hash = ? AND level = ? "
            "AND target_lang = ? AND prompt_version = ? AND status = ?",
            (*key, STATUS_READY),
        ).fetchone()
    except sqlite3.OperationalError as exc:
        raise course.CourseUnavailable(
            f"课程数据库暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()


def _save_generated(key: tuple, lesson: dict) -> tuple[sqlite3.Row, bool]:
    """写一行生成课程；唯一键冲突（并发/重放）时读回已有行，按缓存返回。"""
    conn = _connect()
    try:
        _require_table(conn)
        lesson_id = f"gen-{uuid.uuid4().hex}"
        # 课程包内 id 必须与行 id 一致：attempt/详情都按同一个 id 寻址。
        lesson = {**lesson, "id": lesson_id}
        title = _clean_text(lesson.get("title"), MAX_TITLE_CHARS) or lesson_id
        stamp = course.now_ms()
        try:
            with conn:
                conn.execute(
                    f"INSERT INTO {TABLE} "
                    "(id, owner_user_id, source_kind, source_ref, content_hash, "
                    " level, target_lang, prompt_version, title, lesson_json, "
                    " status, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        lesson_id,
                        *key,
                        title,
                        json.dumps(lesson, ensure_ascii=False, separators=(",", ":")),
                        STATUS_READY,
                        stamp,
                    ),
                )
        except sqlite3.IntegrityError:
            row = _load_cached(key)
            if row is None:
                raise
            return row, True
        row = conn.execute(
            f"SELECT * FROM {TABLE} WHERE id = ?", (lesson_id,)
        ).fetchone()
        if row is None:  # pragma: no cover - 插后即查，理论不可达
            raise course.CourseUnavailable("课程写入后读取失败，请重试。")
        return row, False
    except sqlite3.OperationalError as exc:
        raise course.CourseUnavailable(
            f"课程数据库暂时不可用：{exc}（先运行 alembic upgrade head）"
        ) from exc
    finally:
        conn.close()


def _response_payload(row: sqlite3.Row, *, cached: bool) -> dict:
    return {
        "lessonId": row["id"],
        "title": row["title"],
        "level": row["level"],
        "sourceKind": row["source_kind"],
        "cached": cached,
        "status": row["status"],
    }


# ---------------------------------------------------------------------------
# prompt
# ---------------------------------------------------------------------------

_SCHEMA_HINT = """{
  "title": "English lesson title (<= 80 chars)",
  "titleZh": "目标语言标题（中文/越南语等）",
  "goal": "目标语言的一句话学习目标",
  "readSteps": [
    {
      "title": "目标语言的步骤标题",
      "paragraphIds": ["P1", "P2"],
      "explain": "目标语言的 1-3 句讲解",
      "questions": [
        {
          "prompt": "English comprehension question?",
          "options": [
            {"id": "A", "text": "English option"},
            {"id": "B", "text": "English option"},
            {"id": "C", "text": "English option"},
            {"id": "D", "text": "English option"}
          ],
          "answer": "A",
          "explain": "目标语言解析",
          "evidence": "EXACT English substring from the selected paragraphs"
        }
      ]
    }
  ],
  "words": [
    {"kind": "word", "word": "word or phrase from the text", "ipa": "/.../",
     "meaning": "目标语言释义", "cefr": "B1",
     "example": "English sentence from the text", "evidence": "EXACT English substring"},
    {"kind": "form", "word": "grammar form label", "meaning": "目标语言释义",
     "cefr": "B1", "example": "English sentence from the text",
     "note": "目标语言说明", "evidence": "EXACT English substring"}
  ],
  "output": {
    "prompt": "English writing prompt",
    "targetWords": ["word1", "word2"],
    "wordRange": {"B1": [40, 60]},
    "rubric": ["目标语言评分点 1", "评分点 2", "评分点 3"],
    "sample": "English sample answer of 2-5 sentences",
    "exitTicket": [
      { "prompt": "...", "options": [{"id": "A", "text": "..."}, {"id": "B", "text": "..."},
        {"id": "C", "text": "..."}, {"id": "D", "text": "..."}],
        "answer": "A", "explain": "目标语言解析", "evidence": "EXACT English substring" }
    ]
  },
  "translations": {"P1": "目标语言译文", "P2": "目标语言译文"}
}"""


def _format_paragraphs(paragraphs: tuple[SourceParagraph, ...]) -> str:
    payload = []
    for paragraph in paragraphs:
        item = {"id": paragraph.id, "en": paragraph.en}
        if paragraph.zh:
            item["zh"] = paragraph.zh
        payload.append(item)
    return json.dumps(payload, ensure_ascii=False, indent=1)


def _build_prompt(source: SourceMaterial, level: str, target_lang: str) -> str:
    target_name = languages.prompt_name(target_lang)
    level_desc = config.VOCAB_LEVELS.get(level, level)
    existing_zh = any(paragraph.zh for paragraph in source.paragraphs)
    translation_rule = (
        "The source paragraphs already include zh (the user's own translation): "
        "the server reuses it, so you may omit `translations`."
        if existing_zh
        else f"For novel sources you MUST translate every selected paragraph into "
        f"{target_name} in `translations` (machine translation is fine)."
    )
    return f"""You are an experienced English curriculum designer. Build ONE 12-minute
lesson for {target_name} learners at this level: {level_desc}.

Return exactly ONE JSON object. No markdown fences, no commentary.

Hard rules:
1. Use ONLY the SOURCE PARAGRAPHS below. Never invent facts or text.
2. `readSteps` must contain exactly 3 steps. Each step chooses 1-2 paragraph ids
   (unique across the lesson). Total English across all 3 steps must be
   250-350 words (accepted range: {MIN_TOTAL_WORDS}-{MAX_TOTAL_WORDS}).
3. Exactly 2 comprehension questions per read step (6 total). Each has exactly
   4 options with ids A-D, a valid `answer`, and `evidence` copied verbatim
   from that step's English paragraphs.
4. Exactly 4 `kind:"word"` points and 1 `kind:"form"` point. Word points must
   literally appear in the chosen paragraphs; every point needs `evidence`
   copied verbatim from them.
5. `output`: English writing prompt, exactly 2 target words (both from the 4
   word points), a wordRange object, 3 rubric bullets, a 2-5 sentence sample,
   and exactly 2 exit-ticket questions in the same shape as comprehension
   questions.
6. Questions/options/evidence must be ENGLISH only (no CJK). Explanations,
   titles and meanings use {target_name}.
7. {translation_rule}

JSON schema (follow the keys exactly; extra keys are ignored):
{_SCHEMA_HINT}

SOURCE PARAGRAPHS (JSON; copy text exactly, including punctuation):
<<<SOURCE_PARAGRAPHS
{_format_paragraphs(source.paragraphs)}
SOURCE_PARAGRAPHS>>>
"""


def _retry_prompt(base_prompt: str, issues: list[str]) -> str:
    detail = "\n".join(f"- {issue}" for issue in issues[:12]) or "- unknown issue"
    return (
        base_prompt
        + "\n\nYour previous JSON failed validation:\n"
        + detail
        + "\nRegenerate the COMPLETE corrected JSON object. Do not repeat the mistakes."
    )


# ---------------------------------------------------------------------------
# 模型输出解析
# ---------------------------------------------------------------------------

def _strip_code_fence(text: str) -> str:
    value = (text or "").strip()
    if not value.startswith("```"):
        return value
    lines = value.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip().startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines).strip()


def _parse_json(text: str) -> dict:
    stripped = _strip_code_fence(text)
    if not stripped:
        raise _ParseFailure("模型返回空响应。")
    try:
        data = json.loads(stripped)
    except ValueError:
        start = stripped.find("{")
        end = stripped.rfind("}")
        if start < 0 or end <= start:
            raise _ParseFailure("模型返回内容里没有完整 JSON。")
        try:
            data = json.loads(stripped[start : end + 1])
        except ValueError as exc:
            raise _ParseFailure(f"模型返回的 JSON 无法解析：{exc}") from exc
    if not isinstance(data, dict):
        raise _ParseFailure("模型返回的 JSON 根节点必须是对象。")
    return data


# ---------------------------------------------------------------------------
# 兼容「模型直接回 schema 029」的完整 lesson JSON
# ---------------------------------------------------------------------------

def _sentence_list(text: str) -> list[str]:
    normalized = _norm_ws(text)
    parts = [part.strip() for part in re.split(r"(?<=[.!?])\s+", normalized) if part.strip()]
    return parts or ([normalized] if normalized else [])


def _derive_evidence(text: str, word: str | None = None) -> str:
    """从原文里挑一句作 evidence（模型没给时用；绝不编造）。"""
    for sentence in _sentence_list(text):
        if not word or _word_in_text(word, sentence):
            return sentence[:MAX_EVIDENCE_CHARS]
    sentences = _sentence_list(text)
    return sentences[0][:MAX_EVIDENCE_CHARS] if sentences else ""


def _adapt_question_items(items: Any, step_text: str) -> list[dict]:
    adapted: list[dict] = []
    if not isinstance(items, list):
        return adapted
    for item in items:
        if not isinstance(item, dict):
            adapted.append(item)  # 让 _build_lesson 报结构问题
            continue
        question = {
            key: item.get(key)
            for key in ("prompt", "options", "answer", "explain")
        }
        question["evidence"] = (
            _clean_text(item.get("evidence"), MAX_EVIDENCE_CHARS)
            or _derive_evidence(step_text)
        )
        adapted.append(question)
    return adapted


def _adapt_final_course(
    raw: dict, source: SourceMaterial, target_lang: str
) -> tuple[dict, SourceMaterial]:
    """把「完整 029 lesson JSON」适配成内部候选格式。

    正常 prompt 产出的是 readSteps/words/output 的中间格式，本函数原样返回；
    若模型/测试直接给了 ``steps``（schema 029），则：
    - 每个 read step 的 ``paragraphs[].en`` 必须是源素材原文子串（防编造）；
    - 重新编号 P1..Pn，构造同内容的合成 SourceMaterial；
    - 缺失的 evidence 从原文句子里挑（仍是原文子串），不编答案。
    """
    if "readSteps" in raw:
        return raw, source
    steps = raw.get("steps")
    if not isinstance(steps, list):
        return raw, source
    read_steps = [
        step for step in steps
        if isinstance(step, dict) and step.get("type") == "read"
    ]
    if not read_steps:
        return raw, source

    source_text = _norm_ws("\n\n".join(paragraph.en for paragraph in source.paragraphs))
    paragraphs: list[SourceParagraph] = []
    translations: dict[str, str] = {}
    adapted_steps: list[dict] = []
    all_text: list[str] = []
    for step in read_steps:
        ids: list[str] = []
        step_texts: list[str] = []
        raw_paragraphs = step.get("paragraphs")
        if not isinstance(raw_paragraphs, list):
            return raw, source
        for item in raw_paragraphs:
            if not isinstance(item, dict):
                return raw, source
            en = _clean_text(item.get("en"), MAX_PARAGRAPH_CHARS)
            if not en or _norm_ws(en) not in source_text:
                return raw, source
            paragraph_id = f"P{len(paragraphs) + 1}"
            zh = _clean_text(item.get("zh"), MAX_PARAGRAPH_CHARS)
            if source.kind == SOURCE_YOUTUBE:
                # YouTube 必须复用已有译文（模型抄的 zh 也以缓存为准）。
                for unit in source.paragraphs:
                    if unit.zh and _norm_ws(en) in _norm_ws(unit.en):
                        zh = unit.zh
                        break
            paragraphs.append(SourceParagraph(id=paragraph_id, en=en, zh=zh or None))
            if zh:
                translations[paragraph_id] = zh
            ids.append(paragraph_id)
            step_texts.append(en)
        step_text = "\n\n".join(step_texts)
        all_text.append(step_text)
        adapted_steps.append(
            {
                "title": step.get("title"),
                "paragraphIds": ids,
                "explain": step.get("explain"),
                "questions": _adapt_question_items(step.get("questions"), step_text),
            }
        )
    selected_text = "\n\n".join(all_text)

    words_raw: list[dict] = []
    words_step = next(
        (step for step in steps if isinstance(step, dict) and step.get("type") == "words"),
        None,
    )
    if isinstance(words_step, dict) and isinstance(words_step.get("points"), list):
        for point in words_step["points"]:
            if not isinstance(point, dict):
                words_raw.append(point)
                continue
            item = {
                key: point.get(key)
                for key in (
                    "kind", "word", "ipa", "meaning", "cefr",
                    "example", "note",
                )
            }
            item["evidence"] = (
                _clean_text(point.get("evidence"), MAX_EVIDENCE_CHARS)
                or _derive_evidence(
                    selected_text,
                    item.get("word") if item.get("kind") == "word" else None,
                )
            )
            words_raw.append(item)

    output_step = next(
        (step for step in steps if isinstance(step, dict) and step.get("type") == "output"),
        None,
    )
    output: dict = {}
    if isinstance(output_step, dict):
        output = {
            key: output_step.get(key)
            for key in ("prompt", "targetWords", "wordRange", "rubric", "sample")
        }
        exit_items = output_step.get("exitTicket")
        if exit_items is None:
            exit_items = raw.get("exitTicket")
        output["exitTicket"] = _adapt_question_items(exit_items, selected_text)

    adapted = {
        "title": raw.get("title"),
        "titleZh": raw.get("titleZh"),
        "goal": raw.get("goal"),
        "readSteps": adapted_steps,
        "words": words_raw,
        "output": output,
        "translations": translations,
    }
    adapted_source = replace(source, paragraphs=tuple(paragraphs))
    return adapted, adapted_source


# ---------------------------------------------------------------------------
# 校验 + 组装 lesson
# ---------------------------------------------------------------------------

def _validate_question(
    raw: Any,
    step_text: str,
    where: str,
    issues: list[str],
) -> dict | None:
    if not isinstance(raw, dict):
        issues.append(f"{where} 必须是对象")
        return None
    prompt = _clean_text(raw.get("prompt"), MAX_PROMPT_CHARS)
    if not prompt:
        issues.append(f"{where}.prompt 不能为空")
    elif _has_cjk(prompt):
        issues.append(f"{where}.prompt 必须是英文")
    options_raw = raw.get("options")
    options: list[dict] = []
    if not isinstance(options_raw, list) or len(options_raw) != QUESTION_OPTIONS:
        issues.append(f"{where} 需要 {QUESTION_OPTIONS} 个选项")
    else:
        seen: set[str] = set()
        for index, option in enumerate(options_raw):
            if not isinstance(option, dict):
                issues.append(f"{where}.options[{index}] 必须是对象")
                continue
            option_id = _clean_text(option.get("id"), 8)
            text = _clean_text(option.get("text"), MAX_OPTION_CHARS)
            if not option_id or option_id in seen:
                issues.append(f"{where}.options[{index}].id 非法或重复")
            if not text:
                issues.append(f"{where}.options[{index}].text 不能为空")
            elif _has_cjk(text):
                issues.append(f"{where}.options[{index}].text 必须是英文")
            seen.add(option_id)
            options.append({"id": option_id, "text": text})
    answer = _clean_text(raw.get("answer"), 8)
    if answer not in {option["id"] for option in options}:
        issues.append(f"{where}.answer 必须是合法选项 id")
    evidence = _clean_text(raw.get("evidence"), MAX_EVIDENCE_CHARS)
    if not evidence:
        issues.append(f"{where}.evidence 不能为空")
    elif _has_cjk(evidence):
        issues.append(f"{where}.evidence 必须是英文原文")
    elif not _contains(step_text, evidence):
        issues.append(f"{where}.evidence 必须是所选段落的原文子串")
    explain = _clean_text(raw.get("explain"), MAX_EXPLAIN_CHARS)
    return {
        "prompt": prompt,
        "options": options,
        "answer": answer,
        "explain": explain,
        "evidence": evidence,
    }


def _validate_points(
    raw: Any,
    selected_text: str,
    issues: list[str],
) -> tuple[list[dict], list[dict]]:
    words: list[dict] = []
    forms: list[dict] = []
    if not isinstance(raw, list):
        issues.append("words 必须是数组")
        return words, forms
    for index, item in enumerate(raw):
        where = f"words[{index}]"
        if not isinstance(item, dict):
            issues.append(f"{where} 必须是对象")
            continue
        kind = _clean_text(item.get("kind"), 16).lower()
        word = _clean_text(item.get("word"), 120)
        meaning = _clean_text(item.get("meaning"), MAX_MEANING_CHARS)
        example = _clean_text(item.get("example"), MAX_EXAMPLE_CHARS)
        evidence = _clean_text(item.get("evidence"), MAX_EVIDENCE_CHARS)
        ipa = _clean_text(item.get("ipa"), 80)
        cefr = _clean_text(item.get("cefr"), 8).upper()
        note = _clean_text(item.get("note"), MAX_NOTE_CHARS)
        if kind not in ("word", "form"):
            issues.append(f"{where}.kind 只能是 word 或 form")
            continue
        if not word:
            issues.append(f"{where}.word 不能为空")
        if not meaning:
            issues.append(f"{where}.meaning 不能为空")
        if not example:
            issues.append(f"{where}.example 不能为空")
        if not evidence:
            issues.append(f"{where}.evidence 不能为空")
        elif not _contains(selected_text, evidence):
            issues.append(f"{where}.evidence 必须是所选段落的原文子串")
        if kind == "word":
            if word and not _word_in_text(word, selected_text):
                issues.append(f"{where}.word 必须在所选段落原文中出现")
            if word and evidence and not _contains(evidence, word):
                issues.append(f"{where}.evidence 必须包含该词")
            words.append(
                {
                    "kind": "word",
                    "word": word,
                    "ipa": ipa,
                    "meaning": meaning,
                    "cefr": cefr,
                    "example": example,
                    "evidence": evidence,
                }
            )
        else:
            if not note:
                issues.append(f"{where}.note 不能为空（形式点需要说明）")
            forms.append(
                {
                    "kind": "form",
                    "word": word,
                    "meaning": meaning,
                    "cefr": cefr,
                    "example": example,
                    "note": note,
                    "evidence": evidence,
                }
            )
    if len(words) != WORDS_PER_LESSON:
        issues.append(f"需要 {WORDS_PER_LESSON} 个词（实际 {len(words)} 个）")
    if len(forms) != FORMS_PER_LESSON:
        issues.append(f"需要 {FORMS_PER_LESSON} 个形式点（实际 {len(forms)} 个）")
    seen_words: set[str] = set()
    for point in words:
        key = point["word"].casefold()
        if key in seen_words:
            issues.append(f"词重复：{point['word']}")
        seen_words.add(key)
    return words, forms


def _normalize_text_for_course(text: str) -> str:
    return _norm_ws(text)


def _default_cefr(level: str) -> str:
    if level in CEFR_LEVELS:
        return level
    description = config.VOCAB_LEVELS.get(level, "")
    match = re.search(r"CEFR (A1|A2|B1|B2|C1|C2)", description)
    return match.group(1) if match else "B1"


def _build_lesson(
    raw: dict,
    source: SourceMaterial,
    level: str,
    target_lang: str,
) -> dict:
    """校验模型 JSON 并组装成 ``linguatrek.course-lesson.v1``；失败抛内部异常。"""
    issues: list[str] = []
    if not isinstance(raw, dict):
        raise _ValidationFailed(["根节点必须是 JSON 对象"])

    title = _clean_text(raw.get("title"), MAX_TITLE_CHARS)
    if not title:
        issues.append("title 不能为空")
    title_zh = _clean_text(raw.get("titleZh"), MAX_TITLE_CHARS) or title
    goal = _clean_text(raw.get("goal"), 400)

    source_map = {paragraph.id: paragraph for paragraph in source.paragraphs}
    read_steps_raw = raw.get("readSteps")
    if not isinstance(read_steps_raw, list) or len(read_steps_raw) != READ_STEP_COUNT:
        issues.append(f"readSteps 必须正好 {READ_STEP_COUNT} 个")
        read_steps_raw = []

    selected_ids: list[str] = []
    step_specs: list[dict] = []
    for index, step in enumerate(read_steps_raw[:READ_STEP_COUNT]):
        where = f"readSteps[{index}]"
        if not isinstance(step, dict):
            issues.append(f"{where} 必须是对象")
            continue
        ids_raw = step.get("paragraphIds")
        if not isinstance(ids_raw, list) or not (
            PARAGRAPHS_PER_STEP[0] <= len(ids_raw) <= PARAGRAPHS_PER_STEP[1]
        ):
            issues.append(f"{where}.paragraphIds 需要 1-2 个段落 id")
            ids: list[str] = []
        else:
            ids = [str(value).strip() for value in ids_raw]
        for paragraph_id in ids:
            if paragraph_id not in source_map:
                issues.append(f"{where}.paragraphIds 含未知段落 {paragraph_id!r}")
            elif paragraph_id in selected_ids:
                issues.append(f"{where}.paragraphIds 段落重复 {paragraph_id!r}")
            else:
                selected_ids.append(paragraph_id)
        questions_raw = step.get("questions")
        if not isinstance(questions_raw, list) or len(questions_raw) != QUESTIONS_PER_READ_STEP:
            issues.append(
                f"{where}.questions 必须正好 {QUESTIONS_PER_READ_STEP} 道"
            )
            questions_raw = []
        step_specs.append(
            {
                "title": _clean_text(step.get("title"), 80) or f"精读 {index + 1}",
                "explain": _clean_text(step.get("explain"), MAX_EXPLAIN_CHARS),
                "ids": ids,
                "questions": questions_raw,
            }
        )

    if issues:
        raise _ValidationFailed(issues)

    selected_paragraphs = [source_map[paragraph_id] for paragraph_id in selected_ids]
    selected_text = _normalize_text_for_course(
        "\n\n".join(paragraph.en for paragraph in selected_paragraphs)
    )
    total_words = _count_words(selected_text)
    if not MIN_TOTAL_WORDS <= total_words <= MAX_TOTAL_WORDS:
        issues.append(
            f"精读段总英文词数 {total_words} 不在允许的 "
            f"{MIN_TOTAL_WORDS}-{MAX_TOTAL_WORDS} 词范围"
        )

    translations_raw = raw.get("translations")
    translations = translations_raw if isinstance(translations_raw, dict) else {}
    paragraphs_payload: list[dict] = []
    for paragraph in selected_paragraphs:
        zh = (
            paragraph.zh
            if source.kind == SOURCE_YOUTUBE
            else _clean_text(translations.get(paragraph.id), MAX_PARAGRAPH_CHARS)
        )
        if not zh:
            issues.append(f"段落 {paragraph.id} 缺少 {target_lang} 译文")
        item = {
            "en": paragraph.en,
            "zh": zh or "",
            "zhSource": (
                "existing" if source.kind == SOURCE_YOUTUBE else "machine_translation"
            ),
        }
        paragraphs_payload.append(item)

    built_steps: list[dict] = []
    main_question_number = 0
    for index, spec in enumerate(step_specs):
        step_paragraphs = [
            paragraphs_payload[selected_ids.index(paragraph_id)]
            for paragraph_id in spec["ids"]
        ]
        step_text = _normalize_text_for_course(
            "\n\n".join(paragraph["en"] for paragraph in step_paragraphs)
        )
        questions = []
        for question_raw in spec["questions"]:
            main_question_number += 1
            question = _validate_question(
                question_raw,
                step_text,
                f"readSteps[{index}].questions[{main_question_number - 1}]",
                issues,
            )
            if question is not None:
                question["id"] = f"Q{main_question_number}"
                questions.append(question)
        built_steps.append(
            {
                "id": f"S{index + 2}",
                "type": "read",
                "title": spec["title"],
                "minutes": 2.2,
                "paragraphs": step_paragraphs,
                "explain": spec["explain"],
                "questions": questions,
            }
        )
    if main_question_number != MAIN_QUESTIONS:
        issues.append(f"主测题必须正好 {MAIN_QUESTIONS} 道")

    words, forms = _validate_points(raw.get("words"), selected_text, issues)

    output_raw = raw.get("output")
    if not isinstance(output_raw, dict):
        issues.append("output 必须是对象")
        output_raw = {}
    output_prompt = _clean_text(output_raw.get("prompt"), MAX_PROMPT_CHARS)
    if not output_prompt:
        issues.append("output.prompt 不能为空")
    elif _has_cjk(output_prompt):
        issues.append("output.prompt 必须是英文")
    target_words_raw = output_raw.get("targetWords")
    target_words: list[str] = []
    if not isinstance(target_words_raw, list) or len(target_words_raw) != 2:
        issues.append("output.targetWords 必须正好 2 个")
    else:
        word_lookup = {point["word"].casefold() for point in words}
        for value in target_words_raw:
            word = _clean_text(value, 120)
            if not word:
                issues.append("output.targetWords 不能为空")
                continue
            if word.casefold() not in word_lookup:
                issues.append(f"output.targetWords 中的 {word!r} 不在 4 个词里")
            if not _word_in_text(word, selected_text):
                issues.append(f"output.targetWords 中的 {word!r} 未在原文出现")
            target_words.append(word)
        if len({word.casefold() for word in target_words}) != len(target_words):
            issues.append("output.targetWords 不能重复")

    rubric_raw = output_raw.get("rubric")
    rubric: list[str] = []
    if isinstance(rubric_raw, list):
        for value in rubric_raw[:MAX_RUBRIC_ITEMS]:
            text = _clean_text(value, MAX_RUBRIC_CHARS)
            if text:
                rubric.append(text)
    if not rubric:
        issues.append("output.rubric 至少需要 1 条")

    sample = _clean_text(output_raw.get("sample"), MAX_SAMPLE_CHARS)
    if not sample:
        issues.append("output.sample 不能为空")
    elif len(re.findall(r"[.!?](?:\s|$)", _norm_ws(sample))) < MIN_SENTENCES_SAMPLE:
        issues.append("output.sample 必须是完整英文句子")

    exit_raw = output_raw.get("exitTicket")
    exit_questions: list[dict] = []
    if not isinstance(exit_raw, list) or len(exit_raw) != EXIT_QUESTIONS:
        issues.append(f"output.exitTicket 必须正好 {EXIT_QUESTIONS} 道")
    else:
        for index, question_raw in enumerate(exit_raw):
            question = _validate_question(
                question_raw,
                selected_text,
                f"output.exitTicket[{index}]",
                issues,
            )
            if question is not None:
                question["id"] = f"E{index + 1}"
                exit_questions.append(question)

    word_range = output_raw.get("wordRange")
    if not isinstance(word_range, dict) or not word_range:
        word_range = {_default_cefr(level): [40, 60]}
    else:
        clean_range: dict[str, list[int]] = {}
        for key, value in list(word_range.items())[:4]:
            if not isinstance(key, str):
                continue
            if (
                isinstance(value, list)
                and len(value) == 2
                and all(isinstance(item, int) and not isinstance(item, bool) for item in value)
                and 0 < value[0] < value[1] <= 500
            ):
                clean_range[key] = value
        word_range = clean_range or {_default_cefr(level): [40, 60]}

    if issues:
        raise _ValidationFailed(issues)

    points: list[dict] = []
    for index, word in enumerate(words):
        point = {"id": f"W{index + 1}", "kind": "word", "word": word["word"]}
        if word.get("ipa"):
            point["ipa"] = word["ipa"]
        point["meaning"] = word["meaning"]
        if word.get("cefr"):
            point["cefr"] = word["cefr"]
        point["example"] = word["example"]
        point["evidence"] = word["evidence"]
        points.append(point)
    for form in forms:
        point = {
            "id": "F1",
            "kind": "form",
            "word": form["word"],
            "meaning": form["meaning"],
        }
        if form.get("cefr"):
            point["cefr"] = form["cefr"]
        point["example"] = form["example"]
        point["note"] = form["note"]
        point["evidence"] = form["evidence"]
        points.append(point)

    lesson_id_placeholder = "pending"
    intro = {
        "id": "S0",
        "type": "intro",
        "title": "今天学什么",
        "minutes": 0.5,
        "body": (
            f"用 12 分钟读一段 {total_words} 词的英文原文，学 4 个词和 1 个表达，"
            "做 6 道题，最后写 2–5 句。"
        ),
        "bullets": ["不需要提前预习", "卡住可以暂停", "最后有一个小产出"],
    }
    words_step = {
        "id": "S1",
        "type": "words",
        "title": "先学 4 个词 + 1 个表达",
        "minutes": 1.75,
        "body": "这些词和这个表达会在下面的精读里反复出现，先混个脸熟。",
        "points": points,
    }
    output_step = {
        "id": "S5",
        "type": "output",
        "title": "写点什么",
        "minutes": 3.0,
        "prompt": output_prompt,
        "targetWords": target_words,
        "wordRange": word_range,
        "rubric": rubric,
        "sample": sample,
        "exitTicket": exit_questions,
    }

    source_payload = {
        "kind": source.kind,
        "sourceRef": source.ref,
        "title": source.title,
        "sourceUrl": source.source_url,
        "license": source.license,
    }
    if source.kind == SOURCE_NOVEL:
        source_payload["chapter"] = source.chapter
        source_payload["translation"] = "machine_translation"
    else:
        source_payload["videoId"] = source.video_id
        source_payload["translation"] = "existing"

    lesson = {
        "schema": course.SCHEMA,
        "id": lesson_id_placeholder,
        "version": 1,
        "status": STATUS_READY,
        "title": title,
        "titleZh": title_zh,
        "level": level,
        "durationMinutes": 12,
        "source": source_payload,
        "goal": goal,
        "steps": [intro, words_step, *built_steps, output_step],
    }
    try:
        course.parse_lesson(lesson, where="generated-lesson")
    except course.CourseUnavailable as exc:
        raise _ValidationFailed([f"组装后的课程包未通过校验：{exc}"]) from exc
    return lesson


# ---------------------------------------------------------------------------
# 生成
# ---------------------------------------------------------------------------

async def _generate_validated(
    source: SourceMaterial,
    level: str,
    target_lang: str,
    user_id: str,
) -> tuple[dict, str]:
    """调模型 + 严格校验；失败带问题重试 1 次，仍失败抛 GenerationFailed。"""
    model = llm.resolve_model_for_target(None, target_lang)
    base_prompt = _build_prompt(source, level, target_lang)
    last_issues: list[str] | None = None
    last_error: str | None = None

    for attempt in (1, 2):
        prompt = (
            _retry_prompt(base_prompt, last_issues)
            if attempt == 2 and last_issues
            else base_prompt
        )
        if attempt == 2 and not last_issues and last_error:
            prompt = base_prompt + f"\n\nPrevious attempt failed: {last_error}"
        try:
            with llm.usage_scope(FEATURE, user_id, target_lang=target_lang):
                text = await llm.generate_json_async(prompt, model=model)
            raw = _parse_json(text)
            raw, lesson_source = _adapt_final_course(raw, source, target_lang)
            lesson = _build_lesson(raw, lesson_source, level, target_lang)
            return lesson, model
        except _ValidationFailed as exc:
            last_issues = exc.issues
            last_error = str(exc)
            logger.warning("课程生成校验失败（第 %s 次）：%s", attempt, exc)
        except _ParseFailure as exc:
            last_issues = None
            last_error = str(exc)
            logger.warning("课程生成解析失败（第 %s 次）：%s", attempt, exc)
        except Exception as exc:  # noqa: BLE001 - 模型/网络错误统一重试一次
            last_issues = None
            last_error = f"模型调用失败：{exc}"
            logger.warning("课程生成模型调用失败（第 %s 次）：%s", attempt, exc)

    raise GenerationFailed(
        f"generation_failed：课程生成失败（已重试 1 次）：{last_error or '未知错误'}"
    )


def _build_source(
    source_kind: str,
    *,
    video_id: str | None,
    gutenberg_id: int | None,
    chapter: int | None,
    target_lang: str,
) -> SourceMaterial:
    if source_kind == SOURCE_YOUTUBE:
        if not video_id:
            raise InvalidRequest("invalid_source：YouTube 源需要 videoId。")
        return _build_youtube_source(video_id, target_lang)
    if source_kind == SOURCE_NOVEL:
        if gutenberg_id is None:
            gutenberg_id = GUTENBERG_ID
        if chapter is None:
            chapter = 1
        return _build_novel_source(gutenberg_id, chapter)
    raise InvalidRequest(
        "invalid_source：sourceKind 只能是 youtube 或 novel。"
    )


async def generate_course(
    user_id: str,
    *,
    source_kind: str | None,
    video_id: str | None = None,
    gutenberg_id: int | None = None,
    chapter: int | None = None,
    level: str | None = None,
    target_lang: str | None = None,
) -> dict:
    """生成（或复用）一节课程；返回 ``{lessonId,title,level,sourceKind,cached,status}``。

    错误语义：参数 400；源未就绪 409；模型/校验失败 502；缺表/库 503；
    配额超限由 ``ai.ledger.QuotaExceeded`` 冒泡（路由 429）。
    """
    if not user_id:
        raise InvalidRequest("课程生成需要登录。")
    kind = (source_kind or "").strip().lower()
    if kind not in SOURCE_KINDS:
        raise InvalidRequest("invalid_source：sourceKind 只能是 youtube 或 novel。")
    canonical_level = normalize_level(level)
    lang = normalize_target_lang(target_lang)

    source = await asyncio.to_thread(
        _build_source,
        kind,
        video_id=video_id,
        gutenberg_id=gutenberg_id,
        chapter=chapter,
        target_lang=lang,
    )
    key = _cache_key(
        user_id, source.kind, source.ref, source.content_hash, canonical_level, lang
    )

    cached = await asyncio.to_thread(_load_cached, key)
    if cached is not None:
        return _response_payload(cached, cached=True)

    lock = _lock_for(key)
    async with lock:
        cached = await asyncio.to_thread(_load_cached, key)
        if cached is not None:
            return _response_payload(cached, cached=True)

        # 只有真正要调用模型时才占一条「课程生成」日配额。
        await asyncio.to_thread(
            quota.check_and_consume_quota, user_id, FEATURE, 1, target_lang=lang
        )

        lesson, _model = await _generate_validated(
            source, canonical_level, lang, user_id
        )
        row, race_cached = await asyncio.to_thread(_save_generated, key, lesson)
        return _response_payload(row, cached=race_cached)
