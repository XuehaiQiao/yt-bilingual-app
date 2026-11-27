# 人工发布操作手册（Release Owner / 开发者本人）

> 这份手册从 **Agent 本地门禁完成之后** 开始。
> 生产凭据、生产迁移、生产冒烟、Go/No-Go 必须由人执行；Agent 不碰生产。

## 0. 开始前准备

| 需要 | 说明 |
|---|---|
| Agent 报告 | `/tmp/release/<version>-<sha>/release-report.md`，`status=GO` |
| Release 输入 | `/tmp/release-input.yaml`（版本/SHA/迁移/回填/回滚镜像） |
| 生产目录 | `/srv/ln/app` |
| 生产备份目录 | `/srv/ln/backups` |
| 离机存储 | rclone/对象存储，能列出文件 |
| 供应商控制台 | DeepSeek / Qwen 硬限额 |
| 发布决定 | Release Owner 在场 |
| 回滚镜像 | 上一个生产镜像 tag |

如果 Agent 报告 `NO_GO` 或有 blocker：停止。

## 1. 确认版本、构建候选、打 tag

```bash
cd /srv/ln/app
git fetch origin
git checkout <release-sha>
git status --porcelain          # 必须为空
git rev-parse --short HEAD      # 必须等于 release-sha

export VERSION="<vX.Y.Z>"
export RELEASE_SHA="$(git rev-parse --short HEAD)"
export IMAGE_TAG="$RELEASE_SHA"
export APP_VERSION="$VERSION"
```

构建**新镜像**（不要跳过；生产回滚靠旧 tag）：

```bash
docker compose build --pull
docker compose config | grep -E 'image:|APP_VERSION' | head
docker images | grep linguatrek
```

- [ ] 新镜像 tag = release SHA
- [ ] 旧生产镜像 tag 仍存在（回滚用）
- [ ] 已记录旧生产镜像 tag：`OLD_IMAGE=<tag>`
- [ ] `APP_VERSION` 正确

打 tag（候选验收通过后；失败不复用同名 tag）：

```bash
git tag -a "$VERSION" -m "$VERSION"
git push origin "$VERSION"
git tag -l "$VERSION"
```

## 2. 外部配置（人工核对）

- [ ] `.env` 的 `APP_VERSION=$VERSION`
- [ ] `PUBLIC_BASE_URL` 正确
- [ ] SMTP/Resend 域名 Verified（如涉及邮件）
- [ ] DeepSeek/Qwen 后台日/月硬限额已设
- [ ] 全局日预算 >0；月预算/告警已确认
- [ ] 邀请码/开户赠送/注册开关符合此版本
- [ ] 离机备份可用

> 不确定就不发；这些没有代码兜底。

## 3. 生产备份 + 离机副本

```bash
cd /srv/ln/app
mkdir -p /srv/ln/backups
docker compose run --rm --no-deps \
  -v /srv/ln/backups:/backups \
  -v /srv/ln/app/scripts:/scripts:ro \
  -e BACKUP_ROOT=/backups -e ENV_FILE=/dev/null \
  --entrypoint /bin/bash app /scripts/backup.sh --keep 7

ls -lh /srv/ln/backups/linguatrek-backup-*.tar.gz | tail
sha256sum /srv/ln/backups/linguatrek-backup-*.tar.gz | tail
```

- [ ] 备份包非 0
- [ ] 解压列表可读：`tar -tzf <包> | head`
- [ ] 复制到离机存储
- [ ] 远端能列出
- [ ] 记录文件名/SHA

**没有离机副本，不要继续。**

## 4. 停写与迁移/回填（如涉及）

> 没有迁移/回填：跳到第 5 步。  
> 确认方式：Agent 报告 / release-input.yaml 的 `includes_migration`、`includes_backfill`。

```bash
cd /srv/ln/app
export IMAGE_TAG="$(git rev-parse --short HEAD)"
docker compose stop app
```

### 4.1 迁移前证据

- [ ] 记录当前版本：`docker compose run --rm --no-deps app alembic current`
- [ ] 记录旧镜像：`docker inspect` 或部署记录
- [ ] 用本版本 release notes 指定的快照脚本；没有指定就至少保留第 3 步备份
- [ ] 记录 DB 大小/用户目录大小

### 4.2 迁移（只在新镜像上跑）

```bash
docker compose run --rm --no-deps app alembic current
docker compose run --rm --no-deps app alembic heads
docker compose run --rm --no-deps app alembic upgrade head
docker compose run --rm --no-deps app alembic current
```

- [ ] `heads` 唯一
- [ ] `current == head`

失败：立刻停止，不要反复 upgrade；按第 8 步回滚。

### 4.3 数据回填（如有）

命令必须来自 `release-input.yaml` 或 release notes；不要即兴写 SQL。

```bash
# dry-run
docker compose run --rm --no-deps \
  -v /srv/ln/app/scripts:/app/scripts:ro \
  app python /app/scripts/<backfill>.py --dry-run --report /tmp/backfill-dry.json

# 正式
docker compose run --rm --no-deps \
  -v /srv/ln/app/scripts:/app/scripts:ro \
  app python /app/scripts/<backfill>.py --report /tmp/backfill.json

# 审计
docker compose run --rm --no-deps \
  -v /srv/ln/app/scripts:/app/scripts:ro \
  app python /app/scripts/<audit>.py --out /tmp/audit.json
```

- [ ] dry-run failed=0
- [ ] 正式回填成功
- [ ] 审计无异常/符合预期
- [ ] 记录报告路径

## 5. 启动新版本

```bash
cd /srv/ln/app
export IMAGE_TAG="$(git rev-parse --short HEAD)"
docker compose up -d --force-recreate
sleep 5
docker compose ps
curl -fsS http://127.0.0.1:8000/healthz | python3 -m json.tool
```

- [ ] 容器 Up / healthy
- [ ] `version` = `$VERSION`
- [ ] `migrations.current == head`
- [ ] 镜像 tag = `$IMAGE_TAG`

## 6. 生产冒烟（人工）

按版本勾选，至少：

- [ ] 旧账号登录，未强制改密/验证
- [ ] 旧文章/视频/词书/进度
- [ ] 本版本新功能主路径
- [ ] 找回密码/邮件（如涉及）
- [ ] 我的页额度 / 402 / 429
- [ ] 反馈提交 + 管理台（如涉及）
- [ ] 观影/切换/缓存（如涉及）
- [ ] 首页/文案/移动端（如涉及）

命令：

```bash
curl -fsS http://127.0.0.1:8000/healthz
docker compose logs --tail=100 app | grep -iE 'traceback|"status": 5[0-9][0-9]' || echo "no obvious 5xx"
```

失败：进入第 8 步。

## 7. Go / No-Go

只有全部成立才公告完成：

- [ ] 冒烟全 PASS
- [ ] 无 P0/P1
- [ ] 备份/离机确认
- [ ] 迁移/回填审计通过
- [ ] Release Owner 签字

## 8. 回滚（人工决定）

### 8.1 代码回滚（首选）

```bash
cd /srv/ln/app
export IMAGE_TAG="<old-release-sha>"
docker compose up -d --force-recreate
curl -fsS http://127.0.0.1:8000/healthz
```

DB 保留新版本；旧代码通常兼容增量表/列。

### 8.2 DB 降级（会丢新数据）

```bash
docker compose stop app
docker compose run --rm --no-deps app alembic downgrade <previous-revision>
docker compose up -d
```

先确认：

- [ ] 新版本写入的数据可丢
- [ ] 有备份
- [ ] 已停写

### 8.3 整库恢复（最后手段）

```bash
docker compose stop app
docker compose run --rm --no-deps \
  -v /srv/ln/backups:/backups \
  -v /srv/ln/app/scripts:/scripts:ro \
  --entrypoint /bin/bash app \
  /scripts/restore.sh /backups/<backup>.tar.gz --to /data --force
docker compose start app
```

- [ ] integrity_check ok
- [ ] 旧账号/旧数据冒烟

## 9. 发布后 24 小时

- [ ] 5xx/登录失败/429/402
- [ ] 邮件退信
- [ ] 备份/磁盘/容器
- [ ] 用户反馈
- [ ] 24h 检查单归档

## 10. 收尾

- [ ] release notes
- [ ] tag/镜像/版本记录
- [ ] 7 天内不删旧镜像/备份
- [ ] 复盘：哪个门禁漏了，补测试/流程
