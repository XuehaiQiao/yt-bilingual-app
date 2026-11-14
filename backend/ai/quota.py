"""三层配额（每用户/功能日限额 → 每用户日预算 → 全局日预算）与模型降级链。

配额口径（计划书 §7.4「配额与预算」）：

1. **每用户每功能日限额**：``ai_quota`` 里 ``(user_id, day, feature)`` 的
   ``used_units / limit_units``，原子 UPSERT 递增；免费额度默认值见
   ``config.AI_DAILY_QUOTA_*``（翻译 60 批 ≈ 120 分钟视频、总结 10 次、词典
   200 次、本地剧集 60 批）。
2. **每用户日预算**：``ai_usage`` 当日 SUM ≥ ``AI_DAILY_BUDGET_USER_USD``
   → ``BudgetExceeded``。
3. **全局日预算**：全站当日 SUM ≥ ``AI_DAILY_BUDGET_GLOBAL_USD``
   → ``BudgetExceeded``。

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
import sqlite3

import config
import llm
from ai import ledger
from ai.ledger import KNOWN_FEATURES, QuotaExceeded

logger = logging.getLogger(__name__)

_FEATURE_LIMIT_ATTRS = {
    "translate": "AI_DAILY_QUOTA_TRANSLATE_BATCHES",
    "summary": "AI_DAILY_QUOTA_SUMMARY",
    "define": "AI_DAILY_QUOTA_DEFINE",
    "local_show": "AI_DAILY_QUOTA_LOCAL_SHOW_BATCHES",
}

_warned_missing_tables = False


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


def limit_for(feature: str) -> int:
    """某功能的每日免费额度（0 = 关闭该功能）。"""
    if feature not in KNOWN_FEATURES:
        raise ValueError(f"未知 AI 功能：{feature!r}（见 ai.ledger.KNOWN_FEATURES）")
    attr = _FEATURE_LIMIT_ATTRS[feature]
    try:
        return max(0, int(getattr(config, attr, 0)))
    except (TypeError, ValueError):
        return 0


def _float_config(attr: str) -> float:
    try:
        return max(0.0, float(getattr(config, attr, 0) or 0))
    except (TypeError, ValueError):
        return 0.0


def ensure_within_budget(user_id: str | None, day: str | None = None) -> None:
    """第二、三层预算硬闸：超限抛 ``BudgetExceeded``（0 = 该层不启用）。

    调用前请确保当日账本可用；表未迁移时 sqlite 错误由
    ``check_and_consume_quota`` 统一 fail-open。
    """
    day = day or ledger.day_of()

    user_limit = _float_config("AI_DAILY_BUDGET_USER_USD")
    if user_id and user_limit > 0:
        spend = ledger.daily_spend(user_id, day)
        if spend >= user_limit:
            raise BudgetExceeded(
                "user", day=day, spend_usd=spend, limit_usd=user_limit, user_id=user_id
            )

    global_limit = _float_config("AI_DAILY_BUDGET_GLOBAL_USD")
    if global_limit > 0:
        spend = ledger.global_daily_spend(day)
        if spend >= global_limit:
            raise BudgetExceeded("global", day=day, spend_usd=spend, limit_usd=global_limit)


def check_and_consume_quota(
    user_id: str | None,
    feature: str,
    units: int = 1,
    *,
    day: str | None = None,
) -> dict:
    """三层硬闸入口：预算检查 → 功能日配额原子扣减；超限抛 ``QuotaExceeded``。

    未登录（``user_id=None``）直接放行且不写库（正常 API 都是登录态）。
    表未迁移（``no such table``）时 fail-open：记一次 WARNING 并放行，避免
    升级顺序问题把翻译/查词整条链路打死；上线前必须迁移。
    """
    global _warned_missing_tables

    if not user_id:
        return ledger.check_and_consume_quota(user_id, feature, units, day=day)

    try:
        ensure_within_budget(user_id, day)
        result = ledger.check_and_consume_quota(user_id, feature, units, day=day)
        result["enforced"] = True
        return result
    except sqlite3.OperationalError as exc:
        if "no such table" not in str(exc).lower():
            raise
        if not _warned_missing_tables:
            _warned_missing_tables = True
            logger.warning(
                "ai_usage/ai_quota 表不存在（未跑 0003_cost_ledger 迁移），"
                "AI 配额与预算本次跳过；上线前必须运行 `alembic upgrade head`。"
            )
        return {
            "allowed": True,
            "anonymous": False,
            "enforced": False,
            "feature": feature,
            "day": day or ledger.day_of(),
            "used_units": None,
            "limit_units": None,
            "remaining": None,
            "units": max(1, int(units)),
        }


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
    """
    catalog = config.MODEL_CATALOG
    available = [model_id for model_id in catalog if llm.is_available(model_id)]
    if not available:
        return []

    current: str | None = None
    if (
        preferred_model
        and preferred_model in catalog
        and llm.is_available(preferred_model)
    ):
        current = preferred_model
    if current is None and config.DEFAULT_MODEL in available:
        current = config.DEFAULT_MODEL
    if current is None:
        current = min(available, key=_first_available_key)

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
    "BudgetExceeded",
    "QuotaExceeded",
    "check_and_consume_quota",
    "degradation_chain",
    "ensure_within_budget",
    "is_domestic_region",
    "limit_for",
]
