# 047 — 管理员可见/可调的每日额度

> 状态：**后端（P2-28）+ 管理台 UI（P2-30）已实现** ｜ 2026-11-24
> 背景：此前额度只来自 env/config（`AI_DAILY_QUOTA_*`），管理员前台看不到、改不了；用户只会在 429 时知道超限。P2-28/P2-30 之后管理台可看可调。
>
> 代码落点：`backend/quota_config.py`（三层解析/缓存/校验）、`backend/ai/quota.py`
> （`limit_for` / `snapshot` / `check_and_consume_quota`）、`backend/routes_admin.py`
> （`/api/admin/quotas*` 四个端点）、`backend/migrations/versions/0031_quota_overrides.py`
> （覆盖表）、`backend/tests/test_quota_admin.py`（验收）、`backend/tests/test_migrations.py`
> （head 0031 + 回滚）、`backend/tests/test_quota_ops_subject.py`、`backend/tests/test_ai_ledger.py`
> （旧配额语义零回归）；管理台 `frontend/src/components/AdminQuotasPanel.tsx`、
> `frontend/src/components/AdminConsoleScreen.tsx`（「额度」tab）、
> `frontend/src/lib/admin.ts`（类型 + 4 个 API）、`scripts/admin-quotas-acceptance.mjs`。

## 1. 成熟产品做法（参考）

Stripe Billing entitlements、OpenAI usage limits、AWS Service Quotas、GitHub Actions limits 的共同点：

1. **分层生效**：套餐/全局默认 → 用户级覆盖 → 本次请求硬闸；覆盖有原因、有操作者、有审计。
2. **可见**：管理员能看到「默认值 / 实际生效值 / 今日已用 / 剩余 / 来源（默认/覆盖）」。
3. **可调但不裸奔**：全局默认一次改所有用户；单用户覆盖用于客服/大客户；不直接改 env 重启。
4. **有边界**：0=关闭、正数=限额；校验上限；修改审计；缓存失效即时生效。
5. **用户侧透明**：用户能看到今日用了多少/剩多少（至少 429 文案带 limit/remaining）。

## 2. 本期范围

- 全局默认：按 feature 调整每日额度（translate/summary/define/local_show/quiz/reading/analysis/course_generation）
- 单用户覆盖：为某个用户按 feature 设置 0..N；清除后回继承默认
- 管理员 UI：额度表格（默认/生效/今日已用/剩余/来源）、编辑默认、用户覆盖编辑
- 预算只读展示（user/global daily budget），本期不改预算
- 所有修改写 admin audit；运行时立即生效（≤5s 缓存）

## 3. 数据与解析

- 全局默认存 `app_settings` key `ai_quota_defaults`（JSON `{feature: int}`）；缺省回落 env/config。
- 单用户覆盖表 `quota_overrides`（migration 0031）：
  `user_id, feature, limit_units>=0, reason, created_by, created_at_ms, updated_at_ms`，唯一 `(user_id, feature)`。
- 生效顺序：用户覆盖 > 全局默认 > config。
- `0` = 关闭该功能；不提供「无限」语义（避免误配）。
- 缓存：`quota_config` 进程内 5s；管理员写入后立即清缓存。

## 4. API

- `GET /api/admin/quotas` → `{features:[{feature,defaultLimit,source}], budgets:{userDailyUsd,globalDailyUsd}}`
- `PUT /api/admin/quotas/defaults` `{limits:{feature:int|null}}`，null=回退 env；返回新值；audit。
- `GET /api/admin/quotas/users/{user_id}` → `{user, features:[{feature,defaultLimit,overrideLimit,effectiveLimit,usedToday,remaining,source}]}`
- `PUT /api/admin/quotas/users/{user_id}` `{overrides:{feature:int|null}, reason}`；null=清除；audit。
- 错误：400 校验、404 用户不存在、503 表未迁移；全部 require_admin。

## 5. 运行时

- `quota.limit_for(feature, user_id=None)` 读 effective；`check_and_consume_quota` 显式传 limit，保证判定/报错/审计一致。
- `quota.snapshot` 返回 `limit_source`(config/default/user_override)、`default_limit`、`override_limit`。
- 429 响应保留 feature/used/limit/remaining；管理员 UI 实时反映。
- 不改变预算逻辑、不改变游客/ops 主体语义。

## 6. 验收

- 默认展示 8 个 feature 的 config 值；修改一个默认后，新请求按新值 429/通过，旧进程缓存 ≤5s 失效。
- 单用户覆盖优先于默认；清除后回继承；0 生效；其他用户不受影响。
- 审计有字段/前后值/操作者；一次修改一个事务。
- 用户 429 文案仍可用；管理台 375/1440；现有计费/配额测试零回归。

## 7. 后端实现落点（P2-28 回填，2026-11-24）

- **配置层** `backend/quota_config.py`：`QUOTA_FEATURES`（8 个有用户额度的功能；
  `books` / `discover` 没有用户额度，配置它们返回 400）→ `limit 0..1_000_000`
  （`0` = 关闭，无「无限」语义）。全局默认存 `app_settings.ai_quota_defaults`
  （JSON，只记显式项；`null` 删键回退 env，全部回退时整行删除）；单用户覆盖存
  `quota_overrides`。进程内 5s 缓存（按 `AUTH_DB_PATH` 隔离），写后
  `invalidate()` 立即失效。覆盖表缺表：管理 API 抛 `QuotaConfigUnavailable` → 503；
  运行时 `ai.quota` 捕获后只按默认层继续（fail-open + 一次 WARNING，不阻断 AI 链路）。
- **运行时** `backend/ai/quota.py`：`limit_for(feature, user_id=None)` 走
  `quota_config.effective_limit`（覆盖 > 默认 > config，返回
  `limit/source/default_limit/override_limit`）；`check_and_consume_quota` 把
  effective limit **显式**传给 `ledger.check_and_consume_quota(limit=...)`，429 与
  `snapshot` 的 `limit_source/default_limit/override_limit` 同源。ops/sponsored
  语义不变（仍 `ops_limit_for`，不使用用户覆盖）。
- **API**（全部 `require_admin`）：
  - `GET /api/admin/quotas` → `{features:[{feature,defaultLimit,source}], budgets:{userDailyUsd,globalDailyUsd}}`；
  - `PUT /api/admin/quotas/defaults` `{limits:{feature:int|null}}` → 同上 `features` + `changes`（`from/to` 为存储值语义，`null` 表示回退 env）；
  - `GET /api/admin/quotas/users/{id}` → `{user:{id,email,username,status}, features:[{feature,defaultLimit,overrideLimit,effectiveLimit,usedToday,remaining,source}]}`；
  - `PUT /api/admin/quotas/users/{id}` `{overrides:{feature:int|null}, reason}` → 同样的用户额度体 + `changes`；`reason` 必填 1–200 字。
  - 错误：校验/空对象 400、用户不存在 404、表未迁移 503；写操作一个事务 + 清缓存 + `admin_quota` 审计（`admin.quota.defaults_update` / `admin.quota.user_override_update`，含操作者、目标、before/after、reason）。
- **管理台 UI**（P2-30，2026-11-24）：
  - `AdminConsoleScreen` 新增「额度」tab（`Gauge` 图标，`quotasNonce` 走控制台刷新）；
    `AdminQuotasPanel.tsx` 两张卡：全局默认 / 单用户额度。
  - 全局默认卡：8 功能表格（功能中文 label、默认值输入、来源 badge「后台默认/环境变量」、
    行内「恢复」），只提交改动项（对比当前展示的默认值；`0` 显示「关闭」）；
    行恢复与「全部回退环境默认」把该功能标记为待回退（`null`），保存后回继承 env；
    保存/重置/loading/错误/成功齐全；写后用响应重建表格（无需二次请求）。
  - 预算卡：用户日预算 / 全站日预算只读（`formatUsdNumber`；无输入控件）。
  - 单用户卡：搜索框 300ms 防抖调 `fetchAdminUsers({search, limit: 8})`；
    选中后 `GET /api/admin/quotas/users/{id}` 渲染 8 行的默认/覆盖/生效/今日已用/剩余/来源；
    覆盖输入留空=继承、`0`=关闭；reason 必填 1–200 字（超长/空值前端拦截）；
    保存只提交改动项，清除全部覆盖先经 `ConfirmDialog` 再提交 `null`；
    400/404/503 行内（`role="alert"`）错误、失败保留草稿可重试。
  - 375：`<Table minWidth>` 自管横向滚动，页面零横向溢出；输入/图标按钮有
    `aria-label`、`aria-invalid` 与可见 focus ring；中越文案齐全。
  - 验收：`node scripts/admin-quotas-acceptance.mjs`（mock 4 个 API；A–F 6 组、
    73 断言，含 400/404/503、只提交 changed、0/清除、375/1440 截图与 vi-VN 无中文）；
    既有 `check:balance` / `check:invite` / `check:account` 零回归。
- **验收测试**：`backend/tests/test_quota_admin.py`（默认/覆盖/0/清除/隔离/缓存/TTL/审计/权限/404/503/端到端 429）；`backend/tests/test_migrations.py`（head 0031 + 复合主键/CHECK/回滚/幂等）。
