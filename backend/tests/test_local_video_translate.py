"""P2-36：本地视频翻译 token-aware 分批 + 累计配额单位；local_show 主生成计时。

本地视频（``/api/local-video/process``）原先固定 20 blocks 一批、每批各自取整
扣单位，120 blocks 会扣 6 单位。P2-36 起改为与 YouTube 共用
``translation_batching.chunk_by_budget``（首批 10 / 稳定 40 / 单批 2k token），
并用 ``quota.units_per_batch("translate", …)`` 按累计 blocks 分配单位，
120 blocks = 2 单位。响应顺序、400/402/413/429 语义保持不变。

另外覆盖 ``/api/process-subtitle`` 主生成路径的 ``pipeline_timing`` total/batch
落点（P2-36 第 4 项）。全部离线：模型与教学分析都打桩。
"""
from __future__ import annotations

import pytest

import billing
import config
import llm
import routes_content
import teaching_analysis
import translate
from ai.ledger import QuotaExceeded

SHOW_ID = "timing-show"
SRT_TEXT = """1
00:00:00,000 --> 00:00:02,000
Hello world.

2
00:00:02,500 --> 00:00:04,000
Learning English is fun.
"""


def _blocks(count: int) -> list[dict]:
    return [
        {
            "id": index + 1,
            "start": float(index),
            "end": float(index + 1),
            "en": f"Sentence number {index + 1}.",
        }
        for index in range(count)
    ]


def _stub_analysis(monkeypatch) -> None:
    """本地视频的教学分析是增强项：本文件只测翻译/配额，打桩为零模型。"""

    async def _no_analysis(*_args, **_kwargs):
        return None

    monkeypatch.setattr(teaching_analysis, "ensure_analysis", _no_analysis)


def _stub_translate(monkeypatch, calls: list[dict] | None = None):
    async def _fake_process_llm_batch(blocks, **kwargs):
        if calls is not None:
            calls.append({"size": len(blocks), **kwargs})
        return [
            {"id": block["id"], "zh_text": f"译文 {block['id']}"}
            for block in reversed(blocks)
        ]

    monkeypatch.setattr(translate, "process_llm_batch", _fake_process_llm_batch)


# ---------------------------------------------------------------------------
# 1. 120 blocks：10/40/40/30 分批，累计只扣 2 单位
# ---------------------------------------------------------------------------

def test_120_blocks_token_aware_batches_and_cumulative_units(client, monkeypatch):
    calls: list[dict] = []
    _stub_translate(monkeypatch, calls)
    _stub_analysis(monkeypatch)

    response = client.post(
        "/api/local-video/process", json={"blocks": _blocks(120)}
    )
    assert response.status_code == 200, response.text

    assert [call["size"] for call in calls] == [10, 40, 40, 30]
    # 1 单位 = 100 blocks：第 1 批买下第 1 单位，第 4 批跨入第 2 单位。
    assert [call["quota_units"] for call in calls] == [1, 0, 0, 1]
    assert sum(call["quota_units"] for call in calls) == 2
    assert all(call["feature"] == "translate" for call in calls)
    assert all(call["user_id"] == client.user_id for call in calls)
    assert all(call["target_lang"] == "zh-CN" for call in calls)

    payload = response.json()
    # 模型乱序返回，响应仍按输入 blocks 顺序对齐。
    assert [block["id"] for block in payload["blocks"]] == list(range(1, 121))
    assert [block["zh_text"] for block in payload["blocks"]] == [
        f"译文 {index}" for index in range(1, 121)
    ]
    assert payload["targetLang"] == "zh-CN"
    assert payload["analysisError"] is None
    assert isinstance(payload["highlights"], dict)


def test_100_blocks_charges_exactly_one_unit(client, monkeypatch):
    """跨单位边界：100 blocks = 10+40+40+10，累计正好 1 单位。"""
    calls: list[dict] = []
    _stub_translate(monkeypatch, calls)
    _stub_analysis(monkeypatch)

    response = client.post(
        "/api/local-video/process", json={"blocks": _blocks(100)}
    )
    assert response.status_code == 200, response.text
    assert [call["size"] for call in calls] == [10, 40, 40, 10]
    assert [call["quota_units"] for call in calls] == [1, 0, 0, 0]


def test_missing_block_in_model_output_keeps_order_and_marker(client, monkeypatch):
    """模型漏块时响应仍保持输入顺序，缺失块用统一占位符。"""

    async def _drop_one(blocks, **kwargs):
        return [
            {"id": block["id"], "zh_text": f"译文 {block['id']}"}
            for block in blocks
            if block["id"] != 2
        ]

    monkeypatch.setattr(translate, "process_llm_batch", _drop_one)
    _stub_analysis(monkeypatch)

    response = client.post(
        "/api/local-video/process", json={"blocks": _blocks(3)}
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert [block["id"] for block in payload["blocks"]] == [1, 2, 3]
    assert payload["blocks"][1]["zh_text"] == translate.UNTRANSLATED_MARKER


# ---------------------------------------------------------------------------
# 2. 既有错误语义：400 / 402 / 413 / 429 不变
# ---------------------------------------------------------------------------

def test_empty_blocks_is_400(client):
    response = client.post("/api/local-video/process", json={"blocks": []})
    assert response.status_code == 400
    assert "字幕为空" in response.json()["detail"]


def test_too_many_blocks_is_413(client):
    response = client.post(
        "/api/local-video/process", json={"blocks": _blocks(2001)}
    )
    assert response.status_code == 413
    assert "字幕段落过多" in response.json()["detail"]


def test_invalid_timeline_is_400(client):
    response = client.post(
        "/api/local-video/process",
        json={"blocks": [{"id": 1, "start": 5.0, "end": 1.0, "en": "Hi."}]},
    )
    assert response.status_code == 400
    assert "时间轴" in response.json()["detail"]


def test_quota_exceeded_maps_to_429(client, monkeypatch):
    async def _quota_exceeded(blocks, **kwargs):
        raise QuotaExceeded(
            "translate",
            day="2026-11-24",
            used_units=60,
            limit_units=60,
            units=1,
        )

    monkeypatch.setattr(translate, "process_llm_batch", _quota_exceeded)
    _stub_analysis(monkeypatch)

    response = client.post(
        "/api/local-video/process", json={"blocks": _blocks(1)}
    )
    assert response.status_code == 429
    body = response.json()
    assert body["code"] == "quota_exceeded"
    assert body["feature"] == "translate"


def test_insufficient_balance_maps_to_402(client, monkeypatch):
    async def _insufficient(blocks, **kwargs):
        raise billing.InsufficientBalance(
            balance_micro_usd=0, required_micro_usd=100
        )

    monkeypatch.setattr(translate, "process_llm_batch", _insufficient)
    _stub_analysis(monkeypatch)

    response = client.post(
        "/api/local-video/process", json={"blocks": _blocks(1)}
    )
    assert response.status_code == 402
    body = response.json()
    assert body["code"] == "insufficient_balance"


# ---------------------------------------------------------------------------
# 3. local_show 主生成路径的 pipeline_timing（P2-36 第 4 项）
# ---------------------------------------------------------------------------

@pytest.fixture()
def show_dir(tmp_path, monkeypatch):
    root = tmp_path / "subtitles"
    (root / SHOW_ID / "S01").mkdir(parents=True)
    (root / SHOW_ID / "S01" / "E01.srt").write_text(SRT_TEXT, encoding="utf-8")
    monkeypatch.setattr(config, "SUBTITLES_DIR", str(root))
    monkeypatch.setattr(routes_content, "SUBTITLES_DIR", str(root))
    return root


def test_local_show_main_generation_records_pipeline_timing(
    client, show_dir, monkeypatch
):
    """主生成（非补译/自愈）也要落 total/batch，管理台才能算 P50/P95。"""

    async def _fake_process_llm_batch(blocks, model=None, vocab_level=None, **kwargs):
        return [
            {"id": block["id"], "zh_text": "中文翻译", "highlights": []}
            for block in blocks
        ]

    async def _no_analysis(*_args, **_kwargs):
        return None

    records: list[dict] = []
    monkeypatch.setattr(routes_content, "process_llm_batch", _fake_process_llm_batch)
    monkeypatch.setattr(llm, "batch_pause", lambda model: 0)
    monkeypatch.setattr(teaching_analysis, "attach_to_payload", _no_analysis)
    monkeypatch.setattr(
        routes_content.pipeline_timing, "record", lambda **kwargs: records.append(kwargs)
    )

    response = client.post(
        "/api/process-subtitle",
        json={"show_id": SHOW_ID, "season": 1, "episode": 1},
    )
    assert response.status_code == 200, response.text

    batches = [record for record in records if record["event"] == "batch"]
    totals = [record for record in records if record["event"] == "total"]
    assert len(batches) == 1
    assert batches[0]["feature"] == "local_show"
    assert batches[0]["content_ref"] == f"{SHOW_ID}-S01E01"
    assert batches[0]["batch_index"] == 0
    assert batches[0]["batch_count"] == 1
    assert batches[0]["ok"] is True
    assert totals and totals[0]["feature"] == "local_show"
    assert totals[0]["content_ref"] == f"{SHOW_ID}-S01E01"
    assert totals[0]["batch_count"] == 1
    assert totals[0]["ok"] is True
    assert totals[0]["meta"]["translated"] == 2
