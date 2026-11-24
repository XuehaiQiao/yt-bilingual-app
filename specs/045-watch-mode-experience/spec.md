# 045 — 观影模式体验设计

> 状态：**已实现（P2-15 沉浸壳层 + 舞台居中/环境光 + 字幕三态；P2-16 词条栏重做 + 收藏 + 移动底部抽屉，2026-11-24；P2-17 字幕避让原生控制条/句内高亮/词条行与字号统一/Esc 退观影，2026-11-24；P2-19 词条行「我已掌握」开关 + 收藏互斥，2026-11-24；P2-21 词条行卡片 + 视口内指针 + 抬高 10% + 字幕 92% 宽，2026-11-24；P2-22 指针限定画面区；P2-25 视频/词条分栏比例可调（替代画面大小缩放），2026-11-24；保留 YouTube 原生控制条）** ｜ 依据：用户“观影模式效果不好，要更细节、体验更好的版本”
> 目标稿：`docs/design/watch-mode/mock-{desktop,mobile,empty,subtitle}.png`。实现落点见 §12。

## 1. 问题诊断（当前实现）

| 现象 | 数据/证据 | 影响 |
|---|---|---|
| 视频下方大片死黑 | 1440×900：视频约 1059×595，下方约 200px 空白 | 像“嵌入了一块的网页”，不是影院 |
| 两层 chrome | 顶栏 + LearningHeader 共约 96px | 观影模式没有真正进入沉浸 |
| 字幕通栏黑带 | 全宽不透明带，压在画面下缘 | 割裂画面，且与控件抢安全区 |
| 词条栏空 | 345px 栏内只有 1 行词 | 大面积空白比没有更干扰 |
| 退出按钮浮层 | “退出观影”压在画面右下/字幕附近 | 打断观看，层级错误 |
| 移动端失衡 | 375：视频 343×193，字幕占近一半，下方 500px 空 | 手机端基本不可用 |
| 无状态设计 | 无分析=空白；无词=空白 | 用户不知道是坏了还是没数据 |

## 2. 体验目标

**一句话**：像在看电影，学习工具安静地待在旁边；想学时一伸手就够得到，不想学时它不抢画面。

四个可验证目标：

1. **沉浸**：除画面/字幕/必要控制外，没有常驻 chrome。
2. **可读**：连续看 30 分钟不累；字幕不遮控件、不裁切；可关闭以使用原生字幕。
3. **可学**：当前句的词/语言点随手可见；收藏/已掌握一键完成。
4. **不打断**：任何分析加载/失败都不阻塞播放；空态不制造焦虑。

## 3. 设计原则

1. **画面第一，控件第二**：chrome 在指针静止 2.5s 后淡出；移动/按键再出现。
2. **渐进披露**：默认只有字幕 + 当前句词条；历史/操作/设置按需展开。
3. **一个模式，一个主动作**：观影按钮是唯一入口；不再有独立全屏按钮。
4. **黑边是构图**：用环境光/模糊背景填充，而不是留死黑。
5. **不假装**：无分析/无词条时给明确、克制的状态，不画假内容。
6. **连续性**：播放位置、观影偏好、词条滚动位置在会话内不丢；跨视频重置词条历史。
7. **可调**：字幕字号/位置/单双语、视频与词条栏的分栏比例（P2-25：55–85%，默认 75/25）、词条栏开合，是学习工具的基本控制。

## 4. 桌面（≥1280）

### 4.1 壳层

```
┌───────────────────────────────────────────────┬──────────────┐
│ [返回] 标题 · 观影模式                    [CC] [退出] │  滚动词条     │
│                                               │              │
│           16:9 画面（居中，环境光）           │  当前句目标   │
│                                               │  ─────────   │
│   ┌──── 当前句字幕（英文主/中文辅）────┐      │  历史（淡）   │
│                                               │              │
│        （YouTube 原生控制条，保留）  1.0x CC  │              │
└───────────────────────────────────────────────┴──────────────┘
```

> **本期决策（P2-15）**：图中底部传输条**不在本期**——YouTube 原生播放控制条与原生 CC 入口**保留**（自定义传输条、外层快捷键 Space/←→/J/L/F/W 留待后续；本期只加 `C`）。顶部浮层**不设「设置」按钮**（不新增假设置入口）。

- **移除**普通顶栏与 LearningHeader 常驻；只保留浮层顶部条（返回、标题+来源、观影模式 chip、CC、退出），2.5s 后淡出；鼠标/触摸/键盘活动出现。P2-25 移除了 P2-22 的「画面大小」按钮：画面大小与分栏比例是同一语义，不能有两个互相冲突的控件。
- **分栏比例（P2-25）**：≥1280 时视频列与词条 rail 之间是可拖拽分隔条（`role=separator`、`aria-orientation=vertical`、`aria-valuemin=55/aria-valuemax=85/aria-valuenow`、`tabIndex=0`；1px 线 + 中间 handle，hover/focus 可见）。视频列占 55–85%（默认 75），rail 取剩余宽度并 clamp 到 280–560px；指针拖动调整，键盘 ←/→ 每次 ±2%，双击恢复 75；偏好 `yt_bilingual_watch_split_ratio` 刷新后保留。<768 与 768–1279 都不渲染分隔条（视频置顶 + 抽屉）。
- 舞台占满剩余视口；视频 `object-fit: contain`，16:9 居中；上下黑边用低饱和环境光/模糊画面填充。
- 右侧词条栏宽度由分栏比例驱动（P2-25；默认 1440 = 360px、1920 = 480px，clamp 280–560px），与画面之间是可拖拽分隔条（1px 线 + 中间 handle），不抢画面。
- 控制条浮在画面下缘，自动隐藏；不占布局高度。
- 退出不再用画面中央的按钮；退出在顶部浮层。`Esc`：退出网页全屏后**自动退出观影**（P2-17；只响应「本容器全屏 → 非全屏」的真实退出，初始/未全屏/路由清理不触发）。

### 4.2 字幕

- 英文主内容：`clamp(1.0625rem, 2cqi, 2rem)`（17→32px），600；中文辅助：`clamp(0.9375rem, 1.7cqi, 1.625rem)`（15→26px），400（P2-11 终稿，随媒体区宽度流体缩放）。
- 长句换行不裁切，行宽 `min(96ch, 92%)`（P2-21 由 `min(68ch, 86%)` 放宽；`ch` 跟随英文流体字号，92% 在 1440/1920 实际生效，字幕盒占视频宽 ≥85%）；`text-wrap: balance`。
- 背景：下缘渐变 scrim（透明→`rgba(0,0,0,.72)`），**不是**通栏实色带；左右保留安全边（P2-21：`sm:px-6` + 92% 上限，1440 实测字幕盒距画面边缘约 80px）。
- **避让原生控制条（P2-17；P2-21/P2-22 修订）**：**画面内**指针/触摸、任意位置的键盘活跃时字幕抬高到播放器盒的 **10%**（实测画面下缘 gap 约 12%，原生控制栏上方约 10–14px）。P2-22：pointer/touch 的 `event.target` 必须在 `video-area` 内——滚动词条栏、浮层顶栏、舞台黑边、页面其它区域不唤醒；`pointerover` 让进入跨域 iframe 的边界事件也唤醒（iframe 内部移动对父页不可见）；屏幕外 `pointermove`/`pointerdown` 仍按 P2-21 坐标过滤忽略；播放中静止 **4s** 后落到视频底缘 **0%**（与原生控制条约 4s 消失对齐），暂停时不落底（P2-20）；`bottom` 过渡 **200ms**，`prefers-reduced-motion` 直切。App 跟踪活跃状态，字幕窗只接收 `raised`/`dock`。
- **句内高亮（P2-17）**：英文句内词汇橙底（`bg-amber-400/20 text-amber-100`）、习语/文化点蓝底（`bg-sky-400/20 text-sky-100`）；范围不重叠（点优先），保留完整文本，不使用 `dangerouslySetInnerHTML`；切句更新；字幕关闭时不渲染。中文行暂不高亮。
- 字幕不可点击（避免误触 iframe）；未来可做“点词查词”再单独评估。

### 4.2.1 字幕模式：必须允许关闭（原生字幕共存）

很多视频自带原生字幕，原生字幕的断句/位置/样式往往更好；我们的双语字幕是**增强**，不是替代。字幕控制提供三态（持久化，默认双语）：

| 模式 | 我们的覆盖层 | 使用场景 |
|---|---|---|
| **双语** | 英文 + 中文 | 需要中文辅助 |
| **仅英文** | 英文（隐藏中文） | 只想看英语，但仍用我们的逐句同步 |
| **关闭** | 不渲染 | 只看视频原生字幕；词条栏仍可用（分析数据不依赖覆盖层） |

- 控制位置（P2-15 落地）：浮层顶栏 `CC` 按钮 → 弹出三段选择（双语 / 仅英文 / 关闭）；移动端同一个 `CC` 按钮。YouTube 原生 CC 入口保持在原生控制条里，不被遮挡。
- 键盘：`C` 循环「双语 → 仅英文 → 关闭 → 双语」。
- **不尝试读取/控制 YouTube iframe 的原生 CC 状态**（iframe 不暴露）；当原生字幕开启时，用户选择「关闭」即可，两个字幕不会由我们自动叠加。
- 切换不重载播放器、不影响播放位置/分析请求；词条栏独立于字幕模式。
- 若原生字幕可用，文案提示「若已开视频原生字幕，建议选择关闭」；不假装检测原生字幕是否存在。
- 默认双语，不强制；切换后记住偏好，但不影响其他视频的字幕可用性。

### 4.3 词条栏（P2-16 已实现）

- **rail 宽度由分栏比例驱动**（≥1280；默认 1440=360px、1920=480px，clamp 280–560px）；标题「滚动词条」+ 当前句词数「本句 N」（小号、低对比、tabular）。
- 当前句目标置顶，紧贴 rail 顶部三行内；历史向下顺延，旧条目 `opacity: .55`，越旧越淡（每句约 −.035，下限 .32；最多 30 句）。
- 每条：词/短语（词 amber `warning-fg` / 语言点 sky）+ 释义（次级色）；**P2-21 每条行卡片**：低对比圆角背景 `bg-surface-2/35`（当前句 `bg-surface-2/50`，略强）、行间 4px；**无**分组标题、kind 徽章、整句上文、边框、分割线（行卡片是背景，不是分割线/边框）。
- **统一单行（P2-17）**：词汇与语言点都是「左词/短语，右释义」一行；右列 `text-right`、`break-words` 可换行；语言点解释不再另起一行。标题略增至 `text-dialog`。
- **字号流体（P2-17）**：词/短语 `clamp(1rem, 0.8vw + 0.5rem, 1.375rem)`（16→22px），释义 `clamp(0.875rem, 0.55vw + 0.5rem, 1.125rem)`（14→18px）；375/1440/1920 明显递增；`text-ui`/`text-caption` 保留为回退。
- 操作组：**☆ 收藏**（已收藏实心 amber）+ **✓ 我已掌握**（P2-19，圆形 Check；已掌握绿色实心、未空心）；**桌面默认 opacity .6（≥.6），hover/focus 升到 1**，不挤压词/释义两列；触屏抽屉上两项都常显（各 44px 触摸目标），与星并列在同一 `ml-auto` 操作组。不新增假入口/设置。
- 当前句词行左侧 2px 竖线标记（词 amber / 语言点 sky），不使用“当前句”文字；历史不显示标记。
- 空句不生成条目；当前句无词时保留历史，不显示“本句无生词”；header 本句数显示 0。
- 无分析时：栏内只留一条紧凑说明 + 既有「生成词条」入口（复用 028 GET，不新增 AI），**不铺满空白**；加载中显示 2 行骨架。
- 收藏写入走 App 既有 optimistic favorites：`FavoriteDraft = { type: vocabulary, id: vocab-<videoId>-<word>, videoId, start: 当前块 start, en_text: word, zh_text: gloss, context_en: 当前句, source_kind: video, source_ref: videoId, source_title: 视频标题 }`；App 顶栏/侧栏「单词本」计数同步。失败或游客在词行内回滚并说明（不弹全屏/不假装成功）。
- **已掌握写入（P2-19）**：状态只取 `useIgnoredWords`（登录 = `word_states.mastered`；游客 = `yt_bilingual_guest_mastered_words`），当前句与历史行同一来源。登录 `PATCH /api/review/words {lemma, mastered, targetLang, definition=释义}`，成功后 `refreshIgnored(targetLang)` 并以响应为准；游客 `writeGuestMastered` + `refreshIgnored()`，不调 API。busy 防重复；失败行内回滚说明。**互斥（specs/005）**：标记成功后若同词有收藏则移除；删除失败回滚 mastered=false 并显示行内错误；取消已掌握不恢复收藏（ADR-0001）。

### 4.4 控制条（本期不实现）

- **P2-15 决策：不实现自定义播放/进度条**，因为 YouTube 原生控制条自带字幕入口（原生 CC）且行为稳定；自定义传输条会与 iframe 原生控件重复、遮蔽原生 CC 入口。`VideoPlayer` 的 `fs: 0` 与原生 controls 均保持不变。
- 因此本期也不存在「外层控制条是唯一控制面」：播放/暂停、音量、进度、倍速、全屏、原生 CC 都交给 YouTube；我们只保留「电影感」的壳层与字幕增强。
- 已实现的相关键盘：`C` 字幕三态；`Esc` 沿用浏览器全屏退出（布局保留）。目标态的 `Space`/`←/→`/`J/L`/`F`/`W` 等外层快捷键留待后续（P2-16+）。
- 不做「假设置」按钮：字幕/语言等偏好使用真实可用的控件，不放置无实现的齿轮图标。

## 5. 移动端（<1280，P2-16 已实现）

```
┌─────────────────────────┐
│ ‹  标题            CC ✕ │ 44–48px 浮层
├─────────────────────────┤
│      16:9 视频（置顶）   │
│   英文字幕（主）         │
│   中文字幕（辅）         │
│  （YouTube 原生控制条）  │
├─────────────────────────┤
│ ═══ 滚动词条（抽屉）     │
│ habits          习惯  ☆ │
│ take off        起飞  ☆ │
│ ...（滚动看历史）        │
└─────────────────────────┘
```

- 顶部仍是 P2-15 的浮层条（返回/标题/CC/退出），移动端隐藏“观影模式”chip 给标题让位；不显示普通 tab。**P2-25：<1280（含 375）不渲染分栏分隔条/比例控件**，视频保持整宽置顶 + 底部抽屉。
- **视频 16:9 置顶**：左右 8px，紧接浮层条下方；**不再在整页垂直居中留大片空白**；字幕仍按 P2-11 流体字号在画面内下缘，避开原生控制条。
- **视频原生控制条保留**（P2-15 决策）：不新增自定义播放/进度条，也不遮挡 iframe 底部的原生控件。
- 词条用**底部抽屉**替代旧右上浮窗：默认展开、占据视频以下全部剩余高度（`flex-1`，375 实测约 550px）；拖拽手柄可点击收起/展开（本期不做复杂手势）；面板 `mt-auto` 锚定底部，收起后只留手柄+标题（约 93px）。
- 抽屉不与画面重叠（`panel.y ≥ video.bottom`），因此不遮视频原生控制条；375 无横向溢出。
- 抽屉内容与桌面 rail 同一组件/断言：标题+本句数、当前句 2px 标记、历史渐隐、收藏星标 + ✓ 已掌握常显（各 44px 触摸目标）、无 headings/context/placeholder；两项标记后行内词 16px/释义 14px 仍同行不溢出。
- 退出在顶部栏；CC 三态与 `C` 键在移动端同样可用；安全区底部 `env(safe-area-inset-bottom)`。

## 6. 空态/加载/失败/登录

| 状态 | 表现 | 不做什么 |
|---|---|---|
| 分析加载中 | 词条栏 2 行骨架；播放不受影响 | 不遮画面、不弹 toast |
| 无分析 | 栏内**紧凑**说明「本片还没有词条」+ 生成按钮（不铺满）；视频正常 | 不显示“本句无生词” |
| 分析失败 | 一句说明 + 重试；保留已缓存内容（若有） | 不阻塞播放、不自动重试刷屏 |
| 未登录 | 说明 + 登录；视频可看 | 不弹全屏登录墙 |
| 当前句无词 | 保留历史，不显示占位；本句数 0 | 不留白块、不显示“本句无生词” |
| 游客 | 不请求 AI 分析；普通视频词条栏提示登录后查看/生成；免费库 payload 自带分析时按真实词条展示（含 P2-19 本地「我已掌握」） | 不假装有词条、不请求 AI；收藏仍走登录提示，已掌握只写本机表 |
| 收藏失败 | 乐观星标回滚 + 词行内说明；顶栏计数不变 | 不假装成功、不弹全屏、不刷 toast |
| 游客收藏 | 行内提示登录后收藏（词条栏本身先提示登录） | 不发送任何收藏写请求 |
| 已掌握失败 | 乐观标记回滚 + 词行内说明（`watch-gloss-mastered-error`） | 不假装成功、不弹全屏、不刷 toast |
| 游客已掌握 | 只写本地表（同单词本「我会了」），刷新后仍在 | 不发送任何 review/收藏写请求 |
| 互斥删除失败 | 回滚 mastered=false + 行内说明；不留下「已掌握 + 已收藏」 | 不隐藏错误、不假称已回滚 |

## 7. 视觉 token

- 背景：`#08090b`；浮层：`bg-app/80 + backdrop-blur`；分隔线：`white/8`。
- 文字：主 `fg-primary`、次 `fg-secondary`、弱 `fg-muted`；词 amber `#fbbf24`；语言点 sky `#7dd3fc`。
- 圆角：画面 18px、浮层 14px、抽屉 18px；间距 4/8/12/16/24。
- 不使用纯白大块、不使用彩色渐变按钮；强调色只用于学习目标。

## 8. 验收（体验，不只是元素存在）

1. **5 秒测试**：截图给未接触产品的人，能说出“这是看电影学英语”。
2. **遮挡测试**：字幕/控制/退出/词条在 375、768、1440、1920 互不遮挡。
3. **连续观看 10 分钟**：无需滚动页面；控制条自动隐藏；词条自动跟句。
4. **状态测试**：加载/无分析/失败/未登录/空句都有明确表现，视频始终可播。
5. **键盘/触摸**：快捷键可用；375 触摸目标 ≥44px。
6. **性能**：首句字幕不等待分析；分析不产生新 AI 调用；切换句子无布局跳动。
7. **字幕模式**：双语/仅英文/关闭三态可切换并持久化；关闭后播放器仍正常、词条栏仍可用；不出现双英文字幕被我们强行叠加。
8. **指标**：首句可读时间、词条打开率、收藏率、10 分钟留存、退出率（上线后埋点）。
9. **桌面词条栏（P2-16）**：默认 75/25 时 1440 rail = 360px、1920 = 480px（280–560 clamp）；标题+本句数；当前句置顶且在顶部三行内（2px 标记、无“当前句”文字）；历史 opacity 渐隐；无 headings/badges/context/empty；收藏星标默认 .6 / hover/focus 1、已收藏实心；可见按钮只有收藏（无未实现的 ✓/设置）；无分析态紧凑且有生成入口、不铺满。
10. **移动抽屉（P2-16）**：视频 16:9 置顶（不再整页垂直居中）；抽屉默认展开、占剩余高度、可点击手柄收起/展开、不覆盖视频与原生控制条；375 无横向溢出；CC 三态/退出可用；旧右上浮窗不存在。
11. **收藏（P2-16）**：一键加/取消；App 顶栏「单词本」计数同步；写入失败星标回滚且行内说明；游客不写接口。
12. **字幕避让（P2-17 / P2-21）**：视口内指针活跃时字幕在 bottom 10%（实测画面下缘 gap ~12%，native 控制栏上方约 10–14px，不遮原生控制条）；屏幕外 pointermove/pointerdown 不唤醒；静止 4s 后落到 0%（暂停不落底）；移动指针恢复；过渡 200ms、reduced-motion 直切。
12b. **字幕宽度（P2-21）**：1440/1920 字幕盒 ≥85% 视频宽（实测 85.2% / 87.3%），长句不裁切；375 换行正常。
12c. **词条行卡片（P2-21）**：每行低对比圆角背景（当前句略强，alpha .5 vs .35），行间 4px，无边框/分割线；操作组默认 .6、hover/focus 1，抽屉常显且不挤压词/释义。
13. **词条行/字号（P2-17）**：词汇与语言点均「左词/短语 + 右释义」同一行，右列 `text-right` 可换行；375 16/14px、1440 约 19.5/16px、1920 22/18px；标题略增。
14. **字幕高亮（P2-17）**：标亮词橙底、语言点/文化点蓝底；点优先不重叠；文本完整；切句更新；关闭不渲染；无 HTML 注入。
15. **Esc（P2-17）**：本容器全屏中按 Esc / 浏览器退出 → 自动退出观影（布局恢复、入口按钮回、偏好 off、不重复调 exitFullscreen）；初始/未全屏/路由切走/请求被拒不误触发；点「退出观影」仍正常。
16. **分栏比例（P2-25）**：≥1280 分隔条存在且 `role=separator`/aria-valuemin 55/aria-valuemax 85/aria-valuenow 75；默认视频 75% / rail 25%（1440 rail 360px）；拖到 60 → 视频约 60.6%（rail 撞 560 上限），拖到 85 → 视频约 80%（rail 撞 280 下限），16:9 居中不溢出；键盘 ←/→ 每次 2%（aria-valuenow 同步）、双击恢复 75；刷新保留；1920 rail 始终 280–560；<1280 无分隔条，375 视频整宽 + 抽屉不变。
17. **指针限定（P2-22）**：鼠标在滚动词条栏/浮层顶栏/舞台黑边/视口外移动不抬字幕；画面内 pointermove/pointerdown/pointerover（进入画面）抬；触摸按同一目标规则；键盘仍抬；4s 落底、暂停不落底不变。

## 9. 实施顺序与状态

| 步骤 | 状态 |
|---|---|
| 1. 壳层/舞台 + 顶部浮层 + 桌面/移动布局（不碰数据） | **P2-15 已完成**：双 chrome 不渲染、浮层五项、2.5s 淡出、舞台居中 + 环境光 |
| 2. 字幕排版/字号/位置/设置 | **P2-15 已完成三态 + scrim**（P2-11 流体字号；**P2-17 避让原生控制条两档 + 句内橙/蓝高亮**；**P2-22 指针限定画面区；P2-25 分栏比例（替代画面大小）**）；逐词 karaoke 仍非目标 |
| 3. 词条栏/抽屉 + 收藏/已掌握 | **P2-16 已完成**：rail（P2-25 宽度改为分栏比例驱动）、本句数、当前句置顶/标记、历史渐隐、☆ 收藏、紧凑空态；移动 16:9 置顶 + 底部抽屉（默认展开/可收起）；**P2-17 统一单行 + 流体字号**；**P2-19 ✓ 我已掌握 + 收藏互斥** |
| 4. 控制条/键盘/状态 | **本期跳过自定义控制条**；只加 `C`/`Esc` 语义（P2-17 Esc 退全屏即退观影） |
| 5. 空态/加载/失败 + 可访问性 | **P2-16 完成词条栏范围内的紧凑空态/行内失败/游客提示**；播放器级状态仍按 P2-15 |
| 6. 视觉 QA + 375/768/1440/1920 + 连续观看测试 | P2-15 覆盖 375/1440/1920 截图与几何断言；768/连续 10 分钟待后续 |

## 10. 非目标（本期）

- 弹幕、评论、社交
- 画中画、投屏、字幕下载
- 逐词 karaoke 高亮（后续；P2-17 只做词/短语/语言点的整段高亮）
- 自动进入观影（尊重用户）
- 书籍/文章阅读器复用（后续单独设计）

## 11. 参考

YouTube Theater Mode、Netflix/Apple TV 播放器、Language Reactor、Lingopie、Migaku、Bilibili 播放器字幕设置、Kindle/Instapaper 的排版与连续性。共同点：内容优先、控件退后、渐进披露、状态完整、可调。

## 12. 落地记录（P2-15，2026-11-24）

| 内容 | 位置 |
|---|---|
| 观影模式不渲染 AppShell 顶栏（可选 `hideTopbar`，默认 false）/ LearningHeader | `frontend/src/components/AppShell.tsx`、`frontend/src/App.tsx` |
| 浮层顶栏：返回、标题+来源、观影模式 chip、CC、退出观影；2.5s 淡出；指针/触摸/键盘唤醒；无设置按钮 | `frontend/src/components/WatchTopBar.tsx` |
| 舞台：`watch-stage` 尺寸容器 + 16:9 居中 + 环境光/模糊层填黑边；全屏仍只 `learning-scroll` | `frontend/src/App.tsx` |
| 字幕三态持久化与循环；关闭不挂载覆盖层；渐变 scrim、英上中下 | `frontend/src/lib/layout.ts`、`frontend/src/components/WatchSubtitleOverlay.tsx`、`frontend/src/App.tsx` |
| 保留 YouTube 原生控制条/CC；移除观影模式下的播放器浮层退出按钮（退出移到顶栏）；不新增自定义传输条 | `frontend/src/components/VideoPlayer.tsx` |
| 文案（zh-CN / vi-VN：顶栏、三态、原生字幕共存说明） | `frontend/src/i18n/zh-CN.json`、`vi-VN.json` |
| 验收（P2-15 断言 + P2-10/11/12/13 零回归；1440/1920/375 截图） | `scripts/watch-mode-acceptance.mjs` |

## 13. 落地记录（P2-16，2026-11-24）

| 内容 | 位置 |
|---|---|
| rail 宽度由 P2-25 分栏比例驱动（默认 1440 360px、1920 480px，clamp 280–560）；标题「滚动词条」+「本句 N」；当前句置顶 + 2px 竖线标记；历史按句 opacity 渐隐（.55 → .32）；无 headings/badges/context/placeholder；轨迹底部提示「最多保留最近 30 句」 | `frontend/src/components/WatchGlossPanel.tsx` |
| hover/focus 显示 ☆ 收藏（已收藏实心）；抽屉上常显 44px 星标；失败/游客行内说明并回滚；rail 只有收藏一个可见操作（无未实现 ✓/设置） | `frontend/src/components/WatchGlossPanel.tsx` |
| 无分析紧凑空态（说明 + 既有 028「生成词条」GET），不铺满 rail | `frontend/src/components/WatchGlossPanel.tsx`、`frontend/src/App.tsx` |
| 收藏接线：App 传 `favorites`／`onAddFavorite`／`onRemoveFavorite`；面板构造 vocabulary draft（`vocab-<videoId>-<word>`、start=blockStart、context_en=当前句、source_kind=video/ref/title）；App 顶栏计数同源同步；删除走 `report:false` 静默回滚 | `frontend/src/App.tsx`、`frontend/src/components/WatchGlossPanel.tsx` |
| 移动：`watch-stage` 在 <1280 改为视频置顶（左右 8px，`flex-none`）；`WatchGlossPanel variant=drawer` 占剩余高度、默认展开、手柄点击收起/展开、`mt-auto` 锚底、安全区 padding；旧 floating pill/panel 删除 | `frontend/src/App.tsx`、`frontend/src/components/WatchGlossPanel.tsx` |
| 浮层顶栏移动端隐藏「观影模式」chip，为标题/CC/退出让位；其余 P2-15 行为不变 | `frontend/src/components/WatchTopBar.tsx` |
| 文案（zh-CN / vi-VN：本句数、收藏、抽屉手柄、rail 提示） | `frontend/src/i18n/zh-CN.json`、`vi-VN.json` |
| 验收（P2-16 rail/空态/收藏计数/失败回滚/游客 + 移动 16:9 置顶/抽屉/收起/375 + 1440/1920/375 截图 + P2-10/11/12/13/15 零回归） | `scripts/watch-mode-acceptance.mjs` |

**已知边界**：iframe 不暴露原生 CC 状态，我们不读取/不控制；用户自行开启原生字幕时应选择「关闭」。✓ 已掌握已在 P2-19 实现（收藏星旁圆形开关，登录/游客同一 store）；发音仍未实现；移动端无自定义传输条（P2-15 决策，原生控制条保留）。

## 14. 落地记录（P2-17，2026-11-24）

| 内容 | 位置 |
|---|---|
| 字幕避让原生控制条：App 在观影模式监听视口内 `pointermove` / `pointerdown`（P2-21 越界坐标忽略）/ `touchstart` / `keydown`，活跃时字幕 `bottom 10%`（P2-21 由 15% 下调）；播放中静止 4s 落到底缘 `bottom 0%`（P2-20：暂停不落底）；`bottom` 过渡 200ms，reduced-motion 下 0ms 直切 | `frontend/src/App.tsx`、`frontend/src/components/WatchSubtitleOverlay.tsx` |
| 字幕窗接收 `dock` / `raised`（两档 bottom）与 `glosses` / `languagePoints`（句内高亮）；点优先、范围不重叠；文本切片渲染，无 `dangerouslySetInnerHTML`；橙 `bg-amber-400/20 text-amber-100`、蓝 `bg-sky-400/20 text-sky-100`；切句更新，关闭不渲染 | `frontend/src/components/WatchSubtitleOverlay.tsx`、`frontend/src/App.tsx` |
| 词条行统一：词汇与语言点同一个 `GlossRow`（左词/短语 + 右释义 `text-right`/可换行 + 2px 标记 + ☆ 收藏 + 行内错误）；语言点释义不再另起一行；标题升 `text-dialog`；P2-21 行卡片 `bg-surface-2/35`、当前句 `/50`、行间 4px、操作组默认 .6 | `frontend/src/components/WatchGlossPanel.tsx` |
| 词条字号流体：词 `clamp(1rem, 0.8vw + 0.5rem, 1.375rem)`（16→22px）、释义 `clamp(0.875rem, 0.55vw + 0.5rem, 1.125rem)`（14→18px）；`text-ui`/`text-caption` 回退 | `frontend/src/components/WatchGlossPanel.tsx` |
| Esc：`fullscreenchange` 里用 `pageFullscreenRef` 判断「本容器全屏 → 非全屏」并 `setWatchMode('off')`；初始同步、请求被拒、他人全屏、路由切走（主动清 ref 后释放）不触发；点「退出观影」仍走原路径 | `frontend/src/App.tsx` |
| 验收：抬高/落底两档 + 暂停不落底 / 恢复 4s 等待 + 指针恢复 + 200ms 过渡（reduced-motion 0ms）、词条行同线/right/字号三档（375 16/14、1440 ~19.5/16、1920 22/18）、橙/蓝高亮与完整文本、ESC→watch off、初始/路由/拒绝全屏不误触发；P2-21：视口外 pointer 不唤醒/视口内 pointermove+pointerdown 唤醒、抬高 7–14% band（实测 12.1%）、落底 0、1440/1920 字幕盒 ≥85%（85.2%/87.3%）、行卡片 alpha/4px/当前句更强、操作组默认 .6、375 不挤压；P2-10/11/12/13/15/16 零回归；2× PASS | `scripts/watch-mode-acceptance.mjs` |

## 15. 落地记录（P2-19，2026-11-24）

| 内容 | 位置 |
|---|---|
| 词条行「我已掌握」圆形 Check（lucide，rail hover/focus 出现 / 抽屉常显 44px；绿色实心=已掌握、空心=未；`data-testid="watch-gloss-mastered"`、`data-mastered`、`aria-pressed`、`aria-label` 含词；与 ☆ 同一 `ml-auto` 组） | `frontend/src/components/WatchGlossPanel.tsx` |
| 状态单一来源 `useIgnoredWords`：登录 `word_states.mastered`、游客本地表；当前句与历史行同源，取消后恢复标亮 | `frontend/src/lib/ignoredWords.ts`、`frontend/src/components/WatchGlossPanel.tsx` |
| 写入：登录 `PATCH /api/review/words {lemma, mastered, targetLang, definition=释义}` + `refreshIgnored(targetLang)`（响应为准）；游客 `writeGuestMastered` + `refreshIgnored()`（不调 API）；busy 防重复、失败行内回滚 | `frontend/src/components/WatchGlossPanel.tsx` |
| 互斥（specs/005）：标记成功后移除同词收藏；DELETE 失败 → PATCH mastered=false 回滚 + 行内说明；取消已掌握不恢复收藏（ADR-0001） | `frontend/src/components/WatchGlossPanel.tsx` |
| App 向 rail/drawer 两处 `WatchGlossPanel` 传 `targetLang`；文案（zh-CN / vi-VN：已掌握/取消/失败/互斥回滚） | `frontend/src/App.tsx`、`frontend/src/i18n/zh-CN.json`、`vi-VN.json` |
| 验收：rail 操作组/aria/绿色实心、登录 PATCH 体 + 回读 + 刷新持久、取消不恢复收藏、互斥 DELETE 失败回滚、PATCH 500 回滚、游客库视频本地表写入/刷新/撤销零 API、375 两操作 ≥44px 且 16/14px 仍同行不溢出；1440/375 截图 + P2-10/11/12/13/15/16/17/18 零回归 | `scripts/watch-mode-acceptance.mjs` |

**已知边界**：游客普通 YouTube 视频仍无 AI 分析（词条栏先提示登录）；游客的已掌握只在本机（不跨设备/不上传）；发音仍未实现。

## 16. 落地记录（P2-21，2026-11-24）

| 内容 | 位置 |
|---|---|
| 词条行低对比圆角卡片：`bg-surface-2/35`，当前句 `bg-surface-2/50`；行/条目无边框无阴影、无分割线；行间 4px（含词列表与语言点列表之间）；操作组 32px 图标不挤压右对齐释义 | `frontend/src/components/WatchGlossPanel.tsx` |
| 操作组默认 `opacity: .6`、hover/focus 1；抽屉常显 44px；收藏/已掌握状态与写路径不变（P2-16/P2-19） | `frontend/src/components/WatchGlossPanel.tsx` |
| 指针过滤：仅 `pointermove`/`pointerdown` 的 `clientX/Y ∈ 0..innerWidth/0..innerHeight` 唤醒字幕，屏幕外/越界忽略；`touchstart`/`keydown` 保持；暂停仍不落底 | `frontend/src/App.tsx` |
| 抬高态 `bottom: 10%`（实测画面下缘 gap 12.1%，原生控制栏上方约 10–14px）；落底 `0%`；过渡/reduced-motion 不变 | `frontend/src/components/WatchSubtitleOverlay.tsx` |
| 字幕宽 `min(96ch,92%)`（容器字号 = 英文流体字号，`ch` 随字号缩放）；scrim `sm:px-6`；1440 实测 85.2%、1920 87.3%，375 正常换行不裁切 | `frontend/src/components/WatchSubtitleOverlay.tsx` |
| 验收：视口外 pointer 保持落底、视口内 pointermove/pointerdown 抬高；词条卡 alpha 当前 .5 / 历史 .35、行间 4px、操作组 .6；抬高 7–14% band、落底 0；1440/1920 宽度 ≥85%；375/1440/1920 截图；2× PASS | `scripts/watch-mode-acceptance.mjs` |

## 17. 落地记录（P2-22 指针区域 + P2-25 分栏比例，2026-11-24）

| 内容 | 位置 |
|---|---|
| 字幕唤醒只认画面内 pointer/touch：window `pointermove`/`pointerdown`/`pointerover` 的 `event.target` 必须位于 `video-area`（`contains`），并保留 P2-21 视口坐标过滤（`pointerover` 覆盖进入跨域 iframe 的边界）；`touchstart` 同目标过滤；`keydown` 始终唤醒；滚动词条栏/顶栏/舞台黑边/视口外都不抬 | `frontend/src/App.tsx` |
| 分栏比例偏好：`watchSplitRatio` 55–85（默认 75）、`WATCH_SPLIT_RATIO_KEY = yt_bilingual_watch_split_ratio`、`WATCH_SPLIT_KEY_STEP = 2`、rail clamp 280–560、`watchRailWidthCss()`；P2-22 的 `yt_bilingual_watch_video_scale` 一次性清理 | `frontend/src/lib/layout.ts` |
| 分隔条（仅 ≥1280 观影模式）：`role=separator` / `aria-orientation=vertical` / `aria-valuemin/max/now` / `tabIndex=0`；1px 线 + 中间 handle；指针拖动（`resize-shield`）、←/→ ±2%、Home/End 边界、双击恢复 75；拖动结束写 localStorage | `frontend/src/App.tsx` |
| rail 宽度由比例驱动：`WatchGlossPanel` 接收 `railWidth`（`clamp(280px, (100-ratio)%, 560px)`），删除 `w-[360px]`；视频列 `flex-1` 取剩余宽度，16:9 居中不溢出 | `frontend/src/components/WatchGlossPanel.tsx`、`frontend/src/App.tsx` |
| 移除 P2-22 画面缩放：顶栏不再有「画面大小」控件（`Scaling` 菜单删除），`watchVideoScale`/`data-watch-scale`/mediaStage 缩放宽度删除；浮层顶栏只保留返回/标题+来源/chip/CC/退出 | `frontend/src/components/WatchTopBar.tsx`、`frontend/src/App.tsx` |
| 文案（分隔条 aria/title，中越） | `frontend/src/i18n/zh-CN.json`、`vi-VN.json` |
| 验收：rail/topbar/window-target pointer+touch 保持落底、画面内 pointerover/pointerdown/真实 pointermove/键盘抬高；1440 默认 75/25（rail 360）、拖到 60/85 的 clamp 宽度与 16:9/不溢出、键盘 ±2%/aria/双击重置、刷新保留；1920 rail ∈ [280,560]；375 无分隔条、视频整宽 + 抽屉；`1440-watch-split`/`1920-watch-split` 截图；P2-10～P2-24 零回归；2× PASS | `scripts/watch-mode-acceptance.mjs` |
