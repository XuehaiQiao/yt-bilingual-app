# P2-46 文章本地/线上分级不一致

- status: claimed
- owner: difficulty-fix-impl
- base_sha: e50cecf

## 问题
同一篇文章 `free-app-hidden-cost`：本地显示 B1，线上显示 B2。

## 要求
1) 查清本地/线上分级来源：content JSON `level`、`content_difficulty` 计算、API 返回、前端展示，哪一层不一致
2) 统一为同一口径（内容编辑级别 vs 算法计算级别不要混用）；给出迁移/回填方案
3) 不静默改用户数据；如需更新缓存/表，先写只读对比脚本
4) 回归 article/video 分级与推荐

## write_scope
- `backend/content_difficulty.py`（或实际计算模块）
- `backend/routes_library.py`
- `backend/scripts`/`scripts` 分级回填/对比
- `content/library/articles/free-app-hidden-cost.json`（如确认编辑级别应改）
- `backend/tests/test_library.py` / `test_difficulty_api.py`
- `specs/026-content-difficulty`

## acceptance
- 本地与线上对同一文章返回/显示同一 level
- 其他文章/视频抽检不回归
- 全量 pytest；preflight
