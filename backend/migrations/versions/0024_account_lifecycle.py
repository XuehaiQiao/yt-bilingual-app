"""account_lifecycle：账号删除冷静期 / 数据导出任务 / 管理员审计

Revision ID: 0024_account_lifecycle
Revises: 0023_invite_registration
Create Date: 2026-11-20

M2a「账号删除/导出」的后端数据层（specs/033-account-lifecycle）。三张表：

- ``account_deletion_requests``：一次删除申请一行。
  - ``user_id_hash``：sha256(user_id)，**不存明文 user_id**；完成后仍只保留
    摘要（删除审计口径见 ``docs/项目提案-上线功能.md`` §4.3.4 / §4.3.5）。
  - ``requested_at_ms`` / ``due_at_ms``：申请时间与 7 天冷静期到期时间（毫秒 UTC）。
  - ``status``：``pending`` / ``cancelled`` / ``completed`` / ``failed``。
  - ``verified_via``：``session_password``（本迁移实现）或 ``support_manual``
    （人工客服核验，预留给运维；M2a 代码只产生前者）。
  - ``reason``：用户填写的可选原因；管理员执行原因写 ``admin_audit_log``。
  - ``operator_id``：执行硬删除的管理员 id（或脚本标识）。
  - ``completed_at_ms`` / ``counts_json`` / ``error``：终态时间、各表删除计数、
    失败诊断。``counts_json`` 不含 PII。
  - 部分唯一索引 ``ux_account_deletion_requests_pending``：同一 ``user_id_hash``
    同时只能有一条 ``pending`` 申请（取消/失败后可重新申请）。

- ``data_export_jobs``：一次导出任务一行。
  - ``id``：``exp-<uuid4 hex>``，应用生成；``user_id``：申请人。
  - ``status``：``queued`` / ``running`` / ``ready`` / ``failed`` / ``expired``。
  - ``requested_at_ms`` / ``completed_at_ms`` / ``expires_at_ms``：毫秒 UTC。
  - ``file_path``：相对 ``EXPORTS_DIR`` 的 ZIP 路径（**不存客户端提供的路径**）。
  - ``size_bytes``：ZIP 大小；``download_token_hash``：一次性下载 token 的
    sha256，不存明文。
  - ``downloaded_at_ms``：首次成功下载时间；``error``：失败诊断。
  - 部分唯一索引 ``ux_data_export_jobs_active``：同一用户同时只能有一个
    ``queued`` / ``running`` 任务。

- ``admin_audit_log``：管理员（以及删除/导出这类关键账号操作）的最小审计。
  - ``actor_id`` / ``action`` / ``target_type`` / ``target_id`` / ``detail_json``
    / ``request_id`` / ``created_at_ms``。
  - 删除相关记录的 ``target_id`` 使用 ``user_id_hash``，不写明文 user id。

约束/索引：

- 三张表都有状态 CHECK；删除申请 ``due_at_ms >= requested_at_ms``；导出任务
  ``expires_at_ms IS NULL OR expires_at_ms >= requested_at_ms``。
- 删除申请：``(user_id_hash, requested_at_ms)`` 查询索引、``(status, due_at_ms)``
  到期扫描索引 + 上面说的 pending 部分唯一索引。
- 导出任务：``(user_id, requested_at_ms)`` 列表/限流索引、``(status, expires_at_ms)``
  清理索引 + active 部分唯一索引。
- 审计：``(created_at_ms)``、``(actor_id, created_at_ms)``、``(target_type, target_id)``。

**不修改** ``users`` / ``sessions`` 结构；不改其它表。``upgrade`` / ``downgrade``
都先查 inspector 再操作，可重复执行。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0024_account_lifecycle"
down_revision: str = "0023_invite_registration"
branch_labels: str | None = None
depends_on: str | None = None

DELETION = "account_deletion_requests"
EXPORT = "data_export_jobs"
AUDIT = "admin_audit_log"

IX_DELETION_USER = "ix_account_deletion_requests_user_hash"
IX_DELETION_STATUS_DUE = "ix_account_deletion_requests_status_due"
UX_DELETION_PENDING = "ux_account_deletion_requests_pending"

IX_EXPORT_USER = "ix_data_export_jobs_user_requested"
IX_EXPORT_STATUS_EXPIRES = "ix_data_export_jobs_status_expires"
UX_EXPORT_ACTIVE = "ux_data_export_jobs_active"

IX_AUDIT_CREATED = "ix_admin_audit_created"
IX_AUDIT_ACTOR = "ix_admin_audit_actor_created"
IX_AUDIT_TARGET = "ix_admin_audit_target"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {index["name"] for index in inspector.get_indexes(table)}


def upgrade() -> None:
    """建三张账号生命周期表；不触碰 users/sessions。"""
    if DELETION not in _table_names():
        op.create_table(
            DELETION,
            sa.Column("id", sa.Text(), primary_key=True, nullable=False),
            sa.Column("user_id_hash", sa.Text(), nullable=False),
            sa.Column("requested_at_ms", sa.Integer(), nullable=False),
            sa.Column("due_at_ms", sa.Integer(), nullable=False),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("verified_via", sa.Text(), nullable=False),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column("operator_id", sa.Text(), nullable=True),
            sa.Column("completed_at_ms", sa.Integer(), nullable=True),
            sa.Column("counts_json", sa.Text(), nullable=True),
            sa.Column("error", sa.Text(), nullable=True),
            sa.CheckConstraint(
                "status IN ('pending','cancelled','completed','failed')",
                name="ck_account_deletion_requests_status",
            ),
            sa.CheckConstraint(
                "requested_at_ms >= 0 AND due_at_ms >= requested_at_ms",
                name="ck_account_deletion_requests_times",
            ),
            sa.CheckConstraint(
                "verified_via IN ('session_password','support_manual')",
                name="ck_account_deletion_requests_verified_via",
            ),
        )

    deletion_indexes = _index_names(DELETION)
    if IX_DELETION_USER not in deletion_indexes:
        op.create_index(
            IX_DELETION_USER, DELETION, ["user_id_hash", "requested_at_ms"]
        )
    if IX_DELETION_STATUS_DUE not in deletion_indexes:
        op.create_index(
            IX_DELETION_STATUS_DUE, DELETION, ["status", "due_at_ms"]
        )
    if UX_DELETION_PENDING not in deletion_indexes:
        op.create_index(
            UX_DELETION_PENDING,
            DELETION,
            ["user_id_hash"],
            unique=True,
            sqlite_where=sa.text("status = 'pending'"),
        )

    if EXPORT not in _table_names():
        op.create_table(
            EXPORT,
            sa.Column("id", sa.Text(), primary_key=True, nullable=False),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("requested_at_ms", sa.Integer(), nullable=False),
            sa.Column("completed_at_ms", sa.Integer(), nullable=True),
            sa.Column("expires_at_ms", sa.Integer(), nullable=True),
            sa.Column("file_path", sa.Text(), nullable=True),
            sa.Column("size_bytes", sa.Integer(), nullable=True),
            sa.Column("download_token_hash", sa.Text(), nullable=True),
            sa.Column("downloaded_at_ms", sa.Integer(), nullable=True),
            sa.Column("error", sa.Text(), nullable=True),
            sa.CheckConstraint(
                "status IN ('queued','running','ready','failed','expired')",
                name="ck_data_export_jobs_status",
            ),
            sa.CheckConstraint(
                "requested_at_ms >= 0",
                name="ck_data_export_jobs_requested_at",
            ),
            sa.CheckConstraint(
                "expires_at_ms IS NULL OR expires_at_ms >= requested_at_ms",
                name="ck_data_export_jobs_expires_at",
            ),
            sa.CheckConstraint(
                "size_bytes IS NULL OR size_bytes >= 0",
                name="ck_data_export_jobs_size_bytes",
            ),
        )

    export_indexes = _index_names(EXPORT)
    if IX_EXPORT_USER not in export_indexes:
        op.create_index(
            IX_EXPORT_USER, EXPORT, ["user_id", "requested_at_ms"]
        )
    if IX_EXPORT_STATUS_EXPIRES not in export_indexes:
        op.create_index(
            IX_EXPORT_STATUS_EXPIRES, EXPORT, ["status", "expires_at_ms"]
        )
    if UX_EXPORT_ACTIVE not in export_indexes:
        op.create_index(
            UX_EXPORT_ACTIVE,
            EXPORT,
            ["user_id"],
            unique=True,
            sqlite_where=sa.text("status IN ('queued','running')"),
        )

    if AUDIT not in _table_names():
        op.create_table(
            AUDIT,
            sa.Column("id", sa.Text(), primary_key=True, nullable=False),
            sa.Column("actor_id", sa.Text(), nullable=False),
            sa.Column("action", sa.Text(), nullable=False),
            sa.Column("target_type", sa.Text(), nullable=True),
            sa.Column("target_id", sa.Text(), nullable=True),
            sa.Column("detail_json", sa.Text(), nullable=True),
            sa.Column("request_id", sa.Text(), nullable=True),
            sa.Column("created_at_ms", sa.Integer(), nullable=False),
            sa.CheckConstraint(
                "created_at_ms >= 0",
                name="ck_admin_audit_created_at",
            ),
        )

    audit_indexes = _index_names(AUDIT)
    if IX_AUDIT_CREATED not in audit_indexes:
        op.create_index(IX_AUDIT_CREATED, AUDIT, ["created_at_ms"])
    if IX_AUDIT_ACTOR not in audit_indexes:
        op.create_index(IX_AUDIT_ACTOR, AUDIT, ["actor_id", "created_at_ms"])
    if IX_AUDIT_TARGET not in audit_indexes:
        op.create_index(IX_AUDIT_TARGET, AUDIT, ["target_type", "target_id"])


def downgrade() -> None:
    """只删本迁移的三张表（审计 → 导出 → 删除申请）；其它数据不动。"""
    tables = _table_names()
    if AUDIT in tables:
        op.drop_table(AUDIT)
    if EXPORT in tables:
        op.drop_table(EXPORT)
    if DELETION in tables:
        op.drop_table(DELETION)
