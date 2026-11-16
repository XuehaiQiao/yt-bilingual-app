"""进程内限速（M1 安全最小集，计划书 §7.6）。

目标：上线前用最低成本挡住「一把刷爆 AI 账单」和「注册/登录爆破」。
**不引 Redis、不引第三方依赖**：固定窗口计数（默认 60 秒）放进程内存，
进程重启即清空。已知边界（显式接受，写进 backend/README 安全节）：

- 单进程有效；`uvicorn --workers N` 时每个进程各算各的（MVP 是单进程）；
- 反向代理后所有请求的 ``request.client.host`` 可能是代理 IP；默认不信
  ``X-Forwarded-For``（可伪造），需要按真实 IP 限速时由反代层处理；
- 只做「请求频率」这一层，不做 WAF / bot 指纹 / IP 信誉库（计划书残余风险）。

桶与键（路径 → 桶 → 键）见 :func:`bucket_for`：注册/登录按 IP；估价/处理/
查词/内容发现/读文章导入按登录用户；游客（M1 ⑧）用同一组 business 桶但更紧的上限，键为
``guest:<sha256>``。超限由 ``main.py`` 的身份中间件返回 **429 + Retry-After**。
"""
from __future__ import annotations

import json
import logging
import math
import threading
import time
from collections import deque
from dataclasses import dataclass

from fastapi import Request
from fastapi.responses import JSONResponse

import config

logger = logging.getLogger("linguatrek.ratelimit")

# 固定窗口长度：一分钟（需求口径即「N 次/分钟」）。
WINDOW_SECONDS = 60.0

# 内存兜底：极端情况下（大量伪造 IP/用户）也不让计数表无限膨胀。
_MAX_TRACKED_KEYS = 20_000


@dataclass(frozen=True)
class Bucket:
    """一个限速桶：名字用于配置/日志，scope 决定键是 IP 还是登录用户。"""

    name: str
    scope: str  # "ip" | "user"


_AUTH_PATHS = frozenset({"/api/auth/signup", "/api/auth/login"})

_EXACT_PATHS = {
    "/api/estimate-cost": Bucket("estimate", "user"),
    "/api/define": Bucket("define", "user"),
    # 内容发现（V1）：一次请求含多次搜索/探测/LLM，按登录用户限 5 次/分钟。
    "/api/discover": Bucket("discover", "user"),
    # 读文章（V1）：导入会抓取用户提供的 URL（SSRF 校验 + 2MB 上限），
    # 按登录用户限 10 次/分钟；翻译受 AI 日配额约束，不在此桶。
    "/api/article/import": Bucket("reading", "user"),
    # 学习事件上报（M5 watch + M2 #7 行为埋点）：批量但高频，按用户限
    # 120 次/分钟；游客 60 次/分钟（见 config.RATE_LIMIT_*_EVENTS_PER_MINUTE）。
    "/api/events": Bucket("events", "user"),
    # 公版书（公开只读）：每章都实时抓取公版源；公开路径没有游客身份，
    # 按 IP 计数。列表/详情也过桶，口径简单且保守。
    "/api/books": Bucket("books", "ip"),
}

_PREFIX_PATHS = (
    ("/api/process-video", Bucket("process_video", "user")),
    ("/api/books/", Bucket("books", "ip")),
    # 后台止血台（M1 ⑥）：登录管理员按用户 30 次/分钟（只读但仍限速，
    # 避免一页面板把 DB 打满；0 = 关闭，见 RATE_LIMIT_ADMIN_PER_MINUTE）。
    ("/api/admin", Bucket("admin", "user")),
)

_LIMIT_ATTRS = {
    "auth": "RATE_LIMIT_AUTH_PER_MINUTE",
    "estimate": "RATE_LIMIT_ESTIMATE_COST_PER_MINUTE",
    "process_video": "RATE_LIMIT_PROCESS_VIDEO_PER_MINUTE",
    "define": "RATE_LIMIT_DEFINE_PER_MINUTE",
    "discover": "RATE_LIMIT_DISCOVER_PER_MINUTE",
    "reading": "RATE_LIMIT_READING_PER_MINUTE",
    "admin": "RATE_LIMIT_ADMIN_PER_MINUTE",
    "books": "RATE_LIMIT_BOOKS_PER_MINUTE",
    "events": "RATE_LIMIT_EVENTS_PER_MINUTE",
}

# 游客（无会话、只有 ln_guest）用更紧的上限；auth 桶仍按 IP（游客不适用）。
# 键为 `guest:<sha256>`，与其他游客/登录用户互不影响；clear-cookie 会得到
# 新的空游客（Cookie 方案的已知边界，见 guest.py 文档）。
_GUEST_LIMIT_ATTRS = {
    "estimate": "RATE_LIMIT_GUEST_ESTIMATE_COST_PER_MINUTE",
    "process_video": "RATE_LIMIT_GUEST_PROCESS_VIDEO_PER_MINUTE",
    "define": "RATE_LIMIT_GUEST_DEFINE_PER_MINUTE",
    "events": "RATE_LIMIT_GUEST_EVENTS_PER_MINUTE",
}

# key = "<bucket>:<identity>"；value = 当前窗口内的请求时间（monotonic，递增）。
_hits: dict[str, deque[float]] = {}
_lock = threading.Lock()


def bucket_for(path: str) -> Bucket | None:
    """请求路径属于哪个限速桶；不参与限速（如 /api/models、/health）返回 None。"""
    if path in _AUTH_PATHS:
        return Bucket("auth", "ip")
    bucket = _EXACT_PATHS.get(path)
    if bucket is not None:
        return bucket
    for prefix, prefix_bucket in _PREFIX_PATHS:
        if path.startswith(prefix):
            return prefix_bucket
    return None


def limit_for(bucket_name: str, *, guest: bool = False) -> int:
    """桶的每分钟上限（运行中可被测试/运维改 config 属性）；0 = 关闭。

    ``guest=True`` 时查游客专用上限（更紧）；auth 桶没有游客专用值，仍按 IP
    使用 ``RATE_LIMIT_AUTH_PER_MINUTE``（爆破防护不看是否游客）。
    """
    attr = _GUEST_LIMIT_ATTRS.get(bucket_name) if guest else None
    if not attr:
        attr = _LIMIT_ATTRS.get(bucket_name)
    if not attr:
        return 0
    try:
        return max(0, int(getattr(config, attr, 0) or 0))
    except (TypeError, ValueError):
        return 0


def _identity(
    request: Request,
    bucket: Bucket,
    user: dict | None,
    guest_hash: str | None = None,
) -> str:
    if bucket.scope == "user":
        if isinstance(user, dict) and user.get("id"):
            return f"user:{user['id']}"
        if guest_hash:
            return f"guest:{guest_hash}"
    # 用户桶在未登录且无游客身份时直接调用：按 IP 兜底。
    host = request.client.host if request.client else "unknown"
    return f"ip:{host}"


def consume(
    bucket_name: str, identity: str, limit: int, *, now: float | None = None
) -> int | None:
    """记一次请求；未超限返回 None，超限返回建议的 ``Retry-After``（秒）。

    固定窗口：每次只保留最近 ``WINDOW_SECONDS`` 内的请求时间。超限时建议
    等待时间 = 窗口内最早一次请求过期所需秒数（至少 1 秒）。
    """
    if limit <= 0:
        return None
    moment = time.monotonic() if now is None else now
    horizon = moment - WINDOW_SECONDS
    key = f"{bucket_name}:{identity}"
    with _lock:
        hits = _hits.get(key)
        if hits is None:
            hits = deque()
            _hits[key] = hits
        while hits and hits[0] <= horizon:
            hits.popleft()
        if len(hits) >= limit:
            retry_after = max(1, math.ceil(hits[0] + WINDOW_SECONDS - moment))
            return retry_after
        hits.append(moment)
        _sweep_locked(moment)
    return None


def _sweep_locked(now: float) -> None:
    """内存兜底：条目过多时清掉整窗无请求的空键/过期键（持锁调用）。"""
    if len(_hits) <= _MAX_TRACKED_KEYS:
        return
    horizon = now - WINDOW_SECONDS
    stale = []
    for key, hits in _hits.items():
        while hits and hits[0] <= horizon:
            hits.popleft()
        if not hits:
            stale.append(key)
    for key in stale:
        _hits.pop(key, None)


def check_request(
    request: Request,
    user: dict | None,
    guest_hash: str | None = None,
) -> int | None:
    """中间件入口：按路径选桶 → 取键 → 计数；超限返回 Retry-After 秒数。

    ``guest_hash`` 非空且没有登录用户时，business 桶使用游客专用上限与
    ``guest:<hash>`` 键；auth 桶始终按 IP。
    """
    bucket = bucket_for(request.url.path)
    if bucket is None:
        return None
    is_guest = user is None and bool(guest_hash)
    limit = limit_for(bucket.name, guest=is_guest)
    if limit <= 0:
        return None
    identity = _identity(request, bucket, user, guest_hash)
    retry_after = consume(bucket.name, identity, limit)
    if retry_after is None:
        return None
    logger.warning(
        json.dumps(
            {
                "event": "rate_limited",
                "bucket": bucket.name,
                "scope": "guest" if is_guest else bucket.scope,
                "path": request.url.path,
                "retry_after": retry_after,
                "limit_per_minute": limit,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )
    return retry_after


def rate_limited_response(retry_after: int) -> JSONResponse:
    """统一的 429 响应：中文提示 + ``Retry-After``（秒）。"""
    return JSONResponse(
        status_code=429,
        content={
            "detail": f"请求过于频繁，请 {retry_after} 秒后再试。",
            "retryAfter": retry_after,
        },
        headers={"Retry-After": str(retry_after), "Cache-Control": "no-store"},
    )


# 日限窗口：自评 10 次/天（计划书 §7.4）。与分钟桶分开存，进程重启即清空。
DAY_SECONDS = 86_400.0
_DailyHits = deque[float]
_daily_hits: dict[str, _DailyHits] = {}


def consume_daily(
    bucket_name: str, identity: str, limit: int, *, now: float | None = None
) -> int | None:
    """记一次「/天」配额；未超限返回 None，超限返回建议 ``Retry-After``（秒）。

    与分钟限速同一套进程内语义（单进程有效、重启清零）。窗口是滑动 24 小时，
    不按自然日切，避免用户卡在午夜前后被重复计数。
    """
    if limit <= 0:
        return None
    moment = time.monotonic() if now is None else now
    horizon = moment - DAY_SECONDS
    key = f"{bucket_name}:{identity}"
    with _lock:
        hits = _daily_hits.get(key)
        if hits is None:
            hits = deque()
            _daily_hits[key] = hits
        while hits and hits[0] <= horizon:
            hits.popleft()
        if len(hits) >= limit:
            retry_after = max(1, math.ceil(hits[0] + DAY_SECONDS - moment))
            return retry_after
        hits.append(moment)
        if len(_daily_hits) > _MAX_TRACKED_KEYS:
            stale = [
                day_key
                for day_key, day_hits in _daily_hits.items()
                if not day_hits or day_hits[-1] <= horizon
            ]
            for day_key in stale:
                _daily_hits.pop(day_key, None)
    return None


def reset_rate_limits() -> None:
    """清空所有计数（测试用；运维排查误封时也可调用）。"""
    with _lock:
        _hits.clear()
        _daily_hits.clear()
