"""CEFR M2 #7 行为埋点的离线验收（lookup / replay / rate / visibility）。

覆盖：

1. 四类事件合法 payload → 写 ``learning_events``，payload 只保留白名单字段
   （不落 context/句子/自由文本）；
2. 非法 payload / 未知 type / 批量超 20 / 正常前进的 replay → 整批 400，
   不写半批；
3. ``eventId`` 幂等（同 eventId 只落一行）与 ``dict_lookup`` 60 秒去重；
4. 游客身份 ``guest:<sha256>`` 可用；事件表未迁移 → 503；
5. 混合 batch（watch + behavior）分别写入两张表；
6. 限速：``/api/events`` 桶按用户/游客计数；
7. 管理员只读 ``GET /api/admin/events?type=`` 脱敏、403/401。

所有用例离线：数据库在 conftest 的 tmp_path 下通过真实 Alembic CLI 迁移，
时钟 monkeypatch ``reports.now_ms``，不联网、不碰 data/app.db。
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

import behavior_events
import config
import events
from tests.conftest import TEST_USER_EMAIL
from tests.migration_utils import assert_alembic_ok, run_alembic

NOW = 1_763_000_000_000


def _upgrade() -> str:
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"),
        "upgrade head (behavior events)",
    )
    return config.AUTH_DB_PATH


@pytest.fixture()
def migrated(client):
    _upgrade()
    return client


@pytest.fixture()
def clock(monkeypatch):
    """可推进的注入时钟：改 clock['now']，下一次请求就用新时间。"""
    state = {"now": NOW}
    monkeypatch.setattr("reports.now_ms", lambda: state["now"])
    return state


def _post(client, batch):
    return client.post("/api/events", json={"events": batch})


def _dict_event(event_id: str, word: str = "learning", **extra) -> dict:
    event = {
        "type": "dict_lookup",
        "eventId": event_id,
        "occurredAt": NOW - 1_000,
        "sessionId": "sess-abc-123",
        "contentRef": "dQw4w9WgXcQ",
        "word": word,
        "source": "transcript",
    }
    event.update(extra)
    return event


def _replay_event(event_id: str = "rep-1") -> dict:
    return {
        "type": "video_replay",
        "eventId": event_id,
        "occurredAt": NOW - 1_000,
        "sessionId": "sess-abc-123",
        "contentRef": "dQw4w9WgXcQ",
        "fromSeconds": 42.5,
        "toSeconds": 18.25,
        "method": "click",
    }


def _rate_event(event_id: str = "rate-1") -> dict:
    return {
        "type": "playback_rate",
        "eventId": event_id,
        "occurredAt": NOW - 1_000,
        "contentRef": "dQw4w9WgXcQ",
        "fromRate": 1.0,
        "toRate": 1.5,
    }


def _visibility_event(event_id: str = "vis-1") -> dict:
    return {
        "type": "tab_visibility",
        "eventId": event_id,
        "occurredAt": NOW - 1_000,
        "sessionId": "sess-abc-123",
        "state": "hidden",
        "visibleSeconds": 12.5,
    }


def _rows(db_path: str) -> list[dict]:
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        return [
            dict(row)
            for row in conn.execute(
                "SELECT user_id, session_id, event_type, content_ref, payload, "
                "occurred_at, pseudonym_id, client_event_id FROM learning_events "
                "ORDER BY id"
            )
        ]


# ---------------------------------------------------------------------------
# 合法 payload / 白名单
# ---------------------------------------------------------------------------

def test_four_event_types_are_stored_with_whitelisted_payload(migrated, clock):
    db = _upgrade()
    batch = [
        _dict_event(
            "dict-1",
            word="Learning",
            lemma="learn",
            # 这些字段绝不能被落库：context 是用户看到的原文/自由文本。
            context="A very long sentence the user was reading.",
            title="Private article title",
        ),
        _replay_event(),
        _rate_event(),
        _visibility_event(),
    ]
    response = _post(migrated, batch)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "received": 4,
        "accepted": 4,
        "duplicated": 0,
        "deduplicated": 0,
    }

    rows = _rows(db)
    assert [row["event_type"] for row in rows] == [
        "dict_lookup",
        "video_replay",
        "playback_rate",
        "tab_visibility",
    ]
    identity = rows[0]["user_id"]
    assert identity.startswith("guest:") is False  # 登录用户 → users.id
    assert rows[0]["pseudonym_id"] == events.pseudonym_for(identity)
    assert rows[0]["pseudonym_id"] != identity

    payloads = [json.loads(row["payload"]) for row in rows]
    assert payloads[0] == {
        "word": "learning",
        "lemma": "learn",
        "source": "transcript",
    }
    assert payloads[1] == {
        "fromSeconds": 42.5,
        "toSeconds": 18.25,
        "method": "click",
    }
    assert payloads[2] == {"fromRate": 1.0, "toRate": 1.5}
    assert payloads[3] == {"state": "hidden", "visibleSeconds": 12.5}

    # sessionId 进列；contentRef 进列；不出现 context/自由文本。
    assert rows[0]["session_id"] == "sess-abc-123"
    assert rows[0]["content_ref"] == "dQw4w9WgXcQ"
    assert all("context" not in json.loads(row["payload"]) for row in rows)
    raw = json.dumps([row["payload"] for row in rows], ensure_ascii=False)
    assert "very long sentence" not in raw
    assert "Private article title" not in raw


def test_guest_identity_is_anonymous_and_works(make_client):
    _upgrade()
    with make_client() as guest_client:
        response = _post(guest_client, [_dict_event("guest-dict-1")])
        assert response.status_code == 200, response.text
        assert response.json()["accepted"] == 1
    rows = _rows(config.AUTH_DB_PATH)
    assert rows[0]["user_id"].startswith("guest:")
    assert rows[0]["pseudonym_id"] and len(rows[0]["pseudonym_id"]) == 64


# ---------------------------------------------------------------------------
# 非法 payload：整批 400，不写半批
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "bad_event,message",
    [
        ({"type": "unknown", "eventId": "x-1"}, "type 只支持"),
        ({**_dict_event("x-2"), "eventId": "bad id"}, "eventId 含非法字符"),
        ({**_dict_event("x-3"), "eventId": None}, "eventId 必须是字符串"),
        ({**_dict_event("x-4"), "word": ""}, "word 不能为空"),
        ({**_dict_event("x-5"), "word": "word " * 20}, "word 太长"),
        ({**_dict_event("x-6"), "word": "bad\nword"}, "控制字符"),
        ({**_replay_event("x-7"), "toSeconds": 50}, "只接受回退"),
        ({**_replay_event("x-8"), "fromSeconds": -1}, "fromSeconds 必须在"),
        ({**_replay_event("x-9"), "method": "auto"}, "method 只能是"),
        ({**_rate_event("x-10"), "toRate": 1.0}, "倍速没有变化"),
        ({**_rate_event("x-11"), "toRate": 9}, "toRate 必须在"),
        ({**_visibility_event("x-12"), "state": "blur"}, "state 只能是"),
        ({**_visibility_event("x-13"), "sessionId": None}, "缺少 sessionId"),
        ({**_dict_event("x-14"), "occurredAt": NOW + 10 * 60 * 1000}, "晚超过 5 分钟"),
        ({**_dict_event("x-15"), "source": "user_input"}, "source 只能是"),
        ("not-an-object", "必须是对象"),
    ],
)
def test_invalid_event_rejects_whole_batch(migrated, clock, bad_event, message):
    db = _upgrade()
    response = _post(migrated, [bad_event])
    if not isinstance(bad_event, dict):
        # Pydantic 在路由之前拒绝非对象（与 watch 端点同语义：422）。
        assert response.status_code == 422, response.text
    else:
        assert response.status_code == 400, response.text
        assert message in response.json()["detail"]
    assert _rows(db) == []


def test_batch_over_20_behavior_events_is_rejected(migrated, clock):
    db = _upgrade()
    batch = [
        _dict_event(f"bulk-{index}", word=f"word{index}") for index in range(21)
    ]
    response = _post(migrated, batch)
    assert response.status_code == 400
    assert "最多上报 20 条行为事件" in response.json()["detail"]
    assert _rows(db) == []


def test_behavior_and_watch_share_batch_after_full_validation(migrated, clock):
    db = _upgrade()
    watch = {
        "type": "watch",
        "contentRef": "dQw4w9WgXcQ",
        "kind": "video",
        "targetLang": "zh-CN",
        "watchedSeconds": 60,
        "positionSeconds": 30,
        "occurredAt": NOW - 1_000,
        "clientEventId": "watch-1",
    }
    response = _post(migrated, [watch, _dict_event("dict-mixed")])
    assert response.status_code == 200, response.text
    assert response.json()["accepted"] == 2
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT COUNT(*) FROM watch_events").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM learning_events").fetchone()[0] == 1


# ---------------------------------------------------------------------------
# 幂等 / 去重
# ---------------------------------------------------------------------------

def test_event_id_is_idempotent(migrated, clock):
    db = _upgrade()
    first = _post(migrated, [_dict_event("same-id", word="hello")])
    assert first.status_code == 200
    assert first.json()["accepted"] == 1

    second = _post(migrated, [_dict_event("same-id", word="hello")])
    assert second.status_code == 200, second.text
    assert second.json() == {
        "received": 1,
        "accepted": 0,
        "duplicated": 1,
        "deduplicated": 0,
    }
    assert len(_rows(db)) == 1


def test_dict_lookup_dedupes_same_word_within_60_seconds(migrated, clock):
    db = _upgrade()
    first = _post(migrated, [_dict_event("look-1", word="Hello")])
    assert first.json()["accepted"] == 1

    clock["now"] += 10_000
    second = _post(
        migrated,
        [_dict_event("look-2", word="  hello  ", occurredAt=clock["now"] - 500)],
    )
    assert second.status_code == 200, second.text
    assert second.json() == {
        "received": 1,
        "accepted": 0,
        "duplicated": 0,
        "deduplicated": 1,
    }

    # 另一个词不受影响
    third = _post(
        migrated,
        [_dict_event("look-3", word="world", occurredAt=clock["now"] - 500)],
    )
    assert third.json()["accepted"] == 1

    # 超过 60 秒后同一个词重新落库
    clock["now"] += 61_000
    fourth = _post(
        migrated,
        [_dict_event("look-4", word="hello", occurredAt=clock["now"] - 500)],
    )
    assert fourth.json()["accepted"] == 1
    assert len(_rows(db)) == 3


def test_same_event_id_different_type_is_distinct(migrated, clock):
    _upgrade()
    response = _post(
        migrated,
        [
            _dict_event("shared-id"),
            _rate_event("shared-id"),
        ],
    )
    assert response.status_code == 200, response.text
    assert response.json()["accepted"] == 2


# ---------------------------------------------------------------------------
# 迁移 / 限速
# ---------------------------------------------------------------------------

def test_unmigrated_table_returns_503(client, monkeypatch):
    response = _post(client, [_dict_event("unmigrated-1")])
    assert response.status_code == 503
    assert "0017_behavior_events" in response.json()["detail"]


def test_events_endpoint_is_rate_limited(migrated, clock, monkeypatch):
    monkeypatch.setattr(config, "RATE_LIMIT_EVENTS_PER_MINUTE", 2, raising=False)
    for index in range(2):
        response = _post(
            migrated, [_dict_event(f"rate-limit-{index}", word=f"w{index}")]
        )
        assert response.status_code == 200, response.text
    limited = _post(migrated, [_dict_event("rate-limit-2", word="w2")])
    assert limited.status_code == 429
    assert int(limited.headers["Retry-After"]) >= 1


# ---------------------------------------------------------------------------
# 管理员只读查询
# ---------------------------------------------------------------------------

def test_admin_can_read_recent_events_without_identity(
    migrated, clock, monkeypatch
):
    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({TEST_USER_EMAIL}), raising=False
    )
    assert _post(migrated, [_dict_event("admin-1")]).status_code == 200

    response = migrated.get("/api/admin/events?type=dict_lookup&limit=10")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["count"] == 1
    item = body["events"][0]
    assert item["type"] == "dict_lookup"
    assert item["payload"]["word"] == "learning"
    assert item["sessionId"] == "sess-abc-123"
    # 脱敏：不返回明文归属/设备标识
    assert "user_id" not in item
    assert "device_id" not in item
    assert "userId" not in item
    assert item["pseudonymId"]

    bad_type = migrated.get("/api/admin/events?type=not_a_type")
    assert bad_type.status_code == 400


def test_admin_events_requires_admin(migrated, make_client):
    _upgrade()
    with make_client() as normal_client:
        signup = normal_client.post(
            "/api/auth/signup",
            json={"email": "not-admin@example.com", "password": "not-admin-pass-123"},
        )
        assert signup.status_code == 201, signup.text
        assert normal_client.get("/api/admin/events").status_code == 403
    with make_client() as anonymous:
        assert anonymous.get("/api/admin/events").status_code == 401


# ---------------------------------------------------------------------------
# 纯函数边界（不需要 HTTP）
# ---------------------------------------------------------------------------

def test_normalize_rejects_non_finite_numbers():
    with pytest.raises(behavior_events.InvalidBehaviorEvents):
        behavior_events.normalize_behavior_events(
            [
                {
                    "type": "playback_rate",
                    "eventId": "nan-1",
                    "contentRef": "vid",
                    "fromRate": float("nan"),
                    "toRate": 1.5,
                }
            ],
            now=NOW,
        )


def test_raw_event_size_limit():
    with pytest.raises(behavior_events.InvalidBehaviorEvents, match="事件体太大"):
        behavior_events.normalize_behavior_events(
            [
                {
                    "type": "dict_lookup",
                    "eventId": "big-1",
                    "word": "hello",
                    "padding": "x" * 5000,
                }
            ],
            now=NOW,
        )
