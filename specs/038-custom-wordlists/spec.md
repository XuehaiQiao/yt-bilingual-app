# 038 — 导入自定义词表（CSV / Anki 纯文本 TSV）

> 状态：**待实现** ｜ 2026-11-22 ｜ 需求来源：负责人「导入自定义词表（CSV/Anki）」
> 一句话：登录用户把自己的词表（CSV/TSV）导入成单词本里的独立词表；词条可加入我的单词/复习/已掌握，
> 用户提供的释义优先于系统词典。

## 1. 交互流程

### 入口
单词本顶栏（导出按钮同排）「导入词表」。**需登录**：游客点击 → 登录浮层，不做本地导入。

### 三步弹窗（复用 `ui/Dialog`）
1. **选文件**：拖拽/点选 `.csv` / `.tsv` / `.txt`（UTF-8，兼容 BOM）；≤2 MB、≤5000 行；
   超限不读入并提示。Anki 用户走「导出 → 纯文本」的 TSV；**不解析 `.apkg`**。
2. **预览与列映射**：自动识别分隔符（逗号/Tab）与首行表头；显示前 5 行；
   映射下拉：单词（必填）、释义、音标、CEFR、例句（可选）。
   实时统计「共 N 行 / 有效 M / 跳过 K」，无效行给前 5 条原因。
3. **命名并确认**：默认文件名（≤80 字），同名自动加 `(2)`；成功后新词表 tab 追加到末尾。

### 词表页
复用内置词表表格（`WordTable`）：单词+音标 / 释义 / CEFR；搜索、50/页分页、隐藏中文、行内发音。
每行动作：**加入我的单词 / 标为已掌握**（均幂等；已掌握无需先收藏）；**「加入复习」仅在复习 UI 启用时显示**（当前 `REVIEW_UI_ENABLED=false`，隐藏但保留接口与 `definition` 快照）。
词表头「删除词表」：二次确认；只删词表与条目，**不影响**已收藏/已加入复习的词（快照已存）。
导入完成后**不自动**批量加入；提供「全部加入复习（N 词）」按钮 + 确认。

## 2. 词条校验（客户端 + 服务端都做）

- 单词列必须含拉丁字母 `A–Z/a–z`；允许连字符、撇号、变音符号（`café`）、最多 5 词的短语（≤40 字符）。
- 拒绝：纯中文/日文/韩文/俄文/阿拉伯文、纯数字、纯符号、空值；中文写进单词列按无效处理。
- 去重键 `NFC + casefold`（保留原词形）；同表重复只留第一条。
- 整表判定：无效行 > 50% → 阻止导入，提示「这看起来不是英文词表」；否则导入有效行并返回 `skipped`。
- CEFR 只接受 `A1/A2/B1/B2/C1`（其它忽略，不猜）；音标/例句按原样存。

## 3. 释义优先级（用户数据优先）

1. 词表行：词表释义 → 系统词典缓存 → `—`；**不自动调 AI**。
2. 加入我的单词：收藏存快照（词形/释义/音标/例句），来源 `meta.source_kind='wordlist'`、`source_ref`=表 id、`source_title`=表名。
3. 加入复习：写 `word_states` 时把词表释义写入 `definition` 快照列（迁移 `0029_word_state_definition`）；
   **复习卡优先显示快照**，没有时才走 `/api/define`；不覆盖已有快照。
4. 系统字段（CEFR/音标）按系统数据；词表自带合法值才采用。

## 4. 数据模型（迁移 `0028_user_wordlists`）

`user_wordlists`：`id TEXT PK`、`user_id TEXT NOT NULL`、`name TEXT NOT NULL`、`source_filename TEXT`、
`item_count INTEGER`、`created_at INTEGER`；`UNIQUE(user_id, name)`。

`user_wordlist_items`：`id TEXT PK`、`list_id TEXT NOT NULL`（FK，ON DELETE CASCADE）、
`word TEXT NOT NULL`、`word_key TEXT NOT NULL`（NFC+casefold）、`translation TEXT`、`phonetic TEXT`、
`cefr TEXT`、`example TEXT`、`position INTEGER`；`UNIQUE(list_id, word_key)`；索引 `(list_id, position)`。

`word_states.definition TEXT NULL`（迁移 `0029`）：可空快照；旧行为 NULL。

## 5. API（全部需登录；游客 403）

| 端点 | 请求 | 成功 |
|---|---|---|
| `POST /api/wordlists/import` | `{name?, filename?, items:[{word,translation?,phonetic?,cefr?,example?}]}` ≤5000 | `201 {list:{id,name,itemCount,createdAt}, skipped}`；超过 10 表/5000 行/全无效 400 |
| `GET /api/wordlists` | — | `200 {lists:[{id,name,itemCount,createdAt}]}` |
| `GET /api/wordlists/{id}?page=1&pageSize=50&q=` | `page≥1`、`pageSize 1–200` | `200 {id,name,items:[{word,translation,phonetic,cefr,example}],total,page,pageSize,hasMore}` |
| `DELETE /api/wordlists/{id}` | — | `200 {status:"ok",deleted:true}`；不存在 404 |

`POST /api/review/words` 扩展可选 `definition`：写入 `word_states.definition`（仅当为空时写入，不覆盖用户数据）。
队列/词列表的公开 `word` 形状新增 `definition`（可为 null）。

## 6. 限额与存储

- 每人 ≤10 个自定义词表；每表 ≤5000 词；文件 ≤2 MB。
- 自定义词表词数计入任务 7 的存储配额统计。
- 删除词表级联删条目；不影响收藏/复习状态。

## 7. 验收标准

- [ ] 导入向导：CSV/TSV 分隔符与表头识别、列映射、预览统计、无效行原因、取消零副作用。
- [ ] 校验：非英文/纯数字/符号/超长拒绝；重复去重；>50% 无效阻止；`skipped` 计数正确。
- [ ] 词表 tab：出现在末尾、顺序正确、搜索/分页/隐藏中文/发音可用。
- [ ] 三动作：加入我的单词（来源=词表）、加入复习（带 definition 快照）、标已掌握；幂等且失败可重试。
- [ ] 释义优先级：词表释义优先；缺释义显示 `—`；复习卡显示快照而非再调 `/api/define`；已有快照不被覆盖。
- [ ] 删除词表：条目级联删除，收藏与复习状态保留。
- [ ] 限额：第 11 个表 / 第 5001 行 / 超大文件被拒绝并给明确错误。
- [ ] 375/1440 可用、中越 i18n 对齐、`gate-receipt` G1 P0=0、后端 pytest 绿。

## 8. 非目标（v1）

- 不解析 Anki `.apkg`（zip + SQLite）；用「导出纯文本」TSV 覆盖。
- 不做词表编辑/重命名/合并（删除后重新导入）。
- 不在导入时自动 AI 补释义（可选后续，需计费与确认）。
- 不做导入历史/版本。
