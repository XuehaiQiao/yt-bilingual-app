# 语途版本发布流程（可复用于 v1.1.1 之后所有版本）

> 目标：每次发版都可重复、可证据化、可回滚；不依赖某个人记得。
> 适用：`/srv/ln/app` Docker Compose 生产（单 uvicorn、SQLite、Caddy）。
> 配套：`docs/reports/v1.1-launch-migration-2026-11-25.md`、`docs/checklists/`。

---

## 0. 原则

1. **先冻结，再发版**：发版窗口内只接受 blocker 修复。
2. **代码、数据、配置分开验证**：代码镜像、Alembic 迁移、数据回填不是一件事。
3. **生产只做已演练过的动作**：迁移/回填先在数据副本上跑。
4. **回滚优先代码**：能用旧镜像解决，不先降级数据库。
5. **每个门禁留证据**：命令输出、截图、备份 SHA、健康检查。
6. **缓存与身份隔离是发版门禁**：任何用户数据/缓存改动必须过 A/B/C 测试。

---

## 1. 角色

| 角色 | 职责 |
|---|---|
| Release Owner | 版本范围、排期、Go/No-Go、最终签字 |
| Backend | API、配额/计费、迁移、后端测试 |
| Frontend | UI、i18n、浏览器验收、缓存隔离 |
| QA | 全量回归、双账号/故障注入、截图证据 |
| Ops/DBA | 备份、离机副本、生产迁移、健康/告警 |
| Product | 文案、分级/内容口径、灰度名单 |

小团队可以一人兼多角色，但 **Release Owner 与执行生产迁移的人不能都是“没人复核”**。

---

## 2. 版本与发布类型

### 2.1 版本号

- `vMAJOR.MINOR.PATCH`
- 预发：`vX.Y.Z-rc.N`（不部署生产）
- hotfix：patch 版本；仍走完整门禁
- 不复用 tag；`APP_VERSION`、镜像 tag、git tag 必须对应同一 release SHA
- 镜像 tag 用 release SHA（便于回滚），`APP_VERSION` 用语义版本

### 2.2 按风险选门禁

| 类型 | 例子 | 必需门禁 |
|---|---|---|
| 文案/样式 | 首页文案、i18n | build + i18n + 1440/390 截图 |
| 纯代码 | UI 修复、API 逻辑 | 全量 pytest + 前端 + 相关 acceptance + 冒烟 |
| Schema 迁移 | 新表/新列 | 上述 + 备份/离机 + 迁移演练 + 快照比对 |
| 数据回填 | 分级/缓存/价格 | 上述 + dry-run + 审计 + 回填后对照 |
| 认证/计费/缓存 | 登录、额度、storage、headers | 上述 + A/B/C 隔离 + 402/429 + 缓存头 |
| 安全/成本 | 防刷、预算、密钥 | 上述 + 滥用场景 + 供应商硬限额确认 |

---

## 3. 阶段 0：计划与冻结

### 3.1 开版本卡

- 版本号、目标、非目标、风险等级
- 负责/复核/发布人
- 预计窗口、停服时间、回滚方案
- 需要的数据/迁移/配置/供应商动作

### 3.2 范围冻结

冻结后只接受：

- P0/P1 回归修复
- 发布阻塞项
- 文案错字/安全问题

新功能进入下一版本，不夹带。

### 3.3 发布前必须写

- 变更清单（用户能感知的）
- 数据库变更说明（有无迁移/回填）
- 缓存/隐私影响说明
- 回滚步骤
- 已知问题

模板：`docs/release/templates/version-release-checklist.md`

---

## 4. 阶段 1：开发完成（DoD）

每个功能卡完成时必须：

- [ ] 代码合并，`git status` 干净
- [ ] 新增/修改测试
- [ ] 相关 acceptance 通过
- [ ] 文档/spec 更新
- [ ] 无硬编码密钥、无 PII 日志
- [ ] 涉及用户数据时：明确 scope（device/guest/user/global）与迁移
- [ ] 涉及缓存时：登记缓存 key、TTL、清理/隔离测试
- [ ] 涉及 AI 调用时：配额、余额、预算、失败结算路径
- [ ] 涉及迁移时：upgrade/downgrade/幂等/旧数据兼容
- [ ] 涉及 UI 时：1440、390、中越 i18n
- [ ] 涉及观测时：指标/日志/告警可查

---

## 5. 阶段 2：本地门禁（每次发版必跑）

### 5.1 后端

```bash
cd backend
venv/bin/python -m pytest tests -q
venv/bin/python -m compileall -q .
```

### 5.2 迁移图

```bash
cd backend
venv/bin/alembic heads       # 必须唯一 head
venv/bin/alembic current     # 本地当前版本
```

### 5.3 前端

```bash
cd frontend
npx tsc -b
npm run build
npm run check:i18n
```

### 5.4 浏览器验收

按改动范围跑，至少：

```bash
node scripts/cache-isolation-acceptance.mjs
node scripts/watch-mode-acceptance.mjs
node scripts/v11-p0-acceptance.mjs
```

发版前跑 `scripts/*acceptance*.mjs` 全量；记录 PASS/FAIL/SKIP。
依赖 5199 harness 的脚本必须标明 SKIP 原因，不能静默跳过。

### 5.5 缓存/身份隔离门禁（重要）

- [ ] A 登录 → B 登录 → C 登录，任何私有数据不串
- [ ] 收藏/订阅读失败时无全局 localStorage fallback
- [ ] 视频/书/句子进度按用户隔离
- [ ] 游客 claim 后 guest 桶清空/合并
- [ ] 刷新、后退（bfcache）、跨 tab 登录不显示上一账号
- [ ] 私有 API 响应有 `Cache-Control: private, no-store`
- [ ] Service Worker 不缓存 `/api/**` 和用户文件
- [ ] 退出登录清理浏览器缓存/站点数据（按需）

### 5.6 安全/成本门禁

- [ ] 供应商后台设置日/月硬限额
- [ ] `AI_DAILY_BUDGET_GLOBAL_USD` > 0；建议加月预算
- [ ] `SIGNUP_BONUS_MICRO_USD`、邀请码次数已确认
- [ ] 新账号/游客不能无限调用 AI
- [ ] 402/429 路径未被降级链吞掉
- [ ] 密钥不在前端/日志/截图
- [ ] 失败调用仍记账或可对账

### 5.7 本地 Go 条件

- 全量 pytest 绿
- tsc/build/i18n 绿
- 关键 acceptance 绿
- 无未解释的 FAIL
- 无 blocker 已知问题

---

## 6. 阶段 3：候选构建与预发演练

### 6.1 冻结 release SHA

```bash
cd /srv/ln/app
git fetch origin
git checkout <release-sha>
git status --porcelain    # 必须空
git rev-parse --short HEAD
```

### 6.2 构建候选镜像

```bash
export IMAGE_TAG=$(git rev-parse --short HEAD)
docker compose build --pull
docker images | grep linguatrek
```

构建期间生产旧版本继续运行。

### 6.3 数据副本演练（有迁移/回填时必做）

- 从生产备份取副本，**不要降级生产库**
- 从生产实际 `alembic current` 开始演练
- 验证：
  - upgrade → current = head
  - 旧表行数/哈希不变（预期变化白名单）
  - downgrade 到 previous（若安全）
  - 再 upgrade（幂等）
  - 整库 restore 可用
  - 新版本 health + 登录 + 核心功能
- 注意不可逆迁移（本仓库 0026 是例子）：必须停写 + 备份 + 明确接受

### 6.4 候选验收

- 用生产同构数据，不用空库
- 测旧账号、旧内容/进度、缓存命中、迁移后读写
- 截图/日志存档

---

## 7. 阶段 4：生产发布

### 7.1 T-30：公告/冻结

- 公告停服窗口
- 确认无人在改生产数据
- 确认 Release Owner 在线

### 7.2 T-10：备份与离机

```bash
cd /srv/ln/app
docker compose run --rm --no-deps \
  -v /srv/ln/backups:/backups \
  -v /srv/ln/app/scripts:/scripts:ro \
  -e BACKUP_ROOT=/backups -e ENV_FILE=/dev/null \
  --entrypoint /bin/bash app /scripts/backup.sh --keep 7
```

- 复制到离机存储并校验 SHA
- 记录备份文件名/SHA

### 7.3 T-0：停写 + 迁移前快照

```bash
docker compose stop app
# 生成 pre 快照（见 v1.1 runbook）
```

有迁移时：

```bash
docker compose run --rm --no-deps app alembic current
docker compose run --rm --no-deps app alembic heads
docker compose run --rm --no-deps app alembic upgrade head
```

### 7.4 数据回填（如有）

- 先 `--dry-run`
- 再正式回填
- 再跑审计对照
- 回填脚本必须幂等、可重跑、有报告

### 7.5 启动新版本

```bash
docker compose up -d --force-recreate
sleep 5
docker compose ps
curl -fsS http://127.0.0.1:8000/healthz | python3 -m json.tool
```

期望：

- `version=vX.Y.Z`
- `migrations.current == head`
- 容器 healthy

### 7.6 生产冒烟（必过）

- [ ] 旧账号登录
- [ ] 旧文章/视频/词书/进度
- [ ] 新功能主路径
- [ ] 找回密码/邮件（如涉及）
- [ ] 额度/402/429 正常
- [ ] 反馈/管理台（如涉及）
- [ ] 观影/切换/缓存（如涉及）
- [ ] 日志无 traceback

失败则进入回滚，不继续。

---

## 8. 阶段 5：观察与收尾

### 8.1 24 小时

- 5xx、登录失败、429/402、邮件退信
- 备份/磁盘/容器重启
- 用户反馈/数据异常
- 记录到 24h checklist

### 8.2 7 天

- 删除旧镜像/旧备份（仅在确认稳定后）
- 归档发布证据
- 复盘：门禁漏了什么、哪个测试没覆盖
- 把新发现的坑写回流程/测试，不靠记忆

### 8.3 关闭版本

- release notes 发布
- 版本 tag/记录
- 下一版本 backlog

---

## 9. 回滚矩阵

| 情况 | 首选 | 其次 | 最后 |
|---|---|---|---|
| 代码 bug | 旧镜像 `IMAGE_TAG=<old> docker compose up -d --force-recreate` | 修 hotfix | — |
| Schema 不兼容 | 代码回滚（旧代码兼容新库） | `alembic downgrade <previous>`（会丢新数据） | 整库恢复 |
| 数据写坏 | 停止写入 | 整库恢复最近备份 | 人工修补 |
| 邮件/密钥错误 | 回滚配置/密钥 | 停用功能 | 回滚镜像 |
| 缓存串用户 | 立即停 AI/相关功能 | 回滚镜像 | 清缓存/恢复数据 |

原则：

- 先止损，再定位
- 不删备份/旧镜像
- 需要降级数据库时必须明确“会丢哪些数据”

---

## 10. 每次发版必须产出的证据

- release SHA / git tag / 镜像 tag / `APP_VERSION`
- 本地测试输出摘要
- acceptance PASS/FAIL/SKIP 报告
- 迁移演练报告 + 快照比对
- 生产备份文件名/SHA + 离机校验
- health/冒烟截图/日志
- 24h 观察结论
- release notes 链接

---

## 11. No-Go 条件

任一条成立，不发：

- 后端全量测试失败
- 前端 tsc/build/i18n 失败
- 关键 acceptance 未解释 FAIL
- 迁移未在副本演练
- 没有可用的离机备份
- 私有 API 缓存/身份隔离未验证
- 生产 health/migrations 不一致
- 供应商硬限额未确认（涉及成本时）
- Release Owner 未签字

---

## 12. 使用方式

每个版本复制：

```bash
cp docs/release/templates/version-release-checklist.md \
   docs/release/vX.Y.Z-checklist.md
```

填写、逐项打勾、存档。  
流程本身变更时改本文件，不另起一套。

---

## 13. Git tag 与发布标识

候选验收通过后：

```bash
git status --porcelain          # 必须空
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

- tag 必须指向 release SHA
- 镜像 tag 用 release SHA，`APP_VERSION` 用 `vX.Y.Z`
- 生产验证通过后再发 release notes；tag 不随生产结果移动
- 如候选失败，删除本地/远端 tag 后重来，不复用同名 tag

---

## 14. 自动化建议（逐步补齐）

| 阶段 | 自动化 |
|---|---|
| PR | backend pytest、frontend tsc/build/i18n、相关 acceptance |
| 每日 | `bash scripts/release-acceptance-suite.sh` + 缓存隔离 |
| release tag | 构建镜像、生成 release notes 草稿 |
| 生产前 | 备份状态、迁移 head、预算/密钥检查 |
| 生产后 | health/API 冒烟、24h 指标汇总 |

**不要自动化生产迁移本身**：迁移必须有人确认备份、窗口和回滚。

---

## 15. 失败处理

- 本地门禁失败：修到绿，不进入候选
- 构建失败：不部署，旧版本继续跑
- 迁移失败：停写，按备份恢复/降级；不连续重试写库
- 冒烟失败：立即回滚代码，保留现场日志
- 24h 内异常：按回滚矩阵处理，不删证据

---

## 16. 无上下文 Agent 入口

- 快速启动：[AGENT_QUICKSTART.md](./AGENT_QUICKSTART.md)
- 输入模板：[templates/release-input.yaml](./templates/release-input.yaml)
- 固定流程：[agent-process.yaml](./agent-process.yaml)
- 全量验收：`bash scripts/release-acceptance-suite.sh`

## 17. Agent / 人工边界

| 步骤 | Agent | 开发者本人 |
|---|---|---|
| 代码、测试、本地前端构建、本地验收 | ✅ | 复核 |
| 生产镜像构建 / tag / push / 部署 | ❌ | ✅ |
| 数据副本迁移演练 | ✅ | 复核 |
| 生成 release report | ✅ | 阅读 |
| 生产 SSH/凭据/DNS/SMTP/供应商限额 | ❌ | ✅ |
| 生产备份/离机副本 | ❌（只能给命令） | ✅ |
| 生产迁移/回填 | ❌ | ✅（由 Release Owner 执行） |
| 生产冒烟 | ❌（不碰生产） | ✅ 浏览器/真邮箱/管理员 |
| Go/No-Go/回滚决定 | ❌ | ✅ |

- Agent 固定流程：[agent-process.yaml](./agent-process.yaml) + [report schema](./agent-report.schema.json)
- 人工逐步手册：[HUMAN_RUNBOOK.md](./HUMAN_RUNBOOK.md)

---

## 18. 通用性约定（换版本只改输入，不改流程）

1. **版本差异只允许出现在**：
   - `templates/release-input.yaml`（版本、SHA、是否迁移/回填、演练/回填命令）
   - 该版本 release notes / checklist
   - 版本专用迁移/回填脚本
2. **流程文件不写死版本号**：`agent-process.yaml` 不含 v1.1.1 专属路径/脚本名。
3. **新增迁移时**必须提供：
   - `migration_rehearsal_command`
   - 回填时的 `backfill_dry_run_command` / `backfill_apply_command` / `backfill_audit_command`
   - 没有就由 Release Owner 补；Agent 不得即兴执行。
4. **新增 acceptance 脚本**只要命名匹配 `scripts/*acceptance*.mjs`，自动进入全量套件；依赖专用 harness 的必须在脚本头注释并让 Agent 在报告中写 SKIP 原因。
5. **仓库结构变化时**先改 `agent-process.yaml` 的 `repo.required_files` 和 `bootstrap`，不要靠口头约定。
6. **已知限制**：
   - Agent 不能读生产 `.env`、不能执行生产迁移
   - 自动化只到本地门禁 + 数据副本演练
   - 生产镜像构建、备份、迁移、冒烟、回滚由人完成
7. **每次复盘**：如果某次门禁漏了问题，先把检查项写进 `templates/version-release-checklist.md`，再发下一个版本。
8. **TEST-STALE 处理**：验收脚本失败若证明功能已被删除/取代，先建卡退役脚本并更新 spec，再重跑；不得把 FAIL 静默改成 PASS。
9. **FLAKY 处理**：允许重跑一次并记录；同一脚本反复 flaky 必须修等待条件，不能靠重试发版。
