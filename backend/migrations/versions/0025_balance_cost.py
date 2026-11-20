"""balance_cost：余额 / 流水 / 预占 / 价格表 / AI 计费字段（M3a）

Revision ID: 0025_balance_cost
Revises: 0024_account_lifecycle
Create Date: 2026-11-20

设计来源：``docs/项目提案-上线功能.md`` §5 与 ``specs/034-balance-billing``。

金额单位统一为**整数微美元（µUSD，1 USD = 1,000,000 µUSD）**。此迁移做六件事：

1. ``users.balance_micro_usd INTEGER NOT NULL DEFAULT 0``：新余额列。旧
   ``users.credits`` **原样保留、冻结**（不再写、不再作为扣费依据），不做 1:1
   兑换——那会把旧演示额度凭空变成美元。
2. ``account_ledger``：append-only 资金流水。每一次余额变动都必须有一行，
   ``SUM(delta_micro_usd)`` 应等于 ``users.balance_micro_usd``（对账口径）。
   ``idempotency_key`` 唯一，重复请求/迁移重跑不会重复加钱。
3. ``credit_holds``：调用前预占、调用后结算/释放/过期。``available`` =
   账面余额 − ``active`` holds 之和，并发调用不会「同时看到 $2 都放行」。
4. ``model_prices``：可核实单价表；每个模型按 ``effective_from_ms`` 取最新一条，
   历史版本不覆盖。来源必须记 ``source_kind`` / ``source_ref`` / ``verified_at_ms``。
5. ``ai_usage`` 新列：``cost_micro_usd`` 等计费快照；历史行标记 ``legacy``，
   **不按历史 ``est_cost_usd`` 补扣**（那只是估算，不是账单）。
6. 为所有 ``status='active'`` 且还没有开户奖励流水的用户补发 $2.00（D-3），
   写 ``kind='signup_bonus_backfill'``；用唯一 ``idempotency_key`` 防止迁移重跑
   或手工重跑重复发放。已封禁/待删除账号不补（对齐 D-3）。

**价格 seed（可核实来源，核对日 2026-11-20）**：

- ``deepseek-chat``：DeepSeek 官方价格页
  https://api-docs.deepseek.com/quick_start/pricing 显示 DeepSeek-V4.1-Flash-1017
  （模型名 ``deepseek-flash``）峰值 / 未命中缓存 $0.30 输入、$1.20 输出（每 1M
  tokens，USD 不含税）。目录 id 是 ``deepseek-chat``（官方页未单列该别名，按同
  版本 Flash 计价，待人工复核）；缓存命中与错峰价更低，本表按**上界**记录。
- ``gemini-2.5-flash``：Google 官方 Gemini API 价格页
  https://ai.google.dev/gemini-api/docs/pricing 标准文本价 $0.30 输入 / $2.50
  输出（每 1M tokens，USD 不含税）。抓取时官方页重定向受限，经检索到的官方
  引用值交叉确认，与目录现值一致，待人工复核。
- 其余模型（``qwen-flash`` / ``qwen-plus`` / Gemini 3.x）**留空**：阿里云百炼
  国内站为人民币报价、国际站美元价随地域不同，不做汇率换算；Gemini 3.x 无法
  确认官方单价。缺价模型 ``billable=0``，不扣用户余额。

``upgrade`` / ``downgrade`` 都先查 inspector 再操作：兼容「运行时兼容建表已先
创建部分对象」的旧库/测试库，可重复执行。``downgrade`` 只删本迁移新增的列与
表，不触碰旧表数据（``users`` 行、``ai_usage`` 行都保留）。
"""
from __future__ import annotations

import time

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0025_balance_cost"
down_revision: str = "0024_account_lifecycle"
branch_labels: str | None = None
depends_on: str | None = None

# D-3 已批准：每位 active 存量用户一次性补发 $2.00。迁移里写死，不读 config
# （迁移是历史快照，日后改默认赠送额不应改变本次补发口径）。
BACKFILL_BONUS_MICRO_USD = 2_000_000
BALANCE_COLUMN = "balance_micro_usd"

LEDGER = "account_ledger"
HOLDS = "credit_holds"
PRICES = "model_prices"

UX_LEDGER_IDEMPOTENCY = "ux_account_ledger_idempotency"
IX_LEDGER_USER_CREATED = "ix_account_ledger_user_created"
IX_LEDGER_KIND_CREATED = "ix_account_ledger_kind_created"
IX_LEDGER_REF = "ix_account_ledger_ref"

IX_HOLDS_USER_STATUS = "ix_credit_holds_user_status"
IX_HOLDS_STATUS_EXPIRES = "ix_credit_holds_status_expires"

UX_PRICES_MODEL_EFFECTIVE = "ux_model_prices_model_effective"
IX_PRICES_PROVIDER = "ix_model_prices_provider"

LEDGER_KINDS = (
    "signup_bonus",
    "signup_bonus_backfill",
    "admin_topup",
    "admin_deduct",
    "ai_settle",
    "ai_refund",
    "adjustment",
    "legacy_snapshot",
)
LEDGER_KINDS_SQL = ",".join(f"'{kind}'" for kind in LEDGER_KINDS)

AI_USAGE_COLUMNS = (
    ("cost_micro_usd", sa.Integer()),
    ("input_price_micro_usd_per_mtok", sa.Integer()),
    ("output_price_micro_usd_per_mtok", sa.Integer()),
    ("price_version", sa.Text()),
    ("price_source", sa.Text()),
    ("token_source", sa.Text()),
    ("billable", sa.Integer()),
    ("billing_status", sa.Text()),
    ("hold_id", sa.Text()),
    ("request_id", sa.Text()),
)

# 2026-11-20 00:00:00 UTC：本轮核对价格的生效时间（毫秒）。
PRICE_EFFECTIVE_FROM_MS = 1_795_132_800_000
PRICE_VERSION = "2026-11-20.official.1"

PRICE_SEEDS = (
    {
        "id": "mp-20261120-deepseek-chat",
        "model_id": "deepseek-chat",
        "provider": "DeepSeek",
        "in": 300_000,  # $0.30 / 1M tokens
        "out": 1_200_000,  # $1.20 / 1M tokens
        "source_ref": "https://api-docs.deepseek.com/quick_start/pricing",
        "note": (
            "USD 不含税。官方页 2026-11-20 对 DeepSeek-V4.1-Flash-1017（模型名 "
            "deepseek-flash）的峰值/未命中缓存价 $0.30/$1.20；目录 id deepseek-chat "
            "未单列，按同版本 Flash 计价，待人工复核；缓存命中/错峰更低，本表取上界。"
        ),
    },
    {
        "id": "mp-20261120-gemini-25-flash",
        "model_id": "gemini-2.5-flash",
        "provider": "Google",
        "in": 300_000,  # $0.30 / 1M tokens
        "out": 2_500_000,  # $2.50 / 1M tokens
        "source_ref": "https://ai.google.dev/gemini-api/docs/pricing",
        "note": (
            "USD 不含税，标准文本价（非批量/缓存/音频）。官方页抓取受重定向限制，"
            "经检索到的官方引用值交叉确认 $0.30/$2.50，待人工复核。"
        ),
    },
)


def _inspector():
    return sa.inspect(op.get_bind())


def _table_names() -> set[str]:
    return set(_inspector().get_table_names())


def _column_names(table: str) -> set[str]:
    inspector = _inspector()
    if table not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns(table)}


def _index_names(table: str) -> set[str]:
    inspector = _inspector()
    if table not in inspector.get_table_names():
        return set()
    return {index["name"] for index in inspector.get_indexes(table)}


# ---------------------------------------------------------------------------
# 建表（与 billing.ensure_schema_compat 的兼容 DDL 保持一致；
# tests/test_balance_billing.py 有一条断言比较两者 schema 签名）
# ---------------------------------------------------------------------------

def _create_ledger() -> None:
    if LEDGER in _table_names():
        return
    op.create_table(
        LEDGER,
        sa.Column("id", sa.Text(), primary_key=True, nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column(
            "kind",
            sa.Text(),
            nullable=False,
        ),
        sa.Column("delta_micro_usd", sa.Integer(), nullable=False),
        sa.Column("balance_after_micro_usd", sa.Integer(), nullable=False),
        sa.Column("ref_type", sa.Text(), nullable=True),
        sa.Column("ref_id", sa.Text(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("actor_id", sa.Text(), nullable=True),
        sa.Column("idempotency_key", sa.Text(), nullable=True),
        sa.Column("created_at_ms", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            f"kind IN ({LEDGER_KINDS_SQL})", name="ck_account_ledger_kind"
        ),
        sa.CheckConstraint(
            "delta_micro_usd <> 0", name="ck_account_ledger_delta_nonzero"
        ),
    )
    op.create_index(
        UX_LEDGER_IDEMPOTENCY, LEDGER, ["idempotency_key"], unique=True
    )
    op.create_index(IX_LEDGER_USER_CREATED, LEDGER, ["user_id", "created_at_ms"])
    op.create_index(IX_LEDGER_KIND_CREATED, LEDGER, ["kind", "created_at_ms"])
    op.create_index(IX_LEDGER_REF, LEDGER, ["ref_type", "ref_id"])


def _create_holds() -> None:
    if HOLDS in _table_names():
        return
    op.create_table(
        HOLDS,
        sa.Column("id", sa.Text(), primary_key=True, nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("amount_micro_usd", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("created_at_ms", sa.Integer(), nullable=False),
        sa.Column("expires_at_ms", sa.Integer(), nullable=False),
        sa.Column("settled_at_ms", sa.Integer(), nullable=True),
        sa.Column("ai_request_id", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "amount_micro_usd > 0", name="ck_credit_holds_amount_positive"
        ),
        sa.CheckConstraint(
            "status IN ('active','settled','released','expired')",
            name="ck_credit_holds_status",
        ),
    )
    op.create_index(
        IX_HOLDS_USER_STATUS, HOLDS, ["user_id", "status"]
    )
    op.create_index(
        IX_HOLDS_STATUS_EXPIRES, HOLDS, ["status", "expires_at_ms"]
    )


def _create_prices() -> None:
    if PRICES in _table_names():
        return
    op.create_table(
        PRICES,
        sa.Column("id", sa.Text(), primary_key=True, nullable=False),
        sa.Column("model_id", sa.Text(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("effective_from_ms", sa.Integer(), nullable=False),
        sa.Column("input_micro_usd_per_mtok", sa.Integer(), nullable=False),
        sa.Column("output_micro_usd_per_mtok", sa.Integer(), nullable=False),
        sa.Column("source_kind", sa.Text(), nullable=False),
        sa.Column("source_ref", sa.Text(), nullable=True),
        sa.Column("verified_at_ms", sa.Integer(), nullable=False),
        sa.Column("price_version", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "input_micro_usd_per_mtok >= 0 AND output_micro_usd_per_mtok >= 0",
            name="ck_model_prices_nonnegative",
        ),
        sa.CheckConstraint(
            "source_kind IN ('official_page','vendor_bill','manual')",
            name="ck_model_prices_source_kind",
        ),
    )
    op.create_index(
        UX_PRICES_MODEL_EFFECTIVE,
        PRICES,
        ["model_id", "effective_from_ms"],
        unique=True,
    )
    op.create_index(
        IX_PRICES_PROVIDER, PRICES, ["provider", "effective_from_ms"]
    )


def _seed_prices() -> None:
    """插入可核实价格（幂等：唯一索引 + INSERT OR IGNORE）。"""
    if PRICES not in _table_names():
        return
    conn = op.get_bind()
    for seed in PRICE_SEEDS:
        conn.execute(
            sa.text(
                "INSERT OR IGNORE INTO model_prices ("
                "id, model_id, provider, effective_from_ms, "
                "input_micro_usd_per_mtok, output_micro_usd_per_mtok, "
                "source_kind, source_ref, verified_at_ms, price_version, note"
                ") VALUES (:id, :model_id, :provider, :effective_from_ms, "
                ":input, :output, 'official_page', :source_ref, :verified_at_ms, "
                ":price_version, :note)"
            ),
            {
                "id": seed["id"],
                "model_id": seed["model_id"],
                "provider": seed["provider"],
                "effective_from_ms": PRICE_EFFECTIVE_FROM_MS,
                "input": seed["in"],
                "output": seed["out"],
                "source_ref": seed["source_ref"],
                "verified_at_ms": PRICE_EFFECTIVE_FROM_MS,
                "price_version": PRICE_VERSION,
                "note": seed["note"],
            },
        )


def _backfill_existing_users() -> None:
    """D-3：给 active 且从未发过开户奖励的用户补 $2.00（幂等）。"""
    if LEDGER not in _table_names():
        return
    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT u.id FROM users u "
            "WHERE COALESCE(u.status, 'active') = 'active' "
            "AND COALESCE(u.balance_micro_usd, 0) = 0 "
            "AND NOT EXISTS ("
            "  SELECT 1 FROM account_ledger l WHERE l.user_id = u.id "
            "  AND l.kind IN ('signup_bonus','signup_bonus_backfill')"
            ")"
        )
    ).fetchall()
    now_ms = int(time.time() * 1000)
    for row in rows:
        user_id = row[0]
        idempotency_key = f"signup_bonus_backfill:{user_id}"
        # 手工重跑（例如删掉 alembic_version 再 upgrade）也不能重复加钱。
        already = conn.execute(
            sa.text(
                "SELECT 1 FROM account_ledger WHERE idempotency_key = :key"
            ),
            {"key": idempotency_key},
        ).fetchone()
        if already is not None:
            continue
        conn.execute(
            sa.text(
                "INSERT INTO account_ledger ("
                "id, user_id, kind, delta_micro_usd, balance_after_micro_usd, "
                "ref_type, ref_id, reason, actor_id, idempotency_key, created_at_ms"
                ") VALUES (:id, :user_id, 'signup_bonus_backfill', :delta, :delta, "
                "'migration', '0025_balance_cost', :reason, NULL, "
                ":idempotency_key, :created_at_ms)"
            ),
            {
                "id": f"bl-backfill-{user_id}",
                "user_id": user_id,
                "delta": BACKFILL_BONUS_MICRO_USD,
                "reason": "M3a 存量用户一次性补发（D-3）",
                "idempotency_key": idempotency_key,
                "created_at_ms": now_ms,
            },
        )
        conn.execute(
            sa.text(
                "UPDATE users SET balance_micro_usd = :bonus "
                "WHERE id = :user_id AND COALESCE(balance_micro_usd, 0) = 0"
            ),
            {"bonus": BACKFILL_BONUS_MICRO_USD, "user_id": user_id},
        )


def upgrade() -> None:
    """建余额/流水/预占/价格表，补 ai_usage 计费列，补发存量用户 $2.00。"""
    # 1) users.balance_micro_usd（旧 credits 保留冻结）。
    if BALANCE_COLUMN not in _column_names("users"):
        op.add_column(
            "users",
            sa.Column(
                BALANCE_COLUMN,
                sa.Integer(),
                nullable=False,
                server_default=sa.text("0"),
            ),
        )

    # 2) 三张新表 + 索引。
    _create_ledger()
    _create_holds()
    _create_prices()

    # 3) ai_usage 计费快照列（表不存在说明还没跑到 0003，跳过即可：
    #    后续迁移会创建该表，新列由应用写入时带默认语义）。
    existing = _column_names("ai_usage")
    if existing:
        for name, column_type in AI_USAGE_COLUMNS:
            if name not in existing:
                op.add_column("ai_usage", sa.Column(name, column_type, nullable=True))
        # 历史行标记 legacy：它们发生在余额扣费之前，不能按 est_cost_usd 补扣。
        conn = op.get_bind()
        conn.execute(
            sa.text(
                "UPDATE ai_usage SET billing_status = 'legacy', billable = 0, "
                "token_source = COALESCE(token_source, 'unknown'), "
                "price_source = COALESCE(price_source, 'legacy') "
                "WHERE billing_status IS NULL"
            )
        )

    # 4) 价格 seed + 5) 存量用户补发。
    _seed_prices()
    _backfill_existing_users()


def _drop_column(table: str, column: str) -> None:
    if column not in _column_names(table):
        return
    with op.batch_alter_table(table) as batch:
        batch.drop_column(column)


def downgrade() -> None:
    """回滚：删本迁移新增的表/列，保留 users 与 ai_usage 的既有数据。"""
    # 1) ai_usage 的 10 个计费列一次性重建表删除（比逐列重建快一个量级）。
    to_drop = [
        name for name, _type in AI_USAGE_COLUMNS if name in _column_names("ai_usage")
    ]
    if to_drop:
        with op.batch_alter_table("ai_usage") as batch:
            for name in to_drop:
                batch.drop_column(name)

    # 2) 三张新表（索引随表删除）。
    for table in (HOLDS, LEDGER, PRICES):
        if table in _table_names():
            op.drop_table(table)

    # 3) users.balance_micro_usd（旧 credits 不动）。
    _drop_column("users", BALANCE_COLUMN)
