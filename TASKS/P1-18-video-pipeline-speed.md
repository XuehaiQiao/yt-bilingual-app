# P1-18 视频翻译并行 + 计时（同 B1）

- status: claimed
- owner: {implementer: video-perf-impl, reviewer: lead, integrator: lead}
- base_sha: a5d0f80

## goal
视频处理/学习流的翻译批次并行（受 provider 限流约束），保持流式顺序与进度语义；加结构化计时日志；分析仍不阻塞播放/正文。

## write_scope
- `backend/routes_videos.py`
- `backend/tests/test_videos*.py`（相关）
- `docs/reports/pipeline-timing-2026-11-23.md`（与 P1-17 协调，避免冲突；本卡只追加视频行）
- `frontend/src/components/TranscriptBlock.tsx`（如需“分析中”状态，最小）

## acceptance
1. 视频翻译批次并行（默认 2、可配置 1–3），保持 block 输出顺序；进度/断点恢复不变。
2. 限流 pause 仍生效；失败批次回退/mock 语义不变；不产生重复调用。
3. 计时日志：`feature=video_translation`、batch_count、per-batch duration_ms、total_ms、concurrency；分析 total_ms。
4. 分析不阻塞播放/字幕首屏；失败仍可看视频（现有语义）。
5. 测试：mock 延迟证明并行 wall time；顺序/断点/失败回退；pytest 相关+全量；preflight。

## deps
- 无（与 P1-17 文件不重叠；docs 报告由 lead 合并）
