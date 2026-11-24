"""v1.1 账号找回 / 邮箱验证 / 邮件发送 + 迁移 0033 的离线验收（P2-38）。

覆盖：

1. 迁移 0033：0032 → head 只加不减（users 行原样、email_verified_at NULL），
   auth_tokens / feedback 表与索引齐全；downgrade 只删本迁移对象、可重复升降级；
2. 密码重置：request 恒 200 不枚举、token 只存 sha256、单次消费、过期 410、
   新密码生效且旧会话失效、密码策略复用（短密码不烧 token）、请求限流静默；
3. 邮箱验证：登录态 202、token 单次、confirm 标记 email_verified_at、登录/me
   的 emailVerified 字段、过期 410、已认证不重复发信；
4. 邮件：未配置 SMTP 写 dev outbox；配置后走可注入的 SMTP；发送失败不 500；
5. 旧用户：未验证也能正常登录/使用；未迁移库（缺 0033）登录/注册不受影响。
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
from pathlib import Path

import pytest

import auth_db
import config
import emailer
import routes_auth
from tests.migration_utils import (
    assert_alembic_ok,
    columns,
    index_names,
    revision,
    run_alembic,
    table_names,
)

PASSWORD = "correct-horse-battery"
NEW_PASSWORD = "new-password-456"
EMAIL = "recovery@example.com"
UNKNOWN_EMAIL = "nobody@example.com"

TOKEN_RE = re.compile(r"(?:reset|verify)=([A-Za-z0-9_\-]+)")


# ---------------------------------------------------------------------------
# helpers / fixtures
# ---------------------------------------------------------------------------

def _signup(client, email=EMAIL, password=PASSWORD):
    return client.post(
        "/api/auth/signup", json={"email": email, "password": password}
    )


def _login(client, email=EMAIL, password=PASSWORD):
    return client.post(
        "/api/auth/login", json={"email": email, "password": password}
    )


def _db_rows(sql: str, params: tuple = ()) -> list[dict]:
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    try:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def _db_exec(sql: str, params: tuple = ()) -> None:
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def _outbox_messages() -> list[dict]:
    directory = Path(config.EMAIL_OUTBOX_DIR)
    if not directory.exists():
        return []
    return [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(directory.glob("*.json"))
    ]


def _last_outbox_token() -> str:
    messages = _outbox_messages()
    assert messages, "dev outbox 里没有邮件"
    match = TOKEN_RE.search(messages[-1]["text"])
    assert match, f"邮件正文里没有 token 链接：{messages[-1]['text']!r}"
    return match.group(1)


@pytest.fixture()
def migrated_db():
    """当前用例的临时库迁到 head（auth_tokens/feedback/邮箱验证列可用）。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head"
    )
    return config.AUTH_DB_PATH


@pytest.fixture()
def recovery_client(make_client, migrated_db):
    """已迁移库上注册并登录的用户（Cookie 由 TestClient 保存）。"""
    with make_client() as client:
        response = _signup(client)
        assert response.status_code == 201, response.text
        client.user_id = response.json()["user"]["id"]
        yield client


# ---------------------------------------------------------------------------
# 1. 迁移 0033
# ---------------------------------------------------------------------------

def _seed_old_rows(db) -> dict:
    """在 0032 库里造一条旧用户 + 会话，供「只加不减」断言。"""
    conn = sqlite3.connect(db)
    try:
        conn.execute(
            "INSERT INTO users "
            "(id, email, password_hash, created_at, username, credits, status, "
            "balance_micro_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "old-user-id",
                "old@example.com",
                "$argon2id$old-hash",
                1_700_000_000,
                "old",
                7,
                "active",
                2_000_000,
            ),
        )
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) "
            "VALUES (?, ?, ?, ?)",
            ("a" * 64, "old-user-id", 4_000_000_000, 1_700_000_000),
        )
        conn.commit()
    finally:
        conn.close()
    return {"id": "old-user-id"}


def test_migration_0033_only_adds_and_downgrade_is_safe(tmp_path):
    db = tmp_path / "app.db"
    assert_alembic_ok(
        run_alembic(db, "upgrade", "0032_pipeline_timing"), "upgrade 0032"
    )
    old = _seed_old_rows(db)
    before = _db_rows_sqlite(db, "SELECT * FROM users")

    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    assert revision(db) == "0033_v1_1_launch"

    tables = table_names(db)
    assert {"auth_tokens", "feedback"} <= tables
    assert list(columns(db, "auth_tokens")) == [
        "id",
        "user_id",
        "purpose",
        "token_hash",
        "expires_at_ms",
        "used_at_ms",
        "created_at_ms",
        "email",
    ]
    assert list(columns(db, "feedback")) == [
        "id",
        "user_id",
        "request_id",
        "category",
        "message",
        "contact",
        "status",
        "created_at_ms",
        "resolved_at_ms",
        "admin_note",
    ]
    assert columns(db, "feedback")["status"]["default"] is not None
    assert columns(db, "auth_tokens")["used_at_ms"]["notnull"] == 0
    assert columns(db, "feedback")["user_id"]["notnull"] == 0
    assert columns(db, "feedback")["resolved_at_ms"]["notnull"] == 0

    assert "ux_auth_tokens_token_hash" in index_names(db, "auth_tokens")
    assert "ix_auth_tokens_user_purpose" in index_names(db, "auth_tokens")
    assert (
        "ix_auth_tokens_email_purpose_created" in index_names(db, "auth_tokens")
    )
    assert "ix_auth_tokens_expires" in index_names(db, "auth_tokens")
    assert "ix_feedback_status_created" in index_names(db, "feedback")
    assert "ix_feedback_user_created" in index_names(db, "feedback")

    # 只加不删：旧 users 行（含 id/password_hash/credits/余额）原样保留，
    # 新列为 NULL = 未验证（旧用户不强制验证）。
    after = _db_rows_sqlite(db, "SELECT * FROM users")
    assert len(after) == 1
    assert after[0]["id"] == old["id"]
    assert after[0]["password_hash"] == "$argon2id$old-hash"
    assert after[0]["credits"] == 7
    assert after[0]["balance_micro_usd"] == 2_000_000
    assert after[0]["email_verified_at"] is None
    assert [row["id"] for row in before] == [row["id"] for row in after]
    assert _db_rows_sqlite(db, "SELECT token_hash FROM sessions") == [
        {"token_hash": "a" * 64}
    ]

    # 幂等：已到 head 再 upgrade 一次不报错。
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head again")

    # 降级只删本迁移对象，users/sessions 数据保留；可再次升级。
    assert_alembic_ok(
        run_alembic(db, "downgrade", "0032_pipeline_timing"), "downgrade 0032"
    )
    assert revision(db) == "0032_pipeline_timing"
    assert {"auth_tokens", "feedback"}.isdisjoint(table_names(db))
    assert "email_verified_at" not in columns(db, "users")
    assert _db_rows_sqlite(db, "SELECT id, password_hash, credits FROM users") == [
        {"id": "old-user-id", "password_hash": "$argon2id$old-hash", "credits": 7}
    ]

    # 重复 downgrade 安全；重新升级恢复新表/新列（旧数据仍在）。
    assert_alembic_ok(
        run_alembic(db, "downgrade", "0032_pipeline_timing"), "downgrade again"
    )
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "re-upgrade head")
    assert {"auth_tokens", "feedback"} <= table_names(db)
    assert "email_verified_at" in columns(db, "users")
    assert _db_rows_sqlite(db, "SELECT id FROM users") == [{"id": "old-user-id"}]


def _db_rows_sqlite(db, sql: str) -> list[dict]:
    conn = sqlite3.connect(db)
    try:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(sql).fetchall()]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 2. 密码重置
# ---------------------------------------------------------------------------

def test_password_reset_request_never_enumerates(recovery_client):
    existing = recovery_client.post(
        "/api/auth/password-reset/request", json={"email": " RECOVERY@Example.com "}
    )
    assert existing.status_code == 200
    assert existing.json() == {"ok": True}
    messages = _outbox_messages()
    assert len(messages) == 1, "命中邮箱必须发一封重置邮件"
    assert EMAIL in messages[0]["text"] or "重置" in messages[0]["subject"]
    assert "reset=" in messages[0]["text"]
    assert "#/login?" in messages[0]["text"]
    token = _last_outbox_token()
    assert token not in existing.text, "API 响应绝不能回显 token"

    for payload in (
        {"email": UNKNOWN_EMAIL},
        {"email": "not-an-email"},
        {"email": 12345},
        {},
    ):
        response = recovery_client.post(
            "/api/auth/password-reset/request", json=payload
        )
        assert response.status_code == 200, payload
        assert response.json() == {"ok": True}, payload
    assert len(_outbox_messages()) == 1, "不存在/非法邮箱不应触发发信"


def test_password_reset_token_hashed_single_use_and_rotates_password(
    recovery_client, make_client
):
    old_me = recovery_client.get("/api/auth/me")
    assert old_me.json()["user"]["email"] == EMAIL

    assert recovery_client.post(
        "/api/auth/password-reset/request", json={"email": EMAIL}
    ).json() == {"ok": True}
    token = _last_outbox_token()

    rows = _db_rows("SELECT * FROM auth_tokens")
    assert len(rows) == 1
    row = rows[0]
    assert row["token_hash"] == hashlib.sha256(token.encode()).hexdigest()
    assert row["token_hash"] != token
    assert len(row["token_hash"]) == 64
    assert row["purpose"] == auth_db.PURPOSE_PASSWORD_RESET
    assert row["email"] == EMAIL
    assert row["user_id"] == recovery_client.user_id
    assert row["used_at_ms"] is None
    assert abs(row["expires_at_ms"] - (int(time.time() * 1000) + 30 * 60 * 1000)) < 5_000

    # 密码策略复用：短密码 400，且**不消费** token（用户可改正后重试）。
    short = recovery_client.post(
        "/api/auth/password-reset/confirm",
        json={"token": token, "password": "1234567"},
    )
    assert short.status_code == 400
    assert _db_rows("SELECT used_at_ms FROM auth_tokens")[0]["used_at_ms"] is None

    confirmed = recovery_client.post(
        "/api/auth/password-reset/confirm",
        json={"token": token, "password": NEW_PASSWORD},
    )
    assert confirmed.status_code == 200
    assert confirmed.json() == {"ok": True}
    assert _db_rows("SELECT used_at_ms FROM auth_tokens")[0]["used_at_ms"] is not None

    # 单次：重放被拒。
    replay = recovery_client.post(
        "/api/auth/password-reset/confirm",
        json={"token": token, "password": "another-password-789"},
    )
    assert replay.status_code == 400

    # 旧会话失效（只影响该用户）、旧密码不再可用、新密码可登录。
    assert recovery_client.get("/api/auth/me").json() == {
        "user": None,
        "guest": True,
    }
    stale = _login(recovery_client, password=PASSWORD)
    assert stale.status_code == 401
    fresh = _login(recovery_client, password=NEW_PASSWORD)
    assert fresh.status_code == 200
    assert fresh.json()["user"]["emailVerified"] is False


def test_password_reset_expired_token_is_410_and_wrong_purpose_rejected(
    recovery_client,
):
    recovery_client.post("/api/auth/password-reset/request", json={"email": EMAIL})
    token = _last_outbox_token()
    _db_exec(
        "UPDATE auth_tokens SET expires_at_ms = ? WHERE purpose = ?",
        (int(time.time() * 1000) - 1, auth_db.PURPOSE_PASSWORD_RESET),
    )
    expired = recovery_client.post(
        "/api/auth/password-reset/confirm",
        json={"token": token, "password": NEW_PASSWORD},
    )
    assert expired.status_code == 410
    # 密码没被改：旧密码仍可登录。
    assert _login(recovery_client, password=PASSWORD).status_code == 200

    # 用途不符（邮箱验证 token 拿来重置密码）→ 400。
    verify_token = auth_db.create_auth_token(
        EMAIL,
        auth_db.PURPOSE_EMAIL_VERIFY,
        recovery_client.user_id,
        ttl_ms=auth_db.EMAIL_VERIFY_TTL_MS,
    )
    wrong = recovery_client.post(
        "/api/auth/password-reset/confirm",
        json={"token": verify_token, "password": NEW_PASSWORD},
    )
    assert wrong.status_code == 400


def test_password_reset_request_is_rate_limited_silently(
    recovery_client, monkeypatch
):
    monkeypatch.setattr(routes_auth, "RESET_REQUEST_MAX_PER_IP", 1, raising=False)
    assert recovery_client.post(
        "/api/auth/password-reset/request", json={"email": EMAIL}
    ).status_code == 200
    assert len(_outbox_messages()) == 1
    limited = recovery_client.post(
        "/api/auth/password-reset/request", json={"email": EMAIL}
    )
    assert limited.status_code == 200, "超限也不能泄露/报错"
    assert limited.json() == {"ok": True}
    assert len(_outbox_messages()) == 1, "限流期间不应再发信"


def test_password_reset_email_failure_still_returns_200(
    recovery_client, monkeypatch
):
    monkeypatch.setattr(config, "SMTP_HOST", "smtp.example.com", raising=False)
    monkeypatch.setattr(config, "SMTP_FROM", "no-reply@example.com", raising=False)

    def _broken(message):
        raise OSError("smtp down")

    monkeypatch.setattr(emailer, "_smtp_send", _broken)
    response = recovery_client.post(
        "/api/auth/password-reset/request", json={"email": EMAIL}
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert _outbox_messages() == [], "SMTP 模式不应写 dev outbox"


# ---------------------------------------------------------------------------
# 3. 邮箱验证
# ---------------------------------------------------------------------------

def test_email_verification_requires_login_and_marks_verified(
    recovery_client, make_client
):
    with make_client() as anonymous:
        assert anonymous.post(
            "/api/auth/email-verification/request"
        ).status_code == 401

    me_before = recovery_client.get("/api/auth/me").json()
    assert me_before["user"]["emailVerified"] is False

    requested = recovery_client.post("/api/auth/email-verification/request")
    assert requested.status_code == 202
    assert requested.json() == {"ok": True}
    messages = _outbox_messages()
    assert len(messages) == 1
    assert "验证" in messages[0]["subject"]
    token = _last_outbox_token()
    assert token not in requested.text

    rows = _db_rows("SELECT * FROM auth_tokens")
    assert rows[0]["purpose"] == auth_db.PURPOSE_EMAIL_VERIFY
    assert rows[0]["token_hash"] == hashlib.sha256(token.encode()).hexdigest()

    # 链接可能在没有登录态的新设备打开：confirm 不要求登录。
    with make_client() as anonymous:
        confirmed = anonymous.post(
            "/api/auth/email-verification/confirm", json={"token": token}
        )
    assert confirmed.status_code == 200
    assert confirmed.json() == {"ok": True}
    assert _db_rows("SELECT email_verified_at FROM users")[0][
        "email_verified_at"
    ] is not None

    # 登录/me 都带 emailVerified=true；旧字段仍在。
    me_after = recovery_client.get("/api/auth/me").json()
    assert me_after["user"]["emailVerified"] is True
    assert set(me_after["user"]) == {
        "id",
        "email",
        "username",
        "credits",
        "status",
        "emailVerified",
    }
    with make_client() as fresh:
        login = _login(fresh)
    assert login.status_code == 200
    assert login.json()["user"]["emailVerified"] is True

    # 重放被拒；已验证用户再申请只 202、不再发信。
    replay = recovery_client.post(
        "/api/auth/email-verification/confirm", json={"token": token}
    )
    assert replay.status_code == 400
    again = recovery_client.post("/api/auth/email-verification/request")
    assert again.status_code == 202
    assert len(_outbox_messages()) == 1


def test_email_verification_expired_token_is_410(recovery_client):
    recovery_client.post("/api/auth/email-verification/request")
    token = _last_outbox_token()
    _db_exec(
        "UPDATE auth_tokens SET expires_at_ms = ? WHERE purpose = ?",
        (int(time.time() * 1000) - 1, auth_db.PURPOSE_EMAIL_VERIFY),
    )
    response = recovery_client.post(
        "/api/auth/email-verification/confirm", json={"token": token}
    )
    assert response.status_code == 410
    assert recovery_client.get("/api/auth/me").json()["user"][
        "emailVerified"
    ] is False


def test_old_user_without_verification_can_still_login_and_use_app(
    make_client, migrated_db
):
    auth_db.create_user("legacy@example.com", "legacy-password-123")
    with make_client() as client:
        login = _login(client, "legacy@example.com", "legacy-password-123")
        assert login.status_code == 200
        assert login.json()["user"]["emailVerified"] is False
        assert client.get("/api/favorites").status_code == 200
        # 未验证不阻断任何接口；/me 也照常返回。
        assert client.get("/api/auth/me").status_code == 200


# ---------------------------------------------------------------------------
# 4. 邮件发送（dev outbox / SMTP 可插拔）
# ---------------------------------------------------------------------------

def test_emailer_writes_dev_outbox_when_smtp_unconfigured():
    result = emailer.send_email(
        "User@Example.com", "测试主题", "正文 token=abc", kind="unit-test"
    )
    assert result["transport"] == "outbox"
    path = Path(result["path"])
    assert path.exists()
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["to"] == "user@example.com"
    assert payload["subject"] == "测试主题"
    assert "token=abc" in payload["text"]
    assert path.stat().st_mode & 0o077 == 0, "dev outbox 文件必须是 0600"


def test_emailer_uses_smtp_when_configured(monkeypatch):
    monkeypatch.setattr(config, "SMTP_HOST", "smtp.example.com", raising=False)
    monkeypatch.setattr(config, "SMTP_PORT", 465, raising=False)
    monkeypatch.setattr(config, "SMTP_SSL", True, raising=False)
    monkeypatch.setattr(config, "SMTP_FROM", "no-reply@example.com", raising=False)
    sent: list = []

    def _fake_send(message):
        sent.append(message)

    monkeypatch.setattr(emailer, "_smtp_send", _fake_send)
    result = emailer.send_email("user@example.com", "主题", "正文")
    assert result == {"transport": "smtp"}
    assert len(sent) == 1
    assert sent[0]["To"] == "user@example.com"
    assert sent[0]["From"] == "no-reply@example.com"
    assert _outbox_messages() == []


def test_emailer_failure_raises_and_links_use_public_base_url(monkeypatch):
    monkeypatch.setattr(config, "SMTP_HOST", "smtp.example.com", raising=False)
    monkeypatch.setattr(config, "SMTP_FROM", "no-reply@example.com", raising=False)

    def _broken(message):
        raise OSError("smtp down")

    monkeypatch.setattr(emailer, "_smtp_send", _broken)
    with pytest.raises(emailer.EmailSendError):
        emailer.send_email("user@example.com", "主题", "正文")

    monkeypatch.setattr(
        config, "PUBLIC_BASE_URL", "https://linguatrek.example", raising=False
    )
    assert (
        emailer.password_reset_link("tok-1")
        == "https://linguatrek.example/#/login?reset=tok-1"
    )
    assert (
        emailer.email_verification_link("tok-2")
        == "https://linguatrek.example/#/login?verify=tok-2"
    )


# ---------------------------------------------------------------------------
# 5. 未迁移库：账号找回降级但不影响登录/注册
# ---------------------------------------------------------------------------

def test_unmigrated_db_keeps_auth_working_and_recovery_degrades(
    make_client
):
    with make_client() as client:
        signup = _signup(client, email="no-migrate@example.com")
        assert signup.status_code == 201
        assert signup.json()["user"]["emailVerified"] is False
        assert client.get("/api/auth/me").json()["user"]["emailVerified"] is False
        assert _login(client, "no-migrate@example.com", PASSWORD).status_code == 200

        # 缺 0033：request 恒 200（静默降级），confirm 503 提示先迁移。
        requested = client.post(
            "/api/auth/password-reset/request",
            json={"email": "no-migrate@example.com"},
        )
        assert requested.status_code == 200
        assert requested.json() == {"ok": True}
        confirm = client.post(
            "/api/auth/password-reset/confirm",
            json={"token": "whatever", "password": NEW_PASSWORD},
        )
        assert confirm.status_code == 503
        assert "0033" in confirm.json()["detail"]

        verify = client.post("/api/auth/email-verification/request")
        assert verify.status_code == 202
        verify_confirm = client.post(
            "/api/auth/email-verification/confirm", json={"token": "whatever"}
        )
        assert verify_confirm.status_code == 503


# ---------------------------------------------------------------------------
# 6. 账号硬删除：账号找回 token / 反馈随账号清理（0033 新表）
# ---------------------------------------------------------------------------

def test_account_hard_delete_cleans_recovery_tokens_and_feedback(recovery_client):
    import account_lifecycle

    user_id = recovery_client.user_id
    auth_db.create_auth_token(
        EMAIL,
        auth_db.PURPOSE_PASSWORD_RESET,
        user_id,
        ttl_ms=auth_db.PASSWORD_RESET_TTL_MS,
    )
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    try:
        conn.execute(
            "INSERT INTO feedback (user_id, category, message, status, "
            "created_at_ms) VALUES (?, ?, ?, 'open', ?)",
            (user_id, "bug", "删除测试反馈", int(time.time() * 1000)),
        )
        conn.execute(
            "INSERT INTO feedback (user_id, category, message, status, "
            "created_at_ms) VALUES (NULL, 'other', '匿名反馈', 'open', ?)",
            (int(time.time() * 1000),),
        )
        conn.commit()
    finally:
        conn.close()

    conn = auth_db.connect()
    try:
        counts = account_lifecycle._delete_business_rows(conn, user_id)
        conn.commit()
    finally:
        conn.close()

    assert counts["auth_tokens"] == 1
    assert counts["feedback"] == 1
    assert _db_rows("SELECT id FROM auth_tokens") == []
    assert _db_rows("SELECT message FROM feedback") == [{"message": "匿名反馈"}]
