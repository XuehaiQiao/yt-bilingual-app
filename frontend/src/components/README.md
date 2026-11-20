# components/ — UI 组件

全部遵循 [设计语言](../../../docs/设计语言.md)。带 `motion.` 的动效统一用标准弹簧参数。

| 组件 | 用在哪 | 职责 |
|---|---|---|
| `ui/StateView.tsx` | 全局 | 异步状态统一视图（C10）：`EmptyState` / `LoadingState` / `ErrorPanel` / `Skeleton`；`page(py-16)/card(py-10)/inline(py-3)` 三档；失败只渲染错误面板 + 重试（`ErrorPanel level=inline` 也用于「保留旧数据 + 刷新失败」），空态只来自成功且为空；错误面板 `role=alert`、加载块 `aria-busy` |
| `AuthScreen.tsx` | 未登录 | 登录/注册门禁：单页两个 tab、邮箱+密码（注册含必填用户名 2–24 字与可选确认密码）、邀请码（`REGISTRATION_OPEN=false` 时必填，可从 `?invite=` 预填）、内测/无找回密码提示、用户名/表单行内错误；成功后由 `AuthProvider` 切进应用 |
| `AppShell.tsx` | 全局 | 应用外壳：≥lg 为 `[Sidebar 240/72][TopBar + Main]` 三栏，md–lg 保留 top tabs，<md 仅精简顶栏 + bottom bar；沉浸式任务子视图（视频/阅读/句子精背/复习/考试/定位）隐藏侧栏与主导航，内容占满宽度 |
| `Sidebar.tsx` | 桌面（≥lg） | 左侧导航栏：品牌、四个一级页（图标+文字+练习到期徽章）、分组快捷入口（学习/内容/管理）、底部账号卡片 + 语言/设置；可折叠为 72px 图标栏（aria-label/title 提示），状态持久化在 `localStorage`；空白页签不在此出现，快捷入口全部复用 App 既有路由 |
| `TopBarTabs.tsx` | md–lg | 四个一级页文字 tab（桌面 ≥lg 由 Sidebar 承担，二者不重复） |
| `BottomBar.tsx` | <md | 手机底栏：四个一级页图标+文字、安全区、练习到期徽章 |
| `InputScreen.tsx` | 首页 | 今日工作台容器：今日头部、能力定位引导条与三张行动卡（继续学习/今日复习/本周报告）、「为你推荐」横排、开始学习输入区（含「搜索你想学的内容」发现入口）、词汇轴、句子精背整宽入口卡、四张 bento 卡（最近学习/本地剧集/订阅/最新视频） |
| `TodayWorkbench.tsx` | 首页 | 今日头部（日期/今日状态/模型栏）、能力定位引导条（无画像：12 分钟定位；有画像：水平区间 + 重测）与三张行动卡（继续学习/今日复习/本周报告），复用设计语言卡片配方；继续卡无记录时引导到下方输入框 |
| `CourseScreen.tsx` | 12 分钟课程（#/app/today/lesson/&lt;id&gt;） | 课程 MVP 全屏视图（specs/029）：S0 介绍 → S1 词卡揭示 → S2–S4 英文段落/可隐藏中文/讲解/2 题即时反馈 → S5 产出与 2 道出口题 → 完成页 score/8、产出与参考样例；游客登录提示；刷新/重进按 attempt 恢复步骤与答案；12:00 倒计时只显示；lesson_start/step_view/step_complete/answer/output_submit/lesson_complete 埋点与卸载 sendBeacon drop；中越与 375/1440；生成课程共用同一屏 |
| `NovelCourseCard.tsx` | 首页 | 「经典小说课程」入口（specs/030）：Pride and Prejudice（Gutenberg #1342）第 1–61 章选择（默认 1）、生成按钮 → POST `/api/course/generate` → `#/app/today/lesson/{id}`；缓存命中同样直达；游客登录提示、409/502/429 行内错误；生成中防重复点击 |
| `RecentLearning.tsx` | 首页 | 「最近学习」聚合列表（视频 + 文章 + 公版书/导入书章节）：类型徽章/标题/来源/进度/学习时间，搜索（标题+副标题、大小写不敏感）、全部/视频/文章/书籍筛选 chips（带数量）、每页 10 条翻页；时间按今天 HH:mm / 昨天 / 日期显示，缺失显示「时间未知」；游客只请求视频+本地书进度、不请求文章/导入书；文章与书索引按需加载一次并在卸载时 abort；空/加载/错误态不阻塞今日三卡 |
| `HomeRecommendations.tsx` | 首页 | 「为你推荐」横排卡片（user request #10）：区间副标题/初步推荐徽章、缩略图+难度徽章+时长+标题+理由、水平滚动、「换一批」seed 轮转、加载/失败/空态；点击整卡复用 `EstimateDialog` 估价流程 |
| `LibrarySection.tsx` | 首页 | 「免费资源」窗（user request #11）：视频/文章分段 tab、55 张预置视频卡（编辑等级 chip/频道/时长/计算带/免费标识）、A1–C2 等级筛选 chips（含数量）、水平滚动、加载/失败/空态；游客可用，点击直接进本地内容，不进入估价流程 |
| `LibraryArticleReader.tsx` | 免费文章 | 本地阅读器（user request #11，2026-11-17 补点词/左右对照）：标题/等级/词数/作者/许可、全部/隐藏译文切换、逐段 en+zh、复用 `ClickableWords`+全局 `WordPopover`（source 标免费文章 id/标题）；≥lg 左右两栏、<lg 上下、隐藏译文单栏；内容来自 `/api/library/articles/{id}`，不挂载阅读 API 客户端，没有「翻译本文」按钮，不触发 `/api/article/*` |
| `VocabAxis.tsx` | 我的·设置 | 高亮难度轴（CEFR A1–C2 六站，见 specs/004）：只决定哪些词被标亮，不是能力评级；选择即写入 localStorage，`showTitle=false` 时由调用方给标题 |
| `SentencePacks.tsx` | 首页 | 句子精背入口卡（5 册 + 进度） |
| `VideoPlayer.tsx` | 学习页 | YouTube 播放器封装：seek/播放暂停命令、倍速、全屏 |
| `LocalEpisodeStage.tsx` | 学习页（本地剧集） | 本地剧集媒体占位卡：剧名/集名、取景图标、模拟播放（播放/暂停、可点击进度、当前/总时长） |
| `TranscriptView.tsx` | 学习页 | 字幕列表：**Apple Music 式跟随滚动**、memo 化（只在换句时重渲染）、用户滚动时暂停跟随 |
| `TranscriptBlock.tsx` | 学习页 | 单句：时间戳、译文显隐、收藏星标、听写模糊；**导出 `HighlightedText`/`ClickableWords`/`cn`** 供他处复用 |
| `TeachingNotesPanel.tsx` | 学习页（侧栏/视频下方） | 「语言点」面板（specs/028）：习语/文化点计数与分组列表（phrase/term、中文 meaning/note、quote、时间），点击条目按 blockId seek；折叠/展开、加载骨架、空态「本课暂无语言点」、错误重试、游客或 403 显示「登录后查看语言点」；不遮挡字幕 |
| `ReadingHighlight.tsx` | 四个阅读器 | 阅读标亮 UI：`ReadingHighlight` 包装 `ClickableWords`（淡琥珀下划线/背景，不拦截点词），`ReadingHighlightToggle` 是工具栏「标亮生词」开关（默认开、localStorage 记忆，切换后即时重算） |
| `BilingualRow.tsx` | 阅读器 | 双语段落布局原语：≥lg 左英右中同段同行（同一滚动容器），<lg 英文在上中文在下；译文隐藏时调用方传 `twoColumn=false` 即英文单栏；英文/译文槽位分离，译文栏不参与点词 |
| `WordPopover.tsx` | 全局 | 点查词典卡：音标/释义/例句/TTS/入生词本；卡片打开后单击另一个单词直接切词（触屏无 hover 也一次命中），点空白才关闭 |
| `SentenceView.tsx` | 句子精背 | 背诵视图：册切换、按天卡片、自测遮中文、复习打卡、搜索、单句分享卡 |
| `ReviewScreen.tsx` | 复习 | 生词复习全屏视图（M2 / specs/013）：今日统计、单卡揭晓释义/例句、Again/Hard/Good/Easy 评分（键盘 1–4、空格揭晓）、暂停词、空态/完成态、错误重试；不排名、不红叉 |
| `QuizScreen.tsx` | 理解练习 | 视频理解题全屏视图（M3 / specs/014）：3 道 MCQ/判断题逐题作答、提交即判分+解析、答错「回看证据」关闭答题并 seek 原声、结果页正确率/逐题对错/错题回看/回首页；键盘 1–4 选择、Enter 提交/继续 |
| `PlacementScreen.tsx` | 能力定位 | 定位测与能力画像全屏视图（M4 / specs/016）：介绍（12 分钟/不能回退/只是区间）→ 32 题逐题作答（进度、12 分钟倒计时、超时自动交卷、跳过、退出作废确认、键盘 1–4/Enter）→ 结果页（CEFR 区间+点估计+置信度+强弱项+1 条建议+后端免责声明）→ 画像页（区间/来源/更新时间/重测确认）；游客可测并提示登录后结果保存更久 |
| `DiscoverScreen.tsx` | 内容发现 | 主题搜索全屏视图（specs/017）：搜索框 + 示例、约 10–20 秒 loading、3–5 张候选卡（缩略图/频道/时长/A1–C1/理由/字幕有或未知/已学过）、「换一批」force、空/失败/degraded 提示与重试；点击候选接现有估价流程，上次结果留在 sessionStorage |
| `ReaderScreen.tsx` | 读文章 | 阅读器全屏视图（specs/019）：我的文章列表、URL/粘贴正文双 tab 导入（loading/SSRF/超限/网络错误可读）、阅读态标题与英文段落、全部/隐藏译文切换、缺译文时翻译（真实进度、失败段可重试）、点词复用 `WordPopover`（source 标文章 id/标题）、滚动节流保存进度并恢复、删除确认、空/错误态、中越双语与 375px；≥lg 左右对照、<lg 上下；段落菜单与选中文本分享卡 |
| `BlogScreen.tsx` | 官方博客 | 官方博客视图（specs/020）：列表（日期/阅读时长/标题/摘要/标签/RSS）→ 详情（`react-markdown` 排版、文章中文标注、来源文章标签）；加载/错误/空态、Giscus 预留（未配置显示「评论即将开放」）、中越双语与 375px；正文来自仓库 `content/blog/*.md`，无 CMS；`publicMode` 去掉 app SubHeader，由公开站容器包裹 |
| `PublicHeader.tsx` / `PublicFooter.tsx` | 公开站（主页/博客/定价/资源） | 公开站共用头尾：品牌回 `/`、`#/blog`/`#/pricing`/`#/resources` 三个入口（<md 折成第二行）、语言切换、随登录态切换的「登录 / 进入学习」CTA；页脚复用仓库链接与「即将上线」占位，绝不渲染 app 外壳 |
| `PublicBlogScreen.tsx` | 公开站 | `#/blog[/<slug>]` 公开博客页：`PublicShell` + `PublicHeader/Footer` + `PublicContainer` 包裹 `BlogScreen publicMode`；列表→文章写入 hash，冷启动深链的「返回列表」用 replace、列表内进入的用 history.back |
| `PricingScreen.tsx` | 公开站 | `#/pricing` 定价页：只陈述「内测免费 / 定价即将公布」，不编造任何价格或扣款承诺；登录/进入学习 CTA |
| `ResourcesScreen.tsx` | 公开站 | `#/resources` 资源页：官方博客、应用内免费库 + Project Gutenberg / Standard Ebooks / LibriVox 合法外链（新标签页），明确版权归权利人 |
| `AccountScreen.tsx` | 用户页 | 登录用户的账号页（specs/023 + 033）：头像占位（首字母）+ 用户名内联改名（`PATCH /api/user/profile`）、邮箱、注册日期；余额卡（`credits` / 本月 AI 花费 `monthSpendUsd` / 今日学习分钟，附「额度由管理员发放」）；设置（界面/翻译语言复用 `LanguageSettingsModal`、默认模型复用 `ModelBar`、高亮难度内联 `VocabAxis`（选择即保存，首次按能力档案高带预填）、安装到桌面复用 `PwaInstallButton`）；关于（版本号、官方博客入口、隐私/协议占位不造假链接）；退出登录与仅管理员可见的「管理控制台」入口（打开独立整页控制台）；「数据与账号」区块复用 `AccountDataSection`；冷静期（`user.status=deletion_pending`）时隐藏余额/库入口，改为冷静期卡片 + 导出；游客显示登录提示；中越双语与 375px |
| `AccountDataSection.tsx` | 用户页「数据与账号」 | 账号生命周期 UI（specs/033 / M2b）：导出（密码确认、配额/限流文案、排队→生成→可下载/失败/过期状态轮询、一次性 token 下载、删除临时文件）、删除危险区（密码 + 用户名 + `DELETE` + 可选原因，7 天冷静期/不可恢复/备份 30 天/无邮箱验证）、冷静期卡片（到期日、密码确认取消、跳转导出）；无内联中文，全部走 i18n |
| `AdminConsoleScreen.tsx` | 管理控制台 | 独立整页管理员控制台（specs/021 + 023 + 032）：概览（总用户/近 7 天新增/今日活跃/游客/今日 AI 花费/失败任务）、用户（搜索、每页 20 条分页、调余额、封禁/解封，不能操作自己/最后一个管理员）、邀请码（生成并显示一次明文/复制、状态筛选/分页、撤销、公开注册状态只读）、删除请求（状态筛选/分页、用户邮箱脱敏、到期执行：原因必填 + 二次确认 `DELETE` + 冷静期未满需强制、失败可重试）、审计（时间/操作者/动作/目标/结果，结果由动作与 detail 推导）、设置（维护模式开关 + 公告，公开公告条待接入）、用量与健康（按天×功能、迁移版本/磁盘/最近 failed jobs）；仅管理员可进，非管理员被 toast 拦回首页；中越双语；表格各自横向滚动，375px 不撑破页面 |
| `EstimateDialog.tsx` | 首页 / 内容发现 | 共用的处理前估价流程：`/api/estimate-cost` loading 覆盖层 → `ModelSelectionModal` → 确认后交给调用方开始处理；首页链接输入与发现页候选点击都走它 |
| `ReportScreen.tsx` | 本周报告 | 本周报告全屏视图（M5 / specs/015）：周一到今天日期范围、三个数字（无答题显示「暂无」）、一句事实/下一步/连续天数、证据句子与「回看 mm:ss」、明日到期词入口；加载/错误/空数据态，中越双语、375px 单列 |
| `SentenceText.tsx` | 句子精背 | seg 渲染：四色语块 + ruby 注音 + 逐词可点 |
| `VocabularyBookScreen.tsx` | 单词本（整页） | 收藏的生词（句子不列入）+ 短语 + CEFR/GRE/CET4/CET6 词表：我的单词单行/展开（批量 `/level` 显示 CEFR，不在词表 C1+、来源跳转、收藏时间、取消收藏）；短语 tab（类型/近似 CEFR 徽章、展开懒加载例句/类型说明/来源/notes、服务端搜索 + level/type 筛选 + 每页 50 + 页码）；词表服务端搜索/每页 50/分页、全局隐藏中文（localStorage，点行临时显示，短语展开时中文说明/笔记同样隐藏）；C2 禁用并说明；空/加载/错误重试；中越双语、桌面表格、375px 单列 |
| `ShareCardDialog.tsx` | 全局 | 分享卡弹窗（计划 D-6）：1080×1440 Canvas 预览、下载 PNG、复制文案、生成失败可读错误；本机生成、不请求后端，中越双语与 375px |
| `ModelBar.tsx` | 首页 | 全局模型栏：/api/models 列表、当前模型、按已配 Key 置灰、选择持久化 |
| `ModelSelectionModal.tsx` | 首页流程 | 处理前确认：展示当前全局模型与整片费用预估（不再选模型） |
| `LanguageMenu.tsx` | 顶栏 / 侧栏 / 登录页 | 语言入口按钮：打开 `LanguageSettingsModal`；窄屏或侧栏折叠态只留图标（`iconOnly`） |
| `LanguageSettingsModal.tsx` | 全局 | 语言设置弹窗：界面语言与翻译目标语言两组独立分段控件，立即生效 |
| `ChannelVideoList.tsx` | 全局 | 某频道的本地历史视频列表 |
| `ShowBrowser.tsx` | 首页 | 本地剧集浏览：剧→季→集 |
| `Toaster.tsx` | 全局 | 轻提示（配合 `lib/toast.ts`） |
