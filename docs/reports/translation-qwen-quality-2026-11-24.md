# Qwen vs DeepSeek 翻译质量盲评（初步）

> 日期：2026-11-24 ｜ 语料：项目公版文章 10 段 + 内置视频字幕 20 块
> 模型：`deepseek-chat`、`qwen3.8-flash`（thinking disabled）
> 目的：决定 Qwen 是否可承担“稳定期批次”；不是最终生产金标。

## 1. 方法

- 同一源文、同一 prompt 结构，分别生成 DeepSeek/Qwen 译文（各 1 次用于质量；延迟各 3 次）。
- 盲评：每条随机 A/B 隐藏模型名，要求评委只比较 adequacy/fluency，输出 winner 与 1–5 分。
- 评委：
  - **Qwen Plus**（`qwen3.7-plus`，thinking disabled）：30/30 条完成
  - **Gemini 3.5 Flash Lite**：受免费额度限制，仅 12/30 条有效（其余 429/503）
- 未安装 COMET；项目参考译文是构建期 LLM 产物，不作为人工金标。因此本报告**不声称 COMET 或人工金标结论**。
- 盲评原始数据：`/tmp/translation-tuning/quality_judge.json`

## 2. 质量结果

### Qwen Plus 评委（30 条）

| 任务 | DeepSeek 胜 | Qwen 胜 | 平 | 有效 |
|---|---:|---:|---:|---:|
| 文章（10 段） | 6 | 4 | 0 | 10 |
| 视频（20 块） | 9 | 4 | 7 | 20 |
| **合计** | **15** | **8** | **7** | **30** |

- 平均分（adequacy/fluency 均值）：**DeepSeek 4.73 / Qwen 4.52**
- 结论倾向：DeepSeek 略好，但 Qwen 不是明显崩坏；视频大量平局。

### Gemini 3.5 Flash Lite 评委（仅 12 条有效）

| 任务 | DeepSeek 胜 | Qwen 胜 | 平 |
|---|---:|---:|---:|
| 文章 | 4 | 3 | 0 |
| 视频 | 1 | 2 | 2 |
| 合计 | 5 | 5 | 2 |

- 平均分：DeepSeek 4.54 / Qwen 4.33
- 两个评委在 12 条共同样本上仅 **7/12 一致**；样本太小，不能定论。

## 3. 延迟与成本（同一批，3 次重复）

| 任务 | 模型 | wall 范围 | 平均成本 |
|---|---|---:|---:|
| 文章 10 段 | DeepSeek | 6.41–7.37s | **1,351 µ$** |
| 文章 10 段 | Qwen | 10.30–11.07s | **455 µ$** |
| 视频 20 块 | DeepSeek | 3.07–3.17s | **634 µ$** |
| 视频 20 块 | Qwen | 6.14–10.62s | **247 µ$** |

- Qwen 成本约为 DeepSeek 的 **1/3**（文章 34%、视频 39%）。
- Qwen 延迟约为 DeepSeek 的 **1.6–3.4×**；视频长尾到 10.6s。
- 质量 vs 成本不是单调关系：DeepSeek 质量略高、延迟低；Qwen 便宜但慢且质量略低。

## 4. 结论

1. **Qwen 关闭 thinking 后确实是可用候选**，不是之前的“又慢又贵”。
2. 但按现有盲评，**Qwen 质量略低于 DeepSeek**（15:8，均值 4.52 vs 4.73），样本 30、评委单一且同属 Alibaba，存在偏差。
3. **不应让 Qwen 承担首屏/交互主路径**；可考虑：
   - 后台/离线整本翻译
   - 非首屏稳定期批次（A/B）
   - 成本敏感、可接受 2–3× 延迟的场景
4. 要正式路由，必须补：
   - 第二个独立评委（当前 Gemini 配额失败）
   - 人工 pairwise（至少 30 条）
   - COMET（需安装/参考译文）
   - 真实 P95/失败率长尾测试

## 5. 当前建议

**默认翻译仍用 DeepSeek。**  
Qwen 暂不进入默认路由；先做“Qwen 仅后台/非首屏”的灰度，不动首屏。  
等第二评委 + 人工 pairwise 完成后再决定是否扩大。

## 6. 产物

- 原始生成数据：`/tmp/translation-tuning/quality_gen.json`
- 盲评结果：`/tmp/translation-tuning/quality_judge.json`
- 评委日志：`/tmp/translation-tuning/quality_judge2.log`
- 人工盲评表：`/tmp/translation-tuning/quality-human-ballot.md`
