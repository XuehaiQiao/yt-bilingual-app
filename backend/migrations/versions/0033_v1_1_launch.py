"""v1_1_launch：账号找回 token / 反馈 / 邮箱验证（v1.1 P0）

Revision ID: 0033_v1_1_launch
Revises: 0032_pipeline_timing
Create Date: 2026-11-25

v1.1 上线三项增量（**只加不删**，旧库 ``upgrade head`` 后 users 行数/ID/
password_hash 与其它表数据原样保留）：

1. ``auth_tokens``：一次性账号找回 / 邮箱验证 token。
   - ``id`` INTEGER 主键；
   - ``user_id`` TEXT NOT NULL（token 所属用户；硬删除后 token 自然失效）；
   - ``purpose`` TEXT NOT NULL：``password_reset`` / ``email_verify``（写入层
     收口到 ``auth_db.TOKEN_PURPOSES``；本表不加 CHECK，便于以后新增用途）；
   - ``token_hash`` TEXT NOT NULL：**只存 sha256(token)**，不存明文；唯一索引；
   - ``expires_at_ms`` / ``used_at_ms`` / ``created_at_ms``：毫秒时间戳，
     ``used_at_ms IS NULL`` = 未使用（单次消费靠它 + 原子 UPDATE）；
   - ``email`` TEXT NOT NULL：申请时的规范化邮箱（请求限流与审计用，不改
     ``users.email``）。

   索引：唯一 ``ux_auth_tokens_token_hash``；``(user_id, purpose)`` 按用户；
   ``(email, purpose, created_at_ms)`` 请求限流计数；``(expires_at_ms)`` 清理。

2. ``feedback``：反馈/纠错（P2-39 的 API 写入，本迁移只建表）。
   - ``user_id`` 可空：允许游客/未登录反馈；**故意不建外键**——账号硬删除
     后历史反馈保留（不含密码/PII 之外的账号映射），避免级联删除或悬空约束
     让删除流程失败。用户可见内容（category/message/contact）与处理字段分开；
   - ``request_id``：前端一次提交的稳定 id，便于去重/排查（可空，游客可能没有）；
   - ``category`` / ``message`` NOT NULL；``contact`` 可空；
   - ``status`` NOT NULL DEFAULT ``'open'``（处理状态由 P2-39 定义，本表不加
     CHECK，避免与并行实现的状态机耦合）；
   - ``created_at_ms`` NOT NULL；``resolved_at_ms`` / ``admin_note`` 可空。

   索引：``(status, created_at_ms)`` 管理台待处理队列；``(user_id, created_at_ms)``
   按用户查询。

3. ``users.email_verified_at INTEGER NULL``：NULL = 未验证。**旧用户保持 NULL，
   不强制验证、不强制改密**；验证成功写毫秒时间戳（已有值不覆盖）。

**回滚（downgrade）**：只删本迁移新增的两张表与 ``users.email_verified_at``
列，不触碰 users/sessions 行数据与其它任何表。删列会丢失「已验证」状态，但
旧代码不读该列、新代码对 NULL 一律按未验证处理（登录/使用不受限），因此回滚
是安全的；要保留验证状态请先备份 ``data/app.db``。

**幂等**：``upgrade`` 先查 inspector，表/列已存在（手工建过 / 降级后重新
升级）就跳过；``downgrade`` 同样先判断再删，重复执行安全。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0033_v1_1_launch"
down_revision: str = "0032_pipeline_timing"
branch_labels: str | None = None
depends_on: str | None = None

AUTH_TOKENS = "auth_tokens"
FEEDBACK = "feedback"
USERS = "users"
EMAIL_VERIFIED_COLUMN = "email_verified_at"

UX_AUTH_TOKENS_HASH = "ux_auth_tokens_token_hash"
IX_AUTH_TOKENS_USER_PURPOSE = "ix_auth_tokens_user_purpose"
IX_AUTH_TOKENS_EMAIL_PURPOSE_CREATED = "ix_auth_tokens_email_purpose_created"
IX_AUTH_TOKENS_EXPIRES = "ix_auth_tokens_expires"

IX_FEEDBACK_STATUS_CREATED = "ix_feedback_status_created"
IX_FEEDBACK_USER_CREATED = "ix_feedback_user_created"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {item["name"] for item in inspector.get_indexes(table)}


def _column_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {column["name"] for column in inspector.get_columns(table)}


def _add_email_verified_column() -> None:
    """users.email_verified_at 原地加列（可空，旧行 NULL = 未验证）。"""
    if USERS not in _table_names():
        return
    if EMAIL_VERIFIED_COLUMN in _column_names(USERS):
        return
    op.execute(f"ALTER TABLE {USERS} ADD COLUMN {EMAIL_VERIFIED_COLUMN} INTEGER")


def _drop_email_verified_column() -> None:
    """回滚删列；列不存在时跳过。"""
    if USERS not in _table_names():
        return
    if EMAIL_VERIFIED_COLUMN not in _column_names(USERS):
        return
    with op.batch_alter_table(USERS) as batch_op:
        batch_op.drop_column(EMAIL_VERIFIED_COLUMN)


def upgrade() -> None:
    """建 auth_tokens / feedback，并为 users 加 email_verified_at（可重复执行）。"""
    existing = _table_names()

    if AUTH_TOKENS not in existing:
        op.create_table(
            AUTH_TOKENS,
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("purpose", sa.Text(), nullable=False),
            sa.Column("token_hash", sa.Text(), nullable=False),
            sa.Column("expires_at_ms", sa.Integer(), nullable=False),
            sa.Column("used_at_ms", sa.Integer(), nullable=True),
            sa.Column("created_at_ms", sa.Integer(), nullable=False),
            sa.Column("email", sa.Text(), nullable=False),
        )
        op.create_index(
            UX_AUTH_TOKENS_HASH, AUTH_TOKENS, ["token_hash"], unique=True
        )
        op.create_index(
            IX_AUTH_TOKENS_USER_PURPOSE,
            AUTH_TOKENS,
            ["user_id", "purpose"],
        )
        op.create_index(
            IX_AUTH_TOKENS_EMAIL_PURPOSE_CREATED,
            AUTH_TOKENS,
            ["email", "purpose", "created_at_ms"],
        )
        op.create_index(IX_AUTH_TOKENS_EXPIRES, AUTH_TOKENS, ["expires_at_ms"])
    else:
        # 表已存在（手工建过/降级后重升）：补齐索引，不重复建索引。
        indexes = _index_names(AUTH_TOKENS)
        if UX_AUTH_TOKENS_HASH not in indexes:
            op.create_index(
                UX_AUTH_TOKENS_HASH, AUTH_TOKENS, ["token_hash"], unique=True
            )
        if IX_AUTH_TOKENS_USER_PURPOSE not in indexes:
            op.create_index(
                IX_AUTH_TOKENS_USER_PURPOSE,
                AUTH_TOKENS,
                ["user_id", "purpose"],
            )
        if IX_AUTH_TOKENS_EMAIL_PURPOSE_CREATED not in indexes:
            op.create_index(
                IX_AUTH_TOKENS_EMAIL_PURPOSE_CREATED,
                AUTH_TOKENS,
                ["email", "purpose", "created_at_ms"],
            )
        if IX_AUTH_TOKENS_EXPIRES not in indexes:
            op.create_index(
                IX_AUTH_TOKENS_EXPIRES, AUTH_TOKENS, ["expires_at_ms"]
            )

    if FEEDBACK not in existing:
        op.create_table(
            FEEDBACK,
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.Text(), nullable=True),
            sa.Column("request_id", sa.Text(), nullable=True),
            sa.Column("category", sa.Text(), nullable=False),
            sa.Column("message", sa.Text(), nullable=False),
            sa.Column("contact", sa.Text(), nullable=True),
            sa.Column(
                "status", sa.Text(), nullable=False, server_default="open"
            ),
            sa.Column("created_at_ms", sa.Integer(), nullable=False),
            sa.Column("resolved_at_ms", sa.Integer(), nullable=True),
            sa.Column("admin_note", sa.Text(), nullable=True),
        )
        op.create_index(
            IX_FEEDBACK_STATUS_CREATED, FEEDBACK, ["status", "created_at_ms"]
        )
        op.create_index(
            IX_FEEDBACK_USER_CREATED, FEEDBACK, ["user_id", "created_at_ms"]
        )
    else:
        indexes = _index_names(FEEDBACK)
        if IX_FEEDBACK_STATUS_CREATED not in indexes:
            op.create_index(
                IX_FEEDBACK_STATUS_CREATED, FEEDBACK, ["status", "created_at_ms"]
            )
        if IX_FEEDBACK_USER_CREATED not in indexes:
            op.create_index(
                IX_FEEDBACK_USER_CREATED, FEEDBACK, ["user_id", "created_at_ms"]
            )

    _add_email_verified_column()


def downgrade() -> None:
    """只删本迁移新增的对象；旧表数据（users/sessions 等）保持不动。"""
    # 索引随表删除；先删表再删列，避免重建 users 时扫到无关表。
    if AUTH_TOKENS in _table_names():
        op.drop_table(AUTH_TOKENS)
    if FEEDBACK in _table_names():
        op.drop_table(FEEDBACK)
    _drop_email_verified_column()
