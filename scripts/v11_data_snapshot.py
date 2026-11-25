#!/usr/bin/env python3
"""v1.1 迁移前后数据快照 / 比对（只读，不改任何数据）。

用途（P2-41 运维）：

1. 迁移**前**对数据库与用户目录取一份快照（JSON），作为"迁移前基线"；
2. 迁移**后**再取一份，与基线比对：表有没有凭空消失、行数有没有变、关键表
   内容哈希是否一致、PRAGMA integrity_check / foreign_key_check 是否通过、
   `data/users/` 文件数与聚合哈希是否一致。

比对口径刻意"少读少算"：只做只读查询，按"整表行内容哈希"比较，不打印任何
用户数据行；输出里只有表名、行数、哈希。数据库默认以 `mode=ro` 打开。

用法：

    # 取基线（建议：服务停写后执行，或对迁移前备份里的 app.db 执行）
    python3 scripts/v11_data_snapshot.py --db data/app.db --users data/users \
        --out /tmp/v11-snapshot-pre.json

    # 迁移后取快照并与基线比对
    python3 scripts/v11_data_snapshot.py --db data/app.db --users data/users \
        --out /tmp/v11-snapshot-post.json --compare /tmp/v11-snapshot-pre.json

    # 允许"新增表"（v1.1 预期新增 auth_tokens / feedback）
    ... --compare pre.json --allow-new auth_tokens,feedback

    # 新增列（0033 的 users.email_verified_at）默认已忽略；其它列按需追加
    ... --ignore-column users.email_verified_at

退出码：0 = 通过（可有 WARN）；1 = 有 FAIL；2 = 参数/环境错误。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

FORMAT_VERSION = 1

#: v1.1（migration 0033）预期新增的表。比对时这些"多出来的表"算预期，不算 FAIL；
#: 其它未登记的新增表会 FAIL（避免"顺手建表"悄悄进生产）。
DEFAULT_ALLOW_NEW = ("auth_tokens", "feedback")

#: v1.1（migration 0033）在旧表上新增的列。比对哈希时忽略，保证"旧行内容不变"可比。
DEFAULT_IGNORE_COLUMNS = ("users.email_verified_at",)

#: 这些表只做行数比对、不做内容哈希（版本表每行就是一行字符串，本来就变）。
NO_HASH_TABLES = ("alembic_version",)


def die(msg: str, code: int = 2) -> "None":
    print("[snapshot] 错误：%s" % msg, file=sys.stderr)
    raise SystemExit(code)


def log(msg: str) -> None:
    print("[snapshot] %s" % msg)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def connect_ro(db_path: Path) -> sqlite3.Connection:
    """只读连接。WAL 库需要同目录可写的 -shm；失败时给出可执行的提示。"""
    uri = db_path.resolve().as_uri() + "?mode=ro"
    try:
        con = sqlite3.connect(uri, uri=True, timeout=15)
        con.execute("PRAGMA query_only=1")
        return con
    except sqlite3.OperationalError as exc:  # pragma: no cover - 环境相关
        die(
            "无法以只读方式打开数据库：%s（%s）。"
            "若服务正在写入 WAL，请先停写或改用迁移前备份里的 app.db。"
            % (db_path, exc)
        )
        raise  # pragma: no cover


def scalar(con: sqlite3.Connection, sql: str):
    row = con.execute(sql).fetchone()
    return None if row is None else row[0]


def table_names(con: sqlite3.Connection) -> "list[str]":
    rows = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    return [r[0] for r in rows]


def table_columns(con: sqlite3.Connection, table: str) -> "list[str]":
    escaped = table.replace('"', '""')
    return [r[1] for r in con.execute('PRAGMA table_info("%s")' % escaped)]


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def canonical_value(value) -> str:
    if value is None:
        return "\\N"
    if isinstance(value, (bytes, bytearray)):
        return value.hex()
    text = str(value)
    return text.encode("utf-8", "surrogateescape").decode("utf-8", "surrogateescape")


def table_fingerprint(
    con: sqlite3.Connection, table: str, ignore_columns: "set[str]"
) -> "tuple[int, str, list, list]":
    """返回 (行数, 内容哈希, 实际列, 参与哈希的列)。

    行内容按列值拼接后排序再哈希：与物理行序、page 布局、VACUUM 无关；
    只依赖行内容本身，所以"迁移只加列"时旧值哈希必须不变。
    """
    columns = table_columns(con, table)
    if table in NO_HASH_TABLES:
        rows = scalar(con, "SELECT count(*) FROM %s" % quote_ident(table))
        return int(rows or 0), "", columns, []
    used = [c for c in columns if c not in ignore_columns]
    if not used:
        return 0, sha256_bytes(b""), columns, []
    select_list = ", ".join(quote_ident(c) for c in used)
    rows = []
    for row in con.execute(
        "SELECT %s FROM %s" % (select_list, quote_ident(table))
    ):
        rows.append("\x1f".join(canonical_value(v) for v in row))
    rows.sort()
    h = hashlib.sha256()
    h.update(("\x1e".join(used)).encode("utf-8", "surrogateescape"))
    h.update(b"\n")
    for text in rows:
        h.update(text.encode("utf-8", "surrogateescape"))
        h.update(b"\n")
    return len(rows), h.hexdigest(), columns, used


def dir_fingerprint(root: Path) -> "dict":
    """与 scripts/backup.sh 的 USERS_TREE_SHA256 同一算法：

    对排序后的文件逐个取 sha256，按 `<filehash>  <相对路径>` 行拼接后再哈希，
    相对路径带 `./` 前缀（因为 backup.sh 用 `find . -type f`）。这样运维可以拿
    本工具的输出直接和备份 manifest.env 里的值对照。
    """
    info = {"path": str(root), "exists": root.is_dir(), "file_count": 0, "sha256": ""}
    if not root.is_dir():
        info["sha256"] = sha256_bytes(b"")
        return info
    rels = []
    for base, _dirs, files in os.walk(root):
        for name in files:
            full = Path(base) / name
            if full.is_symlink() or not full.is_file():
                continue
            rels.append(os.path.relpath(str(full), str(root)))
    rels.sort()
    h = hashlib.sha256()
    for rel in rels:
        full = root / rel
        try:
            fh = sha256_file(full)
        except OSError:
            fh = "unreadable"
        rel_posix = rel.replace(os.sep, "/")
        line = "%s  ./%s\n" % (fh, rel_posix)
        h.update(line.encode("utf-8", "surrogateescape"))
    info["file_count"] = len(rels)
    info["sha256"] = h.hexdigest()
    return info


def build_snapshot(args) -> "dict":
    db_path = Path(args.db)
    if not db_path.is_file():
        die("找不到数据库：%s" % db_path)
    users_dir = Path(args.users) if args.users else None
    ignore_pairs = set(args.ignore_column or ()) | set(DEFAULT_IGNORE_COLUMNS)

    con = connect_ro(db_path)
    try:
        tables = table_names(con)
        ignore_by_table = {}
        for pair in ignore_pairs:
            if "." not in pair:
                die("--ignore-column 需要 `表.列` 形式：%s" % pair)
            table, column = pair.split(".", 1)
            ignore_by_table.setdefault(table, set()).add(column)

        integrity = scalar(con, "PRAGMA integrity_check")
        fk_rows = con.execute("PRAGMA foreign_key_check").fetchall()
        journal_mode = scalar(con, "PRAGMA journal_mode")
        page_size = scalar(con, "PRAGMA page_size")
        page_count = scalar(con, "PRAGMA page_count")
        user_version = scalar(con, "PRAGMA user_version")
        alembic = None
        if "alembic_version" in tables:
            alembic = scalar(
                con, "SELECT group_concat(version_num, ',') FROM alembic_version"
            )

        table_info = {}
        for table in tables:
            rows, digest, columns, hashed = table_fingerprint(
                con, table, ignore_by_table.get(table, set())
            )
            table_info[table] = {
                "rows": rows,
                "sha256": digest,
                "columns": columns,
                "hashed_columns": hashed,
            }
    finally:
        con.close()

    snapshot = {
        "format": FORMAT_VERSION,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "db": {
            "path": str(db_path.resolve()),
            "bytes": db_path.stat().st_size,
            "sha256_file": sha256_file(db_path),
        },
        "sqlite": {
            "integrity_check": integrity,
            "foreign_key_check_count": len(fk_rows),
            "foreign_key_check_sample": [list(r) for r in fk_rows[:5]],
            "journal_mode": journal_mode,
            "page_size": page_size,
            "page_count": page_count,
            "user_version": user_version,
        },
        "alembic_version": alembic,
        "table_count": len(tables),
        "tables": table_info,
        "users_dir": dir_fingerprint(users_dir) if users_dir else None,
        "ignore_columns": sorted(ignore_pairs),
    }
    return snapshot


def fmt_mapping(mapping) -> str:
    return ",".join("%s:%s" % (k, mapping[k]) for k in sorted(mapping))


def compare_snapshots(
    pre: "dict", post: "dict", allow_new: "set[str]",
    allow_row_change: "set[str] | None" = None,
    allow_hash_change: "set[str] | None" = None,
) -> "tuple[int, int, int]":
    """返回 (fail, warn, pass)。比较前/后两份快照。

    ``allow_row_change`` / ``allow_hash_change`` 只用于**已登记的跨版本预期
    变化**（例如 0030 插入 model_prices 行、0027/0029 给 word_states 加列）。
    未登记的变化仍然 FAIL；不要用它们掩盖未知差异。
    """
    allow_row_change = allow_row_change or set()
    allow_hash_change = allow_hash_change or set()
    fails = warns = passes = 0

    def ok(msg):
        nonlocal passes
        passes += 1
        print("[PASS] %s" % msg)

    def warn(msg):
        nonlocal warns
        warns += 1
        print("[WARN] %s" % msg)

    def bad(msg):
        nonlocal fails
        fails += 1
        print("[FAIL] %s" % msg)

    # ---- SQLite 层面 ----
    for label, snap in (("迁移前", pre), ("迁移后", post)):
        integrity = snap["sqlite"]["integrity_check"]
        if integrity == "ok":
            ok("%s PRAGMA integrity_check=ok" % label)
        else:
            bad("%s PRAGMA integrity_check=%r" % (label, integrity))
        fk_count = snap["sqlite"]["foreign_key_check_count"]
        if fk_count == 0:
            ok("%s PRAGMA foreign_key_check 无违规" % label)
        else:
            bad("%s PRAGMA foreign_key_check 有 %s 条违规：%s"
                % (label, fk_count, snap["sqlite"]["foreign_key_check_sample"]))

    if pre["sqlite"]["journal_mode"] != post["sqlite"]["journal_mode"]:
        bad("journal_mode 变化：%s -> %s"
            % (pre["sqlite"]["journal_mode"], post["sqlite"]["journal_mode"]))
    else:
        ok("journal_mode 不变：%s" % pre["sqlite"]["journal_mode"])

    pre_tables = pre["tables"]
    post_tables = post["tables"]
    removed = sorted(set(pre_tables) - set(post_tables))
    added = sorted(set(post_tables) - set(pre_tables))
    common = sorted(set(pre_tables) & set(post_tables))

    if removed:
        bad("表消失：%s" % ",".join(removed))
    else:
        ok("没有表消失（迁移前 %s 张）" % len(pre_tables))

    unexpected_added = [t for t in added if t not in allow_new]
    expected_added = [t for t in added if t in allow_new]
    if expected_added:
        ok("预期新增表：%s" % ",".join(
            "%s(%s 行)" % (t, post_tables[t]["rows"]) for t in expected_added))
    if unexpected_added:
        bad("未登记的新增表：%s（确认是否预期；确认后加 --allow-new）"
            % ",".join(unexpected_added))

    # ---- 行数与内容哈希（共同表）----
    row_mismatch = []
    expected_row_change = []
    hash_mismatch = []
    expected_hash_change = []
    for table in common:
        before = pre_tables[table]
        after = post_tables[table]
        if before["rows"] != after["rows"]:
            label = "%s(%s->%s)" % (table, before["rows"], after["rows"])
            if table in allow_row_change:
                expected_row_change.append(label)
            else:
                row_mismatch.append(label)
        elif after["sha256"] and before["sha256"] != after["sha256"]:
            if table in allow_hash_change:
                expected_hash_change.append(table)
            else:
                hash_mismatch.append(table)
    if expected_row_change:
        ok("预期行数变化：%s" % ",".join(expected_row_change))
    if expected_hash_change:
        ok("预期内容哈希变化：%s" % ",".join(expected_hash_change))
    if row_mismatch:
        bad("行数变化：%s" % ",".join(row_mismatch))
    else:
        ok("共同表行数一致（%s 张）" % len(common))
    if hash_mismatch:
        bad("表内容哈希变化：%s" % ",".join(hash_mismatch))
    else:
        ok("共同表内容哈希一致（%s 张）" % len([t for t in common if post_tables[t]["sha256"]]))

    # 新表的列集合（便于核对 0033 建了什么）
    for table in expected_added:
        cols = post_tables[table]["columns"]
        ok("新增表 %s 列：%s" % (table, ",".join(cols)))

    # 旧表新增列（忽略哈希的列应在这里出现，说明"只加列"）
    new_columns = []
    for table in common:
        before_cols = set(pre_tables[table]["columns"])
        after_cols = set(post_tables[table]["columns"])
        for column in sorted(after_cols - before_cols):
            new_columns.append("%s.%s" % (table, column))
        for column in sorted(before_cols - after_cols):
            bad("列被删除：%s.%s" % (table, column))
    if new_columns:
        ok("旧表新增列（行内容不受影响）：%s" % ",".join(new_columns))
    else:
        ok("旧表列集合不变")

    # ---- alembic ----
    if pre["alembic_version"] != post["alembic_version"]:
        print("[INFO] alembic_version：%s -> %s"
              % (pre["alembic_version"], post["alembic_version"]))
    else:
        print("[INFO] alembic_version 未变：%s" % post["alembic_version"])

    # ---- 用户目录 ----
    pre_users = pre.get("users_dir")
    post_users = post.get("users_dir")
    if pre_users and post_users:
        if pre_users["file_count"] != post_users["file_count"]:
            bad("data/users 文件数变化：%s -> %s"
                % (pre_users["file_count"], post_users["file_count"]))
        elif pre_users["sha256"] != post_users["sha256"]:
            bad("data/users 聚合 SHA256 变化（文件内容被改动）")
        else:
            ok("data/users 一致：%s 个文件，聚合 SHA256 相同"
               % post_users["file_count"])
    else:
        warn("未比对 data/users（未传 --users）")

    # ---- 体量 ----
    print("[INFO] app.db 文件字节：%s -> %s"
          % (pre["db"]["bytes"], post["db"]["bytes"]))
    return fails, warns, passes


def main(argv: "list[str]") -> int:
    parser = argparse.ArgumentParser(
        description="v1.1 迁移前后只读数据快照与比对",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--db", required=True, help="SQLite 数据库路径（只读打开）")
    parser.add_argument("--users", default="", help="用户数据目录（默认不比对）")
    parser.add_argument("--out", default="", help="把本次快照写到该 JSON 路径")
    parser.add_argument("--compare", default="", help="与这份基线快照比对")
    parser.add_argument(
        "--allow-new", default=",".join(DEFAULT_ALLOW_NEW),
        help="允许新增的表（逗号分隔；默认 %s）" % ",".join(DEFAULT_ALLOW_NEW),
    )
    parser.add_argument(
        "--ignore-column", action="append", default=[],
        help="比对哈希时忽略的列，`表.列`；默认已忽略 users.email_verified_at",
    )
    parser.add_argument(
        "--allow-row-change", action="append", default=[],
        help="允许行数变化（可重复/逗号分隔），只用于已登记的跨版本预期",
    )
    parser.add_argument(
        "--allow-hash-change", action="append", default=[],
        help="允许内容哈希变化（可重复/逗号分隔），只用于已登记的跨版本预期",
    )
    parser.add_argument("--quiet", action="store_true", help="只输出结论行")
    args = parser.parse_args(argv)

    snapshot = build_snapshot(args)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(snapshot, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        log("快照已写入：%s（sha256=%s）"
            % (out_path, sha256_file(out_path)[:16]))

    print("[INFO] %s 表 / 共 %s 行 / alembic_version=%s / integrity=%s / FK 违规=%s"
          % (snapshot["table_count"],
             sum(t["rows"] for t in snapshot["tables"].values()),
             snapshot["alembic_version"],
             snapshot["sqlite"]["integrity_check"],
             snapshot["sqlite"]["foreign_key_check_count"]))
    if snapshot.get("users_dir"):
        print("[INFO] users 目录：%s 个文件 / 聚合 SHA256=%s"
              % (snapshot["users_dir"]["file_count"],
                 (snapshot["users_dir"]["sha256"] or "")[:16]))

    if not args.compare:
        return 0

    compare_path = Path(args.compare)
    if not compare_path.is_file():
        die("找不到基线快照：%s" % compare_path)
    try:
        pre = json.loads(compare_path.read_text(encoding="utf-8"))
    except ValueError as exc:
        die("基线快照不是合法 JSON：%s（%s）" % (compare_path, exc))
        raise  # pragma: no cover
    if pre.get("format") != FORMAT_VERSION:
        die("基线快照格式版本不匹配：%r（期望 %s）"
            % (pre.get("format"), FORMAT_VERSION))

    allow_new = {t.strip() for t in args.allow_new.split(",") if t.strip()}
    allow_row_change = {
        t.strip() for value in args.allow_row_change for t in value.split(",") if t.strip()
    }
    allow_hash_change = {
        t.strip() for value in args.allow_hash_change for t in value.split(",") if t.strip()
    }
    fails, warns, passes = compare_snapshots(
        pre, snapshot, allow_new, allow_row_change, allow_hash_change
    )
    print("[SUMMARY] PASS=%s WARN=%s FAIL=%s" % (passes, warns, fails))
    if fails:
        print("迁移校验：FAIL（%s 项）" % fails)
        return 1
    print("迁移校验：PASS%s" % ("（有 WARN，见上）" if warns else ""))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except KeyboardInterrupt:  # pragma: no cover
        raise SystemExit(130)
