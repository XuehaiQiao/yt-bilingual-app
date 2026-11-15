"""后台止血台（Admin MVP）的离线验收（用户需求 #12 / specs/021-admin）。

覆盖：

1. 身份：`/api/auth/me` 的 `isAdmin` 真/假，游客响应不变；未登录 401、普通
   用户 403、管理员四个端点 200；
2. stats 聚合：用户总数/近 7 天新增/今日活跃/游客目录数、AI 今日与本月花费/
   今日功能调用、jobs failed/running/待重试；
3. 用户列表：搜索大小写不敏感、分页（limit/offset/total/hasMore）、id 前 8 位、
   本月花费/事件数/最后活跃；
4. 用量：按天 × 功能聚合、时间窗裁剪、days 边界；
5. 健康：/healthz 聚合、data/ 磁盘占用、最近 10 条 failed jobs；
6. 限速：管理员桶 30 次/分钟，第 31 次 429 + Retry-After。

全部离线：数据在 tmp_path，Alembic 用子进程跑；不联网、不碰真实 data/。
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

import auth_db
import config
import events
import jobs
from ai import ledger
from tests.conftest import TEST_USER_EMAIL
from tests.migration_utils import assert_alembic_ok, run_alembic

OTHER_EMAIL = "other-user@example.com"
OTHER_PASSWORD = "other-password-123"
TZ = ZoneInfo("Asia/Shanghai")


# ---------------------------------------------------------------------------
# 夹具 / 造数
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _fixed_quota_tz(monkeypatch):
    monkeypatch.setattr(config, "AI_QUOTA_TIMEZONE", "Asia/Shanghai", raising=False)


@pytest.fixture()
def admin_client(client, monkeypatch):
    """默认 client 的邮箱被设为管理员；返回同一 TestClient。"""
    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({TEST_USER_EMAIL}), raising=False
    )
    return client


@pytest.fixture()
def other_client(make_client, admin_client):
    """普通（非管理员）登录用户；admin 夹具只影响默认 client 的邮箱。"""
    with make_client() as client:
        response = client.post(
            "/api/auth/signup",
            json={"email": OTHER_EMAIL, "password": OTHER_PASSWORD},
        )
        assert response.status_code == 201, response.text
        yield client


@pytest.fixture()
def migrated(admin_client, other_client):
    """临时库迁移到 head；顺带保证普通用户（OTHER_EMAIL）已注册。

    ``other_client`` 只用于造一个「非管理员」用户与归属数据；测试仍从
    ``admin_client`` 发管理请求。
    """
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (admin)"
    )
    return admin_client


def _local_noon_ms(days_ago: int = 0) -> int:
    """当地中午的毫秒时间戳；中午远离日界，测试不受跨日抖动影响。"""
    moment = datetime.now(TZ) - timedelta(days=days_ago)
    return int(
        moment.replace(hour=12, minute=0, second=0, microsecond=0).timestamp() * 1000
    )


def _current_month_first() -> datetime:
    return datetime.now(TZ).replace(
        day=1, hour=12, minute=0, second=0, microsecond=0
    )


def _exec(sql: str, params: tuple = ()) -> None:
    """直接写测试库（只用于造数；admin 端点本身只读）。"""
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def _insert_attempt(user_id: str, answered_at: int) -> None:
    # 只统计 user_id/answered_at；question_id 的外键在默认连接（foreign_keys
    # 未开启）下不校验，这里不需要造完整的 content_items/questions。
    _exec(
        "INSERT INTO attempts (user_id, question_id, chosen_index, is_correct, "
        "answered_at) VALUES (?, 'q-admin-test', 0, 1, ?)",
        (user_id, answered_at),
    )


def _create_job(user_id: str, ref: str) -> dict:
    job = jobs.create_or_reuse(
        user_id=user_id,
        kind=jobs.KIND_PROCESS_VIDEO,
        content_ref=ref,
        target_lang="zh-CN",
    )
    assert job is not None, "测试库已迁移，创建 job 不应失败"
    return job


def _seed_stats_data(admin_user_id: str, other_user_id: str) -> dict:
    """造一份可精确断言的 stats 数据；返回关键时间戳。"""
    now = _local_noon_ms()
    yesterday = _local_noon_ms(1)
    old = int((_current_month_first() - timedelta(days=10)).timestamp() * 1000)

    # 今日活跃：admin 有 learning_event，other 有 attempt；昨天的事件不算今天。
    events.emit_event(
        "video_open", user_id=admin_user_id, occurred_at=now, content_ref="v1"
    )
    events.emit_event(
        "video_open", user_id=other_user_id, occurred_at=yesterday, content_ref="v2"
    )
    _insert_attempt(other_user_id, now)

    # AI 花费：今日 2.80 + 0.30；本月；上月的 9.90 不计入本月。
    ledger.record_usage(
        admin_user_id,
        "translate",
        "gemini-2.5-flash",
        1_000_000,
        1_000_000,
        occurred_at=now,
    )
    ledger.record_usage(
        other_user_id, "define", "gemini-2.5-flash", 1_000_000, 0, occurred_at=now
    )
    ledger.record_usage(
        admin_user_id,
        "translate",
        "gemini-2.5-flash",
        1_000_000,
        0,
        occurred_at=old,
    )

    # jobs：1 failed + 1 running + 1 queued + 1 partial = 待重试 2。
    failed = _create_job(admin_user_id, "admin-failed")
    jobs.mark_failed(failed["id"], "provider 429")
    running = _create_job(admin_user_id, "admin-running")
    jobs.mark_running(running["id"], total=10)
    _create_job(other_user_id, "other-queued")
    partial = _create_job(other_user_id, "other-partial")
    jobs.update_progress(partial["id"], cursor=5, status=jobs.STATUS_PARTIAL)

    # 游客目录：一个合法 + 一个非法形状，只数合法目录。
    guests_root = Path(config.GUEST_DATA_DIR)
    (guests_root / ("a" * 64)).mkdir(parents=True, exist_ok=True)
    (guests_root / "not-a-guest").mkdir(parents=True, exist_ok=True)

    return {"now": now, "yesterday": yesterday, "old": old}


# ---------------------------------------------------------------------------
# 身份 / 权限
# ---------------------------------------------------------------------------

def test_me_reports_is_admin_flag(admin_client, other_client):
    me = admin_client.get("/api/auth/me")
    assert me.status_code == 200
    body = me.json()
    assert body["isAdmin"] is True
    # 冻结契约：user 对象仍然只有 id/email
    assert set(body["user"]) == {"id", "email", "username", "credits", "status"}
    assert set(body) == {"user", "isAdmin"}

    other_me = other_client.get("/api/auth/me")
    assert other_me.status_code == 200
    assert other_me.json()["isAdmin"] is False


def test_guest_me_response_is_unchanged(make_client, monkeypatch):
    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({"nobody@example.com"}), raising=False
    )
    with make_client() as anonymous:
        response = anonymous.get("/api/auth/me")
    assert response.status_code == 200
    assert response.json() == {"user": None, "guest": True}


def test_admin_endpoints_require_login_and_admin(make_client, admin_client, other_client):
    # 未登录（游客）→ 401；普通用户 → 403；管理员 → 200。
    with make_client() as anonymous:
        assert anonymous.get("/api/admin/stats").status_code == 401
        assert anonymous.get("/api/admin/users").status_code == 401
        assert anonymous.get("/api/admin/usage").status_code == 401
        assert anonymous.get("/api/admin/health").status_code == 401

    for path in ("/api/admin/stats", "/api/admin/users", "/api/admin/usage", "/api/admin/health"):
        response = other_client.get(path)
        assert response.status_code == 403, path
        assert "管理员" in response.json()["detail"]
        assert admin_client.get(path).status_code == 200, path


# ---------------------------------------------------------------------------
# stats
# ---------------------------------------------------------------------------

def test_stats_aggregates_seeded_data(migrated):
    other_id = auth_db.get_user_by_email(OTHER_EMAIL)["id"]
    seed = _seed_stats_data(migrated.user_id, other_id)

    # 再造两个用户，验证总数与近 7 天新增（不参与今日活跃）。
    auth_db.create_user("alpha1@example.com", "password-123")
    auth_db.create_user("alpha2@example.com", "password-123")

    response = migrated.get("/api/admin/stats")
    assert response.status_code == 200
    body = response.json()

    assert body["users"]["total"] == 4
    assert body["users"]["new7d"] == 4
    assert body["users"]["activeToday"] == 2
    assert body["users"]["guests"] == 1

    assert body["ai"]["todayCostUsd"] == pytest.approx(2.80 + 0.30)
    assert body["ai"]["monthCostUsd"] == pytest.approx(2.80 + 0.30)
    assert body["ai"]["todayCalls"] == 2
    assert set(body["ai"]["todayByFeature"]) == {"translate", "define"}
    translate = body["ai"]["todayByFeature"]["translate"]
    assert translate["calls"] == 1
    assert translate["inputTokens"] == 1_000_000
    assert translate["outputTokens"] == 1_000_000
    assert translate["costUsd"] == pytest.approx(2.80)

    assert body["jobs"] == {"failed": 1, "running": 1, "pendingRetry": 2}
    assert body["generatedAt"].endswith("Z")
    assert seed["now"] > 0

    # 同一份造数也能从用量端点读到（days=1 只含今天）。
    assert migrated.get("/api/admin/usage?days=1").status_code == 200


def test_stats_before_migrations_degrades_safely(admin_client):
    """只跑 auth_db 兼容建表（没有 ai_usage/jobs/events）时仍返回 200。"""
    assert not Path(config.GUEST_DATA_DIR).exists(), "登录/统计不应创建游客目录"
    response = admin_client.get("/api/admin/stats")
    assert response.status_code == 200
    body = response.json()
    assert body["users"]["total"] == 1
    assert body["users"]["new7d"] == 1
    assert body["users"]["activeToday"] == 0
    assert body["ai"]["todayCostUsd"] == 0
    assert body["jobs"] == {"failed": 0, "running": 0, "pendingRetry": 0}
    assert not Path(config.GUEST_DATA_DIR).exists(), "止血台只读，不能顺手建目录"


# ---------------------------------------------------------------------------
# users
# ---------------------------------------------------------------------------

def test_users_search_and_pagination(migrated):
    other_id = auth_db.get_user_by_email(OTHER_EMAIL)["id"]
    seed = _seed_stats_data(migrated.user_id, other_id)
    alpha1 = auth_db.create_user("alpha1@example.com", "password-123")
    alpha2 = auth_db.create_user("alpha2@example.com", "password-123")

    response = migrated.get("/api/admin/users?limit=2&offset=0")
    assert response.status_code == 200
    body = response.json()
    assert body["limit"] == 2
    assert body["offset"] == 0
    assert body["total"] == 4
    assert len(body["users"]) == 2
    assert body["hasMore"] is True
    for user in body["users"]:
        assert len(user["id"]) == 8
        assert user["createdAt"] > 0

    second = migrated.get("/api/admin/users?limit=2&offset=2").json()
    assert second["hasMore"] is False
    ids = {user["id"] for user in body["users"]} | {user["id"] for user in second["users"]}
    assert ids == {
        migrated.user_id[:8],
        other_id[:8],
        alpha1["id"][:8],
        alpha2["id"][:8],
    }

    # 搜索大小写不敏感，只返回匹配的两个 alpha 用户。
    search = migrated.get("/api/admin/users?search=ALPHA").json()
    assert search["total"] == 2
    assert {user["email"] for user in search["users"]} == {
        "alpha1@example.com",
        "alpha2@example.com",
    }

    # 越界 limit/offset 夹紧而不是 422；空白搜索 = 全部。
    clamped = migrated.get("/api/admin/users?limit=999&offset=-5&search=   ").json()
    assert clamped["limit"] == 100
    assert clamped["offset"] == 0
    assert clamped["total"] == 4

    # 字段口径：admin 本月花费 2.80、事件数 1、最后活跃 = 今日事件时间。
    admin_row = migrated.get("/api/admin/users?search=test-user").json()["users"][0]
    assert admin_row["email"] == TEST_USER_EMAIL
    assert admin_row["monthCostUsd"] == pytest.approx(2.80)
    assert admin_row["eventCount"] == 1
    assert admin_row["lastActiveAt"] == seed["now"]


# ---------------------------------------------------------------------------
# usage
# ---------------------------------------------------------------------------

def test_usage_daily_feature_aggregation(migrated):
    other_id = auth_db.get_user_by_email(OTHER_EMAIL)["id"]
    today = _local_noon_ms()
    yesterday = _local_noon_ms(1)
    ten_days_ago = _local_noon_ms(10)

    ledger.record_usage(
        migrated.user_id, "translate", "gemini-2.5-flash", 1_000_000, 0, occurred_at=today
    )
    ledger.record_usage(
        other_id, "define", "gemini-2.5-flash", 1_000_000, 0, occurred_at=today
    )
    ledger.record_usage(
        migrated.user_id, "summary", "gemini-2.5-flash", 1_000_000, 0, occurred_at=yesterday
    )
    ledger.record_usage(
        migrated.user_id, "translate", "gemini-2.5-flash", 1_000_000, 0, occurred_at=ten_days_ago
    )

    body = migrated.get("/api/admin/usage?days=7").json()
    assert body["days"] == 7
    assert body["start"] == (datetime.now(TZ) - timedelta(days=6)).strftime("%Y-%m-%d")
    assert body["end"] == datetime.now(TZ).strftime("%Y-%m-%d")
    # 10 天前的一条在窗口外，不应出现。
    assert len(body["rows"]) == 3
    assert {row["feature"] for row in body["rows"]} == {"translate", "define", "summary"}
    assert body["totals"]["calls"] == 3
    assert body["totals"]["costUsd"] == pytest.approx(0.90)
    assert len(body["daysSummary"]) == 2
    assert body["daysSummary"][0]["day"] <= body["daysSummary"][1]["day"]

    one = migrated.get("/api/admin/usage?days=1").json()
    assert one["days"] == 1
    assert one["start"] == one["end"]
    assert len(one["rows"]) == 2
    assert one["totals"]["calls"] == 2

    # days 夹在 1..90
    assert migrated.get("/api/admin/usage?days=0").json()["days"] == 1
    assert migrated.get("/api/admin/usage?days=999").json()["days"] == 90

    # 旧库未迁移时返回空表而不是 500
    assert body["rows"][0]["day"] >= body["start"]


# ---------------------------------------------------------------------------
# health
# ---------------------------------------------------------------------------

def test_health_aggregates_snapshot_disk_and_failed_jobs(migrated):
    blob = Path(config.DATA_DIR) / "admin-size.bin"
    blob.parent.mkdir(parents=True, exist_ok=True)
    blob.write_bytes(b"x" * 123)

    created: list[tuple[str, str]] = []
    for index in range(12):
        job = _create_job(migrated.user_id, f"failed-{index:02d}")
        jobs.mark_failed(job["id"], f"boom {index}")
        created.append((job["id"], f"failed-{index:02d}"))
    # 让 updated_at 单调递增，避免同一毫秒内按随机 UUID 排序导致断言抖动。
    for index, (job_id, _ref) in enumerate(created):
        _exec(
            "UPDATE jobs SET updated_at = ? WHERE id = ?",
            (2_000_000_000_000 + index, job_id),
        )

    response = migrated.get("/api/admin/health")
    assert response.status_code == 200
    body = response.json()

    assert body["health"]["status"] == "ok"
    assert body["health"]["version"] == config.APP_VERSION
    assert body["health"]["db"]["ok"] is True
    assert set(body["health"]["db"]["migrations"]) == {"current", "head"}
    assert body["health"]["db"]["migrations"]["current"] == body["health"]["db"]["migrations"]["head"]
    assert isinstance(body["health"]["uptimeSeconds"], (int, float))

    assert body["disk"]["dataDir"] == config.DATA_DIR
    assert body["disk"]["sizeBytes"] >= 123

    assert len(body["failedJobs"]) == 10
    for job in body["failedJobs"]:
        assert len(job["userId"]) == 8
        assert job["kind"] == jobs.KIND_PROCESS_VIDEO
        assert job["error"]
        assert job["updatedAt"] > 0
    # 最新失败的排前面（12 条里取最近 10 条）。
    assert body["failedJobs"][0]["contentRef"] == "failed-11"


# ---------------------------------------------------------------------------
# 限速
# ---------------------------------------------------------------------------

def test_admin_rate_limit_is_30_per_minute(admin_client):
    for _ in range(30):
        assert admin_client.get("/api/admin/stats").status_code == 200
    response = admin_client.get("/api/admin/stats")
    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) >= 1
    assert "retryAfter" in response.json()
