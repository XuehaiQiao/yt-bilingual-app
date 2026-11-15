# 规格：按能力画像推荐内容（规则推荐 V1）

**状态：** 已实现（2026-11-15，后端 + 首页「为你推荐」）｜
**对应代码：** `backend/recommend.py`、`backend/routes_recommend.py`、
`content/curated.json`；前端 `frontend/src/lib/recommend.ts`、
`frontend/src/components/HomeRecommendations.tsx`、`frontend/src/components/InputScreen.tsx`；
测试 `backend/tests/test_recommend.py`。

> 用户需求 #10（计划书 §1.3 / §5.1「按水平推荐内容」）与 V1「规则推荐 + 一句
> 人话理由」（计划书 §13.5）。本规格只覆盖 **人工精选池 + 规则推荐**：不训练
> 个性化模型、不优化观看时长、不做多源内容索引；难度口径沿用 M4 定位测的
> CEFR 区间，不引入 UTR 难度引擎。

---

## 目标

- **G1 首页有推荐**：登录用户/游客打开首页，「今日工作台」下方能看到 3–6 个
  适合自己水平的 YouTube 视频横排卡片。
- **G2 难度匹配**：优先返回 CEFR 区间内的视频，不足时补相邻 ±1 档；无画像
  默认 A2–B1。
- **G3 不重复、不推已学**：同一屏不出现重复 videoId；当前用户/游客 history
  缓存里已有（已缓存/已学）的视频不再返回。
- **G4 主题多样**：同一屏覆盖多个主题，同主题最多 2 条；用户最近看的主题
  优先出现在理由里（「你最近在看科技类」）。
- **G5 有理由**：每条给一句人话理由，至少包含难度匹配说明；中文理由可附
  精选池里的编辑推荐语，越南语理由只用模板（不混中文）。
- **G6 点得下去**：点击卡片复用首页现有的估价 → 选模型 → 处理流程，不新增
  第二条播放路径。
- **G7 轻量**：不调用 LLM、不联网、不新建表/迁移；读 `content/curated.json`
  与 history 缓存，10 分钟进程内缓存 + `Cache-Control: private, max-age=600`。
- **G8 诚实降级**：内容文件缺失/损坏 503；没有候选返回空数组，不伪造视频；
  无画像或画像样本 <100 时 `preliminary:true`。

## 非目标

- 不做「优化观看时长」的推荐算法（计划书明确不做），不做协同过滤/embedding。
- 不做 LLM 个性化理由（本轮规则模板 + 编辑文案；LLM 理由留给后续）。
- 不做 UTR 难度引擎、ECDICT 六列补全、难度预览 UI（M4 后续）。
- 不做多源（文章/播客/音乐）内容索引。
- 不做推荐曝光/点击/完播的持久化与反馈闭环；`seed` 只服务「换一批」。
- 不做游客画像认领后的个性化迁移；游客按任务口径一律默认 A2–B1。

---

## 精选内容池（`content/curated.json`）

只读静态 JSON，随仓库分发；**人工精选草稿，待运营复核**。当前 30 条：

| 维度 | 分布 |
|---|---|
| 难度 | A2 4 / B1 10 / B2 10 / C1 6 |
| 主题 | technology / business / psychology / culture / environment，各 6 条 |
| 时长 | 4:03–31:32（限制 3–40 分钟） |
| 频道 | BBC Learning English、VOA、TED、TED-Ed、Kurzgesagt、Bloomberg Originals、CrashCourse 等 |

每条字段：

```json
{
  "videoId": "KKNCiRWd_j0",
  "title": "What Is an AI Anyway? | Mustafa Suleyman | TED",
  "channel": "TED",
  "duration": 1322,
  "thumbnail": "https://i.ytimg.com/vi/KKNCiRWd_j0/hqdefault.jpg",
  "topic": "technology",
  "level": "C1",
  "publishedAt": "2024-04-22",
  "reason": "DeepMind 负责人 22 分钟完整论述 AI 的本质，长句与抽象概念多，适合 C1 精听。"
}
```

- `_meta.notice` 必须包含「待运营复核」，否则后端拒绝加载（内容闸门）。
- `videoId` 必须 11 位 `[A-Za-z0-9_-]` 且全池唯一；`title/channel/reason` 非空；
  `duration` 180–2400 秒；`level` ∈ A1–C1；`topic` ∈ 五个已知主题；
  `thumbnail` 必须是对应 videoId 的 `i.ytimg.com` 地址；`publishedAt` 为
  `YYYY-MM-DD`（缺省按 1970-01-01，不影响可用性）。
- 收集方式：yt-dlp `ytsearchN:` 按主题/难度取候选，再对每个入选 id 执行
  `yt-dlp --skip-download --dump-json https://www.youtube.com/watch?v=<id>`，
  校验 title/channel/duration/upload_date 均真实可解析（2026-11-15）。
- `reason` 是编辑推荐语，**不是**运行时规则理由；后端中文理由会把规则理由
  与编辑推荐语拼接，越南语只用规则模板。

---

## 推荐规则（`backend/recommend.py`）

### 输入

1. **画像**：登录用户读 `user_profiles.level_band_low/high`（M4，`0009_placement`）；
   没有画像 / 表未迁移 / 读取失败 → 默认 `A2–B1`。游客不读画像，一律默认。
2. **已看历史**：当前身份 + `targetLang` 的 history 缓存目录；只读
   `videoId`、`metadata.channel`、`metadata.title`，不读字幕正文。已缓存
   videoId 全部从候选里排除；频道/标题只用于推断「最近在看什么主题」。
3. **精选池**：`content/curated.json` 的 30 条。

### 排序

1. **难度过滤**：只保留 `level_distance(level, band) <= 1` 的候选（区间内 0，
   相邻一档 1）。
2. **分层**：先取区间内（distance=0），不足 `limit` 再取相邻 ±1（distance=1）。
3. **主题轮转**：每层内按「每轮每个主题最多 1 条」轮转，每主题总数上限 2 条；
   因此 5 个主题、`limit=6` 时先给五个主题各一条，再补第 2 条。
4. **新鲜度**：同主题内按 `publishedAt` 从新到旧（同日保持精选池文件顺序）。
5. **用户主题偏好**：用户最近看的主题在主题顺序里优先（影响小 `limit` 时先推
   熟悉主题），不改变难度分层。
6. **`seed`**：确定性轮转主题顺序与同主题候选顺序；`seed=0` 是首批，
   `1/2/…` 服务「换一批」，不改变筛选规则。
7. **回退**：有画像但 `band±1` 内没有候选（例如都看过了）→ 用默认 `A2–B1`
   重算一次；仍没有 → `items: []`，不伪造。
8. **排除**：按 videoId 去重/排除已看；精选池加载时已拒绝重复 id。

### 理由

- 中文：
  - 画像区间内：`适合你的 B1 水平`；
  - 相邻偏低：`比你的 B1–B2 区间略低，适合热身`；
  - 相邻偏高：`比你的 B1–B2 区间略高，适合挑战`；
  - 无画像：`A2–B1 入门区间，难度合适`；
  - 最近主题命中：追加`；你最近在看科技类`；
  - 最后接精选池 `reason`（编辑推荐语）。
- 越南语：只输出越语模板（`Phù hợp với trình độ B1 của bạn` 等），不拼接中文。

---

## HTTP 契约

`GET /api/recommendations`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `limit` | int | 否 | 1–12，默认 6；越界/非整数 422 |
| `targetLang` | string | 否 | `zh-CN`（缺省）/ `vi-VN`；非法 400 |
| `seed` | int | 否 | 0–9999，默认 0；用于「换一批」的确定性轮转 |

成功（200）：

```json
{
  "items": [
    {
      "videoId": "KKNCiRWd_j0",
      "title": "What Is an AI Anyway? | Mustafa Suleyman | TED",
      "channel": "TED",
      "duration": 1322,
      "thumbnail": "https://i.ytimg.com/vi/KKNCiRWd_j0/hqdefault.jpg",
      "level": "C1",
      "topic": "technology",
      "reason": "适合你的 C1 水平。DeepMind 负责人 22 分钟完整论述 AI 的本质……",
      "url": "https://www.youtube.com/watch?v=KKNCiRWd_j0"
    }
  ],
  "basis": { "band": "B1–B2", "source": "profile" },
  "preliminary": true
}
```

- `basis.source`：`profile`（用了登录用户画像区间）/ `default`（无画像、游客
  或画像回退后使用默认区间）。
- `basis.band`：CEFR 区间标签（en dash，如 `A2–B1`）。
- `preliminary`：无画像或定位测样本 <100 时为 `true`；前端不得把它升级成
  「准确」。
- 返回 `1–6` 条为常态；精选池不足/已看太多时返回实际数量，可为 0。
- 错误：400（targetLang 非法）、422（limit/seed 越界）、503（内容文件缺失/
  损坏/未标草稿）。
- 缓存：进程内 10 分钟；缓存键包含身份、`targetLang`、`limit`、`seed`、区间、
  来源、history 指纹（videoId/频道/最近主题），历史或画像变化会失效；响应头
  `Cache-Control: private, max-age=600`。

---

## 前端

- 首页「今日工作台」下方新增 `HomeRecommendations`：标题「为你推荐」+ 区间
  副标题 + 初步推荐徽章 + 「换一批」。
- 横排卡片（移动端宽 168px、桌面 224px，水平滚动 + snap）：缩略图、播放
  图标、难度徽章、时长、标题两行、频道、理由两行；点击整卡调用首页
  `EstimateDialog`（`/api/estimate-cost`）→ 选模型 → 现有处理流程。
- 「换一批」把 `seed` +1 重新请求；加载/失败/空状态都有文案与重试。
- 中越 i18n（`home.recommend.*`）；375px 下页面无横向溢出，推荐行自身可横滑。
- 游客同样可用；不弹登录。

---

## 测试与验收

`backend/tests/test_recommend.py`（17 个离线用例）：

- 精选池 24–30 条、id 唯一 11 位、A2/B1/B2/C1 + 5 主题、3–40 分钟、草稿标记；
- 有画像 B1–B2 / C1–C1：区间内优先、理由、`basis.source=profile`；
- 无画像/库未迁移：默认 A2–B1、`preliminary=true`；
- 游客即使有游客画像也用默认 band；
- 排除已看 videoId、最近主题进理由；
- `limit=5` 五主题各一条、`limit=6` 同主题 ≤2、`limit=1`、越界 422；
- `seed` 换批；画像区间无候选回退默认 band；
- 空精选池 200 空数组；文件缺失/坏内容 503；
- 缓存 10 分钟命中与 history 变化后失效；vi 理由无中文。

验证命令：

```bash
cd backend
venv/bin/python -m py_compile *.py
venv/bin/python -m pytest tests/test_recommend.py -q
venv/bin/python -m pytest tests -q
cd ../frontend && npx tsc -b && npm run check:i18n
```

2026-11-15 实测：全量 **395 测试绿**；`tsc -b`、`check:i18n`（573 keys × 2）、
`vite build` 通过；Playwright mock 覆盖有画像/无画像/换一批/375px/中越/失败重试
（截图 `/tmp/recommend-shots/`）；8001 临时实例实测无画像 `A2–B1/default`、
有画像 `B1–B2/profile`、已看排除与「你最近在看科技类」、游客默认 band，且推荐
URL 进入真实 `/api/estimate-cost` 返回同一 videoId。

---

## 已知限制 / 下一步

1. **精选池 30 条是草稿**：难度带与推荐语需运营复核；后续按 20 条/周补充。
2. **规则是启发式**：没有协作过滤、没有 20% 探索配额（计划书提到的探索项后续
   再加），主题偏好只影响顺序/理由，不影响难度分层。
3. **历史主题推断是关键词**：频道/标题匹配不到的已看视频不会贡献「你最近在看
   什么类」，但不影响排除与难度匹配。
4. **10 分钟缓存**：看了一个推荐视频后，若 history 文件未变化（例如没有落缓存），
   同 seed 的响应最多再展示 10 分钟；history 一旦变化缓存键即失效。
5. **不做曝光/点击闭环**：无法评估推荐 CTR/完播；后续需要事件表与离线评估。
