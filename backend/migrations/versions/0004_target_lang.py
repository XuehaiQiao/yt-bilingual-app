"""target_lang：给 ``ai_usage`` 增加目标语言维度（specs/012 §5.5 / §5.10）

Revision ID: 0004_target_lang
Revises: 0003_cost_ledger
Create Date: 2026-11-15

M1b 的账本只按「用户 + 功能 + 模型」记成本；多语言上线后需要回答「越南语翻译
花了多少」。P0 只加**记录维度**，不按语言拆限额：

- 列：``ai_usage.target_lang TEXT``，**可空**、默认 ``zh-CN``；
- 旧数据不批量改写：SQLite ``ADD COLUMN ... DEFAULT`` 让旧行读出默认值，
  不执行任何 UPDATE（符合「只读兼容、不批量重写」）；
- 新写入由 ``ai.ledger.record_usage`` 显式填值；未跑本迁移的旧库会退化为
  不带该列写入（见 ledger 的 fallback），不会丢成本数据；
- 不做索引：P0 的按语言成本查询是低频运营查询，数据量小；等真有需求再加。

downgrade 删列（SQLite 3.35+ 支持 ``DROP COLUMN``）；只用于空库/测试回滚。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0004_target_lang"
down_revision: str = "0003_cost_ledger"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "ai_usage"
COLUMN = "target_lang"
DEFAULT_TARGET_LANG = "zh-CN"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _column_names(table: str) -> set[str]:
    return {column["name"] for column in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    """给 ``ai_usage`` 加可空 ``target_lang``（默认 zh-CN），幂等。"""
    if TABLE not in _table_names():
        # 0003 尚未建表（例如先 stamp 到 head 的异常库）：本迁移无从加列。
        # 不替 0003 建表——保持迁移各自职责，留给运维先修版本号。
        return
    if COLUMN in _column_names(TABLE):
        return
    op.add_column(
        TABLE,
        sa.Column(
            COLUMN,
            sa.Text(),
            nullable=True,
            server_default=sa.text(f"'{DEFAULT_TARGET_LANG}'"),
        ),
    )


def downgrade() -> None:
    """删除 ``target_lang`` 列（会丢语言维度，仅限空库/测试回滚）。"""
    if TABLE not in _table_names() or COLUMN not in _column_names(TABLE):
        return
    op.drop_column(TABLE, COLUMN)
