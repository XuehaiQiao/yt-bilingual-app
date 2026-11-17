"""course_mvp：课程 MVP 垂直切片（一课、登录用户、私测 / specs/029）

Revision ID: 0021_course_mvp
Revises: 0020_content_teaching_analysis
Create Date: 2026-11-18

真实课程的进度与事件存储：课程内容本身是随仓库分发的只读 JSON
（``content/course/*.json``），本迁移只建两张表，运行时不建表；表缺失时
``backend/course.py`` 抛 ``CourseUnavailable``，路由返回 503 并提示先跑迁移。

两张表：

- ``course_attempts``：某用户对某课的一次学习尝试。
  - ``id``：TEXT PK（uuid4 hex，由应用生成）；
  - ``user_id``：归属键，登录用户的 ``users.id``（课程需登录，游客不写）；
  - ``lesson_id`` / ``lesson_version``：课程包 id 与包内 version（内容升级后
    旧 attempt 仍能按自己的版本恢复）；
  - ``status``：``in_progress`` / ``completed`` / ``abandoned``（CHECK）；
  - ``current_step_id``：S0–S5，应用层校验步骤存在；
  - ``answers_json``：``{questionId: choice}`` 严格 JSON 文本（只存首次答案，
    重复同 choice 幂等、换 choice 由应用层 409）；
  - ``output_text``：S5 产出（≤2000 字符由应用层校验）；
  - ``score`` / ``total``：完成时计算（total 为课程题数，MVP 为 8）；
  - ``started_at`` / ``updated_at`` / ``completed_at``：服务端毫秒 UTC；
  - ``ix_course_attempts_user_updated(user_id, updated_at)``：恢复/列表查询；
  - ``ix_course_attempts_lesson_status(lesson_id, status)``：运营看流失用；
  - 部分唯一索引 ``ux_course_attempts_in_progress``：同一用户同一课程最多一条
    ``in_progress``，保证「start 复用未完成 attempt」在并发下也成立；已完成的
    历史 attempt 可以并存（允许重学同一课）。

- ``course_events``：课程埋点（append-only；为看流失）。
  - ``id``：INTEGER 自增主键；
  - ``attempt_id`` / ``user_id``：归属；所有查询都带 user_id，越权一律 404；
  - ``event``：``lesson_start`` / ``step_view`` / ``step_complete`` / ``answer``
    / ``output_submit`` / ``lesson_complete`` / ``drop``（CHECK）；
  - ``step_id``：可空（``lesson_start`` 等无步骤事件）；
  - ``payload_json``：可空小对象，JSON 文本；应用层限制 ≤2KB；
  - ``created_at``：服务端毫秒 UTC；
  - ``ix_course_events_attempt(attempt_id, created_at)``：按 attempt 重放；
  - ``ix_course_events_user_event(user_id, event, created_at)``：按用户看事件。

downgrade 按依赖反向删表（先 events，再 attempts），只用于空库/测试回滚。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0021_course_mvp"
down_revision: str = "0020_content_teaching_analysis"
branch_labels: str | None = None
depends_on: str | None = None

ATTEMPTS = "course_attempts"
EVENTS = "course_events"

INDEX_ATTEMPTS_USER_UPDATED = "ix_course_attempts_user_updated"
INDEX_ATTEMPTS_LESSON_STATUS = "ix_course_attempts_lesson_status"
UNIQUE_ATTEMPTS_IN_PROGRESS = "ux_course_attempts_in_progress"
INDEX_EVENTS_ATTEMPT = "ix_course_events_attempt"
INDEX_EVENTS_USER_EVENT = "ix_course_events_user_event"

# 迁移是历史快照：字面量写死，不 import 运行时代码。
ATTEMPT_STATUSES = ("in_progress", "completed", "abandoned")
EVENT_TYPES = (
    "lesson_start",
    "step_view",
    "step_complete",
    "answer",
    "output_submit",
    "lesson_complete",
    "drop",
)


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {index["name"] for index in inspector.get_indexes(table)}


def _in_check(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{value}'" for value in values) + ")"


def upgrade() -> None:
    """建课程尝试/事件两张表 + 索引（幂等，不碰旧表）。"""
    tables = _table_names()

    if ATTEMPTS not in tables:
        op.create_table(
            ATTEMPTS,
            sa.Column("id", sa.Text(), primary_key=True, nullable=False),
            # 需登录：正常只写 users.id；保留 TEXT 形状与其它学习数据一致。
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("lesson_id", sa.Text(), nullable=False),
            sa.Column("lesson_version", sa.Integer(), nullable=False),
            sa.Column(
                "status",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'in_progress'"),
            ),
            sa.Column(
                "current_step_id",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'S0'"),
            ),
            sa.Column(
                "answers_json",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'{}'"),
            ),
            sa.Column(
                "output_text",
                sa.Text(),
                nullable=False,
                server_default=sa.text("''"),
            ),
            sa.Column("score", sa.Integer(), nullable=True),
            sa.Column("total", sa.Integer(), nullable=True),
            sa.Column("started_at", sa.Integer(), nullable=False),
            sa.Column("updated_at", sa.Integer(), nullable=False),
            sa.Column("completed_at", sa.Integer(), nullable=True),
            sa.CheckConstraint(
                _in_check("status", ATTEMPT_STATUSES),
                name="ck_course_attempts_status",
            ),
            sa.CheckConstraint(
                "score IS NULL OR score >= 0",
                name="ck_course_attempts_score",
            ),
            sa.CheckConstraint(
                "total IS NULL OR total >= 0",
                name="ck_course_attempts_total",
            ),
        )

    attempt_indexes = _index_names(ATTEMPTS)
    if INDEX_ATTEMPTS_USER_UPDATED not in attempt_indexes:
        op.create_index(
            INDEX_ATTEMPTS_USER_UPDATED, ATTEMPTS, ["user_id", "updated_at"]
        )
    if INDEX_ATTEMPTS_LESSON_STATUS not in attempt_indexes:
        op.create_index(
            INDEX_ATTEMPTS_LESSON_STATUS, ATTEMPTS, ["lesson_id", "status"]
        )
    # 同一用户同一课程最多一条 in_progress；完成/放弃的历史可以并存。
    if UNIQUE_ATTEMPTS_IN_PROGRESS not in attempt_indexes:
        op.create_index(
            UNIQUE_ATTEMPTS_IN_PROGRESS,
            ATTEMPTS,
            ["user_id", "lesson_id"],
            unique=True,
            sqlite_where=sa.text("status = 'in_progress'"),
        )

    if EVENTS not in tables:
        op.create_table(
            EVENTS,
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("attempt_id", sa.Text(), nullable=False),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("event", sa.Text(), nullable=False),
            sa.Column("step_id", sa.Text(), nullable=True),
            # 严格 JSON 文本；不用 sa.JSON，避免 SQLite 亲和类型改写内容。
            sa.Column("payload_json", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Integer(), nullable=False),
            sa.CheckConstraint(
                _in_check("event", EVENT_TYPES),
                name="ck_course_events_event",
            ),
            sa.ForeignKeyConstraint(
                ["attempt_id"],
                [f"{ATTEMPTS}.id"],
                name="fk_course_events_attempt",
                ondelete="CASCADE",
            ),
        )

    event_indexes = _index_names(EVENTS)
    if INDEX_EVENTS_ATTEMPT not in event_indexes:
        op.create_index(
            INDEX_EVENTS_ATTEMPT, EVENTS, ["attempt_id", "created_at"]
        )
    if INDEX_EVENTS_USER_EVENT not in event_indexes:
        op.create_index(
            INDEX_EVENTS_USER_EVENT, EVENTS, ["user_id", "event", "created_at"]
        )


def downgrade() -> None:
    """只删本迁移的两张表（索引随表删除）；不碰 0020 及更早的表。"""
    tables = _table_names()
    if EVENTS in tables:
        op.drop_table(EVENTS)
    if ATTEMPTS in tables:
        op.drop_table(ATTEMPTS)
