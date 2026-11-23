# P2-08 观影模式最小版

- status: claimed
- owner: {implementer: watch-impl, reviewer: lead, integrator: lead}
- base_sha: ec34e04

## goal
按 `specs/044-watch-mode` 实现看视频页观影模式：放大画面 + 单句字幕窗 + 当前句词条窗；零新增 AI；教学面板不渲染。

## write_scope
- `frontend/src/lib/layout.ts`（watchMode 持久化）
- `frontend/src/components/WatchSubtitleOverlay.tsx`（新建）
- `frontend/src/components/WatchGlossPanel.tsx`（新建）
- `frontend/src/components/VideoPlayer.tsx`（如需 children/overlay 槽）
- `frontend/src/App.tsx`（shared，lead 授权：开关状态/布局/当前句）
- `frontend/src/components/TeachingNotesPanel.tsx`（watch 模式不渲染）
- `frontend/src/i18n/zh-CN.json`、`vi-VN.json`
- `scripts/watch-mode-acceptance.mjs`（新建）
- `specs/044-watch-mode/spec.md`、`specs/README.md`

## acceptance
1. 开关持久化；开启后视频放大、右栏冗余收起、教学面板不渲染；关闭恢复。
2. 单句字幕窗只显示当前句（中上英下）、随播放更新、不遮挡控件、不拦截点击。
3. 词条窗随当前句显示标亮词/语言点；空态/未分析态正确；零新增 AI。
4. reduced-motion 无动画；全屏语义不变；现有脚本零回归。
5. `tsc/build/i18n/gate`；新 Playwright；1440/375 截图；preflight `--staged --as-integrator`。

## deps
- P1-17/P1-18（已收口）
