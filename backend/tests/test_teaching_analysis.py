"""AI 教学分析（高亮/习语/文化点）离线验收（specs/028）。

覆盖：

1. 迁移 0020：表/列/唯一缓存键/索引/回滚/重复迁移幂等；
2. content_hash：同内容稳定、内容变化/prompt 版本维度隔离；
3. 等级/语言归一化：六档 + 旧考试 id 映射、非法值 400、默认档 orbit；
4. prompt：内容级 prompt 用六档候选词并集、无等级阈值；v5 回退 prompt 仍
   带等级描述；quote 必须能在原文找到、目标语言名；
5. 校验闸：en_word/zh_word/quote 子串约束、未知 block 丢弃、译文找不到时
   **整条丢弃**（无释义不标）、颜色强制、单 block ≤20 条、习语 20/文化点 10 上限；
6. 候选词：非句首专名不入候选、句首普通词保留、语料级句首专名兜底
   （Toto 型；长内容分批仍按整篇统计）、与 classify 同源（同一 word_rules
   规则）；
7. 内容级缓存（P2-37）：六档连续只 1 次模型调用、1 行内容级缓存；每档
   payload 的词集合 = 该档旧候选规则（本地筛选等价）；idioms/culture 只生成
   一次并复用；空 gloss/失败/并发/配额口径；
8. 旧缓存兼容：analysis.v5 per-level 行在回退开关下可读、不删除；内容级
   模式下按新版本重生成；
9. 失败不写半成品、可重试；缺 0020 表时 AnalysisUnavailable（内部静默跳过）；
10. 合并：按 block id 覆盖 highlights、清掉旧等级残留、idioms/culture/
    analysisVersion 写进 payload；旧缓存没有分析字段时保持原样；旧版本
    合并字段（v4）在升级合并时丢弃、旧版本分析不写入；
11. 端到端：翻译 prompt 不再请求 highlights；流式处理在翻译后合并分析并落盘；
    GET /api/teaching-analysis（登录、缓存命中免费、换等级零模型调用）。

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
import word_rules
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
    highlights: list[dict] = []
    idioms: list[dict] = []
    culture: list[dict] = []
    for block in blocks:
        en = block.get("en", "")
        zh = block.get("zh", "")
        for word in block.get("candidates", []):
            highlights.append({
                "blockId": block["blockId"],
                "en_word": word,
                # 中文译文取前两个字符（一定是子串）；没有译文时留空。
                "zh_word": zh[:2],
            })
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
    return {"highlights": highlights, "idioms": idioms, "culture": culture}


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
    assert revision(db) == "0032_pipeline_timing"
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
    """v5 回退 prompt 仍按等级描述（旧路径行为不变）。"""
    normalized = teaching_analysis.normalize_blocks(BLOCKS)
    prompt = teaching_analysis.build_prompt(normalized[:1], "moonwalk", "zh-CN")
    assert "CEFR B1" in prompt  # 该等级的词汇量描述（只标高于它的词）
    assert "candidates" in prompt
    assert "Simplified Chinese" in prompt or "Chinese" in prompt
    assert "blockId" in prompt
    assert "en_word" in prompt and "zh_word" in prompt
    assert "quote" in prompt
    assert "never" in prompt.lower()
    assert BLOCKS[0]["en_text"] in prompt
    assert BLOCKS[0]["zh_text"] in prompt


def test_content_prompt_uses_candidate_union_without_level_filter():
    """内容级 prompt：候选词 = 六档并集、无等级阈值；输出是 glosses 字典。"""
    normalized = teaching_analysis.normalize_blocks(BLOCKS)
    union = teaching_analysis._content_candidates_for_blocks(normalized)
    prompt = teaching_analysis.build_content_prompt(normalized, "zh-CN", union)
    blocks = json.loads(prompt.rsplit("Blocks:\n", 1)[-1])
    by_id = {str(block["blockId"]): block for block in blocks}
    assert by_id["1"]["candidates"] == union["1"]
    assert by_id["2"]["candidates"] == union["2"]
    # 并集覆盖每一档的候选词（否则高等级的释义会缺）。
    for level in teaching_analysis.LEVEL_IDS:
        per_level = teaching_analysis._candidate_words_for_blocks(normalized, level)
        for block_id, words in per_level.items():
            assert set(union[block_id]) >= set(words)
    # 不做等级筛选：prompt 不得出现等级阈值说明。
    assert "LEARNER LEVEL" not in prompt
    assert "glosses" in prompt and "idioms" in prompt and "culture" in prompt
    assert "en_word" in prompt and "zh_word" in prompt and "quote" in prompt
    assert "Simplified Chinese" in prompt or "Chinese" in prompt
    assert BLOCKS[0]["en_text"] in prompt and BLOCKS[0]["zh_text"] in prompt


# ---------------------------------------------------------------------------
# 5. 候选词（word_rules 单一规则）
# ---------------------------------------------------------------------------

def test_candidate_words_exclude_proper_nouns_but_keep_sentence_initial_words():
    """非句首专名不入候选；句首大写普通词照常按等级入选（liftoff）。"""
    blocks = [
        {
            "id": 1,
            "en_text": "I saw Georgie and Gridley near the river.",
            "zh_text": "我在河边看见了乔治和格里德利。",
        },
        {
            "id": 2,
            "en_text": "Visitors can buy tickets at the front desk.",
            "zh_text": "游客可以在前台买票。",
        },
    ]
    normalized = teaching_analysis.normalize_blocks(blocks)
    candidates = teaching_analysis._candidate_words_for_blocks(normalized, "liftoff")
    # Georgie / Gridley 是 C1+（高于 A1），若没有专名规则会入选；
    # 现在它们是非句首专名 → 不入候选。
    assert "Georgie" not in candidates.get("1", [])
    assert "Gridley" not in candidates.get("1", [])
    assert candidates["2"][0] == "Visitors"  # 句首大写普通词保留
    assert "tickets" in candidates["2"]
    assert "the" not in candidates["2"]


def test_candidate_words_use_corpus_level_fallback_for_sentence_initial_proper():
    """specs/004 v1.1：Toto 型（句首出现、全文从未小写、另有非句首大写）不入候选。"""
    blocks = [{
        "id": 1,
        "en_text": (
            "Toto was a little dog. Dorothy looked at Toto. "
            "The little dog Toto barked at the visitors."
        ),
        "zh_text": "托托是一只小狗。多萝西看着托托。小狗托托对访客叫。",
    }]
    normalized = teaching_analysis.normalize_blocks(blocks)
    candidates = teaching_analysis._candidate_words_for_blocks(normalized, "liftoff")
    words = candidates.get("1", [])
    assert "Toto" not in words
    # 对照：Dorothy 只在句首出现、没有非句首大写实例 → 词形信息不足，仍按普通词。
    assert "Dorothy" in words


def test_candidate_words_match_classify_for_the_same_text(client):
    """候选集合与 POST /api/vocabulary/classify 同源：同一 rule 向量。"""
    text = ("Yesterday Georgie met Gridley in London. "
            "Visitors can buy tickets at the front desk. "
            "Toto barked at Georgie, then Toto ran away.")
    normalized = teaching_analysis.normalize_blocks([
        {"id": 1, "en_text": text, "zh_text": "游客在伦敦的前台买票。"}
    ])
    candidates = teaching_analysis._candidate_words_for_blocks(
        normalized, "liftoff"
    ).get("1", [])

    # 与前端 collectReadingTokens 相同的两条语料级事实（观察，不判定）。
    facts: dict[str, tuple[bool, bool]] = {}
    for token, sentence_start in word_rules.iter_words(text):
        key = token.casefold()
        has_lowercase, has_non_initial_capital = facts.get(key, (False, False))
        if token[0].islower():
            has_lowercase = True
        if token[0].isupper() and not sentence_start:
            has_non_initial_capital = True
        facts[key] = (has_lowercase, has_non_initial_capital)

    items = [
        {
            "text": token,
            "sentenceStart": sentence_start,
            "hasLowercase": facts[token.casefold()][0],
            "hasNonInitialCapital": facts[token.casefold()][1],
        }
        for token, sentence_start in word_rules.iter_words(text)
    ]
    response = client.post("/api/vocabulary/classify", json={"items": items})
    assert response.status_code == 200, response.text
    classified = response.json()["items"]

    expected: list[str] = []
    seen: set[str] = set()
    for item in classified:
        rank = teaching_analysis._WORD_LEVEL_RANK.get(
            str(item.get("level") or "").upper()
        )
        if item.get("proper") or rank is None or rank <= 0:  # liftoff 阈值 = A1
            continue
        key = str(item["text"]).casefold()
        if key in seen:
            continue
        seen.add(key)
        expected.append(item["text"])

    assert candidates == expected
    assert "Georgie" not in candidates and "Gridley" not in candidates
    assert "Toto" not in candidates  # 句首 + 非句首大写 + 从未小写 → 专名
    assert "Visitors" in candidates


# ---------------------------------------------------------------------------
# 6. 校验闸
# ---------------------------------------------------------------------------

def test_validate_drops_highlights_without_a_matching_gloss():
    """specs/028：zh_word 在译文里找不到 → 整条丢弃（无释义不标）。"""
    normalized = teaching_analysis.normalize_blocks(BLOCKS)
    raw = json.dumps({
        "highlights": [
            # 合法
            {"blockId": 1, "en_word": "museum", "zh_word": "博物馆"},
            # en 不在原文 → 丢
            {"blockId": 1, "en_word": "castle", "zh_word": "城堡"},
            # zh 不在译文 → 整条丢（旧行为是置空保留 en）
            {"blockId": 2, "en_word": "tickets", "zh_word": "门票"},
            # 空 zh → 丢
            {"blockId": 1, "en_word": "morning", "zh_word": ""},
            # 未知 block → 丢
            {"blockId": 99, "en_word": "tickets", "zh_word": "门票"},
            # 空 en → 丢
            {"blockId": 1, "en_word": "", "zh_word": "博物馆"},
        ]
    }, ensure_ascii=False)
    result = teaching_analysis.validate_analysis(raw, normalized)
    # 只有 block 1 的 museum 通过校验；block 2 没有任何可核对释义 → 不出现。
    assert result["highlights"] == {
        "1": [{
            "en_word": "museum",
            "zh_word": "博物馆",
            "color": HIGHLIGHT_COLOR,
        }]
    }
    assert "2" not in result["highlights"]


def test_validate_highlights_is_case_sensitive_like_old_translation():
    """与旧翻译高亮校验口径一致：大小写不同不算原文子串，丢弃。"""
    normalized = teaching_analysis.normalize_blocks(BLOCKS)
    result = teaching_analysis.validate_analysis(
        {"highlights": [{"blockId": 1, "en_word": "MUSEUM", "zh_word": "博物馆"}]},
        normalized,
    )
    assert result["highlights"] == {}


def test_validate_caps_and_dedupes_highlights_and_forces_color():
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
    entries = teaching_analysis.validate_analysis(raw, normalized)["highlights"]["1"]
    assert len(entries) >= 4
    assert entries[0]["en_word"] == "museum"
    assert entries[0]["color"] == HIGHLIGHT_COLOR


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


def test_validate_accepts_highlights_grouped_by_block_id():
    normalized = teaching_analysis.normalize_blocks(BLOCKS)
    raw = {
        "highlights": {
            "1": [{"en_word": "museum", "zh_word": "博物馆"}],
            "2": [{"en_word": "tickets", "zh_word": "买票"}],
        }
    }
    result = teaching_analysis.validate_analysis(raw, normalized)
    assert set(result["highlights"]) == {"1", "2"}


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
# 7/8. ensure：缓存、等级/语言/内容隔离、并发
# ---------------------------------------------------------------------------

def test_ensure_generates_once_then_cache_hit_is_free(analysis_db, llm_stub):
    async def run():
        first = await teaching_analysis.ensure_analysis(
            BLOCKS, "liftoff", "zh-CN", content_ref=VIDEO_ID
        )
        second = await teaching_analysis.ensure_analysis(
            BLOCKS, "liftoff", "zh-CN"
        )
        return first, second

    first, second = asyncio.run(run())
    assert len(llm_stub.prompts) == 1
    assert first == second
    assert first["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION
    assert first["level"] == "liftoff"
    assert first["targetLang"] == "zh-CN"
    assert first["contentHash"] == teaching_analysis.content_hash(BLOCKS)
    assert first["highlights"]  # 两个 block 都有高亮
    assert first["idioms"] and first["culture"]
    assert _row_count() == 1
    # 内容级行：level 标记为 __content__，不是 per-level 行。
    assert [row[2] for row in _rows()] == [teaching_analysis.CONTENT_LEVEL]


def test_ensure_analysis_does_not_hit_rows_from_older_analysis_version(
    analysis_db, llm_stub
):
    """specs/028：v4 旧行按新键不命中，不批量回填，按需重生成当前版本。"""
    content_hash_value = teaching_analysis.content_hash(BLOCKS)
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        conn.execute(
            "INSERT INTO content_teaching_analysis "
            "(id, content_ref, content_hash, level, target_lang, analysis_version, "
            "payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "old-v4-row", VIDEO_ID, content_hash_value, "liftoff", "zh-CN",
                "analysis.v4",
                json.dumps({"analysisVersion": "analysis.v4", "highlights": {}}),
                1,
            ),
        )
    result = asyncio.run(
        teaching_analysis.ensure_analysis(BLOCKS, "liftoff", "zh-CN")
    )
    assert result["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION
    assert len(llm_stub.prompts) == 1
    # 旧行保留、新行另写（版本是缓存键的一部分），不删除也不回填。
    assert sorted(row[4] for row in _rows()) == ["analysis.v4", "analysis.v6"]


def test_ensure_analysis_regenerates_payload_with_old_version_marker(
    analysis_db, llm_stub, monkeypatch
):
    """缓存键相同但 payload 自检版本不匹配（手工恢复/旧常量）→ 不复用。"""
    content_hash_value = teaching_analysis.content_hash(BLOCKS)
    stale = {
        "analysisVersion": "analysis.v4",
        "glossAttempted": True,
        "level": teaching_analysis.CONTENT_LEVEL,
        "targetLang": "zh-CN",
        "contentHash": content_hash_value,
        "glosses": {"1": {"museum": "旧版释义"}},
        "idioms": [],
        "culture": [],
        "model": "old-model",
        "createdAt": 1,
    }
    real_load_cached = teaching_analysis.load_cached
    calls = {"count": 0}

    def fake_load_cached(*args, **kwargs):
        calls["count"] += 1
        if calls["count"] == 1:
            return copy.deepcopy(stale)
        return real_load_cached(*args, **kwargs)

    monkeypatch.setattr(teaching_analysis, "load_cached", fake_load_cached)
    result = asyncio.run(
        teaching_analysis.ensure_analysis(BLOCKS, "liftoff", "zh-CN")
    )
    assert result["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION
    assert "旧版释义" not in json.dumps(result, ensure_ascii=False)
    assert len(llm_stub.prompts) == 1


def test_ensure_analysis_candidates_use_the_whole_text_across_batches(
    analysis_db, llm_stub
):
    """长内容分批时语料级兜底仍按整篇统计：非句首实例落在另一批也生效。"""
    blocks = [
        {
            "id": i,
            "en_text": f"This is plain sentence number {i}.",
            "zh_text": "这是普通句子。",
        }
        for i in range(201)
    ]
    blocks[0]["en_text"] = "Toto was a little dog."
    blocks[0]["zh_text"] = "托托是一只小狗。"
    blocks[200]["en_text"] = "I saw Toto yesterday."
    blocks[200]["zh_text"] = "我昨天看见了托托。"
    asyncio.run(teaching_analysis.ensure_analysis(blocks, "liftoff", "zh-CN"))
    assert len(llm_stub.prompts) == 2, "201 blocks must still run in two batches"
    first = json.loads(llm_stub.prompts[0].rsplit("Blocks:\n", 1)[-1])
    second = json.loads(llm_stub.prompts[1].rsplit("Blocks:\n", 1)[-1])
    assert first[0]["blockId"] == 0 and second[0]["blockId"] == 200
    # 句首 Toto 在第一批、非句首大写 Toto 在第二批：整篇统计后两批都不候选。
    assert "Toto" not in first[0]["candidates"]
    assert "Toto" not in second[0]["candidates"]


def test_ensure_level_switch_does_not_regenerate(analysis_db, llm_stub):
    async def run():
        moon = await teaching_analysis.ensure_analysis(BLOCKS, "moonwalk", "zh-CN")
        inter = await teaching_analysis.ensure_analysis(BLOCKS, "interstellar", "zh-CN")
        moon_again = await teaching_analysis.ensure_analysis(BLOCKS, "moonwalk", "zh-CN")
        return moon, inter, moon_again

    moon, inter, moon_again = asyncio.run(run())
    assert len(llm_stub.prompts) == 1, "换等级只做本地筛选，不得调模型"
    assert moon["level"] == "moonwalk"
    assert inter["level"] == "interstellar"
    assert inter["contentHash"] == moon["contentHash"]
    assert moon_again == moon
    assert {row[2] for row in _rows()} == {teaching_analysis.CONTENT_LEVEL}


def test_six_levels_share_one_content_generation(analysis_db, llm_stub, monkeypatch):
    """P2-37 验收：A1–C2 六档连续打开，只 1 次内容级模型调用、1 行缓存。"""
    consumed: list[tuple] = []

    def fake_quota(user_id, feature, units=1, **kwargs):
        consumed.append((user_id, feature, units))

    monkeypatch.setattr(
        teaching_analysis.quota, "check_and_consume_quota", fake_quota
    )

    normalized = teaching_analysis.normalize_blocks(BLOCKS)
    expected_by_level = {
        level: teaching_analysis._candidate_words_for_blocks(normalized, level)
        for level in teaching_analysis.LEVEL_IDS
    }

    async def run():
        results = {}
        for level in teaching_analysis.LEVEL_IDS:
            results[level] = await teaching_analysis.ensure_analysis(
                BLOCKS, level, "zh-CN", user_id="u1"
            )
        return results

    results = asyncio.run(run())
    assert len(llm_stub.prompts) == 1, "六档共用一次内容级生成"
    assert len(consumed) == 1 and consumed[0][1] == "analysis"
    assert _row_count() == 1
    row = _rows()[0]
    assert row[2] == teaching_analysis.CONTENT_LEVEL
    assert row[4] == teaching_analysis.ANALYSIS_VERSION

    # 每档 payload 的词集合/顺序 = 旧 per-level 候选规则（本地筛选等价）。
    for level, payload in results.items():
        assert payload["level"] == level
        assert payload["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION
        expected = expected_by_level[level]
        got = {
            block_id: [item["en_word"] for item in items]
            for block_id, items in payload["highlights"].items()
        }
        assert got == expected, level
    # supernova（C2）无候选词 → 无高亮，但 idioms/culture 仍复用同一份。
    assert results["supernova"]["highlights"] == {}
    assert results["supernova"]["idioms"] == results["liftoff"]["idioms"]
    assert results["supernova"]["culture"] == results["liftoff"]["culture"]


def test_content_cache_stores_gloss_dictionary_and_candidate_union(
    analysis_db, llm_stub
):
    """内容级行存 glosses 字典 + candidateWords（六档并集），不存正文/prompt。"""
    asyncio.run(teaching_analysis.ensure_analysis(BLOCKS, "liftoff", "zh-CN"))
    content_hash_value = teaching_analysis.content_hash(BLOCKS)
    cached = teaching_analysis.load_cached(
        content_hash_value, teaching_analysis.CONTENT_LEVEL, "zh-CN"
    )
    assert cached is not None
    normalized = teaching_analysis.normalize_blocks(BLOCKS)
    union = teaching_analysis._content_candidates_for_blocks(normalized)
    zh_by_block = {str(block["id"]): block["zh"] for block in normalized}
    assert cached["candidateWords"] == union
    for block_id, words in union.items():
        glosses = cached["glosses"][block_id]
        assert set(glosses) == set(words)
        for zh_word in glosses.values():
            assert zh_word and zh_word in zh_by_block[block_id]
    # 不把整份正文/prompt 写进缓存 meta（idioms/culture 的 quote 是分析内容）。
    assert "transcript" not in cached and "prompt" not in cached
    assert "You are an expert" not in json.dumps(cached, ensure_ascii=False)


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
        (teaching_analysis.CONTENT_LEVEL, "zh-CN"),
        (teaching_analysis.CONTENT_LEVEL, "vi-VN"),
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
        await teaching_analysis.ensure_analysis(BLOCKS, "liftoff", "zh-CN")

    with pytest.raises(teaching_analysis.AnalysisFailed):
        asyncio.run(fail())
    assert _row_count() == 0, "失败不写半成品，下次可重试"

    llm_stub.fail = False
    result = asyncio.run(
        teaching_analysis.ensure_analysis(BLOCKS, "liftoff", "zh-CN")
    )
    assert result["highlights"]
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
    # 内容级分析：换等级命中同一行，只扣 1 单位（旧口径同档位 2 次生成 = 2 单位）。
    assert [(item[1], item[2]) for item in consumed] == [("analysis", 1)]


def test_content_gloss_switch_off_reads_legacy_v5_rows(analysis_db, llm_stub, monkeypatch):
    """回退开关：旧 analysis.v5 per-level 行可读、可复用、不删除、零模型调用。"""
    content_hash_value = teaching_analysis.content_hash(BLOCKS)
    normalized = teaching_analysis.normalize_blocks(BLOCKS)
    candidate_words = teaching_analysis._candidate_words_for_blocks(
        normalized, "liftoff"
    )
    zh_by_block = {str(block["id"]): block["zh"] for block in normalized}
    legacy_highlights = {
        block_id: [
            {"en_word": word, "zh_word": zh_by_block[block_id][:2],
             "color": HIGHLIGHT_COLOR}
            for word in words
        ]
        for block_id, words in candidate_words.items()
    }
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        conn.execute(
            "INSERT INTO content_teaching_analysis "
            "(id, content_ref, content_hash, level, target_lang, analysis_version, "
            "payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "legacy-v5-row",
                VIDEO_ID,
                content_hash_value,
                "liftoff",
                "zh-CN",
                teaching_analysis.LEGACY_ANALYSIS_VERSION,
                json.dumps({
                    "analysisVersion": teaching_analysis.LEGACY_ANALYSIS_VERSION,
                    "glossAttempted": True,
                    "level": "liftoff",
                    "targetLang": "zh-CN",
                    "contentHash": content_hash_value,
                    "highlights": legacy_highlights,
                    "idioms": [{
                        "blockId": 1,
                        "phrase": "opens at nine",
                        "meaning": "九点开门",
                        "quote": "The museum opens at nine",
                    }],
                    "culture": [],
                    "model": "legacy-model",
                    "createdAt": 1,
                }, ensure_ascii=False),
                1,
            ),
        )

    monkeypatch.setattr(config, "ANALYSIS_CONTENT_GLOSS", False, raising=False)
    result = asyncio.run(
        teaching_analysis.ensure_analysis(BLOCKS, "liftoff", "zh-CN")
    )
    assert llm_stub.prompts == [], "旧 v5 行命中不得调模型"
    assert result["analysisVersion"] == teaching_analysis.LEGACY_ANALYSIS_VERSION
    assert result["level"] == "liftoff"
    assert result["highlights"] == legacy_highlights
    assert _row_count() == 1, "只读缓存，不新增行"

    # 开关打开：v5 行不算内容级缓存，按新版本生成一次；旧行保留不删除。
    monkeypatch.setattr(config, "ANALYSIS_CONTENT_GLOSS", True, raising=False)
    fresh = asyncio.run(
        teaching_analysis.ensure_analysis(BLOCKS, "liftoff", "zh-CN")
    )
    assert fresh["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION
    assert len(llm_stub.prompts) == 1
    assert sorted(row[4] for row in _rows()) == [
        teaching_analysis.LEGACY_ANALYSIS_VERSION,
        teaching_analysis.ANALYSIS_VERSION,
    ]


def test_content_gloss_switch_off_writes_per_level_v5_rows(analysis_db, llm_stub, monkeypatch):
    """回退开关下的生成路径仍是旧的按等级口径（两档 = 两次生成、两行 v5）。"""
    monkeypatch.setattr(config, "ANALYSIS_CONTENT_GLOSS", False, raising=False)

    async def run():
        return (
            await teaching_analysis.ensure_analysis(BLOCKS, "liftoff", "zh-CN"),
            await teaching_analysis.ensure_analysis(BLOCKS, "orbit", "zh-CN"),
        )

    liftoff, orbit = asyncio.run(run())
    assert len(llm_stub.prompts) == 2
    assert liftoff["analysisVersion"] == teaching_analysis.LEGACY_ANALYSIS_VERSION
    assert orbit["analysisVersion"] == teaching_analysis.LEGACY_ANALYSIS_VERSION
    assert {row[2] for row in _rows()} == {"liftoff", "orbit"}
    assert {row[4] for row in _rows()} == {teaching_analysis.LEGACY_ANALYSIS_VERSION}


def test_content_row_with_empty_glosses_regenerates_once(analysis_db, llm_stub):
    """旧空 gloss 内容行（无 glossAttempted）重生成一次；之后不再死循环。"""
    content_hash_value = teaching_analysis.content_hash(BLOCKS)
    teaching_analysis.save_cached(
        VIDEO_ID,
        content_hash_value,
        teaching_analysis.CONTENT_LEVEL,
        "zh-CN",
        {
            "analysisVersion": teaching_analysis.ANALYSIS_VERSION,
            "level": teaching_analysis.CONTENT_LEVEL,
            "targetLang": "zh-CN",
            "contentHash": content_hash_value,
            "glosses": {"1": {"museum": ""}},
            "idioms": [],
            "culture": [],
        },
    )
    result = asyncio.run(
        teaching_analysis.ensure_analysis(BLOCKS, "liftoff", "zh-CN")
    )
    assert len(llm_stub.prompts) == 1
    assert result["highlights"], "译文就绪后应重新生成有效 gloss"

    # 再读：行已带 glossAttempted，零调用（不因部分词无释义反复重试）。
    again = asyncio.run(
        teaching_analysis.ensure_analysis(BLOCKS, "liftoff", "zh-CN")
    )
    assert len(llm_stub.prompts) == 1
    assert again["highlights"] == result["highlights"]


def test_content_row_with_gloss_attempted_and_empty_glosses_is_terminal(
    analysis_db, llm_stub
):
    """已尝试过且模型确实给不出释义：不再重生成（无死循环），返回空高亮。"""
    content_hash_value = teaching_analysis.content_hash(BLOCKS)
    teaching_analysis.save_cached(
        VIDEO_ID,
        content_hash_value,
        teaching_analysis.CONTENT_LEVEL,
        "zh-CN",
        {
            "analysisVersion": teaching_analysis.ANALYSIS_VERSION,
            "glossAttempted": True,
            "level": teaching_analysis.CONTENT_LEVEL,
            "targetLang": "zh-CN",
            "contentHash": content_hash_value,
            "glosses": {"1": {"museum": ""}},
            "idioms": [],
            "culture": [],
        },
    )
    result = asyncio.run(
        teaching_analysis.ensure_analysis(BLOCKS, "liftoff", "zh-CN")
    )
    assert llm_stub.prompts == []
    assert result["highlights"] == {}


def test_content_gloss_is_revalidated_against_current_translation():
    """等级 payload 构造时按当前译文再校验：译文变了 → 无法核对的释义丢弃。"""
    normalized = teaching_analysis.normalize_blocks(BLOCKS)
    content = {
        "analysisVersion": teaching_analysis.ANALYSIS_VERSION,
        "glossAttempted": True,
        "level": teaching_analysis.CONTENT_LEVEL,
        "targetLang": "zh-CN",
        "contentHash": teaching_analysis.content_hash(BLOCKS),
        "glosses": {"1": {"museum": "博物馆", "nine": "九点"}},
        "idioms": [],
        "culture": [],
        "model": "m",
        "createdAt": 1,
    }
    payload = teaching_analysis._level_payload_from_content(content, normalized, "liftoff")
    words = {
        item["en_word"]
        for item in payload["highlights"].get("1", [])
    }
    assert "museum" in words and "nine" in words

    changed = copy.deepcopy(BLOCKS)
    changed[0]["zh_text"] = "展馆九点开门。"
    changed_normalized = teaching_analysis.normalize_blocks(changed)
    payload = teaching_analysis._level_payload_from_content(
        content, changed_normalized, "liftoff"
    )
    words = {item["en_word"] for item in payload["highlights"].get("1", [])}
    assert "museum" not in words, "zh_word 不在新译文里 → 整条丢弃"
    assert "nine" in words, "译文仍包含的释义保留"


# ---------------------------------------------------------------------------
# 9/10. 合并进 payload
# ---------------------------------------------------------------------------

def test_merge_into_payload_replaces_highlights_by_block_id():
    payload = {
        "videoId": VIDEO_ID,
        "transcript": copy.deepcopy(BLOCKS),
    }
    # 旧翻译缓存里可能残留的旧等级高亮。
    payload["transcript"][1]["highlights"] = [
        {"en_word": "Visitors", "zh_word": "", "color": "old"}
    ]
    analysis = {
        "analysisVersion": teaching_analysis.ANALYSIS_VERSION,
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

    assert payload["transcript"][0]["highlights"] == [{
        "en_word": "museum",
        "zh_word": "博物馆",
        "color": HIGHLIGHT_COLOR,
    }]
    # 分析覆盖后旧等级残留被清空，非法条目被丢弃。
    assert payload["transcript"][1]["highlights"] == []
    assert payload["idioms"][0]["phrase"] == "opens at nine"
    assert payload["culture"][0]["term"] == "front desk"
    assert payload["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION


def test_merge_into_payload_drops_stale_v4_fields_before_merging():
    """payload 带 v4 合并字段时，v5 分析合并前先丢弃旧字段（不得沿用）。"""
    payload = {
        "videoId": VIDEO_ID,
        "analysisVersion": "analysis.v4",
        "idioms": [
            {"blockId": 1, "phrase": "old idiom", "meaning": "旧",
             "quote": "The museum opens at nine"},
        ],
        "culture": [
            {"blockId": 1, "term": "old culture", "note": "旧",
             "quote": "The museum opens at nine"},
        ],
        "transcript": copy.deepcopy(BLOCKS),
    }
    payload["transcript"][0]["highlights"] = [
        {"en_word": "museum", "zh_word": "旧版释义", "color": HIGHLIGHT_COLOR}
    ]
    payload["transcript"][1]["highlights"] = [
        {"en_word": "Visitors", "zh_word": "旧版释义", "color": HIGHLIGHT_COLOR}
    ]
    # 新分析没有 highlights 字段：若沿用了旧字段，两个 block 的旧高亮会留下。
    analysis = {
        "analysisVersion": teaching_analysis.ANALYSIS_VERSION,
        "idioms": [],
        "culture": [],
    }
    assert teaching_analysis.merge_into_payload(payload, analysis) is True
    assert payload["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION
    assert "highlights" not in payload["transcript"][0]
    assert "highlights" not in payload["transcript"][1]
    assert payload["idioms"] == [] and payload["culture"] == []


def test_merge_into_payload_discards_old_version_analysis():
    """旧版本分析本身也不得写入/沿用：丢弃旧合并字段并返回 False。"""
    payload = {
        "videoId": VIDEO_ID,
        "analysisVersion": "analysis.v4",
        "idioms": [
            {"blockId": 1, "phrase": "old idiom", "meaning": "旧",
             "quote": "The museum opens at nine"},
        ],
        "culture": [],
        "transcript": copy.deepcopy(BLOCKS),
    }
    payload["transcript"][0]["highlights"] = [
        {"en_word": "museum", "zh_word": "旧版释义", "color": HIGHLIGHT_COLOR}
    ]
    stale_analysis = {
        "analysisVersion": "analysis.v4",
        "highlights": {"1": [{"en_word": "museum", "zh_word": "仍不该合并"}]},
        "idioms": [],
        "culture": [],
    }
    assert teaching_analysis.merge_into_payload(payload, stale_analysis) is False
    assert "analysisVersion" not in payload
    assert "idioms" not in payload and "culture" not in payload
    assert "highlights" not in payload["transcript"][0]


def test_merge_into_payload_drops_cached_highlights_without_gloss():
    """旧缓存/模型输出里 zh 为空的条目，合并时也整条丢弃（不再渲染无释义高亮）。"""
    payload = {"transcript": copy.deepcopy(BLOCKS)}
    analysis = {
        "analysisVersion": teaching_analysis.ANALYSIS_VERSION,
        "highlights": {
            "1": [{"en_word": "museum", "zh_word": ""}],
            "2": [
                {"en_word": "Visitors", "zh_word": ""},
                {"en_word": "tickets", "zh_word": "买票"},
            ],
        },
        "idioms": [],
        "culture": [],
    }
    assert teaching_analysis.merge_into_payload(payload, analysis) is True
    assert payload["transcript"][0]["highlights"] == []
    assert payload["transcript"][1]["highlights"] == [{
        "en_word": "tickets",
        "zh_word": "买票",
        "color": HIGHLIGHT_COLOR,
    }]
    assert payload["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION


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


# P0-04：失败原因必须交给调用方（不再被 attach_to_payload 静默吞掉）。
# 只在卡 P0-04 实现落地后才绿；先红后绿。

def test_attach_to_payload_reports_missing_table_reason(client):
    payload = {"transcript": copy.deepcopy(BLOCKS)}
    unavailable: dict = {}
    result = asyncio.run(
        teaching_analysis.attach_to_payload(
            payload,
            level="moonwalk",
            target_lang="zh-CN",
            unavailable_out=unavailable,
        )
    )
    assert result is None
    assert unavailable["analysisUnavailableReason"] == "analysis_unavailable"


def test_attach_to_payload_reports_quota_exceeded(analysis_db, monkeypatch):
    q = teaching_analysis.quota

    def raise_quota(user_id, feature, units=1, **kwargs):
        raise q.QuotaExceeded(
            "analysis",
            day="2026-11-22",
            used_units=30,
            limit_units=30,
            user_id=user_id,
        )

    monkeypatch.setattr(q, "check_and_consume_quota", raise_quota)
    payload = {"transcript": copy.deepcopy(BLOCKS)}
    unavailable: dict = {}
    result = asyncio.run(
        teaching_analysis.attach_to_payload(
            payload,
            level="moonwalk",
            target_lang="zh-CN",
            user_id="u-quota",
            unavailable_out=unavailable,
        )
    )
    assert result is None
    assert unavailable["analysisUnavailableReason"] == "quota_exceeded"
    assert unavailable["analysisUsed"] == 30
    assert unavailable["analysisLimit"] == 30
    assert unavailable["analysisResetAt"].startswith("2026-11-23T00:00:00")
    assert "idioms" not in payload


def test_attach_to_payload_reports_budget_exceeded(analysis_db, monkeypatch):
    q = teaching_analysis.quota

    def raise_budget(user_id, feature, units=1, **kwargs):
        raise q.BudgetExceeded(
            "user", day="2026-11-22", spend_usd=2.5, limit_usd=2.0, user_id=user_id
        )

    monkeypatch.setattr(q, "check_and_consume_quota", raise_budget)
    unavailable: dict = {}
    result = asyncio.run(
        teaching_analysis.attach_to_payload(
            {"transcript": copy.deepcopy(BLOCKS)},
            level="moonwalk",
            target_lang="zh-CN",
            user_id="u-budget",
            unavailable_out=unavailable,
        )
    )
    assert result is None
    assert unavailable["analysisUnavailableReason"] == "budget_exceeded"
    assert unavailable["analysisResetAt"].startswith("2026-11-23T00:00:00")
    assert "analysisUsed" not in unavailable


def test_attach_to_payload_reports_model_failure(analysis_db, llm_stub):
    llm_stub.fail = True
    payload = {"transcript": copy.deepcopy(BLOCKS)}
    unavailable: dict = {}
    result = asyncio.run(
        teaching_analysis.attach_to_payload(
            payload,
            level="moonwalk",
            target_lang="zh-CN",
            user_id="u-model",
            unavailable_out=unavailable,
        )
    )
    assert result is None
    assert unavailable["analysisUnavailableReason"] == "model_error"
    assert "idioms" not in payload


def test_attach_to_payload_success_leaves_unavailable_empty(analysis_db, llm_stub):
    payload = {"transcript": copy.deepcopy(BLOCKS)}
    unavailable: dict = {}
    result = asyncio.run(
        teaching_analysis.attach_to_payload(
            payload,
            level="moonwalk",
            target_lang="zh-CN",
            user_id="u-ok",
            unavailable_out=unavailable,
        )
    )
    assert result is not None
    assert unavailable == {}
    assert payload["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION


# ---------------------------------------------------------------------------
# 10. 翻译只负责译文
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
# 11. 端到端：缓存视频流 / 新视频流 / API
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

    first = stream("liftoff")
    meta = dict(first)["meta"]
    assert len(llm_stub.prompts) == 1
    # P2-32：meta 先到且不带分析；分析完成后用 batch 回传带高亮的 blocks。
    assert all(not block["highlights"] for block in meta["blocks"])
    first_batches = [data for name, data in first if name == "batch"]
    assert len(first_batches) == 1
    assert all(block["highlights"] for block in first_batches[0]["blocks"])
    written = json.loads(
        (history_dir / f"Test_Channel_20240101_{VIDEO_ID}.json").read_text(
            encoding="utf-8"
        )
    )
    assert written["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION
    assert written["idioms"] and written["culture"]
    assert all(block["highlights"] for block in written["transcript"])

    second = stream("liftoff")
    assert len(llm_stub.prompts) == 1, "同内容+等级+语言第二次必须零模型调用"
    second_batches = [data for name, data in second if name == "batch"]
    assert second_batches and all(
        block["highlights"] for block in second_batches[0]["blocks"]
    )
    assert (
        second_batches[0]["blocks"][0]["highlights"]
        == first_batches[0]["blocks"][0]["highlights"]
    )

    third = stream("orbit")
    assert len(llm_stub.prompts) == 1, "换等级由本地筛选，零模型调用"
    third_batches = [data for name, data in third if name == "batch"]
    assert third_batches and any(
        block["highlights"] for block in third_batches[0]["blocks"]
    )
    # 等级筛选真的生效：orbit（阈值更高）不显示 liftoff 的 museum/nine。
    orbit_words = {
        item["en_word"]
        for block in third_batches[0]["blocks"]
        for item in block["highlights"]
    }
    assert "museum" not in orbit_words
    assert len(_rows()) == 1, "六档共享同一行内容级缓存"


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
        "/api/process-video-stream", json={"url": URL, "vocab_level": "liftoff"}
    )
    assert response.status_code == 200, response.text
    events = _sse_events(response)
    names = [name for name, _ in events]
    assert names[0] == "meta" and names[-1] == "done"
    assert names.count("batch") >= 2, "翻译批次之后应再推一次带高亮的分析合并事件"
    last_batch = [data for name, data in events if name == "batch"][-1]
    assert all(block["highlights"] for block in last_batch["blocks"])
    assert len(translation_calls) == 1
    assert len(llm_stub.prompts) == 1

    written = json.loads(
        (history_dir / f"Test_Channel_20240101_{VIDEO_ID}.json").read_text(
            encoding="utf-8"
        )
    )
    assert written["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION
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
        params={"level": "liftoff", "targetLang": "zh-CN"},
    )
    assert first.status_code == 200, first.text
    payload = first.json()
    assert payload["contentRef"] == VIDEO_ID
    assert payload["level"] == "liftoff"
    assert payload["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION
    assert payload["highlights"] and payload["idioms"] and payload["culture"]
    assert len(llm_stub.prompts) == 1

    second = analysis_db.get(
        f"/api/teaching-analysis/{VIDEO_ID}",
        params={"level": "liftoff", "contentHash": payload["contentHash"]},
    )
    assert second.status_code == 200
    assert second.json()["contentHash"] == payload["contentHash"]
    assert len(llm_stub.prompts) == 1, "缓存命中不得再调模型"


def test_api_different_level_reuses_content_cache(analysis_db, history_dir, llm_stub):
    """同一内容的两个等级：端点只生成一次内容级分析，第二次零模型调用。"""
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
    assert first.json()["highlights"] and first.json()["idioms"]
    # supernova（C2）阈值最高：没有候选词释义，但 idioms/culture 复用同一份。
    assert second.json()["highlights"] == {}
    assert second.json()["idioms"] == first.json()["idioms"]
    assert second.json()["culture"] == first.json()["culture"]
    assert len(llm_stub.prompts) == 1


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
