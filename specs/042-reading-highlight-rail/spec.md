# 042 — 阅读侧栏：本页标亮词 + 一键收藏

> 状态：**已实现（2026-11-23，P1-15）** ｜ 需求：负责人「阅读类不应展示单词本生词，应展示标亮词汇并一键收藏」

## 1. 问题

四个阅读器（导入文章/免费库文章/公版书/导入书）的右侧栏当前展示的是**我的收藏/单词本生词**，与当前页面内容无关；用户想看到的是**本页被难度标亮的词**，并能直接收藏。

## 2. 行为

- 侧栏面板改为「本页标亮」：当前页面文本中所有被难度规则标亮的**去重词**
- 每项：词 / CEFR 徽章 / 中文释义（来自分析 gloss；无则 `—`）/ 星标
- 星标：未收藏 → 一键加入「我的收藏」；已收藏 → 取消；状态与顶栏计数同步（App 回调）
- 空态：未开启标亮/本页无标亮词 → 明确提示，不显示无关生词
- 标亮词点击可复用现有查词卡（若页面已有点词能力）
- 句子精背/课程页没有该生词面板，保持现有进度/大纲侧栏，不强行加

## 3. 数据

- 标亮判定复用 `useReadingHighlights`（classify + 已掌握/忽略过滤），不新增第二套规则
- gloss 复用分析 `wordGlossesByBlock`（有则显示，无则空）
- 收藏走现有 `FavoriteDraft`/App 乐观路径（`source_kind` 对应 article/library_article/book/imported_book）

## 4. 验收

- 侧栏不再出现「我的收藏/单词本」列表；出现「本页标亮」及去重词数
- 词/等级/释义/星标正确；一键收藏/取消，顶栏计数即时变化
- 无标亮时显示空态，不报错
- 四阅读器一致；375 单栏/1440 双栏；现有阅读/听读/词表脚本零回归

## 5. 实现落点（2026-11-23）

| 内容 | 位置 |
|---|---|
| 去重标亮词收集（纯函数：token 清洗、lowercase 去重、次数、level、gloss 合并） | `frontend/src/lib/highlightedWords.ts` |
| 侧栏面板（标题/去重词数/词+等级+释义+星标、行内错误、busy、游客门禁、空态） | `frontend/src/components/reading/ReadingHighlightRail.tsx` |
| 四个阅读器接入（删旧词汇面板；传文本/gloss/highlight/source；保留语言点/目录/进度） | `ReaderScreen.tsx`、`LibraryArticleReader.tsx`、`BookReaderScreen.tsx`、`ImportedBookReaderScreen.tsx` |
| App 收藏回调（`onAddFavorite`/`onRemoveFavorite` 传入四个阅读器；顶栏计数同源） | `frontend/src/App.tsx` |
| 文案（zh-CN / vi-VN） | `frontend/src/i18n/zh-CN.json`、`vi-VN.json` |
| 验收脚本（四页 rail、收藏/取消/失败回滚/游客/空态、1440+375 截图） | `scripts/reading-highlight-rail-acceptance.mjs` |

标亮判定仍只来自 `useReadingHighlights`（classify + 已掌握/忽略过滤），本规格不新增第二套难度规则；
P2-04 布局脚本仍按旧面板 testid 取到 rail（面板内保留 `display: contents` 的兼容锚点），布局检查继续有效。
