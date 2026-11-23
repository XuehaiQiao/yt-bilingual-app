# P1-21 管理台「无价格模型」语义修正

- status: claimed
- owner: {implementer: unpriced-impl, reviewer: lead, integrator: lead}
- base_sha: 58a675d

## goal
当前面板把「历史未计费记录」误写成「没有官方价」。改为区分：
- **历史未计费记录**（所选日期内 `unpriced_rows>0` 的模型，价格补齐前产生，不补扣）
- **当前缺价模型**（`billing.price_for_model()` 为 None 的目录模型；现在应为空）

## write_scope
- `backend/billing.py`（summary 增加 `currentUnpricedModels`；保留 `unpricedModels` 兼容=历史）
- `backend/tests/test_balance_billing.py`
- `frontend/src/components/AdminConsoleScreen.tsx`
- `frontend/src/lib/billing.ts`（类型）
- `frontend/src/i18n/zh-CN.json`、`vi-VN.json`

## acceptance
1. 历史列表仍按 `unpriced_rows` 统计；文案改为「历史未计费记录」+「价格补齐前产生，不会补扣」。
2. 当前缺价列表用 `price_for_model` 计算；Qwen/DeepSeek/Gemini 补价后为空，显示「当前所有目录模型都有价格」。
3. 两个列表均空/仅历史/仅当前三种状态可读；不重算/不改历史 usage。
4. 现有计费测试更新并新增：补价模型不再出现在「当前缺价」但仍在历史列表；`unpricedModels` 兼容字段不变。
5. `pytest` 定向+全量；`tsc/build/i18n/gate`；preflight `--staged`。

## deps
- P1-20（已完成）
