"""迁移/事件测试的公共工具。

测试用**真实 Alembic CLI**（子进程 ``python -m alembic``）跑迁移，而不是在
pytest 进程里调 API：env.py 会执行 ``fileConfig``，在进程内跑会改掉 pytest 的
日志配置；子进程还能顺带验证命令本身可用。

每个用例都把 ``AUTH_DB_PATH`` 指到 ``tmp_path``，绝不碰 ``data/app.db``。
"""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
ALEMBIC_INI = BACKEND_DIR / "alembic.ini"


def run_alembic(db_path: str | Path, *args: str) -> subprocess.CompletedProcess:
    """在独立子进程里跑 alembic 命令（数据库路径经 AUTH_DB_PATH 传入）。"""
    env = os.environ.copy()
    env["AUTH_DB_PATH"] = str(db_path)
    return subprocess.run(
        [sys.executable, "-m", "alembic", "-c", str(ALEMBIC_INI), *args],
        cwd=str(BACKEND_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


def assert_alembic_ok(result: subprocess.CompletedProcess, action: str = "") -> None:
    assert result.returncode == 0, (
        f"alembic {action} 失败\n"
        f"STDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
    )


def table_names(db_path: str | Path) -> set[str]:
    with sqlite3.connect(db_path) as conn:
        return {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }


def index_names(db_path: str | Path, table: str) -> set[str]:
    with sqlite3.connect(db_path) as conn:
        return {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?",
                (table,),
            )
        }


def columns(db_path: str | Path, table: str) -> dict[str, dict]:
    """列名 → PRAGMA table_info 字段（保持建表顺序）。"""
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {
        row[1]: {
            "type": row[2],
            "notnull": row[3],
            "default": row[4],
            "pk": row[5],
        }
        for row in rows
    }


def revision(db_path: str | Path) -> str | None:
    """alembic_version 里的当前版本；没有版本表返回 None。"""
    with sqlite3.connect(db_path) as conn:
        if "alembic_version" not in {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }:
            return None
        row = conn.execute("SELECT version_num FROM alembic_version").fetchone()
    return row[0] if row else None
