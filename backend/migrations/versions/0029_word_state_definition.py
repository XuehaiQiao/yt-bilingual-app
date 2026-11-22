"""词状态加释义快照 definition（specs/013「释义快照」/ specs/038 §4）

Revision ID: 0029_word_state_definition
Revises: 0028_user_wordlists
Create Date: 2026-11-22

``word_states.definition TEXT NULL``：用户提供的释义快照（来自自定义词表 /
收藏）。复习队列与词列表的公开 ``word`` 形状新增 ``definition``；复习卡优先
显示快照，缺失时才调 ``/api/define``。旧行为 NULL（系统词典释义**不回写**
该列，快照只属于用户数据）。

- 用 ``ALTER TABLE ... ADD COLUMN`` 原地加列，**不重建表**；SQLite 允许可空
  列的 ADD COLUMN，历史行自动补 NULL。
- 写入口径：``srs.add_word`` **仅当现有值为空（NULL / 空白）时**写入，已有
  ＞0 的快照绝不被第二次导入覆盖。
- 读侧兼容：库停在 0028 时 ``srs`` 用 ``NULL AS definition`` 读出，队列/列表
  照常工作；只有**带 definition 加词**的写路径返回 503 提示先升级。

**回滚（downgrade）说明：本迁移的 downgrade 是 no-op（保留列与数据）。**

- 列内容是用户提供的释义快照，物理删列会不可恢复地丢掉用户数据；回滚到
  0028 的旧代码不读该列，可空列对旧写入路径也没有影响，保留即可安全降级。
- SQLite 3.35+ 支持 ``DROP COLUMN``，这里**主动选择不删**；若要彻底物理
  回滚，可手工执行 ``ALTER TABLE word_states DROP COLUMN definition``，但请先
  确认没有代码依赖该列。
- **幂等**：``upgrade`` 先查列是否存在（降级后再升级 / 手工改过库），不会报
  ``duplicate column name``；表不存在（库没走 0006）时跳过，之后 0006 建表
  不会带本列，读侧按 NULL 兼容。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0029_word_state_definition"
down_revision: str = "0028_user_wordlists"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "word_states"
DEFINITION_COLUMN = "definition"

# 可空快照：旧行 NULL，不设默认值。
ADD_COLUMN_SQL = f"ALTER TABLE {TABLE} ADD COLUMN {DEFINITION_COLUMN} TEXT"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _column_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns(table)}


def upgrade() -> None:
    """原地加列；列已存在（降级后重新升级 / 手工改过库）时跳过。"""
    if TABLE not in _table_names():
        return
    if DEFINITION_COLUMN in _column_names(TABLE):
        return
    op.execute(ADD_COLUMN_SQL)


def downgrade() -> None:
    """no-op：保留 definition 列与用户释义快照（详见模块文档）。"""
    return
