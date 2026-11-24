"""每日 AI 额度配置（全局默认 + 单用户覆盖）的单一事实源（specs/047）。

额度分层（从低到高）：

1. **env/config**：``config.AI_DAILY_QUOTA_*``（部署时写死的兜底默认值）；
2. **全局默认**：``app_settings`` 键 ``ai_quota_defaults`` 的 JSON
   ``{feature: int}``（管理员在后台一次改所有用户；缺省回落第 1 层）；
3. **单用户覆盖**：``quota_overrides`` 表（migration ``0031_quota_overrides``）
   的 ``(user_id, feature)`` 行（客服/大客户；清除后回继承默认）。

语义与边界：

- ``0`` = 关闭该功能（运行时 429）；**不提供「无限」**，避免误配；
- 只允许 :data:`QUOTA_FEATURES` 里的 8 个功能（``books`` / ``discover`` 没有
  用户日额度，不在本表范围内）；限额必须是 ``0..MAX_LIMIT`` 的整数；
- 缓存：进程内 5 秒（全局默认与每用户覆盖各一份），管理员写入后
  :func:`invalidate` 立即生效；每份缓存按 ``AUTH_DB_PATH`` 隔离，避免测试/多库
  场景串味；
- **未迁移**：读覆盖表时抛 :class:`QuotaConfigUnavailable`（管理 API → 503）；
  ``ai.quota`` 在运行时捕获它并只按默认层继续（fail-open，不把 AI 链路打死，
  与 ``ai_usage``/``ai_quota`` 缺表时的既有约定一致）。写 ``app_settings`` 时
  表缺失同样抛该异常。

对外 API（管理端 / ``ai.quota`` 共用）：

- :func:`default_limit` / :func:`global_defaults`：全局默认层；
- :func:`user_overrides` / :func:`effective_limit`：覆盖层与解析结果；
- :func:`set_defaults` / :func:`apply_overrides`：受控写入（单事务）；
- :func:`validate_changes`：把请求体（``{feature: int|null}``）校验成规范形式。
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
from typing import Any

import auth_db
import config
from ai.ledger import KNOWN_FEATURES

logger = logging.getLogger(__name__)

#: ``app_settings`` 里全局默认值的键（JSON ``{feature: int}``）。
DEFAULTS_KEY = "ai_quota_defaults"

#: 单用户覆盖表（migration 0031）。
OVERRIDES_TABLE = "quota_overrides"

#: 进程内缓存时长（秒）；管理员写入后由 :func:`invalidate` 立即清空。
CACHE_SECONDS = 5.0

#: 限额上限（含）。防止把单日额度误配成天文数字。
MAX_LIMIT = 1_000_000

#: 有「用户每日额度」的 8 个功能 → ``config`` 里的兜底属性名。
#: 与 ``ai.quota._FEATURE_LIMIT_ATTRS`` 同源（后者保留为兼容别名）。
FEATURE_LIMIT_ATTRS: dict[str, str] = {
    "translate": "AI_DAILY_QUOTA_TRANSLATE_BATCHES",
    "summary": "AI_DAILY_QUOTA_SUMMARY",
    "define": "AI_DAILY_QUOTA_DEFINE",
    "local_show": "AI_DAILY_QUOTA_LOCAL_SHOW_BATCHES",
    "quiz": "AI_DAILY_QUOTA_QUIZ",
    "reading": "AI_DAILY_QUOTA_READING_BATCHES",
    "analysis": "AI_DAILY_QUOTA_ANALYSIS",
    "course_generation": "AI_DAILY_QUOTA_COURSE_GENERATION",
}

#: 本模块管理的功能集合（渲染顺序固定，管理台/测试都按它遍历）。
QUOTA_FEATURES: tuple[str, ...] = tuple(FEATURE_LIMIT_ATTRS)


class QuotaConfigUnavailable(Exception):
    """额度配置表不可用（未跑迁移/数据库文件不存在）→ 管理 API 503。"""


class InvalidQuotaFeature(ValueError):
    """功能名不在可配置范围内（HTTP 400）。"""


class InvalidQuotaLimit(ValueError):
    """限额不是 ``0..MAX_LIMIT`` 的整数（HTTP 400）。"""


class InvalidQuotaChange(ValueError):
    """请求体形状不对（空对象/非映射；HTTP 400）。"""


# ---------------------------------------------------------------------------
# 缓存
# ---------------------------------------------------------------------------

# 时钟函数单独暴露，测试可替换而不影响全局 time 模块。
_clock = time.monotonic

# (过期时间, 数据库标识, 全局默认覆盖值)
_defaults_cache: tuple[float, str, dict[str, int]] | None = None
# {(数据库标识, user_id): (过期时间, 覆盖值)}
_overrides_cache: dict[tuple[str, str], tuple[float, dict[str, int]]] = {}

# 缺表只告警一次，避免每个 AI 请求刷屏。
_warned_missing_overrides = False


def _db_key() -> str:
    """缓存隔离键：同一个进程可能因测试/多库切换指向不同的 ``AUTH_DB_PATH``。"""
    return os.path.abspath(str(getattr(config, "AUTH_DB_PATH", "") or ""))


def invalidate() -> None:
    """清空全局默认与用户覆盖的进程内缓存（管理员写入后立即调用）。"""
    global _defaults_cache
    _defaults_cache = None
    _overrides_cache.clear()


# 测试/运维排障用的同义入口（与 ``account.reset_settings_cache`` 命名对齐）。
reset_cache = invalidate


# ---------------------------------------------------------------------------
# 连接 / 表检测（读绝不建库，写走 auth_db 的兼容连接）
# ---------------------------------------------------------------------------

def _read_connect() -> sqlite3.Connection | None:
    """只读连接；库文件不存在返回 ``None``（绝不顺手建一个空库）。"""
    path = config.AUTH_DB_PATH
    if not os.path.exists(path):
        return None
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    return row is not None


def _unavailable(message: str) -> QuotaConfigUnavailable:
    return QuotaConfigUnavailable(
        f"{message}（先运行 `cd backend && venv/bin/python -m alembic upgrade head`）"
    )


def _warn_missing_overrides_once() -> None:
    global _warned_missing_overrides
    if _warned_missing_overrides:
        return
    _warned_missing_overrides = True
    logger.warning(
        "%s 表不存在（未跑 0031_quota_overrides 迁移），用户额度覆盖本次不生效；"
        "上线前必须运行 `alembic upgrade head`。",
        OVERRIDES_TABLE,
    )


# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------

def validate_feature(feature: object) -> str:
    """功能名必须是有用户额度的 8 个之一（``books``/``discover`` 明确拒绝）。"""
    if not isinstance(feature, str):
        raise InvalidQuotaFeature(f"功能名必须是字符串：{feature!r}")
    if feature in FEATURE_LIMIT_ATTRS:
        return feature
    if feature in KNOWN_FEATURES:
        raise InvalidQuotaFeature(
            f"功能 {feature!r} 没有用户每日额度，不能配置（可用："
            f"{'、'.join(QUOTA_FEATURES)}）。"
        )
    raise InvalidQuotaFeature(
        f"未知 AI 功能：{feature!r}（见 ai.ledger.KNOWN_FEATURES）。"
    )


def validate_limit(feature: str, value: object) -> int:
    """限额必须是 ``0..MAX_LIMIT`` 的整数（``0`` = 关闭该功能）。"""
    if isinstance(value, bool) or not isinstance(value, int):
        raise InvalidQuotaLimit(
            f"{feature} 的额度必须是 0..{MAX_LIMIT} 的整数或 null：{value!r}"
        )
    if not 0 <= value <= MAX_LIMIT:
        raise InvalidQuotaLimit(
            f"{feature} 的额度必须在 0..{MAX_LIMIT} 之间：{value}"
        )
    return value


def validate_changes(changes: object) -> dict[str, int | None]:
    """校验 ``{feature: int|null}`` 请求体；``null`` = 删除该项（回继承）。

    空对象不是合法修改（避免无意义的审计记录）——调用方应回 400。
    """
    if not isinstance(changes, dict) or not changes:
        raise InvalidQuotaChange(
            "limits/overrides 必须是非空对象（feature → 整数或 null）。"
        )
    validated: dict[str, int | None] = {}
    for feature, value in changes.items():
        name = validate_feature(feature)
        validated[name] = None if value is None else validate_limit(name, value)
    return validated


# ---------------------------------------------------------------------------
# 全局默认层（app_settings）
# ---------------------------------------------------------------------------

def _config_default(feature: str) -> int:
    """第 1 层：``config.AI_DAILY_QUOTA_*``（非法值按 0 = 关闭处理）。"""
    attr = FEATURE_LIMIT_ATTRS[feature]
    try:
        return max(0, min(MAX_LIMIT, int(getattr(config, attr, 0) or 0)))
    except (TypeError, ValueError):
        return 0


def _parse_defaults(raw: object) -> dict[str, int]:
    """解析 ``ai_quota_defaults`` 的 JSON；坏数据/越界项逐条丢弃并告警。"""
    if raw is None or raw == "":
        return {}
    try:
        data = json.loads(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        logger.warning("ai_quota_defaults 不是合法 JSON（按空处理）：%r", raw)
        return {}
    if not isinstance(data, dict):
        logger.warning("ai_quota_defaults 不是对象（按空处理）：%r", raw)
        return {}
    parsed: dict[str, int] = {}
    for feature, value in data.items():
        if feature not in FEATURE_LIMIT_ATTRS:
            logger.warning("ai_quota_defaults 含未知功能 %r（已忽略）。", feature)
            continue
        if isinstance(value, bool) or not isinstance(value, int):
            logger.warning(
                "ai_quota_defaults[%r] 不是整数（已忽略）：%r", feature, value
            )
            continue
        if not 0 <= value <= MAX_LIMIT:
            logger.warning(
                "ai_quota_defaults[%r] 超出 0..%s（已忽略）：%r",
                feature,
                MAX_LIMIT,
                value,
            )
            continue
        parsed[feature] = value
    return parsed


def _load_stored_defaults() -> dict[str, int]:
    """读库里的全局默认覆盖值（缺表/缺库 → 空 dict，回落 env）。"""
    conn = _read_connect()
    if conn is None:
        return {}
    try:
        if not _table_exists(conn, "app_settings"):
            return {}
        row = conn.execute(
            "SELECT value FROM app_settings WHERE key = ?", (DEFAULTS_KEY,)
        ).fetchone()
    finally:
        conn.close()
    return {} if row is None else _parse_defaults(row["value"])


def _cached_defaults() -> dict[str, int]:
    global _defaults_cache
    now = _clock()
    db_key = _db_key()
    cached = _defaults_cache
    if cached is not None and cached[0] > now and cached[1] == db_key:
        return cached[2]
    try:
        value = _load_stored_defaults()
    except sqlite3.Error as exc:  # noqa: BLE001 - 展示/运行时不能因读失败挂掉
        logger.warning("读取 ai_quota_defaults 失败（按空处理）：%s", exc)
        value = {}
    _defaults_cache = (now + CACHE_SECONDS, db_key, value)
    return value


def global_defaults() -> dict[str, int]:
    """当前全局默认覆盖值（只含显式配置过的功能；缺省项回落 env）。"""
    return dict(_cached_defaults())


def default_limit(feature: str) -> tuple[int, str]:
    """默认层解析：``(limit, source)``，``source`` ∈ ``{"default", "config"}``。"""
    name = validate_feature(feature)
    stored = _cached_defaults()
    if name in stored:
        return stored[name], "default"
    return _config_default(name), "config"


# ---------------------------------------------------------------------------
# 单用户覆盖层（quota_overrides）
# ---------------------------------------------------------------------------

def _load_overrides(user_id: str) -> dict[str, int]:
    conn = _read_connect()
    if conn is None:
        raise _unavailable(f"数据库文件不存在：{config.AUTH_DB_PATH}")
    try:
        if not _table_exists(conn, OVERRIDES_TABLE):
            _warn_missing_overrides_once()
            raise _unavailable(f"{OVERRIDES_TABLE} 表不存在（未跑 0031 迁移）")
        rows = conn.execute(
            f"SELECT feature, limit_units FROM {OVERRIDES_TABLE} WHERE user_id = ?",
            (user_id,),
        ).fetchall()
    except sqlite3.Error as exc:
        raise _unavailable(f"读取 {OVERRIDES_TABLE} 失败：{exc}") from exc
    finally:
        conn.close()
    overrides: dict[str, int] = {}
    for row in rows:
        feature = row["feature"]
        if feature not in FEATURE_LIMIT_ATTRS:
            logger.warning(
                "%s 含未知功能 %r（已忽略；见 QUOTA_FEATURES）。",
                OVERRIDES_TABLE,
                feature,
            )
            continue
        try:
            overrides[feature] = max(0, min(MAX_LIMIT, int(row["limit_units"])))
        except (TypeError, ValueError):
            logger.warning(
                "%s 的 limit_units 非法（已忽略）：user=%r feature=%r value=%r",
                OVERRIDES_TABLE,
                user_id,
                feature,
                row["limit_units"],
            )
    return overrides


def user_overrides(user_id: str) -> dict[str, int]:
    """某个用户的覆盖值（只含显式覆盖的功能）；表未迁移抛异常（管理 API → 503）。"""
    if not isinstance(user_id, str) or not user_id:
        raise ValueError("user_id 必须是非空字符串。")
    now = _clock()
    cache_key = (_db_key(), user_id)
    cached = _overrides_cache.get(cache_key)
    if cached is not None and cached[0] > now:
        return dict(cached[1])
    value = _load_overrides(user_id)
    if len(_overrides_cache) > 256:  # 进程内缓存不无限增长
        _overrides_cache.clear()
    _overrides_cache[cache_key] = (now + CACHE_SECONDS, value)
    return dict(value)


def effective_limit(
    feature: str, user_id: str | None = None
) -> tuple[int, str, int, int | None]:
    """解析生效额度：``(limit, source, default_limit, override_limit)``。

    - ``source``：``"user_override"`` > ``"default"``（后台全局默认） >
      ``"config"``（env 兜底）；
    - ``0`` 表示关闭该功能；
    - ``user_id`` 为空时只看默认层（脚本/旧调用）；
    - 覆盖表未迁移时抛 :class:`QuotaConfigUnavailable`，由调用方决定 503
      还是运行时 fail-open（见 ``ai.quota``）。
    """
    name = validate_feature(feature)
    default_value, source = default_limit(name)
    limit = default_value
    override: int | None = None
    if user_id:
        override = user_overrides(user_id).get(name)
        if override is not None:
            limit = override
            source = "user_override"
    return limit, source, default_value, override


# ---------------------------------------------------------------------------
# 写入（管理端用；单事务 + 写后清缓存）
# ---------------------------------------------------------------------------

def _now_ms() -> int:
    return int(time.time() * 1000)


def _write_connect() -> sqlite3.Connection:
    """写连接：走 ``auth_db.connect``（含旧库兼容建表），调用方负责 commit/close。"""
    return auth_db.connect()


def set_defaults(changes: object) -> dict:
    """写全局默认（单条 ``app_settings`` upsert，一个事务）。

    ``None`` 删除该功能的键（回继承 env/config）。返回
    ``{"previous": {...}, "stored": {...}, "changes": {...}}``：``previous`` 是
    改动前的**显式存储值**（缺项为 ``None`` = 当时继承 env），``changes`` 的
    ``from/to`` 同样是存储值语义。表未迁移抛 :class:`QuotaConfigUnavailable`。
    """
    validated = validate_changes(changes)
    conn = _write_connect()
    try:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE")
        if not _table_exists(conn, "app_settings"):
            raise _unavailable("app_settings 表不存在（未跑 0013 迁移）")
        row = conn.execute(
            "SELECT value FROM app_settings WHERE key = ?", (DEFAULTS_KEY,)
        ).fetchone()
        previous = {} if row is None else _parse_defaults(row["value"])
        merged = dict(previous)
        for feature, value in validated.items():
            if value is None:
                merged.pop(feature, None)
            else:
                merged[feature] = value
        if merged:
            conn.execute(
                "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET "
                "value = excluded.value, updated_at = excluded.updated_at",
                (
                    DEFAULTS_KEY,
                    json.dumps(merged, ensure_ascii=False, sort_keys=True),
                    _now_ms(),
                ),
            )
        else:
            # 全部回退 env 时删掉键，避免 app_settings 里留下空对象。
            conn.execute(
                "DELETE FROM app_settings WHERE key = ?", (DEFAULTS_KEY,)
            )
        conn.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    finally:
        conn.close()
    invalidate()
    return {
        "previous": {feature: previous.get(feature) for feature in validated},
        "stored": merged,
        "changes": {
            feature: {"from": previous.get(feature), "to": validated[feature]}
            for feature in validated
        },
    }


def apply_overrides(
    user_id: str,
    changes: object,
    *,
    reason: str | None,
    created_by: str | None,
) -> dict:
    """批量写/删单用户覆盖（**一个事务**）：``None`` → 删除该功能覆盖。

    返回 ``{"changes": {feature: {"from": 旧覆盖值|null, "to": 新覆盖值|null}},
    "overrides": 写入后的覆盖表}``；表未迁移抛 :class:`QuotaConfigUnavailable`。
    """
    if not isinstance(user_id, str) or not user_id:
        raise ValueError("user_id 必须是非空字符串。")
    validated = validate_changes(changes)
    timestamp = _now_ms()
    conn = _write_connect()
    try:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE")
        if not _table_exists(conn, OVERRIDES_TABLE):
            raise _unavailable(f"{OVERRIDES_TABLE} 表不存在（未跑 0031 迁移）")
        rows = conn.execute(
            f"SELECT feature, limit_units FROM {OVERRIDES_TABLE} WHERE user_id = ?",
            (user_id,),
        ).fetchall()
        previous = {row["feature"]: int(row["limit_units"]) for row in rows}
        remaining = dict(previous)
        for feature, value in validated.items():
            if value is None:
                remaining.pop(feature, None)
                conn.execute(
                    f"DELETE FROM {OVERRIDES_TABLE} "
                    "WHERE user_id = ? AND feature = ?",
                    (user_id, feature),
                )
            else:
                remaining[feature] = value
                conn.execute(
                    f"INSERT INTO {OVERRIDES_TABLE} ("
                    "user_id, feature, limit_units, reason, created_by, "
                    "created_at_ms, updated_at_ms"
                    ") VALUES (?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(user_id, feature) DO UPDATE SET "
                    "limit_units = excluded.limit_units, "
                    "reason = excluded.reason, "
                    "created_by = excluded.created_by, "
                    "updated_at_ms = excluded.updated_at_ms",
                    (
                        user_id,
                        feature,
                        value,
                        reason,
                        created_by,
                        timestamp,
                        timestamp,
                    ),
                )
        conn.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    finally:
        conn.close()
    invalidate()
    if len(_overrides_cache) > 256:
        _overrides_cache.clear()
    _overrides_cache[(_db_key(), user_id)] = (_clock() + CACHE_SECONDS, remaining)
    return {
        "changes": {
            feature: {
                "from": previous.get(feature),
                "to": validated[feature],
            }
            for feature in validated
        },
        "overrides": remaining,
    }


def snapshot_defaults() -> list[dict]:
    """管理端「默认值表」：8 个功能的默认值与来源（按 ``QUOTA_FEATURES`` 顺序）。"""
    features: list[dict] = []
    for feature in QUOTA_FEATURES:
        limit, source = default_limit(feature)
        features.append(
            {"feature": feature, "defaultLimit": limit, "source": source}
        )
    return features


__all__ = [
    "CACHE_SECONDS",
    "DEFAULTS_KEY",
    "FEATURE_LIMIT_ATTRS",
    "InvalidQuotaChange",
    "InvalidQuotaFeature",
    "InvalidQuotaLimit",
    "MAX_LIMIT",
    "OVERRIDES_TABLE",
    "QUOTA_FEATURES",
    "QuotaConfigUnavailable",
    "apply_overrides",
    "default_limit",
    "effective_limit",
    "global_defaults",
    "invalidate",
    "reset_cache",
    "set_defaults",
    "snapshot_defaults",
    "user_overrides",
    "validate_changes",
    "validate_feature",
    "validate_limit",
]
