"""review_mastered：词状态加「已掌握」标记（specs/013 v1.1 / specs/005 v1.1）

Revision ID: 0027_review_mastered
Revises: 0026_seed_band_fix
Create Date: 2026-11-21

给 ``word_states`` 加 ``mastered INTEGER NOT NULL DEFAULT 0``（0/1）：

- ``mastered`` 是词状态之上的**标记**，不是新的 ``state`` 取值——不碰 0006 的
  ``state`` CHECK，FSRS 参数（stability / difficulty / due_at / reps）照旧保留，
  撤销「已掌握」不重置复习进度。
- 用 ``ALTER TABLE ... ADD COLUMN`` 原地加列，**不重建表**：SQLite 允许
  「NOT NULL + 非空 DEFAULT」的 ADD COLUMN，历史行自动补 0。
- ``mastered=1`` 的词不进复习队列、不计 ``newWords`` / ``dueToday``，也不参与
  连续天数；统计新增 ``masteredWords``。队列表（读侧）在 srs.py 里过滤。
- 加词入口（``POST /api/review/words``）对已存在且 ``mastered=1`` 的词强制
  清成 0（用户重新加入复习 = 想复习）。

**回滚（downgrade）说明：本迁移的 downgrade 是 no-op（保留列与数据）。**

- 列内容是用户手工标记，物理删列会不可恢复地丢掉「哪些词已掌握」；而回滚到
  0026 的旧代码根本不读这一列，``NOT NULL DEFAULT 0`` 对旧写入路径也没有影响，
  所以保留即可安全降级。
- SQLite 3.35+ 其实支持 ``ALTER TABLE ... DROP COLUMN``，这里**主动选择不删**
  （不是为了兼容旧版 SQLite）；若要彻底物理回滚，可手工执行
  ``ALTER TABLE word_states DROP COLUMN mastered``，但请先确认没有代码依赖该列。
- **读侧兼容**：``srs`` 查询词状态前先看列是否存在（``PRAGMA table_info``），
  列缺失时按 ``0 AS mastered`` 读出，因此「未跑 0027 的库」不会被新代码打成
  503；只有写标记的 ``PATCH``（``srs.set_mastered``）会返回 503 提示先升级。
- 因为列可能被保留，``upgrade`` 先查列再 ADD，重复执行/降级后再升级都不会
  「duplicate column name」。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0027_review_mastered"
down_revision: str = "0026_seed_band_fix"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "word_states"
MASTERED_COLUMN = "mastered"

# 与 specs/013 一致：0/1 标记，默认 0（未掌握）。
ADD_COLUMN_SQL = (
    f"ALTER TABLE {TABLE} ADD COLUMN {MASTERED_COLUMN} "
    "INTEGER NOT NULL DEFAULT 0"
)


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
        # 正常升级顺序里 0006 已建表；表缺失说明库没走 0006，跳过即可，
        # 之后 0006 建表时不会有本列（读侧按 0 兼容，写标记返回 503）。
        return
    if MASTERED_COLUMN in _column_names(TABLE):
        return
    op.execute(ADD_COLUMN_SQL)


def downgrade() -> None:
    """no-op：保留 ``mastered`` 列与用户标记（详见模块文档）。

    回滚到 0026 后旧代码不读该列，保留不会有副作用；删列会丢用户数据。
    读侧在列缺失时按 0 兼容，所以「跳过」与「物理删列」两种状态都能被
    正确读取；本迁移只选择前者。
    """
    return
