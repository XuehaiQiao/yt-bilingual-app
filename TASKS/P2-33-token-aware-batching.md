# P2-33 P1：token-aware 分批 + 首批小批

- status: claimed
- owner: {implementer: batching-impl, reviewer: lead, integrator: lead}
- base_sha: bf3e7e4

## goal
按调优报告 P1，落地分批策略：
- 视频：首批 **10 blocks**，稳定批 **40 blocks**，源 token 预算 2,000
- 文章：首批 **5 段**，稳定批 **20 段**，源 token 预算 2,000
- 条数不是唯一上限：`min(条数, token 预算)`；单条超预算仍单独成批
- 保持 SSE/经典路径的批序、落盘、progress、断点、配额语义
- 不改变 batch 级 1 配额（配额改革另卡）

## write_scope
- `backend/translation_batching.py`（新建）
- `backend/translate.py`（SSE 分批）
- `backend/routes_videos.py`（经典视频分批）
- `backend/reading.py`（文章分批）
- `backend/tests/test_translation_batching.py`（新建）
- `backend/tests/test_streaming_pipeline.py`（进度/批数断言如影响）
- `backend/tests/test_reading.py`
- `backend/tests/test_jobs.py`
- `backend/tests/test_video_pipeline_timing.py`（批数断言如影响）
- `specs/001-streaming-pipeline/spec.md`
- `specs/019-reading/spec.md`

## acceptance
1. 20 段文章 → 批次 5+15（或 5+…），40 块视频 → 10+30；token 超预算时提前切批。
2. 首批更小；稳定批不超过 40/20；单条超预算不丢弃。
3. SSE 事件顺序/progress/cursor/落盘/断点/取消/402 不变；经典路径顺序不变。
4. 现有测试更新；新增批次边界/token/空批测试；全量 pytest；preflight。
