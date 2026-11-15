"""复习引擎：词状态 + 复习日志 + 词来源（计划书 §13.2 M2）

Revision ID: 0006_review_engine
Revises: 0005_jobs
Create Date: 2026-11-15

M2 把「收藏夹」升级成可调度的记忆系统。本迁移只建表/索引，运行时不建表
（``backend/srs.py`` 只读写；表缺失时返回 503 并提示先跑迁移）。

三张表：

- ``word_states``：每个用户每个词（按目标语言分开）一条**当前状态**，是复习
  调度的真源。换设备登录后队列一致，靠的就是它而不是前端 localStorage。
  - ``state``：``new`` / ``learning`` / ``review`` / ``relearning`` /
    ``suspended``，CHECK 兜底；
  - ``due_at`` / ``last_reviewed_at`` / ``created_at``：**毫秒 UTC 时间戳**，
    展示时区交给前端；
  - ``stability`` / ``difficulty``：FSRS-6 的两个核心参数；
  - ``reps`` / ``lapses``：总复习次数 / 累计 Again 次数；
  - ``step``（内部列）：FSRS 学习/重学阶段的子日 step（1 分钟 / 10 分钟）。
    任务书列出的字段没有它，但没有 step 就无法从库里恢复 10 分钟这一档，
    所以作为内部列显式保留；
  - ``fail_streak``（内部列）：连续 Again 次数。达到 3 自动 suspended；
    手工恢复时清零。没有它就只能靠日志推断，恢复后会立刻被旧日志再次判死。
  - UNIQUE(user_id, lemma, target_lang) + (user_id, due_at) 索引；
  - ``lemma`` 由 ``srs.add_word`` 规范为 NFC + 小写，词形大小写不产生重复。

- ``review_logs``：append-only 的复习流水。每次作答一行，``state_before`` /
  ``state_after`` 存当时的完整状态快照（JSON 文本），既作审计也方便以后
  重算参数；``rating`` 只有 again/hard/good/easy，CHECK 兜底。

- ``word_sources``：这个词从哪来（YouTube videoId / 本地剧集 / 文章 + 句子）。
  一个词可以有多个来源；同来源重复添加由 ``srs.add_word`` 幂等去重。表内没有
  业务主键，SQLite 隐式 rowid 足够；索引 ``word_state_id`` 供按词回查。
  外键指向 ``word_states.id``（ON DELETE CASCADE），连接上开启
  ``PRAGMA foreign_keys=ON`` 时生效。

downgrade 按依赖反向删表，只用于空库/测试回滚。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0006_review_engine"
down_revision: str = "0005_jobs"
branch_labels: str | None = None
depends_on: str | None = None

WORD_STATES = "word_states"
REVIEW_LOGS = "review_logs"
WORD_SOURCES = "word_sources"

INDEX_WORD_USER_DUE = "ix_word_states_user_due"
INDEX_LOG_USER_REVIEWED = "ix_review_logs_user_reviewed"
INDEX_SOURCE_WORD = "ix_word_sources_word_state"
UNIQUE_WORD = "ux_word_states_user_lemma_lang"

# 迁移是历史快照：字面量写死，不 import 运行时代码（改常量不该改旧迁移）。
STATES = ("new", "learning", "review", "relearning", "suspended")
RATINGS = ("again", "hard", "good", "easy")


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    return {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(table)}


def _state_check() -> str:
    return "state IN (" + ", ".join(f"'{state}'" for state in STATES) + ")"


def _rating_check() -> str:
    return "rating IN (" + ", ".join(f"'{rating}'" for rating in RATINGS) + ")"


def upgrade() -> None:
    """建三张表与索引（幂等：已存在就跳过）。"""
    tables = _table_names()

    if WORD_STATES not in tables:
        op.create_table(
            WORD_STATES,
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("lemma", sa.Text(), nullable=False),
            sa.Column(
                "target_lang",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'zh-CN'"),
            ),
            sa.Column(
                "state",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'new'"),
            ),
            sa.Column("due_at", sa.Integer(), nullable=False),
            sa.Column("stability", sa.Float(), nullable=True),
            sa.Column("difficulty", sa.Float(), nullable=True),
            sa.Column(
                "reps",
                sa.Integer(),
                nullable=False,
                server_default=sa.text("0"),
            ),
            sa.Column(
                "lapses",
                sa.Integer(),
                nullable=False,
                server_default=sa.text("0"),
            ),
            # 内部列：FSRS 子日 step 与连续失败计数（见模块 docstring）。
            sa.Column(
                "step",
                sa.Integer(),
                nullable=False,
                server_default=sa.text("0"),
            ),
            sa.Column(
                "fail_streak",
                sa.Integer(),
                nullable=False,
                server_default=sa.text("0"),
            ),
            sa.Column("last_reviewed_at", sa.Integer(), nullable=True),
            sa.Column("created_at", sa.Integer(), nullable=False),
            sa.CheckConstraint(_state_check(), name="ck_word_states_state"),
            sa.UniqueConstraint(
                "user_id", "lemma", "target_lang", name=UNIQUE_WORD
            ),
        )

    indexes = _index_names(WORD_STATES)
    if INDEX_WORD_USER_DUE not in indexes:
        # 到期队列的主查询路径：WHERE user_id=? AND state IN (...) AND due_at<=?
        op.create_index(INDEX_WORD_USER_DUE, WORD_STATES, ["user_id", "due_at"])

    if REVIEW_LOGS not in tables:
        op.create_table(
            REVIEW_LOGS,
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("lemma", sa.Text(), nullable=False),
            sa.Column(
                "target_lang",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'zh-CN'"),
            ),
            sa.Column("rating", sa.Text(), nullable=False),
            sa.Column("state_before", sa.Text(), nullable=False),
            sa.Column("state_after", sa.Text(), nullable=False),
            sa.Column("reviewed_at", sa.Integer(), nullable=False),
            sa.Column("elapsed_ms", sa.Integer(), nullable=True),
            sa.CheckConstraint(_rating_check(), name="ck_review_logs_rating"),
        )

    indexes = _index_names(REVIEW_LOGS)
    if INDEX_LOG_USER_REVIEWED not in indexes:
        op.create_index(
            INDEX_LOG_USER_REVIEWED, REVIEW_LOGS, ["user_id", "reviewed_at"]
        )

    if WORD_SOURCES not in tables:
        op.create_table(
            WORD_SOURCES,
            sa.Column(
                "word_state_id",
                sa.Text(),
                sa.ForeignKey(f"{WORD_STATES}.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("content_ref", sa.Text(), nullable=True),
            sa.Column("sentence_id", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Integer(), nullable=False),
        )

    indexes = _index_names(WORD_SOURCES)
    if INDEX_SOURCE_WORD not in indexes:
        op.create_index(INDEX_SOURCE_WORD, WORD_SOURCES, ["word_state_id"])


def downgrade() -> None:
    """按依赖反向删表（索引随表删除）；仅限空库/测试回滚。"""
    tables = _table_names()
    for table in (WORD_SOURCES, REVIEW_LOGS, WORD_STATES):
        if table in tables:
            op.drop_table(table)
