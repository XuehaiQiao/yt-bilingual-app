# lemma 归并影响审计（P1-01）

- 日期：2026-11-23（本地；审计 JSON `generatedAt=2026-11-22T19:52:44Z`）
- 任务卡：`TASKS/P1-01-lemma-impact-audit.md`（owner implementer=`lemma-audit-impl`，reviewer/integrator=`lead`）
- 证据绑定：审计运行于 **HEAD `58b3b40`**；交付时 HEAD=`960c076`（lead 于 03:44 合入 P0-16，未触及本审计只读数据）。任务卡 `base_sha: c57d896` 与两者均不一致，按实际 HEAD 记录；未 commit。
- 脚本：`scripts/lemma_impact_audit.py`（只读；`--json` / `--user-id` / `--include-events`）
- 单测：`scripts/tests/test_lemma_impact_audit.py`（9 例，临时 ecdict/app.db/fixtures）
- 复现：
  ```bash
  python3 scripts/lemma_impact_audit.py --json --include-events > /tmp/lemma-audit.json
  ./backend/venv/bin/python -m pytest scripts/tests/test_lemma_impact_audit.py -q
  ```
- 只读证明（跑前 = 跑后 SHA-256）：

| 文件 | 大小 | SHA-256（跑前=跑后） |
|---|---:|---|
| `data/app.db` | 8,273,920 B | `ce204a33f91b7d71bd071e65f4c9584f90e6e33608f4222c7426ab4b2b2864b3` |
| `data/ecdict.db` | 109,002,752 B | `47f361f6cbc8b5bbcd5b1eb6fd3a9bd7ef5f872120ae920c32c051aad55f1a62` |
| `data/users/581d…/favorites.json` | 6,395 B | `5ae0e2aad0c0ae5e270cefed26769bdcf4ebde398b488f13dcf35ecece634b7c` |
| 其余 4 个空 `favorites.json` | 2 B | `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` |

SQLite 一律 `file:<path>?mode=ro&immutable=1`；脚本没有写库/写文件分支，不调用任何模型。
审计时尚无 `app.db-wal` / `app.db-shm`（immutable 读的是主库快照，若应用正在写需停写后重跑）。

**口径**：`NFC + trim + lowercase`；`stardict.exchange` 的 `0:<base>` 为基形；无 `0:` 回退原词；
多词短语/专名/歧义只进“人工复核候选”，不进入自动合并。`word_states`、`review_logs` 的 lemma
字段本身已按 `backend/srs.normalize_lemma` 写入，本报告再按同一 ECDICT 规则“重算”一次，用来估计
历史数据迁移代价。

---

## 0. 结论摘要

1. **现有数据规模很小，按 ECDICT 规则真正能合并的组很少**：收藏 10 条 → 10 个 lemma（可归并组 0）；
   `word_states` 10 条 → 10 个 lemma（0）；`dict_lookup` 114 条事件 / 108 个面形 → 107 个 lemma（可归并组 1：
   `generation`/`generations`）。**21 条事件的键会变化**，其中 18 条是安全变化，3 条命中“不自动合并”
   （`fixed`/`informed`/`lower` 同形词）。
2. **真正的风险不在“能合并多少”，而在“不能合并却合并了”**：ECDICT 的 `0:` 有已知错标
   （`number→numb`、`weed→wee`），且 `axes/leaves/does` 等有多个基形。候选清单见 §4。
3. **收藏侧只有 1 条需要改键**：`guardrails → guardrail`；**1 条 ECDICT 覆盖不到**：`Pumpkinhead`。
   收藏与复习状态有 **3 处同 lemma 重叠**（`infringement`/`masculinity`/`singularity`），这是方案 A
   需要选择“主记录”的全部冲突；收藏内部、`word_states` 内部各自同 lemma 多条的组数为 **0**。
4. **跨模块影响主要落在内置词表**：CEFR 10,000 行里 275 行本身是变形词（2.75%），GRE/CET4/CET6 唯一
   11,307 行里 337 行（2.98%）；这些行的星标/对勾/标色会因 lemma 对齐而改变匹配。考试词表另有 **59 行
   首字母大写**（专名/国籍/语言），不能自动合并。
5. **高亮筛选差集很小**（当前收藏/掌握只有 14 个词）：公共语料 7,980 个面形里，按 lemma 多命中
   `infringements`、`perpetrators` 2 个面形（各 1 次）；已掌握集合 0 差异。见过次数有 **21 个键**
   会从面形移到 lemma。周报的 lemma 影响为 **0**（`review_logs.lemma` 已是规范形）。
6. **建议先做方案 B（读时按 lemma 对齐，不迁移数据），A 押后到人工 allowlist 与 forms 回填完成之后**。
   见 §6。

---

## 1. 覆盖与归并量

### 1.1 我的单词（favorites，`type=vocabulary`）

当前有 `favorites.json` 的 5 个用户里，只有重点用户 `581d15fe48e44d24be36f06f9926a014` 非空；其余 4 个为空数组。

| 用户 | vocabulary 记录 | 面形 | 按规则 lemma | 可归并组 | 键变化 | 未覆盖 |
|---|---:|---:|---:|---:|---:|---:|
| `581d15fe…`（重点） | 10 | 10 | 10 | 0 | 1（`guardrails→guardrail`） | 1（`Pumpkinhead`） |
| `2b190582…` / `3d7a6c4e…` / `c17d5927…` / `e2b788ef…` | 0 | 0 | 0 | 0 | 0 | 0 |
| **全部** | **10** | **10** | **10** | **0** | **1** | **1 / 10 = 10.0%** |

逐条（重点用户，含来源与 `added_at`）：

| 收藏词 | lemma | 来源 | added_at（UTC） | 说明 |
|---|---|---|---|---|
| decentralized | decentralized | video `_j4Ru918V4w` | 2026-11-15T18:06:11Z | ECDICT 无 `0:`（自指），但反查可到 `decentralize`——规则漏归并候选 |
| chlorine | chlorine | video `eXdVDhOGqoE` | 2026-11-17T17:58:41Z | — |
| doomsday | doomsday | video `eXdVDhOGqoE` | 2026-11-17T17:58:44Z | — |
| singularity | singularity | video `eXdVDhOGqoE` | 2026-11-17T17:59:14Z | 与 `word_states` 重叠 |
| tangible | tangible | video `eXdVDhOGqoE` | 2026-11-17T18:01:10Z | — |
| infringement | infringement | video `eXdVDhOGqoE` | 2026-11-17T18:02:22Z | 与 `word_states` 重叠 |
| perpetrator | perpetrator | video `eXdVDhOGqoE` | 2026-11-17T18:03:34Z | — |
| masculinity | masculinity | video `eXdVDhOGqoE` | 2026-11-17T18:04:15Z | 与 `word_states` 重叠 |
| guardrails | **guardrail** | video `eXdVDhOGqoE` | 2026-11-17T18:11:33Z | 唯一键变化；安全（无歧义/专名） |
| Pumpkinhead | pumpkinhead | book `oz-the-marvelous-land-of-oz` | 2026-11-17T23:03:21Z | ECDICT 未覆盖（大小写查询均无行） |

> 结论：当前收藏即使全量按 lemma 归一化，**条数不减少**（10→10），只有 1 条键变化；
> 收藏内部没有“同一 lemma 多条”的冲突。

### 1.2 已掌握 / 复习状态（`word_states`）

全部 10 条都属于重点用户；`harbor` 的 `target_lang=vi-VN`，其余 `zh-CN`。

| 范围 | 记录 | 面形 | 按规则 lemma | 可归并组 | 键变化 | 短语/未覆盖 |
|---|---:|---:|---:|---:|---:|---|
| 重点用户 | 10 | 10 | 10 | 0 | 0 | 短语 1（`cyclone cellar`）；未覆盖 0 |
| 全部用户 | 10 | 10 | 10 | 0 | 0 | 同上 |

- `cyclone cellar`（book，`reps=2/lapses=1`）是多词短语，按规则**不自动合并**。
- `harbor`、`issue`、`thorny` 等本身即基形；`ecstacy` 是 `ecstasy` 的拼写变体，ECDICT 对
  `ecstacy` 无 `0:`，按规则不合并（保持原词）。
- 若只看“键变化”，现有 `word_states` **0 条**会变；变化只会在未来写入变形词时出现。

### 1.3 查词事件（`learning_events.event_type='dict_lookup'`）

`--include-events` 打开后：全部用户 114 条事件、108 个面形、107 个 lemma；重点用户 112 条、106 个面形、
105 个 lemma；另 2 条属于 2 个游客 pseudonym。

| 范围 | 事件 | 面形 | 按规则 lemma | 可归并组 | 可归并行 | 键变化 | 未覆盖 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 全部用户 | 114 | 108 | 107 | 1 | 2 | 21 | 23 个面形（21.3%） |
| 重点用户 | 112 | 106 | 105 | 1 | 2 | 21 | 23（按面形） |

- 唯一可归并组：`generation` / `generations`（2 条事件；去重后面形 108→107）。
- 21 条键变化示例：`dishes→dish`、`called→call`、`scenarios→scenario`、`authors→author`、
  `quieter→quiet`、`ships→ship`、`fees→fee`、`noticed→notice`、`youngest→young`、
  `interacting→interact`、`whirls→whirl`、`researchers→researcher`、`looked→look`、
  `whiskers→whisker`、`medicines→medicine`、`generations→generation`、`including→include`（2 条）、
  `fixed→fix`、`informed→inform`、`lower→low`。
- 其中 3 条被“不自动合并”拦住：`fixed`、`informed`、`lower`（均为“过去分词/比较级 vs 独立词”的同形词候选）。
- 未覆盖词 23 个（21.3%），主要是多词查询与专名：`pumpkinhead`、`gillikins`、`tippetarius`、
  `ready generations`、`falls short`、`gen z`、`navier–stokes existence and smoothness problem`、
  `riemann hypothesis`、`openai`、`bbc world service`、`people fixing the world`、`6 minute english` 等。
  其中 25 条事件、23 个去重面形；另 1 个收藏未覆盖词与 `pumpkinhead` 重叠。
- 重复面形（同一词被查多次，非 lemma 问题）：`sonar`、`including`、`broad`、`cyclone cellar`、
  `ready generations`、`falls short` 各 2 次（6 组）。

### 1.4 规则盲区：没有 `0:` 但反查得到基形

按任务规则“无 base 回退原词”，以下词不会合并；但 ECDICT 的基形行用 `s/i/p/d/3/r/t/f` 列出了它们，
说明规则会漏掉一部分不规则/派生变形。审计集内共 **123** 个词（79 个内置词表行、71 个公共语料词、
1 个收藏词），重点用户数据里的例子是：

- `decentralized`（收藏）：`decentralize` 行有 `d:decentralized`，但 `decentralized` 行是 `0:decentralized` 自指 →
  规则认不出；若按反查可归并到 `decentralize`。
- 其他例子（内置词表/语料）：`could→can`、`training→train`、`amazing→amaze`、`painting→paint`、
  `complicated→complicate`、`environs→environ`。`was/are` 属于同类（`be` 行有 `p:was`，但 `was` 行
  exchange 为空，`are` 连反查也没有），当前审计数据未出现，但用同一规则处理历史文本时会遇到。

> 这是“保守规则”的代价：宁可漏合并，不可错合并。若产品希望覆盖不规则变形，需要额外的反查/人工表，
> 不能只靠 `0:`。

---

## 2. 冲突清单

### 2.1 收藏内同一 lemma 多条

**0 组**。当前 10 条收藏去重后仍是 10 个面形/10 个 lemma；没有同一 lemma 的多条收藏，
也就没有“forms/来源/added_at 差异”的组。

### 2.2 `word_states` 内同一 lemma 多条

**0 组**。10 条 `word_states` 的 lemma 去重后仍是 10 条，没有需要比较
`reps/lapses/due/mastered/state(suspended)/definition` 的多行组。

保留规则（给未来冲突用，脚本 `_state_recommendation` 已实现）：

1. `reps` 最多者保留（复习次数代表更多学习证据）；
2. 平手看 `last_reviewed_at` 更新者；
3. 再平手优先 `mastered=1`（不能静默取消用户已掌握标记）；
4. 合并时：`definition` 取非空；`word_sources` 取并集；`created_at` 取最早；
   `mastered` 任一为 1 则保留 1；`suspended` 需人工确认（脚本不改状态）。

### 2.3 跨源同 lemma（收藏 vs 复习状态）

**3 组**，全部是“收藏了、也在复习队列里（未掌握）”：

| 词 | 收藏来源 / added_at | word_states：state / reps / lapses / due / mastered / definition | 建议 |
|---|---|---|---|
| infringement | video `eXdVDhOGqoE` / 2026-11-17T18:02:22Z | learning / 2 / 1 / 2026-11-21T17:07:34Z / 0 / null | 若走 A：保留 `word_states` 为 SRS 主记录，收藏折叠为来源/词形；definition 用收藏 `zh_text` 快照补齐 |
| masculinity | video `eXdVDhOGqoE` / 2026-11-17T18:04:15Z | review / 2 / 0 / 2026-11-23T17:02:55Z / 0 / null | 同上；保留最近复习更晚者 |
| singularity | video `eXdVDhOGqoE` / 2026-11-17T17:59:14Z | learning / 2 / 0 / 2026-11-21T17:12:10Z / 0 / null | 同上 |

按 `ADR/0001`，favorites 与“未掌握”的 `word_states` 当前允许并存，这 3 组**不是数据缺陷**；
但方案 A 的“主记录 + forms”会要求二选一，这是全部需要产品决策的冲突。

### 2.4 其他重复

- `dict_lookup` 重复面形 6 组（同一词被查 2 次）：`sonar`、`including`、`broad`、`cyclone cellar`、
  `ready generations`、`falls short`。事件层已有 60 秒去重，这些是跨时间去重后的合法重复；
  lemma 聚合不会删除事件，只改变“见过次数”的键。
- 收藏/状态库里没有发现大小写或 NFC 造成的隐形重复（归一化后无重复面形）。

---

## 3. 跨模块影响数字

### 3.1 内置词表（CEFR / GRE / CET4 / CET6）

口径：“变形行”= 该行词在 ECDICT 有 `0:<base>` 且 `base != 自身`。星标/对勾/标色按存储词形匹配，
因此这些行在基形被收藏/掌握时不会自动点亮（或反过来）。

| 词表 | 行数 | 变形行 | 占比 | 严格安全可合并 | 被拦（歧义/专名/同形） | 备注 |
|---|---:|---:|---:|---:|---:|---|
| CEFR（A1–C1 合并） | 10,000 | 275 | 2.75% | 253 | 22（歧义 1、专名 5、同形 17） | 275 行**全部**也是 10k 频表的 lemma 条目（频表把它们当独立词） |
| CET4 | 3,837 | 69 | 1.80% | 51 | 18（同形 18） | 与 CET6/GRE 有重叠，行数不可相加 |
| CET6 | 5,396 | 104 | 1.93% | 87 | 17（专名 1、同形 16） | 同上 |
| GRE | 7,479 | 243 | 3.25% | 233 | 10（歧义 3、同形 7） | 同上 |
| 考试词表唯一 | 11,307 | 337 | 2.98% | 311 | 26（歧义 3、专名 1、同形 22） | 59 行首字母大写，见下 |

CEFR 变形行的级别分布：A1 11、A2 25、B1 45、B2 85、C1 109（合计 275）。

示例（变形行 → ECDICT base）：

- CEFR：`used→use`、`using→use`、`later→late`、`higher→high`、`according→accord`、`died→die`；
  其中 `number→numb`、`bit→bite`、`ground→grind`、`lay→lie`、`weed→wee` 是**错/险合并**，见 §4。
- CET4：`later→late`、`thought→think`、`lay→lie`、`feeling→feel`、`means→mean`、`shot→shoot`、
  `born→bear`、`beginning→begin`、`understanding→understand`、`living→live`。
- CET6：`later→late`、`thought→think`、`lay→lie`、`means→mean`、`shot→shoot`、`beginning→begin`、
  `understanding→understand`、`living→live`、`finding→find`、`writing→write`。
- GRE：`bit→bite`、`limited→limit`、`criteria→criterion`、`sophisticated→sophisticate`、
  `bacteria→bacterium`、`dealing→deal`、`weed→wee`、`striking→strike`、`bore→bear`、`remains→remain`。

**考试词表 59 行首字母大写**（专名/国籍/语言，不能自动合并）：
`France`、`Germany`、`African`、`Christmas`、`Soviet`、`Africa`、`Christian`、`Indian`、`Jesus`、
`Jewish`、`German`、`Conservative`、`India`、`Christ`、`CORE`、`Spanish`、`Latin`、`Italian`、`Pole`、
`God`、`Islam`、`Atlantic`、`Roman`、`Greek`、`Saint`、`Egyptian`、`Swiss`、`FAX`、`Polish`、
`Mediterranean`、`Mars`、`Venus`、`Marxist`、`Englishman`、`Portuguese`、`Buddhism`、`Arabian`、
`Utopian`、`Welsh`、`Byzantine` 等（完整 59 行见 JSON `crossModule.builtinWordlists.exam.uppercase_examples`）。
CEFR 频表 0 行首字母大写。

**ECDICT 与运行期频表 `forms` 的交叉校验**（只作人工复核线索，不是自动拦截）：

- CEFR：`forms` 缺 235/275 个变形行；0 个直接冲突；275 个变形行同时是 CEFR lemma 条目（频表口径与 ECDICT 冲突）。
- CET6：1 个冲突（`noted`→ECDICT `note`，`forms` 给 `not`）；GRE：3 个冲突
  （`settled`→`settle` vs `set`、`doting`→`dote` vs `dot`、`labored`→`labore` vs `labor`）；
  CET4：0 个。
- 频表把变形行当独立 lemma 的考试词表行：CET4 30、CET6 34、GRE 9、唯一 41。

### 3.2 自定义词表

`user_wordlists` = **0 行**，`user_wordlist_items` = **0 行**，因此：
含变形词的行数 **0**，可归并组 **0**。导入逻辑（`wordlists.py`）只做 `NFC + casefold` 去重、
写 `word_key`，没有 lemma 字段；若未来有数据，脚本会按同样规则计入（当前没有可示例的行）。

### 3.3 短语表

`content/wordlists/phrases.v1.json` 570 条，全部是多词短语（570/570），ECDICT 有行 518 条，
但 **0 条有 `0:` 基形**，因此预计归并数 **0**，实际也是 **0**。52 条 ECDICT 完全无行（`get up` 等
在 ECDICT 的 `exchange` 里也没有可用的基形指针，属预期）。短语匹配应继续按 headword 精确匹配，
不进入单词 lemma 合并。

### 3.4 高亮筛选差集

语料：公共 `content/library`（55 个视频 + 67 篇文章），7,980 个去重面形 / 86,428 次出现。
“已掌握不标”在 `frontend/src/lib/ignoredWords.ts` 用精确小写词形匹配；词表星标/对勾同理。

| 集合 | 面形 / lemma | 按 lemma 新增命中（gain） | 丢失（lose） |
|---|---:|---|---|
| 收藏（重点用户 10 条） | 10 / 10 | **2 个面形、2 次**：`infringements→infringement`、`perpetrators→perpetrator` | 0 |
| 已掌握（`word_states.mastered=1`，4 条） | 4 / 4 | 0 | 0 |
| 并集 | 14 / 14 | 2 个面形、2 次 | 0 |

说明：个人观看历史（`data/users/<uid>/history`）不在本任务声明的只读范围，未读取；上面是公共内容语料的
模拟值，真实高亮差集会随用户看过的视频略增。

### 3.5 见过次数（`dict_lookup` 聚合）

- 重点用户：112 条事件、106 个面形、105 个 lemma；**21 个键**发生变化。
- 全部用户：114 / 108 / 107。
- 典型变化：`including` 2 次 → `include` 2 次；`generations` 1 次 → `generation` 2 次；
  `called→call`、`dishes→dish`、`fixed→fix`、`looked→look` 等从 0→1；
  `lower→low`、`informed→inform`、`noticed→notice` 等同样。
- API 现状（`backend/events.py:lookup_counts`）按小写面形 `GROUP BY` 并返回调用方请求的键；
  改成 lemma 后，前端若继续请求面形（如 `including`），会得到 0/缺失——必须同步改请求键或
  在读层做“面形→lemma”映射。这是方案 B 的关键消费方之一。

### 3.6 周报 / 事件口径

- 周报 `reviewedWords = COUNT(DISTINCT review_logs.lemma)`，`words.new = COUNT(DISTINCT word_states.lemma)`；
  两者**本来就已经按 lemma 去重**。当前 `review_logs` 12 行 / 6 个 distinct lemma，重新按 ECDICT
  规则归一化后的键变化为 **0**；因此现有两周（2026-11-09、2026-11-16）的 lemma 影响是 **0**。
- 周报是生成时快照：2026-11-16 那期存储 `reviewedWords=0`，当前回算该周有 5 个 lemma（10 次复习），
  差 -5 来自“快照之后才写入复习”，**不是 lemma 的影响**（`snapshot_drift` 字段已单列）。
- 事件口径：dict_lookup 在 2026-11-16 这一周（UTC）重点用户 112 条、106 面形 → 105 lemma（-1）；
  事件总数不变，只是“去重词数”少 1。

---

## 4. 误合并候选清单

脚本把候选分六类；其中“用户数据”指收藏/复习/查词/自定义词表，“词表”指内置词表，“语料”指公共内容。
所有数量都来自本次 JSON，人工复核时按词去重。

### 4.1 歧义（多基形 / 同形词）

- 数据层多基形 **30** 个。代表性例子：
  - `leaves`：ECDICT `0:leave`，但 `leaf` 行也列 `s:leaves` → 候选 `{leaf, leave}`；
  - `lives`：`{life, live}`；`shelves`：`{shelf, shelve}`；`does`：`{do, doe}`；
  - `axes`（公共语料）：ECDICT `0:ax`，但 `axis` 的复数也是 `axes`；`0:ax` 只覆盖斧头义 →
    多基形候选 `{ax, axe}`，**语义上仍会错**，必须人工加 `axes→不合并` 或按上下文消歧；
  - 内置词表：`halting→{halt, halter}`、`labored→{labor, labore}`、`enthralling→{enthral, enthrall}`。
  - 噪声（ECDICT 反查错字/多义）：`bathing→{bathe, bthe}`、`feeding→{fee, feed}`、`gases→{gas, gase}`、
    `programs→{program, programme}` 等；这些只说明“反查也必须人工复核”，不能直接当基形。
- 人工同形词清单（`CURATED_HOMOGRAPHS`，命中 **38** 个）：`number`（numb 比较级 vs 名词）、
  `bit`（bite 过去式 vs 名词）、`ground`（grind 过去式 vs 名词）、`lay`（lie 过去式 vs 动词放置）、
  `shot`、`born`、`means`、`feeling`、`living`、`learning`、`understanding`、`building`、`writing`、
  `finding`、`dealing`、`beginning`、`sophisticated`、`informed`、`fixed`、`lower`、`later`、
  `better`、`best`、`worse`、`worst`、`criteria`、`bacteria`、`laden`、`weed`、`does` 等。

### 4.2 专名

- 用户数据 **4** 个：`Kansas`（ECDICT `Kansas`，`n. 堪萨斯州`）、`Georgie`、`Generation X`（多词）、
  `Dorothy`（`n. 桃乐茜（女子名）`）。判定规则：释义出现“（男子名/女子名/地名/州/市/国/人/语/宗教/星球）”
  或 ECDICT 行本身首字母大写且释义指向专名。
- 内置词表：**59** 行首字母大写（§3.1），如 `France/Germany/Mars/God/Christian/Christmas`。
- 说明：ECDICT 里另有数百个专名信号（名字/地名）；这里只把**用户数据/词表行本身**的专名列为候选，
  不把整个 ECDICT 的名字表搬进报告。`Kansas` 同时也是 CEFR 10k 尾部的词（README 已说明专名会混入尾部）。

### 4.3 短语

- **595** 个：570 条短语表 headword（设计上就不合并）+ 25 个用户多词查询
  （`cyclone cellar`、`ready generations`、`falls short`、`a broad range of`、`navier–stokes …` 等）。
- 处理：按 headword/原句匹配，不进入单词 lemma 合并；高亮和收藏仍可按原始短语串工作。

### 4.4 ECDICT 覆盖不到的词

| 来源 | 去重数 | 示例 |
|---|---:|---|
| 用户收藏 | 1 | `Pumpkinhead`（大小写都无行） |
| 用户查词 | 23 | `pumpkinhead`、`gillikins`、`tippetarius`、`ready generations`、`falls short`、`gen z`、`openai`、`bbc world service`、`navier–stokes existence and smoothness problem`、`riemann hypothesis` |
| 内置词表 | 18 | `mourinho`、`kickstarter`、`lookin`、`didnt`、`woah`、`dont`、`spotify` 等（缩写/口语/专名） |
| 短语表 | 52 | `get up` 等纯多词条目 |
| 公共语料 | 319 | `covid`、`bitcoin`、`blockchain`、`didnt` 等新词/缩写 |

未覆盖词一律回退原词；其中用户数据 23 个占该集合 108 个面形的 **21.3%**（收藏 1/10 = 10%，
`word_states` 0/10 = 0%）。

### 4.5 ECDICT `0:` 疑似错标（必须在 allowlist 里显式排除）

| 词 | ECDICT 0: | 问题 |
|---|---|---|
| `number` | `numb` | number 是名词/动词；`0:numb` 只是 numb 的比较级义（`number` 行同时有 `numb-er` 的解释） |
| `weed` | `wee` | weed 是独立名词/动词（杂草/除草），不是 wee 的变形 |
| `axes` | `ax` | axis 的复数也是 axes；`0:ax` 只覆盖斧头义（且 ax/axe 两个拼写） |
| `laden` | `load` | `lade` 与 `load` 都列 `laden`；反查有两个基形 |
| `does` | `doe` | do 的第三人称单数 vs doe 的复数；多基形候选 `{do, doe}` |

另外 `decentralized` 是“规则漏归并”的反例（自指 `0:decentralized`，但 `decentralize` 列了它），
`was/are` 是“无 `0:` 且反查不完整”的已知死角。

### 4.6 人工复核建议

1. 落一张 `lemma_denylist`（至少 `number/weed/axes/laden/does/leaves/lives/shelves` 等）+
   一张 `phrase_allowlist`（短语表全部）；合并前逐词过一遍 §4.1–4.5。
2. `forms` 只信任“单义、规则变形”（复数/过去式/进行时且无语义漂移），比较级/形容词化/名词化
   一律不进自动 forms。
3. 专名/大写行不合并；`Kansas` 这类 CEFR 尾部专名宁可保留原词。

---

## 5. 游客本地数据

- `data/guests/` 当前 **7,296 个游客目录**：3,970 个含 `subscriptions.json` 或空 `history/` 子目录；
  实际文件 1,644 个（1,637 个 `subscriptions.json` + 7 个 history 文件）；**0 个 `favorites.json`**。
- 游客收藏/已掌握的权威存储是浏览器 localStorage：
  - `yt_bilingual_favorites`（游客收藏，含 vocabulary/sentence）
  - `yt_bilingual_guest_mastered_words`（游客“我会了”）
  - `yt_bilingual_ignored_words`（阅读高亮忽略表，和 mastered 同源）
- 因此服务端**无法逐条审计**游客收藏、掌握、词表状态与 lemma 冲突；只能看到游客 pseudonym 下的事件：
  本次 2 条 `dict_lookup`（2 个 pseudonym），且没有收藏表可与它们关联。
- 需要客户端归一化：在 localStorage 读写层做 `NFC + trim + lowercase`，未来再加 lemma（同一份
  规则/denylist），并明确“本地数据不参与服务端审计”。这部分不在本任务写域内。

---

## 6. 方案 A / B 对比与建议

| 维度 | 方案 A：主记录 + forms 合并 | 方案 B：仅状态按 lemma 对齐 |
|---|---|---|
| 改动范围 | 收藏/状态/事件统一按 lemma 写；新增 forms | 读时把 `word_states`/`review_logs`/见过次数/周报对齐 lemma；收藏与历史事件保留面形 |
| 影响记录数 | **134**（收藏 10 + 状态 10 + 事件 114） | **124**（状态 10 + 事件 114；收藏 10 不动） |
| 键变化 | **22**（收藏 1、事件 21） | **21**（事件 21） |
| 去重 | 收藏/状态内部 **0** 条；事件聚合后 distinct **-1**（事件本身不删） | 同左；收藏条数不变 |
| 跨源冲突 | **3** 组（§2.3）需选主记录 | 不需要（允许并存） |
| 错合并风险 | 3 条本来会被合并的字（`fixed/informed/lower`）+ 42 条被候选拦截 | 3 条 + 41 条被候选拦截 |
| 需要 forms | 是（至少 `guardrail→guardrails`；历史事件要回填） | 否（读时映射即可） |
| 回滚 | 有损迁移，需备份 + 审计日志 + 回滚脚本 | 改代码/开关即可，无数据删除 |
| 风险 | ECDICT 错标、forms 语义漂移、历史事件重写、跨源主记录选择 | 消费方漏改导致新数字分叉；收藏内同 lemma 仍多条 |
| 建议阶段 | 第三阶段 | **第一阶段** |

推荐路线（与任务卡 non_goal 一致：本报告只给建议，不做产品决策）：

0. **先落人工 allowlist/denylist**（§4.6）。这是 A/B 共同前置；当前命中同形词候选 38 个、
   多基形 30 个、ECDICT 错标 5 个。
1. **方案 B**：`word_states`、`review_logs`、见过次数、周报、词表标色、高亮筛选统一读时按 lemma 对齐；
   事件保留原词形 + 写 lemma 快照；不删任何行。高亮当前只会多命 2 个面形，风险可控。
2. 收藏**新增**时写入 lemma + 原词形（只影响新数据）；旧 10 条先不合并，等 B 运行一个版本后再评估。
3. 观测后再做方案 A：新增 forms 表、历史事件迁移、3 处跨源主记录决策；必须备份 + 审计日志 + 回滚。
4. 游客端在 localStorage 层做同样的归一化（客户端），并保留“本地不可服务端审计”的说明。

---

## 7. 限制与备注

- SQLite 用 `immutable=1` 读快照；审计期间若有其他写入方（应用进程），应停写后重跑；本次跑前跑后哈希一致。
- ECDICT 的 `exchange` 质量参差：`0:` 有错标（§4.5），反查有错字（§4.1 噪声）；本报告把所有
  “可疑”都放进候选而非自动合并。
- `frequency_bands.v1.json` 的 CEFR 是频带估计（wordfreq），不是官方 CEFR；它的 `forms` 只覆盖 10k 频表
  可解释的变形，缺项不等于 ECDICT 错。
- 数据量：`word_states` 10 行、`review_logs` 12 行、`weekly_reports` 2 行（重点用户）、
  `favorites` 只有 1 个非空用户；因此很多“冲突”类指标当前是 0，报告同时给出未来冲突的判断规则。
- 未提交 commit；只新增 `scripts/lemma_impact_audit.py`、`scripts/tests/test_lemma_impact_audit.py`、
  本报告三个文件。

---

## 8. 关键 JSON 字段（供后续自动化）

- `coverage.{favorites,wordStates,dictLookupEvents}`：记录/面形/lemma/可归并组/未覆盖比例。
- `conflicts.{favorites_same_lemma,word_states_same_lemma,cross_source_same_lemma}`。
- `crossModule.{builtinWordlists,phrases,highlight,seenCounts,weeklyAndEvents}`。
- `misMergeCandidates.{ambiguous_multi_base,proper_noun_candidates,phrase_candidates,uncovered_words,curated_homograph_candidates,ecd_suspect_bases,rule_blind_spots}`。
- `plans.{A,B,recommendation}`。
- `integrity.{before,after,diff.all_unchanged}`（零写入证明）。
