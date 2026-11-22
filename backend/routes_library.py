"""本地免费资源库（content/library，用户需求 #11）。

公开只读、无需登录；**读/播放不触发模型调用**：

- ``GET /api/library``：视频 + 文章清单（首页「免费资源」窗用）；
- ``GET /api/library/videos/{id}``：视频元数据 + 预生成双语字幕块；
- ``GET /api/library/articles/{id}``：原创文章标题 + 逐段 ``{en, zh}`` + 等级。

内容 = 仓库内 ``content/library/*.json`` 与 ``videos/*.json`` / ``articles/*.json``。
视频**不下载视频文件**：只存字幕块与元数据，播放仍走 YouTube 嵌入；路径见
``content/library/README.md``。

教学分析（specs/028；specs/024 2026-11-22 修订）：两个详情端点额外接受可选
``level``（028 高亮档 ``liftoff…supernova``，非法 400）与可选 ``targetLang``
（缺省 ``zh-CN``，非法 400）。**只有显式传 ``level`` 才动分析**：

- 登录用户：缓存命中免费；未命中按既有 ``feature=analysis`` 配额/余额生成，
  失败静默跳过（不阻断播放）；
- 游客：只读全局分析缓存，**绝不生成**；未命中就保持「没有分析」；
- 不带 ``level``：行为与改动前完全一致（没有分析字段、不读分析表）。

为保持「读路径零导入依赖」，``teaching_analysis`` / ``ai_auth`` 在需要分析时
才延迟 import；普通读取仍然只读文件 → 校验 → JSON。错误语义：

- 400：``level`` / ``targetLang`` 非法；
- 404：id 形状非法、id 不存在、对应文件缺失；
- 503：清单/内容目录缺失，或某条内容字段损坏（宁可不发，也不把半条资源交给前端）。

``/api/library*`` 与 ``/api/blog*`` 同列在中间件的公开只读路径里：不创建游客身份、
不下发 Cookie，也不需要登录。
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

import config

logger = logging.getLogger("linguatrek.library")

router = APIRouter(tags=["library"])

MAX_ID_CHARS = 80
MAX_TITLE_CHARS = 300
MAX_CHANNEL_CHARS = 120
MAX_TEXT_CHARS = 4000
MAX_BLOCKS = 5000
MAX_PARAGRAPHS = 200
MAX_ENTRIES = 500
MIN_VIDEO_SECONDS = 60
MAX_VIDEO_SECONDS = 7200

LEVELS = frozenset({"A1", "A2", "B1", "B2", "C1", "C2"})
LEVEL_ORDER = ("A1", "A2", "B1", "B2", "C1", "C2")

_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
# 与内容脚本、前端列表里的词数口径保持一致。
_WORD_RE = re.compile(r"[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*")



class LibraryUnavailable(RuntimeError):
    """资源库内容不可用（目录/清单缺失或字段损坏），HTTP 503。"""

    status_code = 503


def library_dir() -> Path:
    return Path(config.LIBRARY_DIR)


def _bad(message: str) -> LibraryUnavailable:
    return LibraryUnavailable(message)


def _ensure(condition: bool, message: str) -> None:
    if not condition:
        raise _bad(message)


def _read_json(path: Path) -> dict:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise _bad(f"文件不存在：{path.name}") from exc
    except OSError as exc:
        raise _bad(f"读取 {path.name} 失败：{exc}") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise _bad(f"{path.name} 不是合法 JSON：{exc}") from exc
    _ensure(isinstance(data, dict), f"{path.name} 顶层必须是对象")
    return data


def _text(data: dict, key: str, *, limit: int, where: str) -> str:
    value = data.get(key)
    _ensure(isinstance(value, str) and bool(value.strip()), f"{where} 缺少 {key}")
    value = value.strip()
    _ensure(len(value) <= limit, f"{where} 的 {key} 过长")
    return value


def _level(data: dict, where: str) -> str:
    value = data.get("level")
    _ensure(isinstance(value, str) and value in LEVELS, f"{where} 的 level 必须是 A1–C2")
    return value


def _valid_id(value: Any) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= MAX_ID_CHARS
        and _ID_RE.fullmatch(value) is not None
    )


def _manifest(kind: str) -> list[str]:
    """读 ``videos.json`` / ``articles.json``，返回去重后的 id 清单。"""
    path = library_dir() / f"{kind}.json"
    if not path.is_file():
        raise _bad(f"{kind}.json 不存在")
    data = _read_json(path)
    raw = data.get(kind)
    _ensure(isinstance(raw, list), f"{kind}.json 缺少 {kind} 数组")
    _ensure(len(raw) <= MAX_ENTRIES, f"{kind}.json 条目过多")
    ids: list[str] = []
    seen: set[str] = set()
    for value in raw:
        _ensure(_valid_id(value), f"{kind}.json 含非法 id：{value!r}")
        _ensure(value not in seen, f"{kind}.json 含重复 id：{value}")
        seen.add(value)
        ids.append(value)
    return ids


def _entry_path(kind: str, entry_id: str) -> Path:
    """校验 id 形状后返回条目文件路径；不存在时 404（不暴露目录结构）。"""
    if not _valid_id(entry_id):
        raise HTTPException(status_code=404, detail="资源不存在。")
    path = library_dir() / kind / f"{entry_id}.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="资源不存在。")
    return path


def _load_entry(kind: str, entry_id: str) -> dict:
    path = _entry_path(kind, entry_id)
    try:
        data = _read_json(path)
    except LibraryUnavailable as exc:
        logger.warning("读取免费资源失败（%s/%s）：%s", kind, entry_id, exc)
        raise HTTPException(status_code=503, detail="资源内容损坏，暂时无法打开。") from exc
    return data


def _highlights(raw: Any, where: str) -> list[dict]:
    _ensure(isinstance(raw, list), f"{where} 的 highlights 必须是数组")
    _ensure(len(raw) <= 50, f"{where} 的 highlights 过多")
    result: list[dict] = []
    for item in raw:
        _ensure(isinstance(item, dict), f"{where} 的 highlights 项必须是对象")
        en_word = item.get("en_word")
        zh_word = item.get("zh_word")
        color = item.get("color")
        _ensure(
            isinstance(en_word, str)
            and en_word.strip()
            and isinstance(zh_word, str)
            and zh_word.strip()
            and isinstance(color, str)
            and color.strip(),
            f"{where} 的 highlights 项缺少 en_word/zh_word/color",
        )
        result.append(
            {"en_word": en_word.strip(), "zh_word": zh_word.strip(), "color": color.strip()}
        )
    return result


def _video(data: dict, entry_id: str) -> dict:
    where = f"视频 {entry_id}"
    _ensure(data.get("id") == entry_id, f"{where} 的 id 与文件不一致")
    youtube_id = data.get("youtubeId")
    _ensure(
        isinstance(youtube_id, str) and _YOUTUBE_ID_RE.fullmatch(youtube_id) is not None,
        f"{where} 的 youtubeId 非法",
    )
    duration = data.get("duration")
    _ensure(
        isinstance(duration, int)
        and not isinstance(duration, bool)
        and MIN_VIDEO_SECONDS <= duration <= MAX_VIDEO_SECONDS,
        f"{where} 的 duration 非法",
    )
    free = data.get("free")
    _ensure(free is True, f"{where} 必须标记 free: true")
    _ensure(data.get("source") == "youtube", f"{where} 的 source 必须是 youtube")

    blocks_raw = data.get("blocks")
    _ensure(isinstance(blocks_raw, list) and blocks_raw, f"{where} 缺少 blocks")
    _ensure(len(blocks_raw) <= MAX_BLOCKS, f"{where} 的 blocks 过多")
    blocks: list[dict] = []
    seen_ids: set[int] = set()
    for index, raw in enumerate(blocks_raw):
        block_where = f"{where} 第 {index + 1} 个 block"
        _ensure(isinstance(raw, dict), f"{block_where} 必须是对象")
        block_id = raw.get("id")
        _ensure(
            isinstance(block_id, int) and not isinstance(block_id, bool),
            f"{block_where} 的 id 必须是整数",
        )
        _ensure(block_id not in seen_ids, f"{block_where} 的 id 重复")
        seen_ids.add(block_id)
        start = raw.get("start")
        end = raw.get("end")
        _ensure(
            isinstance(start, (int, float)) and not isinstance(start, bool) and start >= 0,
            f"{block_where} 的 start 非法",
        )
        _ensure(
            isinstance(end, (int, float))
            and not isinstance(end, bool)
            and end >= start,
            f"{block_where} 的 end 非法",
        )
        en_text = _text(raw, "en_text", limit=MAX_TEXT_CHARS, where=block_where)
        zh_text = _text(raw, "zh_text", limit=MAX_TEXT_CHARS, where=block_where)
        blocks.append(
            {
                "id": block_id,
                "start": round(float(start), 3),
                "end": round(float(end), 3),
                "en_text": en_text,
                "zh_text": zh_text,
                "highlights": _highlights(raw.get("highlights", []), block_where),
            }
        )

    payload = {
        "id": entry_id,
        "youtubeId": youtube_id,
        "title": _text(data, "title", limit=MAX_TITLE_CHARS, where=where),
        "channel": _text(data, "channel", limit=MAX_CHANNEL_CHARS, where=where),
        "duration": duration,
        "level": _level(data, where),
        "free": True,
        "source": "youtube",
        "blocks": blocks,
    }
    for optional_key in ("thumbnail", "license", "subtitleSource"):
        value = data.get(optional_key)
        if isinstance(value, str) and value.strip():
            payload[optional_key] = value.strip()
    return payload


def _word_count(paragraphs: list[dict]) -> int:
    return sum(len(_WORD_RE.findall(paragraph["en"])) for paragraph in paragraphs)


def _article(data: dict, entry_id: str) -> dict:
    where = f"文章 {entry_id}"
    _ensure(data.get("id") == entry_id, f"{where} 的 id 与文件不一致")
    paragraphs_raw = data.get("paragraphs")
    _ensure(
        isinstance(paragraphs_raw, list) and paragraphs_raw, f"{where} 缺少 paragraphs"
    )
    _ensure(len(paragraphs_raw) <= MAX_PARAGRAPHS, f"{where} 的段落过多")
    paragraphs: list[dict] = []
    for index, raw in enumerate(paragraphs_raw):
        paragraph_where = f"{where} 第 {index + 1} 段"
        _ensure(isinstance(raw, dict), f"{paragraph_where} 必须是对象")
        paragraphs.append(
            {
                "en": _text(raw, "en", limit=MAX_TEXT_CHARS, where=paragraph_where),
                "zh": _text(raw, "zh", limit=MAX_TEXT_CHARS, where=paragraph_where),
            }
        )

    payload = {
        "id": entry_id,
        "title": _text(data, "title", limit=MAX_TITLE_CHARS, where=where),
        "level": _level(data, where),
        "wordCount": _word_count(paragraphs),
        "author": _text(data, "author", limit=MAX_CHANNEL_CHARS, where=where),
        "license": _text(data, "license", limit=MAX_TITLE_CHARS, where=where),
        "paragraphs": paragraphs,
    }
    for optional_key in ("topic", "summary"):
        value = data.get(optional_key)
        if isinstance(value, str) and value.strip():
            payload[optional_key] = value.strip()
    # 来源与公版出处：原创文章 = original；Gutenberg 短篇 = public-domain。
    # 只回传白名单里的字段，避免把任意 JSON 原样透出给前端。
    source = data.get("source")
    if source in ("original", "public-domain"):
        payload["source"] = source
    gutenberg_id = data.get("gutenbergId")
    if isinstance(gutenberg_id, int) and not isinstance(gutenberg_id, bool) and gutenberg_id > 0:
        payload["gutenbergId"] = gutenberg_id
    for optional_key in ("sourceUrl", "publicDomainBasis"):
        value = data.get(optional_key)
        if isinstance(value, str) and value.strip():
            payload[optional_key] = value.strip()
    if data.get("free") is True:
        payload["free"] = True
    return payload


def _video_summary(video: dict) -> dict:
    return {
        "id": video["id"],
        "title": video["title"],
        "channel": video["channel"],
        "duration": video["duration"],
        "level": video["level"],
    }


def _article_summary(article: dict) -> dict:
    return {
        "id": article["id"],
        "title": article["title"],
        "level": article["level"],
        "wordCount": article["wordCount"],
    }


# ---------------------------------------------------------------------------
# 教学分析（specs/028；specs/024 2026-11-22 修订）
# ---------------------------------------------------------------------------

def analysis_blocks(kind: str, payload: dict) -> list[dict]:
    """payload → 教学分析输入的 block 视图（预热脚本复用同一口径）。

    视频直接用预生成的 ``blocks``（``id/en_text/zh_text`` 已经齐全）；文章段落
    JSON 只有 ``{en, zh}``，这里按 **0 起段落下标** 补 ``id``——与阅读器
    ``paragraphs[].idx`` 同口径，``idioms``/``culture`` 的 ``blockId`` 也用它。
    传给 analysis 时字段名转换成 ``en_text/zh_text``（``normalize_blocks`` 也接受
    ``en/zh``，但统一成字幕块形状便于合并高亮）。
    """
    if kind == "videos":
        blocks = payload.get("blocks")
        if not isinstance(blocks, list):
            return []
        return [block for block in blocks if isinstance(block, dict)]
    paragraphs = payload.get("paragraphs")
    if not isinstance(paragraphs, list):
        return []
    blocks: list[dict] = []
    for index, paragraph in enumerate(paragraphs):
        if not isinstance(paragraph, dict):
            continue
        blocks.append(
            {
                "id": index,
                "en_text": paragraph.get("en") or "",
                "zh_text": paragraph.get("zh") or "",
            }
        )
    return blocks


def load_payload(kind: str, entry_id: str) -> dict:
    """读并校验一条资源，返回与详情端点同形的 payload（详情端点与预热脚本共用）。"""
    data = _load_entry(kind, entry_id)
    try:
        return _video(data, entry_id) if kind == "videos" else _article(data, entry_id)
    except LibraryUnavailable as exc:
        is_video = kind == "videos"
        label = "视频" if is_video else "文章"
        logger.warning("校验免费%s失败（%s）：%s", label, entry_id, exc)
        raise HTTPException(
            status_code=503,
            detail=f"{label}内容损坏，暂时无法打开。",
        ) from exc


def _analysis_params(
    level: str | None, target_lang: str | None
) -> tuple[str | None, str | None]:
    """解析可选的 ``level`` / ``targetLang``；非法值 400（与 specs/028 同枚举）。

    - 两个参数都没给：返回 ``(None, None)``，读路径保持完全不变；
    - ``level`` 为空串按「没传」处理（不触发分析）；
    - ``targetLang`` 缺省为 ``zh-CN``（``languages.resolve_target_lang`` 口径）。
    """
    if level is None and target_lang is None:
        return None, None
    import teaching_analysis  # 延迟 import：普通读取不引入分析/数据库依赖

    try:
        canonical_level = None
        if isinstance(level, str) and level.strip():
            canonical_level = teaching_analysis.normalize_level(level)
        lang = teaching_analysis.canonical_target_lang(target_lang)
    except teaching_analysis.AnalysisInvalidRequest as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return canonical_level, lang


def _private_json(payload: dict) -> JSONResponse:
    """带分析的响应不进入共享缓存：同 URL 对游客/登录用户返回形状不同。"""
    return JSONResponse(content=payload, headers={"Cache-Control": "private, no-store"})


async def _attach_analysis(
    payload: dict,
    *,
    kind: str,
    entry_id: str,
    level: str,
    target_lang: str,
    request: Request,
) -> dict:
    """把当前档位/语言的教学分析合并进 payload（失败静默，绝不阻断读取）。

    - 登录用户走 ``attach_to_payload``：缓存命中零模型调用；未命中按
      ``feature=analysis`` 配额/余额生成，失败/超限都不报错（只是没有分析）；
    - 游客走 ``attach_cached_to_payload``：只读全局缓存，不调模型、不占配额。
    """
    import ai_auth
    import teaching_analysis

    blocks = analysis_blocks(kind, payload)
    if not blocks:
        return payload
    wrapper = {"transcript": blocks}
    user = ai_auth.ai_user(request)
    unavailable: dict = {}
    if user is not None:
        analysis = await teaching_analysis.attach_to_payload(
            wrapper,
            level=level,
            target_lang=target_lang,
            content_ref=f"library:{entry_id}",
            user_id=str(user["id"]),
            unavailable_out=unavailable,
        )
    else:
        try:
            analysis = teaching_analysis.attach_cached_to_payload(
                wrapper, level=level, target_lang=target_lang
            )
        except teaching_analysis.TeachingAnalysisError as exc:
            # 分析是增强：0020 表缺失/坏行不影响免费资源读取。
            logger.warning("免费资源分析缓存读取失败（%s）：%s", entry_id, exc)
            analysis = None
    if analysis is None:
        # P0-04：登录用户的生成失败原因可见（游客是「缓存未命中」而非失败）。
        payload.update(unavailable)
        return payload
    if wrapper.get("analysisVersion") != teaching_analysis.ANALYSIS_VERSION:
        # 版本闸：旧版本分析不得混进当前 payload。
        return payload

    if kind == "articles":
        # 分析块是「段落下标 + en_text/zh_text」的视图，高亮要写回段落本体。
        paragraphs = payload.get("paragraphs") or []
        for block in blocks:
            index = block.get("id")
            if isinstance(index, int) and 0 <= index < len(paragraphs):
                paragraphs[index]["highlights"] = block.get("highlights") or []

    payload["idioms"] = wrapper.get("idioms") or []
    payload["culture"] = wrapper.get("culture") or []
    payload["analysisVersion"] = teaching_analysis.ANALYSIS_VERSION
    payload["analysisLevel"] = analysis.get("level") or level
    return payload


def _load_videos(ids: list[str]) -> list[dict]:
    videos = []
    for entry_id in ids:
        try:
            path = _entry_path("videos", entry_id)
            data = _read_json(path)
            videos.append(_video(data, entry_id))
        except HTTPException:
            raise
        except LibraryUnavailable as exc:
            logger.warning("读取免费视频失败（%s）：%s", entry_id, exc)
            raise _bad(f"视频 {entry_id} 内容损坏：{exc}") from exc
    return videos


def _load_articles(ids: list[str]) -> list[dict]:
    articles = []
    for entry_id in ids:
        try:
            path = _entry_path("articles", entry_id)
            data = _read_json(path)
            articles.append(_article(data, entry_id))
        except HTTPException:
            raise
        except LibraryUnavailable as exc:
            logger.warning("读取免费文章失败（%s）：%s", entry_id, exc)
            raise _bad(f"文章 {entry_id} 内容损坏：{exc}") from exc
    return articles


def _json(payload: dict, *, max_age: int) -> JSONResponse:
    return JSONResponse(
        content=payload,
        headers={"Cache-Control": f"public, max-age={max_age}"},
    )


@router.get("/api/library")
def get_library():
    """首页「免费资源」清单；公开、无需登录、不调用模型。"""
    try:
        videos = _load_videos(_manifest("videos"))
        articles = _load_articles(_manifest("articles"))
    except LibraryUnavailable as exc:
        logger.warning("读取免费资源库失败：%s", exc)
        raise HTTPException(status_code=503, detail="免费资源库暂时不可用。") from exc
    video_summaries = [_video_summary(video) for video in videos]
    article_summaries = [_article_summary(article) for article in articles]
    # 等级分布由后端算，前端筛选 chips 直接显示数量，避免两端各算一遍。
    video_levels = {level: 0 for level in LEVEL_ORDER}
    for video in video_summaries:
        video_levels[video["level"]] = video_levels.get(video["level"], 0) + 1
    return _json(
        {
            "videos": video_summaries,
            "articles": article_summaries,
            "counts": {"videos": len(video_summaries), "articles": len(article_summaries)},
            "videoLevels": video_levels,
        },
        max_age=300,
    )


@router.get("/api/library/videos/{video_id}")
async def get_library_video(
    video_id: str,
    request: Request,
    level: str | None = None,
    targetLang: str | None = None,
):
    """单个视频：元数据 + 预生成双语字幕块；公开、无需登录。

    显式传 ``level`` 时附带教学分析（登录按需生成、游客只读缓存）；不带
    ``level`` 时行为与改动前完全一致（不读分析表、不调模型）。
    """
    analysis_level, target_lang = _analysis_params(level, targetLang)
    payload = load_payload("videos", video_id)
    if analysis_level is None:
        return _json(payload, max_age=3600)
    payload = await _attach_analysis(
        payload,
        kind="videos",
        entry_id=video_id,
        level=analysis_level,
        target_lang=target_lang or "zh-CN",
        request=request,
    )
    return _private_json(payload)


@router.get("/api/library/articles/{article_id}")
async def get_library_article(
    article_id: str,
    request: Request,
    level: str | None = None,
    targetLang: str | None = None,
):
    """单篇文章：标题 + 逐段中英 + 等级；公开、无需登录。

    显式传 ``level`` 时附带教学分析（登录按需生成、游客只读缓存）；分析高亮
    写在 ``paragraphs[].highlights``，``idioms``/``culture`` 在 payload 顶层。
    """
    analysis_level, target_lang = _analysis_params(level, targetLang)
    payload = load_payload("articles", article_id)
    if analysis_level is None:
        return _json(payload, max_age=3600)
    payload = await _attach_analysis(
        payload,
        kind="articles",
        entry_id=article_id,
        level=analysis_level,
        target_lang=target_lang or "zh-CN",
        request=request,
    )
    return _private_json(payload)
