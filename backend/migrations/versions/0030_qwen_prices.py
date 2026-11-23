"""Qwen Flash/Plus 版本价：qwen3.8-flash / qwen3.7-plus（P1-20）

Revision ID: 0030_qwen_prices
Revises: 0029_word_state_definition
Create Date: 2026-11-23

Qwen（阿里云百炼）在目录里一直是**别名**：``qwen-flash`` / ``qwen-plus``。
provider ``/models`` 确认这两个别名当前分别指向 ``qwen3.8-flash`` /
``qwen3.7-plus``。本迁移往 ``model_prices`` 写两类行：

1. **真实版本名**（``qwen3.8-flash`` / ``qwen3.7-plus``）——价格的事实来源，
   与官方帮助页的模型名一一对应；
2. **目录别名**（``qwen-flash`` / ``qwen-plus``）——同价同源，别名改指向时必须
   同步更新（改价走新迁移，不改旧行）。

为什么别名也要有行：账本与计费用的是**目录 id**（``llm`` 里的 ``model_key``，
``billing.price_for_model`` 的查询键），provider 请求才用 ``spec["model_id"]``。
只写版本名会让严格计费继续按 ``qwen-flash`` 查不到价（503
``model_unpriced``），本卡验收「严格计费下 Qwen 不再因未定价被拒」不成立。

**价格来源（官方帮助页 2026-11-21 更新，核对日 2026-11-23）**

https://www.alibabacloud.com/help/zh/model-studio/model-pricing

- ``qwen3.8-flash``：北京/全球 输入 **$0.113** / 输出 **$0.382** 每百万 Token；
  新加坡/香港 $0.15 / $0.47。
- ``qwen3.7-plus``：北京/全球 输入 **$0.276** / 输出 **$1.101** 每百万 Token
  （≤256K 上下文；取**原价**，不采用限时折扣）；美国/日本 $0.4 / $1.6。

本项目 ``QWEN_BASE_URL`` 是 dashscope 国内站（北京），故采用北京/全球价；不做
汇率换算、不采用其他地域价。金额 USD 不含税，按整数 µUSD/1M tokens 记：
$0.113 → 113000、$0.382 → 382000、$0.276 → 276000、$1.101 → 1101000。

**幂等与回滚**

- ``upgrade`` 用 ``INSERT OR IGNORE``（唯一索引
  ``ux_model_prices_model_effective`` 兜底），重复执行不会产生重复行，也不会因
  「先手工插过一行」报错。
- ``downgrade`` 只按本迁移的 4 个 id 删除，不动 0025 的 ``deepseek-chat`` /
  ``gemini-2.5-flash`` seed。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0030_qwen_prices"
down_revision: str = "0029_word_state_definition"
branch_labels: str | None = None
depends_on: str | None = None

PRICES = "model_prices"

# 2026-11-20T00:00:00Z：与 0025 的 PRICE_EFFECTIVE_FROM_MS 同一本轮核价生效时间。
PRICE_EFFECTIVE_FROM_MS = 1_795_132_800_000
# 2026-11-23T00:00:00Z：本卡核对日（官方帮助页 2026-11-21 更新）。
PRICE_VERIFIED_AT_MS = 1_795_392_000_000
PRICE_VERSION = "2026-11-23.official.1"
SOURCE_REF = "https://www.alibabacloud.com/help/zh/model-studio/model-pricing"

QWEN_FLASH_IN = 113_000  # $0.113 / 1M tokens
QWEN_FLASH_OUT = 382_000  # $0.382 / 1M tokens
QWEN_PLUS_IN = 276_000  # $0.276 / 1M tokens
QWEN_PLUS_OUT = 1_101_000  # $1.101 / 1M tokens

FLASH_NOTE = (
    "官方帮助页 2026-11-21 更新：北京/全球 输入 $0.113 / 输出 $0.382 每百万 Token"
    "（USD 不含税）。本项目 QWEN_BASE_URL 为 dashscope 国内站 → 采用北京/全球价；"
    "新加坡/香港价 $0.15/$0.47 不采用，不做汇率换算。"
)
PLUS_NOTE = (
    "官方帮助页 2026-11-21 更新：北京/全球 输入 $0.276 / 输出 $1.101 每百万 Token"
    "（≤256K 上下文；USD 不含税；取原价，不采用限时折扣）。本项目 QWEN_BASE_URL "
    "为 dashscope 国内站 → 采用北京/全球价；美国/日本价 $0.4/$1.6 不采用。"
)

PRICE_SEEDS = (
    {
        "id": "mp-20261120-qwen38-flash",
        "model_id": "qwen3.8-flash",
        "in": QWEN_FLASH_IN,
        "out": QWEN_FLASH_OUT,
        "note": "真实版本名价（qwen-flash 别名当前指向该版本）。" + FLASH_NOTE,
    },
    {
        "id": "mp-20261120-qwen-flash",
        "model_id": "qwen-flash",
        "in": QWEN_FLASH_IN,
        "out": QWEN_FLASH_OUT,
        "note": (
            "目录 id（账本/计费键）qwen-flash 的价：provider 当前把该别名指向 "
            "qwen3.8-flash，与其同价同源；别名改指向时必须同步更新。"
        )
        + FLASH_NOTE,
    },
    {
        "id": "mp-20261120-qwen37-plus",
        "model_id": "qwen3.7-plus",
        "in": QWEN_PLUS_IN,
        "out": QWEN_PLUS_OUT,
        "note": "真实版本名价（qwen-plus 别名当前指向该版本）。" + PLUS_NOTE,
    },
    {
        "id": "mp-20261120-qwen-plus",
        "model_id": "qwen-plus",
        "in": QWEN_PLUS_IN,
        "out": QWEN_PLUS_OUT,
        "note": (
            "目录 id（账本/计费键）qwen-plus 的价：provider 当前把该别名指向 "
            "qwen3.7-plus，与其同价同源；别名改指向时必须同步更新。"
        )
        + PLUS_NOTE,
    },
)

INSERT_SQL = (
    "INSERT OR IGNORE INTO model_prices ("
    "id, model_id, provider, effective_from_ms, "
    "input_micro_usd_per_mtok, output_micro_usd_per_mtok, "
    "source_kind, source_ref, verified_at_ms, price_version, note"
    ") VALUES (:id, :model_id, 'Alibaba', :effective_from_ms, "
    ":input, :output, 'official_page', :source_ref, :verified_at_ms, "
    ":price_version, :note)"
)

SEED_IDS = tuple(seed["id"] for seed in PRICE_SEEDS)
DELETE_SQL = "DELETE FROM model_prices WHERE id IN (" + ",".join(
    f"'{seed_id}'" for seed_id in SEED_IDS
) + ")"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    """写入 Qwen 版本价与目录别名价（幂等；表不存在时跳过）。"""
    if PRICES not in _table_names():
        return
    conn = op.get_bind()
    for seed in PRICE_SEEDS:
        conn.execute(
            sa.text(INSERT_SQL),
            {
                "id": seed["id"],
                "model_id": seed["model_id"],
                "effective_from_ms": PRICE_EFFECTIVE_FROM_MS,
                "input": seed["in"],
                "output": seed["out"],
                "source_ref": SOURCE_REF,
                "verified_at_ms": PRICE_VERIFIED_AT_MS,
                "price_version": PRICE_VERSION,
                "note": seed["note"],
            },
        )


def downgrade() -> None:
    """只删本迁移写入的 4 行；0025 的 seed 与历史行保留。"""
    if PRICES not in _table_names():
        return
    op.get_bind().execute(sa.text(DELETE_SQL))
