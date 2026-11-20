# 036 — AI 登录闸与严格计费（M7a 后端）

> 状态：**已实现** ｜ 2026-11-20
> 依赖：001 用户体系、010 多模型、012 多语言、028 教学分析、030 课程生成、
> 031 本地 EPUB、034 余额与 AI 成本（M3a/M3b）、035 飞书告警
> 权威背景：`docs/项目提案-上线功能.md` §5（余额、成本、402/429）、§7.3（认证）、
> §10 M7；本规格只覆盖 **M7a 后端**，前端 M7b 另做。
> 一句话：**所有会调用大模型的交互都必须登录；每笔调用都必须绑定账号、有可核实
> 单价、预占并结算余额。缺价模型直接拒绝，不再出现 `billable=0` 的免费调用。**

## 1. 目标

1. 游客/匿名调用任何 AI 生成入口 → **403** `{detail, code:"login_required"}`。
   不用 401：前端全局把 401 当成会话过期并登出，游客本就没有会话。
2. 登录用户的每笔真实模型调用：
   - `ai_usage.user_id` 必须是该登录用户（后台线程/SSE/全局缓存不得丢 user）；
   - 调用前按候选链最高价预占余额，成功后按 provider usage 结算；
   - 缺价模型 → **503** `{code:"model_unpriced"}`，**不调用 provider**；
   - 余额不足 → **402** `{code:"insufficient_balance"}`（沿用 M3a）；
   - 失败/超时/取消释放预占，不扣费。
3. 缓存命中/公开只读不触发 AI、不扣费：
   - 公版书章节 GET、公版书已缓存译文仍可公开读取；
   - 游客已落盘的历史字幕/词典缓存仍可读，但不会补译/总结/分析；
   - 需要 AI 生成的新内容（未缓存章节、新视频、新本地剧集、新本地视频、查词）
     必须先登录并由触发用户付费。
4. 稳定错误码（前端 M7b 直接读，不解析中文）：
   `login_required` / `model_unpriced` / `insufficient_balance` /
   `quota_exceeded`（功能日配额）/ `budget_exceeded`（用户/全站日预算）。
5. 严格模式默认开启；模型路线只含 priced 模型。

## 2. 非目标

- 不改前端 UI（M7b 另做）；不改支付/邮件/飞书。
- 不改数据库结构：复用 M3a 的 `account_ledger`/`credit_holds`/`model_prices`/
  `ai_usage`；不新增迁移。
- 不做厂商账单自动对账；失败调用是否被厂商计费无法从客户端得知（见 §8）。

## 3. 登录闸（统一 helper）

新增 `backend/ai_auth.py`：

```python
def require_ai_user(request) -> dict      # 未登录/游客抛 billing.LoginRequired（403）
def require_ai_user_id(request) -> str
def ai_user(request) -> dict | None       # 只读：需要「登录才生成、游客只读」时用
```

`billing.LoginRequired`（`status_code=403`、`code="login_required"`）由
`main.py` 已有的 `BillingError` 处理器统一映射成顶层
`{detail, code}`——不是 `{"detail": {...}}`，前端可直接读 `code`。

`main.py` 的 `resolve_identity` 中间件还会在**认证之后、限流之前**按路径做一次
同样的闸门（`_is_ai_generation_request`）：这样游客访问 AI 入口时，即使 body
非法/连续请求，也稳定得到 403 `login_required`（不会先变 422/429），符合
项目提案 §5.5 的「认证 → 限流 → 余额」顺序。路由内的 helper 是第二道防线。

### 3.1 强制入口

| 入口 | 位置 | 说明 |
|---|---|---|
| `POST /api/define` | `routes_user.py` | 查词（缓存/本地词典命中也要登录） |
| `POST /api/process-video` | `routes_videos.py` | 经典处理（含缓存补译/总结/分析） |
| `POST /api/process-video-stream` | `routes_videos.py` | SSE 新生成/补译 |
| `GET /api/process-video-stream` | `routes_videos.py` | EventSource 续传（会生成） |
| `POST /api/process-subtitle` | `routes_content.py` | 本地剧集 SRT |
| `POST /api/local-video/process` | `routes_local_video.py` | 浏览器本地视频字幕 |
| `POST /api/books/{id}/chapters/{n}/translate` | `routes_books.py` | 公版书按需翻译 |
| discover / reading / lesson / course / teaching-analysis / 导入书翻译 | 各自路由 | 原有登录检查统一为 403 + `login_required` |

### 3.2 只读路径

- `GET /api/books/{id}/chapters/{n}`：不传 `?level=` 时零 AI，公开可读；
  传 `?level=` 会触发生成 → 未登录 403。
- `GET /api/history/{filename}`：游客可读自己的缓存；只有登录用户才执行
  「补译未翻译句 / 重试总结 / 生成教学分析」。
- `GET /api/books`、`/api/library/*`、`/api/blog/*`、词汇/难度等纯静态或本地
  词典路径不受影响。

## 4. 严格计费（`BILLING_STRICT`）

`config.BILLING_STRICT` 默认 **True**；`BILLING_STRICT=0` 只作为「迁移前旧部署」
回滚逃生门，生产必须 1。

`llm._billing_begin` 的新顺序（有 `usage_scope(feature, …)` 的调用）：

1. `AI_USAGE_LOGGING=0` 或没有 scope/feature → 不记账（脚本/旧调用）；
2. 没有登录 user（`None` 或 `guest:` 前缀）→ `LoginRequired` 403；
3. 计费表未迁移（`billing.schema_ready()==False`）→ `BillingUnavailable` 503；
4. 模型无价（`billing.price_for_model` 为 None）→ `ModelUnpriced` 503；
5. 余额不足预占 → `InsufficientBalance` 402；
6. 成功 → `billing.settle` 同事务写 `ai_usage` + 扣余额 + `ai_settle` 流水；
   结算失败保留 hold、写 `settle_failed` 兜底行并触发飞书 P1（M5），不静默漏扣。

### 4.1 用户归属

- 所有 API 路径的 `usage_scope` 都显式带真实 `user_id`，不依赖后台线程的
  ContextVar：视频/字幕/本地视频/书籍翻译/导入书/阅读/出题/课程生成/教学分析。
- `book_translation.translate_chapter` 新增必填 `user_id`，按需翻译的成本归
  触发用户（以前记匿名/billable=0）。
- SSE 生成器新增显式 `user_id` 参数；`GET /api/history` 的补译/总结/分析只在
  登录时执行。

### 4.2 缺价模型

- `billing.ModelUnpriced`（503、`code=model_unpriced`、`modelId`）。
- 自动选路/降级链只收 `llm.is_usable()`（Key/端点可用 **且** 有可核实单价）；
  用户显式选择的缺价模型仍排链首，由计费层 503，不静默换模型。
- 生产模型路线只含 priced 模型：`MODEL_ROUTE_VI_VN=deepseek-chat`（Qwen
  Flash/Plus 缺官方价，已移除）；`MODEL_ROUTE_ZH_CN=deepseek-chat,gemini-2.5-flash`
  （两者在 `model_prices` 有价）。补齐 Qwen 官方价后才能加回。

### 4.3 未迁移库的兼容建表

`billing.ensure_schema_compat()`（注册路径调用）现在同时幂等建出
`ai_usage`（含 0025 计费列与 `target_lang`）与 `ai_quota`，并 `INSERT OR IGNORE`
seed 迁移 0025 的 `deepseek-chat`/`gemini-2.5-flash` 价格。这样未跑迁移的
旧库/测试库也不会因缺价把全部 AI 调用 503；生产仍必须先 `alembic upgrade head`。

## 5. 错误码

| 状态码 | `code` | 场景 | 处理 |
|---|---|---|---|
| 403 | `login_required` | 游客/匿名调用 AI 入口 | 弹登录；不登出 |
| 503 | `model_unpriced` | 模型没有可核实单价 | 换有价模型/联系管理员补价 |
| 402 | `insufficient_balance` | 账户可用余额不足预占 | 联系管理员充值（`topup:"admin"`） |
| 429 | `quota_exceeded` | 功能日配额用完 | 明天再试；`feature`/`day` 字段 |
| 429 | `budget_exceeded` | 用户/全站日预算用完 | 明天再试；`scope` 字段 |
| 503 | `billing_unavailable` | 计费表未迁移/账户无余额行 | 运维跑迁移/修数据 |

`ai.ledger.QuotaExceeded.payload()` 生成上述 429 错误体，`main.py` 统一映射；
各路由不再把配额异常转成只有中文 `detail` 的 `HTTPException`。

## 6. 缓存与失败语义

- 命中缓存（完整译文 + 正常总结 + 已缓存教学分析）→ 不调模型、不扣费；
- 失败/超时/客户端取消 → 释放预占，不扣费（已结算的前序批次保留）；
- 结算写入失败 → 保留 hold + 飞书告警 + `billing_status=settle_failed`，可重试；
- **残余风险**：provider 可能已计费但没返回 usage（或我们主动取消），客户端
  无法得知；这部分只能靠厂商账单对账，不在本规格承诺「绝不产生成本」。

## 7. 配置与部署

- `.env.example` / `deploy/production.env.example` / `deploy/linguatrek.env.example`：
  `BILLING_STRICT=1`；`MODEL_ROUTE_VI_VN=deepseek-chat`；
  `DEFAULT_MODEL_VI_VN=deepseek-chat`；Qwen 注释为「补价后启用」。
- 上线前必须：`alembic upgrade head`（0025 计费表 + 价格 seed）→ 至少一个
  模型在 `model_prices` 有价 → 再把 `BILLING_STRICT=1` 暴露给真实用户。

## 8. 测试

`backend/tests/test_ai_login_billing.py`（M7a 新增）+ 既有回归：

- 所有 AI 入口游客/匿名 403 `login_required`，不产生 `ai_usage`/`credit_holds`；
- 登录查词/视频/本地剧集/本地视频 → 扣余额、`ai_usage.user_id` 为本人、
  `billable=1`/`billing_status=settled`；
- 缓存命中/游客读缓存 → 零模型调用、零扣费；
- 公版书翻译：游客 403，登录扣费，第二次缓存命中不扣费；
- 缺价模型 503 `model_unpriced` 且 provider 调用次数为 0；
- 日配额 429 `code=quota_exceeded`；
- 模型路线只含 priced 模型；严格模式默认开；
- 并发预占/结算/无效 hold/overrun/结算失败保留 hold 等继续由
  `tests/test_balance_billing.py` 覆盖。

实测：`cd backend && venv/bin/python -m pytest tests -q` 全绿（见交付报告）。

## 9. 实现文件

- 新增：`backend/ai_auth.py`、`backend/tests/test_ai_login_billing.py`、本规格。
- 修改：`config.py`（`BILLING_STRICT` 默认、vi 路线/默认模型）、`billing.py`
  （`LoginRequired`/`ModelUnpriced`/`strict_mode`/`is_priced`/兼容建表+价格 seed）、
  `llm.py`（严格 `_billing_begin`、`is_usable`、选路过滤）、`ai/ledger.py`
  （`QuotaExceeded.payload`）、`ai/quota.py`（降级链只收 usable）、`main.py`
  （429 处理器）、`translate.py`/`routes_user.py`/`routes_videos.py`/
  `routes_content.py`/`routes_local_video.py`/`routes_books.py`/
  `book_translation.py`/`routes_reading.py`/`routes_quiz.py`/`routes_course.py`/
  `routes_discover.py`/`routes_teaching_analysis.py`/`routes_book_import.py`
  （登录闸、显式 `user_id`、计费异常不回落 mock/占位）。
- 文档：`README.md`、`README_zh.md`、`backend/README.md`、`.env.example`、
  `deploy/production.env.example`、`deploy/linguatrek.env.example`、`specs/README.md`。

## 10. 未覆盖 / 后续

- 前端 M7b（登录弹窗、403 `login_required` 全局处理）不在本规格。
- Qwen 官方价补齐、Gemini 3.x 官方价补齐后才能重新启用对应路线。
- 价格准确性仅到「官方页核对」级别；厂商缓存/阶梯折扣不可见。
- 失败调用的厂商侧计费是残余风险，靠月度账单对账。
