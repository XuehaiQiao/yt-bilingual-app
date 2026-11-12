"""后端离线冒烟测试：应用能装配、核心接口能跑通、缓存与降级判断正确。

运行：cd backend && ./venv/bin/python -m pytest tests -q
所有外部依赖（Gemini / DeepSeek / YouTube / yt-dlp）都在 tests/conftest.py 里
被 monkeypatch 掉，不需要网络、不花 API 额度、不碰真实 history/ 目录。
"""
import json
from types import SimpleNamespace

import pytest

import config
import llm
import routes_user
import routes_videos
import translate

URL = "https://www.youtube.com/watch?v=abc123xyz"
VIDEO_ID = "abc123xyz"

# 两条各自成句的字幕片段：group_transcript_blocks 会正好切成 2 个 block
TRANSCRIPT = [
    SimpleNamespace(text="Hello world.", start=0.0, duration=1.0),
    SimpleNamespace(text="Learning English is fun.", start=2.0, duration=1.0),
]
METADATA = {
    "title": "Test Video",
    "channel": "Test Channel",
    "upload_date": "20240101",
    "thumbnail": "https://example.invalid/thumb.jpg",
}

DICT_PAYLOAD = {
    "word": "serendipity",
    "lemma": "serendipity",
    "ipa": "/ˌserənˈdɪpəti/",
    "pos": "n.",
    "zh": "意外发现美好事物的运气",
    "definition_en": "The luck of finding something good without looking for it.",
    "example": "It was pure serendipity that we met.",
}

TRANSLATION_PAYLOAD = {
    "blocks": [
        {"id": 1, "zh_text": "你好，世界。", "highlights": []},
        {
            "id": 2,
            "zh_text": "学英语很有趣。",
            "highlights": [
                {
                    "en_word": "fun",
                    "zh_word": "有趣",
                    "color": "text-purple-400 border-b border-dashed border-purple-400",
                }
            ],
        },
    ]
}


def test_health_returns_ok(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_estimate_cost_returns_full_model_catalog(client, monkeypatch):
    monkeypatch.setattr(
        routes_videos, "fetch_english_transcript", lambda video_id: list(TRANSCRIPT)
    )
    monkeypatch.setattr(routes_videos, "get_video_metadata", lambda url: dict(METADATA))

    response = client.get("/api/estimate-cost", params={"url": URL})
    assert response.status_code == 200

    data = response.json()
    assert data["videoId"] == VIDEO_ID
    assert data["metadata"]["title"] == "Test Video"
    # "Hello world." (2) + "Learning English is fun." (4) = 6 words
    assert data["transcriptStats"]["wordCount"] == 6

    models = data["models"]
    assert isinstance(models, list)
    assert models, "模型目录不应为空"

    ids = {model["id"] for model in models}
    assert "gemini-2.5-flash" in ids
    assert "deepseek-chat" in ids
    assert ids == set(config.MODEL_CATALOG), "所有目录内模型都应曝光给前端"

    for model in models:
        assert "id" in model
        assert "available" in model
        assert isinstance(model["available"], bool)
        assert "estimatedCost" in model

    by_id = {model["id"]: model for model in models}
    # conftest 里注入了测试 Key，两个 provider 都应显示可用
    assert by_id["gemini-2.5-flash"]["available"] is True
    assert by_id["deepseek-chat"]["available"] is True


def test_define_calls_llm_once_then_hits_cache(client, history_dir, monkeypatch):
    calls = []

    def fake_generate_json(prompt, model=None):
        calls.append({"prompt": prompt, "model": model})
        return json.dumps(DICT_PAYLOAD, ensure_ascii=False)

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)
    # 不依赖本机 Key 决定候选模型，固定走一个
    monkeypatch.setattr(routes_user, "_dict_model_candidates", lambda: ["gemini-2.5-flash"])

    first = client.post(
        "/api/define",
        json={"word": "Serendipity", "context": "It was pure serendipity that we met."},
    )
    assert first.status_code == 200
    assert first.json()["zh"] == DICT_PAYLOAD["zh"]
    assert "Serendipity" in calls[0]["prompt"]
    assert len(calls) == 1

    cache_file = history_dir / "dictionary_cache.json"
    assert cache_file.exists(), "首次查词应写入 dictionary_cache.json"
    cached = json.loads(cache_file.read_text(encoding="utf-8"))
    assert "serendipity" in cached
    assert cached["serendipity"]["zh"] == DICT_PAYLOAD["zh"]

    # 同词（大小写不同）再查：直接命中缓存，不再调 LLM
    second = client.post("/api/define", json={"word": "serendipity"})
    assert second.status_code == 200
    assert second.json() == first.json()
    assert len(calls) == 1, "第二次查词不应再调用 llm.generate_json"


def test_process_video_non_streaming(client, history_dir, monkeypatch):
    monkeypatch.setattr(
        routes_videos, "fetch_english_transcript", lambda video_id: list(TRANSCRIPT)
    )
    monkeypatch.setattr(routes_videos, "get_video_metadata", lambda url: dict(METADATA))
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)  # 别真睡 4 秒

    json_calls = []

    def fake_generate_json(prompt, model=None):
        json_calls.append(model)
        return json.dumps(TRANSLATION_PAYLOAD, ensure_ascii=False)

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)
    monkeypatch.setattr(
        llm, "generate_text", lambda prompt, model=None: "这是一段测试总结。"
    )

    response = client.post(
        "/api/process-video", json={"url": URL, "model": "deepseek-chat"}
    )
    assert response.status_code == 200

    data = response.json()
    assert data["videoId"] == VIDEO_ID
    assert len(data["transcript"]) == 2
    assert [block["en_text"] for block in data["transcript"]] == [
        "Hello world.",
        "Learning English is fun.",
    ]
    assert [block["zh_text"] for block in data["transcript"]] == [
        "你好，世界。",
        "学英语很有趣。",
    ]
    assert [block["id"] for block in data["transcript"]] == [1, 2]
    assert data["transcript"][1]["highlights"] == TRANSLATION_PAYLOAD["blocks"][1]["highlights"]
    assert data["summary"] == "这是一段测试总结。"
    assert json_calls == ["deepseek-chat"], "应按请求里选的模型调用"

    # 结果落盘到隔离后的 HISTORY_DIR
    files = list(history_dir.glob("*.json"))
    assert len(files) == 1
    saved = json.loads(files[0].read_text(encoding="utf-8"))
    assert saved["videoId"] == VIDEO_ID
    assert len(saved["transcript"]) == 2
    assert saved["summary"] == "这是一段测试总结。"

    # 同 URL 再请求：命中历史缓存，不应再产生 LLM 调用
    again = client.post(
        "/api/process-video", json={"url": URL, "model": "deepseek-chat"}
    )
    assert again.status_code == 200
    assert again.json()["transcript"] == data["transcript"]
    assert len(json_calls) == 1, "命中缓存后不应再调用 LLM"


@pytest.mark.parametrize(
    ("summary", "expected"),
    [
        ("", True),
        (None, True),
        ("   \n\t ", True),
        (translate.SUMMARY_ERROR_TEXT, True),
        ("- 核心观点一\n- 核心观点二", False),
    ],
)
def test_summary_needs_refresh(summary, expected):
    assert translate.summary_needs_refresh(summary) is expected

# ---------------------------------------------------------------------------
# History list: model badge / study count / delete endpoint
# ---------------------------------------------------------------------------

def _write_history(tmp_path, filename, *, model="deepseek-chat", study_count=3):
    payload = {
        "videoId": "abc123xyz",
        "metadata": {"title": "Cached Video", "channel": "Chan", "upload_date": "20240101", "thumbnail": ""},
        "transcript": [
            {"id": 1, "start": 0.0, "end": 1.0, "en_text": "Hello world.", "zh_text": "你好，世界。", "highlights": []},
        ],
        "summary": "- 总结",
        "model": model,
        "studyCount": study_count,
    }
    path = tmp_path / filename
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


def test_list_history_reports_model_and_study_count(client, history_dir):
    _write_history(history_dir, "Video_20240101_abc123xyz.json", model="deepseek-chat", study_count=3)
    # Non-video metadata files must never show up as history cards
    (history_dir / "dictionary_cache.json").write_text("{}", encoding="utf-8")

    resp = client.get("/api/history")
    assert resp.status_code == 200
    items = resp.json()
    assert [i["filename"] for i in items] == ["Video_20240101_abc123xyz.json"]
    assert items[0]["model"] == "deepseek-chat"
    assert items[0]["modelName"] == "DeepSeek Chat"
    assert items[0]["studyCount"] == 3


def test_get_history_bumps_study_count(client, history_dir):
    path = _write_history(history_dir, "Video_20240101_abc123xyz.json", study_count=0)

    resp = client.get("/api/history/Video_20240101_abc123xyz.json")
    assert resp.status_code == 200
    assert resp.json()["studyCount"] == 1

    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["studyCount"] == 1, "counter must be persisted, not just returned"


def test_delete_history_removes_file_and_guards_metadata(client, history_dir):
    path = _write_history(history_dir, "Video_20240101_abc123xyz.json")
    (history_dir / "dictionary_cache.json").write_text("{}", encoding="utf-8")

    assert client.delete("/api/history/Video_20240101_abc123xyz.json").status_code == 200
    assert not path.exists()
    assert client.delete("/api/history/Video_20240101_abc123xyz.json").status_code == 404
    assert client.delete("/api/history/dictionary_cache.json").status_code == 400
    assert client.delete("/api/history/..%2Ffavorites.json").status_code == 404
