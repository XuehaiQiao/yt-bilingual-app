# P1-22 手风琴交互应用到所有词表

- status: claimed
- owner: {implementer: accordion-impl, reviewer: lead, integrator: lead}
- base_sha: 58a675d

## goal
所有词表行展开改为**手风琴**：同一词表内只允许一行展开，展开另一行自动收起；再点当前行收起。覆盖：我的收藏、已掌握、内置 CEFR/GRE/CET4/CET6、短语、自定义词表；词族已是单开，保持。

## write_scope
- `frontend/src/components/VocabularyBookScreen.tsx`
- `frontend/src/components/VocabularyRows.tsx`（如需）
- `scripts/wordbook-v12-acceptance.mjs`
- `scripts/mastered-tab-acceptance.mjs`
- `scripts/custom-wordlists-acceptance.mjs`
- `scripts/word-family-acceptance.mjs`
- `specs/005-favorites-export/spec.md`

## acceptance
1. 每个词表内：展开 A 再展开 B → A 自动收起；再点 B → 收起；切 tab 清空展开。
2. 我的收藏/已掌握/内置/短语/自定义全部生效；短语异步详情不串行错乱（切行取消旧加载）。
3. 词族手风琴保持；编辑模式/全选状态不受影响。
4. 展开区内容/操作/底色/testid 不变；375/1440。
5. 四个词表脚本更新断言并跑绿；`tsc/build/i18n/gate`；preflight。

## deps
- 无（与 P1-21 文件不重叠）
