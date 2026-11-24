# P2-18 字幕落底时序修正

- status: claimed
- owner: {implementer: lead, reviewer: lead, integrator: lead}
- base_sha: 1158654

## 用户反馈
1. 原生控制栏实际约 4s 消失
2. 字幕没有落到视频底部

## 修复
- 字幕落底计时从 2.5s 改为**独立 4s**（顶部 chrome 仍 2.5s）
- 落底位置 4% → **0.5%**，底部内边距 16px → 8px，视觉贴住视频底缘
- 验收：等高线从 ≤6% 改为 ≤3%；等待/截图时序同步

## write_scope
- `frontend/src/App.tsx`、`frontend/src/components/WatchTopBar.tsx`、`frontend/src/components/WatchSubtitleOverlay.tsx`
- `scripts/watch-mode-acceptance.mjs`
- `specs/044-watch-mode/spec.md`、`specs/045-watch-mode-experience/spec.md`
