# CONTRACTS（契约，只读）

契约是跨模块的唯一事实源；**代码服从契约，不是反过来**。本目录由 contract-owner 维护，其他 agent 只读。

## 规则

1. 修改契约必须提交 RFC/ADR，列全消费方 grep 清单，并同 PR 加契约测试。
2. `schemas/*.json` 是共享形状的权威定义；前端/后端类型必须能由它校验（P1 起由脚本校验，当前人工核对）。
3. `flags.yaml` 是 Feature Flag 默认值的唯一来源；代码禁止裸常量。
4. `api/openapi.yaml` 是端点快照：P1 由脚本从 FastAPI 生成并与契约 diff；当前先冻结高风险 payload（word / analysis / error）。
5. 任何形状变更都要升版本并写 `CHANGELOG.md`；旧版本消费方必须有迁移窗口。

## 当前冻结

- `schemas/word.json` —— 词条形状（含 `definition` 快照）
- `schemas/analysis.v5.json` —— 教学分析 payload（版本 `analysis.v5`）
- `schemas/error.json` —— 402/403/409/429/503 错误码
- `flags.yaml` —— 现有开关
- `api/README.md` —— 端点清单与生成计划

## 变更流程

proposal（RFC/ADR）→ 消费方 grep → 契约 diff → 测试 → Reviewer（contract-owner）→ 合并 → CHANGELOG。
