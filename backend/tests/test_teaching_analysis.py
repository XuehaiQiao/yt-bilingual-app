"""AI 教学分析（高亮/习语/文化点）离线验收（specs/028）。

覆盖：

1. 迁移 0020：表/列/唯一缓存键/索引/回滚/重复迁移幂等；
2. content_hash：同内容稳定、内容变化/prompt 版本维度隔离；
3. 等级/语言归一化：六档 + 旧考试 id 映射、非法值 400、默认档 orbit；
4. prompt：只标高于等级的词/短语、quote 必须能在原文找到、目标语言名；
5. 校验闸：en_word/zh_word/quote 子串约束、未知 block 丢弃、译文找不到时
   zh_word 置空但保留 en、颜色强制、单 block ≤2 条、习语 20/文化点 10 上限；
6. 缓存：首次生成一次模型调用，第二次命中零调用；等级/语言/内容隔离；
7. 并发：同 key 并发只跑一次模型（后到者复用缓存）；
8. 失败不写半成品、可重试；缺 0020 表时 AnalysisUnavailable（内部静默跳过）；
9. 合并：按 block id 覆盖 highlights、清掉旧等级残留、idioms/culture/
   analysisVersion 写进 payload；旧缓存没有分析字段时保持原样；
10. 端到端：翻译 prompt 不再请求 highlights；流式处理在翻译后合并分析并落盘；
    GET /api/teaching-analysis（登录、缓存命中免费、等级/内容变化重生成）。

全部离线：LLM 全部 monkeypatch；数据库在 conftest 的 tmp_path 下用真实
Alembic CLI 迁移；不联网。
"""
from __future__ import annotations

import asyncio
import copy
import json
import re
import sqlite3
from types import SimpleNamespace

import pytest

import config
import llm
import storage
import teaching_analysis
import translate
import routes_videos
from tests.migration_utils import (
    assert_alembic_ok,
    columns,
    index_names,
    revision,
    run_alembic,
    table_names,
)

VIDEO_ID = "teachvid001"
URL = f"https://www.youtube.com/watch?v={VIDEO_ID}"
TITLE = "Teaching Analysis Test"
HIGHLIGHT_COLOR = translate.HIGHLIGHT_COLOR

BLOCKS = [
    {
        "id": 1,
        "start": 0.0,
        "end": 2.0,
        "en_text": "The museum opens at nine in the morning.",
        "zh_text": "博物馆早上九点开门。",
        "highlights": [],
    },
    {
        "id": 2,
        "start": 2.0,
        "end": 4.0,
        "en_text": "Visitors can buy tickets at the front desk.",
        "zh_text": "游客可以在前台买票。",
        "highlights": [],
    },
]


# ---------------------------------------------------------------------------
# 夹具 / 桩
# ---------------------------------------------------------------------------

@pytest.fixture()
def analysis_db(client):
    """把当前用例的临时库迁到 head（含 0020 教学分析表）。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"),
        "upgrade head (teaching analysis)",
    )
    teaching_analysis.reset_locks()
    return client


def _analysis_from_prompt(prompt: str) -> dict:
    """按 prompt 里的 Blocks 生成一份合法分析（每条都取自原文/译文）。"""
    blocks = json.loads(prompt.rsplit("Blocks:\n", 1)[-1])
    idioms: list[dict] = []
    culture: list[dict] = []
    for block in blocks:
        en = block.get("en", "")
        zh = block.get("zh", "")
        parts = en.split()
        if parts:
            idioms.append({
                "blockId": block["blockId"],
                "phrase": " ".join(parts[:2]),
                "meaning": "测试含义",
                "quote": en,
            })
            culture.append({
                "blockId": block["blockId"],
                "term": parts[0],
                "note": "测试文化点",
                "quote": en,
            })
    # analysis.v2 deliberately has no highlights field.
    return {"idioms": idioms, "culture": culture}


class LlmStub:
    """记录 prompt、可控制失败的异步 generate_json_async 桩。"""

    def __init__(self) -> None:
        self.prompts: list[str] = []
        self.fail = False
        self.delay = 0.0

    async def generate_json_async(self, prompt: str, model: str | None = None):
        self.prompts.append(prompt)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            raise RuntimeError("model unavailable")
        return json.dumps(_analysis_from_prompt(prompt), ensure_ascii=False)


@pytest.fixture()
def llm_stub(monkeypatch):
    stub = LlmStub()
    monkeypatch.setattr(llm, "generate_json_async", stub.generate_json_async)
    return stub


def _row_count() -> int:
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM content_teaching_analysis"
        ).fetchone()[0]


def _rows() -> list[tuple]:
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        return conn.execute(
            "SELECT content_ref, content_hash, level, target_lang, analysis_version "
            "FROM content_teaching_analysis ORDER BY level"
        ).fetchall()


def _seed_cache(
    history_dir,
    *,
    video_id: str = VIDEO_ID,
    blocks: list[dict] | None = None,
    lang: str = "zh-CN",
    summary: str = "测试总结",
    filename: str | None = None,
) -> str:
    directory = str(history_dir)
    path = f"{directory}/{filename or f'Test_Channel_20240101_{video_id}.json'}"
    payload = {
        "videoId": video_id,
        "metadata": {
            "title": TITLE,
            "channel": "Test Channel",
            "upload_date": "20240101",
            "thumbnail": "",
        },
        "transcript": copy.deepcopy(blocks if blocks is not None else BLOCKS),
        "summary": summary,
        "model": "deepseek-chat",
        "studyCount": 1,
        "target_lang": lang,
    }
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    return path


def _sse_events(response) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    current = None
    for line in response.text.splitlines():
        if line.startswith("event: "):
            current = line[len("event: "):]
        elif line.startswith("data: ") and current:
            events.append((current, json.loads(line[len("data: "):])))
            current = None
    return events


# ---------------------------------------------------------------------------
# 1. 迁移 0020
# ---------------------------------------------------------------------------

def test_migration_0020_schema_and_downgrade(tmp_path):
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    assert revision(db) == "0022_generated_courses"
    assert "content_teaching_analysis" in table_names(db)

    columns_ = columns(db, "content_teaching_analysis")
    assert list(columns_) == [
        "id",
        "content_ref",
        "content_hash",
        "level",
        "target_lang",
        "analysis_version",
        "payload_json",
        "created_at",
    ]
    for required in (
        "content_ref",
        "content_hash",
        "level",
        "target_lang",
        "analysis_version",
        "payload_json",
        "created_at",
    ):
        assert columns_[required]["notnull"] == 1, required
    assert columns_["id"]["pk"] == 1
    assert columns_["analysis_version"]["default"] == "'analysis.v1'"
    assert "ix_content_teaching_analysis_ref" in index_names(
        db, "content_teaching_analysis"
    )

    # 唯一缓存键：同 (content_hash, level, target_lang, analysis_version) 只能一行。
    with sqlite3.connect(db) as conn:
        row = (
            "id-1", "ref-1", "hash-1", "moonwalk", "zh-CN", "analysis.v1", "{}", 1
        )
        conn.execute(
            "INSERT INTO content_teaching_analysis "
            "(id, content_ref, content_hash, level, target_lang, analysis_version, "
            "payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            row,
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO content_teaching_analysis "
                "(id, content_ref, content_hash, level, target_lang, "
                "analysis_version, payload_json, created_at) "
                "VALUES ('id-2', 'ref-2', 'hash-1', 'moonwalk', 'zh-CN', "
                "'analysis.v1', '{}', 2)"
            )

    # 回滚只删 0020 的表，0019 的公版书译文表保留。
    assert_alembic_ok(
        run_alembic(db, "downgrade", "0019_book_chapter_translations"),
        "downgrade 0019",
    )
    assert revision(db) == "0019_book_chapter_translations"
    assert "content_teaching_analysis" not in table_names(db)
    assert "book_chapter_translations" in table_names(db)


def test_migration_0020_reupgrade_is_idempotent(tmp_path):
    db = tmp_path / "app.db"
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    first = columns(db, "content_teaching_analysis")
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head (again)")
    assert columns(db, "content_teaching_analysis") == first


# ---------------------------------------------------------------------------
# 2/3. content_hash / 等级 / 语言
# ---------------------------------------------------------------------------

def test_content_hash_is_stable_and_changes_with_content():
    first = teaching_analysis.content_hash(BLOCKS)
    assert first == teaching_analysis.content_hash(copy.deepcopy(BLOCKS))
    assert len(first) == 32

    changed = copy.deepcopy(BLOCKS)
    changed[0]["en_text"] = "A completely different opening sentence."
    assert teaching_analysis.content_hash(changed) != first

    # 只改译文不改变内容 hash（合并时会按当前译文重新校验 zh_word）。
    translated = copy.deepcopy(BLOCKS)
    translated[0]["zh_text"] = "完全不同的中文译文。"
    assert teaching_analysis.content_hash(translated) == first

    # block id 参与哈希：同样正文换 id 不会把分析串到另一份内容上。
    rekeyed = copy.deepcopy(BLOCKS)
    rekeyed[0]["id"] = 99
    assert teaching_analysis.content_hash(rekeyed) != first


def test_normalize_level_accepts_canonical_and_legacy_aliases():
    assert teaching_analysis.normalize_level("liftoff") == "liftoff"
    assert teaching_analysis.normalize_level("moonwalk") == "moonwalk"
    assert teaching_analysis.normalize_level("supernova") == "supernova"
    assert teaching_analysis.normalize_level("cet4") == "liftoff"
    assert teaching_analysis.normalize_level("advanced") == "deep-space"
    assert teaching_analysis.normalize_level(None) == teaching_analysis.DEFAULT_LEVEL == "orbit"


def test_normalize_level_and_language_reject_invalid_values():
    with pytest.raises(teaching_analysis.AnalysisInvalidRequest):
        teaching_analysis.normalize_level("z9")
    with pytest.raises(teaching_analysis.AnalysisInvalidRequest):
        teaching_analysis.canonical_target_lang("xx-XX")


# ---------------------------------------------------------------------------
# 4. prompt
# ---------------------------------------------------------------------------

def test_analysis_prompt_states_level_rules_and_block_input():
    normalized = teaching_analysis.normalize_blocks(BLOCKS)
    prompt = teaching_analysis.build_prompt(normalized[:1], "moonwalk", "zh-CN")
    assert "CEFR B1" in prompt  # 该等级的词汇量描述（只标高于它的词）
    assert "language-points" in prompt
    assert "Simplified Chinese" in prompt or "Chinese" in prompt
    assert "blockId" in prompt
    assert "en_word" not in prompt and "zh_word" not in prompt
    assert "Do not return \"highlights\"" in prompt
    assert "idioms" in prompt and "culture" in prompt
    assert "quote" in prompt
    assert "never" in prompt.lower()
    assert BLOCKS[0]["en_text"] in prompt
    assert BLOCKS[0]["zh_text"] in prompt


# ---------------------------------------------------------------------------
# 5. 校验闸
# ---------------------------------------------------------------------------

def test_validate_ignores_legacy_highlights():
    normalized = teaching_analysis.normalize_blocks(BLOCKS)
    raw = json.dumps({
        "highlights": [
            # 合法
            {"blockId": 1, "en_word": "museum", "zh_word": "博物馆"},
            # en 不在原文 → 丢
            {"blockId": 1, "en_word": "castle", "zh_word": "城堡"},
            # zh 不在译文 → 保留 en、zh 置空
            {"blockId": 2, "en_word": "tickets", "zh_word": "门票"},
            # 未知 block → 丢
            {"blockId": 99, "en_word": "tickets", "zh_word": "门票"},
            # 空 en → 丢
            {"blockId": 1, "en_word": "", "zh_word": "博物馆"},
        ]
    }, ensure_ascii=False)
    result = teaching_analysis.validate_analysis(raw, normalized)
    assert result["highlights"] == {}
    assert result["idioms"] == [] and result["culture"] == []


def test_validate_ignores_legacy_highlights_case():
    """与旧翻译高亮校验口径一致：大小写不同不算原文子串，丢弃。"""
    normalized = teaching_analysis.normalize_blocks(BLOCKS)
    result = teaching_analysis.validate_analysis(
        {"highlights": [{"blockId": 1, "en_word": "MUSEUM", "zh_word": "博物馆"}]},
        normalized,
    )
    assert result["highlights"] == {}


def test_validate_ignores_legacy_highlight_caps():
    normalized = teaching_analysis.normalize_blocks(BLOCKS)
    raw = {
        "highlights": [
            {"blockId": 1, "en_word": "museum", "zh_word": "博物馆", "color": "red"},
            {"blockId": 1, "en_word": "museum", "zh_word": "博物馆"},
            {"blockId": 1, "en_word": "opens", "zh_word": "开门"},
            {"blockId": 1, "en_word": "nine", "zh_word": "九点"},
            {"blockId": 1, "en_word": "morning", "zh_word": "早上"},
        ]
    }
    assert teaching_analysis.validate_analysis(raw, normalized)["highlights"] == {}


def test_validate_drops_idioms_and_culture_without_source_quote():
    normalized = teaching_analysis.normalize_blocks(BLOCKS)
    raw = {
        "highlights": [],
        "idioms": [
            {"blockId": 1, "phrase": "opens at nine", "meaning": "九点开门",
             "quote": "The museum opens at nine"},
            {"blockId": 1, "phrase": "made up", "meaning": "编的",
             "quote": "This quote is not in the text"},
            {"blockId": 2, "phrase": "buy tickets", "meaning": "买票",
             "quote": "Visitors can buy tickets"},
        ],
        "culture": [
            {"blockId": 2, "term": "front desk", "note": "前台",
             "quote": "at the front desk"},
            {"blockId": 2, "term": "castle", "note": "城堡",
             "quote": "a castle"},
            {"blockId": 2, "term": "", "note": "空", "quote": "buy tickets"},
        ],
    }
    result = teaching_analysis.validate_analysis(raw, normalized)
    assert [item["phrase"] for item in result["idioms"]] == [
        "opens at nine",
        "buy tickets",
    ]
    assert [item["term"] for item in result["culture"]] == ["front desk"]


def test_validate_ignores_legacy_grouped_highlights():
    normalized = teaching_analysis.normalize_blocks(BLOCKS)
    raw = {
        "highlights": {
            "1": [{"en_word": "museum", "zh_word": "博物馆"}],
            "2": [{"en_word": "tickets", "zh_word": "门票"}],
        }
    }
    result = teaching_analysis.validate_analysis(raw, normalized)
    assert result["highlights"] == {}


def test_merge_parts_caps_idioms_at_twenty_and_culture_at_ten():
    part = {
        "highlights": {},
        "idioms": [
            {"blockId": 1, "phrase": f"p{i}", "meaning": "m", "quote": "q"}
            for i in range(30)
        ],
        "culture": [
            {"blockId": 1, "term": f"t{i}", "note": "n", "quote": "q"}
            for i in range(15)
        ],
    }
    merged = teaching_analysis._merge_parts([part])
    assert len(merged["idioms"]) == teaching_analysis.MAX_IDIOMS == 20
    assert len(merged["culture"]) == teaching_analysis.MAX_CULTURE == 10


# ---------------------------------------------------------------------------
# 6/7. ensure：缓存、等级/语言/内容隔离、并发
# ---------------------------------------------------------------------------

def test_ensure_generates_once_then_cache_hit_is_free(analysis_db, llm_stub):
    async def run():
        first = await teaching_analysis.ensure_analysis(
            BLOCKS, "moonwalk", "zh-CN", content_ref=VIDEO_ID
        )
        second = await teaching_analysis.ensure_analysis(
            BLOCKS, "moonwalk", "zh-CN"
        )
        return first, second

    first, second = asyncio.run(run())
    assert len(llm_stub.prompts) == 1
    assert first == second
    assert first["analysisVersion"] == "analysis.v2"
    assert first["level"] == "moonwalk"
    assert first["targetLang"] == "zh-CN"
    assert first["contentHash"] == teaching_analysis.content_hash(BLOCKS)
    assert first["highlights"] == {}  # analysis.v2 no longer emits inline highlights
    assert first["idioms"] and first["culture"]
    assert _row_count() == 1


def test_ensure_level_isolation_regenerates(analysis_db, llm_stub):
    async def run():
        moon = await teaching_analysis.ensure_analysis(BLOCKS, "moonwalk", "zh-CN")
        inter = await teaching_analysis.ensure_analysis(BLOCKS, "interstellar", "zh-CN")
        moon_again = await teaching_analysis.ensure_analysis(BLOCKS, "moonwalk", "zh-CN")
        return moon, inter, moon_again

    moon, inter, moon_again = asyncio.run(run())
    assert len(llm_stub.prompts) == 2
    assert moon["level"] == "moonwalk"
    assert inter["level"] == "interstellar"
    assert inter["contentHash"] == moon["contentHash"]
    assert moon_again == moon
    assert {row[2] for row in _rows()} == {"moonwalk", "interstellar"}


def test_ensure_target_language_isolation(analysis_db, llm_stub):
    async def run():
        zh = await teaching_analysis.ensure_analysis(BLOCKS, "moonwalk", "zh-CN")
        vi = await teaching_analysis.ensure_analysis(BLOCKS, "moonwalk", "vi-VN")
        return zh, vi

    zh, vi = asyncio.run(run())
    assert len(llm_stub.prompts) == 2
    assert zh["targetLang"] == "zh-CN"
    assert vi["targetLang"] == "vi-VN"
    assert "Vietnamese" in llm_stub.prompts[1]
    assert {(row[2], row[3]) for row in _rows()} == {
        ("moonwalk", "zh-CN"),
        ("moonwalk", "vi-VN"),
    }


def test_ensure_content_change_regenerates(analysis_db, llm_stub):
    changed = copy.deepcopy(BLOCKS)
    changed[0]["en_text"] = "A completely different opening sentence."

    async def run():
        await teaching_analysis.ensure_analysis(BLOCKS, "moonwalk", "zh-CN")
        await teaching_analysis.ensure_analysis(changed, "moonwalk", "zh-CN")

    asyncio.run(run())
    assert len(llm_stub.prompts) == 2
    hashes = {row[1] for row in _rows()}
    assert hashes == {
        teaching_analysis.content_hash(BLOCKS),
        teaching_analysis.content_hash(changed),
    }


def test_ensure_rejects_mismatched_content_hash(analysis_db, llm_stub):
    async def run():
        await teaching_analysis.ensure_analysis(
            BLOCKS, "moonwalk", "zh-CN", content_hash="deadbeef"
        )

    with pytest.raises(teaching_analysis.AnalysisInvalidRequest):
        asyncio.run(run())
    assert llm_stub.prompts == []
    assert _row_count() == 0


def test_ensure_failure_is_not_cached_and_can_retry(analysis_db, llm_stub):
    llm_stub.fail = True

    async def fail():
        await teaching_analysis.ensure_analysis(BLOCKS, "moonwalk", "zh-CN")

    with pytest.raises(teaching_analysis.AnalysisFailed):
        asyncio.run(fail())
    assert _row_count() == 0, "失败不写半成品，下次可重试"

    llm_stub.fail = False
    result = asyncio.run(
        teaching_analysis.ensure_analysis(BLOCKS, "moonwalk", "zh-CN")
    )
    assert result["highlights"] == {}
    assert _row_count() == 1


def test_ensure_concurrent_calls_generate_once(analysis_db, llm_stub):
    llm_stub.delay = 0.02

    async def run():
        return await asyncio.gather(
            teaching_analysis.ensure_analysis(BLOCKS, "moonwalk", "zh-CN"),
            teaching_analysis.ensure_analysis(BLOCKS, "moonwalk", "zh-CN"),
        )

    first, second = asyncio.run(run())
    assert len(llm_stub.prompts) == 1
    assert first == second
    assert _row_count() == 1


def test_ensure_without_migration_is_unavailable(client, llm_stub):
    async def run():
        await teaching_analysis.ensure_analysis(BLOCKS, "moonwalk", "zh-CN")

    with pytest.raises(teaching_analysis.AnalysisUnavailable):
        asyncio.run(run())
    assert llm_stub.prompts == []


def test_cache_hit_does_not_consume_quota(analysis_db, llm_stub, monkeypatch):
    consumed: list[tuple] = []

    def fake_quota(user_id, feature, units=1, **kwargs):
        consumed.append((user_id, feature, units, kwargs))

    monkeypatch.setattr(
        teaching_analysis.quota, "check_and_consume_quota", fake_quota
    )

    async def run():
        await teaching_analysis.ensure_analysis(BLOCKS, "moonwalk", "zh-CN", user_id="u1")
        await teaching_analysis.ensure_analysis(BLOCKS, "moonwalk", "zh-CN", user_id="u1")
        await teaching_analysis.ensure_analysis(BLOCKS, "orbit", "zh-CN", user_id="u1")

    asyncio.run(run())
    assert [(item[1], item[2]) for item in consumed] == [("analysis", 1), ("analysis", 1)]


# ---------------------------------------------------------------------------
# 8. 合并进 payload
# ---------------------------------------------------------------------------

def test_merge_into_payload_clears_legacy_highlights():
    payload = {
        "videoId": VIDEO_ID,
        "transcript": copy.deepcopy(BLOCKS),
    }
    # 旧翻译缓存里可能残留的旧等级高亮。
    payload["transcript"][1]["highlights"] = [
        {"en_word": "Visitors", "zh_word": "", "color": "old"}
    ]
    analysis = {
        "analysisVersion": "analysis.v2",
        "level": "moonwalk",
        "highlights": {
            "1": [
                {"en_word": "museum", "zh_word": "博物馆"},
                {"en_word": "not-in-text", "zh_word": "博物馆"},
            ],
            "2": [],
        },
        "idioms": [
            {"blockId": 1, "phrase": "opens at nine", "meaning": "九点开门",
             "quote": "The museum opens at nine"},
        ],
        "culture": [
            {"blockId": 2, "term": "front desk", "note": "前台",
             "quote": "at the front desk"},
        ],
    }
    assert teaching_analysis.merge_into_payload(payload, analysis) is True

    assert payload["transcript"][0]["highlights"] == []
    # v2 clears all legacy highlights.
    assert payload["transcript"][1]["highlights"] == []
    assert payload["idioms"][0]["phrase"] == "opens at nine"
    assert payload["culture"][0]["term"] == "front desk"
    assert payload["analysisVersion"] == "analysis.v2"


def test_merge_into_payload_keeps_old_cache_compatible():
    """没有分析结果时旧 payload 原样返回（不凭空加字段/不清旧高亮）。"""
    payload = {"transcript": copy.deepcopy(BLOCKS)}
    payload["transcript"][0]["highlights"] = [
        {"en_word": "museum", "zh_word": "博物馆", "color": HIGHLIGHT_COLOR}
    ]
    assert teaching_analysis.merge_into_payload(payload, None) is False
    assert "idioms" not in payload
    assert "analysisVersion" not in payload
    assert payload["transcript"][0]["highlights"]


def test_attach_to_payload_skips_when_table_missing(client):
    payload = {"transcript": copy.deepcopy(BLOCKS)}
    result = asyncio.run(
        teaching_analysis.attach_to_payload(
            payload, level="moonwalk", target_lang="zh-CN"
        )
    )
    assert result is None
    assert "idioms" not in payload


# ---------------------------------------------------------------------------
# 9. 翻译只负责译文
# ---------------------------------------------------------------------------

def test_translation_prompt_no_longer_requests_highlights(monkeypatch):
    prompts: list[str] = []

    async def fake_generate(prompt, model=None):
        prompts.append(prompt)
        return json.dumps({"blocks": [
            {"id": 1, "en_text": BLOCKS[0]["en_text"], "zh_text": "博物馆九点开门。"}
        ]}, ensure_ascii=False)

    monkeypatch.setattr(llm, "generate_json_async", fake_generate)
    result = asyncio.run(translate.process_llm_batch(
        [{"id": 1, "start": 0.0, "end": 2.0, "text": BLOCKS[0]["en_text"]}],
        model="deepseek-chat",
        vocab_level="moonwalk",
    ))
    assert result[0]["zh_text"] == "博物馆九点开门。"
    assert result[0]["highlights"] == []
    prompt = prompts[0]
    assert "en_word" not in prompt and "zh_word" not in prompt
    assert "Identify 0 to 2" not in prompt
    assert "translation" in prompt.lower()


# ---------------------------------------------------------------------------
# 10. 端到端：缓存视频流 / 新视频流 / API
# ---------------------------------------------------------------------------

def test_cached_stream_merges_analysis_and_zero_extra_calls(
    analysis_db, history_dir, llm_stub
):
    _seed_cache(history_dir)

    def stream(level: str):
        response = analysis_db.post(
            "/api/process-video-stream",
            json={"url": URL, "vocab_level": level},
        )
        assert response.status_code == 200, response.text
        return _sse_events(response)

    first = stream("moonwalk")
    meta = dict(first)["meta"]
    assert len(llm_stub.prompts) == 1
    assert not any(block["highlights"] for block in meta["blocks"])
    written = json.loads(
        (history_dir / f"Test_Channel_20240101_{VIDEO_ID}.json").read_text(
            encoding="utf-8"
        )
    )
    assert written["analysisVersion"] == "analysis.v2"
    assert written["idioms"] and written["culture"]
    assert not any(block["highlights"] for block in written["transcript"])

    second = stream("moonwalk")
    assert len(llm_stub.prompts) == 1, "同内容+等级+语言第二次必须零模型调用"
    assert dict(second)["meta"]["blocks"][0]["highlights"] == meta["blocks"][0]["highlights"] == []

    third = stream("interstellar")
    assert len(llm_stub.prompts) == 2, "换等级必须重新生成"
    assert dict(third)["meta"]["blocks"][0]["highlights"] == []
    assert len(_rows()) == 2


def test_cached_stream_legacy_payload_without_analysis_is_unchanged(
    client, history_dir, llm_stub
):
    """未跑 0020 迁移（旧部署/旧缓存）：旧 highlights 原样返回，不阻断播放。"""
    legacy_blocks = copy.deepcopy(BLOCKS)
    legacy_blocks[0]["highlights"] = [{
        "en_word": "museum", "zh_word": "博物馆", "color": HIGHLIGHT_COLOR,
    }]
    _seed_cache(history_dir, blocks=legacy_blocks)

    response = client.post(
        "/api/process-video-stream", json={"url": URL, "vocab_level": "moonwalk"}
    )
    assert response.status_code == 200, response.text
    meta = dict(_sse_events(response))["meta"]
    assert meta["blocks"][0]["highlights"] == legacy_blocks[0]["highlights"]
    assert llm_stub.prompts == []
    written = json.loads(
        (history_dir / f"Test_Channel_20240101_{VIDEO_ID}.json").read_text(
            encoding="utf-8"
        )
    )
    assert "analysisVersion" not in written


def test_fresh_stream_attaches_analysis_after_translation(
    analysis_db, history_dir, llm_stub, monkeypatch
):
    transcript = [
        SimpleNamespace(
            text="The museum opens at nine in the morning.", start=0.0, duration=2.0
        ),
        SimpleNamespace(
            text="Visitors can buy tickets at the front desk.", start=2.0, duration=2.0
        ),
    ]
    translation_calls: list[list[int]] = []

    async def fake_translate(blocks, model=None, vocab_level=None, **kwargs):
        translation_calls.append([block["id"] for block in blocks])
        return [
            {
                "id": block["id"],
                "start": block["start"],
                "end": block["end"],
                "en_text": block["text"],
                "zh_text": BLOCKS[block["id"] - 1]["zh_text"],
                "highlights": [],
            }
            for block in blocks
        ]

    async def fake_summary(blocks, model=None, **kwargs):
        return "测试总结"

    monkeypatch.setattr(translate, "process_llm_batch", fake_translate)
    monkeypatch.setattr(routes_videos, "summarize_video_transcript", fake_summary)
    monkeypatch.setattr(
        routes_videos, "fetch_english_transcript", lambda video_id: transcript
    )
    monkeypatch.setattr(
        routes_videos,
        "get_video_metadata",
        lambda url: {
            "title": TITLE,
            "channel": "Test Channel",
            "upload_date": "20240101",
            "thumbnail": "",
        },
    )
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)

    response = analysis_db.post(
        "/api/process-video-stream", json={"url": URL, "vocab_level": "moonwalk"}
    )
    assert response.status_code == 200, response.text
    events = _sse_events(response)
    names = [name for name, _ in events]
    assert names[0] == "meta" and names[-1] == "done"
    assert names.count("batch") >= 2, "翻译批次之后应再推一次带高亮的分析合并事件"
    last_batch = [data for name, data in events if name == "batch"][-1]
    assert not any(block["highlights"] for block in last_batch["blocks"])
    assert len(translation_calls) == 1
    assert len(llm_stub.prompts) == 1

    written = json.loads(
        (history_dir / f"Test_Channel_20240101_{VIDEO_ID}.json").read_text(
            encoding="utf-8"
        )
    )
    assert written["analysisVersion"] == "analysis.v2"
    assert written["idioms"] and written["culture"]


def test_api_requires_login(make_client, analysis_db, history_dir):
    _seed_cache(history_dir)
    with make_client() as anonymous:
        response = anonymous.get(
            f"/api/teaching-analysis/{VIDEO_ID}", params={"level": "moonwalk"}
        )
    assert response.status_code == 403


def test_api_returns_analysis_and_caches(analysis_db, history_dir, llm_stub):
    _seed_cache(history_dir)
    first = analysis_db.get(
        f"/api/teaching-analysis/{VIDEO_ID}",
        params={"level": "moonwalk", "targetLang": "zh-CN"},
    )
    assert first.status_code == 200, first.text
    payload = first.json()
    assert payload["contentRef"] == VIDEO_ID
    assert payload["level"] == "moonwalk"
    assert payload["analysisVersion"] == "analysis.v2"
    assert payload["highlights"] == {} and payload["idioms"] and payload["culture"]
    assert len(llm_stub.prompts) == 1

    second = analysis_db.get(
        f"/api/teaching-analysis/{VIDEO_ID}",
        params={"level": "moonwalk", "contentHash": payload["contentHash"]},
    )
    assert second.status_code == 200
    assert second.json()["contentHash"] == payload["contentHash"]
    assert len(llm_stub.prompts) == 1, "缓存命中不得再调模型"


def test_api_different_level_regenerates(analysis_db, history_dir, llm_stub):
    _seed_cache(history_dir)
    first = analysis_db.get(
        f"/api/teaching-analysis/{VIDEO_ID}", params={"level": "liftoff"}
    )
    second = analysis_db.get(
        f"/api/teaching-analysis/{VIDEO_ID}", params={"level": "supernova"}
    )
    assert first.status_code == 200 and second.status_code == 200
    assert first.json()["level"] == "liftoff"
    assert second.json()["level"] == "supernova"
    assert len(llm_stub.prompts) == 2


def test_api_validation_and_not_found(analysis_db, history_dir, llm_stub):
    _seed_cache(history_dir)
    assert analysis_db.get(
        "/api/teaching-analysis/does-not-exist", params={"level": "moonwalk"}
    ).status_code == 404
    assert analysis_db.get(
        f"/api/teaching-analysis/{VIDEO_ID}", params={"level": "z9"}
    ).status_code == 400
    assert analysis_db.get(
        f"/api/teaching-analysis/{VIDEO_ID}", params={"targetLang": "xx-XX"}
    ).status_code == 400
    bad_hash = analysis_db.get(
        f"/api/teaching-analysis/{VIDEO_ID}",
        params={"level": "moonwalk", "contentHash": "deadbeef"},
    )
    assert bad_hash.status_code == 400
    assert llm_stub.prompts == []


def test_api_without_migration_is_503(client, history_dir, llm_stub):
    _seed_cache(history_dir)
    response = client.get(
        f"/api/teaching-analysis/{VIDEO_ID}", params={"level": "moonwalk"}
    )
    assert response.status_code == 503
    assert llm_stub.prompts == []


def test_api_supports_local_show_ref(analysis_db, history_dir, llm_stub):
    _seed_cache(
        history_dir,
        video_id="demo-show-S01E01",
        filename="demo-show_S01E01.json",
    )
    response = analysis_db.get(
        "/api/teaching-analysis/demo-show-S01E01", params={"level": "orbit"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["contentRef"] == "demo-show-S01E01"
    assert response.json()["level"] == "orbit"
