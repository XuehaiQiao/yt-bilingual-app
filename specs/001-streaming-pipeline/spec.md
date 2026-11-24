# 规格：字幕流式管线

**状态：** 已实现 ｜ **对应代码：** `backend/routes_videos.py`（`process_video_stream`）、`backend/translate.py`（`_stream_translate`、`process_llm_batch`、`_align_processed_blocks`）、`backend/translation_batching.py`（P2-33 分批策略）、`backend/ai/quota.py`（P2-34 配额单位换算）、`backend/llm.py`（OpenAI 兼容 payload）、`backend/config.py`（`MODEL_CATALOG`）、`backend/jobs.py` + `backend/migrations/versions/0005_jobs.py`（任务表/续传，M1 ⑤）、`frontend/src/lib/transcript.ts`、`frontend/src/lib/jobs.ts`、`frontend/src/App.tsx`、`frontend/src/components/ModelBar.tsx`

---

## 目标
把"处理一个视频"从"对着加载圈干等几分钟"变成"几秒就能看，翻译边看边补"。这是整个产品体验的地基（[宪法原则 3](../../CONSTITUTION.md)）。

## 用户故事
- 作为用户，我粘贴链接后想**立刻**开始看视频和英文字幕，而不是等全部翻译完。
- 作为用户，翻译没跑完我就关掉了，下次打开希望它**接着翻**，而不是从头再来。
- 作为用户，同一个视频我看第二次，希望**秒开**，不要重新花钱处理。

## 功能需求
- **必须**：抓到英文字幕后立即推给前端，用户可马上观看；翻译按批次陆续补上，带进度提示。
- **必须**：每翻完一批就落盘；中途取消或崩溃，已完成的部分不丢。
- **必须**：再次打开同一视频时，从缓存秒开；缓存里有未翻/失败的句子则自动补译。
- **必须**：翻译结果按句 id 对齐合并，模型漏返或乱序时不能把中文安到错误的英文上。
- **必须**：翻译与总结使用请求里的 `model`（经 `config.resolve_model` 校验）；全局模型栏未传或选了不可用模型时回落到默认模型，缓存自愈补译与总结重生成也用同一模型。
- **应当**：抓字幕失败时给出可操作的中文原因（无字幕/地区限制/被限流），而非笼统报错。
- **必须**（M1 ⑤）：每次生成都绑定一条 `jobs` 记录（`user_id + videoId + targetLang` 未完成的复用，幂等）；每批落盘后推进 `cursor`，断线/取消落成 `partial`。
- **必须**（M1 ⑤）：`GET /api/jobs/{id}` 返回状态/进度/`canResume`；续传走 `jobId + from`，只补 `[未翻译]` 的句子，已生成的字幕不再调用模型。
- **必须**（M1 ⑤）：同一 job 的并发请求只有一条流在生成（进程内执行权），不产生额外 LLM 调用；已完成任务重连只回放。
- **应当**（M1 ⑤）：前端把 `jobId`/游标写 `sessionStorage`，刷新后先查 job 状态再决定是否重连；失败/可续时给一句中越双语提示。
- **必须**（P2-31）：翻译 prompt 使用瘦身 schema——输入 `[{"i": id, "t": text}]`（不含 `start/end`）、输出 `{"r": [{"i": id, "t": "译文"}]}`（不要求 `en_text` 回显）；`en_text/start/end` 一律由输入块回填，不信任模型改写。
- **必须**（P2-31）：解析同时兼容新 `r/i/t` 与旧 `blocks/id/en_text/zh_text`；`prompt_version` 随结构变更递增（当前 `translate.v3`），只写入缓存 payload 供追溯，不进缓存键。
- **必须**（P2-31）：新 schema 若解析出零条目（兼容端点不认 `r/i/t`），同一候选再用旧 schema 救援一次；仍零覆盖则标 `[未翻译]`，不整批换候选重发。
- **必须**（P2-31）：空/纯空白响应在同一候选内重试 1 次，仍空才换候选；JSON 完全无法解析同样同一候选重试 1 次；每批配额只在入口扣 1 次，重试/补译/降级都不重复扣。
- **必须**（P2-31）：输出 id 覆盖不足时统计缺失 id，只对缺失子集同候选补译一次（不整批重发）；补译后仍缺的块标 `[未翻译]`，交由下次加载自愈。
- **必须**（P2-31）：单批翻译有 90s deadline（`translate.TRANSLATE_BATCH_TIMEOUT_SECONDS`），超时取消当前调用并按失败进入降级链；其他 LLM 调用仍走 provider 的 180s timeout，不受影响。
- **应当**（P2-31）：Qwen 目录项用模型级 `thinking_disabled` 标记，OpenAI 兼容 payload 只对该标记发 `thinking:{"type":"disabled"}`；DeepSeek/其他 provider 不发未验证的未知参数。
- **必须**（P2-32）：缓存命中（含续传）的首屏不被教学分析阻塞——事件序固定为 `meta` 先出（不带分析）→ 需要补译时逐批 `batch` → 分析成功后一次 `batch` 回传更新后的 blocks（**无 pending 也发**）→ `summary`/`done`；分析失败只影响增强，不阻断字幕/总结/完成。
- **必须**（P2-33）：翻译按「条数 + 源 token 预算」切批（`backend/translation_batching.py`）：首批 ≤10 blocks 抢首屏，之后每批 ≤40 blocks，且单批 ≤2,000 源 token（`max(1, ceil(len/4))` 的英文近似，不是精确 tokenizer）；单条超预算仍单独成批、不丢弃，不产生空批；批序、并发、逐批落盘、progress/断点、取消与 402 语义都不变；经典路径 `_translate_video_blocks` 共用同一策略。
- **必须**（P2-34）：翻译配额按**内容量**计，不按批（`ai.quota.units_for_blocks` / `units_per_batch`）：`translate`（及 `local_show`）1 单位 = 100 blocks；一次生成的多批按累计 blocks 分配单位，合计 = `ceil(待翻 blocks/100)`，不受 P2-33 切批数影响（1,372 blocks = 14 单位，默认 60 单位内可跑完）；每批最多扣一次，落在已购单位内的批不重复扣（增量 0），重试/降级复用首次扣减；超限仍抛 `QuotaExceeded`（429）；`ai_quota` 表结构不变，旧「批」口径历史行不与新单位换算。

## 验收标准
- [ ] 给定一个有英文字幕的视频，粘贴后数秒内英文字幕可见且可播放。
- [ ] 翻译进行中，已翻句子陆续显示中文，顶部有"X/Y 句"进度。
- [ ] 翻译中途点"停止"，刷新/重开该视频，未翻句子继续被补译。
- [ ] 同一视频第二次打开为秒开（不再调用翻译）。
- [ ] 无字幕视频给出明确提示（并在装了 Whisper 时走 [008 转写回退](../008-asr-fallback/spec.md)）。
- [ ] 翻译中途断开连接：`GET /api/jobs/{id}` 返回 `partial` + 正确 `cursor`；带 `jobId + from` 续传后 `done`，provider 调用总数 = 批次数（无重复 block）。
- [ ] 刷新页面（sessionStorage 里有未完成 job）→ 自动续传；已 `done`/`failed` 的 job 不再重连。
- [ ] （P2-31）新 prompt 输入无 `start/end`、输出无 `en_text` 回显；新 `r/i/t` 与旧 `blocks/id/en_text/zh_text` 响应都能按 id 正确对齐，`en_text/start/end` 由输入回填。
- [ ] （P2-31）空响应/不可解析 JSON 各自同候选最多重试 1 次；仍失败才降级；整条重试路径只扣 1 次配额。
- [ ] （P2-31）缺失 id 只补缺失子集一次，仍缺标 `[未翻译]`；单批 90s 超时进入降级，不会挂到 180s。
- [ ] （P2-32）缓存命中且无未翻译句：`meta` 先到且不含教学分析，分析完成后用 `batch` 更新 blocks；分析慢/失败时 `meta` 仍立即返回，`summary`/`done` 不被阻断。
- [ ] （P2-33）40 块 → 10 / 30 两批（首批小、稳定批 ≤40）；长 block 让源 token 超 2,000 时提前切批；单条超预算仍单独送、不丢弃；SSE 进度/批序/断点与经典路径顺序不变。
- [ ] （P2-34）1,372-block 视频按累计 blocks 只占 14 单位（默认 60 单位内跑完，不再因批数中途 429）；20 段文章 2 单位、10 段 1 单位；重试/补缺不重复扣。

## 边界与非目标
- 只处理英文源字幕 → 中文翻译。
- 翻译质量取决于全局模型栏选中的模型（Gemini / DeepSeek，见 [010](../010-multi-provider-llm/spec.md)），本规格不负责译文润色。
- 旧的非流式端点 `POST /api/process-video` 保留，仅供移动端使用。
