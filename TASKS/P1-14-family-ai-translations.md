# P1-14 AI 补全词族成员中文释义

- status: claimed
- owner: {implementer: family-ai-trans-impl, reviewer: lead, integrator: lead}
- base_sha: 6515e96

## goal
仅补 **中文释义**（不补音标）给仍缺 translation 的 115 个词族成员；用 AI 生成，写入独立 override 文件并在构建时合并（仅空值、不覆盖 lexicon/ECDICT）。

## write_scope
- `content/wordlist/ai-member-translations.v1.json`（新建：word→zh，含 source/date/reviewed=false）
- `scripts/build_word_families.py`（合并 override，仅空值）
- `scripts/tests/test_build_word_families.py`
- `content/wordlist/word-families.v1.json`
- `content/wordlist/NOTICE.md`
- `specs/041-word-family-list/spec.md`
- `backend/tests/test_word_family.py`（覆盖率断言）
- `docs/reports/word-family-ai-translations-2026-11-23.md`

## acceptance
1. 115 个缺失释义全部有中文；translation 覆盖 11,534/11,534；音标覆盖不变（不补）。
2. 合并优先级：lexicon > ECDICT > AI override；已有非空值绝不覆盖。
3. 族数/成员数不变 3,704/11,534；POS/审计规则不变。
4. 报告列出 115 词、来源标记（AI、未人工复核）、抽样；NOTICE/spec 记录来源。
5. 单测：override 仅在空值生效、格式校验、缺文件回退；`--check` 幂等；pytest 定向+全量。
6. 不调用运行时 AI；只在构建时使用生成的静态 override。

## deps
- P1-13（已完成）
