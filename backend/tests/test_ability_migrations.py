"""迁移 0014/0015 的离线验收（计划书 §7.2/§7.3，specs/025）。

覆盖：建表/索引/加列、旧词汇量 seed 的 5 个边界、NULL 画像、confidence cap、
downgrade 保留旧表、重复 upgrade 幂等、assessment_sessions 约束。
全部用 tmp 库 + 真实 Alembic CLI，不碰 data/app.db。
"""
from __future__ import annotations

import json
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

HEAD = "0016_content_difficulty"
BEFORE = "0013_user_profile"


def _upgrade(db_path, target: str = "head") -> None:
    assert_alembic_ok(run_alembic(db_path, "upgrade", target), f"upgrade {target}")


def _legacy_profile(
    db_path,
    user_id: str,
    *,
    vocab_estimate: int | None,
    confidence: float = 0.8,
    reading_estimate: str | None = "C1",
    updated_at: int = 12345,
) -> None:
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO user_profiles "
            "(user_id, cefr, level_band_low, level_band_high, vocab_estimate, "
            "reading_estimate, confidence, pseudo_word_suspicion, updated_at, source) "
            "VALUES (?, 'A2–B2', 'A2', 'B2', ?, ?, ?, 0.0, ?, 'placement')",
            (user_id, vocab_estimate, reading_estimate, confidence, updated_at),
        )


def _ability_db(tmp_path, *, seed: list[tuple[str, int | None, float]] | None = None):
    db = tmp_path / "app.db"
    _upgrade(db, BEFORE)
    for user_id, estimate, confidence in seed or []:
        _legacy_profile(db, user_id, vocab_estimate=estimate, confidence=confidence)
    _upgrade(db)
    return db


# ---------------------------------------------------------------------------
# 建表 / 加列
# ---------------------------------------------------------------------------

def test_upgrade_creates_ability_tables_columns_and_indexes(tmp_path):
    db = tmp_path / "app.db"
    _upgrade(db)
    tables = table_names(db)
    assert {
        "user_skill_profiles",
        "skill_evidence",
        "assessment_sessions",
        "placement_answers",
        "user_profiles",
    } <= tables
    assert revision(db) == HEAD

    profiles = columns(db, "user_skill_profiles")
    assert list(profiles) == [
        "user_id",
        "skill",
        "cefr_point",
        "cefr_low",
        "cefr_high",
        "confidence",
        "status",
        "method",
        "evidence_count",
        "effective_n",
        "last_evidence_at",
        "details",
        "calibration_version",
        "schema_version",
        "updated_at",
    ]
    assert profiles["cefr_point"]["notnull"] == 0
    assert profiles["status"]["notnull"] == 1
    assert profiles["calibration_version"]["notnull"] == 1
    assert "ability.v1" in str(profiles["schema_version"]["default"])
    assert "ix_user_skill_profiles_user_updated" in index_names(db, "user_skill_profiles")

    evidence = columns(db, "skill_evidence")
    for required in ("user_id", "skill", "evidence_type", "source_key", "observed_at"):
        assert evidence[required]["notnull"] == 1, required
    assert "ix_skill_evidence_user_skill_time" in index_names(db, "skill_evidence")
    # UNIQUE(user_id, evidence_type, source_key) 在 SQLite 里是自动唯一索引。
    with sqlite3.connect(db) as conn:
        unique = [
            row[1] for row in conn.execute("PRAGMA index_list(skill_evidence)")
            if row[2]
        ]
        sql = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='skill_evidence'"
        ).fetchone()[0]
    assert unique
    assert "ux_skill_evidence_source" in sql

    sessions = columns(db, "assessment_sessions")
    assert list(sessions)[:5] == [
        "id",
        "user_id",
        "guest_hash",
        "kind",
        "status",
    ]
    assert "ux_assessment_sessions_request" in index_names(db, "assessment_sessions")
    assert "ux_assessment_sessions_active" in index_names(db, "assessment_sessions")


def test_elapsed_ms_is_nullable_and_old_rows_stay_null(tmp_path):
    db = tmp_path / "app.db"
    _upgrade(db)
    assert "elapsed_ms" in columns(db, "placement_answers")
    assert columns(db, "placement_answers")["elapsed_ms"]["notnull"] == 0
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO placement_sessions (id, user_id, status, started_at) "
            "VALUES ('s1', 'u1', 'submitted', 1)"
        )
        conn.execute(
            "INSERT INTO placement_answers "
            "(session_id, item_id, item_type, chosen_index, correct, "
            "difficulty_band, answered_at) "
            "VALUES ('s1', 'v-001', 'vocab', 0, 1, 'A1', 1)"
        )
    with sqlite3.connect(db) as conn:
        row = conn.execute("SELECT elapsed_ms FROM placement_answers").fetchone()
    assert row[0] is None


# ---------------------------------------------------------------------------
# seed
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("estimate", "expected_band"),
    [
        (1500, "A1"),
        (3000, "A2"),
        (5000, "B1"),
        (8000, "B2"),
        (12000, "C1"),
    ],
)
def test_seed_maps_legacy_vocab_estimate_to_band(tmp_path, estimate, expected_band):
    db = _ability_db(tmp_path, seed=[("legacy", estimate, 0.8)])
    with sqlite3.connect(db) as conn:
        row = conn.execute(
            "SELECT * FROM user_skill_profiles WHERE user_id='legacy'"
        ).fetchone()
    row = dict(zip(conn_description(db), row))
    assert row["skill"] == "vocabulary"
    assert row["cefr_point"] == expected_band
    assert row["status"] == "uncalibrated"
    assert row["method"] == "placement"
    assert row["calibration_version"] == "rasch.eap.v1"
    details = json.loads(row["details"])
    assert details["source"] == "legacy_seed"
    assert details["estimate"]["point"] == estimate


def test_seed_null_vocab_creates_empty_row_but_no_reading_row(tmp_path):
    db = _ability_db(tmp_path, seed=[("legacy-null", None, 0.7)])
    with sqlite3.connect(db) as conn:
        rows = conn.execute(
            "SELECT skill, cefr_point, cefr_low, cefr_high, status, details "
            "FROM user_skill_profiles WHERE user_id='legacy-null'"
        ).fetchall()
    assert len(rows) == 1
    skill, point, low, high, status, details = rows[0]
    assert skill == "vocabulary"
    assert point is None and low is None and high is None
    assert status == "uncalibrated"
    assert json.loads(details)["source"] == "legacy_seed"
    with sqlite3.connect(db) as conn:
        reading_rows = conn.execute(
            "SELECT COUNT(*) FROM user_skill_profiles WHERE skill='reading'"
        ).fetchone()[0]
    assert reading_rows == 0


def test_seed_caps_confidence_at_085(tmp_path):
    db = _ability_db(
        tmp_path,
        seed=[
            ("high-confidence", 5000, 0.99),
            ("low-confidence", 5000, 0.4),
        ],
    )
    with sqlite3.connect(db) as conn:
        rows = dict(
            conn.execute(
                "SELECT user_id, confidence FROM user_skill_profiles"
            ).fetchall()
        )
    assert rows["high-confidence"] == 0.85
    assert rows["low-confidence"] == 0.4


# ---------------------------------------------------------------------------
# downgrade / re-upgrade / 约束
# ---------------------------------------------------------------------------

def test_downgrade_removes_ability_but_keeps_legacy_profiles(tmp_path):
    db = _ability_db(tmp_path, seed=[("legacy", 5000, 0.8)])
    assert_alembic_ok(
        run_alembic(db, "downgrade", BEFORE), "downgrade to 0013"
    )
    tables = table_names(db)
    assert "user_skill_profiles" not in tables
    assert "skill_evidence" not in tables
    assert "assessment_sessions" not in tables
    assert "user_profiles" in tables
    assert "elapsed_ms" not in columns(db, "placement_answers")
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT COUNT(*) FROM user_profiles").fetchone()[0] == 1
    assert revision(db) == BEFORE


def test_reupgrade_after_downgrade_reseeds_idempotently(tmp_path):
    db = _ability_db(tmp_path, seed=[("legacy", 5000, 0.8)])
    assert_alembic_ok(run_alembic(db, "downgrade", BEFORE), "downgrade")
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "re-upgrade")
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade again")
    with sqlite3.connect(db) as conn:
        rows = conn.execute(
            "SELECT COUNT(*) FROM user_skill_profiles WHERE user_id='legacy'"
        ).fetchone()[0]
    assert rows == 1
    assert revision(db) == HEAD


def test_assessment_sessions_unique_request_and_active_index(tmp_path):
    db = _ability_db(tmp_path)
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO assessment_sessions "
            "(id, user_id, kind, status, client_request_id, started_at) "
            "VALUES ('s1', 'u1', 'self_assess', 'submitted', 'req-1', 1)"
        )
        # 幂等键：同一用户 + 同一 client_request_id 只能一条。
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO assessment_sessions "
                "(id, user_id, kind, status, client_request_id, started_at) "
                "VALUES ('s2', 'u1', 'self_assess', 'submitted', 'req-1', 2)"
            )
        conn.rollback()
        # 部分唯一索引：同一用户同一 kind 最多一个 in_progress。
        conn.execute(
            "INSERT INTO assessment_sessions "
            "(id, user_id, kind, status, started_at) "
            "VALUES ('a1', 'u2', 'self_assess', 'in_progress', 1)"
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO assessment_sessions "
                "(id, user_id, kind, status, started_at) "
                "VALUES ('a2', 'u2', 'self_assess', 'in_progress', 2)"
            )
        conn.rollback()
        # 不同 kind 的进行中会话可以并存。
        conn.execute(
            "INSERT INTO assessment_sessions "
            "(id, user_id, kind, status, started_at) "
            "VALUES ('a3', 'u2', 'quick_check', 'in_progress', 3)"
        )
        conn.commit()


def conn_description(db_path):
    """sqlite3.Row/dict 辅助：返回列名顺序。"""
    with sqlite3.connect(db_path) as conn:
        return [row[1] for row in conn.execute("PRAGMA table_info(user_skill_profiles)")]
