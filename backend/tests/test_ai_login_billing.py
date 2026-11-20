"""M7a：AI 登录闸 + 严格计费（specs/036-ai-login-billing）离线验收。

覆盖：

1. 所有 AI 入口游客/匿名 → 403 ``{code:"login_required"}``（不是 401/429）；
2. 登录用户查词/视频/本地剧集/本地视频调用 → 预占+结算扣余额、账本归属本人；
3. 缓存命中/纯读取不触发 AI、不扣费；
4. 缺价模型 → 503 ``model_unpriced``，且**不调用 provider**；
5. 功能日配额 → 429 ``quota_exceeded``（稳定 code）；
6. 严格模式默认开启；模型路线只含 priced 模型。

全部离线：provider 用 monkeypatch 的假传输层（走真实 llm.generate → billing 链路）。
"""
from __future__ import annotations

import json
import re
import sqlite3
from types import SimpleNamespace

import pytest

import billing
import config
import llm
import routes_content
import routes_videos
import teaching_analysis

URL = "https://www.youtube.com/watch?v=m7avideo001"
VIDEO_ID = "m7avideo001"

DICT_PAYLOAD = {
    "word": "serendipity",
    "lemma": "serendipity",
    "ipa": "/ˌserənˈdɪpəti/",
    "pos": "n.",
    "zh": "意外发现美好事物的运气",
    "definition_en": "The luck of finding something good without looking for it.",
    "example": "It was pure serendipity that we met.",
}

TRANSCRIPT = [SimpleNamespace(text="Hello world.", start=0.0, duration=1.0)]
METADATA = {
    "title": "M7a Test",
    "channel": "Test Channel",
    "upload_date": "20260101",
    "thumbnail": "",
}

SRT = """1
00:00:00,000 --> 00:00:01,000
Hello world.
"""


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _rows(sql: str, params: tuple = ()) -> list[tuple]:
    """读账本表；游客用例可能还没有数据库/表，按「没有任何行」处理。"""
    try:
        with sqlite3.connect(config.AUTH_DB_PATH) as conn:
            return conn.execute(sql, params).fetchall()
    except sqlite3.OperationalError:
        return []


def _balance(user_id: str) -> int:
    return billing.get_balance(user_id)["balanceMicroUsd"]


def _usage_rows(feature: str | None = None) -> list[tuple]:
    if feature:
        return _rows(
            "SELECT user_id, billable, billing_status, cost_micro_usd FROM ai_usage "
            "WHERE feature = ? ORDER BY id",
            (feature,),
        )
    return _rows(
        "SELECT feature, user_id, billable, billing_status, cost_micro_usd "
        "FROM ai_usage ORDER BY id"
    )


def _assert_login_required(response) -> None:
    assert response.status_code == 403, response.text
    body = response.json()
    assert body.get("code") == "login_required", body
    assert body.get("detail"), body


def _fake_provider(calls: list[dict]):
    """按 prompt 形态返回 JSON：查词 / 字幕翻译。usage 固定，便于算扣费。"""

    def _generate(prompt: str, spec: dict, json_mode: bool):
        calls.append({"prompt": prompt, "model": spec.get("model_id")})
        if "Explain the English word" in prompt:
            return (
                json.dumps(DICT_PAYLOAD, ensure_ascii=False),
                {"input_tokens": 100, "output_tokens": 50},
            )
        if "provide a concise summary" in prompt:
            return "测试总结", {"input_tokens": 150, "output_tokens": 40}
        ids = sorted({int(value) for value in re.findall(r'"id":\s*(\d+)', prompt)})
        blocks = [
            {
                "id": index,
                "en_text": f"Sentence {index}.",
                "zh_text": f"译文 {index}。",
                "highlights": [],
            }
            for index in ids
        ]
        return (
            json.dumps({"blocks": blocks}, ensure_ascii=False),
            {"input_tokens": 200, "output_tokens": 80},
        )

    return _generate


def _install_pipeline(monkeypatch, calls: list[dict] | None = None):
    """视频/字幕链路：字幕抓取 + provider + 总结 + 教学分析全部离线。"""
    calls = calls if calls is not None else []
    monkeypatch.setattr(
        routes_videos, "fetch_english_transcript", lambda _video_id: list(TRANSCRIPT)
    )
    monkeypatch.setattr(routes_videos, "get_video_metadata", lambda _url: dict(METADATA))
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)
    monkeypatch.setattr(llm, "_generate_openai_compatible", _fake_provider(calls))

    async def _no_analysis(*_args, **_kwargs):
        return None

    monkeypatch.setattr(teaching_analysis, "attach_to_payload", _no_analysis)
    return calls


# ---------------------------------------------------------------------------
# 1. 游客/匿名：所有 AI 入口 403 login_required
# ---------------------------------------------------------------------------

def test_all_ai_entrypoints_reject_guest(make_client, monkeypatch):
    # 同一游客连续请求多个入口：放宽游客限速，验证的是登录闸而不是 429。
    monkeypatch.setattr(
        config, "RATE_LIMIT_GUEST_PROCESS_VIDEO_PER_MINUTE", 100, raising=False
    )
    monkeypatch.setattr(
        config, "RATE_LIMIT_GUEST_DEFINE_PER_MINUTE", 100, raising=False
    )
    monkeypatch.setattr(config, "RATE_LIMIT_DISCOVER_PER_MINUTE", 100, raising=False)
    monkeypatch.setattr(config, "RATE_LIMIT_BOOKS_PER_MINUTE", 100, raising=False)
    _install_pipeline(monkeypatch)
    with make_client() as guest:
        guest.get("/api/auth/me")
        requests = [
            ("post", "/api/define", {"json": {"word": "guestword"}}),
            ("post", "/api/process-video", {"json": {"url": URL}}),
            ("post", "/api/process-video-stream", {"json": {"url": URL}}),
            (
                "get",
                "/api/process-video-stream?jobId=whatever",
                {},
            ),
            (
                "post",
                "/api/process-subtitle",
                {"json": {"show_id": "show", "season": 1, "episode": 1}},
            ),
            (
                "post",
                "/api/local-video/process",
                {
                    "json": {
                        "blocks": [
                            {"id": 1, "start": 0, "end": 1, "en": "hello"}
                        ]
                    }
                },
            ),
            (
                "post",
                "/api/books/test-book/chapters/1/translate",
                {"json": {}},
            ),
            ("post", "/api/discover", {"json": {"query": "space"}}),
            (
                "post",
                "/api/article/x/translate",
                {"json": {"targetLang": "vi-VN"}},
            ),
            ("post", "/api/lesson/start", {"json": {}}),
            ("post", "/api/course/generate", {"json": {}}),
            ("get", "/api/teaching-analysis/video:x", {}),
            (
                "post",
                "/api/books/imported/x/chapters/1/translate",
                {"json": {}},
            ),
        ]
        for method, path, kwargs in requests:
            _assert_login_required(getattr(guest, method)(path, **kwargs))

        # 游客不产生任何 AI 用量/预占（游客用例可能还没有建库/建表）。
        assert _rows("SELECT COUNT(*) FROM ai_usage") in ([], [(0,)])
        assert _rows("SELECT COUNT(*) FROM credit_holds") in ([], [(0,)])


def test_guest_history_read_is_allowed_but_never_generates(make_client, monkeypatch):
    """纯缓存读取仍公开；但游客打开历史不会触发补译/总结/分析。"""
    calls: list[dict] = []
    _install_pipeline(monkeypatch, calls)
    with make_client() as guest:
        guest.get("/api/auth/me")
        from guest import hash_token

        guest_hash = hash_token(guest.cookies.get("ln_guest"))
        history = (
            config.GUEST_DATA_DIR
            + f"/{guest_hash}/history"
        )
        import os

        os.makedirs(history, exist_ok=True)
        filename = "Guest_20260101_m7avideo001.json"
        with open(os.path.join(history, filename), "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "videoId": VIDEO_ID,
                    "metadata": METADATA,
                    "transcript": [
                        {
                            "id": 1,
                            "start": 0.0,
                            "end": 1.0,
                            "en_text": "Hello world.",
                            "zh_text": "[未翻译]",
                        }
                    ],
                    "summary": "",
                },
                handle,
                ensure_ascii=False,
            )

        response = guest.get(f"/api/history/{filename}")
        assert response.status_code == 200, response.text
        assert calls == [], "游客打开缓存不得触发任何模型调用"
        assert _rows("SELECT COUNT(*) FROM ai_usage") in ([], [(0,)])


# ---------------------------------------------------------------------------
# 2. 登录用户：查词扣余额；缓存命中不扣
# ---------------------------------------------------------------------------

def test_define_charges_balance_and_cache_hit_is_free(client, monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(llm, "_generate_openai_compatible", _fake_provider(calls))

    before = _balance(client.user_id)
    first = client.post("/api/define", json={"word": "serendipity"})
    assert first.status_code == 200, first.text
    after_first = _balance(client.user_id)
    assert after_first < before, "登录用户查词必须扣余额"
    assert len(calls) == 1

    rows = _usage_rows("define")
    assert len(rows) == 1
    user_id, billable, status, cost = rows[0]
    assert user_id == client.user_id
    assert billable == 1
    assert status == "settled"
    assert cost == before - after_first
    assert _rows(
        "SELECT COUNT(*) FROM credit_holds WHERE status = 'settled'"
    ) == [(1,)]

    second = client.post("/api/define", json={"word": "Serendipity"})
    assert second.status_code == 200
    assert len(calls) == 1, "缓存命中不得再调模型"
    assert _balance(client.user_id) == after_first, "缓存命中不得再扣费"
    assert len(_usage_rows("define")) == 1


# ---------------------------------------------------------------------------
# 3. 缺价模型：503 model_unpriced 且不调用 provider
# ---------------------------------------------------------------------------

def test_unpriced_model_is_503_without_provider_call(client, monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(llm, "_generate_openai_compatible", _fake_provider(calls))
    before = _balance(client.user_id)

    response = client.post(
        "/api/define", json={"word": "unpricedword", "model": "qwen-flash"}
    )
    assert response.status_code == 503, response.text
    body = response.json()
    assert body["code"] == "model_unpriced"
    assert body["modelId"] == "qwen-flash"
    assert calls == [], "缺价模型不得调用厂商"
    assert _balance(client.user_id) == before
    assert _rows("SELECT COUNT(*) FROM credit_holds") == [(0,)]
    assert _rows("SELECT COUNT(*) FROM ai_usage") == [(0,)]


def test_model_routes_contain_only_priced_models(client):
    """所有目标语言路线（尤其越南语）只允许有可核实单价的模型。"""
    for target_lang in ("zh-CN", "vi-VN"):
        route = config.model_route_for(target_lang)
        assert route, target_lang
        for model_id in route:
            assert billing.price_for_model(model_id) is not None, model_id
    assert "qwen-flash" not in config.model_route_for("vi-VN")
    assert "qwen-plus" not in config.model_route_for("vi-VN")
    assert config.DEFAULT_MODEL_VI_VN == "deepseek-chat"


# ---------------------------------------------------------------------------
# 4. 视频 / 本地剧集 / 本地视频：登录扣费；重开缓存不扣
# ---------------------------------------------------------------------------

def test_process_video_charges_once_then_cache_reopen_is_free(client, monkeypatch):
    calls = _install_pipeline(monkeypatch)
    before = _balance(client.user_id)

    first = client.post("/api/process-video", json={"url": URL})
    assert first.status_code == 200, first.text
    after_first = _balance(client.user_id)
    assert after_first < before, "登录用户处理视频必须扣余额"
    features = {row[0] for row in _usage_rows()}
    assert "translate" in features and "summary" in features
    users = {row[1] for row in _usage_rows()}
    assert users == {client.user_id}
    assert all(row[2] == 1 for row in _usage_rows())  # billable

    calls_before = len(calls)
    second = client.post("/api/process-video", json={"url": URL})
    assert second.status_code == 200
    assert len(calls) == calls_before, "缓存完整时重开不得再调模型"
    assert _balance(client.user_id) == after_first, "缓存命中不得再扣费"


def test_process_subtitle_charges_logged_in_user(client, monkeypatch, tmp_path):
    calls: list[dict] = []
    monkeypatch.setattr(llm, "_generate_openai_compatible", _fake_provider(calls))
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)
    subtitles = tmp_path / "subtitles"
    (subtitles / "show" / "S01").mkdir(parents=True)
    (subtitles / "show" / "S01" / "E01.srt").write_text(SRT, encoding="utf-8")
    monkeypatch.setattr(routes_content, "SUBTITLES_DIR", str(subtitles), raising=False)

    async def _no_analysis(*_args, **_kwargs):
        return None

    monkeypatch.setattr(teaching_analysis, "attach_to_payload", _no_analysis)

    before = _balance(client.user_id)
    response = client.post(
        "/api/process-subtitle",
        json={"show_id": "show", "season": 1, "episode": 1},
    )
    assert response.status_code == 200, response.text
    assert _balance(client.user_id) < before
    rows = _usage_rows("local_show")
    assert rows and rows[0][0] == client.user_id and rows[0][1] == 1


def test_local_video_charges_logged_in_user(client, monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(llm, "_generate_openai_compatible", _fake_provider(calls))
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)

    async def _no_analysis(*_args, **_kwargs):
        return None

    monkeypatch.setattr(teaching_analysis, "ensure_analysis", _no_analysis)

    before = _balance(client.user_id)
    response = client.post(
        "/api/local-video/process",
        json={
            "blocks": [
                {"id": 1, "start": 0.0, "end": 1.0, "en": "Hello world."}
            ]
        },
    )
    assert response.status_code == 200, response.text
    assert _balance(client.user_id) < before
    rows = _usage_rows("translate")
    assert rows and rows[0][0] == client.user_id and rows[0][1] == 1


# ---------------------------------------------------------------------------
# 5. 配额错误码稳定；严格模式默认开
# ---------------------------------------------------------------------------

def test_daily_quota_returns_code_quota_exceeded(client, monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(llm, "_generate_openai_compatible", _fake_provider(calls))
    monkeypatch.setattr(config, "AI_DAILY_QUOTA_DEFINE", 1, raising=False)
    monkeypatch.setattr(config, "AI_DAILY_BUDGET_USER_USD", 0, raising=False)
    monkeypatch.setattr(config, "AI_DAILY_BUDGET_GLOBAL_USD", 0, raising=False)

    first = client.post("/api/define", json={"word": "quotafirst"})
    assert first.status_code == 200, first.text
    second = client.post("/api/define", json={"word": "quotasecond"})
    assert second.status_code == 429, second.text
    body = second.json()
    assert body["code"] == "quota_exceeded"
    assert body["feature"] == "define"
    assert "额度" in body["detail"]
    assert len(calls) == 1, "超限后不得再调用模型"


def test_billing_strict_is_on_by_default():
    assert config.BILLING_STRICT is True
