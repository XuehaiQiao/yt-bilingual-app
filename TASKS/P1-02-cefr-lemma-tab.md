# P1-02 CEFR 10k 词形 tab（只读）

- status: claimed
- owner: {implementer: lemma-tab-impl, reviewer: lead, integrator: lead}
- base_sha: d5e9434

## goal
按 `specs/040-cefr-lemma-list` 新增只读「词形」tab：基于 `content/wordlist/frequency_bands.v1.json`（10k lemma + forms + CEFR 锚点）与 `lexicon.v1.json`（音标/释义），后端只读端点 + 前端列表；现有词表结构与数据不动。

## non_goals
- 不做收藏/掌握/编辑/批量/导出
- 不迁移、不写用户数据、不调 AI
- 不改现有 tab 的结构/计数/写操作

## write_scope
- `backend/lemma_list.py`（新建：加载/索引/分组）
- `backend/routes_vocabulary.py`（新增只读端点）
- `backend/tests/test_lemma_list.py`（新建）
- `frontend/src/lib/wordlists.ts`（或新 `lib/lemmaList.ts`，二选一，最小）
- `frontend/src/components/VocabularyBookScreen.tsx`
- `frontend/src/components/VocabularyRows.tsx`（如需只读行配置）
- `frontend/src/i18n/zh-CN.json`
- `frontend/src/i18n/vi-VN.json`
- `scripts/cefr-lemma-acceptance.mjs`（新建）
- `specs/040-cefr-lemma-list/spec.md`（状态回填）
- `specs/README.md`

## read_only
- `specs/040-cefr-lemma-list/spec.md`、`content/wordlist/frequency_bands.v1.json`、`content/wordlists/lexicon.v1.json`、`docs/data-map.md`

## acceptance
1. `GET /api/vocabulary/lemma-list`：total=10000；A1/A2/B1/B2/C1=1000/1000/2000/3000/3000；分页/排序/level 过滤正确；非法 level 400、pageSize>200 400。
2. `q=running` 命中 run；`q=abandoned` 命中 abandon；`q=run` 命中 run；大小写不敏感。
3. 响应 item 含 lemma/rank/level/phonetic/translation/forms；forms 与该 lemma 的映射数量一致。
4. 前端新 tab「词形」在 CET6 之后；只读列/展开/搜索/排序/筛选/分页/跳页；无星标/对勾/编辑/导出。
5. 现有词表 tab 与三个验收脚本零回归；游客可读、零 AI。
6. `tsc/build/i18n/gate` 绿；Playwright `cefr-lemma-acceptance.mjs` PASS；1440/375 截图。
7. 先写失败测试再实现；preflight `--staged` 只 stage 自己文件。

## deps
- P0-16（已完成）

## rollback
revert；纯新增只读功能。
