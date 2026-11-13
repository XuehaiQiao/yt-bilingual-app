# 规格：本地剧集

**状态：** 已实现 ｜ **对应代码：** `backend/transcripts.py`（`parse_srt`、`group_srt_blocks`）、`backend/routes_content.py`（剧集路由）、`backend/local_shows.py`（`episodes.json` 视频映射）、`backend/routes_videos.py`（历史缓存补全）、`scripts/import_playlist.py`（映射落盘）、`frontend/src/components/ShowBrowser.tsx`

---

## 目标
不止 YouTube——让用户用同一套双语学习体验刷自己的剧（美剧、纪录片等），只要有 SRT 字幕。
当某一集能对应到 YouTube 视频时，额外带上真实 `videoId`，前端即可复用「看视频」同款播放器；没有对应视频的集保持纯字幕体验。

## 用户故事
- 作为用户，我想把自己的 `.srt` 字幕放进项目，就能**双语看这部剧**。
- 作为用户，我想按**剧 → 季 → 集**浏览选择。
- 作为用户，如果某一集有对应的 YouTube 视频，我想直接在本地剧集页用视频播放器看，字幕照旧双语。

## 功能需求
- **必须**：识别 `subtitles/<剧名>/S01/E01.srt` 这种目录结构，列出可用的剧、季、集。
- **必须**：处理某一集时，复用与 YouTube **完全相同**的翻译、生词高亮、缓存逻辑。
- **必须**：`subtitles/<show_id>/episodes.json` 保存集 → YouTube 视频映射，格式 `{"S01E01": {"videoId": "3dT8Wm5oI_o", "title": "Lecture 1: ..."}, ...}`（键用 `S%02dE%02d`）。
- **必须**：`backend/local_shows.py` 提供 `episode_video_map(show_id)` 与 `lookup_episode_video(show_id, season, episode)`，由 `routes_content` 与 `routes_videos` 共用；文件缺失/损坏/单条非法都降级为「无映射」并打日志，读取路径限制在 `SUBTITLES_DIR` 内（拒绝 `..`、路径分隔符与符号链接越界）。
- **必须**：`POST /api/process-subtitle` 返回的 `payload.metadata` 在该集有映射时增加 `youtube_video_id`（string）；映射里有标题时再增加 `youtube_title`。**缓存命中也要补上**：每次从 `episodes.json` 现取，不要求重写缓存文件；即使缓存里留着旧 id，返回的也是映射里的新值。
- **必须**：`GET /api/history/{filename}` 对本地剧集缓存（`metadata.is_local_subtitle` 为 `true`）做同样的 metadata 补全；普通 YouTube 缓存的行为与返回内容不变。
- **必须**：`scripts/import_playlist.py` 每次运行都根据 yt-dlp 播放列表写/更新 `episodes.json`，与 SRT 是否已存在无关；幂等——保留已有正确映射，同一集视频变动时以新播放列表为准，`--limit` 之外的已有映射不丢。
- **必须**：本地剧集跟随全局模型栏：`POST /api/process-subtitle` 的可选 `model` 经 `config.resolve_model` 校验，翻译与已缓存集的补译都用该模型；未传、非法或没配 Key 时回落到默认模型。
- **必须**：`POST /api/process-subtitle` 新处理的返回结果与缓存 payload 带 `model`（`config.resolve_model` 后的 id），供历史列表显示本地剧集用的模型。命中缓存时返回缓存里记录的模型（生成时实际使用的），不因本次请求换了模型而覆盖；旧缓存没有该字段时如实留空，只有本次确实用该模型补译过失败块，才补记本次模型。
- **必须**：批与批之间用 `llm.batch_pause(model)` 按 provider 的限流节奏停顿（Gemini 4s、DeepSeek 1s），不再固定 `asyncio.sleep(6)`。
- **必须**：已处理的集标记出来，再次打开秒开。
- **必须**：没有视频映射的本地剧集无真实播放器，用计时器模拟播放进度以驱动字幕同步；有映射的集前端用 `youtube_video_id` 复用「看视频」同款播放器。

## 验收标准
- [ ] 把 `subtitles/<剧>/S01/E01.srt` 放好后，首页"本地剧集"能看到这部剧。
- [ ] 选剧 → 选季 → 选集，处理后得到与 YouTube 一致的双语字幕。
- [ ] 有 `episodes.json` 的剧集，`process-subtitle` 新处理与缓存命中的 `metadata` 都带 `youtube_video_id`；没有映射时 payload 形状不变。
- [ ] `GET /api/history/{filename}` 对本地剧集缓存补全 `youtube_video_id`，对普通 YouTube 缓存无影响。
- [ ] `episodes.json` 缺失或损坏时接口不报错，按纯字幕剧集继续工作。
- [ ] 已处理的集有标记，再次打开为秒开。
- [ ] 处理过的本地剧集在历史列表里显示实际使用的模型名；换一个模型重新打开已处理的集，不会改掉它的模型标记。
- [ ] 用 DeepSeek 处理多批字幕时批间隔为 1s，而不是固定的 6s。

## 边界与非目标
- 只解析 SRT 格式。没有视频映射的剧集不内置视频画面（仅字幕 + 模拟时间轴）；有映射的集播放的是 `episodes.json` 指向的 YouTube 视频，视频本身不下载、不入库。
- `episodes.json` 是可选的旁路文件：没有它时所有接口的行为与本次改动前完全一致。
- 映射每次请求现读 `episodes.json`（不在进程内长期缓存），导入脚本更新后无需重启后端；命中缓存时补全只改响应，不重写 `history/` 里的缓存文件。
- 本地剧集的 `summary` 是固定集名标签（如 `📺 纸牌屋 第1季 第1集`），不是大模型生成的总结，因此不受模型选择影响。
- 缓存里的 `model` 记录「生成这批翻译时实际使用的模型」；旧缓存（无该字段）不被臆测回填，历史列表按"未记录"显示。
- `subtitles/` 内容不入库（版权，见 [宪法原则 6](../../CONSTITUTION.md) 与 `.gitignore`）。
