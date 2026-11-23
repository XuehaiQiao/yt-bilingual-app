# P1-15 阅读侧栏改为本页标亮词 + 一键收藏

- status: claimed
- owner: {implementer: rail-impl, reviewer: lead, integrator: lead}
- base_sha: 84047f6

## write_scope
- `frontend/src/lib/highlightedWords.ts`（新建：从文本+highlight 收集去重标亮词）
- `frontend/src/components/reading/ReadingHighlightRail.tsx`（新建）
- `frontend/src/components/ReaderScreen.tsx`
- `frontend/src/components/LibraryArticleReader.tsx`
- `frontend/src/components/BookReaderScreen.tsx`
- `frontend/src/components/ImportedBookReaderScreen.tsx`
- `frontend/src/App.tsx`（shared，lead 授权：传 onAddFavorite/onRemoveFavorite）
- `frontend/src/i18n/zh-CN.json`、`vi-VN.json`
- `scripts/reading-highlight-rail-acceptance.mjs`（新建）
- `specs/042-reading-highlight-rail/spec.md`、`specs/README.md`

## acceptance
1. 四阅读器右栏不再展示我的收藏/单词本生词；展示「本页标亮」去重词（词/等级/释义/星标）。
2. 一键收藏/取消走 App 回调，顶栏计数即时变化；失败回滚/行内错误。
3. 无标亮/关闭标亮时空态；不报错、不显示无关词。
4. 现有语言点/目录/进度面板保留；句子/课程侧栏不动。
5. `tsc/build/i18n/gate`；新 Playwright；reading-audio/现有阅读脚本零回归；1440/375 截图。

## deps
- P2-04（已完成）
