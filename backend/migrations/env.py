"""Alembic 运行环境：数据库地址与 backend/config.py 同源。

优先级：

1. 环境变量 ``AUTH_DB_PATH``（运维/测试显式覆盖；子进程跑迁移时最可靠）；
2. ``backend/config.py`` 的 ``AUTH_DB_PATH``（默认 ``data/app.db``）。

本项目不维护 SQLAlchemy ORM 模型（运行时代码用标准库 ``sqlite3``），迁移全部
手写；基线 ``0001_baseline`` 的字段/索引以 ``backend/auth_db.py`` 为准。
"""
from __future__ import annotations

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import create_engine, pool

# env.py 在 backend/migrations/ 下；把 backend/ 加进 sys.path，这样无论从哪个
# 目录执行 alembic 都能 import 到 config.py。
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# 手写迁移，没有可 autogenerate 对比的 metadata。
target_metadata = None

# SQLite 的 ALTER 能力有限：后续涉及改列的迁移必须走 batch 模式。
render_as_batch = True


def _db_path() -> str:
    """数据库文件路径：环境变量显式指定优先，否则用应用配置。"""
    explicit = os.environ.get("AUTH_DB_PATH", "").strip()
    if explicit:
        return explicit
    import config as app_config  # 局部导入，避免与 alembic 的 config 重名

    return app_config.AUTH_DB_PATH


def _database_url() -> str:
    return f"sqlite:///{os.path.abspath(_db_path())}"


def run_migrations_offline() -> None:
    """离线模式：只输出 SQL，不连库、不建目录。"""
    context.configure(
        url=_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=render_as_batch,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """在线模式：直接连 sqlite 文件执行迁移。"""
    path = os.path.abspath(_db_path())
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)

    connectable = create_engine(
        f"sqlite:///{path}", poolclass=pool.NullPool
    )
    try:
        with connectable.connect() as connection:
            context.configure(
                connection=connection,
                target_metadata=target_metadata,
                render_as_batch=render_as_batch,
                compare_type=True,
            )
            with context.begin_transaction():
                context.run_migrations()
    finally:
        connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
