# P2-10 观影模式接管全屏 + 网页全屏

- status: pending（等 P2-09 释放 App/Watch 组件）
- owner: {implementer: TBD, reviewer: lead, integrator: lead}
- base_sha: 8216056

## goal
播放器不再保留独立「全屏」按钮；「观影模式」成为唯一观影控制，并附带**网页全屏**（page fullscreen，不是 iframe 自带全屏）。

## 行为
- 进入观影：切布局 + 尝试对观影容器调用 `requestFullscreen()`（用户手势内；失败/不支持则静默，只切布局）
- 退出观影：还原布局 + 若当前处于全屏则 `exitFullscreen()`
- 浏览器/ESC 退出全屏：**保留观影布局**，只同步按钮的全屏状态（不强制退出观影）
- 播放器控件里不再有旧的全屏图标按钮；观影按钮显示进入/退出状态与图标
- 移动端/iframe 限制下失败不报错

## write_scope
- `frontend/src/components/VideoPlayer.tsx`
- `frontend/src/App.tsx`（shared，lead 授权：watch/fullscreen 状态）
- `frontend/src/components/WatchSubtitleOverlay.tsx`（如需）
- `frontend/src/components/WatchGlossPanel.tsx`
- `frontend/src/i18n/zh-CN.json`、`vi-VN.json`
- `scripts/watch-mode-acceptance.mjs`
- `specs/044-watch-mode/spec.md`

## acceptance
1. 播放器只剩观影/退出观影按钮；旧全屏按钮与相关未用代码删除。
2. 进入观影调用全屏 API（mock 断言）；退出时调用 exit；浏览器 ESC 退出全屏后布局仍是观影、按钮状态同步。
3. 全屏 API 不存在/拒绝时不报错，布局正常；iframe 控件不冲突。
4. 375/1440；reduced-motion；现有脚本零回归；`tsc/build/i18n/gate`。

## deps
- P2-09
