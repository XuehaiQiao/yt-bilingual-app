# P2-02 桌面布局基础组件 + 周报样板

- status: claimed
- owner: {implementer: layout-impl, reviewer: lead, integrator: lead}
- base_sha: 0e5957b

## goal
按 `docs/设计-桌面布局规范.md` 先建共享布局件，并把「周报」迁移成样板页；后续批次只复用组件，不再逐页写 `max-w-*`。

## non_goals
- 不改视觉语言/配色/移动端结构
- 不迁移其他页面（P2-03 起）
- 不改后端/数据

## write_scope
- `frontend/src/components/layout/PageContainer.tsx`（新建）
- `frontend/src/components/layout/PageGrid.tsx`（新建）
- `frontend/src/components/layout/SideRail.tsx`（新建）
- `frontend/src/components/layout/ReadingLayout.tsx`（新建；本卡先建 API，阅读页 P2-04 接入）
- `frontend/src/components/ReportScreen.tsx`
- `frontend/tailwind.config.*`（如需 maxWidth token）
- `frontend/src/components/README.md`
- `scripts/p2-02-layout-acceptance.mjs`（新建，Playwright 宽度/双栏断言）
- `docs/设计-桌面布局规范.md`（回填实现状态）

## read_only
- `docs/设计-桌面布局规范.md`、`docs/reports/desktop-layout-audit-2026-11-23.md`、`components/ui/PageHeader.tsx`

## acceptance
1. `PageContainer` variants: `wide|standard|reading|marketing|focused`，统一 padding；`PageGrid` ≥xl 双栏（`minmax(0,1fr) 20rem`）；`SideRail` 320px sticky；`ReadingLayout` 正文 68ch + rail。
2. 周报：`standard` 容器，≥xl 两栏（左事实/数字/证据，右侧解释/下一步）；1440 内容 ≥1100px；1920 居中 1280 内；375 单栏无溢出。
3. 视觉：页头/卡 padding/间距沿用现有 token；不新增颜色字面量；`gate-receipt` G1=0。
4. 现有周报数据/交互/testid 不变；无 review 数字回归。
5. `tsc/build/i18n/gate` 绿；`scripts/p2-02-layout-acceptance.mjs` 断言 1440/1920 宽度与双栏、375 单栏；截图 `/tmp/p2-02-*.png`。
6. 不改 App.tsx；如需共享文件交 lead。

## deps
- 无（规范已批准）

## rollback
revert；纯前端 + 文档。
