# P2-28 每日额度管理后端

- status: claimed
- owner: {implementer: quota-admin-impl, reviewer: lead, integrator: lead}
- base_sha: bcb89d9

## write_scope
- `backend/quota_config.py`（新建）
- `backend/ai/quota.py`
- `backend/routes_admin.py`
- `backend/migrations/versions/0031_quota_overrides.py`（新建）
- `backend/tests/test_quota_admin.py`（新建）
- `backend/tests/test_migrations.py` / head 断言
- `specs/047-quota-admin/spec.md`

## acceptance
见 spec §3–§5；全量 pytest；preflight。
