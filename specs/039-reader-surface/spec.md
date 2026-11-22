# 039 — 阅读器统一渲染层（ReadingSurface）

> 状态：**阶段 1 已实现**（2026-11-22，ee67b8a）；**阶段 2 已实现**（2026-11-22，公版书 + 导入书）｜ 需求来源：负责人「阅读器并没有通用，给不通用的理由」+ 决定分阶段收敛
> 一句话：把「一段英文怎么渲染、怎么查词、怎么标亮、怎么读出来」收敛成**一份共享组件**，
> 四个阅读器退化为只负责取数据与各自专有功能的“壳”。

## 1. 问题（已核实）

同一段英文在四个阅读器里各有一份渲染与行为实现：

| 阅读器 | 内容来源 | 当前差异 |
|---|---|---|
| `ReaderScreen` | 导入文章（`/api/article`） | 有分析/双栏/进度，但历史实现独立 |
| `LibraryArticleReader` | 免费库静态文章（specs/024） | 无账号数据、分析靠 payload |
| `BookReaderScreen` | 公版书分章（`/api/books`） | 目录/系列/章节
| `ImportedBookReaderScreen` | EPUB / 导入书 | 上传/封面/按需分析 |

差异不在“取数据”，而在“渲染一段英文”：标亮、ruby 释义、语言点、点词、听读高亮、双栏/单栏、
开关位置、空/错误态各自实现，导致「A 有、B 没有」与样式漂移。

## 2. 目标（阶段 1）

抽共享 `components/reading/ReadingSurface.tsx` + `lib/useReadingAnalysis.ts`：

- **输入**：`paragraphs`（每段 `{id/index, en, zh?, glosses?, languagePoints?}`）、
  `isHighlighted`、`showLanguagePoints`、`audio`（共享 hook 状态）、`layout`（单栏/双栏）、`onWordClick`。
- **负责**：段落循环、`MarkedWords`（含语言点常显 ruby）、难度标亮、点词命中、当前句高亮、
  双栏布局、空/错误态占位；**不含**数据请求与页面 chrome。
- `useReadingAnalysis`：给定 `contentRef/level/targetLang/isGuest`，按现有契约取分析
  （payload 优先 → 端点缓存/按需），返回 `languagePointsByBlock`/`wordGlossesByBlock`/状态；
  游客只读缓存、生成需登录的语义不变。
- 阶段 1 只接 `ReaderScreen` + `LibraryArticleReader`；两个壳保留导入/翻译/进度/免费库无账号等专有能力，
  段落渲染与阅读交互全部走共享层。
- 阶段 2（2026-11-22 已实现）：`BookReaderScreen` + `ImportedBookReaderScreen`（目录/章节/上传壳）
  同样退化为壳；段落渲染、分析、听读、双栏全部走同一 `ReadingSurface`。

### 2.1 阶段 1 实现路径（2026-11-22，@381440f 基线）

| 文件 | 改动 |
|---|---|
| `frontend/src/components/reading/ReadingSurface.tsx` | 新建共享段落渲染：`MarkedWords`（难度琥珀底 / 语言点 ruby / 点词 / 语境 gloss）+ `AudioSentenceSpan` 当前句 brand 高亮 + `BilingualRow` 单/双栏 + 段落 testid 别名 |
| `frontend/src/lib/useReadingAnalysis.ts` | 新建分析加载 hook：payload 分析优先（免请求）→ 默认 `fetchTeachingAnalysis`（缓存命中免费）→ 调用方 `load` 覆盖（文章/书籍端点把分析合并在 payload 里）；403 → `status: 'login'`，不报错 |
| `frontend/src/components/ReaderScreen.tsx` | 删除段落级 JSX / 分析 refetch effect；壳保留导入/翻译/进度/列表/段落菜单；分析按 level 走 hook |
| `frontend/src/components/LibraryArticleReader.tsx` | 删除段落级 JSX；壳保留无账号免费路径/返回/译文开关/听读条；App 传入的 payload 分析进入 hook |
| 保留 testid | `reader-*`、`library-*` 全部保留（`<prefix>-paragraph|row|en|translation-*`，库翻译列沿用 `library-article-translation-*`） |

### 2.2 阶段 2 实现路径（2026-11-22）

| 文件 | 改动 |
|---|---|
| `frontend/src/components/reading/ReadingSurface.tsx` | 新增四个 shell 注入点：`paragraphIndexAttr`（段落节点上保留 `data-book-paragraph` / `data-imported-paragraph`，进度保存与滚动恢复的既有查询不变）、`listClassName`（默认 `space-y-1.5`，书籍传 `''` 沿用自身行距）、`extraParagraphClass`（书籍紧凑行配方，经 tailwind-merge 覆盖默认 padding/圆角）、`translationMissingLabel`（"有译文但此段缺译" 的缺译文徽章收进共享层） |
| `frontend/src/components/BookReaderScreen.tsx` | 删除段落 map / `BilingualRow` / `ReadingAudioText` / 缺译文徽章 JSX；章节 payload 的 `idioms`/`culture`/`glosses` 交给 `useReadingAnalysis` 作 payload 分析（`enabled:false`，零请求）；目录/章节目录/系列背景/章节翻译/按需分析/听读条全部留在壳 |
| `frontend/src/components/ImportedBookReaderScreen.tsx` | 同上；保留上传后阅读/封面/按需 `level` 拉取（「生成本章词条」）/登录提示/删除确认/听读条；分析同样以 payload 进 hook |
| `frontend/src/components/ReadingAudioText.tsx` | 删除段落级 `ReadingAudioText`（第二份段落渲染），只保留 `AudioSentenceSpan`（`ReadingSurface` 与句子精背共用） |
| 保留 testid | 公版书 `book-paragraph-*` / `book-row-*` / `book-en-*` / `book-translation-*` / `book-translation-missing-*`、导入书 `imported-book-*` 全部由共享层按 `<prefix>-paragraph|row|en|translation-*` 生成；壳工具条（`book-highlight-toggle`、`book-language-points-toggle`、`book-audio-trigger` 等）不变 |
| 验收证据 | `scripts/reading-surface-p2-test.mjs`：同一段英文在三个阅读器的段落/DOM 快照逐字对比 + 语言点开关 + 点词 + 听读当前句高亮 + 1440/375 无溢出；截图 `/tmp/reading-surface-p2-*.png` |

## 3. 要求

- **必须**：阶段 2 后，四个阅读器都不再各自包含段落级 JSX；共享层是唯一渲染入口（仓库里不再有第二份段落渲染器）。
- **必须**：功能不减——难度标亮、ruby 释义、语言点常显 ruby、点词、听读播放条与当前句高亮、
  双栏切换、隐藏中文（如有）、错误重试，在两个阅读器行为一致。
- **必须**：分析加载语义一致（payload 优先、端点补取、游客只读缓存、403 显示登录提示）。
- **必须**：不改变现有 URL/导航/导入/翻译/进度行为；保留现有 testid（`library-paragraph-*`、
  `reader-*`、`book-paragraph-*`、`imported-book-*` 等）至少一处别名，避免验收脚本断裂。
- **必须**：375 单栏、1440 双栏不溢出；行高稳定（hover/标注不引起重排）。
- **必须**：书籍阅读器的目录/章节目录/系列背景/章节翻译/按需分析、导入书的上传后阅读/封面/删除确认/登录提示等壳能力不减；听读播放条仍由壳挂载。
- 验收：同一段英文在公版书/导入书/文章三个阅读器的目标 DOM（段落节点、`data-word-hit`、`data-language-point`、
  `ruby`、`data-audio-sentence`）结构与行为一致；`tsc/build/i18n/gate-receipt` 绿；
  Playwright 对比测试 + 截图；无重复段落渲染代码（grep 可证）。

## 4. 非目标

- 不改四个阅读器的数据接口与 URL；不重做视觉；不合并公版书与导入书的取数/目录壳（只合段落渲染层）；不引入新依赖。
