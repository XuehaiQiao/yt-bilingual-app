"""全局模型选择（后端）契约（全离线）。

覆盖：
- `GET /api/models` 暴露完整 `MODEL_CATALOG`、可用标志与默认模型；
- `/api/define` 优先用请求指定的模型，不可用/非法时安全回落到候选链，
  且候选去重、缓存仍按小写词共享（与模型无关）；
- `/api/process-subtitle` 的翻译批次与缓存自愈都使用请求指定的模型，
  非法/缺省时回落到默认模型。

所有大模型调用都被 monkeypatch，SRT 与 HISTORY_DIR 都指向 tmp_path，
不联网、不碰真实 history/ 或 subtitles/。
"""
import json
import types

import pytest

import config
import llm
import routes_content
import routes_user

DICT_PAYLOAD = {
    "word": "serendipity",
    "lemma": "serendipity",
    "ipa": "/ˌserənˈdɪpəti/",
    "pos": "n.",
    "zh": "意外发现美好事物的运气",
    "definition_en": "The luck of finding something good without looking for it.",
    "example": "It was pure serendipity that we met.",
}

SRT_TEXT = """1
00:00:00,000 --> 00:00:01,500
Hello there.

2
00:00:02,000 --> 00:00:03,500
Learning English is fun.
"""


# ---------------------------------------------------------------------------
# GET /api/models
# ---------------------------------------------------------------------------

def test_models_endpoint_exposes_catalog_and_availability(client, monkeypatch):
    response = client.get("/api/models")
    assert response.status_code == 200

    data = response.json()
    assert data["default"] == config.DEFAULT_MODEL
    assert [m["id"] for m in data["models"]] == list(config.MODEL_CATALOG)

    by_id = {m["id"]: m for m in data["models"]}
    assert set(by_id) == set(config.MODEL_CATALOG)
    for model_id, spec in config.MODEL_CATALOG.items():
        item = by_id[model_id]
        assert set(item) == {"id", "name", "provider", "available", "quotaInfo"}
        assert item["name"] == spec["name"]
        assert item["provider"] == spec["provider"]
        assert isinstance(item["available"], bool)
        # conftest 注入了两把测试 Key，全部模型都应可用
        assert item["available"] is True
        assert item["quotaInfo"] == spec["quotaInfo"]

    # 缺 Key 时不可用，并直接提示缺哪个环境变量
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    by_id = {m["id"]: m for m in client.get("/api/models").json()["models"]}
    assert by_id["deepseek-chat"]["available"] is False
    assert "DEEPSEEK_API_KEY" in by_id["deepseek-chat"]["quotaInfo"]
    assert by_id["gemini-2.5-flash"]["available"] is True


# ---------------------------------------------------------------------------
# POST /api/define 的 model 语义
# ---------------------------------------------------------------------------

def _fake_generate_json(monkeypatch, calls, *, fail_models=()):
    def fake(prompt, model=None):
        calls.append(model)
        if model in fail_models:
            raise RuntimeError(f"{model} failed in test")
        return json.dumps(DICT_PAYLOAD, ensure_ascii=False)

    monkeypatch.setattr(llm, "generate_json", fake)


def test_define_prefers_requested_model(client, monkeypatch):
    calls = []
    _fake_generate_json(monkeypatch, calls)
    monkeypatch.setattr(
        routes_user, "_dict_model_candidates", lambda: ["gemini-2.5-flash", "deepseek-chat"]
    )

    response = client.post(
        "/api/define", json={"word": "globemodel", "model": "deepseek-chat"}
    )

    assert response.status_code == 200
    assert calls == ["deepseek-chat"], "请求指定的可用模型必须排第一且只调用一次"


def test_define_dedupes_requested_model_and_falls_back(client, monkeypatch):
    calls = []
    _fake_generate_json(monkeypatch, calls, fail_models={"deepseek-chat"})
    monkeypatch.setattr(
        routes_user, "_dict_model_candidates", lambda: ["gemini-2.5-flash", "deepseek-chat"]
    )

    response = client.post(
        "/api/define", json={"word": "dedupword", "model": "deepseek-chat"}
    )

    assert response.status_code == 200
    # 请求模型失败后继续候选链，但不会在同一轮里重复尝试它
    assert calls == ["deepseek-chat", "gemini-2.5-flash"]


def test_define_falls_back_when_requested_model_has_no_key(client, monkeypatch):
    calls = []
    _fake_generate_json(monkeypatch, calls)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.setattr(routes_user, "_dict_model_candidates", lambda: ["gemini-2.5-flash"])

    response = client.post(
        "/api/define", json={"word": "nokeyword", "model": "deepseek-chat"}
    )

    assert response.status_code == 200, "传了没 Key 的模型不应 502"
    assert calls == ["gemini-2.5-flash"], "应跳过不可用模型，沿用原候选链"


def test_define_invalid_model_falls_back_to_candidate_chain(client, monkeypatch):
    calls = []
    _fake_generate_json(monkeypatch, calls)
    monkeypatch.setattr(
        routes_user, "_dict_model_candidates", lambda: ["deepseek-chat", "gemini-2.5-flash"]
    )

    response = client.post(
        "/api/define", json={"word": "bogusmodel", "model": "not-a-real-model"}
    )

    assert response.status_code == 200, "非法模型名不应 500/502"
    # 不存在的模型不参与排序：直接沿用候选链首位，而不是被 resolve_model
    # 映射成默认模型后挤到最前。
    assert calls == ["deepseek-chat"]


def test_define_cache_is_shared_across_models(client, history_dir, monkeypatch):
    calls = []
    _fake_generate_json(monkeypatch, calls)
    monkeypatch.setattr(
        routes_user, "_dict_model_candidates", lambda: ["gemini-2.5-flash", "deepseek-chat"]
    )

    first = client.post("/api/define", json={"word": "SharedWord", "model": "deepseek-chat"})
    second = client.post("/api/define", json={"word": "sharedword", "model": "gemini-2.5-flash"})

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert calls == ["deepseek-chat"], "缓存按小写词命中，不因换模型重新生成"
    cached = json.loads(
        (history_dir / "dictionary_cache.json").read_text(encoding="utf-8")
    )
    assert "sharedword" in cached


# ---------------------------------------------------------------------------
# POST /api/process-subtitle 的 model 语义
# ---------------------------------------------------------------------------

@pytest.fixture()
def show_srt(tmp_path, monkeypatch):
    """在 tmp_path 下造一部只有一集的小剧集，并隔离 SUBTITLES_DIR。"""
    season_dir = tmp_path / "subtitles" / "demo-show" / "S01"
    season_dir.mkdir(parents=True)
    (season_dir / "E01.srt").write_text(SRT_TEXT, encoding="utf-8")
    monkeypatch.setattr(routes_content, "SUBTITLES_DIR", str(tmp_path / "subtitles"))
    return season_dir


@pytest.fixture()
def no_sleep(monkeypatch):
    """批次间的限流停顿换成空实现，测试不必真等 6 秒。"""

    async def _noop(*args, **kwargs):
        return None

    # 只替换 routes_content 这个模块里的名字，不动全局 asyncio 模块
    monkeypatch.setattr(routes_content, "asyncio", types.SimpleNamespace(sleep=_noop))


@pytest.fixture()
def batch_calls(monkeypatch):
    calls = []

    async def fake_process_llm_batch(blocks, model=config.DEFAULT_MODEL, vocab_level=None):
        calls.append({"model": model, "ids": [b.get("id") for b in blocks]})
        return [
            {
                "id": b.get("id"),
                "start": b["start"],
                "end": b["end"],
                "en_text": b["text"],
                "zh_text": f"译:{b['text']}",
                "highlights": [],
            }
            for b in blocks
        ]

    monkeypatch.setattr(routes_content, "process_llm_batch", fake_process_llm_batch)
    return calls


@pytest.mark.parametrize(
    ("requested", "expected"),
    [
        ("deepseek-chat", "deepseek-chat"),
        ("not-a-real-model", config.DEFAULT_MODEL),
        (None, config.DEFAULT_MODEL),
    ],
)
def test_process_subtitle_uses_requested_model(
    client, show_srt, history_dir, batch_calls, no_sleep, requested, expected
):
    body = {"show_id": "demo-show", "season": 1, "episode": 1}
    if requested is not None:
        body["model"] = requested

    response = client.post("/api/process-subtitle", json=body)

    assert response.status_code == 200, response.text
    data = response.json()
    assert len(data["transcript"]) >= 1
    assert batch_calls, "应调用翻译批次"
    assert {call["model"] for call in batch_calls} == {expected}
    # 成功结果照旧落盘，供下次秒开/自愈
    assert (history_dir / "demo-show_S01E01.json").exists()


def test_process_subtitle_cached_repair_uses_requested_model(
    client, show_srt, history_dir, monkeypatch
):
    cache_path = history_dir / "demo-show_S01E01.json"
    cache_path.write_text(
        json.dumps(
            {
                "videoId": "demo-show-S01E01",
                "metadata": {"title": "Demo S01E01"},
                "transcript": [
                    {
                        "id": 1,
                        "start": 0.0,
                        "end": 1.5,
                        "en_text": "Hello there.",
                        "zh_text": "[未翻译]",
                        "highlights": [],
                    }
                ],
                "summary": "📺 示例 第1季 第1集",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    calls = []

    async def fake_retranslate(data, path, model=None):
        calls.append(model)
        return data

    monkeypatch.setattr(routes_content, "retranslate_marked_blocks", fake_retranslate)

    response = client.post(
        "/api/process-subtitle",
        json={"show_id": "demo-show", "season": 1, "episode": 1, "model": "deepseek-chat"},
    )

    assert response.status_code == 200
    assert calls == ["deepseek-chat"], "缓存补译必须用请求指定的模型"
