"""翻译/分析管道计时表 pipeline_timing（P2-35，specs/001 §计时观测）

Revision ID: 0032_pipeline_timing
Revises: 0031_quota_overrides
Create Date: 2026-11-24

建一张**只追加**的计时表：把原本只出现在 stdout 里的结构化计时
（``feature=video_translation/sse_translate/video_analysis/reading/
book_translation/local_show``）落成可查询数据，供管理台按 feature 看
样本数 / 成功率 / P50 / P95 / max。

字段契约：

- ``feature``：计时锚点（写入层收口到 ``pipeline_timing.KNOWN_FEATURES``）；
- ``event``：``batch``（单批）或 ``total``（一次翻译/分析收尾）；管理台聚合
  只看 ``total``，批记录用于排障/最近行；
- ``content_ref`` / ``job_id``：可归因标识（videoId / articleId / 书章 /
  SSE job id）。**不存正文、不存用户 id、不存 prompt**；写入层会把含空白、
  超长或反斜杠的值丢成 NULL；
- ``batch_index``（0 起）/ ``batch_count`` / ``duration_ms``（批耗时）/
  ``total_ms``（整次耗时）/ ``concurrency``：延迟与并发归因；
- ``ok``：``0/1``（CHECK 兜底），失败率 = 1 - AVG(ok)；
- ``meta_json``：白名单数值/短标签（attempts/fallback/outcome/status/
  first_batch_ms/translated…），由写入层清洗；
- ``created_at_ms``：服务端毫秒时间戳；
- ``day``：按 ``AI_QUOTA_TIMEZONE`` 派生的 ``YYYY-MM-DD`` 日桶，与账本/配额/
  管理台日期口径一致。

索引：

- ``ix_pipeline_timing_day_feature (day, feature)``：按日期范围扫描/按天聚合；
- ``ix_pipeline_timing_feature_day (feature, day)``：指定 feature 的区间查询；
- ``ix_pipeline_timing_created (created_at_ms)``：最近行倒序。

**回滚（downgrade）**：只删本迁移新建的索引与表；不引用、不修改任何旧表，
回滚到 0031 后旧代码照常运行，代价是丢失已采集的计时数据（属于观测数据，
不影响业务；要保留请先备份 ``data/app.db``）。

**幂等**：``upgrade`` 先查 ``sqlite_master``，表已存在（手工建过/降级后重新
升级）就跳过；``downgrade`` 先判断再删，重复执行安全。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0032_pipeline_timing"
down_revision: str = "0031_quota_overrides"
branch_labels: str | None = None
depends_on: str | None = None

TIMING_TABLE = "pipeline_timing"
IDX_DAY_FEATURE = "ix_pipeline_timing_day_feature"
IDX_FEATURE_DAY = "ix_pipeline_timing_feature_day"
IDX_CREATED = "ix_pipeline_timing_created"
CHECK_OK_BOOL = "ck_pipeline_timing_ok_bool"
CHECK_CONCURRENCY = "ck_pipeline_timing_concurrency"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return {item["name"] for item in inspector.get_indexes(table)}


def upgrade() -> None:
    """建 ``pipeline_timing`` 与索引；表已存在时跳过（可重复执行）。"""
    if TIMING_TABLE in _table_names():
        return
    op.create_table(
        TIMING_TABLE,
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("feature", sa.Text(), nullable=False),
        sa.Column("event", sa.Text(), nullable=False),
        sa.Column("content_ref", sa.Text(), nullable=True),
        sa.Column("job_id", sa.Text(), nullable=True),
        sa.Column("batch_index", sa.Integer(), nullable=True),
        sa.Column("batch_count", sa.Integer(), nullable=True),
        sa.Column("duration_ms", sa.Float(), nullable=True),
        sa.Column("total_ms", sa.Float(), nullable=True),
        sa.Column("concurrency", sa.Integer(), nullable=True),
        sa.Column("ok", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("meta_json", sa.Text(), nullable=True),
        sa.Column("created_at_ms", sa.Integer(), nullable=False),
        sa.Column("day", sa.Text(), nullable=False),
        sa.CheckConstraint("ok IN (0, 1)", name=CHECK_OK_BOOL),
        sa.CheckConstraint(
            "concurrency IS NULL OR concurrency >= 1", name=CHECK_CONCURRENCY
        ),
    )
    op.create_index(IDX_DAY_FEATURE, TIMING_TABLE, ["day", "feature"])
    op.create_index(IDX_FEATURE_DAY, TIMING_TABLE, ["feature", "day"])
    op.create_index(IDX_CREATED, TIMING_TABLE, ["created_at_ms"])


def downgrade() -> None:
    """删除本迁移新建的索引与表；不存在时跳过（可重复执行）。"""
    if TIMING_TABLE not in _table_names():
        return
    existing = _index_names(TIMING_TABLE)
    for name in (IDX_CREATED, IDX_FEATURE_DAY, IDX_DAY_FEATURE):
        if name in existing:
            op.drop_index(name, table_name=TIMING_TABLE)
    op.drop_table(TIMING_TABLE)
