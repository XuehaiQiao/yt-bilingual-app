"""content_teaching_analysis：AI 教学分析（高亮/习语/文化点）按内容+等级+语言缓存

Revision ID: 0020_content_teaching_analysis
Revises: 0019_book_chapter_translations
Create Date: 2026-11-18

把「AI 教学分析」从翻译调用里拆出来：翻译只负责译文，高亮（highlight）/
习语（idiom）/文化点（culture）由 ``backend/teaching_analysis.py`` 单独生成，
并按内容缓存。这样同一份内容在同一 CEFR 高亮档 + 目标语言下只花一次模型钱，
后续用户/后续打开零额外调用；换等级（liftoff..supernova）才重新生成。

一张表：

- ``content_teaching_analysis``：**全局公共缓存**（没有 user_id，登录用户与
  游客共享；分析结果只依赖内容本身，不依赖用户）。
  - ``id``：内部主键（uuid hex；表内寻址/未来引用用，不对外暴露）；
  - ``content_ref``：内容引用（视频 videoId、本地剧集 ``<show>-S01E01`` 等），
    仅用于排查/追溯；**不是**缓存键（同一内容不同引用共享分析）；
  - ``content_hash``：内容规范化哈希（英文正文 + block id，见
    ``teaching_analysis.content_hash``）；
  - ``level``：CEFR 高亮档内部 id（``liftoff``..``supernova``，
    见 ``config.VOCAB_LEVELS``）；分析只标「高于该档」的词/短语；
  - ``target_lang``：canonical 目标语言代码（``zh-CN`` / ``vi-VN``）；
  - ``analysis_version``：prompt/校验口径版本（当前 ``analysis.v1``）；升级后
    旧行不删，按新版本重新生成；
  - ``payload_json``：严格 JSON 文本，形如
    ``{"highlights": {"1": [{en_word, zh_word, color}]},
       "idioms": [{blockId, phrase, meaning, quote}],
       "culture": [{blockId, term, note, quote}]}``；
    只写通过校验的条目（引文必须是原文子串），不存模型原始输出；
  - ``created_at``：服务端毫秒 UTC；
  - ``UNIQUE(content_hash, level, target_lang, analysis_version)``：缓存键。
    命中即零模型调用；内容变化（hash 变）或等级/语言/版本变化才重新生成；
  - ``ix_content_teaching_analysis_ref``：按 content_ref 排查/运维用。

为什么不带 ``user_id``：分析结果（哪些词高于 B1、哪些是习语）与用户无关，
跨用户共享才能实现「同一内容+等级+语言后续用户零调用」（目标 3）。题目
（questions）不在此表：理解题走既有的 ``content_items`` / ``questions``
（``0007_quiz``）管线，按用户+内容缓存，不重复迁移。

downgrade 只删本表，不碰 0019 及更早的表。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0020_content_teaching_analysis"
down_revision: str = "0019_book_chapter_translations"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "content_teaching_analysis"
UNIQUE_CACHE_KEY = "ux_content_teaching_analysis_cache"
INDEX_CONTENT_REF = "ix_content_teaching_analysis_ref"
DEFAULT_ANALYSIS_VERSION = "analysis.v1"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {index["name"] for index in inspector.get_indexes(table)}


def upgrade() -> None:
    """建教学分析缓存表 + 缓存唯一键 + content_ref 索引（幂等）。"""
    if TABLE not in _table_names():
        op.create_table(
            TABLE,
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("content_ref", sa.Text(), nullable=False),
            sa.Column("content_hash", sa.Text(), nullable=False),
            sa.Column("level", sa.Text(), nullable=False),
            sa.Column("target_lang", sa.Text(), nullable=False),
            sa.Column(
                "analysis_version",
                sa.Text(),
                nullable=False,
                server_default=sa.text(f"'{DEFAULT_ANALYSIS_VERSION}'"),
            ),
            # 严格 JSON 文本；不用 sa.JSON，避免 SQLite 亲和类型改写内容。
            sa.Column("payload_json", sa.Text(), nullable=False),
            sa.Column("created_at", sa.Integer(), nullable=False),
            sa.UniqueConstraint(
                "content_hash",
                "level",
                "target_lang",
                "analysis_version",
                name=UNIQUE_CACHE_KEY,
            ),
        )

    if INDEX_CONTENT_REF not in _index_names(TABLE):
        op.create_index(INDEX_CONTENT_REF, TABLE, ["content_ref", "target_lang"])


def downgrade() -> None:
    """只删本表（索引随表删除）；不碰 0019 及更早的表。"""
    if TABLE in _table_names():
        op.drop_table(TABLE)
