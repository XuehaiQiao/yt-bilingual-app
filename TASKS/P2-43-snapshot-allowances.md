# P2-43 迁移快照：登记跨版本预期变化

- status: merged
- owner: lead
- base_sha: 352f772

## 问题
生产 0025→0033 演练时 `v11_data_snapshot.py` 无法登记 0027/0028/0030/0031/0032 的预期变化：
- 新表 `pipeline_timing`、`quota_overrides`、`user_wordlist_items`、`user_wordlists`
- `model_prices` 行数 2→6（0030 写 Qwen 价格）
- `word_states` 新列 `definition/mastered` 导致整表哈希变化

## 变更
`scripts/v11_data_snapshot.py`：
- 新增 `--allow-row-change TABLE`（可重复/逗号）
- 新增 `--allow-hash-change TABLE`
- 未登记变化仍 FAIL；只用于已审计的跨版本预期

## 演练允许项
```bash
--allow-new auth_tokens,feedback,pipeline_timing,quota_overrides,user_wordlist_items,user_wordlists
--allow-row-change model_prices
--ignore-column word_states.definition
--ignore-column word_states.mastered
```
