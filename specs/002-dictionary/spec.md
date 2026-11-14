# 规格：点查词典

**状态：** 已实现 ｜ **对应代码：** `backend/routes_user.py`（`/api/define`）、`backend/local_dict.py`（本地词典）、`frontend/src/components/WordPopover.tsx`、`frontend/src/lib/tts.ts`

---

## 目标
消除查词的摩擦——字幕里遇到任何不认识的词，点一下就懂，不用切到别的应用。这是学习工具区别于"双语播放器"的核心交互。

## 用户故事
- 作为用户，我看字幕时遇到生词，想**点一下就看到**中文释义、音标、例句。
- 作为用户，我想**听一下**这个词怎么读。
- 作为用户，遇到重要的词想**一键存进生词本**，之后复习。

## 功能需求
- **必须**：字幕里**每个**单词（不只是 AI 预选的高亮词）都可点击。
- **必须**：弹出卡片含——单词、音标(IPA)、词性、贴合语境的中文释义、英文释义、例句。
- **必须**：释义结合该词所在句子的语境生成。
- **必须**：一个词常有多个义项，`POST /api/define` 响应在原有字段外新增 `senses` 数组，每项含 `pos` / `zh` / `definition_en`，供前端折叠展示。
- **必须**：`senses` 至少 1 条、最多 12 条；顺序按常用程度（本地词典沿用 ECDICT 原顺序，通常有词性的常见义在前；大模型按常用度排序），超过 12 条截断，避免长尾词义撑爆响应。
- **必须**：`senses[0]` 的 `pos` / `zh` / `definition_en` 与顶层同名字段完全一致（向后兼容：旧前端只读顶层字段仍然正确）；`example` / `ipa` / `lemma` 语义不变。
- **必须**：本地词典把 ECDICT `translation` 的多行/多词性（如 `n. 罩；风帽\nv. 包起来`）拆成多条 `senses`，并用 `definition` 里能按词性对齐的行补 `definition_en`，对不齐的留空字符串；顶层字段取首条。
- **必须**：大模型提示词要求返回 2–5 条常见义项（每条 `pos` / `zh` / `definition_en`，按常用度排序），并保持顶层字段 = 首条；模型漏返 `senses` 时用顶层字段自动补 1 条，不报错。
- **必须**：`dictionary_cache.json` 保存 `senses`；旧缓存没有 `senses` 时在读取时用顶层字段补 1 条，不报错、不返回空。
- **必须**：查词顺序为「语境缓存 → 本地词典 → 大模型」；本地词典命中时**不得**调用大模型，也不写语境缓存。
- **必须**：查词跟随全局模型栏：`POST /api/define` 的可选 `model` 经 `config.resolve_model` 校验后，若该模型已配 Key 则排候选链第一位；**未传或空串**时候选链首位是 `config.resolve_model(None)`（即 `DEFAULT_MODEL`，大陆默认 `deepseek-chat`），`DICT_MODEL`（`gemini-3.5-flash-lite`）只作后续候选；模型不存在或没配 Key 时安全回落到候选链，不因此 502。
- **必须**：走大模型的响应在既有字段之外带上 `model`（实际成功使用的模型 id，可能是候选链降级后的）与 `modelName`（`MODEL_CATALOG` 里的展示名）；本地词典命中不调用模型，响应带 `"source": "local"` 且不含 `model` / `modelName`；命中 `dictionary_cache.json` 时也不声称本次用了模型（`model` 字段不写入缓存、不回填）。既有字段保持不变。
- **必须**：本地词典是可选数据（ECDICT，`data/ecdict.db`，见 [backend/README.md](../../backend/README.md)）：没装、损坏或条目无中文释义时，优雅回落到大模型，不报 500。
- **必须**：同一个词只调一次 AI，之后从缓存返回（[宪法原则 4](../../CONSTITUTION.md)）。
- **必须**：卡片内可朗读单词与例句、可一键加入/移出生词本。
- **应当**：卡片默认显示首条义项，其余义项折叠、可展开查看（前端）。
- **应当**：卡片自动避让，始终留在视口内。

## 验收标准
- [ ] 点击字幕中任意单词，弹出释义卡（音标 + 中文释义 + 例句）。
- [ ] 点扬声器图标能朗读该词。
- [ ] 点星标把该词存入收藏（生词类型，带来源句与时间点）。
- [ ] 同一个词第二次点击，立即返回（命中缓存）。
- [ ] 词典数据缺失时点词仍能正常出释义（走大模型），不出现 500。
- [ ] 查 `right` 这类多义词时返回多条 `senses`，首条与顶层 `pos` / `zh` / `definition_en` 一致。
- [ ] 旧版 `dictionary_cache.json`（无 `senses`）仍能正常返回，且自动补 1 条义项。
- [ ] `POST /api/define {"word":"ultracrepidarian"}`（不带 `model`）实际使用 `deepseek-chat`（`DEFAULT_MODEL`），响应里的 `model` / `modelName` 与之对应。
- [ ] 同一请求带 `{"model":"deepseek-chat"}` 时实际使用 DeepSeek，并报告该模型。
- [ ] 本地词典命中（如 `hello`）不调用任何模型，响应带 `source: local`、不带 `model`。

## 边界与非目标
- 释义来源：优先本地 ECDICT 离线词典（静态词义，秒回、免费），未命中时由大模型生成（Gemini 或 DeepSeek，见 [010](../010-multi-provider-llm/spec.md)）；不调用任何在线词典 API。
- 本地词典数据不随仓库分发，许可证说明见 [backend/README.md](../../backend/README.md)。
- 缓存按小写单词去重，不区分大小写；同词不同语境复用首次释义。
- 词典跟随全局模型栏：请求指定且已配 Key 的模型优先；**缺省（未传/空串）时首选 `DEFAULT_MODEL`**，再按「`gemini-3.5-flash-lite` → `DICT_FALLBACK_MODEL`（即 `DEFAULT_MODEL`，按序去重）→ `MODEL_CATALOG` 其余可用模型」候选链兜底。`dictionary_cache.json` 按小写词缓存、与模型无关，换模型不会让已缓存的词重新生成；缓存本身不记录生成模型（缓存 model 标记语义另行决定）。
