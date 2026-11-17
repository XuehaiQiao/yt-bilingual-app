# 029 — 课程 MVP 垂直切片（私测版）

> 状态：实现中 ｜ 2026-11-18 ｜ 范围：一课、登录用户、**仅本地功能实现（不部署/不上线）**
> 内容：`content/course/ocean-noise-12min.json`（自有文章；第三方视频 pack 不进入本功能）

## 1. 产品范围

只做**一课 12 分钟**的垂直切片，验证线上课程形式：

- 12 分钟 S0–S5：暖场 → 4 词 + 1 形式点 → 3 段阅读/讲解/题 → 2–5 句产出
- 进度可恢复；完成页显示得分/产出
- 事件埋点用于看流失
- 不做：课程列表页、支付、班级、教师端、完整 FSRS、A/B 框架

入口：`#/lesson/ocean-noise-12min`；今日页/内容页加一个「12 分钟课程」入口。

## 2. 数据

### `course_attempts`

| 列 | 说明 |
|---|---|
| `id` | UUID |
| `user_id` | 登录用户 |
| `lesson_id` | `ocean-noise-12min` |
| `lesson_version` | 课程 JSON version |
| `status` | `in_progress` / `completed` / `abandoned` |
| `current_step_id` | S0–S5 |
| `answers_json` | `{questionId: choice}` |
| `output_text` | 用户产出 |
| `score` / `total` | 完成时计算（8 题） |
| `started_at` / `updated_at` / `completed_at` | 毫秒时间戳 |

唯一约束：同一用户同一课程最多 1 条 `in_progress`。

### `course_events`

| 列 | 说明 |
|---|---|
| `id` | 自增 |
| `attempt_id` / `user_id` | 归属 |
| `event` | `lesson_start` / `step_view` / `step_complete` / `answer` / `output_submit` / `lesson_complete` / `drop` |
| `step_id` | 可空 |
| `payload_json` | 可空，小对象 |
| `created_at` | 毫秒 |

迁移：`0021_course_mvp.py`。

## 3. API（全部需登录；游客 401）

### `GET /api/course/lessons`
```json
{"lessons":[{"id":"ocean-noise-12min","title":"...","titleZh":"...","level":"B1","durationMinutes":12,"status":"private_beta","version":1}]}
```

### `GET /api/course/lessons/{id}`
返回课程**脱敏**内容：
- `steps` 内 `questions` 只含 `id/prompt/options`；**不含 `answer`/`explain`**
- `exitTicket` 同样脱敏
- 其余字段原样
- 404 `lesson_not_found`

### `POST /api/course/attempts`
```json
{"lessonId":"ocean-noise-12min"}
```
- 已有 `in_progress` → 返回该 attempt（`resumed:true`）
- 否则新建（`resumed:false`）
- 响应：`{attemptId, lesson, status, currentStepId, answers, output, startedAt, resumed}`

### `GET /api/course/attempts/{id}`
- 仅本人；404
- 返回同上 + `score/total/completedAt`

### `POST /api/course/attempts/{id}/answer`
```json
{"questionId":"Q1","choice":"A"}
```
- 只允许第一答案；重复同 choice 幂等，换 choice 409
- 响应：`{questionId,choice,correct,correctChoice,explanation}`
- 题目不存在/choice 非法 400

### `POST /api/course/attempts/{id}/step`
```json
{"stepId":"S3"}
```
- 更新 `current_step_id`；非法步骤 400；completed 后 409

### `POST /api/course/attempts/{id}/output`
```json
{"text":"..."}
```
- 保存产出；`wordCount` 由服务端按空格切分
- 最长 2000 字符

### `POST /api/course/attempts/{id}/complete`
- 要求所有 8 题已答、产出非空；否则 409 `incomplete`
- 计算 `score`（8 题中正确数），状态 completed
- 响应：`{score,total,answers:[{questionId,choice,correct}],output,completedAt}`

### `POST /api/course/attempts/{id}/events`
```json
{"event":"step_view","stepId":"S2","payload":{"elapsedMs":12000}}
```
- 204；非法 event 400；payload ≤2KB
- `drop` 允许 `navigator.sendBeacon` JSON

## 4. 前端

- `CourseScreen.tsx`：加载课程 → start attempt → S0–S5 单步渲染
- 顶部：课程标题、12:00 倒计时（不强制结束，只显示）、进度条、退出
- S1：词卡翻面/揭示释义
- S2–S4：英文段落 + 中文（可隐藏）、讲解、2 题；答后即时反馈
- S5：产出 textarea、字数、提交；完成后得分页 + 「下一节（即将开放）」/返回今日
- 刷新/退出后从 attempt 恢复
- 游客：显示登录提示，不创建 attempt
- 事件：step_view/step_complete/answer/output_submit/lesson_complete；卸载时 sendBeacon drop
- 375/1440；中越 i18n

## 5. 本地功能验证（不部署）

- 本轮只实现功能，在本机 `uvicorn` + Vite 上走通；不做 VPS/域名/Caddy/公开链接
- 内容：只接自有文章课；第三方视频课不进入本功能
- 验证：完成率、下一节点击、产出提交、每步流失、时长通过 `course_events` 本地检查
- 数据：`course_attempts` + `course_events`
- 部署/私测另立任务，不在本轮范围

## 6. 验收

- 后端迁移/API/权限/评分/事件测试
- 前端 tsc/check:i18n/build
- Playwright：完成一课、刷新恢复、答错反馈、产出校验、游客提示、375/1440
- 本地验证说明（启动命令、测试账号、事件检查）；部署不在本轮
