# P2-40 v1.1 P0 前端闭环

- status: claimed
- owner: v11-frontend-impl
- base_sha: 7ddccf2

## goal（独占 App/i18n 写域）
1) 登录页：忘记密码、重置密码页、邮箱验证提示；不破坏旧登录
2) 用户额度页：今日剩余/重置时间/各功能用量
3) 反馈入口：分类/描述/自动 request_id/提交成功
4) 首次激活：新用户 3 步引导（看一段 → 查一个词 → 复习/计划），可跳过
5) AI 生成标识：翻译/分析/习题旁 “AI 生成” 小标识
6) **不碰移动端**：v1.2 才重构；本轮不新增/不修改 390px、底部栏、PWA、断线重连相关布局（可保留既有行为）
7) 全部中越 i18n；错误/loading/空态

## API 契约（P2-38/39 提供）
- POST /api/auth/password-reset/request|confirm
- POST /api/auth/email-verification/request|confirm
- GET /api/quota
- POST /api/feedback
- 认证/额度/反馈失败不得白屏

## write_scope
- frontend/src/App.tsx
- frontend/src/components/AuthScreen.tsx
- frontend/src/components/AccountScreen.tsx / ProfileScreen.tsx / TodayScreen.tsx / WelcomeScreen.tsx
- 新建 FeedbackDialog/QuotaPanel/AIGeneratedBadge/Onboarding
- frontend/src/lib/{auth,user,quota,feedback}.ts
- frontend/src/i18n/{zh-CN,vi-VN}.json
- scripts/v11-p0-acceptance.mjs
- specs/023/027/032/033（只回填前端落点）

## acceptance
- 找回密码/额度/反馈/引导/AI 标识可用；旧用户登录/数据不变
- 桌面 1440 验收；tsc/build/i18n；旧脚本零回归；preflight

- `frontend/src/components/ReaderScreen.tsx`
- `frontend/src/components/LibraryArticleReader.tsx`
- `frontend/src/components/TeachingNotesPanel.tsx`
- `frontend/src/components/QuizScreen.tsx`
- `frontend/src/components/ExamScreen.tsx`
- `frontend/src/lib/auth.tsx`
- `specs/023-user-profile/spec.md`