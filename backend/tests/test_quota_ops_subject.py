"""P0-05：配额上限单源 + ops/sponsored 主体离线验收。

覆盖（全部 tmp 库 + 假 provider，不联网、不花钱）：

1. **上限单源**：判断只用 ``config``（``quota.limit_for``）；``ai_quota.limit_units``
   只是审计快照。同一 (user, day, feature) 行里写着 400，也必须按当前进程
   config 的 30 拒绝（不再出现 374/30 与 374/400 两套判断）。
2. **审计快照不参与判定**：命中 config 上限时成功消费会刷新快照；被拒绝时不
   覆写历史/审计行。
3. **读侧快照**：``quota.snapshot()`` 的 limit 取 config，另给审计快照，不把
   DB 值当第二真源。
4. **ops/sponsored 主体**：不写用户 ``ai_quota``、不扣余额；``ai_usage`` 照记
   tokens/成本，但 ``billable=0``、``billing_status='ops_warm'``（sponsored →
   ``'sponsored'``）；只受可选的独立日配额与全局日预算约束。
5. **用户路径不回归**：超限 429 且 body 带 used/limit；余额不足仍 402。
6. **预热不占用户额度**：ops 预热后，用户当天换档位分析仍可生成。
7. 脚本默认 ops 主体；旧 ``--user-id`` 需要显式确认。

背景：2026-11-22 的 374/30 故障中，预热进程用 ``AI_DAILY_QUOTA_ANALYSIS=400``
把用户当天 ``ai_quota.limit_units`` 覆写成 400，服务进程随后读到了第二套上限，
同一个 374 出现 30 / 400 两种判断。
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

import billing
import config
import llm
import teaching_analysis
from ai import ledger, quota
from ai.ledger import QuotaExceeded
from tests.migration_utils import assert_alembic_ok, run_alembic

# 2026-11-15 12:00 Asia/Shanghai，固定时间避免跨日抖动。
TS = int(datetime(2026, 11, 15, 4, 0, tzinfo=timezone.utc).timestamp() * 1000)
DAY = "2026-11-15"
PREV_DAY = "2026-11-14"

OPS_SUBJECT = "ops:warm-library"
SPONSORED_SUBJECT = "sponsored:library-launch"

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
# 夹具 / 工具
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _fixed_quota_tz(monkeypatch):
    monkeypatch.setattr(config, "AI_QUOTA_TIMEZONE", "Asia/Shanghai", raising=False)


@pytest.fixture()
def quota_db(tmp_path, monkeypatch):
    """迁移到 head 的独立库（含 0003 配额、0020 分析、0025 计费）。"""
    db = tmp_path / "p0-05.db"
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(db), raising=False)
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    billing.reset_cache()
    teaching_analysis.reset_locks()
    yield db
    billing.reset_cache()
    teaching_analysis.reset_locks()


def _rows(db, sql: str, params: tuple = ()) -> list[tuple]:
    with sqlite3.connect(db) as conn:
        return conn.execute(sql, params).fetchall()


def _count(db, table: str) -> int:
    return _rows(db, f"SELECT COUNT(*) FROM {table}")[0][0]


def _seed_quota_row(
    db,
    *,
    user_id: str = "u1",
    feature: str = "analysis",
    day: str = DAY,
    used: int = 0,
    limit: int = 0,
) -> None:
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO ai_quota (user_id, day, feature, used_units, limit_units) "
            "VALUES (?, ?, ?, ?, ?)",
            (user_id, day, feature, used, limit),
        )
        conn.commit()


def _quota_row(db, user_id: str = "u1", feature: str = "analysis", day: str = DAY):
    rows = _rows(
        db,
        "SELECT used_units, limit_units FROM ai_quota "
        "WHERE user_id = ? AND day = ? AND feature = ?",
        (user_id, day, feature),
    )
    return rows[0] if rows else None


class _LlmStub:
    """教学分析桩：按 prompt 的候选词生成合法分析 JSON（P2-37 内容级同形）。"""

    def __init__(self) -> None:
        self.prompts: list[str] = []

    async def generate_json_async(self, prompt: str, model: str | None = None):
        self.prompts.append(prompt)
        return json.dumps(_analysis_from_prompt(prompt), ensure_ascii=False)


def _analysis_from_prompt(prompt: str) -> dict:
    blocks = json.loads(prompt.rsplit("Blocks:\n", 1)[-1])
    highlights: list[dict] = []
    idioms: list[dict] = []
    culture: list[dict] = []
    for block in blocks:
        en = block.get("en", "")
        zh = block.get("zh", "")
        for word in block.get("candidates", []):
            highlights.append(
                {"blockId": block["blockId"], "en_word": word, "zh_word": zh[:2]}
            )
        parts = en.split()
        if parts:
            idioms.append(
                {
                    "blockId": block["blockId"],
                    "phrase": " ".join(parts[:2]),
                    "meaning": "测试含义",
                    "quote": en,
                }
            )
            culture.append(
                {
                    "blockId": block["blockId"],
                    "term": parts[0],
                    "note": "测试文化点",
                    "quote": en,
                }
            )
    return {"highlights": highlights, "idioms": idioms, "culture": culture}


@pytest.fixture()
def llm_stub(monkeypatch):
    stub = _LlmStub()
    monkeypatch.setattr(llm, "generate_json_async", stub.generate_json_async)
    return stub


# ---------------------------------------------------------------------------
# 1. 上限单源：判断不看 ai_quota.limit_units
# ---------------------------------------------------------------------------

def test_quota_judges_by_config_not_stored_snapshot(quota_db, monkeypatch):
    """行里是别的进程写的 400，本进程 config=30 → 必须 429 且报 374/30。"""
    _seed_quota_row(quota_db, used=374, limit=400)
    monkeypatch.setattr(config, "AI_DAILY_QUOTA_ANALYSIS", 30, raising=False)

    with pytest.raises(QuotaExceeded) as excinfo:
        quota.check_and_consume_quota("u1", "analysis", day=DAY)

    exc = excinfo.value
    assert exc.status_code == 429
    assert exc.used_units == 374
    assert exc.limit_units == 30, "错误里的上限必须取当前 config，而不是行内审计快照"
    payload = exc.payload()
    assert payload["code"] == "quota_exceeded"
    assert payload["feature"] == "analysis"
    assert payload["used"] == 374
    assert payload["limit"] == 30
    # 被拒绝的尝试回滚：审计快照与已用数都不被这次请求改写。
    assert _quota_row(quota_db) == (374, 400)


def test_quota_allows_when_config_is_higher_than_stored_snapshot(quota_db, monkeypatch):
    """反向同理：行里是 30，但本进程 config=400 → 允许，且审计快照刷新为 400。"""
    _seed_quota_row(quota_db, used=374, limit=30)
    monkeypatch.setattr(config, "AI_DAILY_QUOTA_ANALYSIS", 400, raising=False)

    result = quota.check_and_consume_quota("u1", "analysis", day=DAY)

    assert result["allowed"] is True
    assert result["used_units"] == 375
    assert result["limit_units"] == 400, "返回给调用方的上限也必须取 config"
    assert _quota_row(quota_db) == (375, 400)


def test_limit_change_does_not_rewrite_previous_day_rows(quota_db, monkeypatch):
    """改上限只影响当前/之后消费；历史日的审计行原样保留。"""
    monkeypatch.setattr(config, "AI_DAILY_QUOTA_ANALYSIS", 30, raising=False)
    ledger.check_and_consume_quota("u1", "analysis", 1, day=PREV_DAY)

    monkeypatch.setattr(config, "AI_DAILY_QUOTA_ANALYSIS", 400, raising=False)
    ledger.check_and_consume_quota("u1", "analysis", 1, day=DAY)

    assert _quota_row(quota_db, day=PREV_DAY) == (1, 30)
    assert _quota_row(quota_db, day=DAY) == (1, 400)


def test_snapshot_reads_limit_from_config_and_keeps_audit(quota_db, monkeypatch):
    _seed_quota_row(quota_db, used=5, limit=400)
    monkeypatch.setattr(config, "AI_DAILY_QUOTA_ANALYSIS", 30, raising=False)

    snap = quota.snapshot("u1", "analysis", DAY)
    assert snap["used_units"] == 5
    assert snap["limit_units"] == 30
    assert snap["remaining"] == 25
    assert snap["audit_limit_units"] == 400, "审计快照可以展示，但不能参与判定"


# ---------------------------------------------------------------------------
# 2. ops / sponsored 主体：不占用户额度与余额
# ---------------------------------------------------------------------------

def test_ops_subject_does_not_write_user_quota(quota_db, monkeypatch):
    monkeypatch.setattr(config, "AI_OPS_DAILY_QUOTA", {}, raising=False)

    result = quota.check_and_consume_quota(OPS_SUBJECT, "analysis", day=DAY)

    assert result["allowed"] is True
    assert result["ops"] is True
    assert _count(quota_db, "ai_quota") == 0, "ops 预热不得写用户（或任何）ai_quota 行"


def test_ops_subject_has_independent_quota(quota_db, monkeypatch):
    """可选独立配额：只数 ops 主体自己，不占用户额度。"""
    monkeypatch.setattr(config, "AI_OPS_DAILY_QUOTA", {"analysis": 2}, raising=False)

    first = quota.check_and_consume_quota(OPS_SUBJECT, "analysis", day=DAY)
    second = quota.check_and_consume_quota(OPS_SUBJECT, "analysis", day=DAY)
    assert (first["used_units"], second["used_units"]) == (1, 2)

    with pytest.raises(QuotaExceeded) as excinfo:
        quota.check_and_consume_quota(OPS_SUBJECT, "analysis", day=DAY)
    assert excinfo.value.used_units == 2
    assert excinfo.value.limit_units == 2
    # 独立主体行；用户行依旧不存在。
    assert _quota_row(quota_db, user_id=OPS_SUBJECT) == (2, 2)
    assert _quota_row(quota_db, user_id="u1") is None


def test_ops_and_sponsored_are_not_billable_subjects():
    assert ledger.is_ops_subject(OPS_SUBJECT) is True
    assert ledger.is_ops_subject(SPONSORED_SUBJECT) is True
    assert ledger.is_ops_subject("user-1") is False
    assert ledger.is_ops_subject("guest:abc") is False
    assert ledger.is_ops_subject(None) is False
    assert billing._is_billable_user(OPS_SUBJECT) is False
    assert billing._is_billable_user(SPONSORED_SUBJECT) is False
    assert billing._is_billable_user("user-1") is True


def test_ops_llm_usage_is_recorded_unbillable(quota_db, monkeypatch):
    """走真实 llm → billing 链路：ops 不预占、不扣余额，但账本可审计。"""
    calls: list[str] = []

    def _fake_provider(prompt, spec, json_mode):
        calls.append(spec.get("model_id") or "")
        return "ok", {"input_tokens": 1000, "output_tokens": 500}

    monkeypatch.setattr(llm, "_generate_openai_compatible", _fake_provider)

    with llm.usage_scope("analysis", OPS_SUBJECT):
        llm.generate("p005 ops prompt", model="deepseek-chat")

    rows = _rows(
        quota_db,
        "SELECT user_id, billable, billing_status, input_tokens, output_tokens, "
        "est_cost_usd FROM ai_usage",
    )
    assert len(rows) == 1
    user_id, billable, status, in_tokens, out_tokens, cost = rows[0]
    assert user_id == OPS_SUBJECT
    assert billable == 0, "ops 主体绝不能标记为可扣费"
    assert status == "ops_warm"
    assert (in_tokens, out_tokens) == (1000, 500)
    assert cost > 0, "ops 成本仍要可审计"
    assert _count(quota_db, "credit_holds") == 0
    assert _count(quota_db, "account_ledger") == 0


def test_ops_cost_visible_per_subject_in_admin_summary(quota_db):
    """管理台汇总按主体单列 ops 成本（不展开普通用户 id）。"""
    ledger.record_usage(
        OPS_SUBJECT, "analysis", "deepseek-chat", 1_000_000, 500_000, occurred_at=TS
    )
    ledger.record_usage(
        "user-1", "analysis", "deepseek-chat", 1_000_000, 0, occurred_at=TS
    )

    summary = billing.billing_summary()
    subjects = {item["subject"]: item for item in summary["bySubject"]}
    assert set(subjects) == {OPS_SUBJECT}, "只列非用户主体，不展开普通用户 id"
    ops_row = subjects[OPS_SUBJECT]
    assert ops_row["kind"] == "ops"
    assert ops_row["calls"] == 1
    assert ops_row["estimatedCostUsd"] > 0, "ops 成本仍要可审计"
    assert ops_row["billedCostMicroUsd"] == 0, "ops 不产生真实扣费"
    assert summary["totals"]["estimatedCostUsd"] > 0


def test_sponsored_subject_is_recorded_as_sponsored(quota_db):
    row = ledger.record_usage(
        SPONSORED_SUBJECT,
        "analysis",
        "deepseek-chat",
        2000,
        800,
        occurred_at=TS,
        billable=1,  # 即使调用方误传，也不能把 ops/sponsored 记成可扣费
        billing_status="settled",
    )
    assert row is not None
    assert row["user_id"] == SPONSORED_SUBJECT
    assert row["billable"] == 0
    assert row["billing_status"] == "sponsored"


def test_ops_then_user_analysis_still_generates(quota_db, llm_stub, monkeypatch):
    """预热不占用户额度：ops 生成内容级分析后，用户换档位只读缓存、零配额。

    P2-37：同一内容 + 语言只生成一次内容级 gloss，六档切换由本地筛选，
    不再为「新档位」调模型/占配额。
    """
    monkeypatch.setattr(config, "AI_DAILY_QUOTA_ANALYSIS", 30, raising=False)
    monkeypatch.setattr(config, "AI_OPS_DAILY_QUOTA", {}, raising=False)

    async def run():
        warm = await teaching_analysis.ensure_analysis(
            BLOCKS,
            "liftoff",
            "zh-CN",
            content_ref="library:p005",
            subject=OPS_SUBJECT,
        )
        # 用户同档位：缓存命中，零配额。
        cached = await teaching_analysis.ensure_analysis(
            BLOCKS, "liftoff", "zh-CN", user_id="u1"
        )
        # 用户新档位：同一内容级缓存命中（零模型调用），用户额度不消耗。
        fresh = await teaching_analysis.ensure_analysis(
            BLOCKS, "orbit", "zh-CN", user_id="u1"
        )
        return warm, cached, fresh

    warm, cached, fresh = asyncio.run(run())
    assert warm == cached
    assert fresh["level"] == "orbit"
    assert len(llm_stub.prompts) == 1, "内容级分析一次生成；换档位由本地筛选"
    today = ledger.day_of()
    assert _quota_row(quota_db, user_id=OPS_SUBJECT) is None
    assert _quota_row(quota_db, user_id="u1", day=today) is None, (
        "ops 预热 + 用户换档位缓存命中都不占用户额度"
    )


# ---------------------------------------------------------------------------
# 3. 用户路径不回归：429 带 used/limit、余额不足仍 402
# ---------------------------------------------------------------------------

def test_user_quota_429_payload_has_used_and_limit(quota_db, monkeypatch):
    monkeypatch.setattr(config, "AI_DAILY_QUOTA_ANALYSIS", 1, raising=False)
    ledger.check_and_consume_quota("u1", "analysis", 1, day=DAY)

    with pytest.raises(QuotaExceeded) as excinfo:
        quota.check_and_consume_quota("u1", "analysis", day=DAY)
    payload = excinfo.value.payload()
    assert payload["code"] == "quota_exceeded"
    assert payload["used"] == 1
    assert payload["limit"] == 1


def test_user_insufficient_balance_still_402(quota_db, make_client, monkeypatch):
    with make_client() as client:
        signup = client.post(
            "/api/auth/signup",
            json={
                "email": "p005-user@example.com",
                "password": "p005-password-123",
                "username": "p005用户",
            },
        )
        assert signup.status_code == 201, signup.text
        user_id = signup.json()["user"]["id"]
        with sqlite3.connect(quota_db) as conn:
            conn.execute(
                "UPDATE users SET balance_micro_usd = 0 WHERE id = ?", (user_id,)
            )
            conn.commit()

        response = client.post("/api/define", json={"word": "p005payment"})
        assert response.status_code == 402, response.text
        body = response.json()
        assert body["code"] == "insufficient_balance"
        assert body["balanceMicroUsd"] == 0
        # 402 先于 429：没有先扣 define 日配额。
        assert _quota_row(quota_db, user_id=user_id, feature="define") is None


# ---------------------------------------------------------------------------
# 4. 预热脚本：默认 ops 主体；--user-id 兼容但需显式确认
# ---------------------------------------------------------------------------

def _load_warm_script():
    path = (
        Path(__file__).resolve().parents[2] / "scripts" / "warm_library_analysis.py"
    )
    spec = importlib.util.spec_from_file_location("warm_library_analysis_p005", path)
    module = importlib.util.module_from_spec(spec)
    # dataclass（from __future__ import annotations）在 exec 时需要模块已在
    # sys.modules 里，否则解析注解会 AttributeError。
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_warm_script_defaults_to_ops_and_guards_user_billing():
    script = _load_warm_script()
    resolve = script.resolve_actor

    assert resolve(None, None, confirm_user_billing=False, real_run=True) == (
        "ops",
        OPS_SUBJECT,
    )
    assert resolve(None, SPONSORED_SUBJECT, confirm_user_billing=False, real_run=True) == (
        "ops",
        SPONSORED_SUBJECT,
    )
    # 非 ops/sponsored 前缀不得当主体（否则等于绕过用户配额）。
    with pytest.raises(ValueError):
        resolve(None, "some-user-id", confirm_user_billing=False, real_run=True)
    # 旧 --user-id 真跑必须显式确认会消耗该用户配额/余额。
    with pytest.raises(ValueError):
        resolve("user-1", None, confirm_user_billing=False, real_run=True)
    assert resolve("user-1", None, confirm_user_billing=True, real_run=True) == (
        "user",
        "user-1",
    )
    # dry-run 不消耗，不需要确认。
    assert resolve("user-1", None, confirm_user_billing=False, real_run=False) == (
        "user",
        "user-1",
    )
