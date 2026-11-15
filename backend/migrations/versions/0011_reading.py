"""reading：读文章（V1 用户需求 #3 / specs/019）

Revision ID: 0011_reading
Revises: 0010_discover
Create Date: 2026-11-15

V1「读文章」后端的存储层：用户粘贴英文文章 URL（或正文）→ 抽取标题/段落 →
逐段翻译（目标语言 zh-CN / vi-VN）→ 阅读进度回写。本迁移只建四张表 + 索引，
运行时不建表；表缺失时 ``backend/reading.py`` 抛 ``ReadingUnavailable``，
路由返回 503 并提示先跑迁移。

四张表：

- ``articles``：一篇文章（每个用户各一份，不做跨用户共享）。
  - ``id``：TEXT PK（uuid4 hex，由应用生成）；
  - ``user_id``：归属键，登录用户的 users.id（读文章需登录，游客不写）；
  - ``source_url``：可空。URL 导入存**规范化后的最终 URL**（跟随重定向后），
    粘贴正文为 NULL；
  - ``title`` / ``site``：标题与站点域名（粘贴正文时 site 为 NULL）；
  - ``lang``：源语言，当前固定 ``en``；
  - ``word_count``：段落英文词数合计（服务端计算）；
  - ``created_at``：服务端毫秒 UTC；
  - ``ix_articles_user_created(user_id, created_at)``：列表页按「最新在前」；
  - ``ux_articles_user_url(user_id, source_url)``：**部分唯一索引**
    （``WHERE source_url IS NOT NULL``），同一用户同一 URL 只落一行，幂等导入
    在并发下也有数据库兜底；粘贴正文（source_url NULL）不受约束，可多篇。

- ``article_paragraphs``：正文段落。
  - ``article_id`` → ``articles.id``，**ON DELETE CASCADE**；
  - ``idx``：从 0 开始的段序；
  - ``text``：段落正文（应用侧单段上限 4000 字符、最多 200 段）；
  - ``PRIMARY KEY(article_id, idx)``：同一篇内段序唯一，天然按 idx 读取。

- ``article_translations``：已有译文（按目标语言分开）。
  - ``article_id`` → ``articles.id``，**ON DELETE CASCADE**；
  - ``idx``：对应 ``article_paragraphs.idx``；
  - ``target_lang``：canonical 代码（``zh-CN`` / ``vi-VN``，默认 ``zh-CN``）；
  - ``text``：译文；失败段落由应用写 ``[未翻译]`` 作为可重试标记（不是失败终态）；
  - ``model``：实际使用的模型目录 id（失败标记为 NULL）；
  - ``created_at``：服务端毫秒 UTC；
  - ``PRIMARY KEY(article_id, idx, target_lang)``：逐段幂等（已有译文不重译）；
  - ``ix_article_translations_article_lang(article_id, target_lang)``：按语言
    读取整篇已有译文。

- ``article_progress``：阅读进度（每个用户每篇一条，最新位置覆盖）。
  - ``user_id`` + ``article_id`` 复合主键；
  - ``article_id`` → ``articles.id``，**ON DELETE CASCADE**；
  - ``paragraph_idx``：当前段序（CHECK >= 0；应用侧再校验 < 段数）；
  - ``updated_at``：服务端毫秒 UTC。

downgrade 按依赖反向删表（先 progress / translations / paragraphs，再 articles），
只用于空库/测试回滚。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0011_reading"
down_revision: str = "0010_discover"
branch_labels: str | None = None
depends_on: str | None = None

ARTICLES = "articles"
PARAGRAPHS = "article_paragraphs"
TRANSLATIONS = "article_translations"
PROGRESS = "article_progress"

INDEX_ARTICLES_USER_CREATED = "ix_articles_user_created"
UNIQUE_ARTICLES_USER_URL = "ux_articles_user_url"
INDEX_TRANSLATIONS_ARTICLE_LANG = "ix_article_translations_article_lang"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    return {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    """建读文章四表 + 索引（幂等，不碰旧表）。"""
    tables = _table_names()

    if ARTICLES not in tables:
        op.create_table(
            ARTICLES,
            sa.Column("id", sa.Text(), primary_key=True),
            # 读文章需登录：正常只写 users.id；保留 TEXT 形状与 jobs/placement 一致。
            sa.Column("user_id", sa.Text(), nullable=False),
            # URL 导入是最终 URL；粘贴正文为 NULL（部分唯一索引据此放行多篇）。
            sa.Column("source_url", sa.Text(), nullable=True),
            sa.Column("title", sa.Text(), nullable=False),
            sa.Column("site", sa.Text(), nullable=True),
            sa.Column(
                "lang", sa.Text(), nullable=False, server_default=sa.text("'en'")
            ),
            sa.Column(
                "word_count", sa.Integer(), nullable=False, server_default=sa.text("0")
            ),
            sa.Column("created_at", sa.Integer(), nullable=False),
        )

    if INDEX_ARTICLES_USER_CREATED not in _index_names(ARTICLES):
        op.create_index(
            INDEX_ARTICLES_USER_CREATED, ARTICLES, ["user_id", "created_at"]
        )

    # 同 user + 同 URL 只允许一篇；NULL（粘贴正文）不受唯一约束。
    if UNIQUE_ARTICLES_USER_URL not in _index_names(ARTICLES):
        op.create_index(
            UNIQUE_ARTICLES_USER_URL,
            ARTICLES,
            ["user_id", "source_url"],
            unique=True,
            sqlite_where=sa.text("source_url IS NOT NULL"),
        )

    if PARAGRAPHS not in tables:
        op.create_table(
            PARAGRAPHS,
            sa.Column("article_id", sa.Text(), nullable=False),
            sa.Column("idx", sa.Integer(), nullable=False),
            sa.Column("text", sa.Text(), nullable=False),
            sa.ForeignKeyConstraint(
                ["article_id"], [f"{ARTICLES}.id"], ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("article_id", "idx"),
        )

    if TRANSLATIONS not in tables:
        op.create_table(
            TRANSLATIONS,
            sa.Column("article_id", sa.Text(), nullable=False),
            sa.Column("idx", sa.Integer(), nullable=False),
            sa.Column(
                "target_lang",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'zh-CN'"),
            ),
            sa.Column("text", sa.Text(), nullable=False),
            sa.Column("model", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Integer(), nullable=False),
            sa.ForeignKeyConstraint(
                ["article_id"], [f"{ARTICLES}.id"], ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("article_id", "idx", "target_lang"),
        )

    if TRANSLATIONS in _table_names() and (
        INDEX_TRANSLATIONS_ARTICLE_LANG not in _index_names(TRANSLATIONS)
    ):
        op.create_index(
            INDEX_TRANSLATIONS_ARTICLE_LANG,
            TRANSLATIONS,
            ["article_id", "target_lang"],
        )

    if PROGRESS not in tables:
        op.create_table(
            PROGRESS,
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("article_id", sa.Text(), nullable=False),
            sa.Column("paragraph_idx", sa.Integer(), nullable=False),
            sa.Column("updated_at", sa.Integer(), nullable=False),
            sa.CheckConstraint("paragraph_idx >= 0", name="ck_article_progress_idx"),
            sa.ForeignKeyConstraint(
                ["article_id"], [f"{ARTICLES}.id"], ondelete="CASCADE"
            ),
            sa.PrimaryKeyConstraint("user_id", "article_id"),
        )


def downgrade() -> None:
    """按依赖反向删四张表（索引随表删除）；仅限空库/测试回滚。"""
    for table in (PROGRESS, TRANSLATIONS, PARAGRAPHS, ARTICLES):
        if table in _table_names():
            op.drop_table(table)
