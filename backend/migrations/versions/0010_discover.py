"""discover：内容发现的检索词审计与 24h 结果缓存（V1 / specs/017）

Revision ID: 0010_discover
Revises: 0009_placement
Create Date: 2026-11-15

一次「用自然语言找视频」的请求会经过：LLM 改写成 2–3 个英文检索词 →
yt-dlp ``ytsearch`` 并发搜索 → 去重/时长过滤 → 英文字幕轨道探测 → LLM 重排。
本迁移只建一张表，把**检索词与最终候选**留下来做 24 小时缓存与审计：

- ``discover_queries``
  - ``id``：INTEGER PK（自增）；
  - ``user_id``：可空。登录用户 id（游客在路由层被 403，正常不会写）；
    留空是为了脚本/运维/未来匿名预热的审计不因外键失败；
  - ``query_hash``：规范化 query 的 sha256（应用计算；不把原文当键）；
  - ``query``：用户原始主题（去掉控制字符后的文本，便于审计）；
  - ``target_lang``：目标语言，默认 ``zh-CN``；缓存键是
    ``UNIQUE(query_hash, target_lang)``，**已包含语言维度**；
  - ``result``：响应 JSON 文本（检索词 + 候选元数据 + 降级标记；**不存字幕
    正文、不存视频/字幕文件**），用 TEXT 而不是 sa.JSON，避免 SQLite 亲和
    类型改写数字/布尔；
  - ``created_at`` / ``expires_at``：服务端毫秒 UTC；应用按 24h TTL 读取，
    过期即缓存未命中（行保留到下一次同键写入覆盖，便于审计）；
  - 额外索引 ``ix_discover_queries_expires``：按过期时间清理/巡检用。

运行时不建表：未跑本迁移时 ``backend/discover.py`` 的缓存读写按未命中/不写入
降级（只告警一次），发现请求本身仍可用；上线前仍需 ``alembic upgrade head``。
downgrade 只删这一张表，不影响定位测及更早的表。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0010_discover"
down_revision: str = "0009_placement"
branch_labels: str | None = None
depends_on: str | None = None

TABLE = "discover_queries"
INDEX_EXPIRES = "ix_discover_queries_expires"
UNIQUE_HASH_LANG = "ux_discover_queries_hash_lang"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _index_names(table: str) -> set[str]:
    return {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    """建 discover_queries 表与索引（幂等，不碰旧表）。"""
    if TABLE not in _table_names():
        op.create_table(
            TABLE,
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            # 可空：正常请求写 users.id；脚本/运维审计可以留空。
            sa.Column("user_id", sa.Text(), nullable=True),
            sa.Column("query_hash", sa.Text(), nullable=False),
            sa.Column("query", sa.Text(), nullable=False),
            sa.Column(
                "target_lang",
                sa.Text(),
                nullable=False,
                server_default=sa.text("'zh-CN'"),
            ),
            # 响应 JSON 文本；不用 sa.JSON，避免 SQLite 亲和类型改写 bool/数字。
            sa.Column("result", sa.Text(), nullable=False),
            sa.Column("created_at", sa.Integer(), nullable=False),
            sa.Column("expires_at", sa.Integer(), nullable=False),
            sa.UniqueConstraint(
                "query_hash",
                "target_lang",
                name=UNIQUE_HASH_LANG,
            ),
        )

    # 索引单独判断：重复执行/部分应用时也能补齐。
    if INDEX_EXPIRES not in _index_names(TABLE):
        op.create_index(INDEX_EXPIRES, TABLE, ["expires_at"])


def downgrade() -> None:
    """只删 discover_queries（索引随表删除）；仅限空库/测试回滚。"""
    if TABLE in _table_names():
        op.drop_table(TABLE)
