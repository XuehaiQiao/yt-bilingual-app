"""单词本「见过次数」端点的离线验收（specs/005 v1.1）。

覆盖 ``GET /api/vocabulary/seen?words=a,b,c``：

1. 聚合 ``learning_events(event_type='dict_lookup')``，按小写词形归并计数；
2. 键保留传入词形；没查过的词返回 0 而不是缺省；
3. 只统计当前账号（跨用户隔离）、只统计 dict_lookup（其它事件不混入）；
4. 空/超量 422、游客 403、事件表未迁移 503；
5. 脏 payload（NULL word / 非 JSON）不会让整个请求 500。

数据库用真实 Alembic CLI 迁到 head（tmp_path），时间由用例显式写入，不联网。
"""
from __future__ import annotations

import sqlite3

import pytest

import config
import events
from tests.conftest import TEST_USER_EMAIL
from tests.migration_utils import assert_alembic_ok, run_alembic

NOW = 1_763_000_000_000


@pytest.fixture()
def seen_db(client):
    """迁到 head（learning_events 就绪），返回已登录客户端。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (seen)"
    )
    return client


def _emit(word: str, user_id: str, *, event_type: str = "dict_lookup", at: int = NOW):
    """写一条事件（payload 形状与 behavior_events 的 dict_lookup 一致）。"""
    return events.emit_event(
        event_type,
        user_id=user_id,
        payload={"word": word, "source": "transcript"},
        occurred_at=at,
    )


def _seen(client, words: str):
    return client.get("/api/vocabulary/seen", params={"words": words})


def test_seen_counts_dict_lookups_case_insensitively(seen_db):
    client = seen_db
    for _ in range(3):
        _emit("hello", client.user_id)
    _emit("trip", client.user_id)
    # 别的账号 / 别的类型都不该混进当前账号的 seen 计数。
    _emit("hello", "some-other-user")
    _emit("hello", client.user_id, event_type="word_review")

    response = _seen(client, "hello, trip, missing")
    assert response.status_code == 200, response.text
    assert response.json() == {"hello": 3, "trip": 1, "missing": 0}

    # 计数按小写词形归并：大小写不同的查询命中同一个桶；键保留传入词形。
    upper = _seen(client, "Hello")
    assert upper.status_code == 200
    assert upper.json() == {"Hello": 3}

    # 重复传参（与 /api/vocabulary/level 同口径）也能用。
    repeated = client.get(
        "/api/vocabulary/seen", params=[("words", "hello"), ("words", "nope")]
    )
    assert repeated.status_code == 200
    assert repeated.json() == {"hello": 3, "nope": 0}


def test_seen_is_isolated_per_user_and_covers_all_rows(seen_db):
    """同一词查过多次（不同时间）都计；别的用户的同名词 0 条。"""
    client = seen_db
    _emit("alpha", client.user_id, at=NOW - 90_000)
    _emit("alpha", client.user_id, at=NOW - 30_000)
    _emit("alpha", "another-user", at=NOW)

    body = _seen(client, "alpha").json()
    assert body == {"alpha": 2}


def test_seen_empty_and_over_limit_are_422(seen_db):
    client = seen_db
    assert client.get("/api/vocabulary/seen").status_code == 422
    assert _seen(client, "").status_code == 422
    assert _seen(client, " , ").status_code == 422

    too_many = ",".join(f"w{i}" for i in range(101))
    over = _seen(client, too_many)
    assert over.status_code == 422
    assert "100" in over.json()["detail"]

    # 恰好 100 个词可以（未知词全是 0），不会因为数量边界把合法请求挡掉。
    hundred = ",".join(f"w{i}" for i in range(100))
    ok = _seen(client, hundred)
    assert ok.status_code == 200, ok.text
    payload = ok.json()
    assert len(payload) == 100
    assert all(count == 0 for count in payload.values())


def test_seen_guest_is_forbidden(make_client):
    with make_client() as guest:
        response = guest.get("/api/vocabulary/seen", params={"words": "hello"})
    assert response.status_code == 403


def test_seen_503_before_migration(client):
    response = _seen(client, "hello")
    assert response.status_code == 503
    assert "alembic upgrade head" in response.json()["detail"]


def test_seen_ignores_dirty_payloads(seen_db):
    """NULL word / 非 JSON payload 不参与计数，也不让整个请求失败。"""
    client = seen_db
    _emit("good", client.user_id)
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        conn.execute(
            "INSERT INTO learning_events "
            "(user_id, event_type, payload, occurred_at, created_at) "
            "VALUES (?, 'dict_lookup', NULL, ?, ?)",
            (client.user_id, NOW, NOW),
        )
        conn.execute(
            "INSERT INTO learning_events "
            "(user_id, event_type, payload, occurred_at, created_at) "
            "VALUES (?, 'dict_lookup', 'not-json', ?, ?)",
            (client.user_id, NOW, NOW),
        )
        conn.execute(
            "INSERT INTO learning_events "
            "(user_id, event_type, payload, occurred_at, created_at) "
            "VALUES (?, 'dict_lookup', '{\"word\": null}', ?, ?)",
            (client.user_id, NOW, NOW),
        )

    response = _seen(client, "good")
    assert response.status_code == 200, response.text
    assert response.json() == {"good": 1}


def test_seen_user_lookup_matches_login_user(seen_db):
    """登录用户 id 与事件归属一致（防止 user_id 口径写错）。"""
    client = seen_db
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        row = conn.execute(
            "SELECT id FROM users WHERE email = ?", (TEST_USER_EMAIL,)
        ).fetchone()
    assert row is not None and row[0] == client.user_id
