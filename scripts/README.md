# scripts/ — 开发者工具

与产品运行无关的辅助脚本。首次使用先 `npm install`。

| 文件 | 用途 |
|---|---|
| `backup.sh` | 离机备份：优先 `sqlite3 .backup` 做 WAL 安全快照（无 sqlite3 时退化为文件复制并警告），打包 `app.db` + `users/` + 配置键名到 `backups/linguatrek-backup-YYYYmmdd-HHMMSS.tar.gz`，默认保留 7 份（`--keep N`）。不备份 `.env`、不打印密钥。用法与定时任务见 [docs/运行手册.md](../docs/运行手册.md) |
| `restore.sh` | 从备份包恢复并校验：`SHA256SUMS` + `PRAGMA integrity_check` + 表清单/用户数/`users` 文件数/聚合哈希；默认恢复到临时目录，拒绝非空目标（`--force` 会把旧数据移到 `.pre-restore-*`） |
| `restore_drill.sh` | 恢复演练：备份 → 临时恢复 → 与源数据对比（表/用户/文件/哈希）→ 清理；输出 PASS/FAIL + 耗时，退出码非 0 即失败。支持 `--data-dir`、`--keep-temp` |
| `capture.mjs` | 重录 README 的全部动图与截图：`APP_URL=http://localhost:5173 node capture.mjs all`（可单录 `hero/learning/dictionary/dictation/mobile/stills`）。Playwright 驱动系统 Chrome 截帧 + gifenc 纯 JS 编码，无需 ffmpeg。注意：YouTube 播放依赖系统 Chrome（Playwright 自带 Chromium 缺编解码器） |
| `download_subtitles.py` | 从 OpenSubtitles 批量下载剧集 SRT 到 `subtitles/`（需 API key，见文件头注释） |
| `import_playlist.py` | 把一个 YouTube 播放列表的英文字幕导入为本地剧集（字幕为主，可带对应 YouTube 视频）：`backend/venv/bin/python scripts/import_playlist.py --playlist-url "<播放列表 URL>"`。按播放列表顺序写入 `subtitles/<show_id>/S01/E01.srt`，并生成/更新 `episodes.json`（集 → 真实 `videoId` 映射，供 App 复用 YouTube 播放器）与 `meta.json`（标题/封面）；映射每次运行都更新，与 SRT 是否已存在无关且幂等。`--limit N` 试跑前 N 集、`--force` 覆盖、`--dry-run` 只看计划。单集失败不中断并打印原因。只拉字幕，不下载视频、不翻译、不调用模型。字幕仅供自用，`subtitles/` 已 gitignore 不入库 |
| `ingest_youtube.py` | 离线把 YouTube 视频解析进 `history/`：字幕走 yt-dlp（`youtube-transcript-api` 被限流时的备用通路），复用后端的 `group_transcript_blocks` 分句，产出与流式端点同构的英文骨架 + 翻译工单。用法见文件头注释 |
| `merge_translations.py` | 把 `history/.work/<videoId>/out_*.json` 的译文按 id 合并回 history 缓存，顺带体检：高亮必须是精确子串，可疑译文退回 `[未翻译]` 让 App 自动补译 |
| `package.json` | 本目录的独立依赖（playwright / gifenc / pngjs） |
| `fetch_dictionary.py` | 下载 ECDICT（英汉词典，约 77 万词条）并构建本地词典 `data/ecdict.db`：`python3 scripts/fetch_dictionary.py`（幂等，已有则跳过；许可证与数据来源见 [backend/README.md](../backend/README.md#本地词典可选ecdict)）。不装也能跑，查词走大模型 |
