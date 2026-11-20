"""M2a 数据导出 ZIP / 限流 / token / 过期 / 路径安全的离线验收（specs/033）。

所有生成都在 tmp 下的 ``EXPORTS_DIR``；ZIP 只在内存里读，不落仓库 data/。
"""
from __future__ import annotations

import hashlib
import io
import json
import sqlite3
import stat
import time
import zipfile
from pathlib import Path

import pytest

import account_export
import account_lifecycle
import config
import storage
from tests.conftest import (
    SECOND_USER_EMAIL,
    SECOND_USER_PASSWORD,
    TEST_USER_EMAIL,
    TEST_USER_PASSWORD,
)
from tests.migration_utils import assert_alembic_ok, run_alembic

PASSWORD = TEST_USER_PASSWORD
OTHER_PASSWORD = SECOND_USER_PASSWORD


@pytest.fixture()
def migrated(client):
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (export)"
    )
    return client


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


def _username(client) -> str:
    return client.get("/api/auth/me").json()["user"]["username"]


def _seed_export_data(user_id: str) -> dict:
    now = int(time.time() * 1000)
    _exec(
        "INSERT INTO ai_usage (user_id, feature, model_id, input_tokens, "
        "output_tokens, calls, est_cost_usd, occurred_at, created_at, usage_date) "
        "VALUES (?, 'translate', 'deepseek-chat', 10, 20, 2, 0.02, ?, ?, '2026-11-20')",
        (user_id, now, now),
    )
    _exec(
        "INSERT INTO ai_quota (user_id, day, feature, used_units, limit_units) "
        "VALUES (?, '2026-11-20', 'translate', 2, 60)",
        (user_id,),
    )
    _exec(
        "INSERT INTO word_states (id, user_id, lemma, target_lang, state, due_at, "
        "created_at) VALUES ('ws-export', ?, 'apple', 'zh-CN', 'new', ?, ?)",
        (user_id, now, now),
    )
    _exec(
        "INSERT INTO review_logs (id, user_id, lemma, target_lang, rating, "
        "state_before, state_after, reviewed_at) VALUES (1, ?, 'apple', 'zh-CN', "
        "'good', 'new', 'review', ?)",
        (user_id, now),
    )
    _exec(
        "INSERT INTO watch_events (user_id, content_ref, kind, target_lang, "
        "watched_seconds, position_seconds, occurred_at, client_event_id) "
        "VALUES (?, 'video-export', 'video', 'zh-CN', 120, 30, ?, 'export-1')",
        (user_id, now),
    )
    _exec(
        "INSERT INTO credit_transactions (id, user_id, delta, reason, created_at) "
        "VALUES ('ct-export', ?, 5, 'seed', ?)",
        (user_id, now),
    )
    _exec(
        "INSERT INTO imported_books (id, user_id, source_type, source_url, "
        "external_id, title, chapters_json, created_at, updated_at) "
        "VALUES ('epub-0123456789abcdef0123456789abcdef', ?, 'local_epub', '', "
        "'sha', 'Exported Book', '{\"chapters\": []}', ?, ?)",
        (user_id, now, now),
    )
    _exec(
        "INSERT INTO imported_book_translations (book_id, chapter_index, lang, "
        "paragraphs_json, created_at) "
        "VALUES ('epub-0123456789abcdef0123456789abcdef', 0, 'zh-CN', '[]', ?)",
        (now,),
    )
    _exec(
        "INSERT INTO generated_courses (id, owner_user_id, source_kind, source_ref, "
        "content_hash, level, target_lang, prompt_version, title, lesson_json, "
        "status, created_at) VALUES ('gen-export', ?, 'youtube', 'video-export', "
        "'hash', 'orbit', 'zh-CN', 'course-gen.v1', 'Lesson', '{}', 'ready', ?)",
        (user_id, now),
    )
    _exec(
        "INSERT INTO articles (id, user_id, title, lang, word_count, created_at) "
        "VALUES ('art-export', ?, 'Article', 'en', 12, ?)",
        (user_id, now),
    )
    _exec(
        "INSERT INTO article_paragraphs (article_id, idx, text) "
        "VALUES ('art-export', 0, 'Hello export')"
    )
    _exec(
        "INSERT INTO article_translations (article_id, idx, target_lang, text, "
        "created_at) VALUES ('art-export', 0, 'zh-CN', '你好导出', ?)",
        (now,),
    )
    _exec(
        "INSERT INTO article_progress (user_id, article_id, paragraph_idx, updated_at) "
        "VALUES (?, 'art-export', 0, ?)",
        (user_id, now),
    )

    # 公共缓存：绝不能进导出（也不应被删除）。
    _exec(
        "INSERT INTO content_teaching_analysis (id, content_ref, content_hash, "
        "level, target_lang, payload_json, created_at) "
        "VALUES ('cta-export', 'public-ref', 'public-hash', 'orbit', 'zh-CN', "
        "'{\"marker\":\"PUBLIC-CACHE-MARKER\"}', ?)",
        (now,),
    )
    _exec(
        "INSERT INTO book_chapter_translations (book_id, chapter_no, target_lang, "
        "paragraphs_json, created_at, updated_at) "
        "VALUES ('public-book-export', 1, 'zh-CN', "
        "'[\"PUBLIC-BOOK-MARKER\"]', ?, ?)",
        (now, now),
    )

    user_dir = Path(storage.user_data_dir(user_id))
    (user_dir / "history").mkdir(parents=True, exist_ok=True)
    (user_dir / "history" / "video-export.json").write_text(
        '{"videoId":"video-export","marker":"HISTORY-MARKER"}', encoding="utf-8"
    )
    (user_dir / "favorites.json").write_text(
        '[{"id":"fav-1","word":"apple"}]', encoding="utf-8"
    )
    (user_dir / "subscriptions.json").write_text(
        '{"channels":["channel-1"]}', encoding="utf-8"
    )
    book_dir = (
        Path(storage.user_books_dir(user_id))
        / "epub-0123456789abcdef0123456789abcdef"
    )
    (book_dir / "chapters").mkdir(parents=True, exist_ok=True)
    (book_dir / "meta.json").write_text('{"title":"Exported Book"}', encoding="utf-8")
    (book_dir / "chapters" / "0001.json").write_text(
        '{"title":"Chapter 1","paragraphs":["Hello"]}', encoding="utf-8"
    )
    (book_dir / "cover.jpg").write_bytes(b"\xff\xd8\xff-book-cover")
    return {"now": now, "user_dir": user_dir, "book_dir": book_dir}


def _create(client, password: str = PASSWORD):
    return client.post("/api/account/export", json={"password": password})


def _wait(client, job_id: str) -> dict:
    job = account_export.wait_for_export(job_id, timeout=15)
    assert job is not None
    return job


def _download(client, job_id: str, token: str | None):
    params = {} if token is None else {"token": token}
    return client.get(f"/api/account/export/{job_id}", params=params)


def _zip_payload(content: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        assert archive.testzip() is None
        return {name: archive.read(name) for name in archive.namelist()}


# ---------------------------------------------------------------------------
# 1. 生成 + 下载 + manifest + 排除项
# ---------------------------------------------------------------------------

def test_export_zip_manifest_contents_and_exclusions(migrated, make_client):
    client = migrated
    user_id = client.user_id
    seed = _seed_export_data(user_id)
    session_token = client.cookies.get("ln_session")
    assert session_token
    password_hash = _fetchone(
        "SELECT password_hash FROM users WHERE id = ?", (user_id,)
    )[0]

    # 另造一个用户与数据，确认不会混入。
    with make_client() as other_client:
        signup = other_client.post(
            "/api/auth/signup",
            json={"email": SECOND_USER_EMAIL, "password": OTHER_PASSWORD},
        )
        assert signup.status_code == 201
        other_id = signup.json()["user"]["id"]
        _exec(
            "INSERT INTO ai_usage (user_id, feature, model_id, calls, "
            "est_cost_usd, occurred_at, created_at, usage_date) "
            "VALUES (?, 'translate', 'deepseek-chat', 9, 9.9, 1, 1, '2026-11-20')",
            (other_id,),
        )

    wrong = _create(client, "wrong-password")
    assert wrong.status_code == 401
    assert wrong.json()["code"] == "password_invalid"
    assert client.get("/api/account/exports").json()["jobs"] == []

    created = _create(client)
    assert created.status_code == 202, created.text
    body = created.json()
    job_id = body["jobId"]
    token = body["downloadToken"]
    assert body["status"] == "queued"
    assert body["limits"]["per24h"] == 1
    assert body["limits"]["per30d"] == 3
    assert body["limits"]["ttlHours"] == 24
    assert body["expiresAt"] > seed["now"]
    assert token not in json.dumps(
        _fetchone(
            "SELECT download_token_hash FROM data_export_jobs WHERE id = ?", (job_id,)
        )
    )
    stored = _fetchone(
        "SELECT download_token_hash FROM data_export_jobs WHERE id = ?", (job_id,)
    )[0]
    assert stored == hashlib.sha256(token.encode()).hexdigest()
    assert stored != token

    job = _wait(client, job_id)
    assert job["status"] == "ready", job
    listing = client.get("/api/account/exports")
    assert listing.status_code == 200
    item = listing.json()["jobs"][0]
    assert item["id"] == job_id
    assert item["status"] == "ready"
    assert item["downloadable"] is True
    serialized = json.dumps(listing.json())
    assert token not in serialized
    assert stored not in serialized
    assert "filePath" not in serialized
    assert "downloadToken" not in serialized

    path = _fetchone(
        "SELECT file_path FROM data_export_jobs WHERE id = ?", (job_id,)
    )[0]
    absolute = Path(config.EXPORTS_DIR) / path
    assert absolute.is_file()
    assert stat.S_IMODE(absolute.stat().st_mode) == 0o600

    downloaded = _download(client, job_id, token)
    assert downloaded.status_code == 200, downloaded.text
    assert downloaded.headers["content-type"].startswith("application/zip")
    assert "attachment" in downloaded.headers.get("content-disposition", "")
    entries = _zip_payload(downloaded.content)

    assert "manifest.json" in entries
    assert "README.md" in entries
    assert "data/profile.json" in entries
    assert "data/billing.json" in entries
    assert "data/ai-usage.json" in entries
    assert "data/learning/favorites.json" in entries
    assert "data/learning/subscriptions.json" in entries
    assert "data/learning/history/video-export.json" in entries
    assert "data/books.json" in entries
    assert "data/reading.json" in entries
    assert "data/courses.json" in entries
    assert (
        "files/books/epub-0123456789abcdef0123456789abcdef/chapters/0001.json"
        in entries
    )
    assert (
        "files/books/epub-0123456789abcdef0123456789abcdef/cover.jpg" in entries
    )

    manifest = json.loads(entries["manifest.json"])
    assert manifest["formatVersion"] == "linguatrek.export.v1"
    assert manifest["userIdHash"] == hashlib.sha256(user_id.encode()).hexdigest()
    assert manifest["scope"]["ai_usage"] == 1
    assert manifest["scope"]["watch_events"] == 1
    assert manifest["scope"]["imported_books"] == 1
    assert "30 天" in manifest["notice"]
    listed = {entry["path"]: entry for entry in manifest["files"]}
    assert "manifest.json" not in listed
    assert "README.md" in listed
    for name, meta in listed.items():
        assert name in entries, name
        data = entries[name]
        assert meta["bytes"] == len(data)
        assert meta["sha256"] == hashlib.sha256(data).hexdigest()

    profile = json.loads(entries["data/profile.json"])
    assert profile["id"] == user_id
    assert profile["email"] == TEST_USER_EMAIL
    assert "password_hash" not in profile
    assert "creditsLegacy" in profile
    usage = json.loads(entries["data/ai-usage.json"])
    assert usage["usage"][0]["calls"] == 2
    # 明细行没有 prompt 字段；note 里出现「不含 prompt」是说明文字，允许。
    assert all("prompt" not in row for row in usage["usage"])
    assert "prompt" not in usage["usage"][0]
    assert json.loads(entries["data/learning/favorites.json"])[0]["word"] == "apple"

    # 所有内容解压后统一检查：敏感/他人/公共缓存绝不出现。
    text = b"\n".join(entries.values()).decode("utf-8", errors="replace")
    assert password_hash not in text
    assert session_token not in text
    assert token not in text
    assert stored not in text
    assert SECOND_USER_EMAIL not in text
    assert "OTHER-USER-MARKER" not in text
    assert "PUBLIC-CACHE-MARKER" not in text
    assert "PUBLIC-BOOK-MARKER" not in text
    assert "30 天" in entries["README.md"].decode("utf-8")
    for name in entries:
        assert not name.startswith("/")
        assert ".." not in name.split("/")

    # 下载后标记 downloadedAt。
    listed_after = client.get("/api/account/exports").json()["jobs"][0]
    assert listed_after["downloadedAt"] is not None

    # token 错/缺失 → 403。
    assert _download(client, job_id, "wrong-token").status_code == 403
    assert _download(client, job_id, None).status_code == 403

    # 24 小时内第二次 → 429 + Retry-After。
    limited = _create(client)
    assert limited.status_code == 429
    assert limited.json()["code"] == "export_rate_limited"
    assert int(limited.headers["retry-after"]) > 0


# ---------------------------------------------------------------------------
# 2. busy / 删除 / 过期 / 失败 / 配额窗口
# ---------------------------------------------------------------------------

def test_export_busy_delete_and_expiry(migrated):
    client = migrated
    _seed_export_data(client.user_id)
    # 直接插一个 queued 任务，确定性地测 busy（不依赖生成线程快慢）。
    _exec(
        "INSERT INTO data_export_jobs (id, user_id, status, requested_at_ms, "
        "expires_at_ms) VALUES ('exp-busy', ?, 'queued', ?, ?)",
        (
            client.user_id,
            int(time.time() * 1000),
            int(time.time() * 1000) + 3600_000,
        ),
    )
    busy = _create(client)
    assert busy.status_code == 409
    assert busy.json()["code"] == "export_busy"
    assert client.delete("/api/account/export/exp-busy").status_code == 409
    _exec("DELETE FROM data_export_jobs WHERE id = 'exp-busy'")

    created = _create(client)
    assert created.status_code == 202
    job_id = created.json()["jobId"]
    token = created.json()["downloadToken"]
    job = _wait(client, job_id)
    assert job["status"] == "ready"
    assert _download(client, job_id, token).status_code == 200

    deleted = client.delete(f"/api/account/export/{job_id}")
    assert deleted.status_code == 200
    assert deleted.json()["status"] == "expired"
    listed = client.get("/api/account/exports").json()["jobs"][0]
    assert listed["status"] == "expired"
    assert listed["downloadable"] is False
    assert _download(client, job_id, token).status_code == 410
    # 幂等删除。
    assert client.delete(f"/api/account/export/{job_id}").status_code == 200


def test_export_expiry_cleanup(migrated):
    client = migrated
    _seed_export_data(client.user_id)
    created = _create(client)
    assert created.status_code == 202
    job_id = created.json()["jobId"]
    token = created.json()["downloadToken"]
    assert _wait(client, job_id)["status"] == "ready"
    file_path = _fetchone(
        "SELECT file_path FROM data_export_jobs WHERE id = ?", (job_id,)
    )[0]
    absolute = Path(config.EXPORTS_DIR) / file_path
    assert absolute.exists()

    _exec(
        "UPDATE data_export_jobs SET requested_at_ms = ?, expires_at_ms = ? "
        "WHERE id = ?",
        (int(time.time() * 1000) - 2000, int(time.time() * 1000) - 1000, job_id),
    )
    cleanup = account_export.cleanup_exports()
    assert cleanup["expired"] == 1
    assert not absolute.exists()
    row = _fetchone(
        "SELECT status, file_path FROM data_export_jobs WHERE id = ?", (job_id,)
    )
    assert row[0] == "expired"
    assert row[1] is None
    assert _download(client, job_id, token).status_code == 410
    assert client.get("/api/account/exports").json()["jobs"][0]["status"] == "expired"


def test_export_size_limit_marks_failed(migrated, monkeypatch):
    client = migrated
    user_dir = Path(storage.user_data_dir(client.user_id))
    (user_dir / "history").mkdir(parents=True, exist_ok=True)
    (user_dir / "history" / "big.json").write_text(
        json.dumps({"x": "a" * 5000}), encoding="utf-8"
    )
    monkeypatch.setattr(config, "EXPORT_MAX_BYTES", 1024, raising=False)
    created = _create(client)
    assert created.status_code == 202
    job_id = created.json()["jobId"]
    token = created.json()["downloadToken"]
    job = _wait(client, job_id)
    assert job["status"] == "failed", job
    assert job["error"]
    assert not (Path(config.EXPORTS_DIR) / client.user_id / f"{job_id}.zip").exists()
    listed = client.get("/api/account/exports").json()["jobs"][0]
    assert listed["status"] == "failed"
    assert listed["downloadable"] is False
    failed_download = _download(client, job_id, token)
    assert failed_download.status_code == 409
    assert failed_download.json()["code"] == "export_failed"

    # D-5 按“每次创建”计配额：失败任务也占 24h 名额（不偷偷给无限重试）。
    limited = _create(client)
    assert limited.status_code == 429
    assert limited.json()["window"] == "24h"


def test_export_30d_quota_counts_failed_jobs(migrated):
    client = migrated
    user_id = client.user_id
    now = int(time.time() * 1000)
    two_days_ago = now - 2 * 24 * 3600 * 1000
    for index in range(2):
        _exec(
            "INSERT INTO data_export_jobs (id, user_id, status, requested_at_ms, "
            "completed_at_ms, expires_at_ms) VALUES (?, ?, 'ready', ?, ?, ?)",
            (f"exp-old-{index}", user_id, two_days_ago + index, two_days_ago, now + 3600_000),
        )
    _exec(
        "INSERT INTO data_export_jobs (id, user_id, status, requested_at_ms, "
        "completed_at_ms, expires_at_ms) VALUES ('exp-recent', ?, 'ready', ?, ?, ?)",
        (user_id, now - 2 * 3600 * 1000, now, now + 3600_000),
    )
    # 24h 窗口已用 1 次 → 先报 24h。
    limited_24h = _create(client)
    assert limited_24h.status_code == 429
    assert limited_24h.json()["window"] == "24h"

    # 把这 3 条都挪到 24h 之外，30 天窗口达到 3 次 → 报 30d。
    for index in range(2):
        _exec(
            "UPDATE data_export_jobs SET requested_at_ms = ? WHERE id = ?",
            (two_days_ago + index, f"exp-old-{index}"),
        )
    _exec(
        "UPDATE data_export_jobs SET requested_at_ms = ? WHERE id = 'exp-recent'",
        (two_days_ago + 10,),
    )
    limited_30d = _create(client)
    assert limited_30d.status_code == 429
    assert limited_30d.json()["window"] == "30d"

    # 只留一条 failed 也必须占 24h 名额：不允许靠失败任务绕过限流。
    _exec("DELETE FROM data_export_jobs WHERE user_id = ?", (user_id,))
    _exec(
        "INSERT INTO data_export_jobs (id, user_id, status, requested_at_ms, "
        "completed_at_ms, error) VALUES ('exp-failed', ?, 'failed', ?, ?, 'boom')",
        (user_id, now - 1000, now - 500),
    )
    limited = _create(client)
    assert limited.status_code == 429
    assert limited.json()["window"] == "24h"


# ---------------------------------------------------------------------------
# 3. pending 期间可导出 / 密码限流 / 路径安全 / 越权
# ---------------------------------------------------------------------------

def test_export_allowed_during_deletion_pending(migrated):
    client = migrated
    _seed_export_data(client.user_id)
    username = _username(client)
    request = client.post(
        "/api/account/deletion",
        json={"password": PASSWORD, "username": username, "confirm": "DELETE"},
    )
    assert request.status_code == 202
    login = client.post(
        "/api/auth/login", json={"email": TEST_USER_EMAIL, "password": PASSWORD}
    )
    assert login.status_code == 200
    created = _create(client)
    assert created.status_code == 202, created.text
    job = _wait(client, created.json()["jobId"])
    assert job["status"] == "ready"
    assert _download(client, job["id"], created.json()["downloadToken"]).status_code == 200


def test_export_password_failure_throttle(migrated):
    client = migrated
    for index in range(account_lifecycle.PASSWORD_MAX_FAILURES):
        response = _create(client, "wrong-password")
        assert response.status_code == 401, (index, response.text)
    limited = _create(client)
    assert limited.status_code == 429
    assert limited.json()["code"] == "password_rate_limited"
    assert int(limited.headers["retry-after"]) > 0

    account_lifecycle.reset_password_throttle()
    account_export.reset_export_state()
    ok = _create(client)
    assert ok.status_code == 202, ok.text
    assert _wait(client, ok.json()["jobId"])["status"] == "ready"


def test_export_path_safety_and_owner_isolation(migrated, make_client, tmp_path):
    # ZIP 条目 / 导出路径的越界防护。
    for bad in ("../evil", "/abs", "a/../../b", "", ".", "a/.."):
        with pytest.raises(ValueError):
            account_export._safe_arcname(bad)
    assert account_export._safe_arcname("data/ok.json") == "data/ok.json"
    for bad in ("../outside.zip", "/tmp/outside.zip", "", "."):
        with pytest.raises(ValueError):
            account_lifecycle.safe_export_path(bad)

    client = migrated
    user_id = client.user_id
    created = _create(client)
    assert created.status_code == 202
    job_id = created.json()["jobId"]
    token = created.json()["downloadToken"]
    assert _wait(client, job_id)["status"] == "ready"

    with make_client() as other_client:
        signup = other_client.post(
            "/api/auth/signup",
            json={"email": SECOND_USER_EMAIL, "password": OTHER_PASSWORD},
        )
        assert signup.status_code == 201
        # 别人的会话看不到/下不了/删不了我的导出。
        assert other_client.get("/api/account/exports").json()["jobs"] == []
        assert _download(other_client, job_id, token).status_code == 404
        assert other_client.delete(f"/api/account/export/{job_id}").status_code == 404

    # 数据库里被篡改成越界路径时，下载拒绝并标过期，不读/不删外部文件。
    outside = tmp_path / "outside.zip"
    outside.write_bytes(b"PK-outside")
    _exec(
        "UPDATE data_export_jobs SET file_path = ? WHERE id = ?",
        ("../outside.zip", job_id),
    )
    blocked = _download(client, job_id, token)
    assert blocked.status_code == 410
    assert outside.exists()


def test_export_not_ready_status(migrated):
    client = migrated
    token = "token-not-ready"
    _exec(
        "INSERT INTO data_export_jobs (id, user_id, status, requested_at_ms, "
        "expires_at_ms, download_token_hash, file_path) "
        "VALUES ('exp-queued', ?, 'queued', ?, ?, ?, ?)",
        (
            client.user_id,
            int(time.time() * 1000),
            int(time.time() * 1000) + 3600_000,
            hashlib.sha256(token.encode()).hexdigest(),
            f"{client.user_id}/exp-queued.zip",
        ),
    )
    response = _download(client, "exp-queued", token)
    assert response.status_code == 409
    assert response.json()["code"] == "export_not_ready"


def test_export_requires_migration(client):
    # 还没升级的旧库：导出/删除端点 503，而不是 500。
    response = client.post("/api/account/export", json={"password": PASSWORD})
    assert response.status_code == 503
    assert response.json()["code"] == "lifecycle_unavailable"
    assert client.get("/api/account/deletion").status_code == 503
