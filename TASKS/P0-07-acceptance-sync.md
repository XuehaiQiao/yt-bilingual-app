# P0-07 同步验收脚本与 specs/005

- status: claimed
- owner: {implementer: sync-impl, reviewer: lead, integrator: lead}
- base_sha: e97141d

## goal
P0-01/P0-02/P0-03 改变了计数与词表动作语义，旧验收脚本与 specs/005 仍在断言旧行为。更新到新契约并跑绿。

## non_goals
- 不改应用代码、不改后端
- 不放宽断言为空断言；未实现的行为应断言“不存在”

## write_scope
- `scripts/wordbook-v12-acceptance.mjs`
- `scripts/custom-wordlists-acceptance.mjs`
- `specs/005-favorites-export/spec.md`

## read_only
- `ADR/0001`、`docs/data-map.md`、`TASKS/P0-03`、当前 VocabularyBookScreen/VocabularyRows

## acceptance
1. fixtures 改为「我的单词 60 + 已掌握 10，互不重叠」；所有计数按收藏列表长度（60/59/58…），不再用减法。
2. 我的单词：删除展开区「取消收藏」相关断言（该入口应不存在）；星标是唯一取消入口。
3. 词表/短语/自定义：已收藏时「加入我的单词」**不存在**；未收藏时点击后消失；幂等只发一次请求。
4. 已掌握星标禁用断言保留。
5. `specs/005` 更新：展开区不再有「取消收藏」；词表行已收藏不显示「加入我的单词」；计数=收藏列表长度。
6. 两个脚本各跑 2 次全 PASS；报告 assertions 数。不许注释掉整段来“通过”。

## deps
- P0-01、P0-02、P0-03（已完成）

## rollback
revert merge；仅脚本/文档。
