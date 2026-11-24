# P2-37 P2：分析内容级 gloss 字典

- status: claimed
- owner: {implementer: gloss-dict-impl, reviewer: lead, integrator: lead}
- base_sha: aeb8689

## goal
教学分析不再按 CEFR 等级重复生成同一内容的 gloss/idioms/culture：
1) 一次内容级分析（per content_hash + target_lang）生成**所有候选词的语境释义** + idioms/culture；
2) 按当前 level 本地筛选候选词，构造既有 payload；
3) 切换 level 零模型调用；缓存兼容旧 `analysis.v5` 行（不删除）；
4) 保持 API/段落合并/配额/失败降级语义；灰度开关默认开/可回退。

## 约束
- `zh_word` 必须是译文子串；非法条目丢弃
- 候选词 union 不能无限膨胀（上限/按 block）
- 不能把正文/prompt 写入缓存 meta
- 旧 per-level 缓存行保留为历史；新版本 key 用内容级 level 标记
- 分析仍异步/不阻塞首屏；失败不影响正文
- 先做实现 + 单测，真实成本/质量 A/B 由 lead 后续跑

## write_scope
- `backend/teaching_analysis.py`
- `backend/config.py`（开关）
- `backend/tests/test_teaching_analysis.py`
- `backend/tests/test_reading.py`（如缓存断言）
- `specs/028-teaching-analysis/spec.md`（如存在）
- `docs/reports/translation-tuning-2026-11-24.md`（状态回填）

## acceptance
- 同内容同语言：首次分析 1 次内容级生成；A1/A2/B1/B2/C1/C2 切换不再调用模型（mock 计数）
- 每个 level 的候选词筛选与旧逻辑等价（词集合/释义约束）
- idioms/culture 只生成一次并复用
- 旧缓存可读；失败降级/重试/配额不变
- 全量 pytest；preflight
