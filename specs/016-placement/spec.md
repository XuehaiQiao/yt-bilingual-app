# 规格：能力定位测与能力画像（后端）

**状态：** 已实现（2026-11-15，M4 后端；前端 12 分钟流程/结果页下一轮）｜ **对应代码：** `backend/placement.py`、`backend/routes_placement.py`、`backend/migrations/versions/0009_placement.py`、`content/placement/`、`backend/tests/test_placement.py`

> **M1 修订（2026-11-17，已签收；实现见 [specs/025](../025-ability/spec.md)）**：
> 评分从 `heuristic.v1` 的手调加权阈值升级为 **1PL/Rasch + EAP**
> （`calibration_version='rasch.eap.v1'`）；只交付**词汇识别区间**。
> **阅读是有意的破坏性降级**：`POST /submit` 不再返回
> `breakdown.reading.band`，强弱项/建议不再含阅读维度；旧
> `GET /profile` 的 `reading_estimate` 置 `null` + `readingStatus:
> 'insufficient'`，并返回 `deprecated/replacedBy`。定位测 `answers[]`
> 新增可选 `elapsedMs`，落 `placement_answers.elapsed_ms`。本条修订与
> 契约 A1–A3、A6 一起构成发版闸门。

> 计划书 §13.2 M4 / §4.3 的第一块后端：新用户用 12 分钟完成一次定位测，
> 得到 **CEFR 区间 + 置信度 + 强弱项 + 1 条建议**，保存为能力画像；老用户可
> 重测。本规格只冻结**后端契约**：题库结构、抽题、评分、区间、伪词检测、
> 画像、幂等与错误语义。前端 `/features/assess/`、难度引擎（UTR）、CAT 离线
> 模拟与 200–240 题池在后续轮次实现。

---

## 目标

- **G1 12 分钟能测完**：一次会话 32 题（24 词汇 + 5 阅读 + 3 伪词混入），
  客户端计时上限 12 分钟（服务端记录用时，不强制中断）。
- **G2 只给区间**：输出 CEFR 点估计 ±1 带（A1/C1 处截断）+ 置信度，
  **不显示小数等级、不显示考试分数**。
- **G3 有强弱项与建议**：~~词汇识别 / 阅读理解两个维度分别估带~~
  **M1 修订**：只由词汇识别给带；阅读 5 题证据不足，不参与强弱项，
  `strengths/weaknesses/advice` 不再含阅读维度（下一版 20 题阅读小测）。
- **G4 能识破猜测**：10% 伪词（不存在的词，选项全是编造释义）混入词汇题；
  选任一选项 = 过度声称，压低置信度；选「不认识/跳过」= 诚实。
- **G5 保存画像**：`user_profiles` 每个归属键一行，保存区间、置信度、词汇量
  估计、阅读带、伪词可疑度、来源与更新时间。
- **G6 可重测**：已完成会话保留；`reset` 只中止未完成会话，历史与当前画像
  不删；再次 `start` 创建新会话。
- **G7 游客可测**：游客按 `guest:<sha256>` 归属，结果不跨设备/不跨登录身份。
- **G8 诚实**：完成过定位测的用户 < 100 人时 `preliminary: true`，文案明确
  「初步估计」；任何响应都带「这是定位估计，不是考试分数」。

## 非目标

- 不做前端 12 分钟流程、结果页、画像展示、倒计时与断点续答。
- 不做自适应/CAT：本轮是**固定 32 题 + 加权计分**的廉价近似；计划书要求
  的 CAT 停规则与离线模拟（1 人日）在 M4 后续轮次做。
- 不做 ECDICT 六列补全、lemma 化、UTR 难度引擎、内容推荐。
- 不做听力测题（12 分钟预算已满）、说/写评估（明确「未测」）。
- 不做题库 200–240 题平行卷（本轮 39 题草稿；教研审校后扩充）。
- 不做游客认领账号时把 `placement_sessions.user_id` 从 `guest:<sha256>` 迁到
  `users.id`（`guest_hash` 列已预留，账号生命周期后续小节处理）。
- 不承诺考试对标（雅思/托福分数）与「准确」；样本门槛与效度门槛见计划书
  §4.3。

---

## 数据模型（迁移 `0009_placement`）

三张表都不改旧表；运行时不建表，未迁移时四个端点返回 **503** 并提示
`alembic upgrade head`。会话与作答都以 `user_id` 作为**归属键**：登录用户 =
`users.id`，游客 = `guest:<sha256>`（`guest.guest_id()`），与 `watch_events`
同一套口径。

### `placement_sessions`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK NOT NULL | `uuid4().hex`（应用生成） |
| `user_id` | TEXT NOT NULL | 归属键（登录用户 id / `guest:<sha256>`） |
| `guest_hash` | TEXT NULL | 游客 sha256（登录用户 NULL），预留给认领迁移 |
| `status` | TEXT NOT NULL DEFAULT `in_progress` | `in_progress` / `submitted` / `abandoned`（CHECK） |
| `started_at` | INTEGER NOT NULL | 服务端毫秒 UTC |
| `submitted_at` | INTEGER NULL | 提交时刻 |
| `duration_ms` | INTEGER NULL | 提交时上报/回算的用时，CHECK 0–86400000 |
| `score` | REAL NULL | 0–100 加权得分（伪词不计分） |
| `cefr` | TEXT NULL | 区间标签，如 `A2–B2`（en dash） |
| `confidence` | REAL NULL | 0–1（CHECK） |
| `breakdown` | TEXT NULL | 完整结果 JSON（维度明细/强弱项/建议/样本口径） |

- `ix_placement_sessions_user_started(user_id, started_at)`：历史与最近会话查询。
- 部分唯一索引 `ux_placement_sessions_active(user_id) WHERE status='in_progress'`：
  同一归属最多一个未完成会话，保证「复用」在并发下成立；已提交/已作废历史可
  并存（允许重测）。

### `placement_answers`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 自增 |
| `session_id` | TEXT NOT NULL | → `placement_sessions.id`，ON DELETE CASCADE |
| `item_id` | TEXT NOT NULL | **题库银行 id**（`v-012` / `r-03`），不是对外的 `q-01` |
| `item_type` | TEXT NOT NULL | `vocab` / `reading` / `pseudo`（CHECK） |
| `chosen_index` | INTEGER NOT NULL | `-1` = 不认识/跳过，`0–3` = 选项（CHECK -1..3） |
| `correct` | INTEGER NOT NULL | 0/1（伪词恒 0；CHECK） |
| `difficulty_band` | TEXT NOT NULL | `A1`–`C1`（CHECK） |
| `answered_at` | INTEGER NOT NULL | 服务端毫秒 UTC |

- `UNIQUE(session_id, item_id)`：重复提交由应用层拦截（幂等），数据库兜底。
- 提交时一次写入整卷 32 行（跳过也落 `-1`），append-only，无更新/删除入口。

### `user_profiles`

| 列 | 类型 | 说明 |
|---|---|---|
| `user_id` | TEXT PK NOT NULL | 归属键 |
| `cefr` | TEXT NOT NULL | 区间标签，如 `A2–B2` |
| `level_band_low` / `level_band_high` | TEXT NOT NULL | 区间上下带（CEFR 集合，CHECK） |
| `vocab_estimate` | INTEGER NULL | 约词汇量（按 lemma 的粗略中值，UI 带「约」） |
| `reading_estimate` | TEXT NULL | 阅读带（A1–C1） |
| `confidence` | REAL NOT NULL | 0–1（CHECK） |
| `pseudo_word_suspicion` | REAL NOT NULL DEFAULT 0 | 0–1 伪词过度声称比例（CHECK） |
| `updated_at` | INTEGER NOT NULL | 服务端毫秒 UTC |
| `source` | TEXT NOT NULL DEFAULT `placement` | `placement` / `user_edit`（CHECK；本轮只写 placement） |

画像只保留**最新一次**定位测结果；历史结果仍在 `placement_sessions` +
`placement_answers` 里可复算。

---

## 题库（`content/placement/`）

只读静态 JSON，后端懒加载并做结构校验；文件缺失/损坏/未标草稿 → 503。

| 文件 | 内容 | 本轮规模 |
|---|---|---|
| `vocab.json` | 英文词 + 4 个中文释义 + `answerIndex` + 难度带 + 例句 | 30（A1 8 / A2 7 / B1 6 / B2 5 / C1 4） |
| `reading.json` | 50–90 词短文 + 1 题 4 选 1 + 难度带 + 证据句 | 5（A2 1 / B1 2 / B2 1 / C1 1） |
| `pseudo.json` | 编造词 + 4 个编造释义（无正确项） | 4（B1–C1） |

- 每题 `id` 全库唯一；`options` 恰好 4 个且不重复。
- `_meta.notice` 必须包含「待教研审校」，否则拒绝加载（内容闸门）。
- 伪词 id 延续词汇题序号（`v-031`…`v-034`），接口按词汇题外观混入，且对外
  `itemId` 是会话内编号（`q-01`…`q-32`），不暴露银行 id 与真假。

### 抽题

按 `seed = "placement.serve.v1:<sessionId>"` 确定性抽题：

1. 词汇按难度带分层抽 24：A1 5 / A2 5 / B1 5 / B2 5 / C1 4（题池不足时从剩余题补齐，仍为 24）；
2. 从伪词池抽 3；
3. 5 篇阅读全出；
4. 合并后打乱，对外编号 `q-01`…`q-32`。

同一 `sessionId` 在 `start` / `submit` 得到**同一份卷**，因此不需要把整卷落库；
题面只下发题干/选项/难度带，绝不下发 `answerIndex`。

---

## 端点契约

| 端点 | 身份 | 成功 | 失败 |
|---|---|---|---|
| `GET /api/placement/start` | 登录/游客 | `200 {sessionId,status:"in_progress",resumed,attempt,startedAt,durationLimitMs,itemCount,bankVersion,form,calibrationVersion,anchorCount,totals,instructions,items,preliminary,sampleSize,disclaimer}` | `403` 无身份；`503` 未迁移/题库损坏 |
| `POST /api/placement/submit` | 登录/游客 | `200 {sessionId,status:"submitted",reused,score,cefr:{point,low,high,label},confidence,confidenceLabel,confidenceLabelZh,pseudoWordSuspicion,preliminary,sampleSize,durationMs,bankVersion,form,anchorCount,calibration,breakdown,profile,disclaimer}` | `400` 参数非法；`403`；`404` 会话不存在/别人的；`409` 会话已作废/并发冲突；`422` 请求体结构错；`503` |
| `GET /api/placement/profile` | 登录/游客 | `200 {profile: {...} \| null,preliminary,sampleSize,disclaimer}` | `403`；`503` |
| `POST /api/placement/reset` | 登录/游客 | `200 {reset:true,abandonedSessions,profileKept:true,message}` | `403`；`503` |

### `start`

- 同一 `user_id` 有 `in_progress` 会话 → 复用，`resumed: true`，`sessionId` 与
  题面不变；否则新建（部分唯一索引兜底并发）。
- `totals = {"vocab":27,"reading":5,"all":32}`：27 = 24 真词 + 3 伪词（伪词不
  单独暴露数量/类型）。
- 每题 `{itemId,type:"vocab"|"reading",band,prompt,options[4],skippable:true}`
  阅读题多 `passage`；`skippable` 提示客户端提供「不认识」入口。
- `preliminary` / `sampleSize` 按「完成过定位测的不同用户数」计算。

### `submit`

请求：

```json
{
  "sessionId": "…",
  "answers": [{"itemId": "q-01", "chosenIndex": 2}],
  "durationMs": 600000
}
```

- `chosenIndex` 可取 `-1`（或 `null`）= 不认识/跳过；缺省视为 `-1`。
- `answers` 可少于 32 条（跳过的不必提交）；多于 32 条、未知/重复 `itemId`、
  `chosenIndex` 越界都返回 400。
- `durationMs` 缺省用 `now - started_at`；负数/超 24 小时返回 400。
- 评分、写 32 行作答、更新会话、upsert 画像在一个事务里完成。
- **幂等**：会话已是 `submitted` 时直接返回首次结果（`reused:true`），不再写
  答案/画像；同会话重复提交即使答案不同也返回首次结果。
- 并发重复提交由 `UNIQUE(session_id,item_id)` 兜底：冲突时回滚并返回首次结果。

### `profile`

- 无画像：`{"profile": null, "preliminary": true, "sampleSize": N, "disclaimer": "…"}`。
- 有画像：`profile` 含 `cefr`、`levelBandLow/High`、`vocabEstimate`、
  `readingEstimate`、`confidence`、`confidenceLabel(Zh)`、
  `pseudoWordSuspicion`、`updatedAt`、`source`，并从最近一次已提交会话补
  `strengths` / `weaknesses` / `advice` / `measuredDomains` / `notMeasured`。
- `preliminary` 与 `sampleSize` 每次按当前全站样本重新计算。

### `reset`

- 只把当前 `in_progress` 会话改为 `abandoned`，返回中止条数；
- 已提交历史与 `user_profiles` **保留**；下一次 `start` 创建新会话。
- 没有未完成会话时返回 `abandonedSessions: 0`（幂等）。

---

## 评分规则

### 加权正确率

难度带权重：`A1=0.5 / A2=1.0 / B1=1.5 / B2=2.0 / C1=2.5`。

```
weightedScore = Σ(答对题的权重) / Σ(全部作答题目的权重)
score(0–100)  = round(weightedScore × 100, 1)
```

- 词汇、阅读分别算，伪词**不参与**分子/分母。
- 未作答/跳过 = 错（真词）；伪词跳过 = 诚实。
- 分带明细 `breakdown.vocab.bands` / `reading.bands` 供审校与以后 CAT 校准。

### 点估计与区间

加权正确率 → 点估计带（启发式 `heuristic.v1`，见 `placement.py` 顶部常量）：

| 维度 | A2 | B1 | B2 | C1 |
|---|---|---|---|---|
| 总体（29 真词） | ≥0.27 | ≥0.44 | ≥0.60 | ≥0.78 |
| 词汇（24 题） | ≥0.27 | ≥0.43 | ≥0.60 | ≥0.79 |
| 阅读（5 题） | ≥0.26 | ≥0.50 | ≥0.72 | ≥0.90 |

- 区间 = 点估计 **±1 带**（`low = point-1`，`high = point+1`，A1/C1 处截断）：
  A1→`A1–A2`、A2→`A1–B1`、B1→`A2–B2`、B2→`B1–C1`、C1→`B2–C1`。
- 这些阈值是**待校准的启发式**，不是 IRT/CAT 标定；CAT 模拟与教研审校后再调，
  改动必须同步本表、`placement.py` 常量与测试。
- `vocab_estimate` 取点带词汇量中值（A1 1500 / A2 3000 / B1 5000 / B2 8000 /
  C1 12000），只作粗略参考。

### 置信度

```
completion   = 已作答真词数 / 29
durationFactor = <1min 0.40；<3min 0.75；≤13min 1.00；≤20min 0.75；否则 0.50
base         = 0.30 + 0.40 × completion + 0.15 × durationFactor
suspicion    = 伪词选任一选项数 / 伪词总数
penalty      = 0.45 × max(0, suspicion - 1/3) / (2/3)
confidence   = clamp(0.10, 0.85, base - penalty)
```

- `suspicion ≤ 1/3` 不罚；全部伪词都声称认识时罚 0.45。
- 标签：高 ≥0.70 / 中 ≥0.45 / 低 <0.45（同时返回英文 `confidenceLabel` 与中文
  `confidenceLabelZh`）。
- 置信度**不是**统计置信区间，只是「这次结果有多可信」的操作性提示。

### 强弱项与建议

- 词汇带 / 阅读带高于或等于点估计 → `strengths`（如 `词汇识别（B1）`）；
  低于 → `weaknesses`。两个都低于点估计时，把相对较高的维度标为
  「相对较强」并从 `weaknesses` 移除，避免同一维度同时出现在两边。
- `advice` 恰好 1 条，规则优先级：
  1. 伪词可疑度 ≥0.5 → 先提醒「不确定就选不认识、可重测」；
  2. 阅读偏弱 → 每天精读一段目标带短文；
  3. 词汇偏弱 → 每天 20 张生词卡、目标带高频词；
  4. 点估计 ≤A2 → 慢速短视频起步；≤B2 → 真实视频精看；C1 → 无字幕/纯音频 +
     复述。
- `measuredDomains = ["vocab","reading"]`；`notMeasured =
  ["listening","speaking","writing"]`（听力是行为弱测，不在这 12 分钟里；说/写
  明确未测，不用 LLM 猜）。

### 样本口径

- `sampleSize = COUNT(DISTINCT user_id) WHERE status='submitted'`（含游客）。
- `sampleSize < 100` → `preliminary: true`，响应文案标注「初步估计」；
  达到 100 个不同用户后自动翻为 `false`（不做缓存，每次实时算）。
- 对外不承诺「准确」；效度门槛（n≥100 + α≥0.85 + 4 周重测 r≥0.80 + 95% CI）
  按计划书 §4.3 执行，未达标前只标初步。

---

## 测试与验收

`backend/tests/test_placement.py` 19 个离线用例 + `test_migrations.py` 的
0009 表/索引/约束/回滚断言：

- [x] start：32 题 = 24 真词 + 3 伪词 + 5 阅读，不含 `answerIndex`，伪词按
      vocab 外观混入；难度带齐全；同 sessionId 卷面稳定。
- [x] 复用：同用户未完成会话 `resumed:true`；reset 后新会话；已完成历史保留。
- [x] submit：全对 → 100 分 / C1 / 区间 B2–C1 / 置信度 0.85 / 画像落库；
      部分答对 → 低带；缺失 durationMs 用服务端回算。
- [x] 伪词：全部声称 → suspicion=1、置信度 0.40、得分不变；`null`/`-1` →
      suspicion=0；重测后画像更新。
- [x] 幂等：重复提交 `reused:true`，答案行/画像/会话行数不变。
- [x] profile：无画像为 null；提交后可读；reset 后画像保留。
- [x] 游客：可测、归属 `guest:<sha256>`、换 Cookie 看不到、登录用户看不到。
- [x] 隔离：B 提交 A 的会话 404；A 会话仍 in_progress；画像互不可见。
- [x] 校验：未知/重复 itemId、chosenIndex 越界、duration 负数/超 24h、空
      sessionId → 400；未知会话 → 404；已作废 → 409；缺 sessionId → 422。
- [x] 迁移闸门：未迁移四端点 503（提示 0009）；题库损坏 503 且不建会话。
- [x] 样本：99 个已提交用户 → preliminary=true；第 100 个 → false。
- [x] 迁移：head 建三表/索引/部分唯一/FK/CHECK；downgrade 0008 只删三表可再升级。

全量后端测试：**351 绿**（本任务新增 20；此前 331）。

## 已知限制 / 下一步

1. **题库只有 39 题**：计划书首发要求 200–240 题 / 8–10 套平行卷；本轮是草稿
   池，同一用户重测可能碰到相同题（同 sessionId 才固定，换 sessionId 重新抽）。
2. **评分是启发式**：阈值未做 CAT 离线模拟与 10 组 × 200 名考生验证；
   `heuristic.v1` 只是可解释的初版，不是效度证据。
3. **题型单一**：只有词汇识别 + 短阅读；长阅读、听力、说/写未做。
4. **前端未做**：12 分钟倒计时、对「不认识」的显式按钮、结果页/画像展示、
   未完成会话的断点续答提示都在下一轮；后端已用 `skippable`/`preliminary`
   字段预留。
5. **游客认领**：登录后游客定位结果不会自动迁到账号（`guest_hash` 已预留）。
6. **反作弊有限**：只做伪词过度声称检测与用时合理性折减，不做切屏/复制检测。


---

## M1 修订记录（2026-11-17，阅读降级签收）

本文件前半部分描述 M4 的**历史实现**（`heuristic.v1` 加权评分）；M1 之后以
[specs/025](../025-ability/spec.md) 与下列修订为准。

### 变更清单

| # | 变更 | 旧行为 | M1 行为 | 验收 |
|---|---|---|---|---|
| 1 | 估计器 | 加权正确率 → 手调阈值 | 1PL/Rasch + EAP（先验 N(0,1.2)、网格 −4…+4、c=0.15） | 估计器 6 测；全对/全错不发散 |
| 2 | CEFR 来源 | `overall`（词汇+阅读加权） | **仅词汇识别**；输出带限制 A1–C1 | `submit.cefr` 与词汇带一致 |
| 3 | 阅读带 | `breakdown.reading.band` | 字段不存在；`status='insufficient'`、`items=5` | A1 |
| 4 | 强弱项/建议 | 含 reading 维度 | 只由词汇生成；阅读只提「下一版 20 题小测」 | A2 |
| 5 | 旧 profile | `readingEstimate` 有值 + `confidence` | `readingEstimate=null`、`readingStatus='insufficient'`、`cefr` 取词汇带、`deprecated/replacedBy` | A3/A6 |
| 6 | 用时 | 只有会话总时长 | 每题可选 `elapsedMs` → `placement_answers.elapsed_ms`（旧行 NULL） | 迁移 8；隐私 2 |
| 7 | 新表 | 只有 `user_profiles` 快照 | `user_skill_profiles` + `skill_evidence` + `assessment_sessions`；`user_profiles` 保留为 legacy | 迁移 0014/0015 |
| 8 | 状态 | `confidence` 混精度与可信度 | vocabulary=`uncalibrated`；reading=`insufficient`；写作=`self_report`（`cefr=null`）；`measured` 不可达 | A4/A5/A8 |

### 签收

- **产品签收**：接受上述第 3/5 项的破坏性降级——用户不再看到「阅读 B1」
  这类无证据的带；这是 M1 的预期行为，不是回归。
- **旧前端兼容**：`/api/placement/*` 字段名不变；`PlacementScreen.tsx`
  对 `breakdown.reading.band` 的读取会得到 `undefined`，需在后续前端轮次
  改为灰卡「阅读：证据不足（5 题）」。本修订只负责后端契约。
- **回滚**：`alembic downgrade 0013_user_profile` 删除 0014/0015 新表与
  `elapsed_ms`，旧 `user_profiles` 数据保留；旧端点行为回到 M4。
- **测试**：`tests/test_placement.py` 21、`tests/test_ability_contract.py` 8、
  `tests/test_ability_migrations.py` 12，以及全量 608 绿。

---

## M2 修订记录（2026-11-17，题池扩建 + 两套等值结构）

> 状态：**已实现（草稿题库，未经 pilot 校准）**。本条只覆盖 M2 #2/#3：
> 两套 64 题、锚题等值结构、`rasch.eap.v2`。M2 #7 行为埋点、#4 的 60 条
> 锚集校准与 30–50 人 pilot 仍未做；在 pilot 完成前，不得对外宣称「已等值」
> 「已校准」「有效度」或任何准确率数字。

### 1. 题库（`content/placement/forms/`）

| 文件 | Form A | Form B | 说明 |
|---|---:|---:|---|
| `vocab.json` | 40 | 40 | 40 真词（含 10 锚题）；A1–C1 每带 8（2 锚 + 6 非锚） |
| `pseudo.json` | 4 | 4 | 编造词；无 `answerIndex` |
| `reading.json` | 20 | 20 | 4 篇自写短文 × 5 题；A2/B1/B2/C1 各 1 篇 |
| **合计** | **64** | **64** | 44 词汇槽（40 真词 + 4 伪词）+ 20 阅读 |

- **10 道共享锚题**（`an-v-01`…`an-v-10`）：A1–C1 每带 2 道；Form A/B 的
  id、题干、选项、答案、难度带与 `b` 必须完全相同。`placement.py` 加载时会
  对 A/B 做交叉校验，不一致 → `PlacementUnavailable` → 503。
- 每套 `_meta` 带 `form`、`anchorIds`、`parameterVersion`、
  `parameterStatus="uncalibrated"`；`b` 为题带中心占位（不是 IRT 标定值）。
- 阅读为自写文本，不使用受版权保护的材料；`evidence` 仅供教研审校，不下发。
- 伪词检查：质量脚本确认其不在 `content/wordlist/frequency_bands.v1.json`
  的 entries/forms 中；这只是一项最低检查，仍需词典人工复核。

### 2. 题库开关与旧流程回退

- `config.PLACEMENT_BANK_VERSION`（环境变量同名）：`v1`（默认）/ `v2`
  （别名 `legacy` / `1` / `forms` / `2`）。非法值 → 503，不静默回退。
- **只影响新开始的会话**：`start` 新会话 id 带前缀 `p1-` / `p2a-` / `p2b-`，
  `submit` 用前缀重算同一份卷。升级前开始、无前缀的旧会话按 v1 处理；
  `v1 → v2` 或 `v2 → v1` 切换后，进行中的会话仍按原版本提交。
- 未启用 v2（默认）时，旧 39 题流程、24+3+5 抽题、v1 评分、既有测试全部
  不变；`start` 响应额外给 `bankVersion/form/anchorCount/calibrationVersion`。

### 3. 抽题（仍为 12 分钟 32 题）

- v2：24 词汇 = 10 锚题 + 14 非锚题（A1 5 / A2 5 / B1 5 / B2 5 / C1 4）；
  3 伪词；5 阅读（4 篇短文全部覆盖，其中 1 篇出 2 题）。
- 同一 `sessionId` 确定性；`start/submit` 不落整卷，仍只存答案与结果。
- 对外 `itemId` 仍是会话内编号 `q-01`…`q-32`，不暴露银行 id/真假/锚题。

### 4. `rasch.eap.v2`

- 似然：`p = c + (1−c)·σ(θ − b_j − form_offset)`，`c=0.15`；
  `b_j` 优先题级 `b`，省略时回退题带中心；锚题在 A/B 共享同一个 `b_j`。
- 先验/网格/区间与 v1 **完全相同**（N(0,1.2)、−4…+4 step 0.05、EAP、
  95% CI、80% HPD、点带 ±1 带），因此 v1/v2 的 θ 在同一把尺子上。
- `form_offset`：pilot 前固定 `0.0`；正偏移 = 该卷更难（与 `b_j` 同向）。
  等值状态在响应与报告中固定标 `uncalibrated` / `structure_ready_uncalibrated`。
- v1 兼容：`assessment.estimate(...)` 与 `CALIBRATION_VERSION='rasch.eap.v1'`
  不变；旧题库继续走 v1。全对/全错在 v2 同样不发散。
- `submit` 的 `calibration` 对象额外含 `version/calibrationVersion/form/
  anchorCount/scale`；`breakdown.vocab` 含 `form/anchorCount/scale`；
  `user_skill_profiles.calibration_version` 记录本次实际估计器版本（v1 或 v2）。

### 5. 质量门与报告

- 脚本：`scripts/check_placement_bank.py`（可 `--check` 只校验）。
- 报告：`docs/reports/placement-items-2026-11-17.json`。
- 校验内容：每套 64 题、44 词汇槽、4 篇 × 5 题、选项/答案合法、A1–C1 覆盖、
  10 锚题跨套同题同参数、伪词未入词表、样卷 24/3/5 且含 10 锚题。
- **p 值全部 `null`**，`pValues.status="pending_pilot"`；不生成任何伪造
  统计量。题级 `b` 若是编辑占位，报告标 `editorial_uncalibrated`。

### 6. 测试与验收

- 新增 `backend/tests/test_placement_forms.py`（20 例）与
  `backend/tests/test_assessment.py` 的 6 个 v2 用例；覆盖题库结构、锚题闸门、
  v2 抽题/评分/同一 θ 尺度、开关与双向回退、503、幂等、质量脚本与报告。
- 本任务新增 **26 例**；全量后端 **743 绿**（基线 688 + 本任务 26 + 并行的
  M2 行为埋点 29；当前 head `0017_behavior_events`）。`py_compile` 绿。
- 临时 8001 冒烟：`PLACEMENT_BANK_VERSION=v2` 起服务 → start 返回
  `bankVersion=placement.bank.v2` + form A/B + 10 锚题 → submit 返回
  `calibrationVersion=rasch.eap.v2`；切回 v1 起服务 → 旧 39 题流程不变。

### 7. 已知限制（必须与结论一起出现）

1. **题库是草稿**：未经 30–50 人 pilot；p 值、题级 b、form offset 均未校准。
2. **结构等值 ≠ 统计等值**：当前只有「共享锚题 + 共享 b + offset=0」的结构；
   没有锚题漂移/ICC/平行卷同档率证据，不能对外说「已等值」。
3. **阅读仍证据不足**：5 题只做 `insufficient`，不进 θ；M3 的 20 题阅读卷
   仍未做。
4. **44 词汇槽口径**：40 真词 + 4 伪词 = 44；若改为 44 真词，总题数会变成
   68，超出 M2 的 64–66 目标，故本期不这么做。
5. **行为埋点不在本条**：M2 #7（lookup/replay/rate/visibility）与 M2 #4
   （60 条锚集）仍是后续工作。
