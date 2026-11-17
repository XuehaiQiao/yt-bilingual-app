# NOTICE — 单词本词表（`content/wordlists/`）

本目录是语途（LinguaTrek）「单词本」页面的只读词表数据，随仓库分发。
运行期由 [`backend/vocabulary.py`](../../backend/vocabulary.py) 加载，不联网、
不写数据库。**本文件不是法律意见**；对外分发/商用前请自行复核上游数据授权。

## 产物与许可

| 文件 | 内容 | 许可/来源口径 |
|---|---|---|
| `exam-bands.v1.json` | GRE/CET4/CET6 成员：`[word, tagMask, rank]` | 派生自 ECDICT（仓库代码 MIT；**词典数据多来源、授权状况不一**） |
| `lexicon.v1.json` | 词 → `[phonetic, translation]` 紧凑索引 | 音标/中文释义派生自 ECDICT；CEFR 词目派生自 wordfreq 频表 |
| `SHA256SUMS` | 文件哈希 | 本仓库生成 |
| `curated-phrases.v1.json` | 短语精选基线 200 条（自写释义/例句/CEFR/notes） | LinguaTrek 原创整理 |
| `curated-phrases-extra.v1.json` | 短语精选补充批次 370 条（同上） | LinguaTrek 原创整理 |
| `phrases.v1.json` | 合并短语词表 570 条；`counts` + `integrity` | 精选部分 LinguaTrek 原创整理；ECDICT 部分（本批 0 条）见 PHRASES-NOTICE |
| `PHRASES-NOTICE.md` | 短语词表来源/许可/CEFR 口径/质量闸 | 本仓库生成 |

本目录**不包含** ECDICT 的原始 CSV（约 60MB）、英文 `definition`、例句、
`detail`、`audio`，也不包含任何仅研究用途的 CEFR-J / Octanove 词表。
CEFR A1–C1 的成员与等级仍由
[`content/wordlist/frequency_bands.v1.json`](../wordlist/frequency_bands.v1.json)
派生；那份频表的来源、CC BY-SA 4.0 署名与完整 NOTICE 见
[`content/wordlist/NOTICE.md`](../wordlist/NOTICE.md)。

## 上游来源与署名

### 1. ECDICT（考试标签、音标、中文释义）

- 项目：ECDICT — <https://github.com/skywind3000/ECDICT>
- 作者：Linwei（skywind3000）
- 代码许可：MIT License（Copyright (c) 2025 Linwei，
  <https://github.com/skywind3000/ECDICT/blob/master/LICENSE>）
- 数据许可：**仓库没有单独的数据许可文件**。ECDICT README 说明词典数据由
  作者从 EDicTAZ、`cdict-1.0-1.rpm`、四六级/GRE 词表、BNC 语料库等多来源
  整理；各来源授权状况不一。MIT 许可证覆盖的是仓库代码，不等于自动覆盖
  词典数据的每一部分。
- 本批快照：`ecdict.csv@master`（2026-11-17 抓取）
  - SHA-256：`d1ecbdf9ee2b920afb6f430ca6b6bb9f559588cf0dff86e04bd255f9390843cc`
  - 行数：770,611
  - 带 GRE/CET4/CET6 标签且为纯字母词的词条：11,307
- 本仓库只分发**紧凑派生数据**：
  - 词 → 标签位掩码 / 语料库频次秩（`exam-bands.v1.json`）；
  - 词 → 音标 / `translation` 第一个含中文的行（`lexicon.v1.json`，超 120
    字符截断）。
  不重发完整词典，不重发英文释义、例句、扩展 JSON 或音频。
- **商用/再分发提示**：若产品需要对外分发本目录数据，请自行确认 ECDICT
  数据各来源的授权，或替换为授权链更清晰的数据源并重跑
  `scripts/build_word_lists.py`。本仓库不声称已替使用者完成该复核。

### 2. wordfreq 3.1.1（CEFR 频表来源）

- 项目：wordfreq — <https://pypi.org/project/wordfreq/3.1.1/>
- 作者：Robyn Speer（Luminoso）
- 代码许可：Apache License 2.0
- 数据许可：CC BY-SA 4.0
- 引用建议：Robyn Speer. (2022). rspeer/wordfreq: v3.0 (v3.0.2). Zenodo.
  <https://doi.org/10.5281/zenodo.7199437>

`content/wordlist/frequency_bands.v1.json` 是 wordfreq 英语频次的派生频表，
按 CC BY-SA 4.0 分发；其完整署名、语料来源与局限见
[`content/wordlist/NOTICE.md`](../wordlist/NOTICE.md)。本目录只引用该频表的
词目/秩来给 CEFR 列表排序和标级，**不重新分发 wordfreq 原始数据**。

## 口径：approximate 与「不是官方词表」

| 词表 | `approximate` | 含义 |
|---|---|---|
| CEFR A1–C1 | `true` | 由 10k lemma 频表的累计秩映射（A1≤1k / A2≤2k / B1≤4k / B2≤7k / C1≤10k）；是频带估计，**不是官方 CEFR 词表**。C2 没有任何词表，API 标 `available:false`，**不拿 GRE 冒充 C2**。 |
| GRE / CET4 / CET6 | `false` | 成员来自 ECDICT `tag` 列，**不是**用「CET4 1–4500 / CET6 4501–6500 / GRE 6501–12000」这类词频区间近似出来的；但 ECDICT 是词表整理库，标签也不是考试机构官方发布，仍应与官方大纲交叉复核。 |

若将来 ECDICT 官方 CSV 或网络不可用、只能用频带近似，构建脚本/API 必须
改为输出 `approximate:true` 并在 `note` 写「按词频近似，不是官方词表」；
不得静默把近似结果标成 `false`。

## 未采用的候选（评估记录）

| 来源 | 许可状况 | 结论 |
|---|---|---|
| CEFR-J Vocabulary Profile v1.5 | 官方教育研究免费，**商用需书面许可** | 不打包；CEFR 改用自建频带映射 |
| Octanove C1/C2 v1.0 | CC BY-SA 4.0，但为 C1/C2 研究补口 | 不打包；避免第二套许可链，也不拿它补 C2 |
| SUBTLEX-US 独立文件 | 官网无正式许可字符串 | 不直接用；只经 wordfreq 的许可转授 |
| FrequencyWords / hermitdave | CC BY-SA 4.0，但仅 OpenSubtitles 字幕语料 | 备选；本轮用 ECDICT 的考试标签 |
| 只标「MIT」的公开考试词表 | 常见列表许可/覆盖不清 | 不采用；不用来源不明的表 |

## 已知局限

- 18 个 CEFR lemma 在 ECDICT 中查不到（如 `bitcoin`、`didnt`、`youre`），
  音标/中文释义为空；633 个 CEFR lemma 缺音标。频表源自字幕/网页语料，
  可能混入分词噪声。
- ECDICT 音标是旧式音标，不是严格 IPA；中文释义只取第一个含中文的行，
  超 120 字符截断，不保证覆盖全部义项。
- 考试列表按 ECDICT `frq`（缺失回退 `bnc`）排序，不是教学顺序；GRE 表会
  包含一些高频基础词，这是上游 tag 的原样口径。
- 本目录数据是「学习辅助」而非考试大纲/教学测量；不对外宣称官方等级。

## 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| `2026.11.17` | 2026-11-17 | 首版：ECDICT `tag` 构建 GRE 7,479 / CET4 3,837 / CET6 5,396（去重 11,307）；lexicon 15,807 条；CEFR 由 10k 频表派生；C2 `available:false`。 |
| `2026.11.17` | 2026-11-17 | 新增短语词表：ECDICT 多词 tag 实测 0 条；精选 200 + 补充 370 = 570 条；许可与口径见 `PHRASES-NOTICE.md`。 |
