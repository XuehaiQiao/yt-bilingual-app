# CEFR M2 内容锚 · 15 条分歧仲裁包（2026-11-17）

> schema：`cefr-anchor-adjudication.v1` ｜ 状态：**待仲裁（0/15 已填）** ｜ 生成脚本：`scripts/build_cefr_anchor_adjudication.py`（确定性输出，同输入重跑逐字节一致）
> 配套填写表：[`cefr-anchor-adjudication-sheet-2026-11-17.csv`](cefr-anchor-adjudication-sheet-2026-11-17.csv) ｜ 上一环：[60 条盲评包](cefr-anchor-packet-2026-11-17.md) ｜ 背景：[锚校准报告](cefr-anchor-report-2026-11-17.md)

## 0. 这是什么、要你做什么

- 60 条内容锚已完成两位评审的独立评分：45 条完全一致，**15 条相差恰好 1 带**（无跨两带）。
- 这 15 条需要**第三位评审/教研负责人**（或两位评审讨论后的定稿人）各给**一个** band，形成 consensus 标签。
- 你不需要评另外 45 条，也不需要给整批内容重新定级。
- 仲裁只产出**标签**：**不改**任何词典、阈值或内容数据，不触发自动难度调参。

## 1. 包里有什么、刻意没有什么

| 有 | 没有（故意的） |
|---|---|
| 15 条内容本身（文本给 ≤120 词摘录；第三方视频给链接 + 时间窗） | 机器自动预测的 band |
| 评审 A / B 各自的 band、置信度、理由节选 | 编辑标注的 band |
| 仲裁规则与 CEFR 描述符（§2） | 调参集/holdout 归属 |
| 空白填写表（15 行） | 其他 45 条的评分与来源映射 |

> 不显示机器预测带与编辑标注是为了避免锚定：看到「机器判 C1」或「编辑标 A2」再去选，得到的不是独立判断。
> 脚本对每个条目块做了机器断言（条目块内只允许出现该条 A/B 两个 band 名，且不含上述字段字样），见 §6。

## 2. 仲裁规则

### 2.1 判什么：整体理解难度，不是单词难度

要判的是：**处在目标 band 的学习者，不查词、不借助译文，能不能一遍拿到主旨与主要细节。**
不是数生词、不是看标题话题，也不是看作者名气。

**不算「升级」的情形**（只影响局部，不改变整体可理解度）：

- 单个低频/旧式具体词（如 bonnet、gig、currant buns），其余句子仍是简单叙事；
- 专有名词、人名地名、书内虚构名；
- 术语在上下文里被解释、或被例子反复支撑（教学视频、科普旁白的常见做法）；
- 数字、日期、单位、标点造成的视觉密度。

**算「升级」的情形**（整体负荷，会叠加）：

- 需要**推断**说话人立场、反讽、隐含前提，或论证跨越多段才能拼出结论；
- 名词化、多重嵌套从句、省略/倒装/非谓语密集出现（不是偶发一两句）；
- 信息密度高：单位时间内新概念多，且没有停顿、重复、板书辅助；
- 语速 + 连读/弱读 + 口音/背景音共同抬高听力门槛（视频按「听」判，不按字幕稿判）；
- 语域跨度大（旧式书面语、法律/学术套语、方言口语），词都认识也要额外解析。

### 2.2 CEFR 描述符（与本轮盲评包同一 rubric，只给用得到的四带）

| 带 | 词汇 | 句法 | 篇章 / 信息 | 听力（仅视频） |
|---|---|---|---|---|
| **A2** | 日常高频词；少量高频短语 | 简单句 + 基础连接（and/but/because）；常见时态 | 2–5 句的短段落；直接信息；结构可预测 | 慢速、清晰、标准口音；话题日常 |
| **B1** | 常见词为主；少量抽象词、短语动词 | 主从复合句；常见连接词；叙事/说明有层次 | 多段短文；主旨 + 若干细节；有明确结构 | 正常偏慢；清晰标准口音；少量习语/连读 |
| **B2** | 词汇较丰富；抽象/专业词增多 | 多重从句、非谓语、被动等复杂结构 | 长段落；观点、论证、隐含关系；需推断 | 正常语速；有连读/弱读；话题抽象或专业 |
| **C1** | 词汇广；习语、隐喻、语域变化 | 复杂句法、省略、倒装、名词化等 | 长而密集；隐含意义、立场、修辞；需综合理解 | 接近自然语速；口音/语域变化；信息密度高 |

### 2.3 只差一带时怎么选（本包 15 条全部是相邻带分歧）

1. **先整体、后局部**：先通读/通听一遍，凭第一印象定一带；再用描述符核对词汇、句法、篇章三项，看是否有两项以上支持另一带。三项里只有一项擦边 → 维持第一印象。
2. **不取平均、不搞多数票**：band 没有中间档，「A 说 B2、B 说 C1」不等于各一半；也不要用「评审 A 在 14/15 条里都比 B 高」去反向修正（见 §2.5）。
3. **边界五五开时的默认**：选**较低**带、confidence 设 1，并在 reason 里写明「另一带是 X，为什么」。这与盲评包原有 rubric（边界取较低带）一致，也让后续敏感性分析有据可查。
4. **只差一带的典型判据**（可直接对照）：
   - **A2/B1**：情节/话题能否只靠日常词与简单句串起来？出现过去完成时、so…that、定语从句但仍一眼可懂 → 仍可 A2；若需要跟着时间线、人物关系做一点推断，且这类句子成片出现 → B1。
   - **B1/B2**：是否出现了**成段的论证**（而不只是叙事 + 结论）？要理解「为什么」而不只是「发生了什么」→ B2；若论证被例子反复解释、句子偏短 → B1。
   - **B2/C1**：是否要**同时**处理抽象概念、隐含立场与高密度信息？术语多但有解释、语速中等 → B2；术语密集且连续解释机制、几乎不给喘息 → C1。
5. **不确定就写下来**：reason 里写清「哪一带、为什么、还差什么证据」，比一个没有依据的 band 更有用。

### 2.4 置信度

- **3** = 确定；**2** = 比较确定；**1** = 在相邻两带之间摇摆（边界判断）。
- 视频条目若只看了字幕、没有实际听音，请把 confidence 设为 1，并在 reason 写明「仅字幕」。

### 2.5 两条已观测到的偏差（只作提醒，不是答案）

- 两位评审里 **A 在 15 条分歧中有 14 条给出更高的 band**，两人平均 band 只差 0.22 带（A 2.92 / B 2.70）。这说明分歧是同一批边界的两种读法，而不是「一边全对」；请独立判断，不要默认向 A 靠。
- 本批材料**整体**存在来源标注与人工判断的系统性差异（已在锚报告里量化）。包内不提供任何来源等级，请不要用「出版社/年代/频道会怎么标」反推答案。

### 2.6 独立性与保密

- 不要打开 `cefr-anchor-truth-2026-11-17.json`、`cefr-anchor-baseline-2026-11-17.*`、`cefr-anchor-analysis-2026-11-17.json`；不要搜索条目的原始等级。
- 不要与评审 A/B 讨论，也不要看他们的完整答案表（本包已摘录各自理由，足够仲裁）。
- 仲裁只决定这 15 条；评审间一致性（κ）仍按 A/B 的独立标签报告，**不会**用仲裁结果去修饰。

## 3. 15 条清单（按匿名 id 排序，与填写表逐行对应）

| # | 匿名 id | 类型 | 标题 | 评审 A | 评审 B | 复核优先级 |
|---|---|---|---|---|---:|---:|---|
| 01 | `M2-001` | 视频 | What Is an AI Anyway? ｜ Mustafa Suley… | B2 | C1 | 边界 |
| 02 | `M2-004` | 视频 | Talking about sleep 😴 🛏️  Real Easy E… | B1 | A2 | 优先 |
| 03 | `M2-009` | 文本 | 定位测短文 fa-p1 | B1 | A2 | 优先 |
| 04 | `M2-011` | 文本 | The Hidden Cost of a Free App | B2 | B1 | 边界 |
| 05 | `M2-013` | 视频 | The hidden network that makes the int… | C1 | B2 | 优先 |
| 06 | `M2-014` | 视频 | Talking about meetings 🗓️🤝👔 Real Easy… | B1 | A2 | 优先 |
| 07 | `M2-018` | 文本 | The Tale of Peter Rabbit | B1 | A2 | 边界 |
| 08 | `M2-027` | 视频 | What Makes a Good Life? Lessons from … | B2 | B1 | 优先 |
| 09 | `M2-028` | 视频 | How Language Shapes the Way We Think … | C1 | B2 | 优先 |
| 10 | `M2-036` | 视频 | Cultural differences and body languag… | B2 | B1 | 边界 |
| 11 | `M2-038` | 文本 | The Tale of Two Bad Mice | B1 | A2 | 边界 |
| 12 | `M2-052` | 文本 | The Tale of Squirrel Nutkin | B1 | A2 | 边界 |
| 13 | `M2-056` | 视频 | The Rise, Bankruptcy and Rebirth of 2… | C1 | B2 | 优先 |
| 14 | `M2-057` | 文本 | The Memoirs of Sherlock Holmes | C1 | B2 | 边界 |
| 15 | `M2-059` | 文本 | The Tale of Benjamin Bunny | B1 | A2 | 边界 |

- **优先** = 两位评审置信度都 ≥2（不是「低置信度摇摆」能解释的实质分歧），共 7 条：`M2-004`, `M2-009`, `M2-013`, `M2-014`, `M2-027`, `M2-028`, `M2-056`。
- **边界** = 至少一位置信度为 1，其余 8 条。
- 建议顺序：先做 7 条「优先」，再做 8 条「边界」；顺序不影响结论。

## 4. 逐条材料

> 每条只有三块信息：内容 / 评审 A / 评审 B，末尾一个仲裁问题。视频请实际听音，文本只看给的这段摘录。

### 仲裁 01 ｜ `M2-001` ｜ 精选视频（YouTube 嵌入）

- **内容**：What Is an AI Anyway? | Mustafa Suleyman | TED（频道：TED，时长 22:02）
- **链接**：https://www.youtube.com/watch?v=KKNCiRWd_j0
- **时间窗 1**：01:16–02:46（约 90 秒，254 词）— https://www.youtube.com/watch?v=KKNCiRWd_j0&t=76s
- **时间窗 2**：18:52–20:22（约 90 秒，295 词）— https://www.youtube.com/watch?v=KKNCiRWd_j0&t=1132s
- **怎么评**：按**听**的难度判断（可开自动字幕辅助听清，但字幕稿不是评分对象）；第三方视频只给链接 + 时间窗，包内不转载字幕。

- **评审 A**：band **B2** ｜ 置信度 1 ｜ 理由（评审原话节选）：两窗词速约169/197 wpm；autonomy、recursive self-improvement、oversight 等抽象术语搭配多重从句，风险论证信息密度较高；整体在 B2/C1 边界，按规则取 B2。依据两窗英文字幕。
- **评审 B**：band **C1** ｜ 置信度 2 ｜ 理由（评审原话节选）：两窗字幕可定位；约169/197 wpm，递归自我改进、自主性阈值等术语密集，长句与风险推演要求高。

- **仲裁问题：这条内容整体更接近哪一带？** → [ ] B2　[ ] C1（若两者都不对，可填描述符里任一合法 band，并在 reason 写明理由）

### 仲裁 02 ｜ `M2-004` ｜ 精选视频（YouTube 嵌入）

- **内容**：Talking about sleep 😴 🛏️  Real Easy English（频道：BBC Learning English，时长 5:29）
- **链接**：https://www.youtube.com/watch?v=yLu_M4yiCho
- **时间窗 1**：01:53–02:53（约 60 秒，162 词）— https://www.youtube.com/watch?v=yLu_M4yiCho&t=113s
- **时间窗 2**：03:00–04:00（约 60 秒，157 词）— https://www.youtube.com/watch?v=yLu_M4yiCho&t=180s
- **怎么评**：按**听**的难度判断（可开自动字幕辅助听清，但字幕稿不是评分对象）；第三方视频只给链接 + 时间窗，包内不转载字幕。

- **评审 A**：band **B1** ｜ 置信度 2 ｜ 理由（评审原话节选）：两窗词速约162/157 wpm；nightmare、robbers 等日常叙事词，过去简单时与过去进行时为主，教学对话重复解释，信息密度中低。依据两窗英文字幕。
- **评审 B**：band **A2** ｜ 置信度 3 ｜ 理由（评审原话节选）：两窗字幕可定位；约162/157 wpm，日常梦境词汇，过去时短句和问答为主，信息直接。

- **仲裁问题：这条内容整体更接近哪一带？** → [ ] B1　[ ] A2（若两者都不对，可填描述符里任一合法 band，并在 reason 写明理由）

### 仲裁 03 ｜ `M2-009` ｜ 原创定位测短文（草稿）

- **字数**：79 词
- **出典**：LinguaTrek 自写短文（定位测题库草稿，未经 pilot）；包内给全文

> Last Tuesday, Mina left her umbrella on the bus. It was a blue umbrella with a wooden handle, and it had been a birthday present from her sister. At first she thought it was gone forever. The next morning, however, the bus company called. A driver had found the umbrella and kept it in the office. Mina walked to the station after work and collected it. She was so happy that she brought the driver a box of tea.

- **怎么评**：只根据上面这段文本判断书面语难度；不要用标题/作者/年代去猜等级。

- **评审 A**：band **B1** ｜ 置信度 2 ｜ 理由（评审原话节选）：umbrella、wooden handle、collected 等日常词；过去时叙事中含过去完成时和 so...that 结构，事件顺序清楚并带少量情绪细节。
- **评审 B**：band **A2** ｜ 置信度 2 ｜ 理由（评审原话节选）：日常叙事词汇；一般过去时为主，含少量过去完成时和 so...that，情节直接。

- **仲裁问题：这条内容整体更接近哪一带？** → [ ] B1　[ ] A2（若两者都不对，可填描述符里任一合法 band，并在 reason 写明理由）

### 仲裁 04 ｜ `M2-011` ｜ 原创文章节选

- **字数**：94 词
- **出典**：LinguaTrek 编辑部原创，随仓库分发；包内给节选

> Most of us have dozens of apps on our phones, and most of them were free to download. That word, free, feels simple. But when a product costs nothing, it is worth asking what we are paying with instead. The first price is attention. Free apps are often designed to keep us scrolling. Notifications pull us back, streaks make us return, and autoplay removes the moment when we might decide to stop. The longer we stay, the more advertisements we see. In this model, our time becomes the product that is sold to advertisers.

- **怎么评**：只根据上面这段文本判断书面语难度；不要用标题/作者/年代去猜等级。

- **评审 A**：band **B2** ｜ 置信度 2 ｜ 理由（评审原话节选）：attention、streaks、autoplay、advertisers 等数字产品词；设问、被动和定语从句解释免费应用如何把用户时间商品化，需理解隐含商业模式。
- **评审 B**：band **B1** ｜ 置信度 1 ｜ 理由（评审原话节选）：B1/B2 边界；attention、autoplay、advertisers 等词和反问构成抽象论证，但句子多短且关系直接。

- **仲裁问题：这条内容整体更接近哪一带？** → [ ] B2　[ ] B1（若两者都不对，可填描述符里任一合法 band，并在 reason 写明理由）

### 仲裁 05 ｜ `M2-013` ｜ 精选视频（YouTube 嵌入）

- **内容**：The hidden network that makes the internet possible - Sajan Saini（频道：TED-Ed，时长 5:19）
- **链接**：https://www.youtube.com/watch?v=er3v4PVNQqE
- **时间窗 1**：01:27–02:27（约 60 秒，153 词）— https://www.youtube.com/watch?v=er3v4PVNQqE&t=87s
- **时间窗 2**：02:54–03:54（约 60 秒，152 词）— https://www.youtube.com/watch?v=er3v4PVNQqE&t=174s
- **怎么评**：按**听**的难度判断（可开自动字幕辅助听清，但字幕稿不是评分对象）；第三方视频只给链接 + 时间窗，包内不转载字幕。

- **评审 A**：band **C1** ｜ 置信度 2 ｜ 理由（评审原话节选）：两窗词速约153/152 wpm；refracts、wavelengths、integrated photonics、ultrathin silicon 等术语密集，复杂句连续解释光学机制和芯片转换，信息密度高。依据两窗英文字幕。
- **评审 B**：band **B2** ｜ 置信度 2 ｜ 理由（评审原话节选）：两窗字幕可定位；约153/152 wpm，refraction、fiber optics、integrated photonics 等术语，条件句和因果说明密集但语速中等。

- **仲裁问题：这条内容整体更接近哪一带？** → [ ] C1　[ ] B2（若两者都不对，可填描述符里任一合法 band，并在 reason 写明理由）

### 仲裁 06 ｜ `M2-014` ｜ 精选视频（YouTube 嵌入）

- **内容**：Talking about meetings 🗓️🤝👔 Real Easy English（频道：BBC Learning English，时长 5:51）
- **链接**：https://www.youtube.com/watch?v=TL61VKkme14
- **时间窗 1**：00:26–01:26（约 60 秒，154 词）— https://www.youtube.com/watch?v=TL61VKkme14&t=26s
- **时间窗 2**：02:56–03:56（约 60 秒，145 词）— https://www.youtube.com/watch?v=TL61VKkme14&t=176s
- **怎么评**：按**听**的难度判断（可开自动字幕辅助听清，但字幕稿不是评分对象）；第三方视频只给链接 + 时间窗，包内不转载字幕。

- **评审 A**：band **B1** ｜ 置信度 2 ｜ 理由（评审原话节选）：两窗词速约154/145 wpm；colleagues、facial expressions、time zones 等常见工作词，条件句和偏好表达不难，教学对话信息密度中低。依据两窗英文字幕。
- **评审 B**：band **A2** ｜ 置信度 3 ｜ 理由（评审原话节选）：两窗字幕可定位；约154/145 wpm，会议与情绪日常词，短问答和基础状语从句，信息直接。

- **仲裁问题：这条内容整体更接近哪一带？** → [ ] B1　[ ] A2（若两者都不对，可填描述符里任一合法 band，并在 reason 写明理由）

### 仲裁 07 ｜ `M2-018` ｜ 公版书节选（Project Gutenberg）

- **字数**：116 词
- **出典**：Beatrix Potter《The Tale of Peter Rabbit》（1902），Project Gutenberg #14838；美国公版（https://www.gutenberg.org/ebooks/14838）

> Once upon a time there were four little Rabbits, and their names were-- Flopsy, Mopsy, Cotton-tail, and Peter. They lived with their Mother in a sand-bank, underneath the root of a very big fir-tree. 'Now my dears,' said old Mrs. Rabbit one morning, 'you may go into the fields or down the lane, but don't go into Mr. McGregor's garden: your Father had an accident there; he was put in a pie by Mrs. McGregor.' 'Now run along, and don't get into mischief. I am going out.' Then old Mrs. Rabbit took a basket and her umbrella, and went through the wood to the baker's. She bought a loaf of brown bread and five currant buns.

- **怎么评**：只根据上面这段文本判断书面语难度；不要用标题/作者/年代去猜等级。

- **评审 A**：band **B1** ｜ 置信度 2 ｜ 理由（评审原话节选）：fir-tree、lane、mischief、currant buns 等少量旧式具体词；以过去时和直接引语推进故事，含过去完成时与被动但情节直接。
- **评审 B**：band **A2** ｜ 置信度 1 ｜ 理由（评审原话节选）：A2/B1 边界；sand-bank、mischief、currant buns 等具体词稍难，过去时叙事和顺序关系简单。

- **仲裁问题：这条内容整体更接近哪一带？** → [ ] B1　[ ] A2（若两者都不对，可填描述符里任一合法 band，并在 reason 写明理由）

### 仲裁 08 ｜ `M2-027` ｜ 精选视频（YouTube 嵌入）

- **内容**：What Makes a Good Life? Lessons from the Longest Study on Happiness | Robert Waldinger | TED（频道：TED，时长 12:47）
- **链接**：https://www.youtube.com/watch?v=8KkKuTCFvzI
- **时间窗 1**：04:39–05:54（约 75 秒，188 词）— https://www.youtube.com/watch?v=8KkKuTCFvzI&t=279s
- **时间窗 2**：07:13–08:28（约 75 秒，208 词）— https://www.youtube.com/watch?v=8KkKuTCFvzI&t=433s
- **怎么评**：按**听**的难度判断（可开自动字幕辅助听清，但字幕稿不是评分对象）；第三方视频只给链接 + 时间窗，包内不转载字幕。

- **评审 A**：band **B2** ｜ 置信度 2 ｜ 理由（评审原话节选）：两窗词速约150/166 wpm；questionnaires、committed relationship、affection、octogenarian、cholesterol 等词配合多层主从句，报告研究发现并解释关系质量，信息密度中等。依据两窗英文字幕。
- **评审 B**：band **B1** ｜ 置信度 2 ｜ 理由（评审原话节选）：两窗字幕可定位；约150/166 wpm，研究和关系词汇常见，句子层次清楚，以实例和直接结论为主。

- **仲裁问题：这条内容整体更接近哪一带？** → [ ] B2　[ ] B1（若两者都不对，可填描述符里任一合法 band，并在 reason 写明理由）

### 仲裁 09 ｜ `M2-028` ｜ 精选视频（YouTube 嵌入）

- **内容**：How Language Shapes the Way We Think | Lera Boroditsky | TED（频道：TED，时长 14:13）
- **链接**：https://www.youtube.com/watch?v=RKK7wGAYP6k
- **时间窗 1**：05:28–06:43（约 75 秒，262 词）— https://www.youtube.com/watch?v=RKK7wGAYP6k&t=328s
- **时间窗 2**：11:03–12:18（约 75 秒，230 词）— https://www.youtube.com/watch?v=RKK7wGAYP6k&t=663s
- **怎么评**：按**听**的难度判断（可开自动字幕辅助听清，但字幕稿不是评分对象）；第三方视频只给链接 + 时间窗，包内不转载字幕。

- **评审 A**：band **C1** ｜ 置信度 2 ｜ 理由（评审原话节选）：两窗词速约210/184 wpm；egocentric、coordinate frames、cognitive realm、perceptual、grammatical gender 等抽象术语密集，综合语言与认知关系，信息密度高。依据两窗英文字幕。
- **评审 B**：band **B2** ｜ 置信度 2 ｜ 理由（评审原话节选）：两窗字幕可定位；约210/184 wpm，egocentric、coordinate frames、cognitive 等抽象词，例证反复支撑概念，句法中等复杂。

- **仲裁问题：这条内容整体更接近哪一带？** → [ ] C1　[ ] B2（若两者都不对，可填描述符里任一合法 band，并在 reason 写明理由）

### 仲裁 10 ｜ `M2-036` ｜ 精选视频（YouTube 嵌入）

- **内容**：Cultural differences and body language - 6 Minute English（频道：BBC Learning English，时长 6:12）
- **链接**：https://www.youtube.com/watch?v=oTPZWpQ9pbA
- **时间窗 1**：01:41–02:56（约 75 秒，238 词）— https://www.youtube.com/watch?v=oTPZWpQ9pbA&t=101s
- **时间窗 2**：04:05–05:20（约 75 秒，238 词）— https://www.youtube.com/watch?v=oTPZWpQ9pbA&t=245s
- **怎么评**：按**听**的难度判断（可开自动字幕辅助听清，但字幕稿不是评分对象）；第三方视频只给链接 + 时间窗，包内不转载字幕。

- **评审 A**：band **B2** ｜ 置信度 2 ｜ 理由（评审原话节选）：两窗词速均约190 wpm；faux pas、gesticulate、no hard feelings、fall out with 等习语词组较多，虽有教学释义但自然叙事和复习节奏较快，信息密度中等。依据两窗英文字幕。
- **评审 B**：band **B1** ｜ 置信度 1 ｜ 理由（评审原话节选）：B1/B2 边界；两窗字幕可定位，约190/190 wpm，faux pas、gesticulate 等习语有释义，访谈叙事较长但信息直接。

- **仲裁问题：这条内容整体更接近哪一带？** → [ ] B2　[ ] B1（若两者都不对，可填描述符里任一合法 band，并在 reason 写明理由）

### 仲裁 11 ｜ `M2-038` ｜ 公版书节选（Project Gutenberg）

- **字数**：102 词
- **出典**：Beatrix Potter《The Tale of Two Bad Mice》（1904），Project Gutenberg #45264；美国公版（https://www.gutenberg.org/ebooks/45264）

> ONCE upon a time there was a very beautiful doll's-house; it was red brick with white windows, and it had real muslin curtains and a front door and a chimney. IT belonged to two Dolls called Lucinda and Jane; at least it belonged to Lucinda, but she never ordered meals. Jane was the Cook; but she never did any cooking, because the dinner had been bought ready-made, in a box full of shavings. THERE were two red lobsters and a ham, a fish, a pudding, and some pears and oranges. They would not come off the plates, but they were extremely beautiful.

- **怎么评**：只根据上面这段文本判断书面语难度；不要用标题/作者/年代去猜等级。

- **评审 A**：band **B1** ｜ 置信度 2 ｜ 理由（评审原话节选）：muslin curtains、ready-made、shavings、lobsters 等旧式具体词；过去时、被动和原因从句构成直接叙事，物品描写细节较多但句法负荷有限。
- **评审 B**：band **A2** ｜ 置信度 1 ｜ 理由（评审原话节选）：A2/B1 边界；muslin、shavings 等具体词稍难，基本过去时与并列句叙事，情节直观。

- **仲裁问题：这条内容整体更接近哪一带？** → [ ] B1　[ ] A2（若两者都不对，可填描述符里任一合法 band，并在 reason 写明理由）

### 仲裁 12 ｜ `M2-052` ｜ 公版书节选（Project Gutenberg）

- **字数**：117 词
- **出典**：Beatrix Potter《The Tale of Squirrel Nutkin》（1903），Project Gutenberg #14872；美国公版（https://www.gutenberg.org/ebooks/14872）

> This is a Tale about a tail--a tail that belonged to a little red squirrel, and his name was Nutkin. He had a brother called Twinkleberry, and a great many cousins: they lived in a wood at the edge of a lake. In the middle of the lake there is an island covered with trees and nut bushes; and amongst those trees stands a hollow oak-tree, which is the house of an owl who is called Old Brown. One autumn when the nuts were ripe, and the leaves on the hazel bushes were golden and green--Nutkin and Twinkleberry and all the other little squirrels came out of the wood, and down to the edge of the lake.

- **怎么评**：只根据上面这段文本判断书面语难度；不要用标题/作者/年代去猜等级。

- **评审 A**：band **B1** ｜ 置信度 2 ｜ 理由（评审原话节选）：hollow oak-tree、owl、ripe、hazel bushes 等自然描写词；长句含多个定语和并列成分，童话场景与角色关系仍直接。
- **评审 B**：band **A2** ｜ 置信度 1 ｜ 理由（评审原话节选）：A2/B1 边界；hollow、hazel、ripe 等具体词稍难，基本叙事句与定语从句，情节直观。

- **仲裁问题：这条内容整体更接近哪一带？** → [ ] B1　[ ] A2（若两者都不对，可填描述符里任一合法 band，并在 reason 写明理由）

### 仲裁 13 ｜ `M2-056` ｜ 精选视频（YouTube 嵌入）

- **内容**：The Rise, Bankruptcy and Rebirth of 23andMe | The Circuit（频道：Bloomberg Originals，时长 31:32）
- **链接**：https://www.youtube.com/watch?v=DX_HLqz7l2g
- **时间窗 1**：09:33–11:03（约 90 秒，280 词）— https://www.youtube.com/watch?v=DX_HLqz7l2g&t=573s
- **时间窗 2**：26:03–27:33（约 90 秒，301 词）— https://www.youtube.com/watch?v=DX_HLqz7l2g&t=1563s
- **怎么评**：按**听**的难度判断（可开自动字幕辅助听清，但字幕稿不是评分对象）；第三方视频只给链接 + 时间窗，包内不转载字幕。

- **评审 A**：band **C1** ｜ 置信度 2 ｜ 理由（评审原话节选）：两窗词速约187/201 wpm；chapter 11、bidding process、resilient 等词夹杂大量 like/you know、重叠话语和即兴玩笑，个人叙事隐含情绪且信息密度高。依据两窗英文字幕。
- **评审 B**：band **B2** ｜ 置信度 2 ｜ 理由（评审原话节选）：两窗字幕可定位；约187/201 wpm，多人自然对话含大量填充语与短轮次，bankruptcy、chapter 11 等词，后半信息较个人化。

- **仲裁问题：这条内容整体更接近哪一带？** → [ ] C1　[ ] B2（若两者都不对，可填描述符里任一合法 band，并在 reason 写明理由）

### 仲裁 14 ｜ `M2-057` ｜ 公版书节选（Project Gutenberg）

- **字数**：99 词
- **出典**：Arthur Conan Doyle《The Memoirs of Sherlock Holmes》（1894），Project Gutenberg #834；美国公版（https://www.gutenberg.org/ebooks/834）

> It was evening before we reached the little town of Tavistock, which lies, like the boss of a shield, in the middle of the huge circle of Dartmoor. Two gentlemen were awaiting us in the station—the one a tall, fair man with lion-like hair and beard and curiously penetrating light blue eyes; the other a small, alert person, very neat and dapper, in a frock-coat and gaiters, with trim little side-whiskers and an eye-glass. The latter was Colonel Ross, the well-known sportsman; the other, Inspector Gregory, a man who was rapidly making his name in the English detective service.

- **怎么评**：只根据上面这段文本判断书面语难度；不要用标题/作者/年代去猜等级。

- **评审 A**：band **C1** ｜ 置信度 2 ｜ 理由（评审原话节选）：boss of a shield、penetrating、dapper、frock-coat、gaiters、the latter 等旧式描写词；长名词短语、明喻和分号并列形成高密度人物刻画。
- **评审 B**：band **B2** ｜ 置信度 1 ｜ 理由（评审原话节选）：B2/C1 边界；penetrating、dapper、gaiters 等描写词较难，多重同位语但句意直接。

- **仲裁问题：这条内容整体更接近哪一带？** → [ ] C1　[ ] B2（若两者都不对，可填描述符里任一合法 band，并在 reason 写明理由）

### 仲裁 15 ｜ `M2-059` ｜ 公版书节选（Project Gutenberg）

- **字数**：109 词
- **出典**：Beatrix Potter《The Tale of Benjamin Bunny》（1904），Project Gutenberg #14407；美国公版（https://www.gutenberg.org/ebooks/14407）

> One morning a little rabbit sat on a bank. He pricked his ears and listened to the trit-trot, trit-trot of a pony. A gig was coming along the road; it was driven by Mr. McGregor, and beside him sat Mrs. McGregor in her best bonnet. As soon as they had passed, little Benjamin Bunny slid down into the road, and set off--with a hop, skip, and a jump--to call upon his relations, who lived in the wood at the back of Mr. McGregor's garden. That wood was full of rabbit holes; and in the neatest, sandiest hole of all lived Benjamin's aunt and his cousins--Flopsy, Mopsy, Cotton-tail, and Peter.

- **怎么评**：只根据上面这段文本判断书面语难度；不要用标题/作者/年代去猜等级。

- **评审 A**：band **B1** ｜ 置信度 2 ｜ 理由（评审原话节选）：pricked、gig、bonnet、call upon his relations 等旧式具体词和短语；以过去时、定语从句及并列动作推进直接叙事。
- **评审 B**：band **A2** ｜ 置信度 1 ｜ 理由（评审原话节选）：A2/B1 边界；pricked、gig、bonnet 等旧式具体词，as soon as 与定语从句服务于简单叙事。

- **仲裁问题：这条内容整体更接近哪一带？** → [ ] B1　[ ] A2（若两者都不对，可填描述符里任一合法 band，并在 reason 写明理由）

## 5. 怎么填

填写表 `cefr-anchor-adjudication-sheet-2026-11-17.csv`，列定义：

| 列 | 填什么 | 合法值 |
|---|---|---|
| `anon_id` | 不要改 | 15 个 `M2-0xx` |
| `adjudicated_band` | 你定的 band | `A1` / `A2` / `B1` / `B2` / `C1`（**只填一个**，不要写 `B2/C1`、不要写 `B2+`） |
| `adjudicator` | 仲裁者代号 | 如 `J-01`（不写真实姓名） |
| `reason` | 1–3 句依据 | 引用 §2 描述符或具体证据（哪句/哪段让你定在这一带） |
| `confidence` | 置信度 | `3` / `2` / `1` |

15 行都填完才算完成；只填一部分时重算脚本输出 `pending`，不产生任何数字。

## 6. 生成自检（脚本每次生成都跑，失败即不产出文件）

1. 分歧条目恰为 15 条、全部 `|A−B| = 1`，id 与 truth 一一对应；
2. 每个条目块内出现的 band 名 ⊆ {该条 A band, B band}（混入第三带即报错）；
3. 每个条目块内不出现机器预测带、编辑标注、truth、baseline、holdout 等字样；
4. 文本摘录 ≤120 词且与 truth 的 `excerptWords` 一致；视频条目块内**没有**任何字幕正文；
5. 填写表 15 行 × 5 列，除 `anon_id` 外全部为空。

## 7. 填完之后

```bash
cd /Users/piece/Desktop/Me/EnglishLearning/yt-bilingual-app
backend/venv/bin/python scripts/recompute_cefr_anchor.py \
  --adjudication docs/reports/cefr-anchor-adjudication-sheet-2026-11-17.csv \
  --output docs/reports/cefr-anchor-recalibration-2026-11-17.json
```

- 空表 → `status=pending`，不出任何一致性/κ/CI 数字；
- 只填一部分 → `status=partial_adjudication`，列出缺的 id，仍不出数字；
- 15 条填完 → 重算 κ、±1、Wilson CI、holdout，并**只报告**门槛是否满足；脚本不改 `difficulty.py` 阈值。

**门槛提醒**：holdout 只有 20 条，`±1` 点估计 80%（16/20）对应的 Wilson 95% CI 是 58.4%–91.9%，下限远低于 80%。
按「点估计 ≥80% 且 Wilson 下限 ≥80%」的严格口径，n=20 时只有 20/20 才可能通过；想在 95% CI 下确认 80%，
观测值要到约 88%–90% 且样本量约 100。**15 条填完 ≠ 校准通过**，这是扩样与调参的输入，不是结论。

## 8. 已知边界

- 评审 A/B 是在隔离环境中完成的独立评审（见 [`cefr-anchor-ai-double-review-2026-11-17.md`](cefr-anchor-ai-double-review-2026-11-17.md)）；视频条目的听音判断仍需人类复核，8 条视频分歧建议由能实际听音的人仲裁。
- 本包只解决「相邻带取哪一带」；不解决「编辑标注整体偏低」这一假设——那需要公版书锚复核（见 [`cefr-anchor-public-domain-review-2026-11-17.md`](cefr-anchor-public-domain-review-2026-11-17.md)）。
