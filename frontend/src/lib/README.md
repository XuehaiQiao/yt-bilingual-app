# lib/ — 纯逻辑模块

无 UI，是行为的"真相"所在。除 `auth.tsx`（认证状态容器，React Context）外不依赖 React；改行为先看这里。

| 模块 | 职责 |
|---|---|
| `api.ts` | `API_BASE`（`VITE_API_BASE` 可覆盖）与 `apiFetch`（自动带 `X-API-Key`、`credentials: include`、按端点注入 `targetLang`；非 auth 端点 401 广播给认证层） |
| `auth.tsx` | 认证状态：`AuthProvider`/`useAuth`，启动 `GET /api/auth/me`、login/signup/logout、全局 401 回登录页 |
| `transcript.ts` | 字幕核心逻辑：`findActiveIndex`（当前句判定，含 0.8s 前瞻）、SSE 流解析（`consumeSseStream`）、`[未翻译]` 标记判定、译文显示模式（全显/当前句/隐藏）持久化 |
| `sentences.ts` | 句子精背：类型、拉取、四色语块配色、按册×天的背诵/复习进度持久化 |
| `settings.ts` | 词汇水平（六站轴）与全局模型（`yt_bilingual_last_model`）的 localStorage 读写，含旧考试制存档迁移 |
| `progress.ts` | 每视频播放进度记忆（续播 + "已学 N%"），上限 200 条 |
| `events.ts` | 观看事件上报（M5 / specs/015）：只按播放位置增量计 `watchedSeconds`（暂停/拖动不计），内存队列 ≤50 条批量 POST `/api/events`，`clientEventId` 保证重试幂等；每 60s 播放 / 暂停 / 切后台时 flush（keepalive），失败静默重试一次 |
| `exporter.ts` | 收藏导出：Anki TSV（front/back/tags）与完整 CSV |
| `favorites.ts` | 收藏按条 API（M1 ④）：`FavoriteItem` 类型、`fetchFavorites/addFavorite/removeFavorite`（后端按条写入、幂等）；`replaceAllFavorites` 仅为旧整文件 PUT 兼容路径，App 不再调用 |
| `review.ts` | 复习引擎客户端（M2 / specs/013）：队列/统计/作答/暂停的类型与四个 API 函数；走 `apiFetch`，按当前翻译目标语言取词，失败抛带 HTTP 状态的 `ReviewApiError` |
| `quiz.ts` | 理解题客户端（M3 / specs/014）：lesson/题目/作答/结果类型与 `startLesson/getQuestions/answerQuestion/getResult`；走 `apiFetch`（start 自动带 `targetLang`），失败抛带 HTTP 状态的 `QuizApiError` |
| `placement.ts` | 能力定位测客户端（M4 / specs/016）：卷面/画像/结果类型与 `startPlacement/submitPlacement/getProfile/resetPlacement`；走 `apiFetch`，失败抛带 HTTP 状态的 `PlacementApiError`；`preliminary`/`sampleSize`/`disclaimer` 原样交给 UI，不做二次推断 |
| `discover.ts` | 内容发现客户端（specs/017）：/api/discover 的候选/结果类型与 `discoverContent(query,targetLang,force)`；失败抛带 HTTP 状态与 `Retry-After` 的 `DiscoverApiError`；候选不补造、不强行凑足 3–5 个，`hasEnglishSubs` 只接受 true/null |
| `reading.ts` | 读文章客户端（specs/019）：`importArticle`/`getArticle`/`translateArticle`/`listArticles`/`deleteArticle`/`saveProgress` 与文章/段落/译文/进度类型；读取显式带 `targetLang`，失败抛带 HTTP 状态的 `ReadingApiError`；不补造文章内容，译文失败按后端 `translationFailed` 标记展示 |
| `recommend.ts` | 规则推荐客户端（specs/018）：`/api/recommendations` 的条目/区间类型与 `fetchRecommendations({limit,seed})`；不补造条目、`reason`/`basis`/`preliminary` 原样交给 UI；时长格式化为 `mm:ss` |
| `blog.ts` | 官方博客客户端（specs/020）：`/api/blog/posts`、`/api/blog/posts/{slug}`、`/api/blog/feed.xml` 的类型与 `listBlogPosts/getBlogPost/blogFeedUrl`；只读公开接口，失败抛带状态码的 `BlogApiError`；前端用 Markdown 字段配合 `react-markdown`，不注入后端 HTML |
| `tts.ts` | 浏览器朗读（speechSynthesis，偏好英语音色） |
| `toast.ts` | 轻提示总线 + `describeApiError`（把后端/网络错误转成可读中文） |
| `jobs.ts` | 断线续传（M1 ⑤）：`sessionStorage` 里保存 `jobId`/游标（key `yt_bilingual_pending_job`）、`GET /api/jobs/{id}` 查询状态、`recordJobMeta/recordJobProgress/finishJob` 三个 SSE 事件钩子；刷新后「先查状态、可续才带 `jobId + from` 重连」的判定也在这里 |

约定：localStorage key 全部带 `yt_bilingual_` 或 `sentence-` 前缀；新增持久化跟随此约定。
