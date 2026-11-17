"""迁移 0016 content_difficulty 的离线验收（计划书 §7.2 / §7.3，specs/026）。

覆盖：建表/索引/列清单/主键、content_kind & method & confidence 约束、
不 seed、重复 upgrade 幂等、downgrade 只删本表、re-upgrade。
"""
from __future__ import annotations

import sqlite3

import pytest

from tests.migration_utils import (
    assert_alembic_ok,
    columns,
    index_names,
    revision,
    run_alembic,
    table_names,
)

HEAD = "0021_course_mvp"
PREVIOUS = "0015_assessment_sessions"


def _upgrade(db_path, target: str = "head") -> None:
    assert_alembic_ok(run_alembic(db_path, "upgrade", target), f"upgrade {target}")


def test_upgrade_creates_table_columns_and_indexes(tmp_path):
    db = tmp_path / "app.db"
    _upgrade(db, PREVIOUS)
    assert "content_difficulty" not in table_names(db)
    _upgrade(db)
    assert revision(db) == HEAD
    assert "content_difficulty" in table_names(db)

    assert list(columns(db, "content_difficulty")) == [
        "content_ref",
        "content_kind",
        "version",
        "level",
        "cefr_input",
        "cefr_task",
        "lexical_band",
        "syntax_band",
        "discourse_band",
        "features",
        "support",
        "method",
        "confidence",
        "reviewer",
        "reviewed_at",
        "created_at",
        "updated_at",
    ]
    assert {
        "ix_content_difficulty_kind_cefr",
        "ix_content_difficulty_kind_updated",
    } <= index_names(db, "content_difficulty")

    with sqlite3.connect(db) as conn:
        info = conn.execute("PRAGMA table_info(content_difficulty)").fetchall()
        primary_key = [row[1] for row in sorted(info, key=lambda row: row[5]) if row[5]]
        assert primary_key == ["content_ref", "content_kind", "version"]
        assert conn.execute("SELECT COUNT(*) FROM content_difficulty").fetchone()[0] == 0


def test_upgrade_is_idempotent(tmp_path):
    db = tmp_path / "app.db"
    _upgrade(db)
    _upgrade(db)
    assert revision(db) == HEAD


def test_content_difficulty_constraints(tmp_path):
    db = tmp_path / "app.db"
    _upgrade(db)
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO content_difficulty "
            "(content_ref, content_kind, version, method, created_at, updated_at) "
            "VALUES ('a', 'video', 'v1', 'rule', 1, 1)"
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO content_difficulty "
                "(content_ref, content_kind, version, method, created_at, updated_at) "
                "VALUES ('b', 'podcast', 'v1', 'rule', 1, 1)"
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO content_difficulty "
                "(content_ref, content_kind, version, method, created_at, updated_at) "
                "VALUES ('c', 'video', 'v1', 'magic', 1, 1)"
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO content_difficulty "
                "(content_ref, content_kind, version, method, confidence, "
                "created_at, updated_at) VALUES ('d', 'video', 'v1', 'rule', 1.5, 1, 1)"
            )
        # 同内容同版本重复 → 主键冲突（backfill 用 ON CONFLICT 幂等 upsert）。
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO content_difficulty "
                "(content_ref, content_kind, version, method, created_at, updated_at) "
                "VALUES ('a', 'video', 'v1', 'rule', 2, 2)"
            )
        conn.rollback()


def test_downgrade_removes_only_this_table_and_reupgrade_works(tmp_path):
    db = tmp_path / "app.db"
    _upgrade(db)
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO user_profiles "
            "(user_id, cefr, level_band_low, level_band_high, confidence, "
            "pseudo_word_suspicion, updated_at, source) "
            "VALUES ('u1', 'B1–B2', 'B1', 'B2', 0.8, 0.0, 1, 'placement')"
        )
        conn.commit()
    assert_alembic_ok(run_alembic(db, "downgrade", PREVIOUS), "downgrade to 0015")
    assert revision(db) == PREVIOUS
    assert "content_difficulty" not in table_names(db)
    assert "user_skill_profiles" in table_names(db)
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT COUNT(*) FROM user_profiles").fetchone()[0] == 1

    _upgrade(db)
    assert revision(db) == HEAD
    assert "content_difficulty" in table_names(db)
