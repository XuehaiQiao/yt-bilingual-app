# P0-06 治理机制硬化（机器门禁，不靠自觉）

- status: claimed
- owner: {implementer: gov-impl, reviewer: lead, integrator: lead}
- base_sha: 3c270d4

## goal
把「工作流文档」升级为**机器可执行的门禁**：任务板、写域 preflight、契约/Flag 检查、AGENTS 启动协议、pre-commit hook、CI 接入与脚本测试。

## non_goals
- 不引入新依赖/框架；不改业务代码/前端 UI
- 不做 GitHub 分支保护（需管理员）；不实现 OpenAPI 自动生成（P1）
- 不改变 P0-01…05 的卡内容

## write_scope
- `TASKS/board.json`（新建）
- `scripts/agent-preflight.mjs`（新建）
- `scripts/check-task-board.mjs`（新建）
- `scripts/check-contracts.mjs`（新建）
- `scripts/install-hooks.mjs`（新建）
- `.githooks/pre-commit`（新建）
- `scripts/tests/governance.test.mjs`（新建）
- `AGENTS.md`
- `.github/workflows/ci.yml`
- `docs/多agent协作工作流.md`（更新“已落地/待建”状态）
- `TASKS/README.md`

## read_only
- `ARCHITECTURE.md`、`OWNERS.md`、`CONTRACTS/**`、`docs/data-map.md`

## acceptance
1. `node scripts/check-task-board.mjs`：卡文件存在、ID 唯一、依赖无环、状态合法；失败退出 1。
2. `node scripts/agent-preflight.mjs --card P0-06`：当前 diff 白名单通过；故意改 `frontend/src/App.tsx` 时报「共享文件需 --as-integrator」；改白名单外文件时报错退出 1。
3. `node scripts/agent-preflight.mjs --card P0-06 --as-integrator` 允许共享文件。
4. 活跃卡写域交集拒绝：模拟两张 ready 卡同改一文件 → 失败并提示冲突卡。
5. `node scripts/check-contracts.mjs`：schemas JSON 合法；flags 注册表必填字段/重复/过期检查；代码中出现未登记 `ff.*` 报警。
6. `node --test scripts/tests` 全绿；CI 新增 `governance` job 跑上述三脚本 + tests。
7. `AGENTS.md` 顶部有「开工前 5 步 + 无卡不开工 + preflight 命令」；`scripts/install-hooks.mjs` 可安装 `.githooks/pre-commit`（无 `TASK_ID` 且无 `GOVERNANCE_BYPASS=1` 时拒绝提交）。
8. 不改变现有 tsc/build/pytest 行为；`node scripts/gate-receipt.mjs` 仍可运行。

## deps
- 无（先于其余 P0 合并）

## rollback
revert merge；新增脚本/钩子，不改业务数据。
