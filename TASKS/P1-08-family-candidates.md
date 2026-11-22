# P1-08 词族候选清单（只读、零 AI）

- status: merged
- owner: {implementer: lead, reviewer: lead, integrator: lead}
- base_sha: 81be64e

## goal
在 AI 审计前，用机器规则筛出「可能需要复查」的词族：大族、跨 POS、10k 外占比高、多词/专名/大写、rank 跨度大、链式边多。只读，不调 AI，不改数据。

## 交付
- `scripts/word_family_candidates.py`
- `scripts/tests/test_word_family_candidates.py`
- `docs/reports/word-family-candidates-2026-11-23.md`
- 候选 JSON `/tmp/word-family-candidates-audit.json`

## 验收
- 输出候选族数/原因分布/示例；`the/at` 不在；只读 sha256 不变。
- 每条候选带 id/head/size/levels/outside/POS/rank span/edge count/原因，供 AI 或人工复查。
