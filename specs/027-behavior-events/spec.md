# 规格：学习行为埋点（CEFR M2 #7）

> 规格只讲**做什么**和**为什么**，不讲怎么实现。总依据：
> `docs/项目计划-CEFR能力标定.md` §5.6 / §7.3 / §10.2 #7。

**状态：** 已实现（后端 + 前端） ｜ **代码：** `backend/behavior_events.py`、
`backend/routes_events.py`、`backend/routes_admin.py`、迁移
`0017_behavior_events.py`、`frontend/src/lib/learningTelemetry.ts`、
`frontend/src/App.tsx`

---

## 目标

先**如实记录**四类学习行为，给 M3 的行为证据融合（§5.6）准备原料；M2
**不**用它们改对外等级、不显示任何推断结论。事件必须可查、可去重、不含
用户原文与 PII，且上报失败绝不打断查词/播放。

## 事件字典 v1

所有事件走现有 `POST /api/events`，写入 append-only 的 `learning_events`
（不新建表；`watch` 仍写 `watch_events`）。公共字段：

| 字段 | 规则 |
|---|---|
| `type` | 四选一：`dict_lookup` / `video_replay` / `playback_rate` / `tab_visibility` |
| `eventId` | 客户端生成，≤128 字符，`[A-Za-z0-9._:-]`；同归属同类型幂等 |
| `sessionId` | 页面级匿名 id（uuid / 时间戳随机串），≤128；`tab_visibility` 必填 |
| `occurredAt` | 客户端毫秒；缺省服务端时间；不能晚于服务端 5 分钟 |
| `contentRef` | 内容 id（videoId / articleId / bookId），≤200，不含空白/反斜杠 |

| 事件 | 触发点 | payload（白名单） | 去重/节流 |
|---|---|---|---|
| `dict_lookup` | 打开词查卡、点词、悬停切换词 | `word`（NFC、折叠空白、小写、≤64）、可选 `lemma`、`source`（`transcript/reader/book/sentence/other`） | 同一词 60s（前端 + 服务端）；**不发 context/句子/自由文本** |
| `video_replay` | 点击字幕、键盘 ←/R、单句循环、回退 seek、播放器原生回拖（位置轮询发现） | `fromSeconds`、`toSeconds`、`method`（`click/keyboard/loop/seek`）；只接受 `to < from` | 前端按内容 1s（loop 10s）|
| `playback_rate` | 倍速选择器变化 | `fromRate`、`toRate`（0.25–4，且不相等） | 无（用户动作） |
| `tab_visibility` | `visibilitychange` | `state`（`hidden/visible`）、`visibleSeconds`（hidden 时为刚结束的可见时长；visible 为 0） | 只记状态切换；**不记页面内容** |

**不做**：不记录用户输入的自由文本、阅读正文、查询词以外的内容；不出示
「行为等级」；M2 不把事件反馈给推荐或画像（M3 才评估融合）。

## 功能需求

- **必须**：`POST /api/events` 同时接受 `watch` 与四类行为事件；按 `type`
  分流到 `watch_events` / `learning_events`，任一非法整批 400（先全量校验
  再写）。
- **必须**：单次批量 ≤50（沿用 M5），其中行为事件 ≤20；混合批也遵守。
- **必须**：`eventId` 幂等（迁移 0017 的部分唯一索引），重复上报计
  `duplicated`；`dict_lookup` 同词 60s 计 `deduplicated`；幂等优先于词去重。
- **必须**：管理员只读 `GET /api/admin/events?type=&limit=&since=`，返回脱敏
  字段（不含 `user_id`/`device_id`）；未知 type 400；未迁移 503。
- **必须**：`/api/events` 限流（登录 120 次/分钟、游客 60 次/分钟），超限
  429 + `Retry-After`。
- **必须**：前端 4 个触发点均上报；内存队列 ≤100、批量 ≤20、1.5s 合并；
  失败静默（不 toast、不抛错），重试一次保持相同 id；页面隐藏/卸载用
  `keepalive` flush。
- **必须**：游客也上报（`guest:<sha256>` 归属），`sessionId` 匿名；无新增 UI。
- **必须**：事件表未迁移时 POST 返回 503，前端静默失败，不影响学习。

## 验收标准

- [ ] 四类合法事件落 `learning_events`，payload 只含白名单字段；发送
      `context`/`sentence` 不落库。
- [ ] 未知 type、缺 eventId、超长词、正常前进的 replay、非回退秒数、
      非法倍速、缺 sessionId 的 visibility、批量 >20 → 400 且不写半批。
- [ ] 同 eventId 重复上报 → `duplicated` 且只落一行；同词 60s 内 →
      `deduplicated`；61s 后可再落；不同词不受影响。
- [ ] 游客可上报且归属 `guest:<sha256>`；未迁移库 → 503。
- [ ] `/api/events` 限流 429；管理员只读查询可查、非管理员 403/401，
      响应不含明文归属/设备 id。
- [ ] `py_compile`、后端全量 pytest、`tsc -b`、`check:i18n` 绿。
- [ ] Playwright（mock `/api/events` 与 `/api/define`）：点词、切倍速、
      回退、hidden/visible 各发一条；payload 正确；`/api/events` 503 时查词
      与倍速控制仍可用、页面无未捕获错误。

## 边界与非目标

- **不建新表**：复用 `learning_events`；只加 `client_event_id` 列 + 部分唯一索引。
- **不改对外 band**：事件只存档，M2 无任何用户可见的推断结论。
- **不做**播放器内部操作的精确归因：YouTube iframe 的拖动无法直接监听，
  原生回拖由 100ms 位置轮询发现，`from/to` 近似、`method=seek`；App 自己
  发起的点击/键盘/循环 seek 有精确方法。
- **不做**前端采样率可配置；当前按事件类型去重/节流。
- **不做**事件数据导出/删除矩阵扩展；沿用 `learning_events` 的 24 个月保留
  与未来删除权矩阵。

## 版本与变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-17 | 首版实现：4 类事件、迁移 0017、服务端校验/幂等/去重/限流、管理员只读、前端 telemetry 模块与 Playwright 验证 |
