# P0-13 修复「已掌握」释义丢失（标记时快照 + 存量回填）

- status: claimed
- owner: {implementer: def-impl, reviewer: lead, integrator: lead}
- base_sha: adbd4aa

## goal
标记已掌握时把中文释义写入 `word_states.definition` 快照（仅空时写、不覆盖）；并回填当前 4 条已掌握词的存量释义（来源：reconcile 备份中的原收藏 zh_text）。

## non_goals
- 不恢复收藏、不改收藏计数
- 不自动调 AI 查词
- 不改已掌握列表 UI（P0-12 正在改对勾视觉）

## write_scope
- `backend/routes_review.py`（PATCH 接受可选 definition）
- `backend/srs.py`（set_mastered 写入快照，仅空时）
- `backend/tests/test_review_engine.py`
- `frontend/src/components/VocabularyBookScreen.tsx`（标记时传 definition）
- `frontend/src/lib/review.ts`（SetWordMasteredInput 加 definition）
- `scripts/backfill_mastered_definitions.py`（新建）
- `scripts/tests/test_backfill_mastered_definitions.py`（新建）
- `specs/005-favorites-export/spec.md`、`specs/013-review-engine/spec.md`

## read_only
- `ADR/0001`、`docs/data-map.md`、`data/backups/`（只读来源）

## acceptance
1. PATCH `{lemma, mastered:true, definition:"支付能力；…"}` → 响应 word.definition 有值；再次标记/取消不覆盖已有快照。
2. 前端标记已掌握时传行内中文释义（收藏行来自 zh_text，词表行来自 translation）；成功后仍删收藏；失败回滚。
3. 回填脚本：默认 dry-run 列出 4 条（affordability/intimately/thorny/ecstacy）与原 zh_text；`--apply --yes` 写 backup+audit，只填空、不覆盖；`--check` 巡检 mastered 且 definition 空的数量=0；可回滚。
4. 回填后 `GET /api/review/words?mastered=1` 每条的 definition 非空；页面释义列恢复。
5. pytest 定向+全量；`tsc/build/i18n/gate`；1440/375 截图（已掌握 tab）。
6. 先写失败测试再实现；preflight `--staged` 只 stage 自己文件。

## deps
- P0-10（已合并；P0-12 只改对勾视觉，互不冲突）

## rollback
回填脚本 `--rollback`；代码 revert。
