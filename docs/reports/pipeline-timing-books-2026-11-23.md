# 书章节管线提速（B1）报告：批次并行 + 计时 + 分析不阻塞首屏

- 卡：`TASKS/P1-17-book-pipeline-speed.md`（owner：book-perf-impl）
- 卡 base sha：`a5d0f80`；起工 HEAD：`c88b719`；门禁/证据 HEAD：`9fe9330`（期间 P1-18 已合并）
- 日期：2026-11-23
- 范围：`backend/book_translation.py`、`backend/routes_books.py`、`backend/tests/test_book_translation_parallel.py`（新建）、`frontend/src/components/BookReaderScreen.tsx`、本报告
- 未改动：视频管线（`backend/routes_videos.py` 等属于 P1-18）

## 1. 改动前的问题

书章节首次打开时，缺失段落按批**串行**逐批翻译：后一批要等前一批返回；批间还有
`llm.batch_pause()`（Gemini 免费档默认 4s）。一本 288 段（约 36 批）的章节，

- 串行耗时 ≈ `36 × 单批耗时 + 35 × 4s`，很容易越过整章 180s 超时；
- 超时后只有「已完成批次」落库，用户首屏拿不到完整译文；
- 没有任何结构化耗时日志，无法区分「翻译慢」还是「分析慢」；
- 前端首屏 GET 带 `?level=` 时，教学分析在返回前同步生成，正文被分析拖住；
- 分析失败/较慢时，用户看不到任何「语言点正在生成」的非阻断状态。

## 2. 改动内容

### 2.1 翻译批次并行（`backend/book_translation.py`）

- **并发度**：默认 3 路，可调 1–4。读取顺序：`config.BOOK_TRANSLATE_CONCURRENCY`
  → 环境变量 `BOOK_TRANSLATE_CONCURRENCY` → 默认 3；越界自动夹到 1–4，非法值回退默认。
  新增只读函数 `translate_concurrency()`（测试/日志共用）。
- **调度**：`_translation_batches()` 切出的批次通过 `asyncio.Semaphore(并发度)`
  并发执行；**收敛**为 `asyncio.gather(..., return_exceptions=True)`，等所有批次
  结束后再统一判定，避免某批异常时其它批还在后台写缓存。
- **按批顺序合并**：每个下标只属于一个批次；所有成功结果先收集，最后按批次顺序
  覆盖进与原文段落一一对应的 `values`，再写一次缓存（并发完成顺序不影响最终顺序）。
- **成功批次保留 / 部分失败可续**：每个成功批次立即落缓存（快照包含此前全部成功
  批次），失败段写 `null`；下次请求只把 `null` 段送模型，已花钱的段落不重复付费。
- **缓存写安全**：新增进程内 `threading.Lock`（`_cache_write_lock`）包裹
  `save_cache()` 的建连 + UPSERT；「合并结果 + 落库」在逐章 `asyncio.Lock` 内串行，
  快照只增不减，后写不会覆盖先写的成功批次；UPSERT 仍兜底多进程。
- **每日限额只扣 1 次**：`_consume_daily_limit()` 仍在「开始调模型前」调用一次，
  与批数/并发无关；缓存命中不占名额（行为不变）。
- **串行兼容**：并发度 = 1 时退回旧串行节奏，并保留 `llm.batch_pause()` 批间停顿
  （对 RPM 敏感的 provider 可设 1）；并发 > 1 时不再逐批停顿。
- **失败语义不变**：所有批次都失败仍是 502 且不写整行 null；整章超时仍 504，
  超时前成功的批次已落库。

### 2.2 计时日志

翻译（每次翻译尝试都打一行，缓存命中也会打 `status=cached`、`batch_count=0`）：

```
feature=book_translation book=<id> chapter=<n> lang=<code> status=done|partial|failed|cached
batch_count=<n> concurrency=<1-4> total_ms=<float>
batch_ms=[{"batch":0,"duration_ms":1234.5,"paragraphs":8,"translated":8,"ok":true}, ...]
failed_paragraphs=<n>
```

- `total_ms`：从进入 `translate_chapter` 到返回/抛错的整章耗时（含抓原文/缓存读写）；
- `batch_ms`：每批的 `duration_ms`、段落数、成功数、是否成功，按批次序号排序；
- `book/chapter/lang/batch_count/concurrency` 为固定字段，便于 grep/聚合。

分析（`backend/routes_books.py: _attach_chapter_analysis`，只在请求带 `level` 时记录）：

```
feature=book_analysis book=<id> chapter=<n> lang=<code> level=<level>
status=ready|unavailable|skipped_untranslated|invalid_level|failed total_ms=<float>
```

### 2.3 分析不阻塞首屏（`frontend/src/components/BookReaderScreen.tsx`）

- **首屏只取正文**：章节首次/切章/切语言 GET 不再带 `?level=`，拿到译文就渲染；
  分析不再参与首屏关键路径（服务端 GET 带 level 时仍会同步生成，前端只是不再依赖它）。
- **翻译后异步补分析**：新增 deferred effect —— 正文已渲染且本章译文完整
  （`missingTranslations === 0`）后，才单独 GET `?level=` 拿增强 payload；每
  `(book, chapter, language, level)` 只请求一次，重试显式触发；旧响应用 token 丢弃。
- **非阻断状态**：分析请求在飞时显示「正在加载语言点」（复用既有 i18n key
  `teachingNotes.loading`，不新增文案），正文/译文/听读均照常可用。
- **失败仍可读**：分析请求失败时保留已渲染章节，只在阅读面内显示非阻断提示 +
  「重试」按钮（复用 `ReadingSurface` 的 P0-04 `analysisUnavailable` 通道）。
- 翻译 POST 返回后不再在 `runTranslation` 里二次拉取章节；分析统一交给上述 effect，
  避免「翻译完再等分析」阻塞状态。

## 3. 耗时对比（预计 / 单测实测）

设批数 N、单批耗时 `t`、批间停顿 `p`、并发 C：

- 改动前预计 ≈ `N × t + (N-1) × p`
- 改动后预计 ≈ `ceil(N / C) × t`（C>1 时无逐批停顿）

| 场景 | 改动前预计 | 改动后预计（C=3） | 降幅 |
|---|---|---|---|
| 6 批 × 20s，p=4s | 140s | 2 波 ≈ 40s | −71% |
| 9 批 × 20s，p=4s | 212s（>180s 超时） | 3 波 ≈ 60s | −72% |
| 36 批 × 20s，p=4s | 860s | 12 波 ≈ 240s（仍超时则保留部分成功、重试补缺） | −72% |

> 上表为按公式的**预计值**（真实 provider 延迟视网络/限流波动）；`p` 取 Gemini
> 免费档默认 4s，单批 20s 为保守假设。

单测实测（`backend/tests/test_book_translation_parallel.py`，mock `_translate_batch`
+ `asyncio.sleep`，pytest `-s` 输出）：

| 用例 | 配置 | 实测 wall | 对照 |
|---|---|---|---|
| 并行 3 批 × 200ms | C=3 | **224ms** | 串行 sum = 600ms（−63%） |
| 串行 3 批 × 100ms | C=1 | **319ms** | sum = 300ms（仅调度开销） |

日志实测（同一用例，caplog）：`batch_count=3 concurrency=3`，`batch_ms` 中每批
`duration_ms ≥ 190ms`，`total_ms ≥ 200`，`book=parallel-book chapter=1`。

## 4. 验证

- `backend/venv/bin/python -m py_compile book_translation.py routes_books.py`：通过
- 新增测试 `tests/test_book_translation_parallel.py`：8 passed，覆盖
  并行 wall time(max≠sum)/串行/配置夹取/部分失败续补/全失败 502/每日限额只扣 1 次/
  缓存快照单调无覆盖/并发线程写安全/日志字段
- 既有 `tests/test_book_chapter_translation.py`：28 passed（行为兼容）
- 全量 `pytest`：**1441 passed**（273.98s，含既有视频/书籍/课程等全部后端用例）
- 前端：`npx tsc -b`、`npm run build`、`npm run check:i18n`（PASS，2602 keys × 2 languages）、
  `node ../scripts/gate-receipt.mjs --base c88b719`（G1/G2/G4/G6 机械计数 0，i18n PASS；
  UI 人眼走查未做，本机无浏览器工具）
- preflight：`node scripts/agent-preflight.mjs --card P1-17 --staged --evidence-sha 9fe9330`
  → **PASS（0 errors，5 个改动文件全在写域内，无活跃卡写域交集，证据 SHA == HEAD）**。
  注：P1-18 合并前其 board 写域含 `backend/tests/`，曾与 P1-17 的交集检查冲突；
  收窄写域（`ef2efaf`）并合并 P1-18 后复核通过。

## 5. 风险与边界

- 并发 3 路会同时占用全局 LLM 并发闸与 provider RPM；若遇到 429/限流，
  `_translate_batch` 的降级链与「失败段留 null」逻辑会保留已成功批次，可重试补缺。
  对 RPM 敏感的部署可设 `BOOK_TRANSLATE_CONCURRENCY=1` 回到串行节奏。
- 分析仍需一次额外 GET（带 `?level=`），但发生在正文渲染之后，失败不阻断阅读；
  未改变后端「分析失败 fail-open」的既有语义。
- 本次未改视频管线、迁移、i18n 文件与共享组件；前端只改 `BookReaderScreen.tsx`。
