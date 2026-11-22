# 任务卡（TASKS）

每张卡是一份可执行契约：目标、非目标、**可写文件白名单**、只读上下文、验收命令、依赖、Owner、回滚。
派活时只给卡路径；实现者先读卡，再读卡内 `read_only` 文档。

- **机器可读任务板**：`TASKS/board.json`（卡状态 / owner / `write_scope` / `shared_writes` / `deps`）。改卡时同步改 board，否则 preflight 不认。
- 状态：`pending`（未开始）→ `ready` → `claimed` → `in_review` → `approved` → `merged` → `closed`；异常用 `blocked` / `changes_requested`。

## 开工与提交前

```bash
node scripts/check-task-board.mjs                        # 卡文件存在 / ID 唯一 / 状态合法 / deps 无环
node scripts/agent-preflight.mjs --card <ID>             # 改动文件 ⊆ write_scope、共享文件、活跃卡写域交集
node scripts/agent-preflight.mjs --card <ID> --staged    # 提交前（pre-commit 自动跑）
node scripts/install-hooks.mjs                           # 每个 clone 一次：core.hooksPath=.githooks
```

规则：**无卡不开工**；白名单外 1 行即失败；共享文件（`App.tsx`、`i18n/*.json`、`components/ui/**` 等）只由 Integrator 写（`--as-integrator`）；证据绑 `HEAD <sha7>`，rebase 后作废重跑。
