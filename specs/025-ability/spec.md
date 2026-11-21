# 规格：CEFR 能力标定 M1（后端）

**状态：** 已实现（2026-11-17，M1 后端；前端能力档案页后续轮次）｜ **对应代码：** `backend/assessment.py`、`backend/ability.py`、`backend/routes_ability.py`、`backend/placement.py`、`backend/routes_placement.py`、`backend/migrations/versions/0014_ability.py`、`0015_assessment_sessions.py`、`content/ability/`、`scripts/cat_sim.py`｜ **计划书：** `docs/项目计划-CEFR能力标定.md` §5（测量）/ §7（数据与 API）/ §10.1（M1）

> M1 只交付**词汇识别区间**：阅读证据不足、听说写未测。本规格冻结
> 测量口径、证据状态机、数据表、三个新端点与旧端点 shim。目标不是把
> 12 分钟测成「四项评级」，而是把结果从「手调加权阈值」升级为
> 「Rasch/EAP 区间估计 + 可解释的证据状态」。

> **v1.1 D8-2 增补（2026-11-21，已实现）**：旧词汇量回填的种子画像不再展示
> CEFR 区间，只保留点估计；迁移 `0026_seed_band_fix`。详见「种子画像不出带」。
> 对应代码：`backend/ability.py`、
> `backend/migrations/versions/0026_seed_band_fix.py`、`backend/recommend.py`。

---

## 目标

- **G1 估计器可复现**：给定同一份作答，θ/SE/后验区间/CEFR 带/词汇量区间
  必须确定性地复现；`calibration_version='rasch.eap.v1'`。
- **G2 全对/全错不发散**：EAP 向先验收缩，24 题全对/全错仍给有限 θ、SE 与
  区间；点带限制在 A1–C1，不因全对报 C2。
- **G3 证据状态诚实**：词汇 = `uncalibrated`；阅读 = `insufficient`；
  听/说/语法 = `not_measured`；写作 = `self_report` 且 `cefr=null`。
  `measured` 在 M1 代码里不可达。
- **G4 区间优先**：API 优先返回 `low/high/label` 与 `estimate{low,high,unit}`；
  不输出「已标定」「准确」「总分」等话术。
- **G5 旧端点不崩**：`GET /api/placement/profile` 字段名保留；
  `reading_estimate=null` + `readingStatus='insufficient'`；`cefr` 取词汇带；
  返回 `deprecated/replacedBy`。
- **G6 自评只作先验**：20 条 0–3 自评，`clientRequestId` 幂等，10 次/天；
  不改词汇带，只在写作 `selfReport.band` 展示。
- **G7 公开 can-do**：A1–C1 × 4 技能 ≥40 条通用描述（zh + vi），带 `basis`，
  不复制 CoE 原文。
- **G8 可回归**：估计器 6、聚合 12、API 15、契约 A1–A8、迁移 12、隐私 2；
  全量后端测试保持绿。

## 非目标

- 不做内容难度表 / `content_difficulty` / UTR 匹配（M2）。
- 不做逐题 b 标定、平行卷、CAT/MST（M2/M3）。
- 不做阅读 20 题卷、听力/语法小测、写作/口语任务（M3）。
- 不做行为证据融合进 band（M1 只允许写入 evidence，不参与合成）。
- 不改前端、不改 `.env`、不提交 `history/`。
- 不做「官方 CEFR 认证」「相当于雅思」类表述。

---

## 测量口径（`backend/assessment.py`）

```
p(答对 | θ, b) = c + (1 − c) · σ(θ − b)        c = 0.15
b = 题带中心：A1 −2.0 / A2 −1.2 / B1 −0.4 / B2 +0.4 / C1 +1.2 / C2 +2.0
先验 = N(0, 1.2²)；网格 −4…+4、步长 0.05（161 点）
θ̂ = EAP 后验均值；SE = 后验 SD；95% CI = θ̂ ± 1.96·SE
80% HPD 区间（最小宽度 1 带）供内部/详情使用
点带 = 输出带内后验质量最大者；展示区间 = 点带 ±1 带（A1/C1 截断）
词汇量 E[known] = Σ_band N_band · σ(θ − b_band)
```

- **固定 24 题卷的输出带限制为 A1–C1**：题库没有 C2 题，全对不能报 C2。
- **词汇量**：锚点取对外区间中点（A1 1250 / A2 2500 / B1 4250 / B2 7000 /
  C1 11000 / C2 18000，lemma），区间再收敛到 ±2,000–2,500、上下界取整到百位。
- **精度 vs 可信度**（不再混叫 confidence）：
  - `precision{label,se}`：SE≤0.45 高 / ≤0.60 中 / 其余低；
  - `validity{label,flags}`：伪词过度声称、用时过短/过长、完成度低、秒答；
  - 旧 `confidence` = min(precision, validity)，标 `confidenceDeprecated`。
- **空响应**（`n=0`）只用于调用方判断「无证据」，API 不得展示成测量结果；
  无证据时词汇状态为 `not_measured`。

## 数据模型

### 迁移 `0014_ability`

`user_skill_profiles`（PK `user_id, skill`，索引 `(user_id, updated_at)`）：

| 列 | 约束 |
|---|---|
| `skill` | CHECK `vocabulary/grammar/listening/reading/speaking/writing` |
| `cefr_point/low/high` | 可空，CHECK A1–C2；`low <= high` |
| `confidence` | 0–1 |
| `status` | CHECK `uncalibrated/measured/estimated/self_report`；M1 代码断言 measured 不可达 |
| `method` | CHECK `placement/test/behavior/self_report/writing_task/speaking_task/composite` |
| `evidence_count` / `effective_n` | 原始条数 / 加权后条数 |
| `last_evidence_at` | 可空，毫秒 UTC；90 天无新证据 → `stale:true` |
| `details` | JSON：precision/validity/estimate/theta/can-do/selfReport/conflict |
| `calibration_version` | NOT NULL（M1 = `rasch.eap.v1`） |
| `schema_version` | NOT NULL DEFAULT `ability.v1` |
| `updated_at` | NOT NULL |

额外 CHECK：`self_report` 行的 `cefr_point/low/high` 必须全为 NULL（K20）。
**不建 `not_measured` 行**：API 对缺失技能合成状态。

`skill_evidence`（append-only）：

- `UNIQUE(user_id, evidence_type, source_key)`；索引 `(user_id, skill, observed_at)`；
- 字段：`source_ref/band/outcome/weight/confidence/observed_at/payload/created_at`；
- payload 只存 `elapsedMs` 等小字段，**不存题干/选项/原文/PII**；
- 账号删除走 `ability.purge_user()`（当前无自助注销端点，保留给删除流程/测试）。

`placement_answers.elapsed_ms INTEGER NULL`：单题用时；旧行 NULL，缺省时该题
validity 记「用时未知」而不惩罚。

**seed**：旧 `user_profiles.vocab_estimate` → vocabulary 行，
`status='uncalibrated'`、confidence 沿用但 cap 0.85；映射
<2,250 A1 / <4,000 A2 / <6,500 B1 / <10,000 B2 / 其余 C1；NULL 只建词汇空行；
`reading_estimate` **不建 reading 行**。

### 迁移 `0015_assessment_sessions`

- `kind` CHECK `placement/self_assess/listening_check/writing_sample/speaking_sample/quick_check`；
- `status` CHECK `in_progress/submitted/abandoned`；
- `client_request_id` + 唯一索引 `(user_id, client_request_id)`（幂等）；
- 部分唯一索引 `(user_id, kind) WHERE status='in_progress'`；
- `result` JSON 摘要（不含大段原文）；`schema_version` 默认 `ability.v1`。

## API

### `GET /api/ability/profile`（登录/游客）

响应要点（完整形状见计划书 §7.4）：

- `schemaVersion` / `calibrationVersion` / `primary='vocabulary'`；
- `vocabulary`：
  - 有证据：`status='uncalibrated'`、`cefr/low/high/label`、`method`、`bandSource`、
    `evidenceCount`、`effectiveN`、`precision`、`validity`、`evidenceStrength`、
    `confidence`（deprecated）、`lastEvidenceAt`、`stale`、`estimate`、`note`；
  - 无证据：`status='not_measured'`、`cefr=null`、`estimate=null`；
- `composite{derivedFrom:['vocabulary']|[], cefr:null, label, status, note}`；
- `skills.reading = {status:'insufficient', cefr:null, low:null, high:null,
  items, method:'reading.5item.v1', note}`；
- `skills.listening/speaking = {status:'not_measured', cefr:null, note}`；
- `skills.writing = {status:'self_report', cefr:null, low:null, high:null,
  selfReport:{band,items,caveat}, note}`；
- `grammar = {status:'not_measured', band:null, pointsTotal:80}`；
- `inputOutputGap{available:false,...}`；`canDo{level,bySkill}`；`conflicts`；
- `preliminary` / `sampleSize`（与定位测同口径：`<100` → true）；
- `disclaimer`。
- **不存在 `overall`**；任何技能状态都不为 `measured`。
- 缓存：`private, max-age=60`。

### `POST /api/ability/self-assess`（登录/游客）

请求：`{clientRequestId, answers:[{itemId, rating 0–3（-1=跳过）}], durationMs, lang?}`。

- 12–20 条；未知/重复 itemId、rating 越界、duration <30s 或 >30min → 400；
- 幂等：同 `clientRequestId` 重复只返回首次结果（`reused:true`, `evidenceAdded:0`）；
- 限速：10 次/天（进程内滑动 24h，超限 429 + `Retry-After`）；
- 写 `assessment_sessions` + 每技能一条 `skill_evidence(self_assess)`；
- writing 行 `status='self_report'`、`cefr` 三列 NULL、confidence ≤0.35；
- 响应：`{sessionId,status,reused,evidenceAdded,profile,disclaimer}`。

### `GET /api/ability/can-do?level=B1&skill=reading&lang=zh-CN`（公开）

- `level` A1–C1；`skill` listening/speaking/reading/writing；`lang` zh-CN/vi-VN；
- 返回 `{schemaVersion,version,level,skill,lang,basis,note,items:[{id,level,
  skill,statement,observable,basis}]}`；
- 内容缺失/损坏 → 503；未知级别/技能/语言 → 400；
- 公开只读，不签发游客 Cookie；缓存 `public, max-age=3600`。

### 旧端点 shim

`GET /api/placement/profile`：

- 字段名与结构保留；`cefr` / `levelBandLow/High` / `vocabEstimate` 来自
  vocabulary 行（新表缺失时回退旧 `user_profiles`）；
- `readingEstimate = null` + `readingStatus='insufficient'`；
- `confidence = min(precision, validity)`；
- 返回 `deprecated:true` + `replacedBy:'/api/ability/profile'`。

`POST /api/placement/submit`：

- `breakdown.reading` 只保留原始统计 + `status/items/method/note`，**无 band**；
- `strengths/weaknesses/advice` 不再含阅读维度；
- `cefr` 由词汇 Rasch 估计给出；
- `answers[].elapsedMs` 落 `placement_answers.elapsed_ms`；
- 重复提交返回首次结果，且旧版存储结果在响应层会被清洗（阅读带移除）。

## 种子画像不出带（v1.1 D8-2，2026-11-21）

**问题**：迁移 `0014_ability` 把旧 `user_profiles.vocab_estimate` 映射成词汇
区间。C1 点会算出 `low=B2`、`high=C2`（上界超出题库与展示范围），而推荐侧
`normalize_band` 只认 A1–C1，整条链路因此拿不到合法带、回退默认 `A2–B1`。

**决策**：种子行只保留点估计（`cefr_point`），**不展示区间**；用户完成一次
12 分钟定位测后，再由真实题目证据给出区间。

- **迁移 `0026_seed_band_fix`**：对 `details` 含 `"legacy_seed"` 的行清空
  `cefr_low` / `cefr_high`，不动 `cefr_point` 与 `details`；历史迁移 0014
  不回改。`downgrade` 不可逆（被删的是错误的 C2 上界，没有可信旧值可写回）。
- **读取侧兜底**：`ability._display_band` 对 `details.source='legacy_seed'` 的
  行返回 `(None, None)`；即使库未跑 0026，能力档案也不会再展示假区间。
- **`GET /api/ability/profile`**：种子行的 `vocabulary.low/high/label` 为
  `null`；`cefr` 仍返回点带（如 `C1`）；`bandSource='legacy_seed'`；`note`
  改为「旧版词汇量回填：只有词汇量点估计，没有题目级证据；完成一次 12 分钟
  定位测可获得词汇区间。」；`estimate`（点估计与词汇量区间）保留。真实证据行
  的 `bandSource='evidence'`，行为不变。
- **旧端点 shim `GET /api/placement/profile`**：种子行的 `cefr` /
  `levelBandLow/High` 为 `null`，`vocabEstimate` 保留。
- **推荐联动**：种子行无带时用点估计当单档带，规则见
  [specs/026](../026-content-difficulty/spec.md)「推荐读带」。

## 内容

- `content/ability/can_do.json`：5 级 × 4 技能 × 2 条 = 40 条，zh + vi，
  含 `statement` / `observable` / `basis ∈ {cefr-aligned, product-operational}`；
  自写改写，不复制 CoE 原文。
- `content/ability/self_assess.json`：4 技能 × A1–C1 = 20 条，zh + vi，
  0–3 量表 + 跳过。
- 禁用词（用户可见文案）：已测量 / 个性化 / 准确率 / ±1 带 9x% / 相当于雅思 /
  B1.x。

## 验收

- `cd backend && venv/bin/python -m py_compile *.py` 通过；
- `pytest` 全量：608 绿（新增 55：估计器 6 / 聚合 14（含隐私 2）/
  API 15 / 契约 8 / 迁移 12）；
- 8001 临时库实测：旧 shim 无阅读带、`/api/ability/profile` 状态正确、
  self-assess 幂等、can-do 公开 200；
- 契约 A1–A8 全绿（见 `tests/test_ability_contract.py`）；
- （v1.1 D8-2）迁移 0026 清空种子行区间；`/api/ability/profile` 的
  `low/high/label=null` 且 `bandSource='legacy_seed'`；旧 shim 不再输出种子带；
- （v1.1 D8-2）推荐在种子行无带时使用点估计单档带（`test_recommend.py`），
  不再整条回退默认 `A2–B1`；
- `scripts/cat_sim.py` 固定参数产出三列表，仅作设计检查，不对外引用百分比。

## 已知限制

1. 阅读只有 5 题：M1–M2 固定 `insufficient`，M3 才有 20 题独立卷。
2. 题带中心是编辑值，不是题目拟合结果；M2 拿到 n≥300 后才估 5 个 band offset。
3. 行为/quiz/review 证据 M1 只允许写 `skill_evidence`，不合成 band。
4. 自评只是先验；写作 band 只显示在 `selfReport`，不进入任何合成。
5. `scripts/cat_sim.py` 是模型自洽性检查，不是效度/准确率证据。
