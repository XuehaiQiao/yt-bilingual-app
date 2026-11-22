# P0-04 文章分析恢复与可见错误态

- status: ready
- owner: {implementer: TBD, reviewer: TBD, tester: TBD, integrator: TBD}
- base_sha: 95f5891

## goal
个人导入文章打开时能生成/读取 `analysis.v5`；未命中时不再静默空态，显示可重试原因（配额/预算/模型失败），正文与查词不受影响。

## non_goals
- 不做全面分析缓存回填（P1 另立）；不改版本策略本身
- 不改免费库预热内容

## write_scope
- `backend/teaching_analysis.py`（错误分类/返回原因）
- `backend/routes_reading.py`（payload 携带 `analysisUnavailableReason`）
- `backend/routes_videos.py`、`routes_books.py`、`routes_library.py`（同类静默 catch 的透出，最小改动）
- `frontend/src/lib/reading.ts`（解析后端新增的 analysisUnavailableReason/used/limit/resetAt）
- `frontend/src/lib/useReadingAnalysis.ts`
- `frontend/src/components/reading/ReadingSurface.tsx`
- `frontend/src/components/ReaderScreen.tsx`
- `frontend/src/i18n/*.json`（**shared_writes，本卡独占 lease**）
- `backend/tests/`（新增/修改测试）
- `scripts/p0-04-analysis-acceptance.mjs`（新增 Playwright 验收，根 scripts）

## read_only
- `specs/028-teaching-analysis/spec.md`、`specs/039-reader-surface/spec.md`
- `docs/data-map.md`、`CONTRACTS/schemas/error.json`

## acceptance
1. 配额不足时：payload 带 `analysisUnavailableReason=quota_exceeded`（+ used/limit），接口仍 200，正文正常。
2. UI 显示 inline 非阻断提示：「今日分析额度已用完（30/30），明天 0 点恢复」+ 重试；不发登录提示。
3. 缓存命中/生成成功：不显示提示，ruby/语言点正常。
4. 模型失败与配额失败文案不同；不把失败当空态。
5. 后端单测：attach 不再吞掉原因；前端 Playwright：有/无分析、429、恢复后重试。
6. `pytest` 定向 + 全量；`tsc/build/i18n/gate` 绿。

## deps
- P0-05（配额单源与 ops 身份）先在测试环境落地，便于验证“恢复后成功”

## rollback
revert merge；无数据迁移；旧缓存不受影响。
