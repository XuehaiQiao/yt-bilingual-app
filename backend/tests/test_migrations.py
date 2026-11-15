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
HEAD = "0012_exam"


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
    assert {
        "users", "sessions", "learning_events",
        "ai_usage", "ai_quota", "jobs",
        "word_states", "review_logs", "word_sources",
        "content_items", "questions", "attempts",
        "watch_events", "weekly_reports",
        "placement_sessions", "placement_answers", "user_profiles",
        "discover_queries",
        "articles", "article_paragraphs", "article_translations", "article_progress",
        "exam_sessions", "exam_answers",
        "alembic_version",
    } <= tables
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


    # 成本账本 + 日配额表（0003_cost_ledger）
    usage = columns(db, "ai_usage")
    assert list(usage) == [
        "id",
        "user_id",
        "feature",
        "model_id",
        "provider",
        "input_tokens",
        "output_tokens",
        "calls",
        "est_cost_usd",
        "occurred_at",
        "created_at",
        "usage_date",
        "target_lang",
    ]
    assert usage["id"]["pk"] == 1
    assert usage["feature"]["notnull"] == 1
    assert usage["model_id"]["notnull"] == 1
    assert usage["input_tokens"]["notnull"] == 1
    assert usage["est_cost_usd"]["notnull"] == 1
    assert usage["occurred_at"]["notnull"] == 1
    assert usage["usage_date"]["notnull"] == 1
    # 0004_target_lang：可空 + 默认 zh-CN（旧数据不改写，读出默认值）
    assert usage["target_lang"]["notnull"] == 0
    assert "zh-CN" in str(usage["target_lang"]["default"])

    usage_indexes = index_names(db, "ai_usage")
    assert "ix_ai_usage_user_day" in usage_indexes
    assert "ix_ai_usage_feature_day" in usage_indexes
    assert "ix_ai_usage_day" in usage_indexes

    quota = columns(db, "ai_quota")
    assert list(quota) == ["user_id", "day", "feature", "used_units", "limit_units"]
    assert [quota[c]["pk"] for c in ("user_id", "day", "feature")] == [1, 2, 3]
    assert quota["used_units"]["notnull"] == 1
    assert quota["limit_units"]["notnull"] == 1

    # 任务表（0005_jobs）：字段契约 + 用户/时间索引 + 未完成任务的部分唯一索引
    task_table = columns(db, "jobs")
    assert list(task_table) == [
        "id",
        "user_id",
        "kind",
        "content_ref",
        "target_lang",
        "status",
        "cursor",
        "payload",
        "error",
        "created_at",
        "updated_at",
    ]
    assert task_table["id"]["pk"] == 1
    assert task_table["id"]["notnull"] == 1  # SQLAlchemy 建表默认带 NOT NULL
    for required in (
        "user_id", "kind", "content_ref", "target_lang",
        "status", "cursor", "created_at", "updated_at",
    ):
        assert task_table[required]["notnull"] == 1, required
    assert task_table["payload"]["notnull"] == 0
    assert task_table["error"]["notnull"] == 0
    assert "zh-CN" in str(task_table["target_lang"]["default"])
    assert "queued" in str(task_table["status"]["default"])

    job_indexes = index_names(db, "jobs")
    assert "ix_jobs_user_created" in job_indexes
    assert "ux_jobs_active" in job_indexes
    # 部分唯一索引只约束未完成状态：done/failed 的历史任务可以并存
    with sqlite3.connect(db) as conn:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_jobs_active'"
        ).fetchone()
    assert row and "UNIQUE" in row[0].upper() and "WHERE status IN" in row[0]

    # CHECK 约束：状态拼错写不进去（内部写入路径兜底）
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO jobs (id, user_id, kind, content_ref, target_lang, status, "
            "cursor, payload, error, created_at, updated_at) "
            "VALUES ('j1', 'u1', 'process_video', 'vid', 'zh-CN', 'queued', 0, NULL, "
            "NULL, 1, 1)"
        )
        # 同一 (user, content, lang) 只能有一条未完成 job
        try:
            conn.execute(
                "INSERT INTO jobs (id, user_id, kind, content_ref, target_lang, status, "
                "cursor, payload, error, created_at, updated_at) "
                "VALUES ('j2', 'u1', 'process_video', 'vid', 'zh-CN', 'partial', 0, NULL, "
                "NULL, 2, 2)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("ux_jobs_active 应阻止同一内容出现两条未完成 job")
        conn.execute("UPDATE jobs SET status='done' WHERE id='j1'")
        # 完成后可以再建一条新的未完成任务
        conn.execute(
            "INSERT INTO jobs (id, user_id, kind, content_ref, target_lang, status, "
            "cursor, payload, error, created_at, updated_at) "
            "VALUES ('j3', 'u1', 'process_video', 'vid', 'zh-CN', 'queued', 0, NULL, "
            "NULL, 3, 3)"
        )
        try:
            conn.execute("UPDATE jobs SET status='bogus' WHERE id='j1'")
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("jobs.status CHECK 应拒绝未知状态")
        conn.rollback()

    # 复习引擎三表（0006_review_engine）
    word_states = columns(db, "word_states")
    assert list(word_states) == [
        "id",
        "user_id",
        "lemma",
        "target_lang",
        "state",
        "due_at",
        "stability",
        "difficulty",
        "reps",
        "lapses",
        "step",
        "fail_streak",
        "last_reviewed_at",
        "created_at",
    ]
    assert word_states["id"]["pk"] == 1
    assert word_states["id"]["notnull"] == 1
    for required in (
        "user_id", "lemma", "target_lang", "state", "due_at",
        "reps", "lapses", "step", "fail_streak", "created_at",
    ):
        assert word_states[required]["notnull"] == 1, required
    assert word_states["stability"]["notnull"] == 0
    assert word_states["difficulty"]["notnull"] == 0
    assert word_states["last_reviewed_at"]["notnull"] == 0
    assert "zh-CN" in str(word_states["target_lang"]["default"])
    assert "new" in str(word_states["state"]["default"])

    state_indexes = index_names(db, "word_states")
    assert "ix_word_states_user_due" in state_indexes
    # UNIQUE(user_id, lemma, target_lang)：列组合唯一（SQLite 用自动索引表达）
    with sqlite3.connect(db) as conn:
        unique_sets = []
        for row in conn.execute("PRAGMA index_list(word_states)"):
            if row[2]:
                unique_sets.append(
                    tuple(
                        col[2]
                        for col in conn.execute(f"PRAGMA index_info({row[1]})")
                    )
                )
    assert ("user_id", "lemma", "target_lang") in unique_sets

    review_logs = columns(db, "review_logs")
    assert list(review_logs) == [
        "id",
        "user_id",
        "lemma",
        "target_lang",
        "rating",
        "state_before",
        "state_after",
        "reviewed_at",
        "elapsed_ms",
    ]
    assert review_logs["id"]["pk"] == 1
    for required in (
        "user_id", "lemma", "target_lang", "rating",
        "state_before", "state_after", "reviewed_at",
    ):
        assert review_logs[required]["notnull"] == 1, required
    assert review_logs["elapsed_ms"]["notnull"] == 0
    assert "ix_review_logs_user_reviewed" in index_names(db, "review_logs")

    word_sources = columns(db, "word_sources")
    assert list(word_sources) == [
        "word_state_id",
        "content_ref",
        "sentence_id",
        "created_at",
    ]
    assert word_sources["word_state_id"]["notnull"] == 1
    assert word_sources["content_ref"]["notnull"] == 0
    assert word_sources["sentence_id"]["notnull"] == 0
    assert "ix_word_sources_word_state" in index_names(db, "word_sources")
    with sqlite3.connect(db) as conn:
        fk_rows = conn.execute("PRAGMA foreign_key_list(word_sources)").fetchall()
    assert any(
        row[2] == "word_states"
        and row[3] == "word_state_id"
        and row[4] == "id"
        and row[6] == "CASCADE"
        for row in fk_rows
    ), "word_sources 应外键引用 word_states(id) ON DELETE CASCADE"

    # 理解题三表（0007_quiz）
    content_items = columns(db, "content_items")
    assert list(content_items) == [
        "id",
        "user_id",
        "kind",
        "content_ref",
        "target_lang",
        "content_hash",
        "title",
        "status",
        "prompt_version",
        "created_at",
    ]
    assert content_items["id"]["pk"] == 1
    assert content_items["id"]["notnull"] == 1
    for required in (
        "user_id", "kind", "content_ref", "target_lang", "content_hash",
        "title", "status", "prompt_version", "created_at",
    ):
        assert content_items[required]["notnull"] == 1, required
    assert "zh-CN" in str(content_items["target_lang"]["default"])
    assert "draft" in str(content_items["status"]["default"])
    assert "quiz.v1" in str(content_items["prompt_version"]["default"])

    with sqlite3.connect(db) as conn:
        content_unique_sets = []
        for row in conn.execute("PRAGMA index_list(content_items)"):
            if row[2]:
                content_unique_sets.append(
                    tuple(
                        col[2]
                        for col in conn.execute(f"PRAGMA index_info({row[1]})")
                    )
                )
    assert ("user_id", "content_ref", "target_lang") in content_unique_sets

    questions = columns(db, "questions")
    assert list(questions) == [
        "id",
        "content_item_id",
        "ordinal",
        "question_type",
        "prompt",
        "options",
        "answer_index",
        "evidence_block_id",
        "evidence_start",
        "evidence_end",
        "explanation",
        "status",
        "model",
        "created_at",
    ]
    assert questions["id"]["pk"] == 1
    assert questions["id"]["notnull"] == 1
    for required in (
        "content_item_id", "ordinal", "question_type", "prompt", "options",
        "answer_index", "explanation", "status", "created_at",
    ):
        assert questions[required]["notnull"] == 1, required
    for optional in (
        "evidence_block_id", "evidence_start", "evidence_end", "model",
    ):
        assert questions[optional]["notnull"] == 0, optional
    assert "draft" in str(questions["status"]["default"])
    assert "ix_questions_content_item" in index_names(db, "questions")

    attempts = columns(db, "attempts")
    assert list(attempts) == [
        "id",
        "user_id",
        "question_id",
        "chosen_index",
        "is_correct",
        "answered_at",
        "elapsed_ms",
    ]
    assert attempts["id"]["pk"] == 1
    for required in (
        "user_id", "question_id", "chosen_index", "is_correct", "answered_at",
    ):
        assert attempts[required]["notnull"] == 1, required
    assert attempts["elapsed_ms"]["notnull"] == 0
    attempt_indexes = index_names(db, "attempts")
    assert "ix_attempts_user_answered" in attempt_indexes
    assert "ix_attempts_question" in attempt_indexes

    with sqlite3.connect(db) as conn:
        fk_rows = conn.execute("PRAGMA foreign_key_list(questions)").fetchall()
        assert any(
            row[2] == "content_items"
            and row[3] == "content_item_id"
            and row[4] == "id"
            and row[6] == "CASCADE"
            for row in fk_rows
        ), "questions 应外键引用 content_items(id) ON DELETE CASCADE"
        fk_rows = conn.execute("PRAGMA foreign_key_list(attempts)").fetchall()
        assert any(
            row[2] == "questions"
            and row[3] == "question_id"
            and row[4] == "id"
            and row[6] == "CASCADE"
            for row in fk_rows
        ), "attempts 应外键引用 questions(id) ON DELETE CASCADE"

    # 观看事件 + 周报快照（0008_weekly_report）
    watch_events = columns(db, "watch_events")
    assert list(watch_events) == [
        "id",
        "user_id",
        "guest_hash",
        "content_ref",
        "kind",
        "target_lang",
        "watched_seconds",
        "position_seconds",
        "occurred_at",
        "client_event_id",
    ]
    assert watch_events["id"]["pk"] == 1
    for required in (
        "user_id",
        "content_ref",
        "kind",
        "target_lang",
        "watched_seconds",
        "position_seconds",
        "occurred_at",
        "client_event_id",
    ):
        assert watch_events[required]["notnull"] == 1, required
    assert watch_events["guest_hash"]["notnull"] == 0
    assert "zh-CN" in str(watch_events["target_lang"]["default"])
    assert "ix_watch_events_user_occurred" in index_names(db, "watch_events")

    with sqlite3.connect(db) as conn:
        unique_sets = []
        for row in conn.execute("PRAGMA index_list(watch_events)"):
            if row[2]:
                unique_sets.append(
                    tuple(
                        col[2]
                        for col in conn.execute(f"PRAGMA index_info({row[1]})")
                    )
                )
    assert ("user_id", "client_event_id") in unique_sets

    reports = columns(db, "weekly_reports")
    assert list(reports) == [
        "id",
        "user_id",
        "week_start",
        "payload",
        "created_at",
    ]
    assert reports["id"]["pk"] == 1
    for required in ("user_id", "week_start", "payload", "created_at"):
        assert reports[required]["notnull"] == 1, required
    assert reports["week_start"]["type"] == "DATE"
    with sqlite3.connect(db) as conn:
        unique_sets = []
        for row in conn.execute("PRAGMA index_list(weekly_reports)"):
            if row[2]:
                unique_sets.append(
                    tuple(
                        col[2]
                        for col in conn.execute(f"PRAGMA index_info({row[1]})")
                    )
                )
    assert ("user_id", "week_start") in unique_sets

    # CHECK / UNIQUE 由数据库兜底：非法 kind、负数秒、重复 clientEventId 都写不进。
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO watch_events (user_id, guest_hash, content_ref, kind, "
            "target_lang, watched_seconds, position_seconds, occurred_at, "
            "client_event_id) VALUES ('u1', NULL, 'vid1', 'video', 'zh-CN', "
            "60, 10, 1000, 'c1')"
        )
        try:
            conn.execute(
                "INSERT INTO watch_events (user_id, guest_hash, content_ref, kind, "
                "target_lang, watched_seconds, position_seconds, occurred_at, "
                "client_event_id) VALUES ('u1', NULL, 'vid1', 'video', 'zh-CN', "
                "60, 10, 1001, 'c1')"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError(
                "UNIQUE(user_id, client_event_id) 应阻止重复上报"
            )
        try:
            conn.execute("UPDATE watch_events SET kind='audio' WHERE id=1")
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("watch_events.kind CHECK 应拒绝未知类型")
        try:
            conn.execute("UPDATE watch_events SET watched_seconds=-1 WHERE id=1")
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("watch_events.watched_seconds CHECK 应拒绝负数")

        conn.execute(
            "INSERT INTO weekly_reports (user_id, week_start, payload, created_at) "
            "VALUES ('u1', '2026-11-09', '{}', 1000)"
        )
        try:
            conn.execute(
                "INSERT INTO weekly_reports (user_id, week_start, payload, created_at) "
                "VALUES ('u1', '2026-11-09', '{}', 1001)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError(
                "UNIQUE(user_id, week_start) 应阻止同一周写两份快照"
            )
        conn.rollback()

    # 定位测三表（0009_placement）
    sessions = columns(db, "placement_sessions")
    assert list(sessions) == [
        "id",
        "user_id",
        "guest_hash",
        "status",
        "started_at",
        "submitted_at",
        "duration_ms",
        "score",
        "cefr",
        "confidence",
        "breakdown",
    ]
    assert sessions["id"]["pk"] == 1
    assert sessions["id"]["notnull"] == 1
    for required in ("user_id", "status", "started_at"):
        assert sessions[required]["notnull"] == 1, required
    for optional in (
        "guest_hash", "submitted_at", "duration_ms", "score", "cefr",
        "confidence", "breakdown",
    ):
        assert sessions[optional]["notnull"] == 0, optional
    assert "in_progress" in str(sessions["status"]["default"])
    session_indexes = index_names(db, "placement_sessions")
    assert "ix_placement_sessions_user_started" in session_indexes
    assert "ux_placement_sessions_active" in session_indexes
    with sqlite3.connect(db) as conn:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='index' "
            "AND name='ux_placement_sessions_active'"
        ).fetchone()
    assert row and "UNIQUE" in row[0].upper()
    assert "WHERE status = 'in_progress'" in row[0]

    answers = columns(db, "placement_answers")
    assert list(answers) == [
        "id",
        "session_id",
        "item_id",
        "item_type",
        "chosen_index",
        "correct",
        "difficulty_band",
        "answered_at",
    ]
    assert answers["id"]["pk"] == 1
    for required in (
        "session_id", "item_id", "item_type", "chosen_index", "correct",
        "difficulty_band", "answered_at",
    ):
        assert answers[required]["notnull"] == 1, required
    with sqlite3.connect(db) as conn:
        fk_rows = conn.execute("PRAGMA foreign_key_list(placement_answers)").fetchall()
        assert any(
            row[2] == "placement_sessions"
            and row[3] == "session_id"
            and row[4] == "id"
            and row[6] == "CASCADE"
            for row in fk_rows
        ), "placement_answers 应外键引用 placement_sessions(id) ON DELETE CASCADE"
        unique_sets = []
        for row in conn.execute("PRAGMA index_list(placement_answers)"):
            if row[2]:
                unique_sets.append(
                    tuple(
                        col[2]
                        for col in conn.execute(f"PRAGMA index_info({row[1]})")
                    )
                )
    assert ("session_id", "item_id") in unique_sets

    profiles = columns(db, "user_profiles")
    assert list(profiles) == [
        "user_id",
        "cefr",
        "level_band_low",
        "level_band_high",
        "vocab_estimate",
        "reading_estimate",
        "confidence",
        "pseudo_word_suspicion",
        "updated_at",
        "source",
    ]
    assert profiles["user_id"]["pk"] == 1
    assert profiles["user_id"]["notnull"] == 1
    for required in (
        "cefr", "level_band_low", "level_band_high", "confidence",
        "pseudo_word_suspicion", "updated_at", "source",
    ):
        assert profiles[required]["notnull"] == 1, required
    assert profiles["vocab_estimate"]["notnull"] == 0
    assert profiles["reading_estimate"]["notnull"] == 0
    assert "placement" in str(profiles["source"]["default"])
    assert "0" in str(profiles["pseudo_word_suspicion"]["default"])

    # CHECK / UNIQUE / FK 由数据库兜底：未完成会话唯一、跳过记为 -1、非法状态/
    # 选项/难度带/来源/置信度都写不进去。
    with sqlite3.connect(db) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute(
            "INSERT INTO placement_sessions (id, user_id, guest_hash, status, "
            "started_at) VALUES ('ps1', 'u-plc', NULL, 'in_progress', 1000)"
        )
        try:
            conn.execute(
                "INSERT INTO placement_sessions (id, user_id, guest_hash, status, "
                "started_at) VALUES ('ps2', 'u-plc', NULL, 'in_progress', 1001)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError(
                "ux_placement_sessions_active 应阻止同一用户两个未完成会话"
            )
        try:
            conn.execute("UPDATE placement_sessions SET status='bogus' WHERE id='ps1'")
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("placement_sessions.status CHECK 应拒绝未知状态")
        conn.execute(
            "UPDATE placement_sessions SET status='submitted' WHERE id='ps1'"
        )
        conn.execute(
            "INSERT INTO placement_sessions (id, user_id, guest_hash, status, "
            "started_at) VALUES ('ps2', 'u-plc', NULL, 'in_progress', 1001)"
        )

        conn.execute(
            "INSERT INTO placement_answers (session_id, item_id, item_type, "
            "chosen_index, correct, difficulty_band, answered_at) "
            "VALUES ('ps2', 'v-001', 'vocab', -1, 0, 'A1', 1000)"
        )
        try:
            conn.execute(
                "INSERT INTO placement_answers (session_id, item_id, item_type, "
                "chosen_index, correct, difficulty_band, answered_at) "
                "VALUES ('ps2', 'v-001', 'vocab', 0, 0, 'A1', 1001)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError(
                "UNIQUE(session_id, item_id) 应阻止同一会话重复作答"
            )
        try:
            conn.execute(
                "INSERT INTO placement_answers (session_id, item_id, item_type, "
                "chosen_index, correct, difficulty_band, answered_at) "
                "VALUES ('ps2', 'v-002', 'vocab', 4, 0, 'A1', 1002)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("placement_answers.chosen_index CHECK 应拒绝 4")
        try:
            conn.execute(
                "INSERT INTO placement_answers (session_id, item_id, item_type, "
                "chosen_index, correct, difficulty_band, answered_at) "
                "VALUES ('ps2', 'v-003', 'audio', 0, 0, 'A1', 1003)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("placement_answers.item_type CHECK 应拒绝 audio")
        try:
            conn.execute(
                "INSERT INTO placement_answers (session_id, item_id, item_type, "
                "chosen_index, correct, difficulty_band, answered_at) "
                "VALUES ('missing', 'v-004', 'vocab', 0, 0, 'A1', 1004)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("placement_answers 外键应拒绝不存在的 session_id")

        conn.execute(
            "INSERT INTO user_profiles (user_id, cefr, level_band_low, "
            "level_band_high, vocab_estimate, reading_estimate, confidence, "
            "pseudo_word_suspicion, updated_at, source) "
            "VALUES ('u-plc', 'A1–A2', 'A1', 'A2', 1500, 'A1', 0.5, 0.0, 1000, "
            "'placement')"
        )
        try:
            conn.execute(
                "INSERT INTO user_profiles (user_id, cefr, level_band_low, "
                "level_band_high, confidence, pseudo_word_suspicion, updated_at, "
                "source) VALUES ('u-plc', 'A1–A2', 'A1', 'A2', 0.5, 0.0, 1001, "
                "'placement')"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("user_profiles.user_id PRIMARY KEY 应阻止重复画像")
        try:
            conn.execute(
                "UPDATE user_profiles SET confidence=1.5 WHERE user_id='u-plc'"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("user_profiles.confidence CHECK 应拒绝 1.5")
        try:
            conn.execute(
                "UPDATE user_profiles SET source='imported' WHERE user_id='u-plc'"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("user_profiles.source CHECK 应拒绝未知来源")
        conn.rollback()

    # 理解题三表的 CHECK / UNIQUE / FK 由数据库兜底。
    with sqlite3.connect(db) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute(
            "INSERT INTO content_items (id, user_id, kind, content_ref, "
            "target_lang, content_hash, title, status, prompt_version, created_at) "
            "VALUES ('ci1', 'u1', 'video', 'vid1', 'zh-CN', 'hash', 'Title', "
            "'ready', 'quiz.v1', 1000)"
        )
        try:
            conn.execute(
                "INSERT INTO content_items (id, user_id, kind, content_ref, "
                "target_lang, content_hash, title, status, prompt_version, created_at) "
                "VALUES ('ci2', 'u1', 'video', 'vid1', 'zh-CN', 'hash2', 'Title2', "
                "'ready', 'quiz.v1', 1001)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError(
                "UNIQUE(user_id, content_ref, target_lang) 应阻止重复内容项"
            )
        try:
            conn.execute("UPDATE content_items SET kind='audio' WHERE id='ci1'")
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("content_items.kind CHECK 应拒绝未知类型")
        try:
            conn.execute("UPDATE content_items SET status='published' WHERE id='ci1'")
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("content_items.status CHECK 应拒绝未知状态")

        conn.execute(
            "INSERT INTO questions (id, content_item_id, ordinal, question_type, "
            "prompt, options, answer_index, evidence_block_id, evidence_start, "
            "evidence_end, explanation, status, model, created_at) "
            "VALUES ('q1', 'ci1', 1, 'mcq', 'Question?', '[\"a\",\"b\",\"c\",\"d\"]', "
            "0, '1', 1000, 3000, 'explanation', 'approved', 'model-x', 1000)"
        )
        try:
            conn.execute(
                "INSERT INTO questions (id, content_item_id, ordinal, question_type, "
                "prompt, options, answer_index, explanation, status, created_at) "
                "VALUES ('q2', 'ci1', 2, 'essay', 'Q?', '[]', 0, '', 'approved', 1000)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("questions.question_type CHECK 应拒绝未知题型")
        try:
            conn.execute(
                "INSERT INTO questions (id, content_item_id, ordinal, question_type, "
                "prompt, options, answer_index, explanation, status, created_at) "
                "VALUES ('q3', 'ci1', 3, 'mcq', 'Q?', '[]', 0, '', 'pending', 1000)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("questions.status CHECK 应拒绝未知状态")

        conn.execute(
            "INSERT INTO attempts (user_id, question_id, chosen_index, is_correct, "
            "answered_at, elapsed_ms) "
            "VALUES ('u1', 'q1', 2, 0, 1000, 1234)"
        )
        try:
            conn.execute(
                "INSERT INTO attempts (user_id, question_id, chosen_index, is_correct, "
                "answered_at) VALUES ('u1', 'q1', 0, 2, 1001)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("attempts.is_correct CHECK 应只允许 0/1")
        try:
            conn.execute(
                "INSERT INTO attempts (user_id, question_id, chosen_index, is_correct, "
                "answered_at) VALUES ('u1', 'missing-question', 0, 1, 1002)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("attempts 外键应拒绝不存在的 question_id")
        conn.rollback()

    # CHECK / UNIQUE 由数据库兜底：重复词、非法 state、非法 rating、孤儿来源都写不进去。
    with sqlite3.connect(db) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute(
            "INSERT INTO word_states (id, user_id, lemma, target_lang, state, "
            "due_at, reps, lapses, step, fail_streak, created_at) "
            "VALUES ('ws1', 'u1', 'hello', 'zh-CN', 'new', 1000, 0, 0, 0, 0, 1000)"
        )
        try:
            conn.execute(
                "INSERT INTO word_states (id, user_id, lemma, target_lang, state, "
                "due_at, reps, lapses, step, fail_streak, created_at) "
                "VALUES ('ws2', 'u1', 'hello', 'zh-CN', 'new', 1000, 0, 0, 0, 0, 1000)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("UNIQUE(user_id, lemma, target_lang) 应阻止重复词")
        try:
            conn.execute("UPDATE word_states SET state='bogus' WHERE id='ws1'")
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("word_states.state CHECK 应拒绝未知状态")

        conn.execute(
            "INSERT INTO review_logs (user_id, lemma, target_lang, rating, "
            "state_before, state_after, reviewed_at, elapsed_ms) "
            "VALUES ('u1', 'hello', 'zh-CN', 'good', '{}', '{}', 1000, 12)"
        )
        try:
            conn.execute(
                "INSERT INTO review_logs (user_id, lemma, target_lang, rating, "
                "state_before, state_after, reviewed_at, elapsed_ms) "
                "VALUES ('u1', 'hello', 'zh-CN', 'perfect', '{}', '{}', 1001, 12)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("review_logs.rating CHECK 应拒绝未知评分")

        conn.execute(
            "INSERT INTO word_sources (word_state_id, content_ref, sentence_id, "
            "created_at) VALUES ('ws1', 'vid1', 's1', 1000)"
        )
        try:
            conn.execute(
                "INSERT INTO word_sources (word_state_id, content_ref, sentence_id, "
                "created_at) VALUES ('missing', 'vid1', 's1', 1000)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("word_sources 外键应拒绝不存在的 word_state_id")
        conn.rollback()

    # 内容发现缓存（0010_discover）：检索词审计 + 24h 缓存，不存字幕正文
    discover_queries = columns(db, "discover_queries")
    assert list(discover_queries) == [
        "id",
        "user_id",
        "query_hash",
        "query",
        "target_lang",
        "result",
        "created_at",
        "expires_at",
    ]
    assert discover_queries["id"]["pk"] == 1
    assert discover_queries["id"]["notnull"] == 1
    assert discover_queries["user_id"]["notnull"] == 0, "user_id 可空（脚本/运维审计）"
    for required in (
        "query_hash", "query", "target_lang", "result", "created_at", "expires_at",
    ):
        assert discover_queries[required]["notnull"] == 1, required
    assert "zh-CN" in str(discover_queries["target_lang"]["default"])
    assert "ix_discover_queries_expires" in index_names(db, "discover_queries")

    with sqlite3.connect(db) as conn:
        unique_sets = []
        for row in conn.execute("PRAGMA index_list(discover_queries)"):
            if row[2]:
                unique_sets.append(
                    tuple(
                        col[2]
                        for col in conn.execute(f"PRAGMA index_info({row[1]})")
                    )
                )
        assert ("query_hash", "target_lang") in unique_sets

        conn.execute(
            "INSERT INTO discover_queries "
            "(user_id, query_hash, query, target_lang, result, created_at, expires_at) "
            "VALUES (NULL, 'h1', 'TED talk about AI', 'zh-CN', '{}', 1000, 2000)"
        )
        try:
            conn.execute(
                "INSERT INTO discover_queries "
                "(user_id, query_hash, query, target_lang, result, created_at, "
                "expires_at) VALUES ('u1', 'h1', 'same hash', 'zh-CN', '{}', 1001, 2001)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError(
                "UNIQUE(query_hash, target_lang) 应阻止同语言重复缓存"
            )
        # 同一 query_hash 的不同目标语言是两条独立缓存。
        conn.execute(
            "INSERT INTO discover_queries "
            "(user_id, query_hash, query, target_lang, result, created_at, expires_at) "
            "VALUES ('u1', 'h1', 'same hash', 'vi-VN', '{}', 1002, 2002)"
        )
        conn.rollback()

    # 考试练习两表（0012_exam）：会话只存卷面 id，作答只存已答题，不存分数。
    exam_sessions = columns(db, "exam_sessions")
    assert list(exam_sessions) == [
        "id",
        "user_id",
        "exam_type",
        "status",
        "item_ids",
        "started_at",
        "submitted_at",
        "duration_ms",
    ]
    assert exam_sessions["id"]["pk"] == 1
    assert exam_sessions["id"]["notnull"] == 1
    for required in (
        "user_id", "exam_type", "status", "item_ids", "started_at",
    ):
        assert exam_sessions[required]["notnull"] == 1, required
    assert exam_sessions["submitted_at"]["notnull"] == 0
    assert exam_sessions["duration_ms"]["notnull"] == 0
    assert "in_progress" in str(exam_sessions["status"]["default"])
    session_indexes = index_names(db, "exam_sessions")
    assert "ix_exam_sessions_user_started" in session_indexes
    assert "ix_exam_sessions_user_submitted" in session_indexes
    assert "ux_exam_sessions_active" in session_indexes
    with sqlite3.connect(db) as conn:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='index' "
            "AND name='ux_exam_sessions_active'"
        ).fetchone()
    assert row and "UNIQUE" in row[0].upper()
    assert "WHERE status = 'in_progress'" in row[0]

    exam_answers = columns(db, "exam_answers")
    assert list(exam_answers) == [
        "session_id",
        "item_id",
        "chosen_index",
        "correct",
        "answered_at",
    ]
    assert exam_answers["session_id"]["pk"] == 1
    assert exam_answers["item_id"]["pk"] == 2
    for required in (
        "session_id", "item_id", "chosen_index", "correct", "answered_at",
    ):
        assert exam_answers[required]["notnull"] == 1, required
    with sqlite3.connect(db) as conn:
        fk_rows = conn.execute("PRAGMA foreign_key_list(exam_answers)").fetchall()
    assert any(
        row[2] == "exam_sessions"
        and row[3] == "session_id"
        and row[4] == "id"
        and row[6] == "CASCADE"
        for row in fk_rows
    ), "exam_answers 应外键引用 exam_sessions(id) ON DELETE CASCADE"

    # CHECK / UNIQUE / FK 由数据库兜底：同一用户一个未完成会话、状态/用时/
    # 选项/正确标记非法都写不进去，重复作答与孤儿作答也会被拒绝。
    with sqlite3.connect(db) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute(
            "INSERT INTO exam_sessions "
            "(id, user_id, exam_type, status, item_ids, started_at) "
            "VALUES ('es1', 'u-exam', 'cet4', 'in_progress', '[]', 1000)"
        )
        try:
            conn.execute(
                "INSERT INTO exam_sessions "
                "(id, user_id, exam_type, status, item_ids, started_at) "
                "VALUES ('es2', 'u-exam', 'cet4', 'in_progress', '[]', 1001)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError(
                "ux_exam_sessions_active 应阻止同一用户两个未提交会话"
            )
        try:
            conn.execute("UPDATE exam_sessions SET status='abandoned' WHERE id='es1'")
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("exam_sessions.status CHECK 应拒绝未知状态")
        try:
            conn.execute(
                "UPDATE exam_sessions SET duration_ms=-1 WHERE id='es1'"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("exam_sessions.duration_ms CHECK 应拒绝负数")
        conn.execute("UPDATE exam_sessions SET status='submitted' WHERE id='es1'")
        conn.execute(
            "INSERT INTO exam_sessions "
            "(id, user_id, exam_type, status, item_ids, started_at) "
            "VALUES ('es2', 'u-exam', 'cet4', 'in_progress', '[]', 1001)"
        )

        conn.execute(
            "INSERT INTO exam_answers "
            "(session_id, item_id, chosen_index, correct, answered_at) "
            "VALUES ('es2', 'v-002', 0, 0, 1000)"
        )
        try:
            conn.execute(
                "INSERT INTO exam_answers "
                "(session_id, item_id, chosen_index, correct, answered_at) "
                "VALUES ('es2', 'v-002', 1, 1, 1001)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError(
                "PRIMARY KEY(session_id, item_id) 应阻止同一会话重复作答"
            )
        try:
            conn.execute(
                "INSERT INTO exam_answers "
                "(session_id, item_id, chosen_index, correct, answered_at) "
                "VALUES ('es2', 'v-003', 4, 0, 1002)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("exam_answers.chosen_index CHECK 应拒绝 4")
        try:
            conn.execute(
                "INSERT INTO exam_answers "
                "(session_id, item_id, chosen_index, correct, answered_at) "
                "VALUES ('es2', 'v-004', 0, 2, 1003)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("exam_answers.correct CHECK 应只允许 0/1")
        try:
            conn.execute(
                "INSERT INTO exam_answers "
                "(session_id, item_id, chosen_index, correct, answered_at) "
                "VALUES ('missing', 'v-005', 0, 0, 1004)"
            )
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError("exam_answers 外键应拒绝不存在的 session_id")
        conn.rollback()


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

    # 所有迁移的 down 都执行过：业务表清空，只剩 alembic 版本表
    assert table_names(db) == {"alembic_version"}
    assert revision(db) is None

    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head (after downgrade)")
    assert {"users", "sessions", "learning_events"} <= table_names(db)


def test_review_engine_downgrade_to_0005_and_back(tmp_path):
    """0006 单独回滚：只删复习三表，jobs 与更早的表保留；再升级可恢复。"""
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    assert {"word_states", "review_logs", "word_sources"} <= table_names(db)

    assert_alembic_ok(
        run_alembic(db, "downgrade", "0005_jobs"), "downgrade 0005_jobs"
    )
    assert revision(db) == "0005_jobs"
    remaining = table_names(db)
    assert not ({"word_states", "review_logs", "word_sources"} & remaining)
    assert "jobs" in remaining and "users" in remaining and "sessions" in remaining

    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head (again)")
    assert revision(db) == HEAD
    assert {"word_states", "review_logs", "word_sources"} <= table_names(db)


def test_quiz_downgrade_to_0006_and_back(tmp_path):
    """0007 单独回滚：只删理解题三表，复习/任务/更早的表保留；再升级可恢复。"""
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    assert {"content_items", "questions", "attempts"} <= table_names(db)

    assert_alembic_ok(
        run_alembic(db, "downgrade", "0006_review_engine"), "downgrade 0006_review_engine"
    )
    assert revision(db) == "0006_review_engine"
    remaining = table_names(db)
    assert not ({"content_items", "questions", "attempts"} & remaining)
    assert "word_states" in remaining
    assert "jobs" in remaining and "users" in remaining

    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head (again)")
    assert revision(db) == HEAD
    assert {"content_items", "questions", "attempts"} <= table_names(db)


def test_weekly_report_downgrade_to_0007_and_back(tmp_path):
    """0008 单独回滚：只删观看事件/周报快照，理解题与更早的表保留；再升级可恢复。"""
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    assert {"watch_events", "weekly_reports"} <= table_names(db)

    assert_alembic_ok(run_alembic(db, "downgrade", "0007_quiz"), "downgrade 0007_quiz")
    assert revision(db) == "0007_quiz"
    remaining = table_names(db)
    assert not ({"watch_events", "weekly_reports"} & remaining)
    assert "attempts" in remaining
    assert "word_states" in remaining
    assert "users" in remaining

    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head (again)")
    assert revision(db) == HEAD
    assert {"watch_events", "weekly_reports"} <= table_names(db)


def test_placement_downgrade_to_0008_and_back(tmp_path):
    """0009 单独回滚：只删定位测三表，周报与更早的表保留；再升级可恢复。"""
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    assert {"placement_sessions", "placement_answers", "user_profiles"} <= table_names(db)

    assert_alembic_ok(
        run_alembic(db, "downgrade", "0008_weekly_report"),
        "downgrade 0008_weekly_report",
    )
    assert revision(db) == "0008_weekly_report"
    remaining = table_names(db)
    assert not ({"placement_sessions", "placement_answers", "user_profiles"} & remaining)
    assert "watch_events" in remaining
    assert "weekly_reports" in remaining
    assert "attempts" in remaining
    assert "users" in remaining

    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head (again)")
    assert revision(db) == HEAD
    assert {"placement_sessions", "placement_answers", "user_profiles"} <= table_names(db)


def test_discover_downgrade_to_0009_and_back(tmp_path):
    """0010 单独回滚：只删发现缓存表，定位测与更早的表保留；再升级可恢复。"""
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    assert "discover_queries" in table_names(db)

    assert_alembic_ok(
        run_alembic(db, "downgrade", "0009_placement"),
        "downgrade 0009_placement",
    )
    assert revision(db) == "0009_placement"
    remaining = table_names(db)
    assert "discover_queries" not in remaining
    assert "placement_sessions" in remaining
    assert "user_profiles" in remaining
    assert "users" in remaining

    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head (again)")
    assert revision(db) == HEAD
    assert "discover_queries" in table_names(db)


def test_exam_downgrade_to_0011_and_back(tmp_path):
    """0012 单独回滚：只删考试练习两表，读文章与更早的表保留；再升级可恢复。"""
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    assert {"exam_sessions", "exam_answers"} <= table_names(db)

    assert_alembic_ok(
        run_alembic(db, "downgrade", "0011_reading"), "downgrade 0011_reading"
    )
    assert revision(db) == "0011_reading"
    remaining = table_names(db)
    assert "exam_sessions" not in remaining
    assert "exam_answers" not in remaining
    assert "articles" in remaining
    assert "placement_sessions" in remaining
    assert "users" in remaining

    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head (again)")
    assert revision(db) == HEAD
    assert {"exam_sessions", "exam_answers"} <= table_names(db)
