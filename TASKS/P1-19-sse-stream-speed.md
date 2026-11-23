# P1-19 SSE 流式视频翻译并行

- status: claimed
- owner: {implementer: sse-perf-impl, reviewer: lead, integrator: lead}
- base_sha: ec34e04

## goal
`/translate` SSE 流式路径（`translate.py::_stream_translate`）翻译批次并行（默认 2、1–3 可调），同时保持：
- `batch` 事件按批次顺序发出（前端按 id 合并逻辑不变）
- 每批完成即落盘（写锁，防并发覆盖）
- 断点续传/未翻译标记自愈不变
- 客户端取消、402/计费错误立即中断所有在途批次
- 进度 `done/total` 与首字时间可观测

## write_scope
- `backend/translate.py`
- `backend/routes_videos.py`（流生成器/取消/计时）
- `backend/tests/test_streaming*.py`（或相关流式测试）
- `docs/reports/pipeline-timing-sse-2026-11-23.md`

## acceptance
1. 默认 2 批并行（config 1–3）；mock 3 批×200ms：串行 600ms → 并行 ~220ms。
2. `batch` 事件顺序与串行一致（先完成的靠后批次排队发送）；前端合并无需改。
3. 每批落盘加锁；中断后未翻译块仍标记可自愈；续跑只补缺失。
4. 客户端断开/取消 → 在途批次取消；402/额度错误立即中断并透传。
5. 计时日志：feature=sse_translate、batch_index、queue_wait_ms、batch_ms、first_batch_ms、total_ms、concurrency。
6. 测试：延迟 mock 证明并行收益、顺序、落盘、取消、402；相关 pytest + 全量；不改前端（除必要事件兼容）。
7. 不改 `/api/process-video` 已并行逻辑；preflight `--staged`。

## deps
- P1-18（已完成）
