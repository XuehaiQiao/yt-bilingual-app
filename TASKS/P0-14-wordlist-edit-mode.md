# P0-14 所有词表支持编辑模式与批量操作

- status: pending（等 P0-12、P0-13 释放同文件）
- owner: {implementer: TBD, reviewer: lead, integrator: lead}
- base_sha: f98660d

## goal
每个词表都提供「编辑」入口：默认不显示选择框；点击编辑后行首出现 checkbox + 底部批量操作条；再次点「完成」退出并清空选择。自定义词表的编辑/删除/重命名保留并统一到同一套模式。

## 操作矩阵（按词表能力）

| 词表 | 批量操作 |
|---|---|
| 我的收藏 | 取消收藏（DELETE favorites） / 标为已掌握（PATCH + 删收藏） |
| 已掌握 | 取消已掌握（PATCH mastered=false） |
| 内置 CEFR/GRE/CET4/CET6 | 加入收藏（POST） / 标为已掌握 |
| 短语 | 加入收藏 / 标为已掌握 |
| 自定义词表 | 删除词条（DELETE items，二次确认） / 加入收藏 / 标为已掌握 |

## non_goals
- 不做逐条改词/加词/排序
- 不改后端接口（复用现有 favorites / review / wordlists items）
- 不改路由

## write_scope
- `frontend/src/components/VocabularyBookScreen.tsx`
- `frontend/src/components/VocabularyRows.tsx`
- `frontend/src/i18n/zh-CN.json`
- `frontend/src/i18n/vi-VN.json`
- `scripts/wordbook-v12-acceptance.mjs`
- `scripts/mastered-tab-acceptance.mjs`
- `scripts/custom-wordlists-acceptance.mjs`
- `specs/005-favorites-export/spec.md`

## read_only
- `TASKS/P0-10`、`TASKS/P0-12`、`TASKS/P0-13`、`docs/data-map.md`

## acceptance
1. 默认（非编辑态）：不渲染任何行首 checkbox；行内星标/对勾照常可用。
2. 工具栏「编辑」→ 行首 checkbox + 底部操作条「已选 N / 操作… / 完成」；「完成」退出并清空选择。
3. 操作按矩阵：我的收藏可取消收藏/标已掌握；已掌握可取消掌握；内置/短语可加入收藏/标已掌握；自定义可删除词条（确认）/加入收藏/标已掌握。
4. 批量逐条执行：成功项移出选择；失败项保留 + 行内错误 + 汇总；操作中禁用重复提交；删除需 ConfirmDialog。
5. 编辑态禁用行展开（点击行只切换选择）；退出后恢复展开。
6. 计数/星标/对勾/底色规则不回退；375/1440 无溢出；i18n 中越对齐。
7. 三个验收脚本同步并各跑 2 次 PASS；`tsc/build/i18n/gate` 绿。

## deps
- P0-12、P0-13（同文件，必须串行）

## rollback
revert；纯前端。
