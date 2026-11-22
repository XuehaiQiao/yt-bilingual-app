# P1-07 词族成员释义 + 收藏/掌握操作

- status: pending（等 P1-06 释放 VocabularyBookScreen）
- owner: {implementer: TBD, reviewer: lead, integrator: lead}
- base_sha: e660445

## goal
词族 tab 展开后，每个成员行显示：词形 / 音标 / 中文释义 / CEFR（10k 外 `—`）/ 星标 / 对勾；可逐词收藏、标已掌握。族行仍只读（不做批量/编辑/导出）。

## 数据
- `content/wordlist/word-families.v1.json` 的成员增加 `phonetic`、`translation`（来自 `lexicon.v1.json`，缺失为空串；不调 AI）
- 构建脚本可复现；数据文件仍含 source/license/ruleVersion

## 语义
- 星标 = 收藏开关（POST/DELETE `/api/favorites`，来源 `source_kind='wordlist'`、`source_ref` 词族 id/name）
- 对勾 = 已掌握开关（PATCH `/api/review/words`，带 definition 快照；标已掌握时按不变量移除该词收藏）
- 失败回滚 + 行内错误；成功更新顶栏/词书计数与两侧状态
- 10k 外成员与 10k 内成员同一操作；无释义时快照为空

## write_scope
- `content/wordlist/word-families.v1.json`
- `scripts/build_word_families.py`
- `backend/word_family.py`
- `backend/routes_vocabulary.py`
- `backend/tests/test_word_family.py`
- `frontend/src/components/VocabularyBookScreen.tsx`
- `frontend/src/components/VocabularyRows.tsx`
- `frontend/src/i18n/zh-CN.json`
- `frontend/src/i18n/vi-VN.json`
- `scripts/word-family-acceptance.mjs`
- `specs/041-word-family-list/spec.md`

## read_only
- `ADR/0001`、`frontend/src/lib/favorites.ts`、`frontend/src/lib/review.ts`

## acceptance
1. 成员数据含音标/释义；缺失显示 `—`；构建数据量与审计一致（族/成员数不变）。
2. 展开后每行有 star + check；点星 POST/DELETE，点勾 PATCH；标已掌握时收藏被移除；失败回滚。
3. 状态与「我的收藏/已掌握」一致；顶栏计数更新；重复点击幂等。
4. 10k 外成员可操作；未登录按现有登录门禁。
5. 无释义时仍可收藏/掌握（definition 空）。
6. `tsc/build/i18n/gate`；Playwright 断言两态/失败回滚/计数；现有四脚本零回归。

## deps
- P1-06（同文件）
