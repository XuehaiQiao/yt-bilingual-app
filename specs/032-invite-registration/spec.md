# 032 — 邀请/注册开关（M1 G1）

> 状态：**M1 已实现（后端 + 前端 + 管理台）** ｜ 2026-11-20
> 依赖：001 用户体系、021 后台、023 用户资料、`docs/项目提案-上线功能.md` §3.4 / §6
> 目标版本：首发 G1 邀请制免费内测
> 一句话：公开注册默认关闭；管理员生成一次性/限次邀请码，新用户凭码注册；G2 公开注册能力已建好但默认不开。

## 1. 目标

- 首发只允许「拿到邀请码的人」创建账号：`REGISTRATION_OPEN=false`（默认）。
- 管理员可在后台生成、查看、撤销邀请码；列表不返回明文。
- 邀请码限次、限时、可撤销、可审计；并发注册不超发。
- 邀请码消费与建用户/会话同事务；邮箱冲突、会话失败都不消耗邀请码。
- G2 的公开注册能力先建好：把 `REGISTRATION_OPEN` 改成 `true` 即可开放，不需要改代码。
- 注册页明确「内测邀请制」；**v1.1（P2-38）起**提供邮箱验证与自助找回密码，
  注册页/登录页文案随之更新（前端 P2-40）。

## 2. 非目标（本轮不做）

- M2 账号删除/导出；M3 余额/成本；M4 隐私/协议页；M5 飞书告警；M6 Caddy Basic Auth、域名、部署。
- 短信、OAuth、营销邮件不做；邮箱验证/自助找回密码原为 M1 非目标，
  **v1.1 已由 P2-38 补上**（见 §13），注册/登录行为本身不变。
- 不做「管理员免邀请码后门」；管理员也走正常注册（可用邀请码）。
- 不修改 `users` 表结构；余额开户在 M3 另做。
- 不建 `admin_audit` 大表；M1 创建/撤销审计先用结构化日志。

## 3. 行为矩阵

| `REGISTRATION_OPEN` | `INVITE_SIGNUP_ENABLED` | 邀请码 | 结果 |
|---|---|---|---|
| `false`（默认） | `true`（默认） | 有效 | 允许注册；消费该码 |
| `false` | `true` | 缺失 | `403 invite_required` |
| `false` | `true` | 无效/过期/撤销/用尽/重复 | `403 invite_invalid`（对外统一文案） |
| `true`（G2） | 任意 | 缺失 | 允许公开注册 |
| `true` | 任意 | 有效 | 允许注册并消费该码 |
| `true` | 任意 | 无效 | `403 invite_invalid`（传了非法码仍拒绝） |
| `false` | `false` | 任意 | `403 registration_closed`（完全关闭新账号） |
| 任一 | 任一 | — | 已有账号登录、游客/claim-guest 行为不变 |

- 两个开关都在进程启动时读环境变量；改完需重启。管理台只读展示，不提供运行时开关，避免误开。
- 管理员身份不绕过邀请码；没有测试后门。

## 4. 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `REGISTRATION_OPEN` | `false` | `true` 才允许无邀请码公开注册 |
| `INVITE_SIGNUP_ENABLED` | `true` | 与 `REGISTRATION_OPEN=false` 同时为 `false` = 完全关闭注册 |
| `INVITE_CODE_TTL_DAYS` | `30` | 管理员未显式指定时的默认有效天数（1–90） |
| `INVITE_CODE_MAX_USES` | `1` | 管理员未显式指定时的默认次数（1–10） |
| `INVITE_CODE_PEPPER` | 空 | 可选 HMAC pepper；生产建议设置，轮换会使旧码全部失效 |

`.env.example`、`deploy/linguatrek.env.example` 有说明和空值模板；不写真实密钥。

> **首次部署/bootstrap**：默认关闭公开注册后，新库没有任何账号时无法从注册页创建第一个管理员。运维应先把 `ADMIN_EMAILS` 指向一个已有账号，或临时设 `REGISTRATION_OPEN=true` 注册管理员、设置 `ADMIN_EMAILS` 后立刻改回 `false` 并重启。不要长期保持公开注册。

## 5. 数据模型

迁移：`backend/migrations/versions/0023_invite_registration.py`（`down_revision = 0022_generated_courses`）。

### `invite_codes`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | `inv-<uuid4 hex>`，应用生成 |
| `code_hash` | TEXT NOT NULL UNIQUE | HMAC-SHA256(pepper, normalized) 十六进制；不存明文 |
| `code_prefix` | TEXT NOT NULL | 归一化码前 6 位，仅供管理台辨认 |
| `label` | TEXT NULL | 管理员备注 |
| `max_uses` | INTEGER NOT NULL DEFAULT 1 | 1–10 |
| `used_count` | INTEGER NOT NULL DEFAULT 0 | 原子递增；`<= max_uses` |
| `expires_at_ms` | INTEGER NULL | 毫秒 UTC；NULL = 不过期（不建议） |
| `revoked_at_ms` | INTEGER NULL | 撤销时间 |
| `revoked_by` | TEXT NULL | 撤销管理员 id |
| `created_by` | TEXT NOT NULL | 创建管理员 id |
| `created_at_ms` | INTEGER NOT NULL | 毫秒 UTC |
| `last_used_at_ms` | INTEGER NULL | 最近成功兑换时间 |

索引：`ux_invite_codes_code_hash`（唯一）、`ix_invite_codes_created`、`ix_invite_codes_expires`。

### `invite_redemptions`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | `red-<uuid4 hex>` |
| `invite_id` | TEXT NOT NULL | 邀请码 id（不做外键，便于用户删除后保留审计） |
| `user_id` | TEXT NOT NULL | 新用户 id |
| `redeemed_at_ms` | INTEGER NOT NULL | 毫秒 UTC |

索引：`ux_invite_redemptions_user`（`invite_id, user_id` 唯一，防同一用户重复兑换同码）、`ix_invite_redemptions_invite`、`ix_invite_redemptions_user`。
不存 email/ip，尽量少收 PII；M2 删除策略简单。

## 6. 服务端实现

### 6.1 `backend/invites.py`

- `generate_code()`：`LN-XXXX-XXXX-XXXX`，12 位 Crockford Base32（去掉 I/L/O/U）≈ 60 bit，`secrets.choice`。
- `normalize_code()`：大写、去空格/连字符；缺少 `LN` 前缀自动补；非法字符/非字符串抛内部错误。
- `hash_code()`：HMAC-SHA256；库里只有摘要。
- `create_invites()` / `list_invites()` / `revoke_invite()`：管理员创建/分页状态过滤/幂等撤销；列表只返回脱敏字段。
- `redeem_invite()`：在调用方事务内校验并原子占用；失败抛 `InviteError(reason)`，reason 为 `invalid_format` / `not_found` / `revoked` / `expired` / `exhausted` / `duplicate_redemption`，只进日志。
- `register_with_invite()`：`BEGIN IMMEDIATE` 内完成「占码 → 插 user → 插 redemption → 插 session」；邮箱冲突/会话失败回滚。密码 Argon2 在事务外算好。
- 审计：`admin.invite.create` / `admin.invite.revoke` 结构化 JSON 日志，含 actor、id、prefix、次数、过期时间；不含明文码。
- 未迁移旧库抛 `InviteUnavailable`，路由转 503 提示先跑迁移。

### 6.2 注册顺序

1. 校验 email/password/username（不变）。
2. 校验注册开关/邀请码格式（缺码/格式错误直接拒绝）。
3. 事务外 `auth_db.hash_password`（邀请码路径）。
4. `BEGIN IMMEDIATE`。
5. 校验/占用邀请码：不存在/撤销/过期/用尽/重复 → 回滚。
6. 插入 `users`；邮箱唯一冲突 → 回滚，返回 409。
7. 插入 `invite_redemptions`。
8. 插入 `sessions`。
9. `COMMIT`；设置 `ln_session` Cookie。

任何一步异常都回滚，`used_count` 不增加。

## 7. API

### `POST /api/auth/signup`（公开）

```json
{"email":"a@example.com","password":"********","username":"小明","inviteCode":"LN-ABCD-EFGH-JKLM"}
```

- `inviteCode` 可选；`REGISTRATION_OPEN=false` 时必填。
- `201`：同现有契约 `{"user":{id,email,username,credits,status}}` + Cookie。
- 错误响应在 `detail` 之外带稳定 `code`：

| HTTP | `code` | 场景 |
|---|---|---|
| 403 | `invite_required` | 邀请制，没带码 |
| 400 | `invite_invalid` | 码格式非法（非字符串/字符非法） |
| 403 | `invite_invalid` | 不存在/过期/撤销/用尽/重复；对外统一文案 |
| 403 | `registration_closed` | 两个开关都为 false |
| 503 | `registration_unavailable` | 旧库未跑 0023 迁移 |
| 503 | `registration_busy` | SQLite 写锁繁忙（带 `Retry-After: 5`） |
| 409 | —（沿用现有） | 邮箱已注册；邀请码已回滚 |

- 不根据邀请码失败区分具体原因；真实原因写服务端日志。
- 邮箱冲突仍按现状返回 409（G1 可接受，隐私说明由 M4 补）。

### `GET /api/auth/registration`（公开）

```json
{"registrationOpen":false,"inviteSignupEnabled":true,"inviteRequired":true,"registrationClosed":false}
```

注册页据此决定是否显示/强制邀请码；管理台只读展示。

### 管理员 API（`/api/admin/*`，需管理员）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/invites?status=&limit=&offset=` | 状态 `all/active/used/expired/revoked`；分页 1–100；返回 `invites/total/limit/offset/hasMore/status/counts/config`，不含明文/哈希 |
| `POST` | `/api/admin/invites` | `{count?,label?,maxUses?,expiresInDays?}`；默认 1 个、1 次、30 天；明文只在 `codes[]` 出现一次 |
| `POST` | `/api/admin/invites/{id}/revoke` | 幂等；返回 `{invite,alreadyRevoked}`；不存在 404 |

- 权限沿用 `require_admin`：未登录 401、非管理员 403；限速沿用 `/api/admin` 桶（默认 30 次/分钟）。
- `POST` 参数边界：count 1–10、maxUses 1–10、expiresInDays 1–90、label ≤120 字。
- 列表行字段：`id/prefix/label/maxUses/usedCount/status/createdBy/createdAt/expiresAt/revokedAt/revokedBy/lastUsedAt`。

## 8. 前端

### 8.1 注册页（`AuthScreen.tsx`）

- 启动时请求 `GET /api/auth/registration`；失败回落 G1 默认（邀请码必填）。
- 注册页固定提示：「内测邀请制：注册需要邀请码。」；v1.1 起追加「忘记密码可自助重置」
  入口（P2-40 前端；后端接口见 §13）。
- 邀请模式下显示邀请码输入（`auth-invite`），必填；公开注册时显示为可选。
- 支持从 `?invite=...` 或 `#/login?invite=...` 预填；输入自动转大写。
- 客户端只拦「必填但为空」；是否存在/过期/撤销/用尽由服务端判定。
- 错误按稳定 `code` 映射中越文案：`invite_required` / `invite_invalid` / `registration_closed` / `registration_unavailable` / `registration_busy`；409/429 也有本地化文案。
- 完全关闭注册时显示关闭提示并禁用注册按钮；登录与游客入口不受影响。

### 8.2 管理台（`AdminConsoleScreen.tsx`）

- 新增「邀请码」页签：公开注册状态只读徽标；状态筛选（全部/可用/已用完/已过期/已撤销）+ 数量；分页。
- 「生成邀请码」Dialog：数量/可用次数/有效天数/备注；生成后显示明文、复制按钮和「只显示一次」警告；关闭后不可找回。
- 列表：前缀、备注、已用/上限、状态、过期、创建、撤销按钮；已撤销禁用。
- 撤销二次确认；成功后刷新列表与计数。
- 375px 下表格在自身容器横向滚动，页面不横向溢出；沿用现有设计语言和 Dialog/Table 组件。

## 9. 安全与审计

- 邀请码 ≈60 bit 熵；服务端生成；`secrets` 而非 `random`。
- 库里只有 HMAC 摘要；明文只在创建响应出现一次；日志/截图/工单不得出现明文。
- 注册/登录沿用 `ratelimit` 的 auth 桶（默认 10 次/分钟/IP）；管理员接口沿用 admin 桶。
- 不对失败原因做外部区分；真实原因只写结构化日志。
- 失败注册不消耗邀请码；并发下 `BEGIN IMMEDIATE` + 条件 UPDATE + 唯一索引三重兜底。
- 撤销只影响新注册，不影响已注册账号；如需停用账号走封禁/删会话（既有能力）。

## 10. 测试与验收

后端（`backend/tests/test_invite_registration.py`，27 项）：

- 迁移 0023 表/列/索引；旧库 0022→head 数据保留；downgrade 只删两张表、再升级可恢复。
- 码格式/归一化/只存摘要；关闭注册缺码 403；完全关闭 403；有效码注册成功并写 used_count/redemption；无效/过期/撤销/用尽统一 403；邮箱冲突不消耗码；session 插入失败回滚；并发 max_uses=1 只成功一次；重复兑换拒绝；管理员 401/403；管理员创建/列表/撤销/参数边界；创建后注册闭环；注册限流；审计日志不含明文。
- 全量：`cd backend && venv/bin/python -m pytest tests -q`（本规格相关用例另跑）。
- 迁移命令：`AUTH_DB_PATH=<tmp> venv/bin/alembic upgrade head` / `downgrade 0022_generated_courses`。

前端：

- `cd frontend && npx tsc -b && npm run build && npm run check:i18n`。
- Playwright（`frontend/scripts/check-invite-registration.mjs`，`cd frontend && APP_URL=http://127.0.0.1:5173 npm run check:invite`）覆盖：邀请码注册成功、关闭态、无效码提示、管理员生成/撤销、375/1440 截图。
- 真实浏览器人工验收：关闭注册、有效码、无效码、管理员生成/撤销、375/1440。

## 11. 验收清单

- [ ] `REGISTRATION_OPEN=false` 时无码注册 403 `invite_required`，用户未被创建。
- [ ] 有效邀请码注册 201，`used_count + 1`、redemption 有行、Cookie 可访问 `/api/auth/me`。
- [ ] 无效/过期/撤销/用尽返回统一 `invite_invalid`，不泄露原因。
- [ ] 邮箱冲突 409，邀请码次数不变。
- [ ] 并发两个请求抢 max_uses=1 的码，只成功一个。
- [ ] 管理员可生成/列表/撤销；列表无明文/哈希；非管理员 403。
- [ ] 注册页有邀请码输入、内测/无找回密码提示；管理台有邀请码区块；中越文案齐全。
- [ ] `alembic upgrade head` / `downgrade` 可跑；旧库不丢用户。
- [ ] 登录、游客、claim-guest 行为无回归。

## 12. 后续（不在本规格）

- G2 开放注册前的**是否强制邮箱验证**评审（能力已由 v1.1 P2-38 提供；
  不强制的边界与文案仍需 G2 前决策）。
- 邀请码兑换记录管理端只读页（表已建，M1 未加 `GET /{id}/redemptions`；管理员可在列表中看到 usedCount）。
- M2 账号删除时按用户清理 `invite_redemptions.user_id`（保留 invite_id/时间）。
- M6 的 Caddy Basic Auth 与部署配置。

## 13. v1.1 补充：账号找回 / 邮箱验证（P2-38）

M1 时「忘记密码只能人工核验」的边界在 v1.1 解除（G2 能力建设，默认行为不变）：

- **迁移**：`0033_v1_1_launch` 新增 `auth_tokens` / `feedback` 与
  `users.email_verified_at`；只加不删，旧用户保持未验证、**不强制验证/改密**。
- **密码重置**：`POST /api/auth/password-reset/request` 恒 200（不枚举邮箱）；
  token 只存 SHA-256、30 分钟、单次消费；`confirm` 成功后只失效该用户旧会话
  （不做全局会话批量失效）。
- **邮箱验证**：`POST /api/auth/email-verification/request`（登录态，202）与
  `confirm`；验证成功写 `email_verified_at`。登录/`me` 的 user 追加
  `emailVerified`（旧字段不变）。
- **邮件链接**：`{PUBLIC_BASE_URL}/#/login?reset=<token>` / `?verify=<token>`
  （与前端 `readAuthLinkToken` 的 hash 路由约定一致）。
- **限流**：request 按 IP 15 分钟 5 次 + 按邮箱 15 分钟 3 封（跨进程）；
  超限仍返回 200/202，只静默不发信。
- **邮件**：`backend/emailer.py` 可插拔 SMTP（`SMTP_HOST` / `SMTP_PORT` /
  `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` / `PUBLIC_BASE_URL`）；未配置时写
  dev outbox（默认 `/tmp/linguatrek-email-outbox`）；失败只记日志、不 500、
  日志不打印 token。
- **兼容**：未跑 0033 的旧库，request 恒 200 / confirm 503，登录/注册/使用不受
  影响；旧用户不因未验证被阻断。
- **测试**：`backend/tests/test_auth_recovery.py`（迁移 0032→0033、单次/过期/不枚举、
  outbox、旧用户登录）。
