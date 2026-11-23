# 视频翻译批次并行 + 计时（P1-18 / B1）验证报告

- 卡：`TASKS/P1-18-video-pipeline-speed.md`（owner `video-perf-impl`，reviewer/integrator lead）
- 证据 sha：`HEAD c88b719`（工作区改动，未 commit；卡内 `base_sha: a5d0f80` 已被后续 card 提交推进，以 HEAD 为准）
- 写域：`backend/routes_videos.py`、`backend/tests/test_video_pipeline_timing.py`（新建）、本报告
- 前端：未改（`TranscriptBlock.tsx` 无需改；分析仍不阻塞播放/字幕首屏，语义未变）
- 服务：`http://127.0.0.1:8000/health` → `{"status":"ok"}`（未重启服务）

## TL;DR

1. 经典视频翻译路径（`POST /api/process-video`）的批次翻译改为**并行**：默认 2 路，`VIDEO_TRANSLATION_CONCURRENCY` 可调 1–3；block 顺序、retry/mock/硬闸语义、`batch_pause` 限流全部保持。
2. 新增结构化计时：`feature=video_translation`（batch_count / 每批 duration_ms / total_ms / concurrency）、`feature=video_analysis`（total_ms）。
3. 断言级验证：stub 4 批 ×300ms，并发 1 → 1.205s，并发 2 → 0.603s（≈2×）；顺序、不重复调用、失败回退、硬闸、SSE 进度/落盘均有用例覆盖。
4. **SSE 流式路径未动**：`_fresh_stream_gen` / `_cached_stream_gen` 仍走 `translate._stream_translate`（逐批落盘、按序推送、断点续传口径不变）。`translate.py` 不在本卡 write_scope，故流式并行不在本卡实施；若要做需另开卡把 `translate.py` 纳入写域。

## 1. 改动（`backend/routes_videos.py`）

### 1.1 批次并行调度

新增（仅在经典路径使用）：

| 符号 | 作用 |
|---|---|
| `VIDEO_TRANSLATION_BATCH_SIZE = 20` | 与流式路径一致的批大小 |
| `VIDEO_TRANSLATION_CONCURRENCY_DEFAULT = 2` / `_MAX = 3` | 并发上下界 |
| `_video_translation_concurrency()` | 读 `VIDEO_TRANSLATION_CONCURRENCY`，非数字/缺省回落 2，夹在 1–3；每次调用时读取，改 `.env` 即生效 |
| `_translate_video_batch()` | 单批翻译：retry（3 次、429 指数退避 10s→20s）、失败回退 `mock_llm_processing`、计费硬闸直接抛——逐行承接旧串行循环 |
| `_translate_video_blocks()` | 切批 + 并发 lane 调度 + 按 batch 下标回填结果 + 计时汇总 |
| `_attach_video_analysis()` | 教学分析调用包装：`feature=video_analysis total_ms`，返回值/异常语义不变（6 处调用全部换用） |

调度语义：

- 批次数 `B = ceil(blocks/20)`，实际并发 `min(config, B)`——只有 1 批时退化为 1 路，没有额外开销。
- `concurrency` 条 lane 共享递增下标动态领批；结果写 `results[batch_index]`，最终按输入下标顺序摊平 → **block 输出顺序与串行完全一致**（与完成先后无关）。
- 每条 lane 跑完一批（非最后一批）后 `await asyncio.sleep(llm.batch_pause(model))` 再领下一批 → provider 限流节奏保留（同一时刻最多 `concurrency` 个请求在途）。
- 硬闸 `BillingError` / `QuotaExceeded` 原样抛出：立即取消其余 lane，不落 mock。
- 非 429 错误不重试（与旧语义一致），只回退该批 mock；429 重试耗尽同样只回退该批。
- 每个 batch 只调用一次 `process_llm_batch`（无重试之外的重复调用）。
- 计费/配额：每批仍各扣 1 单位，批数不变 → 总扣费次数不变；并发不改变配额口径。

### 1.2 `process_video` 接入

原 ~45 行串行 for 循环替换为一次 `await _translate_video_blocks(blocks, model=..., user_id=..., lang=...)`；端点其余逻辑（缓存命中、补译、总结、写盘、分析、学习次数）未变。

### 1.3 边界说明（为什么没改 SSE）

- 产品核心 SSE 的逐批翻译循环在 `translate._stream_translate`（`backend/translate.py`），不是 `routes_videos.py`；本卡 write_scope 未包含 `translate.py`，按「只改卡内白名单」未越界修改。
- 因此流式语义**零改动**：`meta` 先发英文字幕 → 每批 `batch` 事件按批序推送并落盘 → 分析完成后用 `batch` 事件回填 → `summary`/`done`；`cursor`/`canResume`/断点补译口径不变（见 §4 SSE 用例）。
- 若要让流式批次也并行，需要把 `translate._stream_translate` 的批次循环改成同样的有序并发（并保持逐批事件顺序与落盘），建议单开一张卡把 `backend/translate.py` 纳入写域。

## 2. 计时日志

一行一个 JSON，经 `logging.getLogger("linguatrek.routes_videos")` 输出；`LOG_JSON=1` 时由 `observability.JsonFormatter` 摊平为顶层字段。真实样例（本地 stub 2 批 ×50ms + 分析 30ms）：

```json
{"feature": "video_translation", "event": "batch", "batch": 1, "batch_count": 2, "duration_ms": 50.33, "concurrency": 2, "attempts": 1, "fallback": false, "outcome": "ok"}
{"feature": "video_translation", "event": "batch", "batch": 2, "batch_count": 2, "duration_ms": 50.4, "concurrency": 2, "attempts": 1, "fallback": false, "outcome": "ok"}
{"feature": "video_translation", "event": "total", "batch_count": 2, "total_ms": 50.54, "concurrency": 2, "batch_durations_ms": [{"batch": 1, "duration_ms": 50.32}, {"batch": 2, "duration_ms": 50.4}], "ok": true}
{"feature": "video_analysis", "total_ms": 30.9, "content_ref": "vitest12345", "level": "B1", "ok": false}
```

字段：

- `feature=video_translation`：`event=batch` 每批一行（`batch`、`duration_ms`、`concurrency`、`attempts`、`fallback`、`outcome`）；`event=total` 汇总（`batch_count`、`total_ms`、`concurrency`、按批号排序的 `batch_durations_ms`、`ok`）。
- `feature=video_analysis`：`total_ms`（含缓存命中的 0 模型调用路径）、`content_ref`、`level`、`ok`（`attach_to_payload` 返回分析即 true；分析失败/跳过为 false，不影响视频返回——现有语义）。

检索示例：`grep '"feature": "video_translation"'`；按请求还可叠加访问日志里的 `request_id`。

## 3. 实测（stub 延迟证明并行 wall time）

条件：80 blocks（4 批 ×20），`process_llm_batch` stub 每批 `sleep 300ms`，`batch_pause=0`，同机单进程。

| 并发 | 理论波次 | wall time | 相对串行 |
|---|---|---|---|
| 1（串行） | 4 | 1.205s | 1.00× |
| 2（默认） | 2 | 0.603s | 2.00× |
| 3 | 2（4 批 / 3 路） | 0.602s | 2.00× |

说明：4 批时 3 路也只跑 2 波，收益与 2 路相同；批数 ≥3 的路由在真实视频（通常 >3 批）上才能吃到 3 路收益。全局 LLM 并发闸 `LLM_MAX_CONCURRENCY=4` 仍然生效，视频侧并发不会绕过它。

## 4. 测试

新增 `backend/tests/test_video_pipeline_timing.py`（7 个用例）：

1. 并发配置默认 2、1/2/3 透传、0→1、9→3、非法回落 2；
2. 并行 wall time（并发 2 明显快于并发 1，断言 `< 0.8×`）、block 顺序、峰值在途=2、4 批各调用一次；
3. `batch_pause` 仍在批间生效（3 批 / 2 路 → 恰好 2 次、wall time 覆盖等待）；
4. 非限流失败批次回退 mock：只回退该批、每批仅 1 次调用、其余批正常、顺序不变；
5. 计费硬闸（`billing.LoginRequired`）直接抛出、不落 mock、无重复批次；
6. `/api/process-video` 端点集成：200、41 句顺序、3 批、`feature=video_translation` 的 batch/total 字段与 `feature=video_analysis total_ms` 均落日志；
7. SSE 回归：事件序 `meta, batch×3, stage, summary, done`、每批 `progress.done=20/40/41`、逐批落盘后缓存 41 句全部有译文（断点恢复口径不变）。

命令与结果（`backend/`，离线）：

```bash
venv/bin/python -m pytest tests/test_video_pipeline_timing.py -q          # 7 passed
venv/bin/python -m pytest tests/test_i18n_target_lang.py tests/test_jobs.py \
  tests/test_teaching_analysis.py tests/test_ai_ledger.py \
  tests/test_ai_login_billing.py tests/test_analysis_access.py -q          # 110 passed
venv/bin/python -m pytest tests -q                                        # 全量见下
venv/bin/python -m py_compile *.py                                        # OK
```

全量：`1441 passed, 2 warnings in 273.80s`（运行时刻工作区含 P1-17 并行书翻译改动与新增用例；本次只对本卡 3 个文件负责）。

## 5. 门禁

- `py_compile *.py`：通过。
- pytest：新用例 + 相关 110 个用例通过；全量 1441 passed（见上）。
- preflight：`node scripts/agent-preflight.mjs --card P1-18 --staged` → **未通过（1 error）**，原因不是白名单而是 Board 写域声明冲突：

```
PASS  卡状态：P1-18（claimed）可开工
PASS  owner：video-perf-impl
PASS  deps：无
PASS  共享文件：未命中
PASS  白名单：3 个改动文件均在 write_scope 或共享例外内
FAIL  活跃卡写域交集（1 张卡），需等对方合并或拆卡：
      - P1-17（claimed，owner=book-perf-impl）冲突文件：backend/tests/test_video_pipeline_timing.py
HEAD: c88b719
```

  冲突根因：`TASKS/board.json` 把两张卡的测试目录都粗写成 `backend/tests/`；而两张卡正文的 write_scope 是互不相交的具体前缀（P1-17 = `backend/tests/test_book_translation*.py`，P1-18 = `backend/tests/test_videos*.py`）。**建议 lead（Integrator）把 board 里 P1-17 的该项收窄为 `backend/tests/test_book_translation*.py`（或给 P1-18 标 shared 例外）后重跑 preflight**；本卡代码文件本身已全部通过白名单/共享文件检查。
- specs：`specs/001-streaming-pipeline` 描述的流式逐批行为未变（本卡未动 `translate.py`），无 spec 变更。
- 未 `git commit`（按任务要求）；未改前端；未改 `translate.py` / 书相关文件。
- 相关 6 个既有测试文件（`test_i18n_target_lang` / `test_jobs` / `test_teaching_analysis` / `test_ai_ledger` / `test_ai_login_billing` / `test_analysis_access`）共 110 个用例全部通过，说明并行没有改变 `process_llm_batch` mock 语义等外部可观察契约。

## 6. 已知边界与风险

1. **硬闸中止的固有差异**：串行路径在计费错误时后续批次不会发出；并行路径中止时已启动的批次（最多 `concurrency-1` 个）会把当前调用跑完（结果丢弃）。不产生重复调用，但极端错误下可能多 1 次已开始的 provider 调用——这是并行的固有代价，已在测试中确认不会落 mock、不会重复送批。
2. **`batch_pause` 语义**：从「每批之后等一次」变为「每条 lane 非最后一批之后等一次」，同一时刻在途请求数上限 `concurrency`；限流节奏等价，但不做跨 provider 的令牌桶。
3. **流式路径无收益**：SSE 仍逐批串行（见 §1.3）；本报告只证明经典路径与 SSE 语义不变。
4. **重试延迟**：429 指数退避仍是 10s/20s，并行下多批可能同时等待；未改数值，避免引入新的限流行为。
5. 前端未改：分析完成后仍通过既有 `batch` 事件回填高亮，不阻塞首屏。

## 7. 建议后续

1. 立项把 `backend/translate.py` 纳入写域，给 `_stream_translate` 加同样的有序并发（参数化 concurrency、逐批落盘顺序与 SSE 事件顺序保持不变），让产品主路径也吃到 2–3 路收益。
2. 若后续有 provider 级令牌桶，可把 `batch_pause` 升级为按 provider 的共享节流器（当前按批等待已满足 provider 限流要求）。
