# UI 设计基线（2026-11-19，W5b）

> **这不是门禁通过。** 本报告只记录两个 **report-only** 扫描脚本在 **HEAD `2a821d7` 提交树**上的存量计数、热点与复核命令；本轮（W5b）**不修 UI、不接 CI、不改 PR 流程、不清理任何一条存量**。
>
> **存量口径**：A1 审计 **90 条**（P0 7 / P1 44 / P2 39）是人工审计口径，仍是既有债务；下表是**脚本机械口径**，两者不是同一单位，不能相减、不能互相替代。
>
> 脚本：`scripts/check-design-tokens.mjs` v1.0、`scripts/check-ui-selectors.mjs` v1.0。二者均**未接 CI**，默认退出码 0；`--fail` 才在 P0/P1 > 0 时返回 1。

---

## 1. 快照与口径

| 项 | 值 |
|---|---|
| 日期 | 2026-11-19 |
| HEAD | `2a821d7`（`feat(ui): standardise toast timing, queueing and position`） |
| 扫描对象 | HEAD 提交树的 `frontend/src/**/*.{tsx,css}`（token）与 `frontend/src/**/*.{tsx,ts}`（selector） |
| 为什么用 HEAD | W5b 与 B3/B4/B5 并行；工作区可能含其他批次未提交改动。用 HEAD 提交树，计数可稳定复核 |
| 单行口径 | 「命中行数」= 去重后的源码行；同一行可命中多条规则（`规则命中` 会更大）。P0/P1/P2 按该行**最高**级别归类 |
| 不算通过 | `--baseline` 是存量汇总，没有 PASS 语义；只有 `--diff <base>` 的新增行计数才接近 PR 口径 |

**A1 90 条 vs 本表**：A1 的 90 条按「审计问题」计数，本表按「源码命中行/旧常量定义」计数。例如一处 `blue-*` 审计项可能对应 40 个文件里的多行；一条旧常量审计项也可能对应多个文件里的同名定义。**不得**用本表数字宣称「90 条已清」或「门禁自动通过」。

> 另：`design-gate.md` §8 的「35 hex / 87 `text-zinc-600` / 473 `blue-*` / 56 `z-*` / 93 越阶字号 / 5 `shadow-[`」是更早的 occurrence/审计口径，且包含本轮未扫描的 T-03 `text-zinc-600`；不要与本表的「行」直接对比。

---

## 2. 复核命令

### 2.1 HEAD 快照（与下表数字一致）

```bash
# 在仓库根执行：用临时 worktree 固定到 HEAD，再拷入两个未提交的脚本
git worktree add --detach /tmp/yt-w5b-baseline 2a821d7
cp scripts/check-design-tokens.mjs scripts/check-ui-selectors.mjs /tmp/yt-w5b-baseline/scripts/

(cd /tmp/yt-w5b-baseline && node scripts/check-design-tokens.mjs --baseline)
(cd /tmp/yt-w5b-baseline && node scripts/check-ui-selectors.mjs --baseline)

# 需要机器可读时
(cd /tmp/yt-w5b-baseline && node scripts/check-design-tokens.mjs --json --baseline)
(cd /tmp/yt-w5b-baseline && node scripts/check-ui-selectors.mjs --json --baseline)

git worktree remove /tmp/yt-w5b-baseline
```

### 2.2 当前工作区（会混入并行批次未提交改动）

> 核对本文数字请用 §2.1；§2.2 是日常使用命令。若工作区有 B3/B4/B5 未提交改动，数字会与本文不同（通常更低），这是预期，不是脚本不稳定。

```bash
node scripts/check-design-tokens.mjs --baseline
node scripts/check-ui-selectors.mjs --baseline
node scripts/check-design-tokens.mjs --json
node scripts/check-ui-selectors.mjs --json

# 只看新增行（PR 口径；未来接 CI 的候选命令）
node scripts/check-design-tokens.mjs --diff origin/main
node scripts/check-ui-selectors.mjs --diff origin/main

# 自测（开发用；失败退出码 1）
node scripts/check-design-tokens.mjs --self-test    # 当前 45/45 PASS
node scripts/check-ui-selectors.mjs --self-test     # 当前 27/27 PASS
```

---

## 3. Token 扫描基线

范围：`frontend/src/**/*.tsx|css`，71 文件 / 31,299 行（HEAD 树）。`frontend/src/index.css` 是 token 定义源，**T-01 整文件豁免**。

**合计：846 行命中（P0 337 / P1 471 / P2 38）；规则命中 932 次（可重叠）；涉及 58 文件。**

| 规则 | 级别 | 命中行数 | 文件数 |
|---|---|---:|---:|
| T-01 裸 hex / rgb() / hsl() | P0 | 41 | 28 |
| T-04a `blue-*` / `purple-*` 残留 | P0 | 233 | 41 |
| T-06 `text-[9px]` / `text-[10px]` | P0 | 68 | 29 |
| T-08a `z-[N]` 任意层级 | P0 | 4 | 3 |
| T-04b `violet-*` / `sky-*` / `pink-*` 残留 | P1 | 6 | 6 |
| T-05 任意字号 `text-[…]`（9/10px 单列 T-06） | P1 | 468 | 49 |
| T-07 `shadow-*`（`elev-1/2/3` 与 `none` 除外） | P1 | 25 | 17 |
| T-08b `z-<数字>`（8 个 token 之外） | P1 | 36 | 19 |
| T-11a `h-8`/`h-9` + `rounded-xl` | P2 | 46 | 22 |
| T-11b `h-10` + `rounded-full`（hero 除外，人工确认） | P2 | 1 | 1 |
| T-14 `transition-all` | P2 | 1 | 1 |
| T-15 `hover:scale-*` / `active:scale-[0.95]` | P2 | 3 | 3 |

### 3.1 热点文件（按命中行数，前 10）

| 文件 | 命中行 | P0 | P1 | P2 |
|---|---:|---:|---:|---:|
| `frontend/src/components/CourseScreen.tsx` | 52 | 22 | 29 | 1 |
| `frontend/src/components/PlacementScreen.tsx` | 49 | 23 | 26 | 0 |
| `frontend/src/components/AbilityScreen.tsx` | 43 | 12 | 29 | 2 |
| `frontend/src/components/VocabularyBookScreen.tsx` | 43 | 10 | 32 | 1 |
| `frontend/src/App.tsx` | 37 | 24 | 12 | 1 |
| `frontend/src/components/TodayWorkbench.tsx` | 36 | 18 | 16 | 2 |
| `frontend/src/components/ExamScreen.tsx` | 35 | 15 | 19 | 1 |
| `frontend/src/components/BookReaderScreen.tsx` | 32 | 11 | 21 | 0 |
| `frontend/src/components/AdminConsoleScreen.tsx` | 30 | 7 | 21 | 2 |
| `frontend/src/components/ImportedBookReaderScreen.tsx` | 29 | 8 | 21 | 0 |

### 3.2 本轮覆盖边界（重要）

- **已覆盖**：T-01、T-04a/b、T-05、T-06、T-07、T-08a/b、T-11a/b、T-14、T-15。
- **未纳入**：T-02 `border-white/5|10`、T-03 `text-zinc-600`、T-09 `h-screen`/`Nvh`、T-10 `zinc-900` 透明度、T-12 `focus:outline-none`、T-13 三处底色、裸 `transition`。这些仍由 `scripts/gate-receipt.mjs`（diff 级 G1/G6/T-13）与人工评审覆盖；不纳入本轮的另一个原因是不把与 W5b 规则无关的存量混进基线。
- **行级正则**：只给候选；注释、字符串常量、输入壳例外等可能误报。不是 AST，也不做运行时计算。
- **不扫** `*.ts`（如 `lib/*.ts` 的 `CHUNK_STYLE` 例外）；`--diff` 也只扫 `.tsx`/`.css`。

---

## 4. Selector 扫描基线

范围：`frontend/src/**/*.{tsx,ts}`（116 文件），并扫描 `scripts/*.mjs` 的 `data-testid` 选择器（HEAD 树 65 个；all resolved）。

**合计：53 个 P1 问题（P0 0 / P2 0）；其余项为 0。**

### 4.1 旧常量定义（P1）

**53 处 / 21 文件**。只统计**定义行**；`className={PRIMARY_BUTTON}` 这类 usages 不重复计数。

- 按名称：`CARD`×13 / `SECONDARY_BUTTON`×9 / `PRIMARY_BUTTON`×7 / `OPTION_BASE`×4 / `GHOST_BUTTON`×3 / `ACTION`×2 / `CARD_ICON`×2 / `DANGER_BUTTON`×2 / `ENTRY_ACTION`×2 / `COMPACT_BUTTON`×1 / `PAGE_BUTTON`×1 / `PRIMARY_CTA`×1 / `ROW_BUTTON`×1 / `SECONDARY_CTA`×1 / `SECTION_TITLE`×1 / `SUB_CARD`×1 / `SUCCESS_BUTTON`×1 / `TINTED_BUTTON`×1。
- 热点文件：`AbilityScreen.tsx`×5 / `AdminConsoleScreen.tsx`×5 / `ExamScreen.tsx`×5 / `PlacementScreen.tsx`×5；`CourseScreen.tsx`×4 / `TodayWorkbench.tsx`×4 / `WelcomeScreen.tsx`×4；`VocabularyBookScreen.tsx`×3；`BlogScreen.tsx`×2 / `PracticeScreen.tsx`×2 / `QuizScreen.tsx`×2 / `ReportScreen.tsx`×2 / `ReviewScreen.tsx`×2；其余 8 个文件各 1 处。

### 4.2 重复组件 / 冻结选择器

| 项 | 结果 | 级别 |
|---|---|---|
| `components/ui/` 外同名文件或同名导出 | **0** | P1（若出现） |
| 冻结契约属性 | **4/4 存在**：`data-word-hit`×5、`data-lookup-context`×8、`data-lookup-start`×6、`data-highlight`×1 | P0（若缺失） |
| 冻结关键 testid | **20/20 存在**（`app-shell`、`word-popover*`、`book-series-*`、`reader-scroll`、`reader-highlight-toggle`、`start-mode-select`、`video-url-input`、`share-card-dialog` 等） | P1（若缺失） |

### 4.3 testid 清单（提示项）

| 项 | 值 |
|---|---:|
| 静态唯一 testid（含 `data-testid` 与 `testId` prop） | 729 |
| 动态模板（含 `` `${…}` ``） | 117 |
| `scripts/*.mjs` 依赖的选择器（HEAD 树） | 65 |
| 无法静态解析 | 0 |

**限制**：动态拼接的 testid 只能按前缀/后缀反查；静态扫描不启动浏览器，不证明运行时一定存在。`--diff` 模式下只对新增行里的旧常量和新增组件文件计数，冻结项仍按全量检查。

---

## 5. 结论

1. **不是门禁通过**：本报告没有 PASS 语义；`gate-receipt` 仍是 PR 回执，P0 仍由评审按 `design-gate.md` §3.1 判定。
2. **没有修任何存量**：A1 的 90 条（P0 7 / P1 44 / P2 39）原样保留；W5b 只新增扫描脚本、基线报告与 `design-gate.md` 附录说明，未改 UI、i18n、CI、PR 模板。
3. **数字会随批次变化**：B3/B4/B5 每落地一批，token 的 `blue-*`、字号、`h-9 rounded-xl` 与旧常量计数会下降；请在各批出口用 §2.1 的 HEAD 快照命令重跑，并刷新本报告或新开一份。
4. **下一步（不属于 W5b）**：先清基线，再按 `design-gate.md` §4.3 的三步节奏（本地绿 → CI 只报告 → CI 阻断）接 CI；接之前需 lead 同意，且误报率 <5%。

---

*脚本自测：token 45/45 PASS，selector 27/27 PASS。相关文档：[`design-gate.md`](../design-gate.md) 附录 B/C、[`design-system/tokens.md`](../design-system/tokens.md) §13、[`component-consolidation.md`](../component-consolidation.md) §5.4。*
