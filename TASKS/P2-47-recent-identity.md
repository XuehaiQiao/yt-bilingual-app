# P2-47 最近学习按账号隔离

- status: claimed
- owner: lead
- base_sha: 959f51d

## 问题
同一浏览器切换账号后，Today 的「最近学习」仍显示上一个账号的条目；后端 `/api/history` 已验证按账号隔离，问题在前端组件未随身份变化重挂载/重拉。

## 修复
- App 给 TodayScreen 传 identity key：`status:user.id:dataRevision`
- 身份变化 → TodayScreen（及 RecentLearning 子列表）重新挂载，重新请求 history/report/articles/books
- 不改后端；不清用户数据
- 本地书/视频进度 localStorage 的按用户 namespace 作为后续独立项（需迁移旧数据，避免误归属）

## write_scope
- frontend/src/App.tsx
- scripts/recent-identity-acceptance.mjs（如新增）
- specs/027-behavior-events 或阅读文档（只回填）

## acceptance
- 同一浏览器切换账号，Today 列表重拉，不显示上一账号 history
- 旧账号重新登录仍能看到自己的数据
- tsc/build；现有脚本零回归
