#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""storage_stats.py —— 存储现状只读统计（docs/计划-v1.1.md 任务 7 第一步「量」）

用途：在定「用户总量配额 / 游客 TTL」之前，先把真实分布量出来；阈值由分布决定，不拍脑袋。
本脚本**只量不改**：不清理、不写库、不删文件、不联网。

用法（仓库根目录）：
    python3 scripts/storage_stats.py --db data/app.db --users-dir data/users --guests-dir data/guests
    python3 scripts/storage_stats.py --db data/app.db --users-dir data/users --guests-dir data/guests --json

从 backend/ 目录跑（验证命令）：
    cd backend && venv/bin/python ../scripts/storage_stats.py --db ../data/app.db \\
        --users-dir ../data/users --guests-dir ../data/guests

输出四块：
  1. 数据库：每张表的行数与占用字节（数据页 / 索引页，来自 SQLite dbstat），并标出 14 张关键表；
  2. 按用户聚合：data/users/<user_id>/ 的目录占用、history 文件数/字节、favorites.json 字节，
     以及该用户在库里的行数与估算字节；给出 P50/P90/P99/最大值；
  3. 游客目录 data/guests/*：数量、总字节、每目录分布、最旧目录年龄；
  4. data/ 顶层：库文件、WAL、备份文件等上下文占用。

只读保证：
  * SQLite 以 file:<abs>?mode=ro 打开并 PRAGMA query_only=ON，连接层就拒绝写；
  * 文件系统只用 os.scandir/os.stat 读取，不创建、不修改、不删除任何文件；
  * 纯标准库，无网络调用。

退出码：0 正常；2 库文件不存在；3 库打不开（含 WAL/shm 只读受限）。
"""

import argparse
import json
import os
import sqlite3
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

#: 任务 7 明确要求统计的 14 张表：name -> 归属方式
#:   user    —— 表里直接有 user_id
#:   session —— 只有 session_id，需 join 到 <session 表>.id 再拿 user_id
#:   global  —— 全局缓存，无用户归属
KEY_TABLES = {
    "watch_events": "user",
    "learning_events": "user",
    "word_states": "user",
    "review_logs": "user",
    "placement_answers": "session:placement_sessions",
    "placement_sessions": "user",
    "skill_evidence": "user",
    "attempts": "user",
    "exam_answers": "session:exam_sessions",
    "course_attempts": "user",
    "weekly_reports": "user",
    "content_teaching_analysis": "global",
    "ai_usage": "user",
    "content_difficulty": "global",
}

#: 表里带 guest_hash 的（游客在库里留下的痕迹）
GUEST_HASH_TABLES = ("watch_events", "placement_sessions")

#: 用户目录下的子目录（按任务 7 的第二步分类：用户产物 vs 可重建缓存）
USER_SUBDIRS = ("history", "imported-books", "books", ".upload-staging")

NOTES = []


def note(msg):
    """收集非致命说明，最后统一打印/进 JSON。"""
    NOTES.append(msg)


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def human(n):
    """人类可读字节数。"""
    if n is None:
        return "-"
    steps = ("B", "KB", "MB", "GB", "TB")
    v = float(n)
    for unit in steps:
        if v < 1024 or unit == steps[-1]:
            if unit == "B":
                return "%d B" % n
            return "%.2f %s" % (v, unit)
        v /= 1024.0
    return "%d B" % n


def dwidth(s):
    """字符串显示宽度（中文/全角算 2 个终端列）。"""
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in str(s))


def pad(s, width, align="left"):
    """按显示宽度补空格，避免中文表格错位。"""
    s = str(s)
    fill = max(0, width - dwidth(s))
    if align == "right":
        return " " * fill + s
    return s + " " * fill


def fmt_int(n):
    return "-" if n is None else "{:,}".format(int(n))


def fmt_num(n):
    """整数就按整数打印，非整数保留一位小数（分位数插值会出现小数）。"""
    if n is None:
        return "-"
    if abs(n - round(n)) < 1e-9:
        return "{:,}".format(int(round(n)))
    return "{:,.1f}".format(n)


def percentile(values, p):
    """线性插值分位数（等价 statistics.quantiles(method="inclusive") / numpy 默认）。"""
    xs = sorted(v for v in values if v is not None)
    if not xs:
        return None
    if len(xs) == 1:
        return float(xs[0])
    h = (len(xs) - 1) * (p / 100.0)
    lo = int(h)
    frac = h - lo
    if lo + 1 >= len(xs):
        return float(xs[-1])
    return float(xs[lo] + (xs[lo + 1] - xs[lo]) * frac)


def dist_stats(values):
    """一组样本的 n / min / P50 / P90 / P99 / max / 合计。"""
    xs = sorted(v for v in values if v is not None)
    if not xs:
        return {"n": 0, "min": None, "p50": None, "p90": None, "p99": None,
                "max": None, "mean": None, "sum": None}
    return {
        "n": len(xs),
        "min": xs[0],
        "p50": percentile(xs, 50),
        "p90": percentile(xs, 90),
        "p99": percentile(xs, 99),
        "max": xs[-1],
        "mean": sum(xs) / float(len(xs)),
        "sum": sum(xs),
    }


def dist_line(label, d, humanize=True):
    """把 dist_stats 渲染成一行。"""
    if not d or d["n"] == 0:
        return "%-22s n=0（无样本）" % label
    fmt = human if humanize else fmt_num
    return "%s n=%d  min=%s  P50=%s  P90=%s  P99=%s  max=%s" % (
        pad(label, 22), d["n"],
        fmt(d["min"]), fmt(d["p50"]), fmt(d["p90"]), fmt(d["p99"]), fmt(d["max"]),
    )


# ---------------------------------------------------------------------------
# 文件系统（只读）
# ---------------------------------------------------------------------------

def dir_usage(root):
    """递归统计目录：apparent bytes（文件大小之和）、disk bytes（实际占用）、文件数。"""
    apparent = disk = files = 0
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except OSError as exc:
            note("无法读取目录 %s: %s" % (current, exc))
            continue
        for entry in entries:
            try:
                if entry.is_symlink():
                    continue  # 不跟随软链，避免重复计数/越界
                if entry.is_dir(follow_symlinks=False):
                    stack.append(entry.path)
                elif entry.is_file(follow_symlinks=False):
                    st = entry.stat(follow_symlinks=False)
                    apparent += st.st_size
                    disk += getattr(st, "st_blocks", 0) * 512
                    files += 1
            except OSError:
                continue
    return {"apparent": apparent, "disk": disk, "files": files}


def dir_created_at(path):
    """目录的创建/更新时间戳：优先 st_birthtime（macOS），退化 st_mtime。"""
    try:
        st = os.stat(path, follow_symlinks=False)
    except OSError:
        return None
    return getattr(st, "st_birthtime", None) or st.st_mtime


# ---------------------------------------------------------------------------
# 数据库（只读）
# ---------------------------------------------------------------------------

def open_db_readonly(db_path):
    """以只读方式打开 SQLite；返回 (conn, uri)。失败时抛 RuntimeError，由 main 优雅处理。"""
    abspath = str(Path(db_path).resolve())
    uri = "file:%s?mode=ro" % quote(abspath, safe="/")
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=10)
    except sqlite3.Error as exc:
        raise RuntimeError(
            "以只读模式打开数据库失败：%s\n"
            "  若库处于 WAL 模式且 -shm 文件不可读写，SQLite 会拒绝只读连接；"
            "本脚本不会为了读库而写任何文件。" % exc
        )
    conn.execute("PRAGMA query_only = ON")  # 双保险：连接层拒绝写
    return conn, uri


def quote_ident(name):
    return '"%s"' % name.replace('"', '""')


def table_columns(conn, table):
    return [row[1] for row in conn.execute("PRAGMA table_info(%s)" % quote_ident(table))]


def list_tables(conn):
    return [row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )]


def index_to_table(conn, tables):
    """索引名 -> 表名（含 sqlite_autoindex_*，它们不在 sqlite_master 里但有占页）。"""
    mapping = {}
    for table in tables:
        try:
            for row in conn.execute("PRAGMA index_list(%s)" % quote_ident(table)):
                mapping[row[1]] = table
        except sqlite3.Error:
            continue
    return mapping


def table_sizes(conn):
    """用 dbstat 拿每张表的占用（数据页 + 索引页）。不可用时返回 None。"""
    try:
        rows = conn.execute("SELECT name, SUM(pgsize) FROM dbstat GROUP BY name").fetchall()
    except sqlite3.Error as exc:
        note("dbstat 不可用（%s），改为抽样估算表大小。" % exc)
        return None
    tables = set(list_tables(conn))
    idx2tbl = index_to_table(conn, tables)
    sizes = {}
    for name, pages in rows:
        if name in tables:
            table = name
        elif name in idx2tbl:
            table = idx2tbl[name]
        elif name == "sqlite_schema":
            table = "<sqlite_schema>"
        else:
            table = "<unknown:%s>" % name
        sizes.setdefault(table, 0)
        sizes[table] += int(pages or 0)
    return sizes


def estimate_sizes_by_sampling(conn, tables):
    """dbstat 不可用时的退化估算：抽样 200 行的字段长度，再按行数外推。"""
    sizes = {}
    for table in tables:
        total, sampled = 0, 0
        try:
            cursor = conn.execute("SELECT * FROM %s LIMIT 200" % quote_ident(table))
            for row in cursor:
                total += sum(len(v) if isinstance(v, (str, bytes)) else 8 for v in row) + 12
                sampled += 1
            count = conn.execute("SELECT COUNT(*) FROM %s" % quote_ident(table)).fetchone()[0]
        except sqlite3.Error:
            sizes[table] = 0
            continue
        sizes[table] = int(total / sampled * count) if sampled else 0
    note("表大小采用抽样估算（字段长度外推），未含索引页，仅供量级参考。")
    return sizes


def collect_db(db_path, real_user_ids):
    """数据库部分：库文件信息、按表行数/字节、按用户归集、匿名 user_id、游客 hash。"""
    result = {"path": db_path, "exists": os.path.exists(db_path)}
    if not result["exists"]:
        note("数据库文件不存在：%s（跳过数据库统计）" % db_path)
        return {"database": result, "per_user_db": {}, "anonymous": {}, "guest_hash": {}}

    conn, uri = open_db_readonly(db_path)
    result["uri"] = uri
    try:
        st = os.stat(db_path)
        page_size = conn.execute("PRAGMA page_size").fetchone()[0]
        page_count = conn.execute("PRAGMA page_count").fetchone()[0]
        result.update({
            "bytes": st.st_size,
            "page_size": page_size,
            "page_count": page_count,
            "freelist_count": conn.execute("PRAGMA freelist_count").fetchone()[0],
            "journal_mode": (conn.execute("PRAGMA journal_mode").fetchone() or ("?",))[0],
            "query_only": conn.execute("PRAGMA query_only").fetchone()[0],
            "wals": [],
        })
        for suffix in ("-wal", "-shm"):
            p = db_path + suffix
            if os.path.exists(p):
                result["wals"].append({"path": p, "bytes": os.path.getsize(p)})

        tables = list_tables(conn)
        sizes = table_sizes(conn)
        size_method = "dbstat（精确到页，含索引）"
        if sizes is None:
            sizes = estimate_sizes_by_sampling(conn, tables)
            size_method = "抽样估算（无索引页）"
        result["size_method"] = size_method

        # 行数
        counts = {}
        for table in tables:
            try:
                counts[table] = conn.execute(
                    "SELECT COUNT(*) FROM %s" % quote_ident(table)).fetchone()[0]
            except sqlite3.Error as exc:
                counts[table] = None
                note("无法统计表 %s 行数：%s" % (table, exc))

        total_bytes = sum(v or 0 for v in sizes.values()) or 1
        rows = []
        for table in sorted(tables, key=lambda t: (-(sizes.get(t) or 0), t)):
            rows.append({
                "table": table,
                "rows": counts[table],
                "bytes": sizes.get(table, 0),
                "share": (sizes.get(table, 0) or 0) / float(total_bytes),
                "key": table in KEY_TABLES,
                "attribution": KEY_TABLES.get(table, "other"),
            })
        result["tables"] = rows
        result["table_count"] = len(tables)
        result["tables_total_bytes"] = sum(v or 0 for v in sizes.values())
        result["key_tables_present"] = sorted(t for t in KEY_TABLES if t in tables)
        result["key_tables_missing"] = sorted(t for t in KEY_TABLES if t not in tables)
        if result["key_tables_missing"]:
            note("关键表不存在：%s" % ", ".join(result["key_tables_missing"]))

        # ---- 按用户归集（只在真实用户集合上聚合）----
        real = sorted(real_user_ids)
        per_user = {}          # user_id -> {"rows": {...}, "total_rows": int, "est_bytes": int}
        anon = {}              # table -> {"rows": int, "distinct_user_ids": int}
        placeholders = ",".join("?" for _ in real) if real else None

        def record(uid, table, count, est):
            bucket = per_user.setdefault(uid, {"rows": {}, "total_rows": 0, "est_bytes": 0.0})
            bucket["rows"][table] = count
            bucket["total_rows"] += count
            bucket["est_bytes"] += est

        for table, attr in KEY_TABLES.items():
            if table not in counts:
                continue
            table_bytes = sizes.get(table) or 0
            total_rows = counts[table] or 0

            def est(row_count):
                return table_bytes * row_count / float(total_rows) if total_rows else 0.0

            if attr == "user":
                cols = table_columns(conn, table)
                if "user_id" not in cols or not real:
                    continue
                sql = ("SELECT user_id, COUNT(*) FROM %s WHERE user_id IN (%s) GROUP BY user_id"
                       % (quote_ident(table), placeholders))
                for uid, count in conn.execute(sql, real):
                    record(uid, table, count, est(count))
                # 匿名：有 user_id 但不在真实用户集合里
                anon_rows = conn.execute(
                    "SELECT COUNT(*), COUNT(DISTINCT user_id) FROM %s "
                    "WHERE user_id IS NOT NULL AND user_id NOT IN (%s)"
                    % (quote_ident(table), placeholders), real).fetchone()
                if anon_rows and anon_rows[0]:
                    anon[table] = {"rows": anon_rows[0], "distinct_user_ids": anon_rows[1],
                                   "est_bytes": int(est(anon_rows[0]))}
            elif attr.startswith("session:"):
                parent = attr.split(":", 1)[1]
                if parent not in counts or not real:
                    continue
                sql = ("SELECT s.user_id, COUNT(*) FROM %s c JOIN %s s ON s.id = c.session_id "
                       "WHERE s.user_id IN (%s) GROUP BY s.user_id"
                       % (quote_ident(table), quote_ident(parent), placeholders))
                try:
                    for uid, count in conn.execute(sql, real):
                        record(uid, table, count, est(count))
                except sqlite3.Error as exc:
                    note("表 %s 按用户归集失败（join %s）：%s" % (table, parent, exc))
                    continue
                anon_rows = conn.execute(
                    "SELECT COUNT(*), COUNT(DISTINCT s.user_id) FROM %s c JOIN %s s "
                    "ON s.id = c.session_id WHERE s.user_id IS NOT NULL AND s.user_id NOT IN (%s)"
                    % (quote_ident(table), quote_ident(parent), placeholders), real).fetchone()
                if anon_rows and anon_rows[0]:
                    anon[table] = {"rows": anon_rows[0], "distinct_user_ids": anon_rows[1],
                                   "est_bytes": int(est(anon_rows[0]))}

        for uid, bucket in per_user.items():
            bucket["est_bytes"] = int(round(bucket["est_bytes"]))

        # ---- 游客在库里的痕迹 ----
        guest_hash = {}
        for table in GUEST_HASH_TABLES:
            if table not in counts:
                continue
            cols = table_columns(conn, table)
            if "guest_hash" not in cols:
                continue
            row = conn.execute(
                "SELECT COUNT(*), COUNT(DISTINCT guest_hash) FROM %s WHERE guest_hash IS NOT NULL"
                % quote_ident(table)).fetchone()
            guest_hash[table] = {"rows": row[0], "distinct_guest_hashes": row[1]}

        # ---- 全局缓存表（无用户归属）----
        globals_ = {}
        for table, attr in KEY_TABLES.items():
            if attr == "global" and table in counts:
                globals_[table] = {"rows": counts[table], "bytes": sizes.get(table, 0)}
        return {"database": result, "per_user_db": per_user, "anonymous": anon,
                "guest_hash": guest_hash, "global_cache": globals_}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 按用户聚合（文件系统 + 数据库）
# ---------------------------------------------------------------------------

def collect_users(users_dir, db_users, per_user_db):
    """data/users/<user_id>/ 的目录占用 + 该用户库里的行数估算。"""
    result = {"path": users_dir, "exists": os.path.isdir(users_dir), "users": []}
    if not result["exists"]:
        note("用户目录不存在：%s（跳过按用户聚合）" % users_dir)
        return result

    dirs = sorted(d for d in os.listdir(users_dir)
                  if os.path.isdir(os.path.join(users_dir, d)))
    universe = sorted(set(dirs) | set(db_users))
    result["dir_count"] = len(dirs)
    result["db_user_count"] = len(db_users)
    result["only_dir"] = sorted(set(dirs) - set(db_users))
    result["only_db"] = sorted(set(db_users) - set(dirs))

    users = []
    for uid in universe:
        path = os.path.join(users_dir, uid)
        entry = {"user_id": uid, "has_dir": os.path.isdir(path)}
        if entry["has_dir"]:
            usage = dir_usage(path)
            entry.update({"dir_bytes": usage["apparent"], "dir_disk_bytes": usage["disk"],
                          "file_count": usage["files"]})
            history = os.path.join(path, "history")
            hu = dir_usage(history) if os.path.isdir(history) else {"apparent": 0, "files": 0}
            entry["history_files"] = hu["files"]
            entry["history_bytes"] = hu["apparent"]
            books = os.path.join(path, "imported-books")
            entry["imported_books_bytes"] = dir_usage(books)["apparent"] if os.path.isdir(books) else 0
            fav = os.path.join(path, "favorites.json")
            entry["favorites_bytes"] = os.path.getsize(fav) if os.path.isfile(fav) else 0
            subdirs = {}
            for sub in USER_SUBDIRS:
                p = os.path.join(path, sub)
                if os.path.isdir(p):
                    subdirs[sub] = dir_usage(p)["apparent"]
            entry["subdirs_bytes"] = subdirs
        else:
            entry.update({"dir_bytes": 0, "dir_disk_bytes": 0, "file_count": 0,
                          "history_files": 0, "history_bytes": 0,
                          "imported_books_bytes": 0, "favorites_bytes": 0,
                          "subdirs_bytes": {}})
        db = per_user_db.get(uid, {"rows": {}, "total_rows": 0, "est_bytes": 0})
        entry["db_rows"] = db["total_rows"]
        entry["db_est_bytes"] = db["est_bytes"]
        entry["db_rows_by_table"] = db["rows"]
        entry["total_est_bytes"] = entry["dir_bytes"] + entry["db_est_bytes"]
        users.append(entry)

    users.sort(key=lambda u: -u["total_est_bytes"])
    result["users"] = users
    result["user_count"] = len(users)

    metrics = {
        "dir_bytes": [u["dir_bytes"] for u in users],
        "history_bytes": [u["history_bytes"] for u in users],
        "history_files": [u["history_files"] for u in users],
        "favorites_bytes": [u["favorites_bytes"] for u in users],
        "imported_books_bytes": [u["imported_books_bytes"] for u in users],
        "db_rows": [u["db_rows"] for u in users],
        "db_est_bytes": [u["db_est_bytes"] for u in users],
        "total_est_bytes": [u["total_est_bytes"] for u in users],
    }
    result["distributions"] = {k: dist_stats(v) for k, v in metrics.items()}
    return result


# ---------------------------------------------------------------------------
# 游客目录
# ---------------------------------------------------------------------------

def collect_guests(guests_dir, now):
    """data/guests/*：数量、总字节、每目录分布、最旧目录年龄。"""
    result = {"path": guests_dir, "exists": os.path.isdir(guests_dir), "dirs": []}
    if not result["exists"]:
        note("游客目录不存在：%s（跳过游客统计）" % guests_dir)
        return result

    dirs = []
    for entry in os.scandir(guests_dir):
        try:
            if not entry.is_dir(follow_symlinks=False):
                continue
            usage = dir_usage(entry.path)
            created = dir_created_at(entry.path)
            dirs.append({
                "name": entry.name,
                "bytes": usage["apparent"],
                "disk_bytes": usage["disk"],
                "file_count": usage["files"],
                "created_at": created,
                "age_days": (now - created) / 86400.0 if created else None,
            })
        except OSError as exc:
            note("跳过无法读取的游客目录 %s: %s" % (entry.path, exc))

    ages = [d["age_days"] for d in dirs if d["age_days"] is not None]
    sizes = [d["bytes"] for d in dirs]
    nonempty = [d for d in dirs if d["bytes"] > 0]
    dirs.sort(key=lambda d: -d["bytes"])
    buckets = {"zero": 0, "le_1k": 0, "le_10k": 0, "le_100k": 0, "gt_100k": 0}
    for size in sizes:
        if size <= 0:
            buckets["zero"] += 1
        elif size <= 1024:
            buckets["le_1k"] += 1
        elif size <= 10 * 1024:
            buckets["le_10k"] += 1
        elif size <= 100 * 1024:
            buckets["le_100k"] += 1
        else:
            buckets["gt_100k"] += 1

    result.update({
        "count": len(dirs),
        "nonempty_count": len(nonempty),
        "total_bytes": sum(sizes),
        "total_disk_bytes": sum(d["disk_bytes"] for d in dirs),
        "file_count": sum(d["file_count"] for d in dirs),
        "oldest_age_days": max(ages) if ages else None,
        "newest_age_days": min(ages) if ages else None,
        "dirs": dirs,
        "size_dist_all": dist_stats(sizes),
        "size_dist_nonempty": dist_stats([d["bytes"] for d in nonempty]),
        "size_buckets": buckets,
        "older_than_7d": sum(1 for a in ages if a > 7),
        "older_than_30d": sum(1 for a in ages if a > 30),
        "top": dirs[:10],
    })
    return result


# ---------------------------------------------------------------------------
# data/ 顶层上下文
# ---------------------------------------------------------------------------

def collect_data_root(paths):
    """data/ 顶层目录与文件占用（库文件、备份、reports 等），给上下文。"""
    roots = set()
    for p in paths:
        if p and os.path.exists(p):
            roots.add(os.path.dirname(os.path.abspath(p)))
    result = {"roots": []}
    for root in sorted(roots):
        items = []
        try:
            entries = list(os.scandir(root))
        except OSError as exc:
            note("无法读取 %s: %s" % (root, exc))
            continue
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    usage = dir_usage(entry.path)
                    items.append({"name": entry.name, "kind": "dir",
                                  "bytes": usage["apparent"], "files": usage["files"]})
                elif entry.is_file(follow_symlinks=False):
                    st = entry.stat(follow_symlinks=False)
                    items.append({"name": entry.name, "kind": "file", "bytes": st.st_size,
                                  "mtime": st.st_mtime})
            except OSError:
                continue
        items.sort(key=lambda i: -i["bytes"])
        backups = [i for i in items if i["name"].startswith("app.db.bak")]
        result["roots"].append({
            "root": root,
            "items": items,
            "total_bytes": sum(i["bytes"] for i in items),
            "backup_count": len(backups),
            "backup_bytes": sum(i["bytes"] for i in backups),
        })
    return result


# ---------------------------------------------------------------------------
# 渲染
# ---------------------------------------------------------------------------

COL_T = 34
COL_N = 11


def render(result):
    lines = []
    add = lines.append
    db = result["database"]
    users = result["users"]
    guests = result["guests"]
    per_user_db = result["per_user_db"]

    add("# 存储现状统计（只读）")
    add("生成时间: %s" % result["generated_at"])
    add("命令: %s" % result["command"])
    add("")

    # ---- 1. 数据库 ----
    add("## 1. 数据库")
    if not db.get("exists"):
        add("库文件不存在：%s（跳过）" % db.get("path"))
    else:
        add("库文件: %s  %s (%s B)  页 %s B × %s  空闲页 %s  journal=%s"
            % (db["path"], human(db["bytes"]), fmt_int(db["bytes"]), db["page_size"],
               db["page_count"], db["freelist_count"], db["journal_mode"]))
        wal = ", ".join("%s %s" % (os.path.basename(w["path"]), human(w["bytes"]))
                        for w in db["wals"]) or "无"
        add("WAL/SHM: %s   表数: %d   关键表: %d/%d   大小口径: %s"
            % (wal, db["table_count"], len(db["key_tables_present"]), len(KEY_TABLES),
               db.get("size_method")))
        add("")
        add(pad("表", COL_T) + pad("行数", COL_N, "right") + pad("占用", 12, "right")
            + pad("占比", 8, "right") + "  归属")
        add("-" * (COL_T + COL_N + 12 + 8 + 8))
        for row in db["tables"]:
            mark = "•" if row["key"] else " "
            attr = {"user": "按用户", "global": "全局", "other": "其他"}.get(
                row["attribution"], "会话关联" if row["attribution"].startswith("session:") else "其他")
            add(pad(mark + row["table"], COL_T) + pad(fmt_int(row["rows"]), COL_N, "right")
                + pad(human(row["bytes"]), 12, "right")
                + pad("%.1f%%" % (row["share"] * 100), 8, "right") + "  " + attr)
        add("-" * (COL_T + COL_N + 12 + 8 + 8))
        add(pad("合计（%d 表）" % db["table_count"], COL_T)
            + pad(fmt_int(sum(r["rows"] or 0 for r in db["tables"])), COL_N, "right")
            + pad(human(db["tables_total_bytes"]), 12, "right")
            + pad("100.0%", 8, "right") + "  • = 任务 7 关键表")
        add("")

        globals_ = result.get("global_cache") or {}
        if globals_:
            add("全局缓存（无用户归属，可重建类）：")
            for table, info in globals_.items():
                add("  %-30s %8s 行  %10s" % (table, fmt_int(info["rows"]), human(info["bytes"])))
            add("")

        anon = result.get("anonymous") or {}
        if anon:
            add("匿名 user_id（有 user_id 但不在 users 表、也没有用户目录 —— 多为游客/设备 id）：")
            for table, info in anon.items():
                add("  %-30s %8s 行 / %6s 个 user_id  ~%s"
                    % (table, fmt_int(info["rows"]), fmt_int(info["distinct_user_ids"]),
                       human(info["est_bytes"])))
            add("")

        guest_hash = result.get("guest_hash") or {}
        if guest_hash:
            add("游客在库里的痕迹（guest_hash 非空）：")
            for table, info in guest_hash.items():
                add("  %-30s %8s 行 / %6s 个 guest_hash"
                    % (table, fmt_int(info["rows"]), fmt_int(info["distinct_guest_hashes"])))
            add("")

        real_rows = sum(v.get("total_rows", 0) for v in per_user_db.values())
        real_bytes = sum(v.get("est_bytes", 0) for v in per_user_db.values())
        anon_rows = sum(v["rows"] for v in anon.values())
        anon_bytes = sum(v.get("est_bytes", 0) for v in anon.values())
        add("归集概览: 真实用户 %s 行 ~%s  |  匿名 user_id %s 行 ~%s  |  全局缓存 %s"
            % (fmt_int(real_rows), human(int(real_bytes)),
               fmt_int(anon_rows), human(anon_bytes),
               human(sum(v["bytes"] for v in globals_.values()))))
        add("真实用户的库内分布（用户集合 = users 表 ∪ data/users 目录）：")
        db_rows = [per_user_db.get(u["user_id"], {}).get("total_rows", 0) for u in users["users"]]
        db_bytes = [per_user_db.get(u["user_id"], {}).get("est_bytes", 0) for u in users["users"]]
        add("  " + dist_line("库内行数", dist_stats(db_rows), humanize=False))
        add("  " + dist_line("库内估算字节", dist_stats(db_bytes)))
        add("")

    # ---- 2. 按用户聚合 ----
    add("## 2. 按用户聚合（data/users/*）")
    if not users.get("exists"):
        add("用户目录不存在：%s（跳过）" % users.get("path"))
    else:
        add("目录: %s  用户目录 %d 个 / users 表 %d 个 / 合并后 %d 个"
            % (users["path"], users["dir_count"], users["db_user_count"], users["user_count"]))
        if users["only_dir"]:
            add("⚠ 只有目录、库里没有的用户（疑似已注销残留）：%s" % ", ".join(users["only_dir"]))
        if users["only_db"]:
            add("⚠ 库里注册但没有任何目录的用户：%s" % ", ".join(users["only_db"]))
        add("")
        widths = (12, 18, 12, 9, 12)
        add(pad("用户", COL_T) + pad("目录", widths[0], "right") + pad("history 文件/字节", widths[1], "right")
            + pad("favorites", widths[2], "right") + pad("库内行", widths[3], "right")
            + pad("总估算", widths[4], "right"))
        add("-" * (COL_T + sum(widths)))
        for u in users["users"]:
            hist = "%d / %s" % (u["history_files"], human(u["history_bytes"]))
            add(pad(u["user_id"], COL_T) + pad(human(u["dir_bytes"]), widths[0], "right")
                + pad(hist, widths[1], "right")
                + pad(human(u["favorites_bytes"]), widths[2], "right")
                + pad(fmt_num(u["db_rows"]), widths[3], "right")
                + pad(human(u["total_est_bytes"]), widths[4], "right"))
        add("-" * (COL_T + sum(widths)))
        add(pad("合计", COL_T) + pad(human(sum(u["dir_bytes"] for u in users["users"])), widths[0], "right")
            + pad(human(sum(u["history_bytes"] for u in users["users"])), widths[1], "right")
            + pad(human(sum(u["favorites_bytes"] for u in users["users"])), widths[2], "right")
            + pad(fmt_num(sum(u["db_rows"] for u in users["users"])), widths[3], "right")
            + pad(human(sum(u["total_est_bytes"] for u in users["users"])), widths[4], "right"))
        add("")

        d = users["distributions"]
        n = users["user_count"]
        add("分位数（n=%d%s）：" % (n, "，小样本：P90/P99 已接近最大值，仅供参考" if n < 30 else ""))
        add("  " + dist_line("目录占用", d["dir_bytes"]))
        add("  " + dist_line("history 字节", d["history_bytes"]))
        add("  " + dist_line("history 文件数", d["history_files"], humanize=False))
        add("  " + dist_line("favorites.json", d["favorites_bytes"]))
        add("  " + dist_line("imported-books", d["imported_books_bytes"]))
        add("  " + dist_line("库内行数", d["db_rows"], humanize=False))
        add("  " + dist_line("库内估算字节", d["db_est_bytes"]))
        add("  " + dist_line("总占用估算", d["total_est_bytes"]))
        add("")

    # ---- 3. 游客目录 ----
    add("## 3. 游客目录（data/guests/*）")
    if not guests.get("exists"):
        add("游客目录不存在：%s（跳过）" % guests.get("path"))
    elif guests["count"] == 0:
        add("游客目录存在但为空：%s（0 个目录）" % guests["path"])
    else:
        add("目录: %s  数量 %d（非空 %d）  总字节 %s (%s B)  磁盘占用 %s  文件 %d 个"
            % (guests["path"], guests["count"], guests["nonempty_count"],
               human(guests["total_bytes"]), fmt_int(guests["total_bytes"]),
               human(guests["total_disk_bytes"]), guests["file_count"]))
        oldest = guests["oldest_age_days"]
        newest = guests["newest_age_days"]
        add("目录年龄: 最旧 %s 天前 / 最新 %s 天前  |  超过 7 天 %d 个，超过 30 天 %d 个"
            % ("%.1f" % oldest if oldest is not None else "-",
               "%.1f" % newest if newest is not None else "-",
               guests["older_than_7d"], guests["older_than_30d"]))
        add("  " + dist_line("每目录字节（全部）", guests["size_dist_all"]))
        add("  " + dist_line("每目录字节（非空）", guests["size_dist_nonempty"]))
        buckets = guests["size_buckets"]
        add("  体积分桶: 0 B %d / 1 B–1 KB %d / 1–10 KB %d / 10–100 KB %d / ≥100 KB %d"
            % (buckets["zero"], buckets["le_1k"], buckets["le_10k"],
               buckets["le_100k"], buckets["gt_100k"]))
        add("")
        tops = [g for g in guests["top"] if g["bytes"] > 0]
        add("最大的 %d 个目录：" % len(tops))
        NAME_W = 66
        add(pad("目录", NAME_W) + pad("字节", 12, "right") + pad("文件", 8, "right")
            + "  年龄(天)")
        for g in tops:
            add(pad(g["name"], NAME_W) + pad(human(g["bytes"]), 12, "right")
                + pad(fmt_int(g["file_count"]), 8, "right")
                + "  " + ("%.1f" % g["age_days"] if g["age_days"] is not None else "-"))
        add("")

    # ---- 4. data/ 顶层 ----
    data_root = result.get("data_root") or {}
    if data_root.get("roots"):
        add("## 4. data/ 顶层占用（上下文）")
        for root in data_root["roots"]:
            add("目录: %s  合计 %s" % (root["root"], human(root["total_bytes"])))
            if root["backup_count"]:
                add("  其中 app.db.bak-* 备份 %d 个，共 %s"
                    % (root["backup_count"], human(root["backup_bytes"])))
            for item in root["items"][:12]:
                add("  " + pad(item["name"], 52) + pad(human(item["bytes"]), 12, "right"))
            add("")

    if NOTES:
        add("## 说明 / 异常")
        for msg in NOTES:
            add("- " + msg)
        add("")

    add("只读校验: SQLite URI=%s, PRAGMA query_only=ON；本脚本不写库、不删文件、不联网。"
        % (db.get("uri") or "-"))
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def build_result(args, command, now):
    db_path = args.db
    users_dir = args.users_dir
    guests_dir = args.guests_dir

    generated_at = datetime.fromtimestamp(now, timezone.utc).astimezone().isoformat(timespec="seconds")

    # 真实用户集合：users 表 ∪ data/users 下的目录名
    db_users = set()
    db_part = {}
    if os.path.exists(db_path):
        conn, _ = open_db_readonly(db_path)
        try:
            try:
                db_users = {row[0] for row in conn.execute("SELECT id FROM users")}
            except sqlite3.Error as exc:
                note("读取 users 表失败（按空集处理）：%s" % exc)
        finally:
            conn.close()
    else:
        note("数据库文件不存在：%s（数据库相关统计跳过）" % db_path)

    dir_users = set()
    if os.path.isdir(users_dir):
        dir_users = {d for d in os.listdir(users_dir) if os.path.isdir(os.path.join(users_dir, d))}
    else:
        note("用户目录不存在：%s（按目录聚合部分将为空）" % users_dir)

    real_user_ids = sorted(db_users | dir_users)

    if os.path.exists(db_path):
        db_part = collect_db(db_path, real_user_ids)
    else:
        db_part = {"database": {"path": db_path, "exists": False}, "per_user_db": {},
                   "anonymous": {}, "guest_hash": {}, "global_cache": {}}

    users = collect_users(users_dir, db_users, db_part.get("per_user_db", {}))
    guests = collect_guests(guests_dir, now)
    data_root = collect_data_root([db_path, users_dir, guests_dir])

    return {
        "generated_at": generated_at,
        "command": command,
        "paths": {"db": db_path, "users_dir": users_dir, "guests_dir": guests_dir},
        "database": db_part.get("database", {"path": db_path, "exists": False}),
        "per_user_db": db_part.get("per_user_db", {}),
        "anonymous": db_part.get("anonymous", {}),
        "guest_hash": db_part.get("guest_hash", {}),
        "global_cache": db_part.get("global_cache", {}),
        "users": users,
        "guests": guests,
        "data_root": data_root,
        "key_tables": KEY_TABLES,
        "notes": NOTES,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="存储现状只读统计（任务 7 第一步「量」）：数据库按表、按用户、游客目录。")
    parser.add_argument("--db", default="data/app.db", help="SQLite 库路径（默认 data/app.db）")
    parser.add_argument("--users-dir", default="data/users", help="用户目录（默认 data/users）")
    parser.add_argument("--guests-dir", default="data/guests", help="游客目录（默认 data/guests）")
    parser.add_argument("--json", action="store_true", help="输出 JSON 而不是文本报告")
    args = parser.parse_args(argv)

    args_rest = argv if argv is not None else sys.argv[1:]
    command = " ".join([sys.argv[0]] + list(args_rest))
    now = time.time()

    try:
        result = build_result(args, command, now)
    except RuntimeError as exc:
        sys.stderr.write("[storage_stats] %s\n" % exc)
        return 3
    except sqlite3.Error as exc:
        sys.stderr.write("[storage_stats] 数据库读取失败：%s\n" % exc)
        return 3

    if not result["database"].get("exists") and not result["users"].get("exists") \
            and not result["guests"].get("exists"):
        sys.stderr.write("[storage_stats] 库文件与目录都不存在，无法统计。\n")
        return 2

    if args.json:
        payload = {k: v for k, v in result.items() if k != "per_user_db"}
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        sys.stdout.write(render(result) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
