"""能力档案聚合层的离线验收（计划书 §7.6，specs/025）。

12 组聚合用例 + 2 组隐私用例：

- 无证据/仅定位/自评/陈旧/精度/可信度/状态机/游客/样本量/can-do 内容/认领；
- 隐私：证据流不含题干原文或 PII；删除钩子清空新表。

数据库在 conftest 的 tmp_path 下用真实 Alembic CLI 迁移，不联网、不碰 data/。
"""
from __future__ import annotations

import json
import sqlite3

import pytest

import ability
import assessment
import config
from tests.migration_utils import assert_alembic_ok, run_alembic

BANDS = ("A1", "A2", "B1", "B2", "C1")
NOW = 1_800_000_000_000


def _upgrade() -> None:
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (ability)"
    )


@pytest.fixture()
def ability_db(client):
    _upgrade()
    return client


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _insert_profile(
    user_id: str,
    skill: str = "vocabulary",
    *,
    point: str | None = "B1",
    low: str | None = "A2",
    high: str | None = "B2",
    confidence: float = 0.7,
    status: str = "uncalibrated",
    method: str = "placement",
    details: dict | None = None,
    evidence_count: int = 24,
    effective_n: float = 24.0,
    last_evidence_at: int | None = NOW,
    updated_at: int | None = NOW,
) -> None:
    payload = details if details is not None else {}
    with _db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO user_skill_profiles "
            "(user_id, skill, cefr_point, cefr_low, cefr_high, confidence, status, "
            "method, evidence_count, effective_n, last_evidence_at, details, "
            "calibration_version, schema_version, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                user_id,
                skill,
                point,
                low,
                high,
                confidence,
                status,
                method,
                evidence_count,
                effective_n,
                last_evidence_at,
                json.dumps(payload, ensure_ascii=False),
                assessment.CALIBRATION_VERSION,
                ability.SCHEMA_VERSION,
                updated_at or NOW,
            ),
        )


def _insert_self_assess(
    user_id: str,
    *,
    by_skill: dict,
    submitted_at: int = NOW,
    client_request_id: str = "req-1",
) -> str:
    import uuid

    session_id = uuid.uuid4().hex
    result = {
        "schemaVersion": ability.SCHEMA_VERSION,
        "calibrationVersion": assessment.CALIBRATION_VERSION,
        "bySkill": by_skill,
    }
    with _db() as conn:
        conn.execute(
            "INSERT INTO assessment_sessions "
            "(id, user_id, kind, status, client_request_id, started_at, "
            "submitted_at, duration_ms, score, confidence, skills, result, "
            "schema_version) "
            "VALUES (?, ?, 'self_assess', 'submitted', ?, ?, ?, 120000, 1.5, 0.35, "
            "?, ?, ?)",
            (
                session_id,
                user_id,
                client_request_id,
                submitted_at - 120_000,
                submitted_at,
                json.dumps(sorted(by_skill)),
                json.dumps(result, ensure_ascii=False),
                ability.SCHEMA_VERSION,
            ),
        )
    return session_id


def _insert_placement_sessions(user_id: str, count: int) -> None:
    import uuid

    with _db() as conn:
        conn.executemany(
            "INSERT INTO placement_sessions (id, user_id, status, started_at, "
            "submitted_at) VALUES (?, ?, 'submitted', ?, ?)",
            [
                (uuid.uuid4().hex, f"seed-{uuid.uuid4().hex}", NOW - index, NOW - index)
                for index in range(count)
            ],
        )


# ---------------------------------------------------------------------------
# 聚合
# ---------------------------------------------------------------------------

def test_seed_rows_hide_band_but_keep_point():
    """v1.1 D8-2：旧词汇量回填行只给点估计，不给区间。"""
    row = {"cefr_point": "C1", "cefr_low": "B2", "cefr_high": "C2"}
    assert ability._display_band({"source": "legacy_seed"}, row) == (None, None)
    assert ability._display_band({"source": "placement"}, row) == ("B2", "C2")


def test_profile_without_evidence_returns_not_measured(ability_db):
    payload = ability.profile(ability_db.user_id, now=NOW)
    assert payload["primary"] == "vocabulary"
    assert payload["vocabulary"]["status"] == "not_measured"
    assert payload["vocabulary"]["cefr"] is None
    assert payload["vocabulary"]["estimate"] is None
    assert payload["composite"]["cefr"] is None
    assert payload["composite"]["derivedFrom"] == []
    assert payload["skills"]["reading"]["status"] == "insufficient"
    assert payload["skills"]["reading"]["items"] == 0
    assert payload["skills"]["listening"]["status"] == "not_measured"
    assert payload["skills"]["speaking"]["status"] == "not_measured"
    assert payload["skills"]["writing"]["status"] == "self_report"
    assert payload["skills"]["writing"]["cefr"] is None
    assert payload["skills"]["writing"]["selfReport"]["band"] is None
    assert payload["grammar"]["status"] == "not_measured"
    assert payload["grammar"]["pointsTotal"] == 80
    assert "overall" not in payload


def test_vocabulary_row_maps_interval_precision_and_validity(ability_db):
    details = {
        "estimate": {"point": 5000, "low": 3000, "high": 7000, "unit": "lemma"},
        "precision": {"label": "medium", "se": 0.53},
        "validity": {"label": "high", "flags": ["pseudo_ok", "duration_ok"]},
        "note": "题目证据·未标定：有 24 道题。",
    }
    _insert_profile(ability_db.user_id, details=details, last_evidence_at=NOW)
    payload = ability.profile(ability_db.user_id, now=NOW)
    vocab = payload["vocabulary"]
    assert vocab["status"] == "uncalibrated"
    assert vocab["cefr"] == "B1"
    assert vocab["low"] == "A2" and vocab["high"] == "B2"
    assert vocab["label"] == "A2–B2"
    assert vocab["estimate"] == details["estimate"]
    assert vocab["precision"] == {"label": "medium", "se": 0.53}
    assert vocab["validity"]["label"] == "high"
    assert vocab["evidenceStrength"] == "medium"
    # confidence = min(precision 0.75, validity 0.90) 再与入库值 0.7 取小。
    assert vocab["confidence"] == 0.7
    assert vocab["calibrationVersion"] == "rasch.eap.v1"
    assert payload["composite"]["cefr"] is None
    assert payload["composite"]["derivedFrom"] == ["vocabulary"]
    assert payload["inputOutputGap"]["available"] is False
    assert payload["inputOutputGap"]["outputBand"] is None
    assert payload["sampleSize"] == 0
    assert payload["preliminary"] is True


def test_precision_label_changes_with_se(ability_db):
    for se, expected in ((0.40, "high"), (0.53, "medium"), (0.80, "low")):
        details = {"precision": {"label": "medium", "se": se}}
        _insert_profile(
            ability_db.user_id,
            details=details,
            confidence=0.8,
            last_evidence_at=NOW,
        )
        vocab = ability.profile(ability_db.user_id, now=NOW)["vocabulary"]
        assert vocab["precision"]["se"] == se
        assert vocab["precision"]["label"] == expected


def test_confidence_is_min_of_precision_and_validity(ability_db):
    details = {
        "precision": {"label": "high", "se": 0.40},
        "validity": {"label": "low", "flags": ["pseudo_overclaim"]},
    }
    _insert_profile(
        ability_db.user_id, details=details, confidence=0.9, last_evidence_at=NOW
    )
    vocab = ability.profile(ability_db.user_id, now=NOW)["vocabulary"]
    assert vocab["validity"]["label"] == "low"
    assert vocab["confidence"] == 0.35
    assert vocab["evidenceStrength"] == "medium"


def test_stale_after_90_days(ability_db):
    details = {"precision": {"label": "medium", "se": 0.53}}
    _insert_profile(ability_db.user_id, details=details, last_evidence_at=NOW)
    fresh = ability.profile(ability_db.user_id, now=NOW + ability.STALE_MS - 1)
    stale = ability.profile(
        ability_db.user_id, now=NOW + ability.STALE_MS + 1
    )
    assert fresh["vocabulary"]["stale"] is False
    assert stale["vocabulary"]["stale"] is True


def test_measured_status_is_unreachable_in_m1(ability_db):
    _insert_profile(ability_db.user_id, status="measured", details={})
    with pytest.raises(RuntimeError, match="measured"):
        ability.profile(ability_db.user_id, now=NOW)


def test_writing_self_report_keeps_cefr_null_and_band_only_in_self_report(ability_db):
    _insert_self_assess(
        ability_db.user_id,
        by_skill={
            "writing": {"band": "B2", "items": 5, "mean": 2.6},
            "listening": {"band": "B1", "items": 5, "mean": 2.0},
        },
    )
    payload = ability.profile(ability_db.user_id, now=NOW)
    writing = payload["skills"]["writing"]
    assert writing["status"] == "self_report"
    assert writing["cefr"] is None
    assert writing["low"] is None and writing["high"] is None
    assert writing["selfReport"]["band"] == "B2"
    assert writing["selfReport"]["items"] == 5
    assert "band" not in writing or writing.get("band") is None
    # 自评不改变词汇带。
    assert payload["vocabulary"]["status"] == "not_measured"
    assert payload["composite"]["cefr"] is None


def test_conflict_when_same_skill_evidence_and_self_report_differ_by_two(ability_db):
    _insert_profile(
        ability_db.user_id,
        skill="reading",
        point="C1",
        low="B2",
        high="C1",
        details={},
    )
    _insert_self_assess(
        ability_db.user_id,
        by_skill={"reading": {"band": "A1", "items": 5, "mean": 0.4}},
    )
    payload = ability.profile(ability_db.user_id, now=NOW)
    assert payload["skills"]["reading"]["status"] == "insufficient"
    conflicts = payload["conflicts"]
    assert len(conflicts) == 1
    assert conflicts[0]["skill"] == "reading"
    assert conflicts[0]["bandGap"] == 4
    assert conflicts[0]["action"] == "suggest_retest"


def test_guest_and_user_profiles_do_not_leak(ability_db):
    guest_identity = "guest:" + "a" * 64
    _insert_profile(guest_identity, details={"estimate": {"point": 3000}})
    guest_payload = ability.profile(guest_identity, now=NOW)
    user_payload = ability.profile(ability_db.user_id, now=NOW)
    assert guest_payload["vocabulary"]["status"] == "uncalibrated"
    assert guest_payload["vocabulary"]["estimate"]["point"] == 3000
    assert user_payload["vocabulary"]["status"] == "not_measured"


def test_sample_size_and_preliminary_flip_at_100(ability_db):
    _insert_placement_sessions("sample-owner", 99)
    before = ability.profile(ability_db.user_id, now=NOW)
    assert before["sampleSize"] == 99
    assert before["preliminary"] is True
    _insert_placement_sessions("sample-owner", 1)
    after = ability.profile(ability_db.user_id, now=NOW)
    assert after["sampleSize"] == 100
    assert after["preliminary"] is False


def test_can_do_content_covers_four_skills_and_five_levels():
    content = ability.load_can_do()
    items = content["items"]
    assert len(items) >= 40
    coverage = {(item["skill"], item["level"]) for item in items}
    expected = {
        (skill, level)
        for skill in ("listening", "speaking", "reading", "writing")
        for level in BANDS
    }
    assert expected <= coverage
    assert all(item["statement"]["zh"] for item in items)
    assert all(item["statement"]["vi"] for item in items)
    payload = ability.can_do("B1", "reading", "zh-CN")
    assert payload["level"] == "B1"
    assert payload["lang"] == "zh-CN"
    assert payload["items"]
    assert payload["items"][0]["basis"] in ("cefr-aligned", "product-operational")
    assert ability.can_do("B1", "reading", "vi-VN")["items"][0]["statement"]


def test_claim_guest_moves_ability_rows(ability_db):
    guest_hash = "b" * 64
    guest_identity = "guest:" + guest_hash
    _insert_profile(guest_identity, details={"estimate": {"point": 3000}})
    _insert_self_assess(guest_identity, by_skill={"writing": {"band": "A2", "items": 5}})
    moved = ability.claim_guest(guest_hash, ability_db.user_id)
    assert moved["user_skill_profiles"] == 1
    assert moved["assessment_sessions"] == 1
    payload = ability.profile(ability_db.user_id, now=NOW)
    assert payload["vocabulary"]["cefr"] == "B1"
    assert payload["skills"]["writing"]["selfReport"]["band"] == "A2"
    assert ability.profile(guest_identity, now=NOW)["vocabulary"]["status"] == "not_measured"


# ---------------------------------------------------------------------------
# 隐私
# ---------------------------------------------------------------------------

def test_placement_evidence_contains_no_prompt_or_pii(ability_db):
    start = ability_db.get("/api/placement/start").json()
    email = ability_db.user_email
    answers = [
        {"itemId": item["itemId"], "chosenIndex": 0, "elapsedMs": 9_000}
        for item in start["items"]
    ]
    response = ability_db.post(
        "/api/placement/submit",
        json={
            "sessionId": start["sessionId"],
            "answers": answers,
            "durationMs": 600_000,
        },
    )
    assert response.status_code == 200, response.text
    prompts = {item["prompt"] for item in start["items"] if item.get("prompt")}
    passages = {item.get("passage") for item in start["items"] if item.get("passage")}
    with _db() as conn:
        rows = conn.execute("SELECT * FROM skill_evidence").fetchall()
        answers_rows = conn.execute("SELECT * FROM placement_answers").fetchall()
    assert len(rows) == 29
    assert len(answers_rows) == 32
    assert all(row["elapsed_ms"] == 9_000 for row in answers_rows)
    for row in rows:
        blob = " ".join(
            str(row[key] or "")
            for key in ("source_key", "source_ref", "band", "payload")
        )
        assert email not in blob
        assert not any(prompt in blob for prompt in prompts)
        assert not any(passage and passage in blob for passage in passages)
        payload = json.loads(row["payload"]) if row["payload"] else {}
        assert set(payload).issubset({"elapsedMs"})


def test_purge_user_removes_all_ability_rows(ability_db):
    import uuid

    _insert_profile(ability_db.user_id, details={})
    _insert_self_assess(
        ability_db.user_id, by_skill={"writing": {"band": "A2", "items": 5}}
    )
    with _db() as conn:
        conn.execute(
            "INSERT INTO skill_evidence "
            "(user_id, skill, evidence_type, source_key, observed_at, created_at) "
            "VALUES (?, 'vocabulary', 'placement_answer', ?, ?, ?)",
            (ability_db.user_id, f"placement:{uuid.uuid4().hex}:v-001", NOW, NOW),
        )
    counts = ability.purge_user(ability_db.user_id)
    assert counts["user_skill_profiles"] == 1
    assert counts["assessment_sessions"] == 1
    assert counts["skill_evidence"] == 1
    with _db() as conn:
        for table in (
            "user_skill_profiles",
            "assessment_sessions",
            "skill_evidence",
        ):
            assert (
                conn.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE user_id = ?",
                    (ability_db.user_id,),
                ).fetchone()[0]
                == 0
            )
