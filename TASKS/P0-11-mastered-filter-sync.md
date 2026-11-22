# P0-11 同步 mastered-filter 验收脚本

- status: claimed
- owner: {implementer: sync3-impl, reviewer: lead, integrator: lead}
- base_sha: d80a0dd

## goal
`scripts/mastered-filter-acceptance.mjs` 仍找 `vocab-mine-master-f1`（已删除的展开区文字动作）。按 P0-10 新交互改为行内对勾测试并跑绿。

## non_goals
- 不改应用/后端；不改其他脚本

## write_scope
- `scripts/mastered-filter-acceptance.mjs`

## read_only
- `TASKS/P0-10`、`specs/005`、当前 VocabularyRows/Book 对勾实现

## acceptance
1. 测试「我的收藏」行内对勾：点对勾 → PATCH mastered；行底色变绿/从列表移出（按该脚本原场景）；展开区无文字「已掌握」。
2. 保留该脚本原有筛选/隐藏中文/游客断言；未收藏/已收藏/已掌握三态不回归。
3. 脚本跑 2 次全 PASS，报告 assertions 数。

## deps
- P0-10（已完成）

## rollback
revert；仅脚本。
