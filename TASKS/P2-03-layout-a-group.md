# P2-03 A 组桌面布局（能力/考试/定位）

- status: claimed
- owner: {implementer: layout-a-impl, reviewer: lead, integrator: lead}
- base_sha: d13e70b

## goal
把 `AbilityScreen`、`ExamScreen`、`PlacementScreen` 从 672px 单列迁到 `PageContainer variant="standard"` + `PageGrid`：≥xl 两栏（主内容 + 侧栏），1440 内容 ≥1100，1920 容器 1280；375 单栏。

## non_goals
- 不改数据/接口/交互逻辑
- 不改视觉语言/颜色
- 不动其他页面（P2-04/P2-05）

## write_scope
- `frontend/src/components/AbilityScreen.tsx`
- `frontend/src/components/ExamScreen.tsx`
- `frontend/src/components/PlacementScreen.tsx`
- `scripts/p2-03-layout-acceptance.mjs`（新建）
- `docs/设计-桌面布局规范.md`（回填状态）

## read_only
- `docs/设计-桌面布局规范.md`、`docs/reports/desktop-layout-audit-2026-11-23.md`、`frontend/src/components/layout/*`

## acceptance
1. 三页用 `PageContainer standard` + `PageGrid`；≥xl 两栏（左侧主内容 2fr，右侧 SideRail/说明/操作）；1440 内容 ≥1100；1920 容器 1280。
2. 375 单栏无溢出；数据/交互/testid 不变；review UI 暂停行为不变。
3. 页头/卡 padding/间距与周报样板一致；无新颜色字面量；G1=0。
4. `tsc/build/i18n/gate`；新 Playwright 脚本断言三页宽度/双栏/375；截图 `/tmp/p2-03-*.png`。
5. 不改 App.tsx；共享文件由 lead 合入。

## deps
- P2-02（已完成）

## rollback
revert；纯前端。
