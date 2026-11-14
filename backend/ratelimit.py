"""进程内限速（M1 安全最小集，计划书 §7.6）。

目标：上线前用最低成本挡住「一把刷爆 AI 账单」和「注册/登录爆破」。
**不引 Redis、不引第三方依赖**：固定窗口计数（默认 60 秒）放进程内存，
进程重启即清空。已知边界（显式接受，写进 backend/README 安全节）：

- 单进程有效；`uvicorn --workers N` 时每个进程各算各的（MVP 是单进程）；
- 反向代理后所有请求的 ``request.client.host`` 可能是代理 IP；默认不信
  ``X-Forwarded-For``（可伪造），需要按真实 IP 限速时由反代层处理；
- 只做「请求频率」这一层，不做 WAF / bot 指纹 / IP 信誉库（计划书残余风险）。

桶与键（路径 → 桶 → 键）见 :func:`bucket_for`：注册/登录按 IP，估价/处理/
查词按登录用户。超限由 ``main.py`` 的会话中间件返回 **429 + Retry-After**。
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
}

_PREFIX_PATHS = (
    ("/api/process-video", Bucket("process_video", "user")),
)

_LIMIT_ATTRS = {
    "auth": "RATE_LIMIT_AUTH_PER_MINUTE",
    "estimate": "RATE_LIMIT_ESTIMATE_COST_PER_MINUTE",
    "process_video": "RATE_LIMIT_PROCESS_VIDEO_PER_MINUTE",
    "define": "RATE_LIMIT_DEFINE_PER_MINUTE",
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


def limit_for(bucket_name: str) -> int:
    """桶的每分钟上限（运行中可被测试/运维改 config 属性）；0 = 关闭。"""
    attr = _LIMIT_ATTRS.get(bucket_name)
    if not attr:
        return 0
    try:
        return max(0, int(getattr(config, attr, 0) or 0))
    except (TypeError, ValueError):
        return 0


def _identity(request: Request, bucket: Bucket, user: dict | None) -> str:
    if bucket.scope == "user" and isinstance(user, dict) and user.get("id"):
        return f"user:{user['id']}"
    # 用户桶在未登录时理论上到不了这里（/api 会先 401）；直接调用时按 IP 兜底。
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


def check_request(request: Request, user: dict | None) -> int | None:
    """中间件入口：按路径选桶 → 取键 → 计数；超限返回 Retry-After 秒数。"""
    bucket = bucket_for(request.url.path)
    if bucket is None:
        return None
    limit = limit_for(bucket.name)
    if limit <= 0:
        return None
    retry_after = consume(bucket.name, _identity(request, bucket, user), limit)
    if retry_after is None:
        return None
    logger.warning(
        json.dumps(
            {
                "event": "rate_limited",
                "bucket": bucket.name,
                "scope": bucket.scope,
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


def reset_rate_limits() -> None:
    """清空所有计数（测试用；运维排查误封时也可调用）。"""
    with _lock:
        _hits.clear()
