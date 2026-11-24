"""三层配额（每用户/功能日限额 → 每用户日预算 → 全局日预算）与模型降级链。

配额口径（计划书 §7.4「配额与预算」，P0-05 起单一事实源）：

1. **每用户每功能日限额**：``ai_quota`` 里 ``(user_id, day, feature)`` 的
   ``used_units`` 原子 UPSERT 递增；**上限来自 ``quota_config`` 的三层解析**
   （单用户覆盖 > 后台全局默认 > ``config.AI_DAILY_QUOTA_*``，见 specs/047），
   由 ``limit_for(feature, user_id)`` 统一读出并把解析结果显式传给
   ``ledger.check_and_consume_quota(limit=...)``。行内 ``limit_units`` 只是
   消费时的审计快照，**不参与判断**（P0-05：同一用户同一天不再因不同进程的
   env 上限出现 374/30 与 374/400 两套判断）。覆盖表未迁移时运行时只按默认层
   继续（fail-open + 告警），管理 API 则返回 503。
2. **每用户日预算**：``ai_usage`` 当日 SUM ≥ ``AI_DAILY_BUDGET_USER_USD``
   → ``BudgetExceeded``。
3. **全局日预算**：全站当日 SUM ≥ ``AI_DAILY_BUDGET_GLOBAL_USD``
   → ``BudgetExceeded``。

**非用户主体（P0-05）**：``ops:<name>`` / ``sponsored:<name>``（前缀见
``config.AI_OPS_SUBJECT_PREFIXES``）不是用户——不写用户 ``ai_quota`` 行、不查
余额（无 402），只受**独立日配额**（``AI_OPS_DAILY_QUOTA``，0 = 不限功能次数）
与**全局日预算**约束；``ai_usage`` 照记 tokens/成本供审计。读侧统一用
:func:`snapshot`（used 取库、limit 取 config）。

**单位口径（P2-34）**：``ai_quota.used_units`` 记录的不是「批次数」，而是
**内容量单位**，换算统一走 :func:`units_for_blocks`：

- ``translate`` / ``local_show``：1 单位 = 100 个字幕 blocks；
- ``reading``：1 单位 = 10 段文章；
- 其他功能（``summary`` / ``define`` / ``quiz`` / ``analysis`` /
  ``course_generation``）：1 次 = 1 单位。

每批至少扣 1 单位（``max(1, ceil(内容量 / 每单位量))``）；同一次生成里多批
按**累计内容量**分配单位（:func:`units_per_batch`）：合计 = ``ceil(总内容量 /
每单位量)``，如 1,372 blocks = 14 单位、10 段文章 = 1 单位，不会因为切小批而
被重复向上取整。因此默认 60 单位 ≈ 视频 6,000 blocks/日、文章 600 段/日。
**旧行不可直接与新语义比较**：切换前写入的 ``ai_quota.used_units`` 是「批次数」，
只能当历史审计数据看，不要换算或与新单位混算。``ai_quota`` 表结构不变，也没有
数据迁移。

超限统一抛 ``QuotaExceeded``（``status_code = 429``）。未跑 ``0003_cost_ledger``
迁移的库**fail-open**（记日志、不阻断 AI 功能）——这是为了让升级过程中应用
仍可用；上线前必须跑迁移，否则配额不会生效。

降级链（每个 AI 功能共用，不各自发明）：

    [首选（可用时）] → 同 provider 更便宜的模型 → 另一个可用 provider 的模型

- 价格比较用目录 ``in + out``（未知价按已知最贵，见 ``ledger.price_for``）；
- 只纳入 ``llm.is_available()`` 为真的模型；
- **大陆模式（``AI_MODEL_REGION=cn`` / 默认模型是 DeepSeek 时的 auto）不会把
  Google Gemini 放进自动降级链**；显式传 ``preferred_model=gemini-*`` 时它仍可
  作为首选（用户主动选择），但自动兜底只会在非 Google 模型之间走。
"""
from __future__ import annotations

import logging
import math
import sqlite3
from collections.abc import Sequence

import alerts
import billing
import config
import languages
import llm
import quota_config
from ai import ledger
from ai.ledger import KNOWN_FEATURES, QuotaExceeded

logger = logging.getLogger(__name__)

# 单一事实源在 ``quota_config``；这里保留旧名做兼容别名（course_generator /
# teaching_analysis 的注释仍指向它）。
_FEATURE_LIMIT_ATTRS = quota_config.FEATURE_LIMIT_ATTRS

_warned_missing_tables = False
_warned_missing_overrides = False

#: 内容量 → 配额单位的换算（P2-34）。``None``/未登记功能按「1 次 = 1 单位」。
BLOCKS_PER_UNIT = 100
PARAGRAPHS_PER_UNIT = 10
_CONTENT_PER_UNIT: dict[str, int] = {
    "translate": BLOCKS_PER_UNIT,
    "local_show": BLOCKS_PER_UNIT,
    "reading": PARAGRAPHS_PER_UNIT,
}


def units_for_blocks(feature: str, n: int | float | None) -> int:
    """把一批的内容量换算成配额单位（P2-34 唯一换算入口）。

    - ``translate`` / ``local_show``：1 单位 = 100 blocks（字幕块）；
    - ``reading``：1 单位 = 10 段（段落）；
    - 其他功能：1 次 = 1 单位（与旧行为一致）。

    规则：向上取整、**每批至少 1 单位**；``0`` / 负数 / ``None`` / 非法值都按
    1 处理（空批不会走到扣费，这里只是兜底，避免「0 块」绕过配额硬闸）。
    非整数 ``n``（如 100.5）按 ``int`` 截断后再换算。
    """
    try:
        count = max(0, int(n or 0))
    except (TypeError, ValueError):
        count = 0
    per_unit = _CONTENT_PER_UNIT.get(feature)
    if per_unit is None:
        return 1
    return max(1, math.ceil(count / per_unit))


def units_per_batch(feature: str, batch_sizes: Sequence[int]) -> list[int]:
    """把一串批次的内容量换算成**每批新增**的配额单位（P2-34 批量入口）。

    口径：第 k 批新增单位 = ``ceil(前 k 批累计内容量 / 每单位量)`` 减去前
    ``k-1`` 批已分配的单位。这样多批合计正好是 ``ceil(总内容量 / 每单位量)``：

    - 1,372 blocks（translate）→ 合计 14 单位，无论切成几个小批；
    - 10 段（reading）→ 合计 1 单位（若按每批各自取整，5+5 会误算成 2）。

    返回值与 ``batch_sizes`` 等长、元素 ≥0：中间批次可能是 0（该批落在前面
    批次已经买下的同一个单位里，调用方改走只读闸门
    :func:`ensure_quota_available`，不要重复占额度）。空批（size 0）返回 0；
    负数/非法值按 0 处理。非内容型功能每批固定 1 单位。
    """
    per_unit = _CONTENT_PER_UNIT.get(feature)
    sizes: list[int] = []
    for size in batch_sizes:
        try:
            sizes.append(max(0, int(size or 0)))
        except (TypeError, ValueError):
            sizes.append(0)
    if per_unit is None:
        return [1 if size > 0 else 0 for size in sizes]

    allocated = 0
    cumulative = 0
    units: list[int] = []
    for size in sizes:
        cumulative += size
        target = math.ceil(cumulative / per_unit) if cumulative > 0 else 0
        added = max(0, target - allocated)
        allocated += added
        units.append(added)
    return units


class BudgetExceeded(QuotaExceeded):
    """当日用户/全站 AI 预算不足（429，与功能配额同一退出通道）。"""

    def __init__(
        self,
        scope: str,
        *,
        day: str,
        spend_usd: float,
        limit_usd: float,
        user_id: str | None = None,
    ) -> None:
        self.scope = scope
        self.spend_usd = spend_usd
        self.limit_usd = limit_usd
        who = "用户" if scope == "user" else "全站"
        super().__init__(
            "budget",
            day=day,
            user_id=user_id,
            scope=scope,
            detail=(
                f"今日 AI 预算已用完（{who}当日 ${spend_usd:.4f}/${limit_usd:.2f}，"
                "明天 0 点恢复）；复习与本地词典不受影响。"
            ),
        )


def rethrow_billing_error(exc: BaseException) -> None:
    """候选降级/重试循环里用：计费域异常（402 等）不能被当成模型失败吞掉。

    用法：``except Exception as exc: quota.rethrow_billing_error(exc)`` 放在
    ``except`` 的第一行。降级链只该处理「模型失败」，余额不足要让用户看到 402，
    而不是悄悄回落到 mock/占位文案。
    """
    if isinstance(exc, billing.BillingError):
        raise exc


def _warn_override_unavailable_once() -> None:
    global _warned_missing_overrides
    if _warned_missing_overrides:
        return
    _warned_missing_overrides = True
    logger.warning(
        "quota_overrides 表不可用（未跑 0031 迁移），本次只按全局默认/env 计算额度；"
        "上线前必须运行 `alembic upgrade head`。",
    )


def _effective_limits(
    feature: str, user_id: str | None = None
) -> tuple[int, str, int, int | None]:
    """``quota_config.effective_limit`` 的运行时包装：覆盖表不可用时 fail-open。

    运行时（AI 请求）不能因为「升级顺序」把翻译/查词整条链路打死，所以缺表时
    只按默认层（全局默认 > env）继续并记一次 WARNING；管理 API 走
    ``quota_config`` 的严格版本（503）。非用户主体（ops/sponsored）不使用用户
    覆盖，按无 user_id 解析。
    """
    if user_id and ledger.is_ops_subject(user_id):
        user_id = None
    try:
        return quota_config.effective_limit(feature, user_id)
    except quota_config.QuotaConfigUnavailable as exc:
        _warn_override_unavailable_once()
        logger.debug("用户额度覆盖不可用，只按默认层继续：%s", exc)
        limit, source = quota_config.default_limit(feature)
        return limit, source, limit, None


def limit_for(feature: str, user_id: str | None = None) -> int:
    """某功能对某用户的**生效**每日额度（0 = 关闭该功能）；上限的唯一来源。

    解析顺序：单用户覆盖 > 后台全局默认（``app_settings.ai_quota_defaults``）>
    ``config.AI_DAILY_QUOTA_*``（见 ``quota_config.effective_limit``）。
    ``user_id=None`` 保留旧调用签名（只看默认层）；覆盖表未迁移时运行时只按
    默认层继续（fail-open），不抛异常。
    """
    if feature not in KNOWN_FEATURES:
        raise ValueError(f"未知 AI 功能：{feature!r}（见 ai.ledger.KNOWN_FEATURES）")
    limit, _source, _default, _override = _effective_limits(feature, user_id)
    return limit


def ops_limit_for(feature: str) -> int:
    """非用户主体（ops/sponsored）的独立日配额；0 = 不设功能级上限。

    与 :func:`limit_for` 的 0 语义不同（用户 0 = 关闭该功能，ops 0 = 不限），
    因为 ops 的成本闸是全局日预算（``AI_DAILY_BUDGET_GLOBAL_USD``），不是
    用户免费额度。见 ``config.AI_OPS_DAILY_QUOTA``。
    """
    if feature not in KNOWN_FEATURES:
        raise ValueError(f"未知 AI 功能：{feature!r}（见 ai.ledger.KNOWN_FEATURES）")
    limits = getattr(config, "AI_OPS_DAILY_QUOTA", None) or {}
    try:
        return max(0, int(limits.get(feature, 0) or 0))
    except (AttributeError, TypeError, ValueError):
        return 0


def snapshot(user_id: str | None, feature: str, day: str | None = None) -> dict:
    """权威配额快照（读侧唯一入口）：used 取 ``ai_quota``，limit 取三层解析。

    返回 ``{subject, feature, day, used_units, limit_units, remaining,
    limit_source, default_limit, override_limit, audit_limit_units, independent}``：

    - 用户主体：``limit_units = limit_for(feature, user_id)``（覆盖 > 全局默认
      > env）；``limit_source`` ∈ ``user_override`` / ``default`` / ``config``，
      ``default_limit`` 是默认层值，``override_limit`` 是覆盖值（无则 ``None``）；
    - 非用户主体：``limit_units = ops_limit_for(feature)``，0 时返回 ``None``
      （表示不设功能级上限）；``limit_source`` 仍是 ``config``（独立配额来自
      ``AI_OPS_DAILY_QUOTA``），``default_limit`` 等于该独立配额；
    - ``audit_limit_units`` 是 ``ai_quota.limit_units`` 审计快照，只供排查，
      不参与任何判定；
    - 未迁移/读库失败按 0 已用处理（这是展示接口，不能把页面打死）；用户覆盖
      表未迁移时只按默认层展示（运行时 fail-open，管理 API 另行 503）。
    """
    if feature not in KNOWN_FEATURES:
        raise ValueError(f"未知 AI 功能：{feature!r}（见 ai.ledger.KNOWN_FEATURES）")
    resolved_day = day or ledger.day_of()
    independent = ledger.is_ops_subject(user_id)
    if independent:
        limit = ops_limit_for(feature)
        limit_source = "config"
        default_limit: int | None = limit
        override_limit: int | None = None
    else:
        limit, limit_source, default_limit, override_limit = _effective_limits(
            feature, user_id
        )
    unlimited = independent and limit <= 0

    used = 0
    audit_limit: int | None = None
    if user_id:
        try:
            usage = ledger.daily_usage(user_id, feature, resolved_day)
        except Exception:  # noqa: BLE001 - 展示接口 fail-open
            usage = None
        quota_row = usage.get("quota") if isinstance(usage, dict) else None
        if isinstance(quota_row, dict):
            try:
                used = int(quota_row.get("used_units") or 0)
            except (TypeError, ValueError):
                used = 0
            audit_limit = quota_row.get("limit_units")
    return {
        "subject": user_id,
        "feature": feature,
        "day": resolved_day,
        "used_units": used,
        "limit_units": None if unlimited else limit,
        "remaining": None if unlimited else max(0, limit - used),
        "limit_source": limit_source,
        "default_limit": default_limit,
        "override_limit": override_limit,
        "audit_limit_units": audit_limit,
        "independent": independent,
    }


def _float_config(attr: str) -> float:
    try:
        return max(0.0, float(getattr(config, attr, 0) or 0))
    except (TypeError, ValueError):
        return 0.0


def ensure_within_budget(user_id: str | None, day: str | None = None) -> None:
    """第二、三层预算硬闸：超限抛 ``BudgetExceeded``（0 = 该层不启用）。

    非用户主体（ops/sponsored）跳过用户日预算，只查全局日预算——它们没有
    用户余额/用户额度，成本由全局预算兜底。

    调用前请确保当日账本可用；表未迁移时 sqlite 错误由
    ``check_and_consume_quota`` 统一 fail-open。
    """
    day = day or ledger.day_of()

    user_limit = _float_config("AI_DAILY_BUDGET_USER_USD")
    if user_id and not ledger.is_ops_subject(user_id) and user_limit > 0:
        spend = ledger.daily_spend(user_id, day)
        # 飞书 P1（M5，specs/035）：日预算跨过 50/80/100% 时告警（每档每天一次）；
        # 告警不改变 429 语义，也不抛异常。
        alerts.check_budget_threshold("user", spend, user_limit, day=day)
        if spend >= user_limit:
            raise BudgetExceeded(
                "user", day=day, spend_usd=spend, limit_usd=user_limit, user_id=user_id
            )

    global_limit = _float_config("AI_DAILY_BUDGET_GLOBAL_USD")
    if global_limit > 0:
        spend = ledger.global_daily_spend(day)
        alerts.check_budget_threshold("global", spend, global_limit, day=day)
        if spend >= global_limit:
            raise BudgetExceeded("global", day=day, spend_usd=spend, limit_usd=global_limit)


def _is_missing_db_error(exc: BaseException) -> bool:
    """库/表尚未初始化（升级顺序问题），调用方应 fail-open。"""
    message = str(exc).lower()
    return "no such table" in message or "数据库文件不存在" in str(exc)


def _warn_missing_tables_once() -> None:
    global _warned_missing_tables
    if _warned_missing_tables:
        return
    _warned_missing_tables = True
    logger.warning(
        "ai_usage/ai_quota 表不可用（未初始化数据库或未跑 0003_cost_ledger "
        "迁移），AI 配额与预算本次跳过；上线前必须运行 `alembic upgrade head`。"
    )


def _fail_open_result(feature: str, units: int, day: str | None, lang: str) -> dict:
    return {
        "allowed": True,
        "anonymous": False,
        "enforced": False,
        "feature": feature,
        "day": day or ledger.day_of(),
        "used_units": None,
        "limit_units": None,
        "remaining": None,
        "limit_source": None,
        "default_limit": None,
        "override_limit": None,
        "units": max(1, int(units)),
        "target_lang": lang,
    }


def _check_ops_budget(day: str) -> None:
    """非用户主体只受全局日预算约束（用户预算与余额都跳过）。"""
    ensure_within_budget(None, day)


def _consume_ops_quota(
    subject: str,
    feature: str,
    units: int,
    *,
    day: str | None,
    target_lang: str,
) -> dict:
    """ops/sponsored 主体：独立配额（可选）+ 全局预算；不写用户行、不查余额。"""
    resolved_day = day or ledger.day_of()
    try:
        _check_ops_budget(resolved_day)
        limit = ops_limit_for(feature)
        if limit <= 0:
            return {
                "allowed": True,
                "anonymous": False,
                "ops": True,
                # 只查了全局预算；没有功能级独立配额时 enforced 取决于全局预算是否开启。
                "enforced": _float_config("AI_DAILY_BUDGET_GLOBAL_USD") > 0,
                "feature": feature,
                "day": resolved_day,
                "used_units": None,
                "limit_units": None,
                "remaining": None,
                "limit_source": "config",
                "default_limit": limit,
                "override_limit": None,
                "units": max(1, int(units)),
                "target_lang": target_lang,
            }
        result = ledger.check_and_consume_quota(
            subject,
            feature,
            units,
            limit=limit,
            day=resolved_day,
            target_lang=target_lang,
        )
        result["ops"] = True
        result["enforced"] = True
        result["limit_source"] = "config"
        result["default_limit"] = limit
        result["override_limit"] = None
        return result
    except sqlite3.OperationalError as exc:
        if not _is_missing_db_error(exc):
            raise
        _warn_missing_tables_once()
        return {**_fail_open_result(feature, units, resolved_day, target_lang), "ops": True}


def ensure_quota_available(
    user_id: str | None,
    feature: str,
    *,
    day: str | None = None,
    target_lang: str | None = None,
) -> dict:
    """只做闸门检查、**不扣减**（P2-34 多批累计单位用）。

    多批一次生成时，单位按累计内容量分配给前面的批；后续批落在已购单位内
    （新增单位为 0），不再扣减。但「0 = 关闭该功能」、日预算耗尽、并发下别的
    请求已把额度用光这三种情况仍必须拦住，所以这类批调用本函数走同源判定：
    日预算 → 功能日配额 ``remaining <= 0`` → 429（文案/字段与扣减路径一致）。
    余额 402 已由真正购买单位的批检查，这里不再重复预检。

    表未初始化时与 ``check_and_consume_quota`` 一样 fail-open（记日志、放行）。
    返回形状与扣减路径兼容，``units=0``、``used_units`` 不变。
    """
    if feature not in KNOWN_FEATURES:
        raise ValueError(f"未知 AI 功能：{feature!r}（见 ai.ledger.KNOWN_FEATURES）")
    resolved_lang = languages.normalize_code(target_lang) or languages.DEFAULT_TARGET_LANG
    resolved_day = day or ledger.day_of()
    if not user_id:
        return {
            "allowed": True,
            "anonymous": True,
            "enforced": False,
            "feature": feature,
            "day": resolved_day,
            "used_units": None,
            "limit_units": None,
            "remaining": None,
            "limit_source": None,
            "default_limit": None,
            "override_limit": None,
            "units": 0,
            "target_lang": resolved_lang,
        }

    try:
        if ledger.is_ops_subject(user_id):
            _check_ops_budget(resolved_day)
        else:
            ensure_within_budget(user_id, resolved_day)
        snap = snapshot(user_id, feature, resolved_day)
        remaining = snap["remaining"]
        if remaining is not None and remaining <= 0:
            # 0 = 关闭功能时 remaining 也是 0：必须在调用模型前拦住。
            raise QuotaExceeded(
                feature,
                day=resolved_day,
                used_units=snap["used_units"],
                limit_units=snap["limit_units"],
                units=0,
                user_id=user_id,
            )
        return {**snap, "allowed": True, "enforced": True, "units": 0, "target_lang": resolved_lang}
    except sqlite3.OperationalError as exc:
        if not _is_missing_db_error(exc):
            raise
        _warn_missing_tables_once()
        return {
            "allowed": True,
            "anonymous": False,
            "enforced": False,
            "feature": feature,
            "day": resolved_day,
            "used_units": None,
            "limit_units": None,
            "remaining": None,
            "limit_source": None,
            "default_limit": None,
            "override_limit": None,
            "units": 0,
            "target_lang": resolved_lang,
        }


def check_and_consume_quota(
    user_id: str | None,
    feature: str,
    units: int = 1,
    *,
    day: str | None = None,
    target_lang: str | None = None,
) -> dict:
    """三层硬闸入口：预算检查 → 功能日配额原子扣减；超限抛 ``QuotaExceeded``。

    ``user_id=None``（脚本/旧调用）直接放行且不写库；正常 API 请求会传登录
    用户 id 或游客 ``guest:<sha256>``（M1 ⑧，见 storage.active_identity），
    游客同样受日配额/预算约束。**非用户主体**（``ops:`` / ``sponsored:``）
    走独立分支：不查余额（无 402）、不写用户 ``ai_quota``，只受独立配额
    （``AI_OPS_DAILY_QUOTA``）与全局日预算约束（P0-05 预热主体）。表/数据库
    尚未初始化（``no such table`` 或 ``数据库文件不存在``）时 fail-open：记一次
    WARNING 并放行，避免升级顺序问题或「游客先于首个注册到达」把翻译/查词整条
    链路打死；上线前必须迁移。

    ``target_lang`` 只随结果/账本记录，**不拆限额**（P0 仍按
    ``(user_id, day, feature)`` 计数，见规格 §5.5「成本与配额」）。

    M3a 起在扣日配额/预算**之前**先做一次余额可用性预检查（402）：余额连「输出
    上界 × 候选链最高价」都付不起时直接 402，避免先扣掉日额度却调用不了模型。
    余额为 0 且配额也用尽时优先返 402（用户可行动）；全站预算仍是 429（系统保护）。

    P0-05：功能配额上限由 ``limit_for(feature, user_id)`` 的三层解析决定
    （单用户覆盖 > 后台全局默认 > config，specs/047），且**显式**传给
    ``ledger.check_and_consume_quota(limit=...)``，保证判定/报错/审计快照同源；
    ``ai_quota.limit_units`` 只是审计快照，不再参与判断。返回结果额外带
    ``limit_source`` / ``default_limit`` / ``override_limit``。
    """
    resolved_lang = languages.normalize_code(target_lang) or languages.DEFAULT_TARGET_LANG

    if not user_id:
        return ledger.check_and_consume_quota(
            user_id, feature, units, day=day, target_lang=resolved_lang
        )

    if ledger.is_ops_subject(user_id):
        return _consume_ops_quota(
            user_id, feature, units, day=day, target_lang=resolved_lang
        )

    # 402 先于 429：余额可用性（不写库、不占 hold；未迁移/无价模型直接放行）。
    try:
        billing.ensure_affordable(
            user_id, feature, model_ids=degradation_chain(feature)
        )
    except billing.InsufficientBalance:
        raise
    except billing.BillingUnavailable:
        logger.debug("计费表未就绪，跳过余额预检查（按旧行为继续）。")
    except sqlite3.OperationalError as exc:
        logger.debug("余额预检查读库失败（按旧行为继续）：%s", exc)

    try:
        ensure_within_budget(user_id, day)
        # 先解析生效额度（覆盖 > 全局默认 > env），再显式传给账本：判定、429
        # 文案与审计快照都用同一个 limit，避免多进程/多层配置出现两套上限。
        limit, limit_source, default_limit, override_limit = _effective_limits(
            feature, user_id
        )
        result = ledger.check_and_consume_quota(
            user_id,
            feature,
            units,
            limit=limit,
            day=day,
            target_lang=resolved_lang,
        )
        result["enforced"] = True
        result["limit_source"] = limit_source
        result["default_limit"] = default_limit
        result["override_limit"] = override_limit
        return result
    except sqlite3.OperationalError as exc:
        if not _is_missing_db_error(exc):
            raise
        _warn_missing_tables_once()
        return _fail_open_result(feature, units, day, resolved_lang)


# ---------------------------------------------------------------------------
# 降级链
# ---------------------------------------------------------------------------

def is_domestic_region() -> bool:
    """当前部署是否按「大陆」口径选模型。

    ``AI_MODEL_REGION``：``cn`` 强制大陆；``global`` 强制海外；``auto``（默认）
    按默认模型判断——``DEFAULT_MODEL`` 是 Google 模型才视为海外。
    """
    mode = str(getattr(config, "AI_MODEL_REGION", "auto") or "auto").lower()
    if mode == "cn":
        return True
    if mode == "global":
        return False
    spec = config.MODEL_CATALOG.get(config.DEFAULT_MODEL, {})
    return spec.get("provider") != "Google"


def _provider(model_id: str) -> str:
    spec = config.MODEL_CATALOG.get(model_id, {})
    return str(spec.get("provider") or "unknown")


def _price_rank(model_id: str) -> float:
    """排序用的单价水平：目录 in + out（USD / 1M tokens；未知按最贵）。"""
    in_price, out_price = ledger.price_for(model_id)
    return in_price + out_price


def _first_available_key(model_id: str) -> tuple[int, float, str]:
    """默认模型不可用时挑种子：大陆口径优先非 Google，再按价格从低到高。"""
    domestic_penalty = 0
    if is_domestic_region() and _provider(model_id) == "Google":
        domestic_penalty = 1
    return (domestic_penalty, _price_rank(model_id), model_id)


def degradation_chain(
    feature: str | None = None, preferred_model: str | None = None
) -> list[str]:
    """按「首选 → 同 provider 更便宜 → 另一个可用 provider」返回模型 id 列表。

    ``feature`` 仅作调用方语义标注（不同功能可传入不同首选模型）；链的组成
    完全由 ``preferred_model`` / ``DEFAULT_MODEL``、Key 可用性与价格决定。
    返回空列表表示当前一个可用模型都没有（调用方应走 mock/规则兜底）。

    M7a 严格计费：自动候选只收「有可核实单价」的模型（``llm.is_usable``），
    缺价模型不会因为免费而混进降级链。**用户显式选择**的缺价模型仍放在链首，
    由 ``llm._billing_begin`` 返回 503 ``model_unpriced``（不静默换模型）。
    """
    catalog = config.MODEL_CATALOG
    available = [model_id for model_id in catalog if llm.is_usable(model_id)]
    explicit_unpriced: str | None = None
    if (
        preferred_model
        and preferred_model in catalog
        and llm.is_available(preferred_model)
        and preferred_model not in available
    ):
        explicit_unpriced = preferred_model

    # P2-27: an explicitly selected model that is available *and priced* must
    # lead the chain. Previously only the unpriced case was honoured, so the
    # default (deepseek-chat) silently won over the user's Qwen selection and
    # every ledger row was written against the default model.
    current: str | None = None
    if preferred_model and preferred_model in available:
        current = preferred_model
    if current is None:
        current = explicit_unpriced
    if current is None and config.DEFAULT_MODEL in available:
        current = config.DEFAULT_MODEL
    if current is None and available:
        current = min(available, key=_first_available_key)
    if current is None:
        return []

    chain = [current]
    current_provider = _provider(current)
    current_rank = _price_rank(current)

    # 1) 同 provider 更便宜的模型（价格从低到高）。
    same_provider_cheaper = [
        model_id
        for model_id in available
        if model_id != current
        and _provider(model_id) == current_provider
        and _price_rank(model_id) < current_rank
    ]
    chain.extend(
        sorted(same_provider_cheaper, key=lambda model_id: (_price_rank(model_id), model_id))
    )

    # 2) 另一个可用 provider；大陆口径排除 Google（Gemini 不进默认降级链）。
    domestic = is_domestic_region()
    other_providers = [
        model_id
        for model_id in available
        if _provider(model_id) != current_provider
        and not (domestic and _provider(model_id) == "Google")
    ]
    chain.extend(sorted(other_providers, key=lambda model_id: (_price_rank(model_id), model_id)))

    # 去重且保持顺序（防止同名 provider 配置重复）。
    return list(dict.fromkeys(chain))


__all__ = [
    "BLOCKS_PER_UNIT",
    "BudgetExceeded",
    "PARAGRAPHS_PER_UNIT",
    "QuotaExceeded",
    "check_and_consume_quota",
    "degradation_chain",
    "ensure_quota_available",
    "ensure_within_budget",
    "is_domestic_region",
    "limit_for",
    "ops_limit_for",
    "rethrow_billing_error",
    "snapshot",
    "units_for_blocks",
    "units_per_batch",
]
