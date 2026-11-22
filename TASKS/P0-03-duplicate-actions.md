# P0-03 收敛重复动作与结果镜像

- status: ready
- owner: {implementer: TBD, reviewer: TBD, tester: TBD, integrator: TBD}
- base_sha: 95f5891

## goal
1) 「我的单词」取消收藏只保留星标一个入口，删除展开区「取消收藏」。
2) 已收藏词在所有词表里不再渲染「加入我的单词」动作；删除 `mineAdds` 结果镜像（只留请求中 busy）。
3) 星标/动作都从 canonical 收藏集合派生。

## non_goals
- 不改收藏 API、不改「已掌握」写入（P0-05/后续）
- 不改统一表格布局（P0-01 已定）

## write_scope
- `frontend/src/components/VocabularyBookScreen.tsx`
- `frontend/src/components/VocabularyRows.tsx`
- `frontend/src/lib/favorites.ts`（仅幂等守卫，如需）

## read_only
- `specs/005`、`docs/data-map.md`、`ARCHITECTURE.md` §6
- `frontend/src/lib/favorites.ts` 现有 add/remove

## acceptance
1. 我的单词行：展开区无「取消收藏」；星标 `aria-pressed=true` 是唯一取消入口。
2. 内置词表/短语/自定义词表：已收藏词**不渲染**「加入我的单词」；未收藏词可加入，成功后立即消失动作、星标变实心。
3. 删除 `mineAdds` 结果镜像；失败仅显示行内错误，可重试。
4. Playwright mock：重复点击只发一次请求；加入失败后星标仍为空；兼容既有 testid 或列出需同步脚本。
5. `tsc/build/i18n/gate` 绿；证据截图 1440/375。

## deps
- 与 P0-01 同文件 → 串行（P0-01 后）

## rollback
revert merge；纯前端。
