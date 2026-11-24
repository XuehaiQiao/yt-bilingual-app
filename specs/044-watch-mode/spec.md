# 044 — 观影模式（最小版）

> 状态：**已实现（2026-11-23，P2-08；P2-09 字号/历史；P2-10 接管网页全屏；P2-11 字幕字号流体缩放；P2-12 滚动词条精简；P2-13 payload 分析词条来源；2026-11-24 P2-15 沉浸壳层 + 字幕三态 + 保留原生控制条；P2-16 360 rail + 收藏 + 移动抽屉；P2-17 字幕落底/高亮/词条行统一/字号/Esc 退观影；P2-19 词条行「我已掌握」开关 + 收藏互斥；P2-20 暂停不落底 + 落底 0%；P2-21 词条行卡片 + 视口内指针才唤醒 + 抬高 10% + 字幕 92% 宽；P2-22 指针限定画面区；P2-25 视频/词条分栏比例可调，取代画面缩放）** ｜ 依据：`docs/计划-v1.1.md` 任务 1（D1-1/D1-2 已拍板：只做看视频页；≥1280 右侧固定词条栏）
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
- **浏览器 / ESC 退出全屏（P2-17 修订）**：观影模式请求了网页全屏，因此**真实退出本容器全屏（ESC / 浏览器 chrome / 另一个全屏请求）时自动退出观影模式**（`watchMode = off`，布局恢复、入口按钮回来、偏好持久化 off）；这是「本容器全屏 → 非全屏」的单向判断，初始同步、请求失败/从未进入全屏、路由切走（由 App 主动释放全屏）都**不**会触发退出
- **失败 / 不支持**（移动端 Safari、iframe 未授权、请求被拒）：静默降级为仅切换布局，不报错、不 `console.error`
- **路由切走 / 组件卸载**：若仍是本容器全屏，清理退出；路由切走是导航而非 ESC，保留观影偏好（下次回到视频页仍是观影态）
- **刷新 / 直达链接**：观影模式会持久化，但网页全屏**不会**自动恢复——浏览器要求用户手势，只有点击「观影模式」才进入全屏；此时布局仍是观影态


## 1c. 视频/词条分栏比例（P2-25；替代 P2-22 画面缩放）

- 用户澄清：要调的是**视频窗口与滚动词条窗口的分栏比例**，不是把视频在舞台里缩放。P2-25 移除 P2-22 的「画面大小 60/75/100」控件与 `watchVideoScale` 缩放逻辑，避免两个控件语义冲突。
- `watchSplitRatio`：视频列占整行的百分比，**55–85，默认 75**（75/25），localStorage key `yt_bilingual_watch_split_ratio`；与 `watchMode`、字幕三态分键存储，进入/退出观影模式都不重置。
- 桌面 ≥1280 才显示分隔条（现有的 rail 只在 xl 出现；768–1279 与 <768 都是视频置顶 + 抽屉，无分隔条、无比例控件）。
- 分隔条位于视频列与 rail 之间：`role="separator"` + `aria-orientation="vertical"` + `aria-valuemin=55` / `aria-valuemax=85` / `aria-valuenow`（四舍五入），`tabIndex=0`，1px 线 + 中间小 handle，hover/focus 可见，不覆盖视频/字幕。
- 交互：指针拖动改比例；键盘 ←/→ 每次 ±2%（Home/End 到 55/85）；双击恢复 75；拖动结束后写入 localStorage（键盘/双击立即写入），刷新保留。
- rail 宽度 = 行剩余宽度，CSS `clamp(280px, (100 - ratio)%, 560px)`；视频列取剩余宽度（`flex-1`），16:9 由舞台尺寸容器保持居中、不溢出。默认 1440 → rail 360px（25%），1920 → 480px；拖到极端时 rail 先触 280/560 边界，视频列吸收差额（比例数值仍是 aria-valuenow）。
- 拖动使用与普通布局同一个 `resize-shield`（覆盖 iframe），`pointerup/pointercancel/blur` 收尾；拖动中不写 localStorage。
- `video-area` 仍是 `container-type: inline-size`，字幕字号随视频列宽度流体缩放（clamp 下限 17/15px），更小的视频列不裁切。


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
- **避让原生控制条（P2-17；P2-21/P2-22 修订）**：App 在观影模式跟踪指针活跃（`pointermove` / `pointerdown` / `touchstart` / `keydown`）。**P2-22：只有 `event.target` 位于 `video-area` 容器内才算画面活跃**（`pointermove`/`pointerdown`/`pointerover`；`pointerover` 覆盖跨域 YouTube iframe 边界进入画面，iframe 内部移动对父页不可见）——滚动词条栏、浮层顶栏、舞台黑边、页面其它区域的指针/触摸不唤醒字幕；键盘始终唤醒。**P2-21 保留**：`pointermove`/`pointerdown` 还须 `clientX/Y` 在视口内（`0..innerWidth / 0..innerHeight`）作第二道保护。活跃时字幕抬高到**播放器盒的 10%**（实测约 12% 画面高度，位于原生控制栏上方约 10–14px），避开 YouTube 原生控制条；**静止 4s** 后落到视频底缘（**0%**，与原生控制条约 4s 消失对齐）。`bottom` 过渡 200ms；`prefers-reduced-motion` 下直切（过渡时长为 0）
- **句内高亮（P2-17）**：英文句内把当前句词条标亮——词汇橙底（`bg-amber-400/20 text-amber-100`），习语/文化点蓝底（`bg-sky-400/20 text-sky-100`）；按文本匹配包 `<span>`，**不用 `dangerouslySetInnerHTML`**；范围不重叠（语言点优先），保留完整原句文本（含标点/空格）；切句更新；字幕关闭时不渲染。中文行暂不高亮
- `pointer-events` 分层：字幕窗不拦截播放器点击
- 375 与 1440 都在媒体区内换行，不横向裁切、不溢出画面
- 样式（P2-15 / P2-21）：下缘**渐变 scrim**（透明→暗，非通栏实色带），左右安全边；抬高态 `bottom: 10%` 落在原生控制栏上方约 10–14px，落底态 `0%` 与已隐藏的控制条共存
- **字幕宽度（P2-21）**：单句容器 `max-w-[min(96ch,92%)]`（`ch` 随英文流体字号缩放），1440/1920 实测字幕盒占视频宽 **≥85%**（1440 实测 85.2%，1920 87.3%），长句仍换行不裁切；375 正常换行

### 2b. 字幕三态（P2-15，specs/045 §4.2.1）

- 偏好：`watchSubtitleMode: bilingual | english | off`，localStorage key `yt_bilingual_watch_subtitle_mode`，默认 `bilingual`；与 `watchMode` 分键存储，开关观影模式不重置字幕偏好
- **双语**：英文主 + 中文辅（默认）；**仅英文**：只渲染英文行；**关闭**：整个覆盖层不渲染（不挂载），使用视频原生字幕
- 切换入口：浮层顶栏 CC 按钮 → 三项菜单（双语 / 仅英文 / 关闭，带「关闭后使用视频原生字幕」说明）；键盘 `C` 循环「双语 → 仅英文 → 关闭 → 双语」
- 切换 **不重载 iframe、不丢播放位置**，不触发任何分析请求；关闭后词条栏/抽屉仍可用（P2-16 已重做）
- **不读取、不控制** iframe 的原生 CC 状态；原生字幕共存靠用户选择「关闭」，不自动检测、不自动叠加

## 3. 滚动词条栏 / 抽屉（P2-12 精简；P2-16 目标稿）

- 标题：`watchMode.glossTitle` =「滚动词条」（zh-CN）/「Từ cuộn」（vi-VN）；标题右侧「本句 N」= 当前句 highlight 词数；rail 与抽屉共用同一 key
- ≥1280：右侧 rail，宽度由 P2-25 分栏比例驱动（默认 1440=360px、1920=480px，clamp 280–560px）；<1280：视频置顶 + 底部抽屉（默认展开、占剩余高度、点击手柄收起/展开；P2-16 取代旧 floating）
- 内容 = 当前句的难度标亮词（wordGlossesByBlock）+ 语言点（idioms/culture），只显示词/文本与释义
- **数据来源（P2-13）**：`wordGlossesByBlock` 以页面实际渲染的 `displayTranscript[].highlights` 为准——历史 payload 自带 `analysis.v5` 合并块（block highlights）且 endpoint 不可用（404）时，payload 的块高亮直接生效；endpoint 可用时它已由 `applyTeachingAnalysisHighlights` 覆盖，分析留空的块保持空，不回填旧 payload。`languagePointsByBlock`（idioms/culture）仍只来自分析。免费文章阅读器例外：段落不在 `transcript` 里，仍按段落索引读分析高亮。
- **精简（P2-12；P2-21 修订）**：不显示整句英文上文与当前句圆点、不显示「生词 / 语言点」分组标题、不显示习语/文化 kind 徽章、不显示「本句无生词」或任何逐句/全局空态占位；**P2-21 每个词条行加低对比圆角卡片背景**（`bg-surface-2/35`，当前句 `bg-surface-2/50` 略强；行间 4px），行卡片是背景不是分割线——行/条目仍无边框、无阴影、条目之间无分割线，条目本身无底纹
- **连续列表（P2-16）**：当前句置顶；同一句先词后语言点，句与句之间只留间距、无分组；当前句词行左侧 2px 竖线（词 amber / 语言点 sky），历史无标记
- **行统一（P2-17）**：词汇和语言点都一行「左词/短语，右释义」——右列 `text-right`、可换行（`break-words`）；语言点解释不再另起一行。标题「滚动词条」字号略增（`text-dialog`）
- **字号流体（P2-17）**：词/短语 `clamp(1rem, 0.8vw + 0.5rem, 1.375rem)`（16→22px），释义 `clamp(0.875rem, 0.55vw + 0.5rem, 1.125rem)`（14→18px）；375 / 1440 / 1920 明显递增，取代旧 11–14px 固定字号；`text-ui` / `text-caption` 保留为回退类
- **历史渐隐（P2-16）**：当前句 opacity 1；历史从 .55 起按年龄递减（约 −.035/句，下限 .32），越旧越淡
- **收藏（P2-16；P2-21 修订）**：☆ **桌面默认 opacity .6**（≥.6），hover/focus 升到 1；抽屉常显、44px 触摸目标，已收藏实心；一键写 App 既有 vocabulary favorites（`vocab-<videoId>-<word>`、start=blockStart、context_en=当前句、source_kind=video/source_ref=videoId/source_title=标题）；App 顶栏「单词本」计数同步；失败/游客行内回滚说明；不提供未实现的 ✓/设置
- **已掌握（P2-19）**：收藏星旁同一 `ml-auto` 操作组增加 ✓ 圆形开关（lucide `Check`；rail 默认 opacity .6、hover/focus 1，抽屉常显 44px；已掌握绿色实心、未空心）；`data-testid="watch-gloss-mastered"` + `data-mastered` + `aria-pressed` + `aria-label`（含词）。状态只读 `useIgnoredWords`（`word_states.mastered` / 游客本地表），当前句与历史行同源。登录写 `PATCH /api/review/words {lemma, mastered, targetLang, definition=释义}`，成功后 `refreshIgnored(targetLang)` 并以响应为准；游客只写 `yt_bilingual_guest_mastered_words`（`writeGuestMastered` + `refreshIgnored()`，不调 API）；busy 防重复，失败行内回滚说明。**互斥（specs/005）**：标记成功后若同词有收藏则 `onRemoveFavorite(id)`；删除失败 → 回滚 mastered=false（API/游客写回）并显示行内错误；取消已掌握不恢复收藏（ADR-0001）
- **按句累积（P2-09）**：当前句词条固定在顶部；切到下一句时新句插到顶部，旧句条目向下顺延，直到滚出窗口/超过 30 句
- **去重**：同一 `blockId` 再次出现（回看/跳转）只把原条目移到顶部，不重复插入；条目按 `blockId` 唯一
- **滚动**：新句出现时 `scrollTop = 0`；用户手动向下滚动后不再强制拉回，滚回顶部后恢复自动跟随
- **空句**：不生成条目、不显示占位；旧条目原样保留，当前句标记随空句消失
- **状态**：loading/error/login/未分析仍按原逻辑呈现；无分析改为**紧凑**说明 + 既有「生成词条」入口，不铺满 rail；分析 `ready` 但还没有任何条目时同样不渲染占位
- 长词/长释义用 `break-words` 换行，375/1440 不横向溢出
- 不同视频（`contentRef` 变化）重置历史，避免跨视频的 blockId 串档
- 不新增 AI 调用；只读缓存

## 4. 验收

- 开关持久化；开/关布局与教学面板正确；reduced-motion 无动画
- 当前句字幕与词条随播放/跳转更新；切句不闪整条字幕
- 字幕英文在主位、中文在辅位，375/1440 不裁切/不溢出
- 字号随媒体区宽度流体缩放（P2-11）：375 恰为 17/15 下限；1440 观影字号 > 1440 普通布局；1920 观影 > 1440 观影；全屏（stub）下视频窗加宽字号继续变大；任意档位英文 > 中文；长句不横向裁切/溢出
- 词条窗标题「滚动词条」+「本句 N」（vi「Từ cuộn」，rail 与抽屉一致）
- 词条窗为连续列表：无整句英文上文/当前句圆点、无「生词/语言点」小标题、无习语/文化 kind 徽章、无「本句无生词」/逐句/全局空态占位；**P2-21：词条行为低对比圆角行卡片（无边框/阴影，当前句略强，行间 4px），条目本身无底纹、条目之间无分割线**
- 词条窗数据与页面 ruby/语言点一致；词 amber + 释义、语言点 sky + 释义；375/1440 排版紧凑，长词/长释义换行不横向溢出
- 历史顺延：新句在顶部、旧词仍在、同一句去重移顶、新句自动回顶、手动滚动不被拉回、空句不生成条目且旧条目保留
- P2-16 桌面：默认 75/25 时 1440 rail = 360px、1920 = 480px（280–560 clamp）；标题+本句数；当前句置顶且在顶部三行内；历史 opacity 递减；无 headings/badges/context/empty；收藏星标 **默认 .6、hover/focus 1**、已收藏实心；rail 可见操作只有收藏；无分析空态紧凑、有生成入口
- P2-16 收藏：一键加/取消；POST 体为 vocabulary draft（id/videoId/start/en_text/zh_text/context_en/source_kind=video/source_ref/source_title）；App 顶栏计数加 1/减 1；失败星标回滚且行内说明；游客不写接口
- P2-19 已掌握：每行词/语言点都有 ✓ 与 ☆ 并列在 `ml-auto` 操作组（rail 默认 .6、hover/focus 1；抽屉常显）；登录 PATCH 体含 lemma/mastered/targetLang/definition，成功后 `GET /api/review/words?mastered=1` 回读，pressed/绿色实心与历史行同步；刷新后仍为已掌握；取消 PATCH mastered=false 且不恢复收藏；游客只写 `yt_bilingual_guest_mastered_words`（刷新后仍在），全程不调 review API；PATCH 500 → 行内错误 + 视觉回滚；互斥 DELETE 失败 → PATCH false 回滚 + 行内说明；375 两个操作均 ≥44px、标记后词 16/释义 14px 仍同行不溢出
- P2-16 移动（375）：视频 16:9 置顶（8px 边距，不再整页垂直居中）；抽屉默认展开、占剩余高度、可点击手柄收起/展开、不覆盖视频/原生控制条、375 无横向溢出；CC 三态与退出仍可用；旧右上浮窗不存在
- 词条行（P2-17）：词汇与语言点均一行「词/短语左，释义右」，右列 `text-right` 可换行；语言点解释不再下一行；375 词 16px / 释义 14px，1440 约 19.5/16px，1920 22/18px，三档明显递增
- 字幕避让（P2-17 / P2-21 / P2-22）：画面内指针（或触摸/键盘）活跃时字幕抬高（bottom 10%，实测画面下缘 gap 约 12%）；滚动词条栏/浮层顶栏/舞台黑边/屏幕外 pointermove、pointerdown、touchstart 都不唤醒；画面内 pointer 移动恢复抬高；键盘始终唤醒；静止 4s 后落到底缘（bottom 0%，暂停不落底）；过渡 200ms，reduced-motion 直切
- 分栏比例（P2-25）：1440 默认视频 75% / rail 25%（rail 360px）；拖到 60 → 视频约 60.6%（rail 撞 560 上限），拖到 85 → 视频约 80%（rail 撞 280 下限），两种情况下视频/rail 宽度都按 clamp 规则变化、16:9 居中不溢出；键盘 ←/→ 每次 2%、aria-valuenow 同步、双击恢复 75；刷新保留；1920 下 rail 始终在 280–560；375 无分隔条、视频整宽置顶 + 抽屉；字幕随视频列缩小不裁切
- 字幕宽度（P2-21）：1440/1920 字幕盒 ≥85% 视频宽（实测 85.2% / 87.3%），长句不裁切；375 换行正常
- 字幕高亮（P2-17）：英文句内标亮词橙底、语言点/文化点蓝底；点优先、范围不重叠；文本完整；切句更新；关闭字幕不渲染；中文行不高亮
- 网页全屏（P2-10 / P2-17 修订）：进入观影调用全屏 API、退出观影调用 exit；**ESC/浏览器真实退出本容器全屏 → 自动退出观影**（布局恢复、偏好转 off）；初始/未全屏、路由切走不误触发；API 不存在或被拒时不报错、布局正常
- 播放器控件只有观影/退出观影按钮，无旧全屏按钮（`video-fullscreen-toggle` 不存在）
- 沉浸壳层：观影模式不渲染 AppShell 顶栏与 LearningHeader；浮层顶栏含返回/标题+来源/观影模式 chip/CC/退出，2.5s 静止淡出、鼠标/触摸/键盘出现；无假设置按钮
- 舞台：≥1280 的 16:9 画面在剩余区域居中、环境光填充黑边；<1280 视频 16:9 置顶、抽屉占剩余高度；1440/1920/375 不溢出；全屏仍只全屏观影容器
- 原生控制条：YouTube 控制条与 CC 入口保留，无自定义传输条；字幕 scrim 不压住控制条
- 字幕三态：双语/仅英文/关闭可切换并持久化（默认双语）；关闭后覆盖层不渲染、词条仍可用；`C` 循环；CC 菜单可点击/键盘操作；切换不重载播放器、不丢播放位置；不读取 iframe CC 状态
- 现有播放/字幕/听读/验收脚本零回归；1440/1920/375 截图

## 5. 实现落点（2026-11-23；P2-16 2026-11-24；P2-17 2026-11-24）

| 内容 | 位置 |
|---|---|
| `watchMode` off/on 持久化（key `yt_bilingual_watch_mode`；与 stacked/split、左列比例分键存储） | `frontend/src/lib/layout.ts` |
| 播放器工具栏入口（图标+文字、`aria-pressed`、悬停/触屏可见；切换携带播放进度，不重新起播；**无独立全屏按钮**） | `frontend/src/components/VideoPlayer.tsx` |
| 网页全屏（进入手势内 `requestFullscreen()` 于学习 shell、退出条件 `exitFullscreen()`、失败/不支持静默、路由/卸载清理、`data-page-fullscreen` 状态；**P2-17：本容器全屏 → 非全屏（ESC/浏览器 chrome）自动 `setWatchMode('off')`，初始/未全屏/路由清理不误触发**） | `frontend/src/App.tsx` |
| 单句字幕窗（英上中下、17/15px token 回退、`clamp(…2cqi…)`/`clamp(…1.7cqi…)` 随媒体区宽度流体缩放、玻璃条、`pointer-events-none`、无当前句隐藏；媒体区 `container-type: inline-size`；**P2-17：`dock`/`raised` 两档 bottom（0% / 10%，P2-21 由 15% 下调）、200ms 过渡、reduced-motion 直切、`glosses`+`languagePoints` 句内橙/蓝高亮（文本切片，无 HTML 注入）；P2-21：`min(96ch,92%)` 宽、`ch` 随英文流体字号缩放**） | `frontend/src/components/WatchSubtitleOverlay.tsx`、`frontend/src/App.tsx` |
| 滚动词条窗（P2-12：标题「滚动词条」/「Từ cuộn」；无整句上文/圆点、无分组标题、无 kind 徽章、无逐句及全局空态占位、无条目边框/底纹/分割线；≥1280 固定右栏；<1280 浮层；loading/error/login/无分析态；P2-09 最近 30 句历史/去重/滚动/空句跳过；**P2-17：词汇与语言点统一「左词/短语 + 右释义」单行、右列 `text-right` 可换行、字体 `clamp` 16→22 / 14→18；P2-21：行低对比圆角卡片 `bg-surface-2/35`（当前 `/50`）、行间 4px、无边框/分割线**） | `frontend/src/components/WatchGlossPanel.tsx` |
| 学习视图接线（观看 shell、教学面板/摘要/字幕工具栏不渲染、当前句取 `activeTranscriptIndex`，向词条窗传 `blockId`/`enText`/`videoId`/`blockStart`/`sourceTitle`/favorites 回调） | `frontend/src/App.tsx` |
| P2-16 词条栏/抽屉/收藏（rail 宽度 P2-25 改为比例驱动（1440 默认 360px，280–560 clamp）、本句数、当前句置顶+2px 标记、历史渐隐、☆ 默认 .6/hover 1、失败/游客行内回滚、紧凑空态；<1280 视频置顶 + 底部抽屉默认展开/可收起/手柄/安全区） | `frontend/src/components/WatchGlossPanel.tsx`、`frontend/src/App.tsx`、`frontend/src/components/WatchTopBar.tsx` |
| P2-16 App 收藏接线（`favorites`/`onAddFavorite`/`onRemoveFavorite`；删除路径 `report:false` 静默回滚；顶栏计数同源） | `frontend/src/App.tsx` |
| P2-19 已掌握（`MasteredButton` 圆形 Check，rail 默认 .6 / hover 1、抽屉 44px；`useIgnoredWords` 单一来源；登录 PATCH + `refreshIgnored(targetLang)`、游客 `writeGuestMastered` + `refreshIgnored()`；busy；失败行内回滚；成功后 DELETE 同词收藏、失败回滚 mastered=false；`targetLang` 由 App 两处传入） | `frontend/src/components/WatchGlossPanel.tsx`、`frontend/src/App.tsx` |
| P2-19 文案（已掌握/取消/失败/互斥回滚，中越） | `frontend/src/i18n/zh-CN.json`、`vi-VN.json` |
| P2-17 App 接线（观影模式跟踪指针活跃 → `watchSubtitleRaised`，4s 静止落底；P2-21 越界坐标忽略；**P2-22 目标须在 `video-area` 内（`event.target` containment），键盘不受限、`touchstart` 同目标过滤**；`pageFullscreenRef` 区分「真实退出本容器全屏」与初始/路由/失败；向字幕窗传 `glosses`/`languagePoints`/`raised`/`dock`） | `frontend/src/App.tsx` |
| P2-15 沉浸壳层（AppShell `hideTopbar` 不渲染顶栏；LearningHeader 不渲染；浮层顶栏 `WatchTopBar`：返回/标题+来源/chip/CC/退出，2.5s 淡出，指针/触摸/键盘唤醒） | `frontend/src/components/AppShell.tsx`、`frontend/src/components/WatchTopBar.tsx`、`frontend/src/App.tsx` |
| P2-15 舞台（`watch-stage` 尺寸容器 + 16:9 画面水平/垂直居中 + 环境光/模糊层填充黑边） | `frontend/src/App.tsx` |
| P2-15 字幕三态（`watchSubtitleMode` 持久化与循环；双语/仅英文/关闭；关闭不挂载覆盖层；渐变 scrim） | `frontend/src/lib/layout.ts`、`frontend/src/components/WatchSubtitleOverlay.tsx`、`frontend/src/components/WatchTopBar.tsx`、`frontend/src/App.tsx` |
| P2-15 原生控制条保留（不做自定义播放/进度条；退出按钮从播放器浮层移到顶栏） | `frontend/src/components/VideoPlayer.tsx` |
| 文案（zh-CN / vi-VN） | `frontend/src/i18n/zh-CN.json`、`vi-VN.json` |
| 验收脚本（开关持久化、布局/教学面板、播放/跳转跟句、滚动词条（标题/连续列表/无 context/heading/kind/empty/border、空句跳过、长词长释义 375 换行）、字幕英主中辅字号与流体缩放（375/1440 普通/观影/1920/全屏 stub）、历史顺延/去重/滚动、reduced-motion、网页全屏 stub 断言/失败降级、1440+1920+375 截图；P2-15 追加：双 chrome 不渲染/浮层顶栏五项与 2.5s 淡出/舞台居中与环境光/字幕三态与持久化与 C 键/CC 菜单键盘/原生控制条保留/切换不重载；P2-17 追加：抬高/落底两档与 200ms 过渡 + 指针恢复、词条行同线/右对齐/字号三档、橙/蓝高亮与完整文本、ESC→watch off、初始/路由/拒绝全屏不误触发；P2-19 追加：收藏星级操作组/aria/绿色实心、PATCH+回读+刷新持久、取消不恢复收藏、互斥 DELETE 失败回滚、PATCH 500 回滚、游客本地表写入/刷新/撤销零 API、375 44px 与不挤爆截图；P2-20 追加：落底 0%、暂停 4.5s 仍 raised；P2-21 追加：视口外 pointer 不唤醒/视口内 pointermove+pointerdown 唤醒、抬高 10%（7–14% 实测 band）、1440/1920 字幕盒 ≥85%、词条行卡片/4px/当前句更强/操作组默认 .6、375 不挤压 + 截图；P2-25 追加：默认 75/25 rail 360、拖到 60/85 的 clamp 行为、键盘 ±2%/aria/双击重置、刷新保留、1920 rail 280–560、375 无分隔条 + 截图） | `scripts/watch-mode-acceptance.mjs` |

词条数据只读既有教学分析（specs/028）：`wordGlossesByBlock`（来源见 §3「数据来源（P2-13）」）+ `languagePointsByBlock`；
无分析态的重试按钮复用 `GET /api/teaching-analysis/{content_ref}`，本规格不新增任何 AI 调用。

## 6. 落地记录（P2-21，2026-11-24）

| 内容 | 位置 |
|---|---|
| 词条行低对比圆角卡片：`bg-surface-2/35`、当前句 `bg-surface-2/50`、行/条目仍无边框无阴影；行间 4px（词列表、语言点列表及两者之间）；标题/释义两列不被操作组挤压 | `frontend/src/components/WatchGlossPanel.tsx` |
| 桌面操作组默认 `opacity: .6`、hover/focus 1（收藏星 + 已掌握同组）；抽屉常显 44px 不变 | `frontend/src/components/WatchGlossPanel.tsx` |
| 字幕唤醒只认视口内 pointer：`clientX/Y` 在 `0..innerWidth / 0..innerHeight`，越界忽略；touchstart/keydown 保持；暂停仍不落底 | `frontend/src/App.tsx` |
| 抬高态 `bottom: 10%`（实测画面下缘 gap 12.1%，控制栏上方约 10–14px）；落底 `0%`；200ms 过渡与 reduced-motion 直切不变 | `frontend/src/components/WatchSubtitleOverlay.tsx` |
| 字幕宽度 `min(96ch,92%)`，`ch` 跟随英文流体字号；scrim 边距 `sm:px-6`；1440 实测 85.2%、1920 87.3%，375 正常换行不裁切 | `frontend/src/components/WatchSubtitleOverlay.tsx` |
| 验收：视口外 `pointermove`/`pointerdown` 保持落底、视口内 `pointermove` 与 `pointerdown` 均抬高；词条卡 alpha 当前 .5 / 历史 .35、行间 4px、操作组默认 .6；抬高 7–14% band、落底 0；1440/1920 宽度 ≥85%；375/1440/1920 截图；2× PASS | `scripts/watch-mode-acceptance.mjs` |

## 7. 落地记录（P2-22 指针区域 + P2-25 分栏比例，2026-11-24）

| 内容 | 位置 |
|---|---|
| 指针/触摸活动限定画面区（P2-22 保留）：window `pointermove`/`pointerdown`/`pointerover` 须 `event.target` 在 `videoAreaRef` 容器内，且保留 P2-21 视口坐标过滤（`pointerover` 让跨域 iframe 的进入边界事件也算画面活跃）；`touchstart` 同目标过滤；`keydown` 始终唤醒 | `frontend/src/App.tsx` |
| 分栏比例偏好：`watchSplitRatio` 55–85（默认 75）、`WATCH_SPLIT_RATIO_KEY = yt_bilingual_watch_split_ratio`、`WATCH_SPLIT_KEY_STEP = 2`、rail clamp 280–560、`watchRailWidthCss()`；与观影开关/字幕三态分键；P2-22 的 `yt_bilingual_watch_video_scale` 由 `clearLegacyWatchVideoScale()` 一次性清理 | `frontend/src/lib/layout.ts` |
| 分隔条（仅 ≥1280 观影模式）：`role=separator` / `aria-orientation=vertical` / `aria-valuemin=55` / `aria-valuemax=85` / `aria-valuenow` / `tabIndex=0`；1px 线 + 中间 handle（hover/focus 可见）；指针拖动经 `resize-shield`，←/→ ±2%、Home/End 到边界、双击恢复 75；拖动结束写 localStorage | `frontend/src/App.tsx` |
| rail 宽度由比例驱动：`WatchGlossPanel` 接收 `railWidth`（`clamp(280px, (100-ratio)%, 560px)`），去除 `w-[360px]` 硬编码；视频列 `flex-1` 取剩余宽度，16:9 居中不溢出 | `frontend/src/components/WatchGlossPanel.tsx`、`frontend/src/App.tsx` |
| 移除 P2-22 画面缩放：顶栏不再有「画面大小」控件，`watchVideoScale`/`data-watch-scale`/mediaStage 缩放宽度全部删除；浮层顶栏只保留返回/标题+来源/chip/CC/退出 | `frontend/src/components/WatchTopBar.tsx`、`frontend/src/App.tsx` |
| 文案（分栏分隔条 aria/title，中越） | `frontend/src/i18n/zh-CN.json`、`vi-VN.json` |
| 验收：1440 默认 75/25 → rail 360；拖到 60/85 的 clamp 后宽度、16:9、不溢出；键盘 ←/→ 每步 2%、aria-valuenow、双击重置；刷新保留；1920 rail ∈ [280,560]；375 无分隔条且视频整宽；`1440-watch-split`/`1920-watch-split` 截图；2× PASS | `scripts/watch-mode-acceptance.mjs` |
