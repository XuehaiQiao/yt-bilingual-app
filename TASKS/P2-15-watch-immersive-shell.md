# P2-15 观影模式体验 · 第一期：沉浸壳层 + 字幕模式

- status: claimed
- owner: {implementer: watch-shell-impl, reviewer: lead, integrator: lead}
- base_sha: 92f9fed
- design: specs/045 + docs/design/watch-mode/

## goal
先把“观影感”做出来：
- 观影模式隐藏 AppShell 顶栏和 LearningHeader，只留浮层顶部条（返回/标题/模式/字幕/退出），指针静止自动淡出
- 视频居中、环境光填充黑边，不再顶在上方
- 字幕三态：双语 / 仅英文 / 关闭（原生字幕）；持久化，`C` 循环
- **保留 YouTube 原生播放控制条**（原生字幕入口不能丢；自定义传输条不在本期）
- 词条栏/移动抽屉留到 P2-16

## write_scope
- `frontend/src/App.tsx`（shared lease）
- `frontend/src/components/AppShell.tsx`（新增可选 hideTopbar）
- `frontend/src/components/VideoPlayer.tsx`
- `frontend/src/components/WatchTopBar.tsx`（新建）
- `frontend/src/components/WatchSubtitleOverlay.tsx`
- `frontend/src/lib/layout.ts`（watchSubtitleMode 持久化）
- `frontend/src/i18n/zh-CN.json`、`vi-VN.json`
- `scripts/watch-mode-acceptance.mjs`
- `specs/044-watch-mode/spec.md`、`specs/045-watch-mode-experience/spec.md`

## acceptance
1. 观影模式：AppShell 顶栏、LearningHeader 不渲染；顶部浮层条含返回/标题/模式/字幕/退出；2.5s 静止淡出，移动/触摸/键盘出现。
2. 视频在剩余区域居中；环境光/模糊背景填充黑边；无大块死黑；1440/1920/375 不溢出。
3. 字幕三态：双语/仅英文/关闭；关闭后不渲染覆盖层；原生 iframe 控制条保留且可操作；切换不重载播放器、不丢播放位置。
4. `C` 循环三态；偏好持久化；菜单可键盘/点击操作；关闭后词条仍可用（P2-16 接）。
5. 退出观影/全屏/Esc 层级保持；P2-10/P2-11/P2-12/P2-13 断言零回归。
6. `tsc/build/i18n/gate`；watch acceptance 更新；375/1440/1920 截图；preflight。

## deps
- P2-10/P2-11/P2-12/P2-13
