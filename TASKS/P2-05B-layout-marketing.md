# P2-05B 营销/法律页宽度与目录

- status: claimed
- owner: {implementer: layout-mkt-impl, reviewer: lead, integrator: lead}
- base_sha: 304ecd2

## goal
博客/定价/资源/法律页用 `marketing` 容器（1200）；法律页 ≥xl 加 240px 目录侧栏；1440 内容 ≥1100，视觉与周报/P2-03 一致。

## write_scope
- `frontend/src/components/BlogScreen.tsx`
- `frontend/src/components/PublicBlogScreen.tsx`
- `frontend/src/components/PricingScreen.tsx`
- `frontend/src/components/ResourcesScreen.tsx`
- `frontend/src/components/LegalDocument.tsx`
- `frontend/src/i18n/zh-CN.json`
- `frontend/src/i18n/vi-VN.json`
- `scripts/p2-05b-layout-acceptance.mjs`（新建）

## read_only
- `docs/设计-桌面布局规范.md`、`frontend/src/components/layout/*`

## acceptance
1. 上述页面用 `PageContainer marketing`；1440 容器 1200；1920 居中 1200；375 单栏。
2. 法律页 ≥xl 左侧目录/右侧正文（或正文+目录），目录 sticky；窄屏目录隐藏。
3. 页头/卡 padding/间距与其他批次一致；无新颜色；G1=0。
4. 现有内容/链接/SEO/路由/testid 不变；i18n 中越对齐。
5. `tsc/build/i18n/gate`；新 Playwright 断言宽度/目录/375；截图 `/tmp/p2-05b-*.png`。
6. 不改后端/App.tsx。

## deps
- P2-02（已完成）
