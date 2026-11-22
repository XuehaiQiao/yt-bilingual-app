# P1-05 实现 CEFR 词族 tab（替换词形）

- status: claimed
- owner: {implementer: family-tab-impl, reviewer: lead, integrator: lead}
- base_sha: d13e70b

## goal
按 `specs/041-word-family-list` 用规则 E 生成静态词族数据，后端只读端点 + 前端把「词形」tab 替换为「词族」；只读，不改现有词表结构/数据。

## write_scope
- `content/wordlist/word-families.v1.json`（新建静态数据）
- `content/wordlist/NOTICE.md`（WordNet 来源/license）
- `scripts/build_word_families.py`（新建，可复现生成）
- `scripts/tests/test_build_word_families.py`（新建）
- `backend/word_family.py`（新建）
- `backend/routes_vocabulary.py`
- `backend/tests/test_word_family.py`（新建）
- `backend/lemma_list.py` + `backend/tests/test_lemma_list.py`（删除，被词族替换）
- `frontend/src/components/VocabularyBookScreen.tsx`
- `frontend/src/components/VocabularyRows.tsx`（如需只读族行）
- `frontend/src/i18n/zh-CN.json`、`vi-VN.json`
- `scripts/word-family-acceptance.mjs`（新建）
- `specs/041-word-family-list/spec.md`、`specs/README.md`、`specs/040-cefr-lemma-list/spec.md`

## read_only
- `docs/reports/word-family-open-audit-2026-11-23.md`、`docs/reports/word-family-audit-2026-11-23.md`、`content/wordlist/frequency_bands.v1.json`

## acceptance
1. 生成数据：3,696 族 / 11,563 成员 / 10,640?（以审计为准）10k 外 6,340 / 最大 18；黑名单 17 条、allowlist 22 条；the/at 不出现；数据含 source/license/ruleVersion。
2. API：总数、分页、q 任一词、level、sort、非法参数；decide 5 人、reflect 含 reflection（allowlist）、judge 11 人含 10k 外成员。
3. 前端：tab 从「词形」改「词族」；行为只读；展开成员等级 `—`；现有词表零回归。
4. 删除 lemma-list 端点/模块/测试；specs 状态回填。
5. `pytest` 定向+全量、`tsc/build/i18n/gate`、Playwright 新脚本；1440/375 截图；preflight `--staged` 只 stage 自己文件。

## deps
- P1-04（已完成）

## rollback
revert；静态数据/只读端点新增，不影响用户数据。
