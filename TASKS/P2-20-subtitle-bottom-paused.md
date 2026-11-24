# P2-20 字幕落底 0% + 暂停不落底

- status: claimed（等 P2-19 释放 App）
- owner: {implementer: lead, reviewer: lead, integrator: lead}
- base_sha: 9acbc4b

## 用户反馈
1. 落底位置：0%
2. 视频暂停时不落底

## 修复
- `DOCKED_BOTTOM` 0.5% → **0%**
- App 跟踪真实播放状态（YouTube `onPlaybackStateChange` / 本地字幕 `isSubtitlePlaying`）；暂停时取消落底计时并保持抬高；恢复播放后重新开始 4s 计时
- 指针活动在暂停时只保持抬高，不启动落底计时
- 验收：暂停等待 >4s 仍 raised；恢复播放 4s 后 docked；0% 位置

## write_scope
- `frontend/src/App.tsx`
- `frontend/src/components/WatchSubtitleOverlay.tsx`
- `frontend/src/components/WatchTopBar.tsx`（常量）
- `scripts/watch-mode-acceptance.mjs`
- `specs/044-watch-mode/spec.md`、`specs/045-watch-mode-experience/spec.md`
