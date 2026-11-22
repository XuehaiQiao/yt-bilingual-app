# 数据地图与单一事实源

> 与 `ARCHITECTURE.md` §6 配套。**每个事实只有一个权威存储与唯一写入口。**

| 事实 | 权威存储 | 唯一写入口 | 唯一读路径 | 禁止 |
|---|---|---|---|---|
| 我的单词 | `favorites.json`（type=vocabulary） | `vocabulary.addWord/removeWord`（乐观/回滚只此一处） | `selectMyWords()`；计数=`.length`；导出同源 | `favorites − mastered`、读时交集、localStorage 镜像参与计数 |
| 已掌握 | `word_states.mastered=1` | `vocabulary.markMastered/unmarkMastered`（未来服务端同事务删收藏） | `useMastered()`；计数=`words.length` | 从收藏交集推导、游客本地表当真相 |
| 互斥不变量 | 写路径 | 同一次掌握命令内删收藏 | 只读巡检报警 | 读路径过滤/减法 |
| 自定义词表 | `user_wordlists` / `user_wordlist_items` | `routes_wordlists.py`（含重命名/删条目） | `GET /api/wordlists*` | 前端本地镜像当真相 |
| 分析缓存 | `content_teaching_analysis` | 后端 `ensure_analysis`（唯一） | `/api/teaching-analysis` + payload 合并 | 旧版本混用、失败静默当空态 |
| 配额 | `ai_quota`（用量） | `ai/ledger` + `ai/quota` | `quota.snapshot()`；上限取 config | DB `limit_units` 当第二真源 |
| 余额/预算 | `ai_usage` / `users.balance_micro_usd` | `billing` / `ai.ledger` | `/api/account`、管理台 | 不同语义互相推导 |
| 内容 | `data/users/<uid>/history`、`content/`、DB 译文 | 各内容服务 | 各内容端点 | `content_ref` 裸 id 混用 |

## 现有违规（待 P0/P1 修）

1. 我的单词计数：App 用减法（`App.tsx:2338`）、阅读按钮用长度（`ReadingVocabButton.tsx:28`）、词书自算 → 三处。
2. 已掌握计数：从收藏交集推导（`VocabularyBookScreen.tsx:637-646`）。
3. 收藏写：App、词书、WordPopover 三套乐观/回滚。
4. 配额上限：`ai_quota.limit_units` 被每次 upsert 覆写（400 vs 30）。
5. 分析失败：`attach_to_payload` 静默 catch，UI 无原因/重试。
6. `content_ref`：视频裸 id，其余带前缀。

## 存量数据修复

3 条「已掌握但仍在收藏」（Affordability / intimately / thorny）→ `scripts/reconcile_mastered_favorites.py`：
dry-run 清单 → 备份 + 审计 JSONL → 逐条删除收藏 → 重叠=0 → 可回滚；**不改 `word_states`**。

## 写者矩阵

| 存储 | 允许写者 |
|---|---|
| `favorites.json` | `routes_user.py` → 未来 `FavoritesRepository`；脚本 reconcile（人工授权） |
| `word_states` | `srs.py` |
| `content_teaching_analysis` | `teaching_analysis.ensure_analysis` |
| `ai_usage` / `ai_quota` | `ai/ledger`、`ai/quota`、`billing` |
| `user_wordlists` | `routes_wordlists.py` |

禁止 agent/脚本直接改 `data/app.db`、`data/users/*/favorites.json`、`content/`。
