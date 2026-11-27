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

没有这些，**停止并询问**，不要猜。

把值填入：

```bash
cp docs/release/templates/release-input.yaml /tmp/release-input.yaml
```

## 1. 定位仓库

```bash
git rev-parse --show-toplevel
cd "$(git rev-parse --show-toplevel)"
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
command -v git python3 node npm curl sqlite3
test -x backend/venv/bin/python
test -x backend/venv/bin/alembic
test -d frontend/node_modules
```

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
bash scripts/release-acceptance-suite.sh
```

## 5. 产出

写到：

```text
/tmp/release/<version>-<sha>/
  release-report.json
  release-report.md
  acceptance.tsv
  logs/
```

报告必须符合 `docs/release/agent-report.schema.json`。

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
- 自行 tag/push（除非 Release Owner 明确授权）
