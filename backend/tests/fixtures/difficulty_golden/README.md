# difficulty.v1 golden 样本（M2）

固定 3 条文本，供 `backend/tests/test_difficulty.py` 回归判带（计划书 §6.8）：

| 文件 | 期望 `est_cefr.read` / `cefr_input` | 说明 |
|---|---|---|
| `a2.txt` | `A2` | 只用 A1/A2 频带词（p90 ≤ A2，内容带下限 A2） |
| `b1.txt` | `B1` | 约 14% 实词落在 B1 频带（p90 = B1） |
| `c1.txt` | `C1` | 约 19% C1 频带 + 2% 表外（p90 = C1） |

规则：

- 改算法/改频表后必须重跑这 3 条；若判带变化，在 `specs/026-content-difficulty/spec.md`
  的 changelog 写清原因并更新本表；
- 样本只用于「判带不漂移」，不是效度证据（效度看 §6.7 的 60–100 条锚集 holdout）。
