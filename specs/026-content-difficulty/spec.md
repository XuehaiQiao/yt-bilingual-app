# 规格：内容难度向量与 i+1 匹配（CEFR M2）

> 规格只讲**做什么**和**为什么**，不讲怎么实现。总依据：
> `docs/项目计划-CEFR能力标定.md` §6 / §7.2 / §7.4 / §10.2。

**状态：** 已实现（后端 + 内容 + 最小前端） ｜ **对应代码：** `backend/difficulty.py`、`backend/routes_difficulty.py`、`scripts/build_wordlist.py`、`scripts/backfill_content_difficulty.py`、`scripts/backfill_curated_transcripts.py`、`scripts/content_supply_report.py`、`content/wordlist/`、`content/library/gutenberg-manifest.json`、`backend/migrations/versions/0016_content_difficulty.py`、`frontend/src/lib/difficulty.ts`

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
