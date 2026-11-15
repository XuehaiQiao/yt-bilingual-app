"""exam：考试练习会话 / 逐题作答（V2 用户需求 #11 / specs/022）

Revision ID: 0012_exam
Revises: 0011_reading
Create Date: 2026-11-15

V2「考试练习」后端的存储层：用户从静态题库做 10 道词汇/语法/阅读题，提交后
只看逐题对错与解析。**不存题库、不存分数/预测结果**：题库是随仓库分发的
``content/exam/cet4.json``，评分结果按题库与作答行可重算。本迁移只建两张表 +
索引，运行时不建表；表缺失时 ``backend/exam.py`` 抛 ``ExamUnavailable``，路由
返回 503 并提示先跑迁移。

两张表：

- ``exam_sessions``：一次练习会话。
  - ``id``：TEXT PK（uuid4 hex，由应用生成；start/submit 共用）；
  - ``user_id``：归属键，登录用户的 ``users.id``（考试练习需登录，游客不写）；
  - ``exam_type``：题型 id（当前只有 ``cet4``；应用层校验，不加 CHECK 以便
    后续加题型时不必改表）；
  - ``status``：``in_progress`` / ``submitted``（CHECK）；
  - ``item_ids``：本次卷面的题库 id JSON 数组（保序；提交时据此重建卷面，
    不保存题干/答案）；
  - ``started_at``：服务端毫秒 UTC；
  - ``submitted_at`` / ``duration_ms``：首次提交时写入；``duration_ms`` CHECK
    0–86400000（24h），重复提交不覆盖；
  - ``ix_exam_sessions_user_started(user_id, started_at)``：会话查询；
  - ``ix_exam_sessions_user_submitted(user_id, submitted_at)``：历史列表按
    提交时间倒序；
  - 部分唯一索引 ``ux_exam_sessions_active``：同一用户最多一个 ``in_progress``
    会话，保证「未提交会话复用」在并发下也成立；已提交历史可以并存。

- ``exam_answers``：一次会话的逐题作答（只存**已作答**的题；未答题由 item_ids
  与本题集之差得出，不在表里写空行）。append-only，不提供更新/删除入口。
  - ``session_id`` → ``exam_sessions.id``，**ON DELETE CASCADE**；
  - ``item_id``：题库 id（如 ``v-001`` / ``r-003``）；
  - ``chosen_index``：0–3（CHECK；保证 4 选 1 的合法下标）；
  - ``correct``：0/1（CHECK）；
  - ``answered_at``：服务端毫秒 UTC；
  - ``PRIMARY KEY(session_id, item_id)``：同一会话同一题只落一行，重复提交由
    应用层先拦（幂等返回），数据库兜底防并发双写。

downgrade 按依赖反向删表（先 answers，再 sessions），只用于空库/测试回滚。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0012_exam"
down_revision: str = "0011_reading"
branch_labels: str | None = None
depends_on: str | None = None

SESSIONS = "exam_sessions"
ANSWERS = "exam_answers"

INDEX_SESSIONS_USER_STARTED = "ix_exam_sessions_user_started"
INDEX_SESSIONS_USER_SUBMITTED = "ix_exam_sessions_user_submitted"
UNIQUE_SESSIONS_ACTIVE = "ux_exam_sessions_active"

# 迁移是历史快照：字面量写死，不 import 运行时代码。
SESSION_STATUSES = ("in_progress", "submitted")
MAX_DURATION_MS = 86_400_000


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    return {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(table)}


def _in_check(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{value}'" for value in values) + ")"


def upgrade() -> None:
    """建考试练习两张表 + 索引（幂等，不碰旧表）。"""
    tables = _table_names()

    if SESSIONS not in tables:
        op.create_table(
            SESSIONS,
            sa.Column("id", sa.Text(), primary_key=True, nullable=False),
            # 需登录：正常只写 users.id；保留 TEXT 形状与其它学习数据一致。
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("exam_type", sa.Text(), nullable=False),
            sa.Column(
                "status",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'in_progress'"),
            ),
            # 本次卷面的题库 id 数组（JSON 文本）；不存题干/答案。
            sa.Column("item_ids", sa.Text(), nullable=False),
            sa.Column("started_at", sa.Integer(), nullable=False),
            sa.Column("submitted_at", sa.Integer(), nullable=True),
            sa.Column("duration_ms", sa.Integer(), nullable=True),
            sa.CheckConstraint(
                _in_check("status", SESSION_STATUSES),
                name="ck_exam_sessions_status",
            ),
            sa.CheckConstraint(
                f"duration_ms IS NULL OR duration_ms BETWEEN 0 AND {MAX_DURATION_MS}",
                name="ck_exam_sessions_duration",
            ),
        )

    indexes = _index_names(SESSIONS)
    if INDEX_SESSIONS_USER_STARTED not in indexes:
        op.create_index(
            INDEX_SESSIONS_USER_STARTED, SESSIONS, ["user_id", "started_at"]
        )
    if INDEX_SESSIONS_USER_SUBMITTED not in indexes:
        op.create_index(
            INDEX_SESSIONS_USER_SUBMITTED, SESSIONS, ["user_id", "submitted_at"]
        )
    # 同一用户最多一个未提交会话；已提交历史可以并存（允许反复练习）。
    if UNIQUE_SESSIONS_ACTIVE not in indexes:
        op.create_index(
            UNIQUE_SESSIONS_ACTIVE,
            SESSIONS,
            ["user_id"],
            unique=True,
            sqlite_where=sa.text("status = 'in_progress'"),
        )

    if ANSWERS not in tables:
        op.create_table(
            ANSWERS,
            sa.Column("session_id", sa.Text(), nullable=False),
            sa.Column("item_id", sa.Text(), nullable=False),
            sa.Column("chosen_index", sa.Integer(), nullable=False),
            sa.Column("correct", sa.Integer(), nullable=False),
            sa.Column("answered_at", sa.Integer(), nullable=False),
            sa.ForeignKeyConstraint(
                ["session_id"],
                [f"{SESSIONS}.id"],
                name="fk_exam_answers_session",
                ondelete="CASCADE",
            ),
            sa.CheckConstraint(
                "chosen_index BETWEEN 0 AND 3",
                name="ck_exam_answers_chosen_index",
            ),
            sa.CheckConstraint(
                "correct IN (0, 1)", name="ck_exam_answers_correct"
            ),
            sa.PrimaryKeyConstraint("session_id", "item_id"),
        )


def downgrade() -> None:
    """按依赖反向删表（索引随表删除）；仅限空库/测试回滚。"""
    tables = _table_names()
    for table in (ANSWERS, SESSIONS):
        if table in tables:
            op.drop_table(table)
