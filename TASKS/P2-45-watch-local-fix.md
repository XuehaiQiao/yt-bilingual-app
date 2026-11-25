# P2-45 观影模式修复：v1.0 缓存黑屏 + 本地视频支持

- status: claimed
- owner: watch-fix-impl
- base_sha: e50cecf

## 问题
1) v1.0 已有缓存的视频，在 v1.1 打开观影模式会黑屏
2) 本地视频没有观影模式

## 要求
1) 找出 v1.0 缓存 payload 与 v1.1 观影模式的兼容缺口并修复；不得要求用户重新翻译/清缓存
2) 本地视频（有本地媒体文件，hasLocalVideo）支持观影模式；纯字幕本地剧集是否支持按现有契约判断，至少不回归
3) 保留：YouTube 观影模式、字幕 dock、滚动 gloss、分屏比例、全屏、退出/返回、SSE/缓存历史
4) 覆盖桌面 1440；不碰移动端重构
5) 回归 watch-mode-acceptance、p0-04 等相关脚本

## write_scope
- frontend/src/App.tsx
- frontend/src/components/VideoPlayer.tsx
- frontend/src/components/WatchTopBar.tsx
- frontend/src/components/WatchSubtitleOverlay.tsx
- frontend/src/components/LocalVideoLearning.tsx / LocalVideoShelf.tsx（如涉及）
- frontend/src/lib/history.ts（如涉及）
- scripts/watch-mode-acceptance.mjs / scripts/local-video-*.mjs
- backend/tests（仅如缓存契约需调整）
- specs/044/045

## acceptance
- v1.0 缓存视频开观影模式不再黑屏，能播放/字幕/gloss
- 本地视频可进/退出观影模式，控件不重叠
- 旧 YouTube 行为零回归
