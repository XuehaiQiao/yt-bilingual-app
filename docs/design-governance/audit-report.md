# 语途（LinguaTrek）前端 UI/UX 现状审计报告

> 审计员：A1 现状审计员 ｜ 日期：2026-11-19 ｜ 版本：v1（阶段 0 · 门禁 0 交付物）
> 仓库：`yt-bilingual-app`（只读审计，未修改任何业务代码，未提交 git）
> 判据：`docs/设计语言.md`（视觉最高标准）、`docs/信息架构-导航重构.md`（导航/门禁唯一契约）、`AGENTS.md` 硬性规则、`CONSTITUTION.md`。
> 本报告只回答「哪里不一致、在哪一行、影响谁」，不写完整设计（A2/A3）也不写迁移代码（A4）。

---

## 0. 摘要：五条结论

1. **设计语言已经写得足够细，但代码里没有它的落点。** `text-[11px]` 出现 341 次、`border-white/5` 375 次、`bg-zinc-900/40` 80 次——「配方」被复制成字面量，而不是 token；`brand` 颜色 token 只被用 5 次，而 `blue-*` 被用 473 次。
2. **同一个界面元素有 3–5 个实现，且已互相漂移。** 主按钮 12 处常量定义（`h-10`/`h-11`/`h-12`、`px-4`/`px-5`/`px-6` 各不相同）；卡片 12 处 `CARD` 常量（`rounded-2xl`/`rounded-3xl`/`rounded-2xl sm:rounded-3xl`）；`formatClock` 复制 7 份；弹窗 15 个、其中 3 个不能用键盘关闭。
3. **导航状态模型（`nav.ts`）本身是干净的纯函数，但页面入口在绕过它。** 博客 slug 已建模却不传给组件、`#/content/library` 被静默改写、从「内容」页打开报告会把底层 tab 静默改成「今日」、子视图互跳后「返回」会越过一层——这四类都会让用户回不到来源。
4. **失败被渲染成空态是最伤害信任的一类问题。** 今日「继续学习」、内容页右栏、频道更新三处请求失败只 `console.error`，用户看到的是「暂无记录」——像是数据丢了。
5. **移动端是「能跑」而不是「设计过」。** `h-screen` + `100dvh` 双写、`min-h-screen` 三处、`52vh` 魔法高度、两套嵌套滚动容器、底部安全区 padding 复制 5 份、Toast 压在底栏上、无一处 `scroll-padding-bottom`。

---

## 1. 方法与覆盖

### 1.1 审计对象与规模

| 项 | 数量 | 说明 |
|---|---|---|
| 用户可见路由（canonical） | 27 条 | `#/{today,content,practice,profile}` 4 + 子路由 15 + `#/learn/*` 3 + `#/lesson/*` 1 + `#/welcome`、`#/login` 2 + `?view=profile` 变体 1 |
| 兼容/旧深链别名 | 6 条 | `#/profile/favorites`、`#/content/library`、`#admin`、`/admin`、空 hash、非法 hash 回落 |
| 一级页 | 4 | 今日 / 内容 / 练习 / 我的（`ProfileScreen` → `AccountScreen isPage`） |
| 子视图组件 | 18 | 学习页（YouTube / 本地剧集 / 免费库视频 / 免费库文章）、课程、复习、报告、定位、能力画像、考试、发现、阅读器、句子精背、博客、公版书、书系、导入书、单词本、管理台、理解题覆盖层、登录浮层 |
| 组件文件 | 62 个 `.tsx`（26,162 行） | `frontend/src/components/`；另有 `App.tsx` 3,554 行 |
| lib 模块 | 42 个 `.ts` | 含 `nav.ts`（333 行）、`useNav.ts`（157 行） |
| i18n | 1,691 keys × 2 语言 | `zh-CN`（结构源）、`vi-VN`；`npm run check:i18n` 通过 |
| 全量前端源码 | 67 `.tsx` + 42 `.ts`，39,304 行 | 审计覆盖全部用户可见源码 |

### 1.2 扫描命令（可复现）

所有结论均来自读取/计数，不来自猜测。主要命令：

```bash
# 1. token 频次（子串匹配，范围 frontend/src/**/*.tsx）
grep -rhoE 'text-\[[0-9.]+px\]' --include=*.tsx frontend/src | sort | uniq -c | sort -rn
grep -rhoE '\b(bg|text|border|from|to|via)-[a-z]+-[0-9]{2,3}' --include=*.tsx frontend/src \
  | sed -E 's/.*-([a-z]+)-[0-9]+/\1/' | sort | uniq -c | sort -rn
grep -rhoE '\bz-\[?[0-9]+\]?' --include=*.tsx frontend/src | sort | uniq -c | sort -rn
grep -rhoE 'rounded-[a-z0-9]+' --include=*.tsx frontend/src | sort | uniq -c | sort -rn

# 2. 组件重复
grep -rnE '^const (PRIMARY_BUTTON|SECONDARY_BUTTON|GHOST_BUTTON|CARD|ACTION|PRIMARY_CTA) =' --include=*.tsx frontend/src
grep -rn 'formatClock\|padStart(2' --include=*.tsx frontend/src

# 3. 弹窗/交互
grep -rn 'fixed inset-0\|role="dialog"\|Escape\|createPortal' --include=*.tsx frontend/src
grep -rn 'window.confirm\|window.alert\|toast\.' --include=*.tsx frontend/src

# 4. 导航
grep -n 'case .learn.\|openSub\|replace(\|back()' frontend/src/App.tsx
node frontend/scripts/check-i18n.mjs
```

抽样方式：**全量静态扫描**（不做抽样）。所有 62 个组件文件、`App.tsx`、`nav.ts`、`useNav.ts`、`index.css`、`tailwind.config.js`、`index.html`、`ci.yml`、ESLint 配置均被读取；21 个页面容器逐页读结构。未做运行时浏览器实测（见 §9）。

### 1.3 分级口径

| 级别 | 定义 | 本报告判据 |
|---|---|---|
| **P0** | 阻塞核心流程，或用户会看到「明显错误」（错的语言、错的状态、错的数据、回不去） | 违反《设计语言》硬性禁令/违反 IA 契约/数据或状态丢失 |
| **P1** | 高频出现，或影响信任/可访问性，但不阻塞单次任务 | ≥10 处同类，或出现在 3 个以上核心页面 |
| **P2** | 打磨项：一致性收益明确、可排到上线后 | <10 处，或纯视觉细节 |

统计基线：**P0 7 条 · P1 44 条 · P2 39 条，共 90 条**（P0+P1 = 51 条，占 57%）。

每条问题按固定六段写：`ID` · `严重度` · `类别` · `位置`（`文件:行` 或路由）· `具体表现` · `用户影响` · `建议方向`。类别由章节给出，同时由 ID 前缀编码：**V**=视觉不统一、**I**=交互不一致、**N**=跳转混乱、**C**=组件重复、**L**=布局/内容组织。

### 1.4 未覆盖范围（已明确排除）

- **运行时真机/浏览器验证**（Playwright、iOS Safari、375/390/430 三档）：本报告为静态审计，涉及移动端裁切的结论标注为「结构上必然」。A5 的 QA 清单需补测。
- 后端接口语义、`mobile/`（Expo）目录、`scripts/` 录制工具、`content/` 静态数据。
- 颜色对比度的精确 WCAG 计算（只标注「违反设计语言 min 值」，未逐色算比值）。
- 课程生成（specs/030）相关页面的内容质量——按章程推迟到上线后，但**其外壳与按钮仍纳入一致性审计**。

---

## 2. 总览

### 2.1 分类统计

| 类别 | P0 | P1 | P2 | 小计 | 高频热点文件 |
|---|---|---|---|---|---|
| 一、视觉不统一 | 1 | 11 | 10 | **22** | `App.tsx`、`VocabularyBookScreen.tsx`、`PlacementScreen.tsx`、`AdminConsoleScreen.tsx`、`ExamScreen.tsx` |
| 二、交互不一致 | 2 | 12 | 6 | **20** | `App.tsx`、`TodayScreen.tsx`、`ContentScreen.tsx`、`ModelSelectionModal.tsx`、`ChannelVideoList.tsx` |
| 三、跳转混乱 | 3 | 6 | 9 | **18** | `lib/nav.ts`、`lib/useNav.ts`、`App.tsx`、`BlogScreen.tsx` |
| 四、组件重复 | 0 | 9 | 7 | **16** | `TranscriptBlock.tsx`、`BilingualRow.tsx`、全部 `*Screen.tsx`（CARD/按钮常量） |
| 五、布局/内容组织 | 1 | 6 | 7 | **14** | `App.tsx`、`AccountScreen.tsx`、`ContentScreen.tsx`、`TodayWorkbench.tsx` |
| **合计** | **7** | **44** | **39** | **90** | — |

### 2.2 热点文件（按本报告涉及的 P0/P1 条目数）

| 文件 | 行数 | 涉及条目 | 主要问题类型 |
|---|---|---|---|
| `frontend/src/App.tsx` | 3,554 | 19 | 硬编码底色、z-index、弹窗、返回落点、词卡 handler 5 份、学习页布局 |
| `frontend/src/lib/nav.ts` | 333 | 9 | 往返不对称、被吞掉的别名、建模了却不用的 slug |
| `frontend/src/components/VocabularyBookScreen.tsx` | 1,483 | 9 | 字号越阶、`zinc-600` 8 处、tab 视觉、来源丢失、两套空态 |
| `frontend/src/components/AccountScreen.tsx` | 840 | 8 | 两套重复壳、页面标题 4 种尺度之一、`zinc-600` 6 处 |
| `frontend/src/components/PlacementScreen.tsx` | 1,447 | 7 | 按钮 `h-11` 与全局不一致、`bg-[#09090b]`、标题尺度 |
| `frontend/src/components/ContentScreen.tsx` | 530 | 7 | 一处页面 9 个区块 4 种标题、右栏失败当空态、tab 归属被改写 |
| `frontend/src/components/ExamScreen.tsx` | 1,300 | 6 | 标题尺度、卡片圆角、按钮 `h-10 px-4`、徽章 |
| `frontend/src/components/AdminConsoleScreen.tsx` | 1,634 | 6 | tab 视觉第 3 套、弹窗 `z-[80]`、`bg-[#09090b]`、分页第 3 套 |
| `frontend/src/components/TodayScreen.tsx` | 254 | 5 | 失败当空态、`window.confirm`、页面 padding 复制 |
| `frontend/src/components/TranscriptBlock.tsx` | 268 | 5 | `cn()` 被定义在组件里、`zinc-600` 占位文案、hover 才出现的收藏星 |

### 2.3 P0 清单（7 条，上线前必须处理）

| ID | 一句话 | 位置 |
|---|---|---|
| V-06 | 中文界面里 24 个键的关键文案是英文（处理遮罩、估价弹窗、本地剧集架、"Cancel"） | `i18n/zh-CN.json`（`common.cancel`、`home.loading.*`、`estimate.*`、`shows.*`…） |
| I-01 | 历史/右栏/频道更新请求失败被渲染成「暂无记录」 | `TodayScreen.tsx:100`、`ContentScreen.tsx:126`、`ContentScreen.tsx:186` |
| I-02 | `ChannelVideoList` 弹窗无 Escape、无遮罩关闭、无 `role="dialog"` | `ChannelVideoList.tsx:68-75` |
| N-01 | `#/content/blog/<slug>` 深链失效：打开博客永远落在列表 | `lib/nav.ts:220-222` vs `App.tsx:3169` |
| N-02 | 从「内容」页打开报告/复习会静默改写底层 tab，关闭后落在「今日/练习」 | `lib/nav.ts:144-145`、`App.tsx:2061` |
| N-03 | 子视图互跳（报告→复习）后点返回会**越过**一层，回到更早的页面 | `lib/useNav.ts:55-69`、`App.tsx:1001-1004` |
| L-01 | 移动端学习页：外层 `overflow-y-auto` + 字幕列固定 `52vh` + 内层滚动，字幕区双滚动 | `App.tsx:2918`、`App.tsx:2943`、`App.tsx:2993` |

---

## 3. 类别一 · 视觉不统一

### 3.1 值频次表（Top 24，全部为硬编码字面量）

> 匹配范围：`frontend/src/**/*.tsx`，对 class 字符串做子串计数（`h-9` 这类短值可能顺带命中 `h-96` 等同前缀，实测误差 ≤3%，不影响排序）。「定义」列指《设计语言.md》是否有对应 token/配方。

| # | 值 | 次数 | 设计语言是否定义 | 代表位置（文件:行） |
|---|---|---|---|---|
| 1 | `border-white/5` | 375 | ✓ 常态细边框 | `App.tsx:2505`、`App.tsx:2510`、`App.tsx:2519` |
| 2 | `text-[11px]` | 341 | ✓ 数字/时间/徽章 | `App.tsx:2457`、`App.tsx:2478`、`App.tsx:2798` |
| 3 | `rounded-full` | 180 | ✓ 胶囊档 | `App.tsx:2457`、`App.tsx:2491`、`App.tsx:2834` |
| 4 | `rounded-lg` | 174 | ✓ ≤36px 控件档 | `App.tsx:2470`、`App.tsx:2510`、`App.tsx:2517` |
| 5 | `rounded-xl` | 168 | ✓ 卡片/按钮档 | `App.tsx:3466`、`PwaInstallButton.tsx:124`、`AccountScreen.tsx:90` |
| 6 | `gap-2` | 321 | ✗ 无间距阶梯 | `App.tsx:2470`、`App.tsx:3329`、`PwaInstallButton.tsx:124` |
| 7 | `gap-3` | 167 | ✗ | `App.tsx:2506`、`App.tsx:2643`、`App.tsx:2826` |
| 8 | `px-4` | 157 | ✗ | `App.tsx:2666`、`App.tsx:2826`、`App.tsx:3329` |
| 9 | `gap-1.5` | 141 | ✗ | `App.tsx:2704`、`App.tsx:2717`、`App.tsx:2757` |
| 10 | `rounded-2xl` | 129 | ✓ 浮层档 | `PwaInstallButton.tsx:83`、`AccountScreen.tsx:322`、`AccountScreen.tsx:387` |
| 11 | `p-4` | 130 | ✗ | `PwaInstallButton.tsx:70`、`AccountScreen.tsx:134`、`AccountScreen.tsx:327` |
| 12 | `px-3` | 127 | ✗ | `App.tsx:2457`、`App.tsx:2510`、`AppShell.tsx:173` |
| 13 | `bg-zinc-800/60` | 125 | ✗ 「次按钮」里出现，但被当万能底色用 | `App.tsx:2510`、`App.tsx:2519`、`App.tsx:3466` |
| 14 | `bg-white/5` | 102 | ✓ 悬停底 | 全仓（卡片 hover、图标按钮） |
| 15 | `border-white/10` | 86 | ✓ 强调/悬停 | `App.tsx:2510`、`App.tsx:2570` |
| 16 | `text-zinc-600` | **87** | ✗ **明令禁用**（「三级 zinc-500，禁用 zinc-600」） | `App.tsx:2563`、`App.tsx:2564`、`App.tsx:2798` |
| 17 | `bg-zinc-900/40` | 80 | ✗ 卡片底三阶之一（另有 /30、/60、/90、/95） | `AccountScreen.tsx:322`、`AccountScreen.tsx:327`、`LibrarySection.tsx` |
| 18 | `h-9` | 73 | ✓ 次按钮 | `App.tsx:3466`、`PwaInstallButton.tsx:55`、`AccountScreen.tsx:90` |
| 19 | `h-10` | 72 | ✓ 主按钮 | `PwaInstallButton.tsx:88`、`AccountScreen.tsx:88`、`PlacementScreen.tsx:70` |
| 20 | `text-[10px]` | 67 | ✗ 阶梯外 | `ReviewScreen.tsx:125`、`ReviewScreen.tsx:497`、`ShowBrowser.tsx:192` |
| 21 | `h-8` | 67 | ✗（紧凑版次按钮是 `h-8 px-3 rounded-lg`，但被用于顶栏/标签） | `App.tsx:2510`、`App.tsx:2517` |
| 22 | `duration-200` | 65 | ✓ 微交互 | `App.tsx:2647`、`App.tsx:2980` |
| 23 | `px-6` | 62 | ✗ | `App.tsx:2505`、`App.tsx:3392`、`PwaInstallButton.tsx:86` |
| 24 | `bg-[#09090b]` | 35 | ✗ 硬编码十六进制（应为 `bg-zinc-950`） | `App.tsx:2890`、`App.tsx:3303`、`AccountScreen.tsx:529` |

补充计数（用于下文条目）：任意字号阶梯外合计 **93 处**（`text-[10px]` 67 + `text-[12px]` 17 + `text-[14px]` 4 + `text-[9px]` 3 + `text-[16px]` 1 + `text-[19px]` 1）；`z-*` **12 档 56 处**；脉动/骨架 `animate-pulse` 仅 6 处；任意阴影 `shadow-[...]` **5 处**，而 `tailwind.config.js:42-47` 定义的 `shadow-elev-1/2/3` 只被用 **2 次**。

### 3.2 问题清单

#### V-01 · P2 · 页面底色用十六进制字面量
- **位置**：`App.tsx:2890`、`App.tsx:2952`、`App.tsx:3303`、`App.tsx:3414`、`App.tsx:3524`、`AccountScreen.tsx:529`、`AccountScreen.tsx:580`、`ReviewScreen.tsx:766`、`AdminConsoleScreen.tsx:869`、`VocabularyBookScreen.tsx:1453`、`BlogScreen.tsx:333`、`PlacementScreen.tsx:1357`（共 35 处）
- **表现**：应用底色写成 `bg-[#09090b]`，而 `tailwind.config` 已有 `zinc-950`；`index.css:9` 也硬编码同一值。
- **影响**：若要调整底色/对比度（例如提亮一档），需要全仓搜索十六进制；Web 端与 PWA 主题色 `index.html` 的 `#09090b` 三处各自独立，容易只改一处。
- **建议方向**：底色收敛为 `bg-zinc-950`（或 `--app-bg` 变量），`index.html` theme-color 与 `index.css` 同步引用同一来源。

#### V-02 · P1 · 字号越出设计阶梯 93 处
- **位置**：`TopBarTabs.tsx:44`（`text-[9px]`）、`Sidebar.tsx:183`（`text-[9px]`）、`SentenceView.tsx:239`（`text-[10px]`）、`ReviewScreen.tsx:125/497`、`ShowBrowser.tsx:192`、`VocabularyBookScreen.tsx:607`（`text-[13px]`）、`ImportedBookReaderScreen.tsx:520`（`text-[12px]`）、`SentenceText.tsx:19`（`text-[19px]`）
- **表现**：设计只定义 11/13/15/17px 四级；代码实际出现 9/10/11/12/13/14/15/16/17/19px 十档。
- **影响**：同一屏内相邻文本差 1px 的情况普遍（如 10px 徽章 + 11px 标签），中文小字在 10px 下已经难读；改一套响应式字号要动 93 处。
- **建议方向**：A2 定 5 档（label/caption/body/title/display）并把越阶值映射过去；9/10px 一律并入 11px（iOS 最小可读字号）。

#### V-03 · P1 · `text-zinc-600` 87 处违反禁令
- **位置**：`App.tsx:2563`、`App.tsx:2564`、`App.tsx:2798`、`TranscriptBlock.tsx:232`、`VocabularyBookScreen.tsx`（8 处）、`AccountScreen.tsx`（6 处）、`ReportScreen.tsx`（5 处）、`AuthScreen.tsx`（5 处）、`ShowBrowser.tsx`（4 处）、`LibrarySection.tsx`（4 处）、`AdminConsoleScreen.tsx`（4 处）、`SentenceView.tsx`（3 处）、`ImportedBookReaderScreen.tsx`（3 处）、`BookImportDialog.tsx`（3 处）、`AbilityScreen.tsx`（3 处）
- **表现**：《设计语言》颜色节写死「三级 zinc-500，禁用 zinc-600」，代码里 87 处用 `zinc-600` 当三级文字/占位符。
- **影响**：`#52525b` 在 `#09090b` 上的对比度约 3.0:1（低于 WCAG AA 4.5:1），而它被用在**空态提示、占位符、字号 11px 的说明**这些最需要可读的位置；`TranscriptBlock.tsx:232` 还叠加 `animate-pulse`，翻译中的占位句几乎不可见。
- **建议方向**：全局替换 `text-zinc-600` → `text-zinc-500`（三级）；需要更淡的语义改用 opacity 而非更低色阶。

#### V-04 · P1 · `brand` 颜色 token 形同虚设（5 vs 473）
- **位置**：`tailwind.config.js:25-31` 定义 `brand`；实际 `blue-*` 473 次、`brand-*` 5 次（`AppShell.tsx:203`、`BottomBar.tsx:36/45`、`TopBarTabs.tsx:44/52`）
- **表现**：同一个顶栏内，游客登录按钮用 `bg-brand/10 text-brand-300`（`AppShell.tsx:203`），而 6px 之外的单词本按钮用 `bg-zinc-800/60`；学习页 PiP 按钮用 `bg-blue-500/10 text-blue-400`（`LearningHeader.tsx:81`）。三个控件同排、三种写法。
- **影响**：改品牌蓝需要改 473 处；`blue-400`(#60a5fa) 与 `brand-400`(#409CFF) 肉眼难辨但色值不同，出现「看起来一样、实际两色」的脏值。
- **建议方向**：以 `brand` 为唯一交互强调 token，禁止 `blue-*` 直接出现在组件里（可用 ESLint `no-restricted-syntax` 拦 className 字符串）。

#### V-05 · P1 · 紫色语义扩散到 5 类用途
- **位置**：`App.tsx:2890`、`App.tsx:3303`（`selection:bg-purple-500/30`）、`App.tsx:2548`、`App.tsx:2621`（区块标题 `group-hover:text-purple-400`）、`TranscriptBlock.tsx:97`（注释 ruby `text-purple-300/90`）、`WordPopover.tsx:258`、`WordPopover.tsx:301`（词性徽章 `bg-purple-500/15`）
- **表现**：《设计语言》「紫色只用于 AI 生词高亮」，实际被用于：文本选中、hover 变色、注释 rt、词性徽章。
- **影响**：用户学到「紫色 = AI 挑出来的词」这条隐含规则后被破坏；且选中色与 AI 高亮同色，复制文本时会误以为在标记生词。
- **建议方向**：紫色只保留在 `CHUNK_STYLE`/后端 highlights 数据路径；选中色改用 `brand/30`，词性徽章用中性 `bg-zinc-800` + `text-zinc-300`。

#### V-06 · **P0** · 中文界面里 24 个键的关键文案是英文
- **位置**：`i18n/zh-CN.json`（1,691 条中 53 条不含任何 CJK；49 条被 `*.tsx` 引用，其中 24 条是默认中文界面会直接显示的英文文案）。渲染点：
  - 视频处理全屏遮罩 5 条：`common.cancel`→"Cancel"（`ModelSelectionModal.tsx:180`）；`home.loading.loading`="Loading…"、`home.loading.processing`="Fetching subtitles…"、`home.loading.asr`="Transcribing locally…" 及其 2 条 hint（`App.tsx:3396-3402`）；`home.analyzing`/`home.analyzingHint`（`EstimateDialog.tsx:95-97`）
  - 估价弹窗 5 条：`estimate.title`="Confirm & Start"、`estimate.subtitle`（整句英文）、`estimate.words`="Words:"、`estimate.tokens`="Est. tokens:"、`estimate.confirm`="Confirm & Start"（`ModelSelectionModal.tsx:68/71/100/101/186`）
  - 本地剧集货架 4 条：`shows.empty`="No local shows yet"、`shows.emptyHint`=**"Drop .srt files into subtitles/ to add one"**（把开发者操作说明暴露在 UI 里）、`shows.back`="Back"、`shows.pickSeason`="Pick a season to start"（`ShowBrowser.tsx:83/84/100/201`）
  - 其他：`topbar.popOut`/`closePopOut`（`LearningHeader.tsx:79-85` 的按钮文字与 aria）、`topbar.logoAlt`（`AppShell.tsx:130` aria）、`common.unknownVideo`（`App.tsx:2907` 等 6 处）、`common.unknownChannel`/`noThumbnail`（`ModelSelectionModal.tsx:92/97`）、`home.deletedToast`="Removed from Continue Learning"（`TodayScreen.tsx:151` toast）
- **表现**：默认 UI 语言是 `zh-CN`（`lib/i18n/index.ts:38`），但用户在「看视频→处理→确认→看本地剧集→删除历史」这条主链路上会连续看到 5 处英文；其中 `shows.emptyHint` 直接对用户说「把 .srt 文件放到 subtitles/ 目录」。
- **影响**：中文用户在最关键的三个时刻（等待处理、确认花钱、选择本地内容）看到英文/开发者文案 → 界面像半成品，且「确认花费」这种高信任场景用英文按钮会降低确认率；`check-i18n.mjs` 只校验 vi-VN 对齐，**测不出这一类**。
- **建议方向**：① 补齐这 24 个键的中文；② `check-i18n.mjs` 增加规则「`zh-CN` 值除白名单（品牌名、CEFR、Gutenberg、URL 占位、`Pride and Prejudice` 书名）外必须含 CJK」；③ `shows.emptyHint` 改成用户语言（「在设置里上传字幕，或选择免费资源」）。

#### V-07 · P1 · 保留色之外新增 3 个色相
- **位置**：`LibrarySection.tsx:168`、`ImportedBookReaderScreen.tsx:100`、`ImportedBooksShelf.tsx:143`（`violet-500/*` 徽章）、`VocabAxis.tsx:47`（`from-sky-400 via-violet-400 to-pink-400` + `shadow-[0_0_12px_rgba(139,92,246,0.5)]`）、`LocalEpisodeStage.tsx:82`（`from-blue-500/[0.08] … to-purple-500/[0.06]` 环境渐变）、`SentencePacks.tsx:43`、`SentenceView.tsx:169`（`from-emerald-400 to-sky-400`）
- **表现**：《设计语言》颜色节只列 zinc / 蓝 / 紫（仅 AI 词）/ 翠绿 / 琥珀 / 红；实际出现 `violet`(10)、`sky`(3)、`pink`(1)。
- **影响**：词汇等级轴（设置页）是整页唯一的彩虹渐变 + 紫色外发光，与「克制、界面退后」的总纲直接冲突；`sky` 只出现在两个进度条，无法被用户理解为语义。
- **建议方向**：`violet` 与 `purple` 合并为一个 AI 高亮专用色；`sky` 删除（进度用 brand 蓝或 emerald）；CEFR 轴改为「灰轨 + 当前档 brand 蓝」。

#### V-08 · P2 · 进度条三套配色
- **位置**：观看进度 `emerald-500`（`TodayWorkbench.tsx` 进度条、`ContentScreen.tsx:300`）；句子打卡 `emerald-400 → sky-400` 渐变（`SentenceView.tsx:169`、`SentencePacks.tsx:43`）；CEFR 轴 `sky → violet → pink`（`VocabAxis.tsx:47`）
- **表现**：同为「进度」语义，三处颜色语言不同。
- **影响**：用户无法形成「绿色=已看/已打卡」的稳定直觉。
- **建议方向**：进度统一 `emerald-500`（完成）与 `brand`（当前），渐变最多单色到透明。

#### V-09 · P1 · 圆角分档被跨档使用
- **位置**：`TopBarTabs.tsx:33`（`h-9 rounded-lg`）与 `AppShell.tsx:173`（`h-9 rounded-xl`）——同高控件两档；`PlacementScreen.tsx:75`（`CARD`=`rounded-3xl`）与 `VocabularyBookScreen.tsx:142`（`CARD`=`rounded-2xl`）——同级卡片两档；`ExamScreen.tsx:91`（`rounded-2xl sm:rounded-3xl`）——同一元素两档
- **表现**：设计按元素尺寸分级（≤36px→lg、卡片→xl、浮层→2xl、页面级 bento→3xl），代码按「作者手感」选档。
- **影响**：并排出现的按钮/卡片并非刻意却差一档时，看起来像两种组件而不是两个元素。
- **建议方向**：A2 给「控件高度 → 圆角」硬映射，CI 用正则抽查（`h-9` 只允许 `rounded-lg`/`rounded-full`）。

#### V-10 · P1 · 遮罩/面板材质的 5 种透明度
- **位置**：`bg-zinc-950/70`（17 处，`App.tsx:3392`、`PwaInstallButton.tsx:70`、`AdminConsoleScreen.tsx:312`）、`bg-zinc-950/60`（14 处，`AppShell.tsx:115` 顶栏、`LearningHeader.tsx:34`）、`bg-zinc-900/90`（11 处）、`bg-zinc-900/95`（`BookImportDialog.tsx:136`）、`bg-zinc-950/85`（`BottomBar.tsx:20`）
- **表现**：《设计语言》材质节规定「弹窗遮罩 `bg-zinc-950/70 backdrop-blur-md`」「对话框表面 `bg-zinc-900/90 backdrop-blur-2xl`」；实际 5 种组合，且 blur 也有 `sm/md/xl/2xl` 四档（21/20/13/2 处）。
- **影响**：连续打开不同弹窗（导入书 → 分享卡 → 语言设置）时，背景透明度跳变；玻璃层叠时 `p-6` 卡片看穿两层。
- **建议方向**：遮罩/对话框/面板/chrome 四类各锁一个配方，写进 A2 tokens。

#### V-11 · P1 · vh / dvh 混用导致移动端裁切
- **位置**：`App.tsx:2890` + `App.tsx:2891`（`h-screen` + inline `height:100dvh` 双写，3303/3304 同）、`AuthScreen.tsx:91`（`min-h-screen`）、`WelcomeScreen.tsx:164`（`min-h-screen`）、`InputScreen.tsx:243`（`min-h-screen`，已废弃组件）、`ShareCardDialog.tsx:210`（`max-h-[92vh]`）vs `AbilityScreen.tsx:258`（`max-h-[92dvh]`）、`ChannelVideoList.tsx:69`（`max-h-[85vh]`）vs `AbilityScreen.tsx:484`（`max-h-[85dvh]`）
- **表现**：IA §6.4 第 1 条要求「根壳用 `h-dvh`」；实现用 `h-screen` + 内联 `100dvh` 补丁，`min-h-screen` 三处仍是 100vh。
- **影响**：iOS Safari 地址栏收起/展开时，`min-h-screen` 页面（营销首屏、登录页）会比可视区高 60–100px，导致首屏 CTA 被浏览器工具栏挡住或出现二次滚动。
- **建议方向**：全局只允许 `dvh`（`h-dvh`/`min-h-dvh`/`max-h-[<n>dvh]`），删掉 `h-screen` 双写；`index.css` 加 `@supports` 兜底一处即可。

#### V-12 · P1 · 阴影绕过 token，`elev-*` 几乎没人用
- **位置**：`Toaster.tsx:37`、`WordPopover.tsx:250`、`TranscriptBlock.tsx:167`、`VocabAxis.tsx:47`、`ReaderScreen.tsx:1316`（5 处任意 `shadow-[...]`）；`tailwind.config.js:42-47` 定义 `shadow-elev-1/2/3`，仅 `OfflineIndicator.tsx:24`、`PwaInstallButton` 使用 2 次；另有 `shadow-2xl` 17 次、`shadow-black` 22 次
- **表现**：三层 elevation 的语法存在但被 `shadow-2xl shadow-black/60` 直接取代。
- **影响**：深色界面上阴影是主要的层次手段；现在是「谁写谁定」，同一深度（如 toast 与词卡）阴影不同，玻璃感不统一。
- **建议方向**：`elev-1/2/3` 覆盖 toast/词卡/弹窗三档，禁止新增 `shadow-[...]`。

#### V-13 · P1 · z-index 12 档无分层规则
- **位置**：12 档 56 处：`z-10`(18) `z-20`(9) `z-30`(6) `z-40`(1) `z-50`(12) `z-[60]`(1, `App.tsx:3014` 拖拽盾) `z-[70]`(1, `LanguageSettingsModal.tsx:99`) `z-[80]`(2, `AdminConsoleScreen.tsx:310`、`WordPopover.tsx:229`) `z-[90]`(1, `WordPopover.tsx:250`) `z-[95]`(2, `OfflineIndicator.tsx:24`、`ReaderScreen.tsx:1316`) `z-[100]`(2, `Toaster.tsx:27`、`ShareCardDialog.tsx:195`) `z-[120]`(1, `PwaInstallButton.tsx:70`)
- **表现**：同一功能层出现并列值——离线标记与阅读器浮动按钮都是 `z-[95]`；toast(100) 低于 PWA 安装提示(120) 但高于分享卡(100，同级)。
- **影响**：词卡（90）打开时离线标记（95）会盖在词卡上；toast 与分享卡同层，DOM 顺序决定谁在上，行为不稳定。
- **建议方向**：定义 6 层（base/overlay/chrome/popover/toast/critical）→ 对应 6 个 token 类，其余禁止。

#### V-14 · P1 · 焦点样式三套并存（含吞掉全局环）
- **位置**：全局 `:focus-visible` 蓝环（`index.css:17-21`）；`StartLearning.tsx:111/165`（`focus:border-brand/60 focus:ring-2 focus:ring-brand/15`）；`BookImportDialog.tsx:192`（`focus:border-blue-500/40 focus:outline-none focus:ring-1 focus:ring-blue-500/30`）；`AccountScreen.tsx:620`（`focus-visible:border-brand/60 focus-visible:ring-2 focus-visible:ring-brand/15`）；`ReaderScreen.tsx:151`（`focus:border-…`）
- **表现**：《设计语言》要求「键盘焦点全局统一 `:focus-visible` 蓝环，不做每组件特例」，实际 9 个文件自定义，且 `focus:outline-none` 会主动取消全局环（只在鼠标聚焦时也算）。
- **影响**：键盘用户聚焦输入框时，有的看到 2px 蓝环、有的看到 1px 半透明蓝环、有的什么都没有（被 `outline-none` 吞掉）。
- **建议方向**：删除组件级 `focus:ring/outline-none`，只保留全局规则 + 输入框 `focus-within:border-brand/60` 的容器高亮。

#### V-15 · P2 · 页面标题 4 种尺度、2 种颜色
- **位置**：`TodayWorkbench.tsx:195`（`text-2xl sm:text-4xl md:text-5xl`，`text-zinc-50`）、`ContentScreen.tsx:219`（`text-2xl md:text-3xl`，`text-zinc-50`）、`PracticeScreen.tsx:88`（`text-2xl md:text-3xl`，`text-zinc-50`）、`AccountScreen.tsx:289`（`text-2xl`，`text-zinc-50`，无 md 变体）、`ExamScreen.tsx:1176`（`text-xl sm:text-2xl`，`text-zinc-100`）、`ReviewScreen.tsx:356`/`VocabularyBookScreen.tsx:564`/`ReportScreen.tsx:138`（`text-2xl`，`text-zinc-100`）
- **表现**：同为「页面标题」，4 档字号、2 种白色（`zinc-50` vs `zinc-100`）、有无 md 断点各不相同；设计规定首页大标题 `text-5xl md:text-6xl`，实际最大 `md:text-5xl`。
- **影响**：跨 tab 切换时标题明显跳档（今日 48px → 内容 30px → 我的 24px），像三个不同产品。
- **建议方向**：一级页统一一个 `PageTitle`（含 md 档），子视图统一一个 `SubHeader`（IA §6.3 已点名「P1 统一成 SubHeader」）。

#### V-16 · P2 · 页面容器宽度 8 种
- **位置**：`max-w-[1440px]`（`TodayScreen.tsx:190`、`ContentScreen.tsx:215`）、`max-w-6xl`（`PracticeScreen.tsx:86`、`AccountScreen.tsx:531`、`AdminConsoleScreen.tsx:871`）、`max-w-5xl`（`VocabularyBookScreen.tsx`、`CourseScreen.tsx:135`）、`max-w-3xl`（`BlogScreen.tsx:335`、`DiscoverScreen.tsx:256`、`BookSeriesScreen.tsx:88`）、`max-w-2xl`（`ReviewScreen.tsx:768`、`ReportScreen.tsx:168`、`PlacementScreen.tsx:1359`、`ExamScreen.tsx:1169`、`QuizScreen.tsx:617`、`AbilityScreen.tsx:1217`）、`max-w-5xl`（Welcome）、`max-w-xl`（`CourseScreen.tsx:402`）、`max-w-md`（弹窗）
- **表现**：同级页面（内容 vs 练习 vs 我的）宽度 1440 / 1152 / 1152 并存。
- **影响**：1440 显示器上从「内容」切到「练习」，内容区突然收窄 288px，左边缘跳动。
- **建议方向**：A2 定两档容器（宽页 `max-w-[1440px]`、阅读/任务页 `max-w-2xl/3xl`），一级页必须同类同宽。

#### V-17 · P2 · 页面内边距 4 套
- **位置**：`px-4 sm:px-6 lg:px-8`（Today/Content/Practice/Account）、`px-4 sm:px-6`（Review/Report/Placement/Exam/Quiz/Ability/Vocab/Admin/Blog）、`px-4 sm:px-8`（`BookReaderScreen.tsx:466`、`LibraryArticleReader.tsx:81`）、`px-5 sm:px-8`（`WelcomeScreen.tsx:36`）；顶部 `pt-4`（Today）vs `pt-5`（Content/Practice）vs `py-6`（Account/Blog）vs `py-4`（Review/Exam）
- **表现**：同一层级的顶边距差 8–16px。
- **影响**：桌面端切换 tab 时标题的 Y 坐标跳动（今日 16px、内容 20px、我的 24px），视觉上「页面在抖」。
- **建议方向**：一级页统一 `pt-6 sm:pt-8`、二级页 `py-4 sm:py-8`（与 IA §3 的页面结构表一起定）。

#### V-18 · P2 · 图标容器 5 种尺寸
- **位置**：`w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20`（`PracticeScreen.tsx:103/134/158/194`）、`w-9 h-9 rounded-lg`（`ModelSelectionModal.tsx:111`）、`w-12 h-12 rounded-2xl`（`ExamScreen.tsx:505`）、`w-14 h-14 rounded-full`（`AccountScreen.tsx:537`、`AccountScreen.tsx:588`）、`w-10 h-10 rounded-xl bg-violet-500/10`（`LibrarySection.tsx:168`）
- **表现**：同一「区块图标」角色，尺寸 36/40/48/56px 四种，圆角三档。
- **影响**：卡片头部的图标块大小不一，卡片的「眼位」对不齐。
- **建议方向**：定 `IconTile`（sm 36 / md 40 / lg 48）三档，颜色由语义参数决定。

#### V-19 · P2 · 间距网格不统一
- **位置**：卡片网格 `gap-2.5 sm:gap-4`（`TodayWorkbench.tsx:305`）vs `gap-4 sm:gap-5`（`PracticeScreen.tsx:131`）vs `gap-4 sm:gap-6`（`ContentScreen.tsx:383`）；页面区块 `space-y-4 sm:space-y-5`（Practice）vs `gap-6 sm:gap-8`（Content）
- **表现**：三种「卡片间距」在三个一级页并存（10/16/20/24px）。
- **影响**：三页的节奏感不同，用户感觉「内容页更松散、练习页更挤」。
- **建议方向**：定 4/8/12/16/24 五档间距（gap-1/2/3/4/6），同角色同值。

#### V-20 · P2 · 按压/悬停反馈 3 档
- **位置**：`active:scale-[0.98]`（24 处）、`active:scale-[0.99]`（3 处，`TodayWorkbench` 卡片）、`active:scale-[0.95]`（2 处）、`whileTap`（10 处，stiffness 550/35 等）；`hover:scale-[1.04]`（1 处）
- **表现**：《设计语言》规定按压 `active:scale-[0.98]`、卡片 `whileTap 0.98`、悬停绝不缩放；实际 3 种缩放值 + 1 处悬停放大。
- **影响**：同样的卡片在不同页面按下去的位移不同；`0.95` 在小按钮上看起来像「塌陷」。
- **建议方向**：只保留 0.98（控件）/ 0.99（大卡片）两档，删除 `hover:scale`。

#### V-21 · P2 · 动效时长/曲线不统一
- **位置**：`duration-200` 65 / `duration-300` 16 / `duration-500` 3 / `duration-150` 1；裸 `transition`（Tailwind 默认 150ms）**346 处**，显式 `transition-[…]` 仅约 40 处；`ease-apple` 56 处；`animate-[fadeIn_…]`/`animate-[slideUp_…]` 9 处（`ChannelVideoList.tsx:68-69`、`AdminConsoleScreen.tsx:312/320`、`ModelBar.tsx:99`）
- **表现**：《设计语言》要求「精确指定要动的属性，少用 transition-all，位移/缩放用 `ease-apple`」；实际 346 处用默认 `transition`（属性全集 + 150ms），`ease-apple` 只覆盖 56 处。
- **影响**：颜色过渡有的 150ms、有的 200ms、有的 300ms；带 transform 的交互里约 300 处用默认曲线而非苹果曲线，手感不一致。
- **表现（补充）**：《设计语言》要求「装饰性动效（极光、粒子、卡片倾斜）必须尊重 `prefers-reduced-motion`」；实际 26 个文件使用 framer-motion，只有 6 个调用了 `useReducedMotion`（`ReviewScreen.tsx:140`、`VocabularyBookScreen.tsx:174`、`PlacementScreen.tsx:126`、`QuizScreen.tsx:90`、`ExamScreen.tsx`、`ShareCardDialog.tsx`），且没有 `<MotionConfig reducedMotion="user">` 全局兜底——`TopBarTabs`、`SentenceView`、`WordPopover`、`Toaster`、`AdminConsoleScreen` 等 20 个动画组件在「减弱动态效果」开启时仍然照常弹跳。
- **建议方向**：`transition-colors`/`transition-transform` 二选一 + `duration-200 ease-apple` 作为默认，裸 `transition` 加 lint 禁用；`App.tsx` 根部包一层 `MotionConfig reducedMotion="user"`（一处即可覆盖全部 framer 动效）。

#### V-22 · P2 · 共享视觉基础件被塞进业务组件
- **位置**：`cn()` 定义在 `TranscriptBlock.tsx:11`，被 `SentenceText.tsx:1`、`BilingualRow.tsx:12` 反向 import；`bilingualReadingWidth()` 定义在 `BilingualRow.tsx:16`，被 4 个 reader 共用；`CHUNK_STYLE` 在 `lib/sentences.ts`（正确做法对照）
- **表现**：`cn()` 这种基础设施住在「字幕块」组件里，其他组件为了用它必须 import 一个字幕组件；`TranscriptBlock` 因此成为事实上的 UI 工具库。
- **影响**：任何想复用 `cn` 的新组件都会引入字幕模块（含 477 行字幕逻辑与 memo 比较器），依赖方向反转；也解释了为什么全仓只有 4 个文件用 `cn`（其余 58 个文件拼字符串）。
- **建议方向**：`lib/cn.ts` + `lib/reading-layout.ts`，组件只 import lib（A4 收敛项）。

---

## 4. 类别二 · 交互不一致

### 4.1 行为矩阵

| 同类操作 | 模块 A 的行为 | 模块 B 的行为 | 模块 C 的行为 | 证据 |
|---|---|---|---|---|
| **点词查词** | 字幕：`ClickableWords` 逐词 `<span>`，hover 才出 `bg-white/10` | 句子精背：`SentenceText` 的语块整块可点 + `font-semibold` | 阅读/书籍：`ReadingHighlight` 包 `ClickableWords` + 琥珀下划线 | `TranscriptBlock.tsx:26-48`、`SentenceText.tsx:27-36`、`ReadingHighlight.tsx:20-30` |
| **查词卡来源** | 字幕：无 `sourceId`，靠 `currentSourceFields()` 推断 | 阅读器：传 `article.id/title` → `source_kind='article'` | 书/句子包：书传 id；**句子包不传** → 来源丢失 | `App.tsx:288-368`、`App.tsx:3162` |
| **返回上一级** | 学习页：`h-9 px-2 rounded-lg`，≥sm 显示文字 | 书阅读器：`h-8 px-2.5 rounded-lg` | 句子精背：`h-7 px-2 -ml-1`，**永远显示文字**，icon 3.5 | `LearningHeader.tsx:42`、`BookReaderScreen.tsx:438`、`SentenceView.tsx:108` |
| **退出全屏页** | 「X」+ 带底边框 chip：复习/报告/考试/定位/能力/理解题（`p-2 rounded-full bg-zinc-800/60 border border-white/5`） | 「X」幽灵底：模型选择/语言设置/频道列表/PWA/管理台（`p-2 rounded-full text-zinc-400 hover:bg-white/5`） | 「← 文字」返回：发现/博客/阅读器/书/单词本（`h-8 px-2 -ml-2 rounded-lg`）；词卡/Toast 用 `p-1.5` + `w-4` | `ReviewScreen.tsx:363`、`ModelSelectionModal.tsx:76`、`DiscoverScreen.tsx:260`、`WordPopover.tsx:277` |
| **弹窗遮罩关闭** | 语言设置/导入书/分享卡：点击遮罩关闭 | 选择模型：点击遮罩关闭（无 Escape） | 频道列表：**遮罩不可点、无 Escape、无 role** | `LanguageSettingsModal.tsx:102`、`ModelSelectionModal.tsx:56`、`ChannelVideoList.tsx:68` |
| **加载态** | 一级页：文字 + `Loader2 w-3.5`（内容页右栏） | 阅读器/博客：居中 `Loader2 w-6` + 说明文字 | 书/书架：骨架屏 `animate-pulse` | `ContentScreen.tsx:285`、`ReaderScreen.tsx:890`、`ImportedBooksShelf.tsx:80-82` |
| **错误态** | 今日/内容右栏：**无错误态**，`console.error` 后当空 | 阅读器：红色面板 + 重试 + 登录 | 单词本目录：琥珀条 + 重试 | `TodayScreen.tsx:100`、`ReaderScreen.tsx:183-190`、`VocabularyBookScreen.tsx:1458` |
| **空态** | 单词本：`py-16` + 图标 40 + 标题 + 提示 | 最近学习：`py-10` + **虚线边框** + 蓝色 CTA | 发现/阅读器：`py-12`；句子包：`py-24` 纯文字无图标 | `VocabularyBookScreen.tsx:644-650`、`RecentLearning.tsx:508-530`、`DiscoverScreen.tsx:463`、`SentenceView.tsx:186` |
| **收藏（星标）** | 字幕：hover/触屏才显示，无成功 toast | 句子包：常显，无成功 toast | 词卡：常显，游客点击只 toast「登录后保存」，星标不变 | `TranscriptBlock.tsx:195-205`、`SentenceView.tsx:249`、`WordPopover.tsx:268-276` |
| **危险操作确认** | 删除历史/文章/书：`window.confirm`（4 处） | 考试退出/定位重启：自绘 `role="dialog"` 确认 | 管理台：自绘 dialog + Escape | `TodayScreen.tsx:145`、`ReaderScreen.tsx:644`、`ExamScreen.tsx:1235`、`AdminConsoleScreen.tsx:282-330` |
| **移动端手势** | 全应用仅 4 个手势区：分栏拖拽、词卡 hover 探测、本地剧集进度条点击、拖拽盾 | 无滑动返回、无下滑关闭底部弹层、无长按、无下拉刷新 | 唯一触屏适配是 `[@media(pointer:coarse)]`（1 处） | `App.tsx:2971-2976`、`WordPopover.tsx:241`、`LocalEpisodeStage.tsx:133`、`TranscriptBlock.tsx:200` |

### 4.2 问题清单

#### I-01 · **P0** · 请求失败被渲染成「暂无数据」
- **位置**：`TodayScreen.tsx:92-105`（`/api/history` 失败 → 只有 `console.error`，`history=[]`）、`ContentScreen.tsx:119-131`（同）、`ContentScreen.tsx:163-192`（`/api/channel-updates` 失败 → `console.error`，`visibleUpdates=[]`）
- **表现**：网络失败/后端 500 时，今日「继续学习」显示空态文案 `home.today.continueEmptyTitle`，内容页右栏显示 `content.rail.continueEmpty`，订阅区显示 `home.noUploads`。
- **影响**：用户会以为**学习历史被清空/订阅内容没了**——这是最伤信任的一类错误；重试也无从下手（没有重试入口）。
- **建议方向**：三处补 `*Failed` 状态与「重试」按钮（与 `weekReportFailed` 同一模式，`TodayScreen.tsx:90` 已有先例），失败时不得走空态分支。

#### I-02 · **P0** · 频道列表弹窗无法用键盘/遮罩关闭
- **位置**：`ChannelVideoList.tsx:68-75`（`fixed inset-0` 容器无 `onClick`；面板无 `role="dialog"`；文件内无 `Escape` 监听）
- **表现**：唯一关闭方式是右上角 `p-2 rounded-full` 的 X（约 36×36 命中区）。
- **影响**：键盘用户与读屏用户**无法关闭**该弹窗（Tab 能到 X，但没有 Esc 习惯路径；遮罩点击无效）；手机上单手误触概率低但 X 目标小于 44px。
- **建议方向**：与 `AdminConsoleScreen.tsx:282-330` 的共享 dialog 壳对齐（Escape + 遮罩 + role + 焦点回填）。

#### I-03 · P1 · 弹窗生态：13 个实现，3 个缺 role，3 处无 Escape
- **位置**：有 `role="dialog"`：`LanguageSettingsModal.tsx:106`、`BookImportDialog.tsx:130`、`ShareCardDialog.tsx:201`、`AbilityScreen.tsx:253/479`、`ExamScreen.tsx:1236`、`PlacementScreen.tsx:1403`、`AdminConsoleScreen.tsx:316`、`PwaInstallButton.tsx:75`；**缺 role**：`ModelSelectionModal.tsx:59`、`ChannelVideoList.tsx:69`、`WordPopover.tsx:244`
- **表现**：同样从「编辑态背景」升起的浮层，有的声明模态、有的只是 div。
- **影响**：读屏不会把浮层当对话框播报，背景内容仍在可访问树里（能 Tab 到背后按钮）。
- **建议方向**：A4 抽一个 `Dialog`（role/aria-modal/焦点陷阱/Escape/遮罩/滚动锁），13 处全部替换。

#### I-04 · P1 · 无滚动锁、无焦点陷阱
- **位置**：全仓无 `document.body.style.overflow` 锁定（只有 `App.tsx:457-466` 为拖拽设 `userSelect`）；无 focus trap 工具；`autoFocus` 仅 2 处（`AccountScreen.tsx:606`、`AdminConsoleScreen.tsx:453`）
- **表现**：打开词卡/导入书弹窗后，背景页面仍可滚动；Tab 会跑到浮层后面的按钮上；关闭后焦点不回到触发元素。
- **影响**：手机上手势会「滚动穿透」到背后的页面；键盘用户在长弹窗里会迷失焦点。
- **建议方向**：随 I-03 的 `Dialog` 一并解决（`inert` + `overflow-hidden` + 焦点回填）。

#### I-05 · P1 · 危险操作确认方式分裂（原生 vs 自绘）
- **位置**：`window.confirm`：`TodayScreen.tsx:145`、`ReaderScreen.tsx:644`、`ImportedBookReaderScreen.tsx:365`、`InputScreen.tsx:115`（死代码）；自绘 `role="dialog"` 确认：`ExamScreen.tsx:1235`、`PlacementScreen.tsx:1402`、`AdminConsoleScreen.tsx:310`
- **表现**：同一个「删除」动作，在今日/阅读器弹系统原生对话框（英文按钮、不可 i18n），在考试/定位弹设计过的自定义对话框。
- **影响**：原生 `confirm` 的按钮文案由浏览器语言决定（中文系统里是「确定/取消」，英文系统里是 OK/Cancel），与产品文案体系脱节；UI 一致性在最「危险」的操作上最先崩。
- **建议方向**：统一 `ConfirmDialog`，禁用 `window.confirm/alert`（ESLint 规则即可拦）。

#### I-06 · P1 · 收藏「无成功反馈」，游客收藏「看起来成功」
- **位置**：`App.tsx:892-904`（`toggleFavorite`：guest 只 `toast.info` 后 return）、`App.tsx:849-890`（`addFavoriteOptimistically` / `removeFavoriteOptimistically`：乐观更新，仅错误时 toast）
- **表现**：收藏成功无任何提示；失败才 toast。游客点星标：toast 提示「登录后保存」，但**星标状态不变**——视觉上像点了没反应，或像已经收藏了。
- **影响**：用户无法确认「这一句到底存没存」；游客会以为收藏失败是 bug。
- **建议方向**：星标点击后立即进入「已收藏」视觉（乐观），失败回滚 + 错误 toast；或游客点击时直接打开登录浮层（与 `onRequestLogin` 一致）。

#### I-07 · P1 · 加载态 3 种形态混用，只有 1 处骨架屏
- **位置**：`ContentScreen.tsx:285`（`Loader2 w-3.5` + 文字）、`ReaderScreen.tsx:890`（`Loader2 w-6` + 标题）、`BlogScreen.tsx:361`（`Loader2 w-6` + 文字）、`ImportedBooksShelf.tsx:80-82`（骨架 `animate-pulse`）、`VocabularyBookScreen.tsx:1015`（行内 spinner）
- **表现**：同一「列表加载」，书架用骨架屏、博客用居中 spinner、右栏用行内小 spinner；spinner 尺寸 7 档（`w-3` 1 / `w-3.5` 若干 / `w-4` 32 / `h-4 w-4` 7 / `w-5` / `w-6` 6 / `w-12`）。
- **影响**：首屏加载时布局会「跳」（无骨架的页面从 0 高度长出来）；同一产品里出现两种加载语言。
- **建议方向**：A2 定 `Spinner`（sm/md/lg）与「列表首屏用骨架」规则；`w-4 h-4` 与 `h-4 w-4` 合并。

#### I-08 · P1 · 空态 6 种内边距、2 种边框
- **位置**：`py-16` 8 处（`BlogScreen.tsx:487`、`VocabularyBookScreen.tsx:647`）、`py-24` 5 处（`SentenceView.tsx:186`、`ReaderScreen`）、`py-20` 3 处、`py-12`（`DiscoverScreen.tsx:464`）、`py-10`（`RecentLearning.tsx:513`）、`py-8`（`RecentLearning.tsx:535`）；虚线边框仅 `RecentLearning.tsx:511/533`、`ImportedBooksShelf.tsx:116`、`BooksSection.tsx:149`
- **表现**：《设计语言》唯一空态配方是 `py-16` + `w-10 h-10 text-zinc-700` + 标题 + 提示；实际 6 档 padding，且有的加虚线边框、有的加 CTA 按钮、有的（句子包）纯文字。
- **影响**：空态是「新用户第一次见到的页面」，现在每个模块长得都不一样，无法形成「这里没内容，去这里开始」的稳定指引。
- **建议方向**：`EmptyState`（icon/title/hint/action 四槽）+ 只允许 `py-16`；虚线边框作为「可放置区」专用语义，不用于普通空态。

#### I-09 · P1 · 错误文案三种呈现（内联红字 / toast / 静默）
- **位置**：内联：`WordPopover.tsx:289`（`text-red-400`）、`AccountScreen.tsx:647`（内联 name error）、`PracticeScreen.tsx:217`（`placement.home.failed`）；toast：46 处 `console.error` 中仅部分补 toast（`LibrarySection`、`handleToggleFavorite` 等）；静默：见 I-01
- **表现**：同一个「接口失败」，词卡内联红字、账户页内联红字、导入书用 toast、今日用空白。
- **影响**：用户无法从「提示出现在哪」判断严重程度；内联红字在弹窗角落常被忽略。
- **建议方向**：定规则——**字段级校验用内联，操作失败用 toast，页面级加载失败用错误面板**（三选一，按层级）。

#### I-10 · P1 · Toast 生命周期与层级不受控
- **位置**：`Toaster.tsx:6`（`TOAST_TTL_MS=6000`）、`lib/toast.ts:16-25`（无去重、无上限、无暂停）、`Toaster.tsx:27`（`bottom-6 right-6`）、`BottomBar.tsx:20-21`（`fixed bottom-0 h-14 z-30`）、`OfflineIndicator.tsx:20-24`（`bottom:16px left:16px z-[95]`）
- **表现**：① 错误 toast 6 秒后消失，用户来不及读（长文案如 `describeApiError` 的后端 detail）；② 连发 5 个错误会叠 5 条；③ `bottom-6`（24px）落在高 56px 的底栏区域内——手机 toast 会盖住底栏 tab；④ 离线标记与 toast 同一底部带，窄屏必然重叠。
- **影响**：移动端最重要的两条反馈（保存失败、离线）互相遮挡；错误信息丢失后无法回看。
- **建议方向**：错误 TTL 延长/需手动关闭；`max-width` 与底栏高度联动（`bottom-[calc(56px+env(safe-area-inset-bottom)+12px)]`）；同一 `type+message` 去重。

#### I-11 · P1 · 返回控件的标签/尺寸 5 套
- **位置**：见 4.1 矩阵「返回上一级」行；另有 `App.tsx:3466`（登录页返回是 `border bg-zinc-800/60` 的按钮，全应用唯一）、`AccountScreen.tsx:299`（`h-9 px-2 -ml-2`）、`AdminConsoleScreen.tsx:879`（`ArrowLeft` + 关闭）
- **表现**：返回按钮在 `h-7 / h-8 / h-9`、`px-2 / px-2.5 / px-3`、有无文字、`-ml-1/-ml-2/-ml-3` 之间各自为政。
- **影响**：全屏页的返回是最高频控件之一，位置/大小不一致会造成误触（尤其 `-ml-1` 与 `-ml-3` 的差别让图标离屏幕左缘 8–24px 不等）。
- **建议方向**：`BackButton` 单一实现（`h-9`、`-ml-2`、`≥sm` 显示文字），子视图头部统一。

#### I-12 · P1 · 词卡 5 个 handler 复制粘贴，句子包丢来源
- **位置**：`App.tsx:288-290`（字幕）、`App.tsx:295-311`（阅读）、`App.tsx:316-332`（免费库文章）、`App.tsx:336-351`（公版书）、`App.tsx:353-368`（导入书）；`App.tsx:3162` 把**字幕版** handler 传给了 `SentenceView`
- **表现**：5 个函数体几乎逐行相同（只差 `sourceKind` 字面量）；句子精背复用了不带 source 的字幕 handler。
- **影响**：从句子包收藏的单词，`source_ref` 为空 → 单词本「出处」显示 `vocab.source.unknown`（`VocabularyBookScreen.tsx:544`）且**无法跳回原句包**（`canOpen=false`）。这是数据层的来源丢失，不是样式问题。
- **建议方向**：一个 `makeWordLookup(sourceKind, sourceId, sourceTitle)` 工厂 + 句子包传 `L<levelId>`；单词本来源解析补回跳。

#### I-13 · P1 · 游客门禁两条路径不一致（读文章）
- **位置**：`ContentScreen.tsx:250-262`（「读文章」入口直接 `onOpenReader`，**不鉴权**）vs `App.tsx:2166-2174`（`handleStartRead` 先 `requireAccount()`）；IA §7.4 第 566 行要求「进入前提示，未登录回内容页」
- **表现**：同页两个「读文章」入口：粘贴框里的模式选「读文章」会弹登录；下方蓝色「读文章」链接直接进入阅读器，游客看到居中的登录面板（`ReaderScreen.tsx:703-719`）。
- **影响**：用户被两条规则教育两遍；游客在阅读器里看到的是一个「假页面」（有头部、有返回，中间一个登录块），而不是在入口被拦住。
- **建议方向**：入口统一 `requireAccount()`（与发现页一致），阅读器内部保留登录面板作兜底。

#### I-14 · P1 · 切换内容源（视频/文章/书）的「切走」行为不一致
- **位置**：`App.tsx:1350-1366`（库视频：先 fetch 再 `enterLearn`，成功才进路由）、`App.tsx:1368-1383`（库文章：同）、`App.tsx:2152-2156`（发现：`replace` 回内容页再 `handleUrlSubmit`）、`App.tsx:1052-1072`（单词本收藏项：直接 `handleUrlSubmit`/`handleSelectEpisode` 后 `closeWordbookForJump`）
- **表现**：四种「打开新内容」分别走「先加载后跳」「先跳后加载」「先关面板再跳」，加载遮罩的文案统一是 `home.loading.loading`（"Loading…"）。
- **影响**：用户点一条内容后，有时立刻进新页（失败才弹 toast 留在原页），有时停在原页等全屏遮罩；「返回」回到的地方也因此不同。
- **建议方向**：统一「先建路由（含 loading 骨架）→ 数据到位渲染 → 失败显示页内错误 + 重试」，不用全屏遮罩。

#### I-15 · P2 · 词卡定位不处理视口边界
- **位置**：`WordPopover.tsx:229-251`（`fixed z-[80]` 全屏点击层 + `w-80` 卡片 + `style={cardPosition}`）；`App.tsx:288-290` 传 `e.clientX/e.clientY`
- **表现**：卡片宽 320px，位置直接由点击坐标推导；文件内无 `window.innerWidth` 边界夹取（对比 `ReaderScreen` 的选区浮层有边界处理）。
- **影响**：在手机右侧 1/3 处点词，词卡会超出右边缘被裁掉（横向无滚动）。
- **建议方向**：定位函数补 clamp（左右 8px、上下翻转）。

#### I-16 · P2 · 「hover 才出现」的收藏星标靠一处特例兜底
- **位置**：`TranscriptBlock.tsx:200`（`opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100`）；全仓 `@media(pointer:coarse)` 仅此 1 处；对照 `VideoPlayer.tsx:167` 的同类写法
- **表现**：字幕行的收藏星默认透明，靠 hover 或粗指针媒体查询才可见。
- **影响**：这条「触屏可达」的补丁只写在两个组件里；其他 hover 语义（`group-hover` 20+ 处）在触屏上仍是「看不见就点不到」，例如 `App.tsx:2647` 的删除按钮、`ChannelVideoList.tsx:110` 的播放遮罩。
- **建议方向**：定一条「触屏可见性」规则（`pointer:coarse` 一律常显次要操作），或改用「长按/更多菜单」。

#### I-17 · P2 · 输入模式选择用原生 `select`，全应用仅此一处
- **位置**：`StartLearning.tsx:106-119`（`<select className="appearance-none …">`）vs 其他模式切换用自定义分段控件（`App.tsx:2685` `transModeThumb`、`ReaderScreen.tsx:1013`）
- **表现**：「看视频/搜主题/读文章」三选一用原生下拉，且是今日页与内容页的**主操作**入口。
- **影响**：原生下拉在 iOS/Android 上是系统选择器（样式不可控、与其他弹层语言完全不同）；桌面端点击行为也不同于分段控件。
- **建议方向**：改为设计语言的分段控件（容器 `rounded-lg bg-zinc-800/80 p-0.5` + 滑动白色滑片），或至少为下拉加统一的自定义面板。

#### I-18 · P2 · 分页 4 套实现
- **位置**：`VocabPagination.tsx`（页码条 + 状态文案）、`RecentLearning.tsx:560-596`（上一页/指示器/下一页，`PAGE_BUTTON` 自定义）、`AbilityScreen.tsx:388-410`（用主/次按钮做上一步/下一步，无页码）、`AdminConsoleScreen.tsx:1185-1205`（offset 分页 + `PAGE_SIZE=20`）
- **表现**：一处是「页码条」，一处是「上一页/下一页 + 1/3」，一处是「步骤按钮」，一处是「offset 翻页」。
- **影响**：用户在单词本习惯页码条，到最近学习变成按钮，到管理台又是另一种；`hasMore` 与 `pages` 两种状态模型混用。
- **建议方向**：列表分页统一 `VocabPagination` 形态（页码条 + 状态），步骤型（能力自评）明确改名「上一步/下一步」不叫分页。

#### I-19 · P2 · 保存/刷新类操作反馈不统一
- **位置**：`AccountScreen.tsx:311`（刷新按钮转圈 + `toast.success`）、`AccountScreen.tsx:631`（改名：转圈 + 内联错误 + 成功 toast）、`VocabularyBookScreen.tsx` 删除收藏（无反馈）、`AdminConsoleScreen.tsx:429/567`（保存转圈）
- **表现**：同一类「提交」：有的转圈 + 成功 toast，有的转圈 + 静默，有的内联报错。
- **影响**：用户不知道操作是否生效（尤其管理台调余额/封禁这类高风险动作）。
- **建议方向**：写操作统一「按钮内转圈 + 成功 toast + 失败 toast/内联错误」三件套。

#### I-20 · P2 · 无平台返回键/手势的兜底差异
- **位置**：`useNav.ts:117`（`canGoBackRef = Boolean(parsed.sub) && window.history.length > 1`）、`useNav.ts:128-130`（`go()` 用 replace）
- **表现**：安卓硬件返回键在子视图内有效（走 `hashchange`），但在一级 tab 页按返回会直接离开应用（tab 切换是 replace，不堆历史）；iOS 边缘手势同样离开。
- **影响**：用户在一级页误触返回 → 直接退出应用（Web/PWA 上表现为回到上一站点或空白页）。
- **建议方向**：一级页拦截一次 `popstate` 显示「再按一次退出」或直接 `pushState` 占位（仅在 standalone/PWA 下）。

---

## 5. 类别三 · 跳转混乱

### 5.1 路由 / 跳转表（canonical 27 条）

> 「返回落点」= 点页面内返回（`back()`）后用户实际看到的页面；「刷新」= 深链刷新能否恢复；「问题」列对应条目 ID。

| hash | 组件 | 归属 tab（`parseRoute`） | 入口 | 返回落点 | 刷新 | 问题 |
|---|---|---|---|---|---|---|
| `#/today` | `TodayScreen` | today | 底栏/侧栏/logo | — | ✓ | N-17 |
| `#/content` | `ContentScreen` | content | 同上 | — | ✓ | V-16 |
| `#/practice` | `PracticeScreen` | practice | 同上 | — | ✓ | — |
| `#/profile` | `AccountScreen isPage` | profile | 顶栏头像/侧栏 | — | ✓ | V-15 |
| `#/today/review`、`#/practice/review` | `ReviewScreen` | 前缀 tab | 今日复习卡、练习主卡 | `back()` | 回入口、不恢复进度 | N-03 |
| `#/today/report`、`#/profile/report` | `ReportScreen` | 前缀 tab | 今日报告卡、我的行、**内容页右栏** | `back()` | ✓ | **N-02** |
| `#/practice/placement[?view=profile]` | `PlacementScreen` | practice | 今日定位条、练习行、能力页 | `back()` | 回入口 | N-12 |
| `#/practice/exam` | `ExamScreen` | practice | 练习卡 | `back()` + 统计刷新 | 回入口、草稿由后端复用 | — |
| `#/content/discover` | `DiscoverScreen` | content | 内容页、粘贴框搜索模式 | `back()` | 回入口；`sessionStorage` 缓存结果 | I-13 |
| `#/content/reader[/<articleId>]` | `ReaderScreen` | content | 内容页、粘贴框读文章、单词本来源、今日最近学习 | `back()` / 内部「返回列表」 | ✓（列表状态不恢复） | I-13、N-08 |
| `#/content/sentences/<levelId>` | `SentenceView` | content | 内容页、侧栏快捷、单词本来源 | `back()` | ✓ | N-11（非法 id 静默回今日） |
| `#/content/blog[/<slug>]` | `BlogScreen` | content | 内容页页脚、我的行 | `back()` | 列表 ✓；**文章不恢复** | **N-01** |
| `#/content/book/<bookId>` | `BookReaderScreen` | content | 内容页书架、书系页、单词本、今日 | `back()` | ✓ | — |
| `#/content/book-series/<seriesId>` | `BookSeriesScreen` | content | 内容页书架、书阅读器 | `back()` | ✓ | N-07 |
| `#/content/imported-book/<bookId>` | `ImportedBookReaderScreen` | content | 内容页书架、今日、单词本 | `back()` | ✓ | — |
| `#/learn/youtube/<videoId>` | 学习页 | **content（强制）** | 今日粘贴、内容页、频道更新、最近学习 | `back()` | 仅缓存存在；否则 toast + 回内容页 | **N-04** |
| `#/learn/local/<showId>/S<ss>E<ee>` | 学习页 | content（强制） | 内容页剧集、最近学习 | `back()` | 同上 | N-05 |
| `#/learn/library/<itemId>` | 学习页 / `LibraryArticleReader` | content（强制） | 内容页免费库 | `back()` | ✓（公开只读） | N-09 |
| `#/lesson/<lessonId>` | `CourseScreen` | **today（强制）** | 今日课程卡/小说卡、视频页生成 | `back()` | ✓ | **N-04** |
| `#/profile/vocabulary` | `VocabularyBookScreen` | profile | 顶栏、侧栏、学习页头部、我的行、`favorites` 别名 | `back()` | ✓ | N-10 |
| `#/profile/ability` | `AbilityScreen` | profile | 我的行、定位结果 | `back()` | ✓ | — |
| `#/profile/admin` | `AdminConsoleScreen` | profile | 我的·管理员行、`#admin`、`/admin` | `back()` | 500ms 守卫 | N-14 |
| `#/welcome` | `WelcomeScreen` | — （框架外） | 空 hash、登录页返回 | — | ✓ | N-15 |
| `#/login` | `LoginView` → `AuthScreen` | — | 欢迎页 CTA | 固定返回链接 | 登录后重写 `#/today` | N-15 |
| `#admin`（别名） | 同上 | profile | 旧书签 | `back()` | 规范化 | — |
| `/admin`（路径） | 同上 | profile | 旧书签 | `back()` | 500ms + 重写 | N-14 |
| `#/profile/favorites`（别名） | 单词本 | profile | 旧书签 | `back()` | 重写为 vocabulary | — |
| `#/content/library`（别名） | 内容页 | content | 旧书签/分享 | — | **`/library` 被丢弃** | **N-06** |

### 5.2 问题清单

#### N-01 · **P0** · 博客文章深链失效（slug 建模了但没接）
- **位置**：`lib/nav.ts:220-222`（`parseRoute` 解析 slug）、`lib/nav.ts:310`（`toHash` 输出 slug）、`App.tsx:3169`（渲染 `<BlogScreen onClose=… />`，**没有传 slug**）、`BlogScreen.tsx:259-300`（文章选择是组件内部 `selectedSlug` state）
- **表现**：`#/content/blog/hello-world` 打开的是博客列表；在列表里点开文章，URL 不变；此时刷新回到列表；把文章链接发给别人，对方看到的是列表。
- **影响**：博客是唯一对外可分享的内容页（`content/blog/*.md`，且页脚有 RSS），分享链接全部失效；浏览器后退从文章直接退出博客而不是回列表。
- **建议方向**：`BlogScreen` 接受 `initialSlug` 并在 `onOpen` 时 `replace({kind:'blog',slug})`，列表↔详情双向映射 URL（`replace` 不堆历史）。

#### N-02 · **P0** · 从「内容」页打开报告/复习，底层 tab 被静默改写
- **位置**：`App.tsx:2061-2064`（`handleOpenReport` → `openSub({kind:'report'})`）、`lib/nav.ts:144-145`（`tabForSub('report', currentTab)`：currentTab 不在 {today,profile} 时返回 'today'）、`ContentScreen.tsx:363-371`（内容页右栏「本周报告」入口）、`lib/nav.ts:142-143`（review 同理，回落到 'practice'）
- **表现**：在「内容」页点右栏「本周报告」，URL 变成 `#/today/report`（tab 从 content 变 today）；关闭报告后落在「今日」页。
- **影响**：用户明确从「内容」出发，回来却在「今日」——导航模型「返回入口」的承诺被破坏；`tabForSub` 的注释说「remember the entry page」，但只对 today/profile 生效。
- **建议方向**：`report`/`review` 增加 `content` 前缀（`#/content/report`），或让 `tabForSub` 在 `currentTab` 为任意 tab 时保持该 tab（`parseRoute` 同步接受前缀）。

#### N-03 · **P0** · 子视图互跳后「返回」越过一层
- **位置**：`lib/useNav.ts:55-69`（`replace` 分支只在新 state 无 sub 时清 `canGoBackRef`，否则**保持原值**）、`App.tsx:1001-1004`（`openSub` 在已有 sub 时走 `replace`）、`App.tsx:3101`（报告页「去复习」→ `handleOpenReview`）
- **表现**：今日 → 本周报告（push，`canGoBackRef=true`）→ 点「去复习」（replace 成 review，`canGoBackRef` 仍 true）→ 复习页点返回 → `history.back()` → 回到**打开报告之前**的页面（今日），而不是报告。
- **影响**：返回跳过一个用户明确前往过的页面，方向感丢失；同样的链路出现在「单词本→文章→包」「报告→证据→视频」等所有 sub→sub 跳转。
- **建议方向**：`replace` 到一个新的 sub 时重置 `canGoBackRef=false`（并在 `commit` 里记录「当前 entry 是替换来的」），或在 sub→sub 时改为 push（栈深允许 2）。

#### N-04 · P1 · `#/learn/*` 与 `#/lesson/*` 丢失来源 tab（往返不对称）
- **位置**：`lib/nav.ts:103-107`（`tabOfSub('learn')='content'`）、`lib/nav.ts:138-141`（`tabForSub('learn', currentTab)=currentTab`）、`lib/nav.ts:246-251`（`parseRoute` 强制 `tab:'content'`）、`lib/nav.ts:240-242`（`#/lesson` 强制 `today`）、`App.tsx:1006-1009`
- **表现**：从「今日」打开视频，state 是 `{tab:'today', sub:learn}`，但 `toHash` 只输出 `#/learn/youtube/x`（tab 丢失）；刷新后 `parseRoute` 得到 `{tab:'content'}`；此时点「返回」→ 落在「内容」页而不是「今日」。
- **影响**：这是 IA §7.2 明示的取舍（「归属 tab：content（兜底）」），但对用户是「刷新一下返回就换了地方」；同时 `toHash(parseRoute(h))` 稳定而 `parseRoute(toHash(s)).tab ≠ s.tab`，两个纯函数不再互逆（A3 的导航模型必须解释）。
- **建议方向**：要么把来源 tab 写进 URL（`#/learn/...#from=today` 或 `#/today/learn/...`），要么在返回时用 `sessionStorage` 记录来源 tab；文档里明确「刷新后返回 content」是已知行为，并在返回按钮上加 tooltip。

#### N-05 · P1 · 本地剧集深链缺缓存时的落点与 IA 契约不符
- **位置**：`lib/nav.ts:254-262`（解析）、`App.tsx:1414-1432`（无缓存 → `toast.info(nav.cacheMiss)` + `replace({tab:'content'})`）；IA §7.2 第 527 行要求「无缓存 → 停在『开始/确认』态，不自动处理」
- **表现**：打开一个没有缓存的 `#/learn/local/show/S01E02`，用户被弹回内容页并看到一条 toast；「开始/确认」态不存在了（`resetLearning` 已把该状态删除）。
- **影响**：用户以为链接坏了；且 toast 6 秒即消失，之后无法得知发生了什么。
- **建议方向**：无缓存时渲染一个「该剧集尚未处理，是否现在开始？」的页面态（复用学习页壳 + 说明 + 主按钮），而不是回退 + toast。

#### N-06 · P1 · `#/content/library` 被静默丢弃（分享/书签入口失效）
- **位置**：`lib/nav.ts:234-236`（`library` 段被当作「内容页、无子路由」返回 `sub:null`）、`lib/useNav.ts:106-116`（hash 与 canonical 不一致时 `replaceState` 修正）、`App.tsx:2254`（侧栏「免费库」走 `openPageAnchor('content-library')`，与 URL 无关）
- **表现**：打开 `#/content/library`，地址栏被改写成 `#/content`，页面停在第 1 屏（不会滚到免费库）；同一功能的侧栏入口依赖 `setTimeout` 重试 12 次去 `scrollIntoView`。
- **影响**：任何指向免费库的深链/书签都失效；锚点导航无 URL 表达，刷新丢位置。
- **建议方向**：给区块锚点正式路由（`#/content/library` → 渲染内容页并 `scrollIntoView`，或独立 `#/learn/library` 列表页）；`openPageAnchor` 的时间轮询改为路由参数驱动。

#### N-07 · P1 · 书系 ↔ 书阅读器可递归，返回语义不清
- **位置**：`App.tsx:3176`（书 → `openSub({kind:'book-series'})`）、`App.tsx:3186`（书系 → `openSub({kind:'book'})`）、`App.tsx:1001-1004`（都是 replace）
- **表现**：书 → 书系 → 另一本书 → 书系… 每次 replace，URL 只保留最后一层；点返回一律回到「内容页」。
- **影响**：三层下来用户已经不知道自己怎么进来的；返回没有「一层层退」的可能（栈深被强制为 1）。
- **建议方向**：书系作为「上级」用 push（栈深 2 允许），或去掉书系入口改在书内联展示同系列。

#### N-08 · P1 · 阅读器/博客/发现的内部层级不写 URL
- **位置**：`ReaderScreen.tsx:235`（`selectedId` 局部 state）、`BlogScreen.tsx:259`（`selectedSlug`）、`DiscoverScreen.tsx:133`（query 存 `sessionStorage` 而非 URL）
- **表现**：在阅读器里点开第二篇文章、在博客里点开文章，URL 都不变；刷新回列表；后退退出整个模块。
- **影响**：与 N-01 同源；「深链刷新异常」的典型：用户看文章看到一半刷新，回到列表并丢失阅读位置（进度虽存后端，但当前文章需要重找）。
- **建议方向**：三处内部层级都映射到路由（`reader/<id>` 已有，只是没在用；`blog/<slug>` 已建模）。

#### N-09 · P2 · 免费库文章的「关闭」与返回落点不一致
- **位置**：`LibraryArticleReader.tsx:71`（`onClose` → `App.tsx:1385-1387` → `back()`）；`App.tsx:3067-3075`（`sub.kind==='learn'` 且 `libraryArticle` 时渲染 `LibraryArticleReader`）
- **表现**：免费库文章和视频共用 `#/learn/library/<id>`，但视频页返回后是内容页，文章页返回也是内容页——行为一致 ✓；然而文章的「返回」在视觉上和学习页的 `LearningHeader` 完全不同（无单词本/PiP/标题区）。
- **影响**：两个「同一路由的两个渲染分支」长得像两个页面；用户从视频和文章进入同一 URL 形状，得到的 chrome 不同。
- **建议方向**：`LibraryArticleReader` 复用 `LearningHeader`（标题=文章标题，feature label=免费资源）。

#### N-10 · P2 · 单词本入口有 4 处，计数格式不一致
- **位置**：`AppShell.tsx:189`（`wordbookCount > 99 ? '99+' : wordbookCount`）、`LearningHeader.tsx:71`（原始数字，**无 99+ 上限**）、`Sidebar.tsx`（`renderCount`）、`AccountScreen.tsx:325`（行内）
- **表现**：同一个计数在四个入口的格式化规则不同；学习页头部的胶囊在三位数时会被撑宽。
- **影响**：数字对不上（用户以为数据错了）；窄容器溢出。
- **建议方向**：`formatCount` 单一来源（`99+`），四个入口共用。

#### N-11 · P2 · 非法路由静默回落，无任何反馈
- **位置**：`lib/nav.ts:159-174`（空/非法 → `FALLBACK today`）、`lib/nav.ts:217-218`（`sentences` 非法 levelId → FALLBACK）、`lib/nav.ts:186-190`（`#/practice/report` → FALLBACK）
- **表现**：输入 `#/content/sentences/0`、`#/practice/report`、`#/nonsense`，都静默跳到「今日」，地址栏同步改写。
- **影响**：用户（尤其从旧文档/旧截图点进来）以为「功能没了」；开发者排查时也看不到任何线索。
- **建议方向**：非法 hash → 今日 + 一次性 toast「链接无效，已回到今日」；`#/practice/report` 这类「合理但未支持」的前缀直接支持。

#### N-12 · P2 · 定位页两种入口落在同一路由、返回落点不同
- **位置**：`App.tsx:2031-2033`（`openSub({kind:'placement', view})`）、`lib/nav.ts:111-113`（`tabOfSub('placement')='practice'`，但 `tabForSub` 走 default → 同样 'practice'）、`App.tsx:3119`（能力页「去定位」）
- **表现**：从「今日」定位条进入 → URL `#/practice/placement`（tab 变 practice）；关闭后回到「练习」而不是「今日」。
- **影响**：与 N-02 同一类问题（来源 tab 丢失），只是这次落在 practice；用户会发现「我明明在今日点的」。
- **建议方向**：与 N-02 一并处理（支持 `#/today/placement` 或返回来源 tab）。

#### N-13 · P2 · 三个旧别名靠「改地址」维持，无提示
- **位置**：`lib/nav.ts:191-195`（`favorites` → `vocabulary`）、`lib/nav.ts:234-236`（`library` → 无子路由）、`App.tsx:2324-2341`（`/admin` 路径 500ms 后重写）
- **表现**：旧书签能用，但地址被静默改写；`/admin` 有 500ms 空白等待（`App.tsx:2332-2339`）。
- **影响**：老用户以为收藏页改名是 bug；`/admin` 的 500ms 在慢网下更长（再叠加 auth loading）。
- **建议方向**：别名保留但加「保留兼容」注释 + 在 404/落点页给一次提示；`/admin` 守卫改为「auth ready 即判定」而非固定 500ms。

#### N-14 · P2 · 管理台守卫的双重延迟（500ms × 2）
- **位置**：`App.tsx:2304-2319`（sub 守卫 500ms）、`App.tsx:2324-2341`（path 守卫 500ms）、`App.tsx:2886-2902`（admin 分支在 `isAdmin` 前渲染 spinner）
- **表现**：书签 `/admin` 时先等 path 守卫 500ms，再进 `#/profile/admin` 又等 500ms。
- **影响**：管理员打开书签要 1 秒以上看白屏转圈；非管理员要等 1 秒才被弹回并收 toast（toast 还可能和后续请求的 toast 打架）。
- **建议方向**：以 `status==='authenticated' && isAdmin!==undefined` 为条件同步判定，取消固定 timer。

#### N-15 · P2 · 公开页与主应用的边界不一致
- **位置**：`App.tsx:3428-3454`（`readPublicView`）、`App.tsx:3496-3511`（空 hash → `#/welcome`；登录后重写 `#/today`）、`App.tsx:3513-3517`（`status==='anonymous'` 时**忽略 hash** 直接渲染 `AuthScreen`）
- **表现**：`anonymous` 状态下访问 `#/content/discover` 会看到登录页但地址栏仍是 `#/content/discover`；登录成功后直接进 `#/today`（丢弃原目标）。
- **影响**：地址栏与实际界面不符；用户原本想去的页面在登录后不会被带到（与 §7.4「进入前提示」的意图相反）。
- **建议方向**：`anonymous` 时把 hash 存为 `redirect`，登录后 `replace` 回原目标（`#/login?next=` 或内存 ref）。

#### N-16 · P2 · 切 tab 总回到顶部，「回顶」语义出现两种
- **位置**：`App.tsx:1011-1020`（`navigateTab`：同 tab 且无 sub → `scrollTo({top:0})`；否则 `go(tab)`）、`lib/useNav.ts:128-130`（`go` → replace）、`App.tsx:3218-3293`（`switch (state.tab)` 只渲染当前页组件，离开即卸载）
- **表现**：点**当前** tab 是「平滑回顶」；切到别的 tab 再切回来，页面是重新挂载的，滚动位置直接归零（无过渡、无恢复）。内容页有 9 个区块、今日页有最近学习长列表，这条差异每次切 tab 都会被感知。
- **影响**：用户在内容页读到「免费库」位置，去「今日」看一眼再回来，要重新滚一遍；而「点当前 tab 回顶」的平滑动画又暗示了「位置是可管理的」，两种行为互相矛盾。
- **建议方向**：为一级页按 tab 记录 `scrollTop`（`sessionStorage` 或 `useRef` map），切回时恢复；「回顶」只保留给当前 tab 的主动点击。

#### N-17 · P2 · 非任务子视图在桌面同时有「侧栏」和「页内返回」两套出口
- **位置**：`App.tsx:125-136`（`TASK_SUB_KINDS` 只含 learn/reader/book/book-series/imported-book/sentences/review/exam/placement/course，**不含 blog/discover/report/vocabulary/ability（admin 独立壳）**）、`AppShell.tsx:93-110`（`!isTask` 时渲染 Sidebar）、`AppShell.tsx:159-163`（`!isTask` 时渲染 TopBarTabs）、`BlogScreen.tsx:342`、`VocabularyBookScreen.tsx:560`、`DiscoverScreen.tsx:263`、`ReportScreen.tsx:157`
- **表现**：任务型子视图（视频/阅读器/复习/考试）隐藏侧栏与 tab，只有页内返回；面板型子视图（博客/发现/报告/单词本/能力）保留侧栏 + 四个 tab，**同时**页内还有一个 `ArrowLeft` 返回。
- **影响**：同一「子视图」在桌面上有两种导航人格：一种是沉浸式（必须用页内返回），一种是与一级页几乎无差别（侧栏 tab 仍可点）。用户无法从界面判断「我现在是不是在一个子页面里」；也让「子视图栈深 = 1」的规则在桌面上看起来不成立。
- **建议方向**：二选一并写进 A3——① 面板型子视图也隐藏侧栏（与任务型一致）；② 保留侧栏但去掉页内返回（侧栏即出口），并在顶栏用面包屑表达层级。

#### N-18 · P1 · 单词本跳到内容后，「返回」落在「我的」而不是单词本
- **位置**：`App.tsx:1046-1050`（`closeWordbookForJump`：`replace({tab:'profile', sub:null})`）、`App.tsx:1052-1072`（`handlePlayFavorite` 末尾调用）、`App.tsx:2182-2202`（`handleOpenFavoriteArticle` / `handleOpenFavoriteLibraryArticle` / `handleOpenFavoriteSentencePack` 均先 `closeWordbookForJump()` 再 `openSub(...)`）
- **表现**：在单词本点一条来源（文章/视频/句包）→ 单词本那一层被 **replace** 成「我的」→ 新内容再 push 上去。点「返回」→ `history.back()` → 回到 `#/profile`（我的页），**不是单词本**。
- **影响**：这是单词本最主要的闭环（存词 → 回原文），返回时却回到「我的」，用户要先重新进入单词本、再翻回那一页；与 IA §7.3「子视图之间互跳按替换处理」的意图（替掉旧子视图、保留入口）正好相反——它把**入口页**也一起替掉了。
- **建议方向**：`closeWordbookForJump` 改成「若当前是单词本 → 先 `back()` 回入口 tab，再 push 目标」或直接让单词本→内容的跳转复用 `openSub`（replace 当前 sub，tab 归属用 `tabForSub`），保证返回能回到单词本。

---

## 6. 类别四 · 组件重复

### 6.1 重复映射表

| 功能 | 实现清单（文件:行） | 差异 |
|---|---|---|
| **主按钮** | `AccountScreen.tsx:88`、`AdminConsoleScreen.tsx:91`、`AbilityScreen.tsx:68`、`ReaderScreen.tsx:145`、`ShareCardDialog.tsx:44`、`PwaInstallButton.tsx:124`、`WelcomeScreen.tsx:43`、`ReviewScreen.tsx:107`、`PlacementScreen.tsx:70`、`QuizScreen.tsx:35`、`ExamScreen.tsx:86`、`CourseScreen.tsx:75`、`ModelSelectionModal.tsx:183`、`StartLearning.tsx:199`、`AuthScreen.tsx:252`、`InputScreen.tsx:353`（死代码） | 高度 `h-10` vs `h-11` vs `h-12`；横向 `px-4` vs `px-5` vs `px-6`；圆角 `rounded-xl` vs `rounded-full`；禁用态 `opacity-50` vs `opacity-40`；`disabled:active:scale-100` 有无；transition 属性列表 3 种 |
| **次按钮** | `AccountScreen.tsx:89`、`AdminConsoleScreen.tsx:92`、`AbilityScreen.tsx:69`、`PlacementScreen.tsx:71`、`ExamScreen.tsx:87`、`ReviewScreen.tsx:108`、`CourseScreen.tsx:76`、`BlogScreen.tsx:43`、`ReportScreen.tsx:74`、`VocabularyBookScreen.tsx:138` | `h-9 px-3` vs `h-9 px-4` vs `h-10 px-4` vs `h-11 px-5` vs `h-10 sm:h-11 px-4 sm:px-5`；`text-sm` vs `text-xs`；`disabled:pointer-events-none` 有无 |
| **幽灵按钮** | `PlacementScreen.tsx:73`、`ExamScreen.tsx:89`、`AbilityScreen.tsx:71` | `h-11 px-5` / `h-10 px-4` / `h-9 px-3` 三档，其余相同 |
| **卡片（CARD 常量）** | `VocabularyBookScreen.tsx:142`、`PlacementScreen.tsx:75`、`ReportScreen.tsx:73`、`WelcomeScreen.tsx:38`、`ExamScreen.tsx:91`、`AbilityScreen.tsx:65`、`TodayWorkbench.tsx:68`、`PracticeScreen.tsx:15`、`CourseScreen.tsx:78`、`LibrarySection.tsx:47`、`BooksSection.tsx:34`、`HomeRecommendations.tsx:21`、`ImportedBooksShelf.tsx:25` | `rounded-2xl` vs `rounded-3xl` vs `rounded-2xl sm:rounded-3xl`；`bg-zinc-900/40` vs `/30`；padding `p-3.5 sm:p-5` vs `p-4 sm:p-5`；是否带 `min-w-0`/`flex flex-col` |
| **内联卡片字面量** | `grep 'rounded-2xl border border-white/5 bg-zinc-900/40'` = 40 处、`rounded-3xl …` = 21 处、`bg-zinc-900/30` 9 处 | 与上表 12 个常量并存 → 同一视觉语义 **52 处** |
| **弹窗壳** | `ModelSelectionModal.tsx:53`、`LanguageSettingsModal.tsx:99`、`BookImportDialog.tsx:122`、`ShareCardDialog.tsx:195`、`ChannelVideoList.tsx:68`、`AbilityScreen.tsx:252`、`ExamScreen.tsx:1235`、`PlacementScreen.tsx:1402`、`AdminConsoleScreen.tsx:282`、`PwaInstallButton.tsx:70`、`EstimateDialog.tsx:87`、`App.tsx:3387`（ProcessingOverlay）、`App.tsx:3522`（guest overlay） | 遮罩 `bg-zinc-950/70` vs `/85` vs 无；面板 `bg-zinc-900/90` vs `/95`；圆角 `rounded-2xl` vs `rounded-t-2xl`（底部弹层）；Escape / role / 焦点陷阱 / 点击遮罩 各缺一部分；动效 `framer` vs `animate-[fadeIn]` |
| **Toast/通知** | `Toaster.tsx`（唯一 toast）+ 内联错误 5 处 + `window.confirm` 4 处 + `resume-banner`（`App.tsx:3326-3351`）+ `OfflineIndicator.tsx` | 通知共有 4 种承载（浮层/内联/原生/横幅），样式与消失规则各不同 |
| **单词卡/词条** | `WordPopover.tsx`（浮层词卡）、`TranscriptBlock.tsx:95-105`（ruby 注释）、`SentenceText.tsx:27-36`（第二套 ruby）、`BilingualRow.tsx` + `ReadingHighlight.tsx`（阅读高亮） | 两套 ruby 渲染（`rt` 颜色/字号不同）、两套可点词（`ClickableWords` vs 自定义 `span`） |
| **导航栏** | `Sidebar.tsx`、`TopBarTabs.tsx`、`BottomBar.tsx`、`AppShell.tsx` | 3 个可达性实现 + 4 套徽章：`TopBarTabs.tsx:44`（`min-w-[16px] h-4 text-[9px]`）、`Sidebar.tsx:183`（同上，复制）、`BottomBar.tsx:45`（`min-w-[18px] h-[18px] text-[10px]`）、`VocabularyBookScreen.tsx:611`（`min-w-[18px] px-1.5 py-0.5 text-[10px] bg-white/10`） |
| **分段控件** | `App.tsx:2675`（译文模式）、`ShowBrowser.tsx:148`（季选择）、`AdminConsoleScreen.tsx:932`（后台 tab）、`AuthScreen.tsx:118`（登录/注册）、`SentenceView.tsx:113`（级别）、`ReaderScreen.tsx:752`（导入模式）、`ReaderScreen.tsx:1003`（译文）、`LanguageSettingsModal.tsx:40`（语言） | 选项度量 4 种：`px-2.5 py-1 text-xs`（符合设计）/`px-3 py-1.5 text-sm`/`px-3 py-1.5 text-xs`/`px-2.5 py-1.5 text-xs`；容器 `rounded-lg bg-zinc-800/80` vs `rounded-xl bg-zinc-900/60` vs `rounded-lg bg-zinc-900/40`；选中态「白滑块」vs「白实底」 |
| **页签（tablist）** | `VocabularyBookScreen.tsx:574-622`（pill 底）、`LibrarySection.tsx:317-352`（白实底、无滑块）、`AdminConsoleScreen.tsx:932`（白滑块）、`TopBarTabs.tsx:49-55`（下划线） | 同一「tab」语义 4 种视觉语言；`role="tabpanel"` 全仓 0 个、`aria-controls` 2 个 |
| **分页** | `VocabPagination.tsx`、`RecentLearning.tsx:560-596`、`AbilityScreen.tsx:388-410`、`AdminConsoleScreen.tsx:1185-1205` | 见 I-18 |
| **时间格式化** | `App.tsx:158` `formatClock`、`ReportScreen.tsx:81`、`QuizScreen.tsx:39`、`TranscriptBlock.tsx:137`（内联）、`LocalEpisodeStage.tsx:32`、`TeachingNotesPanel.tsx:30`；倒计时变体 `CourseScreen.tsx:82`、`PlacementScreen.tsx:105` | 7 份相同实现 + 2 份 `ceil` 变体；均无 `>1h` 处理（`mm:ss` 到 60 分钟会显示 `60:00`） |
| **空态** | 见 I-08（8 处 `py-16` 中的 3 处实现出 CTA/虚线/无图标变体） | — |
| **搜索框** | `SentenceView.tsx:154`（`h-7 pl-8 pr-3 text-xs`）、`DiscoverScreen.tsx:299`、`AccountScreen.tsx:620`、`VocabularyBookScreen.tsx:921`、`BookImportDialog.tsx:192`（`h-10 rounded-xl`） | 高度 28/36/40、圆角 2 档、placeholder 颜色 `text-zinc-600` vs `placeholder-zinc-500` |
| **死代码** | `InputScreen.tsx`（598 行，**全仓无 import**，grep 确认） | 旧的「粘贴链接」整页实现，已被 `StartLearning` + `TodayWorkbench` 取代，仍带 `id="video-url"` 与 `window.confirm`，会误导后续开发者 |

### 6.2 问题清单

#### C-01 · P1 · 按钮 4 类 × 12 份常量 + 52 处内联卡片
- **位置**：见 6.1「主按钮/次按钮/幽灵按钮/卡片」行
- **表现**：`PRIMARY_BUTTON` 在 12 个文件里各定义一次（`h-10`/`h-11`/`h-12` 三种高度），`CARD` 在 12 个文件 + 52 处字面量。
- **影响**：任何按钮视觉调整要改 12+ 处且必然漏；「同屏两个主按钮高度不同」已经发生（`PlacementScreen` 的 `h-11` 主按钮紧邻 `h-9` 次按钮）。
- **建议方向**：A4 按「主/次/着色/幽灵/图标」五类各一个组件（含 loading/disabled 状态），删除全部常量。

#### C-02 · P1 · 弹窗 13 个实现，能力集不一致
- **位置**：见 6.1「弹窗壳」行
- **表现**：13 个「浮层」各自实现遮罩、圆角、动效、关闭方式；`Escape` 覆盖 12 个文件、`role` 覆盖 9 个、焦点陷阱 0 个、滚动锁 0 个。
- **影响**：每新增一个弹窗就多一次「漏掉无障碍」的机会；现有 3 个已经漏了 role。
- **建议方向**：`Dialog`（桌面居中/移动底部弹层两形态）+ `Sheet` 两个组件覆盖全部；`ConfirmDialog` 覆盖 `window.confirm`。

#### C-03 · P1 · 5 个点词 handler 复制（含数据缺陷）
- **位置**：`App.tsx:288-368`
- **表现**：5 个 `useCallback` 结构相同，仅 `sourceKind` 不同；第 5 处（句子包）复用了第 1 处导致来源丢失。
- **影响**：见 I-12（单词来源丢失、无法回跳）。
- **建议方向**：工厂函数 + 类型化 `WordLookupSource`，句子包传 `{kind:'sentence_pack', ref:'L<levelId>'}`。

#### C-04 · P1 · 两套 ruby 高亮渲染
- **位置**：`TranscriptBlock.tsx:51-105`（`HighlightedText`，`rt text-[10px] text-purple-300/90`）vs `SentenceText.tsx:27-36`（`rt text-[10px] text-zinc-400/90`，`font-semibold` 语块）
- **表现**：同一「生词/语块上方注中文」的交互，两套实现、两种 `rt` 颜色、两种可点范围（整块 vs 单词）。
- **影响**：用户在字幕里学到的「点词」规则，到句子包变成「点整块」；颜色也在变（紫 vs 灰）。
- **建议方向**：`WordHighlight` 单一组件，注释色与交互范围由参数控制。

#### C-05 · P1 · 4 套 tab 视觉语言
- **位置**：`TopBarTabs.tsx:33-55`（下划线滑块）、`VocabularyBookScreen.tsx:607-620`（pill 底）、`LibrarySection.tsx:317-352`（白实底）、`AdminConsoleScreen.tsx:932-951`（白滑块）
- **表现**：同为「一组互斥选项」，选中态分别是下划线、淡色 pill、实心白、白色滑块。
- **影响**：用户无法把「tab」识别为同一种控件；尤其 `LibrarySection` 的白实底与 `AdminConsole` 的白滑块在同一产品里都叫 tab。
- **建议方向**：导航级（TopBar）用下划线，内容级用「白滑块」；LibrarySection/VocabularyBook 收敛到白滑块。

#### C-06 · P1 · 分段控件 4 种度量
- **位置**：见 6.1「分段控件」行（8 个实现）
- **表现**：设计语言已给唯一配方（容器 `rounded-lg bg-zinc-800/80 p-0.5`、选项 `px-2.5 py-1 text-xs`、白色滑块 `layoutId` + 弹簧 420/36），实际 4 种选项度量、3 种容器。
- **影响**：同一屏（阅读器工具栏）里两个分段控件（导入模式 + 译文）高度和字号不同——`ReaderScreen.tsx:752` 用 `text-xs px-3 py-1.5`，`ReaderScreen.tsx:1003` 用 `text-xs px-2.5 py-1`。
- **建议方向**：`Segmented` 组件（`items/value/onChange/layoutId`），8 处替换。

#### C-07 · P1 · 4 套徽章尺寸/字号
- **位置**：`TopBarTabs.tsx:44`、`Sidebar.tsx:183`（`min-w-[16px] h-4 text-[9px]`）、`BottomBar.tsx:45`（`min-w-[18px] h-[18px] text-[10px]`）、`VocabularyBookScreen.tsx:611`（`min-w-[18px] px-1.5 py-0.5 text-[10px]`）
- **表现**：同一「计数徽章」在顶栏/侧栏/底栏/单词本各一个尺寸；`text-[9px]` 低于任何可读下限。
- **影响**：数字看不清（9px 在 375px 宽的手机上约 2.4mm 高）；徽章在收缩侧栏里会顶到图标。
- **建议方向**：`CountBadge`（sm 16/9px→改 10px、md 18/11px），4 处共用。

#### C-08 · P1 · 7 份 `formatClock` + 2 份倒计时
- **位置**：`App.tsx:158-163`、`ReportScreen.tsx:81-86`、`QuizScreen.tsx:39-44`、`TranscriptBlock.tsx:137-140`、`LocalEpisodeStage.tsx:32-35`、`TeachingNotesPanel.tsx:30-35`、`CourseScreen.tsx:82-87`、`PlacementScreen.tsx:105-110`、`ExamScreen`（倒计时复用）
- **表现**：逐字复制的 `mm:ss`；`>1h` 全部输出 `60:00` 以上（不影响，但不一致的风险点）。
- **影响**：一处要改（如加 `h:mm:ss` 支持直播/长视频）就要改 9 处。
- **建议方向**：`lib/time.ts`（`formatClock`、`formatCountdown`、`formatDuration`）唯一来源。

#### C-09 · P1 · `cn()` 与 `bilingualReadingWidth()` 放错层
- **位置**：`TranscriptBlock.tsx:11-13`、`BilingualRow.tsx:16-17`
- **表现**：基础设施函数住在业务组件里，被 4 个文件反向依赖；全仓只有 4 个文件用 `cn`，其余 58 个拼模板字符串。
- **影响**：类名冲突（如 `p-2` + `p-4`）无法被 `tailwind-merge` 自动消解；`package.json` 里的 `clsx`/`tailwind-merge` 依赖只为这 4 个文件服务。
- **建议方向**：`lib/cn.ts`、`lib/reading-layout.ts`；新代码强制用 `cn`。

#### C-10 · P2 · 两套「快速输入」组件并存（其中一套是死代码）
- **位置**：`StartLearning.tsx`（现用，primary/compact 两 variant）、`InputScreen.tsx`（598 行，无 import）、`TodayWorkbench.tsx`（内部注释仍指向 InputScreen）
- **表现**：旧的整页粘贴组件未删，仍占 598 行并含 `window.confirm`、`id="video-url"` 重复实现。
- **影响**：后来者会照抄旧实现；`id="video-url"` 在两个文件里各有一个（`StartLearning.tsx:125/139` 与 `InputScreen.tsx:338`），`document.getElementById` 的未来使用者可能拿错。
- **建议方向**：删除 `InputScreen.tsx`（A4 第一步，零风险）。

#### C-11 · P2 · 两套列表行样式
- **位置**：`ContentScreen.tsx:292`（`p-2.5 rounded-xl bg-zinc-800/30 hover:bg-zinc-800/60 border`）、`ContentScreen.tsx:474`（同配方）、`RecentLearning.tsx:326`（`rounded-xl bg-zinc-900/40` 行）、`ShowBrowser.tsx:116`（`p-3 rounded-xl bg-zinc-800/30`）
- **表现**：设计语言给了「列表行」唯一配方（`p-3 rounded-xl bg-zinc-800/30 …`），实际 3 种底（`/30`、`/40`、`/60`）+ 2 种 padding。
- **影响**：右栏卡片与列表行在滚动时对比度不一，悬停反馈强弱不同。
- **建议方向**：`ListRow` 组件（可选 trailing/meta），统一 `p-3 rounded-xl bg-zinc-800/30 hover:bg-zinc-800/60`。

#### C-12 · P2 · 两套进度条
- **位置**：`TodayWorkbench.tsx`（`h-1 bg-black/60` 底 + `bg-emerald-500` 填充 + `role="progressbar"`）、`ContentScreen.tsx:298-302`（同，但**无 role**）、`SentenceView.tsx:165-170`（`h-1.5` 轨道 + 渐变 + 无 aria）、`RecentLearning.tsx`（缩略图内）
- **表现**：有的带 `role="progressbar"` 与 `aria-valuenow`，有的没有；高度 1px/1.5px；填充 emerald vs 渐变。
- **影响**：读屏用户只能在一处听到进度；视觉上 1px 条在 Retina 上几乎不可见。
- **建议方向**：`Progress`（含 a11y 三件套 + 高度 1.5px + 单色）。

#### C-13 · P2 · 两套「来源标签」渲染
- **位置**：`LibrarySection.tsx:302-307`（`rounded-full border-emerald-500/20 bg-emerald-500/10 text-[10px] uppercase tracking-wide`）、`LearningHeader.tsx:56`（`text-[11px] rounded-full bg-zinc-800/50 border-white/5`）、`AccountScreen.tsx:679`（`text-[11px] rounded-full bg-blue-500/10 border-blue-500/20 text-blue-300`）
- **表现**：同一「徽标/标签」角色，3 种尺寸 + 3 种颜色语义（emerald/neutral/blue），且只有一处用 `uppercase`（设计语言禁止对中文用 uppercase，但此处英文 `FREE` 尚可）。
- **影响**：标签系统没有语义色规则，读者无法快速区分「免费」「来源」「状态」。
- **建议方向**：`Badge`（tone: neutral/brand/success/warning/danger + size），禁用逐个写色。

#### C-14 · P2 · 两套「复制/分享」浮层
- **位置**：`ShareCardDialog.tsx`（305 行，完整分享卡 + canvas 生成）、`ReaderScreen.tsx:1247-1310`（选区浮层「分享本段」）
- **表现**：分享入口在阅读器有「段落浮层」，在分享卡是整页弹窗；两者动效与遮罩不同。
- **影响**：同一「分享」在两个上下文长得不像同一个功能。
- **建议方向**：A4 评估合并（至少共用生成/降级逻辑与按钮文案）。

#### C-15 · P2 · 两套「删除/移除」图标按钮
- **位置**：`App.tsx:2647`（字幕同传行的星标/删除，hover 才出现）、`VocabularyBookScreen.tsx`（行内删除）、`RecentLearning.tsx:356-368`（`Trash2` 行内删除）、`AccountScreen.tsx:642`（`X` 取消改名）
- **表现**：删除类操作的命中区、颜色（`text-red-400` vs `text-zinc-500`）、确认方式（`window.confirm` vs 直接删）不一。
- **影响**：误删风险不均；用户不确定哪些删除会二次确认。
- **建议方向**：删除统一「hover/focus 变红 + 二次确认」，命中区 ≥32px。

#### C-16 · P2 · 组件文件职责过载（超 1,000 行的 7 个）
- **位置**：`AdminConsoleScreen.tsx` 1,634、`CourseScreen.tsx` 1,606、`VocabularyBookScreen.tsx` 1,483、`PlacementScreen.tsx` 1,447、`ReaderScreen.tsx` 1,329、`ExamScreen.tsx` 1,300、`AbilityScreen.tsx` 1,281（合计 10,080 行 / 全组件 38%）
- **表现**：每个文件内都内联了按钮/卡片/弹窗/空态/分页/格式化函数（本报告 6.1 表里 40% 的重复项来自这 7 个文件）。
- **影响**：任何视觉规范都无法「改一处生效」；review 成本高；也是 P1 重复项的主要来源。
- **建议方向**：A4 按「shell + section + 原子组件」拆分，优先拆出 `CARD`/`BUTTON`/`DIALOG` 三类。

---

## 7. 类别五 · 布局与内容组织

### 7.1 页面清单（首屏结构评估）

| 页面 | 首屏主操作 | 首屏信息密度 | 主要问题 | 关联 |
|---|---|---|---|---|
| 今日 `#/today` | 粘贴框（仅无历史时）/ 三卡 | 高（日期标题 + 定位条 + 3 卡 + 小说卡） | 无历史时主操作在卡上方、有历史时被替换到页面底部（`StartLearning variant=compact`），**同一入口位置随数据变化** | L-04 |
| 内容 `#/content` | 粘贴框 | 很高（9 区块） | 首屏后连续 8 个区块无层级差异；右侧栏在 1024–1279 掉成整宽 | L-02、L-03 |
| 练习 `#/practice` | 复习主卡 | 中（4 卡） | 定位卡被塞进 3 列网格最后一格，`xl:flex-col` 变体与另两卡结构不同 | L-06 |
| 我的 `#/profile` | 无（账户摘要 + 8 个设置行） | 高 | 「账户」与「设置/关于/法律/退出」同页平铺，无分组导航；移动端顶部无返回（正确）但设置了 `isPage` 分支 | L-05 |
| 学习页 | 视频 + 字幕 | 高 | 移动端双层滚动 + 固定 52vh；顶部工具条换行 | L-01 |
| 复习 | 评分按钮 | 中 | 单卡居中，`max-w-2xl`；移动端底部按钮与安全区 | — |
| 报告 | 数字 + 证据列表 | 中 | 证据跳转回学习页 | N-03 |
| 定位/能力 | 开始按钮 / 雷达 | 低 | 两者信息重复（同一 CEFR 结论两处展示） | L-08 |
| 考试 | 类型选择 | 低 | 顶部 eyebrow + 标题 + 副标题 + 2 按钮，移动端挤成两行 | L-09 |
| 发现 | 搜索框 | 低 | 搜索框 + 空态几乎占满首屏 | — |
| 阅读器 | 列表 / 正文 | 低 | 游客态是「假页面」 | I-13 |
| 单词本 | 4 个 tab + 列表 | 高 | tab 数 8+（我的/短语/CEFR/等级…），移动端横向滚动 | L-07 |
| 管理台 | 4 tab + 概览数字 | 高 | 独立壳（无侧栏/底栏），唯一出口是页内「← 返回」文字按钮 | N-14 |
| 欢迎页 | CTA | 低 | `min-h-screen` 在 iOS 裁切 | V-11 |
| 登录 | 表单 | 低 | 返回链接是全应用唯一的 bordered 返回 | I-11 |

### 7.2 问题清单

#### L-01 · **P0** · 移动端学习页双层滚动 + 固定 52vh
- **位置**：`App.tsx:2918`（`flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden max-md:overflow-y-auto`）、`App.tsx:2943`（字幕列 `max-md:h-[52vh]`）、`App.tsx:2993`（展开态 `h-[52vh] md:h-full`）、`TranscriptView.tsx:93`（`h-full overflow-y-auto` + `pb-[45vh]`）
- **表现**：手机上学习页外层可纵向滚动，同时字幕区自身 `h-[52vh]` 且内部还有一个 `overflow-y-auto` 滚动容器；字幕自动跟随时会对内层 `scrollTo`。
- **影响**：手势落在字幕区时滚动内层，落在视频/边缘时滚动外层——同一次滑动可能滚错层，或出现「滚到底了页面还在滚」的链式滚动；`52vh` 在小屏（667pt）上只剩 ~347pt 给字幕，配合 `pb-[45vh]`（≈300pt）的底部留白，实际可读区更小。
- **建议方向**：移动端只保留一个滚动容器（整页滚，字幕自然展开），或用 `overscroll-behavior: contain` + 明确手势分区；`52vh` 换成分区比例或 `dvh`。

#### L-02 · P1 · 内容页 9 个区块无层级差异
- **位置**：`ContentScreen.tsx:209-520`：粘贴框 → 右栏（继续/本周）→ 材料架（剧集 + 句子包）→ 免费库 → 公版书 → 规则推荐 → 订阅更新 → 博客页脚
- **表现**：9 个区块里 6 个用同一种卡片配方（`rounded-3xl bg-zinc-900/40`）、5 种标题字号（`SECTION_TITLE` 17px / `text-sm` / `text-[13px]` / 库与书的 17px / 推荐 17px）。
- **影响**：用户无法一眼判断「主操作是粘贴框」「其余都是货架」；长滚动后失去定位（无 sticky 标题、无分组锚点）。
- **建议方向**：分两级——主操作区（粘贴 + 继续学习）+ 二级货架（其余），二级用统一 `SectionHeader` + 更低的视觉权重；可选 sticky mini-header。

#### L-03 · P1 · 内容页在 1024–1279px 丢失两栏布局
- **位置**：`ContentScreen.tsx:225`（`xl:grid xl:grid-cols-[minmax(0,1fr)_320px]`）、`ContentScreen.tsx:270-273`（右栏 `xl:flex xl:flex-col`）
- **表现**：≥1280px 才是两栏；1024–1279（常见 13" 笔记本 + 240px 侧栏）下右栏变成整宽的两列网格，页面高度翻倍。
- **影响**：桌面第二档（含侧栏展开）时，「继续学习」块横跨整个内容区，像被拉长的横幅。
- **建议方向**：两栏在 `lg` 生效（侧栏出现即进入桌面布局），或 1024–1279 用「右栏置顶横排卡片」。

#### L-04 · P1 · 今日主操作位置随「有无历史」改变
- **位置**：`TodayScreen.tsx:173-182`（无历史时 hero 粘贴框在页头）、`TodayScreen.tsx:240-250`（有历史时 compact 粘贴框在页面最底部）、`App.tsx:3314`/`App.tsx:2266-2282`（顶栏「开始学习」强制跳内容页）
- **表现**：新用户看到的第一个可操作元素是粘贴框；老用户的首屏主操作变成「继续学习」卡，粘贴框被挪到页面末尾；而顶栏的「开始学习」却跳到「内容」页的另一个粘贴框。
- **影响**：同一动作有三个位置（今日页头/今日页尾/内容页），用户（尤其新用户过几天回来）找不到「再来一个视频」。
- **建议方向**：定「今日页头永远有主操作」（无历史 hero、有历史 compact），删除页尾副本；顶栏「开始学习」跳今日并聚焦（而非内容页）。

#### L-05 · P1 · 「我的」页把账户、设置、法律、退出平铺
- **位置**：`AccountScreen.tsx:582-800`（账户摘要 + 余额/花费/时长）、`AccountScreen.tsx:320-520`（libraryRows + settingsSection + aboutSection）、`AccountScreen.tsx:287-315`（pageChrome）
- **表现**：一页里 8 个功能块（单词本/报告/等级/语言/词汇等级/PWA/关于/法律/退出/管理员）没有分组标题层级，全部同权重列表行。
- **影响**：「退出登录」「删除账号（法律区）」这类危险/低频操作与「单词本」这类高频入口同一视觉权重，误触风险与查找成本都高。
- **建议方向**：分 3 组（学习数据 / 偏好 / 关于与账户），组标题 + 危险操作移到组尾并降低权重。

#### L-06 · P1 · 练习页定位卡是网格异类
- **位置**：`PracticeScreen.tsx:131`（`grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3`）、`PracticeScreen.tsx:189-231`（定位卡 `md:col-span-2 xl:col-span-1` + `md:flex-row xl:flex-col`）
- **表现**：同组 3 个卡片里，定位卡在 md 跨 2 列、在 xl 变纵向排列，而另两卡始终纵向。
- **影响**：md 宽度下第三行只剩一张卡横向拉满，视觉上像掉出来的附注；卡片内部按钮在 `md` 时靠右、`xl` 时占满，两套排法。
- **建议方向**：三卡统一栅格（`md:grid-cols-1`，`xl:grid-cols-3`），定位卡与另两卡同构。

#### L-07 · P1 · 单词本 8+ 个 tab 横向溢出
- **位置**：`VocabularyBookScreen.tsx:574-585`（`-mx-4 overflow-x-auto … w-max min-w-full`）、`VocabularyBookScreen.tsx:589-620`（tab 按钮 `h-9 px-2 text-[13px]` + 计数徽章）
- **表现**：tab 数量由目录动态决定（我的/短语/CEFR/5 个等级 …），移动端必须横向滚动且无滚动提示，选中项可能在视口外。
- **影响**：用户不知道还有更多 tab；切换后选中项不自动滚入视口。
- **建议方向**：分组（我的 / 词表），或改为「下拉选择 + 2 个固定 tab」；至少补 `scrollIntoView` 到选中项。

#### L-08 · P2 · 定位与能力画像信息重复
- **位置**：`AbilityScreen.tsx`（雷达 + 自评）、`PlacementScreen.tsx:1359+`（画像视图）、`PracticeScreen.tsx:189-231`（定位行）、`PracticeScreen.tsx:110`（复习行）
- **表现**：「我的 CEFR 等级 + 置信度」在今日定位条、练习定位行、能力页、定位画像页、我的等级行共 5 处展示，文案与格式不同（`placement.home.levelLine` vs `ability.*`）。
- **影响**：用户看到 5 个「你的水平」，若某处数据未刷新会自相矛盾（`reviewStatsNonce`/`placementNonce` 的做法说明这已经发生过）。
- **建议方向**：单一 `LevelSummary` 组件 + 一处数据源，其余页面只做入口。

#### L-09 · P2 · 考试页头部信息过载
- **位置**：`ExamScreen.tsx:1170-1215`（eyebrow + 标题 + 副标题 + 历史按钮 + 关闭 + 进度）
- **表现**：移动端 `text-xl sm:text-2xl` 的标题与 eyebrow/副标题/两个图标按钮同排，`flex-wrap` 后关闭按钮可能换行。
- **影响**：考试是「有始有终」的任务页，头部越复杂越打断；关闭按钮位置在窄屏不稳。
- **建议方向**：`SubHeader`（返回 + 标题 + 关闭），副标题下沉到内容区。

#### L-10 · P2 · 首屏无「下一步」的页面
- **位置**：`DiscoverScreen.tsx:256-320`（搜索框 + 空态）、`ReaderScreen.tsx:700-720`（游客登录面板）、`ReportScreen.tsx:168-220`（报告空周）、`BlogScreen.tsx:487-490`（空列表只有一行字）
- **表现**：这些页面首屏只有「输入框」或「一句说明」，没有明确的推荐动作/示例。
- **影响**：新用户在这些页面会停住（尤其中文界面里还混着英文文案，见 V-06）。
- **建议方向**：每个空态给一个「最有价值的一次操作」（如发现页给 3 个推荐主题、博客空列表给 RSS 订阅）。

#### L-11 · P2 · 桌面/移动布局分支靠 `max-md:` 局部补丁
- **位置**：`App.tsx:2918`（`max-md:overflow-y-auto`）、`App.tsx:2943`（`max-md:h-[52vh]`）、`AppShell.tsx:116`（`isSub ? 'hidden md:flex'`）、`ContentScreen.tsx:225`（`xl:grid`）、`PracticeScreen.tsx:131`（`md:grid-cols-2 xl:grid-cols-3`）
- **表现**：桌面与移动的差异散落在 5 个文件的不同断点（`md`/`lg`/`xl` + `max-md`），没有集中的布局契约。
- **影响**：新增页面要重新决定用哪个断点；`lg`（侧栏出现）与 `md`（顶栏 tabs）与 `xl`（两栏）三个断点混用导致 1024–1279 是「半桌面」状态。
- **建议方向**：A2 定「三档 + 两个断点」：手机 `<768`、桌面窄（侧栏收起/单栏）`768–1279`、桌面宽 `≥1280`，页面只引用档位 token。

#### L-12 · P2 · 子视图头部高度 4 种
- **位置**：`LearningHeader.tsx:34`（`h-12`）、`CourseScreen.tsx:135`（`h-12 md:h-14`）、`BookReaderScreen.tsx:433`（`py-2.5` 自适应）、`SentenceView.tsx:98`（`py-2.5` + `flex-wrap`）、`ReaderScreen.tsx:1090`（`py-3`）
- **表现**：同为「子视图 chrome 条」，高度 44–56px 不定，返回按钮垂直居中位置因此在各页不同。
- **影响**：连续的页面切换中头部高度跳动；`flex-wrap` 的句子包工具条在窄屏会变两行（高度翻倍，挤压内容）。
- **建议方向**：`SubHeader` 固定 `h-12`，工具条下放到内容区第二行。

#### L-13 · P2 · 滚动定位缺 `scroll-padding`（IA §6.4 第 4 条未实现）
- **位置**：`index.css`（无 `scroll-padding`）、`TodayScreen.tsx:166`（`input.scrollIntoView({block:'center'})`）、`App.tsx:2274`、`App.tsx:3031`、`App.tsx:2230`（`scrollIntoView`）、`App.tsx:2226-2239`（锚点重试）
- **表现**：IA 明确要求 `scroll-padding-bottom: calc(56px + env(safe-area-inset-bottom))`，代码里 0 处。
- **影响**：手机上「开始学习」聚焦输入框时，输入框可能被底栏压住（`block:'center'` 缓解但底部元素仍会被裁）；侧栏「免费库/书架/历史」跳转同样可能停在底栏下方。
- **建议方向**：滚动容器加 `scroll-padding-top/bottom`（含安全区），或把 `scrollIntoView` 换成显式 `scrollTo` 计算偏移。

#### L-14 · P2 · 两个一级页缺「下拉刷新/自动重试」
- **位置**：`TodayScreen.tsx:92-139`（挂载时各请求一次，无重试按钮）、`ContentScreen.tsx:119-192`（同）
- **表现**：首屏数据只在 mount 时请求；从后台切回（PWA）或网络恢复后不会刷新，也没有手动刷新按钮（对比「我的」页有 `account-refresh`，`AccountScreen.tsx:308`）。
- **影响**：用户从离线恢复后仍看到空态（叠加 I-01 会被误读为数据丢失）。
- **建议方向**：`visibilitychange`/`online` 事件触发一次静默刷新；错误态给重试；「我的」页的刷新按钮模式可复用。

---

## 8. 附录 A · Top 20 修复优先级（P0/P1）

> 排序依据：影响面（页面数/用户数）× 修复成本。A2/A3 需逐条回应；A4 按此顺序收敛。

| # | ID | 一句话 | 建议归属 | 依赖 |
|---|---|---|---|---|
| 1 | V-06 | 补齐 `zh-CN` 中 24 个键的英文文案（或加 CI 规则） | A5 门禁 + 文案 | 无 |
| 2 | I-01 | 三处「失败当空态」补错误态与重试 | A3 | 无 |
| 3 | N-02 | 报告/复习不再改写底层 tab | A3 | N-04 同源 |
| 4 | N-03 | `replace` 后重置 `canGoBackRef` | A3（`useNav` 一处） | 无 |
| 5 | N-01 | 博客 slug 接进 `BlogScreen` + 打开文章写 URL | A3 | 无 |
| 6 | L-01 | 移动学习页单滚动容器 | A2（布局）+ A4 | 需真机验证 |
| 7 | I-02 | `ChannelVideoList` 换共享 `Dialog` | A4 | C-02 |
| 8 | V-03 | `text-zinc-600` 87 处替换为 `zinc-500` | A2 token | 无 |
| 9 | V-04 | 禁用 `blue-*`，只留 `brand` | A2 token + A5 lint | 无 |
| 10 | C-01 | 五类按钮组件化，删 12 份常量 | A4 | A2 |
| 11 | C-05 | tab 视觉二选一（导航下划线/内容白滑块） | A2 + A4 | 无 |
| 12 | C-07 | 徽章 `CountBadge` 统一 4 处 | A4 | 无 |
| 13 | I-12 | 点词 handler 工厂 + 句子包来源 | A3 + A4 | C-03 |
| 14 | I-05 | 禁用 `window.confirm`，统一 `ConfirmDialog` | A4 | C-02 |
| 15 | I-10 | Toast 位置/时长/去重 | A2 + A4 | 无 |
| 16 | V-14 | 删组件级 focus 样式，只留全局 | A2 + A5 lint | 无 |
| 17 | N-04 | `#/learn` 来源 tab 保留（或用文档明确） | A3 | 决策项 |
| 18 | V-11 | 全仓 `dvh` 化 | A2 | 无 |
| 19 | I-06 | 收藏乐观反馈 + 游客星标状态 | A3 | 无 |
| 20 | V-15/V-16/V-17 | 一级页标题/容器/内边距三件套统一 | A2 | A1 数据 |

---

## 9. 附录 B · 审计盲区

1. **无运行时验证**：本报告是静态审计。所有「移动端会裁切/会双滚动」的结论基于结构（`h-screen`、嵌套 `overflow-y-auto`、`52vh`），未在 iOS Safari/Android Chrome 实测；A5 的 QA 清单必须补 375×667 / 390×844 / 430×932 + 地址栏展开收起。
2. **未测视觉对比度数值**：`zinc-600`（87 处）被判为违反设计语言，未逐处计算 WCAG 比值；A2 定 token 时应给出目标对比度。
3. **未覆盖业务内容质量**：课程/考试/能力自评的题目与文案是否合理不在本次范围（章程排除课程重构）。
4. **未覆盖后端驱动的动态文案**：`BookSeriesScreen.tsx:294-299` 依据后端中文原因串（`版权未到期`/`保护期`）做分支、`ReaderScreen.tsx:94` 用 `'[未翻译]'` 哨兵值——这类「后端字符串当枚举」是 i18n 风险，但需后端契约才能定方案（本报告只记录，未计入 90 条）。
5. **未覆盖 `mobile/`（Expo）** 与已废弃 `InputScreen` 之外的死代码（未做全仓未使用导出扫描）。
6. **Tab 顺序**：`lib/navTabs.ts:16-22` 的可见顺序是「内容/练习/今日/我的」，与 IA §2.1 的「今日/内容/练习/我的」不同；代码注释写明这是 **2026-11-17 owner 决定**（「Content first, Today third」），因此**不计入问题**，仅提醒 A3 在导航规范里显式记录该决策，避免下一轮又被当成 bug 改回去。
7. **测试与门禁现状**（供 A5 参考）：CI 只跑 `tsc -b` + `vite build`（`.github/workflows/ci.yml:68-72`），ESLint 无自定义规则且未进 CI（`frontend/eslint.config.js`）；Playwright 检查只覆盖免费库过滤（`frontend/scripts/check-library-ui.mjs`）与 i18n 字典对齐（`scripts/check-i18n.mjs`）。**没有任何视觉/一致性门禁**——这是以上 90 条能长期存在的结构性原因。

---

## 10. 附录 C · 已一致、无需改动的部分（避免 A2/A4 重复设计）

- 字重上限遵守良好：`font-bold`/`font-extrabold` **0 处**，只有 `font-medium`(483)/`font-semibold`(223)。
- `transition-all` **仅 1 处**（`ModelSelectionModal.tsx:183`），《设计语言》的「少用 transition-all」基本落实。
- 键盘焦点有全局 `:focus-visible` 规则（`index.css:17-21`），问题只在组件级覆盖（V-14）。
- 图标库统一 `lucide-react`，未发现手写内联 SVG（符合《设计语言》图标节）。
- `nav.ts` 是干净的纯函数（无 React/DOM），`useNav` 的 push/replace/back 语义注释清楚；问题在**调用方**与两处历史标记（N-02/N-03）。
- i18n 字典结构对齐（1,691 keys × 2，占位符一致，vi-VN 无 CJK），`npm run check:i18n` 可作门禁基础。
- 空态图标尺寸 `w-10 h-10 text-zinc-700` 的 13 处与设计语言一致（差异在内边距与有没有 CTA）。
- `prefers-reduced-motion` 在 12 个文件中有判断（`matchMedia` 6 处 + `useReducedMotion` 6 处），但覆盖面不足 26 个动画文件的一半，已计入 V-21，不算「已一致」。

---

*审计员 A1 · 交付物：本报告 ｜ 下一步：A5 可从本报告直接生成 QA 检查项；A2/A3 需逐条回应 §2.3 与 §3–§7 的 P0/P1。*
