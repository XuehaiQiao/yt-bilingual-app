# 语途设计令牌（Design Tokens）v1.0

> 作者：A2 · 设计系统架构师 ｜ 日期：2026-11-19 ｜ 阶段：1（门禁 1）
> 依据：`docs/design-governance/audit-report.md`（下称 A1）、`docs/设计语言.md`（下称《设计语言》）、`docs/信息架构-导航重构.md`（下称 IA）、`frontend/tailwind.config.js`、`frontend/src/index.css`、`frontend/src/**/*.tsx` 全量扫描。
> 范围：只定义令牌与使用规则，不改代码、不提交 git。组件规则见 `components.md`，布局规则见 `layout.md`，审计逐条回应见 `audit-response.md`。

---

## 1. 效力与提取原则

1. **本文件是 A4 迁移与 A5 门禁的唯一令牌来源。** 与《设计语言》冲突时以本文件为准；两处已知冲突的裁决见 §2.3 的 Q-01/Q-02，以及 §14 的「上游文档勘误」。
2. **不发明新色/新字号。** 所有值来自现有代码中的 zinc / brand / emerald / amber / red / violet，或 `index.css` 已存在的值；本文件新增的只是**语义名**与**收纳规则**，不是新的视觉值。
3. **三层落点**：
   - **CSS 变量**：只在需要全局运行时/原生 CSS 共享时使用（页面底色、品牌色通道、焦点环、安全区、底栏高度）。
   - **Tailwind theme**：颜色、字号、圆角、阴影、z-index、容器宽、控件高——组件只允许通过 token 类名使用。
   - **Utility**：布局（flex/grid/间距/定位）保持 Tailwind utility；不允许新增任意颜色/阴影/字号/z 值。
4. **以 A1 高频值为基线。** 下表是本轮扫描的原始频次（A1 §3.1 + A2 复核），所有映射必须能解释这些值：

| 类别 | 高频原值（次数） |
|---|---|
| 边框 | `border-white/5` 375 · `border-white/10` 86 |
| 文字 | `text-[11px]` 341 · `text-sm` 350 · `text-xs` 340 · `text-zinc-600` 87 · `text-[10px]` 67 |
| 底色 | `bg-zinc-900/40` 80 · `bg-zinc-800/60` 125 · `bg-white/5` 102 · `bg-[#09090b]` 35 |
| 强调色 | `blue-*` 473 · `brand-*` 5 · `purple/violet` 16 · `sky` 3 · `pink` 1 |
| 圆角 | `rounded-full` 180 · `rounded-lg` 174 · `rounded-xl` 168 · `rounded-2xl` 129 · `rounded-3xl` 27 |
| 字号阶梯外 | 9/10/12/13/14/16/19px 合计 93 处 |
| 层级 | `z-*` 12 档 56 处 |
| 阴影 | `shadow-[...]` 5 · `shadow-2xl` 17 · `elev-*` 仅 2 次使用 |

---

## 2. 颜色

### 2.1 中性色与语义底色

中性色只用 zinc；**语义名固定如下**。除 `fg-disabled` 外，组件里不允许再出现 `zinc-*` 字面色值。

| Token（Tailwind 类名根） | 值 | 旧值来源 | 用途 | 禁止 |
|---|---|---|---|---|
| `app` → `bg-app` | `#09090b`（zinc-950） | `bg-[#09090b]` 35 处、body 底色 | 页面/根壳底色、chrome 底色 | 不得再用十六进制 |
| `surface` → `bg-surface` | `#18181b`（zinc-900） | `bg-zinc-900/40` 80 处 | 卡片、对话框、toast 的**基色**；透明度在使用处给 | 不得当文字色 |
| `surface-2` → `bg-surface-2` | `#27272a`（zinc-800） | `bg-zinc-800/60` 125 处 | 次按钮、行、输入容器、分段容器 | 不得当页面底 |
| `surface-3` → `bg-surface-3` | `#3f3f46`（zinc-700） | `bg-zinc-700/60` | 按下/悬停的次按钮、头像底 | 不得大面积铺 |
| `fg-primary` → `text-fg-primary` | `#f4f4f5`（zinc-100） | `text-zinc-100` / `text-zinc-50` | 页面标题、卡片标题、正文强调 | 页面标题不再用 zinc-50（V-15） |
| `fg-strong` → `text-fg-strong` | `#d4d4d8`（zinc-300） | `text-zinc-300` | 次按钮标签、列表主文字、强调辅助 | 不得与 primary 同屏抢层级 |
| `fg-secondary` → `text-fg-secondary` | `#a1a1aa`（zinc-400） | `text-zinc-400` | 所有**需要读**的次要文字：说明、空态提示、占位符、表单提示 | 不得再降到 muted |
| `fg-muted` → `text-fg-muted` | `#71717a`（zinc-500） | `text-zinc-500` / `text-zinc-600` | 非关键元信息：计数、装饰性说明、时间戳；**4.12:1** | 不用于空态提示/占位符/操作说明（见 §2.3） |
| `fg-disabled` → `text-fg-disabled` | `#52525b`（zinc-600） | `text-zinc-600` 的禁用态 | **仅** disabled 控件的文字 | 唯一允许 zinc-600 的语义令牌；不得用于正文 |
| `fg-inverse` → `text-fg-inverse` | `#09090b` | — | 白色主按钮/白色滑块上的文字 | — |
| `line-subtle` → `border-line-subtle` | `rgba(255,255,255,.05)` | `border-white/5` 375 处 | 常态细边框 | 禁止 `border-zinc-*` |
| `line-strong` → `border-line-strong` | `rgba(255,255,255,.10)` | `border-white/10` 86 处 | 悬停/强调/浮层边框 | 不得用于分隔线 |
| `state-hover` → `bg-state-hover` | `rgba(255,255,255,.05)` | `bg-white/5` 102 处 | hover 叠加底 | 不得当卡片底 |
| `state-selected` → `bg-state-selected` | `rgba(255,255,255,.07)` | `bg-white/[0.04]`、`bg-white/[0.07]` | 导航/侧栏选中底 | 不得与 hover 同时叠 |
| `state-pressed` → `bg-state-pressed` | `rgba(255,255,255,.10)` | `bg-white/10` | 按下/滑块底/选中徽章 | 不得当常态底 |
| `overlay` → `bg-overlay` | `rgba(9,9,11,.70)` | `bg-zinc-950/70` 17 处 | 所有弹窗遮罩 | 不得使用 /60、/85 等变体 |

### 2.2 品牌色与语义色（保留色，不得新增色相）

| Token | 值 | 对比度（在 `app` 上） | 用途 | 禁止 |
|---|---|---|---|---|
| `brand` | `#0A84FF` | 5.45:1 | 填充、焦点、选中、进度、链接底 | 不得作 11px 正文（contrast 够，但与白字搭配注意） |
| `brand-300` | `#66B0FF` | 8.73:1 | **深色上的品牌文字/图标默认色** | — |
| `brand-400` | `#409CFF` | 7.03:1 | 图标、悬停文字 | — |
| `brand-600` | `#0774E8` | 4.43:1 | 仅按下填充 | **不得作文字色**（低于 4.5） |
| `success` | `#10B981` | 7.84:1 | 完成/已处理/已订阅的填充与图标 | 不得表示「当前」 |
| `success-fg` | `#34D399` | 10.35:1 | 成功文字/图标 | — |
| `warning` | `#F59E0B` | 9.26:1 | 警告填充 | 不得用于主按钮 |
| `warning-fg` | `#FBBF24` | 11.92:1 | 警告文字、收藏星标 | — |
| `danger` | `#EF4444` | 5.29:1 | 危险填充/边框 | 不得用于非破坏操作 |
| `danger-fg` | `#F87171` | 7.19:1 | 危险文字、删除悬停 | — |
| `highlight` | `#8B5CF6` | 4.70:1 | **只**用于 AI 生词高亮的底/边框 | 不得用于选中、hover、词性、装饰 |
| `highlight-fg` | `#D8B4FE` | 11.25:1 | AI 高亮的注释/文字 | 不得用于其他语义 |

**品牌色迁移（V-04）**：`blue-*` → `brand-*` 的唯一映射，共 473 处：

| 旧 | 新 | 说明 |
|---|---|---|
| `text-blue-400` / `text-blue-300` / `text-blue-200` | `text-brand-300` | 深色上文字统一 brand-300（比 blue-400 更亮、对比更高） |
| `text-blue-500` | `text-brand-400` | 图标/小面积 |
| `bg-blue-500` | `bg-brand` | 实底 |
| `bg-blue-500/10`、`/15`、`/20` | `bg-brand/10`、`/15`、`/20` | 着色底 |
| `border-blue-500/20`、`/30` | `border-brand/20`、`/30` | 着色边框 |
| `ring-blue-500/*` | `ring-brand/*` | 焦点/高亮 |
| `from-blue-500/[.08]` 等渐变 | 删除渐变，改 `bg-brand/[.08]` 单色 | V-07 |

**保留色迁移（V-05/V-07/V-08）**：

| 旧 | 新 | 规则 |
|---|---|---|
| `purple-300/500`、`violet-300/400/500` | `highlight-fg` / `highlight` / `highlight/15` | 只保留在 AI 高亮数据路径（`CHUNK_STYLE`、后端 highlights） |
| 选中色 `selection:bg-purple-500/30` | `selection:bg-brand/30` | 全应用统一 |
| 词性徽章 `bg-purple-500/15 text-purple-300` | `bg-surface-2/80 text-fg-strong` | 词性是中性信息，不是 AI 语义 |
| `sky-400`、`pink-400`、`violet-400` 渐变 | `success` 或 `brand` 单色 | 进度/轴不再用彩虹渐变 |

**语义分配（只允许这 5 类）**：品牌蓝=交互/当前/链接/焦点；翠绿=完成/成功/已订阅；琥珀=警告/收藏星标；红=危险/失败；紫=仅 AI 生词高亮。

### 2.3 文字层级、对比度与 A5 待决项裁决（Q-01/Q-02）

A5 在 `design-gate.md` §9 把两个冲突交 A2 裁决，结论如下：

**Q-01（空态配方用了被禁的 zinc-600）**：`设计语言.md` 的颜色节写「禁用 zinc-600」，但通用配方里的空态提示写 `text-zinc-600`。**裁决：以颜色节为准。** 空态组件统一为：

- 标题：`text-fg-strong`（zinc-300，14px/500）
- 提示：`text-fg-secondary`（zinc-400，13px/400）——**不是** zinc-600，也不是 zinc-500
- 图标：`text-zinc-700`（纯装饰，可低于文字对比度）
- 动作：`Button variant=secondary` 或 `primary`（每个空态最多 1 个主操作）

即：`设计语言.md` §通用配方最后一条「提示 `text-xs text-zinc-600 mt-1`」作废，实际以本文件为准；阶段 4 回写《设计语言》。

**Q-02（zinc-500 只有 4.12:1，低于 AA 4.5）**：不通过调亮整条色阶解决（会破坏层级），改用**用途分级**：

| 类别 | 允许的最低文字色 | 对比度 | 例子 |
|---|---|---|---|
| A · 必须读（承载操作/状态/说明） | `fg-secondary`（zinc-400） | 7.76:1 | 空态提示、输入占位符、表单说明、错误文案、导航标签、时间戳、卡片说明 |
| B · 可读但非关键（扫描即可） | `fg-muted`（zinc-500） | 4.12:1 | 计数、步数、图表轴标签、装饰性 eyebrow |
| C · 禁用 | `fg-disabled`（zinc-600） | 2.57:1（WCAG 豁免） | 仅 disabled 控件 |
| D · 纯装饰 | `zinc-700` 及更暗 | — | 空态图标、分隔线、背景图形 |

- **`fg-muted` 不得用于 11px 的中文操作说明/空态提示/占位符**；这三类从今天起归入 A 类。
- 这是对现有设计的**收紧**：A1 V-03 的 87 处 `zinc-600` 先全域替换为 `fg-muted`/`fg-secondary`；凡是承载信息（尤其是空态、占位符、翻译中占位）的一律升到 `fg-secondary`。
- A5 门禁 G6 可按此裁定：A 类必须 ≥4.5:1；B 类作为已登记例外（存量），**新增 B 类用于操作说明即 P1**。

**字号下限**：任何中文/越南语文字不得小于 11px（`text-micro`）。`text-[9px]`、`text-[10px]` 全部并入 11px（V-02/C-07）。

### 2.4 材质与边框（V-10）

A1 数出 5 种遮罩/面板透明度 + 4 档 blur。收敛为 **9 个整选配方（对应 6 类角色）**，组件只能整选，不得拼：

| 材质 | 配方（唯一） | 用在哪 | 旧值迁移 |
|---|---|---|---|
| 页面底 | `bg-app` | 根壳、页面滚动容器 | `bg-[#09090b]` |
| Chrome 顶栏/头 | `bg-app/60 backdrop-blur-xl border-b border-line-subtle` | `AppShell` header、`LearningHeader`、`SubHeader` | `bg-zinc-950/60` |
| 手机底栏 | `bg-app/85 backdrop-blur-xl border-t border-line-subtle` | `BottomBar` | `bg-zinc-950/85` |
| 卡片 | `bg-surface/40 border border-line-subtle` | 普通卡片/主面板 | `bg-zinc-900/40`、`/30` |
| 行/控件 | `bg-surface-2/30`（行）· `bg-surface-2/60`（控件） | 列表行、次按钮、输入容器 | `bg-zinc-800/30`、`/60`、`/80` |
| 遮罩 | `bg-overlay backdrop-blur-md` | 所有 Dialog | `bg-zinc-950/70`、`/85` |
| 对话框 | `bg-surface/90 backdrop-blur-2xl border border-line-strong shadow-elev-3` | 居中/底部弹层 | `bg-zinc-900/90`、`/95` |
| 浮层（词卡/toast） | `bg-surface/85 backdrop-blur-xl border border-line-strong shadow-elev-2` | `WordPopover`、`Toaster` | `bg-zinc-900/85` |
| 侧拉面板 | `bg-surface/80 backdrop-blur-2xl border-x border-line-strong` | 全屏侧拉 | `bg-zinc-900/80` |

- 禁止 `backdrop-blur-sm`、`backdrop-blur`（无档）新增；只允许 `md / xl / 2xl` 三档，且与上表绑定。
- 禁止 `bg-zinc-900/30`、`/60`、`/95` 作为新代码；已有值按上表迁移。
- `.glass-panel` / `.glass-card` 仅保留给营销/欢迎页装饰；业务页面不得新增玻璃卡片（A1 §10 指出玻璃层叠问题）。

### 2.5 旧值 → 新令牌总映射（A4 按此执行）

> 顺序即迁移优先级；每一行都可被 A5 用正则抽查。

| # | 旧值 | 新令牌 | 备注 |
|---|---|---|---|
| 1 | `border-white/5` | `border-line-subtle` | 375 处 |
| 2 | `border-white/10` | `border-line-strong` | 86 处 |
| 3 | `bg-zinc-900/40` | `bg-surface/40` | 卡片默认 |
| 4 | `bg-zinc-900/30` | `bg-surface/30` | 仅行；优先改 `bg-surface-2/30` |
| 5 | `bg-zinc-900/60` | `bg-surface/60` | 输入容器/摘要面板 |
| 6 | `bg-zinc-900/90`、`/95` | `bg-surface/90` | 仅对话框 |
| 7 | `bg-zinc-800/60` | `bg-surface-2/60` | 次按钮/控件 |
| 8 | `bg-zinc-800/30` | `bg-surface-2/30` | 列表行 |
| 9 | `bg-zinc-800/80` | `bg-surface-2/80` | 分段容器 |
| 10 | `bg-zinc-700/60` | `bg-surface-3/60` | 次按钮 hover |
| 11 | `bg-white/5` | `bg-state-hover` | hover |
| 12 | `bg-white/[0.04]`、`/[0.07]` | `bg-state-selected` | 选中 |
| 13 | `bg-white/10` | `bg-state-pressed` | 按下/滑块 |
| 14 | `bg-[#09090b]` | `bg-app` | 35 处 |
| 15 | `text-zinc-50`、`text-zinc-100` | `text-fg-primary` | 页面标题统一（V-15） |
| 16 | `text-zinc-300` | `text-fg-strong` | 次按钮/列表主文 |
| 17 | `text-zinc-400` | `text-fg-secondary` | 可读次要文字 |
| 18 | `text-zinc-500` | `text-fg-muted` | 非关键元信息 |
| 19 | `text-zinc-600` | 见 §2.3：信息类 `text-fg-secondary`，装饰/禁用 `text-fg-muted`/`text-fg-disabled` | **迁移后字面量归零**（87 处） |
| 20 | `text-blue-*` / `bg-blue-*` / `border-blue-*` | `brand*` | 473 处，按 §2.2 表 |
| 21 | `text-purple-*` / `bg-purple-*` / `violet-*` | `highlight*` 或中性色 | 仅 AI 高亮保留 |
| 22 | `sky-*` / `pink-*` | 删除 | 进度/轴改单色 |
| 23 | `text-[9px]`、`text-[10px]`、`text-[11px]` | `text-micro` | 11/16 |
| 24 | `text-[12px]`、`text-[13px]`、`text-xs` | `text-caption` | 13/18 |
| 25 | `text-sm`、`text-[14px]` | `text-ui` | 14/20 |
| 26 | `text-[15px]` | `text-body-zh` | 15/24 |
| 27 | `text-base`、`text-[16px]` | `text-body` | 16/26 |
| 28 | `text-[17px]`、`text-lg`（作为小标题时） | `text-section` | 17/24 |
| 29 | `text-xl`、`text-[19px]` | `text-dialog` | 20/28 |
| 30 | `text-2xl` | `text-page` | 24/32 |
| 31 | `text-3xl` | `md:text-page-lg` | 30/36 |
| 32 | `text-4xl` | `text-display-sm` | 36/40；仅大数字/营销 |
| 33 | `text-5xl` | `text-display` | 48/52；英雄标题/大数字 |
| 34 | `text-6xl` | `text-display-lg` | 60/64；仅欢迎页/结果页大数字 |
| 35 | `shadow-2xl shadow-black/60` | `shadow-elev-3` | 对话框 |
| 36 | `shadow-[...]` | `shadow-elev-2`（浮层）或删除 | 5 处 |
| 37 | `shadow-black/*` | 删除 | 22 处 |
| 38 | `rounded-3xl` 普通卡片 | `rounded-card`（16px） | 仅页面级主面板保留 `rounded-panel` |
| 39 | `rounded-2xl` 卡片/浮层 | `rounded-card` / `rounded-layer` | 见 §5 |
| 40 | `h-9 rounded-xl` | `h-9 rounded-control` | V-09：≤36px 控件只允许 8px 圆角 |
| 41 | `active:scale-[0.95]`、`hover:scale-[...]` | 控件 `0.98`；大卡片 `0.99` | 删除 0.95 / 悬停缩放；0.99 仅大卡片 |
| 42 | `hover:scale-[...]` | 删除 | 悬停绝不缩放 |
| 43 | 裸 `transition` | `transition-colors` / `transition-[明确属性]` | + `duration-200 ease-apple` |
| 44 | `h-screen`、`min-h-screen` | `h-dvh`、`min-h-dvh` | V-11 |
| 45 | `max-h-[85vh]`、`[92vh]` | `max-h-[85dvh]`、`[92dvh]` | V-11 |
| 46 | `z-[...]`、`z-*` 12 档 | §7 的 7 个 token | V-13 |
| 47 | `selection:bg-purple-500/30` | 全局 `::selection`（brand/30），组件不写 | V-05 |
| 48 | 组件级 `focus:outline-none`、`focus:ring-*` | 删除；只保留全局 `:focus-visible` + 输入容器 `focus-within` | V-14 |

---

## 3. 排版

### 3.1 字体与字重

- 字体栈沿用 `tailwind.config.js` 的 `font-sans`（SF Pro → PingFang SC → …，含越南语 Latin Extended 回退）。**不允许在组件里写 `font-family`。**
- 字重只允许 **400 / 500 / 600**；标题最高 600。`font-bold` / `font-extrabold` 禁止（当前 0 处）。
- 中文不使用 `italic`、`uppercase`、`tracking-wider`（《设计语言》）；数字用 `tabular-nums`。
- 标题字距：页面/区块标题 `tracking-tight`；今日英雄标题 `tracking-hero`（-0.015em，保留现有）。

### 3.2 字号阶梯与旧值映射（V-02/V-15）

| Token | 字号/行高 | 用途 | 旧值（→ 合并） |
|---|---|---|---|
| `text-micro` | 11px / 16px | 时间戳、计数徽章、底栏标签、ruby 注音、eyebrow、表单计数 | 9、10、11px；`text-[11px]` |
| `text-caption` | 13px / 18px | 次要说明、表单提示、紧凑控件、表格表头、分页 | 12、13px；`text-xs`；`text-[13px]` |
| `text-ui` | 14px / 20px | **默认 UI 文字**：按钮、列表行、输入、标签、正文 | `text-sm`、14px |
| `text-body-zh` | 15px / 24px | 中文字幕/中文译文/中文正文 | 15px |
| `text-body` | 16px / 26px | 英文字幕/英文正文/文章正文 | 16px、`text-base` |
| `text-section` | 17px / 24px | 区块标题、子视图头标题、词卡词头 | 17px；`text-lg` 作小标题时 |
| `text-dialog` | 20px / 28px | Dialog/Sheet 标题 | `text-xl`、19px |
| `text-page` | 24px / 32px | 一级页页面标题（**仅移动端**） | `text-2xl` |
| `text-page-lg` | 30px / 36px | 一级页标题 ≥md | `text-3xl` |
| `text-display-sm` | 36px / 40px | 大数字（报告/结果/统计）、欢迎页副标题 | `text-4xl` |
| `text-display` | 48px / 52px | 今日英雄标题、评分/大数字 | `text-5xl` |
| `text-display-lg` | 60px / 64px | 仅欢迎/结果页大数字 | `text-6xl` |

**响应式规则**：

- 一级页标题：移动端 `text-page`，`md:` 起 `text-page-lg`；**桌面端标题在顶栏（15px）时，页面内不再渲染 h1**（见 `layout.md` §4）。
- 今日的英雄标题是唯一例外：移动端 `text-page`，`sm:` `text-display-sm`，`md:` `text-display`。一级页其他页面不得用 `display*`。
- 子视图头标题**不用** `text-page`，统一 `text-section`（17px），避免头部跳动（L-12）。
- 英中阅读对始终差一级：`text-body`（英）+ `text-body-zh`（中）；二者切换只改颜色，不改字号/字重（《设计语言》）。

**禁止**：新增 `text-[Npx]`；用字号表达层级以外的目的（如用 24px 做卡片标题）。

### 3.3 特殊排版

- 阅读行宽：`max-w-reading`（720px）+ `leading-relaxed`；双语并排时每栏不小于 320px。
- 段落/字幕英文 `tracking-normal`；标题 `tracking-tight`；英雄 `tracking-hero`。
- ruby 注音：`font-size: 11px; line-height: 1.1`；颜色见 `components.md` §15。
- 占位符：`placeholder:text-fg-secondary`（**不是 zinc-500/600**）；输入文字 `text-fg-primary`。
- 空态/错误文案不用斜体（中文无斜体），不改字重，只改颜色。
- 按钮/徽章文本不换行：`whitespace-nowrap`；表格/长标题允许 `break-words`。

---

## 4. 间距、尺寸与容器

### 4.1 间距阶梯与语义（V-19）

基础网格 4px。**允许的值**：`0 / 0.5(2) / 1(4) / 1.5(6) / 2(8) / 2.5(10) / 3(12) / 4(16) / 5(20) / 6(24) / 8(32) / 10(40) / 12(48)`。2px/6px/10px 只用于图标对齐、徽章内边距，不用于区块节奏。

| 语义 | 移动端 | ≥md | 旧值 |
|---|---|---|---|
| 页内边距（左右） | 16 | 24 → 32（≥lg） | `px-4 sm:px-6 lg:px-8` |
| 页顶内边距 | 20 | 32 | `pt-4` / `pt-5` / `py-6` 统一 |
| 页底内边距（有底栏） | 56+safe+16 | 24 | `PAGE_PAD` 三份复制 |
| 区块间距（section） | 24 | 32 | `gap-6 sm:gap-8`、`space-y-4/5` |
| 卡片间距 | 16 | 20（2 列）/24（3 列） | `gap-2.5/4/5/6` |
| 卡片内边距 | 16 | 20 | `p-3.5 sm:p-5`、`p-4 sm:p-5` |
| 主面板内边距 | 16 | 24 | `p-4 sm:p-6` |
| 列表行内边距 | 12 | 12 | `p-3` |
| 行内元素间距 | 6/8 | 8/12 | `gap-1.5/2/3` |
| 图标与文字 | 6/8 | 8 | `gap-1.5/2` |

**禁止**：`p-[13px]`、`gap-[18px]` 这类非阶梯值；`space-y-*` 与 `gap-*` 混用在同一个 flex 容器。

### 4.2 控件高度与触控目标

| Token | 高度 | 用途 | 圆角 |
|---|---|---|---|
| `h-control-xs` | 28px | 工具栏内搜索/筛选 chip（仅桌面） | `rounded-control` |
| `h-control-sm` | 32px | 紧凑按钮、分页、tab 选项 | `rounded-control` |
| `h-control-md` | 36px | 次按钮、导航 tab、输入 | `rounded-control` |
| `h-control-lg` | 40px | 主按钮、标准输入、Dialog 按钮 | `rounded-control-lg`（12px） |
| `h-control-xl` | 48px | 仅首页/开始学习 hero CTA | `rounded-full` |
| `h-topbar` | 48（<md）/64（≥md） | 顶栏 | — |
| `h-subheader` | 48 | 子视图头 | — |
| `h-bottombar` | 56 + safe | 手机底栏 | — |
| `h-sidebar-header` | 64 | 侧栏品牌区 | — |

- **触控目标 ≥44×44**：所有按钮/图标按钮/导航项在 `pointer: coarse` 下必须有 44px 命中区（可用 `min-h-11`、内边距或伪元素扩展），视觉高度可仍为 32/36。
- 图标尺寸：按钮内 16，工具栏 14，区块标题 20；不再使用 12/18/22 等混值。
- 头像：24（顶栏）、32（侧栏）、36（账户头）。

### 4.3 容器宽度（V-16）

| Token | 宽度 | 谁用 |
|---|---|---|
| `max-w-page` | 1440px | 今日 / 内容 / 练习 / 我的（外层统一） |
| `max-w-admin` | 1152px | 管理台、设置型内容 measure |
| `max-w-library` | 1024px | 单词本、公版书书架 |
| `max-w-course` | 768px | 课程 |
| `max-w-reading` | 720px | 博客、阅读器单栏 |
| `max-w-task` | 672px | 复习/报告/理解题/考试/定位/能力 |
| `max-w-rail` | 320px | 内容页右栏 |
| `max-w-dialog-sm` | 448px | 小 Dialog（语言设置） |
| `max-w-dialog-md` | 576px | 表单 Dialog |
| `max-w-dialog-lg` | 896px | 频道列表等大列表 |

- **四个一级页外层容器与左右内边距必须相同**（`max-w-page` + §4.1 页内边距）。页面内部允许再套 `< measure`（如「我的」用 `max-w-admin`、任务页用 `max-w-task`），但必须**左对齐**在同一页内边距上，不得居中造成左缘跳动。
- 内容页：`≥xl` 两栏 `minmax(0,1fr) 320px` + 32 gap；`lg–xl` 单栏 + 顶部横排 rail（见 `layout.md` §6.2）。
- 任何新页面只能引用上表，不得新增 `max-w-[...]`。

---

## 5. 圆角（V-09）

| Token | 值 | 用途 |
|---|---|---|
| `rounded-control` | 8px（`rounded-lg`） | 高度 ≤36px 的控件、tab 选项、图标按钮、缩略图、小标签、分页 |
| `rounded-control-lg` | 12px（`rounded-xl`） | 高度 40px 的按钮/输入、列表行、小卡片（StatTile） |
| `rounded-card` | 16px（`rounded-2xl`） | 普通卡片、Dialog、词卡、toast |
| `rounded-panel` | 24px（`rounded-3xl`） | **仅**一级页主面板/页面级 bento（每个页面最多 1 个主面板使用） |
| `rounded-layer` | 16px | 浮层（与 card 同值，语义分开以便未来调整） |
| `rounded-full` | 9999px | 胶囊：hero 输入/CTA、徽章、头像、圆形关闭按钮 |
| Logo | 10px | 仅品牌方块 |

**硬映射（A5 可直接抽查）**：

- `h-8`、`h-9` → 只允许 `rounded-control` 或 `rounded-full`；**禁止 `rounded-xl`**（V-09 的 `h-9 rounded-xl` 迁移）。
- `h-10` → `rounded-control-lg`（12px）；**主按钮不再用 `rounded-full`**，只有 hero/X L 用 full。
- 卡片 → `rounded-card`；主面板 → `rounded-panel`；**禁止 `rounded-2xl sm:rounded-3xl` 这种响应式变档**。
- 浮层/对话框 → `rounded-card`（移动底部弹层用 `rounded-t-panel`，底边直角）。
- 任何 `< 28px` 的元素不使用 `rounded-panel`。

---

## 6. 阴影与高度层（V-12）

只允许 3 档阴影，且必须用 token：

| Token | 值 | 用途 |
|---|---|---|
| `shadow-elev-1` | `0 1px 1px rgba(0,0,0,.25), 0 4px 12px rgba(0,0,0,.25)` | 小浮层、下拉、hover 抬升（少用） |
| `shadow-elev-2` | `0 1px 1px rgba(0,0,0,.30), 0 8px 24px rgba(0,0,0,.35)` | 词卡、Toast、分段滑块 |
| `shadow-elev-3` | `0 1px 2px rgba(0,0,0,.35), 0 24px 60px rgba(0,0,0,.50)` | Dialog、Sheet |

- 禁止 `shadow-2xl`、`shadow-black/*`、`shadow-[...]`（现有 5 处任意阴影全部并入 elev-2/3）。
- 阴影不用于普通卡片（卡片靠底色/边框表达），只用于「离开页面平面」的浮层。
- 深色界面上阴影只是辅助；同时必须有边框或底色差，不能只靠阴影区分层级。

---

## 7. z-index 分层（V-13）

12 档 56 处收敛为 **7 层 + 1 个页内抬升**：

| Token | 值 | 用途 | 旧值合并 |
|---|---|---|---|
| `z-base` | 0 | 普通内容 | — |
| `z-raised` | 10 | **页内**局部抬升（缩略图角标、图片遮罩），不得跨组件 | `z-10` |
| `z-chrome` | 20 | 顶栏、侧栏、学习页头、子视图头 | `z-20` |
| `z-nav` | 30 | 手机底栏、离线标记（非模态） | `z-30`、`z-[95]`（离线） |
| `z-overlay` | 40 | Dialog 遮罩 | `z-40` |
| `z-dialog` | 50 | Dialog 面板、菜单、Popover 的宿主 | `z-50`、`z-[60]`、`z-[70]`、`z-[80]` |
| `z-popover` | 60 | 词卡、tooltip（必须高于 dialog 内容，低于 toast） | `z-[90]` |
| `z-toast` | 100 | Toast、全局提示 | `z-[100]`、`z-[120]` |

**旧→新映射**：`z-50` / `z-[60]` / `z-[70]` / `z-[80]` → `z-dialog`（Dialog、菜单）；`z-[90]` → `z-popover`；`z-[95]` → 离线 `z-nav`；`z-[100]` / `z-[120]` → `z-toast`（PWA 安装对话框改 `z-dialog`，因为它是模态，不是全局提示）。

规则：

- 只有 `Dialog` 能用 `z-dialog`；只有 `WordCard`/tooltip 能用 `z-popover`；只有 `Toaster` 能用 `z-toast`。
- 不允许同级并列值：同一层只有一个 token。DOM 顺序不再决定谁在上。
- 任何 `z-[...]` 新增即门禁失败；页内局部叠放用 `z-raised`，且父元素必须有 `relative`。

---

## 8. 断点与布局档位（L-11）

保留 Tailwind 默认断点（`sm 640 / md 768 / lg 1024 / xl 1280`），但**结构决策只允许在 `md` 与 `lg` 发生**：

| 档位 | 范围 | 结构 |
|---|---|---|
| `compact`（手机） | `< 768` | 顶栏 48；底栏 56+safe；单栏；页面标题在页内 |
| `regular`（桌面窄） | `768 – 1023` | 顶栏 64 + 文字 tab（md–lg）；无侧栏；单栏 |
| `wide`（桌面） | `≥ 1024` | 侧栏 240/72 + 顶栏标题；内容页在 `≥1280` 两栏；`1024–1279` 单栏 + 顶部 rail 横排 |

- **`sm` 只允许用于字号/间距/网格列数的微调**，不得用于改变导航壳、显示/隐藏主操作、改变页面层级。
- **禁止 `max-md:` 局部补丁**（A1 L-11）；移动端差异用默认值 + `md:` 覆盖表达。
- 新增页面只引用三档：`<md` 单栏、`md–lg` 顶栏 tab、`≥lg` 侧栏。内容页的两栏只在 `xl` 出现（1024–1279 用其他形态，见 `layout.md` §6.2）。

---

## 9. 动效（V-20/V-21）

| Token/规则 | 值 | 用途 |
|---|---|---|
| `duration-fast` | 150ms | 颜色微调（少用） |
| `duration-base` | 200ms | **默认**：颜色、背景、边框、透明度 |
| `duration-slow` | 300ms | 浮层进出、面板展开 |
| `ease-apple` | `cubic-bezier(.25,1,.5,1)` | 位移/缩放/布局 |
| `ease-exit` | `cubic-bezier(.4,0,1,1)` | 退出（fade out） |
| 标准弹簧 | `{ stiffness: 380, damping: 32 }` | 浮层/卡片出现 |
| 分段/导航滑块 | `{ stiffness: 420, damping: 36 }` | `layoutId` 滑块 |
| 按压 | 控件 `active:scale-[0.98]`；大卡片 `0.99` | 唯一两档 |
| 悬停 | 只改背景/边框/颜色，**绝不缩放**；列表行不位移 | — |

- `transition` 必须**明确属性**：`transition-colors`、`transition-[background-color,transform]`、`transition-transform`；禁止裸 `transition`（默认会对所有属性生效）和 `transition-all`。
- 颜色过渡统一 200ms + 默认 ease；带位移/缩放的过渡必须 `ease-apple`。
- **`prefers-reduced-motion` 全局兜底**：在 `App` 根部包 `<MotionConfig reducedMotion="user">`（一处覆盖全部 framer-motion）；CSS 侧对所有 `animate-*` 加 `@media (prefers-reduced-motion: reduce) { animation: none; transition-duration: 0.01ms !important; }`（保留状态变化，不做位移）。
- 装饰性动效（极光/粒子/倾斜）仅限欢迎页，且必须 reduced-motion 关闭；业务页面禁止新增。

---

## 10. 焦点、选择、滚动条、安全区（V-14/V-11）

### 10.1 焦点环（唯一实现）

```css
:focus-visible {
  outline: 2px solid rgb(var(--focus-ring) / .65);
  outline-offset: 2px;
}
```

- **删除** `index.css` 现行 `:focus-visible { border-radius: 8px }`：它会在聚焦时改变元素圆角（全局副作用）。
- 组件不得写 `focus:ring-*`、`focus:outline-none`、`focus-visible:ring-*`；输入框例外：由**容器** `focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/15` 表达（字段本身 `outline-none` 是允许的，但必须包在有 focus-within 的壳里）。
- 自定义焦点环不得与全局环叠加；如确需内嵌（如白色按钮），用 `outline-brand-600` 并保持 2px/2px。

### 10.2 选中与滚动条

- `::selection`：`background: rgb(var(--brand) / .30)`（全局唯一；组件不得写 `selection:bg-purple-*`）。
- Webkit 滚动条：宽 7px（`custom-scrollbar` 6px）；thumb `rgba(255,255,255,.08)`，hover `.18`；track 透明。禁止为单个页面改滚动条颜色。
- 横向滚动容器（tab strip、卡片横排）必须 `overflow-x-auto` + `custom-scrollbar`，不得隐藏滚动条。

### 10.3 尺寸单位与安全区

- **只允许 `dvh`**：根壳 `h-dvh`，全屏页 `min-h-dvh`，弹层 `max-h-[calc(100dvh-2rem)]`；禁止 `h-screen` / `min-h-screen` / `92vh`。
- `index.html` **已含** `viewport-fit=cover`（A1/IA 的「缺 meta」是旧结论，复核为已有），不需要再补；剩余问题是 `h-screen` 双写与 `100vh`。
- CSS 变量：

```css
:root {
  --app-bg: 9 9 11;
  --brand: 10 132 255;
  --focus-ring: 10 132 255;
  --bottom-bar-h: 3.5rem;
  --topbar-h-mobile: 3rem;
}
```

- 安全区只在 5 处使用：底栏 `padding-bottom: env(safe-area-inset-bottom)`；一级页滚动容器 `pb-[calc(56px+env(safe-area-inset-bottom)+16px)]`；Toast 底部偏移；底部弹层；学习页/课程页底部动作条。
- **不要**给 `body` 加全局 padding；滚动由页面自己管（IA §6.4）。

---

## 11. 实现分层：哪些进 CSS 变量 / Tailwind / Utility

| 内容 | 落点 | 理由 |
|---|---|---|
| 页面底色、品牌通道、焦点环、底栏高、安全区 | **CSS 变量** | 原生 CSS（body/selection/scroll-padding）、`env()` 组合需要运行时值 |
| 颜色、字号、圆角、阴影、z、控件高、容器宽 | **Tailwind theme** | 组件只用类名；可被 lint/正则扫描 |
| 布局（flex/grid/间距/定位/断点） | **Utility** | 无需抽象；Tailwind 已覆盖 |
| 页面安全区 padding、滚动 padding | **自定义 utility**（`@layer utilities`） | 一个类承载 `calc(56px + env(...))`，避免 5 份复制 |
| 玻璃材质 `.glass-*` | **保留 CSS 类** | 仅欢迎页；不进 theme |
| 字号/间距任意值 | **禁止** | 例外见 §13 |

**自定义 utility（建议）**：

```css
@layer utilities {
  .pb-safe-nav { padding-bottom: calc(var(--bottom-bar-h) + env(safe-area-inset-bottom) + 1rem); }
  .scroll-pb-safe-nav { scroll-padding-bottom: calc(var(--bottom-bar-h) + env(safe-area-inset-bottom) + 1rem); }
  .bottom-safe-nav { bottom: calc(var(--bottom-bar-h) + env(safe-area-inset-bottom) + 0.75rem); }
  .scroll-pt-chrome { scroll-padding-top: calc(var(--topbar-h-mobile) + 1rem); }
}
```

`@media (min-width: 768px)` 时底栏消失，`pb-safe-nav` 由 `md:pb-6` 覆盖。

---

## 12. 可执行的 Tailwind theme 配置片段（只设计，不改文件）

> 合并进 `frontend/tailwind.config.js` 的 `theme.extend`；保留现有 `fontFamily` 与 `glass`。`brand` 原值不变。

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: { /* 保持现有 */ },
      colors: {
        app: '#09090b',
        surface: { DEFAULT: '#18181b', 2: '#27272a', 3: '#3f3f46' },
        fg: {
          primary: '#f4f4f5',
          strong: '#d4d4d8',
          secondary: '#a1a1aa',
          muted: '#71717a',
          disabled: '#52525b',
          inverse: '#09090b',
        },
        line: {
          subtle: 'rgba(255,255,255,0.05)',
          strong: 'rgba(255,255,255,0.10)',
        },
        state: {
          hover: 'rgba(255,255,255,0.05)',
          selected: 'rgba(255,255,255,0.07)',
          pressed: 'rgba(255,255,255,0.10)',
        },
        overlay: 'rgba(9,9,11,0.70)',
        control: '#f4f4f5',
        brand: { DEFAULT: '#0A84FF', 300: '#66B0FF', 400: '#409CFF', 500: '#0A84FF', 600: '#0774E8' },
        success: { DEFAULT: '#10B981', fg: '#34D399' },
        warning: { DEFAULT: '#F59E0B', fg: '#FBBF24' },
        danger: { DEFAULT: '#EF4444', fg: '#F87171' },
        highlight: { DEFAULT: '#8B5CF6', fg: '#D8B4FE' },
        glass: { /* 保持现有；仅欢迎页 */ },
      },
      fontSize: {
        micro: ['0.6875rem', { lineHeight: '1rem' }],
        caption: ['0.8125rem', { lineHeight: '1.125rem' }],
        ui: ['0.875rem', { lineHeight: '1.25rem' }],
        'body-zh': ['0.9375rem', { lineHeight: '1.5rem' }],
        body: ['1rem', { lineHeight: '1.625rem' }],
        section: ['1.0625rem', { lineHeight: '1.5rem' }],
        dialog: ['1.25rem', { lineHeight: '1.75rem' }],
        page: ['1.5rem', { lineHeight: '2rem' }],
        'page-lg': ['1.875rem', { lineHeight: '2.25rem' }],
        'display-sm': ['2.25rem', { lineHeight: '2.5rem' }],
        display: ['3rem', { lineHeight: '3.25rem' }],
        'display-lg': ['3.75rem', { lineHeight: '4rem' }],
      },
      letterSpacing: { hero: '-0.015em' },
      borderRadius: {
        control: '0.5rem',
        'control-lg': '0.75rem',
        card: '1rem',
        layer: '1rem',
        panel: '1.5rem',
      },
      height: {
        'control-xs': '1.75rem',
        'control-sm': '2rem',
        'control-md': '2.25rem',
        'control-lg': '2.5rem',
        'control-xl': '3rem',
        subheader: '3rem',
        topbar: '4rem',
        'topbar-mobile': '3rem',
        bottombar: '3.5rem',
        'sidebar-header': '4rem',
      },
      minHeight: { touch: '2.75rem' },
      width: { sidebar: '15rem', 'sidebar-collapsed': '4.5rem' },
      maxWidth: {
        page: '90rem',
        admin: '72rem',
        library: '64rem',
        course: '48rem',
        reading: '45rem',
        task: '42rem',
        rail: '20rem',
        'dialog-sm': '28rem',
        'dialog-md': '36rem',
        'dialog-lg': '56rem',
      },
      transitionTimingFunction: {
        apple: 'cubic-bezier(0.25, 1, 0.5, 1)',
        exit: 'cubic-bezier(0.4, 0, 1, 1)',
      },
      boxShadow: {
        'elev-1': '0 1px 1px rgba(0,0,0,.25), 0 4px 12px rgba(0,0,0,.25)',
        'elev-2': '0 1px 1px rgba(0,0,0,.30), 0 8px 24px rgba(0,0,0,.35)',
        'elev-3': '0 1px 2px rgba(0,0,0,.35), 0 24px 60px rgba(0,0,0,.50)',
      },
      zIndex: {
        base: '0',
        raised: '10',
        chrome: '20',
        nav: '30',
        overlay: '40',
        dialog: '50',
        popover: '60',
        toast: '100',
      },
      animation: { /* 保持 fadeIn/slideUp */ },
      keyframes: { /* 保持 */ },
    },
  },
  plugins: [],
};
```

---

## 13. 门禁检查项（可直接写成 A5 脚本/正则）

| # | 检查 | 失败级别 | 范围/例外 |
|---|---|---|---|
| T-01 | 无新增 `#hex`、`rgb(`、`bg-[#` | P0 | `tailwind.config/index.css/index.html/manifest` 的底色三处需一致 |
| T-02 | 无 `border-white/5`、`border-white/10` | P1 | 全部组件 |
| T-03 | 无 `text-zinc-600`（字面量）；`fg-disabled` 只用于 disabled | P0 | 存量迁移后归零 |
| T-04 | 无 `blue-*` / `purple-*` / `violet-*` / `sky-*` / `pink-*` 的 Tailwind 色类 | P0（`blue`/`purple`）；P1（`violet`/`sky`/`pink`） | 例外：`highlight` 数据路径不得写色类；`violet` 仅允许在 `CHUNK_STYLE`（lib）中 |
| T-05 | 无 `text-[Npx]`（N ≠ 0） | P1 | `rounded-[10px]`、`tracking-hero` 例外 |
| T-06 | 无 `text-(9|10)px`；`text-micro` 以下不存在 | P0 | 全部 |
| T-07 | 无 `shadow-[`、`shadow-2xl`、`shadow-black` | P1 | 浮层只允许 elev-2/3 |
| T-08 | `z-` 只允许 8 个 token；无 `z-[N]` | P1 | 全部 |
| T-09 | `h-screen` / `min-h-screen` / `vh` 后缀为 0 | P1 | `dvh` 唯一 |
| T-10 | `zinc-900/30|/60|/90|/95` 新增为 0（按角色迁移） | P2 | 存量 |
| T-11 | 圆角-高度映射：`h-8/h-9` 不出现 `rounded-xl`；`h-10` 不出现 `rounded-full`（hero 除外） | P2 | 组件 |
| T-12 | 每个组件级文件无 `focus:outline-none`（输入壳的字段除外） | P1 | `focus-within` 壳允许 |
| T-13 | `index.html` / `manifest.webmanifest` / `index.css --app-bg` 的底色值一致 | P1 | 脚本可解析三处 |
| T-14 | 无裸 `transition`（`transition` 后不接 `-`） | P2 | 例外：`transition-none` |
| T-15 | 无 `hover:scale-`、`active:scale-[0.95]`；0.99 只允许大卡片 | P2 | 组件 |

---

## 14. 上游文档勘误与未决

1. **`设计语言.md` §通用配方·空状态**：`提示 text-xs text-zinc-600` 与颜色节「禁用 zinc-600」冲突 → 按 §2.3 执行（提示 `text-fg-secondary`）。阶段 4 回写。
2. **`设计语言.md` §按钮·主按钮**写 `transition-all`，与本文件 §9「禁止 transition-all」冲突 → 以本文件为准（`transition-[background-color,transform]`）。
3. **IA 文档 §6.1** 说 `index.html` 缺 `viewport-fit=cover` → 复核**已存在**；不要重复添加。
4. **`shadow-elev-2` 的取值**采用现有 toast/词卡的实际任意阴影（`0 8px 24px` 档），而非原 config 的 `0 8px 24px` 近似值；视觉差异需在 A4 截图对比，±10% 内可接受。
5. **未决（P2）**：是否引入 light theme——本轮不做；所有 token 只覆盖暗色。欢迎页的 `display-lg` 是唯一允许 >48px 的正文场景。
6. **未决（P2）**：`brand-600` 对比度 4.43，仅用于填充悬停；若设计确认要作文字色，需改为 `brand-500`。

---

*上游：A1 `audit-report.md` §3、§6、§7；IA §5、§6；《设计语言》。下游：`components.md`（组件）、`layout.md`（布局）、A4 迁移表、A5 门禁。*
