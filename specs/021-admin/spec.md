# 规格：后台止血台（Admin MVP，读端点）→ 独立管理控制台

**状态：** 已实现（2026-11-15 读端点；2026-11-16 独立管理控制台）｜
**对应代码：** `backend/routes_admin.py`、`backend/config.py::ADMIN_EMAILS`、
`backend/routes_auth.py`（`isAdmin`）、`backend/tests/test_admin.py`、
`frontend/src/components/AdminConsoleScreen.tsx`、`frontend/src/lib/admin.ts`、
`frontend/src/lib/auth.tsx`、`frontend/src/components/AccountScreen.tsx`（入口）、
`frontend/src/App.tsx`（`'admin'` 全页视图 + `/admin`（或 `#admin`）直达守卫）。

> 用户需求 #12「后台」的 MVP，计划 M1 ⑥ 止血台。目标不是 CMS，而是
> **出事时 60 秒内看清「用户 / 花费 / 任务 / 错误」在哪**。因此所有端点
> **只读**：不提供删除、封号、退款、开关切换等写操作（那些是后续 M5 的
> 4 个急救动作，本规格明确不做）。
>
> **2026-11-16 更新**：用户需求 1–3 的运营写操作已由
> [specs/023](../023-user-profile/spec.md) 以**新增端点**的方式落地（调余额 /
> 封禁解封 / 维护模式 / 公告），本规格的「只读」边界只适用于
> `stats` / `users` / `usage` / `health` 四个读端点；`GET /api/admin/users`
> 的字段由 023 扩展（新增 username/credits/status/userId）。
>
> **2026-11-16 前端升级**：顶栏 admin 按钮已移除；唯一应用内入口是用户页
> 「管理控制台」（仅 `isAdmin`）。原只读 `AdminScreen` 被独立整页
> `AdminConsoleScreen` 取代（概览 / 用户 / 设置 / 用量与健康四个分区），
> 并接入 023 的四个写操作。四个读端点的契约不变。

---

## 目标

- **G1 身份边界**：管理员由环境变量 `ADMIN_EMAILS`（逗号分隔，大小写不敏感）
  决定；默认空 = 没有管理员。`/api/auth/me` 对登录用户额外返回顶层
  `isAdmin: boolean`；未登录/游客响应保持 `{user:null, guest:true}` 不变。
- **G2 管理端点**：`/api/admin/*` 需要登录 + 管理员；未登录 401，普通用户 403，
  管理员 200。本规格的四个读端点只读，不改任何表/文件；写端点见 specs/023。
- **G3 一页止血**：`GET /api/admin/stats` 给用户量/活跃、AI 花费与今日功能调用、
  jobs 状态；`GET /api/admin/users` 给用户列表（搜索/分页）；
  `GET /api/admin/usage` 给按天×功能的用量；`GET /api/admin/health` 聚合
  `/healthz`、`data/` 磁盘占用与最近 10 条 failed jobs。
- **G4 前端入口**：仅 `isAdmin` 用户能在用户页看到「管理控制台」入口；控制台是
  独立整页视图（概览 / 用户 / 设置 / 用量与健康），普通用户没有任何入口，直接
  进入 `/admin`（或 `#admin`）也被 toast 拦回首页；中越双语；375px 下表格横向滚动，不撑破页面。
- **G5 限速**：`/api/admin/*` 按登录用户 30 次/分钟（进程内固定窗口，复用
  `backend/ratelimit.py`；`RATE_LIMIT_ADMIN_PER_MINUTE` 可配，0 = 关闭）。

## 非目标

- **不做任何写操作**：无删除用户/内容、无封号、无退款/补偿、无开关、无缓存清理。
- 不新增数据库迁移：只读聚合已有表（`users` / `learning_events` / `attempts` /
  `ai_usage` / `jobs` / `ai_quota`）与 `data/` 目录，不建表、不改 schema。
- 不做独立 role 表、2FA、审计日志、操作留痕（计划书 M1 ⑦ 残余项）。
- 不做图表库/数据大屏；数字用表格与卡片呈现。
- 不做分页游标/排序参数；固定按注册时间倒序、`limit/offset` 分页。
- 不做前端独立 URL 路由：沿用 `App.tsx` 的视图状态；额外支持 `/admin`（或 `#admin`）直达
  入口（启动时读取一次并按 `isAdmin` 放行/拒绝），它不是 router，也不改视图
  之外的地址。

## 管理员身份

| 项 | 规则 |
|---|---|
| 配置 | `ADMIN_EMAILS` 环境变量，逗号分隔；`strip().lower()` 后匹配 |
| 默认 | 空字符串 = 无管理员；所有 `/api/admin/*` 对任何登录用户都 403 |
| 判断 | `config.is_admin_email(email)`；只读环境变量，不改库、不写 Cookie |
| `/api/auth/me` | 登录时 `200 {"user":{…},"isAdmin":true|false}`；游客保持 `{"user":null,"guest":true}`（`user` 字段自 023 起增加 username/credits/status，`isAdmin` 仍只在顶层） |
| 登录/注册 | 响应的 `{"user":{...}}` 契约不变（不塞 `isAdmin`）；前端登录后会补拉一次 `/api/auth/me` 以刷新入口 |

> 为什么用邮箱而不是 user_id：线上排障时运维只知道「给谁开了管理员」，
> 邮箱可读、可直接写进环境变量；user_id 是随机串，需要先查库。
> 为什么不做 role 表：MVP 的边界是「一个人、一台机器、出事时能看数」，
> 独立 role 表 + 2FA + 审计属于 M1 ⑦ 的后续项，不在本规格里加。

## 端点契约（全部需登录 + 管理员）

错误语义统一：未登录 `401 {"detail":"未登录"}`；非管理员
`403 {"detail":"需要管理员权限。"}`；数据库/表不可用时字段降级为 0/空，
不返回 500（`/api/admin/health` 本身也不因 DB degraded 而失败）。

### `GET /api/admin/stats`

```json
{
  "users": {"total": 0, "new7d": 0, "activeToday": 0, "guests": 0},
  "ai": {
    "todayCostUsd": 0.0,
    "monthCostUsd": 0.0,
    "todayCalls": 0,
    "todayByFeature": {
      "translate": {"calls": 0, "costUsd": 0.0, "inputTokens": 0, "outputTokens": 0}
    }
  },
  "jobs": {"failed": 0, "running": 0, "pendingRetry": 0},
  "generatedAt": "2026-11-15T05:30:00.000Z"
}
```

口径：

| 字段 | 口径 |
|---|---|
| `users.total` | `users` 行数 |
| `users.new7d` | `users.created_at >= 服务端当前时间 - 7×24h`（滚动 7 天，秒） |
| `users.activeToday` | 当地「今天」内 `learning_events.occurred_at` 或 `attempts.answered_at` 出现过的不重复 `user_id` |
| `users.guests` | `GUEST_DATA_DIR` 下形状合法的游客目录数（不新建目录） |
| `ai.todayCostUsd` | `ai_usage` 当天 `SUM(est_cost_usd)`（`usage_date` 按 `AI_QUOTA_TIMEZONE`，默认 Asia/Shanghai） |
| `ai.monthCostUsd` | `ai_usage` 当月 `SUM(est_cost_usd)` |
| `ai.todayCalls` | 当天 `SUM(calls)` |
| `ai.todayByFeature` | 当天按 `feature` 聚合 `calls/cost/tokens`，只列出现过的功能 |
| `jobs.failed` | `jobs.status='failed'` |
| `jobs.running` | `jobs.status='running'` |
| `jobs.pendingRetry` | `jobs.status IN ('queued','partial')`（等待/可续传，不等于失败） |

「今天/当月」边界由 `AI_QUOTA_TIMEZONE` 决定；`generatedAt` 是 UTC ISO8601。

### `GET /api/admin/users?limit=50&offset=0&search=`

- `limit` 默认 50，夹在 `1..100`；`offset` 默认 0、最大 100000；`search`
  去空白、最长 100 字符，按邮箱 `LIKE`（转义 `%`/`_`）。
- 返回：

```json
{
  "users": [
    {
      "id": "a1b2c3d4",
      "email": "alice@example.com",
      "createdAt": 1763200000000,
      "monthCostUsd": 0.0,
      "eventCount": 0,
      "lastActiveAt": 1763200000000
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0,
  "hasMore": false
}
```

| 字段 | 口径 |
|---|---|
| `id` | `users.id` **前 8 位**（页面只需要能对账，不需要暴露完整 id） |
| `createdAt` | `users.created_at`（秒）转换为毫秒 |
| `monthCostUsd` | 该用户当月 `ai_usage.est_cost_usd` 合计，6 位小数 |
| `eventCount` | 该用户 `learning_events` 行数 |
| `lastActiveAt` | `MAX(learning_events.occurred_at, attempts.answered_at)`；从未活跃为 `null` |

排序：`created_at DESC, id DESC`；`total` 是过滤后的总数；`hasMore = offset + len(users) < total`。

### `GET /api/admin/usage?days=7`

- `days` 默认 7，夹在 `1..90`。
- 返回按 `(usage_date, feature)` 聚合的行（升序日期、降序成本），外加按天汇总与总计：

```json
{
  "days": 7,
  "start": "2026-11-09",
  "end": "2026-11-15",
  "rows": [
    {"day": "2026-11-15", "feature": "translate", "calls": 2, "inputTokens": 10, "outputTokens": 5, "costUsd": 0.0001}
  ],
  "daysSummary": [
    {"day": "2026-11-15", "calls": 2, "costUsd": 0.0001}
  ],
  "totals": {"calls": 2, "inputTokens": 10, "outputTokens": 5, "costUsd": 0.0001}
}
```

范围是闭区间 `[今天-(days-1), 今天]`；`usage_date` 不存在于范围内的旧数据不显示。

### `GET /api/admin/health`

```json
{
  "health": {
    "status": "ok",
    "version": "0.0.0-dev",
    "db": {"ok": true, "migrations": {"current": "0011_reading", "head": "0011_reading"}},
    "uptimeSeconds": 12.3,
    "time": "2026-11-15T05:30:00.000Z"
  },
  "disk": {"dataDir": "/repo/data", "sizeBytes": 12345},
  "failedJobs": [
    {"id": "…", "userId": "a1b2c3d4", "kind": "process_video", "contentRef": "…", "error": "…", "updatedAt": 1763200000000}
  ]
}
```

- `health` 字段来自 `observability.health_snapshot()`；**端点始终 200**，由
  `health.status` 表达 `ok|degraded`（页面要让运营看到 degraded 的具体字段，
  而不是只看到一个 503）。
- `disk.sizeBytes` 递归统计 `DATA_DIR`（不存在按 0）；不跟随符号链接。
- `failedJobs` 最多 10 条，按 `updated_at DESC`；`userId` 只取前 8 位，
  `error` 截断到 500 字符。

## 只读保证

- 所有 SQL 均为 `SELECT`；连接建立后执行 `PRAGMA query_only = ON`，任何
  误写会被 SQLite 拒绝。
- 不创建数据库、不建表、不写 `data/`；磁盘统计用 `os.scandir`/`os.walk` 只读。
- 本规格的四个读端点不提供任何 `POST/PUT/PATCH/DELETE`；调余额 / 封禁解封 /
  设置写端点由 [specs/023](../023-user-profile/spec.md) 定义（同样需要管理员）。

## 前端

**入口（2026-11-16 起）**

- 顶栏不再有 admin 按钮；唯一应用内入口是用户页 `AccountScreen` 的「管理控制台」
  （`data-testid="account-admin-entry"`，仅 `isAdmin` 渲染）。控制台是独立整页
  `'admin'` 视图（`AdminConsoleScreen`），自带返回；从用户页进入时关闭返回用户页，
  从直达链接进入时回首页。
- 非管理员没有任何入口；`App.tsx` 在打开控制台前再查 `isAdmin`。直接访问
  `/admin`（或 `#admin`；启动时读取一次）会被 toast「需要管理员权限。」并留在首页；控制台
  内部再校验一次 `isAdmin`，丢失权限/会话时同样 toast 并回首页。
- 控制台不写入 URL；`/admin`（或 `#admin`）只是直达守卫，不是 router。

**四个分区**（`AdminConsoleScreen.tsx`，分段 tab 切换）

- 概览：总用户 / 近 7 天新增 / 今日活跃 / 游客 / 今日 AI 花费 / 失败任务，
  复用 `GET /api/admin/stats`；维护模式开启时显示提示条。
- 用户：`GET /api/admin/users?limit=20&offset&search=`，搜索 email/username、
  上一页/下一页；表格列用户名 / 邮箱 / 余额 / 状态 / 注册时间 / 操作。
  - 调整余额：弹窗输入带符号整数（±100000、非 0）+ 原因（1–200 字），
    `POST /api/admin/users/{userId}/credits`；成功 toast + 刷新列表，后端 400
    （如余额不足）原文显示在弹窗内并 toast。
  - 封禁/解封：二次确认弹窗，`PATCH /api/admin/users/{userId}`；成功刷新状态。
    自己的行禁用封禁并提示；封禁自己 / 最后一个管理员等后端 400 原文显示在
    弹窗内。
- 设置：`GET/PUT /api/admin/settings`；维护模式开关（说明开启后非管理员
  `/api` 返回 503）、公告文本（可为空，空保存为 `null`）；保存成功显示已保存，
  并给公告条预览。公开公告条尚未接入：它需要公开读取接口，本轮只落库。
- 用量与健康：`GET /api/admin/usage?days=7` 按天×功能表格 + 合计；
  `GET /api/admin/health` 迁移 current/head、磁盘、运行时长、最近 failed jobs。

**通用**

- 请求全部走 `lib/admin.ts` → `apiFetch`（带 credentials）；401/403 toast 并
  离开控制台，其它错误行内 + toast。
- 加载 / 空态 / 错误重试齐备；所有表格外层 `overflow-x-auto` + 内部 `min-w`，
  页面根 `overflow-x-hidden`；375px 页面不横向滚动，只滚表格。
- 文案走 `admin.*`，zh-CN / vi-VN 对齐（`npm run check:i18n`），越南语无 CJK。

## 限速

- `ratelimit.bucket_for()` 对 `/api/admin` 前缀返回 `Bucket("admin","user")`；
  上限 `config.RATE_LIMIT_ADMIN_PER_MINUTE`（默认 30，0 = 关闭）。
- 超限 `429 + Retry-After`（与现有桶一致）；游客/未登录也先走同一中间件，
  但业务层仍返回 401/403。

## 测试（离线）

`backend/tests/test_admin.py`：

1. 非管理员 403、未登录 401、管理员四个端点 200；
2. `/api/auth/me` 的 `isAdmin` 真/假；游客响应不变；
3. stats 聚合正确（造 users / learning_events / attempts / ai_usage / jobs 数据）；
4. 用户搜索大小写不敏感、分页（limit/offset/total/hasMore）、字段口径；
5. usage 按天×功能聚合、范围裁剪、days 边界；
6. health 含 `health`/`disk`/`failedJobs`，failed jobs 最多 10 条；
7. 管理员桶 30 次/分钟，第 31 次 429 + `Retry-After`；
8. 迁移到 head 后可跑；不新增迁移。

## 验收

- `backend/venv/bin/python -m py_compile *.py` 通过；
- `pytest tests -q` 全绿（现有 457 + 本规格新增）；
- 前端 `npx tsc -b`、`npm run check:i18n`、`npm run build` 通过；
- 8001 临时实例（`/tmp` 数据）：设 `ADMIN_EMAILS` 后管理员四端点 200，
  普通用户 403，未登录 401；stats 数值与手工造数一致；
- Playwright（系统 Chrome，5173，mock `/api/admin/*`）23 项通过：管理员从用户页
  进控制台、普通用户无入口且 `/admin`（或 `#admin`）被踢回首页、概览六项数字、用户搜索与
  分页、+100 调账成功刷新 / 负数 400 行内提示、封禁与解封二次确认、维护模式
  与公告保存、用量与健康表格、中越双语、375px；截图 `/tmp/admin-console-shots/`。

## 2026-11-16 前端：独立管理控制台（用户需求 #3 收口）

**改动文件**

- `frontend/src/components/AdminConsoleScreen.tsx`（新增，替代已删除的
  `AdminScreen.tsx`）：整页控制台、四个分段 tab、两个确认弹窗、管理端四个写操作；
- `frontend/src/lib/admin.ts`：用户行扩展 `userId/username/credits/status`，
  新增 `fetchAdminSettings/saveAdminSettings/adjustAdminUserCredits/updateAdminUserStatus`；
- `frontend/src/App.tsx`：移除顶栏 admin 按钮，新增 `'admin'` 全页视图 + 返回目标
  （用户页/首页）、`/admin`（或 `#admin`）直达守卫、非管理员 toast 回首页；
- `frontend/src/components/AccountScreen.tsx`：管理控制台入口补充说明文案；
- `frontend/src/i18n/{zh-CN,vi-VN}.json`：新增控制台文案（全量 998 keys × 2 对齐）；
- `frontend/src/components/README.md`、`frontend/src/lib/README.md`：文件职责更新。

**验收（2026-11-16）**

`npx tsc -b`、`npm run check:i18n`、`npm run build` 通过；Playwright 23/23，
截图在 `/tmp/admin-console-shots/`（概览、用户表、调账弹窗与 400、封禁确认、
设置、用量与健康、越南语、375px、非管理员被踢）。控制台错误统一 toast +
行内提示；用户表每页 20 条；所有表格在 375px 横向滚动且页面不横向溢出。

**未做**

- 公告的公开读取端点 / App 顶部公告条（需要后端新端点，本轮只保存公告）；
- 操作审计日志（`credit_transactions` 已记录调账流水，其它动作仅服务端日志）；
- 独立 URL 路由（仍是 App 视图状态 + `/admin`（或 `#admin`）直达守卫）。
