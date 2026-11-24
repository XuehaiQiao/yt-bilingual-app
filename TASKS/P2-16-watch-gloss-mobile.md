# P2-16 观影模式体验 · 第二期：词条栏 + 移动抽屉

- status: claimed
- owner: {implementer: watch-gloss-impl, reviewer: lead, integrator: lead}
- base_sha: 2405355
- design: specs/045 §4.3 / §5 + docs/design/watch-mode/

## goal
1) 桌面词条栏按目标稿重做：360px、当前句目标置顶、历史渐隐、hover/focus 操作、收藏一键、无分析空态。
2) 移动端改为“视频顶部 + 底部词条抽屉”，替代右上浮窗；视频不再垂直居中留大片空白。
3) 保留 P2-15 壳层/字幕三态/原生控制条。

## write_scope
- `frontend/src/App.tsx`（shared lease）
- `frontend/src/components/WatchGlossPanel.tsx`
- `frontend/src/components/WatchTopBar.tsx`（仅移动端布局微调）
- `frontend/src/i18n/zh-CN.json`、`vi-VN.json`
- `scripts/watch-mode-acceptance.mjs`
- `specs/044-watch-mode/spec.md`、`specs/045-watch-mode-experience/spec.md`

## acceptance
1. 桌面：rail 360；标题+本句数；当前句 3 行内；历史 opacity 渐隐；无 headings/badges/context/empty；收藏星标 hover/focus 出现；无分析空态有生成入口。
2. 收藏：一键加入/取消，App 顶栏计数同步；失败行内回滚；不新增 AI。
3. 移动：视频 16:9 置顶；底部抽屉占剩余高度（默认展开、可收起），不再右上浮窗；375 无溢出/不遮视频控制；字幕三态仍可用。
4. 桌面/移动截图；P2-10/11/12/13/15 断言零回归。
5. `tsc/build/i18n/gate`；watch acceptance 2× PASS；preflight。

## deps
- P2-15
