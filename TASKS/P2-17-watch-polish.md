# P2-17 观影模式打磨：字幕落底/高亮/词条统一/Esc

- status: claimed
- owner: {implementer: watch-polish-impl, reviewer: lead, integrator: lead}
- base_sha: 6e48c87

## 需求（用户）
1) 字幕在 YouTube 底部控制栏消失后落到视频底部
2) 词条行统一：词汇释义在右，语言点/文化点解释也在右（不再下一行）
3) 词条字号太小，且不随屏幕尺寸变化
4) 字幕中显示标亮词汇（橙底）和文化点/语言点（蓝底）
5) Esc 取消网页全屏时自动退出观影模式

## write_scope
- `frontend/src/App.tsx`（shared lease）
- `frontend/src/components/WatchSubtitleOverlay.tsx`
- `frontend/src/components/WatchGlossPanel.tsx`
- `scripts/watch-mode-acceptance.mjs`
- `specs/044-watch-mode/spec.md`、`specs/045-watch-mode-experience/spec.md`

## acceptance
1) 字幕：控制栏可能可见时抬高；指针静止 2.5s 后降到视频底缘（bottom 约 4%）；指针/触摸/键盘再抬高；过渡 200ms，reduced-motion 直切；不遮原生控制。
2) 词条：词汇与语言点均一行「词/短语左，释义右」，右列可换行；字体随视口缩放（约 16→22 / 14→18），375/1440/1920 明显递增；不再是 11–12px。
3) 字幕高亮：英文句内标亮词橙底、语言点/文化点蓝底；文本完整、可读；无 HTML 注入；切句更新；关闭字幕后不渲染。
4) Esc 退出网页全屏 → 自动退出观影模式（布局恢复、按钮状态正确）；用户点「退出观影」仍正常；request 失败/无全屏时不受影响。
5) P2-10/11/12/13/15/16 零回归；watch acceptance 2× PASS；375/1440/1920 截图；`tsc/build/i18n/gate`；preflight。

## deps
- P2-16
