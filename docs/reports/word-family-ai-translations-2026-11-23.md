# 词族成员中文释义补全（P1-14，AI 生成）

- 日期：2026-11-23
- 任务卡：`TASKS/P1-14-family-ai-translations.md`（implementer=`family-ai-trans-impl`，reviewer/integrator=`lead`，卡 `base_sha: 6515e96`）
- 证据绑定：**HEAD `db83b2b`**（工作区改动未 commit；数据、测试与报告均绑此 HEAD）
- 脚本：`scripts/build_word_families.py`（新增 AI override 读取与合并；构建期读静态文件，运行期不调模型）
- 单测：`scripts/tests/test_build_word_families.py` 46 例（其中 16 例覆盖本任务）、`backend/tests/test_word_family.py` 23 例

## 1. 结论

115 个仍缺 `translation` 的词族成员全部补上中文词典式释义：**释义覆盖
11,419 → 11,534/11,534（100%）**；**音标覆盖不变 10,466/11,534**（AI 只补释义、
不猜音标，仍缺 1,068）。族数/成员数与 P1-13 完全一致（3,704 / 11,534）。

| 指标 | P1-12 后 | P1-14 后 | 说明 |
|---|---:|---:|---|
| 总成员 | 11,534 | 11,534 | 不变 |
| 有音标 | 10,466 | **10,466** | AI 不补音标（90.7%） |
| 有释义 | 11,419 | **11,534** | AI 补 115 条（100%） |
| 仍缺音标 | 1,068 | 1,068 | 无新来源，不编造 |
| 族 / 成员 / 最大族 | 3,704 / 11,534 / 14 | 3,704 / 11,534 / 14 | 不变 |
| 黑名单 / allowlist | 17 / 22 | 17 / 22 | 不变 |

- 合并优先级固定 **lexicon > ECDICT > AI**：AI 只在 lexicon 与 ECDICT 都为空时填入，
  已有非空值逐字节不覆盖。
- 来源标记：`source: "ai-generated"`、`generatedAt: "2026-11-23"`、
  **`reviewed: false`（AI 生成、未人工复核）**；数据新增 `source.aiTranslations`
  溯源（path/sha256/generatedAt/reviewed/entries/translationFills）。
- 未改前端/后端运行时代码；未 commit。

## 2. 来源与合并口径

1. 新增 `content/wordlist/ai-member-translations.v1.json`
   （schema `linguatrek.ai-member-translations.v1`）：**115 条**，键为小写 lemma，
   值为词典式中文释义（如 `tunisian = a. 突尼斯的；n. 突尼斯人`、
   `olympia = n. 奥林匹亚（希腊古地名）`），均由 AI 生成，**不含英文释义、不含音标**。
2. 生成方式：本轮 AI 逐词生成（DeepSeek Harness agent），非从外部词典拷贝；
   未调用任何机器翻译 API，也没有运行期模型调用。
3. 合并位置：`build_word_families._member_fields`。音标只看 lexicon → ECDICT；
   释义看 lexicon → ECDICT → AI，**逐级只在上一级为空时取值**。
4. 只有 `translation` 为空才会用 AI 值；lexicon/ECDICT 的非空释义（含冷僻义、
   旧式音标）原样保留，不做二次改写。
5. AI override 的键必须仍是当前族成员，拼错/死条目直接构建失败；文件缺失、JSON
   坏、schema/`source`/`generatedAt`/`reviewed` 类型不符、键非小写、值为空/不含
   中文/超 120 字符，都会给出带文件路径与词条的错误（退出码 3），不静默降级。
6. 构建确定性：override 是静态文件，输出不含运行时间戳；同一 WordNet 语料 +
   频表 + lexicon + ECDICT + override → 逐字节一致，`--check` 幂等。

## 3. 115 个词与 AI 释义

按字母序；「所属族」为生成后 `word-families.v1.json` 的族 head，「等级」为成员
自身 CEFR 等级（这些词几乎都是 10k 外 demonym/专名派生，等级为空）。

| # | 词 | 中文释义 | 所属族 head | 等级 |
|---:|---|---|---|---|
| 1 | `aberdonian` | a. 阿伯丁的；阿伯丁人的 | `aberdeen` | 10k 外 |
| 2 | `alexandrian` | a. 亚历山大的；n. 亚历山大里亚人 | `alexander` | 10k 外 |
| 3 | `algerian` | a. 阿尔及利亚的；n. 阿尔及利亚人 | `algeria` | 10k 外 |
| 4 | `americanization` | n. 美国化（过程） | `american` | 10k 外 |
| 5 | `americanize` | v. 使美国化 | `american` | 10k 外 |
| 6 | `anglicize` | v. 使英国化；使英语化 | `english` | 10k 外 |
| 7 | `arbitrement` | n. 仲裁；仲裁裁决 | `arbitration` | 10k 外 |
| 8 | `archepiscopal` | a. 大主教的 | `archbishop` | 10k 外 |
| 9 | `argentinian` | a. 阿根廷的；n. 阿根廷人 | `argentina` | 10k 外 |
| 10 | `armenia` | n. 亚美尼亚 | `armenian` | 10k 外 |
| 11 | `arthurian` | a. 亚瑟王（传奇）的 | `arthur` | 10k 外 |
| 12 | `athenian` | a. 雅典的；n. 雅典人 | `athens` | 10k 外 |
| 13 | `attitudinise` | v. 装腔作势；摆姿态 | `attitude` | 10k 外 |
| 14 | `baptistic` | a. 浸信会的 | `baptist` | 10k 外 |
| 15 | `berliner` | n. 柏林人 | `berlin` | 10k 外 |
| 16 | `bonyness` | n. 骨瘦如柴；多骨 | `bone` | 10k 外 |
| 17 | `bosnian` | a. 波斯尼亚的；n. 波斯尼亚人 | `bosnia` | 10k 外 |
| 18 | `britannic` | a. 不列颠的；英国的 | `britain` | 10k 外 |
| 19 | `buddhistic` | a. 佛教的 | `buddhist` | 10k 外 |
| 20 | `caesarean` | a. 凯撒的；剖腹产的；n. 剖腹产 | `caesar` | 10k 外 |
| 21 | `californian` | a. 加利福尼亚的；n. 加州人 | `california` | 10k 外 |
| 22 | `carolingian` | a. 加洛林王朝的；n. 加洛林王朝 | `charles` | 10k 外 |
| 23 | `catholicism` | n. 天主教；天主教教义 | `catholic` | 10k 外 |
| 24 | `celt` | n. 凯尔特人 | `celtic` | 10k 外 |
| 25 | `chadian` | a. 乍得的；n. 乍得人 | `chad` | 10k 外 |
| 26 | `chilean` | a. 智利的；n. 智利人 | `chile` | 10k 外 |
| 27 | `christendom` | n. 基督教世界；基督徒（总称） | `christian` | 10k 外 |
| 28 | `christly` | a. 基督般的；虔诚的 | `christian` | 10k 外 |
| 29 | `churchillian` | a. 丘吉尔式的 | `churchill` | 10k 外 |
| 30 | `columbian` | a. 哥伦布的；哥伦比亚的 | `columbus` | 10k 外 |
| 31 | `croatian` | a. 克罗地亚的；n. 克罗地亚人 | `croatia` | 10k 外 |
| 32 | `cyprian` | a. 塞浦路斯的；n. 塞浦路斯人 | `cyprus` | 10k 外 |
| 33 | `dantean` | a. 但丁的；但丁风格的 | `dante` | 10k 外 |
| 34 | `darwinian` | a. 达尔文的；n. 达尔文主义者 | `darwin` | 10k 外 |
| 35 | `dunkard` | n. 敦克尔派教徒 | `dunk` | 10k 外 |
| 36 | `dynamitist` | n. 使用炸药者；炸药破坏者 | `dynamite` | 10k 外 |
| 37 | `ecuadorian` | a. 厄瓜多尔的；n. 厄瓜多尔人 | `ecuador` | 10k 外 |
| 38 | `einsteinian` | a. 爱因斯坦的；爱因斯坦式的 | `einstein` | 10k 外 |
| 39 | `ethician` | n. 伦理学家 | `ethical` | 10k 外 |
| 40 | `excellency` | n. 阁下（对官员的尊称） | `excellent` | 10k 外 |
| 41 | `fijian` | a. 斐济的；n. 斐济人 | `fiji` | 10k 外 |
| 42 | `frenchify` | v. 使法国化；使法语化 | `french` | 10k 外 |
| 43 | `gandhian` | a. 甘地的；甘地主义的 | `gandhi` | 10k 外 |
| 44 | `georgian` | a. 乔治王时代的；佐治亚/格鲁吉亚的；n. 格鲁吉亚人 | `george` | 10k 外 |
| 45 | `germanic` | a. 日耳曼（人/语）的；n. 日耳曼语 | `german` | 10k 外 |
| 46 | `ghanaian` | a. 加纳（人）的 | `ghana` | 10k 外 |
| 47 | `gilbertian` | a. 吉尔伯特（剧作）风格的 | `gilbert` | 10k 外 |
| 48 | `glaswegian` | a. 格拉斯哥的；n. 格拉斯哥人 | `glasgow` | 10k 外 |
| 49 | `grecian` | a. 希腊的；n. 希腊人 | `greek` | 10k 外 |
| 50 | `gregorian` | a. 格列高利（历法/圣咏）的 | `gregory` | 10k 外 |
| 51 | `guatemalan` | a. 危地马拉的；n. 危地马拉人 | `guatemala` | 10k 外 |
| 52 | `guinean` | a. 几内亚的；n. 几内亚人 | `guinea` | 10k 外 |
| 53 | `haitian` | a. 海地的；n. 海地人 | `haiti` | 10k 外 |
| 54 | `hawking` | n. 鹰猎；v. 用鹰狩猎 | `hawk` | 10k 外 |
| 55 | `hebraic` | a. 希伯来人的；希伯来语的 | `hebrew` | 10k 外 |
| 56 | `hebraical` | a. 希伯来人的；希伯来语的 | `hebrew` | 10k 外 |
| 57 | `hebraist` | n. 希伯来语学者 | `hebrew` | 10k 外 |
| 58 | `hitlerian` | a. 希特勒式的；希特勒主义的 | `hitler` | 10k 外 |
| 59 | `hollander` | n. 荷兰人 | `holland` | 10k 外 |
| 60 | `homeric` | a. 荷马的；荷马风格的 | `homer` | 10k 外 |
| 61 | `icelander` | n. 冰岛人 | `iceland` | 10k 外 |
| 62 | `irelander` | n. 爱尔兰人 | `ireland` | 10k 外 |
| 63 | `islamism` | n. 伊斯兰主义 | `islamic` | 10k 外 |
| 64 | `javan` | a. 爪哇的；n. 爪哇人 | `java` | 10k 外 |
| 65 | `jeffersonian` | a. 杰斐逊的；n. 杰斐逊主义者 | `jefferson` | 10k 外 |
| 66 | `jordanian` | a. 约旦的；n. 约旦人 | `jordan` | 10k 外 |
| 67 | `judaic` | a. 犹太人的；犹太教的 | `jew` | 10k 外 |
| 68 | `judaical` | a. 犹太人的；犹太教的 | `judaism` | 10k 外 |
| 69 | `lancastrian` | a. 兰开斯特的；n. 兰开斯特人 | `lancaster` | 10k 外 |
| 70 | `latinist` | n. 拉丁语学者 | `latin` | 10k 外 |
| 71 | `libyan` | a. 利比亚的；n. 利比亚人 | `libya` | 10k 外 |
| 72 | `lincolnian` | a. 林肯的；林肯式的 | `lincoln` | 10k 外 |
| 73 | `liverpudlian` | a. 利物浦的；n. 利物浦人 | `liverpool` | 10k 外 |
| 74 | `londoner` | n. 伦敦人 | `london` | 10k 外 |
| 75 | `luxembourgian` | a. 卢森堡的；卢森堡人的 | `luxembourg` | 10k 外 |
| 76 | `mainer` | n. 缅因州人 | `maine` | 10k 外 |
| 77 | `malayan` | a. 马来亚的；n. 马来人 | `malaysia` | 10k 外 |
| 78 | `mancunian` | a. 曼彻斯特的；n. 曼彻斯特人 | `manchester` | 10k 外 |
| 79 | `marian` | a. 圣母玛利亚的 | `mary` | 10k 外 |
| 80 | `monacan` | a. 摩纳哥的；n. 摩纳哥人 | `monaco` | 10k 外 |
| 81 | `moroccan` | a. 摩洛哥的；n. 摩洛哥人 | `morocco` | 10k 外 |
| 82 | `napoleonic` | a. 拿破仑的；拿破仑式的 | `napoleon` | 10k 外 |
| 83 | `neapolitan` | a. 那不勒斯的；n. 那不勒斯人 | `naples` | 10k 外 |
| 84 | `necker` | n. 亲吻爱抚的人 | `neck` | 10k 外 |
| 85 | `newtonian` | a. 牛顿的；n. 牛顿学派 | `newton` | 10k 外 |
| 86 | `niger` | n. 尼日尔（西非国家）；尼日尔河 | `nigerian` | 10k 外 |
| 87 | `nilotic` | a. 尼罗河的；n. 尼罗河流域语言 | `nile` | 10k 外 |
| 88 | `o.k.` | a. 好的；ad. 好；v. 批准；n. 同意 | `ok` | 10k 外 |
| 89 | `olympia` | n. 奥林匹亚（希腊古地名） | `olympic` | 10k 外 |
| 90 | `oxonian` | a. 牛津的；n. 牛津人 | `oxford` | 10k 外 |
| 91 | `panamanian` | a. 巴拿马的；n. 巴拿马人 | `panama` | 10k 外 |
| 92 | `parisian` | a. 巴黎的；n. 巴黎人 | `paris` | 10k 外 |
| 93 | `persia` | n. 波斯（伊朗旧称） | `persian` | 10k 外 |
| 94 | `peruvian` | a. 秘鲁的；n. 秘鲁人 | `peru` | 10k 外 |
| 95 | `romanic` | a. 罗曼语的；罗马式的 | `roman` | 10k 外 |
| 96 | `rooseveltian` | a. 罗斯福（式）的 | `roosevelt` | 10k 外 |
| 97 | `shakespearean` | a. 莎士比亚的；n. 莎士比亚学者 | `shakespeare` | 10k 外 |
| 98 | `shakespearian` | a. 莎士比亚的；n. 莎士比亚学者 | `shakespeare` | 10k 外 |
| 99 | `shavian` | a. 萧伯纳（式）的；n. 萧伯纳迷 | `shaw` | 10k 外 |
| 100 | `skinnerian` | a. 斯金纳（行为主义）的；n. 斯金纳学派 | `skin` | 10k 外 |
| 101 | `solomonic` | a. 所罗门的；明智的 | `solomon` | 10k 外 |
| 102 | `somalian` | a. 索马里的；n. 索马里人 | `somalia` | 10k 外 |
| 103 | `strider` | n. 阔步行走者；大步走的人 | `stride` | 10k 外 |
| 104 | `tanzanian` | a. 坦桑尼亚的；n. 坦桑尼亚人 | `tanzania` | 10k 外 |
| 105 | `tibet` | n. 西藏 | `tibetan` | 10k 外 |
| 106 | `titulary` | a. 头衔的；名义上的 | `title` | 10k 外 |
| 107 | `trinidadian` | a. 特立尼达的；n. 特立尼达人 | `trinidad` | 10k 外 |
| 108 | `tunisian` | a. 突尼斯的；n. 突尼斯人 | `tunisia` | 10k 外 |
| 109 | `uruguayan` | a. 乌拉圭的；n. 乌拉圭人 | `uruguay` | 10k 外 |
| 110 | `venetian` | a. 威尼斯的；n. 威尼斯人 | `venice` | 10k 外 |
| 111 | `wagnerian` | a. 瓦格纳的；n. 瓦格纳迷 | `wagner` | 10k 外 |
| 112 | `warehouser` | n. 仓库管理员；仓储商 | `warehouse` | 10k 外 |
| 113 | `washingtonian` | a. 华盛顿的；n. 华盛顿人 | `washington` | 10k 外 |
| 114 | `wilsonian` | a. 威尔逊（主义）的 | `wilson` | 10k 外 |
| 115 | `zimbabwean` | a. 津巴布韦的；n. 津巴布韦人 | `zimbabwe` | 10k 外 |

## 4. 抽样与校验

抽样（10/115，覆盖专名、地名、缩写、冷僻派生与多义词）：

| 词 | 中文释义 | 所属族 head |
|---|---|---|
| `tunisian` | a. 突尼斯的；n. 突尼斯人 | `tunisia` |
| `londoner` | n. 伦敦人 | `london` |
| `olympia` | n. 奥林匹亚（希腊古地名） | `olympic` |
| `o.k.` | a. 好的；ad. 好；v. 批准；n. 同意 | `ok` |
| `titulary` | a. 头衔的；名义上的 | `title` |
| `necker` | n. 亲吻爱抚的人 | `neck` |
| `bonyness` | n. 骨瘦如柴；多骨 | `bone` |
| `hawking` | n. 鹰猎；v. 用鹰狩猎 | `hawk` |
| `niger` | n. 尼日尔（西非国家）；尼日尔河 | `nigerian` |
| `georgian` | a. 乔治王时代的；佐治亚/格鲁吉亚的；n. 格鲁吉亚人 | `george` |

校验结果（HEAD `db83b2b` 工作区）：

- `python3 scripts/build_word_families.py --wordnet-dir /tmp/nltk_data --check`：
  **exit 0**，`content/wordlist/word-families.v1.json` 与现场生成逐字节一致（幂等）。
- `python3 -m pytest scripts/tests/test_build_word_families.py -q`：**46 passed**。
- `cd backend && venv/bin/python -m pytest tests/test_word_family.py -q`：**23 passed**。
- 覆盖率按成员字段逐条统计：`translation` 非空 11,534；`phonetic` 非空 10,466；
  两项都缺 0；仍缺音标 1,068。
- 构建摘要：词族/成员 3,704/11,534；ECDICT 查询 5,642 / 命中 5,533；ECDICT 补
  音标 4,574 / 释义 5,508；**AI 补释义 115**；POS 11,534/11,534。

| 文件 | 大小 | SHA-256 |
|---|---:|---|
| `content/wordlist/ai-member-translations.v1.json`（新） | 6,253 B | `7349c3553a020d2feb4e1e6e515dc8dbb2c0d909a110afc3c528ec279a1098a6` |
| `content/wordlist/word-families.v1.json`（新） | 1,864,340 B | `ce3d6ed49726b8657b64b1e00841e31e14f6b1a5b01d29da52913af43f3597ac` |
| 同上 `integrity.sha256`（counts+families+bl/allowlist） | — | `1a3b7ef56812214a7c70efea35e1dfa5f07e02872935d6e9db439830905a23df` |
| `content/wordlists/lexicon.v1.json`（未改） | 1,152,971 B | `80c0b1abbfbe4d7e5a3384a710a62e3e17caf1aa18a2dd386587de28a5281cd4` |
| `content/wordlist/frequency_bands.v1.json`（未改） | 565,907 B | `67614c18f096cd7981da686c4c02f93447fb5d1dd3eceb76f5dfcbc2cbfd5927` |
| `data/ecdict.db`（只读，未改） | 109,002,752 B | `47f361f6cbc8b5bbcd5b1eb6fd3a9bd7ef5f872120ae920c32c051aad55f1a62` |

## 5. 风险与局限

1. **未人工复核**：115 条释义由 AI 生成，`reviewed=false`；可能遗漏义项、用词不够
   精确或专名译名与产品既有译法不一致。当前只作为词表展示用释义，不参与教学判定。
2. **多义词只给常见义**：如 `georgian` 同时涉及英国乔治王时代、美国佐治亚州与
   格鲁吉亚；`columbian` 兼「哥伦布的/哥伦比亚的」；`niger` 兼国名与河名；
   `cyprian` 另有古义「淫荡的」未收。若产品要按语境取义，需人工补注。
3. **音标仍缺 1,068**：本任务明确不补音标；这些成员前端继续显示 `—`，行为与
   P1-12 相同。
4. **专名派生覆盖边界**：只覆盖当前 115 个仍缺释义的成员；未来词表/族数据变化后
   新出现的缺释义成员不会被自动补，需重跑「找出缺失 → AI 生成 → 更新 override」。
5. **来源标注**：NOTICE/spec/数据 `source.aiTranslations` 与报告均标注 AI、未人工
   复核；对外分发前建议至少抽样人工复核，复核后把 override 的 `reviewed` 改为
   `true` 并重跑构建（`--check` 会更新数据里的 `reviewed` 字段）。
6. 不改前端/后端运行时代码，静态数据字段形状不变；端点原样下发，无运行时 AI 调用。

## 6. 复现

```bash
python3 scripts/build_word_families.py --wordnet-dir /tmp/nltk_data   # 重建
python3 scripts/build_word_families.py --wordnet-dir /tmp/nltk_data --check
python3 -m pytest scripts/tests/test_build_word_families.py -q
cd backend && venv/bin/python -m pytest tests/test_word_family.py -q
```

增量生成 override（一次性、需人工审阅）：从数据中列出 `translation == ""` 的成员，
逐词补中文释义写入 `ai-member-translations.v1.json`，再重跑上面的构建与校验；
**不要在应用运行期生成**。
