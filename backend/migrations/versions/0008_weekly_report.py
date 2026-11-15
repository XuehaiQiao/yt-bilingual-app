"""weekly_report：观看事件 + 周报快照（计划书 §13.2 M5 / §15）

Revision ID: 0008_weekly_report
Revises: 0007_quiz
Create Date: 2026-11-15

M5 的第一块后端：前端上报「看了多久 / 看了哪个内容」，服务端按 UTC 周
聚合出「3 个数字 + 1 句事实 + 1 个下一步 + 1 段可回看证据」。本迁移只建
两张表 + 索引，运行时不建表（``backend/reports.py`` 只读写；表缺失时路由
返回 503 并提示先跑迁移）。

两张表：

- ``watch_events``：append-only 的观看事件流水。
  - ``user_id``：**归属键**。登录用户是 users.id；游客是 ``guest:<sha256>``
    （``guest.guest_id()`` 的形状），这样 ``UNIQUE(user_id, client_event_id)``
    对游客同样生效，不会因为没有账号而失去幂等性；
  - ``guest_hash``：游客的 sha256（登录用户为 NULL），保留给以后「游客认领
    账号」时把事件迁移到 user_id，查询归属仍只看 user_id；
  - ``content_ref``：视频 videoId 或本地剧集规范引用 ``<show_id>-S01E01``；
  - ``kind``：``video`` / ``local_show``，CHECK 兜底；
  - ``watched_seconds`` / ``position_seconds``：秒，CHECK 限制 0–86400；
  - ``occurred_at``：客户端毫秒 UTC 时间戳；
  - ``client_event_id``：客户端生成的幂等键；
  - ``UNIQUE(user_id, client_event_id)``：同一归属下重复上报只落一行；
  - 索引 ``ix_watch_events_user_occurred(user_id, occurred_at)``：周报聚合
    与连续学习天数的唯一查询路径。

- ``weekly_reports``：周报快照（站内页/未来邮件共用）。
  - ``user_id``：归属键（同上，游客也是 ``guest:<sha256>``）；
  - ``week_start``：DATE，UTC 周一；
  - ``payload``：完整周报 JSON 文本（版本号 + 生成时间 + 报告本体），不用
    SQLite 的 JSON 亲和类型，避免数字/字符串往返被改写；
  - ``created_at``：服务端毫秒 UTC；
  - ``UNIQUE(user_id, week_start)``：同一用户同一周只留一份快照（应用层
    ``INSERT OR IGNORE``，先写为准）。

downgrade 按依赖反向删表（先 weekly_reports，再 watch_events），只用于空库/
测试回滚。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0008_weekly_report"
down_revision: str = "0007_quiz"
branch_labels: str | None = None
depends_on: str | None = None

WATCH_EVENTS = "watch_events"
WEEKLY_REPORTS = "weekly_reports"

UNIQUE_WATCH_CLIENT = "ux_watch_events_user_client"
INDEX_WATCH_USER_OCCURRED = "ix_watch_events_user_occurred"
UNIQUE_REPORT_WEEK = "ux_weekly_reports_user_week"

# 迁移是历史快照：字面量写死，不 import 运行时代码。
KINDS = ("video", "local_show")
MAX_SECONDS = 86_400


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    return {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(table)}


def _in_check(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{value}'" for value in values) + ")"


def upgrade() -> None:
    """建 watch_events / weekly_reports 与索引（幂等）。"""
    tables = _table_names()

    if WATCH_EVENTS not in tables:
        op.create_table(
            WATCH_EVENTS,
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            # 归属键：登录用户 id 或 guest:<sha256>；NULL 会让唯一约束失效，
            # 所以游客也必须写这个字段，guest_hash 只作为补充身份。
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("guest_hash", sa.Text(), nullable=True),
            sa.Column("content_ref", sa.Text(), nullable=False),
            sa.Column("kind", sa.Text(), nullable=False),
            sa.Column(
                "target_lang",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'zh-CN'"),
            ),
            sa.Column("watched_seconds", sa.Integer(), nullable=False),
            sa.Column("position_seconds", sa.Integer(), nullable=False),
            sa.Column("occurred_at", sa.Integer(), nullable=False),
            sa.Column("client_event_id", sa.Text(), nullable=False),
            sa.CheckConstraint(
                _in_check("kind", KINDS), name="ck_watch_events_kind"
            ),
            sa.CheckConstraint(
                f"watched_seconds BETWEEN 0 AND {MAX_SECONDS}",
                name="ck_watch_events_watched_seconds",
            ),
            sa.CheckConstraint(
                f"position_seconds BETWEEN 0 AND {MAX_SECONDS}",
                name="ck_watch_events_position_seconds",
            ),
            sa.UniqueConstraint(
                "user_id", "client_event_id", name=UNIQUE_WATCH_CLIENT
            ),
        )

    indexes = _index_names(WATCH_EVENTS)
    if INDEX_WATCH_USER_OCCURRED not in indexes:
        op.create_index(
            INDEX_WATCH_USER_OCCURRED, WATCH_EVENTS, ["user_id", "occurred_at"]
        )

    if WEEKLY_REPORTS not in tables:
        op.create_table(
            WEEKLY_REPORTS,
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("week_start", sa.Date(), nullable=False),
            # 完整报告 JSON 文本；不用 sa.JSON，避免 SQLite 亲和类型改写内容。
            sa.Column("payload", sa.Text(), nullable=False),
            sa.Column("created_at", sa.Integer(), nullable=False),
            sa.UniqueConstraint("user_id", "week_start", name=UNIQUE_REPORT_WEEK),
        )


def downgrade() -> None:
    """按依赖反向删表（索引随表删除）；仅限空库/测试回滚。"""
    tables = _table_names()
    for table in (WEEKLY_REPORTS, WATCH_EVENTS):
        if table in tables:
            op.drop_table(table)
