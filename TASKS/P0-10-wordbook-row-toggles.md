# P0-10 单词本行内开关与配色

- status: pending（等 P0-09 释放同文件）
- owner: {implementer: TBD, reviewer: lead, integrator: lead}
- base_sha: 5591fea

## goal
按负责人 2026-11-22 新交互：
1) 「我已掌握」只保留**对勾图标**开关（无文字，不再有展开区文字动作）；
2) 对勾与星标**并列显示在默认词条行**（所有词表）；
3) tab「我的单词」显示名改为「**我的收藏**」；
4) 固定词表（内置/短语/自定义）中：**已掌握行底色绿色、收藏行底色黄色**，两者互斥（已掌握优先）。

## non_goals
- 不改路由 `#/app/<tab>/vocabulary`、不改收藏/掌握 API
- 不改「我的收藏」「已掌握」两个列表的整体语义
- 不引入新颜色字面量（只用 design token）

## write_scope
- `frontend/src/components/VocabularyBookScreen.tsx`
- `frontend/src/components/VocabularyRows.tsx`
- `frontend/src/i18n/zh-CN.json`
- `frontend/src/i18n/vi-VN.json`
- `scripts/wordbook-v12-acceptance.mjs`
- `scripts/custom-wordlists-acceptance.mjs`
- `scripts/mastered-tab-acceptance.mjs`
- `specs/005-favorites-export/spec.md`

## read_only
- `docs/设计语言.md`（semantic tokens）
- `ADR/0001`、`TASKS/P0-03`、`TASKS/P0-09`

## acceptance
1. 所有词表默认行：… / 等级 / 星标 / **对勾**；对勾 icon-only（ghost icon，44px 热区），`aria-label` 有「已掌握/取消已掌握」，点击发 PATCH mastered；已掌握时实心/勾选态。
2. 展开区不再有「我已掌握/已掌握」文字按钮；也不再有「加入我的单词」（P0-09）。
3. tab 显示名 zh「我的收藏」、vi 对应翻译；页面标题/计数/copy 一致；路由不变。
4. 固定词表（CEFR/GRE/CET4/CET6、短语、自定义词表）行底色：已掌握 `bg-success/10`、收藏 `bg-warning/10`；无状态默认；互斥时已掌握优先；不改变行高/对齐；1440/375 无溢出。
5. 计数仍=收藏列表长度；已掌握计数=服务端列表长度；星标唯一收藏开关。
6. 验收脚本同步（图标 testid、tab 文案、底色 class 断言）；`tsc/build/i18n/gate` 绿。

## deps
- P0-09（同文件，必须串行）

## rollback
revert；纯前端/脚本。
