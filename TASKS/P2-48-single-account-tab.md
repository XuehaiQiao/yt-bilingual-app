# P2-48 单浏览器单活跃账号（跨 tab 同步）

- status: claimed
- owner: lead
- base_sha: 4a... placeholder

## 问题
同一浏览器多个 tab 可显示不同账号：cookie 是单会话，登录 B 后其他 tab 仍显示 A 的 UI，但 API 已按 B 返回，造成“看似同时登录、实际串数据”。

## 修复
- AuthProvider 登录/注册/退出/本地清会话时广播（BroadcastChannel + localStorage 事件 fallback）
- 其他 tab 收到后强制 reload，重新 `/api/auth/me`，清掉旧账号 React 状态
- 不在同一 tab 自触发；不轮询
- v1.1.1 不做账号切换器；多账号用独立浏览器 profile/隐身窗口

## write_scope
- frontend/src/lib/auth.tsx
- scripts/auth-cross-tab-acceptance.mjs（新建）
- specs/023-user-profile/spec.md（说明）

## acceptance
- tab A 登录 B 后，tab A 自动 reload 并显示 B；不会保留 A 数据
- 退出登录后其他 tab reload 为 guest/anonymous
- 无 reload 循环；无登录态时正常
