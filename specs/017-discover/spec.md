# 规格：内容发现（主题 → 候选视频）

**状态：** 已实现（2026-11-15，后端契约 + 前端发现页）｜
**对应代码：** 后端 `backend/discover.py`、`backend/routes_discover.py`、
`backend/migrations/versions/0010_discover.py`、`backend/tests/test_discover.py`；
前端 `frontend/src/lib/discover.ts`、`frontend/src/components/DiscoverScreen.tsx`、
`frontend/src/components/EstimateDialog.tsx`、`frontend/src/App.tsx`、
`frontend/src/components/InputScreen.tsx`。

> 计划书把「主题搜索」列在 V1（`§13.5` / `§5.3`），本规格按当前实现先行落地
> **后端 MVP**。设计调查与取舍见 [`docs/计划-内容发现.md`](../../docs/计划-内容发现.md)；
> 实现与其差异（检索词 2–3 个、候选 3–5 个、总预算 20s、前端使用独立的
> `discover` 视图而不是把首页输入框改成「链接/主题」双模式、未接
> YouTube Data API）以本规格为准。

---

## 目标

- **G1 从 URL 到主题**：用户可以输入中/英文自然语言（如「推荐一些关于人工
  智能的演讲」），后端找到 3–5 个适合英语学习的 YouTube 视频，而不是只接受
  粘贴链接。
- **G2 候选可挑**：每个候选有 `videoId`、标题、频道、时长、缩略图、CEFR
  难度估计（A1–C1）、一句中文理由、是否有英文字幕、是否已学过。
- **G3 明确可学**：确认没有英文字轨的视频不返回；字幕探测失败标 unknown 并
  保留，不把「探测失败」误判成「没有字幕」。
- **G4 失败有兜底**：模型不可用/超时/JSON 非法时仍返回候选（规则排序 + 模板
  理由，`degraded:true`）；单个搜索词失败不影响其余；全部失败给中文 503。
- **G5 值得等待**：并发搜索/探测，总预算约 20s；冷启动超预算时优先返回已有
  候选（重排降级），没有候选才 504。
- **G6 缓存与边界**：同 query + targetLang 24h 缓存，第二次命中不重复搜索/
  探测/调模型；只读公开元数据与字幕轨道列表，**不下载、不保存字幕正文**。
- **G7 账号与成本边界**：需登录（游客 403）；每用户每分钟最多 5 次，避免
  误刷模型额度与 YouTube 反爬。

## 用户故事

- 作为想学某个主题的用户，我输入「TED talk about AI」，希望看到 3–5 个相关
  视频与推荐理由，而不是自己去 YouTube 翻。
- 作为中文用户，我输入中文主题，希望系统理解中文意图、去找英文内容，并给
  中文理由与难度估计。
- 作为担心字幕的用户，我希望候选明确标注「有英文字幕/字幕待确认」，没有
  英文字幕的不要混进来。
- 作为学过某个视频的用户，我希望它标成「已学过」，点开走现有缓存流程。
- 作为遇到失败的用户，我希望知道是没搜到、搜索被限还是模型不可用，并能重试
  或改回粘贴链接。

## 功能需求（后端契约）

### 端点

`POST /api/discover`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | 是 | 1–200 字自然语言（中/英）。空白/超长/YouTube 链接 → 400 |
| `targetLang` | string | 否 | `zh-CN`（缺省）/ `vi-VN`；参与缓存键与审计；非法 → 400 |
| `force` | boolean | 否 | `true` 绕过 24h 缓存，重新搜索/重排 |

成功响应（200）：

```json
{
  "queries": ["TED talk about artificial intelligence", "AI future explained"],
  "candidates": [
    {
      "videoId": "KKNCiRWd_j0",
      "title": "What Is an AI Anyway? | TED",
      "channel": "TED",
      "duration": 1322,
      "thumbnail": "https://i.ytimg.com/vi/KKNCiRWd_j0/hqdefault.jpg",
      "level": "B2",
      "reason": "TED 官方演讲，主题直接命中；22 分钟，适合完整看一场。",
      "hasEnglishSubs": true,
      "alreadyProcessed": false
    }
  ],
  "cached": false,
  "degraded": false,
  "disclaimer": "字幕与时长可能随视频更新，候选由 AI/规则筛选，请以点击后的实际页面为准。"
}
```

- **必须**：`candidates` 为 3–5 个；不足时返回实际数量，空数组也是 200，
  **不伪造候选**。
- **必须**：`level` 为 A1/A2/B1/B2/C1 之一（估计值，不是考试分数）。
- **必须**：`hasEnglishSubs` 为 `true` 或 `null`（unknown）；明确无英文字幕的
  候选不出现在列表中。
- **必须**：`alreadyProcessed` 按**当前登录用户 + targetLang** 的历史缓存计算；
  缓存命中时也重算，绝不把别的用户的状态带过来。
- **应当**：`queries` 为本次实际使用的检索词（LLM 失败时是原 query）。

### 错误语义

| HTTP | `detail` | 触发 |
|---|---|---|
| 400 | `请输入 1–200 个字符的学习主题。` | 空/纯空白/超 200 字 |
| 400 | `这看起来是 YouTube 链接。请直接粘贴完整链接，或换一个主题描述。` | 整段像 YouTube 链接 |
| 400 | `不支持的语言代码：xx-XX` | targetLang 非法 |
| 403 | `内容发现需要登录后使用。` | 未登录/游客 |
| 429 | 统一限速文案 + `retryAfter` / `Retry-After` | >5 次/分钟/用户 |
| 503 | `搜索服务暂时不可用（yt-dlp 失败/超时）。…` | 所有检索词搜索失败 |
| 504 | `发现服务超时（>20s）。…` | 总预算耗尽且没有可用候选 |

错误体保持 `{"detail": "中文字符串"}`，与现有前端错误展示兼容。

## 流程

1. **意图改写（LLM 1）**：要求输出 2–3 个英文检索词；去 Markdown 围栏、取首尾
   花括号、`json.loads`；字段级清洗（去引号、限长、拒绝中文/URL/`youtube`）。
   合法词 <2 个、模型不可用、超时或 JSON 非法 → 降级为原 query（`degraded`）。
2. **搜索（yt-dlp）**：每 query `ytsearchN:`（N=8），查询并发 ≤3，单 query 8s
   超时；只取 flat 元数据（id/title/channel/duration/description/
   channel_is_verified/live_status）。异常只影响该 query。
3. **归一化/过滤**：跨 query 按 `videoId` 去重；丢弃直播/预告、时长缺失、
   <90s、>90min；保留每个 query 内原始顺序，取前 10 个进入探测。
4. **字幕探测（youtube-transcript-api）**：只 `list()`，不 `fetch()`；并发 ≤4，
   单视频 2s；`language_code` 以 `en` 开头即视为有英文轨。已处理视频不发请求
   直接视为有字幕；`TranscriptsDisabled`/`NoTranscriptFound` → 无字幕并过滤；
   超时/IP 被限/视频不可用/其他异常 → unknown 并保留。
5. **重排（LLM 2）**：对 top 10 候选输出 3–5 个 picks（index/level/reason）；
   index 必须是 1..N 的唯一整数，非法项丢弃；不足 3 个用规则排序补足；LLM
   失败/无 Key → 规则排序 + 模板理由。规则只使用时长贴合、频道认证、字幕
   可用性；**播放量只作弱信号，不展示**。
6. **缓存/响应**：正常结果写 `discover_queries`，24h TTL；命中直接返回
   `cached:true`（已处理状态重算）。

### 超时与降级

| 阶段 | 单步预算 | 行为 |
|---|---:|---|
| LLM 意图 | 6s | 降级原 query |
| 单 query 搜索 | 8s | 单失败跳过；全失败 503（全超时 504） |
| 单视频字幕 | 2s | unknown 保留 |
| LLM 重排 | 8s | 规则排序 + 模板理由 |
| 整体 | 20s | 有候选返回部分（重排降级）；无候选 504 |

## 数据模型（迁移 `0010_discover`）

一张表，只存检索词与候选元数据，**不存字幕正文**：

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 自增 |
| `user_id` | TEXT NULL | 发起用户（审计；脚本/运维可空） |
| `query_hash` | TEXT NOT NULL | 规范化 query 的 sha256 |
| `query` | TEXT NOT NULL | 用户主题（去控制字符） |
| `target_lang` | TEXT NOT NULL DEFAULT `zh-CN` | 缓存键语言维度 |
| `result` | TEXT NOT NULL | 响应 JSON 文本（queries/candidates/degraded/disclaimer） |
| `created_at` | INTEGER NOT NULL | 毫秒 UTC |
| `expires_at` | INTEGER NOT NULL | 毫秒 UTC；默认 +24h |
| 约束/索引 | — | `UNIQUE(query_hash, target_lang)`、`ix_discover_queries_expires` |

- 缓存键跨用户共享；`alreadyProcessed` 不写缓存，响应时按当前用户重算。
- `force:true` 绕过读取并覆盖写。
- 只缓存「有候选且没有 query 搜索失败」的结果；空结果/全失败/部分搜索失败
  不缓存，避免把坏结果锁 24h。
- 未迁移的旧库：缓存读写降级为不命中/不写（只告警一次），发现请求仍可用。

## 边界与非目标

- **入口是独立视图**：首页输入框仍只接受链接；主题搜索从「开始学习」区的
  「搜索你想学的内容」进入 `discover` 视图。这样链接的估价流程不受主题搜索的
  加载/错误状态影响。
- **不做 YouTube Data API**：MVP 只用 yt-dlp，零额外 Key；官方 API 作为
  公网/限流时的后续备选，不在本规格。
- 不自动播放/自动选片、不下载视频/音频/字幕文件、不做字幕全文搜索、不做
  推荐流/无限滚动/个性化排序、不接移动端。
- 不保存字幕正文，不在发现阶段触发翻译/总结，不产生学习页缓存。
- 不做反爬绕过（Cookie/代理池/验证码）；yt-dlp 是非官方抓取，存在 403/429/
  失效风险，失败按 503 + 中文提示处理。
- 不做每日发现上限与 YT Data API 配额（本轮只有 5 次/分钟/用户 + 24h 缓存）。
- 难度 `level` 是可见字段的启发式估计（时长为主，LLM 可覆盖），不是测量结果；
  理由不得评价发音/口音/画面。

## 验收标准

- [x] 中文/英文 query → `queries` 至少 2 个英文检索词；LLM 非法 JSON →
      `queries` 为原 query、`degraded:true`，仍返回候选。
- [x] 候选 3–5 个且字段齐全；`videoId` 11 位；`duration` 秒；`thumbnail` 稳定
      `hqdefault.jpg`；`level` ∈ A1–C1；`reason` 中文；`hasEnglishSubs` 为
      true/null；`alreadyProcessed` 按用户历史计算。
- [x] 直播/预告、<90s、>90min、缺时长、重复 videoId 均被过滤。
- [x] 有英文字幕被过滤；探测异常/超时标 unknown 保留。
- [x] 已处理视频跳过字幕探测，`alreadyProcessed:true`。
- [x] LLM 重排非法 index/重复/越界丢弃；不足 3 个用规则补足；LLM 完全失败
      → 规则顺序 + 模板理由 + `degraded:true`。
- [x] 同 query 第二次 `cached:true`，搜索/探测/LLM 调用次数不增加；`force`
      绕过缓存重新搜索；过期缓存不复用；空结果不缓存。
- [x] 游客/未登录 403；限速第 6 次 429；参数非法 400；全部搜索失败 503；
      整体超时 504。
- [x] 迁移：空库/旧库 upgrade 建表；`downgrade 0009_placement` 只删缓存表且
      可再升级。
- [x] 全量后端测试通过（378，其中发现 26 + 迁移断言）。
- [x] 前端：首页入口 / 返回首页；提交 query 显示约 10–20 秒 loading；候选卡
      展示 3–5 个真实字段；点击候选打开估价弹窗且 URL 正确；「换一批」发送
      `force:true`；空/失败/降级有提示与重试；中越双语；375px 无横向溢出。

## 测试与实测

`backend/tests/test_discover.py`（26 个离线用例，mock yt-dlp / 字幕 / LLM）：
意图改写容错、过滤/去重、none/unknown、已处理跳过探测、重排非法 index 与
降级、缓存命中不重复搜索、跨用户缓存与 alreadyProcessed、force、过期缓存、
游客 403、限速、参数校验、搜索失败 503、超时 504、空结果不缓存。

8001 临时实例实测（`/tmp` 数据目录 + mock 外部调用）：中文 query → 3 个英文
检索词 → 4 个候选（直播/短片/无英文字幕被过滤），字段齐全；第二次
`cached:true` 且搜索调用次数保持 3；`force:true` 后搜索次数 6；游客 403；
`discover_queries` 落一行（`result` 为元数据 JSON，无字幕正文）。

## 前端实现（2026-11-15）

- 入口：首页「开始学习」区「或：搜索你想学的内容」→ App 的 `discover` 视图；
  返回键/顶栏 logo 回首页。
- 发现页：`DiscoverScreen` + `lib/discover.ts`。提交走 `POST /api/discover`，
  显示 3–5 个候选（缩略图/标题/频道/时长/A1–C1/一句理由/有英文字幕或未知/
  已学过）；「换一批」发送 `force:true`；空/失败/degraded 有中文/越文提示与
  重试。上次成功结果按 `targetLang` 存在 `sessionStorage`，返回再进仍保留。
- 选片：点击候选 → 与首页共用的 `EstimateDialog` → `GET /api/estimate-cost`
  → 现有 `ModelSelectionModal` → 确认后 `POST /api/process-video-stream`。
- 验证：`npx tsc -b`、`npm run check:i18n`（558 keys × 2）；系统 Chrome +
  Playwright mock 覆盖入口/加载/候选字段/估价 URL/「换一批」force/空错降级/
  中越/375px；截图 `/tmp/discover-shots/`（14 张）。

## 已知限制 / 下一步

1. **候选理由语言**：后端契约固定返回中文理由；越南语界面原样展示，未在前端
   二次翻译（不伪造内容）。要本地化需后端按 `targetLang` 生成。
2. **非官方搜索**：yt-dlp 没有 SLA，可能被 403/429；当前靠 24h 缓存、查询并发
   ≤3、失败不重试风暴与中文提示兜底，公网/长期运行需评估 YouTube Data API。
3. **质量依赖模型**：不确定 LLM 改写/重排对冷门主题的稳定性；规则兜底只能
   保证「不空手」，不保证推荐质量。难度估计是启发式，需用真实内容校准。
4. **单日无上限**：本轮只有每分钟限速；若公网开放，应加每日发现次数上限或
   全站预算（计划书 §6.7 的 `DISCOVERY_DAILY_LIMIT`）。
5. **缓存跨用户共享**：query 兴趣可能敏感；缓存表在本机 SQLite（gitignore 的
   `data/`），日志只记 query_hash，不记原文。
