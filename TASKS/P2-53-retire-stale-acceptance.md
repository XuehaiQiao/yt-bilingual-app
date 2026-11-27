# P2-53 退役过期 CEFR 词形验收

- status: merged
- owner: lead
- base_sha: 890640e
- evidence: `/tmp/full-regression-2026-11-27.md`

## 问题
`scripts/cefr-lemma-acceptance.mjs` 仍等待已删除的 `vocab-lemma-tab`；specs/040 已被 041 词族取代，产品无该 tab，属 TEST-STALE，不是产品回归。

## 动作
- 删除 `scripts/cefr-lemma-acceptance.mjs`
- specs/040 验收记录标注已退役
- 不恢复旧「词形」功能；词族验收 `word-family-acceptance.mjs` 继续作为当前契约

## 结果
- 全量 acceptance：20 PASS / 0 FAIL / 0 SKIP（21 个脚本）
- p2-05b 首跑 flaky、重跑 PASS，单独观察
