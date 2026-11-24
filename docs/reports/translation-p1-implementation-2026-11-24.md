# 翻译管线 P1 实现文档

> 日期：2026-11-24 ｜ 方案依据：[translation-tuning-2026-11-24.md](./translation-tuning-2026-11-24.md)
> 范围：P1 的三项已落地能力——**token-aware 分批 / 配额按内容量 / 计时可观测性**。
> P0 文档：[translation-p0-implementation-2026-11-24.md](./translation-p0-implementation-2026-11-24.md)

---

## 0. 摘要

| 能力 | 状态 | 提交 |
|---|---|---|
| 视频首批 10 / 稳定 40 / 2k token | ✅ | `d26d42b` |
| 文章首批 5 / 稳定 20 / 2k token | ✅ | `d26d42b` |
| 配额改为 1 单位=100 blocks / 10 段 | ✅ | `8686832` |
| 经典视频/本地剧集累计单位 | ✅ | `8686832` |
| 计时落表 + P50/P95 API | ✅ | `6300153` |
| 管理台「翻译计时」表 | ✅ | `6300153` |
| migration `0032_pipeline_timing` | ✅ 已应用 | `6300153` |

验证：

- 后端全量 pytest：**1598 passed**
- 前端 `tsc -b` / `build` / `check:i18n`：PASS
- 后端已重启，迁移 head = `0032_pipeline_timing`
- `pipeline_timing` 表已建；首次翻译后开始有数据

---

## 1. token-aware 分批

### 1.1 新增模块

`backend/translation_batching.py`：

```python
VIDEO_FIRST_BATCH_SIZE = 10
VIDEO_STEADY_BATCH_SIZE = 40
VIDEO_MAX_SOURCE_TOKENS = 2000

ARTICLE_FIRST_BATCH_SIZE = 5
ARTICLE_STEADY_BATCH_SIZE = 20
ARTICLE_MAX_SOURCE_TOKENS = 2000

estimate_tokens(text) = max(1, ceil(len(text) / 4))
chunk_by_budget(items, text_fn, first, steady, max_tokens)
```

规则：

1. 首批最多 `first` 条
2. 后续每批最多 `steady` 条
3. 每批累计源 token ≤ `max_tokens`
4. 单条超预算仍单独成批
5. 不产生空批、保持原顺序

token 估算只是英文字符近似（4 chars ≈ 1 token），不用于计费/配额/缓存键，只用于切批。

### 1.2 视频

- SSE：`translate._stream_translate` 用 `chunk_by_budget` 替换固定 20
- 经典：`routes_videos._translate_video_blocks` 同策略
- 效果：40 块 → **10 + 30**；长视频 → 10 + 40 + 40 + …
- 保持：批序、并发、队列、逐批落盘、progress/cursor、断点续传、取消、402

### 1.3 文章

- `reading.translate_article`：首批 5 段，之后 20 段/2k
- 已有译文不重译；失败段仍写 `[未翻译]`
- 每批仍只扣一次配额

### 1.4 本地剧集

`routes_content.py` 改为同一 token-aware 策略（首批 10 / 稳定 40 / 2k），
否则固定 20 块批会让“1 单位=100 blocks”名不副实。

---

## 2. 配额按内容量

### 2.1 新口径

`backend/ai/quota.py`：

| feature | 1 单位 | 每批扣费 |
|---|---|---:|
| `translate` | 100 blocks | `ceil(累计 blocks / 100)` 的增量 |
| `local_show` | 100 blocks | 同上 |
| `reading` | 10 段 | `ceil(累计段数 / 10)` 的增量 |
| 其他 | 1 次调用 | 1 |

两个入口：

- `units_for_blocks(feature, n)`：单批向上取整，至少 1
- `units_per_batch(feature, batch_sizes)`：多批**累计**分配，保证合计 = `ceil(总内容量 / 每单位量)`

### 2.2 关键例子

- 1,372 blocks 视频 → **14 单位**（旧口径 69 批）
- 61 blocks 切成 3 批 → 合计 **1 单位**（不会 3 单位）
- 10 段文章 → **1 单位**；20 段 → **2 单位**
- 默认 60 单位 ≈ 视频 **6,000 blocks/日**、文章 **600 段/日**

### 2.3 兼容与边界

- `ai_quota` 表结构不变，无数据迁移
- 旧 `used_units` 是“批次数”，与新内容量不可直接比较；文档已注明
- 覆盖批（已缓存/已翻）走只读闸门，不重复扣
- `translate/local_show/reading` 之外 feature 行为不变

### 2.4 管理台

`AdminQuotasPanel` 与中越 i18n 更新：

- 显示“单位”而不是“批”
- 说明 translate/local_show = 100 blocks/单位、reading = 10 段/单位
- 数值/覆盖/审计 API 不变

---

## 3. 计时可观测性

### 3.1 表

migration `0032_pipeline_timing`：

```text
pipeline_timing(
  id, feature, event, content_ref, job_id,
  batch_index, batch_count, duration_ms, total_ms,
  concurrency, ok, meta_json, created_at_ms, day
)
```

索引：`(day, feature)`、`(feature, day)`。

写入约束：

- **绝不阻断翻译**：任何异常只 warning，返回 None
- 不落正文/隐私：只存安全标识、数值、白名单 meta
- `content_ref` / `job_id` 只接受 `[A-Za-z0-9._:-]+` 且长度受限
- 只追加，不 UPDATE/DELETE
- `day` 按 `AI_QUOTA_TIMEZONE`（默认 Asia/Shanghai）派生

### 3.2 覆盖链路

- 视频 SSE：`sse_translate`
- 视频经典：`video_translation`
- 教学分析：`video_analysis`
- 读文章：`reading`
- 公版书：`book_translation`
- 本地剧集：`local_show`（补译/自愈路径）
- 其他共用：`translate`

保留原 stdout 计时日志，事件序不变。

### 3.3 API

`GET /api/admin/pipeline-timing?from&to&feature&limit`

- `require_admin`
- 默认最近 7 天
- 日期 `YYYY-MM-DD`；非法 400
- `limit` 1–200
- 空数据 200 + `rows=[]`
- 表未迁移 503
- 返回：每个 feature 的样本数、成功率、P50/P95/max + 最近行
- 只统计 `event=total`；`batch` 只进最近行

### 3.4 管理台

管理台 →「运维」→「翻译计时」：

- 默认最近 7 天
- 列：功能 / 样本数 / 成功率 / P50 / P95 / 最大
- 375 宽横向滚动
- 空态：“翻译或分析后会自动出现”

---

## 4. 测试与门禁

- 新增 `test_translation_batching.py`：20 个用例（边界/预算/单条超预算/空批）
- 新增 `test_pipeline_timing.py`：记录/清洗/聚合/API/权限/空数据/迁移
- 更新 11 个既有 migration head 断言：`0031 → 0032`
- 更新视频/文章/本地剧集/配额测试的批几何与单位
- 全量 pytest：**1598 passed**
- `tsc -b`、`npm run build`、`check:i18n`（2762×2）PASS
- preflight 通过

---

## 5. 部署

1. 代码更新到 `6300153` 之后
2. **执行 migration**：`cd backend && venv/bin/alembic upgrade head`
3. 重启 backend
4. 前端刷新（管理台 ops 页）
5. 无需重建缓存；旧视频缓存仍可读

当前环境：

- migration head：`0032_pipeline_timing`
- backend/frontend：200
- `pipeline_timing` 初始为空，首次翻译/分析后产生记录

回滚：

- 代码回退到 `8686832` 前：计时记录停止写入，表可保留
- 回退 migration：`alembic downgrade 0031_quota_overrides`（会删计时表；无业务依赖）
- 配额语义回滚会重新按批计；旧 `used_units` 不改

---

## 6. 已知残留

| 项 | 状态 | 影响 |
|---|---|---|
| `routes_local_video.py` | 仍按批扣单位 | 本地视频长内容可能多扣 |
| `book_import.py` | 仍按批扣 | 导入书配额未按段落折算 |
| `local_show` 主生成路径 | timing 只覆盖补译/自愈 | 主生成暂无 P50/P95 |
| `READING_TRANSLATE_BATCH_SIZE` | 配置/README 已失效 | 文档误导，待清理 |
| Qwen 路由 | 未启用 | 质量盲评未完成双评委/人工金标 |
| 分析内容级 gloss 字典 | 未做 | 6 档等级仍重算 |
| UI 浏览器实测 | 待管理员会话过一眼 | 类型/构建/验收已过，未人工看 |

---

## 7. 文件清单

| 文件 | 作用 |
|---|---|
| `backend/translation_batching.py` | token-aware 切批 |
| `backend/translate.py` | SSE 分批接入 |
| `backend/routes_videos.py` | 经典路径分批 + 累计单位 |
| `backend/reading.py` | 文章分批 + 单位 |
| `backend/routes_content.py` | local_show token-aware 分批 |
| `backend/ai/quota.py` | 内容量单位换算 |
| `backend/pipeline_timing.py` | 计时记录/聚合 |
| `backend/migrations/versions/0032_pipeline_timing.py` | 计时表 |
| `backend/routes_admin.py` | timing API |
| `frontend/src/components/AdminConsoleScreen.tsx` | 翻译计时表 |
| `frontend/src/components/AdminQuotasPanel.tsx` | 单位说明 |
| `frontend/src/i18n/{zh-CN,vi-VN}.json` | 中越文案 |
| 测试 | batching/timing/既有断言更新 |

---

## 8. 结论

P1 已完成：

- 分批从“固定条数”变为“首批小批 + 稳定期 token 预算”
- 配额从“按批”变为“按内容量”，长视频不再因批数撞 429
- 计时从 stdout 变为可查询表 + 管理台 P50/P95

下一步 P2：

1. 修 `routes_local_video.py` / `book_import.py` 配额口径
2. 清理失效 `READING_TRANSLATE_BATCH_SIZE`
3. 分析内容级 gloss 字典
4. Qwen 第二评委 + 人工 pairwise 后再决定路由
5. 用真实 7 天 timing 数据校准 10/40、5/20 与 2k 预算
