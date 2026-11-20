# lib/ — 纯逻辑模块

无 UI，是行为的"真相"所在。除 `auth.tsx`（认证状态容器，React Context）外不依赖 React；改行为先看这里。

| 模块 | 职责 |
|---|---|
| `api.ts` | `API_BASE`（`VITE_API_BASE` 可覆盖）与 `apiFetch`（自动带 `X-API-Key`、`credentials: include`、按端点注入 `targetLang`；非 auth 端点 401 广播给认证层） |
| `auth.tsx` | 认证状态：`AuthProvider`/`useAuth`（含 `isAdmin`，来自 `/api/auth/me`）、启动 `GET /api/auth/me`、login/signup（注册带用户名与可选邀请码）/logout、`clearSession`（删除申请成功后仅清本地态，不再请求 logout）、`refreshSession`（取消删除后刷新 `user.status`）、`updateUsername`（`PATCH /api/user/profile`）、`fetchRegistrationConfig`（`GET /api/auth/registration`）、`AuthRequestError`（保留 HTTP 状态与稳定 `code`）、全局 401 回登录页 |
| `username.ts` | 显示名规则（specs/023）：2–24 个字符、中文/英文/数字/下划线/连字符、首尾不能空白；`usernameProblem`（返回首个不满足的 i18n key）、`displayUsername`（无用户名回落邮箱前缀）、`usernameInitial`（头像首字母）。与后端 `account.validate_username` 保持同步 |
| `transcript.ts` | 字幕核心逻辑：`findActiveIndex`（当前句判定，含 0.8s 前瞻）、SSE 流解析（`consumeSseStream`）、`[未翻译]` 标记判定、译文显示模式（全显/当前句/隐藏）持久化 |
| `sentences.ts` | 句子精背：类型、拉取、四色语块配色、按册×天的背诵/复习进度持久化 |
| `settings.ts` | 高亮难度（六站轴）与全局模型（`yt_bilingual_last_model`）的 localStorage 读写：旧考试制存档迁移、`hasSavedVocabLevel()` 首次预填判定、能力档案区间高带 → 轴档位映射；选择变化广播 `yt-bilingual:vocab-level` |
| `teachingAnalysis.ts` | 教学分析客户端（specs/028）：`TeachingAnalysis`/`TeachingHighlight`/`TeachingIdiom`/`TeachingCulture` 类型；`fetchTeachingAnalysis` 带登录 cookie/AbortSignal，按 `contentRef + level + targetLang` 做模块级内存缓存与同 key 请求合并（403/404/失败静默返回 null，`onIssue` 只把原因交给面板），`teachingAnalysisFromPayload` 优先复用历史缓存里已 attach 的 `idioms`/`culture`，`applyTeachingAnalysisHighlights` 用分析高亮覆盖旧 payload 高亮且不改文本/时间轴 |
| `progress.ts` | 每视频播放进度记忆（续播 + "已学 N%"），上限 200 条 |
| `recent.ts` | 今日「最近学习」的纯数据层：视频（`/api/history` 行）/文章（`ArticleSummary`）/公版书与导入书 localStorage 进度 → 统一条目；按 `lastAt` 倒序（0/未知沉底）、大小写不敏感搜索、类型筛选、每页 10 条分页；不网络、不 UI 文案，时间与标签由组件按当前语言渲染 |
| `events.ts` | 观看事件上报（M5 / specs/015）：只按播放位置增量计 `watchedSeconds`（暂停/拖动不计），内存队列 ≤50 条批量 POST `/api/events`，`clientEventId` 保证重试幂等；每 60s 播放 / 暂停 / 切后台时 flush（keepalive），失败静默重试一次 |
| `learningTelemetry.ts` | 学习行为埋点（CEFR M2 #7 / specs/027）：`dict_lookup` / `video_replay` / `playback_rate` / `tab_visibility` 四类事件；只发白名单字段（不含 context/原文），同词 60s、replay 1s（loop 10s）节流，队列 ≤100、批量 ≤20，`eventId` 幂等；失败静默，hidden/pagehide 用 keepalive flush |
| `exporter.ts` | 收藏导出：Anki TSV（front/back/tags）与完整 CSV |
| `shareCard.ts` | 分享卡（计划 D-6）：纯 Canvas 生成 1080×1440 PNG（系统字体栈、深色品牌卡、正文最多 6 行/生词卡 4 行、超出省略、空数据守卫）、`canvasToPngBlob`/`downloadBlob`/`buildShareText`/`copyShareText`；不请求网络、不落服务端 |
| `favorites.ts` | 收藏按条 API（M1 ④）：`FavoriteItem` 类型、`fetchFavorites/addFavorite/removeFavorite`（后端按条写入、幂等）；`replaceAllFavorites` 仅为旧整文件 PUT 兼容路径，App 不再调用 |
| `favoriteSource.ts` | 单词本「来源」解析：新收藏用 `source_kind/source_ref/source_title`，旧记录按 `videoId` 形状推断（11 位→视频、`sentence-pack-L*`→句子精背、其他→文章），标题未知时显示来源未知且不可点；IPA/释义拆分与 `L<levelId>` 解析 |
| `useReadingHighlights.ts` | 阅读标亮（user request 2026-11-17 #3）：按当前 `loadVocabLevel()` 得到阈值，收集段落英文词后调用 `fetchVocabularyLevels`（≤100/批，模块级同词缓存），返回 `wordLevels` Map 与 `isHighlighted`；A1<A2<B1<B2<C1<C1+<C2，C2 不额外标亮；API 失败静默无高亮并保留 `yt_bilingual_reading_highlight` 开关 |
| `vocabulary.ts` | 单词本词表客户端（specs/005）：`fetchVocabularyLists`（目录，C2 `available:false` 原样透传）、`fetchVocabularyPage`（服务端 `q` 搜索 + 分页，默认 50/页）、`fetchPhrasePage`（短语服务端 `q` + level/type 筛选 + 分页，默认 50/页）、`fetchPhraseDetail`（展开时懒加载 `notes/license`）、`fetchVocabularyLevels`（按 100 词分批查词级 CEFR，保留后端 `null`/`C1+` 不做本地推断） |
| `review.ts` | 复习引擎客户端（M2 / specs/013）：队列/统计/作答/暂停的类型与四个 API 函数；走 `apiFetch`，按当前翻译目标语言取词，失败抛带 HTTP 状态的 `ReviewApiError` |
| `quiz.ts` | 理解题客户端（M3 / specs/014）：lesson/题目/作答/结果类型与 `startLesson/getQuestions/answerQuestion/getResult`；走 `apiFetch`（start 自动带 `targetLang`），失败抛带 HTTP 状态的 `QuizApiError` |
| `course.ts` | 12 分钟课程客户端（specs/029 + specs/030）：`CourseLesson/CourseAttempt/CourseQuestion/GeneratedCourse` 等类型与 `fetchCourseLessons/fetchCourseLesson/generateCourse/startCourseAttempt/fetchCourseAttempt/submitCourseAnswer/setCourseStep/saveCourseOutput/completeCourseAttempt`；走 `apiFetch`（会话 cookie/AbortSignal），失败抛带 HTTP 状态与错误码的 `CourseApiError`（生成额外区分 409 `source_not_ready` / 502 `generation_failed`）；题目答案只从作答接口取，客户端不存答案键；事件 `sendCourseEvent` 静默失败，卸载/离开用 `sendCourseDropBeacon` |
| `placement.ts` | 能力定位测客户端（M4 / specs/016）：卷面/画像/结果类型与 `startPlacement/submitPlacement/getProfile/resetPlacement`；走 `apiFetch`，失败抛带 HTTP 状态的 `PlacementApiError`；`preliminary`/`sampleSize`/`disclaimer` 原样交给 UI，不做二次推断 |
| `discover.ts` | 内容发现客户端（specs/017）：/api/discover 的候选/结果类型与 `discoverContent(query,targetLang,force)`；失败抛带 HTTP 状态与 `Retry-After` 的 `DiscoverApiError`；候选不补造、不强行凑足 3–5 个，`hasEnglishSubs` 只接受 true/null |
| `reading.ts` | 读文章客户端（specs/019）：`importArticle`/`getArticle`/`translateArticle`/`listArticles`/`deleteArticle`/`saveProgress` 与文章/段落/译文/进度类型；读取显式带 `targetLang`，失败抛带 HTTP 状态的 `ReadingApiError`；不补造文章内容，译文失败按后端 `translationFailed` 标记展示 |
| `difficulty.ts` | 内容难度客户端（M2 / specs/026）：`/api/content/difficulty/batch` 的 `DifficultyItem` 类型与 `fetchDifficultyBatch(items, band)`；只透传后端的 `cefrInput`/`bucket`/`utrBand`，缺行时回退编辑等级且不补造生词桶；`band` 是用户词汇带上界（无画像由调用方给默认 B1） |
| `recommend.ts` | 规则推荐客户端（specs/018 + M2）：`/api/recommendations` 的条目/区间/难度摘要类型与 `fetchRecommendations({limit,seed})`；不补造条目、`reason`/`basis`/`preliminary` 原样交给 UI；时长格式化为 `mm:ss` |
| `blog.ts` | 官方博客客户端（specs/020）：`/api/blog/posts`、`/api/blog/posts/{slug}`、`/api/blog/feed.xml` 的类型与 `listBlogPosts/getBlogPost/blogFeedUrl`；只读公开接口，失败抛带状态码的 `BlogApiError`；前端用 Markdown 字段配合 `react-markdown`，不注入后端 HTML |
| `library.ts` | 本地免费资源库客户端（user request #11）：`/api/library`、`/api/library/videos/{id}`、`/api/library/articles/{id}` 的类型与 `fetchLibraryIndex/fetchLibraryVideo/fetchLibraryArticle`；公开只读、不触发估价/处理/翻译；只校验并透传后端字段，失败抛带 HTTP 状态的 `LibraryApiError` |
| `tts.ts` | 浏览器朗读（speechSynthesis，偏好英语音色） |
| `admin.ts` | 管理控制台客户端（specs/021 + 023 + 032 + 033）：`fetchAdminStats/fetchAdminUsers/fetchAdminUsage/fetchAdminHealth`、`fetchAdminSettings/saveAdminSettings`、`adjustAdminUserCredits/updateAdminUserStatus`、`fetchAdminInvites/createAdminInvites/revokeAdminInvite`、`fetchAdminDeletionRequests/executeAdminDeletion`（`confirm=DELETE` + 原因 + 冷静期未满需 `force`）、`fetchAdminAudit` 与全部响应类型；所有调用走 `apiFetch`（带 credentials），失败抛带 HTTP 状态与稳定 `code` 的 `AdminApiError`；写操作只在用户显式点击后调用 |
| `accountLifecycle.ts` | 账号生命周期客户端（specs/033 / M2b）：`fetchDeletionState/requestDeletion/cancelDeletion`、`fetchExports/createExport/downloadExport/deleteExport`；`LifecycleApiError` 保留 HTTP 状态/稳定 `code`/`Retry-After`，`lifecycleErrorText` + `formatRetryAfter` 映射中越文案；下载 token 只出现在 202 响应，按 tab 存 `sessionStorage`（刷新可续，关标签即失效）；错误码中文回退仅 zh-CN |
| `toast.ts` | 轻提示总线 + `describeApiError`（把后端/网络错误转成可读文案；`account_pending_deletion` 等稳定 `code` 走 i18n，其余保留后端 `detail`） |
| `jobs.ts` | 断线续传（M1 ⑤）：`sessionStorage` 里保存 `jobId`/游标（key `yt_bilingual_pending_job`）、`GET /api/jobs/{id}` 查询状态、`recordJobMeta/recordJobProgress/finishJob` 三个 SSE 事件钩子；刷新后「先查状态、可续才带 `jobId + from` 重连」的判定也在这里 |

约定：localStorage key 全部带 `yt_bilingual_` 或 `sentence-` 前缀；新增持久化跟随此约定。
