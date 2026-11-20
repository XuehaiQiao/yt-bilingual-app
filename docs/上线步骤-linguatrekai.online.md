# 上线步骤 —— linguatrekai.online（G1 邀请制内测）

> **文档版本**：v1.0 ｜ **事实截止**：2026-11-21 00:55（Asia/Shanghai）  
> **适用对象**：发布负责人、运维、管理员、邀请人 ｜ **目标 Gate**：G1 邀请制内测  
> **当前线上版本**：`41c463b` ｜ **迁移 head**：`0025_balance_cost` ｜ **站点**：<https://linguatrekai.online>  
> **性质**：这是**执行手册**，不是上线批准书，也不替代 [部署执行手册](./部署执行手册-linguatrekai.online.md)、[上线前任务清单](./上线前任务清单-web.md) 和 [项目提案](./项目提案-上线功能.md)。  
> **边界**：本文只写步骤与判定，不改代码、不改服务器、不提交 git；所有涉及生产机的命令都必须由有权限的人在维护窗口执行，并保留输出证据。

**状态图例**：✅ 已完成并有证据 ｜ ⏳ 待完成／待最终 QA ｜ ⚠️ 带风险（需负责人＋复核日期） ｜ ⛔ 明确不做

**角色名约定**：本文用「发布负责人（lead）」「运维负责人（ops）」「法务/产品负责人」「成本负责人」「QA 负责人」指代职责。T-1 签字时必须替换为真实姓名；**只写角色不写姓名 = 未签字 = No-Go**。

---

## 0. 一页结论

### 0.1 结论

**可以做 G1 邀请制内测；不能直接公开注册，不能收费，不能对外称“正式上线”。**

当前站点已经具备 G1 的最小运行条件：

- `https://linguatrekai.online` 返回 200，HTTPS 证书由 Let's Encrypt 签发且未到期；`www` 301 到主域；响应头无 `WWW-Authenticate`，Caddy 层 Basic Auth 已摘除。
- `/healthz` 返回 200：`status=ok`、`version=41c463b`、`db.ok=true`、迁移 `current=head=0025_balance_cost`。
- 公开注册关闭：`/api/auth/registration` 返回 `registrationOpen=false`、`inviteRequired=true`；无邀请码注册为 403。
- Docker 单容器 `linguatrek-app-1` 运行在 `/srv/ln/app`，镜像 `linguatrek:41c463b`，数据卷 `linguatrek_linguatrek-data` → `/data`。
- 管理员账号、DeepSeek Key、严格计费、新用户 $2.00、飞书告警、本机备份、核心 QA 已具备。
- 已知缺口：离机备份未配、30 分钟长 SSE／完整 UI 矩阵／管理员后台 UI 未最终 QA、法务文本与 DeepSeek 价格待复核、飞书 webhook 无签名。

**G1 的硬闸门**（不通过就 No-Go）：

1. 管理员账号能登录（API 或后台），能生成／撤销邀请码；
2. 邀请码闭环可走通：生成 → 注册 → $2 到账 → AI 调用 → 撤销／清理；
3. 本机备份存在，且 `restore_drill.sh` 输出 PASS；
4. `/healthz`、注册闸门、Caddy/TLS、www 301 均通过；
5. Go/No-Go 15 条已签字，带风险项有负责人和复核日期；
6. 回滚路径已演练，值班人与回滚决策人已指定。

**不建议现在做**：打开 `REGISTRATION_OPEN`、接支付／订阅、发正式发布公告、承诺长视频 30 分钟、宣称 UI 已完全合规、宣称备份已离机。

### 0.2 三个非阻塞风险（G1 可带风险，但必须签字）

| # | 风险 | 当前事实 | 影响 | 负责人 | 复核日期 | 临时缓解 |
|---|---|---|---|---|---|---|
| **R1** | 数据单点：离机备份未配 | `/srv/ln/backups` 有 tar.gz；没有对象存储／第二台机器的自动副本 | VPS 磁盘或机房故障时，只能依赖本机或手工下载的副本 | 运维负责人（ops） | 2026-11-28 | T-1 手工下载一份备份到本地并校验 SHA256；首批只邀请可接受“极端情况下数据可能丢失”的用户；不在站内存唯一副本 |
| **R2** | 验证缺口：30 分钟长 SSE、完整 UI 矩阵、管理员后台 UI 未最终 QA | 19 秒视频 SSE 7.0 秒完成、无 5xx；长视频只做了短流 | 长视频可能断流；后台 UI 可能有边缘问题；完整矩阵可能有未发现缺陷 | 发布负责人（lead）＋ QA 负责人 | 后台 UI 2026-11-24；长 SSE／矩阵 2026-11-25 | 首批只发 3–5 人；先只推短视频；管理员用 API 发码作为后台 UI 的兜底；长视频断流即停发新码 |
| **R3** | 合规／成本／告警待复核 | 法务文本待复核；DeepSeek 价格待账单；飞书 webhook 未配 secret | 条款可能有误；成本可能低估；webhook 泄露可被滥用发消息 | 法务/产品负责人＋成本负责人＋运维 | 法务 2026-11-27；价格 2026-12-01；飞书 2026-11-28 | G1 免费、无支付；文案标明“内测版，待法务复核”；只用 hash 法务链接；严格计费＋日预算＋每日对账；飞书群限制成员并准备轮换 webhook |

> 这三个风险**不阻塞 G1 开启**，但阻塞“公开注册／收费／正式发布”。风险接受人默认是发布负责人；T-1 签字时写明真实姓名。任何一项在复核日期前恶化，按第 6 节重新做 Go/No-Go。

### 0.3 现在能做什么／不能做什么

| 能做 | 不能做 |
|---|---|
| 邀请已知用户，一人一码，G1 免费内测 | 打开公开注册、投放广告、发“正式上线” |
| 用 $2.00 赠送额度体验 AI 功能 | 收费、充值、订阅、退款、发票 |
| 短视频、已缓存内容、公开页、法务页 | 承诺 30 分钟长视频稳定、承诺离线 PWA |
| 管理员用 API 或后台发码、调余额、封禁 | 多副本、多 worker、`docker compose scale` |
| 本机备份＋手工下载＋恢复演练 | 宣称已有离机备份、宣称备份万无一失 |

### 0.4 本文不声称

- 不声称“全绿”“零缺陷”“正式上线”“可以收费”。
- 不声称 30 分钟 SSE、完整 UI 矩阵、管理员后台 UI 已通过——它们是待完成项。
- 不声称法务文本已复核、DeepSeek 价格已对账、飞书 webhook 已签名。
- 不声称离机备份已配置；本机 tar.gz ≠ 离机备份。
- 不声称 UI 治理存量已完全合规；G1 只保证核心路径。

---

## 1. 当前线上事实与证据

> 这一节是“写文档时看到的状态”，不是永久承诺。换版本、换机器、换域名后必须重测。

### 1.1 站点与入口

| 项 | 当前值 | 证据／备注 | 状态 |
|---|---|---|---|
| 主域 | `https://linguatrekai.online` | 首页 200 | ✅ |
| www | `https://www.linguatrekai.online` → 301 主域 | `Location: https://linguatrekai.online/` | ✅ |
| TLS | Let's Encrypt，`CN=linguatrekai.online` | `notBefore=2026-11-20`，`notAfter=2027-02-18` | ✅ |
| 安全头 | HSTS、CSP、X-Content-Type-Options、Referrer-Policy、Permissions-Policy | `curl -I` 可见 | ✅ |
| Caddy 层认证 | 无 | 无 `WWW-Authenticate`；2026-11-20 已摘 Basic Auth | ✅ |
| DNS | 主域／www 均 A → `43.245.199.136` | `dig @1.1.1.1` | ✅ |
| 注册开关 | `registrationOpen=false`、`inviteRequired=true` | `GET /api/auth/registration` | ✅ |
| 法务页 | `/#/privacy`、`/#/terms` 才是内容 | 裸 `/privacy` 返回 200 的 SPA 首页，不是法务内容 | ⚠️ 必须用 hash |

**法务链接的硬规则**：上线文案、二维码、公告、页脚、客服回复，一律写：

- `https://linguatrekai.online/#/privacy`
- `https://linguatrekai.online/#/terms`

不要写 `https://linguatrekai.online/privacy` 或 `/terms`；裸路径会落到 SPA 首页，用户看不到条款。页脚和账户页当前已经用 hash 链接，不要改回裸路径。

### 1.2 运行与版本

| 项 | 当前值 | 证据／备注 | 状态 |
|---|---|---|---|
| VPS | GigsGigsCloud HKG-Global-K03，2C/4G/50G，Debian 12.15 | 不是部署手册假设的 Ubuntu；包管理命令别照抄 Ubuntu | ✅ |
| IP／SSH | `43.245.199.136`，SSH 端口 `63916`，用户 `ggcuser`（passwordless sudo） | 不要把 22 当成默认端口 | ✅ |
| 部署目录 | `/srv/ln/app` | Docker Compose 单容器 | ✅ |
| 容器 | `linguatrek-app-1` | 只发布 `127.0.0.1:8000`，公网由 Caddy 反代 | ✅ |
| 镜像 | `linguatrek:41c463b` | `healthz.version=41c463b` | ✅ |
| 数据卷 | `linguatrek_linguatrek-data` → `/data` | 卷名是 Compose 项目名 `linguatrek` + 卷名 `linguatrek-data` | ✅ |
| healthz | 200：`status=ok`、`db.ok=true`、`current=head=0025_balance_cost` | 真实探测 | ✅ |
| Caddy 配置 | `/etc/caddy/Caddyfile` | 无网关版本；`/etc/caddy/g1.env` 只应留 `ACME_EMAIL` | ✅ |
| 备份 | `/srv/ln/backups` 有 tar.gz | 含 PII／口令哈希；目录 700、文件 600 | ✅ 本机 |
| 离机备份 | 未配置 | 已知风险 R1 | ⏳ |

### 1.3 账号、计费、告警

| 项 | 当前值 | 证据／备注 | 状态 |
|---|---|---|---|
| 管理员 | `ADMIN_EMAILS` 已配置，管理员账号已创建 | 完整后台 UI 登录尚未最终 QA | ✅ 账号／⏳ UI |
| DeepSeek Key | 已加载 | `/api/models` 中 `deepseek-chat.available=true` | ✅ |
| 严格计费 | 开启 | `BILLING_STRICT` 生产应为 `1`；T-2 复核 | ✅ |
| 新用户赠送 | `$2.00`（`2,000,000 µUSD`） | `SIGNUP_BONUS_MICRO_USD=2000000` | ✅ |
| 缺价模型 | 路线层禁用 | `MODEL_ROUTE_VI_VN=deepseek-chat`；`recommended` 只有 `deepseek-chat` | ✅ 路线 |
| Qwen | 不进入推荐路线 | `/api/models` 里 Qwen 仍可能显示 `available=true`（Key 在），严格计费下手动选择会 503 `model_unpriced`；T-2 确认前端是否暴露 | ⚠️ 待核对 |
| 越南语 | `deepseek-chat` | 不依赖 Qwen | ✅ |
| 飞书 | `FEISHU_ALERTS_ENABLED=true`，webhook 已配，`send_test` 已 sent | 未配 secret，无签名；见 R3 | ✅ 基础／⚠️ 签名 |
| 公开注册 | 关闭 | 仅邀请码 | ✅ |

### 1.4 QA 证据（2026-11-20 至 2026-11-21）

| 项 | 结果 | 状态 |
|---|---|---|
| define 真实 AI | `deepseek-chat` 扣 433 µUSD | ✅ |
| local-video 3 句真实中文 + `analysis.v4` | 4 idioms / 3 highlights；translate 254 + analysis 444 µUSD | ✅ |
| 19 秒视频 SSE | 7.0 秒完成；`meta`／`batch`／`stage`／`summary`／`done`；无 5xx | ✅ |
| 402 余额不足 | `insufficient_balance` 通过 | ✅ |
| 导出 ZIP | 14 entries | ✅ |
| 删除 pending／cancel／force | 清理通过 | ✅ |
| 游客 AI | 403 `login_required`（本次复核仍为 403） | ✅ |
| 公开页／法务页 | 200 | ✅ |
| 375px 视口 | 无横向溢出 | ✅ |
| 临时 QA 账号 | 已删除；管理员未动 | ✅ |
| 30 分钟长 SSE | 未做最终 QA | ⏳ |
| 完整 UI 矩阵 | 未做最终 QA | ⏳ |
| 管理员后台 UI 登录 | 未做最终 QA | ⏳ |

### 1.5 关键已知缺口

1. **离机备份未配**：本机 `/srv/ln/backups` 的 tar.gz 只防误删，不防 VPS 磁盘／机房故障。
2. **长 SSE 未验收**：19 秒视频通过，不代表 30 分钟长视频通过；Caddy 已配 `flush_interval -1` 和 24h 超时，但必须实测。
3. **管理员后台 UI 未最终 QA**：账号能用不代表后台每个 tab／公告字段／删除请求页都能用；API 发码可作为兜底。
4. **法务文本待复核**：页面已上线，但文本需要法务／负责人确认；法务页写明“内测期间不提供支持邮箱”，对外反馈走邀请人／管理员。
5. **DeepSeek 价格待账单复核**：QA 的 µUSD 是本地计费账本，不是厂商发票；价格差异会影响成本判断。
6. **飞书 webhook 无签名**：一旦 webhook 泄露，别人可以向群里发消息；建议加签名或 IP 白名单 `43.245.199.136`。
7. **后台公告字段没有前台展示入口**：`announcement` 只在管理台和 `admin.ts` 出现，前台未接线；T0 公告不要只写后台，必须走邀请渠道。
8. **Qwen 可用性标记与路线不一致**：`/api/models` 里 Qwen 可能 `available=true`，但严格计费会 503；T-2 确认前端选择器，必要时置灰／隐藏。

---

## 2. 上线前最终检查（T-3～T-1）

> 建议 T0 = **2026-11-24（周二）**。T-3 = 11-21，T-2 = 11-22，T-1 = 11-23。日期是建议值；T0 改期则相对日顺延，复核日期在 Go/No-Go 签字时锁定。  
> 每项必须留证据：命令输出、截图、文件路径、签字。**“文档写了”不等于“已经通过”。**

### 2.1 T-3（2026-11-21）：冻结与只读检查

| # | 检查 | 命令／方式 | 通过标准 | 负责人 | 当前状态 |
|---|---|---|---|---|---|
| T3-1 | 冻结发布物 | `git status --porcelain`、`git rev-parse HEAD`、`git show -s --format='%H %ci %s' HEAD` | HEAD=`41c463b`；部署物来自该 commit；构建上下文只含发布物 | 发布负责人 | ⏳ 当前有 `?? scripts/books-all-shots.mjs` 和本文档，见下 |
| T3-2 | 版本／镜像 | `docker inspect linguatrek-app-1 --format '{{.Config.Image}}'`、`docker image inspect linguatrek:41c463b --format '{{.Id}}'` | 镜像 `linguatrek:41c463b`；容器使用该镜像 | 运维 | ⏳ |
| T3-3 | healthz | `curl -fsS http://127.0.0.1:8000/healthz` | `status=ok`、`db.ok=true`、`current=head=0025_balance_cost` | 运维 | ✅ 公网已验 |
| T3-4 | Caddy | `systemctl is-active caddy`、`caddy validate --config /etc/caddy/Caddyfile --envfile /etc/caddy/g1.env` | active；validate 通过；无 `basic_auth` | 运维 | ⏳ |
| T3-5 | DNS／证书 | `dig +short @1.1.1.1 linguatrekai.online`、`openssl s_client ... -dates` | A=`43.245.199.136`；证书 `notAfter` > 30 天 | 运维 | ✅ 本次 `2027-02-18` |
| T3-6 | 安全组／防火墙 | provider 控制台；`sudo ufw status verbose`；`sudo ss -lntp` | 80/443 对公网；63916 只对管理员 IP；8000 只听 `127.0.0.1` | 运维 | ⏳ |
| T3-7 | 法务 hash 链接 | `curl -sS https://linguatrekai.online/ \| grep -o 'href=\"#/privacy\"'`；浏览器打开 hash | 页脚／账户页链接为 `#/privacy`、`#/terms`；裸路径不用于文案 | 产品 | ✅ 页面／⚠️ 文案待复核 |
| T3-8 | 价格／成本基线 | `GET /api/admin/billing/summary`（管理员 cookie）；记录 `deepseek-chat` 的 `model_prices` | 记录输入／输出单价、`price_version`、近 7 天 `billedCostMicroUsd` | 成本负责人 | ⏳ 待账单 |
| T3-9 | 未跟踪文件处理 | `git status --porcelain`；`ls -l scripts/books-all-shots.mjs` | **不要提交**；把该文件移出发布目录或明确记录“不纳入 41c463b 镜像” | 发布负责人 | ⏳ 当前未处理 |

> **T3-1 说明**：当前工作区有未跟踪文件 `scripts/books-all-shots.mjs`，它不在 `41c463b` 里；本文档也是新增未跟踪交付物。二者都不应进入部署镜像。注意：`docker compose build` 使用的是**工作区**，不是 git commit，未忽略的未跟踪文件也可能进入镜像；T0-B 构建前必须确认工作区只含发布物，或用 `.dockerignore` 排除无关文件。若团队要求 `git status --porcelain` 完全为空，先把无关文件移出构建上下文或归档，**不要为了干净而提交无关文件**。

### 2.2 T-2（2026-11-22）：账号、邀请码、备份、告警

| # | 检查 | 命令／方式 | 通过标准 | 负责人 | 当前状态 |
|---|---|---|---|---|---|
| T2-1 | 管理员登录（API） | `POST /api/auth/login`，再 `GET /api/auth/me` | 200；`isAdmin=true`；不是 403 | 管理员 | ⏳ 必须做 |
| T2-2 | 管理员后台 UI | 浏览器打开 `/#/login` 登录，再打开 `/#/app/profile/admin` | 能进后台；用户／邀请码／计费／设置 tab 可见；不 403 | 管理员／QA | ⏳ 未最终 QA |
| T2-3 | 邀请码生成 | 后台“邀请码 → 生成”或 `POST /api/admin/invites` | 返回 `codes[0]` 明文一次；`maxUses=1`、`expiresInDays=14` | 管理员 | ⏳ |
| T2-4 | 邀请码注册闭环 | 用测试账号注册（见第 3 节） | 201；`ln_session` Cookie；`GET /api/user/summary` 余额 2,000,000 µUSD | QA | ⏳ 用一次性账号 |
| T2-5 | 无码注册被拒 | 不带 `inviteCode` 调 `/api/auth/signup` | 403 `invite_required`；不创建账号 | QA | ✅ 可复测 |
| T2-6 | 撤销 | `POST /api/admin/invites/{id}/revoke` | 撤销后该码不能注册；已注册账号不受影响 | 管理员 | ⏳ |
| T2-7 | 恢复演练 | 容器内 `restore_drill.sh` | 最后一行 `PASS 恢复演练通过：...` | 运维 | ⏳ 必须做 |
| T2-8 | 本机备份 | `docker compose run ... backup.sh --keep 7` | 新 tar.gz 非 0；`SHA256SUMS`、`manifest.env` 存在 | 运维 | ⏳ T-1 前 |
| T2-9 | 备份下载 | `scp -P 63916 ...` 到本地；`shasum -a 256` | 本地副本可解压；SHA256 与服务器一致；存加密磁盘 | 运维 | ⏳ 一次性，不是离机策略 |
| T2-10 | DeepSeek Key／模型 | `GET /api/models?targetLang=zh-CN`；`GET /api/models?targetLang=vi-VN` | `deepseek-chat.available=true`；`recommended` 只有 `deepseek-chat`；Qwen 不手动选 | 管理员 | ✅ Key；⚠️ Qwen 标记 |
| T2-11 | 严格计费 | `docker compose exec app printenv BILLING_STRICT` | `1`；不打印 Key | 运维 | ⏳ 复核 |
| T2-12 | 飞书测试 | `POST /api/admin/alerts/test` | `sent=true`；群里收到；没有 `failed` | 管理员 | ✅ 已 sent；⏳ 复测 |
| T2-13 | 每日备份／巡检 cron | `ls /etc/cron.d/`、`sudo crontab -l`、看 `/var/log/linguatrek-backup.log` | 至少一个每日备份任务；失败会告警 | 运维 | ⏳ 待确认 |
| T2-14 | 模型选择器 Qwen | 浏览器打开视频页模型选择器 | 不展示 Qwen；或展示但选择后明确 503，不静默扣费 | QA | ⏳ |

> **T2-4 测试账号纪律**：只用于闭环；测试完必须撤销码并清理账号。不要在 T0 当天创建真实用户以外的测试账号。清理走第 8.7 节流程，**不要直接改数据库**。

### 2.3 T-1（2026-11-23）：Go/No-Go 与发布准备

| # | 检查 | 通过标准 | 负责人 | 状态 |
|---|---|---|---|---|
| T1-1 | Go/No-Go 15 条逐条签字 | 第 6 节全部勾选；带风险项有 owner／date | 发布负责人 | ⏳ |
| T1-2 | 回滚演练 | 上一镜像 tag 可启动；Caddy 备份可恢复；DB 恢复步骤有人会跑 | 运维 | ⏳ |
| T1-3 | 最终备份 | 新 tar.gz；手工下载；SHA256 记录 | 运维 | ⏳ |
| T1-4 | 证书／磁盘 | 证书 > 30 天；`df -h /` < 70%；`/data` 可写 | 运维 | ⏳ |
| T1-5 | 管理员最终自测 | 登录、发 1 个码、撤销、看审计、飞书 test | 管理员 | ⏳ |
| T1-6 | 公告定稿 | 只写 hash 法务链接；写明无邮箱验证／找回／改密；不写“正式上线” | 产品 | ⏳ |
| T1-7 | 邀请名单 | 首批 3–5 人；一人一码；渠道一对一；不公开贴码 | 发布负责人 | ⏳ |
| T1-8 | 值班表 | T0 及 T+1 的值班人、回滚决策人、法务／成本联系人 | 发布负责人 | ⏳ |
| T1-9 | 变更冻结 | T-1 至 T+1 只修 P0；hotfix 需发布负责人批准 | 发布负责人 | ⏳ |

### 2.4 检查表汇总（可直接打印）

- [ ] 版本 `41c463b`／镜像 `linguatrek:41c463b`／容器 `linguatrek-app-1` 三者一致
- [ ] `/healthz` 200，`current=head=0025_balance_cost`
- [ ] Caddy `validate` 通过，无 `basic_auth`，`/etc/caddy/g1.env` 只留 `ACME_EMAIL`
- [ ] 主域／www DNS 都指向 `43.245.199.136`；www 301；证书 >30 天
- [ ] 管理员 API 登录 `isAdmin=true`；后台 UI 可进（UI 失败时 API 兜底）
- [ ] 邀请码生成、注册、$2 到账、撤销闭环通过
- [ ] 无码注册 403 `invite_required`
- [ ] DeepSeek `deepseek-chat.available=true`；Qwen 不在推荐路线；严格计费 `BILLING_STRICT=1`
- [ ] 飞书 test `sent=true`；无签名风险已知
- [ ] 本机备份新文件；`restore_drill.sh` PASS；手工下载并校验
- [ ] 法务链接只用 `#/privacy`、`#/terms`
- [ ] 价格／成本基线已记录；DeepSeek 账单复核日期已定
- [ ] 安全组：80/443 公网；63916 限制来源；8000 不暴露
- [ ] 公告、邀请名单、值班表、回滚决策人已就绪

---

## 3. 邀请码发放流程

> 目标：一人一码、可撤销、可审计、不泄露、不超发。邀请码明文只在创建响应出现一次，数据库只存 HMAC 摘要，**找不回**；丢了只能撤销重发。

### 3.1 前置条件

- 管理员账号在 `ADMIN_EMAILS` 中，能登录 `https://linguatrekai.online/#/login`。
- 服务端 `REGISTRATION_OPEN=false`、`INVITE_SIGNUP_ENABLED=true`；`/api/auth/registration` 显示 `inviteRequired=true`。
- 管理员知道后台入口 `#/app/profile/admin`；如果后台 UI 有问题，用第 10 节 API 命令兜底。
- 邀请人已阅读并接受：G1 免费、无邮箱验证、无找回密码、无改密、AI 会把字幕文本送模型、视频文件不上传、数据可导出／删除。

### 3.2 生成邀请码

**方式 A：后台 UI（优先）**

1. 管理员登录 `https://linguatrekai.online/#/login`。
2. 打开 `https://linguatrekai.online/#/app/profile/admin`。
3. 进入「邀请码」tab。
4. 点击「生成邀请码」：
   - 数量：首批建议 1 个／人，一次最多生成 10 个；
   - 可用次数：**1**；
   - 有效天数：首批建议 **14** 天（稳定批次可用 30 天）；
   - 备注：`G1-20261124-01` 这类批次号，**不要写邮箱、手机号、真实姓名**。
5. 生成后明文只显示一次；立即复制到密码管理器或一对一私聊，关闭弹窗后无法找回。

**方式 B：API（后台 UI 不可用时的兜底）**

```bash
BASE=https://linguatrekai.online

# 管理员登录：密码放 600 临时 JSON，不要写进 shell history
install -m 600 /dev/null /tmp/ln-admin-login.json
"${EDITOR:-vi}" /tmp/ln-admin-login.json
# 内容：{"email":"<ADMIN_EMAIL>","password":"<ADMIN_PASSWORD>"}

curl -c /tmp/ln.admin.cookie \
  -H 'Content-Type: application/json' \
  --data @/tmp/ln-admin-login.json \
  "$BASE/api/auth/login"

curl -sS -b /tmp/ln.admin.cookie "$BASE/api/auth/me" | python3 -m json.tool
# 期望 "isAdmin": true

curl -sS -b /tmp/ln.admin.cookie \
  -X POST "$BASE/api/admin/invites" \
  -H 'Content-Type: application/json' \
  -d '{"count":1,"label":"G1-20261124-01","maxUses":1,"expiresInDays":14}' \
  | tee /tmp/ln-invite.json

python3 -c 'import json; print(json.load(open("/tmp/ln-invite.json"))["codes"][0]["code"])' \
  > /tmp/ln-invite.code
chmod 600 /tmp/ln-invite.code
rm -f /tmp/ln-admin-login.json
```

- 响应里 `codes[0].code` 是明文，`codes[0].id` 用于撤销；`prefix` 用于后台辨认。
- 不要把 `/tmp/ln-invite.json`、`/tmp/ln-invite.code` 发群、截图、提交仓库。
- 生成失败先看 HTTP 状态：`400` 参数越界、`503` 邀请码表未迁移／数据库忙、`403` 不是管理员。

### 3.3 发放

| 项 | 建议 |
|---|---|
| 首批人数 | 3–5 人；只邀请能接受“内测可能中断／回滚”的人 |
| 一码几人 | **一人一码**；`maxUses=1` |
| 有效期 | 首批 14 天；稳定后 30 天；不要“永不过期” |
| 发送渠道 | 一对一私聊／密码管理器共享；不要群发、不要公开贴、不要写在文档里 |
| 发送内容 | 站点地址、邀请码、注册步骤、$2 说明、无找回密码提醒、法务 hash 链接、反馈渠道 |
| 记录 | 本地表：`label`、`prefix`、发给谁（昵称）、发送时间、兑换时间、撤销时间；**不存明文码** |
| 失败处理 | 码丢了／发错人：立即撤销，重新生成；不要让用户猜或复用 |

**建议参数表**

| 场景 | `count` | `maxUses` | `expiresInDays` | 说明 |
|---|---|---|---|---|
| 首批内测 | 每人 1 个，一批 3–5 | 1 | 14 | 最小暴露面 |
| 稳定批次 | 5–10 | 1 | 30 | 一人一码，便于追责 |
| 小范围 workshop | 1 个共享码 | 3–5 | 7 | **不推荐**；无法区分是谁注册；除非有主持人现场管理 |
| 公开渠道 | — | — | — | ⛔ 禁止；会被爬虫／转发 |

### 3.4 用户注册

1. 用户打开 `https://linguatrekai.online/#/login`，切到「注册」。
2. 填写邮箱、密码（至少 8 位）、用户名（2–24 字符；中文／英文／数字／下划线／连字符）、邀请码。
3. 邀请码可以带空格和连字符，系统会归一化；不要改字符。
4. 注册成功返回 201，下发 `ln_session` Cookie；自动赠送 $2.00。
5. 用户进入账户页应看到余额 `$2.00`（2,000,000 µUSD），标注“内测赠送，不是可购买或提现的余额”。

**必须提前告知用户**：

- 没有邮箱验证、没有找回密码、没有改密，也**没有管理员重置密码接口**；忘记密码就无法自助登录、导出或删除，只能联系邀请人／运营者人工评估，不能承诺恢复。请务必保存好密码。
- 没有支持邮箱；反馈走邀请人或管理员，通常 7 个工作日内回应。
- AI 功能需要登录；游客只能读已缓存内容，AI 入口 403。
- 字幕文本会发送给模型提供商做翻译／分析；视频文件不上传。
- 数据可导出／申请删除；删除需要登录＋密码确认，有 7 天冷静期；忘记密码时无法自助完成。
- 内测可能中断、回滚、清空测试数据；不要存唯一副本。

### 3.5 余额与 AI 使用

- 新用户 $2.00 自动到账；余额不足时 AI 返回 402 `insufficient_balance`。
- 严格计费：每次 AI 调用预占＋结算；缺价模型 503 `model_unpriced`；游客 403 `login_required`。
- 管理员可在后台用户详情调余额（`POST /api/admin/users/{id}/balance`），单次 ±$100，必须写原因和幂等键；不要手工改 DB。
- 用户余额异常先看账户页、`/api/user/summary`、管理员流水；不要先扣别人的余额“试试”。

### 3.6 撤销与封禁

| 场景 | 动作 | 结果 |
|---|---|---|
| 码未使用，发错／泄露 | 后台撤销，或 `POST /api/admin/invites/{id}/revoke` | 该码立即不能注册；已注册账号不受影响 |
| 码已使用，用户违规 | 先撤销未用码；再 `PATCH /api/admin/users/{id}` `{"status":"banned"}` | 旧会话下一次请求 403；不是删除数据 |
| 用户要求退出内测 | 引导导出＋删除申请；不要直接删库 | 7 天冷静期；管理员按流程执行 |
| 管理员误操作 | 用审计日志核对；余额调整用幂等键反向操作 | 不要手改 `app.db` |

- 撤销是幂等的；已撤销再撤销返回“此前已撤销”，不是错误。
- 删除账号是另一层：撤销码不会删除用户；封禁也不删除数据。
- 不要封禁自己或最后一个管理员；接口会拒绝。

### 3.7 审计

- 后台「审计」tab／`GET /api/admin/audit`：邀请码创建、撤销、余额调整、封禁、设置变更。
- `linguatrek.invites` 结构化日志：actor、invite id、prefix、次数、过期时间；**不含明文码**。
- 每周核对：`GET /api/admin/invites?status=all` 的 active／used／expired／revoked 数量，与邀请名单是否一致。
- 发现“码在但人没来”超过 7 天：撤销，避免长期悬挂。
- 发现“人来了但码不是我们发的”：查审计和日志，必要时封禁并停发新码。

---

## 4. 发布日 T0

> 建议 T0：**2026-11-24（周二）**。当前线上已经是 `41c463b` 且 healthz 正常，所以 G1 **开启**通常不需要重新构建或迁移；只有发新 commit 才走完整发布路径。  
> 不要把“开启邀请”做成“重新部署一遍”；能不动镜像就不动。

### 4.1 T0 前提

- [ ] Go/No-Go 15 条已签字（第 6 节）。
- [ ] T-1 最终备份已完成，手工下载副本已校验。
- [ ] 管理员能登录，邀请码已生成或可立即生成。
- [ ] 值班人、回滚决策人、法务／成本联系人已就位。
- [ ] 公告文本已定稿，只含 hash 法务链接。
- [ ] 变更冻结已生效：T-1 至 T+1 只修 P0。

### 4.2 两种情况

| 情况 | 判断 | 要做 | 不要做 |
|---|---|---|---|
| **A. 不换代码（推荐）** | `git rev-parse HEAD` = `41c463b`，线上 healthz 版本一致 | 备份 → 健康检查 → 冒烟 → 发码 → 公告 → 监控 | 不要为了“仪式感”重建镜像／重启容器 |
| **B. 发新 commit** | HEAD 不是 `41c463b`，或必须改配置 | 冻结 → 构建 tag → 备份 → 迁移 → 重启 → 健康 → 冒烟 → 公告 | 不要跳过备份；不要直接 `git pull` 到一半 |

### 4.3 情况 A：不换代码的 T0 步骤

1. **T-30 分钟：最后一次健康检查**

```bash
BASE=https://linguatrekai.online
curl -fsS "$BASE/healthz" | python3 -m json.tool
curl -sSI "$BASE/" | head -20
curl -sSI "$BASE/healthz" | head -10
curl -sSI https://www.linguatrekai.online/ | head -5
curl -sS "$BASE/api/auth/registration"; echo
```

期望：healthz 200、`version=41c463b`、`current=head=0025_balance_cost`；首页 200 且无 `WWW-Authenticate`；www 301；`inviteRequired=true`。

2. **T-20 分钟：备份（即使不迁移也做）**

```bash
cd /srv/ln/app
export IMAGE_TAG=41c463b
docker compose run --rm --no-deps \
  -v /srv/ln/backups:/backups \
  -v "$PWD/scripts:/scripts:ro" \
  -e BACKUP_ROOT=/backups \
  -e ENV_FILE=/dev/null \
  --entrypoint /bin/bash \
  app /scripts/backup.sh --keep 7

ls -lh /srv/ln/backups | tail
```

期望：新的 `linguatrek-backup-YYYYmmdd-HHMMSS.tar.gz` 非 0；`SHA256SUMS`、`manifest.env` 存在。

3. **T-10 分钟：管理员与飞书自测**

```bash
BASE=https://linguatrekai.online

# 管理员登录：密码放 600 文件，不要写进 shell history
install -m 600 /dev/null /tmp/ln-admin-login.json
"${EDITOR:-vi}" /tmp/ln-admin-login.json
# {"email":"<ADMIN_EMAIL>","password":"<ADMIN_PASSWORD>"}

curl -c /tmp/ln.admin.cookie \
  -H 'Content-Type: application/json' \
  --data @/tmp/ln-admin-login.json \
  "$BASE/api/auth/login"

curl -sS -b /tmp/ln.admin.cookie "$BASE/api/auth/me" | python3 -m json.tool
# 期望 "isAdmin": true

curl -sS -b /tmp/ln.admin.cookie \
  -X POST "$BASE/api/admin/alerts/test" \
  -H 'Content-Type: application/json' -d '{"level":"P1"}'
# 期望 sent=true；群里收到

rm -f /tmp/ln-admin-login.json
```

4. **T0：发码与公告**

- 按第 3 节逐个生成／发送邀请码；**一人一码，不群发**。
- 公告走邀请渠道；后台 `announcement` 字段没有前台展示，不要指望它。
- 公告模板见 4.6。

5. **T0+15 分钟：第一个用户注册后检查**

让第一位用户在自己的浏览器确认账户页余额；如用测试账号，命令如下：

```bash
BASE=https://linguatrekai.online
curl -sS -b /tmp/ln.smoke.cookie "$BASE/api/user/summary" | python3 -m json.tool
# 期望 balanceMicroUsd=2000000、balanceUsd="2.00"
```

6. **T0+30 分钟：第一条真实 AI 调用**

- 让用户做一次 `define` 或短视频翻译；管理员看 `/api/admin/billing/summary`：
  - `totals.unbilledRows=0`
  - `totals.settleFailedRows=0`
  - `unpricedModels=[]`
  - `holds.activeCount` 不异常增长
- 如果 402：检查 $2 是否到账、是否被其他调用扣完、是否选到缺价模型。

7. **T0+60 分钟：1 小时看板**（见第 5 节）。

### 4.4 情况 B：发新 commit 的 T0 步骤

> 只有确实要发新代码才做。当前 `41c463b` 已在线，不要为了“重新部署”而重建。

1. **冻结与记录**

```bash
cd /srv/ln/app
git status --porcelain
git rev-parse HEAD
git show -s --format='%H %ci %s' HEAD
git describe --tags --always
```

- 记录完整 SHA；新 tag 建议 `g1-20261124-<shortsha>`。
- **镜像构建使用的是工作区，不是 git commit**：先确认 `git diff --stat` 只包含本次发布改动，未跟踪文件已被 `.dockerignore` 排除或移出构建上下文。
- 工作区有无关未跟踪文件时，不要带进构建上下文；`.dockerignore` 已排除 `.env` 等，但构建上下文仍会包含未忽略文件。
- 打 tag 是发布记录动作，不是本次文档执行动作；不要在本文档任务里提交。

2. **构建并保留回滚镜像**

```bash
cd /srv/ln/app
export OLD_TAG=41c463b
export NEW_TAG=$(git rev-parse --short HEAD)
export IMAGE_TAG="$NEW_TAG"

# 先把当前镜像打上回滚 tag（如果还没有）
docker tag "linguatrek:$OLD_TAG" "linguatrek:rollback-$(date +%Y%m%d)" || true

# 注意：build 使用工作区，不是 git commit；先确认工作区只含发布物
IMAGE_TAG="$NEW_TAG" docker compose build --pull
docker image inspect "linguatrek:$NEW_TAG" --format '{{.Id}} {{.Created}}'
```

- 2C/4G 构建可能较慢；构建期间不要同时跑重任务。
- 构建失败：不要用旧镜像假装新版本；停在 T0 前，修完重来。
- 构建成功后，`docker images 'linguatrek:*'` 应能看到新旧两个 tag。

3. **备份（迁移前必须）**

同 4.3 第 2 步；确认新 tar.gz 后再迁移。

4. **迁移**

```bash
cd /srv/ln/app
export NEW_TAG=$(git rev-parse --short HEAD)

IMAGE_TAG="$NEW_TAG" docker compose run --rm app alembic upgrade head
IMAGE_TAG="$NEW_TAG" docker compose run --rm app alembic current
IMAGE_TAG="$NEW_TAG" docker compose run --rm app alembic heads
```

期望 `current` 与 `heads` 一致；本次基线是 `0025_balance_cost`。不要 `stamp head`，不要手改 `alembic_version`。

5. **重启／健康**

```bash
cd /srv/ln/app
export NEW_TAG=$(git rev-parse --short HEAD)
IMAGE_TAG="$NEW_TAG" docker compose up -d
docker compose ps
docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q app)"
curl -fsS http://127.0.0.1:8000/healthz | python3 -m json.tool
docker compose logs --tail=100 app
```

期望：`Up (healthy)`；healthz 200；`version` 与新 commit 一致（如果 `APP_VERSION` 注入了新值）；日志无 traceback／5xx。

6. **冒烟**：见 4.5。

### 4.5 T0 冒烟（两种路径都做）

| # | 项 | 通过标准 |
|---|---|---|
| S1 | 首页 | 200；无 `WWW-Authenticate`；HSTS／CSP 存在 |
| S2 | healthz | 200；`db.ok=true`；`current=head` |
| S3 | www | 301 到主域 |
| S4 | 注册闸门 | `registrationOpen=false`、`inviteRequired=true`；无码注册 403 |
| S5 | 管理员 | 登录 200；`isAdmin=true`；能打开邀请码页／API |
| S6 | 邀请码 | 生成 1 个测试码；能看到明文一次；能撤销 |
| S7 | 用户注册 | 测试码注册 201；$2 到账；Cookie 属性正确 |
| S8 | AI | 一次 `define` 或短视频翻译成功；无 5xx；账本有扣费 |
| S9 | SSE | 19 秒视频完成；事件 `meta`／`batch`／`stage`／`summary`／`done` |
| S10 | 飞书 | test `sent=true`；群里收到 |
| S11 | 回滚 | 回滚命令在手；旧镜像 tag 存在；Caddy 备份存在 |
| S12 | 日志 | 无 Key／Cookie／webhook／邀请码明文；无 traceback |

> S6／S7 建议在 T-2 完成；T0 只复验，不要为了冒烟占用真实邀请码或创建新的测试账号。若 T0 必须测，测试账号只用于本轮，测完撤销码并清理，不要留测试账号在生产库。

### 4.6 T0 公告模板（只发邀请渠道）

```text
【语途 G1 内测邀请】

地址：https://linguatrekai.online
你的邀请码：单独发送（一人一码，请勿转发；丢了只能找我撤销重发）

注册后自动获得 $2.00 内测 AI 额度（是内测赠送，不是现金，不可购买/提现）。
内测免费；暂时没有邮箱验证、找回密码、改密，请务必保存好密码。
AI 会把字幕文本发送给模型做翻译/分析；视频文件不上传。
隐私政策：https://linguatrekai.online/#/privacy
使用协议：https://linguatrekai.online/#/terms
反馈：直接回复我；通常 7 个工作日内回应。
内测可能中断、回滚或清理测试数据，请不要存唯一副本。
```

- 不要把邀请码写进群公告、文档、截图、Issue。
- 不要把 `/privacy`、`/terms` 裸路径写进公告。
- 不要写“正式上线”“收费”“长期稳定”“30 分钟长视频无压力”。

### 4.7 T0 监控

- 每 15 分钟看一次：`/healthz`、`docker compose ps`、Caddy 日志、`/api/admin/billing/summary`。
- 每 30 分钟看一次：注册数、邀请码兑换、AI 调用、402／429、5xx、磁盘。
- 飞书群保持可收消息；测试消息已 sent。
- 1 小时后按第 5 节做复盘；有任何 P0 立即停发新码。

### 4.8 T0 记录表（填完归档）

| 项 | 记录 |
|---|---|
| T0 日期／时间 |  |
| 发布路径（A 不换代码／B 新 commit） |  |
| commit／镜像 tag／image digest |  |
| 备份文件／SHA256／本地副本路径 |  |
| 迁移 current／heads |  |
| healthz 输出（时间、version） |  |
| 冒烟 S1–S12 结果 |  |
| 发出的邀请码批次／数量 |  |
| 公告发送时间／渠道 |  |
| 1h 看板结果 |  |
| 异常／处理／负责人 |  |

---

## 5. 上线后 1h／24h／7d

> G1 的内部目标，不是对外 SLA。所有阈值按首批 3–5 人的小流量设定；人数上来后重新评估。

### 5.1 T0+1h

| 指标 | 口径 | 目标 | 异常动作 |
|---|---|---|---|
| 可用性 | `/healthz` 200 | 100% | 非 200 立即查容器／DB |
| 5xx | Caddy／app 日志 | 0 | 有 5xx 先看是否新版本；必要时回滚 |
| 注册 | 邀请码兑换数 | ≥1（首批） | 为 0 查邀请码／注册页 |
| 余额 | `GET /api/user/summary` | 新用户 2,000,000 µUSD | 不到账查注册事务／billing |
| AI | 至少 1 次成功调用 | 200；有扣费 | 403 查登录；402 查余额；503 查价格 |
| 未计费 | `billing/summary.totals.unbilledRows` | 0 | >0 停发新码，查缺价模型 |
| 结算失败 | `settleFailedRows` | 0 | >0 查 hold／账本，P1 |
| 飞书 | test／告警 | 可达 | 不可达先修 webhook |
| 备份 | 当日 tar.gz | 存在且非 0 | 缺则补跑并告警 |

### 5.2 T0+24h

| 指标 | 目标 | 异常动作 |
|---|---|---|
| 5xx 比例 | < 1%（G1 最好为 0） | >1% 查日志／回滚 |
| 短视频 SSE 完成率 | ≥95% | 断流查 Caddy／心跳／代理 |
| 用户注册 | 按名单，无异常批量注册 | 异常注册查邀请码／限流 |
| AI 成本 | 与 QA 基线同量级（define≈433 µUSD；3 句 local-video≈698 µUSD） | 明显偏高查模型／token／缓存 |
| 未计费 | `unbilledRows=0`；`unpricedModels=[]` | 非 0 立即停新码并修价 |
| 结算失败 | `settleFailedRows=0` | 非 0 对账并修 hold |
| 单用户日花费 | < $1（以实际 `AI_DAILY_BUDGET_USER_USD` 为准） | 超限查滥用／配额 |
| 磁盘 | <70% | >70% 告警；>85% 停导出／新邀请 |
| 备份 | 当天备份存在；`restore_drill` 最近 PASS | 缺／失败 P1 |
| 证书 | >30 天 | 临近到期查 Caddy 续期 |
| 反馈 | 已分类；P0 清零 | P0 未清不做新批次 |

### 5.3 T0+7d

| 项 | 目标／动作 |
|---|---|
| 可用性 | 记录实际 uptime；不宣称 SLA |
| 成本 | 汇总 7 天 `billedCostMicroUsd`；与 DeepSeek 账单对照，差异 >5% 查价格 |
| 30 分钟 SSE | 完成一次真实长视频测试；通过则解除“只推短视频”限制；失败则继续限制并排期修 |
| 恢复演练 | 再跑一次 `restore_drill.sh`；PASS 记录 |
| 离机备份 | 复核 R1：配置 rclone／对象存储或明确延期；不能一直“暂不做” |
| 法务复核 | 复核 R3：法务文本是否需改；改完再发新批次 |
| 飞书签名 | 加 `FEISHU_WEBHOOK_SECRET` 或 IP 白名单；未完成则限制群成员／轮换 webhook |
| 用户反馈 | 归类：阻断／体验／内容／合规；P0 清零 |
| Gate 决策 | 继续 G1／准备 G2／暂停；**不得自动开公开注册** |

### 5.4 指标口径与命令

- 管理台「概览／计费／用量与健康」或：
  - `GET /api/admin/stats`
  - `GET /api/admin/usage?days=7`
  - `GET /api/admin/billing/summary?from=<YYYY-MM-DD>&to=<YYYY-MM-DD>`
  - `GET /api/admin/health`
- Caddy 访问日志：`journalctl -u caddy --since '1 hour ago' --no-pager | tail -200`
- 容器日志：`docker compose logs --since 1h app`
- 磁盘：`df -h /`、`docker system df`
- 备份：`ls -lh /srv/ln/backups | tail`
- 证书：`openssl s_client ... -dates`

**未计费口径**：`billing/summary` 的 `totals.unbilledRows`、`totals.settleFailedRows`、`unpricedModels`、`holds.activeCount`。这四个是 G1 每天必看项；不要只看 `estimatedCostUsd`，它不是账单。

---

## 6. Go/No-Go 一页纸（15 条）

> 目标：G1 邀请制内测。逐条勾选；**1–9、14–15 任一不通过 = No-Go**。10–13 允许“带风险放行”，但必须填写负责人、复核日期、缓解措施；缺一项 = No-Go。  
> 签字人：发布负责人、运维负责人、法务/产品负责人、成本负责人。角色名必须替换为真实姓名。

- [ ] **1. Gate 与角色已签字**：明确是 G1；发布负责人、回滚决策人、值班人、法务／成本联系人已指定。
- [ ] **2. 版本已冻结**：部署 commit=`41c463b`（或新 SHA）；镜像 tag 与 healthz version 一致；未跟踪文件不进入发布物。
- [ ] **3. 运行健康**：`/healthz` 200；`db.ok=true`；`current=head=0025_balance_cost`（或新 head 一致）。
- [ ] **4. 入口与 TLS**：主域 200；无 `WWW-Authenticate`；HSTS／CSP 存在；www 301；证书 >30 天。
- [ ] **5. 注册闸门**：`registrationOpen=false`、`inviteRequired=true`；无码注册 403 `invite_required`。
- [ ] **6. 管理员可用**：管理员 API 登录 200、`isAdmin=true`；能生成／撤销邀请码；后台 UI 可用或明确 API 兜底。
- [ ] **7. 邀请闭环**：测试码注册 201；$2 到账；撤销后不能注册；测试账号已清理。
- [ ] **8. 备份可恢复**：当日本机备份非 0；`restore_drill.sh` PASS；T-1 手工下载副本已校验。
- [ ] **9. 模型与计费**：`deepseek-chat.available=true`；Qwen 不在推荐；若 UI 暴露 Qwen，选择后必须明确 503 `model_unpriced`、不静默扣费；`BILLING_STRICT=1`；`unbilledRows=0`。
- [ ] **10. 30 分钟 SSE**：通过，或带风险放行（负责人＋日期＋“首批只推短视频”）。
- [ ] **11. 离机备份**：已配置，或带风险放行（负责人＋日期＋T-1 手工下载副本）。
- [ ] **12. 法务复核**：文本已复核，或带风险放行（负责人＋日期＋只免费、不收费、文案标明内测）。
- [ ] **13. 价格复核**：DeepSeek 价格已对账，或带风险放行（负责人＋日期＋严格计费＋每日对账）。
- [ ] **14. 飞书告警**：test `sent=true`；无签名风险已接受，或有签名／IP 白名单计划（负责人＋日期）。
- [ ] **15. 回滚与沟通**：镜像／Caddy／DB 恢复步骤已演练；公告、邀请名单、值班表就绪；不宣称正式发布。

### 6.1 带风险放行表（10–14 专用）

| 项 | 选择（通过／带风险） | 负责人（真实姓名） | 复核日期 | 缓解措施 | 签字 |
|---|---|---|---|---|---|
| 30 分钟 SSE |  |  | 2026-11-25 | 首批 3–5 人；只推短视频；断流停新码；记录代理日志 |  |
| 离机备份 |  |  | 2026-11-28 | T-1 手工下载一份；本机每日备份；恢复演练；首批用户告知风险 |  |
| 法务复核 |  |  | 2026-11-27 | 免费内测；无支付；只用 hash 链接；文案标注“待法务复核” |  |
| 价格复核 |  |  | 2026-12-01 | 严格计费；日预算；每日对账；差异 >5% 停新码 |  |
| 飞书无签名 |  |  | 2026-11-28 | 限制群成员；准备轮换 webhook；启用 `FEISHU_WEBHOOK_SECRET` 或 IP 白名单 |  |

> 如果复核日期到了还没做，**不能自动续期**；必须重新签字，否则停止发新码。

### 6.2 No-Go 触发（任一）

- `/healthz` 非 200，或 `current != head`，或 DB 不可读。
- 无码注册没有 403，或 `REGISTRATION_OPEN=true`。
- 管理员无法登录／无法生成邀请码，且没有 API 兜底。
- 邀请码闭环失败（注册／$2／撤销任一）。
- 本机备份缺失，或 `restore_drill.sh` 失败。
- 发现生产密钥进入前端 bundle、日志、文档或群。
- 有未处理的 P0 数据损坏、越权、计费跑飞。
- 试图在 G1 接支付／公开注册／发正式发布公告。
- 带风险项没有负责人或复核日期。
- 回滚命令没人会跑，或旧镜像／Caddy 备份不存在。

---

## 7. 回滚

> 原则：**先止血，再定位；一次只动一个变量；30 分钟内能回到上一个可用版本。**  
> 回滚决策人：发布负责人；执行人：运维。数据库恢复是最后手段，先确认是否真的需要。

### 7.1 回滚触发条件

- `/healthz` 非 200 持续 >5 分钟，或容器反复重启。
- 5xx >5% 持续 >10 分钟，或核心页面不可用。
- 迁移失败、DB 损坏、数据被误删。
- 计费跑飞：余额异常扣减、`settleFailedRows` 激增、负余额。
- 安全事件：密钥泄露、越权访问、异常注册。
- 长 SSE 全面断流且短时间修不好（可先停长视频，不一定全站回滚）。

### 7.2 镜像／容器回滚

```bash
cd /srv/ln/app
docker images 'linguatrek:*'
# 找到上一个可用 tag，例如 41c463b 或 rollback-20261124

IMAGE_TAG=<OLD_IMAGE_TAG> docker compose up -d --no-build
docker compose ps
docker inspect --format '{{.Config.Image}}' linguatrek-app-1
docker compose logs --tail=100 app
curl -fsS http://127.0.0.1:8000/healthz | python3 -m json.tool
```

- `--no-build` 防止 Compose 顺手重建。
- 如果旧镜像不在本地：不要在生产目录 `git checkout` 后直接 build 覆盖；先用备份恢复数据，再按旧 commit 构建，记录耗时。
- 回滚后检查：登录、首页、`define`、短视频 SSE、管理员登录。
- 数据库迁移**不会**随镜像回滚；旧代码通常能读新库（只加表／列），但必须实测。若旧代码读不了新库，走 7.4。

### 7.3 Caddy 回滚

T0 前先备份：

```bash
sudo cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)"
```

回滚：

```bash
sudo cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bad-$(date +%F-%H%M)"
sudo cp "/etc/caddy/Caddyfile.bak-<STAMP>" /etc/caddy/Caddyfile
sudo chown root:caddy /etc/caddy/Caddyfile
sudo chmod 640 /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --envfile /etc/caddy/g1.env
sudo systemctl reload caddy
```

- 回滚后重测：首页 200、无 `WWW-Authenticate`、`/healthz` 200、www 301、短视频 SSE。
- **不要**把 `/etc/caddy/Caddyfile.with-basic-auth.bak` 当默认回滚目标：它会让站点回到需要网关密码的状态，而 G1 已不再持有那套凭据。只有单独评审并恢复 `/etc/caddy/g1.env` 里的凭据后才可用。
- 改 Caddy 前先 `validate`；reload 失败再 `restart`，并看 `journalctl -u caddy`。

### 7.4 数据库恢复

> 恢复会覆盖当前 `app.db` 和用户数据。只有在确认数据损坏／误删／迁移不可回退时才做；先保留现场。

```bash
cd /srv/ln/app
export IMAGE_TAG=41c463b   # 或当前可用 tag；如果当前镜像坏了，用 <OLD_IMAGE_TAG>
docker compose stop app

docker compose run --rm --no-deps \
  -v /srv/ln/backups:/backups \
  -v "$PWD/scripts:/scripts:ro" \
  --entrypoint /bin/bash \
  app /scripts/restore.sh "/backups/<BACKUP_FILE>" --to /data --force

docker compose start app
curl -fsS http://127.0.0.1:8000/healthz | python3 -m json.tool
docker compose exec app sh -lc 'sqlite3 /data/app.db "PRAGMA integrity_check;"'
```

- `restore.sh` 会先校验 `SHA256SUMS`／manifest，再把旧数据移到 `.pre-restore-*`；确认新数据正常后再清理旧目录。
- 恢复后验证：旧账号能登录、历史还在、余额／账本合理、管理员能登录。
- 如果当前镜像坏了，用旧镜像跑 restore：`IMAGE_TAG=<OLD_IMAGE_TAG> docker compose run ...`。
- 不要在服务运行中直接覆盖 `/data/app.db`；SQLite WAL 会不一致。

### 7.5 不可逆迁移说明

- 本仓库 **Alembic downgrade 未验收**，不承诺可用；不要在生产执行 `alembic downgrade`。
- 当前基线 `0025_balance_cost`；未来迁移只应加表／加列。旧代码通常能读新库，但必须实测登录／核心页面。
- 迁移前必须备份；迁移失败先停 app，不要连续重试写库。
- 不要 `alembic stamp head`；不要手改 `alembic_version`；不要手工 `ALTER TABLE` 修生产库。
- 如果迁移已经破坏数据：停 app → 恢复备份 → 用旧镜像启动 → 记录事故 → 再决定是否重跑迁移。

### 7.6 回滚记录

| 项 | 记录 |
|---|---|
| 触发时间／触发条件 |  |
| 决策人／执行人 |  |
| 回滚类型（镜像／Caddy／DB） |  |
| 回滚前版本／回滚后版本 |  |
| 数据是否恢复／备份文件 |  |
| 恢复耗时 |  |
| 验证结果（healthz／登录／AI／SSE） |  |
| 后续动作／负责人 |  |

---

## 8. 故障处理

> 先分级，再动手。G1 没有 24/7 值班，P0 直接打电话；P1 1 小时内处理；P2 次日。

### 8.1 分级

| 级别 | 例子 | 响应 |
|---|---|---|
| P0 | 全站 502／503、证书过期、数据损坏、密钥泄露、计费跑飞、越权 | 立即止血；停发新码；必要时维护模式／回滚；通知发布负责人 |
| P1 | AI 全挂、SSE 大面积断、备份失败、飞书不可达、单用户余额异常 | 1 小时内处理；发公告；记录 |
| P2 | 单页面 UI 问题、单个模型不可用、非核心接口报错 | 次日处理；记录到已知问题 |

### 8.2 502／503

**502（Caddy 连不上 app）**

```bash
cd /srv/ln/app
docker compose ps
curl -fsS http://127.0.0.1:8000/healthz || true
docker compose logs --tail=200 app
sudo systemctl status caddy --no-pager
sudo journalctl -u caddy --since '10 min ago' --no-pager | tail -100
```

- 容器挂了：`docker compose up -d`；反复重启看日志（OOM／迁移／权限）。
- 容器健康但 Caddy 502：检查 Caddy upstream 是否 `127.0.0.1:8000`；`caddy validate`；reload。
- 不要用 `docker compose scale app=2`“分担”；SQLite 单写，会坏。

**503（应用未就绪／维护模式／DB 不可读）**

- 看 `/healthz` 的 `db.ok`／`migrations.current/head`；不要盲目迁移。
- 磁盘满：`df -h /`、`docker system df`；清日志／旧镜像前先确认回滚 tag 保留。
- 维护模式：`GET /api/admin/settings` 看 `maintenance_mode`；非管理员 `/api/*` 会 503。止血后记得关。
- 迁移不匹配：先回滚镜像；不要连跑 `alembic upgrade head`。

### 8.3 证书／TLS

```bash
openssl s_client -connect linguatrekai.online:443 -servername linguatrekai.online </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
sudo systemctl status caddy --no-pager
sudo journalctl -u caddy --since '1 hour ago' --no-pager | grep -iE 'certificate|acme|error' | tail -50
```

- 证书未到期但浏览器报错：查系统时间、Caddy 是否 reload、DNS 是否被改。
- 到期／续期失败：确认 80/443 放行、DNS 指向本机、Caddy 能出网；`systemctl reload caddy`，再看日志。
- 不要关闭 HTTPS、不要用自签证书长期顶替；不要同时改 DNS 和 Caddy。
- 若使用 Cloudflare：先灰云／Full (strict)，不要让 `/api/*` 被缓存；当前不依赖 Cloudflare 代理。

### 8.4 SSE 断流

**症状**：长视频在 60s／100s／几分钟断；短测试通过但长测试失败。

```bash
BASE=https://linguatrekai.online
curl -N --max-time 2400 \
  -b /tmp/ln.smoke.cookie \
  -X POST "$BASE/api/process-video-stream" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=<VIDEO_ID>","model":"deepseek-chat"}' \
  | tee /tmp/ln-sse.log

grep -c '^: ping' /tmp/ln-sse.log
grep -E '^event: (meta|batch|stage|summary|done)' /tmp/ln-sse.log | tail
```

- 正常：`meta` 很快到；`: ping` 约每 15 秒；`done` 结束；无 5xx。
- 查 Caddy：`flush_interval -1`、`read_timeout 24h`、`response_header_timeout 24h`。
- 查 Cloudflare／代理空闲超时；有橙云先灰云验证。
- 修复前：停发长视频邀请，只推短视频；不要反复烧模型额度做长测。
- 不要同时改 Caddy、Cloudflare、模型 Key；一次只动一个。

### 8.5 余额异常

**症状**：用户余额为负、扣费明显不对、`settleFailedRows` 增长、`unbilledRows` 非 0。

```bash
BASE=https://linguatrekai.online
curl -sS -b /tmp/ln.admin.cookie \
  "$BASE/api/admin/billing/summary?from=<YYYY-MM-DD>&to=<YYYY-MM-DD>" \
  | python3 -m json.tool

curl -sS -b /tmp/ln.admin.cookie \
  "$BASE/api/admin/users/<USER_ID>/ledger" | python3 -m json.tool
```

- 先看 `ai_usage`／`account_ledger`／`credit_holds` 是否一致；不要先手工改余额。
- 需要补偿时用 `POST /api/admin/users/{id}/balance`，写原因＋幂等键；不要直接 SQL。
- 负余额／跑飞：停发新码；必要时维护模式；保留日志；通知成本负责人。
- `unbilledRows>0`：查 `unpricedModels`；缺价模型隐藏或补价；不要用“免费调用”兜底。
- `settleFailedRows>0`：查 hold 是否过期、结算异常；按账本对账，不要静默漏扣。

### 8.6 模型不可用

| 症状 | 先查 | 处置 |
|---|---|---|
| 403 `login_required` | 用户是否登录；Cookie 是否被清 | 让用户重新登录；游客 AI 本来就不允许 |
| 402 `insufficient_balance` | 用户余额、是否被其他调用扣完 | 充值／调余额；不要绕过计费 |
| 503 `model_unpriced` | 模型是否在 `recommended`；价格表是否有价 | 切回 `deepseek-chat`；隐藏该模型；补官方价后再开 |
| 503 provider 错误 | DeepSeek Key、余额、厂商状态 | 看服务端日志；必要时维护模式＋公告；不要切到缺价 Qwen |
| 模型列表 `available=false` | Key 是否加载；env 是否被改 | 检查 `.env` 键是否存在（不打印值）；重启容器；不要发 Key 到群 |

- 当前生产路线：中文／越南语都走 `deepseek-chat`；Qwen 不进入推荐路线。
- `/api/models` 里 Qwen 可能显示 `available=true`，但严格计费会 503；不要把它当作可用模型宣传。
- 模型故障时不要关严格计费（`BILLING_STRICT=0` 是迁移逃生门，不是日常开关）。

### 8.7 账号删除／导出

**导出**：

- 用户账户页发起导出；密码确认；202 返回 `jobId`／`downloadToken`；token 只出现一次，ZIP 默认 24h 有效。
- 管理员不要用邮件发 ZIP；不要发到群里；下载后提醒用户保存。
- 导出失败：看 `jobs`／磁盘／`/data/exports`；不要手工拼接用户数据。

**删除**：

- 用户提交删除 → 202 `pending`，7 天冷静期；会话失效。
- 冷静期内用户可取消；取消需要重新登录＋密码。
- 管理员执行：`POST /api/admin/deletion-requests/{id}/execute`，`confirm=DELETE`；冷静期未满需 `force=true` 且用户书面要求。
- 删除后验证：登录 401、`users` 无行、`/data/users/<id>` 不存在、相关会话清掉；备份中的副本按保留期到期消失。
- **不要直接 `DELETE FROM users`**；不要跳过审计；不要删除管理员账号。

### 8.8 飞书／磁盘／其他

- 飞书 test 失败：看响应 `status=disabled|not_configured|failed`；`failed.reason` 有 `timeout`／`http_xxx`／`feishu_code_xxx`；不要回显 webhook。
- 无签名：限制群成员；准备轮换 webhook；T+7 前加 `FEISHU_WEBHOOK_SECRET` 或 IP 白名单。
- 磁盘 >70%：查备份／导出／日志；>85% 停新邀请／导出；不要删 `app.db`／用户目录。
- 时间不同步：`timedatectl`；NTP 影响飞书签名（如果启用）。
- 所有故障处理完写一条记录：时间、症状、根因、动作、证据、后续。

---

## 9. 明确不做（G1 边界）

| 项 | 明确不做 | 对外口径 |
|---|---|---|
| 公开注册 | 不打开 `REGISTRATION_OPEN`；不投放公开注册链接 | “邀请制内测” |
| 支付／订阅／充值 | 不接支付、不做订阅、不做退款／发票 | “内测免费，定价未定” |
| 邮件 | 不发验证邮件、找回密码邮件、通知邮件 | “暂无邮箱验证／找回密码／改密” |
| 未成年人 | 不主动面向未成年人；邀请人把关；不做年龄验证 | “邀请制、非面向未成年人” |
| PWA／离线 | 不宣传安装、离线、推送；service worker 缓存问题不在 G1 验收 | “浏览器访问，不承诺离线” |
| 多副本／多 worker | 不 `scale`、不加第二个容器、不改多 worker | “单机单副本” |
| 公开营销／SEO | 不做公开投放、sitemap／robots／OG 补齐不在 G1 | “内测，不对外推广” |
| 长视频承诺 | 30 分钟 SSE 未验收前，不承诺长视频稳定 | “首批先短视频” |
| 离机备份 | 不宣称已配置；只有本机备份＋手工副本 | “本机备份，离机待补” |
| 课程生成入口 | 保持隐藏；不要因为内测打开 | “课程生成暂不开放” |
| 正式发布 | 不开发布会、不写“正式上线”、不承诺 SLA | “G1 邀请制内测” |

> 一句话：**G1 是“邀请制内测”，不是“正式发布”；免费不等于可以收费，能登录不等于可以公开注册。**

---

## 10. 附：命令清单

> 只列可执行命令；所有 `<...>` 都是占位符，执行前替换。不要在本文件、聊天、截图里写真实 Key／webhook／密码／邀请码。  
> 默认在 `/srv/ln/app` 执行 Docker 命令；SSH 用 `-p 63916`。当前用户不在 docker 组时，给 `docker` 加 `sudo`；不要改文件属主。

### A. 冻结与版本

```bash
cd /srv/ln/app
git status --porcelain
git rev-parse HEAD
git show -s --format='%H %ci %s' HEAD
git describe --tags --always

docker inspect linguatrek-app-1 --format '{{.Config.Image}}'
docker image inspect linguatrek:41c463b --format '{{.Id}} {{.Created}}'
docker compose ps
docker volume inspect linguatrek_linguatrek-data
```

### B. SSH／容器／健康

```bash
ssh -p 63916 ggcuser@43.245.199.136

cd /srv/ln/app
docker compose ps
docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q app)"
curl -fsS http://127.0.0.1:8000/healthz | python3 -m json.tool
curl -sSI http://127.0.0.1:8000/ | head -10
docker compose logs --tail=200 app
docker stats --no-stream
df -h /
docker system df
```

### C. 公网入口／DNS／TLS／Caddy

```bash
BASE=https://linguatrekai.online

curl -sSI "$BASE/" | head -20
curl -sSI "$BASE/healthz" | head -20
curl -sSI https://www.linguatrekai.online/ | head -5
curl -sS "$BASE/api/auth/registration"; echo

dig +short @1.1.1.1 linguatrekai.online
dig +short @1.1.1.1 www.linguatrekai.online

openssl s_client -connect linguatrekai.online:443 -servername linguatrekai.online </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates

sudo systemctl is-active caddy
caddy version
sudo caddy validate --config /etc/caddy/Caddyfile --envfile /etc/caddy/g1.env
sudo grep -nE 'basic_auth|flush_interval|read_timeout|response_header_timeout|www\.' /etc/caddy/Caddyfile
sudo journalctl -u caddy --since '1 hour ago' --no-pager | tail -100
```

### D. 安全组／防火墙／端口

```bash
sudo ufw status verbose
sudo ss -lntp | grep -E ':80|:443|:8000|:63916'
nc -zv -w 3 43.245.199.136 63916
nc -zv -w 3 43.245.199.136 80
nc -zv -w 3 43.245.199.136 443
```

### E. 管理员登录／邀请码

```bash
BASE=https://linguatrekai.online

install -m 600 /dev/null /tmp/ln-admin-login.json
"${EDITOR:-vi}" /tmp/ln-admin-login.json
# {"email":"<ADMIN_EMAIL>","password":"<ADMIN_PASSWORD>"}

curl -c /tmp/ln.admin.cookie \
  -H 'Content-Type: application/json' \
  --data @/tmp/ln-admin-login.json \
  "$BASE/api/auth/login"

curl -sS -b /tmp/ln.admin.cookie "$BASE/api/auth/me" | python3 -m json.tool

curl -sS -b /tmp/ln.admin.cookie \
  -X POST "$BASE/api/admin/invites" \
  -H 'Content-Type: application/json' \
  -d '{"count":1,"label":"G1-<BATCH>","maxUses":1,"expiresInDays":14}' \
  | tee /tmp/ln-invite.json

python3 -c 'import json; print(json.load(open("/tmp/ln-invite.json"))["codes"][0]["id"])'
python3 -c 'import json; print(json.load(open("/tmp/ln-invite.json"))["codes"][0]["code"])' \
  > /tmp/ln-invite.code
chmod 600 /tmp/ln-invite.code

curl -sS -b /tmp/ln.admin.cookie \
  "$BASE/api/admin/invites?status=all&limit=20" | python3 -m json.tool

curl -sS -b /tmp/ln.admin.cookie \
  -X POST "$BASE/api/admin/invites/<INVITE_ID>/revoke" | python3 -m json.tool

rm -f /tmp/ln-admin-login.json
```

### F. 测试注册／余额／AI

```bash
BASE=https://linguatrekai.online

install -m 600 /dev/null /tmp/ln-signup.json
"${EDITOR:-vi}" /tmp/ln-signup.json
# {"email":"<SMOKE_EMAIL>","password":"<SMOKE_PASSWORD>","username":"<SMOKE_USERNAME>","inviteCode":"<INVITE_CODE>"}

curl -c /tmp/ln.smoke.cookie -D /tmp/ln-smoke.headers \
  -H 'Content-Type: application/json' \
  --data @/tmp/ln-signup.json \
  "$BASE/api/auth/signup"

grep -i '^set-cookie' /tmp/ln-smoke.headers
# 期望 ln_session=...; HttpOnly; Secure; SameSite=Lax; Path=/

curl -sS -b /tmp/ln.smoke.cookie "$BASE/api/user/summary" | python3 -m json.tool
# 期望 balanceMicroUsd=2000000、balanceUsd="2.00"

curl -sS -b /tmp/ln.smoke.cookie \
  -X POST "$BASE/api/define" \
  -H 'Content-Type: application/json' \
  -d '{"word":"<NEW_WORD>","targetLang":"zh-CN"}' | python3 -m json.tool

rm -f /tmp/ln-signup.json
```

### G. 备份／恢复

```bash
cd /srv/ln/app
export IMAGE_TAG=41c463b   # 当前线上 tag；新版本发布后改成新 tag

docker compose run --rm --no-deps \
  -v /srv/ln/backups:/backups \
  -v "$PWD/scripts:/scripts:ro" \
  -e BACKUP_ROOT=/backups \
  -e ENV_FILE=/dev/null \
  --entrypoint /bin/bash \
  app /scripts/backup.sh --keep 7

ls -lh /srv/ln/backups | tail

# 恢复演练（不写真实数据）
docker compose run --rm --no-deps \
  -v "$PWD/scripts:/scripts:ro" \
  -e ENV_FILE=/dev/null \
  --entrypoint /bin/bash \
  app /scripts/restore_drill.sh

# 下载一份到本地（一次性，不是离机策略）
scp -P 63916 ggcuser@43.245.199.136:/srv/ln/backups/<BACKUP_FILE> ~/ln-backups/
shasum -a 256 ~/ln-backups/<BACKUP_FILE>
# 服务器上：sha256sum /srv/ln/backups/<BACKUP_FILE>

# 真实恢复（先停 app，确认后再做）
docker compose stop app
docker compose run --rm --no-deps \
  -v /srv/ln/backups:/backups \
  -v "$PWD/scripts:/scripts:ro" \
  --entrypoint /bin/bash \
  app /scripts/restore.sh "/backups/<BACKUP_FILE>" --to /data --force
docker compose start app
curl -fsS http://127.0.0.1:8000/healthz | python3 -m json.tool
```

### H. 监控／成本／告警

```bash
BASE=https://linguatrekai.online

curl -sS -b /tmp/ln.admin.cookie "$BASE/api/admin/stats" | python3 -m json.tool
curl -sS -b /tmp/ln.admin.cookie "$BASE/api/admin/health" | python3 -m json.tool
curl -sS -b /tmp/ln.admin.cookie "$BASE/api/admin/usage?days=7" | python3 -m json.tool
curl -sS -b /tmp/ln.admin.cookie \
  "$BASE/api/admin/billing/summary?from=<YYYY-MM-DD>&to=<YYYY-MM-DD>" \
  | python3 -m json.tool

curl -sS -b /tmp/ln.admin.cookie \
  -X POST "$BASE/api/admin/alerts/test" \
  -H 'Content-Type: application/json' -d '{"level":"P1"}'

# 只列 env 键名，不打印值
docker compose exec app sh -lc 'for k in ADMIN_EMAILS DEEPSEEK_API_KEY INVITE_CODE_PEPPER FEISHU_WEBHOOK_URL BILLING_STRICT REGISTRATION_OPEN INVITE_SIGNUP_ENABLED; do printenv "$k" >/dev/null && echo "$k set" || echo "$k MISSING"; done'
```

### I. 回滚

```bash
cd /srv/ln/app
docker images 'linguatrek:*'
docker tag linguatrek:41c463b linguatrek:rollback-20261124

IMAGE_TAG=<OLD_IMAGE_TAG> docker compose up -d --no-build
docker compose ps
curl -fsS http://127.0.0.1:8000/healthz | python3 -m json.tool

# Caddy 备份
sudo cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)"

# Caddy 回滚（替换 STAMP）
sudo cp "/etc/caddy/Caddyfile.bak-<STAMP>" /etc/caddy/Caddyfile
sudo chown root:caddy /etc/caddy/Caddyfile
sudo chmod 640 /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --envfile /etc/caddy/g1.env
sudo systemctl reload caddy
```

### J. 账号删除／导出（用户自助，管理员辅助）

```bash
BASE=https://linguatrekai.online

# 导出（用户密码放 600 文件）
install -m 600 /dev/null /tmp/ln-export.json
"${EDITOR:-vi}" /tmp/ln-export.json
# {"password":"<SMOKE_PASSWORD>"}

curl -sS -b /tmp/ln.smoke.cookie \
  -X POST "$BASE/api/account/export" \
  -H 'Content-Type: application/json' \
  --data @/tmp/ln-export.json | tee /tmp/ln-export-job.json \
  | python3 -m json.tool

# 删除申请（7 天冷静期）
install -m 600 /dev/null /tmp/ln-delete.json
"${EDITOR:-vi}" /tmp/ln-delete.json
# {"password":"<SMOKE_PASSWORD>","username":"<SMOKE_USERNAME>","confirm":"DELETE","reason":"smoke cleanup"}

curl -sS -b /tmp/ln.smoke.cookie \
  -X POST "$BASE/api/account/deletion" \
  -H 'Content-Type: application/json' \
  --data @/tmp/ln-delete.json | python3 -m json.tool

# 管理员执行（仅在确认后；force 只用于测试账号）
curl -sS -b /tmp/ln.admin.cookie \
  -X POST "$BASE/api/admin/deletion-requests/<REQUEST_ID>/execute" \
  -H 'Content-Type: application/json' \
  -d '{"confirm":"DELETE","reason":"smoke cleanup","force":true}' \
  | python3 -m json.tool
```

---

## 11. T-0 便签（打印这一页）

```text
┌──────────────────────────────────────────────────────────────────────┐
│  linguatrekai.online — G1 邀请制内测 T-0 便签                        │
│  日期：2026-11-24（周二）    T0 时间：________                        │
│  发布负责人：________   回滚决策人：________   值班：________        │
│  范围：邀请制内测；不公开注册；不收费；不称“正式发布”                │
├──────────────────────────────────────────────────────────────────────┤
│  T-0 前 5 项（全过才发码）                                           │
│  [ ] healthz 200 / version=41c463b / current=head=0025_balance_cost  │
│  [ ] 管理员登录 isAdmin=true；邀请码页/API 可生成、可撤销             │
│  [ ] 本机备份新文件；restore_drill.sh PASS；手工下载副本已校验       │
│  [ ] Caddy validate；首页 200 无 WWW-Authenticate；www 301；证书>30d│
│  [ ] Go/No-Go 15 条签字；带风险项有 owner + 复核日期                 │
├──────────────────────────────────────────────────────────────────────┤
│  T0 顺序（不换代码时跳过 1/3/4）                                     │
│  1. 冻结 commit/tag（仅新版本）                                      │
│  2. 备份 → 记录文件名/SHA256                                         │
│  3. 迁移（仅新版本）→ current=heads                                  │
│  4. 重启 → docker compose ps healthy → healthz 200                   │
│  5. 冒烟：首页/注册闸门/管理员/邀请码/注册/define/短视频 SSE         │
│  6. 逐个发码 + 公告（只发邀请渠道）                                  │
│  7. 1h 看板：5xx、注册、余额、AI、unbilled、飞书、备份               │
├──────────────────────────────────────────────────────────────────────┤
│  禁止                                                               │
│  × 开 REGISTRATION_OPEN       × 接支付/订阅/充值/退款/发票           │
│  × docker compose scale       × 用裸 /privacy、/terms                │
│  × 把 Key/webhook/密码/邀请码发群/截图/写文档                        │
│  × 宣称“正式上线”“全绿”“离机备份已完成”                             │
├──────────────────────────────────────────────────────────────────────┤
│  30 分钟回滚（先止血，再定位）                                       │
│  docker images 'linguatrek:*'                                        │
│  IMAGE_TAG=<OLD_TAG> docker compose up -d --no-build                  │
│  curl -fsS http://127.0.0.1:8000/healthz                              │
│  Caddy：cp 备份 → caddy validate → systemctl reload caddy             │
│  DB：stop app → restore.sh → start app → healthz → integrity_check    │
├──────────────────────────────────────────────────────────────────────┤
│  联系人                                                             │
│  发布负责人：________   运维：________   法务：________              │
│  成本：________         管理员：________                             │
├──────────────────────────────────────────────────────────────────────┤
│  签字：发布________  运维________  法务________  成本________        │
│  时间：________                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

> **最后提醒**：当前能开的是 **G1 邀请制内测**。公开注册、收费、正式发布都不在本次范围；长 SSE、离机备份、法务复核、价格复核未完成时，按第 6 节的带风险放行表处理——有负责人、有复核日期、有缓解措施，才叫“可控风险”；否则就是 No-Go。
