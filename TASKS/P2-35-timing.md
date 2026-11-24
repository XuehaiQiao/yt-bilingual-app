# P2-35 P1：翻译计时落盘 + P50/P95

- status: pending（等 P2-33/34）
- owner: {implementer: timing-impl, reviewer: lead, integrator: lead}
- base_sha: bf3e7e4

## 目标
把现有 stdout 计时落成可查询数据：
- 新表或 JSONL：feature/event/content_ref/job_id/batch_count/duration_ms/queue_wait_ms/total_ms/concurrency/ok/created_at
- 覆盖视频 SSE/经典、文章、书、分析；不含隐私正文
- 管理台「用量」显示 P50/P95/失败率（按 feature/日期）
- 保留 stdout 日志；不改变业务行为

## write_scope
- `backend/observability.py` 或新 `pipeline_timing.py`
- `backend/routes_videos.py`、`translate.py`、`reading.py`、`book_translation.py`（只加记录）
- migration 0032（若用表）
- `backend/routes_admin.py`、`frontend/src/components/AdminConsoleScreen.tsx` 或 AdminQuotasPanel
- tests/specs

## acceptance
- 每次翻译/分析有结构化记录；content_ref/jobId 可归因
- 管理台可按 feature 看 P50/P95/失败率；空/旧库降级
- 不影响翻译/SSE 事件顺序；全量 pytest；preflight
