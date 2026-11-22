# P1-06 词族分页与其他词表共用完整分页

- status: pending（等 P2-05A 释放 VocabularyBookScreen）
- owner: {implementer: TBD, reviewer: lead, integrator: lead}
- base_sha: 304ecd2

## goal
词族 tab 当前虽然用了 `VocabPagination`，但没传 `pageSize/onPageSizeChange`，导致**每页条数选择器被隐藏**；且分页状态用固定 `WORD_FAMILY_PAGE_SIZE=50`。改为与其他词表完全一致的 20/50/100 + 跳页 + 页码，服务端按 `pageSize` 请求。

## write_scope
- `frontend/src/components/VocabularyBookScreen.tsx`
- `scripts/word-family-acceptance.mjs`
- `specs/041-word-family-list/spec.md`

## read_only
- `frontend/src/components/VocabPagination.tsx`、`backend/routes_vocabulary.py`

## acceptance
1. 词族 tab 显示与其他词表相同的分页条：页码/上一页/下一页、每页 20/50/100、跳页输入、状态文案。
2. 切换每页条数：重新从第 1 页请求，服务端 `pageSize` 生效；总页数/高亮正确。
3. 跳页越界钳制；与搜索/筛选/排序组合正确；375/1440。
4. 其他词表分页零回归；`tsc/build/i18n/gate`；Playwright 断言 page-size 菜单/跳页/服务端参数。

## deps
- P2-05A（同文件）

## rollback
revert；纯前端。
