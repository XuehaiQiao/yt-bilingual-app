# 开放词族审计（跨 10k、仅显示有族词）（P1-04）

- 日期：2026-11-23
- 任务卡：`TASKS/P1-04-word-family-open-audit.md`（owner implementer=`family-open-impl`，reviewer/integrator=`lead`）
- 证据绑定：审计运行于 **HEAD `d52607e`**（跑脚本时工作区另有 P2-02 前端的未提交改动，与本次只读的 3 个输入无关；输入文件 SHA-256 见 §8）
- 脚本：`scripts/word_family_open_audit.py`（只读，新增）
- 单测：`scripts/tests/test_word_family_open_audit.py`（**23 例**，固定小样本，不下载 WordNet）
- 环境：系统 `python3` 3.8.8 + nltk 3.6.1；WordNet 3.0 数据在 `/tmp/nltk_data`（`--wordnet-dir /tmp/nltk_data`）
- 候选映射：`/tmp/word-family-open-candidates.json`（**不提交**；3,694 族 / 11,563 词，1,469,090 B）
- 范围：只新增脚本 / 单测 / 本报告；**未改** `scripts/word_family_audit.py`、`backend/**`、`frontend/**`、`content/**`、`data/**`；未 commit

## 0. 结论摘要

1. **规则可行，且覆盖率翻倍**：按「族内可含 10k 外词 + 至少一个成员在 10k」重算，10,000 个 CEFR lemma 里 **5,223 个（52.23%）进族**（P1-03 的 10k 内基线只有 2,621 = 26.21%），**3,694 个词族**，成员总数 **11,563**（10k 内 5,223 / 10k 外 6,340）。每个等级都涨：A1 37.30%→67.10%、C1 18.00%→41.63%。
2. **代价一：无等级成员占多数**。11,563 个成员里 **6,340 个（54.8%）是 10k 外词**，等级只能留空；2,518 个族（68.2%）只有 1 个 10k 成员。UI 若把「无等级」默认成 A1 就是错的。
3. **代价二：族会变大、语义跨度变大**。最大族从 6 人涨到 **18 人**（`F0265`，head=`large`），`large` / `extend` / `comprehend` 三个语义簇被 `largeness.n.02`、`breadth.n.01` 两个 synset 桥接成一家。`comprehend` 族**含 `extend`**（卡里问的），但这是「广度」义项桥接，不是教学意义上的同族。
4. **`the` / `at` 等无族词 4,777 个（47.77%）不进词族表**，已验证不在 `families` 与 `mapping` 里（§2.2、§8）。
5. **坏边 17 条、命中 16 个族**（0.43% of 3,694）：13 条语义已分化 + 4 条明显错误。比 P1-03 的 13 条多 4 条——`judge/adjudicate` 是放开边界后重新回到图里的（P1-03 被 10k 边界挡住），`tend/tender`、`industry/industrious`、`stand/standard` 是本次人工审阅新发现。
6. **`reflect` 族仍缺 `reflection`**：WordNet 3.0 里 `reflection` 的 8 个 synset 全无派生指针（连 `reflectivity` 的派生表都反向引用了 `reflection.n.08`，但 `reflection` 自己不指向任何人）。这是数据缺口，不是构图 bug → 仍走 allowlist。
7. **系统性缺口比预期大**：`strong/strength`、`high/height`、`live/life`、`choose/choice`、`fly/flight` 这类不规则派生在 WordNet 3.0 里**整批缺失**，对应词今天仍是「无族」。给出了 **22 条 allowlist 首批**（两侧都在 10k、图里确实无边），加上后覆盖率 +17 个词（52.23%→52.40%）。
8. **建议规则**：**E = 开放边界 + allowlist − 黑名单** → **3,696 族 / 5,233 个 10k 词（52.33%）/ 最大族 18 / 坏边 0**。黑名单只删 17 条人工确认边，代价 −7 个覆盖词；allowlist 只补 22 条缺失边，代价 0 条坏边。
9. **候选映射**：11,563 词、1,469,090 B、JSON 加载 22.7 ms；建议的数据文件格式见 §7（预计可压到 ~0.6 MB）。
10. **确定性**：两次运行候选 JSON **逐字节一致**（SHA-256 `8251ac2a…`）；频表 / 释义索引跑前跑后 SHA-256 不变（§8）。

## 1. 口径

1. **节点**：WordNet 3.0 全部**单字** lemma（NFC + 小写）。含下划线的多词 lemma 不进图，只统计其桥接效应（§2.1）。
2. **边**：对每个 synset 的每个 lemma 取 `derivationally_related_forms()`，建**无向**边；自指丢弃；同一对 `(a,b)` 在多个 synset / 两个方向出现只保留一条，并记录出现过的 `(synset, pos)` 作为证据。
3. **词族**：连通分量，**≥2 成员且至少 1 个成员 ∈ CEFR 10k** 才算一个族；**没有 10k 成员的分量不成族**（5,787 个，只计数）。
4. **成员**：分量内全部单字词。10k 内成员带 CEFR 等级；10k 外成员 `rank=null` / `level=null`（等级留空）。
5. **head**：族内 CEFR rank 最小（最高频）的成员；family id 按 head rank 升序 `F0001…`。
6. **无族词**：不在任何族里的 10k 词（the/at 等）**不进** `families` / `mapping`，只计数 + 抽样；单例不强行编族（与 P1-03 一致）。
7. **人为判断与机器判断分离**：构图是全自动的；「坏边」「良性词性转换」「allowlist」是**人工审阅清单**，写死在脚本里并逐条校验存在性（数据漂移会直接报错），不当作全量结论。

## 2. 图与族规模

### 2.1 全量派生图

| 指标 | 数值 |
|---|---:|
| 单字节点 | **25,281** |
| 去重无向边 | **15,989** |
| 原始派生指针 | 74,717 |
| ↳ 自指（WordNet 把自己列进派生表） | 19,509 |
| ↳ 多词 lemma 指针 / 去重对 / 涉及多词节点 | 902 / 664 / 358 |
| ↳ 仅大小写归一后相同的指针 | 2,330 |
| 连通分量 | **9,481** |
| ↳ 没有 10k 成员（不成族） | 5,787 |
| 边分类：10k–10k / 跨边界 / 全在 10k 外 | **1,495 / 5,580 / 8,914** |
| 多词桥接若纳入会合并的单字分量 | **0** |

- `10k–10k` 的 1,495 条与 P1-03 完全一致，说明本次图的子集口径没有漂移。
- 多词 lemma（`ad_hoc` 之类）被排除后**一次合并没有发生**：多词节点没有同时挂在两个不同单字分量上。所以排除它们不影响任何单字词族，只是让成员列表干净。
- 边分类说明：真正让覆盖翻倍的是那 5,580 条跨边界边（10k 词 ↔ 10k 外词）；8,914 条全在 10k 外的边只影响「某个 10k 外的词是否跟着进族」，不影响 10k 词的覆盖。

### 2.2 覆盖（开放规则）

| 指标 | 数值 |
|---|---:|
| CEFR lemma | 10,000 |
| 词族数（≥2 成员且 ≥1 个 10k 成员） | **3,694** |
| 成员总数 | **11,563** |
| ↳ 10k 内成员 | **5,223（52.23%）** |
| ↳ 10k 外成员（等级留空） | **6,340（54.83% of 成员）** |
| 最大族 / 中位族 | **18 人 / 3 人** |
| 10k 内「有族 / 无族」 | **5,223 / 4,777（47.77%）** |
| 含 ≥2 个 10k 成员的族 | 1,176 |
| 只有 1 个 10k 成员的族 | 2,518（68.2%） |

**无族词 4,777 个**，rank 最小的 15 个是 `the, to, and, of, a, in, i, that, for, have, you, it, on, with, this` —— `the` / `at` 都不在任何族里（脚本断言 `theInAnyFamily=false`、`atInAnyFamily=false`）。

族内 10k 成员数分布：1 个 2,518 族、2 个 911、3 个 200、4 个 49、5 个 11、6 个 4、8 个 1（没有 7 个的）。

### 2.3 族大小分布

| 大小 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 18 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 族数 | 1,667 | 1,011 | 478 | 261 | 132 | 67 | 37 | 18 | 9 | 7 | 4 | 1 | 1 | 1 |

- ≥6 人的族 277 个、≥10 人的 23 个。P1-03 的 10k 内基线是 2 人 892 / 3 人 193 / 4 人 46 / 5 人 10 / 6 人 4（1,145 族）。
- 变大主要来自 10k 外派生词（`-ness / -tion / -ment / -able`），不是 10k 词之间新增了关系。

### 2.4 按 CEFR 等级覆盖（开放 vs P1-03）

| 等级 | lemma | 开放规则进族 | 覆盖率 | P1-03 覆盖率 |
|---|---:|---:|---:|---:|
| A1（1–1000） | 1,000 | 671 | **67.10%** | 37.30% |
| A2（1001–2000） | 1,000 | 648 | **64.80%** | 33.10% |
| B1（2001–4000） | 2,000 | 1,204 | **60.20%** | 33.55% |
| B2（4001–7000） | 3,000 | 1,451 | **48.37%** | 23.53% |
| C1（7001–10000） | 3,000 | 1,249 | **41.63%** | 18.00% |

- 增幅最大的是 A1（+29.8pp），最小的是 C1（+23.6pp）；等级越高仍然越难覆盖（C1 41.63%）。
- **跨级族**：按「族内 10k 成员出现几个不同等级」统计 → 1 级 2,737 族、2 级 826、3 级 115、4 级 14、5 级 2；**跨 ≥2 级共 957 族（25.9%）**。比例比 P1-03 的 81.5% 低，是因为新增了 2,518 个「只有 1 个 10k 成员」的族；但绝对数从 933 涨到 957，跨级问题没消失。

### 2.5 最大 10 族

| family | 大小 | 10k 成员 | head | 成员（★=10k 内） |
|---|---:|---:|---|---|
| F0265 | 18 | 8 | large | ★large, ★extend, ★extension, ★extensive, ★extent, ★comprehensive, ★comprehend, ★comprehension, comprehendible, comprehensibility, comprehensible, comprehensiveness, extendible, extensible, extensional, extensiveness, extensor, largeness |
| F0392 | 14 | 6 | sense | ★sense, ★sensitive, ★sensor, ★sensation, ★sensitivity, ★sensible, sensibility, sensibleness, sensify, sensing, sensitiveness, sensorial, sensuous, sensuousness |
| F3052 | 13 | 1 | ascend | ★ascend, ascendable, ascendance, ascendancy, ascendant, ascendence, ascendency, ascendent, ascender, ascension, ascensional, ascensive, ascent |
| F0064 | 12 | 4 | use | ★use, ★using, ★user, ★usage, serviceability, serviceable, serviceableness, usable, usableness, usance, useable, useableness |
| F0209 | 12 | 4 | stand | ★stand, ★standard, ★stance, ★standardize, standardisation, standardise, standardiser, standardization, standardizer, standee, stander, standing |
| F0641 | 12 | 2 | crime | ★crime, ★criminal, criminalise, criminality, criminalize, criminalness, criminate, criminative, criminatory, incriminate, incrimination, incriminatory |
| F0813 | 12 | 4 | concept | ★concept, ★conceive, ★conception, ★conceptual, conceiver, conceptional, conceptive, conceptualisation, conceptualise, conceptuality, conceptualization, conceptualize |
| F0325 | 11 | 5 | value | ★value, ★valuable, ★evaluate, ★evaluation, ★valuation, evaluative, evaluator, valuableness, valuate, valuator, valuer |
| F0371 | 11 | 1 | industry | ★industry, diligence, diligent, industrialisation, industrialise, industrialism, industrialist, industrialization, industrialize, industrious, industriousness |
| F0498 | 11 | 4 | judge | ★judge, ★judgment, ★judicial, ★judiciary, adjudicate, adjudicative, adjudicator, adjudicatory, judgeship, judging, judgmental |

> 全量 3,694 族在 `/tmp/word-family-open-candidates.json` 的 `families`。

## 3. 指定词族（卡里点名的 5 个）

### 3.1 `decide` 族：F0310，5 人

- 成员：`decide`(A1, 494)、`decision`(A1, 603)、`decisive`(C1, 7,294)、`deciding`(**10k 外**)、`decisiveness`(**10k 外**)。
- 边证据：`decide–decision`（`decide.v.01` ↔ `decision.n.01`）、`decide–decisive`（`decide.v.01/v.02/v.04` ↔ `decisive.a.01/a.03`）、`decide–deciding`（`decision_making.n.01`）、`decisive–decisiveness`（`decisiveness.n.01`、`finality.n.01`）。
- 相对 P1-03：多出 `deciding`、`decisiveness` 两个 10k 外成员；3 个 10k 成员不变（P1-03 的 F0169）。

### 3.2 `reflect` 族：F0983，4 人 —— **仍缺 `reflection`**

- 成员：`reflect`(A2, 1,645)、`reflective`(C1, 9,839)、`reflector`(10k 外)、`reflectivity`(10k 外)。
- 边证据：`reflect–reflective`（`reflect.v.04`、`chew_over.v.01` ↔ `reflective.a.02/s.03`、`brooding.s.01`）、`reflect–reflector`（`reflector.n.01`）、`reflective–reflectivity`（`reflection.n.08`、`reflectiveness.n.01`）。
- **`reflection`(B1, 3,622) 仍是无族词**：WordNet 3.0 里 `reflection` 的 8 个 synset 全没有派生指针；讽刺的是 `reflectivity` 的派生表里引用了 `reflection.n.08`（反向不对称）。结论与 P1-03 一致：**需要 allowlist `reflect–reflection`**，不能靠改构图规则解决。

### 3.3 `judge` 族：F0498，11 人

- 10k 内：`judge`(A1, 779)、`judgment`(B1, 3,348)、`judicial`(B2, 4,548)、`judiciary`(B2, 6,756)。
- 10k 外（等级留空）：`adjudicate`、`adjudicative`、`adjudicator`、`adjudicatory`、`judgeship`、`judging`、`judgmental`。
- 边证据含 `adjudicate–judge`（`judge.n.01`、`judge.v.05`、`decide.v.02`）——**这就是 P1-03 里被 10k 边界挡住、放开后重新进入的坏边**（§4.2 第 14 条）。11 人里有 4 个 10k 外成员直接由 `adjudicate` 派生，删掉这条边会把这 4 个词一起带走。

### 3.4 `critical` 族：F0899，8 人

- 成员：`critical`(A2, 1,486)、`crisis`(B1, 2,113)、`criticism`(B1)、`critic`(B1)、`criticize`(B1)、`criticise`(B2)、`criticality`(10k 外)、`criticalness`(10k 外)。
- 边证据：`crisis–critical`（`crisis.n.01/n.02` ↔ `critical.s.05`，义项是「处于危机边缘」）、`critical–criticism/critic` 等。
- **`critical/crisis` 是候选误合并**（§4.2 第 1 条）：`critical` 的主要释义「批评的 / 关键的」与「危机」不能互推。P1-03 建议的黑名单在这里依然成立；删边后 `crisis` 与 `critic*` 分成两族。

### 3.5 `comprehend` 族：F0265，18 人（**最大族，head 是 `large`**）—— **含 `extend`**

- 10k 内 8 个：`large`(A1, 430)、`extend`(A2, 1,217)、`extension`(B1, 2,381)、`extensive`(B1, 2,641)、`extent`(B1, 2,725)、`comprehensive`(B1, 3,264)、`comprehend`(C1, 7,976)、`comprehension`(C1, 9,927)。
- 10k 外 10 个：`comprehendible`、`comprehensibility`、`comprehensible`、`comprehensiveness`、`extendible`、`extensible`、`extensional`、`extensiveness`、`extensor`、`largeness`。
- **`extend` 在族里**（卡里问的答案是「是」），但合并路径不是 `comprehend–extend`（两者之间**没有直接边**），而是两条桥接边：
  1. `large–largeness`（`largeness.n.02`）+ `comprehensive–largeness`（`breadth.n.01`，该 synset 里同时有 `largeness`、`comprehensiveness`）→ large 簇与 comprehend 簇合并；
  2. `extensive–extensiveness`（`largeness.n.02`）+ `large–extensiveness`（`largeness.n.02`）→ extend 簇并入。
- 结论：这是**词义「广度 / 全面」义项**造成的桥接，不是词形派生。教学上 `large` 与 `comprehend` 同族没有意义。**建议把 ≥10 人的 23 个族列入人工复核清单**（本次只对 5 个点名族做了判定）；产品若不能拆，至少要在 UI 上把 18 人族的「同族」入口降级或折叠。

## 4. 坏边（人工清单）

**方法**：种子来自 P1-03 的 18 条图内候选 + 本次开放图。逐条回查 WordNet 的 synset 与关系方向；每条都要求「确实存在于本次图里」，否则脚本报错（防清单与数据漂移）。这是**高确定性清单，不是全量自动分类**；清单外仍可能有噪声。

### 4.1 分类汇总

| 类别 | 条数 | 分组（inherited / opened / new） | 说明 |
|---|---:|---|---|
| 语义已分化 `semantic_split` | 13 | 10 / 0 / 3 | 同源但现代释义不能互推 |
| 明显错误 `clear_error` | 4 | 3 / 1 / 0 | WordNet 指针/义项与现代词义不符 |
| **合计（建议黑名单）** | **17** | **13 / 1 / 3** | 命中 **16 个词族** |
| 良性词性转换 `pos_conversion` | 5 | — | 释义透明，**不建议删**（单独列在 `benignEdges`） |

- 17 条里 **15 条两端都在 10k 内**；`judge/adjudicate`、`industry/industrious` 只有一端在 10k。
- P1-03 的 10k 内基线在本脚本里显示 **15 条坏边 / 14 个族**，比它报告的 13 / 12 多 2 条，多出来的正是本次新发现的 `tend/tender`、`stand/standard`（两者在 10k 图内本来就存在，P1-03 未审到）。

### 4.2 逐条清单

| # | A | B | 类别 | 分组 | 10k 内 | 族 | 证据 synset | 审阅理由 |
|---:|---|---|---|---|---|---|---|---|
| 1 | critical | crisis | 语义已分化 | inherited | 是 | F0899 | crisis.n.01/n.02, critical.s.05 | 批评的/关键的 vs 危机 |
| 2 | elect | eligible | 语义已分化 | inherited | 是 | F0234 | elect.v.01, eligible.a.01 | 选举 vs 有资格的 |
| 3 | contain | continent | 语义已分化 | inherited | 是 | F0240 | hold.v.11, continent.a.01 | 「能控制排泄」冷僻义 |
| 4 | contain | content | 语义已分化 | inherited | 是 | F0240 | hold.v.11, capacity.n.03 | 包含 vs 内容/满足 |
| 5 | receive | receptor | 语义已分化 | inherited | 是 | F0611 | pick_up.v.09, sense_organ.n.01 | 收到 vs 受体（术语） |
| 6 | commit | committee | 语义已分化 | inherited | 是 | F0317 | entrust.v.01, committee.n.01 | 委托/犯罪 vs 委员会 |
| 7 | major | majority | 语义已分化 | inherited | 是 | F0501 | major.a.03/a.07, majority.n.01/n.02 | 主要的/主修 vs 多数 |
| 8 | signify | significant | 语义已分化 | inherited | 是 | F0736 | signify.v.02/v.03, meaning.s.01 | 表示 vs 重要的 |
| 9 | grave | gravity | 语义已分化 | inherited | 是 | F1193 | grave.s.01/s.03, graveness.n.01 | 坟墓 vs 重力；走「严肃」 |
| 10 | calculate | calculus | 语义已分化 | inherited | 是 | F1698 | calculate.v.01, calculus.n.03 | 计算 vs 微积分/结石 |
| 11 | tow | tower | 明显错误 | inherited | 是 | F1037 | tow.v.01, tugboat.n.01 | 拖 vs 塔 |
| 12 | tie | tier | 明显错误 | inherited | 是 | F0995 | tie.v.01/v.02, tier.n.02/n.03 | tier「打平的人」冷僻义 |
| 13 | grade | gradual | 明显错误 | inherited | 是 | F1601 | grade.n.03, gradual.a.02 | 坡度 → 不陡的 |
| 14 | judge | adjudicate | 明显错误 | **opened** | 否 | F0498 | judge.n.01, judge.v.05, decide.v.02 | 放开边界后重新入图；现代英语非派生 |
| 15 | tend | tender | 语义已分化 | **new** | 是 | F0399 | tend.v.02, attendant.n.01 | 倾向/照料 vs 温柔的/投标 |
| 16 | industry | industrious | 语义已分化 | **new** | 否 | F0371 | industry.n.02, hardworking.s.01, energetic.s.02 | 工业/行业 vs 勤奋的 |
| 17 | stand | standard | 语义已分化 | **new** | 是 | F0209 | stand.v.10, standard.n.05 | 站立 vs 标准；走「支柱/旗杆」 |

> 命中 16 个族：`F0209, F0234, F0240, F0317, F0371, F0399, F0498, F0501, F0611, F0736, F0899, F0995, F1037, F1193, F1601, F1698`。

### 4.3 新发现的三条为什么算坏边

- `tend / tender`：WordNet 走 `tender.n.03`「看护者」↔ `attendant.n.01`。学习者看到的 `tender` 是「温柔的 / 嫩的 / 投标」，和「倾向」没有可推的关系。
- `industry / industrious`：走 `industry.n.02`「勤勉」义项。`industry` 在 10k 里排 586，主要释义是「工业/行业」，同族给 `diligent`、`diligence` 反而误导。
- `stand / standard`：走 `standard.n.05`「支柱/旗杆」。`stand`(rank 357) 与 `standard`(626) 都是高频词，同屏展示会明显违和。

这三条都是**义项噪声**（`derivationally_related_forms` 是 synset 级的），不是构图 bug；说明开放边界后**必须靠人工清单兜底**，不能只靠 WordNet。

### 4.4 良性词性转换（5 条，不删）

`decide/decision`、`decide/decisive`、`reflect/reflective`、`protect/protective`、`differ/difference` —— 释义透明，产品上正是「词族」要表达的东西。把它们单列，是为了不把误合并率算高（P1-03 的分类口径一致）。

## 5. 规则对比

`边`=保留边数；`词族`=≥2 成员且 ≥1 个 10k 成员的分量；`10k 内`=落在族里的 10k 词；`无族`=10k 里没有族的词；`坏边`=人工清单里现存条数；`含坏边族`=至少含 1 条坏边的族。

| 规则 | 边 | 词族 | 成员 | 10k 内 | 10k 外 | 最大族 | 无族 | 坏边 | 含坏边族 | 覆盖率 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A. 仅 10k 内（P1-03 基线） | 1,495 | 1,145 | 2,621 | 2,621 | 0 | 6 | 7,379 | 15 | 14 | 26.21% |
| B. **全量派生图（开放边界）** | 15,989 | 3,694 | 11,563 | 5,223 | 6,340 | 18 | 4,777 | 17 | 16 | **52.23%** |
| C. B + allowlist | 16,011 | 3,689 | 11,580 | 5,240 | 6,340 | 18 | 4,760 | 17 | 16 | 52.40% |
| D. B − 黑名单 | 15,972 | 3,701 | 11,550 | 5,216 | 6,334 | 18 | 4,784 | 0 | 0 | 52.16% |
| **E. B + allowlist − 黑名单（建议）** | **15,994** | **3,696** | **11,567** | **5,233** | **6,334** | **18** | **4,767** | **0** | **0** | **52.33%** |

结论：

1. **规则本身成立**：A→B 覆盖 +2,602 个词（+26.02pp），族数翻 3.2 倍，最大族 6→18。代价是 6,340 个无等级成员。
2. **allowlist 只补缺、不加噪**：C 比 B 多 17 个覆盖词、族数反而 −5（`live/life`、`long/length`、`lose/loss`、`heal/health`、`weigh/weight` 等被合回同一族，`choose/choice` 新建 1 个族），没有新增坏边。
3. **黑名单代价很小**：D 比 B 少 7 个覆盖词（−0.07pp），换掉 17 条确认坏边、16 个族降到 0；族数 +7（拆族）。
4. **E 是可落地版本**：3,696 族 / 5,233 个 10k 词 / 52.33% / 最大族 18 / 坏边 0。
5. **不要用「同 POS」代替语义审核**：P1-03 已经证明它会杀掉 5 条良性跨词性链接、覆盖率腰斩、坏边只剩 6 条却全坏；开放图下结论不变（`major/majority`、`contain/content` 都是同 POS 的坏边）。

## 6. 风险与边界

1. **无等级成员是产品问题，不是数据问题**：6,340 个成员（54.8%）在 CEFR 10k 之外，没有等级可显示。词族 tab 必须明确「只显示词形 + 标『课外』」，不能默认 A1；否则 68.2% 的族会把 A1 和一堆生僻派生词混在一起。
2. **最大族的语义跨度**：18 人族（`large`/`extend`/`comprehend`）由 `largeness.n.02`、`breadth.n.01` 桥接；同类桥接在其他大族也存在（`use/serviceable`、`stand/standard`、`industry/diligent`、`tend/tender`）。**建议对 23 个 ≥10 人的族做人工复核**，本次只判定了卡里点名的 5 个族。
3. **WordNet 3.0 的系统性缺口比 P1-03 估计的严重**：不规则名词化（`strength/height/width/depth/warmth/truth/youth/length/life/loss/choice/sale/advice/breath/health/weight/flight`）整批没有派生边；`choose`、`strength` 在今天仍是**无族词**。这不是 allowlist 能根治的，需要一张人工「不规则派生表」长期维护（本次给 22 条首批）。
4. **坏边绝对数上升**：13→17（放开边界 +1，人工新发现 +3）。分母变大后比例从 1.05% 降到 0.43%，**不能说误合并变轻了**。
5. **跨级展示**：957 族（25.9%）跨 ≥2 个 CEFR 等级；2,518 个族只有 1 个 10k 成员。等级过滤会让族内成员数变化，产品要拍板（沿用 P1-03 的风险项）。
6. **义项噪声**：`derivationally_related_forms` 是 synset 级，冷僻义会拉进不相干的词（`continent` 走「能控制排泄」、`tier` 走「打平的人」）。清单兜底不是穷尽，清单外仍有噪声。
7. **`reflection` 类缺边只能 allowlist**：WordNet 3.0 的派生指针不对称，无族词里有一部分是「本该有族」的（本次 allowlist 22 条覆盖了其中一部分）。
8. **性能可接受**：全库扫描 4.2–4.8 s，构图 0.15 s，建族 0.35 s，总计 6.0–6.6 s（系统 python3 3.8.8 / nltk 3.6.1）。重跑成本低，适合每次词表或 WordNet 数据变更后复核。
9. **许可**：WordNet 3.0（Princeton University，2006）使用 **WordNet 3.0 License**（允许使用/复制/修改/分发，须保留版权声明与免责声明；禁止用 Princeton 名义背书；AS IS）。来源 <https://wordnet.princeton.edu/>；本机通过 NLTK 3.6.1 的 `wordnet` 语料读取（`/tmp/nltk_data`），**数据文件不提交、不随仓库分发**。若把派生映射随产品分发，需在产品 NOTICE 保留 WordNet 版权声明（本报告不构成法律意见）。
10. **只读边界**：脚本只读频表 / 释义 JSON 与 WordNet 语料，唯一写盘是 `--out`（默认 `/tmp`）。`backend/lemma_list.py`、`frontend/**`、`content/**`、`data/**` 零改动；`scripts/word_family_audit.py` 未被修改（其 15 例单测仍全过）。

## 7. 数据文件格式建议

**规模**（本次候选文件）：

| 指标 | 数值 |
|---|---:|
| 映射词数（只含族内词） | **11,563** |
| 族数 | 3,694 |
| 文件大小（紧凑 JSON，对象格式） | **1,469,090 B（1.40 MiB）** |
| JSON 加载耗时 | **22.7 ms**（`json.load`，Python 3.12） |
| 若只存 10k 词（退回 P1-03 口径） | 5,223 词 |

**建议的落地数据文件**（`content/wordlist/word_families.v1.json`，需产品/负责人确认后才新增；本次不提交）：

```json
{
  "schema": "linguatrek.word-family.v1",
  "version": "2026.11.23",
  "source": {"wordnet": "3.0", "frequencyBands": "2026.11.17",
             "frequencyBandsSha256": "67614c18…"},
  "license": "WordNet 3.0 License (Princeton University, 2006)",
  "families": [
    {"id": "F0310", "head": "decide",
     "members": [["decide", "A1", 494], ["decision", "A1", 603],
                 ["decisive", "C1", 7294], ["deciding", null, null],
                 ["decisiveness", null, null]]}
  ],
  "mapping": {"decide": "F0310", "decision": "F0310", "decisive": "F0310",
              "deciding": "F0310", "decisiveness": "F0310"}
}
```

设计要点（按本次审计结论）：

1. **只存族内词**：4,777 个无族词不进文件 → 前端查表 miss 就是「无族」，不需要额外标记。
2. **`mapping` 值用 family id 字符串**（不用对象）：head/size 都能从 `families` 反查；实测同样的内容按此格式序列化 **649,193 B**（1,469,090 B → −55.8%），即 ~0.62 MiB。
3. **10k 外成员 `level=null, rank=null`**：UI 必须能渲染「无等级」，这是本规则的核心代价。
4. **`families[].members` 已按「rank 升序、10k 外按字母序」排好**，前端不需要再排；`head` 恒为 `members[0]`。
5. **版本化 + 校验和**：文件带 `version` 与来源 sha256，放进 `content/wordlist/SHA256SUMS`（与 `frequency_bands.v1.json` 同流程）；每次重跑脚本 diff `families`/`mapping` 再更新，不静默改。
6. **黑名单 / allowlist 不写进数据文件**：它们是审计脚本里的人工清单（`BAD_EDGES` / `ALLOWLIST`）。落地时用「脚本生成 = 规则 E」，数据只存结果；清单变更走审计记录（本报告 §4/§5）。
7. **许可**：若随产品分发，`content/wordlist/NOTICE.md` 需保留 WordNet 版权声明（与现有频表 NOTICE 并列）。

## 8. 单测与验证

### 8.1 单测

```bash
backend/venv/bin/python -m pytest scripts/tests/test_word_family_open_audit.py -q
# 23 passed（pytest 9.2.0 / Python 3.12 venv）
```

覆盖点（全部固定小样本、不下载 WordNet）：

1. **锚定过滤**：分量里没有 10k 成员 → 不成族（`test_component_without_cefr_anchor_is_not_a_family`）。
2. **跨边界成员**：族内保留 10k 外词、`level=None`、head 仍是 10k 内那个（`test_cross_boundary_member_kept_with_empty_level`）。
3. **边界桥接**：两个 10k 词只靠一个 10k 外 pivot 连起来 → 同一族（`test_two_cefr_words_bridged_by_outside_lemma_share_one_family`）。
4. **无族排除**：the/at 不在 `mapping`/`families`，只计入 `cefr_without_family`。
5. **坏边分类与漂移**：类别校验、清单缺边报错、allowlist 已有边报错（`test_bad_edge_validation_and_drift_detection`）。
6. **黑名单/allowlist 效果**：删边拆族、补边合族（`test_allowlist_adds_missing_member_and_blacklist_splits_family`）。
7. **确定性**：同一文档两次 `dump_json` 字节一致、JSON 里没有耗时/时间戳（`test_run_audit_end_to_end_is_deterministic_and_timestamp_free`）。
8. **多词 / 自指 / 大小写归一 / 多词桥接统计**。

### 8.2 两次运行逐字节一致

```bash
python3 scripts/word_family_open_audit.py --wordnet-dir /tmp/nltk_data   # 两次
shasum -a 256 /tmp/word-family-open-candidates.json
# 8251ac2a253a784d6baaf86f06837728acc40d772f0957dbcce72796a3f80d3b（两次相同）
```

耗时行（`scan/build/families/total`）只打到 stdout，不进 JSON，因此不破坏逐字节一致。

### 8.3 只读证明（跑前 = 跑后）

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `content/wordlist/frequency_bands.v1.json` | 565,907 B | `67614c18f096cd7981da686c4c02f93447fb5d1dd3eceb76f5dfcbc2cbfd5927` |
| `content/wordlists/lexicon.v1.json` | 1,152,971 B | `80c0b1abbfbe4d7e5a3384a710a62e3e17caf1aa18a2dd386587de28a5281cd4` |

脚本内部在运行前后各算一次并断言一致（不一致直接退出码 4）；上表与 P1-03 报告一致，说明两次审计之间输入没被改动。

### 8.4 候选文件自洽性（可复算）

```bash
python3 - <<'PY'
import json, collections
d = json.load(open('/tmp/word-family-open-candidates.json'))
fams, mp, cov = d['families'], d['mapping'], d['coverage']
assert all(len(f['members']) >= 2 and any(m['level'] for m in f['members']) for f in fams)
assert 'the' not in mp and 'at' not in mp
assert cov['families'] == len(fams) == len({f['id'] for f in fams})
assert cov['members'] == len(mp) == sum(f['size'] for f in fams)
in_cefr = sum(1 for f in fams for m in f['members'] if m['level'])
assert cov['cefrMembers'] == in_cefr and in_cefr + cov['cefrWithoutFamily'] == 10000
assert all(f['head'] == f['members'][0]['w'] and f['members'][0]['level'] for f in fams)
assert {str(k): v for k, v in sorted(collections.Counter(f['size'] for f in fams).items())} == cov['sizeDistribution']
print("OK", len(fams), len(mp), cov['cefrMembers'], cov['outsideMembers'])
PY
# OK 3694 11563 5223 6340
```

### 8.5 未改动清单 & 工作区状态

- 新增（本卡）：`scripts/word_family_open_audit.py`、`scripts/tests/test_word_family_open_audit.py`、本报告。
- **未改**：`scripts/word_family_audit.py`（其单测 15 passed）、`backend/**`、`frontend/**`、`content/**`、`data/**`。
- `git status` 里其他改动（`frontend/src/components/ReportScreen.tsx`、`frontend/tailwind.config.js`、`scripts/p2-02-layout-acceptance.mjs` 等）属于 P2-02，不是本卡的写域。
- 未 commit（按卡要求）。

## 附录 A：候选 JSON 结构（节选）

```json
{
  "schema": "linguatrek.word-family-open-audit.v1",
  "rules": {"family": "连通分量 ≥2 成员，且 ≥1 成员 ∈ CEFR 10k", "head": "..."},
  "source": {"wordnet": {"version": "3.0", "license": "WordNet 3.0 License ..."},
             "frequencyBands": {"sha256": "67614c18…", "lemmas": 10000}},
  "graph": {"nodes": 25281, "edges": 15989, "rawPointers": 74717,
            "components": 9481, "componentsWithoutCefr": 5787,
            "edgeClasses": {"bothCefr": 1495, "crossBoundary": 5580, "outsideOnly": 8914}},
  "coverage": {"families": 3694, "members": 11563, "cefrMembers": 5223,
               "outsideMembers": 6340, "maxFamilySize": 18, "medianFamilySize": 3.0,
               "cefrWithoutFamily": 4777, "cefrCoveragePct": 52.23},
  "families": [
    {"id": "F0310", "head": "decide", "headLevel": "A1", "size": 5, "cefrMembers": 3,
     "members": [{"w": "decide", "rank": 494, "level": "A1"},
                 {"w": "deciding", "rank": null, "level": null}]}
  ],
  "mapping": {"decide": {"family": "F0310", "head": "decide", "size": 5}},
  "badEdges": [{"a": "crisis", "b": "critical", "category": "semantic_split",
                "group": "inherited", "synsets": ["crisis.n.01:n", "critical.s.05:s"]}],
  "blacklist": {"edges": [{"a": "...", "b": "..."}]},
  "allowlist": {"edges": [{"a": "reflect", "b": "reflection"}]},
  "examples": {"decide": {"family": "F0310", "members": [], "edges": []}},
  "assertions": {"theInAnyFamily": false, "atInAnyFamily": false,
                 "reflectionInReflectFamily": false,
                 "extendInComprehendFamily": true}
}
```

全量（3,694 族 + 11,563 映射 + 17 坏边 + 22 allowlist）在 `/tmp/word-family-open-candidates.json`，**未提交**。

## 附录 B：交付清单

| 路径 | 说明 |
|---|---|
| `scripts/word_family_open_audit.py` | 只读审计脚本（全量派生图 / 建族 / 坏边 / 规则对比 / 候选导出） |
| `scripts/tests/test_word_family_open_audit.py` | 23 例单测（固定样本，不依赖下载） |
| `docs/reports/word-family-open-audit-2026-11-23.md` | 本报告 |
| `/tmp/word-family-open-candidates.json` | 候选映射（不提交，1,469,090 B） |

## 附录 C：复现命令

```bash
cd yt-bilingual-app
# 人读摘要 + 写候选（默认 /tmp）
python3 scripts/word_family_open_audit.py --wordnet-dir /tmp/nltk_data
# 机器可读（stdout）
python3 scripts/word_family_open_audit.py --wordnet-dir /tmp/nltk_data --json
# 只打印不写盘
python3 scripts/word_family_open_audit.py --wordnet-dir /tmp/nltk_data --no-write
# 单测
backend/venv/bin/python -m pytest scripts/tests/test_word_family_open_audit.py -q
```

退出码：`0` 正常；`2` WordNet 语料/依赖不可用；`3` 人工清单与数据漂移；`4` 输入文件运行期间被改动。

---

## 9. 实现复核与 P1-11 应用（2026-11-23）

### 9.1 P1-05 实现（应用 AI 审计前）

生成数据 `content/wordlist/word-families.v1.json` 的实测数字与本文早期的「规则 E」摘要有差异，原因是本文摘要中的部分数字是**应用黑名单前**的基线；实现严格应用了 17 条黑名单后：

| 项 | 实现值 |
|---|---:|
| 词族 | 3,696 |
| 成员 | 11,567 |
| 10k 内 / 外 | 5,233 / 6,334 |
| 最大族 | 18 |
| judge 族 | 7（judge–adjudicate 已黑名单删除） |
| reflect 族 | 5（allowlist 补入 reflection） |

### 9.2 P1-11 应用 AI 审计 23 条高置信变更后

- 应用：13 条 trim（删 24 个成员及其所有边）+ 10 条 split（删 11 条桥边；`large`
  族需两条：`comprehensive–largeness`、`extensiveness–large`）。规则写在
  `scripts/build_word_families.py` 的 `TRIM_MEMBERS` / `SPLIT_EDGES`（含应用前审计
  族 id、成员/桥边与理由），逐条校验存在性；生成脚本 `--check` 幂等。
- 未应用：中/低置信 11 条（见 `docs/reports/word-family-ai-audit-summary-2026-11-23.md`）；
  构建脚本 `HELD_AUDIT_ITEMS` 断言它们仍在原族/原边。

| 项 | 应用后 |
|---|---:|
| 词族 | 3,704 |
| 成员 | 11,534 |
| 10k 内 / 外 | 5,233 / 6,301 |
| 最大族 | 14（`sense`） |
| 10k 覆盖率 | 52.33% |
| 无族词 | 4,767 |
| `large` / `extend` / `comprehensive` 族 | 2 / 9 / 7（原 18 人 `large` 族拆开） |
| `the` / `at` | 仍不在任何族 |

split 后无 10k 锚点的子组整体消失（`strenuous` / `tart` / `luminous` 组），成员数
因此减少 33（24 个 trim 成员 + 9 个失去锚点的子组成员）。以 P1-11 后的生成数据与
`specs/041` §1/§4 的实现验收数字为准；本文 §1–§8 作为审计过程记录保留。
