# P0-16 已掌握默认按加入时间排序 + 导出覆盖所有词表

- status: claimed
- owner: {implementer: sort-export-impl, reviewer: lead, integrator: lead}
- base_sha: 931c8a0

## goal
1) 「已掌握」默认排序改为**加入时间（新→旧）**，仍可切字母/等级；排序结果客户端分页不变。
2) 「导出」按钮出现在**每个词表**：我的收藏 / 已掌握 / 内置 CEFR/GRE/CET4/CET6 / 短语 / 自定义词表；导出当前列表（尊重当前搜索/筛选/排序，跨页）为 Anki TSV 与 CSV。

## non_goals
- 不改后端；不新增导出端点
- 不改「我的收藏」原有导出格式语义（Anki TSV: Front/Back/Tags；CSV 带上下文列）
- 不做导入

## write_scope
- `frontend/src/components/VocabularyBookScreen.tsx`
- `frontend/src/lib/exporter.ts`
- `frontend/src/i18n/zh-CN.json`
- `frontend/src/i18n/vi-VN.json`
- `scripts/wordbook-v12-acceptance.mjs`
- `scripts/mastered-tab-acceptance.mjs`
- `scripts/custom-wordlists-acceptance.mjs`
- `specs/005-favorites-export/spec.md`

## acceptance
1. 已掌握默认 `masteredSort='added'`：按 `createdAt` 新→旧；同时间按字母；菜单有「加入时间」项并标记选中；切 tab 回来仍默认加入时间（不改用户上次选择？若持久化则按现有模式）。
2. 每个词表面板都有导出按钮（TSV/CSV）；无数据时禁用/隐藏；导出文件名带列表标识与日期。
3. 导出内容：
   - 我的收藏：维持现有格式；
   - 已掌握：word / definition（无则空）/ level；
   - 内置词表：word / phonetic / translation / level（当前 q+筛选+排序，跨页）；
   - 短语：headword / type / translation / level / example；
   - 自定义词表：word / phonetic / translation / level（当前 q+筛选，跨页）。
4. 跨页导出复用 P0-15 的全量加载逻辑；加载失败给错误 toast，不导出半份。
5. 三脚本同步：默认排序、导出按钮存在、下载内容列头/行数（Playwright `download` 或 exporter 单测）；各 2 次 PASS。
6. `tsc/build/i18n/gate` 绿；1440/375 截图；i18n zh+vi。

## deps
- P0-15（已完成）

## rollback
revert；纯前端/脚本/文档。
