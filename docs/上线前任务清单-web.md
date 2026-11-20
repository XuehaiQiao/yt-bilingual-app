# 语途（LinguaTrek）Web 上线前任务清单

> **版本**：v1.0 · 2026-11-20
> **范围**：只覆盖 **Web**（浏览器访问的 `frontend/` + `backend/` + SQLite + Caddy/Docker 部署）。不含 `mobile/`、原生桌面端、离线安装包。
> **快照**：`main` 分支 HEAD `f136bb1`（2026-11-20 07:26 +08:00）；工作区当时仍有未跟踪脚本 `scripts/books-all-shots.mjs`。发布冻结必须以实际提交树为准。
> **依据**：[计划-上线部署.md](./计划-上线部署.md)（2026-11-13 草案，只引用结论，不照抄其中已过期的状态）、[部署指南.md](./部署指南.md)、`deploy/`、`.env.example`、`.github/workflows/ci.yml` 与当前代码。
> **边界**：本文只写清单、验收方法与执行顺序，不改代码、不提交 git；所有复选框默认未勾选。**本文不声称测试全绿、不声称已部署或已上线。**
>
> **一句话结论：现在不能直接公开收费上线；邀请制内测（G1）在 P0 全部完成后可以先走；公开免费注册（G2）必须再补 P1 优先级任务；收费（G3）必须再补 P2 优先级任务。三个 gate 不得跳级。**

---

## 0. 适用范围与当前结论

### 0.1 适用范围

| 范围 | 内容 |
|---|---|
| **包含** | `frontend/`（React 19 + Vite）、`backend/`（FastAPI + SQLite + Alembic）、`deploy/`（Caddy / systemd / Docker / 备份）、公开站页面、账号与游客体系、AI 字幕翻译、本地视频字幕翻译、后台止血台 |
| **不包含** | `mobile/`（Expo，未跟进流式）、任何原生客户端、应用商店发布、微信/支付宝小程序 |
| **不承诺** | 多副本水平扩展；当前架构是单 SQLite 写进程、进程内限流/缓存，只能 1 个 uvicorn worker、1 个副本 |

### 0.2 当前结论

| 问题 | 结论 | 依据（摘要） |
|---|---|---|
| 能否**邀请制内测**？ | **完成 P0 后可以；法务/文案最小集已落地（M4，2026-11-20）**：隐私政策/使用协议已是真实公开页，本地视频文案已修正，注册页已披露邀请制/无邮箱验证/冷静期/字幕送 LLM。仍缺真实可收信联系渠道（P1-03）、法务复核，生产备份与告警尚未验证 | `PrivacyPolicyScreen.tsx` / `TermsScreen.tsx`；`npm run check:legal` 11/11；`AuthScreen.tsx` 的 `auth-signup-disclosure`；`routes_auth.py` / `routes_account.py` 端点清单 |
| 能否**公开免费注册**？ | **不能**。缺邮箱验证或可持续邀请码、找回密码、改密、删除账号、会话吊销、CSRF/Origin 校验、注册开关、监控告警、完整 QA | 见 P1/P2 优先级任务；当前 `signup` 只要邮箱格式合法即可创建账号 |
| 能否**收费**？ | **不能**。没有支付、税务、退款、订阅、发票、对账；定价页明确写“内测免费，定价即将公布” | `PricingScreen.tsx` 与 `zh-CN.json` 的 `public.pricing.*`；仓库内无支付代码 |
| 当前测试是否全绿？ | **未知，本文不声称全绿**。2026-11-20 实测 `pytest --collect-only` 收集 **1122** 项；本文没有运行全量测试 | 本地命令见 §8 C-1；CI 只在 push/PR 时跑 |
| UI 是否已完全合规？ | **不能这样写**。A1 审计 90 条是存量债务；W5b 基线扫描是 report-only；屏级覆盖 **21/27（77.8%）**，仍有 6 个页面未覆盖；CI 的 `design-scan` 故意不阻断 | `docs/design-governance/reports/ui-baseline-2026-11-19.md`；`remediation-status.md` |
| 课程生成入口是否有暴露？ | 已隐藏：`SHOW_COURSE_GENERATION = false`；但“隐藏”不等于“删除”，发版前仍需回归 | `frontend/src/App.tsx` |
| 是否已经有支付？ | 没有。`credits` 只能由管理员手动调账，没有充值/订阅/支付 webhook | `backend/migrations/versions/0013_user_profile.py`；`routes_admin.py` |

### 0.3 阅读与勾选方式

1. 先在 `§0.2` 确认首发 gate；**只做当前 gate 及其之前 gate 的任务**。
2. 每个任务都有 `ID / 优先级 / 阻塞 Gate / 执行动作 / 验收证据 / 依赖 / 工时 / 状态` 八列。
3. 完成后把 `[ ]` 改成 `[x]`，并在证据列补日期、命令输出或链接；没有证据不算完成。
4. 每个 gate 结束前用 `§5` 的最小通过集复核；最后用 `§7` 的 15 条 Go/No-Go 一页纸签字。
5. 命令分两类：`§8 C-1/C-2/C-7/C-9` 可在本仓库直接执行；`§8 C-3–C-6/C-8` 必须在部署机/真实域名执行，未在本机生产环境验证，标 `[先核实]` 的项必须先确认再执行。
6. 本文档本身需要随发布提交入库；在未提交前 `git status` 会显示它，这是预期，不计入 P0-02 的“未跟踪文件”。

---

## 1. 三个 Gate 的定义与通过标准

| Gate | 定义 | 入口 / 账号 | 付费 | 通过标准（硬条件） | 明确不能带进下一阶段 |
|---|---|---|---|---|---|
| **G1 邀请制内测** | 只给 10–30 个已知用户使用；站外不可自助注册；免费 | 应用内邀请码（一人一码）+ 登录用户 + 受限游客；Caddy 网关已移除 | 无 | **P0 全部完成**；隐私/条款/联系渠道可见；字幕送 LLM 已披露；备份+恢复演练通过；HTTPS/健康检查/SSE 30 分钟通过；越权测试通过；无找回/改密/删号已公告 | 公开注册；任何收费；未验收的本地视频/课程入口；未完成的法务页 |
| **G2 公开免费注册** | 任何人可注册，免费使用；注册即登录 | 邮箱验证（推荐）或持续邀请码；`REGISTRATION_OPEN` 开关可用 | 无 | **P0 + P1 全部完成**；找回密码/改密/删号/会话吊销可用；CSRF/Origin 校验；注册开关与限流；监控告警；完整 QA 矩阵；公开站 meta/robots/404 可用 | 任何收费；未对账的 AI 成本；未做删除/导出承诺 |
| **G3 收费** | 订阅或按量付费；有真实价格、支付、退款、发票 | 支付账户 + 订阅/额度体系 | 有 | **P0 + P1 + P2 全部完成**；支付/税务/退款/订阅/发票/对账上线；收费条款与定价页一致；付费 QA 通过 | 未对账就收款；用“内测免费”文案收钱；把支付失败当成功 |

### 1.1 硬规则

1. **不得跳级**：G1 未过不得开 G2；G2 未过不得开 G3。G3 的 P2 不能拿来替换 G1 的 P0。
2. **一个 gate 一个结论**：G1 通过不代表 G2 通过；G2 通过不代表可以收费。
3. **P0 一票否决**：P0 表里任何一项未勾选，目标 gate 直接 No-Go；不允许“先上线后补”。
4. **P1/P2 不等于可以不写**：如果决定跳过 G2/G3，P1/P2 可以后置；一旦要开对应 gate，它们就是阻塞项。
5. **“代码已有”不等于“生产已验证”**：SSE 心跳、`/healthz`、限流、备份脚本都已在仓库里，但必须在部署机按本文命令验证并留证据。

---

## 2. 优先级、状态与使用规则

> **命名说明**：任务 ID 里的 `P2-01` 表示“阶段 P2 的第 1 项”，**不代表优先级**；优先级一律写成 `P0 阻塞 / P1 应做 / P2 可后置`。例如 `P2-03`（阶段 P2，账号安全）可能是 `P1 应做`。阅读时以“优先级”列为准。

| 标记 | 含义 | 使用方式 |
|---|---|---|
| **P0 阻塞** | 不完成不能开 **G1 邀请制内测**；同时阻塞 G2/G3 | 当前阶段只允许 P0 + 必要的 P1 前置；每日站会逐项过 |
| **P1 应做** | G1 可带风险上线，但不完成不能开 **G2 公开免费注册** | G1 上线后 7 天内完成；未完成则不得开放注册 |
| **P2 可后置** | G1/G2 可上线，但不完成不能开 **G3 收费**，或只影响收费后的运营 | 收费项目启动前完成；不收费可暂缓 |
| **状态 `[ ]`** | 未开始 | 完成后改 `[x]`，并在证据列写日期/输出 |
| **状态 `[~]`** | 进行中（可选） | 只用于协作看板，不改变 gate 判定 |
| **状态 `[!]`** | 阻塞/不适用（可选） | 必须写原因与替代方案，不能静默跳过 |

### 2.1 什么算 P0（本清单口径）

- 没有它，G1 用户会遇到**数据丢失、账号不可用、隐私/法律风险、成本失控、无法回滚**中的任意一项。
- 没有它，发布后 **1 小时内**无法判断“是否正常”（健康检查、告警、日志、备份）。
- 没有它，出现事故时**无法在 30 分钟内回滚或恢复**。
- 纯体验优化、SEO、收费能力、长期运营工具，不算 G1 的 P0。

### 2.2 发布前必须记录的“带风险上线”

G1 允许带以下风险上线，但必须在发布记录里写明并指定复核日期：

- 无邮箱验证、无找回密码、无改密、无删号（G1 用人工客服兜底；G2 前必须补）。
- 无 Sentry 等错误追踪（G1 用日志 + 值班；G2 前补）。
- UI 存量项未清零（G1 只保证核心路径；不得写“已完全合规”）。
- 本地视频的 File System Access 只在 HTTPS/localhost 可用（非安全上下文走普通文件选择，不能持久化句柄）。
- 公版书/YouTube 字幕抓取的版权与 ToS 风险由负责人确认（见 P1-06）。

---

## 3. 当前仓库事实（2026-11-20 快照）

> 只列与上线判断直接相关的事实；行号会漂移，以符号名/文件为准。**不要把这里的“已有”当成“已验证”。**

| # | 事实 | 证据 | 对上线的影响 |
|---|---|---|---|
| 1 | 认证端点只有 `POST /api/auth/signup`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`、`POST /api/auth/claim-guest` | `backend/routes_auth.py` | 没有邮箱验证、找回密码、改密、删号 |
| 2 | 账号端点只有 `PATCH /api/user/profile`（只改 username）与 `GET /api/user/summary` | `backend/routes_account.py` | 不能改邮箱/密码，不能自助删号 |
| 3 | 会话 Cookie `ln_session`：HttpOnly、SameSite=Lax、Path=/、30 天；`Secure` 由 `COOKIE_SECURE` 控制 | `routes_auth.py` 的 `set_session_cookie`；`config.py` | 生产必须 HTTPS + `COOKIE_SECURE=1` |
| 4 | `auth_db.delete_user_sessions()` 已定义，但仓库内没有调用方 | `auth_db.py`；全仓 grep | 改密/封禁/删号后“踢掉所有设备”尚未接线 |
| 5 | 游客态：`ln_guest` + `data/guests/<sha256>/`；游客可访问大多数 `/api/*`，有更紧限速；`GUEST_MAX_TRANSLATED_VIDEOS=1` | `main.py` 身份中间件；`guest.py`；`config.py` | G1 用应用内邀请码挡住站外注册（受限游客仍可用），否则游客可绕过“邀请”；Caddy 网关已移除 |
| 6 | 本地视频：视频文件不上传；浏览器解析出的字幕块会 `POST /api/local-video/process`，由后端调用 LLM 翻译/分析 | `backend/routes_local_video.py` 文件头；`frontend/src/lib/localVideoLibrary.ts` | **已于 2026-11-20（M4）修正**：界面使用 `localVideo.subtitleAiDisclosure`（字幕文本送 AI、视频文件不上传），隐私政策第 4/7 节同步披露；旧 key/旧文案已删除 |
| 7 | 本地视频句柄依赖 `showOpenFilePicker` + 安全上下文；普通 `http://192.168.x.x` 回退 `<input type=file>`，不能持久化句柄 | `frontend/src/lib/localVideoLibrary.ts` 的 `canPersistLocalVideoHandles` / `pickLocalVideoHandle` | 生产必须 HTTPS；非安全上下文要有清晰回退提示 |
| 8 | 课程生成入口已隐藏：`const SHOW_COURSE_GENERATION = false` | `frontend/src/App.tsx` | 发版前回归确认没有别的入口暴露；不要把它当“已删除” |
| 9 | **已修复（M4，2026-11-20）**：隐私政策/使用协议是真实公开页（`#/privacy`、`#/terms`），页脚/账户页/注册页均可跳转；`ComingSoon` 与 `legalPending` 已移除 | `PublicFooter.tsx`；`AccountScreen.tsx`；`PrivacyPolicyScreen.tsx` / `TermsScreen.tsx`；`npm run check:legal` | 页面可达性已验收；仍待法务复核与 P1-03 联系渠道 |
| 10 | 定价页明确“内测免费，定价即将公布”“本页不展示未经确认的价格” | `PricingScreen.tsx`；`zh-CN.json` 的 `public.pricing.*` | 在 G3 前保持真实；不得为了收费提前改价而不接支付 |
| 11 | 管理员：`ADMIN_EMAILS` 环境变量；`/api/admin/*` 提供只读统计 + 调额度/封禁/维护模式/公告；公告字段存在后台，但未找到前台展示入口 | `config.py`；`routes_admin.py`；`AdminConsoleScreen.tsx` | G1 需要管理员止血；公告要能在用户侧看到，不能只存后台 |
| 12 | 健康检查：`GET /health` 只探活；`GET /healthz` 只读检查 DB 可读 + Alembic 版本 + uptime，不检查磁盘 | `backend/main.py`；`observability.py` | 监控需要补磁盘/5xx/LLM 花费告警，不能只看 `/health` |
| 13 | SSE 已有 15s `: ping` 心跳（`SSE_HEARTBEAT_INTERVAL` 可覆盖），但**没有后端单流 45 分钟上限** | `routes_videos.py` 的 `_with_heartbeat`；`config.py` | 代理不会因空闲断流，但长流资源占用需要单独限制 |
| 14 | Alembic 当前 head 为 `0022_generated_courses`；`docs/部署指南.md` 里“期望 0012_exam (head)”是过期示例 | `cd backend && venv/bin/alembic heads` 实测；`docs/部署指南.md` §3.4/§4.4 | 迁移验收必须以 `alembic heads` 为准，不能照抄旧文档 |
| 15 | 限流是进程内固定窗口：登录 10 次/60s/IP + 账号/IP 连续失败锁定；注册/估价/处理/查词等有桶；游客更紧 | `routes_auth.py`；`ratelimit.py`；`auth_lockout.py` | 只能单 worker；反代后必须能拿到真实 IP，否则可能全网共享额度 |
| 16 | CI：后端 `py_compile` + `pytest`；前端 `tsc -b` + `vite build` + `check:i18n`；`design-scan` 是 **report-only**（`|| true`） | `.github/workflows/ci.yml` | CI 绿不等于 UI 合规；2026-11-20 本地只确认收集 1122 项，未跑全量 |
| 17 | UI 治理：A1 审计 90 条；屏级覆盖 21/27（77.8%）；剩余 6 个页面；扫描基线约 846 行；报告明确“这不是门禁通过” | `docs/design-governance/reports/ui-baseline-2026-11-19.md`；`remediation-status.md` | 不能写“UI 已完全合规”；G1 只保证核心路径，G2 前补覆盖 |
| 18 | 公开站：`frontend/index.html` 没有 meta description / OG / canonical；`frontend/public/` 没有 `robots.txt` / `sitemap.xml`；公开路由只有 home/blog/pricing/resources/login | `frontend/index.html`；`frontend/src/lib/nav.ts` 的 `PublicView` | G2 前需要补 meta/OG/robots/sitemap/404；G1 可接受但需在发布说明里注明 |
| 19 | 备份/恢复脚本与运行手册已存在；离机备份（rclone）默认未配置；恢复演练脚本 `restore_drill.sh` 可用 | `scripts/backup.sh`、`restore.sh`、`restore_drill.sh`；`docs/运行手册.md`；`deploy/backup.cron` | G1 前必须实际跑通并配置离机副本，不能只看脚本存在 |
| 20 | 没有支付代码；`credits` 只能管理员手动调账；没有订阅/退款/发票 | `0013_user_profile.py`；`routes_admin.py`；全仓 grep | G3 前必须从零接支付与财务流程 |
| 21 | 部署资产齐全：多阶段 `Dockerfile`、`docker-compose.yml`、`deploy/Caddyfile`、`Caddyfile.proxy`、systemd unit、`serve.py`（SPA fallback）、备份 cron | 仓库根与 `deploy/` | 部署方案不用从零写，但必须在目标机验证 |
| 22 | 内容/版权相关：YouTube 播放使用 `react-youtube`（官方 iframe），字幕通过 `youtube-transcript-api`/yt-dlp 抓取；公版书来自 Gutenberg/Standard Ebooks；本地文件由用户自选 | `frontend/src/components/VideoPlayer.tsx`；`backend/transcripts.py`；`backend/books.py` | YouTube ToS、字幕抓取、嵌入权限、公版书来源需要法务确认（P1-06） |

---

## 4. 阶段化任务清单

> 表格里的 `§8 C-x` 指文末命令附录。`[先核实]` 表示命令/外部事实需要在目标环境确认后再执行，不能直接照抄。

### 4.1 P0 · 决策与冻结

| ID | 优先级 | 阻塞 Gate | 执行动作 | 验收证据 / 命令 | 依赖 | 工时(h) | 状态 |
|---|---|---|---|---|---|---|---|
| **P0-01** | P0 阻塞 | G1 | 在发布决策记录中选定首发 gate（建议先 G1）；明确“G1 不承诺公开注册、不收费”；负责人签字 | 决策记录链接/issue；`§7` Go/No-Go 第 1 条勾选 | — | 2 | [ ] |
| **P0-02** | P0 阻塞 | G1 | 冻结发布提交：清理/归档工作区未跟踪文件（当前有 `scripts/books-all-shots.mjs`），打 tag，记录 commit；禁止在冻结后合入非 P0 | 除已纳入发布提交的文件（含本文档）外，`git status --porcelain` 为空；`git rev-parse HEAD`；`git tag --points-at HEAD`（§8 C-2） | P0-01 | 2 | [ ] |
| **P0-03** | P0 阻塞 | G1 | 未完成入口清单：课程生成保持 `SHOW_COURSE_GENERATION=false`；本地视频若未过 P7-05 则隐藏入口；法务页 `ComingSoon` 在 G1 前替换；定价页保留“内测免费/价格未定” | `grep -n "SHOW_COURSE_GENERATION" frontend/src/App.tsx` 为 `false`；浏览器逐入口点击；`grep -R "即将上线" frontend/src` 无用户可见残留 | P1-01/P1-02 | 3 | [ ] |
| **P0-04** | P0 阻塞 | G1 | 定 RACI：发布负责人、法务/隐私、运维/值班、客服/反馈、模型成本、安全；在发布看板/issue 中为每个任务分配 owner（本文表格保持 8 列，不塞 owner） | 负责人表（姓名/联系方式/备份人）；`§7` 第 1、14 条 | P0-01 | 2 | [ ] |
| **P0-05** | P0 阻塞 | G1 | 内测名单与邀请机制：每人唯一邀请码；离组即撤销；写明可访问的数据边界与导出/删除方式 | 名单表；撤销一个测试码后访问被拒；邀请码不可重复使用 | P0-01 | 2 | [ ] |
| **P0-06** | P0 阻塞 | G1 | 发布用户告知：内测免费；**当前无邮箱验证/找回密码/改密/删号**（在补之前）；数据用途；字幕文本会送 LLM；如何退出/申请删除；联系邮箱 | 公告文本 + 站内可见位置；`§7` 第 14 条；用户确认回执 | P1-01/P1-03/P1-05 | 2 | [ ] |
| **P0-07** | P0 阻塞 | G1 | 变更冻结窗口：T-3 到 T+1 只修 P0；hotfix 需发布负责人批准；明确回滚决策人 | 冻结通知；hotfix 模板；`§7` 第 13 条 | P0-04 | 1 | [ ] |

### 4.2 P1 · 法务 / 隐私 / 内容合规

| ID | 优先级 | 阻塞 Gate | 执行动作 | 验收证据 / 命令 | 依赖 | 工时(h) | 状态 |
|---|---|---|---|---|---|---|---|
| **P1-01** | P0 阻塞 | G1 | 上线**隐私政策**公开页（`#/privacy`）：账号数据（邮箱、密码哈希、用户名）、学习记录、日志/IP、Cookie（`ln_session`/`ln_guest`）、IndexedDB 本地视频元数据与字幕文本、AI 处理（字幕文本送模型）、第三方模型提供商、跨境传输、保留期限、删除/导出方式、联系方式、生效日期 | **2026-11-20 M4 已实现**：`PrivacyPolicyScreen.tsx` + `LegalDocument.tsx`；`npm run check:legal` 11/11（公开直达/刷新/游客/匿名/页脚/账户/注册入口/375/1440/中越）；截图 `/tmp/legal-pages-shots/`。仍待法务复核与 P1-03 联系渠道 | P0-01 | 8 | [ ] |
| **P1-02** | P0 阻塞 | G1 | 上线**使用协议/服务条款**（免费内测版）：服务内容、禁止行为、内容版权、免责、服务变更/终止、争议解决、联系方式 | **2026-11-20 M4 已实现**：`TermsScreen.tsx`，页脚/账户页可达，不写具体法院（以运营者所在地法律规定为准）；`npm run check:legal` 11/11；截图 `/tmp/legal-pages-shots/`。仍待法务/负责人确认 | P1-01 | 6 | [ ] |
| **P1-03** | P0 阻塞 | G1 | 设置**真实可收信的联系邮箱/投诉渠道**（如 `support@`），在页脚、隐私政策、使用协议、账户页出现；配置转发/值班 | `mailto:` 链接点击可用；从外部邮箱发信并收到；自动回复/工单编号；`§7` 第 15 条 | P0-04 | 1 | [ ] |
| **P1-04** | P0 阻塞 | G1 | 数据删除 SOP（人工）：收到请求 → 核验身份 → 删除 `users` 行、`sessions`、`data/users/<id>/`、对应游客目录（如已认领）→ 记录；明确备份保留期与“备份中的副本到期删除” | staging 造测试账号 → 按 SOP 删除 → 登录 401、目录不存在、DB 无行；`§8 C-6`；删除记录归档 | P1-01 | 4 | [ ] |
| **P1-05** | P0 阻塞 | G1 | **字幕送 LLM 披露**：隐私政策写明“视频文件不上传；字幕文本会发送给模型提供商做翻译/分析”；修正本地视频 UI 文案（当前 `localVideo.subtitleLocalOnly` 写“字幕只在本地读取，不会上传”，与后端送 LLM 的事实不一致） | **2026-11-20 已修复**：`localVideo.subtitleAiDisclosure` + `LocalVideoLearning.tsx`；`grep -R "subtitleLocalOnly" frontend/src` 为空；浏览器本地视频页与隐私政策截图（`/tmp/legal-pages-shots/local-video-disclosure-zh-1440.png`、`privacy-zh-1440.png`） | P1-01 | 4 | [x] |
| **P1-06** | P0 阻塞 | G1 | 版权/内容声明：YouTube 仅嵌入官方播放器、不下载/不重传视频画面；如启用无字幕 ASR，会下载音频做本地转写，需一并披露；字幕抓取需评估 YouTube ToS；公版书来源；本地文件由用户自担版权；提供侵权投诉/下架渠道；“仅供个人学习”声明 | 使用协议/隐私政策/页脚中的声明；投诉邮箱可收信；负责人签字确认已知 ToS 风险 | P1-02/P1-03 | 4 | [ ] |
| **P1-07** | P0 阻塞 | G1 | 托管地/ICP/跨境决策：服务器在境外则记录“不适用 ICP”及跨境传输披露；在境内则先完成 ICP 备案与内容合规评估（备案可能需数周，T-7 前必须启动）；确认 YouTube 在目标地区的可达性；列出第三方服务清单（模型/字幕/邮件/备份）及数据流向 | 决策记录（地区/供应商/备案号或“不适用”理由）；部署区域截图；`§9` 复核 | P0-01 | 2 | [ ] |
| **P1-08** | P1 应做 | G2 | 数据导出：提供自助 JSON 导出或后台导出工具，覆盖 history/favorites/subscriptions/placement 等用户可见数据；导出文件不含他人数据 | staging 账号导出 → 文件可解压/可读；字段清单与隐私政策一致；再导入/核对条数 | P1-01/P1-04 | 8 | [ ] |
| **P1-09** | P1 应做 | G2 | Cookie/埋点/未成年人/版本变更：Cookie 分类说明；`learning_events` 假名 HMAC 用途与保留；未成年人声明（不面向未成年人或做年龄限制）；隐私政策版本号与变更通知 | 隐私政策含 Cookie 表与埋点段；`EVENTS_PSEUDONYM_SALT` 已设；版本号/生效日期可见 | P1-01 | 4 | [ ] |

### 4.3 P2 · 账号与安全

| ID | 优先级 | 阻塞 Gate | 执行动作 | 验收证据 / 命令 | 依赖 | 工时(h) | 状态 |
|---|---|---|---|---|---|---|---|
| **P2-01** | P0 阻塞 | G1 | 邀请制入口：应用层邀请码 + 关闭公开注册（已实现：`REGISTRATION_OPEN=false` + `INVITE_SIGNUP_ENABLED=true`）；Caddy 网关 Basic Auth 已于 2026-11-20 移除，不再生成/输入网关凭据 | 无邀请码 `POST /api/auth/signup` 返回 403 `invite_required`；`GET /api/auth/registration` 显示 registrationOpen=false、inviteRequired=true；持有效邀请码可注册；撤销后立即失效；`/healthz` 免认证 200 | P0-05 | 4 | [ ] |
| **P2-02** | P1 应做 | G2 | 邮箱验证：接入邮件服务商（`[先核实]` 选型/额度/送达率），配置 SPF/DKIM/DMARC；发验证 token；未验证限制（不能保存/导出/付费）；重发限流；验证链接一次性/过期 | staging 注册 → 收信 → 验证 → `email_verified=true`；过期/重复 token 失败；退信率可观测 | P1-01/P2-01 | 12 | [ ] |
| **P2-03** | P1 应做 | G2 | 找回密码：邮件一次性 token（短过期、单次使用、限流）；统一响应不泄露邮箱是否存在；成功后吊销旧会话 | 忘记密码 → 收信 → 重置 → 旧密码失败/新密码成功；不存在邮箱响应一致；`§8 C-3` Cookie 检查 | P2-02/P2-04 | 12 | [ ] |
| **P2-04** | P1 应做 | G2 | 改密 + 会话吊销：登录态下用旧密码改新密码；成功后调用 `auth_db.delete_user_sessions()` 清其他会话；保留当前会话或要求重登（明确文案） | 改密后另一浏览器旧 Cookie 请求 `/api/auth/me` 401；当前会话行为符合文案；单测覆盖 | P2-02 | 6 | [ ] |
| **P2-05** | P1 应做 | G2 | 删除账号：二次确认 + 冷却/立即删除（二选一，写清）；删除 `users` 行、`sessions`、`data/users/<id>/`、事件表按策略匿名化/删除；备份保留期披露 | 删除后登录 401；目录不存在；DB 无行；`§8 C-6`；隐私政策链接到该流程 | P1-04/P2-04 | 10 | [ ] |
| **P2-06** | P0 阻塞 | G1 | 登录/注册限流与锁定验证：现有登录 10 次/60s/IP + `auth_lockout` 5 次/15 分钟；确认反代后拿到真实 IP；验证 429 + `Retry-After`；避免全网共享一个 IP 额度 | 连续错密码第 6 次进入锁定/第 11 次 429；响应带 `Retry-After`；两个外网 IP 各自计数；反代访问日志可核对；`§8 C-1` | P2-01 | 2 | [ ] |
| **P2-07** | P0 阻塞 | G1 | Cookie/Session 属性验证：`ln_session` 与 `ln_guest` 的 HttpOnly/Secure/SameSite=Lax/Path=/；30 天；登出清 Cookie；HTTP 下不落 Secure Cookie | `curl -D -` 查看 `Set-Cookie` 四个属性；浏览器 DevTools 确认；`§8 C-3` | P4-01 | 1 | [ ] |
| **P2-08** | P1 应做 | G2 | CSRF/Origin 校验：对 POST/PUT/PATCH/DELETE 校验 `Origin`/`Referer` 同源（无头请求按策略拒绝）；保留 SameSite=Lax；补测试 | 跨站表单/伪造 Origin 请求 403；同源正常；`pytest` 新用例通过 | P2-07/P2-09 | 4 | [ ] |
| **P2-09** | P0 阻塞 | G1 | CORS 白名单：`CORS_ORIGINS=https://<domain>`（需要时加 www）；禁止 `*`；保留 `allow_credentials=True`；验证恶意 Origin 不回显 | `curl -H 'Origin: https://evil.example'` 无 `Access-Control-Allow-Origin: evil`；正式 Origin 正常；`§8 C-3` | P4-01 | 1 | [ ] |
| **P2-10** | P1 应做 | G2 | 安全头/CSP：Caddy 已有 HSTS/nosniff/Referrer-Policy/CSP 基线；先 `Report-Only` 观察一周再强制；验证控制台无违规；`frame-ancestors 'self'` | `curl -I` 头齐全；浏览器控制台无 CSP 违规；Report-Only 报告为空/已解释 | P4-12 | 4 | [ ] |
| **P2-11** | P0 阻塞 | G1 | 管理员权限最小集：`ADMIN_EMAILS` 只填必要邮箱；非管理员访问 `/api/admin/*` 403；不能封自己/最后一个管理员；调额度/封禁/维护模式可用 | 管理员账号可进；普通账号 403；封禁测试账号后其旧会话下一次请求 403；`§8 C-1` | P0-04 | 2 | [ ] |
| **P2-12** | P1 应做 | G2 | 依赖/密钥/暴露面：`[先核实]` `pip-audit`/`npm audit`；grep 密钥；`.env`/EnvironmentFile 权限 600；评估 `/docs`、`/openapi.json` 是否公开，必要时关闭/限制 | 无高危依赖（或记录例外）；仓库/镜像无密钥；`curl /docs` 返回预期；`§8 C-2/C-8` | P2-11 | 2 | [ ] |
| **P2-13** | P1 应做 | G2 | 错误文案/账号枚举：登录统一 401；注册 409“邮箱已注册”是否接受由隐私/安全负责人定；找回密码统一响应；429 文案可读 | 文案表；接口测试覆盖；无堆栈/内部路径泄露 | P1-01 | 1 | [ ] |

### 4.4 P3 · AI 成本与滥用

| ID | 优先级 | 阻塞 Gate | 执行动作 | 验收证据 / 命令 | 依赖 | 工时(h) | 状态 |
|---|---|---|---|---|---|---|---|
| **P3-01** | P1 应做 | G2 | 模型价格表：`MODEL_CATALOG` 中 DeepSeek / Gemini 3.x / Qwen 多为 `None`；按官方价核实并填入，或把“价格未知”的模型下线/不展示；不要凭印象编数字 | `python -c` 打印目录价格；估价页不再出现“待定”或明确标注；成本负责人签字 | P0-01 | 3 | [ ] |
| **P3-02** | P0 阻塞 | G1 | 日/月预算与功能配额：设置 `AI_DAILY_BUDGET_USER_USD`、`AI_DAILY_BUDGET_GLOBAL_USD`、各功能 `AI_DAILY_QUOTA_*`；当前无“月预算”实现，必须二选一：补代码做月上限，或在支付/账单侧设硬闸；G1 至少日预算生效 | staging 用户超日预算 → 429；全站超全局预算 → 429；`/api/admin/usage` 有数据；配置截图 | P1-07 | 4 | [ ] |
| **P3-03** | P0 阻塞 | G1 | 游客/未登录上限：`GUEST_MAX_TRANSLATED_VIDEOS=1`、游客分钟限速；重点验证“清 Cookie 换新游客”可绕过累计上限（`0` 表示不限、不是关闭）；网关已移除，站外游客只能靠应用层限速/配额约束（必要时加 IP/设备维度） | 记录清 Cookie 绕过结果；游客目录大小可控；无邀请码注册被拒（403 `invite_required`）；策略写入隐私/公告 | P2-01 | 2 | [ ] |
| **P3-04** | P1 应做 | G2 | 429/额度文案：前端统一处理 `QuotaExceeded`/429，显示“今日额度/预算用完，明天恢复”或 `Retry-After`；不能显示“服务器错误” | 手工触发 429：页面文案正确、按钮可恢复；`grep` 前端错误映射；截图 | P3-02 | 3 | [ ] |
| **P3-05** | P0 阻塞 | G1 | 成本告警/每日对账：接 `ai_usage` + `/api/admin/usage`；设日花费阈值、429 激增、5xx 告警到人；上线首周每天对一次厂商账单 | 告警测试消息收到；账单与账本差异表；`§7` 第 12 条 | P6-01 | 3 | [ ] |
| **P3-06** | P1 应做 | G2 | 单流/并发/滥用：当前后端**没有** 45 分钟单流上限；设置 `LLM_MAX_CONCURRENCY`、单用户并发 1、单流上限；验证封禁/额度调整/维护模式 | 两个账号并发流互不拖垮；超过单流上限收到可读错误且已译批次保留；封禁后旧会话 403 | P3-02/P2-11 | 6 | [ ] |
| **P3-07** | P2 可后置 | G3 | 估算/对账准确性：估价 token 与实际用量、月度花费与厂商发票对账；误差阈值与解释；收费前必须能解释每一笔模型成本 | 30 天对账表（账本/发票/误差）；超阈值有处理记录 | P3-01/P3-05 | 4 | [ ] |

### 4.5 P4 · 生产部署

| ID | 优先级 | 阻塞 Gate | 执行动作 | 验收证据 / 命令 | 依赖 | 工时(h) | 状态 |
|---|---|---|---|---|---|---|---|
| **P4-01** | P0 阻塞 | G1 | 域名/DNS/HTTPS/HSTS：A/AAAA 指向服务器；80/443 放行；Caddy 自动签发证书；HSTS 头；证书到期告警 | `dig +short <domain>`；`curl -sI https://<domain>` 含 HSTS；证书有效期 >30 天；`§8 C-3` | P1-07 | 2 | [ ] |
| **P4-02** | P0 阻塞 | G1 | 托管方式决策：海外 VPS + Caddy（长期）或 Docker + 托管平台（首周）；记录选择、区域、成本；确认单 worker/单副本（`--workers 1`、Compose 1 副本、不 scale）；境内机房因 YouTube 不可达/备案问题不作为默认 | 决策记录；服务器/平台截图；`ps`/`docker compose ps` 只有 1 个 worker/副本；`§8 C-8` 可执行路径 | P0-01 | 1 | [ ] |
| **P4-03** | P0 阻塞 | G1 | 同域静态 + `/api` 反代 + SPA fallback：`/` 服务 `frontend/dist`，`/api` 反代 uvicorn；`try_files`；`flush_interval -1`；`read_timeout 24h` | 首页/深链 `/discover` 200；`/api/models` 200；`curl -I` 见缓存/安全头；SSE 头由 `§8 C-4` 验证 | P4-02 | 2 | [ ] |
| **P4-04** | P0 阻塞 | G1 | 前端构建：`VITE_API_BASE=https://<domain>`（不带尾斜杠）；`npm ci && npm run build`；检查 bundle 含正式域名、无 `VITE_API_KEY`；`sw.js`/`index.html` no-cache | `grep -R` 正式域名（§8 C-2）；`grep -R "VITE_API_KEY" frontend/dist` 与 `grep -R "X-API-Key" frontend/dist` 均为空；浏览器 Network 指向正式域 | P4-01/P4-02 | 2 | [ ] |
| **P4-05** | P0 阻塞 | G1 | 生产环境变量：`CORS_ORIGINS`、`COOKIE_SECURE=1`、`ADMIN_EMAILS`、`EVENTS_PSEUDONYM_SALT`、模型 Key；**不设** `API_AUTH_KEY` / `VITE_API_KEY`；env 文件 600 | 四项分别 `grep '^CORS_ORIGINS='` 等确认有值（Docker 用 `.env`，裸机用 `/etc/linguatrek/env`）；禁用项为空；`ls -l` 600；§8 C-8 | P4-04 | 2 | [ ] |
| **P4-06** | P0 阻塞 | G1 | Alembic 迁移：先备份 → `alembic upgrade head` → `alembic current` 与 `alembic heads` 一致；`/healthz` 的 `db.migrations.current=head`；不要照抄部署指南里的旧 `0012_exam` 示例 | `§8 C-6`；`/healthz` 输出 current=head；迁移前备份文件存在 | P5-02 | 2 | [ ] |
| **P4-07** | P0 阻塞 | G1 | 健康检查：`/health` 存活、`/healthz` 就绪；Docker HEALTHCHECK 或 systemd `Restart=always`；503 视为未就绪；补磁盘水位检查（应用或外部脚本） | `curl /health` 200；`curl /healthz` 200 且 `db.ok=true`；停 DB/改坏路径 → 503；`§8 C-3/C-6` | P4-06 | 1 | [ ] |
| **P4-08** | P0 阻塞 | G1 | SSE 心跳/代理超时：确认 `SSE_HEARTBEAT_INTERVAL=15`；Caddy `flush_interval -1`；Cloudflare 先灰云或确认心跳；实测 30 分钟流不断；记录代理超时配置 | `grep -c '^: ping' /tmp/sse.log` > 0；30 分钟无 524/断流；`§8 C-4`；Caddyfile 截图 | P4-03 | 4 | [ ] |
| **P4-09** | P1 应做 | G2 | 真实 IP/代理头：`--proxy-headers` + `--forwarded-allow-ips` 与拓扑一致；验证登录限流按真实 IP，不是所有人共享一个代理 IP | 两个外网 IP 各自触发限流互不影响；反代访问日志可核对；`§8 C-1` | P4-03 | 2 | [ ] |
| **P4-10** | P0 阻塞 | G1 | 发布/回滚路径：Docker 用镜像 tag，裸机用 release symlink；保留上一版；演练一次“切到上一版再切回” | 旧 tag/旧 release 可启动；`/healthz` 正常；回滚耗时记录；`§8 C-8` | P4-02 | 3 | [ ] |
| **P4-11** | P1 应做 | G2 | PWA/Service Worker 发版：`sw.js` 版本/更新策略；发版后用户能拿到新壳；必要时禁用 PWA 或提示刷新 | 旧缓存下刷新后新版本生效；`sw.js` no-cache；浏览器 DevTools 验证 | P4-04 | 3 | [ ] |
| **P4-12** | P1 应做 | G2 | 静态缓存/安全头验证：`/assets/*` 1 年 immutable；`index.html`/`sw.js` no-cache；HSTS/CSP/nosniff/Referrer-Policy 齐全 | `curl -I` 逐项检查；发版后强刷更新；`§8 C-3` | P4-03 | 1 | [ ] |
| **P4-13** | P2 可后置 | G3 | `/docs`、`/openapi.json` 暴露面：生产关闭或仅内网；确认不泄露内部端点 | `curl /docs` 预期（404/401/内网）；`§8 C-3` | P4-03 | 1 | [ ] |

### 4.6 P5 · 数据与备份

| ID | 优先级 | 阻塞 Gate | 执行动作 | 验收证据 / 命令 | 依赖 | 工时(h) | 状态 |
|---|---|---|---|---|---|---|---|
| **P5-01** | P0 阻塞 | G1 | 数据目录/权限/持久化：`/data`（Docker）或 `/srv/ln/data`（裸机）；`users/`、`guests/` 700；`app.db` 600；卷/磁盘挂载正确；重启不丢 | 重启后 `app.db`、`users/` 仍在；`df -h` 已挂载；`ls -ld` 权限正确；`§8 C-6` | P4-02 | 2 | [ ] |
| **P5-02** | P0 阻塞 | G1 | 备份：迁移前先备份；每日 `scripts/backup.sh --keep 7`；配置 rclone 离机副本（R2/B2/S3）；校验 `SHA256SUMS`/`manifest.env` | 备份文件非 0；`rclone lsf` 可见当天文件；`backup.log` 无警告；`§8 C-5` | P5-01 | 3 | [ ] |
| **P5-03** | P0 阻塞 | G1 | 恢复演练：`scripts/restore_drill.sh` 输出 PASS；再对 staging 做一次真实恢复；旧账号能登录、历史还在；记录耗时 | `restore_drill.sh` 末行 PASS；恢复后 `§8 C-3/C-6`；演练记录归档 | P5-02 | 3 | [ ] |
| **P5-04** | P1 应做 | G2 | 磁盘清理/保留策略：90 天未访问清理、游客目录清理、旧 release/旧备份清理；磁盘 >85% 拒绝新处理或告警；先 dry-run | dry-run 清单；阈值测试；`§8 C-5/C-6`；无用户数据误删 | P5-01 | 4 | [ ] |
| **P5-05** | P1 应做 | G2 | 备份缺失告警 + 删除与备份披露：备份 >24h 缺失/大小为 0 告警；隐私政策写明备份保留期与“删除后备份副本到期消失” | 告警测试；政策段落；`§8 C-5` | P5-02/P1-01 | 2 | [ ] |
| **P5-06** | P1 应做 | G2 | 迁移兼容/回滚：只做加表/加列；旧代码能否读新库；回滚代码不逆向 SQL；在 staging 演练“迁移 + 回滚代码/恢复备份” | 旧 release 启动成功；恢复备份后 `/healthz` 正常；记录回滚窗口 | P4-06 | 3 | [ ] |

### 4.7 P6 · 监控与运维

| ID | 优先级 | 阻塞 Gate | 执行动作 | 验收证据 / 命令 | 依赖 | 工时(h) | 状态 |
|---|---|---|---|---|---|---|---|
| **P6-01** | P0 阻塞 | G1 | uptime + 5xx/LLM/磁盘告警：外部每 5 分钟探 `/healthz`；5xx 率、429 激增、LLM 日花费、磁盘水位告警到人（邮件/Telegram/IM）；测试一次告警 | 手动制造 503/5xx 收到告警；告警群/收件人确认；`§8 C-3`；截图 | P4-07 | 4 | [ ] |
| **P6-02** | P1 应做 | G2 | 日志/错误追踪：结构化 JSON 日志（已有），确认不记 Cookie/密码/Key；轮转/保留；接 Sentry/GlitchTip（`send_default_pii=False`、带 release） | 日志中 `grep -i cookie` 为空；手工异常在错误平台可见；保留天数确认 | P6-01 | 4 | [ ] |
| **P6-03** | P0 阻塞 | G1 | 值班/联系/回滚授权：G1 期间指定 on-call；发布负责人有回滚决策权；联系人表（电话/IM）；30 分钟内可响应 | 联系人表；演练一次“报警 → 决策 → 回滚”；`§7` 第 13/14 条 | P0-04 | 2 | [ ] |
| **P6-04** | P1 应做 | G2 | 容量/压测/安全更新：2 个账号并发 30 分钟流；单 worker 下内存/CPU/磁盘可接受；OS/依赖/证书月度更新流程 | 压测记录；资源曲线；更新日历；无 `database is locked` | P4-08 | 4 | [ ] |
| **P6-05** | P1 应做 | G2 | 状态页/公告渠道：维护模式（`app_settings.maintenance_mode`）可开；用户侧公告/状态页；故障时统一入口 | 维护模式开启后非管理员 `/api/*` 503；公告可见；关闭恢复 | P2-11/P8-05 | 3 | [ ] |

### 4.8 P7 · QA 矩阵

| ID | 优先级 | 阻塞 Gate | 执行动作 | 验收证据 / 命令 | 依赖 | 工时(h) | 状态 |
|---|---|---|---|---|---|---|---|
| **P7-01** | P0 阻塞 | G1 | 浏览器 × 视口矩阵：G1 至少 Chrome + Safari 最新、375/1440；G2 补 Firefox/Edge + 768。覆盖首页、登录、定价、应用 shell、Today、内容页、本地视频；记录通过/失败/截图 | QA 矩阵表逐格填 `Pass/Fail` + 截图链接；G1 无 P0 阻断；`§8 C-9` | P4-03 | 6 | [ ] |
| **P7-02** | P1 应做 | G2 | 账号全流程：注册（邀请/邮箱验证）→ 登录 → 刷新保持 → 登出 → 找回 → 改密 → 删号 → 会话吊销；错误密码/锁定/429 | 每条流程有录屏或截图；接口断言；`§8 C-1/C-3` | P2-02/P2-03/P2-04/P2-05 | 8 | [ ] |
| **P7-03** | P1 应做 | G2 | 游客迁移：游客看视频/收藏/订阅/定位测 → 注册/登录 → `claim-guest` 合并；重复认领幂等；用户数据优先；游客目录清理 | 合并前后条数一致；重复调用返回 `claimed:false`；跨用户不串数据 | P2-05 | 4 | [ ] |
| **P7-04** | P0 阻塞 | G1 | 长视频 SSE：选 60–90 分钟视频跑 30 分钟流；观察 `meta → batch → done`；心跳；断流后重开续译；429 退避；代理不断 | `grep -c '^: ping'`；断流后重跑命中缓存；`§8 C-4`；30 分钟无 524 | P4-08 | 4 | [ ] |
| **P7-05** | P0 阻塞 | G1 | 本地视频：无字幕/后补加载字幕、替换字幕、File System Access（HTTPS/localhost）、非安全上下文回退、文件丢失/权限拒绝、导入失败、空/加载/错误态；视频不离开浏览器 | 逐场景截图/录屏；`grep` 文案；非安全上下文提示可见；`§8 C-9` | P1-05 | 4 | [ ] |
| **P7-06** | P1 应做 | G2 | 429/额度/错误/空/加载：额度用尽、429、离线、5xx、空历史、加载中、维护模式；按钮可恢复；不白屏 | 每个状态有截图/断言；`§8 C-1`；无 unhandled error | P3-04/P6-05 | 4 | [ ] |
| **P7-07** | P1 应做 | G2 | 键盘/焦点/对比度：Tab 顺序、focus visible、对话框焦点陷阱/返回、对比度；注意 UI 基线 21/27、6 个页面未覆盖，**不得写“已完全合规”** | 键盘走查记录；对比度数值；已知问题清单 + 修复/豁免决定 | P4-03 | 6 | [ ] |
| **P7-08** | P0 阻塞 | G1 | 越权/隔离：账号 A 的文件名用账号 B 的 Cookie 读 → 404；游客目录隔离；非管理员 `/api/admin/*` 403；封禁后旧会话 403 | 10 条越权用例全过；`§8 C-1`；证据归档 | P2-11 | 3 | [ ] |
| **P7-09** | P1 应做 | G2 | 回归/移动端/PWA：`pytest`、`tsc -b`、`vite build`、`check:i18n`、`check:nav`、`check:public`、`check:blog`；iOS Safari/Android Chrome 安装/离线/刷新 | 命令全部通过（以实际输出为准）；移动端截图；`§8 C-1/C-9` | P7-01 | 4 | [ ] |

**P7 QA 矩阵（最小口径）**

| 维度 | G1 最小 | G2 全量 |
|---|---|---|
| 浏览器 | Chrome、Safari 最新 | + Firefox、Edge |
| 视口 | 375、1440 | + 768 |
| 账号 | 邀请码注册、登录登出、刷新保持 | + 邮箱验证、找回、改密、删号、会话吊销 |
| 数据 | 游客 → 注册迁移 | + 导出/删除、跨设备 |
| 播放 | 30 分钟 SSE、心跳、断流续译 | + 弱网、429 退避、代理切换 |
| 本地视频 | 加载/替换字幕、句柄、非安全上下文回退 | + 导入失败、权限拒绝、文件丢失 |
| 异常 | 429/额度、空/加载/错误态 | + 5xx、离线、维护模式 |
| 可访问性 | 核心键盘路径 | 全量焦点/对比度/读屏关键路径 |

### 4.9 P8 · 公开站与支持

| ID | 优先级 | 阻塞 Gate | 执行动作 | 验收证据 / 命令 | 依赖 | 工时(h) | 状态 |
|---|---|---|---|---|---|---|---|
| **P8-01** | P1 应做 | G2 | 首页 meta/OG/canonical：`index.html` 补 `description`、`og:title/description/image/url`、`twitter:card`、canonical；中/英/越文案与实际页面一致 | `curl -s https://<domain>/` 查看 head；社交预览调试器；截图 | P8-06 | 3 | [ ] |
| **P8-02** | P1 应做 | G2 | sitemap/robots/404：`robots.txt`、`sitemap.xml`；未知路径有 404（当前 hash 路由未知会回落首页，需确认是否接受）；不要屏蔽 `/assets`/API | `curl /robots.txt`、`/sitemap.xml` 200；未知路径 404 页面；`§8 C-3` | P4-03 | 4 | [ ] |
| **P8-03** | P1 应做 | G2 | 博客/RSS：`/api/blog/feed.xml` 已有；验证绝对链接、标题/日期、订阅入口；公开页脚/导航链接可达 | `curl /api/blog/feed.xml` 为 RSS；订阅器可读；链接正确；`§8 C-3` | P8-01 | 2 | [ ] |
| **P8-04** | P0 阻塞 | G1 | 定价页真实性：G1/G2 保持“内测免费/定价即将公布”；不展示未经确认的价格；没有支付入口；如写“不会自动扣款”必须有依据 | 浏览器 `#/pricing` 文案；`grep` 无虚构价格/支付按钮；负责人确认 | P0-01 | 1 | [ ] |
| **P8-05** | P0 阻塞 | G1 | 联系/反馈/公告：页脚/账户页有联系邮箱；用户可见公告（维护、无找回、额度变化）；后台 `announcement` 目前只在管理台，需要前台展示 | 公告在用户侧可见；反馈入口可用；邮件可收；`§7` 第 15 条 | P1-03/P2-11 | 3 | [ ] |
| **P8-06** | P0 阻塞 | G1 | 法务链接替换：`PublicFooter` 的 `ComingSoon` 改成 `#/privacy`、`#/terms`；`AccountScreen` 的 `legalPending` 改成真实链接；全站无“即将上线”法务文案 | **2026-11-20 已完成**：页脚/账户页/注册页均为真实链接；`grep -R "ComingSoon" frontend/src` 与 `grep -R "legalPending" frontend/src` 均无用户可见残留；`npm run check:legal` 11/11；截图 `/tmp/legal-pages-shots/` | P1-01/P1-02 | 2 | [x] |

### 4.10 P9 · 发布日

| ID | 优先级 | 阻塞 Gate | 执行动作 | 验收证据 / 命令 | 依赖 | 工时(h) | 状态 |
|---|---|---|---|---|---|---|---|
| **P9-01** | P0 阻塞 | G1 | T-7 预演：staging 按生产步骤部署一遍（构建/迁移/健康检查/SSE/备份/回滚），记录耗时与坑；冻结变更 | 预演记录；所有 P0 缺口清单；`§8 C-8`；`§7` 第 2/3 条 | P0-02 | 8 | [ ] |
| **P9-02** | P0 阻塞 | G1 | T-1 终检：权限 600、禁止变量为空、备份完成、证书有效、Go/No-Go 一页纸逐条签字；T0 发布窗口与回滚人确认 | `§7` 15 条全勾选；终检截图；值班表 | P9-01 | 6 | [ ] |
| **P9-03** | P0 阻塞 | G1 | T0 发布：先备份 → 迁移 → 构建/切换 → `/healthz` → 首页/API → 注册/登录 → 短视频 SSE；记录当前 tag/release；失败即回滚 | 发布记录（时间线/命令/输出）；`§8 C-3/C-4/C-6`；回滚命令已备 | P9-02 | 6 | [ ] |
| **P9-04** | P0 阻塞 | G1 | 上线后 1h/24h/7d：1h 看 5xx/SSE/登录；24h 看错误/成本/备份/磁盘；7d 看留存/反馈/账单；异常升级 | 三个时间点检查表；告警/账单/磁盘截图；问题清单 | P9-03 | 4 | [ ] |
| **P9-05** | P0 阻塞 | G1 | 公告/邀请/支持：发邀请（按名单）、置顶内测公告、客服邮箱值班、故障联系人；说明“无找回/改密/删号”与替代流程 | 邀请发送记录；公告截图；客服首响测试；`§7` 第 15 条 | P0-05/P0-06 | 2 | [ ] |

### 4.11 P10 · 回滚 / 事故

| ID | 优先级 | 阻塞 Gate | 执行动作 | 验收证据 / 命令 | 依赖 | 工时(h) | 状态 |
|---|---|---|---|---|---|---|---|
| **P10-01** | P0 阻塞 | G1 | 触发条件/决策人：明确什么情况回滚（`/healthz` 持续 503、5xx 超阈值、数据损坏、登录全挂、SSE 全断、密钥泄露、支付事故）；谁有权决定；先止损再定位 | 一页纸触发条件；决策人/备份人；演练一次判定 | P6-03 | 2 | [ ] |
| **P10-02** | P0 阻塞 | G1 | 回滚步骤：代码/镜像切回上一版（Docker tag / release symlink）；数据库迁移不逆向，必要时恢复备份；回滚后验证 `/healthz`、首页、登录 | 回滚演练记录（耗时/命令/输出）；`§8 C-8`；旧版可启动 | P4-10 | 3 | [ ] |
| **P10-03** | P0 阻塞 | G1 | 数据恢复：停服 → 用最近备份 `restore.sh --force` → `PRAGMA integrity_check` → 启动 → 旧账号登录/历史核对；如数据丢失，如实告知范围，不假装恢复成功 | 恢复演练记录；`§8 C-5/C-6`；用户通知模板 | P5-03 | 3 | [ ] |
| **P10-04** | P0 阻塞 | G1 | 沟通模板：状态（ investigating/identified/monitoring/resolved）、影响范围、数据影响、ETA、下次更新时间、临时绕行；中英/中越按用户群准备 | 模板文档；模拟一次发布；`§7` 第 14 条 | P6-03 | 1 | [ ] |
| **P10-05** | P0 阻塞 | G1 | 紧急开关/密钥泄露/复盘：维护模式、关闭注册/邀请、封禁账号、轮换模型 Key、吊销全部会话；事故后 48h 复盘（RCA + 行动项 + owner） | 每个开关演练一次；轮换流程；复盘模板；`§8 C-8` | P2-11/P4-05 | 2 | [ ] |

### 4.12 P11 · 收费 Gate（P2 可后置，但 G3 前全部阻塞）

> **未完成本节任何一项，不得收费。** 收费不是“加一个支付按钮”，而是支付、税务、退款、订阅、发票、对账、客服六件事同时成立。

| ID | 优先级 | 阻塞 Gate | 执行动作 | 验收证据 / 命令 | 依赖 | 工时(h) | 状态 |
|---|---|---|---|---|---|---|---|
| **P11-01** | P2 可后置 | G3 | 支付服务商选型与 KYC：按目标用户/地区选（`[先核实]` Stripe/支付宝/微信/其他）；完成商户认证、结算账户、测试环境 | 商户后台截图；测试支付成功；结算周期/费率确认 | P0-01 | 8 | [ ] |
| **P11-02** | P2 可后置 | G3 | 定价/套餐/免费额度：免费层与付费层功能差异、货币、含税/不含税、试用；与 `AI_DAILY_QUOTA_*`/预算一致，不承诺无法兑现的“无限” | 定价表；额度映射表；成本测算（毛利）；负责人签字 | P3-01 | 4 | [ ] |
| **P11-03** | P2 可后置 | G3 | 税务/发票/退款政策：增值税/发票类型、跨境税务、退款条件与时限、拒付处理；必要时咨询专业税务/法务（`[先核实]`） | 税务/退款条款；发票样例；客服话术 | P11-01/P1-02 | 8 | [ ] |
| **P11-04** | P2 可后置 | G3 | 订阅生命周期/支付 webhook：创建、续费、取消、失败重试、宽限期、降级；webhook 签名校验、幂等、重放保护；支付成功才开通 | 测试卡覆盖成功/失败/退款/取消/续费；webhook 重放不重复开通；对账日志 | P11-01/P11-02 | 16 | [ ] |
| **P11-05** | P2 可后置 | G3 | 权益/额度/财务对账：订阅状态 ↔ 权益；支付成功开通、退款回收；收入/支付平台/`ai_usage` 三方对账；异常账单告警 | 三方对账表；退款后权益回收；差异处理记录 | P11-04/P3-05 | 8 | [ ] |
| **P11-06** | P2 可后置 | G3 | 收费条款/定价页：自动续费披露、价格变更、取消方式、退款入口；`PricingScreen` 从“内测免费”切换为真实价格；不得保留“定价即将公布”收钱 | 条款/定价页截图；订阅确认页；法务确认 | P11-02/P11-03 | 4 | [ ] |
| **P11-07** | P2 可后置 | G3 | 客服/拒付/付费 QA：退款工单、chargeback、发票申请、付费用户专线；付费流程全量回归（含移动端） | 工单 SLA；拒付演练；付费 QA 记录 | P11-03/P11-04 | 6 | [ ] |

---

## 5. 三个 Gate 的最小通过集

> **优先级与 gate 一一对应**：`P0 阻塞` → G1，`P1 应做` → G2，`P2 可后置` → G3（这里说的是优先级，不是章节编号）。当前分布：**P0 53 项 / P1 30 项 / P2 9 项，共 92 项**。每项都要有证据，不能只勾选。

| 优先级 | 数量 | 任务 ID（按阶段表） |
|---|---|---|
| **P0 阻塞** | 53 | `P0-01…07`、`P1-01…07`、`P2-01/06/07/09/11`、`P3-02/03/05`、`P4-01…08/10`、`P5-01…03`、`P6-01/03`、`P7-01/04/05/08`、`P8-04…06`、`P9-01…05`、`P10-01…05` |
| **P1 应做** | 30 | `P1-08/09`、`P2-02…05/08/10/12/13`、`P3-01/04/06`、`P4-09/11/12`、`P5-04…06`、`P6-02/04/05`、`P7-02/03/06/07/09`、`P8-01…03` |
| **P2 可后置** | 9 | `P3-07`、`P4-13`、`P11-01…07` |

| Gate | 必须全绿 | 关键硬闸门（逐项验收） | 不允许带入下一阶段 |
|---|---|---|---|
| **G1 邀请制内测** | **P0 优先级 53 项全部完成** | 隐私/协议/联系渠道真实可达；邀请闸门可挡站外；字幕送 LLM 已披露；备份+恢复演练通过；SSE 30 分钟通过；越权隔离通过；管理员止血可用；回滚步骤已演练；无找回/改密/删号已公告 | 公开注册；收费；未验收的本地视频/课程入口；未完成的法务页 |
| **G2 公开免费注册** | **P0 53 + P1 30 = 83 项全部完成** | 邮箱验证或持续邀请码；找回密码/改密/删号/会话吊销；CSRF/Origin；注册开关与限流；监控告警接人；完整 QA 矩阵；公开站 meta/robots/404；数据导出/删除流程 | 收费；未对账的 AI 成本；未披露的删除/导出限制 |
| **G3 收费** | **P0 53 + P1 30 + P2 9 = 92 项全部完成** | 支付/税务/退款/订阅/发票/对账；收费条款与真实定价页；付费 QA；客服/拒付流程；支付成功才开通 | 未对账就收款；用“内测免费”文案收钱；把支付失败当成功 |

**最小集摘要（可直接贴到发布群）**

- **G1**：P0 全绿 + 法务三件套（隐私/协议/联系）+ 邀请闸门 + 备份恢复 + SSE 30 分钟 + 越权隔离 + 回滚演练。
- **G2**：G1 + 邮箱验证/邀请码 + 找回/改密/删号 + CSRF + 监控告警 + 完整 QA + 公开站 meta/robots/404。
- **G3**：G2 + 支付/税务/退款/订阅/发票/对账 + 收费条款与真实定价页。
- **绝不混用**：G1 的“免费内测”不包含任何收费任务；P11 任何一项未完成都不能说“可以收费”。

## 6. T-7 到 T+7 的执行日历

> 以 T0 为发布日；每天上午/下午两段，按依赖排。实际日期在发布计划里填。每段结束必须留下证据（命令输出/截图/签字），否则下一天不顺延。

| 日期 | 上午 | 下午 | 出口标准 / 证据 | Owner |
|---|---|---|---|---|
| **T-7** | 确认首发 gate、发布负责人、冻结范围（P0-01/02/04） | staging 按生产步骤预演：构建→迁移→健康检查→首页/API（P9-01） | 预演记录；P0 缺口清单；冻结通知 | 发布负责人 |
| **T-6** | 隐私政策/使用协议初稿评审（P1-01/02） | 联系邮箱、投诉渠道、无找回/改密/删号告知（P1-03/P0-06） | 法务页 URL 草案；邮箱可收信 | 法务/产品 |
| **T-5** | 邀请闸门/注册开关/限流验证（P2-01/P2-06） | Cookie/CORS/管理员权限验证（P2-07/P2-09/P2-11） | 无邀请被拒（401/403）；恶意 Origin 不回显；管理员 403 测试 | 后端 |
| **T-4** | 备份 + 离机副本 + 恢复演练（P5-02/P5-03） | 磁盘/权限/重启持久化（P5-01）；迁移 head 核对（P4-06） | `restore_drill.sh` PASS；`alembic current`=head | 运维 |
| **T-3** | SSE 30 分钟实测（P4-08/P7-04） | 浏览器矩阵 G1（P7-01）+ 本地视频 QA（P7-05） | 无断流；矩阵无 P0 失败 | 前端/QA |
| **T-2** | 越权隔离 10 条（P7-08）+ 预算/额度验证（P3-02） | 全量回归：pytest/tsc/build/i18n/nav/public（P7-09） | 命令输出归档；P0 bug 清零 | QA/后端 |
| **T-1** | Go/No-Go 一页纸逐条签字（§7）；终检环境变量/证书/备份（P9-02） | 备份一次；确认回滚包/镜像；值班表；公告定稿（P9-05） | 15 条全勾；回滚命令可执行 | 发布负责人 |
| **T0** | 备份 → 迁移 → 构建/切换 → `/healthz` → 首页/API | 注册/登录 → 短视频 SSE → 邀请发送/公告；记录 tag（P9-03/P9-05） | 发布记录；`§8 C-3/C-4`；回滚命令在手 | 发布/运维 |
| **T+1** | 1h/24h 指标：5xx、SSE、登录、成本（P9-04） | 处理 P0/P1 反馈；检查备份/磁盘/告警 | 24h 检查表；无未处理 P0 | 值班 |
| **T+2** | 用户反馈归类；法务/隐私问题优先 | 修复 G1 阻塞缺陷；更新已知问题 | 问题清单 + 修复记录 | 产品/工程 |
| **T+3** | 成本对账（P3-05）；429/额度观察 | 安全头/CSP Report-Only 检查（P2-10） | 账单/告警截图；CSP 报告 | 运维/成本 |
| **T+4** | 备份/恢复再检查；磁盘水位（P5-04） | 客服/公告/状态页演练（P6-05/P8-05） | 检查表；演练记录 | 运维/客服 |
| **T+5** | G1 期缺陷收尾；准备 G2 差距清单 | P1 任务启动（邮箱验证/找回/删号） | G2 差距表；owner/日期 | 产品 |
| **T+6** | 周报：稳定性/成本/反馈；确认是否继续 G1 | 发布 G2 准备计划（不提前开注册） | 周报；G2 计划 | 发布负责人 |
| **T+7** | G1 退出评审：P0 是否全绿、是否满足 G2 前置 | 决定“继续 G1 / 进入 G2 / 暂停”；记录决策 | 评审记录；`§7` 复签 | 决策人 |

---

## 7. Go/No-Go 一页纸（15 条，全部可勾选）

> 目标 gate 发布前逐条勾；**任何一条不勾 = No-Go**。不要用“已知问题”替代勾选，除非在发布记录里明确接受并指定复核日期。

- [ ] **1. Gate 决策已签字**：首发是 G1/G2/G3 明确；发布负责人、回滚决策人、值班人已指定（P0-01/P0-04）。
- [ ] **2. 版本已冻结**：发布 commit/tag 固定；`git status --porcelain` 无未处理文件；构建可复现（P0-02）。
- [ ] **3. 目标 gate 的阻塞项全绿**：G1 的 P0、G2 的 P0+P1、G3 的 P0+P1+P2 均无未勾选项；没有“先上线后补”（§5）。
- [ ] **4. 法务三件套可见**：隐私政策、使用协议、联系邮箱真实可达；页脚/账户页无“即将上线”（P1-01/02/03、P8-06）。
- [ ] **5. 邀请/注册闸门有效**：G1 无邀请进不来；G2 注册开关可用；绕过前端直接调 `/api/auth/signup` 也被拒（P2-01）。
- [ ] **6. 账号生命周期可用**：G2 起找回密码、改密、删号、会话吊销均通过（P2-02…P2-05）。
- [ ] **7. 字幕送 LLM 已披露**：隐私政策写明字幕文本会发送给模型；本地视频 UI 文案不再说“只在本地读取，不会上传”（P1-05）。
- [ ] **8. 备份/恢复真实通过**：当日备份存在、离机副本可见、`restore_drill.sh` PASS、真实恢复演练通过（P5-02/P5-03）。
- [ ] **9. 入口与安全配置正确**：HTTPS/HSTS、`/healthz` 200 且 `current=head`、CORS 白名单、Cookie 四属性、无 `API_AUTH_KEY`/`VITE_API_KEY`（P4-01/05/07、P2-07/09）。
- [ ] **10. SSE 长流通过**：30 分钟流不断、心跳存在、断流可续译、代理超时配置正确（P4-08/P7-04）。
- [ ] **11. 隔离与权限通过**：A/B 账号越权 10/10 通过；普通账号访问 `/api/admin/*` 403；封禁旧会话 403（P7-08/P2-11）。
- [ ] **12. 成本与限额可控**：日/全局预算已设；429/额度文案正确；成本告警能到人；首日账单可对（P3-02/P3-04/P3-05）。
- [ ] **13. QA 矩阵通过**：目标 gate 的浏览器×视口矩阵无 P0 阻断；已知 UI 缺陷已记录且不在核心路径（P7-01/P7-07）。
- [ ] **14. 回滚与沟通就绪**：回滚演练通过；值班/联系人/沟通模板可用；30 分钟内可回滚（P6-03/P10-02/P10-04）。
- [ ] **15. 用户告知与支持就绪**：内测公告/无找回/改密/删号说明已发；邀请已按名单发送；客服邮箱有人值守（P0-06/P9-05）。

**No-Go 触发（任一）：** 1–15 任一未勾；`restore_drill.sh` 失败；`/healthz` 不是 200；SSE 30 分钟断流；越权测试有 1 条失败；发现生产密钥进 bundle；支付未对账却已收款；负责人未签字。

---

## 8. 命令与证据附录

> `§8 C-1/C-2/C-7/C-9` 可在本仓库直接执行；`§8 C-3–C-6/C-8` 在部署机/真实域名执行，标 `[先核实]` 的必须先确认环境。
> 所有 `https://<domain>`、`<VIDEO_ID>`、`<邮箱>`、`<密码>` 都是占位符，执行前替换；**不要把真实密码/Key 写进 shell 历史或本文档**。

### C-1 本地提交门禁与测试

```bash
(cd backend && venv/bin/python -m py_compile *.py)
(cd backend && venv/bin/python -m pytest tests -q)
(cd frontend && npx tsc -b)
(cd frontend && npx vite build)
(cd frontend && npm run check:i18n)
(cd frontend && npm run check:nav)
(cd frontend && npm run check:public)
(cd frontend && npm run check:blog)
(cd frontend && npm run check:legal)
```

- 2026-11-20 实测 `pytest --collect-only` 为 **1122** 项；本文**没有**运行全量测试，不能据此说全绿。
- `check:public`/`check:blog`/`check:nav` 是仓库内脚本；若脚本依赖 dev server，按其 README 启动后再跑（`[先核实]` 脚本前置条件）。

### C-2 构建、bundle 与版本冻结

```bash
DOMAIN=ln.example.com          # 改成你的域名
git rev-parse HEAD
git status --porcelain
git tag --points-at HEAD
(cd frontend && VITE_API_BASE="https://$DOMAIN" npm ci)
(cd frontend && VITE_API_BASE="https://$DOMAIN" npm run build)
grep -R "https://$DOMAIN" frontend/dist | head
grep -R -E "VITE_API_KEY|X-API-Key" frontend/dist && echo "BAD: secret in bundle" || echo "OK: no secret"
(cd backend && venv/bin/alembic heads)
```

- `frontend/dist` 里出现 `127.0.0.1:8000` 不一定是错误（`api.ts` 的兜底字符串会被打包保留）；以“正式域名存在 + Network 实际指向正式域”为准（部署指南 §6.4 已有说明）。
- 当前 `alembic heads` 期望 `0022_generated_courses (head)`；若变化，以命令输出为准。

### C-3 生产入口、安全头、CORS、Cookie

```bash
BASE=https://ln.example.com    # 改成你的域名
curl -fsS "$BASE/health" | python3 -m json.tool
curl -fsS "$BASE/healthz" | python3 -m json.tool
curl -fsS -o /dev/null -w 'home=%{http_code}\n' "$BASE/"
curl -fsS -o /dev/null -w 'deep-link=%{http_code}\n' "$BASE/discover"
curl -fsSI "$BASE/" | grep -iE 'strict-transport-security|content-security-policy|x-content-type-options|referrer-policy'
curl -sSI -H 'Origin: https://evil.example' "$BASE/api/models" | grep -i 'access-control-allow-origin' && echo "BAD: CORS too wide" || echo "OK: no evil origin"
```

登录 Cookie 检查（仅测试账号）：

```bash
curl -sS -D - -o /dev/null -c /tmp/ln.cookies \
  -H 'Content-Type: application/json' \
  -d '{"email":"<test-email>","password":"<test-password>"}' \
  "$BASE/api/auth/login" | grep -i '^set-cookie'
```

期望：`ln_session=...; HttpOnly; Secure; SameSite=Lax; Path=/`；HTTP 下不应有 `Secure`。网关已移除：下列 curl 不需要 `-u`。

### C-4 SSE 30 分钟与心跳

```bash
BASE=https://ln.example.com    # 改成你的域名
curl -sS -N --max-time 2400 -b /tmp/ln.cookies \
  -X POST "$BASE/api/process-video-stream" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=<VIDEO_ID>","model":"deepseek-chat"}' \
  | tee /tmp/sse.log

grep -m1 '^event: meta' /tmp/sse.log
grep -c '^: ping' /tmp/sse.log
grep -E '^event: (meta|batch|done|error)' /tmp/sse.log | tail
```

- 需要真实账号 + 可访问的视频；`<VIDEO_ID>` 由执行人选择，`[先核实]` 该视频当前可抓字幕/未被地区限制；网关已移除：curl 不需要 `-u`。
- 期望：10–30 分钟内持续有数据；`: ping` 计数 > 0；Ctrl-C 后重跑同一 URL 能命中缓存继续补译。

### C-5 备份、恢复、离机副本

Docker（部署机）：

```bash
cd /srv/ln/app
sudo mkdir -p /srv/ln/backups && sudo chown 1000:1000 /srv/ln/backups
docker compose run --rm --no-deps \
  -v /srv/ln/backups:/backups \
  -v "$PWD/scripts:/scripts:ro" \
  -e BACKUP_ROOT=/backups -e ENV_FILE=/dev/null \
  --entrypoint /bin/bash app /scripts/backup.sh --keep 7
ls -lh /srv/ln/backups
```

裸机（部署机）：

```bash
sudo -u ln bash -lc 'cd /srv/ln/current && \
  DATA_DIR=/srv/ln/data AUTH_DB_PATH=/srv/ln/data/app.db USER_DATA_DIR=/srv/ln/data/users \
  BACKUP_ROOT=/srv/ln/backups ENV_FILE=/etc/linguatrek/env \
  /srv/ln/current/scripts/backup.sh --keep 7'
sudo -u ln bash -lc 'DATA_DIR=/srv/ln/data AUTH_DB_PATH=/srv/ln/data/app.db \
  USER_DATA_DIR=/srv/ln/data/users /srv/ln/current/scripts/restore_drill.sh'
```

离机副本（先配置 rclone，`[先核实]` remote/bucket 名）：

```bash
rclone lsf r2:linguatrek-backup/daily | tail
```

- `restore_drill.sh` 末行期望 `PASS`；真实恢复见部署指南 §5.2，**必须先停服务**。

### C-6 数据、迁移、DB 检查

```bash
(cd backend && venv/bin/alembic heads)
(cd backend && venv/bin/alembic current)
sqlite3 /data/app.db 'PRAGMA integrity_check;'
sqlite3 /data/app.db 'PRAGMA journal_mode;'
sqlite3 /data/app.db 'select count(*) from users;'
```

裸机把 `/data/app.db` 换成 `/srv/ln/data/app.db`。期望：`heads` 与 `current` 一致；`integrity_check` 返回 `ok`；`journal_mode` 返回 `wal`。

### C-7 代码事实复核（改代码前先跑，确认缺口仍存在）

```bash
grep -nE '@router\.(get|post|patch|delete)' backend/routes_auth.py backend/routes_account.py
grep -nE 'forgot|reset-password|change-password|delete-account|verify-email' backend/routes_auth.py backend/routes_account.py || echo "no such endpoints"
grep -nE 'delete_user_sessions' backend/*.py
grep -n 'SHOW_COURSE_GENERATION' frontend/src/App.tsx
grep -R -E '即将上线|ComingSoon|legalPending' frontend/src | head
grep -n 'subtitleLocalOnly' frontend/src/i18n/zh-CN.json
(cd backend && venv/bin/python -c "import config; print({k:(v.get('in'),v.get('out')) for k,v in config.MODEL_CATALOG.items()})")
```

- 这些命令用于确认“当前缺口”而不是“已完成”；如果输出变化，更新本文档与 gate 判断。

### C-8 部署命令（部署机）

Docker（先准备 `.env`，权限 600）：

```bash
cd /srv/ln/app
cp deploy/linguatrek.env.example .env && chmod 600 .env
# 编辑 .env：CORS_ORIGINS / COOKIE_SECURE / ADMIN_EMAILS / EVENTS_PSEUDONYM_SALT / Key / VITE_API_BASE
docker compose build
docker compose run --rm app alembic upgrade head
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8000/healthz | python3 -m json.tool
```

裸机：

```bash
sudo systemctl restart linguatrek
curl -fsS http://127.0.0.1:8000/healthz | python3 -m json.tool
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

- 以上命令来自 `docs/部署指南.md`；本机未验证目标服务器，执行前 `[先核实]` Docker/服务名/路径/域名。
- 禁止：`--workers 2+`、`docker compose up --scale app=2`、设置 `API_AUTH_KEY`/`VITE_API_KEY`。

### C-9 公开站与 UI 扫描

```bash
node scripts/check-design-tokens.mjs --baseline
node scripts/check-ui-selectors.mjs --baseline
(cd frontend && npm run check:i18n)
```

- 两个 design 脚本是 **report-only**：退出码 0 不代表合规；基线约 846 行，A1 90 条是另一套人工口径。
- 公开站检查：`curl -s https://<domain>/ | head -40`（看 meta）、`curl -s https://<domain>/robots.txt`、`curl -s https://<domain>/sitemap.xml`；没有就是缺口（P8-01/P8-02）。

---

## 9. 未核实项与发布前复核

> 以下项目本文**没有**在生产环境验证，或仓库内没有足够信息；发布前必须由 owner 逐项确认，不能把“看起来有”当“已验证”。

1. **全量测试未运行**：2026-11-20 只确认收集 1122 项；没有跑全量，不能声称全绿。发布前必须跑 `§8 C-1`，并以实际输出为准。
2. **UI 可访问性/对比度未实测**：屏级覆盖 21/27（77.8%），仍有 6 个页面；W5b 报告明确“不是门禁通过”；浏览器对比度实测、`/dev/ui` 矩阵仍未落地。不得写“UI 已完全合规”。
3. **生产域名/DNS/证书/服务器规格未验证**：域名、A/AAAA、80/443、Caddy 版本、证书签发、Cloudflare 灰云/橙云均需在部署机确认。
4. **部署命令未在本机生产环境验证**：本机有 Docker 命令，但没有验证目标服务器；`docker compose`/systemd/Caddy 命令需按实际路径复核。
5. **`docs/部署指南.md` 有迁移 head 过期示例**：文档写“期望 0012_exam (head)”，当前代码 `alembic heads` 是 `0022_generated_courses`；以命令为准，不要照抄旧示例。
6. **计划书的 2026-11-13 外部事实未复核**：Cloudflare 100s、Nginx 60s、Render/Fly/Vercel 的超时与价格是当时核对；厂商会变，上线前按链接复核。
7. **支付/邮件/税务服务商未选**：KYC、费率、结算周期、发票类型、跨境税务均未定；`[先核实]` 后再排 P11。
8. **托管地/ICP/跨境传输未决**：境外服务器需披露跨境；境内需 ICP 备案且 YouTube 可达性/合规风险高；见 P1-07。
9. **YouTube ToS/字幕抓取/嵌入权限未法务确认**：`youtube-transcript-api`/yt-dlp 是非官方抓取，公开部署前需评估 ToS/限流与官方 Data API 替代（P1-06）。
10. **本地视频文案与事实不一致**：当前 `localVideo.subtitleLocalOnly` 说“字幕只在本地读取，不会上传”，但字幕块会送 `/api/local-video/process` 调 LLM；P1-05 必须改，否则属于误导。
11. **无后端单流 45 分钟上限**：计划书里的 45 分钟是方案，不是代码；当前只有心跳，没有强制单流上限。P3-06 需要补或明确接受风险。
12. **无用户侧公告展示**：`app_settings.announcement` 存在管理台，但未找到前台展示入口；P8-05 需要补。
13. **离机备份/监控告警未配置**：脚本存在不等于已配置；rclone remote、告警收件人、值班表都要实际验证。
14. **`faster-whisper` 是可选依赖**：`requirements.txt` 只把本地 ASR 列为可选；生产不装就没有“无字幕自动转写”兜底，QA 时不要承诺该能力。
15. **工作区仍有未跟踪文件**：`scripts/books-all-shots.mjs`；发布冻结前必须归档/提交/忽略，不能带着未知文件构建。
16. **公开站 meta/robots/sitemap 缺失**：`index.html` 无 description/OG，`frontend/public/` 无 `robots.txt`/`sitemap.xml`；G2 前补，G1 可在发布说明中注明。
17. **支付代码为零**：`credits` 只能管理员手动调账；P11 是新增系统，不是“开关”，工时估算必须按新项目排。

---

## 10. 明确不做 / 不许声称的事

- **不许**在 G1 公告里写“公开注册已开放”“支持付费”“随时可退款”。
- **不许**用“内测免费”页面收钱；G3 前不接支付、不展示真实价格。
- **不许**设置 `API_AUTH_KEY` 或 `VITE_API_KEY`（浏览器多用户部署会 401 或泄露密钥）。
- **不许** `--workers 2+` 或多副本（SQLite + 进程内限流/缓存会失效）。
- **不许**在没跑 `restore_drill.sh` 的情况下说“有备份、可恢复”。
- **不许**在没做邮箱验证/找回/改密/删号的情况下开放 G2。
- **不许**在 UI 存量未清、屏级覆盖 21/27 的情况下写“UI 已完全合规”。
- **不许**把“视频不上传”简化成“字幕不上传”：字幕文本会送 LLM，必须披露。
- **不许**跳过备份直接迁移；迁移不可逆，回滚只说“恢复备份”。
- **不许**在未对账的情况下收费；支付成功 ≠ 权益正确 ≠ 财务正确。

---

## 11. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-20 | v1.0 | 初版：Web 三 gate 清单、P0–P11 任务、最小通过集、T-7–T+7 日历、Go/No-Go 15 条、命令附录、未核实项 |

---

> **最终提醒**：这份清单的价值不在“写完”，而在“每一条都能拿出证据”。任何一条勾选都必须能回答三个问题：**谁做的、什么时候做的、命令/截图/链接在哪里**。答不上来就还是 `[ ]`。
