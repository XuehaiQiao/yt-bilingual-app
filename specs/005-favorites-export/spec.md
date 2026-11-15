# 规格：收藏与导出

**状态：** 已实现（M1 ④ 按条 API：2026-11-15；生词折叠与出处：2026-11-16）｜ **对应代码：** `backend/routes_user.py`（`/api/favorites`）、`backend/storage.py`（路径 + 墓碑文件）、`frontend/src/lib/favorites.ts`、`frontend/src/App.tsx`、`frontend/src/components/FavoritesModal.tsx`、`frontend/src/components/ReaderScreen.tsx`、`frontend/src/components/SentenceView.tsx`、`frontend/src/lib/exporter.ts`

---

## 目标
打通学习闭环的最后一环——把"看过/查过"沉淀成"可复习"。收藏不能是死胡同，必须能导出到真正的复习工具。

## 用户故事
- 作为用户，我想**星标**重要的句子和生词，连同它们的来源语境一起存下来。
- 作为用户，我想把收藏**导出到 Anki** 做间隔重复，或导成表格自己整理。
- 作为同时开两个标签页/两台设备的用户，我在一边加/删收藏，另一边不会把整份收藏覆盖掉。

## 功能需求
- **必须**：可收藏两类——整句、单词（生词）；都带来源句、视频、时间点。
- **必须**：收藏持久化到后端（每用户 `favorites.json`），后端不可用时退回 localStorage。
- **必须**：按条写入（`POST /api/favorites`、`DELETE /api/favorites/{id}`），不再由前端发整文件 PUT；旧 `PUT /api/favorites` 只作兼容保留。
- **必须**：同一条收藏有稳定 `id`；重复 POST 幂等（按 id 或内容指纹去重）。
- **必须**：删除不存在的收藏返回 `404`；缺少 `text` 或非法 `type` 返回 `400`；未登录仍是 `401`（由会话中间件统一处理）。
- **必须**：旧 `favorites.json` 里没有 `id` 的记录读取时补稳定 `id`，不丢数据、不在 GET 时改写文件。
- **必须**：并发安全——同一用户的读-改-写用文件锁串行化，并用 tmp + `os.replace` 原子落盘；两个请求同时加收藏不能丢一条。
- **必须**：导出 **Anki 可导入的 TSV**（正面英文 / 背面中文+例句 / 标签）。
- **必须**：导出**完整 CSV**（含类型、英文、中文、语境、视频 id、时间点、日期）。
- **应当**：收藏夹按时间分组（今天 / 昨天 / 更早）。
- **应当**：`GET /api/favorites?since=<ms>` 返回增量（含删除墓碑），供未来多设备同步使用。
- **必须**（2026-11-16）：收藏写入时带出处 `meta.source_kind`（`video` / `local_show` / `article` / `sentence_pack`）、`source_ref`（videoId / showId / articleId / `L<level>`）、`source_title`；后端按“未知字段原样保留”落盘，GET 顶层返回。
- **应当**：没有 `source_*` 的旧收藏按 `videoId` 启发式推断（11 位 → 视频；`sentence-pack-L*` → 句子精背；其他长 id → 文章），标题未知时显示「来源未知」且不可点。
- **必须**：收藏夹里的生词默认收起为**一行**（单词 + IPA + 释义）；展开后显示出处（带确认框的跳转）、原句（英文 + 译文）与回看/删除/分享。句子收藏保持原卡片样式。

## API 契约（M1 ④）

| 端点 | 请求 | 成功 | 失败 |
|---|---|---|---|
| `GET /api/favorites` | — | `200` 数组，最新在前（旧前端契约不变） | `500` 文件损坏 |
| `GET /api/favorites?since=<ms>` | 毫秒时间戳 | `200 {"favorites":[],"deleted":[],"since","serverTime"}` | `422` 参数非整数 |
| `POST /api/favorites` | `{id?, type/kind, text, translation, videoId, time, meta, addedAt?}`；也接受旧的 `en_text/zh_text/start/added_at` | `201 {"status":"ok","created":true,"favorite":{…}}`；重复提交 `200` + `created:false` | `400` 缺 `text` / 非法 `type` / `meta` 非对象 |
| `DELETE /api/favorites/{id}` | — | `200 {"status":"ok","deleted":true,"id"}` | `404` 收藏不存在 |
| `PUT /api/favorites`（兼容） | `{favorites:[…]}` | `200 {"status":"ok","count":N}` | `400` `favorites` 非数组 |

- `favorite` 存储形状保持旧前端字段：`id/type/videoId/start/en_text/zh_text/added_at/highlights/context_en/context_zh`；未知字段原样保留。
- 删除写旁路墓碑 `favorites_tombstones.json`（`{id: deleted_at_ms}`，保留 30 天），不改变主文件数组格式；旧代码回滚后仍能读 `favorites.json`。
- 旧 PUT 是**整份快照**语义：不在快照里的已有 id 记墓碑；非收藏的任意 JSON 记录原样保留（旧测试/旧客户端兼容）。
- 前端使用 `lib/favorites.ts` 的 `fetchFavorites/addFavorite/removeFavorite`；`App.tsx` 先乐观更新本地状态，失败回滚并 toast。`replaceAllFavorites` 只保留为兼容路径，App 不再调用。

## 验收标准
- [x] 看视频时点句子旁星标，该句进入收藏夹，带时间点。
- [x] 查词卡里点星标，该词进入收藏夹（生词类型，带来源句）。
- [x] 句子精背的星标同样走按条 API。
- [x] 收藏夹点"导出 Anki"，下载的 TSV 能被 Anki 正常导入成卡片。
- [x] 点"导出 CSV"，下载的表格含完整上下文列。
- [x] 两个并发 POST 都落盘；删除一条只影响这一条；旧无 id 数据 GET 可读、可删。
- [x] `backend/tests/test_favorites_api.py` 全离线覆盖新增/删除/幂等/400/404/排序/旧数据/墓碑/并发。
- [x] 生词收藏默认一行收起（单词/IPA/释义），展开显示出处与原句；出处点击先弹自定义确认框。
- [x] 出处跳转：视频/本地剧集复用回看、文章打开阅读器对应文章（`ReaderScreen.initialArticleId`）、句子精背打开对应册；旧收藏无标题时禁用。
- [x] 375px 无横向溢出；zh-CN / vi-VN 文案与 placeholder 对齐（`npm run check:i18n`）。

## 边界与非目标
- 不内置复习/间隔重复（导出到 Anki 承担复习；应用内复习属未来路线）。
- 导出是一次性文件下载，不做云同步。
- M1 仍用每用户 JSON 文件（不建 `favorites` 表、不改 Alembic）；按条 API + 墓碑已为 M2 的 `favorites` 表迁移预留语义。
