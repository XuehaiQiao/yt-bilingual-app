# 041 — CEFR 词族表（只读，替换词形 tab）

> 状态：待实现 ｜ 2026-11-23 ｜ 需求：负责人「词族包含 10k 外的词；无族词不显示」
> 数据依据：`docs/reports/word-family-open-audit-2026-11-23.md` 规则 E。

## 1. 构图规则（审计定稿）

- 图：WordNet 3.0 `derivationally_related_forms()` 无向边，**全量词条**（不限制 10k）
- 族：连通分量 ≥2 成员，且**至少一个成员在 CEFR 10k**；族内可含 10k 外词（等级留空）
- 仅显示这些族；无族词（the/at 等 4,777 个）**不出现**
- 质量：人工黑名单 17 条坏边（critical/crisis、judge/adjudicate 等）+ allowlist 22 条缺失边（reflect–reflection 等）
- 结果：**3,696 族 / 11,563 成员 / 10k 覆盖 5,223（52.33%）/ 10k 外成员 6,340**；最大族 18
- 预生成静态数据 `content/wordlist/word-families.v1.json`（含 WordNet 来源/license/规则版本），运行时不依赖 nltk

## 2. 后端（只读）

`GET /api/vocabulary/word-families?q=&level=&sort=rank|alpha&page=1&pageSize=50`

- 行 = 族；`q` 匹配任一成员（大小写不敏感，子串）
- `level`：A1/A2/B1/B2/C1；族内任一成员命中该级即返回（成员自身等级保留）
- `sort`：族 head 的 CEFR rank（默认）/ head 字母
- 响应 `{total, page, pageSize, hasMore, items:[{id, head, headRank, headLevel, levels:[...], members:[{lemma,level|null,rank|null}]}]}`
- 游客可读、不调 AI、不写库；非法参数 400

## 3. 前端

- 现有「词形」tab 改为只读「**词族**」（CEFR 10k）；不再显示 lemma-list tab
- 每行：族 head / head 音标 / head 释义 / 等级集合（如 A1–C1）/ 成员数 / 展开
- 展开：成员列表（lemma + 等级，10k 外显示 `—`），同族按 rank/字母
- 搜索：任一成员命中族；筛选：CEFR 档；排序：词频/字母；服务端分页 50/页+跳页
- 只读：无星标/对勾/编辑/批量/导出；现有词表结构/数据不动
- 加载/空/错误重试；375/1440

## 4. 验收

- 静态数据：族数 3,696、成员 11,563、10k 外 6,340、最大族 18、黑名单 17 条 / allowlist 22 条可验证；`the/at` 不在任何族
- API：总数、分页、q、level、非法参数；示例 decide（5 人）、reflect（+allowlist reflection）、judge（11 人，含 10k 外）
- 前端 tab 替换、成员等级 `—`、搜索/筛选/分页、只读无写操作；现有 tab 零回归
- `tsc/build/i18n/gate`；1440/375 截图

## 5. 非目标

- 不做收藏/掌握/编辑/批量/导出
- 不改现有词表结构/计数/写路径
- 不做词族人工编辑界面
