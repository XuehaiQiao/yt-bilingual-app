# P2-23 APKG 解析后端

- status: claimed
- owner: {implementer: apkg-backend-impl, reviewer: lead, integrator: lead}
- base_sha: 65cc211

## write_scope
- `backend/apkg_import.py`（新建）
- `backend/routes_wordlists.py`
- `backend/main.py`（如路由已 include 则无需）
- `backend/requirements.txt`（zstandard）
- `backend/tests/test_apkg_import.py`（新建）
- `specs/046-apkg-import/spec.md`

## acceptance
见 spec §2/§4；合成 legacy/anki21/anki21b 样本；API 契约；安全/错误码；全量 pytest；preflight。
