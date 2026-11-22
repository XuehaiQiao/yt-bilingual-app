# P1-11 应用词族高置信审计变更

- status: claimed
- owner: {implementer: family-apply-impl, reviewer: lead, integrator: lead}
- base_sha: 69a1492

## goal
把 AI 审计的 **23 条高置信变更**写入构建规则并重新生成词族数据；中/低 11 条保持不动。

## 输入
- `docs/reports/word-family-ai-audit-summary-2026-11-23.md`
- `docs/reports/word-family-ai-audit/batch-*.json`（436 族结果）
- `scripts/build_word_families.py`（当前 17 blacklist + 22 allowlist）
- `content/wordlist/word-families.v1.json`
- `content/wordlist/NOTICE.md`（同步数据统计）

## 变更
- **trim 13 条**：删除指定成员（及其所有边）— digitalis、diligence/diligent、indispensable 组、venter/ventral、ostentation 组、pugnacious/pugnacity、serviceability 组、livery、limpid/limpidity、entrancement、pager、angler、frostian
- **split 10 条**：删除指定桥边 — large、strain、sour、curious、drive/drift、fly/flee、vacation/vacant、advantage/profitable、bad/severe、bright/luminous
- 中/低 11 条（game/agony/impress/create/spoil/sound/urban/wind/deposit/dump/foil）**不动**
- 规则写进 `build_word_families.py`（如 `TRIM_MEMBERS` / `SPLIT_EDGES`，含族 id/理由），逐条校验存在性；重新生成数据；同步 `counts` 与测试期望
- 更新 `specs/041` 数字、`docs/reports/word-family-ai-audit-summary` 的应用标记、`docs/reports/word-family-open-audit` 的实现复核

## write_scope
- `scripts/build_word_families.py`
- `scripts/tests/test_build_word_families.py`
- `content/wordlist/word-families.v1.json`
- `content/wordlist/NOTICE.md`（同步数据统计）
- `backend/tests/test_word_family.py`
- `specs/041-word-family-list/spec.md`
- `docs/reports/word-family-ai-audit-summary-2026-11-23.md`
- `docs/reports/word-family-open-audit-2026-11-23.md`


## read_only
- batch JSON、summary、spec 041、ADR

## acceptance
1. 生成数据应用 23 条；中/低 11 条未动；黑名单/allowlist 仍生效且无重复/冲突。
2. 数字更新：族/成员/10k 覆盖/最大族；`the/at` 仍不在；`--check` 幂等。
3. 后端测试与 scripts 测试通过；词族验收脚本数字更新；现有词表脚本零回归。
4. `pytest` 定向+全量；`tsc/build/i18n/gate`；preflight `--staged`。
5. 报告记录 applied 的 23 条与前后数字；未应用 11 条单列。

## deps
- P1-09（已完成）
