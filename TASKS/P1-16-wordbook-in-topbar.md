# P1-16 阅读/看视频页单词本统一进 top bar

- status: pending（等 P1-15 释放阅读器文件）
- owner: {implementer: TBD, reviewer: lead, integrator: lead}
- base_sha: 9521041

## goal
阅读类 6 页与看视频页不再在页内放「单词本」入口；统一使用 AppShell 顶栏的单词本按钮（与浏览界面一致），计数/跳转同一来源。

## write_scope
- `frontend/src/components/AppShell.tsx`
- `frontend/src/components/App.tsx`（shared，lead 授权）
- `frontend/src/components/LearningHeader.tsx`
- `frontend/src/components/ReaderScreen.tsx`
- `frontend/src/components/LibraryArticleReader.tsx`
- `frontend/src/components/BookReaderScreen.tsx`
- `frontend/src/components/ImportedBookReaderScreen.tsx`
- `frontend/src/components/ReadingVocabButton.tsx`（如无引用则删除）
- `frontend/src/components/LocalVideoLearning.tsx`
- `scripts/topbar-wordbook-acceptance.mjs`（新建）
- `specs/005-favorites-export/spec.md`（入口说明）

## acceptance
1. 任务页（阅读/视频）顶栏显示单词本按钮与计数；与浏览界面样式/位置一致。
2. 页内不再有单词本按钮（LearningHeader/ReadingVocabButton/阅读器 header actions）；点击顶栏进入 `#/app/<tab>/vocabulary`。
3. 计数与 App favorites 单一来源；收藏/掌握后即时变化。
4. 本地视频（LocalVideoLearning）也使用顶栏入口，不再依赖 LearningHeader 的 wordbook。
5. 移动端顶栏不溢出；375/1440。
6. `tsc/build/i18n/gate`；现有阅读/听读/导航脚本零回归；截图。

## deps
- P1-15（同文件）
