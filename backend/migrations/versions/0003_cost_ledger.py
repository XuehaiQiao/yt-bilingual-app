"""cost ledger：``ai_usage``（只追加的 AI 用量账本）+ ``ai_quota``（日配额计数）

Revision ID: 0003_cost_ledger
Revises: 0002_learning_events
Create Date: 2026-11-15

对应计划书 §7.4「AI 成本账本 / 配额与预算」与 M1 ②：

``ai_usage``（**append-only**，只加不改，不做历史回写）
    - id：INTEGER PRIMARY KEY（SQLite rowid 别名，自增）；
    - user_id：归属用户，可空（未登录脚本/旧数据记匿名）；
    - feature：``translate`` / ``summary`` / ``define`` / ``local_show``（写入层校验，
      表上不设 CHECK：新增功能不该为此改表）；
    - model_id / provider：模型目录 id 与厂商；
    - input_tokens / output_tokens：provider 返回的 usage；
    - calls：本次记录对应的 API 调用次数；
    - est_cost_usd：按 ``MODEL_CATALOG`` 价目估算的美元成本（未知价按已知最贵）；
    - occurred_at / created_at：毫秒时间戳（与 ``learning_events`` 一致）；
    - usage_date：写入时按 ``AI_QUOTA_TIMEZONE``（默认 Asia/Shanghai）派生的
      ``YYYY-MM-DD`` 日桶。存下来是为了让「用户+日」「功能+日」能走精确索引
      （``date(occurred_at)`` 无法用索引）；改时区只影响新数据，符合只追加口径。

索引：``(user_id, usage_date)``（本月花费/日预算）、``(feature, usage_date)``
（功能成本）、``(usage_date)``（全局日预算 SUM）。

``ai_quota``（UPSERT 累加）
    - 主键 ``(user_id, day, feature)``，``day`` 为 ``YYYY-MM-DD``；
    - ``used_units / limit_units``：当日已用/日限额；无历史行可回写。

为什么 ``usage_date`` 与 ``occurred_at`` 并存：前者是查询/索引维度，后者是原始
发生时间；两者都由写入层从同一个时间戳派生，不重复真源。downgrade 会删表（含
账本数据），只用于空库/测试回滚。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003_cost_ledger"
down_revision: str = "0002_learning_events"
branch_labels: str | None = None
depends_on: str | None = None

USAGE_USER_DAY_INDEX = "ix_ai_usage_user_day"
USAGE_FEATURE_DAY_INDEX = "ix_ai_usage_feature_day"
USAGE_DAY_INDEX = "ix_ai_usage_day"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return {index["name"] for index in inspector.get_indexes(table)}


def upgrade() -> None:
    """建 ``ai_usage`` / ``ai_quota`` 与查询索引（幂等，旧库可直接 upgrade）。"""
    tables = _table_names()

    if "ai_usage" not in tables:
        op.create_table(
            "ai_usage",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.Text(), nullable=True),
            sa.Column("feature", sa.Text(), nullable=False),
            sa.Column("model_id", sa.Text(), nullable=False),
            sa.Column("provider", sa.Text(), nullable=True),
            sa.Column("input_tokens", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("output_tokens", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("calls", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("est_cost_usd", sa.Float(), nullable=False, server_default=sa.text("0")),
            sa.Column("occurred_at", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.Integer(), nullable=False),
            sa.Column("usage_date", sa.Text(), nullable=False),
        )

    if "ai_quota" not in tables:
        op.create_table(
            "ai_quota",
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("day", sa.Text(), nullable=False),
            sa.Column("feature", sa.Text(), nullable=False),
            sa.Column("used_units", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("limit_units", sa.Integer(), nullable=False),
            sa.PrimaryKeyConstraint("user_id", "day", "feature"),
        )

    existing = _index_names("ai_usage")
    if USAGE_USER_DAY_INDEX not in existing:
        op.create_index(USAGE_USER_DAY_INDEX, "ai_usage", ["user_id", "usage_date"])
    if USAGE_FEATURE_DAY_INDEX not in existing:
        op.create_index(USAGE_FEATURE_DAY_INDEX, "ai_usage", ["feature", "usage_date"])
    if USAGE_DAY_INDEX not in existing:
        op.create_index(USAGE_DAY_INDEX, "ai_usage", ["usage_date"])


def downgrade() -> None:
    """删账本/配额表（会删数据，仅限空库/测试回滚）。"""
    for index in (USAGE_USER_DAY_INDEX, USAGE_FEATURE_DAY_INDEX, USAGE_DAY_INDEX):
        op.execute(f"DROP INDEX IF EXISTS {index}")
    op.execute("DROP TABLE IF EXISTS ai_quota")
    op.execute("DROP TABLE IF EXISTS ai_usage")
