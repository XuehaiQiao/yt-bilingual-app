"""余额与 AI 计费（M3a，specs/034-balance-billing）。

**金额单位（全模块唯一口径）**：整数微美元（µUSD）。

    1 USD = 1,000,000 µUSD = $0.000001

金额列一律 SQLite INTEGER；美元只出现在 API 入参/出参的字符串里（最多 6 位
小数，``"2.00"`` → 2,000,000）。禁止把美元浮点写进金额列、禁止用 REAL 存余额、
禁止拿旧 ``users.credits`` 或 ``ai_usage.est_cost_usd`` 当扣费依据。

职责分三层：

1. **余额与流水**（``get_balance`` / ``admin_adjust`` / ``ledger_entries``）：
   账本 ``account_ledger`` 只追加；任何余额变动都有一行，``SUM(delta)`` 应等于
   ``users.balance_micro_usd``。管理员充/扣用 ``BEGIN IMMEDIATE`` + 幂等键。
2. **预占/结算/释放**（``reserve`` / ``settle`` / ``release`` / ``expire_stale_holds``）：
   调用模型前预占（``credit_holds``），调用后按真实 token 用量结算并写
   ``ai_usage`` + 流水；失败/超时释放。``available = 余额 − active holds``。
   结算与用量写入在**同一个事务**里（要么都落库，要么都回滚保留 hold）。
3. **价格与预占估算**（``price_for_model`` / ``estimate_reserve``）：
   价格优先读 ``model_prices``（按 ``effective_from_ms`` 取最新，历史版本不覆盖），
   缺行时用 ``config.MODEL_CATALOG`` 的 in/out 兜底并标 ``catalog_unverified``；
   两个来源都没有 → ``billable=0``，**不扣余额**、绝不按「已知最贵」静默扣费。

错误语义（与 ``main.py`` 的异常处理器配合）：

- :class:`InsufficientBalance` → HTTP 402 ``{code: insufficient_balance,
  balanceMicroUsd, requiredMicroUsd}``；
- :class:`BillingUnavailable` → HTTP 503（数据库未迁移到 0025）；
- 日配额/日预算/限流仍是 429（见 ``ai/quota.py``），与余额独立。

兼容策略：迁移 ``0025_balance_cost`` 是 schema 真源；``ensure_schema_compat()``
只为「未跑迁移的旧部署/测试库」保留开户事务可用（与 ``auth_db.py`` 连库建表
同一口径）。计费本身只在 **0025 已生效**（``schema_ready()`` 为真）时启用；
未迁移时 AI 调用照旧只记 ``ai_usage``，不会假装扣费。
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import sqlite3
import threading
import time
import uuid
from decimal import Decimal, InvalidOperation

import alerts
import auth_db
import config
import languages
from ai import ledger

logger = logging.getLogger("linguatrek.billing")

MICRO_USD_PER_USD = 1_000_000
MAX_REASON_LENGTH = 200
MAX_IDEMPOTENCY_LENGTH = 120
DEFAULT_LIST_LIMIT = 50
MAX_LIST_LIMIT = 200

LEDGER_KINDS = (
    "signup_bonus",
    "signup_bonus_backfill",
    "admin_topup",
    "admin_deduct",
    "ai_settle",
    "ai_refund",
    "adjustment",
    "legacy_snapshot",
)

HOLD_ACTIVE = "active"
HOLD_SETTLED = "settled"
HOLD_RELEASED = "released"
HOLD_EXPIRED = "expired"

# 003x 价格来源 → ai_usage.price_source 的稳定取值（见项目提案 §5.6）。
SOURCE_KIND_TO_PRICE_SOURCE = {
    "official_page": "official",
    "vendor_bill": "vendor_bill",
    "manual": "manual",
}

_AMOUNT_RE = re.compile(r"^\d+(?:\.\d{1,6})?$")
_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9._:\-]{1,120}$")

_DETAIL_LIMIT = 200


# ---------------------------------------------------------------------------
# 异常
# ---------------------------------------------------------------------------

class BillingError(Exception):
    """计费域异常基类；``status_code`` 供路由/异常处理器统一映射。"""

    status_code = 500
    code = "billing_error"


class InsufficientBalance(BillingError):
    """可用余额不足（HTTP 402）。"""

    status_code = 402
    code = "insufficient_balance"

    def __init__(
        self,
        *,
        balance_micro_usd: int,
        required_micro_usd: int,
        available_micro_usd: int | None = None,
        user_id: str | None = None,
        feature: str | None = None,
    ) -> None:
        available = (
            int(balance_micro_usd)
            if available_micro_usd is None
            else int(available_micro_usd)
        )
        self.balance_micro_usd = int(balance_micro_usd)
        self.available_micro_usd = available
        self.required_micro_usd = int(required_micro_usd)
        self.user_id = user_id
        self.feature = feature
        # 币种明确：余额单位是微美元，不是美元。
        super().__init__(
            "余额不足，请联系管理员充值。"
            f"（可用 {format_usd(available)} USD，本次需要 "
            f"{format_usd(self.required_micro_usd)} USD）"
        )

    def payload(self) -> dict:
        return {
            "detail": str(self),
            "code": self.code,
            "balanceMicroUsd": self.balance_micro_usd,
            "availableMicroUsd": self.available_micro_usd,
            "requiredMicroUsd": self.required_micro_usd,
            "topup": "admin",
        }


class BillingUnavailable(BillingError):
    """余额/价格表缺失（数据库未跑 0025 迁移）；路由转 503。"""

    status_code = 503
    code = "billing_unavailable"


class LoginRequired(BillingError):
    """AI 调用没有登录用户（游客/匿名）：M7a 起一律拒绝，路由转 403。

    用 403 而不是 401：前端全局把 401 当成「会话过期」直接登出；游客本来
    就没有会话，正确的交互是弹登录框，而不是把已经登录的异常态误判为掉线。
    """

    status_code = 403
    code = "login_required"

    def __init__(self, detail: str | None = None) -> None:
        super().__init__(
            detail
            or "AI 功能需要登录后使用；游客可以继续阅读已缓存的公开内容。"
        )

    def payload(self) -> dict:
        return {"detail": str(self), "code": self.code}


class ModelUnpriced(BillingError):
    """模型没有可核实单价：严格计费下禁止调用（HTTP 503）。"""

    status_code = 503
    code = "model_unpriced"

    def __init__(self, model_id: str | None = None) -> None:
        self.model_id = model_id
        super().__init__(
            f"模型 {model_id or 'unknown'} 没有可核实单价，已暂停使用；"
            "请联系管理员补价（model_prices）后再试。"
        )

    def payload(self) -> dict:
        return {
            "detail": str(self),
            "code": self.code,
            "modelId": self.model_id,
        }


class BillingConflict(BillingError):
    """幂等键冲突或 hold 状态不允许该操作（HTTP 409）。"""

    status_code = 409
    code = "billing_conflict"


class InvalidBillingRequest(ValueError):
    """金额/原因/幂等键不合法（HTTP 400）。"""


class BalanceNotFound(BillingError):
    """目标用户不存在（HTTP 404）。"""

    status_code = 404
    code = "user_not_found"


class InsufficientFunds(InvalidBillingRequest):
    """管理员扣减后余额为负（HTTP 400）。"""

    def __init__(self, current: int, delta: int) -> None:
        super().__init__(
            f"扣减后余额会变成负数（当前 {format_usd(current)} USD，"
            f"本次 -{format_usd(abs(delta))} USD）。"
        )
        self.current = current
        self.delta = delta


class HoldNotActive(BillingConflict):
    """hold 已结算/已释放/已过期，不能再次结算（HTTP 409）。"""


class HoldNotFound(BillingError):
    """hold 不存在（HTTP 404）。"""

    status_code = 404
    code = "hold_not_found"


# ---------------------------------------------------------------------------
# 金额解析 / 展示
# ---------------------------------------------------------------------------

def format_usd(micro_usd: int) -> str:
    """整数 µUSD → 美元字符串（保留 2–6 位小数，无科学计数法）。

    例：2_000_000 → ``"2.00"``；3_720 → ``"0.00372"``；-500_000 → ``"-0.50"``。
    """
    value = int(micro_usd)
    sign = "-" if value < 0 else ""
    whole, frac = divmod(abs(value), MICRO_USD_PER_USD)
    frac_text = f"{frac:06d}".rstrip("0")
    if len(frac_text) < 2:
        frac_text = frac_text.ljust(2, "0")
    return f"{sign}{whole}.{frac_text}"


def parse_usd_amount(value: object, *, max_abs_micro_usd: int | None = None) -> int:
    """美元字符串 → 整数 µUSD（精确十进制，最多 6 位小数）。

    只接受字符串（JSON 浮点会丢精度，明确拒绝）；不接受负号——管理台用
    ``direction`` 区分充/扣。越界抛 :class:`InvalidBillingRequest`。
    """
    if not isinstance(value, str):
        raise InvalidBillingRequest("金额必须是字符串，例如 \"2.00\"。")
    text = value.strip()
    if not text or not _AMOUNT_RE.match(text):
        raise InvalidBillingRequest("金额格式不正确（最多 6 位小数的正数，如 \"2.00\"）。")
    try:
        amount = Decimal(text) * Decimal(MICRO_USD_PER_USD)
    except InvalidOperation as exc:  # pragma: no cover - 正则已挡住
        raise InvalidBillingRequest("金额格式不正确。") from exc
    micro = int(amount)
    if micro <= 0:
        raise InvalidBillingRequest("金额必须大于 0。")
    if amount != micro:
        raise InvalidBillingRequest("金额精度最多 6 位小数。")
    if max_abs_micro_usd is not None and micro > int(max_abs_micro_usd):
        raise InvalidBillingRequest(
            f"单次金额不能超过 ${format_usd(int(max_abs_micro_usd))}。"
        )
    return micro


def validate_reason(reason: object) -> str:
    """原因必填（1–200 字）；返回去首尾空白后的文本。"""
    if not isinstance(reason, str):
        raise InvalidBillingRequest("调整原因必须是字符串。")
    text = reason.strip()
    if not 1 <= len(text) <= MAX_REASON_LENGTH:
        raise InvalidBillingRequest(
            f"调整原因需要 1–{MAX_REASON_LENGTH} 个字符。"
        )
    return text


def validate_idempotency_key(key: object) -> str | None:
    """幂等键可选；传入则只接受安全字符、1–120 位。"""
    if key is None:
        return None
    if not isinstance(key, str):
        raise InvalidBillingRequest("幂等键必须是字符串。")
    text = key.strip()
    if not text:
        return None
    if not _IDEMPOTENCY_RE.match(text) or len(text) > MAX_IDEMPOTENCY_LENGTH:
        raise InvalidBillingRequest("幂等键只能包含字母、数字与 . _ : -（≤120 位）。")
    return text


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------------------
# 连接 / schema
# ---------------------------------------------------------------------------

def _connect() -> sqlite3.Connection:
    """用 auth_db 的连接器：旧库会顺手补上 0013/0025 的 users 列。"""
    return auth_db.connect()


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    try:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return set()


_READY_CACHE: dict[str, tuple[bool, float]] = {}
_READY_TTL_SECONDS = 2.0


def reset_cache() -> None:
    """清空 schema 探测缓存（测试/迁移后调用）。"""
    _READY_CACHE.clear()


def schema_ready() -> bool:
    """0025 是否已生效：三张新表 + ai_usage 计费列都在才启用计费。

    未迁移时 ``False``：AI 调用保持旧行为（只记 ``ai_usage`` 的估算成本），
    **不会**假装扣费。结果缓存 2 秒（负结果也缓存），迁移完成后 2 秒内生效。
    """
    path = config.AUTH_DB_PATH
    if not path or not os.path.exists(path):
        return False
    cached = _READY_CACHE.get(path)
    if cached is not None and time.monotonic() - cached[1] < _READY_TTL_SECONDS:
        return cached[0]
    ready = False
    try:
        conn = _connect()
        try:
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name IN "
                    "('account_ledger','credit_holds','model_prices','ai_usage')"
                )
            }
            ready = len(tables) == 4
            if ready:
                ready = "balance_micro_usd" in _columns(conn, "users")
            if ready:
                ready = "cost_micro_usd" in _columns(conn, "ai_usage")
        finally:
            conn.close()
    except sqlite3.Error as exc:
        logger.debug("billing schema 探测失败（按未启用处理）：%s", exc)
        ready = False
    _READY_CACHE[path] = (ready, time.monotonic())
    return ready


# 未跑 0025 的旧库/测试库：开户事务需要 account_ledger。DDL 与迁移 0025 保持
# 一致（tests/test_balance_billing.py 有 schema 签名对比断言）；生产仍必须先跑
# `alembic upgrade head`，这里只是「连库即可开户」的兼容路径。
_COMPAT_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS account_ledger (
    id TEXT NOT NULL PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    delta_micro_usd INTEGER NOT NULL,
    balance_after_micro_usd INTEGER NOT NULL,
    ref_type TEXT,
    ref_id TEXT,
    reason TEXT,
    actor_id TEXT,
    idempotency_key TEXT,
    created_at_ms INTEGER NOT NULL,
    CONSTRAINT ck_account_ledger_kind CHECK (kind IN (
        'signup_bonus','signup_bonus_backfill','admin_topup','admin_deduct',
        'ai_settle','ai_refund','adjustment','legacy_snapshot')),
    CONSTRAINT ck_account_ledger_delta_nonzero CHECK (delta_micro_usd <> 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_account_ledger_idempotency
    ON account_ledger(idempotency_key);
CREATE INDEX IF NOT EXISTS ix_account_ledger_user_created
    ON account_ledger(user_id, created_at_ms);
CREATE INDEX IF NOT EXISTS ix_account_ledger_kind_created
    ON account_ledger(kind, created_at_ms);
CREATE INDEX IF NOT EXISTS ix_account_ledger_ref
    ON account_ledger(ref_type, ref_id);

CREATE TABLE IF NOT EXISTS credit_holds (
    id TEXT NOT NULL PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount_micro_usd INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    settled_at_ms INTEGER,
    ai_request_id TEXT,
    CONSTRAINT ck_credit_holds_amount_positive CHECK (amount_micro_usd > 0),
    CONSTRAINT ck_credit_holds_status CHECK (status IN (
        'active','settled','released','expired'))
);
CREATE INDEX IF NOT EXISTS ix_credit_holds_user_status
    ON credit_holds(user_id, status);
CREATE INDEX IF NOT EXISTS ix_credit_holds_status_expires
    ON credit_holds(status, expires_at_ms);

CREATE TABLE IF NOT EXISTS model_prices (
    id TEXT NOT NULL PRIMARY KEY,
    model_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    effective_from_ms INTEGER NOT NULL,
    input_micro_usd_per_mtok INTEGER NOT NULL,
    output_micro_usd_per_mtok INTEGER NOT NULL,
    source_kind TEXT NOT NULL,
    source_ref TEXT,
    verified_at_ms INTEGER NOT NULL,
    price_version TEXT NOT NULL,
    note TEXT,
    CONSTRAINT ck_model_prices_nonnegative CHECK (
        input_micro_usd_per_mtok >= 0 AND output_micro_usd_per_mtok >= 0),
    CONSTRAINT ck_model_prices_source_kind CHECK (source_kind IN (
        'official_page','vendor_bill','manual'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_model_prices_model_effective
    ON model_prices(model_id, effective_from_ms);
CREATE INDEX IF NOT EXISTS ix_model_prices_provider
    ON model_prices(provider, effective_from_ms);

-- M7a：严格计费要求每笔 AI 调用都能结算，所以兼容路径也建出 0003 的账本表
-- （旧库已经有同表时 CREATE IF NOT EXISTS 是 no-op；缺的计费列下面补）。
CREATE TABLE IF NOT EXISTS ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    feature TEXT NOT NULL,
    model_id TEXT NOT NULL,
    provider TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 0,
    est_cost_usd FLOAT NOT NULL DEFAULT 0,
    occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    usage_date TEXT NOT NULL,
    target_lang TEXT DEFAULT 'zh-CN',
    cost_micro_usd INTEGER,
    input_price_micro_usd_per_mtok INTEGER,
    output_price_micro_usd_per_mtok INTEGER,
    price_version TEXT,
    price_source TEXT,
    token_source TEXT,
    billable INTEGER,
    billing_status TEXT,
    hold_id TEXT,
    request_id TEXT
);
CREATE INDEX IF NOT EXISTS ix_ai_usage_user_day ON ai_usage(user_id, usage_date);
CREATE INDEX IF NOT EXISTS ix_ai_usage_feature_day ON ai_usage(feature, usage_date);
CREATE INDEX IF NOT EXISTS ix_ai_usage_day ON ai_usage(usage_date);

CREATE TABLE IF NOT EXISTS ai_quota (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    feature TEXT NOT NULL,
    used_units INTEGER NOT NULL DEFAULT 0,
    limit_units INTEGER NOT NULL,
    PRIMARY KEY (user_id, day, feature)
);
"""

# 未跑 0025 的旧库可能已经有 0003 的 ai_usage（缺 target_lang/计费列）：
# ``CREATE TABLE IF NOT EXISTS`` 不会补列，这里按迁移同口径逐列 ALTER。
_COMPAT_AI_USAGE_COLUMNS = (
    ("target_lang", "TEXT DEFAULT 'zh-CN'"),
    ("cost_micro_usd", "INTEGER"),
    ("input_price_micro_usd_per_mtok", "INTEGER"),
    ("output_price_micro_usd_per_mtok", "INTEGER"),
    ("price_version", "TEXT"),
    ("price_source", "TEXT"),
    ("token_source", "TEXT"),
    ("billable", "INTEGER"),
    ("billing_status", "TEXT"),
    ("hold_id", "TEXT"),
    ("request_id", "TEXT"),
)

# 与迁移 0025 同一批价格快照（保持唯一键 id 一致，迁移库上是 INSERT OR IGNORE
# no-op）。生产仍应先跑 `alembic upgrade head`；这里只是让「未迁移但已注册」
# 的部署/测试不会因为缺价而把所有 AI 调用 503 掉。
_COMPAT_PRICE_SEEDS = (
    (
        "mp-20261120-deepseek-chat",
        "deepseek-chat",
        "DeepSeek",
        300_000,
        1_200_000,
        "https://api-docs.deepseek.com/quick_start/pricing",
        "2026-11-20.official.1",
    ),
    (
        "mp-20261120-gemini-25-flash",
        "gemini-2.5-flash",
        "Google",
        300_000,
        2_500_000,
        "https://ai.google.dev/gemini-api/docs/pricing",
        "2026-11-20.official.1",
    ),
)
_PRICE_EFFECTIVE_FROM_MS = 1_795_132_800_000

_COMPAT_LOCK = threading.Lock()


def ensure_schema_compat() -> bool:
    """保证开户/计费需要的表存在（幂等）。

    只在**注册**路径调用：生产库应已跑迁移；未跑迁移的旧部署/测试库也能
    「建用户 + 发 $2 + 写流水 + 建会话」整笔事务完成，不会出现「用户建了但
    余额表不存在」。M7a 起同时补 ``ai_usage``/``ai_quota`` 与价格 seed：
    严格计费要求「每笔调用都可结算」，不能因为未迁移就退化成免费调用。
    幂等：``CREATE TABLE IF NOT EXISTS`` + 同名索引 + ``INSERT OR IGNORE``。
    """
    with _COMPAT_LOCK:
        conn = _connect()
        try:
            if "balance_micro_usd" not in _columns(conn, "users"):
                conn.execute(
                    "ALTER TABLE users ADD COLUMN balance_micro_usd "
                    "INTEGER NOT NULL DEFAULT 0"
                )
            conn.executescript(_COMPAT_SCHEMA_SQL)
            if _table_exists(conn, "ai_usage"):
                existing = _columns(conn, "ai_usage")
                for name, column_type in _COMPAT_AI_USAGE_COLUMNS:
                    if name not in existing:
                        conn.execute(
                            f"ALTER TABLE ai_usage ADD COLUMN {name} {column_type}"
                        )
            if _table_exists(conn, "model_prices"):
                for seed in _COMPAT_PRICE_SEEDS:
                    conn.execute(
                        "INSERT OR IGNORE INTO model_prices ("
                        "id, model_id, provider, effective_from_ms, "
                        "input_micro_usd_per_mtok, output_micro_usd_per_mtok, "
                        "source_kind, source_ref, verified_at_ms, price_version) "
                        "VALUES (?, ?, ?, ?, ?, ?, 'official_page', ?, ?, ?)",
                        (
                            seed[0],
                            seed[1],
                            seed[2],
                            _PRICE_EFFECTIVE_FROM_MS,
                            seed[3],
                            seed[4],
                            seed[5],
                            _PRICE_EFFECTIVE_FROM_MS,
                            seed[6],
                        ),
                    )
            conn.commit()
        finally:
            conn.close()
    reset_cache()
    return True


def _require_billing_tables(conn: sqlite3.Connection) -> None:
    missing = [
        table
        for table in ("account_ledger", "credit_holds", "model_prices")
        if not _table_exists(conn, table)
    ]
    if missing:
        raise BillingUnavailable(
            "余额/计费表不存在（" + ", ".join(missing) + "）：请先运行 "
            "`alembic upgrade head`（0025_balance_cost）。"
        )


# ---------------------------------------------------------------------------
# 余额 / 可用余额
# ---------------------------------------------------------------------------

def _active_holds_micro_usd(
    conn: sqlite3.Connection, user_id: str, *, now: int
) -> int:
    if not _table_exists(conn, "credit_holds"):
        return 0
    row = conn.execute(
        "SELECT COALESCE(SUM(amount_micro_usd), 0) FROM credit_holds "
        "WHERE user_id = ? AND status = 'active' AND expires_at_ms > ?",
        (user_id, now),
    ).fetchone()
    return max(0, int(row[0] or 0))


def get_balance(user_id: str, *, now_ms_value: int | None = None) -> dict:
    """账面余额 / active holds / 可用余额（全部整数 µUSD，附美元字符串）。

    未跑 0025 的库没有 ``balance_micro_usd`` 列时会先被 ``auth_db`` 兼容补列；
    若连 users 表都没有则抛 :class:`BillingUnavailable`。
    """
    now = now_ms() if now_ms_value is None else int(now_ms_value)
    conn = _connect()
    try:
        try:
            row = conn.execute(
                "SELECT balance_micro_usd FROM users WHERE id = ?", (user_id,)
            ).fetchone()
        except sqlite3.OperationalError as exc:
            raise BillingUnavailable(str(exc)) from exc
        if row is None:
            raise BalanceNotFound(user_id)
        balance = int(row["balance_micro_usd"] or 0)
        held = _active_holds_micro_usd(conn, user_id, now=now)
    finally:
        conn.close()
    available = balance - held
    return {
        "userId": user_id,
        "balanceMicroUsd": balance,
        "activeHoldsMicroUsd": held,
        "availableMicroUsd": available,
        "balanceUsd": format_usd(balance),
        "availableUsd": format_usd(available),
    }


def available_micro_usd(user_id: str, *, now_ms_value: int | None = None) -> int:
    """可用余额（账面 − active holds）。"""
    return int(
        get_balance(user_id, now_ms_value=now_ms_value)["availableMicroUsd"]
    )


# ---------------------------------------------------------------------------
# 流水写入（调用方事务内）
# ---------------------------------------------------------------------------

def _insert_ledger(
    conn: sqlite3.Connection,
    *,
    user_id: str,
    kind: str,
    delta_micro_usd: int,
    balance_after_micro_usd: int,
    created_at_ms: int,
    ref_type: str | None = None,
    ref_id: str | None = None,
    reason: str | None = None,
    actor_id: str | None = None,
    idempotency_key: str | None = None,
    ledger_id: str | None = None,
) -> str:
    if kind not in LEDGER_KINDS:
        raise ValueError(f"未知流水类型：{kind!r}")
    if int(delta_micro_usd) == 0:
        raise ValueError("流水金额不能为 0")
    entry_id = ledger_id or f"bl-{uuid.uuid4().hex}"
    conn.execute(
        "INSERT INTO account_ledger ("
        "id, user_id, kind, delta_micro_usd, balance_after_micro_usd, "
        "ref_type, ref_id, reason, actor_id, idempotency_key, created_at_ms"
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            entry_id,
            user_id,
            kind,
            int(delta_micro_usd),
            int(balance_after_micro_usd),
            ref_type,
            ref_id,
            (reason or "")[:_DETAIL_LIMIT] or None,
            actor_id,
            idempotency_key,
            int(created_at_ms),
        ),
    )
    return entry_id


def signup_balance_micro_usd() -> int:
    """开户赠送金额（配置在 ``config.SIGNUP_BONUS_MICRO_USD``，默认 $2.00）。"""
    try:
        return max(0, int(config.SIGNUP_BONUS_MICRO_USD))
    except (TypeError, ValueError):
        return 0


def write_signup_bonus(
    conn: sqlite3.Connection,
    user_id: str,
    *,
    now_ms_value: int | None = None,
    kind: str = "signup_bonus",
) -> dict | None:
    """在**调用方事务内**写开户奖励流水；``SIGNUP_BONUS_MICRO_USD=0`` 时不写。

    用户的 ``balance_micro_usd`` 由调用方的 INSERT 一并写入（同事务）；这里只
    追加 ``account_ledger``，``balance_after`` 即赠送额。幂等键固定为
    ``<kind>:<user_id>``，重复调用（理论不可能）会因唯一索引失败而不是重复加钱。
    """
    bonus = signup_balance_micro_usd()
    if bonus <= 0:
        return None
    key = f"{kind}:{user_id}"
    created = now_ms() if now_ms_value is None else int(now_ms_value)
    entry_id = _insert_ledger(
        conn,
        user_id=user_id,
        kind=kind,
        delta_micro_usd=bonus,
        balance_after_micro_usd=bonus,
        created_at_ms=created,
        ref_type="user",
        ref_id=user_id,
        reason="新用户开户赠送 $2.00",
        idempotency_key=key,
        ledger_id=f"bl-{kind}-{user_id}",
    )
    logger.info(
        json.dumps(
            {
                "event": "billing_signup_bonus",
                "user_id": user_id,
                "kind": kind,
                "delta_micro_usd": bonus,
                "ledger_id": entry_id,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )
    return {
        "ledgerId": entry_id,
        "deltaMicroUsd": bonus,
        "balanceAfterMicroUsd": bonus,
        "idempotencyKey": key,
    }


# ---------------------------------------------------------------------------
# 管理员充值 / 扣减
# ---------------------------------------------------------------------------

def _find_idempotent_entry(
    conn: sqlite3.Connection, idempotency_key: str
) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM account_ledger WHERE idempotency_key = ?",
        (idempotency_key,),
    ).fetchone()


def admin_adjust(
    user_id: str,
    delta_micro_usd: int,
    reason: str,
    *,
    actor_id: str | None = None,
    idempotency_key: str | None = None,
    now_ms_value: int | None = None,
) -> dict:
    """管理员充/扣一笔（原子、幂等、不允许负余额），返回新余额与流水 id。

    - ``BEGIN IMMEDIATE`` 里读余额 → 算新余额 → 更新 → 追加流水，并发不丢更新；
    - 扣到负数抛 :class:`InsufficientFunds`，余额与流水都不写；
    - ``idempotency_key`` 已存在时返回**原流水结果**（``replayed=True``），不重复加钱；
      同键不同用户/金额抛 :class:`BillingConflict`。
    """
    try:
        delta = int(delta_micro_usd)
    except (TypeError, ValueError) as exc:
        raise InvalidBillingRequest("调整金额必须是整数 µUSD。") from exc
    if isinstance(delta_micro_usd, bool):
        raise InvalidBillingRequest("调整金额必须是整数 µUSD。")
    if delta == 0:
        raise InvalidBillingRequest("调整金额不能为 0。")
    limit = int(getattr(config, "MAX_ADMIN_BALANCE_DELTA_MICRO_USD", 100_000_000))
    if abs(delta) > limit:
        raise InvalidBillingRequest(
            f"单次调整金额不能超过 ±${format_usd(limit)}。"
        )
    reason = validate_reason(reason)
    key = validate_idempotency_key(idempotency_key)
    kind = "admin_topup" if delta > 0 else "admin_deduct"
    now = now_ms() if now_ms_value is None else int(now_ms_value)

    conn = _connect()
    try:
        _require_billing_tables(conn)
        conn.isolation_level = None
        try:
            conn.execute("BEGIN IMMEDIATE")
            if key:
                existing = _find_idempotent_entry(conn, key)
                if existing is not None:
                    conn.execute("ROLLBACK")
                    if (
                        existing["user_id"] != user_id
                        or int(existing["delta_micro_usd"]) != delta
                    ):
                        raise BillingConflict(
                            "幂等键已被另一笔不同的调整使用。"
                        )
                    return {
                        "userId": user_id,
                        "kind": existing["kind"],
                        "deltaMicroUsd": int(existing["delta_micro_usd"]),
                        "balanceMicroUsd": int(
                            existing["balance_after_micro_usd"]
                        ),
                        "balanceUsd": format_usd(
                            int(existing["balance_after_micro_usd"])
                        ),
                        "ledgerId": existing["id"],
                        "createdAtMs": int(existing["created_at_ms"]),
                        "replayed": True,
                    }
            row = conn.execute(
                "SELECT balance_micro_usd FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            if row is None:
                raise BalanceNotFound(user_id)
            current = int(row["balance_micro_usd"] or 0)
            new_balance = current + delta
            if new_balance < 0:
                raise InsufficientFunds(current, delta)
            conn.execute(
                "UPDATE users SET balance_micro_usd = ? WHERE id = ?",
                (new_balance, user_id),
            )
            entry_id = _insert_ledger(
                conn,
                user_id=user_id,
                kind=kind,
                delta_micro_usd=delta,
                balance_after_micro_usd=new_balance,
                created_at_ms=now,
                ref_type="manual",
                ref_id=None,
                reason=reason,
                actor_id=actor_id,
                idempotency_key=key,
            )
            conn.execute("COMMIT")
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
    finally:
        conn.close()

    logger.info(
        json.dumps(
            {
                "event": "billing_admin_adjust",
                "user_id": user_id,
                "actor_id": actor_id,
                "kind": kind,
                "delta_micro_usd": delta,
                "balance_after_micro_usd": new_balance,
                "ledger_id": entry_id,
                "reason": reason,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )
    return {
        "userId": user_id,
        "kind": kind,
        "deltaMicroUsd": delta,
        "balanceMicroUsd": new_balance,
        "balanceUsd": format_usd(new_balance),
        "ledgerId": entry_id,
        "createdAtMs": now,
        "replayed": False,
    }


def topup(
    user_id: str,
    amount_micro_usd: int,
    reason: str,
    *,
    actor_id: str | None = None,
    idempotency_key: str | None = None,
) -> dict:
    """管理员充值（正数）。"""
    if int(amount_micro_usd) <= 0:
        raise InvalidBillingRequest("充值金额必须大于 0。")
    return admin_adjust(
        user_id,
        int(amount_micro_usd),
        reason,
        actor_id=actor_id,
        idempotency_key=idempotency_key,
    )


def deduct(
    user_id: str,
    amount_micro_usd: int,
    reason: str,
    *,
    actor_id: str | None = None,
    idempotency_key: str | None = None,
) -> dict:
    """管理员扣减（正数金额，内部转负）；扣成负数会被拒绝。"""
    if int(amount_micro_usd) <= 0:
        raise InvalidBillingRequest("扣减金额必须大于 0。")
    return admin_adjust(
        user_id,
        -int(amount_micro_usd),
        reason,
        actor_id=actor_id,
        idempotency_key=idempotency_key,
    )


# ---------------------------------------------------------------------------
# 流水查询
# ---------------------------------------------------------------------------

def ledger_entries(
    user_id: str, *, limit: int = DEFAULT_LIST_LIMIT, offset: int = 0
) -> dict:
    """某用户的流水（按时间倒序）+ 当前余额；管理台用户详情用。"""
    limit = max(1, min(int(limit), MAX_LIST_LIMIT))
    offset = max(0, min(int(offset), 100_000))
    conn = _connect()
    try:
        _require_billing_tables(conn)
        user = conn.execute(
            "SELECT id, email, username, status FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if user is None:
            raise BalanceNotFound(user_id)
        rows = conn.execute(
            "SELECT id, user_id, kind, delta_micro_usd, balance_after_micro_usd, "
            "ref_type, ref_id, reason, actor_id, idempotency_key, created_at_ms "
            "FROM account_ledger WHERE user_id = ? "
            "ORDER BY created_at_ms DESC, id DESC LIMIT ? OFFSET ?",
            (user_id, limit, offset),
        ).fetchall()
        total = int(
            conn.execute(
                "SELECT COUNT(*) FROM account_ledger WHERE user_id = ?", (user_id,)
            ).fetchone()[0]
            or 0
        )
    finally:
        conn.close()
    balance = get_balance(user_id)
    return {
        "user": {
            "id": user["id"],
            "email": user["email"],
            "username": user["username"],
            "status": user["status"],
        },
        "balanceMicroUsd": balance["balanceMicroUsd"],
        "balanceUsd": balance["balanceUsd"],
        "availableMicroUsd": balance["availableMicroUsd"],
        "availableUsd": balance["availableUsd"],
        "activeHoldsMicroUsd": balance["activeHoldsMicroUsd"],
        "entries": [
            {
                "id": row["id"],
                "kind": row["kind"],
                "deltaMicroUsd": int(row["delta_micro_usd"]),
                "deltaUsd": format_usd(int(row["delta_micro_usd"])),
                "balanceAfterMicroUsd": int(row["balance_after_micro_usd"]),
                "balanceAfterUsd": format_usd(
                    int(row["balance_after_micro_usd"])
                ),
                "refType": row["ref_type"],
                "refId": row["ref_id"],
                "reason": row["reason"],
                "actorId": row["actor_id"],
                "idempotencyKey": row["idempotency_key"],
                "createdAtMs": int(row["created_at_ms"]),
            }
            for row in rows
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


# ---------------------------------------------------------------------------
# 价格解析
# ---------------------------------------------------------------------------

def _price_from_row(row: sqlite3.Row) -> dict:
    return {
        "modelId": row["model_id"],
        "provider": row["provider"],
        "inputMicroUsdPerMtok": int(row["input_micro_usd_per_mtok"]),
        "outputMicroUsdPerMtok": int(row["output_micro_usd_per_mtok"]),
        "priceVersion": row["price_version"],
        "sourceKind": row["source_kind"],
        "sourceRef": row["source_ref"],
        "verifiedAtMs": int(row["verified_at_ms"]),
        "priceSource": SOURCE_KIND_TO_PRICE_SOURCE.get(
            row["source_kind"], "manual"
        ),
        "billable": True,
    }


def _catalog_price(model_id: str) -> dict | None:
    """``MODEL_CATALOG`` 的 in/out 兜底（标 ``catalog_unverified``，不静默按最贵）。"""
    spec = config.MODEL_CATALOG.get(model_id)
    if not isinstance(spec, dict):
        return None
    in_price = spec.get("in")
    out_price = spec.get("out")
    for value in (in_price, out_price):
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
            return None
    return {
        "modelId": model_id,
        "provider": str(spec.get("provider") or "unknown"),
        "inputMicroUsdPerMtok": int(round(float(in_price) * MICRO_USD_PER_USD)),
        "outputMicroUsdPerMtok": int(round(float(out_price) * MICRO_USD_PER_USD)),
        "priceVersion": "catalog",
        "sourceKind": "catalog",
        "sourceRef": "config.MODEL_CATALOG",
        "verifiedAtMs": None,
        "priceSource": "catalog_unverified",
        "billable": True,
    }


def price_for_model(model_id: str | None, *, now_ms_value: int | None = None) -> dict | None:
    """模型 id → 价格快照；无价返回 ``None``（调用方必须按 billable=0 处理）。

    优先级：``model_prices``（最近一条 ``effective_from_ms <= now``）→
    ``MODEL_CATALOG`` 的 in/out（``catalog_unverified``）→ None（缺价）。
    未迁移（``schema_ready()`` 为假）时一律返回 None，不启用以价格表为前提的扣费。
    """
    if not model_id or not schema_ready():
        return None
    now = now_ms() if now_ms_value is None else int(now_ms_value)
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT model_id, provider, effective_from_ms, "
            "input_micro_usd_per_mtok, output_micro_usd_per_mtok, source_kind, "
            "source_ref, verified_at_ms, price_version, note "
            "FROM model_prices WHERE model_id = ? AND effective_from_ms <= ? "
            "ORDER BY effective_from_ms DESC LIMIT 1",
            (model_id, now),
        ).fetchone()
    finally:
        conn.close()
    if row is not None:
        price = _price_from_row(row)
        price["effectiveFromMs"] = int(row["effective_from_ms"])
        return price
    return _catalog_price(model_id)


def max_price_for_models(model_ids) -> dict | None:
    """候选模型列表里「每 1M token 最贵」的一组 in/out（预占用；缺价跳过）。"""
    best: dict | None = None
    for model_id in model_ids or ():
        price = price_for_model(model_id)
        if price is None:
            continue
        if best is None or (
            price["inputMicroUsdPerMtok"] + price["outputMicroUsdPerMtok"]
            > best["inputMicroUsdPerMtok"] + best["outputMicroUsdPerMtok"]
        ):
            best = price
    return best


def strict_mode() -> bool:
    """严格计费是否生效（M7a；默认开，``BILLING_STRICT=0`` 仅作回滚逃生门）。

    严格模式下：没有登录用户拒绝（403 login_required）；没有可核实单价拒绝
    （503 model_unpriced）；不允许 ``billable=0`` 的免费账号调用。非严格模式
    只保留给「迁移前旧部署/脚本」临时回滚，生产不得关闭。
    """
    return bool(getattr(config, "BILLING_STRICT", True))


def is_priced(model_id: str | None) -> bool:
    """模型是否有可核实单价（严格模式下选路/降级链只允许 priced 模型）。"""
    return price_for_model(model_id) is not None


# ---------------------------------------------------------------------------
# 成本 / 预占估算
# ---------------------------------------------------------------------------

def ceil_micro(value: float) -> int:
    """向上取整到 1 µUSD（每个分量最多多收 <1 µUSD，宁可略高估）。"""
    if value <= 0:
        return 0
    return int(math.ceil(value - 1e-9))


def token_cost_micro_usd(
    input_tokens: int, output_tokens: int, price: dict
) -> int:
    """按价格快照算成本：每个分量分别 ceil 到 1 µUSD。"""
    in_tokens = max(0, int(input_tokens or 0))
    out_tokens = max(0, int(output_tokens or 0))
    in_cost = ceil_micro(
        in_tokens * int(price["inputMicroUsdPerMtok"]) / MICRO_USD_PER_USD
    )
    out_cost = ceil_micro(
        out_tokens * int(price["outputMicroUsdPerMtok"]) / MICRO_USD_PER_USD
    )
    return in_cost + out_cost


def estimate_reserve(
    feature: str,
    prompt_chars: int = 0,
    model_ids=None,
) -> dict:
    """估算预占金额（整数 µUSD）：prompt 输入 + 功能输出上界 × 最高单价 × 1.2。

    - 输入 token 按「2 字符/token」保守高估（与 ``llm._estimate_tokens`` 同口径）；
    - 输出按 ``config.BILLING_FEATURE_OUTPUT_TOKENS``（功能级上界）；
    - 单价取候选链最高（``max_price_for_models``），缺价模型跳过；
    - 加 ``BILLING_RESERVE_MARGIN_PERCENT``（默认 20%）安全边际，最小 1 µUSD；
    - 超过单次上限 ``BILLING_MAX_RESERVE_MICRO_USD``（默认 $0.50）时**封顶**，
      结算仍按实际用量（允许 overrun，见规格 §7）。
    """
    models = list(model_ids or ())
    price = max_price_for_models(models)
    if price is None:
        return {
            "amountMicroUsd": 0,
            "billable": False,
            "reason": "unpriced",
            "price": None,
            "inputTokens": 0,
            "outputTokens": 0,
            "capped": False,
        }
    in_tokens = max(1, int(prompt_chars or 0) // 2) if prompt_chars else 0
    out_tokens = int(
        config.BILLING_FEATURE_OUTPUT_TOKENS.get(
            feature, config.BILLING_DEFAULT_OUTPUT_TOKENS
        )
    )
    base = token_cost_micro_usd(in_tokens, out_tokens, price)
    margin_pct = 0.0
    try:
        margin_pct = max(0.0, float(config.BILLING_RESERVE_MARGIN_PERCENT))
    except (TypeError, ValueError):
        margin_pct = 0.0
    amount = ceil_micro(base * (1.0 + margin_pct / 100.0))
    amount = max(1, amount)
    cap = max(1, int(config.BILLING_MAX_RESERVE_MICRO_USD))
    capped = amount > cap
    if capped:
        amount = cap
    return {
        "amountMicroUsd": amount,
        "billable": True,
        "reason": "priced",
        "price": price,
        "inputTokens": in_tokens,
        "outputTokens": out_tokens,
        "baseMicroUsd": base,
        "capped": capped,
        "maxReserveMicroUsd": cap,
    }


def ensure_affordable(
    user_id: str | None,
    feature: str,
    *,
    model_ids=None,
) -> None:
    """调用前的低成本 402 预检查（不写库、不占 hold）。

    在 ``ai.quota.check_and_consume_quota`` 里、扣日配额之前调用：余额连「输出
    上界 × 候选链最高价」都付不起时优先返回 402，避免先 429 或先扣日额度。
    未登录/游客/未迁移/模型无价时直接放行（不阻断老行为）。
    """
    if not user_id or not _is_billable_user(user_id):
        return
    if not schema_ready():
        return
    estimate = estimate_reserve(feature, 0, model_ids)
    if not estimate["billable"] or estimate["amountMicroUsd"] <= 0:
        return
    try:
        balance = get_balance(user_id)
    except (BalanceNotFound, BillingUnavailable, sqlite3.OperationalError):
        # 用户不存在（脚本/测试/已删除）或表不可读：没有可扣的余额，按旧行为放行。
        return
    if balance["availableMicroUsd"] < estimate["amountMicroUsd"]:
        raise InsufficientBalance(
            balance_micro_usd=balance["balanceMicroUsd"],
            available_micro_usd=balance["availableMicroUsd"],
            required_micro_usd=estimate["amountMicroUsd"],
            user_id=user_id,
            feature=feature,
        )


def _is_billable_user(user_id: object) -> bool:
    """真实账号才计费；游客 ``guest:<sha256>`` 与匿名不计费（无余额账户）。"""
    return (
        isinstance(user_id, str)
        and bool(user_id)
        and not user_id.startswith("guest:")
    )


# ---------------------------------------------------------------------------
# 预占 / 结算 / 释放 / 过期
# ---------------------------------------------------------------------------

def _hold_row(conn: sqlite3.Connection, hold_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM credit_holds WHERE id = ?", (hold_id,)
    ).fetchone()


def reserve(
    user_id: str,
    amount_micro_usd: int,
    *,
    feature: str | None = None,
    request_id: str | None = None,
    now_ms_value: int | None = None,
    ttl_seconds: int | None = None,
) -> dict:
    """预占可用余额（不写流水，账面余额不变）；不足抛 402。

    ``BEGIN IMMEDIATE`` 内：先把自己的过期 hold 标 expired → 算
    ``available = 余额 − active holds`` → 不足则回滚并抛
    :class:`InsufficientBalance`；否则插 ``credit_holds``。
    """
    amount = int(amount_micro_usd)
    if amount <= 0:
        raise InvalidBillingRequest("预占金额必须大于 0。")
    if not _is_billable_user(user_id):
        return {"id": None, "userId": user_id, "amountMicroUsd": 0, "anonymous": True}
    now = now_ms() if now_ms_value is None else int(now_ms_value)
    ttl = (
        int(getattr(config, "BILLING_HOLD_TTL_SECONDS", 1800))
        if ttl_seconds is None
        else int(ttl_seconds)
    )
    expires = now + max(1, ttl) * 1000
    hold_id = f"hold-{uuid.uuid4().hex}"

    conn = _connect()
    try:
        _require_billing_tables(conn)
        conn.isolation_level = None
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "UPDATE credit_holds SET status = 'expired' "
                "WHERE user_id = ? AND status = 'active' AND expires_at_ms <= ?",
                (user_id, now),
            )
            row = conn.execute(
                "SELECT balance_micro_usd FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            if row is None:
                raise BalanceNotFound(user_id)
            balance = int(row["balance_micro_usd"] or 0)
            held = _active_holds_micro_usd(conn, user_id, now=now)
            available = balance - held
            if available < amount:
                conn.execute("ROLLBACK")
                raise InsufficientBalance(
                    balance_micro_usd=balance,
                    available_micro_usd=available,
                    required_micro_usd=amount,
                    user_id=user_id,
                    feature=feature,
                )
            conn.execute(
                "INSERT INTO credit_holds ("
                "id, user_id, amount_micro_usd, status, created_at_ms, "
                "expires_at_ms, ai_request_id) VALUES (?, ?, ?, 'active', ?, ?, ?)",
                (hold_id, user_id, amount, now, expires, request_id),
            )
            conn.execute("COMMIT")
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
    finally:
        conn.close()

    logger.info(
        json.dumps(
            {
                "event": "billing_reserve",
                "user_id": user_id,
                "hold_id": hold_id,
                "feature": feature,
                "amount_micro_usd": amount,
                "expires_at_ms": expires,
                "request_id": request_id,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )
    return {
        "id": hold_id,
        "userId": user_id,
        "amountMicroUsd": amount,
        "createdAtMs": now,
        "expiresAtMs": expires,
        "feature": feature,
        "requestId": request_id,
    }


def settle(
    hold_id: str,
    actual_micro_usd: int,
    *,
    usage: dict,
    now_ms_value: int | None = None,
    release_if_unpriced: bool = True,
) -> dict:
    """按真实用量结算：写 ``ai_usage`` + 扣余额 + 写 ``ai_settle`` 流水 + 关 hold。

    **同一事务**：任一写库失败整笔回滚，hold 保持 active（不静默丢扣费），
    由调用方告警并可重试。``actual > hold`` 允许发生（估算偏差/价格变化），
    余额可变为负但不得少记，日志标 ``overrun``。
    """
    actual = max(0, int(actual_micro_usd))
    now = now_ms() if now_ms_value is None else int(now_ms_value)
    # 价格在事务外解析（读 model_prices 不需要写锁）；事务内只做余额/流水/用量写。
    price = price_for_model(usage.get("model_id"), now_ms_value=now)
    target_lang = (
        languages.normalize_code(usage.get("target_lang"))
        or languages.DEFAULT_TARGET_LANG
    )
    conn = _connect()
    try:
        _require_billing_tables(conn)
        conn.isolation_level = None
        try:
            conn.execute("BEGIN IMMEDIATE")
            hold = _hold_row(conn, hold_id)
            if hold is None:
                raise HoldNotFound(hold_id)
            status = hold["status"]
            if status == HOLD_SETTLED:
                conn.execute("ROLLBACK")
                return {
                    "holdId": hold_id,
                    "status": HOLD_SETTLED,
                    "alreadySettled": True,
                    "costMicroUsd": actual,
                }
            if status != HOLD_ACTIVE:
                raise HoldNotActive(
                    f"hold {hold_id} 状态为 {status}，不能结算。"
                )
            user_id = hold["user_id"]
            reserved = int(hold["amount_micro_usd"])

            if price is None:
                # 预占时有价、结算时无价（价格行被删/时钟回拨）：不能凭空扣费。
                # 释放 hold，账本按未计费记录（billable=0）。
                if not release_if_unpriced:
                    raise BillingConflict("结算时模型缺价，不能扣费。")
                conn.execute(
                    "UPDATE credit_holds SET status = ?, settled_at_ms = ? "
                    "WHERE id = ?",
                    (HOLD_RELEASED, now, hold_id),
                )
                conn.execute("COMMIT")
                return {
                    "holdId": hold_id,
                    "status": HOLD_RELEASED,
                    "costMicroUsd": 0,
                    "billed": False,
                    "reason": "unpriced_at_settle",
                }

            fields = {
                "user_id": user_id,
                "feature": usage.get("feature") or "translate",
                "model_id": usage.get("model_id") or "unknown",
                "provider": usage.get("provider") or price["provider"],
                "input_tokens": max(0, int(usage.get("input_tokens") or 0)),
                "output_tokens": max(0, int(usage.get("output_tokens") or 0)),
                "calls": max(0, int(usage.get("calls") or 1)),
                "est_cost_usd": round(actual / MICRO_USD_PER_USD, 6),
                "occurred_at": int(usage.get("occurred_at") or now),
                "created_at": now,
                "usage_date": ledger.day_of(int(usage.get("occurred_at") or now)),
                "target_lang": target_lang,
                "cost_micro_usd": actual,
                "input_price_micro_usd_per_mtok": int(
                    price["inputMicroUsdPerMtok"]
                ),
                "output_price_micro_usd_per_mtok": int(
                    price["outputMicroUsdPerMtok"]
                ),
                "price_version": price["priceVersion"],
                "price_source": price["priceSource"],
                "token_source": usage.get("token_source") or "unknown",
                "billable": 1,
                "billing_status": "settled",
                "hold_id": hold_id,
                "request_id": usage.get("request_id"),
            }
            usage_id = ledger.insert_usage(conn, fields)
            row = conn.execute(
                "SELECT balance_micro_usd FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            if row is None:
                raise BalanceNotFound(user_id)
            balance = int(row["balance_micro_usd"] or 0)
            new_balance = balance - actual
            if actual:
                conn.execute(
                    "UPDATE users SET balance_micro_usd = ? WHERE id = ?",
                    (new_balance, user_id),
                )
                overrun = actual > reserved
                reason = (
                    f"AI 调用结算（{fields['feature']} / {fields['model_id']}）"
                    + (f" [overrun {actual - reserved}µUSD > hold {reserved}µUSD]" if overrun else "")
                )
                _insert_ledger(
                    conn,
                    user_id=user_id,
                    kind="ai_settle",
                    delta_micro_usd=-actual,
                    balance_after_micro_usd=new_balance,
                    created_at_ms=now,
                    ref_type="ai_usage",
                    ref_id=str(usage_id),
                    reason=reason,
                    idempotency_key=f"ai_settle:{hold_id}",
                )
            else:
                overrun = False
            conn.execute(
                "UPDATE credit_holds SET status = ?, settled_at_ms = ? WHERE id = ?",
                (HOLD_SETTLED, now, hold_id),
            )
            conn.execute("COMMIT")
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
    finally:
        conn.close()

    if overrun:
        logger.warning(
            json.dumps(
                {
                    "event": "billing_overrun",
                    "hold_id": hold_id,
                    "user_id": user_id,
                    "reserved_micro_usd": reserved,
                    "actual_micro_usd": actual,
                    "balance_after_micro_usd": new_balance,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        # 飞书 P1（M5）：结算实际成本超过预占。告警按用户进入 15 分钟聚合，
        # 失败只记日志，不影响结算结果（余额/流水/返回口径都不变）。
        try:
            alerts.notify_billing_overrun(
                hold_id=hold_id,
                user_id=user_id,
                reserved_micro_usd=reserved,
                actual_micro_usd=actual,
            )
        except Exception:  # noqa: BLE001
            logger.warning("发送 overrun 告警失败（已忽略）。")
    return {
        "holdId": hold_id,
        "status": HOLD_SETTLED,
        "costMicroUsd": actual,
        "balanceAfterMicroUsd": new_balance,
        "usageId": usage_id,
        "overrun": overrun,
        "reservedMicroUsd": reserved,
    }


def release(
    hold_id: str,
    *,
    reason: str | None = None,
    now_ms_value: int | None = None,
) -> dict:
    """释放预占（调用失败/超时/取消）；不扣余额、不写流水。幂等。"""
    now = now_ms() if now_ms_value is None else int(now_ms_value)
    conn = _connect()
    try:
        _require_billing_tables(conn)
        cursor = conn.execute(
            "UPDATE credit_holds SET status = ?, settled_at_ms = ? "
            "WHERE id = ? AND status = ?",
            (HOLD_RELEASED, now, hold_id, HOLD_ACTIVE),
        )
        conn.commit()
        changed = max(0, int(cursor.rowcount or 0))
    finally:
        conn.close()
    if changed:
        logger.info(
            json.dumps(
                {
                    "event": "billing_release",
                    "hold_id": hold_id,
                    "reason": reason,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
    return {"holdId": hold_id, "released": bool(changed), "status": HOLD_RELEASED}


def expire_stale_holds(
    *, now_ms_value: int | None = None, user_id: str | None = None
) -> int:
    """把超过 ``expires_at_ms`` 仍 active 的 hold 标 expired（进程崩溃兜底）。"""
    now = now_ms() if now_ms_value is None else int(now_ms_value)
    conn = _connect()
    try:
        if not _table_exists(conn, "credit_holds"):
            return 0
        if user_id is None:
            cursor = conn.execute(
                "UPDATE credit_holds SET status = ? WHERE status = ? "
                "AND expires_at_ms <= ?",
                (HOLD_EXPIRED, HOLD_ACTIVE, now),
            )
        else:
            cursor = conn.execute(
                "UPDATE credit_holds SET status = ? WHERE status = ? "
                "AND user_id = ? AND expires_at_ms <= ?",
                (HOLD_EXPIRED, HOLD_ACTIVE, user_id, now),
            )
        conn.commit()
        return max(0, int(cursor.rowcount or 0))
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 管理台汇总
# ---------------------------------------------------------------------------

def _group_sum(conn: sqlite3.Connection, column: str, where: str, params) -> list:
    return conn.execute(
        f"SELECT {column} AS key, SUM(COALESCE(cost_micro_usd, 0)) AS cost, "
        "SUM(COALESCE(calls, 0)) AS calls, COUNT(*) AS rows, "
        "SUM(CASE WHEN COALESCE(billing_status, 'legacy') IN ('unbilled','legacy') "
        "THEN 1 ELSE 0 END) AS unpriced_rows "
        f"FROM ai_usage WHERE {where} GROUP BY {column} ORDER BY cost DESC",
        params,
    ).fetchall()


def billing_summary(
    *, day_from: str | None = None, day_to: str | None = None
) -> dict:
    """``GET /api/admin/billing/summary``：按天/模型/功能汇总 token 与成本。

    只读聚合，金额为整数 µUSD；``unbilledRows`` 是缺价/历史未计费条数（**没有**
    扣用户余额），``legacyRows`` 是 0025 之前的历史行。``day_from`` / ``day_to``
    是 ``usage_date`` 的 ``YYYY-MM-DD``（含 to 当天，用 ``<=``）。
    """
    if not schema_ready():
        raise BillingUnavailable(
            "计费表未就绪：请先运行 `alembic upgrade head`（0025_balance_cost）。"
        )
    clauses = ["1 = 1"]
    params: list = []
    if day_from:
        clauses.append("usage_date >= ?")
        params.append(str(day_from))
    if day_to:
        clauses.append("usage_date <= ?")
        params.append(str(day_to))
    where = " AND ".join(clauses)

    conn = _connect()
    try:
        totals_row = conn.execute(
            "SELECT COUNT(*) AS rows, SUM(COALESCE(calls, 0)) AS calls, "
            "SUM(COALESCE(input_tokens, 0)) AS input_tokens, "
            "SUM(COALESCE(output_tokens, 0)) AS output_tokens, "
            "SUM(COALESCE(cost_micro_usd, 0)) AS cost_micro_usd, "
            "SUM(COALESCE(est_cost_usd, 0)) AS est_cost_usd, "
            "SUM(CASE WHEN COALESCE(billing_status, 'legacy') IN ('unbilled','legacy') "
            "THEN 1 ELSE 0 END) AS unpriced_rows, "
            "SUM(CASE WHEN COALESCE(billing_status, 'legacy') = 'legacy' "
            "THEN 1 ELSE 0 END) AS legacy_rows, "
            "SUM(CASE WHEN billing_status = 'settle_failed' THEN 1 ELSE 0 END) "
            "AS settle_failed_rows "
            f"FROM ai_usage WHERE {where}",
            params,
        ).fetchone()
        by_day = _group_sum(conn, "usage_date", where, params)
        by_model = _group_sum(conn, "model_id", where, params)
        by_feature = _group_sum(conn, "feature", where, params)
        provider_rows = conn.execute(
            "SELECT model_id, provider FROM ai_usage WHERE " + where + " "
            "GROUP BY model_id, provider",
            params,
        ).fetchall()
        providers = {row["model_id"]: row["provider"] for row in provider_rows}
        active_holds = conn.execute(
            "SELECT COUNT(*) AS count, COALESCE(SUM(amount_micro_usd), 0) AS amount "
            "FROM credit_holds WHERE status = 'active' AND expires_at_ms > ?",
            (now_ms(),),
        ).fetchone()
        balances = conn.execute(
            "SELECT COUNT(*) AS count, COALESCE(SUM(balance_micro_usd), 0) AS total "
            "FROM users WHERE COALESCE(balance_micro_usd, 0) <> 0"
        ).fetchone()
        ledger_sum = conn.execute(
            "SELECT COALESCE(SUM(delta_micro_usd), 0) AS total FROM account_ledger"
        ).fetchone()
        prices = conn.execute(
            "SELECT model_id, provider, input_micro_usd_per_mtok, "
            "output_micro_usd_per_mtok, price_version, source_kind, source_ref, "
            "verified_at_ms FROM model_prices p WHERE effective_from_ms = ("
            "  SELECT MAX(effective_from_ms) FROM model_prices WHERE model_id = p.model_id"
            ") ORDER BY model_id"
        ).fetchall()
    finally:
        conn.close()

    def _entry(row: sqlite3.Row) -> dict:
        return {
            "key": row["key"],
            "costMicroUsd": int(row["cost"] or 0),
            "costUsd": format_usd(int(row["cost"] or 0)),
            "calls": int(row["calls"] or 0),
            "rows": int(row["rows"] or 0),
            "unbilledRows": int(row["unpriced_rows"] or 0),
        }

    total_cost = int(totals_row["cost_micro_usd"] or 0)
    unpriced_models = sorted(
        row["key"] for row in by_model if int(row["unpriced_rows"] or 0) > 0
    )
    return {
        "from": day_from,
        "to": day_to,
        "totals": {
            "rows": int(totals_row["rows"] or 0),
            "calls": int(totals_row["calls"] or 0),
            "inputTokens": int(totals_row["input_tokens"] or 0),
            "outputTokens": int(totals_row["output_tokens"] or 0),
            "billedCostMicroUsd": total_cost,
            "billedCostUsd": format_usd(total_cost),
            # 兼容旧分析口径：est_cost_usd 是「估算/上界」，不是账单。
            "estimatedCostUsd": round(float(totals_row["est_cost_usd"] or 0.0), 6),
            "unbilledRows": int(totals_row["unpriced_rows"] or 0),
            "legacyRows": int(totals_row["legacy_rows"] or 0),
            "settleFailedRows": int(totals_row["settle_failed_rows"] or 0),
        },
        "byDay": [_entry(row) for row in by_day],
        "byModel": [
            {
                **_entry(row),
                "modelId": row["key"],
                "provider": providers.get(row["key"]),
            }
            for row in by_model
        ],
        "byFeature": [_entry(row) for row in by_feature],
        "unpricedModels": unpriced_models,
        "holds": {
            "activeCount": int(active_holds["count"] or 0),
            "activeMicroUsd": int(active_holds["amount"] or 0),
            "activeUsd": format_usd(int(active_holds["amount"] or 0)),
        },
        "balances": {
            "usersWithBalance": int(balances["count"] or 0),
            "totalMicroUsd": int(balances["total"] or 0),
            "totalUsd": format_usd(int(balances["total"] or 0)),
            "ledgerDeltaMicroUsd": int(ledger_sum["total"] or 0),
        },
        "prices": [
            {
                "modelId": row["model_id"],
                "provider": row["provider"],
                "inputMicroUsdPerMtok": int(row["input_micro_usd_per_mtok"]),
                "outputMicroUsdPerMtok": int(row["output_micro_usd_per_mtok"]),
                "priceVersion": row["price_version"],
                "sourceKind": row["source_kind"],
                "sourceRef": row["source_ref"],
                "verifiedAtMs": int(row["verified_at_ms"] or 0),
            }
            for row in prices
        ],
    }


__all__ = [
    "BillingConflict",
    "BillingError",
    "BillingUnavailable",
    "BalanceNotFound",
    "HoldNotActive",
    "HoldNotFound",
    "InsufficientBalance",
    "InsufficientFunds",
    "InvalidBillingRequest",
    "MICRO_USD_PER_USD",
    "admin_adjust",
    "available_micro_usd",
    "billing_summary",
    "ceil_micro",
    "deduct",
    "ensure_affordable",
    "ensure_schema_compat",
    "estimate_reserve",
    "expire_stale_holds",
    "format_usd",
    "get_balance",
    "ledger_entries",
    "max_price_for_models",
    "now_ms",
    "parse_usd_amount",
    "price_for_model",
    "release",
    "reserve",
    "reset_cache",
    "schema_ready",
    "settle",
    "signup_balance_micro_usd",
    "token_cost_micro_usd",
    "topup",
    "validate_idempotency_key",
    "validate_reason",
    "write_signup_bonus",
]
