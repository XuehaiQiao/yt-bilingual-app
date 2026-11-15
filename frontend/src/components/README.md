# components/ — UI 组件

全部遵循 [设计语言](../../../docs/设计语言.md)。带 `motion.` 的动效统一用标准弹簧参数。

| 组件 | 用在哪 | 职责 |
|---|---|---|
| `AuthScreen.tsx` | 未登录 | 登录/注册门禁：单页两个 tab、邮箱+密码（注册含必填用户名 2–24 字与可选确认密码）、用户名/表单行内错误；成功后由 `AuthProvider` 切进应用 |
| `InputScreen.tsx` | 首页 | 今日工作台容器：今日头部、能力定位引导条与三张行动卡（继续学习/今日复习/本周报告）、「为你推荐」横排、开始学习输入区（含「搜索你想学的内容」发现入口）、词汇轴、句子精背整宽入口卡、四张 bento 卡（最近学习/本地剧集/订阅/最新视频） |
| `TodayWorkbench.tsx` | 首页 | 今日头部（日期/今日状态/模型栏）、能力定位引导条（无画像：12 分钟定位；有画像：水平区间 + 重测）与三张行动卡（继续学习/今日复习/本周报告），复用设计语言卡片配方；继续卡无记录时引导到下方输入框 |
| `HomeRecommendations.tsx` | 首页 | 「为你推荐」横排卡片（user request #10）：区间副标题/初步推荐徽章、缩略图+难度徽章+时长+标题+理由、水平滚动、「换一批」seed 轮转、加载/失败/空态；点击整卡复用 `EstimateDialog` 估价流程 |
| `VocabAxis.tsx` | 首页 | 词汇水平轴（Liftoff→Supernova 六站，见 specs/004） |
| `SentencePacks.tsx` | 首页 | 句子精背入口卡（5 册 + 进度） |
| `VideoPlayer.tsx` | 学习页 | YouTube 播放器封装：seek/播放暂停命令、倍速、全屏 |
| `LocalEpisodeStage.tsx` | 学习页（本地剧集） | 本地剧集媒体占位卡：剧名/集名、取景图标、模拟播放（播放/暂停、可点击进度、当前/总时长） |
| `TranscriptView.tsx` | 学习页 | 字幕列表：**Apple Music 式跟随滚动**、memo 化（只在换句时重渲染）、用户滚动时暂停跟随 |
| `TranscriptBlock.tsx` | 学习页 | 单句：时间戳、译文显隐、收藏星标、听写模糊；**导出 `HighlightedText`/`ClickableWords`/`cn`** 供他处复用 |
| `WordPopover.tsx` | 全局 | 点查词典卡：音标/释义/例句/TTS/入生词本 |
| `SentenceView.tsx` | 句子精背 | 背诵视图：册切换、按天卡片、自测遮中文、复习打卡、搜索、单句分享卡 |
| `ReviewScreen.tsx` | 复习 | 生词复习全屏视图（M2 / specs/013）：今日统计、单卡揭晓释义/例句、Again/Hard/Good/Easy 评分（键盘 1–4、空格揭晓）、暂停词、空态/完成态、错误重试；不排名、不红叉 |
| `QuizScreen.tsx` | 理解练习 | 视频理解题全屏视图（M3 / specs/014）：3 道 MCQ/判断题逐题作答、提交即判分+解析、答错「回看证据」关闭答题并 seek 原声、结果页正确率/逐题对错/错题回看/回首页；键盘 1–4 选择、Enter 提交/继续 |
| `PlacementScreen.tsx` | 能力定位 | 定位测与能力画像全屏视图（M4 / specs/016）：介绍（12 分钟/不能回退/只是区间）→ 32 题逐题作答（进度、12 分钟倒计时、超时自动交卷、跳过、退出作废确认、键盘 1–4/Enter）→ 结果页（CEFR 区间+点估计+置信度+强弱项+1 条建议+后端免责声明）→ 画像页（区间/来源/更新时间/重测确认）；游客可测并提示登录后结果保存更久 |
| `DiscoverScreen.tsx` | 内容发现 | 主题搜索全屏视图（specs/017）：搜索框 + 示例、约 10–20 秒 loading、3–5 张候选卡（缩略图/频道/时长/A1–C1/理由/字幕有或未知/已学过）、「换一批」force、空/失败/degraded 提示与重试；点击候选接现有估价流程，上次结果留在 sessionStorage |
| `ReaderScreen.tsx` | 读文章 | 阅读器全屏视图（specs/019）：我的文章列表、URL/粘贴正文双 tab 导入（loading/SSRF/超限/网络错误可读）、阅读态标题与英文段落、全部/隐藏译文切换、缺译文时翻译（真实进度、失败段可重试）、点词复用 `WordPopover`、滚动节流保存进度并恢复、删除确认、空/错误态、中越双语与 375px；段落菜单与选中文本分享卡 |
| `BlogScreen.tsx` | 官方博客 | 官方博客全屏视图（specs/020）：列表（日期/阅读时长/标题/摘要/标签/RSS）→ 详情（`react-markdown` 排版、文章中文标注、来源文章标签）；加载/错误/空态、首页底部入口、Giscus 预留（未配置显示「评论即将开放」）、中越双语与 375px；正文来自仓库 `content/blog/*.md`，无 CMS |
| `AccountScreen.tsx` | 用户页 | 登录用户的账号页（specs/023）：头像占位（首字母）+ 用户名内联改名（`PATCH /api/user/profile`）、邮箱、注册日期；余额卡（`credits` / 本月 AI 花费 `monthSpendUsd` / 今日学习分钟，附「额度由管理员发放」）；设置（界面/翻译语言复用 `LanguageSettingsModal`、默认模型复用 `ModelBar`、安装到桌面复用 `PwaInstallButton`）；关于（版本号、官方博客入口、隐私/协议占位不造假链接）；退出登录与仅管理员可见的管理控制台入口；游客显示登录提示；中越双语与 375px |
| `AdminScreen.tsx` | 后台止血台 | 管理员只读运营视图（specs/021）：总览卡片（用户/活跃/今日花费/失败任务）、7 天用量表、用户搜索分页、健康与最近 failed jobs；中越双语；表格各自横向滚动，375px 不撑破页面；无删除/改数据按钮 |
| `EstimateDialog.tsx` | 首页 / 内容发现 | 共用的处理前估价流程：`/api/estimate-cost` loading 覆盖层 → `ModelSelectionModal` → 确认后交给调用方开始处理；首页链接输入与发现页候选点击都走它 |
| `ReportScreen.tsx` | 本周报告 | 本周报告全屏视图（M5 / specs/015）：周一到今天日期范围、三个数字（无答题显示「暂无」）、一句事实/下一步/连续天数、证据句子与「回看 mm:ss」、明日到期词入口；加载/错误/空数据态，中越双语、375px 单列 |
| `SentenceText.tsx` | 句子精背 | seg 渲染：四色语块 + ruby 注音 + 逐词可点 |
| `FavoritesModal.tsx` | 全局 | 收藏夹：分组、迷你播放器、**Anki/CSV 导出**、每条句子/生词的分享卡入口 |
| `ShareCardDialog.tsx` | 全局 | 分享卡弹窗（计划 D-6）：1080×1440 Canvas 预览、下载 PNG、复制文案、生成失败可读错误；本机生成、不请求后端，中越双语与 375px |
| `ModelBar.tsx` | 首页 | 全局模型栏：/api/models 列表、当前模型、按已配 Key 置灰、选择持久化 |
| `ModelSelectionModal.tsx` | 首页流程 | 处理前确认：展示当前全局模型与整片费用预估（不再选模型） |
| `LanguageMenu.tsx` | 顶栏 / 登录页 | 语言入口按钮：打开 `LanguageSettingsModal`，窄屏只留图标 |
| `LanguageSettingsModal.tsx` | 全局 | 语言设置弹窗：界面语言与翻译目标语言两组独立分段控件，立即生效 |
| `ChannelVideoList.tsx` | 全局 | 某频道的本地历史视频列表 |
| `ShowBrowser.tsx` | 首页 | 本地剧集浏览：剧→季→集 |
| `Toaster.tsx` | 全局 | 轻提示（配合 `lib/toast.ts`） |
