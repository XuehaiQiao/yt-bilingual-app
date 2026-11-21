"""教学分析读路径访问策略（specs/028 v1.1 §1.3；specs/036 口径）。

三件事：

1. **缓存命中对游客 200**：全局表 ``content_teaching_analysis`` 已有可复用行时，
   ``GET /api/teaching-analysis/{ref}`` 对游客也返回分析——只读、零模型调用、
   不占配额、不写 ``ai_usage``/``ai_quota``；
2. **需要生成时游客仍 403**：缓存未命中（含「行存在但不可复用」）→ 403
   ``code=login_required``，且同样零模型调用、零用量；
3. **per-user payload 与端点同一数据源、同一可见性**：游客从
   ``GET /api/history/{filename}`` 能读到的分析，从端点也能读到（不会
   「一条路 200、另一条 403」）；登录用户两条路拿到的分析也一致。

全部离线：LLM 用桩记录调用次数；数据库在 conftest 的 tmp_path 下用真实
Alembic CLI 迁移；游客目录也落在 tmp_path（conftest 已隔离 ``GUEST_DATA_DIR``）。
"""
from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path

import pytest

import config
import guest as guest_module
import llm
import teaching_analysis
from tests.migration_utils import assert_alembic_ok, run_alembic

VIDEO_ID = "accessvid01"  # 11 位 YouTube 形态
URL = f"https://www.youtube.com/watch?v={VIDEO_ID}"
FILENAME = f"Test_Channel_20240101_{VIDEO_ID}.json"
LEVEL = "liftoff"

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
# 夹具 / 桩（与 tests/test_teaching_analysis.py 同口径，保持本文件自足）
# ---------------------------------------------------------------------------

@pytest.fixture()
def analysis_db(client):
    """把当前用例的临时库迁到 head（含 0020 教学分析表 + 0025 计费表）。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"),
        "upgrade head (analysis access)",
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
    """记录 prompt 的异步 generate_json_async 桩（本文件不测失败路径）。"""

    def __init__(self) -> None:
        self.prompts: list[str] = []

    async def generate_json_async(self, prompt: str, model: str | None = None):
        self.prompts.append(prompt)
        return json.dumps(_analysis_from_prompt(prompt), ensure_ascii=False)


@pytest.fixture()
def llm_stub(monkeypatch):
    stub = LlmStub()
    monkeypatch.setattr(llm, "generate_json_async", stub.generate_json_async)
    return stub


def _seed_cache(history_dir) -> Path:
    """登录用户目录下的双语字幕缓存（还没有分析字段）。"""
    path = Path(history_dir) / FILENAME
    payload = {
        "videoId": VIDEO_ID,
        "metadata": {
            "title": "Analysis Access Test",
            "channel": "Test Channel",
            "upload_date": "20240101",
            "thumbnail": "",
        },
        "transcript": json.loads(json.dumps(BLOCKS)),
        "summary": "测试总结",
        "model": "deepseek-chat",
        "studyCount": 1,
        "target_lang": "zh-CN",
    }
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


def _count(table: str) -> int:
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def _copy_into_guest(guest_client, source: Path) -> Path:
    """把一份缓存放进当前游客自己的目录（游客只读自己身份下的内容缓存）。"""
    guest_client.get("/api/auth/me")  # 首次 API 请求下发 ln_guest
    token = guest_client.cookies.get(guest_module.COOKIE_NAME)
    assert token, "游客 Cookie 未下发"
    directory = Path(
        guest_module.guest_history_dir(
            guest_module.hash_token(token), create=True
        )
    )
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / source.name
    shutil.copyfile(source, target)
    return target


def _assert_same_analysis(payload: dict, response: dict) -> None:
    """payload 里合并的分析 ≡ 端点返回的分析（同一数据源/可见性）。"""
    assert response["analysisVersion"] == payload["analysisVersion"]
    assert response["idioms"] == payload["idioms"]
    assert response["culture"] == payload["culture"]
    for block in payload["transcript"]:
        assert (block.get("highlights") or []) == (
            response["highlights"].get(str(block["id"])) or []
        )


# ---------------------------------------------------------------------------
# 1. 缓存命中：游客也能读；与 per-user payload 同源
# ---------------------------------------------------------------------------

def test_guest_reads_cached_analysis_from_endpoint_and_payload(
    make_client, analysis_db, history_dir, llm_stub
):
    source = _seed_cache(history_dir)

    # 登录用户走缓存视频流：命中翻译缓存 → 生成分析并合并进 payload（1 次模型）。
    stream = analysis_db.post(
        "/api/process-video-stream", json={"url": URL, "vocab_level": LEVEL}
    )
    assert stream.status_code == 200, stream.text
    assert len(llm_stub.prompts) == 1
    logged_in_payload = json.loads(source.read_text(encoding="utf-8"))
    assert logged_in_payload["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION
    assert logged_in_payload["idioms"] and logged_in_payload["culture"]

    # 登录用户：端点命中缓存，零额外模型调用；两条路拿到同一份分析。
    logged_in_endpoint = analysis_db.get(
        f"/api/teaching-analysis/{VIDEO_ID}", params={"level": LEVEL}
    )
    assert logged_in_endpoint.status_code == 200, logged_in_endpoint.text
    assert len(llm_stub.prompts) == 1
    _assert_same_analysis(logged_in_payload, logged_in_endpoint.json())
    logged_in_history = analysis_db.get(
        f"/api/history/{FILENAME}", params={"level": LEVEL}
    )
    assert logged_in_history.status_code == 200, logged_in_history.text
    _assert_same_analysis(logged_in_history.json(), logged_in_endpoint.json())

    usage_before = _count("ai_usage")
    quota_before = _count("ai_quota")

    with make_client() as guest:
        _copy_into_guest(guest, source)

        # 游客 payload 路径：缓存里的分析可读（不触发生成）。
        guest_history = guest.get(f"/api/history/{FILENAME}")
        assert guest_history.status_code == 200, guest_history.text
        guest_payload = guest_history.json()
        assert guest_payload["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION

        # 游客端点路径：同一份缓存 → 200（不是 403）。零模型、零用量、零配额。
        endpoint = guest.get(
            f"/api/teaching-analysis/{VIDEO_ID}", params={"level": LEVEL}
        )
        assert endpoint.status_code == 200, endpoint.text
        assert len(llm_stub.prompts) == 1, "游客读缓存不得调用模型"
        assert _count("ai_usage") == usage_before, "游客读缓存不得写 ai_usage"
        assert _count("ai_quota") == quota_before, "缓存命中不得占配额"

        analysis = endpoint.json()
        assert analysis["contentRef"] == VIDEO_ID
        assert analysis["level"] == LEVEL
        assert analysis["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION
        assert analysis["highlights"] and analysis["idioms"] and analysis["culture"]
        # 游客 payload 能读到的分析，端点也能读到（同源同可见性）。
        _assert_same_analysis(guest_payload, analysis)
        assert analysis == logged_in_endpoint.json(), "游客与登录用户命中同一缓存行"


# ---------------------------------------------------------------------------
# 2. 需要生成：游客仍 403 login_required
# ---------------------------------------------------------------------------

def test_guest_cache_miss_still_requires_login(
    make_client, analysis_db, history_dir, llm_stub
):
    source = _seed_cache(history_dir)
    with make_client() as guest:
        _copy_into_guest(guest, source)

        response = guest.get(
            f"/api/teaching-analysis/{VIDEO_ID}", params={"level": LEVEL}
        )
        assert response.status_code == 403, response.text
        assert response.json().get("code") == "login_required"
        assert llm_stub.prompts == [], "游客未命中不得调用模型"
        assert _count("ai_usage") == 0
        assert _count("ai_quota") == 0

        # 游客看不到的内容同样稳定 403（specs/036：不把「做不到」暴露成 404）。
        missing = guest.get("/api/teaching-analysis/no-such-video")
        assert missing.status_code == 403
        assert missing.json().get("code") == "login_required"
        assert llm_stub.prompts == []


def test_guest_cannot_read_a_cache_row_that_would_be_regenerated(
    make_client, analysis_db, history_dir, llm_stub
):
    """版本自检不匹配的行不算命中：游客 403，登录用户照常重生成（同一判定）。"""
    source = _seed_cache(history_dir)
    content_hash_value = teaching_analysis.content_hash(BLOCKS)
    with sqlite3.connect(config.AUTH_DB_PATH) as conn:
        conn.execute(
            "INSERT INTO content_teaching_analysis "
            "(id, content_ref, content_hash, level, target_lang, analysis_version, "
            "payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                "stale-payload-row",
                VIDEO_ID,
                content_hash_value,
                LEVEL,
                "zh-CN",
                teaching_analysis.ANALYSIS_VERSION,
                json.dumps({
                    "analysisVersion": "analysis.v4",
                    "highlights": {"1": [{"en_word": "museum", "zh_word": "旧版释义"}]},
                    "idioms": [],
                    "culture": [],
                }, ensure_ascii=False),
                1,
            ),
        )

    with make_client() as guest:
        _copy_into_guest(guest, source)
        response = guest.get(
            f"/api/teaching-analysis/{VIDEO_ID}", params={"level": LEVEL}
        )
        assert response.status_code == 403
        assert response.json().get("code") == "login_required"
        assert llm_stub.prompts == []

    regenerated = analysis_db.get(
        f"/api/teaching-analysis/{VIDEO_ID}", params={"level": LEVEL}
    )
    assert regenerated.status_code == 200, regenerated.text
    assert len(llm_stub.prompts) == 1
    assert regenerated.json()["analysisVersion"] == (
        teaching_analysis.ANALYSIS_VERSION
    )


# ---------------------------------------------------------------------------
# 3. 登录用户：未命中照旧生成（行为不变）
# ---------------------------------------------------------------------------

def test_logged_in_cache_miss_still_generates(analysis_db, history_dir, llm_stub):
    _seed_cache(history_dir)
    response = analysis_db.get(
        f"/api/teaching-analysis/{VIDEO_ID}", params={"level": LEVEL}
    )
    assert response.status_code == 200, response.text
    assert len(llm_stub.prompts) == 1
    assert response.json()["analysisVersion"] == teaching_analysis.ANALYSIS_VERSION
    assert response.json()["idioms"] and response.json()["culture"]
