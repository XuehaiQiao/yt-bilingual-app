"""quiz：内容项 + 理解题 + 作答记录（计划书 §13.2 M3 / specs/014）

Revision ID: 0007_quiz
Revises: 0006_review_engine
Create Date: 2026-11-15

M3 的第一块后端：看完一个已有双语字幕的视频/本地剧集后，生成 3 道英文
理解题（选择题 / 判断题），每道题引用一个具体字幕 block 作为证据；用户作答
可判分并回跳证据时间点。本迁移只建三张表 + 索引，运行时不建表
（``backend/quiz.py`` 只读写；表缺失时路由返回 503 并提示先跑迁移）。

三张表：

- ``content_items``：**每个用户每条内容一条**。视频/本地剧集统一到同一张
  表（计划书 S3 的 ``content_items`` 在 M3 的落地子集）。
  - ``kind``：``video`` / ``local_show``，CHECK 兜底；
  - ``content_ref``：视频 videoId 或本地剧集规范引用
    ``<show_id>-S01E01``（见 ``backend/quiz.py``）；
  - ``content_hash``：字幕正文 + 起止毫秒的规范化 sha256 前 32 个十六进制位
    （不依赖 per-user JSON 的 block id），缓存键的一部分；
  - ``prompt_version``：**内部列**（任务书字段清单之外）。M3 的缓存键是
    ``(content_hash, prompt_version)``；没有这一列就无法在 prompt 升级后
    自动失效缓存。不对外暴露；
  - ``status``：``draft``（未生成 / 全部题被 QC 拒绝）/ ``ready``（有可用题）；
  - ``UNIQUE(user_id, content_ref, target_lang)``：同一用户同一内容同一
    目标语言只有一条内容项。计划书 D-7 默认 private，题目跨用户不共享。

- ``questions``：一题一行。``ordinal`` 是展示顺序（1..N，通常 3）。
  - ``question_type``：``mcq``（4 选 1）/ ``tf``（True/False），CHECK 兜底；
  - ``options``：JSON 数组文本（mcq 4 项、tf 2 项），不用 SQLite JSON 亲和
    类型，避免数字型选项被 NUMERIC 亲和改写；
  - ``answer_index``：0 基下标；``rejected`` 行可能是 -1（没有合法答案），
    所以这里不加 CHECK；
  - ``evidence_block_id`` / ``evidence_start`` / ``evidence_end``：证据 block
    与起止时间。时间统一**毫秒**（与计划书 S23 的 ``start_ms`` 口径一致；
    HTTP 响应同时给秒与毫秒，前端按播放器需要取）。rejected 行可以没有证据，
    所以三列可空；
  - ``status``：``draft`` / ``approved`` / ``rejected``。两道闸不通过的题以
    ``rejected`` 落库（保留 QC 证据、避免下次重复花钱），不返回给用户；
  - ``model``：生成该题的模型 id（成本/质量追溯）；
  - 索引 ``ix_questions_content_item``：按内容项取题的主查询路径。

- ``attempts``：append-only 的作答流水（只 INSERT / SELECT）。
  - ``user_id`` / ``question_id`` / ``chosen_index`` / ``is_correct`` /
    ``answered_at``（毫秒 UTC）/ ``elapsed_ms``（可空）；
  - 索引 ``ix_attempts_user_answered``（用户 + 时间）与
    ``ix_attempts_question``（按题回查/结果统计）；
  - 外键指向 ``questions.id``（ON DELETE CASCADE），连接开启
    ``PRAGMA foreign_keys=ON`` 时生效。

downgrade 按依赖反向删表（先 attempts，再 questions，最后 content_items），
只用于空库/测试回滚。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0007_quiz"
down_revision: str = "0006_review_engine"
branch_labels: str | None = None
depends_on: str | None = None

CONTENT_ITEMS = "content_items"
QUESTIONS = "questions"
ATTEMPTS = "attempts"

UNIQUE_CONTENT_ITEM = "ux_content_items_user_ref_lang"
INDEX_QUESTION_ITEM = "ix_questions_content_item"
INDEX_ATTEMPT_USER_ANSWERED = "ix_attempts_user_answered"
INDEX_ATTEMPT_QUESTION = "ix_attempts_question"

# 迁移是历史快照：字面量写死，不 import 运行时代码。
KINDS = ("video", "local_show")
CONTENT_STATUSES = ("draft", "ready")
QUESTION_TYPES = ("mcq", "tf")
QUESTION_STATUSES = ("draft", "approved", "rejected")
DEFAULT_PROMPT_VERSION = "quiz.v1"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    return {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(table)}


def _in_check(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{value}'" for value in values) + ")"


def upgrade() -> None:
    """建 content_items / questions / attempts 与索引（幂等）。"""
    tables = _table_names()

    if CONTENT_ITEMS not in tables:
        op.create_table(
            CONTENT_ITEMS,
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("kind", sa.Text(), nullable=False),
            sa.Column("content_ref", sa.Text(), nullable=False),
            sa.Column(
                "target_lang",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'zh-CN'"),
            ),
            sa.Column("content_hash", sa.Text(), nullable=False),
            sa.Column(
                "title", sa.Text(), nullable=False, server_default=sa.text("''")
            ),
            sa.Column(
                "status",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'draft'"),
            ),
            # 内部列：M3 缓存键的第二维 (content_hash, prompt_version)。
            sa.Column(
                "prompt_version",
                sa.Text(),
                nullable=False,
                server_default=sa.text(f"'{DEFAULT_PROMPT_VERSION}'"),
            ),
            sa.Column("created_at", sa.Integer(), nullable=False),
            sa.CheckConstraint(_in_check("kind", KINDS), name="ck_content_items_kind"),
            sa.CheckConstraint(
                _in_check("status", CONTENT_STATUSES),
                name="ck_content_items_status",
            ),
            sa.UniqueConstraint(
                "user_id", "content_ref", "target_lang", name=UNIQUE_CONTENT_ITEM
            ),
        )

    if QUESTIONS not in tables:
        op.create_table(
            QUESTIONS,
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column(
                "content_item_id",
                sa.Text(),
                sa.ForeignKey(f"{CONTENT_ITEMS}.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("ordinal", sa.Integer(), nullable=False),
            sa.Column("question_type", sa.Text(), nullable=False),
            sa.Column("prompt", sa.Text(), nullable=False),
            # JSON 数组文本；不用 sa.JSON，避免 SQLite 亲和类型改写内容。
            sa.Column("options", sa.Text(), nullable=False),
            sa.Column("answer_index", sa.Integer(), nullable=False),
            sa.Column("evidence_block_id", sa.Text(), nullable=True),
            sa.Column("evidence_start", sa.Integer(), nullable=True),
            sa.Column("evidence_end", sa.Integer(), nullable=True),
            sa.Column(
                "explanation", sa.Text(), nullable=False, server_default=sa.text("''")
            ),
            sa.Column(
                "status",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'draft'"),
            ),
            sa.Column("model", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Integer(), nullable=False),
            sa.CheckConstraint(
                _in_check("question_type", QUESTION_TYPES),
                name="ck_questions_type",
            ),
            sa.CheckConstraint(
                _in_check("status", QUESTION_STATUSES),
                name="ck_questions_status",
            ),
        )

    indexes = _index_names(QUESTIONS)
    if INDEX_QUESTION_ITEM not in indexes:
        op.create_index(INDEX_QUESTION_ITEM, QUESTIONS, ["content_item_id"])

    if ATTEMPTS not in tables:
        op.create_table(
            ATTEMPTS,
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column(
                "question_id",
                sa.Text(),
                sa.ForeignKey(f"{QUESTIONS}.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("chosen_index", sa.Integer(), nullable=False),
            sa.Column("is_correct", sa.Integer(), nullable=False),
            sa.Column("answered_at", sa.Integer(), nullable=False),
            sa.Column("elapsed_ms", sa.Integer(), nullable=True),
            sa.CheckConstraint("is_correct IN (0, 1)", name="ck_attempts_correct"),
        )

    indexes = _index_names(ATTEMPTS)
    if INDEX_ATTEMPT_USER_ANSWERED not in indexes:
        op.create_index(
            INDEX_ATTEMPT_USER_ANSWERED, ATTEMPTS, ["user_id", "answered_at"]
        )
    if INDEX_ATTEMPT_QUESTION not in indexes:
        op.create_index(INDEX_ATTEMPT_QUESTION, ATTEMPTS, ["question_id"])


def downgrade() -> None:
    """按依赖反向删表（索引随表删除）；仅限空库/测试回滚。"""
    tables = _table_names()
    for table in (ATTEMPTS, QUESTIONS, CONTENT_ITEMS):
        if table in tables:
            op.drop_table(table)
