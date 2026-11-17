"""book_chapter_translations：公版书库按需翻译的全局译文缓存

Revision ID: 0019_book_chapter_translations
Revises: 0018_imported_books
Create Date: 2026-11-17

用户需求 1：现有公版书（``content/books/books.json`` 内置书单）很多章节只有
原文、本地没有中译。第一个用户请求某一章时调用 ``POST /api/books/{id}/
chapters/{n}/translate`` 按需翻译缺失段落，并把译文**全局**缓存在本表；后续
任何用户/游客再读同一章同一目标语言都直接命中缓存，不重复调用 LLM。

一张表：

- ``book_chapter_translations``：按「书 + 章 + 目标语言」缓存译文。
  - ``book_id``：内置书单里的书籍 id（``books.json`` 的 ``books[].id``）；
    **不建外键**——书单是仓库内 JSON，不是数据库表；运行期用 ``books.find_book``
    校验，只有书单内 status=available 的书才允许翻译；
  - ``chapter_no``：章节号（1-based，与 ``books.json`` 的 ``chapters[].n`` 对齐）；
  - ``target_lang``：canonical 目标语言代码（``zh-CN`` / ``vi-VN``，见
    ``languages.py``）；
  - ``paragraphs_json``：与公版源段落**按下标对齐**的译文数组，例如
    ``["第一段", null, "第三段"]``；``null`` = 未翻译/失败，下次只补缺失段，
    不重复扣费。**不存英文原文**（原文每次请求从公版源实时抓取）；
  - ``model``：实际使用的模型目录 id（全失败时不会写该行；可为 NULL）；
  - ``created_at`` / ``updated_at``：服务端毫秒 UTC；批量补译时只更新
    ``updated_at`` 与 ``paragraphs_json``，不重置 ``created_at``；
  - ``PRIMARY KEY(book_id, chapter_no, target_lang)``：每章每语言一行，重复翻译
    用 UPSERT 幂等覆盖；
  - ``ix_book_chapter_translations_book_lang(book_id, target_lang)``：按书统计
    已缓存语言/章节时使用。

与 0018 的 ``imported_book_translations`` 的区别：本表是**全局公共缓存**（没有
``user_id``，游客也能共享），且属于仓库内置书单；0018 的译文归属导入用户。

原文边界：本迁移没有任何存放正文的表/列。Gutenberg / Standard Ebooks 原文只在
请求内存中使用，翻译表只存译文。

downgrade 只删本表，不碰 0018 的导入书表。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0019_book_chapter_translations"
down_revision: str = "0018_imported_books"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "book_chapter_translations"
INDEX_BOOK_LANG = "ix_book_chapter_translations_book_lang"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {index["name"] for index in inspector.get_indexes(table)}


def upgrade() -> None:
    """建全局译文缓存表 + 书籍/语言索引（幂等，不碰旧表）。"""
    tables = _table_names()

    if TABLE not in tables:
        op.create_table(
            TABLE,
            # 内置书单 id；书单是 JSON，不建外键。
            sa.Column("book_id", sa.Text(), nullable=False),
            sa.Column("chapter_no", sa.Integer(), nullable=False),
            sa.Column("target_lang", sa.Text(), nullable=False),
            # 与原文段落按下标对齐的译文数组（null = 未翻/失败，可重试补齐）。
            sa.Column("paragraphs_json", sa.Text(), nullable=False),
            sa.Column("model", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Integer(), nullable=False),
            sa.Column("updated_at", sa.Integer(), nullable=False),
            sa.PrimaryKeyConstraint("book_id", "chapter_no", "target_lang"),
        )

    if INDEX_BOOK_LANG not in _index_names(TABLE):
        op.create_index(INDEX_BOOK_LANG, TABLE, ["book_id", "target_lang"])


def downgrade() -> None:
    """只删本表（索引随表删除）；不碰 0018 的导入书表。"""
    if TABLE in _table_names():
        op.drop_table(TABLE)
