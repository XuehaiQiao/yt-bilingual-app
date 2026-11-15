"""M3 理解题后端离线验收（计划书 §13.2 / specs/014，全离线）。

覆盖：

1. 迁移 0007：内容项 / 题目 / 作答三表、索引、唯一约束、CHECK、外键；
2. 生成 3 题（2 mcq + 1 tf）：题干/选项、证据 block 与秒/毫秒时间点；
3. 两道闸：结构校验失败/内容校验失败 → 整批重试 1 次；仍失败该题 rejected；
4. 缓存：同一 content_hash + prompt 版本只调用一次 LLM；字幕变化才重生成；
5. 失败不阻断：模型连续失败返回 422 且不落库（下次可重试）；全被拒则缓存失败；
6. 作答：attempt 落库、证据回跳字段、quiz_answer 事件、结果统计与错题列表；
7. 跨用户隔离（lesson/question 404）、游客 403、参数 400、未迁移 503；
8. local_show 引用规范化与缓存路径；缺字幕 / 双语不足 8 句给 4xx。

所有用例离线：LLM 全部 monkeypatch；数据库在 conftest 的 tmp_path 下通过
真实 Alembic CLI 迁移；不联网。
"""
from __future__ import annotations

import asyncio
import copy
import json
import sqlite3

import pytest

import config
import events
import llm
import quiz
import storage
from tests.migration_utils import assert_alembic_ok, run_alembic

VIDEO_ID = "quizvid0001"
VIDEO_REF = VIDEO_ID
LOCAL_SHOW_REF = "demo-show-S01E01"
TITLE = "Museum Guide"

OTHER = {"email": "quiz-other@example.com", "password": "quiz-password-123"}

SENTENCES = [
    "The museum opens at nine in the morning.",
    "Visitors can buy tickets at the front desk.",
    "The cafe on the second floor serves fresh coffee.",
    "Guided tours leave every hour.",
    "Children under six enter for free.",
    "The gift shop closes at six in the evening.",
    "Photography is not allowed inside the galleries.",
    "Please keep your voice down during the tour.",
    "The exhibition hall is on the third floor.",
    "Members receive a discount on special events.",
]


# ---------------------------------------------------------------------------
# 夹具 / 工具
# ---------------------------------------------------------------------------

@pytest.fixture()
def quiz_db(client):
    """把当前用例的临时库迁到 head（0007 三表就位），返回已登录客户端。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (quiz)"
    )
    return client


def _blocks(count: int = 8) -> list[dict]:
    return [
        {
            "id": index + 1,
            "start": 1.0 + index * 3,
            "end": 3.0 + index * 3,
            "en_text": SENTENCES[index % len(SENTENCES)],
            "zh_text": f"第{index + 1}句的中文译文。",
        }
        for index in range(count)
    ]


def _write_cache(
    client,
    *,
    blocks: list[dict] | None = None,
    video_id: str = VIDEO_ID,
    title: str = TITLE,
    lang: str = "zh-CN",
    prefix: str = "Museum",
) -> str:
    directory = storage.user_history_dir(client.user_id, lang)
    path = f"{directory}/{prefix}_{video_id}.json"
    payload = {
        "videoId": video_id,
        "metadata": {"title": title, "channel": "Test Channel"},
        "transcript": blocks if blocks is not None else _blocks(),
        "target_lang": lang,
    }
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    return path


def _write_local_show_cache(client, *, blocks: list[dict] | None = None, lang="zh-CN"):
    directory = storage.user_history_dir(client.user_id, lang)
    path = f"{directory}/demo-show_S01E01.json"
    payload = {
        "videoId": LOCAL_SHOW_REF,
        "metadata": {
            "title": "Demo Show S01E01",
            "channel": "Demo",
            "is_local_subtitle": True,
        },
        "transcript": blocks if blocks is not None else _blocks(),
        "target_lang": lang,
    }
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    return path


def _valid_questions() -> list[dict]:
    return [
        {
            "question_type": "mcq",
            "prompt": "When does the museum open?",
            "options": [
                "At nine in the morning",
                "At noon",
                "In the evening",
                "At midnight",
            ],
            "answer_index": 0,
            "evidence_block_id": 1,
            "explanation": "第一句说博物馆早上九点开门。",
        },
        {
            "question_type": "mcq",
            "prompt": "Where can visitors buy tickets?",
            "options": [
                "At the front desk",
                "At the cafe",
                "Online only",
                "At the gift shop",
            ],
            "answer_index": 0,
            "evidence_block_id": 2,
            "explanation": "第二句说在前台买票。",
        },
        {
            "question_type": "tf",
            "prompt": "The cafe serves fresh coffee.",
            "options": ["True", "False"],
            "answer_index": 0,
            "evidence_block_id": 3,
            "explanation": "第三句提到咖啡店供应新鲜咖啡。",
        },
    ]


def _with_option_count(questions: list[dict], index: int = 0, count: int = 3):
    broken = copy.deepcopy(questions)
    broken[index]["options"] = broken[index]["options"][:count]
    return broken


def _with_cjk(questions: list[dict], index: int = 0):
    broken = copy.deepcopy(questions)
    broken[index]["prompt"] = broken[index]["prompt"] + "（中文混入）"
    return broken


def _unrelated(questions: list[dict], index: int = 0):
    broken = copy.deepcopy(questions)
    broken[index] = {
        "question_type": "mcq",
        "prompt": "What is the capital of France?",
        "options": ["Paris", "London", "Berlin", "Rome"],
        "answer_index": 0,
        "evidence_block_id": broken[index]["evidence_block_id"],
        "explanation": "与字幕无关的题目。",
    }
    return broken


def _install_llm(monkeypatch, responses: list):
    """按调用顺序返回响应；dict/list 自动 JSON 序列化，Exception 直接抛。"""
    calls: list[str] = []

    async def fake_generate_json(prompt, model=None):
        calls.append(prompt)
        value = responses[min(len(calls) - 1, len(responses) - 1)]
        if isinstance(value, BaseException):
            raise value
        if isinstance(value, str):
            return value
        return json.dumps(value, ensure_ascii=False)

    monkeypatch.setattr(llm, "generate_json_async", fake_generate_json)
    return calls


def _start(client, *, kind: str = "video", ref: str = VIDEO_REF, lang=None):
    body = {"kind": kind, "contentRef": ref}
    if lang is not None:
        body["targetLang"] = lang
    return client.post("/api/lesson/start", json=body)


def _db_rows(sql: str, params=()):
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(sql, params).fetchall()]


def _question_rows(lesson_id: str):
    return _db_rows(
        "SELECT * FROM questions WHERE content_item_id = ? ORDER BY ordinal, id",
        (lesson_id,),
    )


# ---------------------------------------------------------------------------
# 1. 生成 / 缓存
# ---------------------------------------------------------------------------

def test_start_creates_three_questions_and_reuses_cache(quiz_db, monkeypatch):
    client = quiz_db
    _write_cache(client)
    calls = _install_llm(monkeypatch, [_valid_questions()])

    response = _start(client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ready"
    assert body["kind"] == "video"
    assert body["contentRef"] == VIDEO_REF
    assert body["targetLang"] == "zh-CN"
    assert len(body["contentHash"]) == 32
    assert len(body["questions"]) == 3
    assert [item["questionType"] for item in body["questions"]] == [
        "mcq",
        "mcq",
        "tf",
    ]
    assert [len(item["options"]) for item in body["questions"]] == [4, 4, 2]
    for item in body["questions"]:
        assert item["id"] and item["prompt"] and item["ordinal"]
    assert len(calls) == 1

    # prompt 输入纪律：只给字幕块，不给标题/中文译文。
    assert "Museum Guide" not in calls[0]
    assert "第1句的中文译文" not in calls[0]
    assert "The museum opens at nine in the morning." in calls[0]
    assert "[id=1]" in calls[0]

    items = _db_rows("SELECT * FROM content_items")
    assert len(items) == 1
    assert items[0]["status"] == "ready"
    assert items[0]["prompt_version"] == "quiz.v1"
    assert items[0]["content_hash"] == body["contentHash"]
    questions = _question_rows(body["lessonId"])
    assert len(questions) == 3
    assert {row["status"] for row in questions} == {"approved"}
    assert questions[0]["evidence_block_id"] == "1"
    assert questions[0]["evidence_start"] == 1000
    assert questions[0]["evidence_end"] == 3000
    assert questions[0]["model"]

    # 第二次启动命中缓存：lesson 与题目 id 不变，不再调模型。
    second = _start(client)
    assert second.status_code == 200, second.text
    assert second.json()["lessonId"] == body["lessonId"]
    assert [item["id"] for item in second.json()["questions"]] == [
        item["id"] for item in body["questions"]
    ]
    assert len(calls) == 1
    assert len(_db_rows("SELECT id FROM content_items")) == 1
    assert len(_question_rows(body["lessonId"])) == 3

    got = client.get(f"/api/lesson/{body['lessonId']}/questions")
    assert got.status_code == 200, got.text
    assert len(got.json()["questions"]) == 3
    assert "answerIndex" not in got.json()["questions"][0]


def test_structural_gate_retries_once_then_uses_valid_output(quiz_db, monkeypatch):
    client = quiz_db
    _write_cache(client)
    calls = _install_llm(
        monkeypatch, [_with_option_count(_valid_questions()), _valid_questions()]
    )

    response = _start(client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["questions"]) == 3
    assert len(calls) == 2
    assert "failed validation" in calls[1]
    assert "实际 3 个" in calls[1]
    rows = _question_rows(body["lessonId"])
    assert len(rows) == 3
    assert {row["status"] for row in rows} == {"approved"}


def test_gate_failure_after_retry_marks_question_rejected(quiz_db, monkeypatch):
    client = quiz_db
    _write_cache(client)
    broken = _with_option_count(_valid_questions())
    calls = _install_llm(monkeypatch, [broken, broken])

    response = _start(client)
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["questions"]) == 2
    assert len(calls) == 2

    rows = _question_rows(body["lessonId"])
    assert len(rows) == 3
    statuses = [row["status"] for row in rows]
    assert statuses.count("approved") == 2
    assert statuses.count("rejected") == 1
    rejected = next(row for row in rows if row["status"] == "rejected")
    assert len(json.loads(rejected["options"])) == 3

    # rejected 题不返回给用户。
    got = client.get(f"/api/lesson/{body['lessonId']}/questions")
    assert got.status_code == 200
    assert [item["id"] for item in got.json()["questions"]] == [
        item["id"] for item in body["questions"]
    ]


def test_content_gate_rejects_cjk_prompt_and_retries(quiz_db, monkeypatch):
    client = quiz_db
    _write_cache(client)
    calls = _install_llm(monkeypatch, [_with_cjk(_valid_questions()), _valid_questions()])

    response = _start(client)
    assert response.status_code == 200, response.text
    assert len(response.json()["questions"]) == 3
    assert len(calls) == 2
    assert "中文" in calls[1]


def test_content_gate_rejects_unrelated_questions_and_caches_failure(
    quiz_db, monkeypatch
):
    client = quiz_db
    _write_cache(client)
    unrelated = _valid_questions()
    for index in range(3):
        unrelated = _unrelated(unrelated, index)
    calls = _install_llm(monkeypatch, [unrelated, unrelated])

    response = _start(client)
    assert response.status_code == 422, response.text
    assert "校验" in response.json()["detail"]
    assert len(calls) == 2

    items = _db_rows("SELECT * FROM content_items")
    assert len(items) == 1
    assert items[0]["status"] == "draft"
    rows = _question_rows(items[0]["id"])
    assert len(rows) == 3
    assert {row["status"] for row in rows} == {"rejected"}

    # 结果已落库：第二次启动不再花钱。
    second = _start(client)
    assert second.status_code == 422
    assert len(calls) == 2


def test_concurrent_start_generates_only_once(quiz_db, monkeypatch):
    """两个并发 start 只调用一次模型（进程内按用户+内容+语言串行化）。"""
    client = quiz_db
    _write_cache(client)
    calls: list[str] = []

    async def fake_generate_json(prompt, model=None):
        calls.append(prompt)
        await asyncio.sleep(0.05)  # 让第二个请求确实在锁外等待
        return json.dumps(_valid_questions(), ensure_ascii=False)

    monkeypatch.setattr(llm, "generate_json_async", fake_generate_json)
    token = storage.current_user_id.set(client.user_id)
    try:
        async def run():
            return await asyncio.gather(
                quiz.start_lesson(client.user_id, "video", VIDEO_REF, "zh-CN"),
                quiz.start_lesson(client.user_id, "video", VIDEO_REF, "zh-CN"),
            )

        first, second = asyncio.run(run())
    finally:
        storage.current_user_id.reset(token)

    assert len(calls) == 1
    assert first["lessonId"] == second["lessonId"]
    assert len(first["questions"]) == 3
    assert len(_db_rows("SELECT id FROM content_items")) == 1
    assert len(_question_rows(first["lessonId"])) == 3


def test_content_change_invalidates_question_cache(quiz_db, monkeypatch):
    client = quiz_db
    _write_cache(client)
    calls = _install_llm(monkeypatch, [_valid_questions()])

    first = _start(client)
    assert first.status_code == 200
    assert len(calls) == 1
    old_hash = first.json()["contentHash"]

    changed = _blocks()
    changed[0]["en_text"] = "The museum opens at ten in the morning."
    _write_cache(client, blocks=changed)

    second = _start(client)
    assert second.status_code == 200, second.text
    assert second.json()["lessonId"] == first.json()["lessonId"]
    assert second.json()["contentHash"] != old_hash
    assert len(calls) == 2

    rows = _question_rows(first.json()["lessonId"])
    assert len(rows) == 6
    assert sum(1 for row in rows if row["status"] == "approved") == 3
    assert sum(1 for row in rows if row["status"] == "rejected") == 3
    got = client.get(f"/api/lesson/{first.json()['lessonId']}/questions")
    assert len(got.json()["questions"]) == 3
    assert got.json()["contentHash"] == second.json()["contentHash"]


# ---------------------------------------------------------------------------
# 2. 失败路径 / 输入校验
# ---------------------------------------------------------------------------

def test_missing_or_short_subtitles_and_bad_refs(quiz_db, monkeypatch):
    client = quiz_db
    calls = _install_llm(monkeypatch, [_valid_questions()])

    missing = _start(client, ref="nosuchvideo")
    assert missing.status_code == 404
    assert "双语字幕" in missing.json()["detail"]
    assert calls == []

    _write_cache(client, blocks=_blocks(7))
    short = _start(client)
    assert short.status_code == 422
    assert "不足 8 句" in short.json()["detail"]
    assert calls == []

    # 有 8 句但只有 7 句是真正双语（一条 [未翻译]）→ 也算太短。
    untranslated = _blocks(8)
    untranslated[3]["zh_text"] = "[未翻译]"
    _write_cache(client, video_id="quizvid0002", blocks=untranslated)
    short2 = _start(client, ref="quizvid0002")
    assert short2.status_code == 422
    assert calls == []

    assert _start(client, kind="audio").status_code == 400
    assert _start(client, ref="../etc/passwd").status_code == 400
    assert _start(client, kind="local_show", ref="bad-ref").status_code == 400
    assert _start(client, lang="ja-JP").status_code == 400

    missing_show = _start(client, kind="local_show", ref=LOCAL_SHOW_REF)
    assert missing_show.status_code == 404
    assert "双语字幕" in missing_show.json()["detail"]


def test_llm_failure_returns_422_and_is_not_cached(quiz_db, monkeypatch):
    client = quiz_db
    _write_cache(client)
    calls = _install_llm(
        monkeypatch,
        [RuntimeError("provider down"), RuntimeError("provider down"), _valid_questions()],
    )

    failed = _start(client)
    assert failed.status_code == 422
    assert "模型调用失败" in failed.json()["detail"]
    assert len(calls) == 2
    assert _db_rows("SELECT id FROM content_items") == []

    # 失败不落库：下一次启动可以重试，成功后正常落库。
    retried = _start(client)
    assert retried.status_code == 200, retried.text
    assert len(retried.json()["questions"]) == 3
    assert len(calls) == 3
    assert len(_db_rows("SELECT id FROM content_items")) == 1


def test_quiz_returns_503_without_migration(client, monkeypatch):
    """旧库没跑 0007：明确 503，不静默 200/500。"""
    _write_cache(client)
    calls = _install_llm(monkeypatch, [_valid_questions()])
    response = _start(client)
    assert response.status_code == 503
    assert "0007_quiz" in response.json()["detail"]
    assert calls == []
    assert client.get("/api/lesson/not-migrated/questions").status_code == 503


# ---------------------------------------------------------------------------
# 3. local_show
# ---------------------------------------------------------------------------

def test_local_show_lesson_is_supported_and_ref_is_canonicalized(quiz_db, monkeypatch):
    client = quiz_db
    _write_local_show_cache(client)
    calls = _install_llm(monkeypatch, [_valid_questions()])

    # 下划线写法也接受，内容项里的 content_ref 统一成 SxxEyy 规范形式。
    response = _start(client, kind="local_show", ref="demo-show_S01E01")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["kind"] == "local_show"
    assert body["contentRef"] == LOCAL_SHOW_REF
    assert len(body["questions"]) == 3
    assert len(calls) == 1
    item = _db_rows("SELECT * FROM content_items")[0]
    assert item["kind"] == "local_show"
    assert item["title"] == "Demo Show S01E01"

    # 规范写法再次启动命中同一内容项；斜杠写法也接受并归一到同一引用。
    again = _start(client, kind="local_show", ref=LOCAL_SHOW_REF)
    assert again.status_code == 200
    assert again.json()["lessonId"] == body["lessonId"]
    assert len(calls) == 1
    slash = _start(client, kind="local_show", ref="demo-show/S01E01")
    assert slash.status_code == 200
    assert slash.json()["lessonId"] == body["lessonId"]
    assert len(calls) == 1


# ---------------------------------------------------------------------------
# 4. 作答 / 结果 / 事件
# ---------------------------------------------------------------------------

def test_answer_records_attempt_evidence_event_and_result(quiz_db, monkeypatch):
    client = quiz_db
    _write_cache(client)
    _install_llm(monkeypatch, [_valid_questions()])
    lesson = _start(client).json()
    first, second, third = lesson["questions"]

    # 第 1 题选错。
    wrong = client.post(
        "/api/lesson/answer",
        json={"questionId": first["id"], "chosenIndex": 1, "elapsedMs": 1234},
    )
    assert wrong.status_code == 200, wrong.text
    body = wrong.json()
    assert body["correct"] is False
    assert body["chosenIndex"] == 1
    assert body["answerIndex"] == 0
    assert body["explanation"]
    assert body["questionType"] == "mcq"
    assert body["lessonId"] == lesson["lessonId"]
    assert body["evidence"] == {
        "blockId": 1,
        "start": 1.0,
        "end": 3.0,
        "startMs": 1000,
        "endMs": 3000,
    }
    assert body["attemptId"] and body["answeredAt"]

    attempts = _db_rows("SELECT * FROM attempts")
    assert len(attempts) == 1
    assert attempts[0]["user_id"] == client.user_id
    assert attempts[0]["question_id"] == first["id"]
    assert attempts[0]["chosen_index"] == 1
    assert attempts[0]["is_correct"] == 0
    assert attempts[0]["elapsed_ms"] == 1234

    # 事件：quiz_answer，payload 含 correct / evidence，供周报使用。
    quiz_events = events.query_events(
        user_id=client.user_id, event_type="quiz_answer"
    )
    assert len(quiz_events) == 1
    payload = quiz_events[0]["payload"]
    assert payload["correct"] is False
    assert payload["evidence"]["blockId"] == 1
    assert payload["evidence"]["startMs"] == 1000
    assert payload["lessonId"] == lesson["lessonId"]
    assert payload["questionId"] == first["id"]
    assert quiz_events[0]["content_ref"] == VIDEO_REF

    # 第 2、3 题答对；结果统计与错题证据列表。
    for question in (second, third):
        ok = client.post(
            "/api/lesson/answer",
            json={"questionId": question["id"], "chosenIndex": 0, "elapsedMs": 500},
        )
        assert ok.status_code == 200, ok.text
        assert ok.json()["correct"] is True

    result = client.get(f"/api/lesson/{lesson['lessonId']}/result")
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["totalQuestions"] == 3
    assert data["answered"] == 3
    assert data["correct"] == 2
    assert data["wrong"] == 1
    assert data["correctRate"] == pytest.approx(0.6667)
    assert data["lastAnsweredAt"]
    assert len(data["wrongQuestions"]) == 1
    wrong_item = data["wrongQuestions"][0]
    assert wrong_item["questionId"] == first["id"]
    assert wrong_item["chosenIndex"] == 1
    assert wrong_item["answerIndex"] == 0
    assert wrong_item["evidence"]["blockId"] == 1
    assert wrong_item["evidence"]["start"] == 1.0

    assert len(events.query_events(user_id=client.user_id, event_type="quiz_answer")) == 3


def test_result_before_any_answer(quiz_db, monkeypatch):
    client = quiz_db
    _write_cache(client)
    _install_llm(monkeypatch, [_valid_questions()])
    lesson = _start(client).json()

    result = client.get(f"/api/lesson/{lesson['lessonId']}/result").json()
    assert result["totalQuestions"] == 3
    assert result["answered"] == 0
    assert result["correct"] == 0
    assert result["wrong"] == 0
    assert result["correctRate"] == 0.0
    assert result["wrongQuestions"] == []
    assert result["lastAnsweredAt"] is None


def test_answer_validation(quiz_db, monkeypatch):
    client = quiz_db
    _write_cache(client)
    _install_llm(monkeypatch, [_valid_questions()])
    lesson = _start(client).json()
    question_id = lesson["questions"][0]["id"]

    assert client.post(
        "/api/lesson/answer", json={"questionId": question_id, "chosenIndex": 99}
    ).status_code == 400
    assert client.post(
        "/api/lesson/answer", json={"questionId": question_id}
    ).status_code == 400
    assert client.post(
        "/api/lesson/answer", json={"chosenIndex": 0}
    ).status_code == 400
    assert client.post(
        "/api/lesson/answer",
        json={"questionId": question_id, "chosenIndex": 0, "elapsedMs": -1},
    ).status_code == 400
    assert client.post(
        "/api/lesson/answer",
        json={"questionId": question_id, "chosenIndex": 0, "elapsedMs": 10**12},
    ).status_code == 400
    assert client.post(
        "/api/lesson/answer",
        json={"questionId": "no-such-question", "chosenIndex": 0},
    ).status_code == 404

    assert _db_rows("SELECT id FROM attempts") == []


# ---------------------------------------------------------------------------
# 5. 跨用户隔离 / 游客
# ---------------------------------------------------------------------------

def test_cross_user_isolation(quiz_db, monkeypatch, make_client):
    client = quiz_db
    _write_cache(client)
    _install_llm(monkeypatch, [_valid_questions()])
    lesson = _start(client).json()
    question_id = lesson["questions"][0]["id"]

    with make_client() as other:
        assert other.post("/api/auth/signup", json=OTHER).status_code == 201
        assert other.get(
            f"/api/lesson/{lesson['lessonId']}/questions"
        ).status_code == 404
        assert other.get(f"/api/lesson/{lesson['lessonId']}/result").status_code == 404
        assert other.post(
            "/api/lesson/answer",
            json={"questionId": question_id, "chosenIndex": 0},
        ).status_code == 404

        # 第二个用户没写自己的字幕缓存 → start 404，绝不复用第一个用户的 lesson。
        assert _start(other).status_code == 404
        assert _db_rows("SELECT id FROM content_items") != []


def test_guest_gets_403(quiz_db, make_client):
    guest = make_client()
    with guest as client:
        assert client.post(
            "/api/lesson/start",
            json={"kind": "video", "contentRef": VIDEO_REF},
        ).status_code == 403
        assert client.get("/api/lesson/anything/questions").status_code == 403
        assert client.post(
            "/api/lesson/answer", json={"questionId": "q", "chosenIndex": 0}
        ).status_code == 403
        assert client.get("/api/lesson/anything/result").status_code == 403
