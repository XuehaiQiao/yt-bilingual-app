# P0-12 澄清「已掌握」开关的视觉语义

- status: claimed
- owner: {implementer: toggle-impl, reviewer: lead, integrator: lead}
- base_sha: 8d2b3d8

## goal
当前未掌握词的开关只是一个裸对勾（`Check`），看起来像“文字/标签”而不是可点击开关，语义有歧义。改成与星标一致的**双态开关**：

- **未掌握**：空心圆 + 勾（中性灰，hover 有反馈）→ 看起来是“可点击”的开关
- **已掌握**：实心/绿底圆 + 勾（`success` token）→ 看起来是“已选中”状态
- 两种状态共用同一外形（圆 + 勾），只靠填充/颜色区分，不再用裸勾。

## non_goals
- 不改星标逻辑、不改计数、不改行底色规则
- 不改后端/路由
- 不新增颜色字面量（token only）

## write_scope
- `frontend/src/components/VocabularyRows.tsx`
- `frontend/src/i18n/zh-CN.json`（如需文案）
- `frontend/src/i18n/vi-VN.json`
- `scripts/wordbook-v12-acceptance.mjs`
- `scripts/mastered-tab-acceptance.mjs`
- `scripts/mastered-filter-acceptance.mjs`
- `specs/005-favorites-export/spec.md`

## read_only
- `docs/设计语言.md`、`TASKS/P0-10`

## acceptance
1. 未掌握：圆形空心（`border-line`）+ 中性勾；已掌握：绿色填充/浅绿底 + 绿色勾；同一 glyph 外形。
2. 44px 热区/`aria-pressed`/aria-label 保留；点击仍 PATCH、失败回滚、行内错误。
3. 已掌握行底色绿色规则不变；星标与对勾并列顺序不变。
4. 骨架/行高不抖动；375/1440 截图。
5. 三个脚本同步（断言形状 class/aria 而非裸勾 svg），各跑 2 次 PASS；`tsc/build/i18n/gate` 绿。
6. specs/005 写明“圆形勾选按钮、未掌握空心、已掌握实心绿”。

## deps
- P0-10（已完成）

## rollback
revert；纯前端/脚本/文档。
