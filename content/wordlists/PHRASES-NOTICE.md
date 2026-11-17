# NOTICE — 单词本「短语」词表（`content/wordlists/phrases.v1.json`）

本文件说明短语词表的**来源、许可与口径**。词表随仓库分发，运行期由
[`backend/vocabulary.py`](../../backend/vocabulary.py) 只读加载，无数据库、
无迁移。**本文件不是法律意见**；对外分发/商用前请自行复核上游数据授权。

## 1. 产物

| 文件 | 内容 | 规模 |
|---|---|---|
| `curated-phrases.v1.json` | 人工精选基线：短语动词 / 习语 / 固定搭配，含中文释义、自写例句、CEFR、notes | 200 条 |
| `curated-phrases-extra.v1.json` | 补充批次（理由见 §3），结构与基线相同 | 370 条 |
| `phrases.v1.json` | 合并产物（运行期读取）：`entries` + `counts` + `integrity` | 570 条 |
| `PHRASES-NOTICE.md` | 本文件 | — |

`phrases.v1.json` 的每条：

```json
{
  "id": "look-after",
  "headword": "look after",
  "type": "phrasal_verb",       // phrasal_verb | idiom | collocation
  "cefr": "A2",                 // A2 / B1 / B2 / C1 / C1+（近似）
  "translation": "照顾；照料",
  "example": "She looks after her younger brother after school.",
  "source": "curated",          // ECDICT | curated
  "license": "LinguaTrek 原创整理",
  "notes": "非字面义；不要按 look + after 直译。"
}
```

ECDICT 来源的条目另保留 `tagMask`（cet4=1 / cet6=2 / gre=4）与 `rank`
（`frq` 缺失回退 `bnc`，再缺省 999999）。**本批 ECDICT 条目为 0 条**，
原因见 §2。

## 2. ECDICT 多词 tag：实际覆盖为 0（诚实记录）

- 快照：`ecdict.csv@master`（2026-11-17 抓取），770,611 行；
  SHA-256 `d1ecbdf9ee2b920afb6f430ca6b6bb9f559588cf0dff86e04bd255f9390843cc`。
- 多词条目（`word` 含空格）：**366,599** 条。
- 其中 2–4 词、纯字母/空格、全小写：**280,595** 条
  （其中含中文释义 280,323 条）。
- 其中 **带 cet4 / cet6 / gre 任一 tag 的：0 条**。
  整个 CSV 里带任何 tag 的多词条目只有 6 条（`account for`/`bring about`/
  `in spite of`/`per capita`/`space shuttle` 为 toefl/ielts；`ice cream`
  为 zk），都不在 CET4/CET6/GRE 位掩码内。
- 因此 A 路径（ECDICT 多词 tag）在本快照上的实际产出为 0；短语行的
  `frq`/`bnc` 也全部为 0，无法按频次排序。**本词表没有用无 tag 词频硬凑
  数量**。

构建脚本仍完整实现并测试了 A 路径（2–4 词、纯字母/空格、含中文释义、
`tagMask≠0`、去重 `sb./sth.` 尾部变体、保留 tagMask/rank；mock CSV 测试
见 `backend/tests/test_phrases_build.py`）。若上游将来给多词条目补 tag，
重跑脚本即可自动并入，精选条目按 headword 优先去重。

## 3. 精选条目：为什么是 570 条而不是 150–200 条

产品目标为 **500–800 条** A2–C1 教学短语。原计划 = ECDICT 多词 tag（300–500）
+ 人工精选 150–200。由于 §2 的 tag 覆盖为 0，若严格只做 150–200 条精选，
总量会落在 150–200，达不到 500–800 的目标。处理方式：

1. 保留 `curated-phrases.v1.json` 的 **200 条基线**（150–200 区间上界）；
2. 新增 `curated-phrases-extra.v1.json` **370 条补充批次**，使合并后总量
   **570 条**（500–800 区间内）；
3. 所有精选条目（含补充批次）的释义、例句、CEFR、类型、notes 均由
   **语途自写/人工标注**，许可「**LinguaTrek 原创整理**」，不使用受版权
   保护的词典例句；
4. **不**把 ECDICT 无 tag 的 280k 多词条目按词频塞进词表；补充批次是
   人工选目，不是频次填充。

补充批次是**在 A 无法供货时的显式取舍**，报告
[`docs/reports/phrases-build-2026-11-17.json`](../../docs/reports/phrases-build-2026-11-17.json)
如实记录 `ecdict: 0` 与 `curated: 570`。若后续改用授权短语表（Oxford
Phrase List / OPAL 等），应替换补充批次并重跑构建/抽检。

## 4. 许可

| 部分 | 许可/口径 |
|---|---|
| `curated-phrases*.v1.json` 的选目、中文释义、英文例句、CEFR、notes | **LinguaTrek 原创整理** |
| ECDICT 的 tag / 中文释义（若 A 路径产出条目） | 见 `content/wordlists/NOTICE.md` §1；ECDICT 仓库代码 MIT，词典数据多来源、授权状况不一 |
| ECDICT 原始 CSV | **不随仓库分发**（约 66MB，构建时下载到 `/tmp`） |

例句均为语途自写，未复制词典/教材/网页例句。CEFR 为**近似教学标注**，
不是官方 CEFR 短语表。

## 5. CEFR 口径（近似，不是官方）

没有官方 CEFR 短语表。本词表的 `cefr`：

- `curated`：按教学难度人工标注，取值范围 A2–C1（C1+ 保留给超出 C1/未知，
  本批未使用；**不硬凑 C2**）；
- `ECDICT`（若将来有）：组成词在 `frequency_bands.v1.json` 中的最高 CEFR，
  A1 抬到 A2，任一内容词不在频表 → `C1+`；
- API 的 `level=C1+` 表示 **C1 及以上**；C2 未建模，不提供。

页面/API 必须标「A2–C1 近似，非官方 CEFR 短语表」，不得宣称官方等级。

## 6. 质量闸

- 构建期自动校验：2–4 词、纯字母/撇号、ID 唯一、type/CEFR 合法、
  中文释义、精选例句非空、`counts` 与 `entries` 一致、`integrity.sha256`；
- **100 条抽检**：按词表顺序等距抽样，逐条核对「释义 / 例句 / CEFR /
  是否非字面义」，清单见报告 `qualityGate` 与 `checklist`；
- 禁用词/专名/数字过滤：ECDICT 路径自动过滤；精选条目人工复核无冒犯、
  无过时内容；
- 失败口径：任一抽检项不过 → 构建/交付前返工，不静默通过。

## 7. 重建与校验

```bash
# 下载官方 CSV 到 /tmp（不要放进仓库）
curl -L -o /tmp/ecdict-full.csv \
  https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv

# 重建 phrases.v1.json + 质量报告
backend/venv/bin/python scripts/build_phrases.py \
  --ecdict-csv /tmp/ecdict-full.csv

# 离线校验（结构/完整性/精选/规模/无 CSV）
backend/venv/bin/python scripts/build_phrases.py --check
```

## 8. 已知局限

- ECDICT 短语级 tag 覆盖 0，A 实际无产出；570 条全部来自精选批次。
- ECDICT 无短语例句；将来若 A 有产出，`example` 为空，界面需按空例句处理。
- CEFR 是几档粗略标注，不保证与任何考试大纲一一对应；不同教师可能
  给同一短语不同档位。
- `id` 由 headword 派生（小写化、撇号去除、空格转连字符）；headword 改名
  会改变 id，旧收藏需要迁移。
- 词表规模 570，距 800 上限仍有空间；新增条目需继续走 100 条抽检。

## 9. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| `2026.11.17` | 2026-11-17 | 首版：ECDICT 多词 tag 实测 0 条；精选基线 200 + 补充 370 = 570 条（A2 107 / B1 176 / B2 221 / C1 66；短语动词 302 / 习语 203 / 固定搭配 65）；API 分页/搜索/等级/类型/详情；100 条抽检。 |
