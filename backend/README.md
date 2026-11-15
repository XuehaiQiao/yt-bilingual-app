# backend/ — FastAPI 后端

启动：`source venv/bin/activate && uvicorn main:app --port 8000`（入口永远是 `main:app`）。
验证：`venv/bin/python -m py_compile *.py`；离线测试：`venv/bin/python -m pytest tests -q`（测试全程离线、不联网）。环境变量见 [开发指南](../docs/开发指南.md)。

> **翻译目标语言（P0）**：`/api/estimate-cost`、`/api/process-video`、`/api/process-video-stream`、`/api/define`、`/api/process-subtitle` 接受可选 `targetLang`（`zh-CN` 默认 / `vi-VN`）；不带参数 = 中文，旧行为不变。缓存按语言分目录（`history/` 根目录 = zh-CN 兼容位、`history/vi-VN/` = 越南语），模型按语言路线选择。详见下文「多语言目标语言」与 [specs/012](../specs/012-i18n-multilingual/spec.md)。

> **默认模型是 `deepseek-chat`**（DeepSeek，国内可直连，大陆首发商用默认）；Gemini 三档保留在 `MODEL_CATALOG` 里作为**海外可选**（大陆不可用/不合规）。默认模型可用环境变量 `DEFAULT_MODEL` 覆盖（必须是目录里的 id，非法值回落 `deepseek-chat`），`/api/models` 的 `default` 字段与 `resolve_model(None)` 都跟随它。

## 文件说明

| 文件 | 职责 |
|---|---|
| `main.py` | 应用装配：CORS、可选 `X-API-Key` 部署闸门、身份中间件（会话 → 登录用户；否则 `ln_guest` → 隔离游客目录，首次访问下发 Cookie；含 429 限速、封禁账号 403、维护模式 503）、结构化访问日志（request_id + 一行 JSON）、挂载路由模块、`/health`（存活）与 `/healthz`（就绪：DB/迁移/版本）。**不放业务逻辑** |
| `observability.py` | 可观测性（M1c）：`JsonFormatter`、请求级 `request_id` ContextVar、访问日志中间件（只记 method/path/status/duration_ms/request_id/user_id，**不记 query/body/header**）、未处理异常兜底（带 request_id + 堆栈）、只读 `/healthz` 快照（SQLite `mode=ro` + Alembic `ScriptDirectory`/`MigrationContext`） |
| `config.py` | 所有配置：`.env` 加载、数据目录（HISTORY/SUBTITLES/SENTENCES/PLACEMENT/DATA/USER_DATA/AUTH_DB）、安全开关（`CORS_ORIGINS` / `API_AUTH_KEY` / `BROWSER_UI` / `COOKIE_SECURE`）、安全最小集（`RATE_LIMIT_*` / `AUTH_LOCK_*` / `LLM_MAX_CONCURRENCY` / `PREFETCH_CACHE_*` / `FETCH_TIMEOUT_SECONDS` / `MAX_TRANSCRIPT_BLOCKS` / `MAX_FETCH_BYTES` / `MAX_CHANNEL_VIDEOS` / `DISCOVER_*` / `READING_*` / `AI_DAILY_QUOTA_READING_BATCHES` / `RATE_LIMIT_READING_PER_MINUTE`）、SSE 心跳间隔（`SSE_HEARTBEAT_SECONDS`）、可观测性（`APP_VERSION` / `LOG_LEVEL` / `LOG_JSON`）、`MODEL_CATALOG`（可选模型清单：provider / 端点 / Key 环境变量 / 价格 / 批间节奏；Gemini 三档标注为仅海外；Qwen 走 `base_url_env`）、`DEFAULT_MODEL`（全局兜底，默认 `deepseek-chat`）、`TARGET_LANG_MODEL_ROUTES`（按目标语言的模型路线，`MODEL_ROUTE_ZH_CN` / `MODEL_ROUTE_VI_VN` 可覆盖）、`DEFAULT_MODEL_ZH_CN` / `DEFAULT_MODEL_VI_VN`、`resolve_model`（未知/缺省 → 全局默认）、`VOCAB_LEVELS`（词汇水平→prompt 描述）、`CURATED_CONTENT_PATH`（人工精选推荐池，默认 `content/curated.json`）、`BLOG_DIR`（官方博客 Markdown 目录，默认 `content/blog`）、`ADMIN_EMAILS`（后台管理员邮箱，逗号分隔、大小写不敏感，默认空 = 无管理员） |
| `languages.py` | **目标语言注册表（P0）**：`zh-CN` / `vi-VN` 的 prompt 语言名、展示名、本地词典开关；`resolve_target_lang()` 缺省 zh-CN、非法抛 `UnsupportedLanguage`（路由转 400）；`normalize()` 做 NFC（越南语组合字符比较/缓存键）；新增语言只改这里 + `config.TARGET_LANG_MODEL_ROUTES` |
| `auth_db.py` | 用户与会话 SQLite：建表/补列、Argon2id 密码哈希/校验、会话 token（库里只存 sha256）、过期清理、登录失败常量时间处理。`users` 自 0013 起带 `username` / `credits` / `status`；`users`/`sessions` 的建表是**兼容路径**，新表一律走 Alembic |
| `account.py` | 账号资料与运营设置（specs/023）：用户名 2–24 字符校验、`PATCH /api/user/profile` 的落库、余额原子调账（`BEGIN IMMEDIATE` + `credit_transactions` 流水、不允许负余额）、封禁/解封规则（不能封自己/最后一个管理员）、`app_settings` 读写与**维护模式 5 秒进程内缓存**、用户页摘要（本月 AI 花费 / 今日分钟 / 版本） |
| `events.py` | 学习事件日志（append-only）：`emit_event()` 单条追加（失败只记日志、不阻断主流程）、`query_events()` 只读查询（仅开发/测试，不挂 HTTP 端点）、`pseudonym_for()` 假名化、`schema_status()` 迁移自检。**只有 INSERT/SELECT** |
| `jobs.py` | 任务表 `jobs` 的读写层 + 单进程执行互斥（M1 ⑤）：`create_or_reuse`（同 user+kind+content_ref+targetLang 的未完成 job 复用，进程内锁 + 部分唯一索引兜底幂等）、`get`、`update_progress/mark_running/mark_done/mark_failed/settle_interrupted`（cursor 只增不减）、`try_acquire/release/is_active`（同一 job 同时只允许一条流生成，第二个请求 409/SSE error，杜绝重复付费）。表缺失（旧库没跑 0005）时全部降级为 no-op，只告警一次，视频处理照常 |
| `ai/ledger.py` + `ai/quota.py` | AI 成本账本与配额（M1b）：`ai_usage` 只追加记账（价格未知按已知最贵、失败不阻断）、`ai_quota` 原子日配额（UPSERT）、三层预算硬闸、模型降级链（同 provider 更便宜 → 另一个可用 provider，大陆不含 Gemini）。功能枚举 `translate` / `summary` / `define` / `local_show` / `quiz`。账本/配额接受 `target_lang`：`ai_usage.target_lang` 记录维度（0004 迁移，缺省 zh-CN，旧库无列时退化为不带列写入），`ai_quota` **不按语言拆限额** |
| `routes_auth.py` | `/api/auth/signup`（`username` 必填/旧客户端回落 email 前缀）、`/api/auth/login`（封禁账号 403）、`/api/auth/logout`、`/api/auth/me`（user 带 username/credits/status；游客返回 `{user:null,guest:true}`）、`/api/auth/claim-guest`（登录后幂等认领游客数据）；`ln_session` Cookie、登录失败短窗限流与 `auth_lockout` 接入（锁定统一 429 + `Retry-After`） |
| `routes_account.py` | 用户页数据（specs/023）：`PATCH /api/user/profile`（改用户名）、`GET /api/user/summary`（用户信息/余额/本月花费/今日分钟/版本）；均需登录，游客 403 |
| `guest.py` | 游客态（M1 ⑧）：32 字节随机 `ln_guest` Cookie（服务端只存 sha256）、`data/guests/<sha256>/` 隔离目录、游客累计试译上限、登录后把 `history/` / `favorites.json` / `subscriptions.json` 幂等合并到用户目录（同 videoId / 同收藏指纹 / 同订阅键去重，用户数据优先）。**不建表、不新增迁移** |
| `storage.py` | 当前请求的数据根目录：登录用户 → `data/users/<user_id>/`；游客 → `data/guests/<sha256(ln_guest)>/`；两者都没有（脚本/测试）→ 回落 `config.HISTORY_DIR`。`history_dir(target_lang)` / `dictionary_cache_file(target_lang)` 是语言路径的**唯一入口**：`zh-CN`（缺省）→ `history/` 根目录，其他语言 → `history/<code>/`；所有用户数据路径必须从这里取。`favorites_file()` / `favorites_tombstones_file()` 是收藏主文件与删除墓碑的**唯一入口**（按用户隔离、不按语言分文件） |
| `llm.py` | 统一大模型调用层：按 `MODEL_CATALOG` 的 `kind` 分派「Google 官方 SDK」或「OpenAI 兼容 `<base_url>/chat/completions`」；端点支持 `base_url` 或 `base_url_env`（Qwen 等区域端点由环境变量给，不写死）。`is_available` 同时检查 Key 与必需端点；`resolve_model_for_target(requested, target_lang)` 按「用户选择 → 该语言首选 → 该语言路线 → 全局默认 → 目录首个可用」解析，未配 Key 的候选自动跳过。**SDK 调用是同步阻塞的**：async 代码必须用 `generate_json_async` / `generate_text_async`（内含全局并发闸 + `asyncio.to_thread`）；同步 `generate()` 只给脚本/测试。`concurrency_snapshot()` 暴露并发闸峰值/等待直方图。`usage_scope(feature, user_id, target_lang=…)` 声明调用归属后，成功调用会按 provider usage 写进 `ai_usage`（签名不变，`AI_USAGE_LOGGING=0` 可关） |
| `ratelimit.py` | 进程内固定窗口限速（M1 ⑦）：注册/登录按 IP、估价/处理/查词/发现按用户；游客（M1 ⑧）同桶但更紧上限、键为 `guest:<sha256>`；超限 429 + `Retry-After`；不依赖 Redis。桶与上限见下文「安全最小集」 |
| `auth_lockout.py` | 登录失败锁定（M1 ⑦ 残余项）：账号 + IP 双维度连续失败锁定；锁定期间正确密码也 429 + `Retry-After`；成功登录清零；只存进程内存与邮箱哈希，不存明文 |
| `transcripts.py` | 拿到"待翻译的句子"：YouTube 字幕抓取（失败→清晰中文错误）、切句算法、SRT/VTT 解析、yt-dlp 元数据、Whisper 本地转写兜底（可选依赖）。字幕抓取先 `list()` 探测轨道（手动 en 优先，其次自动生成的 en/en-US/en-GB/en-orig 等前缀码），API 失败再用 yt-dlp 下载自动字幕 VTT 回退；返回值带 `subtitle_source` / `auto_generated`。抓取带超时 / 响应体大小 / 字幕块数上限（`_BoundedSession`，M1 ⑦ 残余项）；这些函数是同步阻塞实现，async 调用方负责放进线程 |
| `translate.py` | AI 翻译核心：`process_llm_batch`（大模型批翻 + **按 id 对齐**防错位 + 按水平挑生词 + 高亮子串/NFC 校验 + 越南语 CJK 泄漏重试）、`UNTRANSLATED_MARKER` 自愈约定、`retranslate_marked_blocks`（补译）、`_stream_translate`（逐批落盘的流式生成器）、视频总结。prompt 里的语言名来自 `languages`（不再硬编码 "Chinese"）；JSON 字段名 `zh_text`/`zh_word` 保持 P0 兼容、值为目标语言。LLM 生成调用经 `llm.generate_json_async` / `generate_text_async`（全局并发闸 + 线程）执行，异常仍照常抛回；批间 `batch_pause` 语义不变；翻译/总结带日配额与降级链，`feature` / `user_id` / `target_lang` 缺省取请求上下文（本地剧集传 `local_show`） |
| `routes_videos.py` | `/api/models`（全局模型栏数据源；`targetLang` → `targetLang`/`recommended`）、`/api/estimate-cost`、`/api/process-video`（经典，移动端用）、`/api/process-video-stream`（SSE，产品核心；事件带 `targetLang`，`meta` 另带 `sourceLang`/`promptVersion`；流内慢任务期间按 `SSE_HEARTBEAT_INTERVAL`（默认 15s）发 `: ping` 注释行心跳；`jobId`/`from` 可从游标续传，POST body 与 GET query 等价）、`/api/jobs/{id}`（任务状态/进度/`canResume`，见下文「任务表与断线续传」）、`/api/history*`（按 `targetLang` 只读写对应语言目录；本地剧集缓存按 `episodes.json` 补 `youtube_video_id`）、`/api/channel-updates`（yt-dlp 频道拉取，先过 YouTube 频道 URL 白名单，放线程并发、最多 8 个；单频道硬上限 `MAX_CHANNEL_VIDEOS=200`） |
| `routes_content.py` | `/api/shows*`、`/api/process-subtitle`（本地剧集：`targetLang` 决定缓存目录/prompt/模型路线；翻译与补译跟随请求 `model`，新处理结果与缓存 payload 记录 `model` 和 `target_lang`，批间隔按 `llm.batch_pause(model)`；非中文不写中文固定集名标签，改为 `summary_kind="episode_label"` + 季/集/标题结构化字段；有视频映射的集在 `metadata` 补 `youtube_video_id` / `youtube_title`）、`/api/shows/{id}/processed?targetLang=`、`/api/sentences*`（句子精背） |
| `local_shows.py` | 本地剧集 → YouTube 视频映射：`episode_video_map(show_id)` / `lookup_episode_video(show_id, season, episode)` 读取 `subtitles/<show_id>/episodes.json`；缺失/损坏一律降级为无映射并打日志，路径限制在 `SUBTITLES_DIR` 内 |
| `local_dict.py` | 本地离线词典（可选）：`lookup()` 查 `data/ecdict.db`（ECDICT）并映射成 `/api/define` 字段（含多义项 `senses`，`definition` 按词性对齐补英文释义）；惰性只读 sqlite，数据缺失/损坏一律返回 `None`，调用方回落大模型 |
| `routes_user.py` | `/api/define`（词典：`targetLang` 决定缓存目录与 prompt 语言；语境缓存 → 本地 ECDICT（**仅 zh-CN**）→「已配 Key 的候选模型」；vi-VN 跳过 ECDICT 直接 LLM，只有 DeepSeek Key 也能查；缺省 `model` 时 zh 候选链首选 `DEFAULT_MODEL`、其他语言首选该语言路线；走 LLM 的响应带实际使用的 `model` / `modelName`，本地命中带 `source: local`；响应带 `targetLang`，可选 `pos_label` / `example_translation`；模型结果写按语言隔离的缓存并带 `senses`，旧缓存读取时自动补全）、`/api/favorites`（M1 ④ 按条 API：POST/GET/DELETE + 旧 PUT 兼容 + `?since=` 增量；文件锁 + 原子写，见下文「收藏按条 API」）、`/api/subscriptions`；`/api/define` 先扣词典日配额，超限返回 **429** |
| `srs.py` | **复习调度与词状态读写（M2）**：`review(word_state, rating, now)` 纯函数走 FSRS-6（PyPI `fsrs` 6.3.3，目标保持率 0.9、关闭 fuzz 保证确定性）；`add_word` 幂等建词（重复添加不重置进度，只补来源）；`get_due` 到期词 + 新词队列；`record_answer` 同一事务更新状态并追加 `review_logs` 快照；连续 3 次 `again` 自动 suspend，`set_suspended` 手工暂停/恢复；`get_stats` 今日到期/已复习/新词/连续天数。表由 `0006_review_engine` 创建，运行时不建表；时间全部毫秒 UTC |
| `routes_review.py` | 复习引擎 HTTP 路由（**需登录，游客 403**）：`POST /api/review/words`、`GET /api/review/queue`、`POST /api/review/answer`、`GET /api/review/stats`、`POST/DELETE /api/review/suspend`；契约与错误语义见下文「复习引擎」与 [specs/013](../specs/013-review-engine/spec.md) |
| `quiz.py` | **理解题生成与作答（M3）**：读当前用户已有双语字幕缓存（video / local_show，≥8 句）→ 按 `(content_hash, prompt_version)` 缓存出 3 道题 → 两道闸（结构：mcq 4 选 1 / tf 判断；内容：英文题面不混中文、题目与证据句相关）→ 写 `content_items` / `questions` / `attempts` → 返回证据 block 与秒/毫秒时间点；失败重试 1 次，仍失败该题 `rejected`；表由 `0007_quiz` 创建，运行时不建表；作答写 `learning_events(quiz_answer)` |
| `routes_quiz.py` | 理解题 HTTP 路由（**需登录，游客 403**）：`POST /api/lesson/start`、`GET /api/lesson/{id}/questions`、`POST /api/lesson/answer`、`GET /api/lesson/{id}/result`；契约与错误语义见下文「理解题」与 [specs/014](../specs/014-quiz/spec.md) |
| `reports.py` | **观看事件 + 周报聚合（M5）**：`record_watch_events` 批量写 `watch_events`（`UNIQUE(user_id, client_event_id)` 幂等，游客归属 `guest:<sha256>`，0–86400 秒与未来 5 分钟校验）；`week_report` 用 SQL 算 UTC 周「被动学习分钟 / 复习词数 / 理解题正确率」、规则生成事实与下一步、取错题证据或最近观看的 5 秒窗口、算连续学习天数，并把首份结果写 `weekly_reports` 快照（同周不覆盖）；表由 `0008_weekly_report` 创建，运行时不建表；不调用模型 |
| `routes_events.py` | 学习事件与周报 HTTP 路由（**游客可用**）：`POST /api/events`、`GET /api/report/week`；契约与错误语义见下文「学习事件上报与周报」与 [specs/015](../specs/015-weekly-report/spec.md) |
| `placement.py` | **能力定位测（M4）**：读 `content/placement/` 三份静态题库（30 词汇 + 5 阅读 + 4 伪词，校验草稿标记/选项/正确项）；按 sessionId 确定性抽 24+3+5 并打乱（银行 id 不外发）；加权评分（A1=0.5…C1=2.5）、CEFR 点估计 ±1 带、置信度（完成度 + 用时 − 伪词过度声称）、强弱项与 1 条规则建议；写 `placement_sessions` / `placement_answers` 并 upsert `user_profiles`；同一会话重复提交幂等；`start` 复用未完成会话；表由 `0009_placement` 创建，运行时不建表；不调用模型 |
| `routes_placement.py` | 能力定位测 HTTP 路由（**游客可用**）：`GET /api/placement/start`、`POST /api/placement/submit`、`GET /api/placement/profile`、`POST /api/placement/reset`；契约与错误语义见下文「能力定位测与能力画像」与 [specs/016](../specs/016-placement/spec.md) |
| `exam.py` | **考试练习（V2）**：读 `content/exam/cet4.json`（30 道自编题：15 词汇 + 5 语法 + 10 阅读；校验草稿标记/选项/正确项/短文归属）；每次按 sessionId 确定性抽 10 题（词汇 5 + 语法 2 + 阅读 3）并打乱，卷面不含答案；`start` 复用未提交会话；`submit` 只存已答题并对错/答案/解析/未答标记，重复提交幂等；`history` 只给日期/题型/正确数/总数；写 `exam_start` / `exam_submit` 事件；表由 `0012_exam` 创建，运行时不建表；不调用模型、不报分 |
| `routes_exam.py` | 考试练习 HTTP 路由（**需登录，游客 403**）：`GET /api/exam/types`、`POST /api/exam/start`、`POST /api/exam/submit`、`GET /api/exam/history`；契约与错误语义见下文「考试练习」与 [specs/022](../specs/022-exam-practice/spec.md) |
| `discover.py` | **内容发现（V1）**：LLM 意图改写（2–3 个英文检索词，JSON 容错/降级原 query）→ yt-dlp `ytsearchN:` 并发搜索（≤3，单 query 8 条、失败不拖垮整体）→ 跨 query 去重 + 直播/90s–90min 过滤 → `youtube-transcript-api.list()` 并发探测英文字幕（≤4、2s，失败标 unknown 不误杀）→ LLM 重排 3–5 个（A1–C1 + 中文一句理由；失败规则排序 + 模板理由）→ `discover_queries` 24h 缓存。只读公开元数据/轨道列表，不下载、不存字幕正文；总预算 20s |
| `routes_discover.py` | 内容发现 HTTP 路由：`POST /api/discover`（**需登录，游客 403**；5 次/分钟/用户）；契约/错误语义见下文「内容发现」与 [specs/017](../specs/017-discover/spec.md) |
| `recommend.py` | **规则推荐（V1）**：读 `content/curated.json`（30 条人工精选）+ 登录用户 `user_profiles` 的 CEFR 区间（无画像默认 A2–B1）+ 当前身份 history 缓存；按 band±1、主题轮转、新鲜度、已看排除排序，生成中文/越语一句理由；不调用 LLM、不联网、不建表；10 分钟进程内缓存 |
| `routes_recommend.py` | 规则推荐 HTTP 路由：`GET /api/recommendations?limit=6&targetLang=zh-CN&seed=0`（游客可用）；契约/错误语义见下文「规则推荐」与 [specs/018](../specs/018-recommendations/spec.md) |
| `reading.py` | **读文章（V1）**：URL 导入（SSRF 校验 + 10s/2MB/重定向 ≤3）或粘贴正文 → `trafilatura` → readability → 标准库 `<p>` 三级抽取 → 200 段/单段 4000 字符上限 → `articles` / `article_paragraphs`；逐段翻译（`feature=reading` 配额/账本/降级链，只补缺失段，失败写 `[未翻译]`）；进度/列表/删除；表由 `0011_reading` 创建，运行时不建表 |
| `routes_reading.py` | 读文章 HTTP 路由（**需登录，游客 403**）：`POST /api/article/import`、`POST /api/article/{id}/translate`、`GET /api/article/{id}`、`GET /api/articles`、`DELETE /api/article/{id}`、`PUT /api/article/{id}/progress`；契约/错误语义见下文「读文章」与 [specs/019](../specs/019-reading/spec.md) |
| `routes_blog.py` | 官方博客 HTTP 路由（**公开只读，无需登录**）：`GET /api/blog/posts`、`GET /api/blog/posts/{slug}`、`GET /api/blog/feed.xml`；只读 `content/blog/*.md`，自带 front matter 校验、HTML 转义 + 链接白名单的轻量 Markdown 渲染、RSS 2.0；无数据库/无迁移；见下文「官方博客」与 [specs/020](../specs/020-blog/spec.md) |
| `routes_library.py` | 本地免费资源库 HTTP 路由（**公开只读，无需登录**）：`GET /api/library`、`GET /api/library/videos/{id}`、`GET /api/library/articles/{id}`；只读 `content/library/*.json`（预生成双语字幕块 + 原创双语短文），不连数据库、不 import `llm`、不写状态；未知/缺失 404、内容损坏 503；见 [specs/024](../specs/024-free-library/spec.md) 与 `content/library/README.md` |
| `routes_admin.py` | 后台管理 HTTP 路由（**需登录 + 管理员**）：只读止血台（M1 ⑥：`GET /api/admin/stats`、`/users`、`/usage`、`/health`，连接 `PRAGMA query_only=ON`）+ 运营写操作（specs/023：`POST /users/{id}/credits`、`PATCH /users/{id}`、`GET/PUT /settings`）；管理员由 `config.ADMIN_EMAILS` 决定；限速 30 次/分钟 |
| `requirements.txt` | Python 依赖（`argon2-cffi` 用于密码哈希、`alembic` 用于数据库迁移、`fsrs==6.3.3` 用于 FSRS-6 复习调度、`trafilatura` 用于文章正文抽取、`pytest` 用于离线测试/CI；faster-whisper、readability-lxml/bs4 为可选，见文件内注释） |
| `alembic.ini` / `migrations/` | 数据库迁移：`migrations/versions/0001_baseline.py`（users/sessions）、`0002_learning_events.py`（事件表）、`0003_cost_ledger.py`（`ai_usage` / `ai_quota`）、`0004_target_lang.py`（`ai_usage.target_lang`，可空、默认 zh-CN、不改旧数据）、`0005_jobs.py`（任务表 `jobs` + 用户/时间索引 + 未完成任务的部分唯一索引）、`0006_review_engine.py`（`word_states` / `review_logs` / `word_sources` + 复习索引）、`0007_quiz.py`（`content_items` / `questions` / `attempts` + 理解题索引）、`0008_weekly_report.py`（`watch_events` / `weekly_reports` + 观看事件索引）、`0009_placement.py`（`placement_sessions` / `placement_answers` / `user_profiles` + 未完成会话部分唯一索引）、`0010_discover.py`（`discover_queries` 检索词审计 + 24h 缓存，`UNIQUE(query_hash,target_lang)`）、`0011_reading.py`（`articles` / `article_paragraphs` / `article_translations` / `article_progress` + 用户时间索引与同用户同 URL 部分唯一索引）、`0012_exam.py`（`exam_sessions` / `exam_answers` + 未提交会话部分唯一索引）、`0013_user_profile.py`（`users.username/credits/status` + 旧用户 username 回填 + `credit_transactions` + `app_settings`）；命令与约定见 [migrations/README.md](migrations/README.md) |

## 用户体系与多用户数据隔离

前端并行开发用的**冻结契约**（状态码/字段不可改；0013 起 `user` 增加
`username` / `credits` / `status`，见下方「用户资料、余额与后台设置」）：

| 端点 | 成功 | 失败 |
|---|---|---|
| `POST /api/auth/signup` `{email,password,username}` | `201 {"user":{"id","email","username","credits","status"}}` + 设置 Cookie | `409` 邮箱已存在；`400` 邮箱格式/密码 < 8 位/用户名非法（2–24 字，中文/英文/数字/下划线/连字符，首尾不能空白）；完全不传 `username` 的旧客户端回落 email 前缀 |
| `POST /api/auth/login` `{email,password}` | `200 {"user":{…}}` + 设置 Cookie | `401` 邮箱或密码错（不区分，避免账号枚举）；`403 {"detail":"账号已被停用"}` 封禁账号 |
| `POST /api/auth/logout` | `200 {"ok":true}` 并清除 Cookie | — |
| `GET /api/auth/me` | `200 {"user":{"id","email","username","credits","status"},"isAdmin":bool}`（登录用户；`isAdmin` 来自 `ADMIN_EMAILS`，顶层字段不改变 `user` 契约）；未登录/游客保持 `200 {"user":null,"guest":true}`（并下发 `ln_guest`） | 封禁账号的旧会话在中间件直接 `403 {"detail":"账号已被停用"}` |
| `POST /api/auth/claim-guest`（需登录） | `200 {"ok":true,"claimed":bool,"merged":{history,favorites,subscriptions},"skipped":{…},"guestFiles":N}` | `401 {"detail":"未登录"}`；合并文件操作失败 `500`（游客目录保留可重试） |
| `PATCH /api/user/profile`（需登录） | `200 {"user":{"id","email","username","credits","status"}}` | `400` 用户名非法/缺字段；`403` 游客/未登录 |
| `GET /api/user/summary`（需登录） | `200 {"user":{id,email,username,credits,memberSince,status},"monthSpendUsd":0.0,"usageToday":{"minutes":0.0},"version":"…","preliminary":false}` | `403` 游客/未登录；`404` 用户不存在（竞态） |

- `/api/*` 对游客开放（M1 ⑧）：没有会话时按 `ln_guest` 隔离目录工作，可以估价、看视频、查词；只有需要账号的动作（`claim-guest`）自己要求登录。未登录不再统一 401。
- Cookie 名 `ln_session`：httpOnly、SameSite=Lax、Path=/、Max-Age=30 天；`Secure` 由 `COOKIE_SECURE=1` 控制（本地 HTTP 默认关）。前端不要读 Cookie，也不要把 token 存 localStorage。
- 游客 Cookie 名 `ln_guest`：同样 httpOnly / SameSite=Lax / Path=/ / Max-Age=30 天；值是 32 字节随机 token，服务端只用 `sha256(token)` 当目录名（原始 token 不落盘、不进日志）。浏览器删掉它 = 换一个新的空游客（Cookie 方案的已知边界）；成本侧由更紧限速 + 每游客配额 + 全站日预算兜底。
- 本地前后端分离开发时，`localhost` 与 `127.0.0.1` 属于不同 site，浏览器不会在 fetch 里带 SameSite=Lax 的 Cookie；前后端请统一用同一个主机名（都 `127.0.0.1` 或都 `localhost`），或走 Vite 代理。默认 `CORS_ORIGINS=*` 会回显请求 Origin 以兼容 `credentials: include`；公网部署仍应显式设置允许来源。
- **公网多用户浏览器部署不要设 `API_AUTH_KEY`**：它拦所有 `/api`（含 `/api/auth/*`），登录会被 401；把 key 塞进前端 `VITE_API_KEY` 又等于公开密钥。仅「移动端/内部客户端、不跑浏览器 UI」的部署才考虑它（建议同时设 `BROWSER_UI=0`）；`API_AUTH_KEY` 非空且 `BROWSER_UI` 未关闭时，`config.py` 启动会打印警告。
- 登录失败按 IP 内存限流（默认 60 秒内 10 次失败后返回 429），成功登录清零；用户不存在时也会跑一次等价的 Argon2 校验，响应时间不泄露账号是否存在。
- 会话过期行会在读取命中过期会话时删除，并最多每 60 秒批量清理一次。

数据落盘：

```
data/                                  # DATA_DIR（gitignore）
├── app.db                             # AUTH_DB_PATH 默认值；users + sessions + learning_events（Alembic 管）
├── guests/<sha256>/                   # GUEST_DATA_DIR（M1 ⑧）；布局与下面用户目录一致
│   ├── history/                       # 游客自己的视频/剧集缓存 + dictionary_cache.json
│   ├── favorites.json
│   └── subscriptions.json
└── users/<user_id>/                   # USER_DATA_DIR/<user_id>/
    ├── history/                       # 视频/本地剧集缓存；含 dictionary_cache.json
    ├── favorites.json                 # 收藏数组（按条 API 写入；GET 保持旧数组契约）
    ├── favorites_tombstones.json      # 删除墓碑 {id: deleted_at_ms}，?since= 增量用，保留 30 天
    ├── favorites.json.lock            # 收藏读-改-写文件锁（fcntl，0 字节）
    └── subscriptions.json
```

- `users(id, email, password_hash, created_at, username, credits, status)`：email 统一小写；密码只存 Argon2id 哈希；`username` 是显示名（不唯一，旧用户回填 email 前缀）；`credits` 是管理员手动发放的余额（默认 0）；`status` 是 `active`/`banned`。
- `credit_transactions(id, user_id, delta, reason, admin_id, created_at)`：余额变动流水（append-only，`(user_id, created_at)` 索引）；`app_settings(key, value, updated_at)`：维护模式 / 公告。
- `sessions(token_hash, user_id, expires_at, created_at)`：Cookie 里是 `secrets.token_urlsafe(32)` 的随机 token，库里只存 sha256。
- 词典缓存**按用户隔离**（放在该用户 `history/dictionary_cache.json`）：与视频缓存同一套目录规则，用户的坏缓存不会影响别人；代价只是同词在不同用户间各生成一次，缓存很小，可接受。
- 未登录上下文（测试/脚本）仍回落到 `HISTORY_DIR`（旧 `history/` 目录），保持兼容；正常经 API 的请求一定带身份（登录用户或游客），不会写到旧目录。
- **旧本地数据不会自动迁移**：升级后原 `history/` 里的个人数据不会出现在任何账号下。需要保留时，登录后从 `/api/auth/me` 或 `sqlite3 data/app.db "select id,email from users"` 拿到 user_id，再手动移动：
  ```bash
  mkdir -p data/users/<user_id>/history
  mv history/*.json data/users/<user_id>/history/
  mv history/favorites.json history/subscriptions.json data/users/<user_id>/ 2>/dev/null || true
  ```
  移动前建议先备份 `history/`。

## 游客态（M1 ⑧）

未登录也能先试用：首次访问任一 `/api/*`（含前端启动必调的 `/api/auth/me`）时，中间件下发 `ln_guest`
（32 字节随机、httpOnly、SameSite=Lax、30 天），`GET /api/auth/me` 返回
`{user:null, guest:true}`，前端据此进入游客态而不是登录页。**不建表、不新增迁移**：游客身份就是
`sha256(ln_guest)`，数据写 `data/guests/<sha256>/`，目录布局与用户目录完全一致。

- **隔离**：不同游客、游客与登录用户之间互不可见；路径只接受 64 位小写十六进制哈希（防穿越），
  Cookie 原文不落盘。形状不合法的 `ln_guest` 视为没有 Cookie，重新下发，绝不把任意字符串当目录名。
- **限速更紧**（按 `guest:<sha256>` 计；见下表）；游客累计最多试译 `GUEST_MAX_TRANSLATED_VIDEOS`
  （默认 1）个视频/剧集，新翻译请求返回 **403** + 提示登录；已缓存的那个视频仍可打开/补译。
- **认领**：登录后前端自动 `POST /api/auth/claim-guest`，服务端把游客目录的 `history/`、
  `favorites.json`、`subscriptions.json` 合并到用户目录：同 `videoId`、同收藏指纹（id → 内容指纹）、
  同订阅键去重，**用户数据优先**；成功后删除游客目录并清 `ln_guest`。重复调用幂等
  （`claimed:false`、计数全 0）；任何文件操作失败都保留游客目录并返回 500，重试安全。
- **成本**：游客的 AI 用量以 `guest:<sha256>` 归户写进 `ai_usage` / `ai_quota`，因此同样受每功能日
  配额、每租户日预算与全站日预算约束，不会被「匿名」绕过（清理 Cookie 会得到新游客，这是 Cookie
  方案显式接受的边界；全站日预算是最后硬闸）。

测试（全离线）：`venv/bin/python -m pytest tests/test_guest_mode.py -q`（Cookie/落盘/隔离/伪造/限速/
1 视频上限/认领合并去重/幂等/路径校验）。

## 收藏按条 API（M1 ④）

收藏仍是**每用户一个 JSON 文件**（不建表、不改 Alembic），但读写协议从「前端整文件 PUT」升级为「按条增删」。目标：两个标签页/两台设备同时改收藏时不再互相覆盖。

| 端点 | 请求 | 成功 | 失败 |
|---|---|---|---|
| `GET /api/favorites` | — | `200` 数组，最新在前（旧前端契约不变） | `500` 文件损坏/形状不对 |
| `GET /api/favorites?since=<ms>` | 毫秒时间戳 | `200 {"favorites":[…],"deleted":[{"id","deleted_at"}],"since","serverTime"}` | `422` 参数非整数 |
| `POST /api/favorites` | `{id?, type/kind, text, translation, videoId, time, meta, addedAt?}`；兼容旧字段 `en_text/zh_text/start/added_at` | `201 {"status":"ok","created":true,"favorite":{…}}`；内容/id 重复时 `200` + `created:false` | `400` 缺 `text` / 非法 `type` / `meta` 非对象 |
| `DELETE /api/favorites/{id}` | — | `200 {"status":"ok","deleted":true,"id"}` | `404` 收藏不存在 |
| `PUT /api/favorites`（兼容保留） | `{favorites:[…]}` | `200 {"status":"ok","count":N}` | `400` `favorites` 非数组 |

- **并发安全**：同一用户文件的读-改-写先取「进程内线程锁 + `favorites.json.lock` 的 fcntl 排它锁」，再用 tmp 文件 + `os.replace` 原子替换；并发 POST 不会丢条目，读方也不会看到半截 JSON。
- **幂等**：POST 先按 `id`、再按内容指纹（type/videoId/start/en_text/zh_text/context）去重；同一收藏重复提交只保留一条。
- **旧数据兼容**：旧文件里没有 `id` 的收藏在 GET 时按内容指纹补 `fav-<16 hex>` 稳定 id（**只读不改文件**），可直接用这个 id DELETE；下次写入时 id 才落盘。无法识别的任意 JSON 对象原样保存/返回（旧测试与旧客户端兼容）。
- **旧 PUT**：保持整份快照语义（不在快照里的旧 id 记墓碑），内部走同一套规整与原子写；新前端不再调用。`favorites_tombstones.json` 只增旁路记录，旧代码回滚后仍能正常读 `favorites.json`。
- 前端：`lib/favorites.ts` 提供 `fetchFavorites/addFavorite/removeFavorite`，`replaceAllFavorites` 仅为兼容路径；App 先乐观更新，失败回滚 + toast。
- 测试：`venv/bin/python -m pytest tests/test_favorites_api.py -q`（全离线：增删/幂等/400/404/排序/旧数据/墓碑/并发）。

## 复习引擎（M2：FSRS-6 + 队列 + 复习日志）

把收藏夹升级成「可调度的记忆系统」：每个词有状态、FSRS 参数、到期时间与复习流水。
**服务端状态是唯一真源**，换设备登录后队列一致；本阶段只做后端，前端复习 UI 下一轮。
规格：[specs/013-review-engine](../specs/013-review-engine/spec.md)。

### 表（迁移 `0006_review_engine`）

| 表 | 内容 |
|---|---|
| `word_states` | 每个用户每个词（按 `target_lang` 分开）一条当前状态：`state`（`new` / `learning` / `review` / `relearning` / `suspended`）、`due_at`、`stability` / `difficulty`（FSRS-6）、`reps` / `lapses`、`last_reviewed_at`、`created_at`；内部列 `step`（FSRS 学习/重学子日 step）与 `fail_streak`（连续 Again 计数）。`UNIQUE(user_id, lemma, target_lang)` + `INDEX(user_id, due_at)` |
| `review_logs` | append-only 流水：`rating`（`again` / `hard` / `good` / `easy`）、`state_before` / `state_after`（JSON 快照）、`reviewed_at`、`elapsed_ms`；索引 `(user_id, reviewed_at)` |
| `word_sources` | 词从哪来：`word_state_id`（FK → `word_states.id`，CASCADE）、`content_ref`（videoId / 剧集 / 文章）、`sentence_id`、`created_at`；索引 `word_state_id` |

- 运行时不建表：未跑 `0006` 时复习端点统一返回 **503** 并提示 `alembic upgrade head`，不静默空队列。
- `lemma` 由 `srs.add_word` 规范为 NFC + 小写；`target_lang` 缺省 `zh-CN`，非法代码 400。
- 所有时间字段是**毫秒 UTC**；时区展示交给前端。统计的「今日」按 UTC 日界（文档与响应 `today` 都写明）。

### 调度规则

- 依赖 PyPI **`fsrs` 6.3.3**（FSRS-6），目标保持率 0.9，关闭 fuzz → 同输入同输出，测试注入时钟断言。该包已验证可用并在 `requirements.txt` 固定版本，**不启用 SM-2 兼容降级**（缺包时端点 503 并提示安装；不会静默换算法）。
- 新词首次作答进入学习步长（Again 1 分钟 / Hard 5.5 分钟 / Good 10 分钟 / Easy 直接毕业到 Review），复习时 Again 进入 10 分钟重学。
- 每次作答 `reps+1`；`again` 同时 `lapses+1`、`fail_streak+1`，其他评分把 `fail_streak` 清零。
- `fail_streak >= 3` → 自动 `suspended`（仍写当次日志）；`suspended` 不进队列，作答 **409**。
- 手工 suspend / restore 幂等；恢复后有历史 → `review`（无历史 → `new`），`due_at=now`、`fail_streak=0`，保留 FSRS 参数，不会被恢复前的旧日志立刻再次判死。

### HTTP 契约（全部需登录；游客/未登录 403）

| 端点 | 请求 | 成功 |
|---|---|---|
| `POST /api/review/words` | `{lemma, targetLang?, source?}`；`source` 可为 `{contentRef,sentenceId}`（也接受 `videoId` / snake_case）或字符串 | `201 {"status":"ok","created":true,"word":{…}}`；已存在 `200 created:false`，**不重置进度**，只补来源 |
| `GET /api/review/queue?limit=20&newLimit=10&targetLang=zh-CN` | `limit` 1–100（总条数）、`newLimit` 0–100 | `{targetLang, now, limit, newLimit, counts, due, new, items}`；`due` 按 `due_at` 升序、`new` 按 `created_at` 升序；不返回释义（前端需要时再调 `/api/define`） |
| `POST /api/review/answer` | `{lemma, rating, targetLang?, elapsedMs?}` | `{status:"ok", word, suspended, autoSuspended, dueAt}`；词不存在 404、已暂停 409、评分非法 400 |
| `GET /api/review/stats?targetLang=` | 省略 `targetLang` = 全部语言 | `{targetLang, now, today, dueToday, dueNow, reviewedToday, reviewedWordsToday, newWords, newToday, totalWords, suspendedWords, streakDays}` |
| `POST /api/review/suspend` | `{lemma, targetLang?}` | `{status:"ok", suspended:true, word}`；不存在 404 |
| `DELETE /api/review/suspend?lemma=&targetLang=` | 也接受 JSON body | `{status:"ok", suspended:false, word}`；不存在 404 |

`word` 形状：`{id, lemma, targetLang, state, dueAt, stability, difficulty, reps, lapses, failStreak, lastReviewedAt, createdAt, sources}`。
数据库未迁移 → **503**；参数错误 → **400**；游客 → **403**。

### 运行与验证

```bash
cd backend
venv/bin/alembic upgrade head                 # 新库迁到 0006；旧库先 stamp 0001 再 upgrade
venv/bin/python -m py_compile *.py
venv/bin/python -m pytest tests/test_review_engine.py -q
venv/bin/python -m pytest tests -q            # 全量离线（含迁移升级/回滚）
```

## 理解题（M3 后端：出题 + 作答 + 证据回跳）

看完一个已有双语字幕的 video / local_show 后，生成 3 道英文理解题（2 道 4 选 1
+ 1 道判断题），每题引用一个具体字幕 block 作为证据；作答可判分，答错时前端
可跳回证据时间点。本阶段只做后端，答题页下一轮。规格：
[specs/014-quiz](../specs/014-quiz/spec.md)。

### 表（迁移 `0007_quiz`）

| 表 | 内容 |
|---|---|
| `content_items` | 每个用户每条内容（按 `target_lang` 分开）一条：`kind`（`video` / `local_show`）、`content_ref`、`content_hash`（双语字幕正文 + 起止毫秒的 sha256 前 32 hex）、`title`、`status`（`draft` / `ready`）、内部列 `prompt_version`（缓存键第二维）、`created_at`；`UNIQUE(user_id, content_ref, target_lang)` |
| `questions` | 一题一行：`ordinal`、`question_type`（`mcq` 4 选项 / `tf` True·False 2 选项）、`prompt`、`options`（JSON 文本）、`answer_index`、`evidence_block_id`、`evidence_start/end`（**毫秒**）、`explanation`、`status`（`draft` / `approved` / `rejected`）、`model`、`created_at`；索引 `content_item_id`，FK → `content_items.id` CASCADE |
| `attempts` | append-only 作答流水：`user_id`、`question_id`（FK → `questions.id` CASCADE）、`chosen_index`、`is_correct`（0/1）、`answered_at`（毫秒 UTC）、`elapsed_ms`；索引 `(user_id, answered_at)` 与 `question_id` |

- 运行时不建表：未跑 `0007` 时理解题端点统一返回 **503** 并提示 `alembic upgrade head`。
- `content_items` 是 private（计划书 D-7）：**同一用户同一内容只生成一次**；不同用户各自一份，不共享题目。
- 字幕变化（`content_hash` 变化）或 `prompt_version` 升级才重新生成；旧题置为 `rejected`（attempts 保留）。

### 出题与两道闸

- 输入只来自当前用户的字幕缓存：视频用 `find_history_file_for_video`，本地剧集用
  `history/[<lang>/]<show>_SxxEyy.json`；缓存 `target_lang` 必须与请求一致。
- 视频/剧集至少 **8 句**真正双语（英文 + 非 `[未翻译]` 译文），否则 **422**；长内容按时间轴
  均匀抽 ≤40 块送模型，prompt 只含 `block id + start 秒 + en_text`（不给标题/频道/中文）。
- 模型输出严格 JSON（`questions[3]`，每题 `question_type/prompt/options/answer_index/evidence_block_id/explanation`）。
- **结构闸**：mcq 4 个选项、tf 2 个；答案下标合法；选项非空不重复；evidence block 必须存在。
- **内容闸**：题干/选项不得混入中文（CJK）；题干+选项必须与证据句共享至少一个英文实词。
- 任一题不过 → **整批重试 1 次**；仍不过的题以 `rejected` 落库、不返回；部分通过时返回通过的部分。
  模型调用/解析失败不落库，返回 422，下次可重试；候选全部被拒则落库 `draft`，下次直接
  422、不重复花钱。
- 生成走 `llm.generate_json_async`（全局并发闸 + 线程），`usage_scope("quiz", …)` 记进
  `ai_usage`；一个 lesson 占 1 个 `AI_DAILY_QUOTA_QUIZ`（默认 30/用户/日，缓存命中不占）。

### HTTP 契约（全部需登录；游客/未登录 403）

| 端点 | 请求 | 成功 |
|---|---|---|
| `POST /api/lesson/start` | `{kind, contentRef, targetLang?}`；`contentRef` 为视频 videoId 或 `<show_id>-S01E01` | `{lessonId, status, kind, contentRef, targetLang, contentHash, questions:[{id, ordinal, questionType, prompt, options}]}`；已有缓存直接复用，不重复调模型 |
| `GET /api/lesson/{id}/questions` | — | 同上（不含答案/解释）；lesson 不存在/别人的 **404** |
| `POST /api/lesson/answer` | `{questionId, chosenIndex, elapsedMs?}` | `{correct, answerIndex, chosenIndex, explanation, evidence:{blockId,start,end,startMs,endMs}, lessonId, questionId, questionType, attemptId, answeredAt}` |
| `GET /api/lesson/{id}/result` | — | `{lessonId, status, kind, contentRef, targetLang, totalQuestions, answered, correct, wrong, correctRate, wrongQuestions:[…], lastAnsweredAt}` |

- 证据时间：数据库存**毫秒**；响应 `evidence.start/end` 是**秒**（与字幕 block 同一
  时间轴，播放器可直接 seek），另给 `startMs/endMs`；`blockId` 数字 id 返回 int。
- 错误码：参数 **400**；游客 **403**；无字幕/lesson/question 不存在或越权 **404**；
  字幕太短/生成失败 **422**；配额/预算 **429**；未迁移 **503**。
- 每次成功作答写 `learning_events`：`event_type=quiz_answer`，payload 含
  `correct` / `evidence` / `chosenIndex` / `answerIndex` / `elapsedMs` 等，供周报与能力评估。
  事件写失败只记日志，不阻断作答。

### 运行与验证

```bash
cd backend
venv/bin/alembic upgrade head                 # 新库迁到 0007；旧库先 stamp 0001 再 upgrade
venv/bin/python -m py_compile *.py
venv/bin/python -m pytest tests/test_quiz.py -q
venv/bin/python -m pytest tests -q            # 全量离线（含迁移升级/回滚）
```



## 学习事件上报与周报（M5 后端：观看事件 + 周报快照）

前端批量上报「看了多久 / 看了哪个内容」，服务端按 **UTC 周**聚合出
「3 个数字 + 1 句事实 + 1 个下一步 + 1 段可回看证据」；首份结果写
`weekly_reports` 快照，供站内页与未来邮件复用。本阶段只做后端，周报页/邮件
下一轮。规格：[specs/015-weekly-report](../specs/015-weekly-report/spec.md)。

### 表（迁移 `0008_weekly_report`）

| 表 | 内容 |
|---|---|
| `watch_events` | append-only 观看流水：`user_id`（**归属键**，登录用户 = `users.id`；游客 = `guest:<sha256>`）、`guest_hash`（游客 sha256，登录用户 NULL；为认领迁移预留）、`content_ref`、`kind`（`video` / `local_show`）、`target_lang`、`watched_seconds` / `position_seconds`（秒，CHECK 0–86400）、`occurred_at`（客户端毫秒 UTC）、`client_event_id`；`UNIQUE(user_id, client_event_id)` + `(user_id, occurred_at)` 索引 |
| `weekly_reports` | 周报快照：`user_id`、`week_start`（DATE，UTC 周一）、`payload`（完整报告 JSON 文本：`version` / `generatedAt` / `report`）、`created_at`；`UNIQUE(user_id, week_start)`，同周只留首份 |

- 运行时不建表：未跑 `0008` 时两个端点统一返回 **503** 并提示 `alembic upgrade head`。
- `watch_events` 也是 append-only（`reports.py` 只 INSERT/SELECT）。
- 游客归属写成 `guest:<sha256>` 而不是 NULL，`UNIQUE(user_id, client_event_id)`
  对游客同样生效；`guest_hash` 不对外返回。

### 事件上报 `POST /api/events`

```json
{"events": [
  {"type": "watch", "contentRef": "dQw4w9WgXcQ", "kind": "video",
   "targetLang": "zh-CN", "watchedSeconds": 42, "positionSeconds": 128,
   "occurredAt": 1794398400000, "clientEventId": "w-2026-11-09-a1"}
]}
```

- 单次 **最多 50 条**；`type` 目前只支持 `watch`；`contentRef` 规则与理解题一致
  （`local_show` 会规范化成 `<show>-SxxEyy`）。
- `watchedSeconds` / `positionSeconds`：数字，0–86400 秒，落库取整；
  `occurredAt`：整数毫秒，不能比服务端时间晚 5 分钟以上；
  `clientEventId`：非空、≤128 字符，客户端生成的幂等键。
- **任一条非法 → 整批 400，不写任何一条**（先全量校验，再开事务）。
- 响应：`{"received", "accepted", "duplicated"}`；重复 `clientEventId`
  计入 `duplicated`，不重复计数。
- 游客可用：无会话时归属 `guest:<sha256>`，游客周报与登录用户、其他游客隔离。

### 周报 `GET /api/report/week?weekStart=YYYY-MM-DD`

- 周界：**UTC 周一 00:00 左闭右开** `[weekStart, weekStart+7d)`；`weekStart`
  缺省本周一，传任意日期归一到所在周周一；非法日期 400。
- `numbers`：`passiveMinutes`（`watched_seconds` 求和 ÷60，1 位小数）、
  `reviewedWords`（`review_logs` distinct lemma）、`quizAccuracy`
  （`attempts` 正确率 0–1，**无作答为 null**）。
- `fact`：一句中文事实（例：「你本周看了 1 个视频和 1 集剧集，完成 6 道题，
  复习了 3 个词。」）；无数据为「这周还没有可统计的学习记录。」。
- `nextStep`：规则生成，优先级 = 无任何数据 → 无作答（「明天做一次理解练习」）
  → 有到期词（「复习 N 个到期词」）→ 无观看 → 无复习 → ≥4 次作答且正确率
  <0.6 → 默认「保持这个节奏，明天学 10 分钟」。
- `evidence`：优先本周最近一条**答错题**的 evidence block（`source=quiz_wrong`，
  contentRef + 秒/毫秒起止 + 从当前身份字幕缓存解析的 `sentence`）；没有错题
  则取最近一次观看的 **5 秒窗口**（`source=watch`，以进度为中心）；都没有为
  `null`。句子缓存缺失时 `sentence=null`，时间点仍返回；`blockId` 数字返回 int
  （与理解题一致）。
- `streakDays`：有任意 watch / quiz / review 的 UTC 日连续天数（今天没有记录
  从昨天数，最多回溯 400 天）。
- `quiz`：本周 `attempts` / `correct`；`words`：`new`（本周新建词状态数）、
  `reviewed`、`dueTomorrow`（到明天结束前该复习的词，含逾期）。
- 快照：首次生成时 `INSERT OR IGNORE` 写入 `weekly_reports`；同周后续 GET
  返回实时数字但不覆盖首份快照；无数据也写快照；不同周各一份。
- 错误码：`weekStart` 非法 **400**；表未迁移 **503**。

### 运行与验证

```bash
cd backend
venv/bin/alembic upgrade head                 # 新库迁到 0009；旧库先 stamp 0001 再 upgrade
venv/bin/python -m py_compile *.py
venv/bin/python -m pytest tests/test_weekly_report.py -q
venv/bin/python -m pytest tests -q            # 全量离线（含迁移升级/回滚）

# 手工冒烟（临时 /tmp 库，不碰 data/app.db）
mkdir -p /tmp/yt/data/users /tmp/yt/data/guests
AUTH_DB_PATH=/tmp/yt/app.db venv/bin/alembic upgrade head
AUTH_DB_PATH=/tmp/yt/app.db DATA_DIR=/tmp/yt/data USER_DATA_DIR=/tmp/yt/data/users \
  GUEST_DATA_DIR=/tmp/yt/data/guests HISTORY_DIR=/tmp/yt/legacy \
  venv/bin/uvicorn main:app --port 8001
```

已知边界：游客认领账号时已上报的观看事件暂不迁移（`guest_hash` 已预留）；
`dueTomorrow` 相对当前时刻计算（补看历史周时语义需再确认）；不做客户端时长
反作弊；本轮不切片音频，只给 5 秒时间窗。


## 能力定位测与能力画像（M4 后端）

新用户用 12 分钟完成一次定位测（24 词 + 5 阅读 + 3 伪词混入），得到
**CEFR 区间 + 置信度 + 强弱项 + 1 条建议**，保存为能力画像；老用户可重测。
结果只给区间，不显示小数等级、不承诺考试分数。前端流程/结果页下一轮。
规格：[specs/016-placement](../specs/016-placement/spec.md)。

### 表（迁移 `0009_placement`）

| 表 | 内容 |
|---|---|
| `placement_sessions` | 一次测试：`id`（uuid4 hex）、`user_id`（**归属键**：登录用户 id / 游客 `guest:<sha256>`）、`guest_hash`、`status`（`in_progress` / `submitted` / `abandoned`）、`started_at` / `submitted_at`、`duration_ms`、`score`（0–100）、`cefr`（如 `A2–B2`）、`confidence`（0–1）、`breakdown`（完整结果 JSON）；`(user_id, started_at)` 索引 + 部分唯一索引 `ux_placement_sessions_active`（同一用户最多一个未完成会话） |
| `placement_answers` | 逐题作答（提交时一次写 32 行，append-only）：`session_id`（FK → sessions，CASCADE）、`item_id`（题库银行 id）、`item_type`（`vocab` / `reading` / `pseudo`）、`chosen_index`（`-1` = 不认识/跳过，`0–3` = 选项）、`correct`（0/1；伪词恒 0）、`difficulty_band`、`answered_at`；`UNIQUE(session_id, item_id)` |
| `user_profiles` | 当前画像（每归属键一行，最新一次覆盖）：`cefr`、`level_band_low/high`、`vocab_estimate`（约词汇量）、`reading_estimate`（阅读带）、`confidence`、`pseudo_word_suspicion`、`updated_at`、`source`（`placement` / `user_edit`） |

- 运行时不建表：未跑 `0009` 时四个端点统一 **503** 并提示 `alembic upgrade head`。
- 游客也写 `user_id = guest:<sha256>`，与 `watch_events` 同一套归属口径；换设备/
  Cookie 就是新游客，画像不跨设备。

### 端点

| 端点 | 说明 |
|---|---|
| `GET /api/placement/start` | 开始/复用未完成会话；下发 24 词 + 3 伪词 + 5 阅读（共 32 题，打乱），**不含答案**；伪词按 `vocab` 外观混入，对外 `itemId` 是会话内编号 `q-01`…`q-32` |
| `POST /api/placement/submit` | `{sessionId, answers:[{itemId,chosenIndex}], durationMs?}`；服务端加权评分、区间、置信度、强弱项、1 条建议，写 session + 画像；重复提交幂等返回首次结果 |
| `GET /api/placement/profile` | 当前画像；没有则 `profile: null`；附带 `preliminary` / `sampleSize` |
| `POST /api/placement/reset` | 允许重测：只把未完成会话标 `abandoned`，已提交历史与画像保留 |

### 抽题与计分

- **题库**：`content/placement/{vocab,reading,pseudo}.json`（30 + 5 + 4，草稿待
  教研审校；`_meta.notice` 必须含「待教研审校」，否则启动加载直接 503）。
- **抽题**：按 `seed = placement.serve.v1:<sessionId>` 确定性抽 24 词汇（A1 5 /
  A2 5 / B1 5 / B2 5 / C1 4）+ 3 伪词 + 5 阅读并打乱；start/submit 用同一
  sessionId 重算同一份卷，因此不存整卷。同一用户 start 复用 `in_progress` 会话。
- **计分**：难度带权重 A1=0.5 / A2=1.0 / B1=1.5 / B2=2.0 / C1=2.5；
  `score = Σ答对权重 / Σ全部权重 × 100`；伪词不参与得分，只统计过度声称
  （`pseudoWordSuspicion`）。`chosenIndex=-1`（或 `null`）= 不认识/跳过。
- **区间**：加权正确率 → 点估计带（启发式 `heuristic.v1`，阈值在
  `placement.py` 顶部）→ **±1 带**（A1/C1 截断），如 A1→`A1–A2`、B1→`A2–B2`、
  C1→`B2–C1`。`vocab_estimate` 取点带中值（1500–12000，UI 必须带「约」）。
- **置信度**：完成度 + 用时合理性 − 伪词过度声称惩罚，0.10–0.85；高/中/低三档。
  伪词可疑度 ≥0.5 时建议优先提醒「不确定就选不认识、可重测」。
- **样本口径**：完成过定位测的不同用户数 <100 → `preliminary: true`，文案标
  「初步估计」；达到 100 后自动翻 false。不承诺「准确」/考试分数。
- **强弱项**：词汇带 / 阅读带 vs 点估计；`notMeasured` 明确列
  `listening/speaking/writing`（本测不测，不猜）。

### 运行与验证

```bash
cd backend
venv/bin/alembic upgrade head                 # 新库迁到 0009；旧库先 stamp 0001 再 upgrade
venv/bin/python -m py_compile *.py
venv/bin/python -m pytest tests/test_placement.py -q
venv/bin/python -m pytest tests -q            # 全量离线（含迁移升级/回滚）

# 手工冒烟（临时 /tmp 库，不碰 data/app.db）
mkdir -p /tmp/yt-plc/data/users /tmp/yt-plc/data/guests
AUTH_DB_PATH=/tmp/yt-plc/app.db venv/bin/alembic upgrade head
AUTH_DB_PATH=/tmp/yt-plc/app.db DATA_DIR=/tmp/yt-plc/data \
  USER_DATA_DIR=/tmp/yt-plc/data/users GUEST_DATA_DIR=/tmp/yt-plc/data/guests \
  HISTORY_DIR=/tmp/yt-plc/legacy venv/bin/uvicorn main:app --port 8001
# GET /api/placement/start → POST /api/placement/submit（同一 sessionId 再提交一次验证幂等）
```

已知边界：题库只有 39 题草稿（计划书首发 200–240 题）、评分阈值是启发式而非
CAT 标定、题型只有词汇识别 + 短阅读、前端未做、游客认领账号时定位结果不迁移。


## 考试练习（V2 后端）

用户选「CET-4 风格练习」做 10 道自编题（词汇 5 + 语法 2 + 阅读 3），提交后看
**逐题对错 + 正确答案 + 解析**；历史只显示日期/题型/正确数/总数。**不报分、
不预测成绩、不用真题、不做效果承诺**；命名统一「考试练习」，不使用替代表述。
前端练习页/结果页下一轮。规格：[specs/022-exam-practice](../specs/022-exam-practice/spec.md)。

### 表（迁移 `0012_exam`）

| 表 | 内容 |
|---|---|
| `exam_sessions` | 一次练习：`id`（uuid4 hex）、`user_id`（登录用户 id）、`exam_type`（当前 `cet4`）、`status`（`in_progress` / `submitted`）、`item_ids`（本次卷面的题库 id JSON 数组，保序）、`started_at` / `submitted_at`、`duration_ms`（CHECK 0–86400000）；`(user_id, started_at)` 与 `(user_id, submitted_at)` 索引 + 部分唯一索引 `ux_exam_sessions_active`（同一用户最多一个未提交会话） |
| `exam_answers` | 逐题作答（**只存已作答的题**，append-only）：`session_id`（FK → sessions，CASCADE）、`item_id`（题库 id）、`chosen_index`（0–3，CHECK）、`correct`（0/1，CHECK）、`answered_at`；`PRIMARY KEY(session_id, item_id)` |

- 运行时不建表：未跑 `0012` 时 `start/submit/history` 返回 **503** 并提示
  `alembic upgrade head`；`GET /api/exam/types` 是静态题库目录，不依赖数据库。
- **全部需登录，游客 403**；别人的 sessionId 返回 **404**，不泄露存在性。
- 不建题库表：题库是 `content/exam/cet4.json` 静态文件；会话只存 id，评分结果
  按题库 + 作答行重建，不存成绩。

### 端点

| 端点 | 说明 |
|---|---|
| `GET /api/exam/types` | 可用题型：`{types:[{id:"cet4",label:"CET-4 风格练习",itemCount:30,sessionItemCount:10,...}]}` |
| `POST /api/exam/start` | `{type}`；抽 10 题（词汇 5 + 语法 2 + 阅读 3）并创建/复用未提交会话；卷面**不含答案与解析**；复用返回 `resumed:true` 与同一卷面 |
| `POST /api/exam/submit` | `{sessionId, answers:[{itemId,chosenIndex}], durationMs}`；返回 `correct/total/answered/unanswered` 与逐题 `chosenIndex/correctIndex/correct/answered/explanation`；重复提交幂等返回首次结果（`reused:true`） |
| `GET /api/exam/history?limit=20` | 只含已提交会话：`date` / `examType` / `correct` / `total` / `answered` / `durationMs`；`limit` 1–100；**不出现任何成绩字段** |

### 题库、抽题与判分

- **题库**：`content/exam/cet4.json` 30 题 = 15 词汇 + 5 语法 + 10 阅读
  （3 段短文，每段 3–4 题）；每题 `id/type/band/prompt/options/answerIndex/
  explanation/topic`，阅读题另有 `passageId` 指向顶层 `passages`。
  文件头 `_meta.notice` 必须含「草稿，待教研审校」，否则加载直接 503。
- **抽题**：`seed = exam.serve.v1:<sessionId>` 确定性抽 5 词汇 + 2 语法 + 3 阅读
  （阅读按短文抽，尽量 3 段各 1 题）并打乱；卷面 id 写入 `item_ids`。
- **判分**：每题 4 选 1，`chosenIndex` 与题库 `answerIndex` 一致即正确；未在
  `answers` 里出现的题 = 未作答（`answered:false`, `chosenIndex:null`），
  不写 `exam_answers` 行。总分只给 `correct/total`，不换算成绩/等级/通过比例。
- **幂等**：同一 sessionId 首次提交后状态变为 `submitted`；重复提交直接返回
  按库内作答行重建的首次结果，不覆盖答案/用时，不重复发 `exam_submit`。
- **事件**：新建会话写 `learning_events(exam_start)`，首次提交写
  `learning_events(exam_submit)`（payload：题型/题数/答对数/用时），供周报与
  画像后续聚合；本模块**不改 `user_profiles` / placement 结果**。

### 运行与验证

```bash
cd backend
venv/bin/alembic upgrade head                 # 新库迁到 0012；旧库先 stamp 0001 再 upgrade
venv/bin/python -m py_compile *.py
venv/bin/python -m pytest tests/test_exam.py -q
venv/bin/python -m pytest tests -q            # 全量离线（含迁移升级/回滚）

# 手工冒烟（临时 /tmp 库，不碰 data/app.db）
mkdir -p /tmp/yt-exam/data
AUTH_DB_PATH=/tmp/yt-exam/app.db venv/bin/alembic upgrade head
AUTH_DB_PATH=/tmp/yt-exam/app.db DATA_DIR=/tmp/yt-exam/data \
  HISTORY_DIR=/tmp/yt-exam/history venv/bin/uvicorn main:app --port 8001
# 登录后 GET /api/exam/types → POST /api/exam/start → POST /api/exam/submit → GET /api/exam/history
```

已知边界：题库只有 30 题草稿（CET-4 常见题型中的选词填空/仔细阅读/段落匹配/
听力填空尚未覆盖）、只有客观题、无计时强制、无分项诊断、无前端；游客不可用。


## 内容发现（V1 后端）

把「粘贴 YouTube 链接」扩展成「描述想看什么」，由后端找 3–5 个适合英语学习的
候选；用户选中后仍走现有链路：`/api/estimate-cost` → 选模型 → 双语字幕流式翻译。
规格：[specs/017-discover](../specs/017-discover/spec.md)。

### 端点

`POST /api/discover`（**需登录；游客/未登录 403**；限速 5 次/分钟/用户）

```json
{"query": "推荐一些关于人工智能的演讲", "targetLang": "zh-CN", "force": false}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `query` | 是 | 1–200 字自然语言（中/英）；空白/超长/YouTube 链接 → 400 |
| `targetLang` | 否 | `zh-CN`（缺省）/ `vi-VN`；用于缓存键与审计，非法 → 400 |
| `force` | 否 | `true` 绕过 24h 缓存，重新搜索/重排（用于「换一批」） |

成功响应（200）：

```json
{
  "queries": ["TED talk about artificial intelligence", "AI future explained", "MIT AI lecture"],
  "candidates": [
    {
      "videoId": "KKNCiRWd_j0",
      "title": "What Is an AI Anyway? | TED",
      "channel": "TED",
      "duration": 1322,
      "thumbnail": "https://i.ytimg.com/vi/KKNCiRWd_j0/hqdefault.jpg",
      "level": "B2",
      "reason": "TED 官方演讲，主题直接命中；22 分钟，适合完整看一场。",
      "hasEnglishSubs": true,
      "alreadyProcessed": false
    }
  ],
  "cached": false,
  "degraded": false,
  "disclaimer": "字幕与时长可能随视频更新，候选由 AI/规则筛选，请以点击后的实际页面为准。"
}
```

- `queries`：实际使用的英文检索词（LLM 失败时是原 query，仍照常搜索）。
- `candidates`：3–5 个；搜索/过滤后不足 3 个时返回实际数量（空数组也是 200，
  不伪造候选）。`duration` 为秒；`thumbnail` 固定用稳定的
  `i.ytimg.com/vi/<id>/hqdefault.jpg`（不下载）。
- `level`：A1/A2/B1/B2/C1 的**估计**；`reason`：一句中文，只基于标题/频道/时长/
  字幕状态等可见字段，不评价发音/画面。
- `hasEnglishSubs`：`true` 有英文轨；`null` 探测失败（unknown，保留候选）；
  明确没有英文字轨的候选已过滤，不会以 `false` 出现在列表里。
- `alreadyProcessed`：按**当前用户 + targetLang** 的本地历史缓存计算；缓存命中时
  也会重算，不会把别人的「已学过」带过来。
- `degraded`：任一环节降级（意图→原 query、重排→规则/模板理由、部分 query
  搜索失败）为 `true`，此时理由可能来自模板而不是模型。

错误：`400` 参数/语言/链接；`403` 未登录/游客；`429` 限速（带 `Retry-After`）；
`503` 搜索全部失败（yt-dlp 不可用）；`504` 整体预算耗尽且没有可用候选。

### 流程与边界

1. LLM 意图改写：2–3 个英文检索词，JSON 容错（去围栏/首尾花括号）；不可用、
   超时、非法 JSON 或不足 2 个合法英文词 → 原 query。
2. yt-dlp `ytsearchN:`（每 query 8 条，并发 ≤3，单 query 8s/失败不拖垮整体）；
   提取 id/title/channel/duration/description/verified；跨 query 按 videoId 去重，
   过滤直播/预告、<90s、>90min、缺时长。
3. 字幕探测：只 `list()` 轨道，不 `fetch()` 正文；并发 ≤4、每视频 2s；
   已处理视频直接视为有英文字幕且不联网；失败/超时标 unknown 保留。
4. LLM 重排 top 10：输出 3–5 个 + A1–C1 + 中文一句理由；非法 index 丢弃、
   不足 3 个用规则补足；LLM 失败/无 Key → 规则排序（时长贴合 + 频道认证 +
   字幕可用）+ 模板理由。
5. 整体预算 20s；超时返回已有候选（重排退化为规则），完全无候选才 504。

发现阶段**不下载视频/音频/字幕文件，不保存字幕正文**，也不触发翻译/总结；
选片后由现有估价端点和流式管线处理。

### 24h 缓存（迁移 `0010_discover`）

表 `discover_queries`：`id` / `user_id`（可空）/ `query_hash` / `query` /
`target_lang` / `result`（响应 JSON 文本）/ `created_at` / `expires_at`，
`UNIQUE(query_hash, target_lang)` + `ix_discover_queries_expires`。

- 缓存键 = `sha256(NFKC + casefold(规范化 query)) + target_lang`，默认 TTL 24h；
  命中时 `cached:true`，**不再调用搜索/字幕探测/LLM**（已处理状态按当前用户重算）。
- `force:true` 绕过读取并覆盖写。
- 只缓存「有候选且没有 query 搜索失败」的成功结果；空结果、全失败、部分搜索
  失败不写缓存，避免把一次坏结果锁 24h。
- 不存字幕正文；缓存行可由 `DELETE FROM discover_queries` 清理（不影响学习缓存）。
- 未跑 `0010` 的旧库：缓存读写降级为未命中/不写（只告警一次），端点仍可用；
  上线前仍应 `alembic upgrade head`。

### 配置（默认值）

| 环境变量 | 默认 | 说明 |
|---|---:|---|
| `RATE_LIMIT_DISCOVER_PER_MINUTE` | 5 | 每登录用户每分钟发现次数（0=关闭） |
| `DISCOVER_RESULTS_PER_QUERY` | 8 | 每个检索词取多少条 flat 结果 |
| `DISCOVER_MAX_QUERIES` | 3 | 单次最多检索词（2–3 生效） |
| `DISCOVER_POOL_LIMIT` | 10 | 去重/过滤后进入探测与重排的候选上限 |
| `DISCOVER_SEARCH_CONCURRENCY` | 3 | yt-dlp 查询并发 |
| `DISCOVER_CAPTION_CONCURRENCY` | 4 | 字幕探测并发 |
| `DISCOVER_MIN_DURATION_SECONDS` | 90 | 时长硬下限 |
| `DISCOVER_MAX_DURATION_SECONDS` | 5400 | 时长硬上限（90 分钟） |
| `DISCOVER_CACHE_HOURS` | 24 | 结果缓存 TTL（0=关闭缓存） |
| `DISCOVER_TOTAL_SECONDS` | 20 | 单次请求总预算 |
| `DISCOVER_INTENT_TIMEOUT_SECONDS` | 6 | 意图改写超时 |
| `DISCOVER_SEARCH_TIMEOUT_SECONDS` | 8 | 单 query 搜索超时 |
| `DISCOVER_CAPTION_TIMEOUT_SECONDS` | 2 | 单视频字幕探测超时 |
| `DISCOVER_RERANK_TIMEOUT_SECONDS` | 8 | 重排超时 |

### 测试与手动实测

```bash
cd backend
venv/bin/python -m py_compile *.py
venv/bin/python -m pytest tests/test_discover.py -q   # 26 个离线用例（mock 三处外部调用）
venv/bin/python -m pytest tests -q                    # 全量（含迁移升级/回滚）
```

手动实测（真实网络）：登录后 `POST /api/discover {"query":"TED talk about AI"}`，
检查候选字段、英文字幕过滤与第二次 `cached:true`；或起 8001 临时实例并用
`/tmp` 数据目录 + mock 搜索/探测/LLM 验证端点、缓存与 `force`（不污染仓库
`data/`、`history/`）。


## 规则推荐（V1：按能力画像推荐人工精选内容）

首页「为你推荐」的后端：**不调用 LLM**，用「人工精选池 + 定位测区间 + 已看历史」
做规则推荐。规格：[specs/018-recommendations](../specs/018-recommendations/spec.md)。

### 端点

`GET /api/recommendations?limit=6&targetLang=zh-CN&seed=0`（**游客可用**）

| 参数 | 说明 |
|---|---|
| `limit` | 1–12，默认 6；越界/非整数 422 |
| `targetLang` | `zh-CN`（缺省）/ `vi-VN`；非法 400 |
| `seed` | 0–9999，默认 0；前端「换一批」用确定性轮转，不改变筛选规则 |

成功响应（200）：

```json
{
  "items": [
    {
      "videoId": "KKNCiRWd_j0",
      "title": "What Is an AI Anyway? | Mustafa Suleyman | TED",
      "channel": "TED",
      "duration": 1322,
      "thumbnail": "https://i.ytimg.com/vi/KKNCiRWd_j0/hqdefault.jpg",
      "level": "C1",
      "topic": "technology",
      "reason": "适合你的 C1 水平。DeepMind 负责人 22 分钟完整论述 AI 的本质……",
      "url": "https://www.youtube.com/watch?v=KKNCiRWd_j0"
    }
  ],
  "basis": {"band": "B1–B2", "source": "profile"},
  "preliminary": true
}
```

- `basis.source`：`profile` = 用了登录用户画像区间；`default` = 无画像、游客，
  或画像区间无候选后回退到默认 `A2–B1`。
- `preliminary`：无画像或定位测样本 <100 时为 `true`；前端不得显示成「准确」。
- 返回 1–6 条为常态；候选不足/已看太多时返回实际数量，**不伪造**。
- 错误：400（targetLang 非法）、422（limit/seed 越界）、503（`content/curated.json`
  缺失/损坏/未标「待运营复核」）。
- 缓存：进程内 10 分钟 + 响应头 `Cache-Control: private, max-age=600`。缓存键
  含身份、语言、limit、seed、区间、来源与 history 指纹，history/画像变化自动失效。

### 规则

1. **画像**：登录用户读 `user_profiles.level_band_low/high`；无画像/表未迁移 →
   默认 `A2–B1`。**游客即使有游客画像也一律默认 `A2–B1`**（任务口径）。
2. **已看历史**：只读当前身份 + 目标语言 `history/` 下缓存的 `videoId` /
   `metadata.channel` / `metadata.title`，不读字幕正文；已缓存 videoId 全部排除。
   频道/标题只用于推断「最近在看什么主题」（关键词 + 精选池同频道映射），不当作
   排除条件。
3. **难度**：只保留区间内 + 相邻 ±1；先区间内（distance=0），不足 limit 再补 ±1。
4. **主题多样性**：每轮每主题最多 1 条、每主题总数 ≤2；`limit=5` 时五主题各一条，
   `limit=6` 时先覆盖五主题再补第 2 条。
5. **新鲜度**：同主题内按精选池 `publishedAt` 从新到旧；同日保持文件顺序。
6. **回退**：画像区间无候选（例如都看过）→ 默认 `A2–B1` 重算；仍无 → `items: []`。
7. **理由**：中文为「适合你的 B1 水平 / 比区间略低(高) / 入门区间」+ 最近主题
   + 精选池编辑推荐语；越南语只输出越语模板，不混中文。

### 精选池

`content/curated.json`：30 条真实 YouTube 视频（A2 4 / B1 10 / B2 10 / C1 6；
technology/business/psychology/culture/environment 各 6；4–32 分钟）。内容闸门
校验草稿标记、id 唯一 11 位、时长 180–2400s、主题/难度枚举、缩略图与 id 一致、
`_meta.count` 一致；坏内容 503。字段与维护方式见
[content/README](../content/README.md)。

### 测试与实测

```bash
cd backend
venv/bin/python -m py_compile *.py
venv/bin/python -m pytest tests/test_recommend.py -q   # 17 个离线用例
venv/bin/python -m pytest tests -q                    # 全量 395
```

2026-11-15 实测（8001 临时实例，/tmp 数据目录）：无画像 `A2–B1/default` 6 条；
写入 B1–B2 画像后 `B1–B2/profile` 6 条（全 B1/B2）；加一条科技类 history 后该
视频被排除且理由出现「你最近在看科技类」；游客默认 `A2–B1`；推荐 URL 调真实
`/api/estimate-cost` 返回同一 videoId（`eXdVDhOGqoE`）。


## 读文章（V1 后端：URL/正文导入 + 逐段翻译 + 进度）

用户需求 #3「读文章」的后端 MVP：粘贴英文文章 URL（或正文）→ 抽取标题与段落 →
按目标语言逐段翻译 → 保存到账号历史、回写阅读进度；读的时候查词复用 `/api/define`。
规格：[specs/019](../specs/019-reading/spec.md)。**仅后端**，阅读器前端下一轮。

### 端点（全部需登录；游客/未登录 403）

| 端点 | 说明 | 成功 / 失败 |
|---|---|---|
| `POST /api/article/import` | body `{url}` 或 `{text,title?}`；同用户同 URL 复用 | 200 `{articleId,title,site,sourceUrl,lang,wordCount,createdAt,paragraphs,reused}`；400/422/429/503 |
| `POST /api/article/{id}/translate` | body `{targetLang}`（zh-CN 缺省 / vi-VN）；只补缺失段 | 200 `{articleId,targetLang,status,total,translated,failed,failedIndices,model,batches}`；400/404/429/503 |
| `GET /api/article/{id}?targetLang=` | 标题 + 段落（含 `translation`/`translationFailed`）+ 进度 + stats | 200；400/404/503 |
| `GET /api/articles` | 当前用户文章列表（最新在前，带 `paragraphCount`/`progress`） | 200；503 |
| `DELETE /api/article/{id}` | 删文章 + 段落/译文/进度 | 200 `{ok,articleId}`；404/503 |
| `PUT /api/article/{id}/progress` | body `{paragraphIdx}`（0-based，< 段数） | 200 `{ok,articleId,paragraphIdx,updatedAt}`；400/404/422/503 |

身份选择：**需登录，游客 403**（二选一中的严格版）。文章与进度要「保存回历史」，
必须归属账号；游客 Cookie 换设备即丢，不做游客文章系统。跨用户读/译/删/进度
一律 404（不泄露存在性）。

### 表（迁移 `0011_reading`）

| 表 | 内容 |
|---|---|
| `articles` | `id` TEXT PK、`user_id`、可空 `source_url`（最终 URL；粘贴正文 NULL）、`title`、`site`、`lang`（en）、`word_count`、`created_at`；`ix_articles_user_created(user_id, created_at)`；部分唯一索引 `ux_articles_user_url(user_id, source_url) WHERE source_url IS NOT NULL` 保证同用户同 URL 一篇 |
| `article_paragraphs` | `article_id` FK CASCADE、`idx`、`text`；PK(`article_id`, `idx`) |
| `article_translations` | `article_id` FK CASCADE、`idx`、`target_lang`（zh-CN/vi-VN）、`text`、`model`、`created_at`；PK(`article_id`, `idx`, `target_lang`)；`text='[未翻译]'` 是失败但可重试的标记 |
| `article_progress` | `user_id` + `article_id` PK、`paragraph_idx`、`updated_at`；文章删除时级联 |

### 正文抽取与抓取边界

- **URL**：只允许 http/https；`socket.getaddrinfo` 解析出**全部 IP**，任一为
  私网/回环/链路本地/组播/保留/未指定（含云元数据 `169.254.169.254` 等）即拒绝；
  字面量 IP 直接检查。重定向用 `follow_redirects=False` 手工跟随，**每跳重新校验**、
  最多 3 跳；超时 10s、响应体 2MB 流式截断；抓取失败统一 **422**。
- **抽取**：`trafilatura`（`requirements.txt` 已加，XML 输出只取 `<p>`/`<h1>`）
  → `readability-lxml + bs4`（可选依赖）→ 标准库 `HTMLParser`（跳过 nav/header/
  footer/aside/script，按 class/id 导航关键词与链接占比过滤，`<p>` 只收正文）。
  后两级缺失不影响端点；正常安装只装 `trafilatura` 即可。
- **清洗/上限**：空段过滤、NFC、空白折叠；最多 200 段、单段最多 4000 字符
  （超出按句/空格截断加 `…`）；粘贴正文整体上限 2,000,000 字符。
- **去重**：URL 规范化（去 fragment、host 小写、默认端口省略）后先查已有；
  重定向后按最终 URL 再查一次；并发靠部分唯一索引兜底，命中返回 `reused:true`
  且不再抓取。
- **残余风险**：DNS rebinding（校验到连接之间 DNS 可变；不 pin IP 以免破坏 CDN
  的 TLS/SNI）、系统代理可能用另一套 DNS、JS 渲染页面抽不到正文。新增任意 URL
  抓取路径时必须同时加 scheme/host/IP 黑名单（本条即第一个这样的路径）。

### 翻译（`feature=reading`）

- 按目标语言读已有译文；**已有且不是 `[未翻译]` 的段不重译**，只把缺失段按
  10 段/批送模型；每批先扣 1 个 `AI_DAILY_QUOTA_READING_BATCHES`（默认 60/日），
  成功调用按 `llm.usage_scope("reading", user_id, target_lang=…)` 写 `ai_usage`。
- 模型选择走统一 `quota.degradation_chain(feature="reading")`；返回 JSON
  `{"translations":[{"idx":0,"text":"…"}]}`，按 idx 对齐，容忍围栏/乱序/部分返回；
  vi-VN 输出含 CJK 视为该段失败。
- 失败段写 `[未翻译]`（`model=NULL`），响应 `status:"partial"` + `failedIndices`；
  下次调用只补这些段。完全没有可用模型时同样只写标记，不写假译文。
- 幂等：全部已有译文时 `status:"cached"`、`batches:0`、不调模型。

### 配置（默认值）

| 环境变量 | 默认 | 说明 |
|---|---:|---|
| `READING_FETCH_TIMEOUT_SECONDS` | 10 | URL 抓取超时（秒） |
| `READING_MAX_FETCH_BYTES` | 2097152 | 响应体上限（2MB，流式截断） |
| `READING_MAX_REDIRECTS` | 3 | 最多跟随重定向次数 |
| `READING_MAX_PARAGRAPHS` | 200 | 单篇最多段数 |
| `READING_MAX_PARAGRAPH_CHARS` | 4000 | 单段最多字符 |
| `READING_MAX_TEXT_CHARS` | 2000000 | 粘贴正文整体上限 |
| `READING_TRANSLATE_BATCH_SIZE` | 10 | 每批送模型段数 |
| `AI_DAILY_QUOTA_READING_BATCHES` | 60 | 每用户每日翻译批次数 |
| `RATE_LIMIT_READING_PER_MINUTE` | 10 | 导入次数/分钟/用户（0=关闭） |

### 测试与手动实测

```bash
cd backend
venv/bin/python -m py_compile *.py
venv/bin/python -m pytest tests/test_reading.py -q   # 50 个离线用例（FakeClient + LLM 桩）
venv/bin/python -m pytest tests -q                    # 全量 466（含 12 个博客 + 9 个止血台用例）
```

2026-11-15 8001 临时实例（`/tmp` 数据目录 + 真实 Alembic + mock HTTP/LLM）实测：
粘贴正文 → 2 段；URL 导入 → 标题/2 段/词数；重复 import 同 URL → 同一
`articleId`、`reused:true`、只发 1 次 mock HTTP；zh-CN 与 vi-VN 各翻 2 段且
互不覆盖；再次 zh 翻译 `cached`/0 批；进度与列表正确；`127.0.0.1` / `10.x` /
`169.254.169.254` / `[::1]` / `metadata.google.internal` / `file://` 全部 422；
删除后 404；第二个用户读第一用户文章 404。

## 官方博客（V1：Markdown + RSS + 公开只读）

站内「官方博客」频道：内容来自仓库内 `content/blog/*.md`，**不用数据库、没有后台 CMS、没有新增迁移**。规格：[specs/020-blog](../specs/020-blog/spec.md)。

### 端点（全部公开只读，无需登录）

| 端点 | 成功 | 失败 |
|---|---|---|
| `GET /api/blog/posts` | `200 {"posts":[{slug,title,date,excerpt,tags,lang,readingMinutes}],"count":N}`，日期倒序 | 503（目录缺失/内容坏） |
| `GET /api/blog/posts/{slug}` | `200` 摘要 + `published:true` + `markdown` + `html` | 404（不存在/`published:false`/slug 形状非法）；503 |
| `GET /api/blog/feed.xml` | `200 application/rss+xml`（channel title/link/description/language + 每篇 title/link/guid/description/pubDate） | 503 |

`/api/blog/*` 与 `/api/auth/*`、`/health` 同属公开路径：中间件不要求登录，也**不创建游客身份、不下发 `ln_guest`**（见 `main.py` 的 `_is_public_api_path`）。`API_AUTH_KEY` 是可选的部署级门禁，若设置仍按原规则作用于所有 `/api/*`。

### 内容格式与闸门

- front matter：`title/date/slug/tags/excerpt/published` 六项必填；`slug` 只允许 `a-z0-9-` 且全目录唯一；`published:false` 的文章不出现在列表/详情/RSS。
- 文件 UTF-8、≤256KB；正文 ≤200,000 字符；`README.md` 不作为文章。
- 缺 front matter、字段非法、正文为空、slug 重复 → **503**（宁可不发，也不静默发布半篇文章）。
- 正文开头用于「可发布草稿，运营复核后发布」的 HTML 注释会被剥离，不显示给读者。
- 修改文件即时生效（不做进程缓存），只读、无写入。

### Markdown 渲染与安全

`routes_blog.py` 内置轻量渲染器（不新增 Python 依赖）：标题/段落/粗斜体/行内与围栏代码/列表/引用/分隔线/链接/删除线。安全约定：

1. **源文本先整段 HTML 转义**，再插入受控标签；文章里的 `<script>` 只会成为文本。
2. 链接只放行 `http`/`https`/`mailto` 与相对地址；`javascript:`/`data:` 等降级为纯文本。
3. 不做原始 HTML 透传、不做表格/脚注/嵌套列表；新增渲染能力必须同时补 XSS 用例。

前端 `BlogScreen.tsx` 用 `react-markdown` 渲染 Markdown（默认不执行原始 HTML），并 `skipHtml`；后端返回的 `html` 字段留给 RSS/其他消费方，不通过 `dangerouslySetInnerHTML` 注入。

### 测试与手动实测

```bash
cd backend
venv/bin/python -m py_compile *.py
venv/bin/python -m pytest tests/test_blog.py -q   # 12 个离线用例
venv/bin/python -m pytest tests -q                # 全量 466
```

2026-11-15 8001 临时实例（仓库内 `content/blog/`）实测：未登录 `GET /api/blog/posts` → 4 篇；`GET /api/blog/posts/why-linguatrek` → 元数据 + Markdown + HTML；`GET /api/blog/feed.xml` → RSS 2.0（4 个 item）；未知 slug 404；含 `<script>` / `javascript:` 链接的样例只渲染为转义文本（无标签执行）。


## 用户资料、余额与后台设置（V1 用户需求 1–3 / specs/023）

用户需求 1/2/3 的后端：注册必须设用户名（可改）；独立「用户页」能拿到用户
信息/余额/本月花费/版本；后台可手动调余额、封禁/解封、开关维护模式与写公告。
规格：[specs/023-user-profile](../specs/023-user-profile/spec.md)。**仅后端**，
前端用户页/后台控制台在下一任务。

### 迁移 `0013_user_profile`

| 表 / 列 | 内容 |
|---|---|
| `users.username` | TEXT 可空；新注册必填（旧客户端回落 email 前缀）；**不唯一**（显示名）；迁移回填旧用户为 `@` 前缀 |
| `users.credits` | INTEGER NOT NULL DEFAULT 0；管理员手动发放/扣减，不允许负余额 |
| `users.status` | TEXT NOT NULL DEFAULT 'active'；`active` / `banned` |
| `credit_transactions` | `id` TEXT PK、`user_id`、`delta` INTEGER、`reason` TEXT、`admin_id` TEXT 可空、`created_at`（毫秒）；索引 `(user_id, created_at)`；append-only |
| `app_settings` | `key` TEXT PK、`value` TEXT 可空、`updated_at` INTEGER（秒）；存 `maintenance_mode`（`0`/`1`）与 `announcement`（字符串或 NULL） |

旧库升级：`alembic upgrade head`（**不要**直接 `stamp head`）。未迁移时读接口
降级（维护模式按未开启、摘要 `preliminary=true`），写设置/调账返回 **503** 并
提示先跑迁移；`auth_db.py` 的兼容建表会补 users 三列，保证旧部署仍能登录/注册。

### 端点

| 端点 | 说明 |
|---|---|
| `POST /api/auth/signup` | body 增加 `username`；2–24 字，中文/英文/数字/下划线/连字符，首尾不能空白；缺失/非法 400（**完全不传字段** = 旧客户端，回落 email 前缀）；不要求唯一 |
| `POST /api/auth/login` | user 带 `username/credits/status`；封禁账号密码正确 → **403「账号已被停用」** |
| `GET /api/auth/me` | user 同上；顶层 `isAdmin` 不变；封禁账号旧会话在中间件 403 |
| `PATCH /api/user/profile` | body `{username}`；登录用户改显示名，校验同上；返回 `{"user":{…}}`；游客/未登录 403 |
| `GET /api/user/summary` | 登录用户：`user{id,email,username,credits,memberSince(ms),status}`、`monthSpendUsd`（`ai_usage` 当月 SUM，估算）、`usageToday.minutes`（`watch_events` 当地今天 `watched_seconds`÷60）、`version`（`APP_VERSION`）、`preliminary`（统计源表缺失=true，正常 false）；无数据为 0 |
| `GET /api/admin/users` | 在 021 字段上增加 `username` / `credits` / `status`，并加完整 id `userId`（调账/封禁端点用；展示用 `id` 前 8 位）；搜索同时匹配 email 与 username |
| `POST /api/admin/users/{id}/credits` | body `{delta:int≠0,-100000..100000, reason:1–200 字}`；`BEGIN IMMEDIATE` 原子更新余额 + 写流水；扣后 <0 → 400 余额不足；用户不存在 404；返回 `{"credits":新余额}` |
| `PATCH /api/admin/users/{id}` | body `{status?: 'active'|'banned'}`；不能封自己/最后一个管理员（400）；`isAdmin` 显式传入 400（不实现）；返回 `{"user":{…,createdAt}}` |
| `GET/PUT /api/admin/settings` | `{maintenance_mode:bool, announcement:str|null}`；PUT 按字段 upsert（`announcement:null` 清空，不传保留）；返回当前值 |

后台错误语义：未登录 401、非管理员 403、用户不存在 404、余额不足/参数非法
400、未迁移 503；`/api/admin/*` 沿用 30 次/分钟限速桶。

### 维护模式

- `app_settings.maintenance_mode=1` 时，**非管理员**访问 `/api/*`（除
  `/api/auth/*`、`/api/admin/*`、`/health`、`/healthz`）返回
  **503 `{"detail":"系统维护中，请稍后重试。"}`**；管理员不受影响。
- 判断在 `main.py` 身份中间件：先拒封禁账号（403），再判维护（503），因此
  游客/未登录也拿到维护提示，而不是业务层的 403。
- 进程内缓存 5 秒（`account.SETTINGS_CACHE_SECONDS`），后台 PUT 会立即刷新；
  多进程部署时每个进程最多滞后 5 秒（与限速同一边界）。
- 设置表缺失/读失败按「未开启」处理，设置表故障不会把整个 API 拖进维护态。

### 安全 / 一致性

- 余额调账用 `BEGIN IMMEDIATE` 事务：校验 → 更新 → 追加流水一次提交；并发
  调账不丢更新、不会出现「扣成负数」或「余额变了没有流水」。
- 封禁不删除会话：旧 Cookie 下一次 `/api` 请求被 403，解封后自动恢复；登录
  端点单独返回 403，便于前端区分「密码错」与「账号被停用」。
- 管理员身份仍只看 `ADMIN_EMAILS`；不新增 role 表、2FA、审计日志（沿用
  specs/021 已知边界；本次流水只记录调账操作者 `admin_id`）。
- 用户名不唯一：它是显示名，不作为登录凭据（登录仍用 email）。

### 测试与手动实测

```bash
cd backend
venv/bin/python -m py_compile *.py
venv/bin/python -m pytest tests/test_user_profile.py tests/test_migrations.py -q  # 32 + 迁移用例
venv/bin/python -m pytest tests -q                                                # 全量离线
```

`tests/test_user_profile.py` 覆盖：注册合法/回落/非法、登录与 me 新字段、
改用户名、余额正负/不足/流水/并发原子、封禁后旧会话与登录 403、解封恢复、
不能封自己/最后管理员、settings 读写、维护模式 503（管理员不受影响）、
游客 403、旧库降级。迁移用例覆盖 0013 升级/回滚与旧用户 username 回填。

8001 临时实例（`/tmp` 数据 + 真实 Alembic + `ADMIN_EMAILS`）实测：
注册带用户名 → `/api/auth/me` 有 credits=0 → 管理员调 +100 → `/api/user/summary`
显示余额 100 → 封禁后旧会话与登录 403 → 维护模式普通用户 503、管理员 200。



## 后台止血台（M1 ⑥，只读聚合）

用户需求 #12「后台」的 MVP：出事时在一页里看清「用户量/活跃、AI 花费与配额、
任务状态、错误概览」。**这四个读端点**只读（`PRAGMA query_only = ON`，防误
写）；封禁/调余额/维护模式等写操作见上文「用户资料、余额与后台设置」
与 [specs/023](../specs/023-user-profile/spec.md)。规格：
[specs/021-admin](../specs/021-admin/spec.md)。

### 管理员身份

- `ADMIN_EMAILS`：逗号分隔、大小写不敏感的邮箱名单；默认空 = **没有管理员**
  （所有 `/api/admin/*` 对任何登录用户 403）。改完需重启后端（启动时读取）。
- `/api/auth/me` 登录时返回顶层 `isAdmin: true|false`；`user` 对象自 0013 起为
  `{id,email,username,credits,status}`，游客响应仍是 `{user:null,guest:true}`。
- 不建 role 表：身份只是环境变量判断（写操作另见 specs/023）。

### 端点（全部需登录 + 管理员；失败 401/403）

| 端点 | 成功 | 口径 |
|---|---|---|
| `GET /api/admin/stats` | 200 | `users{total,new7d,activeToday,guests}`、`ai{todayCostUsd,monthCostUsd,todayCalls,todayByFeature}`、`jobs{failed,running,pendingRetry}`、`generatedAt` |
| `GET /api/admin/users?limit=50&offset=0&search=` | 200 | `users[{id(前8位),userId(完整),email,username,credits,status,createdAt,monthCostUsd,eventCount,lastActiveAt}]` + `total/limit/offset/hasMore`；按注册时间倒序；搜索匹配 email/username |
| `GET /api/admin/usage?days=7` | 200 | `rows[{day,feature,calls,inputTokens,outputTokens,costUsd}]` + `daysSummary` + `totals`；`days` 夹在 1..90 |
| `GET /api/admin/health` | 200 | `health`（/healthz 快照；**始终 200，由 `health.status` 表达 degraded**）+ `disk{dataDir,sizeBytes}` + `failedJobs`（最多 10 条，按 `updated_at` 倒序） |

- 「今天/当月」按 `AI_QUOTA_TIMEZONE`（默认 Asia/Shanghai）划分，与
  `ai.ledger` 的 `usage_date` 同口径；成本是账本 `est_cost_usd` 估算值，不是真实账单。
- `activeToday` = 当地今天内 `learning_events.occurred_at` 或
  `attempts.answered_at` 出现过的去重 `user_id`。
- `guests` = `GUEST_DATA_DIR` 下 64 位小写十六进制目录数（只读，不建目录）。
- `jobs.pendingRetry` = `queued + partial`（等待/可续传），与 `failed` 分开。
- 旧库没跑迁移时统计字段降级为 0/空并照常 200；`health` 会如实显示
  `db.migrations.current` 与 degraded 详情。
- 限速桶 `admin`：30 次/分钟/登录用户（`RATE_LIMIT_ADMIN_PER_MINUTE`，0 关闭），
  超限 429 + `Retry-After`。

### 前端入口

`isAdmin` 为真时顶栏显示「止血台」按钮（`data-testid="admin-entry"`）→
`frontend/src/components/AdminScreen.tsx`：总览卡片、7 天用量表、用户表
（搜索/分页）、健康与失败任务；中越双语（`admin.*`）；表格各自横向滚动，
375px 下页面本身不横向滚动。API 客户端在 `frontend/src/lib/admin.ts`。

### 测试与手动实测

```bash
cd backend
venv/bin/python -m py_compile *.py
venv/bin/python -m pytest tests/test_admin.py -q            # 9 个只读用例
venv/bin/python -m pytest tests/test_user_profile.py -q     # 32 个账号/余额/维护用例
venv/bin/python -m pytest tests -q                           # 全量离线
cd ../frontend && npx tsc -b && npm run check:i18n
```

8001 临时实例（`/tmp` 数据 + `ADMIN_EMAILS`）：管理员四端点 200，普通用户
403、未登录 401；stats 的今日花费/活跃/失败任务与手工造数一致。
前端 Chromium 375×844 实测：管理员顶栏入口可见、AdminScreen 四区块渲染，
`documentElement.scrollWidth = 375`（页面无横向溢出）、表格容器 `overflow-x:auto`
（表宽 640 > 视口 335，只在容器内滚动）。


## 多语言目标语言（targetLang，P0）

规格：[specs/012-i18n-multilingual](../specs/012-i18n-multilingual/spec.md) §5.3–§5.10、§6。P0 范围 = **目标语言**（翻译/总结/词典/缓存/模型路线），UI 语言与 `/api/settings` 属后续任务。

### 请求参数与响应字段

| 端点 | 新增参数 | 缺省 | 响应/落盘 |
|---|---|---|---|
| `GET /api/models` | `?targetLang=` | zh-CN | 加 `targetLang`、`recommended`；`default` 为该语言路线首个可用模型 |
| `GET /api/estimate-cost` | `?targetLang=` | zh-CN | 加 `targetLang`、`recommendedModel` |
| `POST /api/process-video` | body `targetLang`（也接受 `target_lang`） | zh-CN | 返回的缓存 payload 带 `target_lang` / `source_lang` / `prompt_version` |
| `POST /api/process-video-stream` | 同上 | zh-CN | 所有 SSE 事件带 `targetLang`；`meta` 另带 `sourceLang`、`promptVersion` |
| `POST /api/process-subtitle` | 同上 | zh-CN | 缓存 payload 带 `target_lang`；非中文 `summary` 为空 + `summary_kind="episode_label"` |
| `GET /api/shows/{show_id}/processed` | `?targetLang=` | zh-CN | 返回 `{processed, targetLang}` |
| `GET /api/history`、`GET/DELETE /api/history/{filename}` | `?targetLang=` | zh-CN | 列表项加 `targetLang`；只在对应语言目录解析/删除 |
| `POST /api/define` | body `targetLang`（也接受 `target_lang`） | zh-CN | 加 `targetLang`，可选 `pos_label` / `example_translation` |

- 语言代码经 `languages.resolve_target_lang()` 规范化（`zh`/`vi` 等别名可用）；**非法代码 400** `{"detail":"不支持的语言代码：xx-XX"}`。
- JSON 字段 `zh_text` / `zh_word` / `zh` 是**历史兼容名**，值 = 当前目标语言；语言标记在容器级（`target_lang` / `targetLang`），不要从文本猜语言。
- 未配 Key 的候选模型自动跳过；运行中失败不自动换厂商（沿用 010 的「不偷偷故障转移」）。

### 数据目录（按语言隔离）

```
data/users/<user_id>/history/                     # zh-CN 兼容位（长期保留）
├── <channel>_<date>_<videoId>.json               # 中文视频/剧集缓存
├── dictionary_cache.json                         # 中文词典缓存
└── vi-VN/                                        # 其他语言：一个语言一个目录
    ├── <channel>_<date>_<videoId>.json
    └── dictionary_cache.json
```

- **必须**通过 `storage.history_dir(target_lang)` / `storage.dictionary_cache_file(target_lang)` 取路径；不要在路由里手拼 `history_dir()/lang/...`。
- 读取缓存时校验 payload 的 `target_lang`（旧文件缺省 = zh-CN）；与请求语言不一致视为未命中，绝不返回错误语言的译文。
- 删除只删当前语言的一份；同一视频的另一语言缓存保留。
- 总结随视频缓存文件（不另设总结缓存）；旧中文缓存只在正常写盘（学习计数/自愈）时补 `target_lang`，不做批量迁移。

### 模型路线

| 语言 | 代码默认路线 | 环境变量覆盖 |
|---|---|---|
| `zh-CN` | `deepseek-chat` → `gemini-2.5-flash` | `MODEL_ROUTE_ZH_CN` |
| `vi-VN` | `gemini-2.5-flash` → `qwen-plus` → `deepseek-chat` | `MODEL_ROUTE_VI_VN` |

- 每语言首选用 `DEFAULT_MODEL_ZH_CN` / `DEFAULT_MODEL_VI_VN` 覆盖；全局兜底仍是 `DEFAULT_MODEL`。
- `qwen-plus` 用 `QWEN_API_KEY` + `QWEN_BASE_URL`（国际站/大陆站端点不同，**代码不写死**）；缺任一视为不可用并跳过。
- 大陆部署不配 `GEMINI_API_KEY` → Gemini 自动跳过，路线落到 Qwen/DeepSeek；Gemini 不进大陆降级链（降级链逻辑见 `ai/quota.py`）。

### 词典策略

| 目标语言 | 查词顺序 |
|---|---|
| `zh-CN` | 语境缓存 → ECDICT（`data/ecdict.db`）→ LLM 候选链 |
| `vi-VN` | 语境缓存 → **跳过 ECDICT** → LLM 候选链 |

- ECDICT 只在 zh-CN 命中；越南语即使本机装了 ECDICT 也不返回中文静态释义。
- 缓存键 = `(target_lang, NFC(casefold(word)))`，落盘到该语言的 `dictionary_cache.json`；同词不同语言互不命中。
- `/api/define` 失败（所有候选都失败）返回 502，不写缓存；本地命中仍 `source: "local"` 且不带 `model`。
- 账本记录 `target_lang`，但**不按语言拆日限额**（P0 仍按 `(user_id, day, feature)` 计数）。

### 测试

```bash
venv/bin/python -m pytest tests/test_i18n_target_lang.py -q   # 目标语言 P0（全离线）
```

## 迁移与事件日志（M1：Alembic + learning_events）

数据库 schema 从 M1 起由 **Alembic** 管理（`alembic.ini` + `migrations/`）。基线迁移 `0001_baseline` 复刻 `auth_db.py` 原有的 `users`/`sessions`/`idx_sessions_expires`；`0002_learning_events` 建学习事件表；`0003_cost_ledger` 建 AI 成本账本 `ai_usage` 与日配额 `ai_quota`；`0004_target_lang` 给 `ai_usage` 加可空 `target_lang`（默认 `zh-CN`，旧行不改写）；`0005_jobs` 建任务表 `jobs`（含未完成任务的**部分唯一索引**，保证同一内容同语言只有一个在跑的任务）；`0006_review_engine` 建复习三表 `word_states` / `review_logs` / `word_sources`（M2，见上文「复习引擎」）；`0007_quiz` 建理解题三表 `content_items` / `questions` / `attempts`（M3，见上文「理解题」）；`0008_weekly_report` 建观看事件 `watch_events` 与周报快照 `weekly_reports`（M5，见上文「学习事件上报与周报」）；`0009_placement` 建定位测三表 `placement_sessions` / `placement_answers` / `user_profiles`（M4，见上文「能力定位测与能力画像」）；`0010_discover` 建内容发现缓存/审计表 `discover_queries`（V1，见上文「内容发现」）；`0011_reading` 建读文章四表；`0012_exam` 建考试练习两表（V2，见上文「考试练习」）；`0013_user_profile` 给 `users` 加 `username`/`credits`/`status`（旧用户 username 回填 email 前缀）、建余额流水 `credit_transactions` 与应用设置 `app_settings`（V1 用户需求 1–3，见上文「用户资料、余额与后台设置」）。应用不再为**新表**写「连库即建表」，`auth_db.py` 里的 `CREATE TABLE IF NOT EXISTS` 只作为旧部署/测试的兼容路径保留。

命令都在 `backend/` 下执行：

```bash
venv/bin/alembic upgrade head            # 新库：从零建到最新（0001 → … → 0013_user_profile）
venv/bin/alembic current                 # 看当前版本

# 已有 data/app.db（只有 users/sessions，没有 alembic_version）：先纳管再补建新表
venv/bin/alembic stamp 0001_baseline     # 只写版本号，不执行 DDL、不动数据
venv/bin/alembic upgrade head            # 补建 learning_events / 账本 / jobs / 复习三表 / 理解题三表 / 周报两张 / 定位测三表 / 发现缓存表 / 读文章四表 / 考试练习两表 / 用户资料三列与余额流水、应用设置两表

venv/bin/alembic stamp head              # 已经是最新版本的库：只标最新，不执行 DDL
```

- 数据库路径与运行时同源：默认 `data/app.db`，可用 `AUTH_DB_PATH` 覆盖（迁移命令与 `config.py` 都读它）。
- 基线迁移**幂等**（用 inspector 判断表/索引是否存在）：旧库直接 `upgrade head` 不会重建 `users`/`sessions`、不会动数据，只补缺的表；仍建议先备份 `data/app.db`。
- **不要对旧库直接 `stamp head`**：会把 `0002`–`0013` 都标记成已应用，`learning_events` / 账本 / 任务表 / 复习三表 / 理解题三表 / 周报两张 / 定位测三表 / 发现缓存表 / 读文章四表 / 考试练习两表 / 用户资料列与余额流水、应用设置永远不会被建出来。正确顺序是 `stamp 0001_baseline` → `upgrade head`（或直接 `upgrade head`）。
- `downgrade` 会 DROP 表（`0001` 的 down 会删 `users`/`sessions`），只用于空库/测试回滚，别在真实库上跑。
- 启动时 `main.py` 的 lifespan 只读检查一次迁移状态：库存在但没迁移会打 WARNING（启动照常成功）；`emit_event` 在表缺失时跳过写入并记 ERROR，学习主流程不受影响。
- 新迁移：`venv/bin/alembic revision -m "说明" --rev-id 0014_xxx`（id 递增）；**新表一律写迁移，不要再加到 `auth_db.py` 的建表里**。

学习事件（`events.py`）：

- 表：`learning_events(id, user_id, device_id, session_id, event_type, content_ref, payload, occurred_at, created_at, pseudonym_id)`；索引 `(user_id, occurred_at)` 与 `(event_type, occurred_at)`。
- **append-only**：只有 `emit_event()` 追加与 `query_events()`（仅开发/测试）读取，**没有改/删接口**，也**没有对外 HTTP 端点**（前端埋点在下一阶段接）。
- `occurred_at`：客户端毫秒时间戳（缺省用服务端时间）；`created_at`：服务端毫秒时间戳；`payload`：JSON 文本（dict/list，UTF-8 原文，不做二次转义）。
- `pseudonym_id = HMAC-SHA256(EVENTS_PSEUDONYM_SALT, user_id)`；未设盐时用开发默认盐并告警一次，**生产必须设置 `EVENTS_PSEUDONYM_SALT`**。按计划书 §8.4，删除权口径（D-10）定稿后明文 `user_id` 会按表级矩阵迁移，事件表最终只靠假名归属。
- `event_type` 暂不设 CHECK 约束（事件字典 v1 未定稿），示例：`video_open` / `block_visible` / `quiz_answer` / `word_review`。
- 测试：`venv/bin/python -m pytest tests/test_migrations.py tests/test_events.py -q`（迁移全流程 + append-only 代码层断言）。

## 健康检查与结构化日志（M1c）

### 两个探针

| 端点 | 用途 | 行为 |
|---|---|---|
| `GET /health` | 存活（liveness） | 固定 `{"status":"ok"}`，不碰数据库 |
| `GET /healthz` | 就绪（readiness） | `{status, version, db, uptime_seconds, time}`；DB 只读检查，失败 `503` + `status=degraded`，从不 500 |

`/healthz` 字段：

```json
{
  "status": "ok",
  "version": "0.0.0-dev",
  "db": {"ok": true, "migrations": {"current": "0004_target_lang", "head": "0004_target_lang"}},
  "uptime_seconds": 12.3,
  "time": "2026-11-14T20:16:10.619Z"
}
```

- `db.ok`：SQLite 是否可读（以 `mode=ro` 打开，**不建库、不建表、不写版本号**）。
- `db.migrations.current` / `head`：当前库版本与代码里的 Alembic head（用 `ScriptDirectory` / `MigrationContext` 只读读取）。**库可读但迁移落后时仍是 200**，用 `current != head` 判断并告警；不要靠 `/healthz` 自动跑迁移。
- `uptime_seconds`：进程启动至今（monotonic）；`time`：UTC ISO8601。
- `version`：`APP_VERSION` 环境变量 > 已安装包元数据 > `0.0.0-dev`；发布时建议注入 tag/commit。

### 访问日志（每请求一行 JSON）

默认 `LOG_JSON=1`，每个请求输出一行（字段固定，不含 query/body/header）：

```json
{"event":"http_request","request_id":"7b1e5b4a1f16471d933434fd9122c074","method":"GET","path":"/health","status":200,"duration_ms":1.23,"time":"2026-11-14T20:16:10.619Z","level":"info","logger":"linguatrek.access"}
```

- `request_id`：优先复用合法的 `X-Request-ID`（8–64 位 `[A-Za-z0-9._-]`），否则生成 UUID hex；同一 id 写进响应头 `X-Request-ID` 与 `request.state.request_id`，4xx/5xx/异常日志都能对上。
- `duration_ms`：从收到请求到响应开始的时间（普通请求即处理耗时；SSE 是首包耗时）。
- `user_id`：仅已登录请求出现；未登录不记 Cookie、不记邮箱。
- **脱敏**：只记 `request.url.path`，不读 query/body/header，所以密码、`X-API-Key`、query 里的 API Key 不会进访问日志。HTTP 客户端（httpx/httpcore）的 INFO 日志也压到 WARNING，避免完整 URL 带 query 泄露。
- 4xx 记 `warning`、5xx 记 `error`、其余 `info`；未处理异常另有一条 `linguatrek.error` 日志，带 `request_id` 和 `stack`，响应为 `500 {"detail":"服务器内部错误","request_id":...}`。
- `LOG_JSON=0` 输出人类可读纯文本；`LOG_LEVEL` 控制应用日志级别（默认 `INFO`）。应用内访问日志会接管 uvicorn.access（两种格式都不会每请求两行）。
- 测试：`venv/bin/python -m pytest tests/test_observability.py -q`。

CI（`.github/workflows/ci.yml`）在后端 job 里跑 `py_compile` + 全量离线测试，前端 job 跑 `npm ci` + `tsc -b` + `vite build`；不需要 secrets。

## AI 成本账本与三层配额（M1b）

目标：运营能一条 SQL 回答「用户 X 本月花了多少美元、花在哪个功能、哪种目标语言」。`ai_usage` 由 `0003_cost_ledger` 建表、`0004_target_lang` 加 `target_lang`；运行时只追加/累加，不做历史回写。

### 表与字段

| 表 | 字段 | 说明 |
|---|---|---|
| `ai_usage` | `id, user_id, feature, model_id, provider, input_tokens, output_tokens, calls, est_cost_usd, occurred_at, created_at, usage_date` | 每次成功模型调用一行，**append-only**；`usage_date` 是写入时按 `AI_QUOTA_TIMEZONE` 派生的日桶 |
| `ai_quota` | `(user_id, day, feature)` 主键 + `used_units, limit_units` | 当日已用/日限额，UPSERT 原子递增 |

- 索引：`(user_id, usage_date)`（本月/日预算）、`(feature, usage_date)`（功能成本）、`(usage_date)`（全局日预算）。
- `feature` 枚举：`translate` / `summary` / `define` / `local_show`；`model_id` 用 `MODEL_CATALOG` 的目录 id 定价。
- 价格来自 `MODEL_CATALOG.in/out`（USD / 1M tokens）；**未知/缺价按目录里已知最贵计，绝不当 0**（当前目录里 DeepSeek 两价均为 `None`，会按 Gemini 2.5 Flash 的已知价计；目录完全没有已知价时才用保守兜底并告警）。
- 记账失败（表未迁移/库不可写）只记日志并返回 `None`，翻译/查词主流程不受影响。

### 一条 SQL 回答「用户 X 本月」

```sql
SELECT feature, SUM(est_cost_usd) AS usd, SUM(calls) AS calls
FROM ai_usage
WHERE user_id = ? AND usage_date >= '2026-11-01' AND usage_date < '2026-12-01'
GROUP BY feature ORDER BY usd DESC;
```

代码里等价入口：`ai.ledger.monthly_spend(user_id, "YYYY-MM")`、`ai.ledger.daily_usage(user_id, feature, "YYYY-MM-DD")`。

### 三层配额（硬闸，不是提醒）

1. 每用户每功能日限额：`AI_DAILY_QUOTA_TRANSLATE_BATCHES=60`（1 批 ≤20 块 ≈ 2 分钟视频，≈120 分钟/日）、`AI_DAILY_QUOTA_SUMMARY=10`、`AI_DAILY_QUOTA_DEFINE=200`、`AI_DAILY_QUOTA_LOCAL_SHOW_BATCHES=60`；0 = 关闭该功能。
2. 每用户日预算：`AI_DAILY_BUDGET_USER_USD`（默认 1.0，0 = 不启用）。
3. 全局日预算：`AI_DAILY_BUDGET_GLOBAL_USD`（默认 20.0，0 = 不启用）。

超限抛 `ai.ledger.QuotaExceeded`（`status_code=429`）；`/api/define` 直接返回 HTTP 429 + 中文提示，翻译/总结按原链路降级/落占位，不会白花钱。**未跑 0003 迁移的库会 fail-open**（记 WARNING、放行），上线前必须 `alembic upgrade head`。

### 降级链

`ai.quota.degradation_chain(feature, preferred_model)`：首选（可用时）→ 同 provider 更便宜 → 另一个可用 provider（按目录价从低到高）。只纳入 `llm.is_available()` 的模型。**大陆口径（`AI_MODEL_REGION=auto` 且默认模型是 DeepSeek，或显式 `cn`）不会把 Google Gemini 放进自动降级链**；`global` 才包含。

### 测试

```bash
cd backend
venv/bin/python -m pytest tests/test_ai_ledger.py tests/test_migrations.py -q
```

覆盖：迁移到 head、记账读回、未知价按最贵、记账失败不抛、配额 UPSERT/超限 429、预算硬闸、未迁移 fail-open、降级链顺序（大陆不含 Gemini / 海外包含）、mock provider 的 usage 落库、`/api/define` 429。

## 任务表与断线续传（M1 ⑤：jobs + SSE 重连）

规格依赖：计划书 §7.3 A-4 / §8.1 `jobs`、[specs/001-streaming-pipeline](../specs/001-streaming-pipeline/spec.md)。目标：**刷新/断网后接着看已生成的字幕，不重复付费**。

### 表与状态机

`jobs`（迁移 `0005_jobs`）：`id`（uuid4 hex）/ `user_id` / `kind`（`process_video` / `local_show`）/ `content_ref`（YouTube videoId）/ `target_lang` / `status` / `cursor` / `payload`（JSON 元数据）/ `error` / `created_at` / `updated_at`。

```
queued ──开始──▶ running ──每批落盘──▶ running（cursor 前进）
running ──正常结束──▶ done
running ──断线/取消──▶ partial（cursor>0）| queued（还没生成）
queued/running/partial ──显式错误──▶ failed
```

- `cursor` = **已落盘译文的有效 block 数**（仍是 `[未翻译]` 的不算），只增不减（SQL `MAX(cursor, ?)`）；`payload.total` 是总句数。
- **产物就是 `history/` 下按批落盘的缓存 JSON**（`_stream_translate` 每批写盘）：job 不复制字幕正文，删缓存 → `GET /api/jobs/{id}` 的 `canResume=false`、续传请求 410 并把任务标 failed。
- **幂等**：同一 `(user_id, kind, content_ref, target_lang)` 同时最多一个未完成 job（`jobs.create_or_reuse` 进程内锁 + 迁移里的部分唯一索引 `ux_jobs_active` 兜底）。普通请求不带 `jobId` 也会复用它；`done/failed` 的历史任务不参与复用。
- **并发**：同一 job 的执行权在进程内（`jobs.try_acquire`）；第二条流请求拿到 409，或（极端竞态下）收到一条 `event: error` + `code=job_busy`，**都不会产生额外的 LLM 调用**。单进程部署即可，不引入独立 worker（计划书「现在不建」清单）。
- **降级**：库文件/`jobs` 表不存在（旧库没跑迁移）时 `jobs.*` 全部是 no-op（告警一次），SSE 仍按旧行为工作，只是 `meta.jobId = null`、没有断线续传。

### HTTP 契约

| 端点 | 说明 |
|---|---|
| `POST /api/process-video-stream` | body 新增可选 `jobId` + `from`（也接受 snake_case）。不带 `jobId` = 普通请求（命中未完成 job 会自动续）；带 `jobId` = 显式续传，`url` 可省。 |
| `GET /api/process-video-stream?jobId=…&from=N` | 与 POST 续传等价（给 `EventSource`/curl 用）。 |
| `GET /api/jobs/{id}` | `{id, kind, contentRef, videoId, targetLang, status, cursor, total, progress:{done,total}, canResume, active, error, createdAt, updatedAt}`。 |

- **401**：未登录（`main.py` 中间件统一拦截）；**404**：任务不存在/已过期（或旧库未迁移）；**403**：任务属于别的用户；**400**：续传请求的目标语言与 job 不一致；**409**：该 job 正在生成，或已失败（需要重新处理）；**410**：产物（缓存）已不存在，需要重新处理。
- 续传语义：要补哪些句子**由缓存里的 `[未翻译]` 标记决定**，与 `from` 无关——已翻好的 block 不会再送模型；`from` 只用于事件/进度展示。SSE 的 `meta` 带 `jobId`/`cursor`/`total`/`resumed`，`batch` 带 `cursor`/`total`/`jobId`，`done` 带 `jobId`/`cursor`/`total`。
- 已 `done` 的 job 被重连时只回放 `meta → summary → done`，**不调模型**。
- 前端（`frontend/src/lib/jobs.ts` + `App.tsx`）：`meta` 时把 `jobId`/游标写 `sessionStorage`（`yt_bilingual_pending_job`），`batch` 推进游标，`done` 清除；刷新后先 `GET /api/jobs/{id}`，`canResume` 才带 `jobId + from` 重连，`done/failed` 直接丢弃。

### 测试

```bash
cd backend
venv/bin/python -m pytest tests/test_jobs.py tests/test_migrations.py -q
```

覆盖：建 job / cursor 推进（20→40→45）、断线 partial、续传只补缺失 block 且 LLM 调用次数不增加、无 jobId 重提交复用同一 job、已完成回放不调模型、同 job 并发 409 且不产生额外调用、8 线程并发 `create_or_reuse` 只产生一条记录、纯缓存秒开不建任务、旧库无表降级、401/403/404/410。

## 本地剧集视频映射（episodes.json）

如果一部本地剧集的每一集能对应到 YouTube 视频，导入脚本会在 `subtitles/<show_id>/episodes.json` 写映射：

```json
{"S01E01": {"videoId": "3dT8Wm5oI_o", "title": "Lecture 1: Introduction to China's History"}}
```

- 由 `scripts/import_playlist.py` 每次运行生成/更新（与 SRT 是否已存在无关；幂等，保留已有正确映射，同一集视频变动时以新列表为准）。
- `backend/local_shows.py` 是唯一读取入口，`routes_content` 与 `routes_videos` 共用；文件缺失/损坏时按「无映射」处理并打日志，不报错。
- `POST /api/process-subtitle` 新处理与缓存命中都会在 `metadata` 补 `youtube_video_id`（有标题时再补 `youtube_title`）；`GET /api/history/{filename}` 对 `metadata.is_local_subtitle` 为 `true` 的缓存做同样补全，普通 YouTube 缓存不变。
- 补全只改响应，不重写 `history/` 里的缓存文件（即使缓存里留着旧 id，响应也以 `episodes.json` 为准）；没有映射的剧集完全按纯字幕 + 模拟时间轴工作。

## 本地词典（可选，ECDICT）

查词默认**先查本地词典、再调大模型**：本地命中直接返回（秒回、零模型成本），未命中才走原来的模型候选链。**不装词典也能跑**，行为与以前完全一致。

```bash
# 仓库根目录执行：下载 ECDICT CSV（约 63 MB）并构建 data/ecdict.db（约 104 MB，77 万词条）
python3 scripts/fetch_dictionary.py
```

- 运行时路径：默认 `data/ecdict.db`，可用环境变量 `LOCAL_DICT_PATH` 覆盖（相对路径按进程工作目录解析，建议绝对路径）。
- 也兼容 ECDICT 官方 sqlite 版：把 `ecdict-sqlite-28.zip` 里的 `stardict.db` 直接放成 `data/ecdict.db` 即可（查询只依赖 `stardict` 表的 `word/sw/phonetic/definition/translation/exchange` 列）。
- 脚本幂等（已有且校验通过就跳过，`--force` 重建）、带进度、失败会清理临时文件并提示手动下载命令；支持 `--csv` / `--dest` / `--keep-csv`。

### 许可证（重要）

- **ECDICT 仓库代码**：MIT License，Copyright (c) 2025 Linwei（见上游 `LICENSE`）。
- **词典数据**：作者在 README 里说明，数据由 EDictAZ、四六级/GRE 词表、`cdict-1.0-1.rpm`、BNC 语料库等多来源逐步整理，**各来源授权状况不一**，MIT 不能简单覆盖全部数据。
- 因此本项目**不打包、不提交**词典数据：`data/` 已加入 `.gitignore`，只有 `scripts/fetch_dictionary.py` 在本机按需下载。自用无额外负担；**对外分发/商用前请自行复核 ECDICT 的数据授权**。

### 字段映射与已知限制

| `/api/define` 字段 | 本地词典来源 |
|---|---|
| `word` / `lemma` | 词条；`lemma` 取 `exchange` 的 `0:` 项（如 `running` → `run`） |
| `ipa` | `phonetic`，自动补 `/.../` |
| `pos` / `zh` / `definition_en` | **首条**义项的词性 / 中文释义 / 英文释义 |
| `senses` | `translation` 每行一个义项（含 `pos` / `zh` / `definition_en`），保持 ECDICT 原顺序，最多 12 条；`definition` 里按词性对齐的行补 `definition_en`，对不齐为空字符串 |
| `example` | 无（固定空字符串） |

- 没有例句：ECDICT 不提供，卡片里例句区直接不显示。
- 音标是 ECDICT 旧式记法（如 `hә'lәu`），不是严格 IPA，只作读音提示。
- 释义是静态词义、不结合语境；多义词返回多条 `senses`（首条与顶层字段一致），超过 12 条截断；语境释义仍由大模型在未命中时生成。
- 无中文释义的条目视为未命中，交给大模型补中文（查词卡片的目标读者是中文用户）。ECDICT 里约 0.16% 词条的 `translation` 其实是英文转写，同样按未命中处理。
- 本地命中的释义**不会**写进 `dictionary_cache.json`——那里只存大模型生成的语境释义，避免两类释义混用。

## 安全最小集（M1 ⑦）

上线前的「不被一把刷爆 / 不被当成代理」底线，全部进程内实现、零新依赖（计划书 §7.6 的子集）。登录失败锁定与抓取超时/大小上限已补齐；域名解析黑名单按设计不加（理由见下）；后台独立角色 + 2FA、审计日志、提示注入隔离仍未做，已登记到 [运行手册「已知风险」](../docs/运行手册.md#6-已知风险与残余风险)。

### 限速（`ratelimit.py`）

固定窗口 60 秒、内存计数；超限统一 **429 + `Retry-After`**（秒），响应体 `{"detail":"请求过于频繁，请 N 秒后再试。","retryAfter":N}`：

| 桶 | 端点 | 键 | 默认（次/分钟） | 环境变量 |
|---|---|---|---|---|
| `auth` | `POST /api/auth/signup`、`POST /api/auth/login` | 客户端 IP | 10 | `RATE_LIMIT_AUTH_PER_MINUTE` |
| `estimate` | `GET /api/estimate-cost` | 登录用户 | 20 | `RATE_LIMIT_ESTIMATE_COST_PER_MINUTE` |
| `process_video` | `POST /api/process-video`、`POST /api/process-video-stream` | 登录用户 | 6 | `RATE_LIMIT_PROCESS_VIDEO_PER_MINUTE` |
| `define` | `POST /api/define` | 登录用户 | 60 | `RATE_LIMIT_DEFINE_PER_MINUTE` |
| `discover` | `POST /api/discover` | 登录用户 | 5 | `RATE_LIMIT_DISCOVER_PER_MINUTE` |
| `reading` | `POST /api/article/import` | 登录用户 | 10 | `RATE_LIMIT_READING_PER_MINUTE` |
| `admin` | `/api/admin/*` | 登录用户 | 30 | `RATE_LIMIT_ADMIN_PER_MINUTE` |
| `estimate`（游客） | 同上 | `guest:<sha256>` | 10 | `RATE_LIMIT_GUEST_ESTIMATE_COST_PER_MINUTE` |
| `process_video`（游客） | 同上 | `guest:<sha256>` | 2 | `RATE_LIMIT_GUEST_PROCESS_VIDEO_PER_MINUTE` |
| `define`（游客） | 同上 | `guest:<sha256>` | 20 | `RATE_LIMIT_GUEST_DEFINE_PER_MINUTE` |

- 环境变量值为 `0` = 关闭该桶；默认值在 `config.py` 读取。
- 在身份中间件里执行：登录用户按 `user:<id>`、游客按 `guest:<sha256>`、注册/登录按 IP 分别计数；429 会经过最外层 CORS 补跨域头，前端能看到真实错误。
- **单进程有效**：`uvicorn --workers N` 时每个进程独立计数；反向代理后 `request.client.host` 可能是代理 IP，默认**不信任**可伪造的 `X-Forwarded-For`。真实 IP/多进程限速留给部署层（计划书显式接受的残余风险：不做 WAF、bot 指纹、IP 信誉库、渗透测试）。
- `routes_auth.py` 另有登录失败计数（同一 IP 60 秒内失败 10 次），其 429 同样带 `Retry-After`；它与下面的账号锁定叠加（突发层 + 持续层）。

### 登录失败锁定（`auth_lockout.py`）

- 账号 + IP 双维度：同一账号或同一 IP 连续失败 `AUTH_LOCK_THRESHOLD`（默认 **5**）次 → 锁定 `AUTH_LOCK_MINUTES`（默认 **15**）分钟。任一维度命中，锁定期间**即使密码正确**也拒绝。
- 响应统一为 **429 + `Retry-After`（秒）**，不用 423：与全局限速共用同一状态码/响应头契约，前端不必新增错误分支；正文文案「登录尝试次数过多，已暂时锁定，请 N 秒后再试。」账号/IP 两个维度完全相同。
- 成功登录清空该账号与该 IP 的失败计数；锁定到期后计数清零。未达阈值的失败计数在 15 分钟内没有新失败也会过期，避免「一年攒 4 次失败，最后一次被锁」。
- 账号不存在/邮箱格式错误同样计数并锁定；账号键是规范化邮箱的 SHA-256（内存里不存明文），401 与 429 文案都不泄露账号是否存在。
- 仅进程内存，重启清空；`AUTH_LOCK_THRESHOLD=0` 或 `AUTH_LOCK_MINUTES=0` 关闭。日志只记命中的维度/等待秒数/阈值，不记邮箱或 IP 明文。
- 与限速相同的已知边界：单进程有效，`uvicorn --workers N` 时各进程独立计数。

### 字幕获取链路（手动 → 自动 → yt-dlp 回退）

用户需求 4：只要视频有**自动生成的英文字幕**就允许播放。`fetch_english_transcript` 不再只调
`fetch(video_id, languages=['en'])`（精确匹配会漏掉 `en-US` / `en-GB` / `en-orig`），而是：

1. **`list()` 探测轨道**：遍历可用轨道，手动 en 优先，其次自动生成 en；语言码按 `en`
   前缀匹配（`en` / `en-US` / `en-GB` / `en-orig` / `en-auto` 等）。同类型里的优先顺序为
   `en` > `en-orig` > `en-US` > `en-GB` > 其他 `en-*`。
2. **按具体语言码 fetch**：直接 fetch 探测到的 `Transcript` 对象（等价于用它自己的
   `language_code` 调 fetch），不再二次 `list()`，也不会因只传 `['en']` 漏抓区域码轨。
3. **yt-dlp 回退**：API 抛 `NoTranscriptFound` / `IpBlocked` / `RequestBlocked` / 超时 / 其他
   异常时，用 `canonical_watch_url(video_id)` 调 `extract_info(download=False)`，在
   `subtitles`（手动）与 `automatic_captions`（自动）里找 en 前缀轨；再用 `download=True`
   + `skip_download`（只写字幕）+ `writesubtitles` / `writeautomaticsub` +
   `subtitleslangs=[探测到的语言码]` + `subtitlesformat='vtt'` 下载到临时目录，
   `parse_vtt` 清洗后复用现有切句链路（`group_transcript_blocks`）。
4. **来源标记**：返回值是 `EnglishTranscript`（list 子类），带 `subtitle_source`
   （`manual` / `auto` / `manual-ytdlp` / `auto-ytdlp`）与 `auto_generated`（bool）。
   估价、经典处理与流式处理都把它写进 `metadata.subtitle_source` /
   `metadata.auto_generated`，随缓存 JSON 与 SSE `meta` 事件下发（UI 后续可显示
   「自动生成字幕」）。
5. **失败语义**：确实没有任何英文轨 → **422**「该视频没有英文字幕（含自动生成）」；超时
   → **504**；响应体/字幕文件超过 `MAX_FETCH_BYTES`、块数超过 `MAX_TRANSCRIPT_BLOCKS`
   → **400**；yt-dlp 回退也失败时**还原 API 的原始错误**（限流仍 429、无轨仍 422），
   不叠加成 502。

### 抓取边界（`transcripts.py` / `routes_videos.py`）

- `FETCH_TIMEOUT_SECONDS=15`：youtube-transcript-api 的 `requests.Session` 注入 connect/read timeout；yt-dlp 的元数据、频道列表、字幕回退下载与 Whisper 下载传 `socket_timeout`。字幕超时 → **504**；元数据超时沿用原有降级（`Unknown Title`），频道超时返回空列表——都不 500。
- `MAX_FETCH_BYTES=5MB`：`_BoundedSession` 用 `stream=True` + 64KB 分块读取字幕 HTTP 响应，累计超限**立即中断并关闭连接**（不会先读完整 body 再检查）；yt-dlp 回退下载的 VTT 落盘后复核大小；Whisper 下载同时用 yt-dlp `max_filesize` 与落盘大小复核。字幕响应/文件超限 → **400**；音频超限 → 跳过本地转写并给出原因。
- `MAX_TRANSCRIPT_BLOCKS=5000`：解析后字幕块数超限 → **400**。
- 大小/块数用 400 而不是 422：流式路径把 422 当作「无字幕」去走 Whisper 兜底，400 可避免为一份超大字幕再下载一遍音频。所有超时/超限错误都有中文 detail，不会变成 500。
- `MAX_CHANNEL_VIDEOS=200`：单频道硬上限；当前 yt-dlp 用 `playlistend=5` 只取最近 5 条，上限用于防未来调大提取量或异常返回炸内存。频道并发仍是最多 8 个。
- **域名解析黑名单**：YouTube 相关路径的出站目标都由代码派生或先过白名单——`extract_video_id` 只接受锚定的 YouTube host，yt-dlp 只接收 `canonical_watch_url(video_id)` 重建的 URL；`/api/channel-updates` 的频道 URL 先过 `validate_channel_url`（同一套 YouTube host 白名单 + `@handle`/`channel`/`c`/`user` 形态，可选 `/videos`；拒绝 userinfo/端口/query/`file://`/内网地址），再交给 yt-dlp；youtube-transcript-api 自己构造 youtube.com 请求。**V1 读文章的 `/api/article/import` 是第一个「用户提供任意 URL」的抓取路径**，它单独实现了 scheme 白名单 + 解析后 IP 黑名单 + 每跳重定向校验（见上文「读文章」）；其余路径仍锚定 YouTube。新增任意 URL 抓取路径时必须照此同时加 scheme/host 白名单 + 解析后 IP 黑名单。
- 已知边界：`requests` 的 timeout 是连接/读取超时，不是严格「整个请求总时限」；`MAX_FETCH_BYTES` 不覆盖 yt-dlp 元数据/频道列表的 HTML（`extract_flat` 响应很小）；多进程部署时锁定/限速各算各的。

### 全局 LLM 并发闸（`llm.py`）

- async 调用一律走 `llm.generate_json_async()` / `llm.generate_text_async()`：进程级 `asyncio.Semaphore`，默认 `LLM_MAX_CONCURRENCY=4`（`0` = 不限）。
- 只限制「真正在跑的 provider 调用」：排队请求只占协程、不占线程。客户端断开导致协程取消时，许可要等 worker 线程真正结束才释放，避免「取消几次就绕过并发上限」。
- 可观测：`llm.concurrency_snapshot()` 返回 `limit / active / peak / acquired / waited / wait_ms_total / wait_ms_max / wait_ms_histogram`；等待 ≥100ms 输出一行 JSON 到 `linguatrek.llm`：`{"event":"llm_concurrency_wait","wait_ms":…,"active":…,"limit":…}`（与访问日志共用 `JsonFormatter`，一行一个 JSON）。

### URL 白名单（`transcripts.extract_video_id`）

- 只接受四种锚定形态：`youtube.com/watch?v=<11位>`、`youtu.be/<11位>`、`youtube.com/embed/<11位>`、`youtube.com/shorts/<11位>`；主机仅 `youtube.com`（可带 `www.`/`m.`）与 `youtu.be`（可带 `www.`/`m.`），scheme 仅 http/https，videoId 必须 11 位 `[A-Za-z0-9_-]`。
- 用 `urlsplit` + 路径/参数精确匹配，**不用** `re.search` 子串匹配；拒绝 userinfo、显式端口、非 http(s) scheme、协议相对 URL、控制字符/反斜杠、缺失/重复 `v`、11 位以外 id，以及把 YouTube 链接藏在其它域名/路径里的字符串。路由层统一返回 400；流式端点在**开流前**校验（不再 200 + error 事件）。
- 校验通过后，交给 yt-dlp（元数据/Whisper 下载）的 URL 一律用 `transcripts.canonical_watch_url(video_id)` 重建；用户原链接里的 `list=` 等 query 不会带过去，避免被当成播放列表抓取。

### 估价预取缓存上限（`routes_videos.py`）

- `_prefetch_cache` 从无界 dict 改为 `OrderedDict` LRU：默认最多 `PREFETCH_CACHE_MAX_ENTRIES=200` 条、TTL `PREFETCH_CACHE_TTL_SECONDS=600` 秒；超容量淘汰最久未用，过期条目在读写时清理；`0` = 关闭缓存。
- 只用于「估价 → 确认处理」之间复用 metadata/transcript，取一次即消费。

### 测试

```bash
cd backend
venv/bin/python -m pytest tests/test_security_minimum.py tests/test_residual_security.py -q
```

覆盖：固定窗口/429+Retry-After/桶路由与按用户隔离/0 关闭、URL 白名单正反例、缓存 LRU+TTL、并发闸上限与直方图、`/api/define` 确实经过闸门；登录锁定（账号/IP、正确密码仍 429、到期恢复、成功清零、0 关闭、未知账号同文案）、字幕超时 504、超块/超大 400 且非 500、`_BoundedSession` 流式字节上限与 timeout 注入、yt-dlp `socket_timeout`、频道单频道 200 条上限、频道 URL 白名单（拒绝内网/`file://`/任意域名）。

## 关键约定

- 事件循环：所有同步阻塞调用（YouTube 字幕、yt-dlp）在 async 代码里必须经 `asyncio.to_thread` 放进线程；不要直接 `await` 一个同步函数或在 async 生成器里裸调。LLM 调用一律用 `llm.generate_json_async` / `llm.generate_text_async`（内部已含并发闸 + 线程封装），不要自己 `to_thread(llm.generate_json, …)` 绕过闸门。Whisper 转写同理。
- SSE 心跳：`/api/process-video-stream` 在无事件可发时每 `SSE_HEARTBEAT_INTERVAL`（默认 15s，`config.SSE_HEARTBEAT_SECONDS`）发一行 `: ping\n\n`。它只是注释行、没有 `data:`，前端 `consumeSseStream` 会忽略；不要改成携带 data 的事件，也不要改变事件顺序。
- 持久化：用户与会话在 `data/app.db`（SQLite）；每个用户的视频/剧集缓存是 `data/users/<user_id>/history/` 下的 JSON；收藏/订阅是对应用户目录下的 JSON；游客数据在 `data/guests/<sha256>/`（布局相同，认领时按键合并）。本地词典数据是可选的 `data/ecdict.db`（均 gitignore，不入库）。
- 所有用户数据路径必须走 `storage.py`（`history_dir()` / `favorites_file()` / `subscriptions_file()` / `dictionary_cache_file()`），**禁止**在新代码里直接拼 `config.HISTORY_DIR`——否则数据会绕过用户隔离。
- 翻译失败的句子标 `[未翻译]`，下次加载自动补译——改动翻译逻辑时**不要破坏这个自愈闭环**。
- 对应规格：流式管线见 [specs/001](../specs/001-streaming-pipeline/spec.md)，各路由的行为定义见 [specs/](../specs/README.md)。
