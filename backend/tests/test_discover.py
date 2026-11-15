"""内容发现（POST /api/discover）离线测试（specs/017-discover）。

全部 monkeypatch：yt-dlp 搜索、youtube-transcript-api 探测、LLM 两次调用都不
联网；缓存表只在缓存相关用例里跑一次真实 Alembic 迁移（tmp 库），其余用例
按「未迁移 → 缓存降级」路径也能跑。

覆盖：意图改写容错、搜索过滤/去重、字幕 none/unknown、已处理跳过探测、
LLM 重排/非法 index/降级模板理由、24h 缓存不重复搜索、force、游客 403、
5 次/分钟限速、参数校验、搜索失败 503、整体超时 504。
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

import config
import discover
from tests.conftest import SECOND_USER_EMAIL, SECOND_USER_PASSWORD
from tests.migration_utils import assert_alembic_ok, run_alembic

DEFAULT_QUERIES = [
    "TED talk about AI",
    "AI explained lecture",
    "artificial intelligence future",
]

GOOD_1 = "AAAAAAAAAA1"
GOOD_2 = "BBBBBBBBBB2"
GOOD_3 = "CCCCCCCCCC3"
GOOD_4 = "DDDDDDDDDD4"

REQUIRED_CANDIDATE_KEYS = {
    "videoId",
    "title",
    "channel",
    "duration",
    "thumbnail",
    "level",
    "reason",
    "hasEnglishSubs",
    "alreadyProcessed",
}


def _raw(
    video_id: str,
    title: str,
    *,
    channel: str = "TED",
    duration: int | None = 600,
    live: str | None = None,
    verified: bool = True,
) -> dict:
    return {
        "videoId": video_id,
        "title": title,
        "channel": channel,
        "channelVerified": verified,
        "durationSeconds": duration,
        "description": f"{title} description",
        "liveStatus": live,
        "viewCount": 1000,
    }


def _default_search_results() -> dict[str, list[dict]]:
    return {
        DEFAULT_QUERIES[0]: [
            _raw(GOOD_1, "What is AI"),
            _raw(GOOD_2, "AI in ten minutes", duration=900),
        ],
        DEFAULT_QUERIES[1]: [
            _raw(GOOD_3, "How AI works", channel="MIT OpenCourseWare", duration=1200),
        ],
        DEFAULT_QUERIES[2]: [
            _raw(GOOD_4, "The future of AI", channel="TED-Ed", duration=480),
        ],
    }


def _default_rerank() -> str:
    return json.dumps(
        {
            "picks": [
                {"index": 1, "level": "B1", "reason": "TED 的 AI 入门讲解，10 分钟适合一次看完。"},
                {"index": 2, "level": "B2", "reason": "MIT 公开课，主题系统且时长适中。"},
                {"index": 3, "level": "A2", "reason": "TED-Ed 动画短片，概念清楚、语速友好。"},
            ]
        },
        ensure_ascii=False,
    )


@pytest.fixture()
def discover_env(monkeypatch):
    """三处外部调用的可控 mock + 调用记录。"""
    state = {
        "search_results": _default_search_results(),
        "search_calls": [],
        "probe_calls": [],
        "captions": {},
        "llm_calls": [],
        "intent_response": json.dumps({"queries": DEFAULT_QUERIES}, ensure_ascii=False),
        "rerank_response": _default_rerank(),
    }

    def fake_search(query, limit):
        state["search_calls"].append((query, limit))
        value = state["search_results"].get(query, [])
        if isinstance(value, BaseException):
            raise value
        return [dict(item) for item in value]

    def fake_probe(video_id):
        state["probe_calls"].append(video_id)
        value = state["captions"].get(video_id, True)
        if isinstance(value, BaseException):
            raise value
        return value

    async def fake_llm(prompt, model):
        state["llm_calls"].append(prompt)
        value = (
            state["intent_response"]
            if discover._INTENT_MARKER in prompt
            else state["rerank_response"]
        )
        if isinstance(value, BaseException):
            raise value
        if callable(value):
            value = value(prompt)
        if isinstance(value, (dict, list)):
            return json.dumps(value, ensure_ascii=False)
        return value

    monkeypatch.setattr(discover, "_search_ytdlp", fake_search)
    monkeypatch.setattr(discover, "_probe_caption", fake_probe)
    monkeypatch.setattr(discover, "_call_llm", fake_llm)
    return state


@pytest.fixture()
def migrated_client(client):
    """已登录 + 已跑 Alembic 迁移的客户端（缓存表存在）。"""
    assert_alembic_ok(
        run_alembic(Path(config.AUTH_DB_PATH), "upgrade", "head"),
        "upgrade head",
    )
    return client


def _post(client, query="TED talk about AI", **extra):
    body = {"query": query, "targetLang": "zh-CN"}
    body.update(extra)
    return client.post("/api/discover", json=body)


# ---------------------------------------------------------------------------
# 正常契约 + 意图改写
# ---------------------------------------------------------------------------

def test_discover_contract_and_intent_queries(client, discover_env):
    discover_env["rerank_response"] = json.dumps(
        {
            "picks": [
                {"index": 3, "level": "A2", "reason": "动画短片，概念清楚。"},
                {"index": 1, "level": "B1", "reason": "TED 入门讲解，时长合适。"},
                {"index": 2, "level": "B2", "reason": "公开课，主题系统。"},
            ]
        },
        ensure_ascii=False,
    )

    response = _post(client)
    assert response.status_code == 200, response.text
    data = response.json()

    assert data["queries"] == DEFAULT_QUERIES
    assert len(data["queries"]) == 3
    assert data["cached"] is False
    assert data["degraded"] is False
    assert isinstance(data["disclaimer"], str) and "字幕" in data["disclaimer"]

    candidates = data["candidates"]
    assert len(candidates) == 3
    assert [item["videoId"] for item in candidates] == [GOOD_3, GOOD_1, GOOD_2]
    for candidate in candidates:
        assert set(candidate) == REQUIRED_CANDIDATE_KEYS
        assert candidate["duration"] > 0
        assert candidate["thumbnail"] == (
            f"https://i.ytimg.com/vi/{candidate['videoId']}/hqdefault.jpg"
        )
        assert candidate["hasEnglishSubs"] is True
        assert candidate["alreadyProcessed"] is False
        assert candidate["level"] in discover.CEFR_LEVELS
        assert candidate["reason"]
    assert candidates[0]["level"] == "A2"
    assert candidates[0]["reason"] == "动画短片，概念清楚。"

    # 两次 LLM（意图 + 重排）；三个 query 各搜一次。
    assert len(discover_env["llm_calls"]) == 2
    assert [query for query, _limit in discover_env["search_calls"]] == DEFAULT_QUERIES
    assert all(limit == 8 for _query, limit in discover_env["search_calls"])


def test_intent_json_fence_and_chinese_query_rejected():
    parsed = discover._parse_intent_queries(
        '```json\n{"queries": ["AI talk", "AI lecture", "中文搜索词"]}\n```'
    )
    assert parsed == ["AI talk", "AI lecture"]

    # 不足 2 个合法英文检索词 → 视为失败，由调用方降级为原 query。
    assert discover._parse_intent_queries('{"queries": ["AI"]}') == []
    assert discover._parse_intent_queries("not json") == []


def test_intent_failure_degrades_to_original_query(client, discover_env):
    discover_env["intent_response"] = "definitely not json"
    discover_env["search_results"] = {
        "TED talk about AI": [_raw(GOOD_1, "What is AI")],
    }

    data = _post(client, query="TED talk about AI").json()
    assert data["queries"] == ["TED talk about AI"]
    assert data["degraded"] is True
    assert [candidate["videoId"] for candidate in data["candidates"]] == [GOOD_1]


# ---------------------------------------------------------------------------
# 搜索过滤 / 去重 / 字幕状态
# ---------------------------------------------------------------------------

def test_search_filters_live_short_long_duplicates(client, discover_env):
    discover_env["search_results"] = {
        DEFAULT_QUERIES[0]: [
            _raw(GOOD_1, "Good one", duration=600),
            _raw("LIVELIVELI1", "Live", live="is_live"),
            _raw("SHORTSHORT1", "Short", duration=60),
            _raw("LONGLONGLO1", "Too long", duration=6000),
            _raw("NODURATION1", "No duration", duration=None),
        ],
        DEFAULT_QUERIES[1]: [
            _raw(GOOD_1, "Duplicate of good one"),
            _raw(GOOD_2, "Good two", duration=900),
        ],
        DEFAULT_QUERIES[2]: [
            _raw(GOOD_3, "Good three", duration=1200),
            _raw("UPCOMINGUP1", "Upcoming", live="is_upcoming"),
        ],
    }

    data = _post(client).json()
    ids = [candidate["videoId"] for candidate in data["candidates"]]
    assert ids == [GOOD_1, GOOD_2, GOOD_3]
    assert set(discover_env["probe_calls"]) == {GOOD_1, GOOD_2, GOOD_3}


def test_no_english_captions_filtered_unknown_kept(client, discover_env):
    discover_env["search_results"] = {
        DEFAULT_QUERIES[0]: [
            _raw(GOOD_1, "Has English"),
            _raw(GOOD_2, "No English"),
            _raw(GOOD_3, "Probe failed"),
        ],
        DEFAULT_QUERIES[1]: [_raw(GOOD_4, "Has English too")],
        DEFAULT_QUERIES[2]: [],
    }
    discover_env["captions"] = {
        GOOD_1: True,
        GOOD_2: False,
        GOOD_3: TimeoutError("probe timed out"),
        GOOD_4: True,
    }

    data = _post(client).json()
    by_id = {candidate["videoId"]: candidate for candidate in data["candidates"]}
    assert GOOD_2 not in by_id, "确认没有英文字幕的候选应被过滤"
    assert GOOD_3 in by_id, "探测失败应保留并标 unknown，不能误杀"
    assert by_id[GOOD_3]["hasEnglishSubs"] is None
    assert by_id[GOOD_1]["hasEnglishSubs"] is True


def test_already_processed_video_skips_probe(client, history_dir, discover_env):
    (Path(history_dir) / f"cached_{GOOD_1}.json").write_text("{}", encoding="utf-8")
    discover_env["search_results"] = {
        DEFAULT_QUERIES[0]: [
            _raw(GOOD_1, "Already processed"),
            _raw(GOOD_2, "New one"),
        ],
        DEFAULT_QUERIES[1]: [_raw(GOOD_3, "Another new one")],
        DEFAULT_QUERIES[2]: [],
    }

    data = _post(client).json()
    by_id = {candidate["videoId"]: candidate for candidate in data["candidates"]}
    assert by_id[GOOD_1]["alreadyProcessed"] is True
    assert by_id[GOOD_1]["hasEnglishSubs"] is True
    assert GOOD_1 not in discover_env["probe_calls"], "已处理视频不应再探测字幕"


# ---------------------------------------------------------------------------
# 重排：非法 index / 降级
# ---------------------------------------------------------------------------

def test_invalid_picks_are_dropped_and_filled_to_three(client, discover_env):
    discover_env["rerank_response"] = json.dumps(
        {
            "picks": [
                {"index": 99, "level": "B1", "reason": "越界"},
                {"index": 1, "level": "B1", "reason": "第一条理由"},
                {"index": 1, "level": "B2", "reason": "重复 index"},
                {"index": -2, "level": "B1", "reason": "负数"},
                {"index": 2, "level": "C9", "reason": "非法难度"},
            ]
        },
        ensure_ascii=False,
    )

    data = _post(client).json()
    assert len(data["candidates"]) == 3
    assert [candidate["videoId"] for candidate in data["candidates"]] == [
        GOOD_1,
        GOOD_2,
        GOOD_3,
    ]
    assert data["candidates"][0]["reason"] == "第一条理由"
    assert data["candidates"][1]["level"] == discover._heuristic_level(
        data["candidates"][1]["duration"]
    )
    # 2 个合法 pick + 1 个规则补足 → 标 degraded（诚实标注模板理由）。
    assert data["degraded"] is True
    assert "来自与主题相关的搜索结果" in data["candidates"][2]["reason"]


def test_rerank_failure_falls_back_to_rules(client, discover_env):
    discover_env["rerank_response"] = "not a json object"

    data = _post(client).json()
    assert len(data["candidates"]) == 4
    assert data["degraded"] is True
    for candidate in data["candidates"]:
        assert candidate["level"] in discover.CEFR_LEVELS
        assert "来自与主题相关的搜索结果" in candidate["reason"]
        assert "有英文字幕" in candidate["reason"]


def test_llm_unavailable_still_returns_rule_ranked_candidates(
    client, discover_env, monkeypatch
):
    monkeypatch.setattr(discover.llm, "is_available", lambda _model: False)
    discover_env["search_results"] = {
        "TED talk about AI": [
            _raw(GOOD_1, "Good one"),
            _raw(GOOD_2, "Good two", duration=900),
            _raw(GOOD_3, "Good three", duration=1200),
            _raw(GOOD_4, "Good four", duration=480),
        ],
    }

    data = _post(client).json()
    assert data["queries"] == ["TED talk about AI"]
    assert data["degraded"] is True
    assert len(data["candidates"]) == 4
    assert discover_env["llm_calls"] == [], "模型不可用时不应发起 LLM 调用"


# ---------------------------------------------------------------------------
# 缓存 / force
# ---------------------------------------------------------------------------

def test_cache_hit_does_not_search_or_probe_again(migrated_client, discover_env):
    first = _post(migrated_client)
    assert first.status_code == 200, first.text
    assert first.json()["cached"] is False
    search_calls_after_first = len(discover_env["search_calls"])
    probe_calls_after_first = len(discover_env["probe_calls"])
    llm_calls_after_first = len(discover_env["llm_calls"])
    assert search_calls_after_first == 3
    assert llm_calls_after_first == 2

    second = _post(migrated_client, query="  ted TALK about ai ")
    assert second.status_code == 200, second.text
    data = second.json()
    assert data["cached"] is True
    assert len(data["candidates"]) == 3
    assert len(discover_env["search_calls"]) == search_calls_after_first
    assert len(discover_env["probe_calls"]) == probe_calls_after_first
    assert len(discover_env["llm_calls"]) == llm_calls_after_first


def test_force_bypasses_cache(migrated_client, discover_env):
    _post(migrated_client)
    assert len(discover_env["search_calls"]) == 3

    response = _post(migrated_client, force=True)
    assert response.status_code == 200, response.text
    assert response.json()["cached"] is False
    assert len(discover_env["search_calls"]) == 6


def test_cache_is_shared_but_already_processed_is_per_user(
    make_client, migrated_client, discover_env, history_dir
):
    (Path(history_dir) / f"cached_{GOOD_1}.json").write_text("{}", encoding="utf-8")
    first = _post(migrated_client).json()
    assert first["cached"] is False
    assert {c["videoId"]: c["alreadyProcessed"] for c in first["candidates"]}[GOOD_1] is True

    with make_client() as other:
        signup = other.post(
            "/api/auth/signup",
            json={"email": SECOND_USER_EMAIL, "password": SECOND_USER_PASSWORD},
        )
        assert signup.status_code == 201, signup.text
        second = _post(other).json()

    assert second["cached"] is True, "缓存键是 query+语言，跨用户共用"
    assert {c["videoId"]: c["alreadyProcessed"] for c in second["candidates"]}[GOOD_1] is False
    assert len(discover_env["search_calls"]) == 3


def test_expired_cache_is_not_used(migrated_client, discover_env):
    _post(migrated_client)
    assert len(discover_env["search_calls"]) == 3

    import sqlite3

    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        conn.execute("UPDATE discover_queries SET expires_at = 0")
        conn.commit()

    response = _post(migrated_client)
    assert response.json()["cached"] is False
    assert len(discover_env["search_calls"]) == 6


# ---------------------------------------------------------------------------
# 身份 / 限速 / 参数校验 / 失败
# ---------------------------------------------------------------------------

def test_guest_is_forbidden(make_client):
    with make_client() as guest:
        response = guest.post(
            "/api/discover",
            json={"query": "TED talk about AI", "targetLang": "zh-CN"},
        )
    assert response.status_code == 403, response.text
    assert "登录" in response.json()["detail"]


def test_rate_limit_five_per_minute_per_user(client, discover_env, monkeypatch):
    monkeypatch.setattr(config, "RATE_LIMIT_DISCOVER_PER_MINUTE", 2)

    assert _post(client).status_code == 200
    assert _post(client).status_code == 200
    response = _post(client)
    assert response.status_code == 429, response.text
    assert response.headers.get("retry-after")
    assert "retryAfter" in response.json()


@pytest.mark.parametrize(
    "query",
    ["", "   ", "x" * 201],
)
def test_invalid_query_returns_400(client, discover_env, query):
    response = _post(client, query=query)
    assert response.status_code == 400, response.text
    detail = response.json()["detail"]
    assert isinstance(detail, str) and detail


@pytest.mark.parametrize(
    "query",
    [
        "https://www.youtube.com/watch?v=KKNCiRWd_j0",
        "https://youtu.be/KKNCiRWd_j0",
        "youtube.com/shorts/KKNCiRWd_j0",
    ],
)
def test_youtube_url_is_rejected_with_400(client, discover_env, query):
    response = _post(client, query=query)
    assert response.status_code == 400, response.text
    assert "链接" in response.json()["detail"]


def test_invalid_target_lang_returns_400(client, discover_env):
    response = _post(client, targetLang="xx-YY")
    assert response.status_code == 400, response.text
    assert "语言" in response.json()["detail"]


def test_all_search_failures_return_503(client, discover_env):
    discover_env["search_results"] = {
        query: RuntimeError("yt-dlp blocked") for query in DEFAULT_QUERIES
    }
    response = _post(client)
    assert response.status_code == 503, response.text
    assert "搜索" in response.json()["detail"]


def test_single_search_failure_does_not_fail_request(client, discover_env):
    discover_env["search_results"] = {
        DEFAULT_QUERIES[0]: RuntimeError("one query failed"),
        DEFAULT_QUERIES[1]: [_raw(GOOD_1, "Good one")],
        DEFAULT_QUERIES[2]: [_raw(GOOD_2, "Good two")],
    }

    response = _post(client)
    assert response.status_code == 200, response.text
    assert [c["videoId"] for c in response.json()["candidates"]] == [GOOD_1, GOOD_2]


def test_deadline_returns_504(client, discover_env, monkeypatch):
    def slow_search(query, limit):
        time.sleep(0.2)
        return []

    monkeypatch.setattr(discover, "_search_ytdlp", slow_search)
    monkeypatch.setattr(config, "DISCOVER_TOTAL_SECONDS", 0.05)
    monkeypatch.setattr(config, "DISCOVER_SEARCH_TIMEOUT_SECONDS", 0.05)

    response = _post(client)
    assert response.status_code == 504, response.text
    assert "超时" in response.json()["detail"]


def test_empty_results_are_200_and_not_cached(migrated_client, discover_env):
    discover_env["search_results"] = {
        DEFAULT_QUERIES[0]: [_raw("NOCAPTION01", "No captions", duration=600)],
        DEFAULT_QUERIES[1]: [],
        DEFAULT_QUERIES[2]: [],
    }
    discover_env["captions"] = {"NOCAPTION01": False}

    first = _post(migrated_client)
    assert first.status_code == 200
    assert first.json()["candidates"] == []
    assert first.json()["cached"] is False

    second = _post(migrated_client)
    assert second.json()["cached"] is False
    assert len(discover_env["search_calls"]) == 6, "空结果不写缓存"
