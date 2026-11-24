# P2-36 P2：翻译配额/配置收尾

- status: claimed
- owner: {implementer: quota-cleanup-impl, reviewer: lead, integrator: lead}
- base_sha: b814344

## goal
修 P1 已知残留：
1) `routes_local_video.py` 固定 20-block 批 → token-aware 分批（视频首批 10/稳定 40/2k），并按累计内容量传 `quota_units`；120 块=2 单位而非 6
2) `book_import.py` 每批 reading 固定 1 单位 → `quota.units_per_batch("reading", batch_sizes)` 累计（10 段=1、20 段=2）
3) 删除失效 `READING_TRANSLATE_BATCH_SIZE`（config.py/README/docs）；不再有“每批段数”说法
4) local_show 主生成加 pipeline_timing total/batch（若低成本；不强制）
5) 保持 400/413/429/402、缓存、事件/响应语义

## write_scope
- `backend/routes_local_video.py`
- `backend/book_import.py`
- `backend/config.py`
- `backend/routes_content.py`（仅 timing，如做）
- `backend/README.md`
- `backend/tests/test_local_video*.py`（实际文件名）
- `backend/tests/test_book_import.py`
- `backend/tests/test_config*.py`（如有）
- `docs/reports/translation-p1-implementation-2026-11-24.md`

## acceptance
1. local video 120 blocks 分多批仍只扣 2 单位；批大小 10/40/2k；结果顺序不变。
2. book import 20 段分 8+8+4 只扣 2 单位；不再每批 1。
3. `READING_TRANSLATE_BATCH_SIZE` 无引用、README 删除；启动/测试不受影响。
4. 全量 pytest；tsc 如前端无改动可跳过；preflight。
