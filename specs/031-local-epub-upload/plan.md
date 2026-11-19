# 031 — 本地 EPUB 上传 · 技术方案

> 配套 [spec.md](./spec.md)。设计阶段，未实现。

## 1. 模块划分

| 模块 | 职责 |
|---|---|
| `backend/local_epub.py`（新） | EPUB 校验、解析、章节文本抽取、封面提取、存储目录管理 |
| `backend/routes_book_upload.py`（新） | `preview` / `upload` 两个 multipart 端点、错误映射、限流 |
| `backend/book_import.py`（改） | `list/get/chapter/delete` 按 `source_type` 分支；本地章节读文件；`_ref_from_book` 允许 `local_epub` |
| `backend/storage.py`（改/复用） | `user_books_dir(user_id)`，只由服务端拼路径 |
| `frontend/src/components/BookImportDialog.tsx` | 增加 Tabs：链接 / 上传；复用 Dialog/Tabs |
| `frontend/src/lib/localBooks.ts`（新） | 上传（XHR 进度）、预览、错误码映射 |
| `frontend/src/components/ImportedBooksShelf.tsx` | 来源徽章、删除菜单、本地书置顶 |
| `backend/requirements.txt` | 增加 `python-multipart`（UploadFile 需要） |

## 2. 解析流程

```
UploadFile
  → size/extension/MIME 初检
  → 写入临时文件（不信任文件名）
  → zipfile 打开：条目数/解压总量/加密检查
  → META-INF/container.xml → OPF
  → dc:title/dc:creator/dc:language/dc:identifier
  → manifest + spine（去重、只取 XHTML）
  → nav.xhtml/NCX → 目录标题；失败回退 h1/spine
  → 每章：HTMLParser/XHTML 段落抽取 → paragraphs[]
  → 封面提取（可选）
  → 成功：写 meta.json + chapters/*.json；删除临时文件
```

### 限制常量（config 可覆盖）

```python
MAX_EPUB_BYTES = 30 * 1024 * 1024
MAX_EPUB_UNCOMPRESSED = 200 * 1024 * 1024
MAX_EPUB_ENTRIES = 2000
MAX_EPUB_CHAPTERS = 300
MAX_EPUB_CHAPTER_CHARS = 1_000_000
MAX_LOCAL_BOOKS_PER_USER = 20
```

## 3. 数据库兼容

- 不新增迁移：复用 `imported_books`
- `source_type='local_epub'`；`external_id='epub:<sha256>'`
- `chapters_json` 为 v2；现有 `_decode_chapters` 只读 `chapters` 数组，向后兼容
- `_ref_from_book` 目前只允许两个 provider；本地分支不应走 `SourceRef`，在 `list/get` 里分流
- `source_url` 非空约束：写 `local://<sha256>`，不暴露给前端

## 4. 存储与清理

```
USER_DATA_DIR/<user_id>/imported-books/<book_id>/
  meta.json
  chapters/0001.json
  cover.jpg
```

- 先写临时目录 `<book_id>.tmp/`，成功后原子 rename
- 失败/取消：删除临时目录；不写 DB
- 删除：删 DB（级联译文）→ 删目录；目录删除失败记录日志但不假成功
- 读取：`book_id` 只允许 `[a-z0-9-]`，并与当前 user_id 一起校验；不拼接客户端路径

## 5. API 细节

### preview

- `UploadFile` 流式读，超过 `MAX_EPUB_BYTES` 立即 413 并停止
- 解析成功返回 `uploadToken`（内存/临时目录，5 分钟 TTL）
- 不写 DB；不保留原文件超过 TTL

### upload

- 接收 `uploadToken`（优先）或再次 `file`
- 校验 `rightsAccepted === true`；否则 400
- 计算 SHA-256；查同用户同 hash → 返回 existing
- 配额检查（日限/书数/总文本）在写 DB 前
- 事务：写 DB → 落目录；任一步失败回滚/清理

### 错误码

| 情况 | HTTP |
|---|---|
| 非 EPUB / 损坏 | 400 |
| DRM/加密 | 422 |
| 超大小/章节数 | 413 |
| 无正文/非英文 | 422 |
| 未登录 | 401 |
| 超日限/总配额 | 429 |
| 数据库/目录不可用 | 503 |

## 6. 前端

- 复用 `Dialog`、`Tabs`、`Button`、`ConfirmDialog`
- 拖拽区 `onDrop` 只取一个 `.epub`；`accept=".epub,application/epub+zip"`
- 上传用 `XMLHttpRequest.upload.onprogress` 显示百分比；解析阶段切文案
- 错误映射到具体 key，不把后端英文原文直接给用户
- 书架：`sourceType === 'local_epub'` → `Badge`「本地」
- `ImportedBooksShelf` 的删除走 ConfirmDialog；成功后 re-fetch
- 阅读器无需改接口形状；只需来源标签分支

## 7. 测试

- 单元：解析器（合法/损坏/DRM/zip bomb/路径穿越/无 TOC/单章/上限）
- API：preview/upload/幂等/权限/删除/配额/翻译缓存
- 前端：Playwright 上传/取消/失败/重试/阅读/删除/375
- 真实文件：至少 EPUB2 + EPUB3 + 含封面各一

## 8. 风险

| 风险 | 处理 |
|---|---|
| 版权滥用 | UI 声明 + 私有 + 删除 + 管理员下架；不做公开分发 |
| ZIP bomb | 解压前限制条目/总大小；流式读取 |
| XSS | 只抽纯文本，绝不渲染 EPUB HTML |
| 大文件阻塞 | 临时文件 + 后台线程/请求内解析；限制 30MB |
| 存储增长 | 20 本/用户、100MB 文本、删除清理、后台统计 |
| EPUB 结构差异 | 标准库解析 + 回退 TOC/标题；失败给可读原因 |
| 与现有公版书边界冲突 | 明确「两种来源」：公版链接白名单 + 本地私有文件；不上架、不公开 |
