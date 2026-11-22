# P1-12 补全词族成员的音标/释义（本地词典）

- status: claimed
- owner: {implementer: family-data-impl, reviewer: lead, integrator: lead}
- base_sha: 8739f76

## goal
词族展开后成员大量缺音标/释义。用本地 `data/ecdict.db`（只读）为缺项补全；优先保留 `lexicon.v1.json` 数据，缺失才用 ECDICT，仍缺失者保留空串并列出清单。**不调用 AI**。

## write_scope
- `scripts/build_word_families.py`
- `scripts/tests/test_build_word_families.py`
- `content/wordlist/word-families.v1.json`
- `content/wordlist/NOTICE.md`
- `specs/041-word-family-list/spec.md`
- `docs/reports/word-family-member-data-2026-11-23.md`（新建）

## acceptance
1. 构建脚本合并 ECDICT：成员 `phonetic`/`translation` 缺失时补齐；已有 lexicon 值不被覆盖；ECDICT 只读打开。
2. 报告覆盖率：总成员 / 有音标 / 有释义 / 仍缺（列出前 50）；预计可补 5,500+，剩余约 100 为 demonym/专名派生。
3. 族数/成员数不变；数据文件含来源说明；NOTICE 更新。
4. 单测覆盖合并优先级、缺失回退、ECDICT 不可用行为；`--check` 幂等。
5. 后端无需改（端点已返回字段）；前端无需改。
6. `pytest` 定向；`preflight --staged`；不 commit。

## deps
- P1-11（已完成）
