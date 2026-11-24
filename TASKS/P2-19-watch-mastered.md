# P2-19 滚动词条「我已掌握」开关

- status: claimed
- owner: {implementer: watch-mastered-impl, reviewer: lead, integrator: lead}
- base_sha: f51860d

## goal
滚动词条每个词/短语/语言点行增加「我已掌握」图标开关（与收藏星并列），状态与词书/标亮过滤共用 `word_states.mastered`；收藏与已掌握互斥。

## write_scope
- `frontend/src/components/WatchGlossPanel.tsx`
- `frontend/src/App.tsx`（shared lease：传 targetLang）
- `frontend/src/i18n/zh-CN.json`、`vi-VN.json`
- `scripts/watch-mode-acceptance.mjs`
- `specs/044-watch-mode/spec.md`、`specs/045-watch-mode-experience/spec.md`

## acceptance
1. 每行收藏星旁有「✓ 我已掌握」圆形图标；已掌握=绿色实心，未=空心；aria-pressed/aria-label 正确。
2. 点击切换：
   - 登录：`PATCH /api/review/words {lemma, mastered, targetLang, definition}`；以响应为准
   - 游客：写 guest localStorage（`yt_bilingual_guest_mastered_words`），不调 API
3. 已掌握后该词不再被标亮（`useIgnoredWords` 刷新），滚动词条状态立即更新；取消可恢复。
4. 收藏/已掌握互斥：标记已掌握时移除同词收藏；移除失败回滚已掌握并显示行内错误。
5. 失败/游客限制行内提示；busy 防重复；历史行也显示状态。
6. 375 触摸目标 ≥44px；与字体/行布局不挤爆。
7. P2-10/11/12/13/15/16/17/18 零回归；watch acceptance 2× PASS；截图；`tsc/build/i18n/gate`；preflight。

## deps
- P2-18
