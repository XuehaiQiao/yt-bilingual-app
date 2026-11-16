"""后台管理（Admin）：只读止血台 + 运营写操作（用户需求 #12 / 1–3）。

原有只读止血台（M1 ⑥，specs/021-admin）：用户量/活跃、AI 花费与配额、任务
状态、错误概览。2026-11-16 起按 specs/023-user-profile 增加运营写操作：

- ``GET  /api/admin/users``：在原有字段上增加 username / credits / status；
- ``POST /api/admin/users/{id}/credits``：手动调余额（原子更新 + 流水，不允许负余额）；
- ``PATCH /api/admin/users/{id}``：封禁/解封（不能封自己或最后一个管理员）；
- ``GET/PUT /api/admin/settings``：维护模式与公告。

身份（见 config.py / routes_auth.py / specs/021-admin）：

- 管理员 = ``ADMIN_EMAILS`` 环境变量（逗号分隔、大小写不敏感）；默认空 =
  没有管理员；
- ``/api/admin/*`` 需登录 + 管理员：未登录 401，普通用户 403；封禁账号由
  身份中间件在进入路由前 403；
- 读聚合用只读连接（``PRAGMA query_only = ON``），写操作只经 ``account.py``
  的受控函数；不提供删除用户/改密码/退款等其它写操作。

「今天/当月」按 ``AI_QUOTA_TIMEZONE``（默认 Asia/Shanghai）划分，与
``ai.ledger`` 的 ``usage_date`` 同口径。所有成本单位是美元（est_cost_usd，
账本里的估算值，不是真实账单）。
"""
from __future__ import annotations

import logging
import os
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import AliasChoices, BaseModel, Field

import account
import behavior_events
import config
import guest
import observability

logger = logging.getLogger("linguatrek.admin")

router = APIRouter(prefix="/api/admin", tags=["admin"])

_MAX_SEARCH_CHARS = 100
_MAX_ERROR_CHARS = 500
_MAX_FAILED_JOBS = 10
_MAX_ANNOUNCEMENT_CHARS = 2000


# ---------------------------------------------------------------------------
# 写操作请求模型（specs/023）
# ---------------------------------------------------------------------------

class CreditAdjustRequest(BaseModel):
    """``POST /users/{id}/credits``：整数金额 + 原因；校验在 account 里做。"""

    delta: int | None = None
    reason: str | None = None


class UserPatchRequest(BaseModel):
    """``PATCH /users/{id}``：只支持 status（active/banned）。"""

    status: str | None = None
    # 需求明确「isAdmin 不实现」：显式传了就 400，避免被误以为已经改成功。
    is_admin: bool | None = Field(
        default=None,
        validation_alias=AliasChoices("isAdmin", "is_admin"),
    )


class SettingsUpdateRequest(BaseModel):
    """``PUT /settings``：字段可选；announcement 可为 null（清空公告）。"""

    maintenance_mode: bool | None = None
    announcement: str | None = None


# ---------------------------------------------------------------------------
# 身份
# ---------------------------------------------------------------------------

def require_admin(request: Request) -> dict:
    """登录 + 管理员校验；未登录 401、非管理员 403（不泄露管理员名单）。"""
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="未登录")
    if not config.is_admin_email(user.get("email")):
        raise HTTPException(status_code=403, detail="需要管理员权限。")
    return user


# ---------------------------------------------------------------------------
# 时间 / 连接工具
# ---------------------------------------------------------------------------

def _timezone() -> ZoneInfo:
    """配额日边界时区；非法配置回落 UTC（与 ai.ledger 的容错口径一致）。"""
    name = getattr(config, "AI_QUOTA_TIMEZONE", "Asia/Shanghai") or "Asia/Shanghai"
    try:
        return ZoneInfo(name)
    except Exception:  # noqa: BLE001 - 非法时区不能让止血台 500
        logger.warning("AI_QUOTA_TIMEZONE=%r 非法，后台止血台按 UTC 计算。", name)
        return ZoneInfo("UTC")


def _iso_utc(moment: datetime | None = None) -> str:
    """UTC ISO8601（毫秒精度，Z 结尾）。"""
    value = moment or datetime.now(timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _now_local() -> datetime:
    return datetime.now(_timezone())


def _day_str(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%d")


def _today_str() -> str:
    return _day_str(_now_local())


def _month_str() -> str:
    return _now_local().strftime("%Y-%m")


def _today_bounds_ms() -> tuple[int, int]:
    """当地「今天」左闭右开的毫秒边界。"""
    start = _now_local().replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def _month_bounds(month: str) -> tuple[str, str]:
    """``YYYY-MM`` → [本月 1 日, 下月 1 日) 的字符串边界。"""
    year, mon = (int(part) for part in month.split("-", 1))
    if not 1 <= mon <= 12:
        raise ValueError(f"非法月份：{month!r}")
    start = f"{year:04d}-{mon:02d}-01"
    end = f"{year + 1:04d}-01-01" if mon == 12 else f"{year:04d}-{mon + 1:02d}-01"
    return start, end


def _connect() -> sqlite3.Connection | None:
    """只读连接；库文件不存在返回 None（绝不顺手建一个空库）。"""
    path = config.AUTH_DB_PATH
    if not os.path.exists(path):
        return None
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    # 只读保证：即使以后有人在本模块误加写语句，SQLite 也会拒绝。
    conn.execute("PRAGMA query_only = ON")
    return conn


@contextmanager
def _db():
    conn = _connect()
    if conn is None:
        yield None
        return
    try:
        yield conn
    finally:
        conn.close()


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?", (name,)
    ).fetchone()
    return row is not None


def _scalar(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> float | int:
    """执行单行单列查询；失败返回 0（止血台不能因为一条统计挂掉）。"""
    try:
        row = conn.execute(sql, params).fetchone()
    except sqlite3.Error as exc:
        logger.warning("后台统计查询失败（已降级为 0）：%s", exc)
        return 0
    if row is None or row[0] is None:
        return 0
    return row[0]


def _round_money(value: object) -> float:
    return round(float(value or 0.0), 6)


def _guest_count() -> int:
    """``GUEST_DATA_DIR`` 下形状合法的游客目录数（只读，不建目录）。

    刻意不调用 ``guest.guests_root()``：那个函数会 ``os.makedirs``，而止血台
    必须零副作用（没有游客时不能凭空建出一个空目录）。
    """
    try:
        root = getattr(config, "GUEST_DATA_DIR", None) or os.path.join(
            config.DATA_DIR, "guests"
        )
    except Exception:  # noqa: BLE001 - 配置损坏不影响其它统计
        return 0
    if not os.path.isdir(root):
        return 0
    count = 0
    try:
        with os.scandir(root) as entries:
            for entry in entries:
                if guest.is_valid_guest_hash(entry.name) and entry.is_dir(
                    follow_symlinks=False
                ):
                    count += 1
    except OSError as exc:
        logger.warning("读取游客目录失败：%s", exc)
        return 0
    return count


def _active_today(conn: sqlite3.Connection) -> int:
    """当地今天内 learning_events 或 attempts 出现过的去重 user_id 数。"""
    start, end = _today_bounds_ms()
    sources: list[str] = []
    if _table_exists(conn, "learning_events"):
        sources.append(
            "SELECT user_id FROM learning_events "
            "WHERE occurred_at >= ? AND occurred_at < ? AND user_id IS NOT NULL"
        )
    if _table_exists(conn, "attempts"):
        sources.append(
            "SELECT user_id FROM attempts "
            "WHERE answered_at >= ? AND answered_at < ? AND user_id IS NOT NULL"
        )
    if not sources:
        return 0
    union = " UNION ".join(sources)
    params: list[int] = []
    for _ in sources:
        params.extend([start, end])
    try:
        row = conn.execute(
            f"SELECT COUNT(*) FROM ({union}) AS active", tuple(params)
        ).fetchone()
    except sqlite3.Error as exc:
        logger.warning("今日活跃查询失败（已降级为 0）：%s", exc)
        return 0
    return int(row[0] or 0) if row else 0


# ---------------------------------------------------------------------------
# 总览
# ---------------------------------------------------------------------------

def _empty_stats() -> dict:
    return {
        "users": {"total": 0, "new7d": 0, "activeToday": 0, "guests": _guest_count()},
        "ai": {
            "todayCostUsd": 0.0,
            "monthCostUsd": 0.0,
            "todayCalls": 0,
            "todayByFeature": {},
        },
        "jobs": {"failed": 0, "running": 0, "pendingRetry": 0},
        "generatedAt": _iso_utc(),
    }


def build_stats() -> dict:
    """``GET /api/admin/stats`` 的数据体（独立成函数便于测试/复用）。"""
    stats = _empty_stats()
    with _db() as conn:
        if conn is None:
            return stats

        if _table_exists(conn, "users"):
            stats["users"]["total"] = int(
                _scalar(conn, "SELECT COUNT(*) FROM users") or 0
            )
            cutoff = int(time.time()) - 7 * 24 * 3600
            stats["users"]["new7d"] = int(
                _scalar(
                    conn,
                    "SELECT COUNT(*) FROM users WHERE created_at >= ?",
                    (cutoff,),
                )
                or 0
            )
        stats["users"]["activeToday"] = _active_today(conn)

        if _table_exists(conn, "ai_usage"):
            today = _today_str()
            month = _month_str()
            month_start, month_end = _month_bounds(month)
            stats["ai"]["todayCostUsd"] = _round_money(
                _scalar(
                    conn,
                    "SELECT SUM(est_cost_usd) FROM ai_usage WHERE usage_date = ?",
                    (today,),
                )
            )
            stats["ai"]["todayCalls"] = int(
                _scalar(
                    conn,
                    "SELECT SUM(calls) FROM ai_usage WHERE usage_date = ?",
                    (today,),
                )
                or 0
            )
            stats["ai"]["monthCostUsd"] = _round_money(
                _scalar(
                    conn,
                    "SELECT SUM(est_cost_usd) FROM ai_usage "
                    "WHERE usage_date >= ? AND usage_date < ?",
                    (month_start, month_end),
                )
            )
            try:
                rows = conn.execute(
                    "SELECT feature, SUM(calls) AS calls, "
                    "SUM(input_tokens) AS input_tokens, "
                    "SUM(output_tokens) AS output_tokens, "
                    "SUM(est_cost_usd) AS cost_usd "
                    "FROM ai_usage WHERE usage_date = ? GROUP BY feature "
                    "ORDER BY cost_usd DESC, feature ASC",
                    (today,),
                ).fetchall()
                stats["ai"]["todayByFeature"] = {
                    row["feature"]: {
                        "calls": int(row["calls"] or 0),
                        "inputTokens": int(row["input_tokens"] or 0),
                        "outputTokens": int(row["output_tokens"] or 0),
                        "costUsd": _round_money(row["cost_usd"]),
                    }
                    for row in rows
                }
            except sqlite3.Error as exc:
                logger.warning("今日功能用量查询失败（已降级为空）：%s", exc)

        if _table_exists(conn, "jobs"):
            try:
                rows = conn.execute(
                    "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"
                ).fetchall()
            except sqlite3.Error as exc:
                logger.warning("任务状态查询失败（已降级为 0）：%s", exc)
                rows = []
            counts = {row["status"]: int(row["n"] or 0) for row in rows}
            stats["jobs"] = {
                "failed": counts.get("failed", 0),
                "running": counts.get("running", 0),
                "pendingRetry": counts.get("queued", 0) + counts.get("partial", 0),
            }
    return stats


# ---------------------------------------------------------------------------
# 用户列表（搜索 + 分页）
# ---------------------------------------------------------------------------

def _escape_like(value: str) -> str:
    """转义 LIKE 通配符，搜索词按字面量匹配。"""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def build_users(limit: int = 50, offset: int = 0, search: str = "") -> dict:
    """``GET /api/admin/users`` 的数据体。

    保留 021 的既有字段（``id`` 前 8 位 / email / createdAt / monthCostUsd /
    eventCount / lastActiveAt），新增 ``username`` / ``credits`` / ``status``
    与完整 id ``userId``（调余额/封禁端点需要完整 id；列表展示仍用 8 位）。
    搜索同时匹配 email 与 username（大小写不敏感）。
    """
    limit = max(1, min(int(limit), 100))
    offset = max(0, min(int(offset), 100_000))
    query = (search or "").strip()[: _MAX_SEARCH_CHARS]

    result = {
        "users": [],
        "total": 0,
        "limit": limit,
        "offset": offset,
        "hasMore": False,
    }
    with _db() as conn:
        if conn is None or not _table_exists(conn, "users"):
            return result

        user_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(users)").fetchall()
        }
        has_profile = {"username", "credits", "status"} <= user_columns

        where = ""
        params: list[object] = []
        if query:
            like = f"%{_escape_like(query.lower())}%"
            if has_profile:
                where = (
                    " WHERE email LIKE ? ESCAPE '\\' "
                    "OR username LIKE ? ESCAPE '\\'"
                )
                params.extend([like, like])
            else:
                where = " WHERE email LIKE ? ESCAPE '\\'"
                params.append(like)

        result["total"] = int(
            _scalar(conn, f"SELECT COUNT(*) FROM users{where}", tuple(params)) or 0
        )
        selected = "id, email, created_at"
        if has_profile:
            selected += ", username, credits, status"
        try:
            rows = conn.execute(
                f"SELECT {selected} FROM users"
                f"{where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
                (*params, limit, offset),
            ).fetchall()
        except sqlite3.Error as exc:
            logger.warning("后台用户列表查询失败（已返回空列表）：%s", exc)
            return result

        month_start, month_end = _month_bounds(_month_str())
        has_usage = _table_exists(conn, "ai_usage")
        has_events = _table_exists(conn, "learning_events")
        has_attempts = _table_exists(conn, "attempts")

        users: list[dict] = []
        for row in rows:
            user_id = row["id"]
            month_cost = 0.0
            if has_usage:
                month_cost = _round_money(
                    _scalar(
                        conn,
                        "SELECT SUM(est_cost_usd) FROM ai_usage "
                        "WHERE user_id = ? AND usage_date >= ? AND usage_date < ?",
                        (user_id, month_start, month_end),
                    )
                )
            event_count = 0
            if has_events:
                event_count = int(
                    _scalar(
                        conn,
                        "SELECT COUNT(*) FROM learning_events WHERE user_id = ?",
                        (user_id,),
                    )
                    or 0
                )
            last_active: int | None = None
            if has_events:
                value = int(
                    _scalar(
                        conn,
                        "SELECT MAX(occurred_at) FROM learning_events WHERE user_id = ?",
                        (user_id,),
                    )
                    or 0
                )
                if value:
                    last_active = value
            if has_attempts:
                value = int(
                    _scalar(
                        conn,
                        "SELECT MAX(answered_at) FROM attempts WHERE user_id = ?",
                        (user_id,),
                    )
                    or 0
                )
                if value and (last_active is None or value > last_active):
                    last_active = value
            users.append(
                {
                    "id": user_id[:8],
                    "userId": user_id,
                    "email": row["email"],
                    "username": row["username"] if has_profile else None,
                    "credits": int(row["credits"] or 0) if has_profile else 0,
                    "status": (
                        row["status"] or account.STATUS_ACTIVE
                    ) if has_profile else account.STATUS_ACTIVE,
                    "createdAt": int(row["created_at"] or 0) * 1000,
                    "monthCostUsd": month_cost,
                    "eventCount": event_count,
                    "lastActiveAt": last_active,
                }
            )
        result["users"] = users
        result["hasMore"] = offset + len(users) < result["total"]
    return result


# ---------------------------------------------------------------------------
# 按天 / 功能用量
# ---------------------------------------------------------------------------

def build_usage(days: int = 7) -> dict:
    """``GET /api/admin/usage`` 的数据体：范围 [今天-(days-1), 今天]。"""
    days = max(1, min(int(days), 90))
    end_day = _today_str()
    start_day = _day_str(_now_local() - timedelta(days=days - 1))
    result: dict = {
        "days": days,
        "start": start_day,
        "end": end_day,
        "rows": [],
        "daysSummary": [],
        "totals": {
            "calls": 0,
            "inputTokens": 0,
            "outputTokens": 0,
            "costUsd": 0.0,
        },
    }
    with _db() as conn:
        if conn is None or not _table_exists(conn, "ai_usage"):
            return result
        try:
            rows = conn.execute(
                "SELECT usage_date, feature, SUM(calls) AS calls, "
                "SUM(input_tokens) AS input_tokens, "
                "SUM(output_tokens) AS output_tokens, "
                "SUM(est_cost_usd) AS cost_usd "
                "FROM ai_usage WHERE usage_date >= ? AND usage_date <= ? "
                "GROUP BY usage_date, feature "
                "ORDER BY usage_date ASC, cost_usd DESC, feature ASC",
                (start_day, end_day),
            ).fetchall()
        except sqlite3.Error as exc:
            logger.warning("后台用量查询失败（已返回空表）：%s", exc)
            return result

        totals = {
            "calls": 0,
            "inputTokens": 0,
            "outputTokens": 0,
            "costUsd": 0.0,
        }
        by_day: dict[str, dict] = {}
        for row in rows:
            item = {
                "day": row["usage_date"],
                "feature": row["feature"],
                "calls": int(row["calls"] or 0),
                "inputTokens": int(row["input_tokens"] or 0),
                "outputTokens": int(row["output_tokens"] or 0),
                "costUsd": _round_money(row["cost_usd"]),
            }
            result["rows"].append(item)
            for key in ("calls", "inputTokens", "outputTokens"):
                totals[key] += item[key]
            totals["costUsd"] += item["costUsd"]
            day = by_day.setdefault(
                item["day"], {"day": item["day"], "calls": 0, "costUsd": 0.0}
            )
            day["calls"] += item["calls"]
            day["costUsd"] += item["costUsd"]
        result["totals"] = {
            "calls": totals["calls"],
            "inputTokens": totals["inputTokens"],
            "outputTokens": totals["outputTokens"],
            "costUsd": _round_money(totals["costUsd"]),
        }
        result["daysSummary"] = [
            {
                "day": day,
                "calls": by_day[day]["calls"],
                "costUsd": _round_money(by_day[day]["costUsd"]),
            }
            for day in sorted(by_day)
        ]
    return result


# ---------------------------------------------------------------------------
# 健康 + 磁盘 + 最近失败任务
# ---------------------------------------------------------------------------

def _disk_usage_bytes() -> int:
    """递归统计 ``DATA_DIR``；目录不存在/不可读按 0。不跟随符号链接。"""
    root = config.DATA_DIR
    if not os.path.isdir(root):
        return 0
    total = 0
    try:
        for dirpath, _dirnames, filenames in os.walk(root, followlinks=False):
            for name in filenames:
                path = os.path.join(dirpath, name)
                try:
                    if os.path.isfile(path) and not os.path.islink(path):
                        total += os.path.getsize(path)
                except OSError:
                    continue
    except OSError as exc:
        logger.warning("统计 data/ 磁盘占用失败：%s", exc)
        return 0
    return total


def _recent_failed_jobs() -> list[dict]:
    with _db() as conn:
        if conn is None or not _table_exists(conn, "jobs"):
            return []
        try:
            rows = conn.execute(
                "SELECT id, user_id, kind, content_ref, error, updated_at "
                "FROM jobs WHERE status = 'failed' "
                "ORDER BY updated_at DESC, id DESC LIMIT ?",
                (_MAX_FAILED_JOBS,),
            ).fetchall()
        except sqlite3.Error as exc:
            logger.warning("后台失败任务查询失败（已返回空列表）：%s", exc)
            return []
    return [
        {
            "id": row["id"],
            "userId": (row["user_id"] or "")[:8],
            "kind": row["kind"],
            "contentRef": row["content_ref"],
            "error": (row["error"] or "")[:_MAX_ERROR_CHARS],
            "updatedAt": int(row["updated_at"] or 0),
        }
        for row in rows
    ]


def build_health() -> dict:
    """``GET /api/admin/health`` 的数据体；DB degraded 时也返回 200。"""
    try:
        snapshot = observability.health_snapshot()
    except Exception as exc:  # noqa: BLE001 - 健康检查自身不能把止血台打死
        logger.exception("读取 /healthz 快照失败：%s", exc)
        snapshot = {
            "status": "degraded",
            "version": config.APP_VERSION,
            "db": {"ok": False, "migrations": {"current": None, "head": None}},
            "uptime_seconds": 0.0,
            "time": _iso_utc(),
        }
    return {
        "health": {
            "status": snapshot.get("status", "degraded"),
            "version": snapshot.get("version"),
            "db": snapshot.get("db", {}),
            "uptimeSeconds": snapshot.get("uptime_seconds", 0),
            "time": snapshot.get("time"),
        },
        "disk": {
            "dataDir": config.DATA_DIR,
            "sizeBytes": _disk_usage_bytes(),
        },
        "failedJobs": _recent_failed_jobs(),
    }


# ---------------------------------------------------------------------------
# HTTP 端点（读聚合 + specs/023 写操作；限速桶见 ratelimit.py）
# ---------------------------------------------------------------------------

@router.get("/stats")
def admin_stats(_user: dict = Depends(require_admin)):
    """用户量/活跃、AI 花费与今日功能调用、任务状态。"""
    return build_stats()


@router.get("/users")
def admin_users(
    limit: int = 50,
    offset: int = 0,
    search: str = "",
    _user: dict = Depends(require_admin),
):
    """用户列表：id 前 8 位 + userId + 邮箱/用户名/余额/状态 + 本月花费等。"""
    return build_users(limit=limit, offset=offset, search=search)


@router.get("/usage")
def admin_usage(days: int = 7, _user: dict = Depends(require_admin)):
    """按天 × 功能聚合 ai_usage（calls / tokens / est_cost_usd）。"""
    return build_usage(days=days)


@router.get("/health")
def admin_health(_user: dict = Depends(require_admin)):
    """聚合 /healthz + data/ 磁盘占用 + 最近 10 条 failed jobs。"""
    return build_health()


@router.get("/events")
def admin_events(
    event_type: str | None = Query(default=None, alias="type"),
    limit: int = Query(default=50, ge=1, le=200),
    since: int | None = Query(default=None, ge=0),
    _user: dict = Depends(require_admin),
):
    """只读事件流：``?type=dict_lookup&limit=50``（M2 #7 行为事件可查）。

    返回已脱敏的字段（不返回 user_id / device_id）；未传 type 时取最近所有
    已知事件。表未迁移 503，未知 type 400。
    """
    try:
        return behavior_events.list_recent_events(
            event_type=event_type, limit=limit, since_ms=since
        )
    except behavior_events.InvalidBehaviorEvents as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except behavior_events.BehaviorUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except sqlite3.Error as exc:
        raise HTTPException(
            status_code=503,
            detail=f"事件表暂不可用：{exc}（先运行 alembic upgrade head）",
        ) from exc


@router.post("/users/{user_id}/credits")
def admin_adjust_credits(
    user_id: str,
    payload: CreditAdjustRequest,
    user: dict = Depends(require_admin),
):
    """手动调余额：delta 非 0、-100000..100000，reason 1–200 字。

    原子更新 users.credits 并追加 credit_transactions；扣减后余额 < 0 拒绝
    （400），用户不存在 404，未迁移 503。返回 ``{"credits": 新余额}``。
    """
    try:
        delta, reason = account.validate_adjustment(payload.delta, payload.reason)
    except account.InvalidAdjustment as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    try:
        credits = account.adjust_credits(
            user_id, delta, reason, admin_id=user["id"]
        )
    except account.UserNotFound:
        raise HTTPException(status_code=404, detail="用户不存在。")
    except account.InsufficientCredits:
        raise HTTPException(
            status_code=400, detail="余额不足，不能扣成负数。"
        )
    except account.CreditsUnavailable:
        raise HTTPException(
            status_code=503,
            detail="数据库未迁移（credit_transactions 缺失），请先执行 alembic upgrade head。",
        )
    return {"credits": credits}


@router.patch("/users/{user_id}")
def admin_patch_user(
    user_id: str,
    payload: UserPatchRequest,
    user: dict = Depends(require_admin),
):
    """封禁/解封用户（只允许 status；isAdmin 不实现）。

    不能封禁自己或最后一个 active 管理员；用户不存在 404。
    返回 ``{"user": {id,email,username,credits,status,createdAt}}``。
    """
    if payload.is_admin is not None:
        raise HTTPException(
            status_code=400,
            detail="暂不支持通过该接口修改管理员身份。",
        )
    if "status" not in payload.model_fields_set or payload.status is None:
        raise HTTPException(status_code=400, detail="请提供 status。")
    status = payload.status.strip().lower()
    if status not in account.STATUSES:
        raise HTTPException(
            status_code=400, detail="status 只支持 active 或 banned。"
        )
    try:
        updated = account.set_user_status(
            user_id, status, actor_id=user["id"]
        )
    except account.UserNotFound:
        raise HTTPException(status_code=404, detail="用户不存在。")
    except account.CannotBanSelf:
        raise HTTPException(status_code=400, detail="不能封禁自己。")
    except account.LastAdmin:
        raise HTTPException(
            status_code=400, detail="不能封禁最后一个管理员。"
        )
    return {"user": updated}


@router.get("/settings")
def admin_get_settings(_user: dict = Depends(require_admin)):
    """当前应用设置：``{maintenance_mode: bool, announcement: str|null}``。"""
    return account.get_settings()


@router.put("/settings")
def admin_update_settings(
    payload: SettingsUpdateRequest,
    _user: dict = Depends(require_admin),
):
    """按字段 upsert 维护模式/公告并返回当前值。

    - ``maintenance_mode``：bool（开着时非管理员 /api/* 返回 503）；
    - ``announcement``：字符串或 null（null = 清空）；不传 = 保留原值。
    """
    fields = payload.model_fields_set
    kwargs: dict[str, object] = {}
    if "maintenance_mode" in fields:
        if payload.maintenance_mode is None:
            raise HTTPException(
                status_code=400, detail="maintenance_mode 必须是布尔值。"
            )
        kwargs["maintenance_mode"] = payload.maintenance_mode
    if "announcement" in fields:
        if (
            payload.announcement is not None
            and len(payload.announcement) > _MAX_ANNOUNCEMENT_CHARS
        ):
            raise HTTPException(
                status_code=400,
                detail=f"公告最多 {_MAX_ANNOUNCEMENT_CHARS} 个字符。",
            )
        kwargs["announcement"] = payload.announcement
    try:
        return account.update_settings(**kwargs)
    except account.SettingsUnavailable:
        raise HTTPException(
            status_code=503,
            detail="数据库未迁移（app_settings 缺失），请先执行 alembic upgrade head。",
        )
