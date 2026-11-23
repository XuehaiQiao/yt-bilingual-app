"""余额与 AI 计费（M3a）的离线验收（specs/034-balance-billing）。

覆盖（全部 tmp 库 + mock provider，不联网、不花钱）：

1. 迁移 0025：三张新表 + users.balance_micro_usd + ai_usage 计费列 + 价格 seed
   + 历史 ai_usage 行标 legacy + 存量 active 用户补发 $2.00，且手工重跑不重复发；
2. 旧库兼容建表（``billing.ensure_schema_compat``）与迁移后的 schema 一致；
3. 开户事务：公开注册 / 邀请码注册都在同一事务写 balance=2,000,000 + ledger
   ``signup_bonus``；失败整笔回滚（用户没建、邀请码没消耗）；
4. 管理员充/扣：美元字符串精确转 µUSD、幂等键、上限、负数、负数余额拒绝；
5. 余额服务：available = 账面 − active holds；并发预占不超扣；
6. 结算 / 释放 / 过期 / overrun / 重复结算幂等；
7. AI 集成：有价模型预占→结算写 ai_usage+流水；缺价模型 billable=0 不扣；
   provider 失败释放 hold；结算失败保留 hold + 标 settle_failed；
8. 402 语义（JSON code/balanceMicroUsd/requiredMicroUsd）且不先扣日配额；
   日预算仍是 429；
9. 价格表版本：新版本按 effective_from_ms 生效，历史行不覆盖；
10. 管理台 API：balance / ledger / billing summary。
"""
from __future__ import annotations

import json
import sqlite3
import threading

import pytest

import auth_db
import billing
import config
import invites
import llm
from ai import ledger
from tests.migration_utils import (
    assert_alembic_ok,
    columns,
    index_names,
    revision,
    run_alembic,
    table_names,
)

PASSWORD = "billing-password-123"
USER_EMAIL = "billing-user@example.com"
ADMIN_EMAIL = "billing-admin@example.com"
OTHER_EMAIL = "billing-other@example.com"

BONUS = 2_000_000


# ---------------------------------------------------------------------------
# 夹具 / 工具
# ---------------------------------------------------------------------------

@pytest.fixture()
def billing_db(tmp_path, monkeypatch):
    """迁移到 head 的独立库；运行时指向它。"""
    db = tmp_path / "billing.db"
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(db), raising=False)
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    billing.reset_cache()
    yield db
    billing.reset_cache()


@pytest.fixture()
def client_upgraded(billing_db, make_client):
    """已登录用户（注册发生在迁移之后 → 走真实开户事务）。"""
    with make_client() as client:
        response = client.post(
            "/api/auth/signup",
            json={"email": USER_EMAIL, "password": PASSWORD, "username": "计费用户"},
        )
        assert response.status_code == 201, response.text
        client.user_id = response.json()["user"]["id"]
        yield client


@pytest.fixture()
def admin_client(client_upgraded, monkeypatch):
    monkeypatch.setattr(
        config, "ADMIN_EMAILS", frozenset({USER_EMAIL}), raising=False
    )
    return client_upgraded


def _signup(make_client, email: str, username: str | None = None):
    """注册并返回 (client, userId)；用于需要多个账号的用例。"""
    client = make_client().__enter__()
    payload = {"email": email, "password": PASSWORD}
    if username:
        payload["username"] = username
    response = client.post("/api/auth/signup", json=payload)
    assert response.status_code == 201, response.text
    client.user_id = response.json()["user"]["id"]
    return client


def _rows(db, sql: str, params: tuple = ()) -> list[tuple]:
    with sqlite3.connect(db) as conn:
        return conn.execute(sql, params).fetchall()


def _balance(db, user_id: str) -> int:
    rows = _rows(db, "SELECT balance_micro_usd FROM users WHERE id = ?", (user_id,))
    assert rows, "用户不存在"
    return int(rows[0][0])


def _ledger_rows(db, user_id: str) -> list[tuple]:
    return _rows(
        db,
        "SELECT kind, delta_micro_usd, balance_after_micro_usd, idempotency_key "
        "FROM account_ledger WHERE user_id = ? ORDER BY created_at_ms, id",
        (user_id,),
    )


def _table_signature(db, table: str):
    """列（名/类型/非空/默认/主键位）+ 索引（名/唯一/来源/列）。"""
    with sqlite3.connect(db) as conn:
        cols = [
            (row[1], row[2].upper(), row[3], row[4], row[5])
            for row in conn.execute(f"PRAGMA table_info({table})")
        ]
        indexes = []
        for _seq, name, unique, origin, _partial in conn.execute(
            f"PRAGMA index_list({table})"
        ):
            index_columns = [
                (row[0], row[1], row[2])
                for row in conn.execute(f"PRAGMA index_info({name})")
            ]
            indexes.append((name, unique, origin, index_columns))
    return cols, sorted(indexes)


# ---------------------------------------------------------------------------
# 1. 迁移 0025
# ---------------------------------------------------------------------------

def test_migration_creates_balance_schema_and_seeds_prices(billing_db):
    tables = table_names(billing_db)
    assert {"account_ledger", "credit_holds", "model_prices"} <= tables
    assert "balance_micro_usd" in columns(billing_db, "users")
    usage = columns(billing_db, "ai_usage")
    assert "cost_micro_usd" in usage
    assert "billing_status" in usage

    assert "ux_account_ledger_idempotency" in index_names(
        billing_db, "account_ledger"
    )
    assert "ux_model_prices_model_effective" in index_names(
        billing_db, "model_prices"
    )

    prices = _rows(
        billing_db,
        "SELECT model_id, provider, input_micro_usd_per_mtok, "
        "output_micro_usd_per_mtok, source_kind, price_version, source_ref "
        "FROM model_prices ORDER BY model_id",
    )
    by_model = {row[0]: row for row in prices}
    assert set(by_model) == {
        "deepseek-chat",
        "gemini-2.5-flash",
        # P1-20 / 0030：Qwen 写真实版本名 + 目录别名两套同价行（见迁移文档）。
        "qwen3.8-flash",
        "qwen-flash",
        "qwen3.7-plus",
        "qwen-plus",
    }
    deepseek = by_model["deepseek-chat"]
    assert deepseek[2] == 300_000 and deepseek[3] == 1_200_000
    assert deepseek[4] == "official_page"
    assert "deepseek.com" in deepseek[6]
    gemini = by_model["gemini-2.5-flash"]
    assert gemini[2] == 300_000 and gemini[3] == 2_500_000
    assert gemini[4] == "official_page"
    # 0030：北京/全球官方价（USD 原价）；版本名与目录别名同价同源。
    for model_id in ("qwen3.8-flash", "qwen-flash"):
        assert by_model[model_id][2] == 113_000 and by_model[model_id][3] == 382_000
        assert by_model[model_id][4] == "official_page"
        assert "alibabacloud.com" in by_model[model_id][6]
    for model_id in ("qwen3.7-plus", "qwen-plus"):
        assert by_model[model_id][2] == 276_000 and by_model[model_id][3] == 1_101_000
        assert by_model[model_id][4] == "official_page"
        assert "alibabacloud.com" in by_model[model_id][6]
    # 缺价模型不编数字：Gemini 3.x 没有行。
    assert not {"gemini-3.5-flash-lite", "gemini-3.1-pro-preview"} & set(by_model)

    # 价格解析：官方价 → billing.price_for_model
    price = billing.price_for_model("deepseek-chat")
    assert price["inputMicroUsdPerMtok"] == 300_000
    assert price["priceSource"] == "official"
    # P1-20：目录 id（账本/计费键）与真实版本名都能取到 Qwen 价。
    assert billing.price_for_model("qwen-flash")["inputMicroUsdPerMtok"] == 113_000
    assert billing.price_for_model("qwen3.8-flash")["outputMicroUsdPerMtok"] == 382_000
    assert billing.price_for_model("qwen-plus")["outputMicroUsdPerMtok"] == 1_101_000
    assert billing.price_for_model("qwen3.7-plus")["inputMicroUsdPerMtok"] == 276_000


def test_compat_schema_matches_migration(tmp_path, monkeypatch):
    """旧库兼容建表（开户用）与迁移 0025 的 schema 必须一致，防止两套真源漂移。"""
    migrated = tmp_path / "migrated.db"
    assert_alembic_ok(run_alembic(migrated, "upgrade", "head"))

    compat = tmp_path / "compat.db"
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(compat), raising=False)
    auth_db.init_db()
    billing.ensure_schema_compat()
    billing.reset_cache()

    for table in ("users", "account_ledger", "credit_holds", "model_prices"):
        assert _table_signature(compat, table) == _table_signature(
            migrated, table
        ), f"{table} 的兼容 DDL 与迁移 0025 不一致"


def test_migration_marks_historical_usage_legacy(tmp_path, monkeypatch):
    """0025 之前写入的 ai_usage 行标 legacy（不按估算成本补扣）。"""
    db = tmp_path / "legacy-usage.db"
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(db), raising=False)
    assert_alembic_ok(
        run_alembic(db, "upgrade", "0024_account_lifecycle"), "upgrade 0024"
    )
    billing.reset_cache()
    row = ledger.record_usage(
        "legacy-user", "translate", "gemini-2.5-flash", 1_000_000, 0
    )
    assert row is not None
    assert "cost_micro_usd" not in row  # 0024 还没有该列

    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    billing.reset_cache()
    rows = _rows(
        db,
        "SELECT billing_status, billable, price_source, cost_micro_usd "
        "FROM ai_usage WHERE user_id = 'legacy-user'",
    )
    assert rows == [("legacy", 0, "legacy", None)]


def test_migration_backfills_active_users_once(tmp_path, monkeypatch):
    """D-3：存量 active 用户补 $2.00；banned/pending 不补；手工重跑不重复。"""
    db = tmp_path / "backfill.db"
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(db), raising=False)
    assert_alembic_ok(
        run_alembic(db, "upgrade", "0024_account_lifecycle"), "upgrade 0024"
    )
    with sqlite3.connect(db) as conn:
        conn.executemany(
            "INSERT INTO users (id, email, password_hash, created_at, username, "
            "credits, status) VALUES (?, ?, 'x', 1, ?, 0, ?)",
            [
                ("u-active", "active@example.com", "active", "active"),
                ("u-banned", "banned@example.com", "banned", "banned"),
                (
                    "u-pending",
                    "pending@example.com",
                    "pending",
                    "deletion_pending",
                ),
            ],
        )
        conn.commit()

    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head")
    billing.reset_cache()
    assert _balance(db, "u-active") == BONUS
    assert _balance(db, "u-banned") == 0
    assert _balance(db, "u-pending") == 0
    assert _ledger_rows(db, "u-active") == [
        ("signup_bonus_backfill", BONUS, BONUS, "signup_bonus_backfill:u-active")
    ]

    # 手工重跑（把版本号改回 0024 再 upgrade）：升级路径幂等，不重复发钱。
    with sqlite3.connect(db) as conn:
        conn.execute(
            "UPDATE alembic_version SET version_num = '0024_account_lifecycle'"
        )
        conn.commit()
    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head (rerun)")
    billing.reset_cache()
    assert _balance(db, "u-active") == BONUS
    assert len(_ledger_rows(db, "u-active")) == 1


def test_migration_downgrade_keeps_users_and_usage(tmp_path, monkeypatch):
    """downgrade -1 只删余额列/新表，users 与 ai_usage 既有数据保留。"""
    db = tmp_path / "downgrade.db"
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(db), raising=False)
    assert_alembic_ok(run_alembic(db, "upgrade", "head"))
    with sqlite3.connect(db) as conn:
        conn.execute(
            "INSERT INTO users (id, email, password_hash, created_at, username, "
            "credits, status) VALUES ('keep', 'keep@example.com', 'x', 1, 'keep', 7, 'active')"
        )
        conn.execute(
            "INSERT INTO account_ledger (id, user_id, kind, delta_micro_usd, "
            "balance_after_micro_usd, created_at_ms) "
            "VALUES ('l1', 'keep', 'admin_topup', 5, 5, 1)"
        )
        conn.commit()

    assert_alembic_ok(
        run_alembic(db, "downgrade", "0024_account_lifecycle"), "downgrade 0024"
    )
    billing.reset_cache()
    assert revision(db) == "0024_account_lifecycle"
    assert "account_ledger" not in table_names(db)
    assert "balance_micro_usd" not in columns(db, "users")
    assert _rows(db, "SELECT email, credits FROM users WHERE id='keep'") == [
        ("keep@example.com", 7)
    ]

    assert_alembic_ok(run_alembic(db, "upgrade", "head"), "upgrade head again")
    assert revision(db) == "0030_qwen_prices"
    # 回滚后余额列重建为 0，再按 D-3 给 active 用户补发。
    assert _balance(db, "keep") == BONUS


# ---------------------------------------------------------------------------
# 2. 开户事务
# ---------------------------------------------------------------------------

def test_public_signup_grants_bonus_in_one_transaction(client_upgraded, billing_db):
    user_id = client_upgraded.user_id
    assert _balance(billing_db, user_id) == BONUS
    assert _ledger_rows(billing_db, user_id) == [
        ("signup_bonus", BONUS, BONUS, f"signup_bonus:{user_id}")
    ]
    # 旧 credits 冻结为 0；会话在同一事务里建好（Cookie 可用）。
    assert _rows(
        billing_db, "SELECT credits FROM users WHERE id = ?", (user_id,)
    ) == [(0,)]
    me = client_upgraded.get("/api/auth/me")
    assert me.status_code == 200
    # 契约不变：user 对象不新增余额字段（余额走 summary）。
    assert set(me.json()["user"]) == {
        "id", "email", "username", "credits", "status"
    }

    summary = client_upgraded.get("/api/user/summary").json()
    assert summary["balanceMicroUsd"] == BONUS
    assert summary["balanceUsd"] == "2.00"
    assert summary["availableMicroUsd"] == BONUS
    assert summary["creditsLegacy"] == 0
    assert summary["user"]["credits"] == 0


def test_signup_bonus_config_zero_skips_ledger(make_client, monkeypatch):
    """SIGNUP_BONUS_MICRO_USD=0：开户不发钱、也不写 0 金额流水。"""
    monkeypatch.setattr(config, "SIGNUP_BONUS_MICRO_USD", 0, raising=False)
    with make_client() as client:
        response = client.post(
            "/api/auth/signup",
            json={"email": "zero-bonus@example.com", "password": PASSWORD},
        )
        assert response.status_code == 201, response.text
        user_id = response.json()["user"]["id"]
    assert auth_db.get_user_by_id(user_id)["balance_micro_usd"] == 0
    assert _ledger_rows(config.AUTH_DB_PATH, user_id) == []


def test_signup_rolls_back_when_bonus_write_fails(make_client, monkeypatch):
    """开户流水写入失败 → 整笔回滚：没有用户、没有会话、没有半条流水。"""
    email = "rollback@example.com"

    def _boom(*args, **kwargs):
        raise sqlite3.OperationalError("disk I/O error (simulated)")

    monkeypatch.setattr(billing, "write_signup_bonus", _boom)
    with make_client() as client:
        response = client.post(
            "/api/auth/signup", json={"email": email, "password": PASSWORD}
        )
        # routes_auth 把 sqlite 写失败统一映射成 503（可重试），不是 201。
        assert response.status_code == 503, response.text
    assert auth_db.get_user_by_email(email) is None
    assert _rows(config.AUTH_DB_PATH, "SELECT COUNT(*) FROM sessions") == [(0,)]


def test_invite_signup_grants_bonus_and_keeps_invite_on_conflict(
    billing_db, make_client, monkeypatch
):
    monkeypatch.setattr(config, "REGISTRATION_OPEN", False, raising=False)
    codes = invites.create_invites("admin-user", count=1, max_uses=2)
    code = codes[0]["code"]

    with make_client() as client:
        first = client.post(
            "/api/auth/signup",
            json={
                "email": "invite-first@example.com",
                "password": PASSWORD,
                "inviteCode": code,
            },
        )
        assert first.status_code == 201, first.text
        user_id = first.json()["user"]["id"]

    assert _balance(billing_db, user_id) == BONUS
    assert _ledger_rows(billing_db, user_id) == [
        ("signup_bonus", BONUS, BONUS, f"signup_bonus:{user_id}")
    ]
    assert _rows(
        billing_db, "SELECT used_count FROM invite_codes", ()
    ) == [(1,)]

    # 同一邮箱重复注册：409，邀请码不被多消耗、不产生第二条流水。
    with make_client() as client:
        duplicate = client.post(
            "/api/auth/signup",
            json={
                "email": "invite-first@example.com",
                "password": PASSWORD,
                "inviteCode": code,
            },
        )
        assert duplicate.status_code == 409, duplicate.text

    assert _rows(billing_db, "SELECT used_count FROM invite_codes") == [(1,)]
    assert _rows(
        billing_db,
        "SELECT COUNT(*) FROM account_ledger WHERE kind = 'signup_bonus'",
    ) == [(1,)]


def test_signup_bonus_without_migration_uses_compat_schema(make_client):
    """未跑迁移的旧库/测试库也能整笔开户 + 严格计费可用（兼容路径）。

    M7a 起兼容建表同时补 ai_usage/ai_quota 与价格 seed：严格计费不能因为
    「没跑迁移」退化成免费调用。生产仍应先跑 `alembic upgrade head`。
    """
    with make_client() as client:
        response = client.post(
            "/api/auth/signup",
            json={"email": "compat-bonus@example.com", "password": PASSWORD},
        )
        assert response.status_code == 201, response.text
        user_id = response.json()["user"]["id"]
    db = config.AUTH_DB_PATH
    assert _balance(db, user_id) == BONUS
    assert _ledger_rows(db, user_id) == [
        ("signup_bonus", BONUS, BONUS, f"signup_bonus:{user_id}")
    ]
    # M7a：兼容建表后计费可用，且 deepseek-chat 有 seed 价（严格计费不会 503）。
    assert billing.schema_ready() is True
    assert billing.price_for_model("deepseek-chat") is not None


# ---------------------------------------------------------------------------
# 3. 管理员充 / 扣
# ---------------------------------------------------------------------------

def _adjust(client, user_id: str, **payload):
    return client.post(f"/api/admin/users/{user_id}/balance", json=payload)


def test_admin_topup_and_deduct(admin_client, billing_db):
    user_id = admin_client.user_id
    topup = _adjust(
        admin_client,
        user_id,
        amountUsd="2.50",
        reason="首次充值",
        idempotencyKey="topup-1",
    )
    assert topup.status_code == 200, topup.text
    body = topup.json()
    assert body["kind"] == "admin_topup"
    assert body["deltaMicroUsd"] == 2_500_000
    assert body["balanceMicroUsd"] == BONUS + 2_500_000
    assert body["balanceUsd"] == "4.50"
    assert body["replayed"] is False
    assert _balance(billing_db, user_id) == BONUS + 2_500_000

    # 幂等重放：返回原流水，不重复加钱。
    replay = _adjust(
        admin_client,
        user_id,
        amountUsd="2.50",
        reason="首次充值",
        idempotencyKey="topup-1",
    )
    assert replay.status_code == 200
    assert replay.json()["replayed"] is True
    assert replay.json()["ledgerId"] == body["ledgerId"]
    assert _balance(billing_db, user_id) == BONUS + 2_500_000

    deduct = _adjust(
        admin_client,
        user_id,
        amountUsd="1.00",
        direction="debit",
        reason="扣减测试",
        idempotencyKey="deduct-1",
    )
    assert deduct.status_code == 200, deduct.text
    assert deduct.json()["kind"] == "admin_deduct"
    assert deduct.json()["deltaMicroUsd"] == -1_000_000
    assert _balance(billing_db, user_id) == BONUS + 1_500_000

    # 整数 µUSD 入口。
    micro = _adjust(
        admin_client,
        user_id,
        amountMicroUsd=250_000,
        reason="整数微美元",
    )
    assert micro.status_code == 200
    assert micro.json()["balanceMicroUsd"] == BONUS + 1_750_000

    # 流水审计：金额链一致 + 管理审计一行。
    kinds = [row[0] for row in _ledger_rows(billing_db, user_id)]
    assert kinds.count("signup_bonus") == 1
    assert kinds.count("admin_topup") == 2
    assert kinds.count("admin_deduct") == 1
    assert _rows(
        billing_db,
        "SELECT COUNT(*) FROM admin_audit_log "
        "WHERE action = 'admin.user.balance_adjust' AND target_id = ?",
        (user_id,),
    )[0][0] >= 1


def test_admin_balance_validation_and_permissions(
    admin_client, billing_db, make_client
):
    user_id = admin_client.user_id
    bad_requests = [
        ({"amountUsd": "0", "reason": "x"}, 400),
        ({"amountUsd": "-1.00", "reason": "x"}, 400),
        ({"amountUsd": "1.0000001", "reason": "x"}, 400),
        ({"amountUsd": 2.5, "reason": "x"}, 400),
        ({"amountUsd": "101.00", "reason": "x"}, 400),
        ({"amountUsd": "1.00"}, 400),
        ({"amountUsd": "1.00", "reason": "x", "direction": "sideways"}, 400),
        ({"reason": "x"}, 400),
        ({"amountMicroUsd": "100", "reason": "x"}, 400),
        ({"amountMicroUsd": 0, "reason": "x"}, 400),
        ({"amountMicroUsd": 100_000_001, "reason": "x"}, 400),
    ]
    for payload, expected in bad_requests:
        response = _adjust(admin_client, user_id, **payload)
        assert response.status_code == expected, (payload, response.text)
    assert _balance(billing_db, user_id) == BONUS

    # 扣成负数：400，余额不变。
    with sqlite3.connect(billing_db) as conn:
        conn.execute("UPDATE users SET balance_micro_usd = 1000 WHERE id = ?", (user_id,))
        conn.commit()
    negative = _adjust(
        admin_client,
        user_id,
        amountUsd="0.01",
        direction="debit",
        reason="扣成负数",
    )
    assert negative.status_code == 400
    assert _balance(billing_db, user_id) == 1000

    # 幂等键冲突（同键不同金额）：409。
    first = _adjust(
        admin_client, user_id, amountUsd="1.00", reason="x", idempotencyKey="dup"
    )
    assert first.status_code == 200
    conflict = _adjust(
        admin_client, user_id, amountUsd="2.00", reason="x", idempotencyKey="dup"
    )
    assert conflict.status_code == 409

    # 不存在用户 404。
    assert _adjust(
        admin_client, "no-such-user", amountUsd="1.00", reason="x"
    ).status_code == 404

    # 非管理员 403 / 未登录 401。
    other = _signup(make_client, OTHER_EMAIL)
    try:
        forbidden = _adjust(
            other, admin_client.user_id, amountUsd="1.00", reason="x"
        )
        assert forbidden.status_code == 403
    finally:
        other.__exit__(None, None, None)
    with make_client() as anonymous:
        assert _adjust(
            anonymous, admin_client.user_id, amountUsd="1.00", reason="x"
        ).status_code == 401


def test_admin_ledger_and_billing_summary(admin_client, billing_db):
    user_id = admin_client.user_id
    _adjust(admin_client, user_id, amountUsd="1.23", reason="充值", idempotencyKey="k")

    ledger_response = admin_client.get(
        f"/api/admin/users/{user_id}/ledger?limit=10&offset=0"
    )
    assert ledger_response.status_code == 200, ledger_response.text
    ledger_body = ledger_response.json()
    assert ledger_body["user"]["id"] == user_id
    assert ledger_body["balanceMicroUsd"] == BONUS + 1_230_000
    assert ledger_body["balanceUsd"] == "3.23"
    assert ledger_body["total"] == 2
    assert [entry["kind"] for entry in ledger_body["entries"]] == [
        "admin_topup",
        "signup_bonus",
    ]
    assert ledger_body["entries"][0]["deltaUsd"] == "1.23"

    summary = admin_client.get("/api/admin/billing/summary")
    assert summary.status_code == 200, summary.text
    body = summary.json()
    assert body["totals"]["billedCostMicroUsd"] == 0
    assert body["totals"]["unbilledRows"] == 0
    assert "currentUnpricedModels" in body
    assert body["unpricedModels"] == []
    assert body["balances"]["totalMicroUsd"] == BONUS + 1_230_000
    assert body["balances"]["ledgerDeltaMicroUsd"] == BONUS + 1_230_000
    assert {price["modelId"] for price in body["prices"]} >= {"deepseek-chat"}

    assert (
        admin_client.get("/api/admin/billing/summary?from=2026-11-20&to=2026-11-21")
        .status_code
        == 200
    )
    assert (
        admin_client.get("/api/admin/billing/summary?from=bad-date").status_code == 400
    )


# ---------------------------------------------------------------------------
# 4. 余额服务：预占 / 结算 / 释放 / 过期
# ---------------------------------------------------------------------------

def _user_id(billing_db, email: str) -> str:
    rows = _rows(billing_db, "SELECT id FROM users WHERE email = ?", (email,))
    assert rows
    return rows[0][0]


def test_reserve_available_and_concurrency(client_upgraded, billing_db):
    user_id = client_upgraded.user_id
    first = billing.reserve(user_id, 1_500_000, feature="translate")
    assert billing.get_balance(user_id)["availableMicroUsd"] == 500_000
    with pytest.raises(billing.InsufficientBalance):
        billing.reserve(user_id, 1_000_000, feature="translate")
    billing.release(first["id"])
    assert billing.get_balance(user_id)["availableMicroUsd"] == BONUS

    # 并发：两个 1.5M 预占只能成功一个（BEGIN IMMEDIATE 串行化）。
    results: list = []
    barrier = threading.Barrier(2)

    def _attempt():
        barrier.wait()
        try:
            hold = billing.reserve(user_id, 1_500_000, feature="translate")
            results.append(("ok", hold["id"]))
        except billing.InsufficientBalance:
            results.append(("insufficient", None))

    threads = [threading.Thread(target=_attempt) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(status for status, _ in results) == ["insufficient", "ok"]
    held = billing.get_balance(user_id)["activeHoldsMicroUsd"]
    assert held == 1_500_000
    assert billing.get_balance(user_id)["availableMicroUsd"] == 500_000


def test_settle_writes_usage_and_ledger(client_upgraded, billing_db):
    user_id = client_upgraded.user_id
    price = billing.price_for_model("deepseek-chat")
    hold = billing.reserve(user_id, 2_000, feature="define")
    result = billing.settle(
        hold["id"],
        900,
        usage={
            "feature": "define",
            "model_id": "deepseek-chat",
            "provider": "DeepSeek",
            "input_tokens": 1000,
            "output_tokens": 500,
            "token_source": "provider",
            "target_lang": "zh-CN",
        },
    )
    assert result["status"] == "settled"
    assert result["costMicroUsd"] == 900
    assert _balance(billing_db, user_id) == BONUS - 900
    rows = _rows(
        billing_db,
        "SELECT cost_micro_usd, billable, billing_status, price_version, "
        "price_source, token_source, hold_id, request_id, "
        "input_price_micro_usd_per_mtok, output_price_micro_usd_per_mtok, "
        "est_cost_usd FROM ai_usage WHERE user_id = ?",
        (user_id,),
    )
    assert len(rows) == 1
    row = rows[0]
    assert row[0] == 900 and row[1] == 1 and row[2] == "settled"
    assert row[3] == price["priceVersion"]
    assert row[4] == "official"
    assert row[5] == "provider"
    assert row[6] == hold["id"]
    assert row[7] is None  # 非 HTTP 上下文没有 request_id
    assert row[8] == 300_000 and row[9] == 1_200_000
    assert row[10] == pytest.approx(0.0009)
    assert _ledger_rows(billing_db, user_id)[-1][0] == "ai_settle"
    assert _ledger_rows(billing_db, user_id)[-1][1] == -900

    # 重复结算：幂等返回，不再扣钱、不再写流水。
    again = billing.settle(
        hold["id"],
        900,
        usage={"feature": "define", "model_id": "deepseek-chat"},
    )
    assert again["alreadySettled"] is True
    assert _balance(billing_db, user_id) == BONUS - 900
    assert len(_ledger_rows(billing_db, user_id)) == 2


def test_settle_overrun_and_released_hold(client_upgraded, billing_db):
    user_id = client_upgraded.user_id
    hold = billing.reserve(user_id, 100, feature="translate", ttl_seconds=1)
    result = billing.settle(
        hold["id"],
        300,
        usage={"feature": "translate", "model_id": "deepseek-chat"},
    )
    assert result["overrun"] is True
    assert result["reservedMicroUsd"] == 100
    assert _balance(billing_db, user_id) == BONUS - 300

    released = billing.reserve(user_id, 500, feature="translate")
    billing.release(released["id"])
    with pytest.raises(billing.HoldNotActive):
        billing.settle(
            released["id"],
            100,
            usage={"feature": "translate", "model_id": "deepseek-chat"},
        )


def test_expired_hold_is_released_for_availability(client_upgraded, billing_db):
    user_id = client_upgraded.user_id
    now = billing.now_ms()
    hold = billing.reserve(
        user_id, 1_000_000, feature="translate", now_ms_value=now, ttl_seconds=30
    )
    assert billing.get_balance(user_id)["activeHoldsMicroUsd"] == 1_000_000
    assert (
        billing.expire_stale_holds(now_ms_value=now + 31_000) == 1
    )
    assert billing.get_balance(user_id)["activeHoldsMicroUsd"] == 0
    rows = _rows(
        billing_db, "SELECT status FROM credit_holds WHERE id = ?", (hold["id"],)
    )
    assert rows == [("expired",)]
    with pytest.raises(billing.HoldNotActive):
        billing.settle(
            hold["id"],
            100,
            usage={"feature": "translate", "model_id": "deepseek-chat"},
        )


# ---------------------------------------------------------------------------
# 5. AI 集成（mock provider）
# ---------------------------------------------------------------------------

def _fake_provider(usage: dict, text: str = '{"ok": true}'):
    def _generate(prompt, spec, json_mode):
        return text, usage
    return _generate


def test_llm_generate_reserves_and_settles(client_upgraded, billing_db, monkeypatch):
    user_id = client_upgraded.user_id
    monkeypatch.setattr(
        llm,
        "_generate_openai_compatible",
        _fake_provider({"input_tokens": 1000, "output_tokens": 500}),
    )
    with llm.usage_scope("define", user_id, target_lang="zh-CN"):
        text = llm.generate("hello " * 20, model="deepseek-chat")
    assert text == '{"ok": true}'
    assert _balance(billing_db, user_id) == BONUS - 900
    usage_row = _rows(
        billing_db,
        "SELECT cost_micro_usd, billing_status, billable, input_tokens, "
        "output_tokens, token_source FROM ai_usage WHERE user_id = ?",
        (user_id,),
    )[0]
    assert usage_row == (900, "settled", 1, 1000, 500, "provider")
    hold = _rows(
        billing_db, "SELECT status, settled_at_ms FROM credit_holds WHERE user_id = ?",
        (user_id,),
    )[0]
    assert hold[0] == "settled" and hold[1] is not None


def test_llm_generate_unpriced_model_is_rejected_and_not_called(
    client_upgraded, billing_db, monkeypatch
):
    """M7a：没有可核实单价的模型必须 503 model_unpriced，且**不调用 provider**。

    P1-20 起 Qwen Flash/Plus 有官方价，缺价样本改用仍未定价的 Gemini 3.1 Pro
    （预览模型无官方美元价，目录 in/out 亦为 None）。
    """
    user_id = client_upgraded.user_id
    calls: list[str] = []

    def _fake(prompt, spec, json_mode):
        calls.append(spec.get("model_id", "?"))
        return '{"ok": true}', {"input_tokens": 1000, "output_tokens": 500}

    monkeypatch.setattr(llm, "_generate_google", _fake)
    with llm.usage_scope("define", user_id, target_lang="zh-CN"):
        with pytest.raises(billing.ModelUnpriced) as excinfo:
            llm.generate("hello", model="gemini-3.1-pro-preview")
    assert excinfo.value.code == "model_unpriced"
    assert excinfo.value.status_code == 503
    assert calls == [], "缺价模型不得真正调用厂商"
    assert _balance(billing_db, user_id) == BONUS
    assert _rows(billing_db, "SELECT COUNT(*) FROM credit_holds") == [(0,)]
    assert _rows(billing_db, "SELECT COUNT(*) FROM ai_usage") == [(0,)]


def test_llm_generate_priced_qwen_uses_version_name_and_alias_price(
    client_upgraded, billing_db, monkeypatch
):
    """P1-20：Qwen 有价后不再 503；provider 收真实版本名，账本/计价用目录 id。"""
    user_id = client_upgraded.user_id
    calls: list[str] = []

    def _fake(prompt, spec, json_mode):
        calls.append(spec.get("model_id", "?"))
        return '{"ok": true}', {"input_tokens": 1000, "output_tokens": 500}

    monkeypatch.setattr(llm, "_generate_openai_compatible", _fake)
    with llm.usage_scope("define", user_id, target_lang="zh-CN"):
        llm.generate("hello", model="qwen-flash")

    # 调用名是目录别名，发给厂商的是固定版本名。
    assert calls == ["qwen3.8-flash"]
    rows = _rows(
        billing_db,
        "SELECT model_id, cost_micro_usd, billable, billing_status, "
        "input_price_micro_usd_per_mtok, output_price_micro_usd_per_mtok "
        "FROM ai_usage WHERE user_id = ?",
        (user_id,),
    )
    assert len(rows) == 1
    row = rows[0]
    assert row[0] == "qwen-flash", "账本按目录 id 记账"
    assert row[2] == 1 and row[3] == "settled"
    assert (row[4], row[5]) == (113_000, 382_000)
    # 113 + 191 = 304 µUSD（北京价，分量分别向上取整）。
    assert row[1] == 304
    assert _balance(billing_db, user_id) == BONUS - 304


def test_llm_generate_provider_failure_releases_hold(
    client_upgraded, billing_db, monkeypatch
):
    user_id = client_upgraded.user_id

    def _boom(prompt, spec, json_mode):
        raise RuntimeError("provider 500")

    monkeypatch.setattr(llm, "_generate_openai_compatible", _boom)
    with llm.usage_scope("define", user_id):
        with pytest.raises(RuntimeError):
            llm.generate("hello", model="deepseek-chat")
    assert _balance(billing_db, user_id) == BONUS
    assert _rows(
        billing_db, "SELECT status FROM credit_holds WHERE user_id = ?", (user_id,)
    ) == [("released",)]
    assert _rows(billing_db, "SELECT COUNT(*) FROM ai_usage") == [(0,)]


def test_llm_settle_failure_keeps_hold(client_upgraded, billing_db, monkeypatch):
    """结算写库失败：hold 保留 active、用量标 settle_failed、余额未扣但可重试。"""
    user_id = client_upgraded.user_id
    monkeypatch.setattr(
        llm,
        "_generate_openai_compatible",
        _fake_provider({"input_tokens": 1000, "output_tokens": 500}),
    )

    def _boom(*args, **kwargs):
        raise sqlite3.OperationalError("simulated settle failure")

    monkeypatch.setattr(billing, "settle", _boom)
    with llm.usage_scope("define", user_id):
        text = llm.generate("hello", model="deepseek-chat")
    assert text == '{"ok": true}'
    assert _balance(billing_db, user_id) == BONUS
    assert _rows(
        billing_db, "SELECT status FROM credit_holds WHERE user_id = ?", (user_id,)
    ) == [("active",)]
    assert _rows(
        billing_db,
        "SELECT billing_status, billable, cost_micro_usd, hold_id FROM ai_usage",
    )[0][:3] == ("settle_failed", 1, 900)


def test_llm_generate_without_login_user_is_rejected(billing_db, monkeypatch):
    """M7a：游客/匿名（user_id 为空或 guest: 前缀）不得调用 AI → 403 login_required。"""
    calls: list[str] = []

    def _fake(prompt, spec, json_mode):
        calls.append(spec.get("model_id", "?"))
        return '{"ok": true}', {"input_tokens": 1000, "output_tokens": 500}

    monkeypatch.setattr(llm, "_generate_openai_compatible", _fake)
    for identity in (None, "guest:" + "a" * 64):
        with llm.usage_scope("define", identity):
            with pytest.raises(billing.LoginRequired) as excinfo:
                llm.generate("hello", model="deepseek-chat")
        assert excinfo.value.code == "login_required"
        assert excinfo.value.status_code == 403
    assert calls == []
    assert _rows(billing_db, "SELECT COUNT(*) FROM ai_usage") == [(0,)]
    assert _rows(billing_db, "SELECT COUNT(*) FROM credit_holds") == [(0,)]


def test_llm_non_strict_rollback_still_unbilled(billing_db, monkeypatch):
    """``BILLING_STRICT=0`` 只是回滚逃生门：旧行为 billable=0 仍可复现。"""
    monkeypatch.setattr(config, "BILLING_STRICT", False, raising=False)
    monkeypatch.setattr(
        llm,
        "_generate_openai_compatible",
        _fake_provider({"input_tokens": 1000, "output_tokens": 500}),
    )
    with llm.usage_scope("define", "guest:" + "a" * 64):
        llm.generate("hello", model="deepseek-chat")
    rows = _rows(
        billing_db,
        "SELECT billable, billing_status, price_source, cost_micro_usd FROM ai_usage",
    )
    assert rows == [(0, "unbilled", "no_account", None)]


def test_price_versioning_new_row_wins(client_upgraded, billing_db):
    user_id = client_upgraded.user_id
    old = billing.price_for_model("deepseek-chat")
    with sqlite3.connect(billing_db) as conn:
        conn.execute(
            "INSERT INTO model_prices (id, model_id, provider, effective_from_ms, "
            "input_micro_usd_per_mtok, output_micro_usd_per_mtok, source_kind, "
            "source_ref, verified_at_ms, price_version, note) "
            "VALUES ('mp-new', 'deepseek-chat', 'DeepSeek', ?, 100000, 200000, "
            "'official_page', 'https://example.com', ?, '2026-11-21.official.1', "
            "'测试新价')",
            (billing.now_ms() - 1, billing.now_ms()),
        )
        conn.commit()
    new = billing.price_for_model("deepseek-chat")
    assert new["inputMicroUsdPerMtok"] == 100_000
    assert new["priceVersion"] == "2026-11-21.official.1"
    # 历史版本保留（不覆盖）。
    assert _rows(
        billing_db,
        "SELECT COUNT(*) FROM model_prices WHERE model_id = 'deepseek-chat'",
    ) == [(2,)]
    # 结算用当前生效价：1000 in + 500 out = 100 + 100 = 200 µUSD。
    hold = billing.reserve(user_id, 2_000, feature="define")
    result = billing.settle(
        hold["id"],
        billing.token_cost_micro_usd(1000, 500, new),
        usage={"feature": "define", "model_id": "deepseek-chat"},
    )
    assert result["costMicroUsd"] == 200
    assert _rows(
        billing_db,
        "SELECT price_version FROM ai_usage WHERE user_id = ?",
        (user_id,),
    ) == [("2026-11-21.official.1",)]
    assert old["priceVersion"] == "2026-11-20.official.1"


# ---------------------------------------------------------------------------
# 6. 402 / 429
# ---------------------------------------------------------------------------

def test_http_402_when_balance_exhausted(client_upgraded, billing_db):
    user_id = client_upgraded.user_id
    with sqlite3.connect(billing_db) as conn:
        conn.execute("UPDATE users SET balance_micro_usd = 0 WHERE id = ?", (user_id,))
        conn.commit()

    response = client_upgraded.post("/api/define", json={"word": "billing402"})
    assert response.status_code == 402, response.text
    body = response.json()
    assert body["code"] == "insufficient_balance"
    assert body["balanceMicroUsd"] == 0
    assert body["requiredMicroUsd"] > 0
    assert body["topup"] == "admin"
    # 402 发生在扣日配额之前：没有消耗 define 额度。
    assert _rows(
        billing_db,
        "SELECT COUNT(*) FROM ai_quota WHERE user_id = ? AND feature = 'define'",
        (user_id,),
    ) == [(0,)]


def test_http_429_daily_budget_still_wins_when_balance_is_enough(
    client_upgraded, billing_db, monkeypatch
):
    user_id = client_upgraded.user_id
    monkeypatch.setattr(config, "AI_DAILY_BUDGET_USER_USD", 0.000001, raising=False)
    ledger.record_usage(
        user_id, "translate", "deepseek-chat", 1, 1
    )
    response = client_upgraded.post("/api/define", json={"word": "billing429"})
    assert response.status_code == 429, response.text

    # 余额为 0 且预算超限：优先 402（用户可行动），不是 429。
    with sqlite3.connect(billing_db) as conn:
        conn.execute("UPDATE users SET balance_micro_usd = 0 WHERE id = ?", (user_id,))
        conn.commit()
    preferred = client_upgraded.post("/api/define", json={"word": "billing429b"})
    assert preferred.status_code == 402, preferred.text


def test_insufficient_balance_payload_serialization():
    exc = billing.InsufficientBalance(
        balance_micro_usd=1_000_000,
        available_micro_usd=1_000_000,
        required_micro_usd=3_720,
        feature="translate",
    )
    payload = exc.payload()
    assert payload["code"] == "insufficient_balance"
    assert payload["balanceMicroUsd"] == 1_000_000
    assert payload["requiredMicroUsd"] == 3_720
    assert "3,720" not in payload["detail"]
    assert billing.format_usd(3_720) == "0.00372"
    assert billing.format_usd(1_000_000) == "1.00"
    assert billing.format_usd(-500_000) == "-0.50"


def test_parse_usd_amount_precision():
    assert billing.parse_usd_amount("2.00") == 2_000_000
    assert billing.parse_usd_amount("0.000001") == 1
    assert billing.parse_usd_amount("100") == 100_000_000
    for bad in ("1.0000001", "-1", "abc", "", "1e3", None, 2.0):
        with pytest.raises(billing.InvalidBillingRequest):
            billing.parse_usd_amount(bad)


# ---------------------------------------------------------------------------
# 7. 汇总与维护
# ---------------------------------------------------------------------------

def test_billing_summary_counts_unbilled_rows(client_upgraded, billing_db, monkeypatch):
    user_id = client_upgraded.user_id
    monkeypatch.setattr(
        llm,
        "_generate_openai_compatible",
        _fake_provider({"input_tokens": 1000, "output_tokens": 500}),
    )
    with llm.usage_scope("define", user_id):
        llm.generate("priced", model="deepseek-chat")
    # M7a：缺价模型不再能产生调用；这里直接构造一条历史/遗留的未计费行，
    # 验证汇总仍把「未计费」单独统计（对账口径不能丢）。
    ledger.record_usage(
        user_id,
        "define",
        "qwen-flash",
        10,
        5,
        price_source="ceiling_unknown",
        token_source="estimated",
        billable=0,
        billing_status="unbilled",
    )

    body = billing.billing_summary()
    assert body["totals"]["billedCostMicroUsd"] == 900
    assert body["totals"]["unbilledRows"] == 1
    # 兼容字段不变：历史未计费按 unpriced_rows 统计（不重算、不补扣）。
    assert body["unpricedModels"] == ["qwen-flash"]
    # P1-21：Qwen 已补价 → 不属于「当前缺价」；旧行仍在历史列表里。
    assert "qwen-flash" not in body["currentUnpricedModels"]
    assert body["byModel"][0]["calls"] == 1
    assert body["holds"]["activeCount"] == 0
    assert body["balances"]["ledgerDeltaMicroUsd"] == BONUS - 900


def _seed_prices_for_missing_catalog_models(db) -> list[str]:
    """给目录里所有仍缺价的模型插一条测试价，用于验证「当前缺价为空」态。"""
    missing = sorted(
        model_key
        for model_key in config.MODEL_CATALOG
        if billing.price_for_model(model_key) is None
    )
    assert missing, "前置：迁移 0025/0030 之后目录里应仍有缺价模型"
    effective = billing.now_ms() - 1
    with sqlite3.connect(db) as conn:
        for index, model_key in enumerate(missing):
            conn.execute(
                "INSERT INTO model_prices (id, model_id, provider, effective_from_ms, "
                "input_micro_usd_per_mtok, output_micro_usd_per_mtok, source_kind, "
                "source_ref, verified_at_ms, price_version, note) "
                "VALUES (?, ?, ?, ?, 100000, 200000, 'official_page', "
                "'https://example.com/prices', ?, '2026-11-23.test.1', '测试补价')",
                (
                    f"mp-current-unpriced-{index}",
                    model_key,
                    config.MODEL_CATALOG[model_key]["provider"],
                    effective,
                    effective,
                ),
            )
        conn.commit()
    return missing


def test_billing_summary_separates_historical_and_current_unpriced(
    client_upgraded, billing_db
):
    """P1-21：补价模型仍出现在历史列表，但不属于当前缺价；补全后 current 为空。"""
    user_id = client_upgraded.user_id
    # 历史：Qwen 补价前产生的未计费行（billable=0，不扣、不补扣）。
    ledger.record_usage(
        user_id,
        "define",
        "qwen-flash",
        10,
        5,
        price_source="ceiling_unknown",
        token_source="estimated",
        billable=0,
        billing_status="unbilled",
    )

    body = billing.billing_summary()
    assert body["unpricedModels"] == ["qwen-flash"]
    assert "qwen-flash" not in body["currentUnpricedModels"]

    # 当前缺价 = 目录里 price_for_model() 仍为 None 的 key（与历史 usage 无关）。
    expected_current = sorted(
        model_key
        for model_key in config.MODEL_CATALOG
        if billing.price_for_model(model_key) is None
    )
    assert body["currentUnpricedModels"] == expected_current
    for priced_model in (
        "deepseek-chat",
        "gemini-2.5-flash",
        "qwen-flash",
        "qwen-plus",
    ):
        assert priced_model not in body["currentUnpricedModels"]

    # 补价后：current 清空，但历史列表与未计费行数不变（不重算历史 usage）。
    seeded = _seed_prices_for_missing_catalog_models(billing_db)
    assert seeded == expected_current
    body = billing.billing_summary()
    assert body["currentUnpricedModels"] == []
    assert body["unpricedModels"] == ["qwen-flash"]
    assert body["totals"]["unbilledRows"] == 1

