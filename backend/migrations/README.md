# backend/migrations — Alembic 迁移

**命令都在 `backend/` 下执行**（数据库路径来自 `AUTH_DB_PATH` 环境变量或 `config.py`，见 `env.py`）：

```bash
venv/bin/alembic upgrade head            # 新库：从零建到最新
venv/bin/alembic current                 # 当前库停在哪个 revision
venv/bin/alembic stamp 0001_baseline     # 旧库（只有 users/sessions）：只标基线，不动数据
venv/bin/alembic upgrade head            #   再补建 learning_events
venv/bin/alembic stamp head              # 已是最新的库：只写版本号，不执行 DDL
```

## 迁移清单

| revision | 内容 |
|---|---|
| `0001_baseline` | 基线：`users` / `sessions` + `idx_sessions_expires`，字段/索引与 `backend/auth_db.py` 一致 |
| `0002_learning_events` | 学习事件日志 `learning_events`（append-only）+ 两个查询索引 |
| `0003_cost_ledger` | AI 成本账本 `ai_usage`（append-only）+ 日配额 `ai_quota`（主键 `user_id, day, feature`）+ 三个查询索引 |
| `0004_target_lang` | 给 `ai_usage` 加可空 `target_lang`（默认 `zh-CN`，旧行不改写、不做 UPDATE）；不拆配额表 |
| `0005_jobs` | 任务表 `jobs`（`id`/`user_id`/`kind`/`content_ref`/`target_lang`/`status`/`cursor`/`payload`/`error`/`created_at`/`updated_at`，`status` 带 CHECK）+ `ix_jobs_user_created` + 部分唯一索引 `ux_jobs_active`（同一 user+kind+content+语言最多一个未完成 job）；见 [backend/README「任务表与断线续传」](../README.md#任务表与断线续传m1-⑤jobs--sse-重连) |
| `0006_review_engine` | 复习引擎三表：`word_states`（状态/FSRS 参数/到期，`UNIQUE(user_id,lemma,target_lang)` + `(user_id,due_at)` 索引）、`review_logs`（append-only 流水 + `(user_id,reviewed_at)` 索引）、`word_sources`（词来源，FK → `word_states.id` ON DELETE CASCADE + `word_state_id` 索引）；见 [backend/README「复习引擎」](../README.md#复习引擎m2fsrs-6--队列--复习日志) |
| `0007_quiz` | 理解题三表：`content_items`（用户内容项，`UNIQUE(user_id,content_ref,target_lang)` + 内部列 `prompt_version`）、`questions`（题目/选项/答案/证据 block 与毫秒时间点，状态 CHECK）、`attempts`（append-only 作答流水 + `(user_id,answered_at)` 索引）；见 [backend/README「理解题」](../README.md#理解题m3-后端出题--作答--证据回跳) 与 [specs/014](../../specs/014-quiz/spec.md) |
| `0008_weekly_report` | 观看事件 `watch_events`（`user_id` 归属键含游客 `guest:<sha256>` + 可空 `guest_hash`、`UNIQUE(user_id,client_event_id)`、`(user_id,occurred_at)` 索引、秒数 CHECK 0–86400）+ 周报快照 `weekly_reports`（`UNIQUE(user_id,week_start)`、`payload` JSON 文本）；见 [backend/README「学习事件上报与周报」](../README.md#学习事件上报与周报m5-后端观看事件--周报快照) 与 [specs/015](../../specs/015-weekly-report/spec.md) |
| `0009_placement` | 能力定位测三表：`placement_sessions`（`id` TEXT PK、`user_id` 归属键含游客 `guest:<sha256>`、`status` CHECK、`started_at/submitted_at/duration_ms/score/cefr/confidence/breakdown`，`(user_id,started_at)` 索引 + 部分唯一索引 `ux_placement_sessions_active` 保证同一用户最多一个未完成会话）、`placement_answers`（FK → sessions CASCADE、`item_type`/`chosen_index=-1..3`/`correct`/`difficulty_band` CHECK、`UNIQUE(session_id,item_id)`）、`user_profiles`（每归属键一行：区间/词汇量估计/阅读带/置信度/伪词可疑度/来源）；见 [backend/README「能力定位测与能力画像」](../README.md#能力定位测与能力画像m4-后端) 与 [specs/016](../../specs/016-placement/spec.md) |
| `0010_discover` | 内容发现缓存/审计表 `discover_queries`：`id` INTEGER PK、可空 `user_id`、`query_hash`、`query`、`target_lang`（默认 `zh-CN`）、`result`（响应 JSON 文本，不含字幕正文）、`created_at`/`expires_at`（毫秒 UTC），`UNIQUE(query_hash,target_lang)` 24h 缓存键 + `ix_discover_queries_expires`；见 [backend/README「内容发现」](../README.md#内容发现v1-后端) 与 [specs/017](../../specs/017-discover/spec.md) |
| `0011_reading` | 读文章四表：`articles`（用户文章，可空 `source_url` + `ix_articles_user_created` + 部分唯一索引 `ux_articles_user_url` 保证同用户同 URL 一篇）、`article_paragraphs`（PK `article_id,idx`，FK CASCADE）、`article_translations`（PK `article_id,idx,target_lang`，`model` 可空，失败段 `text='[未翻译]'`）、`article_progress`（PK `user_id,article_id`，`paragraph_idx` CHECK ≥0）；见 [backend/README「读文章」](../README.md#读文章v1-后端url正文导入--逐段翻译--进度) 与 [specs/019](../../specs/019-reading/spec.md) |
| `0012_exam` | 考试练习两表：`exam_sessions`（`id` TEXT PK、`user_id`、`exam_type`、`status` CHECK `in_progress`/`submitted`、`item_ids` 卷面 JSON、`started_at/submitted_at/duration_ms`，`(user_id,started_at)`/`(user_id,submitted_at)` 索引 + 部分唯一索引 `ux_exam_sessions_active` 保证同一用户最多一个未提交会话）、`exam_answers`（PK `session_id,item_id`、`chosen_index` 0–3 CHECK、`correct` 0/1 CHECK、`answered_at`，FK → sessions CASCADE；只存已作答的题）；不存题库/分数，见 [backend/README「考试练习」](../README.md#考试练习v2-后端) 与 [specs/022](../../specs/022-exam-practice/spec.md) |
| `0017_behavior_events` | `learning_events` 加可空 `client_event_id` + 部分唯一索引 `ux_learning_events_user_type_client`（`(user_id, event_type, client_event_id) WHERE client_event_id IS NOT NULL`），供 M2 #7 行为埋点幂等；旧行保持 NULL，不 backfill；见 [specs/027](../../specs/027-behavior-events/spec.md) |

## 约定

- **迁移 id 递增**：新迁移用 `--rev-id 0013_xxx`，文件名模板是 `%(rev)s`（Alembic 自动补 `.py`）。
- **基线幂等**：`0001` / `0002` 都用 inspector 判断表/索引是否已存在，所以对已有
  `users`/`sessions` 的旧库直接 `alembic upgrade head` 也安全（不重建、不动数据）。
- **不要对旧库直接 `stamp head`**：会把 `0002`–`0012` 也标记成已应用，`learning_events`、
  `ai_usage` / `ai_quota` / `target_lang` 列、`jobs` 表、复习三表、理解题三表、观看事件/周报快照、定位测三表、发现缓存表、读文章四表、考试练习两表、能力标定三表永远不会被创建。旧库的正确姿势是 `stamp 0001_baseline` → `upgrade head`。
- **`downgrade` 会 DROP 表**（`0001` 的 down 会删 `users`/`sessions`），只用于空库/
  测试回滚，别在真实库上跑。
- **行为埋点幂等键**：`0017` 只给 `learning_events` 加可空 `client_event_id` 与部分唯一索引；`behavior_events.py` 用 `INSERT OR IGNORE` 落库，运行时不改表。表/列/索引缺失时抛 `BehaviorUnavailable`，路由返回 503。详见 [specs/027](../../specs/027-behavior-events/spec.md)。
- **`learning_events` 是 append-only**：迁移只建表和索引，不建触发器；保留期硬删
  （计划书 §8.4，24 个月）留到删除权矩阵落地时再做，届时用独立运维脚本，不进应用代码。
- **复习三表**：`word_states` 是调度真源，`review_logs` append-only（应用层只 INSERT/SELECT），
  `word_sources` 随词删除（FK CASCADE，连接需 `PRAGMA foreign_keys=ON`）。运行时不建表；
  表缺失时 `backend/srs.py` 抛 `ReviewUnavailable`，路由返回 503。详见
  [specs/013](../../specs/013-review-engine/spec.md)。
- **理解题三表**：`content_items` 是「每个用户每条内容」的缓存与配额头；`questions` 每行
  一道题（选项 JSON、答案下标、证据 block + 毫秒时间点）；`attempts` append-only。
  运行时不建表；表缺失时 `backend/quiz.py` 抛 `QuizUnavailable`，路由返回 503。详见
  [specs/014](../../specs/014-quiz/spec.md)。
- **观看事件 + 周报快照**：`watch_events` 也是 append-only（应用层只 INSERT/SELECT），
  `user_id` 对游客存 `guest:<sha256>` 作为归属键，保证 `UNIQUE(user_id,client_event_id)`
  对游客同样幂等；`weekly_reports` 用 `INSERT OR IGNORE` 保留同周首份快照。运行时不建表；
  表缺失时 `backend/reports.py` 抛 `ReportUnavailable`，路由返回 503。详见
  [specs/015](../../specs/015-weekly-report/spec.md)。
- **定位测三表**：`placement_sessions` 只保留状态与最终结果（整卷不落库，按 sessionId
  确定性重算）；`placement_answers` 提交时一次写 32 行、append-only；`user_profiles`
  每个归属键一行，最新一次定位测覆盖（`source` 预留 `user_edit`）。部分唯一索引
  `ux_placement_sessions_active` 保证同一用户最多一个未完成会话，重测靠
  `reset`/提交后新建。运行时不建表；表缺失时 `backend/placement.py` 抛
  `PlacementUnavailable`，路由返回 503。详见 [specs/016](../../specs/016-placement/spec.md)。
- **发现缓存表**：`discover_queries` 按 `UNIQUE(query_hash,target_lang)` 保存 24h 的响应
  JSON 与检索词审计；`user_id` 可空、只作审计，不参与缓存键（跨用户复用，但
  `alreadyProcessed` 每次按当前用户重算）。不存字幕正文/视频文件。运行时不建表；
  表缺失时 `backend/discover.py` 的缓存读写降级为未命中/不写（只告警一次），发现
  请求仍可用；上线前需 `alembic upgrade head`。详见 [specs/017](../../specs/017-discover/spec.md)。
- **能力标定 M1**：`0014_ability` 建 `user_skill_profiles`（每用户每技能当前值，
  PK `(user_id, skill)`；`self_report` 行 CEFR 三列必须为 NULL）与 `skill_evidence`
  （append-only，`UNIQUE(user_id, evidence_type, source_key)` 幂等），并加
  `placement_answers.elapsed_ms`；同时把旧 `user_profiles.vocab_estimate` seed 成
  vocabulary 行（`status='uncalibrated'`、confidence cap 0.85），`reading_estimate`
  不建行。`0015_assessment_sessions` 建自评/后续测试会话（`client_request_id` 幂等、
  同用户同类最多一个 `in_progress`）。M1 代码断言 `status='measured'` 不可达。
  详见 [specs/025](../../specs/025-ability/spec.md)。
- 新增表一律写在这里，**不要**再往 `auth_db.py` 的 `_init_schema` 里加 `CREATE TABLE`。
