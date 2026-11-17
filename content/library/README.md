# 本地免费资源库（content/library）

首页「为你推荐」下面的「免费资源」窗读取这里的内容。**打开即用、无需账号、运行时不调用任何大模型**：
后端只读仓库内的 JSON 文件；打开视频/文章时前端只取 `/api/library*`，不会自动触发
`/api/estimate-cost`、`/api/process-video*`、`/api/article/*`，也不发 `process/define` 请求。
（视频页保留全站既有的点词查词能力：只有用户主动点某个词时才查词，预置字幕与译文本身不依赖模型。）

## 目录

```
content/library/
├── videos.json                 视频清单（只存 id）
├── videos/<id>.json            预生成双语字幕块 + 元数据
├── articles.json               文章清单（只存 id）
├── gutenberg-manifest.json     64 篇公版短文的 Gutenberg ID / 链接 / PD 依据
├── articles/<id>.json          原创/公版英文全文 + 逐段中文译文
└── README.md
```

## 重要假设：视频不下载视频文件

视频资源只存「**预生成的双语字幕块 + 元数据**」，不存 mp4/webm：

- 体积：本地仓库不适合放几个 100 MB 的视频；
- 版权：原视频版权归 YouTube 频道所有，仓库只保留字幕与元数据（个人学习用途）；
- 播放：前端仍用现有的 YouTube 嵌入（`VideoPlayer`），点卡片直接进入视频页，
  用本地 blocks 渲染字幕与高亮，不重新请求字幕/翻译。

因此「免费」指的是**字幕与元数据已在本机、打开就能看**，不是离线播放视频。

如果以后确实需要真正的本地视频文件，建议的接入方式（本次不实施、不下载）：

1. 新增 `content/library/media/<id>.mp4`（或外置目录，用环境变量 `LIBRARY_MEDIA_DIR` 指过去）；
2. `videos/<id>.json` 增加 `localVideoFile: "media/<id>.mp4"` 字段；
3. 后端增加受控的静态文件路由（校验 id 形状、Range 请求、内容类型），前端
   `VideoPlayer` 在该字段存在时改用 `<video>` 标签，否则继续用 YouTube 嵌入；
4. 媒体文件体积大，务必放 `.gitignore` 或独立目录，并单独做磁盘占用/清理策略。

## 视频资源（55 个，A1–C2）

55 个真实 YouTube 英语视频，全部**可嵌入播放**、有英文字幕、时长 3–15 分钟；每条都预生成
`en_text + zh_text` 双语字幕块，播放走 YouTube 官方嵌入，不下载视频文件。

| 等级 | 数量 | 说明 |
|---|---|---|
| A1 | 6 | English Comprehensible Input 慢速教学短片（4 条自动字幕，已标 `subtitleSource: auto`） |
| A2 | 10 | BBC Learning English：6 Minute English / Real Easy English |
| B1 | 14 | BBC 6 Minute English、TED-Ed |
| B2 | 12 | TED、TED-Ed、TEDx、Kurzgesagt |
| C1 | 8 | TED、Bloomberg Originals |
| C2 | 5 | TED / TEDx / Bloomberg 学术与深度纪录片 |

- 字幕来源：**51 条人工英文字幕 + 4 条自动字幕**；每条 JSON 的 `subtitleSource` 字段
  （`manual` / `auto`）如实标注。A1 的 4 条自动字幕没有标点，block 按自动字幕行切分，
  用于「听 + 看」入门，不用于精读。
- 双语译文：由本项目现有的 LLM 层（`backend/llm.py`，模型 `deepseek-chat`）在构建期批量生成，
  每条 block 按 `id` 对齐；prompt 版本、prompt 原文与 SHA-256、模型、时间、逐条 token 用量
  和成本估算都记录在 `translation-manifest.json`。52 条新译视频平均 1,194 词/条，
  总用量 205,360 input / 119,521 output tokens，按 2025 年公开价目估算约 **$0.108**（$0.0021/条）。
- 难度：除 C2 外，55 条中的 50 条都由 `backend/difficulty.py`（M2）计算并写入
  `content_difficulty`（`kind=video`）；卡片显示计算带。**C2 不建 difficulty 行**：
  M2 的词表上限是 C1+，C2 由卡片回退到编辑等级 `level`。M2 按词汇覆盖率估计，
  短教学片里的专有名词/语气词可能把计算带抬高；卡片同时显示编辑等级 chip，筛选 chips
  按编辑 `level` 统计。
- 3 条早期视频（`bbc-learning-different-generations`、`teded-better-economy`、
  `kurzgesagt-ai-slop`）复用 M1 阶段的处理缓存，未重新翻译；`translation-manifest.json`
  里以 `legacy: true` 记录。

完整清单（按等级）：

### A1（6）

| id | YouTube | 频道 | 时长 | 字幕 |
|---|---|---|---|---|
| `eci-total-beginners-story` | `31AtaK035JQ` | English Comprehensible Input for ESL Beginners | 7 分钟 | manual |
| `eci-big-and-small` | `Ir-hBvo1Z2A` | English Comprehensible Input for ESL Beginners | 6 分钟 | manual |
| `eci-stand-verb` | `n50v95kAJCQ` | English Comprehensible Input for ESL Beginners | 4 分钟 | auto |
| `eci-cut-verb` | `8x1inMgDh-A` | English Comprehensible Input for ESL Beginners | 5 分钟 | auto |
| `eci-play-verb` | `kMsy__T_4GY` | English Comprehensible Input for ESL Beginners | 8 分钟 | auto |
| `eci-bob-wants-swim` | `2V5W4yF_Yqo` | English Comprehensible Input for ESL Beginners | 6 分钟 | auto |

### A2（10）

| id | YouTube | 频道 | 时长 | 字幕 |
|---|---|---|---|---|
| `bbc6-technology-youngsters` | `StEB_wntlZ0` | BBC Learning English | 6 分钟 | manual |
| `bbc-real-easy-food` | `4C4wlOAscvY` | BBC Learning English | 6 分钟 | manual |
| `bbc-real-easy-meetings` | `TL61VKkme14` | BBC Learning English | 6 分钟 | manual |
| `bbc-real-easy-sleep` | `yLu_M4yiCho` | BBC Learning English | 5 分钟 | manual |
| `bbc-real-easy-housemates` | `lHZCWPdQr80` | BBC Learning English | 6 分钟 | manual |
| `bbc-real-easy-seasons` | `QBddNulwhKo` | BBC Learning English | 5 分钟 | manual |
| `bbc-real-easy-mistakes` | `eK5Tsornvng` | BBC Learning English | 6 分钟 | manual |
| `bbc-real-easy-days-out` | `S7mfygW40Cs` | BBC Learning English | 6 分钟 | manual |
| `bbc-real-easy-sweet-foods` | `P3jsDVjil2o` | BBC Learning English | 7 分钟 | manual |
| `bbc-real-easy-famous-sites` | `KHimUkNBDiQ` | BBC Learning English | 7 分钟 | manual |

### B1（14）

| id | YouTube | 频道 | 时长 | 字幕 |
|---|---|---|---|---|
| `bbc-learning-different-generations` | `h-NZcQF7jgI` | BBC Learning English | 6 分钟 | manual |
| `teded-better-economy` | `6MK6tuZ7Rws` | TED-Ed | 6 分钟 | manual |
| `teded-wildlife-climate` | `ZCKRjP_DMII` | TED-Ed | 5 分钟 | manual |
| `bbc6-body-language` | `oTPZWpQ9pbA` | BBC Learning English | 6 分钟 | manual |
| `kurzgesagt-robot-rights` | `DHyUYg8X31c` | Kurzgesagt – In a Nutshell | 7 分钟 | manual |
| `teded-tax-cuts` | `wCLP3djiKvM` | TED-Ed | 5 分钟 | manual |
| `teded-languages-evolve` | `iWDKsHm6gTA` | TED-Ed | 4 分钟 | manual |
| `teded-stress-brain` | `WuyPuH9ojCE` | TED-Ed | 4 分钟 | manual |
| `teded-internet-cables` | `er3v4PVNQqE` | TED-Ed | 5 分钟 | manual |
| `teded-earth-2050` | `2njn71TqkjA` | TED-Ed | 5 分钟 | manual |
| `teded-procrastination` | `FWTNMzK9vG4` | TED-Ed | 6 分钟 | manual |
| `teded-calm-under-pressure` | `CqgmozFr_GM` | TED-Ed | 4 分钟 | manual |
| `teded-good-posture` | `OyK0oE5rwFY` | TED-Ed | 4 分钟 | manual |
| `teded-confidence-tips` | `l_NYrWqUR40` | TED-Ed | 4 分钟 | manual |

### B2（12）

| id | YouTube | 频道 | 时长 | 字幕 |
|---|---|---|---|---|
| `kurzgesagt-ai-slop` | `_zfN9wnPvU0` | Kurzgesagt – In a Nutshell | 10 分钟 | manual |
| `ted-ai-danger` | `eXdVDhOGqoE` | TED | 10 分钟 | manual |
| `ted-climate-mental-health` | `-IlDkCEvsYw` | TED | 8 分钟 | manual |
| `kurzgesagt-climate-late` | `wbR-5mHI6bo` | Kurzgesagt – In a Nutshell | 10 分钟 | manual |
| `teded-bilingual-brain` | `MMmOLN5zBLY` | TED-Ed | 5 分钟 | manual |
| `tedx-culture-language` | `fbQ3LGoFaLc` | TEDx Talks | 9 分钟 | manual |
| `ted-good-life` | `8KkKuTCFvzI` | TED | 13 分钟 | manual |
| `kurzgesagt-life-inside-earth` | `VD6xJq8NguY` | Kurzgesagt – In a Nutshell | 11 分钟 | manual |
| `kurzgesagt-scariest-place` | `yDAAlojz8NU` | Kurzgesagt – In a Nutshell | 9 分钟 | manual |
| `kurzgesagt-extreme-place` | `FfWtIaDtfYk` | Kurzgesagt – In a Nutshell | 12 分钟 | manual |
| `kurzgesagt-largest-star` | `3mnSDifDSxQ` | Kurzgesagt – In a Nutshell | 12 分钟 | manual |
| `kurzgesagt-trees-weird` | `ZSch_NgZpQs` | Kurzgesagt – In a Nutshell | 11 分钟 | manual |

### C1（8）

| id | YouTube | 频道 | 时长 | 字幕 |
|---|---|---|---|---|
| `ted-language-shapes-thought` | `RKK7wGAYP6k` | TED | 14 分钟 | manual |
| `ted-master-procrastinator` | `arj7oStGLkU` | TED | 14 分钟 | manual |
| `ted-stress-friend` | `RcGyVTAoXEU` | TED | 14 分钟 | manual |
| `ted-sitting-brain-body` | `rKgtm81yi94` | TED | 11 分钟 | manual |
| `ted-social-health` | `LpSDuDIaBGk` | TED | 10 分钟 | manual |
| `ted-break-bad-habit` | `-moW9jvvMr4` | TED | 9 分钟 | manual |
| `bloomberg-buffett-investing` | `HxkHu4kdEeg` | Bloomberg Originals | 9 分钟 | manual |
| `ted-next-outbreak` | `6Af6b_wyiwI` | TED | 9 分钟 | manual |

### C2（5）

| id | YouTube | 频道 | 时长 | 字幕 |
|---|---|---|---|---|
| `ted-brain-scans` | `esPRsT-lmw8` | TEDx Talks | 15 分钟 | manual |
| `ted-addiction-wrong` | `PY9DcIMGxMs` | TED | 15 分钟 | manual |
| `ted-exercise-brain` | `BHY0FxzoKZE` | TED | 13 分钟 | manual |
| `tedx-brain-focus` | `PBaFURjVrm0` | TEDx Talks | 15 分钟 | manual |
| `bloomberg-ganges-cleanup` | `gDBO-B__oLk` | Bloomberg Originals | 14 分钟 | manual |

- 许可：字幕/元数据为本地构建产物；原视频版权归对应频道，播放走 YouTube 官方嵌入。
- 英文源字幕在构建期用 `yt-dlp` 抓取（人工字幕优先，没有人工才退自动字幕），
  只落 `subtitleSource` 与字幕块，不下载视频。

## 文章资源（67 篇：3 篇原创 + 64 篇公版短文）

### 原创文章（3 篇）

| id | 标题 | 主题 | 等级 | 词数 |
|---|---|---|---|---|
| `ocean-noise` | Why the Ocean Is Getting Louder | 科普 | B1 | 269 |
| `free-app-hidden-cost` | The Hidden Cost of a Free App | 科技 | B2 | 323 |
| `case-for-doing-nothing` | The Case for Doing Nothing | 生活 | A2 | 269 |

- 作者：**LinguaTrek 编辑部**
- 许可：**原创，免费使用**
- 每篇 250–350 词，逐段 `en` + `zh`。

### Project Gutenberg 公版短文（64 篇）

- 来源：Project Gutenberg（【#18442】Fifty Famous Stories Retold、【#6168】Fifty Famous People、
  【#7439】English Fairy Tales、【#14241】More English Fairy Tales、【#11339】Aesop's Fables、
  【#49010】Æsop's Fables: A Version for Young Readers、【#7518】More Jataka Tales、
  【#62514】Jataka Tales）。
- 每篇 250–400 词，保留**英文原文**并配**本项目中译文**，逐段 `en` + `zh`；
  每篇 JSON 都带 `gutenbergId` / `sourceUrl` / `publicDomainBasis`，总清单见
  `content/library/gutenberg-manifest.json`。
- 选文只取公有领域文本（作者逝世逾 70 年 / 1923 年前出版）；译文为本项目自有译文，
  未复制任何受版权保护的译本或注释。
- 等级为编辑初标，卡片/阅读器优先显示 `content_difficulty` 的计算结果。

## 数据结构

`videos.json` / `articles.json` 只是清单：

```json
{
  "_meta": { "version": 2, "count": 55, "levels": { "A1": 6, "A2": 10, "B1": 14, "B2": 12, "C1": 8, "C2": 5 } },
  "videos": ["eci-total-beginners-story", "..."]
}
```

`videos/<id>.json`（节选）：

```json
{
  "id": "bbc-learning-different-generations",
  "youtubeId": "h-NZcQF7jgI",
  "title": "Learning from different generations (6 Minute English)",
  "channel": "BBC Learning English",
  "duration": 379,
  "level": "B1",
  "free": true,
  "source": "youtube",
  "thumbnail": "https://i.ytimg.com/vi/h-NZcQF7jgI/hqdefault.jpg",
  "subtitleSource": "manual",
  "translation": {
    "model": "deepseek-chat",
    "provider": "DeepSeek",
    "promptVersion": "library-video-zh-v1",
    "translatedAt": "2026-11-17T00:00:00+00:00"
  },
  "blocks": [
    { "id": 1, "start": 0.16, "end": 1.02, "en_text": "Hi Georgie.", "zh_text": "嗨，乔治。", "highlights": [] }
  ]
}
```

`articles/<id>.json`（节选）：

```json
{
  "id": "ocean-noise",
  "title": "Why the Ocean Is Getting Louder",
  "level": "B1",
  "wordCount": 269,
  "author": "LinguaTrek 编辑部",
  "license": "原创，免费使用",
  "paragraphs": [{ "en": "When people talk about pollution…", "zh": "当人们谈论海洋污染时…" }]
}
```

公版短文额外带来源字段（`wordCount` 由后端按正文实算，不写进文件）：

```json
{
  "id": "pg-bruce-and-the-spider",
  "title": "Bruce and the Spider",
  "level": "B1",
  "author": "James Baldwin",
  "license": "Public domain (Project Gutenberg #18442)",
  "source": "public-domain",
  "gutenbergId": 18442,
  "sourceUrl": "https://www.gutenberg.org/ebooks/18442",
  "publicDomainBasis": "Published 1896; author James Baldwin (1841–1925)…",
  "paragraphs": [{ "en": "There was once a king of Scotland…", "zh": "从前有一位苏格兰国王……" }]
}
```

## 如何新增资源

### 新增视频

1. 用 `yt-dlp` 校验视频：`playable_in_embed` 为真、有英文 `subtitles` 或
   `automatic_captions`、时长 180–900 秒；失败就换一条，不凑数。
2. 抓英文字幕（人工优先，自动字幕可用但要标 `subtitleSource: "auto"`），按 block 切分；
   把英文字幕块交给现有 LLM 层（`backend/llm.py`）批量翻译成中文，按 block id 对齐；
   构建期一次性调用，运行时零 LLM。译文的模型/prompt/时间/token 记录到
   `translation-manifest.json`。
3. 写 `content/library/videos/<id>.json`，id 用 kebab-case，必须带
   `youtubeId/title/channel/duration/level/free/source/blocks`；每个 block 必须有非空
   `en_text` 与 `zh_text`，`highlights` 可为空数组。
4. 把 id 加进 `videos.json` 的 `videos` 数组，更新 `_meta.count/updatedAt/levels`。
5. 用 `backend/difficulty.py` 计算并写入 `content_difficulty`（`kind=video`，C2 除外；
   M2 词表上限 C1+，C2 由卡片回退编辑等级）。
6. 运行 `cd backend && venv/bin/python -m pytest tests/test_library.py tests/test_library_content.py -q`；
   前端 `npx tsc -b` + `npm run check:i18n`；浏览器里确认筛选 chips、卡片与视频页。

> 字幕来源：优先复用 `data/users/*/history/*.json` 或 `data/guests/*/history/*.json`
> 里已翻译好的缓存；没有缓存时允许用本机后端/LLM **一次性**生成后固化（构建期成本）。
> 2026-11-17 的 52 条扩容使用 `deepseek-chat` 批量翻译，产物见 `translation-manifest.json`。

### 新增文章

1. 写一篇 250–350 词的原创英文短文，按自然段拆成 `paragraphs`，每段配 `zh` 译文；
2. 填好 `author`/`license`（默认「LinguaTrek 编辑部」「原创，免费使用」）与 `level`；
3. 放进 `content/library/articles/<id>.json`，再加进 `articles.json`；
4. 后端会按英文正文重新计算 `wordCount`，列表接口返回的就是实际词数。

公版短文另需（250–400 词）：

1. 只选公有领域文本，保留原文（可做换行/连字符清理，不改写正文）；
2. 每篇配本项目自有中译文，逐段 `en` + `zh`；
3. JSON 写入 `source: "public-domain"`、`gutenbergId`、`sourceUrl`、`publicDomainBasis`；
4. 更新 `articles.json` 与 `gutenberg-manifest.json`。

## 运行时为什么不会调用模型

- `backend/routes_library.py` 只做「读文件 → 校验 → JSON 响应」，不 import `llm`、不连数据库；
- `/api/library*` 列在中间件的公开只读路径里，不创建游客身份；
- 前端视频页直接用本地 `blocks` 渲染字幕，文章阅读器直接用本地段落，打开时不触发估价/处理/翻译接口；
- 视频页的点词查词是用户主动行为，不属于「打开即用」路径，也不影响预置字幕的离线可用；
- `backend/tests/test_library.py` 与 `backend/tests/test_library_content.py` 在完全离线的夹具下跑
  （`llm`/字幕抓取/视频元数据全部被断言拦截），并额外断言 `/api/library*` 的响应不依赖任何处理管线。
