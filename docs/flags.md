# Feature Flags

> 唯一默认值来源：`CONTRACTS/flags.yaml`。代码禁止裸布尔常量。

## 命名

`ff.<域>.<特性>`，如 `ff.review.ui`、`ff.course.generation`。域与领域模块一致（review/vocabulary/reading/billing/...）。

## 必填字段

Owner、`default`、`created`、`expiry`、`removal`（移除条件）。到期未删 → 门禁报红（P1 起 `check-flags`）。

## 读取

- 前端：只能 `useFlag('ff.review.ui')`（P1 建 SDK）；当前迁移期允许一个集中常量模块过渡，禁止新增组件内常量。
- 后端：`flags.is_enabled()`；关闭态统一返回 403 `feature_disabled`，判定点唯一。
- 远端覆盖：`/api/flags`（ETag/60s 缓存）；变更写 `admin_audit_log`。

## 生命周期

`proposed → on(gray) → on(all) → off → removed`。每一步记录：日期、Owner、影响面、回滚方式。

## 现有迁移项

| 旧机制 | 位置 | 迁移到 |
|---|---|---|
| `REVIEW_UI_ENABLED` | `frontend/src/lib/review.ts:18` | `ff.review.ui` |
| `SHOW_COURSE_GENERATION` | `frontend/src/App.tsx:287` | `ff.course.generation` |
| `import.meta.env.DEV` / `VITE_GISCUS_*` | 构建期/第三方配置 | 保留为构建配置，不算业务开关 |
