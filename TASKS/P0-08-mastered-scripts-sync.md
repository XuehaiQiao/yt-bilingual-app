# P0-08 同步「已掌握」验收脚本

- status: claimed
- owner: {implementer: sync2-impl, reviewer: lead, integrator: lead}
- base_sha: e9fb59f

## goal
P0-01/02/03 后，`mastered-tab-acceptance.mjs` 仍按旧模型（已掌握词同时留在收藏、撤销回填我的单词、已掌握行从收藏取释义）断言。更新到新契约并跑绿。

## non_goals
- 不改应用/后端
- 不放宽断言；旧行为应断言不存在

## write_scope
- `scripts/mastered-tab-acceptance.mjs`
- `scripts/mastered-filter-acceptance.mjs`（如失败）

## read_only
- `ADR/0001`、`docs/data-map.md`、`TASKS/P0-03`、`specs/005` 已掌握段

## acceptance
1. fixtures：我的单词不含已掌握词（favorites 只有 luminous）；已掌握列表 60 条，词条无收藏→释义按 `definition` 快照，缺失显示 `—`（不再从 favorite 取）。
2. 断言：已掌握星标禁用；撤销后该词**不回到**我的单词、计数不变；已掌握仍从 `GET /api/review/words?mastered=1` 驱动。
3. 两个脚本各跑 2 次全 PASS，报告 assertions 数；375 截图保留。
4. 如 `mastered-filter-acceptance.mjs` 仍绿则只改 mastered-tab。

## deps
- P0-01、P0-02、P0-03（已完成）

## rollback
revert；仅脚本。
