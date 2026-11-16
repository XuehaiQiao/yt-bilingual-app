"""content_difficulty：内容难度向量（计划书 §6 / §7.2，specs/026）。

Revision ID: 0016_content_difficulty
Revises: 0015_assessment_sessions
Create Date: 2026-11-17

M2「锚点与匹配」的存储层：每内容每版本一行，**不 seed**（由
``scripts/backfill_content_difficulty.py`` 回填，幂等 upsert）。

- PK ``(content_ref, content_kind, version)``；
- ``content_kind`` CHECK ``video/local_show/article/curated/sentence_pack/
  quiz_item/placement_item``；
- ``level`` 保留旧标量（编辑标注），供难度行缺失时回退；
- ``cefr_input`` / ``cefr_task``：理解该内容所需带 / 用该内容做任务的输出带
  （M2 只填 input；task 留给 M3）；
- ``lexical_band`` / ``syntax_band`` / ``discourse_band`` 可空；
- ``features`` 是 ``difficulty.v1`` JSON（含 ``available`` 可用性标志）；
- ``support`` 是字幕/翻译/词表 JSON；
- ``method`` CHECK ``manual/rule/hybrid/llm``；
- ``confidence`` 是内容侧标签可信度（不是用户侧 confidence）；
- ``reviewer`` / ``reviewed_at`` 人工复核留痕；
- 索引 ``(content_kind, cefr_input)`` 与 ``(content_kind, updated_at)``。

downgrade 只删本表；旧 ``level`` 仍在各内容文件/旧逻辑里，回退路径不受影响。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "0016_content_difficulty"
down_revision: str = "0015_assessment_sessions"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "content_difficulty"
INDEX_KIND_CEFR = "ix_content_difficulty_kind_cefr"
INDEX_KIND_UPDATED = "ix_content_difficulty_kind_updated"

CONTENT_KINDS = (
    "video",
    "local_show",
    "article",
    "curated",
    "sentence_pack",
    "quiz_item",
    "placement_item",
)
METHODS = ("manual", "rule", "hybrid", "llm")


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    return {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(table)}


def _in_check(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN (" + ", ".join(f"'{value}'" for value in values) + ")"


def upgrade() -> None:
    """建 content_difficulty 与两个索引（幂等）。"""
    if TABLE in _table_names():
        return
    op.create_table(
        TABLE,
        sa.Column("content_ref", sa.Text(), primary_key=True, nullable=False),
        sa.Column("content_kind", sa.Text(), primary_key=True, nullable=False),
        sa.Column("version", sa.Text(), primary_key=True, nullable=False),
        sa.Column("level", sa.Text(), nullable=True),
        sa.Column("cefr_input", sa.Text(), nullable=True),
        sa.Column("cefr_task", sa.Text(), nullable=True),
        sa.Column("lexical_band", sa.Text(), nullable=True),
        sa.Column("syntax_band", sa.Text(), nullable=True),
        sa.Column("discourse_band", sa.Text(), nullable=True),
        sa.Column("features", sa.Text(), nullable=True),
        sa.Column("support", sa.Text(), nullable=True),
        sa.Column("method", sa.Text(), nullable=False, server_default=sa.text("'rule'")),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("reviewer", sa.Text(), nullable=True),
        sa.Column("reviewed_at", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            _in_check("content_kind", CONTENT_KINDS),
            name="ck_content_difficulty_kind",
        ),
        sa.CheckConstraint(
            _in_check("method", METHODS), name="ck_content_difficulty_method"
        ),
        sa.CheckConstraint(
            "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)",
            name="ck_content_difficulty_confidence",
        ),
    )
    existing = _index_names(TABLE)
    if INDEX_KIND_CEFR not in existing:
        op.create_index(INDEX_KIND_CEFR, TABLE, ["content_kind", "cefr_input"])
    if INDEX_KIND_UPDATED not in existing:
        op.create_index(INDEX_KIND_UPDATED, TABLE, ["content_kind", "updated_at"])


def downgrade() -> None:
    """删两个索引与本表（旧内容文件/旧 level 回退路径保留）。"""
    if TABLE not in _table_names():
        return
    existing = _index_names(TABLE)
    for name in (INDEX_KIND_CEFR, INDEX_KIND_UPDATED):
        if name in existing:
            op.drop_index(name, table_name=TABLE)
    op.drop_table(TABLE)
