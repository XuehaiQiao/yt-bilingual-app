# 034 — 余额与 AI 成本（M3a 后端）

> 状态：**M3a 后端 + 迁移 + M3b 前端 + 规格 + 测试已实现** ｜ 2026-11-20
> 依赖：001 用户体系、010 多模型、013/014/019/028/029/030 等 AI 调用方、021 后台、
> 023 用户资料、032 注册、033 账号删除；权威设计见
> `docs/项目提案-上线功能.md` §5（另见 §5.2/5.3/5.6/5.7/5.8/5.11）
> 范围：后端、Alembic 迁移、**前端 UI（M3b）**、规格、测试；不含支付、M4 法务、M5 飞书。
> 前端实现细节见 §15。
> 一句话：给每个账号一个整数微美元余额（新用户 $2.00），每次真实模型调用前预占、
> 调用后按 provider token 用量结算并写流水；缺价模型只记账不扣钱；余额不足 402。

## 1. 目标

- 新账号（邀请码注册 / 公开注册）开户即得 **$2.00 = 2,000,000 µUSD**；建用户、
  余额、`signup_bonus` 流水、会话**同一个事务**，失败整笔回滚。
- 现有 active 存量用户迁移时一次性补发 $2.00（D-3），写
  `signup_bonus_backfill` 流水；**不重复补**（幂等键唯一 + 迁移可重跑）。
- 管理员可在后台手动充值/扣减：美元字符串精确转 µUSD（≤6 位小数）、单次 ±$100、
  原因必填、幂等键、禁止扣成负数；写 `account_ledger` + `admin_audit_log`。
- 每次真实模型调用前按「prompt 输入 + 功能输出上界 × 候选链最高价 × 1.2」预占；
  余额不足返回 **402 `insufficient_balance`**，不消耗日配额。
- 调用成功后按 provider 返回的 usage（缺失时按字符估算并标记）结算：扣余额、
  写 `ai_usage` + `ai_settle` 流水；实际成本允许超过预占（overrun，下次 402）。
- 失败/超时/取消释放预占；结算失败保留 hold 并告警，可重试，不静默丢扣费。
- 缺价模型 `billable=0`：不预占、不扣余额，但仍记录 token / 上界成本 / 价格来源。
- 日配额/日预算/限流仍是 **429**；封禁/待删除仍是 **403**；余额与日预算独立
  （$2 余额 ≠ 每天可花 $2）。
- 老接口 `users.credits` 冻结保留（只读兼容），不参与扣费、不做 1:1 兑换。

## 2. 非目标（M3a 不做）

- 不做支付、充值码、发票、退款流程（M3b 前端已在 §15 落地，用户仍不能自助充值）。
- 不做 M4 文案/法务、M5 飞书告警、多 worker/分布式锁（SQLite 单写进程）。
- 不改 SQLite 架构（仍单文件 + WAL）、不引入 Redis/消息队列。
- 不删除旧 `users.credits` / `credit_transactions`；旧 `POST /api/admin/users/{id}/credits`
  保留但标记 deprecated（响应头 `Deprecation: true`）。
- 不做厂商账单自动对账（`billing/reconciliation` 仅预留思路；本轮仅提供汇总与
  账本对账口径），不保证「绝对准确」（见 §11）。

## 3. 金额单位（唯一口径）

| 名称 | 含义 | 存储/展示 |
|---|---|---|
| `µUSD`（micro-USD） | 1 USD = 1,000,000 µUSD | **数据库一律 INTEGER**；API 字段 `*MicroUsd` |
| `USD` | 美元 | 只在 API 入参/出参字符串（2–6 位小数，如 `"2.00"`、`"0.00372"`） |
| `USD / 1M tokens` | 厂商单价 | `model_prices.input_micro_usd_per_mtok`（整数 µUSD / 1M tokens） |
| `token` / `ms` | 整数 | provider usage / 毫秒 UTC 时间戳 |

禁止：

- 用 `REAL`/浮点存余额、扣费、流水金额；JSON 浮点传金额（管理员接口拒绝非字符串
  `amountUsd`，改传 `amountMicroUsd` 整数）。
- 用旧 `users.credits`（旧单位）或 `ai_usage.est_cost_usd`（目录价估算）当扣费依据。
- 把旧 `credits` 乘 1,000,000（把 100 变成 $100，凭空造钱）。

格式化：`billing.format_usd()` 输出 2–6 位小数（`2_000_000 → "2.00"`，
`3_720 → "0.00372"`，`-500_000 → "-0.50"`）；解析：`billing.parse_usd_amount()`
只接受 `^\d+(\.\d{1,6})?$`，用 `Decimal` 精确转 µUSD，拒绝负号/科学计数法/非字符串。

## 4. 数据模型（迁移 `0025_balance_cost`）

`backend/migrations/versions/0025_balance_cost.py`；`down_revision = 0024_account_lifecycle`。

### 4.1 `users.balance_micro_usd`

- `INTEGER NOT NULL DEFAULT 0`；旧 `credits` 原样保留但**冻结**（不再写、不参与扣费）。
- 旧库连库兼容路径（`auth_db._ensure_user_profile_columns`）会幂等补该列，保证
  未跑迁移的旧部署/测试库也能开户；迁移仍是 schema 真源。

### 4.2 `account_ledger`（append-only）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | `bl-<uuid>`；开户奖励 `bl-signup_bonus-<user_id>`、补发 `bl-backfill-<user_id>` |
| `user_id` | TEXT NOT NULL | 归属用户 |
| `kind` | TEXT NOT NULL | `signup_bonus` / `signup_bonus_backfill` / `admin_topup` / `admin_deduct` / `ai_settle` / `ai_refund` / `adjustment` / `legacy_snapshot` |
| `delta_micro_usd` | INTEGER NOT NULL | 正=入账，负=出账；不能为 0 |
| `balance_after_micro_usd` | INTEGER NOT NULL | 该笔之后账面余额 |
| `ref_type` / `ref_id` | TEXT | `ai_usage` / `hold` / `manual` / `user` / `migration` |
| `reason` | TEXT | 管理员原因 / 系统说明（≤200 字） |
| `actor_id` | TEXT | 管理员 id；系统为空 |
| `idempotency_key` | TEXT | **UNIQUE**（NULL 互不冲突）；管理员充/扣、结算幂等 |
| `created_at_ms` | INTEGER NOT NULL | 毫秒 UTC |

索引：`ux_account_ledger_idempotency`（唯一）、`ix_account_ledger_user_created`、
`ix_account_ledger_kind_created`、`ix_account_ledger_ref`。

**对账口径**：`SUM(delta_micro_usd) == users.balance_micro_usd`；每笔余额变动
必须有一行流水。

### 4.3 `credit_holds`（预占）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | `hold-<uuid>` |
| `user_id` | TEXT NOT NULL | |
| `amount_micro_usd` | INTEGER NOT NULL | > 0 |
| `status` | TEXT NOT NULL | `active` / `settled` / `released` / `expired` |
| `created_at_ms` / `expires_at_ms` | INTEGER NOT NULL | 默认 TTL 30 分钟 |
| `settled_at_ms` | INTEGER | 结算/释放/过期时间 |
| `ai_request_id` | TEXT | 关联 request_id（排障） |

索引：`ix_credit_holds_user_status`、`ix_credit_holds_status_expires`。
`available = balance_micro_usd − SUM(active holds 且未过期)`。

### 4.4 `model_prices`（价格版本表）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | `mp-<日期>-<model>` |
| `model_id` / `provider` | TEXT NOT NULL | 目录 id / 厂商 |
| `effective_from_ms` | INTEGER NOT NULL | 生效时间（毫秒 UTC） |
| `input_micro_usd_per_mtok` / `output_micro_usd_per_mtok` | INTEGER NOT NULL | ≥0 |
| `source_kind` | TEXT NOT NULL | `official_page` / `vendor_bill` / `manual` |
| `source_ref` | TEXT | 官方价格页 URL / 账单号 |
| `verified_at_ms` | INTEGER NOT NULL | 核对时间 |
| `price_version` | TEXT NOT NULL | `YYYY-MM-DD.<source>.<seq>` |
| `note` | TEXT | 币种/含税/缓存/批处理/别名说明 |

唯一索引 `ux_model_prices_model_effective(model_id, effective_from_ms)`：同一模型
同一时刻一条生效价；**历史行不覆盖**，改价新增版本。

### 4.5 `ai_usage` 新列

`cost_micro_usd INTEGER`、`input_price_micro_usd_per_mtok INTEGER`、
`output_price_micro_usd_per_mtok INTEGER`、`price_version TEXT`、`price_source TEXT`、
`token_source TEXT`、`billable INTEGER`、`billing_status TEXT`、`hold_id TEXT`、
`request_id TEXT`。

- 历史行（迁移前）由 0025 标记 `billing_status='legacy'`、`billable=0`、
  `price_source='legacy'`、`token_source='unknown'`；**不按 `est_cost_usd` 补扣**。
- `est_cost_usd`（旧 Float 列）保留：有精确扣费时由 `cost_micro_usd / 1e6` 派生；
  缺价时仍是「已知识别最贵」的**上界估算**，只用于分析/日预算，不是账单。

### 4.6 迁移 seed 与存量补发

价格 seed（核对日 2026-11-20，USD 不含税；见 §11 残余风险）：

| model_id | provider | in（µUSD/1Mtok） | out（µUSD/1Mtok） | 来源 |
|---|---|---|---|---|
| `deepseek-chat` | DeepSeek | 300,000（$0.30） | 1,200,000（$1.20） | 官方价格页 `https://api-docs.deepseek.com/quick_start/pricing`：DeepSeek-V4.1-Flash-1017（模型名 `deepseek-flash`）峰值/未命中缓存价；目录 id 未单列，按同版本 Flash 计，待复核 |
| `gemini-2.5-flash` | Google | 300,000（$0.30） | 2,500,000（$2.50） | 官方价格页 `https://ai.google.dev/gemini-api/docs/pricing` 标准文本价；抓取时官方页重定向受限，经检索到的官方引用值交叉确认，待人工复核 |

**不填**：`qwen-flash` / `qwen-plus`（百炼国内站人民币报价、国际站美元价随地域
不同，不做汇率换算）、`gemini-3.5-flash-lite` / `gemini-3.1-pro-preview`（无法确认
官方单价）。这些模型 `billable=0`，不扣余额。

存量补发：

- `status='active'` 且 `balance_micro_usd=0` 且没有 `signup_bonus` / `signup_bonus_backfill`
  流水的用户 → 置余额 2,000,000 + 写流水（`idempotency_key='signup_bonus_backfill:<uid>'`）。
- `banned` / `deletion_pending` 不补。
- 手工重跑（例如把 `alembic_version` 改回 0024 再 upgrade）不会重复发钱：升级路径
  先查表/索引再建，补发前查幂等键。

## 5. 开户事务（$2.00）

- 配置：`SIGNUP_BONUS_MICRO_USD`（默认 `2000000`；0 = 不发）。
- 公开注册：`auth_db.create_user_with_bonus()` —— `BEGIN IMMEDIATE` 内
  `INSERT users(balance=bonus)` + `account_ledger(signup_bonus)` +（可选）`sessions`；
  失败回滚，不会出现「有账号没余额」。
- 邀请码注册：`invites.register_with_invite()` 原有事务内追加同样两笔；邮箱冲突/
  邀请码失败整笔回滚，**邀请码不被消耗、流水不写**。
- 未跑 0025 的旧库：`billing.ensure_schema_compat()` 幂等建表（与迁移同 DDL），
  开户仍整笔事务；`billing.schema_ready()` 仍为 False（未见 `ai_usage` 计费列），
  **AI 调用不会开始扣费**——计费以迁移生效为前提。
- 旧 `users.credits` 写 0；旧接口 `/credits` 仍可改它，但不会让 AI 可用。

## 6. 管理员充 / 扣

`POST /api/admin/users/{user_id}/balance`（需 `ADMIN_EMAILS`）：

请求（金额二选一）：

```json
{"amountUsd": "2.00", "direction": "credit", "reason": "线下转账",
 "idempotencyKey": "<uuid>"}
```

或 `{"amountMicroUsd": 2000000, ...}`。`direction`：`credit`（默认）/ `debit`；
也接受 `topup/add/increase`、`deduct/subtract`。

校验：金额 > 0；`amountUsd` 最多 6 位小数；单次 ≤ `MAX_ADMIN_BALANCE_DELTA_MICRO_USD`
（默认 $100 或 1e8 µUSD）；`reason` 1–200 字；扣减后不得为负；用户存在。

事务：`BEGIN IMMEDIATE` → 幂等键查重（命中返回原流水，`replayed=true`；同键不同
用户/金额 409）→ 读余额 → `UPDATE users` → `INSERT account_ledger` → commit。
另写 `admin_audit_log`（action=`admin.user.balance_adjust`）。

响应：`{userId, ledgerId, kind, deltaMicroUsd, replayed, balanceMicroUsd,
balanceUsd, availableMicroUsd, availableUsd}`；错误：400 参数/负余额、404 用户、
409 幂等冲突、503 未迁移、401/403 身份。

其它管理台接口：

- `GET /api/admin/users/{id}/ledger?limit&offset`：用户 + 余额 + 流水倒序 + total；
- `GET /api/admin/billing/summary?from=YYYY-MM-DD&to=YYYY-MM-DD`：按天/模型/功能
  汇总（`billedCostMicroUsd` 真实扣费、`estimatedCostUsd` 旧估算、`unbilledRows`
  缺价未扣条数、`legacyRows`、`settleFailedRows`、active holds、余额合计、
  账本合计、当前价格表）；
- `GET /api/admin/users`：每行新增 `balanceMicroUsd` / `balanceUsd`；
- `POST /api/admin/users/{id}/credits`：**deprecated**（响应头 `Deprecation: true`），
  只改旧 `credits`/`credit_transactions`，前端改用新接口。

用户侧：`GET /api/user/summary` 顶层新增 `balanceMicroUsd` / `balanceUsd` /
`availableMicroUsd` / `availableUsd` / `activeHoldsMicroUsd` / `creditsLegacy`；
`user` 对象保持既有字段（`credits` 旧单位冻结）；登录/注册/`me` 的 user 契约不变。

## 7. 预占 / 结算 / 释放

### 7.1 预占（调用前）

- 触发点：`llm.generate()`（所有真实模型调用的唯一收口）；要求调用方已用
  `llm.usage_scope(feature, user_id, target_lang=…)` 声明归属。
- 预估：输入 token = prompt 字符数/2（保守）；输出 = `BILLING_FEATURE_OUTPUT_TOKENS`
  的功能上界（translate 2000、summary 1500、define 800 等）；单价取
  「候选降级链 × 0.5 字符/token 上界」中的**最高** in/out（防切到更贵模型）；
  再乘 `1 + BILLING_RESERVE_MARGIN_PERCENT/100`（默认 +20%），最小 1 µUSD；
  单次封顶 `BILLING_MAX_RESERVE_MICRO_USD`（默认 $0.50），封顶时告警。
- 原子性：`BEGIN IMMEDIATE` → 先把自己过期 hold 标 `expired` → 算
  `available = 余额 − active holds` → 不足则回滚并抛 402 → 否则插 `credit_holds`。
- **不写流水**：账面余额不变，只有可用余额减少。

### 7.2 结算（调用成功后）

- 实际 token：优先 provider usage；缺失部分按 2 字符/token 估算并标
  `token_source=provider/mixed/estimated/unknown`。
- 成本：`ceil(in_tokens × in_price / 1e6) + ceil(out_tokens × out_price / 1e6)`
  （每个分量向上取整到 1 µUSD，最多多收 <1 µUSD/分量，不把成本记成 0）。
- 同一事务：`INSERT ai_usage`（`billable=1`、`billing_status='settled'`、价格快照、
  hold_id、request_id）→ `UPDATE users` 扣 actual → `INSERT account_ledger`
  （`kind='ai_settle'`、`delta=-actual`、`ref_type='ai_usage'`、幂等键
  `ai_settle:<hold_id>`）→ hold 标 `settled`。
- `actual > 预占`：允许，余额可变负，写日志 `billing_overrun`；下次调用因可用
  余额不足 402。
- 重复结算：hold 已 `settled` 时幂等返回，不重复扣。
- 结算写库失败：整笔回滚、hold **保持 active**、ERROR 告警；同时以
  `billing_status='settle_failed'` 尽力写一条 ai_usage 供对账；可人工/脚本重试
  （hold_id + 金额），未扣的钱不会静默消失。
- `BILLING_STRICT=1` 时可让结算异常上抛（默认 0：不让用户已拿到的模型结果因账务
  写库失败而丢失）。

### 7.3 释放 / 过期（失败路径）

- provider 抛错/超时/取消：`UPDATE credit_holds SET status='released'`，不扣钱、
  不写流水；异常原样上抛给降级链。
- 进程崩溃：`expires_at_ms`（默认 30 分钟）过期后，`reserve` 与
  `expire_stale_holds()` 会把仍 active 的 hold 标 `expired`，可用余额恢复。

### 7.4 402 不能被降级链吞掉

`InsufficientBalance` 是计费域异常（`billing.BillingError`），不是模型失败：
翻译/总结/词典/分析/理解题/课程/读文章/导入书/本地剧集/视频处理的重试或降级
`except Exception` 里统一先调 `quota.rethrow_billing_error(exc)`，避免把 402
变成 mock 译文或占位文案。SSE 流开始后无法改 HTTP 状态码，错误事件里带上
`code`/余额字段（流开始前仍返回 402）。

## 8. 402 / 429 / 403 语义

| 状态码 | 含义 | 触发 | 响应要点 |
|---|---|---|---|
| **402** | 余额不足 | 预占时 `available < required`（或 gate 预检查付不起输出上界） | `{detail, code:"insufficient_balance", balanceMicroUsd, availableMicroUsd, requiredMicroUsd, topup:"admin"}` |
| **429** | 日配额/日预算/限流 | 功能日配额、用户日预算、全站日预算、请求限速 | 保持既有中文文案 + `Retry-After`；`code` 语义 `quota_exceeded/budget_exceeded/rate_limited` |
| **403** | 封禁/待删除/无权限 | `users.status=banned/deletion_pending`、非管理员 | 既有 `account_disabled/account_pending_deletion/admin_required` 语义 |
| **401** | 未登录 | 无效会话 | 不泄露账号是否存在 |

检查顺序：认证 → 限流 → **余额可用性（402，`ai.quota.check_and_consume_quota`
入口的低成本预检查）** → 日预算/功能配额（429）→ 预占。余额为 0 且配额也用尽时
优先 402；全站预算耗尽仍 429。

日预算与余额独立：`AI_DAILY_BUDGET_USER_USD`（默认 $1/天）与
`AI_DAILY_BUDGET_GLOBAL_USD`（默认 $20/天）不变；`$2.00` 总额度不等于每天可花 $2。

## 9. 价格读取

优先 `model_prices`（`effective_from_ms <= now` 的最新一条）；无行时用
`config.MODEL_CATALOG` 的 in/out 兜底并标 `price_source='catalog_unverified'`
（**不按「已知最贵」扣费**）；两者都没有 → `price_for_model` 返回 None →
`billable=0`、`price_source='ceiling_unknown'`，不预占、不扣。

`ai_usage.price_source` 取值：`official` / `vendor_bill` / `manual` /
`catalog_unverified` / `ceiling_unknown` / `billing_unavailable` / `no_account` /
`legacy` / `settle_failed`。

## 10. 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `SIGNUP_BONUS_MICRO_USD` | `2000000` | 新用户开户赠送（$2.00）；0 = 不发 |
| `MAX_ADMIN_BALANCE_DELTA_MICRO_USD` | `100000000` | 管理员单次充/扣上限（$100） |
| `BILLING_RESERVE_MARGIN_PERCENT` | `20` | 预占安全边际（%） |
| `BILLING_MAX_RESERVE_MICRO_USD` | `500000` | 单次预占上限（$0.50） |
| `BILLING_HOLD_TTL_SECONDS` | `1800` | hold 过期时间（秒），崩溃兜底 |
| `BILLING_STRICT` | `0` | 1 = 结算失败上抛异常（默认保留 hold + 告警） |

## 11. 「尽量准确」的边界（必须如实告知）

| 误差来源 | 影响 | 处理 | 残余风险 |
|---|---|---|---|
| 模型缺价（qwen / Gemini 3.x） | 无法知道真实单价 | `billable=0` 不扣；`est_cost_usd` 记上界 | 用户可免费用这些模型；$2 暂不约束它们 |
| provider 未返回 usage | token 数不准 | 按字符估算 + `token_source` | 可能高估/低估 |
| 缓存命中/批处理/错峰折扣 | 厂商账单低于标价 | 按标价记 | 账本高于账单 |
| 失败但厂商已计费 | 账本漏记 | 记录失败、月度账单对账 | 无法逐笔归因 |
| 价格调整 | 历史不可比 | `price_version` 不改历史 | 跨版本比较需说明 |
| 币种/税 | 账单含税/其他币种 | 统一 USD 不含税；备注 | 与财务口径差异 |
| tokenizer 差异 | 估算偏差 | 优先 provider usage | 小偏差 |
| 四舍五入 | 每分量 ≤1 µUSD | 向上取整 | 可忽略 |

**结论**：对「有官方价 + provider 返回 usage」的模型可做到可复核的逐次成本；
缺价/估算/失败调用只能算上界或近似，不能承诺绝对准确。G2 前必须补齐默认模型
价格并完成一次厂商账单对账。

## 12. API 摘要

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| GET | `/api/user/summary` | 登录 | 顶层新增余额字段；`user` 契约不变 |
| POST | `/api/admin/users/{id}/balance` | 管理员 | 充/扣（新增） |
| GET | `/api/admin/users/{id}/ledger` | 管理员 | 流水（新增） |
| GET | `/api/admin/billing/summary` | 管理员 | 计费汇总（新增） |
| GET | `/api/admin/users` | 管理员 | 每行新增余额 |
| POST | `/api/admin/users/{id}/credits` | 管理员 | **deprecated**（旧单位） |

## 13. 测试与验收

新增 `backend/tests/test_balance_billing.py`（28 条），覆盖：

1. 迁移 0025：表/列/索引、价格 seed、历史行 `legacy`、active 补发 $2 且重跑不重复、
   downgrade/upgrade 往返；
2. 兼容建表与迁移 schema 逐列/逐索引一致；
3. 公开注册 / 邀请码注册开户事务（含邀请码失败不消耗、流水写失败整笔回滚）；
4. 管理员充/扣：美元字符串精度、整数 µUSD 入口、幂等重放、409 冲突、±$100、
   负数、负数余额、原因/方向/身份校验、审计；
5. 预占/并发不超扣/结算/重复结算/overrun/释放/过期；
6. `llm.generate` 集成：有价预占→结算、缺价不扣、provider 失败释放、结算失败
   保留 hold、无账号不扣；
7. 402 JSON 形状 + 不先扣日配额、429 仍生效、402 优先于 429；
8. 价格版本生效；billing summary 统计未计费行。

验收命令：

```bash
cd backend
./venv/bin/python -m alembic upgrade head && ./venv/bin/python -m alembic downgrade -1 \
  && ./venv/bin/python -m alembic upgrade head
./venv/bin/python -m py_compile *.py ai/*.py
./venv/bin/python -m pytest -q
```

## 14. 已知未接入/未覆盖

- 计费接在 `llm.generate()` 收口，**所有走 LLM 的功能（翻译/summary/词典/本地剧集/
  理解题/读文章/公版书/教学分析/课程生成）都在范围内**；评分/本地词典/规则推荐
  等零模型路径不产生费用。
- **游客与匿名**（无账号）不计费：没有余额账户，只有日配额/全站预算约束。
- **公版书全局缓存翻译**（`book_translation.py`，`user_id=None`）不计费，与游客
  同口径（它另有「只允许匿名触发全局缓存」的设计）。
- 教学分析作为翻译的增强步骤时失败会被降级跳过（主流程已出译文），此时不返回
  402；`/api/teaching-analysis/*` 单独调用会 402。
- SSE 流已开始后余额不足只能发 `error` 事件（HTTP 200），流开始前仍返回 402。
- 缺价模型（qwen / Gemini 3.x）暂不扣费，补齐官方价前 $2 余额不约束这些模型。

## 15. M3b 前端实现（2026-11-20）

代码路径：

| 文件 | 职责 |
|---|---|
| `frontend/src/lib/billing.ts` | 整数 µUSD ↔ USD 的唯一格式化/解析入口（2–6 位小数、无浮点误差）；金额输入精确解析（≤6 位）；管理员幂等键 UUID；余额/流水/计费汇总类型 |
| `frontend/src/lib/api.ts` | `apiFetch` 在 402 `insufficient_balance` 时向全局发布可用/所需余额；402 **不触发** 401 登出；SSE 场景由 `notifyInsufficientBalance()` 复用同一通道 |
| `frontend/src/App.tsx` | 应用壳的余额不足横幅（可用/本次需要 + 「查看账户余额」入口 + 关闭）；SSE `error` 事件的 `code=insufficient_balance` 同走该通道 |
| `frontend/src/lib/toast.ts` | `describeApiError` 把 402 映射为本地化「余额不足」文案（带金额），429 保留配额文案，均不退化成「HTTP 402 / 服务器错误」 |
| `frontend/src/components/AccountScreen.tsx` | 余额卡：可用余额（主）、账面余额、active holds（>0）、本月 AI 花费、今日学习；`$0.00` / 负余额（overrun）/ 旧 credits（历史演示额度）说明；「内测赠送 $2.00 / 联系管理员充值 / 不可购买提现」三条说明 |
| `frontend/src/components/AdminConsoleScreen.tsx` | 用户列表余额列 + 旧额标记；「调整余额」对话框（USD 字符串、方向、原因、前端 UUID 幂等键、确认、预览）；用户流水对话框（最近 50 条、分页、类型/金额/调整后余额/原因/操作者，不渲染幂等键）；新增「计费」标签页（日期范围、真实扣费 µUSD/USD、token、未计费/legacy/settle_failed、hold、余额↔流水对账、无价格模型提示、当前价格表） |
| `frontend/src/i18n/zh-CN.json` / `vi-VN.json` | 全部新增文案中越双语，无硬编码中文 |
| `frontend/scripts/check-balance-billing.mjs` | Playwright 验收（stub API、真实 Chromium）：账户余额四态、402 HTTP/SSE、429、管理台调额成功/校验/400/402/409、流水分页、计费汇总、375/1440 无横向溢出、中越文案 |

设计约束：

- 用户不能自助充值：账户页与管理台都明确「联系管理员」，前端不提供支付入口。
- 管理台旧 `credits` 调额按钮隐藏；旧接口与客户端函数保留（`adjustAdminUserCredits` 标注 deprecated），不参与 AI 扣费。
- 金额一律从整数 µUSD 格式化；`monthSpendUsd` / `estimatedCostUsd` 等旧浮点仅作「估算/分析」并按旧口径展示，不用于余额。
- 402 与 429 语义分离：402 显示余额不足横幅/文案，429 显示原有配额文案。

验收：

```bash
cd frontend
npx tsc -b
npm run build
npm run check:i18n
APP_URL=http://127.0.0.1:5173 npm run check:balance
# 截图：/tmp/balance-billing-shots/
```

已知 API 字段差异（前端按实际代码适配）：

- `GET /api/user/summary` 只有 `monthSpendUsd`（本月估算）与 `usageToday.minutes`，**没有**按用户的「今日 AI 花费」字段；账户页展示现有的本月花费 + 今日学习分钟。
- `GET /api/admin/billing/summary` 的 `byDay` / `byModel` / `byFeature` 只有 `costMicroUsd` / `calls` / `rows` / `unbilledRows`，**没有**分组 token；token 合计只在 `totals.inputTokens/outputTokens` 提供，管理台按该口径展示。
