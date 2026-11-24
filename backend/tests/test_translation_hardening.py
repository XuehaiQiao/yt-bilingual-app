"""P2-31 翻译 P0 加固的离线验收。

覆盖：
1. Qwen 目录项显式关闭 thinking，OpenAI 兼容 payload 只对该标记发
   `thinking:{"type":"disabled"}`；DeepSeek/其他模型不带未知字段。
2. 视频翻译 prompt 瘦身：输入 `{i,t}`、输出 `{r:[{i,t}]}`，不再带
   start/end 与 en_text 回显；旧 `blocks/id/en_text/zh_text` 仍能解析。
3. 空/纯空白响应同候选重试 1 次后降级；JSON 完全无法解析同候选重试 1 次；
   新 schema 零覆盖时同候选旧 schema 救援 1 次；每批配额只扣 1 次。
4. 缺失 id 只补缺失子集一次（不整批重发），仍缺标 `[未翻译]`。
5. 单批 90s deadline：超时取消并进入降级，不挂 provider 的 180s。
"""
from __future__ import annotations

import asyncio
import json

import pytest

import config
import llm
import translate

# conftest 的离线护栏会把 ``_generate_openai_compatible`` 换成断言函数；
# 模块导入时先抓住真实实现，payload 测试再临时装回去。
_REAL_OPENAI_COMPATIBLE = llm._generate_openai_compatible


def _blocks(n: int = 3) -> list[dict]:
    texts = ["First sentence.", "Second sentence.", "Third sentence."]
    return [
        {"id": i + 1, "text": texts[i], "start": float(i), "end": float(i + 1)}
        for i in range(n)
    ]


def _new_schema(entries: list[tuple[int, str]]) -> str:
    return json.dumps(
        {"r": [{"i": i, "t": t} for i, t in entries]}, ensure_ascii=False
    )


def _old_schema(entries: list[tuple[int, str]]) -> str:
    return json.dumps(
        {"blocks": [{"id": i, "zh_text": t} for i, t in entries]}, ensure_ascii=False
    )


def _single_candidate(monkeypatch, model: str = "model-a") -> None:
    monkeypatch.setattr(
        translate.quota,
        "degradation_chain",
        lambda feature=None, preferred_model=None: [model],
    )


# ---------------------------------------------------------------------------
# 1. Qwen thinking off / DeepSeek 不发未知参数
# ---------------------------------------------------------------------------

def test_only_qwen_catalog_entries_carry_thinking_flag():
    assert config.MODEL_CATALOG["qwen-flash"]["thinking_disabled"] is True
    assert config.MODEL_CATALOG["qwen-plus"]["thinking_disabled"] is True
    assert "thinking_disabled" not in config.MODEL_CATALOG["deepseek-chat"]
    assert "thinking_disabled" not in config.MODEL_CATALOG["gemini-2.5-flash"]


def _capture_payloads(monkeypatch, models: list[str]) -> list[dict]:
    captured: list[dict] = []

    class _FakeResponse:
        status_code = 200
        text = ""

        def json(self):
            return {
                "choices": [{"message": {"content": '{"r": []}'}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            }

    class _FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def post(self, url, json=None, headers=None):
            captured.append({"url": url, "payload": json, "headers": headers})
            return _FakeResponse()

    monkeypatch.setattr(llm, "_generate_openai_compatible", _REAL_OPENAI_COMPATIBLE)
    monkeypatch.setattr(llm.httpx, "Client", _FakeClient)
    monkeypatch.setenv("QWEN_BASE_URL", "https://qwen.example/v1")
    monkeypatch.setenv("QWEN_API_KEY", "test-qwen-key")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-deepseek-key")

    for model in models:
        llm._generate_openai_compatible("say hi", llm._spec(model), True)
    return [item["payload"] for item in captured]


def test_qwen_payload_sends_thinking_disabled(monkeypatch):
    qwen_flash, qwen_plus = _capture_payloads(monkeypatch, ["qwen-flash", "qwen-plus"])
    for payload, model_id in (
        (qwen_flash, "qwen3.8-flash"),
        (qwen_plus, "qwen3.7-plus"),
    ):
        assert payload["model"] == model_id
        assert payload["thinking"] == {"type": "disabled"}
        assert payload["response_format"] == {"type": "json_object"}


def test_deepseek_payload_has_no_thinking_or_unknown_fields(monkeypatch):
    (payload,) = _capture_payloads(monkeypatch, ["deepseek-chat"])
    assert "thinking" not in payload
    # 只发 OpenAI 兼容端点已知的字段；未知参数可能直接 400。
    assert set(payload) == {
        "model", "messages", "temperature", "stream", "response_format"
    }


# ---------------------------------------------------------------------------
# 2. 新 prompt schema / 新旧解析兼容
# ---------------------------------------------------------------------------

def test_slim_prompt_and_new_schema_align_backfills_original_fields(monkeypatch):
    prompts: list[str] = []

    async def fake_generate(prompt, model=None):
        prompts.append(prompt)
        # 乱序返回也要按 id 对齐。
        return _new_schema([(2, "第二句。"), (1, "第一句。")])

    monkeypatch.setattr(llm, "generate_json_async", fake_generate)
    _single_candidate(monkeypatch)

    result = asyncio.run(
        translate.process_llm_batch(_blocks(2), model="model-a", user_id=None)
    )

    assert [block["id"] for block in result] == [1, 2]
    assert [block["zh_text"] for block in result] == ["第一句。", "第二句。"]
    # 输出仍回填原 en_text/start/end（不信任模型回显）。
    assert result[0]["en_text"] == "First sentence."
    assert result[0]["start"] == 0.0 and result[0]["end"] == 1.0
    assert result[1]["start"] == 1.0 and result[1]["end"] == 2.0

    prompt = prompts[0]
    assert '"en_text"' not in prompt
    assert '"start"' not in prompt and '"end"' not in prompt
    # 输入是 {i,t} 且只有文本，没有 start/end。
    assert '"i": 1' in prompt and '"t": "First sentence."' in prompt
    # 输出 schema 只要 r/i/t。
    assert '{"r": [{"i": 1, "t": "..."}]}' in prompt
    assert translate.PROMPT_VERSIONS["translate"] == "translate.v3"


def test_extract_block_list_accepts_r_and_legacy_blocks():
    new_entries = [{"i": 1, "t": "你好。"}]
    old_entries = [{"id": 1, "zh_text": "你好。"}]
    assert translate._extract_block_list({"r": new_entries}) == new_entries
    assert translate._extract_block_list({"blocks": old_entries}) == old_entries
    # 单条对象/{"1": {...}} 形式也要兼容。
    assert translate._extract_block_list({"i": 1, "t": "你好。"}) == [
        {"i": 1, "t": "你好。"}
    ]
    assert translate._extract_block_list({"1": {"id": 1, "zh_text": "你好。"}}) == [
        {"id": 1, "zh_text": "你好。"}
    ]


def test_align_accepts_legacy_schema_and_ignores_model_en_text():
    result, stats = translate._align_processed_blocks(
        _blocks(1),
        {
            "blocks": [
                {
                    "id": 1,
                    "en_text": "MODEL REWROTE THIS",
                    "zh_text": "第一句。",
                    "highlights": [],
                }
            ]
        },
    )
    assert stats["missing"] == 0
    assert stats["missing_ids"] == []
    assert result[0]["en_text"] == "First sentence."
    assert result[0]["zh_text"] == "第一句。"


# ---------------------------------------------------------------------------
# 3. 空响应 / JSON 解析失败重试与配额
# ---------------------------------------------------------------------------

def test_empty_response_retries_same_candidate_once(monkeypatch):
    calls: list[str] = []

    def fake_generate_json(prompt, model=None):
        calls.append(model)
        if len(calls) == 1:
            return "   \n  "
        return _new_schema([(1, "第一句。")])

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)
    _single_candidate(monkeypatch)

    result = asyncio.run(
        translate.process_llm_batch(_blocks(1), model="model-a", user_id=None)
    )
    assert calls == ["model-a", "model-a"]
    assert result[0]["zh_text"] == "第一句。"


def test_empty_response_after_retry_degrades_and_charges_quota_once(monkeypatch):
    calls: list[str] = []
    quota_calls: list[int] = []

    def fake_generate_json(prompt, model=None):
        calls.append(model)
        if model == "model-a":
            return "  \n "
        return _new_schema([(1, "第一句。")])

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)
    monkeypatch.setattr(
        translate.quota,
        "degradation_chain",
        lambda feature=None, preferred_model=None: ["model-a", "model-b"],
    )
    monkeypatch.setattr(
        translate.quota,
        "check_and_consume_quota",
        lambda *args, **kwargs: quota_calls.append(1),
    )

    result = asyncio.run(
        translate.process_llm_batch(_blocks(1), model="model-a", user_id=None)
    )
    assert calls == ["model-a", "model-a", "model-b"], "同一候选最多 2 次再降级"
    assert result[0]["zh_text"] == "第一句。"
    assert len(quota_calls) == 1, "整批重试/降级不得重复扣配额"


def test_unparsable_json_retries_same_candidate_once(monkeypatch):
    calls: list[str] = []

    def fake_generate_json(prompt, model=None):
        calls.append(model)
        if len(calls) == 1:
            return "not json at all"
        return _new_schema([(1, "第一句。")])

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)
    _single_candidate(monkeypatch)

    result = asyncio.run(
        translate.process_llm_batch(_blocks(1), model="model-a", user_id=None)
    )
    assert calls == ["model-a", "model-a"]
    assert result[0]["zh_text"] == "第一句。"


# ---------------------------------------------------------------------------
# 4. 缺失 ID 只补缺失子集
# ---------------------------------------------------------------------------

def test_missing_ids_only_resend_the_missing_subset(monkeypatch):
    calls: list[str] = []
    prompts: list[str] = []
    quota_calls: list[int] = []

    def fake_generate_json(prompt, model=None):
        calls.append(model)
        prompts.append(prompt)
        if len(calls) == 1:
            return _new_schema([(1, "第一句。"), (2, "第二句。")])
        return _new_schema([(3, "第三句。")])

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)
    monkeypatch.setattr(
        translate.quota,
        "degradation_chain",
        lambda feature=None, preferred_model=None: ["model-a", "model-b"],
    )
    monkeypatch.setattr(
        translate.quota,
        "check_and_consume_quota",
        lambda *args, **kwargs: quota_calls.append(1),
    )

    result = asyncio.run(
        translate.process_llm_batch(_blocks(3), model="model-a", user_id=None)
    )

    assert calls == ["model-a", "model-a"], "只补缺失一次，不整批重复翻译"
    assert len(quota_calls) == 1, "补缺失不得重复扣配额"
    assert [block["zh_text"] for block in result] == [
        "第一句。", "第二句。", "第三句。"
    ]
    # 第二次只发缺失的 id=3：不能再出现第 1/2 句的文本。
    supplement = prompts[1]
    assert '"i": 3' in supplement
    assert "First sentence." not in supplement
    assert "Second sentence." not in supplement


def test_missing_ids_still_missing_after_one_supplement_marked_untranslated(monkeypatch):
    calls: list[str] = []

    def fake_generate_json(prompt, model=None):
        calls.append(model)
        if len(calls) == 1:
            return _new_schema([(1, "第一句。")])
        return _new_schema([])  # 补译仍没给 id=2

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)
    _single_candidate(monkeypatch)

    result = asyncio.run(
        translate.process_llm_batch(_blocks(2), model="model-a", user_id=None)
    )
    assert calls == ["model-a", "model-a"]
    assert result[0]["zh_text"] == "第一句。"
    assert result[1]["zh_text"] == translate.UNTRANSLATED_MARKER


def test_zero_coverage_response_rescued_once_with_legacy_schema(monkeypatch):
    prompts: list[str] = []

    def fake_generate_json(prompt, model=None):
        prompts.append(prompt)
        if len(prompts) == 1:
            return json.dumps({"blocks": []})  # 新 schema 零覆盖
        return _old_schema([(1, "第一句。")])

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)
    _single_candidate(monkeypatch)

    result = asyncio.run(
        translate.process_llm_batch(_blocks(1), model="model-a", user_id=None)
    )
    assert len(prompts) == 2, "零覆盖只做一次旧 schema 救援"
    assert '"id": 1' in prompts[1] and "zh_text" in prompts[1]
    assert result[0]["zh_text"] == "第一句。"


def test_zero_coverage_rescue_still_empty_marks_untranslated(monkeypatch):
    calls: list[str] = []

    def fake_generate_json(prompt, model=None):
        calls.append(model)
        return json.dumps({"blocks": []})

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)
    _single_candidate(monkeypatch)

    result = asyncio.run(
        translate.process_llm_batch(_blocks(1), model="model-a", user_id=None)
    )
    assert calls == ["model-a", "model-a"], "救援也只重试一次"
    assert result[0]["zh_text"] == translate.UNTRANSLATED_MARKER


# ---------------------------------------------------------------------------
# 5. 90s 单批 deadline
# ---------------------------------------------------------------------------

def test_translate_batch_timeout_degrades_to_next_candidate(monkeypatch):
    calls: list[str] = []
    monkeypatch.setattr(translate, "TRANSLATE_BATCH_TIMEOUT_SECONDS", 0.05)

    async def fake_generate_json_async(prompt, model=None):
        calls.append(model)
        if model == "model-a":
            await asyncio.sleep(0.5)  # 超过 0.05s deadline
            return _new_schema([(1, "不该等到这个结果。")])
        return _new_schema([(1, "第一句。")])

    monkeypatch.setattr(llm, "generate_json_async", fake_generate_json_async)
    monkeypatch.setattr(
        translate.quota,
        "degradation_chain",
        lambda feature=None, preferred_model=None: ["model-a", "model-b"],
    )

    result = asyncio.run(
        translate.process_llm_batch(_blocks(1), model="model-a", user_id=None)
    )
    assert calls == ["model-a", "model-b"], "超时必须取消并进入降级"
    assert result[0]["zh_text"] == "第一句。"


def test_default_deadline_is_90s_and_llm_timeout_untouched():
    assert translate.TRANSLATE_BATCH_TIMEOUT_SECONDS == 90.0
    # 其他 LLM 调用仍走 provider 自身 timeout（目录没写时默认 180s），
    # 翻译 deadline 只包住 process_llm_batch 的调用点。
    import inspect

    source = inspect.getsource(llm.generate_json_async)
    assert "wait_for" not in source


# ---------------------------------------------------------------------------
# 6. 配额单位（P2-34）：1 单位 = 100 blocks，每批只扣一次
# ---------------------------------------------------------------------------

def _many_blocks(n: int) -> list[dict]:
    return [
        {"id": i + 1, "text": f"Sentence number {i + 1}.", "start": float(i), "end": float(i + 1)}
        for i in range(n)
    ]


@pytest.mark.parametrize(("n", "units"), [(20, 1), (100, 1), (101, 2), (1372, 14)])
def test_process_llm_batch_charges_units_by_block_count(monkeypatch, n, units):
    """translate：1 单位 = 100 blocks；1,372 blocks 换算为 14 单位。"""
    monkeypatch.setattr(
        llm,
        "generate_json",
        lambda prompt, model=None: _new_schema(
            [(i + 1, f"译文{i + 1}") for i in range(n)]
        ),
    )
    _single_candidate(monkeypatch)
    charged: list[tuple] = []

    def fake_quota(*args, **kwargs):
        charged.append((args, kwargs))

    monkeypatch.setattr(translate.quota, "check_and_consume_quota", fake_quota)

    result = asyncio.run(
        translate.process_llm_batch(_many_blocks(n), model="model-a", user_id="u1")
    )
    assert len(result) == n
    assert len(charged) == 1, "整批只扣一次"
    _, feature, passed_units = charged[0][0]
    assert feature == "translate"
    assert passed_units == units


def test_process_llm_batch_local_show_uses_100_blocks_per_unit(monkeypatch):
    monkeypatch.setattr(
        llm,
        "generate_json",
        lambda prompt, model=None: _new_schema(
            [(i + 1, f"译文{i + 1}") for i in range(101)]
        ),
    )
    _single_candidate(monkeypatch)
    charged: list[int] = []
    monkeypatch.setattr(
        translate.quota,
        "check_and_consume_quota",
        lambda *args, **kwargs: charged.append(args[2]),
    )

    asyncio.run(
        translate.process_llm_batch(
            _many_blocks(101), model="model-a", feature="local_show", user_id="u1"
        )
    )
    assert charged == [2], "local_show 也是 100 blocks/单位"


def test_process_llm_batch_empty_batch_charges_nothing(monkeypatch):
    charged: list = []
    monkeypatch.setattr(
        translate.quota,
        "check_and_consume_quota",
        lambda *args, **kwargs: charged.append(1),
    )
    assert asyncio.run(translate.process_llm_batch([], model="model-a", user_id="u1")) == []
    assert charged == []


def test_1372_block_video_costs_14_units_under_default_limit():
    """1,372-block 视频按累计 blocks 计 14 单位，默认 60 单位不会中途 429。"""
    import translation_batching

    blocks = _many_blocks(1372)
    batches = translation_batching.chunk_by_budget(
        blocks,
        lambda block: block["text"],
        translation_batching.VIDEO_FIRST_BATCH_SIZE,
        translation_batching.VIDEO_STEADY_BATCH_SIZE,
        translation_batching.VIDEO_MAX_SOURCE_TOKENS,
    )
    units = translate.quota.units_per_batch(
        "translate", [len(batch) for batch in batches]
    )
    assert len(batches) > 14, "P2-33 会把视频切成小批（首批 10、稳定 40）"
    assert sum(units) == 14
    assert sum(units) < config.AI_DAILY_QUOTA_TRANSLATE_BATCHES, "60 单位内可跑完"
    # 文章口径同样按累计段数：20 段 = 2 单位（首批 5 + 稳定 15）。
    article_batches = translation_batching.chunk_by_budget(
        _many_blocks(20),
        lambda block: block["text"],
        translation_batching.ARTICLE_FIRST_BATCH_SIZE,
        translation_batching.ARTICLE_STEADY_BATCH_SIZE,
        translation_batching.ARTICLE_MAX_SOURCE_TOKENS,
    )
    assert sum(
        translate.quota.units_per_batch(
            "reading", [len(batch) for batch in article_batches]
        )
    ) == 2


def test_covered_batch_checks_gate_without_charging(monkeypatch):
    """quota_units=0：落在已购单位内，不扣减但要走只读闸门。"""
    monkeypatch.setattr(
        llm,
        "generate_json",
        lambda prompt, model=None: _new_schema([(1, "第一句。")]),
    )
    _single_candidate(monkeypatch)
    consumed: list = []
    gated: list = []
    monkeypatch.setattr(
        translate.quota,
        "check_and_consume_quota",
        lambda *args, **kwargs: consumed.append(args),
    )
    monkeypatch.setattr(
        translate.quota,
        "ensure_quota_available",
        lambda *args, **kwargs: gated.append(args),
    )

    result = asyncio.run(
        translate.process_llm_batch(
            _blocks(1), model="model-a", user_id="u1", quota_units=0
        )
    )
    assert result[0]["zh_text"] == "第一句。"
    assert consumed == [], "覆盖批不得重复扣减"
    assert len(gated) == 1, "但必须做只读闸门检查"


def test_stream_translate_allocates_cumulative_units(monkeypatch, tmp_path):
    """SSE 流式 101 blocks 切 4 批，但累计只占 2 单位（1 单位=100 blocks）。"""
    transcript = [
        {
            "id": index + 1,
            "start": float(index),
            "end": float(index) + 1,
            "en_text": f"Sentence number {index + 1}.",
            "zh_text": "",
            "highlights": [],
        }
        for index in range(101)
    ]
    payload = {"videoId": "unit-test", "transcript": transcript}
    save_path = tmp_path / "unit-test.json"
    save_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    units: list[int] = []

    async def fake(blocks, **kwargs):
        units.append(kwargs.get("quota_units"))
        return [
            {
                "id": block["id"],
                "start": block["start"],
                "end": block["end"],
                "en_text": block["en_text"],
                "zh_text": "译文",
                "highlights": [],
            }
            for block in blocks
        ]

    monkeypatch.setattr(translate, "process_llm_batch", fake)
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)

    async def run() -> None:
        async for _update in translate._stream_translate(
            transcript,
            list(range(101)),
            payload,
            str(save_path),
            model="model-a",
            user_id="u1",
            target_lang="zh-CN",
        ):
            pass

    asyncio.run(run())
    assert len(units) == 4, "101 blocks 切成 10/40/40/11 四批"
    assert units == [1, 0, 0, 1], "累计 101 blocks = 2 单位，只在前两批边界扣"
    assert sum(units) == 2
