"""AI 成本账本 + 三层配额 + 降级链的离线验收（M1b）。

覆盖（全部用 tmp 库 / mock provider，不联网、不花额度）：

1. ``0003_cost_ledger`` 空库 upgrade 到 head（另见 test_migrations.py）；
2. ``record_usage`` 写入/读回、按月按功能聚合、``daily_usage`` 配额视图；
3. **未知价格按「已知最贵」计**（不是 0），目录外模型按 ``unknown`` provider；
4. 记账失败（库/表缺失）只记日志、不抛异常、不阻断主流程；
5. 配额 UPSERT 原子递增、超限抛 ``QuotaExceeded``（429），不同功能互不影响；
6. 未迁移库 fail-open（升级顺序安全）；
7. 第二层用户日预算硬闸（``BudgetExceeded``）；
8. 降级链顺序：首选 → 同 provider 更便宜 → 另一个可用 provider；大陆模式
   不含 Gemini，海外模式包含；
9. 模型失败时 ``process_llm_batch`` 走第二个候选；配额超限时不调用模型；
10. ``llm.usage_scope`` + mock provider → ``ai_usage`` 落库、hook 可关；
11. ``/api/define`` 配额耗尽返回 HTTP 429。
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

import config
import llm
import translate
from ai import ledger, quota
from ai.ledger import QuotaExceeded
from tests.migration_utils import assert_alembic_ok, run_alembic

# 2026-11-15 12:00 Asia/Shanghai，固定时间避免跨日/跨月抖动。
TS = int(datetime(2026, 11, 15, 4, 0, tzinfo=timezone.utc).timestamp() * 1000)
DAY = "2026-11-15"
MONTH = "2026-11"

DICT_PAYLOAD = {
    "word": "serendipity",
    "lemma": "serendipity",
    "ipa": "/ˌserənˈdɪpəti/",
    "pos": "n.",
    "zh": "意外发现美好事物的运气",
    "definition_en": "The luck of finding something good without looking for it.",
    "example": "It was pure serendipity that we met.",
}


@pytest.fixture(autouse=True)
def _fixed_quota_tz(monkeypatch):
    """配额日边界固定为 Asia/Shanghai，测试不受本机 .env 影响。"""
    monkeypatch.setattr(config, "AI_QUOTA_TIMEZONE", "Asia/Shanghai", raising=False)


@pytest.fixture()
def ledger_db(tmp_path, monkeypatch):
    """空库跑 Alembic 到 head（含 0003），并把运行时指向它。"""
    db = tmp_path / "ledger.db"
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(db), raising=False)
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    return db


def _count(db, table="ai_usage"):
    with sqlite3.connect(db) as conn:
        return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


# ---------------------------------------------------------------------------
# 账本
# ---------------------------------------------------------------------------

def test_record_usage_writes_row_and_monthly_spend(ledger_db):
    assert ledger.day_of(TS) == DAY
    assert ledger.month_of(TS) == MONTH

    row = ledger.record_usage(
        "user-1", "translate", "gemini-2.5-flash", 1_000_000, 1_000_000, occurred_at=TS
    )
    assert row is not None
    assert row["id"] > 0
    assert row["user_id"] == "user-1"
    assert row["feature"] == "translate"
    assert row["provider"] == "Google"
    assert row["input_tokens"] == 1_000_000
    assert row["output_tokens"] == 1_000_000
    assert row["calls"] == 1
    assert row["usage_date"] == DAY
    assert row["est_cost_usd"] == pytest.approx(0.30 + 2.50)

    ledger.record_usage(
        "user-1", "define", "deepseek-chat", 1_000_000, 1_000_000, occurred_at=TS
    )
    # 另一个用户、另一个月不能混进来
    ledger.record_usage(
        "user-2", "translate", "deepseek-chat", 1_000_000, 0, occurred_at=TS
    )
    ledger.record_usage(
        "user-1",
        "translate",
        "deepseek-chat",
        1_000_000,
        0,
        occurred_at=TS - 40 * 24 * 3600 * 1000,
    )

    spend = ledger.monthly_spend("user-1", MONTH)
    assert spend["user_id"] == "user-1"
    assert spend["month"] == MONTH
    assert set(spend["by_feature"]) == {"translate", "define"}
    assert spend["by_feature"]["translate"]["cost_usd"] == pytest.approx(2.80)
    assert spend["by_feature"]["define"]["cost_usd"] == pytest.approx(2.80)
    assert spend["total_usd"] == pytest.approx(5.60)
    assert spend["calls"] == 2
    assert spend["input_tokens"] == 2_000_000

    daily = ledger.daily_usage("user-1", "translate", DAY)
    assert daily["day"] == DAY
    assert daily["feature"] == "translate"
    assert daily["cost_usd"] == pytest.approx(2.80)
    assert daily["calls"] == 1
    assert daily["quota"] is None  # 还没消耗配额

    all_features = ledger.daily_usage("user-1", day=DAY)
    assert all_features["cost_usd"] == pytest.approx(5.60)
    assert all_features["quota"] == {}


def test_unknown_price_uses_known_most_expensive(ledger_db):
    ceiling = ledger.known_ceiling_prices()
    assert ceiling == (0.30, 2.50), "已知价最高值来自 gemini-2.5-flash"

    # 目录内缺价（DeepSeek 两个价格都是 None）→ 按已知最贵，不得当 0
    assert ledger.price_for("deepseek-chat") == ceiling
    assert ledger.price_for("gemini-3.5-flash-lite") == ceiling
    # 目录外模型同样按最贵；provider 不编造
    assert ledger.price_for("mystery-model") == ceiling
    row = ledger.record_usage("user-1", "translate", "mystery-model", 1_000_000, 0, occurred_at=TS)
    assert row["provider"] == "unknown"
    assert row["est_cost_usd"] == pytest.approx(0.30)
    assert row["est_cost_usd"] > 0, "未知价格绝不能记成 0"


def test_usage_extractors_cover_both_providers():
    google_response = SimpleNamespace(
        usage_metadata=SimpleNamespace(
            prompt_token_count=120, candidates_token_count=34, total_token_count=154
        )
    )
    assert ledger.usage_from_google_response(google_response) == {
        "input_tokens": 120,
        "output_tokens": 34,
    }
    assert ledger.usage_from_openai_response(
        {"usage": {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10}}
    ) == {"input_tokens": 7, "output_tokens": 3}
    # 没有 usage 时返回 0，由 llm.py 决定按字符保守估算
    assert ledger.usage_from_openai_response({}) == {"input_tokens": 0, "output_tokens": 0}
    assert ledger.usage_from_google_response(SimpleNamespace()) == {
        "input_tokens": 0,
        "output_tokens": 0,
    }


def test_record_usage_failure_does_not_raise(tmp_path, monkeypatch):
    monkeypatch.setattr(
        config, "AUTH_DB_PATH", str(tmp_path / "missing" / "app.db"), raising=False
    )
    assert ledger.record_usage("user-1", "translate", "deepseek-chat", 10, 5) is None
    assert ledger.record_usage("user-1", "not-a-feature", "deepseek-chat", 1, 1) is None


# ---------------------------------------------------------------------------
# 配额（功能日限额）
# ---------------------------------------------------------------------------

def test_quota_upsert_and_exceeded(ledger_db):
    first = ledger.check_and_consume_quota("user-1", "define", 1, limit=2, day=DAY)
    assert first["used_units"] == 1
    assert first["remaining"] == 1
    assert first["limit_units"] == 2

    second = ledger.check_and_consume_quota("user-1", "define", 1, limit=2, day=DAY)
    assert second["used_units"] == 2
    assert second["remaining"] == 0

    with pytest.raises(QuotaExceeded) as excinfo:
        ledger.check_and_consume_quota("user-1", "define", 1, limit=2, day=DAY)
    assert excinfo.value.status_code == 429
    assert excinfo.value.used_units == 2
    assert excinfo.value.limit_units == 2
    assert "额度" in str(excinfo.value)

    # 超限回滚后计数保持 2，不会虚增
    daily = ledger.daily_usage("user-1", "define", DAY)
    assert daily["quota"] == {"used_units": 2, "limit_units": 2, "remaining": 0}

    # 不同功能独立计数
    other = ledger.check_and_consume_quota("user-1", "summary", 1, limit=1, day=DAY)
    assert other["used_units"] == 1
    assert _count(ledger_db, "ai_quota") == 2


def test_quota_fail_open_when_tables_missing(tmp_path, monkeypatch):
    """未跑 0003 迁移的库不能把 AI 功能整条链路打死（记日志 + 放行）。"""
    import auth_db

    monkeypatch.setattr(config, "AUTH_DB_PATH", str(tmp_path / "app.db"), raising=False)
    auth_db.init_db()  # 只有 users/sessions

    result = quota.check_and_consume_quota("user-1", "define")
    assert result["allowed"] is True
    assert result["enforced"] is False


def test_budget_exceeded_is_quota_exceeded(ledger_db, monkeypatch):
    # 先制造 $2.80 的当日花费，再把用户日预算压到 $0.50
    ledger.record_usage(
        "user-1", "translate", "gemini-2.5-flash", 1_000_000, 1_000_000, occurred_at=TS
    )
    monkeypatch.setattr(config, "AI_DAILY_BUDGET_USER_USD", 0.50, raising=False)
    monkeypatch.setattr(config, "AI_DAILY_BUDGET_GLOBAL_USD", 20.0, raising=False)
    monkeypatch.setattr(config, "AI_DAILY_QUOTA_DEFINE", 200, raising=False)

    with pytest.raises(quota.BudgetExceeded) as excinfo:
        quota.check_and_consume_quota("user-1", "define", day=DAY)
    assert isinstance(excinfo.value, QuotaExceeded)
    assert excinfo.value.status_code == 429
    assert excinfo.value.scope == "user"
    assert "预算" in str(excinfo.value)


# ---------------------------------------------------------------------------
# 降级链
# ---------------------------------------------------------------------------

def _install_fake_catalog(monkeypatch):
    fake = {
        "premium": {
            "name": "Premium", "provider": "DeepSeek", "kind": "openai_compatible",
            "model_id": "premium", "base_url": "https://example.invalid/v1",
            "api_key_env": "TEST_PREMIUM_KEY", "batch_pause": 0,
            "in": 10.0, "out": 20.0, "quotaInfo": "test",
        },
        "cheap": {
            "name": "Cheap", "provider": "DeepSeek", "kind": "openai_compatible",
            "model_id": "cheap", "base_url": "https://example.invalid/v1",
            "api_key_env": "TEST_CHEAP_KEY", "batch_pause": 0,
            "in": 1.0, "out": 2.0, "quotaInfo": "test",
        },
        "other": {
            "name": "Other", "provider": "Moonshot", "kind": "openai_compatible",
            "model_id": "other", "base_url": "https://example.invalid/v1",
            "api_key_env": "TEST_OTHER_KEY", "batch_pause": 0,
            "in": 5.0, "out": 5.0, "quotaInfo": "test",
        },
        "google-x": {
            "name": "Google X", "provider": "Google", "kind": "google",
            "model_id": "google-x", "api_key_env": "TEST_GOOGLE_KEY", "batch_pause": 0,
            "in": 0.1, "out": 0.1, "quotaInfo": "test",
        },
    }
    monkeypatch.setattr(config, "MODEL_CATALOG", fake, raising=False)
    monkeypatch.setattr(config, "DEFAULT_MODEL", "premium", raising=False)
    # llm.py 在 import 时绑定了目录别名；测试里两个模块一起指到假目录。
    monkeypatch.setattr(llm, "MODEL_CATALOG", fake, raising=False)
    monkeypatch.setattr(llm, "DEFAULT_MODEL", "premium", raising=False)
    for env in ("TEST_PREMIUM_KEY", "TEST_CHEAP_KEY", "TEST_OTHER_KEY", "TEST_GOOGLE_KEY"):
        monkeypatch.setenv(env, "test-key")
    return fake


def test_degradation_chain_cn_excludes_gemini(monkeypatch):
    _install_fake_catalog(monkeypatch)
    monkeypatch.setattr(config, "AI_MODEL_REGION", "auto", raising=False)

    # 大陆口径（默认模型是 DeepSeek）：同 provider 更便宜 → 另一个非 Google provider
    assert quota.degradation_chain("translate", "premium") == [
        "premium", "cheap", "other",
    ], "Gemini 不得进入大陆默认降级链"
    assert "google-x" not in quota.degradation_chain("define")

    # 首选不可用时，种子按「大陆优先 + 更便宜」选
    monkeypatch.delenv("TEST_PREMIUM_KEY", raising=False)
    assert quota.degradation_chain("translate", "premium")[0] == "cheap"


def test_degradation_chain_overseas_includes_gemini(monkeypatch):
    _install_fake_catalog(monkeypatch)
    monkeypatch.setattr(config, "DEFAULT_MODEL", "google-x", raising=False)
    monkeypatch.setattr(llm, "DEFAULT_MODEL", "google-x", raising=False)
    monkeypatch.setattr(config, "AI_MODEL_REGION", "auto", raising=False)
    chain = quota.degradation_chain("translate")
    assert chain[0] == "google-x"
    assert set(chain) == {"google-x", "cheap", "other", "premium"}
    assert chain.index("cheap") < chain.index("other") < chain.index("premium")


def test_process_llm_batch_falls_back_on_model_failure(monkeypatch):
    calls = []

    def fake_generate_json(prompt, model=None):
        calls.append(model)
        if model == "model-a":
            raise RuntimeError("provider 429")
        return json.dumps(
            {"blocks": [{"id": 1, "zh_text": "你好。", "highlights": []}]},
            ensure_ascii=False,
        )

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)
    monkeypatch.setattr(
        translate.quota,
        "degradation_chain",
        lambda feature=None, preferred_model=None: ["model-a", "model-b"],
    )

    result = asyncio.run(
        translate.process_llm_batch(
            [{"id": 1, "text": "Hello.", "start": 0.0, "end": 1.0}],
            model="model-a",
            user_id=None,
        )
    )
    assert calls == ["model-a", "model-b"], "第一个模型失败后必须走第二个候选"
    assert result[0]["zh_text"] == "你好。"


def test_process_llm_batch_blocks_model_when_quota_exceeded(ledger_db, monkeypatch):
    monkeypatch.setattr(config, "AI_DAILY_QUOTA_TRANSLATE_BATCHES", 1, raising=False)
    monkeypatch.setattr(config, "AI_DAILY_BUDGET_USER_USD", 0, raising=False)
    monkeypatch.setattr(config, "AI_DAILY_BUDGET_GLOBAL_USD", 0, raising=False)
    calls = []

    def fake_generate_json(prompt, model=None):
        calls.append(model)
        return json.dumps(
            {"blocks": [{"id": 1, "zh_text": "你好。", "highlights": []}]},
            ensure_ascii=False,
        )

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)
    blocks = [{"id": 1, "text": "Hello.", "start": 0.0, "end": 1.0}]

    first = asyncio.run(
        translate.process_llm_batch(blocks, model="deepseek-chat", user_id="quota-user")
    )
    assert first[0]["zh_text"] == "你好。"

    with pytest.raises(QuotaExceeded) as excinfo:
        asyncio.run(
            translate.process_llm_batch(blocks, model="deepseek-chat", user_id="quota-user")
        )
    assert excinfo.value.status_code == 429
    assert calls == ["deepseek-chat"], "配额超限后不得再调用模型"

    daily = ledger.daily_usage("quota-user", "translate")
    assert daily["quota"]["used_units"] == 1
    assert daily["quota"]["limit_units"] == 1

    # 总结额度为 0：不调用模型，返回可自愈的占位文案（不打断主链路）
    monkeypatch.setattr(config, "AI_DAILY_QUOTA_SUMMARY", 0, raising=False)
    summary_calls = []
    monkeypatch.setattr(llm, "generate_text", lambda *a, **k: summary_calls.append(1) or "x")
    summary = asyncio.run(
        translate.summarize_video_transcript(
            [{"text": "Hello."}], user_id="summary-user"
        )
    )
    assert summary == translate.SUMMARY_ERROR_TEXT
    assert summary_calls == []


# ---------------------------------------------------------------------------
# llm usage hook + HTTP 429
# ---------------------------------------------------------------------------

def test_llm_usage_hook_records_usage(ledger_db, monkeypatch):
    def fake_openai(prompt, spec, json_mode):
        return "hello", {"input_tokens": 1200, "output_tokens": 340}

    monkeypatch.setattr(llm, "_generate_openai_compatible", fake_openai)

    with llm.usage_scope("define", "hook-user"):
        assert llm.generate_text("Explain serendipity", model="deepseek-chat") == "hello"

    spend = ledger.monthly_spend("hook-user", ledger.month_of())
    assert spend["total_usd"] == pytest.approx(
        ledger.estimate_cost_usd("deepseek-chat", 1200, 340)
    )
    assert spend["by_feature"]["define"]["input_tokens"] == 1200
    assert spend["by_feature"]["define"]["output_tokens"] == 340
    assert spend["calls"] == 1
    assert _count(ledger_db) == 1

    # 没有 usage_scope 的调用不记账（hook 是 opt-in）
    llm.generate_text("no scope", model="deepseek-chat")
    assert _count(ledger_db) == 1

    # 全局开关可关
    monkeypatch.setattr(config, "AI_USAGE_LOGGING", False, raising=False)
    with llm.usage_scope("define", "hook-user"):
        llm.generate_text("logging off", model="deepseek-chat")
    assert _count(ledger_db) == 1


def test_define_returns_429_when_daily_quota_exhausted(client, monkeypatch):
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade (client db)"
    )
    monkeypatch.setattr(config, "AI_DAILY_QUOTA_DEFINE", 1, raising=False)
    monkeypatch.setattr(config, "AI_DAILY_BUDGET_USER_USD", 0, raising=False)
    monkeypatch.setattr(config, "AI_DAILY_BUDGET_GLOBAL_USD", 0, raising=False)
    calls = []

    def fake_generate_json(prompt, model=None):
        calls.append(model)
        return json.dumps(DICT_PAYLOAD, ensure_ascii=False)

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)

    first = client.post("/api/define", json={"word": "firstword"})
    assert first.status_code == 200, first.text
    assert first.json()["zh"] == DICT_PAYLOAD["zh"]

    second = client.post("/api/define", json={"word": "secondword"})
    assert second.status_code == 429, second.text
    assert "额度" in second.json()["detail"]
    assert len(calls) == 1, "超出日限额后不得再调用模型"
