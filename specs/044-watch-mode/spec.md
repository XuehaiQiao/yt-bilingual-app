# 044 — 观影模式（最小版）

> 状态：**已实现（2026-11-23，P2-08）** ｜ 依据：`docs/计划-v1.1.md` 任务 1（D1-1/D1-2 已拍板：只做看视频页；≥1280 右侧固定词条栏）
> 成本：0（只读已有分析缓存，不新增 AI 调用）。

## 1. 开关与布局

- `watchMode: off | on`，localStorage key `yt_bilingual_watch_mode`
- 入口：看视频页播放器工具栏（图标+文字，`aria-pressed`）
- 开启后：视频放大为主区；隐藏右栏摘要/工具栏冗余项；**教学面板不渲染**（不是折叠）
- 关闭：恢复现有 stacked/split 布局与教学面板
- 尊重 `prefers-reduced-motion`

## 2. 单句字幕窗

- 绝对定位在视频区下缘（玻璃配方 `bg-zinc-950/70 backdrop-blur-md border-t border-white/5`）
- 只显示当前句：中文在上、英文在下；不显示整条 transcript
- 随播放推进更新；无当前句时隐藏
- 不遮挡 YouTube 底部控件（抬高到画面约 12% 以上）
- `pointer-events` 分层：字幕窗不拦截播放器点击

## 3. 词条窗

- ≥1280：右侧固定栏（320–360），随当前句切换
- 内容 = 当前句的难度标亮词（wordGlossesByBlock）+ 语言点（idioms/culture）
- 空句/无词条：「本句无生词」，不留白
- 未生成分析：「本片还没有词条」+ 既有 028 生成入口
- 不新增 AI 调用；只读缓存

## 4. 验收

- 开关持久化；开/关布局与教学面板正确；reduced-motion 无动画
- 当前句字幕与词条随播放/跳转更新；切句不闪整条字幕
- 词条窗数据与页面 ruby/语言点一致；空态文案正确
- 全屏语义不变（最小版不改全屏）
- 现有播放/字幕/听读/验收脚本零回归；1440/375 截图

## 5. 实现落点（2026-11-23）

| 内容 | 位置 |
|---|---|
| `watchMode` off/on 持久化（key `yt_bilingual_watch_mode`；与 stacked/split、左列比例分键存储） | `frontend/src/lib/layout.ts` |
| 播放器工具栏入口（图标+文字、`aria-pressed`、悬停/触屏可见；切换携带播放进度，不重新起播） | `frontend/src/components/VideoPlayer.tsx` |
| 单句字幕窗（中上英下、玻璃条、`pointer-events-none`、无当前句隐藏、无动画） | `frontend/src/components/WatchSubtitleOverlay.tsx` |
| 词条窗（≥1280 固定右栏 `clamp(20rem,24vw,22.5rem)`；<1280 浮层；loading/error/空句/无分析四态） | `frontend/src/components/WatchGlossPanel.tsx` |
| 学习视图接线（观看 shell、教学面板/摘要/字幕工具栏不渲染、当前句取 `activeTranscriptIndex`） | `frontend/src/App.tsx` |
| 文案（zh-CN / vi-VN） | `frontend/src/i18n/zh-CN.json`、`vi-VN.json` |
| 验收脚本（开关持久化、布局/教学面板、播放/跳转跟句、词条/空态、reduced-motion、1440+375 截图） | `scripts/watch-mode-acceptance.mjs` |

词条数据只读既有教学分析（specs/028）：`wordGlossesByBlock` + `languagePointsByBlock`；
无分析态的重试按钮复用 `GET /api/teaching-analysis/{content_ref}`，本规格不新增任何 AI 调用。
