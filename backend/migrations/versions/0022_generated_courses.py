"""generated_courses：用户生成的课程（specs/030 课程生成）

Revision ID: 0022_generated_courses
Revises: 0021_course_mvp
Create Date: 2026-11-18

课程本身仍是一份 ``linguatrek.course-lesson.v1`` JSON（``lesson_json``，含
答案，仅服务端判分用）；本表只负责「谁、从什么源、什么等级/语言、用哪个
prompt 版本、生成过一次」，让重复点击零模型调用。

- ``id``：``gen-<uuid4 hex>``，由应用生成；
- ``owner_user_id``：生成者；列表/详情/attempt 都只认本人，越权按 404
  处理（不泄露存在性）；
- ``source_kind``：``youtube`` / ``novel``（CHECK）；
- ``source_ref``：YouTube videoId，或 ``gutenberg:1342:chapter:1``；
- ``content_hash``：源文本规范化后的 sha256 前 32 位；源内容变化自动失效；
- ``level``：高亮档 id（liftoff..supernova，兼容旧考试 id 归一化后的值）；
- ``target_lang``：``zh-CN`` / ``vi-VN``；
- ``prompt_version``：``course-gen.v1``，改 prompt/校验口径时递增；
- ``title`` / ``lesson_json``：列表标题与完整课程包（JSON 文本，不用
  sa.JSON，避免 SQLite 亲和类型改写内容）；
- ``status``：当前只有 ``ready``（失败不落库，不写半成品）；
- ``created_at``：服务端毫秒 UTC。

唯一键 ``ux_generated_courses_cache`` 覆盖缓存键
``(owner_user_id, source_kind, source_ref, content_hash, level, target_lang,
prompt_version)``：同一用户同一内容的同等级/语言/prompt 版本只落一行。
``ix_generated_courses_owner_created`` 供「我的课程」列表按时间倒序查询。

downgrade 只删本表；不影响 0021 的 attempt/event（旧 attempt 指向生成课程
时会按课程不存在返回 404）。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0022_generated_courses"
down_revision: str = "0021_course_mvp"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "generated_courses"
UNIQUE_CACHE_KEY = "ux_generated_courses_cache"
INDEX_OWNER_CREATED = "ix_generated_courses_owner_created"

# 迁移是历史快照：字面量写死，不 import 运行时代码。
SOURCE_KINDS = ("youtube", "novel")
STATUSES = ("ready",)
CACHE_COLUMNS = [
    "owner_user_id",
    "source_kind",
    "source_ref",
    "content_hash",
    "level",
    "target_lang",
    "prompt_version",
]


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {index["name"] for index in inspector.get_indexes(table)}


def upgrade() -> None:
    """建 ``generated_courses`` + 缓存唯一键 + 归属索引（幂等）。"""
    if TABLE not in _table_names():
        op.create_table(
            TABLE,
            sa.Column("id", sa.Text(), primary_key=True, nullable=False),
            sa.Column("owner_user_id", sa.Text(), nullable=False),
            sa.Column("source_kind", sa.Text(), nullable=False),
            sa.Column("source_ref", sa.Text(), nullable=False),
            sa.Column("content_hash", sa.Text(), nullable=False),
            sa.Column("level", sa.Text(), nullable=False),
            sa.Column("target_lang", sa.Text(), nullable=False),
            sa.Column("prompt_version", sa.Text(), nullable=False),
            sa.Column("title", sa.Text(), nullable=False),
            # 完整课程包（含 answer/explain）；只给服务端判分用，下发前脱敏。
            sa.Column("lesson_json", sa.Text(), nullable=False),
            sa.Column(
                "status",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'ready'"),
            ),
            sa.Column("created_at", sa.Integer(), nullable=False),
            sa.CheckConstraint(
                "source_kind IN (" + ", ".join(f"'{value}'" for value in SOURCE_KINDS) + ")",
                name="ck_generated_courses_source_kind",
            ),
            sa.CheckConstraint(
                "status IN (" + ", ".join(f"'{value}'" for value in STATUSES) + ")",
                name="ck_generated_courses_status",
            ),
            sa.CheckConstraint(
                "created_at >= 0",
                name="ck_generated_courses_created_at",
            ),
        )

    indexes = _index_names(TABLE)
    if UNIQUE_CACHE_KEY not in indexes:
        op.create_index(
            UNIQUE_CACHE_KEY,
            TABLE,
            CACHE_COLUMNS,
            unique=True,
        )
    if INDEX_OWNER_CREATED not in indexes:
        op.create_index(
            INDEX_OWNER_CREATED,
            TABLE,
            ["owner_user_id", "created_at"],
        )


def downgrade() -> None:
    """只删本迁移的表（索引随表删除）；不碰 0021 及更早的表。"""
    if TABLE in _table_names():
        op.drop_table(TABLE)
