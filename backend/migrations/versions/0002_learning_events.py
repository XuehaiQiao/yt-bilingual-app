"""learning_events：append-only 的学习事件日志

Revision ID: 0002_learning_events
Revises: 0001_baseline
Create Date: 2026-11-15

字段（对应计划书 §7.3 A-1 / §8.4）：

- ``user_id``：归属用户。计划书 §8.4 的删除权矩阵要求最终只存假名，
  但 D-10（删除权口径）尚未定稿，M1a 先同时保留明文 ``user_id``（查询/归属用）
  与 ``pseudonym_id``（统计用），定稿后按表级矩阵迁移；
- ``pseudonym_id = HMAC-SHA256(EVENTS_PSEUDONYM_SALT, user_id)``，见 backend/events.py；
- ``occurred_at``：客户端毫秒时间戳；``created_at``：服务端毫秒时间戳；
- ``payload``：JSON 文本（UTF-8，dict/list 均可；不用 SQLite 的 JSON 亲和类型，
  避免 NUMERIC 亲和把形如 "123" 的 JSON 字符串转成数字，破坏 JSON 往返）；
- ``event_type`` 不设 CHECK 约束：事件字典 v1（spec-011）还没定稿，先由写入层
  + 文档约束（示例：video_open / block_visible / quiz_answer / word_review）。

append-only 在应用层保证（backend/events.py 只有 INSERT/SELECT）；这里不建
禁止改删的触发器，因为 §8.4 的保留期（24 个月）硬删路径以后要能运行。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002_learning_events"
down_revision: str = "0001_baseline"
branch_labels: str | None = None
depends_on: str | None = None

USER_INDEX = "ix_learning_events_user_occurred"
TYPE_INDEX = "ix_learning_events_type_occurred"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return {index["name"] for index in inspector.get_indexes(table)}


def upgrade() -> None:
    """建 learning_events 与两个查询索引（幂等）。"""
    if "learning_events" not in _table_names():
        op.create_table(
            "learning_events",
            # INTEGER PRIMARY KEY 在 SQLite 里就是 rowid 的别名，自增；不写
            # AUTOINCREMENT —— 跨库兼容，且 append-only 下不存在 rowid 复用问题。
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.Text(), nullable=True),
            sa.Column("device_id", sa.Text(), nullable=True),
            sa.Column("session_id", sa.Text(), nullable=True),
            sa.Column("event_type", sa.Text(), nullable=False),
            sa.Column("content_ref", sa.Text(), nullable=True),
            sa.Column("payload", sa.Text(), nullable=True),
            sa.Column("occurred_at", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.Integer(), nullable=False),
            sa.Column("pseudonym_id", sa.Text(), nullable=True),
        )

    existing = _index_names("learning_events")
    if USER_INDEX not in existing:
        op.create_index(USER_INDEX, "learning_events", ["user_id", "occurred_at"])
    if TYPE_INDEX not in existing:
        op.create_index(TYPE_INDEX, "learning_events", ["event_type", "occurred_at"])


def downgrade() -> None:
    """删事件表（会删数据，仅限空库/测试）。"""
    op.execute(f"DROP INDEX IF EXISTS {USER_INDEX}")
    op.execute(f"DROP INDEX IF EXISTS {TYPE_INDEX}")
    op.execute("DROP TABLE IF EXISTS learning_events")
