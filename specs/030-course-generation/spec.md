# 030 — 课程生成（YouTube / 公版小说）

> 状态：**已实现，推迟到网站上线后** ｜ 2026-11-18 实现、2026-11-19 调整优先级 ｜ 范围：用户端生成入口、后端生成器、P&P 公版小说源
> 上线前不以本功能为阻塞项；先完成 UI/UX 一致性与上线必需功能。
> 依赖：029 课程 MVP（attempt/评分/事件）、既有视频字幕/翻译、teaching_analysis、Gutenberg 抓取
>
> 代码路径（后端）：`backend/course_generator.py`（源适配/切章/生成/校验/缓存/单飞）、
> `backend/course.py`（静态 + 本人生成课程合并、脱敏、attempt）、
> `backend/routes_course.py`（`POST /api/course/generate`）、
> `backend/migrations/versions/0022_generated_courses.py`、
> `backend/tests/test_course_generation.py`。

## 1. 目标

把已有内容转成一节 12 分钟课程（S0–S5），不再只支持静态 `content/course/ocean-noise-12min.json`。

- **YouTube**：使用当前用户已处理视频的双语字幕
- **小说**：Project Gutenberg #1342《Pride and Prejudice》，按 `CHAPTER I–LXI` 切章
- 生成结果进入现有 `#/lesson/{lessonId}`，共用 CourseScreen/attempt/评分/事件
- 生成按内容+等级缓存；同一用户同一内容再次点击不重复调用模型

## 2. 非目标

- 不做真正“一条龙” YouTube 处理（先处理视频，再点生成）
- 不把 P&P 加入现有 75 本公版书库
- 不做课程市场/公开列表/支付
- 不做现代版权小说

## 3. 数据

迁移 `0022_generated_courses`：

| 列 | 说明 |
|---|---|
| `id` | `gen-<uuid>` |
| `owner_user_id` | 生成者；列表/详情只返回本人 |
| `source_kind` | `youtube` / `novel` |
| `source_ref` | videoId 或 `gutenberg:1342:chapter:1` |
| `content_hash` | 源文本规范化 sha256 前 32 位 |
| `level` | 高亮档 id 或 CEFR 标签 |
| `target_lang` | `zh-CN` / `vi-VN` |
| `prompt_version` | `course-gen.v1` |
| `title` / `lesson_json` | 生成课程（含答案，服务端用） |
| `status` | `ready` |
| `created_at` | 毫秒 |

唯一键：`(owner_user_id, source_kind, source_ref, content_hash, level, target_lang, prompt_version)`。

## 4. API

### `POST /api/course/generate`（登录）

```json
{"sourceKind":"youtube","videoId":"h-NZcQF7jgI","level":"moonwalk"}
```
或
```json
{"sourceKind":"novel","gutenbergId":1342,"chapter":1,"level":"moonwalk"}
```

- `level` 可省略，默认 `orbit`；支持现有 liftoff..supernova
- YouTube：当前用户 + 目标语言必须已有处理好的 history；否则 409 `source_not_ready`
- Novel：Gutenberg #1342，chapter 1–61；抓取/解析失败 502；内容过长截取
- 缓存命中：`cached:true`，零模型调用
- 首次生成：一次 LLM，严格校验后落库；失败 502 `generation_failed`，不写半成品
- 配额：`course_generation`，每天 5 次；缓存命中不占
- 响应：`{lessonId, title, level, sourceKind, cached, status:"ready"}`

### `GET /api/course/lessons`
静态课程 + 当前用户生成的课程。

### `GET /api/course/lessons/{id}`
静态包或本人生成课程；脱敏规则同 029（不含 answer/explain）。

### 其他 `/api/course/attempts/*`
不变；lesson_id 可指向生成课程。

## 5. 生成内容

- 3 个阅读/观看段（每段 1–3 段原文；总英文目标 250–350 词，生成接受 200–600 词）
- 4 个词 + 1 个形式点，均带原文证据；生成时若某个词无法在原文找到，允许降为 3 个词，不整课失败
- 6 主测 + 2 离场题，MCQ，带 answer/explain/evidence
- 2–5 句产出，2 个目标词
- 元数据：source/title/level/durationMinutes/sourceRef
- 小说段落的 `zh` 由同一次 LLM 生成（标记 machine_translation，质量由后续人工抽检）

校验：

- 词/形式点必须在整篇源文出现；题目 evidence 必须在对应段出现
- 题目 answer 必须是合法 option id；evidence 必须是原文子串
- 至少 6 主测 + 2 离场；总英文 200–600 词（目标 250–350）
- 失败重试 1 次；仍失败不落库

## 6. 前端

### YouTube
- 视频结果页增加「生成课程」按钮
- 点击：loading「正在生成 12 分钟课程…（约 30 秒）」→ 成功 `#/lesson/{id}`；失败可重试
- 源未就绪提示「先完成字幕生成/翻译」
- 同一视频已生成时走缓存

### 小说
- 今日页/内容页增加「经典小说课程」入口
- Pride and Prejudice，章节 1–61 选择；默认第 1 章
- 「生成课程」→ 同一课程 UI；缓存命中直接进

## 7. 验收

- 后端：迁移/API/源适配/缓存/校验/权限/配额测试；不联网测试用 fake LLM
- 前端：tsc/check:i18n/build；Playwright：视频生成、章节生成、loading/失败/缓存、375/1440
- 真机：同一视频同 level 第二次 `cached:true`；P&P 第 1 章生成后进课程
- 不做部署
