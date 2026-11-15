"""账号资料 / 余额 / 应用设置 / 维护模式（V1 用户需求 1–3 / specs/023）。

三块职责：

1. **用户名**：注册与 ``PATCH /api/user/profile`` 共用的校验（2–24 字符，
   中文/英文/数字/下划线/连字符，首尾不能是空白；不要求全局唯一）。
2. **余额（credits）**：管理员手动调账的唯一入口。调账在
   ``BEGIN IMMEDIATE`` 事务里完成「校验余额 → 更新 users.credits → 追加
   credit_transactions」，不允许扣成负数；流水 append-only。
3. **应用设置 / 维护模式**：``app_settings`` 键值表（``maintenance_mode``、
   ``announcement``）。维护模式在身份中间件里读取，进程内缓存 5 秒
   （``SETTINGS_CACHE_SECONDS``）避免每个请求都打 SQLite；管理员在后台改完
   设置会立刻失效缓存，测试可用 ``reset_settings_cache()`` 清空。

用户页摘要（``GET /api/user/summary``）也在这里聚合：

- ``monthSpendUsd``：``ai_usage`` 当月 ``SUM(est_cost_usd)``（账本估算值，
  不是真实账单；月份边界按 ``AI_QUOTA_TIMEZONE``）；
- ``usageToday.minutes``：``watch_events`` 当地今天 ``watched_seconds`` 合计
  ÷ 60（没有观看数据为 0）；
- ``version``：``config.APP_VERSION``；
- ``preliminary``：统计源表缺失（旧库未迁移 / 账本不可用）时为 true，
  表示这些数字是估算/降级值；正常为 false。

数据表由迁移 ``0013_user_profile`` 创建。运行时**不建表**：写设置或调账时
表缺失抛 ``SettingsUnavailable`` / ``CreditsUnavailable``，路由转 503；维护
模式读取失败按「未开启」处理（不让设置表故障把整个 API 拖进维护态）。
"""
from __future__ import annotations

import logging
import os
import re
import sqlite3
import time
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import auth_db
import config

logger = logging.getLogger("linguatrek.account")

# --- 用户名 -----------------------------------------------------------------
USERNAME_MIN_LENGTH = 2
USERNAME_MAX_LENGTH = 24
# 中文（基本区 + 扩展 A）/ 英文 / 数字 / 下划线 / 连字符；不含空白与其它符号。
_USERNAME_RE = re.compile(r"^[A-Za-z0-9_\-\u3400-\u4dbf\u4e00-\u9fff]+$")

# --- 账号状态 ---------------------------------------------------------------
STATUS_ACTIVE = "active"
STATUS_BANNED = "banned"
STATUSES = (STATUS_ACTIVE, STATUS_BANNED)

# --- 余额调账 ---------------------------------------------------------------
MAX_CREDIT_DELTA = 100_000
MAX_CREDIT_REASON_LENGTH = 200

# --- 应用设置 ---------------------------------------------------------------
MAINTENANCE_KEY = "maintenance_mode"
ANNOUNCEMENT_KEY = "announcement"
SETTINGS_CACHE_SECONDS = 5.0

_maintenance_cache: tuple[float, bool] | None = None

# ``announcement`` 需要区分「未传（不改）」与「显式 null（清空）」。
_UNSET = object()


class InvalidUsername(ValueError):
    """用户名不满足 2–24 字符/字符集/首尾空白规则。"""


class InvalidAdjustment(ValueError):
    """调账参数非法（delta 为 0/越界、reason 长度不对）。"""


class UserNotFound(Exception):
    """目标用户不存在。"""


class InsufficientCredits(Exception):
    """扣减后余额为负：拒绝本次调账，余额不变。"""

    def __init__(self, current: int, delta: int) -> None:
        super().__init__(f"余额不足：当前 {current}，本次 {delta}")
        self.current = current
        self.delta = delta


class CannotBanSelf(Exception):
    """管理员不能封禁自己。"""


class LastAdmin(Exception):
    """不能封禁最后一个可用的管理员。"""


class SettingsUnavailable(Exception):
    """app_settings 表缺失（旧库未跑迁移）。"""


class CreditsUnavailable(Exception):
    """users.credits / credit_transactions 表缺失（旧库未跑迁移）。"""


# ---------------------------------------------------------------------------
# 用户名
# ---------------------------------------------------------------------------

def validate_username(raw: object) -> str:
    """校验并返回用户名；不合法抛 :class:`InvalidUsername`（中文原因）。

    不做 trim：首尾空白按非法处理（需求：不允许空白开头结尾）。
    """
    if not isinstance(raw, str):
        raise InvalidUsername("用户名必须是字符串。")
    if len(raw) < USERNAME_MIN_LENGTH:
        raise InvalidUsername(
            f"用户名至少需要 {USERNAME_MIN_LENGTH} 个字符。"
        )
    if len(raw) > USERNAME_MAX_LENGTH:
        raise InvalidUsername(
            f"用户名最多 {USERNAME_MAX_LENGTH} 个字符。"
        )
    if raw != raw.strip():
        raise InvalidUsername("用户名首尾不能是空白。")
    if not _USERNAME_RE.match(raw):
        raise InvalidUsername(
            "用户名只能包含中文、英文、数字、下划线或连字符。"
        )
    return raw


def public_user(row: dict) -> dict:
    """对外的用户字段（注册/登录/me/资料更新共用；不含 created_at）。"""
    return {
        "id": row["id"],
        "email": row["email"],
        "username": row.get("username"),
        "credits": int(row.get("credits") or 0),
        "status": row.get("status") or STATUS_ACTIVE,
    }


def update_username(user_id: str, username: object) -> dict:
    """更新用户名并返回公开用户字段；用户不存在抛 :class:`UserNotFound`。"""
    username = validate_username(username)
    conn = auth_db.connect()
    try:
        row = conn.execute(
            "SELECT id, email, username, credits, status FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if row is None:
            raise UserNotFound(user_id)
        conn.execute(
            "UPDATE users SET username = ? WHERE id = ?", (username, user_id)
        )
        conn.commit()
    finally:
        conn.close()
    updated = dict(row)
    updated["username"] = username
    return public_user(updated)


# ---------------------------------------------------------------------------
# 账号状态（封禁 / 解封）
# ---------------------------------------------------------------------------

def _active_admin_count(conn: sqlite3.Connection, exclude_user_id: str) -> int:
    """除目标用户外，管理名单里仍为 active 的用户数。"""
    rows = conn.execute("SELECT id, email, status FROM users").fetchall()
    return sum(
        1
        for row in rows
        if row["id"] != exclude_user_id
        and (row["status"] or STATUS_ACTIVE) == STATUS_ACTIVE
        and config.is_admin_email(row["email"])
    )


def set_user_status(
    user_id: str, status: str, *, actor_id: str | None = None
) -> dict:
    """把用户状态改为 active/banned，返回含 createdAt(ms) 的后台用户对象。

    规则（需求：不能封禁自己 / 最后一个管理员）：

    - 封禁自己 → :class:`CannotBanSelf`；
    - 封禁管理名单里的最后一个 active 管理员 → :class:`LastAdmin`；
    - 目标不存在 → :class:`UserNotFound`。解封永远允许。
    """
    if status not in STATUSES:
        raise ValueError(f"未知用户状态：{status!r}")
    conn = auth_db.connect()
    try:
        row = conn.execute(
            "SELECT id, email, username, credits, status, created_at "
            "FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if row is None:
            raise UserNotFound(user_id)
        if status == STATUS_BANNED and row["status"] != STATUS_BANNED:
            if actor_id and actor_id == user_id:
                raise CannotBanSelf(user_id)
            if config.is_admin_email(row["email"]) and _active_admin_count(
                conn, user_id
            ) < 1:
                raise LastAdmin(user_id)
        if (row["status"] or STATUS_ACTIVE) != status:
            conn.execute(
                "UPDATE users SET status = ? WHERE id = ?", (status, user_id)
            )
            conn.commit()
    finally:
        conn.close()
    result = dict(row)
    result["status"] = status
    return {
        "id": result["id"],
        "email": result["email"],
        "username": result["username"],
        "credits": int(result["credits"] or 0),
        "status": result["status"],
        "createdAt": int(result["created_at"] or 0) * 1000,
    }


# ---------------------------------------------------------------------------
# 余额调整 + 流水
# ---------------------------------------------------------------------------

def validate_adjustment(delta: object, reason: object) -> tuple[int, str]:
    """校验调账参数；不合法抛 :class:`InvalidAdjustment`（中文原因）。"""
    if isinstance(delta, bool) or not isinstance(delta, int):
        raise InvalidAdjustment("调整金额必须是整数。")
    if delta == 0:
        raise InvalidAdjustment("调整金额不能为 0。")
    if abs(delta) > MAX_CREDIT_DELTA:
        raise InvalidAdjustment(
            f"调整金额范围为 -{MAX_CREDIT_DELTA}..{MAX_CREDIT_DELTA}。"
        )
    if not isinstance(reason, str):
        raise InvalidAdjustment("调整原因必须是字符串。")
    reason = reason.strip()
    if not 1 <= len(reason) <= MAX_CREDIT_REASON_LENGTH:
        raise InvalidAdjustment(
            f"调整原因需要 1–{MAX_CREDIT_REASON_LENGTH} 个字符。"
        )
    return delta, reason


def adjust_credits(
    user_id: str,
    delta: int,
    reason: str,
    admin_id: str | None = None,
) -> int:
    """原子调账：更新余额并追加流水，返回新余额。

    - 正向发放/负向扣减都走 ``BEGIN IMMEDIATE``，并发调账不会丢更新；
    - 扣减后 < 0 → :class:`InsufficientCredits`，余额与流水都不写；
    - 用户不存在 → :class:`UserNotFound`；表/列缺失 → :class:`CreditsUnavailable`。
    """
    delta, reason = validate_adjustment(delta, reason)
    conn = auth_db.connect()
    try:
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT credits FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            if row is None:
                raise UserNotFound(user_id)
            current = int(row["credits"] or 0)
            new_balance = current + delta
            if new_balance < 0:
                raise InsufficientCredits(current, delta)
            conn.execute(
                "UPDATE users SET credits = ? WHERE id = ?",
                (new_balance, user_id),
            )
            conn.execute(
                "INSERT INTO credit_transactions "
                "(id, user_id, delta, reason, admin_id, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    uuid.uuid4().hex,
                    user_id,
                    delta,
                    reason,
                    admin_id,
                    int(time.time() * 1000),
                ),
            )
            conn.commit()
        except sqlite3.OperationalError as exc:
            conn.rollback()
            message = str(exc)
            if "credit_transactions" in message or "no such column" in message:
                raise CreditsUnavailable(message) from exc
            raise
    finally:
        conn.close()
    return new_balance


# ---------------------------------------------------------------------------
# 应用设置 / 维护模式
# ---------------------------------------------------------------------------

def _read_connect() -> sqlite3.Connection | None:
    """只读连接；库文件不存在返回 None（绝不顺手建库）。"""
    path = config.AUTH_DB_PATH
    if not os.path.exists(path):
        return None
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?", (table,)
    ).fetchone()
    return row is not None


def _read_settings_raw() -> dict[str, str | None]:
    """读 app_settings（无表/无库 → 空 dict）。只读、不建表。"""
    conn = _read_connect()
    if conn is None:
        return {}
    try:
        if not _table_exists(conn, "app_settings"):
            return {}
        rows = conn.execute("SELECT key, value FROM app_settings").fetchall()
    except sqlite3.Error as exc:
        logger.warning("读取 app_settings 失败（按默认值处理）：%s", exc)
        return {}
    finally:
        conn.close()
    return {row["key"]: row["value"] for row in rows}


def _maintenance_from_raw(raw: dict[str, str | None]) -> bool:
    return str(raw.get(MAINTENANCE_KEY) or "").strip() == "1"


def get_settings() -> dict:
    """当前设置（维护模式 bool + 公告 str|null）；表缺失时返回默认值。"""
    raw = _read_settings_raw()
    return {
        "maintenance_mode": _maintenance_from_raw(raw),
        "announcement": raw.get(ANNOUNCEMENT_KEY),
    }


def maintenance_enabled() -> bool:
    """维护模式是否开启（进程内缓存 5 秒；读失败按未开启）。"""
    global _maintenance_cache
    now = time.monotonic()
    cached = _maintenance_cache
    if cached is not None and now < cached[0]:
        return cached[1]
    try:
        enabled = _maintenance_from_raw(_read_settings_raw())
    except Exception as exc:  # noqa: BLE001 - 设置故障不能把整个 API 拖进维护态
        logger.warning("读取维护模式失败（按未开启处理）：%s", exc)
        enabled = False
    _maintenance_cache = (now + SETTINGS_CACHE_SECONDS, enabled)
    return enabled


def reset_settings_cache() -> None:
    """清空维护模式进程内缓存（测试/运维排障用）。"""
    global _maintenance_cache
    _maintenance_cache = None


def update_settings(
    *,
    maintenance_mode: object = _UNSET,
    announcement: object = _UNSET,
) -> dict:
    """按字段 upsert 设置并返回当前值；表缺失抛 :class:`SettingsUnavailable`。

    ``announcement=None`` 是合法值（清空公告）；只有完全不传该字段才保留原值。
    """
    updates: dict[str, str | None] = {}
    if maintenance_mode is not _UNSET:
        if not isinstance(maintenance_mode, bool):
            raise ValueError("maintenance_mode 必须是布尔值。")
        updates[MAINTENANCE_KEY] = "1" if maintenance_mode else "0"
    if announcement is not _UNSET:
        if announcement is not None and not isinstance(announcement, str):
            raise ValueError("announcement 必须是字符串或 null。")
        updates[ANNOUNCEMENT_KEY] = announcement
    if not updates:
        return get_settings()

    conn = auth_db.connect()
    try:
        try:
            now = int(time.time())
            for key, value in updates.items():
                conn.execute(
                    "INSERT INTO app_settings (key, value, updated_at) "
                    "VALUES (?, ?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET "
                    "value = excluded.value, updated_at = excluded.updated_at",
                    (key, value, now),
                )
            conn.commit()
        except sqlite3.OperationalError as exc:
            conn.rollback()
            if "app_settings" in str(exc) or "no such table" in str(exc):
                raise SettingsUnavailable(str(exc)) from exc
            raise
    finally:
        conn.close()

    current = get_settings()
    if MAINTENANCE_KEY in updates:
        global _maintenance_cache
        _maintenance_cache = (
            time.monotonic() + SETTINGS_CACHE_SECONDS,
            current["maintenance_mode"],
        )
    return current


# ---------------------------------------------------------------------------
# 用户页摘要
# ---------------------------------------------------------------------------

def _timezone() -> ZoneInfo:
    """配额/统计「今天/当月」的时区；非法配置回落 UTC。"""
    name = getattr(config, "AI_QUOTA_TIMEZONE", "Asia/Shanghai") or "Asia/Shanghai"
    try:
        return ZoneInfo(name)
    except Exception:  # noqa: BLE001 - 非法时区不能让摘要 500
        logger.warning("AI_QUOTA_TIMEZONE=%r 非法，用户摘要按 UTC 计算。", name)
        return ZoneInfo("UTC")


def _month_bounds() -> tuple[str, str]:
    """当地当月 → [`YYYY-MM-01`, 下月 1 日) 的字符串边界（与 ai_usage 同口径）。"""
    now = datetime.now(_timezone())
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = (start + timedelta(days=32)).replace(day=1)
    return start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")


def _today_bounds_ms() -> tuple[int, int]:
    """当地今天 [00:00, 次日 00:00) 的毫秒时间戳边界。"""
    start = datetime.now(_timezone()).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    end = start + timedelta(days=1)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def _month_spend_usd(user_id: str) -> tuple[float, bool]:
    """本月 AI 花费（估算）+ 是否降级（表缺失）。"""
    conn = _read_connect()
    if conn is None:
        return 0.0, True
    try:
        if not _table_exists(conn, "ai_usage"):
            return 0.0, True
        start, end = _month_bounds()
        row = conn.execute(
            "SELECT SUM(est_cost_usd) FROM ai_usage "
            "WHERE user_id = ? AND usage_date >= ? AND usage_date < ?",
            (user_id, start, end),
        ).fetchone()
        return round(float(row[0] or 0.0), 6), False
    except sqlite3.Error as exc:
        logger.warning("用户本月 AI 花费查询失败（按 0 处理）：%s", exc)
        return 0.0, True
    finally:
        conn.close()


def _today_minutes(user_id: str) -> tuple[float, bool]:
    """今天观看分钟数（watch_events.watched_seconds 合计 ÷ 60）+ 是否降级。"""
    conn = _read_connect()
    if conn is None:
        return 0.0, True
    try:
        if not _table_exists(conn, "watch_events"):
            return 0.0, True
        start, end = _today_bounds_ms()
        row = conn.execute(
            "SELECT SUM(watched_seconds) FROM watch_events "
            "WHERE user_id = ? AND occurred_at >= ? AND occurred_at < ?",
            (user_id, start, end),
        ).fetchone()
        seconds = float(row[0] or 0.0)
        return round(seconds / 60.0, 2), False
    except sqlite3.Error as exc:
        logger.warning("用户今日学习分钟查询失败（按 0 处理）：%s", exc)
        return 0.0, True
    finally:
        conn.close()


def build_summary(user_id: str) -> dict:
    """``GET /api/user/summary`` 的响应体；数字无数据时为 0。"""
    user = auth_db.get_user_by_id(user_id)
    if user is None:
        raise UserNotFound(user_id)
    month_spend, spend_degraded = _month_spend_usd(user_id)
    minutes, usage_degraded = _today_minutes(user_id)
    return {
        "user": {
            "id": user["id"],
            "email": user["email"],
            "username": user["username"],
            "credits": int(user["credits"] or 0),
            "memberSince": int(user["created_at"] or 0) * 1000,
            "status": user["status"],
        },
        "monthSpendUsd": month_spend,
        "usageToday": {"minutes": minutes},
        "version": config.APP_VERSION,
        "preliminary": bool(spend_degraded or usage_degraded),
    }
