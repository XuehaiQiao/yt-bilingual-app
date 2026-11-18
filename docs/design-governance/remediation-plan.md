# UI/UX 治理修复计划（Remediation Plan）

> 日期：2026-11-19 ｜ 来源：A1–A5 五角色交叉审阅 ｜ 状态：**最终验收为 conditional，不可宣称已全部达标**
> **执行状态（2026-11-19）**：**W0 文档对齐 + W6 A4 映射修正已完成**，证据/复核命令见 [`remediation-status.md`](./remediation-status.md)；W1–W5 仍未完成，不得据此关闭 P0 或宣布可上线。
> 关联：`00-team-charter.md`、`audit-report.md`、`design-system/`、`interaction-spec.md`、`navigation-model.md`、`component-consolidation.md`、`design-gate.md`、`design-qa-checklist.md`

## 0. 结论

治理文档与门禁骨架已完成，但交叉审阅证明**四项最终验收没有同时成立**：

| 验收标准 | 现状 | 结论 |
|---|---|---|
| P0/P1 有规范或修复计划 | 51/51 有规范落点；但 V-06 未闭环、D-01/D-02 无实施批次、L-01 无实现行 | **conditional** |
| 令牌/组件覆盖 ≥80% UI | **元素实例 96.6%**；文件 80.6%；**屏级 67%** | **按「UI 元素」口径成立，按屏级不成立**；须补 Menu/公开页/表格等 |
| 门禁嵌入 PR/合并流程 | PR 模板 + CI `check:i18n` 已落地；token/selector 未接 | **基础成立，但可绕过** |
| QA 逐条对应审计类型 | 名义 51/51、P0 7/7；但 5 条验收值错误、12 条无审计 ID、6 条不可判定 | **conditional** |

因此：**可以宣布“治理框架完成”，不能宣布“网站 UI/UX 已达标可上线”。** 本计划只列修复，不代表已修。

## 1. 五个角色交叉审阅的共同结论

1. **V-06 是最大的“假关闭”风险**：A1 初审计 24 键，A5 复核 31 键 + 1 待裁决；A4 原按 24 键、7 键没有迁移行（**W0 已补为 31 键，见 `remediation-status.md`**）；`check:i18n` 当前绿，31 个英文键仍在。V-06 必须单列 P0，不能靠现有 CI 关闭。
2. **导航 P0 没有实施归属**：A4 把 `nav.ts/useNav.ts/App` 推给 A3，A3 只写规范不改代码；D-01/D-02 没有 B0 批次、人日、owner。N-01/N-02/N-03 三个 P0 和 N-18 仍是无主。
3. **A4 映射“文件级未归属 0”不等于“实现点未归属 0”**：至少漏 `DiscoverScreen` 5 处、`StartLearning` 1 处，`Placement` 2 处仅由 G22 兜底；217 行里 7 处行号超文件长度、3 行重复；B1–B5 有依赖倒置（**W6 已修，映射 222 行，见 `remediation-status.md`**）。
4. **A2/A3 有 7 处契约冲突**：Toast TTL/去重、EmptyState 间距、页面级 X vs BackButton、Dialog dirty/alertdialog、词卡 hover 切词、Segmented 5 项边界、移动端双壳/tab 顺序。
5. **A5 门禁可被绕过**：G1 实测不抓 `bg-black/60`、任意 z/字号/阴影；G2 只抓固定常量名；G4 漏裸 `outline-none`；证据不绑 commit；131 项以页面为主，缺组件矩阵。
6. **对比度仍是盲区**：A1 未算 WCAG，A2 把责任指向门禁 G6（但 G6 是移动端），A5 QA 只用 class 判断；发布前必须补实测。
7. **覆盖率的三种口径**：元素实例 96.6%、文件 80.6%、屏级 67%。验收标准写的是“UI 元素”，按实例口径过线；但屏级暴露 Menu/公开页/管理台表格等未覆盖，不能只挑好口径。

## 2. 工作流（按依赖排序）

### W0 · 文档对齐（0.5 人日，最先做）

| 项 | 修法 |
|---|---|
| V-06 计数 | 所有文档统一 **31 键 + `sentences.day` 待裁决**；A4 G0 补 7 个键：`home.removeHistoryTitle`、`home.deleteConfirm`、`home.noUploads`、`common.localFile`、`shows.season`、`shows.episodesShort`、`shows.seasonsEpisodes` |
| Toast | 统一采用 A3：success 3s / info 5s / error 8s；同 key 5s 去重；最多 3 条排队；更新 A2 C8、A4、QA-X-07 |
| EmptyState | 卡片/右栏统一 `py-3`（A3）或明确 `size`；改 A2 C10/A4/G QA |
| BackButton | A2 C12 补 `parentLabel/aria-label="返回<父级>"`，与 A3 `backLabelFor` 一致 |
| X vs Back | 任务/面板页面级一律 BackButton；X 只给覆盖层；删除 A2 layout §6.1 的「关闭」残留 |
| Dialog | 补 `alertdialog/fullscreen/loading/error/dirty/onBeforeClose`；明确 dirty 关闭先确认、嵌套先关再开 |
| 词卡 | 删除 A3 IX-21 的「hover 120–200ms 切词」；保留点击/键盘切词；明确非模态、不锁滚动 |
| Segmented | 统一 2–5 项；>5 用 Tabs/Menu；A3 IX-19 与 A2 C6 对齐 |
| 移动端 | 明确面板型移动端是否保留壳；A2 C11 tab 序改为 D-08（内容/练习/今日/我的） |
| IA | `docs/信息架构-导航重构.md` §7.2/§7.3/§8.2 旧 URL、栈深恒 1、强制归属 tab 标「已废止」；不要只靠文首修订 |
| QA 值 | 修 5 条：QA-NAV-13（管理台独立壳）、QA-ASM-06/ADM-07（不要求页头关闭）、QA-ADM-05（offset 在调用方）、QA-X-12（`/80 + text-caption`）、QA-X-11/VOC-07（触控 ≥44） |

**出口**：文档不再互相矛盾；V-06 有可执行清单；QA 值可复核。

### W1 · 导航 B0（3–4 人日，阻塞 N-01/02/03/N-18）

1. `nav.ts`：全前缀 `#/<tab>/...`；learn/lesson 带来源 tab；`SectionAnchor`；`parentOf/backLabelFor`；legacy 别名表。
2. `useNav.ts`：`dshNav.depth` 替代 `history.length`；前进 push、tab/同屏参数 replace；深链按父级兜底；非法路由一次 toast。
3. `App.tsx`：`openSub` 一律 push；删 `closeWordbookForJump`；report/review 任意来源 tab；`#/content/library` 滚动；登录 `next`。
4. 测试：`parseRoute(toHash(s))` 互逆；A→B→C 返回 C→B→A；刷新/分享/深链；`#/content/library`；旧别名。

**出口**：N-01/N-02/N-03/N-18 关闭；G5/QA-NAV-01–08 通过。

### W2 · V-06 P0（1–2 人日，依赖 W0）

1. 31 键中文化（7 个新增键分配 B2/B4 或 W2 同批）。
2. `check-i18n.mjs` 增「zh 值必须含 CJK（白名单）」；白名单补 6 个 CEFR + `vocab.phrases.source.ecdict`；删 14 死键；`sentences.day` 裁决。
3. `v06-keys.json` + 规则；先 warn 后 error；关闭条件=规则先红后绿。
4. QA-X-17 改为规则输出；QA-VID-03 覆盖 4 屏 31 键。

**出口**：31/31 键含 CJK、主链路无英文；CI 规则绿；否则仍是上线阻塞。

### W3 · 组件收敛首批（5–7 人日）

- **B0/B1 基座**：Tailwind tokens、`lib/cn/time/format`、`ui/Button`、G0 文案；先做 AccountScreen 最小切片（2 个常量、3 个调用点）。
- **B2**：Dialog/ConfirmDialog/Toast；修 I-02 频道弹窗、I-05 `window.confirm`、I-10 Toast 位置。
- **B4-P0**：StateView；修 I-01 三处「失败当空态」。
- **B3**：BackButton/SubHeader/PageHeader（可上线前只做 BackButton 子集）。
- **B4 其余 / B5**：卡片/列表/分页/词卡/Tabs/Segmented/Progress/Field（多数可上线后）。

**出口**：P0 I-01/I-02/V-06 关闭；关键组件出口脚本（旧常量=0、弹窗壳=1、失败不当空）。

### W4 · L-01 移动端（1–2 人日）

- 删除学习页 `52vh`、内层 `overflow-y-auto`、`pb-[45vh]`；整页单滚动；视频不 sticky；桌面双栏保留。
- 375×667 / 390×844 / 430×932 + iOS 地址栏展开收起 + 软键盘。

**出口**：L-01/MOB-01 通过；无横向溢出、无双滚动。

### W5 · QA/门禁加固（1–2 人日）

1. 证据绑 SHA：PR 首行 `HEAD <sha7>`，截图名带 `@sha7`；评审抽 1 条人眼项。
2. `npm run gate:receipt`：输出 SHA、diff、触发判定、G1/G2/G4/G6 计数、i18n 末行。
3. G1 扩到 A2 T-01..T-15（purple/red/emerald/amber/zinc/white/black/shadow/transition/scale）；G2 加 `components/ui` 白名单、A4 常量清单、内联/新文件重复检测；G4 输入壳例外。
4. QA-X-02 全 14 个浮层或强制 I-02；组件矩阵 `/dev/ui`（9 组件×状态×键盘）；对比度实测（4.5:1 / 4.12:1 登记）。
5. 删除/合并 3 对重复 QA；12 条无审计 ID 的 specs 功能项移到功能验收，不进设计 QA；6 条不可判定项改可测或删除。
6. token/selector 自动扫描：先 warn，基线清到 0 后 error。

**出口**：门禁注入反例能命中；QA 去重后约 123 条；V-06/对比度/组件矩阵有证据。

### W6 · A4 映射修正（0.5–1 人日）

- 补 `DiscoverScreen` 5 处、`StartLearning:162`、`Placement:975/1245` 显式行；G22 保留行移出 217（实际迁移 208）。
- 修 7 处越界行号、3 行重复；B4 内联卡 61→56。
- Batch 重排：W1(B0) 与 B1 并行；B2 的 LoadingState 依赖移到 B4-P0 之后；B3/B4 不再声称可并行；WordCard/VocabPagination 兼容适配器或撤回别名承诺。
- 217 按实现点归属；验收脚本加行号存在/唯一。

## 3. 上线前 vs 上线后

### 上线前必须（P0 + 同源 P1）

| 工作流 | 范围 | 预估 |
|---|---|---:|
| W0 | 文档对齐 | 0.5 |
| W1 | 导航 B0 | 3–4 |
| W2 | V-06 31 键 + CJK 规则 | 1–2 |
| W3 | B1/B2 + B4-P0（I-01/I-02） | 5–7 |
| W4 | L-01 移动单滚动 | 1–2 |
| W5 | 门禁加固（可并行） | 1–2 |
| W6 | 映射修正 | 0.5–1 |
| **合计** | | **12–18.5 人日** |

同源 P1：I-03/04/05、I-12/C-03、N-04/N-18、V-03、V-11/V-14、I-10、L-07；随 W1–W3 处理。

### 上线后迭代（P1 其余 + P2）

- B3 页头/导航壳、B5 Tabs/Segmented/ruby/Progress/Field、B4 卡片/列表/分页、G22 大组件拆分、C-14/C-16、分享 canvas、Table/Switch/chip/axis/分栏、多数组件视觉收敛。
- 条件：不阻塞核心流程；有 issue + owner；A5 门禁保留例外记录。

## 4. 执行顺序（硬依赖）

```
W0 文档
  ├─ W2 V-06（可并行 W1）
  └─ W6 映射修正（可并行）
W1 B0 导航 ──→ W3 B3（BackButton）──→ W5 QA/门禁加固
W3 B1/B2/B4-P0 ──→ W4 L-01 验收
```

禁止先做大面积视觉重构；先关 P0 路径：V-06、I-01/I-02、N-01/02/03、L-01。

## 5. 最终验收复核方式

完成 W0–W6 后，按四项重新验：

1. **P0/P1**：A1 的 7 P0 + 44 P1 逐条有规范 + 已修/已排期；V-06 规则先红后绿。
2. **覆盖**：元素实例 ≥80%（当前 96.6%）；文件 ≥80%（当前 80.6%）；屏级 67% 补 Menu/公开页/Table/Switch/chip/axis/分栏后再报，不混口径。
3. **门禁**：PR 模板 + `gate:receipt` + CI i18n；用 3 个注入反例验证 G1/G2/G4/G7 能命中；P0 阻断。
4. **QA**：去重后 123 条；每个 P0/P1 至少 1 条可执行检查；5 条错误值已修；V-06/对比度/组件矩阵有实测证据。

**未完成上述复核前，不宣布“UI/UX 治理完成/可上线”。**
