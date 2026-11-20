"""M2a 账号删除/理性期/硬删除/审计的离线验收（specs/033）。

覆盖：

1. 删除申请：密码 + 用户名 + ``DELETE`` 确认；立即吊销会话；7 天冷静期；
2. pending 状态：登录放行、``/api/auth/*`` 与 ``/api/account/*`` 可用，其它
   ``/api/*`` 403 ``account_pending_deletion``（AI/写学习数据被阻断）；
3. 取消：密码确认 → active；取消后业务恢复；
4. 最后管理员保护；重复申请 409；
5. 管理员列表 / 到期执行 / ``force`` 提前执行 / 二次确认 / 原因；
6. 硬删除的数据库/目录/导出文件断言：users/sessions/业务行全删，备份与公共
   缓存不动；旧 Cookie 失效、旧密码 401；审计只留 hash / 计数；
7. 文件删除失败 → 申请 failed、用户保留、可重试，不假装成功；
8. 迁移 0024：upgrade / downgrade / 再 upgrade、字段/索引/CHECK/部分唯一索引。
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from pathlib import Path

import pytest

import account
import account_lifecycle
import config
import events
import routes_auth
import storage
from tests.conftest import (
    SECOND_USER_EMAIL,
    SECOND_USER_PASSWORD,
    TEST_USER_EMAIL,
    TEST_USER_PASSWORD,
)
from tests.migration_utils import (
    assert_alembic_ok,
    columns,
    index_names,
    revision,
    run_alembic,
    table_names,
)

PASSWORD = TEST_USER_PASSWORD
SECOND_PASSWORD = SECOND_USER_PASSWORD


# ---------------------------------------------------------------------------
# 夹具 / 造数
# ---------------------------------------------------------------------------

@pytest.fixture()
def migrated(client):
    """默认已登录用户建好后，把临时库迁移到 head。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (M2a)"
    )
    return client


@pytest.fixture()
def admin_client(make_client, migrated, monkeypatch):
    """另建一个管理员账号，并让 ADMIN_EMAILS 只指向它。"""
    with make_client() as client:
        response = client.post(
            "/api/auth/signup",
            json={"email": SECOND_USER_EMAIL, "password": SECOND_PASSWORD},
        )
        assert response.status_code == 201, response.text
        client.user_id = response.json()["user"]["id"]
        monkeypatch.setattr(
            config, "ADMIN_EMAILS", frozenset({SECOND_USER_EMAIL}), raising=False
        )
        yield client


def _exec(sql: str, params: tuple = ()) -> None:
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def _fetchone(sql: str, params: tuple = ()):
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    try:
        return conn.execute(sql, params).fetchone()
    finally:
        conn.close()


def _fetchall(sql: str, params: tuple = ()):
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def _username(client) -> str:
    me = client.get("/api/auth/me")
    assert me.status_code == 200, me.text
    return me.json()["user"]["username"]


def _submit(client, password: str = PASSWORD, username: str | None = None, confirm: str = "DELETE"):
    return client.post(
        "/api/account/deletion",
        json={
            "password": password,
            "username": _username(client) if username is None else username,
            "confirm": confirm,
        },
    )


def _deletion_state(client) -> dict:
    response = client.get("/api/account/deletion")
    assert response.status_code == 200, response.text
    return response.json()


def _seed_business_data(user_id: str, tmp_path: Path) -> None:
    """给用户造一套覆盖删除清单的数据库行 + 文件 + 导出临时文件。"""
    now = int(time.time() * 1000)
    pseudo = events.pseudonym_for(user_id)
    _exec(
        "INSERT INTO learning_events (user_id, pseudonym_id, event_type, "
        "occurred_at, created_at) VALUES (?, ?, 'test', ?, ?)",
        (user_id, pseudo, now, now),
    )
    _exec(
        "INSERT INTO word_states (id, user_id, lemma, target_lang, state, due_at, "
        "created_at) VALUES ('ws-1', ?, 'apple', 'zh-CN', 'review', ?, ?)",
        (user_id, now, now),
    )
    _exec(
        "INSERT INTO word_sources (word_state_id, content_ref, created_at) "
        "VALUES ('ws-1', 'video-1', ?)",
        (now,),
    )
    _exec(
        "INSERT INTO ai_usage (user_id, feature, model_id, input_tokens, "
        "output_tokens, calls, est_cost_usd, occurred_at, created_at, usage_date) "
        "VALUES (?, 'translate', 'deepseek-chat', 10, 20, 1, 0.01, ?, ?, '2026-11-20')",
        (user_id, now, now),
    )
    _exec(
        "INSERT INTO watch_events (user_id, content_ref, kind, target_lang, "
        "watched_seconds, position_seconds, occurred_at, client_event_id) "
        "VALUES (?, 'video-1', 'video', 'zh-CN', 60, 10, ?, 'client-1')",
        (user_id, now),
    )
    _exec(
        "INSERT INTO articles (id, user_id, title, lang, word_count, created_at) "
        "VALUES ('art-1', ?, 'Test', 'en', 10, ?)",
        (user_id, now),
    )
    _exec(
        "INSERT INTO article_paragraphs (article_id, idx, text) "
        "VALUES ('art-1', 0, 'hello')"
    )
    _exec(
        "INSERT INTO article_translations (article_id, idx, target_lang, text, "
        "created_at) VALUES ('art-1', 0, 'zh-CN', '你好', ?)",
        (now,),
    )
    _exec(
        "INSERT INTO article_progress (user_id, article_id, paragraph_idx, updated_at) "
        "VALUES (?, 'art-1', 0, ?)",
        (user_id, now),
    )
    _exec(
        "INSERT INTO imported_books (id, user_id, source_type, source_url, "
        "external_id, title, chapters_json, created_at, updated_at) "
        "VALUES ('book-1', ?, 'local_epub', '', 'sha', 'Book', "
        "'{\"chapters\": []}', ?, ?)",
        (user_id, now, now),
    )
    _exec(
        "INSERT INTO imported_book_translations (book_id, chapter_index, lang, "
        "paragraphs_json, created_at) VALUES ('book-1', 0, 'zh-CN', '[]', ?)",
        (now,),
    )
    _exec(
        "INSERT INTO jobs (id, user_id, kind, content_ref, target_lang, status, "
        "cursor, created_at, updated_at) "
        "VALUES ('job-1', ?, 'process_video', 'video-1', 'zh-CN', 'done', 1, ?, ?)",
        (user_id, now, now),
    )
    _exec(
        "INSERT INTO credit_transactions (id, user_id, delta, reason, created_at) "
        "VALUES ('ct-1', ?, 5, 'test', ?)",
        (user_id, now),
    )
    _exec(
        "INSERT INTO generated_courses (id, owner_user_id, source_kind, source_ref, "
        "content_hash, level, target_lang, prompt_version, title, lesson_json, "
        "status, created_at) VALUES ('gen-1', ?, 'youtube', 'video-1', 'hash', "
        "'orbit', 'zh-CN', 'course-gen.v1', 'Lesson', '{}', 'ready', ?)",
        (user_id, now),
    )
    _exec(
        "INSERT INTO invite_redemptions (id, invite_id, user_id, redeemed_at_ms) "
        "VALUES ('red-1', 'inv-x', ?, ?)",
        (user_id, now),
    )

    # 公共缓存：删除用户时不能动。
    _exec(
        "INSERT INTO content_teaching_analysis (id, content_ref, content_hash, "
        "level, target_lang, payload_json, created_at) "
        "VALUES ('cta-1', 'video-public', 'hash-public', 'orbit', 'zh-CN', '{}', ?)",
        (now,),
    )
    _exec(
        "INSERT INTO book_chapter_translations (book_id, chapter_no, target_lang, "
        "paragraphs_json, created_at, updated_at) "
        "VALUES ('public-book', 1, 'zh-CN', '[]', ?, ?)",
        (now, now),
    )

    # 用户目录 + 收藏/历史 + 导入书文件。
    user_dir = Path(storage.user_data_dir(user_id))
    (user_dir / "history").mkdir(parents=True, exist_ok=True)
    (user_dir / "history" / "video-1.json").write_text('{"ok":true}', encoding="utf-8")
    (user_dir / "favorites.json").write_text("[]", encoding="utf-8")
    book_dir = Path(storage.user_books_dir(user_id)) / "epub-0123456789abcdef0123456789abcdef"
    (book_dir / "chapters").mkdir(parents=True, exist_ok=True)
    (book_dir / "meta.json").write_text('{"title":"Book"}', encoding="utf-8")
    (book_dir / "chapters" / "0001.json").write_text('{"paragraphs":[]}', encoding="utf-8")

    # 导出临时文件 + 任务行（硬删除必须清掉）。
    export_dir = Path(config.EXPORTS_DIR) / user_id
    export_dir.mkdir(parents=True, exist_ok=True)
    export_file = export_dir / "exp-test.zip"
    export_file.write_bytes(b"PK-test")
    _exec(
        "INSERT INTO data_export_jobs (id, user_id, status, requested_at_ms, "
        "expires_at_ms, file_path, size_bytes, download_token_hash) "
        "VALUES ('exp-test', ?, 'ready', ?, ?, ?, 7, 'hash')",
        (user_id, now, now + 3600_000, f"{user_id}/exp-test.zip"),
    )

    # 备份目录（不在任何删除逻辑里）。用 tmp_path 下的假备份代替真实备份。
    backups = tmp_path / "backups"
    backups.mkdir(exist_ok=True)
    (backups / "daily.tar.gz").write_bytes(b"backup")
    return user_dir


def _assert_user_rows_gone(user_id: str, pseudo: str) -> None:
    assert _fetchone("SELECT id FROM users WHERE id = ?", (user_id,)) is None
    assert _fetchone("SELECT COUNT(*) FROM sessions WHERE user_id = ?", (user_id,))[0] == 0
    for table, column in (
        ("learning_events", "user_id"),
        ("watch_events", "user_id"),
        ("word_states", "user_id"),
        ("review_logs", "user_id"),
        ("attempts", "user_id"),
        ("content_items", "user_id"),
        ("exam_sessions", "user_id"),
        ("placement_sessions", "user_id"),
        ("assessment_sessions", "user_id"),
        ("user_profiles", "user_id"),
        ("skill_evidence", "user_id"),
        ("user_skill_profiles", "user_id"),
        ("articles", "user_id"),
        ("article_progress", "user_id"),
        ("imported_books", "user_id"),
        ("course_attempts", "user_id"),
        ("course_events", "user_id"),
        ("jobs", "user_id"),
        ("discover_queries", "user_id"),
        ("credit_transactions", "user_id"),
        ("invite_redemptions", "user_id"),
        ("data_export_jobs", "user_id"),
    ):
        assert (
            _fetchone(f"SELECT COUNT(*) FROM {table} WHERE {column} = ?", (user_id,))[0]
            == 0
        ), table
    assert (
        _fetchone(
            "SELECT COUNT(*) FROM generated_courses WHERE owner_user_id = ?", (user_id,)
        )[0]
        == 0
    )
    assert (
        _fetchone(
            "SELECT COUNT(*) FROM learning_events WHERE pseudonym_id = ?", (pseudo,)
        )[0]
        == 0
    )
    assert _fetchone("SELECT COUNT(*) FROM word_sources")[0] == 0
    assert _fetchone("SELECT COUNT(*) FROM questions")[0] == 0
    assert _fetchone("SELECT COUNT(*) FROM exam_answers")[0] == 0
    assert _fetchone("SELECT COUNT(*) FROM placement_answers")[0] == 0
    assert _fetchone("SELECT COUNT(*) FROM article_paragraphs")[0] == 0
    assert _fetchone("SELECT COUNT(*) FROM article_translations")[0] == 0
    assert _fetchone("SELECT COUNT(*) FROM imported_book_translations")[0] == 0


# ---------------------------------------------------------------------------
# 1. 删除申请 / 冷却期 / pending 访问控制 / 取消
# ---------------------------------------------------------------------------

def test_deletion_request_pending_restrictions_and_cancel(migrated, make_client):
    client = migrated
    state = _deletion_state(client)
    assert state["status"] == "active"
    assert state["cooldownDays"] == 7
    assert state["backupRetentionDays"] == 30
    assert "30 天" in state["notice"]

    username = _username(client)
    assert _submit(client, confirm="delete").status_code == 400
    assert _submit(client, username="other-name").status_code == 400
    wrong = _submit(client, password="wrong-password")
    assert wrong.status_code == 401
    assert wrong.json()["code"] == "password_invalid"

    old_token = client.cookies.get(routes_auth.COOKIE_NAME)
    assert old_token
    response = _submit(client)
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["status"] == "deletion_pending"
    assert body["dueAt"] - body["requestedAt"] == account_lifecycle.COOLDOWN_MS
    assert body["sessionsRevoked"] is True
    assert body["backupRetentionDays"] == 30

    # 提交后 Cookie 已清；旧 token 不再对应任何会话。
    assert client.get("/api/auth/me").json()["user"] is None
    with make_client() as old_client:
        old_client.cookies.set(routes_auth.COOKIE_NAME, old_token)
        old_me = old_client.get("/api/auth/me")
        assert old_me.status_code == 200
        assert old_me.json()["user"] is None

    # pending 可以重新登录（用于取消/导出）。
    login = client.post(
        "/api/auth/login", json={"email": TEST_USER_EMAIL, "password": PASSWORD}
    )
    assert login.status_code == 200, login.text
    assert login.json()["user"]["status"] == "deletion_pending"
    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["user"]["status"] == "deletion_pending"

    pending_state = _deletion_state(client)
    assert pending_state["status"] == "deletion_pending"
    assert pending_state["dueAt"]
    assert pending_state["deletion"]["status"] == "pending"
    assert pending_state["deletion"]["verifiedVia"] == "session_password"

    # 除 auth/account 外的 /api/* 全部 403，且带稳定 code。
    for method, path in (
        ("get", "/api/user/summary"),
        ("get", "/api/estimate-cost"),
        ("get", "/api/blog/posts"),
        ("get", "/api/books"),
        ("post", "/api/events"),
    ):
        denied = getattr(client, method)(path)
        assert denied.status_code == 403, (path, denied.text)
        assert denied.json()["code"] == "account_pending_deletion", path
    # auth/account 端点仍可用。
    assert client.get("/api/account/exports").status_code == 200
    assert client.get("/api/auth/me").status_code == 200
    claim = client.post("/api/auth/claim-guest")
    assert claim.status_code == 403
    assert claim.json()["code"] == "account_pending_deletion"

    # 冷静期内重复提交 409。
    duplicate = _submit(client)
    assert duplicate.status_code == 409
    assert duplicate.json()["code"] == "deletion_already_pending"

    # 取消需要密码；错误密码不改变状态。
    bad_cancel = client.post(
        "/api/account/deletion/cancel", json={"password": "wrong-password"}
    )
    assert bad_cancel.status_code == 401
    assert bad_cancel.json()["code"] == "password_invalid"
    assert _deletion_state(client)["status"] == "deletion_pending"
    cancel = client.post(
        "/api/account/deletion/cancel", json={"password": PASSWORD}
    )
    assert cancel.status_code == 200, cancel.text
    assert cancel.json()["status"] == "active"
    assert client.get("/api/user/summary").status_code == 200

    after = _deletion_state(client)
    assert after["status"] == "active"
    assert after["deletion"]["status"] == "cancelled"

    # 没有 pending 申请时取消 → 409。
    again = client.post(
        "/api/account/deletion/cancel", json={"password": PASSWORD}
    )
    assert again.status_code == 409
    assert again.json()["code"] == "deletion_not_pending"


def test_last_admin_cannot_submit_deletion(migrated, monkeypatch):
    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({TEST_USER_EMAIL}), raising=False
    )
    response = _submit(migrated)
    assert response.status_code == 409
    assert response.json()["code"] == "last_admin"
    assert _deletion_state(migrated)["status"] == "active"
    # 管理员 PATCH 仍只能 active/banned，不能把用户设成 pending。
    assert account.STATUSES == (account.STATUS_ACTIVE, account.STATUS_BANNED)
    assert account.STATUS_DELETION_PENDING in account.ALL_STATUSES


# ---------------------------------------------------------------------------
# 2. 管理员执行硬删除：数据/目录/审计断言
# ---------------------------------------------------------------------------

def test_admin_execute_hard_delete_cleans_everything(
    migrated, admin_client, make_client, tmp_path
):
    client = migrated
    user_id = client.user_id
    pseudo = events.pseudonym_for(user_id)
    user_dir = _seed_business_data(user_id, tmp_path)
    export_file = Path(config.EXPORTS_DIR) / user_id / "exp-test.zip"
    backup_file = tmp_path / "backups" / "daily.tar.gz"
    assert user_dir.exists() and export_file.exists() and backup_file.exists()

    username = _username(client)
    assert _submit(client).status_code == 202
    # 申请时把会话全删了；重新登录 pending，供硬删除后旧 Cookie 断言使用。
    login = client.post(
        "/api/auth/login", json={"email": TEST_USER_EMAIL, "password": PASSWORD}
    )
    assert login.status_code == 200
    request_id = _deletion_state(client)["deletion"]["id"]

    # 权限：匿名 401、普通 pending 用户 403、管理员 200。
    with make_client() as anonymous:
        assert anonymous.get("/api/admin/deletion-requests").status_code == 401
    assert client.get("/api/admin/deletion-requests").status_code == 403
    listing = admin_client.get("/api/admin/deletion-requests")
    assert listing.status_code == 200, listing.text
    payload = listing.json()
    assert payload["total"] == 1
    row = payload["requests"][0]
    assert row["id"] == request_id
    assert row["status"] == "pending"
    assert row["userIdHash"] == hashlib.sha256(user_id.encode()).hexdigest()
    assert row["user"]["email"] == TEST_USER_EMAIL
    assert row["user"]["username"] == username
    assert row["overdue"] is False

    # 执行接口的二次确认 / 冷静期 / 原因校验。
    url = f"/api/admin/deletion-requests/{request_id}/execute"
    assert admin_client.post(url, json={"confirm": "NO", "reason": "x"}).status_code == 400
    assert admin_client.post(url, json={"confirm": "DELETE", "reason": ""}).status_code == 400
    early = admin_client.post(url, json={"confirm": "DELETE", "reason": "test"})
    assert early.status_code == 409
    assert early.json()["code"] == "deletion_not_due"
    executed = admin_client.post(
        url,
        json={
            "confirm": "DELETE",
            "reason": "用户书面要求立即删除",
            "force": True,
        },
    )
    assert executed.status_code == 200, executed.text
    result = executed.json()
    assert result["status"] == "completed"
    assert result["counts"]["users"] == 1
    assert result["counts"]["sessions"] >= 0
    assert result["counts"]["learning_events"] == 1
    assert result["counts"]["word_states"] == 1
    assert result["counts"]["word_sources"] == 1
    assert result["counts"]["articles"] == 1
    assert result["counts"]["imported_books"] == 1
    assert result["counts"]["generated_courses"] == 1
    assert result["counts"]["data_export_jobs"] == 1
    assert result["counts"]["files"] >= 2

    # 数据库：用户与所有可定位行删除；公共缓存/备份保留。
    _assert_user_rows_gone(user_id, pseudo)
    assert _fetchone("SELECT COUNT(*) FROM content_teaching_analysis")[0] == 1
    assert _fetchone("SELECT COUNT(*) FROM book_chapter_translations")[0] == 1
    assert backup_file.read_bytes() == b"backup"
    assert not user_dir.exists()
    assert not (Path(config.EXPORTS_DIR) / user_id).exists()
    assert not export_file.exists()

    # 申请完成：只保留 user_id_hash / 计数 / 操作员，不含明文 user id。
    request_row = _fetchone(
        "SELECT status, user_id_hash, operator_id, counts_json, error "
        "FROM account_deletion_requests WHERE id = ?",
        (request_id,),
    )
    assert request_row[0] == "completed"
    assert request_row[1] == hashlib.sha256(user_id.encode()).hexdigest()
    assert request_row[2] == admin_client.user_id
    counts = json.loads(request_row[3])
    assert counts["users"] == 1
    assert request_row[4] is None
    serialized = json.dumps(json.loads(request_row[3]))
    assert user_id not in serialized

    # 审计：申请与执行都有记录；target_id 不写明文 user id。
    audit_rows = _fetchall(
        "SELECT action, target_id, detail_json FROM admin_audit_log ORDER BY created_at_ms"
    )
    actions = {row[0] for row in audit_rows}
    assert "account.deletion.request" in actions
    assert "account.deletion.execute.completed" in actions
    assert all(user_id not in (row[1] or "") for row in audit_rows)
    assert all(user_id not in (row[2] or "") for row in audit_rows)
    completed_audit = [row for row in audit_rows if row[0].endswith(".completed")]
    assert completed_audit and "用户书面要求立即删除" in completed_audit[0][2]

    # 旧 Cookie 不再返回用户；旧密码 401。
    old_cookie_me = client.get("/api/auth/me")
    assert old_cookie_me.status_code == 200
    assert old_cookie_me.json()["user"] is None
    old_login = client.post(
        "/api/auth/login", json={"email": TEST_USER_EMAIL, "password": PASSWORD}
    )
    assert old_login.status_code == 401

    # 完成后管理列表不再暴露 email/username。
    after = admin_client.get("/api/admin/deletion-requests").json()["requests"][0]
    assert after["status"] == "completed"
    assert after["user"] is None
    assert TEST_USER_EMAIL not in json.dumps(after)

    audit = admin_client.get("/api/admin/audit?limit=20")
    assert audit.status_code == 200
    assert any(
        entry["action"] == "account.deletion.execute.completed"
        for entry in audit.json()["entries"]
    )
    # 被删用户的旧会话已失效（401）；非管理员权限在删除前已断言 403。
    assert client.get("/api/admin/audit").status_code == 401


def test_file_delete_failure_marks_failed_and_retry(
    migrated, admin_client, monkeypatch, tmp_path
):
    client = migrated
    user_id = client.user_id
    user_dir = Path(storage.user_data_dir(user_id))
    (user_dir / "history").mkdir(parents=True, exist_ok=True)
    (user_dir / "history" / "x.json").write_text("{}", encoding="utf-8")

    assert _submit(client).status_code == 202
    assert client.post(
        "/api/auth/login", json={"email": TEST_USER_EMAIL, "password": PASSWORD}
    ).status_code == 200
    request_id = _deletion_state(client)["deletion"]["id"]

    original = account_lifecycle._safe_delete_tree

    def _boom(*args, **kwargs):
        raise OSError("permission denied (test)")

    monkeypatch.setattr(account_lifecycle, "_safe_delete_tree", _boom)
    url = f"/api/admin/deletion-requests/{request_id}/execute"
    failed = admin_client.post(
        url, json={"confirm": "DELETE", "reason": "test failure", "force": True}
    )
    assert failed.status_code == 500, failed.text
    assert failed.json()["code"] == "deletion_failed"
    assert failed.json()["requestStatus"] == "failed"

    # 不假装成功：users 仍在、仍是 pending；申请 failed 且错误可诊断。
    assert _fetchone("SELECT status FROM users WHERE id = ?", (user_id,))[0] == "deletion_pending"
    row = _fetchone(
        "SELECT status, error FROM account_deletion_requests WHERE id = ?",
        (request_id,),
    )
    assert row[0] == "failed"
    assert "file_delete_failed" in row[1]
    # 阶段 1 已删掉会话；用户重新登录后才能看到 failed 状态。
    assert client.post(
        "/api/auth/login", json={"email": TEST_USER_EMAIL, "password": PASSWORD}
    ).status_code == 200
    state = _deletion_state(client)
    assert state["status"] == "deletion_pending"
    assert state["deletion"]["status"] == "failed"
    assert state["deletion"]["error"] == "删除处理失败，请联系支持。"

    monkeypatch.setattr(account_lifecycle, "_safe_delete_tree", original)
    retried = admin_client.post(
        url, json={"confirm": "DELETE", "reason": "retry after fixing", "force": True}
    )
    assert retried.status_code == 200, retried.text
    assert retried.json()["status"] == "completed"
    assert not user_dir.exists()
    assert _fetchone("SELECT id FROM users WHERE id = ?", (user_id,)) is None


def test_admin_existing_writes_are_audited(migrated, admin_client):
    target = migrated.user_id
    response = admin_client.post(
        f"/api/admin/users/{target}/credits",
        json={"delta": 5, "reason": "测试调额"},
    )
    assert response.status_code == 200, response.text
    audit = admin_client.get("/api/admin/audit?limit=20")
    assert audit.status_code == 200
    entries = audit.json()["entries"]
    credit = [entry for entry in entries if entry["action"] == "admin.user.credits_adjust"]
    assert credit, entries
    assert credit[0]["targetId"] == target
    assert credit[0]["detail"]["delta"] == 5


# ---------------------------------------------------------------------------
# 3. 迁移 0024
# ---------------------------------------------------------------------------

def test_migration_0024_schema_downgrade_and_reupgrade(tmp_path):
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    assert revision(db) == "0024_account_lifecycle"

    assert {
        "account_deletion_requests",
        "data_export_jobs",
        "admin_audit_log",
    } <= table_names(db)

    deletion = columns(db, "account_deletion_requests")
    assert list(deletion) == [
        "id",
        "user_id_hash",
        "requested_at_ms",
        "due_at_ms",
        "status",
        "verified_via",
        "reason",
        "operator_id",
        "completed_at_ms",
        "counts_json",
        "error",
    ]
    assert deletion["id"]["pk"] == 1
    for required in (
        "user_id_hash",
        "requested_at_ms",
        "due_at_ms",
        "status",
        "verified_via",
    ):
        assert deletion[required]["notnull"] == 1, required
    assert deletion["reason"]["notnull"] == 0
    assert deletion["error"]["notnull"] == 0
    assert {
        "ix_account_deletion_requests_user_hash",
        "ix_account_deletion_requests_status_due",
        "ux_account_deletion_requests_pending",
    } <= index_names(db, "account_deletion_requests")

    exports = columns(db, "data_export_jobs")
    assert list(exports) == [
        "id",
        "user_id",
        "status",
        "requested_at_ms",
        "completed_at_ms",
        "expires_at_ms",
        "file_path",
        "size_bytes",
        "download_token_hash",
        "downloaded_at_ms",
        "error",
    ]
    assert exports["id"]["pk"] == 1
    for required in ("user_id", "status", "requested_at_ms"):
        assert exports[required]["notnull"] == 1, required
    assert {
        "ix_data_export_jobs_user_requested",
        "ix_data_export_jobs_status_expires",
        "ux_data_export_jobs_active",
    } <= index_names(db, "data_export_jobs")

    audit = columns(db, "admin_audit_log")
    assert list(audit) == [
        "id",
        "actor_id",
        "action",
        "target_type",
        "target_id",
        "detail_json",
        "request_id",
        "created_at_ms",
    ]
    assert audit["id"]["pk"] == 1
    assert {
        "ix_admin_audit_created",
        "ix_admin_audit_actor_created",
        "ix_admin_audit_target",
    } <= index_names(db, "admin_audit_log")

    # 部分唯一索引：同一 hash 只能有一条 pending；取消后可再申请。
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO account_deletion_requests "
            "(id, user_id_hash, requested_at_ms, due_at_ms, status, verified_via) "
            "VALUES ('d1', 'hash-1', 1, 2, 'pending', 'session_password')"
        )
        try:
            conn.execute(
                "INSERT INTO account_deletion_requests "
                "(id, user_id_hash, requested_at_ms, due_at_ms, status, verified_via) "
                "VALUES ('d2', 'hash-1', 2, 3, 'pending', 'session_password')"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("同一用户不应有两条 pending 删除申请")
        conn.execute("UPDATE account_deletion_requests SET status='cancelled' WHERE id='d1'")
        conn.execute(
            "INSERT INTO account_deletion_requests "
            "(id, user_id_hash, requested_at_ms, due_at_ms, status, verified_via) "
            "VALUES ('d2', 'hash-1', 2, 3, 'pending', 'session_password')"
        )
        try:
            conn.execute(
                "UPDATE account_deletion_requests SET status='bogus' WHERE id='d2'"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("status CHECK 应拒绝未知删除状态")
        conn.rollback()

    # 导出 active 部分唯一索引：同一用户最多一个 queued/running。
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO data_export_jobs "
            "(id, user_id, status, requested_at_ms, expires_at_ms) "
            "VALUES ('e1', 'u1', 'queued', 1, 2)"
        )
        try:
            conn.execute(
                "INSERT INTO data_export_jobs "
                "(id, user_id, status, requested_at_ms, expires_at_ms) "
                "VALUES ('e2', 'u1', 'running', 2, 3)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("同一用户不应有两个进行中的导出任务")
        conn.execute("UPDATE data_export_jobs SET status='ready' WHERE id='e1'")
        conn.execute(
            "INSERT INTO data_export_jobs "
            "(id, user_id, status, requested_at_ms, expires_at_ms) "
            "VALUES ('e2', 'u1', 'queued', 3, 4)"
        )
        try:
            conn.execute(
                "UPDATE data_export_jobs SET status='bogus' WHERE id='e1'"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("status CHECK 应拒绝未知导出状态")
        conn.rollback()

    # 旧库（含 users）升级后数据不丢；downgrade 只删三张新表。
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO users (id, email, password_hash, created_at, username, "
            "credits, status) VALUES ('legacy', 'legacy@example.com', 'x', 1, "
            "'legacy', 0, 'active')"
        )
        conn.commit()
    assert_alembic_ok(run_alembic(db, "downgrade", "-1"), "downgrade -1")
    remaining = table_names(db)
    assert not {
        "account_deletion_requests",
        "data_export_jobs",
        "admin_audit_log",
    } & remaining
    assert {"users", "sessions", "invite_codes"} <= remaining
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT email FROM users WHERE id='legacy'").fetchone()[0] == (
            "legacy@example.com"
        )
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "re-upgrade head")
    assert revision(db) == "0024_account_lifecycle"
    assert {"account_deletion_requests", "data_export_jobs", "admin_audit_log"} <= (
        table_names(db)
    )
    # 重复 upgrade 是 no-op。
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head again")


def test_due_execution_without_force(migrated, admin_client):
    """冷静期到期后，管理员不传 force 也能执行；列表/脚本口径一致。"""
    client = migrated
    assert _submit(client).status_code == 202
    assert client.post(
        "/api/auth/login", json={"email": TEST_USER_EMAIL, "password": PASSWORD}
    ).status_code == 200
    request_id = _deletion_state(client)["deletion"]["id"]
    now = int(time.time() * 1000)
    _exec(
        "UPDATE account_deletion_requests SET requested_at_ms = ?, due_at_ms = ? "
        "WHERE id = ?",
        (now - 8 * 24 * 3600 * 1000, now - 1000, request_id),
    )
    due = account_lifecycle.list_due_deletions()
    assert [item["id"] for item in due] == [request_id]

    response = admin_client.post(
        f"/api/admin/deletion-requests/{request_id}/execute",
        json={"confirm": "DELETE", "reason": "冷静期到期执行"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "completed"
    assert _fetchone("SELECT id FROM users WHERE id = ?", (client.user_id,)) is None
