# 044 — 观影模式（最小版）

> 状态：**已实现（2026-11-23，P2-08；P2-09 字号/历史；P2-10 接管网页全屏）** ｜ 依据：`docs/计划-v1.1.md` 任务 1（D1-1/D1-2 已拍板：只做看视频页；≥1280 右侧固定词条栏）
> 成本：0（只读已有分析缓存，不新增 AI 调用）。

## 1. 开关与布局

- `watchMode: off | on`，localStorage key `yt_bilingual_watch_mode`
- 入口：看视频页播放器工具栏（图标+文字，`aria-pressed`）；**观影模式是唯一的观影控制**，播放器不再保留独立的「全屏」按钮
- 开启后：视频放大为主区；隐藏右栏摘要/工具栏冗余项；**教学面板不渲染**（不是折叠）
- 关闭：恢复现有 stacked/split 布局与教学面板
- 尊重 `prefers-reduced-motion`

## 1b. 网页全屏（P2-10，方案 A）

- **进入观影**：切布局 + 在点击手势内对观影容器（学习 shell）调用 `requestFullscreen()`；这是**网页全屏**，不是 YouTube iframe 自带的全屏（`fs: 0` 不变，iframe 控件不受影响）
- **退出观影**：还原布局 + 若 `document.fullscreenElement` 仍是本容器则调用 `exitFullscreen()`
- **浏览器 / ESC 退出全屏**：**保留观影布局**，不强制退出观影；只把「是否处于网页全屏」的状态同步到界面（`learning-scroll` 的 `data-page-fullscreen`）
- **失败 / 不支持**（移动端 Safari、iframe 未授权、请求被拒）：静默降级为仅切换布局，不报错、不 `console.error`
- **路由切走 / 组件卸载**：若仍是本容器全屏，清理退出；cleanup 不抛错
- **刷新 / 直达链接**：观影模式会持久化，但网页全屏**不会**自动恢复——浏览器要求用户手势，只有点击「观影模式」才进入全屏；此时布局仍是观影态


## 2. 单句字幕窗

- 绝对定位在视频区下缘（玻璃配方 `bg-zinc-950/70 backdrop-blur-md border-t border-white/5`）
- 只显示当前句：**英文在上（主内容，17px，`text-section`）**、中文在下（辅助，15px，`text-body-zh`）；不显示整条 transcript
- 字号只走 `tailwind.config.js` 的字号 token，不写裸 px；行高沿用 `leading-snug`，居中、`text-balance`
- 随播放推进更新；无当前句时隐藏
- 不遮挡 YouTube 底部控件（抬高到画面约 12% 以上）
- `pointer-events` 分层：字幕窗不拦截播放器点击
- 375 与 1440 都在媒体区内换行，不横向裁切、不溢出画面

## 3. 词条窗

- ≥1280：右侧固定栏（320–360）；<1280：浮层
- 内容 = 当前句的难度标亮词（wordGlossesByBlock）+ 语言点（idioms/culture）
- **按句累积（P2-09）**：当前句词条固定在顶部；切到下一句时新句插到顶部，旧句条目向下顺延，直到滚出窗口/超过 30 句
- **去重**：同一 `blockId` 再次出现（回看/跳转）只把原条目移到顶部，不重复插入；条目按 `blockId` 唯一
- **每条带句子上文**：英文原句截断一行（`truncate`，`title` 可看全文），便于区分历史句子；当前句带高亮点与 `aria-current`
- **滚动**：新句出现时 `scrollTop = 0`；用户手动向下滚动后不再强制拉回，滚回顶部后恢复自动跟随
- **空句**：当前句无词条时在顶部显示「本句无生词」，旧条目仍保留
- **状态**：loading/error/login/未分析仍按原逻辑整块呈现；只有分析 `ready` 后才开始累计历史
- 不同视频（`contentRef` 变化）重置历史，避免跨视频的 blockId 串档
- 不新增 AI 调用；只读缓存

## 4. 验收

- 开关持久化；开/关布局与教学面板正确；reduced-motion 无动画
- 当前句字幕与词条随播放/跳转更新；切句不闪整条字幕
- 字幕英文在主位（≥17px）、中文在辅位（≥15px），375/1440 不裁切/不溢出
- 词条窗数据与页面 ruby/语言点一致；空态文案正确
- 历史顺延：新句在顶部、旧词仍在、同一句去重移顶、新句自动回顶、手动滚动不被拉回、空句保留旧条目
- 网页全屏（P2-10）：进入观影调用全屏 API、退出观影调用 exit；ESC/浏览器退出全屏后布局仍是观影且状态同步；API 不存在或被拒时不报错、布局正常；路由切走退出清理
- 播放器控件只有观影/退出观影按钮，无旧全屏按钮（`video-fullscreen-toggle` 不存在）
- 现有播放/字幕/听读/验收脚本零回归；1440/375 截图

## 5. 实现落点（2026-11-23）

| 内容 | 位置 |
|---|---|
| `watchMode` off/on 持久化（key `yt_bilingual_watch_mode`；与 stacked/split、左列比例分键存储） | `frontend/src/lib/layout.ts` |
| 播放器工具栏入口（图标+文字、`aria-pressed`、悬停/触屏可见；切换携带播放进度，不重新起播；**无独立全屏按钮**） | `frontend/src/components/VideoPlayer.tsx` |
| 网页全屏（进入手势内 `requestFullscreen()` 于学习 shell、退出条件 `exitFullscreen()`、ESC 保留布局、失败/不支持静默、路由/卸载清理、`data-page-fullscreen` 状态） | `frontend/src/App.tsx` |
| 单句字幕窗（英上中下、17/15px token、玻璃条、`pointer-events-none`、无当前句隐藏、无动画） | `frontend/src/components/WatchSubtitleOverlay.tsx` |
| 词条窗（≥1280 固定右栏 `clamp(20rem,24vw,22.5rem)`；<1280 浮层；loading/error/空句/无分析四态；P2-09 最近 30 句历史/去重/滚动） | `frontend/src/components/WatchGlossPanel.tsx` |
| 学习视图接线（观看 shell、教学面板/摘要/字幕工具栏不渲染、当前句取 `activeTranscriptIndex`，向词条窗传 `blockId`/`enText`/`contentRef`） | `frontend/src/App.tsx` |
| 文案（zh-CN / vi-VN） | `frontend/src/i18n/zh-CN.json`、`vi-VN.json` |
| 验收脚本（开关持久化、布局/教学面板、播放/跳转跟句、词条/空态、字幕英主中辅字号、历史顺延/去重/滚动、reduced-motion、网页全屏 stub 断言/失败降级、1440+375 截图） | `scripts/watch-mode-acceptance.mjs` |

词条数据只读既有教学分析（specs/028）：`wordGlossesByBlock` + `languagePointsByBlock`；
无分析态的重试按钮复用 `GET /api/teaching-analysis/{content_ref}`，本规格不新增任何 AI 调用。
