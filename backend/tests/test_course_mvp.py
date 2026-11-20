"""课程 MVP 后端离线验收（specs/029）。

覆盖：

1. 课程包：列表元数据、详情脱敏（题目不含 answer/explain、step 讲解保留）、
   8 题计数、404、内容损坏/目录缺失 503；
2. attempt：start 新建、重复 start 恢复同一 attempt、GET 恢复、完成后重开新
   attempt；跨用户 404（不泄露存在性）；
3. 作答：正确/错误反馈、重复同 choice 幂等、换 choice 409、题目/选项非法 400；
4. 步骤/产出：合法更新、非法步骤 400、完成后 409、wordCount、2000 字符上限；
5. 完成：未答完/无产出 409、8 题评分、混合对错评分、重复完成幂等；
6. 事件：写入 204、非法 event/step/payload/超 2KB 400、跨用户 404；
7. 权限：游客 401；
8. 迁移 0021：两张表/列/索引/部分唯一约束；head 已更新到 0022。

所有用例离线：数据库在 conftest 的 tmp_path 下通过真实 Alembic CLI 迁移；
课程包读仓库内静态 JSON（或 tmp 副本），不联网、不碰 data/app.db。
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

import config
import course
from tests.migration_utils import (
    assert_alembic_ok,
    columns,
    index_names,
    revision,
    run_alembic,
    table_names,
)

PASSWORD = "course-password-123"
SECOND_EMAIL = "course-second@example.com"
LESSON_ID = "ocean-noise-12min"
QUESTION_IDS = ("Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "E1", "E2")
ALL_CORRECT = {question_id: "A" for question_id in QUESTION_IDS}


# ---------------------------------------------------------------------------
# 夹具 / 工具
# ---------------------------------------------------------------------------

def _upgrade() -> None:
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"),
        "upgrade head (course)",
    )


@pytest.fixture()
def course_client(client):
    """已迁移到 head 的登录客户端。"""
    _upgrade()
    return client


@pytest.fixture()
def second_client(course_client, make_client):
    """第二个登录用户（用于跨用户隔离）。"""
    with make_client() as test_client:
        response = test_client.post(
            "/api/auth/signup",
            json={"email": SECOND_EMAIL, "password": PASSWORD},
        )
        assert response.status_code == 201, response.text
        test_client.user_id = response.json()["user"]["id"]
        yield test_client


@pytest.fixture()
def guest_client(course_client, make_client):
    """匿名游客客户端（中间件下发 ln_guest）。"""
    with make_client() as test_client:
        me = test_client.get("/api/auth/me")
        assert me.status_code == 200
        assert me.json()["user"] is None and me.json()["guest"] is True
        yield test_client


def _start(client, lesson_id: str = LESSON_ID) -> dict:
    response = client.post("/api/course/attempts", json={"lessonId": lesson_id})
    assert response.status_code == 200, response.text
    return response.json()


def _answer_all(client, attempt_id: str, choices: dict[str, str] | None = None) -> None:
    mapping = dict(ALL_CORRECT)
    mapping.update(choices or {})
    for question_id in QUESTION_IDS:
        response = client.post(
            f"/api/course/attempts/{attempt_id}/answer",
            json={"questionId": question_id, "choice": mapping[question_id]},
        )
        assert response.status_code == 200, response.text


def _save_output(client, attempt_id: str, text: str = "Underwater noise is constant pollution.") -> dict:
    response = client.post(
        f"/api/course/attempts/{attempt_id}/output", json={"text": text}
    )
    assert response.status_code == 200, response.text
    return response.json()


def _finished(client, attempt_id: str, choices: dict[str, str] | None = None) -> dict:
    _answer_all(client, attempt_id, choices)
    _save_output(client, attempt_id)
    response = client.post(f"/api/course/attempts/{attempt_id}/complete")
    assert response.status_code == 200, response.text
    return response.json()


def _question_dicts(payload: dict):
    """遍历课程详情里所有题目对象（步骤 questions / exitTicket / 根 exitTicket）。"""
    for step in payload.get("steps") or []:
        for key in ("questions", "exitTicket"):
            for question in step.get(key) or []:
                yield question
    for question in payload.get("exitTicket") or []:
        yield question


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ---------------------------------------------------------------------------
# 1. 课程包 / 脱敏
# ---------------------------------------------------------------------------

def test_lesson_list_metadata(course_client):
    response = course_client.get("/api/course/lessons")
    assert response.status_code == 200, response.text
    lessons = response.json()["lessons"]
    assert [lesson["id"] for lesson in lessons] == [LESSON_ID]
    lesson = lessons[0]
    assert lesson["title"] == "Why the Ocean Is Getting Louder"
    assert lesson["titleZh"] == "为什么海洋越来越吵"
    assert lesson["level"] == "B1"
    assert lesson["durationMinutes"] == 12
    assert lesson["status"] == "private_beta"
    assert lesson["version"] == 1
    # 列表不下发正文/答案
    assert "steps" not in lesson
    assert "answer" not in json.dumps(lesson)


def test_lesson_detail_is_sanitized(course_client):
    response = course_client.get(f"/api/course/lessons/{LESSON_ID}")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["id"] == LESSON_ID
    assert [step["id"] for step in payload["steps"]] == [
        "S0", "S1", "S2", "S3", "S4", "S5",
    ]
    question_dicts = list(_question_dicts(payload))
    assert len(question_dicts) == 8
    for question in question_dicts:
        assert set(question) >= {"id", "prompt", "options"}
        assert "answer" not in question
        assert "explain" not in question
        for option in question["options"]:
            assert "text" in option
    # 步骤级讲解是教学内容，必须保留
    s2 = next(step for step in payload["steps"] if step["id"] == "S2")
    assert "explain" in s2
    assert "correctChoice" not in json.dumps(payload)
    # 整个响应里不存在被脱敏掉的答案标记
    assert '"answer"' not in json.dumps(payload)


def test_lesson_detail_unknown_is_404(course_client):
    response = course_client.get("/api/course/lessons/no-such-lesson")
    assert response.status_code == 404
    assert "lesson_not_found" in response.json()["detail"]


def test_packaged_lesson_has_no_third_party_video(course_client):
    response = course_client.get(f"/api/course/lessons/{LESSON_ID}")
    assert response.status_code == 200
    text = json.dumps(response.json(), ensure_ascii=False).lower()
    assert "youtube" not in text
    assert "videoId".lower() not in text
    assert response.json()["source"]["kind"] == "article"


def test_lesson_dir_missing_is_503(course_client, monkeypatch, tmp_path):
    monkeypatch.setattr(config, "COURSE_DIR", str(tmp_path / "missing"), raising=False)
    response = course_client.get("/api/course/lessons")
    assert response.status_code == 503


def test_invalid_lesson_pack_is_503(course_client, monkeypatch, tmp_path):
    directory = tmp_path / "course"
    directory.mkdir()
    (directory / "bad.json").write_text(
        json.dumps({"schema": "wrong", "id": "bad", "version": 1, "steps": []}),
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "COURSE_DIR", str(directory), raising=False)
    response = course_client.get("/api/course/lessons")
    assert response.status_code == 503
    assert "schema" in response.json()["detail"]


# ---------------------------------------------------------------------------
# 2. attempt 创建 / 恢复 / 归属
# ---------------------------------------------------------------------------

def test_start_creates_attempt(course_client):
    payload = _start(course_client)
    assert payload["resumed"] is False
    assert payload["attemptId"]
    assert payload["status"] == "in_progress"
    assert payload["currentStepId"] == "S0"
    assert payload["answers"] == {}
    assert payload["output"] == ""
    assert isinstance(payload["startedAt"], int)
    assert payload["lesson"]["id"] == LESSON_ID
    # start 响应同样脱敏
    assert '"answer"' not in json.dumps(payload)


def test_start_again_resumes_same_attempt(course_client):
    first = _start(course_client)
    second = _start(course_client)
    assert second["resumed"] is True
    assert second["attemptId"] == first["attemptId"]
    with _db() as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM course_attempts WHERE status = 'in_progress'"
        ).fetchone()[0]
    assert count == 1


def test_answer_keeps_attempt_resumable(course_client):
    started = _start(course_client)
    attempt_id = started["attemptId"]
    response = course_client.post(
        f"/api/course/attempts/{attempt_id}/answer",
        json={"questionId": "Q1", "choice": "A"},
    )
    assert response.status_code == 200
    resumed = _start(course_client)
    assert resumed["resumed"] is True
    assert resumed["answers"] == {"Q1": "A"}

    fetched = course_client.get(f"/api/course/attempts/{attempt_id}")
    assert fetched.status_code == 200, fetched.text
    body = fetched.json()
    assert body["attemptId"] == attempt_id
    assert body["answers"] == {"Q1": "A"}
    assert body["score"] is None
    assert body["total"] is None
    assert body["completedAt"] is None


def test_start_unknown_lesson_is_404(course_client):
    response = course_client.post(
        "/api/course/attempts", json={"lessonId": "no-such-lesson"}
    )
    assert response.status_code == 404
    assert "lesson_not_found" in response.json()["detail"]


def test_start_without_lesson_id_is_400(course_client):
    response = course_client.post("/api/course/attempts", json={})
    assert response.status_code == 400


def test_other_users_attempt_is_404(course_client, second_client):
    attempt_id = _start(course_client)["attemptId"]
    assert second_client.get(f"/api/course/attempts/{attempt_id}").status_code == 404
    assert (
        second_client.post(
            f"/api/course/attempts/{attempt_id}/answer",
            json={"questionId": "Q1", "choice": "A"},
        ).status_code
        == 404
    )
    assert (
        second_client.post(
            f"/api/course/attempts/{attempt_id}/step", json={"stepId": "S1"}
        ).status_code
        == 404
    )
    assert (
        second_client.post(
            f"/api/course/attempts/{attempt_id}/output", json={"text": "hi"}
        ).status_code
        == 404
    )
    assert (
        second_client.post(f"/api/course/attempts/{attempt_id}/complete").status_code
        == 404
    )
    assert (
        second_client.post(
            f"/api/course/attempts/{attempt_id}/events",
            json={"event": "step_view", "stepId": "S1"},
        ).status_code
        == 404
    )


# ---------------------------------------------------------------------------
# 3. 作答
# ---------------------------------------------------------------------------

def test_answer_correct_feedback(course_client):
    attempt_id = _start(course_client)["attemptId"]
    response = course_client.post(
        f"/api/course/attempts/{attempt_id}/answer",
        json={"questionId": "Q1", "choice": "A"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["questionId"] == "Q1"
    assert body["choice"] == "A"
    assert body["correct"] is True
    assert body["correctChoice"] == "A"
    assert body["explanation"]


def test_answer_wrong_feedback(course_client):
    attempt_id = _start(course_client)["attemptId"]
    response = course_client.post(
        f"/api/course/attempts/{attempt_id}/answer",
        json={"questionId": "Q2", "choice": "B"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["correct"] is False
    assert body["correctChoice"] == "A"


def test_repeat_same_choice_is_idempotent(course_client):
    attempt_id = _start(course_client)["attemptId"]
    first = course_client.post(
        f"/api/course/attempts/{attempt_id}/answer",
        json={"questionId": "Q3", "choice": "A"},
    )
    second = course_client.post(
        f"/api/course/attempts/{attempt_id}/answer",
        json={"questionId": "Q3", "choice": "A"},
    )
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    with _db() as conn:
        answers = json.loads(
            conn.execute(
                "SELECT answers_json FROM course_attempts WHERE id = ?",
                (attempt_id,),
            ).fetchone()[0]
        )
    assert answers == {"Q3": "A"}


def test_change_choice_is_409(course_client):
    attempt_id = _start(course_client)["attemptId"]
    course_client.post(
        f"/api/course/attempts/{attempt_id}/answer",
        json={"questionId": "Q4", "choice": "A"},
    )
    response = course_client.post(
        f"/api/course/attempts/{attempt_id}/answer",
        json={"questionId": "Q4", "choice": "B"},
    )
    assert response.status_code == 409
    assert "answer_locked" in response.json()["detail"]


def test_answer_unknown_question_is_400(course_client):
    attempt_id = _start(course_client)["attemptId"]
    response = course_client.post(
        f"/api/course/attempts/{attempt_id}/answer",
        json={"questionId": "Q999", "choice": "A"},
    )
    assert response.status_code == 400
    assert "question_not_found" in response.json()["detail"]


def test_answer_invalid_choice_is_400(course_client):
    attempt_id = _start(course_client)["attemptId"]
    response = course_client.post(
        f"/api/course/attempts/{attempt_id}/answer",
        json={"questionId": "Q1", "choice": "Z"},
    )
    assert response.status_code == 400
    assert "invalid_choice" in response.json()["detail"]


# ---------------------------------------------------------------------------
# 4. 步骤 / 产出
# ---------------------------------------------------------------------------

def test_step_updates_current_step(course_client):
    attempt_id = _start(course_client)["attemptId"]
    response = course_client.post(
        f"/api/course/attempts/{attempt_id}/step", json={"stepId": "S3"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["currentStepId"] == "S3"
    fetched = course_client.get(f"/api/course/attempts/{attempt_id}").json()
    assert fetched["currentStepId"] == "S3"


def test_invalid_step_is_400(course_client):
    attempt_id = _start(course_client)["attemptId"]
    response = course_client.post(
        f"/api/course/attempts/{attempt_id}/step", json={"stepId": "S9"}
    )
    assert response.status_code == 400
    assert "invalid_step" in response.json()["detail"]


def test_step_after_complete_is_409(course_client):
    attempt_id = _start(course_client)["attemptId"]
    _finished(course_client, attempt_id)
    response = course_client.post(
        f"/api/course/attempts/{attempt_id}/step", json={"stepId": "S5"}
    )
    assert response.status_code == 409


def test_output_saves_and_counts_words(course_client):
    attempt_id = _start(course_client)["attemptId"]
    text = "Underwater noise from shipping is constant pollution."
    body = _save_output(course_client, attempt_id, text)
    assert body["text"] == text
    assert body["output"] == text
    assert body["wordCount"] == 7
    fetched = course_client.get(f"/api/course/attempts/{attempt_id}").json()
    assert fetched["output"] == text


def test_output_limit_2000_chars(course_client):
    attempt_id = _start(course_client)["attemptId"]
    ok = course_client.post(
        f"/api/course/attempts/{attempt_id}/output", json={"text": "a" * 2000}
    )
    assert ok.status_code == 200
    too_long = course_client.post(
        f"/api/course/attempts/{attempt_id}/output", json={"text": "a" * 2001}
    )
    assert too_long.status_code == 400
    assert "output_too_long" in too_long.json()["detail"]


def test_output_missing_text_is_400(course_client):
    attempt_id = _start(course_client)["attemptId"]
    response = course_client.post(
        f"/api/course/attempts/{attempt_id}/output", json={}
    )
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# 5. 完成与评分
# ---------------------------------------------------------------------------

def test_complete_without_answers_is_409_incomplete(course_client):
    attempt_id = _start(course_client)["attemptId"]
    _save_output(course_client, attempt_id)
    response = course_client.post(f"/api/course/attempts/{attempt_id}/complete")
    assert response.status_code == 409
    assert "incomplete" in response.json()["detail"]


def test_complete_without_output_is_409_incomplete(course_client):
    attempt_id = _start(course_client)["attemptId"]
    _answer_all(course_client, attempt_id)
    response = course_client.post(f"/api/course/attempts/{attempt_id}/complete")
    assert response.status_code == 409
    assert "incomplete" in response.json()["detail"]


def test_complete_scores_all_correct(course_client):
    attempt_id = _start(course_client)["attemptId"]
    body = _finished(course_client, attempt_id)
    assert body["score"] == 8
    assert body["total"] == 8
    assert body["completedAt"] and isinstance(body["completedAt"], int)
    assert len(body["answers"]) == 8
    assert all(item["correct"] is True for item in body["answers"])
    assert body["output"]

    fetched = course_client.get(f"/api/course/attempts/{attempt_id}").json()
    assert fetched["status"] == "completed"
    assert fetched["score"] == 8
    assert fetched["total"] == 8
    assert fetched["completedAt"] == body["completedAt"]


def test_complete_mixed_answers_score(course_client):
    attempt_id = _start(course_client)["attemptId"]
    body = _finished(course_client, attempt_id, {"Q2": "B", "Q5": "C"})
    assert body["score"] == 6
    assert body["total"] == 8
    by_id = {item["questionId"]: item for item in body["answers"]}
    assert by_id["Q2"]["correct"] is False
    assert by_id["Q2"]["choice"] == "B"
    assert by_id["Q5"]["correct"] is False
    assert by_id["Q1"]["correct"] is True


def test_complete_is_idempotent(course_client):
    attempt_id = _start(course_client)["attemptId"]
    first = _finished(course_client, attempt_id)
    second = course_client.post(f"/api/course/attempts/{attempt_id}/complete")
    assert second.status_code == 200, second.text
    assert second.json() == first


def test_complete_after_complete_then_start_new_attempt(course_client):
    attempt_id = _start(course_client)["attemptId"]
    _finished(course_client, attempt_id)
    restarted = _start(course_client)
    assert restarted["resumed"] is False
    assert restarted["attemptId"] != attempt_id


# ---------------------------------------------------------------------------
# 6. 事件
# ---------------------------------------------------------------------------

def test_event_writes_row(course_client):
    attempt_id = _start(course_client)["attemptId"]
    response = course_client.post(
        f"/api/course/attempts/{attempt_id}/events",
        json={"event": "step_view", "stepId": "S2", "payload": {"elapsedMs": 12000}},
    )
    assert response.status_code == 204
    assert response.content == b""
    with _db() as conn:
        row = conn.execute(
            "SELECT attempt_id, event, step_id, payload_json "
            "FROM course_events WHERE attempt_id = ?",
            (attempt_id,),
        ).fetchone()
    assert row["event"] == "step_view"
    assert row["step_id"] == "S2"
    assert json.loads(row["payload_json"]) == {"elapsedMs": 12000}


def test_event_invalid_type_is_400(course_client):
    attempt_id = _start(course_client)["attemptId"]
    response = course_client.post(
        f"/api/course/attempts/{attempt_id}/events",
        json={"event": "buy_course"},
    )
    assert response.status_code == 400
    assert "invalid_event" in response.json()["detail"]


def test_event_invalid_step_is_400(course_client):
    attempt_id = _start(course_client)["attemptId"]
    response = course_client.post(
        f"/api/course/attempts/{attempt_id}/events",
        json={"event": "step_view", "stepId": "S9"},
    )
    assert response.status_code == 400
    assert "invalid_step" in response.json()["detail"]


def test_event_payload_too_large_is_400(course_client):
    attempt_id = _start(course_client)["attemptId"]
    response = course_client.post(
        f"/api/course/attempts/{attempt_id}/events",
        json={"event": "drop", "payload": {"note": "x" * 2100}},
    )
    assert response.status_code == 400
    assert "payload_too_large" in response.json()["detail"]


def test_event_payload_must_be_object(course_client):
    attempt_id = _start(course_client)["attemptId"]
    response = course_client.post(
        f"/api/course/attempts/{attempt_id}/events",
        json={"event": "drop", "payload": ["not", "an", "object"]},
    )
    assert response.status_code == 400
    assert "invalid_payload" in response.json()["detail"]


# ---------------------------------------------------------------------------
# 7. 权限：游客 401
# ---------------------------------------------------------------------------

def test_guest_gets_401_on_all_course_endpoints(guest_client):
    endpoints = [
        ("GET", "/api/course/lessons"),
        ("GET", f"/api/course/lessons/{LESSON_ID}"),
        ("POST", "/api/course/attempts"),
        ("GET", "/api/course/attempts/whatever"),
        ("POST", "/api/course/attempts/whatever/answer"),
        ("POST", "/api/course/attempts/whatever/step"),
        ("POST", "/api/course/attempts/whatever/output"),
        ("POST", "/api/course/attempts/whatever/complete"),
        ("POST", "/api/course/attempts/whatever/events"),
    ]
    for method, url in endpoints:
        kwargs = {"json": {}} if method == "POST" else {}
        response = guest_client.request(method, url, **kwargs)
        assert response.status_code == 401, (method, url, response.text)


# ---------------------------------------------------------------------------
# 8. 迁移 0021
# ---------------------------------------------------------------------------

def test_migration_0021_tables_columns_indexes(tmp_path):
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head (0021)")

    assert revision(db) == "0025_balance_cost"
    tables = table_names(db)
    assert {"course_attempts", "course_events"} <= tables

    attempt_columns = columns(db, "course_attempts")
    assert list(attempt_columns) == [
        "id",
        "user_id",
        "lesson_id",
        "lesson_version",
        "status",
        "current_step_id",
        "answers_json",
        "output_text",
        "score",
        "total",
        "started_at",
        "updated_at",
        "completed_at",
    ]
    assert attempt_columns["id"]["pk"] == 1
    for required in (
        "user_id",
        "lesson_id",
        "lesson_version",
        "status",
        "current_step_id",
        "answers_json",
        "output_text",
        "started_at",
        "updated_at",
    ):
        assert attempt_columns[required]["notnull"] == 1, required
    assert attempt_columns["score"]["notnull"] == 0
    assert attempt_columns["total"]["notnull"] == 0
    assert attempt_columns["completed_at"]["notnull"] == 0

    attempt_indexes = index_names(db, "course_attempts")
    assert {
        "ix_course_attempts_user_updated",
        "ix_course_attempts_lesson_status",
        "ux_course_attempts_in_progress",
    } <= attempt_indexes

    event_columns = columns(db, "course_events")
    assert list(event_columns) == [
        "id",
        "attempt_id",
        "user_id",
        "event",
        "step_id",
        "payload_json",
        "created_at",
    ]
    assert event_columns["id"]["pk"] == 1
    for required in ("attempt_id", "user_id", "event", "created_at"):
        assert event_columns[required]["notnull"] == 1, required
    assert event_columns["step_id"]["notnull"] == 0
    assert event_columns["payload_json"]["notnull"] == 0

    event_indexes = index_names(db, "course_events")
    assert {
        "ix_course_events_attempt",
        "ix_course_events_user_event",
    } <= event_indexes

    # 同一用户同一课程最多一条 in_progress；completed 历史可并存。
    with sqlite3.connect(db) as conn:
        insert = (
            "INSERT INTO course_attempts "
            "(id, user_id, lesson_id, lesson_version, status, current_step_id, "
            " answers_json, output_text, started_at, updated_at) "
            "VALUES (?, 'u1', ?, 1, ?, 'S0', '{}', '', 1, 1)"
        )
        conn.execute(insert, ("a1", LESSON_ID, "in_progress"))
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(insert, ("a2", LESSON_ID, "in_progress"))
        conn.execute(insert, ("a3", LESSON_ID, "completed"))
        conn.execute(insert, ("a4", LESSON_ID, "completed"))


def test_migration_0021_downgrade_drops_tables(tmp_path):
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    assert_alembic_ok(
        run_alembic(db, "downgrade", "0020_content_teaching_analysis"),
        "downgrade 0021",
    )
    tables = table_names(db)
    assert "course_attempts" not in tables
    assert "course_events" not in tables
    assert revision(db) == "0020_content_teaching_analysis"


# ---------------------------------------------------------------------------
# 9. 课程包校验（纯函数，不经 HTTP）
# ---------------------------------------------------------------------------

def test_course_parser_rejects_duplicate_question_id():
    raw = json.loads(
        (Path(config.COURSE_DIR) / f"{LESSON_ID}.json").read_text(encoding="utf-8")
    )
    raw["steps"][2]["questions"][1]["id"] = raw["steps"][2]["questions"][0]["id"]
    with pytest.raises(course.CourseUnavailable):
        course.parse_lesson(raw)


def test_course_parser_rejects_answer_outside_options():
    raw = json.loads(
        (Path(config.COURSE_DIR) / f"{LESSON_ID}.json").read_text(encoding="utf-8")
    )
    raw["steps"][2]["questions"][0]["answer"] = "Z"
    with pytest.raises(course.CourseUnavailable):
        course.parse_lesson(raw)
