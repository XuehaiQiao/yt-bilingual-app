# 多 Agent 协作工作流 v1.1

> 状态：**随架构批准生效（2026-11-22）；P0-06 已把任务板 / 写域 preflight / 契约与 Flag / hook / CI 落成机器门禁（2026-11-22）** ｜ 依据：`ARCHITECTURE.md` §10、`docs/design-governance/*`、专家提案
> 原则：**契约先行、写域隔离、机器门禁、独立评审**；agent 之间不靠长对话同步。

## 1. 角色

| 角色 | 写什么 | 禁止 | 交付 |
|---|---|---|---|
| Architect / Planner | 目标/非目标、spec、契约、任务卡、DAG、ADR | 写产品代码、放宽验收、自己实现 | 任务卡、契约、ADR |
| Implementer | 任务卡白名单内实现 | 白名单外一行也不改；不改共享文件/门禁/验收断言；不合并 | commits + handoff |
| Reviewer | 只读审 diff + 证据 + G1–G8 | 改代码/测试/卡；自审；批准 SHA 不符的证据 | `review.json`（sha7 + P0/P1 + 结论） |
| Tester | 先写失败测试/验收，再复跑 | 改产品代码；用实现当 oracle；事后补测试 | 红/绿日志、截图 |
| Integrator | **唯一共享文件写者**；串行合并、跑全套门禁 | 合并红 PR；静默改别人域内逻辑 | merge-sha 门禁包 |
| Scribe | spec/文档/ADR/度量归档 | 改代码、改决策、代替 Owner 验收 | 文档回填、度量册 |

独立 Reviewer（不得是作者）触发条件：共享文件、契约/迁移/i18n key/flag、P0/安全/计费/账号删除、跨前后端、设计门禁自身、hotfix。

## 2. 任务卡（唯一派活载体）

每张卡落在 `TASKS/<id>.md`；派活 prompt 只给卡路径 + 角色 + 纪律，不抄上下文。

```yaml
id: P0-01-my-words-count
goal: 顶栏/侧栏/词书 tab/阅读按钮/导出的「我的单词」计数统一，等于收藏列表长度
non_goals: [新增后端计数端点, 改收藏数据结构]
write_scope: [frontend/src/lib/myWords.ts, frontend/src/components/VocabularyBookScreen.tsx, frontend/src/components/ReadingVocabButton.tsx]
shared_writes: [frontend/src/App.tsx]        # 仅 Integrator
read_only: [specs/005-favorites-export/spec.md, frontend/src/lib/favorites.ts, ARCHITECTURE.md §6]
contracts: [my-words-single-source, GET /api/favorites]
acceptance: [tsc+build+check:i18n, favorites-count-acceptance.mjs（新增）, grep 计数路径无 mastered 减法]
evidence: artifacts/<sha7>/P0-01/{gate.json,acceptance.log,1440.png,375.png}
deps: []
owner: {implementer: impl-1, reviewer: rev-1, tester: qa-1, integrator: int-1}
base_sha: <sha7>; branch: task/P0-01
rollback: revert merge; 纯前端
```

规则：白名单外 1 行 = 失败；同一张卡不换 Implementer；卡内 `write_scope` 是唯一写权限；`shared_writes` 由 Integrator 持租约写入。

## 3. 并行与写域

- `deps` 构成 DAG；只跑 deps 全 done 且**活跃卡 scope 无交集**的卡；同波次最多 3 个 Implementer。
- 一卡一 worktree：`git worktree add .worktrees/<id> -b task/<id> <base>`；`.worktrees/` 入 `.gitignore`。
- 共享文件（只 Integrator）：`App.tsx`、`i18n/*.json`、`package*.json`、`components/ui/**`、`lib/nav*`、`backend/migrations/**`、`.github/**`、`scripts/gate-receipt.mjs`、`specs/README.md`。
- 冲突硬停：preflight 扫活跃卡 scope 交集 → 拒绝 claim；PR 再验 diff ⊆ 白名单；Integrator 串行合并。
- **共享工作区提交纪律**：多个 agent 同一 worktree 时，agent 只能 `git add` 自己白名单内的文件；Integrator 提交前必须 `git diff --cached --name-only` 复核，并使用 `git commit -- <paths>` 显式提交自己的文件，**禁止 `git add -A`/裸 `git commit` 把别人暂存的文件带入**。
- 证据绑 `HEAD <sha7>`；rebase/amend 后旧证据作废重跑。

## 4. 合并门禁

| 门 | 命令 | 现状 | 强制 |
|---|---|---|---|
| 类型/构建 | `cd frontend && npx tsc -b && npm run build` | CI 已跑 | 必须 |
| i18n | `npm run check:i18n` | CI 已跑 | 必须 |
| 后端 | `py_compile *.py` + `pytest tests -q` | CI 已跑 | 必须 |
| 功能验收 | `APP_URL=… node scripts/<feature>-acceptance.mjs` | 手动 | 改动功能必须 |
| 设计门禁 | `node scripts/gate-receipt.mjs`（绑 HEAD） | report-only | 必须跑并贴结果；P0 阻断 |
| 任务板 | `node scripts/check-task-board.mjs`（卡文件/ID 唯一/状态/deps 无环） | **已落地（P0-06）** | CI 强制 |
| 写域/证据 | `node scripts/agent-preflight.mjs --card <ID> [--staged]`（diff ⊆ 白名单、共享文件、活跃卡交集、HEAD） | **已落地（P0-06）** | 新任务强制；pre-commit 自动跑 |
| 契约 | `node scripts/check-contracts.mjs`（schemas JSON + flags 注册）；`check-contract-map`（route/schema 测试映射） | schemas/flag **已落地（P0-06）**；contract-map 仍待建（P1） | 新任务强制（已落地部分） |
| Flag | `node scripts/check-contracts.mjs`（必填/唯一/未过期/未登记 `ff.*`）；关闭态测试 | 注册表检查**已落地（P0-06）**；关闭态测试仍待建（P1） | 新任务强制（已落地部分） |

### 4.1 安装与绕过（诚实边界）

每个 clone 执行一次（只改本仓库 local config，不动全局）：

```bash
node scripts/install-hooks.mjs           # git config core.hooksPath .githooks；chmod +x .githooks/pre-commit
node scripts/install-hooks.mjs --check   # 校验是否已安装
```

- `.githooks/pre-commit`：无 `TASK_ID` 且 `GOVERNANCE_BYPASS!=1` → **拒绝提交**；有 `TASK_ID` → 跑
  `node scripts/agent-preflight.mjs --card "$TASK_ID" --staged`，失败即拒绝。
- 绕过：`GOVERNANCE_BYPASS=1` 或 `git commit --no-verify` 可跳过 hook。**仅限事故**，事后必须在
  handoff / PR 写明原因与补跑结果。
- CI：`.github/workflows/ci.yml` 的 `governance` job 跑
  `check-task-board` + `check-contracts` + `node --test "scripts/tests/*.test.mjs"`（Node 22）。
  注意 Node 的 test runner 接受文件/glob 而不是裸目录，因此不写 `node --test scripts/tests`。
- **仍待管理员**：GitHub 分支保护 / required checks。在配置之前，`governance` job 失败只是“变红”，
  不能物理阻止合并；`gate-receipt` 仍是 report-only。**不宣称“已强制”**。

## 5. Handoff（交接记忆）

字段：`taskId / assignId / baseSha / branch / headSha / changedFiles / contractRefs / 命令+exit code / evidence@sha7 / residual risks / rollback / handoffId`。
用 `mnemos_remember`（tags 冒号 `task:<id>`、`assign:<id>`）返回 memoryId；Integrator 用 `mnemos_task_update` 回填；结论按 taskId 取，不把回执当结论。

## 6. 状态机

`proposed → ready → claimed → in_review → approved → merged → closed`；`blocked` 只写一个问题 + owner + 期望时间；`changes_requested` 必须指到文件/行。

## 7. P0 试点顺序（4 个 bug + 基建）

| 波次 | 卡 | 内容 | 可并行 |
|---|---|---|---|
| W1 | P0-05 | 配额上限单源 + ops 身份（分析不再被预热挤掉） | 与 P0-02 |
| W1 | P0-02 | reconcile 3 条存量重叠（dry-run→备份→审计→apply） | — |
| W2 | P0-01 | 单一 `selectMyWords`，删除所有减法 | 依赖 02 |
| W2 | P0-03 | 重复入口：星标唯一取消；已收藏不显示「加入我的单词」 | 与 01 同文件 → 串行 |
| W3 | P0-04 | 文章分析恢复 + 可见可重试错误态 | 依赖 05 |

每卡流程：Architect 定卡 → Tester 红测 → Implementer（worktree）→ Reviewer（独立）→ Integrator 合并 → Scribe 回填 spec/度量。

## 8. 度量

返工率（首次 review 后 changes_requested / 合并卡）≤15%；契约破坏 0；同文件冲突 0；门禁首次通过率 ≥80%；证据 SHA 不符 0。
