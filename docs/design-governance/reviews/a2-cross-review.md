# A2 交叉审阅（阶段 4）

> 只读评审，未改代码；核全部规范、62 组件与 App。

## 结论

覆盖：实例 **96.6%（估）** 达标；文件 **50/62=80.6%** 刚过线；屏级全映射 **18/27=67%** 不达标。A3/A2 交界与双方内部共 7 处冲突；A4 的 6 个缺口 3 条前提失真、2 条回写不全；A5 QA 名义 51/51，但 5 条验收值与 A2/A3/A4 冲突；现有门禁挡不住完整「新增裸色/第二份组件」。A1 7 条 P0 有落点。

## 一、覆盖率（可复核）

- **实例**：grep 计数，按钮 362、输入 25、浮层/词卡 22、tab/seg 16、badge 8、toast 1、分页 4、三态 27、壳 4、页头 25、词表 2、进度 12、卡片/行/图标/节标题 88，约 596；未归属 20（菜单 2、switch 2、table 2、chip 7、axis 1、banner 2、canvas 1、分栏 1、公开页 2）→ **576/596=96.6%**。
- **文件**：62 个组件文件（含死代码 `InputScreen`）+ `App.tsx` = 63；剔除死代码后 62；含未归属件 12 个（`ModelBar/Review/Account/Admin/Auth/Welcome/VocabAxis/VocabularyBook/ReadingHighlight/ShareCardDialog/OfflineIndicator/App`），余 50 全映射 → **50/62=80.6%**。
- **屏**：27 条 canonical 路由中 9 条、7 类屏含未归属件（welcome/login/learning/review/vocabulary/admin/profile）→ **18/27=67%**。

结论：「≥80%」在实例口径成立，文件口径刚过线，屏级口径不成立；补缺可达 95%+。

## 二、A3 × A2 冲突

1. **Toast**：A2 C8 有 `warning`、info 4s、去重 2s、超限丢最旧；A3 IX-08 三型、info 5s、去重 5s、排队；A4 C8 采 A3 却称无冲突。
2. **EmptyState**：A3 IX-04 卡片/右栏 `py-3`；A2 C10 `size=card` 为 `py-10`；A4 取 py-10。
3. **BackButton/X**：A2 layout §6.1 任务页留「返回+标题+关闭」、子视图头右可带关闭；A3 D-04/§5.4 规定 X 只给覆盖层；A2 C12 自身也写子视图只用 Back。A4 删 `onClose` 未登记。
4. **Dialog**：A2 C4 禁嵌套、二级确认「先关再开」；A3 IX-09/15 要求 dirty 关闭前确认（同框切内容）；A4 Dialog 无 dirty/onBeforeClose。忙碌关闭：A2 允许 Esc+确认，A3/A4 禁用。
5. **词卡**：A3 IX-21 鼠标悬停 120–200ms 切词，与其 IX-11「hover 不承载业务状态」及 A2 §9/C13「点击切词」冲突；A2「所有打开焦点进卡」vs A3「仅键盘打开」。
6. **Tabs/Segmented**：A2 C6 只允许 2–4 项、>4 用 Tabs/Menu；A3 IX-19 2–5 项用 Segmented、>7 下拉；5 项归属冲突。
7. **移动端**：A3 nm-02/§1.4 所有子视图隐 BottomBar；A2 C11 称面板型子视图用 NavShell、layout §2.4「保留壳」。且 A2 C11 tab 序（今日先）与 A3 D-08（内容先）相反；A2 C11 移动页名 vs layout §2.5 不显示/小字，有双 h1 风险。

## 三、A4 对 A2 契约

- **6 缺口**：①`control`：A2 tokens §12 已有，但 §2.1 语义表缺、C1/C5/C6 仍写裸 `bg-zinc-100`，回写不全（A4「§12 未定义」失真）；②OptionCard：C2b 已定义，A4 props 缺 `correct/wrong` 与组内方向键；③favoriteSource：A2 §18 已是 `lib/favoriteSource.ts` + `canOpen`，A4 前提失真；④Pagination：A2/A4 一致（调用方换算），但 A5 QA-ADM-05 写「组件内换算」；⑤BottomBar：保留自有布局，一致；⑥14 浮层：A2 已写 14，A4 前提失真。
- **自行发明**：无新视觉令牌；但 `WordHighlight` 的 `highlights[].color` 允许任意色值；Dialog 增 `busy`、Toast 去 `warning`、SubHeader 去 `onClose` 均未登记；`word-card-position`/`word-lookup` 未进 A2 §18。

## 四、A5 QA 与门禁

- **覆盖**：脚本复核 P0/P1 **51/51、缺失 0**，P0 7/7；V 12/C 9/L 7 均有项。
- **验收值错 5 条**：QA-NAV-13 把管理台归面板型保留侧栏（A3 为 A 独立壳、A2 layout §6.5 无侧栏）；QA-ASM-06/ADM-07 要求页头「关闭」（A3 D-04 禁）；QA-ADM-05 offset 收在组件（A4 调用方）；QA-X-12 Segmented 写 `/60+text-xs`（A2 C6 为 `/80+text-caption`）；QA-X-11/VOC-07 命中区 ≥32（A2 要求 ≥44）。
- **门禁**：G1 漏 `purple`（A2 的 P0）、`red/emerald/amber`、zinc（除 600）、`white/black`、`border-white/5`、`bg-zinc-900/40`、`shadow-black`、`hover:scale`、裸 `transition`、`h-8 rounded-xl`；且放行 `text-[11/13/15/17px]`（与 A2 T-05 冲突）。G2 只抓命名常量，漏 `PAGE_BUTTON/CARD_ICON/SECTION_TITLE/SECONDARY_CTA`，也抓不到行内第二份卡片或新文件。G4 全量拦 `focus:outline-none`，误伤输入壳。→ 只能防部分裸色与典型常量。

## 五、缺项与优先级

- **P1 上线前**：Menu/Dropdown（ModelBar、Review、C5/C14 overflow 自身要用）；公开页布局（welcome/login；Auth 现用被 A2 禁的 `glass` + `min-h-screen`）；OptionCard 状态；Dialog dirty-close；Toast/Empty/Back/tab 序/移动底栏/Segmented 边界文档对齐。
- **P2 上线后**：Table（管理台 2 处）、Switch（2 处）、filterChip、VocabAxis、分享 canvas、离线/恢复横幅、分栏拖拽、面包屑视觉。

## remediation

- **A2**：C1/C5/C6 改 `bg-control`、§2.1 补 `control` 行；C11 tab 序按 D-08；layout §6.1 删 X；明确面板型移动是否保留壳；C10 增 inline(py-3) 或请 A3 改 py-10。
- **A3**：词卡去 hover 切词；明确 dirty 确认路径；Segmented 5 项边界。
- **A4**：OptionCard 补 state/组键盘；Dialog 补 dirty/onBeforeClose；登记 busy/去 warning/去 onClose；删 color 字段。
- **A5**：修 5 条验收值；G1 对齐 A2 §13 T-01..T-15（补 purple 等）；G2 加 `components/ui` 白名单/import 与 A4 常量清单；G4 输入壳例外。
- **门槛**：实例+文件 ≥80% 已过；屏级 67% 需 P1 Menu/公开页 + P2 Table/switch/chip/axis/分栏 补齐后再宣称。
