# P1-09 词族候选 AI 审计

- status: claimed
- owner: {implementer: lead + batch reviewers, reviewer: lead, integrator: lead}
- base_sha: d649dc5

## goal
对 436 个机器候选族做 AI 逐族审计：keep / trim / split，给出要删除的成员/边与理由；只产出建议，不改数据、不改代码。

## 输入
- `/tmp/word-family-candidates-audit.json`（436 族全量）
- `content/wordlist/word-families.v1.json`（成员/等级/rank）

## 输出
- `docs/reports/word-family-ai-audit/batch-XX.json`（每批结构化结果）
- 汇总报告（lead 合并）：keep/trim/split 数量、高置信坏族清单、待人工裁决项
- 不写 blacklist/allowlist；不重新生成数据

## 规则
- 同词根 + 透明语义才算一族；链式串接、词形巧合、不同词根、语义已分化 → trim/split
- 不因「生僻/10k 外」而删除合法派生
- 不确定 → keep + low confidence + 理由

## non_goals
- 不改应用/数据/构建脚本
- 不做最终裁决（lead/用户确认后才写入 blacklist/allowlist）

## rollback
删除 audit 输出即可。
