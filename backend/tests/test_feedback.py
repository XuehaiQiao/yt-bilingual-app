"""反馈/纠错 API 离线验收（v1.1 P0 / P2-39，specs/048）。

覆盖：

1. 登录用户提交 → 入 ``feedback`` 表（0033）：user_id/分类/正文/联系方式/
   requestId/状态 open；响应 ``{id, status, requestId}``；
2. 游客提交（``user_id`` NULL）+ 前端在用的 ``description`` 别名；
3. ``requestId`` 缺省时回落到访问日志的 request_id（``X-Request-ID``）；
4. 非法载荷一律 400 且**不落库**（未知分类/空正文/超长/非字符串/联系方式超长）；
5. 限流：登录/游客各自的上限（429 + Retry-After），两档互不影响；
6. 管理端列表：require_admin（401/403）、最近优先、status 过滤、limit、无账号
   敏感字段；
7. 管理端更新：状态白名单/404/空对象 400、resolved_at_ms 进出终态、adminNote、
   审计行；
8. 未迁移库：提交与列表都 503（写路径不 fail-open，不静默丢反馈）。
"""
from __future__ import annotations

import json
import sqlite3
import time

import pytest

import config
import feedback
import ratelimit
from tests.migration_utils import assert_alembic_ok, run_alembic

USER_EMAIL = "feedback-user@example.com"
USER_PASSWORD = "feedback-password-123"
SENSITIVE_FRAGMENTS = ("password_hash", "token_hash", "ln_session")


# ---------------------------------------------------------------------------
# helpers / fixtures
# ---------------------------------------------------------------------------

def _db_rows(sql: str, params: tuple = ()) -> list[dict]:
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    try:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


@pytest.fixture()
def migrated_db():
    """当前用例的临时库迁到 head（feedback / admin_audit_log 可用）。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (feedback)"
    )
    return config.AUTH_DB_PATH


@pytest.fixture()
def fb_client(make_client, migrated_db):
    """已迁移库上注册并登录的用户（Cookie 由 TestClient 保存）。"""
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


@pytest.fixture()
def admin_client(fb_client, monkeypatch):
    """把当前用户设为唯一管理员（``ADMIN_EMAILS`` 大小写不敏感）。"""
    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({fb_client.user_email}), raising=False
    )
    return fb_client


def _post(client, **payload):
    return client.post("/api/feedback", json=payload)


# ---------------------------------------------------------------------------
# 1. 提交（登录 / 游客）
# ---------------------------------------------------------------------------

def test_signed_in_feedback_persists_row(fb_client):
    started = int(time.time() * 1000)
    response = _post(
        fb_client,
        category="BUG",
        message="  导出按钮点了没反应  ",
        page="#/account?tab=library",
        requestId="req-123",
        contact="me@example.com",
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert isinstance(body["id"], str), "回执 id 是字符串（前端 FeedbackReceipt.id）"
    assert body["id"].isdigit()
    assert body["status"] == "open"
    assert body["requestId"] == "req-123"

    rows = _db_rows("SELECT * FROM feedback")
    assert len(rows) == 1
    row = rows[0]
    assert int(body["id"]) == row["id"]
    assert row["user_id"] == fb_client.user_id
    assert row["category"] == "bug", "分类应规范化为小写"
    assert row["message"] == "导出按钮点了没反应", "正文应去首尾空白"
    assert row["contact"] == "me@example.com"
    assert row["request_id"] == "req-123"
    assert row["status"] == "open"
    assert row["resolved_at_ms"] is None
    assert row["admin_note"] is None
    assert abs(row["created_at_ms"] - started) < 10_000
    # 0033 没有 page 列：来源页只进日志，不落库（specs/048 §4）。
    assert "page" not in row


def test_guest_feedback_accepts_description_alias(make_client, migrated_db):
    with make_client() as guest:
        response = guest.post(
            "/api/feedback",
            json={
                "category": "content",
                "description": "第二段译文把 habits 译成了「习惯们」，请修正。",
                "requestId": "guest-1",
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["requestId"] == "guest-1"
    rows = _db_rows("SELECT * FROM feedback")
    assert len(rows) == 1
    assert rows[0]["user_id"] is None, "游客反馈必须允许 user_id NULL"
    assert rows[0]["message"].startswith("第二段译文")
    assert rows[0]["contact"] is None


def test_request_id_falls_back_to_access_log_id(fb_client):
    response = fb_client.post(
        "/api/feedback",
        json={"category": "other", "message": "页面加载有点慢"},
        headers={"X-Request-ID": "trace-abc-123"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["requestId"] == "trace-abc-123"
    assert _db_rows("SELECT request_id FROM feedback") == [
        {"request_id": "trace-abc-123"}
    ]


# ---------------------------------------------------------------------------
# 2. 非法载荷（400 且不落库）
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"category": "weird", "message": "hi"},
        {"category": "bug"},
        {"category": "bug", "message": ""},
        {"category": "bug", "message": "   "},
        {"category": "bug", "message": "x" * (feedback.MESSAGE_MAX + 1)},
        {"category": "bug", "message": 123},
        {"category": 42, "message": "hi"},
        {"category": "bug", "message": "四个字啊"},
        {"category": "bug", "message": "okkkk", "contact": "x" * (feedback.CONTACT_MAX + 1)},
        {"category": "bug", "message": "okkkk", "page": 123},
    ],
)
def test_invalid_feedback_payload_is_400_and_not_stored(fb_client, payload):
    response = fb_client.post("/api/feedback", json=payload)
    assert response.status_code == 400, response.text
    assert "detail" in response.json()
    assert _db_rows("SELECT COUNT(*) AS n FROM feedback")[0]["n"] == 0


# ---------------------------------------------------------------------------
# 3. 限流
# ---------------------------------------------------------------------------

def test_signed_in_feedback_is_rate_limited(fb_client, monkeypatch):
    monkeypatch.setattr(
        config, "RATE_LIMIT_FEEDBACK_PER_MINUTE", 2, raising=False
    )
    ratelimit.reset_rate_limits()
    for index in range(2):
        assert (
            _post(fb_client, category="bug", message=f"第 {index} 条反馈").status_code
            == 200
        )

    limited = _post(fb_client, category="bug", message="第 3 条反馈")
    assert limited.status_code == 429, limited.text
    body = limited.json()
    assert body["detail"].startswith("请求过于频繁")
    assert isinstance(body["retryAfter"], int) and body["retryAfter"] >= 1
    assert int(limited.headers["Retry-After"]) >= 1
    assert _db_rows("SELECT COUNT(*) AS n FROM feedback")[0]["n"] == 2, "超限请求不落库"


def test_guest_feedback_has_its_own_tighter_rate_limit(make_client, migrated_db, monkeypatch):
    monkeypatch.setattr(
        config, "RATE_LIMIT_GUEST_FEEDBACK_PER_MINUTE", 1, raising=False
    )
    ratelimit.reset_rate_limits()
    with make_client() as guest:
        assert guest.post(
            "/api/feedback",
            json={"category": "other", "description": "游客第一条"},
        ).status_code == 200
        limited = guest.post(
            "/api/feedback",
            json={"category": "other", "description": "游客第二条"},
        )
        assert limited.status_code == 429, limited.text
    assert _db_rows("SELECT COUNT(*) AS n FROM feedback")[0]["n"] == 1


# ---------------------------------------------------------------------------
# 4. 管理端：权限
# ---------------------------------------------------------------------------

def test_admin_feedback_requires_admin(make_client, migrated_db, fb_client):
    with make_client() as anonymous:
        assert anonymous.get("/api/admin/feedback").status_code == 401
    assert fb_client.get("/api/admin/feedback").status_code == 403, "普通用户不是管理员"
    assert fb_client.patch(
        "/api/admin/feedback/1", json={"status": "open"}
    ).status_code == 403


# ---------------------------------------------------------------------------
# 5. 管理端：列表 + 更新
# ---------------------------------------------------------------------------

def _seed_feedback(admin_client, make_client) -> list[str]:
    ids = [
        _post(admin_client, category="bug", message="第一条反馈").json()["id"],
        _post(admin_client, category="feature", message="第二条反馈").json()["id"],
    ]
    with make_client() as guest:
        guest_response = guest.post(
            "/api/feedback",
            json={"category": "other", "description": "游客的一条"},
        )
        assert guest_response.status_code == 200, guest_response.text
        ids.append(guest_response.json()["id"])
    return ids


def test_admin_feedback_list_and_update(admin_client, make_client):
    first_id, second_id, guest_id = (
        int(value) for value in _seed_feedback(admin_client, make_client)
    )

    listed = admin_client.get("/api/admin/feedback")
    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert body["total"] == 3
    assert body["limit"] == feedback.DEFAULT_LIST_LIMIT
    assert [item["id"] for item in body["items"]] == [guest_id, second_id, first_id], (
        "最近优先：同毫秒时按 id 倒序"
    )
    item = body["items"][0]
    assert set(item) == {
        "id",
        "userId",
        "requestId",
        "category",
        "message",
        "contact",
        "status",
        "createdAt",
        "resolvedAt",
        "adminNote",
    }
    for fragment in SENSITIVE_FRAGMENTS:
        assert fragment not in listed.text, f"管理台载荷不能含账号敏感字段：{fragment}"

    limited = admin_client.get("/api/admin/feedback?limit=2")
    assert limited.status_code == 200
    assert len(limited.json()["items"]) == 2
    assert limited.json()["total"] == 3, "total 是过滤后的总数，不是本页条数"

    assert admin_client.get("/api/admin/feedback?status=all").status_code == 200
    assert admin_client.get("/api/admin/feedback?status=bogus").status_code == 400
    assert admin_client.get("/api/admin/feedback?limit=0").status_code == 422

    resolved = admin_client.patch(
        f"/api/admin/feedback/{first_id}",
        json={"status": "resolved", "adminNote": "已修复并部署"},
    )
    assert resolved.status_code == 200, resolved.text
    updated = resolved.json()
    assert updated["status"] == "resolved"
    assert updated["adminNote"] == "已修复并部署"
    assert updated["resolvedAt"] is not None

    pending = admin_client.get("/api/admin/feedback?status=open")
    assert pending.json()["total"] == 2
    assert all(item["status"] == "open" for item in pending.json()["items"])

    audits = _db_rows(
        "SELECT * FROM admin_audit_log WHERE action = 'admin.feedback.update'"
    )
    assert len(audits) == 1
    assert audits[0]["actor_id"] == admin_client.user_id
    assert audits[0]["target_type"] == "feedback"
    assert audits[0]["target_id"] == str(first_id)
    detail = json.loads(audits[0]["detail_json"])
    assert detail["changes"]["status"] == {"from": "open", "to": "resolved"}

    reopened = admin_client.patch(
        f"/api/admin/feedback/{first_id}", json={"status": "open"}
    )
    assert reopened.status_code == 200
    assert reopened.json()["status"] == "open"
    assert reopened.json()["resolvedAt"] is None, "退回非终态应清空处理时间"
    assert reopened.json()["adminNote"] == "已修复并部署", "未提供 adminNote 时保持原值"

    cleared = admin_client.patch(
        f"/api/admin/feedback/{first_id}", json={"adminNote": None}
    )
    assert cleared.status_code == 200
    assert cleared.json()["adminNote"] is None

    assert admin_client.patch(
        f"/api/admin/feedback/{guest_id}", json={"status": "weird"}
    ).status_code == 400
    assert admin_client.patch(
        f"/api/admin/feedback/{guest_id}", json={}
    ).status_code == 400
    assert admin_client.patch(
        "/api/admin/feedback/999999", json={"status": "resolved"}
    ).status_code == 404


# ---------------------------------------------------------------------------
# 6. 未迁移库（503）
# ---------------------------------------------------------------------------

def test_feedback_returns_503_when_table_missing(client, monkeypatch):
    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({client.user_email}), raising=False
    )
    submitted = client.post(
        "/api/feedback", json={"category": "bug", "message": "未迁移库测试"}
    )
    assert submitted.status_code == 503, submitted.text
    assert "alembic upgrade head" in submitted.json()["detail"]

    listed = client.get("/api/admin/feedback")
    assert listed.status_code == 503, listed.text
