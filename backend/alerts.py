"""飞书告警（M5，specs/035-feishu-alerts）。

设计口径与 ``docs/项目提案-上线功能.md`` §9 对齐：

- **级别**：P0 立即处理（站点不可用 / 数据风险）、P1 当日处理（成本 / 备份 /
  安全异常）、P2 每日摘要（运营 / 审计）。
- **事件类型是闭集**（``EVENT_TYPES``）：未知事件直接拒绝，避免拼写错误把告警
  静默丢掉；聚合 / 摘要这类内部合成消息用 ``DERIVED_EVENTS``，不接受外部输入。
- **发送器**：只走飞书自定义机器人 webhook，标准库 ``urllib``（不引新依赖）；
  可选 ``timestamp + HMAC-SHA256`` 签名（算法见 :func:`gen_sign`）；默认超时 5s。
- **请求路径绝不阻塞、绝不抛出**：:func:`notify` 只做「判定 + 入队」，真正的
  HTTP POST 在后台 daemon 线程里做；发送失败只记日志（只含 event/level/key），
  绝不把 webhook / secret / 完整 payload 写进日志，也不影响业务响应。
- **去重 / 限流**：同一 ``event:key`` 在 ``ALERT_DEDUPE_SECONDS``（默认 300s）
  内只接受一次；P1 在 ``ALERT_P1_AGGREGATE_SECONDS``（默认 900s）窗口内合并成
  一条聚合消息；P2 按本地日期缓存计数，到 ``ALERT_DAILY_DIGEST_HOUR`` 后发一条
  摘要；维护模式下静默 P1/P2，P0 仍发。
- **降级**：未开启 / 未配置 webhook / 超时 / 非 2xx / 飞书返回非 0 code，全部只
  记日志并返回结果字典，不抛异常、不写磁盘、不重试（重试交给外部巡检脚本）。
- **单进程内存状态**：去重表、P1/P2 桶、预算阈值标记、LLM 失败率窗口都在进程
  内存里；单 worker 部署有效，进程重启清零（已知边界，见规格 §6）。

调用入口（业务代码只用这些，不直接 new ``AlertManager``）：

- :func:`notify` / :func:`flush` —— 通用入口；
- :func:`notify_http_5xx` / :func:`notify_billing_settle_failed` /
  :func:`notify_billing_overrun` —— 已接入的自动事件；
- :func:`check_budget_threshold` / :func:`record_llm_outcome` —— 阈值判断；
- :func:`send_test` —— 管理员测试消息（绕过去重/聚合，同步发送）。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
import socket
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Mapping

import config

logger = logging.getLogger("linguatrek.alerts")

LEVELS: tuple[str, ...] = ("P0", "P1", "P2")
_LEVEL_ORDER = {level: index for index, level in enumerate(LEVELS)}

#: 对外接受的事件类型（闭集）。F-8：新增事件时同时更新规格与测试。
EVENT_TYPES = frozenset(
    {
        "http_5xx",
        "billing_settle_failed",
        "billing_overrun",
        "llm_failure_rate",
        "budget_threshold",
        "backup_failed",
        "health_unhealthy",
        "test",
    }
)

#: 内部合成的消息（P1 聚合 / P2 每日摘要）；只由本模块生成，不接受外部 event。
DERIVED_EVENTS = frozenset({"p1_aggregate", "p2_digest"})

DEFAULT_LEVEL = "P1"

#: 发送函数签名：``(url, body_bytes, timeout_seconds) -> (status, response_text)``。
#: 测试注入假 transport，绝不真的请求飞书。
Transport = Callable[[str, bytes, float], tuple[int, str]]

_MAX_SUMMARY_CHARS = 300
_MAX_DETAILS_CHARS = 500
_MAX_KEY_CHARS = 120
_FLUSHER_INTERVAL_SECONDS = 30.0
_BUDGET_THRESHOLDS = (50, 80, 100)
_LLM_WINDOW_SECONDS = 600.0
_LLM_MIN_CALLS = 10
_LLM_MIN_FAILURES = 2
_LLM_FAILURE_RATE = 0.2
_AT_USER_RE = re.compile(r"^[A-Za-z0-9_:-]{1,64}$")


# ---------------------------------------------------------------------------
# 数据形状
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Alert:
    """一条待发送的告警（内部结构；外部用 :func:`notify` 的关键字参数）。"""

    event: str
    level: str
    summary: str
    key: str = ""
    details: Any = None
    occurred_at: float | None = None


def _result(
    status: str,
    *,
    event: Any = None,
    level: Any = None,
    key: str = "",
    sent: bool = False,
    queued: bool = False,
    reason: str | None = None,
) -> dict:
    """统一返回形状，便于管理员端点/巡检脚本打印与测试断言。"""
    return {
        "event": event,
        "level": level,
        "key": key,
        "status": status,
        "sent": sent,
        "queued": queued,
        "reason": reason,
    }


def _normalize_event(event: Any) -> str | None:
    name = str(event or "").strip().lower()
    return name if name in EVENT_TYPES else None


def _normalize_level(level: Any) -> str | None:
    name = str(level or "").strip().upper()
    return name if name in LEVELS else None


def _clean_summary(summary: Any, fallback: str = "") -> str:
    text = str(summary or fallback or "").replace("\r", " ").strip()
    return text[:_MAX_SUMMARY_CHARS]


def _clean_key(key: Any) -> str:
    text = str(key or "").replace("\r", " ").replace("\n", " ").strip()
    return text[:_MAX_KEY_CHARS]


def _iso_local(ts: float | None) -> str:
    moment = datetime.fromtimestamp(time.time() if ts is None else ts)
    return moment.astimezone().isoformat(timespec="seconds")


def _configured_secrets() -> tuple[str, ...]:
    """从 config 读当前 webhook/secret，用于 payload 脱敏（防御性，不是主路径）。"""
    return (
        str(getattr(config, "FEISHU_WEBHOOK_URL", "") or ""),
        str(getattr(config, "FEISHU_WEBHOOK_SECRET", "") or ""),
    )


def sanitize_details(details: Any, *, redact: tuple[str, ...] = ()) -> str:
    """把 details 压成一行文本：截断 + 把 webhook/secret 替换成 ``[redacted]``。

    日志与 payload 都不应该出现 webhook URL、签名 secret；这里是最后一层保险，
    即使调用方误把敏感值塞进 details 也不会发出去。
    """
    if details is None:
        return ""
    if isinstance(details, Mapping):
        text = "; ".join(f"{key}={details[key]}" for key in sorted(details, key=str))
    elif isinstance(details, (list, tuple, set)):
        text = "; ".join(str(item) for item in details)
    else:
        text = str(details)
    for value in (*_configured_secrets(), *redact):
        if value and len(value) >= 4:
            text = text.replace(value, "[redacted]")
    text = text.replace("\r", " ").strip()
    if len(text) > _MAX_DETAILS_CHARS:
        text = text[:_MAX_DETAILS_CHARS] + "…"
    return text


# ---------------------------------------------------------------------------
# 消息体（纯函数，便于测试与复用）
# ---------------------------------------------------------------------------


def build_text_payload(
    alert: Alert,
    *,
    env_name: str = "dev",
    at_user_id: str = "",
    redact: tuple[str, ...] = (),
) -> dict:
    """飞书自定义机器人「文本」消息。"""
    lines = [
        f"【语途告警】{alert.level} · {alert.event}",
        f"环境：{env_name}",
        f"摘要：{_clean_summary(alert.summary) or alert.event}",
    ]
    key = _clean_key(alert.key)
    if key:
        lines.append(f"Key：{key}")
    details = sanitize_details(alert.details, redact=redact)
    if details:
        lines.append(f"详情：{details}")
    lines.append(f"时间：{_iso_local(alert.occurred_at)}")
    text = "\n".join(lines)
    if at_user_id:
        text += f'\n<at user_id="{at_user_id}"></at>'
    return {"msg_type": "text", "content": {"text": text}}


def build_card_payload(
    alert: Alert,
    *,
    env_name: str = "dev",
    at_user_id: str = "",
    redact: tuple[str, ...] = (),
) -> dict:
    """飞书自定义机器人「富文本卡片」消息（interactive card）。"""
    title = f"[{alert.level}] 语途告警 · {alert.event}"
    template = {"P0": "red", "P1": "orange", "P2": "blue"}.get(alert.level, "grey")
    lines = [
        f"**级别**：{alert.level}",
        f"**环境**：{env_name}",
        f"**事件**：{alert.event}",
        f"**摘要**：{_clean_summary(alert.summary) or alert.event}",
    ]
    key = _clean_key(alert.key)
    if key:
        lines.append(f"**Key**：{key}")
    details = sanitize_details(alert.details, redact=redact)
    if details:
        lines.append(f"**详情**：{details}")
    if at_user_id:
        lines.append(f"<at id={at_user_id}></at>")
    return {
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True},
            "header": {
                "template": template,
                "title": {"tag": "plain_text", "content": title},
            },
            "elements": [
                {"tag": "div", "text": {"tag": "lark_md", "content": "\n".join(lines)}},
                {
                    "tag": "note",
                    "elements": [
                        {
                            "tag": "plain_text",
                            "content": f"时间：{_iso_local(alert.occurred_at)} · 自动告警",
                        }
                    ],
                },
            ],
        },
    }


def gen_sign(timestamp: str | int, secret: str) -> str:
    """飞书自定义机器人签名：``HMAC-SHA256(key="{timestamp}\\n{secret}", msg="")``。

    官方示例即「把 ``timestamp\\nsecret`` 当作 HMAC key、消息体为空」，结果
    base64 后放在请求体顶层 ``sign`` 字段，同时带上 ``timestamp``。服务器时间
    必须 NTP 同步；时间漂移会被飞书拒绝（返回非 0 code）。
    """
    string_to_sign = f"{timestamp}\n{secret}"
    digest = hmac.new(
        string_to_sign.encode("utf-8"), digestmod=hashlib.sha256
    ).digest()
    return base64.b64encode(digest).decode("utf-8")


def apply_signature(payload: dict, secret: str, *, timestamp: int | str | None = None) -> dict:
    """就地给 payload 加 ``timestamp``/``sign``；``secret`` 为空时原样返回。"""
    if not secret:
        return payload
    ts = str(int(time.time()) if timestamp is None else timestamp)
    payload["timestamp"] = ts
    payload["sign"] = gen_sign(ts, secret)
    return payload


def _default_transport(url: str, body: bytes, timeout: float) -> tuple[int, str]:
    """标准库 POST（同步、阻塞）；只在后台线程或巡检脚本里调用。"""
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        status = int(response.getcode() or 0)
        text = response.read(4096).decode("utf-8", "replace")
    return status, text


def _response_ok(status: int, text: str) -> bool:
    """HTTP 2xx 且（若返回 JSON）``code`` 为 0。"""
    if not 200 <= int(status) < 300:
        return False
    try:
        payload = json.loads(text)
    except (TypeError, ValueError):
        return True
    if not isinstance(payload, dict):
        return True
    code = payload.get("code", payload.get("StatusCode"))
    if code is None:
        return True
    try:
        return int(code) == 0
    except (TypeError, ValueError):
        return False


def _response_reason(status: int, text: str) -> str:
    """失败原因标签（不含响应正文，避免把敏感内容带进日志）。"""
    if not 200 <= int(status) < 300:
        return f"http_{int(status)}"
    try:
        payload = json.loads(text)
    except (TypeError, ValueError):
        return "invalid_response"
    if isinstance(payload, dict):
        code = payload.get("code", payload.get("StatusCode"))
        if code is not None:
            try:
                return f"feishu_code_{int(code)}"
            except (TypeError, ValueError):
                return "feishu_code_unknown"
    return "invalid_response"


def _classify_exception(exc: BaseException) -> str:
    """异常 → 不含 URL/响应体的原因标签。"""
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return "timeout"
    if isinstance(exc, urllib.error.HTTPError):
        return f"http_{int(exc.code)}"
    if isinstance(exc, urllib.error.URLError):
        reason = getattr(exc, "reason", None)
        if isinstance(reason, (TimeoutError, socket.timeout)):
            return "timeout"
        return "network_error"
    return type(exc).__name__.lower()


def _default_maintenance_check() -> bool:
    """维护模式是否开启；延迟 import account，避免模块级循环依赖。"""
    try:
        import account

        return bool(account.maintenance_enabled())
    except Exception:  # noqa: BLE001 - 读不到维护状态按「未维护」处理
        return False


def _local_now_default(ts: float) -> datetime:
    return datetime.fromtimestamp(ts).astimezone()


# ---------------------------------------------------------------------------
# 发送器
# ---------------------------------------------------------------------------


class AlertManager:
    """告警判定 + 发送。生产用模块级单例（:func:`notify`），测试可直接 new。"""

    def __init__(
        self,
        *,
        enabled: bool = False,
        webhook_url: str = "",
        webhook_secret: str = "",
        min_level: str = "P2",
        at_user_id: str = "",
        message_format: str = "text",
        env_name: str = "dev",
        dedupe_seconds: float = 300.0,
        p1_aggregate_seconds: float = 900.0,
        digest_hour: int = 9,
        timeout_seconds: float = 5.0,
        transport: Transport | None = None,
        maintenance_check: Callable[[], bool] | None = None,
        async_send: bool = True,
        background_flush: bool = True,
        clock: Callable[[], float] = time.time,
        local_now: Callable[[float], datetime] | None = None,
    ) -> None:
        self.enabled = bool(enabled)
        self.webhook_url = (webhook_url or "").strip()
        self.webhook_secret = (webhook_secret or "").strip()
        self.min_level = min_level if min_level in LEVELS else "P2"
        self.at_user_id = (at_user_id or "").strip()
        if self.at_user_id and not _AT_USER_RE.fullmatch(self.at_user_id):
            logger.warning("FEISHU_AT_USER_ID 格式异常，P0 将不 @ 人。")
            self.at_user_id = ""
        self.message_format = message_format if message_format in ("text", "card") else "text"
        self.env_name = (env_name or "dev").strip() or "dev"
        self.dedupe_seconds = max(0.0, float(dedupe_seconds))
        self.p1_aggregate_seconds = max(1.0, float(p1_aggregate_seconds))
        self.digest_hour = min(23, max(0, int(digest_hour)))
        self.timeout_seconds = min(10.0, max(1.0, float(timeout_seconds)))
        self.async_send = bool(async_send)
        self.background_flush = bool(background_flush)
        self._transport: Transport = transport or _default_transport
        self._maintenance_check = maintenance_check or _default_maintenance_check
        self._clock = clock
        self._local_now = local_now or _local_now_default

        self._lock = threading.RLock()
        self._dedupe: dict[str, float] = {}
        self._p1_pending: list[Alert] = []
        self._p1_started: float | None = None
        self._p1_dropped = 0
        self._p2_counts: dict[str, int] = {}
        self._p2_last_digest_date = ""
        self._budget_notified: dict[str, set[str]] = {}
        self._llm_events: deque[tuple[float, bool]] = deque()
        self._threads: list[threading.Thread] = []
        self._flusher: threading.Thread | None = None
        self._stop = threading.Event()
        self._closed = False
        self.last_success_at: float | None = None
        if self.enabled and not self._webhook_ok:
            logger.warning(
                "飞书告警已启用但 FEISHU_WEBHOOK_URL 为空或非法：只记录判定，不发送。"
            )

    # -- 构造 ---------------------------------------------------------------
    @classmethod
    def from_config(cls) -> "AlertManager":
        return cls(
            enabled=bool(getattr(config, "FEISHU_ALERTS_ENABLED", False)),
            webhook_url=str(getattr(config, "FEISHU_WEBHOOK_URL", "") or ""),
            webhook_secret=str(getattr(config, "FEISHU_WEBHOOK_SECRET", "") or ""),
            min_level=str(getattr(config, "FEISHU_ALERT_LEVEL", "P2") or "P2"),
            at_user_id=str(getattr(config, "FEISHU_AT_USER_ID", "") or ""),
            message_format=str(
                getattr(config, "FEISHU_ALERT_MESSAGE_FORMAT", "text") or "text"
            ),
            env_name=str(getattr(config, "ALERT_ENV", "dev") or "dev"),
            dedupe_seconds=float(getattr(config, "ALERT_DEDUPE_SECONDS", 300) or 0),
            p1_aggregate_seconds=float(
                getattr(config, "ALERT_P1_AGGREGATE_SECONDS", 900) or 900
            ),
            digest_hour=int(getattr(config, "ALERT_DAILY_DIGEST_HOUR", 9) or 9),
            timeout_seconds=float(
                getattr(config, "FEISHU_ALERT_TIMEOUT_SECONDS", 5.0) or 5.0
            ),
        )

    @property
    def configured(self) -> bool:
        return self.enabled and self._webhook_ok

    @property
    def _webhook_ok(self) -> bool:
        return self.webhook_url.startswith(("http://", "https://"))

    # -- 主入口 -------------------------------------------------------------
    def notify(
        self,
        event: Any,
        level: Any = DEFAULT_LEVEL,
        *,
        summary: Any = "",
        key: Any = "",
        details: Any = None,
        force: bool = False,
        sync: bool = False,
    ) -> dict:
        """判定一条告警：立即发送 / P1 聚合 / P2 摘要 / 静默。

        - ``force=True``：绕过最低级别、去重、维护模式、P1/P2 缓冲，直接发送
          （管理员测试消息用；仍受 enabled / webhook 配置约束）。
        - ``sync=True``：在当前线程发送（只在已有后台线程 / 同步脚本里用）。
        普通请求路径保持 ``sync=False``，HTTP POST 在后台线程完成。
        """
        event_name = _normalize_event(event)
        level_name = _normalize_level(level)
        clean_key = _clean_key(key)
        if event_name is None:
            return _result(
                "unknown_event", event=event, level=level_name or level, key=clean_key
            )
        if level_name is None:
            return _result(
                "invalid_level", event=event_name, level=level, key=clean_key
            )
        if not self.enabled:
            return _result("disabled", event=event_name, level=level_name, key=clean_key)
        if not self._webhook_ok:
            return _result(
                "not_configured", event=event_name, level=level_name, key=clean_key
            )
        if not force and _LEVEL_ORDER[level_name] > _LEVEL_ORDER[self.min_level]:
            return _result(
                "filtered",
                event=event_name,
                level=level_name,
                key=clean_key,
                reason=f"min_level={self.min_level}",
            )

        now = self._clock()
        if not force and level_name in ("P1", "P2") and self._in_maintenance():
            return _result(
                "suppressed_maintenance", event=event_name, level=level_name, key=clean_key
            )

        # 顺手把到期的 P1 聚合窗口 / P2 摘要发掉（惰性 flush；后台线程是兜底）。
        self._flush_due(now, sync=sync)

        dedupe_key = f"{event_name}:{clean_key}" if clean_key else event_name
        if not force and level_name in ("P0", "P1") and self.dedupe_seconds > 0:
            if self._is_duplicate(dedupe_key, now):
                return _result(
                    "suppressed_dedupe",
                    event=event_name,
                    level=level_name,
                    key=clean_key,
                    reason=f"window={int(self.dedupe_seconds)}s",
                )
            self._remember(dedupe_key, now)

        alert = Alert(
            event=event_name,
            level=level_name,
            summary=_clean_summary(summary, fallback=event_name),
            key=clean_key,
            details=details,
            occurred_at=now,
        )

        if level_name == "P1" and not force:
            self._buffer_p1(alert, now)
            self._ensure_flusher()
            return _result(
                "aggregated", event=event_name, level=level_name, key=clean_key, queued=True
            )
        if level_name == "P2" and not force:
            self._buffer_p2(event_name)
            self._ensure_flusher()
            return _result(
                "buffered_daily", event=event_name, level=level_name, key=clean_key, queued=True
            )
        return self._dispatch(alert, sync=sync)

    def flush(self, *, force: bool = False, sync: bool = True) -> list[dict]:
        """立即发送到期的 P1 聚合 / P2 摘要；``force=True`` 无视窗口与整点。"""
        return self._flush_due(self._clock(), sync=sync, force=force)

    # -- 去重 ---------------------------------------------------------------
    def _is_duplicate(self, dedupe_key: str, now: float) -> bool:
        with self._lock:
            last = self._dedupe.get(dedupe_key)
            if last is None:
                return False
            return (now - last) < self.dedupe_seconds

    def _remember(self, dedupe_key: str, now: float) -> None:
        with self._lock:
            self._dedupe[dedupe_key] = now
            if len(self._dedupe) > 512:
                horizon = now - max(self.dedupe_seconds, 1.0)
                for stale in [k for k, ts in self._dedupe.items() if ts < horizon]:
                    self._dedupe.pop(stale, None)

    # -- P1 聚合 / P2 摘要 -------------------------------------------------
    def _buffer_p1(self, alert: Alert, now: float) -> None:
        with self._lock:
            if not self._p1_pending:
                self._p1_started = now
            if len(self._p1_pending) >= 100:
                self._p1_pending.pop(0)
                self._p1_dropped += 1
            self._p1_pending.append(alert)

    def _buffer_p2(self, event_name: str) -> None:
        with self._lock:
            self._p2_counts[event_name] = self._p2_counts.get(event_name, 0) + 1

    def _aggregate_p1_locked(self, now: float) -> Alert:
        pending = self._p1_pending
        dropped = self._p1_dropped
        self._p1_pending = []
        self._p1_dropped = 0
        self._p1_started = None

        counts: dict[str, int] = {}
        for alert in pending:
            counts[alert.event] = counts.get(alert.event, 0) + 1
        lines = [
            f"- [{a.event}] {a.key + ': ' if a.key else ''}{a.summary}"
            for a in pending[:20]
        ]
        if len(pending) > 20:
            lines.append(f"- （另有 {len(pending) - 20} 条省略）")
        detail_parts = ["聚合：" + "；".join(f"{e}×{n}" for e, n in sorted(counts.items()))]
        if lines:
            detail_parts.append("\n".join(lines))
        if dropped:
            detail_parts.append(f"（窗口内因上限丢弃 {dropped} 条）")
        summary = f"{len(pending) + dropped} 条 P1 事件（{int(self.p1_aggregate_seconds)} 秒聚合）"
        return Alert(
            event="p1_aggregate",
            level="P1",
            summary=summary,
            key="p1",
            details="\n".join(detail_parts),
            occurred_at=pending[-1].occurred_at if pending else now,
        )

    def _digest_due_locked(self, now: float) -> Alert | None:
        if not self._p2_counts:
            return None
        local = self._local_now(now)
        today = local.date().isoformat()
        if local.hour < self.digest_hour:
            return None
        if self._p2_last_digest_date == today:
            return None
        return self._take_digest_locked(now, today)

    def _take_digest_locked(self, now: float, today: str) -> Alert:
        counts = dict(self._p2_counts)
        self._p2_counts.clear()
        self._p2_last_digest_date = today
        total = sum(counts.values())
        details = "；".join(f"{event}×{count}" for event, count in sorted(counts.items()))
        return Alert(
            event="p2_digest",
            level="P2",
            summary=f"每日摘要：P2 事件 {total} 条",
            key="daily",
            details=details,
            occurred_at=now,
        )

    def _flush_due(self, now: float, *, sync: bool, force: bool = False) -> list[dict]:
        actions: list[Alert] = []
        with self._lock:
            if self._p1_pending and (
                force
                or (
                    self._p1_started is not None
                    and now - self._p1_started >= self.p1_aggregate_seconds
                )
            ):
                actions.append(self._aggregate_p1_locked(now))
            if force and self._p2_counts:
                actions.append(
                    self._take_digest_locked(now, self._local_now(now).date().isoformat())
                )
            else:
                digest = self._digest_due_locked(now)
                if digest is not None:
                    actions.append(digest)
        return [self._dispatch(alert, sync=sync) for alert in actions]

    # -- 后台发送 / flush ---------------------------------------------------
    def _ensure_flusher(self) -> None:
        if not (self.configured and self.background_flush):
            return
        with self._lock:
            if self._closed:
                return
            if self._flusher is not None and self._flusher.is_alive():
                return
            flusher = threading.Thread(
                target=self._flush_loop,
                name="linguatrek-alert-flusher",
                daemon=True,
            )
            self._flusher = flusher
        flusher.start()

    def _flush_loop(self) -> None:
        while not self._stop.wait(_FLUSHER_INTERVAL_SECONDS):
            try:
                self._flush_due(self._clock(), sync=True)
            except Exception:  # noqa: BLE001 - 维护线程绝不能把进程带崩
                logger.warning(
                    json.dumps(
                        {"event": "alert_flush_failed"},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                )

    def _dispatch(self, alert: Alert, *, sync: bool) -> dict:
        try:
            payload = self._build_payload(alert)
            body = json.dumps(
                payload, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
        except Exception:  # noqa: BLE001 - 构造失败也只记日志
            logger.warning(
                json.dumps(
                    {
                        "event": "alert_payload_failed",
                        "alert_event": alert.event,
                        "level": alert.level,
                        "key": alert.key,
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            )
            return _result(
                "error", event=alert.event, level=alert.level, key=alert.key,
                reason="payload_failed",
            )

        if sync or not self.async_send:
            return self._deliver(body, alert)

        thread = threading.Thread(
            target=self._deliver_safe,
            args=(body, alert),
            name="linguatrek-alert-send",
            daemon=True,
        )
        with self._lock:
            self._threads = [t for t in self._threads if t.is_alive()]
            self._threads.append(thread)
        thread.start()
        return _result(
            "queued", event=alert.event, level=alert.level, key=alert.key, queued=True
        )

    def _build_payload(self, alert: Alert) -> dict:
        at_user_id = self.at_user_id if alert.level == "P0" else ""
        redact = (self.webhook_url, self.webhook_secret)
        if self.message_format == "card":
            payload = build_card_payload(
                alert, env_name=self.env_name, at_user_id=at_user_id, redact=redact
            )
        else:
            payload = build_text_payload(
                alert, env_name=self.env_name, at_user_id=at_user_id, redact=redact
            )
        if self.webhook_secret:
            timestamp = str(int(self._clock()))
            payload["timestamp"] = timestamp
            payload["sign"] = gen_sign(timestamp, self.webhook_secret)
        return payload

    def _deliver_safe(self, body: bytes, alert: Alert) -> None:
        try:
            self._deliver(body, alert)
        except Exception:  # noqa: BLE001 - 线程兜底：任何异常都只记日志
            self._log_failure(alert, "unexpected")
        finally:
            current = threading.current_thread()
            with self._lock:
                self._threads = [t for t in self._threads if t is not current]

    def _deliver(self, body: bytes, alert: Alert) -> dict:
        try:
            status, text = self._transport(
                self.webhook_url, body, self.timeout_seconds
            )
        except Exception as exc:  # noqa: BLE001 - 断网/超时/HTTPError 都降级为日志
            reason = _classify_exception(exc)
            self._log_failure(alert, reason)
            return _result(
                "failed", event=alert.event, level=alert.level, key=alert.key,
                reason=reason,
            )
        if not _response_ok(status, text):
            reason = _response_reason(status, text)
            self._log_failure(alert, reason)
            return _result(
                "failed", event=alert.event, level=alert.level, key=alert.key,
                reason=reason,
            )
        self.last_success_at = self._clock()
        logger.info(
            json.dumps(
                {
                    "event": "alert_sent",
                    "alert_event": alert.event,
                    "level": alert.level,
                    "key": alert.key,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return _result(
            "sent", event=alert.event, level=alert.level, key=alert.key, sent=True
        )

    def _log_failure(self, alert: Alert, reason: str) -> None:
        # 只记 event / level / key / 原因标签：绝不打印 webhook、secret、响应正文。
        logger.warning(
            json.dumps(
                {
                    "event": "alert_send_failed",
                    "alert_event": alert.event,
                    "level": alert.level,
                    "key": alert.key,
                    "reason": reason,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )

    # -- 维护模式 / 预算 / LLM 失败率 --------------------------------------
    def _in_maintenance(self) -> bool:
        try:
            return bool(self._maintenance_check())
        except Exception:  # noqa: BLE001
            return False

    def check_budget_threshold(
        self,
        scope: str,
        spend_usd: float,
        limit_usd: float,
        *,
        day: str | None = None,
    ) -> dict | None:
        """日预算使用比例跨过 50/80/100% 时发一条 P1；每档每天最多一次。"""
        try:
            spend = float(spend_usd)
            limit = float(limit_usd)
        except (TypeError, ValueError):
            return None
        if not self.enabled or limit <= 0:
            return None
        percent = spend / limit * 100.0
        threshold = max((t for t in _BUDGET_THRESHOLDS if percent >= t), default=None)
        if threshold is None:
            return None
        day_key = day or self._local_now(self._clock()).date().isoformat()
        marker = f"{scope}:{threshold}"
        with self._lock:
            notified = self._budget_notified.setdefault(day_key, set())
            if marker in notified:
                return None
            notified.add(marker)
            if len(self._budget_notified) > 7:
                for stale in sorted(self._budget_notified)[:-7]:
                    self._budget_notified.pop(stale, None)
        return self.notify(
            "budget_threshold",
            "P1",
            summary=(
                f"{scope} 日预算已用 {percent:.1f}%（{spend:.2f}/{limit:.2f} USD，"
                f"阈值 {threshold}%）"
            ),
            key=marker,
            details={"scope": scope, "threshold": threshold},
        )

    def record_llm_outcome(self, success: bool, *, model: str | None = None) -> dict | None:
        """记录一次模型调用结果；10 分钟窗口失败率 ≥20% 且 ≥10 次时发 P1。"""
        if not self.enabled:
            return None
        now = self._clock()
        with self._lock:
            self._llm_events.append((now, bool(success)))
            while self._llm_events and now - self._llm_events[0][0] > _LLM_WINDOW_SECONDS:
                self._llm_events.popleft()
            while len(self._llm_events) > 2000:
                self._llm_events.popleft()
            total = len(self._llm_events)
            failures = sum(1 for _, ok in self._llm_events if not ok)
        if total < _LLM_MIN_CALLS or failures < _LLM_MIN_FAILURES:
            return None
        rate = failures / total
        if rate < _LLM_FAILURE_RATE:
            return None
        return self.notify(
            "llm_failure_rate",
            "P1",
            summary=f"近 10 分钟模型失败 {failures}/{total}（{rate:.0%}）",
            key="llm",
            details={"model": model or "unknown"},
        )

    # -- 线程收尾（测试 / 进程退出） ---------------------------------------
    def wait_for_idle(self, timeout: float = 5.0) -> bool:
        """等待所有已派发的后台发送线程结束（测试用）。"""
        deadline = time.monotonic() + max(0.0, timeout)
        while True:
            with self._lock:
                threads = [t for t in self._threads if t.is_alive()]
            if not threads:
                return True
            for thread in threads:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                thread.join(remaining)

    def close(self) -> None:
        self._stop.set()
        with self._lock:
            self._closed = True
            flusher = self._flusher
            self._flusher = None
        if flusher is not None and flusher is not threading.current_thread():
            flusher.join(timeout=1.0)

    def snapshot(self) -> dict:
        """不含任何密钥的只读状态（排查「告警器是不是死了」用）。"""
        with self._lock:
            return {
                "enabled": self.enabled,
                "configured": self.configured,
                "min_level": self.min_level,
                "message_format": self.message_format,
                "env": self.env_name,
                "pending_p1": len(self._p1_pending),
                "pending_p2": sum(self._p2_counts.values()),
                "inflight": sum(1 for t in self._threads if t.is_alive()),
                "last_success_at": self.last_success_at,
            }


# ---------------------------------------------------------------------------
# 模块级单例与业务入口
# ---------------------------------------------------------------------------

_manager: AlertManager | None = None
_manager_lock = threading.Lock()


def _get_manager() -> AlertManager:
    global _manager
    with _manager_lock:
        if _manager is None:
            _manager = AlertManager.from_config()
        return _manager


def reset_state() -> None:
    """丢弃单例（测试隔离 / 配置热更新后重新读 env）。"""
    global _manager
    with _manager_lock:
        manager = _manager
        _manager = None
    if manager is not None:
        manager.close()


def wait_for_idle(timeout: float = 5.0) -> bool:
    with _manager_lock:
        manager = _manager
    if manager is None:
        return True
    return manager.wait_for_idle(timeout)


def snapshot() -> dict:
    with _manager_lock:
        manager = _manager
    if manager is None:
        return {"enabled": False, "configured": False, "initialized": False}
    data = manager.snapshot()
    data["initialized"] = True
    return data


def notify(
    event: Any,
    level: Any = DEFAULT_LEVEL,
    *,
    summary: Any = "",
    key: Any = "",
    details: Any = None,
    force: bool = False,
    sync: bool = False,
) -> dict:
    """通用告警入口：**不抛异常**、默认不阻塞调用方。"""
    try:
        return _get_manager().notify(
            event,
            level,
            summary=summary,
            key=key,
            details=details,
            force=force,
            sync=sync,
        )
    except Exception as exc:  # noqa: BLE001 - 告警失败绝不能影响业务
        _log_internal_error(event, level, key, exc)
        return _result(
            "error",
            event=str(event or "")[:40],
            level=str(level or "")[:4],
            key=_clean_key(key),
            reason=type(exc).__name__,
        )


def flush(*, force: bool = False, sync: bool = True) -> list[dict]:
    try:
        return _get_manager().flush(force=force, sync=sync)
    except Exception as exc:  # noqa: BLE001
        _log_internal_error("flush", "", "", exc)
        return []


def _log_internal_error(event: Any, level: Any, key: Any, exc: BaseException) -> None:
    try:
        logger.warning(
            json.dumps(
                {
                    "event": "alert_internal_error",
                    "alert_event": str(event or "")[:40],
                    "level": str(level or "")[:4],
                    "key": _clean_key(key),
                    "reason": type(exc).__name__,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
    except Exception:  # noqa: BLE001
        pass


def check_budget_threshold(
    scope: str, spend_usd: float, limit_usd: float, *, day: str | None = None
) -> dict | None:
    """预算比例钩子（``ai/quota.py`` 调用）：50/80/100% 各一次/天。"""
    try:
        return _get_manager().check_budget_threshold(
            scope, spend_usd, limit_usd, day=day
        )
    except Exception as exc:  # noqa: BLE001
        _log_internal_error("budget_threshold", "P1", scope, exc)
        return None


def record_llm_outcome(success: bool, *, model: str | None = None) -> dict | None:
    """LLM 失败率钩子（``llm.generate`` 调用）；失败只记日志，不影响调用。"""
    try:
        return _get_manager().record_llm_outcome(success, model=model)
    except Exception as exc:  # noqa: BLE001
        _log_internal_error("llm_failure_rate", "P1", "llm", exc)
        return None


# --- 已接入的自动事件（业务侧只调用这些，便于统一改口径） -------------------


def notify_http_5xx(
    *, method: str, path: str, request_id: str | None, error_type: str
) -> dict:
    """未处理异常 → P0（同一 method+path+异常类型 5 分钟内去重）。"""
    return notify(
        "http_5xx",
        "P0",
        summary=f"{method} {path} 未处理异常（{error_type}）",
        key=f"{method}:{path}:{error_type}",
        details={"request_id": request_id or ""},
    )


def notify_billing_settle_failed(
    *, hold_id: str, user_id: str | None, actual_micro_usd: int, error_type: str
) -> dict:
    """计费结算失败（hold 保留、可重试）→ P0。"""
    return notify(
        "billing_settle_failed",
        "P0",
        summary="AI 计费结算失败（hold 保留，等待重试）",
        key="settle_failed",
        details={
            "hold_id": hold_id,
            "user_id": user_id or "",
            "actual_micro_usd": actual_micro_usd,
            "error": error_type,
        },
    )


def notify_billing_overrun(
    *,
    hold_id: str,
    user_id: str | None,
    reserved_micro_usd: int,
    actual_micro_usd: int,
) -> dict:
    """结算超出预占（overrun）→ P1（按用户 15 分钟聚合）。"""
    overrun = max(0, int(actual_micro_usd) - int(reserved_micro_usd))
    return notify(
        "billing_overrun",
        "P1",
        summary=f"AI 结算超出预占 {overrun} µUSD",
        key=f"overrun:{user_id or '-'}",
        details={
            "hold_id": hold_id,
            "reserved_micro_usd": reserved_micro_usd,
            "actual_micro_usd": actual_micro_usd,
        },
    )


def send_test(
    message: str = "", level: str = "P1", *, sync: bool = True
) -> dict:
    """管理员测试消息：绕过去重 / 聚合 / 维护模式，同步返回真实发送结果。"""
    return notify(
        "test",
        level,
        summary=_clean_summary(message, fallback="管理员测试消息"),
        key="test",
        details={"source": "/api/admin/alerts/test"},
        force=True,
        sync=sync,
    )
