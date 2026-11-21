"""免费库教学分析接入（specs/024 2026-11-22 修订 + specs/028）离线验收。

覆盖：

1. 游客无缓存：payload 不带分析字段，且**零模型调用**；
2. 游客有缓存：payload 带分析（视频 blocks[].highlights / 文章 paragraphs[].highlights +
   顶层 idioms/culture/analysisVersion），仍零模型调用；
3. 登录用户无缓存：调模型一次、分析写入全局缓存，响应不进入共享缓存；
4. 登录用户再取：缓存命中，零模型调用，payload 与首次一致；
5. 失败静默：模型失败仍 200、只是没有分析字段；
6. 非法 level / targetLang → 400，且不触发模型；
7. 不带 level：payload 形状与改动前完全一致（文章段落仍只有 en/zh）。

全部离线：LLM 用桩记录调用；数据库在 conftest 的 tmp_path 下用真实 Alembic
CLI 迁移到 head（含 0020 教学分析表、0025 计费表）。
"""
from __future__ import annotations

import asyncio
import json
import sqlite3

import pytest

import config
import llm
import routes_library
import teaching_analysis
from tests.migration_utils import assert_alembic_ok, run_alembic

VIDEO_ID = "bbc-learning-different-generations"
ARTICLE_ID = "ocean-noise"
LEVEL = "liftoff"
LANG = "zh-CN"

VIDEO_PATH = f"/api/library/videos/{VIDEO_ID}"
ARTICLE_PATH = f"/api/library/articles/{ARTICLE_ID}"


# ---------------------------------------------------------------------------
# 夹具 / 桩
# ---------------------------------------------------------------------------

@pytest.fixture()
def analysis_db(client):
    """把当前用例的临时库迁到 head（含 0020 教学分析表 + 0025 计费表）。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"),
        "upgrade head (library analysis)",
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

    async def generate_json_async(self, prompt: str, model: str | None = None):
        self.prompts.append(prompt)
        if self.fail:
            raise RuntimeError("model unavailable")
        return json.dumps(_analysis_from_prompt(prompt), ensure_ascii=False)


@pytest.fixture()
def llm_stub(monkeypatch):
    stub = LlmStub()
    monkeypatch.setattr(llm, "generate_json_async", stub.generate_json_async)
    return stub


def _blocks(kind: str, entry_id: str) -> list[dict]:
    """与详情端点同一口径的分析输入块（预热脚本也用它）。"""
    payload = routes_library.load_payload(kind, entry_id)
    return routes_library.analysis_blocks(kind, payload)


def _seed_cache(kind: str, entry_id: str) -> None:
    """直接走 ensure_analysis 生成一份全局缓存（游客读路径的命中条件）。"""
    asyncio.run(
        teaching_analysis.ensure_analysis(
            _blocks(kind, entry_id), LEVEL, LANG
        )
    )


def _cache_rows() -> int:
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM content_teaching_analysis"
        ).fetchone()[0]


def _assert_no_analysis_field(payload: dict) -> None:
    for forbidden in ("idioms", "culture", "analysisVersion", "analysisLevel"):
        assert forbidden not in payload, forbidden


# ---------------------------------------------------------------------------
# 1. 游客无缓存：没有分析、零模型调用
# ---------------------------------------------------------------------------

def test_guest_without_cache_gets_no_analysis_and_no_model_call(
    analysis_db, llm_stub, make_client
):
    with make_client() as guest:
        video = guest.get(VIDEO_PATH, params={"level": LEVEL})
        article = guest.get(ARTICLE_PATH, params={"level": LEVEL})

    assert video.status_code == 200, video.text
    assert article.status_code == 200, article.text
    _assert_no_analysis_field(video.json())
    _assert_no_analysis_field(article.json())
    assert llm_stub.prompts == [], "游客未命中缓存时绝不生成分析"
    assert _cache_rows() == 0


# ---------------------------------------------------------------------------
# 2. 游客有缓存：只读合并，仍零模型调用
# ---------------------------------------------------------------------------

def test_guest_reads_cached_analysis_without_generating(
    analysis_db, llm_stub, make_client
):
    _seed_cache("videos", VIDEO_ID)
    _seed_cache("articles", ARTICLE_ID)
    generated = len(llm_stub.prompts)
    assert generated >= 2

    with make_client() as guest:
        video = guest.get(VIDEO_PATH, params={"level": LEVEL})
        article = guest.get(ARTICLE_PATH, params={"level": LEVEL})

    assert len(llm_stub.prompts) == generated, "游客只读缓存，不得再调模型"
    video_payload = video.json()
    article_payload = article.json()
    assert video_payload["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION
    assert video_payload["analysisLevel"] == LEVEL
    assert video_payload["idioms"] and video_payload["culture"]
    assert any(block["highlights"] for block in video_payload["blocks"])
    assert all(isinstance(block["highlights"], list) for block in video_payload["blocks"])

    assert article_payload["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION
    assert article_payload["idioms"] and article_payload["culture"]
    assert all(
        isinstance(paragraph.get("highlights"), list)
        for paragraph in article_payload["paragraphs"]
    )


# ---------------------------------------------------------------------------
# 3/4. 登录：首次生成一次并写缓存，再取零调用
# ---------------------------------------------------------------------------

def test_logged_in_generates_once_then_reads_cache(analysis_db, llm_stub):
    first = analysis_db.get(VIDEO_PATH, params={"level": LEVEL})
    assert first.status_code == 200, first.text
    payload = first.json()
    assert payload["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION
    assert payload["analysisLevel"] == LEVEL
    assert payload["idioms"] and payload["culture"]
    assert any(block["highlights"] for block in payload["blocks"])
    assert len(llm_stub.prompts) == 1, "一个内容一个等级一次生成"
    assert _cache_rows() == 1
    # 同 URL 对不同身份（游客/登录）返回形状不同，不能进共享缓存。
    assert first.headers.get("cache-control") == "private, no-store"

    second = analysis_db.get(VIDEO_PATH, params={"level": LEVEL})
    assert second.status_code == 200
    assert len(llm_stub.prompts) == 1, "缓存命中不得再调模型"
    assert second.json()["blocks"] == payload["blocks"]
    assert second.json()["idioms"] == payload["idioms"]


def test_logged_in_article_analysis_writes_paragraph_highlights(analysis_db, llm_stub):
    response = analysis_db.get(
        ARTICLE_PATH, params={"level": LEVEL, "targetLang": LANG}
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    paragraphs = payload["paragraphs"]
    assert payload["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION
    assert payload["analysisLevel"] == LEVEL
    assert payload["idioms"] and payload["culture"]
    for paragraph in paragraphs:
        assert {"en", "zh", "highlights"} <= set(paragraph)
        assert isinstance(paragraph["highlights"], list)
    # 文章 analysis block id = 0 起段落下标（与阅读器 paragraphs[].idx 同口径）。
    for item in payload["idioms"] + payload["culture"]:
        assert isinstance(item["blockId"], int)
        assert 0 <= item["blockId"] < len(paragraphs)
    assert len(llm_stub.prompts) == 1


# ---------------------------------------------------------------------------
# 5. 生成失败静默：仍然 200，只是没有分析字段
# ---------------------------------------------------------------------------

def test_generation_failure_is_silent(analysis_db, llm_stub):
    llm_stub.fail = True
    response = analysis_db.get(VIDEO_PATH, params={"level": LEVEL})
    assert response.status_code == 200, response.text
    _assert_no_analysis_field(response.json())
    assert llm_stub.prompts, "登录用户未命中缓存时应尝试生成"
    assert _cache_rows() == 0, "失败不写半成品"


# ---------------------------------------------------------------------------
# 6. 非法参数 400
# ---------------------------------------------------------------------------

def test_invalid_level_or_target_lang_is_400(analysis_db, llm_stub, make_client):
    with make_client() as guest:
        assert guest.get(VIDEO_PATH, params={"level": "zzz"}).status_code == 400
        assert (
            guest.get(VIDEO_PATH, params={"level": LEVEL, "targetLang": "xx-YY"}).status_code
            == 400
        )
        assert guest.get(VIDEO_PATH, params={"targetLang": "xx-YY"}).status_code == 400
        assert guest.get(ARTICLE_PATH, params={"level": "zzz"}).status_code == 400
    assert llm_stub.prompts == [], "参数非法时不得触发生成"


# ---------------------------------------------------------------------------
# 7. 不带 level：形状与改动前完全一致
# ---------------------------------------------------------------------------

def test_omitting_level_keeps_legacy_payload(analysis_db, llm_stub, make_client):
    expected_video = routes_library.load_payload("videos", VIDEO_ID)
    expected_article = routes_library.load_payload("articles", ARTICLE_ID)
    with make_client() as guest:
        video = guest.get(VIDEO_PATH)
        article = guest.get(ARTICLE_PATH)

    assert video.status_code == 200 and article.status_code == 200
    video_payload = video.json()
    article_payload = article.json()
    _assert_no_analysis_field(video_payload)
    _assert_no_analysis_field(article_payload)
    assert video_payload["blocks"] == expected_video["blocks"]
    assert all(set(paragraph) == {"en", "zh"} for paragraph in article_payload["paragraphs"])
    assert article_payload["paragraphs"] == expected_article["paragraphs"]
    assert llm_stub.prompts == []
    # 普通读取仍可公开缓存。
    assert "public" in video.headers.get("cache-control", "")
