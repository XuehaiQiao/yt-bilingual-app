# content/ — 入库的静态学习内容

与 `history/`（运行时缓存，不入库）不同，这里是**产品自带**的内容，随仓库分发。

| 路径 | 内容 |
|---|---|
| `sentences/` | 句子精背的 500 句精选（5 册 × 100 句），见 [sentences/README](./sentences/README.md) |
| `placement/` | 能力定位测题库（M4，草稿待教研审校）：30 词汇 + 5 阅读 + 4 伪词，见 [placement/README](./placement/README.md) |
| `curated.json` | 人工精选推荐池（V1 规则推荐，草稿待运营复核）：30 条真实 YouTube 视频，A2–C1 / 5 主题 / 4–32 分钟，见下文 |

## curated.json（人工精选推荐池）

首页「为你推荐」和 `GET /api/recommendations` 的候选来源。**不是** YouTube 搜索结果缓存，是随仓库分发、由运营维护的人工精选；文件头 `_meta.notice` 明确写着「人工精选草稿，待运营复核」。

- **规模与分布**：当前 30 条；A2 4 / B1 10 / B2 10 / C1 6；五个主题各 6 条
  （technology / business / psychology / culture / environment）；时长
  180–2400 秒（3–40 分钟）。
- **字段**：`videoId`（11 位真实 id）、`title`、`channel`、`duration`（秒）、
  `thumbnail`（`https://i.ytimg.com/vi/<id>/hqdefault.jpg`）、`topic`、`level`
  （A1–C1）、`publishedAt`（`YYYY-MM-DD`，来自 yt-dlp 的 `upload_date`）、
  `reason`（一句中文编辑推荐语）。
- **真实性**：候选由 yt-dlp `ytsearchN:` 收集，每个入选 id 再用
  `yt-dlp --skip-download --dump-json https://www.youtube.com/watch?v=<id>`
  逐条校验标题/频道/时长/上传日期可解析（2026-11-15）；没有编造 id。
- **后端闸门**：`backend/recommend.py` 加载时校验草稿标记、id 唯一性、时长范围、
  主题/难度枚举、缩略图与 id 一致、`_meta.count` 与条目数一致；坏内容直接
  503，不会把假视频推给用户。

新增/替换一条：

1. 用 yt-dlp 搜索候选，选时长 3–40 分钟、有英文字幕的英语视频；
2. 用 watch URL 校验元数据（id/title/channel/duration/upload_date）；
3. 在 `items` 里按 `publishedAt` 从新到旧插入（推荐排序用它做新鲜度）；
4. 更新 `_meta.count` 与 `_meta.levels` / `_meta.topics` 计数；
5. 跑 `cd backend && venv/bin/python -m pytest tests/test_recommend.py -q`。

> 人工精选是 V1 的冷启动方案：先保证「30 条真内容 + 规则匹配」，不追求个性
> 化模型。推荐曝光/点击闭环、UTR 难度引擎与 20% 探索配额在后续迭代。
