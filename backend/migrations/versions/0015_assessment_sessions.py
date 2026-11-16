"""assessment_sessions：自评与后续测试会话（计划书 §7.2，specs/025）。

Revision ID: 0015_assessment_sessions
Revises: 0014_ability
Create Date: 2026-11-17

M1 只落 ``kind='self_assess'`` 的已提交会话；表结构与定位测的
``placement_sessions`` 并存，**不当唯一历史**（定位测仍是主卷）：

- ``id`` TEXT PK（uuid4 hex，应用生成）；
- ``user_id`` 归属键（登录 id / ``guest:<sha256>``），``guest_hash`` 预留；
- ``kind`` CHECK ``placement/self_assess/listening_check/writing_sample/
  speaking_sample/quick_check``；
- ``status`` CHECK ``in_progress/submitted/abandoned``；
- ``client_request_id`` 幂等键：``UNIQUE(user_id, client_request_id)``；
- ``started_at`` / ``submitted_at`` / ``duration_ms``；
- ``score`` / ``confidence``（自评 confidence ≤0.35，由应用 cap）；
- ``skills`` JSON 数组、``result`` JSON 摘要（**不含大段原文**）；
- ``schema_version`` 默认 ``ability.v1``；
- 部分唯一索引 ``(user_id, kind) WHERE status='in_progress'``：同一用户同类
  测试最多一个进行中会话；
- 索引 ``(user_id, kind, started_at)``。

downgrade 只删本表；定位测表与能力画像不受影响。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0015_assessment_sessions"
down_revision: str = "0014_ability"
branch_labels: str | None = None
depends_on: str | None = None

SESSIONS = "assessment_sessions"
INDEX_USER_KIND_STARTED = "ix_assessment_sessions_user_kind_started"
UNIQUE_ACTIVE = "ux_assessment_sessions_active"
UNIQUE_REQUEST = "ux_assessment_sessions_request"

KINDS = (
    "placement",
    "self_assess",
    "listening_check",
    "writing_sample",
    "speaking_sample",
    "quick_check",
)
STATUSES = ("in_progress", "submitted", "abandoned")
SCHEMA_VERSION = "ability.v1"
MAX_DURATION_MS = 86_400_000


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _in_check(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{value}'" for value in values) + ")"


def upgrade() -> None:
    """建 assessment_sessions 与两个唯一索引（幂等）。"""
    if SESSIONS in _table_names():
        return
    op.create_table(
        SESSIONS,
        sa.Column("id", sa.Text(), primary_key=True, nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("guest_hash", sa.Text(), nullable=True),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column(
            "status", sa.Text(), nullable=False, server_default=sa.text("'in_progress'")
        ),
        sa.Column("client_request_id", sa.Text(), nullable=True),
        sa.Column("started_at", sa.Integer(), nullable=False),
        sa.Column("submitted_at", sa.Integer(), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("skills", sa.Text(), nullable=True),
        sa.Column("result", sa.Text(), nullable=True),
        sa.Column(
            "schema_version",
            sa.Text(),
            nullable=False,
            server_default=sa.text(f"'{SCHEMA_VERSION}'"),
        ),
        sa.CheckConstraint(_in_check("kind", KINDS), name="ck_assessment_sessions_kind"),
        sa.CheckConstraint(
            _in_check("status", STATUSES), name="ck_assessment_sessions_status"
        ),
        sa.CheckConstraint(
            f"duration_ms IS NULL OR duration_ms BETWEEN 0 AND {MAX_DURATION_MS}",
            name="ck_assessment_sessions_duration",
        ),
        sa.CheckConstraint(
            "confidence IS NULL OR confidence BETWEEN 0 AND 1",
            name="ck_assessment_sessions_confidence",
        ),
    )
    op.create_index(
        INDEX_USER_KIND_STARTED,
        SESSIONS,
        ["user_id", "kind", "started_at"],
    )
    # 同一用户同一类测试最多一个 in_progress（并发 start 兜底）。
    op.create_index(
        UNIQUE_ACTIVE,
        SESSIONS,
        ["user_id", "kind"],
        unique=True,
        sqlite_where=sa.text("status = 'in_progress'"),
    )
    # 幂等键；NULL 不参与唯一冲突（SQLite 语义），所以旧端点/内部会话可留空。
    op.create_index(
        UNIQUE_REQUEST,
        SESSIONS,
        ["user_id", "client_request_id"],
        unique=True,
    )


def downgrade() -> None:
    """只删本表；其他能力表与定位测表保留。"""
    if SESSIONS in _table_names():
        op.drop_table(SESSIONS)
