# 语途翻译链路专家方案：稳定性、质量、延迟、Token

> 日期：2026-11-24 ｜ 证据基线：`HEAD e891f15` ｜ 研究任务图：`t-mwuolufj-c91b`
> **状态（2026-11-24 回填）**：P0 的 1（thinking off）/2（prompt 瘦身）/3（空响应重试 + ID 覆盖）/4（90s deadline）已由 P2-31 落地；5（分析移出首屏）不在本卡范围。实施与测试证据见 §11。
> 方法：生产代码/账本审计 + 受控真实模型实验 + 外部文献调研；三者交叉，不把单一来源当结论。
> 外部文献说明：本次 `mnemos_validate` 隔离验证通道不可用（返回“未写入验证结论”），因此外部论文/厂商文档结论按“来源自述、未隔离验证”标注；生产代码与实验数据是可复核事实。

---

## 0. 执行摘要（先给决策）

### 结论

1. **默认模型固定为 `deepseek-chat`**，翻译请求显式关闭 thinking；Qwen Flash 在“thinking 未关”的实测中不适合作为交互式翻译主模型。
2. **不再用固定“条数”作为唯一分批依据**：改为 **token/字符预算 + 首块小批 + 稳定期大批**。首块优先保证首屏，稳定期优先吞吐/成本。
3. **视频首批 10 blocks，稳定期 40 blocks 或 ≤2,000 源 token**；文章首批 5 段，稳定期 20 段或 ≤2,000 源 token；书暂维持 8 段/3 并发，等书籍专项实验。
4. **先做 prompt 瘦身**：视频输入去掉 `start/end`、输出去掉 `en_text` 回显；预计翻译成本 **−30%～−40%**（实验/审计推算，必须先做小样本 A/B 验证）。
5. **稳定性优先于“更大批”**：空响应重试、ID 覆盖率 100% 硬校验、缺失 ID 只补缺失、每批 deadline、模型熔断；批量失败不能整篇重来。
6. **分析不阻塞首屏**：文章/视频先出正文/字幕，分析异步补；分析改“内容级 gloss 字典”，把 6 档等级重算降为 1 次内容级生成 + 本地筛选（需专项实验）。
7. **配额单位从“批”改为“blocks/usage”**：当前 60 批 = 1,200 blocks，一个 1,372-block 讲座必然中途 429；建议 1 单位 = 100 blocks，默认 60 单位/日，管理员可调。

### 预期收益（按现有数据推算，需灰度验证）

| 项 | 现状 | 目标 |
|---|---|---|
| 视频 300 blocks 总耗时 | 约 30–60s（反推，无真实 P95） | **≤40s P95** |
| 视频首批译文 | bs20 单次约 4.0s + 抓取 | **≤8s P95**（首批 10 blocks） |
| 文章 20 段 | 串行 bs10 约 13.5s（实验） | **≤15s P95**；首批 ≤5s |
| 翻译成本 | DeepSeek 文章 $0.0028/篇、视频 $0.028/300 blocks | **−30%～−40%**（prompt 瘦身后） |
| 解析/对齐 | 成功调用 100% | 保持 100%，失败可重试/补缺 |
| 长视频配额 | 1,372 blocks 必 429 | 6,000 blocks/日，可调 |

---

## 1. 方法与证据强度

| 证据 | 来源 | 强度 | 局限 |
|---|---|---|---|
| 代码参数/语义 | `backend/translate.py`、`reading.py`、`book_translation.py`、`routes_videos.py`、`teaching_analysis.py` | 高（行号可核） | 实现与 specs 有漂移 |
| 生产账本 | `data/app.db.ai_usage` 30 天 1,464 行 | 中 | **开发库，仅 1 个真实用户**；60.3% legacy 行无成本；无 content 维度 |
| 计时报告 | `docs/reports/pipeline-timing-*.md` | 中 | 全部是 stub/mock，不是真实 provider |
| 受控实验 | `/tmp/translation-tuning/experiment.json` + `.md` | 中高 | 每配置 2–3 次；串行单请求；质量盲评 n=3、单评委 |
| 文献 | 25 个来源（arXiv/官方文档/项目页） | 中 | **隔离验证不可用**；部分仅摘要/检索片段 |

**结论口径**：凡是“参数建议”，都同时给出证据与置信度；没有真实数据支撑的地方明确标“待实验”，不伪装成最优。

---

## 2. 当前基线（事实）

### 2.1 各链路参数

| 链路 | 批大小 | 并发 | 配额单位 | 缓存 | 首屏是否被分析阻塞 |
|---|---:|---:|---|---|---|
| 视频 SSE（主路径） | 20 blocks（硬编码） | 2（1–3） | 1/批（60/日） | 用户+语言 | 缓存命中且分析未命中时：**是** |
| 视频经典 | 20 | 2 | 1/批（60/日） | 用户+语言 | 是（一次性） |
| 读文章 | 10 段（可配） | 1 | 1/批（60/日） | 文章+语言 | **是**（GET 带 level 同步分析） |
| 公版书 | 8 段/12k 字符 | 3（1–4） | 不走 ai_quota | 全局 | 前端已改为不阻塞 |
| 导入书 | 8 段/12k 字符 | 1 | 1/批（reading） | 用户+书 | 是 |
| 本地剧集 | 20 | 1 | 1/批（60/日） | 用户+语言，全成功才写 | 是 |
| 本地视频 | 20 | 1 | 1/批（translate） | **无服务端译文缓存** | 是 |
| 教学分析 | 200 blocks/次 | 1 | 1/份（30/日） | 全局 content+level+lang | — |

### 2.2 账本事实

- 正常业务日（排除压测/批处理）487 次调用：
  - `translate` 43.5% 成本（1,404 µUSD/次）
  - `analysis` 26.5%（3,074 µUSD/次）
  - `local_show` 9.5%
  - 翻译相关合计 **86.4%**
- 视频成本：105/300/1,372 blocks ≈ **$0.0124 / $0.0281 / $0.1193**；每 1,000 blocks 约为理论 token 最小值的 **4.9×**（输入 4.2×；输出回显 `en_text` 被丢弃仍付费）。
- **配额硬伤**：`translate` 60 批/日 = 1,200 blocks；MIT 讲座 1,372 blocks = 69 批，**单个视频中途 429**。11-24 已出现 `used_units=60/60`。

### 2.3 当前 prompt 的结构性浪费（视频）

`translate.process_llm_batch` 输入每个 block：

```json
{"id": 1, "text": "...", "start": 12.3, "end": 16.8}
```

输出要求：

```json
{"id": 1, "en_text": "<copy exact English>", "zh_text": "..."}
```

但代码 `translate.py:194` 用输入原文覆盖 `en_text`，**模型回显的 en_text 被丢弃**；`start/end` 模型完全不用。审计估算这两项＋JSON 结构约占输入 43%、输出 30–38%，删掉＋紧凑 schema 可省 **~40%** 翻译花费。

---

## 3. 受控实验：batch size 的真实曲线

### 3.1 实验设计

- 内容：20 个 60–120 词公版文章段；40 个 6–25 词视频句块（非用户隐私内容）
- 模型：`deepseek-chat`、`qwen-flash`
- 配置：文章 bs 1/5/10/20；视频 5/10/20/40；每配置 2–3 次
- 指标：wall、prompt/completion/reasoning tokens、JSON 解析、ID 覆盖率、空/重复/语言错误、长度比、盲评质量
- Prompt：逐字复用 `reading._build_translation_prompt` 与视频 `process_llm_batch` 模板
- 总调用 40 次，成本 **$0.0501**

### 3.2 DeepSeek：批越大，延迟/成本越低

| 任务 | bs | 单次 wall | 每条 wall | 整篇串行预测 | 整篇成本 |
|---|---:|---:|---:|---:|---:|
| 文章 | 1 | 2,051ms | 2,051ms | 41.0s | 3,693 µ$ |
| 文章 | 5 | 4,084ms | 817ms | 16.3s | 2,971 µ$ |
| 文章 | 10 | 6,738ms | 674ms | 13.5s | 2,907 µ$ |
| 文章 | 20 | 11,538ms | 577ms | **11.5s** | **2,794 µ$** |
| 视频 | 5 | 2,097ms | 419ms | 16.8s | 2,637 µ$ |
| 视频 | 10 | 2,932ms | 293ms | 11.7s | 2,457 µ$ |
| 视频 | 20 | 4,050ms | 202ms | 8.1s | 2,266 µ$ |
| 视频 | 40 | 5,708ms | 143ms | **5.7s** | **2,198 µ$** |

**质量**：deepseek bs=1/10/20 盲评均值完全相同（adequacy 4.67、fluency 5.00，n=3）；同输入重复输出 bigram F1 0.89（文章）/0.98（视频）。**解析/ID 覆盖率 100%，无漏返/空/重复/语言错误。**

### 3.3 Qwen Flash：thinking 是主要风险

| 任务 | bs | 单次 wall | reasoning tokens | 结果 |
|---|---:|---:|---:|---|
| 文章 | 1 | 8.5s | 481 | OK |
| 文章 | 5 | 56.3s | 5,238（占 completion 92%） | OK |
| 文章 | 10 | 95.9s | 6,446（88%） | OK |
| 文章 | 20 | 121.6s / 180s 超时 | 10,049 | 2 次仅 1 成功 |
| 视频 | 5–40 | 7.7–41.7s | 300–2,556 | OK |

- Qwen 文章成本是 DeepSeek 的 **1.4–3.0×**，视频便宜 5–25%，但慢 **4–9×**。
- 质量盲评：Qwen bs10/20 有 −0.33/−0.67 adequacy 下降，但 n=3、单评委、bs20 仅 1 次成功，只能算弱信号。
- **关键判断**：这不是“Qwen 不行”，而是 **thinking 未关闭**下的结果；当前 `llm.py` 请求只发 `temperature/response_format`，没有关闭 thinking 的参数。关闭 thinking 是下一项必做实验，不能直接基于本实验把 Qwen 判死。

### 3.4 批大小结论

- **DeepSeek 在 20/40 批内没有出现对齐/解析退化**；延迟和成本随批增大持续改善，但边际收益递减（文章 10→20 仅 14% 延迟收益）。
- **首块延迟**与总延迟是两件事：bs40 单次 5.7s，bs10 单次 2.9s；首批应更小，稳定期再放大。
- 质量样本太小，不能证明 bs20 与 bs1 质量等同；只能说明“没有明显崩坏”。
- 文献支持“批处理通常降质、但提示压缩可缓解”；因此**先压缩 prompt，再扩批**，而不是先扩批。

---

## 4. 外部研究给出的边界

> 以下为外部来源自述；**隔离验证不可用，按未验证处理**。引用只用于方向性判断，不当作语途的实证。

1. **长上下文本身会降低性能**（arXiv 2510.05381, EMNLP 2025 Findings）：即使检索完美，输入变长仍降 13.9%–85%。→ 不要把“窗口够大”当“该塞满”。
2. **文档级翻译随长度变差、靠前句子更好**（arXiv 2412.17592, MT Summit 2025）。
3. **段落级可优于句级，但仍有漏译**（arXiv 2304.03245，18 语向/350 小时人工评估）；**多句一次处理有偶发漏句**（DelTA, arXiv 2410.08143）。
4. **批处理省 2–4× token，但总体上降质**；GPT-4o batch=4 无压缩降 44.6%，加提示压缩可保住 >90%（arXiv 2503.02756）。
5. **DeepSeek JSON 模式无法识别 JSON 时可能返回纯空格 content**（官方 JSON Output 文档）；即使 `finish_reason=stop`，也可能空。→ 必须空响应重试 + 条数/index 校验。
6. **DeepSeek 默认 thinking 开启**（官方价目/文档）；翻译应显式关闭。
7. **评估不能只用 BLEU**；COMET 更接近人工，但需参考；LLM-as-judge 只适合系统级 pairwise，单句绝对分不可靠。

**方向性结论**：  
- 质量对上下文长度是倒 U：太短丢指代/术语，太长降质/漏句。  
- 工程上真正的风险不是平均质量，而是**漏句、空响应、错位、重试放大成本**。  
- 所以方案必须是“**小批首屏 + 适中稳定批 + 强校验 + 可修复**”，而不是单纯追求大批。

---

## 5. 推荐方案：参数与架构

### 5.1 分批策略（核心）

采用**双阈值**：`首个块小批` + `稳定期按 token/字符预算`。

| 链路 | 首批 | 稳定批 | 硬上限 | 并发 | 依据 |
|---|---:|---:|---|---:|---|
| 视频 SSE | **10 blocks** | **40 blocks** | ≤2,000 源 token 或 12,000 字符 | 2（首块优先） | 实验 bs10 2.9s 首屏；bs40 5.7s/40 块，边际成本最低 |
| 文章 | **5 段** | **20 段** | ≤2,000 源 token 或 8,000 字符 | 2（有序） | 实验 bs5 4.1s 首块；bs20 11.5s 整篇、成本最低 |
| 公版书 | 4 段 | 8 段/12k 字符 | ≤2,000 源 token | 3 | 保持现状，等书籍专项实验；不凭直觉扩大 |
| 导入书 | 4 段 | 8 段/12k | ≤2,000 源 token | 2 | 目前串行，先并行再调批 |
| 本地剧集 | 10 | 20 | ≤2,000 源 token | 2 | 与视频同构；先修“任一批失败整集不缓存” |
| 本地视频 | 10 | 20 | ≤2,000 源 token | 2 | 与视频同构；必须加缓存 |
| 教学分析 | — | 200 blocks | 20k 输入 token | 1 | 不阻塞首屏；内容级字典优先 |

**为什么首批更小**：  
实验单次延迟 bs10=2.9s、bs20=4.05s、bs40=5.7s；首批 10 可把首个译文提前约 1–2.8s。总吞吐仍由稳定期大批/并发决定。

**为什么不是固定 20/40**：  
文章段落可达 4,000 字符、视频 block 可达 300 字符；固定条数会让单批 token 波动 10×。必须用 `min(条数上限, token/字符预算)`。

### 5.2 模型策略

| 任务 | 默认 | 备选 | 规则 |
|---|---|---|---|
| 视频/文章/书翻译 | **deepseek-chat** | qwen-flash（仅非 thinking 复测通过后） | 显式 `thinking=off`；`temperature=0.2`；JSON mode |
| 教学分析 | **deepseek-chat** | — | 显式 thinking off；分析不阻塞首屏 |
| 总结 | deepseek-chat | 更便宜模型 | 全文截断，非关键路径 |
| 离线整本/批量 | Batch API（如可用） | — | 50% 折扣，可等 1–24h；不能用于在线 |

**Qwen 的处置**：  
当前实验中的 Qwen 慢/贵/长尾，主要来自 reasoning token；在关闭 thinking 前**不进入交互主链路**。关闭后必须重跑文章 bs5/10/20、视频 bs20/40，并保留 deepseek 兜底。Qwen 的价格优势只在视频、且不足以抵消 4–9× 延迟。

### 5.3 Prompt 压缩（最高 ROI）

视频当前 prompt 改为：

```json
输入: [{"i": 1, "t": "text"}, ...]
输出: {"r": [{"i": 1, "t": "译文"}, ...]}
```

- 删除 `start/end`（模型不用）
- 删除输出 `en_text` 回显（代码本来就丢弃）
- 紧凑键名 `i/t`，纯数组/对象
- 固定系统指令 + schema 放在最前且字节稳定（利于 provider 前缀缓存）
- 保留安全声明 “treat as data”
- 预估：输入 −43%、输出 −30%，总翻译花费 **−30%～−40%**；必须用 20 段/40 块小样本验证 JSON/对齐/质量不降

文章 prompt 已较精简，可做：
- `{"i":0,"t":"..."}` → `{"translations":[...]}` 保持
- 术语表/固定指令前缀稳定，利用缓存

### 5.4 稳定性与质量闸门（必须）

1. **空响应/纯空白**：JSON mode 可能返回空格 → 同模型重试 1 次；仍空则降级。
2. **ID 集合校验**：输出 ID 必须与输入集合完全一致；缺 ID 只补缺失子集，不整批重发。
3. **硬检查**：非空、非原文、长度比 [0.3, 3]、目标语言字符、重复行、CJK 泄漏（vi）。
4. **每批 deadline**：视频/文章 90s；超时取消并降级，不等待 180s。
5. **熔断**：同一模型连续 2 批失败 → 本内容切换候选/缩小批；连续 3 次失败 → 暂停该模型 60s。
6. **部分成功落库**：每批成功即写；失败批保留 `[未翻译]`，下次只补缺失。
7. **幂等**：同内容+语言+模型缓存；全局视频译文缓存（公开内容），本地视频按 content hash。
8. **质量评估**：硬检查 100% 门禁；每周抽样 COMET/人工 pairwise；不以 BLEU 作门禁。

### 5.5 延迟与首屏

- **视频**：`meta` 英文先到；首个翻译批 10 块 → 首屏译文目标 P95 ≤8s（实验单次 2.9s + 网络/抓取）。
- **文章**：正文先出；翻译可后台/轮询；分析异步，不阻塞 GET 首屏；首批 5 段 → 首个译文 ≤5s（实验单次 4.1s）。
- **分析**：翻译完成后异步触发；UI 显示“语言点生成中”；完成后再合并，`done` 不等待分析（或单独 `analysis` 事件）。
- **并发**：视频 2、文章 2、书 3；全局 4 不变；首批任务优先调度（避免稳定批占满并发）。
- **SLO（待埋点验证）**：
  - 视频首批 P95 ≤8s；300 blocks P95 ≤40s；失败率 <0.5%
  - 文章 20 段 P95 ≤15s；失败率 <0.5%
  - 解析/ID 覆盖 ≥99.9%；分析不阻塞正文

### 5.6 配额与成本模型

当前“1 批=1 单位”与内容长度脱钩：

- 60 批 = 1,200 blocks；一个 1,372-block 讲座必然 429
- 文章 10 段/批，60 批 = 600 段，够 3 篇
- 建议改成 **1 单位 = 100 blocks**：
  - 默认 60 单位/日 = **6,000 blocks**（约 4 个长讲座）
  - 文章按段折算（10 段 ≈ 1 单位）
  - 管理台已经支持按用户覆盖，可继续用
- 或更成熟：**按 token/成本配额**（每用户每日 $ / 每功能 token），但对用户解释成本高；本期先用 blocks 统一，后续再切 token。

**成本目标**：
- 视频 300 blocks：$0.028 → **≤$0.020**（prompt 瘦身）
- 文章 20 段：$0.0028 → **≤$0.0020**
- 分析：6 档等级重算 → 内容级字典 1 次生成 + 本地筛选（目标 −50%+，待专项实验）

---

## 6. 实施顺序（按 ROI）

### P0（1–2 天，低风险、立即收益）

1. 显式关闭 thinking（DeepSeek/Qwen 请求参数；需确认 provider 字段）
2. 视频 prompt 瘦身（去 start/end、去 en_text 回显、紧凑键名）+ 小样本 A/B
3. 空响应/纯空白重试 + ID 覆盖硬校验 + 缺失只补缺失
4. 分析移出首屏关键路径（文章/视频缓存命中路径）
5. 每批 deadline（90s）

**预期**：翻译成本 −30%～−40%；空响应故障显著下降；首屏不再被分析拖住。

### P1（3–5 天，需要实验）

1. token-aware 分批 + 首批小批（视频 10/40、文章 5/20）
2. 文章/本地剧集并发 2（有序合并）
3. 配额单位改 blocks；管理台文案同步
4. 全局视频译文缓存 / 本地视频缓存
5. 计时日志落盘（JSONL）+ content_ref/jobId + P50/P95 看板

**预期**：视频 300 blocks ≤40s；长视频不再中途 429；可观测性从 0 到 1。

### P2（1–2 周，架构级）

1. 内容级 gloss 字典（分析 6 档→1 次）
2. 书籍/导入书专项实验（8 段/12k 是否最优）
3. 自适应缩批（连续失败自动二分）
4. 质量评估流水线（硬检查 + COMET 抽样 + 人工 pairwise）
5. 离线整本翻译走 Batch API（50% 折扣）

---

## 7. 必须补做的实验（当前结论的缺口）

| 实验 | 目的 | 最小设计 |
|---|---|---|
| Qwen thinking off | 判断 Qwen 是否可用 | 同内容 bs5/10/20，thinking on/off，延迟/token/质量 |
| Prompt 瘦身 A/B | 验证 −40% 成本不降质 | 20 段/40 块，老/新 prompt，JSON/ID/质量/成本 |
| Token-aware 分批 | 找真实最优批 | 1k/2k/4k 源 token，P50/P95/失败率 |
| 分析字典化 | 6 档→1 次 | 同内容 6 档，比较成本/质量/延迟 |
| 并发/尾延迟 | 验证 2 路是否足够 | 3/5/10 并发，P95、429、总时长 |
| 书籍 8 段/12k | 书籍最优 | 4/8/16 段，3 并发，质量/超时 |

**质量评估方法**：硬检查（100%）+ 抽样 COMET/人工 pairwise；LLM-as-judge 只做系统级 pairwise，不做单句绝对分门禁。

---

## 8. 明确不推荐

- 为了“省调用”把 batch 无上限扩大：文献与实验都表明收益递减、尾延迟/失败成本上升。
- 用 Qwen 当前 thinking 默认配置跑文章：实测 26–140s、成本 1.4–3×。
- 让分析阻塞翻译/首屏：分析是增强，不是内容可用性的前提。
- 用 BLEU/单句 LLM 打分当质量门禁。
- 用 1 批=1 单位继续做配额：内容长度与额度脱钩，长视频必 429。

---

## 9. 证据与产物

- 生产审计：`/tmp/translation-tuning/pipeline.md`（430 行，代码行号/账本 SQL/内容规模）
- 受控实验：`/tmp/translation-tuning/experiment.md`、`experiment.json`、`charts/`
- 文献：`/tmp/translation-tuning/literature.md`（25 来源；隔离验证不可用，已标注）
- 现有计时：`docs/reports/pipeline-timing-{videos,books,sse}-2026-11-23.md`
- 研究任务图：`t-mwuolufj-c91b`（pipeline/research/experiment 三个 handoff）

---

## 10. 最终建议（一句话）

**先用 prompt 瘦身 + 关闭 thinking + 强校验拿到确定收益；再用 token-aware 的“首批小批/稳定期大批”把延迟和成本同时压下来；分析字典化与配额单位改革放在第二阶段。** 在没有真实 P95 日志之前，不要把任何固定 batch size 称为“最优”；本方案给出的 10/40、5/20 是当前实验与文献约束下的最合理起点，必须用灰度数据继续校准。

---

## 11. P2-31 实施状态（2026-11-24 回填）

任务卡：`TASKS/P2-31-translation-p0.md`；实现：工作区改动（基于 `759eaf5`，按卡要求未提交）。

| P0 项 | 状态 | 落地内容 | 验证 |
|---|---|---|---|
| 1. 关闭 thinking | **已实施（Qwen）** | `MODEL_CATALOG` 的 `qwen-flash`/`qwen-plus` 增加模型级 `thinking_disabled: true`；`llm._generate_openai_compatible` 仅对该标记发 `thinking:{"type":"disabled"}` | `test_translation_hardening.py::test_qwen_payload_sends_thinking_disabled`、`test_deepseek_payload_has_no_thinking_or_unknown_fields` |
| 2. 视频 prompt 瘦身 | **已实施** | 输入 `[{"i","t"}]`（去 start/end）、输出 `{"r":[{"i","t"}]}`（去 en_text 回显）；`_extract_block_list`/`_align_processed_blocks` 兼容新 `r/i/t` 与旧 `blocks/id/en_text/zh_text`；`en_text/start/end` 由输入回填；`translate.v2 → translate.v3` | `test_slim_prompt_and_new_schema_align_backfills_original_fields`、`test_extract_block_list_accepts_r_and_legacy_blocks`、`test_align_accepts_legacy_schema_and_ignores_model_en_text` |
| 3. 空响应 + ID 覆盖稳定化 | **已实施** | 空/纯空白响应同候选重试 1 次；不可解析 JSON 同候选重试 1 次；新 schema 零覆盖时同候选旧 schema 救援一次；缺失 id 只补缺失子集一次；仍缺标 `[未翻译]`；每批只在入口扣 1 次配额 | `test_empty_response_retries_same_candidate_once`、`test_empty_response_after_retry_degrades_and_charges_quota_once`、`test_unparsable_json_retries_same_candidate_once`、`test_missing_ids_only_resend_the_missing_subset`、`test_missing_ids_still_missing_after_one_supplement_marked_untranslated`、`test_zero_coverage_response_rescued_once_with_legacy_schema` |
| 4. 90s 单批 deadline | **已实施** | `translate.TRANSLATE_BATCH_TIMEOUT_SECONDS = 90.0`，`process_llm_batch` 用 `asyncio.wait_for` 包住单次调用；超时按失败进入降级；其他 LLM 调用仍走 provider 180s | `test_translate_batch_timeout_degrades_to_next_candidate`、`test_default_deadline_is_90s_and_llm_timeout_untouched` |
| 5. 分析移出首屏 | 未实施（不在 P2-31 卡范围） | — | — |

**限制说明**：
- DeepSeek Key 当前无效，`thinking` 关闭的收益只在 Qwen 上实测（Qwen 3.8 Flash：关闭后 reasoning_tokens 215→0、completion 261→38、2.19s）；DeepSeek **不发** `thinking` 字段，避免未验证参数导致 400。Qwen 关闭 thinking 后的文章/视频批量质量复测仍待做（§7 第一项）。
- prompt 瘦身的 −30%～−40% 成本收益来自审计/实验推算；本卡只验证 schema/解析/对齐不降级，真实成本下降需灰度账本复核。

**验收（实现时）**：
- `cd backend && venv/bin/python -m pytest -q` → **1529 passed**（P2-31 新增 `tests/test_translation_hardening.py` 15 例；旧测试全绿）。
- `node scripts/agent-preflight.mjs --card P2-31 --base 759eaf5` → 通过（新增测试先 `git add -N` 纳入检查）。说明：卡 `base_sha=e891f15` 早于卡登记提交 `759eaf5`，直接用卡 base 会把 `TASKS/P2-31-translation-p0.md`、`TASKS/board.json` 两个已提交文件算成本次改动；故以 HEAD 为 base 复核写域。
- 未提交（按卡要求），改动仅限卡 `write_scope`。

---

## 11. P0 后续实测：Qwen 关闭 thinking 后（2026-11-24）

> 直接 provider 调用；`thinking:{"type":"disabled"}`；temperature 0.2 / JSON mode；文章/视频同一实验语料；每配置 2 次。

### 结果

| 任务 | bs | wall（关闭 thinking） | 关闭前 wall | completion tokens | reasoning |
|---|---:|---:|---:|---:|---:|
| 文章 | 5 | 8.83–9.92s | 56.3s | 425–479 | 0 |
| 文章 | 10 | 14.41–16.12s | 95.9s | 930–944 | 0 |
| 文章 | 20 | 22.49–28.57s | 121.6s / 180s timeout | 1,934–1,959 | 0 |
| 视频 | 20 | 7.54–8.18s | 13.6s | 641–649 | 0 |
| 视频 | 40 | 11.73–13.50s | 41.7s | 1,272–1,273 | 0 |

- **reasoning 完全消失**；文章 bs20 从 121s→22–29s，视频 bs40 从 41.7s→11.7–13.5s。
- JSON 输出：文章/视频的 ID 覆盖率 100%（一次视频响应是顶层数组，不是 `{"r":...}`；应用 `_extract_block_list` 能兼容，提示词仍建议对象）。
- 成本（按 P1-20 价格）：
  - 文章 bs20：Qwen 约 **994 µUSD/篇** vs DeepSeek **2,794 µUSD/篇**（约 **-64%**）
  - 视频 bs40：Qwen 约 **604 µUSD/40 blocks** vs DeepSeek **2,198 µUSD/40 blocks**（约 **-72%**）

### 判断更新

- 之前“Qwen 文章成本 1.4–3× DeepSeek”的结论**只成立于 thinking 开启时**；关闭后 Qwen 反而显著便宜。
- 但 Qwen 仍比 DeepSeek 慢约 **1.5–2.5×**（文章 bs20 22–29s vs 11.5s；视频 bs40 11.7–13.5s vs 5.7s）。
- 质量：本批 2 次翻译文本可读、ID 完整，但没有盲评/人工金标，不能宣布质量等同。
- **默认策略不变**：交互首屏仍用 DeepSeek；Qwen 可作为**后台/离线/成本敏感**路径候选，或稳定期后续批（不影响首屏）的 A/B 候选。
- 需要补一次正式质量盲评（Qwen vs DeepSeek，同一批文章/视频，至少 10 段/20 块、双评委）后再决定是否路由。
