# 词族成员音标/释义补全（P1-12）

- 日期：2026-11-23
- 任务卡：`TASKS/P1-12-family-member-data.md`（implementer=`family-data-impl`，reviewer/integrator=`lead`，卡 `base_sha: 8739f76`）
- 证据绑定：**HEAD `1ec1f33`**（P1-11 已合入；卡上的 8739f76 早于 P1-11，按实际 HEAD 记录）；未 commit
- 脚本：`scripts/build_word_families.py`（新增本地 ECDICT 只读补全；不调用任何模型）
- 单测：`scripts/tests/test_build_word_families.py`（26 例，其中新增 11 例覆盖本任务）

## 1. 结论

本地 `data/ecdict.db` 把词族成员的**释义覆盖率从 51.3% 提到 99.0%**、
音标覆盖率从 51.1% 提到 90.7%；11,534 个成员里 1,074 个仍缺至少一项，
其中 109 个两项都缺。族数/成员数不变（3,704 / 11,534）。

| 指标 | 补全前 | 补全后 | 覆盖率（后） |
|---|---:|---:|---:|
| 总成员 | 11,534 | 11,534 | — |
| 有音标 | 5,892 | **10,466** | 90.7% |
| 有释义 | 5,911 | **11,419** | 99.0% |
| 缺任一 | 5,642 | **1,074** | 9.3%（仍缺） |
| 两项都缺 | 5,623 | **109** | 0.9%（仍缺） |

- ECDICT 实际查询 5,642 词（lexicon 缺音标或释义的成员，去重后），命中 5,533 行。
- 新增补全：音标 4,574 个、释义 5,508 个（逐字段补，不覆盖 lexicon 已有值）。
- 卡里「预计可补 5,500+ / 剩余约 100」按**释义**口径达成（仍缺 115）；
  音标另有 1,068 缺口，主要因为 ECDICT 对大量派生词（willingness、using 等）
  只给释义、不给音标，不是本次补全逻辑漏查（见 §3.2）。

## 2. 合并口径

1. 每个成员两个字段独立合并：`phonetic`、`translation` 分开判断。
2. `lexicon.v1.json` 已有非空值 → **原样保留**（逐字节不改；含音标有、释义空的
   部分条目）。
3. lexicon 缺该项 → 查本地 ECDICT `stardict(word, phonetic, translation)`：
   - 只读打开：`file:<absolute>?mode=ro&immutable=1`，不建表、不写库、不联网；
   - 批量 `SELECT ... WHERE word IN (?, …)`，每批 900 词（避开 SQLite 999 变量上限）；
   - 只查「lexicon 缺音标或释义」的成员，不全量扫库；
   - 归一化与 `lexicon.v1.json` 同口径（复用 `build_word_lists.clean_*`）：
     音标压缩空白；释义取第一个含中文的行、超 120 字符以 `…` 截断；
   - **精确小写匹配**（见 §4「仅大写条目」）。
4. 两边都缺 → 保留空串，不编造；字段始终存在（前端显示 `—`）。
5. 数据文件新增溯源 `source.ecdict`：`path` / `sha256` / `queried` / `found` /
   `translationLimit` / `phoneticFills` / `translationFills`；`rules.memberFields`
   同步说明来源顺序。`--check` 重新生成（含 ECDICT 查询）与已提交文件逐字节一致。

## 3. 仍缺明细（1,074 个成员）

### 3.1 缺释义：115 个

| 类别 | 数量 | 说明 |
|---|---:|---|
| ECDICT 仅存大写词形 | 107 | 专名/地名人名派生：`Londoner`、`Parisian`、`Americanization`、`O.K.` 等；小写 lemma 精确匹配不到（口径见 §4） |
| ECDICT 完全无条目 | 2 | `bonyness`、`archepiscopal` |
| 有行但 translation 无中文 | 6 | `titulary`、`attitudinise`、`warehouser`、`ethician`、`arbitrement`、`dynamitist`（ECDICT 只有英文「= xxx」） |

前 50 词（按族 head 顺序；括号内为所属族，均为 demonym/专名派生或冷僻派生）：

1. americanization（american）　2. americanize（american）　3. londoner（london）
4. titulary（title）　5. anglicize（english）　6. o.k.（ok）　7. frenchify（french）
8. washingtonian（washington）　9. georgian（george）　10. germanic（german）
11. californian（california）　12. christendom（christian）　13. christly（christian）
14. skinnerian（skin）　15. parisian（paris）　16. marian（mary）　17. olympia（olympic）
18. carolingian（charles）　19. excellency（excellent）　20. britannic（britain）
21. bonyness（bone）　22. attitudinise（attitude）　23. necker（neck）　24. irelander（ireland）
25. catholicism（catholic）　26. romanic（roman）　27. judaic（jew）　28. grecian（greek）
29. mancunian（manchester）　30. wilsonian（wilson）　31. jordanian（jordan）
32. latinist（latin）　33. islamism（islamic）　34. liverpudlian（liverpool）
35. arthurian（arthur）　36. alexandrian（alexander）　37. berliner（berlin）
38. oxonian（oxford）　39. lincolnian（lincoln）　40. malayan（malaysia）
41. hawking（hawk）　42. argentinian（argentina）　43. warehouser（warehouse）
44. glaswegian（glasgow）　45. hitlerian（hitler）　46. mainer（maine）　47. celt（celtic）
48. guinean（guinea）　49. niger（nigerian）　50. hollander（holland）

后缀分布（115 个）：`-ian` 53、`-an` 14、`-ic` 11、`-er` 10、`-ist` 3、`-ism` 2、
`-ical` 2、`-ization/-ize/-ise` 4、其余 16（`-ness/-dom/-ly/-ment/-y/-al` 等）。

### 3.2 缺音标：1,068 个

| 类别 | 数量 | 说明 |
|---|---:|---|
| ECDICT 有行但音标为空 | 959 | 派生/屈折形式：`willingness`、`using`、`pleaser`、`orderer` 等；ECDICT 只给释义 |
| ECDICT 无条目 | 109 | 即 §3.1 的 107 个仅大写条目 + 2 个无条目（两项都缺的 109 个） |

顺带发现：lexicon 自身有 19 个成员释义非空、音标为空（`willingness`、`using`、
`positiveness` …），ECDICT 对这些词也给不出音标，仍为空串（不编造）。

前 50 词（族 head 顺序；除 35/36 外均为「ECDICT 有行无音标」）：

1. willingness（will）　2. timeliness（time）　3. impersonator（person）　4. knower（know）
5. knowingness（know）　6. wanter（want）　7. hereness（here）　8. playing（play）
9. feelings（feel）　10. partialness（part）　11. using（use）　12. useableness（use）
13. runniness（run）　14. oldness（old）　15. winnings（win）　16. talkativeness（talk）
17. farawayness（far）　18. pleaser（please）　19. systemiser（system）　20. systemizer（system）
21. motional（move）　22. movableness（move）　23. letterer（let）　24. losings（lose）
25. unitization（unit）　26. moneyer（money）　27. orderer（order）　28. hearable（hear）
29. awayness（away）　30. problematical（problem）　31. realness（real）　32. planning（plan）
33. killable（kill）　34. breakableness（break）　35. americanization（american，无条目）
36. americanize（american，无条目）　37. waterer（water）　38. understandability（understand）
39. addable（add）　40. studentship（study）　41. studiousness（study）　42. studying（study）
43. musicalness（music）　44. hitting（hit）　45. reasoner（reason）　46. dealings（deal）
47. presidentship（president）　48. courting（court）　49. creativeness（create）
50. officiation（office）

## 4. 口径决策：为什么不用大小写折叠补那 107 个专名

ECDICT 把专名/派生写成首字母大写（`Londoner`、`Americanization`、`O.K.`）。若按
`lower(word)` 查询可再补 107 个释义，但会引入错挂：`mainer` 会拿到姓氏
`Mainer`（人名）、`strider` 会拿到游戏名 `Strider`、`hawking` 会拿到「用鹰行猎」。
因此本任务按**精确小写**匹配，这 107 个保留空串，与卡里「剩余约 100 为
demonym/专名派生」的预期一致。若以后要补，需逐词人工 allowlist，不宜全局折叠。

## 5. 复现与校验

```bash
python3 scripts/build_word_families.py            # 重建（需 /tmp/nltk_data WordNet + data/ecdict.db）
python3 scripts/build_word_families.py --check    # 幂等：与已提交文件逐字节一致
./backend/venv/bin/python -m pytest scripts/tests/test_build_word_families.py -q
```

实际结果：`--check` 通过（exit 0）；构建脚本单测 **26 passed**；构建两次
`integrity.sha256` 均为 `acb3423e…`，文件 SHA-256 不变。

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `content/wordlist/word-families.v1.json`（新） | 1,702,433 B | `7cfa9f8aee6ac817adc15c7eb57fb96a00c3a51442e93140ee8bc0b627acd528` |
| 同上（HEAD `1ec1f33`，旧） | 1,485,953 B | `4c0e7a6c6aca0eeee6a83a708696f4b3067ffdd706172881c2c8d97acdc4cfe2` |
| `data/ecdict.db`（只读，跑前=跑后） | 109,002,752 B | `47f361f6cbc8b5bbcd5b1eb6fd3a9bd7ef5f872120ae920c32c051aad55f1a62` |
| `content/wordlists/lexicon.v1.json`（未改） | 1,152,971 B | `80c0b1abbfbe4d7e5a3384a710a62e3e17caf1aa18a2dd386587de28a5281cd4` |
| `content/wordlist/frequency_bands.v1.json`（未改） | 565,907 B | `67614c18f096cd7981da686c4c02f93447fb5d1dd3eceb76f5dfcbc2cbfd5927` |

数据文档 `integrity.sha256`（覆盖 counts+families+blacklist+allowlist）：
`acb3423ef96bd6416ccbb97b6a58852e1910c60a812e7063f7a0ded28fcae9ef1`。
构建过程中频表/lexicon/ECDICT 任一文件被改动会以退出码 4 拒绝写盘。

## 6. 已知局限与后续

- ECDICT 是旧式音标为主（少量现代 IPA），释义只取首个含中文行、≤120 字符；
  同一词形可能有冷僻义先行（如 `deciding` 补成 `[计] 判定`），属源数据口径，
  不做二次改写。
- 959 个派生词仍缺音标：本地词典无数据，且本任务不允许调 AI；如产品要求 100%
  覆盖，需要新的音标来源或接受空串（前端已显示 `—`）。
- 本任务未改前端/后端代码；数据字段形状不变，端点继续原样下发。
- 后端 `backend/tests/test_word_family.py` 有 3 个测试仍断言旧语义
  「lexicon 缺 = 空串」（`largeness`、`deciding`、逐条 lexicon 相等），数据补全后
  必然失败；该文件不在本卡写域，需 lead 按合并语义更新断言（见 handoff）。
