# 规格：单词本与导出

**状态：** 已实现（M1 ④ 按条 API：2026-11-15；生词折叠与出处：2026-11-16；独立「单词本」页面：2026-11-17；短语 tab：2026-11-17）｜ **对应代码：** `backend/routes_user.py`（`/api/favorites`）、`backend/routes_vocabulary.py`（词表目录/短语/分页/等级）、`backend/storage.py`（路径 + 墓碑文件）、`backend/vocabulary.py`、`frontend/src/lib/favorites.ts`、`frontend/src/lib/vocabulary.ts`、`frontend/src/lib/favoriteSource.ts`、`frontend/src/components/VocabularyBookScreen.tsx`、`frontend/src/App.tsx`、`frontend/src/lib/exporter.ts`

---

## 目标
打通学习闭环的最后一环——把"看过/查过"沉淀成"可复习"。单词不能只是躺在收藏里：要能按 CEFR 与考试词表浏览、按中文遮挡自测、再一键导出到真正的复习工具。

## 用户故事
- 作为用户，我想**星标**重要的生词，连同它们的来源语境一起存下来。
- 作为用户，我想在独立的「单词本」里看到**我的单词**，并展开查看它的 CEFR 等级、出处与收藏时间；不在词表里的词诚实显示 `C1+`。
- 作为用户，我想按 **CEFR A1–C2 + GRE + CET4 + CET6** 浏览词表，搜索单词并看到音标、中文释义与等级。
- 作为用户，我想在「短语」tab 里按等级与类型浏览人工精选的短语动词、习语和固定搭配，展开看例句、类型说明与用法笔记。
- 作为用户，我想**隐藏中文**背词；点某一行临时显示释义，再点收起；这个偏好下次打开仍然记得。
- 作为用户，我想把收藏的单词**导出到 Anki** 做间隔重复，或导成 CSV 自己整理。
- 作为同时开两个标签页/两台设备的用户，我在一边加/删收藏，另一边不会把整份收藏覆盖掉。

## 功能需求
### 收藏数据（不变）
- **必须**：可收藏两类——整句、单词（生词）；都带来源句、视频/文章、时间点。
- **必须**：收藏持久化到后端（每用户 `favorites.json`），后端不可用时退回 localStorage。
- **必须**：按条写入（`POST /api/favorites`、`DELETE /api/favorites/{id}`），不再由前端发整文件 PUT；旧 `PUT /api/favorites` 只作兼容保留。
- **必须**：同一条收藏有稳定 `id`；重复 POST 幂等（按 id 或内容指纹去重）；删除不存在的收藏返回 `404`。
- **必须**：旧 `favorites.json` 里没有 `id` 的记录读取时补稳定 `id`，不丢数据、不在 GET 时改写文件。
- **必须**：并发安全——同一用户的读-改-写用文件锁串行化，并用 tmp + `os.replace` 原子落盘。
- **必须**（2026-11-16 起）：收藏写入时带出处 `meta.source_kind`（`video` / `local_show` / `article` / `library_article` / `sentence_pack` / `book` / `imported_book`）、`source_ref`、`source_title`；后端按“未知字段原样保留”落盘，GET 顶层返回。
- **应当**：没有 `source_*` 的旧收藏按 `videoId` 启发式推断（11 位 → 视频；`sentence-pack-L*` → 句子精背；其他长 id → 文章），标题未知时显示「来源未知」且不可点。

### 单词本页面（2026-11-17）
- **必须**：独立整页路由 `#/profile/vocabulary`（旧 `#/profile/favorites` 作为兼容别名，自动改写为新路由）；顶栏标题「单词本」+ 返回。
- **必须**：侧边栏快捷入口「收藏」改「单词本」；顶栏/学习页头部旧 Favorites 按钮与数字改「单词本」入口；个人页「我的收藏」行改「单词本」。这些入口都打开页面，**不再弹 FavoritesModal**（组件已删除）。
- **必须**：Tabs 顺序 `我的单词 / 短语 / A1 / A2 / B1 / B2 / C1 / C2 / GRE / CET4 / CET6`；词表 tab 数量来自 `GET /api/vocabulary/lists`；收藏数量在顶栏/侧边栏显示（只数生词）。
- **必须**：**我的单词**只列 `favorites` 中 `type=vocabulary`（句子/分享卡不列入），默认一行（单词 + IPA + 中文释义）；展开显示 CEFR 徽章、来源（可跳回视频/本地剧集/文章/免费文章/句子精背/公版书/导入书）、收藏时间、取消收藏。等级走 `GET /api/vocabulary/level`（每批 ≤100），不在词表或非法 token 显示 `C1+`。
- **必须**：**词表**支持服务端搜索（`q`，300ms 防抖）、每页 50、分页；每行 word / phonetic / translation / CEFR 徽章。
- **必须**：**短语**（2026-11-17）：tab 位于「我的单词」之后、A1 之前，数量取自 `/lists` 的 `phrases.count`；行内显示 headword、类型徽章（短语动词/习语/固定搭配）、中文释义、CEFR 徽章；默认单行/两行，展开懒加载 `/phrases/{id}` 显示例句、类型说明、来源（人工精选）、license 与用法笔记；点击行展开/收起。
- **必须**：短语 tab 的服务端搜索（`q`，300ms 防抖）、等级筛选（全部/A2/B1/B2/C1）、类型筛选（全部/短语动词/习语/固定搭配）、每页 50 与页码/上一页/下一页；加载/空/错误重试。短语的列表/搜索/筛选/分页状态与单词表完全独立；切 tab 重置分页。
- **必须**：短语 CEFR 是教学近似值（`approximate:true`）：徽章 title 与列表说明都标注「近似、非官方」，筛选不提供 C2（数据无 C2）。
- **必须**：「隐藏中文」全局开关：隐藏后只显示单词（+ 音标与等级），点击行临时显示中文，再点收起；偏好写 localStorage（`yt_bilingual_vocab_hide_zh`）并跨刷新记忆。短语同样复用该开关：隐藏时行内只留 headword（+ 类型与等级），点击行临时显示释义，展开详情时中文类型说明与用法笔记也保持隐藏。
- **必须**：C2 `available:false` 时 tab 禁用并显示「C2 词表暂未建模」；**不请求** C2 词表、不拿空表冒充数据、不用 GRE 冒充 C2。
- **必须**：加载/空态/错误重试；导出 Anki TSV / CSV 只导出「我的单词」（生词），不再混入句子。
- **必须**：中越 i18n 文案与 placeholder 对齐；桌面表格化、375px 单列不横向溢出。

### v1.1 交互升级（本轮最小版）

- **必须**：**我已掌握**——词条浮层与「我的单词」行都有「我已掌握」；标记后从「我的单词」移入独立的「**已掌握**」词表（见下一条），可撤销；数据与复习共用 `word_states.mastered`（见 specs/013），不在收藏里另存一份。游客用本地 `localStorage` 忽略表实现同样效果，但**不叫「已掌握」**（叫「我会了」），不上传服务端。
- **必须（2026-11-22 修订）**：**「已掌握」是独立词表 tab**，与「我的单词」并列，**不是**同一页内的分组/分段切换。tab 顺序：`我的单词 / 已掌握 / 短语 / CEFR 词表 / GRE / CET4 / CET6`；游客的 tab 名为「我会了」。
- **必须**：已掌握 tab **复用内置词表（GRE / CET-4）的表格格式**——列「单词（含音标）/ 释义 / CEFR 徽章」，桌面三列、375px 单列；支持「隐藏中文」（点行临时显示）；客户端分页每页 50（服务端已掌握列表上限 200）。释义/音标取收藏里的词条数据（`splitIpaAndMeaning`），无收藏记录的词显示 `—`；CEFR 批量走 `GET /api/vocabulary/level`。
- **应当**：已掌握行提供「取消已掌握 / 撤销忽略」动作，否则无法从该页移回；动作乐观更新、失败回滚并 toast。
- **必须**：「我的单词」不再混入已掌握词（两个列表互斥）；已掌握 tab 的加载/空/错误三态齐全（错误可重试，失败不当空态）。
- **必须**：**来源**——每行显示**最后一次**收藏/加入时的来源链接（`meta.source_kind` + `source_ref` + `source_title`）；同词同来源再次收藏时更新来源与时间，不新增重复行；`context_en/context_zh` 旧数据保留但**不再展示**。
- **必须**：**排序**——「我的单词」支持按 加入时间 / 见过次数 / 难度 排序（默认加入时间倒序）；难度批量走 `GET /api/vocabulary/level`，见过次数走新增的 `GET /api/vocabulary/seen`。
- **必须**：**筛选**——类型（词/短语）、来源（按 `source_kind`）、未掌握；与排序可叠加；空结果给空态而不是空白。
- **必须**：**加词入口**——词条浮层主入口 + 收藏行次入口，调用 `POST /api/review/words` 并带来源；交互与验收见 specs/013。
- **必须**：三态齐全与错误可重试；i18n 中越对齐；375px 单列不溢出。

## API 契约
### 收藏（M1 ④）

| 端点 | 请求 | 成功 | 失败 |
|---|---|---|---|
| `GET /api/favorites` | — | `200` 数组，最新在前（旧前端契约不变） | `500` 文件损坏 |
| `GET /api/favorites?since=<ms>` | 毫秒时间戳 | `200 {"favorites":[],"deleted":[],"since","serverTime"}` | `422` 参数非整数 |
| `POST /api/favorites` | `{id?, type/kind, text, translation, videoId, time, meta, addedAt?}`；也接受旧的 `en_text/zh_text/start/added_at` | `201 {"status":"ok","created":true,"favorite":{…}}`；重复提交 `200` + `created:false` | `400` 缺 `text` / 非法 `type` / `meta` 非对象 |
| `DELETE /api/favorites/{id}` | — | `200 {"status":"ok","deleted":true,"id"}` | `404` 收藏不存在 |
| `PUT /api/favorites`（兼容） | `{favorites:[…]}` | `200 {"status":"ok","count":N}` | `400` `favorites` 非数组 |

- `favorite` 存储形状保持旧前端字段：`id/type/videoId/start/en_text/zh_text/added_at/highlights/context_en/context_zh`；未知字段原样保留。
- 删除写旁路墓碑 `favorites_tombstones.json`（`{id: deleted_at_ms}`，保留 30 天）。
- 前端使用 `lib/favorites.ts` 的 `fetchFavorites/addFavorite/removeFavorite`；`App.tsx` 先乐观更新本地状态，失败回滚并 toast。`replaceAllFavorites` 只保留为兼容路径，App 不再调用。

### 词表（公开只读，2026-11-17）

| 端点 | 请求 | 成功 | 失败 |
|---|---|---|---|
| `GET /api/vocabulary/lists` | — | `200` 数组：`id/label/count/source/license/notice/approximate/available/version/note`；C2 `available:false` | `503` 数据缺失 |
| `GET /api/vocabulary/lists/{id}?page=1&pageSize=50&q=` | `page≥1`、`pageSize 1–200`、`q` 服务端包含搜索 | `200 {items:[{word,phonetic,translation,cefrLevel}],total,page,pageSize,hasMore}` | `404` 词表不存在/C2；`422` 参数非法；`503` 数据缺失 |
| `GET /api/vocabulary/phrases?page=1&pageSize=50&q=&level=&type=` | `page≥1`、`pageSize 1–200`、`q` 匹配 headword/中文、`level` A2/B1/B2/C1/C1+、`type` phrasal_verb/idiom/collocation | `200 {items:[{id,headword,type,cefr,translation,example,source}],total,page,pageSize,hasMore}` | `400` level/type 非法；`422` 参数非法；`503` 数据缺失 |
| `GET /api/vocabulary/phrases/{id}` | — | `200` 短语详情（列表字段 + `license/notes`） | `404` 短语不存在；`503` 数据缺失 |
| `GET /api/vocabulary/level?words=a,b,c` | ≤100 个词/批 | `200 {word: 'A1'..'C1' \| 'C1+' \| null}`（保留输入大小写） | `422` 空/超量 |
| `GET /api/vocabulary/seen?words=a,b,c` | 需登录；≤100 个词/批 | `200 {word: count}`：`learning_events(type='dict_lookup')` 实时聚合，按小写词形归并、返回 0 而不是缺省 | `403` 游客；`422` 空/超量 |

- C2 未建模：`available:false`，请求 `/lists/cefr-c2` 返回 `404`；前端不请求。
- 词表数据来自仓库只读 JSON（`content/wordlist/`、`content/wordlists/`），无数据库迁移、无 LLM 调用。

## 验收标准
- [x] 看视频时点句子旁星标，该句进入收藏；查词卡星标把词按生词类型存下（带来源句）。
- [x] 句子精背的星标同样走按条 API。
- [x] 旧 `#/profile/favorites` 自动改写为 `#/profile/vocabulary`，任何入口都不再挂载 `FavoritesModal`。
- [x] 顶栏 / 侧边栏 / 个人页 / 学习页头部都显示「单词本」与生词数量，点击进入独立页面。
- [x] 我的单词默认一行；展开显示 CEFR（批量 `/level`；不在词表 `C1+`）、来源、收藏时间；取消收藏乐观删除、失败回滚 + toast。
- [x] 来源可跳回：视频/本地剧集、文章、免费文章、句子精背、公版书、导入书；无来源时显示「来源未知」且不可点。
- [x] 词表 tabs 与数量来自 `/lists`；C2 tab 禁用并显示「C2 词表暂未建模」，不发起 C2 请求、不显示空表。
- [x] 词表搜索走服务端 `q`（防抖）、每页 50、分页到最后一页；加载/空/错误重试态可读。
- [x] 隐藏中文后只显示单词行，点击行临时显示、再点收起；`localStorage` 记住偏好，刷新后仍生效。
- [x] 短语 tab 位于「我的单词」与 A1 之间，显示 570；列表/搜索/筛选/分页与单词表互不干扰，切 tab 后回到第 1 页。
- [x] 短语行显示类型与近似 CEFR 徽章；展开显示例句、类型说明、来源与用法笔记；加载/空/错误重试可用。
- [x] 短语复用隐藏中文开关：隐藏时只留 headword，点行临时显示释义，展开详情的中文说明与笔记同样隐藏。
- [x] 短语在 375px 与 1440px 无横向溢出，zh-CN / vi-VN 文案对齐；C2 tab 仍禁用、GRE/CET4/CET6 不受影响。
- [x] 导出 Anki/CSV 仍可用，导出的范围是「我的单词」。
- [x] 375px 单列与 1440px 桌面无横向溢出；zh-CN / vi-VN 文案与 placeholder 对齐（`npm run check:i18n`）。
- [ ] 「我已掌握」：标记后移出我的单词、进独立「已掌握」tab；撤销恢复；游客为「我会了」本地 tab，不上传。
- [ ] 已掌握 tab 复用词表格式（单词+音标 / 释义 / CEFR），隐藏中文与分页可用；无收藏数据的词显示 `—`；可逐行取消。
- [ ] 来源显示最后一次来源链接；同词再次收藏更新来源与时间，不产生重复行；旧 `context_*` 不再展示但数据保留。
- [ ] 排序（时间/次数/难度）与筛选（类型/来源/未掌握）可叠加；见过次数对游客显示「—」。
- [ ] 加词入口两处可用：带来源、幂等、成功/失败反馈；加入后复习队列出现该词。

## 边界与非目标
- C2 词表尚未建模：不拿 GRE 或频表冒充 C2，也不展示空表当数据。
- 单词本只列生词；句子收藏仍保存在后端（按条 API），当前没有独立列表 UI，也不混入单词本。
- 不内置复习/间隔重复（导出到 Anki 承担复习；应用内复习属 specs/013）。
- 导出是一次性文件下载，不做云同步。
- 仍用每用户 JSON 文件存收藏（不建 `favorites` 表、不改 Alembic）。
- 本轮最小版**不做**：收藏释义指针化（只存 word、渲染查词典缓存）、`word_seen` 物化表、内置词表全量补释义、`favorites.json` → `word_states` 迁移——留作完整版（计划 §3.4），需要单独评审。
