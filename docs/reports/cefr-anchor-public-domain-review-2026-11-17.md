# 公版书锚与 holdout 文章复核（2026-11-17）

> 状态：**复核完成；未改任何数据、未改阈值、未触碰 `content/books/`** ｜ 生成脚本：`scripts/build_cefr_anchor_book_review.py`（只读 truth + 两张答案表，确定性输出）
> 上游：[锚校准报告](cefr-anchor-report-2026-11-17.md) ｜ [15 条仲裁包](cefr-anchor-adjudication-2026-11-17.md) ｜ 双评明细：[AI 双评报告](cefr-anchor-ai-double-review-2026-11-17.md)

## 1. 结论

1. **13 条公版书节选里有 7 条指向「编辑标注可能偏低」**：3 条已是「两位评审都高于编辑标注」（其中 `M2-045` 高 **3 带**，是本批单条最大差），另有 4 条只在评审 A 那里高、评审 B 与编辑同带，需仲裁后才算数。
2. **机器预测也往同一方向偏**：13 条公版书里 8 条机器预测比编辑标注高 ≥2 带（平均高 +1.62 带），只有 2 条低（`M2-051` / `M2-057` 各 −1）。人工与词频两个独立信号方向一致。
3. **holdout 文章 7/9 落 ±1**；其中公版书 4 条只有 2/4，定位测短文 4/4、原创 1/1 —— 公版书是 holdout 里唯一掉出 ±1 的文本来源。
4. **反方向也不是没有**：`M2-003`（编辑 C1、两位评审都判 B2）与 `M2-057`（编辑 C1、评审 A 同、评审 B 判 B2）说明偏差不是「全体编辑偏低」，不能用一个统一偏移量去修正。
5. **本报告不判定谁对谁错，也不改数据。** 能确认的只是：公版书/叙事文本上存在**需要人工复核的系统性差**，候选共 **8 条**（确认型 4 + 待仲裁型 4）。改标注、改阈值都需要人类教研决定，不在本任务范围。

## 2. 口径（三列怎么读）

| 列 | 来源 | 口径 |
|---|---|---|
| 编辑 | `truth.items[*].editorialBand` | 编辑给出的 band。公版书是 **书级**（`editorialLabelLevel=book_level`），不是这段 120 词节选级——`truth` 的 notes 已注明这一点，本报告也按此保留歧义 |
| 人工共识 | 评审 A / B 答案表 | **两位一致**才叫共识；15 条相邻带分歧在仲裁完成前一律写「待仲裁」，不取平均、不取多数票 |
| 机器预测 | `truth.items[*].autoBand` | `difficulty.v1` 的 `cefr_input`（p90 实词覆盖判带），可能取 `C1+` |
| 共识−编辑 / 机器−编辑 | 本脚本计算 | 按 `A1<A2<B1<B2<C1<C1+` 的序号差（A1 折叠为 A2）；**正数 = 比编辑标注高** |

> 注：holdout 文章的「人工共识」列有 2 条是「待仲裁」，因此 §4 的 9 条表里有 7 条的共识可直接读；±1 口径见 §6。

## 3. 13 条公版书节选

| 匿名 id | 标题（作者, 年） | split | 编辑 | 评审 A | 评审 B | 人工共识 | 机器预测 | 共识−编辑 | 机器−编辑 | 标记 |
|---|---|---|---|---|---|---|---|---|---|---|
| `M2-018` | The Tale of Peter Rabbit（Beatrix Potter, 1902） | calibration | A2 | B1 | A2 | 待仲裁 | C1 | — | +3 | 编辑偏低候选（待仲裁） |
| `M2-021` | Alice's Adventures in Wonderland（Lewis Carroll, 1865） | holdout | B1 | B1 | B1 | B1 | B1 | 0 | 0 | 一致 |
| `M2-024` | The Hound of the Baskervilles（Arthur Conan Doyle, 1902） | calibration | B2 | C1 | C1 | C1 | C1+ | +1 | +2 | 编辑偏低候选 ✓ |
| `M2-026` | The Valley of Fear（Arthur Conan Doyle, 1915） | calibration | C1 | C1 | C1 | C1 | C1+ | 0 | +1 | 一致 |
| `M2-038` | The Tale of Two Bad Mice（Beatrix Potter, 1904） | holdout | A2 | B1 | A2 | 待仲裁 | C1 | — | +3 | 编辑偏低候选（待仲裁） |
| `M2-039` | A Study in Scarlet（Arthur Conan Doyle, 1887） | calibration | B2 | B2 | B2 | B2 | B2 | 0 | 0 | 一致 |
| `M2-042` | Five Children and It（E. Nesbit, 1902） | calibration | B1 | B1 | B1 | B1 | C1 | 0 | +2 | 一致 |
| `M2-045` | The Tailor of Gloucester（Beatrix Potter, 1903） | calibration | A2 | C1 | C1 | C1 | C1+ | +3 | +4 | 编辑偏低候选 ✓ |
| `M2-051` | The Story of Doctor Dolittle（Hugh Lofting, 1920） | calibration | B1 | B1 | B1 | B1 | A2 | 0 | -1 | 一致 |
| `M2-052` | The Tale of Squirrel Nutkin（Beatrix Potter, 1903） | calibration | A2 | B1 | A2 | 待仲裁 | B2 | — | +2 | 编辑偏低候选（待仲裁） |
| `M2-055` | Tarzan of the Apes（Edgar Rice Burroughs, 1914） | holdout | B2 | C1 | C1 | C1 | C1+ | +1 | +2 | 编辑偏低候选 ✓ |
| `M2-057` | The Memoirs of Sherlock Holmes（Arthur Conan Doyle, 1894） | calibration | C1 | C1 | B2 | 待仲裁 | B2 | — | -1 | 分歧跨编辑带（待仲裁） |
| `M2-059` | The Tale of Benjamin Bunny（Beatrix Potter, 1904） | holdout | A2 | B1 | A2 | 待仲裁 | C1+ | — | +4 | 编辑偏低候选（待仲裁） |

**读表要点**

- 13 条里人工共识与编辑标注完全同带 5 条、高 1 带以上 3 条、低 1 带 0 条（仅统计两人一致的 8 条）。
- 一致项的平均差 **+0.62 带**（8 条）；把分歧项按两人中点计入则全体平均 **+0.50 带**——但中点是描述统计，不是共识标签。
- 机器预测 vs 编辑：8/13 高 2 带及以上、1 条高 1 带、2 条同带、2 条低 1 带（`M2-051`/`M2-057`）；`C1+` 共出现 5 次。机器在叙事/旧式文本上的方向是**偏高**。

## 4. 9 条 holdout 文章（含 4 条公版书，与 §3 重叠）

| 匿名 id | 标题（作者, 年） | 来源集 | split | 编辑 | 评审 A | 评审 B | 人工共识 | 机器预测 | 共识−编辑 | 机器−编辑 | 标记 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `M2-003` | 定位测短文 fb-p4 | placement_11 | holdout | C1 | B2 | B2 | B2 | B2 | -1 | -1 | 编辑可能偏高 ✓ |
| `M2-021` | Alice's Adventures in Wonderland（Lewis Carroll, 1865） | public_domain_book_13 | holdout | B1 | B1 | B1 | B1 | B1 | 0 | 0 | 一致 |
| `M2-029` | 定位测短文 r-01 | placement_11 | holdout | A2 | A2 | A2 | A2 | B1 | 0 | +1 | 一致 |
| `M2-038` | The Tale of Two Bad Mice（Beatrix Potter, 1904） | public_domain_book_13 | holdout | A2 | B1 | A2 | 待仲裁 | C1 | — | +3 | 编辑偏低候选（待仲裁） |
| `M2-044` | The Case for Doing Nothing | content_difficulty_36 | holdout | A2 | B1 | B1 | B1 | B1 | +1 | +1 | 编辑偏低候选 ✓ |
| `M2-048` | 定位测短文 fa-p3 | placement_11 | holdout | B2 | B2 | B2 | B2 | B2 | 0 | 0 | 一致 |
| `M2-049` | 定位测短文 fa-p2 | placement_11 | holdout | B1 | B1 | B1 | B1 | B1 | 0 | 0 | 一致 |
| `M2-055` | Tarzan of the Apes（Edgar Rice Burroughs, 1914） | public_domain_book_13 | holdout | B2 | C1 | C1 | C1 | C1+ | +1 | +2 | 编辑偏低候选 ✓ |
| `M2-059` | The Tale of Benjamin Bunny（Beatrix Potter, 1904） | public_domain_book_13 | holdout | A2 | B1 | A2 | 待仲裁 | C1+ | — | +4 | 编辑偏低候选（待仲裁） |

**读表要点**

- 9 条里公版书 4 条（`M2-021`/`M2-038`/`M2-055`/`M2-059`，与 §3 同一批）、定位测短文 4 条、原创 1 条。
- 自动 ±1：定位测 4/4、原创 1/1；公版书 2/4（`M2-038`/`M2-059` 差 2–3 带，且都是编辑 A2 / 人工 B1 的待仲裁项）。
- 这解释了为什么 holdout 总体 80% 的 CI 会很宽：样本只有 20 条，掉出 ±1 的 4 条（`M2-004`/`M2-038`/`M2-053`/`M2-059`）里 2 条是公版书、2 条是视频，没有一条落在定位测短文上。

## 5. 候选清单（只标记，不改数据）

### 5.1 确认型：两位评审都高于编辑标注（4 条）

| 匿名 id | 标题 | 编辑 | 人工共识 | 共识−编辑 | 机器 | split |
|---|---|---|---|---|---|---|
| `M2-024` | The Hound of the Baskervilles | B2 | C1 | +1 | C1+ | calibration |
| `M2-045` | The Tailor of Gloucester | A2 | C1 | +3 | C1+ | calibration |
| `M2-055` | Tarzan of the Apes | B2 | C1 | +1 | C1+ | holdout |
| `M2-044` | The Case for Doing Nothing | A2 | B1 | +1 | B1 | holdout |

- `M2-045`（The Tailor of Gloucester，编辑 A2 / 两位评审都 C1 / 机器 C1+）是**最需要人工复核的一条**：差 3 带，且不是「节选难度」能完全解释的量级。
- 另外 3 条差 1 带：`M2-024`、`M2-055`（公版书）、`M2-044`（holdout 原创文章，编辑 A2 / 人工 B1 / 机器 B1）。

### 5.2 待仲裁型：评审 A 高于编辑、评审 B 与编辑同带（4 条）

| 匿名 id | 标题 | 编辑 | 评审 A / B | 机器 | split |
|---|---|---|---|---|---|
| `M2-018` | The Tale of Peter Rabbit | A2 | B1 / A2 | C1 | calibration |
| `M2-038` | The Tale of Two Bad Mice | A2 | B1 / A2 | C1 | holdout |
| `M2-052` | The Tale of Squirrel Nutkin | A2 | B1 / A2 | B2 | calibration |
| `M2-059` | The Tale of Benjamin Bunny | A2 | B1 / A2 | C1+ | holdout |

- 这 4 条**全部也是 15 条仲裁包里的条目**；仲裁结果若取 A 带，确认型名单会从 4 条扩到 8 条；若取 B 带则维持「编辑正确」。**不要预先假设方向。**

### 5.3 反方向：编辑标注可能偏高（1 条）

| 匿名 id | 标题 | 编辑 | 人工共识 | 机器 |
|---|---|---|---|---|
| `M2-003` | 定位测短文 fb-p4 | C1 | B2 | B2 |

> `M2-003` 是唯一一条「两位评审一致且低于编辑」的文本（编辑 C1 / 人工 B2 / 机器 B2）；`M2-057` 仍待仲裁。它的存在说明本批编辑标注的偏差不是单向的，用「统一 +1 带」之类的修正是错的。

## 6. 与锚报告口径的对齐（三处）

1. **「公版书文章 7/9」的写法容易误读**。锚报告 §5.3 写「holdout 中公版书文章 7/9（77.8%）」，但 holdout 的 9 条文章并非都是公版书：公版书 4 条、定位测短文 4 条、原创 1 条。7/9 是**全部 holdout 文章**的 ±1，公版书单独看是 2/4。本报告按来源拆开，锚报告已同步更正措辞。
2. **§5.5 的 19 条待人工确认、以及本报告引用的 consensus 列，都不要当作已定稿标签**：15 条仲裁标签未落盘，锚报告 §5.2 的两组 consensus 指标无法从文件复现（见锚报告 §5.6）。本报告只用「两人一致」作为共识，分歧项一律写「待仲裁」。
3. **holdout 文章的 ±1 用的是「待仲裁项取评审 B 带」的临时口径**（本报告为不预设仲裁结果，对 2 条待仲裁项统一按评审 B 带计算，仅用于与锚报告的 7/9 对齐；仲裁完成后以 `recompute_cefr_anchor.py` 重算为准）。若争议全取 A 带，公版书 4 条仍是 2/4、定位测 4/4、整体仍 7/9。

## 7. 为什么不能直接改数据（边界声明）

- **样本小**：13 条公版书里只有 8 条有可用的两人一致标签；4 条要靠仲裁，其余是单条差异，不足以支撑「把书级标注整体上调」。
- **标注层级不同**：编辑标的是**书级**（整本书的推荐读级），本报告比较的是**120 词节选**；节选偏难不等于全书标错。
- **评审本身是 AI**：两位评审在隔离环境中只看文本/字幕，未做人类听音与教学判断；公版书里的旧式词汇、长句对母语成人不难，对 CEFR 学习者难——这正是分歧点，需要人类教研裁定。
- **机器预测不是裁判**：`difficulty.v1` 在叙事文本上已知偏高（本表 8/13 高 ≥2 带），两个信号同向只提高「值得复核」的优先级，不能当作证据。
- **改动面**：`content/books/` 属仓库内容资产，改它需要 books 侧版本与验证；本任务明确只出报告。
- **因此本报告只产出：候选清单 + 差异列 + 复核建议**，不改任何数据文件。

## 8. 复现

```bash
cd /Users/piece/Desktop/Me/EnglishLearning/yt-bilingual-app
backend/venv/bin/python scripts/build_cefr_anchor_book_review.py            # 写本报告
backend/venv/bin/python scripts/build_cefr_anchor_book_review.py --check    # 只自检
```

- 只读 `docs/reports/cefr-anchor-truth-2026-11-17.json` 与两张答案表；不联网、不调用模型、不写 `content/books/`；
- 自检：13 + 9 条齐全、id 与 truth 一致、去重后候选 8 条、表中不含未填数值；
- 输出确定性：同输入重跑逐字节一致。
