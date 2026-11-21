# 031 — 本地 EPUB 上传

> 状态：**M1 已实现（后端 + 前端，待集成验收）** ｜ 2026-11-19
> 依赖：019 读文章、021 后台、公版书导入（`imported_books` / `ImportedBookReader` / `book_import.py`）
> 目标版本：上线后第一个迭代；不改变现有 Gutenberg / Standard Ebooks 链接导入

> **v1.1 任务 5 增补（2026-11-21，已实现）**：导入书章节接口新增可选
> `?level=`，按需生成本章教学分析（上下文释义 / 习语 / 文化点），与公版书
> 共用缓存与计费；详见 §13。对应代码：`backend/routes_book_import.py`、
> `backend/book_import.py`、`frontend/src/lib/importedBooks.ts`、
> `frontend/src/components/ImportedBookReaderScreen.tsx`。

> 一句话：登录用户上传自己有权使用的无 DRM EPUB，在「我的书」里按章阅读、点词、翻译。

## 1. 目标

- 从内容页「我的书」块头部进入「导入」，增加 **上传 EPUB** 页签
- 文件只在账号下私有保存；导入后出现在「我的书」，与现有导入书共用阅读器
- 章节、目录、标题、作者、封面（可选）自动提取；失败给出可操作原因
- 按章翻译复用现有 `imported_book_translations` 与 AI 配额；缓存命中不扣费
- 删除书时同时删除本地文件、章节文本与译文

## 2. 非目标

- 不做 PDF / MOBI / AZW3 / TXT；不做 EPUB 转 PDF
- 不做 DRM 破解、去水印、OCR、扫描版修复
- 不做在线书城、公开分享链接、跨用户借阅
- V1 不做插图阅读、脚注弹层、朗读；只保留正文与目录
- 不做「自动识别版权」；版权由上传者声明，产品只做边界与删除机制

## 3. 产品边界（必须写进 UI）

- 仅接受 **公版书** 或 **用户拥有使用权的自有文件**
- 仅接受 **无 DRM** 的 EPUB；加密/DRM 文件直接拒绝，不做绕过
- 文件仅当前账号可见，不生成公开 URL，不进入推荐/搜索/博客
- 上传者需勾选「我确认有权使用此文件，且不会上传盗版或未授权内容」
- 删除即删除：数据库书目、章节文件、译文缓存、封面全部清理
- 侵权投诉/管理员可下架（后续 021 后台加只读入口；V1 先记录 `reported` 状态或人工删除）

> 说明：产品无法技术性判断版权归属；因此这里的承诺是“私有 + 声明 + 可删除”，不是“版权校验”。这和现有「仅 Gutenberg / Standard Ebooks 链接」的严格白名单不同，是新增的、有边界的个人文件通道。

## 4. 用户流程

### 4.1 入口

内容页 → 「我的书」块 → 头部右侧「导入书籍」→ Dialog 两个页签：

```
[ 公版书链接 ]  [ 上传 EPUB ]
```

- 入口在「我的书」块头部（与标题同一行，`flex-wrap`）；游客可见入口但点不到书：
  点击先弹登录浮层，游客不加载「我的书」列表（不产生 403 错误态）
- 保留现有链接导入的预览/确认流程
- 上传页签支持拖拽与文件选择，接受 `.epub`，显示大小上限
- 上传成功后：关闭 Dialog → 「我的书」列表刷新 → 该书置顶并标记「本地」

### 4.2 上传与预览

1. 选择文件 → 前端校验扩展名/MIME/大小（30MB）
2. 上传到 `preview` 端点 → 后端解析（不落库）
3. 展示：
   - 封面（有则显示，无则书本占位）
   - 标题 / 作者 / 语言
   - 章节数 / 文件大小 / 预计阅读时长（按 200 词/分钟估算）
   - 「仅自己可见」提示
4. 勾选权利声明 → 「加入我的书」
5. 上传/解析进度：选择文件 → 上传中 → 解析中 → 完成；可取消
6. 重复文件（同账号同 SHA-256）直接返回已有书，不重复占配额

### 4.3 阅读

- 进入现有导入书阅读器路由：`#/app/profile/learn/imported-book/<id>`（沿用现有路由）
- 目录来自 EPUB spine/TOC；章节标题保留
- 段落级点词、翻译、隐藏中文、阅读进度与现有书一致
- 本地书来源标记「本地 EPUB」，不显示外链
- 无译文时仍可读原文；翻译按章触发，失败可重试

### 4.4 删除

- 书架卡片菜单 → 删除 → ConfirmDialog
- 提示「会删除本地文件与已生成译文」
- 删除后列表移除；失败不假成功

## 5. UI 规格

### 5.1 Dialog

- 复用 `Dialog`（B2 已统一），`size="md"`，移动端 sheet
- 页签用现有 `Tabs`（panel skin），不新增导航模型
- 拖拽区：虚线边框、`拖入 EPUB 或点击选择`、`最大 30MB`
- 选中文件后显示文件名/大小/移除按钮
- 主按钮 `加入我的书`；次按钮 `取消`
- 错误区：内联 `role=alert`，不覆盖表单
- 成功：toast「已加入我的书」；失败保留文件选择，可重试

### 5.2 书架

- 入口：`data-testid="book-import-open"` 的「导入书籍」按钮在「我的书」
  （`ImportedBooksShelf`）块头部右侧，与标题同一行；文案 key
  `importedBooks.importButton` 与 Dialog 归属（`BooksSection`）不变
- 游客视图：块头部标题 + 按钮 + 一行 `importedBooks.guestHint`；不请求
  `/api/books/imported`，不显示空/错误态
- `ImportedBooksShelf` 卡片增加来源徽章：
  - 公版链接：`公版`
  - 本地上传：`本地`
- 书架头部显示 `本地 N 本` 与总容量（后续）
- 空态：`还没有导入的书` + 两个入口

### 5.3 文案（zh / vi 同步）

- `importedBooks.dialog.tabs.link` / `.upload`
- `importedBooks.upload.dropHint` / `.choose` / `.maxSize`
- `importedBooks.upload.rights` / `.rightsHint`
- `importedBooks.upload.parsing` / `.uploading`
- 错误：`notEpub` / `drm` / `tooLarge` / `corrupt` / `noChapters` / `unsupportedLanguage`
- 所有文案走 i18n，不硬编码中文

## 6. 数据与存储

### 6.1 复用现有表

不新增表；`imported_books` 增加一种来源：

| 字段 | 值 |
|---|---|
| `source_type` | `local_epub` |
| `source_url` | `local://<sha256>`（仅标识，不可访问） |
| `external_id` | `epub:<sha256>` |
| `title` / `author` / `language` | EPUB metadata，缺失时回退文件名/`Unknown`/`en` |
| `chapters_json` | v2：章节索引 + 本地相对路径，不含正文 |

`chapters_json` v2 示例：

```json
{
  "version": 2,
  "provider": "local_epub",
  "originalFilename": "pride-and-prejudice.epub",
  "sha256": "…",
  "chapters": [
    {"n": 1, "title": "Chapter I", "file": "chapters/0001.json", "chars": 5321}
  ]
}
```

唯一键 `(user_id, source_type, external_id)` 天然防重复。

### 6.2 文件布局

```text
<USER_DATA_DIR>/<user_id>/imported-books/<book_id>/
  meta.json          # 标题/作者/语言/封面路径（可选）
  chapters/0001.json # {"title":"...","paragraphs":["...", "..."]}
  cover.jpg          # 可选，从 EPUB 提取并压缩
```

- 原始 EPUB 解析成功后删除，不长期保留（减少隐私面）
- 章节文件只存纯文本段落；不保留脚本/样式/外链
- 读取时按 `book_id` + 用户校验，路径不得由客户端传入

### 6.3 配额

| 项 | 默认 |
|---|---|
| 单文件 | 30MB（压缩后） |
| 解压后总大小 | 200MB |
| 单章节文本 | 1MB |
| 章节数 | 300 |
| 每用户本地书 | 20 本 |
| 每用户总文本 | 100MB |
| 上传频率 | 10 次/天（沿用 `book_import` 日限） |

超限返回 413/429，并给明确剩余量。

## 7. API

全部需登录；游客 401。

### `POST /api/books/upload/preview`

`multipart/form-data`：`file`（EPUB）

- 校验与解析，不落库；返回 metadata + chapterCount + cover 临时 URL/占位
- 错误：400 非 EPUB/损坏、413 超限、422 DRM/加密/无章节/非英文、429 限流
- 解析结果可缓存 5 分钟（`uploadToken`），确认时复用，避免重复上传

### `POST /api/books/upload`

`multipart/form-data`：`file` 或 `uploadToken` + `rightsAccepted=true`

- 幂等：同 hash 返回 `{bookId, status:"ok", existing:true}`
- 成功写入书目 + 章节文件 + 可选封面；事务失败清理临时目录
- 返回 `{bookId, title, chapterCount, sourceType:"local_epub"}`

### 其他

- `GET /api/books/imported`：增加 `sourceType` / `local` 字段
- `GET /api/books/imported/{id}/chapters/{n}`：按 `sourceType` 分支；本地读文件；
  可选 `?level=` 按需附加教学分析（见 §13）
- `POST .../translate`：沿用现有翻译与配额
- `DELETE /api/books/imported/{id}`：删除记录 + 整个本地目录
- 不需要新迁移；若后续加容量统计再加表/列

## 8. 解析与安全

### 8.1 EPUB 解析

- 只依赖标准库 `zipfile` + `xml.etree.ElementTree`（不引入重量级 EPUB 库）
- `META-INF/container.xml` → OPF 路径 → metadata + manifest + spine
- 目录：EPUB3 `nav.xhtml`，回退 EPUB2 NCX；再回退 spine 顺序
- 文本：XHTML → 段落（`p`/`h1`–`h3`/`li`），去脚本/样式/图片；规范化空白
- 标题：章节 `title`/`h1` → TOC 文本 → `Chapter N`
- 封面：EPUB3 `cover-image` 或 manifest `cover`，可压缩为 400px 宽 JPEG

### 8.2 安全

- ZIP：拒绝加密条目；限制条目数/单条大小/总解压大小；拒绝 `..` 路径
- XML：禁用外部实体/DTD；不解析远程资源
- 文件名：只允许 basename，不参与路径拼接
- 存储：所有路径由服务端生成；`book_id` 使用 `epub-<uuid>`，不采用用户输入
- 内容：只渲染纯文本段落，禁止把 EPUB HTML 原样注入前端
- 频控：上传/预览共用 `/api/books/*` IP 桶 + 用户日限
- 隐私：私有目录；不写日志正文；不返回其他用户书

### 8.3 法律边界

- UI 明示仅公版/自有授权文件；不提供 DRM 绕过
- 不提供公开分享、下载原文件、批量导出正文
- 删除即清理；保留删除审计（只记 id/时间，不记正文）
- 后续如需更强合规：管理员可下架、用户举报入口、DMCA 流程

## 9. 阅读器兼容

- `ImportedBookReader` 已按 `sourceType`/章节接口读取；新增本地来源只需保证返回形状一致
- 章节 payload 不带 `level` 时仍为 `{title, paragraphs:[{index,en,zh}]}`；`zh` 无译文为 null；
  带 `level` 且分析成功时额外返回 `glosses` / `languagePoints` / `analysisVersion` /
  `analysisLevel`（见 §13）
- 目录/进度/字体/隐藏中文/点词不区分来源
- 书名旁显示「本地」徽章；不显示「查看原网页」

## 10. 验收

### 后端

- 解析合法 EPUB3 / EPUB2 / 无 TOC / 单章 / 300 章上限
- 拒绝：非 ZIP、损坏 ZIP、加密/DRM、zip bomb、路径穿越、无正文、超大文件
- 幂等：同文件二次上传返回 existing，不重复占配额
- 权限：A 用户不能读/删 B 用户的书
- 删除：DB + 章节 + 封面 + 译文全部清理
- 翻译：本地章节走同一条翻译/配额/缓存路径
- 章节分析（v1.1 任务 5）：带 `level` 且译文齐全 → `glosses` / `languagePoints` /
  `analysisLevel`；不带 `level` → 旧形状且不触发生成；未翻译/分析失败 → 200 旧形状；
  非法 `level` → 400
- 章节分析缓存命中零模型零扣费（与公版书同缓存键）

### 前端

- tsc / build / check:i18n
- Playwright：链接页签回归；上传页签选择/拖拽/预览/确认/失败/取消；375/1440
- 书架显示「本地」；点击进入阅读器；删除确认
- 键盘：Dialog 焦点、Tabs 方向键、拖拽区可点击选择
- （v1.1 任务 5）打开章节默认不生成分析；「生成本章词条」按钮点击后才带 `level`，
  生成期间禁用，失败只显示轻提示、章节照常可读

### 人工

- 用 3 本真实 EPUB（有封面/无封面/EPUB2）各上传一次，读 3 章
- 关闭浏览器重开，书仍在；换账号不可见
- 断网/中断上传不产生半本书

## 11. 分期

| 阶段 | 内容 |
|---|---|
| M1 | 预览/导入/存储/阅读/删除 + 基础错误，英文 EPUB |
| M2 | 封面、TOC 优化、进度、上传进度条、配额展示 |
| M3 | 多语言 EPUB、管理员下架、举报/审计 |

## 12. 待确认

1. **V1 是否只支持英文 EPUB？** 现有阅读器点词/翻译按英文设计；建议 V1 只收英文，其他语言返回 `unsupportedLanguage`。
2. **文件是否只存在服务器？** 本设计为账号私有服务器存储（可跨设备）；如果只想浏览器本地读，需要另一套 IndexedDB 方案。
3. **单文件上限 30MB 是否合适？** 含插图的 EPUB 可能更大；V1 只取文本，30MB 足够大多数文字书。
4. **是否允许非公版的自有文件？** 当前设计允许“自有授权”，靠声明和私有存储；若要坚持只公版，需加白名单/人工审核，成本和可用性都会变差。

## 13. 章节按需教学分析（v1.1 任务 5，2026-11-21）

> 适用于导入书章节接口（Gutenberg / Standard Ebooks 链接导入与本地 EPUB 共用），
> 不改变 §9 的阅读器默认行为。教学分析本身的口径见
> [specs/028](../028-teaching-analysis/spec.md)。

### 13.1 API

`GET /api/books/imported/{id}/chapters/{n}?level=<高亮档>&targetLang=<语言>`

- `level` 是**高亮难度档**（specs/004 的档位 id；旧考试 id 会映射），不是 CEFR
  字母。非法档位 → **400**（`detail` 含「高亮等级」）；需要登录，游客/未登录 **403**。
- 省略 `level`：不生成、不读分析缓存，响应与旧版完全一致，打开章节零 AI 调用。
- 带入 `level` 且满足条件时，额外返回：
  - `paragraphs[].glosses`：`{小写词: 上下文释义}`；原始 `highlights` 不回传；
  - `languagePoints`：`[{blockId, text, meaning, kind}]`，`kind ∈ {idiom, culture}`，
    `blockId` 就是段落 `index`（点词/跳转据此对齐）；
  - `analysisVersion`：分析 schema 版本（当前 `analysis.v5`）；
  - `analysisLevel`：本次实际使用的档位。
- 以下情况返回 **200 旧形状**（不新增字段、不写空释义缓存）：
  本章 `missingTranslations > 0`、段落为空、任一段 `zh` 缺失/为空；
  分析本身失败也静默兜底，不阻塞读书。

### 13.2 按需与成本

- **打开章节绝不自动生成**：前端只有「生成本章词条」按钮会带 `level`
  （D5-1；一本 EPUB 可能几十章，逐章生成会瞬间吃光配额）。
- 生成/读取都走 `teaching_analysis.attach_to_payload`，缓存键
  `(content_hash, level, target_lang, analysis_version)`，与公版书共用；命中时
  零模型零扣费。`content_ref` 为 `book:<bookId>:<chapter>`。
- 计费/配额沿用 specs/028 的 `feature=analysis` 路径；无登录时前端引导登录。
- 分析失败静默：章节仍可读，前端只显示一行轻提示。

### 13.3 前端

- `fetchImportedChapter(bookId, n, {level, signal})`：不传 `level` 的路径保持原样。
- 阅读器工具栏新增「生成本章词条」按钮与语言点开关；`languagePoints` 按
  `blockId` 分组渲染到对应段落，`glosses` 交给 `ReadingHighlight`。
- 生成期间按钮禁用；切换章节时丢弃迟到的结果；未翻译章节点按钮只得到轻提示。

### 13.4 测试

`backend/tests/test_book_import.py` 新增 5 例（打桩 `attach_to_payload`，不调模型）：
带 `level` 的分析字段形状、不带 `level` 的旧形状且零调用、未翻译章节跳过、
分析失败静默、非法 `level` 400。
