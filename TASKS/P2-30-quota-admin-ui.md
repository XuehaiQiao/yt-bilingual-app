# P2-30 管理台额度 UI

- status: claimed
- owner: {implementer: quota-ui-impl, reviewer: lead, integrator: lead}
- base_sha: b6fd813

## goal
管理台新增「额度」面板，让管理员看见并调整每日额度（后端 P2-28 已完成）。

## write_scope
- `frontend/src/components/AdminQuotasPanel.tsx`（新建）
- `frontend/src/components/AdminConsoleScreen.tsx`
- `frontend/src/lib/admin.ts`（类型/4 个 API）
- `frontend/src/i18n/zh-CN.json`、`vi-VN.json`
- `scripts/admin-quotas-acceptance.mjs`（新建）
- `specs/047-quota-admin/spec.md`

## acceptance
1. 新 tab「额度」；全局默认 8 功能表：功能/默认值/来源（后台/环境）/编辑；预算只读展示。
2. 保存默认：只提交改动；0=关闭；「恢复环境默认」；成功/失败/loading；写后刷新。
3. 单用户：搜索用户→选择→8 功能默认/覆盖/生效/今日已用/剩余/来源；覆盖可设 0、可清除回继承；reason 必填；保存成功/400/404/503。
4. 移动端可横向滚动不撑破；无权限/未登录由 AdminConsole 现有门禁处理。
5. Playwright mock 全流程（默认修改、用户覆盖、清除、错误）；`tsc/build/i18n/gate`；现有 admin 脚本零回归；preflight。
