# P2-38 v1.1 schema + 账号找回/邮箱验证

- status: claimed
- owner: schema-auth-impl
- base_sha: 7ddccf2
- task graph: t-muwuwj7aj-9f34

## goal
v1.1 增量 schema + 账号找回后端：
1) migration 0033_v1_1_launch：auth_tokens、feedback、users.email_verified_at（只加不删）
2) 密码重置 request/confirm（token 只存 hash、单次、过期、限流、不枚举邮箱）
3) 邮箱验证 request/confirm（登录态）
4) SMTP 可插拔发送（未配置时 dev outbox/日志；生产不发 token 明文）
5) 旧用户不强制验证、不强制改密；现有 session/数据不变

## API 契约
- POST /api/auth/password-reset/request {email} → 200 {ok:true}（恒成功）
- POST /api/auth/password-reset/confirm {token,password} → 200 {ok:true}; 400/410
- POST /api/auth/email-verification/request (auth) → 202 {ok:true}
- POST /api/auth/email-verification/confirm {token} → 200 {ok:true}
- 登录/me 响应加 emailVerified（不破坏旧字段）

## write_scope
- backend/migrations/versions/0033_v1_1_launch.py
- backend/emailer.py（新建）
- backend/config.py
- backend/routes_auth.py
- backend/auth_db.py
- backend/account_lifecycle.py（如密码策略/会话失效）
- backend/tests/（head 断言 0032→0033、auth recovery/emailer 新测；只改相关）
- specs/032/033/034（如涉及）
- docs/reports/translation-p1...（不改）

## acceptance
- 旧库 upgrade 后 users 行数/ID/密码/数据不变；email_verified_at NULL
- token 不可重放/过期/错误密码策略；请求恒 200 不泄露邮箱是否存在
- SMTP 未配置时不影响应用；配置后真实发送（测试用本地 outbox）
- 新增测试 + 全量 pytest；preflight
