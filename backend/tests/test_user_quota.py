"""用户额度 API 离线验收（v1.1 P0 / P2-39，specs/048）。

覆盖：

1. 身份：没有游客 Cookie 的匿名请求 → 401 未登录；游客（已下发 Cookie）→ 403；
2. 载荷：8 个 feature、``{feature, limit, used, remaining, resetAt, source}``，
   ``limit``/``source`` 与 ``quota_config.effective_limit`` 同源；
3. ``used`` 取 ``ai_quota.used_units`` 当天行，``remaining`` 不为负；``ai_quota``
   缺表时按 0（展示接口不 500）；
4. ``0`` = 关闭该功能（limit 与 remaining 都是 0，不提供「无限」）；
5. 来源分层：config（env）→ default（后台全局默认）→ user_override（单用户覆盖）；
6. ``resetAt`` = ``AI_QUOTA_TIMEZONE`` 次日 00:00（ISO8601，每个 feature 同值）；
7. 未迁移（``quota_overrides`` 缺失）→ 503，不拿默认值冒充生效额度；
8. 与管理员口径一致：``/api/quota`` 的 limit/used/source 等于
   ``/api/admin/quotas/users/{id}`` 的 effectiveLimit/usedToday/source。
"""
from __future__ import annotations

import sqlite3
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

import config
import quota_config
from ai import ledger
from tests.migration_utils import assert_alembic_ok, run_alembic

USER_EMAIL = "quota-user@example.com"
USER_PASSWORD = "quota-password-123"
REQUIRED_FEATURE_KEYS = {
    "feature",
    "limit",
    "used",
    "remaining",
    "resetAt",
    "source",
}


# ---------------------------------------------------------------------------
# helpers / fixtures
# ---------------------------------------------------------------------------

def _db_exec(sql: str, params: tuple = ()) -> None:
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def _insert_used(user_id: str, feature: str, used: int, limit: int = 999) -> None:
    """写一条当天的 ``ai_quota`` 用量行（审计用 limit_units 不参与判定）。"""
    _db_exec(
        "INSERT INTO ai_quota (user_id, day, feature, used_units, limit_units) "
        "VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(user_id, day, feature) DO UPDATE SET used_units = excluded.used_units",
        (user_id, ledger.day_of(), feature, used, limit),
    )


def _feature_map(body: dict) -> dict[str, dict]:
    return {item["feature"]: item for item in body["features"]}


@pytest.fixture()
def migrated_db():
    """当前用例的临时库迁到 head（ai_quota / quota_overrides / app_settings 可用）。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (quota)"
    )
    quota_config.invalidate()
    return config.AUTH_DB_PATH


@pytest.fixture()
def quota_client(make_client, migrated_db):
    """已迁移库上注册并登录的用户。"""
    with make_client() as client:
        response = client.post(
            "/api/auth/signup",
            json={"email": USER_EMAIL, "password": USER_PASSWORD},
        )
        assert response.status_code == 201, response.text
        user = response.json()["user"]
        client.user_id = user["id"]
        client.user_email = user["email"]
        yield client


# ---------------------------------------------------------------------------
# 1. 身份：401 / 403
# ---------------------------------------------------------------------------

def test_quota_401_for_anonymous_then_403_for_guest(make_client, migrated_db):
    with make_client() as anonymous:
        first = anonymous.get("/api/quota")
        assert first.status_code == 401, first.text
        assert first.json()["detail"] == "未登录"
        # 首次请求由身份中间件下发 ln_guest；之后的请求就是「游客」了。
        second = anonymous.get("/api/quota")
        assert second.status_code == 403, second.text
        assert "登录" in second.json()["detail"]


# ---------------------------------------------------------------------------
# 2. 载荷形状 / 数值 / 重置时间
# ---------------------------------------------------------------------------

def test_quota_payload_shape_values_and_reset_time(quota_client):
    response = quota_client.get("/api/quota")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["day"] == ledger.day_of()
    assert body["timezone"] == config.AI_QUOTA_TIMEZONE
    assert [item["feature"] for item in body["features"]] == list(
        quota_config.QUOTA_FEATURES
    )

    # resetAt：AI_QUOTA_TIMEZONE 的次日 00:00，ISO8601 带偏移。
    reset_at = datetime.fromisoformat(body["resetAt"])
    assert reset_at.tzinfo is not None
    tz = ZoneInfo(config.AI_QUOTA_TIMEZONE)
    expected = (datetime.now(tz) + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    assert abs((reset_at - expected).total_seconds()) < 5
    assert reset_at.astimezone(tz).hour == 0
    assert reset_at.astimezone(tz).minute == 0

    for item in body["features"]:
        assert set(item) == REQUIRED_FEATURE_KEYS
        limit, source, _default, _override = quota_config.effective_limit(
            item["feature"], quota_client.user_id
        )
        assert item["limit"] == limit
        assert item["source"] == source
        assert item["source"] in ("config", "default", "user_override")
        assert item["used"] == 0
        assert item["remaining"] == max(0, limit)
        assert item["resetAt"] == body["resetAt"], "同一配额日的重置时间必须一致"


def test_quota_used_today_comes_from_ai_quota(quota_client):
    _insert_used(quota_client.user_id, "translate", 3)
    body = quota_client.get("/api/quota").json()
    translate = _feature_map(body)["translate"]
    assert translate["used"] == 3
    assert translate["remaining"] == max(0, translate["limit"] - 3)


def test_quota_used_zero_when_ai_quota_table_missing(quota_client):
    _db_exec("DROP TABLE ai_quota")
    response = quota_client.get("/api/quota")
    assert response.status_code == 200, response.text
    assert all(item["used"] == 0 for item in response.json()["features"])


# ---------------------------------------------------------------------------
# 3. 0 = 关闭
# ---------------------------------------------------------------------------

def test_quota_zero_limit_means_feature_off(quota_client, monkeypatch):
    monkeypatch.setattr(
        config, "AI_DAILY_QUOTA_TRANSLATE_BATCHES", 0, raising=False
    )
    body = quota_client.get("/api/quota").json()
    translate = _feature_map(body)["translate"]
    assert translate["limit"] == 0
    assert translate["remaining"] == 0
    assert translate["source"] == "config"


# ---------------------------------------------------------------------------
# 4. 来源分层
# ---------------------------------------------------------------------------

def test_quota_source_layers_config_default_and_user_override(quota_client):
    baseline = _feature_map(quota_client.get("/api/quota").json())["translate"]
    assert baseline["source"] == "config", "只有 env 时来源是 config"

    _db_exec(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, "
        "updated_at = excluded.updated_at",
        (quota_config.DEFAULTS_KEY, '{"translate": 30}', int(time.time())),
    )
    quota_config.invalidate()
    default_layer = _feature_map(quota_client.get("/api/quota").json())["translate"]
    assert default_layer["source"] == "default"
    assert default_layer["limit"] == 30

    _db_exec(
        "INSERT INTO quota_overrides "
        "(user_id, feature, limit_units, reason, created_by, created_at_ms, updated_at_ms) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (quota_client.user_id, "translate", 7, "test", "admin", 1, 1),
    )
    quota_config.invalidate()
    override_layer = _feature_map(quota_client.get("/api/quota").json())["translate"]
    assert override_layer["source"] == "user_override"
    assert override_layer["limit"] == 7


# ---------------------------------------------------------------------------
# 5. 未迁移 → 503（与管理员接口同口径）
# ---------------------------------------------------------------------------

def test_quota_returns_503_when_override_table_missing(client):
    response = client.get("/api/quota")
    assert response.status_code == 503, response.text
    assert "alembic upgrade head" in response.json()["detail"]


# ---------------------------------------------------------------------------
# 6. 与管理员口径一致
# ---------------------------------------------------------------------------

def test_quota_matches_admin_endpoint(quota_client, monkeypatch):
    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({quota_client.user_email}), raising=False
    )
    _insert_used(quota_client.user_id, "reading", 2)

    user_side = _feature_map(quota_client.get("/api/quota").json())
    admin_response = quota_client.get(
        f"/api/admin/quotas/users/{quota_client.user_id}"
    )
    assert admin_response.status_code == 200, admin_response.text
    admin_side = {
        item["feature"]: item for item in admin_response.json()["features"]
    }
    assert set(admin_side) == set(user_side)
    for feature, item in user_side.items():
        assert item["limit"] == admin_side[feature]["effectiveLimit"]
        assert item["used"] == admin_side[feature]["usedToday"]
        assert item["remaining"] == admin_side[feature]["remaining"]
        assert item["source"] == admin_side[feature]["source"]
