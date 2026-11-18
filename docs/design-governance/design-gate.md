# 设计门禁（Design Gate）v1.0

> 版本：**v1.0**（2026-11-19 定稿）｜责任人：A5（质量门禁与 QA）｜审批：lead
> 适用：`yt-bilingual-app` 前端 **Web** 改动（含 375 响应式）；`mobile/` Expo 原生 app 本轮不在治理范围（章程 §1）。
> 依据：A1 [`audit-report.md`](./audit-report.md)（90 条：P0 7 / P1 44 / P2 39）、A2 [`design-system/`](./design-system/tokens.md)、A3 [`interaction-spec.md`](./interaction-spec.md) / [`navigation-model.md`](./navigation-model.md)、A4 [`component-consolidation.md`](./component-consolidation.md)、[`gate-1-review.md`](./gate-1-review.md) / [`gate-2-review.md`](./gate-2-review.md)、[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)、[`frontend/package.json`](../../frontend/package.json)。
> 与 [`design-qa-checklist.md`](./design-qa-checklist.md) 的分工：**本文件是每个 UI PR 的 8 项最小集**；QA 清单是发布前 / 阶段回归的模块全量集。两者不互相替代。

---

## 0. 一句话，以及三个必须核实的事实

**一句话**：UI 改动合并前，作者用 **8 个「是/否」问题 + 5 分钟走查**证明这次没有把已统一的东西再拆开；评审者只复核证据，不重做走查、不加审批人、不开会。

门禁要立在事实上，所以先把仓库现状钉死（2026-11-19 本地实测）：

| 事实 | 结论 | 证据 |
|---|---|---|
| CI 实际跑什么 | 后端 `py_compile` + `pytest`；前端 `npx tsc -b`、`npx vite build`、`npm run check:i18n` | `.github/workflows/ci.yml`（前端 job） |
| CI **不**跑什么 | **没有 lint、没有 token/视觉扫描、没有选择器冒烟** | 同上；`frontend/package.json` 只有脚本 |
| 当前基线是否绿 | `tsc -b`、`vite build`、`check:i18n` 三条本地实测**均通过** | `TSC_EXIT=0`；`✓ built in 3.16s`；`i18n check passed: 1691 keys × 2 languages` |

**由此确定（不再含糊）**：

1. **机器门禁 = tsc + build**（CI 已覆盖，PR 不用贴输出）。
2. **i18n = CI 机器门禁**：`check:i18n` 已接入前端 job；PR 仍建议贴最后一行输出，便于 review。
3. token/视觉扫描、选择器冒烟仍留阶段 4，避免存量 90 条问题让门禁直接爆红。
4. 阶段 3 **不新增任何会因存量 90 条问题爆红的规则**；token 正则、选择器冒烟、路径过滤一律放阶段 4（§4.3）。

---

## 1. 触发条件（精确到路径 × 变更类型）

### 1.1 命中即触发（任一）

| # | 路径（glob） | 什么变更算 | 为什么触发 |
|---|---|---|---|
| **T1** | `frontend/src/components/**` | `.tsx` 的渲染输出、class、交互行为变化 | 全部用户可见组件 |
| **T2** | `frontend/src/App.tsx`、`frontend/src/main.tsx` | 壳、路由挂载、全局状态、全局样式注入 | 导航 / 子视图切换都从这里进 |
| **T3** | `frontend/src/**/*.css` | `index.css` 等全局材质、焦点环、滚动、安全区 | 一处改动影响全站 |
| **T4** | `frontend/tailwind.config.{js,ts,cjs}`、`frontend/postcss.config.{js,cjs}` | token / theme / content 扫描 | 视觉单一来源 |
| **T5** | `frontend/index.html`、`frontend/public/manifest.webmanifest` | title / theme-color / 图标 / 启动屏 | PWA 外观 |
| **T6** | `frontend/src/i18n/*.json`、`frontend/src/lib/i18n/**` | 新增或修改用户可见文案 | V-06 主战场 |
| **T7** | `frontend/src/lib/{nav,useNav,navTabs}.ts` | 路由、历史、返回、滚动恢复 | 导航契约 |
| **T8** | 等效改动 | 文件不在上表，但改变了用户看到的**层级 / 跳转 / 操作方式**（例：新增 `components/ui/Dialog.tsx`、`lib/usePageScroll.ts`） | 防绕过 |

**判定规则**：拿不准就按触发处理（门禁 5 分钟，漏一次回归更贵）。

**命中路径但不触发**：只改注释 / 类型标注 / 格式化 / 删除无引用死代码，且**不改变渲染输出与交互** → PR 末行勾「跳过」并写一句原因。同一 PR 里只要有一处改变渲染输出，整 PR 按触发处理。

### 1.2 不触发（明确列出）

| 路径 / 变更 | 说明 |
|---|---|
| `backend/**` | 后端由 pytest + spec 验收；纯后端 PR 连「跳过」都不用勾 |
| `docs/**`、`specs/**`、`README*`、`AGENTS.md`、`CONSTITUTION.md` | 纯文档 |
| `content/**`、`frontend/public/**`（非 manifest / 非图标语义）、`scripts/**`、`data/**` | 静态数据与工具 |
| `.github/**` | CI 与模板自身 |
| `mobile/**` | Expo 原生 app，本轮不做（章程 §1） |
| `**/*.test.*`、`**/__tests__/**`、仅类型定义且不改用户可见输出 | 无 UI 输出 |
| 依赖升级：`tailwindcss`、`postcss`、`react`、`react-dom`、`framer-motion`、`lucide-react` **以外** | 这六个影响渲染 / 动效：升级不产生源码 diff，按 T8 做一次三屏抽查（1440 + 375 + 弹窗）；其余升级不触发 |
| 纯 revert（恢复到此前的已过门禁版本） | PR 写「revert of #\<PR\>」即可 |

### 1.3 当前不触发、阶段 4 再补的

- 自动路径过滤（按本节判定 UI PR 的 CI job）：阶段 4。
- token / 选择器冒烟：阶段 4（§4.3）。
- `mobile/`：恢复跟进时另立规则。

---

## 2. 检查项（8 项，是 / 否）

> 适用范围：触发了 §1.1 的 PR。每项只需回答「是 / 否」并给证据；**没有证据的勾选视为未通过**；「不适用」要写一句理由，否则按未通过处理。

### 2.1 总表

| # | 检查项（是 / 否） | 主要判据 | 失败等级 | 依据 |
|---|---|---|---|---|
| **G1** | **没有新增设计字面量** | diff 新增行无 hex / rgb / 任意字号 / 任意 z / 任意阴影；颜色、材质、圆角走 token | 新增语义色 / hex / 任意 z / `text-zinc-600` → **P0**；其余 **P1** | tokens §2/§5/§6/§7/§13 |
| **G2** | **组件没有出第二份** | 按钮 / 卡片 / 弹窗 / tab / 分段 / 徽章 / 空态 / 分页复用既有组件；新组件有「不能复用」的理由 | 同屏两套壳 / 两套弹窗行为 → **P0**；新增重复实现 **P1** | components §1.4、A4 映射表 |
| **G3** | **加载 / 空 / 错误三态齐全** | 失败**不得**渲染成空态；空态只在「成功且为空」；错误可重试或可退出 | 失败当空态 / 无重试 → **P0**；缺骨架 → **P1** | IX-01/03/04/05 |
| **G4** | **对话框与键盘可用** | Escape / 遮罩 / X 可关；`role` + 焦点回填 + 滚动锁；焦点可见；无 `window.confirm` | 键盘关不掉 / 焦点跑背景 / 主流程走不完 → **P0**；缺 role / 焦点环被吞 **P1** | IX-09/10、C4 |
| **G5** | **导航与返回正确** | URL 可分享可刷新；返回回来源；切 tab 不堆历史；刷新不自动触发处理 / 付费 | 死路 / 循环 / 403 白屏 / 自动扣费 → **P0** | navigation-model §3–§4 |
| **G6** | **移动端可用** | 375 无横向滚动；单滚动容器；只允许 `dvh`；底栏 / 安全区不挡主操作 | 375 阻断操作 / 双滚动 / 溢出挡内容 → **P0**；细节 **P1** | layout §2.4/§6.3/§8、L-01 |
| **G7** | **文案与 i18n 正确** | 文案走 `t()`；zh / vi 同步；中文界面无英文；`check:i18n` 通过 | 只写一种语言 / vi 混中文 / 主链路英文 → **P0** | V-06、specs/012 §5.7 |
| **G8** | **写操作与危险操作可控** | 按钮内 loading + 成功反馈 + 失败可回滚；危险操作二次确认；游客门禁在入口 | 重复提交 / 假成功 / 未确认删除 → **P0**；反馈缺失 **P1** | IX-07/22/24/26、I-05/06/19 |

### 2.2 逐项判定

#### G1 · 没有新增设计字面量

- **检查什么**：本次新增行里的 `#hex`、`rgb()`、`bg-[…]`、阶梯外字号、`z-[…]`、`shadow-[…]`、跨档圆角、`h-screen`。
- **怎么判定**：下面的命令返回 **0 行**即「是」。允许的既有配方（设计语言明确列出）不算新增：`text-[11px]/[13px]/[15px]/[17px]`、`rounded-[10px]`、`tracking-[-0.015em]`。

```bash
# 把 origin/main 换成本 PR 的 base 分支（upstream/main 同理）
git diff origin/main...HEAD -- 'frontend/src/**/*.tsx' 'frontend/src/**/*.css' 'frontend/src/i18n/**' \
  | grep -E '^\+' | grep -vE '^\+\+\+' \
  | grep -nE '#[0-9a-fA-F]{3,8}|rgb\(|bg-\[|text-\[(9|10|12|14|16|18|19|2[0-9]|[3-9][0-9])px\]|z-\[|shadow-\[|(bg|text|border|ring|from|to|via)-(blue|violet|sky|pink)-|text-zinc-600|(min-)?h-screen|rounded-2xl sm:rounded-3xl'
```

- **证据**：命令输出（空）+ 例外行号（有则写「例外数 N」）。
- **等级**：新增语义色 / hex / 任意 z-index / `text-zinc-600` → **P0**；其余 → **P1**。
- **豁免**：A2 未覆盖的新材质 / 新场景，已按 §5 登记（≤30 天、有 owner、有到期 issue）；或「照抄既有页面旧值」且同时在 A4 收敛表登记。
- **不追溯存量**：35 处 hex、87 处 `text-zinc-600`、473 处 `blue-*`、56 处 `z-*`、93 处越阶字号是 A1 存量，由 A4 B1–B5 + 阶段 4 门禁归零，**不在本 PR 阻断**。

#### G2 · 组件没有出第二份

- **检查什么**：是否又写了一颗主按钮 / 卡片 / 弹窗 / tab / 分段 / 徽章 / 空态 / 分页。
- **怎么判定**：命令返回 0 行；新组件必须写在 `frontend/src/components/ui/` 并在 PR 写「不能复用谁、为什么」；同屏不出现两个同类浮层。

```bash
git diff origin/main...HEAD -- 'frontend/src/**/*.tsx' \
  | grep -E '^\+.*const (PRIMARY_BUTTON|SECONDARY_BUTTON|GHOST_BUTTON|DANGER_BUTTON|CARD|ACTION|PRIMARY_CTA|OPTION_BASE) ='
```

- **复用清单**（A2 C1–C15）：Button、Card/ListRow/IconTile、Input/SearchField、Dialog/ConfirmDialog/Sheet、Tabs、Segmented、Badge/CountBadge、Toast、Pagination、EmptyState/ErrorPanel/Skeleton、NavShell、PageHeader/SubHeader/BackButton、WordCard/WordHighlight、VocabRow/VocabTabStrip、Progress。
- **证据**：命令输出 + 新组件路径（如有）+ 一句复用理由。
- **等级**：**P1**；同屏两套壳、两套弹窗关闭行为不一致、新旧实现同屏并存 → **P0**。
- **豁免**：A4 批次迁移期的「新增并行、旧文件保留到批末」（A4 §5.5）；PR 必须写批次（B1–B5）与删除条件；**单屏不得新旧并存**。

#### G3 · 加载 / 空 / 错误三态齐全

- **检查什么**：改动的异步区块在断网 / 500 时显示错误面板 + 重试，而不是「暂无数据」；首屏列表用骨架；空态只在成功且为空时出现。
- **怎么判定**：DevTools 断网 → 进改动页 → 截错误态；清空数据 → 截空态；3G 限速 → 截加载态。错误面板必须能重试或退出。
- **证据**：3 张截图（文件名含状态，如 `today-error-375.png`）+ 一句复现方式。
- **等级**：失败当空态 / 无重试 → **P0**；缺骨架或加载态混用 → **P1**。
- **豁免**：页内无异步请求（PR 写一句）。
- **testid 锚点**：C10 迁移后统一 `data-testid="error-panel"` / `"empty-state"`；当前用截图，脚本在阶段 4 加。

#### G4 · 对话框与键盘可用

- **检查什么**：Tab 能到全部操作；焦点始终可见；Escape / 遮罩 / X 可关；关闭后焦点回触发元素；背景不滚；`role="dialog"` + `aria-modal`；无新增 `window.confirm/alert`。
- **怎么判定**：命令返回 0 行 + 只用键盘走一遍。

```bash
git diff origin/main...HEAD -- 'frontend/src/**/*.tsx' \
  | grep -E '^\+.*(window\.confirm|window\.alert|focus:outline-none)'
```

- **证据**：键盘走查截图 / 录屏（焦点在弹窗内、背景不滚）+ 命令输出；弹窗与返回控件优先用 `data-testid` 定位（`*-back`、`word-popover*`）。
- **等级**：键盘无法关闭 / 无法完成主流程 / 焦点丢失 → **P0**；缺 role、焦点环被吞、遮罩不可关 → **P1**。
- **豁免**：非模态的进程内提示（toast、行内错误）不适用；iframe / WebView 内内容不适用（注明）。

#### G5 · 导航与返回正确

- **检查什么**：改动的入口 / 子视图 URL 符合 `navigation-model`；返回落到来源；刷新 / 深链恢复同一屏；tab 切换不新增历史；刷新不自动重跑处理 / 估价。
- **怎么判定**：贴 URL 到新标签打开（同屏）；连开 A→B→C 后连点返回（C→B→A）；刷新学习页看 Network 无 `process` / `estimate` 调用。
- **证据**：3 行 hash 序列（打开前 / 跳转后 / 返回后）+ 刷新截图 + Network 截图。
- **等级**：死路 / 循环 / 403 白屏 / 刷新自动触发处理或付费 → **P0**；落点偏差 → **P1**。
- **豁免**：D-08 的 tab 顺序（内容 / 练习 / 今日 / 我的）与 D-12 理解题覆盖层是已知决策，不算缺陷。

#### G6 · 移动端可用

- **检查什么**：1440 + 375 各走一遍；375 无横向滚动、单滚动容器、底栏不挡主按钮；不新增 `h-screen` / `min-h-screen` / `vh` 后缀；改导航壳加测 1024 / 768。
- **怎么判定**：截图 + 命令返回 0 行。

```bash
git diff origin/main...HEAD -- 'frontend/src/**/*.tsx' \
  | grep -E '^\+.*(h-screen|min-h-screen|[0-9]+vh)'
```

- **证据**：1440 / 375 截图（改壳 + 1024 / 768），文件名含宽度，如 `reader-375-vi.png`。
- **等级**：375 阻断操作、学习页双滚动 / 链式滚动、横向溢出挡内容 → **P0**；间距 / 安全区细节 → **P1**。
- **豁免**：iOS Safari 真机（地址栏展开 / 收起）只在发布前 QA 做；但改学习页 / 壳必须给 375 浏览器截图。

#### G7 · 文案与 i18n 正确

- **检查什么**：新增文案走 `t()`；`zh-CN.json` / `vi-VN.json` 同键；中文界面无英文句子；vi 无 CJK；`{{placeholder}}` 一致；V-06 的键已中文化。
- **怎么判定**：`npm run check:i18n` 通过（贴最后一行）；diff 里无硬编码中文 JSX：

```bash
cd frontend && npm run check:i18n
git diff origin/main...HEAD -- 'frontend/src/**/*.tsx' \
  | grep -E '^\+.*>[^<{]*[一-龥]'   # 注释误报人工剔除
```

- **证据**：check:i18n 末行 + zh-CN ↔ vi-VN 切换截图 + 新 key 列表。
- **等级**：只写一种语言 / check:i18n 失败 / vi 混中文 / 主链路英文 → **P0**；文案风格 → 不阻断（PR 评论）。
- **豁免**：品牌名、CEFR、URL 占位、书名、`{{license}}` 等模板值（白名单 14 键见 QA 附录 A）；`vi-VN` 存量未翻译键按 specs/012 节奏，不阻断。

#### G8 · 写操作与危险操作可控

- **检查什么**：写操作按钮内转圈 + 防重复点击；成功有反馈；失败有 toast / 内联且不假成功；危险操作（删除 / 退出考试 / 重置定位 / 封禁 / 调余额）二次确认；游客点需登录入口先弹登录浮层；收藏乐观更新 + 失败回滚。
- **怎么判定**：双击提交按钮；断网提交；取消确认框；游客点收藏。四个动作各截一张图。
- **证据**：提交中 / 成功 / 失败 3 张截图 + 游客收藏 1 张。
- **等级**：重复提交（尤其计费 / 写库）、假成功、未确认就删除 → **P0**；缺成功反馈 → **P1**。
- **豁免**：只读页不适用；`hotfix` 回滚 PR 按 §3.2 第 4 条补做。

---

## 3. 等级与合并规则

### 3.1 等级定义

| 等级 | 定义 | 合并处置 |
|---|---|---|
| **P0** | 用户走不通 / 走错 / 白屏 / 错语言 / 同一语义两套事实 / 重复扣费 | **不合并**；修完重跑该项并更新证据 |
| **P1** | 可用但不一致（缺状态、缺 aria、对比度不足、动效未降级） | 可合并，但必须登记 issue + owner + 到期 ≤7 天 |
| **P2** | 打磨项 | 只在 PR 评论记一句，不计入阻断与度量 |

### 3.2 合并规则（硬规则）

1. **P0 未过 → 不合并。** 评审者在 PR 评论 `design-gate: P0 <G#>` 写清现象与复现，走**正常 review** 的 request changes——不新增审批角色、不加 CODEOWNERS。
2. **P1 可记录后修**，三条同时满足才放行：PR「遗留 P1」表有 issue 链接；有 owner；到期 ≤7 天。同一检查项**连续逾期两次** → 第三次按 P0 处理。
3. **纯后端 / 纯文档 / 无用户可见改动 → 不触发**；PR 勾末行「跳过」即可，不需要设计证据。
4. **紧急修复**（线上 P0 故障、安全、回滚）：lead 打 `hotfix` 标签后可先合并；**24h 内**在同一 PR 补勾证据或开 issue 记补做；每周度量单列「延期项」，连续两周延期 → 恢复强制门禁。
5. **豁免**：只能 lead 批；同一检查项一周 override ≥3 次 → 视为规则问题（§8），由 A5 修订规则，而不是继续绕过。
6. **V-06 不因「门禁通过」关闭**：它是门禁 1 记录的 P0 例外，必须 31 键中文落地（24 审计键 + 7 条 A5 复核追加，见 QA 附录 A）+ QA 勾选后才算关闭（门禁 1 裁决）。

### 3.3 与既有规则的关系

- 不替代 AGENTS.md 提交门禁（`tsc -b` / 后端 `py_compile` / 浏览器实测），是**叠加**。
- 视觉以 `design-system/` 为准；行为以 `interaction-spec.md` / `navigation-model.md` 为准；冲突时**先修文档再改代码**，A5 不单方面裁决。
- 功能正确性由 `specs/` 验收；本门禁只管「做得一致」。

---

## 4. 嵌入方式

### 4.1 PR 模板（已落盘）

**已创建** [`.github/pull_request_template.md`](../../.github/pull_request_template.md)：机器门禁 3 行 + 设计门禁 8 勾 + 「设计走查证据」表 + 遗留 P1 表 + 跳过行。**不增加审批人**，只加勾选与证据链接；模板是唯一勾选来源（附录 A 只放指针，不复制）。

### 4.2 机器门禁（现状，本阶段不改 CI）

| 门 | 现状 | 位置 | 阶段 3 动作 |
|---|---|---|---|
| 类型检查 | 已跑 `npx tsc -b` | `ci.yml:68-69` | **保持** |
| 构建 | 已跑 `npx vite build` | `ci.yml:71-72` | **保持** |
| i18n | 脚本有、**CI 已接**；当前通过（1691 keys × 2） | `package.json`；`ci.yml` 前端 job | 机器门禁；PR 可贴输出便于 review |
| Lint | 脚本有、CI 未接；无自定义规则 | `package.json:9` | 不动（与门禁无关） |
| token 扫描 | 无 | — | **阶段 4** |
| 选择器冒烟 | 无（A4 已要求 `scripts/check-ui-selectors.mjs`） | — | **阶段 4** |

### 4.3 阶段 4 计划（不阻塞当前）

1. **先清基线，再开规则**：B3 出口开「z-index / 字号 / 圆角 / `zinc-600`」；B5 出口开「无 `blue-*` / `purple-*` / `shadow-[` / 裸 `transition`」（A4 §5.7 已定两档）。全绿后才接 CI。
2. `check:i18n` 增「zh 值必须含 CJK，白名单 14 键」规则：**必须在 31 键文案落地后开启**，否则 31 条直接爆红（V-06 例外条款）。
3. `check-ui-selectors.mjs`：674 个唯一 `data-testid`、77 个被脚本依赖、4 个契约属性（`data-word-hit`、`data-lookup-context`、`data-lookup-start`、`data-highlight`）。
4. 自动路径过滤（按 §1.1 判断是否 UI PR）：最后做，只减少漏勾，不增加阻断。
5. 上线节奏统一三步：**本地绿 → CI 只报告（warn）→ CI 阻断（error）**；任一步误报率 >5% 回退到上一步。

### 4.4 5 分钟走查时间盒

| 时间 | 动作 | 对应 |
|---|---|---|
| 0:00–0:40 | 跑 G1 / G2 两条 diff 命令；看 diff 是否只碰预期文件 | G1、G2 |
| 0:40–1:30 | 断网 / 清数据 / 3G：截空、加载、错误三态 | G3 |
| 1:30–2:20 | 只用键盘：Tab 走完、Enter 触发、Esc 关弹窗、焦点可见 | G4 |
| 2:20–3:00 | 双击提交、断网提交、取消确认、游客点收藏 | G8 |
| 3:00–3:50 | 贴 URL / 刷新 / 连开 A→B→C 连点返回 | G5 |
| 3:50–4:30 | 375 与 1440 各走一遍主路径；查横向滚动与底栏 | G6 |
| 4:30–5:00 | 切 zh-CN ↔ vi-VN；贴 `check:i18n` 末行 | G7 |

**证据最小集**：2 张截图（1440 / 375）+ 1 条命令输出 + 1 张异常态截图。改导航壳或断点再加 1024 / 768。

---

## 5. 例外与豁免

**什么时候可以例外**：A2 未覆盖的新材质 / 新场景；复刻既有页面时不得不沿用旧值（同时登记为 A4 收敛项）。

**登记格式**（必须可搜索）：

```ts
// design-exception: <原因> · <owner> · <YYYY-MM-DD> · <到期日或 issue 号>
```

```css
/* design-exception: <原因> · <owner> · <YYYY-MM-DD> · <到期日或 issue 号> */
```

- PR 勾选块写「例外数：N」，并附一行理由。
- **审批**：lead 批，A5 登记；PR 内写明到期日或 issue。
- **时限**：≤30 天。到期未清 → 该文件后续 UI 改动按 P0 复核，不再接受同类新例外。
- **统计**：例外数计入 §8 指标 1；单周例外率（例外数 ÷ UI PR 数）>20% → 视为规范缺口，反馈 A2 / A3 补规范。
- **存量不追溯**：A1 的 90 条只由 A4 批次与 `remediation-plan.md` 消化，门禁只拦新增 / 本次改动。

---

## 6. 责任人

| 动作 | PR 作者 | 评审者 | lead | A5 |
|---|---|---|---|---|
| 勾 8 项 + 附证据 | R | C | I | I |
| 5 分钟走查 | R | 抽查 2 条证据 | I | I |
| P0 判定与阻断 | R | A | C | C |
| P1 登记（issue + owner + 到期） | R | C | I | A |
| 例外审批与登记 | C | I | A | R |
| 每周度量统计 | I | I | A | R |
| 本文件修订 | C | C | A | R |

R=执行，A=最终负责，C=被咨询，I=知会。

---

## 7. 首次使用说明（开发者 / 评审者 / P0 阻断）

### 7.1 开发者：5 步

1. **判触发**：`git diff --name-only origin/main...HEAD` 对照 §1.1。不触发 → 模板末行勾「跳过」，结束。
2. **跑机器门禁**：`cd frontend && npx tsc -b && npx vite build && npm run check:i18n`，留最后一行输出。
3. **走 5 分钟**：按 §4.4 时间盒做；截图命名带宽度与状态（`today-375-error.png`）。
4. **填模板**：8 项勾选 + 证据表 + 例外行号；P1 建 issue 填「遗留 P1」表。
5. **自查**：每勾一项都能点开一条证据；点不开的取消勾选，不要「先勾上再说」。

### 7.2 评审者：30 秒

1. 看 diff 是否命中 §1.1；命中却没填设计门禁 → 退回。
2. 抽查 2 条硬证据：G1 命令输出为空 + 一张 375 截图；改导航的抽查 G5 的 hash 序列。
3. 看「遗留 P1」表是否都有 issue + owner + ≤7 天；没有 → 要求补。
4. 其余不看：不重做走查、不评价审美、不要求额外审批人。

### 7.3 P0 怎么阻断

- 评审者评论 `design-gate: P0 G3`（写清现象与复现步骤），按正常 review 流程 request changes。
- 作者修复后只重跑该项并更新证据；评审者只复核这一项。
- 有争议（作者认为不是 P0）→ lead 裁决；紧急上线 → `hotfix` + 24h 内补做（§3.2 第 4 条）。

---

## 8. 度量（每周一次，10 分钟内完成）

| 指标 | 定义 | 采集方式 | 当前基线（2026-11-19） | 目标 | 责任人 |
|---|---|---|---|---|---|
| **1. 每周新增裸值** | 新增 hex / 阶梯外字号 / 任意 z / 任意阴影 / 魔法间距条数 ÷ 该周 UI PR 数 | PR 勾选块「例外数」+ G1 命令输出；阶段 4 用 `check-design-tokens.mjs --diff` | 存量：35 hex / 87 `text-zinc-600` / 473 `blue-*` / 56 `z-*` / 93 越阶字号 / 5 `shadow-[` | 新增 = 0；例外 ≤1 / PR | A5 |
| **2. 重复组件数** | A4 映射表中「同一语义多实现」的组数 | `component-consolidation.md`（23 组 G0–G22、217 行映射、18.5 人日） | **23 组** | 每周不增；B1–B5 后 ≤11 组（降 ≥50%） | A4 提供，A5 统计 |
| **3. 门禁通过率** | 首轮 P0 = 0 且 8 项全勾的 UI PR ÷ 全部 UI PR | PR 模板 + 评审复核 | 从本版起统计 | ≥90%；连续两周 <90% → 复盘规范缺口 | A5 |
| 诊断 A：例外率 | 例外数 ÷ UI PR 数 | 同上 | — | >20% → 反馈 A2/A3 补规范 | A5 |
| 诊断 B：override | `design-gate-override` / `hotfix` 次数 | PR 标签 | — | 同一项 ≥3 次/周 → 改规则 | lead |

- **节奏**：每周五 15 分钟，A5 汇总 ≤5 行周报（三个指标 + 例外 + 逾期 P1）。每月一次规则评审（lead + A5），只看「误伤」「漏勾」「规范缺口」三类。
- **纪律**：度量只用于发现规范缺口，**不用于考核个人**。

---

## 9. 回滚

- **单个 PR**：直接 revert；UI 改动不得夹带不可回滚的数据迁移，必须则拆 PR。
- **门禁误伤**：lead 打 `design-gate-override` 标签 + 一行理由后合并；同项一周 ≥3 次 → 由 A5 修规则（§8 诊断 B）。
- **规则回滚**：本文件修改走 PR 并留变更记录；令牌 / 组件标准由 A2 / A4 决定，A5 不单方面改。
- **阶段 4 脚本**：误报则先降级为 warn，一周内修脚本或放宽规则；不得直接删规则掩盖问题。
- **文档被误改**：`docs/design-governance/` 在版本控制内，按 git 回滚，禁止手工改历史结论。

---

## 10. 变更记录

| 日期 | 版本 | 变更 | 作者 |
|---|---|---|---|
| 2026-11-19 | v0.1 | 初稿：触发条件、7 项检查、嵌入方式、例外、度量（已被 v1.0 取代） | A5 |
| 2026-11-19 | **v1.0** | 定稿：去掉初稿的占位表述；触发条件细化到 8 类触发源（T1–T8）× 变更类型；检查项定为 8 项（新增 G8 写操作），每项补「怎么判定 + 证据 + 等级 + 豁免」；落地 PR 模板；补合并规则、首次使用说明、度量基线与阶段 4 计划 | A5 |
| 2026-11-19 | **v1.1** | 接入 `npm run check:i18n` 到前端 CI（阶段 3 门禁落地）；token/选择器扫描仍留阶段 4；同步 PR 模板 | lead |

---

## 附录 A：PR 勾选块（与 `.github/pull_request_template.md` 同步）

见仓库根 [`.github/pull_request_template.md`](../../.github/pull_request_template.md)。模板是唯一来源，本附录不再复制，避免两处漂移。

## 附录 B：CI 接入现状（阶段 3 已落地 i18n）

`.github/workflows/ci.yml` 的前端 job 已加入：

```yaml
      - name: i18n check
        run: npm run check:i18n
```

仍留阶段 4 的（本次不接）：

```yaml
      # 仅扫本次 diff，避免存量债；先 warn 后 error
      # - name: design tokens (diff)
      #   run: node scripts/check-design-tokens.mjs --diff origin/${{ github.base_ref }}
      # - name: ui selectors
      #   run: node scripts/check-ui-selectors.mjs
```

接入前提：token/selector 脚本先写完、误报率可接受（<5%）、lead 同意改 CI。

## 附录 C：命令速查

```bash
# 触发判断
git diff --name-only origin/main...HEAD

# G1 字面量 / G2 重复常量 / G4 原生确认框 / G6 旧视口单位
git diff origin/main...HEAD -- 'frontend/src/**/*.tsx' | grep -E '^\+.*(const (PRIMARY_BUTTON|CARD|ACTION|OPTION_BASE) =|window\.confirm|window\.alert|focus:outline-none|h-screen|min-h-screen|[0-9]+vh)'

# G7 硬编码 CJK + i18n 对齐
git diff origin/main...HEAD -- 'frontend/src/**/*.tsx' | grep -E '^\+.*>[^<{]*[一-龥]'
cd frontend && npm run check:i18n
```

> 命令只做「漏项提醒」，不替代人看截图；误报（注释、字符串常量里的示例）由作者在 PR 写一句说明。
