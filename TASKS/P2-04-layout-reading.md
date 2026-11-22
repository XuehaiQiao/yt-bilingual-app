# P2-04 阅读类页面桌面布局（正文 + 侧栏）

- status: claimed
- owner: {implementer: layout-read-impl, reviewer: lead, integrator: lead}
- base_sha: 088382d

## goal
把阅读类页面迁到 `ReadingLayout`：正文列 68ch + 右侧 320px 侧栏（语言点/词汇/目录/进度），总宽 1200；≥xl 双栏，375 单栏；正文不拉长。

## 覆盖页面
- 导入文章 `ReaderScreen`
- 免费库文章 `LibraryArticleReader`
- 公版书 `BookReaderScreen`
- 导入书 `ImportedBookReaderScreen`
- 句子精背 `SentenceView`
- 课程 `CourseScreen`

## write_scope
- `frontend/src/components/ReaderScreen.tsx`
- `frontend/src/components/LibraryArticleReader.tsx`
- `frontend/src/components/BookReaderScreen.tsx`
- `frontend/src/components/ImportedBookReaderScreen.tsx`
- `frontend/src/components/SentenceView.tsx`
- `frontend/src/components/CourseScreen.tsx`
- `scripts/p2-04-layout-acceptance.mjs`（新建）
- `docs/设计-桌面布局规范.md`（回填状态）

## read_only
- `docs/设计-桌面布局规范.md`、`docs/reports/desktop-layout-audit-2026-11-23.md`、`frontend/src/components/layout/*`、`frontend/src/components/reading/*`

## acceptance
1. 六个页面使用 `ReadingLayout`：正文 `max-w-[68ch]`，右栏 320（xl+），总容器 1200；1440 内容 ≥1100；1920 居中 1200；375 单栏无溢出。
2. 右栏内容：文章/书=语言点/词汇/目录（现有分析面板移入或复用）；句子=进度/提示；课程=大纲；不重复渲染现有面板。
3. 听读播放条/当前句高亮/点词/语言点开关/testid 全部保留；`reading-audio-acceptance` 与现有验收零回归。
4. 页头/卡 padding/间距与周报/P2-03 一致；无新颜色；G1=0。
5. `tsc/build/i18n/gate`；新 Playwright 断言 6 页宽度/双栏/375；截图 `/tmp/p2-04-*.png`。
6. 不改后端/数据/App.tsx；共享文件交 lead。

## deps
- P2-02（已完成）

## rollback
revert；纯前端。
