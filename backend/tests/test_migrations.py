"""Alembic 迁移的离线验收（全部用 tmp 库，不碰 data/app.db）。

覆盖：

1. 空库 ``upgrade head``：users/sessions/learning_events 与索引齐全，字段契约与
   ``auth_db.py`` 一致；
2. 旧库（auth_db 现存 schema + 真实数据）``stamp 0001_baseline`` + ``upgrade head``：
   users/sessions 数据不丢，learning_events 可用；
3. 旧库直接 ``upgrade head``：基线迁移幂等，不重建、不丢数据；
4. 已迁移库 ``stamp head``：只写版本号，可重复执行；
5. ``downgrade base`` → ``upgrade head`` 往返成功（迁移有 up 也有 down）。
"""
from __future__ import annotations

import sqlite3

import config
import auth_db
from tests.migration_utils import (
    assert_alembic_ok,
    columns,
    index_names,
    revision,
    run_alembic,
    table_names,
)

BASELINE = "0001_baseline"
HEAD = "0002_learning_events"


def _make_legacy_db(db_path, monkeypatch) -> dict:
    """用「旧路径」（auth_db 连库即建表）造一个带真实数据的旧库。"""
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(db_path), raising=False)
    auth_db.init_db()
    user = auth_db.create_user("old-user@example.com", "old-password-123")
    token = auth_db.create_session(user["id"])
    return {"user": user, "token": token}


def _table_signature(db_path, table: str):
    """表契约签名：列（名字/类型/可空/默认值/主键位）+ 索引（名字/唯一/来源/列）。"""
    with sqlite3.connect(db_path) as conn:
        columns = [
            (row[1], row[2].upper(), row[3], row[4], row[5])
            for row in conn.execute(f"PRAGMA table_info({table})")
        ]
        indexes = []
        for _seq, name, unique, origin, _partial in conn.execute(
            f"PRAGMA index_list({table})"
        ):
            index_columns = [
                (row[0], row[1], row[2])
                for row in conn.execute(f"PRAGMA index_info({name})")
            ]
            indexes.append((name, unique, origin, index_columns))
    return columns, sorted(indexes)


def test_upgrade_head_from_empty_db(tmp_path):
    db = tmp_path / "app.db"
    assert not db.exists()

    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")

    tables = table_names(db)
    assert {"users", "sessions", "learning_events", "alembic_version"} <= tables
    assert revision(db) == HEAD

    # 基线字段与 auth_db.py 一致（名字/顺序/可空性）
    users = columns(db, "users")
    assert list(users) == ["id", "email", "password_hash", "created_at"]
    assert users["id"]["pk"] == 1
    assert users["id"]["notnull"] == 0  # 与 auth_db.py 的 `id TEXT PRIMARY KEY` 一致
    assert users["email"]["notnull"] == 1
    assert users["password_hash"]["notnull"] == 1
    assert users["created_at"]["notnull"] == 1

    sessions = columns(db, "sessions")
    assert list(sessions) == ["token_hash", "user_id", "expires_at", "created_at"]
    assert sessions["token_hash"]["pk"] == 1
    assert sessions["token_hash"]["notnull"] == 0
    assert sessions["user_id"]["notnull"] == 1

    # 索引：sessions 的过期清理索引 + 事件表的两个查询索引
    assert "idx_sessions_expires" in index_names(db, "sessions")
    events_indexes = index_names(db, "learning_events")
    assert "ix_learning_events_user_occurred" in events_indexes
    assert "ix_learning_events_type_occurred" in events_indexes

    # email UNIQUE 约束（SQLite 用自动索引表达）
    with sqlite3.connect(db) as conn:
        unique_indexes = [
            row[1]
            for row in conn.execute("PRAGMA index_list(users)")
            if row[2] == 1
        ]
    assert unique_indexes, "users.email 应有 UNIQUE 约束"

    # 事件表字段齐全
    events = columns(db, "learning_events")
    assert list(events) == [
        "id",
        "user_id",
        "device_id",
        "session_id",
        "event_type",
        "content_ref",
        "payload",
        "occurred_at",
        "created_at",
        "pseudonym_id",
    ]
    assert events["event_type"]["notnull"] == 1
    assert events["occurred_at"]["notnull"] == 1
    assert events["created_at"]["notnull"] == 1


def test_baseline_schema_matches_auth_db_contract(tmp_path, monkeypatch):
    """基线迁移与 auth_db.py 的现存 schema 逐列/逐索引一致（含可空性）。"""
    legacy_db = tmp_path / "legacy.db"
    fresh_db = tmp_path / "fresh.db"

    monkeypatch.setattr(config, "AUTH_DB_PATH", str(legacy_db), raising=False)
    auth_db.init_db()
    assert_alembic_ok(run_alembic(fresh_db, "upgrade", "head"), "upgrade head")

    for table in ("users", "sessions"):
        assert _table_signature(legacy_db, table) == _table_signature(fresh_db, table), (
            f"{table} 的基线 schema 与 auth_db.py 不一致"
        )


def test_legacy_db_stamp_then_upgrade_keeps_data(tmp_path, monkeypatch):
    db = tmp_path / "app.db"
    legacy = _make_legacy_db(db, monkeypatch)
    user = legacy["user"]

    assert set(table_names(db)) == {"users", "sessions"}
    assert revision(db) is None

    # 旧库纳管：先只标记基线，数据一个字节都不动
    assert_alembic_ok(run_alembic(db, "stamp", BASELINE), "stamp 0001_baseline")
    assert revision(db) == BASELINE

    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head (legacy)")
    assert revision(db) == HEAD
    assert "learning_events" in table_names(db)

    # users/sessions 数据不丢
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT id, email FROM users").fetchall() == [
            (user["id"], "old-user@example.com")
        ]
        assert conn.execute("SELECT token_hash FROM sessions").fetchall() == [
            (auth_db.hash_token(legacy["token"]),)
        ]

    # 旧登录路径仍可用（缓存不因迁移失效），事件表可写
    assert auth_db.get_user_by_email("OLD-USER@example.com")["id"] == user["id"]
    assert auth_db.get_session(legacy["token"])["id"] == user["id"]
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO learning_events (user_id, event_type, occurred_at, created_at) "
            "VALUES (?, ?, ?, ?)",
            (user["id"], "video_open", 1000, 1000),
        )
        conn.commit()
        assert conn.execute("SELECT COUNT(*) FROM learning_events").fetchone()[0] == 1


def test_upgrade_head_directly_on_legacy_db_is_safe(tmp_path, monkeypatch):
    """基线迁移幂等：旧库不 stamp 直接 upgrade head 也不重建、不丢数据。"""
    db = tmp_path / "app.db"
    legacy = _make_legacy_db(db, monkeypatch)

    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head (legacy, no stamp)")

    assert revision(db) == HEAD
    assert {"users", "sessions", "learning_events"} <= table_names(db)
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT email FROM users").fetchone()[0] == "old-user@example.com"
    assert auth_db.get_session(legacy["token"])["id"] == legacy["user"]["id"]


def test_stamp_head_on_migrated_db_is_noop(tmp_path):
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")

    before = (table_names(db), index_names(db, "learning_events"))
    assert_alembic_ok(run_alembic(db, "stamp", "head"), "stamp head")
    # 再跑一次也不报错（stamp 只写版本号，可重复）
    assert_alembic_ok(run_alembic(db, "stamp", "head"), "stamp head (repeat)")

    assert revision(db) == HEAD
    assert (table_names(db), index_names(db, "learning_events")) == before


def test_downgrade_base_then_upgrade_head_roundtrip(tmp_path):
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    assert_alembic_ok(run_alembic(db, "downgrade", "base"), "downgrade base")

    # 两个迁移的 down 都执行过：业务表清空，只剩 alembic 版本表
    assert table_names(db) == {"alembic_version"}
    assert revision(db) is None

    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head (after downgrade)")
    assert {"users", "sessions", "learning_events"} <= table_names(db)
