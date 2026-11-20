"""invite_registration：邀请码与兑换记录（M1 G1 邀请制）

Revision ID: 0023_invite_registration
Revises: 0022_generated_courses
Create Date: 2026-11-20

G1 邀请制最小集（specs/032-invite-registration）。两张表：

- ``invite_codes``：管理员生成的一次性/限次邀请码。
  - ``id``：``inv-<uuid4 hex>``，应用生成；
  - ``code_hash``：SHA-256/HMAC-SHA256 十六进制摘要，**唯一**；不存明文；
  - ``code_prefix``：归一化码的前 6 位，仅供管理台辨认（不能用于兑换）；
  - ``label``：管理员备注；
  - ``max_uses`` / ``used_count``：次数上限与原子递增的已用次数；
  - ``expires_at_ms``：毫秒 UTC；NULL = 不过期（不建议，但结构上允许）；
  - ``revoked_at_ms`` / ``revoked_by``：撤销时间与操作人；
  - ``created_by``：创建管理员 user id；
  - ``created_at_ms`` / ``last_used_at_ms``：毫秒 UTC。

- ``invite_redemptions``：一次成功兑换对应一行。
  - ``id``：``red-<uuid4 hex>``；
  - ``invite_id`` / ``user_id`` / ``redeemed_at_ms``；
  - ``UNIQUE(invite_id, user_id)``：同一用户不能重复兑换同一邀请码；
  - 不存 email/ip：兑换记录只服务审计/用量，PII 不进这张表（M2 删除策略也简单）。

约束与索引：

- ``code_hash`` 唯一索引 ``ux_invite_codes_code_hash``；
- ``ix_invite_codes_created`` 供管理台按创建时间倒序/分页；
- ``ix_invite_codes_expires`` 供过期筛选；
- ``ix_invite_redemptions_invite`` 供按邀请码查看兑换；
- ``ix_invite_redemptions_user`` 供 M2 按用户删除/导出时查找。

**不修改 users 表**（余额/开户事务属 M3）；不建 ``admin_audit`` 大表，M1 的
创建/撤销审计先走结构化日志（见 ``invites.py``）。

downgrade 只删本迁移的两张表（先 redemptions，再 codes）；users/sessions 与
其它表不动。升级/降级都按表名/索引名判重，可重复执行。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0023_invite_registration"
down_revision: str = "0022_generated_courses"
branch_labels: str | None = None
depends_on: str | None = None

CODES = "invite_codes"
REDEMPTIONS = "invite_redemptions"

UNIQUE_CODE_HASH = "ux_invite_codes_code_hash"
INDEX_CODES_CREATED = "ix_invite_codes_created"
INDEX_CODES_EXPIRES = "ix_invite_codes_expires"
INDEX_REDEMPTIONS_INVITE = "ix_invite_redemptions_invite"
INDEX_REDEMPTIONS_USER = "ix_invite_redemptions_user"
UNIQUE_REDEMPTION_USER = "ux_invite_redemptions_user"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {index["name"] for index in inspector.get_indexes(table)}


def upgrade() -> None:
    """建邀请码与兑换表；不触碰 users/sessions。"""
    if CODES not in _table_names():
        op.create_table(
            CODES,
            sa.Column("id", sa.Text(), primary_key=True, nullable=False),
            sa.Column("code_hash", sa.Text(), nullable=False),
            sa.Column("code_prefix", sa.Text(), nullable=False),
            sa.Column("label", sa.Text(), nullable=True),
            sa.Column(
                "max_uses",
                sa.Integer(),
                nullable=False,
                server_default=sa.text("1"),
            ),
            sa.Column(
                "used_count",
                sa.Integer(),
                nullable=False,
                server_default=sa.text("0"),
            ),
            sa.Column("expires_at_ms", sa.Integer(), nullable=True),
            sa.Column("revoked_at_ms", sa.Integer(), nullable=True),
            sa.Column("revoked_by", sa.Text(), nullable=True),
            sa.Column("created_by", sa.Text(), nullable=False),
            sa.Column("created_at_ms", sa.Integer(), nullable=False),
            sa.Column("last_used_at_ms", sa.Integer(), nullable=True),
            sa.CheckConstraint(
                "max_uses >= 1 AND max_uses <= 10",
                name="ck_invite_codes_max_uses",
            ),
            sa.CheckConstraint(
                "used_count >= 0 AND used_count <= max_uses",
                name="ck_invite_codes_used_count",
            ),
            sa.CheckConstraint(
                "expires_at_ms IS NULL OR expires_at_ms >= 0",
                name="ck_invite_codes_expires",
            ),
            sa.CheckConstraint(
                "created_at_ms >= 0",
                name="ck_invite_codes_created_at",
            ),
        )

    indexes = _index_names(CODES)
    if UNIQUE_CODE_HASH not in indexes:
        op.create_index(UNIQUE_CODE_HASH, CODES, ["code_hash"], unique=True)
    if INDEX_CODES_CREATED not in indexes:
        op.create_index(INDEX_CODES_CREATED, CODES, ["created_at_ms"])
    if INDEX_CODES_EXPIRES not in indexes:
        op.create_index(INDEX_CODES_EXPIRES, CODES, ["expires_at_ms"])

    if REDEMPTIONS not in _table_names():
        op.create_table(
            REDEMPTIONS,
            sa.Column("id", sa.Text(), primary_key=True, nullable=False),
            sa.Column("invite_id", sa.Text(), nullable=False),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("redeemed_at_ms", sa.Integer(), nullable=False),
            sa.CheckConstraint(
                "redeemed_at_ms >= 0",
                name="ck_invite_redemptions_redeemed_at",
            ),
        )

    indexes = _index_names(REDEMPTIONS)
    if INDEX_REDEMPTIONS_INVITE not in indexes:
        op.create_index(INDEX_REDEMPTIONS_INVITE, REDEMPTIONS, ["invite_id"])
    if INDEX_REDEMPTIONS_USER not in indexes:
        op.create_index(INDEX_REDEMPTIONS_USER, REDEMPTIONS, ["user_id"])
    if UNIQUE_REDEMPTION_USER not in indexes:
        op.create_index(
            UNIQUE_REDEMPTION_USER,
            REDEMPTIONS,
            ["invite_id", "user_id"],
            unique=True,
        )


def downgrade() -> None:
    """只删兑换记录与邀请码；其它表与数据保留。"""
    tables = _table_names()
    if REDEMPTIONS in tables:
        op.drop_table(REDEMPTIONS)
    if CODES in tables:
        op.drop_table(CODES)
