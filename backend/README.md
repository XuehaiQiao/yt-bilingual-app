# backend/ — FastAPI 后端

启动：`source venv/bin/activate && uvicorn main:app --port 8000`（入口永远是 `main:app`）。
验证：`venv/bin/python -m py_compile *.py`；离线测试：`venv/bin/python -m pytest tests -q`（测试全程离线、不联网）。环境变量见 [开发指南](../docs/开发指南.md)。

> **默认模型是 `deepseek-chat`**（DeepSeek，国内可直连，大陆首发商用默认）；Gemini 三档保留在 `MODEL_CATALOG` 里作为**海外可选**（大陆不可用/不合规）。默认模型可用环境变量 `DEFAULT_MODEL` 覆盖（必须是目录里的 id，非法值回落 `deepseek-chat`），`/api/models` 的 `default` 字段与 `resolve_model(None)` 都跟随它。

## 文件说明

| 文件 | 职责 |
|---|---|
| `main.py` | 应用装配：CORS、可选 `X-API-Key` 部署闸门、用户会话中间件（Cookie → SQLite → `request.state.user` + 数据目录 ContextVar）、结构化访问日志（request_id + 一行 JSON）、挂载四个路由模块、`/health`（存活）与 `/healthz`（就绪：DB/迁移/版本）。**不放业务逻辑** |
| `observability.py` | 可观测性（M1c）：`JsonFormatter`、请求级 `request_id` ContextVar、访问日志中间件（只记 method/path/status/duration_ms/request_id/user_id，**不记 query/body/header**）、未处理异常兜底（带 request_id + 堆栈）、只读 `/healthz` 快照（SQLite `mode=ro` + Alembic `ScriptDirectory`/`MigrationContext`） |
| `config.py` | 所有配置：`.env` 加载、数据目录（HISTORY/SUBTITLES/SENTENCES/DATA/USER_DATA/AUTH_DB）、安全开关（`CORS_ORIGINS` / `API_AUTH_KEY` / `BROWSER_UI` / `COOKIE_SECURE`）、SSE 心跳间隔（`SSE_HEARTBEAT_SECONDS`）、可观测性（`APP_VERSION` / `LOG_LEVEL` / `LOG_JSON`）、`MODEL_CATALOG`（可选模型清单：provider / 端点 / Key 环境变量 / 价格 / 批间节奏；Gemini 三档标注为仅海外）、`DEFAULT_MODEL`（默认 `deepseek-chat`，可用同名环境变量覆盖）、`resolve_model`（未知/缺省 → 默认模型）、`VOCAB_LEVELS`（词汇水平→prompt 描述） |
| `auth_db.py` | 用户与会话 SQLite：建表、Argon2id 密码哈希/校验、会话 token（库里只存 sha256）、过期清理、登录失败常量时间处理。`users`/`sessions` 的建表是**兼容路径**，新表一律走 Alembic |
| `events.py` | 学习事件日志（append-only）：`emit_event()` 单条追加（失败只记日志、不阻断主流程）、`query_events()` 只读查询（仅开发/测试，不挂 HTTP 端点）、`pseudonym_for()` 假名化、`schema_status()` 迁移自检。**只有 INSERT/SELECT** |
| `ai/ledger.py` + `ai/quota.py` | AI 成本账本与配额（M1b）：`ai_usage` 只追加记账（价格未知按已知最贵、失败不阻断）、`ai_quota` 原子日配额（UPSERT）、三层预算硬闸、模型降级链（同 provider 更便宜 → 另一个可用 provider，大陆不含 Gemini） |
| `routes_auth.py` | `/api/auth/signup`、`/api/auth/login`、`/api/auth/logout`、`/api/auth/me`；`ln_session` Cookie 与登录失败限流 |
| `storage.py` | 当前请求的数据根目录：登录用户 → `data/users/<user_id>/`；无用户 → 回落 `config.HISTORY_DIR`。所有用户数据路径必须从这里取 |
| `llm.py` | 统一大模型调用层：按 `MODEL_CATALOG` 的 `kind` 分派「Google 官方 SDK」或「OpenAI 兼容 `<base_url>/chat/completions`」，并提供 `is_available`（有没有 Key）与 `batch_pause`（按厂商限流节奏）。**SDK 调用是同步阻塞的**，调用方在 async 代码里必须用 `asyncio.to_thread` 包一层；`usage_scope(feature, user_id)` 声明调用归属后，成功调用会按 provider usage 写进 `ai_usage`（签名不变，`AI_USAGE_LOGGING=0` 可关） |
| `transcripts.py` | 拿到"待翻译的句子"：YouTube 字幕抓取（失败→清晰中文错误）、切句算法、SRT 解析、yt-dlp 元数据、Whisper 本地转写兜底（可选依赖）。这些函数是同步阻塞实现，async 调用方负责放进线程 |
| `translate.py` | AI 翻译核心：`process_llm_batch`（大模型批翻 + **按 id 对齐**防错位 + 按水平挑生词）、`UNTRANSLATED_MARKER` 自愈约定、`retranslate_marked_blocks`（补译）、`_stream_translate`（逐批落盘的流式生成器）、视频总结。LLM 生成调用经 `asyncio.to_thread` 执行，异常仍照常抛回；批间 `batch_pause` 语义不变；翻译/总结带日配额与降级链，`feature` / `user_id` 缺省取请求上下文（本地剧集传 `local_show`） |
| `routes_videos.py` | `/api/models`（全局模型栏数据源）、`/api/estimate-cost`、`/api/process-video`（经典，移动端用）、`/api/process-video-stream`（SSE，产品核心；流内慢任务期间按 `SSE_HEARTBEAT_INTERVAL`（默认 15s）发 `: ping` 注释行心跳）、`/api/history*`（本地剧集缓存按 `episodes.json` 补 `youtube_video_id`）、`/api/channel-updates`（yt-dlp 频道拉取，放线程并发、最多 8 个） |
| `routes_content.py` | `/api/shows*`、`/api/process-subtitle`（本地剧集：翻译与补译跟随请求 `model`，新处理结果与缓存 payload 记录 `model`，批间隔按 `llm.batch_pause(model)`；有视频映射的集在 `metadata` 补 `youtube_video_id` / `youtube_title`）、`/api/sentences*`（句子精背） |
| `local_shows.py` | 本地剧集 → YouTube 视频映射：`episode_video_map(show_id)` / `lookup_episode_video(show_id, season, episode)` 读取 `subtitles/<show_id>/episodes.json`；缺失/损坏一律降级为无映射并打日志，路径限制在 `SUBTITLES_DIR` 内 |
| `local_dict.py` | 本地离线词典（可选）：`lookup()` 查 `data/ecdict.db`（ECDICT）并映射成 `/api/define` 字段（含多义项 `senses`，`definition` 按词性对齐补英文释义）；惰性只读 sqlite，数据缺失/损坏一律返回 `None`，调用方回落大模型 |
| `routes_user.py` | `/api/define`（词典：`dictionary_cache.json` 语境缓存 → 本地词典 → 「已配 Key 的候选模型」；缺省 `model` 时候选链首选 `DEFAULT_MODEL`；走 LLM 的响应带实际使用的 `model` / `modelName`，本地命中带 `source: local`；模型结果写缓存并带 `senses`，旧缓存读取时自动补全）、`/api/favorites`、`/api/subscriptions`；`/api/define` 先扣词典日配额，超限返回 **429** |
| `requirements.txt` | Python 依赖（`argon2-cffi` 用于密码哈希、`alembic` 用于数据库迁移、`pytest` 用于离线测试/CI；faster-whisper 为可选，见文件内注释） |
| `alembic.ini` / `migrations/` | 数据库迁移：`migrations/versions/0001_baseline.py`（users/sessions）、`0002_learning_events.py`（事件表）、`0003_cost_ledger.py`（`ai_usage` / `ai_quota`）；命令与约定见 [migrations/README.md](migrations/README.md) |

## 用户体系与多用户数据隔离

前端并行开发用的**冻结契约**（状态码/字段不可改）：

| 端点 | 成功 | 失败 |
|---|---|---|
| `POST /api/auth/signup` `{email,password}` | `201 {"user":{"id","email"}}` + 设置 Cookie | `409` 邮箱已存在；`400` 邮箱格式或密码 < 8 位 |
| `POST /api/auth/login` `{email,password}` | `200 {"user":{"id","email"}}` + 设置 Cookie | `401` 邮箱或密码错（不区分，避免账号枚举） |
| `POST /api/auth/logout` | `200 {"ok":true}` 并清除 Cookie | — |
| `GET /api/auth/me` | `200 {"user":{"id","email"}}` | `401 {"detail":"未登录"}` |

- 除 `/api/auth/*` 与 `/health` 外，所有 `/api/*` 都要求登录；未登录统一 `401 {"detail":"未登录"}`。
- Cookie 名 `ln_session`：httpOnly、SameSite=Lax、Path=/、Max-Age=30 天；`Secure` 由 `COOKIE_SECURE=1` 控制（本地 HTTP 默认关）。前端不要读 Cookie，也不要把 token 存 localStorage。
- 本地前后端分离开发时，`localhost` 与 `127.0.0.1` 属于不同 site，浏览器不会在 fetch 里带 SameSite=Lax 的 Cookie；前后端请统一用同一个主机名（都 `127.0.0.1` 或都 `localhost`），或走 Vite 代理。默认 `CORS_ORIGINS=*` 会回显请求 Origin 以兼容 `credentials: include`；公网部署仍应显式设置允许来源。
- **公网多用户浏览器部署不要设 `API_AUTH_KEY`**：它拦所有 `/api`（含 `/api/auth/*`），登录会被 401；把 key 塞进前端 `VITE_API_KEY` 又等于公开密钥。仅「移动端/内部客户端、不跑浏览器 UI」的部署才考虑它（建议同时设 `BROWSER_UI=0`）；`API_AUTH_KEY` 非空且 `BROWSER_UI` 未关闭时，`config.py` 启动会打印警告。
- 登录失败按 IP 内存限流（默认 60 秒内 10 次失败后返回 429），成功登录清零；用户不存在时也会跑一次等价的 Argon2 校验，响应时间不泄露账号是否存在。
- 会话过期行会在读取命中过期会话时删除，并最多每 60 秒批量清理一次。

数据落盘：

```
data/                                  # DATA_DIR（gitignore）
├── app.db                             # AUTH_DB_PATH 默认值；users + sessions + learning_events（Alembic 管）
└── users/<user_id>/                   # USER_DATA_DIR/<user_id>/
    ├── history/                       # 视频/本地剧集缓存；含 dictionary_cache.json
    ├── favorites.json
    └── subscriptions.json
```

- `users(id, email, password_hash, created_at)`：email 统一小写；密码只存 Argon2id 哈希。
- `sessions(token_hash, user_id, expires_at, created_at)`：Cookie 里是 `secrets.token_urlsafe(32)` 的随机 token，库里只存 sha256。
- 词典缓存**按用户隔离**（放在该用户 `history/dictionary_cache.json`）：与视频缓存同一套目录规则，用户的坏缓存不会影响别人；代价只是同词在不同用户间各生成一次，缓存很小，可接受。
- 未登录上下文（测试/脚本）仍回落到 `HISTORY_DIR`（旧 `history/` 目录），保持兼容；正常经 API 的请求一定带用户，不会写到旧目录。
- **旧本地数据不会自动迁移**：升级后原 `history/` 里的个人数据不会出现在任何账号下。需要保留时，登录后从 `/api/auth/me` 或 `sqlite3 data/app.db "select id,email from users"` 拿到 user_id，再手动移动：
  ```bash
  mkdir -p data/users/<user_id>/history
  mv history/*.json data/users/<user_id>/history/
  mv history/favorites.json history/subscriptions.json data/users/<user_id>/ 2>/dev/null || true
  ```
  移动前建议先备份 `history/`。

## 迁移与事件日志（M1：Alembic + learning_events）

数据库 schema 从 M1 起由 **Alembic** 管理（`alembic.ini` + `migrations/`）。基线迁移 `0001_baseline` 复刻 `auth_db.py` 原有的 `users`/`sessions`/`idx_sessions_expires`；`0002_learning_events` 建学习事件表；`0003_cost_ledger` 建 AI 成本账本 `ai_usage` 与日配额 `ai_quota`。应用不再为**新表**写「连库即建表」，`auth_db.py` 里的 `CREATE TABLE IF NOT EXISTS` 只作为旧部署/测试的兼容路径保留。

命令都在 `backend/` 下执行：

```bash
venv/bin/alembic upgrade head            # 新库：从零建到最新（0001_baseline → 0002_learning_events → 0003_cost_ledger）
venv/bin/alembic current                 # 看当前版本

# 已有 data/app.db（只有 users/sessions，没有 alembic_version）：先纳管再补建新表
venv/bin/alembic stamp 0001_baseline     # 只写版本号，不执行 DDL、不动数据
venv/bin/alembic upgrade head            # 补建 learning_events

venv/bin/alembic stamp head              # 已经是最新版本的库：只标最新，不执行 DDL
```

- 数据库路径与运行时同源：默认 `data/app.db`，可用 `AUTH_DB_PATH` 覆盖（迁移命令与 `config.py` 都读它）。
- 基线迁移**幂等**（用 inspector 判断表/索引是否存在）：旧库直接 `upgrade head` 不会重建 `users`/`sessions`、不会动数据，只补缺的表；仍建议先备份 `data/app.db`。
- **不要对旧库直接 `stamp head`**：会把 `0002` 也标记成已应用，`learning_events` 永远不会被建出来。正确顺序是 `stamp 0001_baseline` → `upgrade head`（或直接 `upgrade head`）。
- `downgrade` 会 DROP 表（`0001` 的 down 会删 `users`/`sessions`），只用于空库/测试回滚，别在真实库上跑。
- 启动时 `main.py` 的 lifespan 只读检查一次迁移状态：库存在但没迁移会打 WARNING（启动照常成功）；`emit_event` 在表缺失时跳过写入并记 ERROR，学习主流程不受影响。
- 新迁移：`venv/bin/alembic revision -m "说明" --rev-id 0003_xxx`（id 递增）；**新表一律写迁移，不要再加到 `auth_db.py` 的建表里**。

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
  "db": {"ok": true, "migrations": {"current": "0003_cost_ledger", "head": "0003_cost_ledger"}},
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

目标：运营能一条 SQL 回答「用户 X 本月花了多少美元、花在哪个功能」。表由 `0003_cost_ledger` 创建，运行时只追加/累加，不做历史回写。

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

## 关键约定

- 事件循环：所有同步阻塞调用（LLM SDK、YouTube 字幕、yt-dlp）在 async 代码里必须经 `asyncio.to_thread` 放进线程；不要直接 `await` 一个同步函数或在 async 生成器里裸调。Whisper 转写同理。
- SSE 心跳：`/api/process-video-stream` 在无事件可发时每 `SSE_HEARTBEAT_INTERVAL`（默认 15s，`config.SSE_HEARTBEAT_SECONDS`）发一行 `: ping\n\n`。它只是注释行、没有 `data:`，前端 `consumeSseStream` 会忽略；不要改成携带 data 的事件，也不要改变事件顺序。
- 持久化：用户与会话在 `data/app.db`（SQLite）；每个用户的视频/剧集缓存是 `data/users/<user_id>/history/` 下的 JSON；收藏/订阅是对应用户目录下的 JSON。本地词典数据是可选的 `data/ecdict.db`（均 gitignore，不入库）。
- 所有用户数据路径必须走 `storage.py`（`history_dir()` / `favorites_file()` / `subscriptions_file()` / `dictionary_cache_file()`），**禁止**在新代码里直接拼 `config.HISTORY_DIR`——否则数据会绕过用户隔离。
- 翻译失败的句子标 `[未翻译]`，下次加载自动补译——改动翻译逻辑时**不要破坏这个自愈闭环**。
- 对应规格：流式管线见 [specs/001](../specs/001-streaming-pipeline/spec.md)，各路由的行为定义见 [specs/](../specs/README.md)。
