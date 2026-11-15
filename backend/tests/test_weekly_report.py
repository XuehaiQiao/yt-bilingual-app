"""M5 学习事件上报 + 周报后端离线验收（计划书 §13.2 M5 / specs/015）。

覆盖：

1. 迁移 0008 的表/索引/约束断言在 ``tests/test_migrations.py`` 里（本文件负责
   端点行为）；
2. POST /api/events：批量、幂等、游客、校验（负数/超 24h/未来时间/非法 kind）；
3. GET /api/report/week：3 个数字、事实、下一步、证据（错题优先/最近观看）、
   连续天数、quiz/words 明细；
4. 无数据：0 / null / 明确事实句，快照照写；
5. 周界：UTC 周一 00:00 左闭右开；weekStart 归一到所在周周一；
6. 快照：同周只写一次（后续 GET 不覆盖），不同周各自一份；
7. 用户/游客隔离；未迁移 503。

所有用例离线：时钟 monkeypatch ``reports.now_ms``；数据库在 conftest 的
tmp_path 下通过真实 Alembic CLI 迁移，不联网、不碰 data/app.db。
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

import config
import reports
import storage
from tests.migration_utils import assert_alembic_ok, run_alembic

MONDAY = datetime(2026, 11, 9, tzinfo=timezone.utc)
NOW = MONDAY + timedelta(days=2, hours=12)  # 周三 12:00 UTC
WEEK_START = "2026-11-09"
PASSWORD = "weekly-password-123"


def _ms(value: datetime) -> int:
    return int(value.timestamp() * 1000)


def _upgrade() -> None:
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (weekly)"
    )


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


@pytest.fixture()
def clock(monkeypatch):
    """可推进的注入时钟：改 clock['now']，下一次请求就用新时间。"""
    state = {"now": _ms(NOW)}
    monkeypatch.setattr(reports, "now_ms", lambda: state["now"])
    return state


@pytest.fixture()
def report_db(client):
    """已迁移到 head 的登录客户端。"""
    _upgrade()
    return client


def _watch(
    client_event_id: str,
    *,
    content_ref: str = "vid1",
    kind: str = "video",
    target_lang: str | None = None,
    watched_seconds: int = 60,
    position_seconds: int = 30,
    occurred_at: int | None = None,
) -> dict:
    event = {
        "type": "watch",
        "contentRef": content_ref,
        "kind": kind,
        "watchedSeconds": watched_seconds,
        "positionSeconds": position_seconds,
        "occurredAt": _ms(NOW) if occurred_at is None else occurred_at,
        "clientEventId": client_event_id,
    }
    if target_lang is not None:
        event["targetLang"] = target_lang
    return event


def _post(client, events: list[dict]):
    return client.post("/api/events", json={"events": events})


def _write_video_cache(
    client,
    video_id: str = "vid1",
    *,
    blocks: list[dict] | None = None,
    lang: str = "zh-CN",
) -> str:
    directory = storage.user_history_dir(client.user_id, lang)
    path = f"{directory}/Weekly_{video_id}.json"
    if blocks is None:
        blocks = [
            {
                "id": 1,
                "start": 10.0,
                "end": 13.0,
                "en_text": "The museum opens at nine in the morning.",
                "zh_text": "博物馆早上九点开门。",
            },
            {
                "id": 2,
                "start": 40.0,
                "end": 43.0,
                "en_text": "The cafe on the second floor serves fresh coffee.",
                "zh_text": "二楼的咖啡店供应新鲜咖啡。",
            },
            {
                "id": 3,
                "start": 70.0,
                "end": 74.0,
                "en_text": "Guided tours leave every hour.",
                "zh_text": "导览每小时出发一次。",
            },
        ]
    payload = {
        "videoId": video_id,
        "metadata": {"title": "Weekly Test", "channel": "Test Channel"},
        "transcript": blocks,
        "target_lang": lang,
    }
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    return path


def _seed_attempt(
    user_id: str,
    *,
    suffix: str = "1",
    content_ref: str = "vid1",
    kind: str = "video",
    target_lang: str = "zh-CN",
    answered_at: int | None = None,
    correct: bool = False,
    block_id: str = "1",
    start_ms: int = 10_000,
    end_ms: int = 13_000,
) -> None:
    answered_at = _ms(NOW) if answered_at is None else answered_at
    conn = _db()
    try:
        conn.execute(
            "INSERT INTO content_items (id, user_id, kind, content_ref, "
            "target_lang, content_hash, title, status, prompt_version, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', 'quiz.v1', ?)",
            (f"ci-{suffix}", user_id, kind, content_ref, target_lang, "hash", "T", 1),
        )
        conn.execute(
            "INSERT INTO questions (id, content_item_id, ordinal, question_type, "
            "prompt, options, answer_index, evidence_block_id, evidence_start, "
            "evidence_end, explanation, status, model, created_at) "
            "VALUES (?, ?, 1, 'mcq', 'When does the museum open?', "
            "'[\"At nine\",\"At noon\",\"At night\",\"Never\"]', 0, ?, ?, ?, "
            "'第一句。', 'approved', 'test-model', ?)",
            (
                f"q-{suffix}",
                f"ci-{suffix}",
                block_id,
                start_ms,
                end_ms,
                1,
            ),
        )
        conn.execute(
            "INSERT INTO attempts (user_id, question_id, chosen_index, is_correct, "
            "answered_at, elapsed_ms) VALUES (?, ?, 2, ?, ?, 1200)",
            (user_id, f"q-{suffix}", 1 if correct else 0, answered_at),
        )
        conn.commit()
    finally:
        conn.close()


def _add_attempt(
    user_id: str,
    question_id: str,
    *,
    answered_at: int,
    correct: bool,
) -> None:
    conn = _db()
    try:
        conn.execute(
            "INSERT INTO attempts (user_id, question_id, chosen_index, is_correct, "
            "answered_at, elapsed_ms) VALUES (?, ?, 0, ?, ?, 800)",
            (user_id, question_id, 1 if correct else 0, answered_at),
        )
        conn.commit()
    finally:
        conn.close()


def _seed_word(
    user_id: str,
    lemma: str,
    *,
    state: str = "review",
    due_at: int,
    created_at: int | None = None,
) -> None:
    created_at = _ms(MONDAY) if created_at is None else created_at
    conn = _db()
    try:
        conn.execute(
            "INSERT INTO word_states (id, user_id, lemma, target_lang, state, "
            "due_at, stability, difficulty, reps, lapses, step, fail_streak, "
            "last_reviewed_at, created_at) "
            "VALUES (?, ?, ?, 'zh-CN', ?, ?, NULL, NULL, 0, 0, 0, 0, NULL, ?)",
            (f"ws-{lemma}", user_id, lemma, state, due_at, created_at),
        )
        conn.commit()
    finally:
        conn.close()


def _seed_review(user_id: str, lemma: str, *, reviewed_at: int) -> None:
    conn = _db()
    try:
        conn.execute(
            "INSERT INTO review_logs (user_id, lemma, target_lang, rating, "
            "state_before, state_after, reviewed_at, elapsed_ms) "
            "VALUES (?, ?, 'zh-CN', 'good', '{}', '{}', ?, 900)",
            (user_id, lemma, reviewed_at),
        )
        conn.commit()
    finally:
        conn.close()


def _snapshot_rows(user_id: str) -> list[sqlite3.Row]:
    conn = _db()
    try:
        return conn.execute(
            "SELECT * FROM weekly_reports WHERE user_id = ? ORDER BY week_start",
            (user_id,),
        ).fetchall()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 事件上报
# ---------------------------------------------------------------------------

def test_events_batch_idempotent(report_db, clock):
    events = [
        _watch("c1", content_ref="vid1", watched_seconds=600, position_seconds=120),
        _watch(
            "c2",
            content_ref="vid2",
            watched_seconds=300,
            position_seconds=60,
            occurred_at=_ms(NOW - timedelta(hours=2)),
        ),
    ]
    response = _post(report_db, events)
    assert response.status_code == 200, response.text
    assert response.json() == {"received": 2, "accepted": 2, "duplicated": 0}

    # 整批重复：全部计 duplicated，不重复计数
    response = _post(report_db, events)
    assert response.status_code == 200, response.text
    assert response.json() == {"received": 2, "accepted": 0, "duplicated": 2}

    # 混合：一条旧、一条新
    response = _post(report_db, [events[0], _watch("c3", content_ref="vid3")])
    assert response.json() == {"received": 2, "accepted": 1, "duplicated": 1}

    conn = _db()
    try:
        rows = conn.execute(
            "SELECT * FROM watch_events WHERE user_id = ? ORDER BY id",
            (report_db.user_id,),
        ).fetchall()
    finally:
        conn.close()
    assert len(rows) == 3
    assert rows[0]["client_event_id"] == "c1"
    assert rows[0]["watched_seconds"] == 600
    assert rows[0]["guest_hash"] is None
    assert rows[0]["target_lang"] == "zh-CN"


def test_guest_can_report_and_get_isolated_report(report_db, make_client, clock):
    with make_client() as guest_client:
        response = _post(guest_client, [_watch("guest-1", watched_seconds=600)])
        assert response.status_code == 200, response.text
        assert response.json()["accepted"] == 1

        token = guest_client.cookies.get("ln_guest")
        assert token
        import hashlib

        guest_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        conn = _db()
        try:
            row = conn.execute(
                "SELECT * FROM watch_events WHERE content_ref = 'vid1'"
            ).fetchone()
        finally:
            conn.close()
        assert row["user_id"] == f"guest:{guest_hash}"
        assert row["guest_hash"] == guest_hash

        response = guest_client.get("/api/report/week")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["numbers"]["passiveMinutes"] == 10.0
        # 只有观看、没有作答 → 下一步是理解练习
        assert body["nextStep"] == "明天做一次理解练习"

    # 另一个游客看不到前一个游客的数据
    with make_client() as other_guest:
        response = other_guest.get("/api/report/week")
        assert response.status_code == 200, response.text
        assert response.json()["numbers"] == {
            "passiveMinutes": 0.0,
            "reviewedWords": 0,
            "quizAccuracy": None,
        }

    # 登录用户的周报也不包含游客事件
    response = report_db.get("/api/report/week")
    assert response.status_code == 200, response.text
    assert response.json()["numbers"]["passiveMinutes"] == 0.0


def test_event_validation_is_atomic(report_db, clock):
    now = _ms(NOW)

    cases = [
        (_watch("bad-watched", watched_seconds=-1), "watchedSeconds"),
        (_watch("too-long", watched_seconds=86_401), "watchedSeconds"),
        (_watch("bad-position", position_seconds=-1), "positionSeconds"),
        (_watch("bad-future", occurred_at=now + 6 * 60 * 1000), "occurredAt"),
        (
            {
                **_watch("bad-kind"),
                "kind": "audio",
            },
            "kind",
        ),
        (
            {
                **_watch("bad-type"),
                "type": "quiz",
            },
            "type",
        ),
        (
            {
                key: value
                for key, value in _watch("missing-client").items()
                if key != "clientEventId"
            },
            "clientEventId",
        ),
        (_watch("bad-lang", target_lang="xx-YY"), "不支持的语言代码"),
        (_watch("bad-ref", content_ref=""), "contentRef"),
    ]
    for event, expected in cases:
        response = _post(report_db, [event])
        assert response.status_code == 400, (event, response.text)
        assert expected in response.json()["detail"], response.json()

    # 空批次是合法 no-op
    response = _post(report_db, [])
    assert response.status_code == 200
    assert response.json() == {"received": 0, "accepted": 0, "duplicated": 0}

    # 超过 50 条：整批拒绝
    response = _post(report_db, [_watch(f"bulk-{i}") for i in range(51)])
    assert response.status_code == 400
    assert "最多上报 50 条" in response.json()["detail"]

    # 未来 5 分钟以内允许（时钟误差容忍）
    response = _post(
        report_db, [_watch("near-future", occurred_at=now + 4 * 60 * 1000)]
    )
    assert response.status_code == 200, response.text
    assert response.json()["accepted"] == 1

    # local_show 引用规范化
    response = _post(
        report_db,
        [
            _watch(
                "local-1",
                content_ref="demo-show/S01E02",
                kind="local_show",
            )
        ],
    )
    assert response.status_code == 200, response.text
    conn = _db()
    try:
        rows = conn.execute("SELECT content_ref FROM watch_events").fetchall()
    finally:
        conn.close()
    assert len(rows) == 2
    assert {row["content_ref"] for row in rows} == {"vid1", "demo-show-S01E02"}
    # 9 个非法用例 + 50 条超限 + 空批次都没有写库；只有 2 条合法事件


def test_events_unavailable_before_migration(client, clock):
    # 未跑 0008：事件与周报都返回 503，且不建表
    response = _post(client, [_watch("c1")])
    assert response.status_code == 503
    assert "alembic upgrade head" in response.json()["detail"]
    response = client.get("/api/report/week")
    assert response.status_code == 503


# ---------------------------------------------------------------------------
# 周报聚合
# ---------------------------------------------------------------------------

def test_week_report_full_aggregation(report_db, clock):
    user_id = report_db.user_id
    _write_video_cache(report_db)

    events = [
        _watch(
            "w1",
            content_ref="vid1",
            watched_seconds=600,
            position_seconds=120,
            occurred_at=_ms(MONDAY + timedelta(hours=10)),
        ),
        _watch(
            "w2",
            content_ref="vid1",
            watched_seconds=300,
            position_seconds=130,
            occurred_at=_ms(MONDAY + timedelta(days=1, hours=10)),
        ),
        _watch(
            "w3",
            content_ref="demo-show-S01E01",
            kind="local_show",
            watched_seconds=120,
            position_seconds=10,
            occurred_at=_ms(MONDAY + timedelta(days=2, hours=9)),
        ),
        # 上周六：不进本周数字，也不延长连续天数（周日的空档断开）
        _watch(
            "old",
            content_ref="vid-old",
            watched_seconds=999,
            occurred_at=_ms(MONDAY - timedelta(days=2)),
        ),
    ]
    response = _post(report_db, events)
    assert response.status_code == 200, response.text
    assert response.json()["accepted"] == 4

    # 6 次作答，4 对 2 错；错题证据 block 1（10–13s）
    _seed_attempt(
        user_id,
        suffix="1",
        answered_at=_ms(MONDAY + timedelta(days=1, hours=11)),
        correct=False,
    )
    for index in range(5):
        _add_attempt(
            user_id,
            "q-1",
            answered_at=_ms(MONDAY + timedelta(days=1, hours=12 + index)),
            correct=index < 4,
        )

    # 复习：4 行 / 3 个不同词
    for index, lemma in enumerate(["alpha", "beta", "gamma", "gamma"]):
        _seed_review(
            user_id,
            lemma,
            reviewed_at=_ms(MONDAY + timedelta(days=1, hours=9 + index)),
        )

    # 词状态：本周新增 5 个；到期按「到明天结束」口径 = w1(逾期) + w2
    _seed_word(user_id, "alpha", state="review", due_at=_ms(NOW - timedelta(days=1)))
    _seed_word(user_id, "beta", state="review", due_at=_ms(NOW + timedelta(hours=1)))
    _seed_word(
        user_id,
        "gamma",
        state="learning",
        due_at=_ms(NOW + timedelta(days=2)),
    )
    _seed_word(user_id, "delta", state="suspended", due_at=_ms(NOW + timedelta(hours=1)))
    _seed_word(user_id, "epsilon", state="new", due_at=_ms(NOW + timedelta(hours=1)))

    response = report_db.get("/api/report/week")
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["weekStart"] == WEEK_START
    assert body["weekEnd"] == "2026-11-16"
    assert body["timezone"] == "UTC"
    assert body["numbers"] == {
        "passiveMinutes": 17.0,  # (600 + 300 + 120) / 60
        "reviewedWords": 3,
        "quizAccuracy": 0.6667,
    }
    assert (
        body["fact"]
        == "你本周看了 1 个视频和 1 集剧集，完成 6 道题，复习了 3 个词。"
    )
    assert body["nextStep"] == "复习 2 个到期词"
    assert body["quiz"] == {"attempts": 6, "correct": 4}
    assert body["words"] == {"new": 5, "reviewed": 3, "dueTomorrow": 2}
    assert body["streakDays"] == 3

    evidence = body["evidence"]
    assert evidence["source"] == "quiz_wrong"
    assert evidence["contentRef"] == "vid1"
    assert evidence["kind"] == "video"
    assert evidence["start"] == 10.0
    assert evidence["end"] == 13.0
    assert evidence["startMs"] == 10_000
    assert evidence["endMs"] == 13_000
    assert evidence["durationSeconds"] == 3.0
    assert evidence["sentence"] == "The museum opens at nine in the morning."
    assert evidence["blockId"] == 1

    # 同一周传任意日期都归一到周一
    response = report_db.get("/api/report/week?weekStart=2026-11-11")
    assert response.status_code == 200, response.text
    assert response.json()["weekStart"] == WEEK_START
    assert response.json()["numbers"] == body["numbers"]

    # 快照落库
    rows = _snapshot_rows(user_id)
    assert len(rows) == 1
    assert rows[0]["week_start"] == WEEK_START
    payload = json.loads(rows[0]["payload"])
    assert payload["version"] == 1
    assert payload["report"]["numbers"] == body["numbers"]


def test_week_report_no_data(report_db, clock):
    response = report_db.get("/api/report/week")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["numbers"] == {
        "passiveMinutes": 0.0,
        "reviewedWords": 0,
        "quizAccuracy": None,
    }
    assert body["fact"] == "这周还没有可统计的学习记录。"
    assert body["nextStep"] == "明天先看一个 10 分钟的视频"
    assert body["evidence"] is None
    assert body["streakDays"] == 0
    assert body["quiz"] == {"attempts": 0, "correct": 0}
    assert body["words"] == {"new": 0, "reviewed": 0, "dueTomorrow": 0}
    # 无数据也写快照（未来邮件要能拿到「数据不足」的事实）
    assert len(_snapshot_rows(report_db.user_id)) == 1


def test_week_boundary_monday_utc(report_db, clock):
    monday = datetime(2026, 11, 16, tzinfo=timezone.utc)  # 下周一 00:00 UTC
    clock["now"] = _ms(monday)

    # 上周日最后一毫秒：属于上一周
    response = _post(
        report_db,
        [
            _watch(
                "prev-sunday",
                content_ref="vid-prev",
                watched_seconds=60,
                occurred_at=_ms(monday) - 1,
            )
        ],
    )
    assert response.status_code == 200, response.text
    # 本周一 00:00:00.000：属于本周（左闭）
    response = _post(
        report_db,
        [_watch("this-monday", watched_seconds=120, occurred_at=_ms(monday))],
    )
    assert response.status_code == 200, response.text

    # 下周一 00:00 属于下周（右开）；直接插库，避免未来时间校验
    conn = _db()
    try:
        conn.execute(
            "INSERT INTO watch_events (user_id, guest_hash, content_ref, kind, "
            "target_lang, watched_seconds, position_seconds, occurred_at, "
            "client_event_id) VALUES (?, NULL, 'vid-next', 'video', 'zh-CN', "
            "300, 0, ?, 'next-monday')",
            (report_db.user_id, _ms(monday) + 7 * 86_400_000),
        )
        conn.commit()
    finally:
        conn.close()

    response = report_db.get("/api/report/week")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["weekStart"] == "2026-11-16"
    assert body["numbers"]["passiveMinutes"] == 2.0

    response = report_db.get("/api/report/week?weekStart=2026-11-09")
    assert response.status_code == 200, response.text
    assert response.json()["weekStart"] == "2026-11-09"
    assert response.json()["numbers"]["passiveMinutes"] == 1.0

    response = report_db.get("/api/report/week?weekStart=2026-11-13")
    assert response.status_code == 200, response.text
    assert response.json()["weekStart"] == "2026-11-09"

    for bad in ("2026-13-01", "11/09/2026", "2026-11-9", "not-a-date"):
        response = report_db.get(f"/api/report/week?weekStart={bad}")
        assert response.status_code == 400, (bad, response.text)
        assert "weekStart" in response.json()["detail"]


def test_snapshot_written_once_then_report_refreshes(report_db, clock):
    response = _post(report_db, [_watch("s1", watched_seconds=60)])
    assert response.status_code == 200, response.text

    first = report_db.get("/api/report/week").json()
    assert first["numbers"]["passiveMinutes"] == 1.0
    before = _snapshot_rows(report_db.user_id)
    assert len(before) == 1
    before_payload = before[0]["payload"]
    before_created = before[0]["created_at"]

    # 同一周后续再上报：周报数字刷新，但快照保持首份（同周只写一次）
    clock["now"] = _ms(NOW + timedelta(hours=2))
    response = _post(report_db, [_watch("s2", watched_seconds=90)])
    assert response.status_code == 200, response.text
    second = report_db.get("/api/report/week").json()
    assert second["numbers"]["passiveMinutes"] == 2.5

    after = _snapshot_rows(report_db.user_id)
    assert len(after) == 1
    assert after[0]["payload"] == before_payload
    assert after[0]["created_at"] == before_created

    # 数据库层唯一约束兜底：同用户同周再插一条被忽略/拒绝
    conn = _db()
    try:
        conn.execute(
            "INSERT OR IGNORE INTO weekly_reports (user_id, week_start, payload, "
            "created_at) VALUES (?, ?, '{}', 1)",
            (report_db.user_id, WEEK_START),
        )
        count = conn.execute(
            "SELECT COUNT(*) FROM weekly_reports WHERE user_id = ?",
            (report_db.user_id,),
        ).fetchone()[0]
    finally:
        conn.close()
    assert count == 1


def test_evidence_falls_back_to_recent_watch(report_db, clock):
    _write_video_cache(report_db)
    response = _post(
        report_db,
        [
            _watch(
                "e1",
                content_ref="vid1",
                watched_seconds=120,
                position_seconds=41,
                occurred_at=_ms(MONDAY + timedelta(hours=20)),
            )
        ],
    )
    assert response.status_code == 200, response.text

    body = report_db.get("/api/report/week").json()
    evidence = body["evidence"]
    assert evidence["source"] == "watch"
    assert evidence["contentRef"] == "vid1"
    assert evidence["start"] == 38.5  # 41 - 2.5 秒
    assert evidence["end"] == 43.5  # 固定 5 秒
    assert evidence["durationSeconds"] == 5.0
    assert evidence["positionSeconds"] == 41
    assert evidence["sentence"] == "The cafe on the second floor serves fresh coffee."
    assert body["nextStep"] == "明天做一次理解练习"


def test_next_step_accuracy_rule(report_db, clock):
    user_id = report_db.user_id
    _seed_attempt(
        user_id,
        suffix="acc",
        answered_at=_ms(NOW - timedelta(hours=1)),
        correct=False,
    )
    for index in range(4):
        _add_attempt(
            user_id,
            "q-acc",
            answered_at=_ms(NOW - timedelta(minutes=50 - index)),
            correct=index == 0,
        )
    _seed_review(user_id, "alpha", reviewed_at=_ms(NOW - timedelta(hours=2)))
    response = _post(report_db, [_watch("acc-watch", watched_seconds=300)])
    assert response.status_code == 200, response.text

    body = report_db.get("/api/report/week").json()
    assert body["quiz"] == {"attempts": 5, "correct": 1}
    assert body["numbers"]["quizAccuracy"] == 0.2
    assert body["nextStep"] == "再做一次理解练习，答错的句子回听一遍"


def test_report_user_isolation(report_db, make_client, clock):
    _post(report_db, [_watch("user1", watched_seconds=600)])
    other = make_client()
    with other as other_client:
        response = other_client.post(
            "/api/auth/signup",
            json={"email": "weekly-other@example.com", "password": PASSWORD},
        )
        assert response.status_code == 201, response.text
        other_id = response.json()["user"]["id"]
        _post(other_client, [_watch("user2", watched_seconds=120)])
        body = other_client.get("/api/report/week").json()
        assert body["numbers"]["passiveMinutes"] == 2.0
    first = report_db.get("/api/report/week").json()
    assert first["numbers"]["passiveMinutes"] == 10.0
    assert other_id != report_db.user_id
