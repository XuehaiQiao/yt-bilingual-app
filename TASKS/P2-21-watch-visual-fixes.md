# P2-21 观影细节修正：词条卡片、指针过滤、控制栏对齐、字幕宽度

- status: claimed
- owner: {implementer: watch-visual-impl, reviewer: lead, integrator: lead}
- base_sha: d82dc71

## 用户反馈
1. 滚动词条需要背景卡片；收藏/掌握开关难以看见
2. 鼠标在屏幕外移动时不要弹起字幕
3. 字幕抬高态与 YouTube 原生控制栏不适配
4. 字幕宽度与视频窗口适配度不高，大屏下偏窄

## 修复
1) 词条行加**低对比背景卡片**（圆角、无分割线）；操作组默认可见（桌面 opacity≥0.6，hover 1；抽屉常显），图标按钮保持 44px 触摸目标。
2) 字幕唤醒只接受**视口内** pointermove/pointerdown；屏幕外/越界坐标不触发；键盘/touch 保持。
3) 抬高态 bottom 15% → **10%**，落在原生控制栏上方约 10–14px；测试阈值同步（约 7%–14%）。
4) 字幕最大宽度 `min(68ch,86%)` → **`min(96ch,92%)`**，随视频窗口变宽；长句仍两行内不裁切。
5) 保留 4s 落底、暂停不落底、0% 落底、三态字幕、Esc 退观影。

## write_scope
- `frontend/src/App.tsx`（shared lease）
- `frontend/src/components/WatchSubtitleOverlay.tsx`
- `frontend/src/components/WatchGlossPanel.tsx`
- `scripts/watch-mode-acceptance.mjs`
- `specs/044-watch-mode/spec.md`、`specs/045-watch-mode-experience/spec.md`

## acceptance
1. 词条行可见卡片背景；收藏/掌握在桌面默认可见、手机上常显；轮询无挤压。
2. 视口外 pointermove 不 raise；视口内 raise；暂停仍不落底。
3. 抬高态与原生控制栏上方对齐（实测 gap 约 8–14%）；落底 0%。
4. 1440/1920 字幕宽度占比明显提升（目标 ≥85% 视频宽），不裁切；375 正常。
5. 零回归（P2-10～P2-20）；watch acceptance 2× PASS；375/1440/1920 截图；`tsc/build/i18n/gate`；preflight。

## deps
- P2-20
