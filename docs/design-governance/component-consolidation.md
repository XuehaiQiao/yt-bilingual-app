# 组件收敛方案与旧实现 → 新组件映射（Component Consolidation）

> 作者：A4 · 组件复用工程师 ｜ 日期：2026-11-19 ｜ 阶段：2（门禁 2 交付物）
> 仓库：`yt-bilingual-app` ｜ 范围：`frontend/src/` 组件收敛的**方案与映射表**
> 本阶段**只写方案、不改业务代码、不提交 git**；所有「迁移动作」都是下一阶段的实施指令，不是已完成事实。
> 上游：A1 `audit-report.md`（问题事实与分级）、A2 `design-system/{tokens,components,layout}.md`（视觉/组件契约）、A3 `interaction-spec.md` + `navigation-model.md`（行为/导航契约）、门禁 1 `gate-1-review.md`、`docs/信息架构-导航重构.md` 2026-11-19 修订节。

## W6 修订（2026-11-19，W0/W6 文档对齐）

> **原 217 行不是全部正确。** 阶段 4 交叉审阅（`reviews/a4-cross-review.md`）证明：至少漏 8 处实现点、7 处行号越界、3 行重复、7 条 G22「保留」被计入迁移、内联卡片数把死代码算进 B4。本节记录 W6 的修正；下文所有数字以本表为准。

| 项 | 原值 | W6 修正后 | 证据/命令 |
|---|---|---|---|
| §3 映射行 | 217 | **222** = 221 可执行/登记 + 1 保留别名（G11-11）；G22 的 7 条保留行移至 §3.23，不计入 | §6.5 脚本 `rows=222`
| 漏项 | — | 新增 8 行：`DiscoverScreen:371/382/392/474/483`、`StartLearning:162`、`PlacementScreen:975/1245` | G1-25..27、G12-23..27
| V-06 键 | 24 | **31**（A1 24 + A5 复核 7，G0-06..G0-12）；`sentences.day` 裁决为同批中文化（不计入 31） | G0 表、§5.3
| 重复行 | 3 | 删除 G16-13/14/15（与 G11-09/10/11 同一旧实现）；G16 保留 12 行 | §3 G16 注
| 越界行号 | 7 | 全部改为实际范围：`SentenceText.tsx:19-39`、`lib/navTabs.ts:33-35`、`ReadingHighlight.tsx:32-88` | §6.5b
| G22 | 计入 217 | 7 行移入 §3.23「保留清单」，不参与迁移计数 | §3.23
| 内联卡片 | 61（B4） | **B4 实际迁移 56**；61 = 56 + `InputScreen` 死代码 5（B1 删除） | §附录 A
| 批次 | B3/B4 可并行、B2 依赖倒置 | 见 §4.0/§4.6：B1 与 W1/B0 导航并行；B2 的 G3-02 后置到 B4-P0；B3/B4 不并行；B4 的别名改为兼容适配器 | §4
| 217 其他引用 | 摘要/§6.1/§6.2/§6.5/§6.6 | 全部改为 222，且不再声称原 217 全对 | 全文件

> 基线算术：原 217 = 208 实际迁移 + 7 G22 保留 + 2 别名（G11-11、G16-15）。W6 后 222 = 221 可执行/登记（208 − 2 重复 + 8 漏项 + 7 G0 新键）+ 1 别名（G11-11）；G22 7 行单列。批次合计 60+21+37+65+39 = 222。

---

## 0. 摘要与执行口径

### 0.1 五条结论

1. **重复是「常量级」而不是「组件级」的**：38 个命名按钮常量散在 18 个文件、13 个 `CARD` 常量 + 2 个 `CARD_ICON`，另有 **61 处内联卡片字面量（含死代码 5 处；B4 实际迁移 56 处）**。所以收敛的抓手是「先建原子组件 + 删常量」，不是重写页面。
2. **风险最高的是覆盖层与词卡，不是按钮**：14 个弹窗壳的能力集各不相同（`role` 覆盖 9/14、`Escape` 覆盖 9/14、焦点陷阱 0、滚动锁 0），4 处 `window.confirm` 仍在；词卡同时存在两套 ruby 渲染、两套可点词范围、无 `role`、`z-[90]`、定位无边界夹取。
3. **A2/A3 的契约足够细，能直接落成 props**：本方案把 15 个组件族落成 **15 个 `components/ui/*` 文件 + 6 个新增 `lib/*` 文件**（另扩展既有 `lib/favoriteSource.ts`），每个都给出可直接编码的 TypeScript API；不新建「大而全组件库」。
4. **本方案共 23 组重复、222 条旧实现映射（W6 修正后；原 217 见文首 W6 修订），未归属项 0**；按 5 个组件批次推进（另 W2 与 G0 同批）、总计约 18.5 人日（另 1.5 人日视觉/回归）。B1 可与 W1/B0 导航并行（文件不重叠），第一批不依赖 URL 改造即可独立执行。
5. **发现 6 处 A2/A3 契约缺口**（不是冲突，是待补定义）：`bg-zinc-100` 未 token 化、`resolveFavoriteSource` 目标路径写错、`Tabs` 的 `BottomBar` 皮肤不适用、`Pagination` 缺 offset 适配、`OptionCard`（4 份 `OPTION_BASE`）未被 A2 定义、浮层实际 14 个（A2 记 13）。裁决见 §6.3。

### 0.2 判据与冲突顺序

| 冲突 | 以谁为准 |
|---|---|
| 视觉值（颜色/字号/圆角/阴影/z/控件高） | A2 `tokens.md`；与《设计语言》冲突处按 tokens §14 勘误 |
| 组件语义/状态矩阵/a11y | A2 `components.md` |
| 交互行为（失败/空/确认/焦点/反馈层级） | A3 `interaction-spec.md` |
| 导航/返回/URL/history | A3 `navigation-model.md`（门禁 1 已批准 D-01–D-12） |
| 问题是否存在、严重度 | A1 `audit-report.md` |
| 本文件与 A2/A3 的**缺口**（未定义而非矛盾） | 本文件给出裁决并登记，见 §6.3；不静默发明 |

### 0.3 术语（迁移动作只有 6 种）

| 动作 | 含义 | 允许的残留 |
|---|---|---|
| **替换** | 调用点改用新组件，旧实现（常量/壳）删除 | 无 |
| **包裹** | 旧组件内部改为渲染新组件，对外 props 不变 | 旧文件保留、旧导出保留 |
| **保留别名** | 旧导出名 `export { X as Y } from ...` 指向新实现 | 一个发布周期，A5 记 TODO |
| **改名** | 语义变化（如分页 → 步骤控制），调用点与 aria 文案同步改 | 需更新测试选择器 |
| **保留** | 经裁决不收敛（有理由），仅做 token 化或维持现状 | 必须在 §7 或行内写明理由 |
| **删除** | 代码删除（死代码/常量）。删除前必须 grep 确认 0 引用 | 无 |

### 0.4 验证等级（映射表「验证」列的取值）

| 代号 | 内容 | 命令/方式 |
|---|---|---|
| **V0** | 类型 | `cd frontend && npx tsc -b` |
| **V1** | 类型 + 构建 | `npm run build` |
| **V2** | V1 + 现有脚本 | `npm run check:i18n`、`npm run check:library` |
| **V3** | V2 + 视觉 | 截图 375×667 / 390×844 / 1024×768 / 1440×900，与迁移前逐屏对比 |
| **V4** | V3 + 交互/无障碍 | 键盘（Tab/Esc/方向键/Enter）、触屏（390×844）、读屏抽查（VoiceOver/Chrome a11y tree） |

> 现有 Playwright 脚本在 `scripts/*.mjs` 与 `frontend/scripts/check-library-ui.mjs`（共 77 个 `data-testid` 依赖），**不是**「跑一遍就完」：迁移前先冻结选择器，见 §5.4 / 附录 B。

### 0.5 批次总览（细节见 §4）

| 批次 | 主题 | 行数 | 预估 | 可独立回滚 |
|---|---|---:|---:|---|
| B1 | 基座：token/lib 单一来源、Button/IconButton、点词工厂、31 个英文键（+ `sentences.day`） | 60 | 3.0 人日 | ✓（纯新增 + 常量删除；与 W1/B0 导航并行） |
| B2 | 覆盖层与反馈：Dialog/ConfirmDialog/Sheet、Toast、离线标记 | 21 | 3.0 人日 | ✓（旧壳保留到批末；含 1 行后置 G3-02 等 B4-P0 的 StateView） |
| B3 | 导航壳与页头：CountBadge/Badge、BackButton/SubHeader/PageHeader、导航壳 | 37 | 3.5 人日 | ✓（壳结构不动） |
| B4 | 状态/卡片/列表/分页/词卡：Empty/Loading/Error、Card/ListRow、Pagination、WordCard | 65 | 4.5 人日 | ✓（词卡独立文件） |
| B5 | 高风险交互件：Tabs/Segmented/WordHighlight/VocabRow/Progress/Field | 39 | 4.5 人日 | ⚠️ 需同批更新脚本选择器；G22 保留行已移出 |
| — | 视觉与回归（截图矩阵、真机抽查） | — | 1.5 人日 | — |
| **合计** | | **222** | **20.0 人日** | 60+21+37+65+39=222（W6 后） |

---

## 1. 现状重复组清单（G0–G22）

> 每组固定四栏：**旧实现（文件:行/导出）**、**差异（样式/props/行为/状态）**、**使用页面/入口**、**风险**。
> 「行」均为 2026-11-19 仓库实测行号；与 A1 报告的行号偏差 ≤3 行（A1 定稿后代码仅注释变更），以本表为准。
> 「差异」列覆盖样式/行为/状态；**props 级差异**在本表只给要点，逐组件的旧导出/新 API 对照见 §3 的「旧实现」与「迁移动作」两列，以及 §2.2 的 TypeScript 签名。

| 组 | 旧实现（文件:行 / 导出） | 差异（样式 / 行为 / 状态） | 使用页面 / 入口 | 风险 |
|---|---|---|---|---|
| **G0** i18n 英文键（V-06，P0；A1 初审计 24 + A5 复核 7 = **31 键**；`sentences.day` 另行裁决） | `i18n/zh-CN.json`：`common.cancel`、`home.loading.*`(5)、`home.analyzing*`(2)、`estimate.*`(5)、`shows.*`(4)、`topbar.popOut/closePopOut/logoAlt`、`common.unknownVideo/unknownChannel/noThumbnail`、`home.deletedToast`（24）+ `home.removeHistoryTitle`、`home.deleteConfirm`、`home.noUploads`、`common.localFile`、`shows.season`、`shows.episodesShort`、`shows.seasonsEpisodes`（7），共 31 键 | 中文默认界面显示英文；`check-i18n` 只校验 vi-VN 对齐，测不出；`shows.emptyHint` 还把开发者操作（放 .srt）写进 UI | 视频处理遮罩、估价确认、本地剧集货架、登录/顶栏 aria、历史删除 toast、历史/订阅空态 | 中文用户在主链路上连续看到英文；「确认花费」场景信任受损；门禁 1 登记为上线阻塞 |
| **G1** 按钮（C-01） | 38 个命名常量 / 18 文件：`AccountScreen:87/89`、`ReviewScreen:106/108`、`AdminConsoleScreen:90/92/94/96/98`、`VocabularyBookScreen:138/140`、`BlogScreen:43/45`、`PlacementScreen:69/71/73`、`ReportScreen:74`、`QuizScreen:34`、`WelcomeScreen:42/45`、`ExamScreen:85/87/89`、`AbilityScreen:67/69/71`、`CourseScreen:74/76`、`ShareCardDialog:43/45`、`ReaderScreen:144/146/148`、`RecentLearning:67`、`TodayWorkbench:71/73`、`PracticeScreen:16`、`NovelCourseCard:20`；另 4 份 `OPTION_BASE`（Placement:76/Quiz:36/Exam:92/Course:79）与 7 处内联按钮 | 高度 `h-8/9/10/11/12` 五档（含 `h-10 sm:h-11`）；横向 `px-3/4/5/6`；圆角 `rounded-lg/xl/full`；禁用 `opacity-40/50` 与 `disabled:pointer-events-none` 有无；`disabled:active:scale-100` 有无；transition 属性表 4 种；图标按钮命中区 28–36px | 全站（今日/内容/练习/我的/复习/报告/考试/定位/能力/课程/单词本/管理台/弹窗/学习页） | 同屏主按钮高度不一（Placement 主 `h-11` 紧邻次 `h-9`）；样式改动必然漏改；触屏命中区不足 |
| **G2** 卡片 / 图标块 / 区块标题（C-01/C-11/V-18） | 13 个 `CARD`：`VocabularyBookScreen:142`、`PlacementScreen:75`、`ReportScreen:73`、`WelcomeScreen:38`、`ExamScreen:91`、`AbilityScreen:65`、`TodayWorkbench:68`、`PracticeScreen:15`、`CourseScreen:78`、`LibrarySection:47`、`BooksSection:34`、`HomeRecommendations:21`、`ImportedBooksShelf:25`；2 个 `CARD_ICON`（`TodayWorkbench:69`、`WelcomeScreen:46`）；`SECTION_TITLE`（`ContentScreen:38`）；**61 处内联卡片字面量（含死代码 5；B4 实迁 56）**（清单见附录 A） | 圆角 `rounded-2xl` / `rounded-3xl` / `rounded-2xl sm:rounded-3xl`；底 `bg-zinc-900/40` 与 `/30`、`/60`；padding `p-3.5 sm:p-5` vs `p-4 sm:p-5` vs `p-2 sm:p-2.5`；是否 `flex flex-col min-w-0`；`CARD_ICON` 32/36px 两档；区块标题 17px 字面量 5 处重复 | 四个一级页、右栏、书架、免费库、推荐、句子包、课程、报告、能力 | 同角色卡片圆角/内边距混排；任何视觉调整要改 **71 处**（13 常量 + 2 图标 + 56 内联；61 含死代码 5）；图标块眼位对不齐 |
| **G3** 弹窗壳（C-02/I-02/I-03/I-04） | 14 处：`ModelSelectionModal:53`、`EstimateDialog:91`、`LanguageSettingsModal:99`、`BookImportDialog:122`、`ShareCardDialog:195`、`ChannelVideoList:68`、`AbilityScreen:252`、`AbilityScreen:478`、`ExamScreen:1235`、`PlacementScreen:1402`、`AdminConsoleScreen:310`、`PwaInstallButton:70`、`App.tsx:3392`(ProcessingOverlay)、`App.tsx:3524`(guest-auth) | 遮罩 `bg-zinc-950/70` vs `/85` vs 无；面板 `/90` vs `/95`；圆角 `rounded-2xl` vs `rounded-t-2xl`；`role` 覆盖 9/14；`Escape` 覆盖 9/14；**焦点陷阱 0、滚动锁 0**；`z-50/70/80/100/120` 五档；动效 framer vs `animate-[fadeIn]` | 全部弹窗入口（估价/语言/导入书/分享/频道/自评/证据/退出确认/重启确认/管理台/PWA/处理遮罩/游客登录） | 键盘/读屏无法关闭（I-02 P0）；背景可滚（滚动穿透）；焦点丢失；层级互盖（I-10/V-13 同源） |
| **G4** 危险操作确认（I-05/IX-24） | `window.confirm` 4 处：`TodayScreen:145`、`ReaderScreen:644`、`ImportedBookReaderScreen:365`、`InputScreen:115`（死代码） | 原生 confirm 按钮文案跟浏览器语言走、不可 i18n；与 Exam/Placement/Admin 的自绘确认框两套语义；危险动作文案「确定」而非动词 | 删除历史 / 删除文章 / 删除导入书 | 最危险的操作上首先崩掉一致性；确认文案无法保证「动词+对象」 |
| **G5** Toast / 通知（I-10/IX-08） | `Toaster.tsx:6`（TTL 6000）、`:27`（`bottom-6`、`z-[100]`）、`:28` 容器；`lib/toast.ts:16-25`（无去重/上限/暂停）；`OfflineIndicator.tsx:20-24`（`bottom:16px`、`z-[95]`） | 所有类型固定 6s；无去重、无上限；`bottom-6` 落在 56px 底栏内；离线标记与 toast 同一底部带；close 按钮 32px | 全局（收藏/删除/保存/网络错误/离线） | 移动端两条最重要反馈互相遮挡；错误 6s 消失来不及读；连发 5 条叠 5 条 |
| **G6** 点词 handler（C-03/I-12） | 5 份 `useCallback`：`App.tsx:288`(字幕)、`:295`(阅读)、`:316`(免费库文章)、`:336`(公版书)、`:353`(导入书)；`App.tsx:3162` 把字幕版传给 `SentenceView`；`:910`/`:958` 的来源分支；`lib/favoriteSource.ts` 的 `resolveFavoriteSource` | 函数体逐行相同，仅 `sourceKind` 字面量不同；句子包复用字幕 handler → `source_ref` 为空；来源解析对 `sentence_pack` 的 `canOpen` 依赖 `sentencePackLevel` | 字幕、句子精背、阅读器、书籍、免费库文章、单词本「出处」 | 数据层来源丢失（单词本「出处未知」且不可回跳）；复制粘贴扩散；收藏 id 生成分散 |
| **G7** 词卡 / 高亮 / ruby（C-04/C-13/V-05） | `WordPopover.tsx`（整文件 353 行；overlay `:229`、card `:250`、CARD_* `:55-64`、紫色词性 `:258/301`、错误 `:289`）；`TranscriptBlock.tsx:26-48`(ClickableWords)、`:51-105`(HighlightedText ruby)；`SentenceText.tsx:19-39`（第二套 ruby/chunk）；`ReadingHighlight.tsx:20-31`（琥珀下划线） | 两套 ruby（`rt purple-300/90` vs `text-zinc-400/90`）；两套可点范围（word vs chunk）；词卡 overlay `z-[80]`、card `z-[90]`、无 `role`、`w-80` 定位仅估算高度；词性紫色属 AI 语义滥用；字幕星标 hover 才出现 | 字幕、句子精背、四个阅读器、书籍、免费库文章 | 用户学到的「点词」规则在不同屏不同；紫色语义被破坏；手机右侧点词出界；键盘不可关闭；触屏点不到星标 |
| **G8** 返回 / 页头（I-11/L-12/N-09/D-04） | 页面级返回/关闭 21 处：`LearningHeader:36-48`(h-9)、`BookReaderScreen:431-442`(h-8)、`SentenceView:96-112`(h-7)、`ReviewScreen:355-368`(X chip)、`ReportScreen:145-158`(X chip)、`DiscoverScreen:258-267`(h-8)、`VocabularyBookScreen:549-565`(h-9)、`AccountScreen:292-302`(h-9 rounded-xl)、`AdminConsoleScreen:873-884`、`CourseScreen:135-148`、`ReaderScreen:1090-1100`(h-8 -ml-3)、`ReaderScreen:186-196`、`LibraryArticleReader:66-74`、`ImportedBookReaderScreen:395-405`、`BookSeriesScreen:72-80`、`BlogScreen:338-346/384-392`、`ExamScreen:1170-1215`(eyebrow+标题+副标+2 图标)、`AbilityScreen:872-886`(X)、`PlacementScreen:1360-1385`(X)、`App.tsx:3460-3472`(唯一边框返回)；4 个一级页标题 `TodayWorkbench:194`/`ContentScreen:219`/`PracticeScreen:88`/`AccountScreen:289`；`PAGE_PAD` 3 个常量 + 2 处内联（`TodayScreen:23`、`ContentScreen:37`、`PracticeScreen:14`、`AccountScreen:529/580`）；容器宽 8 种 43 处 | 返回 h-7/8/9 三档、`px-2/2.5/3`、`-ml-1/2/3`、有无文字；任务页用 X、面板页用 ←（两套语义）；头部 h-12 / `h-12 md:h-14` / `py-2.5` / `py-3` 四档；SentenceView 工具条 `flex-wrap` 会变两行；一级页标题 24/30/48 三档 | 全部子视图 + 四个一级页 | 最高频控件位置/尺寸不一致导致误触；桌面任务页无面包屑；标题跨 tab 跳档 |
| **G9** Tabs（C-05） | `TopBarTabs.tsx:33-60`（下划线 + `layoutId`）；`VocabularyBookScreen:570-622`（淡 pill + `text-[13px]` + 计数）；`LibrarySection:314-345`（白实底、无滑块）；`AdminConsoleScreen:925-951`（白滑块、`text-xs`、`rounded-md`） | 选中态 4 种（下划线/淡 pill/白实底/白滑块）；容器 3 种；`role="tabpanel"` 全仓 0 个；`aria-controls` 2 处；tab 高度 32/36/40 混用 | 顶栏导航、内容页免费库、单词本、管理台 | 用户无法把「tab」识别为同一种控件；无障碍缺 tabpanel 关联；单词本 8+ tab 移动端横向溢出 |
| **G10** Segmented（C-06/I-17） | 8 处：`App.tsx:2660-2700`(译文模式)、`ShowBrowser:145-168`(季)、`AuthScreen:108-137`(登录/注册)、`SentenceView:111-130`(级别)、`ReaderScreen:744-770`(导入)、`ReaderScreen:990-1020`(译文)、`LanguageSettingsModal:36-60`(语言)、`StartLearning:102-121`(原生 `<select>`，I-17) | 选项度量 4 种（`px-2.5 py-1 text-xs` / `px-3 py-1.5 text-sm` / `px-3 py-1.5 text-xs` / `px-2.5 py-1.5 text-xs`）；容器 `bg-zinc-800/80` vs `bg-zinc-900/60` vs `bg-zinc-900/40`；选中「白滑块」vs「白实底」；`role=radio` 只 1 处；原生 select 1 处 | 学习页工具条、阅读器（同屏两个）、句子包、登录、语言设置、季选择、开始学习 | 同屏两个分段控件高度/字号不同；原生下拉在 iOS 是系统选择器；`role`/键盘不一致 |
| **G11** Badge / Count / 来源标签（C-07/C-13/N-10） | `TopBarTabs:44-52`(16/9px)、`Sidebar:166-190`(16/9px + amber 变体)、`BottomBar:43-53`(18/10px)、`VocabularyBookScreen:607-620`(18/10px)、`LevelBadge:150-166`、`LibrarySection:302-307`(emerald uppercase)、`LearningHeader:54-58`(11px chip)、`AccountScreen:678-682`(blue badge)、`AppShell:189-191`(inline 99+)、`LearningHeader:69-74`(原数)、`navTabs.ts:33-35`(`formatDueBadge`) | 计数徽章 4 套尺寸；9/10px 低于可读下限；来源标签 3 种色语义（emerald/neutral/blue）；计数格式：`99+`(AppShell) vs 原数(LearningHeader) vs `formatDueBadge`；`uppercase` 用在英文 FREE 尚可但无规则 | 顶栏/侧栏/底栏/学习页/单词本/免费库/账户页 | 同一计数四入口不同格式，用户以为数据错；窄容器溢出；语义色无规则 |
| **G12** 空 / 加载 / 错误三态（I-01/I-07/I-08/I-09） | 空态 9 处：`VocabularyBookScreen:644`(基准)、`RecentLearning:508/533`(虚线)、`BlogScreen:486`、`DiscoverScreen:463`、`SentenceView:186`、`BookSeriesScreen:131`、`ChannelVideoList:84`、`ShowBrowser:81`；加载 10 处：`ContentScreen:285`(w-3.5)、`ReaderScreen:890`(w-6)、`BlogScreen:361`、`ChannelVideoList:82`(纯文字)、`ImportedBooksShelf:80`(骨架)、`VocabularyBookScreen:1014/1341`、`ReviewScreen:508`(py-20)、`ReportScreen:173`；错误：`TodayScreen:92-105`、`ContentScreen:119-131`、`:163-192`、`:133-163`（4 处 P0「失败当空」），`ReaderScreen:183-190`(基准)、`VocabularyBookScreen:1348`、`ReportScreen:191`、`ReviewScreen:517`、`RecentLearning` 部分错误、`AbilityScreen:1237` | 空态 padding 6 档（py-16/24/20/12/10/8），2 种边框（普通/虚线）；加载 3 形态（行内小 spinner / 居中大 spinner / 骨架）；错误 3 呈现（内联/toast/静默）；`items.length===0 && failed` 被判为空 | 今日/内容/练习右栏/频道/书架/单词本/博客/发现/报告/复习/能力 | **失败被渲染成「暂无数据」是 A1 P0**（用户以为历史/订阅被清空）；空态无下一步动作；布局跳动 |
| **G13** 分页 / 步骤（I-18） | `VocabPagination.tsx`（页码条 + 状态文案，保留基准）；`RecentLearning:560-596`（上一页/指示器/下一页 + `PAGE_BUTTON:67`）；`AdminConsoleScreen:1185-1205`（offset 翻页 + `PAGE_SIZE`）；`AbilityScreen:388-410`（步骤按钮，误叫分页） | 状态模型混用：`pages`（vocab/recent）vs `hasMore`（admin）；页码形态 2 套 + 步骤 1 套；当前页 a11y 仅 vocab 有 `aria-current`；`h-8` 按钮命中 32px | 单词本、最近学习、管理台用户表、能力自评 | 用户在不同列表要重新学习分页；offset 与页码换算易错；步骤流程被叫分页 |
| **G14** 列表行 / 删除图标（C-11/C-15） | 列表行 4 套：`ContentScreen:292-310`、`:466-486`、`RecentLearning:320-340`、`ShowBrowser:110-125`；设置/账户行 `AccountScreen:320-520`；删除/操作图标 6 处：`App.tsx:2640-2660`(hover 才出)、`RecentLearning:352-370`、`VocabularyBookScreen:845-860`、`AccountScreen:632-646`(取消改名)、`ReaderScreen:970-985`、`ImportedBookReaderScreen:420-435` | 行底 `bg-zinc-800/30` vs `/60` vs `bg-zinc-900/40`；padding `p-2.5` vs `p-3`；hover 反馈强弱不同；删除色 `text-red-400` vs `text-zinc-500`；确认方式（confirm/无确认）；命中区 28–36px | 内容页右栏/列表、最近学习、本地剧集、我的、单词本、阅读器 | 对比度与悬停反馈漂移；误删风险不均；触屏 hover-only 删除点不到 |
| **G15** 进度（C-12/V-08） | `TodayWorkbench:342-347`（h-1 + emerald + role）、`ContentScreen:299-302`（同，无 role）、`SentenceView:168-170`（h-1 渐变 emerald→sky，无 aria）、`SentencePacks:42-44`（渐变）、`ReviewScreen:398-403`、`PlacementScreen:625-631`、`QuizScreen:401-406`、`ExamScreen:621-625`、`CourseScreen:209-214`、`ReaderScreen:1049`、`LocalEpisodeStage:131`；`VocabAxis:47`（彩虹轴，非进度） | 高度 1px vs 1.5px；填充 emerald vs 渐变 vs brand；a11y：7 处有 `role=progressbar`、4 处无；`aria-valuenow` 有的用 index 有的用百分比 | 今日/内容/学习页/句子包/复习/定位/理解题/考试/课程/阅读器/设置（词汇轴） | 读屏只能在部分位置听到进度；1px 条在 Retina 几乎不可见；同语义三套配色 |
| **G16** 共享函数（C-08/C-09/N-10） | `cn()`：`TranscriptBlock:5-14`（被 `SentenceText:1`、`BilingualRow:12`、`ReadingHighlight` 链式依赖）；`bilingualReadingWidth()`：`BilingualRow:16-17`；`formatClock` 6 份：`App:158`、`ReportScreen:81`、`QuizScreen:39`、`TranscriptBlock:137`、`LocalEpisodeStage:32`、`TeachingNotesPanel:30`；倒计时 2 份：`CourseScreen:82`、`PlacementScreen:105`；内联 `mm:ss` 2 处：`App:1611`、`lib/recommend:75`；计数格式：`AppShell:189`、`LearningHeader:71`、`navTabs:40` | 6 份逐字相同；2 份 `ceil` 变体；均无 `>1h` 处理（60 分钟显示 `60:00`）；`cn` 让「字幕组件」成为事实 UI 工具库，依赖方向反转；全仓只有 4 文件用 `cn` | 字幕/报告/理解题/学习页/句子包/课程/定位/最近学习/顶栏 | 改一处要改 9 处；新增组件为了 `cn` 引入 477 行字幕逻辑；类名冲突无法被 tailwind-merge 消解 |
| **G17** 搜索 / 输入（C3） | `ReaderScreen:150`(`textField`)、`SentenceView:150-156`(h-7)、`VocabularyBookScreen:921`(h-10) 与短语搜索、`DiscoverScreen:294-305`、`BookImportDialog:186-194`(blue focus)、`AccountScreen:612-620`(改名)、`StartLearning:125-145`(hero 字段) | 高度 28/36/40 三档；圆角 2 档；placeholder `zinc-500` vs `zinc-600`；focus 4 种（全局环 / 壳 focus-within / `focus:ring-blue-*` / `outline-none`）；移动端字号未统一 16px | 阅读器、句子包、单词本、发现、导入书、账户、开始学习 | 输入聚焦样式不一；iOS 自动放大；`focus:outline-none` 吞全局环 |
| **G18** 死代码（C-10） | `InputScreen.tsx:1-598`（`window.confirm:115`、`id="video-url":338`、`min-h-screen:243`、`h-12` 主按钮 5 处） | 全仓 0 import；与 `StartLearning` 的 `id="video-url"` 重复；注释仍被 `ShowBrowser:91`、`TodayWorkbench:11`、`lib/model.tsx:3` 引用 | 无（死代码） | 后来者照抄旧实现；重复 DOM id 隐患；占 598 行 |
| **G19** 导航壳（C-11） | `Sidebar.tsx`（400 行，240/72、徽章 `:166-190`）、`TopBarTabs.tsx`（见 G9）、`BottomBar.tsx`（h-14 + safe）、`AppShell.tsx`（顶栏标题/CTA/`topbar-start:169`/`wordbookCount:189`） | 4 套徽章（G11）；顶栏标题 15px 但页内也有 24px 标题（N-17 桌面双标题风险）；`h-screen` + 内联 `100dvh` 双写在 App；侧栏/顶栏 tab 同时出现在 md–lg；CTA 用 `rounded-xl bg-zinc-100` 独立写 | 全局壳 | 桌面双标题；层级与 `z-chrome` 不一致；计数格式；壳改动波及所有页面 |
| **G20** 单词本词表行（C-14/L-07） | 词表行 `VocabularyBookScreen:1382-1445`；短语行 `:1049-1130`；来源可点规则 `:534-548`（`resolveFavoriteSource` + `sentencePackLevel`）；移动 tab 溢出 `:574-585` | 桌面 grid 与移动卡片两套 DOM 混在同一个 `<button>`；来源列可点性由本地函数判断；8+ tab 横向滚动无提示、选中项不 `scrollIntoView`；9/10px 计数徽章 | 单词本（我的/短语/词表） | 移动端首屏看不到全部 tab；来源「出处未知」不可点；表格语义缺失（role=table） |
| **G21** 分享 / 选区浮层（C-14） | `ShareCardDialog.tsx`（305 行，Canvas 生成）；`ReaderScreen:1240-1320`（选区浮层「分享本段」） | 同一「分享」两套入口与动效；遮罩透明度不同；按钮常量各自定义；复制/下载失败反馈不同 | 单词本、句子包、阅读器 | 用户认不出是同一功能；A7 评估合并成本高，本轮只共用底层 |
| **G22** 超大组件（C-16） | 7 个 >1,000 行：`AdminConsoleScreen` 1,634、`CourseScreen` 1,606、`VocabularyBookScreen` 1,483、`PlacementScreen` 1,447、`ReaderScreen` 1,329、`ExamScreen` 1,300、`AbilityScreen` 1,281（合计 10,080 行 / 全组件 38%） | 每个文件内联按钮/卡片/弹窗/空态/分页/格式化；本清单 40% 的重复项来自这 7 个文件 | 管理台/课程/单词本/定位/阅读器/考试/能力 | 任何规范都无法「改一处生效」；review 成本高；但本阶段拆分风险 > 收益 |

### 1.1 组数与小计

| 维度 | 数字 | 说明 |
|---|---:|---|
| 重复组 | **23**（G0–G22） | G0 为门禁 1 指定的 P0 i18n 例外，其余对应 A1 C-01–C-16 与 I/N 相关重复 |
| 命名按钮常量 | **38**（18 文件）+ 4 份 `OPTION_BASE` + 7 处内联按钮 | G1（`PAGE_BUTTON` 归 G13、`OPTION_BASE` 归 `OptionCard`） |
| `CARD` 常量 / 内联卡片 | **13 + 2 `CARD_ICON` + 61 处内联**（含死代码 5，存量 56） | G2 / 附录 A |
| 弹窗壳 / 原生 confirm | **14 / 4** | G3 / G4 |
| 页面级返回/关闭控件 | **21** | G8 |
| Tabs / Segmented | **4 / 8** | G9 / G10 |
| 状态三态实现 | **27 处**（空 9 + 加载 10 + 错误 8，去重后 22 行） | G12 |
| 进度条 | **11** | G15 |
| 共享函数副本 | **15**（`cn` 1 + 宽度 1 + 时间 8 + 内联时间 2 + 计数 3） | G16 |
| 死代码 | **1 个文件 / 598 行** | G18 |

---

## 2. 目标组件树

### 2.1 目录与文件（只建当前需要的）

```
frontend/src/
├── components/
│   ├── ui/                          ← 新增；唯一允许承载共享视觉原子的目录
│   │   ├── Button.tsx               C1  Button / IconButton
│   │   ├── Card.tsx                 C2  Card / ListRow / IconTile / SectionHeader / OptionCard
│   │   ├── Field.tsx                C3  Input / SearchField / Textarea（壳 + 状态）
│   │   ├── Dialog.tsx               C4  Dialog / ConfirmDialog（Sheet = Dialog sheet）
│   │   ├── Tabs.tsx                 C5  Tabs（skin: nav | panel）
│   │   ├── Segmented.tsx            C6  Segmented
│   │   ├── Badge.tsx                C7  Badge / CountBadge / Dot
│   │   ├── Toast.tsx                C8  Toaster（视图；订阅 lib/toast）
│   │   ├── Pagination.tsx           C9  Pagination（+ paginationTokens 导出）
│   │   ├── StateView.tsx            C10 EmptyState / LoadingState / ErrorPanel / Skeleton
│   │   ├── PageHeader.tsx           C12 PageHeader / SubHeader / BackButton
│   │   ├── WordCard.tsx             C13 词卡浮层（非模态）
│   │   ├── WordHighlight.tsx        C13 ClickableWords / WordHighlight（唯一 ruby）
│   │   ├── VocabRow.tsx             C14 VocabRow / VocabTabStrip
│   │   └── Progress.tsx             C15 Progress / StepControls
│   ├── AppShell.tsx                 C11 NavShell 保留改造（不新建文件）
│   ├── Sidebar.tsx                  C11 保留改造
│   ├── TopBarTabs.tsx               C11 内部改用 ui/Tabs(skin=nav)
│   ├── BottomBar.tsx                C11 保留（icon+label 布局不适用 Tabs nav 皮肤）
│   └── …                            ← 业务组件原地迁移，不搬家
└── lib/
    ├── cn.ts                        clsx + tailwind-merge（唯一来源）
    ├── time.ts                      formatClock / formatCountdown / formatDuration
    ├── format.ts                    formatCount / formatDueBadge（别名）
    ├── reading-layout.ts            bilingualReadingWidth
    ├── word-lookup.ts               WordLookupSource / createWordLookup / getLookupSourceKind
    └── word-card-position.ts        computeWordCardPosition（视口夹取）
```

- **不建 `components/ui/index.ts` barrel**：项目无路径别名（`tsconfig` 无 `paths`），barrel 会把 15 个组件拉进一棵 import 图，增大循环依赖与 HMR 面积；逐个文件 import。
- 组件文件一律 `export function`（受 `eslint react-refresh` 约束的纯组件文件），类型与常量随文件导出。

### 2.2 组件契约（名称/props/状态/token 直接指导实现）

> token 类名以 A2 `tokens.md` §12 的 Tailwind theme 为准（`bg-surface`、`text-fg-secondary`、`border-line-subtle`、`rounded-card`、`h-control-md`、`z-dialog`、`shadow-elev-3` 等）。`bg-control` 为本方案登记的补充 token（= `#f4f4f5`，替代散落的 `bg-zinc-100`，见 §6.3 Q-A4-01）。

#### C1 · `components/ui/Button.tsx`

```ts
export type ButtonVariant = 'primary' | 'secondary' | 'tinted' | 'ghost' | 'destructive' | 'icon';
export type ButtonTone = 'brand' | 'success' | 'warning' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl'; // 32 / 36 / 40 / 48

export interface ButtonProps {
  variant?: ButtonVariant;          // 默认 'secondary'（避免误用主按钮）
  tone?: ButtonTone;                // 仅 tinted/destructive 有意义
  size?: ButtonSize;                // 默认 'md'
  loading?: boolean;
  loadingLabel?: string;            // loading 时保留原文案的替代文案（可选）
  disabled?: boolean;
  fullWidth?: boolean;
  iconOnly?: boolean;               // 必须给 ariaLabel
  ariaLabel?: string;
  iconLeft?: React.ReactNode;       // 16px 图标
  iconRight?: React.ReactNode;
  type?: 'button' | 'submit';
  onClick?: () => void;             // 不暴露 event（A2 C1）
  className?: string;               // 只允许布局覆盖
  testId?: string;
  children?: React.ReactNode;
}
export function Button(props: ButtonProps): JSX.Element;
export function IconButton(props: Omit<ButtonProps, 'variant'|'iconOnly'> & { ariaLabel: string }): JSX.Element;
```

| 项 | 规则 |
|---|---|
| 尺寸 | sm `h-control-sm rounded-control text-caption`；md `h-control-md rounded-control text-ui`；lg `h-control-lg rounded-control-lg text-ui`；xl `h-control-xl rounded-full text-ui`（仅欢迎/开始学习 hero） |
| 变体 | primary `bg-control text-fg-inverse hover:bg-white`；secondary `bg-surface-2/60 border-line-subtle text-fg-strong hover:bg-surface-3/60`；tinted `bg-{tone}/10 border-{tone}/20 text-{tone}-fg`；ghost `text-fg-secondary hover:bg-state-hover`；destructive `bg-danger/10 border-danger/20 text-danger-fg`；icon `p-2 text-fg-secondary` |
| 交互 | `transition-[background-color,border-color,color,transform] duration-200 ease-apple`；`active:scale-[0.98]`（icon 同）；**禁止 hover 缩放**；`focus-visible` 用全局环 |
| 状态 | disabled → `disabled + aria-disabled + opacity-50`；loading → 左 spinner 16 + `aria-busy` + 保留宽度（`min-w`）；不渲染 error/empty |
| 触屏 | `pointer: coarse` 下 icon 命中区 `min-h-11 min-w-11`（视觉 36 不变） |
| token | `bg-control`、`text-fg-inverse`、`bg-surface-2/60`、`surface-3`、`border-line-subtle`、`rounded-control` / `rounded-control-lg` / `rounded-full`、`h-control-*`、`danger/*`、`z` 无关 |

#### C2 · `components/ui/Card.tsx`

```ts
export type CardVariant = 'card' | 'panel' | 'interactive' | 'stat';
export interface CardProps {
  variant?: CardVariant; padding?: 'card' | 'panel' | 'row';
  title?: React.ReactNode; description?: React.ReactNode;
  icon?: LucideIcon; iconTone?: ButtonTone;
  footer?: React.ReactNode; loading?: boolean;
  href?: string; onClick?: () => void;      // 二者只能有一个
  className?: string; testId?: string; children?: React.ReactNode;
}
export function Card(props: CardProps): JSX.Element;

export interface ListRowProps {
  leading?: React.ReactNode; title: React.ReactNode; subtitle?: React.ReactNode;
  meta?: React.ReactNode; trailing?: React.ReactNode;
  href?: string; onClick?: () => void; className?: string; testId?: string;
}
export function ListRow(props: ListRowProps): JSX.Element;

export function IconTile(props: { icon: LucideIcon; tone?: ButtonTone; size?: 'sm'|'md'|'lg'; className?: string }): JSX.Element;
export function SectionHeader(props: { title: React.ReactNode; hint?: React.ReactNode; action?: React.ReactNode; id?: string }): JSX.Element;
export function OptionCard(props: { selected: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode; testId?: string; className?: string }): JSX.Element;
```

| 项 | 规则 |
|---|---|
| 材质 | card `bg-surface/40 border-line-subtle rounded-card`；panel `rounded-panel p-4 sm:p-6`（每页 ≤1）；interactive 加 `hover:border-line-strong hover:bg-surface/50`，整卡可点时用 `<button>/<a>` + 焦点环；stat 用于统计块 |
| 内边距 | card `p-4 sm:p-5`；panel `p-4 sm:p-6`；row `p-3` |
| ListRow | `p-3 rounded-control-lg bg-surface-2/30 border-line-subtle hover:bg-surface-2/60 hover:border-line-strong`；`:active` 不缩放 |
| IconTile | sm 36 / md 40 / lg 48；`rounded-control-lg`（sm/md）/`rounded-card`（lg）；`bg-{tone}/10 border-{tone}/20 text-{tone}-fg`；无 tone 用 `bg-surface-2/60 text-fg-secondary` |
| SectionHeader | 标题 `text-section font-semibold tracking-tight text-fg-primary` + hint `text-caption text-fg-secondary` + action 文字链 `text-caption text-brand-300` |
| OptionCard | 考试/理解题/定位/课程的选项卡：`w-full rounded-control-lg border px-4 py-3 text-left`；选中 `border-brand/40 bg-brand/10`；未选中 `border-line-subtle bg-surface-2/30 hover:bg-surface-2/60`；`role="radio" aria-checked`；**这一条是对 A2 的补充（Q-A4-02）** |
| 状态 | loading → Skeleton（标题 60%、正文 2 行，保持高度）；error → 卡内 ErrorPanel（不整卡替换）；empty → 卡内 EmptyState size=inline（py-3） |
| token | `bg-surface/40`、`border-line-subtle/strong`、`rounded-card/panel/control-lg`、`text-section/caption`、`bg-surface-2/30` |

#### C3 · `components/ui/Field.tsx`

```ts
export interface InputProps {
  value: string; onChange: (value: string) => void;
  label: string;                              // 必填（可见或 sr-only）
  placeholder?: string;
  variant?: 'default' | 'search' | 'hero' | 'textarea';
  size?: 'sm' | 'md' | 'lg';                  // 28/36/40
  error?: string; loading?: boolean; clearable?: boolean;
  onSubmit?: () => void; maxLength?: number;
  inputMode?: 'text'|'url'|'search'|'numeric'; type?: 'text'|'url'|'search';
  testId?: string; autoFocus?: boolean; disabled?: boolean;
  leadingIcon?: React.ReactNode; className?: string;
}
export function Input(props: InputProps): JSX.Element;
export function SearchField(props: Omit<InputProps,'variant'> & { onClear?: () => void }): JSX.Element;
```

| 项 | 规则 |
|---|---|
| 壳 | `bg-surface-2/60 border-line-subtle rounded-control-lg`；focus `focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/15`；字段本身 `outline-none`（仅在壳内允许） |
| 尺寸 | sm 32 / md 36 / lg 40；hero 为 `rounded-full p-1.5 h-control-xl`；移动端输入字号 ≥16px（防 iOS 放大） |
| 行为 | Enter 提交（`isComposing` 时忽略）；Esc 清空（clearable）；clear 按钮 44 命中；`aria-invalid` + `aria-describedby` |
| 状态 | default/hover/focus/disabled/loading/error；**不渲染 empty**（无结果由 EmptyState 承担） |
| token | `bg-surface-2/60`、`border-brand/60`、`ring-brand/15`、`h-control-*`、`rounded-control*`、`placeholder:text-fg-secondary` |

#### C4 · `components/ui/Dialog.tsx`

```ts
export interface DialogProps {
  open: boolean; onClose: () => void;
  title: string; description?: string;
  role?: 'dialog' | 'alertdialog';            // 阻断型用 alertdialog
  size?: 'sm' | 'md' | 'lg';                  // 448 / 576 / 896
  fullscreen?: boolean;                       // 登录门禁/首次引导；与 size/sheet 互斥
  sheet?: boolean;                            // <md 底部弹层
  closeOnBackdrop?: boolean; closeOnEsc?: boolean;  // 默认 true；alertdialog/busy 强制 false
  busy?: boolean;                             // 关闭全部退出路径
  loading?: boolean;                          // body skeleton + 页脚 loading
  error?: string | React.ReactNode;           // body 顶部 ErrorPanel，不关闭
  dirty?: boolean;                            // 关闭前放弃确认（IX-15）
  onBeforeClose?: () => boolean | Promise<boolean>;  // false = 取消关闭
  initialFocus?: 'first' | 'cancel' | React.RefObject<HTMLElement>;
  footer?: React.ReactNode; headerExtra?: React.ReactNode;
  children: React.ReactNode; testId?: string; ariaLabel?: string;
}
export function Dialog(props: DialogProps): JSX.Element | null;

export interface ConfirmDialogProps {
  open: boolean; title: string; body?: string;
  confirmLabel: string; cancelLabel: string;
  destructive?: boolean; busy?: boolean; error?: string;
  dirty?: boolean; onBeforeClose?: () => boolean | Promise<boolean>;
  onConfirm: () => void; onClose: () => void; testId?: string;
}
export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element | null;
```

| 项 | 规则（逐条可测，A3 IX-09 + A2 C4） |
|---|---|
| 结构 | `createPortal` → overlay `bg-overlay backdrop-blur-md z-overlay` → panel `role="dialog" aria-modal="true" aria-labelledby` + `bg-surface/90 backdrop-blur-2xl border-line-strong rounded-card shadow-elev-3 z-dialog` |
| 行为 | 打开：锁 `body` 滚动（记录 scrollTop）→ 焦点入 `initialFocus`（默认第一个可交互；Confirm 默认「取消」）→ `inert` 背景；Tab/Shift+Tab 循环；Esc/遮罩关闭（可配）；关闭：恢复滚动 + 焦点回触发元素 |
| 尺寸 | sm/md/lg + `max-h-[calc(100dvh-2rem)]`；sheet：`rounded-t-panel max-h-[90dvh]` + 底部 `env(safe-area-inset-bottom)` |
| 状态 | closed 不渲染 DOM；open → 焦点入面板/背景不可滚；busy → 除显式可取消外全部关闭路径禁用 + 主按钮 loading；loading → body Skeleton（标题保留）；error → body 顶部 ErrorPanel，不关闭；dirty → X/Esc/遮罩先弹放弃确认；fullscreen → `inset-0`、无模糊遮罩/圆角、内容区唯一滚动 |
| 关闭 | `onBeforeClose` 优先：返回 `false` 取消关闭；dirty 时由它发起「放弃未保存内容？」确认。`alertdialog`/busy 禁用 Esc/遮罩并显示「处理中」 |
| 禁止 | 嵌套 Dialog（二级确认先关再开，或同框切换）；`window.confirm/alert`；`z-[...]`；`autoFocus` 到危险按钮；`busy` 时仍可关闭 |
| token | `bg-overlay`、`bg-surface/90`、`border-line-strong`、`rounded-card/panel`、`shadow-elev-3`、`z-overlay/z-dialog`、`max-w-dialog-*` |

#### C5 · `components/ui/Tabs.tsx`

```ts
export interface TabItem {
  id: string; label: string;
  count?: number | null; disabled?: boolean; icon?: React.ReactNode;
  testId?: string; countTestId?: string;
}
export interface TabsProps {
  skin: 'nav' | 'panel';
  items: TabItem[]; value: string; onChange: (id: string) => void;
  layoutId: string; ariaLabel: string;
  overflow?: 'scroll' | 'menu';               // 单词本用 menu
  idPrefix?: string; testId?: string; className?: string;
}
export function Tabs(props: TabsProps): JSX.Element;
```

| 项 | 规则 |
|---|---|
| nav | 文字 tab + 选中 `text-fg-primary` + 2px `bg-brand` 下划线（`layoutId` 弹簧 420/36）；容器无底；不缩放 |
| panel | 容器 `rounded-control bg-surface-2/80 p-0.5 border-line-subtle`；选中白滑块 `bg-control text-fg-inverse` + `layoutId`；未选中 `text-fg-secondary` |
| a11y | `role=tablist/tab`、`aria-selected`、`aria-controls`（面板 id = `${idPrefix}-panel-${id}`）、方向键 + Home/End；计数 `aria-label` 带完整数字 |
| 状态 | disabled `opacity-40 aria-disabled + title`；count ↓null 不渲染 0；`overflow="menu"` 时移动端固定 2 tab + 「词表」菜单 |
| token | `rounded-control`、`bg-surface-2/80`、`bg-control`、`text-fg-*`、`bg-brand`、`text-micro` |

#### C6 · `components/ui/Segmented.tsx`

```ts
export interface SegmentedOption { value: string; label: string; icon?: React.ReactNode; testId?: string }
export interface SegmentedProps {
  options: SegmentedOption[]; value: string; onChange: (value: string) => void;
  layoutId: string; ariaLabel: string;
  size?: 'sm' | 'md';                          // 28 / 32
  disabled?: boolean; loadingValue?: string;
  testId?: string; className?: string;
}
export function Segmented(props: SegmentedProps): JSX.Element;
```

| 项 | 规则 |
|---|---|
| 容器 | `inline-flex rounded-control bg-surface-2/80 p-0.5 border-line-subtle` |
| 选项 | `px-2.5 py-1 text-caption`（sm）/ `px-3 py-1.5 text-ui`（md）；选中 `motion.span layoutId bg-control text-fg-inverse`；未选中 `text-fg-secondary hover:text-fg-primary` |
| a11y | `role=radiogroup` + `role=radio aria-checked`；左右键移动并选中；Tab 进出整组一次 |
| 状态 | disabled 整组；loadingValue 只对异步项加 spinner；error 组下方 13px `danger-fg`；无 empty；**2–5 项**（5 项仍为 Segmented，6 项起改用 Tabs/Menu） |
| token | `rounded-control`、`bg-surface-2/80`、`bg-control`、`text-caption/ui` |

#### C7 · `components/ui/Badge.tsx`

```ts
export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'highlight';
export function Badge(props: { tone?: BadgeTone; icon?: React.ReactNode; title?: string; testId?: string; children: React.ReactNode }): JSX.Element;
export function CountBadge(props: { count: number; max?: number; ariaLabel: string; size?: 'sm'|'md'; testId?: string }): JSX.Element | null;
export function Dot(props: { tone: BadgeTone; label: string }): JSX.Element;
```

| 项 | 规则 |
|---|---|
| Badge | `text-micro font-medium px-2 py-0.5 rounded-full` + tone 底/边/字；**≥11px**，禁止 9/10px；中文不 `uppercase` |
| CountBadge | `min-w-[18px] h-[18px] px-1 text-micro tabular-nums rounded-full`；`count<=0` 返回 null；`>max` → `${max}+`；必须有 `aria-label`（如「复习到期 12 个」） |
| tone | neutral `bg-surface-2/60 text-fg-strong border-line-subtle`；brand `bg-brand/10 text-brand-300 border-brand/20`；success/warning/danger 同法；highlight 仅 AI 高亮 |
| 状态 | Badge 静态不可点；CountBadge `count<=0` 不渲染、`>max` → `99+`；计数 loading/error 不渲染（不显示 0）；disabled Badge `opacity-40` + title 说明 |
| token | `text-micro`、`rounded-full`、`brand/success/warning/danger/highlight` |

#### C8 · `components/ui/Toast.tsx` + `lib/toast.ts`（扩展）

```ts
// lib/toast.ts（API 向后兼容：现有 toast.error(msg) 调用不改）
export interface ToastOptions { duration?: number; action?: { label: string; onClick: () => void }; dedupeKey?: string }
export const toast: {
  error(message: string, opts?: ToastOptions): void;
  success(message: string, opts?: ToastOptions): void;
  info(message: string, opts?: ToastOptions): void;
};
export function subscribeToToasts(fn: (item: ToastItem) => void): () => void;  // 保持
export async function describeApiError(resOrErr: unknown): Promise<string>;     // 保持
```

| 项 | 规则 |
|---|---|
| 视图 | desktop `fixed right-6 bottom-6 z-toast max-w-[28rem]`；mobile `left-4 right-4 bottom-safe-nav`；栈最多 3 条 |
| 生命周期 | success 3s / info 5s / error 8s；`hover`/`focus` 暂停；`action`/长错误保持到手动关闭；同 `type+message` 5s 去重（更新计时而非新增） |
| 状态 | `info / success / error` 三态；最多 3 条**可见**，第 4 条起 **FIFO 排队**（不丢旧条目）；重复 key 更新计时而非新增；不提供 loading toast（用按钮内 loading） |
| a11y | info/success `role=status aria-live=polite`；error `role=alert aria-live=assertive`；close `aria-label` + 44 命中；Esc 关闭当前条 |
| 离线标记 | 移到顶栏下方（`z-nav`），与 toast 分处上下（A3 IX-08 位置表） |
| token | `bg-surface/85`、`backdrop-blur-xl`、`shadow-elev-2`、`rounded-card`、`bottom-safe-nav`、`z-toast` |

#### C9 · `components/ui/Pagination.tsx`

```ts
export function paginationTokens(current: number, total: number): Array<number | 'ellipsis'>; // 由 VocabPagination 原样迁入
export interface PaginationProps {
  page: number; pages: number; hasMore?: boolean;
  onChange: (page: number) => void;
  summary: string;                       // 调用方 i18n
  scope: string;                         // test-id 前缀（vocab/phrase/recent/admin）
  testIds?: { prev?: string; next?: string; status?: string; page?: (n: number) => string };
  className?: string;
}
export function Pagination(props: PaginationProps): JSX.Element | null; // pages<=1 返回 null
```

| 项 | 规则 |
|---|---|
| 结构 | 状态文案 `text-caption text-fg-muted tabular-nums` + `‹ [1] [2] … [n] ›`；当前页 `bg-state-pressed text-fg-primary aria-current="page"`；其余 `text-fg-secondary hover:bg-state-hover` |
| 状态 | disabled（首页/末页）`opacity-40 pointer-events-none aria-disabled`；loading 锁点击；error 保留页码（列表区 ErrorPanel）；pages 0 不渲染 |
| 适配 | `hasMore` 服务端 offset 分页：`page = offset/PAGE_SIZE + 1`、`pages = ceil(total/PAGE_SIZE)`，由 Admin 调用方计算；组件不读网络 |
| token | `h-control-sm`、`rounded-control`、`text-caption`、`bg-state-pressed` |

#### C10 · `components/ui/StateView.tsx`

```ts
export function EmptyState(props: {
  icon?: LucideIcon; title: string; hint?: string;
  action?: { label: string; onClick: () => void };
  size?: 'page' | 'card' | 'inline'; testId?: string;
}): JSX.Element;

export function LoadingState(props: {
  kind?: 'spinner' | 'skeleton'; label?: string;
  minHeight?: number; rows?: number; testId?: string;
}): JSX.Element;

export function ErrorPanel(props: {
  level?: 'page' | 'card' | 'inline';
  title?: string; detail?: string;
  onRetry?: () => void; retryLabel?: string;
  secondary?: { label: string; onClick: () => void };
  testId?: string;
}): JSX.Element;

export function Skeleton(props: { lines?: number; className?: string }): JSX.Element;
```

| 项 | 规则 |
|---|---|
| EmptyState | `page` → `py-16`；`card` → `py-10`；`inline` → `py-3`（卡片内部/右栏内联，A3 IX-04）；icon 40 `text-zinc-700`；标题 14/500 `text-fg-strong`；hint 13/400 `text-fg-secondary`（**不是** zinc-600/500）；action ≤1；必须来自「成功且为空」分支 |
| LoadingState | `spinner` 14/16/24 三档；列表首屏用 `skeleton`（3 行，与真实行同高）；`aria-busy`；`minHeight` 防跳动；reduced-motion 下静态 |
| ErrorPanel | 三行：发生了什么（用户语言）→ 可怎么做 → 一个主操作；`role=alert`；`onRetry` 必填（可重试时）；`level=inline` 仅一行文字 + 重试 |
| 硬规则 | 失败**绝不**渲染 EmptyState；空态不得用虚线边框（可放置区例外：书架导入）；错误不重复出现在 toast + 面板 |
| token | `text-fg-*`、`bg-surface/40`、`rounded-card`、`text-danger-fg` |

#### C11 · NavShell（不新建文件）

| 文件 | 职责 | 本次改造 | token |
|---|---|---|---|
| `AppShell.tsx` | 桌面/手机壳、顶栏标题/副标、右侧控件 | 顶栏标题改 `text-ui/600` + 面包屑 11；`topbar-start` 换 `Button size=md`；`wordbookCount` 用 `formatCount`；`h-dvh` 由壳负责 | `bg-app/60`、`h-topbar`、`z-chrome`、`text-section` |
| `Sidebar.tsx` | ≥lg 侧栏 240/72、4 tab、快捷分组 | 徽章 → `CountBadge`；选中底 `bg-state-selected`；折叠 `aria-expanded` | `w-sidebar`、`bg-surface/40`、`z-chrome` |
| `TopBarTabs.tsx` | md–lg 文字 tab | 内部改用 `Tabs skin="nav"`；保留 `nav-tab-*` / `nav-practice-badge` testid | `h-control-md`、`text-ui` |
| `BottomBar.tsx` | <md 底栏 | 保留 icon+label 布局（Tabs nav 皮肤不适用）；徽章 → `CountBadge`；`h-bottombar + safe` | `bg-app/85`、`z-nav`、`text-micro` |

**状态**：选中态来自路由（`aria-current`），不由组件本地猜；计数 0 或请求失败都不渲染徽章（不显示占位 0）；侧栏折叠 `aria-expanded` 持久化；loading 不改变 tab 可用性。

#### C12 · `components/ui/PageHeader.tsx`

```ts
export function BackButton(props: {
  onBack: () => void; label?: string; parentLabel?: string;
  showLabel?: boolean;                  // 默认 true → ≥sm 显示文字
  testId?: string;
}): JSX.Element;

export function SubHeader(props: {
  title: string; onBack: () => void; backLabel?: string;
  meta?: React.ReactNode;               // 来源/等级徽章 ≤1
  actions?: React.ReactNode;            // ≤3 个 44 控件
  testId?: string; className?: string;
}): JSX.Element;

export function PageHeader(props: {
  title: string; subtitle?: string; actions?: React.ReactNode;
  className?: string; testId?: string;   // 渲染 h1，默认 lg:hidden
}): JSX.Element;
```

| 项 | 规则 |
|---|---|
| BackButton | `h-control-md px-2 -ml-2 rounded-control text-ui text-fg-strong hover:bg-state-hover hover:text-fg-primary`；icon 16；`aria-label = nav.backTo(parentLabel)`（无父级时 `nav.back`）；命中 ≥44；永不 disabled；页面级不出现 X |
| SubHeader | `<header>` `h-subheader px-3 sm:px-4 bg-app/60 backdrop-blur-xl border-b border-line-subtle z-chrome`；不换行；标题 `text-section truncate`；返回是第一个 Tab 停靠点 |
| PageHeader | `h1 text-page md:text-page-lg text-fg-primary` + `text-ui text-fg-secondary`；`lg:hidden`；同一视口只有一个 h1 |
| 禁止 | 页面级 X 与 ← 并存；`h-7/h-8`；头部 `flex-wrap`；子视图 24px 标题 |
| token | `h-subheader`、`bg-app/60`、`z-chrome`、`text-section`、`text-page(-lg)` |

#### C13 · `components/ui/WordCard.tsx` + `components/ui/WordHighlight.tsx`

```ts
export function WordCard(props: {
  target: WordLookupTarget;             // word/context/start/x/y/source*
  onClose: () => void;
  onRetarget: (t: WordLookupTarget) => void;
  onToggleFavorite: (def: WordDefinition) => void;
  isFavorited: boolean;
}): JSX.Element;

export type WordHitMode = 'word' | 'chunk';
export function ClickableWords(props: {
  text: string; onWordClick: WordClickHandler; isHighlighted?: (word: string) => boolean;
}): JSX.Element;
export function WordHighlight(props: {
  text: string; mode?: WordHitMode;
  highlights?: Array<{ word: string; annotation?: string; color?: string }>;
  onWordClick?: WordClickHandler;
  isHighlighted?: (word: string) => boolean;
  className?: string;
}): JSX.Element;
```

| 项 | 规则 |
|---|---|
| 词卡定位 | `computeWordCardPosition({x,y,width:320,height,viewport})`：`left = clamp(12, x-w/2, innerWidth-w-12)`；下方不足则上方翻转（`bottom = innerHeight-y+24`）；`maxHeight` 由可用空间算；**必须夹取**（I-15） |
| 词卡行为 | 非模态：不锁滚动；`role="dialog" aria-modal="false" aria-label={word}`；Esc/点空白/关闭按钮关闭；**仅键盘打开时**焦点入卡、关闭回触发词（鼠标/触屏不抢焦点）；打开时点击/键盘点另一词直接切词（旧请求 abort）；hover 不切词 |
| 词卡层级 | overlay `z-overlay`（点击层）+ card `z-popover`；`w-80 bg-surface/85 shadow-elev-2 rounded-card` |
| ruby | **只保留一套** `<ruby>词<rt>注</rt></ruby>`；`rt text-micro`；AI 词 `text-highlight-fg`，普通注释 `text-fg-secondary`；不得出现 `purple-300/90` / `zinc-400/90` 两套 |
| 可点范围 | `mode='word'` 字幕/阅读；`mode='chunk'` 句子精背（整块可点 + `font-semibold`）；阅读高亮用琥珀下划线（保留 `data-highlight`） |
| 键盘 | 每句一个 `role=group`；句内**一个** `tabindex=0` 的 roving 词；左右键移动、Enter 打开；`data-word-hit` / `data-lookup-context` / `data-lookup-start` 属性**必须原样保留**（脚本依赖） |
| 触屏 | 收藏星/操作常显（`pointer: coarse`）；不依赖 hover（I-16） |
| 状态 | 词卡 `closed → loading → ready / error`；切词时 loading 替换内容不关闭；无释义显示「未找到释义」+ 重试；收藏态 `favorited` 独立（乐观 + 失败回滚） |
| token | `bg-surface/85`、`shadow-elev-2`、`rounded-card`、`z-overlay/z-popover`、`text-highlight-fg` |

#### C14 · `components/ui/VocabRow.tsx`

```ts
export function VocabRow(props: {
  word: string; phonetic?: string; definition: string; level: string;
  source: { label: string; onOpen?: () => void; canOpen: boolean };
  createdAt?: number; expanded?: boolean; onToggle?: () => void;
  onRemove?: () => void; onSpeak?: () => void;
  layout: 'row' | 'table'; testIdPrefix?: string;
}): JSX.Element;

export function VocabTabStrip(props: {
  tabs: TabItem[]; value: string; onChange: (id: string) => void;
  catalog?: { label: string; onSelect: () => void }[];   // 移动端「词表」菜单
  ariaLabel: string; testId?: string;
}): JSX.Element;
```

| 项 | 规则 |
|---|---|
| VocabRow | 桌面列：词 14/600 + CEFR Badge + 释义 14（2 行截断）+ 来源 13（可点 `text-brand-300`；不可点 `text-fg-muted`「出处未知」）+ 时间 11 tabular + 操作 44；移动卡片：词 17/600 + Badge + 释义 + 来源 + 时间 + 操作 |
| 来源 | `canOpen=false` 时**不可点**并说明「出处未知」（I-12 数据缺陷的 UI 兜底）；句子包 `source.ref='L<levelId>'` 必须可回跳 |
| VocabTabStrip | 移动端固定「我的/短语」+「词表」菜单（C2 禁用 + 说明）；桌面完整 tab 可换行；选中项 `scrollIntoView({inline:'nearest'})`；计数用 CountBadge |
| 状态 | loading 行高不变；error 来源列降级；空列表交给 EmptyState（「去内容页存词」） |
| token | `bg-surface-2/30`、`border-line-subtle`、`text-ui/caption/micro`、`rounded-control-lg` |

#### C15 · `components/ui/Progress.tsx`

```ts
export function Progress(props: {
  value: number; max?: number; tone?: 'brand' | 'success';
  label: string;            // 读屏名称
  testId?: string; className?: string;   // 高度固定 1.5px，不暴露
}): JSX.Element | null;      // max<=0 返回 null

export function StepControls(props: {
  step: number; total: number;
  onNext?: () => void; onPrev?: () => void;
  nextLabel?: string; prevLabel?: string; canNext?: boolean; nextDisabledReason?: string;
  loading?: boolean; error?: string; sticky?: boolean;
  testId?: string;
}): JSX.Element;
```

| 项 | 规则 |
|---|---|
| Progress | `role=progressbar aria-valuemin=0 aria-valuemax aria-valuenow`；轨道 `bg-white/5`；填充 `bg-brand`（进行中）/`bg-success`（完成）；高 1.5px；单色无渐变；不因 error 变红 |
| StepControls | 底部动作条 `sticky`（不用 fixed）+ safe-area；上一步第一步隐藏；未满足条件 disabled + 原因文案；loading 锁双按钮 |
| 禁止 | 渐变进度；1px 轨道；把步骤叫分页；`VocabAxis` 这类非进度可视化套用 Progress |
| token | `bg-white/5`、`bg-brand/success`、`h-control-lg`、`rounded-full` |

#### 其余导出

| 文件 | 导出 | 说明 |
|---|---|---|
| `ui/Badge.tsx` | `Dot` | 在线/离线等极简状态，必须有 `aria-label` |
| `lib/toast.ts` | `toast`、`subscribeToToasts`、`describeApiError` | 保持现有调用方式，仅扩展 options |
| `lib/favoriteSource.ts` | `resolveFavoriteSource` | **保留原文件**（A2 §18 写作 `lib/vocabulary.ts`，实际不存在，见 §6.3 Q-A4-03）；补 `sentence_pack` 可回跳与 `source_ref` 空规则 |

### 2.3 共享 lib 契约（C-08/C-09/C-03 的落点）

| 文件 | 导出 | 契约 | 替代 |
|---|---|---|---|
| `lib/cn.ts` | `cn(...inputs: ClassValue[]): string` | clsx + twMerge；所有 `ui/*` 与业务组件统一 import | `TranscriptBlock.tsx:11` |
| `lib/time.ts` | `formatClock(seconds): string` | `mm:ss`；`≥1h` → `h:mm:ss`；`NaN/负` → `00:00` | `App:158`、`ReportScreen:81`、`QuizScreen:39`、`TranscriptBlock:137`、`LocalEpisodeStage:32`、`TeachingNotesPanel:30` |
| | `formatCountdown(ms): string` | 与 `formatClock` 同规则（`ceil` 到秒），供倒计时 | `CourseScreen:82`、`PlacementScreen:105` |
| | `formatDuration(seconds): string` | 推荐卡「12 分钟」等标签；`<60s` 显示 `1 分钟` | `lib/recommend.ts:75`、`App:1611` |
| `lib/format.ts` | `formatCount(n, max=99): string` | `>99 → '99+'`；`0 → '0'`（是否显示由组件决定） | `AppShell:189`、`LearningHeader:71` |
| | `formatDueBadge(n): string` | 别名 `formatCount`，保留旧导出名一版 | `lib/navTabs.ts:33-35` |
| `lib/reading-layout.ts` | `bilingualReadingWidth(twoColumn): string` | `twoColumn ? 'max-w-library' : 'max-w-reading'`；返回 token 类名 | `BilingualRow.tsx:16` |
| `lib/word-lookup.ts` | `WordLookupSource`、`WordLookupHandler`、`createWordLookup(source)`、`getLookupSourceKind(target)` | 工厂返回 `(word, context, start, e) => void`；`sentence_pack` 强制 `ref: L1–L5`；类型与 App 现有 `FavoriteSourceKind` 对齐 | `App.tsx:288-368` 5 份 |
| `lib/word-card-position.ts` | `computeWordCardPosition(input): {left, top, maxHeight, placement}` | 纯函数，可单测；边界夹取 + 上下翻转 | `WordPopover.tsx:55-64`、`:200-220` |

### 2.4 命名与导入约束

1. 业务组件只能 `import { X } from './ui/X'` 或 `from '../lib/x'`；**禁止**从另一个业务组件 import 共享函数（唯一过渡例外：`TranscriptBlock` 在 B5 前 re-export `ClickableWords`/`cn` 旧名）。
2. `className` 只允许布局覆盖（宽、外边距、对齐）；颜色/圆角/字号/阴影由组件的 `variant/size/tone` 决定（A2 §1.1-4）。
3. 组件不读路由/auth；`BackButton`/`Dialog.onClose`/`Tabs.onChange` 由调用方注入行为；A3 的 history 语义只在 App 层。
4. 组件内文案只允许两类：调用方传入的字符串/ReactNode；通用 i18n 键（`common.close`、`common.retry`、`common.cancel`）。**不允许**组件硬编码业务文案。
5. 所有可交互元素必须有可见焦点；禁止组件级 `focus:ring-*` / `focus:outline-none`（输入壳例外）。

### 2.5 不新建 / 不合并的裁决

| 议题 | 裁决 | 理由 |
|---|---|---|
| NavShell 是否新建 `ui/NavShell.tsx` | **不新建**，改造现有 `AppShell/Sidebar/TopBarTabs/BottomBar` | A2 C11 也只要求收敛尺寸/状态/徽章；重写壳会把「组件收敛」变成「导航重构」，与 A3 实施窗口冲突 |
| 分享卡（C-14）是否合并 | **不合并**（G21 保留 + 共用 Dialog/Button） | Canvas 生成与选区浮层生命周期不同；合并是功能重构，留上线后 |
| `OPTION_BASE` 是否建组件 | **建 `OptionCard`**（`ui/Card.tsx` 的一个导出） | 4 个页面的选项卡同构且高频；不建则这 4 份常量无法归属 |
| filter chip（免费库等级/短语筛选） | **不抽组件**，保留本地 `filterChip`/inline，B4 只换 token | A2 无 Chip 契约；临时抽象会与 Segmented 语义重叠；A5 记为候选 |
| `VocabAxis` 彩虹轴 | **不套 Progress**，只按 V-07 换单色（B5） | 它是「能力轴」不是进度；套 Progress 会误导 |
| `ui/index.ts` barrel | **不建** | 无路径别名；barrel 增大耦合与 HMR 面积 |

---

## 3. 完整映射表

> 列定义固定：`ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖（A2 token / A3 交互） | 优先级 | 预估（人日） | 验证`。
> `T§`=`tokens.md`，`C§`=`components.md`，`L§`=`layout.md`；`IX-xx`/`NM-xx`=A3 两份规范。验证代号见 §0.4。
> **每行都必须有归属**：不存在「其它/待定」；无法收敛的行写「保留」并给理由。

### G0 · i18n P0 例外（A1 V-06，门禁 1 指定 A4 迁移）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G0-01 | `i18n/zh-CN.json` `home.loading.loading/processing/asr`、`home.loading.processingHint/asrHint`、`home.analyzing`、`home.analyzingHint` | 无组件（文案） | 替换：中文改写；vi-VN 同步；`processingHint` 保留「翻译会流式出现」的说明 | A1 V-06；A3 IX-03 | **P0** | 0.1 | V2 |
| G0-02 | `zh-CN.json` `estimate.title/subtitle/words/tokens/confirm` | 文案 | 替换：中文改写（标题/按钮不再同词）；金额与词数字段用 tabular-nums 不受影响 | V-06；C4 页脚 | **P0** | 0.1 | V2 |
| G0-03 | `zh-CN.json` `shows.empty/emptyHint/back/pickSeason` | 文案 | 替换：中文改写；`emptyHint` 删除「把 .srt 放进 subtitles/」的开发者说明，改为用户动作（设置/免费资源） | V-06；L§7.3 | **P0** | 0.1 | V2 |
| G0-04 | `zh-CN.json` `topbar.popOut/closePopOut/logoAlt`、`common.unknownVideo/unknownChannel/noThumbnail`、`home.deletedToast` | 文案 | 替换：中文改写（aria 也算，读屏会读） | V-06 | **P0** | 0.1 | V2 |
| G0-05 | `zh-CN.json` `common.cancel` | 文案 | 替换：`取消`；Dialog/ConfirmDialog 默认页脚复用 | V-06；C4 | **P0** | 0.1 | V2 |
| G0-06 | `zh-CN.json` `home.removeHistoryTitle` "Remove from Continue Learning"（`RecentLearning.tsx`） | 文案 | 替换：中文改写；与 G4-01 的 ConfirmDialog 标题统一 | V-06；IX-24 | **P0** | 0.1 | V2 |
| G0-07 | `zh-CN.json` `home.deleteConfirm` "Remove \"{{title}}\" from Continue Learning?"（`TodayScreen.tsx:145`） | 文案 | 替换：中文改写；`window.confirm` 随 G4-01 迁移 | V-06；IX-24 | **P0** | 0.1 | V2 |
| G0-08 | `zh-CN.json` `home.noUploads` "No new uploads yet"（`ContentScreen.tsx`） | 文案 | 替换：中文改写；只用于成功且为空的订阅空态 | V-06；IX-04 | **P0** | 0.1 | V2 |
| G0-09 | `zh-CN.json` `common.localFile` "Local File"（`RecentLearning.tsx`、`TodayWorkbench.tsx`） | 文案 | 替换：中文改写 | V-06 | **P0** | 0.1 | V2 |
| G0-10 | `zh-CN.json` `shows.season` "Season {{number}}"（`ShowBrowser.tsx:163`） | 文案 | 替换：中文改写；占位符保持一致 | V-06 | **P0** | 0.1 | V2 |
| G0-11 | `zh-CN.json` `shows.episodesShort` "({{count}} ep)"（`ShowBrowser.tsx`） | 文案 | 替换：中文改写；`vi-VN` 同步 | V-06 | **P0** | 0.1 | V2 |
| G0-12 | `zh-CN.json` `shows.seasonsEpisodes` "{{seasons}} seasons · {{episodes}} episodes"（`ShowBrowser.tsx`） | 文案 | 替换：中文改写；`tabular-nums` 不受影响 | V-06 | **P0** | 0.1 | V2 |

> **`sentences.day` 裁决（W0）**：`SentenceView.tsx:197` 渲染的 "Day {{day}}" 属**用户可见英文**，裁决为 **W2 同批中文化（第 32 条）**；它**不计入 31 键清单**，但 CI 的 CJK 规则**不把它列入白名单**，因此 W2 出口必须同时改它，否则规则仍红。G0 的 7 个新增键可与 W2 合并执行（同一 i18n 文件，避免双改）。

### G1 · 按钮常量（A1 C-01 / A2 C1）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G1-01 | `AccountScreen.tsx:87/89` `PRIMARY_BUTTON`/`SECONDARY_BUTTON` | Button primary/lg + secondary/md | 替换；常量删除 | T§4.2/§5；C§C1 | P1 | 0.25 | V3 |
| G1-02 | `ReviewScreen.tsx:106/108` PRIMARY(h-11)/SECONDARY(h-10) | Button primary/lg + secondary/lg | 替换；常量删除；h-11→40 记录视觉差异 | T§4.2；C§C1 | P1 | 0.25 | V3 |
| G1-03 | `AdminConsoleScreen.tsx:90/92/94/96/98` PRIMARY/SECONDARY/COMPACT/DANGER/SUCCESS | Button（primary lg / secondary md / ghost sm / destructive md / tinted success） | 替换；5 个常量删除 | T§2.2/§4.2；C§C1 | P1 | 0.5 | V3 |
| G1-04 | `VocabularyBookScreen.tsx:138/140` SECONDARY(h-9)/DANGER(h-8) | Button secondary/md + destructive/sm | 替换；常量删除 | C§C1；T§4.2 | P1 | 0.25 | V3 |
| G1-05 | `BlogScreen.tsx:43/45` SECONDARY/TINTED | Button secondary/md + tinted brand/md | 替换；常量删除；`blue-*`→`brand-*` | T§2.2；C§C1 | P1 | 0.25 | V3 |
| G1-06 | `PlacementScreen.tsx:69/71/73` PRIMARY(h-11)/SECONDARY(h-11)/GHOST(h-11) | Button primary/lg + secondary/lg + ghost/lg | 替换；常量删除；h-11→40 | C§C1；T§4.2 | P1 | 0.25 | V3 |
| G1-07 | `ReportScreen.tsx:74` SECONDARY | Button secondary/md | 替换；常量删除 | C§C1 | P1 | 0.1 | V3 |
| G1-08 | `QuizScreen.tsx:34` PRIMARY(h-11) | Button primary/lg | 替换；常量删除 | C§C1 | P1 | 0.1 | V3 |
| G1-09 | `WelcomeScreen.tsx:42/45` PRIMARY_CTA/SECONDARY_CTA(h-12 rounded-full) | Button primary/xl + secondary/xl | 替换；常量删除（xl 是唯一允许 rounded-full 的主按钮） | C§C1；T§5 | P1 | 0.25 | V3 |
| G1-10 | `ExamScreen.tsx:85/87/89` PRIMARY/SECONDARY/GHOST(h-10) | Button primary/lg + secondary/lg + ghost/lg | 替换；常量删除 | C§C1 | P1 | 0.25 | V3 |
| G1-11 | `AbilityScreen.tsx:67/69/71` PRIMARY/SECONDARY(h-9)/GHOST(h-9) | Button primary/lg + secondary/md + ghost/md | 替换；常量删除 | C§C1 | P1 | 0.25 | V3 |
| G1-12 | `CourseScreen.tsx:74/76` PRIMARY `h-10 sm:h-11`/SECONDARY | Button primary/lg（lg 固定 40，不再响应式变高） | 替换；常量删除 | C§C1；T§4.2 | P1 | 0.25 | V3 |
| G1-13 | `ShareCardDialog.tsx:43/45` `primaryButton`/`secondaryButton` | Button primary/lg + secondary/lg | 替换；常量删除 | C§C1；IX-27 | P1 | 0.15 | V3 |
| G1-14 | `ReaderScreen.tsx:144/146/148` `primaryButton`/`secondaryButton`/`tintedButton` | Button primary/lg + secondary/md + tinted brand/md | 替换；常量删除 | C§C1；T§2.2 | P1 | 0.25 | V3 |
| G1-15 | `PwaInstallButton.tsx:124` 内联主按钮 | Button primary/lg | 替换 | C§C1；C4 Dialog 页脚 | P1 | 0.1 | V3 |
| G1-16 | `ModelSelectionModal.tsx:178/183` 内联 ghost + primary | Button ghost/md + primary/lg（Dialog 页脚） | 替换（随 G3-01） | C§C1；C§C4 | P1 | 0.15 | V4 |
| G1-17 | `StartLearning.tsx:199` 内联提交按钮（rounded-full h-9） | Button primary/md（hero 场景用 size=md + `rounded-control`） | 替换；保留 `start-submit` testid | C§C1；I-17 | P1 | 0.15 | V3 |
| G1-18 | `AuthScreen.tsx:252` 内联提交按钮 | Button primary/lg fullWidth | 替换 | C§C1；IX-26 | P1 | 0.15 | V3 |
| G1-19 | `DiscoverScreen.tsx:306` 内联提交按钮 | Button primary/md | 替换；保留 `discover-submit` | C§C1 | P1 | 0.15 | V3 |
| G1-20 | `AppShell.tsx:166-180` `topbar-start` 内联主按钮 | Button primary/md | 替换；保留 `topbar-start` | C§C1；C11 | P1 | 0.15 | V3 |
| G1-21 | `TodayWorkbench.tsx:71/73` `ACTION`/`ENTRY_ACTION` | Button（primary/secondary/ghost 由调用处传；ACTION 不再自带颜色） | 替换；常量删除；三卡动作统一 | C§C1；L§5.1 | P1 | 0.25 | V3 |
| G1-22 | `PracticeScreen.tsx:16` `ACTION` | Button primary/lg | 替换；常量删除 | C§C1；L§5.3 | P1 | 0.15 | V3 |
| G1-23 | `NovelCourseCard.tsx:20` `ENTRY_ACTION` | Button secondary/md | 替换；常量删除 | C§C1 | P1 | 0.1 | V3 |
| G1-24 | `PlacementScreen.tsx:76`、`QuizScreen.tsx:36`、`ExamScreen.tsx:92`、`CourseScreen.tsx:79` `OPTION_BASE` | `OptionCard` | 替换；4 份常量删除；`role=radio` + `aria-checked`；保留各页选项 testid | C§C2（补充 Q-A4-02）；A3 IX-19 | P1 | 0.5 | V4 |
| G1-25 | `StartLearning.tsx:162` compact 形态的提交按钮（h-8 px-3 rounded-lg） | Button primary/sm（compact 用 `size=sm`） | 替换；保留 `start-submit`/`start-compact-submit` testid；主/紧凑两种形态同一组件 | C§C1；L§5.1 | P1 | 0.15 | V3 |
| G1-26 | `PlacementScreen.tsx:975` 游客提示内登录按钮（h-9 px-3 rounded-lg） | Button secondary/md | 替换；保留 `placement-guest-login` | C§C1；IX-17 | P1 | 0.1 | V3 |
| G1-27 | `PlacementScreen.tsx:1245` 画像区游客登录按钮（h-9 px-3 rounded-lg） | Button secondary/md | 替换；保留 `placement-profile-guest` 内的登录入口 | C§C1；IX-17 | P1 | 0.1 | V3 |

### G2 · 卡片 / 图标块 / 区块标题（A1 C-01/C-11 / A2 C2）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G2-01 | `VocabularyBookScreen.tsx:142` `CARD`(rounded-2xl) | Card card | 替换；常量删除；列表容器不再自带 `rounded-2xl` | C§C2；T§5 | P1 | 0.15 | V3 |
| G2-02 | `PlacementScreen.tsx:75` `CARD`(rounded-3xl) | Card（主任务卡 panel；其余 card） | 替换；常量删除；主卡 ≤1 panel | C§C2；L§5.3 | P1 | 0.25 | V3 |
| G2-03 | `ReportScreen.tsx:73` `CARD`(rounded-3xl) | Card card | 替换；圆角 24→16 | C§C2；T§5 | P1 | 0.15 | V3 |
| G2-04 | `WelcomeScreen.tsx:38/46` `CARD`/`CARD_ICON` | Card card + IconTile sm | 替换；营销页保留玻璃装饰仅在 hero | C§C2；T§2.4 | P2 | 0.25 | V3 |
| G2-05 | `ExamScreen.tsx:91` `CARD`(`rounded-2xl sm:rounded-3xl`) | Card card | 替换；删除响应式变档（V-09） | C§C2；T§5 | P1 | 0.15 | V3 |
| G2-06 | `AbilityScreen.tsx:65` `CARD`(rounded-3xl) | Card card | 替换 | C§C2 | P1 | 0.15 | V3 |
| G2-07 | `TodayWorkbench.tsx:68/69` `CARD`/`CARD_ICON` | Card card + IconTile md | 替换；三卡同构 | C§C2；L§5.1 | P1 | 0.25 | V3 |
| G2-08 | `PracticeScreen.tsx:15` `CARD`(p-4 sm:p-5) | Card（复习主卡 panel；三卡 card） | 替换；主卡与另三卡区分 | C§C2；L§5.3 | P1 | 0.25 | V3 |
| G2-09 | `CourseScreen.tsx:78` `CARD`(`rounded-2xl sm:rounded-3xl`) | Card card | 替换；删除响应式变档 | C§C2；T§5 | P1 | 0.15 | V3 |
| G2-10 | `LibrarySection.tsx:47` `CARD`(w-[196px] 横向卡) | Card interactive（宽度用 className 布局覆盖） | 替换；横向滚动卡保留 snap | C§C2 | P1 | 0.25 | V2 |
| G2-11 | `BooksSection.tsx:34` `CARD`(w-[220px]) | Card interactive | 替换 | C§C2 | P1 | 0.15 | V2 |
| G2-12 | `HomeRecommendations.tsx:21` `CARD`(w-[168px]) | Card interactive | 替换；删除 hover 位移 | C§C2；T§9 | P2 | 0.15 | V2 |
| G2-13 | `ImportedBooksShelf.tsx:25` `CARD`(w-[220px]) | Card interactive | 替换 | C§C2 | P2 | 0.15 | V2 |
| G2-14 | `ContentScreen.tsx:38` `SECTION_TITLE`（`text-[17px]`） | SectionHeader | 替换；5 种区块标题收敛 17px | C§C2；L§4.2 | P1 | 0.25 | V3 |
| G2-15 | 61 处内联卡片字面量（清单见附录 A；含 InputScreen 5 处随 G18 删除，**B4 实迁 56**） | Card / ListRow | 替换；按文件分组脚本化替换，逐文件 review；**不做全仓 sed** | C§C2；T§2.4/§5 | P1 | 1.5 | V3 |
| G2-16 | `TodayWorkbench.tsx:69`（32px）与 `WelcomeScreen.tsx:46`（36px）的 `CARD_ICON` 尺寸两档 | IconTile | 替换：尺寸只允许 36/40/48，同一屏同角色必须同尺寸；与 G2-04/G2-07 的组件替换同一批完成 | C§C2；V-18 | P2 | 0.1 | V2 |
| G2-17 | 卡片圆角混排（`rounded-2xl` 40 处 / `rounded-3xl` 21 处，A1 V-09） | Card token（rounded-card） | 替换：普通卡片统一 16px；`rounded-panel` 仅主面板 | T§5；C§C2 | P1 | 0（随 G2-15） | V3 |

### G3 · 弹窗壳（A1 C-02/I-02/I-03/I-04 / A2 C4）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G3-01 | `ModelSelectionModal.tsx:53-60` 壳（无 role/Esc/portal） | Dialog size=md | 替换整壳；页脚 Button ghost+primary；保留 `estimate-modal` testid | C§C4；IX-09 | P1 | 0.5 | V4 |
| G3-02 | `EstimateDialog.tsx:86-105` 阻断遮罩（无 role/aria-busy） | Dialog busy（不可关闭）+ LoadingState | 替换；估价失败改为「仍要开始？」ConfirmDialog（IX-12） | C§C4/C10；IX-03/IX-12 | P1 | 0.25 | V3 |
| G3-03 | `LanguageSettingsModal.tsx:98-140`（z-[70]） | Dialog size=sm | 替换；层级 `z-[70]`→`z-dialog` | C§C4；T§7 | P1 | 0.25 | V4 |
| G3-04 | `BookImportDialog.tsx:122-140`（`max-h-[calc(100dvh-24px)]`） | Dialog size=md | 替换；改用 `max-h-[calc(100dvh-2rem)]` + sheet；保留 `book-import-dialog` | C§C4；T§10.3 | P1 | 0.5 | V4 |
| G3-05 | `ShareCardDialog.tsx:195-215`（z-[100]） | Dialog size=md | 包裹：壳换 Dialog，Canvas/复制逻辑保留；保留 `share-card-dialog`/`share-card-close` | C§C4；IX-27 | P1 | 0.5 | V3 |
| G3-06 | `ChannelVideoList.tsx:68-90`（P0：无 role/Esc/遮罩关闭） | Dialog size=lg | 替换；补 role/aria-modal/Esc/遮罩/焦点 | C§C4；IX-09；A1 I-02 | **P0** | 0.5 | V4 |
| G3-07 | `AbilityScreen.tsx:250-300` 自评 sheet | Dialog sheet | 替换；保留 `ability-self-assess-sheet` | C§C4 | P1 | 0.5 | V4 |
| G3-08 | `AbilityScreen.tsx:476-500` 证据抽屉 | Dialog sheet | 替换；保留 `ability-evidence-drawer` | C§C4 | P1 | 0.5 | V4 |
| G3-09 | `ExamScreen.tsx:1233-1250` 退出确认 | ConfirmDialog | 替换 | C§C4；IX-24 | P1 | 0.25 | V4 |
| G3-10 | `PlacementScreen.tsx:1400-1415` 重启确认 | ConfirmDialog | 替换 | C§C4；IX-24 | P1 | 0.25 | V4 |
| G3-11 | `AdminConsoleScreen.tsx:282-350` 内联 DialogShell | Dialog + ConfirmDialog | 替换：删除内联壳；调额/封禁改 ConfirmDialog + 表单 Dialog | C§C4；IX-25 | P1 | 0.75 | V4 |
| G3-12 | `PwaInstallButton.tsx:62-95`（z-[120]） | Dialog size=sm | 替换；模态不再用 `z-toast` | C§C4；T§7 | P1 | 0.25 | V4 |
| G3-13 | `App.tsx:3387` `ProcessingOverlay`（无 role） | Dialog busy（阻断） | 替换；补 `role=alertdialog`/`aria-busy`；文案随 G0-01 | C§C4；IX-03 | P1 | 0.25 | V3 |
| G3-14 | `App.tsx:3522` `guest-auth-overlay`（全屏 div） | Dialog fullscreen sheet + AuthScreen | 替换；登录成功消费 pendingRoute（A3 NM-08） | C§C4；IX-26；NM-08 | P1 | 0.5 | V4 |

### G4 · 危险操作确认（A1 I-05 / A2 C4 / A3 IX-24）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G4-01 | `TodayScreen.tsx:145` `window.confirm(home.deleteConfirm)` | ConfirmDialog | 替换；标题「删除这条学习记录？」+ 后果 + 动词按钮；失败保留条目 + toast | C§C4；IX-24 | P1 | 0.25 | V4 |
| G4-02 | `ReaderScreen.tsx:644` `window.confirm(reader.deleteConfirm)` | ConfirmDialog | 替换；删除后列表移除 | C§C4；IX-24 | P1 | 0.25 | V4 |
| G4-03 | `ImportedBookReaderScreen.tsx:365` `window.confirm(...)` | ConfirmDialog | 替换 | C§C4；IX-24 | P1 | 0.25 | V4 |
| G4-04 | `InputScreen.tsx:115` `window.confirm(home.deleteConfirm)` | （无） | 删除：随 G18 整文件删除，不迁移 | C§C10；A1 C-10 | P2 | 0.1 | V1 |

### G5 · Toast / 通知（A1 I-10 / A2 C8 / A3 IX-08）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G5-01 | `Toaster.tsx:6/27/28/37` 固定 6s、`bottom-6`、`z-[100]` | Toaster（重写） | 替换：位置/时长/上限/去重/暂停/ARIA；保留 `toast.*` 调用方式 | C§C8；IX-08；T§7 | P1 | 0.5 | V4 |
| G5-02 | `lib/toast.ts:16-25` 无去重/上限/暂停/action | `lib/toast.ts` 扩展 | 包裹：`toast.*` 增加可选 `ToastOptions`；现有调用零改动 | C§C8；IX-08 | P1 | 0.5 | V1 |
| G5-03 | `OfflineIndicator.tsx:20-24` 底部 `z-[95]` 与 toast 同区 | 离线标记（保留组件） | 替换位置：移到顶栏下方 `z-nav`；`role=status` | C§C8；IX-08；T§7 | P1 | 0.25 | V3 |

### G6 · 点词 handler（A1 C-03/I-12 / A3 IX-21）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G6-01 | `App.tsx:288-293` `handleWordLookup`（字幕） | `lib/word-lookup.ts` `createWordLookup` | 替换：工厂实现 + 5 处调用统一；删除 5 份 useCallback | A1 C-03/I-12；IX-21 | P1 | 0.25 | V2 |
| G6-02 | `App.tsx:295-314` `handleReaderWordLookup` | `createWordLookup({kind:'article',ref:articleId})` | 替换 | IX-21 | P1 | 0.1 | V2 |
| G6-03 | `App.tsx:316-334` `handleLibraryArticleWordLookup` | `createWordLookup({kind:'library_article',ref:itemId})` | 替换 | IX-21 | P1 | 0.1 | V2 |
| G6-04 | `App.tsx:336-351` `handleBookWordLookup` | `createWordLookup({kind:'book',ref:bookId})` | 替换 | IX-21 | P1 | 0.1 | V2 |
| G6-05 | `App.tsx:353-368` `handleImportedBookWordLookup` | `createWordLookup({kind:'imported_book',ref:bookId})` | 替换 | IX-21 | P1 | 0.1 | V2 |
| G6-06 | `App.tsx:3158-3167` `SentenceView onWordLookup={handleWordLookup}`（**来源丢失**） | `createWordLookup({ kind: 'sentence_pack', ref: 'L' + levelId })` | 替换：传 typed source；`source_ref` 必须为 `L1–L5` | A1 I-12；IX-21/IX-22 | P1 | 0.25 | V2 |
| G6-07 | `App.tsx:910-916` `currentSourceFields`、`:958-980` `lookupSourceKind` 分支 | `lib/word-lookup.ts` `getLookupSourceKind` | 替换：来源判定单一来源；字幕用当前视频兜底 | IX-21 | P1 | 0.25 | V1 |
| G6-08 | `lib/favoriteSource.ts` `resolveFavoriteSource`（`sentence_pack` 需 `sentencePackLevel` 才可点） | 扩展 `resolveFavoriteSource` | 包裹：返回 `{kind,ref,title,canOpen}`；`source_ref` 空 → `canOpen=false`；`L<n>` → 可回跳 | A1 I-12；C§C14 | P1 | 0.25 | V1 |

### G7 · 词卡 / 高亮 / ruby（A1 C-04/C-13/V-05 / A2 C13）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G7-01 | `WordPopover.tsx:222-255` overlay + card 壳（无 role/Esc/焦点回填） | `WordCard` | 替换：`role=dialog aria-modal=false aria-label={word}`；Esc/空白/关闭；焦点入卡/回词；切词 abort 旧请求 | C§C13；IX-21；I-03/I-15 | P1 | 0.75 | V4 |
| G7-02 | `WordPopover.tsx:55-64` `CARD_*` + `:200-220` 定位计算 | `lib/word-card-position.ts` | 替换：纯函数 clamp（左右 12px）+ 上下翻转 + maxHeight；可单测 | C§C13；I-15 | P1 | 0.5 | V3 |
| G7-03 | `WordPopover.tsx:252/301` 词性徽章 `bg-purple-500/15 text-purple-300` | `Badge tone=neutral` | 替换：词性是中性信息，不用 AI 紫 | C§C7/C13；T§2.2；V-05 | P1 | 0.1 | V2 |
| G7-04 | `WordPopover.tsx:285-295` 内联错误 `text-red-400` | `ErrorPanel level=inline` | 包裹：保留在卡内 + 重试；不用 toast | C§C10/C13；IX-05/IX-21 | P1 | 0.15 | V3 |
| G7-05 | `TranscriptBlock.tsx:51-105` `HighlightedText` 第二套 ruby（`rt purple-300/90`） | `WordHighlight`（唯一 ruby） | 替换：`rt text-micro`；AI 词 `text-highlight-fg`、普通注释 `text-fg-secondary`；保留 `data-word-hit` | C§C13；T§3.3；V-05 | P1 | 1.0 | V3 |
| G7-06 | `TranscriptBlock.tsx:26-48` `ClickableWords`（基础设施住在字幕组件） | `WordHighlight.tsx` 导出 `ClickableWords` | 包裹：实现搬到 ui；`TranscriptBlock` 保留 `export { ClickableWords }` 别名一版（`SentenceText`/`ReadingHighlight` 迁移后删除） | C§C13；C-09 | P1 | 0.5 | V2 |
| G7-07 | `SentenceText.tsx:19-39` 第二套 ruby + 整块可点 + `text-[19px]` | `WordHighlight mode="chunk"` | 替换：`mode=chunk` + `font-semibold`；字号改 `text-body`/`text-section` 阶梯（19→16/17） | C§C13；T§3.2；C-04 | P1 | 0.5 | V3 |
| G7-08 | `ReadingHighlight.tsx:20-31` 琥珀下划线（`bg-amber-400/[0.08]` + dotted underline） | `WordHighlight isHighlighted` | 包裹：`True` 时画 `decoration-amber-400/50`；保留 `data-highlight="1"`（脚本依赖） | C§C13；V-07 | P2 | 0.25 | V2 |
| G7-09 | `TranscriptBlock.tsx:195-205` 星标 `opacity-0 group-hover:opacity-100` | `WordHighlight` 操作槽 + `IconButton` | 替换：`pointer: coarse` 常显；`aria-pressed`；无成功 toast（IX-22） | C§C13/C1；IX-11/I-16 | P1 | 0.25 | V4 |
| G7-10 | `WordPopover.tsx:229/250` `z-[80]` / `z-[90]` | `z-overlay` / `z-popover` | 替换：非模态点击层 40、卡片 60 | T§7；V-13 | P2 | 0.1 | V2 |

### G8 · 返回 / 页头 / 页面骨架（A1 I-11/L-12/N-09 / A2 C12 / A3 D-04/NM-09）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G8-01 | `LearningHeader.tsx:36-48` 返回（h-9 px-2，≥sm 文字） | `SubHeader` + `BackButton` | 替换：保留 `learning-header`/`learning-back`/`learning-title`；工具条下沉内容区第二行 | C§C12；L§6.3 | P1 | 0.5 | V3 |
| G8-02 | `BookReaderScreen.tsx:431-442` 返回（h-8 px-2.5） | `SubHeader` | 替换；保留 `book-reader`/`book-reader-back` | C§C12；L§6.1 | P1 | 0.5 | V3 |
| G8-03 | `SentenceView.tsx:96-112` 返回（h-7 -ml-1，图标 3.5） | `SubHeader` + 工具条第二行 | 替换；保留 `sentences-back`；禁止头部 `flex-wrap` | C§C12；L§6.1/L-12 | P1 | 0.5 | V3 |
| G8-04 | `ReviewScreen.tsx:355-368` X 关闭（chip） | `SubHeader`（BackButton） | 改名 + 替换：X→←；`review-close`→`review-back`（登记 §5.4） | C§C12；D-04；NM-09 | P1 | 0.5 | V4 |
| G8-05 | `ReportScreen.tsx:145-158` X 关闭 | `SubHeader` | 改名 + 替换；`report-close`→`report-back` | C§C12；D-04 | P1 | 0.5 | V4 |
| G8-06 | `DiscoverScreen.tsx:258-267` 返回（h-8 -ml-2 + 文字） | `SubHeader` | 替换；保留 `discover-back` | C§C12 | P1 | 0.25 | V3 |
| G8-07 | `VocabularyBookScreen.tsx:549-565` 返回（h-9，hidden sm 文字） | `SubHeader` | 替换；保留 `vocab-back`；标题 24→17 | C§C12；L§5.5 | P1 | 0.5 | V3 |
| G8-08 | `AccountScreen.tsx:292-302` 返回（h-9 -ml-2 rounded-xl） | `BackButton` | 替换；`rounded-xl`→`rounded-control`；保留 `account-back` | C§C12；T§5 | P1 | 0.25 | V3 |
| G8-09 | `AdminConsoleScreen.tsx:873-884` 返回（h-9 -ml-2 rounded-xl） | `BackButton` | 替换；保留 `admin-back` | C§C12；T§5 | P1 | 0.25 | V3 |
| G8-10 | `CourseScreen.tsx:135-148` 退出（h-9，hidden sm 文字；头部 `md:h-14`） | `SubHeader` | 替换：固定 h-12；保留 `course-exit`；倒计时/步骤下沉 | C§C12；L§6.1 | P1 | 0.5 | V3 |
| G8-11 | `ReaderScreen.tsx:1090-1100` 返回列表（h-8 -ml-3） | `SubHeader` | 替换；保留 `reader-back-list`；工具条第二行 | C§C12；L§6.4 | P1 | 0.5 | V3 |
| G8-12 | `ReaderScreen.tsx:186-196` 头部返回（列表态） | `SubHeader` | 替换；保留既有 testid | C§C12 | P1 | 0.25 | V3 |
| G8-13 | `LibraryArticleReader.tsx:66-74` 返回（h-8） | `SubHeader`（标题=文章，feature=免费资源） | 替换：与学习页共用头部（N-09）；保留 `library-reader` | C§C12；N-09 | P1 | 0.5 | V3 |
| G8-14 | `ImportedBookReaderScreen.tsx:395-405` 返回 | `SubHeader` | 替换 | C§C12 | P1 | 0.5 | V3 |
| G8-15 | `BookSeriesScreen.tsx:72-80` 返回 | `SubHeader` | 替换；保留 `book-series-screen` | C§C12 | P1 | 0.25 | V3 |
| G8-16 | `BlogScreen.tsx:338-346/384-392` 两处返回（列表/文章） | `SubHeader` | 替换：文章态返回文案「返回列表」；保留 `blog-*` | C§C12；NM-04 | P1 | 0.5 | V3 |
| G8-17 | `ExamScreen.tsx:1170-1215` 头部（eyebrow+标题 20/24+副标+历史+关闭） | `SubHeader` | 替换：只留「返回+标题」，**删除页面级关闭 X**；退出/放弃作为业务动作走 IX-24 确认；eyebrow/副标/历史/进度移入内容区（L-09） | C§C12；L§6.1/L-09；D-04/IX-24 | P1 | 0.75 | V4 |
| G8-18 | `AbilityScreen.tsx:872-886` X 关闭 | `SubHeader` | 改名 + 替换；`ability-close`→`ability-back` | C§C12；D-04 | P1 | 0.5 | V4 |
| G8-19 | `PlacementScreen.tsx:1360-1385` 头部（eyebrow+标题 20/24+X） | `SubHeader` | 替换：eyebrow/副标下沉；`placement-exit` 保留为 **确认退出**（IX-24） | C§C12；L§6.1 | P1 | 0.5 | V4 |
| G8-20 | `App.tsx:3460-3472` 登录页返回（全站唯一边框按钮） | `BackButton` | 替换：公开页例外，允许保留边框？→ **统一 BackButton**，边框删除 | C§C12；D-04 | P2 | 0.15 | V3 |
| G8-21 | 4 个一级页标题：`TodayWorkbench:194`(24/36/48)、`ContentScreen:219`(24/30)、`PracticeScreen:88`(24/30)、`AccountScreen:289`(24) | `PageHeader` | 替换：移动端 `text-page md:text-page-lg`、`lg:hidden`；今日 hero 标题保留唯一 `display` 例外 | C§C12；L§2.5；V-15 | P1 | 0.5 | V3 |
| G8-22 | `PAGE_PAD` 3 个常量 + 2 处内联：`TodayScreen:23`、`ContentScreen:37`、`PracticeScreen:14`、`AccountScreen:529/580` | `pb-safe-nav` utility（tokens §11） | 替换：删除常量与内联；一级页滚动容器统一 utility | T§11；L§3.3 | P1 | 0.25 | V3 |
| G8-23 | 页面容器宽度 8 种 43 处（`max-w-[1440px]`/6xl/5xl/3xl/2xl/xl/md） | `max-w-page/admin/library/course/reading/task` | 替换：按 tokens §4.3 映射；一级页外层必须同宽 | T§4.3；L§3.1；V-16 | P1 | 1.0 | V3 |

### G9 · Tabs（A1 C-05 / A2 C5）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G9-01 | `TopBarTabs.tsx:33-60` 下划线 tab + `nav-underline` | `Tabs skin="nav"` | 包裹：组件内部改用 Tabs；保留 `nav-tabs`/`nav-tab-*`/`nav-practice-badge` | C§C5；C11 | P1 | 0.5 | V4 |
| G9-02 | `VocabularyBookScreen.tsx:570-622` 淡 pill tab（8+ 项横向溢出） | `Tabs skin="panel"` + `VocabTabStrip` | 替换：移动 2 固定 + 词表菜单；桌面 panel 皮肤；选中 `scrollIntoView`；保留 `vocab-tabs`/`vocab-tab-*`/`vocab-tab-count-*` | C§C5/C14；L§5.5；L-07 | P1 | 0.75 | V4 |
| G9-03 | `LibrarySection.tsx:314-345` 白实底 tab | `Tabs skin="panel"` | 替换：白实底→白滑块；保留 `library-tab-*` | C§C5；C-05 | P1 | 0.5 | V3 |
| G9-04 | `AdminConsoleScreen.tsx:925-951` 白滑块 tab（容器缺失） | `Tabs skin="panel"` | 替换：补统一容器；保留 `admin-tab-*`；补 `role=tabpanel` | C§C5；C-05 | P1 | 0.5 | V3 |

### G10 · Segmented（A1 C-06/I-17 / A2 C6）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G10-01 | `App.tsx:2660-2700` 译文模式（`transModeThumb`，px-2.5 py-1 text-xs） | `Segmented` sm | 替换：`layoutId="trans-mode"`；保留现有 aria | C§C6；IX-19 | P1 | 0.25 | V3 |
| G10-02 | `ShowBrowser.tsx:145-168` 季选择（px-3 py-1.5 text-sm） | `Segmented` md | 替换：`layoutId="season"` | C§C6 | P2 | 0.25 | V3 |
| G10-03 | `AuthScreen.tsx:108-137` 登录/注册（`authTabThumb`） | `Segmented` md | 替换：`role=radiogroup`；保留 `auth-tab-*`/`auth-tab-thumb` | C§C6；IX-26 | P1 | 0.5 | V4 |
| G10-04 | `SentenceView.tsx:111-130` 级别（`sentenceLevelThumb`） | `Segmented` sm | 替换：级别切换同屏 replace（NM-04）；保留 `sentences-*` | C§C6；NM-04 | P1 | 0.5 | V4 |
| G10-05 | `ReaderScreen.tsx:744-770` 导入模式（`readerImportThumb`，role=tab） | `Segmented` sm | 替换：tab→radio（语义是模式不是导航）；保留 `reader-import-tab-*` | C§C6；IX-19 | P1 | 0.5 | V4 |
| G10-06 | `ReaderScreen.tsx:990-1020` 译文显示（`readerTranslationThumb`，aria-pressed） | `Segmented` sm | 替换：`aria-checked` 取代 `aria-pressed`；保留 `reader-translation-*` | C§C6 | P1 | 0.25 | V3 |
| G10-07 | `LanguageSettingsModal.tsx:36-60` 界面语言（`languageThumb`，role=radio） | `Segmented` md | 替换：保留 `language-option-*`；两行标签布局用 `icon`/`label` 扩展或保留内部 slot | C§C6；IX-19 | P1 | 0.5 | V4 |
| G10-08 | `StartLearning.tsx:102-121` 原生 `<select>`（I-17） | `Segmented` md | 替换：3 项模式改分段；**同批更新** `scripts/reader-layout-test.mjs:458`（`selectOption('read')` → `click([data-testid=start-mode-read])`） | C§C6；IX-19；I-17 | P2 | 0.5 | V4 |

### G11 · Badge / Count / 来源标签（A1 C-07/C-13/N-10 / A2 C7）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G11-01 | `TopBarTabs.tsx:44-52` `nav-practice-badge`（16/9px） | `CountBadge` | 替换：11px；保留 testid 与 aria | C§C7；C-07 | P1 | 0.15 | V3 |
| G11-02 | `Sidebar.tsx:166-190` brand + amber 两套徽章（16/9px） | `CountBadge` + `Badge tone=warning` | 替换：11px；折叠态绝对定位 | C§C7；C11 | P1 | 0.25 | V3 |
| G11-03 | `BottomBar.tsx:43-53` `bottom-practice-badge`（18/10px） | `CountBadge` | 替换：11px；保留 testid | C§C7 | P1 | 0.15 | V3 |
| G11-04 | `VocabularyBookScreen.tsx:607-620` tab 计数（18/10px） | `CountBadge` | 替换：11px；保留 `vocab-tab-count-*` | C§C7 | P1 | 0.15 | V3 |
| G11-05 | `VocabularyBookScreen.tsx:150-166` `LevelBadge` | `Badge tone=neutral` | 包裹：保留 `vocab-list-level`/`vocab-level` 等 testid | C§C7 | P2 | 0.1 | V2 |
| G11-06 | `LibrarySection.tsx:302-307` `FREE` emerald uppercase 标签 | `Badge tone=success` | 替换：去 `uppercase`；保留 `library-video-badge` 等 | C§C7/C13；C-13 | P1 | 0.15 | V3 |
| G11-07 | `LearningHeader.tsx:54-58` feature label（11px chip） | `Badge tone=neutral` | 替换 | C§C7；C-13 | P2 | 0.1 | V3 |
| G11-08 | `AccountScreen.tsx:678-682` 管理员 blue badge | `Badge tone=brand` | 替换 | C§C7；T§2.2 | P2 | 0.1 | V3 |
| G11-09 | `AppShell.tsx:189-191` 内联 `>99 ? '99+'` | `formatCount` + `CountBadge` | 替换：格式单一来源；保留 `topbar-wordbook` | T§18；C§C7；N-10 | P1 | 0.1 | V2 |
| G11-10 | `LearningHeader.tsx:69-74` 原始数字（无 99+） | `formatCount` | 替换：四入口一致 | N-10；C§C7 | P1 | 0.1 | V2 |
| G11-11 | `lib/navTabs.ts:33-35` `formatDueBadge` | `lib/format.ts` `formatCount` | 保留别名：`export { formatCount as formatDueBadge }`；调用点不改 | N-10；C§C18 | P1 | 0.1 | V1 |

### G12 · 空 / 加载 / 错误三态（A1 I-01/I-07/I-08/I-09 / A2 C10）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G12-01 | `VocabularyBookScreen.tsx:644-654` `emptyState()` 本地 helper | `EmptyState size=inline` | 替换：保留各 testid；hint 从 `zinc-600` 升 `fg-secondary` | C§C10；IX-04；T§2.3 | P1 | 0.25 | V3 |
| G12-02 | `RecentLearning.tsx:508-530` 空态（虚线 + 蓝 CTA，py-10） | `EmptyState size=inline` | 替换：去虚线（普通空态禁止）；CTA→Button secondary；保留 `recent-empty`/`recent-empty-action` | C§C10；IX-04；L-10 | P1 | 0.25 | V3 |
| G12-03 | `RecentLearning.tsx:533-548` 筛选空（py-8） | `EmptyState size=inline` | 替换：保留「清除筛选」动作；保留 `recent-filtered-empty` | C§C10；IX-04 | P1 | 0.15 | V3 |
| G12-04 | `BlogScreen.tsx:361/486` 加载（py-20 spinner）+ 空（py-24） | `LoadingState` + `EmptyState size=page` | 替换：空态给「RSS 订阅」动作；loading 改骨架 | C§C10；L§7.3 | P1 | 0.25 | V3 |
| G12-05 | `DiscoverScreen.tsx:463-470` 空态（py-12、无图标、无动作） | `EmptyState size=page` | 替换：给 3 个示例主题动作（L-10） | C§C10；L§7.3 | P2 | 0.25 | V3 |
| G12-06 | `SentenceView.tsx:186` 纯文字加载/空（py-24） | `LoadingState` + `EmptyState` | 替换：加载骨架；空态四槽 | C§C10；I-08 | P2 | 0.25 | V3 |
| G12-07 | `BookSeriesScreen.tsx:131` not-found（py-16） | `ErrorPanel level=page` | 改名 + 替换：404 是错误不是空态（IX-05） | C§C10；IX-05 | P2 | 0.15 | V3 |
| G12-08 | `ChannelVideoList.tsx:82/84` 纯文字 loading + 空（无错误态） | `LoadingState`（skeleton）+ `EmptyState size=inline` + `ErrorPanel level=inline` | 替换：补错误分支；保留 `channel-*` | C§C10；IX-01/04/05；I-02 | P1 | 0.5 | V3 |
| G12-09 | `ShowBrowser.tsx:69/81` 加载（py-12）+ 空（py-16） | `LoadingState` + `EmptyState` + `ErrorPanel` | 替换：空态说明改用户动作（随 G0-03） | C§C10；L§7.3 | P1 | 0.25 | V3 |
| G12-10 | `BooksSection.tsx:149`、`ImportedBooksShelf.tsx:116` 虚线「可放置区」 | `EmptyState`（`dashed` 不提供） | 保留：可放置区虚线是 IX-04 明确例外；只换文案与 Button | C§C10；IX-04 例外 | P2 | 0.1 | V2 |
| G12-11 | `ImportedBooksShelf.tsx:80-82` 骨架屏 | `Skeleton` | 包裹：保留为列表首屏基准；行高与真实行一致 | C§C10；IX-03 | P2 | 0.15 | V3 |
| G12-12 | `ContentScreen.tsx:285-289` 行内 `Loader2 w-3.5` | `LoadingState kind=spinner` | 替换：右栏卡片内行内 spinner；`aria-busy` | C§C10；IX-03 | P1 | 0.15 | V3 |
| G12-13 | `ReaderScreen.tsx:890` 居中大 spinner + 标题 | `LoadingState kind=skeleton` | 替换：保持头部稳定，正文骨架 | C§C10；IX-03 | P2 | 0.25 | V3 |
| G12-14 | `ReviewScreen.tsx:508/517` 加载 py-20 + 错误面板 | `LoadingState` + `ErrorPanel` | 替换：错误保留重试与第二出口 | C§C10；IX-05 | P1 | 0.25 | V3 |
| G12-15 | `ReportScreen.tsx:173/191` 加载 py-20 + 错误 | `LoadingState` + `ErrorPanel` | 替换 | C§C10；IX-05 | P1 | 0.25 | V3 |
| G12-16 | `VocabularyBookScreen.tsx:1014/1021/1341/1348` loading + error（phrase/vocab） | `LoadingState` + `ErrorPanel` | 替换：保留 `vocab-loading`/`vocab-error`/`phrase-*`；错误标题用户语言 | C§C10；IX-05 | P1 | 0.5 | V3 |
| G12-17 | `TodayScreen.tsx:92-105` `/api/history` 失败当空（**P0**） | `ErrorPanel level=card` + 三态枚举 | 替换：`historyState: loading / error / empty / ready`；失败不显示 `continueEmpty*`；重试 | C§C10；IX-01；A1 I-01 | **P0** | 0.5 | V4 |
| G12-18 | `ContentScreen.tsx:119-131` 右栏 `/api/history` 失败当空（**P0**） | `ErrorPanel level=card` | 替换：右栏卡内错误行 + 重试 | C§C10；IX-01 | **P0** | 0.25 | V4 |
| G12-19 | `ContentScreen.tsx:163-192` `/api/channel-updates` 失败当空（**P0**） | `ErrorPanel level=card` | 替换：只有 `hasSubscriptions=false` 才是空态 | C§C10；IX-01 | **P0** | 0.5 | V4 |
| G12-20 | `ContentScreen.tsx:133-163` 本周报告失败仍走 `weekEmpty`（**P0**） | `ErrorPanel level=card` | 替换：失败→错误行；「本周无数据」只用于成功且为空 | C§C10；IX-01 | **P0** | 0.25 | V4 |
| G12-21 | `RecentLearning.tsx:597-610` 部分失败横幅 + 重试 | `ErrorPanel level=inline` | 包裹：保留旧数据 + 行内警告（IX-01 refreshing→error stale） | C§C10；IX-01 | P1 | 0.25 | V3 |
| G12-22 | `ReaderScreen.tsx:183-190` 错误面板（红面板 + 重试 + 登录 + 返回） | `ErrorPanel level=page` | 包裹：作为基准形态；统一 props | C§C10；IX-05 | P2 | 0.25 | V3 |
| G12-23 | `DiscoverScreen.tsx:371` 错误态重试按钮（h-9 rounded-xl） | `ErrorPanel` 的 `onRetry` + `Button secondary/md` | 替换；保留 `discover-retry`；错误面板不渲染 EmptyState | C§C10；C§C1；IX-05 | P1 | 0.15 | V3 |
| G12-24 | `DiscoverScreen.tsx:382` 403 登录按钮（blue 边框） | `Button secondary/md` + `ErrorPanel.secondary` | 替换；`blue-*`→`brand-*`；保留 `discover-login` | C§C1/C10；IX-17 | P1 | 0.1 | V3 |
| G12-25 | `DiscoverScreen.tsx:392` 错误态返回按钮（ArrowLeft + 文字） | `Button ghost/md`（返回动作） | 替换；页面级退出语义由 A3 的 `onBack` 提供，不是 X | C§C1；D-04 | P1 | 0.1 | V3 |
| G12-26 | `DiscoverScreen.tsx:474` 空态重试按钮 | `EmptyState size=page` 的 action（≤1）或 `Button secondary/md` | 替换；保留 `discover-empty-retry`；空态来自成功且为空 | C§C10；IX-04 | P2 | 0.15 | V3 |
| G12-27 | `DiscoverScreen.tsx:483` 空态返回按钮 | `Button ghost/md` | 替换；保留标题/说明；返回动作只发 `onBack` | C§C1；IX-04 | P2 | 0.1 | V3 |

### G13 · 分页 / 步骤（A1 I-18 / A2 C9/C15）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G13-01 | `VocabPagination.tsx`（整文件，页码条 + 状态文案 + `paginationTokens`） | `Pagination` | 包裹：文件改名迁移到 `ui/Pagination.tsx`；`scope: vocab / phrase` 保留；`paginationTokens` 原样导出 | C§C9；IX-18 | P2 | 0.25 | V2 |
| G13-02 | `RecentLearning.tsx:560-596` 上一页/指示器/下一页 + `PAGE_BUTTON:67` | `Pagination` | 替换：统一页码条 + 状态文案；保留 `recent-*` testid（用 `testIds` 覆盖） | C§C9；I-18 | P2 | 0.5 | V3 |
| G13-03 | `AdminConsoleScreen.tsx:1185-1205` offset 翻页 + `PAGE_SIZE` | `Pagination`（`hasMore`） | 替换：`page = offset/PAGE_SIZE + 1`；保留 `admin-users-prev/next` 与 `admin-users-page` | C§C9；IX-18 | P2 | 0.5 | V2 |
| G13-04 | `AbilityScreen.tsx:388-410` 步骤按钮（误叫分页） | `StepControls` | 改名：上一步/下一步 + 步骤 2/8；不用 Pagination；保留 `ability-self-assess-*` | C§C15；IX-18/IX-19 | P2 | 0.5 | V3 |

### G14 · 列表行 / 删除图标（A1 C-11/C-15 / A2 C2）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G14-01 | `ContentScreen.tsx:292-310` 右栏继续学习行（`p-2.5 rounded-xl bg-zinc-800/30`） | `ListRow` | 替换：`p-3 rounded-control-lg bg-surface-2/30`；缩略图/进度保留 | C§C2；C-11 | P2 | 0.5 | V3 |
| G14-02 | `ContentScreen.tsx:466-486` 订阅视频行（同配方第二处） | `ListRow` | 替换 | C§C2；C-11 | P2 | 0.25 | V3 |
| G14-03 | `RecentLearning.tsx:320-340` 最近学习行（`bg-zinc-900/40`） | `ListRow` | 替换：底改 `surface-2/30`；保留 `recent-*` | C§C2；C-11 | P2 | 0.5 | V3 |
| G14-04 | `ShowBrowser.tsx:110-125` 剧集行（`p-3 rounded-xl bg-zinc-800/30`） | `ListRow` | 替换 | C§C2；C-11 | P2 | 0.25 | V3 |
| G14-05 | `AccountScreen.tsx:320-520` 设置/关于/学习数据行（全部同权重） | `ListRow` + `SectionHeader` | 替换：按 L-05 分 3 组；危险操作移组尾 | C§C2；L§5.4 | P1 | 1.0 | V3 |
| G14-06 | `App.tsx:2640-2660` 字幕行删除（hover 才出现） | `IconButton` destructive + `ConfirmDialog` | 替换：触屏常显/更多菜单；命中 44；二次确认 | C§C1/C15；IX-11/IX-24 | P2 | 0.5 | V4 |
| G14-07 | `RecentLearning.tsx:352-370` 行内删除（`Trash2`） | `IconButton` + `ConfirmDialog` | 替换：hover/focus 变红；命中 44 | C§C1；C-15 | P2 | 0.25 | V3 |
| G14-08 | `VocabularyBookScreen.tsx:845-860` 短语行删除 | `IconButton` | 替换：统一红/确认策略（可逆取消收藏用撤销 toast） | C§C1/C14；IX-22 | P2 | 0.25 | V3 |
| G14-09 | `AccountScreen.tsx:632-646` 取消改名（`X`，w-9 h-9） | `IconButton` | 替换：`aria-label` 保留；命中 44 | C§C1 | P2 | 0.1 | V2 |
| G14-10 | `ReaderScreen.tsx:970-985` 删除文章（`Trash2`） | `IconButton` + `ConfirmDialog` | 替换（随 G4-02） | C§C1；IX-24 | P2 | 0.15 | V3 |
| G14-11 | `ImportedBookReaderScreen.tsx:420-435` 删除导入书 | `IconButton` + `ConfirmDialog` | 替换（随 G4-03） | C§C1；IX-24 | P2 | 0.15 | V3 |

### G15 · 进度（A1 C-12/V-08 / A2 C15）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G15-01 | `TodayWorkbench.tsx:342-347`（h-1 + emerald + role） | `Progress` | 替换：高 1.5；tone=success；保留 aria | C§C15；C-12 | P2 | 0.15 | V2 |
| G15-02 | `ContentScreen.tsx:299-302`（同配方，无 role） | `Progress` | 替换：补 a11y | C§C15；C-12 | P2 | 0.1 | V2 |
| G15-03 | `SentenceView.tsx:168-170`（h-1 渐变 emerald→sky，无 aria） | `Progress` | 替换：单色 success；补 role/aria；保留图例 | C§C15；V-08 | P2 | 0.25 | V3 |
| G15-04 | `SentencePacks.tsx:42-44` 渐变进度 | `Progress` | 替换：单色；卡片内保留百分比 | C§C15；V-08 | P2 | 0.15 | V3 |
| G15-05 | `ReviewScreen.tsx:398-403`（h-1.5 + role） | `Progress` | 包裹：保留 role/props；高不变 | C§C15 | P2 | 0.1 | V2 |
| G15-06 | `PlacementScreen.tsx:625-631`（h-1.5 + role） | `Progress` | 包裹 | C§C15 | P2 | 0.1 | V2 |
| G15-07 | `QuizScreen.tsx:401-406`（h-1.5 + role） | `Progress` | 包裹 | C§C15 | P2 | 0.1 | V2 |
| G15-08 | `ExamScreen.tsx:621-625`（h-1.5 + role） | `Progress` | 包裹 | C§C15 | P2 | 0.1 | V2 |
| G15-09 | `CourseScreen.tsx:209-214`（步骤进度） | `Progress` + `StepControls` | 替换：步骤计数与进度条统一 | C§C15；IX-18 | P2 | 0.5 | V3 |
| G15-10 | `ReaderScreen.tsx:1049`（阅读进度 h-1.5） | `Progress` | 替换：补 label | C§C15 | P2 | 0.15 | V2 |
| G15-11 | `VocabAxis.tsx:47` 彩虹轴（**非进度**） | 无（保留） | 保留：不套 Progress；B5 只按 V-07 改单色轨 + brand 当前档 | T§2.2；V-07/§2.5 | P2 | 0.25 | V3 |

### G16 · 共享函数（A1 C-08/C-09/N-10 / A2 §18）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G16-01 | `TranscriptBlock.tsx:5-14` `cn()`（clsx + twMerge） | `lib/cn.ts` | 替换：实现搬走；`TranscriptBlock` 保留 `export { cn }` 别名；后续组件改 import lib | C§C18；C-09 | P1 | 0.25 | V1 |
| G16-02 | `BilingualRow.tsx:16-17` `bilingualReadingWidth()` | `lib/reading-layout.ts` | 替换：返回 `max-w-library`/`max-w-reading`；`BilingualRow` 保留别名一版 | T§4.3；C-09 | P1 | 0.25 | V2 |
| G16-03 | `App.tsx:158-163` `formatClock` | `lib/time.ts` | 替换：删除本地函数 | C§C18；C-08 | P1 | 0.1 | V1 |
| G16-04 | `ReportScreen.tsx:81-86` `formatClock` | `lib/time.ts` | 替换 | C§C18；C-08 | P1 | 0.1 | V1 |
| G16-05 | `QuizScreen.tsx:39-44` `formatClock` | `lib/time.ts` | 替换 | C§C18；C-08 | P1 | 0.1 | V1 |
| G16-06 | `TranscriptBlock.tsx:137-140` `formatTime`（内联） | `lib/time.ts` | 替换 | C§C18；C-08 | P1 | 0.1 | V1 |
| G16-07 | `LocalEpisodeStage.tsx:32-35` 内联时间 | `lib/time.ts` | 替换 | C§C18；C-08 | P1 | 0.1 | V1 |
| G16-08 | `TeachingNotesPanel.tsx:30-35` 内联时间 | `lib/time.ts` | 替换 | C§C18；C-08 | P1 | 0.1 | V1 |
| G16-09 | `CourseScreen.tsx:82-87` `formatClock(ms)` | `lib/time.ts` `formatCountdown` | 替换 | C§C18；C-08 | P1 | 0.1 | V1 |
| G16-10 | `PlacementScreen.tsx:105-110` `formatCountdown(ms)` | `lib/time.ts` `formatCountdown` | 替换 | C§C18；C-08 | P1 | 0.1 | V1 |
| G16-11 | `App.tsx:1611-1612` 内联 `mm:ss`（resume toast） | `lib/time.ts` | 替换 | C§C18；C-08 | P2 | 0.1 | V1 |
| G16-12 | `lib/recommend.ts:75` 内联 `mm:ss` 时长标签 | `lib/time.ts` `formatDuration` | 替换 | C§C18；C-08 | P2 | 0.15 | V1 |

> **W6 去重**：原 G16-13/14/15 与 G11-09/10/11 是同一旧实现的重复登记（`AppShell:189-191`、`LearningHeader:69-74`、`lib/navTabs.ts` 的 `formatDueBadge`），已删除并合并到 G11-09/10/11；G16 由 15 行降为 12 行。

### G17 · 搜索 / 输入（A2 C3）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G17-01 | `ReaderScreen.tsx:150-152` `textField`（rounded-xl + 自定义 focus） | `Input` size=lg | 替换：删除常量；focus 交壳 `focus-within`；placeholder 改 `text-fg-secondary` | C§C3；T§10.1；V-14 | P2 | 0.25 | V3 |
| G17-02 | `SentenceView.tsx:150-156` 搜索（h-7 pl-8 text-xs） | `SearchField` size=sm（<md 用 lg 防缩放） | 替换；保留既有 testid | C§C3；I-07 | P2 | 0.25 | V3 |
| G17-03 | `VocabularyBookScreen.tsx:921-930` 短语搜索（h-10） | `SearchField` size=md | 替换；保留 `phrase-search`/`phrase-search-clear` | C§C3 | P2 | 0.25 | V3 |
| G17-04 | `DiscoverScreen.tsx:294-305` 搜索（壳 + 内联字段） | `SearchField` size=lg | 替换；保留 `discover-*` testid | C§C3 | P2 | 0.25 | V3 |
| G17-05 | `BookImportDialog.tsx:186-194` URL 字段（blue focus） | `Input` size=md | 替换：`focus:ring-blue-*`→壳 `focus-within:brand` | C§C3；V-14；T§2.2 | P2 | 0.25 | V3 |
| G17-06 | `AccountScreen.tsx:612-620` 改名输入（h-10 text-lg） | `Input` size=lg | 替换：输入字号移动端 ≥16px；保留 `account-username-*` | C§C3；IX-16 | P2 | 0.25 | V3 |
| G17-07 | `StartLearning.tsx:125-145` hero 字段（id=`video-url`） | `Input variant="hero"` size=xl | 替换：保留 `id="video-url"`、`video-url-input`、textarea 分支 | C§C3；L§5.1 | P2 | 0.5 | V4 |

### G18 · 死代码（A1 C-10）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G18-01 | `InputScreen.tsx:1-598`（`window.confirm:115`、`id="video-url":338`、`min-h-screen:243`、5 处内联卡片） | 无 | 删除：先 `grep -rn "InputScreen"` 确认 0 import（当前仅注释提及，保留注释改写）；删除后全局只剩 `StartLearning` 的 `id="video-url"` | A1 C-10；C§C10 | P2 | 0.1 | V1 |

### G19 · 导航壳（A2 C11 / A3 D-03）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G19-01 | `Sidebar.tsx`（400 行，240/72、徽章、快捷分组、折叠） | NavShell（保留改造） | 包裹：结构不动；徽章→`CountBadge`；选中底→`state-selected`；折叠 `aria-expanded`；宽度 `w-sidebar(-collapsed)` | C§C11；L§9.1 | P1 | 0.75 | V3 |
| G19-02 | `BottomBar.tsx`（h-14 + safe、4 项） | NavShell（保留改造） | 包裹：布局不变；徽章→`CountBadge`；`text-micro`；`h-bottombar` | C§C11；L§8.4 | P1 | 0.25 | V3 |
| G19-03 | `AppShell.tsx:84-220` 顶栏（标题 15 + 副标 11 + CTA + 计数 + 头像） | NavShell（保留改造） | 包裹：`topbar-start`→`Button`；`formatCount`；面包屑（D-03）由 `subLabel` 给出；`h-topbar`/`bg-app/60`/`z-chrome` | C§C11；D-03；L§9.2 | P1 | 0.75 | V3 |

### G20 · 单词本词表行（A2 C14 / A1 L-07）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G20-01 | `VocabularyBookScreen.tsx:1382-1445` 词表行（grid `<button>`，桌面/移动混排） | `VocabRow layout="table"` | 替换：桌面真实 `<table>` 语义（thead/tbody）、移动卡片；保留 `vocab-list-row/word/translation/level` | C§C14；L§5.5 | P2 | 1.0 | V3 |
| G20-02 | `VocabularyBookScreen.tsx:1049-1130` 短语行（可展开细节） | `VocabRow layout="row"` | 替换：展开 `aria-expanded`；保留 `phrase-row/headword/translation/expand/detail` | C§C14 | P2 | 0.75 | V3 |
| G20-03 | `VocabularyBookScreen.tsx:534-548` `sourceText()` 来源可点判断 | `VocabRow.source` + `resolveFavoriteSource` | 替换：`canOpen` 由 lib 返回；不可点显示「出处未知」 | C§C14；I-12 | P1 | 0.25 | V2 |

### G21 · 分享 / 选区浮层（A1 C-14）

| ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|
| G21-01 | `ShareCardDialog.tsx:1-305`（Canvas 生成 + 复制/下载） | Dialog + Button | 包裹：壳与按钮换共享组件；**不合并**分享入口（C-14 留上线后）；保留 `share-card-*` | C§C4/C1；IX-27 | P2 | 0.5 | V3 |
| G21-02 | `ReaderScreen.tsx:1240-1320` 选区浮层「分享本段」 | 保留（仅 token/Button） | 保留：浮层生命周期与选区绑定，不并入 ShareCardDialog；材质/按钮对齐 | T§2.4；C§C1；C-14 | P2 | 0.25 | V3 |

### G22 · 超大组件（A1 C-16）

> **W6 调整**：这 7 项是「保留（不拆 / 不迁移）」登记，不是可执行迁移行。原 G22-01..07 已移至下方 **§3.23 保留清单**（ID 改为 R-01..R-07），**不再计入 §3 的 222 行**；§6.1 的 C-16 归属仍对应这 7 项。

### 3.23 保留清单（原 G22，不计入 222 行）

| ID | 原 ID | 旧实现（文件:行 / 导出） | 新组件 | 迁移动作 | 依赖 | 优先级 | 预估 | 验证 |
|---|---|---|---|---|---|---|---|---|
| R-01 | G22-01 | `AdminConsoleScreen.tsx`（1,634 行） | 无（保留） | 保留：本阶段只抽 Button/Card/Dialog/Tabs/Pagination 常量；**不拆文件**（拆分留上线后） | A1 C-16；§7 | P2 | 0 | V1 |
| R-02 | G22-02 | `CourseScreen.tsx`（1,606 行） | 无（保留） | 保留：抽 Button/Card/Progress/StepControls；不拆 | C-16；§7 | P2 | 0 | V1 |
| R-03 | G22-03 | `VocabularyBookScreen.tsx`（1,483 行） | 无（保留） | 保留：抽 Button/Card/Tabs/Pagination/VocabRow；不拆 | C-16；§7 | P2 | 0 | V1 |
| R-04 | G22-04 | `PlacementScreen.tsx`（1,447 行） | 无（保留） | 保留：抽 Button/Card/Progress/Segmented；不拆。**注意**：其游客登录按钮已由 G1-26/27 显式迁出，不再由本行兜底 | C-16；§7 | P2 | 0 | V1 |
| R-05 | G22-05 | `ReaderScreen.tsx`（1,329 行） | 无（保留） | 保留：抽 Button/Input/Progress/Segmented/SubHeader；不拆 | C-16；§7 | P2 | 0 | V1 |
| R-06 | G22-06 | `ExamScreen.tsx`（1,300 行） | 无（保留） | 保留：抽 Button/Card/Progress/SubHeader/OptionCard；不拆 | C-16；§7 | P2 | 0 | V1 |
| R-07 | G22-07 | `AbilityScreen.tsx`（1,281 行） | 无（保留） | 保留：抽 Button/Card/Progress/StepControls/Dialog；不拆 | C-16；§7 | P2 | 0 | V1 |

> 保留行的验收：**不得**把「文件仍 >1,000 行」当作迁移未完成；它们只要求本阶段抽出的常量/子组件归零（由 G1/G2/G3/G5/G8/G9/G12/G13/G15 行覆盖）。拆分留上线后（§7.2）。

---

## 4. 迁移顺序（5 个批次）

### 4.0 批次与组的关系

| 批次 | 包含的组/行 | 行数 | 预估 | 主要风险 |
|---|---|---|---:|---:|---|
| **B1 基座** | G0（12）、G1（27）、G6（8）、G16（12）、G18（1） | 60 | 3.0 | 按钮 h-11→40 的 4px 视觉差；`cn` 依赖方向变更；31 键 i18n 与 W2 同文件 |
| **B2 覆盖层与反馈** | G3（14）、G4（4）、G5（3）；其中 G3-02 后置 | 21 | 3.0 | 焦点陷阱/滚动锁实现质量；P0 频道弹窗；原生 confirm 文案变化 |
| **B3 壳与页头** | G8（23）、G11（11）、G19（3） | 37 | 3.5 | X→← 语义变化；桌面双标题；`data-page-scroll` 需与 A3 协调 |
| **B4 状态/卡片/列表/分页/词卡** | G2（17）、G7-01..04/09/10（6）、G12（27）、G13（4）、G14（11） | 65 | 4.5 | 卡片圆角 24→16 的视觉变化；I-01 三处状态改造；词卡定位；56 处内联卡片 |
| **B5 高风险交互件** | G7-05..08（4）、G9（4）、G10（8）、G15（11）、G17（7）、G20（3）、G21（2） | 39 | 4.5 | 两套 ruby 合并（脚本依赖 `data-word-hit`）；原生 select→分段（脚本 `selectOption`）；tab 语义 |
| **合计** | | **222** | **18.5 + 1.5** | 60+21+37+65+39=222；G22 的 R-01..R-07 保留行不计入 |

> **批次重排（W6）**：① B1 与 W1/B0 导航**并行**，文件边界见 B1 入口；② B2 拆成 P0 切片（20 行）+ 尾行 G3-02（等 B4-P0 的 StateView）；③ B3 与 B4 **不再声称可并行**（G7-03 用 B3 的 Badge，且两者都改 `VocabularyBookScreen`）；④ B4 先做 P0 切片（I-01 的 4 行 + StateView），再做其余；⑤ G22 保留行移出批次。

### B1 · 基座（基座 token + 原子 + 共享函数 + 死代码）

- **范围**：G0-01..12、G1-01..27、G6-01..08、G16-01..12、G18-01（60 行）。
- **入口条件**：① A2 `tokens.md` §12 的 theme 片段合入 `frontend/tailwind.config.js`（含本方案补充的 `colors.control`），`index.css` 落 CSS 变量/`::selection`/`focus-visible` 修正/`@layer utilities`；② `npx tsc -b` 与 `npm run build` 在当前 HEAD 全绿；③ **W1/B0 导航可与本批并行**：本批不改 `nav.ts`/`useNav.ts`/`App.tsx` 的路由分支（App.tsx 只动按钮常量/点词 handler/formatClock），导航改动由 W1 单独提交；同一文件冲突时以「先合 W1、再 rebase B1」处理，不互相等待。
- **出口条件**：① `grep -rn "PRIMARY_BUTTON\|SECONDARY_BUTTON\|GHOST_BUTTON" frontend/src` = 0；② 5 处 word lookup 合并为 1 个工厂，`SentenceView` 传 `sentence_pack` source（用浏览器断点确认 `source_ref=L<n>`）；③ 8 份 `formatClock`/`formatCountdown` 归零，`formatCount` 覆盖 4 入口；④ `InputScreen.tsx` 已删且 `tsc/build` 绿；⑤ **31 键全为中文 + `sentences.day` 中文化**（`npm run check:i18n` 通过；若 W2 已先做，本项以 W2 回执为准，不重复改）；⑥ 6 个代表屏截图（今日/内容/练习/复习/单词本/弹窗）无未记录差异。
- **回滚策略**：每文件组独立 commit（`ui/Button` / `lib/*` / G1 常量删除分 3 个 commit）；回滚只 revert 对应 commit，`lib/*` 是纯新增，不回滚也不影响旧代码。旧常量文件在批末才删，删除 commit 单独可 revert。
- **保留的旧别名**：`TranscriptBlock` 继续导出 `cn`/`ClickableWords`（指向 lib/ui）；`navTabs.formatDueBadge` 继续导出（指向 `format.ts`）；`BilingualRow.bilingualReadingWidth` 继续导出（指向 `reading-layout`）。别名删除条件：B5 结束后 `grep` 旧名 = 0。
- **预估**：3.0 人日（Button 0.75 + G1 调用点 1.0 + lib/工厂 0.75 + i18n 0.25 + 验证 0.25）。

### B2 · 覆盖层与反馈（Dialog/Confirm/Toast）

- **范围（P0 切片，20 行）**：G3-01、G3-03..14、G4-01..04、G5-01..03。
- **尾行（1 行，后置）**：G3-02 `EstimateDialog` 的 busy/LoadingState —— 它依赖 B4-P0 的 `StateView`/`LoadingState`，**不在 B2 前段完成**。
- **入口条件**：B1 出口全绿；`Dialog` 的焦点陷阱/滚动锁已写单测或手测（打开 → Tab 循环 → Esc → 焦点回填）；`z-*` token 已落地；`alertdialog`/`fullscreen`/`loading`/`error`/`dirty`/`onBeforeClose` 契约已按 A2 C4 / A3 IX-09 落地。
- **出口条件**：① 14 个弹窗壳只剩 1 个 `Dialog` + `ConfirmDialog`（`grep -rn "fixed inset-0" frontend/src/components` 仅出现在 `ui/` 内）；② `grep -rn "window.confirm\|window.alert" frontend/src` = 0；③ 全部弹窗 `role=dialog`（阻断型 `alertdialog`）/`aria-modal`/Esc/遮罩/焦点回填（I-02 通过）；④ Toast 在 375/390 不压底栏、success 3s / info 5s / error 8s、同 key 5s 去重、最多 3 条可见且其余 **FIFO 排队**；⑤ `PwaInstall` 模态不再用 `z-toast`；⑥ dirty 关闭先确认、无嵌套 Dialog；⑦ 现有 Playwright 的 `estimate-modal`/`share-card-dialog` 仍可选中。
- **回滚策略**：旧壳文件保留到批末（新组件先包裹）；逐弹窗迁移、逐 commit；任一弹窗回归失败 → revert 该弹窗 commit，其余不受影响。禁止把 14 个弹窗放一个 commit。
- **保留的旧别名**：`EstimateDialog` 组件名保留（内部换 Dialog）；`ChannelVideoList` 的对外 props 不变；`ShareCardDialog` 组件名与 testid 不变。
- **尾行入口**：B4-P0 的 `LoadingState` 与 `ErrorPanel` 可用后，只补 G3-02；只改 `EstimateDialog`，不重开 B2 其余行。
- **预估**：3.0 人日（Dialog 1.0 + 14 弹窗 1.25 + confirm 0.25 + Toast 0.5）。

### B3 · 导航壳与页头（BackButton/SubHeader/Badge）

- **范围**：G8-01..23、G11-01..11、G19-01..03（37 行）。
- **入口条件**：B1 出口全绿；B2 P0 切片的 Dialog/Button 可用；**B4-P0 的 `StateView` 可用**（Back/页头的空/错状态复用）；A3 的 **D-03 双壳裁决**已确认（桌面面板型保留侧栏 + 页内返回；任务型隐藏侧栏；**手机所有子视图不保留全局壳**）；`parentOf`/`backLabelFor` 的行为契约已在 `navigation-model.md` 固定（A4 不实现，只调用 `onBack`，并把 `parentLabel` 传给 `BackButton`）。
- **出口条件**：① 页面级返回只有 `BackButton`（21 处 → 1 实现），无页面级 X（`grep "common.close"` 仅剩 Dialog 内部）；② 子视图头 h-12 且不换行（Review/Report/Exam/Placement/Ability/Discover 的 X→←；Exam 头只留返回+标题，业务退出走 IX-24 确认）；③ 四个一级页同一视口只有一个 h1、移动端标题 24/30、桌面顶栏 15；④ 4 个入口计数全部 `99+` 一致；⑤ 375/1024/1440 截图：底栏 4 项单行、侧栏折叠徽章不压图标、桌面无 4 tab + 标题重复。
- **回滚策略**：壳文件（AppShell/Sidebar/BottomBar）与页面头部分开：壳改动单独 commit（可 revert 不影响子视图）；页面头部逐屏 commit。X→← 的回滚只需还原该屏 header（`BackButton` 仍在，不影响其他屏）。
- **保留的旧别名**：`LearningHeader` 组件名保留一版（内部渲染 `SubHeader` + 工具条），`LibraryArticleReader` 继续用同一 `SubHeader`；`review-close`/`report-close` 等 testid 改名登记在 §5.4（如需兼容，`testIds` 可同时输出旧 id 一个周期）。
- **预估**：3.5 人日（BackButton/SubHeader 0.75 + 20 处屏头 1.5 + 一级页标题/骨架 0.75 + 徽章/壳 0.5）。

### B4 · 状态 / 卡片 / 列表 / 分页 / 词卡

- **范围**：G2-01..17、G7-01..04/09/10、G12-01..27、G13-01..04、G14-01..11（65 行）。
- **B4-P0 切片（4 行 + StateView）**：G12-17..20（I-01 三处失败当空）+ `ui/StateView.tsx`（EmptyState/LoadingState/ErrorPanel/Skeleton 契约）。必须在 B2 尾行 G3-02 与 B3 之前完成；**不能等 B4 其余**。
- **B4 其余（61 行）**：卡片/列表/分页/词卡/空态等；入口条件 B3 出口全绿。
- **入口条件**：B2 P0 出品（ErrorPanel 与 Dialog 可用）→ B4-P0；B3 出口全绿 → B4 其余；I-01 三处的三态枚举设计评审通过（`loading|error|empty|ready`，不允许 `length===0 && failed`）；卡片 `panel` 的分配表（每页 ≤1）已确认。
- **出口条件**：① 13 个 `CARD`/2 个 `CARD_ICON`/`SECTION_TITLE` 删除；**56 处内联卡片**按附录 A 全部迁移（61 含 `InputScreen` 死代码 5 处，B1 已删；`grep` 旧字面量 = 0，可放置区例外）；② 断网刷新今日/内容页显示「加载失败 + 重试」，不是「暂无记录」（I-01 验收）；③ 首屏列表骨架、空态 `py-16`（page）/`py-10`（card）/`py-3`（inline）、错误 `role=alert`；④ 4 处分页形态统一（ability 改「上一步/下一步」）；⑤ 词卡 375px 左右/下边缘不裁切、Esc 关闭、点击/键盘切词不关、非模态不锁滚动；⑥ 截图：四个一级页卡片圆角/内边距、右栏、书架、词卡。
- **回滚策略**：G12 的 I-01 三处按文件独立 commit（TodayScreen / ContentScreen 两次）——它们是 P0，必须可单独回滚；卡片字面量按文件分组脚本化替换（每文件一 commit），**不做全仓一次 sed**；词卡独立文件，失败只 revert WordCard。
- **保留的旧别名（W6 改为兼容适配器）**：`VocabPagination` 不再承诺「直接导出即兼容」，改为薄适配器：保留 `scope/page/pages/hasMore/onChange` 旧 props，内部用 `vocab.page.status` 生成 `summary`、把 `hasMore` 转成 `pages` 语义后渲染 `Pagination`；`WordPopover` 同样改薄适配器：旧 props `word/context/x/y/onClose/onToggleFavorite/isFavorited/onSwitchWord` → `WordCard target={{word,context,start:0,x,y}}` + `onRetarget`（`onSwitchWord` 直通）。**若适配器无法在 1 个 PR 内通过 tsc + 现有脚本，则撤回别名承诺并直接改全部调用点**（不允许「props 兼容」的口头承诺）。`ImportedBooksShelf` 骨架屏保留。
- **预估**：4.5 人日（G12 1.5 + G2 1.0 + G14 0.75 + G13 0.5 + 词卡 0.75）。

### B5 · 高风险交互件（Tabs/Segmented/WordHighlight/Vocab/Progress/Field）

- **范围**：G7-05..08、G9-01..04、G10-01..08、G15-01..11、G17-01..07、G20-01..03、G21-01..02（39 行；G22 保留行已移出）。
- **入口条件**：B4 全部出口（含 B4-P0 与其余）绿；`scripts/reader-layout-test.mjs` 与 `highlight-difficulty-test.mjs`/`cefr-autotranslate-test.mjs` 在迁移前先跑一遍留基线；确认 `data-word-hit`/`data-lookup-context`/`data-lookup-start`/`data-highlight` 冻结；原生 select→Segmented 的脚本改法已评审（§5.4）。
- **出口条件**：① 全站 tab 只有 nav/panel 两种皮肤（`grep "role=\"tablist\""` 4 处，全部来自 `ui/Tabs`）；② 8 处分段统一度量，`role=radiogroup`/`aria-checked`，**2–5 项**（6 项起走 Tabs/Menu）；③ 全站只有一套 ruby（`grep "text-purple-300/90\|text-zinc-400/90"` = 0），字幕/句子包/阅读器点词行为符合 IX-21（点击/键盘切词，hover 不切词）；④ 单词本移动端首屏不出现 8 tab 溢出，词表行桌面 `<table>`、来源可点规则一致；⑤ 11 处进度 `role=progressbar` 全覆盖、无渐变；⑥ 5 个搜索框 + 阅读器/账户/开始学习字段统一 `Field`；⑦ 全部现有 Playwright 脚本（含改后的 `reader-layout-test.mjs`）通过；⑧ `npm run check:i18n`/`check:library`/`build` 绿。
- **回滚策略**：**逐组件独立分支**：Tabs → 各调用点；Segmented → 逐处（App/ShowBrowser/Auth/Sentence/Reader×2/Language/StartLearning）；WordHighlight → 先 `ClickableWords` 替换（保留 `HighlightedText` 旧导出），再 SentenceText，再阅读高亮；任何一步脚本失败 → 只回滚该步，`TranscriptBlock` 的旧 ruby 保留到批末。`StartLearning` select→Segmented 与脚本修改必须同一 commit（否则测试红）。
- **保留的旧别名**：`TranscriptBlock` 的 `HighlightedText`/`ClickableWords` 导出保留到 B5 末；`VocabPagination` 适配器在 B5 末删除；`reading.highlight` 的 `data-highlight` 永远保留（不是别名，是测试契约）。
- **预估**：4.5 人日（WordHighlight 1.25 + Tabs 0.75 + Segmented 0.75 + Progress 0.5 + Field 0.5 + Vocab 0.75）。

### 4.6 批次依赖图

```
A2 token 配置（前置 PR）
        │
        ▼
B1 基座（60）───────────────► B2·P0（20：Dialog/Confirm/Toast）
   ▲                                   │
   │ 并行（文件不重叠）                  ▼
W1/B0 导航（A3）                 B4-P0（4 + StateView）
                                        │
                                ┌───────┴────────┐
                                ▼                ▼
                        B2·尾（G3-02）      B3 壳/页头（37）
                                                 │
                                                 ▼
                                        B4 其余（61）
                                                 │
                                                 ▼
                                        B5 高风险（39）
```

- **B1 与 W1/B0 导航可并行**：文件边界写死在 B1 入口；不得把导航改造混进 B1 的 commit。
- **B2 与 B4-P0 的依赖方向**：`G3-02` 用 `LoadingState`，因此 B2 只先做 20 行 P0 切片；`G3-02` 等 B4-P0 之后。
- **B3 与 B4 不并行**：`G7-03`（B4）用 B3 的 `Badge`；B3 与 B4 都改 `VocabularyBookScreen`；声明并行会产生同文件冲突与「Badge 未就绪」的假依赖。
- **B2 与 B3 的先后不可交换**：`ChannelVideoList`（I-02 P0）必须先在 B2 修完，再谈壳的一致性。
- **B4-P0 优先于 B4 其余**：I-01 是 P0，不能压到批末（原方案把 I-01 压在 B4 尾部是风险/价值错配）。

---

## 5. 风险与兼容

### 5.1 样式回归

**先看等价性**（A2 §2.5 / §5 / §6 的映射，值相同则风险低）：

| 旧值（高频） | 新 token | 是否等价 | 结论 |
|---|---|---|---|
| `border-white/5`（375） | `border-line-subtle` | ✓ 同 `rgba(255,255,255,.05)` | 零风险 |
| `bg-zinc-900/40`（80） | `bg-surface/40` | ✓ 同 `#18181b` | 零风险 |
| `bg-zinc-800/60`（125） | `bg-surface-2/60` | ✓ 同 `#27272a` | 零风险 |
| `text-zinc-400` | `text-fg-secondary` | ✓ 同 `#a1a1aa` | 零风险 |
| `bg-[#09090b]`（35） | `bg-app` | ✓ 同 `#09090b` | 零风险 |
| `rounded-2xl` 卡片 | `rounded-card` | ✓ 同 16px | 零风险 |
| `text-zinc-50` | `text-fg-primary` | ✗ `#fafafa` vs `#f4f4f5` | 轻微变暗，需截图 |
| `text-zinc-600`（87） | 信息类 `fg-secondary` / 装饰 `fg-muted` | ✗ 明显变亮 | **有意修复 V-03**，需逐屏确认不是「变糊」 |
| `rounded-3xl` 普通卡片（21） | `rounded-card`（16） | ✗ −8px | **有意修复 V-09**，需产品确认 |
| `h-11` 主/次按钮 | `h-control-lg`（40） | ✗ −4px | 按钮组高度/对齐会变，需截图 |
| `h-9 rounded-xl` | `h-control-md rounded-control`（8） | ✗ 圆角 −4px | 顶栏/单词本/管理台需截图 |
| `shadow-2xl shadow-black/60` | `shadow-elev-3` | ✗ 值不同 | 弹窗深色层叠需截图 |
| `blue-*`（473） | `brand-*`（`#0A84FF` vs `#3b82f6`） | ✗ 明显变亮 | 见 §5.7 扫尾；逐文件确认 |

**四类高风险回归与对策**

1. **卡片圆角/内边距整体变化（B4）**：13 个 `CARD` + 56 处内联字面量统一到 16/20 或 24，视觉变化最大。对策：先出「迁移前/后」四页截图（375/1024/1440），产品确认 `panel` 的分配表（内容页主操作面板、练习复习主卡）后再动；其余按文件分批，不一次改全站。
2. **按钮高度 44→40（B1）**：Review/Placement/Quiz 的 `h-11` 变 40，可能影响「3 个按钮一行」的换行与点击区。对策：保留 44 命中区（`min-h-11` 在 `pointer:coarse`），桌面截图对比按钮行；如果某屏因此换行，优先调布局而不是改 token。
3. **字号 19/10/13 归入阶梯（B4/B5）**：`SentenceText` 19→16/17 会让句子包行高变化，`text-[10px]`→11px 会让徽章变宽。对策：句子包单独截图 + 行高（`leading-[2.6]`）逐句核对；徽章用 `CountBadge` 固定 18×18 不受影响。
4. **阴影/材质变化（B2）**：词卡/toast/弹窗的 `shadow-[...]`→`elev-*`，在纯黑背景上肉眼差异小但在灰底截图可见。对策：A5 的视觉回归清单把它列为「允许差异」并记录基线截图（附录 D）。

**不允许的「顺手改」**：迁移组件时**不**改业务文案、不改间距节奏（`space-y`/`gap`）、不改布局断点——这些属于 A2/A5 或其他批次。每行映射的「迁移动作」只做该行写的事。

### 5.2 行为变化（D-01/D-02 与返回）

| 变更 | 影响 | 控制 |
|---|---|---|
| 页面级 X → ←（G8-04/05/17/18/19，D-04） | 任务页（复习/报告/考试/定位/能力）的退出图标从 X 变箭头；`aria-label` 从「关闭」变「返回<父级>」（`parentLabel` 由 A3 `backLabelFor` 提供） | 测试 id 改名登记（§5.4）；**业务退出**（放弃考试/重置定位）≠ 导航关闭：仍按 IX-24 弹 ConfirmDialog，控件在页内/SubHeader trailing，不再用 X；I-11 的「返回」语义由 A3 的 `back()` 提供，A4 只传 `onBack` |
| BackButton 统一 `back()` | 有历史回上一屏，无历史回父级（A3 NM-04/§4） | **A4 不实现 history**；`onBack` 仍调用 App 现有 `back()`；A3 改造 `useNav` 后自动生效，组件无需再改 |
| 词卡从 `z-[90]` 降到 `z-popover`(60) | 与 Dialog(50)/Toast(100) 的层序变化 | 验收：词卡在 Dialog 上打开时被 Dialog 遮住？——按 A2 设计词卡高于 Dialog 内容（60>50），但低于 toast；若出现「词卡盖住弹窗」的业务场景，走 §6.3 记录 |
| Dialog 打开锁滚动 | 页面滚动位置在关闭后恢复 | 记录 `scrollTop` 并在关闭时恢复（A2 C4 行为 3/6）；iOS Safari 用 `overflow:hidden` + `position:fixed` 兜底（实现细节，需真机） |
| Toast 位置/时长变化 | 错误停留 8s 而非 6s；移动端不再压底栏 | 用户可感知但不阻塞；A5 QA 项「toast 不遮底栏」 |
| `window.confirm` → ConfirmDialog | 删除操作的确认文案/按钮变中文；默认焦点在「取消」 | 删除后的 toast 与列表更新逻辑不变；失败保留条目 |
| 收藏星标乐观更新（G7-09） | 点击立即变实心；失败回滚 | 行为在 App（A3 IX-22），A4 只保证组件 `aria-pressed`/触屏常显；不改变 App 的乐观逻辑 |

**D-01/D-02 的边界（写死）**：URL 前缀、push/replace、深链兜底、滚动恢复**全部归 A3**。A4 的组件（`Tabs`/`Segmented`/`BackButton`/`Dialog`/`WordCard`）只发语义事件（`onChange`/`onBack`/`onClose`），**不得**自行改 hash 或调用 `history.*`。验收命令：`grep -rn "history\\.\\|location.hash" frontend/src/components/ui/` 必须为 0。

### 5.3 i18n

1. **P0 例外（V-06）**：**31 个英文键**（G0-01..12）在 B1/W2 全部改为中文，vi-VN 同批补齐；`sentences.day` 裁决为**同批中文化（第 32 条，不计入 31 键，CI 白名单不含它）**。`check-i18n.mjs` 只校验结构对齐，**不能**替代人工检查——B1 出口用「主要链路无英文」人工走查（视频处理 → 估价 → 本地剧集 → 历史删除 → 订阅空态/季集标签）。
2. **新增键（附录 C）**：组件通用文案新增 8 个键（加载失败/重试/分页/返回父级/放弃更改等），必须 zh-CN + vi-VN 同时加，否则 `check:i18n` 失败。
3. **组件不硬编码业务文案**：`Button`/`Dialog`/`EmptyState` 等只接受字符串或 ReactNode；`EmptyState` 的默认标题从 i18n 取（`errors.loadFailed`），调用方可覆盖。
4. **文案层级**：字段级内联（Account/BookImport）→ 组件内 `error` prop；操作级 → toast；页面级 → `ErrorPanel`。同一个错误不得同时出现在 toast 和 ErrorPanel（IX-02）。
5. **aria 也算文案**：`aria-label` 里的英文由 G0-04 一起修（`topbar.logoAlt` 等）；`BackButton` 的 `aria-label` 用 `nav.back` + 父级名，新增 `nav.backTo`。

### 5.4 测试选择器（`data-testid` / `data-*`）

**现状**：`frontend/src` 内有 674 个 `data-testid`（去重），`scripts/*.mjs` 直接依赖其中 77 个；另有 `data-word-hit` / `data-lookup-context` / `data-lookup-start` / `data-highlight` 四个**非 testid 契约属性**被点词与高亮脚本使用。

**冻结规则（B1 起生效）**

1. 迁移时 **testid 挂在新的最外层可交互元素上**；内部结构重写不构成改名理由。
2. 必须原样保留的契约属性：`data-word-hit`、`data-lookup-context`、`data-lookup-start`、`data-highlight`（`WordHighlight` 重写时逐句核对）。
3. 高风险改名**只允许**在附录 B 登记过的情况下发生，且同一 commit 内改脚本；不改脚本的改名视为回归。
4. `data-testid` 只增不删；`scope` 派生的 id（如 `vocab-page-*`）由 `Pagination` 的 `scope` 参数保证与旧值一致，必要时用 `testIds` override。
5. 每个批次出口跑一遍**选择器冒烟脚本**（新增 `scripts/check-ui-selectors.mjs`，由 A5 落地；A4 先在批次出口手工执行附录 B 的清单）。

**已知必须同批修改的脚本点**

| 旧选择器/用法 | 迁移后 | 修改位置 | 批次 |
|---|---|---|---|
| `[data-testid=start-mode-select]` + `selectOption('read')` | `[data-testid=start-mode-read]` + `click()` | `scripts/reader-layout-test.mjs:458` | B5（G10-08） |
| `[data-testid=video-url-input]` | 不变（`Input testId` 透传） | 同上 `:461` | B5（G17-07） |
| `word-popover*` | 不变 | 多处 | B4（G7-01） |
| `[data-word-hit]` / `[data-lookup-context]` | 不变（属性契约） | `reader-layout-test` 等 | B5（G7-05..07） |
| `review-close` / `report-close` / `ability-close` | `review-back` / `report-back` / `ability-back` | 现有脚本 0 引用；A5 QA 需同步 | B3（G8-04/05/18） |
| `library-*` / `book-*` / `vocab-axis-*` / `share-card-*` | **不变** | 现有脚本依赖 | 全批 |

### 5.5 A/B 并存（不做运行时开关）

项目没有 feature flag 基础设施，**不引入**运行时开关（会把一致性治理变成双份维护）。采用**文件级并存**：

1. **新增即并行**：`components/ui/*` 是纯新增，旧实现继续可用；一个调用点没改完不影响构建。
2. **旧文件保留到批末**：旧 `WordPopover`/`VocabPagination`/`Dialog` 壳在对应批次出口前不删；出口时用 `grep` 证明 0 引用再删。
3. **别名过渡（W6 修正）**：`TranscriptBlock.ClickableWords`→`ui/WordHighlight` 可保留 `export { 新 as 旧 }` 一版；但 `WordPopover`→`WordCard`、`VocabPagination`→`Pagination` 的旧 props **不兼容**，不得只写 `export { 新 as 旧 }`。二者必须提供薄适配器（映射旧 props，见 B4「保留的旧别名」），并在 1 个 PR 内通过 `tsc` + 现有脚本；做不到就撤回别名承诺、直接改全部调用点，删除条件写进批次出口。
4. **同屏不共存**：同一页面/弹窗不得同时渲染新旧两个实现（会出现双焦点/双滚动锁）；若某屏迁移失败，回滚该屏而不是保留双份。
5. **分支与提交**：每批一个分支（`a4/b1-atoms` …），每组件/文件组一个 commit，commit message 写 `refactor(ui): ...`；不混入 A3 的导航提交、不混入 A2 的 token 配置提交（token 配置作为 B1 的前置 PR）。

### 5.6 禁止一次性大爆炸

- **禁止**对 62 个组件跑一次全仓 `sed`/codemod；卡片字面量迁移必须按附录 A 的文件清单逐文件 review（每文件一个 commit）。
- **禁止**在一个批次里同时改「组件视觉」与「URL/back 行为」；行为改动只能来自 A3 的独立提交。
- **禁止**为了通过 `tsc` 而给新组件加 `any`/`@ts-ignore`；旧 props 用兼容层（`Omit` + 默认值）而不是关类型。
- **批次规模**：单批 ≤1 周；单 commit ≤1 组件或 1 文件组；每个 commit 都能独立 revert 且构建绿。
- **失败处理**：任一批次出口不达标 → 停批，先修复或回滚该批，不带病进入下一批；门禁 2 只认「批次出口证据」，不认「大部分完成」。

### 5.7 token 扫尾（与组件迁移同行但单独验收）

A2 的 T-02..T-15 正则门禁**不能**在 B5 结束时立刻全绿：颜色/字号/圆角/`blue-*` 的字面量分布在 42 个（`blue-`）、40 个（`zinc-600`）、52 个（`text-[Npx]`）文件中，很多文件不在本次组件映射的「组件行」里（如 `ModelBar.tsx`、`LanguageMenu.tsx`、`ProfileScreen.tsx`、`VideoPlayer.tsx`、`TranscriptView.tsx`；其中 `ProfileScreen` 是 `AccountScreen` 的薄包装、`TranscriptView` 是 `TranscriptBlock` 的滚动容器）。

- **归属**：token 扫尾是 A4 的**并行工作流**（B4/B5 各文件访问时顺手完成），不增加组件映射行；本表未列出的模板/容器文件（`ModelBar.tsx`、`LanguageMenu.tsx`、`ProfileScreen.tsx`、`VideoPlayer.tsx`、`TranscriptView.tsx` 等）由 B4/B5 的「touch-and-converge」覆盖。
- **验收**：A5 的 `check-design-tokens.mjs` 分两档开启——B3 出口开「z/字号/圆角/`zinc-600`」；B5 出口开「无 `blue-*`/`purple-*`/`shadow-[`/裸 `transition`」。若上线窗口早于扫尾完成，未开档的规则记入 §7 不做清单，**不得**假装通过。
- **不做**：不把 `blue-*` 一次性替换成 `brand-*` 后不截图；品牌蓝变亮是可见变化，按屏确认（附录 D）。

---

## 6. 门禁 2 自检

### 6.1 覆盖率

#### A1 「组件重复」C-01–C-16 → 本方案归属

| A1 | 一句话 | 本方案组 | 行数 | 覆盖 |
|---|---|---|---:|---|
| C-01 | 按钮 4 类 + 内联卡片 | G1-01..27 + G2-01..15 | 27 + 15 | ✅ 全量（内联 61 处实测、B4 实际迁移 56；A1 记 52） |
| C-02 | 弹窗 13 个实现，能力集不一致 | G3-01..14 | 14 | ✅（实测 14，见 §6.3 Q-A4-06） |
| C-03 | 5 个点词 handler（含数据缺陷） | G6-01..08 | 8 | ✅ 含数据修复 |
| C-04 | 两套 ruby 高亮渲染 | G7-05..08 | 4 | ✅ 单一 ruby |
| C-05 | 4 套 tab 视觉语言 | G9-01..04 | 4 | ✅ |
| C-06 | 分段控件 4 种度量 | G10-01..08 | 8 | ✅ |
| C-07 | 4 套徽章尺寸/字号 | G11-01..05、09..10 | 7 | ✅ 含 99+ 格式 |
| C-08 | 7 份 `formatClock` + 2 份倒计时 | G16-03..12 | 10 | ✅ |
| C-09 | `cn()` / `bilingualReadingWidth()` 放错层 | G16-01..02 | 2 | ✅ |
| C-10 | 两套「快速输入」并存（一套死代码） | G18-01 | 1 | ✅ 删除 |
| C-11 | 两套列表行样式 | G14-01..05 + G2-15..17 | 5 + 3 | ✅ |
| C-12 | 两套进度条 | G15-01..11 | 11 | ✅ |
| C-13 | 两套「来源标签」渲染 | G11-06..08 + G7-03 | 3 + 1 | ✅ |
| C-14 | 两套「复制/分享」浮层 | G21-01..02 | 2 | ✅ 保留 + 共用底层 |
| C-15 | 两套「删除/移除」图标按钮 | G14-06..11 | 6 | ✅ |
| C-16 | 组件文件职责过载（7 个 >1,000 行） | G22-01..07 | 7 | ✅ 本阶段不拆（§7） |

> 行数按 A1 概念归组；同一行可同时服务多条 A1（如 G2-15 同时服务 C-01/C-11），因此上表行数之和不等于 §3 的 **222** 唯一行数。

#### 与 I/N 相关的重复（A1 条目 → 组件部分归属）

| A1 | 组件侧归属 | 说明 |
|---|---|---|
| I-01 | G12-17..20 | 失败当空态改 ErrorPanel + 三态枚举 |
| I-02 | G3-06 | 频道弹窗换 Dialog（P0） |
| I-03/I-04 | G3 全组 | role/焦点陷阱/滚动锁/回填 |
| I-05 | G4 | 4 处 `window.confirm` → ConfirmDialog |
| I-06 | G7-09 | 星标组件 `aria-pressed` + 触屏常显；乐观逻辑在 App（A3） |
| I-07/I-08/I-09 | G12 | 加载/空/错误三态 |
| I-10 | G5 | Toast 位置/时长/去重 + 离线标记移位 |
| I-11 | G8 | 21 处返回/关闭 → BackButton/SubHeader |
| I-12 | G6 + G20-03 | 工厂 + 来源可点规则 |
| I-13 | —（非组件） | 游客门禁在入口逻辑（A3 IX-17） |
| I-14 | G8-01/12 + A3 | 组件侧只统一学习页头/骨架；先路由后加载归 A3 IX-12 |
| I-15 | G7-02 | 词卡边界夹取 |
| I-16 | G7-09 + G14-06 | 触屏常显 |
| I-17 | G10-08 | 原生 select → Segmented |
| I-18 | G13 | 分页/步骤统一 |
| I-19 | G1 + G12 | 按钮 loading/disabled 状态 + 反馈层级 |
| I-20 | —（非组件） | 平台返回，A3 NM-14 暂不实现 |
| N-01..N-08、N-11..N-16、N-18 | —（A3 导航逻辑） | 不由 A4 组件映射覆盖；A4 只提供 BackButton/SubHeader 等承载体 |
| N-09 | G8-13 | 免费库文章复用学习页 SubHeader |
| N-10 | G11-09..11 | 计数格式单一来源（原 G16-13..15 为重复登记，已合并） |
| N-17 | G19 + A3 D-03 | 壳保留改造；任务型/面板型出口由 A3 定 |

**结论**：A1 的 16 条 C 类 **全部有归属**；I/N 中属于组件实现的条目全部有归属，属于导航/守卫/URL 的条目明确划归 A3（不是遗漏，是分工）。**未归属项 = 0**。

### 6.2 每行有迁移步骤（可脚本核对）

**222 行**全部满足：8 列、迁移动作以 6 种动词之一开头、优先级 ∈ {P0,P1,P2}、预估为数字、验证 ∈ {V0..V4}、且每行写明旧实现 `文件:行`；G22 的 7 条保留行在 §3.23（ID 为 R-01..R-07），不参与本计数。核对脚本见 §6.5（输出 `rows=222 bad=0 dup=0 out_of_range=0`）。

### 6.3 与 A2/A3 的缺口与裁决（不是冲突，是待补定义）

| ID | 问题 | 证据 | 裁决 | 需谁确认 |
|---|---|---|---|---|
| **Q-A4-01** | A2 规定 primary/tab 选中/分段滑块用 `bg-zinc-100`，但 tokens §12 未定义该 token，违反「组件不写裸色值」 | `components.md` C1/C5/C6 的配方；`tokens.md` §12 colors 无 zinc-100 | 新增 `colors.control = '#f4f4f5'`（= zinc-100）→ 类名 `bg-control`；A2 tokens §12 补一行（登记，不自行改 A2 文件） | A2（文档回写） |
| **Q-A4-02** | 4 份 `OPTION_BASE`（Placement/Quiz/Exam/Course）无对应组件；A2 C2 的 variant 只有 card/panel/interactive/stat | `PlacementScreen:76`、`QuizScreen:36`、`ExamScreen:92`、`CourseScreen:79` | 在 `ui/Card.tsx` 新增 `OptionCard`（radio 语义，见 §2.2）；请求 A2 在 C2 增补一行 | A2 |
| **Q-A4-03** | A2 §18 把 `resolveFavoriteSource` 的目标路径写成 `lib/vocabulary.ts`，但该函数实际在 `lib/favoriteSource.ts`，返回类型也没有 `canOpen` | `lib/favoriteSource.ts:27`（返回 `{kind,ref,title}`）；`lib/vocabulary.ts` 是词表 API 模块 | **扩展 `lib/favoriteSource.ts`**（加 `canOpen`），不新建 `lib/vocabulary.ts` 版本；A2 §18 路径修正 | A2 |
| **Q-A4-04** | A2 C9 Pagination API 只有 `page/pages/hasMore`，管理台是 offset/total | `AdminConsoleScreen:1185` `offset` + `PAGE_SIZE`；`usersPage.total` | 组件保持 `page/pages/hasMore`；调用方算 `page=offset/PAGE_SIZE+1`，`pages=ceil(total/PAGE_SIZE)`；组件不感知 offset | A4（已定） |
| **Q-A4-05** | A2 C11 说 TopBarTabs 用 Tabs，但 BottomBar 是 icon+label 竖排，不适用 `skin=nav` | `BottomBar.tsx:33-56` | TopBarTabs 用 `Tabs skin=nav`；**BottomBar 保留自有布局**，只用 `CountBadge` + token；不强行套 Tabs | A4（已定） |
| **Q-A4-06** | A2 说「13 个浮层」，实测 14（多出 ProcessingOverlay 与 guest-auth，合计 14 个壳；A1 的 13 未含 guest overlay） | `App.tsx:3392`、`:3524`；G3 清单 | 以 14 为准；ProcessingOverlay 归 Dialog busy，guest-auth 归 Dialog fullscreen sheet；不新增第 15 个壳 | A4（已定） |

> 没有发现 A2 与 A3 的**相互矛盾**：视觉以 A2、行为以 A3 的切分在 6 个缺口上都能落成实现。A2 的 `bg-zinc-100` 与 A3 无关；A3 的 D-01/D-02 与 A4 组件无重叠（组件不碰 history）。

### 6.4 首批（B1）可执行性

**前置（1 个 PR，A4 自己）**：`tailwind.config.js` 合入 tokens §12（+ `control`）、`index.css` 落 CSS 变量/`::selection`/焦点环修正/`@layer utilities`（`pb-safe-nav`、`bottom-safe-nav`、`scroll-pb-safe-nav`、`scroll-pt-chrome`）。这是纯配置，不改变现有页面（旧类名仍生效），可独立合并/回滚。

**B1 触碰文件**：`lib/{cn,time,format,reading-layout,word-lookup}.ts`（新增 5）、`components/ui/Button.tsx`（新增 1；Badge 在 B3）、18 个按钮常量文件、`App.tsx`（5 handler + formatClock；**不碰路由分支**，与 W1 并行）、6 个 `formatClock` 文件、`i18n/zh-CN.json` + `vi-VN.json`（31 键 + `sentences.day`；可与 W2 合并执行）、删除 `InputScreen.tsx`。

**可执行性证据**：① 所有旧实现都有精确行号（§3 G0/G1/G6/G16/G18）；② API 已用 TypeScript 签名固定（§2.2）；③ 入口/出口可命令化（`grep` + `tsc` + `check:i18n`）；④ 不依赖 A3 的 URL 改造（组件只发事件）；⑤ 视觉差异已预先登记（§5.1 的 h-11→40 与 `zinc-600`→`fg-secondary`）。

**B1 首日可完成的最小切片**：`lib/cn.ts` + `ui/Button.tsx` + `AccountScreen`（1 个文件）→ tsc/build → 截图对比账户页按钮；证明模式后再铺开其余 17 个文件。

### 6.5 自查命令（可直接跑）

```bash
cd /Users/piece/Desktop/Me/EnglishLearning/yt-bilingual-app
python3 - <<'PY'
import re, os, glob
acts = ('替换','包裹','保留别名','改名','保留','删除')
paths = {}
for p in glob.glob('frontend/src/**/*', recursive=True):
    if os.path.isfile(p):
        paths[os.path.basename(p)] = p
rows = bad = dup = out_of_range = 0
seen = set()
for i, line in enumerate(open('docs/design-governance/component-consolidation.md', encoding='utf-8'), 1):
    if not re.match(r'^\| G\d+-\d+ \|', line):
        continue
    rows += 1
    c = [x.strip() for x in line.strip().strip('|').split('|')]
    rid = c[0]
    if rid in seen:
        dup += 1
        print('DUP', i, rid)
    seen.add(rid)
    ok = (len(c) == 8 and any(a in c[3] for a in acts)
          and c[5] in ('P0', 'P1', 'P2', '**P0**')
          and re.match(r'^\d+(\.\d+)?$', c[6].split('（')[0].strip())
          and re.match(r'^V\d$', c[7]))
    if not ok:
        bad += 1
        print('BAD', i, c[:2])
    for f, a, b in re.findall(r'`([A-Za-z0-9_./-]+\.(?:tsx|ts)):(\d+)(?:-(\d+))?`', line):
        p = paths.get(os.path.basename(f))
        if not p:
            continue
        n = sum(1 for _ in open(p, encoding='utf-8', errors='ignore'))
        hi = int(b) if b else int(a)
        if int(a) < 1 or hi > n:
            out_of_range += 1
            print('OUT_OF_RANGE', i, f'{f}:{a}' + (f'-{b}' if b else ''), f'actual={n}')
print(f'rows={rows} bad={bad} dup={dup} out_of_range={out_of_range}')
PY
# 期望：rows=222 bad=0 dup=0 out_of_range=0
```

### 6.5b W6 行号修正清单（7 处）

| 文档位置 | 原引用 | 实际 | 说明 |
|---|---|---|---|
| G7 组概览 / G7-07 | `SentenceText.tsx:9-40` | `SentenceText.tsx:19-39` | 文件 39 行；组件从 19 行起 |
| G8 组概览 / G11-11 / §2.3 | `navTabs.ts:40-42`、`lib/navTabs.ts:40-42`、`lib/navTabs.ts:40` | `lib/navTabs.ts:33-35` | 文件 35 行；`formatDueBadge` 在 33–35 |
| §6.5 自查 | — | — | 脚本已加「行号存在」校验，越界即 `OUT_OF_RANGE` |
| §7.3 保留清单 | `ReadingHighlight.tsx:37-90` | `ReadingHighlight.tsx:32-88` | 文件 88 行；`ReadingHighlightToggle` 在 32–88 |

### 6.6 门禁 2 结论

| 检查项 | 结论 | 证据 |
|---|---|---|
| 映射表覆盖率（A1 全部 C 类 + I/N 重复） | ✅ 通过（W6 修正后） | §6.1：C-01..C-16 全归属；I/N 组件部分全归属；未归属 0 |
| 每行有迁移步骤 | ✅ 通过 | §6.5 脚本 `rows=222 bad=0 dup=0 out_of_range=0` |
| 目标组件与 A2/A3 无冲突 | ✅ 通过（6 个缺口已裁决 + W0 契约对齐） | §6.3；缺口均为「A2 未定义/路径笔误」，不改变视觉或行为契约 |
| 首批可执行 | ✅ 通过 | §6.4：前置配置 + 最小切片 + 出口命令；与 W1/B0 并行不冲突 |
| 未归属项 | **0** | §3 共 222 行（221 可执行/登记 + 1 别名），每行有旧实现、动作、批次归属（§4）；G22 保留 7 行在 §3.23 单列 |

---

## 7. 不做清单

### 7.1 本阶段明确不做（阶段边界）

1. **不改任何业务代码、不提交 git**：本文件是方案；`frontend/src` 与 `tailwind.config.js` 保持原样。
2. **不做 A3 的导航改造**：`nav.ts`/`useNav.ts`、URL 前缀（D-01）、push/replace（D-02）、深链兜底、滚动恢复全部由 A3 实施；A4 只在组件层接 `onBack/onChange/onClose`。
3. **不做 A5 的门禁脚本**：`check-design-tokens.mjs`、`check-ui-selectors.mjs`、CJK 规则、PR 模板由 A5 落地；A4 只提供可 grep 的规则与 §6.5 自查脚本。
4. **不新增依赖**：不引入 shadcn/ui、Radix、Headless UI、`@tanstack/*`；只用现有 `clsx`/`tailwind-merge`/`framer-motion`/`lucide-react`。
5. **不做亮色主题**：token 只覆盖暗色（A2 §14 未决已裁决）。

### 7.2 留给上线后 / 下一轮

| 项 | 原因 | 归属 |
|---|---|---|
| 7 个 >1,000 行组件的文件拆分（C-16） | 拆分是结构性重构，与「组件收敛」分开验收；本阶段只抽常量与子组件，文件净减 | 上线后 / A5 之后 |
| 分享卡与阅读器选区浮层合并（C-14） | 生命周期不同（Canvas 生成 vs 选区锚定）；合并需重做交互 | 上线后 |
| NavShell 结构重写（侧栏+顶栏双标题、D-03 视觉细化） | D-03 的行为已由 A3 定；重写壳会扩大回归面 | 下一轮 |
| `filterChip`（免费库等级、短语筛选）抽象 | A2 无 Chip 契约；先 token 化，避免与 Segmented 语义重叠 | A5 候选 |
| 死代码删除的**执行**（InputScreen） | 方案已定为 B1 零风险删除；若实施窗口裁掉 B1，则与 A5 的死代码扫描一起做（不阻塞任何功能） | B1 或 A5 |
| `VocabAxis` 彩虹轴重设计 | 需要产品确认「能力轴」的语义色，不只是换 token | A5/设计 |
| PWA standalone 返回拦截（I-20）、理解题 history guard（D-12/Q-04） | 需真机验证，A3 已标暂不 | 上线后 |
| 移动端真机视觉/对比度精确 WCAG 计算 | A1 静态审计盲区 | A5 阶段 3 |
| 课程生成相关页面的内容质量 | 章程 §1 已排除 | 不在本轮 |

### 7.3 被本方案**刻意保留**的旧实现（不是遗漏）

| 保留项 | 位置 | 理由 | 后续 |
|---|---|---|---|
| `BottomBar` 自有布局 | `BottomBar.tsx` | `Tabs skin=nav` 是文字 tab；底栏是 icon+label，强行套用会破坏 44 命中区 | 只做 CountBadge/token |
| `filterChip` / 等级筛选 chips | `VocabularyBookScreen:656`、`LibrarySection:334+` | 无契约，抽组件会引入第 5 种「chip」语义 | A5 记候选 |
| `VocabAxis` | `VocabAxis.tsx` | 不是进度条；保留组件，只换色 | 下一轮重设计 |
| `ReadingHighlightToggle` | `ReadingHighlight.tsx:32-88` | 开关有专属语义（阅读难度提示），非通用 Switch | 保留，只换 token |
| `ModelBar` / `LanguageMenu` 下拉 | `ModelBar.tsx`、`LanguageMenu.tsx` | 不是弹窗壳，是锚定菜单；A2 未定义 Menu | token 扫尾 + 后续 Menu 组件 |

---

## 附录 A · 内联卡片字面量清单（61 处；B4 实迁 56，按文件）

> 匹配 `rounded-2xl|rounded-3xl border border-white/5 bg-zinc-900/40`；`InputScreen` 5 处随 G18 删除，存量 56 处。迁移动作统一为 `Card`/`ListRow`（G2-15），按文件分批 commit。

| 文件 | `rounded-2xl` | `rounded-3xl` | 合计 |
|---|---:|---:|---:|
| `AccountScreen.tsx` | 3 | 1 | 4 |
| `AdminConsoleScreen.tsx` | 7 | 0 | 7 |
| `VocabularyBookScreen.tsx` | 1 | 0 | 1 |
| `BlogScreen.tsx` | 2 | 0 | 2 |
| `ImportedBookReaderScreen.tsx` | 1 | 0 | 1 |
| `ImportedBooksShelf.tsx` | 1 | 0 | 1 |
| `WelcomeScreen.tsx` | 1 | 0 | 1 |
| `ExamScreen.tsx` | 4 | 1 | 5 |
| `ContentScreen.tsx` | 2 | 2 | 4 |
| `StartLearning.tsx` | 1 | 1 | 2 |
| `LibraryArticleReader.tsx` | 1 | 0 | 1 |
| `HomeRecommendations.tsx` | 3 | 0 | 3 |
| `DiscoverScreen.tsx` | 1 | 1 | 2 |
| `LibrarySection.tsx` | 3 | 0 | 3 |
| `BookReaderScreen.tsx` | 2 | 0 | 2 |
| `BooksSection.tsx` | 1 | 0 | 1 |
| `PracticeScreen.tsx` | 1 | 1 | 2 |
| `CourseScreen.tsx` | 1 | 1 | 2 |
| `ReaderScreen.tsx` | 4 | 0 | 4 |
| `PlacementScreen.tsx` | 0 | 1 | 1 |
| `ReportScreen.tsx` | 0 | 1 | 1 |
| `AbilityScreen.tsx` | 0 | 1 | 1 |
| `SentencePacks.tsx` | 0 | 1 | 1 |
| `TodayWorkbench.tsx` | 0 | 3 | 3 |
| `NovelCourseCard.tsx` | 0 | 1 | 1 |
| `InputScreen.tsx`（删除） | 0 | 5 | 5 |
| **合计** | **40** | **21** | **61** |

## 附录 B · 测试选择器冻结清单（脚本依赖，按风险排序）

| 风险 | 选择器/属性 | 使用脚本 | 迁移规则 |
|---|---|---|---|
| 高 | `[data-word-hit]`、`[data-lookup-context]`、`[data-lookup-start]` | `reader-layout-test`、`highlight-difficulty-test`、`cefr-autotranslate-test`、`verify-books` | 属性名与语义不变；`WordHighlight` 重写后逐项 grep 确认 |
| 高 | `[data-highlight]` | `highlight-difficulty-test`、`verify-difficulty` | 保留 `data-highlight="1"` |
| 高 | `start-mode-select` + `selectOption` | `reader-layout-test:458` | 同批改脚本（G10-08） |
| 高 | `word-popover`、`word-popover-overlay`、`word-popover-word` | `reader-layout-test` 等 | 保留（G7-01） |
| 中 | `library-*`（section/tab/level/video-card/video-badge/row/reader） | `check-library-ui.mjs`、`cefr-autotranslate-test` | 原样保留 |
| 中 | `book-*`（book-reader/paragraph/chapter/en/translation/series/progress/error） | `verify-books`、`books-all-shots`、`reader-layout-test` | 原样保留 |
| 中 | `vocab-list-*`、`vocab-tab-*`、`vocab-axis-*`、`phrase-*` | 多个脚本 | 原样保留 |
| 中 | `share-card-dialog`、`share-card-close` | `capture.mjs` 等 | 保留 |
| 低 | `review-close`/`report-close`/`ability-close` | 现有脚本 0 引用 | 改名 → `*-back`，登记本表 |
| 低 | `nav-tabs`/`bottom-bar`/`top-bar`/`topbar-*` | 少量脚本 | 保留 |
| 低 | `estimate-modal`、`book-import-dialog`、`ios-install-help`、`admin-console` | 0/少量 | 保留 |

## 附录 C · 新增 i18n 键（B1–B5 需补，zh-CN + vi-VN 同步）

| 键 | 用途 | 批次 |
|---|---|---|
| `errors.loadFailed` | ErrorPanel 默认标题「加载失败」 | B4 |
| `errors.loadFailedHint` | 默认说明「请检查网络后重试」 | B4 |
| `errors.notFound` | 404 内容不存在 | B4 |
| `common.retry` | 已存在（重试） | — |
| `common.pageStatus` | 通用分页状态「第 {{page}} / {{pages}} 页」 | B4 |
| `common.pagePrev` / `common.pageNext` | 通用上一页/下一页（替换 vocab 专用键） | B4 |
| `nav.backTo` | BackButton aria「返回{{parent}}」 | B3 |
| `common.discardTitle` / `common.discardConfirm` | Dialog dirty 关闭确认（IX-15） | B2 |
| `a11y.loading` | `sr-only` 加载中（IX-03） | B4 |

> 现有键可复用的：`common.close`、`common.cancel`（B1 改中文）、`common.delete`、`nav.back`、`errors.network`、`errors.httpStatus`、`practice.badge.aria`、`vocab.page.*`（B4 后可保留为 `common.page*` 的别名或删除调用）。

## 附录 D · 视觉验收矩阵（截图基线）

| 屏幕 / 状态 | 375×667 | 390×844 | 1024×768 | 1440×900 | 备注 |
|---|---|---|---|---|---|
| 今日（有历史） | ✓ | ✓ | ✓ | ✓ | 输入槽位置/三卡/标题 |
| 今日（空历史） | ✓ | — | ✓ | — | 空态动作 |
| 内容（首屏 + 右栏） | ✓ | ✓ | ✓ | ✓ | 1024 rail 横排、1280 两栏 |
| 练习（四卡） | ✓ | — | ✓ | ✓ | 定位卡不再跨列 |
| 我的（三组） | ✓ | ✓ | ✓ | ✓ | 组标题/危险区 |
| 学习页（移动单滚动） | ✓ | ✓ | ✓ | ✓ | 字幕区只滚一个容器 |
| 句子精背 | ✓ | — | ✓ | ✓ | ruby/行高/进度 |
| 单词本（tab/表格/分页） | ✓ | ✓ | ✓ | ✓ | 8 tab 溢出、词表行 |
| 弹窗（估价/频道/导入书/分享） | ✓ | ✓ | — | ✓ | Esc/焦点/遮罩 |
| 词卡（左/右/下边缘点词） | ✓ | ✓ | — | ✓ | 不裁切 |
| Toast（错误 + 离线） | ✓ | ✓ | — | ✓ | 不压底栏 |
| 复习/报告/考试/定位（X→←） | ✓ | — | — | ✓ | 头部 h-12 不换行 |

*上游：A1 §3/§6/§7、A2 `tokens.md`/`components.md`/`layout.md`、A3 `interaction-spec.md`/`navigation-model.md`、`gate-1-review.md`。下游：A5 的 `design-gate.md`/`design-qa-checklist.md` 可直接把 §4 的批次出口条件与附录 D 转成 QA 项。*
