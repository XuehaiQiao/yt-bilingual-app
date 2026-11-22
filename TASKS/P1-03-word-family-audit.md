# P1-03 WordNet 词族映射审计（只读）

- status: claimed
- owner: {implementer: family-audit-impl, reviewer: lead, integrator: lead}
- base_sha: 30f3e05

## goal
在把「词形」tab 改成「词族」前，用 WordNet 3.0 派生关系对 CEFR 10k 做只读审计：覆盖多少、词族分布、误合并候选、`decide/decision/decisive` 与 `reflect/reflection/reflective` 实际分组，给出可落地的构图规则。

## non_goals
- 不改应用/数据/现有词表
- 不提交 WordNet 数据文件；只报告与候选映射
- 不做产品决策（只给建议）

## write_scope
- `scripts/word_family_audit.py`（新建）
- `scripts/tests/test_word_family_audit.py`（新建）
- `docs/reports/word-family-audit-2026-11-23.md`（新建）

## read_only
- `content/wordlist/frequency_bands.v1.json`、`content/wordlists/lexicon.v1.json`
- WordNet 3.0 语料（系统 `python3` 的 nltk，数据目录 `/tmp/nltk_data`；脚本需可 `--wordnet-dir` 指定，缺失时给明确错误）
- 现有 `backend/lemma_list.py`（参考，不修改）

## acceptance（报告必须包含）
1. 10k CEFR lemma 覆盖率：多少 lemma 至少有一条 WordNet 派生关系；能形成多少词族（≥2 成员）、最大族、单例数。
2. 例子：`decide` / `decision` / `decisive` 是否同族；`reflect` / `reflection` / `reflective` 是否同族；展示族成员与 WordNet 关系名。
3. 误合并候选：`critical→crisis`、`adjudicate→judge` 等；统计有多少条，分类（语义已分化/词性转换/明显错误）。
4. 规则建议：只保留哪些链接（同 POS/同词根/仅 10k 内/人工 allowlist），以及预计误合并率。
5. 构建候选映射（输出到报告附录或 `/tmp`，不提交数据文件）：word → family id / head；给出 JSON 示例。
6. 单测：WordNet 解析封装、族合并、误合并分类（用固定小样本，不依赖下载）。
7. 只读证明：前后 CEFR/lexicon 文件 sha256 不变。

## deps
- 无（只读）

## rollback
仅新增脚本/报告。
