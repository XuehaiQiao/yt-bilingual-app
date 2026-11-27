# 无上下文 Agent 快速启动

> 你没有任何历史记忆时，只读这一个文件 + `agent-process.yaml` 就能完成发布前门禁。
> 你**不能**执行生产步骤；生产由 `HUMAN_RUNBOOK.md` 的人完成。

## 0. 你需要的输入

先让 Release Owner 提供：

- `version`（如 `v1.2.0`）
- `release_sha`（要发布的 git commit）
- `release_type`
- 是否含迁移/回填
- 回滚镜像 tag
- `repo_root`（仓库绝对路径）
- 如含迁移/回填：`production_backup_path` 必须是 Release Owner 已复制到本机 `/tmp` 的副本（不要读 `/srv/ln/backups`），以及迁移验收/回填/审计命令

没有这些，**停止并询问**，不要猜。

把值填入：

```bash
cp docs/release/templates/release-input.yaml /tmp/release-input.yaml
```

## 1. 定位仓库

```bash
git rev-parse --show-toplevel
cd "$(git rev-parse --show-toplevel)"
git fetch origin
git checkout <release_sha>
git status --porcelain   # 必须为空
git rev-parse --short HEAD
```

## 2. 读文件顺序

1. `docs/release/agent-process.yaml`
2. `docs/release/AGENT_QUICKSTART.md`（本文件）
3. `docs/release/templates/version-release-checklist.md`
4. 需要时读 `docs/release/HUMAN_RUNBOOK.md`，了解交接点

## 3. 环境检查

```bash
command -v git python3 node npm curl sqlite3 timeout
test -x backend/venv/bin/python
test -x backend/venv/bin/alembic
test -d frontend/node_modules
test -d scripts/node_modules
```

任一项缺失：

```bash
./setup.sh                      # backend venv + frontend deps
cd scripts && npm ci            # Playwright acceptance deps
npx playwright install chromium
```

浏览器：

- Playwright 自带 chromium（推荐）：`npx playwright install chromium`
- 脚本通常支持 `CHROME_PATH`；也可以设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
- 示例（在 `scripts/` 下）：
  ```bash
  export CHROME_PATH="$(cd scripts && node -e 'console.log(require("playwright").chromium.executablePath())')"
  ```
- **Linux/CI** 不能依赖脚本里写死的 macOS Chrome 路径；必须设置上述环境变量。
- **注意**：部分脚本使用 `channel: 'chrome'`，需要系统安装 Google Chrome；只装 Playwright chromium 不够。Linux 请安装 `google-chrome`，或按脚本注释改为 `executablePath`。
- 验收脚本若因浏览器/harness 缺失无法跑，必须写 SKIP 原因，不能静默跳过。

如果 8000/5173 已有服务在跑：

- 不要假设它跑的是 `release_sha` 的代码；
- 让 Release Owner 确认/重启，或在干净环境重新启动；
- 否则验收结果不能作为本版本证据（NO_GO）。

本地服务未启动时：

```bash
mkdir -p /tmp/release
(cd backend && venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000) \
  >/tmp/release/api.log 2>&1 &
(cd frontend && npm run dev -- --host 127.0.0.1 --port 5173) \
  >/tmp/release/web.log 2>&1 &
sleep 3
curl -fsS http://127.0.0.1:8000/healthz
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5173/
```

只停止**你自己启动的**服务；不要杀用户已有的进程。

## 4. 执行固定门禁

按 `agent-process.yaml` 顺序：

1. p0 输入校验
2. p1 仓库/工具
3. p2 后端
4. p3 前端
5. p4 acceptance
6. p5 迁移演练（仅当 `includes_migration/backfill`）
7. p6 报告

全量 acceptance：

```bash
OUT=/tmp/release/<version>-<sha>/acceptance \
  bash scripts/release-acceptance-suite.sh
```

套件默认对失败脚本重试一次（`RETRY=0` 可关闭）；重试通过会写 `retry-pass`，报告中要保留首次/重试日志。两次都失败 = NO_GO。

单脚本调试：

```bash
ONLY=admin-feedback OUT=/tmp/release-debug bash scripts/release-acceptance-suite.sh
```

依赖 harness 的脚本必须用 `SKIP` + `SKIP_REASON` 显式跳过，并写进报告。

## 5. 产出

写到：

```text
/tmp/release/<version>-<sha>/
  release-report.json
  release-report.md
  acceptance/acceptance.tsv
  acceptance/logs/
```

报告必须符合 `docs/release/agent-report.schema.json`。

`checks[]` 映射规则：

- 每个 `scripts/*acceptance*.mjs` 一条，`id` = 文件名去掉 `.mjs`
- `status` 从 `acceptance.tsv` 取 PASS/FAIL/TIMEOUT/SKIP
- `evidence` = 对应 log 路径
- 发布 GO 要求 **0 SKIP**；SKIP 只用于本地调试，报告中出现 SKIP/TIMEOUT 即 `NO_GO`
- 重试通过（`retry-pass`）按 PASS 记录，但保留首次/重试日志
- `acceptance.pass/fail/skip` 直接来自 TSV 计数
- 全 PASS（无 SKIP/TIMEOUT）且 blockers 为空才写 `status: GO`，否则 `NO_GO`

## 6. 交接

最终回复只给：

- `status: GO / NO_GO`
- release SHA / version
- 失败/跳过项数量
- 报告路径
- 明确一句：**“等待人工执行生产步骤”**

禁止：

- SSH/生产 Docker
- 生产迁移/回填
- 读/打印密钥
- 删除备份
- **自行 tag/push（任何情况下都不行；tag 由 Release Owner 在候选验收通过后执行）**
