# 语途（LinguaTrek）目标架构 v0.1（草案）

> 状态：**待负责人批准** ｜ 2026-11-22 ｜ 依据：4 位专家提案（领域/契约/流程/缺陷根因）+ 4 个实测缺陷
> 批准后才产出可落地工作流（任务卡、OWNERS、CONTRACTS、flags、data-map、CI 门禁）；本文不改变任何代码。

## 0. 一句话

**按业务能力分层、契约先行、每个事实一个权威来源；阅读器/播放器/单词本只是“壳”，公共逻辑全部下沉核心层。**

目标不是重写，而是把已经存在的正确样板（`lib/nav.ts`、`ReadingSurface`）推广到其余部分，并用机器门禁阻止再次分叉。

## 1. 为什么改：4 个缺陷暴露的同一类问题

| 现象 | 根因（证据） | 违反的原则 |
|---|---|---|
| 星标与展开区都有「取消收藏」 | 同一删除动作两条路径（`VocabularyBookScreen` 行 action + 星标），各自忙态/回滚/toast | 单一事实源、一种反馈层级 |
| 已收藏词仍显示「加入我的单词」 | 行内 `mineAdds` 结果镜像凌驾于 canonical 收藏集合；已收藏时未隐藏动作 | 结果镜像 ≠ 真源 |
| 个人文章无标亮/语言点 | 分析缓存是 v4，v5 未回填；服务端配额 374/30 拒绝生成，`attach_to_payload` 静默跳过；标亮层（classify）本身正常 | 失败当空态、版本升级无回填策略 |
| 视频页 12 / 阅读页 15 | 「我的单词」被写成 `favorites − mastered` 运行时公式；阅读页直接取 favorites 长度；存量 3 条 mastered 仍在收藏 | 用公式掩盖数据缺陷、每个壳各算一份 |

结论：不是 agent 能力问题，是**边界、契约、事实源、门禁**缺失。多 agent 并行只是把缺失放大。

## 2. 分层与依赖方向

```
适配层 shells/         video · article · library · book · imported
      ↓  只许向下
领域层 domains/        ingest · reading · vocabulary · review · billing · report
      ↓
核心层 core/           PlaybackCore · ReadingSurface/ReadingChrome · Repository/transport
      ↓                 Flags/Settings · ContentRef · error taxonomy
平台层 platform/       api transport · i18n · auth · nav（已有，保留）
```

**硬规则（CI 强制，不靠评审提醒）**

1. 只许向下依赖：`shells → domains → core → platform`；禁止反向、禁止平级。
2. 壳与壳之间零 import；共享一律上移核心。
3. `core/**` 不得 import `domains/**` 或 `components/**`；`domains/**` 不含 JSX。
4. 目录即边界：前端目标目录 `src/{core,domains,shells,platform}`；用 dependency-cruiser / ESLint `import/no-restricted-paths` 阻断。
5. 后端目标：`routes_*.py` 只做 HTTP 校验与映射 → `domains/services` → `repositories`；禁止路由直接读写共享文件/共享表。

迁移期允许旧路径存在，但**新增文件必须落在目标层**，且“旧→新”的 import 只能从壳指向新核心。

## 3. 领域模块（按业务能力，不按 agent 划分）

| 模块 | 拥有的状态/策略 | 对外接口（草图） |
|---|---|---|
| ingest | URL/EPUB 导入、估价、处理作业、SSE 恢复 | `useIngestJob()`、`resolveContent(input)` |
| reading | `ReadingScope`（文章/书/导入书/免费库）、章节、翻译态、进度、分析需求 | `useReadingScope(ref)`、`useAnalysis(ref)` |
| vocabulary | **我的单词（收藏）**、**已掌握**、自定义词表、行操作命令 | `useMyWords()`、`selectMyWordCount()`、`markMastered()` |
| review | 队列/统计/作答/暂停 + UI 开关 | `useReview()`, flag `ff.review.ui` |
| billing | 余额、报价、402/403/429 分类 | `useBalance()`、`classifyAiFailure()` |
| report | 周报、事件、事实数字 | `useWeekReport()` |

复习（review）当前 UI 暂停，但领域与数据保留；独立背单词功能未来直接复用该域，不再复制。

## 4. 公共核心

| 核心件 | 职责 | 替换现状 |
|---|---|---|
| `PlaybackCore` | 唯一播放状态机：position/playing/rate/loop + play/pause/seek；transport = video/local/tts | App 命令 props、`VideoPlayer` 自持 isPlaying、5 处 `useReadingAudio` |
| `ReadingSurface` + `ReadingChrome` | 段落渲染、标亮、ruby、语言点、点词、当前句高亮、双栏；`ReadingScope` 由壳提供 | 四个阅读器壳（阶段 1/2 已完成共享渲染，本次补齐 chrome/scope） |
| `Repository` / `transport` | 每域一个数据访问口：`targetLang` 注入、abort、错误分类（402/403/429/503）、乐观更新唯一位置 | 20+ 组件直接 fetch、App/屏内双写收藏 |
| `Flags` | `ff.<域>.<特性>` 注册表 + `useFlag()`；禁止本地常量 | `REVIEW_UI_ENABLED`、`SHOW_COURSE_GENERATION` 等 4 种机制 |
| `ContentRef` | 规范化 `{kind,id,chapter?,lang?}`；唯一字符串格式 `kind:...` | 视频裸 id、`article:`/`book:`/`library:` 混用 |

## 5. 适配层规范

壳只做三件事：**取数 → 填页面 chrome → 组 ReadingShell**。

```ts
type ContentRef = { kind: 'video'|'article'|'library'|'book'|'imported'; id: string; chapter?: number };
interface ReadingAdapter {
  kind: ContentRef['kind'];
  load(ref: ContentRef, signal: AbortSignal): Promise<ReadingScope>;
  chrome(scope: ReadingScope): ReadingChromeVM;      // 标题/来源/返回/空错态
  testIds: { prefix: string; translationPrefix?: string }; // 兼容既有验收脚本
}
```

**禁止**：壳内写段落 JSX、句内高亮、翻译列、收藏计数、掌握写入、分析取数策略、播放状态机、手拼 testid。
**尺寸门禁**：单壳 ≤200 行；出现 `fetch`、`filter(type==='vocabulary')`、直调 `useReadingAudio`、≥10 个 `useState` → Reviewer 直接拒。

## 6. 单一事实源（SSOT，本文最关键部分）

**「我的单词」= 词汇收藏列表本身；计数 = 该列表长度。禁止任何 `favorites − mastered` 减法或读时过滤。**

| 事实 | 权威存储 | 唯一写入口 | 唯一读路径 |
|---|---|---|---|
| 我的单词 | `favorites.json`（type=vocabulary） | `vocabulary.addWord/removeWord`（乐观/回滚只此一处） | `selectMyWords(favorites)`；计数=`.length`；导出也用同一列表 |
| 已掌握 | `word_states.mastered=1` | `vocabulary.markMastered/unmarkMastered`（未来服务端同事务删收藏） | `useMastered()`；计数=`words.length`；不读收藏 |
| 互斥不变量 | 写路径 | `mastered ∩ 我的单词 = ∅`；撤销不回填收藏 | 只读巡检脚本报警，不在读路径扣减 |
| 分析缓存 | `content_teaching_analysis` | 后端 `ensure_analysis`（唯一） | `/api/teaching-analysis` + payload 合并；版本升级必须“回填或可重试”，不能静默空 |
| 配额/余额 | `ai_usage` / `ai_quota` / `billing` | 各自服务；**上限只取 config**，DB 仅审计快照 | 读侧统一 `quota.snapshot()`；运维预热用 `ops:`/sponsored 身份，不占用户配额 |
| 播放器状态 | `PlaybackCore` | controller actions | `usePlayback()` 快照 |
| 开关 | `CONTRACTS/flags.yaml` + `/api/flags` | Flags SDK | `useFlag()`；后端关闭态 403 `feature_disabled` |
| 路由 | `lib/nav.ts` + `useNav`（已达标） | `open/back/replace` | 保持，作为其余 SSOT 的样板 |

**存量数据修复**：现有 3 条「已掌握却仍在收藏」（Affordability / intimately / thorny）属于数据缺陷。用一次性脚本 `reconcile`：dry-run 清单 → 备份 + 审计 JSONL → 逐条删除收藏（走 Repository/锁）→ 验收重叠=0；**不碰 `word_states`**，提供回滚。禁止在代码里继续用减法掩盖。

## 7. 契约（CONTRACTS，只读）

```
CONTRACTS/
  api/openapi.yaml            # 端点快照（CI diff 必须有人审）
  schemas/word.json           # 词形（camelCase，含 definition 快照）
  schemas/analysis.v5.json    # 分析 payload（外层 camelCase，内层 en_word/zh_word/color 冻结）
  schemas/error.json          # 403/402/429/503/409 错误码
  flags.yaml                  # FF 注册表（唯一默认值来源）
  CHANGELOG.md
```

规则：契约只读；修改必须 RFC/ADR + 版本号 + 全消费方 grep 清单 + 契约测试同 PR。后端新端点必须 `response_model`（或等价 schema），前端共享类型从契约生成或至少由 schema 校验；禁止 62 个手写类型继续膨胀。

## 8. Feature Flag 规范

- 命名 `ff.<域>.<特性>`，如 `ff.review.ui`；唯一默认值在 `flags.yaml`。
- 必填：Owner、创建日、失效日、移除 PR；到期未删 → CI 报红。
- 读取只能 `useFlag()`（前端）/`flags.is_enabled()`（后端）；**禁止新增本地布尔常量**。
- 生命周期：proposed → on(gray) → on(all) → off → removed；变更写 `admin_audit_log`。
- 当前 `REVIEW_UI_ENABLED` 迁到 `ff.review.ui`，后端关闭时统一 403，不再只靠前端不渲染。

## 9. 所有权与写域

| 资产 | Owner | 审批 | 覆盖路径 |
|---|---|---|---|
| 词汇（收藏/已掌握/词表） | vocabulary-owner | Architect | `frontend/src/domains/vocabulary/**`、`backend/wordlists.py`、`srs.py` 相关 |
| 阅读与分析 | reading-owner | Architect | `frontend/src/core/reading/**`、`backend/teaching_analysis.py`、`routes_reading.py` |
| 契约与 Flag | contract-owner | 负责人 | `CONTRACTS/**`、`docs/flags.md`、`docs/data-map.md` |
| 共享文件 | **仅 Integrator** | 负责人 | `App.tsx`、`i18n/*.json`、`package*.json`、`components/ui/**`、`lib/nav*`、`backend/migrations/**`、`scripts/gate-receipt.mjs` |

- 任务卡必须写**可写文件白名单**、只读上下文、验收命令；白名单外 1 行即失败。
- 禁止两个 agent 同时改同一文件：preflight 扫活跃卡 scope 交集 → 拒绝 claim；共享文件只由 Integrator 合入。
- 一卡一 worktree/branch；证据绑 `HEAD <sha7>`；rebase 后证据作废重跑。

## 10. 多 agent 工作流（批准后细化成独立文档）

角色：Architect/Planner（卡/契约/ADR，不写码）、Implementer（白名单内实现）、Reviewer（独立、不可自审）、Tester（先红后绿）、Integrator（唯一共享文件写者/串行合并）、Scribe（spec/ADR/度量）。

通信只走四个通道：**任务卡、契约、PR（diff+证据）、handoff 记忆**；禁止长对话同步。详细 schema、DAG、门禁命令与试点在批准后产出。

## 11. 迁移路线（先修数据与计数，再拆结构）

| 阶段 | 动作 | 验收 |
|---|---|---|
| P0-a | 单一 selector：`selectMyWords()`；删 App/词书/阅读按钮/导出的减法与 mastered 过滤；已掌握计数=服务端列表长度 | 顶栏=侧栏=词书=阅读按钮=导出；grep 无 `mastered` 参与计数 |
| P0-b | 写路径原子化：标已掌握同请求删收藏（服务端），失败整体失败；前端只发一次命令 | 掌握后收藏不含该词；撤销不回填；并发幂等 |
| P0-c | `reconcile` 存量 3 条重叠：dry-run→备份/审计→apply→重叠=0；提供回滚 | 两页同时显示 12；favorites ∩ mastered = ∅ |
| P0-d | 修复重复入口：mine 行删除只保留星标；已收藏时「加入我的单词」不渲染；删结果镜像 | 每行只有一个取消入口；已收藏词无加入动作 |
| P0-e | 分析：v5 回填/可重试错误态；配额上限单源；预热用 ops 身份；个人文章打开可生成 | 文章出现 ruby/语言点；失败显示重试而非空 |
| P1 | ReadingChrome/ReadingScope；四个壳 ≤200 行；单词本 8 类列表一个 ListSource；Repository 收口 | 壳边界 lint 绿；行为一致 |
| P2 | PlaybackCore 接管视频/阅读条/本地剧集；App 巨型 state 拆域 store | 播放状态单源；App 行数下降 |
| P3 | billing/report 域；契约/flag 收口；旧代码删除 | 无重复实现；门禁全绿 |

风险：删收藏是写操作 → 备份/审计/回滚；testid 是验收契约 → adapter 原样保留；迁移期禁止双渲染两套实现；`App.tsx` 是热点 → 只由 Integrator 改。

## 12. 验收标准（架构是否落地）

- 每个事实只有一个写入口（grep + 契约测试可证），计数路径不含 mastered 过滤/减法。
- `favorites ∩ mastered = ∅`；两页计数一致；取消收藏只有星标一个入口；已收藏词无「加入我的单词」。
- 个人文章：分析可用；失败/配额有可见、可重试提示，不再“静默空态”。
- 壳 ≤200 行、无段落 JSX、无 fetch、无计数；边界 lint + 契约测试 + flag lint 在 CI 强制。
- 四个阅读器、两个词表入口行为一致；`tsc/build/pytest/i18n/gate` 全绿且证据绑 HEAD。

## 13. 待批准的决定

1. **我的单词 = favorites 列表，计数=长度；已掌握独立列表；运行时禁止减法**；存量 3 条 overlap 用一次性 reconcile 修数据（先 dry-run 再 apply，可回滚）。
2. **写路径服务端原子化**：标已掌握同请求删收藏；撤销不回填。
3. **配额/计费单源**：上限只取 config；DB 行快照仅审计；预热脚本用 ops/sponsored 身份，不占用户额度；分析失败必须可重试可见。
4. **契约先行**：`CONTRACTS/` + OpenAPI/schema 快照 + 契约测试；契约改动走 RFC/ADR。
5. **目录与边界**：`src/{core,domains,shells,platform}`，只许向下依赖，依赖 lint 进 CI。
6. **开关统一**：`flags.yaml` + `ff.*` + `/api/flags`；`REVIEW_UI_ENABLED` 迁移，禁止本地常量。
7. **多 agent 工作流**：任务卡（写域白名单）+ 独立 Reviewer + Integrator 共享文件 + preflight/证据 SHA 门禁；批准本文后产出详细工作流文档。

---

**下一步**：负责人批准本草案 → 产出 `docs/多agent协作工作流.md`、`OWNERS.md`、`CONTRACTS/` 骨架、`docs/flags.md`、`docs/data-map.md`，并按 §11 P0 拆出第一批任务卡（4 个 bug 作为试点）。
