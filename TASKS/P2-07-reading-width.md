# P2-07 阅读正文在宽屏下放宽

- status: merged
- owner: {implementer: lead, reviewer: lead, integrator: lead}
- base_sha: 5b97764

## goal
用户反馈阅读正文每行仅 7–8 词、偏窄。保留可读性同时，在宽屏按视口放宽正文列：
- <1280：68ch
- ≥1280（xl）：76ch（容器仍 1200）
- ≥1536（2xl）：88ch，容器放宽到 1360，rail 仍 320

## 验收
- 1440 正文 ~730–830px（76ch），1920 正文 ~840–940px（88ch）
- 双栏/rail 320/无横向溢出不变；六阅读页与 375 单栏不回归
- 更新 `scripts/p2-04-layout-acceptance.mjs`、设计规范、截图、门禁
