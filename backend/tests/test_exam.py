"""考试练习后端离线验收（V2 用户需求 #11 / specs/022）。

覆盖：

1. 题库：30 题 = 15 词汇 + 5 语法 + 10 阅读（3 段短文每段 3–4 题）、草稿标记、
   字段/选项/正确项合法、抽题配额 5+2+3 且不含答案；
2. 端点：types 题型目录、start 10 题不含答案、未提交会话复用、submit 逐题
   对错/正确答案/解析、未答标记、history 日期/正确数/总数；
3. 幂等：重复提交返回首次结果，不重复写答案/不重复发事件；
4. 权限：全部需登录、游客 403、越权 404；未迁移 503、题库缺失 503；
5. 事件：exam_start / exam_submit 写 learning_events，payload 供周报使用；
6. 文案：响应里没有 score / 预测分 / 通过率 等字段。

所有用例离线：数据库在 conftest 的 tmp_path 下通过真实 Alembic CLI 迁移；
题库读仓库内静态 JSON（或 tmp 副本），不联网、不碰 data/app.db。
"""
from __future__ import annotations

import json
import sqlite3

import pytest

import config
import events
import exam
from tests.migration_utils import assert_alembic_ok, run_alembic

PASSWORD = "exam-password-123"
SECOND_EMAIL = "exam-second@example.com"

BANNED_KEY_PARTS = ("score", "predicted", "passrate", "pass_rate", "throughrate")
BANNED_TEXT = ("分数", "预测分", "通过率", "保分", "模拟考试", "模考")


# ---------------------------------------------------------------------------
# 夹具 / 工具
# ---------------------------------------------------------------------------

def _upgrade() -> None:
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (exam)"
    )


@pytest.fixture()
def exam_db(client):
    """已迁移到 head 的登录客户端。"""
    _upgrade()
    return client


@pytest.fixture()
def second_client(exam_db, make_client):
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
def guest_client(exam_db, make_client):
    """一个匿名游客客户端（中间件会下发 ln_guest 并保存 Cookie）。"""
    with make_client() as test_client:
        me = test_client.get("/api/auth/me")
        assert me.status_code == 200
        assert me.json()["user"] is None and me.json()["guest"] is True
        yield test_client


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _start(client, exam_type: str = "cet4") -> dict:
    response = client.post("/api/exam/start", json={"type": exam_type})
    assert response.status_code == 200, response.text
    return response.json()


def _submit(client, data: dict, answers: list[dict], duration_ms: int | None = 600_000):
    body = {"sessionId": data["sessionId"], "answers": answers}
    if duration_ms is not None:
        body["durationMs"] = duration_ms
    return client.post("/api/exam/submit", json=body)


def _bank_items() -> dict[str, exam.Item]:
    return {item.id: item for item in exam.load_bank().items}


def _build_answers(
    data: dict,
    *,
    correct_count: int | None = None,
    wrong: int = 0,
    skip: int = 0,
) -> list[dict]:
    """按卷面顺序生成答案：默认全对，可指定错 N 题/跳过 N 题。"""
    bank = _bank_items()
    answers: list[dict] = []
    remaining_wrong = wrong
    remaining_skip = skip
    for item in data["items"]:
        if remaining_skip > 0:
            remaining_skip -= 1
            continue
        bank_item = bank[item["itemId"]]
        index = bank_item.answer_index
        if remaining_wrong > 0:
            index = (index + 1) % 4
            remaining_wrong -= 1
        answers.append({"itemId": item["itemId"], "chosenIndex": index})
        if correct_count is not None and len(answers) >= correct_count:
            break
    return answers


def _assert_no_banned(obj, *, dump: bool = True) -> None:
    """响应中不得出现 score / 预测 / 通过率 等字段或文案。"""
    if dump:
        text = json.dumps(obj, ensure_ascii=False)
        for banned in BANNED_TEXT:
            assert banned not in text, f"响应出现禁用文案：{banned}"
    if isinstance(obj, dict):
        for key, value in obj.items():
            lowered = str(key).lower()
            for part in BANNED_KEY_PARTS:
                assert part not in lowered, f"响应出现禁用字段：{key}"
            _assert_no_banned(value, dump=False)
    elif isinstance(obj, list):
        for value in obj:
            _assert_no_banned(value, dump=False)
    elif isinstance(obj, str):
        for banned in BANNED_TEXT:
            assert banned not in obj, f"响应出现禁用文案：{banned}"


# ---------------------------------------------------------------------------
# 题库
# ---------------------------------------------------------------------------

def test_content_bank_is_draft_and_well_formed():
    """30 题配额、草稿标记、字段契约与抽题（5+2+3）全部符合。"""
    bank = exam.load_bank()
    assert len(bank.items) == exam.TOTAL_ITEMS == 30
    assert len(bank.passages) == 3
    assert bank.label == "CET-4 风格练习"

    counts = {}
    for item in bank.items:
        counts[item.type] = counts.get(item.type, 0) + 1
        assert item.band in exam.CEFR_BANDS
        assert item.prompt
        assert len(item.options) == 4
        assert len(set(item.options)) == 4
        assert isinstance(item.answer_index, int) and 0 <= item.answer_index <= 3
        assert item.explanation and item.topic
        if item.type == "reading":
            assert item.passage_id in {p.id for p in bank.passages}
        else:
            assert item.passage_id is None
    assert counts == {"vocab": 15, "grammar": 5, "reading": 10}

    with open(f"{config.EXAM_DIR}/cet4.json", encoding="utf-8") as handle:
        raw = json.load(handle)
    assert "待教研审校" in raw["_meta"]["notice"]
    assert raw["_meta"]["itemCount"] == 30
    dumped = json.dumps(raw, ensure_ascii=False)
    for banned in BANNED_TEXT:
        assert banned not in dumped

    for session_id in ("s1", "s2", "alpha", "deadbeef"):
        items = exam.sample_items(session_id)
        assert len(items) == exam.EXAM_SIZE == 10
        by_type = {}
        for item in items:
            by_type[item.type] = by_type.get(item.type, 0) + 1
        assert by_type == {"vocab": 5, "grammar": 2, "reading": 3}
        reading_passages = {
            item.passage_id for item in items if item.type == "reading"
        }
        assert len(reading_passages) == 3  # 3 段短文各出现 1 题

    # 同一 sessionId 抽题稳定；不同 sessionId 卷面不同（允许极小概率相同）。
    assert [item.id for item in exam.sample_items("stable")] == [
        item.id for item in exam.sample_items("stable")
    ]
    assert [item.id for item in exam.sample_items("alpha")] != [
        item.id for item in exam.sample_items("beta")
    ]


def test_public_item_never_leaks_answer_or_explanation():
    bank = exam.load_bank()
    for item in bank.items:
        payload = exam._public_item(item, bank)
        dumped = json.dumps(payload, ensure_ascii=False)
        assert "answerIndex" not in dumped
        assert "answer_index" not in dumped
        assert "explanation" not in payload
        assert "answerIndex" not in payload
        assert "correctIndex" not in payload
        assert len(payload["options"]) == 4
        if item.type == "reading":
            assert payload["passage"]["text"]
            assert payload["passage"]["id"] == item.passage_id
        else:
            assert "passage" not in payload


# ---------------------------------------------------------------------------
# types / start
# ---------------------------------------------------------------------------

def test_types_catalog_requires_login(exam_db, guest_client):
    guest = guest_client.get("/api/exam/types")
    assert guest.status_code == 403, guest.text

    response = exam_db.get("/api/exam/types")
    assert response.status_code == 200, response.text
    body = response.json()
    _assert_no_banned(body)
    assert body["types"] == [
        {
            "id": "cet4",
            "label": "CET-4 风格练习",
            "itemCount": 30,
            "sessionItemCount": 10,
            "description": exam.TYPE_DESCRIPTION,
            "disclaimer": exam.DISCLAIMER,
        }
    ]


def test_start_returns_ten_items_without_answers(exam_db):
    data = _start(exam_db)
    _assert_no_banned(data)
    assert data["status"] == "in_progress"
    assert data["examType"] == "cet4"
    assert data["label"] == "CET-4 风格练习"
    assert data["resumed"] is False
    assert data["itemCount"] == 10
    assert data["totals"] == {"vocab": 5, "grammar": 2, "reading": 3, "all": 10}
    assert len(data["items"]) == 10
    assert len({item["itemId"] for item in data["items"]}) == 10

    dumped = json.dumps(data, ensure_ascii=False)
    assert "answerIndex" not in dumped
    assert "answer_index" not in dumped
    assert "correctIndex" not in dumped
    assert "chosenIndex" not in dumped

    for item in data["items"]:
        assert "explanation" not in item
        assert "answerIndex" not in item
        assert "correctIndex" not in item
        assert "chosenIndex" not in item
        assert item["type"] in exam.ITEM_TYPES
        assert item["band"] in exam.CEFR_BANDS
        assert len(item["options"]) == 4
        if item["type"] == "reading":
            assert item["passage"]["text"]
        else:
            assert "passage" not in item

    with _db() as conn:
        row = conn.execute("SELECT * FROM exam_sessions").fetchone()
    assert row["id"] == data["sessionId"]
    assert row["user_id"] == exam_db.user_id
    assert row["exam_type"] == "cet4"
    assert row["status"] == "in_progress"
    assert row["started_at"] > 0
    assert json.loads(row["item_ids"]) == [
        item["itemId"] for item in data["items"]
    ]

    # 开始事件：只写一条，payload 供周报聚合。
    event_rows = events.query_events(
        user_id=exam_db.user_id, event_type="exam_start"
    )
    assert len(event_rows) == 1
    assert event_rows[0]["session_id"] == data["sessionId"]
    assert event_rows[0]["content_ref"] == "cet4"
    payload = event_rows[0]["payload"]
    assert payload["examType"] == "cet4"
    assert payload["itemCount"] == 10
    assert payload["resumed"] is False
    assert "score" not in json.dumps(payload)


def test_start_reuses_in_progress_session(exam_db):
    first = _start(exam_db)
    second = _start(exam_db)
    assert second["sessionId"] == first["sessionId"]
    assert second["resumed"] is True
    assert [item["itemId"] for item in second["items"]] == [
        item["itemId"] for item in first["items"]
    ]
    assert [item["prompt"] for item in second["items"]] == [
        item["prompt"] for item in first["items"]
    ]

    with _db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM exam_sessions").fetchone()[0] == 1
    # 复用不重复发开始事件
    assert (
        len(events.query_events(user_id=exam_db.user_id, event_type="exam_start"))
        == 1
    )


# ---------------------------------------------------------------------------
# submit / 评分 / 未答 / 幂等
# ---------------------------------------------------------------------------

def test_submit_all_correct_returns_per_item_result(exam_db):
    data = _start(exam_db)
    answers = _build_answers(data)
    response = _submit(exam_db, data, answers)
    assert response.status_code == 200, response.text
    result = response.json()
    _assert_no_banned(result)

    assert result["sessionId"] == data["sessionId"]
    assert result["status"] == "submitted"
    assert result["reused"] is False
    assert result["examType"] == "cet4"
    assert result["correct"] == 10
    assert result["total"] == 10
    assert result["answered"] == 10
    assert result["unanswered"] == 0
    assert result["durationMs"] == 600_000
    assert len(result["items"]) == 10

    bank = _bank_items()
    for item in result["items"]:
        assert item["answered"] is True
        assert item["correct"] is True
        assert item["chosenIndex"] == bank[item["itemId"]].answer_index
        assert item["correctIndex"] == bank[item["itemId"]].answer_index
        assert item["explanation"] == bank[item["itemId"]].explanation
        assert len(item["options"]) == 4

    with _db() as conn:
        session = conn.execute(
            "SELECT * FROM exam_sessions WHERE id=?", (data["sessionId"],)
        ).fetchone()
        assert session["status"] == "submitted"
        assert session["submitted_at"] is not None
        assert session["duration_ms"] == 600_000
        answer_rows = conn.execute(
            "SELECT * FROM exam_answers WHERE session_id=?", (data["sessionId"],)
        ).fetchall()
    assert len(answer_rows) == 10
    assert all(row["correct"] == 1 for row in answer_rows)
    assert all(0 <= row["chosen_index"] <= 3 for row in answer_rows)

    event_rows = events.query_events(
        user_id=exam_db.user_id, event_type="exam_submit"
    )
    assert len(event_rows) == 1
    payload = event_rows[0]["payload"]
    assert payload["correct"] == 10
    assert payload["total"] == 10
    assert payload["answered"] == 10
    assert payload["durationMs"] == 600_000
    assert "score" not in json.dumps(payload)


def test_submit_scores_mixed_answers(exam_db):
    data = _start(exam_db)
    answers = _build_answers(data, wrong=3)
    result = _submit(exam_db, data, answers).json()
    assert result["correct"] == 7
    assert result["total"] == 10
    assert result["answered"] == 10
    assert result["unanswered"] == 0
    wrong_ids = {
        item["itemId"]
        for item in result["items"]
        if not item["correct"]
    }
    assert len(wrong_ids) == 3
    for item in result["items"]:
        assert item["correct"] == (item["chosenIndex"] == item["correctIndex"])


def test_submit_marks_unanswered_items(exam_db):
    data = _start(exam_db)
    answered = _build_answers(data, correct_count=6)
    assert len(answered) == 6
    result = _submit(exam_db, data, answered).json()
    assert result["correct"] == 6
    assert result["total"] == 10
    assert result["answered"] == 6
    assert result["unanswered"] == 4

    unanswered = [item for item in result["items"] if not item["answered"]]
    assert len(unanswered) == 4
    for item in unanswered:
        assert item["chosenIndex"] is None
        assert item["correct"] is False
        assert isinstance(item["correctIndex"], int)
        assert item["explanation"]
    for item in result["items"]:
        if item["answered"]:
            assert item["correct"] is True

    with _db() as conn:
        rows = conn.execute(
            "SELECT * FROM exam_answers WHERE session_id=?", (data["sessionId"],)
        ).fetchall()
    assert len(rows) == 6


def test_submit_is_idempotent(exam_db):
    data = _start(exam_db)
    first = _submit(exam_db, data, _build_answers(data))
    assert first.status_code == 200, first.text
    first_body = first.json()
    submitted_at = first_body["submittedAt"]
    duration = first_body["durationMs"]

    # 重复提交：即使答案不同、用时不同，也返回首次结果。
    second = _submit(exam_db, data, [], duration_ms=1)
    assert second.status_code == 200, second.text
    second_body = second.json()
    assert second_body["reused"] is True
    assert second_body["correct"] == first_body["correct"] == 10
    assert second_body["total"] == first_body["total"] == 10
    assert second_body["submittedAt"] == submitted_at
    assert second_body["durationMs"] == duration
    assert second_body["items"] == first_body["items"]

    with _db() as conn:
        assert (
            conn.execute("SELECT COUNT(*) FROM exam_answers").fetchone()[0] == 10
        )
        assert (
            conn.execute("SELECT COUNT(*) FROM exam_sessions").fetchone()[0] == 1
        )
    assert (
        len(events.query_events(user_id=exam_db.user_id, event_type="exam_submit"))
        == 1
    )


def test_submit_duration_defaults_to_server_elapsed(exam_db, monkeypatch):
    data = _start(exam_db)
    started_at = data["startedAt"]
    monkeypatch.setattr(exam, "now_ms", lambda: started_at + 300_000)
    response = _submit(
        exam_db, data, _build_answers(data), duration_ms=None
    )
    assert response.status_code == 200, response.text
    assert response.json()["durationMs"] == 300_000


# ---------------------------------------------------------------------------
# history
# ---------------------------------------------------------------------------

def test_history_lists_submitted_practice_newest_first(exam_db):
    first = _start(exam_db)
    first_result = _submit(exam_db, first, _build_answers(first)).json()
    assert first_result["correct"] == 10

    # 未提交的会话不出现在历史里
    second = _start(exam_db)
    assert second["sessionId"] != first["sessionId"]
    body = exam_db.get("/api/exam/history")
    assert body.status_code == 200, body.text
    assert len(body.json()["sessions"]) == 1

    second_result = _submit(
        exam_db, second, _build_answers(second, wrong=5)
    ).json()
    assert second_result["correct"] == 5

    response = exam_db.get("/api/exam/history")
    assert response.status_code == 200, response.text
    body = response.json()
    _assert_no_banned(body)
    assert body["limit"] == 20
    sessions = body["sessions"]
    assert len(sessions) == 2
    assert sessions[0]["sessionId"] == second["sessionId"]
    assert sessions[1]["sessionId"] == first["sessionId"]
    assert sessions[0]["correct"] == 5
    assert sessions[1]["correct"] == 10
    for item in sessions:
        assert item["examType"] == "cet4"
        assert item["label"] == "CET-4 风格练习"
        assert item["total"] == 10
        assert item["answered"] == 10
        assert item["date"].endswith("Z")
        assert item["submittedAt"] > 0
        assert item["durationMs"] == 600_000

    limited = exam_db.get("/api/exam/history?limit=1")
    assert limited.status_code == 200, limited.text
    assert len(limited.json()["sessions"]) == 1
    assert limited.json()["sessions"][0]["sessionId"] == second["sessionId"]

    assert exam_db.get("/api/exam/history?limit=0").status_code == 422
    assert exam_db.get("/api/exam/history?limit=101").status_code == 422


# ---------------------------------------------------------------------------
# 权限 / 校验 / 迁移闸门
# ---------------------------------------------------------------------------

def test_cross_user_session_is_404(exam_db, second_client):
    data = _start(exam_db)
    answers = _build_answers(data)

    stolen = second_client.post(
        "/api/exam/submit",
        json={
            "sessionId": data["sessionId"],
            "answers": answers,
            "durationMs": 600_000,
        },
    )
    assert stolen.status_code == 404, stolen.text
    assert second_client.get("/api/exam/history").json()["sessions"] == []

    # 第一个用户的会话仍是 in_progress，可以正常提交。
    own = _submit(exam_db, data, answers)
    assert own.status_code == 200, own.text
    assert own.json()["correct"] == 10

    # 第二个用户自己的会话与第一个互不影响。
    second = _start(second_client)
    assert second["sessionId"] != data["sessionId"]
    assert second_client.get("/api/exam/history").json()["sessions"] == []


def test_guest_is_forbidden_on_all_endpoints(guest_client):
    assert guest_client.get("/api/exam/types").status_code == 403
    assert (
        guest_client.post("/api/exam/start", json={"type": "cet4"}).status_code
        == 403
    )
    assert (
        guest_client.post(
            "/api/exam/submit",
            json={"sessionId": "x", "answers": []},
        ).status_code
        == 403
    )
    assert guest_client.get("/api/exam/history").status_code == 403

    # 游客的请求没有写任何会话（表已迁移，但没有行）。
    with _db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM exam_sessions").fetchone()[0] == 0


def test_submit_validation_errors(exam_db):
    data = _start(exam_db)
    session_id = data["sessionId"]
    item_id = data["items"][0]["itemId"]

    def post(answers, duration=600_000, **overrides):
        body = {"sessionId": session_id, "answers": answers, "durationMs": duration}
        body.update(overrides)
        return exam_db.post("/api/exam/submit", json=body)

    assert post([{"itemId": "not-in-paper", "chosenIndex": 0}]).status_code == 400
    assert (
        post(
            [
                {"itemId": item_id, "chosenIndex": 0},
                {"itemId": item_id, "chosenIndex": 1},
            ]
        ).status_code
        == 400
    )
    assert post([{"itemId": item_id, "chosenIndex": 4}]).status_code == 400
    assert post([{"itemId": item_id, "chosenIndex": -1}]).status_code == 400
    assert post([{"itemId": item_id, "chosenIndex": "x"}]).status_code == 422
    assert post([], duration=-1).status_code == 400
    assert post([], duration=exam.MAX_DURATION_MS + 1).status_code == 400
    assert post([], **{"sessionId": ""}).status_code == 400
    assert post([], **{"sessionId": "does-not-exist"}).status_code == 404
    assert (
        exam_db.post("/api/exam/submit", json={"answers": []}).status_code == 422
    )
    assert (
        exam_db.post(
            "/api/exam/start", json={"type": "toefl"}
        ).status_code
        == 400
    )
    assert exam_db.post("/api/exam/start", json={"type": ""}).status_code == 400
    assert exam_db.post("/api/exam/start", json={}).status_code == 400

    with _db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM exam_answers").fetchone()[0] == 0
        assert (
            conn.execute(
                "SELECT status FROM exam_sessions WHERE id=?", (session_id,)
            ).fetchone()["status"]
            == "in_progress"
        )


def test_unmigrated_db_returns_503(client):
    """题库是静态的，types 不依赖数据库；其余端点未迁移时 503。"""
    assert client.get("/api/exam/types").status_code == 200
    start = client.post("/api/exam/start", json={"type": "cet4"})
    assert start.status_code == 503, start.text
    assert "0012_exam" in start.text
    submit = client.post(
        "/api/exam/submit", json={"sessionId": "x", "answers": []}
    )
    assert submit.status_code == 503, submit.text
    history = client.get("/api/exam/history")
    assert history.status_code == 503, history.text


def test_broken_bank_returns_503_without_creating_session(
    exam_db, tmp_path, monkeypatch
):
    monkeypatch.setattr(config, "EXAM_DIR", str(tmp_path / "missing"), raising=False)
    response = exam_db.get("/api/exam/types")
    assert response.status_code == 503, response.text
    assert "题库" in response.text
    start = exam_db.post("/api/exam/start", json={"type": "cet4"})
    assert start.status_code == 503, start.text
    with _db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM exam_sessions").fetchone()[0] == 0
