# 046 — Anki `.apkg` 词表导入

> 状态：待实现 ｜ 2026-11-24
> 目标：让用户把 Anki 牌组导出包（`.apkg`）导入自定义词表，走现有 CSV 向导的校验/入库。

## 1. 支持范围

- `.apkg`（Anki 导出包）≤ **50 MB**
- 读取 `collection.anki2` / `collection.anki21` / `collection.anki21b`（后者 zstd）
- 只取**文本字段**：单词、释义；可附带 phonetic/CEFR/example（APKG 一般没有，留空）
- 忽略媒体、复习记录、学习进度、模板/样式
- 最多解析 **10000 条 notes**；超过则截断并在响应标记 `truncated`
- 只支持登录用户（与自定义词表一致；游客 403）

## 2. 后端解析 API

`POST /api/wordlists/apkg-parse`（multipart `file`）

响应：

```json
{
  "fileName": "xxx.apkg",
  "decks": [{ "id": "1", "name": "Default", "noteCount": 120 }],
  "models": [{ "id": "123", "name": "Basic", "fields": ["Front", "Back"] }],
  "notes": [{ "deckId": "1", "modelId": "123", "fields": ["word", "meaning"] }],
  "total": 120,
  "truncated": false
}
```

- `400`：不是合法 APKG / 无 notes / 不支持的 collection 格式
- `403`：未登录
- `413`：文件 >50 MB
- `503`：zstd 依赖缺失/解析暂不可用

安全：

- ZIP 只读取 collection 成员，不解压媒体；限制解压后 collection ≤200 MB
- SQLite 只读打开临时文件；不执行 SQL 写入
- HTML 清洗：`<br>`→空格、去标签、`[sound:…]` 去除、HTML entity 还原、压缩空白

## 3. 前端向导

保留现有三步，但 `.apkg` 增加一个配置步骤：

1. 选文件：接受 `.csv/.tsv/.txt/.apkg`；APKG ≤50 MB
2. **APKG 配置**：选牌组 → 选笔记类型（若多种）→ 选「词字段」「释义字段」；显示过滤后条数与预览
3. 映射/确认：沿用现有词表校验与确认（把 APKG 行转成两列：词、释义）
4. 导入：复用 `/api/wordlists/import`

- 默认选 noteCount 最大的牌组/模型；词字段默认第一个非空字段，释义字段默认第二个
- 只导入选中的牌组+模型；其它模型显示跳过数量
- 无有效英文词的行按现有规则跳过；>50% 无效仍阻止导入
- 失败/空/截断/字段缺失都有明确文案

## 4. 验收

- 合成 APKG：legacy `.anki2`、`.anki21`、`.anki21b`（zstd）各一条
- 解析：牌组/模型/字段/notes 正确；HTML 清洗；10000 截断；损坏包 400；大文件 413
- 前端：APKG 选文件→配置→确认→导入；牌组/模型/字段切换；预览；无效行拦截；游客不上传（403 文案）
- 现有 CSV/TSV/TXT 导入零回归；词表上限/去重/唯一名不变
- 375/1440 截图；`tsc/build/i18n/gate`；pytest 全量；preflight

## 5. 依赖

- 后端 `zstandard`（仅 `.anki21b` 需要；加入 requirements）
- 前端不新增解析依赖（由后端解析）
