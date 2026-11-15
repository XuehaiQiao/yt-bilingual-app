"""M4 能力定位测试后端离线验收（计划书 §13.2 M4 / specs/016）。

覆盖：

1. 题库：30 词汇 / 5 阅读 / 4 伪词，草稿标记、字段契约、选项/正确项合法，
   抽题 24+3+5、五个难度带齐全、对外卷面不含 answerIndex；
2. 端点：start 不含答案 / 未完成会话复用 / reset 后重建；submit 加权评分、
   CEFR 区间、置信度、强弱项、1 条建议、画像落库；profile 无画像为 null；
3. 伪词：选任一选项计 overclaim、压低置信度但不影响得分；跳过（-1/null）为诚实；
4. 幂等：重复提交返回首次结果，不重复写答案/画像；
5. 游客可测、结果不跨设备；跨用户会话/画像隔离；未迁移 503、题库损坏 503；
6. 样本 <100 → preliminary=true，达到 100 个不同用户后翻为 false；
7. 纯函数评分：难度带加权、区间 ±1 带（A1/C1 截断）。

所有用例离线：数据库在 conftest 的 tmp_path 下通过真实 Alembic CLI 迁移；
题库读仓库内静态 JSON（或 tmp 副本），不联网、不碰 data/app.db。
"""
from __future__ import annotations

import json
import sqlite3

import pytest

import config
import placement
from tests.migration_utils import assert_alembic_ok, run_alembic

PASSWORD = "placement-password-123"
SECOND_EMAIL = "placement-second@example.com"


# ---------------------------------------------------------------------------
# 夹具 / 工具
# ---------------------------------------------------------------------------

def _upgrade() -> None:
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (placement)"
    )


@pytest.fixture()
def placement_db(client):
    """已迁移到 head 的登录客户端。"""
    _upgrade()
    return client


@pytest.fixture()
def second_client(placement_db, make_client):
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
def guest_client(placement_db, make_client):
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


def _start(client) -> dict:
    response = client.get("/api/placement/start")
    assert response.status_code == 200, response.text
    return response.json()


def _submit(client, data: dict, answers: list[dict], duration_ms: int | None = 600_000):
    body = {"sessionId": data["sessionId"], "answers": answers}
    if duration_ms is not None:
        body["durationMs"] = duration_ms
    return client.post("/api/placement/submit", json=body)


def _bank_maps():
    bank = placement.load_bank()
    return (
        {item.prompt: item for item in bank.vocab},
        {item.prompt: item for item in bank.reading},
    )


def _build_answers(
    data: dict,
    *,
    real: str = "correct",
    pseudo: str = "skip",
) -> list[dict]:
    """按卷面生成答案：真词 correct/wrong/skip，伪词 skip/claim。"""
    vocab, reading = _bank_maps()
    answers: list[dict] = []
    for item in data["items"]:
        if item["type"] == "reading":
            bank_item = reading[item["prompt"]]
        elif item["prompt"] in vocab:
            bank_item = vocab[item["prompt"]]
        else:
            if pseudo == "claim":
                answers.append({"itemId": item["itemId"], "chosenIndex": 0})
            elif pseudo == "null":
                answers.append({"itemId": item["itemId"], "chosenIndex": None})
            continue

        if real == "skip":
            continue
        index = bank_item.answer_index
        if real == "wrong":
            index = (index + 1) % 4
        answers.append({"itemId": item["itemId"], "chosenIndex": index})
    return answers


def _real_count(data: dict) -> int:
    vocab, reading = _bank_maps()
    return sum(
        1
        for item in data["items"]
        if item["type"] == "reading" or item["prompt"] in vocab
    )


def _pseudo_items(data: dict) -> list[dict]:
    vocab, _reading = _bank_maps()
    return [
        item
        for item in data["items"]
        if item["type"] == "vocab" and item["prompt"] not in vocab
    ]


# ---------------------------------------------------------------------------
# 题库
# ---------------------------------------------------------------------------

def test_content_bank_is_draft_and_well_formed():
    """三份题库文件数量/草稿标记/选项/正确项/难度带全部符合契约。"""
    bank = placement.load_bank()
    assert len(bank.vocab) == 30
    assert len(bank.reading) == 5
    assert 3 <= len(bank.pseudo) <= 5
    assert len({item.id for item in bank.all_items}) == (
        len(bank.vocab) + len(bank.reading) + len(bank.pseudo)
    )

    for item in bank.vocab:
        assert item.type == "vocab"
        assert item.band in placement.CEFR_BANDS
        assert len(item.options) == 4 and len(set(item.options)) == 4
        assert isinstance(item.answer_index, int) and 0 <= item.answer_index <= 3
        assert item.prompt and item.example
    for item in bank.reading:
        assert item.type == "reading"
        assert item.passage and item.prompt
        assert len(item.options) == 4
        assert isinstance(item.answer_index, int) and 0 <= item.answer_index <= 3
    for item in bank.pseudo:
        assert item.type == "pseudo"
        assert item.answer_index is None
        assert len(item.options) == 4

    for filename in ("vocab.json", "reading.json", "pseudo.json"):
        with open(f"{config.PLACEMENT_DIR}/{filename}", encoding="utf-8") as handle:
            payload = json.load(handle)
        assert "待教研审校" in payload["_meta"]["notice"]

    # 抽题：24 词汇 + 3 伪词 + 5 阅读 = 32；所有难度带都被覆盖。
    for session_id in ("s1", "s2", "s3", "deadbeef"):
        items = placement.sample_items(session_id)
        assert len(items) == placement.SERVED_TOTAL == 32
        vocab, _reading = _bank_maps()
        real = [item for item in items if item.type == "vocab"]
        pseudo = [item for item in items if item.type == "pseudo"]
        reading_items = [item for item in items if item.type == "reading"]
        assert len(real) == 24
        assert len(pseudo) == 3
        assert len(reading_items) == 5
        assert {item.band for item in items} == set(placement.CEFR_BANDS)
        assert all(item.prompt in vocab for item in real)

    # 同一 sessionId 抽题稳定（start/submit 靠这个重算卷面）。
    assert [item.id for item in placement.sample_items("stable")] == [
        item.id for item in placement.sample_items("stable")
    ]
    # 不同 sessionId 顺序/抽样不同（允许极小概率相同，这里取两个已知样本）。
    assert [item.id for item in placement.sample_items("alpha")] != [
        item.id for item in placement.sample_items("beta")
    ]


def test_public_item_never_leaks_answer_index():
    bank = placement.load_bank()
    for item in bank.all_items:
        payload = placement._public_item("q-01", item)
        dumped = json.dumps(payload, ensure_ascii=False)
        assert "answerIndex" not in dumped
        assert "answer_index" not in dumped
        assert payload["type"] in ("vocab", "reading")
        assert len(payload["options"]) == 4
        assert payload["skippable"] is True
        if item.type == "reading":
            assert payload["passage"] == item.passage
        else:
            assert "passage" not in payload


# ---------------------------------------------------------------------------
# start / reset
# ---------------------------------------------------------------------------

def test_start_returns_paper_without_answers_and_mixes_pseudo(placement_db):
    data = _start(placement_db)
    assert data["status"] == "in_progress"
    assert data["resumed"] is False
    assert data["itemCount"] == 32
    assert data["totals"] == {"vocab": 27, "reading": 5, "all": 32}
    assert len(data["items"]) == 32
    assert len({item["itemId"] for item in data["items"]}) == 32
    assert [item["itemId"] for item in data["items"]] == [
        placement.served_item_id(index) for index in range(1, 33)
    ]
    assert sum(1 for item in data["items"] if item["type"] == "vocab") == 27
    assert sum(1 for item in data["items"] if item["type"] == "reading") == 5
    assert _real_count(data) == 29
    assert len(_pseudo_items(data)) == 3
    assert data["preliminary"] is True
    assert data["sampleSize"] == 0
    assert "不是考试分数" in data["disclaimer"]
    assert data["durationLimitMs"] == 720_000

    for item in data["items"]:
        assert len(item["options"]) == 4
        assert item["band"] in placement.CEFR_BANDS
        assert "answerIndex" not in item
        if item["type"] == "reading":
            assert item["passage"]
        else:
            assert "passage" not in item

    with _db() as conn:
        row = conn.execute("SELECT * FROM placement_sessions").fetchone()
    assert row["id"] == data["sessionId"]
    assert row["user_id"] == placement_db.user_id
    assert row["status"] == "in_progress"
    assert row["started_at"] > 0
    assert row["guest_hash"] is None


def test_start_reuses_in_progress_and_reset_allows_new(placement_db):
    first = _start(placement_db)
    second = _start(placement_db)
    assert second["sessionId"] == first["sessionId"]
    assert second["resumed"] is True
    assert [item["itemId"] for item in second["items"]] == [
        item["itemId"] for item in first["items"]
    ]

    reset = placement_db.post("/api/placement/reset")
    assert reset.status_code == 200, reset.text
    assert reset.json()["reset"] is True
    assert reset.json()["abandonedSessions"] == 1
    assert reset.json()["profileKept"] is True

    third = _start(placement_db)
    assert third["sessionId"] != first["sessionId"]
    assert third["resumed"] is False
    assert third["attempt"] == 2  # 一条已作废历史 + 本次新会话
    assert [item["prompt"] for item in third["items"]] != [
        item["prompt"] for item in first["items"]
    ]

    with _db() as conn:
        rows = conn.execute(
            "SELECT id, status FROM placement_sessions ORDER BY started_at"
        ).fetchall()
    assert len(rows) == 2
    assert rows[0]["status"] == "abandoned"
    assert rows[1]["id"] == third["sessionId"]
    assert rows[1]["status"] == "in_progress"

    # 再 reset：中止刚开的第三个会话；再调一次已没有未完成会话。
    assert placement_db.post("/api/placement/reset").json()["abandonedSessions"] == 1
    assert placement_db.post("/api/placement/reset").json()["abandonedSessions"] == 0
    with _db() as conn:
        statuses = [
            row["status"]
            for row in conn.execute("SELECT status FROM placement_sessions")
        ]
    assert statuses == ["abandoned", "abandoned"]


# ---------------------------------------------------------------------------
# submit / 评分 / 画像
# ---------------------------------------------------------------------------

def test_submit_scores_interval_confidence_and_profile(placement_db):
    data = _start(placement_db)
    answers = _build_answers(data, real="correct", pseudo="skip")
    assert len(answers) == 29

    response = _submit(placement_db, data, answers, duration_ms=600_000)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["sessionId"] == data["sessionId"]
    assert result["status"] == "submitted"
    assert result["reused"] is False
    assert result["score"] == 100.0
    assert result["cefr"] == {
        "point": "C1",
        "low": "B2",
        "high": "C1",
        "label": "B2–C1",
    }
    assert result["confidence"] == 0.85
    assert result["confidenceLabel"] == "high"
    assert result["confidenceLabelZh"] == "高"
    assert result["pseudoWordSuspicion"] == 0.0
    assert result["preliminary"] is True
    assert result["sampleSize"] == 1
    assert result["durationMs"] == 600_000
    assert "不是考试分数" in result["disclaimer"]

    breakdown = result["breakdown"]
    assert breakdown["vocab"]["total"] == 24
    assert breakdown["vocab"]["correct"] == 24
    assert breakdown["vocab"]["band"] == "C1"
    assert breakdown["vocab"]["estimate"] == 12000
    assert breakdown["reading"]["total"] == 5
    assert breakdown["reading"]["correct"] == 5
    assert breakdown["reading"]["band"] == "C1"
    assert breakdown["pseudo"] == {
        "total": 3,
        "claimed": 0,
        "skipped": 3,
        "suspicion": 0.0,
    }
    assert breakdown["overall"]["correct"] == 29
    assert breakdown["answered"] == 29
    assert breakdown["skipped"] == 3
    assert breakdown["strengths"]
    assert breakdown["weaknesses"] == []
    assert isinstance(breakdown["advice"], str) and len(breakdown["advice"]) > 10
    assert breakdown["measuredDomains"] == ["vocab", "reading"]
    assert breakdown["notMeasured"] == ["listening", "speaking", "writing"]
    assert breakdown["preliminary"] is True

    profile = result["profile"]
    assert profile["cefr"] == "B2–C1"
    assert profile["levelBandLow"] == "B2"
    assert profile["levelBandHigh"] == "C1"
    assert profile["vocabEstimate"] == 12000
    assert profile["readingEstimate"] == "C1"
    assert profile["confidence"] == 0.85
    assert profile["pseudoWordSuspicion"] == 0.0
    assert profile["source"] == "placement"
    assert profile["preliminary"] is True
    assert profile["sampleSize"] == 1
    assert profile["strengths"] == breakdown["strengths"]
    assert profile["advice"] == breakdown["advice"]

    with _db() as conn:
        session = conn.execute(
            "SELECT * FROM placement_sessions WHERE id=?",
            (data["sessionId"],),
        ).fetchone()
        assert session["status"] == "submitted"
        assert session["submitted_at"] is not None
        assert session["duration_ms"] == 600_000
        assert session["score"] == 100.0
        assert session["cefr"] == "B2–C1"
        assert session["confidence"] == 0.85
        stored = json.loads(session["breakdown"])
        assert stored["breakdown"]["vocab"]["correct"] == 24
        assert stored["cefr"]["label"] == "B2–C1"

        answer_rows = conn.execute(
            "SELECT * FROM placement_answers WHERE session_id=?",
            (data["sessionId"],),
        ).fetchall()
        assert len(answer_rows) == 32
        pseudo_rows = [row for row in answer_rows if row["item_type"] == "pseudo"]
        assert len(pseudo_rows) == 3
        assert all(row["chosen_index"] == -1 for row in pseudo_rows)
        assert all(row["correct"] == 0 for row in pseudo_rows)

        profiles = conn.execute("SELECT * FROM user_profiles").fetchall()
        assert len(profiles) == 1
        assert profiles[0]["user_id"] == placement_db.user_id

    fetched = placement_db.get("/api/placement/profile")
    assert fetched.status_code == 200
    body = fetched.json()
    assert body["profile"]["cefr"] == "B2–C1"
    assert body["sampleSize"] == 1
    assert body["preliminary"] is True


def test_submit_is_idempotent(placement_db):
    data = _start(placement_db)
    answers = _build_answers(data, real="correct")
    first = _submit(placement_db, data, answers)
    assert first.status_code == 200, first.text
    first_body = first.json()
    updated_at = first_body["profile"]["updatedAt"]

    second = _submit(placement_db, data, [])  # 重复提交：答案不同也返回首次结果
    assert second.status_code == 200, second.text
    second_body = second.json()
    assert second_body["reused"] is True
    assert second_body["sessionId"] == first_body["sessionId"]
    assert second_body["score"] == first_body["score"]
    assert second_body["cefr"] == first_body["cefr"]
    assert second_body["confidence"] == first_body["confidence"]
    assert second_body["profile"]["updatedAt"] == updated_at

    with _db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM placement_answers").fetchone()[0] == 32
        assert conn.execute("SELECT COUNT(*) FROM placement_sessions").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM user_profiles").fetchone()[0] == 1
        session = conn.execute("SELECT * FROM placement_sessions").fetchone()
    assert session["status"] == "submitted"


def test_pseudo_claims_lower_confidence_without_changing_score(placement_db):
    # 第一次：全部真词答对 + 伪词都选一个选项（overclaim）
    data = _start(placement_db)
    claimed = _build_answers(data, real="correct", pseudo="claim")
    assert len(claimed) == 32
    result = _submit(placement_db, data, claimed)
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["score"] == 100.0  # 伪词不计分
    assert body["pseudoWordSuspicion"] == 1.0
    assert body["breakdown"]["pseudo"]["claimed"] == 3
    assert body["breakdown"]["pseudo"]["skipped"] == 0
    assert body["confidence"] == 0.40  # 0.85 - 0.45
    assert body["confidenceLabel"] == "low"
    assert body["profile"]["pseudoWordSuspicion"] == 1.0

    # 第二次（老用户重测）：同样全对，但伪词诚实跳过；置信度恢复。
    retake = _start(placement_db)
    assert retake["sessionId"] != data["sessionId"]
    honest = _submit(placement_db, retake, _build_answers(retake, real="correct"))
    assert honest.status_code == 200
    honest_body = honest.json()
    assert honest_body["score"] == body["score"]
    assert honest_body["pseudoWordSuspicion"] == 0.0
    assert honest_body["confidence"] == 0.85
    assert honest_body["confidence"] > body["confidence"]
    assert honest_body["profile"]["pseudoWordSuspicion"] == 0.0

    with _db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM placement_sessions").fetchone()[0] == 2
        assert conn.execute("SELECT COUNT(*) FROM user_profiles").fetchone()[0] == 1


def test_pseudo_null_answer_counts_as_honest(placement_db):
    data = _start(placement_db)
    answers = _build_answers(data, real="correct", pseudo="null")
    assert len(answers) == 32
    result = _submit(placement_db, data, answers)
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["breakdown"]["pseudo"]["claimed"] == 0
    assert body["pseudoWordSuspicion"] == 0.0
    assert body["confidence"] == 0.85
    with _db() as conn:
        pseudo_rows = conn.execute(
            "SELECT * FROM placement_answers WHERE item_type='pseudo'"
        ).fetchall()
    assert len(pseudo_rows) == 3
    assert all(row["chosen_index"] == -1 for row in pseudo_rows)


def test_submit_partial_answers_sets_low_band(placement_db):
    data = _start(placement_db)
    vocab, _reading = _bank_maps()
    answers = []
    for item in data["items"]:
        if item["type"] == "vocab" and item["prompt"] in vocab:
            bank_item = vocab[item["prompt"]]
            if bank_item.band == "A1":
                answers.append(
                    {"itemId": item["itemId"], "chosenIndex": bank_item.answer_index}
                )
        # 其余（含阅读、A2–C1、伪词）全部跳过
    result = _submit(placement_db, data, answers)
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["score"] < 25
    assert body["cefr"]["point"] == "A1"
    assert body["cefr"] == {
        "point": "A1",
        "low": "A1",
        "high": "A2",
        "label": "A1–A2",
    }
    assert body["breakdown"]["overall"]["correct"] == len(answers)
    assert body["breakdown"]["answered"] == len(answers)
    assert body["breakdown"]["skipped"] == 32 - len(answers)
    assert body["confidence"] < 0.85
    assert body["breakdown"]["strengths"]  # 至少给一个相对强项
    assert "advice" in body["breakdown"]


def test_score_session_weights_harder_bands():
    """同样只答对 1 题，C1 题比 A1 题贡献更高的加权分。"""
    bank = placement.load_bank()
    picks = [
        next(item for item in bank.vocab if item.band == band)
        for band in placement.CEFR_BANDS
    ]
    served = tuple(picks)
    assert all(item.answer_index is not None for item in picks)

    only_a1 = {picks[0].id: picks[0].answer_index}
    only_c1 = {picks[-1].id: picks[-1].answer_index}
    all_correct = {item.id: item.answer_index for item in picks}
    none = {}

    a1_result = placement.score_session(
        served, only_a1, duration_ms=600_000, sample_size=1
    )
    c1_result = placement.score_session(
        served, only_c1, duration_ms=600_000, sample_size=1
    )
    assert c1_result["score"] > a1_result["score"]
    assert a1_result["cefr"]["point"] == "A1"
    assert c1_result["cefr"]["point"] == "A2"

    full = placement.score_session(
        served, all_correct, duration_ms=600_000, sample_size=1
    )
    assert full["score"] == 100.0
    assert full["cefr"] == {
        "point": "C1",
        "low": "B2",
        "high": "C1",
        "label": "B2–C1",
    }
    assert full["confidence"] == 0.85
    assert full["pseudoWordSuspicion"] == 0.0

    empty = placement.score_session(served, none, duration_ms=600_000, sample_size=1)
    assert empty["score"] == 0.0
    assert empty["cefr"]["point"] == "A1"
    assert empty["confidence"] < full["confidence"]


def test_submit_duration_defaults_to_server_elapsed(placement_db, monkeypatch):
    data = _start(placement_db)
    started_at = data["startedAt"]
    monkeypatch.setattr(placement, "now_ms", lambda: started_at + 300_000)
    answers = _build_answers(data, real="correct")
    response = _submit(placement_db, data, answers, duration_ms=None)
    assert response.status_code == 200, response.text
    assert response.json()["durationMs"] == 300_000


def test_submit_duration_caps_long_idle_session(placement_db, monkeypatch):
    """会话放了几十天才提交：回算用时截到 24h 上限，不因 CHECK 失败。"""
    data = _start(placement_db)
    started_at = data["startedAt"]
    monkeypatch.setattr(
        placement, "now_ms", lambda: started_at + 30 * 24 * 60 * 60 * 1000
    )
    response = _submit(
        placement_db, data, _build_answers(data, real="correct"), duration_ms=None
    )
    assert response.status_code == 200, response.text
    assert response.json()["durationMs"] == placement.MAX_DURATION_MS

    with _db() as conn:
        row = conn.execute(
            "SELECT duration_ms FROM placement_sessions WHERE id=?",
            (data["sessionId"],),
        ).fetchone()
    assert row["duration_ms"] == placement.MAX_DURATION_MS


# ---------------------------------------------------------------------------
# profile / 游客 / 隔离 / 校验 / 迁移闸门
# ---------------------------------------------------------------------------

def test_profile_null_then_saved_then_reset_keeps_it(placement_db):
    empty = placement_db.get("/api/placement/profile")
    assert empty.status_code == 200, empty.text
    assert empty.json()["profile"] is None
    assert empty.json()["sampleSize"] == 0
    assert empty.json()["preliminary"] is True

    data = _start(placement_db)
    placement_db.post("/api/placement/reset")
    assert placement_db.get("/api/placement/profile").json()["profile"] is None

    data = _start(placement_db)
    submitted = _submit(placement_db, data, _build_answers(data, real="correct"))
    assert submitted.status_code == 200
    assert placement_db.get("/api/placement/profile").json()["profile"] is not None

    reset = placement_db.post("/api/placement/reset")
    assert reset.status_code == 200
    assert reset.json()["abandonedSessions"] == 0
    kept = placement_db.get("/api/placement/profile").json()["profile"]
    assert kept is not None and kept["cefr"] == "B2–C1"


def test_guest_can_take_test_but_result_does_not_cross_devices(
    placement_db, guest_client, make_client
):
    data = _start(guest_client)
    assert data["resumed"] is False
    result = _submit(guest_client, data, _build_answers(data, real="correct"))
    assert result.status_code == 200, result.text
    assert result.json()["profile"]["cefr"] == "B2–C1"

    guest_profile = guest_client.get("/api/placement/profile").json()["profile"]
    assert guest_profile is not None

    with _db() as conn:
        row = conn.execute("SELECT * FROM placement_sessions").fetchone()
    assert row["user_id"].startswith("guest:")
    assert len(row["guest_hash"]) == 64

    # 同一台机器换一个游客 Cookie = 新设备/新游客：看不到上一个游客的结果。
    with make_client() as another_guest:
        another_guest.get("/api/auth/me")
        other_profile = another_guest.get("/api/placement/profile").json()
        assert other_profile["profile"] is None
        other_start = _start(another_guest)
        assert other_start["sessionId"] != data["sessionId"]
        assert other_start["sampleSize"] == 1  # 样本数全站计数，但画像不串

    # 登录用户也看不到游客画像。
    assert placement_db.get("/api/placement/profile").json()["profile"] is None


def test_cross_user_session_and_profile_isolation(placement_db, second_client):
    data = _start(placement_db)

    stolen = second_client.post(
        "/api/placement/submit",
        json={
            "sessionId": data["sessionId"],
            "answers": _build_answers(data, real="correct"),
            "durationMs": 600_000,
        },
    )
    assert stolen.status_code == 404, stolen.text
    assert second_client.get("/api/placement/profile").json()["profile"] is None

    own = _start(second_client)
    assert own["sessionId"] != data["sessionId"]
    submitted = _submit(second_client, own, _build_answers(own, real="correct"))
    assert submitted.status_code == 200
    assert second_client.get("/api/placement/profile").json()["profile"] is not None

    # 第一个用户的会话仍是 in_progress，没有被 B 的提交影响。
    with _db() as conn:
        row = conn.execute(
            "SELECT status FROM placement_sessions WHERE id=?", (data["sessionId"],)
        ).fetchone()
    assert row["status"] == "in_progress"
    assert placement_db.get("/api/placement/profile").json()["profile"] is None


def test_submit_validation_errors(placement_db):
    data = _start(placement_db)
    session_id = data["sessionId"]
    item_id = data["items"][0]["itemId"]

    def post(answers, duration=600_000, **overrides):
        body = {"sessionId": session_id, "answers": answers, "durationMs": duration}
        body.update(overrides)
        return placement_db.post("/api/placement/submit", json=body)

    assert post([{"itemId": "q-99", "chosenIndex": 0}]).status_code == 400
    assert post(
        [
            {"itemId": item_id, "chosenIndex": 0},
            {"itemId": item_id, "chosenIndex": 1},
        ]
    ).status_code == 400
    assert post([{"itemId": item_id, "chosenIndex": 4}]).status_code == 400
    assert post([{"itemId": item_id, "chosenIndex": -2}]).status_code == 400
    assert post([], duration=-1).status_code == 400
    assert post([], duration=placement.MAX_DURATION_MS + 1).status_code == 400
    assert post([], **{"sessionId": ""}).status_code == 400
    assert post([], **{"sessionId": "does-not-exist"}).status_code == 404

    missing = placement_db.post(
        "/api/placement/submit", json={"answers": []}
    )
    assert missing.status_code == 422

    abandoned = placement_db.post("/api/placement/reset")
    assert abandoned.status_code == 200
    assert post([], duration=600_000).status_code == 409

    with _db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM placement_answers").fetchone()[0] == 0


def test_unmigrated_db_returns_503(client):
    for method, url in (
        ("get", "/api/placement/start"),
        ("post", "/api/placement/submit"),
        ("get", "/api/placement/profile"),
        ("post", "/api/placement/reset"),
    ):
        if url.endswith("/submit"):
            response = getattr(client, method)(
                url, json={"sessionId": "x", "answers": []}
            )
        else:
            response = getattr(client, method)(url)
        assert response.status_code == 503, (url, response.text)
        assert "0009_placement" in response.text


def test_broken_bank_returns_503_without_creating_session(
    placement_db, tmp_path, monkeypatch
):
    monkeypatch.setattr(config, "PLACEMENT_DIR", str(tmp_path / "missing"), raising=False)
    response = placement_db.get("/api/placement/start")
    assert response.status_code == 503, response.text
    assert "题库" in response.text
    with _db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM placement_sessions").fetchone()[0] == 0


def test_preliminary_flag_flips_at_100_users(placement_db):
    with _db() as conn:
        conn.executemany(
            "INSERT INTO placement_sessions (id, user_id, status, started_at, "
            "submitted_at) VALUES (?, ?, 'submitted', ?, ?)",
            [
                (f"seed-{index}", f"seed-user-{index}", 1000 + index, 2000 + index)
                for index in range(99)
            ],
        )
        conn.commit()

    data = _start(placement_db)
    assert data["sampleSize"] == 99
    assert data["preliminary"] is True

    result = _submit(placement_db, data, _build_answers(data, real="correct"))
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["sampleSize"] == 100
    assert body["preliminary"] is False
    assert body["breakdown"]["preliminary"] is False
    assert body["profile"]["preliminary"] is False

    fetched = placement_db.get("/api/placement/profile").json()
    assert fetched["sampleSize"] == 100
    assert fetched["preliminary"] is False
