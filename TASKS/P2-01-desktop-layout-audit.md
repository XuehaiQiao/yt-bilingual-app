# P2-01 桌面端页面宽度审计

- status: merged
- owner: {implementer: lead, reviewer: lead, integrator: lead}
- base_sha: 30f3e05

## goal
以真实登录会话在 1440/1920 视口审计所有主要界面，测量内容容器宽度与主区域占比，形成表格与修复优先级；本轮只审计不改代码。

## 交付
- `docs/reports/desktop-layout-audit-2026-11-23.md`
- 截图 `/tmp/layout-audit-*.png`

## 结论摘要
- 672px：周报、能力档案、考试、定位（最窄）
- 768px：内容发现、阅读列表、导入文章、句子精背、公版书阅读、课程
- 1024px：单词本、博客/定价/资源/法律
- 1152–1440px：练习/我的/免费库文章/视频学习/导入书/后台/内容/今日/免费资源等

## rollback
仅新增报告/任务卡。
