# A3 对 A1 审计的逐条回应（交互 I + 跳转 N）

> 版本：v1（2026-11-19）｜作者：A3 交互与导航规范师｜状态：阶段 1 · 门禁 1 交付物
> 输入：[`audit-report.md`](./audit-report.md) §4 交互（I-01–I-20）、§5 跳转（N-01–N-18）
> 输出：[`interaction-spec.md`](./interaction-spec.md)、[`navigation-model.md`](./navigation-model.md)
> 规则：逐条覆盖，不漏 ID；状态只有 **覆盖 / 部分覆盖 / 暂不处理** 三种。标 `*` 的行依赖 `navigation-model.md` §0.4 的 D-01/D-02 被 lead 批准；若否决，这些行降为「部分覆盖」。

---

## 0. 统计

| 维度 | 数量 | 覆盖 | 部分覆盖 | 暂不处理 |
|---|---|---|---|---|
| 交互 I（I-01–I-20） | 20 | 17 | 2（I-17、I-18） | 1（I-20） |
| 跳转 N（N-01–N-18） | 18 | 17 | 1（N-10） | 0 |
| **合计** | **38** | **34** | **3** | **1** |

- **P0（5 条）全部覆盖**：I-01、I-02、N-01、N-02、N-03。
- **P1（18 条）全部覆盖**：交互 I-03–I-14（12 条）；跳转 N-04–N-08、N-18（6 条）。
- **P2（15 条）**：11 条覆盖（I-15、I-16、I-19、N-09、N-11–N-17）；3 条部分覆盖（I-17、I-18、N-10）；1 条暂不处理（I-20）。
- 校验：P0 5 + P1 18 + P2 11 = 34 覆盖；P2 3 部分 + P2 1 暂不 = 4；总计 38。

> 「必须处理的 P2」判定：I-15（词卡出界）、I-16（hover 依赖）、I-19（反馈）、N-09（chrome）、N-11（非法路由）、N-12（定位来源）、N-13（别名）、N-14（守卫）、N-15（登录目标）、N-16（滚动）、N-17（双壳）、N-18（单词本返回）全部纳入规范并覆盖；I-17/I-18/N-10 涉及组件视觉/收敛，规范先定行为，落地留给 A2/A4；I-20 需要真机/PWA 验证，先记为暂不处理。

---

## 1. 交互条目（I-01–I-20）

| 审计 ID | 级别 | 规范条目（文件 + 锚点） | 覆盖状态 | 理由 / 落地要点 |
|---|---|---|---|---|
| **I-01** | **P0** | `interaction-spec.md#ix-01`、`#ix-05`、`#ix-20` | **覆盖** | 三处「catch 后置空数组」改为显式 `error` 态 + 错误面板 + 重试；`TodayScreen.tsx:95-105`、`ContentScreen.tsx:121-131`、`ContentScreen.tsx:179-193` 不得再进入 `continueEmpty/weekEmpty/noUploads`；周报失败同样改正。参考 `LibrarySection.tsx` 四态实现。 |
| **I-02** | **P0** | `interaction-spec.md#ix-09` | **覆盖** | `ChannelVideoList` 纳入统一 Dialog：`role="dialog"` + `aria-modal` + `aria-labelledby`、Escape、遮罩点击、焦点陷阱、滚动锁、关闭后焦点回填；X 命中区 ≥44×44。 |
| **I-03** | P1 | `interaction-spec.md#ix-09` | 覆盖 | 13 个弹窗统一到 A4 的 `Dialog`（role/aria-modal/label/焦点/滚动锁/Escape/遮罩）；缺 role 的 `ModelSelectionModal`、`ChannelVideoList`、`WordPopover` 按模态/非模态分别补齐（词卡 `aria-modal="false"`，不做焦点陷阱）。 |
| **I-04** | P1 | `interaction-spec.md#ix-09`、`#ix-10` | 覆盖 | Dialog 契约含 `inert` 背景 + `overflow-hidden` + 焦点陷阱 + 关闭回填；路由变化时统一关闭覆盖层；词卡不锁滚动（非模态）。 |
| **I-05** | P1 | `interaction-spec.md#ix-09`、`#ix-24` | 覆盖 | 全站禁用 `window.confirm/alert`；删除历史/文章/书/导入书、重置定位、退出考试统一 `ConfirmDialog`（标题问句 + 后果 + 动词按钮 + 取消默认焦点）；可逆的取消收藏改用撤销 toast。 |
| **I-06** | P1 | `interaction-spec.md#ix-22`、`#ix-17` | 覆盖 | 收藏/取消采用乐观更新：星标与计数立即变化，失败回滚 + error toast；游客点击直接打开登录浮层，星标不变；不弹 success toast（状态本身即反馈）；单词本移除提供 5s 撤销。 |
| **I-07** | P1 | `interaction-spec.md#ix-03` | 覆盖 | 首屏列表/卡片统一骨架（免费资源、书架、最近学习、频道更新）；行内刷新用 `w-3.5` spinner；详情页保持头部稳定；spinner 尺寸收敛由 A2 定义，行为上禁止「首屏空白 + 居中大 spinner」。 |
| **I-08** | P1 | `interaction-spec.md#ix-04` | 覆盖 | `EmptyState` 四槽（图标/标题/解释/动作）；普通空态只允许 `py-16`；卡片/右栏内联空态 `py-3`；虚线边框仅用于「可放置区」；区分真空/筛选空/未登录三种文案。 |
| **I-09** | P1 | `interaction-spec.md#ix-02`、`#ix-05` | 覆盖 | 反馈四层：字段内联、操作 toast、区块错误面板、阻断遮罩；页面加载失败必须用错误面板（不是 toast/静默）；词卡内联错误保留重试；后端 `detail` 只能作附加说明。 |
| **I-10** | P1 | `interaction-spec.md#ix-08` | 覆盖 | TTL：success 3s / info 5s / error 8s（长错误或带动作保持到手动关闭）；同 key 5s 去重、最多 3 条、hover/focus 暂停；移动端抬到底栏安全区之上；离线标记移到顶栏下方，消除与 toast 重叠。 |
| **I-11** | P1 | `navigation-model.md#nm-09` | 覆盖 | 单一 `BackButton`：`h-9`、`-ml-2`、`ArrowLeft`、≥sm 显示「返回」、aria 含父级；页面级不再用 X（X 只给覆盖层）；Review/Report/Exam/Placement/Ability/Discover 的 X 全部替换。 |
| **I-12** | P1 | `interaction-spec.md#ix-21` | 覆盖 | 5 个点词 handler 收敛为 `makeWordLookup(sourceKind, sourceId, sourceTitle)`；句子包传 `sentence_pack` + `L<levelId>`；免费库文章传 `article` + 文章 id；单词本来源解析补回跳；空 `source_ref` 视为 P1 数据缺陷，不准静默显示「未知来源」。 |
| **I-13** | P1 | `interaction-spec.md#ix-17`、`#ix-23` | 覆盖 | 「读文章」两个入口统一 `requireAccount()`；未登录 → 登录浮层（不改路由），取消留原页；阅读器内登录面板仅作深链兜底；登录成功后完成原导航。 |
| **I-14** | P1 | `interaction-spec.md#ix-12`、`#ix-23` | 覆盖 | 统一「先 URL/壳 + 骨架 → 加载 → 成功/页内错误 + 重试」；免费库、发现候选、单词本、粘贴框四条路径不再分别用「先 fetch 后跳」「先跳后加载」「全屏遮罩」；导航不再使用全屏阻断遮罩。 |
| I-15 | P2 | `interaction-spec.md#ix-21` | 覆盖 | 词卡定位契约：左右 12px clamp、空间不足向上翻转、`maxHeight` 按视口可用高度、内容可滚动、不遮触发词；现有代码已有 clamp，规范补翻转/最大高度/切词不跳动，防止回退。 |
| I-16 | P2 | `interaction-spec.md#ix-11` | 覆盖 | 规则：粗指针（`pointer: coarse`）下所有 hover-only 操作常显，或提供「更多」菜单；至少覆盖字幕收藏星、`App.tsx:2647` 删除、`ChannelVideoList` 播放遮罩；触屏命中区 ≥44×44。 |
| I-17 | P2 | `interaction-spec.md#ix-19` | **部分覆盖** | 行为规范已定：2–5 个互斥选项用分段控件，原生 `<select>` 仅限 >7 项/系统选择；但具体视觉组件与替换清单归 A2（分段控件令牌）+ A4（StartLearning 改造），本轮 A3 不发明样式。 |
| I-18 | P2 | `interaction-spec.md#ix-18` | **部分覆盖** | 分页模型已定：列表统一「页码条 + 总数/当前页」，筛选归 1，步骤型改名上一步/下一步，状态存 URL/session；组件收敛到 `VocabPagination` 归 A4，A3 只定行为，不合并代码。 |
| I-19 | P2 | `interaction-spec.md#ix-07`、`#ix-25` | 覆盖 | 写操作统一 `submitting` 状态：按钮内 spinner + disabled + 防重复；成功 toast 仅用于无可见结果的操作；失败保留输入/对话框并内联错误；管理台调额/封禁失败不关闭对话框。 |
| I-20 | P2 | `navigation-model.md#nm-14` | **暂不处理** | 平台返回差异（Android 硬件返回/iOS 边缘手势/PWA standalone）需要真机与 standalone 环境验证；规范只给出目标：web 原生后退与页面 BackButton 同义，深度 0 离开站点属正常，PWA 根页「再按一次退出」列为 P2；本轮不改代码、不承诺已实现。 |

---

## 2. 跳转条目（N-01–N-18）

| 审计 ID | 级别 | 规范条目（文件 + 锚点） | 覆盖状态 | 理由 / 落地要点 |
|---|---|---|---|---|
| **N-01** | **P0** | `navigation-model.md#nm-03`、`#nm-06`、`#nm-10` | 覆盖* | `BlogScreen` 接受初始 slug；列表→文章 **push** `#/<tab>/blog/<slug>`，文章→列表 back；刷新/分享恢复文章；`App.tsx:3169` 必须传 slug，`BlogScreen.tsx:259` 的 `selectedSlug` 改为受控。依赖 D-01（前缀）但即使保留旧前缀也成立。 |
| **N-02** | **P0** | `navigation-model.md#nm-05`、`#nm-04`、`#nm-10` | 覆盖* | URL 第一段=来源 tab；`#/content/report`、`#/content/review` 合法；`tabForSub` 恒等于 `currentTab`（管理台除外）；打开报告/复习不再改写底层 tab；关闭回内容。依赖 D-01。 |
| **N-03** | **P0** | `navigation-model.md#nm-04`、`#nm-08` | 覆盖* | 所有前进导航 push；`useNav` 用 `history.state.dshNav.depth` 而非 `history.length`；replace 不再用于「换成另一个屏幕」；报告→复习/证据返回报告，单词本→文章返回单词本，连续 A→B→C 按 C→B→A 退。依赖 D-02。 |
| N-04 | P1 | `navigation-model.md#nm-03`、`#nm-05` | 覆盖* | `learn/lesson` 带来源 tab（`#/<tab>/learn/...`、`#/<tab>/lesson/...`）；旧 `#/learn`→content、`#/lesson`→today 一次重写；`parseRoute(toHash(s))` 与 state 互逆；刷新后返回落点与打开时一致。依赖 D-01。 |
| N-05 | P1 | `navigation-model.md#nm-07`、`#nm-08` + `interaction-spec.md#ix-23` | 覆盖 | 无缓存 local 剧集渲染恢复页（「尚未处理」+ 开始处理/返回），不再 toast + 弹回内容；开始处理是显式按钮（可能产生费用）；YouTube 无缓存同理（重试需确认费用）；IA §7.2 同步修订（D-06）。 |
| N-06 | P1 | `navigation-model.md#nm-03`、`#nm-06` | 覆盖 | `#/content/library` 成为合法 content 锚点并滚动到免费库区块；`#/content/books` 同理；侧栏快捷入口改用 URL + 数据就绪后滚动，删除 12 次 `setTimeout` 轮询（D-05）。 |
| N-07 | P1 | `navigation-model.md#nm-01`、`#nm-04`、`#nm-08` | 覆盖* | 书↔书系都是 push；面包屑表达分类（内容›书系›书），Back 表达历史（回上一个来处）；递归交替不再互相 replace；深链兜底回 content。依赖 D-02。 |
| N-08 | P1 | `navigation-model.md#nm-03`、`#nm-06` | 覆盖 | 阅读器文章 id、博客 slug 进 URL；列表→详情 push，返回列表；发现页结果留 `sessionStorage`（含 LLM 花费，不自动重跑）；刷新恢复当前文章。 |
| N-09 | P2 | `navigation-model.md#nm-02`、`#nm-09` | 覆盖 | 免费库文章与视频共用学习页 chrome：`LibraryArticleReader` 复用 `LearningHeader`（标题=文章标题、feature=免费资源、BackButton），不再出现「同路由两种外壳」；页面级 X 统一改 BackButton。 |
| N-10 | P2 | `navigation-model.md#nm-09`（§5.3） | **部分覆盖** | 规范已定单一 `formatCount`（>99 → "99+"）并要求顶栏/侧栏/学习页/我的行共用；实际合并四处代码归 A4（组件收敛），A3 只定规则，不直接改代码。 |
| N-11 | P2 | `navigation-model.md#nm-07` | 覆盖 | 真非法 hash → `#/today` + 一次性 toast「链接无效，已回到今日」；`#/practice/report` 这类新模型下合法的路由直接支持；`#/content/sentences/0` 等非法参数同样提示；不静默改写。 |
| N-12 | P2 | `navigation-model.md#nm-05`、`#nm-06` | 覆盖* | 今日打开定位 → `#/today/placement`，关闭回今日；练习打开 → `#/practice/placement`；能力页「重测」保留来源；`view=profile` 同屏 replace。依赖 D-01。 |
| N-13 | P2 | `navigation-model.md#nm-07` | 覆盖 | 旧别名保留且可读：`favorites→vocabulary`、`#/content/library`→锚点、`#admin`/`/admin`→profile/admin；规范化用 replace，不提示（若需要可在落点页提示一次）；`/admin` 不再固定 500ms，auth ready 即判。 |
| N-14 | P2 | `navigation-model.md#nm-12` | 覆盖 | 管理台守卫条件改为 `status !== 'loading' && isAdmin !== undefined`；非管理员 toast + `replace('#/profile')`，只提示一次；`/admin` 路径只重写一次；取消固定 500ms×2。 |
| N-15 | P2 | `navigation-model.md#nm-12` | 覆盖 | 公开页在模型外；匿名访问应用路由保留 hash，登录后就地渲染原目标；`#/login?next=<hash>` 支持回跳（校验只允许应用内 hash）；退出登录 replace welcome，避免后退回个人页。 |
| N-16 | P2 | `navigation-model.md#nm-13` | 覆盖 | 一级 tab 按 tab 记录 `scrollTop` 并恢复；只有「点当前 tab」才平滑回顶；列表→详情→返回恢复列表滚动；锚点区块用 `scroll-padding`。 |
| N-17 | P2 | `navigation-model.md#nm-02` | 覆盖 | D-03：任务型隐藏桌面 Sidebar/tab，只有页内 BackButton；面板型保留 Sidebar + 面包屑，同时保留页内 BackButton。两个出口语义明确（Sidebar=全局，Back=局部父级），并用面包屑表达层级；手机所有子视图都隐藏 BottomBar。 |
| N-18 | P1 | `navigation-model.md#nm-04`、`#nm-10` | 覆盖* | 删除 `closeWordbookForJump`；单词本→文章/书/句包/视频一律 push；返回回单词本，不落「我的」；学习页→单词本也 push，返回学习页。依赖 D-02。 |

---

## 3. 依赖与未覆盖

### 3.1 依赖（不是「未覆盖」，但需其它角色配合）

| 依赖 | 需要谁 | 影响 |
|---|---|---|
| **D-01 URL 全前缀 / D-02 前进全 push** | lead 在门禁 1 批准；IA 同步修订 | 标 `*` 的 7 行（N-01/N-02/N-03/N-04/N-07/N-12/N-18）从「覆盖」降为「部分覆盖」；备选见 nav §0.4 |
| `Dialog` / `ConfirmDialog` / `BackButton` 组件 | A4（A2 定视觉） | I-02/I-03/I-04/I-05/I-11 的代码落地 |
| `formatCount` 单一来源 | A4 | N-10 从部分覆盖转为覆盖 |
| 分段控件/分页组件 | A2 + A4 | I-17/I-18 从部分覆盖转为覆盖 |
| PWA/真机返回验证 | A5 | I-20 从暂不处理转为覆盖 |
| 错误文案 key（`*Failed`、`nav.invalidLink`） | A4/文案 + i18n | I-01/I-05/N-11 的最终文案 |

### 3.2 未覆盖项（如实列出）

1. **I-20（P2）暂不处理**：Android/iOS/PWA 的根页退出拦截。原因：需要 standalone 环境真机验证，且属于平台差异；规范给出目标行为，未承诺本轮实现。
2. **I-17/I-18/N-10 部分覆盖**：行为规则已定，但视觉组件替换、分页合并、计数格式合并属于 A2/A4 的实现工作；A3 不修改代码，也不发明新样式。
3. **非 I/N 条目**（V/C/L）不在 A3 的回应范围：V-06 文案、C-02 弹窗组件、L-01 移动双滚动等由 A2/A4/A5 负责；本文只在交互契约中引用，不重复设计。

### 3.3 A1 未列但规范新增的约束（提醒 A4/A5）

| 新增约束 | 位置 | 原因 |
|---|---|---|
| 估价失败必须先确认再开始，不得静默开始处理 | `interaction-spec.md#ix-12` | 现状 `EstimateDialog` 估价失败直接 `onStart`，用户不知道费用；与「一次成本只花一次」相邻风险 |
| 目标语言切换关闭依赖语言的子视图并 toast | `navigation-model.md` §0.4 D-11 | 现状行为正确但未被文档化；防止后续误改成「保留旧内容」 |
| 覆盖层在路由变化时统一关闭 | `interaction-spec.md#ix-13` | 现状频道面板/词卡可能跨路由残留 |
| 词卡键盘可达（句子级停靠点 + 方向键） | `interaction-spec.md#ix-21` | A1 只提了弹窗键盘；字幕有数百词，逐词 tab 不可行，需句级方案 |
| 离线标记移到顶栏下方 | `interaction-spec.md#ix-08` | 与 toast 同处底部在 375px 必然重叠（I-10 的结构性修法） |

---

## 4. 门禁 1 自检

- [x] A1 的 **I-01–I-20、N-01–N-18 全部 38 个 ID** 在本表出现，无遗漏。
- [x] 5 条 P0 全部有规范条目、行为规则与 QA 判定。
- [x] 18 条 P1 全部有规范条目（I-03–I-14、N-04–N-08、N-18）。
- [x] 每条「覆盖/部分覆盖/暂不处理」都有理由；部分覆盖/暂不处理写明依赖与后续角色。
- [x] 导航模型的每条返回规则都能写成 QA 是/否项（nav §13，共 20 项）。
- [x] 规范未修改业务代码，未提交 git。
- [ ] 待 lead 批准 D-01/D-02 并在 IA 中同步修订（门禁 1 动作）。
