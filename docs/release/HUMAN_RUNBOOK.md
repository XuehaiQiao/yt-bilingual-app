# 人工发布操作手册（Release Owner / 开发者本人）

> Agent 已完成本地门禁并给出 `GO/NO_GO` 报告。  
> 本文只列**必须由人完成**的步骤；生产凭据、迁移窗口、发布决定不能交给 Agent。

## 0. 先读 Agent 报告

- [ ] 打开 `/tmp/release/<version>-<sha>/release-report.md`
- [ ] `status` 必须是 **GO**
- [ ] 无 blocker
- [ ] 记录：release SHA、镜像 tag、备份计划、回滚镜像

如果 `NO_GO` 或 blocker 未解决：停止，不进入生产。

## 1. 确认版本与发布物

```bash
cd /srv/ln/app
git fetch origin
git checkout <release-sha>
git status --porcelain          # 必须空
git rev-parse --short HEAD      # 必须等于 release-sha
```

- [ ] tag 已存在：`git tag -l <version>`；没有则按流程创建并推送
- [ ] 镜像 tag = release SHA
- [ ] `APP_VERSION` 将设置为 `<version>`

## 2. 外部配置（人工）

- [ ] SMTP / `PUBLIC_BASE_URL` 正确（如涉及）
- [ ] Resend 域名 Verified
- [ ] 供应商后台日/月硬限额已设
- [ ] 全局日预算 >0；月预算/告警已确认
- [ ] 邀请码/开户赠送/注册开关符合本版本
- [ ] 离机备份（rclone/对象存储）可用

## 3. 备份与离机副本

```bash
cd /srv/ln/app
docker compose run --rm --no-deps \
  -v /srv/ln/backups:/backups \
  -v /srv/ln/app/scripts:/scripts:ro \
  -e BACKUP_ROOT=/backups -e ENV_FILE=/dev/null \
  --entrypoint /bin/bash app /scripts/backup.sh --keep 7

ls -lh /srv/ln/backups/
sha256sum /srv/ln/backups/linguatrek-backup-*.tar.gz
```

- [ ] 备份包非 0
- [ ] 复制到离机存储
- [ ] 远端可列出
- [ ] 记录文件名/SHA

**没有离机副本，不要继续。**

## 4. 停写与迁移/回填（如涉及）

```bash
cd /srv/ln/app
docker compose stop app

# 迁移前快照（按当前版本脚本）
mkdir -p /tmp/release-final
docker compose run --rm --no-deps \
  -v /tmp/release-final:/out \
  -v /srv/ln/app/scripts:/scripts:ro \
  -e AUTH_DB_PATH=/data/app.db \
  app python /scripts/v11_data_snapshot.py \
  --db /data/app.db --users /data/users --out /out/pre.json

docker compose run --rm --no-deps app alembic current
docker compose run --rm --no-deps app alembic upgrade head
docker compose run --rm --no-deps app alembic current
```

如有数据回填：

```bash
# 先 dry-run，再正式
docker compose run --rm --no-deps \
  -v /srv/ln/app/scripts:/app/scripts:ro \
  app python /app/scripts/<backfill>.py --dry-run --report /tmp/backfill-dry.json
```

- [ ] current == head
- [ ] 快照比对 PASS
- [ ] 回填 dry-run 无 failed
- [ ] 正式回填
- [ ] 回填审计 PASS

任何一步失败：不要启动新版本，按第 8 步回滚。

## 5. 启动新版本

```bash
cd /srv/ln/app
docker compose up -d --force-recreate
sleep 5
docker compose ps
curl -fsS http://127.0.0.1:8000/healthz | python3 -m json.tool
```

- [ ] 容器 Up / healthy
- [ ] `version` = `<version>`
- [ ] `migrations.current == head`
- [ ] 镜像 tag 正确

## 6. 生产冒烟（人工）

逐项打勾：

- [ ] 旧账号登录，不强制改密/验证
- [ ] 旧文章/视频/词书/进度
- [ ] 本版本新功能主路径
- [ ] 找回密码/邮件（如涉及）
- [ ] 我的页额度/402/429
- [ ] 反馈提交 + 管理台（如涉及）
- [ ] 观影/切换/缓存（如涉及）
- [ ] 日志无 traceback

命令：

```bash
docker compose logs --tail=100 app | grep -iE 'traceback|"status": 5[0-9][0-9]' || echo "no obvious 5xx"
```

失败：进入第 8 步，不继续放量。

## 7. Go / No-Go

- [ ] 所有冒烟 PASS
- [ ] 无 P0/P1
- [ ] 备份/离机确认
- [ ] Release Owner 签字

才可对外公告发布完成。

## 8. 回滚（人工决定）

### 8.1 代码回滚（首选）

```bash
cd /srv/ln/app
IMAGE_TAG=<old-release-sha> docker compose up -d --force-recreate
```

数据库保留新版本，旧代码通常兼容增量表/列。

### 8.2 数据库降级（会丢新数据）

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
