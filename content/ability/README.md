# content/ability

CEFR 能力标定 M1 的只读内容（specs/025）。运行时不写这些文件；缺失/损坏时
`backend/ability.py` 抛 `AbilityUnavailable`，路由返回 503。

| 文件 | 内容 | 校验 |
|---|---|---|
| `can_do.json` | A1–C1 × 4 技能 × 2 条 = 40 条通用 can-do 描述；每条含中文/越南语 `statement`、可观察条件 `observable`、`basis` | `ability.load_can_do()` 校验条数/级别/技能/zh+vi/basis |
| `self_assess.json` | 4 技能 × A1–C1 = 20 条自评；0–3 量表 + 跳过 | `ability.load_self_assess()` 校验恰好 20 条、覆盖完整 |

## 版权与口径

- 全部为**自写改写**，参考 CEFR 能力描述框架与可观察条件，**不复制** Council of
  Europe 的描述符原文。
- 描述用「A2 学习者通常能…」的通用句式，不是对当前用户的判定；阅读在
  M1–M2 没有用户特定判定。
- `basis` 两档：`cefr-aligned`（通用改写）/ `product-operational`（产品化可观察
  条件，未校准）。WPM/词数/时长等阈值未做教师校准，不得称为「CEFR 标准」。
- 用户可见文案禁用词：已测量 / 个性化 / 准确率 / ±1 带 9x% / 相当于雅思 / B1.x。
