# 041 — CEFR 词族表（族行只读，成员可收藏/掌握）

> 状态：**已实现（2026-11-23；P1-07 成员释义与操作、P1-11 应用 AI 审计 23 条变更、P1-12 成员音标/释义补全、P1-13 折叠行/词性分组手风琴重设计、P1-14 AI 补全剩余 115 条释义）** ｜ 需求：负责人「词族包含 10k 外的词；无族词不显示」
> 数据依据：`docs/reports/word-family-open-audit-2026-11-23.md` 规则 E + `docs/reports/word-family-ai-audit-summary-2026-11-23.md`（P1-11 应用 23 条）+ `docs/reports/word-family-member-data-2026-11-23.md`（P1-12 成员字段覆盖）+ `docs/reports/word-family-ai-translations-2026-11-23.md`（P1-14 AI 释义）。

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
- 成员词性（P1-13）：每个成员在生成时写入 `pos`——该 lemma 在 WordNet 3.0
  **全部 synset** 的 POS 集合，按 `n/v/a/s/r` 规范顺序去重；没有任何 synset 的
  lemma 写 `[]`（不编造）。`s`（satellite adjective）与 `a` 在展示上同归形容词。
  POS 只用于折叠行徽章与展开区分组，**不参与构图**，族数/成员数不变。生成时
  查 11,534 个词、全部命中（`counts.membersWithPos` = 11,534，
  `membersWithoutPos` = 0）；`--check` 可复现。
- 成员释义（P1-07 / P1-12 / P1-14）：每个成员在生成时快照 `phonetic` /
  `translation`：先取 `content/wordlists/lexicon.v1.json`，缺项用本地 ECDICT
  （`data/ecdict.db`，`mode=ro&immutable=1` 只读打开、批量 `IN` 查询、只查缺失词）
  补；`translation` 仍缺的 115 个成员（demonym/专名派生为主）用 **AI 生成的静态
  override** `content/wordlist/ai-member-translations.v1.json` 补（`source=ai-generated`、
  `reviewed=false`、未人工复核）。AI 只补释义、**不补音标**，且仅当 lexicon 与
  ECDICT 都为空才填，已有值不覆盖；仍未命中留 `""`，不编造。10k 外成员同样带这两
  字段。归一化与 lexicon 同口径（首个含中文行、≤120 字符）。P1-14 后覆盖率：
  音标 10,466/11,534（不变）、释义 11,534/11,534（AI 补 115）；数据新增
  `source.lexicon` / `source.ecdict` / `source.aiTranslations` 溯源，`--check`
  可复现。head 的音标/释义仍由后端按同一词典在运行期补充（保持既有响应字段）。
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
  pos:[...], phonetic, translation}]}]}`
  （head 音标/释义是 head 在 lexicon 里的只读补充字段；成员 `phonetic/translation`
  是构建时的词典快照（lexicon 优先、缺项 ECDICT、释义仍缺用 AI override；
  AI 标记 `reviewed=false`），两边都缺为 `""`，不编造；成员 `pos` 是
  `n/v/a/s/r` 的规范顺序数组，旧数据缺失时下发 `[]`，非法字符 → 503）
- 游客可读、不调 AI、不写库；非法参数 400（`level` 含 C2 / `sort` / page /
  pageSize / q 长度）；数据缺失/损坏（含 integrity 失败）→ 503
- `backend/word_family.py`（加载/校验/索引/分页）；`routes_vocabulary.py` 挂路由并
  在启动时预热。旧 `GET /api/vocabulary/lemma-list`、`backend/lemma_list.py` 已删除。
- 成员收藏/掌握不新增写端点：复用既有 `/api/favorites` 与 `/api/review/words`
  （`source_kind='wordlist'` 词族来源，见 §3），本端点自身仍只读。

## 3. 前端

- 现有「词形」tab 改为「**词族**」（CEFR 10k）；不再显示 lemma-list tab
- **默认折叠行**（P1-13）：`head / 音标 / 中文释义 / CEFR / POS 徽章 / N 词 /
  → 派生词预览`。POS 徽章按 `v·n·adj·adv` 展示族内出现的词性（`a`+`s` 合并为
  `adj`）；预览取 head 之后按 rank 的前 2 个成员，其余以 `+N` 计数；无音标/
  释义/词性一律显示 `—`，不显示默认值
- **手风琴**（P1-13）：同一时刻只允许一个族展开；展开另一个族自动收起前一个；
  点击已展开的族收起；展开状态只在本页内存中，**不写 URL/history**
- **展开区按词性分组**（P1-13）：动词 / 名词 / 形容词 / 副词 / 其他（空组不
  渲染，顺序固定）；一个多词性成员只进一个组（优先 v → n → a/s → r → 其他）；
  组内主词置顶，其余按 CEFR rank（10k 外最后）、再按字母；每组标题带成员数
- 展开：成员行（原词 / 音标 / 中文释义 / CEFR（10k 外 `—`）/ 星标 / 对勾）；
  缺音标/释义的成员显示 `—`（P1-07 行为保留）
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
  字符串快照：lexicon 非空值逐条保留，缺项为 ECDICT 值、AI override 值或 `""`
  （不编造；全库 10,466 个成员有音标 / 11,534 个有释义，仍缺 1,068 / 0；AI 补
  115 条且 `reviewed=false`），`--check` 可复现；
  每个成员带 `pos`（n/v/a/s/r 去重排序；11,534 个成员全部可解析、0 个为空），
  `decide` 族为 decide `[v]` / decision `[n]` / decisive `[a,s]` /
  deciding `[n,v,s]` / decisiveness `[n]`，`large` 为 `[n,a,s,r]`
- API：总数、分页（page/pageSize 1–200）、q、level、非法参数；示例 decide（5 人）、
  reflect（+allowlist reflection）、judge（7 人，含 10k 外成员）、large（2 人）、
  extend（9 人）、comprehensive（7 人，不含 large/extend）、sense（14 人，最大族）；
  成员字段 `{lemma, level, rank, phonetic, translation}`
- 前端 tab 替换、成员等级 `—`、搜索/筛选/分页（20/50/100 + 跳页）；族行只读
  （无星标/对勾/编辑/批量/导出），成员星标/对勾两态、POST/DELETE/PATCH 载荷、
  失败回滚 + 行内错误、幂等、计数与我的收藏/已掌握同步、10k 外无释义成员可操作、
  游客登录门禁；现有 tab 零回归
- P1-13 折叠行/手风琴/分组：折叠行结构（head/音标/释义/CEFR/POS/N 词/预览 2 个
  + `+N`）、POS 徽章（`v·n`、`v·n·adj`）、无值 `—`；手风琴单开（展开另一个自动
  收起、再点收起、URL 不变、同一时刻只有 1 个展开区）；展开区组顺序与组内成员
  （动词/名词/形容词；主词置顶、rank 排序、成员不重复渲染）；375/1440 均无横向
  溢出；`scripts/word-family-acceptance.mjs` 217 断言
- `tsc/build/i18n/gate`；1440/375 截图；Playwright `scripts/word-family-acceptance.mjs`

## 5. 实现路径

- 数据：`scripts/build_word_families.py`（规则 E + P1-11 审计清单 + 成员音标/释义
  快照：lexicon 优先、缺项回退本地 ECDICT、释义仍缺用 AI 静态 override；可复现，
  `--check` 校验已提交数据）→
  `content/wordlist/word-families.v1.json`；
  `content/wordlist/ai-member-translations.v1.json`（AI 释义 override）；
  `content/wordlist/NOTICE.md` 署名；报告
  `docs/reports/word-family-member-data-2026-11-23.md` 与
  `docs/reports/word-family-ai-translations-2026-11-23.md`。
- 后端：`backend/word_family.py`、`backend/routes_vocabulary.py`；
  测试 `backend/tests/test_word_family.py`、`scripts/tests/test_build_word_families.py`。
- 前端：`frontend/src/components/VocabularyRows.tsx`（`WordFamilyTable` + 成员行/操作 +
  传输 + 归一化）、`frontend/src/components/VocabularyBookScreen.tsx`
  （tab/工具栏/分页/三态 + 成员收藏/掌握写路径与回滚）、
  `frontend/src/i18n/zh-CN.json`、`vi-VN.json`。
- 验收：`scripts/word-family-acceptance.mjs`（UI，mock 后端，217 断言；P1-10
  顶栏计数、P1-13 折叠行/手风琴/词性分组断言并入）。

## 6. 非目标

- 不做族行收藏/掌握/编辑/批量/导出（成员可逐词收藏、标已掌握，见 §3）
- 不改现有词表结构/计数/写路径；不做按 POS 筛选、不把展开状态写进 URL/深链
- 不做词族人工编辑界面；不把 WordNet 语料随仓库分发
- 不补成员音标（P1-14 的 AI override 只补释义）；不在运行期调用 AI 生成释义
  （只读构建时生成的静态 override）
