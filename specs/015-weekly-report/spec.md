# 规格：学习事件上报与周报（后端）

**状态：** 已实现（2026-11-15，M5 后端；前端周报页/邮件下一轮）｜ **对应代码：** `backend/reports.py`、`backend/routes_events.py`、`backend/migrations/versions/0008_weekly_report.py`、`backend/tests/test_weekly_report.py`

> 计划书 §13.2 M5 / §15 的第一块后端：前端把「看了多久 / 看了哪个内容」批量
> 上报，服务端按 **UTC 周** 聚合出「3 个数字 + 1 句事实 + 1 个下一步 + 1 段
> 可回看证据（5 秒原声的时间窗）」。本规格只冻结**后端契约**：事件表、上报
> 幂等、周报口径、快照与错误语义。前端 `/features/report/`、邮件送达与退订、
> 音频切片在后续轮次实现。

---

## 目标

- **G1 能上报**：前端一次可提交最多 50 条 `watch` 事件（内容、kind、目标语言、
  观看秒数、播放位置、发生时间、客户端幂等键）。
- **G2 不重复**：同一用户（含游客）重复提交同一 `clientEventId` 只落一行；
  重复上报不重复计数。
- **G3 能算周报**：给定 `weekStart` 或默认本周一（UTC），用 SQL 算出
  被动学习分钟、复习词数、理解题正确率，并生成一句中文事实。
- **G4 有下一步**：按固定优先级用规则生成一句可执行建议（不调用模型）。
- **G5 有证据**：优先返回本周答错题的 evidence block（contentRef + 起止时间 +
  字幕句子）；没有错题时返回最近一次观看的 5 秒回看窗口；都没有则 `null`。
- **G6 可留档**：同一用户同一 UTC 周的首份周报写入 `weekly_reports` 快照，
  供站内页与未来邮件复用；同周不覆盖。
- **G7 游客可用**：游客也有独立归属键与独立周报，不要求注册。

## 非目标

- 不做前端周报页、带回卡片、邮件模板、退订、打开率采集。
- 不做音频文件切片/转码：本轮只返回秒/毫秒时间窗与句子，播放器按时间点回跳。
- 不做模型叙述：事实句与下一步全部规则生成（计划书：数字用 SQL 算，模型只
  写叙述；模型叙述进 V1）。
- 不做游客认领账号时把 `watch_events.user_id` 从 `guest:<sha256>` 迁移到
  `users.id`（`guest_hash` 列已预留；认领迁移在账号生命周期的后续小节做）。
- 不做反作弊/客户端时长校验（只做范围与未来时间校验）。

---

## 数据模型（迁移 `0008_weekly_report`）

两张表都不改旧表；运行时不建表，未迁移时两个端点返回 **503** 并提示
`alembic upgrade head`。

### `watch_events`（append-only）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 自增 |
| `user_id` | TEXT NOT NULL | **归属键**：登录用户 = `users.id`；游客 = `guest:<sha256>` |
| `guest_hash` | TEXT NULL | 游客 sha256（登录用户 NULL）；预留给游客认领迁移 |
| `content_ref` | TEXT NOT NULL | 视频 videoId；本地剧集规范化为 `<show_id>-S01E01` |
| `kind` | TEXT NOT NULL | `video` / `local_show`（CHECK） |
| `target_lang` | TEXT NOT NULL DEFAULT `zh-CN` | 目标语言 |
| `watched_seconds` | INTEGER NOT NULL | 本次观看秒数，CHECK 0–86400 |
| `position_seconds` | INTEGER NOT NULL | 离开时的播放位置（秒），CHECK 0–86400 |
| `occurred_at` | INTEGER NOT NULL | 客户端毫秒 UTC 时间戳 |
| `client_event_id` | TEXT NOT NULL | 客户端生成的幂等键 |

- `UNIQUE(user_id, client_event_id)`：同一归属下重复上报只落一行。
- `ix_watch_events_user_occurred(user_id, occurred_at)`：周报聚合与连续天数的
  唯一查询路径。
- append-only 在应用层保证（`reports.py` 只 INSERT/SELECT，不提供改/删入口）。

### `weekly_reports`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 自增 |
| `user_id` | TEXT NOT NULL | 归属键（同上） |
| `week_start` | DATE NOT NULL | UTC 周一（`YYYY-MM-DD`） |
| `payload` | TEXT NOT NULL | 完整周报 JSON（`version` / `generatedAt` / `report`） |
| `created_at` | INTEGER NOT NULL | 服务端毫秒 UTC |

- `UNIQUE(user_id, week_start)`：同一用户同一周只有一份快照。
- 快照写入用 `INSERT OR IGNORE`：**首份为准**，后续 GET 不覆盖（站内页可以
  显示实时数字，邮件/留档使用首份快照；口径变化必须升 `version`）。

---

## `POST /api/events`

### 请求

```json
{"events": [
  {"type": "watch",
   "contentRef": "dQw4w9WgXcQ",
   "kind": "video",
   "targetLang": "zh-CN",
   "watchedSeconds": 42,
   "positionSeconds": 128,
   "occurredAt": 1794398400000,
   "clientEventId": "w-2026-11-09-a1"}
]}
```

- `events` 必须是数组，**单次最多 50 条**（超限 400，整批不写）。
- `type` 目前只接受 `"watch"`（其他类型 400，避免把未来事件误写进观看表）。
- `contentRef`：非空、≤200 字符；规则与理解题一致（video 不接受 `/`；
  `local_show` 接受 `show_id-S01E01` / `_S01E01` / `/S01E01`，统一规范化成
  `<show>-SxxEyy`；拒绝 NUL / 反斜杠 / 路径分隔符）。
- `kind`：`video` / `local_show`。
- `targetLang`：缺省 `zh-CN`，非法 400。
- `watchedSeconds`：数字，0–86400（秒）；落库四舍五入为整数。
- `positionSeconds`：数字，0–86400；缺省 0。
- `occurredAt`：整数毫秒；不能比服务端时间晚 **5 分钟以上**（400），负数 400。
- `clientEventId`：非空、≤128 字符；客户端生成，用于幂等。
- **任一条非法 → 整批 400，不落任何一条**（校验全部在事务前完成）。

### 身份

- 有有效会话 → `user_id = users.id`，`guest_hash = NULL`；
- 无会话、有 `ln_guest` → `user_id = guest:<sha256>`，`guest_hash = sha256`；
- 两者都没有时中间件会当场下发游客 Cookie，所以正常 `/api/*` 请求一定有身份。

### 响应

```json
{"received": 4, "accepted": 3, "duplicated": 1}
```

- `accepted`：新写入的行数；
- `duplicated`：被 `UNIQUE(user_id, client_event_id)` 忽略的条数；
- 幂等对「同一批内重复」和「跨请求重复」同样生效。

### 错误语义

| 状态码 | 场景 |
|---|---|
| 400 | 批次 >50、字段缺失/类型错、负数/超 24h、未来时间过远、非法 kind/lang/contentRef |
| 403 | 既非登录用户也无游客身份（正常请求不会出现） |
| 503 | `watch_events` 表缺失（未跑 `0008_weekly_report`） |

---

## `GET /api/report/week?weekStart=YYYY-MM-DD`

### 周界

- 周界固定为 **UTC 周一 00:00**，区间左闭右开 `[weekStart, weekStart + 7d)`；
- `weekStart` 缺省 = 当前 UTC 周的周一；
- 传任意日期会**归一到所在周的周一**（例：`2026-11-11` → `2026-11-09`）；
- 格式必须是 `YYYY-MM-DD`，非法 400；`weekEnd` 返回下周一（开区间）。

### 响应

```json
{
  "version": 1,
  "weekStart": "2026-11-09",
  "weekEnd": "2026-11-16",
  "timezone": "UTC",
  "generatedAt": 1794398400000,
  "numbers": {
    "passiveMinutes": 17.0,
    "reviewedWords": 3,
    "quizAccuracy": 0.6667
  },
  "fact": "你本周看了 1 个视频和 1 集剧集，完成 6 道题，复习了 3 个词。",
  "nextStep": "复习 2 个到期词",
  "evidence": {
    "source": "quiz_wrong",
    "contentRef": "vid1",
    "kind": "video",
    "targetLang": "zh-CN",
    "start": 10.0,
    "end": 13.0,
    "startMs": 10000,
    "endMs": 13000,
    "durationSeconds": 3.0,
    "sentence": "The museum opens at nine in the morning.",
    "blockId": 1,
    "questionId": "q1",
    "attemptId": 7,
    "answeredAt": 1794398400000
  },
  "streakDays": 3,
  "quiz": {"attempts": 6, "correct": 4},
  "words": {"new": 5, "reviewed": 3, "dueTomorrow": 2}
}
```

### 三个数字

| 字段 | 口径 | 无数据 |
|---|---|---|
| `numbers.passiveMinutes` | 本周 `watch_events.watched_seconds` 求和 ÷ 60，保留 1 位小数 | `0.0` |
| `numbers.reviewedWords` | 本周 `review_logs` 的 `COUNT(DISTINCT lemma)` | `0` |
| `numbers.quizAccuracy` | 本周 `attempts.correct / attempts`，保留 4 位小数（0–1） | `null`（不是 0） |

### 一句事实 `fact`

- 有数据：`你本周` + 非零部分用中文逗号连接 + `。`；
  - 观看按 **distinct contentRef** 计数，分别说「看了 N 个视频」「看了 N 集剧集」
    「看了 N 个视频和 M 集剧集」；
  - 作答：「完成 N 道题」；复习：「复习了 N 个词」；
  - 某个来源为 0 时省略该分句。
- 没有任何数据：`这周还没有可统计的学习记录。`

### 下一步 `nextStep`（规则，优先级从上到下）

| 优先级 | 条件 | 文案 |
|---|---|---|
| 1 | 本周无观看、无作答、无复习 | `明天先看一个 10 分钟的视频` |
| 2 | 本周无作答（无输出） | `明天做一次理解练习` |
| 3 | `words.dueTomorrow > 0` | `复习 N 个到期词` |
| 4 | 本周无观看 | `看一个 10 分钟的视频` |
| 5 | 本周无复习 | `把本周遇到的生词加进复习` |
| 6 | 有 ≥4 次作答且正确率 < 0.6 | `再做一次理解练习，答错的句子回听一遍` |
| 7 | 其它 | `保持这个节奏，明天学 10 分钟` |

### 证据 `evidence`

优先级：

1. **本周最近一条答错题**（`attempts.is_correct = 0` 且 question 有
   `evidence_start/end`）：返回 `source="quiz_wrong"`，时间取题目证据 block 的
   毫秒起止；`sentence` 从当前身份该语言的字幕缓存里按 `evidence_block_id`
   解析（缓存缺失/损坏时句子为 `null`，时间点仍返回）；附带 `questionId` /
   `attemptId` / `answeredAt`。
2. **本周最近一次观看**：返回 `source="watch"`，以 `positionSeconds` 为中心
   截 **5 秒**窗口（开头不足 2.5 秒时从 0 起算），`start/end` 固定相差 5.0 秒；
   按位置在该语言字幕缓存里找包含它的 block 给 `sentence`（找不到为 `null`）；
   附带 `positionSeconds` / `watchedSeconds` / `occurredAt`。
3. 都没有：`null`。

时间字段同时给**秒**（`start/end`，播放器直接 seek）与**毫秒**
（`startMs/endMs`，稳定断言口径），另给 `durationSeconds`。`blockId` 与理解题
API 一致：数字 block id 返回 int，字符串 id 原样返回。

### 其余字段

- `streakDays`：有任意 watch / quiz / review 的 UTC 日连续天数。今天没有记录时
  从昨天往回数（与 `srs.get_stats` 一致），最多回溯 400 天。
- `quiz`：本周作答数与答对数（append-only 流水，重做同一题算多次）。
- `words`：
  - `new`：本周新建的 `word_states` 的 distinct lemma；
  - `reviewed`：同 `numbers.reviewedWords`；
  - `dueTomorrow`：到**明天结束**前所有该复习的词（`learning` / `review` /
    `relearning`，含已逾期；与 `srs` 的到期口径同源），相对**当前时刻**计算。

### 快照

首次计算某周周报时写 `weekly_reports`（`INSERT OR IGNORE`）：

```json
{"version": 1, "generatedAt": 1794398400000, "report": {…完整响应…}}
```

- 同用户同周只保留首份；后续 GET 可以在响应里返回实时数字，但不覆盖快照；
- 无数据也写快照（未来邮件要能表达「这周数据不足」）；
- 不同周各一份。

### 错误语义

| 状态码 | 场景 |
|---|---|
| 400 | `weekStart` 不是合法 `YYYY-MM-DD` |
| 403 | 既非登录用户也无游客身份（正常请求不会出现） |
| 503 | `watch_events` / `weekly_reports` 表缺失（未跑 `0008_weekly_report`） |

---

## 隐私与隔离

- 归属只认 `user_id`：登录用户与游客、游客与游客之间互不可见；
- `guest_hash` 只是游客身份的补充列（为认领迁移预留），接口不返回；
- 事件表不存 Cookie 原文、只存 sha256 归属键；
- 周报只在有身份时返回，未登录请求由中间件当场签发游客 Cookie，因此不会
  把「匿名请求」混进某个真实用户。

---

## 验收

- [x] 迁移 `0008_weekly_report` 建两表/索引/唯一约束/CHECK；`downgrade 0007` 可回滚再升级。
- [x] `POST /api/events` 批量写入，最多 50 条；同批/跨请求重复 `clientEventId` 不重复计数。
- [x] 游客可用：`user_id = guest:<sha256>`、`guest_hash` 落库，游客周报与登录用户隔离。
- [x] 校验：负数/超 86400 秒/未来 5 分钟以上/非法 kind·type·lang·contentRef 一律 400，整批不写。
- [x] 周报三个数字：求和 / distinct lemma / 正确率；无数据时 0 / 0 / null。
- [x] 事实句与下一步按规则生成（无输出、有到期词、无观看、无复习、低正确率等分支）。
- [x] 证据优先答错题 block（contentRef/起止/句子），否则最近观看的 5 秒窗口，否则 null。
- [x] 连续天数跨 watch/quiz/review；UTC 日界。
- [x] UTC 周一 00:00 左闭右开；`weekStart` 任意日期归一；非法 400。
- [x] `weekly_reports` 同周只写首份；无数据也写；不同周各一份。
- [x] 未迁移 503；用户/游客隔离；全量离线测试绿（331 个）。

## 测试

```bash
cd backend
venv/bin/python -m py_compile *.py
venv/bin/python -m pytest tests/test_weekly_report.py -q
venv/bin/python -m pytest tests/test_migrations.py tests/test_weekly_report.py -q
venv/bin/python -m pytest tests -q
```

## 后续（下一轮）

- 前端 `features/report/`：周报页（3 数字 + 事实 + 下一步 + 带回卡片）、
  5 秒原声播放/回跳、空态与加载态。
- 邮件：复用 M1 事务性邮件通道发送每周事实，带退订与打开率采集。
- 周报叙述/邮件模板版本化（`payload.version` 已预留）。
- 游客认领账号时把 `watch_events.user_id` 从 `guest:<sha256>` 迁到 `users.id`
  （用 `guest_hash` 定位），并补迁移测试。
- `dueTomorrow` 与 `nextStep` 在「补看历史周」时的语义再确认（当前相对现在计算）。
