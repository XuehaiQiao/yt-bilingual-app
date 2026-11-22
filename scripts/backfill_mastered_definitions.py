#!/usr/bin/env python3
"""P0-13 回填「已掌握但释义为空」的词（可审计、可回滚）。

背景
----
标记已掌握时，前端只 PATCH ``mastered``，没有把行内中文释义写入
``word_states.definition``；因此旧数据里已掌握词的释义快照为空，已掌握 tab
只能显示 ``—``。本脚本从 **reconcile 备份**（``data/backups/favorites-*.json``，
只读）找回这些词原来的收藏 ``zh_text``，只给 ``definition`` 仍为空的已掌握行
填空，**绝不覆盖已有快照**。

前端语义
--------
收藏的 ``zh_text`` 形如 ``/ˈaʊt/ 外面``：斜杠内是音标，后面才是释义。标记时
前端存的是 ``meaning``（不含音标），本脚本用同一段正则拆分，写回 ``meaning``；
dry-run 会同时打印原始 ``zh_text`` 与将要写入的 ``definition``。

用法
----
    # 1) 默认 dry-run：只读扫描 + 打印清单，不写任何文件（包括备份目录）
    backend/venv/bin/python scripts/backfill_mastered_definitions.py
    backend/venv/bin/python scripts/backfill_mastered_definitions.py --user-id <uid>

    # 2) 只读巡检：empty_definition=0 退出码 0，否则 1
    backend/venv/bin/python scripts/backfill_mastered_definitions.py --check

    # 3) 真正执行（必须显式 --apply --yes --user-id）：
    #    先写备份 JSON + JSONL 审计，再逐条只填空
    backend/venv/bin/python scripts/backfill_mastered_definitions.py \
        --apply --user-id <uid> --yes

    # 4) 回滚（幂等）：按审计/备份恢复 definition（只恢复仍等于回填值的行）
    backend/venv/bin/python scripts/backfill_mastered_definitions.py \
        --rollback data/backups/backfill-mastered-definitions-audit-<uid>-<ts>.jsonl

写入路径
--------
正填走产品写入口 ``srs.set_mastered(..., definition=...)``；它本身只填空、不
覆盖、mastered=false 不写，和前端标记路径共用同一语义。回滚是显式运维操作，
只在「当前值仍等于回填值」时用一条带 id/user_id/lemma 条件的 UPDATE 恢复
旧值，用户手改过的行不覆盖。dry-run / --check 使用只读 SQLite URI：WAL 边车
为空时用 ``immutable=1``，不创建 ``-wal``/``-shm``。

退出码：0 = 成功 / 巡检无空释义；1 = 巡检发现空释义 / apply 后仍遗留
unresolved / 回滚遇到冲突；2 = 用法或数据错误。
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import glob
import io
import json
import os
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# backend 模块 import 时 config.py 会往 stdout 打运维警告；本脚本输出可解析清单，
# 只在 import 期间吞掉这些提示（与 reconcile_mastered_favorites.py 一致）。
with contextlib.redirect_stdout(io.StringIO()):
    import config  # noqa: E402
    import srs  # noqa: E402

SCRIPT_NAME = "backfill_mastered_definitions"
AUDIT_VERSION = 1
BACKUP_RE = re.compile(r"^favorites-(.+)-(\d{8}-\d{6}(?:-\d+)?)\.json$")
IPA_MEANING_RE = re.compile(r"^/([^/]{1,120})/\s*(.*)$")
EMPTY_SQL = "(definition IS NULL OR trim(definition) = '')"


class BackfillError(RuntimeError):
    """可预期的失败：打印一行友好错误并退出 2，不抛 traceback。"""


# ---------------------------------------------------------------------------
# 归一化 / 只读数据库
# ---------------------------------------------------------------------------


def normalize_word_key(text) -> str:
    """与产品一致的词比对键：NFC + trim + lower（不做词形还原）。"""
    if not isinstance(text, str):
        return ""
    return unicodedata.normalize("NFC", text).strip().lower()


def clean_str(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def normalize_definition(value):
    """空串 / 纯空白 → None；非字符串视为非法（与 srs._normalize_definition 同口径）。"""
    if value is None:
        return None
    if not isinstance(value, str):
        raise BackfillError("definition 必须是字符串或 null。")
    text = value.strip()
    return text or None


def meaning_from_zh_text(zh_text) -> str:
    """与前端 ``splitIpaAndMeaning`` 同口径：去掉开头的 /音标/，只留释义。"""
    text = clean_str(zh_text)
    match = IPA_MEANING_RE.match(text)
    if not match:
        return text
    return match.group(2).strip()


def validate_user_id(user_id: str) -> str:
    if not isinstance(user_id, str) or not user_id:
        raise BackfillError("--user-id 不能为空。")
    if user_id != user_id.strip():
        raise BackfillError(f"--user-id 含首尾空白：{user_id!r}。")
    if user_id in (".", "..") or "\x00" in user_id:
        raise BackfillError(f"非法 --user-id：{user_id!r}。")
    if os.sep in user_id or "/" in user_id or "\\" in user_id:
        raise BackfillError(f"--user-id 不能含路径分隔符：{user_id!r}。")
    return user_id


def _db_is_wal(path: str) -> bool:
    try:
        with open(path, "rb") as handle:
            header = handle.read(20)
    except OSError:
        return False
    return len(header) >= 20 and header[18] == 2 and header[19] == 2


def _wal_has_frames(db_path: str) -> bool:
    try:
        return os.path.getsize(db_path + "-wal") > 0
    except OSError:
        return False


def _read_can_be_immutable(db_path: str) -> bool:
    return _db_is_wal(db_path) and not _wal_has_frames(db_path)


def _read_only_uri(db_path: str) -> str:
    params = "mode=ro"
    if _read_can_be_immutable(db_path):
        params += "&immutable=1"
    return Path(os.path.abspath(db_path)).as_uri() + "?" + params


def _db_path() -> str:
    return config.AUTH_DB_PATH


def _connect_readonly() -> sqlite3.Connection:
    path = _db_path()
    if not os.path.exists(path):
        raise BackfillError(
            f"数据库不存在：{path}。先运行 backend/venv/bin/alembic upgrade head。"
        )
    try:
        conn = sqlite3.connect(_read_only_uri(path), uri=True, timeout=10)
    except sqlite3.OperationalError as exc:
        raise BackfillError(f"无法只读打开数据库：{path}（{exc}）。") from exc
    conn.row_factory = sqlite3.Row
    return conn


def _check_schema(conn: sqlite3.Connection) -> None:
    tables = {
        row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }
    if "word_states" not in tables:
        raise BackfillError(
            "word_states 表不存在（未跑 0006_review_engine 迁移）。"
            "请先运行 backend/venv/bin/alembic upgrade head。"
        )
    columns = {row[1] for row in conn.execute("PRAGMA table_info(word_states)")}
    if "mastered" not in columns:
        raise BackfillError(
            "word_states 缺少 mastered 列（未跑 0027_review_mastered 迁移）。"
            "请先运行 backend/venv/bin/alembic upgrade head。"
        )
    if "definition" not in columns:
        raise BackfillError(
            "word_states 缺少 definition 列（未跑 0029_word_state_definition "
            "迁移）。请先运行 backend/venv/bin/alembic upgrade head。"
        )


def load_mastered_empty(user_id: str | None = None) -> list[dict]:
    """只读读取 mastered=1 且 definition 为空的行。"""
    conn = _connect_readonly()
    try:
        _check_schema(conn)
        sql = (
            "SELECT id, user_id, lemma, target_lang, created_at, definition "
            f"FROM word_states WHERE mastered = 1 AND {EMPTY_SQL}"
        )
        params: tuple = ()
        if user_id:
            sql += " AND user_id = ?"
            params = (user_id,)
        sql += " ORDER BY user_id, lemma, id"
        return [dict(row) for row in conn.execute(sql, params).fetchall()]
    except sqlite3.Error as exc:
        raise BackfillError(f"读取 word_states 失败：{exc}") from exc
    finally:
        conn.close()


def load_mastered_counts(user_id: str | None = None) -> list[dict]:
    """按用户统计 mastered 总数与空释义数（--check）。"""
    conn = _connect_readonly()
    try:
        _check_schema(conn)
        sql = (
            "SELECT user_id, COUNT(*) AS mastered_total, "
            f"SUM(CASE WHEN {EMPTY_SQL} THEN 1 ELSE 0 END) AS empty_definition "
            "FROM word_states WHERE mastered = 1"
        )
        params: tuple = ()
        if user_id:
            sql += " AND user_id = ?"
            params = (user_id,)
        sql += " GROUP BY user_id ORDER BY user_id"
        return [dict(row) for row in conn.execute(sql, params).fetchall()]
    except sqlite3.Error as exc:
        raise BackfillError(f"读取 word_states 失败：{exc}") from exc
    finally:
        conn.close()


def load_word_states_by_ids(ids: list[str]) -> list[dict]:
    if not ids:
        return []
    conn = _connect_readonly()
    try:
        _check_schema(conn)
        placeholders = ", ".join("?" for _ in ids)
        rows = conn.execute(
            f"SELECT * FROM word_states WHERE id IN ({placeholders}) ORDER BY id",
            tuple(ids),
        ).fetchall()
        return [dict(row) for row in rows]
    except sqlite3.Error as exc:
        raise BackfillError(f"读取 word_states 失败：{exc}") from exc
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 备份来源（reconcile 备份，只读）
# ---------------------------------------------------------------------------


def backup_dir_path(explicit: str | None) -> str:
    return explicit or os.path.join(config.DATA_DIR, "backups")


def discover_backup_files(backup_dir: str, user_id: str | None = None) -> list[tuple[str, str, str]]:
    """返回 [(user_id, stamp, path)]，同一用户按 stamp 从新到旧。"""
    found: list[tuple[str, str, str]] = []
    for path in glob.glob(os.path.join(backup_dir, "favorites-*.json")):
        match = BACKUP_RE.match(os.path.basename(path))
        if not match:
            continue
        uid, stamp = match.group(1), match.group(2)
        if user_id and uid != user_id:
            continue
        found.append((uid, stamp, path))
    found.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
    return found


def load_backup_sources(backup_dir: str, user_id: str) -> dict[str, dict]:
    """用户全部备份里的 vocabulary 收藏，按最新备份优先建索引。"""
    sources: dict[str, dict] = {}
    for _uid, _stamp, path in discover_backup_files(backup_dir, user_id):
        try:
            payload = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise BackfillError(f"备份文件无法读取：{path}（{exc}）。") from exc
        if isinstance(payload, dict):
            records = payload.get("favorites") or payload.get("records") or []
        else:
            records = payload
        if not isinstance(records, list):
            raise BackfillError(f"备份文件形状异常（不是列表）：{path}")
        for record in records:
            if not isinstance(record, dict):
                continue
            if record.get("type") == "sentence":
                continue
            key = normalize_word_key(record.get("en_text"))
            if not key or key in sources:
                continue
            sources[key] = {
                "en_text": clean_str(record.get("en_text")),
                "zh_text": clean_str(record.get("zh_text")),
                "favorite_id": record.get("id"),
                "backup_path": path,
            }
    return sources


def build_plan(rows: list[dict], backup_dir: str) -> list[dict]:
    """把空释义行与备份里的原收藏对上，生成 fillable/unresolved 计划。"""
    by_user: dict[str, list[dict]] = {}
    for row in rows:
        by_user.setdefault(str(row.get("user_id") or ""), []).append(row)
    plan: list[dict] = []
    for uid, user_rows in by_user.items():
        sources = load_backup_sources(backup_dir, uid) if uid else {}
        for row in user_rows:
            key = normalize_word_key(row.get("lemma"))
            source = sources.get(key)
            item = {
                "user_id": uid,
                "word_state_id": row.get("id"),
                "lemma": row.get("lemma"),
                "target_lang": row.get("target_lang"),
                "created_at": row.get("created_at"),
                "definition_before": row.get("definition"),
                "source_en_text": None,
                "source_zh_text": None,
                "source_backup": None,
                "favorite_id": None,
                "definition_to_write": None,
                "status": "unresolved",
                "reason": None,
            }
            if source is None:
                item["reason"] = "no_backup_favorite"
                plan.append(item)
                continue
            item.update(
                {
                    "source_en_text": source["en_text"],
                    "source_zh_text": source["zh_text"],
                    "source_backup": source["backup_path"],
                    "favorite_id": source["favorite_id"],
                }
            )
            meaning = meaning_from_zh_text(source["zh_text"])
            if not meaning:
                item["reason"] = "empty_meaning_in_favorite"
                plan.append(item)
                continue
            item["status"] = "fillable"
            item["definition_to_write"] = meaning
            plan.append(item)
    return plan


# ---------------------------------------------------------------------------
# 输出 / 写文件
# ---------------------------------------------------------------------------


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def now_ms() -> int:
    return int(dt.datetime.now().timestamp() * 1000)


def _emit_json(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def _table(plan: list[dict]) -> str:
    headers = ("#", "lemma", "target", "zh_text", "definition_to_write", "status")
    rows = []
    for index, item in enumerate(plan, start=1):
        status = item["status"]
        if item["status"] != "fillable":
            status = f"{status}:{item.get('reason') or '-'}"
        rows.append(
            (
                str(index),
                str(item.get("lemma") or "-"),
                str(item.get("target_lang") or "-"),
                str(item.get("source_zh_text") or "-"),
                str(item.get("definition_to_write") or "-"),
                status,
            )
        )
    widths = [
        max(len(str(row[column])) for row in (headers, *rows))
        for column in range(len(headers))
    ]
    lines = ["  ".join(str(cell).ljust(widths[i]) for i, cell in enumerate(headers))]
    lines.append("  ".join("-" * width for width in widths))
    for row in rows:
        lines.append("  ".join(str(cell).ljust(widths[i]) for i, cell in enumerate(row)))
    return "\n".join(lines)


def _unique_output_paths(backup_dir: str, user_id: str) -> tuple[str, str]:
    for attempt in range(1000):
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        if attempt:
            stamp = f"{stamp}-{attempt}"
        backup = os.path.join(
            backup_dir, f"word-states-mastered-definitions-{user_id}-{stamp}.json"
        )
        audit = os.path.join(
            backup_dir, f"backfill-mastered-definitions-audit-{user_id}-{stamp}.jsonl"
        )
        if not os.path.exists(backup) and not os.path.exists(audit):
            return backup, audit
    raise BackfillError(f"无法在 {backup_dir} 生成唯一备份文件名。")


def _atomic_write_json(path: str, payload: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _write_jsonl_line(handle, payload: dict) -> None:
    handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=False) + "\n")
    handle.flush()
    os.fsync(handle.fileno())


# ---------------------------------------------------------------------------
# 命令：dry-run / check
# ---------------------------------------------------------------------------


def cmd_dry_run(args) -> int:
    uid = validate_user_id(args.user_id) if args.user_id else None
    rows = load_mastered_empty(uid)
    backup_dir = backup_dir_path(args.backup_dir)
    plan = build_plan(rows, backup_dir)
    fillable = [item for item in plan if item["status"] == "fillable"]
    unresolved = [item for item in plan if item["status"] != "fillable"]
    report = {
        "script": SCRIPT_NAME,
        "mode": "dry-run",
        "ok": not unresolved,
        "generated_at": now_iso(),
        "user_id": uid,
        "db_path": _db_path(),
        "backup_dir": backup_dir,
        "mastered_total": sum(item["mastered_total"] for item in load_mastered_counts(uid)),
        "empty_definition": len(rows),
        "fillable_count": len(fillable),
        "unresolved_count": len(unresolved),
        "rows": plan,
        "write_files": 0,
    }
    if args.json:
        _emit_json(report)
        return 0 if not unresolved else 1

    print("== P0-13 backfill mastered definitions (dry-run) ==")
    if uid:
        print(f"user_id: {uid}")
    print(f"db: {_db_path()} (read-only)")
    print(f"backups: {backup_dir} (read-only)")
    print(
        f"mastered_total={report['mastered_total']} "
        f"empty_definition={report['empty_definition']} "
        f"fillable={len(fillable)} unresolved={len(unresolved)}"
    )
    if plan:
        print("")
        print(_table(plan))
        print("")
    print("dry-run：未备份、未写审计、未改 word_states（0 写入）。")
    if fillable:
        print("下一步（需 lead/用户确认后）：加 --apply --user-id <uid> --yes 执行。")
    return 0 if not unresolved else 1


def cmd_check(args) -> int:
    uid = validate_user_id(args.user_id) if args.user_id else None
    counts = load_mastered_counts(uid)
    mastered_total = sum(int(item["mastered_total"] or 0) for item in counts)
    empty = sum(int(item["empty_definition"] or 0) for item in counts)
    report = {
        "script": SCRIPT_NAME,
        "mode": "check",
        "ok": empty == 0,
        "generated_at": now_iso(),
        "db_path": _db_path(),
        "mastered_total": mastered_total,
        "empty_definition": empty,
        "users": [
            {
                "user_id": item["user_id"],
                "mastered_total": int(item["mastered_total"] or 0),
                "empty_definition": int(item["empty_definition"] or 0),
            }
            for item in counts
        ],
        "write_files": 0,
    }
    if args.json:
        _emit_json(report)
    else:
        print("== P0-13 backfill mastered definitions check (read-only) ==")
        for item in report["users"]:
            print(
                f"user={item['user_id']} mastered={item['mastered_total']} "
                f"empty_definition={item['empty_definition']}"
            )
        print(f"mastered_total={mastered_total} empty_definition={empty}")
        if empty:
            print("VIOLATION: 已掌握词仍有空释义；先 dry-run 再 --apply --yes。")
        else:
            print("OK: 已掌握词释义快照全部非空")
    return 0 if empty == 0 else 1


# ---------------------------------------------------------------------------
# 命令：apply
# ---------------------------------------------------------------------------


def cmd_apply(args) -> int:
    if not args.user_id:
        raise BackfillError("--apply 必须显式指定 --user-id（防误写）。")
    if not args.yes:
        raise BackfillError("--apply 必须同时给出 --yes（人工确认）。")
    uid = validate_user_id(args.user_id)
    backup_dir = backup_dir_path(args.backup_dir)
    rows = load_mastered_empty(uid)
    plan = build_plan(rows, backup_dir)
    fillable = [item for item in plan if item["status"] == "fillable"]
    unresolved = [item for item in plan if item["status"] != "fillable"]

    if not rows:
        report = {
            "script": SCRIPT_NAME,
            "mode": "apply",
            "ok": True,
            "generated_at": now_iso(),
            "user_id": uid,
            "empty_definition": 0,
            "filled_count": 0,
            "unresolved_count": 0,
            "write_files": 0,
            "note": "没有空释义的已掌握词，未做任何写入。",
        }
        if args.json:
            _emit_json(report)
        else:
            print("== P0-13 backfill (apply) ==")
            print(f"user_id={uid} empty_definition=0：无需回填；未备份、未写审计。")
        return 0

    os.makedirs(backup_dir, exist_ok=True)
    backup_path, audit_path = _unique_output_paths(backup_dir, uid)
    word_states = load_word_states_by_ids([str(item["word_state_id"]) for item in plan])
    backup_payload = {
        "script": SCRIPT_NAME,
        "version": AUDIT_VERSION,
        "mode": "apply",
        "user_id": uid,
        "generated_at": now_iso(),
        "db_path": _db_path(),
        "backup_dir": backup_dir,
        "planned": [
            {
                "word_state_id": item["word_state_id"],
                "lemma": item["lemma"],
                "target_lang": item["target_lang"],
                "definition_before": normalize_definition(item["definition_before"]),
                "definition_after": item["definition_to_write"],
                "source_zh_text": item["source_zh_text"],
                "source_backup": item["source_backup"],
                "favorite_id": item["favorite_id"],
            }
            for item in fillable
        ],
        "unresolved": [
            {
                "word_state_id": item["word_state_id"],
                "lemma": item["lemma"],
                "reason": item["reason"],
            }
            for item in unresolved
        ],
        "word_states": word_states,
    }
    _atomic_write_json(backup_path, backup_payload)

    filled: list[dict] = []
    skipped: list[dict] = []
    started_at = now_iso()
    with open(audit_path, "w", encoding="utf-8") as audit:
        _write_jsonl_line(
            audit,
            {
                "type": "header",
                "script": SCRIPT_NAME,
                "audit_version": AUDIT_VERSION,
                "mode": "apply",
                "user_id": uid,
                "started_at": started_at,
                "db_path": _db_path(),
                "backup_path": backup_path,
                "empty_definition_before": len(rows),
                "fillable_count": len(fillable),
                "unresolved_count": len(unresolved),
                "reason": "mastered_definition_backfill",
                "rollback_policy": (
                    "仅当当前 definition 仍等于回填值时才恢复 before；"
                    "用户手改过的行不覆盖"
                ),
            },
        )
        for item in fillable:
            before = normalize_definition(item["definition_before"])
            after = item["definition_to_write"]
            _write_jsonl_line(
                audit,
                {
                    "type": "fill",
                    "phase": "before_update",
                    "filled_at": now_iso(),
                    "filled_at_ms": now_ms(),
                    "user_id": uid,
                    "word_state_id": item["word_state_id"],
                    "lemma": item["lemma"],
                    "target_lang": item["target_lang"],
                    "definition_before": before,
                    "definition_after": after,
                    "source_zh_text": item["source_zh_text"],
                    "source_backup": item["source_backup"],
                    "favorite_id": item["favorite_id"],
                    "backup_path": backup_path,
                },
            )
            try:
                word = srs.set_mastered(
                    uid,
                    item["lemma"],
                    item["target_lang"],
                    True,
                    now=now_ms(),
                    source=None,
                    definition=after,
                )
            except Exception as exc:  # noqa: BLE001 - 统一记录后退出 2
                _write_jsonl_line(
                    audit,
                    {
                        "type": "error",
                        "at": now_iso(),
                        "word_state_id": item["word_state_id"],
                        "lemma": item["lemma"],
                        "error": f"{type(exc).__name__}: {exc}",
                    },
                )
                raise BackfillError(
                    f"回填 {item['lemma']} 失败：{exc}；备份={backup_path} 审计={audit_path}"
                ) from exc
            written = normalize_definition(word.get("definition"))
            if written == after:
                filled.append({**item, "definition_after": after})
            else:
                skipped.append(
                    {
                        **item,
                        "reason": "existing_snapshot_not_overwritten",
                        "current_definition": word.get("definition"),
                    }
                )
        empty_after = load_mastered_empty(uid)
        _write_jsonl_line(
            audit,
            {
                "type": "result",
                "finished_at": now_iso(),
                "user_id": uid,
                "filled_count": len(filled),
                "skipped_count": len(skipped),
                "empty_definition_after": len(empty_after),
                "filled_lemmas": [item["lemma"] for item in filled],
                "skipped": [
                    {"lemma": item["lemma"], "reason": item["reason"]}
                    for item in skipped
                ],
            },
        )

    report = {
        "script": SCRIPT_NAME,
        "mode": "apply",
        "ok": len(empty_after) == 0 and not skipped,
        "generated_at": now_iso(),
        "user_id": uid,
        "backup_path": backup_path,
        "audit_path": audit_path,
        "empty_definition_before": len(rows),
        "filled_count": len(filled),
        "filled_lemmas": [item["lemma"] for item in filled],
        "skipped_count": len(skipped),
        "unresolved_count": len(unresolved),
        "empty_definition_after": len(empty_after),
        "write_files": 2,
        "db_writes": len(filled),
    }
    if args.json:
        _emit_json(report)
        return 0 if report["ok"] else 1

    print("== P0-13 backfill (apply) ==")
    print(f"user_id={uid}")
    print(f"backup={backup_path}")
    print(f"audit={audit_path}")
    print(
        f"empty_definition: {len(rows)} -> {len(empty_after)} "
        f"(filled={len(filled)} skipped={len(skipped)} unresolved={len(unresolved)})"
    )
    if filled:
        print("filled: " + ", ".join(item["lemma"] for item in filled))
    if skipped:
        print(
            "WARN: 以下行在回填前已有快照，未覆盖："
            + ", ".join(item["lemma"] for item in skipped),
            file=sys.stderr,
        )
    if unresolved:
        print(
            "WARN: 以下空释义行在备份里找不到可用的原收藏："
            + ", ".join(f"{item['lemma']}({item['reason']})" for item in unresolved),
            file=sys.stderr,
        )
    return 0 if report["ok"] else 1


# ---------------------------------------------------------------------------
# 命令：rollback
# ---------------------------------------------------------------------------


def _load_rollback_entries(path: str) -> tuple[str | None, list[dict], str]:
    """从审计 JSONL 或备份 JSON 读出 [(before, after)]；返回 (user_id, entries, kind)。"""
    target = Path(path)
    if not target.exists():
        raise BackfillError(f"回滚文件不存在：{path}")
    if target.suffix == ".json":
        try:
            payload = json.loads(target.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise BackfillError(f"备份文件无法读取：{path}（{exc}）。") from exc
        if not isinstance(payload, dict) or payload.get("script") != SCRIPT_NAME:
            raise BackfillError(f"不是本脚本的备份文件：{path}")
        uid = payload.get("user_id")
        entries = []
        for item in payload.get("planned") or []:
            if not isinstance(item, dict):
                continue
            entries.append(
                {
                    "word_state_id": item.get("word_state_id"),
                    "user_id": uid,
                    "lemma": item.get("lemma"),
                    "target_lang": item.get("target_lang"),
                    "definition_before": item.get("definition_before"),
                    "definition_after": item.get("definition_after"),
                }
            )
        return uid, entries, "backup"

    if target.suffix != ".jsonl":
        raise BackfillError(f"回滚文件必须是 .jsonl 审计或 .json 备份：{path}")
    header = None
    entries = []
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise BackfillError(f"审计行不是合法 JSON：{path}（{exc}）") from exc
                if item.get("type") == "header":
                    header = item
                elif item.get("type") == "fill":
                    entries.append(item)
    except OSError as exc:
        raise BackfillError(f"审计文件无法读取：{path}（{exc}）。") from exc
    if header is None:
        raise BackfillError(f"审计文件缺少 header：{path}")
    if header.get("script") != SCRIPT_NAME:
        raise BackfillError(f"不是本脚本的审计文件：{path}")
    return header.get("user_id"), entries, "audit"


def _latest_audit(backup_dir: str, user_id: str | None) -> str:
    pattern = os.path.join(backup_dir, "backfill-mastered-definitions-audit-*.jsonl")
    candidates = []
    for path in glob.glob(pattern):
        name = os.path.basename(path)
        if user_id and f"-{user_id}-" not in name:
            continue
        candidates.append(path)
    if not candidates:
        raise BackfillError(
            f"在 {backup_dir} 下没有找到可回滚的审计文件"
            + (f"（user_id={user_id}）" if user_id else "")
            + "。"
        )
    candidates.sort(key=lambda item: os.path.getmtime(item), reverse=True)
    return candidates[0]


def cmd_rollback(args) -> int:
    path = args.rollback
    if not path:
        path = _latest_audit(backup_dir_path(args.backup_dir), args.user_id)

    user_id, entries, kind = _load_rollback_entries(path)
    if args.user_id and user_id != args.user_id:
        raise BackfillError(
            f"--user-id={args.user_id} 与文件里的 user_id={user_id} 不一致，拒绝回滚。"
        )
    if not entries:
        print("== P0-13 backfill rollback ==")
        print(f"source={path} ({kind})")
        print("restored=0 already_before=0 missing=0 conflicts=0")
        return 0

    db_path = _db_path()
    if not os.path.exists(db_path):
        raise BackfillError(f"数据库不存在：{db_path}。")
    restored = already = missing = conflicts = 0
    conflict_rows: list[str] = []
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("BEGIN IMMEDIATE")
        for item in entries:
            word_id = item.get("word_state_id")
            row = conn.execute(
                "SELECT id, lemma, definition FROM word_states "
                "WHERE id = ? AND user_id = ? AND lemma = ?",
                (word_id, user_id, item.get("lemma")),
            ).fetchone()
            if row is None:
                missing += 1
                continue
            current = normalize_definition(row["definition"])
            before = normalize_definition(item.get("definition_before"))
            after = normalize_definition(item.get("definition_after"))
            if current == after:
                conn.execute(
                    "UPDATE word_states SET definition = ? WHERE id = ?",
                    (before, word_id),
                )
                restored += 1
            elif current == before:
                already += 1
            else:
                conflicts += 1
                conflict_rows.append(str(item.get("lemma") or word_id))
        conn.commit()
    except sqlite3.Error as exc:
        conn.rollback()
        raise BackfillError(f"回滚写入失败：{exc}") from exc
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    report = {
        "script": SCRIPT_NAME,
        "mode": "rollback",
        "ok": conflicts == 0,
        "generated_at": now_iso(),
        "source": path,
        "kind": kind,
        "user_id": user_id,
        "restored": restored,
        "already_before": already,
        "missing": missing,
        "conflicts": conflicts,
        "conflict_lemmas": conflict_rows,
        "write_files": 0,
        "db_writes": restored,
    }
    if args.json:
        _emit_json(report)
    else:
        print("== P0-13 backfill rollback ==")
        print(f"source={path} ({kind})")
        print(
            f"restored={restored} already_before={already} "
            f"missing={missing} conflicts={conflicts}"
        )
        if conflict_rows:
            print(
                "WARN: 以下行的释义在回填后被改过，未覆盖："
                + ", ".join(conflict_rows),
                file=sys.stderr,
            )
    return 0 if conflicts == 0 else 1


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=SCRIPT_NAME,
        description="P0-13：把备份里的原收藏释义回填到空 word_states.definition（只填空）。",
    )
    parser.add_argument("--user-id", help="目标用户 id（--apply 必填；dry-run/--check 可选）")
    parser.add_argument(
        "--backup-dir",
        help="reconcile 备份目录（默认 $DATA_DIR/backups；输出也写在这里）",
    )
    parser.add_argument("--apply", action="store_true", help="真正写入（必须配 --yes --user-id）")
    parser.add_argument("--yes", action="store_true", help="确认执行 apply")
    parser.add_argument("--check", action="store_true", help="只读巡检空释义数量")
    parser.add_argument(
        "--rollback",
        nargs="?",
        const="",
        metavar="AUDIT_OR_BACKUP",
        help="按审计 JSONL 或备份 JSON 回滚；省略路径时取最新审计",
    )
    parser.add_argument("--json", action="store_true", help="输出机器可解析 JSON")
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    modes = sum(bool(value) for value in (args.apply, args.check, args.rollback is not None))
    if modes > 1:
        print("错误：--apply / --check / --rollback 只能三选一。", file=sys.stderr)
        return 2
    try:
        if args.rollback is not None:
            return cmd_rollback(args)
        if args.check:
            return cmd_check(args)
        if args.apply:
            return cmd_apply(args)
        return cmd_dry_run(args)
    except BackfillError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
