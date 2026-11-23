# P1-17 书章节翻译并行 + 计时 + 分析不阻塞首屏（B1）

- status: claimed
- owner: {implementer: book-perf-impl, reviewer: lead, integrator: lead}
- base_sha: a5d0f80

## goal
书本章节首次打开：翻译批次并行（默认 3 路），首屏不等待分析；分析完成后补语言点。加结构化计时日志。

## write_scope
- `backend/book_translation.py`
- `backend/tests/test_book_translation*.py`
- `backend/routes_books.py`（分析计时）
- `frontend/src/components/BookReaderScreen.tsx`（分析中状态，不阻塞正文）
- `docs/reports/pipeline-timing-2026-11-23.md`（新建）

## acceptance
1. 翻译批次并行（默认 3、可配置 1–4），按 batch 顺序合并；成功批次落缓存、部分失败保留成功段、下次只补缺失；每日限额只扣 1 次。
2. 并发写缓存安全（串行/锁）；无重复模型调用；失败不写半成品。
3. 计时日志：`feature=book_translation`、book/chapter、batch_count、per-batch duration_ms、total_ms、concurrency；分析 `feature=book_analysis` total_ms。
4. 首屏：翻译返回即渲染正文；分析进行中显示非阻断状态；分析失败不阻断阅读（P0-04 语义）。
5. 测试：mock `_translate_batch` 带 sleep 证明 wall time 接近 max 而非 sum；顺序/缓存/部分失败/限流；pytest 全量；preflight。

## deps
- 无
