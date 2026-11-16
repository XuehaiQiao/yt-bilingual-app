# CEFR M2 内容锚盲评包（60 条）

> 版本：2026-11-17 ｜ schema：`cefr-anchor-packet.v1` ｜ 状态：**人工双评未完成（校准未完成）**

本包只含**待评条目 + 评分 rubric + 空白评分栏**；**不含**任何难度等级、`difficulty.v1` 预测、编辑标注、调参/holdout 归属，也不含任何人工评分结果。

## 怎么用这个包

1. 将本包与你的**个人答案表**（`cefr-anchor-answer-sheet-rater-a-2026-11-17.csv` 或 `...-rater-b...`）一起使用；两位评审独立完成，**在双方都提交前不讨论**。
2. 按顺序评 60 条。每条只给一个 band（A1–C1）+ 置信度（1–3）；可选填目标生词率桶（`<1%` / `1–3%` / `3–5%` / `5–8%` / `>8%`）。
3. 视频条目只给标题/频道/链接/时间窗，**不给字幕全文**；请观看时间窗后判断整段视频。第三方视频版权归原频道，包内不转载字幕。
4. 文本条目给的是节选/全文（公版或语途原创），≤120 词；请只根据**看到的这段文本**判断。
5. 不要搜索原始等级、不要看 `cefr-anchor-truth-*`、不要参考另一位评审的评分。
6. 预计 3.5–4 小时；可分段完成，但请保持同一套 rubric。

## 60 条构成（评审可见的只是类型与长度）

- 总数：**60** 条；视频 **33** 条、文章/短文/公版节选 **27** 条。
- 其中 **40 条用于调参、20 条用于 holdout**；具体哪条属于哪边已隐藏，不影响逐条评分。

## 交付与保密

- 只提交 band/置信度/备注，不提交猜测的原文来源等级；
- 答案表用评审代号，不写真实姓名；
- 任何「看起来像 A2」的标题/频道/作者都不是评分依据。

## 评分 rubric（A1–C1）

先判断**语言本身的难度**，不要考虑话题你是否熟悉、是否有中文字幕/译文、也不要用标题、作者或频道去猜等级。
内容集合按 A2 以上设计；如果你认为某条低于 A2，可选 A1（分析时折叠为 A2，与 `difficulty.v1` 的内容带下限一致）。
如果你认为某条明显高于 C1，选 C1，并在备注写 `C1+`。

| 带 | 词汇 | 句法 | 篇章 / 信息 | 听力（仅视频） |
|---|---|---|---|---|
| **A1** | 高频具体词；孤立词、固定短语 | 一般现在时、be/have/do、简单问句；句子很短 | 单句或极短通知；信息点少且直接 | 语速很慢、吐字清晰、停顿多；常需重复 |
| **A2** | 日常高频词；少量高频短语 | 简单句 + 基础连接（and/but/because）；常见时态 | 2–5 句的短段落；直接信息；结构可预测 | 慢速、清晰、标准口音；话题日常 |
| **B1** | 常见词为主；少量抽象词、短语动词 | 主从复合句；常见连接词；叙事/说明有层次 | 多段短文；主旨 + 若干细节；有明确结构 | 正常偏慢；清晰标准口音；少量习语/连读 |
| **B2** | 词汇较丰富；抽象/专业词增多 | 多重从句、非谓语、被动等复杂结构 | 长段落；观点、论证、隐含关系；需推断 | 正常语速；有连读/弱读；话题抽象或专业 |
| **C1** | 词汇广；习语、隐喻、语域变化 | 复杂句法、省略、倒装、名词化等 | 长而密集；隐含意义、立场、修辞；需综合理解 | 接近自然语速；口音/语域变化；信息密度高 |

**判定顺序（建议）**

1. **词汇**：目标带学习者不查词能否覆盖主要内容？生词是高频还是低频/抽象？
2. **句法**：平均句长、从句层数、非谓语/被动/倒装是否构成负担？
3. **篇章**：信息是直接陈述，还是要推断观点、关系、态度？
4. **听力**（视频）：语速、连读/弱读、口音、背景音、信息密度；可用字幕辅助听懂，但评级按**听**的难度。
5. 选“最贴合”的一带；若在相邻两带之间摇摆，选较低的一带并标置信度 1（表示这是边界判断）。

**置信度**：3 = 确定；2 = 比较确定；1 = 在相邻带之间摇摆。
**不要**查资料找原始等级标注；**不要**与其他评审讨论；**不要**参考同一条的其他评分。


---

## 待评条目（顺序已打乱）

### M2-001 ｜ 精选视频（YouTube 嵌入） ｜ 时长 22:02 ｜ 2 个时间窗，共 03:00

- **标题**：What Is an AI Anyway? | Mustafa Suleyman | TED
- **频道**：TED
- **链接**：https://www.youtube.com/watch?v=KKNCiRWd_j0
- **时间窗 1**：01:16–02:46 （约 90 秒，254 词）— https://www.youtube.com/watch?v=KKNCiRWd_j0&t=76s
- **时间窗 2**：18:52–20:22 （约 90 秒，295 词）— https://www.youtube.com/watch?v=KKNCiRWd_j0&t=1132s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-002 ｜ 精选视频（YouTube 嵌入） ｜ 时长 09:52 ｜ 2 个时间窗，共 02:30

- **标题**：AI Slop Is Destroying The Internet
- **频道**：Kurzgesagt – In a Nutshell
- **链接**：https://www.youtube.com/watch?v=_zfN9wnPvU0
- **时间窗 1**：02:51–04:06 （约 75 秒，248 词）— https://www.youtube.com/watch?v=_zfN9wnPvU0&t=171s
- **时间窗 2**：05:25–06:40 （约 75 秒，257 词）— https://www.youtube.com/watch?v=_zfN9wnPvU0&t=325s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-003 ｜ 原创定位测短文（草稿） ｜ 93 词

- **来源**：LinguaTrek 自写短文（定位测题库草稿，未经 pilot）；包内给全文。

> A notification is a small interruption, but its effects are cumulative. Each alert competes for attention, and even when ignored it leaves a trace: a decision postponed, a train of thought broken. Designers defend alerts as a service to users who want to stay informed. Critics reply that many alerts serve the platform's need for engagement rather than the user's need for information. The disagreement is not really about technology. It concerns who has the right to decide what deserves our attention, and whether convenience is worth the cost of being constantly available.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-004 ｜ 精选视频（YouTube 嵌入） ｜ 时长 05:29 ｜ 2 个时间窗，共 02:00

- **标题**：Talking about sleep 😴 🛏️  Real Easy English
- **频道**：BBC Learning English
- **链接**：https://www.youtube.com/watch?v=yLu_M4yiCho
- **时间窗 1**：01:53–02:53 （约 60 秒，162 词）— https://www.youtube.com/watch?v=yLu_M4yiCho&t=113s
- **时间窗 2**：03:00–04:00 （约 60 秒，157 词）— https://www.youtube.com/watch?v=yLu_M4yiCho&t=180s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-005 ｜ 精选视频（YouTube 嵌入） ｜ 时长 14:11 ｜ 2 个时间窗，共 02:30

- **标题**：We WILL Fix Climate Change!
- **频道**：Kurzgesagt – In a Nutshell
- **链接**：https://www.youtube.com/watch?v=LxgMdjyw8uw
- **时间窗 1**：04:15–05:30 （约 75 秒，247 词）— https://www.youtube.com/watch?v=LxgMdjyw8uw&t=255s
- **时间窗 2**：09:10–10:25 （约 75 秒，264 词）— https://www.youtube.com/watch?v=LxgMdjyw8uw&t=550s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-006 ｜ 精选视频（YouTube 嵌入） ｜ 时长 05:43 ｜ 2 个时间窗，共 02:00

- **标题**：Talking about food 🍔🥒🍫 Real Easy English
- **频道**：BBC Learning English
- **链接**：https://www.youtube.com/watch?v=4C4wlOAscvY
- **时间窗 1**：01:28–02:28 （约 60 秒，158 词）— https://www.youtube.com/watch?v=4C4wlOAscvY&t=88s
- **时间窗 2**：02:54–03:54 （约 60 秒，153 词）— https://www.youtube.com/watch?v=4C4wlOAscvY&t=174s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-007 ｜ 精选视频（YouTube 嵌入） ｜ 时长 06:34 ｜ 2 个时间窗，共 02:30

- **标题**：Do Robots Deserve Rights? What if Machines Become Conscious?
- **频道**：Kurzgesagt – In a Nutshell
- **链接**：https://www.youtube.com/watch?v=DHyUYg8X31c
- **时间窗 1**：02:28–03:43 （约 75 秒，214 词）— https://www.youtube.com/watch?v=DHyUYg8X31c&t=148s
- **时间窗 2**：03:52–05:07 （约 75 秒，209 词）— https://www.youtube.com/watch?v=DHyUYg8X31c&t=232s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-008 ｜ 精选视频（YouTube 嵌入） ｜ 时长 14:04 ｜ 2 个时间窗，共 02:30

- **标题**：Inside the Mind of a Master Procrastinator | Tim Urban | TED
- **频道**：TED
- **链接**：https://www.youtube.com/watch?v=arj7oStGLkU
- **时间窗 1**：05:21–06:36 （约 75 秒，248 词）— https://www.youtube.com/watch?v=arj7oStGLkU&t=321s
- **时间窗 2**：10:25–11:40 （约 75 秒，241 词）— https://www.youtube.com/watch?v=arj7oStGLkU&t=625s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-009 ｜ 原创定位测短文（草稿） ｜ 79 词

- **来源**：LinguaTrek 自写短文（定位测题库草稿，未经 pilot）；包内给全文。

> Last Tuesday, Mina left her umbrella on the bus. It was a blue umbrella with a wooden handle, and it had been a birthday present from her sister. At first she thought it was gone forever. The next morning, however, the bus company called. A driver had found the umbrella and kept it in the office. Mina walked to the station after work and collected it. She was so happy that she brought the driver a box of tea.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-010 ｜ 原创定位测短文（草稿） ｜ 63 词

- **来源**：LinguaTrek 自写短文（定位测题库草稿，未经 pilot）；包内给全文。

> Repair cafes are gatherings where volunteers help people fix broken household objects, from toasters to bicycles. The idea began in the Netherlands and has spread to many countries. Supporters argue that these events not only reduce waste but also teach practical skills. Critics point out that some repairs take longer than a single afternoon, and that safety rules can be difficult to apply.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-011 ｜ 原创文章节选 ｜ 94 词

- **来源**：LinguaTrek 编辑部原创，随仓库分发

> Most of us have dozens of apps on our phones, and most of them were free to download. That word, free, feels simple. But when a product costs nothing, it is worth asking what we are paying with instead. The first price is attention. Free apps are often designed to keep us scrolling. Notifications pull us back, streaks make us return, and autoplay removes the moment when we might decide to stop. The longer we stay, the more advertisements we see. In this model, our time becomes the product that is sold to advertisers.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-012 ｜ 精选视频（YouTube 嵌入） ｜ 时长 10:07 ｜ 2 个时间窗，共 02:30

- **标题**：Is It Too Late To Stop Climate Change? Well, it's Complicated.
- **频道**：Kurzgesagt – In a Nutshell
- **链接**：https://www.youtube.com/watch?v=wbR-5mHI6bo
- **时间窗 1**：01:55–03:10 （约 75 秒，214 词）— https://www.youtube.com/watch?v=wbR-5mHI6bo&t=115s
- **时间窗 2**：08:36–09:51 （约 75 秒，217 词）— https://www.youtube.com/watch?v=wbR-5mHI6bo&t=516s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-013 ｜ 精选视频（YouTube 嵌入） ｜ 时长 05:19 ｜ 2 个时间窗，共 02:00

- **标题**：The hidden network that makes the internet possible - Sajan Saini
- **频道**：TED-Ed
- **链接**：https://www.youtube.com/watch?v=er3v4PVNQqE
- **时间窗 1**：01:27–02:27 （约 60 秒，153 词）— https://www.youtube.com/watch?v=er3v4PVNQqE&t=87s
- **时间窗 2**：02:54–03:54 （约 60 秒，152 词）— https://www.youtube.com/watch?v=er3v4PVNQqE&t=174s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-014 ｜ 精选视频（YouTube 嵌入） ｜ 时长 05:51 ｜ 2 个时间窗，共 02:00

- **标题**：Talking about meetings 🗓️🤝👔 Real Easy English
- **频道**：BBC Learning English
- **链接**：https://www.youtube.com/watch?v=TL61VKkme14
- **时间窗 1**：00:26–01:26 （约 60 秒，154 词）— https://www.youtube.com/watch?v=TL61VKkme14&t=26s
- **时间窗 2**：02:56–03:56 （约 60 秒，145 词）— https://www.youtube.com/watch?v=TL61VKkme14&t=176s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-015 ｜ 精选视频（YouTube 嵌入） ｜ 时长 04:59 ｜ 2 个时间窗，共 02:00

- **标题**：What Earth in 2050 could look like - Shannon Odell
- **频道**：TED-Ed
- **链接**：https://www.youtube.com/watch?v=2njn71TqkjA
- **时间窗 1**：01:30–02:30 （约 60 秒，177 词）— https://www.youtube.com/watch?v=2njn71TqkjA&t=90s
- **时间窗 2**：03:34–04:34 （约 60 秒，164 词）— https://www.youtube.com/watch?v=2njn71TqkjA&t=214s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-016 ｜ 精选视频（YouTube 嵌入） ｜ 时长 04:03 ｜ 2 个时间窗，共 02:00

- **标题**：How languages evolve - Alex Gendler
- **频道**：TED-Ed
- **链接**：https://www.youtube.com/watch?v=iWDKsHm6gTA
- **时间窗 1**：00:07–01:07 （约 60 秒，181 词）— https://www.youtube.com/watch?v=iWDKsHm6gTA&t=7s
- **时间窗 2**：02:45–03:45 （约 60 秒，184 词）— https://www.youtube.com/watch?v=iWDKsHm6gTA&t=165s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-017 ｜ 精选视频（YouTube 嵌入） ｜ 时长 04:39 ｜ 2 个时间窗，共 02:00

- **标题**：Do tax cuts stimulate the economy? - Jonathan Smith
- **频道**：TED-Ed
- **链接**：https://www.youtube.com/watch?v=wCLP3djiKvM
- **时间窗 1**：01:05–02:05 （约 60 秒，177 词）— https://www.youtube.com/watch?v=wCLP3djiKvM&t=65s
- **时间窗 2**：03:06–04:06 （约 60 秒，169 词）— https://www.youtube.com/watch?v=wCLP3djiKvM&t=186s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-018 ｜ 公版书节选（Project Gutenberg） ｜ 116 词

- **作者**：Beatrix Potter
- **来源**：Beatrix Potter《The Tale of Peter Rabbit》（1902），Project Gutenberg #14838；美国公版，包内节选 ≤120 词。
- **原文链接**：https://www.gutenberg.org/ebooks/14838

> Once upon a time there were four little Rabbits, and their names were-- Flopsy, Mopsy, Cotton-tail, and Peter. They lived with their Mother in a sand-bank, underneath the root of a very big fir-tree. 'Now my dears,' said old Mrs. Rabbit one morning, 'you may go into the fields or down the lane, but don't go into Mr. McGregor's garden: your Father had an accident there; he was put in a pie by Mrs. McGregor.' 'Now run along, and don't get into mischief. I am going out.' Then old Mrs. Rabbit took a basket and her umbrella, and went through the wood to the baker's. She bought a loaf of brown bread and five currant buns.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-019 ｜ 精选视频（YouTube 嵌入） ｜ 时长 10:19 ｜ 2 个时间窗，共 02:30

- **标题**：AI Is Dangerous, but Not for the Reasons You Think | Sasha Luccioni | TED
- **频道**：TED
- **链接**：https://www.youtube.com/watch?v=eXdVDhOGqoE
- **时间窗 1**：03:50–05:05 （约 75 秒，247 词）— https://www.youtube.com/watch?v=eXdVDhOGqoE&t=230s
- **时间窗 2**：07:37–08:52 （约 75 秒，240 词）— https://www.youtube.com/watch?v=eXdVDhOGqoE&t=457s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-020 ｜ 精选视频（YouTube 嵌入） ｜ 时长 06:04 ｜ 2 个时间窗，共 02:30

- **标题**：How do we create a better economy?
- **频道**：TED-Ed
- **链接**：https://www.youtube.com/watch?v=6MK6tuZ7Rws
- **时间窗 1**：01:23–02:38 （约 75 秒，262 词）— https://www.youtube.com/watch?v=6MK6tuZ7Rws&t=83s
- **时间窗 2**：03:27–04:42 （约 75 秒，246 词）— https://www.youtube.com/watch?v=6MK6tuZ7Rws&t=207s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-021 ｜ 公版书节选（Project Gutenberg） ｜ 120 词

- **作者**：Lewis Carroll
- **来源**：Lewis Carroll《Alice's Adventures in Wonderland》（1865），Project Gutenberg #11；美国公版，包内节选 ≤120 词。
- **原文链接**：https://www.gutenberg.org/ebooks/11

> Alice was not a bit hurt, and she jumped up on to her feet in a moment: she looked up, but it was all dark overhead; before her was another long passage, and the White Rabbit was still in sight, hurrying down it. There was not a moment to be lost: away went Alice like the wind, and was just in time to hear it say, as it turned a corner, “Oh my ears and whiskers, how late it’s getting!” She was close behind it when she turned the corner, but the Rabbit was no longer to be seen: she found herself in a long, low hall, which was lit up by a row of lamps hanging from the roof.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-022 ｜ 原创定位测短文（草稿） ｜ 96 词

- **来源**：LinguaTrek 自写短文（定位测题库草稿，未经 pilot）；包内给全文。

> For years, manufacturers have designed products that are difficult to repair: batteries are sealed, spare parts are scarce, and software locks out independent workshops. The "right to repair" movement argues that this wastes resources and limits consumer choice. Some governments now require companies to publish repair manuals and supply parts for a minimum number of years. Manufacturers warn that such rules could raise prices and slow innovation. Yet the debate is shifting. As electronic waste grows, the question is less about whether repair should be allowed than about who controls the knowledge required to do it.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-023 ｜ 原创定位测短文（草稿） ｜ 94 词

- **来源**：LinguaTrek 自写短文（定位测题库草稿，未经 pilot）；包内给全文。

> When Daniel moved into his new flat, he did not know anyone in the building. On his first evening, he tried to cook dinner but discovered that he had no salt. He knocked on the door opposite and asked his neighbour, an older woman named Rosa, if she could help. Rosa smiled and gave him a small bag of salt. The next day, Daniel baked some bread and took half of it to her. They now meet in the hallway almost every morning and talk about the weather, the garden or the local shops.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-024 ｜ 公版书节选（Project Gutenberg） ｜ 116 词

- **作者**：Arthur Conan Doyle
- **来源**：Arthur Conan Doyle《The Hound of the Baskervilles》（1902），Project Gutenberg #2852；美国公版，包内节选 ≤120 词。
- **原文链接**：https://www.gutenberg.org/ebooks/2852

> Mr. Sherlock Holmes, who was usually very late in the mornings, save upon those not infrequent occasions when he was up all night, was seated at the breakfast table. I stood upon the hearth-rug and picked up the stick which our visitor had left behind him the night before. It was a fine, thick piece of wood, bulbous-headed, of the sort which is known as a “Penang lawyer.” Just under the head was a broad silver band nearly an inch across. “To James Mortimer, M.R.C.S., from his friends of the C.C.H.,” was engraved upon it, with the date “1884.” It was just such a stick as the old-fashioned family practitioner used to carry—dignified, solid, and reassuring.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-025 ｜ 原创定位测短文（草稿） ｜ 95 词

- **来源**：LinguaTrek 自写短文（定位测题库草稿，未经 pilot）；包内给全文。

> The town library used to close at six, which made it hard for people who worked during the day. Last month it began staying open until nine on weekdays. The library also added more desks near the windows and a small area where visitors can make tea. The librarian says the change has brought in many new readers, especially students preparing for exams. Not everyone is happy: a few residents have complained about noise in the evenings. The library is now testing a rule that asks visitors to keep phone calls outside the reading rooms.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-026 ｜ 公版书节选（Project Gutenberg） ｜ 114 词

- **作者**：Arthur Conan Doyle
- **来源**：Arthur Conan Doyle《The Valley of Fear》（1915），Project Gutenberg #3289；美国公版，包内节选 ≤120 词。
- **原文链接**：https://www.gutenberg.org/ebooks/3289

> “Porlock, Watson, is a nom-de-plume, a mere identification mark; but behind it lies a shifty and evasive personality. In a former letter he frankly informed me that the name was not his own, and defied me ever to trace him among the teeming millions of this great city. Porlock is important, not for himself, but for the great man with whom he is in touch. Picture to yourself the pilot fish with the shark, the jackal with the lion—anything that is insignificant in companionship with what is formidable: not only formidable, Watson, but sinister—in the highest degree sinister. That is where he comes within my purview. You have heard me speak of Professor Moriarty?”

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-027 ｜ 精选视频（YouTube 嵌入） ｜ 时长 12:47 ｜ 2 个时间窗，共 02:30

- **标题**：What Makes a Good Life? Lessons from the Longest Study on Happiness | Robert Waldinger | TED
- **频道**：TED
- **链接**：https://www.youtube.com/watch?v=8KkKuTCFvzI
- **时间窗 1**：04:39–05:54 （约 75 秒，188 词）— https://www.youtube.com/watch?v=8KkKuTCFvzI&t=279s
- **时间窗 2**：07:13–08:28 （约 75 秒，208 词）— https://www.youtube.com/watch?v=8KkKuTCFvzI&t=433s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-028 ｜ 精选视频（YouTube 嵌入） ｜ 时长 14:13 ｜ 2 个时间窗，共 02:30

- **标题**：How Language Shapes the Way We Think | Lera Boroditsky | TED
- **频道**：TED
- **链接**：https://www.youtube.com/watch?v=RKK7wGAYP6k
- **时间窗 1**：05:28–06:43 （约 75 秒，262 词）— https://www.youtube.com/watch?v=RKK7wGAYP6k&t=328s
- **时间窗 2**：11:03–12:18 （约 75 秒，230 词）— https://www.youtube.com/watch?v=RKK7wGAYP6k&t=663s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-029 ｜ 原创定位测短文（草稿） ｜ 44 词

- **来源**：LinguaTrek 自写短文（定位测题库草稿，未经 pilot）；包内给全文。

> Tom started working at a small bike shop on Monday. He had never repaired a bike before, so his boss showed him how to fix a flat tire. By the end of the day, Tom could do it alone. He was tired but proud.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-030 ｜ 原创定位测短文（草稿） ｜ 98 词

- **来源**：LinguaTrek 自写短文（定位测题库草稿，未经 pilot）；包内给全文。

> Urban trees are often discussed as decoration, yet their value is increasingly measured in degrees and dollars. A mature tree can lower street temperatures, absorb storm water and improve air quality; in dense neighbourhoods, the difference can be a matter of health rather than comfort. The benefits are also unevenly distributed. Wealthier districts tend to have older, larger trees, while poorer areas often have fewer and younger ones. Planting programmes that ignore this pattern may widen the gap they claim to close. The difficult question is therefore not whether trees help, but who gets to benefit from them.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-031 ｜ 精选视频（YouTube 嵌入） ｜ 时长 05:45 ｜ 2 个时间窗，共 02:00

- **标题**：Why you procrastinate even when it feels bad
- **频道**：TED-Ed
- **链接**：https://www.youtube.com/watch?v=FWTNMzK9vG4
- **时间窗 1**：00:18–01:18 （约 60 秒，150 词）— https://www.youtube.com/watch?v=FWTNMzK9vG4&t=18s
- **时间窗 2**：02:55–03:55 （约 60 秒，142 词）— https://www.youtube.com/watch?v=FWTNMzK9vG4&t=175s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-032 ｜ 视频（YouTube 嵌入） ｜ 时长 06:19 ｜ 2 个时间窗，共 02:30

- **标题**：Learning from different generations (6 Minute English)
- **频道**：BBC Learning English
- **链接**：https://www.youtube.com/watch?v=h-NZcQF7jgI
- **时间窗 1**：02:30–03:45 （约 75 秒，254 词）— https://www.youtube.com/watch?v=h-NZcQF7jgI&t=150s
- **时间窗 2**：04:01–05:16 （约 75 秒，214 词）— https://www.youtube.com/watch?v=h-NZcQF7jgI&t=241s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-033 ｜ 原创文章节选 ｜ 94 词

- **来源**：LinguaTrek 编辑部原创，随仓库分发

> When people talk about pollution in the ocean, they usually think of plastic bags or oil. But there is another kind of pollution that we cannot see: noise. For animals that live in the sea, sound is as important as light is for us. The main source of underwater noise is shipping. Large ships carry most of the world's goods, and their engines never stop. Scientists also point to sonar, drilling machines, and loud explosions used in research or construction. All of these sounds travel much farther and faster in water than in air.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-034 ｜ 精选视频（YouTube 嵌入） ｜ 时长 05:04 ｜ 2 个时间窗，共 02:00

- **标题**：The benefits of a bilingual brain - Mia Nacamulli
- **频道**：TED-Ed
- **链接**：https://www.youtube.com/watch?v=MMmOLN5zBLY
- **时间窗 1**：01:20–02:20 （约 60 秒，166 词）— https://www.youtube.com/watch?v=MMmOLN5zBLY&t=80s
- **时间窗 2**：03:12–04:12 （约 60 秒，169 词）— https://www.youtube.com/watch?v=MMmOLN5zBLY&t=192s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-035 ｜ 精选视频（YouTube 嵌入） ｜ 时长 04:47 ｜ 2 个时间窗，共 02:00

- **标题**：Can wildlife adapt to climate change? - Erin Eastwood
- **频道**：TED-Ed
- **链接**：https://www.youtube.com/watch?v=ZCKRjP_DMII
- **时间窗 1**：00:58–01:58 （约 60 秒，156 词）— https://www.youtube.com/watch?v=ZCKRjP_DMII&t=58s
- **时间窗 2**：03:27–04:27 （约 60 秒，148 词）— https://www.youtube.com/watch?v=ZCKRjP_DMII&t=207s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-036 ｜ 精选视频（YouTube 嵌入） ｜ 时长 06:12 ｜ 2 个时间窗，共 02:30

- **标题**：Cultural differences and body language - 6 Minute English
- **频道**：BBC Learning English
- **链接**：https://www.youtube.com/watch?v=oTPZWpQ9pbA
- **时间窗 1**：01:41–02:56 （约 75 秒，238 词）— https://www.youtube.com/watch?v=oTPZWpQ9pbA&t=101s
- **时间窗 2**：04:05–05:20 （约 75 秒，238 词）— https://www.youtube.com/watch?v=oTPZWpQ9pbA&t=245s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-037 ｜ 精选视频（YouTube 嵌入） ｜ 时长 18:36 ｜ 2 个时间窗，共 03:00

- **标题**：The Tipping Points of Climate Change — and Where We Stand | Johan Rockström | TED
- **频道**：TED
- **链接**：https://www.youtube.com/watch?v=Vl6VhCAeEfQ
- **时间窗 1**：07:58–09:28 （约 90 秒，255 词）— https://www.youtube.com/watch?v=Vl6VhCAeEfQ&t=478s
- **时间窗 2**：10:14–11:44 （约 90 秒，259 词）— https://www.youtube.com/watch?v=Vl6VhCAeEfQ&t=614s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-038 ｜ 公版书节选（Project Gutenberg） ｜ 102 词

- **作者**：Beatrix Potter
- **来源**：Beatrix Potter《The Tale of Two Bad Mice》（1904），Project Gutenberg #45264；美国公版，包内节选 ≤120 词。
- **原文链接**：https://www.gutenberg.org/ebooks/45264

> ONCE upon a time there was a very beautiful doll's-house; it was red brick with white windows, and it had real muslin curtains and a front door and a chimney. IT belonged to two Dolls called Lucinda and Jane; at least it belonged to Lucinda, but she never ordered meals. Jane was the Cook; but she never did any cooking, because the dinner had been bought ready-made, in a box full of shavings. THERE were two red lobsters and a ham, a fish, a pudding, and some pears and oranges. They would not come off the plates, but they were extremely beautiful.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-039 ｜ 公版书节选（Project Gutenberg） ｜ 85 词

- **作者**：Arthur Conan Doyle
- **来源**：Arthur Conan Doyle《A Study in Scarlet》（1887），Project Gutenberg #244；美国公版，包内节选 ≤120 词。
- **原文链接**：https://www.gutenberg.org/ebooks/244

> “Criminal cases are continually hinging upon that one point. A man is suspected of a crime months perhaps after it has been committed. His linen or clothes are examined, and brownish stains discovered upon them. Are they blood stains, or mud stains, or rust stains, or fruit stains, or what are they? That is a question which has puzzled many an expert, and why? Because there was no reliable test. Now we have the Sherlock Holmes’ test, and there will no longer be any difficulty.”

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-040 ｜ 精选视频（YouTube 嵌入） ｜ 时长 06:22 ｜ 2 个时间窗，共 02:30

- **标题**：Is technology harmful to youngsters? 6 Minute English
- **频道**：BBC Learning English
- **链接**：https://www.youtube.com/watch?v=StEB_wntlZ0
- **时间窗 1**：02:11–03:26 （约 75 秒，218 词）— https://www.youtube.com/watch?v=StEB_wntlZ0&t=131s
- **时间窗 2**：03:42–04:57 （约 75 秒，198 词）— https://www.youtube.com/watch?v=StEB_wntlZ0&t=222s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-041 ｜ 精选视频（YouTube 嵌入） ｜ 时长 24:01 ｜ 2 个时间窗，共 03:00

- **标题**：How Kalshi Became the Biggest Prediction Market | The Circuit with Emily Chang
- **频道**：Bloomberg Originals
- **链接**：https://www.youtube.com/watch?v=XNZN6gYhpLU
- **时间窗 1**：02:30–04:00 （约 90 秒，322 词）— https://www.youtube.com/watch?v=XNZN6gYhpLU&t=150s
- **时间窗 2**：12:01–13:31 （约 90 秒，332 词）— https://www.youtube.com/watch?v=XNZN6gYhpLU&t=721s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-042 ｜ 公版书节选（Project Gutenberg） ｜ 108 词

- **作者**：E. Nesbit
- **来源**：E. Nesbit《Five Children and It》（1902），Project Gutenberg #778；美国公版，包内节选 ≤120 词。
- **原文链接**：https://www.gutenberg.org/ebooks/778

> It was at the gravel-pits. Father had to go away suddenly on business, and mother had gone away to stay with Granny, who was not very well. They both went in a great hurry, and when they were gone the house seemed dreadfully quiet and empty, and the children wandered from one room to another and looked at the bits of paper and string on the floors left over from the packing, and not yet cleared up, and wished they had something to do. It was Cyril who said: 'I say, let's take our Margate spades and go and dig in the gravel-pits. We can pretend it's seaside.'

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-043 ｜ 视频（YouTube 嵌入） ｜ 时长 09:52 ｜ 2 个时间窗，共 02:30

- **标题**：AI Slop Is Destroying The Internet
- **频道**：Kurzgesagt – In a Nutshell
- **链接**：https://www.youtube.com/watch?v=_zfN9wnPvU0
- **时间窗 1**：02:51–04:06 （约 75 秒，240 词）— https://www.youtube.com/watch?v=_zfN9wnPvU0&t=171s
- **时间窗 2**：05:02–06:17 （约 75 秒，233 词）— https://www.youtube.com/watch?v=_zfN9wnPvU0&t=302s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-044 ｜ 原创文章节选 ｜ 107 词

- **来源**：LinguaTrek 编辑部原创，随仓库分发

> We live in a busy world. We work, study, scroll through our phones, and plan the next thing. Many of us feel guilty when we are not doing something useful. But doing nothing is not always a waste of time. Your brain needs rest. When you sit quietly, your mind can sort through the day. Scientists say that short breaks help us remember better and feel less tired. Some people think rest must be earned. They finish a task, and then allow themselves five minutes. But your brain is not a machine that only stops when the work is done. It needs small pauses all day long.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-045 ｜ 公版书节选（Project Gutenberg） ｜ 116 词

- **作者**：Beatrix Potter
- **来源**：Beatrix Potter《The Tailor of Gloucester》（1903），Project Gutenberg #14868；美国公版，包内节选 ≤120 词。
- **原文链接**：https://www.gutenberg.org/ebooks/14868

> In the time of swords and periwigs and full-skirted coats with flowered lappets--when gentlemen wore ruffles, and gold-laced waistcoats of paduasoy and taffeta--there lived a tailor in Gloucester. He sat in the window of a little shop in Westgate Street, cross-legged on a table, from morning till dark. All day long while the light lasted he sewed and snippeted, piecing out his satin and pompadour, and lutestring; stuffs had strange names, and were very expensive in the days of the Tailor of Gloucester. But although he sewed fine silk for his neighbours, he himself was very, very poor--a little old man in spectacles, with a pinched face, old crooked fingers, and a suit of thread-bare clothes.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-046 ｜ 原创定位测短文（草稿） ｜ 52 词

- **来源**：LinguaTrek 自写短文（定位测题库草稿，未经 pilot）；包内给全文。

> When Maya moved into a new flat, she noticed the kitchen was too dark to cook in. Instead of buying expensive lights, she moved a mirror from the bedroom and placed it opposite the window. The mirror reflects daylight into the room. Now she can chop vegetables without turning on a lamp.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-047 ｜ 精选视频（YouTube 嵌入） ｜ 时长 07:32 ｜ 2 个时间窗，共 02:30

- **标题**：How climate change affects your mental health | Britt Wray
- **频道**：TED
- **链接**：https://www.youtube.com/watch?v=-IlDkCEvsYw
- **时间窗 1**：02:48–04:03 （约 75 秒，235 词）— https://www.youtube.com/watch?v=-IlDkCEvsYw&t=168s
- **时间窗 2**：05:39–06:54 （约 75 秒，237 词）— https://www.youtube.com/watch?v=-IlDkCEvsYw&t=339s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-048 ｜ 原创定位测短文（草稿） ｜ 96 词

- **来源**：LinguaTrek 自写短文（定位测题库草稿，未经 pilot）；包内给全文。

> On-demand delivery services promise to save time, but the convenience is rarely free. Behind each quick delivery stands a network of couriers whose schedules are shaped by algorithms rather than fixed shifts. Economists debate whether such work offers genuine flexibility or simply shifts risk onto the workers. What is clear is that the price shown to customers covers only part of the arrangement. When a delivery is late, the courier may bear the cost; when demand falls, hours disappear. Regulators are now asking who should be responsible for the gaps that the app does not show.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-049 ｜ 原创定位测短文（草稿） ｜ 99 词

- **来源**：LinguaTrek 自写短文（定位测题库草稿，未经 pilot）；包内给全文。

> Every Saturday morning, a community centre in Leeds opens its doors to broken things. At the Repair Cafe, volunteers with practical skills try to fix lamps, radios, chairs and clothes that visitors bring in. The service is free, but visitors are encouraged to stay and watch. "We want people to learn how things work," says the organiser. Since the cafe opened two years ago, it has repaired more than six hundred objects. Not everything can be saved, and some repairs take several visits. Still, the volunteers say the most valuable result is the conversations that happen around the tables.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-050 ｜ 精选视频（YouTube 嵌入） ｜ 时长 12:09 ｜ 2 个时间窗，共 02:30

- **标题**：Intro to Economics: Crash Course Econ #1
- **频道**：CrashCourse
- **链接**：https://www.youtube.com/watch?v=3ez10ADR_gM
- **时间窗 1**：03:29–04:44 （约 75 秒，326 词）— https://www.youtube.com/watch?v=3ez10ADR_gM&t=209s
- **时间窗 2**：10:23–11:38 （约 75 秒，303 词）— https://www.youtube.com/watch?v=3ez10ADR_gM&t=623s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-051 ｜ 公版书节选（Project Gutenberg） ｜ 102 词

- **作者**：Hugh Lofting
- **来源**：Hugh Lofting《The Story of Doctor Dolittle》（1920），Project Gutenberg #501；美国公版，包内节选 ≤120 词。
- **原文链接**：https://www.gutenberg.org/ebooks/501

> So, as time went on, the Doctor got more and more animals; and the people who came to see him got less and less. Till at last he had no one left—except the Cat’s-meat-Man, who didn’t mind any kind of animals. But the Cat’s-meat-Man wasn’t very rich and he only got sick once a year—at Christmas-time, when he used to give the Doctor sixpence for a bottle of medicine. Sixpence a year wasn’t enough to live on—even in those days, long ago; and if the Doctor hadn’t had some money saved up in his money-box, no one knows what would have happened.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-052 ｜ 公版书节选（Project Gutenberg） ｜ 117 词

- **作者**：Beatrix Potter
- **来源**：Beatrix Potter《The Tale of Squirrel Nutkin》（1903），Project Gutenberg #14872；美国公版，包内节选 ≤120 词。
- **原文链接**：https://www.gutenberg.org/ebooks/14872

> This is a Tale about a tail--a tail that belonged to a little red squirrel, and his name was Nutkin. He had a brother called Twinkleberry, and a great many cousins: they lived in a wood at the edge of a lake. In the middle of the lake there is an island covered with trees and nut bushes; and amongst those trees stands a hollow oak-tree, which is the house of an owl who is called Old Brown. One autumn when the nuts were ripe, and the leaves on the hazel bushes were golden and green--Nutkin and Twinkleberry and all the other little squirrels came out of the wood, and down to the edge of the lake.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-053 ｜ 视频（YouTube 嵌入） ｜ 时长 06:04 ｜ 2 个时间窗，共 02:30

- **标题**：How do we create a better economy?
- **频道**：TED-Ed
- **链接**：https://www.youtube.com/watch?v=6MK6tuZ7Rws
- **时间窗 1**：00:58–02:13 （约 75 秒，277 词）— https://www.youtube.com/watch?v=6MK6tuZ7Rws&t=58s
- **时间窗 2**：04:14–05:29 （约 75 秒，260 词）— https://www.youtube.com/watch?v=6MK6tuZ7Rws&t=254s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-054 ｜ 精选视频（YouTube 嵌入） ｜ 时长 09:13 ｜ 2 个时间窗，共 02:30

- **标题**：The surprising implications of culture on language and how we talk
- **频道**：TEDx Talks
- **链接**：https://www.youtube.com/watch?v=fbQ3LGoFaLc
- **时间窗 1**：02:42–03:57 （约 75 秒，176 词）— https://www.youtube.com/watch?v=fbQ3LGoFaLc&t=162s
- **时间窗 2**：05:18–06:33 （约 75 秒，206 词）— https://www.youtube.com/watch?v=fbQ3LGoFaLc&t=318s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-055 ｜ 公版书节选（Project Gutenberg） ｜ 110 词

- **作者**：Edgar Rice Burroughs
- **来源**：Edgar Rice Burroughs《Tarzan of the Apes》（1914），Project Gutenberg #78；美国公版，包内节选 ≤120 词。
- **原文链接**：https://www.gutenberg.org/ebooks/78

> There was in the whole atmosphere of the craft that undefinable something which presages disaster. Outwardly, to the knowledge of the Claytons, all went on as before upon the little vessel; but that there was an undertow leading them toward some unknown danger both felt, though they did not speak of it to each other. On the second day after the wounding of Black Michael, Clayton came on deck just in time to see the limp body of one of the crew being carried below by four of his fellows while the first mate, a heavy belaying pin in his hand, stood glowering at the little party of sullen sailors.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-056 ｜ 精选视频（YouTube 嵌入） ｜ 时长 31:32 ｜ 2 个时间窗，共 03:00

- **标题**：The Rise, Bankruptcy and Rebirth of 23andMe | The Circuit
- **频道**：Bloomberg Originals
- **链接**：https://www.youtube.com/watch?v=DX_HLqz7l2g
- **时间窗 1**：09:33–11:03 （约 90 秒，280 词）— https://www.youtube.com/watch?v=DX_HLqz7l2g&t=573s
- **时间窗 2**：26:03–27:33 （约 90 秒，301 词）— https://www.youtube.com/watch?v=DX_HLqz7l2g&t=1563s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-057 ｜ 公版书节选（Project Gutenberg） ｜ 99 词

- **作者**：Arthur Conan Doyle
- **来源**：Arthur Conan Doyle《The Memoirs of Sherlock Holmes》（1894），Project Gutenberg #834；美国公版，包内节选 ≤120 词。
- **原文链接**：https://www.gutenberg.org/ebooks/834

> It was evening before we reached the little town of Tavistock, which lies, like the boss of a shield, in the middle of the huge circle of Dartmoor. Two gentlemen were awaiting us in the station—the one a tall, fair man with lion-like hair and beard and curiously penetrating light blue eyes; the other a small, alert person, very neat and dapper, in a frock-coat and gaiters, with trim little side-whiskers and an eye-glass. The latter was Colonel Ross, the well-known sportsman; the other, Inspector Gregory, a man who was rapidly making his name in the English detective service.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-058 ｜ 精选视频（YouTube 嵌入） ｜ 时长 04:16 ｜ 2 个时间窗，共 02:00

- **标题**：How stress affects your brain - Madhumita Murgia
- **频道**：TED-Ed
- **链接**：https://www.youtube.com/watch?v=WuyPuH9ojCE
- **时间窗 1**：00:10–01:10 （约 60 秒，157 词）— https://www.youtube.com/watch?v=WuyPuH9ojCE&t=10s
- **时间窗 2**：02:16–03:16 （约 60 秒，161 词）— https://www.youtube.com/watch?v=WuyPuH9ojCE&t=136s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-059 ｜ 公版书节选（Project Gutenberg） ｜ 109 词

- **作者**：Beatrix Potter
- **来源**：Beatrix Potter《The Tale of Benjamin Bunny》（1904），Project Gutenberg #14407；美国公版，包内节选 ≤120 词。
- **原文链接**：https://www.gutenberg.org/ebooks/14407

> One morning a little rabbit sat on a bank. He pricked his ears and listened to the trit-trot, trit-trot of a pony. A gig was coming along the road; it was driven by Mr. McGregor, and beside him sat Mrs. McGregor in her best bonnet. As soon as they had passed, little Benjamin Bunny slid down into the road, and set off--with a hop, skip, and a jump--to call upon his relations, who lived in the wood at the back of Mr. McGregor's garden. That wood was full of rabbit holes; and in the neatest, sandiest hole of all lived Benjamin's aunt and his cousins--Flopsy, Mopsy, Cotton-tail, and Peter.

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

### M2-060 ｜ 精选视频（YouTube 嵌入） ｜ 时长 15:16 ｜ 2 个时间窗，共 03:00

- **标题**：Who are you, really? The puzzle of personality | Brian Little | TED
- **频道**：TED
- **链接**：https://www.youtube.com/watch?v=qYvXk_bqlBk
- **时间窗 1**：05:06–06:36 （约 90 秒，221 词）— https://www.youtube.com/watch?v=qYvXk_bqlBk&t=306s
- **时间窗 2**：12:13–13:43 （约 90 秒，228 词）— https://www.youtube.com/watch?v=qYvXk_bqlBk&t=733s
- **怎么评**：观看上述时间窗，判断整段视频的**口语难度**（可开 YouTube 自动字幕辅助听清，但不要用字幕稿的等级标注）。

- **我的评分**：band ____｜置信度 ____（1–3）｜备注：____________________

---

## 提交前检查

- [ ] 60 条都填了 band；
- [ ] 60 条都填了置信度（1–3）；
- [ ] 没有和另一位评审讨论过；
- [ ] 没有查看 `cefr-anchor-truth-2026-11-17.json`。

> 人工评审未完成 → 校准未完成。不得把本包的自动基线当作效度证据，也不得在人工标签齐备前宣称 κ 或一致率。
