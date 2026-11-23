# P1-20 Qwen Flash/Plus 版本与价格落地

- status: claimed
- owner: {implementer: qwen-impl, reviewer: lead, integrator: lead}
- base_sha: fc8cdbb

## goal
把 Qwen Flash/Plus 从别名固定到实际版本，并补可核实价格，使严格计费可用；**不改默认 MODEL_ROUTE**。

## 版本与价格（官方帮助页 2026-11-21 更新）
- `qwen3.8-flash`（当前 `qwen-flash` 别名指向 v3.8）：
  - 北京/全球：输入 **$0.113** / 输出 **$0.382** 每百万 Token
  - 新加坡/香港：$0.15 / $0.47
- `qwen3.7-plus`（当前 `qwen-plus` 别名指向 v3.7）：
  - 北京/全球：输入 **$0.276** / 输出 **$1.101** 每百万 Token（≤256K；限时折扣不采用，取原价）
  - 美国/日本：$0.4 / $1.6
- 来源：https://www.alibabacloud.com/help/zh/model-studio/model-pricing
- 本项目 QWEN_BASE_URL 为 dashscope 国内站 → 采用北京价。

## write_scope
- `backend/config.py`（catalog model_id/name/version 字段）
- `backend/migrations/versions/0030_qwen_prices.py`（新建，插 model_prices，可回滚）
- `backend/tests/test_migrations.py`（head 常量）
- `backend/tests/` 其他 head 断言（grep 0029）
- `docs/API模型与价格.md`（如存在；没有则 `backend/README.md` 补一段）

## acceptance
1. catalog `qwen-flash` → `model_id=qwen3.8-flash`、`qwen-plus` → `qwen3.7-plus`；名称/version 可见。
2. 迁移插入两条价格（source_kind=official_page、source_ref 官方 URL、effective_from、备注北京/全球、原价）；重复 upgrade 幂等；downgrade 删除。
3. `billing.price_for_model()` 能取到；严格计费下 Qwen 不再因未定价被拒（但仍不在默认路线）。
4. 旧数据库 head 0029 → 0030；全仓 head 断言更新；全量 pytest。
5. 不改 `TARGET_LANG_MODEL_ROUTES`、不改默认模型；前端无需改（若名称展示来自 catalog 则自然生效）。

## deps
- 无
