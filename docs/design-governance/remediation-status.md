# W0 + W6 执行状态（文档对齐与 A4 映射修正）

> 日期：2026-11-19 ｜ 执行：W0（文档对齐）+ W6（A4 映射修正） ｜ 仓库：`yt-bilingual-app`
> 范围：**只改 `docs/design-governance/**` 与本文所引的 IA 文档**；W0 未改 `frontend/`、`backend/`、`.github/`（同 worktree 中 `frontend/` 的改动来自 W1/W2/W3 并行分工，见 §4.4）；**未 git 提交**。
> 上游计划：[`remediation-plan.md`](./remediation-plan.md) §W0/§W6 ｜ 交叉审阅：[`reviews/a1..a5-cross-review.md`](./reviews/)
> 结论：**W0 与 W6 的文档项已完成**；W1–W5 不在本交付范围（完成状态以各自 handoff 为准），不能据此关闭 P0 或宣布「UI/UX 治理完成/可上线」。


## 2026-11-19 执行更新（W0–W5 主要路径与全部 P0 已落地）

> 本文件 §1–§6 是 W0 交付时的快照；以下为并行执行后的最新状态，覆盖快照中的「未完成」。

| 工作流 | 状态 | 证据 / 仍未关 |
|---|---|---|
| W1 导航 B0 | ✅ 已实现 | `nav.ts/useNav/App` 全前缀、push/back、锚点、login next；`check-nav` 12/12、`check-nav-e2e` 10/10。**N-01 仍剩 BlogScreen 不接受 slug，深链显示列表；N-08 阅读器列表→文章未动** |
| W2 V-06 | ✅ 默认可见 31 键已中文化 + CJK 规则 + 负例 | `check:i18n` 绿；31/31 + `sentences.day`；14 个死键仍在白名单（InputScreen 未删），待 QA-X-25 清理 |
| W3-B1 基座 | ✅ | tokens/index.css/lib/`ui/Button`/AccountScreen 最小切片；tsc/build/ESLint 绿 |
| W3-B4-P0 三态 | ✅ | 新 `ui/StateView`；TodayScreen/ContentScreen/RecentLearning/TodayWorkbench 失败→错误面板+重试；Playwright 32/32 |
| W4 L-01 | ✅ | 移动学习页单滚动；删 52vh/内层滚动/pb-[45vh]；375/390/430 Playwright 200/200；桌面回归通过 |
| W5 门禁加固 | 🟡 文档/脚本已交付 | 证据绑 SHA、`scripts/gate-receipt.mjs`（report-only，自测 42/42）、G1/G2/G4 扩面、QA-X-02 全 14 浮层、NAV-21/X-29/30/31、QA 119 条；**仍未落地**：`/dev/ui` 矩阵、浏览器对比度实测、token/selector 自动扫描 |

**当前仍未关闭的 P0**：N-01（博客 slug）、I-01（失败当空态）、I-02（频道弹窗键盘）、L-01（移动双滚动）。N-02/N-03/N-18 已由 W1 覆盖（需以 e2e 为准）；V-06 默认可见键已关闭，死键清理是上线前收尾项（旧 QA-X-25，已迁出）。

**下一批**：W4 + W3-B2/B4-P0（可并行，文件边界需约定）；W5 的 `/dev/ui` 矩阵、浏览器对比度实测、token/selector 自动扫描随 W3/发布前 QA 收尾；完成后重新跑门禁 3/4 验收。

---

## 1. W0 已完成项（11/11）

| # | 项 | 落点 | 状态 | 复核 |
|---|---|---|---|---|
| 1 | V-06 统一 **31 键** + `sentences.day` 裁决 | A4 `G0` 由 5 行扩为 12 行（补 7 键）；A2 `audit-response.md`、A4 摘要/§5.3、A5 QA 附录 A、`design-gate.md` §3.2/§4.3 全部 31；A1 初审计 24 保留为历史 | ✅ | `grep -rn "31 键" docs/design-governance/*.md`；A4 `rows=222` |
| 2 | Toast 统一 A3 | A2 C8：三型、success 3s / info 5s / error 8s、5s 去重、最多 3 条可见 + FIFO 排队；A4 C8/B2 出口同步；QA-X-07 写明数值与证据 | ✅ | A2 C8、A4 C8、QA-X-07 |
| 3 | EmptyState 尺寸规则 | A2 C10：`page(py-16) / card(py-10) / inline(py-3)`；A3 IX-04 同口径；A4 C10 + G12-01/02/03/08；layout §7.2；QA-X-06 | ✅ | 文档内 `py-16/py-10/py-3` 三档一致 |
| 4 | BackButton `parentLabel` / aria 父级 | A2 C12 增加 `parentLabel`、`nav.backTo`、与 A3 `backLabelFor` 一致的 aria 公式；A4 C12 同步；QA-NAV-12 已含「aria 含父级名」 | ✅ | A2 C12 API/ARIA、A3 NM §5.1 |
| 5 | 页面级 X vs BackButton | A2 C12 L-09 删「关闭」；A2 layout §6.1 删 X；A4 G8-17/§5.2 改为「只留返回+标题」；明确业务退出按 IX-24（Exam/Placement 确认框），不是导航关闭 | ✅ | `grep -rn "返回 + 标题 + 关闭" design-system/ component-consolidation.md` = 0 |
| 6 | Dialog 契约补齐 | A2 C4：`alertdialog` / `fullscreen` / `loading` / `error` / `dirty` / `onBeforeClose`；行为契约补 dirty 先确认、嵌套先关再开；A3 IX-09 同步；A4 C4 props/状态同步；QA-X-02 增加检查 | ✅ | A2 C4、A3 IX-09、A4 C4 |
| 7 | 词卡删 hover 切词 | A3 IX-21 删除「hover 120–200ms 切词」；改为点击/触屏/键盘切词，hover 只做视觉；A2 C13、A4 C13 明确「仅键盘打开时焦点入卡、非模态不锁滚动」 | ✅ | `grep -rn "120–200ms\|120-200ms" interaction-spec.md` = 0 |
| 8 | Segmented 边界统一 | A2 C6、A3 IX-19、A4 C6/B5、QA-X-12 统一 **2–5 项**；>5 用 Tabs/Menu | ✅ | 三份文档同口径 |
| 9 | 移动端双壳 / tab 序 | A2 C11：可见顺序 **内容/练习/今日/我的**（D-08，默认落地今日）；手机所有子视图不保留全局壳，桌面面板型保留 Sidebar + 面包屑（D-03）；layout §2.4 同步 | ✅ | A2 C11、layout §2.4、NM §1.4 |
| 10 | IA 旧模型标废止 | `docs/信息架构-导航重构.md` §7.2/§7.3/§8.2 各加「已废止」块并指向 `navigation-model.md`；旧 `#/learn/...` 行改为 `#/<tab>/...` + 兼容说明；「栈深恒 1」段落显式废止 | ✅ | `grep -n "已废止（2026-11-19 W0" docs/信息架构-导航重构.md` = 3 |
| 11 | QA 5 条错值 + 去重/迁出 | 5 条值在 HEAD `5996289` 已修正，W0 复核无回退；删除 3 对重复；迁出 12 条无审计 ID；6 条不可判定 = 4 条改写可测 + 1 条迁出（X-25）+ 1 条随无审计迁出（X-26）；**131 → 115 条** | ✅ | 本文 §4 命令 |

### 1.1 关于 5 条 QA 错值的说明

`QA-NAV-13`、`QA-ASM-06`、`QA-ADM-07`、`QA-ADM-05`、`QA-X-12`、`QA-X-11`、`QA-VOC-07` 在 HEAD `5996289` 已按交叉审阅修正（管理台独立壳、页面级不用关闭 X、offset 在调用方、`/80 + text-caption`、触控 ≥44）。W0 逐条复核，当前值正确；本次未再改这些行的值，只补了它们的**相邻契约**（如 QA-X-12 的 2–5 项边界）。

### 1.2 V-06 裁决（`sentences.day`）

- **V-06 计数口径**：31 键（A1 初审计 24 + A5 复核 7），清单见 QA 附录 A.1/A.2。
- **`sentences.day`（"Day {{day}}"，`SentenceView.tsx:197`）**：裁决为**用户可见英文，W2 同批中文化**；它是第 32 条，但**不计入 31 键**，也**不得进入 CJK 白名单**（否则 CI 规则永久红）。
- 白名单由 14 键补为 **21 键**（+6 个 `home.vocabLevel.*.label` CEFR 标签 + `vocab.phrases.source.ecdict`）。

---

## 2. W6 已完成项

| 项 | 原值 | 修正后 | 落点 |
|---|---|---|---|
| A4 映射行 | 217（含 7 条 G22 保留 + 2 别名） | **222 行 = 221 可执行/登记 + 1 保留别名**；G22 的 7 行移至 §3.23（R-01..R-07，不计入） | A4 §3 / §6.5 |
| 漏项 | 0 行 | **+8 行**：`DiscoverScreen:371/382/392/474/483`（G12-23..27）、`StartLearning:162`（G1-25）、`PlacementScreen:975/1245`（G1-26/27） | A4 §3 |
| V-06 G0 | 24 键 / 5 行 | **31 键 / 12 行**（G0-06..G0-12） | A4 G0 |
| 越界行号 | 7 处 | 全部修正：`SentenceText.tsx:19-39`、`lib/navTabs.ts:33-35`、`ReadingHighlight.tsx:32-88` | A4 §6.5b |
| 重复行 | 3 行 | 删除 G16-13/14/15（与 G11-09/10/11 重复），G16 15→12 | A4 §3 G16 |
| G22 保留行 | 计入 217 | 移出 §3；「实际迁移 208」写入基线算术，不再把保留当迁移 | A4 §3.23 / W6 修订 |
| B4 内联卡 | 61 | **56**（61 含 `InputScreen` 死代码 5；B1 删除） | A4 §0.1/G2-15/B4/附录 A |
| 批次重排 | B3/B4 可并行；B2 依赖倒置 | B1 与 W1/B0 导航并行；B2 拆 P0（20 行）+ 尾行 G3-02（等 B4-P0）；B4 先做 P0（4 行 + StateView）再做其余；**B3→B4 其余→B5 串行** | A4 §4.0/§4.6 |
| 别名承诺 | `export { 新 as 旧 }` 即兼容 | 改为**薄兼容适配器**（`WordPopover`→`WordCard`、`VocabPagination`→`Pagination`），1 个 PR 内过 tsc + 脚本；做不到就撤回承诺、改全部调用点 | A4 B4 / §5.5 |
| 文档自我修正 | 217 全对 | 文首 **W6 修订** 明确「原 217 不是全部正确」，列出所有修正 | A4 文首 |

---

## 3. 剩余工作（W1–W5，按 W0 交接口径）

| 工作流 | 状态（W0 写作时） | 说明 |
|---|---|---|
| **W1 · 导航 B0** | ❌ W0 范围外 | `nav.ts` 全前缀/`SectionAnchor`/`parentOf/backLabelFor`、`useNav.dshNav.depth`、`App` push、legacy 别名、测试。W0 只改了文档（IA 标废止、NM 契约就绪）。 |
| **W2 · V-06 P0** | ❌ W0 范围外 | 31 键 + `sentences.day` 中文化、`check-i18n.mjs` CJK 规则、白名单 21 键、删 14 死键、`v06-keys.json`。W0 只定了口径。 |
| **W3 · 组件收敛首批** | ❌ W0 范围外 | tokens/`lib/cn`/`ui/Button`/B1 切片、B2 Dialog/Toast、B4-P0 StateView；A4 的适配器/批次出口脚本均未实现。 |
| **W4 · L-01 移动单滚动** | ❌ W0 范围外 | 52vh/内层滚动/pb-[45vh] 未动；375/390/430 真机未验。 |
| **W5 · QA/门禁加固** | 🟡 文档/脚本已交付（见上表） | 证据绑 SHA、`scripts/gate-receipt.mjs`（report-only）、G1/G2/G4 扩面、QA v1.2（含 14 浮层/新增 4 条/附录 F/G）已落地；`/dev/ui` 组件矩阵、浏览器对比度实测、token/selector 自动扫描未落地。 |
| **W6 的 CI 部分** | ⚠️ 仅文档 | 行号存在/唯一检查已写进 A4 §6.5 Python 自查脚本，但**未接入 CI**，也不是产品代码。 |

**仍未关闭的 P0（按 W0 交接口径）**：V-06（31+1 键）、N-01/02/03、N-18（导航文档已定、代码未按本文件验收）、L-01、I-01/I-02（A4 只定批次）。**不得**以 W0/W6 完成宣布可上线。

> 注：本文件是 **W0 的文档交付快照**。同一 worktree 中可能已有 W1/W2/W3 并行分工的产品代码改动（`git status` 可见）；它们是否完成以各自 handoff 为准，本文件不替它们宣布完成。

---

## 4. 可复核命令与统计

> 全部在仓库根目录执行；只读文档/源码，不需要启动服务。

### 4.1 A4 映射表（期望 222 / 0 / 0 / 0）

```bash
cd /Users/piece/Desktop/Me/EnglishLearning/yt-bilingual-app
python3 - <<'PY'
import re, os, glob
acts = ('替换','包裹','保留别名','改名','保留','删除')
paths = {}
for p in glob.glob('frontend/src/**/*', recursive=True):
    if os.path.isfile(p): paths[os.path.basename(p)] = p
rows = bad = dup = out_of_range = 0
seen = set()
for i, line in enumerate(open('docs/design-governance/component-consolidation.md', encoding='utf-8'), 1):
    if not re.match(r'^\| G\d+-\d+ \|', line): continue
    rows += 1
    c = [x.strip() for x in line.strip().strip('|').split('|')]
    rid = c[0]
    if rid in seen: dup += 1; print('DUP', i, rid)
    seen.add(rid)
    ok = (len(c) == 8 and any(a in c[3] for a in acts)
          and c[5] in ('P0','P1','P2','**P0**')
          and re.match(r'^\d+(\.\d+)?$', c[6].split('（')[0].strip())
          and re.match(r'^V\d$', c[7]))
    if not ok: bad += 1; print('BAD', i, c[:2])
    for f, a, b in re.findall(r'`([A-Za-z0-9_./-]+\.(?:tsx|ts)):(\d+)(?:-(\d+))?`', line):
        p = paths.get(os.path.basename(f))
        if not p: continue
        n = sum(1 for _ in open(p, encoding='utf-8', errors='ignore'))
        hi = int(b) if b else int(a)
        if int(a) < 1 or hi > n:
            out_of_range += 1; print('OUT_OF_RANGE', i, f'{f}:{a}' + (f'-{b}' if b else ''), f'actual={n}')
print(f'rows={rows} bad={bad} dup={dup} out_of_range={out_of_range}')
PY
# 期望：rows=222 bad=0 dup=0 out_of_range=0
```

### 4.2 QA 项数与审计覆盖（期望 115 / 51 / 缺失 0）

```bash
cd docs/design-governance
grep -cE '^\| QA-[A-Z]+-[0-9]+ \|' design-qa-checklist.md        # 115
grep -oE '^#### (V|I|N|C|L)-[0-9]+ · (\*\*P0\*\*|P1)' audit-report.md \
  | grep -oE '(V|I|N|C|L)-[0-9]+' | sort -u | wc -l                # 51
while read id; do grep -q -- "$id" design-qa-checklist.md || echo "MISSING $id"; done \
  < <(grep -oE '^#### (V|I|N|C|L)-[0-9]+ · (\*\*P0\*\*|P1)' audit-report.md | grep -oE '(V|I|N|C|L)-[0-9]+' | sort -u)
# 无输出 = 51/51 覆盖
```

### 4.3 关键一致性 grep

```bash
cd docs/design-governance
# V-06 一律 31（除 A1 历史 24 / A.1 标题）
grep -rn "31 键" *.md design-system/*.md
grep -rn "24 个\|24 键" *.md | grep -v reviews/ | grep -v "初审计"
# 期望只剩 audit-report.md 的历史条目标题（§115/§192）、QA A.1 标题与本文的「24→31」对照行
# 页面级 X 残留（应无「返回 + 标题 + 关闭」）
grep -rn "返回 + 标题 + 关闭\|返回+标题+关闭" design-system/ component-consolidation.md || echo "OK: no page-level close residue"
# 词卡 hover 切词（应为 0）
grep -rn "120–200ms\|120-200ms" interaction-spec.md || echo "OK: no hover switching"
# IA 旧模型已标废止
grep -n "已废止（2026-11-19 W0" ../信息架构-导航重构.md | wc -l   # 3
```

### 4.4 未改产品代码的证明

```bash
cd /Users/piece/Desktop/Me/EnglishLearning/yt-bilingual-app
# W0 自己的改动范围（docs-only）；frontend/ 的改动来自 W1/W2/W3 并行分工，不是 W0
git status --short -- docs/design-governance docs/信息架构-导航重构.md
# 期望：上述 docs 修改 + 新增 remediation-status.md；无 frontend/backend/.github 的 W0 改动
git log --oneline -1     # 仍为 5996289（W0 未提交）
```

---

## 5. 改动文件清单

| 文件 | 改动 |
|---|---|
| `docs/design-governance/design-system/components.md` | C4 Dialog、C6 Segmented、C8 Toast、C10 EmptyState、C11 tab 序/移动壳、C12 BackButton/X、C13 词卡 |
| `docs/design-governance/design-system/layout.md` | §2.4 面板型/移动壳、§6.1 任务页头部、§7.2 inline 空态 |
| `docs/design-governance/design-system/audit-response.md` | V-06 24→31 + `sentences.day` |
| `docs/design-governance/interaction-spec.md` | IX-04/IX-09/IX-19/IX-21 |
| `docs/design-governance/component-consolidation.md` | W6 修订、G0 31 键、8 漏项、G22 移出、去重、行号、批次、适配器、自查脚本 |
| `docs/design-governance/design-gate.md` | V-06 31+1、白名单 21、W2 开启条件 |
| `docs/design-governance/design-qa-checklist.md` | v1.1：5 值复核、Toast/Empty/Dialog/Segmented、去重/迁出、131→115、附录 E |
| `docs/design-governance/remediation-plan.md` | 顶部执行状态（W0/W6 完成，W1–W5 未完成） |
| `docs/design-governance/gate-1-review.md`、`gate-2-review.md`、`gate-3-review.md`、`audit-report.md` | V-06 历史计数补 31/`sentences.day` 注；A4 映射计数补 222（W6） |
| `docs/信息架构-导航重构.md` | §7.2/§7.3/§8.2 标已废止、旧 URL/栈深/固定归属修正 |
| `docs/design-governance/remediation-status.md` | 本文（新增） |

---

## 6. 未完成 / 风险

1. **W1–W5 不在 W0 交付范围**（见 §3）；并行分工可能已在同一 worktree 推进，完成状态以各自 handoff 为准。W0/W6 只是文档层，不能替代代码验收。
2. **A4 适配器只是契约**：`WordPopover`/`VocabPagination` 的薄适配器尚未实现；B4 出口必须用 `tsc` + 现有脚本证明，否则按 A4 的退路撤回别名承诺。
3. **A4 自查脚本未接 CI**：行号存在/唯一目前是人工可跑脚本；W5 已落地 `gate-receipt`（report-only，未接 CI）。
4. **QA 计数 115 是文档口径**：§4.2 的 `grep` 只匹配主表行；附录 E 的 ID 用反引号包裹，不计入。不要把 E.2/E.3 的追溯行当成执行项。
5. **旧 IA 表保留为历史**：§7.2/§7.3/§8.2 仍含旧 URL 示例，但已有「已废止」块；实现时只能引用 navigation-model，不能以旧表为准。
6. **V-06 仍未关闭**：31+1 键未中文化、CI 规则未接；`check:i18n` 现在仍绿是「测不出」，不是「已修好」。
