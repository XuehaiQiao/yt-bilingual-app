# scripts/ — 开发者工具

与产品运行无关的辅助脚本。首次使用先 `npm install`。

| 文件 | 用途 |
|---|---|
| `backup.sh` | 离机备份：优先 `sqlite3 .backup` 做 WAL 安全快照（无 sqlite3 时退化为文件复制并警告），打包 `app.db` + `users/` + 配置键名到 `backups/linguatrek-backup-YYYYmmdd-HHMMSS.tar.gz`，默认保留 7 份（`--keep N`）。不备份 `.env`、不打印密钥。用法与定时任务见 [docs/运行手册.md](../docs/运行手册.md) |
| `restore.sh` | 从备份包恢复并校验：`SHA256SUMS` + `PRAGMA integrity_check` + 表清单/用户数/`users` 文件数/聚合哈希；默认恢复到临时目录，拒绝非空目标（`--force` 会把旧数据移到 `.pre-restore-*`） |
| `restore_drill.sh` | 恢复演练：备份 → 临时恢复 → 与源数据对比（表/用户/文件/哈希）→ 清理；输出 PASS/FAIL + 耗时，退出码非 0 即失败。支持 `--data-dir`、`--keep-temp` |
| `preflight-production.sh` | 生产上线只读预检：DNS、22/80/443 TCP、HTTPS、`/healthz`、安全头、www 301、G1 401/200；`--netrc` 可验证带凭据的 200。不 SSH、不写服务器、不执行部署；离线时明确失败。用法见 [部署执行手册](../docs/部署执行手册-linguatrekai.online.md) |
| `check-alerts.py` | `/healthz` 外部巡检 → 飞书 P0（M5，specs/035）：连续 N 次失败才告警，计数/重复间隔存 `data/alerts/health_state.json`；`--dry-run` 只看不写、`--self-test` 离线验证 payload/签名、`--event backup_failed ...` 主动上报其它事件。cron 模板见 `deploy/alert-check.cron`；不打印 webhook/secret |
| `verify-difficulty.mjs` | CEFR M2 前端验收（specs/026）：Playwright 打开 `APP_URL`（默认 `http://127.0.0.1:5199`），mock `/api/content/difficulty/batch`，断言「为你推荐 / 免费资源」卡片显示难度徽章与「生词约 X%」，且用户可见文案不含「个性化」；截图写 `data/reports/difficulty-web.png`。需先 `npm ci`（playwright + 系统 Chrome channel）并启动前端 dev server |
| `build_books.py` | 构建期生成公版书中文译文（一次性）：读 `content/books/books.json`，按 `sourceUrl` 抓取 Project Gutenberg 原文（主站维护时回退 PGLAF 镜像），用 `backend/llm.py` 分批翻译并写 `content/books/<book>/chapters/<n>.zh.json`；**只写中译文，不存英文原文**，记录 prompt 版本/模型/生成时间。默认跳过完整译文，`--force` 重译、`--only`/`--chapters` 限定范围、`--dry-run` 只看计划（需 .env 模型 Key） |
| `verify-books.mjs` | 公版书前端验收（Playwright，全 API mock）：3 个系列、39 本书、章节切换、译文切换、点词查词、游客可用、375px 无横向溢出、中/越 UI；截图写 `/tmp/books-shots/`。用法：`APP_URL=http://127.0.0.1:5199 node verify-books.mjs`（需先 `npm ci`） |
| `reader-layout-test.mjs` | 阅读器取词 + 左右对照验收（Playwright，全 API mock）：自创/免费/公版书/导入书点词出卡、source 元数据、1440/1024 左英右中同段同行、375 上下布局、仅原文单栏、翻译/进度/段落分享回归；截图写 `/tmp/reader-layout-shots/`。用法：`cd scripts && node reader-layout-test.mjs`（需前端 dev server，默认 `APP_URL=http://127.0.0.1:5173/`） |
| `verify-telemetry.mjs` | CEFR M2 #7 行为埋点前端验收（Playwright）：mock `/api/events` 与 `/api/define`，驱动点词、倍速、回退与 hidden/visible，断言 4 类事件 payload 与匿名 sessionId；再用事件 API 503 证明查词/倍速不被埋点中断。需后端 8001 跑 0017 迁移、前端 `VITE_API_BASE=http://127.0.0.1:8001`；截图/事件 JSON 写 `/tmp/m2-telemetry-shots/` |
| `capture.mjs` | 重录 README 的全部动图与截图：`APP_URL=http://localhost:5173 node capture.mjs all`（可单录 `hero/learning/dictionary/dictation/mobile/stills`）。Playwright 驱动系统 Chrome 截帧 + gifenc 纯 JS 编码，无需 ffmpeg。注意：YouTube 播放依赖系统 Chrome（Playwright 自带 Chromium 缺编解码器） |
| `download_subtitles.py` | 从 OpenSubtitles 批量下载剧集 SRT 到 `subtitles/`（需 API key，见文件头注释） |
| `import_playlist.py` | 把一个 YouTube 播放列表的英文字幕导入为本地剧集（字幕为主，可带对应 YouTube 视频）：`backend/venv/bin/python scripts/import_playlist.py --playlist-url "<播放列表 URL>"`。按播放列表顺序写入 `subtitles/<show_id>/S01/E01.srt`，并生成/更新 `episodes.json`（集 → 真实 `videoId` 映射，供 App 复用 YouTube 播放器）与 `meta.json`（标题/封面）；映射每次运行都更新，与 SRT 是否已存在无关且幂等。`--limit N` 试跑前 N 集、`--force` 覆盖、`--dry-run` 只看计划。单集失败不中断并打印原因。只拉字幕，不下载视频、不翻译、不调用模型。字幕仅供自用，`subtitles/` 已 gitignore 不入库 |
| `ingest_youtube.py` | 离线把 YouTube 视频解析进 `history/`：字幕走 yt-dlp（`youtube-transcript-api` 被限流时的备用通路），复用后端的 `group_transcript_blocks` 分句，产出与流式端点同构的英文骨架 + 翻译工单。用法见文件头注释 |
| `merge_translations.py` | 把 `history/.work/<videoId>/out_*.json` 的译文按 id 合并回 history 缓存，顺带体检：高亮必须是精确子串，可疑译文退回 `[未翻译]` 让 App 自动补译 |
| `package.json` | 本目录的独立依赖（playwright / gifenc / pngjs） |
| `build_wordlist.py` | 构建自建英语频表（M2）：wordfreq 3.1.1（数据 CC BY-SA 4.0）→ 10,000 lemma × 10 个千词频带 + lemma forms + CEFR 锚点；产物写 `content/wordlist/frequency_bands.v1.json` + `SHA256SUMS`。`--check` 只校验已提交产物（离线，CI 用）；`--freq-tsv` 支持离线快照（测试用）。许可/局限见 `content/wordlist/NOTICE.md` |
| `build_word_lists.py` | 构建单词本词表：读 ECDICT 官方 `ecdict.csv` 的 `tag` 列（GRE/CET4/CET6）+ `frq`/`bnc` 排序 + 音标/首行中文释义，写 `content/wordlists/exam-bands.v1.json`、`lexicon.v1.json`、`SHA256SUMS`；CEFR A1–C1 仍由 `build_wordlist.py` 的频表派生，**不提交 60MB CSV**。`--check` 离线校验结构/完整性/频表覆盖；给 `--ecdict-csv` 做完整重建对比。许可/近似口径见 `content/wordlists/NOTICE.md` |
| `check_placement_bank.py` | 定位测题库质量校验（M2）：Form A/B 各 64 题（40 真词 + 4 伪词 = 44 词汇槽 + 20 阅读 = 4 篇 × 5 题）、A1–C1 带覆盖、选项/答案合法、10 道共享锚题跨套同题同参数、伪词未入仓库词表、样卷 24+3+5 且含锚题。报告写 `docs/reports/placement-items-2026-11-17.json`；**p 值全部 null（pending pilot），不生成伪造统计量**。`--check` 只校验不写；退出码 0/1/2。用法见 [content/placement/README.md](../content/placement/README.md) |
| `fetch_curated_subtitles.py` | 构建期抓取 30 条 curated 视频英文字幕到 `data/curated-subtitles/`（gitignored，不随仓库分发）；人工字幕优先、自动字幕回退，记录 `subtitleSource` 供难度管线降级句法字段。需联网 + yt-dlp，幂等（`--refresh` 强制重抓） |
| `backfill_content_difficulty.py` | 回填 `content_difficulty`（M2）：70 条 serving（3 视频 + 67 文章）+ 30 条 curated = 100 条；幂等 upsert、输出覆盖率/按 kind/band 分布/失败原因，报告写 `data/reports/`（gitignored）。`--dry-run` 只算不写 |
| `build_cefr_anchor_adjudication.py` | 生成 CEFR M2 锚校准的 15 条相邻带分歧仲裁包（`docs/reports/cefr-anchor-adjudication-2026-11-17.md`）+ 空白仲裁表（`…-sheet-…csv`，15 行）。只读 truth / 盲评包 / 两张评审答案表；**结构上不写 autoBand 与 editorialBand**（防锚定），退出前对每个条目块做机器断言（条目块内 band 名 ⊆ 该条 A/B 两带、无禁用字样、摘录 ≤120 词、表全空）。`--check` 只断言不写文件；输出确定性 |
| `build_cefr_anchor_book_review.py` | 生成公版书锚复核报告（`docs/reports/cefr-anchor-public-domain-review-2026-11-17.md`）：13 条公版书节选 + 9 条 holdout 文章的「编辑 / 人工共识 / difficulty.v1」三列对照与差异，标出「编辑偏低」候选（确认型 4 条、待仲裁 4 条）。只读 truth + 答案表；**不改任何标注、不碰 `content/books/`**；一致才叫共识，分歧写「待仲裁」 |
| `recompute_cefr_anchor.py` | 按仲裁后的 CSV 重算 QWK/未加权 κ、±1、Wilson CI、holdout 与调参集，并按复核计划门槛给 PASS/FAIL。**空表或只填一部分 → `status=pending`/`partial_adjudication`，`metrics=null`，不伪造**；只写 `docs/reports/cefr-anchor-recalibration-2026-11-17.json`，不改 `difficulty.py` 阈值。用法：`backend/venv/bin/python scripts/recompute_cefr_anchor.py [--adjudication CSV] [--dry-run]` |
| `fetch_dictionary.py` | 下载 ECDICT（英汉词典，约 77 万词条）并构建本地词典 `data/ecdict.db`：`python3 scripts/fetch_dictionary.py`（幂等，已有则跳过；许可证与数据来源见 [backend/README.md](../backend/README.md#本地词典可选ecdict)）。不装也能跑，查词走大模型 |
