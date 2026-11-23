# P1-13 词族手风琴 + 默认/展开内容重设计

- status: claimed
- owner: {implementer: family-ui-impl, reviewer: lead, integrator: lead}
- base_sha: 7d9bcd4

## goal
按学习价值重设词族行：默认折叠行让人一眼看懂「同根派生」；展开按词性分组展示成员；同时只允许一个词族展开。

## 默认折叠行
`head  /ipa/  核心释义  CEFR  [v·n·adj]  5 词  → decision · decisive +2`
- 主词 + 音标 + 释义 + CEFR
- 词性分布徽章（v/n/adj/adv/other）
- 2–3 个代表派生词预览 + 总数
- 不再只显示「成员数」

## 展开
- 手风琴：只允许一个族展开；展开另一个自动收起；再点收起
- 按词性分组：动词 / 名词 / 形容词 / 副词 / 其他；组内按 rank，主词置顶
- 每行：原词 / 音标 / 释义 / CEFR / ★ / ✓（保留 P1-07 行为）
- 无音标/释义显示 `—`

## 数据
- 构建脚本给每个成员加 `pos`（WordNet synset POS 集合：n/v/a/s/r；无则空）
- 重新生成数据；族数/成员数不变；保留 P1-11 的 23 条规则与 P1-12 ECDICT 补全

## write_scope
- `scripts/build_word_families.py`
- `scripts/tests/test_build_word_families.py`
- `content/wordlist/word-families.v1.json`
- `backend/word_family.py`
- `backend/tests/test_word_family.py`
- `frontend/src/components/VocabularyBookScreen.tsx`
- `frontend/src/components/VocabularyRows.tsx`
- `frontend/src/i18n/zh-CN.json`
- `frontend/src/i18n/vi-VN.json`
- `scripts/word-family-acceptance.mjs`
- `specs/041-word-family-list/spec.md`

## acceptance
1. 折叠行按上述结构；预览成员 2–3 个；POS 徽章正确；无数据时 `—`。
2. 手风琴：只一个展开；切另一个自动收起；再点收起；展开区按 POS 分组、主词置顶、组内 rank。
3. 成员行保留释义/音标/★/✓ 与失败回滚；计数同步。
4. 数据含 `pos`；族/成员数不变；the/at 不在；黑名单/allowlist 规则不回归。
5. `tsc/build/i18n/gate`；word-family acceptance 更新；四词表零回归；1440/375 截图。

## deps
- P1-12（已完成）
