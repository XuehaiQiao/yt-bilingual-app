"""登录失败锁定（账号维度 + IP 维度，进程内存）。

M1 ⑦ 安全最小集的残余项：`ratelimit.py` 只做「同一 IP 每分钟请求数」，
挡不住慢速撞库；这里补「连续失败 N 次 → 锁 M 分钟」。

规则（全部可在 `config.py` / 环境变量里调）：

- 同一**账号**（规范化邮箱的 SHA-256，不存明文）或同一 **IP** 连续失败达到
  ``AUTH_LOCK_THRESHOLD``（默认 5）→ 锁定 ``AUTH_LOCK_MINUTES``（默认 15）分钟；
- **任意一个维度命中锁定，即使密码正确也拒绝**；返回 429 + ``Retry-After``
  （与全局限速同一契约，不用 423，前端无需区分两套状态码）；
- 成功登录清空该账号与该 IP 的失败计数；锁定到期后计数清零，可重新登录；
- 账号不存在/邮箱格式错误也照常计数并锁定，响应与真实账号完全一致，
  不泄露「账号是否存在」；
- 阈值或分钟为 0 = 关闭；计数只放进程内存，进程重启即清空（单进程有效，
  多 worker 时各进程独立计数——与 `ratelimit.py` 的已知边界相同）。

失败计数在 ``AUTH_LOCK_MINUTES`` 内没有新失败会过期，避免「一年里攒 4 次
失败，最后一次被锁」这种不合理的长期累积。
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import threading
import time
from dataclasses import dataclass

import config

logger = logging.getLogger("linguatrek.auth_lockout")

# 内存兜底：大量随机邮箱/IP 也不让表无限膨胀；超限先清过期项，再淘汰最旧。
_MAX_TRACKED_KEYS = 20_000


@dataclass(frozen=True)
class LockStatus:
    """一次锁定判定：还需等待的秒数与命中的维度（account / ip）。"""

    retry_after: int
    scopes: tuple[str, ...]


@dataclass
class _Entry:
    failures: int = 0
    locked_until: float = 0.0
    last_failure: float = 0.0


_entries: dict[str, _Entry] = {}
_lock = threading.Lock()


def _now() -> float:
    """单调时钟；测试可 monkeypatch 本函数来快进锁定到期。"""
    return time.monotonic()


def _policy() -> tuple[int, float] | None:
    """读取当前阈值/锁定时长；关闭时返回 None。每次读取便于测试/运维调参。"""
    try:
        threshold = int(getattr(config, "AUTH_LOCK_THRESHOLD", 5) or 0)
        minutes = int(getattr(config, "AUTH_LOCK_MINUTES", 15) or 0)
    except (TypeError, ValueError):
        return None
    if threshold <= 0 or minutes <= 0:
        return None
    return threshold, float(minutes) * 60.0


def _key(scope: str, value: str) -> str:
    """账号键只存邮箱哈希，内存表里不出现明文邮箱。"""
    if scope == "account":
        digest = hashlib.sha256((value or "").encode("utf-8")).hexdigest()
        return f"account:{digest}"
    return f"ip:{value or 'unknown'}"


def _remaining_seconds(entry: _Entry, now: float) -> int:
    return max(1, math.ceil(entry.locked_until - now))


def _expire(entry: _Entry, now: float, window: float) -> bool:
    """清理过期状态；返回清理后是否仍处于锁定中（持锁调用）。"""
    if entry.locked_until and entry.locked_until <= now:
        entry.locked_until = 0.0
        entry.failures = 0
    if not entry.locked_until and entry.failures and now - entry.last_failure >= window:
        entry.failures = 0
    return entry.locked_until > now


def _status_locked(
    keys: tuple[tuple[str, str], ...], now: float, window: float
) -> LockStatus | None:
    """检查多个维度是否锁定（持锁调用）。"""
    scopes: list[str] = []
    retry_after = 0
    for scope, key in keys:
        entry = _entries.get(key)
        if entry is None:
            continue
        if _expire(entry, now, window):
            scopes.append(scope)
            retry_after = max(retry_after, _remaining_seconds(entry, now))
        elif not entry.failures:
            _entries.pop(key, None)
    if not scopes:
        return None
    return LockStatus(retry_after=retry_after, scopes=tuple(scopes))


def check(account: str, ip: str) -> LockStatus | None:
    """登录前检查：账号或 IP 被锁则返回状态，否则 None。"""
    policy = _policy()
    if policy is None:
        return None
    _threshold, window = policy
    now = _now()
    keys = (("account", _key("account", account)), ("ip", _key("ip", ip)))
    with _lock:
        status = _status_locked(keys, now, window)
    if status is not None:
        _log("login_locked", status, policy)
    return status


def record_failure(account: str, ip: str) -> LockStatus | None:
    """记一次失败；刚触发锁定则返回状态（调用方本次仍返回统一 401）。"""
    policy = _policy()
    if policy is None:
        return None
    threshold, window = policy
    now = _now()
    keys = (("account", _key("account", account)), ("ip", _key("ip", ip)))
    with _lock:
        scopes: list[str] = []
        retry_after = 0
        for scope, key in keys:
            entry = _entries.setdefault(key, _Entry())
            if _expire(entry, now, window):
                # 理论上 check() 已挡掉；并发下仍可能走到这里，不重复计数。
                scopes.append(scope)
                retry_after = max(retry_after, _remaining_seconds(entry, now))
                continue
            entry.failures += 1
            entry.last_failure = now
            if entry.failures >= threshold:
                entry.locked_until = now + window
                scopes.append(scope)
                retry_after = max(retry_after, _remaining_seconds(entry, now))
        _sweep_locked(now, window)
    if not scopes:
        return None
    status = LockStatus(retry_after=retry_after, scopes=tuple(scopes))
    _log("login_lockout_triggered", status, policy)
    return status


def clear(account: str, ip: str) -> None:
    """成功登录后清空该账号与该 IP 的失败/锁定状态。"""
    with _lock:
        _entries.pop(_key("account", account), None)
        _entries.pop(_key("ip", ip), None)


def reset() -> None:
    """清空全部状态（测试/运维排查误封用）。"""
    with _lock:
        _entries.clear()


def _sweep_locked(now: float, window: float) -> None:
    """内存兜底：超容量时先清过期/空条目，再从最旧的未锁定条目开始淘汰。"""
    if len(_entries) <= _MAX_TRACKED_KEYS:
        return
    for key, entry in list(_entries.items()):
        _expire(entry, now, window)
        if not entry.failures and entry.locked_until <= now:
            _entries.pop(key, None)
    if len(_entries) <= _MAX_TRACKED_KEYS:
        return
    # False（未锁定）排前面、越久没失败越先淘汰；锁定项尽量保留。
    ordered = sorted(
        _entries.items(),
        key=lambda item: (item[1].locked_until > now, item[1].last_failure),
    )
    for key, _entry in ordered[: len(_entries) - _MAX_TRACKED_KEYS]:
        _entries.pop(key, None)


def _log(event: str, status: LockStatus, policy: tuple[int, float]) -> None:
    """结构化日志；不写邮箱/IP 明文，只写命中的维度。"""
    threshold, window = policy
    logger.warning(
        json.dumps(
            {
                "event": event,
                "scopes": list(status.scopes),
                "retry_after": status.retry_after,
                "threshold": threshold,
                "lock_seconds": int(window),
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )
