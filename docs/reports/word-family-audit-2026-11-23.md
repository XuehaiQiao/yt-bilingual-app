# WordNet 词族映射审计（P1-03）

- 日期：2026-11-23
- 任务卡：`TASKS/P1-03-word-family-audit.md`（owner implementer=`family-audit-impl`，reviewer/integrator=`lead`）
- 证据绑定：审计运行于 **HEAD `daca0c1`**（接手时 HEAD=`c3801fb`，期间 integrator 合入 P2-01 文档；两次数据文件 SHA-256 相同，见 §7）
- 脚本：`scripts/word_family_audit.py`（只读，新增）
- 单测：`scripts/tests/test_word_family_audit.py`（15 例，固定小样本，不下载 WordNet）
- 环境：系统 `python3` 3.8.8 + nltk 3.6.1；WordNet 3.0 数据位于 `/tmp/nltk_data`（`--wordnet-dir /tmp/nltk_data`）
- 候选映射：`/tmp/word-family-candidates.json`（**不提交**；含全部 1,145 个词族与 10k word→family 映射）
- 范围：只新增脚本/单测/本报告；未改 `backend/lemma_list.py`、前端、数据或词表，未 commit

## 0. 结论摘要

1. **覆盖率是主要问题，不是误合并**：10,000 个 CEFR lemma 里，**5,222 个（52.2%）**在 WordNet 里至少有一条派生关系（含指向 10k 外），但产品可用的「10k 内」只有 **2,621 个（26.2%）**；形成 **1,145 个词族（≥2 人）**，最大族 6 人，**7,379 个单例**。C1 最低（18.0%），A1 最高（37.3%）。
2. `decide / decision / decisive` 自动同族（F0169，恰好 3 人）；`reflect / reflective` 同族，但 **`reflection` 在 WordNet 3.0 里没有任何派生指针**（8 个 synset 全空），所以自动分组会把 `reflection` 漏成单例——这是数据缺口，不是构图 bug。
3. **跨出 10k 的链接很多**：9,540 条（5,492 个目标词，多为 `-ness/-ment/-tion` 派生词，例如 `rich→richness`）。放开边界只让进族 lemma 从 2,621 涨到 2,694（+73），却会引入 `judge→adjudicate` 这类词，**不值得**。
4. **误合并清单（人工审阅）19 条**：语义已分化 10 / 词性转换 5 / 明显错误 4；其中 18 条在 10k 图内。**13 条高确定性坏候选（语义已分化 + 明显错误）影响 12 / 1,145 个词族（1.05%）、占 13 / 1,495 条边（0.87%）**；把 5 条良性跨词性转换也算进来，16 个族（1.40%）含候选边。另 1 条（`judge/adjudicate`）已被 10k 边界挡住。**准确率总体不差，问题是覆盖太薄**。
5. **规则建议**：以「仅保留两侧都在 10k 内的链接」为基线 → 加人工 allowlist（首批 `reflect/reflection`）→ 人工黑名单/界面降级处理 13 条坏边。**不要**用「只保留同 POS」：它把 5 条良性跨词性链接全杀掉、覆盖率跌到 12.0%，却留下 6 条候选（全部是坏候选）。
6. **81.5% 的词族跨 CEFR 等级**（933/1,145；119 个跨 ≥3 级）。例：`decide`(A1)/`decision`(A1)/`decisive`(C1) 同族。词族展示需要等级过滤或等级标签，不能默认把 A1 和 C1 混在一起。
7. 产物只写 `/tmp`；两个输入 JSON 跑前跑后 SHA-256 完全一致（§7）。

## 1. 口径

1. **lemma**：频表 `entries` 原样，NFC + 小写；10,000 个都是单字（无空格/连字符）。
2. **派生边**：对每个 lemma 的每个 synset，取 `lemma.derivationally_related_forms()`；按 `(source, target, synset, pos)` 去重；去掉自指（WordNet 会把自己列进派生表）与多词 lemma；建**无向**边。
3. **产品可用图**：只保留**两侧都在 10k 内**的边（任务卡要求）；跨出的链接只统计，不参与分组。
4. **词族**：连通分量；只把 ≥2 个 10k 成员的连通分量叫词族；head = 族内 rank 最小（最高频）的 lemma；family id 按 head rank 升序 `F0001…`。单例不强行编族（映射里 `family=null`）。
5. **误合并候选**：机器构图不判断语义，因此这是**人工审阅清单**（脚本内置 19 条，逐条校验确实存在于 WordNet 边或跨出链接）；分类为人工判断：语义已分化 / 词性转换 / 明显错误。不是自动全量分类，也不声称穷尽。

## 2. 覆盖率与分布

### 2.1 总览（10k 内基线）

| 指标 | 数值 |
|---|---:|
| CEFR lemma | 10,000 |
| WordNet 没有任何 synset（多为功能词/专名/缩写，如 the/to/and） | 844（8.44%） |
| WordNet 原始派生指针 | 31,870 |
| 按 `(source,target,synset,pos)` 去重后的 relation 记录 | 25,382 |
| ↳ 其中自指 / 多词 | 9,612 / 69 |
| 去重后单字派生链接 | 15,701 |
| ↳ 目标在 10k 内 / 跨出 10k | 6,161 / 9,540（5,492 个目标词） |
| 10k 内无向边 | 1,495 |
| 有任意 WordNet 派生链接（含跨出 10k） | 5,222（52.22%） |
| **有 10k 内派生链接的 lemma（进族）** | **2,621（26.21%）** |
| **词族数（≥2 成员）** | **1,145** |
| 最大族 | **6 人**（4 个：`create`/F0116、`sense`/F0211、`election`/F0218、`critical`/F0465） |
| 单例（无 10k 内派生链接） | **7,379（73.79%）** |

族大小分布：2 人 892 族、3 人 193 族、4 人 46 族、5 人 10 族、6 人 4 族。

### 2.2 按 CEFR 等级

| 等级 | lemma | 进族 | 覆盖率 |
|---|---:|---:|---:|
| A1（rank 1–1000） | 1,000 | 373 | 37.30% |
| A2（1001–2000） | 1,000 | 331 | 33.10% |
| B1（2001–4000） | 2,000 | 671 | 33.55% |
| B2（4001–7000） | 3,000 | 706 | 23.53% |
| C1（7001–10000） | 3,000 | 540 | 18.00% |

**跨级词族**：933 / 1,145（81.5%）跨至少 2 个 CEFR 等级；119 族跨 ≥3 级
（等级集合大小分布：1 级 212 族、2 级 814、3 级 104、4 级 13、5 级 2）。
例：`decide`(A1)+`decision`(A1)+`decisive`(C1)；`reflect`(A2)+`reflective`(C1)；`critical`(A2)+`crisis`(B1)+…+`criticise`(B2)。

### 2.3 最大族与代表族（全部 1,145 族见 JSON 的 `families`）

| family | 大小 | head（rank） | 成员（等级） |
|---|---:|---|---|
| F0116 | 6 | create（A1, 362） | create(A1), creative(B1), creation(B1), creature(B1), creator(B1), creativity(B2) |
| F0211 | 6 | sense（A1, 620） | sense(A1), sensitive(B1), sensor(B1), sensation(B2), sensitivity(B2), sensible(B2) |
| F0218 | 6 | election（A1, 633） | election(A1), elect(A2), eligible(B1), electoral(B2), eligibility(C1), electorate(C1) |
| F0465 | 6 | critical（A2, 1486） | critical(A2), crisis(B1), criticism(B1), critic(B1), criticize(B1), criticise(B2) |
| F0073 | 5 | different（A1, 258） | different, difference, differ, differentiate, differential |
| F0131 | 5 | receive（A1, 390） | receive, reception, receiver, recipient, receptor |
| F0134 | 5 | sign（A1, 397） | sign, significant, signature, significance, signify |
| F0270 | 5 | contain（A1, 786） | contain, content, container, continent, continental |
| F0323 | 5 | committee（A1, 966） | committee, commission, commitment, commissioner, commit |
| F0406 | 5 | analysis（A2, 1288） | analysis, analyze, analyst, analytic, analytical |
| F0464 | 5 | resident（A2, 1484） | resident, residence, residential, reside, residency |
| F0480 | 5 | defend（A2, 1545） | defend, defence, defensive, defender, defendant |
| F0713 | 5 | offensive（B1, 2763） | offensive, offense, offend, offence, offender |
| F0716 | 5 | dominate（B1, 2775） | dominate, dominant, dominance, dominion, domination |

> 大小 ≥3 的族共 253 个；报告只列代表，机器可读全量在 `/tmp/word-family-candidates.json` 的 `families`（1,145 条，含每族成员与等级）。

### 2.4 被 10k 边界丢弃的跨出链接

- 9,540 条（5,492 个不同目标词）；高频目标多为未进 10k 的 `-ness/-ment/-tion` 派生：`active→activeness`（11）、`clear→clearness`（11）、`close→closing`（11）、`rich→richness`（11）、`dead→deadness`（10）……
- 这些目标不在 CEFR 词表里，产品展示不能直接显示；但反过来说明「如果允许族成员跨出 10k，可多覆盖一部分词」——本审计仍按卡要求保留 10k 内。
- 典型被挡的坏链接：`judge→adjudicate`（`adjudicate` 不在 10k）。若放开边界，`judge` 族会多一个 `adjudicate`（§3.3）。

## 3. 指定词族

### 3.1 `decide / decision / decisive`：同族（F0169）

- 族：`F0169`，head=`decide`，成员恰好 3 个：`decide`(A1, 494)、`decision`(A1, 603)、`decisive`(C1, 7294)。
- 边与 WordNet 关系：
  - `decide – decision`：`decide.v.01`（v）与 `decision.n.01`（n）双向；
  - `decide – decisive`：`decide.v.01/v.02/v.04`（v）与 `decisive.a.01/a.03`（a）；
  - `decision – decisive` 没有直接派生边（同族靠 `decide` 传递）。
- 结论：三词同族符合教学直觉；但 `decisive` 是 C1，和 A1 的 `decide` 同屏需要等级提示。

### 3.2 `reflect / reflection / reflective`：**不同族**（自动只得到 2 人）

- `reflect`(A2, 1645) 与 `reflective`(C1, 9839) 同族 `F0502`；边：`reflect.v.04`、`chew_over.v.01`（v）与 `reflective.a.02`、`brooding.s.01`、`reflective.s.03`（a/s）。
- **`reflection`(B1, 3622) 是单例**：WordNet 3.0 里 `reflection` 的 8 个 synset 的 lemma **全部没有** `derivationally_related_forms()` 指针；`reflect` 侧也只挂 `reflective`/`reflector`（`reflector` 不在 10k）。这是 WordNet 3.0 的**不对称/数据缺口**，不是构图取舍。
- 人工 allowlist 补一条 `reflect–reflection` 后：进族 lemma 2,621→2,622，族数不变（reflection 从单例并入 F0502，变成 3 人）。报告建议把这类「明显该有、WordNet 没给」的边走 allowlist，而非加全局规则。

### 3.3 `critical / crisis` 与 `judge / adjudicate`

- `critical / crisis` 自动同族（F0465），族成员见 §2.3。链接证据：`crisis.n.01/n.02`（n）↔ `critical.s.05`（s，义项英文：「being in or verging on a state of crisis or emergency」）。**这是候选误合并**：`critical` 的主要释义是「批评的/关键的」，与「危机」不能互推；见 §4。
- `judge / adjudicate` **没有**进 10k 图：`adjudicate` 不在 10k，`judge.n.01` 的派生指针指向 `adjudicate` 被边界丢弃。`judge` 自动族是 `F0267`：`judge`(A1, 779)、`judgment`(B1, 3348)、`judicial`(B2, 4548)、`judiciary`(B2, 6756)。若放开 10k 边界，`judge` 会连上 `adjudicate`（§4 的明显错误候选）——这正是保留 10k 边界的收益。

## 4. 误合并候选（人工审阅清单）

**方法**：人工审阅 19 条候选——种子来自任务卡（`critical/crisis`、`judge/adjudicate`）+ 对全部 253 个 ≥3 人族、142 条零中文释义共字的边、以及全部跨 POS 边的逐条检查；每条都回查 WordNet 的 synset 与关系方向。分类是语义判断，不是自动分类器；清单写死在脚本里并做存在性校验（数据/清单漂移会报错）。**这是高确定性清单，不是全量统计；清单之外仍可能有噪声。**

### 4.1 分类汇总

| 类别 | 条目 | 其中在 10k 图内 | 说明 |
|---|---:|---:|---|
| 语义已分化 | 10 | 10 | 同源但现代释义不能互推 |
| 词性转换 | 5 | 5 | 可接受的跨词性链接（教学上透明） |
| 明显错误 | 4 | 3 | WordNet 指针/义项与现代词义不符；`judge/adjudicate` 在被丢弃的跨出边里 |
| **合计** | **19** | **18** | 图内 18 条分布在 **16 个词族** |

图内 18 条 → **16 个词族**（1.40% of 1,145）；其中 13 条「坏候选」（语义已分化 + 明显错误）→ **12 个词族 = 1.05%**、**13/1,495 条边 = 0.87%**。另 5 条是良性词性转换，不应被算作误合并（它们让「含候选边」的族数从 12 变成 16）。

### 4.2 逐条清单

| # | A | B | POS(A/B) | 类别 | 族 | 主要关系（synset） | 审阅理由 |
|---:|---|---|---|---|---|---|---|
| 1 | critical | crisis | a,s / n | 语义已分化 | F0465 | crisis.n.01 ↔ critical.s.05 | 批评的/关键的 vs 危机；走 critical 的次要义项 |
| 2 | elect | eligible | n,s,v / a | 语义已分化 | F0218 | elect.v.01 ↔ eligible.a.01 | 选举 vs 有资格的 |
| 3 | contain | continent | v / a,n,s | 语义已分化 | F0270 | hold.v.11 ↔ continent.a.01 | 包含 vs 大陆；链接走「能控制排泄」冷僻义 |
| 4 | contain | content | v / a,n,v | 语义已分化 | F0270 | hold.v.11 ↔ capacity.n.03 | 包含 vs 内容/满足 |
| 5 | receive | receptor | v / n | 语义已分化 | F0131 | pick_up.v.09 ↔ sense_organ.n.01 | 收到 vs 受体/感受器（专业术语） |
| 6 | commit | committee | v / n | 语义已分化 | F0323 | entrust.v.01 ↔ committee.n.01 | 委托/犯罪 vs 委员会 |
| 7 | major | majority | a,n,s,v / n | 语义已分化 | F0173 | major.a.03/a.07 ↔ majority.n.0x | 主要的/主修 vs 多数（同 POS 也挡不住） |
| 8 | signify | significant | v / a,s | 语义已分化 | F0134 | signify.v.02 ↔ meaning.s.01 | 表示 vs 重要的 |
| 9 | grave | gravity | n,s,v / n | 语义已分化 | F0740 | grave.s.01/s.03 ↔ gravity.n.02 | 坟墓 vs 重力；走「严肃」义项 |
| 10 | calculate | calculus | v / n | 语义已分化 | F0780 | calculate.v.01 ↔ calculus.n.03 | 计算 vs 微积分/结石 |
| 11 | decide | decision | v / n | 词性转换 | F0169 | decide.v.01 ↔ decision.n.01 | 释义透明，可接受 |
| 12 | decide | decisive | v / a,s | 词性转换 | F0169 | decide.v.01/v.02/v.04 ↔ decisive.a.0x | 释义透明，可接受 |
| 13 | reflect | reflective | v / a,s | 词性转换 | F0502 | reflect.v.04 / chew_over.v.01 ↔ reflective.a.02… | 释义透明，可接受 |
| 14 | protect | protective | v / a,s | 词性转换 | F0254 | protect.v.01/v.02 ↔ protective.a.01 | 释义透明，可接受 |
| 15 | differ | difference | v / n | 词性转换 | F0073 | differ.v.01 ↔ difference.n.01 | 释义透明，可接受 |
| 16 | tow | tower | n,v / n,v | 明显错误 | F0574 | tow.v.01 → tower；tower → tow 走 tugboat.n.01（拖船） | 拖 vs 塔；现代英语无派生关系 |
| 17 | tie | tier | n,v / n | 明显错误 | F0517 | tie.v.01/v.02 ↔ tier.n.02–04 | WordNet 用 tier「打平的人/系东西的人」冷僻义 |
| 18 | grade | gradual | n,v / a,n | 明显错误 | F0378 | grade.n.03 ↔ gradual.a.02 | 走「坡度→不陡的」，非现代派生 |
| 19 | judge | adjudicate | n,v / v | 明显错误 | F0267（A 侧） | judge.n.01 → adjudicate（**跨出边，已丢弃**） | 现代英语非派生；10k 边界已挡住 |

> 良性「词性转换」不是产品 bug：若词族 tab 需要保留 `decide→decision`，这些边应保留；报告把它们列出，是为了区分「合并会带来语义噪声」和「合并只是跨词性」。

## 5. 规则对比

图规模口径：`边`=保留边数；`有链接 lemma`=有 ≥1 条保留边的 10k lemma；`进族 lemma`=落在 ≥2 成员连通分量的 10k lemma；`词族`=≥2 成员的连通分量；`坏候选`=人工清单中「语义已分化 + 明显错误」的边存活数；`坏候选族`=含 ≥1 条坏候选边的词族。误合并率 = 坏候选族 / 词族数；良性词性转换不计入分子。

| 规则 | 边 | 有链接 lemma | 进族 lemma | 词族 | 最大族 | 单例 | 候选边 | 坏候选 | 坏候选族 | 误合并率 | 覆盖率 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A. 仅 10k 内（基线） | 1,495 | 2,621 | 2,621 | 1,145 | 6 | 7,379 | 18 | 13 | 12 | 1.05% | 26.21% |
| B. 10k + 同 POS | 641 | 1,198 | 1,198 | 558 | 5 | 8,802 | 6 | 6 | 6 | 1.08% | 11.98% |
| C. 放开 10k 边界 | 7,055 | 5,222 | 2,694 | 1,174 | 6 | 7,306 | 19 | 14 | 13 | 1.11% | 26.94% |
| D. 放开边界 + 同 POS | 3,517 | 2,918 | 1,208 | 563 | 5 | 8,792 | 7 | 7 | 7 | 1.24% | 12.08% |
| E. A + 人工 allowlist | 1,496 | 2,622 | 2,622 | 1,145 | 6 | 7,378 | 18 | 13 | 12 | 1.05% | 26.22% |
| **F. A + allowlist − 人工黑名单（建议）** | **1,483** | **2,609** | **2,609** | **1,144** | **6** | **7,391** | **5** | **0** | **0** | **0%** | **26.09%** |

结论：

1. **B（同 POS）不可取**：覆盖率从 26.21% 跌到 11.98%（-14.23pp，-54.3%），却保留 6 条候选——恰好是 6 条坏候选（`contain/content`、`major/majority`、`grave/gravity`、`tow/tower`、`tie/tier`、`grade/gradual`，误合并族 6/558=1.08%）；5 条良性跨词性链接（decide/decision 等）全部被杀。**「同 POS」不是安全规则**。
2. **C（放开边界）不划算**：进族 lemma 只从 2,621 涨到 2,694（+73，+2.8%），却引入 `judge/adjudicate` 这类坏边；另有 2,528 个 lemma 只连到 10k 之外的词，产品无法直接展示。故保留 10k 边界。
3. **E（allowlist）**：只补 WordNet 缺边，覆盖率 +1（`reflection`），无新增候选；成本极低，建议保留机制（人工审核逐条加）。
4. **F（建议）**：在 A+allowlist 上人工去掉 13 条坏候选边，覆盖率 -13 个 lemma（-0.13pp），坏候选归零；代价是 `critical` 族从 6 人拆成 5+1、`contain` 5 人拆成 2+2+1 等，产品上可接受。**黑名单是产品取舍，不应偷偷写进数据**；每次加边都要留审计记录。

### 5.1 建议落地步骤

1. 数据侧：产出「在 10k 内的无向派生边」+「人工 allowlist」两张表；边不直接入应用数据文件，先用脚本生成候选映射。
2. 展示侧：只有 `family` 非空的词显示词族入口（单例 7,379 个不显示）；词族内显示等级标签，按用户等级过滤/提示（81.5% 族跨级）。
3. 人工 allowlist：先补 `reflect/reflection`；把「WordNet 缺失但教学明确」的边走同一流程，不扩全局规则。
4. 人工黑名单：§4 的 13 条图内坏候选（影响 12 个族；含良性转换共 16 族），产品确认后再决定「拆族」还是「保留但在 UI 标语义分化」。
5. 迭代：词表版本或 WordNet 数据变化时重跑脚本，对比 `families`/`mapping` 的 diff，不静默更新。

## 6. 风险与边界

1. **覆盖率低**：26.21% 是产品最大风险；C1 只有 18.0%。如果「词族」tab 期待大多数词都有族，WordNet 3.0 单独不够，需要人工补边或接受「无族」空态。
2. **WordNet 3.0 老且稀疏**：2006 年发布；派生关系靠人工/词库维护，缺 `reflection` 这类常见词；不是完整 derivational morphology 资源。
3. **义项噪声**：`derivationally_related_forms` 是 synset 级的，可能只挂在冷僻义项上（`continent.a.01` 的「能控制排泄」）；本审计用人工清单兜底，未能自动全量判定。
4. **不对称**：WordNet 的派生指针方向不保证双向；本审计建无向图规避，但缺边（如 reflection）仍会漏。
5. **同 POS 规则的假安全**：见 §5；不要用「POS 相同」代替语义审核。
6. **候选清单不是穷尽**：19 条是高确定性人工清单；按固定规则抽出的零释义共字边还有噪声（`begin/beginner` 这类是良性），不能直接当误合并率。13 条坏边/0.87% 是**已确认**的下限，不是全库真值。
7. **跨级展示**：933/1,145 族跨 CEFR 等级；若产品按等级筛选，族内成员会变化，需要产品拍板（本次不做产品决策）。
8. **许可**：WordNet 3.0（Princeton University，2006）使用 **WordNet 3.0 License**（允许使用/复制/修改/分发，须保留版权声明与免责声明；禁止用 Princeton 名义背书；AS IS）。来源 <https://wordnet.princeton.edu/>；本机通过 NLTK 3.6.1 的 `wordnet` 语料读取（`/tmp/nltk_data`），**数据文件不提交、不随仓库分发**。若后续把派生映射随产品分发，需在产品 NOTICE 中保留 WordNet 版权声明（本报告不构成法律意见）。
9. **只读边界**：脚本只读两个 JSON，不写仓库数据；唯一写盘是 `--out`（默认 `/tmp`）。`backend/lemma_list.py` 与前端零改动。

## 7. 只读证明与复现

### 7.1 SHA-256（跑前 = 跑后）

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `content/wordlist/frequency_bands.v1.json` | 565,907 B | `67614c18f096cd7981da686c4c02f93447fb5d1dd3eceb76f5dfcbc2cbfd5927` |
| `content/wordlists/lexicon.v1.json` | 1,152,971 B | `80c0b1abbfbe4d7e5a3384a710a62e3e17caf1aa18a2dd386587de28a5281cd4` |

### 7.2 复现命令

```bash
cd yt-bilingual-app
python3 scripts/word_family_audit.py --wordnet-dir /tmp/nltk_data
# 机器可读摘要：
python3 scripts/word_family_audit.py --wordnet-dir /tmp/nltk_data --json
# 单测（固定小样本，不需要下载 WordNet）：
backend/venv/bin/python -m pytest scripts/tests/test_word_family_audit.py -q
```

- 连续跑两次，`/tmp/word-family-candidates.json` 逐字节一致（确定性输出；无运行时时间戳）。
- 本报告数字均可从上一条命令的 stdout / `/tmp/word-family-candidates.json` 复算。
- 单测结果：**15 passed**（`pytest 9.2.0`，Python 3.12 venv；脚本本体跑在系统 python3 3.8.8）。

## 附录 A：候选映射 JSON 结构（节选）

```json
{
  "schema": "linguatrek.word-family-audit.v1",
  "coverage": {"lemmas": 10000, "lemmas_in_family": 2621,
               "families": 1145, "singletons": 7379, "max_family_size": 6},
  "families": [
    {"id": "F0169", "head": "decide", "level": "A1", "size": 3,
     "members": ["decide", "decision", "decisive"]}
  ],
  "mapping": {
    "decide":   {"family": "F0169", "head": "decide", "size": 3},
    "decision": {"family": "F0169", "head": "decide", "size": 3},
    "decisive": {"family": "F0169", "head": "decide", "size": 3},
    "reflection": {"family": null, "head": null, "size": 1}
  },
  "mergeCandidates": {"summary": {
    "total": 19, "inGraph": 18, "droppedOnly": 1,
    "byCategory": {"semantic_split": 10, "pos_conversion": 5, "clear_error": 4}
  }}
}
```

全量（10k 条 mapping + 1,145 条 families + 19 条候选）在 `/tmp/word-family-candidates.json`，**未提交**。

## 附录 B：交付清单

| 路径 | 说明 |
|---|---|
| `scripts/word_family_audit.py` | 只读审计脚本（构图/覆盖/误合并/规则对比/候选映射） |
| `scripts/tests/test_word_family_audit.py` | 15 例单测（固定样本，不依赖下载） |
| `docs/reports/word-family-audit-2026-11-23.md` | 本报告 |
| `/tmp/word-family-candidates.json` | 候选映射（不提交） |

未修改：`backend/lemma_list.py`、`frontend/**`、`content/**`、`data/**`；未 commit。
