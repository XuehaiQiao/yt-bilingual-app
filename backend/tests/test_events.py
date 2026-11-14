"""学习事件日志（append-only）的离线验收。

覆盖：

- ``emit_event`` 写入 → ``query_events`` 读回，字段/时间戳/假名正确；
- payload 的 JSON 往返（含中文、嵌套结构、浮点/布尔）；
- 事件表未迁移 / 库文件不存在 / payload 不可序列化时，写入失败**不抛异常**、
  不阻断主流程，并且留下日志；
- 只读查询的过滤与排序；
- **append-only 的代码层断言**：events.py 里没有改/删 SQL，没有改/删入口，
  也没有对外 HTTP 端点；表结构只由迁移创建。

所有用例用 tmp 库：先用 Alembic 建一份模板库，再按用例复制。
"""
from __future__ import annotations

import ast
import json
import logging
import re
import shutil
import sqlite3
from pathlib import Path

import pytest

import auth_db
import config
import events
import main
from tests.migration_utils import assert_alembic_ok, run_alembic

BACKEND_DIR = Path(__file__).resolve().parents[1]
EVENTS_MODULE = BACKEND_DIR / "events.py"


@pytest.fixture(scope="module")
def migrated_db_template(tmp_path_factory) -> Path:
    """整个模块共用一份「已 upgrade head」的模板库（每个用例再复制）。"""
    path = tmp_path_factory.mktemp("migrated_template") / "app.db"
    assert_alembic_ok(run_alembic(path, "upgrade", "head"), "upgrade head")
    return path


@pytest.fixture()
def events_db(tmp_path, monkeypatch, migrated_db_template) -> Path:
    """每个用例一份独立的已迁移库 + 固定的测试盐。"""
    path = tmp_path / "app.db"
    shutil.copy2(migrated_db_template, path)
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(path), raising=False)
    monkeypatch.setattr(config, "EVENTS_PSEUDONYM_SALT", "test-pseudonym-salt", raising=False)
    # 每个用例都能独立触发「未配置盐」的告警
    monkeypatch.setattr(events, "_warned_default_salt", False, raising=False)
    return path


def test_emit_event_roundtrip(events_db):
    occurred = 1_700_000_000_123
    event_id = events.emit_event(
        "video_open",
        user_id="user-1",
        device_id="device-a",
        session_id="session-1",
        content_ref="video-9",
        payload={"rate": 1.5, "visible": True},
        occurred_at=occurred,
    )
    assert isinstance(event_id, int) and event_id > 0

    rows = events.query_events(user_id="user-1")
    assert len(rows) == 1
    row = rows[0]
    assert row["id"] == event_id
    assert row["event_type"] == "video_open"
    assert row["user_id"] == "user-1"
    assert row["device_id"] == "device-a"
    assert row["session_id"] == "session-1"
    assert row["content_ref"] == "video-9"
    assert row["payload"] == {"rate": 1.5, "visible": True}
    assert row["occurred_at"] == occurred
    assert isinstance(row["created_at"], int) and row["created_at"] >= occurred

    # 假名：由盐 + user_id 决定，不是明文 user_id
    assert row["pseudonym_id"] == events.pseudonym_for("user-1")
    assert row["pseudonym_id"] != "user-1"


def test_payload_json_roundtrip_unicode_and_nested(events_db):
    payload = {
        "中文": "未翻译的句子",
        "nested": {"list": [1, 2.5, None, False], "deep": {"k": "值"}},
        "emoji": "🎧",
    }
    event_id = events.emit_event("quiz_answer", user_id="u-cn", payload=payload)
    assert event_id is not None

    rows = events.query_events(event_type="quiz_answer")
    assert rows[0]["payload"] == payload

    # 落库是 UTF-8 原文（ensure_ascii=False），不是 \uXXXX 转义
    with sqlite3.connect(events_db) as conn:
        raw = conn.execute(
            "SELECT payload FROM learning_events WHERE id = ?", (event_id,)
        ).fetchone()[0]
    assert "中文" in raw and "🎧" in raw
    assert json.loads(raw) == payload


def test_event_type_is_required(events_db):
    assert events.emit_event("") is None
    assert events.emit_event("   ") is None
    assert events.emit_event(None) is None  # 类型不对也不抛
    assert events.query_events() == []


def test_bad_occurred_at_falls_back_to_server_time(events_db, caplog):
    with caplog.at_level(logging.WARNING, logger="events"):
        event_id = events.emit_event("video_open", user_id="u", occurred_at="not-a-number")
    assert event_id is not None
    row = events.query_events(event_type="video_open")[0]
    assert isinstance(row["occurred_at"], int) and row["occurred_at"] > 0


def test_emit_event_appends_without_overwriting(events_db):
    first = events.emit_event("word_review", user_id="u", occurred_at=1000)
    second = events.emit_event("word_review", user_id="u", occurred_at=2000)
    assert first is not None and second is not None and second > first

    rows = events.query_events(user_id="u")
    assert [row["id"] for row in rows] == [first, second]
    assert [row["occurred_at"] for row in rows] == [1000, 2000]


def test_query_events_filters_and_order(events_db):
    events.emit_event("video_open", user_id="alice", occurred_at=1000)
    events.emit_event("quiz_answer", user_id="alice", occurred_at=2000)
    events.emit_event("quiz_answer", user_id="bob", occurred_at=3000)

    assert len(events.query_events(user_id="alice")) == 2
    assert len(events.query_events(event_type="quiz_answer")) == 2
    assert [r["user_id"] for r in events.query_events(event_type="quiz_answer")] == [
        "alice",
        "bob",
    ]
    assert [r["occurred_at"] for r in events.query_events(since_ms=1500)] == [2000, 3000]
    assert [r["occurred_at"] for r in events.query_events(until_ms=2000)] == [1000, 2000]
    assert [r["occurred_at"] for r in events.query_events(limit=1)] == [1000]
    assert len(events.query_events(limit=0)) == 1  # limit 夹到 >=1


def test_emit_event_does_not_raise_when_table_missing(tmp_path, monkeypatch, caplog):
    db = tmp_path / "legacy.db"
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(db), raising=False)
    auth_db.init_db()  # 旧路径：只有 users/sessions，没有 learning_events

    with caplog.at_level(logging.ERROR, logger="events"):
        assert events.emit_event("video_open", user_id="u") is None

    assert any("learning_events" in record.getMessage() for record in caplog.records)
    with sqlite3.connect(db) as conn:
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    assert "learning_events" not in tables


def test_emit_event_does_not_raise_when_db_missing(tmp_path, monkeypatch, caplog):
    db = tmp_path / "not_created_yet" / "app.db"
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(db), raising=False)

    with caplog.at_level(logging.ERROR, logger="events"):
        assert events.emit_event("video_open", user_id="u") is None

    # 不会因为埋点失败顺手建出一个空库
    assert not db.exists()
    assert any(record.levelno >= logging.ERROR for record in caplog.records)


def test_emit_event_keeps_event_when_payload_not_serializable(events_db, caplog):
    with caplog.at_level(logging.WARNING, logger="events"):
        event_id = events.emit_event(
            "block_visible", user_id="u", payload={"bad": {1, 2, 3}}
        )
    assert event_id is not None  # 事件本身保留

    rows = events.query_events(event_type="block_visible")
    assert len(rows) == 1
    assert rows[0]["payload"] is None


def test_pseudonym_depends_on_salt(monkeypatch):
    monkeypatch.setattr(config, "EVENTS_PSEUDONYM_SALT", "salt-a", raising=False)
    first = events.pseudonym_for("user-1")
    monkeypatch.setattr(config, "EVENTS_PSEUDONYM_SALT", "salt-b", raising=False)
    second = events.pseudonym_for("user-1")

    assert first != second
    assert first and second and "user-1" not in first
    assert events.pseudonym_for(None) is None
    assert events.pseudonym_for("") is None


def test_schema_status_tracks_migration_state(tmp_path, monkeypatch):
    db = tmp_path / "app.db"
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(db), raising=False)
    missing = events.schema_status()
    assert missing["db_exists"] is False and missing["ready"] is False

    auth_db.init_db()  # 旧库：users/sessions 在，事件表还没迁移
    legacy = events.schema_status()
    assert legacy["db_exists"] is True
    assert legacy["events_table"] is False
    assert legacy["ready"] is False

    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    migrated = events.schema_status()
    assert migrated["events_table"] is True
    assert migrated["alembic_revision"] == "0003_cost_ledger"
    assert migrated["ready"] is True


def test_no_public_event_api():
    """M1a 只做内部写入层，不新增对外端点（下一阶段再接前端）。"""
    paths = {getattr(route, "path", "") for route in main.app.routes}
    assert not any("event" in path.lower() for path in paths)


def _non_docstring_strings(source: str) -> list[str]:
    tree = ast.parse(source)
    docstrings: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            first = node.body[0] if node.body else None
            if (
                isinstance(first, ast.Expr)
                and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)
            ):
                docstrings.add(id(first.value))
    return [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and id(node) not in docstrings
    ]


def test_events_module_is_append_only_by_construction():
    """代码层断言：events.py 里不存在改/删路径（表只由迁移创建）。"""
    source = EVENTS_MODULE.read_text(encoding="utf-8")

    # 1) 非 docstring 字符串里不出现改/删 SQL 关键字
    for text in _non_docstring_strings(source):
        assert not re.search(
            r"\b(UPDATE|DELETE|REPLACE|DROP|ALTER|TRUNCATE)\b", text.upper()
        ), f"events.py 出现疑似改/删语句：{text!r}"

    # 2) 扫到的完整 SQL 只有 INSERT / SELECT
    sql_statements = [
        text.strip().upper()
        for text in _non_docstring_strings(source)
        if text.strip().upper().startswith(("SELECT", "INSERT", "UPDATE", "DELETE"))
    ]
    assert sql_statements, "应当能扫到 events.py 里的 SQL 语句"
    assert all(sql.startswith(("SELECT", "INSERT")) for sql in sql_statements)

    # 3) 模块对外接口里没有改/删类函数
    public_names = [name for name in dir(events) if not name.startswith("_")]
    assert not [
        name
        for name in public_names
        if re.match(r"(update|delete|remove|purge|drop|truncate)", name, re.IGNORECASE)
    ], f"events.py 暴露了改/删入口：{public_names}"

    # 4) 必须在的接口都在（防止有人误删写入层）
    for required in ("emit_event", "query_events", "schema_status", "pseudonym_for"):
        assert callable(getattr(events, required, None)), f"缺少 events.{required}"
