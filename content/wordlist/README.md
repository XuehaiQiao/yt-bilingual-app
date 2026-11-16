# content/wordlist — 自建英语频表（CEFR M2）

运行期唯一词→频带映射，用于内容难度管线的词汇覆盖率（UTR）与生词率估算
（`backend/difficulty.py`）。**只读、随仓库分发、无 LLM、无数据库。**

## 文件

| 文件 | 用途 |
|---|---|
| `frequency_bands.v1.json` | 10,000 lemma × 10 个频带（每带 1,000）+ lemma 屈折 forms + CEFR 锚点 + 许可/版本/完整性哈希 |
| `SHA256SUMS` | 文件级 SHA-256（`shasum -a 256 -c` 可校验） |
| `NOTICE.md` | 来源、许可（CC BY-SA 4.0）、署名、未采用来源的评估记录 |
| `README.md` | 本文件：结构、加载、重建、局限 |

## 为什么自建

本地优先架构下没有「服务端词表」：`start_app.command` 起的就是用户机器上的
uvicorn，`content/` 随仓库分发。CEFR-J 商用需书面许可、Octanove 是研究补口，
都不能直接打包。按计划书 K18 的 fallback，运行期改用自己的频带映射：

- 数据源 **wordfreq 3.1.1**（数据 CC BY-SA 4.0，可商用 + 署名 + share-alike）；
- 产物以 **CC BY-SA 4.0** 开放，署名见 `NOTICE.md`；
- 不包含 ECDICT / CEFR-J / Octanove 的任何词条数据。

## JSON 结构

```json
{
  "schema": "linguatrek.wordlist.v1",
  "version": "2026.11.17",
  "license": "CC-BY-SA-4.0",
  "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
  "source": {"name": "wordfreq", "version": "3.1.1", "url": "…", "dataLicense": "CC-BY-SA-4.0", "method": "…"},
  "counts": {"lemmas": 10000, "forms": 10848, "bands": 10, "by_cefr": {"A1": 1000, "…": 0}, "by_band": {"1": 1000, …}},
  "band_size": 1000,
  "limit": 10000,
  "cefr_anchors": [{"max_rank": 1000, "level": "A1"}, …, {"max_rank": 10000, "level": "C1"}],
  "cefr_probs": {"1": {"A1": 1.0, …}, …},
  "entries": [["the", 1], ["be", 2], …, ["tumour", 10000]],
  "forms": {"running": "run", "went": "go", "children": "child", …},
  "integrity": {"algorithm": "sha256", "scope": "entries+forms+band_size+cefr_anchors+limit+version", "sha256": "…"}
}
```

加载（`backend/difficulty.py`）：

- 首次使用时读文件并按 mtime/size 缓存；
- 校验 schema / license / `integrity.sha256`，失败 → 503（不静默用坏数据）；
- 只暴露 `rank_of(token)` / `lemma_for(token)` / `level_for_rank(rank)` 等
  查询，不把全量数据放进 API 响应。

## 重建与校验

```bash
# 产物已提交；只有在改词表/改宽度时才重建（需要联网装 wordfreq）
python3 -m venv /tmp/wordlist-venv
/tmp/wordlist-venv/bin/pip install wordfreq==3.1.1
/tmp/wordlist-venv/bin/python scripts/build_wordlist.py --from-wordfreq \
    --out content/wordlist/frequency_bands.v1.json --write-sidecar

# 只校验（离线；CI 用）
/tmp/wordlist-venv/bin/python scripts/build_wordlist.py --check
```

构建幂等：同一输入两次构建字节一致。改版本时同步更新：
`NOTICE.md` 的变更记录 → `content/wordlist/SHA256SUMS` → `specs/026` 的
changelog → 重新回填 `content_difficulty`（`scripts/backfill_content_difficulty.py`）。

## 局限（务必连同 NOTICE 一起读）

- 频率只是 CEFR 的代理，不是教学等级；判带是「估计」，对外不写「你是什么等级」。
- 锚点切点（1k/2k/4k/7k/10k）是 v1 先验，等 §6.7 的 60–100 条锚集校准后重定。
- 专名/人名会混入词表尾部；内容侧做「非句首大写」过滤，但仍会轻微抬高 UTR。
- 规则 lemma 化不是语义 lemma 化；表外词计入 `beyond` 桶。
- 10,000 是频带锚点数，不是「词汇量」；UI 不显示点值词汇量。
