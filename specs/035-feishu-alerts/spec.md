# 035 — 飞书告警（M5，后端）

> 状态：**后端 + 配置 + 巡检脚本 + 规格 + 测试已实现** ｜ 2026-11-20
> 依赖：`docs/项目提案-上线功能.md` §9（飞书设计）、§6/§7（成本与可观测性）、
> 034 余额与 AI 计费（结算失败 / overrun）、021 后台（管理员）、
> `backend/observability.py`（请求日志 / 未处理异常）。
> 范围：后端告警模块、接入点、管理员测试端点、外部巡检脚本、env 注释、规格、
> 测试；**不改前端、不改支付/账号语义、不新增数据库迁移、不引入 Redis/消息队列**。
> 一句话：用一个飞书群 + 一个自定义机器人 webhook，把「站点不可用 / 资金风险 /
> 成本异常」按 P0/P1/P2 分级送达；请求路径不阻塞、失败只记日志、webhook 与
> 签名密钥只放服务器 env。

## 1. 目标

- **P0 能叫醒人**：未处理 5xx、计费结算失败、`/healthz` 连续失败（外部巡检）。
- **P1 当日处理**：结算 overrun、日预算 50/80/100%、LLM 失败率异常。
- **P2 每日摘要**：备份失败等低频事件合并成一天一条，避免告警疲劳。
- **发送在请求路径之外**：HTTP POST 在后台 daemon 线程（管理员测试端点例外，
  它是显式同步操作）；断网/超时/非 2xx/飞书非 0 code 都只记日志，不影响业务。
- **密钥不进仓库/日志/测试快照**：`FEISHU_WEBHOOK_URL` 与
  `FEISHU_WEBHOOK_SECRET` 只从环境变量读；日志只含 event/level/key 与原因标签。
- **可去重、可聚合、可静默、可降级**：同 key 5 分钟去重；P1 15 分钟聚合；
  P2 每日摘要；维护模式静默 P1/P2（P0 仍发）；发送失败不重试、不写盘。
- **单机单 worker 口径**：去重表、聚合桶、预算标记、失败率窗口都在进程内存，
  重启清零；不引入 Redis / 消息队列 / 多进程协调。

## 2. 非目标（M5 不做）

- 不做完整 APM / Sentry / 日志平台；不把飞书当唯一日志存储。
- 不做多通道（短信/电话/邮件）、不做 24/7 值班承诺。
- 不做磁盘水位 / 证书到期 / 备份文件缺失的**自动**采集：本轮只提供事件类型
  `backup_failed` 与脚本的 `--event` 主动上报入口（由备份脚本/巡检 cron 调用）。
- 不做发送重试与「恢复通知」（提案 §9.6/§9.5 的建议项，见 §8 未覆盖）。
- 不做 5xx 风暴的跨 key 合并（只按 `method+path+异常类型` 去重；同一根因的
  多路径仍可能各发一条 P0）。
- 不新增数据库表/迁移；不在前端展示告警配置或历史。
- 不改造 M3 余额语义：只在「结算失败 / overrun」两个既有分支旁加告警调用。

## 3. 级别

| 级别 | 含义 | 发送方式 |
|---|---|---|
| `P0` | 站点不可用 / 数据或资金风险，立即处理 | 立即发送；配置 `FEISHU_AT_USER_ID` 时 @ 负责人 |
| `P1` | 当日处理（成本 / 备份 / 安全异常） | `ALERT_P1_AGGREGATE_SECONDS` 窗口聚合后一条 |
| `P2` | 运营 / 审计摘要 | 本地日期缓存，`ALERT_DAILY_DIGEST_HOUR` 后一条每日摘要 |

- `FEISHU_ALERT_LEVEL` 是**最低发送级别**：`P2`（默认，全发）/ `P1`（P0+P1）/
  `P0`（只发 P0）。被过滤的事件返回 `filtered`，不发。
- 去重只作用于 P0/P1；P2 是摘要，按次数累计不逐条去重。
- 维护模式（`app_settings.maintenance_mode=1`）下 P1/P2 返回
  `suppressed_maintenance`；**P0 不受影响**。

## 4. 事件类型（闭集）

代码常量：`backend/alerts.py::EVENT_TYPES`。未知事件返回 `unknown_event` 且不发，
避免拼写错误把告警静默丢掉。

| 事件 | 级别 | 触发点 | key（去重维度） |
|---|---|---|---|
| `http_5xx` | P0 | `observability.record_request` 捕获未处理异常 | `method:path:异常类型` |
| `billing_settle_failed` | P0 | `llm._billing_finish` 结算写库失败（保留 hold） | `settle_failed` |
| `billing_overrun` | P1 | `billing.settle` 实际成本 > 预占 | `overrun:<user_id>` |
| `llm_failure_rate` | P1 | `llm.generate` 每次调用成败计数；10 分钟窗口失败率 ≥20% 且调用 ≥10 次且失败 ≥2 次 | `llm` |
| `budget_threshold` | P1 | `ai.quota.ensure_within_budget`，日预算跨 50/80/100% | `user|global:<阈值>` |
| `backup_failed` | P1 | 外部脚本 `scripts/check-alerts.py --event backup_failed ...` | 调用方 `--key` |
| `health_unhealthy` | P0 | `scripts/check-alerts.py` 连续 N 次 `/healthz` 失败 | `healthz` |
| `test` | P1（可指定） | `POST /api/admin/alerts/test` | `test`（管理员测试强制绕过） |

内部合成消息（不在闭集、不接受外部 event）：`p1_aggregate`（P1 聚合）、
`p2_digest`（P2 每日摘要）。

## 5. 发送与签名

- **通道**：飞书群自定义机器人 webhook；只依赖标准库 `urllib`。
- **消息形态**：`FEISHU_ALERT_MESSAGE_FORMAT=text`（默认，纯文本）或 `card`
  （`msg_type=interactive` 富文本卡片，P0 红 / P1 橙 / P2 蓝）。
- **签名**（`FEISHU_WEBHOOK_SECRET` 非空时）：请求体顶层加
  `timestamp`（秒）与 `sign`：
  `base64(HMAC-SHA256(key=f"{timestamp}\n{secret}", msg=""))`。
  服务器时间必须 NTP 同步；时间漂移会被飞书拒绝（按失败降级）。
- **超时**：`FEISHU_ALERT_TIMEOUT_SECONDS`，默认 5 秒（代码夹在 3–5）。
- **@ 负责人**：仅 P0 且 `FEISHU_AT_USER_ID` 非空时追加
  `<at user_id="ou_xxx"></at>`（文本）或 `<at id=ou_xxx></at>`（卡片）；
  值可为 open_id 或 `all`。@ 是否生效取决于群/机器人权限，发送失败只记日志。
- **不打印敏感信息**：日志固定只含 `alert_event` / `level` / `key` / 原因标签
  （`timeout`、`http_500`、`feishu_code_19021` 等），不含 webhook、secret、
  响应正文或完整 payload；payload 构造前对 details 再做一次
  webhook/secret 替换（`[redacted]`）与 500 字符截断。

## 6. 去重 / 聚合 / 摘要 / 静默

| 机制 | 默认 | 行为 |
|---|---|---|
| 同 key 去重 | `ALERT_DEDUPE_SECONDS=300` | P0/P1 在窗口内只接受一次；`0` = 关闭 |
| P1 聚合 | `ALERT_P1_AGGREGATE_SECONDS=900` | 窗口内不同 key 的 P1 合并成一条；窗口到期由「下一条告警惰性触发」或后台 flusher（30s tick）发出 |
| P2 每日摘要 | `ALERT_DAILY_DIGEST_HOUR=9` | 按本地日期累计次数；到整点后发一条；当天只发一次 |
| 维护模式静默 | — | P1/P2 不发送；P0 仍发 |
| 最低级别 | `FEISHU_ALERT_LEVEL=P2` | 低于该级别的事件不发 |

已知边界：

- 全部状态在**进程内存**，单 worker 有效；进程重启清零（P1 未发出的聚合、
  P2 当日计数、去重表、预算标记、LLM 失败率窗口都会丢）。
- P1 聚合与 P2 摘要依赖应用进程存活（后台 flusher）或显式 `alerts.flush()`；
  应用停机期间不会补发。
- 管理员的 `test` 消息与巡检脚本的 `--event` 使用 `force=True`，绕过去重 /
  聚合 / 维护模式（仍受「未开启 / 未配置 webhook」约束）。

## 7. 接入点与代码路径

| 文件 | 改动 |
|---|---|
| `backend/alerts.py` | **新增**：级别/事件闭集、`AlertManager`、去重、P1 聚合、P2 摘要、签名、payload、后台发送、预算/失败率钩子、模块级单例 |
| `backend/config.py` | 新增 `FEISHU_*` / `ALERT_*` / `RATE_LIMIT_ADMIN_ALERT_TEST_PER_MINUTE`；默认关闭 |
| `backend/observability.py` | 未处理异常：记日志 + 500 响应之后调用 `alerts.notify_http_5xx`（再包一层 try/except，告警故障不递归） |
| `backend/billing.py` | `settle` 的 overrun 日志后调用 `alerts.notify_billing_overrun`（不改变余额/流水/返回） |
| `backend/llm.py` | 结算失败分支调用 `alerts.notify_billing_settle_failed`（P0）；`generate` 成功/失败调用 `alerts.record_llm_outcome`（余额不足/取消不计失败） |
| `backend/ai/quota.py` | `ensure_within_budget` 在抛 `BudgetExceeded` 前调用 `alerts.check_budget_threshold` |
| `backend/routes_admin.py` | 新增 `POST /api/admin/alerts/test`，管理员 + 专用限流 |
| `scripts/check-alerts.py` | **新增**：进程外 `/healthz` 连续失败巡检、state 文件、`--dry-run`、`--self-test`、`--event` |
| `deploy/alert-check.cron` | **新增**：cron 安装模板（每 2 分钟，读取 `/etc/linguatrek/env`） |
| `.env.example` / `deploy/linguatrek.env.example` | 新增告警配置注释；**不含真实值** |
| `backend/tests/test_alerts.py` / `test_alerts_integration.py` | **新增**离线测试 |

`/healthz` 本身**不发**告警：探活抖动容易造成误报；由外部巡检脚本连续 N 次
失败后发 P0。

## 8. 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `FEISHU_ALERTS_ENABLED` | `false` | 总开关；关闭时不建线程、不读维护模式、不发送 |
| `FEISHU_WEBHOOK_URL` | 空 | 自定义机器人 webhook；**本身是密钥**，只放 env |
| `FEISHU_WEBHOOK_SECRET` | 空 | 签名密钥；空 = 不签名 |
| `FEISHU_ALERT_LEVEL` | `P2` | 最低发送级别：`P2` / `P1` / `P0` |
| `FEISHU_AT_USER_ID` | 空 | P0 @ 负责人：open_id 或 `all`；留空不 @ |
| `FEISHU_ALERT_MESSAGE_FORMAT` | `text` | `text` / `card` |
| `FEISHU_ALERT_TIMEOUT_SECONDS` | `5` | 发送超时（代码夹在 3–5 秒） |
| `ALERT_DEDUPE_SECONDS` | `300` | 同 key 去重窗口；`0` = 关闭 |
| `ALERT_P1_AGGREGATE_SECONDS` | `900` | P1 聚合窗口 |
| `ALERT_DAILY_DIGEST_HOUR` | `9` | P2 每日摘要整点（服务器本地时区） |
| `ALERT_ENV` | `dev` | 消息正文里的环境标签（prod/staging/dev） |
| `RATE_LIMIT_ADMIN_ALERT_TEST_PER_MINUTE` | `3` | 管理员测试端点限流（次/分钟） |

## 9. 管理员测试端点

`POST /api/admin/alerts/test`（需登录 + `ADMIN_EMAILS` 管理员）

请求体（可省略）：`{"message": "可选文案（≤200 字）", "level": "P0|P1|P2"}`，
`level` 默认 `P1`（不 @ 人）。

响应（HTTP 200，除非校验/限流失败）：

```json
{"event": "test", "level": "P1", "key": "test", "status": "sent",
 "sent": true, "queued": false, "reason": null, "enabled": true,
 "configured": true, "ok": true}
```

- `status` 可能是 `sent` / `failed` / `disabled` / `not_configured` /
  `unknown_event` / `invalid_level` / `error`；未开启/未配置时**不伪装成功**
  （`ok=false`）。
- 权限：游客 401、普通用户 403；限流：专用桶
  `RATE_LIMIT_ADMIN_ALERT_TEST_PER_MINUTE`（默认 3 次/分钟，超限 429 +
  `Retry-After`），另外还受既有 `/api/admin` 30 次/分钟桶约束。
- 测试消息同步发送（`sync=True`，在 FastAPI 线程池里执行），返回真实结果；
  不会写入告警去重表（`force=True`）。
- 响应不含 webhook/secret；审计日志只记 level/status/sent。

## 10. 外部巡检脚本

`scripts/check-alerts.py`：

```bash
# 手工验证（不发消息、不写 state）
backend/venv/bin/python scripts/check-alerts.py --dry-run

# 生产 cron 调用（真实发送；env 由 cron 行 source）
backend/venv/bin/python scripts/check-alerts.py

# 离线验证 payload/签名（transport 是内存假函数，不联网）
backend/venv/bin/python scripts/check-alerts.py --self-test

# 主动上报其它事件（如备份失败）
backend/venv/bin/python scripts/check-alerts.py \
  --event backup_failed --level P1 --summary "备份文件缺失" --key backup
```

- 默认 URL `http://127.0.0.1:8000/healthz`，阈值 `--threshold 2`，超时 5s，
  重复告警间隔 `--dedupe-seconds 1800`。
- 连续失败计数存 `DATA_DIR/alerts/health_state.json`（跨 cron 运行保留）；
  成功清零；达到阈值且未在 dedupe 窗口内 → 发 `health_unhealthy` P0。
- `--dry-run` 不发送、不写 state；输出一行 JSON（便于 cron 日志）。
- 退出码：0 = 健康或已处理；2 = 不健康（已按需告警）；1 = 参数/脚本错误。
- 安装模板见 `deploy/alert-check.cron`；cron 不继承 systemd
  `EnvironmentFile`，需在该行 `set -a; . /etc/linguatrek/env; set +a`。

## 11. 降级与安全

- **未开启**：`notify()` 立即返回 `disabled`；不建线程、不查维护模式。
- **已开启但无 webhook / URL 非法**：返回 `not_configured`；启动时打印一次警告
  （不含 URL）。
- **超时 / DNS / 连接拒绝 / 非 2xx / 飞书返回非 0 code**：返回 `failed` +
  原因标签，只打一条 WARNING 日志；不抛给请求、不重试、不写盘。
- **告警代码自身异常**：模块入口 `notify()` 兜底 try/except，返回 `error`；
  5xx 中间件再包一层 try/except，确保不会递归成第二个 5xx。
- **密钥纪律**：webhook/secret 不写进代码、文档、测试快照、日志、payload；
  `.env`/`/etc/linguatrek/env` 权限 600；轮换时先加新 webhook 验证再删旧。
- **签名依赖时间**：服务器必须 NTP 同步；时间漂移会导致飞书拒绝（按失败降级）。

## 12. 测试与验收

```bash
cd backend
venv/bin/python -m py_compile alerts.py routes_admin.py observability.py billing.py llm.py ai/quota.py
venv/bin/python -m pytest tests/test_alerts.py tests/test_alerts_integration.py -q
venv/bin/python -m pytest tests -q          # 全量
```

覆盖（全部离线，transport 为内存假函数；不请求飞书）：

1. 关闭不发；开启但无 webhook 不崩、状态 `not_configured`；
2. 文本/卡片 payload；`timestamp + HMAC-SHA256` 签名可独立复算；
3. 超时/断网/非 2xx/飞书非 0 code 不抛异常，原因标签正确；
4. 同 key 5 分钟去重、P1 聚合、P2 每日摘要、维护模式静默 P0 仍发；
5. 最低级别过滤、未知事件、强制发送、异步发送 + 线程收尾；
6. 预算 50/80/100% 每档每天一次；LLM 失败率窗口；
7. details/webhook/secret 脱敏；请求体与日志不含敏感值；
8. 未处理 5xx → P0 且同异常去重；告警函数抛错不递归；`/healthz` 503 不直接发；
9. `billing.settle` overrun → P1；`llm` 结算失败 → P0；quota 预算钩子；
10. 管理员测试端点：游客 401 / 普通用户 403 / 管理员 200 / 限流 429 /
    level 校验 400 / 关闭与未配置的真实状态；
11. 巡检脚本：连续失败阈值、去重、恢复清零、dry-run、`--self-test`、`--event`。

手工验证（不联网）：

```bash
backend/venv/bin/python scripts/check-alerts.py --self-test
# 预期输出含 "sent": true、"sign_recomputable": true

# 应用内离线验证：假 transport，不请求飞书
backend/venv/bin/python - <<'PY'
import sys; sys.path.insert(0, "backend")
import alerts
m = alerts.AlertManager(
    enabled=True, webhook_url="https://example.invalid/hook",
    webhook_secret="demo", transport=lambda u, b, t: (200, '{"code":0}'),
    async_send=False, background_flush=False,
)
print(m.notify("test", "P0", summary="offline", force=True, sync=True))
PY
```

真实环境验收（需要用户本人）：

- 建群/机器人 → 配 env → 重启 → `POST /api/admin/alerts/test` 收到消息（含 @ 人）；
- 故意填错 webhook：接口 200 但 `sent=false`，日志有 `alert_send_failed`
  且无 webhook/secret；业务请求不受影响；
- 模拟 5xx / 连续 healthz 失败：确认 P0、去重与恢复；
- `grep -R "FEISHU_WEBHOOK"` 仓库无真实值；日志无 webhook/secret。

## 13. 已知未覆盖 / 后续

- 无发送重试与 `failed.jsonl` 落盘（提案 §9.6 建议）；失败只记日志，靠下次
  事件或巡检脚本重新触发（巡检脚本自身有 state 去重）。
- 无「恢复通知」（提案 §9.5 建议）；只有再次异常会重新告警。
- 无跨 key 的 5xx 风暴合并 / 全站 5xx 率阈值；当前按路径 + 异常类型去重。
- 无磁盘水位/证书到期/备份缺失的自动采集；`backup_failed` 需由外部脚本
  调用 `--event` 上报。
- P1 聚合/P2 摘要/去重/预算标记/LLM 窗口都是进程内存：单 worker 有效，
  重启清零；P2 摘要依赖应用进程在整点后仍在运行（或手动 `alerts.flush()`）。
- 飞书接口的真实限流/签名/卡片字段未在本机联调（提案 §D-7/附录 D 未核实项）；
  格式按飞书官方自定义机器人文档实现，若线上返回非 0 code 会按失败记录原因标签。
- `FEISHU_ALERT_LEVEL` / `FEISHU_AT_USER_ID` 是可选能力；@ 是否生效取决于
  机器人/群权限。
- 未改前端：管理台暂无「告警测试」按钮，测试端点仅供 curl/脚本使用。

## 14. 验收清单

- [x] `pytest tests/test_alerts.py tests/test_alerts_integration.py -q` 全绿
- [x] 全量 `pytest tests -q` 通过（见收尾报告）
- [x] 关闭 / 无 webhook / 超时 / 非 2xx 均不抛异常
- [x] 签名可独立复算；日志与 payload 不含 webhook/secret
- [x] 去重、P1 聚合、P2 摘要、维护模式、级别过滤有测试
- [x] 管理员端点权限 401/403/200、限流 429、level 400 有测试
- [x] 5xx 告警不递归；`/healthz` 不直接告警；巡检脚本连续失败/恢复有测试
- [x] `.env.example` / `deploy/linguatrek.env.example` 只有注释与空值
- [ ] 真实飞书 webhook 到群验证（需用户本人建群/机器人后执行，见 §12）
