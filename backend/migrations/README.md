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
| `0003_cost_ledger` | AI 成本账本 `ai_usage`（append-only）+ 日配额 `ai_quota`（主键 `user_id, day, feature`）+ 三个查询索引 |
| `0004_target_lang` | 给 `ai_usage` 加可空 `target_lang`（默认 `zh-CN`，旧行不改写、不做 UPDATE）；不拆配额表 |
| `0005_jobs` | 任务表 `jobs`（`id`/`user_id`/`kind`/`content_ref`/`target_lang`/`status`/`cursor`/`payload`/`error`/`created_at`/`updated_at`，`status` 带 CHECK）+ `ix_jobs_user_created` + 部分唯一索引 `ux_jobs_active`（同一 user+kind+content+语言最多一个未完成 job）；见 [backend/README「任务表与断线续传」](../README.md#任务表与断线续传m1-⑤jobs--sse-重连) |
| `0006_review_engine` | 复习引擎三表：`word_states`（状态/FSRS 参数/到期，`UNIQUE(user_id,lemma,target_lang)` + `(user_id,due_at)` 索引）、`review_logs`（append-only 流水 + `(user_id,reviewed_at)` 索引）、`word_sources`（词来源，FK → `word_states.id` ON DELETE CASCADE + `word_state_id` 索引）；见 [backend/README「复习引擎」](../README.md#复习引擎m2fsrs-6--队列--复习日志) |

## 约定

- **迁移 id 递增**：新迁移用 `--rev-id 0007_xxx`，文件名模板是 `%(rev)s`（Alembic 自动补 `.py`）。
- **基线幂等**：`0001` / `0002` 都用 inspector 判断表/索引是否已存在，所以对已有
  `users`/`sessions` 的旧库直接 `alembic upgrade head` 也安全（不重建、不动数据）。
- **不要对旧库直接 `stamp head`**：会把 `0002` / `0003` / `0004` / `0005` / `0006` 也标记成已应用，`learning_events`、
  `ai_usage` / `ai_quota` / `target_lang` 列、`jobs` 表、复习三表永远不会被创建。旧库的正确姿势是 `stamp 0001_baseline` → `upgrade head`。
- **`downgrade` 会 DROP 表**（`0001` 的 down 会删 `users`/`sessions`），只用于空库/
  测试回滚，别在真实库上跑。
- **`learning_events` 是 append-only**：迁移只建表和索引，不建触发器；保留期硬删
  （计划书 §8.4，24 个月）留到删除权矩阵落地时再做，届时用独立运维脚本，不进应用代码。
- **复习三表**：`word_states` 是调度真源，`review_logs` append-only（应用层只 INSERT/SELECT），
  `word_sources` 随词删除（FK CASCADE，连接需 `PRAGMA foreign_keys=ON`）。运行时不建表；
  表缺失时 `backend/srs.py` 抛 `ReviewUnavailable`，路由返回 503。详见
  [specs/013](../../specs/013-review-engine/spec.md)。
- 新增表一律写在这里，**不要**再往 `auth_db.py` 的 `_init_schema` 里加 `CREATE TABLE`。
