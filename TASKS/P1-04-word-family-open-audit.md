# P1-04 开放词族审计（跨 10k、仅显示有族词）

- status: claimed
- owner: {implementer: family-open-impl, reviewer: lead, integrator: lead}
- base_sha: 3da9741

## goal
按负责人新规则重算词族：**族内可含 CEFR 10k 之外的词；只要族内至少一个成员在 10k 即可；无族词（the/at 等）不进入词族表**。产出候选映射与坏边清单，供实现前定黑名单/allowlist。

## rules
- 图：WordNet 3.0 `derivationally_related_forms()` 无向边（全量词条，不限制 10k）
- 族筛选：连通分量 ≥2 成员，且至少 1 个成员 ∈ CEFR 10k
- 展示：只显示这些族；10k 外成员保留，等级标记为空
- 排除：无派生关系的词（the/at）不出现
- 质量：坏边（critical/crisis、judge/adjudicate 等）需逐条列出；给出黑名单/allowlist 建议
- 输出候选 `word → familyId/head` 到 `/tmp`（不提交数据文件）

## write_scope
- `scripts/word_family_open_audit.py`（新建）
- `scripts/tests/test_word_family_open_audit.py`（新建）
- `docs/reports/word-family-open-audit-2026-11-23.md`（新建）

## read_only
- `content/wordlist/frequency_bands.v1.json`、`docs/reports/word-family-audit-2026-11-23.md`、WordNet 语料

## acceptance（报告）
1. 族数、成员总数、10k 内/外成员数；族大小分布（最大/中位）；`the/at` 不在任何族。
2. 示例：decide 族、reflect 族（reflection 是否仍需 allowlist）、judge 族、critical 族、comprehend 族（是否含 extend）。
3. 坏边清单与建议黑名单；allowlist 首批。
4. 候选映射规模/文件大小/加载耗时；数据文件格式建议。
5. 单测；两次运行逐字节一致；只读证明。
6. 明确「无族词」数量与它们不进入词族表的验证。

## deps
- P1-03（已完成）
