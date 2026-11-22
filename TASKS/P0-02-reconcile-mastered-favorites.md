# P0-02 reconcile：清理「已掌握仍在收藏」存量

- status: ready
- owner: {implementer: TBD, reviewer: TBD, integrator: TBD}
- base_sha: 95f5891

## goal
修复存量数据缺陷：3 条（Affordability / intimately / thorny）`mastered=1` 且仍在 favorites。执行后 `favorites ∩ mastered = ∅`，我的单词=12，已掌握 tab 仍 3 条。

## non_goals
- 不改 `word_states`、不改已掌握记录
- 不静默批量删；必须 dry-run + 备份 + 审计 + 人工确认
- 不做其他用户（本机仅当前用户；脚本支持 `--user-id`）

## write_scope
- `scripts/reconcile_mastered_favorites.py`（新建）
- `scripts/tests/`（若存在测试目录，可加；不改应用代码）

## read_only
- `docs/data-map.md`
- `specs/005` §已掌握与收藏互斥
- `backend/storage.py`（favorites 读写/锁）

## acceptance
1. 默认 dry-run：列出清单（lemma、favorite id、added_at、mastered 时间、source_kind），断言命中数=3；**不写文件**。
2. `--apply --user-id … --yes`：先备份 `data/backups/favorites-<uid>-<ts>.json`，逐条走 per-item DELETE（文件锁 + tombstones），写 JSONL 审计。
3. 执行后：`favorites` 15→12；`word_states` 3 条不变；单词本两 tab 无交集；`/api/favorites` 返回 12。
4. `--rollback <audit.jsonl>` 可幂等恢复；`--check` 只读巡检 overlap=0。
5. 脚本自带单测/集成测试（临时目录），不碰真实数据。

## deps
- 无（P0-01 可并行）

## rollback
`--rollback` 恢复备份/重放 JSONL；操作只动收藏，不动掌握状态。
