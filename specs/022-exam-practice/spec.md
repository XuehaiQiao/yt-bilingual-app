# 规格：考试练习（V2，后端 MVP）

**状态：** 已实现（2026-11-15，后端；前端练习页/结果页下一轮）｜
**对应代码：** `backend/exam.py`、`backend/routes_exam.py`、
`backend/migrations/versions/0012_exam.py`、`content/exam/cet4.json`、
`backend/tests/test_exam.py`。

> 计划书 §5.2 #11 / §13.5 V2 的第一块后端。用户选一套「CET-4 风格练习」
> 做 10 道自编题（词汇/语法/阅读），提交后看逐题对错与解析；历史只显示
> 日期/题型/正确数/总数。**不报分、不预测成绩、不用真题、不做效果承诺**；
> 命名统一「考试练习」，不叫「模考」。本规格只冻结**后端契约**：题库结构、
> 抽题、提交、评分、历史、幂等与错误语义。前端、计时 UI、分项诊断与
> 选词填空/段落匹配/听力填空等其余 CET 题型不在本轮。

---

## 目标

- **G1 能选题型开始练习**：`GET /api/exam/types` 返回可用题型（当前只有
  `cet4`，label「CET-4 风格练习」，题库 `itemCount=30`，每次练习 10 题）。
- **G2 只做题型练习**：从静态、自编的 30 道题库里抽 10 道（词汇 5 + 语法 2 +
  阅读 3）；卷面**不含答案与解析**；产品命名统一「考试练习」，不使用「模拟考试」
  等替代表述。
- **G3 提交后能看对错与解析**：逐题返回用户选择、正确答案、对错、解析；
  未作答的题标 `answered=false` / `chosenIndex=null`；只给 `correct` 与
  `total`，不换算成绩、等级或通过比例。
- **G4 会话可复用**：同一用户存在未提交会话时，`start` 复用同一 sessionId
  与同一卷面（`resumed=true`）；同一用户最多一个未提交会话由部分唯一索引
  兜底。
- **G5 提交幂等**：同一 sessionId 重复提交返回首次结果（`reused=true`），
  不重复写答案、不覆盖首次用时、不重复发 `exam_submit` 事件。
- **G6 历史可看**：`GET /api/exam/history?limit=20` 只列已提交练习，
  字段为日期/题型/正确数/总数/已答数/用时，不出现任何成绩字段。
- **G7 能接周报与画像**：新建会话写 `learning_events(exam_start)`，首次提交
  写 `learning_events(exam_submit)`；本轮不改 placement 画像。

## 非目标

- **不做真题**：题库全部自编；不引入、不下载、不宣称任何真题。
- **不报分**：不做分数换算、成绩预测、通过比例、效果承诺、排名或「你相当于
  CET-4 xxx 分」；只显示答对题数/总题数。
- **不做前端**：不做练习页、计时器/全屏锁、结果页、历史页；不新增 UI 文案键。
- **不做分项诊断**：本轮只给逐题对错与解析；词汇/语法/阅读的分项能力评估
  与建议在后续轮次。
- **不做全部 CET 题型**：本轮只有 4 选 1 客观题（词汇/语法/阅读）；选词填空、
  段落匹配、听力填空、翻译/写作不做。
- **不建题库表**：题库是随仓库分发的静态 JSON；不存题干/答案副本，不做
  后台 CMS、不做题目编辑/审核工作流。
- **不做游客练习**：记录要归属账号；游客 403（与复习/理解题/读文章一致）。
- **不做计时强制/反作弊**：`durationMs` 只记录，不因超时自动交卷；也不检测
  切屏、复制等行为（练习定位不是监考）。

---

## 数据模型（迁移 `0012_exam`）

两张表，不改旧表；运行时不建表，未迁移时 `start/submit/history` 返回 **503**
并提示 `alembic upgrade head`。**不存题库、不存成绩/预测结果**：评分结果按
题库 + 作答行可重算。

### `exam_sessions`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK NOT NULL | `uuid4().hex`（应用生成；start/submit 共用） |
| `user_id` | TEXT NOT NULL | 归属键，登录用户的 `users.id`（需登录，游客不写） |
| `exam_type` | TEXT NOT NULL | 题型 id，当前只有 `cet4`；应用层校验，不加 CHECK 以便后续加题型 |
| `status` | TEXT NOT NULL DEFAULT `in_progress` | `in_progress` / `submitted`（CHECK） |
| `item_ids` | TEXT NOT NULL | 本次卷面的题库 id JSON 数组（保序）；不存题干/答案 |
| `started_at` | INTEGER NOT NULL | 服务端毫秒 UTC |
| `submitted_at` | INTEGER NULL | 首次提交时刻，重复提交不覆盖 |
| `duration_ms` | INTEGER NULL | 首次提交时写入；CHECK 0–86400000（24h） |

- `ix_exam_sessions_user_started(user_id, started_at)`：会话查询。
- `ix_exam_sessions_user_submitted(user_id, submitted_at)`：历史列表按提交
  时间倒序。
- 部分唯一索引 `ux_exam_sessions_active(user_id) WHERE status='in_progress'`：
  同一用户最多一个未提交会话，保证「复用」在并发下成立；已提交历史可并存。

### `exam_answers`

只存**已作答**的题；未答题由卷面 `item_ids` 与作答行之差得出，不写空行。
append-only，不提供更新/删除入口。

| 列 | 类型 | 说明 |
|---|---|---|
| `session_id` | TEXT NOT NULL | → `exam_sessions.id`，ON DELETE CASCADE |
| `item_id` | TEXT NOT NULL | 题库 id（如 `v-001` / `r-003`） |
| `chosen_index` | INTEGER NOT NULL | 0–3（CHECK；4 选 1 的合法下标） |
| `correct` | INTEGER NOT NULL | 0/1（CHECK） |
| `answered_at` | INTEGER NOT NULL | 服务端毫秒 UTC |
| — | PRIMARY KEY(`session_id`,`item_id`) | 同一会话同一题只落一行；并发双写的库级兜底 |

---

## 题库（`content/exam/cet4.json`）

- **规模**：30 题 = 15 词汇 + 5 语法 + 10 阅读；阅读为 3 段短文，每段 3–4 题。
- **每题字段**：`id`、`type`（`vocab` / `grammar` / `reading`）、`band`
  （A1–C1）、`prompt`、`options`（4 个英文选项）、`answerIndex`（0–3）、
  `explanation`（中文解析，只讲词义/固定搭配/语法，不编出处）、`topic`；
  阅读题另有 `passageId`，指向顶层 `passages[].id`。
- **草稿标记**：`_meta.notice` 必须含「草稿，待教研审校」；否则
  `ExamUnavailable`（503），不静默上线未审校题库。
- **结构校验**：总数 30、题型配额 15/5/10、`passages` 恰好 3 段、每段 3–4
  题、选项 4 个且不重复、`answerIndex` 0–3、解析/主题非空、id 唯一、
  阅读题 `passageId` 必须存在。题库缺失/损坏/未标草稿 → 503。
- **内容约束**：全部自编，不含真题；不使用「模拟考试」等替代表述或成绩/效果
  承诺；解析不声称来自某年真题或官方答案。

## 抽题

- 每次 10 题：**词汇 5 + 语法 2 + 阅读 3**（与题库总量 15/5/10 解耦）。
- 阅读按短文抽：尽量让 3 段短文各出现 1 题（随机选段、段内随机选题）。
- 种子：`exam.serve.v1:<sessionId>`，确定性抽题后打乱；卷面 id 写入
  `item_ids`，提交时按 id 重算题面（题库变动导致缺题时 503，不静默改卷）。
- 对外的 `itemId` 就是题库 id（练习不是考试，题库随仓库公开，不做 id 混淆）。

---

## 端点契约（全部需登录）

错误语义统一：游客/未登录 `403`；会话不存在或属于其他用户 `404`（不泄露
存在性）；参数非法 `400`；请求体结构不符合 Pydantic `422`；会话状态变化
`409`；未迁移/题库不可用 `503`。

### `GET /api/exam/types`

```json
{
  "types": [
    {
      "id": "cet4",
      "label": "CET-4 风格练习",
      "itemCount": 30,
      "sessionItemCount": 10,
      "description": "从 30 道自编题中抽 10 题（词汇 5 + 语法 2 + 阅读 3）；提交后看逐题对错与解析。",
      "disclaimer": "自编题，非真题；只做题型练习，不报分、不预测成绩。"
    }
  ],
  "disclaimer": "自编题，非真题；只做题型练习，不报分、不预测成绩。"
}
```

静态题库目录，不读写数据库；题库损坏时 503。

### `POST /api/exam/start`

请求：`{"type":"cet4"}`。`type` 也接受 `examType` / `exam_type`。

```json
{
  "sessionId": "7f3c…",
  "examType": "cet4",
  "label": "CET-4 风格练习",
  "status": "in_progress",
  "resumed": false,
  "startedAt": 1763200000000,
  "itemCount": 10,
  "totals": {"vocab": 5, "grammar": 2, "reading": 3, "all": 10},
  "instructions": "共 10 题……这是自编题练习，不是真题，也不提供成绩评估。",
  "items": [
    {
      "itemId": "v-001",
      "type": "vocab",
      "band": "A2",
      "topic": "校园",
      "prompt": "The library is a quiet place where students can ____ on their exams.",
      "options": ["refuse", "borrow", "focus", "complain"]
    },
    {
      "itemId": "r-001",
      "type": "reading",
      "band": "B1",
      "topic": "校园",
      "prompt": "What problem did the student council notice?",
      "options": ["…", "…", "…", "…"],
      "passage": {
        "id": "p-01",
        "title": "A Small Change in the Cafeteria",
        "text": "Last spring, ..."
      }
    }
  ],
  "disclaimer": "自编题，非真题；只做题型练习，不报分、不预测成绩。"
}
```

- **绝不下发** `answerIndex` / `explanation` / `correctIndex`。
- 同一用户已有未提交会话：返回同一 sessionId、同一卷面、`resumed=true`；
  不重复发 `exam_start` 事件。已有会话题型不同 → 409（当前只有 cet4，
  正常不会触发）。
- 不支持的 `type` → 400；题库坏了 → 503，不落会话。

### `POST /api/exam/submit`

请求：

```json
{
  "sessionId": "7f3c…",
  "answers": [
    {"itemId": "v-001", "chosenIndex": 2},
    {"itemId": "r-001", "chosenIndex": 1}
  ],
  "durationMs": 540000
}
```

- `answers` 可少于 10 条：未出现的题 = 未作答；`chosenIndex` 省略/null 也按
  未作答处理。
- `itemId` 必须属于本次卷面，重复或卷面外 → 400；`chosenIndex` 必须是
  0–3（不接受 -1）；`durationMs` 省略时服务端按 `now - started_at` 回算并
  截到 24h 上限，负数/超上限 → 400。

响应：

```json
{
  "sessionId": "7f3c…",
  "examType": "cet4",
  "label": "CET-4 风格练习",
  "status": "submitted",
  "reused": false,
  "startedAt": 1763200000000,
  "submittedAt": 1763200540000,
  "durationMs": 540000,
  "correct": 8,
  "total": 10,
  "answered": 9,
  "unanswered": 1,
  "items": [
    {
      "itemId": "v-001",
      "type": "vocab",
      "band": "A2",
      "topic": "校园",
      "prompt": "…",
      "options": ["…", "…", "…", "…"],
      "chosenIndex": 2,
      "correctIndex": 2,
      "correct": true,
      "answered": true,
      "explanation": "focus on 表示「集中注意力于」；……"
    },
    {
      "itemId": "r-001",
      "type": "reading",
      "band": "B1",
      "topic": "校园",
      "prompt": "…",
      "options": ["…", "…", "…", "…"],
      "passage": {"id": "p-01", "title": "…", "text": "…"},
      "chosenIndex": null,
      "correctIndex": 1,
      "correct": false,
      "answered": false,
      "explanation": "第一句提到……"
    }
  ],
  "disclaimer": "自编题，非真题；只做题型练习，不报分、不预测成绩。"
}
```

- 同一 sessionId 已提交：直接返回首次结果（`reused=true`），**忽略本次
  answers/durationMs**，不重复写行、不重复发事件；已提交会话的
  `submittedAt` / `durationMs` 不变。
- 提交只写已作答行；`exam_sessions` 更新为 `submitted` + 首次用时。
- 并发提交由 `PRIMARY KEY(session_id,item_id)` 与 `UPDATE ... WHERE
  status='in_progress'` 兜底；冲突后重读已提交结果返回，仍失败 → 409。

### `GET /api/exam/history?limit=20`

```json
{
  "sessions": [
    {
      "sessionId": "7f3c…",
      "examType": "cet4",
      "label": "CET-4 风格练习",
      "startedAt": 1763200000000,
      "submittedAt": 1763200540000,
      "date": "2026-11-15T06:22:20.000Z",
      "correct": 8,
      "total": 10,
      "answered": 9,
      "durationMs": 540000
    }
  ],
  "limit": 20,
  "disclaimer": "自编题，非真题；只做题型练习，不报分、不预测成绩。"
}
```

- 只含 `status='submitted'` 的会话，按 `submitted_at DESC, rowid DESC`。
- `limit` 默认 20，允许 1–100；越界 → 422。
- **不返回** score / predictedScore / passRate / 正确率百分比等任何成绩口径。

---

## 身份、错误与事件

| 场景 | 结果 |
|---|---|
| 游客 / 未登录 | 403（四个端点一致） |
| 登录用户 | 200；数据归属 `users.id` |
| 别人的 sessionId 提交 | 404（与不存在同文案） |
| 不支持的 type | 400 |
| sessionId 为空/不存在 | 400 / 404 |
| 未跑 `0012_exam` | start/submit/history 503；types 不依赖 DB，仍 200 |
| 题库缺失/损坏/未标草稿 | types/start 503 |
| 已提交会话再次提交 | 200 + 首次结果 + `reused=true` |

学习事件（`learning_events`，append-only，失败不阻断主流程）：

- `exam_start`：仅在**新建**会话时写；`session_id` = 练习会话 id，
  `content_ref` = `cet4`；payload = `{examType, itemCount, totals, resumed:false}`。
- `exam_submit`：仅在**首次**提交时写；payload =
  `{examType, correct, total, answered, durationMs}`。
- 事件 payload **不含** score 或任何成绩预测字段；周报与画像的聚合在后续轮次接入，
  本轮不写 `user_profiles`、不影响 placement。

---

## 文案与命名约束（硬性）

- 产品名统一「考试练习」；不使用「模拟考试」等替代表述。
- 面向用户的响应/页面文案只给 `correct/total` 与逐题对错，不给成绩评估、
  通过承诺或提分承诺；不出现 score / predicted / passRate 字段。
- 题库与 `disclaimer` 明确：自编题、非真题；只做题型练习，不报分、不预测
  成绩。
- 不承诺「做完能过 CET-4」或任何效果。

---

## 验收与测试

离线测试 `backend/tests/test_exam.py`（16 个）覆盖：

1. 题库：30 题配额 15/5/10、3 段短文每段 3–4 题、草稿标记、字段/选项/正确项
   合法、抽题 5+2+3 且 3 段阅读各 1 题、确定性；
2. `types`：登录目录正确；游客 403；
3. `start`：10 题、不含答案/解析、会话落库、事件 `exam_start`；复用同一
   sessionId/卷面且不重复发事件；
4. `submit`：全对 10/10、混合答案、未答标记（answered/unanswered）、逐题
   `correctIndex`/`explanation`、时长回算、事件 `exam_submit`；
5. 幂等：重复提交返回首次结果、不重复写行/发事件；
6. `history`：只列已提交、最新在前、limit、日期/正确数/总数、无禁用字段；
7. 权限与错误：游客 403、跨用户 404、非法 type/答案/时长 400、缺 sessionId
   422、未迁移 503、题库缺失 503；
8. 迁移测试同步覆盖 `0012_exam` 升/降级、索引、CHECK、FK CASCADE。

全量离线测试：`cd backend && venv/bin/python -m pytest tests -q`。
手工冒烟：临时 `/tmp` 库跑 `alembic upgrade head` + `uvicorn --port 8001`，
登录后 `types → start（10 题）→ submit（correct/total）→ history`，确认
响应无任何成绩字段。

---

## 已知边界（如实列出）

- 题库只有 **30 题草稿**，且覆盖的是 4 选 1 词汇/语法/阅读；选词填空、
  段落匹配、听力填空、翻译/写作未做。
- 无前端、无计时强制、无分项诊断、无错题本/重练；历史只到会话级。
- 评分是直接对答案，不做加权/能力估计；不声称与 CET-4 真实成绩对标。
- 未做题目乱序防作弊之外的任何监考；练习定位不是考试。
- 游客不可用；跨设备一致性依赖登录账号。
