# backend/migrations — Alembic 迁移

**命令都在 `backend/` 下执行**（数据库路径来自 `AUTH_DB_PATH` 环境变量或 `config.py`，见 `env.py`）：

```bash
venv/bin/alembic upgrade head            # 新库：从零建到最新
venv/bin/alembic current                 # 当前库停在哪个 revision
venv/bin/alembic stamp 0001_baseline     # 旧库（只有 users/sessions）：只标基线，不动数据
venv/bin/alembic upgrade head            #   再补建 learning_events
venv/bin/alembic stamp head              # 已是最新的库：只写版本号，不执行 DDL
```

## 迁移清单

| revision | 内容 |
|---|---|
| `0001_baseline` | 基线：`users` / `sessions` + `idx_sessions_expires`，字段/索引与 `backend/auth_db.py` 一致 |
| `0002_learning_events` | 学习事件日志 `learning_events`（append-only）+ 两个查询索引 |

## 约定

- **迁移 id 递增**：新迁移用 `--rev-id 0003_xxx`，文件名模板是 `%(rev)s`（Alembic 自动补 `.py`）。
- **基线幂等**：`0001` / `0002` 都用 inspector 判断表/索引是否已存在，所以对已有
  `users`/`sessions` 的旧库直接 `alembic upgrade head` 也安全（不重建、不动数据）。
- **不要对旧库直接 `stamp head`**：会把 `0002` 也标记成已应用，`learning_events`
  永远不会被创建。旧库的正确姿势是 `stamp 0001_baseline` → `upgrade head`。
- **`downgrade` 会 DROP 表**（`0001` 的 down 会删 `users`/`sessions`），只用于空库/
  测试回滚，别在真实库上跑。
- **`learning_events` 是 append-only**：迁移只建表和索引，不建触发器；保留期硬删
  （计划书 §8.4，24 个月）留到删除权矩阵落地时再做，届时用独立运维脚本，不进应用代码。
- 新增表一律写在这里，**不要**再往 `auth_db.py` 的 `_init_schema` 里加 `CREATE TABLE`。
