"""按能力画像推荐人工精选内容（用户需求 #10 / 计划书 V1 规则推荐，specs/018）。

这是一个**不调用 LLM** 的规则推荐器：

    画像（user_profiles 的 CEFR 区间；无画像默认 A2–B1）
      + 已看历史（当前用户/游客 history 缓存里的 videoId、频道、标题）
      + 人工精选池（content/curated.json，30 条真实 YouTube 视频）
      → 难度 band±1 内优先、同主题去重、排除已学/已缓存
      → 按「难度接近度 + 主题多样性 + 新鲜度」排序
      → 每条附一句人话理由（中文 / 越南语）
      → 10 分钟进程内缓存 + HTTP Cache-Control

边界（与任务要求一致）：

- 只读 ``content/curated.json`` 与本地 history 缓存，不联网、不下载、不调模型；
- **不新建表、不新增迁移**：画像直接读 M4 的 ``user_profiles``（表缺失时按无
  画像处理，返回默认区间，不影响推荐可用性）；
- 游客**不使用**游客自己的定位测画像，一律默认 A2–B1（任务口径）；登录用户
  才读画像；
- 排除规则只按 videoId：已缓存/已学过的视频不再返回；频道只用于推断「你最近
  在看什么类」，不作为排除条件（否则一个频道只能看一次，太粗暴）；
- 题目要的 ``preliminary`` 沿用定位测的样本口径：无画像或样本 <100 时为 true。
- **M2（specs/026）**：优先读 ``content_difficulty`` 的 ``cefrInput`` 做
  ``match_score``（词汇带接近度 + 支持度）；无难度行时完全回退旧的
  ``level_distance`` 规则；理由不得出现「个性化」一词。

排序细节见 ``select_items``：先按难度距离分层（精确区间 → 相邻 ±1），层内做
主题轮转（每轮每个主题最多取 1 条、每主题总上限 2 条），同主题内按发布时间
从新到旧；``seed`` 只做确定性轮转，支持前端「换一批」。
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

import config
import difficulty
import languages
import placement
import storage

logger = logging.getLogger("linguatrek.recommend")

CEFR_LEVELS = ("A1", "A2", "B1", "B2", "C1")
LEVEL_INDEX = {level: index for index, level in enumerate(CEFR_LEVELS)}
DEFAULT_BAND = ("A2", "B1")
DEFAULT_LIMIT = 6
MAX_LIMIT = 12
MAX_PER_TOPIC = 2
RESULT_CACHE_TTL_SECONDS = 10 * 60
RESULT_CACHE_MAX = 256
CONTENT_NOTICE_MARKER = "待运营复核"
# 内容供给 gate（计划书 §4.8 / §6.4）：可推荐内容 <100 条时不开 match_v0 评分，
# 回退旧的 level_distance + 发布时间规则；不报匹配指标、不写「个性化」。
SUPPLY_GATE_MIN = 100

# history 根目录里的元数据文件（与 routes_videos.HISTORY_META_FILES 同口径；
# 这里不 import 路由模块，避免领域模块反向依赖 HTTP 层）。
_HISTORY_META_FILES = {
    "favorites.json",
    "subscriptions.json",
    "dictionary_cache.json",
}

_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# 主题的界面名（推荐理由用）。内容闸门限定只能取这几个 key，避免运营新增
# 主题时越南语理由混入中文。
TOPIC_LABELS: dict[str, dict[str, str]] = {
    "technology": {"zh-CN": "科技", "vi-VN": "công nghệ"},
    "business": {"zh-CN": "商业", "vi-VN": "kinh doanh"},
    "psychology": {"zh-CN": "心理", "vi-VN": "tâm lý"},
    "culture": {"zh-CN": "文化", "vi-VN": "văn hóa"},
    "environment": {"zh-CN": "环境", "vi-VN": "môi trường"},
}

# 只用于「用户最近在看什么」的轻量关键词推断，不参与内容难度/排序。
# 频道名/标题很小，匹配失败就只给难度理由，不影响推荐本身。
_TOPIC_KEYWORDS: dict[str, tuple[str, ...]] = {
    "technology": (
        "technology", "tech", "artificial intelligence", "computer", "internet",
        "robot", "software", "smartphone", "digital", "algorithm",
        "machine learning", "chatgpt", "online",
    ),
    "business": (
        "business", "economy", "economic", "finance", "financial", "market",
        "startup", "company", "money", "tax", "trade", "invest", "bank",
        "entrepreneur", "gdp", "tariff",
    ),
    "psychology": (
        "psychology", "psychological", "brain", "mind", "sleep", "stress",
        "habit", "procrastinat", "mental", "emotion", "personality",
        "happiness", "anxiety", "relationship",
    ),
    "culture": (
        "culture", "cultural", "language", "history", "food", "travel",
        "music", "tradition", "bilingual", "linguistic", "english",
    ),
    "environment": (
        "climate", "environment", "environmental", "energy", "nature",
        "planet", "earth", "pollution", "wildlife", "sustainab", "carbon",
        "ocean", "recycl",
    ),
}


class RecommendationUnavailable(RuntimeError):
    """精选内容缺失/损坏（HTTP 503，与定位测题库同一种错误语义）。"""

    status_code = 503

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


@dataclass(frozen=True)
class Watched:
    """当前用户/游客的已看历史（推荐只需要这三个维度）。"""

    video_ids: frozenset[str] = frozenset()
    channels: frozenset[str] = frozenset()
    topics: tuple[str, ...] = ()

    def fingerprint(self) -> str:
        """缓存键的一部分：历史变了，10 分钟缓存自动失效。"""
        material = "\x1f".join(
            [
                *sorted(self.video_ids),
                *sorted(self.channels),
                *self.topics,
            ]
        )
        return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# 无状态的静态池 / 缓存容器
# ---------------------------------------------------------------------------

_catalog_cache: dict[str, tuple[tuple[int, int], dict]] = {}
_result_cache: OrderedDict[str, tuple[float, dict]] = OrderedDict()
_history_cache: OrderedDict[str, tuple[tuple, Watched]] = OrderedDict()
_cache_lock = threading.Lock()


def reset_cache() -> None:
    """清空进程内缓存（测试隔离；运维改了 content/curated.json 也可手动调）。"""
    with _cache_lock:
        _catalog_cache.clear()
        _result_cache.clear()
        _history_cache.clear()


def _cache_get(key: str) -> dict | None:
    now = time.time()
    with _cache_lock:
        entry = _result_cache.get(key)
        if entry is None:
            return None
        expires_at, payload = entry
        if expires_at <= now:
            _result_cache.pop(key, None)
            return None
        _result_cache.move_to_end(key)
        return payload


def _cache_put(key: str, payload: dict) -> None:
    with _cache_lock:
        _result_cache[key] = (time.time() + RESULT_CACHE_TTL_SECONDS, payload)
        _result_cache.move_to_end(key)
        while len(_result_cache) > RESULT_CACHE_MAX:
            _result_cache.popitem(last=False)


# ---------------------------------------------------------------------------
# 精选池加载 + 内容闸门
# ---------------------------------------------------------------------------

def curated_path() -> str:
    return os.path.abspath(getattr(config, "CURATED_CONTENT_PATH", ""))


def _bad(message: str) -> RecommendationUnavailable:
    return RecommendationUnavailable(f"推荐内容不可用：{message}（content/curated.json）")


def _require_text(raw: Any, field: str, *, limit: int = 300) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise _bad(f"字段 {field} 必须是非空字符串")
    text = raw.strip()
    if len(text) > limit:
        raise _bad(f"字段 {field} 超过 {limit} 字符")
    return text


def _validate_catalog(raw: Any, path: str) -> dict:
    """校验精选池；坏内容宁可 503，也不把假/缺字段的视频推给用户。"""
    if not isinstance(raw, dict):
        raise _bad(f"{path} 顶层必须是 JSON 对象")
    meta = raw.get("_meta")
    if not isinstance(meta, dict):
        raise _bad("缺少 _meta")
    notice = meta.get("notice")
    if not isinstance(notice, str) or CONTENT_NOTICE_MARKER not in notice:
        raise _bad(f"_meta.notice 必须标注「{CONTENT_NOTICE_MARKER}」")

    raw_items = raw.get("items")
    if not isinstance(raw_items, list):
        raise _bad("items 必须是数组")

    items: list[dict] = []
    seen: set[str] = set()
    for index, entry in enumerate(raw_items):
        if not isinstance(entry, dict):
            raise _bad(f"items[{index}] 必须是对象")
        video_id = _require_text(entry.get("videoId"), f"items[{index}].videoId", limit=11)
        if not _VIDEO_ID_RE.fullmatch(video_id):
            raise _bad(f"items[{index}].videoId 不是合法的 11 位 YouTube id")
        if video_id in seen:
            raise _bad(f"videoId 重复：{video_id}")
        seen.add(video_id)

        title = _require_text(entry.get("title"), f"items[{index}].title", limit=200)
        channel = _require_text(entry.get("channel"), f"items[{index}].channel", limit=120)
        duration = entry.get("duration")
        if isinstance(duration, bool) or not isinstance(duration, int):
            raise _bad(f"items[{index}].duration 必须是整数秒")
        if not (180 <= duration <= 2400):
            raise _bad(f"items[{index}].duration 不在 3–40 分钟范围：{duration}")

        thumbnail = _require_text(
            entry.get("thumbnail"), f"items[{index}].thumbnail", limit=300
        )
        expected_prefix = f"https://i.ytimg.com/vi/{video_id}/"
        if not thumbnail.startswith(expected_prefix):
            raise _bad(f"items[{index}].thumbnail 必须指向该 videoId 的 ytimg 地址")

        topic = entry.get("topic")
        if topic not in TOPIC_LABELS:
            raise _bad(f"items[{index}].topic 不在允许的主题集合里：{topic!r}")
        level = entry.get("level")
        if level not in LEVEL_INDEX:
            raise _bad(f"items[{index}].level 不是 A1–C1：{level!r}")
        reason = _require_text(entry.get("reason"), f"items[{index}].reason", limit=200)

        published_at = entry.get("publishedAt")
        if published_at is None:
            published_at = "1970-01-01"
        if not isinstance(published_at, str) or not _ISO_DATE_RE.fullmatch(published_at):
            raise _bad(f"items[{index}].publishedAt 必须是 YYYY-MM-DD")

        items.append(
            {
                "videoId": video_id,
                "title": title,
                "channel": channel,
                "duration": duration,
                "thumbnail": thumbnail,
                "topic": topic,
                "level": level,
                "publishedAt": published_at,
                "reason": reason,
            }
        )

    count = meta.get("count")
    if count is not None and count != len(items):
        raise _bad(f"_meta.count={count!r} 与 items 数量 {len(items)} 不一致")

    return {"meta": meta, "items": items}


def load_catalog(path: str | None = None) -> dict:
    """读取并校验精选池；按文件 mtime/size 缓存，内容坏了直接 503。"""
    target = os.path.abspath(path or curated_path())
    try:
        stat = os.stat(target)
    except OSError as exc:
        raise RecommendationUnavailable(
            f"推荐内容文件不存在：{target}（content/curated.json 应随仓库分发）"
        ) from exc
    signature = (stat.st_mtime_ns, stat.st_size)
    with _cache_lock:
        cached = _catalog_cache.get(target)
        if cached is not None and cached[0] == signature:
            return cached[1]
    try:
        with open(target, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError) as exc:
        raise _bad(f"无法解析 {target}：{exc}") from exc
    catalog = _validate_catalog(raw, target)
    with _cache_lock:
        _catalog_cache[target] = (signature, catalog)
    return catalog


# ---------------------------------------------------------------------------
# 画像 → CEFR 区间
# ---------------------------------------------------------------------------

def normalize_band(low: Any, high: Any) -> tuple[str, str] | None:
    """把画像的上下带规范成 (low, high)；非法/缺失返回 None。"""
    if low not in LEVEL_INDEX or high not in LEVEL_INDEX:
        return None
    if LEVEL_INDEX[low] > LEVEL_INDEX[high]:
        return high, low
    return low, high


def band_label(band: tuple[str, str]) -> str:
    """界面/响应里的区间标签，例如 ``A2–B1``（en dash，与定位测一致）。"""
    return f"{band[0]}–{band[1]}"


def level_distance(level: str, band: tuple[str, str]) -> int:
    """难度带距离：区间内 0，相邻一档 1，更远 2。"""
    index = LEVEL_INDEX[level]
    low = LEVEL_INDEX[band[0]]
    high = LEVEL_INDEX[band[1]]
    if low <= index <= high:
        return 0
    if index < low:
        return low - index
    return index - high


# C1+ 不在编辑等级枚举里；按「比 C1 高半档」处理成 5（仅用于距离/排序）。
_CONTENT_INDEX = {**LEVEL_INDEX, "C1+": len(LEVEL_INDEX)}


def content_band_distance(content_level: str | None, band: tuple[str, str]) -> int | None:
    """内容 ``cefrInput`` 与用户区间的距离（c1+ 视为 C1 之上）。"""
    if not isinstance(content_level, str) or content_level not in _CONTENT_INDEX:
        return None
    index = _CONTENT_INDEX[content_level]
    low = LEVEL_INDEX[band[0]]
    high = LEVEL_INDEX[band[1]]
    if low <= index <= high:
        return 0
    if index < low:
        return low - index
    return index - high


def match_score(distance: int | None, support: object = None) -> float:
    """M2 ``match_v0``：词汇带接近度 0.7 + 支持度 0.3（计划书 §6.4）。

    距离 0/1/2/更远 → 1.0 / 0.75 / 0.45 / 0.2；支持度见
    ``difficulty.score_support``。无难度数据时调用方回退旧规则，不调用本函数。
    """
    if distance is None:
        return 0.0
    lexical_fit = {0: 1.0, 1: 0.75, 2: 0.45}.get(distance, 0.2)
    support_fit = difficulty.score_support(support if isinstance(support, dict) else None)
    return round(0.7 * lexical_fit + 0.3 * support_fit, 4)


def _ability_band(identity: str) -> tuple[tuple[str, str], bool] | None:
    """M2：优先读 ``user_skill_profiles`` 的词汇带（新表），失败返回 None。"""
    try:
        import ability  # 延迟 import：推荐模块不因能力模块缺失而整体不可用

        payload = ability.profile(identity)
    except Exception as exc:  # noqa: BLE001 - 推荐必须比能力档案更宽容
        logger.debug("推荐读取新表词汇带失败：%s", exc)
        return None
    vocabulary = payload.get("vocabulary") if isinstance(payload, dict) else None
    if not isinstance(vocabulary, dict):
        return None
    band = normalize_band(vocabulary.get("low"), vocabulary.get("high"))
    if band is None:
        # 种子画像不出带（v1.1 D8-2）：用点估计当单档带，且 LEVEL_INDEX 只有
        # A1–C1，C2 点会被挡在外面——不再把用户推回默认 A2–B1。
        point = vocabulary.get("cefr")
        if isinstance(point, str) and point in LEVEL_INDEX:
            band = (point, point)
        else:
            return None
    return band, bool(payload.get("preliminary", True))


def profile_band(
    identity: str | None, *, is_guest: bool = False
) -> tuple[tuple[str, str] | None, bool]:
    """读登录用户的画像区间；游客/无画像/表未迁移一律返回 (None, True)。

    M2 优先读新表 ``user_skill_profiles``（词汇带），再回退定位测旧快照；
    推荐不能因为库没迁移就整体 503：默认区间是有意设计的降级路径。
    """
    if is_guest or not identity:
        return None, True
    ability_band = _ability_band(identity)
    if ability_band is not None:
        return ability_band
    try:
        payload = placement.get_profile(identity)
    except Exception as exc:  # noqa: BLE001 - 推荐必须比定位测更宽容
        logger.info("推荐读取能力画像失败，按默认区间处理：%s", exc)
        return None, True
    profile = payload.get("profile") if isinstance(payload, dict) else None
    if not isinstance(profile, dict):
        return None, True
    band = normalize_band(profile.get("levelBandLow"), profile.get("levelBandHigh"))
    if band is None:
        return None, True
    preliminary = bool(payload.get("preliminary", True))
    return band, preliminary


# ---------------------------------------------------------------------------
# 已看历史（只读 history 缓存元数据）
# ---------------------------------------------------------------------------

def _infer_topic(
    video_id: str | None,
    title: str | None,
    channel: str | None,
    by_video: dict[str, str],
    channel_topics: dict[str, set[str]],
) -> str | None:
    if video_id and video_id in by_video:
        return by_video[video_id]
    text = f"{title or ''} {channel or ''}".lower()
    for topic, keywords in _TOPIC_KEYWORDS.items():
        if any(keyword in text for keyword in keywords):
            return topic
    if channel and len(channel_topics.get(channel, set())) == 1:
        return next(iter(channel_topics[channel]))
    return None


def _history_signature(root: str) -> tuple[tuple[str, int, int], ...]:
    entries: list[tuple[str, int, int]] = []
    try:
        with os.scandir(root) as iterator:
            for entry in iterator:
                if entry.name in _HISTORY_META_FILES or not entry.name.endswith(".json"):
                    continue
                try:
                    if not entry.is_file():
                        continue
                    stat = entry.stat()
                except OSError:
                    continue
                entries.append((entry.name, stat.st_mtime_ns, stat.st_size))
    except OSError:
        return ()
    entries.sort()
    return tuple(entries)


def read_watched(target_lang: str, items: list[dict]) -> Watched:
    """扫描当前身份/目标语言的 history 目录，提取 videoId、频道、最近主题。

    只读元数据；目录签名（文件名+mtime+size）没变时复用上次结果，避免每次
    推荐都解析一遍可能很大的字幕 JSON。
    """
    root = storage.history_dir(target_lang)
    signature = _history_signature(root)
    cache_key = os.path.abspath(root)
    with _cache_lock:
        cached = _history_cache.get(cache_key)
        if cached is not None and cached[0] == signature:
            _history_cache.move_to_end(cache_key)
            return cached[1]

    by_video = {item["videoId"]: item["topic"] for item in items}
    channel_topics: dict[str, set[str]] = {}
    for item in items:
        channel_topics.setdefault(item["channel"], set()).add(item["topic"])

    video_ids: set[str] = set()
    channels: set[str] = set()
    topics: list[str] = []
    # 新文件在前：最近看的主题优先。
    for name, _mtime, _size in sorted(signature, key=lambda row: row[1], reverse=True):
        path = os.path.join(root, name)
        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, ValueError) as exc:
            logger.debug("推荐跳过损坏的 history 文件 %s：%s", name, exc)
            continue
        if not isinstance(data, dict):
            continue
        metadata = data.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
        video_id = data.get("videoId") or metadata.get("videoId")
        if video_id is None:
            video_id = metadata.get("youtube_video_id")
        if not isinstance(video_id, str) or not _VIDEO_ID_RE.fullmatch(video_id):
            video_id = None
        if video_id:
            video_ids.add(video_id)
            # 本地剧集缓存也可能带频道/标题，能推出主题就推。
            if video_id in by_video:
                topic = by_video[video_id]
            else:
                topic = _infer_topic(
                    video_id,
                    metadata.get("title"),
                    metadata.get("channel"),
                    by_video,
                    channel_topics,
                )
        else:
            topic = None
        channel = metadata.get("channel") or data.get("channel")
        if isinstance(channel, str) and channel.strip():
            channels.add(channel.strip())
        if topic is None:
            topic = _infer_topic(
                None,
                metadata.get("title"),
                channel if isinstance(channel, str) else None,
                by_video,
                channel_topics,
            )
        if topic and topic not in topics:
            topics.append(topic)

    watched = Watched(
        video_ids=frozenset(video_ids),
        channels=frozenset(channels),
        topics=tuple(topics),
    )
    with _cache_lock:
        _history_cache[cache_key] = (signature, watched)
        _history_cache.move_to_end(cache_key)
        while len(_history_cache) > 64:
            _history_cache.popitem(last=False)
    return watched


# ---------------------------------------------------------------------------
# 规则排序
# ---------------------------------------------------------------------------

def _rotate(entries: list[Any], seed: int) -> list[Any]:
    if not entries:
        return []
    offset = seed % len(entries)
    return entries[offset:] + entries[:offset]


def supply_gate_state() -> dict[str, Any]:
    """当前内容供给 gate：只统计 video/article/curated 里 cefr_input 非空的行。

    返回 ``{"eligible": int, "byKind": {...}, "threshold": 100, "open": bool}``。
    查询失败/表未迁移 → eligible=0、gate 关闭（回退旧规则）。
    """
    counts = difficulty.count_eligible_by_kind(difficulty.RECOMMENDABLE_KINDS)
    by_kind = {kind: int(counts.get(kind, 0)) for kind in difficulty.RECOMMENDABLE_KINDS}
    eligible = sum(by_kind.values())
    return {
        "eligible": eligible,
        "byKind": by_kind,
        "threshold": SUPPLY_GATE_MIN,
        "open": eligible >= SUPPLY_GATE_MIN,
    }


def _load_difficulties(items: list[dict]) -> dict[str, dict]:
    """批量读 curated 视频的 content_difficulty 行；无行/未迁移返回空。"""
    refs = [item["videoId"] for item in items if isinstance(item.get("videoId"), str)]
    rows = difficulty.get_rows([("curated", ref) for ref in refs])
    return {ref: row for (kind, ref), row in rows.items() if kind == "curated"}


def _difficulty_fingerprint(difficulties: dict[str, dict]) -> str:
    material = "\x1f".join(
        f"{ref}:{row.get('cefrInput')}:{row.get('confidence')}"
        for ref, row in sorted(difficulties.items())
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def select_items(
    items: list[dict],
    band: tuple[str, str],
    *,
    watched_video_ids: frozenset[str] | set[str] = frozenset(),
    favorite_topics: tuple[str, ...] = (),
    limit: int = DEFAULT_LIMIT,
    seed: int = 0,
    difficulties: dict[str, dict] | None = None,
) -> list[dict]:
    """按难度接近度 + 主题多样性 + 新鲜度选 0–limit 条（纯函数，便于测试）。

    1. 先排除已缓存 videoId，只保留 band±1 内的候选；
    2. **有 content_difficulty**：距离用 ``cefrInput``、层内按 ``match_score``
       排序（词汇带接近度 0.7 + 支持度 0.3）；无难度行时完全用旧的
       ``level_distance`` + 发布时间规则；
    3. 两层都做主题轮转：每轮每个主题最多取 1 条、每主题总数最多 2 条；
    4. 同层内先按分数、再按 ``publishedAt`` 新→旧；``seed`` 做确定性轮转。
    """
    if limit <= 0:
        return []
    difficulties = difficulties or {}
    grouped: dict[tuple[int, str], list[tuple[dict, float]]] = {}
    for item in items:
        if item.get("videoId") in watched_video_ids:
            continue
        row = difficulties.get(item.get("videoId"))
        content_level = (row or {}).get("cefrInput")
        content_distance = content_band_distance(content_level, band)
        if content_distance is not None:
            distance = content_distance
            score = match_score(content_distance, (row or {}).get("support"))
        else:
            distance = level_distance(item["level"], band)
            score = 1.0 - 0.2 * distance
        if distance > 1:
            continue
        grouped.setdefault((distance, item["topic"]), []).append((item, score))
    for candidates in grouped.values():
        # 先按日期倒序，再按分数稳定排序：同分时新内容在前。
        candidates.sort(key=lambda pair: pair[0].get("publishedAt") or "", reverse=True)
        candidates.sort(key=lambda pair: pair[1], reverse=True)

    # 主题排序：用户最近看的主题优先，其余按精选池里第一次出现的顺序。
    first_seen: dict[str, int] = {}
    for order, item in enumerate(items):
        first_seen.setdefault(item["topic"], order)
    topic_order = sorted(
        first_seen,
        key=lambda topic: (
            0 if topic in favorite_topics else 1,
            first_seen[topic],
        ),
    )
    if seed:
        topic_order = _rotate(topic_order, seed)

    selected: list[dict] = []
    topic_counts: dict[str, int] = {}
    for distance in (0, 1):
        positions: dict[str, int] = {}
        for topic in topic_order:
            candidates = grouped.get((distance, topic), [])
            if seed:
                candidates = _rotate(candidates, seed)
            grouped[(distance, topic)] = candidates
            positions[topic] = 0
        for _round in range(MAX_PER_TOPIC):
            for topic in topic_order:
                if len(selected) >= limit:
                    break
                if topic_counts.get(topic, 0) >= MAX_PER_TOPIC:
                    continue
                candidates = grouped.get((distance, topic), [])
                position = positions.get(topic, 0)
                if position >= len(candidates):
                    continue
                item = candidates[position][0]
                positions[topic] = position + 1
                selected.append(item)
                topic_counts[topic] = topic_counts.get(topic, 0) + 1
            if len(selected) >= limit:
                break
        if len(selected) >= limit:
            break
    return selected


# ---------------------------------------------------------------------------
# 推荐理由
# ---------------------------------------------------------------------------

def _reason(
    item: dict,
    *,
    band: tuple[str, str],
    source: str,
    distance: int,
    recent_topic: str | None,
    target_lang: str,
    difficulty_row: dict | None = None,
) -> str:
    """一句人话理由；有难度数据时用「与你当前词汇区间接近」+ 估算生词桶。"""
    topic = item["topic"]
    content_level = (difficulty_row or {}).get("cefrInput")
    bucket = None
    if difficulty_row:
        # utr_band = 高于用户整个区间（取高带）的词占比，与 K17 的「带级量」
        # 和 3.5% 目标口径一致；用低带会把所有真实内容都算成 >8%。
        rate = difficulty.utr_band_for(
            (difficulty_row or {}).get("features"), band[1]
        )
        bucket = difficulty.novelty_bucket(rate)

    if target_lang == "vi-VN":
        if content_level:
            base = f"Gần với khoảng từ vựng hiện tại của bạn"
            base += f" (nội dung {content_level}"
            if bucket:
                base += f"; ước tính khoảng {bucket} từ mới"
            base += f" theo trình độ {band_label(band)})"
        elif source == "profile":
            if distance == 0:
                base = f"Phù hợp với trình độ {item['level']} của bạn"
            elif LEVEL_INDEX[item["level"]] < LEVEL_INDEX[band[0]]:
                base = (
                    f"Dễ hơn một chút so với khoảng {band_label(band)} của bạn, "
                    "tốt để khởi động"
                )
            else:
                base = (
                    f"Khó hơn một chút so với khoảng {band_label(band)} của bạn, "
                    "thử thách nhẹ"
                )
        else:
            base = f"Trình độ nhập môn {band_label(band)}, độ khó phù hợp"
        if recent_topic == topic:
            base += f"; gần đây bạn xem chủ đề {TOPIC_LABELS[topic]['vi-VN']}"
        return f"{base}."

    if content_level:
        base = f"与你当前词汇区间接近（{content_level} 内容"
        if bucket:
            base += f"，按你的 {band_label(band)} 估算，生词约 {bucket}"
        base += "）"
    elif source == "profile":
        if distance == 0:
            base = f"适合你的 {item['level']} 水平"
        elif LEVEL_INDEX[item["level"]] < LEVEL_INDEX[band[0]]:
            base = f"比你的 {band_label(band)} 区间略低，适合热身"
        else:
            base = f"比你的 {band_label(band)} 区间略高，适合挑战"
    else:
        base = f"{band_label(band)} 入门区间，难度合适"
    if recent_topic == topic:
        base += f"；你最近在看{TOPIC_LABELS[topic]['zh-CN']}类"
    editorial = str(item.get("reason") or "").strip()
    return f"{base}。{editorial}" if editorial else f"{base}。"


def _public_item(
    item: dict, reason: str, *, difficulty_row: dict | None = None, band: tuple[str, str] | None = None
) -> dict:
    payload = {
        "videoId": item["videoId"],
        "title": item["title"],
        "channel": item["channel"],
        "duration": item["duration"],
        "thumbnail": item["thumbnail"],
        "level": item["level"],
        "topic": item["topic"],
        "reason": reason,
        "url": f"https://www.youtube.com/watch?v={item['videoId']}",
    }
    content_level = (difficulty_row or {}).get("cefrInput")
    if content_level:
        rate = (
            difficulty.utr_band_for((difficulty_row or {}).get("features"), band[1])
            if band
            else None
        )
        payload["difficulty"] = {
            "cefrInput": content_level,
            "level": (difficulty_row or {}).get("level") or item.get("level"),
            "confidence": (difficulty_row or {}).get("confidence"),
            "utrBand": rate,
            "bucket": difficulty.novelty_bucket(rate),
            "estimated": True,
            "source": "computed",
        }
    return payload


# ---------------------------------------------------------------------------
# 对外用例
# ---------------------------------------------------------------------------

def recommend(
    identity: str | None,
    *,
    is_guest: bool = False,
    target_lang: str = languages.DEFAULT_TARGET_LANG,
    limit: int = DEFAULT_LIMIT,
    seed: int = 0,
) -> dict:
    """生成推荐响应；不调用模型，失败只可能是精选内容缺失/损坏（503）。"""
    try:
        lang = languages.resolve_target_lang(target_lang)
    except languages.UnsupportedLanguage:
        lang = languages.DEFAULT_TARGET_LANG
    limit = max(1, min(MAX_LIMIT, int(limit)))
    seed = max(0, int(seed))

    catalog = load_catalog()
    items: list[dict] = catalog["items"]
    watched = read_watched(lang, items)
    favorite = watched.topics[0] if watched.topics else None
    profile, preliminary_from_profile = profile_band(identity, is_guest=is_guest)
    supply = supply_gate_state()
    # 供给不足：完全回退旧的 level_distance 规则；也不返回 difficulty 徽章，
    # 避免在没有 100 条供给时展示「匹配」类信号。
    if supply["open"]:
        difficulties = _load_difficulties(items)
    else:
        difficulties = {}
        logger.info(
            "内容供给不足（%s/%s），回退旧推荐规则",
            supply["eligible"],
            supply["threshold"],
        )
    difficulty_fingerprint = _difficulty_fingerprint(difficulties)
    gate_key = "match" if supply["open"] else "legacy"

    attempts: list[tuple[tuple[str, str], str, bool]] = []
    if profile is not None:
        attempts.append((profile, "profile", preliminary_from_profile))
    # 无画像 / 画像没有可用候选 → 默认 A2–B1（任务明确要求的回退）。
    attempts.append((DEFAULT_BAND, "default", True))

    for band, source, preliminary in attempts:
        cache_key = "|".join(
            [
                identity or "-",
                lang,
                str(limit),
                str(seed),
                band_label(band),
                source,
                "p" if preliminary else "f",
                gate_key,
                difficulty_fingerprint,
                watched.fingerprint(),
            ]
        )
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached

        chosen = select_items(
            items,
            band,
            watched_video_ids=watched.video_ids,
            favorite_topics=watched.topics,
            limit=limit,
            seed=seed,
            difficulties=difficulties,
        )
        if not chosen and source == "profile":
            continue  # 回退到默认 band
        if not chosen and source == "default":
            payload = {
                "items": [],
                "basis": {"band": band_label(band), "source": "default"},
                "preliminary": True,
            }
            _cache_put(cache_key, payload)
            return payload

        def _distance_for(item: dict) -> int:
            row = difficulties.get(item["videoId"])
            content_distance = content_band_distance(
                (row or {}).get("cefrInput"), band
            )
            if content_distance is not None:
                return content_distance
            return level_distance(item["level"], band)

        reasons = [
            _reason(
                item,
                band=band,
                source=source,
                distance=_distance_for(item),
                recent_topic=favorite,
                target_lang=lang,
                difficulty_row=difficulties.get(item["videoId"]),
            )
            for item in chosen
        ]
        items_payload = [
            _public_item(
                item,
                reason,
                difficulty_row=difficulties.get(item["videoId"]),
                band=band,
            )
            for item, reason in zip(chosen, reasons)
        ]
        payload = {
            "items": items_payload,
            "basis": {"band": band_label(band), "source": source},
            "preliminary": preliminary,
        }
        _cache_put(cache_key, payload)
        return payload

    # 理论不可达：默认 band 分支一定会 return。
    return {
        "items": [],
        "basis": {"band": band_label(DEFAULT_BAND), "source": "default"},
        "preliminary": True,
    }
