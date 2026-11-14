"""baseline：users / sessions（与 backend/auth_db.py 的既有契约一致）

Revision ID: 0001_baseline
Revises:
Create Date: 2026-11-15

该迁移负责把「应用连库时自己建表」的历史状态纳入 Alembic 管理：

- 新库：直接建出 users / sessions + idx_sessions_expires；
- 旧库（已有 users/sessions，但没有 alembic_version）：本迁移用 inspector 判断
  表/索引是否存在，存在就跳过，因此 ``alembic upgrade head`` 对旧库同样安全，
  不会重建表、不会丢数据；也可以先 ``alembic stamp 0001_baseline`` 再 upgrade。

字段/索引以 auth_db.py 的 ``_init_schema`` 为准（email 小写 + UNIQUE；sessions
按 token_hash 主键、expires_at 索引）。downgrade 会 DROP 表，只用于空库/测试。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001_baseline"
down_revision: str | None = None
branch_labels: str | None = None
depends_on: str | None = None


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return {index["name"] for index in inspector.get_indexes(table)}


def upgrade() -> None:
    """建基线表；对已存在的表/索引保持不动（幂等，便于旧库直接纳管）。"""
    tables = _table_names()

    if "users" not in tables:
        op.create_table(
            "users",
            # 旧库（auth_db.py）是 `id TEXT PRIMARY KEY`：SQLite 对非 INTEGER
            # 主键不自动加 NOT NULL，这里显式 nullable=True 保持逐列一致。
            sa.Column("id", sa.Text(), primary_key=True, nullable=True),
            sa.Column("email", sa.Text(), nullable=False, unique=True),
            sa.Column("password_hash", sa.Text(), nullable=False),
            sa.Column("created_at", sa.Integer(), nullable=False),
        )

    if "sessions" not in tables:
        op.create_table(
            "sessions",
            sa.Column("token_hash", sa.Text(), primary_key=True, nullable=True),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("expires_at", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.Integer(), nullable=False),
        )

    if "idx_sessions_expires" not in _index_names("sessions"):
        op.create_index("idx_sessions_expires", "sessions", ["expires_at"])


def downgrade() -> None:
    """回滚到无 schema 状态（会删数据，仅限空库/测试）。"""
    op.execute("DROP INDEX IF EXISTS idx_sessions_expires")
    op.execute("DROP TABLE IF EXISTS sessions")
    op.execute("DROP TABLE IF EXISTS users")
