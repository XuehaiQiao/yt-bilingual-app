"""全局模型选择（后端）契约（全离线）。

覆盖：
- `GET /api/models` 暴露完整 `MODEL_CATALOG`、可用标志与默认模型
  （大陆首发商用默认 `deepseek-chat`；未配 `GEMINI_API_KEY` 时 Gemini 置灰）；
- `config.DEFAULT_MODEL` 默认 `deepseek-chat`，`DEFAULT_MODEL` 环境变量可覆盖，
  非法值回落默认，`resolve_model(None)` 与 `llm` 的缺省模型一致；
- `/api/define` 优先用请求指定的模型，不可用/非法时安全回落到候选链，
  且候选去重、缓存仍按小写词共享（与模型无关）；
- `/api/define` 缺省模型语义：没带 model（或空串）时候选链首位是
  `resolve_model(None)`（`DEFAULT_MODEL`），`DICT_MODEL` 只作后续候选；
  走 LLM 的响应带实际使用的 `model` / `modelName`，缓存命中不声称用了模型；
- `/api/process-subtitle` 的翻译批次与缓存自愈都使用请求指定的模型，
  非法/缺省时回落到默认模型；新处理结果与缓存 payload 记录 `model`，
  批次间隔按 provider 的 `llm.batch_pause(model)` 走。

所有大模型调用都被 monkeypatch，SRT 与 HISTORY_DIR 都指向 tmp_path，
不联网、不碰真实 history/ 或 subtitles/。
"""
import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

import config
import llm
import routes_content
import routes_user

BACKEND_DIR = Path(__file__).resolve().parents[1]

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
    assert data["default"] == "deepseek-chat", "大陆商用默认模型必须是 DeepSeek"
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


def test_models_endpoint_gemini_unavailable_without_key(client, monkeypatch):
    """大陆部署只配 DeepSeek：默认模型可用，Gemini 三档全部置灰。"""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    data = client.get("/api/models").json()
    assert data["default"] == "deepseek-chat"

    by_id = {m["id"]: m for m in data["models"]}
    for gemini_id in ("gemini-2.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"):
        assert by_id[gemini_id]["provider"] == "Google"
        assert by_id[gemini_id]["available"] is False
        assert "GEMINI_API_KEY" in by_id[gemini_id]["quotaInfo"]
    assert by_id["deepseek-chat"]["available"] is True


def test_default_model_is_deepseek_and_resolve_falls_back(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-deepseek-key")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    assert config.DEFAULT_MODEL == config.DEFAULT_MODEL_FALLBACK == "deepseek-chat"
    assert config.resolve_model(None) == "deepseek-chat"
    assert config.resolve_model("") == "deepseek-chat"
    assert config.resolve_model("not-a-real-model") == "deepseek-chat"
    assert config.resolve_model("gemini-2.5-flash") == "gemini-2.5-flash"


def test_llm_helpers_work_for_deepseek(monkeypatch):
    """`is_available` / `batch_pause` 对默认的 DeepSeek 必须有意义。"""
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-deepseek-key")
    assert llm.is_available(None) is True, "None 应解析到默认模型"
    assert llm.is_available("deepseek-chat") is True
    assert llm.batch_pause(None) == llm.batch_pause("deepseek-chat") == 1.0
    assert llm._spec(None)["provider"] == "DeepSeek"

    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    assert llm.is_available("deepseek-chat") is False


def _config_default_in_subprocess(monkeypatch, env_value):
    """在干净的子进程里 import config，验证「启动时」读取环境变量的行为。"""
    env = {k: v for k, v in os.environ.items() if k != "DEFAULT_MODEL"}
    if env_value is not None:
        env["DEFAULT_MODEL"] = env_value
    result = subprocess.run(
        [sys.executable, "-c", "import config; print('RESOLVED=' + config.DEFAULT_MODEL)"],
        cwd=str(BACKEND_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    resolved = [ln for ln in result.stdout.splitlines() if ln.startswith("RESOLVED=")]
    assert resolved, f"子进程没有输出默认模型: {result.stdout}{result.stderr}"
    return resolved[-1].split("=", 1)[1]


def test_default_model_env_override(monkeypatch):
    assert _config_default_in_subprocess(monkeypatch, "gemini-2.5-flash") == "gemini-2.5-flash"


@pytest.mark.parametrize("bad_value", [None, "", "not-a-real-model"])
def test_default_model_env_invalid_falls_back(monkeypatch, bad_value):
    assert _config_default_in_subprocess(monkeypatch, bad_value) == "deepseek-chat"


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
    # 首次是 LLM 生成，响应多出 model / modelName（透明度字段）；缓存命中
    # 不声称本次用了模型，因此只比较其余既有字段。
    assert {
        k: v for k, v in first.json().items() if k not in ("model", "modelName")
    } == second.json()
    assert "model" not in second.json(), "缓存命中不应声称本次用了模型"
    assert calls == ["deepseek-chat"], "缓存按小写词命中，不因换模型重新生成"
    cached = json.loads(
        (history_dir / "dictionary_cache.json").read_text(encoding="utf-8")
    )
    assert "sharedword" in cached
    assert "model" not in cached["sharedword"], "模型透明度字段只进响应、不写缓存"


# ---------------------------------------------------------------------------
# /api/define 的缺省模型语义（P1）：没带 model → 候选链首位 = DEFAULT_MODEL
# ---------------------------------------------------------------------------

def test_define_default_candidate_chain_starts_with_default_model():
    candidates = routes_user._dict_model_candidates()

    assert candidates[0] == config.resolve_model(None) == config.DEFAULT_MODEL
    assert routes_user.DICT_MODEL in candidates, "DICT_MODEL 仍作为后续候选保留"
    assert (
        routes_user.DICT_FALLBACK_MODEL == config.DEFAULT_MODEL
    ), "兜底模型必须引用 config.DEFAULT_MODEL，避免硬编码漂移"
    assert len(candidates) == len(set(candidates)), "候选链不能有重复模型"


def test_define_default_chain_skips_default_without_key(monkeypatch):
    """默认模型没配 Key 时跳过它，而不是让查词 502。"""
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    candidates = routes_user._dict_model_candidates()

    assert config.DEFAULT_MODEL not in candidates
    assert candidates[0] == routes_user.DICT_MODEL, "默认模型不可用时退到词典小模型"
    assert set(candidates) == set(config.MODEL_CATALOG) - {config.DEFAULT_MODEL}


@pytest.mark.parametrize("payload", [{}, {"model": ""}, {"model": None}])
def test_define_missing_or_empty_model_uses_default_model(client, monkeypatch, payload):
    calls = []
    _fake_generate_json(monkeypatch, calls)

    response = client.post("/api/define", json={"word": "defaultchain", **payload})

    assert response.status_code == 200, response.text
    assert calls[0] == config.resolve_model(None) == config.DEFAULT_MODEL
    data = response.json()
    assert data["model"] == config.DEFAULT_MODEL
    assert data["modelName"] == config.MODEL_CATALOG[config.DEFAULT_MODEL]["name"]


def test_define_with_model_uses_it_and_reports_it(client, monkeypatch):
    calls = []
    _fake_generate_json(monkeypatch, calls)

    response = client.post(
        "/api/define", json={"word": "withmodel", "model": "deepseek-chat"}
    )

    assert response.status_code == 200
    assert calls == ["deepseek-chat"], "请求指定的可用模型必须排第一"
    data = response.json()
    assert data["model"] == "deepseek-chat"
    assert data["modelName"] == config.MODEL_CATALOG["deepseek-chat"]["name"]


def test_define_reports_actual_model_after_fallback(client, monkeypatch):
    calls = []
    _fake_generate_json(monkeypatch, calls, fail_models={"gemini-2.5-flash"})

    response = client.post(
        "/api/define", json={"word": "fallbackmodel", "model": "gemini-2.5-flash"}
    )

    assert response.status_code == 200
    assert calls == ["gemini-2.5-flash", config.DEFAULT_MODEL]
    data = response.json()
    assert data["model"] == config.DEFAULT_MODEL, "降级后应报告实际成功的模型"
    assert data["modelName"] == config.MODEL_CATALOG[config.DEFAULT_MODEL]["name"]


def test_define_default_failure_falls_back_to_dict_model(client, monkeypatch):
    """默认模型失败时继续沿候选链走，`DICT_MODEL` 仍作为后续候选。"""
    calls = []
    _fake_generate_json(monkeypatch, calls, fail_models={config.DEFAULT_MODEL})

    response = client.post("/api/define", json={"word": "dictfallback"})

    assert response.status_code == 200
    assert calls[:2] == [config.DEFAULT_MODEL, routes_user.DICT_MODEL]
    assert response.json()["model"] == routes_user.DICT_MODEL


def test_define_cached_hit_does_not_claim_a_model(client, history_dir, monkeypatch):
    calls = []
    _fake_generate_json(monkeypatch, calls)

    first = client.post("/api/define", json={"word": "cachemodel"})
    second = client.post("/api/define", json={"word": "cachemodel"})

    assert first.status_code == second.status_code == 200
    assert first.json()["model"] == config.DEFAULT_MODEL
    assert "model" not in second.json(), "缓存命中不声称本次用了模型"
    assert "modelName" not in second.json()
    assert len(calls) == 1, "缓存命中不应再调用大模型"


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

    async def fake_process_llm_batch(blocks, model=config.DEFAULT_MODEL, vocab_level=None, **kwargs):
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
    # 新处理的返回结果与落盘 payload 都记录实际使用的模型（历史列表用）
    assert data["model"] == expected
    saved = json.loads(
        (history_dir / "demo-show_S01E01.json").read_text(encoding="utf-8")
    )
    assert saved["model"] == expected


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

    async def fake_retranslate(data, path, model=None, **kwargs):
        calls.append(model)
        return data

    monkeypatch.setattr(routes_content, "retranslate_marked_blocks", fake_retranslate)

    response = client.post(
        "/api/process-subtitle",
        json={"show_id": "demo-show", "season": 1, "episode": 1, "model": "deepseek-chat"},
    )

    assert response.status_code == 200
    assert calls == ["deepseek-chat"], "缓存补译必须用请求指定的模型"
    # 旧缓存原本没有 model：这次真的用它补译过，才补记本次模型
    assert response.json()["model"] == "deepseek-chat"


def test_process_subtitle_cache_hit_keeps_generation_model(
    client, show_srt, history_dir, batch_calls, no_sleep
):
    first = client.post(
        "/api/process-subtitle",
        json={"show_id": "demo-show", "season": 1, "episode": 1, "model": "deepseek-chat"},
    )
    assert first.status_code == 200
    assert first.json()["model"] == "deepseek-chat"
    batches_after_first = len(batch_calls)

    # 换一个模型再打开同一集：命中缓存，返回的仍是生成时记录的模型，
    # 不会被本次请求的模型覆盖（缓存里没有失败块，不触发补译）。
    second = client.post(
        "/api/process-subtitle",
        json={"show_id": "demo-show", "season": 1, "episode": 1, "model": "gemini-2.5-flash"},
    )

    assert second.status_code == 200
    assert second.json()["model"] == "deepseek-chat"
    assert len(batch_calls) == batches_after_first, "缓存命中不应再调用翻译批次"


def test_process_subtitle_old_cache_without_model_is_not_invented(
    client, show_srt, history_dir, batch_calls, no_sleep
):
    # 旧缓存（本字段出现之前生成）没有 model，且没有失败块可补译：
    # 不臆测当时用的模型，也不把本次请求的模型写进去。
    (history_dir / "demo-show_S01E01.json").write_text(
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
                        "zh_text": "你好。",
                        "highlights": [],
                    }
                ],
                "summary": "📺 示例 第1季 第1集",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    response = client.post(
        "/api/process-subtitle",
        json={"show_id": "demo-show", "season": 1, "episode": 1, "model": "deepseek-chat"},
    )

    assert response.status_code == 200
    assert "model" not in response.json()
    assert batch_calls == []


def test_process_subtitle_batch_pause_follows_provider(
    client, show_srt, history_dir, batch_calls, monkeypatch
):
    sleeps = []
    pause_calls = []
    real_batch_pause = llm.batch_pause

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    def recording_batch_pause(model=None):
        pause_calls.append(model)
        return real_batch_pause(model)

    monkeypatch.setattr(routes_content, "asyncio", types.SimpleNamespace(sleep=fake_sleep))
    monkeypatch.setattr(llm, "batch_pause", recording_batch_pause)

    response = client.post(
        "/api/process-subtitle",
        json={"show_id": "demo-show", "season": 1, "episode": 1, "model": "deepseek-chat"},
    )

    assert response.status_code == 200
    assert pause_calls == ["deepseek-chat"], "批间隔必须按本次使用的模型取"
    assert sleeps == [llm.batch_pause("deepseek-chat")] == [1.0], (
        "DeepSeek 走自己的 1s 节奏，而不是写死的 6s"
    )
    assert 6 not in sleeps
