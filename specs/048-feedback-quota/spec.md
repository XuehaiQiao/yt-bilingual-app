# 048 — 用户额度透明 + 反馈/纠错（v1.1 P0）

> 状态：**后端（P2-39）已实现** ｜ 2026-11-25 ｜ base `7ddccf2`，证据 `HEAD 5c99559`
> 背景：额度一直是「看不见的闸」——用户只会在 429 时知道超限（047 只解决管理台可看可调）；
> 出了问题也没有产品内出口，只能靠外部渠道描述（还常常缺 requestId/页面）。
> 048 补上两条**面向用户**的只读/写入出口：`GET /api/quota`（今日额度透明）与
> `POST /api/feedback`（反馈/纠错，登录或游客均可）+ 管理台处理入口。
>
> 代码落点：`backend/feedback.py`（校验/写入/列表/更新/503）、
> `backend/routes_feedback.py`（`POST /api/feedback`、`GET|PATCH /api/admin/feedback`）、
> `backend/routes_user.py`（`GET /api/quota`）、`backend/main.py`（注册 router）；
> 表由 `backend/migrations/versions/0033_v1_1_launch.py` 建（P2-38，已合并，本卡不改表）；
> 验收：`backend/tests/test_feedback.py`、`backend/tests/test_user_quota.py`。
> 前端消费方（P2-40，只读引用、本卡不改）：`frontend/src/lib/feedback.ts`
> （发 `description` 别名 + `requestId` + `page`）、`frontend/src/lib/quota.ts`。

## 1. 成熟产品做法（参考）

Intercom 反馈附件、Linear 的 requestId 关联、OpenAI usage dashboard、GitHub 的
「today's usage + resets at」共同点：

1. **反馈是产品出口**：不需要注册也能提交，但要有稳定关联 id，事后能定位；
2. **有分类、有状态机**：bug/功能/内容/其他；open → in_progress → resolved/closed；
   处理动作留审计（谁、何时、从什么状态到什么状态、备注）；
3. **额度可见**：用户能看到「每个功能今天用了多少、还剩多少、下次重置时间、来源」；
4. **口径单一**：用户侧数字必须与管理员侧、运行时 429 判定同源，不能各算一套；
5. **0 = 关闭**：不提供「无限」这种误配，界面上显示「已关闭」而不是空进度条。

## 2. 本期范围

- `POST /api/feedback`：分类 / 正文 / 来源页 / requestId / 联系方式；登录用户与游客均可；
- `GET /api/admin/feedback`：管理员最近优先列表，可按状态过滤、分页上限；
- `PATCH /api/admin/feedback/{id}`：管理员改状态 + 处理备注，写审计；
- `GET /api/quota`：登录用户 8 个功能的 `limit/used/remaining/resetAt/source` + 统一重置时间；
- **不做**：反馈附件/截图上传、邮件通知、用户回访、管理台 UI（前端另卡）、
  额度「无限」、修改 047 的管理台端点、不新增迁移（表由 0033 提供）。

## 3. 数据（0033 `feedback`，本卡只写不建表）

列：`id INTEGER PK / user_id TEXT NULL / request_id TEXT NULL / category TEXT /
message TEXT / contact TEXT NULL / status TEXT DEFAULT 'open' /
created_at_ms INTEGER / resolved_at_ms INTEGER NULL / admin_note TEXT NULL`；
索引 `(status, created_at_ms)`、`(user_id, created_at_ms)`。

- `user_id` 可空 = 游客提交；**故意不建外键**：账号硬删除后历史反馈保留，删除流程
  不会被悬空约束卡住；
- **0033 没有 page 列**：来源页是诊断信息，`POST` 会校验/截断（≤300）并写进结构化
  日志（与 requestId 一起），不落库；若以后管理台要按来源页筛选，需另加迁移（0034），
  本卡不自作主张改 schema；
- `request_id` 不建唯一约束、**不做去重**：重复提交保留多行，靠同一个 id 归组排查；
  前端一次弹窗只生成一个 id 并在提交中禁用按钮，正常不会重复。

## 4. API 契约

### 4.1 `POST /api/feedback`（登录或游客，限流）

请求体：`{category, message | description, page?, requestId?, contact?}`

- `category` 白名单：`bug` / `feature` / `content` / `other`（大小写与首尾空白规范化；
  翻译/分析纠错归 `content`）；未知分类 **400**；
- `message`（别名 `description`，前端 P2-40 用后者）：去首尾空白后 **5–2000** 字符，
  非字符串/空/过短/超长 **400**；与前端 `FEEDBACK_DESCRIPTION_MIN/MAX` 同口径
  （前端注释也写明「后端同样拒绝」，不搞两套底线）；
- `contact` 可空，字符串，≤200 字符，空串按未填；
- `page` 可空，字符串，超长截断到 300；非字符串 **400**；
- `requestId` 可空，字符串，截断到 128；**未给时回落到访问日志的 request_id**
  （来自 `X-Request-ID` 头或服务端生成），保证每次受理都能和日志对上；
- 身份：登录用户记 `user_id`；游客记 NULL（Cookie 游客身份一样可提交）；
- 成功：`200 {id:<str>, status:"open", requestId:<str|null>}`；`id` 与表主键同值
  但返回**字符串**（前端 `FeedbackReceipt.id: string`，整型会被前端判成 null）；
  管理端列表/PATCH 路径仍用整数主键；
- 失败：`400` 校验 / `429` 限流（`detail` + `retryAfter` + `Retry-After`）/
  `503` 表未迁移（写路径**不 fail-open**，不静默丢用户反馈）。

限流（进程内固定窗口，见 `ratelimit.py`，单进程有效）：

- 登录用户 `RATE_LIMIT_FEEDBACK_PER_MINUTE`（默认 **5**/分钟）；
- 游客 `RATE_LIMIT_GUEST_FEEDBACK_PER_MINUTE`（默认 **3**/分钟），键为 `guest:<sha256>`；
- 两个键名目前不在 `config.py`（本卡写域不含它）：`routes_feedback` 用同名属性
  `getattr` + 模块默认兜底；以后在 config 加同名属性即生效，不需要改代码。
- 0 = 关闭该档限流（与其它桶一致）。

### 4.2 `GET /api/admin/feedback?status=&limit=`（require_admin）

- `status` 可选：`open` / `in_progress` / `resolved` / `closed`；空、`all` 或未给 =
  不过滤；未知状态 **400**；
- `limit` 1–200（默认 50），超出范围由 FastAPI 422；
- 最近优先（`created_at_ms DESC, id DESC`）；
- 返回 `{items:[{id,userId,requestId,category,message,contact,status,createdAt,
  resolvedAt,adminNote}], total, limit, status}`；`total` 是**过滤后**总数；
- **不含账号敏感字段**（无密码哈希/session/token/邮箱以外的账号映射）；`contact`
  是用户主动留的回访渠道，只给管理员看；
- 未登录 **401**、普通用户 **403**、表未迁移 **503**。

### 4.3 `PATCH /api/admin/feedback/{id}`（require_admin）

- 请求体 `{status?, adminNote?}`，至少一项，否则 **400**；
- `status` 白名单同 4.2，未知状态 **400**；`adminNote` 字符串 ≤2000，`null` = 清空；
- `resolved_at_ms`：**非终态 → 终态**（resolved/closed）写当前毫秒；退回
  open/in_progress 清空；终态之间互转保留首次处理时间（衡量处理时长）；
- 未知 id **404**；成功返回更新后的整条反馈；
- 写 `admin_audit_log`（`action=admin.feedback.update`，`target_type=feedback`，
  detail 含 status/adminNote 的前后值）；审计表未迁移时降级为日志、不影响本次更新
  （与既有管理台写操作约定一致）。

### 4.4 `GET /api/quota`（登录用户）

返回：

```json
{
  "day": "2026-11-25",
  "resetAt": "2026-11-26T00:00:00+08:00",
  "timezone": "Asia/Shanghai",
  "features": [
    {"feature": "translate", "limit": 60, "used": 3, "remaining": 57,
     "resetAt": "2026-11-26T00:00:00+08:00", "source": "config"}
  ]
}
```

- 8 个 feature = `quota_config.QUOTA_FEATURES`（顺序固定；`books`/`discover` 没有
  用户日额度，不返回）；
- `limit` / `source` 复用 `quota_config.effective_limit()`：单用户覆盖 >
  后台全局默认 > `config.AI_DAILY_QUOTA_*`，`source` ∈
  `user_override` / `default` / `config`；
- `used` 取 `ai_quota.used_units` 当天行（`ledger.day_of()` 日桶）；**表缺失/无行/
  读失败按 0**（展示接口不 500）；`remaining = max(0, limit - used)`；
- `0` = 关闭该功能：`limit` 与 `remaining` 都是 0，不提供「无限」；
- `resetAt` = `AI_QUOTA_TIMEZONE` 下的**次日 00:00**（ISO8601 带偏移），顶层与每个
  feature 同值；`day` 与 `timezone` 是附加信息，前端可忽略；
- **身份**：未登录且还没有游客身份（请求里没有 `ln_guest` Cookie）→ **401**；
  已带游客身份 Cookie → **403**（游客没有账号额度，提示登录）；未迁移
  （`quota_overrides` 缺失）→ **503**（与管理员接口同口径，不拿默认值冒充生效额度）；
- 只读：不改变任何计数器，也不改变运行时判定（判定仍只在
  `ai.quota.check_and_consume_quota`）。

## 5. 口径与一致性

- 用户侧 limit/used/source **必须**等于 `GET /api/admin/quotas/users/{id}` 的
  `effectiveLimit`/`usedToday`/`source`（测试
  `test_quota_matches_admin_endpoint` 直接对拍）；
- 日桶统一 `AI_QUOTA_TIMEZONE`（默认 `Asia/Shanghai`），与 `ai.ledger` / 管理台一致；
- 额度缓存沿用 `quota_config` 的 5s 进程内缓存：管理员改默认/覆盖后 ≤5s 生效
  （写入方显式 `invalidate()`）；
- 反馈不触达 AI、不消耗额度、不写账本。

## 6. 验收

- 反馈：登录/游客都能提交并落 0033；分类/正文/联系方式非法 → 400 且不落库；
  限流 → 429（两档上限独立）；`requestId` 可从 body 或访问日志请求头回落；
- 管理端：非管理员 401/403；最近优先、status 过滤、limit；PATCH 状态白名单/
  404/空对象 400；`resolved_at_ms` 进出终态正确；审计行有前后值；
- 额度：匿名 401、游客 403；8 个 feature 的 `{limit,used,remaining,resetAt,source}`
  齐全；0=关闭；三层来源正确；`resetAt` = 次日 00:00（带时区）；未迁移 503；
  与管理员口径逐项相等；
- 全量后端 `pytest` 零回归；`backend/venv/bin/python -m py_compile *.py` 通过；
  `node scripts/agent-preflight.mjs --card P2-39` 通过（写域见卡）。

## 7. 已知边界 / 后续

- **page 不落库**（0033 无列）：只进日志；要按来源页筛选需 0034 迁移（schema 负责人）；
- 限流是进程内的：`uvicorn --workers N` 时每进程各算各的（与既有桶同一已知边界，
  见 `backend/README` 安全节）；多进程部署前应换共享存储或退化为反代层限流；
- 反馈没有「用户撤回/查看自己历史反馈」端点：本期只做单向提交与管理台处理
  （游客没有 user_id 可回联，撤回语义不成立）；
- **前端 source 文案对齐（待前端卡处理）**：后端 `source` 用 047 的枚举
  `user_override`（本卡契约），而已合并的 `QuotaPanel.tsx` 只在
  `item.source === 'override'` 时显示「单独配置」徽章；不改后端枚举（会与
  047/管理端口径冲突），前端加一行兼容或改枚举即可；
- 管理台 UI 由前端卡（P2-40 之后）接入，本卡只交付 API 与载荷契约。
