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
├── articles/<id>.json          原创英文全文 + 逐段中文译文
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

## 视频资源（3 个）

| id | YouTube | 频道 | 时长 | 等级 |
|---|---|---|---|---|
| `bbc-learning-different-generations` | `h-NZcQF7jgI` | BBC Learning English | 约 6 分钟 | B1 |
| `teded-better-economy` | `6MK6tuZ7Rws` | TED-Ed | 约 6 分钟 | B1 |
| `kurzgesagt-ai-slop` | `_zfN9wnPvU0` | Kurzgesagt – In a Nutshell | 约 10 分钟 | B2 |

- 三个视频都是真实 YouTube 英语视频，均有英文字幕、时长在 3–20 分钟内；其中 TED-Ed /
  Kurzgesagt 两条来自 `content/curated.json` 的人工精选池，BBC 六分钟那条（用户需求点名的
  `h-NZcQF7jgI`）复用已有处理缓存。
- 双语字幕由本项目**已有的处理缓存一次性固化**（`h-NZcQF7jgI` 等历史缓存），
  这是构建期成本；产物落盘后运行时不再调用模型。
- 每个 block 保留 `en_text` / `zh_text` / `highlights`，与在线视频页的 `TranscriptItem` 同形。
- 许可：字幕/元数据为本地构建产物；原视频版权归对应频道，播放走 YouTube 官方嵌入。

## 文章资源（3 篇，原创）

| id | 标题 | 主题 | 等级 | 词数 |
|---|---|---|---|---|
| `ocean-noise` | Why the Ocean Is Getting Louder | 科普 | B1 | 269 |
| `free-app-hidden-cost` | The Hidden Cost of a Free App | 科技 | B2 | 323 |
| `case-for-doing-nothing` | The Case for Doing Nothing | 生活 | A2 | 269 |

- 作者：**LinguaTrek 编辑部**
- 许可：**原创，免费使用**
- 每篇 250–350 词，逐段 `en` + `zh`；没有任何版权文章被复制。

## 数据结构

`videos.json` / `articles.json` 只是清单：

```json
{ "_meta": { "version": 1 }, "videos": ["bbc-learning-different-generations"] }
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

## 如何新增资源

### 新增视频

1. 把视频 JSON 放进 `content/library/videos/<id>.json`，id 用 kebab-case，
   必须带 `youtubeId/title/channel/duration/level/free/source/blocks`；
2. 每个 block 必须有非空 `en_text` 与 `zh_text`（双语已翻译好），`highlights` 可为空数组；
3. 把 id 加进 `videos.json` 的 `videos` 数组，并更新 `_meta.count/updatedAt`；
4. 运行 `cd backend && venv/bin/python -m pytest tests/test_library.py -q` 校验形状；
5. 运行时不需要新增任何请求路径——后端会自动读新文件。

> 字幕来源：优先复用 `data/users/*/history/*.json` 或 `data/guests/*/history/*.json`
> 里已翻译好的缓存；没有缓存时允许用本机后端/LLM **一次性**生成后固化（构建期成本）。

### 新增文章

1. 写一篇 250–350 词的原创英文短文，按自然段拆成 `paragraphs`，每段配 `zh` 译文；
2. 填好 `author`/`license`（默认「LinguaTrek 编辑部」「原创，免费使用」）与 `level`；
3. 放进 `content/library/articles/<id>.json`，再加进 `articles.json`；
4. 后端会按英文正文重新计算 `wordCount`，列表接口返回的就是实际词数。

## 运行时为什么不会调用模型

- `backend/routes_library.py` 只做「读文件 → 校验 → JSON 响应」，不 import `llm`、不连数据库；
- `/api/library*` 列在中间件的公开只读路径里，不创建游客身份；
- 前端视频页直接用本地 `blocks` 渲染字幕，文章阅读器直接用本地段落，打开时不触发估价/处理/翻译接口；
- 视频页的点词查词是用户主动行为，不属于「打开即用」路径，也不影响预置字幕的离线可用；
- `backend/tests/test_library.py` 在完全离线的夹具下跑（`llm`/字幕抓取/视频元数据全部被断言拦截），
  并额外断言 `/api/library*` 的响应不依赖任何处理管线。
