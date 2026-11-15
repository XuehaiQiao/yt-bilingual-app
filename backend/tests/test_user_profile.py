"""用户名 / 用户页 / 余额 / 后台手动设置（V1 用户需求 1–3 / specs/023）。

覆盖：

1. 注册：username 合法/缺失回落/非法（长度、字符集、首尾空白、非字符串）；
2. 登录 / me：user 带 username / credits / status；被封禁账号登录 403；
3. 改用户名：成功 / 非法 / 缺字段 / 重名允许 / 游客 403；
4. 用户页摘要：余额、本月 AI 花费、今日分钟、版本、preliminary、无数据为 0；
5. 后台调余额：正负/不足/0/越界/原因校验/404/普通用户 403/事务流水/并发原子；
6. 封禁：旧会话下一次请求 403、登录 403、解封恢复；不能封自己/最后一个管理员；
7. 维护模式：非管理员 503、管理员不受影响、auth/health 白名单、5 秒缓存；
8. settings 读写；普通用户访问后台 403；旧库未迁移时 GET 默认值 / PUT 503；
9. 迁移 0013 的升级/回滚断言在 tests/test_migrations.py。

全部离线：数据库在 conftest 的 tmp_path 下用真实 Alembic CLI 迁移；不联网、
不碰仓库 data/。
"""
from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

import account
import auth_db
import config
from ai import ledger
from tests.conftest import TEST_USER_EMAIL
from tests.migration_utils import assert_alembic_ok, run_alembic

PASSWORD = "profile-password-123"
OTHER_EMAIL = "profile-other@example.com"
SECOND_ADMIN_EMAIL = "profile-admin2@example.com"
TZ = ZoneInfo("Asia/Shanghai")


# ---------------------------------------------------------------------------
# 夹具 / 工具
# ---------------------------------------------------------------------------

def _upgrade() -> None:
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"),
        "upgrade head (user profile)",
    )


@pytest.fixture()
def migrated(client):
    """默认登录用户 + 迁移到 head（表齐全）。"""
    _upgrade()
    return client


@pytest.fixture()
def admin_client(migrated, monkeypatch):
    """默认用户设为管理员（邮箱匹配 ADMIN_EMAILS）。"""
    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({TEST_USER_EMAIL}), raising=False
    )
    return migrated


@pytest.fixture()
def other_client(admin_client, make_client):
    """普通登录用户（非管理员）；每个用例独立 Cookie。"""
    with make_client() as client:
        response = client.post(
            "/api/auth/signup",
            json={
                "email": OTHER_EMAIL,
                "password": PASSWORD,
                "username": "其他用户",
            },
        )
        assert response.status_code == 201, response.text
        client.user_id = response.json()["user"]["id"]
        yield client


@pytest.fixture()
def unmigrated_admin_client(client, monkeypatch):
    """未跑 0013 迁移、但当前用户是管理员的客户端。"""
    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({TEST_USER_EMAIL}), raising=False
    )
    return client


def _signup(client, email: str, username=None, *, password: str = PASSWORD):
    body = {"email": email, "password": password}
    if username is not None:
        body["username"] = username
    return client.post("/api/auth/signup", json=body)


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _transaction_rows(user_id: str) -> list[dict]:
    with _db() as conn:
        return [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM credit_transactions WHERE user_id = ? "
                "ORDER BY created_at ASC",
                (user_id,),
            ).fetchall()
        ]


def _settings_rows() -> dict[str, str | None]:
    with _db() as conn:
        return {
            row["key"]: row["value"]
            for row in conn.execute("SELECT key, value FROM app_settings")
        }


def _today_noon_ms(days_ago: int = 0) -> int:
    moment = datetime.now(TZ) - timedelta(days=days_ago)
    return int(
        moment.replace(hour=12, minute=0, second=0, microsecond=0).timestamp()
        * 1000
    )


def _previous_month_noon_ms() -> int:
    first = datetime.now(TZ).replace(day=1, hour=12, minute=0, second=0, microsecond=0)
    return int((first - timedelta(days=1)).timestamp() * 1000)


def _insert_watch_event(
    user_id: str,
    *,
    seconds: int,
    occurred_at: int,
    event_id: str,
) -> None:
    with _db() as conn:
        conn.execute(
            "INSERT INTO watch_events "
            "(user_id, guest_hash, content_ref, kind, target_lang, "
            "watched_seconds, position_seconds, occurred_at, client_event_id) "
            "VALUES (?, NULL, 'v-profile', 'video', 'zh-CN', ?, 0, ?, ?)",
            (user_id, seconds, occurred_at, event_id),
        )
        conn.commit()


# ---------------------------------------------------------------------------
# 注册 / 登录 / me
# ---------------------------------------------------------------------------

def test_signup_accepts_username_and_returns_profile_fields(make_client):
    with make_client() as client:
        response = _signup(client, "new-user@example.com", "小明-AI_1")
        assert response.status_code == 201, response.text
        user = response.json()["user"]
        assert user["username"] == "小明-AI_1"
        assert user["credits"] == 0
        assert user["status"] == "active"

        me = client.get("/api/auth/me")
        assert me.status_code == 200
        assert me.json()["user"] == user
        assert me.json()["isAdmin"] is False

        # 2 字符下界、中文 / 英文 / 数字 / 下划线 / 连字符都合法。
        for index, name in enumerate(("中A", "a-b", "a_b", "abc123", "测试名字")):
            response = _signup(client, f"ok-{index}@example.com", name)
            assert response.status_code == 201, (name, response.text)
            assert response.json()["user"]["username"] == name


def test_signup_without_username_falls_back_to_email_prefix(make_client):
    """旧客户端（完全不传字段）回落 email 前缀；不做长度/字符集校验。"""
    with make_client() as client:
        response = _signup(client, "legacy.user@example.com")
        assert response.status_code == 201, response.text
        assert response.json()["user"]["username"] == "legacy.user"

        short = _signup(client, "a@example.com")
        assert short.status_code == 201
        assert short.json()["user"]["username"] == "a"


@pytest.mark.parametrize(
    ("username", "expect"),
    [
        (None, 400),          # 显式 null：字段传了就必须合法
        ("", 400),
        ("a", 400),
        ("a" * 25, 400),
        ("  ab", 400),
        ("ab  ", 400),
        ("a b", 400),
        ("ab!", 400),
        ("ab@cd", 400),
        (123, 400),
        (["abcd"], 400),
        ({"name": "abcd"}, 400),
    ],
)
def test_signup_rejects_invalid_username(make_client, username, expect):
    with make_client() as client:
        response = client.post(
            "/api/auth/signup",
            json={
                "email": "bad-name@example.com",
                "password": PASSWORD,
                "username": username,
            },
        )
        assert response.status_code == expect, response.text
        assert response.json().get("detail")
        assert client.cookies.get("ln_session") is None
        # 失败的注册不能落用户（校验先于建库时文件可能还不存在）。
        import os

        if os.path.exists(config.AUTH_DB_PATH):
            with _db() as conn:
                assert conn.execute(
                    "SELECT COUNT(*) FROM users WHERE email='bad-name@example.com'"
                ).fetchone()[0] == 0


def test_login_returns_profile_fields(migrated, monkeypatch):
    user_id = migrated.user_id
    with _db() as conn:
        conn.execute("UPDATE users SET credits=42 WHERE id=?", (user_id,))
        conn.commit()
    migrated.post("/api/auth/logout")
    response = migrated.post(
        "/api/auth/login",
        json={"email": TEST_USER_EMAIL, "password": "test-password-123"},
    )
    assert response.status_code == 200, response.text
    user = response.json()["user"]
    assert user["credits"] == 42
    assert user["username"] == "test-user"
    assert user["status"] == "active"


# ---------------------------------------------------------------------------
# 改用户名
# ---------------------------------------------------------------------------

def test_patch_profile_updates_username(migrated):
    response = migrated.patch(
        "/api/user/profile", json={"username": "新名字-42"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["user"]["username"] == "新名字-42"
    assert migrated.get("/api/auth/me").json()["user"]["username"] == "新名字-42"

    # 用户不存在字段 / null / 非法字符 → 400，旧值不变。
    for body in (
        {},
        {"username": None},
        {"username": "x"},
        {"username": "a b"},
        {"username": 123},
    ):
        response = migrated.patch("/api/user/profile", json=body)
        assert response.status_code == 400, (body, response.text)
    assert migrated.get("/api/auth/me").json()["user"]["username"] == "新名字-42"


def test_patch_profile_allows_duplicate_display_names(migrated, make_client):
    assert migrated.patch(
        "/api/user/profile", json={"username": "同名"}
    ).status_code == 200
    with make_client() as second:
        response = _signup(second, "second-duplicate@example.com", "同名")
        assert response.status_code == 201, response.text
        assert response.json()["user"]["username"] == "同名"


def test_profile_endpoints_require_login(make_client):
    with make_client() as anonymous:
        # 首次访问是游客（中间件下发 ln_guest），用户资料统一 403。
        assert anonymous.get("/api/auth/me").json()["guest"] is True
        assert anonymous.patch(
            "/api/user/profile", json={"username": "游客名"}
        ).status_code == 403
        assert anonymous.get("/api/user/summary").status_code == 403


# ---------------------------------------------------------------------------
# 用户页摘要
# ---------------------------------------------------------------------------

def test_summary_has_zero_values_when_no_data(migrated):
    response = migrated.get("/api/user/summary")
    assert response.status_code == 200, response.text
    body = response.json()
    row = auth_db.get_user_by_id(migrated.user_id)
    assert body["user"] == {
        "id": row["id"],
        "email": row["email"],
        "username": row["username"],
        "credits": 0,
        "memberSince": row["created_at"] * 1000,
        "status": "active",
    }
    assert body["monthSpendUsd"] == 0
    assert body["usageToday"] == {"minutes": 0}
    assert body["version"] == config.APP_VERSION
    assert body["preliminary"] is False


def test_summary_aggregates_month_spend_and_today_minutes(migrated, monkeypatch):
    monkeypatch.setattr(config, "AI_QUOTA_TIMEZONE", "Asia/Shanghai", raising=False)
    this_month = _today_noon_ms()
    prev_month = _previous_month_noon_ms()
    row1 = ledger.record_usage(
        migrated.user_id,
        "translate",
        "gemini-2.5-flash",
        1_000_000,
        0,
        occurred_at=this_month,
    )
    row2 = ledger.record_usage(
        migrated.user_id,
        "define",
        "gemini-2.5-flash",
        0,
        1_000_000,
        occurred_at=this_month,
    )
    ledger.record_usage(
        migrated.user_id,
        "summary",
        "gemini-2.5-flash",
        1_000_000,
        0,
        occurred_at=prev_month,
    )
    assert row1 and row2
    _insert_watch_event(
        migrated.user_id,
        seconds=90,
        occurred_at=_today_noon_ms(),
        event_id="profile-today",
    )
    _insert_watch_event(
        migrated.user_id,
        seconds=600,
        occurred_at=_today_noon_ms(1),
        event_id="profile-yesterday",
    )
    with _db() as conn:
        conn.execute(
            "UPDATE users SET credits=123 WHERE id=?", (migrated.user_id,)
        )
        conn.commit()

    body = migrated.get("/api/user/summary").json()
    expected = row1["est_cost_usd"] + row2["est_cost_usd"]
    assert body["monthSpendUsd"] == pytest.approx(expected, abs=1e-9)
    assert body["monthSpendUsd"] > 0
    assert body["usageToday"] == {"minutes": 1.5}  # 90s 今天 + 昨天 600s 不计
    assert body["user"]["credits"] == 123
    assert body["preliminary"] is False


def test_summary_degrades_without_migrations(client):
    """旧库没有 ai_usage/watch_events：数字为 0，preliminary=true。"""
    body = client.get("/api/user/summary").json()
    assert body["monthSpendUsd"] == 0
    assert body["usageToday"] == {"minutes": 0}
    assert body["preliminary"] is True


# ---------------------------------------------------------------------------
# 后台：调余额
# ---------------------------------------------------------------------------

def test_admin_adjust_credits_and_transactions(admin_client, other_client):
    target = other_client.user_id
    response = admin_client.post(
        f"/api/admin/users/{target}/credits",
        json={"delta": 100, "reason": "  新用户补贴  "},
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"credits": 100}

    second = admin_client.post(
        f"/api/admin/users/{target}/credits",
        json={"delta": -30, "reason": "扣减测试"},
    )
    assert second.status_code == 200
    assert second.json() == {"credits": 70}

    rows = _transaction_rows(target)
    assert len(rows) == 2
    assert rows[0]["delta"] == 100
    assert rows[0]["reason"] == "新用户补贴"
    assert rows[0]["admin_id"] == admin_client.user_id
    assert rows[0]["created_at"] > 0
    assert rows[1]["delta"] == -30
    assert rows[1]["reason"] == "扣减测试"

    # 余额不足：拒绝且余额/流水不变。
    insufficient = admin_client.post(
        f"/api/admin/users/{target}/credits",
        json={"delta": -1000, "reason": "扣爆"},
    )
    assert insufficient.status_code == 400
    assert "余额不足" in insufficient.json()["detail"]
    assert other_client.get("/api/user/summary").json()["user"]["credits"] == 70
    assert len(_transaction_rows(target)) == 2

    # 参数校验：0 / 越界 / 原因空或超长 → 400；缺失字段 → 422。
    bad_bodies = [
        {"delta": 0, "reason": "零"},
        {"delta": 100_001, "reason": "越界"},
        {"delta": -100_001, "reason": "越界"},
        {"delta": 1, "reason": ""},
        {"delta": 1, "reason": "   "},
        {"delta": 1, "reason": "x" * 201},
    ]
    for body in bad_bodies:
        assert (
            admin_client.post(
                f"/api/admin/users/{target}/credits", json=body
            ).status_code
            == 400
        ), body
    assert len(_transaction_rows(target)) == 2

    assert (
        admin_client.post(
            "/api/admin/users/not-a-user/credits",
            json={"delta": 10, "reason": "x"},
        ).status_code
        == 404
    )
    # 普通用户 / 未登录不能调账。
    assert (
        other_client.post(
            f"/api/admin/users/{target}/credits",
            json={"delta": 10, "reason": "x"},
        ).status_code
        == 403
    )


def test_admin_credit_adjustment_is_atomic(admin_client, other_client):
    target = other_client.user_id
    errors: list[BaseException] = []

    def worker() -> None:
        try:
            account.adjust_credits(target, 10, "并发发放", admin_client.user_id)
        except BaseException as exc:  # noqa: BLE001 - 线程里收集断言失败
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert not errors, errors
    assert auth_db.get_user_by_id(target)["credits"] == 80
    assert len(_transaction_rows(target)) == 8


# ---------------------------------------------------------------------------
# 后台：封禁 / 解封
# ---------------------------------------------------------------------------

def test_ban_blocks_login_and_existing_session(admin_client, other_client, make_client):
    target = other_client.user_id
    assert other_client.get("/api/user/summary").status_code == 200

    response = admin_client.patch(
        f"/api/admin/users/{target}", json={"status": "banned"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["user"]["status"] == "banned"

    # 旧会话下一次 /api 请求 403；健康探针不受影响。
    blocked = other_client.get("/api/user/summary")
    assert blocked.status_code == 403
    assert blocked.json()["detail"] == "账号已被停用"
    assert other_client.get("/api/auth/me").status_code == 403
    assert other_client.get("/health").status_code == 200

    # 用没有旧会话的新客户端验证登录端点本身的 403（不带 Cookie 才能走到路由）。
    with make_client() as fresh:
        login = fresh.post(
            "/api/auth/login", json={"email": OTHER_EMAIL, "password": PASSWORD}
        )
    assert login.status_code == 403
    assert login.json()["detail"] == "账号已被停用"

    # 解封后原 Cookie 恢复（不删会话）。
    unban = admin_client.patch(
        f"/api/admin/users/{target}", json={"status": "active"}
    )
    assert unban.status_code == 200
    assert other_client.get("/api/user/summary").status_code == 200


def test_admin_cannot_ban_self_or_last_admin(admin_client, other_client, monkeypatch):
    self_ban = admin_client.patch(
        f"/api/admin/users/{admin_client.user_id}", json={"status": "banned"}
    )
    assert self_ban.status_code == 400
    assert "自己" in self_ban.json()["detail"]

    # isAdmin 不实现：显式传入 400；body 缺 status 400。
    assert admin_client.patch(
        f"/api/admin/users/{other_client.user_id}", json={"isAdmin": True}
    ).status_code == 400
    assert admin_client.patch(
        f"/api/admin/users/{other_client.user_id}", json={}
    ).status_code == 400
    assert admin_client.patch(
        f"/api/admin/users/{other_client.user_id}", json={"status": "deleted"}
    ).status_code == 400

    # 两个管理员时封禁其中一个允许；只剩一个时服务层拒绝「最后一个管理员」。
    monkeypatch.setattr(
        config,
        "ADMIN_EMAILS",
        frozenset({TEST_USER_EMAIL, OTHER_EMAIL}),
        raising=False,
    )
    assert admin_client.patch(
        f"/api/admin/users/{other_client.user_id}", json={"status": "banned"}
    ).status_code == 200

    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({TEST_USER_EMAIL}), raising=False
    )
    with pytest.raises(account.LastAdmin):
        account.set_user_status(
            admin_client.user_id, "banned", actor_id="another-admin-id"
        )


def test_ban_unknown_user_is_404(admin_client):
    response = admin_client.patch(
        "/api/admin/users/missing-user", json={"status": "banned"}
    )
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# 后台：用户列表 / 权限
# ---------------------------------------------------------------------------

def test_admin_users_include_profile_fields(admin_client, other_client):
    users = admin_client.get("/api/admin/users?search=其他用户").json()
    assert users["total"] == 1
    row = users["users"][0]
    assert row["id"] == other_client.user_id[:8]
    assert row["userId"] == other_client.user_id
    assert row["username"] == "其他用户"
    assert row["credits"] == 0
    assert row["status"] == "active"
    # 既有字段保留。
    for field in (
        "email", "createdAt", "monthCostUsd", "eventCount", "lastActiveAt",
    ):
        assert field in row

    # 邮箱搜索仍可用（大小写不敏感）。
    by_email = admin_client.get("/api/admin/users?search=PROFILE-OTHER").json()
    assert by_email["total"] == 1

    assert other_client.get("/api/admin/users").status_code == 403


def test_admin_write_endpoints_require_admin(migrated, other_client):
    assert other_client.get("/api/admin/settings").status_code == 403
    assert other_client.put(
        "/api/admin/settings", json={"maintenance_mode": True}
    ).status_code == 403
    assert (
        other_client.patch(
            f"/api/admin/users/{other_client.user_id}", json={"status": "banned"}
        ).status_code
        == 403
    )


# ---------------------------------------------------------------------------
# 后台：settings / 维护模式
# ---------------------------------------------------------------------------

def test_settings_read_write(admin_client):
    initial = admin_client.get("/api/admin/settings")
    assert initial.status_code == 200
    assert initial.json() == {"maintenance_mode": False, "announcement": None}

    on = admin_client.put(
        "/api/admin/settings", json={"maintenance_mode": True}
    )
    assert on.status_code == 200
    assert on.json() == {"maintenance_mode": True, "announcement": None}

    announced = admin_client.put(
        "/api/admin/settings", json={"announcement": "今晚 23:00 维护"}
    )
    assert announced.json() == {
        "maintenance_mode": True,
        "announcement": "今晚 23:00 维护",
    }

    cleared = admin_client.put("/api/admin/settings", json={"announcement": None})
    assert cleared.json() == {"maintenance_mode": True, "announcement": None}

    # 空 body 不改任何字段。
    assert admin_client.put("/api/admin/settings", json={}).json() == {
        "maintenance_mode": True,
        "announcement": None,
    }
    assert _settings_rows() == {"maintenance_mode": "1", "announcement": None}

    # 关闭维护并保留公告。
    off = admin_client.put(
        "/api/admin/settings",
        json={"maintenance_mode": False, "announcement": "公告保留"},
    )
    assert off.json() == {"maintenance_mode": False, "announcement": "公告保留"}


def test_maintenance_mode_blocks_non_admin_only(
    admin_client, other_client, make_client
):
    assert admin_client.put(
        "/api/admin/settings", json={"maintenance_mode": True}
    ).status_code == 200

    for path in ("/api/user/summary", "/api/estimate-cost"):
        blocked = other_client.get(path)
        assert blocked.status_code == 503, path
        assert blocked.json() == {"detail": "系统维护中，请稍后重试。"}

    # 白名单：认证与健康探针仍可用；管理员完全不受影响。
    assert other_client.get("/api/auth/me").status_code == 200
    assert other_client.get("/health").status_code == 200
    assert admin_client.get("/api/user/summary").status_code == 200
    assert admin_client.get("/api/admin/settings").status_code == 200

    # 游客同样 503（维护检查发生在路由的 403 之前）。
    with make_client() as guest:
        assert guest.get("/api/user/summary").status_code == 503

    # 关闭后恢复。
    admin_client.put("/api/admin/settings", json={"maintenance_mode": False})
    assert other_client.get("/api/user/summary").status_code == 200


def test_maintenance_mode_cache_is_per_process(admin_client, other_client, monkeypatch):
    monkeypatch.setattr(config, "AI_QUOTA_TIMEZONE", "Asia/Shanghai", raising=False)
    assert other_client.get("/api/user/summary").status_code == 200  # 填充缓存 false
    with _db() as conn:
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) "
            "VALUES ('maintenance_mode', '1', 1) "
            "ON CONFLICT(key) DO UPDATE SET value='1'"
        )
        conn.commit()
    # 5 秒缓存内仍按未维护处理。
    assert other_client.get("/api/user/summary").status_code == 200
    account.reset_settings_cache()
    assert other_client.get("/api/user/summary").status_code == 503


def test_unmigrated_admin_settings_and_credits_are_degraded(unmigrated_admin_client):
    # app_settings 不存在：GET 返回默认值，PUT 503。
    assert unmigrated_admin_client.get("/api/admin/settings").json() == {
        "maintenance_mode": False,
        "announcement": None,
    }
    response = unmigrated_admin_client.put(
        "/api/admin/settings", json={"maintenance_mode": True}
    )
    assert response.status_code == 503
    assert "alembic upgrade head" in response.json()["detail"]

    # credit_transactions 不存在：调账 503（不写半条余额）。
    credits = unmigrated_admin_client.post(
        f"/api/admin/users/{unmigrated_admin_client.user_id}/credits",
        json={"delta": 10, "reason": "x"},
    )
    assert credits.status_code == 503
    assert auth_db.get_user_by_id(unmigrated_admin_client.user_id)["credits"] == 0
