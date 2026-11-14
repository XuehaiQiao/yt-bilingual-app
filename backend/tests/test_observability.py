"""CI/M1c 可观测性验收：/healthz 与结构化访问日志。

覆盖：

- ``/healthz`` 的 200/503、字段完整、迁移版本（Alembic 只读接口）、只读行为；
- 访问日志：``X-Request-ID`` 响应头、一行一个 JSON、字段齐全、登录后带 user_id；
- 敏感值不落日志：query / body / 请求头里的密码与 API Key 均不出现；
- 未处理异常：日志带 request_id 与堆栈，500 响应也带 request_id。

所有用例沿用 conftest 的 tmp 数据目录与离线守卫，不联网、不碰真实 data/。
"""
from __future__ import annotations

import json
import logging
import re
import sqlite3
import traceback
from datetime import datetime

import config
import observability
import routes_videos
from tests.migration_utils import assert_alembic_ok, run_alembic

REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{8,64}$")
URL = "https://www.youtube.com/watch?v=abc123xyz"


def _access_records(caplog):
    return [record for record in caplog.records if record.name == "linguatrek.access"]


# --- /healthz -------------------------------------------------------------


def test_healthz_ok_and_fields(client):
    response = client.get("/healthz")
    assert response.status_code == 200

    body = response.json()
    assert set(body) == {"status", "version", "db", "uptime_seconds", "time"}
    assert body["status"] == "ok"
    assert body["version"] == config.APP_VERSION
    assert body["db"]["ok"] is True
    assert set(body["db"]["migrations"]) == {"current", "head"}
    # signup 走的是 auth_db 兼容建表路径，还没有 alembic_version
    assert body["db"]["migrations"]["current"] is None
    assert body["db"]["migrations"]["head"] == observability.alembic_head()
    assert isinstance(body["uptime_seconds"], (int, float))
    assert body["uptime_seconds"] >= 0
    assert body["time"].endswith("Z")
    datetime.fromisoformat(body["time"].replace("Z", "+00:00"))
    assert response.headers["Cache-Control"] == "no-store"


def test_healthz_reports_migrated_database(client):
    """迁移到 head 后，current 应等于 head（验证 MigrationContext 只读读取）。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade"
    )

    response = client.get("/healthz")
    assert response.status_code == 200
    migrations = response.json()["db"]["migrations"]
    assert migrations["head"] == observability.alembic_head()
    assert migrations["current"] == migrations["head"]


def test_healthz_is_public_and_does_not_write(make_client, monkeypatch, tmp_path):
    db_path = tmp_path / "empty.db"
    sqlite3.connect(db_path).close()  # 空库：没有表，也没有 alembic_version
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(db_path), raising=False)

    with make_client() as anonymous:
        response = anonymous.get("/healthz")

    assert response.status_code == 200
    assert response.json()["db"] == {
        "ok": True,
        "migrations": {"current": None, "head": observability.alembic_head()},
    }
    # 只读检查不能给空库建表/写版本号
    assert db_path.stat().st_size == 0


def test_healthz_503_when_database_missing(make_client, monkeypatch, tmp_path):
    missing = tmp_path / "no-such-dir" / "app.db"
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(missing), raising=False)

    with make_client() as anonymous:
        response = anonymous.get("/healthz")

    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "degraded"
    assert body["db"]["ok"] is False
    assert body["db"]["migrations"] == {
        "current": None,
        "head": observability.alembic_head(),
    }
    # 健康检查不得顺手建出空库
    assert not missing.exists()


def test_healthz_503_when_database_is_not_sqlite(make_client, monkeypatch, tmp_path):
    broken = tmp_path / "broken.db"
    broken.write_text("this is not a sqlite database", encoding="utf-8")
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(broken), raising=False)

    with make_client() as anonymous:
        response = anonymous.get("/healthz")

    assert response.status_code == 503
    assert response.json()["status"] == "degraded"
    assert response.json()["db"]["ok"] is False


# --- request_id 与访问日志 --------------------------------------------------


def test_request_id_header_is_generated(client):
    response = client.get("/health")
    request_id = response.headers.get("X-Request-ID")
    assert request_id and REQUEST_ID_RE.fullmatch(request_id)


def test_request_id_header_echoes_safe_client_value(client):
    response = client.get("/health", headers={"X-Request-ID": "trace-abc-123"})
    assert response.headers["X-Request-ID"] == "trace-abc-123"


def test_request_id_header_replaces_unsafe_client_value(client):
    response = client.get("/health", headers={"X-Request-ID": "bad id with spaces"})
    request_id = response.headers["X-Request-ID"]
    assert request_id != "bad id with spaces"
    assert REQUEST_ID_RE.fullmatch(request_id)


def test_access_log_is_one_line_json_without_user_for_anonymous(make_client, caplog):
    caplog.set_level(logging.INFO, logger="linguatrek.access")

    with make_client() as anonymous:
        response = anonymous.get(
            "/health", headers={"X-Request-ID": "trace-anon-123"}
        )

    records = _access_records(caplog)
    assert records, "每个请求都应有一行访问日志"
    payload = json.loads(records[-1].getMessage())
    assert payload["event"] == "http_request"
    assert payload["request_id"] == response.headers["X-Request-ID"]
    assert payload["request_id"] == "trace-anon-123"
    assert payload["method"] == "GET"
    assert payload["path"] == "/health"
    assert payload["status"] == 200
    assert isinstance(payload["duration_ms"], (int, float))
    assert payload["duration_ms"] >= 0
    assert "user_id" not in payload

    # 实际写出的日志行（JsonFormatter）也是单行合法 JSON
    line = observability.JsonFormatter().format(records[-1])
    assert "\n" not in line
    formatted = json.loads(line)
    assert formatted["status"] == 200
    assert formatted["request_id"] == "trace-anon-123"
    assert formatted["level"] == "info"


def test_access_log_has_user_id_when_logged_in(client, caplog):
    caplog.set_level(logging.INFO, logger="linguatrek.access")

    response = client.get("/health", headers={"X-Request-ID": "trace-user-123"})

    payload = json.loads(_access_records(caplog)[-1].getMessage())
    assert payload["request_id"] == response.headers["X-Request-ID"]
    assert payload["user_id"] == client.user_id


def test_access_log_does_not_leak_query_body_or_headers(make_client, caplog):
    caplog.set_level(logging.INFO)
    password = "super-secret-password-123"
    api_key = "sk-live-super-secret-key"

    with make_client() as anonymous:
        response = anonymous.post(
            "/api/auth/login",
            params={"password": password, "api_key": api_key},
            json={"email": "nobody@example.com", "password": password},
            headers={"X-API-Key": api_key},
        )

    assert response.status_code == 401
    # 访问日志只记 path：query / body / header 里的敏感值一律不落日志
    payload = json.loads(_access_records(caplog)[-1].getMessage())
    assert payload["path"] == "/api/auth/login"
    assert password not in caplog.text
    assert api_key not in caplog.text
    assert "query" not in payload


def test_unhandled_exception_log_has_request_id_and_stack(
    client, caplog, monkeypatch
):
    caplog.set_level(logging.INFO, logger="linguatrek.error")
    caplog.set_level(logging.INFO, logger="linguatrek.access")

    def _boom(_video_id):
        raise RuntimeError("boom")

    monkeypatch.setattr(routes_videos, "fetch_english_transcript", _boom)

    response = client.get(
        "/api/estimate-cost",
        params={"url": URL},
        headers={"X-Request-ID": "trace-error-123"},
    )

    assert response.status_code == 500
    assert response.headers["X-Request-ID"] == "trace-error-123"
    assert response.json()["request_id"] == "trace-error-123"

    errors = [r for r in caplog.records if r.name == "linguatrek.error"]
    assert errors, "未处理异常必须留下带堆栈的日志"
    record = errors[-1]
    assert record.exc_info is not None
    stack = "".join(traceback.format_exception(*record.exc_info))
    assert "RuntimeError: boom" in stack
    # 异常日志经 JsonFormatter 后仍是单行，并带 request_id / stack
    line = observability.JsonFormatter().format(record)
    assert "\n" not in line
    payload = json.loads(line)
    assert payload["request_id"] == "trace-error-123"
    assert "RuntimeError: boom" in payload["stack"]

    access_payload = json.loads(_access_records(caplog)[-1].getMessage())
    assert access_payload["status"] == 500
