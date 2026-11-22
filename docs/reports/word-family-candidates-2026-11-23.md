# 词族候选清单（机器筛选，只读）

- 日期：2026-11-23
- 输入：`content/wordlist/word-families.v1.json`（3,696 族 / 11,567 成员）
- 脚本：`scripts/word_family_candidates.py`（只读；`--json`）
- 候选 JSON：`/tmp/word-family-candidates-audit.json`
- 未调用 AI、未修改数据；输入文件 sha256 见输出。

## 规则

| 规则 | 定义 | 命中 |
|---|---|---:|
| large | 族 ≥6 人 | 278 |
| multi-pos | 族 ≥6 人且 ≥3 种 POS | 256 |
| outside-heavy | 10k 外成员 ≥4 且占比 ≥70% | 238 |
| rank-spread | 族 ≥4 人且 rank 跨度 ≥7000 | 74 |
| word-shape | 含多词/大写/非字母成员 | 1 |

去重后 **436 个候选族**（3,696 的 11.8%），适合分批人工/AI 复核；其余 3,260 族按规则无需复查。

## 典型候选

- `F0264 large`（18 人）：large / extend / extension / extensive / extent / comprehensive / comprehend / comprehension / …——链式连接，语义跨度过大
- `F0391 sense`（14 人）：sense / sensitive / sensor / sensation / sensitivity / sensible / …
- `F0064 use`（12 人）：use / using / user / usage / serviceability / serviceable / usable / …——`serviceability` 明显是靠链条挂进来的
- `F0640 crime`（12 人）：crime / criminal / criminalise / incriminate / …
- `F0900 digital`（11 人）：digital / digit / digitalis / digitalization / digitize / …——`digitalis`（毛地黄）是词形巧合
- `F0700 theory`（10 人）：theory / theorist / theoretic / theorise / theorize / …

## 建议

1. 436 族按每批 30–50 族交给 AI（结构化输出：keep / remove_edge / remove_member + 理由），约 10–15 批
2. 人工只审 AI 分歧与高风险（大族、明显词形巧合）
3. 结论写回 `build_word_families.py` 的 blacklist/allowlist，重新生成数据；不手改 JSON

## 复现

```bash
python3 scripts/word_family_candidates.py            # 摘要
python3 scripts/word_family_candidates.py --json     # 全量候选
python3 -m pytest scripts/tests/test_word_family_candidates.py -q
```
