# SSE 流式翻译批次并行 + 计时（P1-19 / B2）验证报告

- 卡：`TASKS/P1-19-sse-stream-speed.md`（owner `sse-perf-impl`，reviewer/integrator lead）
- 证据 sha：`HEAD 45b71e6`（工作区改动，**未 commit**；卡内 `base_sha: ec34e04` 已被后续提交推进，以 HEAD 为准）
- 写域：`backend/translate.py`、`backend/routes_videos.py`、`backend/tests/test_streaming_pipeline.py`（新建）、本报告
- 前端：**未改**（`batch` 事件契约不变，前端按 id 合并逻辑无需改动）
- 经典路径：**未改** `/api/process-video` 已有的并行逻辑（`_translate_video_blocks`）

## TL;DR

1. `translate._stream_translate` 的批次翻译改为**有序并行**：默认 2 批（`SSE_TRANSLATE_CONCURRENCY`，1–3 可调）；后完成批次在内存队列排队，`batch` 事件仍严格按批序产出。
2. 每批完成即回填 + 持 `asyncio.Lock` 落盘；中断后未翻译块仍为 `[未翻译]`，续跑只补缺失（自愈不变）。
3. 客户端断开/取消：async generator `finally` 取消全部在途 task 并 `gather` 等待，无泄漏；402/额度硬闸立即置 `aborted`、取消在途批次并透传（`_guarded_stream` 仍转成稳定 code 的 SSE `error` 事件）。
4. `batch_pause` 从「每批跑完睡一拍」改为**本流全局的批开始时间节奏**：任意两批开始时间至少间隔 `batch_pause`，并发下仍遵守 provider 节奏。
5. 进度/`cursor` 改为按批序累计的「实际已翻句数」（`translated`），避免后完成批次先落盘导致首批事件进度跳变。
6. 新增结构化计时 `feature=sse_translate`（每批 `batch_index/queue_wait_ms/batch_ms/concurrency`，收尾 `total_ms/first_batch_ms/concurrency/outcome`）。
7. 断言级验证：3 批 ×200ms，串行 0.607s → 并发 2 为 0.404s（两波）→ 并发 3 为 0.205s；乱序完成（批 3 先回）时 `queue_wait_ms` 分别为 0 / 120 / 200ms，事件顺序仍 1→2→3。全量 `1451 passed`。

## 1. 改动（`backend/translate.py`）

### 1.1 新增配置/工具

| 符号 | 作用 |
|---|---|
| `SSE_TRANSLATE_CONCURRENCY_ENV` / `_DEFAULT=2` / `_MAX=3` | 并发配置名与上下界；批大小常量 `SSE_TRANSLATE_BATCH_SIZE=20`（与串行路径一致） |
| `_stream_translate_concurrency()` | 读 `SSE_TRANSLATE_CONCURRENCY`：非数字/空/超出 1–3 一律回落 **2**（卡要求「非法回退 2」，与 P1-18 的 clamp 语义有意不同）；每次生成器开始时读取，改 `.env` 即生效 |
| `_stream_timing(**fields)` | 一行 JSON 计时日志，`feature=sse_translate`，经 `logging.getLogger("linguatrek.translate")` 输出 |
| `_persist_stream_payload(payload, save_path)` | 整份 payload 写盘；测试打桩可计数（仍调用真实写盘） |

### 1.2 调度语义

- 批次数 `B = ceil(len(indices)/20)`，实际并发 `min(config, B)`；每批一个 `asyncio.Task`，`asyncio.Semaphore` 限制在途批数。
- **按批序产出**：worker 完成时把 `(batch_index, batch_ms, completed_at, translated_count)` 放进 `asyncio.Queue`；生成器只等 `batch_index == expected`，先到但序号靠后的消息存 `completed` 字典缓冲——事件顺序与串行逐行一致，前端零改动。
- **每批完成即落盘**：worker 在 `async with write_lock` 内回填本批 block、`stamp_payload_language`、整份 payload 写盘；后完成批次的写盘也包含此前已完成批次的译文（写锁串行，不会互相覆盖）。写盘发生在 yield 之前，客户端在任意时刻断开都不丢已完成批次。
- **失败语义不变**：非计费异常仍只影响该批（打印后该批 block 保持 `[未翻译]`，下一次加载自愈），并照样完成一次落盘；不中断整条流。
- **首批优先一次调度**：非首批 task 在进 provider 前 `await asyncio.sleep(0)` 让出一次调度。首个结果若同步返回（缓存/极快 provider），先产出首个 `batch` 事件，其余 lane 随后进入；真实模型调用下无可观测差异。这也是「断线时只跑完第 1 批」既有 jobs 语义得以保持的原因（见 §5）。
- **取消**：生成器 `finally` 对全部 task `cancel()` 后 `await asyncio.gather(..., return_exceptions=True)`；`CancelledError`/`GeneratorExit` 单独记录 `outcome=cancelled` 后继续上抛。
- **402/额度错误立即中断**：worker 捕获 `billing.BillingError` / `ai.ledger.QuotaExceeded` 后置 `aborted`、把 `("abort", exc)` 入队并上抛；生成器收到 abort 立即 `raise`（不等待前一批），`finally` 取消其余在途 task；`aborted` 还会拦住尚未进 provider 的排队批次（不再多花钱）。
  - 与旧行为的有意差异：旧流式路径只透传 `BillingError`，`QuotaExceeded`（429）会被 `rethrow_billing_error` 放过并继续跑后续批次；本卡按 acceptance 改为 **429 同样立即中断**，由 `_guarded_stream` 转成带 `code`（`quota_exceeded`/`budget_exceeded`）的 SSE error 事件。
- **provider 节奏**：`_wait_for_start_slot()` 用 `pace_lock` + `last_started` 保证批与批**开始时间**至少相隔 `llm.batch_pause(model)`；`pause<=0` 时完全跳过（测试/本地 provider 零开销）。并发 lane 不会绕过该节奏。

### 1.3 进度/cursor

- 生成器 yield 的 update 新增 `translated`：进入函数时已翻好的句数 + 按批序累计的本批实际翻好句数（`[未翻译]`/空 不计数）。
- 原因：并行下后完成批次可能先落盘并回填 `transcript`，若路由沿用 `_translated_cursor(transcript)` 实时计数，首批事件就可能把进度报成接近 100%。

## 2. 改动（`backend/routes_videos.py`）

- `_cached_stream_gen` / `_fresh_stream_gen` 两个消费循环：`cursor = update.pop("translated", None)`，缺省（兼容旧式/被打桩的 update）才回落 `_translated_cursor(transcript)`。SSE `batch` 事件字段/顺序均不变（`translated` 是内部字段，不会出现在事件里）。
- `_translate_video_blocks` docstring 同步：流式路径已改为「有序并行」，经典路径不受影响。

## 3. 计时日志

一行一个 JSON；`LOG_JSON=1` 时由 `observability.JsonFormatter` 摊平。真实样例（本地 stub：3 批 ×200ms，`SSE_TRANSLATE_CONCURRENCY=3`）：

```json
{"feature": "sse_translate", "event": "batch", "batch_index": 0, "batch_count": 3, "queue_wait_ms": 1.81, "batch_ms": 201.22, "concurrency": 3}
{"feature": "sse_translate", "event": "batch", "batch_index": 1, "batch_count": 3, "queue_wait_ms": 0.91, "batch_ms": 202.46, "concurrency": 3}
{"feature": "sse_translate", "event": "batch", "batch_index": 2, "batch_count": 3, "queue_wait_ms": 0.16, "batch_ms": 203.44, "concurrency": 3}
{"feature": "sse_translate", "event": "total", "batch_count": 3, "total_ms": 204.6, "first_batch_ms": 204.46, "concurrency": 3, "translated": 45, "outcome": "done"}
```

乱序完成样例（批 1/2/3 延迟 240/120/40ms，完成顺序 3→2→1；事件仍按 1→2→3）：

```json
{"feature": "sse_translate", "event": "batch", "batch_index": 0, "batch_count": 3, "queue_wait_ms": 0.04, "batch_ms": 241.11, "concurrency": 3}
{"feature": "sse_translate", "event": "batch", "batch_index": 1, "batch_count": 3, "queue_wait_ms": 120.14, "batch_ms": 121.12, "concurrency": 3}
{"feature": "sse_translate", "event": "batch", "batch_index": 2, "batch_count": 3, "queue_wait_ms": 200.41, "batch_ms": 40.96, "concurrency": 3}
{"feature": "sse_translate", "event": "total", "batch_count": 3, "total_ms": 242.44, "first_batch_ms": 242.01, "concurrency": 3, "translated": 45, "outcome": "done"}
```

字段：

- `event=batch`：`batch_index`（0 起）、`batch_count`、`batch_ms`（该批 provider 调用耗时，含降级/重试，不含限速等待）、`queue_wait_ms`（该批完成 → 按序交给消费端的排队时长，乱序时显著 >0）、`concurrency`。
- `event=total`：`batch_count`、`total_ms`、`first_batch_ms`（首个 batch 事件产出时间，首字指标）、`concurrency`、`translated`（最终已翻句数）、`outcome`（done/error/cancelled）。
- 不打印任何字幕/译文内容。

检索示例：`grep '"feature": "sse_translate"'`。

## 4. 实测：并行收益（stub 延迟证明 wall time）

条件：45 blocks（3 批 ×20/20/5），`process_llm_batch` stub 每批 `sleep 200ms`，`llm.batch_pause=0`，同机单进程。

| 并发 | 理论波次 | wall time | 相对串行 |
|---|---|---|---|
| 1（串行基线） | 3 | 0.607s | 1.00× |
| 2（默认） | 2 | 0.404s | 1.50× |
| 3 | 1 | 0.205s | 2.96× |

说明：卡 acceptance 的「3 批×200ms → 并行 ~220ms」对应并发 3（三批同波）；默认 2 只有两批同波，3 批需要两波（≈400ms），这是并发上限的预期行为。真实视频通常 >3 批，默认 2 的稳态吞吐约为串行的 2 倍；`LLM_MAX_CONCURRENCY=4` 的全局闸仍生效。

## 5. 测试

新增 `backend/tests/test_streaming_pipeline.py`（10 个用例，全部离线）：

| 用例 | 断言 |
|---|---|
| `test_stream_translate_concurrency_config` | 默认 2；1/2/3 生效；0/9/-1/abc/空 回退 2 |
| `test_parallel_batches_keep_order_and_persist` | 并发 3、3 批延迟 240/120/40ms：wall <0.34s（串行 0.40s）、peak=3；事件/block 顺序=串行；`translated=[20,40,45]`；落盘 3 次；最终全译文；计时日志字段与 `queue_wait_ms>40/80ms`、`first_batch_ms≥200ms` |
| `test_default_concurrency_is_two` | 默认 2：peak=2，3×150ms 两波完成 <0.42s |
| `test_batch_pause_paces_batch_starts` | 并发 3 且 `batch_pause=0.12`：相邻批开始时间差 ≥0.1s（全局节奏） |
| `test_cancel_cancels_inflight_and_resume_only_missing` | 首批后 `aclose()`：0.0x s 返回、无泄漏 task、在途批次 cancelled、只落盘 1 次、其余块仍 `[未翻译]`；续跑只送 21–45 |
| `test_billing_error_aborts_immediately[402/429]` | 批 2 立即抛 `InsufficientBalance`/`QuotaExceeded`：<0.5s 上抛、无泄漏 task、在途批取消、不落盘成功 |
| `test_failed_batch_stays_untranslated_and_heals` | 单批非计费失败：该批保持标记、其余批正常、`translated=[20,20,25]`、续跑只补失败批 |
| `test_sse_endpoint_keeps_batch_order_with_parallel_batches` | 端点乱序完成：SSE 仍 `meta→batch×3→stage→summary→done`，`progress/cursor=[20,40,45]`，block id 1–45，缓存全量落盘，计时日志齐全 |
| `test_sse_endpoint_402_emits_error_event` | 端点 402：<2s 返回 `meta→error`，`code=insufficient_balance` |

回归（既有流式/断点/cursor 语义）：

- `tests/test_jobs.py`：`[batch.cursor] == [20,40,45]`、断线后 `partial`/`cursor=20`、续传只补 21–45、总调用 3 批；
- `tests/test_video_pipeline_timing.py::test_sse_stream_keeps_batch_order_progress_and_cache`：`progress=[20,40,41]`、block 顺序、逐批落盘；
- `tests/test_streaming_p0.py`：SSE 心跳/事件顺序/事件循环不阻塞。

结果：

```
# 相关回归（既有流式/断点 + 邻近路由测试 11 个文件，不含本卡新文件）
223 passed in 28.09s

# 全量 backend
1451 passed, 2 warnings in 273.70s (0:04:33)
```

## 6. 边界与未做

- 前端未改；SSE 事件名/字段/顺序未变（`batch` 事件只多一个内部字段，路由已 pop 掉）。
- `/api/process-video`（经典路径）未改。
- 限速节奏是**本流内全局**（跨并发 lane），不是跨请求/跨进程的 provider 全局限流；与 P1-18 经典路径同口径。若日后需要 provider 级全局限流，应抽到 `llm` 层统一处理。
- 并发上限 3 是卡内约束；实际吞吐仍受 `LLM_MAX_CONCURRENCY=4` 与 provider RPM 约束。
- `queue_wait_ms` 只在事件交给消费端时记录；若流在等待期间被取消，该批没有 batch 日志（属于预期，收尾有 `outcome=cancelled` 的 total 日志）。

## 7. 复现命令

```bash
cd backend
venv/bin/python -m pytest tests/test_streaming_pipeline.py -q
venv/bin/python -m pytest tests/test_jobs.py tests/test_streaming_p0.py \
  tests/test_video_pipeline_timing.py -q
venv/bin/python -m pytest tests/ -q
venv/bin/python -m py_compile translate.py routes_videos.py tests/test_streaming_pipeline.py
cd .. && git add backend/translate.py backend/routes_videos.py \
  backend/tests/test_streaming_pipeline.py docs/reports/pipeline-timing-sse-2026-11-23.md
node scripts/agent-preflight.mjs --card P1-19 --staged
```

## 8. preflight

（见下方运行结果，`--card P1-19 --staged`。）

```
agent-preflight · 写域/证据门禁
card: P1-19（status=claimed，owner=sse-perf-impl）
base: ec34e04（来源：卡 base_sha）
mode: 暂存区（--staged）
HEAD: 45b71e6b8fe2746c9c2bfb8ecd79ed7a42d41bd6
改动文件：4 个

INFO  证据绑 HEAD：提交后请用 --evidence-sha 45b71e6 复核
PASS  卡状态：P1-19（claimed）可开工
PASS  owner：sse-perf-impl
PASS  deps：P1-18
PASS  共享文件：未命中
PASS  白名单：4 个改动文件均在 write_scope 或共享例外内
PASS  活跃卡写域：无交集（已检查：P2-08）

结果：✅ 通过（0 errors，0 warnings）
```

说明：同一工作区里 P2-08（watch-impl）的前端改动/新增文件保持未暂存，未进入本卡证据；本卡只暂存上述 4 个白名单文件，**未 commit**。
