"""``/api/estimate-cost`` 估价与计费同源的离线验收（specs/010 §估价与计费同源）。

覆盖：

1. 迁移 head（0025 自带价格 seed）后，``models[].estimatedCost`` 非空，且
   与扣费同一口径：``(inputTokens*300000 + outputTokens*1200000)/1e12``
   （deepseek-chat 在 ``model_prices`` 的实测单价，``MODEL_CATALOG`` 已是 null）；
2. 价格表无行且目录无价 → ``estimatedCost=null``，接口仍 200（前端「待定」）；
3. 价格表未迁移的临时库 → 200 + null（不 500）；
4. ``price_for_model`` 抛错 → 200 + null + warning（不 500）。

全部离线：视频元数据/字幕用 monkeypatch 假件，库在 ``tmp_path``。
"""
from __future__ import annotations

import logging
import sqlite3
from types import SimpleNamespace

import pytest

import billing
import config
import routes_videos
from tests.migration_utils import assert_alembic_ok, run_alembic

URL = "https://www.youtube.com/watch?v=estimate123"
VIDEO_ID = "estimate123"

# 10 个词 → 估价口径 input_tokens=15、output_tokens=20（见路由里的 1.5/2.0 系数）
TRANSCRIPT = [
    SimpleNamespace(
        text="one two three four five six seven eight nine ten",
        start=0.0,
        duration=3.0,
    )
]
METADATA = {
    "title": "Estimate Test",
    "channel": "Test Channel",
    "thumbnail": "https://example.invalid/thumb.jpg",
}

# 0025 迁移 seed 的 deepseek-chat 单价（µUSD / 1M tokens）
DEEPSEEK_IN = 300_000
DEEPSEEK_OUT = 1_200_000


@pytest.fixture()
def migrated_db(tmp_path, monkeypatch):
    """独立空库跑 Alembic 到 head（含 model_prices seed），运行时指向它。"""
    db = tmp_path / "estimate.db"
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(db), raising=False)
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    billing.reset_cache()
    yield db
    billing.reset_cache()


def _install_video_fakes(monkeypatch):
    monkeypatch.setattr(routes_videos, "get_video_metadata", lambda url: dict(METADATA))
    monkeypatch.setattr(
        routes_videos, "fetch_english_transcript", lambda video_id: list(TRANSCRIPT)
    )


def _estimate(make_client, monkeypatch):
    _install_video_fakes(monkeypatch)
    with make_client() as client:
        return client.get("/api/estimate-cost", params={"url": URL})


def _models_by_id(payload: dict) -> dict:
    return {entry["id"]: entry for entry in payload["models"]}


def test_estimate_cost_uses_price_table_same_as_billing(
    migrated_db, make_client, monkeypatch
):
    """有价格行时估价非空，且与 billing 扣费公式一致。"""
    response = _estimate(make_client, monkeypatch)
    assert response.status_code == 200, response.text

    data = response.json()
    assert data["videoId"] == VIDEO_ID
    stats = data["transcriptStats"]
    assert stats["wordCount"] == 10
    assert stats["estimatedInputTokens"] == 15
    assert stats["estimatedOutputTokens"] == 20

    # 价格来源就是 billing 计费用的那张表，不是 MODEL_CATALOG 的旧字段。
    price = billing.price_for_model("deepseek-chat")
    assert price is not None
    assert price["inputMicroUsdPerMtok"] == DEEPSEEK_IN
    assert price["outputMicroUsdPerMtok"] == DEEPSEEK_OUT

    expected = round(
        (
            stats["estimatedInputTokens"] * DEEPSEEK_IN
            + stats["estimatedOutputTokens"] * DEEPSEEK_OUT
        )
        / 1e12,
        6,
    )
    assert expected > 0

    by_id = _models_by_id(data)
    assert by_id["deepseek-chat"]["estimatedCost"] == expected
    # 同一价格来源下，另一条 seed 价（gemini-2.5-flash）也必须有估价。
    assert by_id["gemini-2.5-flash"]["estimatedCost"] is not None


def test_estimate_cost_null_when_price_table_empty_and_catalog_unpriced(
    migrated_db, make_client, monkeypatch
):
    """无价格行 + 目录无价 → null（不编造），接口仍 200。"""
    with sqlite3.connect(migrated_db) as conn:
        conn.execute("DELETE FROM model_prices")

    assert billing.price_for_model("deepseek-chat") is None

    response = _estimate(make_client, monkeypatch)
    assert response.status_code == 200, response.text

    by_id = _models_by_id(response.json())
    assert by_id["deepseek-chat"]["estimatedCost"] is None
    assert by_id["qwen-flash"]["estimatedCost"] is None
    assert by_id["gemini-3.1-pro-preview"]["estimatedCost"] is None


def test_estimate_cost_null_on_unmigrated_db(make_client, monkeypatch):
    """价格表未迁移的临时库：估价按缺价处理，200 而不是 500。"""
    assert billing.schema_ready() is False, "本用例的库应保持未迁移"

    response = _estimate(make_client, monkeypatch)
    assert response.status_code == 200, response.text

    models = response.json()["models"]
    assert models
    assert all(entry["estimatedCost"] is None for entry in models)


def test_estimate_cost_null_when_price_lookup_raises(
    client, monkeypatch, caplog
):
    """price_for_model 抛错（如价格表损坏）：按无价处理并记 warning。"""
    _install_video_fakes(monkeypatch)

    def boom(model_id, **kwargs):
        raise sqlite3.OperationalError("no such table: model_prices")

    monkeypatch.setattr(billing, "price_for_model", boom)
    caplog.set_level(logging.WARNING, logger="linguatrek.routes_videos")

    response = client.get("/api/estimate-cost", params={"url": URL})
    assert response.status_code == 200, response.text
    assert all(
        entry["estimatedCost"] is None for entry in response.json()["models"]
    )
    assert "估价读取模型价格失败" in caplog.text
