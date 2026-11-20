"""数据导出：配额、后台 ZIP 生成、一次性下载 token、过期清理（M2a / specs/033）。

口径（D-5 拍板）：ZIP（JSON + 用户文件）；1 次/24h、3 次/30 天；临时文件 24h
过期；密码确认；同一用户同时只允许 1 个 queued/running 任务；200MB 上限。

安全约束：

- ``data_export_jobs.download_token_hash`` 只存 sha256，明文 token 只在
  ``POST /api/account/export`` 的 202 响应里出现一次；
- ``file_path`` 只存相对 ``config.EXPORTS_DIR`` 的路径，下载/删除时经
  ``account_lifecycle.safe_export_path`` 做 realpath 校验；**不接受客户端路径**；
- ZIP 内所有条目名都经过 ``_safe_arcname``（拒绝绝对路径与 ``..``），生成端
  不读用户提供的路径，避免 Zip Slip；
- 导出不包含密码哈希、会话/Cookie/token、他人数据、公共缓存、备份、日志、
  模型 prompt（当前不存）；``manifest.json`` 只含 sha256 和文件清单；
- 生成失败标记 ``failed``，删除半成品，不把失败伪装成 ready。

后台生成用 daemon 线程（单 worker 部署）；测试可用 ``wait_for_export()`` 等
终态，或直接调用 ``run_export_job()`` 同步执行。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import sqlite3
import threading
import time
import uuid
import zipfile
from datetime import datetime, timezone

import account_lifecycle as lifecycle
import auth_db
import config
import storage

logger = logging.getLogger("linguatrek.account_export")

STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_READY = "ready"
STATUS_FAILED = "failed"
STATUS_EXPIRED = "expired"
ACTIVE_STATUSES = (STATUS_QUEUED, STATUS_RUNNING)
TERMINAL_STATUSES = (STATUS_READY, STATUS_FAILED, STATUS_EXPIRED)

EXPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000
EXPORT_WINDOW_30D_MS = 30 * 24 * 60 * 60 * 1000
EXPORT_WINDOW_30D_LIMIT = 3
STALE_JOB_MS = 2 * 60 * 60 * 1000

FORMAT_VERSION = "linguatrek.export.v1"
MAX_ENTRIES = 20_000
MAX_ERROR_CHARS = 500
MANIFEST_NAME = "manifest.json"
README_NAME = "README.md"

_MANIFEST_EXCLUDED = [
    "password_hash（密码哈希）",
    "sessions / Cookie / 会话 token",
    "其它用户的数据",
    "公共缓存与词典：content_difficulty、content_teaching_analysis、"
    "book_chapter_translations、questions 公共题库、data/subtitles、data/ecdict.db",
    "备份文件（backups/ 与离机副本）",
    "内部日志、管理员审计、模型 prompt（当前不存）",
    "游客目录 data/guests/<hash>（无法可靠映射到账号）",
]


class ExportError(lifecycle.LifecycleError):
    code = "export_error"
    status_code = 400


class ExportBusy(ExportError):
    code = "export_busy"
    status_code = 409


class ExportRateLimited(ExportError):
    code = "export_rate_limited"
    status_code = 429


class ExportNotFound(ExportError):
    code = "export_not_found"
    status_code = 404


class ExportNotReady(ExportError):
    code = "export_not_ready"
    status_code = 409


class ExportFailed(ExportError):
    code = "export_failed"
    status_code = 409


class ExportTokenInvalid(ExportError):
    code = "export_token_invalid"
    status_code = 403


class ExportExpired(ExportError):
    code = "export_expired"
    status_code = 410


def now_ms() -> int:
    return int(time.time() * 1000)


def ttl_ms() -> int:
    return max(1, int(config.EXPORT_TTL_HOURS or 0)) * 60 * 60 * 1000


def hash_download_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def reset_export_state() -> None:
    """测试隔离：清理进程内生成标记（DB 状态仍以表为准）。"""
    with _generating_lock:
        _generating.clear()


_generating: set[str] = set()
_generating_lock = threading.Lock()


def _connect():
    return auth_db.connect()


def _require(conn: sqlite3.Connection) -> None:
    lifecycle.ensure_schema(conn)


def _job_public(row: sqlite3.Row) -> dict:
    now = now_ms()
    expires = row["expires_at_ms"]
    return {
        "id": row["id"],
        "status": row["status"],
        "requestedAt": int(row["requested_at_ms"]),
        "completedAt": (
            int(row["completed_at_ms"]) if row["completed_at_ms"] is not None else None
        ),
        "expiresAt": int(expires) if expires is not None else None,
        "sizeBytes": int(row["size_bytes"]) if row["size_bytes"] is not None else None,
        "downloadedAt": (
            int(row["downloaded_at_ms"])
            if row["downloaded_at_ms"] is not None
            else None
        ),
        "error": row["error"],
        "downloadable": bool(
            row["status"] == STATUS_READY
            and expires is not None
            and int(expires) > now
            and row["file_path"]
        ),
    }


def _quota_state(conn: sqlite3.Connection, user_id: str, moment: int) -> dict:
    """返回该用户 24h / 30 天窗口内的导出次数与最早可重试时间。"""
    since_30d = moment - EXPORT_WINDOW_30D_MS
    # 口径按 D-5 字面：每个创建出来的导出任务（含 failed/expired）都计入配额。
    rows = conn.execute(
        "SELECT requested_at_ms FROM data_export_jobs "
        "WHERE user_id = ? AND requested_at_ms >= ? "
        "ORDER BY requested_at_ms ASC",
        (user_id, since_30d),
    ).fetchall()
    timestamps = [int(row["requested_at_ms"]) for row in rows]
    since_24h = moment - EXPORT_COOLDOWN_MS
    in_24h = [ts for ts in timestamps if ts > since_24h]
    return {
        "count24h": len(in_24h),
        "count30d": len(timestamps),
        "oldest24h": min(in_24h) if in_24h else None,
        "oldest30d": timestamps[0] if timestamps else None,
    }


def create_export_job(
    user: dict,
    password: object,
    *,
    http_request_id: str | None = None,
) -> dict:
    """密码确认 + 限流检查 + 创建 queued 任务，返回只出现一次的下载 token。"""
    lifecycle.check_password_or_raise("export", user, password)
    cleanup_exports()
    moment = now_ms()
    job_id = f"exp-{uuid.uuid4().hex}"
    token = secrets.token_urlsafe(32)
    token_hash = hash_download_token(token)
    expires_at = moment + ttl_ms()

    conn = _connect()
    try:
        _require(conn)
        try:
            conn.execute("BEGIN IMMEDIATE")
            active = conn.execute(
                "SELECT id FROM data_export_jobs WHERE user_id = ? "
                "AND status IN (?, ?) LIMIT 1",
                (user["id"], *ACTIVE_STATUSES),
            ).fetchone()
            if active is not None:
                raise ExportBusy("已有导出任务正在生成，请稍后重试。")
            quota = _quota_state(conn, user["id"], moment)
            if quota["count24h"] >= 1:
                retry_ms = int(quota["oldest24h"] or moment) + EXPORT_COOLDOWN_MS - moment
                raise ExportRateLimited(
                    "24 小时内只能导出 1 次，请稍后再试。",
                    retryAfter=max(1, retry_ms // 1000),
                    window="24h",
                )
            if quota["count30d"] >= EXPORT_WINDOW_30D_LIMIT:
                retry_ms = (
                    int(quota["oldest30d"] or moment) + EXPORT_WINDOW_30D_MS - moment
                )
                raise ExportRateLimited(
                    "30 天内最多导出 3 次，请稍后再试。",
                    retryAfter=max(1, retry_ms // 1000),
                    window="30d",
                )
            conn.execute(
                "INSERT INTO data_export_jobs "
                "(id, user_id, status, requested_at_ms, expires_at_ms, "
                "download_token_hash) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    job_id,
                    user["id"],
                    STATUS_QUEUED,
                    moment,
                    expires_at,
                    token_hash,
                ),
            )
            lifecycle.write_audit(
                user["id"],
                "account.export.request",
                target_type="export_job",
                target_id=job_id,
                detail={"requestedAt": moment, "expiresAt": expires_at},
                request_id=http_request_id,
                conn=conn,
                required=True,
            )
            conn.commit()
        except sqlite3.IntegrityError as exc:
            conn.rollback()
            if "data_export_jobs" in str(exc) or "UNIQUE" in str(exc).upper():
                raise ExportBusy("已有导出任务正在生成，请稍后重试。") from exc
            raise
        except Exception:
            conn.rollback()
            raise
    finally:
        conn.close()

    start_export_job(job_id)
    return {
        "jobId": job_id,
        "status": STATUS_QUEUED,
        "requestedAt": moment,
        "expiresAt": expires_at,
        "downloadToken": token,
        "downloadPath": f"/api/account/export/{job_id}?token={token}",
        "limits": export_limits(),
    }


def export_limits() -> dict:
    return {
        "per24h": 1,
        "per30d": EXPORT_WINDOW_30D_LIMIT,
        "ttlHours": int(config.EXPORT_TTL_HOURS or 0),
        "maxBytes": int(config.EXPORT_MAX_BYTES or 0),
        "concurrentJobs": 1,
    }


def start_export_job(job_id: str) -> None:
    """后台 daemon 线程生成；HTTP 请求立即 202。"""
    thread = threading.Thread(
        target=run_export_job,
        args=(job_id,),
        name=f"export-{job_id[:12]}",
        daemon=True,
    )
    thread.start()


def run_export_job(job_id: str) -> None:
    """把 queued 任务置 running 并生成 ZIP；可同步调用（测试/运维）。"""
    conn = _connect()
    try:
        _require(conn)
        cursor = conn.execute(
            "UPDATE data_export_jobs SET status = ?, completed_at_ms = NULL, error = NULL "
            "WHERE id = ? AND status = ?",
            (STATUS_RUNNING, job_id, STATUS_QUEUED),
        )
        conn.commit()
        if not cursor.rowcount:
            return
    except lifecycle.LifecycleUnavailable:
        return
    except sqlite3.Error:
        logger.exception("导出任务启动失败：%s", job_id)
        return
    finally:
        conn.close()

    with _generating_lock:
        if job_id in _generating:
            return
        _generating.add(job_id)
    try:
        result = _generate_zip(job_id)
        completed_at = now_ms()
        expires_at = completed_at + ttl_ms()
        conn = _connect()
        try:
            cursor = conn.execute(
                "UPDATE data_export_jobs SET status = ?, completed_at_ms = ?, "
                "expires_at_ms = ?, file_path = ?, size_bytes = ?, error = NULL "
                "WHERE id = ? AND status IN (?, ?)",
                (
                    STATUS_READY,
                    completed_at,
                    expires_at,
                    result["filePath"],
                    result["sizeBytes"],
                    job_id,
                    STATUS_QUEUED,
                    STATUS_RUNNING,
                ),
            )
            conn.commit()
            if not cursor.rowcount:
                # 生成期间被清理/删除（如 2 小时僵尸任务）：不把任务改回 ready，
                # 同时删掉刚生成的孤儿 ZIP。
                _remove_file(result["filePath"])
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001 - 任何生成失败都标 failed
        logger.exception("导出任务生成失败：%s", job_id)
        _mark_failed(job_id, f"{type(exc).__name__}: {exc}")
    finally:
        with _generating_lock:
            _generating.discard(job_id)


def _mark_failed(job_id: str, error: str) -> None:
    error = (error or "unknown")[:MAX_ERROR_CHARS]
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT file_path FROM data_export_jobs WHERE id = ?", (job_id,)
        ).fetchone()
        if row is not None and row["file_path"]:
            _remove_file(row["file_path"])
        conn.execute(
            "UPDATE data_export_jobs SET status = ?, completed_at_ms = ?, "
            "file_path = NULL, size_bytes = NULL, error = ? "
            "WHERE id = ? AND status IN (?, ?)",
            (STATUS_FAILED, now_ms(), error, job_id, STATUS_QUEUED, STATUS_RUNNING),
        )
        conn.commit()
    except Exception:  # noqa: BLE001 - 失败处理本身不能把线程打崩
        logger.exception("标记导出失败时出错：%s", job_id)
    finally:
        conn.close()


def wait_for_export(job_id: str, timeout: float = 10.0) -> dict | None:
    """轮询到终态（测试/脚本用）；超时返回当前行。"""
    deadline = time.monotonic() + max(0.0, float(timeout))
    while True:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT id, status, requested_at_ms, completed_at_ms, "
                "expires_at_ms, size_bytes, downloaded_at_ms, error, file_path "
                "FROM data_export_jobs WHERE id = ?",
                (job_id,),
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            return None
        if row["status"] in TERMINAL_STATUSES or time.monotonic() >= deadline:
            return _job_public(row)
        time.sleep(0.02)


# ---------------------------------------------------------------------------
# ZIP 生成
# ---------------------------------------------------------------------------

def _open_readonly_db() -> sqlite3.Connection:
    path = config.AUTH_DB_PATH
    if not os.path.exists(path):
        raise RuntimeError("数据库文件不存在")
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?", (table,)
    ).fetchone()
    return row is not None


def _rows(conn: sqlite3.Connection, table: str, sql: str, params: tuple = ()) -> list[dict]:
    if not _table_exists(conn, table):
        return []
    return [dict(row) for row in conn.execute(sql, params).fetchall()]


def _iso_utc(moment: datetime | None = None) -> str:
    value = moment or datetime.now(timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _safe_arcname(raw: object) -> str:
    """ZIP 条目名：正斜杠、相对路径；拒绝绝对路径与 ``..``（Zip Slip 防护）。"""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("空的 ZIP 条目名")
    name = raw.replace("\\", "/").strip()
    if name.startswith("/"):
        raise ValueError("ZIP 条目名不能是绝对路径")
    parts = [part for part in name.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        raise ValueError(f"非法 ZIP 条目名：{raw!r}")
    return "/".join(parts)


def _json_bytes(payload: object) -> bytes:
    return json.dumps(
        payload, ensure_ascii=False, indent=2, sort_keys=False
    ).encode("utf-8")


class _ZipWriter:
    """往 ZIP 里写条目并记录 size/sha256；总未压缩字节超限即失败。"""

    def __init__(self, archive: zipfile.ZipFile, max_bytes: int) -> None:
        self.archive = archive
        self.max_bytes = max(1, int(max_bytes))
        self.total_bytes = 0
        self.entries: list[dict] = []
        self.entry_count = 0

    def _account(self, arcname: str, size: int) -> str:
        name = _safe_arcname(arcname)
        if self.entry_count >= MAX_ENTRIES:
            raise RuntimeError(f"导出文件条目超过上限 {MAX_ENTRIES}")
        self.entry_count += 1
        self.total_bytes += max(0, int(size))
        if self.total_bytes > self.max_bytes:
            raise RuntimeError(
                f"导出数据超过 {self.max_bytes} 字节上限，未生成 ZIP"
            )
        return name

    def add_bytes(self, arcname: str, data: bytes) -> None:
        name = self._account(arcname, len(data))
        info = zipfile.ZipInfo(name, date_time=time.localtime()[:6])
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o600 << 16
        self.archive.writestr(info, data)
        self.entries.append(
            {
                "path": name,
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )

    def add_json(self, arcname: str, payload: object) -> None:
        self.add_bytes(arcname, _json_bytes(payload))

    def add_file(self, arcname: str, path: str) -> None:
        size = os.path.getsize(path)
        name = self._account(arcname, size)
        digest = hashlib.sha256()
        info = zipfile.ZipInfo(name, date_time=time.localtime()[:6])
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o600 << 16
        written = 0
        with self.archive.open(info, "w") as target, open(path, "rb") as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                target.write(chunk)
                written += len(chunk)
        self.entries.append(
            {"path": name, "bytes": written, "sha256": digest.hexdigest()}
        )

    def add_tree(
        self,
        prefix: str,
        root: str,
        *,
        skip_hidden: bool = False,
    ) -> int:
        """把 root 下的普通文件加入 prefix/；跳过符号链接与临时文件。"""
        if not os.path.isdir(root) or os.path.islink(root):
            return 0
        added = 0
        root_real = os.path.realpath(root)
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            dirnames[:] = [
                name
                for name in sorted(dirnames)
                if not os.path.islink(os.path.join(dirpath, name))
                and not name.startswith(".tmp-")
                and not name.startswith(".")
            ]
            for filename in sorted(filenames):
                if filename.endswith(".lock") or ".tmp-" in filename:
                    continue
                if skip_hidden and filename.startswith("."):
                    continue
                path = os.path.join(dirpath, filename)
                if os.path.islink(path) or not os.path.isfile(path):
                    continue
                real = os.path.realpath(path)
                if real != root_real and not real.startswith(root_real + os.sep):
                    continue
                relative = os.path.relpath(path, root)
                self.add_file(f"{prefix}/{relative}", path)
                added += 1
        return added


def _user_files_root(user_id: str) -> str:
    root = os.path.realpath(config.USER_DATA_DIR)
    candidate = os.path.realpath(storage.user_data_dir(user_id))
    if candidate == root or not candidate.startswith(root + os.sep):
        raise RuntimeError("用户数据目录越界")
    return candidate


def _add_learning_files(writer: _ZipWriter, user_id: str) -> int:
    root = _user_files_root(user_id)
    added = 0
    history = os.path.join(root, "history")
    added += writer.add_tree("data/learning/history", history, skip_hidden=True)
    for filename in (
        "favorites.json",
        "favorites_tombstones.json",
        "subscriptions.json",
    ):
        path = os.path.join(root, filename)
        if os.path.isfile(path) and not os.path.islink(path):
            writer.add_file(f"data/learning/{filename}", path)
            added += 1
    return added


def _add_book_files(writer: _ZipWriter, user_id: str) -> int:
    root = os.path.realpath(storage.user_books_dir(user_id))
    if not os.path.isdir(root) or os.path.islink(root):
        return 0
    added = 0
    try:
        entries = sorted(os.scandir(root), key=lambda item: item.name)
    except OSError:
        return 0
    for entry in entries:
        if not entry.is_dir(follow_symlinks=False):
            continue
        if entry.name.startswith(".") or ".tmp-" in entry.name:
            continue
        added += writer.add_tree(
            f"files/books/{entry.name}", entry.path, skip_hidden=True
        )
    return added


def _load_profile(conn: sqlite3.Connection, user_id: str) -> dict:
    row = conn.execute(
        "SELECT id, email, username, created_at, status, credits FROM users "
        "WHERE id = ?",
        (user_id,),
    ).fetchone()
    if row is None:
        raise RuntimeError("user_not_found")
    return {
        "id": row["id"],
        "email": row["email"],
        "username": row["username"],
        "createdAtMs": int(row["created_at"] or 0) * 1000,
        "createdAt": _iso_utc(
            datetime.fromtimestamp(int(row["created_at"] or 0), timezone.utc)
        ),
        "status": row["status"],
        # users.credits 是 M3 前的旧单位（未定义美元）；不伪造成 µUSD。
        "creditsLegacy": int(row["credits"] or 0),
        "creditsNote": "旧单位；M3 金额模型上线前不代表美元余额",
    }


def _build_payloads(conn: sqlite3.Connection, user_id: str) -> tuple[dict, dict]:
    """返回 (payloads: arcname→对象, counts: 表→行数)。"""
    counts: dict[str, int] = {}
    payloads: dict[str, object] = {}

    credit_transactions = _rows(
        conn,
        "credit_transactions",
        "SELECT * FROM credit_transactions WHERE user_id = ? ORDER BY created_at ASC",
        (user_id,),
    )
    payloads["data/billing.json"] = {
        "creditTransactions": credit_transactions,
        # M3 的新账本表尚未落地；存在时按同一用户导出，不存在时为空数组。
        "accountLedger": _rows(
            conn,
            "account_ledger",
            "SELECT * FROM account_ledger WHERE user_id = ? ORDER BY created_at_ms ASC",
            (user_id,),
        ),
        "creditHolds": _rows(
            conn,
            "credit_holds",
            "SELECT * FROM credit_holds WHERE user_id = ?",
            (user_id,),
        ),
    }
    counts["credit_transactions"] = len(credit_transactions)

    usage_rows = _rows(
        conn,
        "ai_usage",
        "SELECT * FROM ai_usage WHERE user_id = ? ORDER BY occurred_at ASC",
        (user_id,),
    )
    quota_rows = _rows(
        conn,
        "ai_quota",
        "SELECT * FROM ai_quota WHERE user_id = ? ORDER BY day ASC, feature ASC",
        (user_id,),
    )
    aggregate: dict[str, dict] = {}
    for row in usage_rows:
        key = f"{row.get('usage_date')}|{row.get('feature')}|{row.get('model_id')}"
        item = aggregate.setdefault(
            key,
            {
                "usageDate": row.get("usage_date"),
                "feature": row.get("feature"),
                "modelId": row.get("model_id"),
                "calls": 0,
                "inputTokens": 0,
                "outputTokens": 0,
                "estCostUsd": 0.0,
            },
        )
        item["calls"] += int(row.get("calls") or 0)
        item["inputTokens"] += int(row.get("input_tokens") or 0)
        item["outputTokens"] += int(row.get("output_tokens") or 0)
        item["estCostUsd"] = round(
            float(item["estCostUsd"]) + float(row.get("est_cost_usd") or 0.0), 6
        )
    payloads["data/ai-usage.json"] = {
        "usage": usage_rows,
        "quota": quota_rows,
        "summary": sorted(aggregate.values(), key=lambda item: item["usageDate"] or ""),
        "note": "明细不含 prompt（当前未存）；est_cost_usd 是估算值，不是账单。",
    }
    counts["ai_usage"] = len(usage_rows)
    counts["ai_quota"] = len(quota_rows)

    word_states = _rows(
        conn,
        "word_states",
        "SELECT * FROM word_states WHERE user_id = ? ORDER BY created_at ASC",
        (user_id,),
    )
    review_logs = _rows(
        conn,
        "review_logs",
        "SELECT * FROM review_logs WHERE user_id = ? ORDER BY reviewed_at ASC",
        (user_id,),
    )
    word_sources = _rows(
        conn,
        "word_sources",
        "SELECT ws.* FROM word_sources ws "
        "JOIN word_states s ON s.id = ws.word_state_id "
        "WHERE s.user_id = ? ORDER BY ws.created_at ASC",
        (user_id,),
    )
    payloads["data/review.json"] = {
        "wordStates": word_states,
        "reviewLogs": review_logs,
        "wordSources": word_sources,
    }
    counts["word_states"] = len(word_states)
    counts["review_logs"] = len(review_logs)
    counts["word_sources"] = len(word_sources)

    activity = {
        "watchEvents": _rows(
            conn,
            "watch_events",
            "SELECT * FROM watch_events WHERE user_id = ? ORDER BY occurred_at ASC",
            (user_id,),
        ),
        "weeklyReports": _rows(
            conn,
            "weekly_reports",
            "SELECT * FROM weekly_reports WHERE user_id = ? ORDER BY week_start ASC",
            (user_id,),
        ),
    }
    payloads["data/activity.json"] = activity
    counts["watch_events"] = len(activity["watchEvents"])
    counts["weekly_reports"] = len(activity["weeklyReports"])

    content_items = _rows(
        conn,
        "content_items",
        "SELECT * FROM content_items WHERE user_id = ? ORDER BY created_at ASC",
        (user_id,),
    )
    questions = _rows(
        conn,
        "questions",
        "SELECT q.* FROM questions q "
        "JOIN content_items c ON c.id = q.content_item_id "
        "WHERE c.user_id = ? ORDER BY q.content_item_id ASC, q.ordinal ASC",
        (user_id,),
    )
    attempts = _rows(
        conn,
        "attempts",
        "SELECT * FROM attempts WHERE user_id = ? ORDER BY answered_at ASC",
        (user_id,),
    )
    exam_sessions = _rows(
        conn,
        "exam_sessions",
        "SELECT * FROM exam_sessions WHERE user_id = ? ORDER BY started_at ASC",
        (user_id,),
    )
    exam_answers = _rows(
        conn,
        "exam_answers",
        "SELECT a.* FROM exam_answers a "
        "JOIN exam_sessions s ON s.id = a.session_id "
        "WHERE s.user_id = ? ORDER BY a.answered_at ASC",
        (user_id,),
    )
    payloads["data/practice.json"] = {
        "contentItems": content_items,
        "questions": questions,
        "attempts": attempts,
        "examSessions": exam_sessions,
        "examAnswers": exam_answers,
    }
    for key, rows in (
        ("content_items", content_items),
        ("questions", questions),
        ("attempts", attempts),
        ("exam_sessions", exam_sessions),
        ("exam_answers", exam_answers),
    ):
        counts[key] = len(rows)

    placement_sessions = _rows(
        conn,
        "placement_sessions",
        "SELECT * FROM placement_sessions WHERE user_id = ? ORDER BY started_at ASC",
        (user_id,),
    )
    placement_answers = _rows(
        conn,
        "placement_answers",
        "SELECT a.* FROM placement_answers a "
        "JOIN placement_sessions s ON s.id = a.session_id "
        "WHERE s.user_id = ? ORDER BY a.answered_at ASC",
        (user_id,),
    )
    assessment_sessions = _rows(
        conn,
        "assessment_sessions",
        "SELECT * FROM assessment_sessions WHERE user_id = ? ORDER BY started_at ASC",
        (user_id,),
    )
    user_profiles = _rows(
        conn,
        "user_profiles",
        "SELECT * FROM user_profiles WHERE user_id = ?",
        (user_id,),
    )
    skill_evidence = _rows(
        conn,
        "skill_evidence",
        "SELECT * FROM skill_evidence WHERE user_id = ? ORDER BY observed_at ASC",
        (user_id,),
    )
    user_skill_profiles = _rows(
        conn,
        "user_skill_profiles",
        "SELECT * FROM user_skill_profiles WHERE user_id = ?",
        (user_id,),
    )
    payloads["data/assessment.json"] = {
        "placementSessions": placement_sessions,
        "placementAnswers": placement_answers,
        "assessmentSessions": assessment_sessions,
        "userProfiles": user_profiles,
        "skillEvidence": skill_evidence,
        "userSkillProfiles": user_skill_profiles,
    }
    for key, rows in (
        ("placement_sessions", placement_sessions),
        ("placement_answers", placement_answers),
        ("assessment_sessions", assessment_sessions),
        ("user_profiles", user_profiles),
        ("skill_evidence", skill_evidence),
        ("user_skill_profiles", user_skill_profiles),
    ):
        counts[key] = len(rows)

    articles = _rows(
        conn,
        "articles",
        "SELECT * FROM articles WHERE user_id = ? ORDER BY created_at ASC",
        (user_id,),
    )
    article_paragraphs = _rows(
        conn,
        "article_paragraphs",
        "SELECT p.* FROM article_paragraphs p "
        "JOIN articles a ON a.id = p.article_id "
        "WHERE a.user_id = ? ORDER BY p.article_id ASC, p.idx ASC",
        (user_id,),
    )
    article_translations = _rows(
        conn,
        "article_translations",
        "SELECT t.* FROM article_translations t "
        "JOIN articles a ON a.id = t.article_id "
        "WHERE a.user_id = ? ORDER BY t.article_id ASC, t.idx ASC, t.target_lang ASC",
        (user_id,),
    )
    article_progress = _rows(
        conn,
        "article_progress",
        "SELECT * FROM article_progress WHERE user_id = ?",
        (user_id,),
    )
    payloads["data/reading.json"] = {
        "articles": articles,
        "articleParagraphs": article_paragraphs,
        "articleTranslations": article_translations,
        "articleProgress": article_progress,
    }
    for key, rows in (
        ("articles", articles),
        ("article_paragraphs", article_paragraphs),
        ("article_translations", article_translations),
        ("article_progress", article_progress),
    ):
        counts[key] = len(rows)

    imported_books = _rows(
        conn,
        "imported_books",
        "SELECT * FROM imported_books WHERE user_id = ? ORDER BY created_at ASC",
        (user_id,),
    )
    imported_book_translations = _rows(
        conn,
        "imported_book_translations",
        "SELECT t.* FROM imported_book_translations t "
        "JOIN imported_books b ON b.id = t.book_id "
        "WHERE b.user_id = ? ORDER BY t.book_id ASC, t.chapter_index ASC",
        (user_id,),
    )
    payloads["data/books.json"] = {
        "importedBooks": imported_books,
        "importedBookTranslations": imported_book_translations,
        "note": (
            "本地 EPUB 上传只保留解析后的章节/封面（原 EPUB 文件未持久化）；"
            "章节与封面在 files/books/<bookId>/ 下。"
        ),
    }
    counts["imported_books"] = len(imported_books)
    counts["imported_book_translations"] = len(imported_book_translations)

    course_attempts = _rows(
        conn,
        "course_attempts",
        "SELECT * FROM course_attempts WHERE user_id = ? ORDER BY started_at ASC",
        (user_id,),
    )
    course_events = _rows(
        conn,
        "course_events",
        "SELECT * FROM course_events WHERE user_id = ? ORDER BY created_at ASC",
        (user_id,),
    )
    generated_courses = _rows(
        conn,
        "generated_courses",
        "SELECT * FROM generated_courses WHERE owner_user_id = ? ORDER BY created_at ASC",
        (user_id,),
    )
    payloads["data/courses.json"] = {
        "courseAttempts": course_attempts,
        "courseEvents": course_events,
        "generatedCourses": generated_courses,
    }
    counts["course_attempts"] = len(course_attempts)
    counts["course_events"] = len(course_events)
    counts["generated_courses"] = len(generated_courses)
    return payloads, counts


def _generate_zip(job_id: str) -> dict:
    conn = _connect()
    try:
        _require(conn)
        job = conn.execute(
            "SELECT id, user_id, status FROM data_export_jobs WHERE id = ?",
            (job_id,),
        ).fetchone()
    finally:
        conn.close()
    if job is None:
        raise ExportNotFound("导出任务不存在。")
    user_id = job["user_id"]

    read_conn = _open_readonly_db()
    tmp_path: str | None = None
    try:
        profile = _load_profile(read_conn, user_id)
        payloads, counts = _build_payloads(read_conn, user_id)
    finally:
        read_conn.close()

    root = os.path.realpath(config.EXPORTS_DIR)
    user_dir = os.path.realpath(os.path.join(root, user_id))
    if user_dir == root or not user_dir.startswith(root + os.sep):
        raise RuntimeError("导出目录越界")
    if not os.path.isdir(root):
        os.makedirs(root, mode=0o700, exist_ok=True)
    os.makedirs(user_dir, mode=0o700, exist_ok=True)
    try:
        os.chmod(user_dir, 0o700)
    except OSError:
        pass

    final_path = os.path.join(user_dir, f"{job_id}.zip")
    tmp_path = os.path.join(user_dir, f".{job_id}.tmp-{uuid.uuid4().hex[:8]}")
    relative_path = f"{user_id}/{job_id}.zip"
    max_bytes = int(config.EXPORT_MAX_BYTES or 0)
    generated_at = now_ms()

    try:
        with zipfile.ZipFile(
            tmp_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
        ) as archive:
            writer = _ZipWriter(archive, max_bytes)
            writer.add_json("data/profile.json", profile)
            for name, payload in payloads.items():
                writer.add_json(name, payload)
            file_count = _add_learning_files(writer, user_id)
            file_count += _add_book_files(writer, user_id)
            counts["files"] = file_count

            readme = _readme_text(user_id, job_id, generated_at)
            writer.add_bytes(README_NAME, readme.encode("utf-8"))

            manifest = {
                "formatVersion": FORMAT_VERSION,
                "jobId": job_id,
                "generatedAt": _iso_utc(),
                "generatedAtMs": generated_at,
                "userIdHash": lifecycle.hash_user_id(user_id),
                "scope": counts,
                "excluded": _MANIFEST_EXCLUDED,
                "notice": (
                    "导出不改变账号状态；删除账号后历史备份最长可能有 30 天残留。"
                ),
                "files": writer.entries,
                "manifestIncludesItself": False,
            }
            manifest_bytes = _json_bytes(manifest)
            # manifest 是最后一个条目，自身不列入 files（避免自引用哈希）。
            archive.writestr(_safe_arcname(MANIFEST_NAME), manifest_bytes)

        size = os.path.getsize(tmp_path)
        if size > max_bytes:
            raise RuntimeError(f"导出 ZIP 超过 {max_bytes} 字节上限")
        try:
            os.chmod(tmp_path, 0o600)
        except OSError:
            pass
        os.replace(tmp_path, final_path)
        tmp_path = None
        return {
            "filePath": relative_path,
            "sizeBytes": size,
            "counts": counts,
        }
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                logger.warning("删除导出临时文件失败：%s", tmp_path)


def _readme_text(user_id: str, job_id: str, generated_at: int) -> str:
    generated = datetime.fromtimestamp(generated_at / 1000, timezone.utc).isoformat(
        timespec="seconds"
    ).replace("+00:00", "Z")
    return f"""# LinguaTrek 数据导出

- 导出任务：`{job_id}`
- 生成时间（UTC）：{generated}
- 用户 id 摘要（sha256，不暴露明文 id）：`{lifecycle.hash_user_id(user_id)}`
- 格式版本：`{FORMAT_VERSION}`
- 数据范围 / 各表行数：见 `manifest.json` 的 `scope`

## 目录

| 路径 | 内容 |
|---|---|
| `data/profile.json` | 账号资料、状态、旧单位余额（`creditsLegacy`） |
| `data/billing.json` | 旧 `credit_transactions` 只读快照；新账本表存在时一并导出 |
| `data/ai-usage.json` | AI 用量明细 + 按天/功能/模型汇总 + 日配额（不含 prompt） |
| `data/learning/` | 学习缓存（history）、收藏、订阅、收藏墓碑（原样 JSON） |
| `data/review.json` | 复习词状态、复习日志、词来源 |
| `data/activity.json` | 观看事件、周报快照 |
| `data/practice.json` | 理解题、作答、考试会话与答案 |
| `data/assessment.json` | 定位测、能力会话、画像、证据、分技能画像 |
| `data/reading.json` | 用户文章、段落、逐段译文、阅读进度 |
| `data/books.json` | 导入书元数据、按章译文 |
| `files/books/` | 本地 EPUB 上传后保留的章节/封面文件（原 EPUB 未持久化） |
| `data/courses.json` | 课程 attempt、事件、用户生成的课程 |
| `manifest.json` | 文件清单（每个文件的 SHA256 / 字节数）、范围、排除项 |

## 时间与单位

- 数据库里以 `_at_ms` / `At` 结尾的时间是毫秒 UTC；`users.created_at` /
  `credit_transactions.created_at` 是秒（导出已同时给 `createdAtMs`）。
- `users.credits` 是 M3 前的旧单位，没有定义美元汇率；`creditsLegacy`
  不能当作余额或金额使用。
- `est_cost_usd` 是估算值，不是厂商账单。

## 明确不包含

- 密码哈希、会话 / Cookie / 下载 token；
- 其它用户的数据；
- 公共缓存与词典（内容难度、教学分析、公共题库、内置书译文、`data/subtitles`、
  `data/ecdict.db`）；
- 备份文件（`backups/` 与离机副本）；
- 内部日志、管理员审计、模型 prompt（当前未存）；
- 游客目录 `data/guests/<hash>`（无可靠 user→guest 映射，未擅自删除/导出）。

## 不改变账号

导出不会删除或停用账号。删除账号需在账号页单独提交；提交后有 7 天冷静期，
到期硬删除后不可恢复；历史备份最长可能有 **30 天**残留，备份到期才会自然消失。
"""


# ---------------------------------------------------------------------------
# 列表 / 下载 / 删除 / 清理
# ---------------------------------------------------------------------------

def list_exports(user_id: str, limit: int = 20) -> dict:
    cleanup_exports()
    limit = max(1, min(int(limit), 50))
    conn = _connect()
    try:
        _require(conn)
        rows = conn.execute(
            "SELECT id, status, requested_at_ms, completed_at_ms, expires_at_ms, "
            "size_bytes, downloaded_at_ms, error, file_path FROM data_export_jobs "
            "WHERE user_id = ? ORDER BY requested_at_ms DESC, id DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
    finally:
        conn.close()
    return {
        "jobs": [_job_public(row) for row in rows],
        "limits": export_limits(),
    }


def _load_job(user_id: str, job_id: str) -> sqlite3.Row | None:
    conn = _connect()
    try:
        _require(conn)
        return conn.execute(
            "SELECT id, user_id, status, requested_at_ms, completed_at_ms, "
            "expires_at_ms, file_path, size_bytes, download_token_hash, "
            "downloaded_at_ms, error FROM data_export_jobs "
            "WHERE id = ? AND user_id = ?",
            (job_id, user_id),
        ).fetchone()
    finally:
        conn.close()


def _remove_file(relative_path: object) -> bool:
    try:
        path = lifecycle.safe_export_path(relative_path)
    except ValueError:
        return False
    try:
        if os.path.isfile(path) or os.path.islink(path):
            os.remove(path)
            return True
    except OSError:
        logger.warning("删除导出文件失败：%s", path, exc_info=True)
    return False


def _expire_job(job_id: str, file_path: object) -> None:
    _remove_file(file_path)
    conn = _connect()
    try:
        conn.execute(
            "UPDATE data_export_jobs SET status = ?, expires_at_ms = ?, "
            "file_path = NULL WHERE id = ? AND status IN (?, ?, ?)",
            (STATUS_EXPIRED, now_ms(), job_id, STATUS_READY, STATUS_QUEUED, STATUS_RUNNING),
        )
        conn.commit()
    except sqlite3.Error:
        logger.warning("标记导出过期失败：%s", job_id, exc_info=True)
    finally:
        conn.close()


def get_export_for_download(user_id: str, job_id: str, token: object) -> dict:
    """校验归属/状态/token；返回可流式下载的绝对路径。"""
    cleanup_exports()
    row = _load_job(user_id, job_id)
    if row is None:
        raise ExportNotFound("导出任务不存在。")
    now = now_ms()
    if row["status"] == STATUS_EXPIRED or (
        row["expires_at_ms"] is not None and int(row["expires_at_ms"]) <= now
    ):
        _expire_job(job_id, row["file_path"])
        raise ExportExpired("导出文件已过期。")
    if row["status"] == STATUS_FAILED:
        raise ExportFailed("导出生成失败，请重新发起导出或联系支持。")
    if row["status"] in ACTIVE_STATUSES:
        raise ExportNotReady("导出仍在生成中，请稍后重试。")
    if row["status"] != STATUS_READY:
        raise ExportNotReady("导出尚不可下载。")
    if not isinstance(token, str) or not token:
        raise ExportTokenInvalid("缺少或错误的下载 token。")
    stored = row["download_token_hash"] or ""
    if not stored or not hmac.compare_digest(
        stored, hash_download_token(token)
    ):
        raise ExportTokenInvalid("缺少或错误的下载 token。")
    if not row["file_path"]:
        raise ExportExpired("导出文件已过期。")
    try:
        path = lifecycle.safe_export_path(row["file_path"])
    except ValueError as exc:
        raise ExportExpired("导出文件路径不可用。") from exc
    if not os.path.isfile(path) or os.path.islink(path):
        _expire_job(job_id, row["file_path"])
        raise ExportExpired("导出文件已过期。")
    return {
        "job": _job_public(row),
        "path": path,
        "filename": f"linguatrek-export-{job_id}.zip",
    }


def mark_downloaded(job_id: str) -> None:
    conn = _connect()
    try:
        conn.execute(
            "UPDATE data_export_jobs SET downloaded_at_ms = ? "
            "WHERE id = ? AND downloaded_at_ms IS NULL",
            (now_ms(), job_id),
        )
        conn.commit()
    finally:
        conn.close()


def delete_export(user_id: str, job_id: str) -> dict:
    """删除临时 ZIP（幂等）；任务行保留为 ``expired`` 供列表/审计。"""
    row = _load_job(user_id, job_id)
    if row is None:
        raise ExportNotFound("导出任务不存在。")
    if row["status"] in ACTIVE_STATUSES:
        raise ExportBusy("导出任务正在生成，暂时不能删除。")
    _remove_file(row["file_path"])
    conn = _connect()
    try:
        conn.execute(
            "UPDATE data_export_jobs SET status = ?, expires_at_ms = ?, "
            "file_path = NULL WHERE id = ? AND user_id = ?",
            (STATUS_EXPIRED, now_ms(), job_id, user_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "jobId": job_id, "status": STATUS_EXPIRED}


def cleanup_exports(now: int | None = None) -> dict:
    """清理过期/僵尸任务：24h 到期 ready → expired；>2h queued/running → failed。"""
    moment = now_ms() if now is None else int(now)
    stale_before = moment - STALE_JOB_MS
    result = {"expired": 0, "staleFailed": 0, "filesDeleted": 0}
    try:
        conn = _connect()
    except sqlite3.Error:
        return result
    try:
        if not _table_exists(conn, "data_export_jobs"):
            return result
        rows = conn.execute(
            "SELECT id, status, file_path, expires_at_ms, requested_at_ms "
            "FROM data_export_jobs "
            "WHERE (status = ? AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?) "
            "OR (status IN (?, ?) AND requested_at_ms <= ?)",
            (STATUS_READY, moment, STATUS_QUEUED, STATUS_RUNNING, stale_before),
        ).fetchall()
    except sqlite3.Error:
        logger.warning("扫描导出清理任务失败", exc_info=True)
        return result
    finally:
        conn.close()

    for row in rows:
        if _remove_file(row["file_path"]):
            result["filesDeleted"] += 1
        try:
            conn = _connect()
            try:
                if row["status"] == STATUS_READY:
                    conn.execute(
                        "UPDATE data_export_jobs SET status = ?, file_path = NULL "
                        "WHERE id = ? AND status = ?",
                        (STATUS_EXPIRED, row["id"], STATUS_READY),
                    )
                    result["expired"] += 1
                else:
                    conn.execute(
                        "UPDATE data_export_jobs SET status = ?, "
                        "completed_at_ms = ?, file_path = NULL, "
                        "error = 'stale_job: 生成线程未完成，已标记失败' "
                        "WHERE id = ? AND status IN (?, ?)",
                        (
                            STATUS_FAILED,
                            moment,
                            row["id"],
                            STATUS_QUEUED,
                            STATUS_RUNNING,
                        ),
                    )
                    result["staleFailed"] += 1
                conn.commit()
            finally:
                conn.close()
        except sqlite3.Error:
            logger.warning("更新导出清理状态失败：%s", row["id"], exc_info=True)
    return result
