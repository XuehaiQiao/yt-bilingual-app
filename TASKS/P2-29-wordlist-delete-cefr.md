# P2-29 自定义词表删除入口 + 存量 CEFR 回填

- status: claimed
- owner: {implementer: wordlist-fix-impl, reviewer: lead, integrator: lead}
- base_sha: bcb89d9

## 用户反馈
1. 自定义词表应有删除选项（现在藏在「⋯」里，不明显）
2. 已导入的 GRE 红宝书 7,511 词仍无 CEFR（导入早于自动匹配修复）

## 修复
1. 自定义词表头部加显式「删除词表」图标按钮（Trash2，aria-label/title，testid `vocab-custom-delete-quick`），复用现有二次确认；保留菜单项。
2. 存量 CEFR 回填：
   - 后端 `POST /api/wordlists/{id}/backfill-cefr`（登录/归属校验）：扫描该表 cefr 为空的行，用 `vocabulary.level_map_for_words` 批量匹配 A1–C1，更新；返回 `{updated,total,remaining}`。
   - 前端打开自定义词表时，如发现缺失 CEFR 自动调用一次并刷新（静默；失败不阻塞展示）；也可在菜单加「补全等级」手动项。
   - 不覆盖已有 CEFR；C1+/未知留空。
3. 本地现有 GRE 列表执行回填（用户要求）。

## write_scope
- `frontend/src/components/VocabularyBookScreen.tsx`
- `frontend/src/lib/wordlists.ts`
- `frontend/src/i18n/zh-CN.json`、`vi-VN.json`
- `backend/wordlists.py`
- `backend/routes_wordlists.py`
- `backend/tests/test_wordlists.py`
- `scripts/custom-wordlists-acceptance.mjs`
- `specs/038-custom-wordlists/spec.md`

## acceptance
1. 删除按钮可见，点击弹现有确认；删除后回我的单词/无该表。
2. 旧表 7,511 词自动回填：列表 CEFR 徽章出现；已有等级不被覆盖；C1+ 留空。
3. 空表/无缺失不写；归属/游客错误；回填幂等；375/1440。
4. 现有导入/APKG/词表测试零回归；pytest；`tsc/build/i18n/gate`；preflight。

## deps
- P2-24/P2-26
