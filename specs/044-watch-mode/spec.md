# 044 — 观影模式（最小版）

> 状态：**已实现（2026-11-23，P2-08；P2-09 字号/历史；P2-10 接管网页全屏；P2-11 字幕字号流体缩放；P2-12 滚动词条精简；P2-13 payload 分析词条来源）** ｜ 依据：`docs/计划-v1.1.md` 任务 1（D1-1/D1-2 已拍板：只做看视频页；≥1280 右侧固定词条栏）
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
- 只显示当前句：**英文在上（主内容）**、中文在下（辅助）；不显示整条 transcript
- **字号随视频窗宽度流体缩放（P2-11，纯 CSS 容器查询）**：媒体区 `data-testid="video-area"` 设 `container-type: inline-size`（`[container-type:inline-size]`），字幕字号用容器查询单位 `cqi`（1cqi = 视频窗宽度的 1%）：
  - 英文：`clamp(1.0625rem, 2cqi, 2rem)` → 17px … 32px
  - 中文：`clamp(0.9375rem, 1.7cqi, 1.625rem)` → 15px … 26px
  - 任意窗宽英文都大于中文；375 落在下限 17/15；全屏/加宽视频窗时自动变大，不依赖 JS ResizeObserver
  - **回退**：`text-section`（17px）/ `text-body-zh`（15px）token 保留在元素上；不支持 `cqi` 的引擎会丢弃无效的 inline 声明，回退到 token 固定字号，不出现无字号
- 行高沿用 `leading-snug`，居中、`text-balance`；字号不写裸 px
- 随播放推进更新；无当前句时隐藏
- 不遮挡 YouTube 底部控件（抬高到画面约 12% 以上）
- `pointer-events` 分层：字幕窗不拦截播放器点击
- 375 与 1440 都在媒体区内换行，不横向裁切、不溢出画面

## 3. 滚动词条窗（P2-12 精简）

- 标题：`watchMode.glossTitle` =「滚动词条」（zh-CN）/「Từ cuộn」（vi-VN）；rail 与 floating 共用同一 key
- ≥1280：右侧固定栏（320–360）；<1280：浮层（容器边界/标题栏保留，不属于条目分割线）
- 内容 = 当前句的难度标亮词（wordGlossesByBlock）+ 语言点（idioms/culture），只显示词/文本与释义
- **数据来源（P2-13）**：`wordGlossesByBlock` 以页面实际渲染的 `displayTranscript[].highlights` 为准——历史 payload 自带 `analysis.v5` 合并块（block highlights）且 endpoint 不可用（404）时，payload 的块高亮直接生效；endpoint 可用时它已由 `applyTeachingAnalysisHighlights` 覆盖，分析留空的块保持空，不回填旧 payload。`languagePointsByBlock`（idioms/culture）仍只来自分析。免费文章阅读器例外：段落不在 `transcript` 里，仍按段落索引读分析高亮。
- **精简（P2-12）**：不显示整句英文上文与当前句圆点、不显示「生词 / 语言点」分组标题、不显示习语/文化 kind 徽章、不显示「本句无生词」或任何逐句/全局空态占位；条目无卡片边框/底纹，条目之间无分割线
- **连续列表**：词（amber）+ 释义（右对齐、次级色）；语言点文本（sky）+ 释义（下一行、次级色）；同一句先词后语言点，句与句之间只留间距、无分组
- **按句累积（P2-09）**：当前句词条固定在顶部；切到下一句时新句插到顶部，旧句条目向下顺延，直到滚出窗口/超过 30 句
- **去重**：同一 `blockId` 再次出现（回看/跳转）只把原条目移到顶部，不重复插入；条目按 `blockId` 唯一
- **滚动**：新句出现时 `scrollTop = 0`；用户手动向下滚动后不再强制拉回，滚回顶部后恢复自动跟随
- **空句**：不生成条目、不显示占位；旧条目原样保留，当前句标记随空句消失
- **状态**：loading/error/login/未分析仍按原逻辑整块呈现；分析 `ready` 但还没有任何条目时同样不渲染占位
- 长词/长释义用 `break-words` 换行，375/1440 不横向溢出
- 不同视频（`contentRef` 变化）重置历史，避免跨视频的 blockId 串档
- 不新增 AI 调用；只读缓存

## 4. 验收

- 开关持久化；开/关布局与教学面板正确；reduced-motion 无动画
- 当前句字幕与词条随播放/跳转更新；切句不闪整条字幕
- 字幕英文在主位、中文在辅位，375/1440 不裁切/不溢出
- 字号随媒体区宽度流体缩放（P2-11）：375 恰为 17/15 下限；1440 观影字号 > 1440 普通布局；1920 观影 > 1440 观影；全屏（stub）下视频窗加宽字号继续变大；任意档位英文 > 中文；长句不横向裁切/溢出
- 词条窗标题「滚动词条」（vi「Từ cuộn」，rail 与 floating 一致）
- 词条窗为连续列表：无整句英文上文/当前句圆点、无「生词/语言点」小标题、无习语/文化 kind 徽章、无「本句无生词」/逐句/全局空态占位；条目无卡片边框/底纹，条目之间无分割线
- 词条窗数据与页面 ruby/语言点一致；词 amber + 释义、语言点 sky + 释义下一行；375/1440 排版紧凑，长词/长释义换行不横向溢出
- 历史顺延：新句在顶部、旧词仍在、同一句去重移顶、新句自动回顶、手动滚动不被拉回、空句不生成条目且旧条目保留
- 网页全屏（P2-10）：进入观影调用全屏 API、退出观影调用 exit；ESC/浏览器退出全屏后布局仍是观影且状态同步；API 不存在或被拒时不报错、布局正常；路由切走退出清理
- 播放器控件只有观影/退出观影按钮，无旧全屏按钮（`video-fullscreen-toggle` 不存在）
- 现有播放/字幕/听读/验收脚本零回归；1440/1920/375 截图

## 5. 实现落点（2026-11-23）

| 内容 | 位置 |
|---|---|
| `watchMode` off/on 持久化（key `yt_bilingual_watch_mode`；与 stacked/split、左列比例分键存储） | `frontend/src/lib/layout.ts` |
| 播放器工具栏入口（图标+文字、`aria-pressed`、悬停/触屏可见；切换携带播放进度，不重新起播；**无独立全屏按钮**） | `frontend/src/components/VideoPlayer.tsx` |
| 网页全屏（进入手势内 `requestFullscreen()` 于学习 shell、退出条件 `exitFullscreen()`、ESC 保留布局、失败/不支持静默、路由/卸载清理、`data-page-fullscreen` 状态） | `frontend/src/App.tsx` |
| 单句字幕窗（英上中下、17/15px token 回退、`clamp(…2cqi…)`/`clamp(…1.7cqi…)` 随媒体区宽度流体缩放、玻璃条、`pointer-events-none`、无当前句隐藏、无动画；媒体区 `container-type: inline-size`） | `frontend/src/components/WatchSubtitleOverlay.tsx`、`frontend/src/App.tsx` |
| 滚动词条窗（P2-12：标题「滚动词条」/「Từ cuộn」；无整句上文/圆点、无分组标题、无 kind 徽章、无逐句及全局空态占位、无条目边框/底纹/分割线；词 amber + 释义、语言点 sky + 释义下一行；≥1280 固定右栏 `clamp(20rem,24vw,22.5rem)`；<1280 浮层；loading/error/login/无分析态；P2-09 最近 30 句历史/去重/滚动/空句跳过） | `frontend/src/components/WatchGlossPanel.tsx` |
| 学习视图接线（观看 shell、教学面板/摘要/字幕工具栏不渲染、当前句取 `activeTranscriptIndex`，向词条窗传 `blockId`/`enText`/`contentRef`） | `frontend/src/App.tsx` |
| 文案（zh-CN / vi-VN） | `frontend/src/i18n/zh-CN.json`、`vi-VN.json` |
| 验收脚本（开关持久化、布局/教学面板、播放/跳转跟句、滚动词条（标题/连续列表/无 context/heading/kind/empty/border、空句跳过、长词长释义 375 换行）、字幕英主中辅字号与流体缩放（375/1440 普通/观影/1920/全屏 stub）、历史顺延/去重/滚动、reduced-motion、网页全屏 stub 断言/失败降级、1440+1920+375 截图） | `scripts/watch-mode-acceptance.mjs` |

词条数据只读既有教学分析（specs/028）：`wordGlossesByBlock`（来源见 §3「数据来源（P2-13）」）+ `languagePointsByBlock`；
无分析态的重试按钮复用 `GET /api/teaching-analysis/{content_ref}`，本规格不新增任何 AI 调用。
