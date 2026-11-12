# 规格：多模型接入（Gemini / DeepSeek）

**状态：** 已实现 ｜ **对应代码：** `backend/llm.py`、`backend/config.py`（`MODEL_CATALOG`）、`backend/translate.py`、`backend/routes_user.py`、`backend/routes_videos.py`（`/api/models`、`/api/estimate-cost`）、`frontend/src/components/ModelBar.tsx`、`frontend/src/lib/settings.ts`

---

## 目标
把"翻译 / 总结 / 查词"背后的模型从"只认 Gemini"变成"可替换"：用户配了哪家的 Key，就能选哪家的模型，换厂商不用改代码。

## 用户故事
- 作为用户，我想在模型选择里看到**我配了 Key** 的模型；没配 Key 的置灰，并直接告诉我缺哪个环境变量。
- 作为用户，我想用 DeepSeek 做翻译/总结，体验和 Gemini 一致：英文先出、译文逐批补、中断能续。
- 作为开发者，我想加一家新厂商只改配置（`MODEL_CATALOG`），不碰调用点。

## 功能需求
- **必须**：`MODEL_CATALOG` 是唯一模型清单，驱动前端选择器、请求校验、成本估算。
- **必须**：模型选择是全局的——首页顶部的「模型」栏（数据源 `GET /api/models`）保存并展示当前模型，翻译、总结、本地剧集、查词典都跟随它；不再按视频逐次选模型。
- **必须**：支持两类 provider——`google`（google-genai SDK）与 `openai_compatible`（`<base_url>/chat/completions`，覆盖 DeepSeek / OpenAI / Qwen / Kimi / GLM / Ollama 等）。
- **必须**：翻译、总结、词典三条链路都走 `llm.py` 统一适配层，调用点不再直接 import 厂商 SDK。
- **必须**：批间停顿按 provider 配置（Gemini 免费档 15 RPM → 4 秒；DeepSeek → 1 秒）。
- **必须**：未配置 Key 的模型 `available=false`，前端置灰不可选，文案显示缺哪个环境变量。
- **必须**：词典按"已配置 Key 的候选清单"依次尝试，只有 DeepSeek Key 也能查词。
- **应当**：单价未知时成本显示"待定"，不填猜测值。

## 验收标准
- [ ] 只配 `GEMINI_API_KEY`：模型选择里 Gemini 三档可选，DeepSeek 置灰并提示 `需要配置 DEEPSEEK_API_KEY`。
- [ ] 两个 Key 都配：四个模型全部可选，`/api/estimate-cost` 返回的 `available` 与 Key 一致。
- [ ] 选 DeepSeek 处理一个短视频：双语字幕、高亮、总结结构与 Gemini 结果一致。
- [ ] 模型返回 401/404/429：该批走原有降级/重试逻辑，`[未翻译]` 自愈闭环不被破坏。
- [ ] 词典在只有 DeepSeek Key 时仍返回 JSON 卡片；同词第二次命中缓存、不再请求。

## 边界与非目标
- 不内置本地模型下载；Ollama 之类只要暴露 OpenAI 兼容端点，加一条目录配置即可接入。
- 翻译缓存仍以视频为键（`history/*.json`），**不按模型区分**：同一视频换模型不会自动重译，需重新处理。
- 不做自动故障转移：选中的模型失败照原有逻辑降级，不偷偷换厂商。
- 不保证各厂商 JSON 合规性一致；解析仍靠"按 id 对齐 + 缺失标 `[未翻译]`"兜底。
