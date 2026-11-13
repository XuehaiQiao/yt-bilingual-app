# backend/ — FastAPI 后端

启动：`source venv/bin/activate && uvicorn main:app --port 8000`（入口永远是 `main:app`）。
验证：`venv/bin/python -m py_compile *.py`；离线测试：`venv/bin/python -m pytest tests -q`（测试全程离线、不联网）。环境变量见 [开发指南](../docs/开发指南.md)。

## 文件说明

| 文件 | 职责 |
|---|---|
| `main.py` | 应用装配：CORS、`X-API-Key` 鉴权中间件、挂载三个路由模块、`/health`。**不放业务逻辑** |
| `config.py` | 所有配置：`.env` 加载、数据目录（HISTORY/SUBTITLES/SENTENCES）、安全开关、`MODEL_CATALOG`（可选模型清单：provider / 端点 / Key 环境变量 / 价格 / 批间节奏）、`VOCAB_LEVELS`（词汇水平→prompt 描述） |
| `llm.py` | 统一大模型调用层：按 `MODEL_CATALOG` 的 `kind` 分派「Google 官方 SDK」或「OpenAI 兼容 `<base_url>/chat/completions`」，并提供 `is_available`（有没有 Key）与 `batch_pause`（按厂商限流节奏） |
| `transcripts.py` | 拿到"待翻译的句子"：YouTube 字幕抓取（失败→清晰中文错误）、切句算法、SRT 解析、yt-dlp 元数据、Whisper 本地转写兜底（可选依赖） |
| `translate.py` | AI 翻译核心：`process_llm_batch`（大模型批翻 + **按 id 对齐**防错位 + 按水平挑生词）、`UNTRANSLATED_MARKER` 自愈约定、`retranslate_marked_blocks`（补译）、`_stream_translate`（逐批落盘的流式生成器）、视频总结 |
| `routes_videos.py` | `/api/models`（全局模型栏数据源）、`/api/estimate-cost`、`/api/process-video`（经典，移动端用）、`/api/process-video-stream`（SSE，产品核心）、`/api/history*`（本地剧集缓存按 `episodes.json` 补 `youtube_video_id`）、`/api/channel-updates` |
| `routes_content.py` | `/api/shows*`、`/api/process-subtitle`（本地剧集：翻译与补译跟随请求 `model`，新处理结果与缓存 payload 记录 `model`，批间隔按 `llm.batch_pause(model)`；有视频映射的集在 `metadata` 补 `youtube_video_id` / `youtube_title`）、`/api/sentences*`（句子精背） |
| `local_shows.py` | 本地剧集 → YouTube 视频映射：`episode_video_map(show_id)` / `lookup_episode_video(show_id, season, episode)` 读取 `subtitles/<show_id>/episodes.json`；缺失/损坏一律降级为无映射并打日志，路径限制在 `SUBTITLES_DIR` 内 |
| `local_dict.py` | 本地离线词典（可选）：`lookup()` 查 `data/ecdict.db`（ECDICT）并映射成 `/api/define` 字段（含多义项 `senses`，`definition` 按词性对齐补英文释义）；惰性只读 sqlite，数据缺失/损坏一律返回 `None`，调用方回落大模型 |
| `routes_user.py` | `/api/define`（词典：`dictionary_cache.json` 语境缓存 → 本地词典 → 「已配 Key 的候选模型」；缺省 `model` 时候选链首选 `DEFAULT_MODEL`；走 LLM 的响应带实际使用的 `model` / `modelName`，本地命中带 `source: local`；模型结果写缓存并带 `senses`，旧缓存读取时自动补全）、`/api/favorites`、`/api/subscriptions` |
| `requirements.txt` | Python 依赖（faster-whisper 为可选，见文件内注释） |

## 本地剧集视频映射（episodes.json）

如果一部本地剧集的每一集能对应到 YouTube 视频，导入脚本会在 `subtitles/<show_id>/episodes.json` 写映射：

```json
{"S01E01": {"videoId": "3dT8Wm5oI_o", "title": "Lecture 1: Introduction to China's History"}}
```

- 由 `scripts/import_playlist.py` 每次运行生成/更新（与 SRT 是否已存在无关；幂等，保留已有正确映射，同一集视频变动时以新列表为准）。
- `backend/local_shows.py` 是唯一读取入口，`routes_content` 与 `routes_videos` 共用；文件缺失/损坏时按「无映射」处理并打日志，不报错。
- `POST /api/process-subtitle` 新处理与缓存命中都会在 `metadata` 补 `youtube_video_id`（有标题时再补 `youtube_title`）；`GET /api/history/{filename}` 对 `metadata.is_local_subtitle` 为 `true` 的缓存做同样补全，普通 YouTube 缓存不变。
- 补全只改响应，不重写 `history/` 里的缓存文件（即使缓存里留着旧 id，响应也以 `episodes.json` 为准）；没有映射的剧集完全按纯字幕 + 模拟时间轴工作。

## 本地词典（可选，ECDICT）

查词默认**先查本地词典、再调大模型**：本地命中直接返回（秒回、零模型成本），未命中才走原来的模型候选链。**不装词典也能跑**，行为与以前完全一致。

```bash
# 仓库根目录执行：下载 ECDICT CSV（约 63 MB）并构建 data/ecdict.db（约 104 MB，77 万词条）
python3 scripts/fetch_dictionary.py
```

- 运行时路径：默认 `data/ecdict.db`，可用环境变量 `LOCAL_DICT_PATH` 覆盖（相对路径按进程工作目录解析，建议绝对路径）。
- 也兼容 ECDICT 官方 sqlite 版：把 `ecdict-sqlite-28.zip` 里的 `stardict.db` 直接放成 `data/ecdict.db` 即可（查询只依赖 `stardict` 表的 `word/sw/phonetic/definition/translation/exchange` 列）。
- 脚本幂等（已有且校验通过就跳过，`--force` 重建）、带进度、失败会清理临时文件并提示手动下载命令；支持 `--csv` / `--dest` / `--keep-csv`。

### 许可证（重要）

- **ECDICT 仓库代码**：MIT License，Copyright (c) 2025 Linwei（见上游 `LICENSE`）。
- **词典数据**：作者在 README 里说明，数据由 EDictAZ、四六级/GRE 词表、`cdict-1.0-1.rpm`、BNC 语料库等多来源逐步整理，**各来源授权状况不一**，MIT 不能简单覆盖全部数据。
- 因此本项目**不打包、不提交**词典数据：`data/` 已加入 `.gitignore`，只有 `scripts/fetch_dictionary.py` 在本机按需下载。自用无额外负担；**对外分发/商用前请自行复核 ECDICT 的数据授权**。

### 字段映射与已知限制

| `/api/define` 字段 | 本地词典来源 |
|---|---|
| `word` / `lemma` | 词条；`lemma` 取 `exchange` 的 `0:` 项（如 `running` → `run`） |
| `ipa` | `phonetic`，自动补 `/.../` |
| `pos` / `zh` / `definition_en` | **首条**义项的词性 / 中文释义 / 英文释义 |
| `senses` | `translation` 每行一个义项（含 `pos` / `zh` / `definition_en`），保持 ECDICT 原顺序，最多 12 条；`definition` 里按词性对齐的行补 `definition_en`，对不齐为空字符串 |
| `example` | 无（固定空字符串） |

- 没有例句：ECDICT 不提供，卡片里例句区直接不显示。
- 音标是 ECDICT 旧式记法（如 `hә'lәu`），不是严格 IPA，只作读音提示。
- 释义是静态词义、不结合语境；多义词返回多条 `senses`（首条与顶层字段一致），超过 12 条截断；语境释义仍由大模型在未命中时生成。
- 无中文释义的条目视为未命中，交给大模型补中文（查词卡片的目标读者是中文用户）。ECDICT 里约 0.16% 词条的 `translation` 其实是英文转写，同样按未命中处理。
- 本地命中的释义**不会**写进 `dictionary_cache.json`——那里只存大模型生成的语境释义，避免两类释义混用。

## 关键约定

- 持久化以 `history/` 下的 JSON 文件为主（无数据库）；本地词典数据是可选的 `data/ecdict.db`（gitignore，不入库）。
- 翻译失败的句子标 `[未翻译]`，下次加载自动补译——改动翻译逻辑时**不要破坏这个自愈闭环**。
- 对应规格：流式管线见 [specs/001](../specs/001-streaming-pipeline/spec.md)，各路由的行为定义见 [specs/](../specs/README.md)。
