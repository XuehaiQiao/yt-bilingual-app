# P2-26 导入词表自动匹配 CEFR

- status: claimed
- owner: {implementer: auto-cefr-impl, reviewer: lead, integrator: lead}
- base_sha: b8bd87e

## goal
导入自定义词表（CSV/TSV/TXT/APKG）时，未提供 CEFR 的词自动匹配 10k 频表等级：
- A1/A2/B1/B2/C1 → 写入 cefr
- C1+ / 不在频表 → 留空（现有 UI 显示 —）
- 用户显式提供合法 CEFR 时保留，不覆盖
- APKG 导入同样生效（无需用户在 Anki 字段里提供 CEFR）

## write_scope
- `backend/wordlists.py`
- `backend/vocabulary.py`（新增无 100 上限的内部批量 level map）
- `backend/tests/test_wordlists.py`
- `backend/tests/test_apkg_import.py`（如导入断言）
- `specs/038-custom-wordlists/spec.md`
- `specs/046-apkg-import/spec.md`

## acceptance
1. 无 CEFR 的词经导入后，列表接口有 A1–C1（如 abandon=B1、the=A1）。
2. 显式 CEFR 不被覆盖；C1+/未知留空；非法 CEFR 仍按原规则忽略。
3. 7,512 词导入性能可接受（加载频表一次，不 100 次重复读文件）。
4. 导入响应/skipped/限额/去重不变；CSV 与 APKG 都覆盖。
5. pytest 全量；preflight。

## deps
- P2-23/P2-24
