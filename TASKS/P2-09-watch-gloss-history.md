# P2-09 观影模式：字幕字号 + 词条历史顺延

- status: claimed
- owner: {implementer: watch-history-impl, reviewer: lead, integrator: lead}
- base_sha: 5b97764

## goal
1) 单句字幕：**英文在上、字号更大（17px 主内容）**；中文在下、更小（15px 辅助）；保持行高与 375 不溢出。
2) 词条窗改为**按句累积**：当前句的标亮词/语言点自动出现在顶部，之前句子的词条不消失，向下顺延，直到被滚出窗口；新句自动滚到顶部。

## write_scope
- `frontend/src/components/WatchSubtitleOverlay.tsx`
- `frontend/src/components/WatchGlossPanel.tsx`
- `frontend/src/App.tsx`（shared，lead 授权：传当前句文本/序号）
- `frontend/src/i18n/zh-CN.json`、`vi-VN.json`（如需「当前句」）
- `scripts/watch-mode-acceptance.mjs`
- `specs/044-watch-mode/spec.md`

## acceptance
1. 字幕：中文/英文字号提升后不重叠、不超出画面、375 不溢出；`pointer-events-none` 不变。
2. 词条历史：
   - 当前句词条在顶部；切到下一句时新句插到顶部，旧句条目保留在下方
   - 同一句重复经过（回看/跳转）不重复插入，而是移到顶部
   - 新句自动滚到顶部；用户手动滚动后不被强制拉回
   - 空句显示「本句无生词」；旧条目仍保留
   - 最多保留 30 句历史，超出丢弃最旧
3. 全局 loading/error/login/未分析状态仍正确；零新增 AI。
4. `tsc/build/i18n/gate`；watch-mode 验收更新（3 句顺延/去重/滚动/字号）；375/1440 截图；现有脚本零回归。
5. 不改后端、不改其他页面。

## deps
- P2-08（已完成）
