# 公版书系列阅读库（content/books）

内容页「公版书」窗与 `#/content/book/<id>` 阅读器读取这里。

## 架构：只存译文，原文每次按需抓取

这是用户明确要求的架构，也是本目录最重要的约束：

- 仓库**只存书目/章节索引 + 我们的中译文**；
- **英文原文不落仓库、不建数据库表、不写缓存文件**；
- 打开某一章时，后端按 `sourceUrl` 从 Project Gutenberg 实时抓取纯文本，
  解析成段落，再与本地译文按下标对齐返回 `{en, zh}`；
- 正常请求每次都抓取；源站故障时只允许使用**进程内 5 分钟内存缓存**降级，
  绝不写磁盘；
- 译文由构建期管线（`scripts/build_books.py` + `backend/llm.py`）一次性生成，
  阅读时不调用任何大模型。

## 首发三组系列

| 系列 id | 系列 | 作者 | 系列总数 | 已导入 | 可读章节 |
|---|---|---|---|---:|---:|
| `oz` | Oz 系列 | L. Frank Baum | 14 | 1 本 | 6 章（第 1–6 章） |
| `peter-rabbit` | Peter Rabbit 系列 | Beatrix Potter | 23 | 3 本 | 每本 1 章（全文） |
| `alice` | Alice 系列 | Lewis Carroll | 2 | 1 本 | 6 章（第 1–6 章） |

已导入书目：

| bookId | 书名 | 年份 | Gutenberg | 状态 |
|---|---|---:|---:|---|
| `oz-the-wonderful-wizard-of-oz` | The Wonderful Wizard of Oz | 1900 | [#55](https://www.gutenberg.org/ebooks/55) | 可读第 1–6 章，共 24 章 |
| `pr-the-tale-of-peter-rabbit` | The Tale of Peter Rabbit | 1902 | [#14838](https://www.gutenberg.org/ebooks/14838) | 全文 |
| `pr-the-tale-of-benjamin-bunny` | The Tale of Benjamin Bunny | 1904 | [#14407](https://www.gutenberg.org/ebooks/14407) | 全文 |
| `pr-the-tale-of-jemima-puddle-duck` | The Tale of Jemima Puddle-Duck | 1908 | [#14814](https://www.gutenberg.org/ebooks/14814) | 全文 |
| `alice-alices-adventures-in-wonderland` | Alice's Adventures in Wonderland | 1865 | [#11](https://www.gutenberg.org/ebooks/11) | 可读第 1–6 章，共 12 章 |

其余书目在 `books.json` 中标记为 `coming_soon`：只列书名、年份与公版源链接，
没有章节文件，阅读器显示「即将上线」。

## 版权与内容提示

- 只用 **Project Gutenberg**（含 PGLAF 镜像）等公版文本；逐本核对 **Public
  domain in the US**，每本书的 `source` / `license` / `sourceUrl` 都写在
  `books.json` 里。
- 不做仍受版权保护的作品（Magic Tree House、Narnia、Harry Potter 等）。
- 公版文本可能含过时的观念或冒犯性表达。书页会显示一句内容提示；译文按原意
  翻译，不删改、不美化。

## 目录结构

```
content/books/
├── books.json                       系列 + 书目 + 章节索引 + source/license/sourceUrl
├── README.md
└── <bookId>/chapters/<n>.zh.json    段落级中译文（不含英文原文）
```

`books.json` 关键字段：

```json
{
  "series": [{
    "id": "oz",
    "title": "Oz 系列",
    "author": "L. Frank Baum",
    "description": "……",
    "books": [{
      "id": "oz-the-wonderful-wizard-of-oz",
      "title": "The Wonderful Wizard of Oz",
      "titleZh": "绿野仙踪",
      "year": 1900,
      "level": "B1",
      "status": "available",
      "source": "Project Gutenberg",
      "license": "Public domain in the US",
      "sourceUrl": "https://www.gutenberg.org/cache/epub/55/pg55.txt",
      "catalogUrl": "https://www.gutenberg.org/ebooks/55",
      "gutenbergId": 55,
      "totalChapters": 24,
      "parser": { "mode": "chapters" },
      "chapters": [{ "n": 1, "title": "旋风来了" }]
    }]
  }]
}
```

`chapters/<n>.zh.json` 只含中译文与生成元数据：

```json
{
  "schema": "books.chapter.zh.v1",
  "bookId": "oz-the-wonderful-wizard-of-oz",
  "chapter": 1,
  "title": "旋风来了",
  "paragraphs": ["多萝西住在堪萨斯大草原的中央……"],
  "meta": {
    "promptVersion": "books-zh.v1",
    "model": "deepseek-chat",
    "generatedAt": "2026-11-17T…Z",
    "source": "Project Gutenberg #55",
    "sourceUrl": "https://www.gutenberg.org/cache/epub/55/pg55.txt",
    "sourceTitle": "The Cyclone",
    "paragraphCount": 20,
    "translator": "LinguaTrek build pipeline (offline)"
  }
}
```

译文按源文本段落**逐段生成、逐段对齐**；`paragraphs` 的某项为 `null` 时，
接口返回 `zh: null`，前端显示「译文待生成」，不会运行时调用 AI 补译。

> `books.json` 里的 `parser.bodyStart` 是**解析锚点**（无章节短篇用来定位正文
> 起点的一小句），不是原文全文；小说类只靠 `Chapter I` 这类结构行定位。

## 构建译文（一次性、可增量）

```bash
# 需要 .env 里的模型 Key；默认 deepseek-chat，3 并发
backend/venv/bin/python scripts/build_books.py --dry-run
backend/venv/bin/python scripts/build_books.py
backend/venv/bin/python scripts/build_books.py --only oz-the-wonderful-wizard-of-oz --force
```

脚本会：

1. 读 `books.json`，只处理 `status=available` 的书；
2. 从 `sourceUrl` 抓取公版纯文本（PG 主站维护时自动回退 PGLAF 镜像）；
3. 用 `backend/llm.py` 分批翻译，校验段落数/中文非空，失败会拆分重试；
4. 写 `chapters/<n>.zh.json`，记录 prompt 版本、模型与生成时间；
5. 默认跳过已有完整译文，失败章节可重跑。

> 翻译质量抽查过开头、对话、结尾等段落；专有名词统一译名表写在脚本
> `GLOSSARIES` 里。公版文本语言较旧，译文以忠实原意为先。

## 新增一本可读书

1. 在 `books.json` 的对应系列里把该书 `status` 改为 `available`，补
   `totalChapters`、`chapters`（章节号 + 中文标题）、`parser`；
2. 对 `parser`：
   - 小说类（Gutenberg 有 `Chapter I` / `CHAPTER I.` 行）：`{ "mode": "chapters" }`；
   - 无章节的短篇：`{ "mode": "single", "bodyStart": "正文第一段开头" }`；
3. 运行 `scripts/build_books.py --only <bookId>` 生成译文；
4. 运行后端测试：`cd backend && venv/bin/python -m pytest tests/test_books.py -q`。

注意：`sourceUrl` 必须是 https 公版源白名单站点（`gutenberg.org` /
`gutenberg.pglaf.org` / `standardebooks.org`）；书单校验会拒绝其它域名。

## 接口

- `GET /api/books`：系列分组 + 每本可读章节数；
- `GET /api/books/{id}`：元数据 + 已导入章节索引 + 同系列全部书目；
- `GET /api/books/{id}/chapters/{n}`：实时抓取原文 + 按段对齐译文，`no-store`。

公开只读、免登录、不发游客 Cookie；章节按 IP 限速。详见
`backend/routes_books.py` / `backend/books.py`。
