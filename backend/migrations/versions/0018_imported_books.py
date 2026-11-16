"""imported_books：用户导入的公版书（产品化：公版书链接导入）

Revision ID: 0018_imported_books
Revises: 0017_behavior_events
Create Date: 2026-11-17

用户可从 Project Gutenberg / Standard Ebooks 粘贴公版书链接，导入到「我的书」：
预览元数据与章节、按章读原文（每次从公版源实时抓取，**不存原文**）、按章翻译
（AI，译文缓存）、删除。本迁移只建两张表，运行时不建表；表缺失时
``backend/book_import.py`` 抛 ``BookImportUnavailable``，路由 503 并提示先跑迁移。

两张表：

- ``imported_books``：一个用户导入的一本书。
  - ``id``：TEXT PK（uuid4 hex，由应用生成）；
  - ``user_id``：归属键（``users.id``），导入需登录；
  - ``source_type``：``gutenberg`` / ``standard_ebooks``（见 book_import.py）；
  - ``source_url``：用户粘贴链接的**规范化规范地址**（Gutenberg 统一为
    ``https://www.gutenberg.org/ebooks/{id}``；Standard Ebooks 统一为
    ``https://standardebooks.org/ebooks/{author}/{slug}``）；
  - ``external_id``：源站内稳定标识（``gutenberg:1342`` /
    ``standard_ebooks:jane-austen/pride-and-prejudice``），用于幂等导入；
  - ``title`` / ``author`` / ``language``：抓取到的元数据（作者可空）；
  - ``chapters_json``：**章节索引，不含任何正文**。形状：
    ``{"version": 1, "provider": "...", "textUrl": null,
    "chapters": [{"n": 1, "title": "Chapter I", "url": null}]}``。
    Gutenberg 的 ``textUrl`` 记录首次发现的纯文本地址（没有则为 null），章节
    每次读时从当前源重新抓取；Standard Ebooks 每章记录目录页里的 XHTML 地址。
  - ``created_at`` / ``updated_at``：服务端毫秒 UTC；
  - ``UNIQUE(user_id, source_type, external_id)``：同一用户同一本书只落一行，
    重复导入在 API 层返回已有记录，并发下由数据库唯一约束兜底。
  - ``ix_imported_books_user_created(user_id, created_at)``：列表按最新在前。

- ``imported_book_translations``：按章、按目标语言缓存的 AI 译文。
  - ``book_id`` → ``imported_books.id``，**ON DELETE CASCADE**；
  - ``chapter_index``：章节号（1-based，与 ``chapters_json`` 的 ``n`` 对齐）；
  - ``lang``：canonical 目标语言代码（``zh-CN`` / ``vi-VN``）；
  - ``paragraphs_json``：与原文段落按下标对齐的译文数组；失败/未翻段为
    ``null``，下次只补缺失段（不重复扣费）；
  - ``model``：实际使用的模型目录 id（全失败时 NULL）；
  - ``created_at``：服务端毫秒 UTC；
  - ``PRIMARY KEY(book_id, chapter_index, lang)``：每章每语言一行，重复翻译
    幂等覆盖。

原文边界：本迁移**没有**任何存放正文的表/列；Gutenberg 原文按需从源站抓取后
只在请求内存中使用，Standard Ebooks 章节同理。翻译表只存译文。

downgrade 先删译文表再删书目表（仅空库/测试回滚）。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0018_imported_books"
down_revision: str = "0017_behavior_events"
branch_labels: str | None = None
depends_on: str | None = None

BOOKS = "imported_books"
TRANSLATIONS = "imported_book_translations"
INDEX_BOOKS_USER_CREATED = "ix_imported_books_user_created"
UNIQUE_BOOKS_USER_SOURCE = "ux_imported_books_user_source"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {index["name"] for index in inspector.get_indexes(table)}


def upgrade() -> None:
    """建导入书两张表 + 索引（幂等，不碰旧表）。"""
    tables = _table_names()

    if BOOKS not in tables:
        op.create_table(
            BOOKS,
            sa.Column("id", sa.Text(), primary_key=True),
            # 导入需登录：只写 users.id。
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("source_type", sa.Text(), nullable=False),
            sa.Column("source_url", sa.Text(), nullable=False),
            sa.Column("external_id", sa.Text(), nullable=False),
            sa.Column("title", sa.Text(), nullable=False),
            sa.Column("author", sa.Text(), nullable=True),
            sa.Column(
                "language", sa.Text(), nullable=False, server_default=sa.text("'en'")
            ),
            # 只存章节索引（标题/顺序/可选章节地址），绝不存原文段落。
            sa.Column(
                "chapters_json",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'{\"version\": 1, \"chapters\": []}'"),
            ),
            sa.Column("created_at", sa.Integer(), nullable=False),
            sa.Column("updated_at", sa.Integer(), nullable=False),
        )

    if INDEX_BOOKS_USER_CREATED not in _index_names(BOOKS):
        op.create_index(
            INDEX_BOOKS_USER_CREATED, BOOKS, ["user_id", "created_at"]
        )

    # 同一用户同一本书只允许一行（并发导入的数据库兜底）。SQLite 的
    # UNIQUE 表约束会生成匿名 autoindex，这里显式建命名唯一索引，便于测试/运维。
    if UNIQUE_BOOKS_USER_SOURCE not in _index_names(BOOKS):
        op.create_index(
            UNIQUE_BOOKS_USER_SOURCE,
            BOOKS,
            ["user_id", "source_type", "external_id"],
            unique=True,
        )

    if TRANSLATIONS not in tables:
        op.create_table(
            TRANSLATIONS,
            sa.Column("book_id", sa.Text(), nullable=False),
            sa.Column("chapter_index", sa.Integer(), nullable=False),
            sa.Column("lang", sa.Text(), nullable=False),
            # 与原文段落按下标对齐的译文数组（null=未翻/失败，可重试补齐）。
            sa.Column("paragraphs_json", sa.Text(), nullable=False),
            sa.Column("model", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Integer(), nullable=False),
            sa.ForeignKeyConstraint(
                ["book_id"], [f"{BOOKS}.id"], ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("book_id", "chapter_index", "lang"),
        )


def downgrade() -> None:
    """按依赖反向删两张表（索引随表删除）；仅限空库/测试回滚。"""
    tables = _table_names()
    if TRANSLATIONS in tables:
        op.drop_table(TRANSLATIONS)
    if BOOKS in tables:
        op.drop_table(BOOKS)
