# P2-44 语言点首屏：level-first 渐进 gloss

- status: claimed
- owner: level-first-impl
- base_sha: 1ba4d1e

## 问题
P2-37 内容级分析首次加载就生成 A1–C2 六档候选词并集，首屏 prompt/输出过大；用户实测语言点加载过慢。

## 目标
保留内容级缓存，但首次只生成**当前等级**候选词；切等级时只补缺失词，不回到每档整篇重算。

## 行为
1) `ensure_analysis` 把当前 canonical level 传给 `_ensure_content_analysis`
2) 缓存命中且覆盖当前等级候选 → 0 模型调用
3) 缓存缺失/不覆盖 → 只生成当前等级缺失候选词
   - 首次：当前等级候选（≤20/block，和旧 v5 同量级）
   - 后续：只补当前等级中缓存没有的词
4) 合并 glosses；idioms/culture 首次生成，增量不重复生成
5) 旧 v6 全量缓存可继续复用；不回退、不删已有缓存
6) 缓存仍 keyed `(content_hash, __content__, target_lang, analysis.v6)`

## write_scope
- `backend/teaching_analysis.py`
- `backend/tests/test_teaching_analysis.py`
- `backend/tests/test_reading.py`（如缓存断言）
- `backend/tests/test_quota_ops_subject.py`（如调用次数）
- `specs/028-teaching-analysis/spec.md`
- `docs/reports/translation-tuning-2026-11-24.md`

## acceptance
- 首次分析候选数 = 当前等级候选数，不含其他档
- 同 level 第二次 0 调用
- 切到新 level 只生成缺失词；覆盖后 0 调用
- idioms/culture 不重复生成
- 旧 v6 缓存复用
- 全量 pytest；preflight
