# P2-42 v1.1 反馈管理台

- status: claimed
- owner: feedback-admin-impl
- base_sha: 1caa6fa

## goal
把已上线的反馈 API 接到管理台，形成闭环：
- 管理台新增「反馈」tab
- 列表：状态/分类/内容/用户或游客/requestId/页面/时间
- 筛选 open/resolved/all；分页/limit
- 展开处理：标记 resolved/open + admin note；保存后刷新
- 空态/loading/error/无权限由 AdminConsole 现有门禁处理
- 中越 i18n；桌面 1440；不碰移动端

## API
- GET /api/admin/feedback?status&limit → 列表
- PATCH /api/admin/feedback/{id} {status,adminNote}
（P2-39 已合并）

## write_scope
- frontend/src/components/AdminFeedbackPanel.tsx（新建）
- frontend/src/components/AdminConsoleScreen.tsx
- frontend/src/lib/admin.ts
- frontend/src/i18n/zh-CN.json、vi-VN.json
- scripts/admin-feedback-acceptance.mjs（新建）
- specs/048-feedback-quota/spec.md（前端落点）

## acceptance
- mock GET/PATCH；tab 可切换；筛选；处理成功/失败；空态
- 1440 截图；tsc/build/i18n；旧 admin 脚本零回归；preflight
