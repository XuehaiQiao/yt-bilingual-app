# 规格：理解题与证据回跳（后端）

**状态：** 已实现（2026-11-15，M3 后端；前端答题 UI 下一轮）｜ **对应代码：** `backend/quiz.py`、`backend/routes_quiz.py`、`backend/migrations/versions/0007_quiz.py`、`backend/tests/test_quiz.py`

> 计划书 §13.2 M3 的第一块：给「看完一个视频」一个出口——3 道英文理解题，
> 每题引用一个具体字幕 block 作为证据；答错可回跳证据时间点。
> 本规格只冻结**后端契约**：内容项、出题管线（两道闸 + 缓存）、作答、结果统计、
> 学习事件。答题页/回跳动画/周报展示在下一轮实现。

---

## 目标

- **G1 有出口**：已有双语字幕（≥8 句）的 video / local_show，能生成 3 道英文理解题（选择题 / 判断题）。
- **G2 有证据**：每道题都绑定一个真实存在的字幕 block，并带秒/毫秒时间点；前端可据此跳回视频那一秒。
- **G3 有判断**：作答记录落到服务端（`attempts`），返回对错、正确答案、解释与证据，结果页可算正确率与错题证据列表。
- **G4 不重复花钱**：同一用户、同一内容、同一目标语言，在 `(content_hash, prompt_version)` 不变时只调用模型一次；字幕变化才重生成。
- **G5 有质量闸**：结构闸（选项数量/答案下标/证据存在）+ 内容闸（英文题干不混中文、题目与证据句相关）；不合格的题不返回给用户。
- **G6 可积累**：每次作答写 `learning_events`（`quiz_answer`），供后续周报与能力评估。

## 非目标

- 不做前端答题页、回跳动画、结果页 UI（下一轮）。
- 不做题目跨用户共享：计划书 D-7 默认 **private**，同一用户同一内容只生成一次；跨用户复用要等 `derivative_policy` 定稿。
- 不做举报/人工审核入口、种子题库、1 句产出（M3 后续 / 下一轮）。
- 不做听写/填空/词义猜测三类题（计划书 §9.4 的完整题库在后续阶段）。
- 不迁移或改写已有 `history/` 缓存；只读取当前用户的字幕缓存。

---

## 数据模型（迁移 `0007_quiz`）

三张表都不改旧表；运行时不建表，未迁移时路由返回 **503** 并提示 `alembic upgrade head`。

### `content_items`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | uuid4 hex |
| `user_id` | TEXT NOT NULL | 归属用户（题目不跨用户共享） |
| `kind` | TEXT NOT NULL | `video` / `local_show`（CHECK） |
| `content_ref` | TEXT NOT NULL | 视频 videoId；本地剧集规范化成 `<show_id>-S01E01` |
| `target_lang` | TEXT NOT NULL DEFAULT `zh-CN` | 与 i18n 口径一致 |
| `content_hash` | TEXT NOT NULL | 双语字幕正文 + 起止毫秒的规范化 sha256 前 32 hex |
| `title` | TEXT NOT NULL DEFAULT `''` | 标题只用于展示，不进 prompt |
| `status` | TEXT NOT NULL DEFAULT `draft` | `draft`（未生成 / 全部题被拒）/ `ready`（有可用题） |
| `prompt_version` | TEXT NOT NULL DEFAULT `quiz.v1` | **内部列**：缓存键第二维，prompt 升级时使旧题失效 |
| `created_at` | INTEGER NOT NULL | 毫秒 UTC |

- `UNIQUE(user_id, content_ref, target_lang)`：同一用户同一内容同一语言一条内容项。
- 字幕变化（`content_hash` 变化）或 prompt 升级时，复用同一内容项、把旧题置为
  `rejected`（历史 `attempts` 仍保留），再写新题。

### `questions`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | uuid4 hex |
| `content_item_id` | TEXT NOT NULL | FK → `content_items.id`，ON DELETE CASCADE |
| `ordinal` | INTEGER NOT NULL | 展示顺序（通常 1..3） |
| `question_type` | TEXT NOT NULL | `mcq` / `tf`（CHECK） |
| `prompt` | TEXT NOT NULL | 英文题干 |
| `options` | TEXT NOT NULL | JSON 数组文本；mcq 4 项、tf 2 项 |
| `answer_index` | INTEGER NOT NULL | 0 基下标；rejected 行可能为 -1 |
| `evidence_block_id` | TEXT NULL | 证据 block id（数字字符串会转回 int 返回） |
| `evidence_start` / `evidence_end` | INTEGER NULL | 证据起止，**毫秒**（计划书 S23 口径） |
| `explanation` | TEXT NOT NULL DEFAULT `''` | 解释，可为目标语言（中文/越南语） |
| `status` | TEXT NOT NULL DEFAULT `draft` | `draft` / `approved` / `rejected`（CHECK） |
| `model` | TEXT NULL | 生成模型 id |
| `created_at` | INTEGER NOT NULL | 毫秒 UTC |

索引：`ix_questions_content_item(content_item_id)`。

### `attempts`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | 作答流水 |
| `user_id` | TEXT NOT NULL | 作答用户 |
| `question_id` | TEXT NOT NULL | FK → `questions.id`，ON DELETE CASCADE |
| `chosen_index` | INTEGER NOT NULL | 用户选的选项下标 |
| `is_correct` | INTEGER NOT NULL | 0/1（CHECK） |
| `answered_at` | INTEGER NOT NULL | 毫秒 UTC |
| `elapsed_ms` | INTEGER NULL | 答题耗时，可空 |

索引：`ix_attempts_user_answered(user_id, answered_at)`、`ix_attempts_question(question_id)`。
append-only：应用层只 INSERT/SELECT，不提供修改/删除入口。

---

## 出题管线

### 输入（严格）

- 视频：`translate.find_history_file_for_video(contentRef, target_lang)` 找到当前用户该语言的
  `history/[<lang>/]<...>_<videoId>.json`；
- 本地剧集：`history/[<lang>/]<show_id>_SxxEyy.json`；`contentRef` 接受
  `show_id-S01E01` / `show_id_S01E01` / `show_id/S01E01`，统一规范化为
  `<show_id>-S01E01`；
- 校验缓存 payload 的 `target_lang` 与请求一致；不一致视为未命中（404）；
- 只取 `transcript` 里同时有 `en_text` 与有效 `zh_text`（不是 `[未翻译]`/模拟翻译）的块；
  **至少 8 句**，否则 **422**（「这集暂无练习」）；
- 送模型的上下文最多 40 块：短内容全用，长内容按时间轴均匀抽样；每行只给
  `block id + start 秒 + en_text`，**不给标题、频道名、中文译文**（计划书 §9.4 输入纪律）。

### 模型输出（严格 JSON）

```json
{"questions": [
  {"question_type": "mcq", "prompt": "English question?",
   "options": ["A", "B", "C", "D"], "answer_index": 0,
   "evidence_block_id": "12", "explanation": "中文或越南语解释"},
  {"question_type": "tf", "prompt": "English statement to judge.",
   "options": ["True", "False"], "answer_index": 0,
   "evidence_block_id": "13", "explanation": "..."}
]}
```

- `mcq`：**4 个**英文选项；`tf`：**2 个**选项（True/False，判断题的自然形态）。
- 题面与选项必须是英文；解释使用目标语言（`languages.prompt_name`）。

### 两道闸（不额外花钱）

1. **结构闸**：
   - `mcq` options 恰好 4 个、`tf` 恰好 2 个；选项非空、互不重复、不含
     `all/none of the above`；
   - `answer_index` 是整数且在选项范围内；
   - `evidence_block_id` 必须出现在本次输入的字幕块里（否则丢弃）；
   - 必须有非空 `explanation`。
2. **内容闸**：
   - 题干与选项不得出现中文/日文 CJK 字符（解释不受限）；
   - 题干 + 选项必须与**本题证据句**至少共享一个英文实词（简易词尾归一 +
     停用词过滤），防止「问与本段无关的内容」。
   - 证据 block 的 `start/end` 从缓存块直接取，不信任模型给的时间。

任一题不过 → **整批重试 1 次**（把校验问题写进 prompt）；仍不过的题以
`rejected` 落库，不返回给用户。三题中部分通过时返回通过的部分（1–3 题），
内容项仍为 `ready`；全部不通过时为 `draft`。

### 缓存与失败语义

- 缓存键 = `(user_id, content_ref, target_lang)` + 行内 `(content_hash, prompt_version)`。
  同一内容未变化 → 直接复用库里的 `approved` 题，**不再调模型**。
- 模型调用/解析失败（没有产生任何候选）→ **不落库**，返回 422 + 错误；下次
  启动可以重试（失败不污染缓存）。
- 模型给出了候选但全部被 QC 拒绝 → 以 `rejected` 落库、内容项 `draft`；下次
  启动命中失败缓存直接 422，**不重复花钱**。
- 生成成功后，同一内容再次 `start` 不重复调用模型；题目 id 保持不变。

---

## API 契约

全部端点**需登录**；游客/未登录 **403**。`targetLang` 缺省 `zh-CN`，非法 **400**。

| 端点 | 请求 | 成功 |
|---|---|---|
| `POST /api/lesson/start` | `{kind, contentRef, targetLang?}` | `{lessonId, status, kind, contentRef, targetLang, contentHash, questions:[{id, ordinal, questionType, prompt, options}]}`；已有缓存直接复用 |
| `GET /api/lesson/{id}/questions` | — | 同上（不含答案/解释）；lesson 不存在/别人的 **404** |
| `POST /api/lesson/answer` | `{questionId, chosenIndex, elapsedMs?}` | `{correct, answerIndex, chosenIndex, explanation, evidence:{blockId,start,end,startMs,endMs}, lessonId, questionId, questionType, attemptId, answeredAt}` |
| `GET /api/lesson/{id}/result` | — | `{lessonId, status, kind, contentRef, targetLang, totalQuestions, answered, correct, wrong, correctRate, wrongQuestions:[…], lastAnsweredAt}` |

### 证据时间口径

- 数据库 `evidence_start/end`：**毫秒**（计划书 S23 的 `start_ms` 口径）。
- 响应 `evidence.start/end`：**秒**（与字幕 block 同一时间轴，播放器可直接
  `seekTo`）；同时给 `startMs/endMs` 便于稳定断言。
- `evidence.blockId`：数字 block id 返回 int，字符串 id 原样返回。

### 错误语义

| 状态码 | 场景 |
|---|---|
| 400 | kind / contentRef / targetLang / chosenIndex / elapsedMs 非法 |
| 403 | 游客/未登录 |
| 404 | 没有字幕缓存、lesson/question 不存在或是别人的 |
| 422 | 双语字幕不足 8 句、模型生成失败、题目全部未通过 QC |
| 429 | 「理解题」日配额/预算用完（`feature=quiz`） |
| 503 | 数据库未跑 `0007_quiz` 迁移 |

`chosenIndex` 越界、`elapsedMs` 为负或超过 24 小时 → 400，不写 attempt。

---

## 学习事件

每次成功写入 attempt 后追加 `learning_events`：

```json
{"event_type": "quiz_answer", "content_ref": "<videoId / show-S01E01>",
 "payload": {"lessonId": "...", "questionId": "...", "questionType": "mcq",
             "chosenIndex": 1, "answerIndex": 0, "correct": false,
             "evidence": {"blockId": 1, "start": 1.0, "end": 3.0,
                          "startMs": 1000, "endMs": 3000},
             "elapsedMs": 1234, "kind": "video", "targetLang": "zh-CN"}}
```

事件写失败只记日志，不阻断作答（`events.emit_event` 语义）。

## 成本与配额

- 模型调用走 `llm.generate_json_async`（全局并发闸 + 线程），`usage_scope("quiz", …)`
  记进 `ai_usage`（`feature=quiz`，按 provider usage 定价）。
- 生成一个 lesson 占 1 个 `AI_DAILY_QUOTA_QUIZ` 单位（默认 30/用户/日）；缓存命中
  不占额度。三层预算硬闸照旧生效。
- 单题成本目标 < $0.005（计划书 M3 验收）由 prompt 规模（≤40 块）与缓存保证，
  后续用 `ai_usage` 实测回填。

---

## 验收

- [x] 迁移 `0007_quiz` 建三表/索引/唯一约束/CHECK/FK；`downgrade 0006` 可回滚再升级。
- [x] 已有双语字幕的 video / local_show 生成 3 题（2 mcq + 1 tf）；选项、答案、证据合法。
- [x] 结构闸失败 → 重试 1 次；仍失败该题 `rejected`，不返回。
- [x] 内容闸：中文混入题干/选项、与证据句无关 → 重试/拒绝。
- [x] 缓存：同一 content_hash + prompt 版本只调用一次模型；字幕变化才重生成。
- [x] 作答记录 attempt、返回证据 block/秒/毫秒；答错结果进入 `wrongQuestions`。
- [x] 结果统计：对/错/正确率/错题证据列表。
- [x] `quiz_answer` 事件带 correct/evidence。
- [x] 跨用户隔离（404）、游客 403、参数 400、未迁移 503。
- [x] 全量离线测试保持绿（319 个）。

## 测试

```bash
cd backend
venv/bin/python -m py_compile *.py
venv/bin/python -m pytest tests/test_quiz.py -q
venv/bin/python -m pytest tests/test_migrations.py tests/test_quiz.py -q
venv/bin/python -m pytest tests -q
```

## 后续（下一轮）

- 前端 `features/learn/`：开始学习入口、答题卡、答错自动回跳证据时间点（±300 ms）、
  结果页与「这集暂无练习」空态。
- 举报/下架入口（S17）、人工抽检 50 题/周、种子题库（S19）。
- 周报接入 `quiz_answer`（正确率、错题主题、回看次数）。
- 题目跨用户共享（受 `derivative_policy` 约束）与题目难度参数。
