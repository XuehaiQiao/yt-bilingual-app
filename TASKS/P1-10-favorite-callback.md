# P1-10 词书内新增收藏回传 App（顶栏计数即时同步）

- status: claimed
- owner: {implementer: fav-callback-impl, reviewer: lead, integrator: lead}
- base_sha: 69a1492

## goal
在单词本（含词族成员）内新增收藏时，不只更新词书局部 overlay，还通过 App 的 favorites 状态更新顶栏/侧栏「单词本」计数；删除已有收藏保持现状。

## write_scope
- `frontend/src/App.tsx`（shared，lead 授权本次 Integrator lease）
- `frontend/src/components/VocabularyBookScreen.tsx`
- `frontend/src/lib/favorites.ts`（如需类型）
- `scripts/wordbook-v12-acceptance.mjs`
- `scripts/word-family-acceptance.mjs`

## read_only
- `frontend/src/lib/favorites.ts`、`TASKS/P1-07`、`ADR/0001`

## acceptance
1. App 向 VocabularyBookScreen 传 `onAddFavorite`（复用 App 现有乐观 addFavorite 路径）；词书新增收藏（内置词表/短语/自行定义/词族成员）调用它，App favorites 更新、顶栏计数 +1。
2. 词书内已有收藏删除仍走 `onRemoveFavorite`，计数 -1。
3. 失败回滚：App 计数与星标恢复；行内错误。
4. 重复点击幂等；游客登录门禁不变。
5. Playwright：mock 下从词族成员收藏 → 顶栏计数即时 +1（不刷新）；失败 -0。
6. `tsc/build/i18n/gate`；三词表脚本零回归。

## deps
- P1-07（已完成）
