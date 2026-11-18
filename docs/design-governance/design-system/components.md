# 语途核心组件规范（Components）v1.0

> 作者：A2 · 设计系统架构师 ｜ 日期：2026-11-19 ｜ 阶段：1（门禁 1）
> 依赖：`tokens.md`（下称 T）、`docs/design-governance/audit-report.md`（下称 A1）、`docs/设计语言.md`、《信息架构-导航重构》（下称 IA）。
> 范围：只定义当前实际存在/上线前必需的核心组件；**不写迁移代码，不写完整旧→新映射表**（留给 A4）。组件实现必须只用 T 的令牌。

---

## 1. 总则（所有组件共同遵守）

### 1.1 组件边界

1. 一个视觉角色只有一个组件实现；禁止在页面里再定义 `PRIMARY_BUTTON`、`CARD`、`PAGE_BUTTON` 等类常量（A1 C-01）。新代码只 import 组件。
2. 组件不读业务状态（路由、auth、i18n 文案除外）；文案由调用方通过 `t()` 传入或使用 i18n key，组件不硬编码中文/英文（V-06 的结构性预防）。
3. 组件不写裸色值/任意字号/任意 z/任意阴影；所有视觉值来自 T。
4. 组件的 `className` 只允许布局覆盖（宽度、外边距、对齐），**不允许**覆盖颜色、圆角、字号、阴影；需要新变体就新增语义 variant，不在调用处 patch。
5. 所有可交互元素必须有 `:focus-visible` 可见焦点；禁止 `outline-none` 吞掉全局环（T §10）。
6. 所有图标按钮必须有 `aria-label` + `title`；所有异步区域必须有 loading/error/empty 三态（不适用时显式写 `—`）。

### 1.2 状态定义（本文件统一口径）

| 状态 | 判定 | 通用要求 |
|---|---|---|
| default | 无交互、无数据异常 | 使用 token 的常态值 |
| hover | `pointer: fine` 且指针悬停 | 只改背景/边框/文字色；**不缩放、不位移**（T §9） |
| active | 按下（鼠标/触摸） | 控件 `scale(.98)`；导航/列表行不缩放 |
| focus | 键盘 `:focus-visible` | 2px `rgba(10,132,255,.65)` 环，offset 2；不得被任何组件覆盖 |
| disabled | 不可操作 | `opacity-50` + `pointer-events-none` + `aria-disabled="true"`；不响应 hover/active |
| loading | 异步进行中 | 保留布局宽度；显示 spinner；`aria-busy="true"`；禁止重复提交 |
| error | 操作/数据失败 | 按层级呈现：字段内联 / 操作 toast / 页面 ErrorPanel；**不得渲染成 empty** |
| empty | 请求成功但无数据 | 使用 EmptyState；必须有「下一步」动作或明确说明；**不得与 error 混用** |

### 1.3 无障碍基线

- 文本对比度：A 类文字 ≥4.5:1（T §2.3）；焦点环 2px；触控目标 ≥44×44（coarse pointer）。
- 语义：优先原生元素（`button` / `a` / `input` / `dialog` 的等价 role）；自定义控件必须补齐 role/状态/键盘。
- 键盘：Tab 顺序 = 视觉顺序；Esc 关闭浮层；Enter/Space 激活；方向键用于 tab/radio/菜单。
- 动效：尊重 `prefers-reduced-motion`；loading 的脉动在 reduced-motion 下改为静态。
- 中文/越南语：最小 11px；不 `uppercase`、不 `italic`；按钮标签不换行（`whitespace-nowrap`）。

### 1.4 组件清单与替代关系（A1 ID）

| # | 组件 | 替代的旧实现/A1 ID | 主要使用处 |
|---|---|---|---|
| C1 | Button（含 IconButton/DangerButton） | C-01、V-04、V-20、V-21、I-19、C-15 | 全站 |
| C2 | Card / ListRow / IconTile | C-01、C-11、V-09、V-10、V-12、V-18 | 一级页、右栏、书架、设置行 |
| C3 | Input / Textarea / SearchField | 6.1「搜索框」行、V-14、I-17（模式选择改用 Segmented） | 粘贴框、搜索、表单 |
| C4 | Dialog / ConfirmDialog / Sheet | C-02、I-02、I-03、I-04、I-05、V-10、V-13 | 13 个浮层 |
| C5 | Tabs | C-05、C-07（计数）、L-07（与 C14 配合） | 顶栏导航、内容页、管理台、单词本 |
| C6 | Segmented | C-06、I-17 | 译文模式、季选择、语言、登录/注册 |
| C7 | Badge / CountBadge | C-07、C-13、V-02、N-10（格式化） | 导航、卡片、来源标签 |
| C8 | Toast | I-10、I-06、I-19 | 全局反馈 |
| C9 | Pagination | I-18 | 单词本、最近学习、管理台 |
| C10 | EmptyState / Loading / ErrorPanel / Skeleton | I-01、I-07、I-08、I-09、V-03、L-10、L-14 | 全站 |
| C11 | NavShell（Sidebar/TopBar/BottomBar） | C-05（导航 tab）、C-07（徽章）、V-15、L-11、L-12 | 全局壳 |
| C12 | PageHeader / SubHeader / BackButton | I-11、L-09、L-12、V-15 | 一级页/子视图 |
| C13 | WordCard / WordHighlight | C-03、C-04、I-06、I-12、I-15、I-16、V-05 | 字幕、阅读器、词卡 |
| C14 | VocabRow / VocabTabStrip | L-07、I-12、C-07、C-13、N-10 | 单词本 |
| C15 | CourseStepControls / Progress | C-12、V-08、V-20 | 课程、学习页进度 |

> A1 的 C-08（时间格式化）、C-09（`cn`/阅读宽度）、N-10（计数格式）不是视觉组件，归入 §18「共享基础函数」，由 A4 移到 `lib/`。

---

## C1 · Button

### 用途 / 何时用 / 何时不用

- **用途**：触发一个动作（提交、确认、打开、删除）。
- **用**：页面主操作、卡片动作、表单提交、Dialog 页脚、图标操作。
- **不用**：导航目的地（用 `<a>`/NavShell 的 tab）、纯展示的标签（用 Badge）、开关状态（用 Segmented/Tabs）。

### Anatomy

```
[iconLeft 16] [label 14/600 或 14/500] [iconRight 16] [spinner 16（loading）]
容器：inline-flex items-center justify-center gap-2 whitespace-nowrap
```

### API（语义级）

| 名称 | 类型 | 说明 |
|---|---|---|
| `variant` | `primary \| secondary \| tinted \| ghost \| destructive \| icon` | 视觉层级；`tinted` 必须配 `tone` |
| `tone` | `brand \| success \| warning \| danger` | 仅 tinted 使用 |
| `size` | `sm(32) \| md(36) \| lg(40) \| xl(48)` | 默认 `md`；主操作用 `lg`；hero 用 `xl` |
| `loading` / `loadingLabel` | boolean / string | spinner + 保留原文案；宽度不变 |
| `disabled` | boolean | 语义 disabled，不只是样式 |
| `fullWidth` | boolean | 移动端表单/Dialog 页脚 |
| `iconOnly` | boolean | 必须同时给 `ariaLabel` |
| `onClick` | `() => void` | 不接收原生 event 以约束用法 |

### 尺寸与变体（唯一配方）

| variant | 常态 | hover | 说明 |
|---|---|---|---|
| primary | `bg-zinc-100 text-fg-inverse` | `bg-white` | 每个视口最多 1 个 |
| secondary | `bg-surface-2/60 border-line-subtle text-fg-strong` | `bg-surface-3/60 text-fg-primary` | 次操作 |
| tinted | `bg-{tone}/10 border-{tone}/20 text-{tone}-fg` | `bg-{tone}/15` | 品牌/成功/危险等 |
| ghost | `text-fg-secondary` | `bg-state-hover text-fg-primary` | 低权重 |
| destructive | `bg-danger/10 border-danger/20 text-danger-fg` | `bg-danger/15` | 删除/退出 |
| icon | `p-2 text-fg-secondary` | `bg-state-hover text-fg-primary` | 命中区 ≥44 |

- 圆角：`sm/md` → `rounded-control`（8）；`lg` → `rounded-control-lg`（12）；`xl` → `rounded-full`（仅 hero/开始学习）。
- 主按钮禁止 `rounded-full`（除 `xl`）；禁止 `h-11` / `h-12` 作为“主按钮变体”（那是旧代码漂移，A1 C-01）。

### 状态矩阵

| 状态 | 视觉 | 行为 / 可检查点 |
|---|---|---|
| default | 按上表；文字 14/500（primary 600） | 原生 `button type="button"`（表单提交用 `type="submit"`） |
| hover | 按上表；无缩放/位移 | `pointer: coarse` 下不存在（不依赖 hover） |
| active | `scale-[0.98]` + 底色再深一档 | 键盘 Space/Enter 也能触发同一态；导航类按钮不用 scale |
| focus | 全局 2px 蓝环，offset 2 | 不得被 `focus:outline-none` 覆盖；图标按钮同样有环 |
| disabled | `opacity-50` + 无 hover/active | `disabled` 属性 + `aria-disabled`；不可 Tab 聚焦 |
| loading | 左侧 spinner `w-4 h-4 animate-spin`，label 保留 | 保持原宽度（`min-w`），防跳动；`aria-busy`；屏蔽重复点击；成功/失败后退出 |
| error | 按钮本身无 error 态 | 操作失败走 Toast/内联错误；破坏性操作由 ConfirmDialog 承担 |
| empty | — | 不适用 |

### 键盘 / 触屏 / ARIA

- Enter/Space 触发；`disabled` 时不触发；`type` 明确。
- 触屏命中区 ≥44×44：图标按钮 `p-2` 只有 36，需 `min-h-11 min-w-11` 或 `::before` 扩展。
- `aria-label` 在 iconOnly 时必填；loading 时 `aria-busy="true"`；危险按钮文案必须是动词（「删除」「退出登录」），不得只写「确定」。

### 禁止用法

- 同屏两个 primary；用 primary 表达「取消」；用 `<div onClick>` 冒充按钮；`active:scale-[0.95]`/`hover:scale`；把 `blue-*`/`purple-*` 写进按钮；用 `transition-all`。

### 替代旧实现

`PRIMARY_BUTTON` 12 份（`AccountScreen:87`、`AdminConsoleScreen:90`、`AbilityScreen:67`、`ReaderScreen:145`、`ShareCardDialog:44`、`PwaInstallButton:124`、`WelcomeScreen:43`、`ReviewScreen:106`、`PlacementScreen:69`、`QuizScreen:34`、`ExamScreen:85`、`CourseScreen:74`、`ModelSelectionModal:183`、`StartLearning:199` 等）→ 一个 Button；`SECONDARY_BUTTON` 10 份 → `variant=secondary`；`GHOST_BUTTON` 3 份 → `variant=ghost`；`PAGE_BUTTON` 自绘制 → `variant=secondary size=sm`。

### QA 检查

- [ ] 页面/屏幕内 primary 数量 ≤1（Dialog 页脚单独计算，但同一 Dialog 内 ≤1）。
- [ ] 所有 iconOnly 按钮有 `aria-label`。
- [ ] 无 `h-11`/`h-12` 主按钮（hero 的 `h-12` 允许）。
- [ ] 无 `focus:outline-none`；无 `active:scale-[0.95]`。

---

## C2 · Card / ListRow / IconTile

### 用途 / 何时用 / 何时不用

- **用途**：承载一组相关内容；ListRow 承载一条可点/可扫的条目；IconTile 是卡片/列表的图标容器。
- **用**：一级页卡片、内容货架、统计块、设置行、来源行。
- **不用**：页面级分区外壳（用 `section` + SectionHeader）；浮层（用 Dialog/WordCard）；表格（用 table）。

### Anatomy

```
Card: [IconTile] [title 17/600] [meta/badge 11] [description 14/400] [body] [footer actions]
Panel（页面级主面板）：同 Card，但 p 更大、圆角 rounded-panel、每页 ≤1 个
ListRow: [leading icon/thumb 40] [title 14/500 + subtitle 13] [meta 11] [trailing action 44]
```

### API

| 名称 | 类型 | 说明 |
|---|---|---|
| `variant` | `card \| panel \| interactive \| stat` | `interactive` 整卡可点；`panel` 仅页面主面板 |
| `padding` | `card(16/20) \| panel(16/24) \| row(12)` | 对应 T §4.1 |
| `onClick` / `href` | — | 二者只能有一个；整卡可点时必须有 focus ring 与语义 |
| `title` / `description` | ReactNode | 标题用 `text-section`；说明用 `text-caption text-fg-secondary` |
| `icon` / `iconTone` | LucideIcon / tone | IconTile 自动配色 |
| `loading` | boolean | 渲染 Skeleton，不改变卡片高度 |
| `footer` | ReactNode | 动作区；最多 1 primary + 1 secondary |

**IconTile**：`sm 36 / md 40 / lg 48`；圆角 `sm/md → rounded-control-lg`，`lg → rounded-card`；底色 `bg-{tone}/10 border border-{tone}/20 text-{tone}-fg`；无 tone 时 `bg-surface-2/60 text-fg-secondary`。同一屏同一角色的图标 tile 必须同尺寸。

### 状态矩阵

| 状态 | Card（静态） | Card（interactive） | ListRow |
|---|---|---|---|
| default | `bg-surface/40 border-line-subtle rounded-card` | 同左 | `p-3 rounded-control-lg bg-surface-2/30 border-line-subtle` |
| hover | 不变 | `border-line-strong` + `bg-surface/50`；**不缩放** | `bg-surface-2/60 border-line-strong`；不缩放 |
| active | — | `scale-[0.99]`（大卡片）；仅点击瞬间 | 不缩放；`bg-surface-2/70` |
| focus | 内部动作各自有焦点环 | 整卡可点时整卡显示 2px 环；内部动作不得再套一层 | 行可点时整行显示环；trailing 按钮 `stopPropagation` |
| disabled | — | `opacity-50 pointer-events-none aria-disabled` | 同左 |
| loading | Skeleton：标题 60% 宽、正文 2 行、圆角 `rounded-control` | 同左，保留卡片高度 | 3 行骨架，行高与真实行一致 |
| error | 卡内 ErrorPanel（`p-4`），不整卡替换 | 同左 | 行内文字 `text-danger-fg` + 重试图标按钮 |
| empty | 卡内 EmptyState `size=card` | 同左 | 不适用（空态在列表层） |

### 键盘 / 触屏 / ARIA

- 整卡可点：用 `<button>` 或 `<a>`，`aria-label` 取标题；内部有独立动作时，外层不得是 button（用 `div role=group` + 内部各自可点），或内部动作 `stopPropagation`。
- ListRow 可点：`role="button"` 或 `<a>`；Tab 只停在行本身，trailing 图标按钮单独 Tab（顺序：行 → trailing）。
- 触屏：行/卡片不依赖 hover 才显示操作（删除/星标常显或在 `pointer: coarse` 下常显）。

### 禁止用法

- 卡片套卡片（同色同圆角导致层级消失）；普通卡片用 `rounded-3xl`；同一行三个不同字号标题；卡片 hover 放大；用 `bg-zinc-900/30|/60|/95` 新值；用渐变边框/发光。

### 替代旧实现

12 个 `CARD` 常量（`VocabularyBookScreen:142`、`PlacementScreen:75`、`ReportScreen:73`、`WelcomeScreen:38`、`ExamScreen:91`、`AbilityScreen:65`、`TodayWorkbench:68`、`PracticeScreen:15`、`CourseScreen:78`、`LibrarySection:47`、`BooksSection:34`、`HomeRecommendations:21`、`ImportedBooksShelf:25`）+ 52 处内联卡片字面量 → Card/ListRow 两种；`CARD_ICON`（TodayWorkbench:69）→ IconTile；列表行 3 种底（C-11）→ ListRow。

### QA 检查

- [ ] 任一页面 `rounded-panel` 出现 ≤1 次（主面板）。
- [ ] 同一屏所有 card 圆角是 16px，不出现 16/24 混排。
- [ ] IconTile 宽度只出现 36/40/48。
- [ ] 可点卡片有 focus ring；内部按钮不冒泡触发整卡。

---

## C3 · Input / Textarea / SearchField

### 用途 / 何时用 / 何时不用

- **用途**：文本输入、链接/文章粘贴、搜索、表单字段。
- **用**：开始学习粘贴框、发现搜索、单词本搜索、账户改名、导入书 URL。
- **不用**：多选一（Segmented）、导航（Tabs）、纯展示（文本）。

### Anatomy

```
FieldShell: [leading icon 16] [input 14/400] [clear/spinner 16] [submit 按需]
标准表单：label 13/500 在上；error 13/400 danger-fg 在下；counter 11 右下
开始学习：FieldShell 变体 = 胶囊（rounded-full，p-1.5，h-12）
```

### API

| 名称 | 类型 | 说明 |
|---|---|---|
| `value` / `onChange` | string / (v) => void | 受控 |
| `label` | string | 可见或 `sr-only`；**placeholder 不得替代 label** |
| `placeholder` | string | 仅补充示例，不承载唯一说明 |
| `variant` | `default(search) \| hero \| textarea` | hero 用于开始学习；textarea 用于文章正文 |
| `size` | `sm(28/32) \| md(36) \| lg(40)` | 工具栏搜索用 sm；表单用 lg |
| `error` | string | 设置 `aria-invalid` + `aria-describedby`；边框 `border-danger/40` |
| `loading` | boolean | 右侧 spinner，输入仍可编辑（搜索）或禁用（提交） |
| `clearable` | boolean | 显示清除按钮（44 命中区）；Esc 清除 |
| `onSubmit` | `() => void` | Enter 提交（IME composing 时忽略） |
| `maxLength` / `inputMode` / `type` | — | URL/搜索/文本正确设置 |

### 状态矩阵

| 状态 | 视觉 | 行为 / 可检查点 |
|---|---|---|
| default | 壳 `bg-surface-2/60 border-line-subtle`；文字 `fg-primary`；placeholder `fg-secondary` | 字段本身透明、无边框 |
| hover | 壳 `border-line-strong` | 仅 fine pointer |
| active | 壳 `border-brand/60` + 无 ring（聚焦才出 ring） | 光标可见 |
| focus | **壳** `focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/15` | 字段 `outline-none` 仅在壳存在时允许；全局键盘环不被吃 |
| disabled | 壳/文字 `opacity-50`；`disabled` + `aria-disabled` | 不可编辑、不可 Tab |
| loading | 右侧 spinner；搜索不锁输入；提交锁输入 | `aria-busy`；loading 中 Enter 不重复提交 |
| error | 壳 `border-danger/40`；下方 error 文案 13 `danger-fg` | `aria-invalid="true"`、`aria-describedby` 指向错误；错误消失时同时清除属性 |
| empty | —（输入框本身没有 empty；搜索无结果由 C10 EmptyState 呈现） | 搜索为空时 CTA 禁用，不显示无结果 |

### 键盘 / 触屏 / ARIA

- 始终有 label（可见或 `sr-only`）；`autocomplete` 正确。
- Enter 提交；IME 中文/越南语组合期间不提交（检查 `event.nativeEvent.isComposing`）。
- Esc：清空搜索（有清除按钮时）；不关闭页面。
- 触屏：字号 ≥16px 会触发 iOS 缩放——输入文字用 `text-ui`(14) 但在 iOS 上需 `text-body`(16) 或 `font-size:16px`；**输入框在移动端使用 16px**（视觉可保持行高 24），避免自动放大。
- 搜索框 `role="searchbox"`（或 `input type=search`）+ `aria-label`；清除按钮 `aria-label`。

### 禁止用法

- 用 placeholder 当唯一标签；`placeholder-zinc-500/600`；`focus:outline-none` 后没有壳的 focus-within；把原生 `<select>` 当模式选择（I-17）；在输入框里写 `h-7` 作为移动端主输入（SentencesView 旧实现）。

### 替代旧实现

5 种搜索框高度（28/36/40，A1 §6.1）→ `SearchField size=sm|md`；`StartLearning` 的字段壳保留但令牌化；`SentenceView:154` 的 `h-7` 搜索 → sm（桌面）/ lg（移动）；`BookImportDialog:192` → `md`。

### QA 检查

- [ ] 每个输入都有 label 或 `aria-label`。
- [ ] focus 时可见环来自壳，不是字段的 `outline-none`。
- [ ] placeholder 颜色为 `fg-secondary`，不是 zinc-600。
- [ ] 移动端输入字号 ≥16px（防缩放）。
- [ ] IME 组合期间不提交。

---

## C4 · Dialog / ConfirmDialog / Sheet

### 用途 / 何时用 / 何时不用

- **用途**：模态任务、确认、表单、列表详情（频道视频）。
- **用**：语言设置、导入书、分享卡、模型/估价、频道列表、删除确认、PWA iOS 帮助。
- **不用**：非模态词卡（C13）、页面内展开（Accordion）、导航目的地（页面）。

### Anatomy

```
Portal → Overlay(bg-overlay backdrop-blur-md z-overlay)
  Panel(role=dialog aria-modal=true aria-labelledby z-dialog
        bg-surface/90 backdrop-blur-2xl border-line-strong rounded-card shadow-elev-3)
    Header: title 20/600 + subtitle 14/400 + CloseButton 44
    Body: p-6 (可滚动；max-h 由 dvh 计算)
    Footer: 次按钮左 / 主按钮右；移动端纵向全宽
```

### API

| 名称 | 类型 | 说明 |
|---|---|---|
| `open` / `onClose` | boolean / () => void | 受控；关闭后焦点回到触发元素 |
| `title` / `description` | string | 必填 title；`aria-labelledby` 指向它 |
| `size` | `sm(448) \| md(576) \| lg(896)` | 对应 T §4.3 |
| `initialFocus` | ref / selector | 默认：第一个可交互元素；危险确认默认「取消」 |
| `closeOnBackdrop` | boolean | 默认 true；破坏性确认也 true（=取消） |
| `closeOnEsc` | boolean | 默认 true；不可关闭的流程必须显式说明并给替代出口 |
| `destructive` | boolean | ConfirmDialog 用；主按钮 danger |
| `footer` | ReactNode | 最多 2 个动作 |
| `sheet` | boolean | `<md` 底部弹层：`rounded-t-panel`、`max-h-[90dvh]`、底部 safe-area |

### 行为契约（必须全部满足，逐条可测）

1. `createPortal` 到 `body`。
2. `role="dialog"` + `aria-modal="true"` + `aria-labelledby`（标题存在时）。
3. 打开时：锁 `document.body` 滚动（`overflow:hidden` + 记录 scrollTop）；焦点移到 `initialFocus`。
4. 焦点陷阱：Tab/Shift+Tab 在面板内循环；背景内容 `inert` 或 `aria-hidden`。
5. Esc 关闭；点击遮罩关闭（可配置）；关闭按钮 44×44。
6. 关闭后：焦点回到触发元素；恢复滚动；动画结束后卸载。
7. 不允许嵌套 Dialog；如内容需要二级确认，先关闭再打开一个新的 ConfirmDialog。

### 状态矩阵

| 状态 | 面板 | 行为 / 可检查点 |
|---|---|---|
| default（closed） | 不渲染任何 DOM | 触发元素 focus 正常 |
| open | overlay + panel 按配方；入场 `fadeIn 250ms` + `slideUp 300ms ease-apple` | 焦点在面板内；背景不可滚动 |
| hover | 仅按钮/行有 hover | 面板本身不响应 hover |
| active | 按钮 `scale(.98)`；遮罩无 | — |
| focus | 全局环；焦点陷阱 | Tab 不离开面板；Esc 关闭 |
| disabled | 页脚按钮 disabled 时 `opacity-50` | 表单未满足时主按钮 disabled，但错误提示可见 |
| loading | 面板内容保留标题，body 显示 Spinner/Skeleton；页脚主按钮 loading | 不可关闭（若操作不可中断）必须显示「处理中」；否则允许 Esc 但需确认 |
| error | body 顶部 ErrorPanel（可重试）；不关闭 Dialog | 错误文案可读；重试按钮聚焦 |
| empty | body 内 EmptyState `size=card` | 空列表也必须有动作/说明 |

### 键盘 / 触屏 / ARIA

- Esc 关闭；Tab 循环；Enter 触发当前聚焦按钮；焦点可见。
- 触屏：底部弹层按钮全宽、44 高；遮罩可点；不做「下滑关闭」手势（未定义，避免误触）。
- 读屏：打开时朗读标题；`aria-describedby` 指向描述；错误区域 `role="alert"`。
- ConfirmDialog：默认焦点「取消」；危险按钮文字必须是动词 + 对象（「删除这条记录」）。

### 禁止用法

- 13 个自制壳（A1 C-02）；无 `role`/`aria-modal`；无 Escape；无焦点陷阱；背景可滚；`z-[70]` 等任意层级；`max-h-[92vh]`；用 `window.confirm/alert`（I-05）；打开时 `autoFocus` 到危险按钮。

### 替代旧实现

`LanguageSettingsModal`、`BookImportDialog`、`ShareCardDialog`、`ModelSelectionModal`、`ChannelVideoList`、`AbilityScreen` 两处、`ExamScreen:1235`、`PlacementScreen:1402`、`AdminConsoleScreen:282`、`PwaInstallButton:70`、`EstimateDialog`、`App.tsx:3387`（ProcessingOverlay）、`App.tsx:3522`（guest overlay）→ 一个 Dialog；`window.confirm` 4 处 → ConfirmDialog。A1 I-02 的频道列表直接按 `size=lg` 迁移。

### QA 检查

- [ ] 13 个浮层全部有 `role="dialog"` + `aria-modal`。
- [ ] 每个 Dialog 可用 Esc 关闭（除显式不可中断流程）。
- [ ] 打开时 Tab 不能到背景；关闭后焦点回到触发按钮。
- [ ] 无 `window.confirm`。
- [ ] 遮罩只用 `bg-overlay backdrop-blur-md`。

---

## C5 · Tabs

### 用途 / 何时用 / 何时不用

- **用途**：在同级视图/筛选之间切换（互斥）。
- **用**：顶栏一级导航（nav 皮肤）、内容页免费库/管理台/单词本（panel 皮肤）。
- **不用**：模式/开关（Segmented）、页面跳转（Link）、超过 5 项且无分组（用菜单/分组）。

### 两种皮肤（只允许两种）

| 皮肤 | 视觉 | 用在哪 |
|---|---|---|
| `nav` | 文字 tab；选中 `text-fg-primary` + 2px `bg-brand` 下划线；容器无底 | 桌面一级导航（Sidebar 内为行，不用此皮肤；TopBarTabs 用） |
| `panel` | 容器 `rounded-control bg-surface-2/80 p-0.5 border-line-subtle`；选中白滑块 `bg-zinc-100 text-fg-inverse` + `layoutId` 弹簧 420/36；未选中 `text-fg-secondary` | 内容页、管理台、单词本、图书馆 |

- **统一裁决（C-05）**：`LibrarySection` 的白实底 → panel 白滑块；`VocabularyBook` 的淡 pill → panel 白滑块；`AdminConsole` 的白滑块保留并套上统一容器；`TopBarTabs` 保留下划线。**同一语义只有这两种外观。**

### API

| 名称 | 类型 | 说明 |
|---|---|---|
| `skin` | `nav \| panel` | 必填 |
| `items` | `{id,label,count?,disabled?,icon?}[]` | 文案由调用方 `t()` |
| `value` / `onChange` | string / (id) => void | 受控 |
| `layoutId` | string | 面板滑块动画 id，每个 tablist 唯一 |
| `overflow` | `scroll \| menu` | 移动端超过 4 项时用 `menu`；单词本用 `menu`（见 C14） |
| `ariaLabel` | string | tablist 的可访问名 |

### 状态矩阵

| 状态 | nav | panel |
|---|---|---|
| default | `text-fg-secondary`，无下划线 | 容器底；未选中项 `text-fg-secondary` |
| hover | `text-fg-primary bg-state-hover`；不位移 | `text-fg-primary`；不位移 |
| active | `bg-state-pressed`；无 scale | 白滑块跟随；无 scale |
| focus | 全局 2px 环 | 全局环；滑块在环下 |
| disabled | 不存在（4 个 tab 永远可用） | `opacity-40 cursor-not-allowed` + `aria-disabled` + `title` 说明（如 C2） |
| loading | — | 计数未加载时显示 `—` 或省略，不显示 0 |
| error | — | 计数失败不显示徽章；不把 tab 变红 |
| empty | — | — |

### 键盘 / 触屏 / ARIA

- `role="tablist"` + `role="tab"` + `aria-selected` + `aria-controls`（面板存在时）。
- 方向键在 tab 间移动（自动激活）；Home/End 到首尾；Tab 离开 tablist。
- 移动端 tab 高度 ≥44 命中；横向滚动容器必须可滚且选中项自动 `scrollIntoView({inline:'nearest'})`。
- 计数通过 `aria-label` 附加（如「单词 12 个」），不只靠视觉徽章。

### 禁止用法

- 4 种 tab 视觉并存（下划线/淡 pill/白实底/白滑块）；tab 里放主按钮；用 tab 做页面跳转；`role=tab` 无 `aria-selected`；横向溢出无提示。

### 替代旧实现

`TopBarTabs`（下划线，保留）、`VocabularyBookScreen:574`（淡 pill → panel）、`LibrarySection:317`（白实底 → panel）、`AdminConsoleScreen:932`（白滑块 → panel 统一容器）；`role="tabpanel"` 全仓 0 个 → 每个 tablist 必须有对应 panel。

### QA 检查

- [ ] 全站 tab 只出现两种皮肤。
- [ ] 每个 `role=tab` 有 `aria-selected`，每个 tablist 有 `aria-label`。
- [ ] 方向键可切换；选中项在视口内。
- [ ] 计数徽章 ≥11px（见 C7）。

---

## C6 · Segmented

### 用途 / 何时用 / 何时不用

- **用途**：在一组紧凑选项中选一个（模式/语言/季/登录注册）。
- **用**：译文模式、导入模式、语言设置、季选择、登录/注册、生词水平。
- **不用**：导航级切换（Tabs）、超过 4 项（Select/Menu）、需要搜索的长列表。

### Anatomy

```
容器：inline-flex items-center rounded-control bg-surface-2/80 p-0.5 border-line-subtle
选项：relative px-2.5 py-1 text-caption font-medium rounded-control
选中：motion.span layoutId 白滑块 bg-zinc-100 + 文字 fg-inverse；未选中 text-fg-secondary
```

### API

| 名称 | 类型 | 说明 |
|---|---|---|
| `options` | `{value,label,icon?}[]` | 2–4 项；超过 4 项改用 Tabs/Menu |
| `value` / `onChange` | string / (v) => void | 即选即生效（自动保存）；需要「保存」的表单不要用 |
| `ariaLabel` | string | radiogroup 名称 |
| `layoutId` | string | 同一屏多个 Segmented 必须不同 id |
| `size` | `sm(28) \| md(32)` | 工具栏用 sm；设置行用 md |

### 状态矩阵

| 状态 | 视觉 | 行为 / 可检查点 |
|---|---|---|
| default | 容器底；选中白滑块；未选中 `text-fg-secondary` | `role="radiogroup"`；选项 `role="radio" aria-checked` |
| hover | 未选中 `text-fg-primary`；不位移 | 触屏无 hover 依赖 |
| active | 选项 `bg-state-pressed`（滑块跟随） | 点击即切换；无 scale |
| focus | 全局环在选项上 | 方向键移动选择；Tab 进入/离开整组一次 |
| disabled | 整组 `opacity-50`；`aria-disabled` | 不可切换 |
| loading | 选项右侧 spinner（仅异步项）；组不锁 | 异步切换时保持旧值直到成功 |
| error | 组下方 13px `danger-fg` 文案 | `aria-describedby`；不把滑块变红 |
| empty | — | 不适用 |

### 键盘 / 触屏 / ARIA

- 左右/上下方向键移动并选中；Home/End；Space/Enter 选中。
- 触屏选项命中 ≥44×44（容器内可扩展）。
- 读屏朗读「组名，选项，已选中」。

### 禁止用法

- 用原生 `<select>` 做模式选择（I-17）；选中态用文字加粗；同一屏两个 `layoutId` 相同；容器/选项有 4 种度量（C-06）。

### 替代旧实现

8 处分段：`App.tsx:2675`、`ShowBrowser:148`、`AdminConsoleScreen:932`（改 Tabs）、`AuthScreen:118`、`SentenceView:113`、`ReaderScreen:752`、`ReaderScreen:1003`、`LanguageSettingsModal:40` → 一个 Segmented（Admin 的 tab 归 C5）。

### QA 检查

- [ ] 选项度量只有 `px-2.5 py-1 text-caption`（sm）/ `px-3 py-1.5`（md）。
- [ ] `role=radiogroup` + `aria-checked`。
- [ ] 同一屏 layoutId 唯一。
- [ ] 模式选择不再出现原生 select。

---

## C7 · Badge / CountBadge

### 用途 / 何时用 / 何时不用

- **用途**：短状态、来源、等级、计数。
- **用**：免费/来源标签、CEFR 等级、导航到期数、tab 计数。
- **不用**：可点击操作（用 Button）、长文案（用文本）、仅靠颜色表达状态（必须带文字/aria）。

### Anatomy / 变体

| 变体 | 配方 | 用途 |
|---|---|---|
| Badge | `text-micro font-medium px-2 py-0.5 rounded-full`；tone 底/边/字 | 来源、等级、状态 |
| CountBadge | `min-w-[18px] h-[18px] px-1 text-micro tabular-nums rounded-full` | 导航/tab 计数 |
| Dot | `w-1.5 h-1.5 rounded-full` + aria-label | 仅在线/离线等极简状态 |

Tone：`neutral`（`bg-surface-2/60 text-fg-strong border-line-subtle`）、`brand`（`bg-brand/10 text-brand-300 border-brand/20`）、`success`、`warning`、`danger`、`highlight`（**仅 AI 高亮**）。

### 状态矩阵

| 状态 | Badge | CountBadge |
|---|---|---|
| default | 静态；无 hover | 数字/`99+`；`aria-label` 带完整数字 |
| hover | 不适用（不可点）；可移除 Badge 的 × 用 icon button | 不适用 |
| active | — | — |
| focus | 可移除时 × 有环 | — |
| disabled | `opacity-40` + 说明 title | 计数 0 时**不渲染**（不是显示 0） |
| loading | 不显示占位 0；可显示 `—` | 不显示 |
| error | 计数失败不渲染 | 不渲染 |
| empty | — | `0` 不显示；`>99` → `99+` |

### 键盘 / 触屏 / ARIA

- 计数徽章必须 `aria-label`（如「复习到期 12 个」），不能只让读屏读「12」。
- 颜色不是唯一语义：状态 Badge 必须有文字；纯色点必须有 `aria-label`。
- 11px 是下限；不再使用 `text-[9px]/[10px]`。

### 禁止用法

- 4 套尺寸（A1 C-07）；9px 数字；中文 `uppercase`；用紫色/蓝色 Badge 表达非品牌/非 AI 语义；计数 0 显示红点。

### 替代旧实现

顶栏 `TopBarTabs:44`（16/9px）、侧栏 `Sidebar:183`（16/9px）、底栏 `BottomBar:45`（18/10px）、单词本 `VocabularyBookScreen:611`（18/10px）、来源标签 `LibrarySection:302` / `LearningHeader:56` / `AccountScreen:679`（C-13）→ Badge/CountBadge。

### QA 检查

- [ ] 徽章字号 ≥11px；无 9/10px。
- [ ] 所有 CountBadge 有 `aria-label`；0 不显示；>99 显示 99+。
- [ ] Badge 语义色只有 5 类 + highlight。

---

## C8 · Toast

### 用途 / 何时用 / 何时不用

- **用途**：操作结果反馈（保存、删除、失败、离线恢复）。
- **用**：非阻塞的短反馈；操作失败且没有页面级错误面板时。
- **不用**：字段校验（内联）、页面加载失败（ErrorPanel）、需要用户决策（ConfirmDialog）、可回看的长日志。

### Anatomy

```
底部堆叠（列）：[icon 20] [message 14/400 fg-strong，最多 3 行] [action? 14/500] [close 32]
容器：bg-surface/85 backdrop-blur-xl border-{tone}/30 rounded-card shadow-elev-2
```

### API

| 名称 | 类型 | 说明 |
|---|---|---|
| `type` | `info \| success \| warning \| error` | 决定 icon/边框/aria-live |
| `message` | string | 用户语言；错误须包含可行动信息（不只是后端 detail） |
| `duration` | number | info 4000 / success 3000 / error 8000（错误可手动关闭） |
| `action` | `{label,onClick}` | 可选「重试/撤销」；点击后关闭 |
| `dedupeKey` | string | 同 key 2s 内去重；默认 `type+message` |
| `maxVisible` | number | 3；超出丢最旧 |

### 状态矩阵

| 状态 | 视觉 | 行为 / 可检查点 |
|---|---|---|
| default | 按 type；`role="status"`（info/success） | 进入：`opacity 0→1` + `translateY 12→0`，spring 480/34 |
| hover | 背景不变；close 按钮高亮；**暂停计时** | 鼠标离开后恢复剩余时长 |
| active | close/action `scale(.98)` | 点击 action 关闭并执行 |
| focus | 环在 action/close；有焦点时暂停计时 | 键盘可达；Esc 关闭当前 toast |
| disabled | — | — |
| loading | 不允许 loading toast（用按钮内 loading） | — |
| error | `border-danger/30` + `danger-fg` icon；`role="alert" aria-live="assertive"` | 8s + 手动关闭；内容可读；不自动消失到无法回看 |
| empty | — | — |

### 位置与层级（I-10）

- 桌面：`fixed right-6 bottom-6 z-toast max-w-[28rem]`。
- 移动端：`left-4 right-4 bottom-safe-nav`，**必须高于底栏**（`56px + safe + 12px`），不得覆盖底栏 tab。
- 离线标记不得与 toast 同区：离线标记移到顶栏下方/右上（`z-nav`），或 toast 打开时让位。
- 最多 3 条；同 key 去重；不叠 5 条。

### 键盘 / 触屏 / ARIA

- `role=status`/`alert`；`aria-live`；不抢焦点（除非含 action 且用户主动）。
- 触屏：close ≥44 命中；toast 本身不滑动关闭（未定义手势）。
- 读屏：错误必须 assertive；成功 polite。

### 禁止用法

- 固定 6s 所有类型；无去重/无上限；`bottom-6` 落在底栏下；用 toast 承担字段错误；loading toast；长文案不截断导致溢出。

### 替代旧实现

`Toaster.tsx`（6s、无去重、`bottom-6`、`z-[100]`）→ 上述规则；散落的 `toast.success/info` 调用保留，但错误需带 action 或页面级替代。

### QA 检查

- [ ] 移动端 toast 不覆盖底栏（375/390/430 实测）。
- [ ] 错误 toast 8s 且有 close。
- [ ] 连续 5 个错误只显示 3 条且同 key 去重。
- [ ] 含 action 的 toast 键盘可达。

---

## C9 · Pagination

### 用途 / 何时用 / 何时不用

- **用途**：列表分页（页码条）。
- **用**：单词本、短语、最近学习、管理台用户列表。
- **不用**：步骤流程（用「上一步/下一步」，不叫分页）、无限滚动（未采用）、内容少于 1 页（不渲染）。

### Anatomy

```
[状态文案 13 fg-muted tabular-nums]        [‹] [1] [2] … [n] [›]
按钮：h-8 min-w-8 rounded-control text-caption；当前 bg-state-pressed text-fg-primary aria-current=page
```

### API

| 名称 | 类型 | 说明 |
|---|---|---|
| `page` / `pages` | number | 页码从 1 开始 |
| `hasMore` | boolean | 服务端 offset 分页时用于下一页禁用 |
| `onChange` | (page) => void | 只发合法页 |
| `summary` | string | 如「第 1 / 3 页」；由调用方 i18n |
| `scope` | string | test-id 前缀（vocab/phrase/admin） |

### 状态矩阵

| 状态 | 视觉 | 行为 / 可检查点 |
|---|---|---|
| default | 当前页 `bg-state-pressed`；其他 `text-fg-secondary` | 状态文案与页码一致 |
| hover | 非当前页 `bg-state-hover text-fg-primary` | — |
| active | `scale(.98)` | 点击后滚动到列表顶部（保持 header 可见） |
| focus | 全局环 | 键盘 Tab 到每个页码；Enter 切换 |
| disabled | 上一页在第 1 页、下一页在末页：`opacity-40 pointer-events-none` + `aria-disabled` | 不渲染可点的死按钮 |
| loading | 页码区保留，列表区 Skeleton；禁止重复点击 | 锁定分页直到响应 |
| error | 页码保留，列表区 ErrorPanel + 重试 | 不清空当前页 |
| empty | 总页数 0 时整块不渲染 | — |

### 键盘 / 触屏 / ARIA

- 页码按钮 `aria-label`（「第 2 页」）；当前页 `aria-current="page"`。
- 触屏：h-8 按钮命中区扩到 44；横向可滚。
- 移动端与状态文案同一行时允许换行（`flex-wrap`），不横向溢出。

### 禁止用法

- 4 套分页（I-18）；步骤按钮叫分页；页码直接显示 100 个；`hasMore` 与 `pages` 混用导致下一页逻辑不一致。

### 替代旧实现

`VocabPagination`（保留为基准）、`RecentLearning:560`（上一页/下一页 + 1/3）→ 统一页码条；`AdminConsoleScreen:1185` offset 分页 → 同一组件（服务端 `hasMore`）；`AbilityScreen:388` 步骤按钮 → 改名「上一步/下一步」，不属于 Pagination。

### QA 检查

- [ ] 所有列表分页形态一致（页码 + 状态文案）。
- [ ] 当前页 `aria-current=page`；禁用态不可点。
- [ ] 页码在 375px 下不横向溢出（可换行/滚动）。

---

## C10 · EmptyState / Loading / ErrorPanel / Skeleton

### 用途 / 何时用 / 何时不用

- **用途**：把「没有数据」「正在加载」「加载失败」分成三种明确状态。
- **用**：任何异步列表/卡片/页面。
- **不用**：把失败渲染成空态（I-01）；用空态表达「无权限」（用门禁卡/登录提示）；用 spinner 代替骨架（首屏列表）。

### Anatomy

```
EmptyState：icon 40 text-zinc-700 → title 14/500 fg-strong → hint 13/400 fg-secondary → action（≤1）
Loading：Spinner 14/16/24 或 Skeleton 行；可带 label 13 fg-secondary
ErrorPanel：icon danger-fg 20 → title 14/500 fg-strong → detail 13 fg-secondary → [重试] secondary；role=alert
Skeleton：rounded-control bg-white/5 animate-pulse；reduced-motion 下静态
```

### API

| 名称 | 类型 | 说明 |
|---|---|---|
| `EmptyState.size` | `page(48/16 py-16) \| card(40/12 py-10)` | 只允许两档 |
| `EmptyState.action` | `{label,onClick}` | L-10：每个空态给「最有价值的一次操作」；没有动作时必须有明确说明 |
| `Loading.kind` | `spinner \| skeleton` | 首屏列表用 skeleton；按钮/刷新用 spinner |
| `Loading.minHeight` | number | 预留高度，防布局跳动（默认 160） |
| `ErrorPanel.onRetry` | () => void | 可重试错误必填；不可重试时给替代动作 |
| `ErrorPanel.level` | `page \| card \| inline` | 页面级/卡内/行内 |

### 三态矩阵（组件本身的状态）

| 状态 | EmptyState | Loading | ErrorPanel |
|---|---|---|---|
| default | 成功但 0 条；有 icon/title/hint/action | 首次加载/刷新 | 请求失败 |
| hover | 仅 action 按钮 | — | 仅重试按钮 |
| active | action `scale(.98)` | — | 重试 `scale(.98)` |
| focus | action 有全局环 | — | 重试有环 |
| disabled | action 可 disabled（如未满足条件） | — | 重试 loading 时 disabled |
| loading | 不允许在 EmptyState 内再放 spinner | `aria-busy`；skeleton 数量 ≤3；不改变容器高度 | 重试中按钮 spinner + 区域保持 |
| error | **绝不**用 EmptyState 表示 error | 加载失败 → 切 ErrorPanel，不无限转圈 | `role=alert`；标题「加载失败」；detail 可读；重试 |
| empty | 自身即空态 | — | — |

### 判定规则（可检查）

- 状态源必须是显式枚举：`loading | error | empty | ready`；`items.length===0 && failed` → error。
- 页面级加载失败：不得只 `console.error`；必须有 ErrorPanel + 重试（I-01）。
- 首屏列表加载：skeleton 3 行；不是居中 spinner。
- 空态：`py-16`（page）/`py-10`（card）；不得再用 py-24/py-20/py-12/py-8。
- 虚线边框只用于「可放置区」（拖拽导入），不用于普通空态。
- 错误文案三层次（I-09）：字段级内联、操作级 toast、页面级 ErrorPanel；同一错误只出现一层。

### 键盘 / 触屏 / ARIA

- ErrorPanel `role="alert"`；Loading `role="status"`/`aria-busy`；Skeleton `aria-hidden`。
- EmptyState 的 action 是唯一 Tab 停靠点；图标 `aria-hidden`。
- 触屏 action ≥44。

### 禁止用法

- 失败当空（I-01）；6 种 padding；空态无动作（L-10）；加载无骨架导致跳动；错误只有 console；spinner 尺寸 7 档。

### 替代旧实现

`TodayScreen:100`、`ContentScreen:126/186` 失败当空 → ErrorPanel；`ChannelVideoList:81` loading 文本 → Skeleton；`ImportedBooksShelf:80` 骨架保留为基准；空态 8 处（I-08）→ 两档 EmptyState；`WordPopover` 错误内联（保留为 card 级）；`ReaderScreen:183` 错误面板保留为基准。

### QA 检查

- [ ] 断网刷新今日/内容页：显示「加载失败 + 重试」，不是「暂无记录」。
- [ ] 首屏列表是 skeleton，不是居中 spinner。
- [ ] 空态 padding 只有 py-16/py-10。
- [ ] 每个空态有 action 或明确说明。
- [ ] 错误不重复出现在 toast + 面板。

---

## C11 · NavShell（Sidebar / TopBar / BottomBar）

### 用途 / 何时用 / 何时不用

- **用途**：全局导航壳，承载一级导航、页面标题、全局入口。
- **用**：所有一级页与面板型子视图。
- **不用**：沉浸式任务页（学习、复习、考试、定位、课程）——隐藏侧栏/底栏，由子视图自己的 SubHeader 承担（N-17 的裁决：任务型隐藏；面板型保留壳 + 面包屑，见 `layout.md` §7）。

### Anatomy / 尺寸

| 区域 | 尺寸 | 内容 |
|---|---|---|
| Sidebar `≥lg` | 240 / 72（折叠） | 品牌 64、4 个一级 tab、快捷分组、底部账户/语言/设置 |
| TopBar `<md` | h-12 | logo + 当前页名（17）+ 语言 + 头像 |
| TopBar `md–lg` | h-16 | logo + 4 个文字 tab + 模型/语言/头像 |
| TopBar `≥lg` | h-16 | 页面标题 15/600 + 副标 11（面包屑）+ 右侧控件；**不再显示 4 tab** |
| BottomBar `<md` | h-14 + safe | 4 tab（icon 20 + label 11）+ 练习到期徽章 |

### API

| 名称 | 类型 | 说明 |
|---|---|---|
| `state.tab` / `state.sub` | NavState | 选中态来自路由，不由组件本地猜 |
| `tabs` | `{id,label,icon}[]` | 顺序固定（今日/内容/练习/我的；代码当前为内容/练习/今日/我的是 owner 决定，见 A1 §9） |
| `dueCount` | number | 仅练习 tab，0 不显示，>99 → `99+` |
| `wordbookCount` | number | 顶栏/侧栏入口，统一 `99+` |
| `onNavigate` | (tab) => void | 一级切换 replace（A3） |
| `subLabel` | string | 面包屑/当前子视图名，仅 ≥lg 顶栏 |

### 状态矩阵（一级 tab）

| 状态 | 视觉 | 行为 / 可检查点 |
|---|---|---|
| default | 未选中 `text-fg-secondary`/`text-fg-muted`；无底 | `aria-current` 不设置 |
| hover | `text-fg-primary bg-state-hover`；不缩放 | 触屏无 hover 依赖 |
| active | `bg-state-pressed`；**不 scale**（4 个 tab 同时抖动很吵） | 点击即切换 |
| focus | 全局环 | Tab 顺序：logo → 4 tab → 右侧控件 |
| disabled | 不存在（4 tab 永远可点） | 门禁在页面内提示，不给 tab 加锁 |
| loading | 计数未加载不显示徽章 | — |
| error | 计数失败不显示徽章 | 不改变 tab 可用性 |
| empty | 计数 0 不显示 | — |

### 键盘 / 触屏 / ARIA

- `<nav aria-label={t('nav.aria.primary')}>`；当前项 `aria-current="page"`。
- 底栏每项 ≥44×44（56 高）；图标 20；文字 11 单行 `whitespace-nowrap`；越南语不截断（≤8 字符）。
- 桌面侧栏折叠：`aria-expanded` + `title`/`aria-label`；折叠状态持久化；折叠后徽章用绝对定位，不挤压图标。
- 顶栏右侧 icon-only 控件必须有 `aria-label` + `title`。

### 禁止用法

- 同时显示侧栏 + 顶栏 4 tab（≥lg）；顶栏和页内各有一个页面标题（V-15）；`h-screen` 壳；底栏 hover 依赖；计数格式 4 套；把门禁锁在 tab 上。

### 替代旧实现

`Sidebar.tsx`、`TopBarTabs.tsx`、`BottomBar.tsx`、`AppShell.tsx`（保留结构，按本规范收敛尺寸/状态/徽章）；4 套徽章 → C7；顶栏标题 4 种尺度 → C12/§4。

### QA 检查

- [ ] 375px：底栏可见、4 项单行、最后一张卡不被遮挡。
- [ ] 1024px：侧栏 + 顶栏标题，无 4 tab。
- [ ] 每个页面只有一个可见页面标题。
- [ ] 所有 tab 有 `aria-current`；图标按钮有 `aria-label`。

---

## C12 · PageHeader / SubHeader / BackButton

### 用途 / 何时用 / 何时不用

- **用途**：表达「我在哪、这一页是什么、能做什么」；子视图的返回/关闭。
- **用**：一级页页头；所有子视图（复习/报告/考试/定位/阅读器/博客/单词本/课程/学习页）。
- **不用**：Dialog（用 Dialog header）、卡片标题（用 Card title）、区块标题（用 SectionHeader 17）。

### 三种头部（唯一）

| 组件 | 用在哪 | 结构 |
|---|---|---|
| `PageHeader` | 一级页**移动端** | h1 `text-page md:text-page-lg` + subtitle `text-ui fg-secondary` + actions（≤2） |
| `TopBar title` | 一级页**桌面** | 15/600 + 11 副标/面包屑（在 C11 顶栏内） |
| `SubHeader` | 子视图（含任务页） | h-12；BackButton（左）+ title 17/600 truncate + meta/badge 11 + trailing（≤3 个 44 控件） |

- **V-15 裁决**：一级页移动端标题 24（`text-page`），≥md 30（`text-page-lg`）；桌面端标题只在顶栏（15），页面内**不渲染** h1。子视图标题统一 17（`text-section`），不再出现 24/30 的大标题。
- **L-12 裁决**：SubHeader 固定 `h-12`；工具条/副标题下沉到内容区第二行；`flex-wrap` 禁止在头部出现。
- **L-09 裁决**：考试页头部只保留「返回 + 标题 + 关闭」；eyebrow/副标题/历史按钮移到内容区。

### API

| 名称 | 类型 | 说明 |
|---|---|---|
| `title` | string | 必填；`title` 属性同时用于 tooltip |
| `subtitle` | string | 仅 PageHeader；SubHeader 不用 |
| `meta` | ReactNode | 来源/等级徽章（≤1） |
| `actions` | ReactNode | PageHeader ≤2；SubHeader ≤3；超出的收进 More 菜单 |
| `onBack` | () => void | SubHeader 必填（返回上一层） |
| `onClose` | () => void | 只有 Dialog 用 CloseButton；子视图用 Back |
| `showBackLabel` | boolean | `≥sm` 显示「返回」文字；移动端只图标 |

### 状态矩阵

| 状态 | PageHeader | SubHeader / BackButton |
|---|---|---|
| default | 标题/说明按 token；动作按 C1 | 返回 `text-fg-secondary`；标题 `fg-primary`；背景 chrome |
| hover | 动作 hover 按 C1 | 返回 `bg-state-hover text-fg-primary`；无位移 |
| active | — | 返回 `scale(.98)`；标题无 |
| focus | 动作有环 | 返回有环；顺序：返回 → 标题（若可点）→ trailing |
| disabled | 动作可 disabled | 返回永不 disabled；无历史时仍回 tab（A3） |
| loading | 标题可保留；整页 loading 由 C10 | 标题/元信息可 Skeleton；返回仍可点 |
| error | 不改变头部；错误在内容区 | 不把头部变红 |
| empty | — | — |

### 键盘 / 触屏 / ARIA

- PageHeader 的 h1 是页面唯一 h1；桌面顶栏标题也应是 h1（不能两个 h1 同时可见）。
- BackButton：`button` + `aria-label={t('nav.back')}`；`≥sm` 显示文字；命中 ≥44；`-ml-2` 与内容左缘对齐。
- SubHeader 用 `<header>`；返回键是第一个 Tab 停靠点。
- CloseButton（Dialog）：`aria-label={t('common.close')}`，`p-2 rounded-full`，44 命中。

### 禁止用法

- 5 套返回（h-7/h-8/h-9、-ml-1/-2/-3）；子视图用 24px 大标题；头部 `flex-wrap` 成两行；同一视口两个 h1；Dialog 用返回箭头。

### 替代旧实现

`LearningHeader:42`（h-9 px-2）、`BookReaderScreen:438`（h-8 px-2.5）、`SentenceView:108`（h-7 px-2 -ml-1）、`ReviewScreen:363` / `ReportScreen:157` 的 X、`ExamScreen:1176`（text-xl sm:text-2xl + 多控件）、`AccountScreen:299`、`AdminConsoleScreen:879` → BackButton/SubHeader；`PageHeader` 统一 Today/Content/Practice/Profile 移动端标题。

### QA 检查

- [ ] 所有子视图头部高度 48px；无换行。
- [ ] 每个视口只有一个 h1。
- [ ] 返回控件只有一种尺寸/位置；命中 ≥44。
- [ ] 子视图标题 ≤17px；不再出现 24px 子视图标题。

---

## C13 · WordCard / WordHighlight

### 用途 / 何时用 / 何时不用

- **用途**：点词查词（浮层）；在字幕/文章中标注 AI 生词与中文注释。
- **用**：字幕、句子精背、阅读器、书籍、免费文章。
- **不用**：整页词典、单词本列表（用 C14）、非 AI 语义的高亮（用琥珀下划线）。

### WordCard Anatomy / 行为

```
Click-away layer（z-overlay）→ Card（w-80，z-popover，bg-surface/85，shadow-elev-2）
  [word 17/600] [ipa 13] [pos? 中性 Badge] [TTS] [收藏星] [close]
  [loading / error / 释义] [例句] [showAll]
```

- 定位：`left = clamp(12, x - w/2, innerWidth - w - 12)`；下方放不下则翻到上方（`bottom = innerHeight - y + 24`）；`maxHeight` 由可用空间计算；**必须夹取视口边界**（I-15）。
- 打开：点击词/触屏点词；焦点进入卡片；**不锁背景滚动**（非模态），但点击空白关闭。
- 关闭：Esc、点空白、关闭按钮；关闭后焦点回到触发的词。
- 切词：卡片打开时点另一个词直接切换（触屏一次命中），不先关闭。

### WordLookup API（替代 5 份 handler，C-03/I-12）

```ts
type WordLookupSource =
  | { kind: 'video' | 'local_show' | 'article' | 'library_article' | 'book' | 'imported_book';
      ref: string; title?: string }
  | { kind: 'sentence_pack'; ref: `L${1 | 2 | 3 | 4 | 5}`; title?: string };

createWordLookup(source: WordLookupSource): (word: string, context: string, point: {x:number;y:number}) => void;
```

- 所有入口必须传 `source`；句子包必须传 `L<levelId>`（当前丢失，I-12）；`source_ref` 为空时单词本显示「出处未知」且不可点击。
- 卡片错误：内联 `text-danger-fg` + 重试；不用 toast。

### 状态矩阵

| 状态 | WordCard | WordHighlight |
|---|---|---|
| default | 打开后 loading 态；宽 320；边框 line-strong | 普通词：无底色；AI 词：`bg-highlight/15` + 注释 `highlight-fg`；阅读标亮：琥珀下划线 |
| hover | 卡片不变；操作按钮 hover 按 C1 | fine pointer：`bg-state-hover`；不移动文字 |
| active | 按钮 `scale(.98)` | 点击后卡片打开；词背景短暂 `state-pressed` |
| focus | 焦点进入卡片；Esc 关闭；Tab 在卡内 | roving tabindex（见下）；焦点环在词上 |
| disabled | 词无释义时按钮 disabled | 不可点词（如译文/标点）无 hover、无 role |
| loading | 卡内 spinner 16 + 文案 14 `fg-secondary` | — |
| error | 卡内 `danger-fg` 文案 + 重试；保留词头 | — |
| empty | 无释义：显示「未找到释义」+ 可重试；不空白 | — |

### WordHighlight / ruby 规则（C-04/V-05）

- **只保留一套 ruby 渲染**：`<ruby>词<rt>中文</rt></ruby>`；`rt` 11px，颜色：AI 词 `highlight-fg`，普通词 `fg-secondary`；不得再出现 `text-purple-300/90` 与 `text-zinc-400/90` 两套。
- 可点范围由 `mode: 'word' | 'chunk'` 决定：字幕=word；句子精背=chunk（整块可点）；阅读=word + 琥珀下划线。视觉上用 `font-semibold` 或下划线区分，不改变字号。
- **键盘**：每句/每段是一个 `role="group"`；组内只有一个可点词 `tabindex=0`（roving），左右方向键移动，Enter 打开词卡。避免上千个词进入 Tab 序列。
- **触屏**：收藏星/操作常显（`pointer: coarse`）；不得依赖 hover 才可点（I-16）。
- 收藏：点击立即乐观变星（`warning-fg`）；失败回滚 + 错误 toast；游客点击打开登录浮层，不出现「点了没反应」（I-06）。
- 词性徽章：`bg-surface-2/80 text-fg-strong`，不用紫色。
- 文本选中：全局 brand/30；组件不得写 `selection:bg-purple-*`。

### 禁止用法

- 紫色用于非 AI 语义；两套 ruby；hover 才出现的星标；词卡超出右边缘；无 role 的浮层；把词卡做成模态（锁滚动）；在卡片里用 `z-[90]`。

### 替代旧实现

`WordPopover.tsx`（无 role、z-[90]、`w-80` 定位无边界已修但需统一）、`TranscriptBlock.tsx:51-105`（一套 ruby）、`SentenceText.tsx:27-36`（第二套 ruby）、`ReadingHighlight.tsx`（琥珀下划线保留）；`App.tsx:288-368` 5 个 handler → `createWordLookup`。

### QA 检查

- [ ] 全站 ruby 只有一套；AI 紫只出现在高亮路径。
- [ ] 词卡在 375px 右/下边缘不裁切。
- [ ] 触屏可点词、可收藏（无 hover 依赖）。
- [ ] 每句只有一个词进入 Tab 序列；方向键可移动。
- [ ] 句子包词条有来源且可回跳。

---

## C14 · VocabRow / VocabTabStrip

### 用途 / 何时用 / 何时不用

- **用途**：单词本的一条词/短语；单词本顶部的 tab 导航。
- **用**：`#/profile/vocabulary` 的我的单词、短语、CEFR/考试词表。
- **不用**：词卡浮层（C13）、字幕（C13）、通用列表（C2 ListRow 可复用外观，但单词行有专属列）。

### VocabRow Anatomy

```
桌面（≥lg，表格）：词 14/600 | CEFR/来源 Badge 11 | 释义 14（2 行截断） | 来源 13（可点/未知） | 时间 11 tabular | 操作 44
移动（<lg，卡片）：[词 17/600 + Badge] [释义 14] [来源 13] [时间 11] [展开/收藏/删除 44]
```

### VocabRow API

| 名称 | 类型 | 说明 |
|---|---|---|
| `word` / `phonetic` / `definition` | string | 词头、音标、释义 |
| `level` | CEFR/GRE/… | 渲染 Badge neutral/brand |
| `source` | `{label, onOpen?}` | 有 ref → 可点链接（13 `brand-300`）；无 ref → `fg-muted`「出处未知」，不可点（I-12） |
| `createdAt` | number | 11 tabular；相对时间 |
| `expanded` / `onToggle` | boolean | 展开例句/来源详情；行高变化不引起横向滚动 |
| `onRemove` / `onSpeak` | () => void | 删除需 ConfirmDialog；操作 44 |
| `layout` | `row \| table` | 由容器断点决定，组件不自己读 window |

### VocabTabStrip（L-07 裁决）

- **移动端**：固定 2 个 tab（我的 / 短语）+ 1 个「词表」入口（打开菜单，列出 CEFR A1–C1 + GRE/CET4/CET6；C2 disabled + 说明）。不再横向塞 8 个 tab。
- **桌面端**：显示完整 tab 条，可换行；仍用 panel 皮肤（C5）；计数 Badge。
- 切换后选中项 `scrollIntoView({inline:'nearest'})`；`role=tablist`；未加载计数不显示 0。
- tab 顺序固定：我的 → 短语 → 词表；不允许按最近使用重排。

### 状态矩阵

| 状态 | VocabRow | VocabTabStrip |
|---|---|---|
| default | 行 `bg-surface-2/30 border-line-subtle`；文字层级如上 | panel 容器；当前 tab 白滑块 |
| hover | `bg-surface-2/60 border-line-strong`；来源链接 `brand-300`；不缩放 | 未选中 `text-fg-primary` |
| active | 行 `scale` 无；操作按钮 `.98` | 滑块跟随 |
| focus | 行可展开时整行环；操作按钮各自环 | 全局环；方向键切换 |
| disabled | 删除/收藏中：`opacity-50` | C2 tab `opacity-40` + `aria-disabled` + title 说明 |
| loading | 行内 CEFR 徽章位置显示 `—`；不跳动 | 计数未加载省略 |
| error | 来源解析失败：来源列显示「出处未知」；行仍可操作 | 计数失败不显示徽章；tab 可用 |
| empty | 列表空 → C10 EmptyState（「去内容页存词」） | 没有「空 tab」；目录不可用时隐藏词表入口并说明 |

### 键盘 / 触屏 / ARIA

- 行可展开：`aria-expanded`；Enter/Space；展开后焦点留在触发按钮。
- 表格布局用真实 `<table>`/`<thead>`（桌面）；移动卡片不是表格。
- 删除按钮 `aria-label` 含词（「删除 abandon」）；收藏星 `aria-pressed`。
- 触屏操作常显；命中 ≥44；不依赖 hover。

### 禁止用法

- 8+ tab 横向滚动无提示；计数格式不一致（N-10：统一 `formatCount`，>99 → 99+）；9/10px 徽章；来源丢失仍显示可点；删除无确认；词表 C2 当普通禁用无说明。

### 替代旧实现

`VocabularyBookScreen.tsx:574-622`（8+ tab、淡 pill、`text-[13px]`）→ VocabTabStrip；`:607` 计数徽章 → C7；`:544` 来源未知 → 可点性规则；`:921/1258` 搜索 → C3；`:1394` 表格行 → VocabRow。

### QA 检查

- [ ] 移动端单词本首屏不出现横向溢出的 8 个 tab。
- [ ] 每个词条来源要么可点、要么明确「出处未知」。
- [ ] C2 禁用有说明；计数 `99+` 一致。
- [ ] 删除有 ConfirmDialog；操作命中 ≥44。

---

## C15 · CourseStepControls / Progress

### 用途 / 何时用 / 何时不用

- **用途**：课程/任务的分步控制与进度展示。
- **用**：`#/lesson/*` 课程、学习页进度、复习/考试进度。
- **不用**：列表分页（C9）、Tab 切换（C5）、一般数据可视化（用图表）。

### CourseStepControls Anatomy

```
底部动作条（sticky，含 safe-area）：
  [上一步 secondary]            [步骤 2/8 · 11 tabular]            [继续 primary]
  上方：Progress（h-1.5） + 反馈/错误行
```

### API

| 名称 | 类型 | 说明 |
|---|---|---|
| `step` / `total` | number | 文案「第 2 / 8 步」；`aria-valuenow` |
| `canNext` / `nextLabel` | boolean / string | 未满足条件时 disabled，但必须显示原因 |
| `onNext` / `onPrev` | () => void | 上一步在第一步隐藏（不是禁用） |
| `loading` | boolean | 主按钮 spinner，锁定双按钮 |
| `error` | string | 动作失败在动作条上方内联 `danger-fg` + 重试 |
| `sticky` | boolean | 移动端 sticky 在滚动容器内，不用 `fixed` |

### Progress API

| 名称 | 类型 | 说明 |
|---|---|---|
| `value` / `max` | number | `role="progressbar" aria-valuemin=0 aria-valuemax aria-valuenow` |
| `tone` | `brand \| success` | 进行中 brand；完成 success |
| `height` | `1.5px`（唯一） | 旧 1px/1.5px 混用收敛 |
| `label` | string | 读屏名称 |

### 状态矩阵

| 状态 | StepControls | Progress |
|---|---|---|
| default | 上一步 secondary（可隐藏）；继续 primary；步骤计数 11 tabular | 轨道 `bg-white/5`；填充 brand；高度 1.5 |
| hover | 按钮按 C1 | 无交互 |
| active | 按钮 `.98` | — |
| focus | 全局环；顺序：上一步 → 继续 | — |
| disabled | 未满足条件：`opacity-50` + `aria-disabled`；旁边显示「请先作答」13 fg-secondary | 值不合法时归 0，不显示负值 |
| loading | 主按钮 spinner + 保留标签；上一步锁定 | 若步进是异步，进度条保留当前值不预跳 |
| error | 动作条上方 `role=alert` 文案 + 重试；按钮恢复可点 | 不把进度条变红 |
| empty | 无步骤时显示 C10 ErrorPanel（数据异常），不显示 0/0 | total=0 时隐藏进度条 |

### 键盘 / 触屏 / ARIA

- Enter/Space 触发当前焦点按钮；课程答题可用数字键（1–4）但不作为唯一方式。
- `sticky bottom-0` + `pb-[calc(0.75rem+env(safe-area-inset-bottom))]`；键盘弹起时 `dvh` 收缩，动作条仍可见（不用 fixed）。
- 触屏按钮高 44；双按钮在 375px 下不换行（上一步可缩为图标 + aria-label）。
- 读屏：步骤变化 `aria-live="polite"`；进度条有 label。

### 禁止用法

- 渐变进度条；1px 轨道；两种进度配色表达同一语义；固定底栏与键盘重叠；步骤按钮叫「分页」；loading 时仍可重复提交。

### 替代旧实现

`CourseScreen.tsx` 的步骤按钮/倒计时（保留逻辑，套本组件）、`TodayWorkbench` 进度条、`ContentScreen:298` 无 role 的进度条、`SentenceView:165` 渐变进度 → Progress（单色 + a11y）；`ReviewScreen` 统计块 → StatTile（C2）。

### QA 检查

- [ ] 进度条都有 `role=progressbar` 与 `aria-valuenow`。
- [ ] 进度填充只有 brand/success 两色，无渐变。
- [ ] 动作条在 375px + 键盘弹起时不被遮住。
- [ ] 未满足条件时按钮 disabled 且有原因文案。

---

## 18. 共享基础函数（非视觉，但必须单一来源）

| 函数 | 目标路径 | 契约 | 替代的重复 |
|---|---|---|---|
| `cn(...)` | `lib/cn.ts` | clsx + tailwind-merge；所有组件用它合并类名 | `TranscriptBlock.tsx:11`（C-09） |
| `bilingualReadingWidth()` | `lib/reading-layout.ts` | 返回双语栏宽/断点策略；4 个 reader 共用 | `BilingualRow.tsx:16`（C-09） |
| `formatClock(seconds)` | `lib/time.ts` | `mm:ss`；`≥1h` → `h:mm:ss`；`NaN/负` → `00:00` | 7 份复制（C-08） |
| `formatCountdown(seconds)` | `lib/time.ts` | 与 formatClock 同规则，供倒计时 | Course/Placement（C-08） |
| `formatCount(n)` | `lib/format.ts` | `>99 → 99+`；`0 → '0'`（是否显示由组件决定） | 4 处入口（N-10） |
| `resolveFavoriteSource(fav)` | `lib/vocabulary.ts` | 返回 `{kind, ref, title, canOpen}`；无 ref → canOpen=false | 单词本来源（I-12） |
| `describeApiError(res)` | `lib/toast.ts` | 用户可读错误（已存在），toast 使用 | 错误文案（I-09） |

- 组件只 import `lib/`，不得从另一个业务组件反向 import（C-09 的依赖反转）。
- 新代码禁止再复制上述函数；A4 迁移时逐项删除旧副本。

---

## 19. 与 A3/A4/A5 的边界

- **A2（本文件）**：组件的语义、anatomy、状态、a11y、禁止项、替代关系。
- **A3**：导航返回/焦点回填/滚动位置恢复、toast 与路由的交互（如非法路由提示）；本文件只定义组件行为，不定义 history 栈。
- **A4**：按 §1.4 清单实现组件并替换旧实现；完整旧→新文件映射表由 A4 产出。推荐顺序：C10/C4/C1（底座）→ C2/C3/C5/C6/C7（高频）→ C11/C12（壳）→ C13/C14/C15（领域组件）。
- **A5**：把每节 QA 检查转成 PR 勾选/正则脚本；组件状态矩阵中可 grep 的规则（字号、圆角、z、颜色、焦点）直接进 `check-design-tokens.mjs`。

---

*上游：`tokens.md`、A1 §3/§6、IA §5/§6。下游：A4 `component-consolidation.md`、A5 `design-gate.md` / `design-qa-checklist.md`。*
