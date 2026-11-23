# P2-11 观影字幕字号随视频窗缩放

- status: pending（等 P2-10 释放 VideoPlayer/媒体区）
- owner: {implementer: TBD, reviewer: lead, integrator: lead}
- base_sha: dffc7e6

## 背景
项目没有独立「弹幕」功能；用户指的是观影模式的**单句字幕窗**。当前字号固定（英 17px / 中 15px），视频窗放大/全屏时显得偏小。

## goal
字号按**视频窗宽度**（容器查询）流体缩放，而不是固定 px 或全页视口：
- 英文：`clamp(17px, ~2.0cqi, 24px)` 主内容
- 中文：`clamp(15px, ~1.7cqi, 20px)` 辅助
- 任何窗口下英文始终大于中文；375 不低于 17/15；不溢出字幕窗
- 不依赖 JS ResizeObserver（优先纯 CSS 容器查询；不支持时回退固定字号）
- 与 P2-10 全屏共存：全屏后视频窗变宽，字号自动变大

## write_scope
- `frontend/src/components/WatchSubtitleOverlay.tsx`
- `frontend/src/App.tsx`（媒体区加 container-type，shared lease）
- `scripts/watch-mode-acceptance.mjs`
- `specs/044-watch-mode/spec.md`

## acceptance
1. 媒体区 `container-type: inline-size`（或等效），字幕字号用 cqi/clamp。
2. 1440 普通/观影/全屏三档实测字号递增；英文 > 中文。
3. 375 最小档 17/15，不溢出；长句仍换行完整。
4. 浏览器不支持容器查询时回退固定 17/15，不出现无字号。
5. watch-mode 验收增加字号随窗宽变化断言；现有历史/全屏断言零回归；截图。

## deps
- P2-10
