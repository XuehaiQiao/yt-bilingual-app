# NOTICE — 自建英语频表（`frequency_bands.v1.json`）

本目录是语途（LinguaTrek）CEFR M2「内容难度」的**运行期唯一词→频带映射**。
随仓库分发；运行期只读本文件，不读 CEFR-J / Octanove / SUBTLEX 等任何
仅研究用途的词表（计划书 K18 / §2.4）。

## 产物与许可

| 项 | 值 |
|---|---|
| 文件 | `frequency_bands.v1.json`（+ `SHA256SUMS` 文件哈希） |
| schema | `linguatrek.wordlist.v1` |
| version | `2026.11.17` |
| **本产物许可** | **Creative Commons Attribution-ShareAlike 4.0 International（CC BY-SA 4.0）** |
| 许可链接 | <https://creativecommons.org/licenses/by-sa/4.0/> |
| 用途 | 允许商用；须署名 + 以同协议开放本衍生数据 |

**为什么是 CC BY-SA 4.0**：本产物由 wordfreq 的英语频次数据派生。wordfreq
3.1.1 的**数据文件**以 CC BY-SA 4.0 分发（其**代码**为 Apache-2.0）；按
share-alike，派生数据（本频表）也以 CC BY-SA 4.0 开放。App 的源代码是独立
作品，不因此被传染；但本 JSON 数据文件本身必须保留 CC BY-SA 4.0 + 署名。
商用没有问题；若产品要求「衍生数据也不能是 share-alike」，应替换数据源并
重跑 `scripts/build_wordlist.py`。

## 上游来源与署名

### 主来源：wordfreq 3.1.1

- 项目：wordfreq — <https://pypi.org/project/wordfreq/3.1.1/>
- 作者：Robyn Speer（Luminoso）
- 代码许可：Apache License 2.0（`LICENSE.txt`，Copyright 2022 Robyn Speer）
- 数据许可：CC BY-SA 4.0
- 引用建议：Robyn Speer. (2022). rspeer/wordfreq: v3.0 (v3.0.2). Zenodo.
  <https://doi.org/10.5281/zenodo.7199437>

wordfreq 的英语频次由多个语料来源合并（其 METADATA 的 `License` 节逐条列出）：

- **Google Books Ngrams / Google Books Syntactic Ngrams**
  （<http://books.google.com/ngrams>）：Google 的使用条款为「Ngram Viewer
  图表与数据可自由用于任何目的，欢迎注明来源并附链接」。
- **Leeds Internet Corpus**（University of Leeds Centre for Translation
  Studies，<http://corpus.leeds.ac.uk/list.html>）。
- **Wikipedia**（<http://www.wikipedia.org>）。
- **ParaCrawl**（<https://paracrawl.eu>）。
- **OPUS OpenSubtitles 2018**（<http://opus.nlpl.eu/OpenSubtitles.php>），
  原始数据来自 OpenSubtitles（<http://www.opensubtitles.org/>），使用时需
  署名 OpenSubtitles。
- **SUBTLEX 系列**（SUBTLEX-US/UK/CH/DE/NL，Marc Brysbaert 等，
  <http://crr.ugent.be/programs-data/subtitle-frequencies>）。wordfreq 作者
  已获 Brysbaert 邮件许可，可**用于任何目的（不限于学术）**分发这些词表，
  条件是：使用方必须署名 SUBTLEX 作者，且须清楚说明 SUBTLEX 是免费数据。
- 部分 Twitter 流式 API 统计（只保留词频统计，不重发推文内容）。

本仓库**不再单独分发**上述任何原始词表；本产物只是「lemma + 频率秩 +
频带」的聚合映射，不含释义、例句或原语料文本。

### 未采用的候选（评估记录）

| 来源 | 许可状况 | 结论 |
|---|---|---|
| CEFR-J Vocabulary Profile v1.5 / v1.6 | 官方教育研究免费，**商用需书面许可** | 运行期不使用；离线校准也不在本轮 |
| Octanove C1/C2 v1.0 | CC BY-SA 4.0，但为 C1/C2 研究补口 | 不打包；避免混入第二套许可链 |
| SUBTLEX-US 独立文件 | 官网无正式许可字符串（open-for-research + 引用请求） | 不直接用；只经 wordfreq 的许可转授 |
| FrequencyWords / hermitdave | CC BY-SA 4.0，但仅 OpenSubtitles 字幕语料 | 备选；本产物选覆盖更全的 wordfreq |
| 只标「MIT」的公开词表 | 常见 1k–10k 列表多是 Google Trillion Corpus 派生，许可不清晰或覆盖不足 | 不采用；不能用来源不明的表 |

## 构建方法与可复现性

`scripts/build_wordlist.py`：

1. 取 wordfreq `top_n_list('en', 60_000, wordlist='large')`；
2. 过滤非纯字母 / 1–2 字母噪声 / 字幕缩写（`ll`、`govt`…）；
3. 自写屈折规则 + 内置不规则表把 running→run、went→go、children→child
   折回 lemma（**不使用 ECDICT 词形数据**，避免第二套许可链）；
4. 按 lemma 聚合相对频次、降序取前 **10,000** 个 lemma；
5. 每 1,000 个一档，共 10 带；按词表累计秩给 CEFR 锚点：
   A1 ≤1,000 / A2 ≤2,000 / B1 ≤4,000 / B2 ≤7,000 / C1 ≤10,000（v1 先验，
   待计划书 §6.7 的 60–100 条锚集校准）；
6. 输出 `version / license / source / counts / cefr_anchors / cefr_probs /
   entries / forms / integrity.sha256`。

重建（需要能访问 PyPI 的 Python；产物已提交，运行期不需要 wordfreq）：

```bash
python3 -m venv /tmp/wordlist-venv
/tmp/wordlist-venv/bin/pip install wordfreq==3.1.1
/tmp/wordlist-venv/bin/python scripts/build_wordlist.py --from-wordfreq \
    --out content/wordlist/frequency_bands.v1.json --write-sidecar
/tmp/wordlist-venv/bin/python scripts/build_wordlist.py --check
```

`--check` 会校验 schema/许可/条目数/rank 连续性/forms 合法性/integrity；
`SHA256SUMS` 是文件级哈希（构建脚本 `--write-sidecar` 生成）。

## 已知局限（必须连同频表一起读）

1. **频率 ≠ CEFR 教学等级**。CEFR 标签含教学取舍（如 `umbrella` 是 A1 但
   频次秩可能 >5k）；本表用频次代理，做的是「难度估计」，不是官方定级。
2. **CEFR 锚点是 v1 先验**，切点 1k/2k/4k/7k/10k 来自惯例词汇量区间
   （计划书 §4.3）而非校准过的标准设定；M2 决策表用 p90 判带（见
   `backend/difficulty.py` 与 specs/026），对自有 36 条编辑标注 ±1 带
   命中 26/36（约 72%，其中完全一致 7 条；单标注者，不是 §6.7 holdout，
   不对外宣称准确率）。
3. **专名/人名混入**：wordfreq 是大小写归一的语料频次，词表尾部会混入
   `colin`、`julie` 等名字；内容侧另有「非句首大写」过滤，但会轻微抬高
   UTR。词表尾部也有少量口语/网络词，属预期。
4. **lemma 化是规则近似**：不规则表覆盖常见屈折，未覆盖的派生/罕见形式
   会算 OOV；`news→new` 这类频带相邻的折叠不影响带级判断，但不是语义
   lemma 化。
5. **只覆盖 10,000 lemma**：表外词计入 `beyond` 桶；C2 不测（计划书 K15）。
6. **词表大小不是「词汇量」**：10,000 是频带锚点数量，不是「认识 1 万词」；
   对外文案不得把频带/生词率写成精确等级或个性化画像（K17）。

## 词族数据（`word-families.v1.json`，specs/041）

本目录还分发一份**只读词族数据**，供单词本「词族」tab 使用；运行期只读该
JSON，不安装、不读取 nltk / WordNet 语料。

| 项 | 值 |
|---|---|
| 文件 | `word-families.v1.json`（生成脚本 `scripts/build_word_families.py`） |
| schema | `linguatrek.word-family.v1` |
| version | `2026.11.23` |
| ruleVersion | `E`（全量 WordNet 派生图 + allowlist − 黑名单） |
| 构图 | WordNet 3.0 `derivationally_related_forms()` 无向派生图；连通分量 ≥2 成员且 ≥1 成员在 CEFR 10k；10k 外成员等级留空；无族词不写入 |
| 人工清单 | 黑名单 17 条坏边（`semantic_split` + `clear_error`）、allowlist 22 条缺失边；逐条校验存在性 |
| 结果 | 3,704 族 / 11,534 成员（10k 内 5,233、10k 外 6,301）/ 最大族 14；已应用 2026-11-23 高置信 AI 审计 23 条（中/低 11 条未应用） |
| 成员字段 | 每个成员带 `phonetic` / `translation` 快照：先取 `content/wordlists/lexicon.v1.json`，缺项用本地 ECDICT 补（只读、精确小写匹配、首个含中文行 ≤120 字符）；`translation` 仍缺时用 AI 生成的静态 override 补（仅空值、不覆盖、不补音标，见下节），仍缺留空串。覆盖率：音标 10,466/11,534（90.7%，P1-14 未改变）、释义 11,534/11,534（100%，其中 AI 补 115 条、**未人工复核**）；仍缺音标 1,068 |
| 审计依据 | `docs/reports/word-family-open-audit-2026-11-23.md`（P1-04） |
| **本产物许可** | **WordNet 3.0 License**（WordNet 派生部分）+ **CC BY-SA 4.0**（CEFR 频次/等级部分，见上文章节）；成员音标/释义的 ECDICT 派生字段口径见下节 |

### 上游来源：WordNet 3.0（Princeton University）

- 项目：WordNet — <https://wordnet.princeton.edu/>
- 版本：3.0（2006）；本机通过 NLTK 3.6.1 的 `wordnet` 语料读取，**语料不随仓库分发**
- 许可：WordNet 3.0 License（允许使用/复制/修改/分发，须保留版权声明与免责声明；
  禁止以 Princeton 名义背书；AS IS）

WordNet 3.0 许可要求的版权声明与免责声明（保留原文）：

> WordNet 3.0 Copyright 2006 by Princeton University. All rights reserved.
>
> THIS SOFTWARE AND DATABASE IS PROVIDED "AS IS" AND PRINCETON UNIVERSITY MAKES
> NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR IMPLIED. BY WAY OF EXAMPLE, BUT
> NOT LIMITATION, PRINCETON UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES OF
> MERCHANTABILITY OR FITNESS FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF THE
> LICENSED SOFTWARE, DATABASE OR DOCUMENTATION WILL NOT INFRINGE ANY THIRD PARTY
> PATENTS, COPYRIGHTS, TRADEMARKS OR OTHER RIGHTS.
>
> The name of Princeton University or Princeton may not be used in advertising
> or publicity pertaining to distribution of the software and/or database. Title
> to copyright in this software, database and any associated documentation shall
> at all times remain with Princeton University and LICENSEE agrees to preserve
> same.

### 上游来源：ECDICT（成员缺项补充）

词族成员的 `phonetic` / `translation` 在 `lexicon.v1.json` 缺该项时，用本机
ECDICT（`data/ecdict.db`，同 `content/wordlists/` 的 ECDICT 来源）补全：

- 项目与授权：ECDICT，<https://github.com/skywind3000/ECDICT>；仓库代码 MIT，
  词典数据由作者从 EDicTAZ、cdict、四六级/GRE 词表、BNC 等多来源整理，各来源
  授权状况不一。**本目录只分发紧凑派生字段**（词 → 音标/首行中文释义），不重发
  原文 CSV、英文 `definition`、例句、扩展 JSON 或音频；对外分发/商用前请自行
  复核，详见 [`content/wordlists/NOTICE.md`](../wordlists/NOTICE.md)。
- 快照：`data/ecdict.db` 表 `stardict(word, phonetic, translation)`，
  SHA-256 `47f361f6cbc8b5bbcd5b1eb6fd3a9bd7ef5f872120ae920c32c051aad55f1a62`
  （不随仓库分发）。
- 读取方式：`file:<绝对路径>?mode=ro&immutable=1` 只读打开，按批 `IN` 查询
  （每批 900 词），不建表、不写库、不联网；构建后复核文件 SHA-256 未变。
- 合并规则：只补 `lexicon.v1.json` 缺的音标或释义，**已有值不覆盖**；两边都缺
  留空串。归一化与 lexicon 同口径：音标压缩空白，释义取第一个含中文的行、
  超 120 字符以 `…` 截断。精确小写匹配（ECDICT 仅存大写词形的专名派生不补）。
- 本次结果：查询 5,642 词、命中 5,533；补音标 4,574、补释义 5,508。
- 局限：ECDICT 音标是旧式音标、不是严格 IPA；释义不保证覆盖全部义项；大量
  派生词只有释义没有音标（959 个成员仍缺音标）。

### 上游来源：AI 生成成员释义（P1-14）

lexicon 与 ECDICT 都查不到释义的 **115 个词族成员**（demonym/专名派生为主：
`tunisian`、`londoner`、`olympia`、`o.k.` 等），用 AI 生成的词典式中文释义补齐：

- 文件：`content/wordlist/ai-member-translations.v1.json`
  （schema `linguatrek.ai-member-translations.v1`）。
- 标记：`source: "ai-generated"`、`generatedAt: "2026-11-23"`、
  **`reviewed: false`（AI 生成、未人工复核）**。
- 范围：只补 `translation`，**不补音标**；条数 115，全部为词族成员。
- 合并：构建时仅当 lexicon 与 ECDICT 的同词释义都为空才填入，**已有值绝不覆盖**
  （优先级 lexicon > ECDICT > AI）；键不是族成员、文件缺失或格式不合法 → 构建
  直接失败（退出码 3），不静默生成低覆盖数据。
- 运行期不调用任何模型：override 是静态文件，应用只读生成的
  `word-families.v1.json`；数据新增 `source.aiTranslations` 溯源
  （path/sha256/generatedAt/reviewed/entries/translationFills）。
- 局限：AI 释义未人工复核，可能遗漏义项或用词不够精确（多义词如 `georgian`、
  `columbian`、`niger` 只给常见义）；专名译名采用通行译法。发现错误应改
  override → 人工复核后把 `reviewed` 置 `true` → 重跑构建与 `--check`。

### 与频表的关系

词族的 CEFR 锚定（10k 内/外、A1–C1 等级）派生自本目录的
`frequency_bands.v1.json`（wordfreq 3.1.1，CC BY-SA 4.0，署名见上文章节）；
该部分按 CC BY-SA 4.0 保留署名并以同协议开放。词族的成员关系（派生边）来自
WordNet 3.0，按 WordNet 3.0 License 保留上述声明。

### 重建与校验

```bash
python3 scripts/build_word_families.py --wordnet-dir /tmp/nltk_data
python3 scripts/build_word_families.py --wordnet-dir /tmp/nltk_data --check
```

`--ecdict` 默认指向 `data/ecdict.db`（本地可选数据，不随仓库分发）；lexicon
缺项时会只读查询它，库缺失则以退出码 3 失败，不静默生成低覆盖数据。
`--ai-translations` 默认指向 `content/wordlist/ai-member-translations.v1.json`；
文件缺失/格式坏同样以退出码 3 失败。构建是确定性的（无时间戳来源的耗时字段；
同一 WordNet 语料 + 同一频表 + 同一 lexicon + 同一 ECDICT 库 + 同一 AI override
逐字节一致）；文件带 `integrity.sha256`（覆盖 counts + families +
blacklist + allowlist）。清单或数据变化时先更新审计报告与 `specs/041`，再重跑
生成并 diff。

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-17 | 首版 v1：wordfreq 3.1.1，10,000 lemma / 10 带 / 10,848 forms；closes M2 词表构建 |
| 2026-11-23 | 新增 `word-families.v1.json`（specs/041，规则 E）：WordNet 3.0 派生图 + 17 条黑名单 / 22 条 allowlist；保留 WordNet 3.0 版权声明与免责声明 |
| 2026-11-23 | 词族成员音标/释义补全（P1-12）：lexicon 缺项用本地 ECDICT 补（音标 5,892→10,466、释义 5,911→11,419；仍缺 1,074），数据新增 `source.ecdict` 溯源；报告 `docs/reports/word-family-member-data-2026-11-23.md` |
| 2026-11-23 | 词族成员中文释义补全（P1-14）：115 个 lexicon/ECDICT 均缺释义的成员用 AI 生成静态 override 补齐（释义 11,419→11,534，音标 10,466 不变）；新增 `content/wordlist/ai-member-translations.v1.json` 与 `source.aiTranslations` 溯源（`reviewed=false`，未人工复核）；报告 `docs/reports/word-family-ai-translations-2026-11-23.md` |
