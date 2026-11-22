"""M2 复习引擎离线验收（计划书 §13.2 / specs/013，全离线）。

覆盖：

1. 迁移 0006：三表/列/索引/唯一约束/CHECK，升级与回滚（同时扩展
   test_migrations.py 的 schema 契约）；
2. FSRS 纯调度：确定性、again/hard/good/easy 间隔顺序、状态映射；
3. 连续 3 次 again 自动 suspend · 作答 409 · 手工恢复后继续；
4. add_word 幂等（重复添加不重置进度）与来源去重/补充；
5. 队列：跨用户隔离、targetLang 过滤、到期/新词排序、limit/newLimit；
6. stats：今日到期/已复习/新词/连续天数（注入时钟跨日）；
7. API：游客 403、400/404/409/503、删除恢复的 query/body 两种写法、
   ``GET /api/review/words`` 的 ``mastered`` / ``state`` 过滤与校验；
8. 复习日志快照与 elapsed_ms 落库、换设备登录后队列一致。

所有时间都由测试注入（monkeypatch ``srs.now_ms``），不读真实时钟。
数据库在 conftest 的 tmp_path 下，通过真实 Alembic CLI 迁移；不联网。
"""
from __future__ import annotations

import json
import sqlite3

import pytest

import config
import srs
from tests.migration_utils import assert_alembic_ok, run_alembic

# 2025-10-09 08:53:20 UTC，避免恰好落在日界上。
NOW = 1_760_000_000_000
DAY = srs.MS_PER_DAY
HOUR = 60 * 60 * 1000
MINUTE = 60 * 1000

USER = {"email": "test-user@example.com", "password": "test-password-123"}
OTHER = {"email": "review-other@example.com", "password": "review-password-123"}


# ---------------------------------------------------------------------------
# 夹具 / 工具
# ---------------------------------------------------------------------------

@pytest.fixture()
def review_db(client):
    """把当前用例的临时库迁到 head（0006 三表就位），返回已登录客户端。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (review)"
    )
    return client


@pytest.fixture()
def clock(monkeypatch):
    """可推进的注入时钟：clock['now'] 改一下，下一次请求就用新时间。"""
    state = {"now": NOW}
    monkeypatch.setattr(srs, "now_ms", lambda: state["now"])
    return state


def _add(client, lemma, target="zh-CN", source=None, definition=None):
    body = {"lemma": lemma, "targetLang": target}
    if source is not None:
        body["source"] = source
    if definition is not None:
        body["definition"] = definition
    return client.post("/api/review/words", json=body)


def _queue(client, **params):
    return client.get("/api/review/queue", params=params)


def _answer(client, lemma, rating, target="zh-CN", elapsed_ms=None):
    body = {"lemma": lemma, "rating": rating, "targetLang": target}
    if elapsed_ms is not None:
        body["elapsedMs"] = elapsed_ms
    return client.post("/api/review/answer", json=body)


def _stats(client, target="zh-CN"):
    params = {} if target is None else {"targetLang": target}
    return client.get("/api/review/stats", params=params)


def _db_rows(sql, params=()):
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(sql, params).fetchall()]


def _new_state(**overrides):
    state = {
        "id": "w1",
        "user_id": "u1",
        "lemma": "hello",
        "target_lang": "zh-CN",
        "state": "new",
        "due_at": NOW,
        "stability": None,
        "difficulty": None,
        "reps": 0,
        "lapses": 0,
        "step": 0,
        "fail_streak": 0,
        "last_reviewed_at": None,
        "created_at": NOW,
    }
    state.update(overrides)
    return state


# ---------------------------------------------------------------------------
# 1. FSRS 纯调度
# ---------------------------------------------------------------------------

def test_review_is_deterministic_and_does_not_mutate_input():
    state = _new_state(
        state="review",
        stability=10.0,
        difficulty=5.0,
        reps=3,
        lapses=1,
        fail_streak=1,
        last_reviewed_at=NOW - 10 * DAY,
    )
    before = json.dumps(state, sort_keys=True)
    first = srs.review(state, "good", now=NOW)
    second = srs.review(state, "good", now=NOW)

    assert first == second
    assert json.dumps(state, sort_keys=True) == before  # 纯函数不改入参
    assert first["state"] == "review"
    assert first["reps"] == 4
    assert first["lapses"] == 1
    assert first["fail_streak"] == 0
    assert first["last_reviewed_at"] == NOW
    assert first["due_at"] > NOW


def test_rating_intervals_are_ordered_from_new():
    intervals = {}
    for rating in ("again", "hard", "good", "easy"):
        updated = srs.review(_new_state(), rating, now=NOW)
        intervals[rating] = updated["due_at"] - NOW
        assert updated["reps"] == 1
        assert updated["fail_streak"] == (1 if rating == "again" else 0)
        assert updated["lapses"] == (1 if rating == "again" else 0)

    # FSRS 默认学习步长：Again 1 分钟、Hard 5.5 分钟、Good 10 分钟；
    # Easy 直接毕业到 Review（按天）。
    assert intervals["again"] == MINUTE
    assert intervals["hard"] == int(5.5 * MINUTE)
    assert intervals["good"] == 10 * MINUTE
    assert intervals["easy"] > intervals["good"]
    assert list(intervals.values()) == sorted(intervals.values())
    assert list(intervals.values()) == [
        intervals[key] for key in ("again", "hard", "good", "easy")
    ]


def test_rating_intervals_are_ordered_from_review():
    state = _new_state(
        state="review",
        stability=10.0,
        difficulty=5.0,
        reps=5,
        last_reviewed_at=NOW - 10 * DAY,
    )
    intervals = {
        rating: srs.review(state, rating, now=NOW)["due_at"] - NOW
        for rating in ("again", "hard", "good", "easy")
    }
    # Again 进入 10 分钟重学；其余按 FSRS 间隔升序。
    assert intervals["again"] == 10 * MINUTE
    assert intervals["hard"] < intervals["good"] < intervals["easy"]


def test_unknown_rating_and_suspended_state_are_rejected():
    with pytest.raises(ValueError):
        srs.review(_new_state(), "perfect", now=NOW)
    with pytest.raises(srs.WordSuspended):
        srs.review(_new_state(state="suspended"), "good", now=NOW)


# ---------------------------------------------------------------------------
# 2. 连续失败 suspend / 手工恢复
# ---------------------------------------------------------------------------

def test_three_again_auto_suspends_then_manual_restore(review_db, clock):
    client = review_db
    assert _add(client, "Trip").status_code == 201

    first = _answer(client, "trip", "again")
    second = _answer(client, "trip", "again")
    third = _answer(client, "trip", "again")

    assert first.status_code == 200 and first.json()["word"]["state"] == "learning"
    assert second.status_code == 200 and second.json()["word"]["state"] == "learning"
    body = third.json()
    assert third.status_code == 200
    assert body["suspended"] is True
    assert body["autoSuspended"] is True
    assert body["word"]["state"] == "suspended"
    assert body["word"]["failStreak"] == 3
    assert body["word"]["lapses"] == 3

    # suspended 不进队列，也不能继续作答。
    assert _queue(client).json()["items"] == []
    blocked = _answer(client, "trip", "good")
    assert blocked.status_code == 409
    assert "暂停" in blocked.json()["detail"]

    # 手工恢复：回到 review，失败计数清零，dueAt = now。
    restored = client.delete(
        "/api/review/suspend", params={"lemma": "trip", "targetLang": "zh-CN"}
    )
    assert restored.status_code == 200, restored.text
    word = restored.json()["word"]
    assert restored.json()["suspended"] is False
    assert word["state"] == "review"
    assert word["failStreak"] == 0
    assert word["dueAt"] == clock["now"]
    assert word["reps"] == 3

    # 恢复后可以继续作答，不会因为恢复前的 3 条 again 日志立刻再被暂停。
    resumed = _answer(client, "trip", "good")
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["suspended"] is False
    assert resumed.json()["word"]["reps"] == 4
    assert resumed.json()["word"]["state"] == "review"


def test_suspended_list_exposes_paused_words_for_restore(review_db):
    client = review_db
    assert _add(client, "calm").status_code == 201
    assert _add(client, "trip").status_code == 201
    for lemma in ("calm", "trip"):
        assert client.post("/api/review/suspend", json={"lemma": lemma}).status_code == 200

    listed = client.get("/api/review/suspended")
    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert body["total"] == 2
    assert {word["lemma"] for word in body["words"]} == {"calm", "trip"}
    assert all(word["state"] == "suspended" for word in body["words"])
    # 恢复入口需要的字段（前端直接渲染）在列表里就有。
    assert all("targetLang" in word and "sources" in word for word in body["words"])

    restored = client.delete(
        "/api/review/suspend", params={"lemma": "calm", "targetLang": "zh-CN"}
    )
    assert restored.status_code == 200
    after = client.get("/api/review/suspended").json()
    assert [word["lemma"] for word in after["words"]] == ["trip"]
    assert after["total"] == 1


def test_manual_suspend_is_idempotent_and_restore_is_idempotent(review_db):
    client = review_db
    assert _add(client, "calm").status_code == 201

    first = client.post("/api/review/suspend", json={"lemma": "calm"})
    second = client.post("/api/review/suspend", json={"lemma": "calm"})
    assert first.status_code == 200 and first.json()["word"]["state"] == "suspended"
    assert second.status_code == 200 and second.json()["word"]["state"] == "suspended"

    # reps=0：恢复到 new；重复恢复保持 new。
    restored = client.delete("/api/review/suspend?lemma=calm")
    assert restored.status_code == 200
    assert restored.json()["word"]["state"] == "new"
    again = client.delete("/api/review/suspend?lemma=calm")
    assert again.status_code == 200
    assert again.json()["word"]["state"] == "new"

    # 不存在的词 → 404；缺 lemma → 400。
    assert client.post(
        "/api/review/suspend", json={"lemma": "missing"}
    ).status_code == 404
    assert client.delete("/api/review/suspend").status_code == 400


# ---------------------------------------------------------------------------
# 3. add_word 幂等 / 来源
# ---------------------------------------------------------------------------

def test_add_word_is_idempotent_and_does_not_reset_progress(review_db, clock):
    client = review_db
    created = _add(client, "Hello", source={"contentRef": "vid1", "sentenceId": "s1"})
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["created"] is True
    word = body["word"]
    assert word["lemma"] == "hello"  # NFC + 小写规范化
    assert word["state"] == "new"
    assert word["reps"] == 0
    assert word["sources"][0]["contentRef"] == "vid1"
    assert word["sources"][0]["sentenceId"] == "s1"

    answered = _answer(client, "hello", "good")
    assert answered.status_code == 200
    after_answer = answered.json()["word"]
    assert after_answer["reps"] == 1
    assert after_answer["state"] == "learning"

    # 重复添加（大小写不同 + 同一来源）：200 created=false，进度不动。
    repeated = _add(
        client, "HELLO", source={"contentRef": "vid1", "sentenceId": "s1"}
    )
    assert repeated.status_code == 200
    repeated_word = repeated.json()["word"]
    assert repeated.json()["created"] is False
    assert repeated_word["id"] == word["id"]
    assert repeated_word["reps"] == after_answer["reps"] == 1
    assert repeated_word["dueAt"] == after_answer["dueAt"]
    assert repeated_word["state"] == after_answer["state"]
    assert len(repeated_word["sources"]) == 1  # 同来源去重

    # 新来源：不重置进度，但来源列表补一条。
    new_source = _add(
        client, "hello", source={"videoId": "vid2", "sentence_id": "s2"}
    )
    assert new_source.status_code == 200
    assert new_source.json()["created"] is False
    assert new_source.json()["word"]["reps"] == 1
    assert new_source.json()["word"]["dueAt"] == after_answer["dueAt"]
    assert len(new_source.json()["word"]["sources"]) == 2

    # 字符串来源也接受，并映射为 contentRef。
    string_source = _add(client, "world", source="article-1")
    assert string_source.status_code == 201
    assert string_source.json()["word"]["sources"][0]["contentRef"] == "article-1"


# ---------------------------------------------------------------------------
# 4. 队列：隔离 / 排序 / limit / 语言
# ---------------------------------------------------------------------------

def test_queue_isolation_ordering_and_target_language(review_db, clock, make_client):
    client = review_db
    t0 = NOW - 30 * MINUTE
    clock["now"] = t0
    for lemma in ("alpha", "beta", "gamma"):
        assert _add(client, lemma).status_code == 201
    assert _add(client, "hola", target="vi-VN").status_code == 201

    # beta 的到期更早（Again 1 分钟），alpha 更晚（Good 10 分钟）。
    clock["now"] = t0 + MINUTE
    assert _answer(client, "beta", "again").status_code == 200
    clock["now"] = t0 + 2 * MINUTE
    assert _answer(client, "alpha", "good").status_code == 200

    clock["now"] = NOW
    queue = _queue(client, targetLang="zh-CN")
    assert queue.status_code == 200, queue.text
    body = queue.json()
    assert [item["lemma"] for item in body["due"]] == ["beta", "alpha"]
    assert [item["lemma"] for item in body["new"]] == ["gamma"]
    assert [item["lemma"] for item in body["items"]] == ["beta", "alpha", "gamma"]
    assert body["counts"] == {"due": 2, "new": 1, "total": 3}
    # 到期时间升序
    assert [item["dueAt"] for item in body["due"]] == sorted(
        item["dueAt"] for item in body["due"]
    )

    # 语言过滤：vi 队列只有 hola。
    vi_queue = _queue(client, targetLang="vi-VN").json()
    assert [item["lemma"] for item in vi_queue["items"]] == ["hola"]

    # limit 是总条数上限。
    limited = _queue(client, targetLang="zh-CN", limit=2).json()
    assert [item["lemma"] for item in limited["items"]] == ["beta", "alpha"]
    # newLimit=0 只回到期词。
    no_new = _queue(client, targetLang="zh-CN", newLimit=0).json()
    assert no_new["new"] == []
    assert [item["lemma"] for item in no_new["items"]] == ["beta", "alpha"]

    # 跨用户隔离：第二个用户看不到第一个用户的词。
    with make_client() as other:
        assert other.post("/api/auth/signup", json=OTHER).status_code == 201
        other_queue = _queue(other, targetLang="zh-CN").json()
        assert other_queue["items"] == []
        assert other_queue["counts"] == {"due": 0, "new": 0, "total": 0}


def test_queue_new_word_limit_is_created_at_order(review_db, clock):
    client = review_db
    for index, lemma in enumerate(("one", "two", "three", "four", "five")):
        clock["now"] = NOW + index * 1000
        assert _add(client, lemma).status_code == 201

    clock["now"] = NOW + 10_000
    body = _queue(client, targetLang="zh-CN", newLimit=3, limit=10).json()
    assert [item["lemma"] for item in body["new"]] == ["one", "two", "three"]
    assert body["counts"] == {"due": 0, "new": 3, "total": 3}
    assert body["newLimit"] == 3

    one = _queue(client, targetLang="zh-CN", limit=1).json()
    assert [item["lemma"] for item in one["items"]] == ["one"]
    assert one["counts"]["total"] == 1


def test_queue_returns_503_without_migration(client):
    """旧库没跑 0006：明确 503，不静默空队列、不 500。"""
    response = _queue(client, targetLang="zh-CN")
    assert response.status_code == 503
    assert "0006_review_engine" in response.json()["detail"]
    assert _add(client, "word").status_code == 503


# ---------------------------------------------------------------------------
# 5. 统计
# ---------------------------------------------------------------------------

def test_stats_today_due_reviewed_new_and_streak(review_db, clock):
    client = review_db
    clock["now"] = NOW
    assert _add(client, "alpha").status_code == 201
    assert _add(client, "beta").status_code == 201
    assert _answer(client, "alpha", "good").status_code == 200

    day1 = _stats(client).json()
    assert day1["today"] == "2025-10-09"
    assert day1["dueToday"] == 1  # alpha 今天 10 分钟后到期
    assert day1["dueNow"] == 0
    assert day1["reviewedToday"] == 1
    assert day1["reviewedWordsToday"] == 1
    assert day1["newWords"] == 1
    assert day1["newToday"] == 2
    assert day1["totalWords"] == 2
    assert day1["suspendedWords"] == 0
    assert day1["streakDays"] == 1

    # 第 2 天：alpha 已过期，beta 今天复习（结束后 due 在今天）。
    clock["now"] = NOW + DAY
    assert _answer(client, "beta", "good").status_code == 200
    day2 = _stats(client).json()
    assert day2["today"] == "2025-10-10"
    assert day2["dueNow"] == 1  # alpha
    assert day2["dueToday"] == 2
    assert day2["reviewedToday"] == 1
    assert day2["newWords"] == 0
    assert day2["newToday"] == 0
    assert day2["streakDays"] == 2

    # 跳过第 3 天，第 4 天没有复习：连续天数归零。
    clock["now"] = NOW + 3 * DAY
    day4 = _stats(client).json()
    assert day4["today"] == "2025-10-12"
    assert day4["reviewedToday"] == 0
    assert day4["streakDays"] == 0
    assert day4["dueNow"] == 2

    # 不传 targetLang 统计全部语言；vi 词不污染 zh-CN 统计。
    assert _add(client, "hola", target="vi-VN").status_code == 201
    all_stats = _stats(client, target=None).json()
    assert all_stats["targetLang"] is None
    assert all_stats["totalWords"] == 3
    zh_stats = _stats(client, target="zh-CN").json()
    assert zh_stats["totalWords"] == 2


def test_stats_validation(review_db):
    client = review_db
    assert _stats(client, target="xx-XX").status_code == 400


# ---------------------------------------------------------------------------
# 6. 作答日志 / 跨设备
# ---------------------------------------------------------------------------

def test_answer_writes_review_log_snapshots(review_db, clock):
    client = review_db
    assert _add(client, "hello").status_code == 201
    response = _answer(client, "hello", "good", elapsed_ms=1234)
    assert response.status_code == 200

    logs = _db_rows(
        "SELECT rating, state_before, state_after, elapsed_ms, reviewed_at "
        "FROM review_logs WHERE lemma = 'hello'"
    )
    assert len(logs) == 1
    log = logs[0]
    assert log["rating"] == "good"
    assert log["elapsed_ms"] == 1234
    before = json.loads(log["state_before"])
    after = json.loads(log["state_after"])
    assert before["state"] == "new"
    assert before["reps"] == 0
    assert after["state"] == "learning"
    assert after["reps"] == 1
    assert log["reviewed_at"] == NOW

    # 状态表也已更新（reps / due_at / last_reviewed_at 一致）。
    rows = _db_rows(
        "SELECT state, reps, due_at, last_reviewed_at FROM word_states "
        "WHERE lemma = 'hello'"
    )
    assert rows[0]["state"] == "learning"
    assert rows[0]["reps"] == 1
    assert rows[0]["due_at"] > NOW
    assert rows[0]["last_reviewed_at"] == NOW


def test_queue_is_consistent_across_devices(review_db, clock, make_client):
    client = review_db
    clock["now"] = NOW
    assert _add(client, "alpha").status_code == 201
    assert _add(client, "beta").status_code == 201
    assert _answer(client, "alpha", "good").status_code == 200

    with make_client() as second:
        login = second.post(
            "/api/auth/login",
            json={"email": USER["email"], "password": USER["password"]},
        )
        assert login.status_code == 200, login.text
        second_queue = _queue(second, targetLang="zh-CN").json()
        first_queue = _queue(client, targetLang="zh-CN").json()
        assert second_queue == first_queue
        assert [item["lemma"] for item in second_queue["items"]] == ["beta"]
        # 同一账号：在第二台设备作答，第一台立刻看到队列变化。
        assert _answer(second, "beta", "good").status_code == 200
        assert _queue(client, targetLang="zh-CN").json()["items"] == []


# ---------------------------------------------------------------------------
# 7. API 校验 / 游客 / 恢复 body
# ---------------------------------------------------------------------------

def test_guest_is_forbidden_on_all_review_endpoints(make_client):
    with make_client() as guest:
        calls = [
            guest.post("/api/review/words", json={"lemma": "hello"}),
            guest.get("/api/review/words", params={"mastered": "1"}),
            guest.get("/api/review/queue"),
            guest.post(
                "/api/review/answer", json={"lemma": "hello", "rating": "good"}
            ),
            guest.get("/api/review/stats"),
            guest.post("/api/review/suspend", json={"lemma": "hello"}),
            guest.delete("/api/review/suspend?lemma=hello"),
        ]
        for response in calls:
            assert response.status_code == 403, response.text


def test_api_validation_errors(review_db, clock):
    client = review_db
    assert _add(client, "hello").status_code == 201
    assert _add(client, "").status_code == 400
    assert _add(client, "hello", target="xx-XX").status_code == 400
    assert _add(client, "hello", source=["not", "a", "source"]).status_code == 400
    assert _answer(client, "missing", "good").status_code == 404
    assert _answer(client, "hello", "perfect").status_code == 400
    assert _answer(client, "hello", "good", elapsed_ms=-1).status_code == 400
    assert _queue(client, targetLang="xx-XX").status_code == 400
    assert _queue(client, limit=0).status_code == 422


def test_restore_accepts_json_body(review_db):
    client = review_db
    assert _add(client, "bodyword").status_code == 201
    assert client.post(
        "/api/review/suspend", json={"lemma": "bodyword", "targetLang": "zh-CN"}
    ).status_code == 200
    restored = client.request(
        "DELETE",
        "/api/review/suspend",
        json={"lemma": "bodyword", "targetLang": "zh-CN"},
    )
    assert restored.status_code == 200, restored.text
    assert restored.json()["word"]["state"] == "new"


# ---------------------------------------------------------------------------
# 8. 已掌握（mastered，specs/013 v1.1 / 迁移 0027）
# ---------------------------------------------------------------------------

def _master(client, lemma, mastered, target="zh-CN", source=None, definition=None):
    body = {"lemma": lemma, "targetLang": target, "mastered": mastered}
    if source is not None:
        body["source"] = source
    if definition is not None:
        body["definition"] = definition
    return client.patch("/api/review/words", json=body)


def test_mastered_word_leaves_queue_and_stats_count_it(review_db, clock):
    client = review_db
    clock["now"] = NOW
    assert _add(client, "alpha").status_code == 201
    clock["now"] = NOW + 1000  # created_at 决定新词顺序，避免同毫秒按 id 排序
    assert _add(client, "beta").status_code == 201
    assert [item["lemma"] for item in _queue(client).json()["items"]] == [
        "alpha",
        "beta",
    ]

    marked = _master(client, "alpha", True)
    assert marked.status_code == 200, marked.text
    body = marked.json()
    assert body["status"] == "ok"
    assert body["word"]["mastered"] is True
    assert body["word"]["state"] == "new"  # 标记不新增 state 取值
    assert [item["lemma"] for item in _queue(client).json()["items"]] == ["beta"]

    stats = _stats(client).json()
    assert stats["masteredWords"] == 1
    assert stats["newWords"] == 1  # alpha 不再算新词
    assert stats["totalWords"] == 2  # 但仍在生词本里

    # 撤销：回到队列，标记清零，FSRS / reps 不变（这条新词本来也没复习过）。
    undone = _master(client, "alpha", False)
    assert undone.status_code == 200, undone.text
    assert undone.json()["word"]["mastered"] is False
    assert [item["lemma"] for item in _queue(client).json()["items"]] == [
        "alpha",
        "beta",
    ]
    assert _stats(client).json()["masteredWords"] == 0


def test_mastered_excluded_from_due_queue_without_resetting_fsrs(review_db, clock):
    client = review_db
    clock["now"] = NOW
    assert _add(client, "gamma").status_code == 201
    assert _answer(client, "gamma", "good").status_code == 200

    clock["now"] = NOW + 60 * MINUTE  # gamma 到期
    due = _queue(client).json()
    assert [item["lemma"] for item in due["due"]] == ["gamma"]
    before = due["due"][0]
    stats = _stats(client).json()
    assert stats["dueToday"] == 1 and stats["dueNow"] == 1

    marked = _master(client, "gamma", True).json()["word"]
    assert marked["mastered"] is True
    # 标记只加在词状态之上：FSRS 参数与复习进度原样保留。
    assert marked["reps"] == before["reps"] == 1
    assert marked["dueAt"] == before["dueAt"]
    assert marked["stability"] == before["stability"]

    empty = _queue(client).json()
    assert empty["items"] == [] and empty["due"] == [] and empty["new"] == []
    stats = _stats(client).json()
    assert stats["dueToday"] == 0 and stats["dueNow"] == 0
    assert stats["masteredWords"] == 1


def test_patch_mastered_upserts_and_is_idempotent(review_db):
    client = review_db

    # 词不存在：建行（state=new），不要求先 POST /words。
    first = _master(client, "fresh", True)
    assert first.status_code == 200, first.text
    word = first.json()["word"]
    assert word["mastered"] is True
    assert word["state"] == "new"
    fresh_id = word["id"]

    # 同一个值重复 PATCH：同一行、字段不变。
    second = _master(client, "fresh", True)
    assert second.status_code == 200, second.text
    assert second.json()["word"]["id"] == fresh_id
    rows = _db_rows(
        "SELECT id, mastered FROM word_states WHERE lemma = 'fresh'"
    )
    assert len(rows) == 1
    assert rows[0]["mastered"] == 1

    # 撤销：仍只有一行，标记 0，回到（新词）队列。
    undone = _master(client, "Fresh", False)  # 大小写归一化到同一行
    assert undone.status_code == 200, undone.text
    assert undone.json()["word"]["id"] == fresh_id
    assert undone.json()["word"]["mastered"] is False
    assert len(_db_rows("SELECT id FROM word_states WHERE lemma = 'fresh'")) == 1
    assert [item["lemma"] for item in _queue(client).json()["items"]] == ["fresh"]

    # source 可选：带来源只为该词记一条来源，不重复建行。
    sourced = _master(
        client, "fresh", True, source={"contentRef": "vid-1", "sentenceId": "s1"}
    )
    assert sourced.status_code == 200, sourced.text
    sources = sourced.json()["word"]["sources"]
    assert [(s["contentRef"], s["sentenceId"]) for s in sources] == [
        ("vid-1", "s1")
    ]
    assert len(_db_rows("SELECT id FROM word_states WHERE lemma = 'fresh'")) == 1


def test_readding_a_mastered_word_clears_the_flag(review_db, clock):
    client = review_db
    clock["now"] = NOW
    assert _add(client, "repeat").status_code == 201
    assert _master(client, "repeat", True).json()["word"]["mastered"] is True
    assert _queue(client).json()["items"] == []

    # 再次「加入复习」= 想复习：强制 mastered=0，且仍是幂等（不新建行）。
    again = _add(client, "repeat")
    assert again.status_code == 200, again.text
    body = again.json()
    assert body["created"] is False
    assert body["word"]["mastered"] is False
    assert _db_rows(
        "SELECT mastered FROM word_states WHERE lemma = 'repeat'"
    )[0]["mastered"] == 0
    assert [item["lemma"] for item in _queue(client).json()["items"]] == ["repeat"]


def test_patch_mastered_validation_and_guest(make_client, review_db):
    client = review_db
    assert _master(client, "", True).status_code == 400
    assert _master(client, "hello", True, target="xx-XX").status_code == 400
    assert _master(client, "hello", "yes").status_code == 400
    assert _master(client, "hello", 1).status_code == 400
    missing = client.patch("/api/review/words", json={"lemma": "hello"})
    assert missing.status_code == 400
    assert _master(
        client, "hello", True, source=["not", "a", "source"]
    ).status_code == 400

    with make_client() as guest:
        assert _master(guest, "hello", True).status_code == 403


def test_list_mastered_words_endpoint(review_db, clock):
    """GET /api/review/words：缺省全部词；?mastered=1 即「已掌握」列表（单一真相）。"""
    client = review_db
    clock["now"] = NOW
    assert _add(client, "alpha").status_code == 201
    clock["now"] = NOW + 1000  # created_at 决定排序，避免同毫秒按 id
    assert _add(client, "beta").status_code == 201
    assert _master(client, "alpha", True).status_code == 200

    listed = client.get("/api/review/words", params={"mastered": "1"})
    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert body["targetLang"] is None
    assert body["now"] == clock["now"]
    assert body["total"] == 1
    assert [word["lemma"] for word in body["words"]] == ["alpha"]
    word = body["words"][0]
    assert word["mastered"] is True
    assert word["state"] == "new"  # 标记不是 state 取值
    # 复用 to_public_word：与 POST/PATCH 的 word 同形。
    assert {"id", "lemma", "targetLang", "state", "dueAt", "mastered", "sources"} <= set(
        word
    )

    # mastered=0 只返回未掌握；省略 mastered = 不过滤（全部词）。
    unmastered = client.get("/api/review/words", params={"mastered": "0"}).json()
    assert unmastered["total"] == 1
    assert [item["lemma"] for item in unmastered["words"]] == ["beta"]
    everything = client.get("/api/review/words").json()
    assert everything["total"] == 2
    assert [item["lemma"] for item in everything["words"]] == ["beta", "alpha"]

    # 排序：COALESCE(last_reviewed_at, created_at) DESC —— 复习过的词更新更近。
    clock["now"] = NOW + 10 * MINUTE
    assert _answer(client, "beta", "good").status_code == 200
    ordered = client.get("/api/review/words").json()
    assert [item["lemma"] for item in ordered["words"]] == ["beta", "alpha"]

    # 语言过滤 + limit：limit 只截断列表，total 是过滤后总数。
    assert _add(client, "hola", target="vi-VN").status_code == 201
    assert _master(client, "hola", True, target="vi-VN").status_code == 200
    zh = client.get(
        "/api/review/words", params={"mastered": "1", "targetLang": "zh-CN"}
    ).json()
    assert zh["targetLang"] == "zh-CN"
    assert zh["total"] == 1 and [item["lemma"] for item in zh["words"]] == ["alpha"]
    all_langs = client.get("/api/review/words", params={"mastered": "1"}).json()
    assert all_langs["total"] == 2
    limited = client.get("/api/review/words", params={"limit": 1}).json()
    assert limited["total"] == 3 and len(limited["words"]) == 1

    # 撤销标记后从「已掌握」列表消失。
    assert _master(client, "alpha", False).status_code == 200
    gone = client.get(
        "/api/review/words", params={"mastered": "1", "targetLang": "zh-CN"}
    ).json()
    assert gone["total"] == 0 and gone["words"] == []


def test_list_words_validation(review_db):
    """mastered 只接受 0/1（其余 400）；limit 越界 422；targetLang 非法 400。"""
    client = review_db
    for bad in ("2", "true", "yes", ""):
        response = client.get("/api/review/words", params={"mastered": bad})
        assert response.status_code == 400, (bad, response.text)
        assert "0" in response.json()["detail"] and "1" in response.json()["detail"]
    assert (
        client.get(
            "/api/review/words", params={"mastered": "1", "targetLang": "xx-XX"}
        ).status_code
        == 400
    )
    assert client.get("/api/review/words", params={"limit": 0}).status_code == 422
    assert client.get("/api/review/words", params={"limit": 201}).status_code == 422


def _seed_all_states(client, clock):
    """造出 5 种 ``state`` 各一个词，返回 ``{state: lemma}``（specs/013 state 筛选）。"""
    clock["now"] = NOW
    words = {}
    assert _add(client, "alpha").status_code == 201  # new：加词不答
    words["new"] = "alpha"

    clock["now"] += 1000
    assert _add(client, "bravo").status_code == 201
    learning = _answer(client, "bravo", "good")
    assert learning.status_code == 200
    assert learning.json()["word"]["state"] == "learning"
    words["learning"] = "bravo"

    clock["now"] += 1000
    assert _add(client, "charlie").status_code == 201
    reviewed = _answer(client, "charlie", "easy")  # Easy 直接毕业到 review
    assert reviewed.status_code == 200
    assert reviewed.json()["word"]["state"] == "review"
    words["review"] = "charlie"

    clock["now"] += 1000
    assert _add(client, "delta").status_code == 201
    assert _answer(client, "delta", "easy").json()["word"]["state"] == "review"
    relearning = _answer(client, "delta", "again")  # review 时 Again → relearning
    assert relearning.status_code == 200
    assert relearning.json()["word"]["state"] == "relearning"
    words["relearning"] = "delta"

    clock["now"] += 1000
    assert _add(client, "echo").status_code == 201
    suspended = client.post("/api/review/suspend", json={"lemma": "echo"})
    assert suspended.status_code == 200
    assert suspended.json()["word"]["state"] == "suspended"
    words["suspended"] = "echo"
    clock["now"] += 1000
    return words


def test_list_words_state_filter(review_db, clock):
    """``?state=`` 合法单值/多值过滤；省略不过滤；形状/total 口径与现有一致。"""
    client = review_db
    seeded = _seed_all_states(client, clock)
    word_keys = {"mastered", "state", "dueAt", "sources"}

    everything = client.get("/api/review/words")
    assert everything.status_code == 200
    body = everything.json()
    assert set(body) == {"targetLang", "now", "total", "words"}  # 返回形状不变
    assert body["total"] == 5
    assert {word["lemma"] for word in body["words"]} == set(seeded.values())
    assert word_keys <= set(body["words"][0])

    def listed(state):
        response = client.get("/api/review/words", params={"state": state})
        assert response.status_code == 200, (state, response.text)
        return response.json()

    # 单值过滤。
    single = listed("new")
    assert single["total"] == 1
    assert [word["lemma"] for word in single["words"]] == ["alpha"]
    assert single["words"][0]["state"] == "new"
    suspended = listed("suspended")
    assert suspended["total"] == 1
    assert [word["lemma"] for word in suspended["words"]] == [seeded["suspended"]]

    # 多值过滤（子集），排序口径不变：最近更新在前。
    multi = listed("learning,review")
    assert multi["total"] == 2
    assert [word["lemma"] for word in multi["words"]] == ["charlie", "bravo"]
    assert all(word["state"] in ("learning", "review") for word in multi["words"])
    every_state = listed(",".join(srs.VALID_STATES))
    assert every_state["total"] == 5 and len(every_state["words"]) == 5

    # 大小写 / 首尾空白 / 重复项 / 尾逗号都是同一语义。
    tolerant = listed(" NEW , review, new ,")
    assert tolerant["total"] == 2
    assert {word["lemma"] for word in tolerant["words"]} == {"alpha", "charlie"}

    # limit 只截断列表，total 仍是过滤后总数（与 mastered 现有口径一致）。
    limited = client.get(
        "/api/review/words", params={"state": "new,learning,review", "limit": 2}
    ).json()
    assert limited["total"] == 3
    assert len(limited["words"]) == 2
    truncated = client.get(
        "/api/review/words", params={"state": "learning,review", "limit": 1}
    ).json()
    assert truncated["total"] == 2
    assert [word["lemma"] for word in truncated["words"]] == ["charlie"]


def test_list_words_state_validation(review_db):
    """state 非法值 / 空值 → 400；与 mastered、limit 的校验互不吞掉。"""
    client = review_db
    for bad in ("mastered", "due", "new,bogus"):
        response = client.get("/api/review/words", params={"state": bad})
        assert response.status_code == 400, (bad, response.text)
        detail = response.json()["detail"]
        assert "new" in detail and "suspended" in detail, detail
    # 显式给了 state 却没有任何有效值：400（省略该参数才表示不过滤）。
    for empty in ("", " , "):
        response = client.get("/api/review/words", params={"state": empty})
        assert response.status_code == 400, (empty, response.text)
        assert "不能为空" in response.json()["detail"]
    # 合法 state + 非法 mastered：仍然 400（两个校验都在）。
    assert (
        client.get(
            "/api/review/words", params={"state": "new", "mastered": "2"}
        ).status_code
        == 400
    )
    assert (
        client.get("/api/review/words", params={"state": "new", "limit": 0}).status_code
        == 422
    )


def test_list_words_state_combines_with_mastered_and_lang(review_db, clock):
    """state 与 mastered / targetLang 组合生效（AND），total 是交集口径。"""
    client = review_db
    clock["now"] = NOW
    # alpha：review 状态 + 已掌握。
    assert _add(client, "alpha").status_code == 201
    assert _answer(client, "alpha", "easy").json()["word"]["state"] == "review"
    assert _master(client, "alpha", True).status_code == 200
    clock["now"] += 1000
    # beta：new 状态，未掌握。
    assert _add(client, "beta").status_code == 201
    clock["now"] += 1000
    # gamma：review 状态，未掌握，vi-VN。
    assert _add(client, "gamma", target="vi-VN").status_code == 201
    assert _answer(
        client, "gamma", "easy", target="vi-VN"
    ).json()["word"]["state"] == "review"

    mastered_review = client.get(
        "/api/review/words", params={"state": "review", "mastered": "1"}
    ).json()
    assert mastered_review["total"] == 1
    assert [word["lemma"] for word in mastered_review["words"]] == ["alpha"]
    assert mastered_review["words"][0]["mastered"] is True

    unmastered_review = client.get(
        "/api/review/words", params={"state": "review", "mastered": "0"}
    ).json()
    assert unmastered_review["total"] == 1
    assert [word["lemma"] for word in unmastered_review["words"]] == ["gamma"]

    # 再叠 targetLang：state 过滤后语言的交集。
    zh_review = client.get(
        "/api/review/words",
        params={"state": "review", "mastered": "0", "targetLang": "zh-CN"},
    ).json()
    assert zh_review["total"] == 0 and zh_review["words"] == []
    vi_review = client.get(
        "/api/review/words",
        params={"state": "review", "mastered": "0", "targetLang": "vi-VN"},
    ).json()
    assert vi_review["total"] == 1
    assert [word["lemma"] for word in vi_review["words"]] == ["gamma"]

    # 组合过滤下 total 也不受 limit 影响。
    limited = client.get(
        "/api/review/words", params={"state": "review", "limit": 1}
    ).json()
    assert limited["total"] == 2 and len(limited["words"]) == 1


def test_list_words_state_filter_guest_403(make_client, review_db):
    """游客/未登录：合法或非法 state 都先被鉴权挡下 → 403（不泄露校验细节）。"""
    with make_client() as guest:
        assert guest.get("/api/review/words", params={"state": "new"}).status_code == 403
        assert (
            guest.get("/api/review/words", params={"state": "bogus"}).status_code == 403
        )


def test_normalize_states_is_order_stable_and_validates():
    """srs.normalize_states：None=不过滤；去重/小写/排序稳定；非法值 ValueError。"""
    assert srs.normalize_states(None) is None
    assert srs.normalize_states("review,new,review") == ("new", "review")
    assert srs.normalize_states([" NEW ", "relearning"]) == ("new", "relearning")
    assert srs.normalize_states(("suspended",)) == ("suspended",)
    with pytest.raises(ValueError):
        srs.normalize_states("mastered")
    with pytest.raises(ValueError):
        srs.normalize_states("")
    with pytest.raises(ValueError):
        srs.normalize_states([])


def test_public_word_exposes_mastered_flag():
    base = {
        "id": "w1",
        "lemma": "hello",
        "target_lang": "zh-CN",
        "state": "new",
        "due_at": NOW,
        "reps": 0,
    }
    assert srs.to_public_word({**base, "mastered": 1})["mastered"] is True
    assert srs.to_public_word({**base, "mastered": 0})["mastered"] is False
    # 库停在 0026（内部字典没有该键）也必须是 False，而不是 None/KeyError。
    assert srs.to_public_word(base)["mastered"] is False


def test_mastered_words_do_not_extend_streak(review_db, clock):
    client = review_db
    clock["now"] = NOW
    assert _add(client, "streaky").status_code == 201
    assert _answer(client, "streaky", "good").status_code == 200
    assert _stats(client).json()["streakDays"] == 1

    assert _master(client, "streaky", True).status_code == 200
    stats = _stats(client).json()
    assert stats["streakDays"] == 0  # 已掌握的词不参与连续天数
    assert stats["reviewedToday"] == 1  # 历史日志仍在（只是不计入 streak）
    assert stats["masteredWords"] == 1


def test_review_reads_work_before_0027_migration(client, clock):
    """库停在 0026：读写照常（mastered 读作 False），只有写标记 503 提示升级。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "0026_seed_band_fix"),
        "upgrade 0026",
    )
    clock["now"] = NOW
    assert _add(client, "olddb").status_code == 201
    body = _queue(client).json()
    assert [item["lemma"] for item in body["items"]] == ["olddb"]
    assert body["items"][0]["mastered"] is False
    assert _stats(client).json()["masteredWords"] == 0
    blocked = _master(client, "olddb", True)
    assert blocked.status_code == 503
    assert "0027_review_mastered" in blocked.json()["detail"]

    # 补迁移后标记可用（读侧不需要重连/重启）。
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head"
    )
    assert _master(client, "olddb", True).status_code == 200


def test_definition_snapshot_written_once_and_returned_everywhere(review_db, clock):
    """释义快照（specs/013 / 0029）：首写生效，二次不覆盖；队列/列表都带该字段。"""
    client = review_db
    clock["now"] = NOW

    created = _add(client, "café", definition="咖啡馆")
    assert created.status_code == 201
    word = created.json()["word"]
    assert word["definition"] == "咖啡馆"
    assert _db_rows(
        "SELECT definition FROM word_states WHERE lemma = 'café'"
    )[0]["definition"] == "咖啡馆"

    # 同词（大小写不同）再次导入不同释义：不覆盖已有快照，也不重置进度。
    again = _add(client, "Café", definition="咖啡店")
    assert again.status_code == 200
    assert again.json()["created"] is False
    assert again.json()["word"]["definition"] == "咖啡馆"
    assert _db_rows(
        "SELECT definition FROM word_states WHERE lemma = 'café'"
    )[0]["definition"] == "咖啡馆"

    queue = _queue(client).json()
    assert [item["lemma"] for item in queue["items"]] == ["café"]
    assert queue["items"][0]["definition"] == "咖啡馆"
    listed = client.get("/api/review/words").json()
    assert listed["words"][0]["definition"] == "咖啡馆"


def test_definition_is_null_when_not_provided(review_db, clock):
    """没有用户释义时公开 word 仍带 definition 字段，值为 null（旧行为）。"""
    client = review_db
    clock["now"] = NOW
    word = _add(client, "plain").json()["word"]
    assert "definition" in word and word["definition"] is None
    assert _queue(client).json()["items"][0]["definition"] is None
    assert client.get("/api/review/words").json()["words"][0]["definition"] is None


def test_definition_requires_0029_migration(client, clock):
    """库停在 0028：无 definition 的加词/队列照常；带 definition 的写路径 503。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "0028_user_wordlists"),
        "upgrade 0028",
    )
    clock["now"] = NOW
    assert _add(client, "olddb").status_code == 201
    assert _add(client, "olddb").json()["word"]["definition"] is None
    assert _queue(client).json()["items"][0]["definition"] is None

    blocked = _add(client, "olddb", definition="旧库释义")
    assert blocked.status_code == 503
    assert "0029_word_state_definition" in blocked.json()["detail"]
    # 事务已回滚：没有半写入（旧库没有该列，词状态仍只有先前那一行）。
    assert _db_rows("SELECT COUNT(*) AS n FROM word_states")[0]["n"] == 1

    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head"
    )
    filled = _add(client, "olddb", definition="旧库释义")
    assert filled.status_code == 200
    assert filled.json()["word"]["definition"] == "旧库释义"

    # definition 形状非法 → 400（不是 500）。
    invalid = _add(client, "another", definition=123)
    assert invalid.status_code == 400


# ---------------------------------------------------------------------------
# 8b. 标记已掌握时的释义快照（P0-13 / 0029）
# ---------------------------------------------------------------------------

def test_patch_mastered_snapshots_definition_only_when_empty(review_db, clock):
    """PATCH 可选 definition：仅填空、不覆盖；撤销不写；响应/列表都返回快照。"""
    client = review_db
    clock["now"] = NOW

    # 词不存在：PATCH mastered=true 建行，同时写入释义快照。
    created = _master(
        client, "Affordability", True, definition="支付能力；负担能力；可购性"
    )
    assert created.status_code == 200, created.text
    word = created.json()["word"]
    assert word["mastered"] is True
    assert word["definition"] == "支付能力；负担能力；可购性"
    assert _db_rows(
        "SELECT definition FROM word_states WHERE lemma = 'affordability'"
    )[0]["definition"] == "支付能力；负担能力；可购性"

    # 已掌握行再次标记（带不同释义）：不覆盖已有快照。
    again = _master(client, "affordability", True, definition="另一个释义")
    assert again.status_code == 200, again.text
    assert again.json()["word"]["definition"] == "支付能力；负担能力；可购性"
    assert _db_rows(
        "SELECT definition FROM word_states WHERE lemma = 'affordability'"
    )[0]["definition"] == "支付能力；负担能力；可购性"

    # 撤销已掌握（即使带释义）不写快照。
    undone = _master(client, "affordability", False, definition="撤销时的释义")
    assert undone.status_code == 200, undone.text
    assert undone.json()["word"]["definition"] == "支付能力；负担能力；可购性"
    assert _db_rows(
        "SELECT definition FROM word_states WHERE lemma = 'affordability'"
    )[0]["definition"] == "支付能力；负担能力；可购性"

    # 已掌握列表按同一份快照返回，页面释义列不丢。
    listed = client.get("/api/review/words", params={"mastered": "1"}).json()
    assert listed["total"] == 0  # 刚撤销，已掌握列表为空
    remastered = _master(client, "affordability", True)
    assert remastered.json()["word"]["definition"] == "支付能力；负担能力；可购性"
    listed = client.get("/api/review/words", params={"mastered": "1"}).json()
    assert listed["words"][0]["definition"] == "支付能力；负担能力；可购性"

    # 没有释义的标记保持 null，不伪造空串。
    plain = _master(client, "plain", True)
    assert plain.json()["word"]["definition"] is None
    assert _db_rows(
        "SELECT definition FROM word_states WHERE lemma = 'plain'"
    )[0]["definition"] is None


def test_patch_mastered_definition_validation(review_db):
    """definition 形状非法 → 400（与 POST 口径一致）；空白视为未提供。"""
    client = review_db
    invalid = _master(client, "bad", True, definition=123)
    assert invalid.status_code == 400
    assert _db_rows("SELECT COUNT(*) AS n FROM word_states")[0]["n"] == 0

    blank = _master(client, "blank", True, definition="   ")
    assert blank.status_code == 200, blank.text
    assert blank.json()["word"]["definition"] is None


def test_patch_mastered_definition_requires_0029_migration(client, clock):
    """库停在 0028：不带释义的标记照常；带释义 503 且不产生半写入。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "0028_user_wordlists"),
        "upgrade 0028",
    )
    clock["now"] = NOW
    assert _master(client, "olddb", True).status_code == 200
    assert _master(client, "olddb", True).json()["word"]["definition"] is None

    blocked = _master(client, "olddb", True, definition="旧库释义")
    assert blocked.status_code == 503
    assert "0029_word_state_definition" in blocked.json()["detail"]
    # definition 列不存在，没有半写入；标记本身也不被这次失败请求改写。
    assert _db_rows(
        "SELECT mastered FROM word_states WHERE lemma = 'olddb'"
    )[0]["mastered"] == 1

    # 新词 + definition 在旧库同样拒绝，且不新建行。
    blocked_new = _master(client, "brand-new", True, definition="旧库释义")
    assert blocked_new.status_code == 503
    assert _db_rows("SELECT COUNT(*) AS n FROM word_states")[0]["n"] == 1

    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head"
    )
    filled = _master(client, "olddb", True, definition="旧库释义")
    assert filled.status_code == 200, filled.text
    assert filled.json()["word"]["definition"] == "旧库释义"
