"""单用户每日 AI 额度覆盖表 quota_overrides（specs/047 §3）

Revision ID: 0031_quota_overrides
Revises: 0030_qwen_prices
Create Date: 2026-11-24

建一张表：管理员为**单个用户 × 单个功能**设置的每日额度覆盖值。生效顺序是
「单用户覆盖 > 全局默认（``app_settings.ai_quota_defaults``）>
``config.AI_DAILY_QUOTA_*``」，本表是最上面一层（见 ``quota_config.py``）。

字段契约：

- ``user_id`` + ``feature`` 复合主键 —— 天然满足 ``UNIQUE(user_id, feature)``，
  同一用户同一功能只有一条覆盖（应用层 UPSERT）；
  复合主键也覆盖 ``WHERE user_id = ?`` 的查询前缀，不额外建索引；
- ``limit_units``：``0..1_000_000`` 的整数；``CHECK (limit_units >= 0)``
  兜底「不能为负」。**0 = 关闭该功能**（不是「无限」）；上限在应用层校验；
- ``reason`` / ``created_by``：客服/大客户覆盖的原因与操作者（审计上下文）；
- ``created_at_ms`` / ``updated_at_ms``：毫秒时间戳；UPSERT 时保留创建时间、
  刷新更新时间（应用层负责）。

**回滚（downgrade）**：只删这张新表。它不引用也不修改任何旧表，回滚到 0030
后旧代码照常运行；代价是丢失管理员设置的单用户覆盖（那些用户回继承默认额度）。
要保留数据请先备份 ``data/app.db``。

**幂等**：``upgrade`` 先查 ``sqlite_master``，表已存在（手工建过/降级后重新
升级）就跳过；``downgrade`` 同样先判断再删，重复执行安全。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0031_quota_overrides"
down_revision: str = "0030_qwen_prices"
branch_labels: str | None = None
depends_on: str | None = None

OVERRIDES_TABLE = "quota_overrides"
CHECK_LIMIT_NON_NEGATIVE = "ck_quota_overrides_limit_non_negative"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    """建 ``quota_overrides``；表已存在时跳过（可重复执行）。"""
    if OVERRIDES_TABLE in _table_names():
        return
    op.create_table(
        OVERRIDES_TABLE,
        sa.Column("user_id", sa.Text(), primary_key=True, nullable=False),
        sa.Column("feature", sa.Text(), primary_key=True, nullable=False),
        sa.Column("limit_units", sa.Integer(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_at_ms", sa.Integer(), nullable=False),
        sa.Column("updated_at_ms", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "limit_units >= 0", name=CHECK_LIMIT_NON_NEGATIVE
        ),
    )


def downgrade() -> None:
    """删除本迁移新建的表；不存在时跳过（可重复执行）。"""
    if OVERRIDES_TABLE in _table_names():
        op.drop_table(OVERRIDES_TABLE)
