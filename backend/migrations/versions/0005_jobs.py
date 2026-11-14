"""jobs：处理任务表 + 断线续传游标（计划书 M1 ⑤ / §7.3 A-4）

Revision ID: 0005_jobs
Revises: 0004_target_lang
Create Date: 2026-11-15

M1 ⑤ 的最小落地：把「处理一个视频」从一次 HTTP 连接里抽出来持久化，
刷新/断网后能从游标继续，已生成的字幕不重复付费。

表 ``jobs``：

- ``id`` TEXT PK（uuid4 hex，服务端生成）；
- ``user_id`` / ``kind``（``process_video`` / ``local_show``）/ ``content_ref``
  （YouTube videoId 或本地剧集引用）；
- ``target_lang``：与 0004 一致，默认 ``zh-CN``（历史兼容位）；
- ``status``：``queued`` / ``running`` / ``partial`` / ``done`` / ``failed``，
  由 CHECK 约束兜底（内部写入路径，拼错宁可写不进去也不要留下垃圾状态）；
- ``cursor`` INTEGER：**已落盘译文的 block 数**（0 = 还没生成；等于 total 表示
  字幕全部有译文）。续传实际要补的句子由缓存里的 ``[未翻译]`` 标记决定，
  所以 cursor 只作进度/可续判断，不会被拿来跳过失败批次；
- ``payload`` TEXT：JSON 元数据（videoId / url / model / total 等），**不放字幕
  正文**——产物就是 ``history/`` 下按批落盘的缓存 JSON（宪法原则 4）；
- ``error`` TEXT：失败原因（只给人看，不参与逻辑）；
- ``created_at`` / ``updated_at``：毫秒时间戳。

索引：

- ``ix_jobs_user_created``：按用户 + 时间查任务（排查/后续任务列表）；
- ``ux_jobs_active``：**部分唯一索引**，同一 ``(user_id, kind, content_ref,
  target_lang)`` 同时最多一个未完成 job（queued/running/partial）。并发创建时
  数据库层兜底，应用层 ``jobs.create_or_reuse`` 再配进程内锁，保证「同一视频
  同一语言只付一次翻译钱」。

约定：

- 运行时不建表（``backend/jobs.py`` 只读写）；表缺失时任务绑定降级为无操作，
  旧库（未跑本迁移）仍能正常处理视频，只是没有断线续传；
- 不做定期清理：任务产物即用户缓存，删缓存后任务自然变成「产物缺失」
  （``GET /api/jobs/{id}`` 返回 ``canResume=false``，续传请求 410）。计划书
  §8.4 的保留期硬删留到删除权矩阵落地时用独立运维脚本，不进应用代码。

downgrade 删表（含索引），只用于空库/测试回滚。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0005_jobs"
down_revision: str = "0004_target_lang"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "jobs"
INDEX_USER_CREATED = "ix_jobs_user_created"
INDEX_ACTIVE_UNIQUE = "ux_jobs_active"

# 与 backend/jobs.py 的常量保持一致（迁移里写死字面量：迁移是历史快照，
# 不 import 运行时代码，避免以后改常量把旧迁移的行为也改掉）。
STATUSES = ("queued", "running", "partial", "done", "failed")
ACTIVE_STATUSES = ("queued", "running", "partial")
_ACTIVE_SQL = "(" + ", ".join(f"'{status}'" for status in ACTIVE_STATUSES) + ")"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    return {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    """建 ``jobs`` 表与两个索引（幂等：已存在就跳过）。"""
    if TABLE not in _table_names():
        op.create_table(
            TABLE,
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
            sa.Column(
                "status",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'queued'"),
            ),
            sa.Column(
                "cursor",
                sa.Integer(),
                nullable=False,
                server_default=sa.text("0"),
            ),
            sa.Column("payload", sa.Text(), nullable=True),
            sa.Column("error", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Integer(), nullable=False),
            sa.Column("updated_at", sa.Integer(), nullable=False),
            sa.CheckConstraint(
                "status IN (" + ", ".join(f"'{status}'" for status in STATUSES) + ")",
                name="ck_jobs_status",
            ),
        )

    indexes = _index_names(TABLE)
    if INDEX_USER_CREATED not in indexes:
        op.create_index(INDEX_USER_CREATED, TABLE, ["user_id", "created_at"])
    if INDEX_ACTIVE_UNIQUE not in indexes:
        # 部分唯一索引：SQLite 与 Postgres 都支持同样的语法（WHERE ...）。
        # 只约束未完成状态，done/failed 的历史 job 可以无限累积。
        op.execute(
            f"CREATE UNIQUE INDEX {INDEX_ACTIVE_UNIQUE} ON {TABLE} "
            f"(user_id, kind, content_ref, target_lang) "
            f"WHERE status IN {_ACTIVE_SQL}"
        )


def downgrade() -> None:
    """删表（含索引）；会丢任务进度，仅限空库/测试回滚。"""
    if TABLE not in _table_names():
        return
    op.drop_table(TABLE)
