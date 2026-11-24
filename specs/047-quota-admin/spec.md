# 047 — 管理员可见/可调的每日额度

> 状态：待实现 ｜ 2026-11-24
> 现状：额度只来自 env/config（`AI_DAILY_QUOTA_*`），管理员前台看不到、改不了；用户只会在 429 时知道超限。

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
