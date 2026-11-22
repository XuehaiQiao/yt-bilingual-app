# 041 — CEFR 词族表（族行只读，成员可收藏/掌握）

> 状态：**已实现（2026-11-23；P1-07 成员释义与操作、P1-11 应用 AI 审计 23 条变更）** ｜ 需求：负责人「词族包含 10k 外的词；无族词不显示」
> 数据依据：`docs/reports/word-family-open-audit-2026-11-23.md` 规则 E + `docs/reports/word-family-ai-audit-summary-2026-11-23.md`（P1-11 应用 23 条）。

## 1. 构图规则（审计定稿）

- 图：WordNet 3.0 `derivationally_related_forms()` 无向边，**全量词条**（不限制 10k）
- 族：连通分量 ≥2 成员，且**至少一个成员在 CEFR 10k**；族内可含 10k 外词（等级留空）
- 仅显示这些族；无族词（the/at 等 4,767 个）**不出现**
- 质量：人工黑名单 17 条坏边（critical/crisis、judge/adjudicate 等）+ allowlist 22 条
  缺失边（reflect–reflection 等）+ **P1-11 应用 AI 审计 23 条高置信变更**（13 条 trim
  删 24 个成员、10 条 split 删 11 条桥边；中/低置信 11 条不应用）
- 结果（**规则 E + P1-11**）：**3,704 族 / 11,534 成员 / 10k 覆盖 5,233（52.33%）/
  10k 外成员 6,301**；最大族 14（`sense`）
  - 注：审计 §2.2 / §3 里的 3,694 族 / 11,563 成员 / 5,223 / 6,340 是**规则 B**（未加
    allowlist、未删黑名单）的基线；产品落地按规则 E + P1-11，数字以本行为准。
  - 指定族：`decide` 族 5 人（decide/decision/decisive/deciding/decisiveness）；
    `reflect` 族 5 人（allowlist 补 `reflection`）；`judge` 族 **7 人**（黑名单删
    `judge–adjudicate` 后 `adjudicate` 子簇不再入族）；`large` 族 2 人
    （large/largeness）、`extend` 族 9 人、`comprehensive` 族 7 人——P1-11 拆开原
    18 人 `large` 族（原桥接边 `comprehensive–largeness`、`extensiveness–large`）。
- 预生成静态数据 `content/wordlist/word-families.v1.json`（含 WordNet 来源/license/
  规则版本/黑/白名单/integrity），运行时不依赖 nltk 或 WordNet 语料。
- 成员释义（P1-07）：每个成员在生成时从 `content/wordlists/lexicon.v1.json` 快照
  `phonetic` / `translation`（词典缺该词时为 `""`，不编造；10k 外成员同样带这两
  字段并在有词典条目时显示释义）。生成脚本 `--check` 可复现；P1-11 后族数/成员数
  为 3,704 / 11,534，文件新增 `source.lexicon` 溯源。head 的音标/释义仍由后端按
  同一词典在运行期补充（保持既有响应字段）。
- 署名：WordNet 3.0 License（Princeton University, 2006）+ 频表 CC BY-SA 4.0，
  见 `content/wordlist/NOTICE.md`；生成脚本 `scripts/build_word_families.py`。

## 2. 后端（词族端点只读，成员写操作复用既有端点）

`GET /api/vocabulary/word-families?q=&level=&sort=rank|alpha&page=1&pageSize=50`

- 行 = 族；`q` 匹配**任一成员**（大小写不敏感，子串），返回整族
- `level`：A1/A2/B1/B2/C1；族内任一成员命中该级即返回（成员自身等级保留）
- `sort`：族 head 的 CEFR rank（默认）/ head 字母
- 分页：`page` 从 1、`pageSize` 1–200（前端提供与其他词表一致的 20/50/100，
  默认 50），响应回显 `page/pageSize/hasMore`
- 响应 `{total, page, pageSize, hasMore, items:[{id, head, headRank, headLevel,
  headPhonetic, headTranslation, levels:[...], members:[{lemma, level|null, rank|null,
  phonetic, translation}]}]}`
  （head 音标/释义是 head 在 lexicon 里的只读补充字段；成员 `phonetic/translation`
  是构建时的词典快照，两条路径缺条目均为 `""`，不编造）
- 游客可读、不调 AI、不写库；非法参数 400（`level` 含 C2 / `sort` / page /
  pageSize / q 长度）；数据缺失/损坏（含 integrity 失败）→ 503
- `backend/word_family.py`（加载/校验/索引/分页）；`routes_vocabulary.py` 挂路由并
  在启动时预热。旧 `GET /api/vocabulary/lemma-list`、`backend/lemma_list.py` 已删除。
- 成员收藏/掌握不新增写端点：复用既有 `/api/favorites` 与 `/api/review/words`
  （`source_kind='wordlist'` 词族来源，见 §3），本端点自身仍只读。

## 3. 前端

- 现有「词形」tab 改为「**词族**」（CEFR 10k）；不再显示 lemma-list tab
- 每行：族 head / head 音标 / head 释义 / 等级集合（如 A1–C1）/ 成员数 / 展开
- 展开：成员行（原词 / 音标 / 中文释义 / CEFR（10k 外 `—`）/ 星标 / 对勾），
  同族按 rank/字母（服务端已排序）；缺音标/释义的成员显示 `—`
- 族行只读：族行没有星标/对勾/编辑/批量/导出，现有词表结构/数据不动；成员
  逐词可操作（P1-07）：
  - 星标 = 收藏开关：POST/DELETE `/api/favorites`，`source_kind='wordlist'`、
    `source_ref='word-family:<familyId>'`、`source_title` 用族 head
    （`vocab.family.sourceTitle` = `词族：<head>`）；收藏快照含音标 + 中文释义
  - 对勾 = 已掌握开关：PATCH `/api/review/words` 带 `definition=translation`
    快照（无释义时快照为空、不带 `definition`）；按「已掌握与收藏互斥」不变量，
    标记已掌握会移除该词收藏
  - 失败回滚（星标/对勾回到原状态）+ 行内错误；重复点击幂等；状态与
    「我的收藏 / 已掌握」同步、tabs 计数即时更新；10k 外成员同一套操作；
    未登录走现有登录门禁（打开登录浮层，不发写请求）
- 搜索：任一成员命中族；筛选：CEFR 档；排序：词频/字母；服务端分页，分页条与
  其他词表完全一致（页码/上一页/下一页/跳页/状态文案 + 每页 20/50/100，默认 50；
  切换条数重置到第 1 页并按新 `pageSize` 重新请求；跳页越界钳制；375/1440 可用）
- 加载/空/错误重试；375/1440

## 4. 验收

- 静态数据：族数 3,704、成员 11,534、10k 外 6,301、10k 覆盖 5,233、最大族 14；
  黑名单 17 条 / allowlist 22 条可验证；P1-11 的 23 条高置信变更已应用（13 条 trim
  的 24 个成员不再出现；10 条 split 的 11 条桥边两端不同族；中/低 11 条保持原样）；
  `the/at` 不在任何族（规则 E 见 §1 注）；每个成员带 `phonetic` / `translation`
  字符串快照且与 lexicon 逐条一致（缺条目为 `""`；全库 5,892 个成员有音标 /
  5,911 个有释义），`--check` 可复现
- API：总数、分页（page/pageSize 1–200）、q、level、非法参数；示例 decide（5 人）、
  reflect（+allowlist reflection）、judge（7 人，含 10k 外成员）、large（2 人）、
  extend（9 人）、comprehensive（7 人，不含 large/extend）、sense（14 人，最大族）；
  成员字段 `{lemma, level, rank, phonetic, translation}`
- 前端 tab 替换、成员等级 `—`、搜索/筛选/分页（20/50/100 + 跳页）；族行只读
  （无星标/对勾/编辑/批量/导出），成员星标/对勾两态、POST/DELETE/PATCH 载荷、
  失败回滚 + 行内错误、幂等、计数与我的收藏/已掌握同步、10k 外无释义成员可操作、
  游客登录门禁；现有 tab 零回归
- `tsc/build/i18n/gate`；1440/375 截图；Playwright `scripts/word-family-acceptance.mjs`

## 5. 实现路径

- 数据：`scripts/build_word_families.py`（规则 E + P1-11 审计清单 + 成员音标/释义快照，可复现；
  `--check` 校验已提交数据）→ `content/wordlist/word-families.v1.json`；
  `content/wordlist/NOTICE.md` 署名。
- 后端：`backend/word_family.py`、`backend/routes_vocabulary.py`；
  测试 `backend/tests/test_word_family.py`、`scripts/tests/test_build_word_families.py`。
- 前端：`frontend/src/components/VocabularyRows.tsx`（`WordFamilyTable` + 成员行/操作 +
  传输 + 归一化）、`frontend/src/components/VocabularyBookScreen.tsx`
  （tab/工具栏/分页/三态 + 成员收藏/掌握写路径与回滚）、
  `frontend/src/i18n/zh-CN.json`、`vi-VN.json`。
- 验收：`scripts/word-family-acceptance.mjs`（UI，mock 后端，185 断言；P1-10 顶栏计数断言并入）。

## 6. 非目标

- 不做族行收藏/掌握/编辑/批量/导出（成员可逐词收藏、标已掌握，见 §3）
- 不改现有词表结构/计数/写路径
- 不做词族人工编辑界面；不把 WordNet 语料随仓库分发
