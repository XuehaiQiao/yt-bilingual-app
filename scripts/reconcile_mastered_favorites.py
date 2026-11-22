#!/usr/bin/env python3
"""P0-02 reconcile：清理「已掌握但仍在收藏」的存量数据（可审计、可回滚）。

背景见 `ADR/0001-my-words-single-source.md`、`docs/data-map.md`、`specs/005`
§已掌握与收藏互斥：**我的单词 = favorites 列表本身**，**已掌握 =
`word_states.mastered=1`**，两者不允许重叠。2026-11-22 之前「先收藏、后标掌握」
是两次独立调用，服务端标记 mastered 时不删收藏，于是留下了 3 条存量重叠
（Affordability / intimately / thorny）。

本脚本只做一件事：把「与已掌握词重叠的 vocabulary 收藏」逐条删掉。它**不改
`word_states`**（已掌握是用户学习状态，不能为修数字而丢）。

用法
----
    # 1) 默认 dry-run：只读扫描 + 打印清单，绝不写文件（包括锁文件）
    backend/venv/bin/python scripts/reconcile_mastered_favorites.py
    backend/venv/bin/python scripts/reconcile_mastered_favorites.py \
        --user-id <uid> --expect 3

    # 2) 只读巡检（CI/收尾验收）：overlap=0 退出码 0，否则 1
    backend/venv/bin/python scripts/reconcile_mastered_favorites.py --check

    # 3) 真正执行（必须显式 --apply --yes）：先备份 + 写 JSONL 审计，再逐条删
    backend/venv/bin/python scripts/reconcile_mastered_favorites.py \
        --apply --user-id <uid> --yes

    # 4) 回滚（幂等，可重复执行）：按审计 JSONL 恢复被删收藏
    backend/venv/bin/python scripts/reconcile_mastered_favorites.py \
        --rollback data/backups/reconcile-audit-<uid>-<ts>.jsonl

写入路径与产品一致：删除走 `routes_user` 的收藏锁（线程锁 + fcntl 文件锁）、
原子写与 tombstones 旁路文件，**不整文件直写**；不 import/调用任何「静默批量删」。
dry-run / `--check` 不获取写锁（获取写锁会创建 `favorites.json.lock`），
`word_states` 用只读 SQLite URI 读取、收藏文件纯 `open(..., "r")`：
- WAL 边车（`-wal`）为空时用 `immutable=1`，连 `-wal`/`-shm` 都不会创建；
- `-wal` 非空（可能有未 checkpoint 的最新提交）时退回真实只读连接，此时
  SQLite 可能创建/复用 `-wal`/`-shm` 共享文件（不是业务数据），stderr 会提示。
日常本机（应用未运行、WAL 已 checkpoint）走前者，dry-run 对数据目录零写入。

已知局限（surface form vs lemma）
---------------------------------
收藏里的 `en_text` 是用户当时看到的**表面形式**，`word_states.lemma` 是 SRS 的
规范化 lemma。本脚本的比对键与产品前端一致：NFC + `strip()` + `lower()`
（前端 `normalizeMasteryWord`，见 `frontend/src/lib/wordMastery.ts`；后端
`normalize_lemma` 另加 NFC）。**不做词形还原**：因此 `guardrails`（收藏）与
`guardrail`（lemma）这类单复数/屈折变化不会被判为重叠；多词短语（如
`cyclone cellar`）也不会。P0 的 3 条恰好表面形式与 lemma 一致，能被命中；
若以后出现屈折差异，需要人工复核或引入 lemmatizer，不能默认本脚本能发现。

退出码：0 = 成功 / 巡检无重叠；1 = `--check` 发现重叠；2 = 用法或数据错误。
"""

from __future__ import annotations

import argparse
import contextlib
import copy
import datetime as dt
import io
import json
import os
import sqlite3
import sys
import unicodedata
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# backend 模块 import 时 config.py 会往 stdout 打运维警告（CORS/模型目录等）；
# 本脚本要输出可解析的清单/JSON，所以只在 import 期间吞掉这些提示。
with contextlib.redirect_stdout(io.StringIO()):
    import config  # noqa: E402
    import routes_user as favorites_store  # noqa: E402
    import storage  # noqa: E402

SCRIPT_NAME = "reconcile_mastered_favorites"
VOCABULARY_TYPE = "vocabulary"
AUDIT_VERSION = 1


class ReconcileError(RuntimeError):
    """可预期的失败：打印一行友好错误并退出 2，不抛 traceback。"""


# ---------------------------------------------------------------------------
# 归一化与只读读取
# ---------------------------------------------------------------------------


def normalize_word_key(text) -> str:
    """与产品一致的词比对键：NFC + trim + lower（不做词形还原）。"""
    if not isinstance(text, str):
        return ""
    return unicodedata.normalize("NFC", text).strip().lower()


def _clean_str(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _validate_user_id(user_id: str) -> str:
    if not isinstance(user_id, str) or not user_id:
        raise ReconcileError("--user-id 不能为空。")
    if user_id != user_id.strip():
        raise ReconcileError(f"--user-id 含首尾空白：{user_id!r}。")
    if user_id in (".", "..") or "\x00" in user_id:
        raise ReconcileError(f"非法 --user-id：{user_id!r}。")
    if os.sep in user_id or "/" in user_id or "\\" in user_id:
        raise ReconcileError(f"--user-id 不能含路径分隔符：{user_id!r}。")
    return user_id


def readonly_paths(user_id: str) -> dict[str, str]:
    """只读模式下的路径：规则与 `storage.favorites_file()` 相同，但不 mkdir。

    `storage` 的路径函数会 `_ensure_dir()`，对不存在的用户会建目录；dry-run
    必须「绝不写文件」，所以这里直接用 `config.USER_DATA_DIR` 拼路径。
    """
    user_root = os.path.join(config.USER_DATA_DIR, user_id)
    return {
        "user_root": user_root,
        "favorites": os.path.join(user_root, "favorites.json"),
        "tombstones": os.path.join(user_root, "favorites_tombstones.json"),
        "db": config.AUTH_DB_PATH,
    }


@contextlib.contextmanager
def user_scope(user_id: str):
    """把写入口（storage/routes_user）的当前身份切到指定用户，结束后还原。"""
    token = storage.current_user_id.set(user_id)
    try:
        yield
    finally:
        storage.current_user_id.reset(token)


def _read_favorites_snapshot(path: str) -> tuple[list, list]:
    """只读读取收藏文件，返回 `(原样记录, 补 id 后的记录)`。

    不获取写锁（避免创建 `favorites.json.lock`）；读取的是原子写完成后的
    完整文件，因此不会读到半份 JSON。
    """
    if not os.path.exists(path):
        return [], []
    try:
        records = favorites_store._load_favorites_unlocked(path)
    except Exception as exc:  # HTTPException：文件损坏/形状异常
        raise ReconcileError(
            f"收藏文件无法读取：{path}（{exc}）。请先人工检查该 JSON。"
        ) from exc
    with_ids = favorites_store._with_missing_ids(records)
    if len(with_ids) != len(records):
        # `_with_missing_ids` 按设计 1:1 返回；长度变了说明实现变了，别继续。
        raise ReconcileError("收藏记录补 id 后长度异常，拒绝继续（防误删）。")
    return records, with_ids


def _db_is_wal(path: str) -> bool:
    """读 SQLite 文件头判断是否 WAL 模式（纯文件读，不打开数据库）。"""
    try:
        with open(path, "rb") as handle:
            header = handle.read(20)
    except OSError:
        return False
    # offset 18/19 = write/read version，2 表示 WAL。
    return len(header) >= 20 and header[18] == 2 and header[19] == 2


def _wal_has_frames(db_path: str) -> bool:
    """`-wal` 非空 = 可能有未 checkpoint 的数据，必须用真实只读连接看最新值。"""
    try:
        return os.path.getsize(db_path + "-wal") > 0
    except OSError:
        return False


def _read_can_be_immutable(db_path: str) -> bool:
    """WAL 且边车为空时用 `immutable=1`：不建 -wal/-shm，dry-run 才真正零写入。

    - 非 WAL 库用普通 `mode=ro` 即可（不产生边车），不用 immutable：避免在
      有并发写者的 journal 库上做无锁读。
    - WAL 有未 checkpoint 数据时**不能** immutable（会读到旧快照），改用
      `mode=ro` 读取最新提交。
    """
    if not _db_is_wal(db_path):
        return False
    return not _wal_has_frames(db_path)


def _mastered_read_mode(db_path: str) -> str:
    """人类可读的读取方式：immutable / readonly-wal / readonly。"""
    if _read_can_be_immutable(db_path):
        return "immutable"
    return "readonly-wal" if _db_is_wal(db_path) else "readonly"


def _read_only_uri(db_path: str) -> str:
    """SQLite 只读 URI；`immutable=1` 只在 WAL 边车为空时使用。"""
    params = "mode=ro"
    if _read_can_be_immutable(db_path):
        params += "&immutable=1"
    return Path(os.path.abspath(db_path)).as_uri() + "?" + params


def load_mastered_words(user_id: str) -> list[dict]:
    """只读读取该用户 `word_states.mastered=1` 的全部词。

    直接发 SELECT（不 import srs / 不打开读写连接）：
    - 只读 URI 不写主库；WAL 边车为空时用 `immutable=1`，连 -wal/-shm 都不建；
    - 不做 200 条截断，避免「只删一部分」的静默漏扫；
    - 库/表/列缺失时给可操作错误，不抛 traceback。
    """
    path = config.AUTH_DB_PATH
    if not os.path.exists(path):
        raise ReconcileError(
            f"数据库不存在：{path}。先运行 backend/venv/bin/alembic upgrade head。"
        )
    uri = _read_only_uri(path)
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=10)
    except sqlite3.OperationalError as exc:
        raise ReconcileError(f"无法只读打开数据库：{path}（{exc}）。") from exc
    try:
        conn.row_factory = sqlite3.Row
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        if "word_states" not in tables:
            raise ReconcileError(
                "word_states 表不存在（未跑 0006_review_engine 迁移）。"
                "请先运行 backend/venv/bin/alembic upgrade head。"
            )
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(word_states)")
        }
        if "mastered" not in columns:
            # 旧库（< 0027）不可能有已掌握行：按产品读侧兼容返回空列表。
            return []
        rows = conn.execute(
            "SELECT id, user_id, lemma, target_lang, state, created_at, mastered "
            "FROM word_states WHERE user_id = ? AND mastered = 1 "
            "ORDER BY created_at DESC, id DESC",
            (user_id,),
        ).fetchall()

        return [dict(row) for row in rows]
    except sqlite3.Error as exc:
        raise ReconcileError(f"读取 word_states 失败：{exc}") from exc
    finally:
        conn.close()


def mastered_by_key(words: list[dict]) -> dict[str, dict]:
    grouped: dict[str, dict] = {}
    for word in words:
        if not isinstance(word, dict):
            continue
        key = normalize_word_key(word.get("lemma"))
        if key:
            grouped.setdefault(key, word)
    return grouped


def _favorite_source(record: dict) -> tuple[str, str]:
    kind = _clean_str(record.get("source_kind"))
    ref = _clean_str(record.get("source_ref"))
    return kind, ref


def _iso(ms: int) -> str:
    if not ms:
        return "-"
    return (
        dt.datetime.fromtimestamp(ms / 1000)
        .astimezone()
        .isoformat(timespec="seconds")
    )


def _now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def _now_ms() -> int:
    return int(dt.datetime.now().timestamp() * 1000)


def collect_overlaps(
    raw_records: list, with_ids: list, mastered: dict[str, dict]
) -> tuple[list[dict], list[dict]]:
    """返回 `(overlap 条目, 参与比较的 vocabulary 收藏)`。

    overlap 条目同时保留 `favorite`（文件里的原样记录，审计/回滚用）与
    `favorite_id`（补 id 后的稳定 id，删除用）。
    """
    overlaps: list[dict] = []
    vocabulary: list[dict] = []
    for raw, record in zip(raw_records, with_ids):
        if not isinstance(record, dict):
            continue
        if favorites_store._favorite_kind(record) != VOCABULARY_TYPE:
            continue
        vocabulary.append(record)
        text = favorites_store._first_text(record, "en_text", "text")
        key = normalize_word_key(text)
        if not key:
            continue
        word = mastered.get(key)
        if word is None:
            continue
        source_kind, source_ref = _favorite_source(record)
        overlaps.append(
            {
                "lemma": word.get("lemma"),
                "normalized_key": key,
                "favorite_id": record.get("id"),
                "en_text": text,
                "added_at": favorites_store._favorite_added_at(record),
                "added_at_iso": _iso(favorites_store._favorite_added_at(record)),
                "mastered_created_at": int(word.get("created_at") or 0),
                "mastered_created_at_iso": _iso(int(word.get("created_at") or 0)),
                "word_state_id": word.get("id"),
                "target_lang": word.get("target_lang"),
                "source_kind": source_kind or None,
                "source_ref": source_ref or None,
                "favorite": copy.deepcopy(raw),
            }
        )
    return overlaps, vocabulary


def scan_user(user_id: str) -> dict:
    """只读扫描一个用户：收藏统计 + mastered + overlap。"""
    paths = readonly_paths(user_id)
    raw, with_ids = _read_favorites_snapshot(paths["favorites"])
    mastered_words = load_mastered_words(user_id)
    overlaps, vocabulary = collect_overlaps(raw, with_ids, mastered_by_key(mastered_words))
    return {
        "user_id": user_id,
        "favorites_path": paths["favorites"],
        "favorites_exists": os.path.exists(paths["favorites"]),
        "favorites_total": len(raw),
        "vocabulary_count": len(vocabulary),
        "sentence_count": len(raw) - len(vocabulary),
        "mastered_count": len(mastered_words),
        "mastered_read_mode": _mastered_read_mode(paths["db"]),
        "overlaps": overlaps,
        "overlap_count": len(overlaps),
        "raw_records": raw,
        "with_ids": with_ids,
    }


def discover_user_ids() -> list[str]:
    """仅列目录：`USER_DATA_DIR` 下带 favorites.json 的用户（不建目录）。"""
    root = config.USER_DATA_DIR
    if not os.path.isdir(root):
        return []
    found = []
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if not os.path.isdir(path):
            continue
        if os.path.exists(os.path.join(path, "favorites.json")):
            found.append(name)
    return found


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------


def _overlap_table(overlaps: list[dict]) -> str:
    headers = (
        "#",
        "lemma",
        "favorite_id",
        "en_text",
        "added_at",
        "mastered_created_at",
        "source_kind/source_ref",
    )
    rows = []
    for index, item in enumerate(overlaps, start=1):
        source = "-"
        if item.get("source_kind") or item.get("source_ref"):
            source = f"{item.get('source_kind') or '-'}/{item.get('source_ref') or '-'}"
        rows.append(
            (
                str(index),
                str(item.get("lemma") or "-"),
                str(item.get("favorite_id") or "-"),
                str(item.get("en_text") or "-"),
                f"{item.get('added_at')} ({item.get('added_at_iso')})",
                f"{item.get('mastered_created_at')} ({item.get('mastered_created_at_iso')})",
                source,
            )
        )
    widths = [
        max(len(str(row[column])) for row in (headers, *rows))
        for column in range(len(headers))
    ]
    lines = ["  ".join(str(cell).ljust(widths[i]) for i, cell in enumerate(headers))]
    lines.append("  ".join("-" * width for width in widths))
    for row in rows:
        lines.append(
            "  ".join(str(cell).ljust(widths[i]) for i, cell in enumerate(row))
        )
    return "\n".join(lines)


def _report_base(scan: dict) -> dict:
    return {
        "script": SCRIPT_NAME,
        "generated_at": _now_iso(),
        "user_id": scan["user_id"],
        "favorites_path": scan["favorites_path"],
        "db_path": config.AUTH_DB_PATH,
        "favorites_total": scan["favorites_total"],
        "vocabulary_count": scan["vocabulary_count"],
        "sentence_count": scan["sentence_count"],
        "mastered_count": scan["mastered_count"],
        "mastered_read_mode": scan["mastered_read_mode"],
        "overlap_count": scan["overlap_count"],
        "overlaps": [
            {key: value for key, value in item.items() if key != "favorite"}
            for item in scan["overlaps"]
        ],
    }


def _print_scan_header(mode: str, scan: dict) -> None:
    print(f"== P0-02 reconcile mastered <-> favorites ({mode}) ==")
    print(f"user_id: {scan['user_id']}")
    print(f"favorites: {scan['favorites_path']} (read-only)")
    print(f"word_states: {config.AUTH_DB_PATH} (read-only)")
    print(
        f"favorites_total={scan['favorites_total']} "
        f"vocabulary={scan['vocabulary_count']} "
        f"sentence={scan['sentence_count']} "
        f"mastered={scan['mastered_count']}"
    )
    if scan["sentence_count"]:
        print("note: sentence 类型收藏不参与比对（我的单词只算 vocabulary）。")
    if scan["mastered_read_mode"] == "readonly-wal":
        print(
            "note: app.db 的 -wal 非空，已用真实只读连接读取最新提交；"
            "SQLite 可能创建/复用 -wal/-shm 共享文件（不写业务数据）。",
            file=sys.stderr,
        )
    if scan["overlap_count"]:
        print("")
        print(_overlap_table(scan["overlaps"]))
        print("")
    else:
        print("")


def _emit_json(report: dict) -> None:
    print(json.dumps(report, ensure_ascii=False, indent=2))


def _require_user_dir(user_id: str) -> None:
    user_root = readonly_paths(user_id)["user_root"]
    if not os.path.isdir(user_root):
        raise ReconcileError(
            f"用户目录不存在：{user_root}（请检查 --user-id 是否拼错）。"
        )


def _resolve_single_user(
    user_id: str | None, *, quiet: bool = False
) -> tuple[str, dict] | None:
    """dry-run 的用户解析：显式 --user-id，或自动定位唯一有 overlap 的用户。"""
    if user_id:
        uid = _validate_user_id(user_id)
        _require_user_dir(uid)
        return uid, scan_user(uid)

    candidates = discover_user_ids()
    if not candidates:
        raise ReconcileError(f"在 {config.USER_DATA_DIR} 下没有找到任何用户收藏文件。")
    scans = [scan_user(uid) for uid in candidates]
    overlap_users = [scan for scan in scans if scan["overlap_count"]]
    if len(overlap_users) == 1:
        scan = overlap_users[0]
        if not quiet:
            print(
                f"auto-detected user_id={scan['user_id']}（唯一存在 overlap 的用户）"
            )
        return scan["user_id"], scan
    if len(overlap_users) > 1:
        listing = ", ".join(
            f"{scan['user_id']}(overlap={scan['overlap_count']})"
            for scan in overlap_users
        )
        raise ReconcileError(
            f"多个用户存在 overlap（{listing}），请显式指定 --user-id。"
        )
    return None


# ---------------------------------------------------------------------------
# 命令：dry-run / check
# ---------------------------------------------------------------------------


def cmd_dry_run(args) -> int:
    resolved = _resolve_single_user(args.user_id, quiet=args.json)
    if resolved is None:
        report = {
            "script": SCRIPT_NAME,
            "mode": "dry-run",
            "ok": True,
            "generated_at": _now_iso(),
            "user_id": None,
            "overlap_count": 0,
            "overlaps": [],
            "write_files": 0,
            "note": "没有用户存在「已掌握仍在收藏」重叠。",
        }
        if args.json:
            _emit_json(report)
        else:
            print("== P0-02 reconcile mastered <-> favorites (dry-run) ==")
            print("overlap_count=0（没有用户存在重叠）")
            print("dry-run：未写任何文件。")
        return 0

    uid, scan = resolved
    if args.expect is not None and scan["overlap_count"] != args.expect:
        if args.json:
            report = _report_base(scan)
            report.update(
                {
                    "mode": "dry-run",
                    "ok": False,
                    "expected_overlap": args.expect,
                    "write_files": 0,
                }
            )
            _emit_json(report)
        else:
            _print_scan_header("dry-run", scan)
            print(
                f"ASSERT FAILED: 期望 overlap={args.expect}，"
                f"实际 overlap={scan['overlap_count']}。"
            )
        return 2

    report = _report_base(scan)
    report.update(
        {
            "mode": "dry-run",
            "ok": True,
            "expected_overlap": args.expect,
            "write_files": 0,
        }
    )
    if args.json:
        _emit_json(report)
        return 0

    _print_scan_header("dry-run", scan)
    print(f"overlap_count={scan['overlap_count']}")
    if args.expect is not None:
        print(f"assert overlap_count == {args.expect}: OK")
    print("dry-run：未备份、未写审计、未删除、未创建锁文件（0 写入）。")
    if scan["overlap_count"]:
        print("下一步（需 lead/用户确认后）：加 --apply --yes 执行。")
    return 0


def cmd_check(args) -> int:
    if args.user_id:
        uid = _validate_user_id(args.user_id)
        _require_user_dir(uid)
        uids = [uid]
    else:
        uids = discover_user_ids()
        if not uids:
            raise ReconcileError(
                f"在 {config.USER_DATA_DIR} 下没有找到任何用户收藏文件。"
            )

    scans = [scan_user(uid) for uid in uids]
    total = sum(scan["overlap_count"] for scan in scans)
    report = {
        "script": SCRIPT_NAME,
        "mode": "check",
        "ok": total == 0,
        "generated_at": _now_iso(),
        "overlap_total": total,
        "users": [
            {
                "user_id": scan["user_id"],
                "favorites_total": scan["favorites_total"],
                "vocabulary_count": scan["vocabulary_count"],
                "mastered_count": scan["mastered_count"],
                "overlap_count": scan["overlap_count"],
                "overlap_favorite_ids": [
                    item["favorite_id"] for item in scan["overlaps"]
                ],
            }
            for scan in scans
        ],
        "write_files": 0,
    }
    if args.json:
        _emit_json(report)
    else:
        print("== P0-02 reconcile check (read-only) ==")
        for scan in scans:
            print(
                f"user={scan['user_id']} favorites={scan['favorites_total']} "
                f"vocabulary={scan['vocabulary_count']} "
                f"mastered={scan['mastered_count']} "
                f"overlap={scan['overlap_count']}"
            )
        print(f"overlap_total={total}")
        if total:
            print(
                "VIOLATION: favorites ∩ word_states.mastered 不为空；"
                "确认后用 --apply --yes 修复。"
            )
        else:
            print("OK: favorites ∩ word_states.mastered = ∅")
    return 0 if total == 0 else 1


# ---------------------------------------------------------------------------
# 命令：apply
# ---------------------------------------------------------------------------


def _unique_output_paths(backup_dir: str, user_id: str) -> tuple[str, str, str]:
    for attempt in range(1000):
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        if attempt:
            stamp = f"{stamp}-{attempt}"
        backup = os.path.join(backup_dir, f"favorites-{user_id}-{stamp}.json")
        audit = os.path.join(
            backup_dir, f"reconcile-audit-{user_id}-{stamp}.jsonl"
        )
        if not os.path.exists(backup) and not os.path.exists(audit):
            return backup, audit, stamp
    raise ReconcileError(f"无法在 {backup_dir} 生成唯一备份文件名。")


def _write_jsonl_line(handle, payload: dict) -> None:
    handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=False) + "\n")
    handle.flush()
    os.fsync(handle.fileno())


def _word_states_fingerprint(words: list[dict]) -> list[tuple]:
    return sorted(
        (
            str(word.get("id") or ""),
            str(word.get("lemma") or ""),
            str(word.get("state") or ""),
            int(word.get("created_at") or 0),
            int(word.get("mastered") or 0),
        )
        for word in words
    )


def _delete_one_favorite(
    favorites_path: str, favorite_id: str, tombstones_path: str
) -> bool:
    """按产品的 DELETE 语义删一条：写收藏 + 写墓碑；重复删除返回 False。"""
    records = favorites_store._with_missing_ids(
        favorites_store._load_favorites_unlocked(favorites_path)
    )
    remaining = [
        item
        for item in records
        if not (isinstance(item, dict) and item.get("id") == favorite_id)
    ]
    if len(remaining) == len(records):
        return False
    favorites_store._write_favorites_unlocked(favorites_path, remaining)
    tombstones = favorites_store._load_tombstones_unlocked(tombstones_path)
    tombstones[favorite_id] = _now_ms()
    favorites_store._write_tombstones_unlocked(tombstones_path, tombstones)
    return True


def cmd_apply(args) -> int:
    if not args.user_id:
        raise ReconcileError("--apply 必须显式指定 --user-id（防误删）。")
    if not args.yes:
        raise ReconcileError("--apply 必须同时给出 --yes（人工确认）。")
    uid = _validate_user_id(args.user_id)
    paths = readonly_paths(uid)
    if not os.path.exists(paths["favorites"]):
        raise ReconcileError(f"用户 {uid} 没有收藏文件：{paths['favorites']}")

    backup_dir = args.backup_dir or os.path.join(config.DATA_DIR, "backups")

    with user_scope(uid):
        favorites_path = storage.favorites_file()
        tombstones_path = storage.favorites_tombstones_file()
        with favorites_store._favorites_file_lock(favorites_path):
            raw, with_ids = _read_favorites_snapshot(favorites_path)
            mastered_words_before = load_mastered_words(uid)
            overlap_items, vocabulary = collect_overlaps(
                raw, with_ids, mastered_by_key(mastered_words_before)
            )
            before_total = len(raw)
            before_vocabulary = len(vocabulary)
            before_mastered_fingerprint = _word_states_fingerprint(mastered_words_before)

            if not overlap_items:
                report = {
                    "script": SCRIPT_NAME,
                    "mode": "apply",
                    "ok": True,
                    "generated_at": _now_iso(),
                    "user_id": uid,
                    "favorites_path": favorites_path,
                    "favorites_total": before_total,
                    "vocabulary_count": before_vocabulary,
                    "mastered_count": len(mastered_words_before),
                    "overlap_count": 0,
                    "deleted_count": 0,
                    "deleted_favorite_ids": [],
                    "write_files": 0,
                    "note": "没有 overlap，未做任何写入。",
                }
                if args.json:
                    _emit_json(report)
                else:
                    print("== P0-02 reconcile (apply) ==")
                    print(f"user_id={uid}")
                    print(
                        "overlap_count=0：无需删除；未备份、未写审计"
                        "（仅获取过文件锁）。"
                    )
                return 0

            os.makedirs(backup_dir, exist_ok=True)
            backup_path, audit_path, _stamp = _unique_output_paths(backup_dir, uid)
            favorites_store._atomic_write_json(backup_path, raw)

            deleted_ids: list[str] = []
            started_at_iso = _now_iso()
            with open(audit_path, "w", encoding="utf-8") as audit:
                _write_jsonl_line(
                    audit,
                    {
                        "type": "header",
                        "script": SCRIPT_NAME,
                        "audit_version": AUDIT_VERSION,
                        "mode": "apply",
                        "user_id": uid,
                        "started_at": started_at_iso,
                        "favorites_path": favorites_path,
                        "tombstones_path": tombstones_path,
                        "db_path": config.AUTH_DB_PATH,
                        "backup_path": backup_path,
                        "favorites_total_before": before_total,
                        "vocabulary_count_before": before_vocabulary,
                        "mastered_count": len(mastered_words_before),
                        "overlap_planned": [
                            item["favorite_id"] for item in overlap_items
                        ],
                        "normalization": "NFC + strip + lower（不做词形还原）",
                        "audit_policy": (
                            "deleted 行先落盘再删除；回滚时仍在的 id 幂等跳过"
                        ),
                        "reason": "mastered_favorite_overlap",
                    },
                )

                # 任务卡要求「先备份 + 写 JSONL 审计（原记录全文 + 依据 + 时间），
                # 再逐条删除」：先把全部待删记录落盘并 fsync，再动收藏文件。
                # 这样即使删到一半进程崩溃，--rollback 也能恢复每一条候选；
                # 对「审计先写、实际没删」的条目，回滚时因 id 仍在而幂等跳过。
                planned_ids: list[str] = []
                for item in overlap_items:
                    favorite_id = str(item["favorite_id"] or "")
                    if not favorite_id:
                        raise ReconcileError(
                            "overlap 条目没有稳定 id，拒绝删除（请人工检查）。"
                        )
                    planned_ids.append(favorite_id)
                    _write_jsonl_line(
                        audit,
                        {
                            "type": "deleted",
                            "phase": "before_delete",
                            "deleted_at": _now_iso(),
                            "deleted_at_ms": _now_ms(),
                            "user_id": uid,
                            "reason": "mastered_favorite_overlap",
                            "lemma": item["lemma"],
                            "normalized_key": item["normalized_key"],
                            "favorite_id": favorite_id,
                            "favorite": item["favorite"],
                            "basis": {
                                "en_text": item["en_text"],
                                "added_at": item["added_at"],
                                "added_at_iso": item["added_at_iso"],
                                "mastered_created_at": item["mastered_created_at"],
                                "mastered_created_at_iso": item[
                                    "mastered_created_at_iso"
                                ],
                                "word_state_id": item["word_state_id"],
                                "target_lang": item["target_lang"],
                                "source_kind": item["source_kind"],
                                "source_ref": item["source_ref"],
                            },
                            "backup_path": backup_path,
                        },
                    )

                for favorite_id in planned_ids:
                    removed = _delete_one_favorite(
                        favorites_path, favorite_id, tombstones_path
                    )
                    if not removed:
                        # 锁内不应发生；若发生说明并发写者绕过锁，记审计但不谎报。
                        print(
                            f"WARN: favorite {favorite_id} 已不在收藏中，跳过。",
                            file=sys.stderr,
                        )
                        continue
                    deleted_ids.append(favorite_id)

                # 收尾自检：重读文件、重算 overlap、核对 word_states 未变。
                raw_after, with_ids_after = _read_favorites_snapshot(favorites_path)
                mastered_words_after = load_mastered_words(uid)
                overlap_after, vocabulary_after = collect_overlaps(
                    raw_after, with_ids_after, mastered_by_key(mastered_words_after)
                )
                after_mastered_fingerprint = _word_states_fingerprint(
                    mastered_words_after
                )
                word_states_unchanged = (
                    before_mastered_fingerprint == after_mastered_fingerprint
                )
                _write_jsonl_line(
                    audit,
                    {
                        "type": "result",
                        "finished_at": _now_iso(),
                        "user_id": uid,
                        "deleted_count": len(deleted_ids),
                        "deleted_favorite_ids": deleted_ids,
                        "favorites_total_after": len(raw_after),
                        "vocabulary_count_after": len(vocabulary_after),
                        "overlap_after": len(overlap_after),
                        "word_states_unchanged": word_states_unchanged,
                        "mastered_count_before": len(mastered_words_before),
                        "mastered_count_after": len(mastered_words_after),
                    },
                )

            report = {
                "script": SCRIPT_NAME,
                "mode": "apply",
                "ok": len(overlap_after) == 0 and word_states_unchanged,
                "generated_at": _now_iso(),
                "user_id": uid,
                "favorites_path": favorites_path,
                "backup_path": backup_path,
                "audit_path": audit_path,
                "favorites_total_before": before_total,
                "favorites_total_after": len(raw_after),
                "vocabulary_count_before": before_vocabulary,
                "vocabulary_count_after": len(vocabulary_after),
                "mastered_count_before": len(mastered_words_before),
                "mastered_count_after": len(mastered_words_after),
                "deleted_count": len(deleted_ids),
                "deleted_favorite_ids": deleted_ids,
                "overlap_after": len(overlap_after),
                "word_states_unchanged": word_states_unchanged,
                # 备份 + 审计 = 2 个文件；每条删除再各写收藏与墓碑。
                "write_files": 2,
                "write_operations": 2 + 2 * len(deleted_ids),
            }

    if args.json:
        _emit_json(report)
        return 0 if report["ok"] else 1

    print("== P0-02 reconcile (apply) ==")
    print(f"user_id={uid}")
    print(f"backup={backup_path}")
    print(f"audit={audit_path}")
    print(f"overlap_before={len(overlap_items)}")
    print("deleted: " + ", ".join(deleted_ids))
    print(
        f"favorites_total: {before_total} -> {len(raw_after)} "
        f"(vocabulary {before_vocabulary} -> {len(vocabulary_after)})"
    )
    print(
        f"word_states: unchanged={word_states_unchanged} "
        f"(mastered {len(mastered_words_before)} -> {len(mastered_words_after)})"
    )
    print(f"overlap_after={len(overlap_after)}")
    if report["ok"]:
        print("done")
        return 0
    print("ERROR: 自检未通过，请检查审计与备份。", file=sys.stderr)
    return 1


# ---------------------------------------------------------------------------
# 命令：rollback
# ---------------------------------------------------------------------------


def _load_audit(path: str) -> tuple[dict, list[dict]]:
    if not os.path.exists(path):
        raise ReconcileError(f"审计文件不存在：{path}")
    header = None
    deleted: list[dict] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            text = line.strip()
            if not text:
                continue
            try:
                payload = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ReconcileError(
                    f"审计文件第 {line_number} 行不是合法 JSON：{exc}"
                ) from exc
            if not isinstance(payload, dict):
                raise ReconcileError(f"审计文件第 {line_number} 行不是 JSON 对象。")
            if payload.get("type") == "header":
                header = payload
            elif payload.get("type") == "deleted":
                if not isinstance(payload.get("favorite"), dict):
                    raise ReconcileError(
                        f"审计文件第 {line_number} 行缺少 favorite 原始记录。"
                    )
                deleted.append(payload)
            elif payload.get("type") == "result":
                continue
            else:
                raise ReconcileError(
                    f"审计文件第 {line_number} 行 type 未知：{payload.get('type')!r}"
                )
    if header is None:
        raise ReconcileError("审计文件没有 header 行，无法确定用户与备份。")
    return header, deleted


def cmd_rollback(args) -> int:
    audit_path = os.path.abspath(args.rollback)
    header, deleted = _load_audit(audit_path)
    uid = _validate_user_id(str(header.get("user_id") or ""))
    if args.user_id and _validate_user_id(args.user_id) != uid:
        raise ReconcileError(
            f"--user-id={args.user_id} 与审计文件 user_id={uid} 不一致，拒绝恢复。"
        )
    if not deleted:
        raise ReconcileError("审计文件里没有可恢复的 deleted 记录。")

    restored: list[str] = []
    already_present: list[str] = []
    stale: list[str] = []
    with user_scope(uid):
        favorites_path = storage.favorites_file()
        tombstones_path = storage.favorites_tombstones_file()
        with favorites_store._favorites_file_lock(favorites_path):
            raw, with_ids = _read_favorites_snapshot(favorites_path)
            existing_ids = {
                item.get("id")
                for item in with_ids
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
            merged = list(raw)
            audit_ids: list[str] = []
            for entry in deleted:
                favorite = copy.deepcopy(entry["favorite"])
                favorite_id = entry.get("favorite_id") or favorite.get("id")
                favorite_id = str(favorite_id) if favorite_id else ""
                if not favorite_id:
                    raise ReconcileError(
                        "审计记录缺少 favorite_id，无法幂等恢复。"
                    )
                audit_ids.append(favorite_id)
                if favorite_id in existing_ids:
                    already_present.append(favorite_id)
                    continue
                if favorite.get("id") != favorite_id:
                    # 原文件这条可能本来没有 id（产品读时按内容指纹补同一个
                    # id）；统一写成实际删除用的稳定 id，保证重复回滚幂等。
                    favorite["id"] = favorite_id
                merged.append(favorite)
                existing_ids.add(favorite_id)
                restored.append(favorite_id)

            if restored:
                favorites_store._write_favorites_unlocked(favorites_path, merged)

            # 幂等收尾：审计涉及的 id 只要现在存在，就把残留墓碑清掉
            # （崩溃在「写收藏」与「清墓碑」之间时，重跑能自愈）。
            current_ids = {
                item.get("id")
                for item in favorites_store._with_missing_ids(
                    favorites_store._load_favorites_unlocked(favorites_path)
                )
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
            tombstones = favorites_store._load_tombstones_unlocked(tombstones_path)
            stale = sorted(
                key for key in audit_ids if key in tombstones and key in current_ids
            )
            if stale:
                for key in stale:
                    tombstones.pop(key, None)
                favorites_store._write_tombstones_unlocked(tombstones_path, tombstones)

            raw_after, with_ids_after = _read_favorites_snapshot(favorites_path)
            vocabulary_after = [
                item
                for item in with_ids_after
                if isinstance(item, dict)
                and favorites_store._favorite_kind(item) == VOCABULARY_TYPE
            ]

    report = {
        "script": SCRIPT_NAME,
        "mode": "rollback",
        "ok": True,
        "generated_at": _now_iso(),
        "user_id": uid,
        "audit_path": audit_path,
        "backup_path": header.get("backup_path"),
        "restored_count": len(restored),
        "restored_favorite_ids": restored,
        "already_present_count": len(already_present),
        "already_present_favorite_ids": already_present,
        "tombstones_cleared": stale,
        "favorites_total": len(raw_after),
        "vocabulary_count": len(vocabulary_after),
        "note": "回滚按设计会重新产生 mastered ∩ favorites 重叠；不变量需再次 reconcile。",
    }
    if args.json:
        _emit_json(report)
        return 0

    print("== P0-02 reconcile (rollback) ==")
    print(f"user_id={uid}")
    print(f"audit={audit_path}")
    print(f"restored={len(restored)} {restored}")
    print(f"already_present={len(already_present)} {already_present}")
    print(f"tombstones_cleared={report['tombstones_cleared']}")
    print(
        f"favorites_total={len(raw_after)} vocabulary={len(vocabulary_after)}"
    )
    print("note: 回滚按设计会恢复 overlap（互斥不变量暂时不成立）。")
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="P0-02：清理「已掌握仍在收藏」的存量收藏（默认 dry-run，只读）。",
        epilog="默认无参数 = dry-run；绝不会静默删除。",
    )
    parser.add_argument("--user-id", help="目标用户 id；dry-run 省略时自动定位唯一重叠用户")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只读扫描并打印清单（默认行为，保留此开关便于语义清晰）",
    )
    parser.add_argument(
        "--apply", action="store_true", help="执行删除（需 --user-id 与 --yes）"
    )
    parser.add_argument("--yes", action="store_true", help="确认执行 --apply")
    parser.add_argument(
        "--check", action="store_true", help="只读巡检 overlap；有重叠时退出码 1"
    )
    parser.add_argument(
        "--rollback", metavar="AUDIT_JSONL", help="按审计 JSONL 幂等恢复被删收藏"
    )
    parser.add_argument(
        "--expect",
        type=int,
        metavar="N",
        help="dry-run 断言 overlap 数；不符时退出码 2",
    )
    parser.add_argument(
        "--backup-dir",
        help="备份与审计目录（默认 <repo>/data/backups）",
    )
    parser.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    selected = sum(
        1 for flag in (args.apply, args.check, bool(args.rollback)) if flag
    )
    if selected > 1:
        print("ERROR: --apply / --check / --rollback 只能选一个。", file=sys.stderr)
        return 2
    try:
        if args.rollback:
            return cmd_rollback(args)
        if args.check:
            return cmd_check(args)
        if args.apply:
            return cmd_apply(args)
        return cmd_dry_run(args)
    except ReconcileError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
