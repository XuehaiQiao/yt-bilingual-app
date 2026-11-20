"""理解题生成与作答（计划书 §13.2 M3 / specs/014）。

把「看完一个视频」变成「有出口的小测」：读已有双语字幕的 video / local_show
缓存 → 用大模型生成 3 道英文理解题（选择题 / 判断题）→ 两道闸校验 → 落库
（同一用户同一内容只生成一次）→ 作答判分 → 返回证据 block 与时间点，供前端
「回看证据」跳回那一秒。

设计约束：

- **输入只来自用户自己的字幕缓存**：视频走 ``translate.find_history_file_for_video``，
  本地剧集走 ``history/`` 下的 ``<show>_SxxEyy.json``。不抓网、不重翻、不读
  别人的缓存；缺字幕 / 双语不足 8 句给清晰的 4xx。
- **两道闸（不额外花钱）**：
  1. 结构闸：mcq 必须 4 个选项、tf 必须 2 个选项；答案下标合法；evidence
     block id 必须出现在本次给模型的上下文里；
  2. 内容闸：题干/选项不得混入中文（CJK）；题干或选项必须与证据句共享至少
     一个英文实词（防「问与本段无关的内容」）。
  两道闸任一不过 → 整批重试 1 次；仍不过的题以 ``rejected`` 落库，不返回给
  用户。
- **缓存**：缓存键 = ``(user_id, content_ref, target_lang)`` 行 + 行内的
  ``(content_hash, prompt_version)``。命中原内容且 prompt 版本一致时直接复用
  库里的题，不再调用模型；字幕内容变了（content_hash 变化）才重新生成，并把
  旧题置为 ``rejected``（历史 attempts 仍保留）。**题目跨用户不共享**（D-7
  private 口径）。
- **失败不阻断**：模型调用/解析失败不写内容项，返回 0 题 + 错误信息（下次
  可重试，不被失败结果污染）；模型给出了题但全部被 QC 拒绝时，以
  ``rejected`` 落库并返回错误，避免同一内容反复花钱。
- **时间口径**：数据库里 ``evidence_start/end`` 和 ``answered_at`` 都是**毫秒**；
  对外的证据时间同时给秒（``start``/``end``，与字幕 block 同一时间轴，播放器
  可直接 seek）与毫秒（``startMs``/``endMs``）。
- **表由 Alembic 创建**（``0007_quiz``）：运行时只读写；表缺失时抛
  :class:`QuizUnavailable`，路由转 503，绝不顺手建表。

对外函数：

- :func:`start_lesson`（async）：确保内容项 + 题目，返回 lesson 与题目；
- :func:`get_questions`：取某 lesson 的已通过题目；
- :func:`answer_question`：记录一次作答并返回判分 + 证据；
- :func:`get_result`：结果统计 + 错题证据列表。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import re
import sqlite3
import time
import unicodedata
import uuid

import config
import events
import languages
import llm
import storage
import translate
from ai import quota

logger = logging.getLogger(__name__)

# prompt 版本：缓存键的第二维；改 prompt/校验口径时递增，旧题自动失效重生成。
QUIZ_PROMPT_VERSION = "quiz.v1"

LESSON_QUESTION_COUNT = 3
MIN_BLOCKS = 8
MAX_CONTEXT_BLOCKS = 40
MAX_CONTENT_REF_LENGTH = 200
MAX_ELAPSED_MS = 24 * 60 * 60 * 1000
MAX_PROMPT_CHARS = 600
MAX_OPTION_CHARS = 300
MAX_EXPLANATION_CHARS = 1000

KINDS = ("video", "local_show")
QUESTION_TYPES = ("mcq", "tf")
CONTENT_STATUS_DRAFT = "draft"
CONTENT_STATUS_READY = "ready"
QUESTION_STATUS_DRAFT = "draft"
QUESTION_STATUS_APPROVED = "approved"
QUESTION_STATUS_REJECTED = "rejected"

OPTIONS_PER_MCQ = 4
OPTIONS_PER_TF = 2

MAX_JSON_BYTES = 8 * 1024 * 1024  # 8 MB：单个字幕缓存远小于此，防坏文件撑爆内存

# 单进程内按 (事件循环, user, content, lang) 串行化 start，避免并发重复花钱。
# 测试/多 loop 场景把 loop id 放进 key，避免 asyncio.Lock 跨 loop 绑定。
_lesson_locks: dict[tuple[int, str, str, str], asyncio.Lock] = {}

# 本地剧集引用：show_id-S01E01 / show_id_S01E01 / show_id/S01E01。
_LOCAL_SHOW_REF_RE = re.compile(
    r"^(?P<show>[A-Za-z0-9][A-Za-z0-9_.-]*?)[-_/]"
    r"S(?P<season>\d{1,2})E(?P<episode>\d{1,3})$",
    re.IGNORECASE,
)

# 题干/选项里的 CJK（含日文假名）：英文题面出现这些字符直接判内容闸失败。
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]")

# 词表校验用：英文单词（允许词内连字符/撇号）。
_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'\-]*")
_HASH_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)

# 内容闸的停用词：问句骨架/功能词不参与「题目是否与证据句相关」的判断。
_STOPWORDS = frozenset(
    """
    about above according after again against all also am an and another any are
    as at be because been before being below between both but by can cannot could
    did do does doing done down during each either else even ever every few first
    following for from further had has have having he her here hers him his how
    however i if in into is it its itself just last less many may me might more
    most much must my neither no none not now of off on once one only or other
    otherwise our out over own same second she should since so some such than
    that the their them then there these they thing this those though three
    through thus to too true false two under until up upon us very was we were
    what when where whether which while who whom whose why will with within
    without would you your yours
    """.split()
)

# 额外排除的题型/教案词：它们不是证据句里的实词。
_STOPWORDS = _STOPWORDS | frozenset(
    """
    answer choose correct incorrect option options passage question questions
    sentence speaker statement summary text transcript video main idea best
    explains explanation describe described following read listening
    """.split()
)


# ---------------------------------------------------------------------------
# 错误类型（路由按类型映射 400/404/422/503）
# ---------------------------------------------------------------------------

class QuizError(Exception):
    """理解题模块的领域错误基类。"""

    code = "quiz_error"


class InvalidRequest(QuizError):
    """参数非法（路由 400）。"""

    code = "invalid_request"


class ContentNotFound(QuizError):
    """找不到该视频/剧集的双语字幕缓存（路由 404）。"""

    code = "content_not_found"


class ContentTooShort(QuizError):
    """双语字幕不足 8 句，无法出题（路由 422）。"""

    code = "content_too_short"


class GenerationFailed(QuizError):
    """模型调用失败或所有题未通过 QC（路由 422）。"""

    code = "generation_failed"


class QuizNotFound(QuizError):
    """lesson / question 不存在，或不属于当前用户（路由 404）。"""

    code = "quiz_not_found"


class QuizUnavailable(QuizError):
    """数据库/迁移不可用（路由 503）。"""

    code = "quiz_unavailable"


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def now_ms() -> int:
    """服务端当前毫秒时间戳（测试可 monkeypatch 注入时钟）。"""
    return int(time.time() * 1000)


def canonical_target_lang(raw: str | None) -> str:
    """目标语言 canonical code；缺省 zh-CN，非法抛 InvalidRequest。"""
    try:
        return languages.resolve_target_lang(raw)
    except languages.UnsupportedLanguage as exc:
        raise InvalidRequest(str(exc)) from exc


def _clean_text(value) -> str:
    """NFC + 去首尾空白；非字符串按空串处理。"""
    if not isinstance(value, str):
        return ""
    return unicodedata.normalize("NFC", value).replace("\u00a0", " ").strip()


def _to_ms(value) -> int | None:
    """秒（字幕时间轴）→ 毫秒整数；非法/缺失返回 None。"""
    if value is None or isinstance(value, bool):
        return None
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(seconds):
        return None
    if seconds < 0:
        seconds = 0.0
    return int(round(seconds * 1000))


def _normalize_hash_text(text: str) -> str:
    """content_hash 的正文规范化：NFC、小写、去标点、压缩空白。"""
    value = unicodedata.normalize("NFC", text or "").lower()
    value = _HASH_PUNCT_RE.sub(" ", value)
    return " ".join(value.split())


def _content_hash(blocks: list[dict]) -> str:
    """字幕正文 + 起止毫秒的规范化哈希（sha256 前 16 字节 = 32 hex）。

    不含 per-user JSON 的块 id / 标题 / 频道：同一内容在不同用户缓存里只要
    正文与时间轴一致，哈希就一致（D-7 private 口径下仍按用户隔离生成）。
    """
    digest = hashlib.sha256()
    for block in blocks:
        digest.update(_normalize_hash_text(block["en"]).encode("utf-8"))
        digest.update(b"\x1f")
        digest.update(str(block["start_ms"]).encode("ascii"))
        digest.update(b"\x1f")
        digest.update(str(block["end_ms"]).encode("ascii"))
        digest.update(b"\x1e")
    return digest.hexdigest()[:32]


def _content_tokens(text: str) -> set[str]:
    """英文实词集合（小写 + 简易词尾归一）；用于内容闸的相关性判断。"""
    tokens: set[str] = set()
    for raw in _WORD_RE.findall((text or "").lower()):
        word = raw.strip("'-")
        if len(word) < 4 or word in _STOPWORDS:
            continue
        tokens.add(_stem(word))
    return tokens


def _stem(word: str) -> str:
    """极简词尾归一（opens/opened/opening → open），不引入 NLP 依赖。"""
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    for suffix, min_length in (
        ("ingly", 7),
        ("edly", 6),
        ("ing", 5),
        ("ed", 4),
        ("ly", 5),
        ("es", 4),
        ("s", 3),
    ):
        if word.endswith(suffix) and len(word) >= min_length:
            base = word[: -len(suffix)]
            if len(base) >= 3:
                return base
    return word


def _has_cjk(text: str) -> bool:
    return bool(_CJK_RE.search(text or ""))


def _canonical_block_id(value) -> str:
    """block id 统一成字符串：12 / 12.0 / "12" 都归到 "12"。"""
    if value is None or isinstance(value, bool):
        return ""
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else str(value)
    text = str(value).strip()
    if text.endswith(".0") and text[:-2].isdigit():
        return text[:-2]
    return text


def _decode_block_id(text) -> int | str | None:
    """数据库里的 TEXT → 对外 JSON：纯数字转回 int（兼容前端数字 block id）。"""
    if text is None or text == "":
        return None
    value = str(text)
    try:
        return int(value)
    except (TypeError, ValueError):
        return value


# ---------------------------------------------------------------------------
# 内容解析：video / local_show → 双语 blocks
# ---------------------------------------------------------------------------

def _normalize_content_ref(kind: str, content_ref) -> dict:
    """校验 kind/content_ref；本地剧集引用规范化为 ``<show>-S01E01``。"""
    if kind not in KINDS:
        raise InvalidRequest("kind 只能是 video 或 local_show。")
    if not isinstance(content_ref, str):
        raise InvalidRequest("contentRef 不能为空。")
    ref = content_ref.strip()
    if not ref:
        raise InvalidRequest("contentRef 不能为空。")
    if len(ref) > MAX_CONTENT_REF_LENGTH:
        raise InvalidRequest(f"contentRef 太长（最多 {MAX_CONTENT_REF_LENGTH} 字符）。")
    if "\x00" in ref or "\\" in ref:
        raise InvalidRequest("contentRef 不能包含路径分隔符。")

    parsed: dict = {"kind": kind, "ref": ref}
    if kind == "video":
        if "/" in ref:
            raise InvalidRequest("contentRef 不能包含路径分隔符。")
    else:
        # local_show 接受 <show>/S01E01 写法；show 本身由正则限制为安全字符，
        # 规范化后不再含路径分隔符，缓存路径不会被穿越。
        match = _LOCAL_SHOW_REF_RE.match(ref)
        if not match:
            raise InvalidRequest(
                "local_show 的 contentRef 需要形如 <show_id>-S01E01（也接受 "
                "_S01E01、/S01E01 写法）。"
            )
        show = match.group("show")
        season = int(match.group("season"))
        episode = int(match.group("episode"))
        if not show or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", show):
            raise InvalidRequest("show_id 含非法字符。")
        parsed.update(
            {
                "ref": f"{show}-S{season:02d}E{episode:02d}",
                "show": show,
                "season": season,
                "episode": episode,
            }
        )
    return parsed


def _read_payload(path: str) -> dict:
    """读字幕缓存 JSON；损坏/超限给 ContentNotFound（不 500）。"""
    try:
        size = os.path.getsize(path)
    except OSError as exc:
        raise ContentNotFound("字幕缓存不可读。") from exc
    if size > MAX_JSON_BYTES:
        raise ContentNotFound("字幕缓存文件过大，拒绝加载。")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError) as exc:
        raise ContentNotFound("字幕缓存损坏，无法解析。") from exc
    if not isinstance(payload, dict):
        raise ContentNotFound("字幕缓存格式不正确。")
    return payload


def _normalize_blocks(transcript: list) -> tuple[list[dict], list[dict]]:
    """原始 transcript → (all_blocks, eligible_blocks)。

    ``all_blocks`` 保留所有有英文正文的块（供上下文用）；``eligible_blocks``
    只保留「英文 + 目标语言译文都有、且译文不是失败占位」的块（出题与证据
    只能引用这些块）。块 id 沿用缓存里的 ``id``（没有时用序号 +1）。
    """
    all_blocks: list[dict] = []
    seen_ids: set[str] = set()
    for index, raw in enumerate(transcript):
        if not isinstance(raw, dict):
            continue
        en = _clean_text(raw.get("en_text") or raw.get("text"))
        if not en:
            continue
        zh = _clean_text(raw.get("zh_text"))
        start_ms = _to_ms(raw.get("start"))
        end_ms = _to_ms(raw.get("end"))
        if start_ms is None:
            # 没有起点的块无法作为证据回跳，也不能进 prompt（否则模型可能引用）。
            continue
        if end_ms is None or end_ms < start_ms:
            end_ms = start_ms
        raw_id = raw.get("id")
        block_id = _canonical_block_id(raw_id) or str(index + 1)
        if block_id in seen_ids:
            # 块 id 重复会让证据指向歧义；保留第一条并记日志，不改变前端 id。
            logger.warning("字幕块 id 重复（%s），已忽略后续重复块。", block_id)
            continue
        seen_ids.add(block_id)
        block = {
            "id": block_id,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "en": en,
            "zh": zh,
            "bilingual": bool(zh) and not translate.needs_retranslation(zh),
        }
        all_blocks.append(block)
    eligible = [block for block in all_blocks if block["bilingual"]]
    return all_blocks, eligible


def _select_context_blocks(eligible: list[dict]) -> list[dict]:
    """选送进 prompt 的块：不超过 40 块时全用；更长时按时间轴均匀抽样。"""
    if len(eligible) <= MAX_CONTEXT_BLOCKS:
        return list(eligible)
    step = (len(eligible) - 1) / (MAX_CONTEXT_BLOCKS - 1)
    indices: list[int] = []
    for position in range(MAX_CONTEXT_BLOCKS):
        index = int(round(position * step))
        if index not in indices:
            indices.append(index)
    return [eligible[index] for index in indices]


def _resolve_content(parsed_ref: dict, target_lang: str) -> dict:
    """按 kind/contentRef 找到缓存并解析出题所需的 blocks 与元数据。"""
    kind = parsed_ref["kind"]
    content_ref = parsed_ref["ref"]
    if kind == "video":
        path = translate.find_history_file_for_video(
            content_ref, target_lang=target_lang
        )
        if not path:
            raise ContentNotFound(
                f"没有找到该视频在 {target_lang} 下的双语字幕缓存，请先完成字幕生成。"
            )
    else:
        filename = (
            f"{parsed_ref['show']}_S{parsed_ref['season']:02d}"
            f"E{parsed_ref['episode']:02d}.json"
        )
        path = os.path.join(storage.history_dir(target_lang), filename)
        if not os.path.isfile(path):
            raise ContentNotFound(
                f"没有找到该集在 {target_lang} 下的双语字幕缓存，请先完成字幕生成。"
            )

    payload = _read_payload(path)
    cached_lang = translate.payload_target_lang(payload)
    if cached_lang != target_lang:
        raise ContentNotFound(
            f"该缓存不是 {target_lang} 版本（实际 {cached_lang}），请重新生成字幕。"
        )
    transcript = payload.get("transcript")
    if not isinstance(transcript, list):
        raise ContentNotFound("字幕缓存缺少 transcript 字段。")

    all_blocks, eligible = _normalize_blocks(transcript)
    if len(eligible) < MIN_BLOCKS:
        raise ContentTooShort(
            f"可出题的双语字幕不足 {MIN_BLOCKS} 句（当前 {len(eligible)} 句），"
            "这集暂无练习。"
        )

    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    title = _clean_text(metadata.get("title")) or content_ref
    context_blocks = _select_context_blocks(eligible)
    return {
        "kind": kind,
        "content_ref": content_ref,
        "target_lang": target_lang,
        "title": title,
        "all_blocks": all_blocks,
        "eligible_blocks": eligible,
        "context_blocks": context_blocks,
        "content_hash": _content_hash(eligible),
    }


# ---------------------------------------------------------------------------
# Prompt / 模型响应解析
# ---------------------------------------------------------------------------

_QUIZ_PROMPT_TEMPLATE = """You are an ESL reading-comprehension quiz writer for a
bilingual subtitle app. The learner has just watched the video segment below.
Write exactly 3 comprehension questions about it.

TRANSCRIPT BLOCKS (each line starts with [id=<block id>] start=<seconds>s):
{blocks}

RULES:
1. Write exactly 3 questions. Prefer 2 "mcq" and 1 "tf".
2. "mcq" has exactly 4 distinct English options. "tf" has exactly 2 options:
   ["True", "False"].
3. "answer_index" is 0-based and must point to the correct option.
4. Every question must set "evidence_block_id" to one of the ids shown above.
5. The question prompt and all options must be in English only. Do NOT include
   any Chinese/Japanese characters in them.
6. "explanation" must be written in {target_name}. It may be in the target
   language (Chinese/Vietnamese is fine here).
7. Use ONLY facts stated in the transcript blocks. Do NOT use outside knowledge,
   the video title, the channel name, or guesses.
8. The question prompt or its options must include at least one key content
   word from the evidence block, so the evidence link is checkable.
9. Do not use "all of the above" / "none of the above". Distractors must be
   plausible but wrong.
10. Return ONLY a JSON object, with no markdown fences and no commentary.

JSON shape:
{{"questions": [
  {{"question_type": "mcq",
    "prompt": "English question?",
    "options": ["English option A", "English option B", "English option C", "English option D"],
    "answer_index": 0,
    "evidence_block_id": "12",
    "explanation": "..."}},
  {{"question_type": "tf",
    "prompt": "English statement to judge.",
    "options": ["True", "False"],
    "answer_index": 0,
    "evidence_block_id": "13",
    "explanation": "..."}}
]}}"""


def _format_blocks_for_prompt(blocks: list[dict]) -> str:
    lines = []
    for block in blocks:
        seconds = block["start_ms"] / 1000
        lines.append(f"[id={block['id']}] start={seconds:.2f}s\n{block['en']}")
    return "\n\n".join(lines)


def _build_prompt(blocks: list[dict], target_lang: str) -> str:
    target_name = languages.prompt_name(target_lang)
    return _QUIZ_PROMPT_TEMPLATE.format(
        blocks=_format_blocks_for_prompt(blocks), target_name=target_name
    )


def _build_retry_prompt(base_prompt: str, issues: list[str]) -> str:
    detail = "\n".join(f"- {issue}" for issue in issues[:8]) or "- unknown issue"
    return (
        base_prompt
        + "\n\nYour previous JSON failed validation:\n"
        + detail
        + "\nRegenerate the complete JSON object with exactly 3 valid questions. "
        "Do not repeat the same mistakes."
    )


class _ParseFailure(ValueError):
    """模型响应不是可用 JSON。"""


def _strip_code_fence(text: str) -> str:
    value = text.strip()
    if not value.startswith("```"):
        return value
    lines = value.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip().startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines).strip()


def _extract_json_value(text: str):
    """尽量从模型输出里取出 JSON；先整段解析，再截取首尾括号。"""
    stripped = _strip_code_fence(text)
    if not stripped:
        raise _ParseFailure("模型返回空响应。")
    try:
        return json.loads(stripped)
    except ValueError:
        pass

    starts = [pos for pos in (stripped.find("{"), stripped.find("[")) if pos >= 0]
    if not starts:
        raise _ParseFailure("模型返回内容里没有 JSON。")
    start = min(starts)
    end = max(stripped.rfind("}"), stripped.rfind("]"))
    if end <= start:
        raise _ParseFailure("模型返回的 JSON 不完整。")
    try:
        return json.loads(stripped[start : end + 1])
    except ValueError as exc:
        raise _ParseFailure(f"模型返回的 JSON 无法解析：{exc}") from exc


def _extract_question_list(data) -> list[dict]:
    """兼容模型常见的几种 JSON 外壳，返回 dict 列表。"""
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if isinstance(data, dict):
        if isinstance(data.get("prompt"), str):
            return [data]
        for key in ("questions", "items", "quiz", "data", "results", "content"):
            value = data.get(key)
            if isinstance(value, str):
                try:
                    value = json.loads(value)
                except ValueError:
                    continue
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
            if isinstance(value, dict):
                nested = _extract_question_list(value)
                if nested:
                    return nested
    return []


def _parse_questions(text: str) -> list[dict]:
    data = _extract_json_value(text)
    items = _extract_question_list(data)
    if not items:
        raise _ParseFailure("模型响应里没有 questions 数组。")
    if len(items) > LESSON_QUESTION_COUNT:
        logger.warning("模型返回了 %s 道题，只取前 %s 道。", len(items), LESSON_QUESTION_COUNT)
        items = items[:LESSON_QUESTION_COUNT]
    return items


def _normalize_question_type(value) -> str | None:
    raw = _clean_text(value).lower().replace("-", "_").replace(" ", "_")
    if raw in ("", "mcq", "multiple_choice", "choice", "single_choice"):
        return "mcq"
    if raw in ("tf", "true_false", "truefalse", "boolean", "judge", "judgement"):
        return "tf"
    return None


def _candidate(
    *,
    question_type: str,
    prompt: str,
    options: list[str],
    answer_index: int,
    evidence_block_id: str | None,
    evidence_start: int | None,
    evidence_end: int | None,
    explanation: str,
    issues: list[str],
) -> dict:
    return {
        "question_type": question_type,
        "prompt": prompt,
        "options": options,
        "answer_index": answer_index,
        "evidence_block_id": evidence_block_id,
        "evidence_start": evidence_start,
        "evidence_end": evidence_end,
        "explanation": explanation,
        "status": QUESTION_STATUS_APPROVED if not issues else QUESTION_STATUS_REJECTED,
        "issues": list(issues),
    }


def _extract_evidence_block_id(raw: dict) -> str:
    value = raw.get("evidence_block_id", raw.get("evidenceBlockId"))
    if value is None:
        value = raw.get("evidence")
    if isinstance(value, dict):
        value = value.get("blockId", value.get("block_id", value.get("id")))
    return _canonical_block_id(value)


def _validate_candidate(raw, context_by_id: dict[str, dict]) -> dict:
    """结构闸 + 内容闸；返回带 approved/rejected 状态的候选字典。"""
    if not isinstance(raw, dict):
        return _candidate(
            question_type="mcq",
            prompt="（题目结构非法）",
            options=[],
            answer_index=-1,
            evidence_block_id=None,
            evidence_start=None,
            evidence_end=None,
            explanation="",
            issues=["题目不是 JSON 对象"],
        )

    issues: list[str] = []
    question_type = _normalize_question_type(
        raw.get("question_type", raw.get("questionType", raw.get("type")))
    )
    if question_type is None:
        issues.append("question_type 只能是 mcq 或 tf")
        question_type = "mcq"

    prompt = _clean_text(raw.get("prompt") or raw.get("question"))
    if not prompt:
        issues.append("题干为空")
    elif len(prompt) > MAX_PROMPT_CHARS:
        issues.append("题干过长")
    if prompt and _has_cjk(prompt):
        issues.append("题干混入了中文/日文字符")

    raw_options = raw.get("options", raw.get("choices"))
    options: list[str] = []
    if not isinstance(raw_options, list):
        issues.append("options 必须是数组")
    else:
        for item in raw_options:
            options.append(_clean_text(item))
        # mcq = 选择题（4 选 1）；tf = 判断题（True/False 两个选项）。
        # 题面/选项都必须是英文，答案下标按各自选项数校验。
        expected = OPTIONS_PER_MCQ if question_type == "mcq" else OPTIONS_PER_TF
        if len(options) != expected:
            issues.append(
                f"{question_type} 需要 {expected} 个选项（实际 {len(options)} 个）"
            )
        if any(not option for option in options):
            issues.append("存在空选项")
        if any(len(option) > MAX_OPTION_CHARS for option in options):
            issues.append("选项过长")
        if any(_has_cjk(option) for option in options):
            issues.append("选项混入了中文/日文字符")
        normalized = [option.casefold() for option in options if option]
        if len(set(normalized)) != len(normalized):
            issues.append("选项重复")
        joined = " ".join(options).lower()
        if "all of the above" in joined or "none of the above" in joined:
            issues.append("选项里包含 all/none of the above")

    raw_answer = raw.get("answer_index", raw.get("answerIndex"))
    answer_index = -1
    if isinstance(raw_answer, bool) or raw_answer is None:
        issues.append("缺少合法的 answer_index")
    else:
        try:
            answer_index = int(raw_answer)
        except (TypeError, ValueError):
            issues.append("answer_index 不是整数")
        else:
            if options and not (0 <= answer_index < len(options)):
                issues.append("answer_index 越界")

    evidence_key = _extract_evidence_block_id(raw)
    evidence = context_by_id.get(evidence_key)
    if not evidence_key:
        issues.append("缺少 evidence_block_id")
    elif evidence is None:
        issues.append("evidence_block_id 不在本次上下文的字幕块里")

    explanation = _clean_text(
        raw.get("explanation") or raw.get("explanation_zh") or raw.get("rationale")
    )
    if not explanation:
        issues.append("缺少 explanation")
    elif len(explanation) > MAX_EXPLANATION_CHARS:
        issues.append("explanation 过长")

    # 内容闸：题干/选项必须与证据句共享至少一个英文实词。
    if evidence is not None:
        question_tokens = _content_tokens(prompt + " " + " ".join(options))
        evidence_tokens = _content_tokens(evidence["en"])
        if not question_tokens:
            issues.append("题干/选项缺少可用于校验的英文实词")
        elif not (question_tokens & evidence_tokens):
            issues.append("题目与证据句无关")

    return _candidate(
        question_type=question_type,
        prompt=prompt or "（题目结构非法）",
        options=options,
        answer_index=answer_index,
        evidence_block_id=evidence["id"] if evidence is not None else None,
        evidence_start=evidence["start_ms"] if evidence is not None else None,
        evidence_end=evidence["end_ms"] if evidence is not None else None,
        explanation=explanation,
        issues=issues,
    )


def _validate_all(items: list[dict], context_by_id: dict[str, dict]) -> list[dict]:
    candidates = [_validate_candidate(item, context_by_id) for item in items]
    return candidates[:LESSON_QUESTION_COUNT]


def _approved_count(candidates: list[dict]) -> int:
    return sum(1 for item in candidates if item["status"] == QUESTION_STATUS_APPROVED)


# ---------------------------------------------------------------------------
# 生成（async：调用大模型；失败重试 1 次）
# ---------------------------------------------------------------------------

async def _generate_questions(
    user_id: str,
    target_lang: str,
    blocks: list[dict],
) -> tuple[list[dict], str | None]:
    """调模型 + 两道闸；返回 (候选列表, 错误信息)。

    重试策略：第一轮只要有任一道题没通过（或模型调用/解析失败），带着校验
    问题重试 1 次；两轮都跑完后取「通过题数更多」的一轮（平局取后一轮）。
    两轮都没有候选 → 返回空列表 + 错误，由调用方决定不落库（失败不污染缓存）。
    """
    context_by_id = {block["id"]: block for block in blocks}
    base_prompt = _build_prompt(blocks, target_lang)
    model = llm.resolve_model_for_target(None, target_lang)
    attempts: list[list[dict]] = []
    last_error: str | None = None

    for attempt in (1, 2):
        prompt = base_prompt
        if attempt == 2 and attempts:
            issues = [
                issue
                for candidate in attempts[-1]
                for issue in candidate.get("issues", [])
            ]
            prompt = _build_retry_prompt(base_prompt, issues)
        elif attempt == 2 and last_error:
            prompt = base_prompt + f"\n\nPrevious attempt failed: {last_error}"
        try:
            # 账本归属：feature=quiz，成功调用按 provider usage 记进 ai_usage。
            with llm.usage_scope("quiz", user_id, target_lang=target_lang):
                text = await llm.generate_json_async(prompt, model=model)
            raw_items = _parse_questions(text)
            candidates = _validate_all(raw_items, context_by_id)
            attempts.append(candidates)
            if _approved_count(candidates) >= LESSON_QUESTION_COUNT:
                return candidates, None
            last_error = "部分题目未通过结构/内容校验。"
        except _ParseFailure as exc:
            last_error = str(exc)
            logger.warning("理解题生成解析失败（第 %s 次）：%s", attempt, exc)
        except Exception as exc:  # noqa: BLE001 - 模型/网络错误不阻断主流程
            quota.rethrow_billing_error(exc)  # 402 不能被当成模型失败重试
            last_error = f"模型调用失败：{exc}"
            logger.warning("理解题生成失败（第 %s 次）：%s", attempt, exc)

    if not attempts:
        return [], last_error or "题目生成失败，请稍后重试。"
    best = attempts[0]
    for candidate in attempts[1:]:
        if _approved_count(candidate) >= _approved_count(best):
            best = candidate
    approved = _approved_count(best)
    if approved <= 0:
        return best, last_error or "模型生成的题目均未通过校验。"
    return best, None if approved >= LESSON_QUESTION_COUNT else last_error


# ---------------------------------------------------------------------------
# SQLite 读写
# ---------------------------------------------------------------------------

def _db_path() -> str:
    return config.AUTH_DB_PATH


def _connect() -> sqlite3.Connection:
    path = _db_path()
    if not os.path.exists(path):
        raise QuizUnavailable(
            f"数据库文件不存在：{path}（先运行 `venv/bin/alembic upgrade head`）。"
        )
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _translate_db_error(exc: sqlite3.Error) -> None:
    """表/列缺失 → QuizUnavailable（503）；其余错误原样抛。"""
    text = str(exc).lower()
    if "no such table" in text or "no such column" in text:
        raise QuizUnavailable(
            "理解题数据表不存在（未跑 0007_quiz 迁移）。"
            "请先运行 `backend/venv/bin/alembic upgrade head`。"
        ) from exc


_ITEM_COLUMNS = (
    "id, user_id, kind, content_ref, target_lang, content_hash, title, status, "
    "prompt_version, created_at"
)

_QUESTION_COLUMNS = (
    "id, content_item_id, ordinal, question_type, prompt, options, answer_index, "
    "evidence_block_id, evidence_start, evidence_end, explanation, status, model, "
    "created_at"
)


def _row_to_item(row: sqlite3.Row) -> dict:
    item = dict(row)
    item["created_at"] = int(item.get("created_at") or 0)
    return item


def _row_to_question(row: sqlite3.Row) -> dict:
    question = dict(row)
    try:
        options = json.loads(question.get("options") or "[]")
    except ValueError:
        logger.warning("题目 %s 的 options JSON 损坏，按空数组返回。", question.get("id"))
        options = []
    question["options"] = options if isinstance(options, list) else []
    question["ordinal"] = (
        int(question["ordinal"]) if question.get("ordinal") is not None else 0
    )
    question["answer_index"] = (
        int(question["answer_index"])
        if question.get("answer_index") is not None
        else -1
    )
    for key in ("evidence_start", "evidence_end", "created_at"):
        if question.get(key) is not None:
            question[key] = int(question[key])
    return question


def _fetch_item_by_ref(
    conn: sqlite3.Connection, user_id: str, content_ref: str, target_lang: str
) -> dict | None:
    row = conn.execute(
        f"SELECT {_ITEM_COLUMNS} FROM content_items "
        "WHERE user_id = ? AND content_ref = ? AND target_lang = ?",
        (user_id, content_ref, target_lang),
    ).fetchone()
    return _row_to_item(row) if row is not None else None


def _fetch_item_by_id(conn: sqlite3.Connection, item_id: str) -> dict | None:
    row = conn.execute(
        f"SELECT {_ITEM_COLUMNS} FROM content_items WHERE id = ?", (item_id,)
    ).fetchone()
    return _row_to_item(row) if row is not None else None


def _get_item_by_ref(user_id: str, content_ref: str, target_lang: str) -> dict | None:
    conn = _connect()
    try:
        return _fetch_item_by_ref(conn, user_id, content_ref, target_lang)
    except sqlite3.OperationalError as exc:
        _translate_db_error(exc)
        raise
    finally:
        conn.close()


def _get_item_by_id(item_id: str) -> dict:
    conn = _connect()
    try:
        item = _fetch_item_by_id(conn, item_id)
    except sqlite3.OperationalError as exc:
        _translate_db_error(exc)
        raise
    finally:
        conn.close()
    if item is None:
        raise QuizNotFound("lesson 不存在。")
    return item


def _owned_item(user_id: str, item_id: str) -> dict:
    """取 lesson；不存在或不属于当前用户统一 404（不泄露存在性）。"""
    if not isinstance(item_id, str) or not item_id.strip():
        raise QuizNotFound("lesson 不存在。")
    item = _get_item_by_id(item_id.strip())
    if item["user_id"] != user_id:
        raise QuizNotFound("lesson 不存在。")
    return item


def _load_questions(item_id: str, statuses: tuple[str, ...]) -> list[dict]:
    placeholders = ", ".join("?" for _ in statuses)
    conn = _connect()
    try:
        rows = conn.execute(
            f"SELECT {_QUESTION_COLUMNS} FROM questions "
            f"WHERE content_item_id = ? AND status IN ({placeholders}) "
            "ORDER BY ordinal ASC, created_at ASC, id ASC",
            (item_id, *statuses),
        ).fetchall()
        return [_row_to_question(row) for row in rows]
    except sqlite3.OperationalError as exc:
        _translate_db_error(exc)
        raise
    finally:
        conn.close()


def _persist_generation(
    *,
    user_id: str,
    parsed_ref: dict,
    target_lang: str,
    content_hash: str,
    title: str,
    candidates: list[dict],
    model: str,
) -> str:
    """在一个事务里 upsert 内容项 + 替换当前题；返回 content_item id。"""
    content_ref = parsed_ref["ref"]
    kind = parsed_ref["kind"]
    created_at = now_ms()
    approved = _approved_count(candidates)
    status = CONTENT_STATUS_READY if approved > 0 else CONTENT_STATUS_DRAFT

    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT id FROM content_items "
            "WHERE user_id = ? AND content_ref = ? AND target_lang = ?",
            (user_id, content_ref, target_lang),
        ).fetchone()
        if row is not None:
            item_id = row["id"]
            # 内容/提示词变化：旧题不删（attempts 仍引用），标记 rejected 退出展示。
            conn.execute(
                "UPDATE questions SET status = ? "
                "WHERE content_item_id = ? AND status IN (?, ?)",
                (
                    QUESTION_STATUS_REJECTED,
                    item_id,
                    QUESTION_STATUS_APPROVED,
                    QUESTION_STATUS_DRAFT,
                ),
            )
            conn.execute(
                "UPDATE content_items SET kind = ?, content_hash = ?, title = ?, "
                "status = ?, prompt_version = ? WHERE id = ?",
                (
                    kind,
                    content_hash,
                    title,
                    status,
                    QUIZ_PROMPT_VERSION,
                    item_id,
                ),
            )
        else:
            item_id = uuid.uuid4().hex
            conn.execute(
                "INSERT INTO content_items "
                "(id, user_id, kind, content_ref, target_lang, content_hash, title, "
                "status, prompt_version, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    item_id,
                    user_id,
                    kind,
                    content_ref,
                    target_lang,
                    content_hash,
                    title,
                    status,
                    QUIZ_PROMPT_VERSION,
                    created_at,
                ),
            )

        for ordinal, candidate in enumerate(candidates, start=1):
            conn.execute(
                "INSERT INTO questions "
                "(id, content_item_id, ordinal, question_type, prompt, options, "
                "answer_index, evidence_block_id, evidence_start, evidence_end, "
                "explanation, status, model, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    uuid.uuid4().hex,
                    item_id,
                    ordinal,
                    candidate["question_type"],
                    candidate["prompt"],
                    json.dumps(candidate["options"], ensure_ascii=False),
                    int(candidate["answer_index"]),
                    candidate["evidence_block_id"],
                    candidate["evidence_start"],
                    candidate["evidence_end"],
                    candidate["explanation"],
                    candidate["status"],
                    model,
                    created_at,
                ),
            )
        conn.commit()
        return item_id
    except sqlite3.OperationalError as exc:
        conn.rollback()
        _translate_db_error(exc)
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 序列化
# ---------------------------------------------------------------------------

def _public_question(question: dict) -> dict:
    """答题前不暴露答案/解释；只给渲染题目必要字段。"""
    return {
        "id": question["id"],
        "ordinal": question["ordinal"],
        "questionType": question["question_type"],
        "prompt": question["prompt"],
        "options": question["options"],
    }


def _evidence_payload(question: dict) -> dict:
    """证据时间：秒（播放器直接 seek）+ 毫秒（稳定口径）。"""
    block_id = _decode_block_id(question.get("evidence_block_id"))
    start_ms = question.get("evidence_start")
    end_ms = question.get("evidence_end")
    if start_ms is None or end_ms is None:
        return {
            "blockId": block_id,
            "start": None,
            "end": None,
            "startMs": None,
            "endMs": None,
        }
    return {
        "blockId": block_id,
        "start": round(int(start_ms) / 1000, 3),
        "end": round(int(end_ms) / 1000, 3),
        "startMs": int(start_ms),
        "endMs": int(end_ms),
    }


def _lesson_payload(item: dict, questions: list[dict]) -> dict:
    return {
        "lessonId": item["id"],
        "status": item["status"],
        "kind": item["kind"],
        "contentRef": item["content_ref"],
        "targetLang": item["target_lang"],
        "contentHash": item["content_hash"],
        "questions": [_public_question(question) for question in questions],
    }


# ---------------------------------------------------------------------------
# 对外：start / questions / answer / result
# ---------------------------------------------------------------------------

async def start_lesson(
    user_id: str, kind: str, content_ref, target_lang: str | None
) -> dict:
    """确保内容项 + 题目（已有且内容未变则复用），返回 lesson 与 3 道题。

    单进程内按 ``(user, content, lang)`` 串行化：两个并发 start 不会各调一次
    模型（第二个拿到锁后重新查缓存直接复用）。
    """
    lang = canonical_target_lang(target_lang)
    parsed_ref = _normalize_content_ref(kind, content_ref)
    content = await asyncio.to_thread(_resolve_content, parsed_ref, lang)

    loop_key = id(asyncio.get_running_loop())
    lock_key = (loop_key, user_id, parsed_ref["ref"], lang)
    lock = _lesson_locks.get(lock_key)
    if lock is None:
        lock = asyncio.Lock()
        _lesson_locks[lock_key] = lock

    async with lock:
        item = await asyncio.to_thread(
            _get_item_by_ref, user_id, parsed_ref["ref"], lang
        )
        if (
            item is not None
            and item["kind"] == parsed_ref["kind"]
            and item["content_hash"] == content["content_hash"]
            and item["prompt_version"] == QUIZ_PROMPT_VERSION
        ):
            questions = await asyncio.to_thread(
                _load_questions, item["id"], (QUESTION_STATUS_APPROVED,)
            )
            if questions:
                return _lesson_payload(item, questions)
            # 之前生成过但全部被 QC 拒绝：命中缓存，不再重复花钱。
            raise GenerationFailed(
                "该内容的题目此前未通过校验（结果已缓存，不重复生成）；"
                "字幕更新或 prompt 升级后可重试。"
            )

        # 只有真正要调用模型时才占一条「理解题」日配额。
        await asyncio.to_thread(
            quota.check_and_consume_quota, user_id, "quiz", 1, target_lang=lang
        )

        candidates, error = await _generate_questions(
            user_id, lang, content["context_blocks"]
        )
        if not candidates:
            # 模型调用/解析失败：不写库，下次可重试，不被失败结果污染。
            raise GenerationFailed(error or "题目生成失败，请稍后重试。")

        model = llm.resolve_model_for_target(None, lang)
        item_id = await asyncio.to_thread(
            _persist_generation,
            user_id=user_id,
            parsed_ref=parsed_ref,
            target_lang=lang,
            content_hash=content["content_hash"],
            title=content["title"],
            candidates=candidates,
            model=model,
        )
        questions = await asyncio.to_thread(
            _load_questions, item_id, (QUESTION_STATUS_APPROVED,)
        )
        if not questions:
            raise GenerationFailed(
                error or "模型生成的题目均未通过校验（已缓存，不重复生成）。"
            )
        item = await asyncio.to_thread(_get_item_by_id, item_id)
        return _lesson_payload(item, questions)


def get_questions(user_id: str, lesson_id: str) -> dict:
    """取 lesson 的已通过题目；不存在/别人的 lesson 一律 404。"""
    item = _owned_item(user_id, lesson_id)
    questions = _load_questions(item["id"], (QUESTION_STATUS_APPROVED,))
    return _lesson_payload(item, questions)


def _fetch_question_for_user(question_id: str, user_id: str) -> dict:
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT q.id, q.content_item_id, q.ordinal, q.question_type, "
            "q.prompt, q.options, q.answer_index, q.evidence_block_id, "
            "q.evidence_start, q.evidence_end, q.explanation, q.status, q.model, "
            "q.created_at, ci.user_id AS item_user_id, "
            "ci.content_ref AS content_ref, ci.kind AS kind, "
            "ci.target_lang AS target_lang "
            "FROM questions q JOIN content_items ci ON ci.id = q.content_item_id "
            "WHERE q.id = ?",
            (question_id,),
        ).fetchone()
    except sqlite3.OperationalError as exc:
        _translate_db_error(exc)
        raise
    finally:
        conn.close()
    if row is None:
        raise QuizNotFound("题目不存在。")
    question = _row_to_question(row)
    extra = dict(row)
    question.update(
        {
            "item_user_id": extra.get("item_user_id"),
            "content_ref": extra.get("content_ref"),
            "kind": extra.get("kind"),
            "target_lang": extra.get("target_lang"),
        }
    )
    if question["item_user_id"] != user_id:
        raise QuizNotFound("题目不存在。")
    if question["status"] != QUESTION_STATUS_APPROVED:
        # 已下线的题不再接受作答；对用户表现为不存在。
        raise QuizNotFound("题目不存在。")
    return question


def _coerce_choice(value) -> int:
    if isinstance(value, bool) or value is None:
        raise InvalidRequest("chosenIndex 必须是整数。")
    try:
        chosen = int(value)
    except (TypeError, ValueError) as exc:
        raise InvalidRequest("chosenIndex 必须是整数。") from exc
    return chosen


def _coerce_elapsed(value) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise InvalidRequest("elapsedMs 必须是非负整数。")
    try:
        elapsed = int(value)
    except (TypeError, ValueError) as exc:
        raise InvalidRequest("elapsedMs 必须是非负整数。") from exc
    if elapsed < 0 or elapsed > MAX_ELAPSED_MS:
        raise InvalidRequest("elapsedMs 超出允许范围（0–24 小时）。")
    return elapsed


def answer_question(
    user_id: str, question_id: str, chosen_index, elapsed_ms
) -> dict:
    """记录一次作答；返回判分、正确答案、解释与证据时间点。"""
    if not isinstance(question_id, str) or not question_id.strip():
        raise QuizNotFound("题目不存在。")
    question = _fetch_question_for_user(question_id.strip(), user_id)
    options = question["options"]
    if not options:
        raise QuizNotFound("题目不存在。")
    chosen = _coerce_choice(chosen_index)
    if not (0 <= chosen < len(options)):
        raise InvalidRequest(
            f"chosenIndex 越界（题目有 {len(options)} 个选项）。"
        )
    elapsed = _coerce_elapsed(elapsed_ms)
    correct = chosen == question["answer_index"]
    answered_at = now_ms()

    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        cursor = conn.execute(
            "INSERT INTO attempts "
            "(user_id, question_id, chosen_index, is_correct, answered_at, elapsed_ms) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                user_id,
                question["id"],
                chosen,
                1 if correct else 0,
                answered_at,
                elapsed,
            ),
        )
        attempt_id = cursor.lastrowid
        conn.commit()
    except sqlite3.OperationalError as exc:
        conn.rollback()
        _translate_db_error(exc)
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    evidence = _evidence_payload(question)
    result = {
        "correct": bool(correct),
        "answerIndex": question["answer_index"],
        "chosenIndex": chosen,
        "explanation": question["explanation"],
        "evidence": evidence,
        "lessonId": question["content_item_id"],
        "questionId": question["id"],
        "questionType": question["question_type"],
        "attemptId": int(attempt_id) if attempt_id is not None else None,
        "answeredAt": answered_at,
    }
    # 周报/能力评估的事件原料：答题时写 quiz_answer（失败不阻断主流程）。
    events.emit_event(
        "quiz_answer",
        user_id=user_id,
        content_ref=question["content_ref"],
        payload={
            "lessonId": question["content_item_id"],
            "questionId": question["id"],
            "questionType": question["question_type"],
            "chosenIndex": chosen,
            "answerIndex": question["answer_index"],
            "correct": bool(correct),
            "evidence": evidence,
            "elapsedMs": elapsed,
            "kind": question["kind"],
            "targetLang": question["target_lang"],
        },
        occurred_at=answered_at,
    )
    return result


def get_result(user_id: str, lesson_id: str) -> dict:
    """结果统计：对/错/正确率 + 错题证据列表（按作答时间倒序）。"""
    item = _owned_item(user_id, lesson_id)
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT a.id AS attempt_id, a.chosen_index, a.is_correct, "
            "a.answered_at, a.elapsed_ms, q.id AS question_id, q.prompt, "
            "q.answer_index, q.explanation, q.evidence_block_id, "
            "q.evidence_start, q.evidence_end, q.question_type "
            "FROM attempts a JOIN questions q ON q.id = a.question_id "
            "WHERE q.content_item_id = ? AND a.user_id = ? AND q.status = ? "
            "ORDER BY a.answered_at ASC, a.id ASC",
            (item["id"], user_id, QUESTION_STATUS_APPROVED),
        ).fetchall()
        total_questions = conn.execute(
            "SELECT COUNT(*) AS n FROM questions "
            "WHERE content_item_id = ? AND status = ?",
            (item["id"], QUESTION_STATUS_APPROVED),
        ).fetchone()["n"]
    except sqlite3.OperationalError as exc:
        _translate_db_error(exc)
        raise
    finally:
        conn.close()

    attempts = []
    for row in rows:
        question = _row_to_question(row)
        question["id"] = row["question_id"]
        attempts.append(
            {
                "attemptId": int(row["attempt_id"]),
                "questionId": question["id"],
                "questionType": question["question_type"],
                "prompt": question["prompt"],
                "chosenIndex": int(row["chosen_index"]),
                "answerIndex": question["answer_index"],
                "explanation": question["explanation"],
                "evidence": _evidence_payload(question),
                "correct": bool(row["is_correct"]),
                "answeredAt": int(row["answered_at"]),
                "elapsedMs": int(row["elapsed_ms"]) if row["elapsed_ms"] is not None else None,
            }
        )

    answered = len(attempts)
    correct_count = sum(1 for attempt in attempts if attempt["correct"])
    wrong = [attempt for attempt in attempts if not attempt["correct"]]
    wrong.reverse()  # 最新错的在前
    return {
        "lessonId": item["id"],
        "status": item["status"],
        "kind": item["kind"],
        "contentRef": item["content_ref"],
        "targetLang": item["target_lang"],
        "totalQuestions": int(total_questions or 0),
        "answered": answered,
        "correct": correct_count,
        "wrong": len(wrong),
        "correctRate": round(correct_count / answered, 4) if answered else 0.0,
        "wrongQuestions": wrong,
        "lastAnsweredAt": attempts[-1]["answeredAt"] if attempts else None,
    }
