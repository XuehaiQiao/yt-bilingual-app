# 规格：内容难度向量与 i+1 匹配（CEFR M2）

> 规格只讲**做什么**和**为什么**，不讲怎么实现。总依据：
> `docs/项目计划-CEFR能力标定.md` §6 / §7.2 / §7.4 / §10.2。

**状态：** 已实现（后端 + 内容 + 最小前端） ｜ **对应代码：** `backend/difficulty.py`、`backend/content_difficulty.py`（只读口径对比）、`backend/routes_difficulty.py`、`scripts/build_wordlist.py`、`scripts/backfill_content_difficulty.py`、`scripts/content-difficulty-backfill.py`（只读对比闸门）、`scripts/backfill_curated_transcripts.py`、`scripts/content_supply_report.py`、`content/wordlist/`、`content/library/gutenberg-manifest.json`、`backend/migrations/versions/0016_content_difficulty.py`、`frontend/src/lib/difficulty.ts`

---

## 目标

给每条内容（视频/文章）算一个**可解释、可复现、离线**的难度向量与 CEFR
输入带，让推荐与内容卡能回答「这条内容对你现在大约有多少生词」，而不是
只显示一个编辑手填的等级字母。

## 用户故事

- 作为学习者，我想在推荐/免费资源卡上看到「难度带 + 生词约 X%（桶）」，
  以便判断这条内容现在是否适合我。
- 作为产品，我想让推荐理由从「band 距离」升级为「与你当前词汇区间接近」，
  以便在 30 条精选池里仍能给出人话解释。
- 作为教研/运营，我想对任意内容重算难度并落库，以便新增内容时不用手填等级。
- 作为工程师，我想让难度计算 0 LLM、可重跑、有版本与完整性校验，以便
  离线/本地优先架构下也能一致复现。

## 功能需求

- **必须**：运行期只读自建频表 `content/wordlist/frequency_bands.v1.json`
  （CC BY-SA 4.0，wordfreq 3.1.1 数据派生）；不读 CEFR-J / Octanove /
  SUBTLEX 等仅研究用途词表。频表带 `version / license / integrity.sha256`。
- **必须**：`scripts/build_wordlist.py` 可复现（幂等、`--check` 校验），
  产物 8,000–10,000 lemma、每 1,000 一档、带 CEFR 锚点；`NOTICE.md` 写清
  来源、许可、署名与未采用来源的评估。
- **必须**：`difficulty.v1` features 冻结字段：`size/utr/utr_content/
  cefr_mix/p_level/proper_noun_rate/speed/syntax/available/lex/pragmatics/
  support/est_cefr/editorial_level/label_confidence/method/computed_at`；
  自动字幕或无标点时 `asl/clause_density/passive_per_1k` 置 null 且
  `available=false`，不参与判带。
- **必须**：文章与视频两个入口；视频用字幕块时间戳算毛/净语速与
  `window_p90_wpm`；文章按标点切句。
- **必须**：`content_difficulty` 表（迁移 0016，按 §7.2 全字段，不 seed），
  回填脚本对 70 条 serving（3 视频 + 67 文章）+ 30 条 curated 生成 100 条，
  幂等、有覆盖率/失败原因。
- **必须**：公开 API `GET /api/content/difficulty?kind&ref` 与 batch
  （≤50，`Cache-Control: public, max-age=3600`）；内容缺失 404；难度行缺失/
  表未迁移回退内容编辑 `level`（200，不 503）。管理员
  `POST /api/admin/content-difficulty/recompute`。
- **必须**：推荐用 `match_score`（`cefrInput` 与用户词汇区间接近度 +
  支持度）排序；理由含「与你当前词汇区间接近」；无难度数据回退旧
  `level_distance` 规则；用户可见文案不出现「个性化」。
- **应当**：前端「为你推荐」「免费资源」卡片显示难度徽章与生词桶；
  zh-CN / vi-VN 均有文案；`check:i18n` 通过。
- **应当**：难度行缺失/无画像时仍可用：徽章回退编辑等级，不显示生词桶。

## 推荐读带：种子画像与单档回退（v1.1 D8-2，2026-11-21）

- 推荐优先读 `GET /api/ability/profile` 的 `vocabulary.low/high`，用
  `normalize_band` 限制在 A1–C1（[specs/025](../025-ability/spec.md)）。
- 旧词汇量回填的种子行**不再出带**（`low/high=null`）；此时用
  `vocabulary.cefr` 点估计当**单档带** `(point, point)`，例如 `(B1, B1)`，
  仅当点也在 A1–C1 时生效。C2 点或空点仍回退旧路径（定位测旧快照 / 默认
  `A2–B1`）。
- 单档带照常参与 `level_distance` / `content_band_distance` / `match_score`：
  同档距离 0、相邻一档 1；`basis.source` 仍为 `profile`，`basis.band` 可能
  呈现为 `B1–B1` 这类单档标签，理由文案沿用原规则（如「适合你的 B1 水平」）。
- 效果：种子用户不再因为 C2 上界被整条链路推回默认 `A2–B1`；这是
  「没有区间时宁可用点估计」的降级，不生成新数据、不调用模型。

## 分级口径与发布一致性（P2-46，2026-11-26）

### 三种等级，不许混用

- **编辑级（editorial）**：内容 JSON 的 `level`（人工标注，A1–C2）。
  `GET /api/library*` 的 `level` 只回传它；没有算法行时，前端也用它兜底。
- **算法级（computed）**：`content_difficulty.cefr_input`（`difficulty.v1` 规则
  计算，0 LLM，A1–C1+）。`GET /api/content/difficulty` 的 `cefrInput` 只回传它。
- **展示级（display）**：前端徽章 `cefrInput ?? editorial`，不是第三种数据源：
  `source=computed` 显示算法级，`source=legacy` 回退编辑级。

编辑级与算法级允许相差一档，**不互相覆盖**：禁止把 `cefr_input` 改成编辑级来
「对齐」，也禁止把内容 JSON 的 `level` 改成算法级。两套数字都保留，才能区分
「人怎么标」与「算法怎么估」。

### 本地/线上不一致的排查顺序

先查数据覆盖，再查代码：

1. `GET /api/content/difficulty?kind=article&ref=<id>` 看 `source`：
   `computed` = 该环境有算法行；`legacy` = 缺行/表未迁移，回退编辑级。
2. 只读对比（不写库、不改缓存）：

   ```bash
   backend/venv/bin/python scripts/content-difficulty-backfill.py \
       --api-base https://linguatrekai.online
   ```

   报告写 `data/reports/content-difficulty-audit.json`（已 gitignore），包含每条
   的 `editorialLevel/computedLevel/localDisplay/remoteDisplay`、`summary` 与
   `plan`（`localMissing`/`remoteMissing`/`outsideAlgorithm`）。
3. 只有两端 `content_difficulty` 覆盖一致，才可能显示一致；否则先按 `plan`
   回填，不要改内容 JSON 去「凑」线上的数字。

### 现状（2026-11-26，HEAD f3d90f8 实测）

- 本地库：152 条 serving 中 147 条有算法行，5 条 C2 视频（`ted-*` ×4 +
  `bloomberg-ganges-cleanup`）不在算法域内，回退编辑级 C2 是设计行为。
- 线上库：152 条全部 `source=legacy`（`content_difficulty` 无数据），所以同一篇
  `free-app-hidden-cost` 本地显示算法级 B1、线上回退编辑级 B2——**不是内容 JSON
  写错，也不是两套代码**（线上 `/healthz` 迁移已到 head，前端 bundle 也含
  difficulty 逻辑；差异在数据库数据）。
- 若线上按本地数据回填：124 条展示等级会从编辑级变为算法级；其中档差
  ≥3 的 10 条（如 `eci-play-verb` 编辑 A1 / 算法 C1+）应先做教研复核，再决定
  是否整体上线算法徽章。

### 回填/发布步骤

1. **先备份**生产库（部署手册 §7），再确认迁移 `current=head`（0016 建表只建
   表，不产生数据）。
2. 在目标环境跑只读对比，确认 `plan.localMissing`/`plan.remoteMissing`；C2 的
   `outsideAlgorithm` 条目不要写算法行（`difficulty.v1` 没有 C2 输出域）。
3. 只对 `plan` 列出的算法域内条目做 `difficulty.recompute`。**不要直接跑全量
   回填脚本**：它会把 5 条 C2 也写成 computed（`level=null`），把 C2 徽章换成
   更低的算法带。等 C2 策略定了再放开。容器内按清单回填（先备份）：

   ```bash
   docker compose run --rm -T app python - <<'PY'
   import json, sys
   sys.path.insert(0, "/app/backend")
   import difficulty
   report = json.load(open("/data/reports/content-difficulty-audit.json"))
   plan = report["plan"]["localMissing"]  # 或 remoteMissing
   ok, failures = 0, []
   for item in plan:
       try:
           difficulty.recompute(item["kind"], item["ref"])
           ok += 1
       except difficulty.DifficultyError as exc:
           failures.append(f'{item["kind"]}:{item["ref"]} {exc}')
   print(f"recomputed {ok}, failed {len(failures)}")
   print("\n".join(failures[:10]))
   PY
   ```

   `plan` 只含算法域内条目，C2 不会进来。管理员 API 也可（每批 ≤50）。
   若 `curated` 因缺 `CURATED_SUBTITLES_DIR` 字幕缓存失败，先把构建期
   `data/curated-subtitles/*.json` 部署到目标机的对应目录再重跑；只补
   video/article 时，可推荐池仍有 117 条，供给 gate 仍 ≥100。
4. 回填后重跑第 2 步：`summary.remote.displayMismatch` 应对 video/article 为 0；
   `curated` 若缺字幕缓存会保持 legacy（本地/线上各 25 条展示差异），需另行
   部署 `data/curated-subtitles` 或接受推荐池少 30 条。公开难度接口
   `Cache-Control: max-age=3600`，验收时用 cache-buster 或等 1 小时，别把 CDN
   旧值当新数据。
5. 本地与线上都做同一步，且内容/频表版本一致；只修一边会制造新的不一致。

### 生产容器注意

生产镜像只 COPY `backend/` 与 `content/`，**不含 `scripts/`**（Dockerfile 现状）。
只读对比可以直接在本地 checkout 跑（`--api-base` 指向线上，不能访问数据库也能
得到线上 `source/cefrInput`）。要在目标环境容器里跑对比/写库，需先发布包含
`backend/content_difficulty.py` 的镜像，并把 scripts 只读挂进容器：

```bash
cd /srv/ln/app
docker compose run --rm -T -v /srv/ln/app/scripts:/app/scripts:ro app \
  python /app/scripts/content-difficulty-backfill.py --out /data/reports/content-difficulty-audit.json
```

报告落在 `/data`（唯一持久卷），再用它生成回填清单。不要在容器内 `pip install`
或改镜像内容。

## 验收标准

- [ ] 给定 `content/wordlist/frequency_bands.v1.json`，当跑
      `build_wordlist.py --check`，则返回 0 且打印 lemma 数/许可/hash。
- [ ] 给定同一频次输入，当连续构建两次，则产物字节一致；篡改任一条目后
      `--check` 返回 1。
- [ ] 给定 A2/B1/C1 三条 golden 文本，当计算 features，则
      `est_cefr.read` 分别为 A2/B1/C1（`tests/fixtures/difficulty_golden/`）。
- [ ] 给定空文本 / 无标点 / 自动字幕 / 超长文本，当计算，则不崩溃：
      空文本 `cefr_input=null`、无标点 `asl=null` 且 `available=false`、
      自动字幕句法字段为 null、超长文本仍可算且 UTR 单调。
- [ ] 给定迁移 0016，当 upgrade/downgrade/re-upgrade，则表/索引/约束正确，
      重复 upgrade 幂等，downgrade 只删本表。
- [ ] 给定 70 条 serving（3 视频 + 67 文章）+ 30 条 curated，当跑回填，则写入
      100 条、覆盖率 100%、报告含按 kind/band 分布与失败原因；第二次跑全部 skipped。
- [ ] 给定 curated 视频无英文字幕/超时，当跑 `backfill_curated_transcripts.py`，
      则写一条 `available=false` 占位行（`cefrInput=null`、features.available 全
      false），报告保留原因，不伪造等级；不落任何字幕原文。
- [ ] 给定 64 篇 Gutenberg 公版短文，当跑回填，则逐篇算出 `cefrInput`；内容侧
      有 `gutenbergId/sourceUrl/publicDomainBasis`，正文 250–400 词且逐段 en+zh。
- [ ] 给定有难度行，当 `GET /api/content/difficulty`，则 `source=computed`、
      features 完整、`cefrInput` 非空；给 `band=B1` 时带 `utrBand`/`bucket`。
- [ ] 给定没有难度行/库未迁移，当 GET，则 200 + `source=legacy` + 编辑 level。
- [ ] 给定 content 不存在，当 GET/batch，则 404；batch >50 → 400。
- [ ] 给定管理员身份，当 POST recompute，则 upsert 成功且幂等；非管理员 403、
      未登录 401。
- [ ] 给定可推荐内容 ≥100 条且有难度行，当 `GET /api/recommendations`，则
      条目带 `difficulty`，理由含「与你当前词汇区间接近」，无「个性化」。
- [ ] 给定可推荐内容 <100 条（供给 gate 关闭），当 `GET /api/recommendations`，
      则完全回退旧的 `level_distance` 规则、不返回 `difficulty`；gate 状态写进
      `docs/reports/content-supply-2026-11-17.json`。
- [x] （v1.1 D8-2）给定种子画像（`low/high=null`），当 `GET /api/recommendations`，
      则用词汇点估计当单档带（限 A1–C1），不落入默认 `A2–B1`。
- [ ] （P2-46）给定本地有算法行、线上缺行的同一内容，当跑只读对比，
      则报告两端 `localDisplay`/`remoteDisplay` 与 `plan.remoteMissing` 可核对，
      且脚本不写库；回填按 `plan` 只覆盖算法域内条目（C2 保持编辑级）。
- [ ] 前端 `npx tsc -b` / `npm run check:i18n` 通过；mock Playwright 断言
      免费资源卡片出现难度徽章与生词桶；推荐卡在 gate 开时才出现。

## 边界与非目标

- **不做** C2 定级；`C1+` 合并展示（K15）。
- **不做** 用户侧 `utr_user`（M3 需要 `word_states ≥100–200`）；M2 只有
  带级量 `utr_band`，文案统一「按你的等级估算」，**禁止「个性化」**（K17）。
- **不做** 80/10/10 探索位：可推荐内容现为 **100 条**（3 视频 + 67 文章 + 30 curated，
  其中 64 篇为 Gutenberg 公版短文），供给 gate 已按「eligible ≥100 自动开」启用
  （`match_v0`）；若日后跌回 <100 条则自动回退旧规则。探索位仍留到 M3。
- **不做** 60–100 条锚集与 holdout（M2 教研工作，本规格只交工程管线）；
  当前用 36 条编辑标注做对照：36 条中 ±1 带 26 条（约 72%，完全一致 7 条），**不对外宣称准确率**。
- **不做** 文化负载自动识别（先置 0 / 人工）；`idiom_density` 是自建短语表
  近似，只记录不决策。
- **不做** local_show（SRT）入口；`kind=local_show` 暂返回 404，后续按同一
  接口补。
- **频表局限**：wordfreq 是大小写归一的语料频次，专名/人名会混入尾部；
  CEFR 锚点切点（1k/2k/4k/7k/10k）是 v1 先验，等锚集校准。详见
  `content/wordlist/NOTICE.md`。
- **许可**：产物 CC BY-SA 4.0（share-alike），可商用；署名见 NOTICE。
  若产品要求不能 share-alike，需替换数据源并重跑构建/回填。

## 版本与变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-17 | 首版实现：频表 v1（wordfreq 3.1.1，10k lemma）、迁移 0016、difficulty 规则管线、36 条回填、公开/批量/admin API、推荐 match_score、前端徽章与生词桶 |
| 2026-11-17 | 内容供给补齐：新增 30 篇 Gutenberg 公版短文（总 64 篇），回填后 `content_difficulty` 可推荐 **100 条**（3 视频 + 67 文章 + 30 curated），供给 gate 开启（`match_v0`），报告见 `docs/reports/content-supply-2026-11-17.json` |
| 2026-11-21 | v1.1 D8-2：种子画像不出带，推荐改用词汇点估计当单档带（A1–C1），不再回退默认 `A2–B1`（见 [specs/025](../025-ability/spec.md)） |
| 2026-11-26 | P2-46：明确编辑级/算法级/展示级三种口径不混用；新增只读对比 `backend/content_difficulty.py` + `scripts/content-difficulty-backfill.py`（报告含 `plan`，不写库）；给出生产回填/缓存/容器步骤。线上 `content_difficulty` 全缺行，故同一文章本地算法 B1、线上回退编辑 B2 |
