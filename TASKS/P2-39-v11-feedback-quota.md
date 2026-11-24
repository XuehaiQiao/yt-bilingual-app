# P2-39 v1.1 反馈 + 用户额度 API

- status: pending（依赖 P2-38 schema）
- owner: feedback-quota-impl
- base_sha: 7ddccf2

## goal
1) 反馈/纠错：POST /api/feedback（登录/游客均可，限流、request_id、分类、页面）；GET/PATCH /api/admin/feedback（管理员）
2) 用户额度：GET /api/quota（登录）返回各功能 limit/used/remaining/resetAt/source；只读，复用 quota_config/ai_quota
3) 不改变管理台现有 /api/admin/quotas

## write_scope
- backend/feedback.py（新建）
- backend/routes_feedback.py（新建）
- backend/routes_user.py 或 routes_account.py（quota endpoint）
- backend/main.py（router）
- backend/routes_admin.py（feedback admin，如独立）
- backend/tests/test_feedback.py、test_user_quota.py
- specs/047 或新 spec、docs

## acceptance
- 反馈入表（0033）、限流/非法 400、游客可用；admin 列表/状态
- /api/quota 401 未登录；数值与 admin 口径一致；0=关闭；重置时间正确
- 全量 pytest；preflight

## integration
- `specs/048-feedback-quota/spec.md`
- `frontend/src/components/QuotaPanel.tsx`（source=user_override 徽章兼容）
