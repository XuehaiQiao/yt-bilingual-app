"""飞书告警（M5）接入点的离线测试：5xx / 计费 / 预算 / 管理员端点 / 巡检。

覆盖：

1. 未处理 5xx → P0，同一异常 5 分钟去重；告警自身失败不会递归成第二次 5xx；
2. ``/healthz`` 503 不直接发（由外部巡检脚本负责）；
3. ``billing.settle`` overrun → P1 告警；``llm`` 结算失败 → P0 告警；
4. ``ai.quota`` 日预算阈值钩子；
5. ``POST /api/admin/alerts/test``：管理员 200、普通用户 403、游客 401、
   专用限流 429；关闭/未配置时返回真实状态而不是伪装成功。

全部离线：transport 是内存假函数；不请求飞书、不联网。
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import alerts
import auth_db
import billing
import config
import llm
import observability
from ai import ledger, quota
from tests.conftest import _httpx_app_kwarg_compat
from tests.migration_utils import assert_alembic_ok, run_alembic
from tests.test_alerts import FAKE_WEBHOOK, FakeTransport, make_manager


@pytest.fixture(autouse=True)
def _reset_alerts():
    alerts.reset_state()
    yield
    alerts.reset_state()


def _install_manager(monkeypatch, **overrides):
    transport = FakeTransport()
    manager = make_manager(transport=transport, **overrides)
    monkeypatch.setattr(alerts, "_manager", manager)
    monkeypatch.setattr(config, "FEISHU_ALERTS_ENABLED", True, raising=False)
    monkeypatch.setattr(config, "FEISHU_WEBHOOK_URL", FAKE_WEBHOOK, raising=False)
    return manager, transport


def _boom_app() -> FastAPI:
    app = FastAPI()

    @app.get("/api/boom")
    async def boom():  # pragma: no cover - 只在测试请求里执行
        raise RuntimeError("boom")

    app.middleware("http")(observability.record_request)
    return app


def _make_test_client(app):
    with _httpx_app_kwarg_compat():
        return TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# 1. 未处理 5xx
# ---------------------------------------------------------------------------


def test_unhandled_5xx_sends_p0_once(monkeypatch):
    _manager, transport = _install_manager(monkeypatch, dedupe_seconds=300)
    app = _boom_app()
    with _make_test_client(app) as client:
        first = client.get("/api/boom")
        second = client.get("/api/boom")

    assert first.status_code == 500 and second.status_code == 500
    assert "request_id" in first.json()
    assert len(transport.calls) == 1
    payload = transport.calls[0]["payload"]
    text = payload["content"]["text"]
    assert payload["msg_type"] == "text"
    assert "P0" in text and "http_5xx" in text
    assert "GET /api/boom" in text and "RuntimeError" in text


def test_5xx_alert_failure_does_not_recurse(monkeypatch):
    def explode(*_args, **_kwargs):
        raise RuntimeError("alert transport exploded")

    monkeypatch.setattr(alerts, "notify_http_5xx", explode)
    app = _boom_app()
    with _make_test_client(app) as client:
        first = client.get("/api/boom")
        second = client.get("/api/boom")

    # 告警函数抛异常也不能改变 500 响应或触发第二次异常处理。
    assert first.status_code == 500 and second.status_code == 500


def test_5xx_transport_failure_is_swallowed_and_deduped(monkeypatch):
    transport = FakeTransport()
    transport.error = TimeoutError("send timeout")
    manager = make_manager(transport=transport, dedupe_seconds=300)
    monkeypatch.setattr(alerts, "_manager", manager)
    app = _boom_app()
    with _make_test_client(app) as client:
        assert client.get("/api/boom").status_code == 500
        assert client.get("/api/boom").status_code == 500
    assert len(transport.calls) == 1


def test_healthz_degraded_does_not_alert_directly(monkeypatch, make_client, tmp_path):
    _manager, transport = _install_manager(monkeypatch)
    monkeypatch.setattr(
        config, "AUTH_DB_PATH", str(tmp_path / "missing.db"), raising=False
    )
    with make_client() as client:
        response = client.get("/healthz")
    assert response.status_code == 503
    assert response.json()["status"] == "degraded"
    assert transport.calls == []


# ---------------------------------------------------------------------------
# 2. 计费 / 预算钩子
# ---------------------------------------------------------------------------


@pytest.fixture()
def billing_db(tmp_path, monkeypatch):
    db = tmp_path / "alerts-billing.db"
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(db), raising=False)
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    billing.reset_cache()
    yield db
    billing.reset_cache()


def test_billing_overrun_sends_p1(billing_db, monkeypatch):
    user, _token = auth_db.create_user_with_bonus(
        "alerts-billing@example.com", "alerts-password-123", with_session=False
    )
    hold = billing.reserve(user["id"], 100, feature="translate")
    recorded: list[dict] = []
    monkeypatch.setattr(
        alerts,
        "notify_billing_overrun",
        lambda **kwargs: recorded.append(kwargs) or {"status": "queued"},
    )

    result = billing.settle(
        hold["id"],
        300,
        usage={"feature": "translate", "model_id": "deepseek-chat"},
    )
    assert result["overrun"] is True
    assert recorded == [
        {
            "hold_id": hold["id"],
            "user_id": user["id"],
            "reserved_micro_usd": 100,
            "actual_micro_usd": 300,
        }
    ]


def test_billing_no_overrun_does_not_send(billing_db, monkeypatch):
    user, _token = auth_db.create_user_with_bonus(
        "alerts-billing2@example.com", "alerts-password-123", with_session=False
    )
    hold = billing.reserve(user["id"], 500, feature="translate")
    recorded: list[dict] = []
    monkeypatch.setattr(
        alerts,
        "notify_billing_overrun",
        lambda **kwargs: recorded.append(kwargs) or {"status": "queued"},
    )
    result = billing.settle(
        hold["id"],
        200,
        usage={"feature": "translate", "model_id": "deepseek-chat"},
    )
    assert result["overrun"] is False
    assert recorded == []


def test_llm_settle_failure_sends_p0(monkeypatch):
    price = {
        "inputMicroUsdPerMtok": 1_000_000,
        "outputMicroUsdPerMtok": 2_000_000,
        "priceVersion": "test-price",
    }
    state = {
        "enabled": True,
        "user": "user-1",
        "hold": {"id": "hold-1"},
        "price": price,
        "feature": "translate",
        "target_lang": "zh-CN",
        "request_id": "req-1",
        "schema": True,
        "degraded": False,
    }
    monkeypatch.setattr(
        billing,
        "settle",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("database is locked")),
    )
    monkeypatch.setattr(ledger, "record_usage", lambda *_a, **_k: None)
    recorded: list[dict] = []
    monkeypatch.setattr(
        alerts,
        "notify_billing_settle_failed",
        lambda **kwargs: recorded.append(kwargs) or {"status": "queued"},
    )

    llm._billing_finish(
        state,
        "deepseek-chat",
        {"provider": "DeepSeek"},
        {"input_tokens": 10, "output_tokens": 5},
        "prompt",
        "text",
    )
    expected_cost = billing.token_cost_micro_usd(10, 5, price)
    assert len(recorded) == 1
    assert recorded[0]["hold_id"] == "hold-1"
    assert recorded[0]["user_id"] == "user-1"
    assert recorded[0]["actual_micro_usd"] == expected_cost
    assert recorded[0]["error_type"] == "RuntimeError"


def test_llm_generate_records_failure_and_success(monkeypatch):
    recorded: list[tuple[bool, str | None]] = []
    monkeypatch.setattr(
        alerts,
        "record_llm_outcome",
        lambda success, model=None: recorded.append((success, model)),
    )

    def boom(*_args, **_kwargs):
        raise RuntimeError("provider 500")

    monkeypatch.setattr(llm, "_generate_openai_compatible", boom)
    with pytest.raises(RuntimeError):
        llm.generate("hi", "deepseek-chat")
    assert recorded == [(False, "deepseek-chat")]

    monkeypatch.setattr(
        llm,
        "_generate_openai_compatible",
        lambda *_args, **_kwargs: ("ok", {"input_tokens": 1, "output_tokens": 1}),
    )
    assert llm.generate("hi", "deepseek-chat") == "ok"
    assert recorded[-1] == (True, "deepseek-chat")


def test_quota_budget_hook_calls_alerts(monkeypatch):
    calls: list[tuple[tuple, dict]] = []
    monkeypatch.setattr(ledger, "daily_spend", lambda _uid, _day: 5.0)
    monkeypatch.setattr(ledger, "global_daily_spend", lambda _day: 7.0)
    monkeypatch.setattr(config, "AI_DAILY_BUDGET_USER_USD", 10.0, raising=False)
    monkeypatch.setattr(config, "AI_DAILY_BUDGET_GLOBAL_USD", 20.0, raising=False)
    monkeypatch.setattr(
        alerts,
        "check_budget_threshold",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )
    quota.ensure_within_budget("user-1", "2026-11-20")
    assert calls == [
        (("user", 5.0, 10.0), {"day": "2026-11-20"}),
        (("global", 7.0, 20.0), {"day": "2026-11-20"}),
    ]


# ---------------------------------------------------------------------------
# 3. 管理员测试端点
# ---------------------------------------------------------------------------


def test_admin_alerts_test_requires_admin(client, monkeypatch):
    monkeypatch.setattr(config, "ADMIN_EMAILS", frozenset(), raising=False)
    response = client.post("/api/admin/alerts/test", json={})
    assert response.status_code == 403


def test_admin_alerts_test_requires_login(make_client):
    with make_client() as guest:
        response = guest.post("/api/admin/alerts/test", json={})
    assert response.status_code == 401


def test_admin_alerts_test_sends_and_rate_limits(client, monkeypatch):
    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({client.user_email}), raising=False
    )
    monkeypatch.setattr(
        config, "RATE_LIMIT_ADMIN_ALERT_TEST_PER_MINUTE", 3, raising=False
    )
    _manager, transport = _install_manager(monkeypatch)

    for index in range(3):
        response = client.post(
            "/api/admin/alerts/test",
            json={"message": f"hello-{index}", "level": "P1"},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["ok"] is True and body["sent"] is True
        assert body["status"] == "sent"
        assert body["enabled"] is True and body["configured"] is True
    assert len(transport.calls) == 3
    assert "hello-0" in transport.calls[0]["payload"]["content"]["text"]

    limited = client.post("/api/admin/alerts/test", json={"level": "P1"})
    assert limited.status_code == 429
    assert int(limited.headers["Retry-After"]) >= 1
    assert limited.json()["retryAfter"] >= 1
    assert len(transport.calls) == 3


def test_admin_alerts_test_validates_level(client, monkeypatch):
    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({client.user_email}), raising=False
    )
    _manager, transport = _install_manager(monkeypatch)
    response = client.post("/api/admin/alerts/test", json={"level": "P9"})
    assert response.status_code == 400
    assert transport.calls == []


def test_admin_alerts_test_reports_disabled_and_unconfigured(client, monkeypatch):
    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({client.user_email}), raising=False
    )
    monkeypatch.setattr(config, "FEISHU_ALERTS_ENABLED", False, raising=False)
    monkeypatch.setattr(config, "FEISHU_WEBHOOK_URL", "", raising=False)
    manager = make_manager(enabled=False)
    monkeypatch.setattr(alerts, "_manager", manager)

    disabled = client.post("/api/admin/alerts/test", json={})
    assert disabled.status_code == 200
    assert disabled.json()["status"] == "disabled"
    assert disabled.json()["ok"] is False

    unconfigured_manager = make_manager(enabled=True, webhook_url="")
    monkeypatch.setattr(alerts, "_manager", unconfigured_manager)
    monkeypatch.setattr(config, "FEISHU_ALERTS_ENABLED", True, raising=False)
    unconfigured = client.post("/api/admin/alerts/test", json={})
    assert unconfigured.status_code == 200
    assert unconfigured.json()["status"] == "not_configured"
    assert unconfigured.json()["ok"] is False
