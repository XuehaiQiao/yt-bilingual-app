"""seed_band_fix：旧词汇量回填行不再给假区间（v1.1 D8-2）

Revision ID: 0026_seed_band_fix
Revises: 0025_balance_cost
Create Date: 2026-11-21

0014 的种子画像把「词汇量点估计」映射成区间：C1 点会被推到上界 C2，
形成 ``B2–C2``。推荐侧 ``normalize_band`` 只认 A1–C1，于是整条链路拿不到
合法带、回退到默认 A2–B1（本地实测 ``recommend.profile_band`` 返回
``(None, True)``）。

按 v1.1 D8-2 的裁决：**种子行只保留点估计（``cefr_point``），不展示区间**；
用户完成一次定位测后再由真实证据给出区间。本迁移只清空种子行的
``cefr_low`` / ``cefr_high``，不动 ``cefr_point`` 与 ``details``。

历史迁移 0014 不回改（已执行的迁移不可改写）；读取侧 ``ability._display_band``
同时做了兜底，未跑本迁移的库也不会再展示假区间。
"""
from __future__ import annotations

from alembic import op
from sqlalchemy import inspect

revision: str = "0026_seed_band_fix"
down_revision: str = "0025_balance_cost"
branch_labels = None
depends_on = None


def _table_exists(name: str) -> bool:
    return name in set(inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    if not _table_exists("user_skill_profiles"):
        return
    # details 由 json.dumps 写入；用 LIKE 而不是 json_extract，避免历史脏行解析失败。
    op.execute(
        "UPDATE user_skill_profiles "
        "SET cefr_low = NULL, cefr_high = NULL "
        "WHERE (cefr_low IS NOT NULL OR cefr_high IS NOT NULL) "
        "AND details LIKE '%\"legacy_seed\"%'"
    )


def downgrade() -> None:
    """不可逆：被删掉的是错误的 C2 上界，没有可信的旧值可写回。

    回滚后读取侧仍会抑制种子行区间（``ability._display_band``），所以降级
    不会让假区间重新出现在能力档案里。
    """
    pass
