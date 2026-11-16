"""behavior_events：学习行为埋点的幂等键（CEFR M2 #7）

Revision ID: 0017_behavior_events
Revises: 0016_content_difficulty
Create Date: 2026-11-17

M2「锚点与匹配」#7 行为埋点：``dict_lookup`` / ``video_replay`` /
``playback_rate`` / ``tab_visibility`` 四类事件复用现有 ``learning_events``
append-only 表（不新建表，计划书 §7.3 的事件口径）。

本迁移只做两件事：

- ``learning_events`` 加可空列 ``client_event_id``：客户端生成的幂等键
  （与 ``watch_events`` 同名同义）；旧行保持 NULL，不 backfill。
- 建部分唯一索引 ``ux_learning_events_user_type_client``：
  ``(user_id, event_type, client_event_id) WHERE client_event_id IS NOT NULL``。
  同一归属、同一事件类型下重复上报只落一行；``user_id`` 为 NULL 的旧事件
  不参与约束（部分索引不约束 NULL 行）。

downgrade 删索引与列；只用于空库/测试回滚。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0017_behavior_events"
down_revision: str = "0016_content_difficulty"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "learning_events"
COLUMN = "client_event_id"
UNIQUE_INDEX = "ux_learning_events_user_type_client"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _column_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns(table)}


def _index_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {index["name"] for index in inspector.get_indexes(table)}


def upgrade() -> None:
    """加幂等键列 + 部分唯一索引（幂等）。"""
    if TABLE not in _table_names():
        return

    if COLUMN not in _column_names(TABLE):
        # 可空：旧事件没有客户端幂等键；新事件由 behavior_events.py 强制填写。
        op.add_column(TABLE, sa.Column(COLUMN, sa.Text(), nullable=True))

    if UNIQUE_INDEX not in _index_names(TABLE):
        op.create_index(
            UNIQUE_INDEX,
            TABLE,
            ["user_id", "event_type", COLUMN],
            unique=True,
            sqlite_where=sa.text(f"{COLUMN} IS NOT NULL"),
        )


def downgrade() -> None:
    """删部分唯一索引与幂等键列（仅空库/测试回滚）。"""
    if TABLE not in _table_names():
        return
    if UNIQUE_INDEX in _index_names(TABLE):
        op.drop_index(UNIQUE_INDEX, table_name=TABLE)
    if COLUMN in _column_names(TABLE):
        with op.batch_alter_table(TABLE) as batch_op:
            batch_op.drop_column(COLUMN)
