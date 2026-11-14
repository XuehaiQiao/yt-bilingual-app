"""目标语言（``targetLang``）后端 P0 的离线验收（specs/012-i18n-multilingual）。

覆盖：

1. ``languages``：缺省 zh-CN、别名归一、非法抛错、NFC、展示名、本地词典开关；
2. 非法 ``targetLang`` → HTTP 400（估价/处理/流式/本地剧集/词典/历史/模型）；
3. 默认行为不变：不带参数 = zh-CN，仍写 ``history/`` 根目录、仍走中文 prompt；
4. 越南语请求：缓存落 ``history/vi-VN/``、payload 带 ``target_lang``、prompt 用
   Vietnamese、与中文缓存互不命中；
5. SSE ``meta``/``batch``/``summary``/``done`` 事件带 ``targetLang``；
6. 词典：vi 跳过 ECDICT 直接 LLM、缓存按语言隔离；zh 本地命中仍 ``source=local``；
7. 模型路线：zh 默认 deepseek-chat；vi 按 Key 自动跳过 gemini/qwen；
8. 账本/配额记录 ``target_lang`` 且不拆限额；
9. ``0004_target_lang`` 迁移：旧库补列、旧数据读出 zh-CN、downgrade 可回滚；
10. 越南语输出校验：JSON 按 id 对齐、高亮子串过滤、CJK 泄漏重试后标未翻译；
11. 历史列表/读取/删除按语言目录隔离。

全部离线：外部调用与 LLM 全部 monkeypatch，目录/数据库都在 tmp_path。
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import unicodedata
from pathlib import Path
from types import SimpleNamespace

import pytest

import config
import languages
import llm
import local_dict
import routes_content
import routes_user
import routes_videos
import translate
from ai import ledger, quota
from tests.migration_utils import assert_alembic_ok, columns, run_alembic

URL = "https://www.youtube.com/watch?v=vitest12345"
VIDEO_ID = "vitest12345"

# group_transcript_blocks 会切成 2 个 block
TRANSCRIPT = [
    SimpleNamespace(text="Hello world.", start=0.0, duration=1.0),
    SimpleNamespace(text="Learning English is fun.", start=2.0, duration=1.0),
]
METADATA = {
    "title": "Vi Test Video",
    "channel": "Test Channel",
    "upload_date": "20240101",
    "thumbnail": "",
}

VI_TRANSLATION = {
    "blocks": [
        {"id": 1, "zh_text": "Xin chào thế giới.", "highlights": []},
        {
            "id": 2,
            "zh_text": "Học tiếng Anh rất vui.",
            "highlights": [{"en_word": "fun", "zh_word": "vui"}],
        },
    ]
}
ZH_TRANSLATION = {
    "blocks": [
        {"id": 1, "zh_text": "你好，世界。", "highlights": []},
        {"id": 2, "zh_text": "学英语很有趣。", "highlights": []},
    ]
}
VI_DICT = {
    "word": "hello",
    "lemma": "hello",
    "ipa": "/həˈləʊ/",
    "pos": "interj.",
    "pos_label": "thán từ",
    "zh": "xin chào",
    "definition_en": "used as a greeting",
    "example": "Hello, how are you?",
    "example_translation": "Xin chào, bạn khỏe không?",
}

SRT_TEXT = """1
00:00:00,000 --> 00:00:01,500
Hello there.

2
00:00:02,000 --> 00:00:03,500
Learning English is fun.
"""

LOCAL_DICT_SCHEMA = """
CREATE TABLE stardict (
    word TEXT NOT NULL, sw TEXT NOT NULL, phonetic TEXT,
    definition TEXT, translation TEXT, exchange TEXT
);
CREATE INDEX idx_stardict_sw ON stardict(sw);
"""


# ---------------------------------------------------------------------------
# 公共夹具 / 桩
# ---------------------------------------------------------------------------

@pytest.fixture()
def local_db(tmp_path, monkeypatch):
    """一个小型 ECDICT：hello 命中，用于验证「vi 不走本地词典」。"""
    path = tmp_path / "ecdict.db"
    conn = sqlite3.connect(str(path))
    conn.executescript(LOCAL_DICT_SCHEMA)
    conn.execute(
        "INSERT INTO stardict VALUES (?, ?, ?, ?, ?, ?)",
        ("hello", "hello", "həˈləʊ", "n. an expression of greeting",
         "interj. 喂, 嘿", ""),
    )
    conn.commit()
    conn.close()
    monkeypatch.setenv("LOCAL_DICT_PATH", str(path))
    local_dict.reset()
    yield path
    local_dict.reset()


def _install_video_fakes(monkeypatch):
    """字幕/元数据/LLM 桩：按 prompt 里的语言返回中文或越南语，记录所有 prompt。"""
    prompts: list[str] = []

    def fake_fetch(_video_id):
        return list(TRANSCRIPT)

    def fake_metadata(_url):
        return dict(METADATA)

    def fake_generate_json(prompt, model=None):
        prompts.append(prompt)
        payload = VI_TRANSLATION if "Vietnamese" in prompt else ZH_TRANSLATION
        return json.dumps(payload, ensure_ascii=False)

    def fake_generate_text(prompt, model=None):
        prompts.append(prompt)
        return "Tóm tắt tiếng Việt." if "Vietnamese" in prompt else "中文总结。"

    monkeypatch.setattr(routes_videos, "fetch_english_transcript", fake_fetch)
    monkeypatch.setattr(routes_videos, "get_video_metadata", fake_metadata)
    monkeypatch.setattr(llm, "generate_json", fake_generate_json)
    monkeypatch.setattr(llm, "generate_text", fake_generate_text)
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)
    return prompts


@pytest.fixture()
def demo_srt(tmp_path, monkeypatch):
    season_dir = tmp_path / "subtitles" / "demo-show" / "S01"
    season_dir.mkdir(parents=True)
    (season_dir / "E01.srt").write_text(SRT_TEXT, encoding="utf-8")
    monkeypatch.setattr(routes_content, "SUBTITLES_DIR", str(tmp_path / "subtitles"))
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)
    return season_dir


@pytest.fixture()
def ledger_db(tmp_path, monkeypatch):
    db = tmp_path / "i18n-ledger.db"
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(db), raising=False)
    monkeypatch.setattr(config, "AI_QUOTA_TIMEZONE", "Asia/Shanghai", raising=False)
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    return db


# ---------------------------------------------------------------------------
# 1. languages 注册表
# ---------------------------------------------------------------------------

def test_languages_registry_defaults_and_validation():
    assert languages.DEFAULT_TARGET_LANG == "zh-CN"
    assert languages.resolve_target_lang(None) == "zh-CN"
    assert languages.resolve_target_lang("") == "zh-CN"
    assert languages.resolve_target_lang("  ") == "zh-CN"
    # 别名/大小写归一
    assert languages.resolve_target_lang("vi") == "vi-VN"
    assert languages.resolve_target_lang("VI-vn") == "vi-VN"
    assert languages.resolve_target_lang("zh") == "zh-CN"
    # 非法 → 抛错（路由层转 400）
    with pytest.raises(languages.UnsupportedLanguage):
        languages.resolve_target_lang("xx-XX")
    assert languages.normalize_code("xx-XX") is None
    assert languages.supported_target_langs()[0] == "zh-CN"
    assert set(languages.supported_target_langs()) == {"zh-CN", "vi-VN"}


def test_languages_nfc_display_and_dictionary_policy():
    decomposed = unicodedata.normalize("NFD", "Tiếng Việt")
    assert decomposed != "Tiếng Việt"
    assert languages.normalize(decomposed) == "Tiếng Việt"

    assert languages.language_display_name("vi-VN", "zh-CN") == "越南语"
    assert languages.language_display_name("vi-VN", "vi-VN") == "Tiếng Việt"
    assert languages.language_display_name("zh-CN", "vi-VN") == "Tiếng Trung (Giản thể)"
    assert languages.prompt_name("vi-VN") == "Vietnamese"
    assert languages.prompt_name(None) == "Simplified Chinese"

    assert languages.uses_local_dictionary("zh-CN") is True
    assert languages.uses_local_dictionary("vi-VN") is False
    payload = languages.supported_languages()
    assert {item["code"] for item in payload} == {"zh-CN", "vi-VN"}


# ---------------------------------------------------------------------------
# 2. 非法 targetLang → 400
# ---------------------------------------------------------------------------

def test_invalid_target_lang_returns_400(client, monkeypatch):
    _install_video_fakes(monkeypatch)
    bad = {"targetLang": "xx-XX"}

    cases = [
        ("post", "/api/process-video", {"url": URL, **bad}),
        ("post", "/api/process-video-stream", {"url": URL, **bad}),
        ("post", "/api/process-subtitle",
         {"show_id": "demo-show", "season": 1, "episode": 1, **bad}),
        ("post", "/api/define", {"word": "hello", **bad}),
    ]
    for method, path, body in cases:
        response = getattr(client, method)(path, json=body)
        assert response.status_code == 400, (path, response.text)
        assert "不支持的语言代码" in response.json()["detail"]

    assert client.get("/api/estimate-cost", params={"url": URL, **bad}).status_code == 400
    assert client.get("/api/models", params=bad).status_code == 400
    assert client.get("/api/history", params=bad).status_code == 400
    assert client.get("/api/shows/demo-show/processed", params=bad).status_code == 400


# ---------------------------------------------------------------------------
# 3/4. 默认中文不变 + 越南语缓存隔离
# ---------------------------------------------------------------------------

def test_default_target_lang_keeps_chinese_behavior(client, history_dir, monkeypatch):
    prompts = _install_video_fakes(monkeypatch)

    response = client.post("/api/process-video", json={"url": URL})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["target_lang"] == "zh-CN"
    assert data["source_lang"] == "en"
    assert data["transcript"][0]["zh_text"] == "你好，世界。"
    assert data["summary"] == "中文总结。"

    # 根目录（zh-CN 兼容位）有缓存；不产生 vi-VN 目录里的文件
    root_files = [p for p in history_dir.glob("*.json")]
    assert len(root_files) == 1
    assert root_files[0].name.endswith(f"_{VIDEO_ID}.json")
    saved = json.loads(root_files[0].read_text(encoding="utf-8"))
    assert saved["target_lang"] == "zh-CN"
    assert not (history_dir / "vi-VN").exists()

    assert any("Chinese" in p for p in prompts)
    assert not any("Vietnamese" in p for p in prompts)


def test_vi_target_lang_uses_vi_cache_and_prompts(client, history_dir, monkeypatch):
    prompts = _install_video_fakes(monkeypatch)

    response = client.post(
        "/api/process-video", json={"url": URL, "targetLang": "vi-VN"}
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["target_lang"] == "vi-VN"
    assert data["transcript"][1]["zh_text"] == "Học tiếng Anh rất vui."
    # 高亮：en_word 是英文子串、zh_word 是越南语译文子串
    assert data["transcript"][1]["highlights"][0]["zh_word"] == "vui"
    assert data["summary"] == "Tóm tắt tiếng Việt."

    # prompt 参数化：翻译/总结都要求 Vietnamese
    assert any("English-Vietnamese teacher" in p for p in prompts)
    assert any("summary in Vietnamese" in p for p in prompts)
    assert not any("Chinese" in p and "Vietnamese" not in p for p in prompts)

    # vi-VN 子目录有缓存；根目录没有越南语文件
    vi_dir = history_dir / "vi-VN"
    vi_files = list(vi_dir.glob("*.json"))
    assert len(vi_files) == 1
    assert json.loads(vi_files[0].read_text(encoding="utf-8"))["target_lang"] == "vi-VN"
    assert list(history_dir.glob("*.json")) == []

    # 同语言第二次 → 命中 vi 缓存，不再调用模型
    calls_before = len(prompts)
    again = client.post("/api/process-video", json={"url": URL, "targetLang": "vi-VN"})
    assert again.status_code == 200
    assert again.json()["transcript"] == data["transcript"]
    assert len(prompts) == calls_before, "越南语缓存命中不应重新调用模型"

    # 中文请求不能命中越南语缓存（会重新调用模型并写根目录）
    zh = client.post("/api/process-video", json={"url": URL})
    assert zh.status_code == 200
    assert zh.json()["transcript"][0]["zh_text"] == "你好，世界。"
    assert len(prompts) > calls_before
    assert len(list(history_dir.glob("*.json"))) == 1


def test_estimate_cost_and_models_accept_target_lang(client, monkeypatch):
    monkeypatch.setattr(
        routes_videos, "fetch_english_transcript", lambda video_id: list(TRANSCRIPT)
    )
    monkeypatch.setattr(routes_videos, "get_video_metadata", lambda url: dict(METADATA))

    estimate = client.get(
        "/api/estimate-cost", params={"url": URL, "targetLang": "vi-VN"}
    )
    assert estimate.status_code == 200
    data = estimate.json()
    assert data["targetLang"] == "vi-VN"
    assert data["recommendedModel"] == "deepseek-chat"

    models = client.get("/api/models", params={"targetLang": "vi-VN"}).json()
    assert models["targetLang"] == "vi-VN"
    assert models["default"] == "deepseek-chat"
    assert models["recommended"] == [
        "deepseek-chat", "qwen-plus", "gemini-2.5-flash",
    ]

    zh_models = client.get("/api/models").json()
    assert zh_models["targetLang"] == "zh-CN"
    assert zh_models["default"] == config.DEFAULT_MODEL == "deepseek-chat"


# ---------------------------------------------------------------------------
# 5. SSE 事件带 targetLang
# ---------------------------------------------------------------------------

def test_sse_events_carry_target_lang(client, monkeypatch):
    _install_video_fakes(monkeypatch)

    with client.stream(
        "POST",
        "/api/process-video-stream",
        json={"url": URL, "targetLang": "vi-VN"},
    ) as response:
        assert response.status_code == 200
        lines = list(response.iter_lines())

    events = []
    current = None
    for line in lines:
        if line.startswith("event: "):
            current = line.split(": ", 1)[1]
        elif line.startswith("data: ") and current:
            events.append((current, json.loads(line[len("data: "):])))
            current = None

    names = [name for name, _ in events]
    assert names == ["meta", "batch", "stage", "summary", "done"]
    for name, payload in events:
        assert payload.get("targetLang") == "vi-VN", name
    meta = dict(events)["meta"]
    assert meta["sourceLang"] == "en"
    assert meta["promptVersion"] == translate.PROMPT_VERSIONS["translate"]
    assert dict(events)["summary"]["summary"] == "Tóm tắt tiếng Việt."


# ---------------------------------------------------------------------------
# 6. 词典：vi 跳过 ECDICT；缓存按语言隔离
# ---------------------------------------------------------------------------

def test_define_vi_skips_local_dict_and_isolates_cache(
    client, history_dir, local_db, monkeypatch
):
    calls = []

    def fake_generate_json(prompt, model=None):
        calls.append(prompt)
        return json.dumps(VI_DICT, ensure_ascii=False)

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)

    response = client.post(
        "/api/define", json={"word": "hello", "targetLang": "vi-VN"}
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["targetLang"] == "vi-VN"
    assert data["zh"] == "xin chào"
    assert data["pos_label"] == "thán từ"
    assert data["example_translation"] == "Xin chào, bạn khỏe không?"
    assert "source" not in data, "越南语不应命中 ECDICT"
    assert "Vietnamese" in calls[0]
    assert len(calls) == 1

    vi_cache = history_dir / "vi-VN" / "dictionary_cache.json"
    assert vi_cache.exists()
    cached = json.loads(vi_cache.read_text(encoding="utf-8"))
    assert cached["hello"]["target_lang"] == "vi-VN"
    assert cached["hello"]["zh"] == "xin chào"
    assert not (history_dir / "dictionary_cache.json").exists(), (
        "vi 词条不能写进中文缓存文件"
    )

    # 同语言重复查询 → 命中缓存，不再调用模型
    again = client.post("/api/define", json={"word": "hello", "targetLang": "vi-VN"})
    assert again.status_code == 200
    assert again.json()["zh"] == "xin chào"
    assert "model" not in again.json(), "缓存命中不声称本次用了模型"
    assert len(calls) == 1

    # 中文查询仍走 ECDICT 本地命中，与越南语缓存互不影响
    zh = client.post("/api/define", json={"word": "hello"})
    assert zh.status_code == 200
    zh_data = zh.json()
    assert zh_data["targetLang"] == "zh-CN"
    assert zh_data["source"] == "local"
    assert zh_data["zh"] == "喂, 嘿"
    assert len(calls) == 1, "中文本地命中不应调用模型"
    assert not (history_dir / "dictionary_cache.json").exists(), (
        "本地命中不写 LLM 词典缓存（旧行为不变）"
    )


def test_vi_dictionary_falls_back_to_deepseek_without_other_keys(client, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("QWEN_API_KEY", raising=False)

    calls = []

    def fake_generate_json(prompt, model=None):
        calls.append({"prompt": prompt, "model": model})
        return json.dumps(VI_DICT, ensure_ascii=False)

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)

    response = client.post(
        "/api/define", json={"word": "hello", "targetLang": "vi-VN"}
    )
    assert response.status_code == 200, response.text
    assert calls[0]["model"] == "deepseek-chat", "只有 DeepSeek Key 时也要能查越南语"


# ---------------------------------------------------------------------------
# 7. 模型路线
# ---------------------------------------------------------------------------

def test_model_routes_and_key_skipping(monkeypatch):
    assert config.model_route_for("zh-CN") == ["deepseek-chat", "gemini-2.5-flash"]
    assert config.model_route_for("vi-VN") == [
        "deepseek-chat", "qwen-plus", "gemini-2.5-flash",
    ]

    # 负责人决定：Qwen 正式启用前，越南语也先用 DeepSeek。
    assert llm.resolve_model_for_target(None, "zh-CN") == "deepseek-chat"
    assert llm.resolve_model_for_target(None, "vi-VN") == "deepseek-chat"
    # 没有 DeepSeek Key → 落到 Qwen（conftest 配了 Key 与端点）
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    assert llm.is_available("deepseek-chat") is False
    assert llm.resolve_model_for_target(None, "vi-VN") == "qwen-plus"
    # Qwen 只有 Key、没有端点 → 视为不可用，再落到 Gemini
    monkeypatch.delenv("QWEN_BASE_URL", raising=False)
    assert llm.is_available("qwen-plus") is False
    assert llm.resolve_model_for_target(None, "vi-VN") == "gemini-2.5-flash"
    # 用户显式选择且可用时优先（恢复 DeepSeek Key）
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-deepseek-key")
    assert llm.resolve_model_for_target("deepseek-chat", "vi-VN") == "deepseek-chat"


def test_model_route_env_override_skips_unknown_ids(monkeypatch):
    monkeypatch.setenv("I18N_TEST_ROUTE", "not-a-model,deepseek-chat, qwen-plus")
    assert config._model_route_from_env(
        "I18N_TEST_ROUTE", ["gemini-2.5-flash"]
    ) == ["deepseek-chat", "qwen-plus"]

    monkeypatch.setenv("I18N_TEST_ROUTE", "not-a-model")
    assert config._model_route_from_env(
        "I18N_TEST_ROUTE", ["deepseek-chat"]
    ) == ["deepseek-chat"], "全部非法时回落默认路线"

    # 环境变量覆盖是启动时读取的：不重载模块，只验证解析函数本身。
    monkeypatch.delenv("I18N_TEST_ROUTE", raising=False)
    assert config._model_route_from_env(
        "I18N_TEST_ROUTE", ["vi-test"]
    ) == ["vi-test"]


# ---------------------------------------------------------------------------
# 8. 账本 / 配额记录 target_lang（不拆限额）
# ---------------------------------------------------------------------------

def test_ledger_and_quota_record_target_lang_without_splitting_limits(
    ledger_db, monkeypatch
):
    monkeypatch.setattr(config, "AI_DAILY_QUOTA_DEFINE", 3, raising=False)
    monkeypatch.setattr(config, "AI_DAILY_BUDGET_USER_USD", 0, raising=False)
    monkeypatch.setattr(config, "AI_DAILY_BUDGET_GLOBAL_USD", 0, raising=False)
    vi = ledger.record_usage(
        "u1", "translate", "deepseek-chat", 10, 5, target_lang="vi-VN"
    )
    assert vi is not None and vi["target_lang"] == "vi-VN"
    zh = ledger.record_usage("u1", "translate", "deepseek-chat", 10, 5)
    assert zh["target_lang"] == "zh-CN", "缺省 language 记为 zh-CN"

    with sqlite3.connect(ledger_db) as conn:
        rows = conn.execute(
            "SELECT target_lang FROM ai_usage ORDER BY id"
        ).fetchall()
    assert [row[0] for row in rows] == ["vi-VN", "zh-CN"]

    first = quota.check_and_consume_quota(
        "u1", "define", 1, target_lang="vi-VN"
    )
    assert first["target_lang"] == "vi-VN"
    assert first["used_units"] == 1
    # 换语言仍消耗同一条配额（P0 不拆限额）
    second = quota.check_and_consume_quota(
        "u1", "define", 1, target_lang="zh-CN"
    )
    assert second["used_units"] == 2
    assert second["target_lang"] == "zh-CN"


def test_ledger_record_usage_on_0003_db_without_target_lang_column(
    tmp_path, monkeypatch
):
    """M1b 旧库（只有 0003）也要能记账：退化为不带语言列写入，不丢成本数据。"""
    db = tmp_path / "ledger-0003.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "0003_cost_ledger"), "upgrade 0003")
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(db), raising=False)

    row = ledger.record_usage(
        "u1", "translate", "deepseek-chat", 10, 5, target_lang="vi-VN"
    )
    assert row is not None
    assert row["target_lang"] == "vi-VN"
    with sqlite3.connect(db) as conn:
        assert conn.execute("SELECT COUNT(*) FROM ai_usage").fetchone()[0] == 1


# ---------------------------------------------------------------------------
# 9. 0004_target_lang 迁移
# ---------------------------------------------------------------------------

def test_migration_0004_adds_target_lang_to_existing_ledger_db(tmp_path):
    db = tmp_path / "old-ledger.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "0003_cost_ledger"), "upgrade 0003")
    assert "target_lang" not in columns(db, "ai_usage")

    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO ai_usage (user_id, feature, model_id, provider, "
            "input_tokens, output_tokens, calls, est_cost_usd, occurred_at, "
            "created_at, usage_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("old-user", "translate", "deepseek-chat", "DeepSeek",
             10, 5, 1, 0.001, 1000, 1000, "2026-11-15"),
        )
        conn.commit()

    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    usage = columns(db, "ai_usage")
    assert "target_lang" in usage
    assert usage["target_lang"]["notnull"] == 0, "列可空"
    assert "zh-CN" in str(usage["target_lang"]["default"])

    with sqlite3.connect(db) as conn:
        # 旧数据不批量改写：读出 server default（zh-CN），不是 NULL 也不是新值
        assert conn.execute(
            "SELECT target_lang FROM ai_usage WHERE user_id = 'old-user'"
        ).fetchone()[0] == "zh-CN"

    # 幂等：再 upgrade 一次不报错
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head (repeat)")

    assert_alembic_ok(run_alembic(db, "downgrade", "0003_cost_ledger"), "downgrade 0003")
    assert "target_lang" not in columns(db, "ai_usage")


# ---------------------------------------------------------------------------
# 10. 越南语输出校验
# ---------------------------------------------------------------------------

def test_vietnamese_cjk_leak_retries_then_marks_untranslated(monkeypatch):
    calls = []

    def fake_generate_json(prompt, model=None):
        calls.append(model)
        return json.dumps(
            {"blocks": [{"id": 1, "zh_text": "你好，世界。", "highlights": []}]},
            ensure_ascii=False,
        )

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)
    monkeypatch.setattr(
        translate.quota,
        "degradation_chain",
        lambda feature=None, preferred_model=None: ["model-a"],
    )

    result = asyncio.run(
        translate.process_llm_batch(
            [{"id": 1, "text": "Hello world.", "start": 0.0, "end": 1.0}],
            model="model-a",
            target_lang="vi-VN",
            user_id=None,
        )
    )
    assert result[0]["zh_text"] == translate.UNTRANSLATED_MARKER
    assert calls == ["model-a", "model-a"], "语言错误必须同一候选重试一次"
    assert result[0]["highlights"] == []


def test_vietnamese_json_alignment_and_highlight_validation(monkeypatch):
    payload = {
        "blocks": [
            # 乱序 + 多余 id：按 id 对齐、多余块丢弃
            {
                "id": 2,
                "zh_text": "Học tiếng Anh rất vui.",
                "highlights": [
                    {"en_word": "fun", "zh_word": "vui"},
                    {"en_word": "not-in-sentence", "zh_word": "vui"},
                    {"en_word": "fun", "zh_word": "không có trong bản dịch"},
                ],
            },
            {"id": 1, "zh_text": "Xin chào thế giới.", "highlights": []},
            {"id": 99, "zh_text": "thừa", "highlights": []},
        ]
    }
    monkeypatch.setattr(
        llm, "generate_json", lambda prompt, model=None: json.dumps(payload, ensure_ascii=False)
    )
    monkeypatch.setattr(
        translate.quota,
        "degradation_chain",
        lambda feature=None, preferred_model=None: ["model-a"],
    )

    result = asyncio.run(
        translate.process_llm_batch(
            [
                {"id": 1, "text": "Hello world.", "start": 0.0, "end": 1.0},
                {"id": 2, "text": "Learning English is fun.", "start": 2.0, "end": 3.0},
            ],
            model="model-a",
            target_lang="vi-VN",
            user_id=None,
        )
    )
    assert [block["id"] for block in result] == [1, 2]
    assert result[0]["zh_text"] == "Xin chào thế giới."
    assert result[1]["zh_text"] == "Học tiếng Anh rất vui."
    # 只保留「英文子串 + 译文子串」都成立的高亮
    assert result[1]["highlights"] == [{
        "en_word": "fun",
        "zh_word": "vui",
        "color": translate.HIGHLIGHT_COLOR,
    }]


# ---------------------------------------------------------------------------
# 11. 历史列表/读取/删除按语言隔离
# ---------------------------------------------------------------------------

def _video_payload(lang: str | None, video_id: str = "histvid1") -> dict:
    payload = {
        "videoId": video_id,
        "metadata": {"title": "Hist", "channel": "Ch", "upload_date": "20240101"},
        "transcript": [{
            "id": 1, "start": 0.0, "end": 1.0, "en_text": "Hi.",
            "zh_text": "Xin chào." if lang == "vi-VN" else "你好。",
            "highlights": [],
        }],
        "summary": "vi" if lang == "vi-VN" else "zh",
        "model": "deepseek-chat",
        "studyCount": 0,
    }
    if lang:
        payload["target_lang"] = lang
    return payload


def test_history_scoped_by_target_language(client, history_dir):
    vi_dir = history_dir / "vi-VN"
    vi_dir.mkdir()
    (vi_dir / "Vid_20240101_vi1.json").write_text(
        json.dumps(_video_payload("vi-VN", "vi1"), ensure_ascii=False), encoding="utf-8"
    )
    (history_dir / "Vid_20240101_zh1.json").write_text(
        json.dumps(_video_payload(None, "zh1"), ensure_ascii=False), encoding="utf-8"
    )

    zh_items = client.get("/api/history").json()
    assert [item["filename"] for item in zh_items] == ["Vid_20240101_zh1.json"]
    assert zh_items[0]["targetLang"] == "zh-CN"

    vi_items = client.get("/api/history", params={"targetLang": "vi-VN"}).json()
    assert [item["filename"] for item in vi_items] == ["Vid_20240101_vi1.json"]
    assert vi_items[0]["targetLang"] == "vi-VN"

    # 读取：在各自语言目录解析；跨语言视为未命中
    assert client.get("/api/history/Vid_20240101_vi1.json").status_code == 404
    assert client.get("/api/history/Vid_20240101_zh1.json").status_code == 200
    vi_detail = client.get(
        "/api/history/Vid_20240101_vi1.json", params={"targetLang": "vi-VN"}
    )
    assert vi_detail.status_code == 200
    assert vi_detail.json()["target_lang"] == "vi-VN"

    # payload 语言与目录不一致 → 未命中（防把错误语言译文返回）
    (vi_dir / "Vid_20240101_wrong.json").write_text(
        json.dumps(_video_payload(None, "wrong"), ensure_ascii=False), encoding="utf-8"
    )
    assert client.get(
        "/api/history/Vid_20240101_wrong.json", params={"targetLang": "vi-VN"}
    ).status_code == 404

    # 删除只删当前语言；中文那份保留
    assert client.delete(
        "/api/history/Vid_20240101_vi1.json", params={"targetLang": "vi-VN"}
    ).status_code == 200
    assert not (vi_dir / "Vid_20240101_vi1.json").exists()
    assert (history_dir / "Vid_20240101_zh1.json").exists()


# ---------------------------------------------------------------------------
# 本地剧集：语言目录 + processed
# ---------------------------------------------------------------------------

def test_process_subtitle_vi_writes_language_dir(client, history_dir, demo_srt, monkeypatch):
    calls = []

    async def fake_process_llm_batch(blocks, model=config.DEFAULT_MODEL, vocab_level=None, **kwargs):
        calls.append(kwargs.get("target_lang"))
        return [
            {
                "id": block.get("id"),
                "start": block["start"],
                "end": block["end"],
                "en_text": block["text"],
                "zh_text": f"vi:{block['text']}",
                "highlights": [],
            }
            for block in blocks
        ]

    monkeypatch.setattr(routes_content, "process_llm_batch", fake_process_llm_batch)

    response = client.post(
        "/api/process-subtitle",
        json={
            "show_id": "demo-show", "season": 1, "episode": 1,
            "model": "deepseek-chat", "targetLang": "vi-VN",
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["target_lang"] == "vi-VN"
    assert data["summary"] == "", "越南语不写中文固定集名标签"
    assert data["summary_kind"] == "episode_label"
    assert calls == ["vi-VN"], "翻译批次的账本/语言维度必须透传"

    cache_path = history_dir / "vi-VN" / "demo-show_S01E01.json"
    assert cache_path.exists()
    saved = json.loads(cache_path.read_text(encoding="utf-8"))
    assert saved["target_lang"] == "vi-VN"
    assert not (history_dir / "demo-show_S01E01.json").exists()

    processed = client.get(
        "/api/shows/demo-show/processed", params={"targetLang": "vi-VN"}
    ).json()
    assert processed == {"processed": ["S01E01"], "targetLang": "vi-VN"}
    assert client.get("/api/shows/demo-show/processed").json()["processed"] == []

    # 中文再处理一次 → 独立缓存，不命中越南语
    zh = client.post(
        "/api/process-subtitle",
        json={"show_id": "demo-show", "season": 1, "episode": 1,
              "model": "deepseek-chat"},
    )
    assert zh.status_code == 200
    assert zh.json()["target_lang"] == "zh-CN"
    assert (history_dir / "demo-show_S01E01.json").exists()
    assert (history_dir / "vi-VN" / "demo-show_S01E01.json").exists()
