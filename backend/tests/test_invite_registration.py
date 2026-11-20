"""M1 G1 邀请制注册的离线验收（specs/032-invite-registration）。

覆盖：

- 迁移 0023：两张表 + 唯一/查询索引，旧库 upgrade/downgrade 可跑；
- 码生成格式、归一化、只存摘要、前缀；
- 关闭注册：缺码 403 `invite_required`；完全关闭 403 `registration_closed`；
- 有效码注册成功并把 used_count/redemption 写对；无效/过期/撤销/用尽统一
  `invite_invalid`，对外不区分原因；
- 邮箱冲突回滚且不消耗邀请码；并发 max_uses=1 不超发；重复兑换被拒；
- 管理员 API：未登录 401/普通用户 403、创建/列表/撤销、脱敏、参数边界；
- 注册限流沿用 auth 桶；审计日志不含明文码。

全部离线：Alembic 用子进程跑临时库，不联网、不碰真实 data/。
"""
from __future__ import annotations

import logging
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

import auth_db
import config
import invites
from tests.conftest import TEST_USER_EMAIL, TEST_USER_PASSWORD
from tests.migration_utils import (
    assert_alembic_ok,
    columns,
    index_names,
    run_alembic,
    table_names,
)

PASSWORD = "correct-horse-battery"
ADMIN_EMAIL = "invite-admin@example.com"
OTHER_EMAIL = "invite-other@example.com"


# ---------------------------------------------------------------------------
# 夹具 / helpers
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _migrated_invite_db():
    """每个用例把当前 tmp 库迁到 head（邀请码表由 Alembic 建）。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"),
        "upgrade head (invites)",
    )


def _db_path() -> str:
    return config.AUTH_DB_PATH


def _rows(sql: str, params: tuple = ()) -> list[dict]:
    conn = sqlite3.connect(_db_path())
    try:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def _exec(sql: str, params: tuple = ()) -> None:
    conn = sqlite3.connect(_db_path())
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def _signup(client, email: str, invite_code: str | None = None):
    body: dict[str, object] = {"email": email, "password": PASSWORD}
    if invite_code is not None:
        body["inviteCode"] = invite_code
    return client.post("/api/auth/signup", json=body)


@pytest.fixture()
def public_registration(monkeypatch):
    monkeypatch.setattr(config, "REGISTRATION_OPEN", True, raising=False)
    monkeypatch.setattr(config, "INVITE_SIGNUP_ENABLED", True, raising=False)


@pytest.fixture()
def invite_only(monkeypatch):
    monkeypatch.setattr(config, "REGISTRATION_OPEN", False, raising=False)
    monkeypatch.setattr(config, "INVITE_SIGNUP_ENABLED", True, raising=False)


@pytest.fixture()
def fully_closed(monkeypatch):
    monkeypatch.setattr(config, "REGISTRATION_OPEN", False, raising=False)
    monkeypatch.setattr(config, "INVITE_SIGNUP_ENABLED", False, raising=False)


@pytest.fixture()
def admin_client(make_client, monkeypatch):
    """管理员登录客户端；注册阶段显式用公开注册（不依赖 conftest 默认）。"""
    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({ADMIN_EMAIL}), raising=False
    )
    monkeypatch.setattr(config, "REGISTRATION_OPEN", True, raising=False)
    with make_client() as client:
        response = client.post(
            "/api/auth/signup",
            json={"email": ADMIN_EMAIL, "password": PASSWORD},
        )
        assert response.status_code == 201, response.text
        yield client


# ---------------------------------------------------------------------------
# 迁移
# ---------------------------------------------------------------------------

def test_migration_0023_tables_columns_and_indexes(tmp_path):
    db = tmp_path / "invite-migrate.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")

    tables = table_names(db)
    assert {"invite_codes", "invite_redemptions"} <= tables

    codes = columns(db, "invite_codes")
    assert list(codes) == [
        "id",
        "code_hash",
        "code_prefix",
        "label",
        "max_uses",
        "used_count",
        "expires_at_ms",
        "revoked_at_ms",
        "revoked_by",
        "created_by",
        "created_at_ms",
        "last_used_at_ms",
    ]
    assert codes["id"]["pk"] == 1
    assert codes["code_hash"]["notnull"] == 1
    assert codes["max_uses"]["notnull"] == 1
    assert str(codes["max_uses"]["default"]) == "1"
    assert codes["used_count"]["notnull"] == 1
    assert str(codes["used_count"]["default"]) == "0"
    assert codes["created_by"]["notnull"] == 1
    assert codes["expires_at_ms"]["notnull"] == 0
    assert codes["revoked_at_ms"]["notnull"] == 0

    redemptions = columns(db, "invite_redemptions")
    assert list(redemptions) == [
        "id",
        "invite_id",
        "user_id",
        "redeemed_at_ms",
    ]
    assert redemptions["id"]["pk"] == 1
    assert redemptions["invite_id"]["notnull"] == 1
    assert redemptions["user_id"]["notnull"] == 1

    code_indexes = index_names(db, "invite_codes")
    assert "ux_invite_codes_code_hash" in code_indexes
    assert "ix_invite_codes_created" in code_indexes
    assert "ix_invite_codes_expires" in code_indexes
    redemption_indexes = index_names(db, "invite_redemptions")
    assert "ux_invite_redemptions_user" in redemption_indexes
    assert "ix_invite_redemptions_invite" in redemption_indexes
    assert "ix_invite_redemptions_user" in redemption_indexes

    # 唯一索引确实唯一
    with sqlite3.connect(db) as conn:
        unique = {
            row[1]: row[2]
            for row in conn.execute("PRAGMA index_list(invite_codes)")
        }
        assert unique["ux_invite_codes_code_hash"] == 1
        unique = {
            row[1]: row[2]
            for row in conn.execute("PRAGMA index_list(invite_redemptions)")
        }
        assert unique["ux_invite_redemptions_user"] == 1


def test_migration_0023_preserves_users_and_downgrades_cleanly(tmp_path):
    db = tmp_path / "invite-legacy.db"
    # 先到 0022，写入一个用户，再升级到 0023：旧库兼容、数据不丢。
    assert_alembic_ok(
        run_alembic(db, "upgrade", "0022_generated_courses"), "upgrade 0022"
    )
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO users (id, email, password_hash, created_at, username, "
            "credits, status) VALUES ('legacy-user', 'legacy@example.com', 'x', 1, "
            "'legacy', 0, 'active')"
        )
        conn.commit()
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head（含 0023）")
    assert {"invite_codes", "invite_redemptions"} <= table_names(db)
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT email FROM users").fetchone()[0] == "legacy@example.com"

    assert_alembic_ok(
        run_alembic(db, "downgrade", "0022_generated_courses"), "downgrade 0022"
    )
    remaining = table_names(db)
    assert "invite_codes" not in remaining
    assert "invite_redemptions" not in remaining
    assert "users" in remaining
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT email FROM users").fetchone()[0] == "legacy@example.com"

    # 再升级可恢复（迁移可重复执行）
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade again")
    assert {"invite_codes", "invite_redemptions"} <= table_names(db)


# ---------------------------------------------------------------------------
# 码生成 / 存储
# ---------------------------------------------------------------------------

def test_generate_code_is_human_readable_and_random():
    codes = {invites.generate_code() for _ in range(20)}
    assert len(codes) == 20
    for code in codes:
        assert code.startswith("LN-")
        assert len(code) == len("LN-XXXX-XXXX-XXXX")
        core = code.replace("-", "")[2:]
        assert len(core) == 12
        assert set(core) <= set(invites.CODE_ALPHABET)
        assert not (set(core) & set("ILOU"))


def test_normalize_accepts_prefixless_lowercase_and_spaces():
    assert invites.normalize_code("ln-pewc-2gtc-fs89") == "LNPEWC2GTCFS89"
    assert invites.normalize_code("  pe wc 2gtc fs89 ") == "LNPEWC2GTCFS89"
    assert invites.normalize_code("LN-PEWC-2GTC-FS89") == "LNPEWC2GTCFS89"
    assert invites.normalize_code("") == ""
    with pytest.raises(invites.InviteError):
        invites.normalize_code("LN-PEWC-2GTC-FS8!")
    with pytest.raises(invites.InviteError):
        invites.normalize_code(123)


def test_database_stores_only_hash_and_prefix():
    codes = invites.create_invites("admin-1", label="仅存摘要")
    code = codes[0]["code"]
    rows = _rows("SELECT * FROM invite_codes")
    assert len(rows) == 1
    assert rows[0]["code_hash"] == invites.hash_code(invites.normalize_code(code))
    assert rows[0]["code_hash"] != code
    assert rows[0]["code_prefix"] == code.replace("-", "")[:6]
    assert rows[0]["used_count"] == 0
    # 明文只在服务函数返回值里，不存在于任何列
    for value in rows[0].values():
        assert code not in str(value)


# ---------------------------------------------------------------------------
# 注册闭环
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("registration_open", "invite_enabled", "expected"),
    [
        (False, True, {
            "registrationOpen": False,
            "inviteSignupEnabled": True,
            "inviteRequired": True,
            "registrationClosed": False,
        }),
        (True, True, {
            "registrationOpen": True,
            "inviteSignupEnabled": True,
            "inviteRequired": False,
            "registrationClosed": False,
        }),
        (False, False, {
            "registrationOpen": False,
            "inviteSignupEnabled": False,
            "inviteRequired": False,
            "registrationClosed": True,
        }),
    ],
)
def test_registration_config_endpoint(
    make_client, monkeypatch, registration_open, invite_enabled, expected
):
    monkeypatch.setattr(config, "REGISTRATION_OPEN", registration_open, raising=False)
    monkeypatch.setattr(config, "INVITE_SIGNUP_ENABLED", invite_enabled, raising=False)
    with make_client() as client:
        response = client.get("/api/auth/registration")
    assert response.status_code == 200
    assert response.json() == expected


def test_open_registration_rejects_invalid_supplied_code(
    make_client, public_registration
):
    with make_client() as client:
        response = _signup(client, "open-invalid@example.com", "LN-AAAA-BBBB-CCCC")
    assert response.status_code == 403
    assert response.json()["code"] == "invite_invalid"
    assert _rows(
        "SELECT id FROM users WHERE email = ?", ("open-invalid@example.com",)
    ) == []


def test_closed_registration_without_invite_is_403(make_client, invite_only):
    with make_client() as client:
        response = _signup(client, "no-code@example.com")
    assert response.status_code == 403
    body = response.json()
    assert body["code"] == "invite_required"
    assert body["detail"]
    assert _rows("SELECT id FROM users WHERE email = ?", ("no-code@example.com",)) == []


def test_fully_closed_registration_is_403_registration_closed(
    make_client, fully_closed
):
    code = invites.create_invites("admin-1")[0]["code"]
    with make_client() as client:
        response = _signup(client, "fully-closed@example.com", code)
    assert response.status_code == 403
    assert response.json()["code"] == "registration_closed"
    assert _rows("SELECT id FROM users WHERE email = ?", ("fully-closed@example.com",)) == []


def test_valid_invite_registers_and_consumes_code(make_client, invite_only):
    created = invites.create_invites("admin-1", label="first", max_uses=1)[0]
    with make_client() as client:
        response = _signup(client, "Invited@Example.COM", created["code"])
        assert response.status_code == 201, response.text
        user = response.json()["user"]
        assert user["email"] == "invited@example.com"
        assert set(user) == {"id", "email", "username", "credits", "status"}
        assert user["credits"] == 0
        assert user["status"] == "active"
        # 注册即登录
        me = client.get("/api/auth/me")
        assert me.status_code == 200
        assert me.json()["user"]["id"] == user["id"]

    rows = _rows("SELECT * FROM invite_codes WHERE id = ?", (created["id"],))
    assert rows[0]["used_count"] == 1
    assert rows[0]["last_used_at_ms"] is not None
    redemptions = _rows(
        "SELECT * FROM invite_redemptions WHERE invite_id = ?", (created["id"],)
    )
    assert len(redemptions) == 1
    assert redemptions[0]["user_id"] == user["id"]
    # 管理台状态：已用完
    listed = invites.list_invites(status="used")
    assert listed["total"] == 1
    assert listed["invites"][0]["id"] == created["id"]


@pytest.mark.parametrize(
    "case",
    ["not_found", "expired", "revoked", "exhausted"],
)
def test_unusable_invites_share_unified_error(make_client, invite_only, case):
    if case == "not_found":
        code = "LN-AAAA-BBBB-CCCC"
    elif case == "expired":
        created = invites.create_invites("admin-1")[0]
        code = created["code"]
        _exec(
            "UPDATE invite_codes SET expires_at_ms = 1 WHERE id = ?",
            (created["id"],),
        )
    elif case == "revoked":
        created = invites.create_invites("admin-1")[0]
        code = created["code"]
        invites.revoke_invite(created["id"], "admin-1")
    else:
        created = invites.create_invites("admin-1", max_uses=1)[0]
        code = created["code"]
        invites.register_with_invite(
            "first@example.com",
            auth_db.hash_password(PASSWORD),
            "first",
            code,
        )

    with make_client() as client:
        response = _signup(client, f"{case}@example.com", code)
    assert response.status_code == 403
    body = response.json()
    assert body["code"] == "invite_invalid"
    assert body["detail"] == "邀请码无效或不可用，请向邀请人确认。"
    # 不泄露具体原因
    for reason in ("expired", "revoked", "exhausted", "not_found"):
        assert reason not in body["detail"].lower()


def test_invalid_code_format_is_400(make_client, invite_only):
    with make_client() as client:
        response = client.post(
            "/api/auth/signup",
            json={
                "email": "bad-format@example.com",
                "password": PASSWORD,
                "inviteCode": 12345,
            },
        )
    assert response.status_code == 400
    assert response.json()["code"] == "invite_invalid"


def test_email_conflict_does_not_consume_invite(make_client, invite_only):
    # 先建一个已存在账号（公开注册路径不受影响，但这里直接走服务层）。
    auth_db.create_user("existing@example.com", PASSWORD)
    created = invites.create_invites("admin-1", max_uses=1)[0]

    with make_client() as client:
        response = _signup(client, "EXISTING@example.com", created["code"])
    assert response.status_code == 409
    assert response.json()["detail"] == "邮箱已注册。"

    row = _rows("SELECT used_count FROM invite_codes WHERE id = ?", (created["id"],))[0]
    assert row["used_count"] == 0
    assert _rows(
        "SELECT id FROM invite_redemptions WHERE invite_id = ?", (created["id"],)
    ) == []


def test_session_failure_rolls_back_invite_and_user():
    """事务内任何失败（这里用 trigger 模拟 session 插入失败）都不消耗邀请码。"""
    created = invites.create_invites("admin-1", max_uses=1)[0]
    _exec(
        "CREATE TRIGGER fail_session_insert BEFORE INSERT ON sessions "
        "BEGIN SELECT RAISE(ABORT, 'simulated session failure'); END"
    )
    with pytest.raises(sqlite3.DatabaseError):
        invites.register_with_invite(
            "session-fail@example.com",
            auth_db.hash_password(PASSWORD),
            "sessionfail",
            created["code"],
        )
    assert _rows(
        "SELECT id FROM users WHERE email = ?", ("session-fail@example.com",)
    ) == []
    assert _rows(
        "SELECT used_count FROM invite_codes WHERE id = ?", (created["id"],)
    )[0]["used_count"] == 0
    assert _rows(
        "SELECT id FROM invite_redemptions WHERE invite_id = ?", (created["id"],)
    ) == []


def test_concurrent_signup_does_not_oversell(invite_only):
    created = invites.create_invites("admin-1", max_uses=1, count=2)[0]
    code = created["code"]
    password_hash = auth_db.hash_password(PASSWORD)
    barrier = threading.Barrier(2)

    def attempt(index: int):
        barrier.wait()
        try:
            return ("ok", invites.register_with_invite(
                f"race-{index}@example.com", password_hash, f"race{index}", code
            )[0]["id"])
        except invites.InviteError as exc:
            return ("err", exc.reason)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, (1, 2)))

    assert sorted(kind for kind, _ in results) == ["err", "ok"]
    assert [value for kind, value in results if kind == "err"] == ["exhausted"]
    row = _rows("SELECT used_count FROM invite_codes WHERE id = ?", (created["id"],))[0]
    assert row["used_count"] == 1
    assert len(_rows("SELECT * FROM invite_redemptions WHERE invite_id = ?", (created["id"],))) == 1
    assert len(_rows("SELECT * FROM users WHERE email LIKE 'race-%'")) == 1


def test_duplicate_redemption_is_rejected_and_does_not_double_count():
    created = invites.create_invites("admin-1", max_uses=2)[0]
    user_id = "same-user"
    conn = auth_db.connect()
    try:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE")
        invites.redeem_invite(conn, created["code"], user_id)
        conn.execute(
            "INSERT INTO invite_redemptions (id, invite_id, user_id, redeemed_at_ms) "
            "VALUES ('red-1', ?, ?, 1)",
            (created["id"], user_id),
        )
        conn.execute("COMMIT")
    finally:
        conn.close()

    conn = auth_db.connect()
    try:
        conn.isolation_level = None
        conn.execute("BEGIN IMMEDIATE")
        with pytest.raises(invites.InviteError) as excinfo:
            invites.redeem_invite(conn, created["code"], user_id)
        assert excinfo.value.reason == "duplicate_redemption"
        conn.execute("ROLLBACK")
    finally:
        conn.close()

    row = _rows("SELECT used_count FROM invite_codes WHERE id = ?", (created["id"],))[0]
    assert row["used_count"] == 1


# ---------------------------------------------------------------------------
# 管理员 API
# ---------------------------------------------------------------------------

def test_admin_invites_require_admin(make_client, admin_client, public_registration):
    with make_client() as anonymous:
        assert anonymous.get("/api/admin/invites").status_code == 401
        assert anonymous.post("/api/admin/invites", json={}).status_code == 401
        assert anonymous.post("/api/admin/invites/x/revoke").status_code == 401

    # admin_client 是管理员；另造普通用户验证 403。
    with make_client() as other:
        signup = other.post(
            "/api/auth/signup",
            json={"email": OTHER_EMAIL, "password": PASSWORD},
        )
        assert signup.status_code == 201
        assert other.get("/api/admin/invites").status_code == 403
        assert other.post("/api/admin/invites", json={}).status_code == 403
        assert other.post("/api/admin/invites/x/revoke").status_code == 403


def test_admin_create_list_revoke_flow(admin_client, invite_only):
    created = admin_client.post(
        "/api/admin/invites",
        json={
            "count": 2,
            "label": "内测第一批",
            "maxUses": 2,
            "expiresInDays": 7,
        },
    )
    assert created.status_code == 200, created.text
    payload = created.json()
    assert len(payload["codes"]) == 2
    assert payload["config"]["registrationOpen"] is False
    assert payload["config"]["inviteRequired"] is True
    for item in payload["codes"]:
        assert item["code"].startswith("LN-")
        assert item["prefix"] == item["code"].replace("-", "")[:6]
        assert item["maxUses"] == 2
        assert item["usedCount"] == 0
        assert item["label"] == "内测第一批"

    listed = admin_client.get("/api/admin/invites?status=active&limit=1&offset=0")
    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert body["total"] == 2
    assert len(body["invites"]) == 1
    assert body["hasMore"] is True
    assert body["counts"]["active"] == 2
    row = body["invites"][0]
    assert set(row) == {
        "id",
        "prefix",
        "label",
        "maxUses",
        "usedCount",
        "status",
        "createdBy",
        "createdAt",
        "expiresAt",
        "revokedAt",
        "revokedBy",
        "lastUsedAt",
    }
    assert "code" not in row
    assert "code_hash" not in row
    assert "codeHash" not in row

    target = payload["codes"][0]
    revoked = admin_client.post(f"/api/admin/invites/{target['id']}/revoke")
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["invite"]["status"] == "revoked"
    assert revoked.json()["alreadyRevoked"] is False

    again = admin_client.post(f"/api/admin/invites/{target['id']}/revoke")
    assert again.status_code == 200
    assert again.json()["alreadyRevoked"] is True

    revoked_list = admin_client.get("/api/admin/invites?status=revoked")
    assert revoked_list.status_code == 200
    assert revoked_list.json()["total"] == 1
    assert revoked_list.json()["invites"][0]["id"] == target["id"]

    missing = admin_client.post("/api/admin/invites/inv-does-not-exist/revoke")
    assert missing.status_code == 404


def test_admin_invite_parameter_validation(admin_client):
    cases = [
        {"count": 0},
        {"count": 11},
        {"maxUses": 0},
        {"maxUses": 11},
        {"expiresInDays": 0},
        {"expiresInDays": 91},
        {"label": "x" * 121},
        {"count": "two"},
    ]
    for body in cases:
        response = admin_client.post("/api/admin/invites", json=body)
        assert response.status_code in (400, 422), (body, response.status_code, response.text)
    assert admin_client.get("/api/admin/invites?status=nope").status_code == 400


def test_admin_created_code_can_register(admin_client, make_client, monkeypatch):
    created = admin_client.post(
        "/api/admin/invites",
        json={"label": "admin-created", "maxUses": 1, "expiresInDays": 30},
    )
    assert created.status_code == 200
    code = created.json()["codes"][0]["code"]

    # 管理员创建后把注册开关切到邀请制（模拟 G1 默认配置）。
    monkeypatch.setattr(config, "REGISTRATION_OPEN", False, raising=False)
    with make_client() as client:
        response = _signup(client, "from-admin-code@example.com", code)
    assert response.status_code == 201, response.text
    assert _rows(
        "SELECT used_count FROM invite_codes WHERE id = ?",
        (created.json()["codes"][0]["id"],),
    )[0]["used_count"] == 1


# ---------------------------------------------------------------------------
# 限流 / 审计
# ---------------------------------------------------------------------------

def test_signup_rate_limit_uses_auth_bucket(make_client, invite_only, monkeypatch):
    monkeypatch.setattr(config, "RATE_LIMIT_AUTH_PER_MINUTE", 2, raising=False)
    with make_client() as client:
        r1 = _signup(client, "rl1@example.com")
        r2 = _signup(client, "rl2@example.com")
        r3 = _signup(client, "rl3@example.com")
    assert r1.status_code == 403
    assert r2.status_code == 403
    assert r3.status_code == 429
    assert r3.headers.get("Retry-After")


def test_audit_log_contains_no_plaintext_code(caplog, admin_client):
    caplog.set_level(logging.INFO, logger="linguatrek.invites")
    created = admin_client.post(
        "/api/admin/invites",
        json={"label": "audit", "maxUses": 1, "expiresInDays": 30},
    )
    assert created.status_code == 200
    code = created.json()["codes"][0]["code"]
    invite_id = created.json()["codes"][0]["id"]
    assert admin_client.post(f"/api/admin/invites/{invite_id}/revoke").status_code == 200

    text = caplog.text
    assert "admin.invite.create" in text
    assert "admin.invite.revoke" in text
    assert code not in text
    assert invite_id in text
