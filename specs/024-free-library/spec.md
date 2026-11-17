# 规格：本地免费资源库（视频预置双语字幕 + 原创短文）

**状态：** 已实现（2026-11-16，内容 + 后端 + 前端）｜
**对应代码：** `content/library/*`、`backend/routes_library.py`、
`backend/tests/test_library.py`、`frontend/src/lib/library.ts`、
`frontend/src/components/LibrarySection.tsx`、
`frontend/src/components/LibraryArticleReader.tsx`；配置 `LIBRARY_DIR`
（`backend/config.py`）、公开路径 `main.py::_is_public_api_path`。

> 用户需求 #11「本地免费资源库」。目标是在首页「为你推荐」下面加一扇
> 「免费资源」窗：视频 + 文章，无需账号、本地存储、**运行时零 LLM 调用**。
> 这是给还没登录/不想花 token 的用户一个「打开就能学」的入口。

---

## 目标

- **G1 首页入口**：首页「为你推荐」下方新增 `LibrarySection`，标题「免费资源」，
  视频/文章分段 tab，卡片显示标题、时长或词数、等级徽章、免费标识；游客可用，
  不弹登录。
- **G2 视频即开即看**：点视频直接进入现有视频页，用本地 `blocks` 渲染双语字幕，
  YouTube 嵌入播放；打开时不请求 `/api/estimate-cost`、`/api/process-video*`、
  `/api/define`，页面顶部标注「免费资源 · 预置双语字幕」。视频页保留既有的
  点词查词（用户主动行为，不影响预置字幕的离线可用）。
- **G3 文章本地阅读器**：点文章进入阅读器本地模式，直接显示段落与中文译文，
  译文可一键显示/隐藏；不请求 `/api/article/*`，不显示「翻译本文」按钮。
- **G4 公开只读**：三个端点无需登录；中间件不为 `/api/library/*` 创建游客身份
  或下发 Cookie；无数据库、无写入端点、无 LLM。
- **G5 内容闸门**：文件缺失/字段损坏 503，条目缺失/未知 id 404；宁可不发，
  也不把半条资源交给前端。
- **G6 双语文档壳**：界面文案 zh-CN / vi-VN；375px 单列可用；不破坏首页其他区块。
- **G7 可扩展**：新增资源 = 放一个 JSON + 在清单里加 id，不改后端代码。

## 非目标

- **不下载视频文件**：只存「预生成双语字幕块 + 元数据」，播放走 YouTube 嵌入
  （体积/版权原因）；「免费」指字幕与元数据已在本机，不是离线播放视频。
  如未来要做真本地视频，方案见 `content/library/README.md`。
- 不做账号体系、收藏/进度同步、评论、搜索、分页、后台 CMS。
- 不做多语言正文：视频 `zh_text` 与文章 `zh` 固定为中文；越南语只覆盖 UI。
- 不把资源写进数据库；不做定时刷新/自动抓取字幕。
- 不做运行时 LLM 翻译：内容在构建期一次性固化，运行时只读文件。

## 内容模型（无数据库）

```
content/library/
├── videos.json                 # { "videos": ["<id>", ...] }
├── videos/<id>.json            # id/youtubeId/title/channel/duration/level/free/source/blocks
├── articles.json               # { "articles": ["<id>", ...] }
├── articles/<id>.json          # id/title/level/author/license/paragraphs[{en,zh}]
└── README.md                   # 来源、许可、新增方式、零 LLM 说明
```

- 视频 3 个：BBC Learning English（`h-NZcQF7jgI`，复用已有缓存）、TED-Ed
  （`6MK6tuZ7Rws`，精选池）、Kurzgesagt（`_zfN9wnPvU0`，精选池）；均为真实
  YouTube 英语视频、3–20 分钟、有英文字幕；双语字幕由已有处理缓存一次性固化。
- 文章 3 篇原创（科普/科技/生活各一，250–350 词），作者「LinguaTrek 编辑部」，
  许可「原创，免费使用」；逐段 `en` + `zh`。
- `free: true`、`source: "youtube"`（视频）/ `source: "original"`（文章）。

## API

| 方法 | 路径 | 返回 | 缓存 |
|---|---|---|---|
| GET | `/api/library` | `{videos:[{id,title,channel,duration,level}], articles:[{id,title,level,wordCount}]}` | `public, max-age=300` |
| GET | `/api/library/videos/{id}` | 元数据 + `blocks[{id,start,end,en_text,zh_text,highlights}]` | `public, max-age=3600` |
| GET | `/api/library/articles/{id}` | 标题/等级/词数/作者/许可 + `paragraphs[{en,zh}]` | `public, max-age=3600` |

- 404：id 形状非法、id 不存在、条目文件缺失；
- 503：资源目录/清单缺失、清单引用缺失文件、条目 JSON 损坏或字段非法；
- 公开路径与 `/api/blog/*` 同列：跳过游客签发，不写任何状态。

## 前端

- `LibrarySection`：首页推荐下方；加载/失败/空态；视频/文章 tab；卡片横向滚动；
  `data-testid` 覆盖 section/tab/card/free badge。
- 视频：App 里新增 `handleOpenLibraryVideo`，取详情后直接
  `setTranscript(blocks)` / `setMetadata(camera...)` / `setVideoId(youtubeId)`，
  `metadata.is_library=true`；媒体区左上角显示「免费资源 · 预置双语字幕」。
- 文章：`LibraryArticleReader` 轻量阅读器（**2026-11-17 补齐** `ClickableWords`
  点词与全局 `WordPopover`，source 标免费文章 id/标题，收藏「出处」走
  `library_article` 路由；`reader.translation.*` 切换文案），段落 `en` + `zh`；
  ≥lg 逐段左右对照（左英右中、同一滚动容器），<lg 上下排列，隐藏译文时英文
  单栏；不挂载 `ReaderScreen` 的导入/翻译/进度逻辑，因此不存在
  `/api/article/*` 请求。
- 阅读器共用布局组件 `BilingualRow`（`ReaderScreen`/`LibraryArticleReader`/
  `BookReaderScreen`/`ImportedBookReaderScreen`）；回归脚本
  `scripts/reader-layout-test.mjs`。
- 首页原有「为你推荐」「开始学习」「今日」等区块不动；375px 下卡片单列/横滑。

## 验收

- 后端：`py_compile`；`pytest tests/test_library.py` 13 条；全量 pytest 全绿；
  未登录三个端点 200、404/503 分支、无游客 Cookie、无 LLM 调用。
- 前端：`npx tsc -b`、`npm run check:i18n`。
- Playwright（真实后端）：游客开视频出现预置字幕且无 `process/estimate` 请求；
  开文章显示译文且无 `/api/article` 请求；tab 切换；375px；zh/vi。
  截图 `/tmp/library-shots/`。
- 运行时零 LLM：`routes_library.py` 不 import `llm`、不连数据库；内容为文件读取。
