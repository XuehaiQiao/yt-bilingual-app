# 040 — CEFR 10k 词形表（只读）

> 状态：**待实现** ｜ 2026-11-23 ｜ 需求来源：负责人「不变更现有词表结构，新增一个 lemma 词表（CEFR 10000）」
> 一句话：基于已有静态数据新增一个**只读**「词形」tab，把 CEFR 10k 按 lemma 展示并列出词形；现有词表结构/数据完全不动。

## 1. 数据源（已存在，不新建词表/不迁移）

- `content/wordlist/frequency_bands.v1.json`：`entries`（10,000 个 `[lemma, rank]`）、`forms`（10,848 个 `form → lemma`）、`cefr_anchors`（≤1000 A1、≤2000 A2、≤4000 B1、≤7000 B2、≤10000 C1）
- `content/wordlists/lexicon.v1.json`：`entries[word] = [phonetic, translation]`（补音标/中文释义）
- 该数据本身已是 lemma 口径；**不再用 ECDICT 二次推断**，避免错标/歧义。

## 2. 后端（只读）

`GET /api/vocabulary/lemma-list?q=&level=&sort=rank|alpha&page=1&pageSize=50`

- `q`：匹配 lemma 或任一词形（大小写不敏感，子串）；命中词形时返回其 lemma
- `level`：`A1/A2/B1/B2/C1`（无 C2）；非法 400
- `sort`：`rank`（默认，频次升序）/ `alpha`
- `pageSize` 1–200；响应 `{total, page, pageSize, hasMore, items:[{lemma,rank,level,phonetic,translation,forms:[form…]}]}`
- 启动时从两个 JSON 建内存索引并缓存；游客可用、不调 AI、不写库。
- 空/缺翻译：`translation` 为 `""`、`phonetic` 为 `""`，不编造。

## 3. 前端

- 单词本新增 tab「**词形**」（副标 CEFR 10k），位置在 CET6 之后；**只读**：无星标/对勾/编辑/批量/导出。
- 行：lemma / 音标 / 中文释义 / CEFR 徽章 / 词形数 / 展开；展开列出全部 forms。
- 工具栏：搜索（匹配 lemma 或词形）、排序（词频/字母）、筛选（CEFR 档）；服务端分页 50/页，页码/跳页。
- 加载/空/错误重试三态；375/1440；中越文案对齐。
- 现有 tab（我的收藏/已掌握/CEFR/GRE/CET4/CET6/短语/自定义）结构、计数、写操作完全不变。

## 4. 验收

- [ ] 总数 10,000；A1/A2/B1/B2/C1 = 1000/1000/2000/3000/3000。
- [ ] 搜 `running` 命中 `run`；搜 `abandoned` 命中 `abandon`；搜 lemma 正常。
- [ ] level 筛选边界正确；非法 level 400；pageSize 上限 200。
- [ ] 词形数 = forms 映射数量；展开与搜索一致。
- [ ] 现有词表 tab/操作/验收脚本零回归。
- [ ] 游客可读；无 AI 调用；`tsc/build/i18n/gate` 绿；1440/375 截图。

## 5. 非目标

- 不做收藏/掌握/编辑/批量/导出（只读）
- 不改现有词表结构、不迁移、不写用户数据
- 不做 ECDICT 推断或全量词典浏览
