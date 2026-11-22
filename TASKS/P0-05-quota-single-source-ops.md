# P0-05 配额单源 + ops 预热身份

- status: ready
- owner: {implementer: TBD, reviewer: TBD, tester: TBD, integrator: TBD}
- base_sha: 95f5891

## goal
1) 日配额上限只从 config 读；`ai_quota.limit_units` 仅审计快照，不再参与判断。
2) 预热/运维脚本使用 `ops:`/sponsored 计费身份，不消耗用户配额与余额；成本仍可审计。
3) 修复「预热 374 次把用户当天分析额度打满」的因果链。

## non_goals
- 不改用户余额结算逻辑；不新增付费层级
- 不改各 feature 默认值（只改上限来源与主体）

## write_scope
- `backend/ai/ledger.py`
- `backend/ai/quota.py`
- `backend/config.py`
- `backend/billing.py`（主体识别，如需要）
- `backend/teaching_analysis.py`（传入 subject）
- `scripts/warm_library_analysis.py`
- `backend/tests/test_quota*.py` / `test_balance*.py`

## read_only
- `CONTRACTS/schemas/error.json`
- `docs/data-map.md`
- `specs/028`

## acceptance
1. 同一 user 当天：预热进程 `AI_DAILY_QUOTA_ANALYSIS=400` 后，正常进程按 30 判断；日志/响应不再出现 374/30 与 374/400 两套数（行内 `limit_at_consume` 仅审计）。
2. 预热写入 `ai_usage` 的 `billable=false` + `billing_status='ops_warm'`（或主体字段），不写入用户 `ai_quota`。
3. 用户分析配额只统计用户自己的调用；ops 成本可在管理台按主体查询。
4. 单测：上限变更不影响历史行；ops 消耗不占用户额度；用户超限 429 带结构化字段；余额不足仍 402。
5. `pytest` 全量；`py_compile`；写一条运维说明（README/部署文档）。

## deps
- 无（P0-04 依赖本卡）

## rollback
迁移/字段变更需可回滚；脚本参数向后兼容（旧 `--user-id` 仍可运行，默认 ops 主体 + 显式确认）。
