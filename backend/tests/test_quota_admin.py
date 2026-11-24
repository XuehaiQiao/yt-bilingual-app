"""每日额度管理（specs/047）的离线验收：配置层 + 管理 API + 运行时生效。

覆盖：

1. ``quota_config`` 三层解析：全局默认（``app_settings.ai_quota_defaults``）>
   env/config；单用户覆盖优先；``0`` = 关闭；``null`` = 回退/清除；
2. 5 秒进程内缓存 + 管理员写入后立即失效（不用等 5s）；
3. 管理 API：面板默认值/来源 + 预算只读；默认值改/清；单用户覆盖改/清；
   今日已用/剩余；其他用户隔离；用户不存在 404；未迁移 503；
   全部 ``require_admin``（未登录 401 / 普通用户 403）；
4. 审计：动作、操作者、目标、before/after、reason；一次请求一个事务；
5. 运行时：``quota.limit_for`` / ``check_and_consume_quota`` 用生效值判定，
   429 的 ``limit`` 与快照来源一致；改默认后新请求按新值 429/通过；
6. 参数校验 400（未知 feature / ``books`` / 负数 / 超上限 / 浮点 / 空对象）。

全部离线：tmp 库 + ``alembic upgrade head`` 子进程；不联网、不碰真实 data/。
"""
from __future__ import annotations

import json
import sqlite3

import pytest

import config
import llm
import quota_config
from ai import ledger, quota
from ai.ledger import QuotaExceeded
from tests.conftest import TEST_USER_EMAIL
from tests.migration_utils import assert_alembic_ok, run_alembic

OTHER_EMAIL = "quota-other@example.com"
OTHER_PASSWORD = "quota-other-password-123"

ANALYSIS_ATTR = quota_config.FEATURE_LIMIT_ATTRS["analysis"]

DICT_PAYLOAD = {
    "word": "serendipity",
    "lemma": "serendipity",
    "ipa": "/ˌserənˈdɪpəti/",
    "pos": "n.",
    "zh": "意外发现美好事物的运气",
    "definition_en": "The luck of finding something good without looking for it.",
    "example": "It was pure serendipity that we met.",
}


# ---------------------------------------------------------------------------
# 夹具 / 工具
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _fixed_quota_tz(monkeypatch):
    monkeypatch.setattr(config, "AI_QUOTA_TIMEZONE", "Asia/Shanghai", raising=False)


@pytest.fixture(autouse=True)
def _clean_quota_cache():
    """模块级缓存跨用例存活，进出各清一次（缓存键还带 DB 路径，双保险）。"""
    quota_config.invalidate()
    yield
    quota_config.invalidate()


@pytest.fixture()
def admin_client(client, monkeypatch):
    """默认 client 的邮箱设为管理员（与 test_admin.py 同口径）。"""
    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({TEST_USER_EMAIL}), raising=False
    )
    return client


@pytest.fixture()
def other_client(make_client, admin_client):
    """普通（非管理员）登录用户，用于 403 与「其他用户不受影响」。"""
    with make_client() as client:
        response = client.post(
            "/api/auth/signup",
            json={"email": OTHER_EMAIL, "password": OTHER_PASSWORD},
        )
        assert response.status_code == 201, response.text
        client.user_id = response.json()["user"]["id"]
        yield client


@pytest.fixture()
def migrated(admin_client, other_client):
    """临时库迁移到 head；返回管理员客户端（普通用户已注册）。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (quota)"
    )
    return admin_client


def _audit_rows(action: str) -> list[dict]:
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT actor_id, action, target_type, target_id, detail_json, "
            "created_at_ms FROM admin_audit_log WHERE action = ? "
            "ORDER BY created_at_ms DESC, id DESC",
            (action,),
        ).fetchall()
    return [dict(row) for row in rows]


def _find_change(rows: list[dict], feature: str) -> dict:
    """在同类审计里找包含指定 feature 的改动（同一毫秒内顺序不保证）。"""
    for row in rows:
        detail = json.loads(row["detail_json"])
        if feature in (detail.get("changes") or {}):
            return detail
    raise AssertionError(f"审计里找不到 {feature} 的改动：{rows}")


def _seed_used(user_id: str, feature: str, used: int, limit: int = 999) -> None:
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        conn.execute(
            "INSERT INTO ai_quota (user_id, day, feature, used_units, limit_units) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, day, feature) DO UPDATE SET "
            "used_units = excluded.used_units, limit_units = excluded.limit_units",
            (user_id, ledger.day_of(), feature, used, limit),
        )


# ---------------------------------------------------------------------------
# 1. 面板：8 个功能默认值 + 预算（只读）
# ---------------------------------------------------------------------------

def test_get_quotas_lists_eight_features_and_budgets(migrated, monkeypatch):
    monkeypatch.setattr(config, "AI_DAILY_QUOTA_QUIZ", 7, raising=False)
    monkeypatch.setattr(config, "AI_DAILY_BUDGET_USER_USD", 1.5, raising=False)

    response = migrated.get("/api/admin/quotas")
    assert response.status_code == 200, response.text
    body = response.json()

    assert [item["feature"] for item in body["features"]] == list(
        quota_config.QUOTA_FEATURES
    )
    assert len(body["features"]) == 8
    by_feature = {item["feature"]: item for item in body["features"]}
    assert by_feature["quiz"] == {
        "feature": "quiz",
        "defaultLimit": 7,
        "source": "config",
    }
    assert by_feature["analysis"]["defaultLimit"] == int(
        getattr(config, ANALYSIS_ATTR)
    )
    # 预算只读展示，与 config 同值。
    assert body["budgets"] == {
        "userDailyUsd": 1.5,
        "globalDailyUsd": round(float(config.AI_DAILY_BUDGET_GLOBAL_USD), 6),
    }


# ---------------------------------------------------------------------------
# 2. 全局默认：改 / 清 / 缓存 / 审计
# ---------------------------------------------------------------------------

def test_put_defaults_returns_new_values_and_audits(migrated):
    admin_id = migrated.user_id
    response = migrated.put(
        "/api/admin/quotas/defaults", json={"limits": {"analysis": 5}}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    by_feature = {item["feature"]: item for item in body["features"]}
    assert by_feature["analysis"] == {
        "feature": "analysis",
        "defaultLimit": 5,
        "source": "default",
    }
    assert body["changes"] == {"analysis": {"from": None, "to": 5}}

    rows = _audit_rows("admin.quota.defaults_update")
    assert len(rows) == 1
    row = rows[0]
    assert row["actor_id"] == admin_id
    assert row["target_type"] == "app_settings"
    assert row["target_id"] == quota_config.DEFAULTS_KEY
    detail = _find_change(rows, "analysis")
    assert detail["changes"]["analysis"] == {"from": None, "to": 5}
    assert detail["stored"] == {"analysis": 5}

    # 再改一次：from 是上一次的值（前后值都在审计里）。
    second = migrated.put(
        "/api/admin/quotas/defaults", json={"limits": {"analysis": 9}}
    )
    assert second.status_code == 200, second.text
    detail = _find_change(_audit_rows("admin.quota.defaults_update"), "analysis")
    assert detail["changes"]["analysis"] == {"from": 5, "to": 9}


def test_put_defaults_null_reverts_to_env(migrated):
    assert migrated.put(
        "/api/admin/quotas/defaults", json={"limits": {"analysis": 4}}
    ).status_code == 200
    assert quota_config.default_limit("analysis") == (4, "default")

    response = migrated.put(
        "/api/admin/quotas/defaults", json={"limits": {"analysis": None}}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    by_feature = {item["feature"]: item for item in body["features"]}
    assert by_feature["analysis"]["defaultLimit"] == int(
        getattr(config, ANALYSIS_ATTR)
    )
    assert by_feature["analysis"]["source"] == "config"
    assert response.json()["changes"] == {"analysis": {"from": 4, "to": None}}
    # 库里不再留 ai_quota_defaults 键（避免空对象累积）。
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM app_settings WHERE key = ?",
            (quota_config.DEFAULTS_KEY,),
        ).fetchone()[0]
    assert count == 0


def test_defaults_write_invalidates_cache_immediately(migrated):
    # 先读一次：把 env 值塞进 5s 缓存。
    assert quota_config.default_limit("analysis") == (int(getattr(config, ANALYSIS_ATTR)), "config")

    response = migrated.put(
        "/api/admin/quotas/defaults", json={"limits": {"analysis": 3}}
    )
    assert response.status_code == 200, response.text
    # 管理员写入后立即生效，不用等缓存过期。
    assert quota_config.default_limit("analysis") == (3, "default")


def test_defaults_cache_expires_after_five_seconds(migrated, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(quota_config, "_clock", lambda: now[0])
    env_value = int(getattr(config, ANALYSIS_ATTR))

    assert quota_config.default_limit("analysis") == (env_value, "config")  # 缓存

    # 模拟另一个进程直接改库（不经过本进程的 invalidate）。
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, "
            "updated_at = excluded.updated_at",
            (quota_config.DEFAULTS_KEY, json.dumps({"analysis": 11}), 123),
        )
    assert quota_config.default_limit("analysis") == (
        env_value,
        "config",
    ), "5 秒内应继续用进程内缓存"

    now[0] += quota_config.CACHE_SECONDS + 0.1
    assert quota_config.default_limit("analysis") == (11, "default")


# ---------------------------------------------------------------------------
# 3. 单用户覆盖：优先级 / 清除 / 0 / 隔离 / 审计
# ---------------------------------------------------------------------------

def test_get_user_quotas_shows_defaults_used_today_and_remaining(migrated, other_client):
    user_id = other_client.user_id
    _seed_used(user_id, "analysis", used=2)
    response = migrated.get(f"/api/admin/quotas/users/{user_id}")
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["user"]["id"] == user_id
    assert body["user"]["email"] == OTHER_EMAIL
    assert "password_hash" not in body["user"]
    features = {item["feature"]: item for item in body["features"]}
    assert len(features) == 8
    analysis = features["analysis"]
    default_limit = int(getattr(config, ANALYSIS_ATTR))
    assert analysis["defaultLimit"] == default_limit
    assert analysis["overrideLimit"] is None
    assert analysis["effectiveLimit"] == default_limit
    assert analysis["usedToday"] == 2
    assert analysis["remaining"] == default_limit - 2
    assert analysis["source"] == "config"


def test_user_override_precedence_clear_and_isolation(migrated, other_client):
    user_id = other_client.user_id
    admin_id = migrated.user_id
    default_limit = int(getattr(config, ANALYSIS_ATTR))
    assert quota_config.effective_limit("analysis", user_id) == (
        default_limit,
        "config",
        default_limit,
        None,
    )

    response = migrated.put(
        f"/api/admin/quotas/users/{user_id}",
        json={"overrides": {"analysis": 2}, "reason": "客服调整：大客户测试"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    features = {item["feature"]: item for item in body["features"]}
    assert features["analysis"] == {
        "feature": "analysis",
        "defaultLimit": default_limit,
        "overrideLimit": 2,
        "effectiveLimit": 2,
        "usedToday": 0,
        "remaining": 2,
        "source": "user_override",
    }
    assert body["changes"] == {"analysis": {"from": None, "to": 2}}

    # 运行时读同一个覆盖；管理员写后立即生效（不靠 5s 缓存过期）。
    assert quota_config.effective_limit("analysis", user_id) == (2, "user_override", default_limit, 2)
    assert quota.limit_for("analysis", user_id) == 2
    assert quota.limit_for("analysis") == default_limit

    # 其他用户不受影响（隔离）。
    other = migrated.get(f"/api/admin/quotas/users/{migrated.user_id}")
    other_features = {item["feature"]: item for item in other.json()["features"]}
    assert other_features["analysis"]["overrideLimit"] is None
    assert other_features["analysis"]["effectiveLimit"] == default_limit
    assert other_features["analysis"]["source"] == "config"

    # 审计：操作者、目标、前后值、reason。
    rows = _audit_rows("admin.quota.user_override_update")
    detail = _find_change(rows, "analysis")
    assert detail["changes"]["analysis"] == {"from": None, "to": 2}
    assert detail["reason"] == "客服调整：大客户测试"
    assert rows[0]["actor_id"] == admin_id
    assert rows[0]["target_type"] == "user"
    assert rows[0]["target_id"] == user_id

    # 清除（null）→ 回继承默认。
    cleared = migrated.put(
        f"/api/admin/quotas/users/{user_id}",
        json={"overrides": {"analysis": None}, "reason": "恢复默认"},
    )
    assert cleared.status_code == 200, cleared.text
    features = {item["feature"]: item for item in cleared.json()["features"]}
    assert features["analysis"]["overrideLimit"] is None
    assert features["analysis"]["effectiveLimit"] == default_limit
    assert features["analysis"]["source"] == "config"
    assert cleared.json()["changes"] == {"analysis": {"from": 2, "to": None}}
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM quota_overrides WHERE user_id = ?",
            (user_id,),
        ).fetchone()[0] == 0


def test_user_override_zero_closes_feature(migrated, other_client):
    user_id = other_client.user_id
    response = migrated.put(
        f"/api/admin/quotas/users/{user_id}",
        json={"overrides": {"analysis": 0}, "reason": "临时关闭该功能"},
    )
    assert response.status_code == 200, response.text
    features = {item["feature"]: item for item in response.json()["features"]}
    assert features["analysis"]["overrideLimit"] == 0
    assert features["analysis"]["effectiveLimit"] == 0
    assert features["analysis"]["remaining"] == 0
    assert features["analysis"]["source"] == "user_override"


def test_runtime_consumes_by_effective_limit(migrated):
    """运行时：覆盖 1 → 第二次 429（limit=1）；覆盖 0 → 直接 429（limit=0）。"""
    guest = "guest:quota-runtime"
    quota_config.apply_overrides(
        guest, {"analysis": 1}, reason="测试", created_by="admin-test"
    )
    assert quota.limit_for("analysis", guest) == 1

    first = quota.check_and_consume_quota(guest, "analysis")
    assert first["used_units"] == 1
    assert first["limit_units"] == 1
    assert first["limit_source"] == "user_override"
    assert first["default_limit"] == int(getattr(config, ANALYSIS_ATTR))
    assert first["override_limit"] == 1

    with pytest.raises(QuotaExceeded) as excinfo:
        quota.check_and_consume_quota(guest, "analysis")
    assert excinfo.value.limit_units == 1
    assert excinfo.value.used_units == 1
    assert excinfo.value.payload()["limit"] == 1

    snap = quota.snapshot(guest, "analysis")
    assert snap["limit_source"] == "user_override"
    assert snap["override_limit"] == 1
    assert snap["limit_units"] == 1
    assert snap["used_units"] == 1

    # 0 = 关闭：即使一次都没用过也要拒绝，且报错里 limit=0 / used=0。
    quota_config.apply_overrides(
        "guest:quota-zero", {"analysis": 0}, reason="测试关闭", created_by="admin-test"
    )
    assert quota.limit_for("analysis", "guest:quota-zero") == 0
    with pytest.raises(QuotaExceeded) as excinfo:
        quota.check_and_consume_quota("guest:quota-zero", "analysis")
    assert excinfo.value.limit_units == 0
    assert excinfo.value.used_units == 0
    payload = excinfo.value.payload()
    assert (payload["used"], payload["limit"]) == (0, 0)


def test_user_update_is_atomic_on_validation_error(migrated, other_client):
    user_id = other_client.user_id
    response = migrated.put(
        f"/api/admin/quotas/users/{user_id}",
        json={"overrides": {"analysis": 2, "quiz": -1}, "reason": "混入非法值"},
    )
    assert response.status_code == 400, response.text
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM quota_overrides WHERE user_id = ?", (user_id,)
        ).fetchone()[0]
    assert count == 0, "同一请求里有一个非法值就整体拒绝，不能写一半"


# ---------------------------------------------------------------------------
# 4. 校验（400）/ 404 / 503 / 权限
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "limits",
    [
        {},
        {"nope": 1},
        {"books": 1},  # KNOWN_FEATURES 里但没有用户日额度
        {"analysis": -1},
        {"analysis": quota_config.MAX_LIMIT + 1},
        {"analysis": "many"},
        {"analysis": 1.5},
        {"analysis": True},
    ],
)
def test_put_defaults_validation_returns_400(migrated, limits):
    response = migrated.put("/api/admin/quotas/defaults", json={"limits": limits})
    assert response.status_code == 400, (limits, response.text)


def test_put_user_requires_reason_and_valid_changes(migrated, other_client):
    user_id = other_client.user_id
    url = f"/api/admin/quotas/users/{user_id}"

    assert migrated.put(url, json={"overrides": {"analysis": 1}}).status_code == 400
    assert migrated.put(
        url, json={"overrides": {}, "reason": "空改动"}
    ).status_code == 400
    assert migrated.put(
        url, json={"overrides": {"nope": 1}, "reason": "未知功能"}
    ).status_code == 400
    assert migrated.put(
        url, json={"overrides": {"analysis": 1}, "reason": "x" * 201}
    ).status_code == 400


def test_quota_endpoints_require_admin(migrated, other_client, make_client):
    with make_client() as anonymous:
        assert anonymous.get("/api/admin/quotas").status_code == 401
        assert anonymous.put(
            "/api/admin/quotas/defaults", json={"limits": {"analysis": 1}}
        ).status_code == 401

    for path in (
        "/api/admin/quotas",
        f"/api/admin/quotas/users/{other_client.user_id}",
    ):
        response = other_client.get(path)
        assert response.status_code == 403, path
        assert "管理员" in response.json()["detail"]

    assert other_client.put(
        "/api/admin/quotas/defaults", json={"limits": {"analysis": 1}}
    ).status_code == 403
    assert other_client.put(
        f"/api/admin/quotas/users/{other_client.user_id}",
        json={"overrides": {"analysis": 1}, "reason": "越权"},
    ).status_code == 403


def test_unknown_user_returns_404(migrated):
    assert migrated.get("/api/admin/quotas/users/ghost-user").status_code == 404
    response = migrated.put(
        "/api/admin/quotas/users/ghost-user",
        json={"overrides": {"analysis": 1}, "reason": "不存在"},
    )
    assert response.status_code == 404


def test_unmigrated_db_returns_503_but_panel_still_works(client, monkeypatch):
    """未跑迁移：面板按 env 展示（200），改默认/用户覆盖明确 503。"""
    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({TEST_USER_EMAIL}), raising=False
    )
    user_id = client.user_id

    panel = client.get("/api/admin/quotas")
    assert panel.status_code == 200, panel.text
    assert all(item["source"] == "config" for item in panel.json()["features"])

    response = client.put(
        "/api/admin/quotas/defaults", json={"limits": {"analysis": 1}}
    )
    assert response.status_code == 503
    assert "alembic upgrade head" in response.json()["detail"]

    response = client.get(f"/api/admin/quotas/users/{user_id}")
    assert response.status_code == 503
    assert "0031" in response.json()["detail"]

    response = client.put(
        f"/api/admin/quotas/users/{user_id}",
        json={"overrides": {"analysis": 1}, "reason": "未迁移"},
    )
    assert response.status_code == 503


# ---------------------------------------------------------------------------
# 5. 端到端：改默认/覆盖后，新请求按新值 429/通过
# ---------------------------------------------------------------------------

def test_define_uses_admin_default_and_user_override(migrated, monkeypatch):
    monkeypatch.setattr(config, "AI_DAILY_BUDGET_USER_USD", 0, raising=False)
    monkeypatch.setattr(config, "AI_DAILY_BUDGET_GLOBAL_USD", 0, raising=False)
    monkeypatch.setattr(llm, "generate_json", lambda prompt, model=None: json.dumps(
        DICT_PAYLOAD, ensure_ascii=False
    ))

    # 全局默认改成 1 → 第二次请求 429，limit 报 1。
    assert migrated.put(
        "/api/admin/quotas/defaults", json={"limits": {"define": 1}}
    ).status_code == 200
    first = migrated.post("/api/define", json={"word": "quotaalpha"})
    assert first.status_code == 200, first.text
    second = migrated.post("/api/define", json={"word": "quotabeta"})
    assert second.status_code == 429, second.text
    assert second.json()["code"] == "quota_exceeded"
    assert second.json()["limit"] == 1

    # 单用户覆盖优先：关闭 define 后，即使默认值改大也 429。
    assert migrated.put(
        "/api/admin/quotas/defaults", json={"limits": {"define": 50}}
    ).status_code == 200
    override = migrated.put(
        f"/api/admin/quotas/users/{migrated.user_id}",
        json={"overrides": {"define": 0}, "reason": "测试关闭"},
    )
    assert override.status_code == 200, override.text
    blocked = migrated.post("/api/define", json={"word": "quotagamma"})
    assert blocked.status_code == 429, blocked.text
    assert blocked.json()["limit"] == 0

    # 清除覆盖 → 回继承默认，继续可用。
    cleared = migrated.put(
        f"/api/admin/quotas/users/{migrated.user_id}",
        json={"overrides": {"define": None}, "reason": "恢复"},
    )
    assert cleared.status_code == 200, cleared.text
    allowed = migrated.post("/api/define", json={"word": "quotadelta"})
    assert allowed.status_code == 200, allowed.text


# ---------------------------------------------------------------------------
# 6. 单位换算（P2-34）：1 单位 = 内容量，不再按「批」
# ---------------------------------------------------------------------------

def test_units_for_blocks_conversion():
    # translate / local_show：1 单位 = 100 blocks
    assert quota.units_for_blocks("translate", 20) == 1
    assert quota.units_for_blocks("translate", 100) == 1
    assert quota.units_for_blocks("translate", 101) == 2
    assert quota.units_for_blocks("translate", 1372) == 14  # 1,372-block 视频
    assert quota.units_for_blocks("local_show", 100) == 1
    assert quota.units_for_blocks("local_show", 101) == 2
    # reading：1 单位 = 10 段
    assert quota.units_for_blocks("reading", 10) == 1
    assert quota.units_for_blocks("reading", 11) == 2
    assert quota.units_for_blocks("reading", 20) == 2
    # 其他功能：1 次 = 1 单位，与内容量无关
    for feature in ("summary", "define", "quiz", "analysis", "course_generation"):
        assert quota.units_for_blocks(feature, 0) == 1
        assert quota.units_for_blocks(feature, 500) == 1
    # 常量与换算口径同源，便于管理台/文档引用
    assert quota.BLOCKS_PER_UNIT == 100
    assert quota.PARAGRAPHS_PER_UNIT == 10


def test_units_for_blocks_boundaries_never_zero():
    """空/负数/非法值按 1 兜底：0 块不能变成 0 单位绕过配额硬闸。"""
    for n in (0, -5, None, "bad", 0.4):
        assert quota.units_for_blocks("translate", n) == 1
        assert quota.units_for_blocks("reading", n) == 1


def test_multi_unit_consume_and_429_reports_units(migrated):
    """一次扣多个单位：used/limit/units 都要进 429 文案与结果。"""
    guest = "guest:quota-units"
    quota_config.apply_overrides(
        guest, {"reading": 3}, reason="测试单位", created_by="admin-test"
    )
    units = quota.units_for_blocks("reading", 11)
    assert units == 2

    first = quota.check_and_consume_quota(guest, "reading", units)
    assert first["used_units"] == 2
    assert first["units"] == 2
    assert first["limit_units"] == 3

    with pytest.raises(QuotaExceeded) as excinfo:
        quota.check_and_consume_quota(guest, "reading", units)
    assert excinfo.value.units == 2
    assert excinfo.value.used_units == 2
    assert excinfo.value.limit_units == 3
    assert "本次需 2" in str(excinfo.value)


def test_zero_limit_still_closes_multi_unit_feature(migrated):
    """0 = 关闭：即使一次要扣多个单位，也直接 429（limit=0）。"""
    guest = "guest:quota-units-off"
    quota_config.apply_overrides(
        guest, {"translate": 0}, reason="测试关闭", created_by="admin-test"
    )
    with pytest.raises(QuotaExceeded) as excinfo:
        quota.check_and_consume_quota(
            guest, "translate", quota.units_for_blocks("translate", 101)
        )
    assert excinfo.value.limit_units == 0
    assert excinfo.value.used_units == 0
    assert quota.snapshot(guest, "translate")["remaining"] == 0


def test_units_per_batch_uses_cumulative_content():
    """多批按累计内容量分配单位，避免每小批各自向上取整。"""
    # 10 段 → 5+5 两批也只要 1 单位；11 段 = 2 单位；20 段 = 2 单位。
    assert quota.units_per_batch("reading", [5, 5]) == [1, 0]
    assert quota.units_per_batch("reading", [5, 6]) == [1, 1]
    assert quota.units_per_batch("reading", [5, 15]) == [1, 1]
    # 1,372 blocks 的首批 10 + 稳定 40 → 合计 14 单位（不是每批各 1）。
    sizes = [10] + [40] * 34 + [2]
    assert sum(sizes) == 1372
    units = quota.units_per_batch("translate", sizes)
    assert len(units) == len(sizes)
    assert all(unit >= 0 for unit in units)
    assert sum(units) == 14
    # 空批/非法值不产生负单位；其他功能每批仍 1 次 = 1 单位。
    assert quota.units_per_batch("translate", []) == []
    assert quota.units_per_batch("translate", [0, -3]) == [0, 0]
    assert quota.units_per_batch("analysis", [1, 1, 1]) == [1, 1, 1]


def test_ensure_quota_available_checks_without_consuming(migrated):
    """落在已购单位内的批：只查闸门，不写 ai_quota；额度用光/关闭仍 429。"""
    guest = "guest:quota-check-only"
    quota_config.apply_overrides(
        guest, {"reading": 1}, reason="测试只读闸门", created_by="admin-test"
    )
    result = quota.ensure_quota_available(guest, "reading")
    assert result["allowed"] is True
    assert result["units"] == 0
    assert result["remaining"] == 1
    assert quota.snapshot(guest, "reading")["used_units"] == 0, "只读不能扣减"

    quota.check_and_consume_quota(guest, "reading", 1)
    with pytest.raises(QuotaExceeded) as excinfo:
        quota.ensure_quota_available(guest, "reading")
    assert excinfo.value.units == 0
    assert excinfo.value.limit_units == 1
    assert excinfo.value.used_units == 1
    assert quota.snapshot(guest, "reading")["used_units"] == 1

    # 0 = 关闭：只读闸门也必须在调用模型前拦住。
    quota_config.apply_overrides(
        guest, {"reading": 0}, reason="测试关闭", created_by="admin-test"
    )
    with pytest.raises(QuotaExceeded) as excinfo:
        quota.ensure_quota_available(guest, "reading")
    assert excinfo.value.limit_units == 0
