"""能力档案 API 的离线验收（计划书 §7.4 / §7.6，specs/025）。

覆盖 profile / self-assess / can-do 三个端点：空画像、有定位证据、陈旧、
未迁移 503、自评校验/幂等/日限、公开 can-do、旧 profile shim、游客隔离。
数据库在 conftest 的 tmp_path 下用真实 Alembic CLI 迁移，不联网。
"""
from __future__ import annotations

import json
import time

import pytest

import ability
import assessment
import config
from tests.migration_utils import assert_alembic_ok, run_alembic

PASSWORD = "ability-password-123"


def _upgrade() -> None:
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (ability)"
    )


@pytest.fixture()
def ability_db(client):
    _upgrade()
    return client


@pytest.fixture()
def guest_client(ability_db, make_client):
    with make_client() as test_client:
        me = test_client.get("/api/auth/me")
        assert me.status_code == 200
        assert me.json()["guest"] is True
        yield test_client


def _self_items() -> list[str]:
    return [item["id"] for item in json.load(open(
        config.ABILITY_DIR + "/self_assess.json", encoding="utf-8"
    ))["items"]]


def _answers(count: int = 20, rating: int = 3) -> list[dict]:
    return [{"itemId": item_id, "rating": rating} for item_id in _self_items()[:count]]


def _submit_body(
    *, client_request_id: str = "req-1", count: int = 20, rating: int = 3, duration: int = 120_000
) -> dict:
    return {
        "clientRequestId": client_request_id,
        "answers": _answers(count, rating),
        "durationMs": duration,
    }


def _take_placement(client) -> dict:
    start = client.get("/api/placement/start")
    assert start.status_code == 200, start.text
    payload = start.json()
    answers = [
        {"itemId": item["itemId"], "chosenIndex": 0, "elapsedMs": 9_000}
        for item in payload["items"]
    ]
    submitted = client.post(
        "/api/placement/submit",
        json={
            "sessionId": payload["sessionId"],
            "answers": answers,
            "durationMs": 600_000,
        },
    )
    assert submitted.status_code == 200, submitted.text
    return submitted.json()


# ---------------------------------------------------------------------------
# profile
# ---------------------------------------------------------------------------

def test_profile_empty_guest_is_not_measured(guest_client):
    response = guest_client.get("/api/ability/profile")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, max-age=60"
    body = response.json()
    assert body["schemaVersion"] == "ability.v1"
    assert body["primary"] == "vocabulary"
    assert body["calibrationVersion"] == "rasch.eap.v1"
    assert body["vocabulary"]["status"] == "not_measured"
    assert body["vocabulary"]["cefr"] is None
    assert body["composite"]["cefr"] is None
    assert body["skills"]["reading"]["status"] == "insufficient"
    assert body["skills"]["writing"]["status"] == "self_report"
    assert body["skills"]["writing"]["cefr"] is None
    assert body["grammar"]["status"] == "not_measured"
    assert body["inputOutputGap"]["available"] is False
    assert body["conflicts"] == []
    assert body["preliminary"] is True
    assert body["sampleSize"] == 0
    assert "不是官方 CEFR 认证" in body["disclaimer"]
    assert "overall" not in body
    # M1 不得出现 measured 状态（not_measured 是允许的合成状态）。
    assert '"status": "measured"' not in json.dumps(body, ensure_ascii=False)


def test_profile_after_placement_has_vocabulary_interval(ability_db):
    _take_placement(ability_db)
    response = ability_db.get("/api/ability/profile")
    assert response.status_code == 200, response.text
    body = response.json()
    vocab = body["vocabulary"]
    assert vocab["status"] == "uncalibrated"
    assert vocab["cefr"] in ("A1", "A2", "B1", "B2", "C1")
    assert vocab["low"] <= vocab["cefr"] <= vocab["high"]
    assert vocab["evidenceCount"] == 24
    assert vocab["precision"]["se"] is not None
    assert vocab["validity"]["label"] in ("high", "medium", "low")
    assert set(vocab["estimate"]) >= {"low", "high", "unit", "point"}
    assert vocab["estimate"]["unit"] == "lemma"
    assert vocab["note"]
    assert vocab["calibrationVersion"] == "rasch.eap.v1"
    assert body["composite"]["cefr"] is None
    assert body["composite"]["derivedFrom"] == ["vocabulary"]
    assert body["skills"]["reading"]["items"] == 5
    assert body["skills"]["reading"]["cefr"] is None
    assert "band" not in body["skills"]["reading"]
    assert body["skills"]["listening"]["status"] == "not_measured"
    assert body["skills"]["speaking"]["status"] == "not_measured"
    assert body["grammar"]["status"] == "not_measured"
    assert body["canDo"]["level"] == vocab["cefr"]
    assert body["canDo"]["bySkill"]["reading"]
    assert body["sampleSize"] == 1
    assert body["preliminary"] is True
    assert "overall" not in body


def test_profile_unmigrated_returns_503(client):
    response = client.get("/api/ability/profile")
    assert response.status_code == 503, response.text
    assert "0014_ability" in response.text


def test_profile_stale_flag_after_90_days(ability_db):
    _take_placement(ability_db)
    import sqlite3

    conn = sqlite3.connect(config.AUTH_DB_PATH)
    old = int(time.time() * 1000) - (ability.STALE_MS + 24 * 60 * 60 * 1000)
    conn.execute(
        "UPDATE user_skill_profiles SET last_evidence_at = ? WHERE user_id = ?",
        (old, ability_db.user_id),
    )
    conn.commit()
    conn.close()
    body = ability_db.get("/api/ability/profile").json()
    assert body["vocabulary"]["stale"] is True


# ---------------------------------------------------------------------------
# self-assess
# ---------------------------------------------------------------------------

def test_self_assess_creates_writing_self_report(ability_db):
    response = ability_db.post(
        "/api/ability/self-assess",
        json=_submit_body(client_request_id="self-1", rating=3),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "submitted"
    assert body["reused"] is False
    assert body["evidenceAdded"] == 4
    assert body["sessionId"]
    writing = body["profile"]["skills"]["writing"]
    assert writing["status"] == "self_report"
    assert writing["cefr"] is None
    assert writing["selfReport"]["band"] == "C1"
    assert writing["selfReport"]["items"] == 5
    # 自评不改词汇带。
    assert body["profile"]["vocabulary"]["status"] == "not_measured"
    assert body["profile"]["composite"]["cefr"] is None


def test_self_assess_is_idempotent(ability_db):
    first = ability_db.post(
        "/api/ability/self-assess", json=_submit_body(client_request_id="same")
    )
    assert first.status_code == 200, first.text
    second = ability_db.post(
        "/api/ability/self-assess", json=_submit_body(client_request_id="same")
    )
    assert second.status_code == 200, second.text
    assert second.json()["reused"] is True
    assert second.json()["evidenceAdded"] == 0
    assert second.json()["sessionId"] == first.json()["sessionId"]

    import sqlite3

    conn = sqlite3.connect(config.AUTH_DB_PATH)
    sessions = conn.execute(
        "SELECT COUNT(*) FROM assessment_sessions WHERE kind='self_assess'"
    ).fetchone()[0]
    evidence = conn.execute(
        "SELECT COUNT(*) FROM skill_evidence WHERE evidence_type='self_assess'"
    ).fetchone()[0]
    conn.close()
    assert sessions == 1
    assert evidence == 4


def test_self_assess_item_count_and_unknown_item_validation(ability_db):
    for count in (11, 21):
        response = ability_db.post(
            "/api/ability/self-assess",
            json=_submit_body(client_request_id=f"count-{count}", count=min(count, 20)),
        )
        if count == 11:
            assert response.status_code == 400, response.text
        else:
            # 21 条超过上限；即使只有 20 个已知 item，也应先被条数拦住。
            body = _submit_body(client_request_id="count-21")
            body["answers"].append({"itemId": "not-a-real-item", "rating": 2})
            assert ability_db.post("/api/ability/self-assess", json=body).status_code == 400
    unknown = _submit_body(client_request_id="unknown")
    unknown["answers"][0]["itemId"] = "nope"
    assert ability_db.post("/api/ability/self-assess", json=unknown).status_code == 400


def test_self_assess_rating_and_duration_validation(ability_db):
    bad_rating = _submit_body(client_request_id="rating")
    bad_rating["answers"][0]["rating"] = 4
    assert ability_db.post("/api/ability/self-assess", json=bad_rating).status_code == 400
    bad_rating["answers"][0]["rating"] = -2
    assert ability_db.post("/api/ability/self-assess", json=bad_rating).status_code == 400
    too_fast = _submit_body(client_request_id="fast", duration=29_999)
    assert ability_db.post("/api/ability/self-assess", json=too_fast).status_code == 400
    too_slow = _submit_body(client_request_id="slow", duration=1_800_001)
    assert ability_db.post("/api/ability/self-assess", json=too_slow).status_code == 400


def test_self_assess_duplicate_item_validation(ability_db):
    body = _submit_body(client_request_id="dup")
    body["answers"][1]["itemId"] = body["answers"][0]["itemId"]
    response = ability_db.post("/api/ability/self-assess", json=body)
    assert response.status_code == 400, response.text


def test_self_assess_daily_limit_returns_429(ability_db):
    for index in range(ability.SELF_ASSESS_DAILY_LIMIT):
        response = ability_db.post(
            "/api/ability/self-assess",
            json=_submit_body(client_request_id=f"daily-{index}", count=12),
        )
        assert response.status_code == 200, (index, response.text)
    blocked = ability_db.post(
        "/api/ability/self-assess",
        json=_submit_body(client_request_id="daily-over", count=12),
    )
    assert blocked.status_code == 429, blocked.text
    assert blocked.headers.get("retry-after")
    assert blocked.json()["retryAfter"] > 0


# ---------------------------------------------------------------------------
# can-do
# ---------------------------------------------------------------------------

def test_can_do_is_public_and_does_not_issue_guest_cookie(ability_db, make_client):
    with make_client() as public:
        response = public.get(
            "/api/ability/can-do", params={"level": "B1", "skill": "reading", "lang": "zh-CN"}
        )
        assert response.status_code == 200, response.text
        assert response.headers["cache-control"] == "public, max-age=3600"
        body = response.json()
        assert body["level"] == "B1"
        assert body["skill"] == "reading"
        assert body["lang"] == "zh-CN"
        assert body["items"]
        assert body["items"][0]["statement"]
        assert body["items"][0]["observable"]
        assert body["items"][0]["basis"] in ("cefr-aligned", "product-operational")
        assert not any("ln_guest" in header for header in response.headers.get_list("set-cookie"))
        assert not public.cookies.get("ln_guest")


def test_can_do_validation_and_missing_content(ability_db, tmp_path, monkeypatch):
    assert ability_db.get(
        "/api/ability/can-do", params={"level": "D1", "skill": "reading"}
    ).status_code == 400
    assert ability_db.get(
        "/api/ability/can-do", params={"level": "B1", "skill": "vocabulary"}
    ).status_code == 400
    assert ability_db.get(
        "/api/ability/can-do",
        params={"level": "B1", "skill": "reading", "lang": "fr-FR"},
    ).status_code == 400
    monkeypatch.setattr(config, "ABILITY_DIR", str(tmp_path / "missing"), raising=False)
    missing = ability_db.get(
        "/api/ability/can-do", params={"level": "B1", "skill": "reading"}
    )
    assert missing.status_code == 503, missing.text


def test_can_do_vi_language(ability_db):
    response = ability_db.get(
        "/api/ability/can-do",
        params={"level": "A2", "skill": "speaking", "lang": "vi-VN"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["lang"] == "vi-VN"
    assert body["items"][0]["statement"].startswith("Có thể")


# ---------------------------------------------------------------------------
# 旧 profile shim / 游客隔离
# ---------------------------------------------------------------------------

def test_legacy_placement_profile_shim_has_no_reading_band(ability_db):
    _take_placement(ability_db)
    response = ability_db.get("/api/placement/profile")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["deprecated"] is True
    assert body["replacedBy"] == "/api/ability/profile"
    profile = body["profile"]
    assert profile["cefr"]
    assert profile["readingEstimate"] is None
    assert profile["reading_estimate"] is None
    assert profile["readingStatus"] == "insufficient"
    assert '"reading_estimate": null' in json.dumps(body, ensure_ascii=False)
    assert "readingEstimate\": \"" not in json.dumps(body)
    assert profile["measuredDomains"] == ["vocab"]
    assert "阅读" not in profile["advice"] or "证据不足" in profile["advice"]
    serialized = json.dumps(body, ensure_ascii=False)
    for band in assessment.CEFR_BANDS[:5]:
        assert f'"reading": "{band}"' not in serialized
        assert f'"readingEstimate": "{band}"' not in serialized


def test_guest_profile_is_isolated(ability_db, make_client):
    with make_client() as guest_one:
        guest_one.get("/api/auth/me")
        _take_placement(guest_one)
        first = guest_one.get("/api/ability/profile").json()
        assert first["vocabulary"]["status"] == "uncalibrated"
    with make_client() as guest_two:
        guest_two.get("/api/auth/me")
        second = guest_two.get("/api/ability/profile").json()
        assert second["vocabulary"]["status"] == "not_measured"
        assert second["sampleSize"] == 1  # 全站样本计数，但画像不串
