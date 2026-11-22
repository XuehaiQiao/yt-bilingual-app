# P2-05A 单词本/列表/设置页宽度

- status: claimed
- owner: {implementer: layout-table-impl, reviewer: lead, integrator: lead}
- base_sha: 304ecd2

## goal
按 `docs/设计-桌面布局规范.md`：单词本用 `wide`（表格吃满主区域）；内容发现/阅读列表放宽；练习/我的用 `standard` 两栏/网格；1440 内容 ≥1100。

## write_scope
- `frontend/src/components/VocabularyBookScreen.tsx`
- `frontend/src/components/DiscoverScreen.tsx`
- `frontend/src/components/ReaderScreen.tsx`（仅列表态容器，不动详情阅读布局）
- `frontend/src/components/PracticeScreen.tsx`
- `frontend/src/components/ProfileScreen.tsx`
- `scripts/p2-05a-layout-acceptance.mjs`（新建）

## read_only
- `docs/设计-桌面布局规范.md`、`docs/reports/desktop-layout-audit-2026-11-23.md`、`frontend/src/components/layout/*`

## acceptance
1. 单词本：`PageContainer wide`；1440 表宽 ≥主区域（表格不缩在 1024）；工具栏同宽；375 无溢出。
2. 内容发现/阅读列表：≥1100 或 `standard`；筛选/列表排布不破。
3. 练习/我的：`standard`（1200–1280），卡片 2–3 列；375 单栏。
4. 数据/交互/testid/词族与编辑模式零回归；无新颜色；G1=0。
5. `tsc/build/i18n/gate`；新 Playwright 断言 1440/1920 宽度与 375；截图 `/tmp/p2-05a-*.png`。
6. 不改 i18n/后端/App.tsx；共享文件交 lead。

## deps
- P2-02（已完成）
