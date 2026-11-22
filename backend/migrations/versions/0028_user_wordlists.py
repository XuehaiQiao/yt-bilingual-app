"""自定义词表：user_wordlists + user_wordlist_items（specs/038 §4）

Revision ID: 0028_user_wordlists
Revises: 0027_review_mastered
Create Date: 2026-11-22

建两张表（字段契约见 ``specs/038-custom-wordlists/spec.md`` §4）：

- ``user_wordlists``：登录用户导入的一张自定义词表。``user_id`` 归属账号；
  ``UNIQUE(user_id, name)`` 保证同一用户下表名唯一（重名由应用层加 ``(2)``）；
  ``source_filename`` 只作展示，``item_count`` 是导入后的有效条目数。
- ``user_wordlist_items``：词表条目。``list_id`` 外键指向 ``user_wordlists.id``
  且 ``ON DELETE CASCADE``：删除词表时条目一起消失，不影响收藏/复习状态
  （那些状态存在 ``word_states``，是另一份数据）。
  ``word`` 保留导入时的原词形；``word_key`` 是 ``NFC + casefold`` 去重键，
  ``UNIQUE(list_id, word_key)`` 兜底「同表重复只留第一条」。
  索引 ``(list_id, position)`` 供分页按导入顺序读取。

**回滚（downgrade）**：先删子表 ``user_wordlist_items``、再删父表
``user_wordlists``（顺序与 FK 依赖相反）。回滚会丢失用户导入的词表内容；
要保留数据请先备份 ``data/app.db``。本迁移只**新增**两张表，不改任何旧表，
所以回滚到 0027 后旧代码照常运行，不需要数据迁移。

**幂等**：``upgrade`` 先查 ``sqlite_master``，表已存在（手工建过 / 降级后
重新升级）就跳过，不会报 ``table already exists``；``downgrade`` 同样先判断
再删，重复执行安全。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0028_user_wordlists"
down_revision: str = "0027_review_mastered"
branch_labels: str | None = None
depends_on: str | None = None

LISTS_TABLE = "user_wordlists"
ITEMS_TABLE = "user_wordlist_items"
INDEX_ITEMS_LIST_POSITION = "ix_user_wordlist_items_list_position"
UNIQUE_LIST_USER_NAME = "ux_user_wordlists_user_name"
UNIQUE_ITEM_LIST_WORD = "ux_user_wordlist_items_list_word"
FK_ITEMS_LIST = "fk_user_wordlist_items_list"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    """建表 + 索引；逐表判断存在性，可重复执行。"""
    existing = _table_names()
    if LISTS_TABLE not in existing:
        op.create_table(
            LISTS_TABLE,
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("source_filename", sa.Text(), nullable=True),
            sa.Column("item_count", sa.Integer(), nullable=True),
            sa.Column("created_at", sa.Integer(), nullable=True),
            sa.UniqueConstraint(
                "user_id", "name", name=UNIQUE_LIST_USER_NAME
            ),
        )
    if ITEMS_TABLE not in existing:
        op.create_table(
            ITEMS_TABLE,
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("list_id", sa.Text(), nullable=False),
            sa.Column("word", sa.Text(), nullable=False),
            sa.Column("word_key", sa.Text(), nullable=False),
            sa.Column("translation", sa.Text(), nullable=True),
            sa.Column("phonetic", sa.Text(), nullable=True),
            sa.Column("cefr", sa.Text(), nullable=True),
            sa.Column("example", sa.Text(), nullable=True),
            sa.Column("position", sa.Integer(), nullable=True),
            sa.ForeignKeyConstraint(
                ["list_id"],
                [f"{LISTS_TABLE}.id"],
                name=FK_ITEMS_LIST,
                ondelete="CASCADE",
            ),
            sa.UniqueConstraint(
                "list_id", "word_key", name=UNIQUE_ITEM_LIST_WORD
            ),
        )
    indexes = (
        {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(ITEMS_TABLE)}
        if ITEMS_TABLE in _table_names()
        else set()
    )
    if INDEX_ITEMS_LIST_POSITION not in indexes:
        op.create_index(
            INDEX_ITEMS_LIST_POSITION,
            ITEMS_TABLE,
            ["list_id", "position"],
            unique=False,
        )


def downgrade() -> None:
    """先删子表再删父表；重复执行安全（表不存在时跳过）。"""
    existing = _table_names()
    if ITEMS_TABLE in existing:
        op.drop_table(ITEMS_TABLE)
    if LISTS_TABLE in existing:
        op.drop_table(LISTS_TABLE)
