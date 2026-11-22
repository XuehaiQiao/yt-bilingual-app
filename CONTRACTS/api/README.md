# API 契约（快照待生成）

当前后端 140 个端点、28 个路由模块，`response_model` 使用率为 0，前端 62 个手写类型——**这是已知债务**，不是契约。

P1 计划：
1. 用 FastAPI 生成 `openapi.yaml` 快照，入库；CI 对 diff 做 review 提示。
2. 先为高风险端点补 `response_model`：`/api/favorites`、`/api/review/words`、`/api/wordlists*`、`/api/teaching-analysis`、`/api/article`、`/api/library*`、`/api/books*`。
3. 生成前端类型或对 `schemas/*.json` 做运行时校验，停止手写类型继续膨胀。

在此之前，以下端点形状按本目录 schemas 冻结：
- `GET /api/favorites` → 收藏列表（我的单词 = 该列表本身）
- `GET /api/review/words?mastered=1` → 已掌握列表（含 `definition`）
- `GET /api/wordlists/{id}` → 自定义词表条目（含 item `id`）
- `GET /api/teaching-analysis/{ref}` → `analysis.v5`
