# P2-32 分析移出首屏关键路径

- status: claimed
- owner: {implementer: analysis-p0-impl, reviewer: lead, integrator: lead}
- base_sha: 9b46408

## goal
P0：正文/字幕先出，教学分析异步补，不阻塞首屏。

1) 视频缓存命中路径：`_cached_stream_gen` 先 `yield meta`（不带分析也可），再跑分析；分析完成用 `batch` 事件回传更新 blocks。无 pending 也要能收到分析 batch。
2) 文章：`ReaderScreen.openArticle` 初始 GET **不传 level**，先渲染正文；`useReadingAnalysis` 在后台用 `loadArticleAnalysis` 拉当前 level 分析，完成后显示语言点。翻译后的 `refreshTranslations` 可继续带 level（不在首屏）。
3) 保持 `analysisUnavailableReason` 非阻断提示；失败仍可读。
4) 不改变分析缓存/等级/内容契约；不新增 AI 调用。

## write_scope
- `backend/routes_videos.py`
- `backend/tests/test_streaming_pipeline.py`（事件序更新）
- `backend/tests/test_video_pipeline_timing.py`（如事件序）
- `frontend/src/components/ReaderScreen.tsx`
- `scripts/reader-analysis-acceptance.mjs` 或相关阅读验收（如存在）
- `backend/tests/test_teaching_analysis.py`
- `scripts/p0-04-analysis-acceptance.mjs`
- `specs/001-streaming-pipeline/spec.md`
- `specs/019-reading/spec.md`

## acceptance
1. 视频缓存命中：SSE 顺序 `meta` 先到，分析完成后 `batch` 更新；无 pending 也有分析 batch；首屏不等分析。
2. 文章：初始 GET 无 level、正文先渲染；分析 GET 后台；语言点加载中/失败不阻塞正文。
3. 事件顺序/progress/cursor/断点/取消/402 语义不变；分析失败只影响增强。
4. 现有 video/article 测试更新；全量 pytest；前端 tsc/build/i18n；preflight。
