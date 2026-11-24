"""P2-35 翻译计时落盘（pipeline_timing）离线验收。

覆盖：

1. ``record``：字段清洗（content_ref/job_id/meta 白名单）、日桶按配额时区派生、
   未知 feature/event 丢弃、库/表缺失/任意异常都**静默返回 None**；
2. ``aggregate``：按 feature 的样本数/成功率/P50/P95/max（Python 计算）、
   feature 过滤、最近行倒序 + limit、区间为空返回空列表、表缺失抛
   ``PipelineTimingUnavailable``（管理 API 503）；
3. 管理 API：``require_admin``（401/403）、from/to/feature/limit 非法 400、
   空数据 200、正常数据形状、未迁移 503；
4. 迁移 0032：建表/索引/列清单、downgrade 只删本表、重复升降级幂等、head；
5. 接线：``routes_videos._timing_log`` / ``translate._stream_timing`` 会落一行，
   而落盘层故障不会让计时/翻译抛异常（SSE 事件序由既有用例保证）。

全部离线：临时 SQLite + ``alembic upgrade head`` 子进程；不联网、不碰真实
``data/``。
"""
from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

import book_translation
import config
import pipeline_timing
import routes_videos
import teaching_analysis
import translate
from tests.conftest import TEST_USER_EMAIL
from tests.migration_utils import (
    assert_alembic_ok,
    columns,
    index_names,
    revision,
    run_alembic,
    table_names,
)

OTHER_EMAIL = "timing-other@example.com"
OTHER_PASSWORD = "timing-other-password-123"

# 固定时钟：2026-11-20 12:00 Asia/Shanghai（日桶一定是 2026-11-20）。
FIXED_MS = int(
    datetime(2026, 11, 20, 12, 0, tzinfo=ZoneInfo("Asia/Shanghai")).timestamp() * 1000
)
FIXED_DAY = "2026-11-20"


@pytest.fixture(autouse=True)
def _fixed_timing_env(monkeypatch):
    monkeypatch.setattr(config, "AI_QUOTA_TIMEZONE", "Asia/Shanghai", raising=False)
    pipeline_timing._warned.clear()
    yield
    pipeline_timing._warned.clear()


@pytest.fixture()
def admin_client(client, monkeypatch):
    """默认 client 的邮箱设为管理员（与 test_quota_admin.py 同口径）。"""
    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({TEST_USER_EMAIL}), raising=False
    )
    return client


@pytest.fixture()
def other_client(make_client, admin_client):
    """普通（非管理员）登录用户，用于 403。"""
    with make_client() as client:
        response = client.post(
            "/api/auth/signup",
            json={"email": OTHER_EMAIL, "password": OTHER_PASSWORD},
        )
        assert response.status_code == 201, response.text
        client.user_id = response.json()["user"]["id"]
        yield client


@pytest.fixture()
def migrated(admin_client):
    """临时库迁移到 head；返回管理员客户端。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (timing)"
    )
    return admin_client


def _rows() -> list[dict]:
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        return [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM pipeline_timing ORDER BY id ASC"
            )
        ]


def _record_total(ms: float, *, ok: bool = True, feature: str = "video_translation"):
    return pipeline_timing.record(
        feature=feature,
        event="total",
        content_ref="vid123",
        job_id="job-1",
        batch_count=3,
        total_ms=ms,
        concurrency=2,
        ok=ok,
        meta={"attempts": 1, "outcome": "ok", "status": "done"},
        occurred_at_ms=FIXED_MS,
    )


# ---------------------------------------------------------------------------
# 1. record
# ---------------------------------------------------------------------------

def test_record_writes_row_with_clean_fields(migrated):
    row_id = pipeline_timing.record(
        feature="video_translation",
        event="batch",
        content_ref="vid123",
        job_id="job-1",
        batch_index=1,
        batch_count=3,
        duration_ms=12.3456,
        concurrency=2,
        ok=False,
        meta={
            "attempts": 2,
            "fallback": True,
            "outcome": "mock_fallback",
            # 以下不在白名单/类型非法：必须被丢弃，表里不能出现正文。
            "secret": "用户正文不该落盘",
            "batch_ms": [1, 2, 3],
        },
        occurred_at_ms=FIXED_MS,
    )
    assert row_id is not None
    rows = _rows()
    assert len(rows) == 1
    row = rows[0]
    assert row["feature"] == "video_translation"
    assert row["event"] == "batch"
    assert row["content_ref"] == "vid123"
    assert row["job_id"] == "job-1"
    assert row["batch_index"] == 1
    assert row["batch_count"] == 3
    assert row["duration_ms"] == 12.35
    assert row["total_ms"] is None
    assert row["concurrency"] == 2
    assert row["ok"] == 0
    assert row["day"] == FIXED_DAY
    assert row["created_at_ms"] == FIXED_MS
    assert "secret" not in (row["meta_json"] or "")
    assert "用户正文" not in (row["meta_json"] or "")
    assert "batch_ms" not in (row["meta_json"] or "")


def test_record_derives_day_from_quota_timezone(migrated):
    # UTC 2026-11-19 17:00 = 上海 2026-11-20 01:00；日桶必须跟配额时区走。
    utc_ms = int(
        datetime(2026, 11, 19, 17, 0, tzinfo=ZoneInfo("UTC")).timestamp() * 1000
    )
    pipeline_timing.record(
        feature="reading",
        event="total",
        total_ms=5.0,
        ok=True,
        occurred_at_ms=utc_ms,
    )
    assert _rows()[0]["day"] == FIXED_DAY


def test_record_drops_unknown_feature_and_event(migrated):
    assert (
        pipeline_timing.record(
            feature="not_a_feature", event="total", total_ms=1.0, ok=True
        )
        is None
    )
    assert (
        pipeline_timing.record(
            feature="reading", event="Total", total_ms=1.0, ok=True
        )
        is None
    )
    assert _rows() == []


def test_record_never_raises_when_db_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(
        config, "AUTH_DB_PATH", str(tmp_path / "missing" / "app.db"), raising=False
    )
    assert (
        pipeline_timing.record(
            feature="reading", event="total", total_ms=1.0, ok=True
        )
        is None
    )


def test_record_never_raises_when_table_missing(tmp_path, monkeypatch):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE users (id TEXT PRIMARY KEY)")
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(path), raising=False)
    assert (
        pipeline_timing.record(
            feature="reading", event="total", total_ms=1.0, ok=True
        )
        is None
    )


def test_record_never_raises_on_unexpected_error(migrated, monkeypatch):
    def _boom(*_args, **_kwargs):
        raise RuntimeError("模拟磁盘故障")

    monkeypatch.setattr(pipeline_timing, "_connect", _boom)
    assert (
        pipeline_timing.record(
            feature="reading", event="total", total_ms=1.0, ok=True
        )
        is None
    )


def test_record_cleans_unsafe_content_ref(migrated):
    pipeline_timing.record(
        feature="reading",
        event="total",
        content_ref="带 空格 的正文",
        job_id="bad/job",
        total_ms=2.0,
        ok=True,
        occurred_at_ms=FIXED_MS,
    )
    row = _rows()[0]
    assert row["content_ref"] is None
    assert row["job_id"] is None


# ---------------------------------------------------------------------------
# 2. aggregate / percentile
# ---------------------------------------------------------------------------

def test_aggregate_percentiles_ok_rate_and_recent(migrated):
    for ms, ok in ((100.0, True), (200.0, True), (300.0, False), (400.0, True)):
        _record_total(ms, ok=ok)
    # 批记录不参与 P50/P95，只计入 batchSamples / 最近行。
    pipeline_timing.record(
        feature="video_translation",
        event="batch",
        content_ref="vid123",
        batch_index=0,
        batch_count=3,
        duration_ms=50.0,
        concurrency=2,
        ok=True,
        occurred_at_ms=FIXED_MS,
    )
    # 另一功能不混进 video_translation 行。
    _record_total(999.0, feature="reading")

    data = pipeline_timing.aggregate(FIXED_DAY, FIXED_DAY, recent_limit=2)
    rows = {row["feature"]: row for row in data["rows"]}
    assert set(rows) == {"video_translation", "reading"}
    video = rows["video_translation"]
    assert video["samples"] == 4
    assert video["okSamples"] == 3
    assert video["okRate"] == 0.75
    assert video["p50Ms"] == 250.0
    assert video["p95Ms"] == 385.0
    assert video["maxMs"] == 400.0
    assert video["avgMs"] == 250.0
    assert video["batchSamples"] == 1
    assert rows["reading"]["p50Ms"] == 999.0

    # 最近行倒序（同一毫秒按 id 倒序），受 limit 限制。
    assert len(data["recent"]) == 2
    assert data["recent"][0]["id"] > data["recent"][1]["id"]
    assert data["recent"][0]["feature"] == "reading"

    filtered = pipeline_timing.aggregate(
        FIXED_DAY, FIXED_DAY, feature="video_translation"
    )
    assert [row["feature"] for row in filtered["rows"]] == ["video_translation"]
    assert all(item["feature"] == "video_translation" for item in filtered["recent"])


def test_aggregate_empty_range_returns_empty_rows(migrated):
    data = pipeline_timing.aggregate("2020-01-01", "2020-01-07")
    assert data["rows"] == []
    assert data["recent"] == []
    assert data["from"] == "2020-01-01"
    assert data["to"] == "2020-01-07"


def test_aggregate_validates_range_feature_and_limit(migrated):
    with pytest.raises(ValueError):
        pipeline_timing.aggregate("2026-11-21", "2026-11-20")
    with pytest.raises(ValueError):
        pipeline_timing.aggregate("2026/11/20", "2026-11-20")
    with pytest.raises(ValueError):
        pipeline_timing.aggregate("2026-11-20", "2026-11-20", feature="unknown")
    with pytest.raises(ValueError):
        pipeline_timing.aggregate("2026-11-20", "2026-11-20", recent_limit=0)
    with pytest.raises(ValueError):
        pipeline_timing.aggregate("2026-11-20", "2026-11-20", recent_limit=201)


def test_aggregate_raises_unavailable_without_table(tmp_path, monkeypatch):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE users (id TEXT PRIMARY KEY)")
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(path), raising=False)
    with pytest.raises(pipeline_timing.PipelineTimingUnavailable):
        pipeline_timing.aggregate(FIXED_DAY, FIXED_DAY)


def test_percentile_edge_cases():
    assert pipeline_timing.percentile([], 0.5) is None
    assert pipeline_timing.percentile([42.0], 0.95) == 42.0
    assert pipeline_timing.percentile([1.0, 2.0], 0.0) == 1.0
    assert pipeline_timing.percentile([1.0, 2.0], 1.0) == 2.0
    assert pipeline_timing.percentile([1.0, 2.0, 3.0], 0.5) == 2.0


# ---------------------------------------------------------------------------
# 3. Admin API
# ---------------------------------------------------------------------------

def test_admin_endpoint_empty_data_returns_200(migrated):
    response = migrated.get("/api/admin/pipeline-timing?from=2026-11-01&to=2026-11-30")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["rows"] == []
    assert body["recent"] == []
    assert body["from"] == "2026-11-01"
    assert body["to"] == "2026-11-30"


def test_admin_endpoint_returns_rows_and_recent(migrated):
    _record_total(120.0)
    _record_total(240.0, ok=False)
    response = migrated.get(
        "/api/admin/pipeline-timing"
        f"?from={FIXED_DAY}&to={FIXED_DAY}&feature=video_translation&limit=1"
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["rows"]) == 1
    row = body["rows"][0]
    assert row["feature"] == "video_translation"
    assert row["samples"] == 2
    assert row["okRate"] == 0.5
    assert row["p50Ms"] == 180.0
    assert row["p95Ms"] == 234.0
    assert row["maxMs"] == 240.0
    assert len(body["recent"]) == 1
    assert body["recent"][0]["jobId"] == "job-1"


def test_admin_endpoint_requires_admin(migrated, make_client):
    anonymous = make_client()
    with anonymous as client:
        assert client.get("/api/admin/pipeline-timing").status_code == 401


def test_admin_endpoint_rejects_non_admin(migrated, other_client):
    assert other_client.get("/api/admin/pipeline-timing").status_code == 403


def test_admin_endpoint_validates_params(migrated):
    cases = (
        "?from=2026-11-32&to=2026-11-20",
        "?from=2026-11-21&to=2026-11-20",
        "?from=2026-11-20&to=2026-11-20&feature=nope",
        "?from=2026-11-20&to=2026-11-20&limit=0",
        "?from=2026-11-20&to=2026-11-20&limit=201",
    )
    for query in cases:
        response = migrated.get(f"/api/admin/pipeline-timing{query}")
        assert response.status_code == 400, (query, response.text)


def test_admin_endpoint_503_when_not_migrated(admin_client):
    response = admin_client.get("/api/admin/pipeline-timing")
    assert response.status_code == 503
    assert "pipeline_timing" in response.text


# ---------------------------------------------------------------------------
# 4. 迁移 0032
# ---------------------------------------------------------------------------

def test_migration_0032_upgrade_downgrade_is_idempotent(tmp_path):
    db = tmp_path / "app.db"
    assert_alembic_ok(
        run_alembic(db, "upgrade", "0031_quota_overrides"), "upgrade 0031"
    )
    assert "pipeline_timing" not in table_names(db)
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    assert revision(db) == "0032_pipeline_timing"
    assert "pipeline_timing" in table_names(db)
    assert list(columns(db, "pipeline_timing")) == [
        "id",
        "feature",
        "event",
        "content_ref",
        "job_id",
        "batch_index",
        "batch_count",
        "duration_ms",
        "total_ms",
        "concurrency",
        "ok",
        "meta_json",
        "created_at_ms",
        "day",
    ]
    assert {
        "ix_pipeline_timing_day_feature",
        "ix_pipeline_timing_feature_day",
        "ix_pipeline_timing_created",
    } <= index_names(db, "pipeline_timing")

    # 幂等：在已建表的状态再 upgrade 一次不能报错。
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head again")

    assert_alembic_ok(
        run_alembic(db, "downgrade", "0031_quota_overrides"), "downgrade 0031"
    )
    assert revision(db) == "0031_quota_overrides"
    assert "pipeline_timing" not in table_names(db)

    # 重复 downgrade（版本已回到 0031）安全；再 upgrade 能重建。
    assert_alembic_ok(
        run_alembic(db, "downgrade", "0031_quota_overrides"), "downgrade again"
    )
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "re-upgrade head")
    assert "pipeline_timing" in table_names(db)


# ---------------------------------------------------------------------------
# 5. 接线：stdout 计时 helper 会落表，落盘故障不影响调用方
# ---------------------------------------------------------------------------

def test_video_timing_helper_records_row(migrated):
    routes_videos._timing_log(
        "video_translation",
        event="batch",
        batch=2,
        batch_count=3,
        duration_ms=12.5,
        concurrency=2,
        attempts=1,
        fallback=False,
        outcome="ok",
        content_ref="vid123",
    )
    rows = _rows()
    assert len(rows) == 1
    assert rows[0]["feature"] == "video_translation"
    assert rows[0]["event"] == "batch"
    assert rows[0]["batch_index"] == 1  # stdout 的 1 起 batch → 表里 0 起
    assert rows[0]["content_ref"] == "vid123"
    assert rows[0]["ok"] == 1


def test_stream_timing_helper_records_row(migrated):
    translate._stream_timing(
        event="total",
        batch_count=2,
        total_ms=98.5,
        first_batch_ms=40.0,
        concurrency=2,
        translated=30,
        outcome="done",
        ok=True,
        content_ref="vid123",
        job_id="job-1",
    )
    rows = _rows()
    assert len(rows) == 1
    assert rows[0]["feature"] == "sse_translate"
    assert rows[0]["job_id"] == "job-1"
    assert rows[0]["total_ms"] == 98.5
    assert rows[0]["ok"] == 1


def test_book_timing_helper_records_batches_and_total(migrated):
    book_translation._log_translation_timing(
        book_id="pride-and-prejudice",
        number=2,
        lang="zh-CN",
        status="partial",
        batch_count=2,
        concurrency=2,
        total_ms=1234.5,
        batch_timings=[
            {
                "batch": 0,
                "duration_ms": 500.0,
                "paragraphs": 8,
                "translated": 8,
                "error": None,
            },
            {
                "batch": 1,
                "duration_ms": 700.0,
                "paragraphs": 8,
                "translated": 6,
                "error": "provider timeout",
            },
        ],
        failed_paragraphs=2,
    )
    rows = _rows()
    assert [(row["event"], row["batch_index"]) for row in rows] == [
        ("batch", 0),
        ("batch", 1),
        ("total", None),
    ]
    total = rows[-1]
    assert total["feature"] == "book_translation"
    assert total["content_ref"] == "pride-and-prejudice:2"
    assert total["concurrency"] == 2
    assert total["total_ms"] == 1234.5
    assert total["ok"] == 0  # partial 不算成功样本
    assert rows[0]["duration_ms"] == 500.0
    assert rows[0]["ok"] == 1
    assert rows[1]["ok"] == 0


def test_book_timing_helper_skips_cached_runs(migrated):
    book_translation._log_translation_timing(
        book_id="pride-and-prejudice",
        number=2,
        lang="zh-CN",
        status="cached",
        batch_count=0,
        concurrency=2,
        total_ms=3.0,
    )
    assert _rows() == []


def test_video_analysis_helper_records_job_id(migrated, monkeypatch):
    async def fake_attach(_payload, **_kwargs):
        return {"highlights": []}

    monkeypatch.setattr(teaching_analysis, "attach_to_payload", fake_attach)

    result = asyncio.run(
        routes_videos._attach_video_analysis(
            {"videoId": "vid123"},
            content_ref="vid123",
            level="B1",
            job_id="job-1",
        )
    )
    assert result == {"highlights": []}
    rows = _rows()
    assert len(rows) == 1
    assert rows[0]["feature"] == "video_analysis"
    assert rows[0]["event"] == "total"
    assert rows[0]["content_ref"] == "vid123"
    assert rows[0]["job_id"] == "job-1"
    assert rows[0]["ok"] == 1


def test_timing_failure_never_breaks_helpers(migrated, monkeypatch):
    def _boom(*_args, **_kwargs):
        raise RuntimeError("模拟计时故障")

    monkeypatch.setattr(pipeline_timing, "record", _boom)
    # 两个 helper 都必须在 finally 里安全：不能把异常抛回翻译/SSE。
    routes_videos._timing_log(
        "video_translation", event="total", total_ms=1.0, ok=True
    )
    translate._stream_timing(event="total", total_ms=1.0, outcome="done", ok=True)
