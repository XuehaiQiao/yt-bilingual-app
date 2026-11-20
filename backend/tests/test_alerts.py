"""飞书告警（M5，specs/035-feishu-alerts）核心离线测试。

覆盖：

1. 关闭 / 未配置 webhook：不发、不崩、不建后台线程；
2. 文本 / 富文本卡片 payload；timestamp + HMAC-SHA256 签名可复算；
3. 超时、断网、非 2xx、飞书非 0 code：只返回失败结果，不抛异常；
4. 去重（同 key 5 分钟）、P1 15 分钟聚合、P2 每日摘要、维护模式静默 P0 仍发；
5. 最低级别过滤、未知事件、强制发送、异步发送 + wait_for_idle；
6. 预算 50/80/100% 每档每天一次；LLM 失败率窗口；
7. payload/日志脱敏（webhook/secret 不出现）；
8. 巡检脚本状态机（连续 N 次失败、去重、恢复、dry-run、自检）。

全部离线：transport 是内存假函数，不请求飞书；不使用真实 webhook/secret。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import importlib.util
import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

import alerts
import config

FAKE_WEBHOOK = "https://example.invalid/open-apis/bot/v2/hook/offline-test"
FAKE_SECRET = "offline-signing-secret"


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------


class FakeTransport:
    """记录请求并按脚本返回；默认飞书成功响应。"""

    def __init__(self, responses=None):
        self.calls: list[dict] = []
        self.responses = list(responses or [])
        self.error: BaseException | None = None
        self._lock = threading.Lock()

    def __call__(self, url, body, timeout):
        payload = json.loads(body.decode("utf-8"))
        with self._lock:
            self.calls.append({"url": url, "payload": payload, "timeout": timeout})
        if self.error is not None:
            raise self.error
        if self.responses:
            return self.responses.pop(0)
        return 200, '{"code":0,"msg":"success"}'

    @property
    def bodies(self) -> list[str]:
        return [json.dumps(call["payload"], ensure_ascii=False) for call in self.calls]


class FakeClock:
    def __init__(self, value: float = 1_700_000_000.0):
        self.value = value

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class FakeLocalNow:
    def __init__(self, moment: datetime):
        self.moment = moment

    def __call__(self, _ts: float) -> datetime:
        return self.moment


def make_manager(transport=None, **overrides) -> alerts.AlertManager:
    kwargs = dict(
        enabled=True,
        webhook_url=FAKE_WEBHOOK,
        webhook_secret="",
        min_level="P2",
        at_user_id="",
        message_format="text",
        env_name="test",
        dedupe_seconds=300.0,
        p1_aggregate_seconds=900.0,
        digest_hour=9,
        timeout_seconds=5.0,
        transport=transport or FakeTransport(),
        maintenance_check=lambda: False,
        async_send=False,
        background_flush=False,
        clock=FakeClock(),
    )
    kwargs.update(overrides)
    return alerts.AlertManager(**kwargs)


def _text_of(call: dict) -> str:
    return call["payload"]["content"]["text"]


@pytest.fixture(autouse=True)
def _reset_alerts():
    alerts.reset_state()
    yield
    alerts.reset_state()


# ---------------------------------------------------------------------------
# 1. 关闭 / 未配置
# ---------------------------------------------------------------------------


def test_disabled_does_not_send():
    transport = FakeTransport()
    manager = make_manager(transport=transport, enabled=False)
    result = manager.notify("test", "P0", summary="x", force=True, sync=True)
    assert result["status"] == "disabled"
    assert result["sent"] is False
    assert transport.calls == []
    manager.close()


def test_enabled_without_webhook_does_not_crash(monkeypatch):
    transport = FakeTransport()
    manager = make_manager(transport=transport, webhook_url="")
    result = manager.notify("test", "P0", summary="x", force=True, sync=True)
    assert result["status"] == "not_configured"
    assert transport.calls == []

    # 全局入口同样不抛异常。
    monkeypatch.setattr(config, "FEISHU_ALERTS_ENABLED", True, raising=False)
    monkeypatch.setattr(config, "FEISHU_WEBHOOK_URL", "", raising=False)
    alerts.reset_state()
    global_result = alerts.notify("test", "P1", summary="x", force=True, sync=True)
    assert global_result["status"] == "not_configured"


def test_unknown_event_and_invalid_level_rejected():
    transport = FakeTransport()
    manager = make_manager(transport=transport)
    assert manager.notify("not_an_event", "P0", sync=True)["status"] == "unknown_event"
    assert manager.notify("test", "PX", sync=True)["status"] == "invalid_level"
    assert transport.calls == []


# ---------------------------------------------------------------------------
# 2. payload / 签名
# ---------------------------------------------------------------------------


def test_text_payload_and_signature_recomputable():
    transport = FakeTransport()
    clock = FakeClock(1_700_000_000.0)
    manager = make_manager(
        transport=transport, webhook_secret=FAKE_SECRET, clock=clock
    )
    result = manager.notify(
        "test",
        "P1",
        summary="hello offline",
        key="k1",
        details={"foo": "bar"},
        force=True,
        sync=True,
    )
    assert result["status"] == "sent" and result["sent"] is True
    assert len(transport.calls) == 1
    call = transport.calls[0]
    payload = call["payload"]
    assert payload["msg_type"] == "text"
    text = _text_of(call)
    assert "P1" in text and "test" in text and "hello offline" in text and "k1" in text
    assert "foo=bar" in text
    assert call["timeout"] == 5.0

    # 独立实现复算签名：key = f"{timestamp}\n{secret}"，消息体为空，base64。
    timestamp = "1700000000"
    assert payload["timestamp"] == timestamp
    expected = base64.b64encode(
        hmac.new(
            f"{timestamp}\n{FAKE_SECRET}".encode("utf-8"),
            digestmod=hashlib.sha256,
        ).digest()
    ).decode("utf-8")
    assert payload["sign"] == expected
    assert alerts.gen_sign(timestamp, FAKE_SECRET) == expected

    # 请求体里不得出现 webhook / secret。
    body = transport.bodies[0]
    assert FAKE_SECRET not in body and FAKE_WEBHOOK not in body


def test_card_payload_and_p0_at_mention():
    transport = FakeTransport()
    manager = make_manager(
        transport=transport, message_format="card", at_user_id="ou_offline"
    )
    manager.notify("test", "P0", summary="card alert", force=True, sync=True)
    payload = transport.calls[0]["payload"]
    assert payload["msg_type"] == "interactive"
    card = payload["card"]
    assert card["header"]["template"] == "red"
    assert "P0" in card["header"]["title"]["content"]
    markdown = card["elements"][0]["text"]["content"]
    assert "<at id=ou_offline></at>" in markdown
    assert "card alert" in markdown

    # P1 不 @ 人。
    manager.notify("test", "P1", summary="no mention", key="p1", force=True, sync=True)
    markdown_p1 = transport.calls[1]["payload"]["card"]["elements"][0]["text"]["content"]
    assert "ou_offline" not in markdown_p1


def test_text_payload_p0_at_mention():
    transport = FakeTransport()
    manager = make_manager(transport=transport, at_user_id="all")
    manager.notify("test", "P0", summary="x", force=True, sync=True)
    assert '<at user_id="all"></at>' in _text_of(transport.calls[0])
    manager.notify("test", "P2", summary="y", key="p2", force=True, sync=True)
    assert "at user_id" not in _text_of(transport.calls[1])


def test_details_are_redacted_and_truncated():
    text = alerts.sanitize_details(
        {"hook": FAKE_WEBHOOK, "secret": FAKE_SECRET, "long": "x" * 900},
        redact=(FAKE_WEBHOOK, FAKE_SECRET),
    )
    assert FAKE_WEBHOOK not in text and FAKE_SECRET not in text
    assert "[redacted]" in text
    assert len(text) <= 501  # 500 字符 + 省略号

    transport = FakeTransport()
    manager = make_manager(transport=transport, webhook_secret=FAKE_SECRET)
    manager.notify(
        "test",
        "P1",
        summary="redact",
        details={"secret": FAKE_SECRET, "hook": FAKE_WEBHOOK},
        force=True,
        sync=True,
    )
    body = transport.bodies[0]
    assert FAKE_SECRET not in body and FAKE_WEBHOOK not in body


# ---------------------------------------------------------------------------
# 3. 超时 / 非 2xx / 飞书非 0 code：不抛异常
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (TimeoutError("timed out"), "timeout"),
        (OSError("network down"), "oserror"),
    ],
)
def test_transport_exception_does_not_raise(error, reason):
    transport = FakeTransport()
    transport.error = error
    manager = make_manager(transport=transport)
    result = manager.notify("test", "P0", summary="x", force=True, sync=True)
    assert result["status"] == "failed"
    assert result["reason"] == reason
    assert result["sent"] is False
    assert len(transport.calls) == 1


def test_non_2xx_and_feishu_error_code_do_not_raise():
    transport = FakeTransport(
        responses=[
            (500, "internal error"),
            (200, '{"code":19021,"msg":"sign match fail"}'),
        ]
    )
    manager = make_manager(transport=transport)
    first = manager.notify("test", "P0", summary="a", force=True, sync=True)
    second = manager.notify("test", "P0", summary="b", force=True, sync=True)
    assert first["status"] == "failed" and first["reason"] == "http_500"
    assert second["status"] == "failed" and second["reason"] == "feishu_code_19021"


def test_async_send_does_not_block_and_swallows_failures():
    transport = FakeTransport(responses=[(500, "boom")])
    manager = make_manager(transport=transport, async_send=True)
    started = time.monotonic()
    result = manager.notify("test", "P0", summary="async", force=True, sync=False)
    elapsed = time.monotonic() - started
    assert result["status"] == "queued" and result["queued"] is True
    assert elapsed < 1.0
    assert manager.wait_for_idle(2.0) is True
    assert len(transport.calls) == 1
    assert manager.snapshot()["inflight"] == 0


# ---------------------------------------------------------------------------
# 4. 去重 / 聚合 / 每日摘要 / 维护模式
# ---------------------------------------------------------------------------


def test_dedupe_same_event_key_for_five_minutes():
    transport = FakeTransport()
    clock = FakeClock()
    manager = make_manager(transport=transport, clock=clock, dedupe_seconds=300)
    first = manager.notify("http_5xx", "P0", summary="a", key="GET:/x:RuntimeError", sync=True)
    second = manager.notify("http_5xx", "P0", summary="a", key="GET:/x:RuntimeError", sync=True)
    other = manager.notify("http_5xx", "P0", summary="b", key="GET:/y:RuntimeError", sync=True)
    assert first["status"] == "sent"
    assert second["status"] == "suppressed_dedupe"
    assert other["status"] == "sent"
    assert len(transport.calls) == 2

    clock.advance(301)
    third = manager.notify("http_5xx", "P0", summary="a", key="GET:/x:RuntimeError", sync=True)
    assert third["status"] == "sent"
    assert len(transport.calls) == 3


def test_p1_aggregation_window():
    transport = FakeTransport()
    clock = FakeClock()
    manager = make_manager(transport=transport, clock=clock, p1_aggregate_seconds=900)
    first = manager.notify("billing_overrun", "P1", summary="overrun a", key="user-1")
    second = manager.notify("budget_threshold", "P1", summary="budget 80%", key="global:80")
    assert first["status"] == "aggregated" and second["status"] == "aggregated"
    assert transport.calls == []

    clock.advance(901)
    sent = manager.flush()
    assert len(sent) == 1 and sent[0]["status"] == "sent"
    assert len(transport.calls) == 1
    text = _text_of(transport.calls[0])
    assert "p1_aggregate" in text and "P1" in text
    assert "overrun a" in text and "budget 80%" in text
    assert "billing_overrun×1" in text and "budget_threshold×1" in text
    # 已经发过，再 flush 不重复。
    assert manager.flush() == []


def test_p2_daily_digest():
    transport = FakeTransport()
    clock = FakeClock()
    local = FakeLocalNow(datetime(2026, 1, 1, 8, 0, tzinfo=timezone.utc))
    manager = make_manager(
        transport=transport, clock=clock, digest_hour=9, local_now=local
    )
    manager.notify("backup_failed", "P2", summary="backup missing")
    manager.notify("backup_failed", "P2", summary="backup zero bytes")
    assert transport.calls == []
    assert manager.flush() == []  # 08:00，未到 9 点

    local.moment = datetime(2026, 1, 1, 9, 5, tzinfo=timezone.utc)
    sent = manager.flush()
    assert len(sent) == 1 and sent[0]["status"] == "sent"
    text = _text_of(transport.calls[0])
    assert "p2_digest" in text and "每日摘要" in text and "backup_failed×2" in text

    # 当天之后再有 P2：进入下一天摘要，当天不重复发。
    manager.notify("backup_failed", "P2", summary="later today")
    assert manager.flush() == []
    local.moment = datetime(2026, 1, 2, 9, 5, tzinfo=timezone.utc)
    sent_next = manager.flush()
    assert len(sent_next) == 1
    assert "backup_failed×1" in _text_of(transport.calls[1])


def test_maintenance_mode_silences_p1_p2_but_not_p0():
    transport = FakeTransport()
    manager = make_manager(
        transport=transport, maintenance_check=lambda: True, dedupe_seconds=0
    )
    p0 = manager.notify("http_5xx", "P0", summary="p0", key="p0", sync=True)
    p1 = manager.notify("billing_overrun", "P1", summary="p1", key="p1")
    p2 = manager.notify("backup_failed", "P2", summary="p2")
    assert p0["status"] == "sent"
    assert p1["status"] == "suppressed_maintenance"
    assert p2["status"] == "suppressed_maintenance"
    assert len(transport.calls) == 1


def test_min_level_filter_and_force_bypass():
    transport = FakeTransport()
    manager = make_manager(transport=transport, min_level="P0", dedupe_seconds=0)
    assert manager.notify("billing_overrun", "P1", summary="p1")["status"] == "filtered"
    assert manager.notify("backup_failed", "P2", summary="p2")["status"] == "filtered"
    forced = manager.notify("billing_overrun", "P1", summary="forced", force=True, sync=True)
    assert forced["status"] == "sent"
    assert len(transport.calls) == 1


# ---------------------------------------------------------------------------
# 5. 预算阈值 / LLM 失败率
# ---------------------------------------------------------------------------


def test_budget_threshold_once_per_day_per_level():
    transport = FakeTransport()
    clock = FakeClock()
    local = FakeLocalNow(datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc))
    manager = make_manager(
        transport=transport, clock=clock, local_now=local, p1_aggregate_seconds=900
    )
    assert manager.check_budget_threshold("global", 4.0, 10.0) is None  # 40%
    first = manager.check_budget_threshold("global", 5.1, 10.0)  # 51%
    assert first is not None and first["status"] == "aggregated"
    assert manager.check_budget_threshold("global", 5.2, 10.0) is None  # 同档同日
    eighty = manager.check_budget_threshold("global", 8.5, 10.0)
    assert eighty is not None and eighty["key"].endswith(":80")
    full = manager.check_budget_threshold("global", 10.0, 10.0)
    assert full is not None and full["key"].endswith(":100")

    local.moment = datetime(2026, 1, 2, 12, 0, tzinfo=timezone.utc)
    clock.advance(301)  # 越过 5 分钟去重窗口，验证「新的一天重新计数」
    next_day = manager.check_budget_threshold("global", 5.1, 10.0)
    assert next_day is not None

    manager.flush(force=True)
    assert len(transport.calls) == 1
    text = _text_of(transport.calls[0])
    assert "budget_threshold" in text
    assert "global 日预算已用 51.0%" in text


def test_llm_failure_rate_window():
    transport = FakeTransport()
    clock = FakeClock()
    manager = make_manager(transport=transport, clock=clock, p1_aggregate_seconds=1)
    # 10 次成功 + 1 次失败：低于「≥10 次调用且失败 ≥2」门槛。
    for _ in range(10):
        assert manager.record_llm_outcome(True, model="m") is None
    assert manager.record_llm_outcome(False, model="m") is None
    # 第 2 个失败：窗口内 12 次调用 / 2 次失败 = 16.7% < 20%，仍不告警。
    assert manager.record_llm_outcome(False, model="m") is None
    # 再失败 2 次：4/14 = 28.6% ≥ 20%。
    manager.record_llm_outcome(False, model="m")
    triggered = manager.record_llm_outcome(False, model="m")
    assert triggered is not None and triggered["event"] == "llm_failure_rate"

    manager.flush(force=True)
    text = _text_of(transport.calls[0])
    assert "llm_failure_rate" in text and "模型失败" in text


# ---------------------------------------------------------------------------
# 6. 巡检脚本（scripts/check-alerts.py）
# ---------------------------------------------------------------------------


def _load_script():
    path = Path(__file__).resolve().parents[2] / "scripts" / "check-alerts.py"
    spec = importlib.util.spec_from_file_location("check_alerts_script", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def script():
    return _load_script()


def test_health_script_consecutive_failures_and_recovery(script, tmp_path):
    state_path = tmp_path / "alerts" / "health_state.json"
    sent = []

    def fail_probe(_url, _timeout):
        return {
            "ok": False,
            "http_status": 503,
            "app_status": "degraded",
            "details": {"http_status": 503, "app_status": "degraded"},
        }

    def notify_fn(event, level, **kwargs):
        sent.append({"event": event, "level": level, **kwargs})
        return {"status": "sent", "sent": True}

    first = script.run_check(
        url="http://127.0.0.1:8000/healthz",
        state_path=state_path,
        threshold=2,
        timeout=1,
        dedupe_seconds=1800,
        probe_fn=fail_probe,
        notify_fn=notify_fn,
    )
    assert first["ok"] is False and first["alert"] is None
    assert first["reason"].startswith("below_threshold")
    assert state_path.exists()

    second = script.run_check(
        url="http://127.0.0.1:8000/healthz",
        state_path=state_path,
        threshold=2,
        timeout=1,
        dedupe_seconds=1800,
        probe_fn=fail_probe,
        notify_fn=notify_fn,
    )
    assert second["alert"]["sent"] is True
    assert sent and sent[0]["event"] == "health_unhealthy" and sent[0]["level"] == "P0"
    assert sent[0]["sync"] is True and sent[0]["force"] is True

    third = script.run_check(
        url="http://127.0.0.1:8000/healthz",
        state_path=state_path,
        threshold=2,
        timeout=1,
        dedupe_seconds=1800,
        probe_fn=fail_probe,
        notify_fn=notify_fn,
    )
    assert third["reason"] == "deduped" and third["alert"] is None
    assert len(sent) == 1

    healthy = script.run_check(
        url="http://127.0.0.1:8000/healthz",
        state_path=state_path,
        threshold=2,
        timeout=1,
        dedupe_seconds=1800,
        probe_fn=lambda _u, _t: {"ok": True, "details": {"http_status": 200}},
        notify_fn=notify_fn,
    )
    assert healthy["ok"] is True and healthy["consecutive_failures"] == 0


def test_health_script_dry_run_does_not_write_or_send(script, tmp_path):
    state_path = tmp_path / "health_state.json"
    sent = []
    result = script.run_check(
        url="http://127.0.0.1:8000/healthz",
        state_path=state_path,
        threshold=1,
        timeout=1,
        dedupe_seconds=0,
        dry_run=True,
        probe_fn=lambda _u, _t: {
            "ok": False,
            "http_status": None,
            "app_status": None,
            "details": {},
        },
        notify_fn=lambda *a, **k: sent.append((a, k)) or {"sent": True},
    )
    assert result["alert"]["status"] == "would_send"
    assert sent == []
    assert not state_path.exists()


def test_health_script_fetch_health_parsing(script, monkeypatch):
    class FakeResponse:
        def __init__(self, status, body):
            self.status = status
            self.body = body

        def getcode(self):
            return self.status

        def read(self, _limit):
            return self.body

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    monkeypatch.setattr(
        script.urllib.request,
        "urlopen",
        lambda _request, timeout: FakeResponse(
            200,
            b'{"status":"ok","version":"1.2.3","db":{"ok":true,'
            b'"migrations":{"current":"abc","head":"abc"}},"uptime_seconds":1.5}',
        ),
    )
    probe = script.fetch_health("http://127.0.0.1:8000/healthz", 1)
    assert probe["ok"] is True and probe["http_status"] == 200
    assert probe["details"]["version"] == "1.2.3"
    assert probe["details"]["migration_current"] == "abc"

    monkeypatch.setattr(
        script.urllib.request,
        "urlopen",
        lambda _request, timeout: (_ for _ in ()).throw(
            script.urllib.error.URLError("connection refused")
        ),
    )
    failed = script.fetch_health("http://127.0.0.1:8000/healthz", 1)
    assert failed["ok"] is False
    assert failed["details"]["reason"] == "request_failed:URLError"


def test_health_script_self_test_offline(script, capsys):
    assert script.main(["--self-test"]) == 0
    line = capsys.readouterr().out.strip().splitlines()[-1]
    payload = json.loads(line)
    assert payload["self_test"] is True
    assert payload["sent"] is True
    assert payload["has_sign"] is True and payload["sign_recomputable"] is True
    assert FAKE_SECRET not in line and FAKE_WEBHOOK not in line


def test_health_script_event_mode(script, monkeypatch, capsys):
    recorded = []
    monkeypatch.setattr(
        script.alerts,
        "notify",
        lambda event, level, **kwargs: recorded.append((event, level, kwargs))
        or {"status": "sent", "sent": True},
    )
    assert script.main(["--event", "backup_failed", "--level", "P1", "--summary", "backup missing"]) == 0
    assert recorded[0][0] == "backup_failed" and recorded[0][1] == "P1"
    assert recorded[0][2]["force"] is True
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])["sent"] is True
