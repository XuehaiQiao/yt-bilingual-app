# 规格：字幕流式管线

**状态：** 已实现 ｜ **对应代码：** `backend/routes_videos.py`（`process_video_stream`）、`backend/translate.py`（`_stream_translate` 等）、`backend/jobs.py` + `backend/migrations/versions/0005_jobs.py`（任务表/续传，M1 ⑤）、`frontend/src/lib/transcript.ts`、`frontend/src/lib/jobs.ts`、`frontend/src/App.tsx`、`frontend/src/components/ModelBar.tsx`

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

## 验收标准
- [ ] 给定一个有英文字幕的视频，粘贴后数秒内英文字幕可见且可播放。
- [ ] 翻译进行中，已翻句子陆续显示中文，顶部有"X/Y 句"进度。
- [ ] 翻译中途点"停止"，刷新/重开该视频，未翻句子继续被补译。
- [ ] 同一视频第二次打开为秒开（不再调用翻译）。
- [ ] 无字幕视频给出明确提示（并在装了 Whisper 时走 [008 转写回退](../008-asr-fallback/spec.md)）。
- [ ] 翻译中途断开连接：`GET /api/jobs/{id}` 返回 `partial` + 正确 `cursor`；带 `jobId + from` 续传后 `done`，provider 调用总数 = 批次数（无重复 block）。
- [ ] 刷新页面（sessionStorage 里有未完成 job）→ 自动续传；已 `done`/`failed` 的 job 不再重连。

## 边界与非目标
- 只处理英文源字幕 → 中文翻译。
- 翻译质量取决于全局模型栏选中的模型（Gemini / DeepSeek，见 [010](../010-multi-provider-llm/spec.md)），本规格不负责译文润色。
- 旧的非流式端点 `POST /api/process-video` 保留，仅供移动端使用。
