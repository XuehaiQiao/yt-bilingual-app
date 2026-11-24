# 033 — 账号删除 / 数据导出（M2a 后端）

> 状态：**M2a 后端 + 迁移 + 规格 + 测试已实现** ｜ 2026-11-20
> 依赖：001 用户体系、013/014/015/016/019/021/023/025/027/028/029/030/031/032、
> `docs/项目提案-上线功能.md` §4（数据地图/删除/导出/API 草案）与 §5 账号状态约束
> 范围：后端、Alembic 迁移、规格、测试；**不含前端 UI（M2b）**
> 一句话：提交删除后立即停用并进入 7 天冷静期，可取消/导出；到期硬删除可定位
> 数据；导出 ZIP 含 JSON + 用户文件，24h 临时文件、一次性下载 token、200MB 上限。

## 1. 目标

- 登录用户自助提交删除：密码 + 用户名 + 确认词 `DELETE`；提交即停用（禁止
  AI 调用与学习数据写入），7 天冷静期内可取消或导出，到期硬删除。
- 删除前可导出：ZIP（JSON + 用户文件），密码确认；1 次/24h、3 次/30 天；
  同时只允许 1 个进行中任务；临时文件 24h 过期；下载 token 只存 hash。
- 后台可查看删除请求、到期执行（二次确认 + 原因）；写最小管理员审计。
- 错误码稳定，方便 M2b 前端映射；不泄露账号/任务存在性。
- 删除后：`users`/`sessions`/可定位业务行/`data/users/<id>/`/导出临时文件
  全部清空；旧 Cookie 不再返回用户，旧密码 401；备份按保留期自然过期。

## 2. 非目标（M2a 不做）

- 不做前端 UI/管理台按钮（M2b）；不做邮件/短信/站内通知（本轮无邮件服务）。
- 不做管理员代用户发起删除的 HTTP 端点；`verified_via=support_manual` 只预留
  字段，人工核验的删除由运维按支持 SOP 走（本轮未编码）。
- 不做支付/余额/µUSD（M3）；导出里 `users.credits` 只是旧单位快照。
- 不做备份重写/按用户从备份中擦除（D-2：最长 30 天残留并披露）。
- 不做按用户删除公共缓存/日志/游客目录（无法可靠定位，见 §8）。
- 不做多 worker 分布式任务队列；导出线程是单进程 daemon，任务表是状态真源。

## 3. 已拍板口径

| 决策 | 取值 | 落点 |
|---|---|---|
| D-1 冷静期 | **7 天**；提交即停用；可取消；到期硬删 | `account_lifecycle.COOLDOWN_DAYS` |
| D-2 备份 | 每日 7 份 + 离机 30 天；删除后最长残留 30 天并披露 | 文案 `backupRetentionDays=30`；删除逻辑不碰备份 |
| D-5 导出 | **ZIP（JSON + 用户文件）**；1 次/24h、3 次/30 天；临时文件 24h；密码确认；1 个进行中 | `account_export` / `data_export_jobs` |

无邮件/短信/站内通知；**v1.1（P2-38）起**已提供邮箱验证与自助找回密码（见
`specs/032` §13），密码重置走一次性邮件 token；删除冷静期内 `/api/auth/*`
仍放行，用户可先找回密码再取消/导出。

## 4. 状态机与访问控制

### 4.1 users.status

| 状态 | 含义 | 允许登录 | 业务 `/api/*` | 说明 |
|---|---|---|---|---|
| `active` | 正常 | 是 | 全部 | 默认 |
| `banned` | 封禁 | 密码正确时 403（登录路由） | 旧会话下一次 `/api/*` 403 | 既有逻辑不变；解封恢复 |
| `deletion_pending` | 删除冷静期 | **是**（用于取消/导出） | 除 `/api/auth/*`、`/api/account/*` 外 403 `account_pending_deletion` | 提交删除时立即写；全部会话删除 |

- `deletion_pending` **不是**管理员 `PATCH /api/admin/users/{id}` 可设置的状态；
  `account.STATUSES` 仍只含 `active/banned`，`ALL_STATUSES` 记录全集。
- 中间件判定顺序：banned 403 → pending 403 → 维护模式 503 → 游客/限速 → 路由。
  因此 pending 用户不能调用 AI、估价、复习、读文章、课程、上传等任何业务端点；
  `/api/blog/*`、`/api/library/*` 等公开只读 API 也 403（与需求“普通 `/api/*`”
  一致）。`/health` 不受影响。
- `POST /api/auth/claim-guest` 虽在 `/api/auth/*` 下，但会写学习数据，路由内对
  pending 额外 403；`login/logout/me/registration` 正常。
- 提交删除会删除全部会话并清除当前响应 Cookie；用户必须重新登录才能取消/导出。
  这就是“立即停用”的实现方式（旧 Cookie 立即失效）。

### 4.2 删除申请状态机

```
（无申请）
  │ POST /api/account/deletion（密码+用户名+DELETE）
  ▼
pending（users.status=deletion_pending，due=+7d，会话全删）
  ├─ POST /deletion/cancel（密码）→ cancelled；users.status=active
  ├─ 到期/管理员 force 执行 → completed（users 最后删除）
  └─ 执行失败（文件/DB）→ failed；users 保留 pending，仅管理员重试/支持处理
     （failed 不自动恢复 active：可能已删掉部分业务数据）
```

- 同一 `user_id_hash` 同时只允许一条 `pending`（部分唯一索引）；重复提交 409。
- 执行前再次校验：申请仍为 `pending/failed`、用户仍为 `deletion_pending`、
  不是最后一个管理员；任一不满足标 `failed` 并返回 409/404，不硬删。
- 冷静期未满默认拒绝执行（409 `deletion_not_due`）；用户书面要求立即删除时，
  管理员可传 `force=true`，仍必须填原因并写审计。
- 失败不会显示成功：`users` 保留、申请 `failed`、`error` 保留可诊断信息；
  修好权限/DB 后可再次调用执行接口重试（阶段 1 删除是幂等的）。

## 5. 数据模型（迁移 0024_account_lifecycle）

`backend/migrations/versions/0024_account_lifecycle.py`，`down_revision =
0023_invite_registration`。三张表，**不修改 users/sessions**。

### 5.1 account_deletion_requests

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | `del-<uuid4 hex>` |
| `user_id_hash` | TEXT NOT NULL | `sha256(user_id)`；**不存明文 user id** |
| `requested_at_ms` | INTEGER NOT NULL | 申请时间（ms UTC） |
| `due_at_ms` | INTEGER NOT NULL | 到期时间 = requested + 7d |
| `status` | TEXT NOT NULL | `pending/cancelled/completed/failed` |
| `verified_via` | TEXT NOT NULL | `session_password` / `support_manual`（后者预留） |
| `reason` | TEXT NULL | 用户可选原因 |
| `operator_id` | TEXT NULL | 执行硬删除的管理员/脚本标识 |
| `completed_at_ms` | INTEGER NULL | 终态时间（cancelled/failed/completed 都写） |
| `counts_json` | TEXT NULL | 各表删除条数/文件数；无 PII |
| `error` | TEXT NULL | 失败诊断（截断 1000 字符） |

索引：`ix_account_deletion_requests_user_hash(user_id_hash, requested_at_ms)`、
`ix_account_deletion_requests_status_due(status, due_at_ms)`、部分唯一
`ux_account_deletion_requests_pending(user_id_hash) WHERE status='pending'`。
CHECK：status 枚举、`due_at_ms >= requested_at_ms`、verified_via 枚举。

### 5.2 data_export_jobs

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | `exp-<uuid4 hex>` |
| `user_id` | TEXT NOT NULL | 申请人 |
| `status` | TEXT NOT NULL | `queued/running/ready/failed/expired` |
| `requested_at_ms` | INTEGER NOT NULL | 申请时间 |
| `completed_at_ms` | INTEGER NULL | 生成结束时间 |
| `expires_at_ms` | INTEGER NULL | 临时文件过期时间（生成完成时重置为 +24h） |
| `file_path` | TEXT NULL | 相对 `EXPORTS_DIR` 的 ZIP 路径；不存客户端路径 |
| `size_bytes` | INTEGER NULL | ZIP 大小 |
| `download_token_hash` | TEXT NULL | token 的 sha256；不存明文 |
| `downloaded_at_ms` | INTEGER NULL | 首次成功下载时间 |
| `error` | TEXT NULL | 失败诊断 |

索引：`ix_data_export_jobs_user_requested(user_id, requested_at_ms)`、
`ix_data_export_jobs_status_expires(status, expires_at_ms)`、部分唯一
`ux_data_export_jobs_active(user_id) WHERE status IN ('queued','running')`。
CHECK：status 枚举、`requested_at_ms >= 0`、`expires_at_ms >= requested_at_ms`、
`size_bytes >= 0`。

### 5.3 admin_audit_log

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | `aud-<uuid4 hex>` |
| `actor_id` | TEXT NOT NULL | 管理员/用户/脚本标识 |
| `action` | TEXT NOT NULL | 如 `account.deletion.request` |
| `target_type` / `target_id` | TEXT NULL | 目标类型/id；删除相关 target_id 用申请 id 或 user_id_hash |
| `detail_json` | TEXT NULL | 结构化明细（无密码/token/明文 user id） |
| `request_id` | TEXT NULL | 访问日志的 request_id |
| `created_at_ms` | INTEGER NOT NULL | 毫秒 UTC |

索引：`ix_admin_audit_created`、`ix_admin_audit_actor_created`、
`ix_admin_audit_target`。既有管理台写操作（调余额/封禁/邀请码/设置）在迁移存在时
补写审计；旧库未迁移时降级为结构化日志，不阻断原功能。

## 6. 删除范围（硬删除）

原则：**能定位到 user_id 的行/文件全删；公共缓存不误删；备份自然过期；失败可
诊断、可重试、不假装成功。**

### 6.1 顺序

1. **sessions**（断线）→ 业务表（子表先于父表）→ 提交（阶段 1，一个事务）；
2. **文件目录**：`data/users/<id>/`、`data/exports/<id>/`、导出任务文件（阶段 2；
   失败可重试，不删 users）；
3. **data_export_jobs 行 + users 最后**（阶段 3，一个事务），同时把申请标
   `completed` 并写审计/计数。

SQLite 事务覆盖阶段 1 与阶段 3；文件系统无法与 SQLite 同事务，所以文件失败时
保留 users/申请为 failed，重试幂等。任何一步失败都不显示“已删除”。

### 6.2 表清单与特殊处理

| 对象 | 处理 |
|---|---|
| `sessions` | 按 user_id 删（最先） |
| `auth_tokens` | 按 user_id 删（v1.1 P2-38 新表，含邮箱快照；旧库无表时跳过） |
| `feedback` | 按 user_id 删（v1.1 P2-38 新表；匿名反馈 `user_id IS NULL` 无法归属，保留） |
| `invite_redemptions` | 按 user_id 删；邀请码 used_count 是聚合，不动 |
| `ai_usage` / `ai_quota` | 按 user_id 删原始行；不删公共缓存 |
| `learning_events` | `user_id = ? OR pseudonym_id = HMAC(salt,user_id)` 双口径删 |
| `watch_events` / `weekly_reports` | 按 user_id 删 |
| `word_sources` | 无 user_id：按该用户 `word_states.id` 先删 |
| `review_logs` / `word_states` | 按 user_id 删 |
| `attempts` | 按 user_id 删 |
| `questions` | 无 user_id：按该用户 `content_items.id` 删 |
| `content_items` | 按 user_id 删 |
| `exam_answers` | 无 user_id：按该用户 `exam_sessions.id` 先删 |
| `exam_sessions` | 按 user_id 删 |
| `placement_answers` | 无 user_id：按该用户 `placement_sessions.id` 先删 |
| `placement_sessions` / `assessment_sessions` | 按 user_id 删 |
| `skill_evidence` / `user_skill_profiles` / `user_profiles` | 按 user_id 删 |
| `article_translations` / `article_paragraphs` | 无 user_id：按该用户 `articles.id` 先删 |
| `article_progress` / `articles` | 按 user_id 删 |
| `imported_book_translations` | 无 user_id：按该用户 `imported_books.id` 先删 |
| `imported_books` | 按 user_id 删 |
| `course_events` / `course_attempts` | 按 user_id 删 |
| `generated_courses` | 按 **owner_user_id** 删；见下方说明 |
| `jobs` / `discover_queries` / `credit_transactions` | 按 user_id 删 |
| `data_export_jobs` | 文件删除后按 user_id 删行 |
| `data/users/<id>/` | 整目录删（history/imported-books/favorites/subscriptions/`.upload-staging` 等） |
| `data/exports/<id>/` | 整目录 + 任务 file_path 指向的文件删 |
| `content_teaching_analysis` | **不删**：以 content_ref 为键、无 user_id；本地视频缓存无法可靠归属 |
| `content_difficulty` / `book_chapter_translations` / `public questions` | **不删**：公共缓存/题库 |
| `data/subtitles/`、`data/ecdict.db`、旧 `history/` | **不删**：公共/旧匿名回落数据 |
| `data/guests/<hash>/` | **不删/不猜**：无 user→guest 持久映射；认领后目录通常已合并删除 |
| `backups/` + 离机副本 | **不删**：按 7 日 + 30 天自然过期；文案披露 |
| 日志 | 不追溯删除；按 14–30 天轮转 |

**`generated_courses` 说明**：提案 §4.2 写它“为公共内容缓存”，但 0022 实际实现
是 `owner_user_id` 归属、课程列表/详情只返回本人（specs/030）。它含用户生成内容
与明文 owner id，属于可定位个人数据，因此 M2a 按 `owner_user_id` 删除；这与
“公共缓存不误删”的原则一致——它并不是跨用户共享的公共缓存。

### 6.3 删除后验证

- `users` / `sessions` 无行；`auth_tokens` 无该用户行（含邮箱快照不残留）；
  `feedback` 只保留 `user_id IS NULL` 的匿名反馈；
- 各业务表按 user_id/pseudonym/子表关联为 0；
- `data/users/<id>/`、`data/exports/<id>/` 不存在；
- 旧 Cookie 请求 `GET /api/auth/me` → `{user:null, guest:true}`；
- 旧密码登录 401；
- 备份文件/公共缓存仍存在；
- 申请 `completed`，`user_id_hash`、`counts_json`、`operator_id` 保留，无明文
  user id/email/username；用户填写的 `reason` 在完成时清空；审计同样只留
  hash/申请 id。

## 7. 导出

### 7.1 API 与频率

| 方法 | 路径 | 认证 | 成功 | 失败 |
|---|---|---|---|---|
| POST | `/api/account/export` | 登录 + 密码 | 202 `{jobId,status,requestedAt,expiresAt,downloadToken,downloadPath,limits}` | 401 `password_invalid`；409 `export_busy`；429 `export_rate_limited` |
| GET | `/api/account/exports` | 登录 | `{jobs,limits}`（无 token/hash/路径） | 401 |
| GET | `/api/account/export/{id}?token=` | 登录 + token | 200 `application/zip` | 403 `export_token_invalid`；404 `export_not_found`；409 `export_not_ready`/`export_failed`；410 `export_expired` |
| DELETE | `/api/account/export/{id}` | 登录 | 200 `{ok,jobId,status:"expired"}`（幂等） | 404；409 `export_busy`（生成中不能删） |

- 频率：24h 内最多 1 次、30 天内最多 3 次；按 D-5 字面，**每个创建出来的
  任务（含 `failed/expired`）都计入配额**，不允许靠失败重试绕过；24h 优先于
  30d 返回。
- 同时只允许 1 个 `queued/running`；重复请求 409 `export_busy`。
- 密码错误计入进程内限流（15 分钟 5 次；按操作+用户隔离）；超限 429
  `password_rate_limited` + `Retry-After`。成功一次即清零。
- 下载 token：32 字节随机、库里只存 sha256；明文只在 202 响应出现一次。
  token 是**每个任务一份**的下载凭据（24h 内可重试下载；不是登录凭据，列表/审计
  永不回显）。规格明确：为支持断点/重试，不在首次下载后立即作废；过期/删除
  文件后 410。
- 202 的 `expiresAt` 是预计值；生成完成时按完成时间 +24h 重置。
- 导出可在 `deletion_pending` 期间进行（`/api/account/*` 白名单）。

### 7.2 ZIP 布局

```
manifest.json
README.md
data/profile.json
data/billing.json
data/ai-usage.json
data/review.json
data/activity.json
data/practice.json
data/assessment.json
data/reading.json
data/books.json
data/courses.json
data/learning/
  history/<原相对路径>.json
  favorites.json
  favorites_tombstones.json
  subscriptions.json
files/books/<bookId>/
  meta.json / chapters/*.json / cover.*
```

- `manifest.json`：`formatVersion`、`jobId`、`generatedAt`、`generatedAtMs`、
  `userIdHash`、`scope`（各表行数/文件数）、`excluded`、`notice`、`files`
  （每个文件的 path/bytes/sha256；不含 manifest 自身）。
- `README.md`：范围、单位、排除项、备份 30 天提示、原 EPUB 未持久化说明。
- 每个 JSON 文件在写入时计算 sha256；manifest 最后写入，避免自引用。
- 用户文件原样复制（history/favorites/subscriptions/导入书章节/封面）；跳过符号
  链接、`.lock`、`.tmp-*`、`.upload-staging` 不导出。
- 200MB 上限同时约束未压缩总字节与最终 ZIP；超限标 `failed`（不生成半成品）。
- 条目名统一经 `_safe_arcname`（拒绝绝对路径/`..`）；`file_path` 只存相对路径，
  下载/删除经 `safe_export_path` realpath 校验，防止 Zip Slip/路径穿越。

### 7.3 明确排除

密码哈希、会话/Cookie/token、他人数据、公共缓存与词典
（`content_difficulty` / `content_teaching_analysis` / 公共题库 /
`book_chapter_translations` / `data/subtitles` / `data/ecdict.db`）、备份、日志、
管理员审计、模型 prompt（当前不存）、游客目录。`learning_events` 未列在
§4.4.2 导出清单里，M2a 不导出原始行为事件（`watch_events`/周报在 `activity.json`）。

### 7.4 临时文件生命周期

- 生成目录 `data/exports/<user_id>/` 权限 0700，ZIP 0600；
- 生成完成 → `ready`，`expires=completed+24h`；
- 列表/创建/下载时触发 `cleanup_exports()`：
  - `ready` 且过期 → 删文件、标 `expired`；
  - `queued/running` 超过 2 小时 → 删半成品、标 `failed`（僵尸线程）；
- `DELETE` 立即删文件并标 `expired`（幂等）；
- 账号硬删除会删 `data_export_jobs` 行与导出目录。

## 8. 管理员 API 与审计

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/deletion-requests`（别名 `/api/admin/deletions`） | 列表；`status=all/pending/cancelled/completed/failed`、limit/offset；pending 行带 email/username，完成后 `user=null` |
| POST | `/api/admin/deletion-requests/{id}/execute` | body `{confirm:"DELETE", reason, force?}`；默认冷静期未满 409；force=true 才可提前；失败 500 且申请 failed |
| GET | `/api/admin/audit` | `{entries,total,limit,offset,hasMore}`；`action` 可选精确过滤 |

- 仅 `ADMIN_EMAILS`；未登录 401、非管理员 403；最后管理员保护沿用（申请与执行
  都检查）。
- 执行二次确认：`confirm` 必须 `DELETE`；原因 1–200 字符，写审计。
- 安全脚本 `backend/run_due_deletions.py`：默认 dry-run 列出到期申请；
  `--confirm` 才执行；`--limit`/`--operator` 可配；`--cleanup-exports` 可顺带清理
  过期/僵尸导出文件（可配 cron）；逐条失败不中断，最后非 0 退出。
- 审计动作（至少）：`account.deletion.request`、`account.deletion.cancel`、
  `account.deletion.execute.completed`、`account.deletion.execute.failed`、
  `account.export.request`、`admin.user.credits_adjust`、
  `admin.user.status_update`、`admin.invite.create`、`admin.invite.revoke`、
  `admin.settings.update`。

## 9. 错误码

| code | HTTP | 场景 |
|---|---|---|
| `auth_required` | 401 | 未登录 |
| `password_invalid` | 401 | 本人密码错误（删除/取消/导出统一） |
| `password_rate_limited` | 429 | 密码错误次数过多；带 Retry-After |
| `confirmation_invalid` | 400 | 用户名/确认词不匹配 |
| `invalid_reason` | 400 | 管理员原因缺失/过长 |
| `deletion_already_pending` | 409 | 已有 pending 申请 |
| `deletion_not_pending` | 409 | 无 pending 可取消/状态已变化 |
| `deletion_not_due` | 409 | 冷静期未满且未 force |
| `deletion_not_found` | 404 | 申请不存在 |
| `deletion_completed` | 409 | 已完成的申请再次执行 |
| `deletion_failed` | 500 | 执行失败；申请已标 failed |
| `last_admin` | 409 | 最后一个管理员 |
| `lifecycle_unavailable` | 503 | 0024 未迁移 |
| `account_pending_deletion` | 403 | pending 账号访问业务 `/api/*` |
| `export_busy` | 409 | 已有 queued/running 任务 |
| `export_rate_limited` | 429 | 24h/30d 配额；`window` 字段 |
| `export_not_found` / `export_not_ready` / `export_failed` | 404/409 | 任务不存在/未完成/失败 |
| `export_token_invalid` | 403 | token 缺失/错误 |
| `export_expired` | 410 | 过期/文件已删 |

所有账号/删除/导出错误体为 `{"detail": "...", "code": "..."}`；限流带
`Retry-After`；`Cache-Control: no-store`。登录错误仍保持既有 401/403 文案，
不新增账号枚举面。密码确认失败对“密码错”与“用户不存在”统一文案；这些端点均
要求先登录，天然只能操作本人。

## 10. 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `EXPORTS_DIR` | `DATA_DIR/exports` | 导出临时目录；必须可写 |
| `EXPORT_MAX_BYTES` | `200MB` | ZIP/未压缩总字节上限 |
| `EXPORT_TTL_HOURS` | `24` | 临时文件保留小时数 |

冷静期 7 天、24h/30d 配额是代码常量（D-1/D-5），不提供运行时开关。

## 11. 安全与边界

- 密码确认复用 `auth_db.authenticate`，只校验当前登录用户自己的邮箱，并比对
  返回 id；不拿别人的邮箱/密码做确认。
- token/明文 user id 不落库；删除申请与审计只存 `sha256(user_id)`；导出
  `manifest.userIdHash` 同样只给摘要。
- 路径：`EXPORTS_DIR` realpath 约束；ZIP 条目拒绝绝对路径/`..`；客户端不能传
  文件路径；删除目录拒绝符号链接越界。
- 管理台删除/审计仅 `ADMIN_EMAILS`；管理员不能封禁/删除最后一个 active 管理员。
- **无法按用户删除的边界（必须在隐私政策/支持话术中保留）**：
  1. `content_teaching_analysis` / `content_difficulty` 以内容为键，本地视频
     `local-video:<hash>` 没有 user_id，无法可靠归属；不误删公共缓存。
  2. `data/guests/<hash>/` 与游客归属行（`ai_usage`/`ai_quota`/`watch_events`/
     `placement_sessions`/`assessment_sessions`/`user_profiles` 里的
     `guest:<sha256>`）没有持久 user→guest 映射；不猜、不删。
  3. 备份包含 `app.db` + `data/users/`；不按用户重写，最长 30 天残留。
  4. 日志不追溯删除，按 14–30 天轮转。
  5. 已购/第三方侧（未来支付、邮件）不在本轮；无邮件/支付。
- **残余风险**：提交删除前已在运行的 SSE/后台 LLM 任务可能继续到结束（新请求
  已 403）；后台任务的写回可能发生在停用后。M2a 没有全局任务取消钩子，建议
  M2b/M5 在长任务入口检查用户状态或在删除时标记 jobs 取消（本轮未做，明确登记）。
- 单 worker/进程内限速与导出线程：多 worker 部署时每个进程各自计数、部分唯一
  索引仍兜底并发；本轮按单 worker 设计。

## 12. 代码路径

| 文件 | 职责 |
|---|---|
| `backend/migrations/versions/0024_account_lifecycle.py` | 三张表 + 约束/索引 |
| `backend/account_lifecycle.py` | 删除申请/取消/硬删除/审计/密码限流/路径校验 |
| `backend/account_export.py` | 配额/任务/ZIP/manifest/token/下载/过期清理 |
| `backend/routes_account_lifecycle.py` | `/api/account/deletion*`、`/export*` |
| `backend/routes_admin_lifecycle.py` | `/api/admin/deletion-requests*`、`/audit` |
| `backend/main.py` | pending 中间件限制 |
| `backend/account.py` | `deletion_pending` 状态常量 |
| `backend/routes_admin.py` | 既有写操作审计钩子 |
| `backend/migrations/versions/0033_v1_1_launch.py` | v1.1 auth_tokens / feedback / email_verified_at |
| `backend/auth_db.py` | token 签发/单次消费/密码更新/邮箱验证标记 |
| `backend/emailer.py` | SMTP 可插拔 + dev outbox（账号找回/验证邮件） |
| `backend/routes_auth.py` | 密码重置/邮箱验证端点（P2-38） |
| `backend/run_due_deletions.py` | 到期删除安全脚本（dry-run 默认） |
| `backend/tests/test_account_lifecycle.py` | 删除/迁移/审计/失败重试测试 |
| `backend/tests/test_account_export.py` | 导出/限流/token/过期/路径测试 |

## 13. 验收

- `cd backend && venv/bin/python -m pytest tests -q` 全量通过（记录耗时/结果）；
- `alembic upgrade head` → `downgrade -1` → `upgrade head` 成功（0024 表可重建，
  0023 及旧数据保留）；
- 手动/测试：请求删除 → pending 登录受控 → 取消；导出 → ZIP 可读 → 下载 →
  过期 410；
- 删除后数据/目录/数据库/旧 Cookie/旧密码断言通过；备份与公共缓存未被误删；
- 管理员权限、最后管理员、二次确认、失败重试/不假装成功均有测试。

## 14. 已知未覆盖 / 后续

- M2b 前端：状态页/到期日/取消/导出按钮/下载列表/管理台按钮与文案。
- 无通知：冷静期到期不会提醒用户（无邮件/短信）；站内到期日依赖用户登录。
- 支持人工核验删除（`verified_via=support_manual`）无 HTTP 流程，需按支持 SOP
  人工执行；本轮不建管理员代发起端点。
- 备份/日志/公共缓存/游客目录的边界见 §11；未做备份重写与日志追溯清理。
- 已运行任务的强制取消（LLM/SSE/后台 job）未做；仅禁止新请求。
- 导出 token 在 24h 内可重复下载（为断点/重试）；不是单次点击即失效。
