# P0-15 编辑态「全选（按当前筛选结果）」

- status: claimed
- owner: {implementer: select-impl, reviewer: lead, integrator: lead}
- base_sha: 4dd27bd

## goal
编辑模式下提供「全选」：一次选中**当前筛选/搜索命中的全部结果**（不只当前页），支持三态表头 checkbox、清除选择、跨页批量操作。

## non_goals
- 不新增后端接口；复用现有分页/搜索参数
- 不改单行 checkbox、批量操作矩阵、退出编辑行为
- 不做反向选择（反选）

## write_scope
- `frontend/src/components/VocabularyBookScreen.tsx`
- `frontend/src/components/VocabularyRows.tsx`
- `frontend/src/i18n/zh-CN.json`
- `frontend/src/i18n/vi-VN.json`
- `scripts/wordbook-v12-acceptance.mjs`
- `scripts/mastered-tab-acceptance.mjs`
- `scripts/custom-wordlists-acceptance.mjs`
- `specs/005-favorites-export/spec.md`

## acceptance
1. 编辑态表头出现全选 checkbox（三态：未选/部分/全选）；默认不选；退出编辑清空。
2. 点全选 = 选中当前 **搜索 + 筛选 + 排序** 下的全部结果，跨页；底部显示「已选 N / 结果 M」。
3. 部分选择时表头为 indeterminate；再点全选 = 清空（或按平台惯例，写清）。
4. 服务端分页列表（内置/自定义）：全选时按当前 `q`/筛选拉取全部页（受现有上限），显示加载态；拉取失败不清空已有选择并给行内/toast 错误。
5. 批量操作对跨页选中项同样生效：成功项移出选择，失败项保留 + 汇总；操作中禁用。
6. 非编辑态无全选 checkbox；单行选择/行展开行为不变。
7. 三脚本同步（全选、跨页、清除、indeterminate、跨页批量）各 2 次 PASS；`tsc/build/i18n/gate` 绿；1440/375 截图。

## deps
- P0-14（已完成）

## rollback
revert；纯前端/脚本/文档。
