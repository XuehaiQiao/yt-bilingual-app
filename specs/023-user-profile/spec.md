# 规格：用户名 / 用户页数据 / 余额与后台手动设置

**状态：** 已实现（2026-11-16，仅后端）｜
**对应代码：** `backend/migrations/versions/0013_user_profile.py`、
`backend/account.py`、`backend/routes_account.py`、`backend/routes_auth.py`、
`backend/routes_admin.py`、`backend/main.py`、`backend/tests/test_user_profile.py`、
`backend/tests/test_migrations.py`。

> 用户需求 1/2/3：① 注册必须设用户名（可改）；② 独立「用户页」要能拿到用户
> 信息 / 余额 / 本月花费 / 版本；③ 独立后台可手动调余额、封禁/解封、维护模式
> 与公告，且普通用户无法访问后台接口。**本轮只做后端**；用户页与后台控制台
> 前端在下一任务。余额语义暂定 `credits`（默认 0，管理员手动发放）；支付/
> 充值体系未实现。

---

## 目标

- **G1 用户名**：注册时设置显示名（2–24 字符，中文/英文/数字/下划线/连字符，
  不允许空白开头结尾），登录后可改；不要求全局唯一。旧客户端完全不传
  `username` 时回落 email 前缀，保证升级不打断注册。
- **G2 用户页数据**：`GET /api/user/summary` 一次给齐用户信息、余额、本月 AI
  花费、今日学习分钟、版本号；无数据时数字为 0。
- **G3 后台运营**：管理员可查用户（含用户名/余额/状态）、手动调余额（写流水、
  不允许负余额）、封禁/解封（不能封自己/最后一个管理员）、读写维护模式与公告。
- **G4 维护模式**：开启时非管理员的 `/api/*` 返回 503（认证、后台、健康探针
  除外），管理员不受影响。
- **G5 安全**：后台端点仅管理员（未登录 401、普通用户 403）；封禁账号的旧会话
  下一次请求 403；所有校验在服务端完成，不信任前端。

## 用户故事

- 作为新用户，我想在注册时起一个中文/英文名字，以便在应用里被称呼。
- 作为登录用户，我想在用户页看到自己的余额、本月 AI 花费和版本号，以便知道
  当前用量与状态。
- 作为运营（管理员），我想在后台手动给用户加/扣余额、封禁账号、开关维护模式，
  以便处理充值补偿/滥用/系统维护。
- 作为系统，我希望维护期间普通用户看到明确提示，而管理员仍能登录后台处置。

## 功能需求

### 1. 数据模型（迁移 `0013_user_profile`）

`users` 表加三列：

| 列 | 类型 | 规则 |
|---|---|---|
| `username` | TEXT 可空 | 新用户由注册写入；旧用户回填 email 的 `@` 前缀（重名不管）；不唯一 |
| `credits` | INTEGER NOT NULL DEFAULT 0 | 余额；只能由管理员调账改变 |
| `status` | TEXT NOT NULL DEFAULT 'active' | `active` / `banned` |

新表：

- `credit_transactions(id TEXT PK, user_id TEXT, delta INTEGER, reason TEXT,
  admin_id TEXT NULL, created_at INTEGER)`，索引 `(user_id, created_at)`；
  append-only，每次调账一行。
- `app_settings(key TEXT PK, value TEXT NULL, updated_at INTEGER)`；本次使用
  `maintenance_mode`（`'0'`/`'1'`）与 `announcement`（字符串或 NULL）。

### 2. 注册 / 登录 / me

- `POST /api/auth/signup` body 增加 `username`：
  - 2–24 个字符（按 Unicode 字符计，中文算 1 个）；
  - 只允许中文（基本区/扩展 A）、英文、数字、下划线、连字符；
  - 首尾不能是空白（不做自动 trim，直接 400）；
  - 传了却不合法（含 `null`、空串、非字符串）→ **400**；
  - **完全不传** `username` 字段 = 旧客户端 → 回落 email 的 `@` 前缀（兼容，
    不校验长度/字符集）；
  - 不要求全局唯一（显示名；登录仍用 email）。
- 响应 `user` 带 `{id,email,username,credits,status}`；旧字段 `id/email` 保留。
- `POST /api/auth/login`：密码正确但 `status='banned'` → **403
  `{"detail":"账号已被停用"}`**，不创建新会话；不泄露密码是否正确以外的信息。
- `GET /api/auth/me`：登录用户返回同一 `user`（顶层仍 `isAdmin`）；游客仍
  `{user:null,guest:true}`。
- 封禁账号的**已有会话**不删除；下一次 `/api/*` 请求由身份中间件返回
  **403 `{"detail":"账号已被停用"}`**；解封后原 Cookie 恢复。

### 3. 改用户名

`PATCH /api/user/profile`（需登录；游客/未登录 403）：

```json
{"username": "新名字"}
```

- 校验同注册；400 时附中文 `detail`，旧值不变。
- 缺 `username` 字段 / `null` / 非字符串 → 400。
- 成功：`200 {"user":{"id","email","username","credits","status"}}`；email、
  密码、余额、状态都不可经此接口修改。
- 允许两个用户使用同一个显示名。

### 4. 用户页摘要

`GET /api/user/summary`（需登录；游客/未登录 403）：

```json
{
  "user": {
    "id": "…", "email": "a@example.com", "username": "小明",
    "credits": 100, "memberSince": 1763200000000, "status": "active"
  },
  "monthSpendUsd": 0.0003,
  "usageToday": {"minutes": 12.5},
  "version": "0.0.0-dev",
  "preliminary": false
}
```

| 字段 | 口径 |
|---|---|
| `user.memberSince` | `users.created_at`（秒）转毫秒 |
| `monthSpendUsd` | `ai_usage` 当月 `SUM(est_cost_usd)`；月份边界按 `AI_QUOTA_TIMEZONE`；6 位小数；**估算值，不是真实账单** |
| `usageToday.minutes` | `watch_events` 当地今天 `SUM(watched_seconds) ÷ 60`，2 位小数 |
| `version` | `config.APP_VERSION` |
| `preliminary` | 统计源表缺失（旧库未迁移/表不可用）→ `true`（数字为降级值）；正常 `false` |

无数据时 `monthSpendUsd=0`、`usageToday={"minutes":0}`，不返回 `null`。

### 5. 后台端点（管理员）

管理员 = `ADMIN_EMAILS` + `config.is_admin_email`（沿用 specs/021）。未登录
**401**、非管理员 **403**、目标用户不存在 **404**；`/api/admin/*` 沿用
30 次/分钟限速桶。

- `GET /api/admin/users`：保留 021 的全部字段，新增
  `username` / `credits` / `status`，并新增完整 id `userId`（列表展示的 `id`
  仍是前 8 位，调账/封禁必须用 `userId`）。`search` 同时匹配 email 与 username。
- `POST /api/admin/users/{id}/credits`：

  ```json
  {"delta": 100, "reason": "新用户补贴"}
  ```

  - `delta` 整数、非 0、范围 `-100000..100000`；`reason` 去首尾空白后 1–200 字；
    非法 400。
  - 在 `BEGIN IMMEDIATE` 事务内：读当前余额 → 校验不为负 → `UPDATE users.credits`
    → `INSERT credit_transactions`（`admin_id` = 当前管理员，`created_at` 毫秒
    UTC）→ 提交。
  - 扣减后 < 0 → **400**「余额不足，不能扣成负数。」，余额与流水都不写。
  - 成功：`200 {"credits": 新余额}`。
  - `credit_transactions` 表缺失（旧库未迁移）→ **503**，提示先跑迁移。
- `PATCH /api/admin/users/{id}`：

  ```json
  {"status": "banned"}
  ```

  - 只允许 `active` / `banned`；缺 `status` 400。
  - 不能封禁自己（400「不能封禁自己。」）；不能封禁管理名单里最后一个 active
    管理员（400「不能封禁最后一个管理员。」）。
  - `isAdmin` 不实现：显式传入 **400**，不静默忽略。
  - 成功：`200 {"user":{id,email,username,credits,status,createdAt}}`。
  - 封禁不删会话（见 §2）。
- `GET /api/admin/settings` → `{"maintenance_mode": bool, "announcement": str|null}`。
- `PUT /api/admin/settings` body 任一字段：

  ```json
  {"maintenance_mode": true, "announcement": "今晚 23:00 维护"}
  ```

  - 按字段 upsert；`announcement: null` 清空公告；不传的字段保留原值；
    `maintenance_mode: null` 400；公告上限 2000 字（超出 400）。
  - 返回当前完整值。
  - `app_settings` 表缺失（旧库未迁移）→ **503**；GET 在旧库返回默认值
    （`false` / `null`），不 500。

### 6. 维护模式

- 读取 `app_settings.maintenance_mode`，进程内缓存 **5 秒**；后台 PUT 立即刷新，
  多进程部署时每个进程最多滞后 5 秒。
- 开启时，**非管理员**访问 `/api/*` 返回
  **503 `{"detail":"系统维护中，请稍后重试。"}`**。
- 白名单：`/api/auth/*`、`/api/admin/*`、`/health`、`/healthz`（以及 CORS 预检）。
- 管理员不受影响；封禁检查发生在维护检查之前。
- 设置表缺失/读取失败按「未开启」处理，不让设置故障把整个 API 拖进维护态。

## 错误语义汇总

| 场景 | 状态码 |
|---|---|
| 用户名缺失值/非法（注册、改资料） | 400 |
| 未登录访问用户页接口 | 403 |
| 游客/未登录访问后台 | 401（未登录） / 403（普通用户） |
| 封禁账号登录 / 旧会话 | 403「账号已被停用」 |
| 调余额：0/越界/原因非法 | 400 |
| 调余额：扣成负数 | 400「余额不足…」 |
| 目标用户不存在 | 404 |
| 封禁自己 / 最后一个管理员 / isAdmin | 400 |
| 未迁移写设置/调账 | 503 |
| 维护模式（非管理员） | 503「系统维护中，请稍后重试。」 |

## 非目标

- 不做前端用户页 / 独立后台控制台（下一任务）；不新增前端路由守卫。
- 不做支付/充值/退款/账单；`credits` 只是管理员手动发放的余额（语义暂定）。
- 不做独立 role 表、2FA、后台操作审计日志；`credit_transactions` 只记录调账
  操作者 id，不覆盖其它后台动作。
- 不做用户名全局唯一/敏感词过滤/改名频率限制；显示名允许重名。
- 不提供用户自助注销/导出、公告的公开读取端点（公告由后续前端任务决定如何消
  费；当前只落库 + 后台读写）。
- 不改 email、密码、游客归属；游客仍然不能使用用户页接口。

## 验收标准

- [ ] 注册带合法用户名 201，`me` 与登录响应的 `user` 都带
      username/credits/status；密码只存 Argon2 哈希不变。
- [ ] 注册传非法用户名（长度/字符/首尾空白/non-string/null）400，且不落用户；
      完全不传字段回落 email 前缀 201。
- [ ] `PATCH /api/user/profile` 改名成功并可在 `me` 读到；非法值 400 且旧值不变；
      游客 403；两个用户可同名。
- [ ] `GET /api/user/summary` 无数据时数字为 0；写入 `ai_usage` 与 `watch_events`
      后本月花费/今日分钟正确，旧月份不计入；`version` 等于 `APP_VERSION`。
- [ ] 管理员 `+`/`-` 余额成功、余额不足 400、0/越界/原因非法 400、用户不存在 404、
      普通用户 403；每次成功调账留下一条 `credit_transactions`；并发调账不丢更新。
- [ ] 封禁后登录 403、旧会话下一次 `/api` 请求 403、解封后原 Cookie 恢复；
      不能封自己；服务层拒绝最后一个管理员。
- [ ] `GET/PUT /api/admin/settings` 读写正确；`announcement:null` 清空、不传字段保留。
- [ ] 维护模式开启后普通用户与游客 503，管理员与 `/api/auth/*`、`/health` 正常；
      关闭后恢复；进程内缓存 5 秒。
- [ ] 迁移 `0013` 可升级（含旧库四列 users 回填）与回滚（删两表 + 三列、保留用户行）。
- [ ] `venv/bin/python -m py_compile *.py` 与全量 `pytest tests -q` 通过；
      8001 `/tmp` 临时实例实测注册→me→调余额→summary→封禁→维护模式全链路。

## 测试

`backend/tests/test_user_profile.py`（32 个离线用例）：注册/回落/非法用户名、
登录与 me、改用户名、摘要聚合与降级、余额调账（正负/不足/参数/404/403/流水/
并发原子）、封禁与解封、最后管理员、settings、维护模式（含管理员白名单与
5 秒缓存）、游客 403、旧库降级。

`backend/tests/test_migrations.py` 覆盖 0013 升级/回滚/旧用户回填。
