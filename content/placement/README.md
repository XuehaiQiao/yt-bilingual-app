# content/placement/ — 能力定位测题库（M4 / M1 / M2 草稿）

> **状态：草稿，待教研审校；未经 30–50 人 pilot 校准。** 所有题库文件的
> `_meta.notice` 都带「待教研审校」；后端 `placement.py` 加载时会校验该标记，
> 缺了直接 503，防止未审校的题直接上线。题级 `b` 是题带中心的**编辑占位**，
> `pValue` 全部为 **null（pending pilot）**；本目录不提供、也不应被引用为
> 「已等值」「已校准」「有效度」的证据。

## 目录

```
content/placement/
├── vocab.json / reading.json / pseudo.json        # v1 旧 39 题（默认题库）
└── forms/
    ├── form-a/{vocab,pseudo,reading}.json         # Form A：64 题
    └── form-b/{vocab,pseudo,reading}.json         # Form B：64 题
```

| 题库 | 内容 | 数量 | 用途 |
|---|---|---|---|
| v1（根目录三份） | 30 词 + 5 阅读 + 4 伪词 | 39 | 默认；旧流程/旧会话回退 |
| Form A | 40 真词 + 4 伪词（= 44 词汇槽）+ 20 阅读（4 篇 × 5 题） | 64 | `PLACEMENT_BANK_VERSION=v2` |
| Form B | 同上，不同题目 | 64 | 同上，与 A 共享 10 道锚题 |

- **44 词汇槽 = 40 真词 + 4 伪词**；加 20 阅读 = **64 题/套**（落在计划书
  M2 的 64–66 题目标内）。
- **10 道共享锚题**：A1/A2/B1/B2/C1 各 2 道，Form A/B 的 id、题干、选项、
  答案、难度带、`b` 完全相同；服务端加载时做交叉校验，不一致直接 503。
- 阅读短文均为**自写文本**，不使用受版权保护的材料；`evidence` 字段是
  正确项证据句，仅供教研审校，不下发用户。
- 伪词（`quennivate` / `dravellate` 等）是编造词；`scripts/check_placement_bank.py`
  会检查它们不在仓库词表（`content/wordlist/frequency_bands.v1.json`）里，
  但这只是最低检查，不能替代词典人工审校。

## 题目契约

- `id`：一套题库内唯一；锚题在 A/B 两套中**有意复用同一个 id**。
  - v1：`v-001`…`v-030`、`v-031`…`v-034`（伪词）、`r-01`…`r-05`。
  - v2 非锚：`fa-v-001`…`fa-v-030` / `fb-v-001`…`fb-v-030`，
    `fa-p-01`…`fa-p-04` / `fb-p-01`…`fb-p-04`，`fa-r-01`…`fa-r-20` /
    `fb-r-01`…`fb-r-20`。
  - v2 锚题：`an-v-01`…`an-v-10`（A/B 相同）。
- `band`：`A1` / `A2` / `B1` / `B2` / `C1`（阅读 A2–C1；本轮不测 C2）。
- `options`：恰好 4 个互不重复的选项（词汇为中文释义，阅读为英文选项）。
- `answerIndex`：0–3；**伪词没有**（没有正确项）。
- `b`（v2 必填）：题级难度（logit）。本期一律等于题带中心
  A1 −2.0 / A2 −1.2 / B1 −0.4 / B2 +0.4 / C1 +1.2，`parameterStatus:
  uncalibrated`；改为 pilot 标定值时必须同时更新状态，不能只改数字。
- `anchor`（v2）：布尔；`true` 的题必须出现在 `_meta.anchorIds` 且 A/B 一致。
- `passageId` / `evidence`（v2 阅读）：4 篇短文 × 5 题；`evidence` 不下发。

## 抽题与评分（实现见 `backend/placement.py` / `assessment.py`）

- **v1（默认）**：每次 24 词汇（A1 5 / A2 5 / B1 5 / B2 5 / C1 4）+ 3 伪词
  + 5 阅读 = 32 题；`seed = placement.serve.v1:<sessionId>`，同一会话稳定。
- **v2**：同样 24 + 3 + 5 = 32 题，从 Form A/B 抽；**10 道锚题全部出现**，
  阅读 5 题覆盖 4 篇短文；`seed = placement.serve.v2:<sessionId>`。
- **开关**：`PLACEMENT_BANK_VERSION=v1`（默认）/ `v2`；只影响**新开始**的
  会话。会话 id 前缀 `p1-` / `p2a-` / `p2b-` 记录版本与卷面，升级前开始的
  旧会话仍能按 v1 提交，不会「换卷」。
- **计分**：难度带权重 A1=0.5 … C1=2.5，`score = Σ答对权重 / Σ全部权重`；
  伪词不计分，只统计过度声称。`chosenIndex=-1`（或 `null`）= 不认识/跳过。
- **v1 评分**：`rasch.eap.v1`，`b` 只用题带中心。
- **v2 评分**：`rasch.eap.v2`，题级 `b`（锚题共享）+ `form_offset`（pilot
  前固定 0）；θ/SE/95% CI/80% HPD/点带/±1 带口径与 v1 完全一致。**当前只能
  说「等值结构就位」，不能说「已等值」**：没有 pilot 的锚题漂移估计，form
  offset 还是占位 0。

## 质量校验

```bash
cd backend
venv/bin/python ../scripts/check_placement_bank.py
# 只校验不写：venv/bin/python ../scripts/check_placement_bank.py --check
```

输出 `docs/reports/placement-items-2026-11-17.json`，包含：

- 每套题数（64）、词汇槽（44 = 40 真词 + 4 伪词）、阅读（4 篇 × 5 题）、
  带分布、选项/答案合法性、锚题一致性；
- `pValues.status = "pending_pilot"`，**每个 item 的 `pValue` 都是 null**；
- 锚题参数与 `equating.status = "structure_ready_uncalibrated"`；
- 脚本退出码 0 = 通过，1 = 有 issue（不生成正式报告时也会打印）。

真实 p 值、题级 b 标定和两套等值都必须等 30–50 人 pilot 的真实作答；在
拿到数据前，任何页面/文档/客服话术都不得写「已校准」「准确率」「已等值」。

## 审校清单（接手教研请逐条过）

- [ ] 每个词的难度带是否符合中文学习者实际（不是只看词频表）。
- [ ] 4 个选项是否只有一个正确、干扰项是否有迷惑性但无争议。
- [ ] 中文释义是否自然、无错别字、无方言/歧义。
- [ ] 阅读题正确答案是否**只能**由原文证据推出，干扰项是否明确错误。
- [ ] 伪词是否确认未被主流词典与仓库词表收录；误收真实词立即替换并升版本。
- [ ] 10 道锚题在 A/B 是否仍同题同参数；改动锚题必须同步两套文件。
- [ ] 改完题把 `_meta.version` / `_meta.updated` 升一版，重跑质量脚本，并同步
      `specs/016-placement/spec.md` 的题库规模。
