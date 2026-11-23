# P2-13 修复：payload 自带分析高亮时不生成词条释义

- status: claimed
- owner: {implementer: gloss-fix-impl, reviewer: lead, integrator: lead}
- base_sha: 366ae4e

## 根因
`teachingAnalysisFromPayload()` 把 payload 的 block highlights 留在 `transcript[].highlights`，`analysis.highlights` 固定为 `{}`；而 App 的 `wordGlossesByBlock` 只从 `teachingAnalysis.highlights` 构建。结果：
- 视频历史 payload 自带 `analysis.v5` + highlights、但没有 endpoint 请求时，ruby 无 gloss
- 观影模式「滚动词条」没有词条（只有 idioms/culture）
- P2-12 去掉空态后表现为完全空白

## goal
`wordGlossesByBlock` 以 **`displayTranscript` 的 block.highlights** 为来源（endpoint 分析已由 `applyTeachingAnalysisHighlights` 覆盖/保留 payload 回退），不再只依赖 `analysis.highlights`；语言点仍用 analysis idioms/culture。

## write_scope
- `frontend/src/App.tsx`
- `scripts/watch-mode-acceptance.mjs`
- `specs/044-watch-mode/spec.md`（数据来源说明）

## acceptance
1. 只带 payload analysis（无 endpoint 请求）的视频：难度标亮词显示 ruby 释义；滚动词条显示同词释义。
2. endpoint 分析可用时行为不变（高亮以 endpoint 为准，空 block 不被旧 payload 污染）。
3. idioms/culture 仍显示；P2-12 精简样式/历史/字号/全屏零回归。
4. 新增 Playwright 用例：mock payload `analysisVersion + block highlights + idioms`，拦截 `/api/teaching-analysis` 为 404，断言 ruby 与滚动词条有词；再测 endpoint 权威覆盖。
5. `tsc/build/i18n/gate`；watch-mode 验收 2× PASS；截图。

## deps
- P2-12
