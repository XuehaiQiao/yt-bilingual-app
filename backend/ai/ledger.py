"""AI 成本账本（``ai_usage``，只追加）与日配额原子计数（``ai_quota``）。

设计约束（对应计划书 §7.4「AI 成本账本」/ M1 ②）：

- **只追加/累加**：``record_usage`` 只 INSERT；``check_and_consume_quota`` 只
  UPSERT 累加当日计数。不提供历史回写、不改昨天的数据。
- **未知价格不得当 0**：价格取 ``config.MODEL_CATALOG`` 的 ``in`` / ``out``
  （USD / 100 万 token）。目录里缺价的模型（当前 DeepSeek/Gemini 3.x 均为
  ``None``）与目录外模型一律按「**目录里已知最贵**」的 in/out 分别计费；只有
  目录完全没有已知价时才用保守兜底价并告警。
- **写入不阻断主流程**：``record_usage`` 捕获所有异常、记日志并返回 ``None``
  （表未迁移、库不可写时翻译/查词照常工作）。
- **原子配额**：``check_and_consume_quota`` 在单条 SQLite 事务里
  ``INSERT ... ON CONFLICT DO UPDATE`` + 条件 UPDATE，超限回滚并抛
  ``QuotaExceeded``（带 ``status_code = 429`` 语义）。
- **日期边界**：按 ``config.AI_QUOTA_TIMEZONE``（默认 Asia/Shanghai）派生
  ``usage_date`` / 配额 ``day``；``usage_date`` 是写入时派生的日桶，改时区只
  影响新数据，符合「不做历史回写」。
- 表由 Alembic ``0003_cost_ledger`` 创建；运行时不建表、不改表。

运维查询示例（一条 SQL 回答「用户 X 本月花了多少、花在哪个功能」）::

    SELECT feature, SUM(est_cost_usd) AS usd, SUM(calls) AS calls
    FROM ai_usage
    WHERE user_id = ? AND usage_date >= '2026-11-01' AND usage_date < '2026-12-01'
    GROUP BY feature ORDER BY usd DESC;
"""
from __future__ import annotations

import logging
import os
import sqlite3
import time
from datetime import datetime, timezone as dt_timezone
from zoneinfo import ZoneInfo

import config
import storage

logger = logging.getLogger(__name__)

# 与计划书 §7.4 / M1 ② 对齐的功能枚举。写入层严格校验：拼错的功能名会让
# 「花在哪个功能」失真，宁可丢一条并告警，也不污染账本。
KNOWN_FEATURES = ("translate", "summary", "define", "local_show")
FEATURE_LABELS = {
    "translate": "翻译",
    "summary": "总结",
    "define": "词典",
    "local_show": "本地剧集",
}

# 目录里一个已知价都没有时的保守兜底（非官方报价，只在异常配置下使用）。
# 正常目录（gemini-2.5-flash 有价）不会走到这里，未知价按已知最贵计。
_EMERGENCY_PRICE_IN = 3.0
_EMERGENCY_PRICE_OUT = 15.0

_warned: set[str] = set()


class QuotaExceeded(RuntimeError):
    """当日 AI 配额/预算不足（HTTP 语义 429）。"""

    status_code = 429

    def __init__(
        self,
        feature: str,
        *,
        day: str,
        used_units: int | None = None,
        limit_units: int | None = None,
        units: int = 1,
        user_id: str | None = None,
        scope: str = "feature",
        detail: str | None = None,
    ) -> None:
        self.feature = feature
        self.day = day
        self.used_units = used_units
        self.limit_units = limit_units
        self.units = units
        self.user_id = user_id
        self.scope = scope
        label = FEATURE_LABELS.get(feature, feature)
        if detail:
            message = detail
        else:
            message = (
                f"今日 AI 额度已用完（{label}：已用 {used_units}/{limit_units}，"
                f"本次需 {units}），明天 0 点恢复；复习与本地词典不受影响。"
            )
        super().__init__(message)


def now_ms() -> int:
    """服务端当前时间的毫秒时间戳（与 events.py 一致）。"""
    return int(time.time() * 1000)


# ---------------------------------------------------------------------------
# 日期 / 价格
# ---------------------------------------------------------------------------

def _timezone():
    """配额日边界时区；非法配置回落 UTC 并只告警一次。"""
    name = getattr(config, "AI_QUOTA_TIMEZONE", "Asia/Shanghai") or "Asia/Shanghai"
    try:
        return ZoneInfo(name)
    except Exception:  # noqa: BLE001 - 时区配置错误不能阻断 AI 功能
        if "_timezone" not in _warned:
            _warned.add("_timezone")
            logger.warning("AI_QUOTA_TIMEZONE=%r 无效，配额日边界改用 UTC。", name)
        return dt_timezone.utc


def day_of(ts_ms: int | None = None) -> str:
    """毫秒时间戳 → 配额时区下的 ``YYYY-MM-DD``。"""
    stamp = now_ms() if ts_ms is None else int(ts_ms)
    return datetime.fromtimestamp(stamp / 1000, tz=_timezone()).strftime("%Y-%m-%d")


def month_of(ts_ms: int | None = None) -> str:
    """毫秒时间戳 → 配额时区下的 ``YYYY-MM``。"""
    stamp = now_ms() if ts_ms is None else int(ts_ms)
    return datetime.fromtimestamp(stamp / 1000, tz=_timezone()).strftime("%Y-%m")


def _is_price(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def known_ceiling_prices() -> tuple[float, float]:
    """目录里已知 in/out 价各自的最高值（未知价的计费上限）。"""
    known_in = [
        float(spec["in"])
        for spec in config.MODEL_CATALOG.values()
        if _is_price(spec.get("in"))
    ]
    known_out = [
        float(spec["out"])
        for spec in config.MODEL_CATALOG.values()
        if _is_price(spec.get("out"))
    ]
    ceiling_in = max(known_in) if known_in else 0.0
    ceiling_out = max(known_out) if known_out else 0.0
    fallback_used = not known_in or not known_out or ceiling_in <= 0 or ceiling_out <= 0
    if fallback_used and "ceiling" not in _warned:
        _warned.add("ceiling")
        logger.warning(
            "MODEL_CATALOG 没有可用的已知价格，未知价改用保守兜底 "
            "in=$%s / out=$%s per 1M tokens（非官方报价）。",
            _EMERGENCY_PRICE_IN,
            _EMERGENCY_PRICE_OUT,
        )
    return (
        ceiling_in if ceiling_in > 0 else _EMERGENCY_PRICE_IN,
        ceiling_out if ceiling_out > 0 else _EMERGENCY_PRICE_OUT,
    )


def price_for(model_id: str | None) -> tuple[float, float]:
    """模型 id → (in, out) 单价（USD / 1M tokens）。

    目录内缺价的字段按已知最贵补；目录外模型整个按已知最贵计——**绝不当 0**。
    """
    spec = config.MODEL_CATALOG.get(model_id) if model_id else None
    ceiling_in, ceiling_out = known_ceiling_prices()
    in_price = spec.get("in") if isinstance(spec, dict) else None
    out_price = spec.get("out") if isinstance(spec, dict) else None
    return (
        float(in_price) if _is_price(in_price) else ceiling_in,
        float(out_price) if _is_price(out_price) else ceiling_out,
    )


def provider_for(model_id: str | None) -> str:
    """模型 id → provider 名；目录外记 ``unknown``（不编造厂商）。"""
    spec = config.MODEL_CATALOG.get(model_id) if model_id else None
    provider = spec.get("provider") if isinstance(spec, dict) else None
    return str(provider) if provider else "unknown"


def estimate_cost_usd(
    model_id: str | None, input_tokens: int = 0, output_tokens: int = 0
) -> float:
    """按 token 数与目录价估算成本（美元）。"""
    in_price, out_price = price_for(model_id)
    return (
        _int_tokens(input_tokens) * in_price
        + _int_tokens(output_tokens) * out_price
    ) / 1_000_000


def _int_tokens(value) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


# ---------------------------------------------------------------------------
# provider usage 解析
# ---------------------------------------------------------------------------

def usage_from_google_response(response) -> dict:
    """google-genai response → ``{input_tokens, output_tokens}``。

    读取 ``response.usage_metadata`` 的 prompt/candidates token 数；缺失时
    （有些旧 SDK / 假响应没有该字段）返回 0，让 llm.py 决定是否按字符估算。
    """
    meta = getattr(response, "usage_metadata", None)
    if meta is None:
        return {"input_tokens": 0, "output_tokens": 0}
    input_tokens = _int_tokens(getattr(meta, "prompt_token_count", 0))
    output_tokens = _int_tokens(getattr(meta, "candidates_token_count", 0))
    if not input_tokens and not output_tokens:
        total = _int_tokens(getattr(meta, "total_token_count", 0))
        if total:
            # 只有 total 时按「输出约占一半」的保守估计拆，宁可高估成本。
            output_tokens = total // 2
            input_tokens = total - output_tokens
    return {"input_tokens": input_tokens, "output_tokens": output_tokens}


def usage_from_openai_response(data) -> dict:
    """OpenAI 兼容响应体 → ``{input_tokens, output_tokens}``。

    兼容 ``prompt_tokens/completion_tokens`` 与部分厂商的
    ``input_tokens/output_tokens`` 命名；没有 usage 时返回 0。
    """
    usage = data.get("usage") if isinstance(data, dict) else None
    if not isinstance(usage, dict):
        return {"input_tokens": 0, "output_tokens": 0}
    input_tokens = usage.get("prompt_tokens", usage.get("input_tokens", 0))
    output_tokens = usage.get("completion_tokens", usage.get("output_tokens", 0))
    input_tokens = _int_tokens(input_tokens)
    output_tokens = _int_tokens(output_tokens)
    if not input_tokens and not output_tokens:
        total = _int_tokens(usage.get("total_tokens", 0))
        if total:
            output_tokens = total // 2
            input_tokens = total - output_tokens
    return {"input_tokens": input_tokens, "output_tokens": output_tokens}


# ---------------------------------------------------------------------------
# 数据库连接（schema 只由 Alembic 创建）
# ---------------------------------------------------------------------------

def _db_path() -> str:
    return config.AUTH_DB_PATH


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path(), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _require_db() -> str:
    path = _db_path()
    if not os.path.exists(path):
        raise sqlite3.OperationalError(
            f"数据库文件不存在：{path}（先运行 alembic upgrade head）"
        )
    return path


# ---------------------------------------------------------------------------
# 账本：只追加
# ---------------------------------------------------------------------------

_INSERT_USAGE_SQL = (
    "INSERT INTO ai_usage ("
    "user_id, feature, model_id, provider, input_tokens, output_tokens, calls, "
    "est_cost_usd, occurred_at, created_at, usage_date"
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


def record_usage(
    user_id: str | None,
    feature: str,
    model_id: str | None,
    input_tokens: int = 0,
    output_tokens: int = 0,
    *,
    calls: int = 1,
    occurred_at: int | None = None,
    provider: str | None = None,
) -> dict | None:
    """追加一条 AI 用量记录，返回落库行；**任何失败只记日志并返回 None**。

    参数：
    - ``user_id``：归属用户；``None`` 时回落到当前请求 ContextVar，仍为空则
      记为匿名（``user_id IS NULL``，计入全局预算，不出现在「用户 X」查询里）；
    - ``feature``：``translate`` / ``summary`` / ``define`` / ``local_show``；
    - ``model_id``：目录 id（用于定价；未知/缺价按已知最贵计）；
    - ``input_tokens`` / ``output_tokens``：provider usage，负数按 0；
    - ``calls``：本次 API 调用次数（默认 1）；
    - ``occurred_at``：毫秒时间戳，缺省服务端当前时间；
    - ``provider``：缺省从目录读，目录外记 ``unknown``。
    """
    if feature not in KNOWN_FEATURES:
        logger.warning("record_usage 收到未知 feature=%r（已丢弃；见 KNOWN_FEATURES）。", feature)
        return None

    resolved_user = user_id if user_id is not None else storage.active_user_id()
    tokens_in = _int_tokens(input_tokens)
    tokens_out = _int_tokens(output_tokens)
    call_count = _int_tokens(calls)
    occurred = now_ms() if occurred_at is None else _int_tokens(occurred_at)
    created = now_ms()
    usage_date = day_of(occurred)
    resolved_provider = provider or provider_for(model_id)
    cost = estimate_cost_usd(model_id, tokens_in, tokens_out)

    try:
        _require_db()
        conn = _connect()
        try:
            cursor = conn.execute(
                _INSERT_USAGE_SQL,
                (
                    resolved_user,
                    feature,
                    model_id or "unknown",
                    resolved_provider,
                    tokens_in,
                    tokens_out,
                    call_count,
                    cost,
                    occurred,
                    created,
                    usage_date,
                ),
            )
            conn.commit()
            return {
                "id": int(cursor.lastrowid),
                "user_id": resolved_user,
                "feature": feature,
                "model_id": model_id or "unknown",
                "provider": resolved_provider,
                "input_tokens": tokens_in,
                "output_tokens": tokens_out,
                "calls": call_count,
                "est_cost_usd": cost,
                "occurred_at": occurred,
                "created_at": created,
                "usage_date": usage_date,
            }
        finally:
            conn.close()
    except Exception:  # noqa: BLE001 - 记账失败绝不能阻断翻译/查词主流程
        logger.exception(
            "ai_usage 写入失败（已忽略，不阻断主流程）：feature=%r model=%r",
            feature,
            model_id,
        )
        return None


def _user_clause(user_id: str | None) -> tuple[str, list]:
    if user_id is None:
        return "user_id IS NULL", []
    return "user_id = ?", [user_id]


def _month_bounds(month: str) -> tuple[str, str]:
    """``YYYY-MM`` → [本月 1 日, 下月 1 日) 的日桶边界（字符串可直接比较）。"""
    try:
        year_s, month_s = month.split("-", 1)
        year, mon = int(year_s), int(month_s)
        if not (1 <= mon <= 12):
            raise ValueError
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError(f"非法月份：{month!r}（应为 YYYY-MM）") from exc
    start = f"{year:04d}-{mon:02d}-01"
    if mon == 12:
        end = f"{year + 1:04d}-01-01"
    else:
        end = f"{year:04d}-{mon + 1:02d}-01"
    return start, end


def monthly_spend(
    user_id: str | None, month: str | None = None, *, now_ms_value: int | None = None
) -> dict:
    """用户某月（默认当月）的总花费与按功能拆分。

    返回 ``{user_id, month, total_usd, calls, input_tokens, output_tokens,
    by_feature: {feature: {cost_usd, calls, input_tokens, output_tokens, rows}}}``。
    表不存在时抛 ``sqlite3.Error``（运维查询要能看到迁移问题）。
    """
    month = month_of(now_ms_value) if month is None else str(month)
    start, end = _month_bounds(month)
    user_sql, user_params = _user_clause(user_id)
    sql = (
        "SELECT feature, COUNT(*) AS rows, SUM(calls) AS calls, "
        "SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, "
        "SUM(est_cost_usd) AS cost_usd "
        "FROM ai_usage WHERE "
        f"{user_sql} AND usage_date >= ? AND usage_date < ? "
        "GROUP BY feature ORDER BY cost_usd DESC"
    )
    _require_db()
    conn = _connect()
    try:
        rows = conn.execute(sql, [*user_params, start, end]).fetchall()
    finally:
        conn.close()

    by_feature: dict[str, dict] = {}
    totals = {"cost_usd": 0.0, "calls": 0, "input_tokens": 0, "output_tokens": 0, "rows": 0}
    for row in rows:
        item = {
            "cost_usd": round(float(row["cost_usd"] or 0.0), 6),
            "calls": int(row["calls"] or 0),
            "input_tokens": int(row["input_tokens"] or 0),
            "output_tokens": int(row["output_tokens"] or 0),
            "rows": int(row["rows"] or 0),
        }
        by_feature[row["feature"]] = item
        for key in totals:
            totals[key] += item[key]
    return {
        "user_id": user_id,
        "month": month,
        "total_usd": round(totals["cost_usd"], 6),
        "calls": totals["calls"],
        "input_tokens": totals["input_tokens"],
        "output_tokens": totals["output_tokens"],
        "by_feature": by_feature,
    }


def _usage_totals(user_id: str | None, day: str, feature: str | None = None) -> dict:
    user_sql, params = _user_clause(user_id)
    sql = (
        "SELECT COUNT(*) AS rows, SUM(calls) AS calls, "
        "SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, "
        "SUM(est_cost_usd) AS cost_usd FROM ai_usage "
        f"WHERE {user_sql} AND usage_date = ?"
    )
    params.append(day)
    if feature is not None:
        sql += " AND feature = ?"
        params.append(feature)
    _require_db()
    conn = _connect()
    try:
        row = conn.execute(sql, params).fetchone()
    finally:
        conn.close()
    return {
        "calls": int(row["calls"] or 0),
        "input_tokens": int(row["input_tokens"] or 0),
        "output_tokens": int(row["output_tokens"] or 0),
        "rows": int(row["rows"] or 0),
        "cost_usd": round(float(row["cost_usd"] or 0.0), 6),
    }


def daily_spend(user_id: str | None, day: str | None = None) -> float:
    """用户某日（默认今天）AI 花费合计（美元）。用于第二层日预算硬闸。"""
    return float(_usage_totals(user_id, day or day_of())["cost_usd"])


def global_daily_spend(day: str | None = None) -> float:
    """全站某日（默认今天）AI 花费合计（美元）。用于第三层全局日预算硬闸。"""
    day = day or day_of()
    sql = "SELECT SUM(est_cost_usd) AS cost_usd FROM ai_usage WHERE usage_date = ?"
    _require_db()
    conn = _connect()
    try:
        row = conn.execute(sql, (day,)).fetchone()
    finally:
        conn.close()
    return round(float(row["cost_usd"] or 0.0), 6)


def daily_usage(
    user_id: str | None, feature: str | None = None, day: str | None = None
) -> dict:
    """用户某日（默认今天）的账本用量 + 配额计数。

    - ``feature`` 给定时只看该功能；不给时聚合全部功能，并返回各功能的配额行；
    - 账本部分来自 ``ai_usage``（花费/tokens/calls），配额部分来自 ``ai_quota``
      （已用/日限额/剩余）。
    """
    day = day or day_of()
    totals = _usage_totals(user_id, day, feature)
    result = {
        "user_id": user_id,
        "day": day,
        "feature": feature,
        **totals,
        "quota": None,
    }

    user_sql, params = _user_clause(user_id)
    _require_db()
    conn = _connect()
    try:
        if feature is not None:
            row = conn.execute(
                "SELECT used_units, limit_units FROM ai_quota "
                f"WHERE {user_sql} AND day = ? AND feature = ?",
                [*params, day, feature],
            ).fetchone()
            if row is not None:
                quota_item = {
                    "used_units": int(row["used_units"]),
                    "limit_units": int(row["limit_units"]),
                    "remaining": max(0, int(row["limit_units"]) - int(row["used_units"])),
                }
                result["quota"] = quota_item
                # 单功能视图同时给出顶层字段，方便运营/脚本直接读。
                result.update(quota_item)
        else:
            rows = conn.execute(
                "SELECT feature, used_units, limit_units FROM ai_quota "
                f"WHERE {user_sql} AND day = ? ORDER BY feature",
                [*params, day],
            ).fetchall()
            result["quota"] = {
                row["feature"]: {
                    "used_units": int(row["used_units"]),
                    "limit_units": int(row["limit_units"]),
                    "remaining": max(0, int(row["limit_units"]) - int(row["used_units"])),
                }
                for row in rows
            }
    finally:
        conn.close()
    return result


# ---------------------------------------------------------------------------
# 日配额：UPSERT + 条件递增（原子）
# ---------------------------------------------------------------------------

_UPSERT_QUOTA_SQL = (
    "INSERT INTO ai_quota (user_id, day, feature, used_units, limit_units) "
    "VALUES (?, ?, ?, 0, ?) "
    "ON CONFLICT(user_id, day, feature) DO UPDATE SET limit_units = excluded.limit_units"
)

_CONSUME_QUOTA_SQL = (
    "UPDATE ai_quota SET used_units = used_units + ? "
    "WHERE user_id = ? AND day = ? AND feature = ? "
    "AND used_units + ? <= limit_units"
)


def check_and_consume_quota(
    user_id: str | None,
    feature: str,
    units: int = 1,
    *,
    limit: int | None = None,
    day: str | None = None,
) -> dict:
    """原子消耗 ``units`` 个当日配额；超限抛 ``QuotaExceeded``。

    - 未登录/``user_id=None``：无法归属，直接放行（``anonymous=True``），不写库；
    - ``limit`` 缺省时从 ``ai.quota.limit_for(feature)`` 取（延迟导入避免环）；
    - 表不存在时抛 ``sqlite3.OperationalError``，由 ``ai.quota`` 的包装层决定
      是否 fail-open（运行时未迁移时不能把翻译整条链路打死）。

    返回 ``{allowed, feature, day, used_units, limit_units, remaining, units}``。
    """
    if feature not in KNOWN_FEATURES:
        raise ValueError(f"未知 AI 功能：{feature!r}（见 ai.ledger.KNOWN_FEATURES）")
    try:
        units = max(1, int(units))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"配额 units 必须是正整数：{units!r}") from exc

    day = day or day_of()
    if not user_id:
        return {
            "allowed": True,
            "anonymous": True,
            "feature": feature,
            "day": day,
            "used_units": None,
            "limit_units": None,
            "remaining": None,
            "units": units,
        }

    if limit is None:
        from ai import quota as quota_module  # 延迟导入：quota 模块 import ledger

        limit = quota_module.limit_for(feature)
    try:
        limit = max(0, int(limit))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"配额限额必须是非负整数：{limit!r}") from exc

    _require_db()
    conn = _connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(_UPSERT_QUOTA_SQL, (user_id, day, feature, limit))
        cursor = conn.execute(
            _CONSUME_QUOTA_SQL, (units, user_id, day, feature, units)
        )
        if cursor.rowcount != 1:
            row = conn.execute(
                "SELECT used_units, limit_units FROM ai_quota "
                "WHERE user_id = ? AND day = ? AND feature = ?",
                (user_id, day, feature),
            ).fetchone()
            used = int(row["used_units"]) if row is not None else 0
            stored_limit = int(row["limit_units"]) if row is not None else limit
            conn.rollback()
            raise QuotaExceeded(
                feature,
                day=day,
                used_units=used,
                limit_units=stored_limit,
                units=units,
                user_id=user_id,
            )
        row = conn.execute(
            "SELECT used_units, limit_units FROM ai_quota "
            "WHERE user_id = ? AND day = ? AND feature = ?",
            (user_id, day, feature),
        ).fetchone()
        conn.commit()
    except QuotaExceeded:
        raise
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    used = int(row["used_units"])
    limit_value = int(row["limit_units"])
    return {
        "allowed": True,
        "anonymous": False,
        "feature": feature,
        "day": day,
        "used_units": used,
        "limit_units": limit_value,
        "remaining": max(0, limit_value - used),
        "units": units,
    }
