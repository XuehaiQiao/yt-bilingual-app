# P2-22 观影模式：指针限定视频区 + 视频窗口尺寸可调

- status: claimed
- owner: {implementer: watch-size-impl, reviewer: lead, integrator: lead}
- base_sha: 65cc211

## 用户反馈
1. 鼠标在滚动词条栏移动仍会抬字幕；应只响应视频画面区域
2. 观影模式下视频窗口尺寸可调

## 修复
1) 活动区域限定：只有指针/触摸事件目标位于 `video-area`（或视频舞台）内才抬字幕；滚动词条栏、顶栏、画面外都不触发；键盘仍可唤醒。
2) 视频窗口尺寸：
   - `watchVideoScale` 60–100%，默认 100，localStorage 持久化
   - 顶栏加「画面大小」控制（三档/滑杆），保持 16:9、居中、不溢出
   - 100% = 现有最大；缩小后四周留环境光/黑边，不裁切
   - 375 移动端不缩小（保持 100%）或隐藏控制
3) 保留字幕抬高/落底、暂停不落底、三态字幕、原生控制条。

## write_scope
- `frontend/src/App.tsx`（shared lease）
- `frontend/src/components/WatchTopBar.tsx`
- `frontend/src/lib/layout.ts`
- `frontend/src/i18n/zh-CN.json`、`vi-VN.json`
- `scripts/watch-mode-acceptance.mjs`
- `specs/044-watch-mode/spec.md`、`specs/045-watch-mode-experience/spec.md`

## acceptance
1. 鼠标在词条栏/顶栏/视口外移动不抬字幕；视频画面内移动抬；键盘仍抬。
2. 顶栏可调 60/75/100（或滑杆）；video 宽度按比例变化，16:9，居中，无溢出；刷新后保留。
3. 100% 恢复最大；375 不受影响/无控制；字幕不因缩放溢出。
4. P2-10～P2-21 零回归；watch acceptance 2× PASS；1440/1920/375 截图；`tsc/build/i18n/gate`；preflight。

## deps
- P2-21
