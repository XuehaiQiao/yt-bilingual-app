# 部署执行手册 —— linguatrekai.online（G1 邀请制）

> 适用对象：本次 G1 海外 VPS 上线（域名 `linguatrekai.online`，VPS `43.245.199.136`）。
> 本手册只覆盖**部署层**（DNS、系统、Docker/裸机、Caddy、TLS、访问控制、备份、告警、验收、回滚），不改业务代码，不改
> [项目提案-上线功能.md](./项目提案-上线功能.md) / [上线前任务清单-web.md](./上线前任务清单-web.md) 的决策。
>
> **执行状态说明**：本手册由 M6a 编写，作者**没有 SSH 登录、没有部署服务器**（无凭据）。
> 文中命令除特别注明外均**未在目标 VPS 执行**；Caddy 配置只在本机用 Caddy 2.11.9 做过
> `validate` 与本地行为测试，Docker 镜像未在本机构建（本机 Docker daemon 未运行）。
> 每一条涉及目标机的命令都应在执行时记录实际输出，不能把“文档写了”当成“已经通过”。

---

## 0. 已知事实、边界与路径选择

### 0.1 已确认的信息

| 项 | 当前值 | 备注 |
|---|---|---|
| 域名 | `linguatrekai.online` | `www` 需要 301 到主域 |
| VPS IPv4 | `43.245.199.136` | GigsGigsCloud HKG-Global-K03，2 vCPU / 4 GB / 50 GB，香港 |
| 应用 | FastAPI 单 worker + SQLite + React `frontend/dist` | 同域部署；不要多 worker/多副本 |
| 访问控制 | G1：应用内邀请码；公开注册关闭；Caddy 层无认证（网关已于 2026-11-20 移除） | 不再有网关账号，一人一邀请码 |
| 本次 DNS 实测（2026-11-20） | `dig @1.1.1.1` → `43.245.199.136`（主域与 www 都是） | 公网解析已指向 VPS |
| 本机 resolver（作者环境） | 主域 `198.18.0.70`、www `198.18.0.74` | `198.18.0.0/15` 常见于代理 fake-IP，**不代表 DNS 未生效** |
| SSH 认证 | 未知 | 先确认 provider 控制台/默认账号，不要反复试密码 |
| 服务器 OS | 未确认 | 以下按 **Ubuntu 22.04/24.04** 写；若为 Debian/CentOS/Alma，包管理命令需替换 |

> **DNS 结论**：不要因为本机 `dig` 返回 `198.18.x.x` 就去改 DNS。先在 `1.1.1.1`/`8.8.8.8`/手机蜂窝网络复核；
> 本机 fake-IP 只能说明“本机代理接管了解析”。目标网络（你的浏览器/监控）仍需单独验证。

### 0.2 两条部署路径，二选一

| | **路径 A：Docker（推荐）** | 路径 B：裸机 systemd |
|---|---|---|
| 适合 | 想要可复现、少装系统依赖；单机最简单 | 不想装 Docker、想直接控制进程 |
| 静态文件 | 容器内 `deploy/serve.py` 服务 `frontend/dist` | Caddy 直接服务 `/srv/ln/current/frontend/dist` |
| API | 容器内 uvicorn 单 worker，映射 `127.0.0.1:8000` | systemd + uvicorn 单 worker，`127.0.0.1:8000` |
| Caddy 配置 | `deploy/Caddyfile.g1.proxy`（全量反代） | `deploy/Caddyfile.g1`（静态 + `/api` 反代） |
| 数据 | Docker 命名卷 `linguatrek-data` → `/data` | `/srv/ln/data` |
| 环境变量 | `/srv/ln/app/.env`（600） | `/etc/linguatrek/env`（600，ln:ln） |
| 备份 | `docker compose run ... scripts/backup.sh` | cron 调 `scripts/backup.sh` |
| 升级/回滚 | 镜像 tag | `/srv/ln/releases/<stamp>` 符号链接 |

**推荐路径 A（Docker）**：本手册以 A 为主线；B 的关键差异单独成节，避免两套命令混杂。

> 这里的“二选一”指**应用运行方式**，不是“Docker 与 Caddy 只装一个”：
> 两条路径都由宿主机 Caddy 终止 TLS。Docker 路径 = Docker 跑应用 + 宿主机 Caddy 反代；
> 裸机路径 = systemd 跑应用 + 宿主机 Caddy 服务静态/反代。裸机路径不需要 Docker。

无论哪条路径，以下四条不变：**同域、单写进程、SQLite WAL、每日离机备份**。

### 0.3 本手册不承诺的事

- 不承诺“按顺序执行一定全绿”。DNS 传播、机房网络、Cloudflare、证书签发、模型 Key、飞书机器人权限都可能失败。
- 不承诺 SSH 可用、provider 防火墙已放行、目标 OS 是 Ubuntu；这些必须现场确认。
- 不承诺 SSE 30 分钟、本地视频文件句柄、402、导出/删除已经通过；它们是**验收项**，不是已知结果。
- 不在本手册写任何真实密码、API Key、webhook、证书私钥或邀请码明文。

### 0.4 开始前必须准备好的东西

- [ ] 域名注册商账号（能改 A/CNAME；知道到期日）
- [ ] VPS provider 控制台（能看开机状态、重装、VNC/救援模式、防火墙/安全组）
- [ ] 一个可用的 SSH 入口（密钥优先；不知道认证方式就先走控制台）
- [ ] `ADMIN_EMAILS` 要用的邮箱（必须真实可登录；G1 期间管理员要靠它进后台生成邀请码）
- [ ] 至少一个模型 Key：`DEEPSEEK_API_KEY`；越南语目标再准备 `QWEN_API_KEY`
- [ ] G1 邀请码方案：管理员邮箱 + 一次性邀请码（每人一码，30 天有效）；网关账号已不需要
- [ ] 飞书群 + 自定义机器人（可选，但上线前建议有；没有就至少接一个外部 uptime）
- [ ] 离机备份目标（对象存储/S3 兼容/另一台机器，自行选择；本手册不绑定供应商）

---

## 1. 上线前决策与冻结

### 1.1 先冻结发布物

在本地/CI 记录本次要部署的 commit 或 tag：

```bash
cd /path/to/yt-bilingual-app
git status --short          # 应为空；部署物不应夹带未提交改动
git rev-parse HEAD          # 记录完整 commit
git describe --tags --always
```

> 部署前确认工作区干净，不要把未提交/无关文件带进 release。本文不执行 `git commit`。

### 1.2 凭据清单（只记“需要哪些”，不记值）

| 变量/凭据 | 用途 | 放哪里 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 默认模型 | 应用 env（600） |
| `QWEN_API_KEY` / `QWEN_BASE_URL` | 越南语路线（可选） | 应用 env（600） |
| `GEMINI_API_KEY` | 可选；香港出口需实测 | 应用 env（600） |
| `ADMIN_EMAILS` | 管理员邮箱 | 应用 env（600） |
| `INVITE_CODE_PEPPER` | 邀请码 HMAC pepper | 应用 env（600），`openssl rand -hex 32` |
| `EVENTS_PSEUDONYM_SALT` | 学习事件假名盐 | 应用 env（600），`openssl rand -hex 32` |
| `FEISHU_WEBHOOK_URL` / `FEISHU_WEBHOOK_SECRET` | 飞书告警 | 应用 env（600） |
| 对象存储凭据 | 离机备份 | `rclone config` 的受保护配置，不进仓库 |

### 1.3 不要做的事

- 不要设置 `API_AUTH_KEY`：它会拦截所有 `/api`（含 `/api/auth/*`），浏览器登录直接 401。
- 不要设置 `VITE_API_KEY`：会被打进前端 bundle，等于公开密钥。
- 不要在 shell 历史里 `export DEEPSEEK_API_KEY=sk-...`；用编辑器/`read -rsp` 写 env 文件。
- 不要把 `.env`、`data/`、`history/`、`subtitles/`、证书私钥、邀请码明文提交/截图/发群。
- 不要打开 `REGISTRATION_OPEN=true`；网关已摘除，但注册仍必须邀请制，开放公开注册要单独评审。

---

## 2. DNS 检查与切换

### 2.1 在域名商处确认记录

推荐用 A 记录（不要用 AAAA，除非 VPS 确有可用 IPv6）：

```text
类型   名称    值                  TTL
A      @      43.245.199.136      300
A      www    43.245.199.136      300
```

也可以 `www` 用 CNAME 指向 `@`；Caddy 需要能对 `www.linguatrekai.online` 单独签发证书。

> 如果域名商不支持 `@`，填域名本身；不要留空。改完等 TTL 过期（本次 300s 起步）。
> Cloudflare 用户：**首次签发证书前先设 DNS only（灰云）**，不要一上来橙云。

### 2.2 从多个出口验证

```bash
dig +short A linguatrekai.online @1.1.1.1
dig +short A linguatrekai.online @8.8.8.8
dig +short A www.linguatrekai.online @1.1.1.1
dig +short A www.linguatrekai.online @8.8.8.8
```

期望四个输出都是 `43.245.199.136`（或 www 的 CNAME 最终解析到它）。

再看本机：

```bash
dig +short A linguatrekai.online
dig +short A www.linguatrekai.online
```

如果本机返回 `198.18.x.x` / `198.19.x.x`：

- 这是保留的 benchmark 网段，常见于 Clash/Surge 等代理的 fake-IP；
- 不要改 DNS 记录；
- 用手机蜂窝网络（关闭 Wi-Fi/VPN）或 `curl --resolve` 再验证；
- 本仓库的 `scripts/preflight-production.sh` 检测到 fake-IP 时会自动用 `--resolve` 直连 VPS 做 HTTPS 检查，但仍会单独报告公网 DNS。

### 2.3 目标网络复核（上线前必做）

在**不经过本机代理**的网络（手机 4G/5G、另一台云主机）执行：

```bash
curl -sSI --max-time 10 https://linguatrekai.online/ | head
```

如果这里连不上，但本机 `@1.1.1.1` 正常，问题通常在目标网络/代理，不在 DNS。

### 2.4 Cloudflare 灰云 / 橙云

- **G1 首次上线建议灰云（DNS only）**：先让 Caddy 完成 HTTP-01 证书签发，排除代理变量。
- 橙云（Proxied）会改变 TLS 终止、缓存和空闲超时；Cloudflare 默认 100s 空闲超时，SSE 必须确认后端
  15s 心跳已生效，并实测 30 分钟长流。
- 橙云时 SSL/TLS 模式用 **Full (strict)**；不要用 Flexible（会回源 HTTP，且可能循环）。
- 橙云可能缓冲/压缩 SSE；如果 30 分钟流仍被切断，先切回灰云定位，不要在应用层“加大超时”掩盖。
- 如果以后要限制源站只接受 Cloudflare 回源，需要额外的防火墙/IP 列表策略，不属于本次 G1 的第一天范围。

---

## 3. SSH 登录与服务器初始化

### 3.1 先确认能登录，不要猜密码

在 provider 控制台确认：

- 实例状态、公网 IP、默认用户名（`root` / `ubuntu` / `debian` 等）；
- 是否已注入 SSH key；
- 是否有 VNC/救援模式（万一 SSH 配错可以救回）；
- provider 自带防火墙/安全组是否放行 22/80/443（与系统 UFW 是两层）。

从本机测试（**只测试连通性，不反复试密码**）：

```bash
ssh -o BatchMode=yes -o ConnectTimeout=5 <user>@43.245.199.136 'echo connected; id'
```

- `BatchMode=yes` 只用密钥，不会卡在密码提示；
- 失败就回控制台确认认证方式/重置密钥，不要连续爆破。

> 本次 M6a 没有 SSH 凭据，作者未执行本节；SSH 认证方式仍未知。

### 3.2 创建非 root 用户 `ln`

以 provider 默认账号或 root 登录后：

```bash
sudo adduser --disabled-password --gecos "" ln
sudo usermod -aG sudo ln
sudo install -d -m 700 -o ln -g ln /home/ln/.ssh
```

在本机生成专用密钥（不要复用个人主密钥）：

```bash
ssh-keygen -t ed25519 -a 100 -C "ln@linguatrekai-$(date +%F)"
# 默认写到 ~/.ssh/id_ed25519；有旧密钥时用 -f 指定新文件名
```

把公钥装到服务器（推荐 `ssh-copy-id`，会走密码/已有密钥）：

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub ln@43.245.199.136
```

或者手工追加（在服务器上以 `ln` 身份）：

```bash
# 本机
cat ~/.ssh/id_ed25519.pub
# 服务器
sudo -u ln tee -a /home/ln/.ssh/authorized_keys
sudo chmod 600 /home/ln/.ssh/authorized_keys
sudo chown ln:ln /home/ln/.ssh/authorized_keys
```

**验证新会话可用后再改 sshd**：

```bash
ssh -i ~/.ssh/id_ed25519 ln@43.245.199.136 'sudo -n true && echo sudo-ok'
```

### 3.3 SSH 加固（保留当前会话，别把自己锁在外面）

```bash
sudo tee /etc/ssh/sshd_config.d/99-linguatrek.conf >/dev/null <<'EOF'
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
EOF

sudo sshd -t
sudo systemctl reload ssh 2>/dev/null || sudo systemctl reload sshd
```

- 先开一个新终端验证 `ssh -i ... ln@...` 仍可登录，再关闭旧会话。
- 如果 `sshd -t` 报错，先修配置，不要 reload。
- 仅当 provider 的救援控制台可用时才考虑 `AllowUsers`；配错会锁死。

### 3.4 防火墙：22/80/443

```bash
sudo apt update
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

同时检查 provider 控制台的安全组/防火墙：只放 22/80/443，不要放 8000。

> **Docker + UFW 的坑**：Docker 发布的端口会走 nat 表，可能绕过 UFW。本仓库 `docker-compose.yml`
> 只发布 `127.0.0.1:8000:8000`，所以公网仍不可达；**不要**改成 `8000:8000` 或 `--publish 0.0.0.0:8000`。
> 若以后改了端口映射，必须自己再加 DOCKER-USER 链规则。

### 3.5 时区、NTP、自动安全更新

```bash
sudo timedatectl set-timezone Asia/Shanghai      # 或 UTC；全机一致即可
sudo timedatectl set-ntp true
timedatectl

sudo apt install -y unattended-upgrades apt-listchanges
sudo dpkg-reconfigure -plow unattended-upgrades   # 选择自动安装安全更新
```

飞书签名依赖服务器时间；NTP 没同步会出现 `feishu_code_*` 签名失败。

### 3.6 Swap（4 GB 内存的保险）

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo sysctl vm.swappiness=10
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-linguatrek.conf
free -h
```

50 GB 磁盘不算大；swap 只防 OOM，不替代监控磁盘。

### 3.7 目录与权限

```bash
sudo mkdir -p /srv/ln/app /srv/ln/backups
sudo mkdir -p /srv/ln/data/{history,subtitles,users,guests,exports,home,alerts}
sudo chown -R ln:ln /srv/ln
sudo chmod 755 /srv/ln /srv/ln/app
sudo chmod 700 /srv/ln/data /srv/ln/data/users /srv/ln/data/guests /srv/ln/backups
```

裸机路径还需要：

```bash
sudo mkdir -p /srv/ln/releases
sudo chmod 755 /srv/ln/releases
```

> Docker 命名卷会自动继承镜像内 `/data` 的 UID 1000，通常不需要手工 chown；
> 只有改成 bind mount 时才需要 `sudo chown -R 1000:1000 /srv/ln/data`。

### 3.8 基础软件

```bash
sudo apt install -y curl git rsync sqlite3 jq unzip ca-certificates cron dnsutils openssl rclone
```

- `dnsutils` 提供 `dig`；`sqlite3` 是备份一致性快照与 integrity_check 需要；
- `rclone` 用于离机备份（可选，但建议装）；
- `jq` 只用于运维排查，不是应用依赖。

---

## 4. 路径 A：Docker（推荐）

### 4.1 安装 Docker Engine 与 Compose 插件

官方 apt 仓库（比 `curl | sh` 更容易审计和回滚）：

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker ln
```

重新登录 `ln`（或 `newgrp docker`）后验证：

```bash
docker --version
docker compose version
docker run --rm hello-world
```

> `hello-world` 需要拉镜像/联网；失败时先查 DNS、代理、Docker daemon，不要把网络问题当成应用问题。

### 4.2 取代码到 `/srv/ln/app`

```bash
sudo -u ln git clone https://github.com/huthvincent/yt-bilingual-app.git /srv/ln/app
cd /srv/ln/app
sudo -u ln git checkout <本次冻结的 tag/commit>
```

- 生产固定 tag/commit，不要直接跟 `main`。
- 仓库若已迁移/私有，改成你的远端；或在本机 `rsync` 上传（排除 `.git`/`data`/`history`/`subtitles`/`.env`）。
- 不要在生产目录里 `git pull` 到一半再修；每次发布用明确 commit。

### 4.3 准备生产 env

```bash
cd /srv/ln/app
sudo -u ln cp deploy/production.env.example .env
sudo -u ln chmod 600 .env
sudo -u ln "${EDITOR:-vi}" .env
```

逐项填：

| 变量 | 本次建议值/动作 |
|---|---|
| `DOMAIN` | `linguatrekai.online`（部署脚本/preflight 用；应用不读） |
| `VITE_API_BASE` | `https://linguatrekai.online`（构建期写死，不带尾斜杠） |
| `CORS_ORIGINS` | `https://linguatrekai.online`（只主域，不要 `*`） |
| `COOKIE_SECURE` | `1` |
| `ADMIN_EMAILS` | 你的管理员邮箱（必填；留空 = 没有管理员） |
| `REGISTRATION_OPEN` | `false` |
| `INVITE_SIGNUP_ENABLED` | `true` |
| `INVITE_CODE_PEPPER` | `openssl rand -hex 32` 生成 |
| `EVENTS_PSEUDONYM_SALT` | `openssl rand -hex 32` 生成 |
| `SIGNUP_BONUS_MICRO_USD` | `2000000`（$2.00） |
| `DEFAULT_MODEL` | `deepseek-chat` |
| `DEEPSEEK_API_KEY` | 你的 Key |
| `MODEL_ROUTE_ZH_CN` | `deepseek-chat` |
| `MODEL_ROUTE_VI_VN` | `deepseek-chat`（M7a：Qwen 缺可核实单价，已从路线移除） |
| `QWEN_BASE_URL` | 香港/海外 VPS 用国际站；Key 必须同站 |
| `FEISHU_*` | 先留空/关闭，等 §8 再开 |
| `APP_VERSION` | 可填本次 commit/tag，便于 healthz 核对 |
| 路径 | Docker 段保持 `/data`；裸机段全部注释 |

生成两个随机值（不要粘到聊天/工单，直接填进 `.env`）：

```bash
openssl rand -hex 32      # INVITE_CODE_PEPPER
openssl rand -hex 32      # EVENTS_PSEUDONYM_SALT
```

填完后检查（不要打印密钥值）：

```bash
cd /srv/ln/app
sudo -u ln grep -E '^(DOMAIN|CORS_ORIGINS|COOKIE_SECURE|REGISTRATION_OPEN|INVITE_SIGNUP_ENABLED|SIGNUP_BONUS_MICRO_USD|DEFAULT_MODEL|VITE_API_BASE)=' .env

# 禁用项必须没有输出：
sudo -u ln grep -E '^(API_AUTH_KEY|VITE_API_KEY)=' .env && echo '❌ 删除这两行' || echo 'OK: 没有禁用项'

# 只判断是否非空，不打印值：
for k in ADMIN_EMAILS DEEPSEEK_API_KEY EVENTS_PSEUDONYM_SALT INVITE_CODE_PEPPER; do
  sudo -u ln grep -q "^$k=." .env && echo "$k 已填" || echo "❌ $k 为空"
done

ls -l .env    # 期望 -rw------- ln ln
```

### 4.4 构建镜像

```bash
cd /srv/ln/app
export IMAGE_TAG=$(git rev-parse --short HEAD)
docker compose build --pull
```

- `docker-compose.yml` 的 build args 会读 `.env` 里的 `VITE_API_BASE`；**改域名必须重建**。
- 构建产物里的 `127.0.0.1:8000` 兜底字符串是正常的（见 `frontend/src/lib/api.ts`），以正式域名存在、浏览器 Network 实际指向正式域为准。
- 构建失败先看 `docker compose build` 日志；不要用旧镜像假装新版本。

### 4.5 首次迁移（先备份，再迁移）

首次部署数据库还不存在；先建目录/权限，再迁移：

```bash
cd /srv/ln/app
docker compose run --rm app alembic upgrade head
docker compose run --rm app alembic current
docker compose run --rm app alembic heads
```

- 期望 `current` 与 `heads` 一致；本仓库当前快照的 head 是 `0025_balance_cost`，但**不要照抄**，以 `alembic heads` 输出为准。
- 旧文档里的 `0012_exam` 是过期示例；迁移验收只看 `alembic current` 与 `alembic heads`。
- 不要对已有旧库 `alembic stamp head`；旧库升级按 `docs/开发指南.md` 的迁移一节。
- 生产升级时：**先按 §7 做备份**，再迁移；迁移失败先停，不要连续重试写库。

### 4.6 启动与健康检查

```bash
cd /srv/ln/app
docker compose up -d
docker compose ps          # STATUS 应为 Up (healthy)，首次等 30s 左右
docker compose logs --tail=100 app
```

```bash
curl -fsS http://127.0.0.1:8000/healthz | python3 -m json.tool
# 期望 status=ok、db.ok=true、db.migrations.current=head
curl -fsS -o /dev/null -w 'index=%{http_code}\n' http://127.0.0.1:8000/
docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q app)"
```

容器内是 `uvicorn serve:app`（单 worker）；端口只发布到宿主机 `127.0.0.1:8000`。

### 4.7 数据卷与权限

默认命名卷 `linguatrek-data` → `/data`，不需要手工 chown。确认：

```bash
docker volume ls | grep linguatrek
docker compose exec app sh -lc 'ls -ld /data /data/app.db; id'
```

如果改成 bind mount（不推荐，除非你明确知道 UID）：

```yaml
# docker-compose.yml
volumes:
  - /srv/ln/data:/data
```

```bash
sudo chown -R 1000:1000 /srv/ln/data
```

否则容器会报 `ERROR: 数据目录不可写`。

### 4.8 日志与资源

```bash
docker compose logs -f app            # Ctrl-C 退出，不影响容器
docker stats --no-stream
df -h /srv/ln
```

- 日志驱动已限制 `max-size=10m`、`max-file=5`；
- 单 worker 是硬约束，`docker compose up --scale app=2` 会破坏 SQLite/进程内限流，不要用。

---

## 5. 路径 B：裸机 systemd（备选）

> 只有明确不想装 Docker 时才走这里。以下假设 Ubuntu 24.04（Python 3.12 可用）；
> Ubuntu 22.04 请把 `python3.12` 换成系统可用的 Python 3.11/3.10 并先确认依赖支持。

### 5.1 安装 Python / Node

```bash
sudo apt install -y python3.12 python3.12-venv python3-pip sqlite3 rsync rclone
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
python3.12 --version && node --version
```

Node 只用于构建前端；不想在 VPS 装 Node，可在本地构建后只上传 `frontend/dist`（见 §5.6）。

### 5.2 发布一个 release

```bash
STAMP=$(date -u +%Y%m%dT%H%M)
sudo -u ln git clone https://github.com/huthvincent/yt-bilingual-app.git /srv/ln/releases/$STAMP
sudo -u ln git -C /srv/ln/releases/$STAMP checkout <tag/commit>

sudo -u ln python3.12 -m venv /srv/ln/releases/$STAMP/venv
sudo -u ln /srv/ln/releases/$STAMP/venv/bin/pip install --upgrade pip
sudo -u ln /srv/ln/releases/$STAMP/venv/bin/pip install -r /srv/ln/releases/$STAMP/backend/requirements.txt

sudo -u ln bash -lc "cd /srv/ln/releases/$STAMP/frontend && \
  VITE_API_BASE=https://linguatrekai.online npm ci && \
  VITE_API_BASE=https://linguatrekai.online npm run build"

sudo ln -sfn /srv/ln/releases/$STAMP /srv/ln/current
sudo chmod -R a+rX /srv/ln/releases/$STAMP/frontend/dist
```

### 5.3 环境变量文件

```bash
sudo install -d -m 750 -o root -g ln /etc/linguatrek
sudo install -m 600 -o ln -g ln /dev/null /etc/linguatrek/env
sudo -u ln "${EDITOR:-vi}" /etc/linguatrek/env
```

把 `deploy/production.env.example` 内容写进去，然后：

- **取消注释**“裸机路径”段（`/srv/ln/...`）；
- **注释掉**“Docker 路径”段（`/data`、`/app/content/...`）；
- `DOMAIN`/`CORS_ORIGINS`/`VITE_API_BASE` 仍用正式域名；
- 不要写 `API_AUTH_KEY`/`VITE_API_KEY`。

```bash
sudo chown ln:ln /etc/linguatrek/env
sudo chmod 600 /etc/linguatrek/env
sudo -u ln grep -E '^(DATA_DIR|AUTH_DB_PATH|CORS_ORIGINS|COOKIE_SECURE)=' /etc/linguatrek/env
```

### 5.4 首次迁移

```bash
sudo -u ln bash -lc 'set -a; . /etc/linguatrek/env; set +a; \
  cd /srv/ln/current/backend && /srv/ln/current/venv/bin/alembic upgrade head'
sudo -u ln bash -lc 'set -a; . /etc/linguatrek/env; set +a; \
  cd /srv/ln/current/backend && /srv/ln/current/venv/bin/alembic current'
sudo -u ln bash -lc 'set -a; . /etc/linguatrek/env; set +a; \
  cd /srv/ln/current/backend && /srv/ln/current/venv/bin/alembic heads'
```

### 5.5 systemd

```bash
sudo cp /srv/ln/current/deploy/linguatrek.service /etc/systemd/system/linguatrek.service
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/linguatrek.service   # 可选
sudo systemctl enable --now linguatrek
systemctl status linguatrek --no-pager
journalctl -u linguatrek -f
```

服务只监听 `127.0.0.1:8000`，已带单 worker、`NoNewPrivileges`、`ProtectSystem=strict`、
`ReadWritePaths=/srv/ln/data /srv/ln/subtitles /srv/ln/backups`、`Restart=always`。

### 5.6 不在服务器装 Node 的发布方式

本机构建：

```bash
cd frontend
VITE_API_BASE=https://linguatrekai.online npm ci
VITE_API_BASE=https://linguatrekai.online npm run build
```

上传（示例；`<host>` 替换为 SSH 目标）：

```bash
STAMP=$(date -u +%Y%m%dT%H%M)
ssh <host> "sudo mkdir -p /srv/ln/releases/$STAMP/{frontend,backend,content} && sudo chown -R ln:ln /srv/ln/releases/$STAMP"
rsync -az --delete frontend/dist/ <host>:/srv/ln/releases/$STAMP/frontend/dist/
rsync -az backend/ <host>:/srv/ln/releases/$STAMP/backend/ --exclude venv --exclude __pycache__
rsync -az content/ <host>:/srv/ln/releases/$STAMP/content/
ssh <host> "sudo -u ln python3.12 -m venv /srv/ln/releases/$STAMP/venv && \
  sudo -u ln /srv/ln/releases/$STAMP/venv/bin/pip install -r /srv/ln/releases/$STAMP/backend/requirements.txt"
ssh <host> "sudo ln -sfn /srv/ln/releases/$STAMP /srv/ln/current && sudo systemctl restart linguatrek"
```

---

## 6. Caddy、TLS 与访问控制（无网关认证）

### 6.1 安装 Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
caddy version          # 建议 >= 2.8（当前生产 2.11.9）
```

官方说明：<https://caddyserver.com/docs/install#debian-ubuntu-raspbian>。

### 6.2 选择 Caddyfile

| 路径 | 使用文件 | 说明 |
|---|---|---|
| Docker | `deploy/Caddyfile.g1.proxy` | 全量反代到 `127.0.0.1:8000`；容器内服务静态文件 |
| 裸机 | `deploy/Caddyfile.g1` | Caddy 服务 `/srv/ln/current/frontend/dist` + `/api` 反代 |

两者都已包含：

- `linguatrekai.online` 与 `www.linguatrekai.online`；
- www 301 到主域；
- HSTS/CSP/X-Content-Type-Options/Referrer-Policy/Permissions-Policy；
- `frontend/dist` 静态 + SPA fallback（仅 `.g1`）；
- `/api/*` SSE `flush_interval -1` + 24h 超时；
- 无 Caddy 层认证：`/`、`/api/*` 直接到应用，访问控制由应用内邀请码负责；
- `/healthz`、`/health` 直通后端（`.g1` 裸机模板用 handle 单独转发）；
- 访问日志删除下载 URL 的 `token`/`access_token`/`api_key` 查询参数。

先备份系统自带配置：

```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)
```

复制对应文件：

```bash
# Docker
sudo cp /srv/ln/app/deploy/Caddyfile.g1.proxy /etc/caddy/Caddyfile
# 裸机
# sudo cp /srv/ln/app/deploy/Caddyfile.g1 /etc/caddy/Caddyfile

sudo chown root:caddy /etc/caddy/Caddyfile
sudo chmod 640 /etc/caddy/Caddyfile
```

> Caddy 服务通常以 `caddy` 用户运行，所以配置必须对 `caddy` 组可读；不要用 600 root 把服务读不到。

### 6.3 访问控制与 `/etc/caddy/g1.env`

**G1 只用应用内邀请码，不再有网关账号。** 2026-11-20 起线上 Caddy 只做 TLS + 反代：
不要执行 `caddy hash-password`，不要建 `/etc/caddy/g1-users.caddy`，也不要给任何人发
g1 账号/密码。访问控制由应用层负责（`REGISTRATION_OPEN=false` +
`INVITE_SIGNUP_ENABLED=true`，注册必须带一次性邀请码，见 §9.3）。

`/etc/caddy/g1.env` 只需一项：

```ini
ACME_EMAIL=ops@linguatrekai.online
```

```bash
sudo install -m 600 -o root -g root /dev/null /etc/caddy/g1.env
sudo "${EDITOR:-vi}" /etc/caddy/g1.env   # 只写 ACME_EMAIL
sudo chown root:root /etc/caddy/g1.env && sudo chmod 600 /etc/caddy/g1.env
```

- 文件权限 600 root；systemd 以 root 读取 EnvironmentFile，再以 caddy 用户运行 Caddy。
- 不要再往里加任何凭据型环境变量（网关用户名/哈希之类）。

Caddy 官方 systemd 单元通常带 `--environ`，会把进程环境打印进 journal。建议用 drop-in
去掉它并加载 env：

```bash
sudo install -d -m 755 /etc/systemd/system/caddy.service.d
sudo tee /etc/systemd/system/caddy.service.d/10-g1-env.conf >/dev/null <<'EOF'
[Service]
EnvironmentFile=/etc/caddy/g1.env
# 清空官方 ExecStart 里的 --environ，避免把进程环境写进日志
ExecStart=
ExecStart=/usr/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
EOF

sudo systemctl daemon-reload
sudo systemctl enable caddy
sudo systemctl restart caddy
```

检查：

```bash
systemctl cat caddy | grep -E 'ExecStart|EnvironmentFile'
# 期望 ExecStart 不含 --environ；EnvironmentFile 指向 /etc/caddy/g1.env
caddy version
sudo caddy validate --config /etc/caddy/Caddyfile --envfile /etc/caddy/g1.env
```

> `caddy validate` 只保证语法与适配通过，不代表线上行为正确；必须再按 §6.5 实测
> 200 / `/healthz` / www 301 与邀请码注册闸门。

### 6.4 启动/重载与证书

```bash
sudo systemctl reload caddy       # 配置改动
sudo journalctl -u caddy -f       # 观察证书签发；Ctrl-C 退出
```

首次签发需要：

- 80/443 已放行（provider + UFW）；
- `linguatrekai.online` / `www` 解析到本机；
- Cloudflare 为灰云（首次）；
- 服务器时间准确。

日志里看到证书获取成功后，继续验证：

```bash
curl -sSI https://linguatrekai.online/ | head -20
curl -sSI https://www.linguatrekai.online/ | head -8
```

### 6.5 验证 200 / health / www 301 / 邀请码

```bash
curl -sSI https://linguatrekai.online/ | head -20
# 期望 200，且没有 WWW-Authenticate；带 HSTS/CSP 等安全头

curl -sSI https://linguatrekai.online/healthz | head -20
# 期望 200（JSON），且没有 WWW-Authenticate

curl -sSI https://linguatrekai.online/health | head -20
# 期望 200

curl -sSI https://www.linguatrekai.online/ | head -10
# 期望 301，Location: https://linguatrekai.online/...
```

注册闸门（公开只读 + 一次无码注册）：

```bash
curl -sS https://linguatrekai.online/api/auth/registration; echo
# 期望 registrationOpen=false、inviteRequired=true

curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Content-Type: application/json' \
  -d '{"email":"noinvite-<时间戳>@example.invalid","password":"<一次性强密码>","username":"noinvite"}' \
  https://linguatrekai.online/api/auth/signup
# 期望 403，响应 code=invite_required；不要用真实邀请码做这一步
```

> 网关已移除，浏览器不再弹认证框；"退出登录"只影响应用会话。

### 6.6 多人访问（一人一邀请码）

不再有网关账号。按人发码：

1. 管理员用 `ADMIN_EMAILS` 里的邮箱登录；
2. `POST /api/admin/invites`（见 §9.3）为每人生成一次性邀请码（默认 30 天 / 1 次）；
3. 撤销：撤销该码或等它过期；已登录会话另算，必要时封禁账号。

> 邀请码明文只在创建响应出现一次；通过密码管理器/一次性渠道发出，不要写进文档、群或仓库。

### 6.7 G2：摘除 Basic Auth（2026-11-20 已完成）

线上已按本节摘掉网关，**不是**打开 `REGISTRATION_OPEN=true`：

- `/etc/caddy/Caddyfile` 删掉路径豁免规则与认证块，保留 TLS、安全头、`reverse_proxy`、
  SSE 超时、日志脱敏、www 301、health 路径；
- `/etc/caddy/g1.env` 只留 `ACME_EMAIL`（600 root），网关凭据变量已删除；
- 回滚备份：`/etc/caddy/Caddyfile.with-basic-auth.bak`（600 root），**不要删**；
- drop-in `10-g1-env.conf` 可保留（只加载 `ACME_EMAIL`，不再有凭据）；
- `REGISTRATION_OPEN` 保持 `false`，验证见 §6.5。

若确实要恢复网关（需单独评审，不要在开放注册的同一天做）：

```bash
sudo cp /etc/caddy/Caddyfile.with-basic-auth.bak /etc/caddy/Caddyfile
# 同时把两个网关凭据变量恢复进 /etc/caddy/g1.env（600 root）
sudo caddy validate --config /etc/caddy/Caddyfile --envfile /etc/caddy/g1.env
sudo systemctl reload caddy
```

- 回滚后必须先验证 401/200、healthz 与 SSE，再对外；
- 不要在 G1 第一天同时改 Cloudflare 规则、Caddy 配置和模型 Key。

### 6.8 Cloudflare 与 SSE 注意

- G1 先灰云；证书签发成功后观察 24h 再决定是否橙云。
- 橙云时：SSL/TLS **Full (strict)**；不要让 Cloudflare 缓存 `/api/*`；确认 SSE 不被缓冲。
- 后端心跳默认 15s（`SSE_HEARTBEAT_INTERVAL=15`）；Caddy 已 `flush_interval -1` + 24h 超时。
- 如果 60/100s 断流：先看 `journalctl -u caddy`、Cloudflare Analytics、浏览器 Network 的
  `text/event-stream`；按 §9.4 做 30 分钟长流，不要只测 1 分钟。
- 不要在 G1 第一天同时改 Cloudflare 规则、Caddy 配置和模型 Key；一次只动一个变量。

---

## 7. 数据目录、备份与恢复演练

### 7.1 备份脚本做什么

`scripts/backup.sh` 会：

1. 用 `sqlite3 .backup` 生成 WAL 安全的 `app.db` 快照（没有 sqlite3 时退化为文件复制）；
2. 复制 `USER_DATA_DIR`（默认 `data/users`）；
3. 只收集配置**键名**与 `.env.example` 模板，不复制 `.env` 的值；
4. 打成 `linguatrek-backup-YYYYmmdd-HHMMSS.tar.gz`，默认保留 7 份。

备份含 PII/口令哈希：目录 700、文件 600，离机桶必须私有。

### 7.2 Docker：首次手工备份

```bash
sudo mkdir -p /srv/ln/backups
sudo chown 1000:1000 /srv/ln/backups

cd /srv/ln/app
docker compose run --rm --no-deps \
  -v /srv/ln/backups:/backups \
  -v "$PWD/scripts:/scripts:ro" \
  -e BACKUP_ROOT=/backups \
  -e ENV_FILE=/dev/null \
  --entrypoint /bin/bash \
  app /scripts/backup.sh --keep 7

ls -lh /srv/ln/backups
```

期望看到 `linguatrek-backup-*.tar.gz`、`SHA256SUMS`、`manifest.env`，大小非 0。

加入 root cron（`sudo crontab -e`）：

```cron
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 3 * * * cd /srv/ln/app && docker compose run --rm --no-deps -v /srv/ln/backups:/backups -v /srv/ln/app/scripts:/scripts:ro -e BACKUP_ROOT=/backups -e ENV_FILE=/dev/null --entrypoint /bin/bash app /scripts/backup.sh --keep 7 >> /var/log/linguatrek-backup.log 2>&1
```

### 7.3 裸机：首次备份与 cron

```bash
sudo mkdir -p /srv/ln/backups && sudo chown ln:ln /srv/ln/backups
sudo -u ln bash -lc 'cd /srv/ln/current && \
  DATA_DIR=/srv/ln/data AUTH_DB_PATH=/srv/ln/data/app.db USER_DATA_DIR=/srv/ln/data/users \
  BACKUP_ROOT=/srv/ln/backups ENV_FILE=/etc/linguatrek/env \
  /srv/ln/current/scripts/backup.sh --keep 7'

sudo install -m 644 /srv/ln/current/deploy/backup.cron /etc/cron.d/linguatrek-backup
sudo tail -n 30 /srv/ln/backups/backup.log
```

> `deploy/backup.cron` 默认以 `ln` 用户运行；如你改了路径/用户，先改文件再安装。

### 7.4 恢复演练（上线前与每月一次）

先做**自动演练**，不碰真实数据、不占 8000 端口。

裸机：

```bash
sudo -u ln bash -lc 'DATA_DIR=/srv/ln/data AUTH_DB_PATH=/srv/ln/data/app.db \
  USER_DATA_DIR=/srv/ln/data/users /srv/ln/current/scripts/restore_drill.sh'
# 期望最后一行：PASS 恢复演练通过：...
```

Docker（在容器内跑同一脚本；会备份 → 临时恢复 → 比对，不写 `/data`）：

```bash
cd /srv/ln/app
docker compose run --rm --no-deps \
  -v "$PWD/scripts:/scripts:ro" \
  -e ENV_FILE=/dev/null \
  -e ENV_EXAMPLE=/dev/null \
  --entrypoint /bin/bash \
  app /scripts/restore_drill.sh
```

> Docker 变体本机未验证；如果 `/tmp` 或脚本路径不对，先在容器里 `bash -lc 'ls -l /scripts'` 排查。
> 演练时最好暂停写入；备份后源数据变化会导致比对失败，这是预期行为。

### 7.5 真实恢复（先停服务）

Docker：

```bash
cd /srv/ln/app
docker compose stop app
docker compose run --rm --no-deps \
  -v /srv/ln/backups:/backups \
  -v "$PWD/scripts:/scripts:ro" \
  --entrypoint /bin/bash \
  app /scripts/restore.sh /backups/linguatrek-backup-YYYYmmdd-HHMMSS.tar.gz --to /data --force
docker compose start app
curl -fsS http://127.0.0.1:8000/healthz | python3 -m json.tool
```

裸机：

```bash
sudo systemctl stop linguatrek
sudo -u ln /srv/ln/current/scripts/restore.sh \
  /srv/ln/backups/linguatrek-backup-YYYYmmdd-HHMMSS.tar.gz --to /srv/ln/data --force
sudo systemctl start linguatrek
curl -fsS http://127.0.0.1:8000/healthz | python3 -m json.tool
sudo -u ln sqlite3 /srv/ln/data/app.db 'PRAGMA integrity_check;'   # 期望 ok
```

恢复后确认旧账号能登录、历史仍在；无异常再清理 `.pre-restore-*`。

### 7.6 离机备份（占位，不绑定供应商）

本机备份只防误删，不防 VPS 磁盘/机房故障。自行选择对象存储（S3 兼容/其他），先配置：

```bash
sudo -u ln rclone config
# 按 provider 文档创建 remote；remote 名示例：remote（不要用真实密钥截图/发群）
sudo -u ln rclone lsf remote:linguatrek-backup/daily | tail
```

用 `/etc/cron.d`（带用户字段，明确以 `ln` 身份读 rclone 配置；把 `remote` 换成你的 remote 名）：

```bash
sudo tee /etc/cron.d/linguatrek-offsite >/dev/null <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
25 3 * * * ln rclone copy /srv/ln/backups remote:linguatrek-backup/daily --include "linguatrek-backup-*.tar.gz" --checksum --transfers 2 >> /srv/ln/backups/rclone.log 2>&1
15 4 1 * * ln rclone delete remote:linguatrek-backup/daily --min-age 30d >> /srv/ln/backups/rclone.log 2>&1
EOF
sudo chmod 644 /etc/cron.d/linguatrek-offsite
```

- 本手册不推荐/不绑定具体厂商；示例中的 `remote:` 只是占位。
- 对象存储侧也应配生命周期/版本控制，不要只依赖本机 cron。
- 备份成功/失败建议接飞书告警（见 §8）；失败时不要静默。

---

## 8. 飞书告警（M5）

### 8.1 建机器人

飞书群 → 设置 → 群机器人 → 添加机器人 → 自定义机器人：

- 复制 webhook；可选启用“签名校验”并保存 secret；
- webhook/secret 都是密钥，只放服务器 env（600），不要写进仓库、文档、截图或前端；
- 服务器时间必须 NTP 同步（§3.5），否则签名会被拒。

### 8.2 应用 env

在 `.env`（Docker）或 `/etc/linguatrek/env`（裸机）设置：

```ini
FEISHU_ALERTS_ENABLED=true
FEISHU_WEBHOOK_URL=<粘贴 webhook>
FEISHU_WEBHOOK_SECRET=<可选签名密钥>
FEISHU_ALERT_LEVEL=P2
FEISHU_AT_USER_ID=
FEISHU_ALERT_MESSAGE_FORMAT=text
ALERT_ENV=prod
ALERT_DEDUPE_SECONDS=300
ALERT_P1_AGGREGATE_SECONDS=900
ALERT_DAILY_DIGEST_HOUR=9
RATE_LIMIT_ADMIN_ALERT_TEST_PER_MINUTE=3
```

Docker 改 `.env` 后必须重建容器让 env 生效：

```bash
cd /srv/ln/app
docker compose up -d --force-recreate app
docker compose exec app sh -lc 'printenv | grep -c "^FEISHU_ALERTS_ENABLED=true$"'
```

裸机：

```bash
sudo systemctl restart linguatrek
```

### 8.3 发一条测试消息

需要管理员账号（`ADMIN_EMAILS` 中的邮箱）。用 cookie：

```bash
BASE=https://linguatrekai.online

# 把登录密码写进 600 的临时文件，避免进 history
install -m 600 /dev/null /tmp/ln-login.json
"${EDITOR:-vi}" /tmp/ln-login.json
# 内容：{"email":"your-admin@example.com","password":"..."}

curl -c /tmp/ln.cookie -D /tmp/ln-login.headers \
  -H 'Content-Type: application/json' --data @/tmp/ln-login.json \
  "$BASE/api/auth/login"

curl -b /tmp/ln.cookie \
  -X POST "$BASE/api/admin/alerts/test" \
  -H 'Content-Type: application/json' -d '{"level":"P1"}'

rm -f /tmp/ln-login.json
```

响应 `status=sent` / `sent=true` 表示已送达；`disabled` 表示没开开关；
`not_configured` 表示 webhook 为空/非法；`failed` 的 `reason` 含
`timeout`/`http_xxx`/`feishu_code_xxx`（不会回显 webhook/secret）。

### 8.4 巡检 cron

裸机（`/healthz` 本机探测，连续 2 次失败发 P0）：

```bash
sudo mkdir -p /srv/ln/data/alerts && sudo chown ln:ln /srv/ln/data/alerts
sudo -u ln /srv/ln/current/backend/venv/bin/python \
  /srv/ln/current/scripts/check-alerts.py --dry-run
sudo install -m 644 /srv/ln/current/deploy/alert-check.cron /etc/cron.d/linguatrek-alert
sudo tail -f /srv/ln/data/alerts/check.log
```

Docker 没有宿主 venv；可每 2 分钟用 compose 临时容器探测服务名 `app`（**未在目标机验证**；
若太重，改用外部 uptime 监控）。写进 **root 的 crontab**（`sudo crontab -e`）：

```cron
*/2 * * * * cd /srv/ln/app && docker compose run --rm --no-deps -v /srv/ln/app/scripts:/scripts:ro --entrypoint python app /scripts/check-alerts.py --url http://app:8000/healthz >> /var/log/linguatrek-alert.log 2>&1
```

`deploy/alert-check.cron` 每 2 分钟；阈值 2；状态在 `data/alerts/health_state.json`。
备份失败等事件可复用：

```bash
backend/venv/bin/python scripts/check-alerts.py --event backup_failed --level P1 --summary "备份文件缺失"
```

### 8.5 离线自检

```bash
cd /srv/ln/current
backend/venv/bin/python scripts/check-alerts.py --self-test
# 预期含 "sent": true 与 "sign_recomputable": true

cd backend && venv/bin/python -m pytest tests/test_alerts.py tests/test_alerts_integration.py -q
```

已知边界：去重/聚合状态在进程内存，必须单 worker；重启清零；发送失败只记日志；
告警不是唯一监控，`/healthz`、备份日志、磁盘/证书仍需外部兜底。

---

## 9. 上线前 Smoke（不承诺全绿，逐项记录）

### 9.1 先跑只读预检脚本

```bash
cd /srv/ln/app
DOMAIN=linguatrekai.online EXPECTED_IP=43.245.199.136 \
  ./scripts/preflight-production.sh
```

脚本只做读取：DNS、22/80/443 TCP、HTTPS、首页 200、`/healthz`、安全头、www 301、
注册闸门（`/api/auth/registration` 的 `registrationOpen=false`、无邀请码注册必须 403
`invite_required`）。不会 SSH、不会重启、不会改服务器。没有网络时会明确 `FAIL` 并返回非 0。

> 唯一的 POST 是"故意不带邀请码"的注册探测：服务端在写库前拒绝，不会创建账号，
> 也不消耗邀请码。

### 9.2 HTTPS / 证书 / 安全头

```bash
BASE=https://linguatrekai.online

curl -sSI --max-time 10 "$BASE/" | sed -n '1,20p'
# 期望 200（无 WWW-Authenticate）+ HSTS + CSP + X-Content-Type-Options + Referrer-Policy

curl -sSI --max-time 10 "$BASE/healthz" | sed -n '1,20p'
# 期望 200，且没有 WWW-Authenticate

openssl s_client -connect linguatrekai.online:443 -servername linguatrekai.online </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
# 记录到期日；应 > 30 天
```

### 9.3 账号：登录 / 邀请码注册

```bash
BASE=https://linguatrekai.online

# 1) 首页无认证 -> 200（无 WWW-Authenticate）
curl -sSI "$BASE/" | grep -iE 'HTTP/|www-authenticate'

# 2) 注册开关（公开只读）
curl -sS "$BASE/api/auth/registration" | python3 -m json.tool
# 期望 registrationOpen=false、inviteRequired=true
```

管理员生成邀请码（用管理员 cookie）：

```bash
# 登录（密码放 600 临时文件，见 §8.3）
curl -c /tmp/ln.admin.cookie \
  -H 'Content-Type: application/json' --data @/tmp/ln-login.json \
  "$BASE/api/auth/login"

curl -b /tmp/ln.admin.cookie \
  -X POST "$BASE/api/admin/invites" \
  -H 'Content-Type: application/json' \
  -d '{"count":1,"label":"smoke"}' \
  | tee /tmp/ln-invite.json

# 明文只出现一次；取出后放 600 文件
python3 -c 'import json; print(json.load(open("/tmp/ln-invite.json"))["codes"][0])' > /tmp/ln-invite.code
chmod 600 /tmp/ln-invite.code
```

注册一个一次性测试账号（不要在命令里写密码；用 600 的 JSON 文件）：

```bash
# 用编辑器创建 /tmp/ln-signup.json：
# {"email":"smoke-<时间戳>@example.com","password":"<一次性强密码>","username":"smoke<时间戳>","inviteCode":"<上一步邀请码>"}
curl -c /tmp/ln.smoke.cookie -D /tmp/ln.smoke.headers \
  -H 'Content-Type: application/json' --data @/tmp/ln-signup.json \
  "$BASE/api/auth/signup"

grep -i '^set-cookie' /tmp/ln.smoke.headers
# 期望 ln_session=...; HttpOnly; Secure; SameSite=Lax; Path=/
```

再测无邀请码注册被拒（用另一个一次性邮箱）：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Content-Type: application/json' \
  -d '{"email":"noinvite-<时间戳>@example.com","password":"<一次性强密码>","username":"noinvite"}' \
  "$BASE/api/auth/signup"
# 期望 403，响应 code=invite_required
```

> 邀请码明文只在创建响应出现一次；测试完可撤销/让它过期。不要把它写进文档/群。

### 9.4 SSE 30 分钟长流

需要一条真实 YouTube 视频 + 测试账号 cookie。先用短视频确认事件格式，再跑 30 分钟：

```bash
BASE=https://linguatrekai.online

curl -N --max-time 2400 \
  -b /tmp/ln.smoke.cookie \
  -X POST "$BASE/api/process-video-stream" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=<VIDEO_ID>","model":"deepseek-chat"}' \
  | tee /tmp/ln-sse.log | grep -m1 '^event: meta'
```

另开终端：

```bash
grep -c '^: ping' /tmp/ln-sse.log
grep -E '^event: (meta|batch|done)' /tmp/ln-sse.log | tail
```

记录：

- 流是否持续 > 30 分钟；
- `: ping` 是否每 ~15s 出现；
- 是否在 60/100s 被代理切断；
- 中断后同一 URL 重跑能否命中缓存继续补译。

> 不要用真实用户的长视频反复烧模型额度；用测试账号+短视频起步，再选一条 30 分钟内的视频。
> 本项必须浏览器/curl 实测，不能只看 Caddy 配置就宣称通过。

### 9.5 本地视频 HTTPS 文件句柄

App 的本地视频库使用 `FileSystemFileHandle`（IndexedDB 持久化），浏览器只在
**secure context**（HTTPS 或 localhost）提供 `showOpenFilePicker`。用 Chromium 内核浏览器：

1. 打开 `https://linguatrekai.online/`，通过 G1 + 应用登录；
2. 选择本地 `mp4/webm` 与 `.srt`；
3. 确认能播放、字幕能翻译、关闭页面再打开能从本地视频库恢复（文件句柄/进度）；
4. 用 `http://<IP>:8000` 或普通 HTTP 访问时，应看到“不支持持久化”的降级提示，而不是静默失败。

> 这一项无法用 curl 验证；必须在浏览器实测并记录浏览器/版本。
> 如果文件句柄恢复失败，先看浏览器是否 Chromium、是否 HTTPS、是否清除了站点数据。

### 9.6 402（余额不足）

用一次性测试账号（新用户默认 $2.00），管理员把它扣到 0，再调用一个会产生模型费用的端点：

```bash
BASE=https://linguatrekai.online

# 1) 测试账号 user id（用 smoke cookie）
curl -sS -b /tmp/ln.smoke.cookie "$BASE/api/auth/me" \
  | tee /tmp/ln-me.json | python3 -m json.tool
USER_ID=$(python3 -c 'import json; print(json.load(open("/tmp/ln-me.json"))["user"]["id"])')

# 2) 管理员扣掉 $2.00（管理员 cookie；金额是字符串）
curl -b /tmp/ln.admin.cookie \
  -X POST "$BASE/api/admin/users/$USER_ID/balance" \
  -H 'Content-Type: application/json' \
  -d '{"amountUsd":"2.00","direction":"deduct","reason":"smoke 402"}'

# 3) 用一个新词触发查词（避免缓存命中）
curl -b /tmp/ln.smoke.cookie \
  -X POST "$BASE/api/define" \
  -H 'Content-Type: application/json' \
  -d '{"word":"smoke402xyz","targetLang":"zh-CN"}'
# 期望 402，响应含 code=insufficient_balance、balanceMicroUsd、requiredMicroUsd
```

> 若扣款后仍 200，说明余额/账本未按预期工作；不要继续上线，先查 `ai_usage`/`billing`。
> 不要对真实管理员账号做扣款测试。

### 9.7 导出 / 删除（一次性账号）

导出：

```bash
# 密码放 600 临时 JSON
install -m 600 /dev/null /tmp/ln-export.json
"${EDITOR:-vi}" /tmp/ln-export.json
# {"password":"<smoke 账号密码>"}

curl -b /tmp/ln.smoke.cookie \
  -X POST "$BASE/api/account/export" \
  -H 'Content-Type: application/json' --data @/tmp/ln-export.json \
  | tee /tmp/ln-export-job.json

python3 -m json.tool /tmp/ln-export-job.json
# 记录 jobId/downloadToken/downloadPath；token 只出现一次
```

等后台生成完成后下载：

```bash
JOB=$(python3 -c 'import json; print(json.load(open("/tmp/ln-export-job.json"))["jobId"])')
TOKEN=$(python3 -c 'import json; print(json.load(open("/tmp/ln-export-job.json"))["downloadToken"])')
curl -b /tmp/ln.smoke.cookie \
  -o /tmp/ln-export.zip "$BASE/api/account/export/$JOB?token=$TOKEN"
unzip -l /tmp/ln-export.zip | head
```

删除（冷静期 7 天；提交后所有会话失效）：

```bash
install -m 600 /dev/null /tmp/ln-delete.json
"${EDITOR:-vi}" /tmp/ln-delete.json
# {"password":"<smoke 账号密码>","username":"<smoke 用户名>","confirm":"DELETE","reason":"smoke"}

curl -b /tmp/ln.smoke.cookie \
  -X POST "$BASE/api/account/deletion" \
  -H 'Content-Type: application/json' --data @/tmp/ln-delete.json \
  -D /tmp/ln-delete.headers | python3 -m json.tool
# 期望 202 + status=pending + cooldownDays=7
```

冷静期内用密码取消（不要等 7 天，避免真实 purge）。删除申请会踢掉会话，先重新登录：

```bash
install -m 600 /dev/null /tmp/ln-login-smoke.json
"${EDITOR:-vi}" /tmp/ln-login-smoke.json
# 内容：{"email":"<smoke 邮箱>","password":"<smoke 密码>"}

curl -c /tmp/ln.smoke.cookie \
  -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  --data @/tmp/ln-login-smoke.json

install -m 600 /dev/null /tmp/ln-delete-cancel.json
"${EDITOR:-vi}" /tmp/ln-delete-cancel.json
# 内容：{"password":"<smoke 密码>"}

curl -b /tmp/ln.smoke.cookie \
  -X POST "$BASE/api/account/deletion/cancel" \
  -H 'Content-Type: application/json' --data @/tmp/ln-delete-cancel.json
```

> 删除申请会立刻踢掉全部会话；取消需要重新登录。真实删除不可逆，测试账号务必取消或让它过期前确认。

### 9.8 管理台 / 飞书

- 管理员登录后打开后台，确认用户列表、邀请码、余额/用量可见；
- `POST /api/admin/alerts/test` 返回 `sent`（见 §8.3）；
- 检查 `/healthz` 的 `version` 是否与 `APP_VERSION` 一致；
- 检查日志无 API Key、cookie、webhook、密码或邀请码明文。

### 9.9 验收记录表

| 项 | 命令/方式 | 实际结果 | 通过? |
|---|---|---|---|
| 公网 DNS 主域/www | `dig @1.1.1.1` |  |  |
| 80/443/22 | `nc`/preflight |  |  |
| HTTPS 证书 | `curl -sSI` + `openssl x509 -dates` |  |  |
| 首页无认证 200 | `curl -I` |  |  |
| `/healthz` 200 | curl |  |  |
| 安全头 | curl -I |  |  |
| www 301 | curl -I |  |  |
| 邀请码注册 | curl + 管理员 |  |  |
| 登录 Cookie 属性 | `-D` 头 |  |  |
| SSE 30 分钟 | curl/浏览器 |  |  |
| 本地视频文件句柄 | Chromium HTTPS |  |  |
| 402 | 扣余额 + define |  |  |
| 导出/删除/取消 | curl |  |  |
| 备份 + 恢复演练 | 脚本 |  |  |
| 飞书测试消息 | 管理端点 |  |  |

**任何一项失败：停在上线前，修完重跑；不要“边上线边修”。**

---

## 10. 回滚

### 10.1 Docker 镜像回滚

```bash
cd /srv/ln/app
docker images 'linguatrek:*'        # 找到上一个 tag
IMAGE_TAG=<旧tag> docker compose up -d --no-build
docker compose logs --tail=100 app
curl -fsS http://127.0.0.1:8000/healthz | python3 -m json.tool
```

- `Caddyfile`/TLS 不需要动；
- 数据库迁移不回滚；旧代码通常能读新库（迁移只加表/列），但必须实测登录/核心页面；
- 若迁移破坏数据：停 app → 按 §7.5 恢复备份 → 再用旧镜像启动。

### 10.2 裸机 release 回滚

```bash
ls -1 /srv/ln/releases | tail -5
sudo ln -sfn /srv/ln/releases/<旧STAMP> /srv/ln/current
sudo systemctl restart linguatrek
curl -fsS http://127.0.0.1:8000/healthz | python3 -m json.tool
```

### 10.3 Caddy 回滚

```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bad-$(date +%F-%H%M) 2>/dev/null || true
sudo cp /etc/caddy/Caddyfile.bak-<时间戳> /etc/caddy/Caddyfile
sudo chown root:caddy /etc/caddy/Caddyfile
sudo chmod 640 /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --envfile /etc/caddy/g1.env
sudo systemctl restart caddy
```

- 若回滚到摘网关前的配置（`Caddyfile.with-basic-auth.bak`），需同时恢复 drop-in 与
  `/etc/caddy/g1.env` 里的凭据变量，再 `daemon-reload`（详见 §6.7）；
- 回滚后必须重测 200、healthz、SSE（至少短流）。

### 10.4 数据库

- **迁移前必须备份**；Alembic downgrade 未在本仓库验收，不承诺可用；
- 数据回退只能恢复备份（§7.5）；
- 恢复会覆盖当前 `app.db`/用户数据；`--force` 会把旧数据移到 `.pre-restore-*`，确认后再清理；
- 迁移不可逆是硬边界：不要在没有备份的情况下跑 `alembic upgrade head`。

---

## 11. 安全与运维纪律

1. **密钥不进 shell history**：用编辑器/`read -rsp`/600 临时文件；不要 `export KEY=...`。
2. **env 文件 600**：应用 env、`/etc/caddy/g1.env`（只有 `ACME_EMAIL`）、导出 token 临时文件。
3. **Caddy 配置 640 root:caddy**；只有系统读取的 env（`/etc/caddy/g1.env`）才 600 root。
4. **保留 `--environ` 的移除**：否则 Caddy 启动会把进程环境写 journal；用 `systemctl cat caddy` 复核。
5. **日志脱敏**：Caddy 默认脱敏 Authorization/Cookie；本手册的 log filter 还删除导出 token 查询参数；
   仍不要把完整日志发群。
6. **Cloudflare 先灰云**；橙云要单独验证 SSE、TLS 模式、缓存规则。
7. **Docker 防火墙**：只发布 `127.0.0.1:8000`；UFW 不能完全保护 Docker 端口，绝不 `0.0.0.0:8000`。
8. **SSH**：只开密钥登录；保留 provider 控制台/VNC 作为救援；不要在聊天里发私钥。
9. **备份**：目录 700、文件 600；离机桶私有；定期 restore drill；备份内含 PII/口令哈希。
10. **邀请码撤销**：用管理员接口撤销或让它过期；应用会话是另一层，必要时封禁/删会话。
11. **管理员权限在应用层**：`/api/admin/*` 由 `ADMIN_EMAILS` 校验；不要把管理员密码发给测试用户。
12. **每日巡检**：`/healthz`、磁盘 `df -h`、备份日志、Caddy 证书到期、飞书告警是否可达。

---

## 12. 未验证项 / 待现场确认

| 项 | 状态 | 怎么确认 |
|---|---|---|
| SSH 认证方式/默认用户 | **未知** | provider 控制台；`ssh -o BatchMode=yes` |
| 服务器 OS/版本 | **未确认** | `lsb_release -a` / `cat /etc/os-release` |
| provider 安全组 | **未确认** | 控制台；`nc -z` 22/80/443 |
| Docker 安装/构建/运行 | **未在本机验证**（本机 daemon 未运行） | 目标机 `docker compose build`、`up -d` |
| Caddy 实际版本/证书签发 | **未在目标机验证** | `caddy version`、`journalctl -u caddy` |
| `Caddyfile.g1` / `.g1.proxy` 语法 | 本机 Caddy 2.11.9 `validate` 通过 | 目标机再 `caddy validate` |
| 首页 200、`/healthz` 200、www 301（无网关认证） | 2026-11-20 目标机 curl 实测通过 | 换域名/换机后重测 |
| SSE 30 分钟 | **未验证** | §9.4 |
| 本地视频文件句柄 | **未验证** | Chromium HTTPS 实测 |
| 402 / 导出 / 删除 | **未验证** | §9.6–9.7 |
| 备份/恢复演练（Docker 变体） | **未在本机验证** | 目标机跑 `restore_drill.sh` |
| 飞书真实 webhook | **未验证** | §8.3 |
| Cloudflare 灰云/橙云 | **未配置** | 先在灰云签发证书，再决定 |
| DNS 在目标网络 | 公网已指向 VPS；本机 fake-IP | 手机蜂窝/另一台机器复核 |

---

## 13. 文件索引

| 文件 | 用途 |
|---|---|
| `deploy/Caddyfile.g1` | G1 裸机：静态 `frontend/dist` + `/api` 反代 + health 直通 + www 301（无网关认证） |
| `deploy/Caddyfile.g1.proxy` | G1 Docker：全量反代 + health 直通 + www 301（无网关认证） |
| `deploy/Caddyfile` / `deploy/Caddyfile.proxy` | 原有示例（同样无网关认证）；保留作参考 |
| `deploy/production.env.example` | 本次 `linguatrekai.online` 的生产 env 模板（无密钥） |
| `deploy/linguatrek.env.example` | 通用生产 env 模板（保留） |
| `.env.example` | 本地开发模板；末尾有生产入口说明 |
| `scripts/preflight-production.sh` | 只读预检：DNS/端口/HTTPS/首页 200/healthz/安全头/www 301/注册闸门（无邀请码注册必须 403） |
| `deploy/linguatrek.service` | 裸机 systemd 单 worker |
| `deploy/backup.cron` / `deploy/alert-check.cron` | 裸机备份/巡检 cron |
| `scripts/backup.sh` / `restore.sh` / `restore_drill.sh` | 备份/恢复/演练 |
| `docs/部署指南.md` | 通用部署背景（Docker/裸机、备份、验证） |
| `docs/上线前任务清单-web.md` | P4 部署项与 §8 命令；以其为准做验收勾选 |
