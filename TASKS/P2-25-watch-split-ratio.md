# P2-25 观影模式：视频/滚动词条分栏比例可调

- status: claimed
- owner: {implementer: watch-split-impl, reviewer: lead, integrator: lead}
- base_sha: b8bd87e

## 用户澄清
上一版「画面大小 60/75/100」是把视频在舞台里缩放；用户要的是**视频窗口与滚动词条窗口的分栏比例**可调。

## 目标
- 桌面观影模式：视频列 + 词条 rail 之间加可拖拽分隔条
- 拖动调整视频占比（建议 55%–85%），rail 宽度 280–560px 自适应
- 双击分隔条恢复默认 75 / 25；键盘 ←/→ 调整（role=separator，aria-valuenow）
- 持久化 `yt_bilingual_watch_split_ratio`；刷新保留
- 375/移动端仍为视频置顶 + 抽屉，不显示分隔条
- 移除/替换 P2-22 的「画面大小」缩放菜单，避免两个控件语义冲突

## write_scope
- `frontend/src/App.tsx`（shared lease）
- `frontend/src/components/WatchTopBar.tsx`
- `frontend/src/components/WatchGlossPanel.tsx`（rail 宽度由比例驱动）
- `frontend/src/lib/layout.ts`
- `frontend/src/i18n/zh-CN.json`、`vi-VN.json`
- `scripts/watch-mode-acceptance.mjs`
- `specs/044-watch-mode/spec.md`、`specs/045-watch-mode-experience/spec.md`

## acceptance
1. 1440：默认视频 75%/rail 25%；拖动到 60/85 时视频/rail 宽度按比例变化，16:9 不溢出。
2. 分隔条键盘可调、aria-valuenow、双击恢复；刷新保留。
3. 1920 比例合理（rail 280–560 限制）；375 无分隔条/抽屉不变。
4. P2-10～P2-24 零回归；watch acceptance 2× PASS；1440/1920/375 截图。
5. `tsc/build/i18n/gate`；preflight。

## deps
- P2-22
