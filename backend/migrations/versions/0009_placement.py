"""placement：能力定位测试会话 / 作答 / 能力画像（计划书 §13.2 M4 / specs/016）

Revision ID: 0009_placement
Revises: 0008_weekly_report
Create Date: 2026-11-15

M4 的第一块后端：一次 12 分钟定位测（24 词汇 + 5 阅读 + 3 伪词）的会话、逐题
作答流水与「当前能力画像」。本迁移只建三张表 + 索引，运行时不建表；表缺失时
``placement.py`` 抛 ``PlacementUnavailable``、路由返回 503 并提示先跑迁移。

三张表：

- ``placement_sessions``：一次测试的会话。
  - ``id``：TEXT PK（uuid4 hex，由应用生成；同一会话 start/submit 共用）；
  - ``user_id``：**归属键**。登录用户 = ``users.id``；游客 = ``guest:<sha256>``
    （``guest.guest_id()`` 的形状），与 ``watch_events`` 同一套口径；
  - ``guest_hash``：游客 sha256（登录用户 NULL），保留给以后游客认领迁移；
  - ``status``：``in_progress`` / ``submitted`` / ``abandoned``（CHECK）；
  - ``started_at`` / ``submitted_at``：服务端毫秒 UTC；
  - ``duration_ms``：客户端上报的用时，CHECK 0–86400000（24h）；
  - ``score``：0–100 加权得分（REAL；伪词不计分）；
  - ``cefr``：区间标签（如 ``A2–B2``，en dash），由应用写；
  - ``confidence``：0–1，CHECK；
  - ``breakdown``：完整结果 JSON 文本（维度明细/强弱项/建议/样本口径），不用
    SQLite 的 JSON 亲和类型，避免数字/字符串往返被改写；
  - 部分唯一索引 ``ux_placement_sessions_active``：同一 ``user_id`` 最多一个
    ``in_progress`` 会话，保证「未完成会话复用」在并发下也成立；已提交/已作废
    的历史会话可以并存（同一用户可重测）。

- ``placement_answers``：一次会话的逐题作答（提交时一次写入整卷 32 行，跳过
  记 ``chosen_index=-1``；不提供更新/删除入口）。
  - ``session_id`` → ``placement_sessions.id``，**ON DELETE CASCADE**；
  - ``item_id``：题库银行 id（如 ``v-012`` / ``r-03``；不是对外的会话内
    ``q-01``，便于审计与复算）；
  - ``item_type``：``vocab`` / ``reading`` / ``pseudo``（CHECK）；
  - ``chosen_index``：``-1``（不认识/跳过）或 0–3（CHECK）；
  - ``correct``：0/1（伪词恒 0；CHECK）；
  - ``difficulty_band``：``A1``–``C1``（CHECK）；
  - ``answered_at``：服务端毫秒 UTC；
  - ``UNIQUE(session_id, item_id)``：同一会话同一题只落一行，重复提交由应用层
    先拦（幂等返回），数据库兜底防并发双写。

- ``user_profiles``：当前能力画像（每个归属键一行，最新一次定位测覆盖）。
  - ``user_id``：TEXT PK（登录用户 id 或 ``guest:<sha256>``）；
  - ``cefr`` / ``level_band_low`` / ``level_band_high``：区间标签与上下带；
  - ``vocab_estimate``：约词汇量（INTEGER，按 lemma 的粗略估计，UI 带「约」）；
  - ``reading_estimate``：阅读带（A1–C1；本轮不承诺考试分数）；
  - ``confidence``：0–1，CHECK；
  - ``pseudo_word_suspicion``：0–1，伪词过度声称比例（CHECK）；
  - ``updated_at``：服务端毫秒 UTC；
  - ``source``：``placement`` / ``user_edit``（CHECK；本轮只写 placement）。

downgrade 按依赖反向删表（先 answers，再 sessions，最后 profiles），只用于空库/
测试回滚。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0009_placement"
down_revision: str = "0008_weekly_report"
branch_labels: str | None = None
depends_on: str | None = None

SESSIONS = "placement_sessions"
ANSWERS = "placement_answers"
PROFILES = "user_profiles"

INDEX_SESSIONS_USER_STARTED = "ix_placement_sessions_user_started"
UNIQUE_SESSIONS_ACTIVE = "ux_placement_sessions_active"
UNIQUE_ANSWERS_SESSION_ITEM = "ux_placement_answers_session_item"

# 迁移是历史快照：字面量写死，不 import 运行时代码。
CEFR_BANDS = ("A1", "A2", "B1", "B2", "C1")
SESSION_STATUSES = ("in_progress", "submitted", "abandoned")
ITEM_TYPES = ("vocab", "reading", "pseudo")
PROFILE_SOURCES = ("placement", "user_edit")
MAX_DURATION_MS = 86_400_000


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    return {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(table)}


def _in_check(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{value}'" for value in values) + ")"


def upgrade() -> None:
    """建 placement_sessions / placement_answers / user_profiles 与索引（幂等）。"""
    tables = _table_names()

    if SESSIONS not in tables:
        op.create_table(
            SESSIONS,
            sa.Column("id", sa.Text(), primary_key=True, nullable=False),
            # 归属键：登录用户 id 或 guest:<sha256>；游客也写 user_id，保证隔离与
            # 样本计数口径一致，guest_hash 只作为补充身份。
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("guest_hash", sa.Text(), nullable=True),
            sa.Column(
                "status",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'in_progress'"),
            ),
            sa.Column("started_at", sa.Integer(), nullable=False),
            sa.Column("submitted_at", sa.Integer(), nullable=True),
            sa.Column("duration_ms", sa.Integer(), nullable=True),
            sa.Column("score", sa.Float(), nullable=True),
            sa.Column("cefr", sa.Text(), nullable=True),
            sa.Column("confidence", sa.Float(), nullable=True),
            # 完整结果 JSON 文本；不用 sa.JSON，避免 SQLite 亲和类型改写内容。
            sa.Column("breakdown", sa.Text(), nullable=True),
            sa.CheckConstraint(
                _in_check("status", SESSION_STATUSES),
                name="ck_placement_sessions_status",
            ),
            sa.CheckConstraint(
                f"duration_ms IS NULL OR duration_ms BETWEEN 0 AND {MAX_DURATION_MS}",
                name="ck_placement_sessions_duration",
            ),
            sa.CheckConstraint(
                "confidence IS NULL OR confidence BETWEEN 0 AND 1",
                name="ck_placement_sessions_confidence",
            ),
        )

    indexes = _index_names(SESSIONS)
    if INDEX_SESSIONS_USER_STARTED not in indexes:
        op.create_index(
            INDEX_SESSIONS_USER_STARTED, SESSIONS, ["user_id", "started_at"]
        )
    # 同一归属最多一个未完成会话；已完成/已作废的历史可以并存（允许重测）。
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
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("session_id", sa.Text(), nullable=False),
            sa.Column("item_id", sa.Text(), nullable=False),
            sa.Column("item_type", sa.Text(), nullable=False),
            sa.Column("chosen_index", sa.Integer(), nullable=False),
            sa.Column("correct", sa.Integer(), nullable=False),
            sa.Column("difficulty_band", sa.Text(), nullable=False),
            sa.Column("answered_at", sa.Integer(), nullable=False),
            sa.ForeignKeyConstraint(
                ["session_id"],
                [f"{SESSIONS}.id"],
                name="fk_placement_answers_session",
                ondelete="CASCADE",
            ),
            sa.CheckConstraint(
                _in_check("item_type", ITEM_TYPES),
                name="ck_placement_answers_item_type",
            ),
            # -1 = 不认识/跳过；0–3 = 四个选项。
            sa.CheckConstraint(
                "chosen_index BETWEEN -1 AND 3",
                name="ck_placement_answers_chosen_index",
            ),
            sa.CheckConstraint(
                "correct IN (0, 1)", name="ck_placement_answers_correct"
            ),
            sa.CheckConstraint(
                _in_check("difficulty_band", CEFR_BANDS),
                name="ck_placement_answers_band",
            ),
            sa.UniqueConstraint(
                "session_id",
                "item_id",
                name=UNIQUE_ANSWERS_SESSION_ITEM,
            ),
        )

    if PROFILES not in tables:
        op.create_table(
            PROFILES,
            sa.Column("user_id", sa.Text(), primary_key=True, nullable=False),
            sa.Column("cefr", sa.Text(), nullable=False),
            sa.Column("level_band_low", sa.Text(), nullable=False),
            sa.Column("level_band_high", sa.Text(), nullable=False),
            sa.Column("vocab_estimate", sa.Integer(), nullable=True),
            sa.Column("reading_estimate", sa.Text(), nullable=True),
            sa.Column("confidence", sa.Float(), nullable=False),
            sa.Column(
                "pseudo_word_suspicion",
                sa.Float(),
                nullable=False,
                server_default=sa.text("0"),
            ),
            sa.Column("updated_at", sa.Integer(), nullable=False),
            sa.Column(
                "source",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'placement'"),
            ),
            sa.CheckConstraint(
                _in_check("level_band_low", CEFR_BANDS),
                name="ck_user_profiles_low",
            ),
            sa.CheckConstraint(
                _in_check("level_band_high", CEFR_BANDS),
                name="ck_user_profiles_high",
            ),
            sa.CheckConstraint(
                "reading_estimate IS NULL OR "
                + _in_check("reading_estimate", CEFR_BANDS),
                name="ck_user_profiles_reading",
            ),
            sa.CheckConstraint(
                "vocab_estimate IS NULL OR vocab_estimate >= 0",
                name="ck_user_profiles_vocab_estimate",
            ),
            sa.CheckConstraint(
                "confidence BETWEEN 0 AND 1",
                name="ck_user_profiles_confidence",
            ),
            sa.CheckConstraint(
                "pseudo_word_suspicion BETWEEN 0 AND 1",
                name="ck_user_profiles_pseudo",
            ),
            sa.CheckConstraint(
                _in_check("source", PROFILE_SOURCES),
                name="ck_user_profiles_source",
            ),
        )


def downgrade() -> None:
    """按依赖反向删表（索引随表删除）；仅限空库/测试回滚。"""
    tables = _table_names()
    for table in (ANSWERS, SESSIONS, PROFILES):
        if table in tables:
            op.drop_table(table)
