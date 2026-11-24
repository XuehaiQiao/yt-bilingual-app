"""翻译/分析管道计时落盘（P2-35）：``pipeline_timing`` 只追加表 + P50/P95。

背景：视频 SSE/经典、教学分析、读文章、公版书、本地剧集原本只有一行
stdout 计时日志（``feature=... total_ms=...``），线上没有任何可查询的数据，
P50/P95/失败率只能靠肉眼翻日志。本模块把这些结构化计时落成表，供
``GET /api/admin/pipeline-timing`` 与管理台「翻译计时」表查询。

硬约束：

- **写入绝不阻断翻译**：``record`` 的任何异常（库文件不存在、未迁移到 0032、
  只读、磁盘满、并发锁超时）都只记一次 warning 并返回 ``None``；调用方在
  ``finally`` 里调用也安全，不会把翻译/SSE 变成 5xx。
- **不落正文/隐私**：只存标识与数值。``content_ref`` 只接受无空白/无反斜杠的
  安全标识（videoId / articleId / 书章），否则丢弃为 ``NULL``；``job_id`` 同理；
  ``meta`` 只接受白名单键的标量值，**没有用户 id、没有正文、没有 prompt**。
- **只追加**：不 UPDATE / DELETE；按 ``(day, feature)`` 与 ``(feature, day)``
  建索引，管理台按日范围 + feature 聚合。
- **日桶口径**：``day`` 按 ``config.AI_QUOTA_TIMEZONE``（默认 Asia/Shanghai）
  派生，与 ``ai.usage`` / 配额 / 管理台日期同口径；改时区只影响新记录。
- 表由 Alembic ``0032_pipeline_timing`` 创建，运行时不建表。

聚合口径（``aggregate``）：

- 样本 = ``event='total'`` 的记录（一次翻译/分析算一次），时长取 ``total_ms``；
  ``event='batch'`` 只进最近行，不参与 P50/P95（批时长与整次时长不可混算）；
- P50/P95 用线性插值（与常见监控面板一致），无样本时返回空列表（HTTP 200）；
- ``okRate`` 是 0–1 的比例，未写 ``ok`` 的旧记录按成功计（列默认 1）。

运维示例::

    SELECT feature, COUNT(*), AVG(total_ms)
    FROM pipeline_timing
    WHERE day >= '2026-11-18' AND event = 'total'
    GROUP BY feature;
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import sqlite3
import time
from datetime import datetime
from urllib.parse import quote
from zoneinfo import ZoneInfo

import config

logger = logging.getLogger("linguatrek.pipeline_timing")

TABLE = "pipeline_timing"
MIGRATION_REVISION = "0032_pipeline_timing"

# feature 是检索/聚合锚点：拼错会让管理台出现两个近义行，宁可丢这条并告警。
KNOWN_FEATURES = (
    "video_translation",  # 视频经典路径（/api/process-video）
    "sse_translate",  # 视频流式路径（/api/process-video-stream 的翻译）
    "video_analysis",  # 教学分析（视频/本地剧集/缓存命中）
    "reading",  # 读文章翻译
    "book_translation",  # 内置公版书按章翻译
    "local_show",  # 本地剧集（补译/自愈路径）
    "translate",  # 其他共用翻译路径（缓存补译）
)

# event 同样收口，避免把 "Batch"/"totals" 之类拼写写进统计维度。
KNOWN_EVENTS = ("batch", "total")

# meta_json 白名单：只放排障需要的数值/短标签。正文、prompt、用户输入一律不落。
META_KEYS = frozenset(
    {
        "attempts",
        "fallback",
        "outcome",
        "status",
        "first_batch_ms",
        "queue_wait_ms",
        "batch_ms",
        "translated",
        "failed_paragraphs",
        "level",
    }
)

MAX_CONTENT_REF_CHARS = 200
MAX_JOB_ID_CHARS = 128
MAX_META_VALUE_CHARS = 64

_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9._:-]+$")
_MAX_RANGE_DAYS = 366

# 缺表/缺库只告警一次，避免每个批次刷一行；测试换库路径时会再告警。
_warned: set[str] = set()


class PipelineTimingUnavailable(Exception):
    """表未迁移 / 库文件不存在 / 不可读（管理 API 映射 503）。"""


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def now_ms() -> int:
    """服务端当前毫秒时间戳（测试 monkeypatch 这里注入时钟）。"""
    return int(time.time() * 1000)


def _timezone() -> ZoneInfo:
    """计时日桶时区；非法配置回落 UTC（与 ai.ledger 同口径，不影响主流程）。"""
    name = getattr(config, "AI_QUOTA_TIMEZONE", "Asia/Shanghai") or "Asia/Shanghai"
    try:
        return ZoneInfo(name)
    except Exception:  # noqa: BLE001 - 坏时区不能影响记录/查询
        if "timezone" not in _warned:
            _warned.add("timezone")
            logger.warning("AI_QUOTA_TIMEZONE=%r 非法，pipeline_timing 日桶改用 UTC。", name)
        return ZoneInfo("UTC")


def day_of(ts_ms: int | None = None) -> str:
    """毫秒时间戳 → 计时时区下的 ``YYYY-MM-DD``。"""
    stamp = now_ms() if ts_ms is None else int(ts_ms)
    return datetime.fromtimestamp(stamp / 1000, tz=_timezone()).strftime("%Y-%m-%d")


def feature_known(feature: str | None) -> bool:
    """管理 API/写入层的 feature 校验（``None`` 表示不过滤，不在这里判）。"""
    return feature in KNOWN_FEATURES


def _db_path() -> str:
    return config.AUTH_DB_PATH


def _connect(*, readonly: bool) -> sqlite3.Connection:
    path = _db_path()
    if not os.path.isfile(path):
        raise PipelineTimingUnavailable(
            f"数据库文件不存在：{path}（先运行 alembic upgrade head）"
        )
    if readonly:
        url = f"file:{quote(os.path.abspath(path), safe='/')}?mode=ro&uri=true"
        conn = sqlite3.connect(url, uri=True, timeout=2)
        conn.execute("PRAGMA query_only = ON")
    else:
        conn = sqlite3.connect(path, timeout=2)
    conn.row_factory = sqlite3.Row
    return conn


def _warn_once(key: str, message: str, *args) -> None:
    if key in _warned:
        return
    _warned.add(key)
    logger.warning(message, *args)


# ---------------------------------------------------------------------------
# 字段清洗（写入绝不把正文/隐私带进表）
# ---------------------------------------------------------------------------

def _as_safe_ref(value, *, max_chars: int) -> str | None:
    """安全标识（videoId/articleId/jobId）：无空白、无反斜杠、有长度上限。"""
    if value is None:
        return None
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or len(text) > max_chars:
        return None
    if not _SAFE_ID_RE.fullmatch(text):
        return None
    return text


def _as_ms(value) -> float | None:
    """非负毫秒数，保留 2 位小数；非法/负数返回 None。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number) or number < 0:
        return None
    return round(number, 2)


def _as_count(value, *, minimum: int = 0) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < minimum:
        return None
    return value


def _as_day(value) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    try:
        datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        return None
    return text


def _sanitize_meta(meta) -> str | None:
    """meta_json：只保留白名单键的标量值；未知键/复杂类型静默丢弃。"""
    if not isinstance(meta, dict):
        return None
    clean: dict = {}
    for key, value in meta.items():
        if key not in META_KEYS:
            continue
        if isinstance(value, bool):
            clean[key] = value
        elif isinstance(value, int):
            clean[key] = value
        elif isinstance(value, float):
            if math.isfinite(value):
                clean[key] = round(value, 2)
        elif isinstance(value, str):
            text = value.strip()
            if not text or len(text) > MAX_META_VALUE_CHARS:
                continue
            if any(ord(char) < 32 for char in text):
                continue
            clean[key] = text
    if not clean:
        return None
    return json.dumps(clean, ensure_ascii=False, separators=(",", ":"))


# ---------------------------------------------------------------------------
# 写入（静默）
# ---------------------------------------------------------------------------

def record(
    *,
    feature: str,
    event: str,
    content_ref: str | None = None,
    job_id: str | None = None,
    batch_index: int | None = None,
    batch_count: int | None = None,
    duration_ms: float | None = None,
    total_ms: float | None = None,
    concurrency: int | None = None,
    ok: bool | None = None,
    meta: dict | None = None,
    occurred_at_ms: int | None = None,
) -> int | None:
    """追加一条计时记录；**任何失败都静默**（只记一次 warning），返回行 id/None。

    参数：
    - ``feature``：``KNOWN_FEATURES`` 之一（拼错直接丢弃，不污染聚合）；
    - ``event``：``batch``（单批）或 ``total``（一次翻译/分析收尾）；
    - ``content_ref`` / ``job_id``：可归因标识；不合法（含空白/正文）会置空；
    - ``batch_index``：0 起；``batch_count``：本次切了几批；
    - ``duration_ms``：批耗时；``total_ms``：整次耗时；
    - ``concurrency``：并发通道数；``ok``：成功与否（缺省按成功）；
    - ``meta``：白名单数值/短标签（``META_KEYS``）；
    - ``occurred_at_ms``：缺省服务端当前时间（测试注入固定时钟用）。
    """
    try:
        if feature not in KNOWN_FEATURES:
            _warn_once(
                f"feature:{feature}",
                "pipeline_timing 收到未知 feature=%r（已丢弃；见 KNOWN_FEATURES）。",
                feature,
            )
            return None
        if event not in KNOWN_EVENTS:
            _warn_once(
                f"event:{event}",
                "pipeline_timing 收到未知 event=%r（已丢弃；见 KNOWN_EVENTS）。",
                event,
            )
            return None

        created = now_ms() if occurred_at_ms is None else int(occurred_at_ms)
        fields = {
            "feature": feature,
            "event": event,
            "content_ref": _as_safe_ref(content_ref, max_chars=MAX_CONTENT_REF_CHARS),
            "job_id": _as_safe_ref(job_id, max_chars=MAX_JOB_ID_CHARS),
            "batch_index": _as_count(batch_index),
            "batch_count": _as_count(batch_count),
            "duration_ms": _as_ms(duration_ms),
            "total_ms": _as_ms(total_ms),
            "concurrency": _as_count(concurrency, minimum=1),
            "ok": 1 if ok is None else int(bool(ok)),
            "meta_json": _sanitize_meta(meta),
            "created_at_ms": created,
            "day": day_of(created),
        }
        try:
            conn = _connect(readonly=False)
        except PipelineTimingUnavailable:
            _warn_once(
                "db-missing",
                "pipeline_timing：数据库文件不存在（计时不落盘；先运行 "
                "alembic upgrade head，不影响翻译）。",
            )
            return None
        try:
            with conn:
                cursor = conn.execute(
                    f"INSERT INTO {TABLE} ("
                    "feature, event, content_ref, job_id, batch_index, "
                    "batch_count, duration_ms, total_ms, concurrency, ok, "
                    "meta_json, created_at_ms, day"
                    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        fields["feature"],
                        fields["event"],
                        fields["content_ref"],
                        fields["job_id"],
                        fields["batch_index"],
                        fields["batch_count"],
                        fields["duration_ms"],
                        fields["total_ms"],
                        fields["concurrency"],
                        fields["ok"],
                        fields["meta_json"],
                        fields["created_at_ms"],
                        fields["day"],
                    ),
                )
                return int(cursor.lastrowid)
        finally:
            conn.close()
    except sqlite3.OperationalError as exc:
        if "no such table" in str(exc).lower():
            _warn_once(
                "missing-table",
                "pipeline_timing 表不存在（数据库未迁移到 %s；计时不落盘，"
                "不影响翻译）。",
                MIGRATION_REVISION,
            )
        else:
            _warn_once(
                "sqlite-error",
                "pipeline_timing 写入失败（已静默忽略，不影响翻译）：%s",
                exc,
            )
        return None
    except Exception as exc:  # noqa: BLE001 - 计时绝不能影响主流程
        _warn_once(
            "unexpected",
            "pipeline_timing 写入异常（已静默忽略，不影响翻译）：%s",
            type(exc).__name__,
        )
        return None


# ---------------------------------------------------------------------------
# 聚合（管理 API）
# ---------------------------------------------------------------------------

def percentile(values: list[float], p: float) -> float | None:
    """线性插值分位数（``p`` 取 0–1）；空列表返回 None。"""
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return round(ordered[0], 2)
    rank = max(0.0, min(1.0, p)) * (len(ordered) - 1)
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return round(ordered[lower], 2)
    value = ordered[lower] + (ordered[upper] - ordered[lower]) * (rank - lower)
    return round(value, 2)


def _validate_range(day_from: str, day_to: str) -> None:
    start = _as_day(day_from)
    end = _as_day(day_to)
    if start is None or end is None:
        raise ValueError("from/to 需要 YYYY-MM-DD 格式。")
    if start > end:
        raise ValueError("from 不能晚于 to。")
    span = (
        datetime.strptime(end, "%Y-%m-%d")
        - datetime.strptime(start, "%Y-%m-%d")
    ).days
    if span > _MAX_RANGE_DAYS:
        raise ValueError(f"日期范围最多 {_MAX_RANGE_DAYS} 天。")


def _recent_row(row: sqlite3.Row) -> dict:
    return {
        "id": int(row["id"]),
        "feature": row["feature"],
        "event": row["event"],
        "contentRef": row["content_ref"],
        "jobId": row["job_id"],
        "batchIndex": row["batch_index"],
        "batchCount": row["batch_count"],
        "durationMs": row["duration_ms"],
        "totalMs": row["total_ms"],
        "concurrency": row["concurrency"],
        "ok": bool(row["ok"]),
        "createdAtMs": int(row["created_at_ms"]),
        "day": row["day"],
    }


def aggregate(
    day_from: str,
    day_to: str,
    *,
    feature: str | None = None,
    recent_limit: int = 50,
) -> dict:
    """按 feature 聚合区间内的 ``total`` 记录，并返回最近行。

    返回::

        {
          "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "feature": "..." | None,
          "rows": [{feature, samples, okSamples, okRate, p50Ms, p95Ms, maxMs,
                    avgMs, batchSamples}],
          "recent": [{id, feature, event, contentRef, jobId, batchIndex,
                      batchCount, durationMs, totalMs, concurrency, ok,
                      createdAtMs, day}]
        }

    空数据是正常结果（``rows=[]``），不是错误；表/库不可用抛
    :class:`PipelineTimingUnavailable`（管理 API 映射 503）。
    """
    _validate_range(day_from, day_to)
    if feature is not None and feature not in KNOWN_FEATURES:
        raise ValueError(f"未知 feature：{feature!r}（见 KNOWN_FEATURES）。")
    limit = int(recent_limit)
    if not 1 <= limit <= 200:
        raise ValueError("limit 需要在 1–200 之间。")

    where = "day >= ? AND day <= ?"
    params: list = [day_from, day_to]
    if feature is not None:
        where += " AND feature = ?"
        params.append(feature)

    try:
        conn = _connect(readonly=True)
    except PipelineTimingUnavailable:
        raise
    except sqlite3.Error as exc:
        raise PipelineTimingUnavailable(f"读取计时数据失败：{exc}") from exc

    try:
        totals = conn.execute(
            "SELECT feature, ok, total_ms FROM pipeline_timing "
            f"WHERE {where} AND event = 'total'",
            params,
        ).fetchall()
        batch_rows = conn.execute(
            "SELECT feature, COUNT(*) AS samples FROM pipeline_timing "
            f"WHERE {where} AND event = 'batch' GROUP BY feature",
            params,
        ).fetchall()
        recent = conn.execute(
            "SELECT id, feature, event, content_ref, job_id, batch_index, "
            "batch_count, duration_ms, total_ms, concurrency, ok, created_at_ms, day "
            f"FROM pipeline_timing WHERE {where} "
            "ORDER BY created_at_ms DESC, id DESC LIMIT ?",
            [*params, limit],
        ).fetchall()
    except sqlite3.OperationalError as exc:
        if "no such table" in str(exc).lower():
            raise PipelineTimingUnavailable(
                "数据库缺少 pipeline_timing 表（先运行 alembic upgrade head，"
                f"{MIGRATION_REVISION}）。"
            ) from exc
        raise PipelineTimingUnavailable(f"读取计时数据失败：{exc}") from exc
    except sqlite3.Error as exc:
        raise PipelineTimingUnavailable(f"读取计时数据失败：{exc}") from exc
    finally:
        conn.close()

    grouped: dict[str, dict] = {}
    for row in totals:
        item = grouped.setdefault(
            row["feature"], {"samples": 0, "ok": 0, "values": []}
        )
        item["samples"] += 1
        if row["ok"]:
            item["ok"] += 1
        if row["total_ms"] is not None:
            item["values"].append(float(row["total_ms"]))
    batch_counts = {row["feature"]: int(row["samples"]) for row in batch_rows}

    rows = []
    for name, item in grouped.items():
        values = item["values"]
        rows.append(
            {
                "feature": name,
                "samples": item["samples"],
                "okSamples": item["ok"],
                "okRate": round(item["ok"] / item["samples"], 4)
                if item["samples"]
                else None,
                "p50Ms": percentile(values, 0.50),
                "p95Ms": percentile(values, 0.95),
                "maxMs": round(max(values), 2) if values else None,
                "avgMs": round(sum(values) / len(values), 2) if values else None,
                "batchSamples": batch_counts.get(name, 0),
            }
        )
    rows.sort(key=lambda item: (-item["samples"], item["feature"]))

    return {
        "from": day_from,
        "to": day_to,
        "feature": feature,
        "rows": rows,
        "recent": [_recent_row(row) for row in recent],
    }


__all__ = [
    "MIGRATION_REVISION",
    "KNOWN_FEATURES",
    "KNOWN_EVENTS",
    "META_KEYS",
    "PipelineTimingUnavailable",
    "aggregate",
    "day_of",
    "feature_known",
    "now_ms",
    "percentile",
    "record",
]
