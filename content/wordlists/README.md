# content/wordlists — 单词本词表与等级索引

「单词本」页面的只读数据：CEFR 各级、GRE、CET4/6 词表，以及词 → 音标 /
首行中文释义 / CEFR 的紧凑索引。**随仓库分发、运行期零 LLM、零数据库、
零迁移**；后端加载器见 [`backend/vocabulary.py`](../../backend/vocabulary.py)，
端点见 [`backend/routes_vocabulary.py`](../../backend/routes_vocabulary.py)。

## 文件

| 文件 | 内容 |
|---|---|
| `exam-bands.v1.json` | GRE / CET4 / CET6 成员索引：`[word, tagMask, rank]`；tagMask `cet4=1 / cet6=2 / gre=4`，rank 取 ECDICT `frq`（缺失回退 `bnc`） |
| `lexicon.v1.json` | 词 → `[phonetic, translation]`；覆盖 10k CEFR lemma + 11,307 考试词（去重 15,807 条） |
| `SHA256SUMS` | 两个 JSON 的文件级 SHA-256（`shasum -a 256 -c SHA256SUMS`） |
| `NOTICE.md` | 来源、许可、署名与数据授权口径（**必读**） |
| `README.md` | 本文件：结构、API、重建、局限 |

CEFR A1–C1 的成员**不**在这里复制：运行期直接读
[`../wordlist/frequency_bands.v1.json`](../wordlist/frequency_bands.v1.json)
（wordfreq 3.1.1 数据，CC BY-SA 4.0），按现有锚点派生：

| 等级 | 累计秩范围 | 词数 |
|---|---|---|
| A1 | ≤1,000 | 1,000 |
| A2 | 1,001–2,000 | 1,000 |
| B1 | 2,001–4,000 | 2,000 |
| B2 | 4,001–7,000 | 3,000 |
| C1 | 7,001–10,000 | 3,000 |
| C2 | — | **未建模**（`available:false`） |

GRE / CET4 / CET6 当前规模（一个词可以同时属于多个表，所以三表相加 ≠
去重数）：

| 词表 | 词数 | 来源 |
|---|---:|---|
| GRE | 7,479 | ECDICT `tag` 含 `gre` |
| CET4 | 3,837 | ECDICT `tag` 含 `cet4` |
| CET6 | 5,396 | ECDICT `tag` 含 `cet6` |
| 去重 | 11,307 | 上述三表并集 |

## API

三个端点都**公开只读**，不需要登录；不签发游客 Cookie。响应带
`Cache-Control: public, max-age=3600`。

### `GET /api/vocabulary/lists`

返回数组（顺序：CEFR A1–C2 → GRE → CET4 → CET6），每项：

```json
{
  "id": "cefr-a1",
  "label": "CEFR A1",
  "count": 1000,
  "source": "wordfreq 3.1.1 → frequency_bands.v1.json",
  "license": "CC-BY-SA-4.0",
  "notice": "content/wordlist/NOTICE.md",
  "approximate": true,
  "available": true,
  "version": "2026.11.17",
  "note": "按 10k lemma 频表的累计秩映射…"
}
```

- CEFR 的 `approximate:true`：等级是**频带估计**，不是官方 CEFR 词表。
- 考试的 `approximate:false`：成员来自 ECDICT `tag` 列，**不是**用词频
  区间近似冒出来的；但 ECDICT 是词表整理库，也不是考试机构官方发布。
- `cefr-c2`：`count:0`、`available:false`、`source/license:null`，`note`
  明确「C2 未建模；不拿 GRE 冒充 C2」。

### `GET /api/vocabulary/lists/{id}?page=1&pageSize=50&q=`

```json
{
  "items": [
    {"word": "abandon", "phonetic": "ә'bændәn",
     "translation": "vt. 放弃, 抛弃…", "cefrLevel": "B1"}
  ],
  "total": 2000,
  "page": 1,
  "pageSize": 50,
  "hasMore": true
}
```

- `page` ≥1；`pageSize` 1–200（默认 50）；`q` ≤64 字符。
- `q` 大小写不敏感；**前缀匹配优先，其次包含匹配**，组内保持词表原顺序。
- CEFR 列表按频表秩升序；考试列表按 ECDICT `frq`/`bnc` 升序。
- `cefrLevel` 为 `null` 表示该考试词不在 10k CEFR 频表；前端展开时用
  `/level` 显示 `C1+`。
- 词表不存在、或请求 `cefr-c2` → `404`；数据文件缺失/损坏/完整性失败 →
  `503`；参数越界 → `422`（页面/页大小）或 `400`（q 超长）。

### `GET /api/vocabulary/level?words=abandon,running,ubiquitous`

`words` 逗号分隔（也可重复传参），最多 100 个。返回 `{词: 等级}`：

- 在 10k CEFR 频表（含屈折 forms 折回 lemma）→ `A1`–`C1`；
- 合法英文词但不在频表 → `C1+`。**本端点不查 ECDICT**：在频表但不在
  本地词典仍按频表给 A1–C1；不在频表也不在词典同样 `C1+`；本地词典缺失时
  行为一致；
- 非法 token（空、含数字/符号、超 64 字符）→ `null`；
- 响应键保留输入的大小写与词形（如 `Abandon` → `B1`）。
- 连字符复合词**不拆成部件判级**（避免 `state-of-the-art` 被按 `state`
  判成 A1）；精确词/form/后缀都查不到就是 `C1+`。缩略词与屈折仍会折回
  lemma（`running` → `run`）。

示例：`abandon` → `B1`，`running` → `A1`（折回 `run`），`ubiquitous` →
`C1+`，`qwerty!` → `null`。

## 构建与校验

产物已提交；只有换数据源/改词表口径时才重建。**不要把 60MB CSV 提交进仓库。**

```bash
# 1. 下载 ECDICT 官方 CSV 到仓库外
curl -L -o /tmp/ecdict-full.csv \
  https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv

# 2. 重建 exam-bands + lexicon + SHA256SUMS（幂等）
backend/venv/bin/python scripts/build_word_lists.py \
  --ecdict-csv /tmp/ecdict-full.csv

# 3. 离线校验（结构/完整性/频表覆盖；CI 可跑）
backend/venv/bin/python scripts/build_word_lists.py --check

# 4. 完整重建对比（需要 CSV；确认字节级幂等）
backend/venv/bin/python scripts/build_word_lists.py --check \
  --ecdict-csv /tmp/ecdict-full.csv
```

- 本批产物对应的 ECDICT 快照：`ecdict.csv@master`（2026-11-17），
  SHA-256 `d1ecbdf9ee2b920afb6f430ca6b6bb9f559588cf0dff86e04bd255f9390843cc`，
  770,611 行，其中 11,307 行带 GRE/CET4/CET6 标签且为纯字母词。
- `--allow-small` 只用于测试小 CSV；正式产物不要加（会跳过规模护栏）。
- 重建后同步：`README.md` 计数 → `NOTICE.md` 变更记录 →
  `SHA256SUMS`（脚本自动写）→ 跑
  `cd backend && venv/bin/python -m pytest tests/test_vocabulary_api.py tests/test_word_lists_build.py -q`。

## 局限（务必连同 NOTICE 一起读）

- CEFR 是频带代理，不是教学等级/官方 CEFR 词表；锚点（1k/2k/4k/7k/10k）
  是 v1 先验。C2 没有词表，API 明确 `available:false`，**不拿 GRE 冒充**。
- 考试标签来自 ECDICT 的整理，不是考试机构官方发布；GRE 表会包含一些
  高频基础词（如 `want`、`even`），这是上游 tag 的原样口径，不是本仓库
  自己筛的「难词」。
- 10k CEFR lemma 里有 18 个在 ECDICT 中查不到（如 `bitcoin`、`didnt`、
  `youre`），`phonetic`/`translation` 为空；其中 633 个缺音标。
  频表源自字幕/网页语料，可能混入 `didnt` 这类分词噪声；UI 应容忍空字段。
- CEFR 列表的 `word` 保持频表 lemma 的小写形式（含专名如 `africa`、
  `american`）；需要首字母/专名大小写时由显示层自行映射，或后续在产物中
  增加 display 字段。
- ECDICT 音标是旧式音标，不是严格 IPA；中文释义只取**第一个含中文的行**，
  超过 120 字符截断，不保证覆盖全部义项。
- `rank` 用 ECDICT `frq`（缺失回退 `bnc`），是语料库频次，不是教学顺序；
  同一词可在多个考试词表中重复出现。
- 数据授权：ECDICT 代码 MIT，词典数据多来源、授权状况不一；对外分发/
  商用前请自行复核。详见 [NOTICE.md](./NOTICE.md)。
