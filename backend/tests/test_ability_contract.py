"""契约断言 A1–A8（计划书 §7.7，specs/025）。

这些用例是**发版闸门**：任何一条失败都表示用户可见 payload 又在声称
「阅读有带 / 总等级 / 自评带 / measured」，或文案出现禁用词。
"""
from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path

import pytest

import config
from tests.migration_utils import assert_alembic_ok, run_alembic

BACKEND_DIR = Path(__file__).resolve().parents[1]
CONTENT_DIR = BACKEND_DIR.parent / "content" / "ability"


def _upgrade() -> None:
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (contract)"
    )


@pytest.fixture()
def migrated(client):
    _upgrade()
    return client


def _take_placement(client) -> dict:
    start = client.get("/api/placement/start").json()
    answers = [
        {"itemId": item["itemId"], "chosenIndex": 0, "elapsedMs": 8_000}
        for item in start["items"]
    ]
    response = client.post(
        "/api/placement/submit",
        json={
            "sessionId": start["sessionId"],
            "answers": answers,
            "durationMs": 600_000,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _walk(value, path=()):
    """深度遍历 JSON，产出 (path, dict/list/str)。"""
    yield path, value
    if isinstance(value, dict):
        for key, child in value.items():
            yield from _walk(child, path + (key,))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _walk(child, path + (index,))


def _self_assess(client) -> dict:
    items = [
        item["id"]
        for item in json.load(
            (CONTENT_DIR / "self_assess.json").open(encoding="utf-8")
        )["items"]
    ]
    response = client.post(
        "/api/ability/self-assess",
        json={
            "clientRequestId": "contract-1",
            "answers": [{"itemId": item, "rating": 2} for item in items],
            "durationMs": 120_000,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_a1_submit_has_no_reading_band(migrated):
    result = _take_placement(migrated)
    reading = result["breakdown"]["reading"]
    assert "band" not in reading
    assert reading["status"] == "insufficient"
    assert reading["items"] == 5
    assert reading["method"] == "reading.5item.v1"
    assert '"band"' not in json.dumps(reading, ensure_ascii=False)


def test_a2_strengths_weaknesses_advice_have_no_reading_dimension(migrated):
    result = _take_placement(migrated)
    breakdown = result["breakdown"]
    assert all("阅读" not in item for item in breakdown["strengths"])
    assert all("阅读" not in item for item in breakdown["weaknesses"])
    # 建议里只允许出现「阅读证据不足/下一版小测」这类说明，不允许阅读带或
    # 「阅读短板」判断。
    advice = breakdown["advice"]
    assert "阅读" not in advice or ("证据不足" in advice or "小测" in advice)
    assert not re.search(r"阅读[^。；]{0,8}(A1|A2|B1|B2|C1)", advice)
    assert "阅读是当前短板" not in advice


def test_a3_legacy_profile_reading_is_null_and_insufficient(migrated):
    _take_placement(migrated)
    body = migrated.get("/api/placement/profile").json()
    profile = body["profile"]
    assert profile["readingEstimate"] is None
    assert profile["reading_estimate"] is None
    assert profile["readingStatus"] == "insufficient"
    assert body["deprecated"] is True
    assert body["replacedBy"] == "/api/ability/profile"


def test_a4_ability_profile_has_no_overall_and_composite_is_null(migrated):
    _take_placement(migrated)
    body = migrated.get("/api/ability/profile").json()
    assert "overall" not in body
    assert body["primary"] == "vocabulary"
    assert body["composite"]["cefr"] is None
    assert body["composite"]["derivedFrom"] == ["vocabulary"]
    assert body["vocabulary"]["cefr"] is not None
    assert body["vocabulary"]["status"] != "measured"


def test_a5_self_report_cefr_is_null_and_band_lives_in_self_report(migrated):
    payload = _self_assess(migrated)
    writing = payload["profile"]["skills"]["writing"]
    assert writing["status"] == "self_report"
    assert writing["cefr"] is None
    assert writing["low"] is None and writing["high"] is None
    assert writing["selfReport"]["band"] is not None
    assert writing.get("band") is None
    assert writing["selfReport"]["caveat"]


def test_a6_public_payload_has_zero_reading_band(migrated):
    _take_placement(migrated)
    _self_assess(migrated)
    bodies = [
        migrated.get("/api/ability/profile").json(),
        migrated.get("/api/placement/profile").json(),
    ]
    for body in bodies:
        for path, value in _walk(body):
            if isinstance(value, dict):
                if "reading" in path or (path and path[-1] == "reading"):
                    assert "band" not in value or value.get("band") is None, path
                    assert "cefr" not in value or value.get("cefr") is None, path
                    assert "low" not in value or value.get("low") is None, path
                    assert "high" not in value or value.get("high") is None, path
    serialized = json.dumps(bodies, ensure_ascii=False)
    assert '"readingEstimate": null' in serialized
    assert '"readingStatus": "insufficient"' in serialized


def test_a7_copy_has_no_banned_claims():
    banned_patterns = {
        "已测量": r"已测量",
        "个性化": r"个性化",
        "准确率": r"准确率",
        "±1 带 9x%": r"±1\s*带\s*9\d%",
        "相当于雅思": r"相当于雅思",
        "B1.x": r"B1\.\d",
    }
    files = [
        CONTENT_DIR / "can_do.json",
        CONTENT_DIR / "self_assess.json",
        BACKEND_DIR / "ability.py",
        BACKEND_DIR / "routes_ability.py",
    ]
    hits: list[str] = []
    for path in files:
        text = path.read_text(encoding="utf-8")
        for label, pattern in banned_patterns.items():
            for match in re.finditer(pattern, text):
                line = text.count("\n", 0, match.start()) + 1
                hits.append(f"{path.name}:{line}:{label}")
    assert hits == [], hits


def test_a8_migration_has_zero_measured_rows(client):
    # 先造一个旧画像，再跑迁移，验证 seed 不会把旧数据写成 measured。
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "0013_user_profile"),
        "upgrade to 0013",
    )
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    conn.execute(
        "INSERT OR REPLACE INTO user_profiles "
        "(user_id, cefr, level_band_low, level_band_high, vocab_estimate, "
        "reading_estimate, confidence, pseudo_word_suspicion, updated_at, source) "
        "VALUES ('legacy-user', 'A2–B2', 'A2', 'B2', 5000, 'C1', 0.9, 0, 1, 'placement')"
    )
    conn.commit()
    conn.close()
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade to head"
    )
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    measured = conn.execute(
        "SELECT COUNT(*) FROM user_skill_profiles WHERE status = 'measured'"
    ).fetchone()[0]
    seeded = conn.execute(
        "SELECT cefr_point, confidence, status FROM user_skill_profiles "
        "WHERE user_id = 'legacy-user' AND skill = 'vocabulary'"
    ).fetchone()
    reading_rows = conn.execute(
        "SELECT COUNT(*) FROM user_skill_profiles WHERE skill = 'reading'"
    ).fetchone()[0]
    conn.close()
    assert measured == 0
    assert seeded is not None
    assert seeded[0] == "B1"
    assert seeded[1] == 0.85  # cap
    assert seeded[2] == "uncalibrated"
    assert reading_rows == 0
