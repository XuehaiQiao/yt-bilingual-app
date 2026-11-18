# A1 审计回应（A2 域：V 视觉 / C 组件 / L 布局）v1.0

> 作者：A2 · 设计系统架构师 ｜ 日期：2026-11-19 ｜ 阶段：1（门禁 1）
> 输入：`docs/design-governance/audit-report.md`（A1）§2.3、§3、§6、§7、附录 A。
> 输出：`tokens.md`、`components.md`、`layout.md`。本表逐条覆盖 A1 中 **V（22 条）/ C（16 条）/ L（14 条）共 52 条**，不漏 ID。
> 状态口径：**覆盖**=规范给出了可执行规则；**部分**=规则已给，但落地依赖 A3/A4/A5 或不属于设计系统域；**暂不**=本轮明确不做（本表无）。

---

## 0. 覆盖统计

| 类别 | P0 | P1 | P2 | 小计 | 覆盖 | 部分 | 暂不 |
|---|---:|---:|---:|---:|---:|---:|---:|
| V 视觉 | 1 | 11 | 10 | **22** | 20 | 2 | 0 |
| C 组件 | 0 | 9 | 7 | **16** | 13 | 3 | 0 |
| L 布局 | 1 | 6 | 7 | **14** | 12 | 2 | 0 |
| **合计** | **2** | **26** | **24** | **52** | **45** | **7** | **0** |

- **P0/P1 未覆盖项：仅 V-06（部分）**——24 条英文文案的补齐与 CI 规则不属于视觉令牌/组件/布局，需 A5 门禁 + A4 文案迁移；本规范给出结构预防（组件不硬编码文案、11px 下限、中文最小字号）与检查项。
- 其余 6 个「部分」均为 P2：V-22、C-10、C-14、C-16、L-08、L-14。
- I（交互）/ N（导航）不在 A2 域，由 A3 回应；但 A2 的组件/布局规则已被 A3 引用（Dialog 焦点、Toast 位置、返回头、单滚动）。

---

## 1. 视觉（V）

| ID | 级别 | 规范条目（文件 + 章节/锚点） | 状态 | 理由 / 备注 |
|---|---|---|---|---|
| V-01 | P2 | `tokens.md` §2.1（`app`）、§2.5 #14、§13 T-13 | 覆盖 | `bg-[#09090b]` 35 处 → `bg-app`；`index.css --app-bg`、`index.html theme-color`、manifest 三处一致性列入 T-13 |
| V-02 | P1 | `tokens.md` §3.2 字号阶梯；§13 T-05/T-06 | 覆盖 | 9/10/11→micro 11；12/13→caption 13；14→ui；15/16 保持；17→section；19→dialog；新增的只有语义名，不新增字号 |
| V-03 | P1 | `tokens.md` §2.3（Q-01/Q-02 裁决）、§2.5 #19 | 覆盖 | `zinc-600` 字面量归零：信息类升 `fg-secondary`（7.76:1），装饰/禁用用 `fg-muted`/`fg-disabled`；空态提示不再是 zinc-600 |
| V-04 | P1 | `tokens.md` §2.2 品牌映射、§2.5 #20；`components.md` C1/C7 | 覆盖 | `blue-*` 473 处按 7 行映射到 `brand-*`；`brand-600` 只作填充；A5 用 T-04 正则拦截新 `blue-*` |
| V-05 | P1 | `tokens.md` §2.2 保留色、§2.5 #21/#47；`components.md` C13 | 覆盖 | 紫色只保留 AI 高亮；选中改 `brand/30`（全局 `::selection`）；词性徽章改中性；注释色 `highlight-fg` 唯一 |
| **V-06** | **P0** | `components.md` §1.1（组件不硬编码文案）、§1.3（11px 中文下限）；`tokens.md` §3.2；A5 待办 | **部分** | 设计系统只能给结构预防；24 个 `zh-CN` 英文键的补齐、`check-i18n.mjs` 的「zh 必须含 CJK」规则属文案/门禁，不在 A2 域。**未覆盖部分明确交 A5（规则）+ A4（文案）** |
| V-07 | P1 | `tokens.md` §2.2 保留色迁移、§2.5 #22 | 覆盖 | violet/sky/pink 全部收敛：紫只 AI，sky/pink 删除，轴改「灰轨 + brand 当前档」；`.glass-*` 只留欢迎页 |
| V-08 | P2 | `tokens.md` §2.2；`components.md` C15 Progress | 覆盖 | 进度只允许 `brand`（进行）与 `success`（完成）两色；禁止渐变；高度 1.5px |
| V-09 | P1 | `tokens.md` §5 圆角硬映射；`components.md` C1/C2 | 覆盖 | h-8/h-9 只允许 8px/full；h-10 用 12px；卡片 16px；页面主面板 24px；禁止 `rounded-2xl sm:rounded-3xl` |
| V-10 | P1 | `tokens.md` §2.4 六种材质；§2.5 #3–#10 | 覆盖 | 5 种遮罩/面板透明度 → 6 个整选配方；blur 只允许 md/xl/2xl 且与材质绑定；对话框 /90、浮层 /85、chrome /60 |
| V-11 | P1 | `tokens.md` §10.3、§2.5 #44/#45；`layout.md` §2.3/§8.1 | 覆盖 | 只允许 `dvh`；删除 `h-screen` 双写/`min-h-screen`/`92vh`；`viewport-fit=cover` 已存在（勘误） |
| V-12 | P1 | `tokens.md` §6；`components.md` C2/C4/C8 | 覆盖 | 只保留 elev-1/2/3；`shadow-2xl`/`shadow-black`/`shadow-[...]` 全部映射；卡片不用阴影 |
| V-13 | P1 | `tokens.md` §7；`components.md` C4/C8/C11 | 覆盖 | 12 档 56 处 → 7 层（base/raised/chrome/nav/overlay/dialog/popover/toast）；同层不再并列；PWA 模态归 dialog |
| V-14 | P1 | `tokens.md` §10.1；`components.md` C1/C3/C12 | 覆盖 | 删除组件级 focus ring/outline-none；只保留全局 `:focus-visible` + 输入壳 `focus-within`；修复全局 `border-radius:8px` 副作用 |
| V-15 | P2 | `tokens.md` §3.2；`layout.md` §2.5/§4.1；`components.md` C12 | 覆盖 | 一级页标题移动端 24/30、桌面顶栏 15；子视图 17；同一视口一个 h1；白只有 `fg-primary` 一种（zinc-50→zinc-100） |
| V-16 | P2 | `tokens.md` §4.3；`layout.md` §3.1 | 覆盖 | 四个一级页外层统一 `max-w-page` 1440 + 同 padding；内部 measure 左对齐；不再出现 1440/1152 的容器差 |
| V-17 | P2 | `tokens.md` §4.1；`layout.md` §3.3 | 覆盖 | 一级页 `px-4 sm:px-6 lg:px-8 pt-5 sm:pt-8`；子视图 py 4/6；4 套内边距收敛 |
| V-18 | P2 | `components.md` C2 IconTile | 覆盖 | IconTile 只允许 36/40/48 三档，圆角/语义色绑定；5 种尺寸收敛 |
| V-19 | P2 | `tokens.md` §4.1 间距阶梯 | 覆盖 | 4px 基准 + 语义角色（页/区块/卡片/行/内联）；2/6/10 只用于对齐；三种卡片间距收敛 |
| V-20 | P2 | `tokens.md` §9；`components.md` C1/C2 | 覆盖 | 只保留 0.98（控件）/0.99（大卡片）；删除 0.95 与 hover 缩放；导航不缩放 |
| V-21 | P2 | `tokens.md` §9；`components.md` C1/§18 | 覆盖 | 200ms 默认、仅位移/缩放用 ease-apple；禁止裸 transition/transition-all；`MotionConfig reducedMotion="user"` 全局兜底 |
| V-22 | P2 | `components.md` §18 共享基础函数；§1.1 依赖方向 | **部分** | `cn` / `bilingualReadingWidth` 的目标路径与契约已定；实际移动与删除旧定义属 A4 代码迁移（P2） |

---

## 2. 组件（C）

| ID | 级别 | 规范条目（文件 + 章节/锚点） | 状态 | 理由 / 备注 |
|---|---|---|---|---|
| C-01 | P1 | `components.md` C1 Button、C2 Card/ListRow | 覆盖 | 4 类按钮 × 12 份常量 + 52 处内联卡片 → Button/Card 两类；主/次/幽灵/着色/图标/危险全部有状态矩阵 |
| C-02 | P1 | `components.md` C4 Dialog/Confirm/Sheet | 覆盖 | 13 个弹窗壳 → 1 个 Dialog；强制 role/aria-modal/焦点陷阱/Escape/遮罩/滚动锁/焦点回填；ConfirmDialog 取代原生 confirm |
| C-03 | P1 | `components.md` C13 `createWordLookup` + `WordLookupSource` | 覆盖 | 5 个 handler 复制 → 一个工厂；句子包必须传 `L<levelId>`；`source_ref` 为空时单词本不可点，修 I-12 的数据缺陷 |
| C-04 | P1 | `components.md` C13 WordHighlight/ruby | 覆盖 | 只保留一套 ruby；`rt` 11px；AI 紫 vs 中性灰；word/chunk 由参数控制；字幕/句子包/阅读器共用 |
| C-05 | P1 | `components.md` C5 Tabs | 覆盖 | 4 套 tab 视觉 → 两种皮肤（导航下划线、内容白滑块）；Library/Vocab/Admin 收敛；`role=tabpanel` 必须存在 |
| C-06 | P1 | `components.md` C6 Segmented | 覆盖 | 8 处分段 → 一个组件；唯一容器/选项度量；`layoutId` 弹簧 420/36；模式选择改 Segmented（I-17） |
| C-07 | P1 | `components.md` C7 Badge/CountBadge | 覆盖 | 4 套徽章 → Badge + CountBadge；最小 11px；0 不显示；>99 → 99+；aria-label 带完整数字 |
| C-08 | P1 | `components.md` §18 共享函数 | 覆盖 | `formatClock/formatCountdown` 唯一实现（`lib/time.ts`）；`>1h` 输出 `h:mm:ss`；9 份复制删除 |
| C-09 | P1 | `components.md` §18；C2/C13 | 覆盖 | `cn` → `lib/cn.ts`；`bilingualReadingWidth` → `lib/reading-layout.ts`；组件不得反向 import 业务组件 |
| C-10 | P2 | `components.md` §1.1 组件边界 | **部分** | 规范声明 `InputScreen` 为废弃、不得再引用；删除 598 行死代码属 A4 第一步（P2，零风险） |
| C-11 | P2 | `components.md` C2 ListRow | 覆盖 | 3 种列表行底/2 种 padding → 一个 ListRow（`p-3 rounded-control-lg bg-surface-2/30 hover:/60`） |
| C-12 | P2 | `components.md` C15 Progress | 覆盖 | 两套进度条 → Progress（1.5px、单色、role/aria 三件套）；1px/渐变/无 role 全部收敛 |
| C-13 | P2 | `components.md` C7 Badge | 覆盖 | 来源/免费/等级 3 种标签 → Badge 五语义色；删除逐处写色与中文 uppercase |
| C-14 | P2 | `components.md` C4（分享用 Dialog）+ C13 | **部分** | 分享卡与选区浮层统一到 Dialog/WordHighlight 的外观与按钮语义；Canvas 生成/降级逻辑是否合并需 A4 评估（不阻塞） |
| C-15 | P2 | `components.md` C1 destructive + C2 ListRow 操作 | 覆盖 | 删除类操作统一「hover/focus 变红 + ConfirmDialog + 命中 ≥32/44」；`window.confirm` 由 C4 取代 |
| C-16 | P2 | `components.md` §1.1/§19 组件边界与拆分顺序 | **部分** | 组件职责过载（7 个 >1000 行）是代码结构问题；A2 只规定拆分边界与顺序，实际拆分归 A4（P2） |

---

## 3. 布局（L）

| ID | 级别 | 规范条目（文件 + 章节/锚点） | 状态 | 理由 / 备注 |
|---|---|---|---|---|
| **L-01** | **P0** | `layout.md` §6.3 学习页移动单滚动（9 条硬规则 + 真机验收） | 覆盖 | 删除 `52vh`/内层 `overflow-y-auto`/`pb-[45vh]`；整页一个滚动容器；视频不 sticky；桌面双栏保留；375/390/430 + iOS 地址栏验收 |
| L-02 | P1 | `layout.md` §4.2 SectionHeader、§5.2 内容页两层结构 | 覆盖 | 主操作面板（1 个 `rounded-panel`）+ 货架区（17px SectionHeader，不加外卡）；9 区块顺序固定；首屏预算明确 |
| L-03 | P1 | `layout.md` §1.2、§5.2、§9.3 | 覆盖 | 1024–1279 用「rail 置顶横排」（A1 方案二），≥1280 两栏；主列不低 420；消除半桌面高度翻倍 |
| L-04 | P1 | `layout.md` §5.1 | 覆盖 | 输入槽固定页头（hero/compact 只换形态不换位置）；删除页尾副本；顶栏「开始学习」跳今日并聚焦；无历史/有历史都不出现两个输入 |
| L-05 | P1 | `layout.md` §5.4 | 覆盖 | 账户头 + 余额；学习数据/偏好/关于账户三组；退出在组尾、删除账号最后 + 确认；组标题 17 |
| L-06 | P1 | `layout.md` §5.3 | 覆盖 | 三卡 `md:grid-cols-3` 等宽同构；定位卡不再 `col-span-2`/换向；动作统一底部 |
| L-07 | P1 | `layout.md` §5.5；`components.md` C14 VocabTabStrip | 覆盖 | 移动端 2 固定 tab + 词表菜单（不再 8+ 横滚）；桌面完整 tab 可换行；选中项 scrollIntoView；计数 99+ |
| L-08 | P2 | `layout.md` §5.4、§5.1；`components.md` C7 | **部分** | 规定「一个 LevelSummary 数据源；今日仅在无画像时显示；练习/我的只做入口」；`LevelSummary` 组件本身需 A4 抽取（P2） |
| L-09 | P2 | `layout.md` §6.1/§6.2；`components.md` C12 | 覆盖 | 考试头只留返回/标题/关闭；eyebrow/副标题/历史/进度下沉；窄屏不换行；SubHeader 固定 48 |
| L-10 | P2 | `layout.md` §7.3 空态动作表 | 覆盖 | 每个空态一个「最有价值动作」；发现给 3 示例主题、博客给 RSS、单词本去内容页；空态不得只有一句说明 |
| L-11 | P2 | `layout.md` §1.2；`tokens.md` §8 | 覆盖 | 三档 + 1280 只加宽；结构只在 md/lg/xl 变化；禁 `max-md:` 补丁；sm 只做字号/间距 |
| L-12 | P2 | `layout.md` §2.5/§6.1；`components.md` C12 | 覆盖 | SubHeader 固定 48；头部不换行；工具条下沉第二行；子视图标题 17；消除 44–56 的高度漂移 |
| L-13 | P2 | `layout.md` §8.1/§8.2；`tokens.md` §10.3 | 覆盖 | `[data-page-scroll]` 统一 `scroll-padding-bottom`（56+safe+16）；锚点 `scroll-margin`；输入聚焦不被底栏遮住 |
| L-14 | P2 | `layout.md` §7.4 | **部分** | ErrorPanel + 重试布局已定；`visibilitychange`/`online` 静默刷新属交互实现，交 A3/A4；不阻塞门禁 1 |

---

## 4. 未覆盖 / 后续动作

### 4.1 P0/P1 未覆盖（1 条）

| ID | 缺什么 | 交给谁 | 验收 |
|---|---|---|---|
| V-06 | 24 个 `zh-CN` 英文键的实际翻译；`check-i18n.mjs` 的「zh 值必须含 CJK（白名单除外）」规则 | A5 门禁 + A4 文案 | `check:i18n` 新增规则通过；主链路（处理遮罩/估价/剧集/删除）无英文；A5 QA 勾选 |

### 4.2 P2 部分覆盖（5 条，不阻塞门禁 1）

| ID | 缺什么 | 交给谁 |
|---|---|---|
| V-22 | `cn` / `bilingualReadingWidth` 实际移动到 `lib/` | A4 |
| C-10 | 删除 `InputScreen.tsx`（598 行死代码） | A4（第一步） |
| C-14 | 分享卡生成/降级逻辑是否与选区浮层合并的评估 | A4 |
| C-16 | 7 个 >1000 行组件的拆分（按 C1/C2/C4/C10 边界） | A4（P2） |
| L-08 | 抽 `LevelSummary` 组件、统一 5 处展示的数据源 | A4 |
| L-14 | `visibilitychange`/`online` 静默刷新 | A3/A4 |

> 注：上表 6 行 P2（V-22、C-10、C-14、C-16、L-08、L-14）+ §4.1 的 P0（V-06）= 7 个「部分」。分类：V 部分 2（V-06/V-22）、C 部分 3（C-10/C-14/C-16）、L 部分 2（L-08/L-14）。

### 4.3 与 A1 建议不同、需 lead 知情的 3 个裁决

1. **L-03**：未把两栏提前到 `lg`（1024）；改为 `1024–1279` rail 横排、`≥1280` 两栏。理由：240 侧栏 + 320 rail + 32 gap 会把主列压到 ~368px，低于可读下限；A1 也提供了这个备选方案。
2. **L-11**：结构档位采用 `<768 / 768–1023 / ≥1024`（+1280 加宽），而不是 A1 的 `<768 / 768–1279 / ≥1280`。理由：现有壳的侧栏断点是 `lg`；把桌面边界改到 1024 是**最小改动**，且 1280 继续承担内容加宽。语义上仍满足「三档 + 两个断点」。
3. **V-15**：桌面一级页不再渲染页内大标题（标题在顶栏），移动端保留 24/30；子视图标题统一 17。这比 A1 的「一级页统一一个 PageTitle」更严格，但解决了「同一视口两个标题」和切换 tab 时的标题跳档。

---

## 5. 自检：ID 覆盖清单

- **V**：V-01 ✅ V-02 ✅ V-03 ✅ V-04 ✅ V-05 ✅ V-06 ✅ V-07 ✅ V-08 ✅ V-09 ✅ V-10 ✅ V-11 ✅ V-12 ✅ V-13 ✅ V-14 ✅ V-15 ✅ V-16 ✅ V-17 ✅ V-18 ✅ V-19 ✅ V-20 ✅ V-21 ✅ V-22 ✅（22/22）
- **C**：C-01 ✅ C-02 ✅ C-03 ✅ C-04 ✅ C-05 ✅ C-06 ✅ C-07 ✅ C-08 ✅ C-09 ✅ C-10 ✅ C-11 ✅ C-12 ✅ C-13 ✅ C-14 ✅ C-15 ✅ C-16 ✅（16/16）
- **L**：L-01 ✅ L-02 ✅ L-03 ✅ L-04 ✅ L-05 ✅ L-06 ✅ L-07 ✅ L-08 ✅ L-09 ✅ L-10 ✅ L-11 ✅ L-12 ✅ L-13 ✅ L-14 ✅（14/14）

**合计 52/52 条有规范落点；P0/P1 共 28 条中 1 条部分（V-06），无「暂不处理」。**

---

*上游：A1 `audit-report.md`；下游：A5 `design-gate.md` / `design-qa-checklist.md`、A4 `component-consolidation.md`、lead `remediation-plan.md`。*
