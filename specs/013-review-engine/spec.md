# 规格：词状态与 FSRS 复习引擎（后端）

**状态：** 已实现（2026-11-15，M2 后端；前端复习 UI 下一轮）｜ **对应代码：** `backend/srs.py`、`backend/routes_review.py`、`backend/migrations/versions/0006_review_engine.py`、`backend/tests/test_review_engine.py`

> 计划书 §13.2 M2 的第一块：把「收藏夹」从「存一条记录」升级为**可调度的记忆系统**。
> 本规格只冻结**后端契约**：词状态、到期队列、复习作答、暂停/恢复、统计。
> 4 种卡面、TTS、复习页交互与收藏夹迁移到词状态的界面流程在下一轮实现。

> **v1.1 任务 9 增补（2026-11-21，已实现）**：新增 `GET /api/review/suspended`
> 暂停词列表端点；复习页补「暂停中 N 个词 → 恢复」入口；语言口径与
> `/api/review/stats` 对齐。对应代码：`backend/routes_review.py`、`backend/srs.py`、
> `frontend/src/components/ReviewScreen.tsx`、`frontend/src/lib/review.ts`、
> `frontend/src/lib/api.ts`。

---

## 目标

- **G1 状态在服务端**：每个词有 FSRS 参数、当前状态与到期时间；换设备登录后队列一致，不依赖 localStorage。
- **G2 调度可复现**：同一份状态 + 同一评分 + 同一时刻 → 同一结果；测试注入时钟，不读真实时间。
- **G3 队列可解释**：返回「到期词」与「新词」两类，各自有上限；排序稳定，跨用户严格隔离。
- **G4 失败可止损**：连续 3 次 `again` 自动 suspend，不无限耗复习耐心；用户可手工恢复。
- **G5 全离线可验**：不联网、不调 LLM；释义由前端后续调 `/api/define` 获取。

## 非目标

- 不做前端复习 UI、4 卡面、TTS、听写（下一轮 / M3）。
- 不迁移 `favorites.json` 存量收藏到 `word_states`（下一轮随前端一起做）。
- 不做每日新词/复习总量的服务端硬上限（当前用 `limit` + `newLimit` 控制返回量；长期上限待教研定）。
- 不做多设备实时推送/冲突合并：同一账号后写覆盖先写，服务端状态是唯一真源。
- 不做时区展示：库里一律毫秒 UTC，前端按用户本地时区展示。

---

## 数据模型（迁移 `0006_review_engine`）

### `word_states`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | uuid4 hex |
| `user_id` | TEXT NOT NULL | 归属用户 |
| `lemma` | TEXT NOT NULL | 词条；NFC + 小写规范化后存储 |
| `target_lang` | TEXT NOT NULL DEFAULT `zh-CN` | 与 i18n 口径一致 |
| `state` | TEXT NOT NULL | `new` / `learning` / `review` / `relearning` / `suspended`（CHECK） |
| `due_at` | INTEGER NOT NULL | 下次到期，毫秒 UTC |
| `stability` / `difficulty` | REAL NULL | FSRS-6 参数；`new` 时为空 |
| `reps` / `lapses` | INTEGER NOT NULL DEFAULT 0 | 总复习次数 / 累计 `again` 次数 |
| `step` | INTEGER NOT NULL DEFAULT 0 | **内部列**：FSRS 学习/重学子日 step |
| `fail_streak` | INTEGER NOT NULL DEFAULT 0 | **内部列**：连续 `again` 次数 |
| `last_reviewed_at` | INTEGER NULL | 上次复习，毫秒 UTC |
| `created_at` | INTEGER NOT NULL | 入词时间，毫秒 UTC |

- `UNIQUE(user_id, lemma, target_lang)`：同用户同语言同一个词只有一条状态。
- `INDEX (user_id, due_at)`：到期队列主查询路径。

#### 已掌握（v1.1 任务 2，迁移 `0027_review_mastered`）

- 新增列 `mastered INTEGER NOT NULL DEFAULT 0`（0/1），用 `ALTER TABLE ... ADD COLUMN`，**不重建表**。
- `mastered` 是词状态之上的标记，**不是新的 `state` 值**（不改 `state` CHECK）；FSRS 字段照旧保留。
- `mastered=1` 的词**不进队列、不计 `newWords`/`dueToday`**，也不参与连续天数；统计新增 `masteredWords`。
- 撤销已掌握不重置 FSRS 参数；同一词再次「加入复习」时强制 `mastered=0`。

### `review_logs`

`id`（自增 PK）、`user_id`、`lemma`、`target_lang`、`rating`（`again`/`hard`/`good`/`easy`，CHECK）、`state_before` / `state_after`（JSON 文本快照）、`reviewed_at`（毫秒 UTC）、`elapsed_ms`（可空）。
索引：`(user_id, reviewed_at)`。追加写，不提供修改/删除入口。

### `word_sources`

`word_state_id`（FK → `word_states.id`，ON DELETE CASCADE）、`content_ref`（videoId / 剧集 / 文章）、`sentence_id`、`created_at`。索引 `word_state_id`。
一个词可来自多处；同一来源重复添加幂等去重。

---

## 调度规则

- 依赖 **PyPI `fsrs` 6.3.3**（FSRS-6），目标保持率 **0.9**，关闭 fuzz → 结果确定。
  该包已验证可用（`requirements.txt` 固定版本），因此**不启用** SM-2 兼容降级：
  缺包时 `srs` 抛 `ReviewUnavailable`，端点返回 503 并提示安装依赖，不会静默换算法导致调度口径漂移。
- 新词 = `new`、`reps=0`；首次作答后进入 `learning` 或 `review`。学习步长沿用 FSRS 默认（1 分钟 / 10 分钟），重学步长 10 分钟。
- 每次作答：`reps+1`；`again` 时 `lapses+1`、`fail_streak+1`，其他评分把 `fail_streak` 清零。
- `fail_streak >= 3` → 自动 `suspended`（仍写当次日志，便于审计）。
- 手工 suspend / restore 都幂等；restore 把状态放回 `review`（`reps=0` 时回 `new`）、`due_at=now`、`fail_streak=0`，保留 FSRS 参数。
- `suspended` 的词不出现在队列里，作答返回 **409**，需先恢复。

## API 契约

全部端点**需登录**；游客/未登录返回 **403**。`targetLang` 缺省 `zh-CN`，非法代码 **400**。时间均为毫秒 UTC。

| 端点 | 请求 | 成功 |
|---|---|---|
| `POST /api/review/words` | `{lemma, targetLang?, source?}`；`source` 可含 `contentRef`/`sentenceId`（也接受 snake_case） | `201 {"status":"ok","created":true,"word":{…}}`；已存在 `200 created:false`，**不重置进度** |
| `GET /api/review/queue?limit=20&newLimit=10&targetLang=zh-CN` | `limit` 1–100（总条数上限）；`newLimit` 0–100 | `200 {targetLang, now, items, due, new, counts}`；`due` 按 `due_at` 升序，`new` 按 `created_at` 升序；`items = due + new` |
| `POST /api/review/answer` | `{lemma, rating, targetLang?, elapsedMs?}` | `200 {status:"ok", word, suspended, autoSuspended}`；词不存在 **404**，已暂停 **409**，评分非法 **400** |
| `GET /api/review/stats?targetLang=` | 省略 `targetLang` = 全部语言 | `200 {targetLang, now, today, dueToday, dueNow, reviewedToday, reviewedWordsToday, newWords, newToday, totalWords, suspendedWords, streakDays}`；「今日」按 UTC 日界 |
| `GET /api/review/suspended?limit=100&targetLang=` | `limit` 1–200（默认 100）；省略 `targetLang` = 全部语言 | `200 {targetLang, now, total, words:[word…]}`；按 `COALESCE(last_reviewed_at, created_at)` 倒序、`id` 兜底；`total` 为不分页总数 |
| `PATCH /api/review/words` | `{lemma, targetLang?, mastered: boolean, source?}` | `200 {status:"ok", word}`；词不存在则创建（等价 POST），已存在只改 `mastered`，幂等；`mastered=true` 时同时把词从队列移出 |
| `POST /api/review/suspend` | `{lemma, targetLang?}` | `200 {status:"ok", suspended:true, word}`；不存在 **404**；重复调用幂等 |
| `DELETE /api/review/suspend?lemma=&targetLang=`（也接受 JSON body） | — | `200 {status:"ok", suspended:false, word}`；不存在 **404** |

`word` 形状：`{id, lemma, targetLang, state, dueAt, stability, difficulty, reps, lapses, failStreak, lastReviewedAt, createdAt, sources:[{contentRef,sentenceId,createdAt}]}`。
队列项额外带 `sources`，不返回释义（前端需要时再调 `/api/define`，语言由 `targetLang` 决定）。

错误语义：数据库未跑 `0006` 迁移时返回 **503**（`detail` 提示先 `alembic upgrade head`），不静默 500。

### 加入复习入口（v1.1 任务 9）

- **入口**：词条浮层（主入口）与单词本收藏行（次入口）都调用 `POST /api/review/words`，
  带来源 `source.contentRef` / `source.sentenceId`（收藏里已有的 `meta.source_*` 直接映射）。
- **交互**：点击即请求，成功 toast「已加入复习」；重复点击幂等（`created:false` 不报错）；
  失败内联提示可重试；请求中禁用按钮。视频页与阅读页的词条浮层用同一按钮与文案。
- **文案**：按钮「加入复习」/「已在复习」，不出现「已掌握」以外的能力承诺。

### 暂停词列表与恢复（v1.1 任务 9）

- **列表**：`GET /api/review/suspended` 只返回 `state='suspended'` 的词（自动或手工暂停），
  `targetLang` 缺省 = 全部语言、给定则校验并过滤；`limit` 默认 100、上限 200。
  响应 `total` 是过滤后的总数（不受 `limit` 影响），`words` 复用公开 `word` 形状。
- **恢复**：沿用既有 `DELETE /api/review/suspend?lemma=&targetLang=`；恢复后
  `state` 回 `review`（`reps=0` 时回 `new`）、`due_at=now`、`fail_streak=0`；
  `reps>0` 保留 stability/difficulty，`reps=0` 的 new 行清空 FSRS 参数。
- **前端入口**：复习页仅在「今日复习完成 / 今天没有要复习的词」的空态显示
  「暂停中 N 个词」按钮，条件是 `stats.suspendedWords > 0`；点开 `Dialog`
  逐行列出 `lemma`、`targetLang`、`failStreak`，每行「恢复」。
- **恢复交互**：恢复请求带该行自己的 `targetLang`；成功后移除该行并把
  `stats.suspendedWords` 减 1（不重拉统计）；失败在对话框内联错误，可重试；
  恢复进行中禁用所有恢复按钮，避免重复提交。
- **语言口径**：`/api/review/suspended` 已加入前端 `TARGET_LANG_QUERY_PATHS`
  白名单，`apiFetch` 总是带当前 `targetLang`，因此「暂停中 N 个」的计数与
  列表严格同口径（不会出现跨语言列表对不上计数）。端点本身仍保留「省略 =
  全部语言」的后端语义，供直接调用方使用。

## 验收

- [x] 迁移 `upgrade head` 建三表/索引/唯一约束/CHECK；`downgrade` 可回滚到 `0005` 再升级。
- [x] FSRS 调度确定性：同输入同 now 结果一致；四档评分首次间隔 `again < hard < good < easy`。
- [x] 连续 3 次 `again` 自动 suspend；手工恢复后可继续，恢复记录清零失败计数。
- [x] `add_word` 幂等：重复添加不重置 `reps` / `due_at`，但可补充新来源。
- [x] 队列跨用户隔离、`targetLang` 过滤、稳定排序、`limit` 与 `newLimit` 生效。
- [x] 统计：今日到期/今日已复习/新词/连续天数；跨日注入时钟可复现。
- [x] （v1.1 任务 9）`GET /api/review/suspended`：省略 `targetLang` 覆盖全部语言、给定则过滤；
  `limit` 默认 100/上限 200；`total` 为过滤后总数；按最近更新倒序。
- [x] （v1.1 任务 9）复习页暂停词恢复：空态入口、逐行恢复、成功后计数同步、
  失败可重试；恢复后失败计数清零并回到队列。
- [x] 游客 403；现有 284 个后端测试保持全绿。

- [x] 队列排除 `mastered=1`；`stats.masteredWords` 与「已掌握」列表数量一致。
- [x] `PATCH /api/review/words` 幂等：同词两次 `mastered=true` 只一条行；`mastered=false` 可撤销。
- [x] 加词入口：词条浮层与收藏行都能加词并带来源；重复点击不重复建行；失败可重试。

## 测试

```bash
cd backend
venv/bin/python -m py_compile *.py
venv/bin/python -m pytest tests/test_review_engine.py -q
venv/bin/python -m pytest tests -q
```

## 后续（下一轮）

- 前端 `features/review/`：单卡全屏、1–4 键、Undo、四卡面、语境句、TTS。
- `favorites.json` → `word_states` 的一次性迁移 + 去重；收藏语义从「记录」改为「建档」。
- 每日新词/复习配额、积压保护与「明天预计 M」的跨日预测。
- 复习事件接入 `learning_events`（`word_review`）与周报。
