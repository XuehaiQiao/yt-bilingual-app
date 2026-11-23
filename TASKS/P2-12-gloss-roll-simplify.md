# P2-12 「滚动词条」精简

- status: pending（等 P2-11 释放 WatchGlossPanel）
- owner: {implementer: TBD, reviewer: lead, integrator: lead}
- base_sha: 13ea3b9

## goal
把观影模式词条窗改名为「滚动词条」，并去掉冗余要素：
- 标题：`滚动词条`（vi 对应）
- 不显示整句英文上文
- 不显示「生词 / 语言点」小标题
- 不显示「习语 / 文化」kind 徽章
- 不显示「本句无生词」及逐句空态占位
- 不显示条目卡片边框/底纹/条目间分割线
- 保留：当前句条目在顶部、历史顺延、重复句移顶不重复、最多 30 句、新句滚顶、手动滚动不打断、全局 loading/error/login/未分析状态

## 视觉
- 连续列表，无分组标题、无边框、无分割线
- 词条：词（amber）+ 释义（右对齐/次级色）
- 语言点：文本（sky）+ 释义（下一行/次级色），不标 kind
- 面板标题/边界保留（rail 左边界、floating 卡片边界属于容器，不是条目分割线）

## write_scope
- `frontend/src/components/WatchGlossPanel.tsx`
- `frontend/src/i18n/zh-CN.json`、`vi-VN.json`
- `scripts/watch-mode-acceptance.mjs`
- `specs/044-watch-mode/spec.md`

## acceptance
1. 标题「滚动词条」；无整句、无两节标题、无 kind 徽章、无「本句无生词」、无条目边框/分割线。
2. 历史行为不变；空句不再生成占位条目，旧条目保留。
3. 375/1440 排版紧凑；长词/长释义换行不溢出。
4. loading/error/login/未分析仍正确；零新增 AI。
5. watch-mode 验收更新（断言无 context/无 headings/无 kind/无 empty/无 border），现有字号/全屏/历史断言零回归；截图。

## deps
- P2-11
