# P0-01 单一「我的单词」计数

- status: ready
- owner: {implementer: TBD, reviewer: TBD, tester: TBD, integrator: TBD}
- base_sha: 95f5891

## goal
顶栏、侧栏、用户页、单词本 tab、阅读页按钮、导出全部读同一个「我的单词」列表长度；删除所有 `favorites − mastered` 与读时过滤。

## non_goals
- 不新增后端计数端点（收藏列表已在 `GET /api/favorites` 返回）
- 不改收藏数据结构、不改已掌握端点
- 不做存量 reconcile（P0-02）

## write_scope
- `frontend/src/lib/myWords.ts`（新建）
- `frontend/src/components/VocabularyBookScreen.tsx`
- `frontend/src/components/ReadingVocabButton.tsx`
- `frontend/src/components/ProfileScreen.tsx`（若含计数）
- `frontend/src/App.tsx`（**shared_writes，仅 Integrator**）

## read_only
- `ARCHITECTURE.md` §6
- `docs/data-map.md`
- `specs/005-favorites-export/spec.md`
- `frontend/src/lib/favorites.ts`

## contracts
- `ADR/0001-my-words-single-source.md`
- `CONTRACTS/schemas/word.json`

## acceptance
1. 新 selector `selectMyWords(favorites)` 与 `selectMastered(serverWords)`；计数 = 列表长度。
2. grep 全前端：计数路径不含 `mastered` / `!mastered` / 减法。
3. Playwright mock：收藏 15、其中 3 条 mastered（模拟脏数据）→ 顶栏/词书/阅读按钮全部显示 15（诚实暴露脏数据），reconcile 后（P0-02）全部 12。
4. `tsc -b`、`build`、`check:i18n`、`gate-receipt` 绿。
5. 导出输入与计数同源。

## deps
- 建议在 P0-02 之前或并行（选择器先上，数字先变一致；reconcile 后变正确）

## rollback
revert merge；纯前端，无迁移/无数据改写。
