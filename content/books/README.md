# 公版书系列阅读库（content/books）

内容页「公版书」窗与 `#/content/book/<id>` 阅读器读取这里。当前收录 **8 个系列
/ 75 本书 / 71 本原文可读 / 1164 章索引 / 48 章中译**。

## 架构：只存译文，原文每次按需抓取

这是用户明确要求的架构，也是本目录最重要的约束：

- 仓库**只存书目/章节索引 + 我们的中译文**；
- **英文原文不落仓库、不建数据库表、不写缓存文件**；
- 打开某一章时，后端按 `sourceUrl` 从 Project Gutenberg 实时抓取纯文本，
  解析成段落，再与本地译文按下标对齐返回 `{en, zh}`；
- 正常请求每次都抓取；源站故障时只允许使用**进程内 5 分钟内存缓存**降级，
  绝不写磁盘；
- 未翻译的章节照常返回原文，`zh: null`；阅读时不调用任何大模型。

## 收录范围

| 系列 id | 系列 | 作者 | 系列书目 | 可读 | 章节索引 | 已译 |
|---|---|---|---:|---:|---:|---:|
| `oz` | Oz 系列 | L. Frank Baum | 14 | 14 | 341 | 6 |
| `peter-rabbit` | Peter Rabbit 系列 | Beatrix Potter | 23 | 21 | 21 | 21 |
| `alice` | Alice 系列 | Lewis Carroll | 2 | 2 | 24 | 6 |
| `sherlock-holmes` | Sherlock Holmes 系列 | Arthur Conan Doyle | 9 | 9 | 112 | 3 |
| `anne` | Anne of Green Gables 系列 | L. M. Montgomery | 6 | 6 | 219 | 3 |
| `five-children` | Five Children 三部曲 | E. Nesbit | 3 | 3 | 37 | 3 |
| `doctor-dolittle` | Doctor Dolittle 系列 | Hugh Lofting | 5 | 3 | 116 | 3 |
| `tarzan` | Tarzan 系列 | Edgar Rice Burroughs | 13 | 13 | 294 | 3 |

- **只收美国公版**（2026 年：1930 年及以前出版）。每本在 `books.json` 写
  `license` / `publicDomainBasis` / `sourceUrl` / `catalogUrl` / `gutenbergId`。
- 系列级 `excluded` 明确列出未收录作品与原因：
  - Anne of Windy Poplars (1936)、Anne of Ingleside (1939)：版权未到期；
  - Oz 非 Baum 续作 26 本：不属于 Baum 14 本范围；
  - Doctor Dolittle 1926–1928（已公版但超出 1920–1925 范围）与 1933+（未到期）；
  - Tarzan 1931+ 共 10 本：版权未到期。
- Project Gutenberg 暂无单行本的 4 卷（Appley Dapply、Little Pig Robinson、
  Dolittle's Circus、Dolittle's Zoo）标 `coming_soon`，在系列页显示原因，
  不提供正文。
- Pigling Bland 的正文取自 Gutenberg #572《The Great Big Treasury of Beatrix
  Potter》中的同名故事（PG 无单行本）。

## 章节索引与解析

`books.json` 的每章除了 `n` / `title`，还有构建期从同一版本公版源提取的：

- `anchor`：章节标题行（或标题行 + 首行）的规范化文本；
- `occurrence`：该标题在源文本中第几次出现（处理“目录 + 正文”重复）；
- 可选 `skipTitle`：锚点是 `CHAPTER I` 这类纯编号行时，跳过下一行标题。

运行期按 `anchor` 顺序切章，不存偏移量、不存原文；源文本更新导致锚点找不到时
返回 503，而不是悄悄错位。

## 目录结构

```
content/books/
├── books.json                       系列 + 书目 + 章节索引 + 公版元数据
├── README.md
└── <bookId>/chapters/<n>.zh.json    段落级中译文（不含英文原文）
```

`chapters/<n>.zh.json`：

```json
{
  "schema": "books.chapter.zh.v1",
  "bookId": "sh-a-study-in-scarlet",
  "chapter": 1,
  "title": "歇洛克·福尔摩斯先生",
  "paragraphs": ["……"],
  "meta": {
    "promptVersion": "books-zh.v1",
    "model": "deepseek-chat",
    "generatedAt": "2026-11-17T…Z",
    "source": "Project Gutenberg #244",
    "sourceUrl": "https://www.gutenberg.org/cache/epub/244/pg244.txt",
    "sourceTitle": "MR. SHERLOCK HOLMES",
    "paragraphCount": 69
  }
}
```

## 重建目录（可复现）

```bash
# 抓 Gutenberg HTML/纯文本 → 提取章节标题/锚点/词数 → 写 books.json
backend/venv/bin/python scripts/build_books_catalog.py
# 只翻译指定书/章节（构建期一次，带 prompt 版本与时间）
backend/venv/bin/python scripts/build_books.py --only sh-a-study-in-scarlet --chapters 1,2,3
backend/venv/bin/python scripts/build_books.py --dry-run
```

`build_books_catalog.py` 会把 Gutenberg 文本缓存在 `/tmp/yt-books-catalog`（不写
仓库）；`build_books.py` 默认跳过已有完整译文，失败可重跑。

## 接口

- `GET /api/books`：系列分组 + 每本可读/已译章节数 + 排除清单；
- `GET /api/books/{id}`：元数据 + 全部章节索引（含 `translated` / `titleZh`）；
- `GET /api/books/{id}/chapters/{n}`：实时抓取原文 + 按段对齐译文，`no-store`。

公开只读、免登录、不发游客 Cookie；章节按 IP 限速。详见
`backend/routes_books.py` / `backend/books.py`。

## 版权与内容提示

公版文本可能含过时的观念或冒犯性表达。书页显示内容提示；译文按原意翻译，
不删改、不美化。
