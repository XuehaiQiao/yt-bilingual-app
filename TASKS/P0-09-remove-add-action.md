# P0-09 彻底移除「加入我的单词」动作

- status: claimed
- owner: {implementer: rm-add-impl, reviewer: lead, integrator: lead}
- base_sha: b4e3359

## goal
「加入我的单词」与星标是同一语义的重复开关：星标已在每一行，收藏/取消收藏只应由星标完成。**所有词表、任何状态下都不再渲染「加入我的单词」**（不再有「已加入/disabled」变体）。

## non_goals
- 不改收藏 API/星标行为
- 不改「已掌握」动作
- 不改阅读器/后端

## write_scope
- `frontend/src/components/VocabularyBookScreen.tsx`
- `frontend/src/components/VocabularyRows.tsx`
- `scripts/wordbook-v12-acceptance.mjs`
- `scripts/custom-wordlists-acceptance.mjs`
- `specs/005-favorites-export/spec.md`

## read_only
- `ADR/0001`、`specs/005` 统一词表 UI 段、`TASKS/P0-03`

## acceptance
1. 代码中删除 `mine` row action / `rowAddActions` 的「加入我的单词」分支；词表/短语/自定义词表展开区只剩完整释义、来源、已掌握等，无任何加入收藏按钮。
2. 星标是唯一收藏开关：未收藏点星 → POST + 实心；已收藏点星 → DELETE + 空心；重复点击幂等。
3. 验收脚本：断言「加入我的单词」按钮在未收藏/已收藏两种状态下**都不存在**；删除旧的「已加入」断言；其余动作/计数不回退。
4. `tsc -b`、`build`、`check:i18n`、`gate-receipt` 绿；两个脚本各 2 次 PASS；1440/375 截图。
5. 仅剩无需密钥的 i18n 清理（如有）也由本卡负责。

## deps
- P0-03、P0-07（已完成）

## rollback
revert；纯前端/脚本。
