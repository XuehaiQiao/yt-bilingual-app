# 041 — CEFR 词族表（只读，替换词形 tab）

> 状态：**已实现（2026-11-23）** ｜ 需求：负责人「词族包含 10k 外的词；无族词不显示」
> 数据依据：`docs/reports/word-family-open-audit-2026-11-23.md` 规则 E。

## 1. 构图规则（审计定稿）

- 图：WordNet 3.0 `derivationally_related_forms()` 无向边，**全量词条**（不限制 10k）
- 族：连通分量 ≥2 成员，且**至少一个成员在 CEFR 10k**；族内可含 10k 外词（等级留空）
- 仅显示这些族；无族词（the/at 等 4,767 个）**不出现**
- 质量：人工黑名单 17 条坏边（critical/crisis、judge/adjudicate 等）+ allowlist 22 条缺失边（reflect–reflection 等）
- 结果（**规则 E**，审计 §5 表 E 行）：**3,696 族 / 11,567 成员 / 10k 覆盖 5,233（52.33%）/ 10k 外成员 6,334**；最大族 18
  - 注：审计 §2.2 / §3 里的 3,694 族 / 11,563 成员 / 5,223 / 6,340 是**规则 B**（未加
    allowlist、未删黑名单）的基线；产品落地按规则 E，数字以 §5 的 E 行为准。
  - 指定族（规则 E）：`decide` 族 5 人（decide/decision/decisive/deciding/decisiveness）；
    `reflect` 族 5 人（allowlist 补 `reflection`）；`judge` 族 **7 人**（黑名单删
    `judge–adjudicate` 后 `adjudicate` 子簇不再入族；规则 B 才是 11 人）；
    `comprehend`/`large` 族 18 人含 `extend`。
- 预生成静态数据 `content/wordlist/word-families.v1.json`（含 WordNet 来源/license/
  规则版本/黑/白名单/integrity），运行时不依赖 nltk 或 WordNet 语料。
- 署名：WordNet 3.0 License（Princeton University, 2006）+ 频表 CC BY-SA 4.0，
  见 `content/wordlist/NOTICE.md`；生成脚本 `scripts/build_word_families.py`。

## 2. 后端（只读）

`GET /api/vocabulary/word-families?q=&level=&sort=rank|alpha&page=1&pageSize=50`

- 行 = 族；`q` 匹配**任一成员**（大小写不敏感，子串），返回整族
- `level`：A1/A2/B1/B2/C1；族内任一成员命中该级即返回（成员自身等级保留）
- `sort`：族 head 的 CEFR rank（默认）/ head 字母
- 响应 `{total, page, pageSize, hasMore, items:[{id, head, headRank, headLevel,
  headPhonetic, headTranslation, levels:[...], members:[{lemma, level|null, rank|null}]}]}`
  （音标/释义是 head 在 lexicon 里的只读补充字段，缺条目为 `""`，不编造）
- 游客可读、不调 AI、不写库；非法参数 400（`level` 含 C2 / `sort` / page /
  pageSize / q 长度）；数据缺失/损坏（含 integrity 失败）→ 503
- `backend/word_family.py`（加载/校验/索引/分页）；`routes_vocabulary.py` 挂路由并
  在启动时预热。旧 `GET /api/vocabulary/lemma-list`、`backend/lemma_list.py` 已删除。

## 3. 前端

- 现有「词形」tab 改为只读「**词族**」（CEFR 10k）；不再显示 lemma-list tab
- 每行：族 head / head 音标 / head 释义 / 等级集合（如 A1–C1）/ 成员数 / 展开
- 展开：成员列表（lemma + 等级，10k 外显示 `—`），同族按 rank/字母（服务端已排序）
- 搜索：任一成员命中族；筛选：CEFR 档；排序：词频/字母；服务端分页 50/页+跳页
- 只读：无星标/对勾/编辑/批量/导出；现有词表结构/数据不动
- 加载/空/错误重试；375/1440

## 4. 验收

- 静态数据：族数 3,696、成员 11,567、10k 外 6,334、10k 覆盖 5,233、最大族 18；
  黑名单 17 条 / allowlist 22 条可验证；`the/at` 不在任何族（规则 E 见 §1 注）
- API：总数、分页、q、level、非法参数；示例 decide（5 人）、reflect（+allowlist
  reflection）、judge（7 人，含 10k 外成员）、comprehend（18 人）
- 前端 tab 替换、成员等级 `—`、搜索/筛选/分页、只读无写操作；现有 tab 零回归
- `tsc/build/i18n/gate`；1440/375 截图；Playwright `scripts/word-family-acceptance.mjs`

## 5. 实现路径

- 数据：`scripts/build_word_families.py`（规则 E，可复现；`--check` 校验已提交数据）
  → `content/wordlist/word-families.v1.json`；`content/wordlist/NOTICE.md` 署名。
- 后端：`backend/word_family.py`、`backend/routes_vocabulary.py`；
  测试 `backend/tests/test_word_family.py`、`scripts/tests/test_build_word_families.py`。
- 前端：`frontend/src/components/VocabularyRows.tsx`（`WordFamilyTable` + 传输 +
  归一化）、`frontend/src/components/VocabularyBookScreen.tsx`（tab/工具栏/分页/三态）、
  `frontend/src/i18n/zh-CN.json`、`vi-VN.json`。
- 验收：`scripts/word-family-acceptance.mjs`（UI，mock 后端，75 断言）。

## 6. 非目标

- 不做收藏/掌握/编辑/批量/导出
- 不改现有词表结构/计数/写路径
- 不做词族人工编辑界面；不把 WordNet 语料随仓库分发
