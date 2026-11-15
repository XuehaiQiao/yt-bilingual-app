"""user_profile：用户名 / 余额 / 账号状态 + 余额流水 + 应用设置（V1 用户需求 1–3）

Revision ID: 0013_user_profile
Revises: 0012_exam
Create Date: 2026-11-16

用户需求 1/2/3 的存储层：

- ``users`` 增加三列（不新建用户表）：
  - ``username``：显示名（可空；新注册必填/旧客户端回落 email 前缀，允许重名）；
  - ``credits``：余额（整数，默认 0；由管理员手动调账，支付/充值体系未实现）；
  - ``status``：账号状态 ``active`` / ``banned``（默认 active；封禁后登录与旧
    会话在身份中间件被拒）。
  旧用户的 ``username`` 回填为 email 的 ``@`` 前缀（重名不处理——它是显示名，
  不要求全局唯一）；``credits`` / ``status`` 由列默认值补齐，不需要逐行 UPDATE。

- ``credit_transactions``：管理员调账流水，append-only。
  - ``id``：TEXT PK（uuid4 hex，由应用生成）；
  - ``user_id``：归属用户 id（``users.id``）；
  - ``delta``：本次变动（正数发放 / 负数扣减）；
  - ``reason``：管理员填写的原因（1–200 字）；
  - ``admin_id``：操作管理员 id，可空（保留给脚本/系统调账）；
  - ``created_at``：服务端毫秒 UTC；
  - ``ix_credit_transactions_user_created``：按用户查流水。

- ``app_settings``：键值设置表（本次只有维护模式与公告）。
  - ``key`` TEXT PK（``maintenance_mode`` / ``announcement``）；
  - ``value`` TEXT 可空（维护模式存 ``'0'`` / ``'1'``；公告存原文，空 = NULL）；
  - ``updated_at``：服务端秒级 UTC。

运行时**不建表**：表/列缺失时 ``backend/account.py`` 抛
``SettingsUnavailable`` / ``CreditsUnavailable``，路由返回 503 并提示先跑迁移
（维护模式读取除外——旧库按「未开启」处理，不阻断线上请求）。

downgrade 删除两张新表并移除 users 的三列；只用于空库/测试回滚。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0013_user_profile"
down_revision: str = "0012_exam"
branch_labels: str | None = None
depends_on: str | None = None

USERS = "users"
CREDIT_TRANSACTIONS = "credit_transactions"
APP_SETTINGS = "app_settings"

INDEX_CREDIT_USER_CREATED = "ix_credit_transactions_user_created"

NEW_USER_COLUMNS = ("username", "credits", "status")


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _column_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns(table)}


def _backfill_usernames() -> None:
    """旧用户 username = email 前缀（`@` 之前）；已有值不覆盖，重名不管。"""
    op.execute(
        "UPDATE users SET username = CASE "
        "WHEN instr(email, '@') > 1 THEN substr(email, 1, instr(email, '@') - 1) "
        "ELSE email END "
        "WHERE username IS NULL"
    )


def upgrade() -> None:
    """加 users 三列并回填 username；建余额流水与应用设置表（幂等）。"""
    tables = _table_names()

    if USERS in tables:
        columns = _column_names(USERS)
        if "username" not in columns:
            # 可空：旧客户端回落 email 前缀、旧用户由下面回填；允许重名。
            op.add_column(USERS, sa.Column("username", sa.Text(), nullable=True))
        if "credits" not in columns:
            op.add_column(
                USERS,
                sa.Column(
                    "credits",
                    sa.Integer(),
                    nullable=False,
                    server_default=sa.text("0"),
                ),
            )
        if "status" not in columns:
            op.add_column(
                USERS,
                sa.Column(
                    "status",
                    sa.Text(),
                    nullable=False,
                    server_default=sa.text("'active'"),
                ),
            )
        _backfill_usernames()

    tables = _table_names()
    if CREDIT_TRANSACTIONS not in tables:
        op.create_table(
            CREDIT_TRANSACTIONS,
            sa.Column("id", sa.Text(), primary_key=True, nullable=False),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("delta", sa.Integer(), nullable=False),
            sa.Column("reason", sa.Text(), nullable=False),
            # 可空：系统/脚本调账没有登录管理员；管理员操作填 users.id。
            sa.Column("admin_id", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Integer(), nullable=False),
        )
    inspector = sa.inspect(op.get_bind())
    indexes = {
        index["name"]
        for index in inspector.get_indexes(CREDIT_TRANSACTIONS)
    }
    if INDEX_CREDIT_USER_CREATED not in indexes:
        op.create_index(
            INDEX_CREDIT_USER_CREATED,
            CREDIT_TRANSACTIONS,
            ["user_id", "created_at"],
        )

    if APP_SETTINGS not in _table_names():
        op.create_table(
            APP_SETTINGS,
            sa.Column("key", sa.Text(), primary_key=True, nullable=False),
            # announcement 允许为空（NULL = 没有公告）；维护模式存 '0'/'1'。
            sa.Column("value", sa.Text(), nullable=True),
            sa.Column("updated_at", sa.Integer(), nullable=False),
        )


def downgrade() -> None:
    """反向删两张新表 + users 三列（仅空库/测试回滚）。"""
    tables = _table_names()
    for table in (CREDIT_TRANSACTIONS, APP_SETTINGS):
        if table in tables:
            op.drop_table(table)

    if USERS in _table_names():
        columns = _column_names(USERS)
        with op.batch_alter_table(USERS) as batch_op:
            for column in ("status", "credits", "username"):
                if column in columns:
                    batch_op.drop_column(column)
