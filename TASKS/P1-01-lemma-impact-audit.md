# P1-01 lemma 归并影响审计（只读）

- status: claimed
- owner: {implementer: lemma-audit-impl, reviewer: lead, integrator: lead}
- base_sha: c57d896

## goal
在改任何代码/数据前，量化 lemma 归并对以下系统的影响：我的收藏、已掌握、其他词表状态/标色、高亮筛选、收藏↔掌握、见过次数、出处、复习进度、统计、事件、游客数据、自定义词表、误合并风险。**只读，不写数据、不调 AI。**

## non_goals
- 不实现归并、不迁移、不改应用代码
- 不写 favorites/word_states/events
- 不做产品决策（只给建议与数字）

## write_scope
- `scripts/lemma_impact_audit.py`（新建）
- `scripts/tests/test_lemma_impact_audit.py`（新建）
- `docs/reports/lemma-impact-2026-11-23.md`（新建报告）

## read_only
- `data/app.db`（只读打开）、`data/users/*/favorites.json`、`data/ecdict.db`
- `content/wordlists/`、`content/library/`、`ADR/0001`、`docs/data-map.md`

## acceptance（报告必须包含）
1. **覆盖与归并量**：现有 vocabulary 收藏 / `word_states` / `dict_lookup` 事件中，按 ECDICT `exchange` 的 `0:` base 能归并的组数、涉及条数、去重后条数；未覆盖词比例。
2. **冲突清单**：同一 lemma 下收藏多条的 forms/来源/时间；`word_states` 多条时 FSRS 字段（reps/lapses/due/mastered/suspended/definition）差异，逐组给出建议保留项。
3. **跨模块影响数字**：
   - 内置词表（CEFR/GRE/CET4/CET6）中含变形词的行数及示例（这些行的星标/对勾/标色会受 lemma 状态影响）
   - 自定义词表 `user_wordlist_items` 中含变形词的行数
   - 短语表预计归并数（应接近 0）
   - 高亮筛选受影响词数（已掌握/收藏按面形 vs lemma 的差集）
   - 见过次数按 lemma 聚合后与现在的差异
   - 每周统计/事件口径差异
4. **误合并候选**：axes/leaves 等歧义、专名、多词短语；只接受 ECDICT `0:` 明确 base 的规则说明 + 人工复核清单。
5. **游客数据**：说明本地 `guest_mastered_words`/guest favorites 无 lemma 字段，需客户端归一化；无法在服务端审计的项明确标注。
6. **建议**：合并口径 A（主记录+forms）vs B（仅状态按 lemma 对齐）各自影响条数与风险；分阶段实施建议。
7. 脚本：默认只读；`--json` 输出机器可读；前后 `sha256` 证明未写库/未写文件；单测覆盖 exchange 解析、归并分组、误合并分类。
8. 报告写入 `docs/reports/lemma-impact-2026-11-23.md`；不 commit。

## deps
- 无（只读，可与 P0-16 并行）

## rollback
仅新增脚本/报告；删除即可。
