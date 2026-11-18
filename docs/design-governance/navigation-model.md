# 导航模型（Navigation Model）

> 版本：v1（2026-11-19）｜作者：A3 交互与导航规范师｜状态：阶段 1 · 门禁 1 交付物
> 范围：页面层级、URL 模型、push/replace/back、返回目标、面包屑/标题/关闭、跳转矩阵、深链/刷新/跨模块跳转。
> 基线：`docs/信息架构-导航重构.md`（IA）§7；本文是它的**可实施细化 + 已登记的修订**。只写规范，不改代码，不提交 git。

---

## 0. 一页看懂与决策

### 0.1 四句话

1. **四个一级 tab 不变**：今日 / 内容 / 练习 / 我的；默认落地是「今日」，可见顺序沿用 owner 2026-11-17 的决定（内容 / 练习 / 今日 / 我的），见 §0.4 D-8。
2. **URL 第一段永远是来源 tab**：`#/<tab>/...`。同一个屏幕从今日打开是 `#/today/report`，从内容打开是 `#/content/report`——返回时不需要猜。
3. **前进就 push，切换就 replace**：tab 切换、同屏参数切换用 replace；打开子视图、列表→详情、跨屏跳转用 push；返回就是弹出一帧。废止「子视图栈深恒为 1」。
4. **返回键有且只有两个出口**：有来源历史 → 回到来源；没有历史（深链/刷新）→ 回到该屏幕的**父级**（表见 §5）；页面级不用 X，X 只属于覆盖层。

### 0.2 与 IA 的关系

本文以 IA §7 为基线，但 A1 已证明「栈深恒为 1 + 强制归属 tab」与用户预期冲突（N-02/N-03/N-04/N-07/N-12/N-18）。本文件把修订显式登记为 `D-01`–`D-12`；**实现以本文件为准，IA 由 lead 在门禁 1 同步修订**。不登记就直接偏离 IA 的实现视为违规。

### 0.3 现有问题的根因（一句话）

| 根因 | 表现（A1） |
|---|---|
| `tab` 既是「归属」又当「前缀」，而 `learn/lesson` 不写前缀 | `parseRoute(toHash(s)).tab ≠ s.tab`；刷新后从今日打开的视频返回落到内容（N-04） |
| `openSub` 在已有 `sub` 时一律 replace | 报告→复习、单词本→文章返回越过一层（N-03/N-18） |
| `report/review/placement` 的 `tabForSub` 只认部分来源 tab | 内容页打开报告后落在今日（N-02）；今日打开定位后落在练习（N-12） |
| 博客 slug 建模了但不传给组件 | 文章深链/刷新/分享失效（N-01） |
| 列表/详情内部状态不进 URL | 阅读器/博客/发现刷新回列表（N-08） |
| 空闲锚点靠 `setTimeout` 轮询，不写 URL | `#/content/library` 被静默丢弃（N-06） |
| 返回守卫用 `history.length` | 深链进入也会 `history.back()`，可能离开应用；replace 后守卫不复位（N-03） |
| 管理台/公开页守卫用固定定时器 | 500ms×2 白屏（N-14）；登录丢失目标（N-15） |

### 0.4 修订登记（A3 决策）

| ID | 决策 | 影响的 A1 条目 | 若被 lead 否决的备选 |
|---|---|---|---|
| **D-01** | **URL 全前缀**：所有应用页面都是 `#/<tab>/<sub>...`；`learn/lesson` 也带来源 tab。旧 `#/learn/...`→`#/content/learn/...`、`#/lesson/...`→`#/today/lesson/...` 一次性重写。 | N-02/N-04/N-12 | 保留 source-absolute + `?from=<tab>`（可行但模型有两套前缀，不推荐） |
| **D-02** | **所有前进导航 push**：tab 根→子视图、子视图→子视图、列表→详情、来源→原文都是 push；只有同屏参数（句子册、定位视图）和 tab 切换 replace。栈由浏览器 history 承载，不再限制为 1 层。 | N-03/N-07/N-18 | 维持栈深 1：则「单词本→原文」必须 replace 并牺牲回到单词本，需用户确认接受 |
| **D-03** | **双壳明确**：任务型子视图（视频/阅读器/书/句子/复习/考试/定位/课程）隐藏桌面侧栏与 tab，只有页内返回；面板型子视图（报告/发现/博客/单词本/能力）保留桌面侧栏与面包屑，同时保留页内返回（侧栏=全局出口，返回=局部父级）。 | N-17 | 让面板型也隐藏侧栏（导航更统一，但博客/报告在桌面失去全局入口） |
| **D-04** | **页面级退出统一 BackButton（←）**；X 只用于对话框/弹层。全屏页不再各自保留 X/箭头两套。 | I-11/N-09 | 保留 X 但统一尺寸/位置（仍有两套语义，不推荐） |
| **D-05** | **区块锚点进 URL**：`#/content/library`、`#/content/books` 是合法的 tab 级锚点；进入后滚动到区块，不再静默改写。 | N-06/L-13 | 给区块独立子路由（更重，P2 再考虑） |
| **D-06** | **缓存缺失是页面态，不是 toast+弹回**：`#/<tab>/learn/local/...` 无缓存 → 渲染「尚未处理」恢复页（开始处理/返回）；YouTube 无缓存同理（重试需确认费用）。IA §7.2 的「toast+回内容页」同步修订。 | N-05/I-14 | 保持 toast+回内容页（需接受用户不知发生了什么） |
| **D-07** | **非法路由有一次性反馈**：合法但未支持 → 尽量支持；真正非法 → `#/today` + 一次 toast「链接无效，已回到今日」。 | N-11 | 保持静默回落（不推荐） |
| **D-08** | **tab 可见顺序**：内容 / 练习 / 今日 / 我的（owner 2026-11-17 决定）；**默认落地仍为今日**。 | 附录 B-6 | 改回 IA 顺序（需 owner 重新拍板） |
| **D-09** | **公开页在模型外**：`#/welcome`、`#/login` 不属于 4 tab；匿名访问应用路由保留 hash，登录成功后就地渲染原目标；`#/login?next=<hash>` 支持回跳。 | N-15 | 登录后统一回今日（旧行为，不推荐） |
| **D-10** | **管理台是全局控制台**：固定 `#/profile/admin`（不按来源 tab 改前缀）；关闭/失败回来源（history）或 profile（兜底）；守卫以 auth ready + `isAdmin` 判定，不用固定计时器。 | N-14 | 把管理台做成 tab 子视图（权限语义更弱，不推荐） |
| **D-11** | **目标翻译语言切换是环境失效，不是导航**：中止当前流，关闭依赖语言的子视图（admin/单词本除外）并 replace 回 tab 根，toast 说明。 | I-14 邻近 | 保留当前子视图并标记 stale（会混语言，不推荐） |
| **D-12** | **理解题仍是学习页层内覆盖**：不占路由、不 push；刷新回学习页。浏览器返回在答题中会退出学习页——这是已知边界（P2 可加一层 history guard，见 §14）。 | IA §7.1 | 把理解题升级成独立路由（需先定证据回跳，IA P1 决策） |

> 本表是 **A3 的正式建议**；除 D-01/D-02 外均为低风险收敛。D-01/D-02 是修复 N-02/N-03/N-04/N-12/N-18 的必要条件。

---

<a id="nm-01"></a>
## 1. 页面层级模型

### 1.1 五层

```
L0 公开页（模型外）        #/welcome  #/login
L1 一级 tab                #/today  #/content  #/practice  #/profile
L2 子视图
   T 任务型（沉浸）         视频/本地剧集/免费库视频·文章/阅读器/书/书系/导入书/
                            句子精背/复习/考试/定位/课程
   P 面板型（tab 下钻）     报告/发现/博客/单词本/能力档案
   A 独立壳                 管理台
L2.5 屏内层级              博客列表↔文章、阅读器列表↔文章（URL 可表达，历史 push）
L3 覆盖层                  词卡/菜单（非模态）、对话框/确认框（模态）、
                            频道列表（模态）、理解题（层内全屏覆盖）
L4 瞬态                     toast、离线标记、估价遮罩、拖拽盾
```

**关键区分**：L2 是「屏幕」，L2.5 是「同一屏幕的详情态」。详情态可以有自己的 URL 和历史帧，但不是新的一级/二级页面；因此它不需要独立的外壳，返回控件仍由所属屏幕提供。

### 1.2 屏幕类别定义

| 类别 | 例子 | 桌面外壳（≥lg） | 手机外壳（<md） | 页面级退出 | URL | 历史动作 |
|---|---|---|---|---|---|---|
| **L0 公开** | 欢迎、登录 | 无 | 无 | 登录页有「返回欢迎」 | 是 | 普通链接/`next` |
| **L1 tab** | 今日/内容/练习/我的 | Sidebar + TopBar | TopBar 精简 + BottomBar | 无（根） | 是 | 切换 replace |
| **T 任务型** | 视频、阅读器、书、复习、考试、定位、课程、句子 | 隐藏 Sidebar 与 tab；保留 TopBar 标题栏（桌面） | 无全局 chrome；页内 Header | BackButton | 是 | push |
| **P 面板型** | 报告、发现、博客、单词本、能力 | Sidebar + TopBar 标题/父级；保留页内 BackButton | 无全局 chrome；页内 Header | BackButton | 是 | push |
| **A 独立壳** | 管理台 | 自己的一屏（不套 Sidebar/TopBar） | 同左 | BackButton | 是（固定 profile 前缀） | push（受守卫） |
| **锚点** | `#/content/library`、`#/content/books` | 同 L1 | 同 L1 | 无（tab 根） | 是 | replace |
| **覆盖层** | 词卡、Dialog、频道列表、理解题 | 浮在当前屏上 | 同左 | Esc/遮罩/关闭 | 否 | 不写 history |
| **瞬态** | toast、离线标记、估价遮罩 | 全局 | 全局 | 自动/手动 | 否 | 不写 history |

### 1.3 同级 / 父子 / 同屏 / 覆盖

| 关系 | 定义 | 例子 | 历史动作 | 返回 |
|---|---|---|---|---|
| **同级** | 两个平级屏幕，彼此不是对方的上级 | 报告↔复习、发现→视频、单词本→文章 | **push** | 回上一个屏幕 |
| **父子** | tab→子视图；列表→详情；来源→原文；报告→证据视频 | 今日→报告、博客列表→文章、单词本→文章、报告→证据 | **push** | 回父级 |
| **同屏参数** | 同一个屏幕换参数，不产生新上下文 | 句子册 1→2、定位 intro→profile、博客文章 A→B？（文章 B 从列表进，见下） | **replace** | 无新增历史；返回仍回进入该屏的来源 |
| **覆盖** | 不改变当前屏幕，只在其上浮层 | 词卡、设置弹窗、频道列表、理解题 | **不写 history** | Esc/关闭回原屏 |
| **环境失效** | 语言等全局设置变化使当前屏内容失效 | 目标翻译语言切换 | replace 回 tab 根 | 不能返回旧语言内容 |

**边界**：博客文章 A→B（在文章底部点另一篇）如果组件提供「相关/下一篇」，按新文章 **push**；如果只是同屏切换锚点，用 replace。默认以「用户是否还能回到 A」判断：能回到 A → push；不能 → replace。

<a id="nm-02"></a>
### 1.4 外壳与出口（N-17 的答案）

- **任务型**是「工作台」：视频/阅读/做题需要宽度，隐藏侧栏，页内 BackButton 是唯一出口。
- **面板型**是「tab 的下钻页」：博客/报告/单词本是列表或档案，不是沉浸工作台；保留 Sidebar 让用户随时去别的 tab，同时保留 BackButton 回到局部父级。两个出口语义不同，不是重复：
  - Sidebar = **全局**：去任何一级页（会离开当前子视图）。
  - BackButton = **局部**：回当前子视图的来源/父级。
  - 顶栏/页内标题必须显示 `父级 tab`（面包屑），让用户知道「我在内容 › 官方博客」，从而理解两个出口的差别。
- **手机**：所有子视图都隐藏 BottomBar（避免误触导航丢上下文），页内 Header 必须首屏可见 BackButton。这条同时适用于面板型与任务型。

---

<a id="nm-03"></a>
## 2. URL 模型

### 2.1 语法（D-01）

```ebnf
hash        = "#" ( public | app | legacy )
public      = "/welcome" | "/login" [ "?next=" encodedAppHash ]
app         = "/" tab [ "/" segment *( "/" segment ) ] [ "?" query ]
tab         = "today" | "content" | "practice" | "profile"
segment     = sub | source | param | anchor
sub         = "review" | "report" | "placement" | "exam" | "discover"
            | "reader" | "sentences" | "blog" | "book" | "book-series"
            | "imported-book" | "learn" | "lesson" | "vocabulary"
            | "ability" | "admin"
anchor      = "library" | "books"
query       = "view=profile"            ; 仅 placement
            | 其他未来参数（未知参数忽略）
```

**规范形态**：`#/<来源 tab>/<子视图>[/<参数>]`；`learn` 与 `lesson` 也从属于来源 tab：

| 子视图 | 规范 URL 模板 | 旧 URL（兼容读入，一次性重写） |
|---|---|---|
| 复习 | `#/<tab>/review` | `#/today/review`、`#/practice/review`（已符合） |
| 报告 | `#/<tab>/report` | `#/today/report`、`#/profile/report`（已符合） |
| 定位/画像 | `#/<tab>/placement[?view=profile]` | 已符合 |
| 考试 | `#/<tab>/exam` | 已符合 |
| 发现 | `#/<tab>/discover` | 已符合 |
| 阅读器 | `#/<tab>/reader[/<articleId>]` | 已符合 |
| 句子精背 | `#/<tab>/sentences/<levelId>` | 已符合 |
| 博客 | `#/<tab>/blog[/<slug>]` | 已符合 |
| 公版书/书系/导入书 | `#/<tab>/book/<id>`、`book-series/<id>`、`imported-book/<id>` | 已符合 |
| 学习页 | `#/<tab>/learn/youtube/<videoId>`、`#/<tab>/learn/local/<showId>/S<ss>E<ee>`、`#/<tab>/learn/library/<itemId>` | **`#/learn/...` → `#/content/learn/...`** |
| 课程 | `#/<tab>/lesson/<lessonId>` | **`#/lesson/...` → `#/today/lesson/...`** |
| 单词本 | `#/<tab>/vocabulary` | 已符合 |
| 能力档案 | `#/<tab>/ability` | 已符合 |
| 管理台 | `#/profile/admin`（固定，D-10） | `#admin`、`/admin` 重写；`#/<其他 tab>/admin` 也规范化为 `#/profile/admin` |
| 内容锚点 | `#/content/library`、`#/content/books` | 前者是当前被丢弃的别名，现成为合法锚点（D-05） |
| 欢迎/登录 | `#/welcome`、`#/login[?next=...]` | — |

**为什么不是 source-absolute + `?from=`**：见 D-01。前缀让 `parseRoute`/`toHash` 对所有应用页面互逆，也让「分享/刷新后返回落点」天然正确；`learn` 的内容身份仍由子路径表达，不冲突。

<a id="nm-05"></a>
### 2.2 URL 里放什么 / 不放什么

| 状态 | 放 URL？ | 理由/实现 |
|---|---|---|
| 当前 tab、子视图 kind、内容 id/slug | **必须** | 刷新/分享恢复 |
| 来源 tab | **必须**（第一段） | 返回落点，N-02/N-04/N-12 |
| 定位视图 `view=profile` | **必须** | 刷新恢复；同屏 replace |
| 内容区锚点 `library/books` | **必须**（D-05） | 深链/书签/侧栏快捷 |
| 博客文章 slug、阅读器文章 id | **必须** | N-01/N-08；进入详情 push |
| 单词本 tab/筛选/页码 | 可 `sessionStorage` | 会话内恢复；不值得分享 |
| 发现页查询与结果 | 可 `sessionStorage` | 结果含 LLM 花费，刷新不自动重跑 |
| 词卡、对话框、频道面板、toast | **否** | 瞬态；路由变化即关闭 |
| 播放秒数、滚动位置 | 否（进度另存后端/本地） | 刷新按缓存/进度恢复 |
| 理解题打开状态 | 否（D-12） | 刷新回学习页 |
| 目标翻译语言 | 否（全局设置） | 切换时关闭依赖语言的子视图（D-11） |

<a id="nm-06"></a>
### 2.3 路由清单（全量屏幕）

> 「默认来源 tab」只用于旧 URL/无来源兜底；新 URL 第一段就是实际来源。所有屏幕的刷新恢复都不自动触发付费处理（IA R7）。**每一屏的出口与返回落点见 §4 返回目标表，跨屏入口/出口见 §6 跳转矩阵。**

| # | 屏幕 | 规范 URL 模板 | 类 | 默认来源 | 主要入口 | 无历史返回兜底 |
|---|---|---|---|---|---|---|
| 1 | 今日 | `#/today` | L1 | today | 底栏/侧栏/品牌/欢迎页/登录成功 | — |
| 2 | 内容 | `#/content` | L1 | content | 底栏/侧栏/欢迎页/今日空态 | — |
| 3 | 练习 | `#/practice` | L1 | practice | 底栏/侧栏 | — |
| 4 | 我的 | `#/profile` | L1 | profile | 底栏/侧栏/顶栏头像 | — |
| 5 | 复习 | `#/<tab>/review` | T | practice | 今日复习卡、练习主卡、报告「去复习」 | 来源 tab |
| 6 | 本周报告 | `#/<tab>/report` | P | today | 今日卡、我的行、内容右栏、侧栏 | 来源 tab |
| 7 | 定位/画像 | `#/<tab>/placement[?view=profile]` | T | practice | 今日引导条、练习卡、能力页重测 | 来源 tab |
| 8 | 考试 | `#/<tab>/exam` | T | practice | 练习卡 | 来源 tab |
| 9 | 内容发现 | `#/<tab>/discover` | P | content | 内容次入口、粘贴框搜索、侧栏 | 来源 tab |
| 10 | 阅读器列表 | `#/<tab>/reader` | T | content | 内容阅读入口、今日最近文章、侧栏 | 来源 tab |
| 11 | 阅读器详情 | `#/<tab>/reader/<articleId>` | T | content | 列表、单词本来源、今日最近 | 列表（同 tab） |
| 12 | 句子精背 | `#/<tab>/sentences/<levelId>` | T | content | 内容素材卡、侧栏、单词本来源 | 来源 tab |
| 13 | 博客列表 | `#/<tab>/blog` | P | content | 内容页脚、我的关于、侧栏、欢迎页 | 来源 tab |
| 14 | 博客文章 | `#/<tab>/blog/<slug>` | P | content | 列表、分享链接 | 列表（同 tab） |
| 15 | 公版书阅读器 | `#/<tab>/book/<bookId>` | T | content | 内容书架、书系、单词本来源、今日最近 | 来源 tab（书系→书：来源=书系） |
| 16 | 书系 | `#/<tab>/book-series/<seriesId>` | T | content | 内容书架、书阅读器「同系列」 | 来源 tab |
| 17 | 导入书阅读器 | `#/<tab>/imported-book/<bookId>` | T | content | 内容书架、今日最近、单词本来源 | 来源 tab |
| 18 | 学习页（YouTube） | `#/<tab>/learn/youtube/<videoId>` | T | content | 今日/内容粘贴、订阅更新、最近学习、推荐、发现候选、证据回看、单词本来源 | 来源 tab |
| 19 | 学习页（本地剧集） | `#/<tab>/learn/local/<showId>/S<ss>E<ee>` | T | content | 内容 ShowBrowser、最近学习、证据回看、单词本来源 | 来源 tab |
| 20 | 学习页（免费库视频） | `#/<tab>/learn/library/<itemId>` | T | content | 内容免费资源视频卡、单词本来源 | 来源 tab |
| 21 | 免费库文章阅读器 | `#/<tab>/learn/library/<itemId>`（文章分支） | T | content | 内容免费资源文章卡、单词本来源 | 来源 tab |
| 22 | 课程 | `#/<tab>/lesson/<lessonId>` | T | today | 今日课程/小说卡、学习页「生成课程」 | 来源 tab |
| 23 | 单词本 | `#/<tab>/vocabulary` | P | profile | 顶栏、侧栏、学习页头部、我的行、旧收藏别名 | 来源 tab |
| 24 | 能力档案 | `#/<tab>/ability` | P | profile | 我的行、定位结果 | 来源 tab |
| 25 | 管理台 | `#/profile/admin` | A | profile | 我的管理员行、侧栏、`#admin`、`/admin` | profile（拒绝则 profile） |
| 26 | 内容·免费库锚点 | `#/content/library` | 锚点 | content | 侧栏「免费库」、旧分享链接 | 内容页顶部（无返回） |
| 27 | 内容·公版书锚点 | `#/content/books` | 锚点 | content | 侧栏「公版书」 | 内容页顶部 |
| 28 | 欢迎页 | `#/welcome` | L0 | — | 空 hash（匿名/游客）、登录页返回 | — |
| 29 | 登录页 | `#/login[?next=...]` | L0 | — | 欢迎页 CTA、深链 | 欢迎页 |

<a id="nm-07"></a>

**别名/兼容**

| 旧地址 | 行为 |
|---|---|
| `#/learn/youtube/<id>`（无 tab） | replace 为 `#/content/learn/youtube/<id>` |
| `#/learn/local/...`、`#/learn/library/...` | 同上，默认 content |
| `#/lesson/<id>` | replace 为 `#/today/lesson/<id>` |
| `#/profile/favorites` | replace 为 `#/profile/vocabulary` |
| `#/content/library` | **不再丢弃**；解析为 content 锚点（D-05） |
| `#/content/books` | 解析为 content 锚点 |
| `#admin` | replace 为 `#/profile/admin` |
| `#/<tab>/admin`（tab≠profile） | replace 为 `#/profile/admin`（管理台不按来源 tab 变前缀，D-10） |
| `/admin`（path） | SPA fallback 后 replace 为 `#/profile/admin`；只处理一次 |
| 空 hash / `#` / `#/` | 匿名/游客 → `#/welcome`；已登录 → `#/today`（replace，不留幽灵条目） |
| 非法 hash / 非法参数 | `#/today` + 一次性 toast（D-07） |

### 2.4 query 与编码

- `placement` 只认 `view=profile`，其他值按 `intro`（同旧行为）。
- `login` 的 `next` 只接受应用内 hash（`#/...` 或 `/...`），解码后必须是合法路由；非法则忽略，登录后去 `#/today`。只允许相对 hash，禁止 `http(s)://`（防开放重定向）。
- 路径段一律 `encodeURIComponent`；解析时 `decodeURIComponent`，失败则按原字符串处理并最终走非法路由兜底。
- 未知 query 参数忽略，不报错；不得把未知参数写回地址栏（canonical 化时丢弃）。

---

<a id="nm-04"></a>
## 3. 历史语义（push / replace / back）

### 3.1 唯一决策表

| 用户动作 | API | history | 深度 | 说明 |
|---|---|---|---|---|
| 点一级 tab（非当前，或当前有子视图） | `go(tab)` | `replaceState` | **0** | tab 切换不堆历史（IA §7.3 保留） |
| 点当前 tab 且当前有子视图 | `go(tab)` | `replaceState` | **0** | 退出子视图，回该 tab 根 |
| 点当前 tab（已在根页） | `navigateTab` 特例 | 不写 | 不变 | 平滑回顶；不产生历史 |
| tab 根 → 子视图 | `open(sub)` | `pushState` | +1 | URL 第一段=当前 tab |
| 子视图 → 子视图（同级/父子） | `open(sub)` | `pushState` | +1 | D-02；不再 replace |
| 列表 → 详情（博客/阅读器） | `open(same screen detail)` | `pushState` | +1 | 浏览器后退回列表 |
| 同屏参数（句子册、定位视图） | `replace(state)` | `replaceState` | 不变 | 不堆历史 |
| 页面 BackButton | `back()` | `history.back()`（深度>0）或 replace 父级 | -1/不变 | 见 §4 |
| 浏览器后退/前进 | 原生 | 原生 | 读取 state | `popstate` 同步；不拦截 |
| 深链/刷新进入 | mount | `replaceState` canonical | **0** | 没有应用内历史；页内返回走父级兜底 |
| 别名/非法路由规范化 | `replaceState` | 不变 | 保持 | 一次完成；非法给一次 toast |
| 目标语言切换（D-11） | `replace({tab,sub:null})` | replace | 0 | 关闭依赖语言的子视图 + toast |
| 退出登录 | `replace('#/welcome')` | replace | 0 | 清空应用内导航状态 |
| 打开对话框/词卡/频道/理解题 | 无 | 不写 | 不变 | 覆盖层不占历史（D-12） |

### 3.2 深度与 history.state

`useNav` 不再用 `history.length` 判断能否返回。每次 `pushState` 写入：

```ts
window.history.pushState(
  { dshNav: { depth: currentDepth + 1 } },
  '',
  toHash(next),
);
```

- `replaceState` 保持当前 depth（tab 根、退出登录、语言失效写 0；别名规范化保持原 depth）。
- `popstate` 从 `event.state?.dshNav?.depth` 读深度；没有标记（外部进入、旧页面）→ 0。
- 深链 mount：state 里没有 `dshNav` → depth 0，并 `replaceState` 写入 canonical hash 与 `depth: 0`。
- 浏览器前进到已 push 的帧：state 里有 depth，恢复。
- **`history.length > 1` 不再作为判断依据**（它包含站外历史，深链会误判可回退，是 N-03 的一半根因）。

### 3.3 禁止

- 禁止在组件里直接 `window.location.hash = ...` 做应用内导航（公开页欢迎/登录的链接与登录成功重写除外，且必须走定义好的 replace）。
- 禁止在已有子视图时用 `replace` 做「前进」（D-02 例外：同屏参数、环境失效、缓存缺失回落）。
- 禁止 push 与当前 `sameRoute` 相同的 URL（会制造重复历史条目）。
- 禁止用 `history.back()` 实现「关闭当前页」而不检查深度（深链会离开应用）。

---

<a id="nm-08"></a>
## 4. 返回目标表

**规则**：
1. 有应用内历史（depth > 0）→ 一律 `history.back()`（路由帧层面：浏览器后退 = 页面 BackButton = 安卓硬件返回；覆盖层例外见 §10）。
2. 无应用内历史（depth = 0，深链/刷新）→ `replace` 到下表「无历史兜底」，**不得离开应用**。
3. 详情页在无历史时回**列表**（不是 tab 根）；无列表可回时回来源 tab。
4. 管理台拒绝（非管理员）→ `replace` 到 `#/profile` + toast；管理台正常关闭 → 回来源（history）或 profile（兜底）。
5. 覆盖层不参与上表；关闭覆盖层不改路由（Esc/关闭/遮罩）。

| 当前屏幕 | 有历史 → | 无历史兜底 | BackButton 文案 | 备注 |
|---|---|---|---|---|
| L1 tab 根 | 浏览器后退离开（原生） | — | 不显示 | 点当前 tab = 回顶 |
| `review` | 上一个帧 | `#/<tab>` | 返回 | 进行中退出需确认（IX-24） |
| `report` | 上一个帧 | `#/<tab>` | 返回 | 证据→视频是 push，返回报告 |
| `placement` | 上一个帧 | `#/<tab>` | 返回 | 答题中退出确认；`view=profile` 同屏 replace |
| `exam` | 上一个帧 | `#/<tab>` | 返回 | 进行中退出确认 |
| `discover` | 上一个帧 | `#/<tab>` | 返回 | 结果在 sessionStorage |
| `reader`（列表） | 上一个帧 | `#/<tab>` | 返回 | 列表滚动恢复 |
| `reader/<articleId>` | 上一个帧（通常是列表） | `#/<tab>/reader` | 返回列表 | N-08；进度已保存 |
| `sentences` | 上一个帧 | `#/<tab>` | 返回 | 册切换 replace |
| `blog`（列表） | 上一个帧 | `#/<tab>` | 返回 | 列表滚动恢复 |
| `blog/<slug>` | 上一个帧（通常是列表） | `#/<tab>/blog` | 返回列表 | N-01；分享链接刷新回文章 |
| `book` | 上一个帧（可能是书系/单词本/今日） | `#/<tab>` | 返回 | N-07；书系→书是 push |
| `book-series` | 上一个帧（可能是书） | `#/<tab>` | 返回 | 书→书系是 push，符合「回上一个」 |
| `imported-book` | 上一个帧 | `#/<tab>` | 返回 | — |
| `learn/*` | 上一个帧 | `#/<tab>` | 返回 | 缓存缺失恢复页的返回也走此表 |
| `lesson/<id>` | 上一个帧 | `#/<tab>` | 返回 | 课程进度在后端 attempt |
| `vocabulary` | 上一个帧（学习页/今日/内容/我的） | `#/<tab>` | 返回 | 单词本→来源是 push（N-18） |
| `ability` | 上一个帧 | `#/<tab>` | 返回 | — |
| `admin` | 上一个帧 | `#/profile` | 返回 | 拒绝 → profile + toast |
| 锚点 `#/content/library`、`#/content/books` | 无返回控件 | — | — | 侧栏/底栏切走即可 |
| `welcome` | 无返回控件 | — | — | 外部落地页 |
| `login` | 回到欢迎 | — | 返回欢迎 | 登录成功 → `next` 或 today |
| 覆盖层 | 无路由变化 | — | Esc/关闭 | 不进入本表 |

**三条可写成 QA 的判定**：
- 从任意入口打开任意子视图 → 点 BackButton → 是否回到**刚才那一屏**（不是「归属 tab」）？有历史时必须「是」。
- 复制深链在新标签页打开 → 点 BackButton → 是否停在本应用内的父级/列表（不是空白页/上一站点）？必须「是」。
- 从 A 屏打开 B 屏，再打开 C 屏，连续返回 → 是否按 C→B→A 顺序退？必须「是」（D-02）。

---

<a id="nm-09"></a>
## 5. 返回控件、标题与面包屑

### 5.1 BackButton（I-11 的答案）

全站页面级返回只有一个实现：

| 属性 | 规范 |
|---|---|
| 视觉 | `ArrowLeft` + 可选文字；`h-9 px-2 -ml-2 rounded-lg`；`text-zinc-300 hover:text-zinc-100 hover:bg-white/5`；焦点用全局环 |
| 文字 | ≥sm 显示「返回」；窄屏可只留图标但有 `aria-label` |
| aria-label | `返回<父级>`，父级由 `backLabelFor(state)` 给出（如今日/内容/列表/报告） |
| 位置 | 页面 Header 左上，首屏可见；不得被滚动容器裁掉 |
| 行为 | `back()`；有输入 dirty 时先确认（IX-15）；有历史回来源，无历史回父级（§4） |
| 例外 | 登录页「返回欢迎」是公开页链接，不是 App 内 back；管理台用自己的壳但同用 BackButton |

**禁止**：页面级 X（关闭）与 ← 并存；`h-7/h-8` 混用；`-ml-1/-ml-3` 各自为政；永远显示文字 vs 只在 ≥sm 显示文字的分裂。Review/Report/Exam/Placement/Ability/Discover 现有的 X 全部替换为 BackButton（D-04）。

### 5.2 标题/面包屑

| 屏幕 | 桌面 ≥lg | 手机 <md |
|---|---|---|
| L1 tab | TopBar：标题=tab 名；副标题=一句话定位 | TopBar：当前 tab 名；BottomBar 高亮 |
| P 面板型子视图 | TopBar：标题=子视图名；副标题=`父级 tab`（面包屑）；页内 H1=子视图名 | 页内 Header：BackButton + H1；无全局标题 |
| T 任务型子视图 | 桌面 TopBar 可显示「父级 tab / 子视图」；页内 Header 以内容标题为主（学习页标题=视频/文章标题，feature label=类型；阅读器=文章标题） | 同左（无 TopBar） |
| A 管理台 | 自己的 Header：标题 + BackButton + 仅管理员标识 | 同左 |
| L0 | 欢迎/登录自己的标题 | 同左 |

**面包屑规则**：
- 分隔符统一 `›`（或 `/`，A2 定视觉），格式 `父级 tab › 当前屏`；不得省略父级。
- 面包屑是**信息**，不是第三个导航入口；父级跳转由 BackButton/Sidebar 承担（避免用户点面包屑绕过未保存确认）。
- 管理台、公开页不显示 tab 面包屑。
- 面包屑只在 ≥md 显示；手机用 BackButton 的 aria-label 表达父级。

### 5.3 计数与入口一致性（N-10）

- 单词本计数只有一个 `formatCount(count)`：`>99 → "99+"`，其余原数字；顶栏、侧栏、学习页头部、我的行、底栏徽章全部调用它。
- 入口矩阵中的同一目标只允许一套名称/图标/计数格式；Sidebar 快捷入口与主入口同源。
- 徽章 `99+` 上限同时适用于练习到期数（`formatDueBadge` 已存在，合并到同一工具）。

### 5.4 关闭（X）只用于覆盖层

- 对话框、词卡、频道列表、分享卡、估价确认：X/关闭按钮，`aria-label=common.close`。
- 全屏页面：不用 X；用 BackButton（D-04）。
- 页面内的「完成/提交/退出」是业务动作，不是导航关闭；按 IX-24 确认。

---

<a id="nm-10"></a>
## 6. 跨屏跳转矩阵

> 「动作」指规范要求。`push` 表示新增历史帧；`replace` 表示不新增。返回列指执行后的 BackButton/浏览器后退落点。所有入口都必须带来源 tab（URL 第一段）。

| # | 从 | 入口/动作 | 到 | 动作 | 返回落点 | 需修改/原因 |
|---|---|---|---|---|---|---|
| J01 | 任意 tab | 底栏/侧栏/品牌 | 对应 tab 根 | replace | — | 保持（tab 不堆历史） |
| J02 | 今日 | 继续学习卡/最近学习 | `#/today/learn/...` | push | 今日 | — |
| J03 | 今日 | 粘贴链接（估价确认后） | `#/today/learn/youtube/<id>` | push | 今日 | 估价失败需确认（IX-12） |
| J04 | 今日 | 复习卡 | `#/today/review` | push | 今日 | — |
| J05 | 今日 | 报告卡 | `#/today/report` | push | 今日 | — |
| J06 | 今日 | 定位引导条 | `#/today/placement` | push | 今日 | **修复 N-12 同类：来源今日** |
| J07 | 今日 | 课程/小说卡 | `#/today/lesson/<id>` | push | 今日 | — |
| J08 | 内容 | 粘贴链接（确认后） | `#/content/learn/youtube/<id>` | push | 内容 | — |
| J09 | 内容 | 发现入口/搜索 | `#/content/discover` | push | 内容 | — |
| J10 | 内容 | 读文章入口/粘贴文章 | `#/content/reader[/<id>]` | push | 内容 | 游客门禁见 IX-17 |
| J11 | 内容 | 句子素材卡 | `#/content/sentences/<level>` | push | 内容 | — |
| J12 | 内容 | 免费库视频/文章 | `#/content/learn/library/<id>` | push | 内容 | **先路由后加载（I-14）** |
| J13 | 内容 | 书架/书系 | `#/content/book...` | push | 内容 | — |
| J14 | 内容 | 订阅频道/最新视频 | `#/content/learn/youtube/<id>` | push | 内容 | 先确认估价 |
| J15 | 内容 | 页脚博客 | `#/content/blog` | push | 内容 | — |
| J16 | 内容 | 右栏「本周报告」 | `#/content/report` | push | 内容 | **修复 N-02** |
| J17 | 练习 | 复习主卡 | `#/practice/review` | push | 练习 | — |
| J18 | 练习 | 考试卡 | `#/practice/exam` | push | 练习 | 游客门禁 |
| J19 | 练习 | 定位卡 | `#/practice/placement` | push | 练习 | — |
| J20 | 我的 | 单词本行 | `#/profile/vocabulary` | push | 我的 | — |
| J21 | 我的 | 报告行/能力/管理台 | `#/profile/report`、`#/profile/ability`、`#/profile/admin` | push | 我的 | — |
| J22 | 单词本 | 来源文章/书/句包/视频 | `#/<tab>/reader`、`book`、`sentences`、`learn...` | **push** | **单词本** | **修复 N-18：不再先 replace 掉单词本** |
| J23 | 学习页 | 头部单词本 | `#/<tab>/vocabulary` | push | 学习页 | 保留当前视频 |
| J24 | 报告 | 证据「回看」 | `#/<tab>/learn/...` | push | 报告 | **修复 N-03 链路：不再 replace 报告** |
| J25 | 报告 | 「去复习」 | `#/<tab>/review` | push | 报告 | **修复 N-03：返回报告而非 tab** |
| J26 | 发现 | 候选「开始」 | `#/<tab>/learn/youtube/<id>` | push | 发现 | **I-14：不先 replace 回内容** |
| J27 | 博客列表 | 文章 | `#/<tab>/blog/<slug>` | push | 博客列表 | **修复 N-01/N-08** |
| J28 | 阅读器列表 | 文章 | `#/<tab>/reader/<id>` | push | 阅读器列表 | **修复 N-08** |
| J29 | 书阅读器 | 「同系列」（书系） | `#/<tab>/book-series/<id>` | push | 书 | **N-07：返回语义=回到来处** |
| J30 | 书系 | 选书 | `#/<tab>/book/<id>` | push | 书系 | 同上 |
| J31 | 学习页 | 「生成课程」成功 | `#/<tab>/lesson/<id>` | push | 学习页 | 生成中防重复 |
| J32 | 欢迎 | CTA | `#/login`、`#/today`、`#/content`、`#/content/blog` | 链接/replace | 公开页 | 登录 next |
| J33 | 登录 | 成功 | `next` 或 `#/today` | replace | — | **修复 N-15** |
| J34 | 管理台 | 非管理员/被拒 | `#/profile` | replace | — | **修复 N-14**；先 toast |
| J35 | 侧栏 | 免费库/公版书 | `#/content/library`、`#/content/books` | replace + 滚动 | 内容锚点 | **修复 N-06** |
| J36 | 侧栏 | 历史 | `#/today` + 滚动到历史 | replace | 今日 | 可选锚点（P2） |
| J37 | 任意子视图 | 点同一 tab | 该 tab 根 | replace | — | 退出子视图 |
| J38 | 任意 | 浏览器后退 | 上一帧 | 原生 pop | 上一帧 | 深度 0 时离开站点（正常） |

**标注**：J16/J22/J24/J25/J26/J27/J28/J29/J30/J33/J34/J35 是本轮必须改的跳转（与 N-01/N-02/N-03/N-06/N-07/N-08/N-15/N-18 对应）。

---

<a id="nm-11"></a>
## 7. 需要修改的跳转（N 清单）

| A1 ID | 现状 | 规范要求 | 代码落点 |
|---|---|---|---|
| N-01 | `#/content/blog/<slug>` 打开列表；点文章 URL 不变 | `BlogScreen` 接受 slug；列表→文章 push，文章→列表 back；刷新/分享恢复文章 | `App.tsx:3169` 传 slug；`BlogScreen.tsx:259-300` 受控 |
| N-02 | 内容页打开报告/复习，tab 被改成今日/练习 | URL 第一段=来源 tab；`#/content/report`、`#/content/review` 合法；`tabForSub` 不再改写 | `nav.ts:138-153`；`App.tsx:2061` |
| N-03 | 子视图互相 replace，`canGoBackRef` 仍 true，返回越过一层 | 所有前进 push；replace 不再承担「换成另一个屏幕」；深度随 history.state | `useNav.ts:55-69`；`App.tsx:1001-1004` |
| N-04 | `#/learn` 不写来源 tab，刷新后返回内容 | 全前缀：`#/<tab>/learn/...`；旧 URL 重写为 content | `nav.ts:244-263`；`toHash` |
| N-05 | 本地剧集无缓存 toast + 弹回内容 | 恢复页（尚未处理 + 开始/返回），不自动处理 | `App.tsx:1414-1432`；`restoreLearnRoute` |
| N-06 | `#/content/library` 被丢弃；锚点靠 setTimeout | 锚点进 URL；内容页按 state 滚动；删除轮询 | `nav.ts:234-236`；`App.tsx:2241-2251` |
| N-07 | 书↔书系互相 replace，返回语义不清 | 两者都是 push；面包屑=归类，Back=来处；深链兜底内容 | `App.tsx:3176/3186`；`openSub` |
| N-08 | 阅读器/博客/发现内部层级不写 URL | 文章 id/slug 进 URL；列表→详情 push；发现查询留 sessionStorage | `ReaderScreen.tsx:235`；`BlogScreen.tsx:259` |
| N-09 | 免费库文章与视频共用路由但 chrome 不同 | 共用学习页 Header（标题=文章，feature=免费资源）；页面级 BackButton | `LibraryArticleReader.tsx:71`；`LearningHeader` |
| N-10 | 单词本 4 处入口计数格式不一 | `formatCount` 单一来源（99+） | `AppShell.tsx:189`、`LearningHeader.tsx:71`、`Sidebar.tsx`、`AccountScreen.tsx:325` |
| N-11 | 非法路由静默回落 | 合法化不支持的尽量支持；真非法 → today + 一次性 toast | `nav.ts:159-174`；`useNav` mount |
| N-12 | 今日定位落 practice，关闭回练习 | `#/today/placement`；关闭回今日 | `nav.ts:111-113`；`App.tsx:2031` |
| N-13 | 三个旧别名静默改写；`/admin` 500ms | 别名保留 + 一次规范化；`/admin` auth ready 即判；文案提示可选 | `nav.ts:191-195/234-236`；`App.tsx:2324-2341` |
| N-14 | 管理台守卫固定 500ms×2 | auth ready + `isAdmin` 已知即判定；拒绝 toast + replace profile | `App.tsx:2304-2341` |
| N-15 | 匿名访问 hash 与登录后目标丢失 | 匿名保留 hash；登录后就地渲染；`#/login?next` 回跳 | `App.tsx:3490-3532` |
| N-16 | 切 tab 回零；点当前 tab 回顶，两套「回顶」 | tab 滚动位置记忆；只有点当前 tab 才回顶 | `App.tsx:1011-1020`；`useNav` |
| N-17 | 面板型同时有侧栏与页内返回，任务型只有页内返回 | D-03：双壳明确 + 面包屑；两个出口语义不同 | `AppShell.tsx:93-110/159-163`；`TASK_SUB_KINDS` |
| N-18 | 单词本跳内容前 replace 掉单词本，返回落到「我的」 | 单词本→来源 push；返回单词本 | `App.tsx:1046-1050`；`closeWordbookForJump` 删除 |

---

<a id="nm-12"></a>
## 8. 公开页 / 登录 / 管理台边界

### 8.1 公开页

- `#/welcome` 与 `#/login` 是 **L0**，不进入 `{tab, sub}` 的「应用帧」；不显示 Sidebar/BottomBar。
- 空 hash：`status` 为 `anonymous` / `guest` → `replace('#/welcome')`；`authenticated` → `#/today`。欢迎页不得留下幽灵历史条目（用 replace）。
- 欢迎页 CTA 用普通链接 `<a href="#/...">`（会新增历史条目，符合「从公开页进入应用」的预期）；`#/login` 保留「返回欢迎」。
- 匿名用户访问应用路由：**保留 hash**，渲染登录界面；登录成功后 `AuthGate` 直接渲染 `AppContent`，由 `useNav` 解析原 hash → 原目标。不得重写 `#/today`。
- `#/login?next=<hash>`：登录成功后 `replace(next)`；`next` 非法/跨域 → `#/today`。登录页自身成功后 `replace`，不保留 `#/login` 在历史里（否则后退又回登录）。

### 8.2 管理台（D-10）

- 路由固定 `#/profile/admin`；不从 URL 第一段取来源 tab。
- 守卫条件：`status !== 'loading' && isAdmin !== undefined`；不满足时显示加载占位；非管理员 → `toast.error(admin.error.forbidden)` + `replace('#/profile')`；只提示一次。
- `/admin` path：SPA fallback 后**一次**重写为 `#/profile/admin`；不再固定等 500ms；auth ready 即判。
- 管理台内部二级 tab（概览/用户/设置/用量）**不进 URL**（本轮的取舍）；刷新回概览。若后续要分享，再加 `?tab=`。
- 管理员关闭：有历史 → back；无历史 → `#/profile`。
- 公开页与主应用边界：管理台、登录页、欢迎页均不显示 BottomBar；登录成功/退出登录后不得留下公开页与主应用交错的无效历史（退出登录用 replace welcome）。

### 8.3 退出登录

- 退出成功后 `replace('#/welcome')`，清空 `dshNav` 深度与任何 `pendingRoute`；不保留个人页面在可后退历史里（隐私）。
- 若退出请求失败但仍本地登出：给 error toast（沿用 `auth.tsx` 行为），导航仍回 welcome。

---

<a id="nm-13"></a>
## 9. 滚动与回顶（N-16）

| 场景 | 规范 |
|---|---|
| 切到别的 tab 再切回 | 恢复该 tab 上次滚动位置（sessionStorage，按 tab 键） |
| 点击当前 tab（已在根页） | 平滑回顶（唯一「回顶」语义） |
| 页面内返回（列表→详情→返回） | 恢复列表滚动位置；不回到顶部 |
| 打开新的子视图 | 从顶部开始（学习页除外：按进度恢复播放/字幕位置） |
| 从子视图返回来源 tab | 恢复来源 tab 滚动位置 |
| 锚点 `#/content/library` | 数据/区块渲染后滚动到区块，带 `scroll-padding-top`；失败时停在该区块并显示错误 |
| 浏览器后退到详情 | 详情滚动位置可恢复（sessionStorage，按 hash 键）；至少恢复阅读进度 |

**实现建议**：`data-page-scroll` 容器按 `tab` 记录 `scrollTop`；子视图用 `useEffect` 在内容就绪后恢复 `scrollIntoView`；删除 `setTimeout` 轮询，改为「路由参数 + 数据就绪回调」。

---

<a id="nm-14"></a>
## 10. 平台返回 / 手势 / PWA（I-20）

| 环境 | 行为 | 规范 |
|---|---|---|
| 浏览器（桌面/移动） | 浏览器后退键 = `popstate` | 与页面 BackButton 同义；深链深度 0 时离开站点（正常） |
| Android 硬件返回 | 触发 `popstate` | 同上；不额外监听 |
| iOS 边缘手势 | 触发 `popstate` | 同上；不可拦截 |
| PWA standalone | 深度 0 时返回会退出应用 | **P2 目标**：首次返回拦截并提示「再按一次退出」；本轮暂不实现（需真机验证 standalone 判定） |
| 理解题（层内覆盖） | 浏览器后退会离开学习页 | **已知边界**（D-12）；P2 可加 history guard：打开时 push 同 URL 哨兵，pop 时先关覆盖层 |

**QA**：逐项验证「浏览器后退 / 页面 BackButton / 安卓返回」在同一状态下落点一致；唯一例外是深度 0（浏览器离开站点）与覆盖层（D-12）。

---

<a id="nm-15"></a>
## 11. 待决策（不硬编）

| ID | 问题 | 当前规范默认 | 何时定 |
|---|---|---|---|
| Q-01 | 发现页查询是否进 URL（可分享的搜索结果） | 否，`sessionStorage`（结果含 LLM 花费，刷新不重跑） | A4 实施前；若要分享再加 `?q=` |
| Q-02 | 单词本 tab/筛选/页码是否进 URL | 否，`sessionStorage`；刷新回默认 tab | P2 |
| Q-03 | 管理台内部 tab 是否进 URL | 否，刷新回概览 | P2 |
| Q-04 | 理解题浏览器后退是否拦截 | 否（D-12 已知边界） | P2 评估 history guard |
| Q-05 | PWA 根页退出拦截 | 暂不实现（§10） | 上线前真机验证 |
| Q-06 | 目标语言切换是否保留当前阅读/视频位置 | 当前默认：关闭依赖语言的子视图并回 tab 根 + toast（D-11） | 若用户反馈强烈，可改为「保留路由 + 重新加载」 |
| Q-07 | 课程生成成功后是否算「学习页的子视图」 | 是：`#/<tab>/lesson/<id>`，push，返回学习页 | 已定 |
| Q-08 | 书→书系是否算「向上」 | 书系是分类页；从书进入按**新目的地** push，返回书（历史语义）；面包屑不决定返回 | 已定（D-02） |

---

<a id="nm-16"></a>
## 12. 实施契约：`nav.ts` / `useNav`

### 12.1 类型

```ts
export type TabId = 'today' | 'content' | 'practice' | 'profile';

export type SectionAnchor = 'library' | 'books';

export interface NavState {
  /** 来源/返回锚点 tab（不是「归属」）。 */
  tab: TabId;
  sub: SubRoute | null;
  /** tab 级区块锚点；与 sub 互斥。 */
  anchor?: SectionAnchor;
}

export type SubRoute = /* 保持现有 16 种 kind；learn/lesson 的 URL 由 tab 前缀承载 */;
```

- `TAB_IDS` 可见顺序不变（content / practice / today / profile）；默认落地 `today`。
- `TASK_SUB_KINDS` 从 `App.tsx` 迁到 `nav.ts`（单一来源，供 AppShell 与 QA 使用）。
- `SUB_LABEL_KEYS` 可留在 App（i18n 依赖），但 `TASK_SUB_KINDS` 不重复定义。

### 12.2 纯函数

| 函数 | 契约 |
|---|---|
| `parseRoute(hash): NavState` | 解析所有规范形态；`#/<tab>/...` 第一段决定 `tab`；旧 `#/learn`、`#/lesson` 用默认 content/today；空/非法 → `FALLBACK`（today）。必须保留 `#/content/library`、`#/content/books` 为 anchor。 |
| `toHash(state): string` | **总是**输出 `#/<state.tab>...`（管理台/公开页例外）；与 `parseRoute` 互逆：对任意合法 state，`parseRoute(toHash(state))` 等于 state（忽略对象身份）。 |
| `tabOfSub(sub, fallback?)` | 仅用于旧 URL/无来源兜底：learn→content、course→today、review/exam/placement→practice、report→today、其余 profile/content 按表；**不再用于新导航**。 |
| `tabForSub(sub, currentTab)` | **恒等于 `currentTab`**（D-01/D-02）；管理台固定 profile（D-10）。保留函数名以减少迁移面。 |
| `parentOf(state): NavState 或 null` | 无历史兜底：详情→列表；其余子视图→`{tab:state.tab,sub:null}`；admin→profile；tab 根→null。 |
| `backLabelFor(state): TranslationKey/string` | 列表详情→「返回列表」；其余→「返回」；aria 需含父级名。 |
| `resolveRoute(hash)` | `{ state, canonical, kind: 'canonical' / 'legacy' / 'invalid' }`；帮助 `useNav` 决定是否 replaceState/toast。 |
| `sameRoute(a,b)` | 比较规范 hash；用于去重 push。 |
| `isTabPrefixedRoute(hash)` | 测试/QA 用：新 URL 必须为 true（公开页除外）。 |

**旧 URL 重写表**必须作为常量存在 `nav.ts`（单一来源），`useNav` 与 QA 共用：

```ts
const LEGACY: Array<{ test: RegExp; to: (m) => NavState; toast?: boolean }> = [
  { test: /^#?\/?learn\//, to: () => ({ tab: 'content', sub: /* parse rest */ }) },
  { test: /^#?\/?lesson\//, to: () => ({ tab: 'today', sub: /* parse rest */ }) },
  { test: /^#?\/?profile\/favorites$/, to: () => ({ tab: 'profile', sub: { kind: 'vocabulary' } }) },
  // #/content/library 不是 legacy，是 anchor
];
```

### 12.3 `useNav` 行为

```ts
interface NavApi {
  state: NavState;
  depth: number;                 // 只读，供 QA/调试；页面不依赖它渲染
  go(tab: TabId): void;          // replace tab 根，depth=0
  open(sub: SubRoute): void;     // push（当前 tab 为来源）；sameRoute 去重
  replace(state: NavState): void;// replace；同屏参数/环境失效；tab 根 depth=0
  openAnchor(anchor: SectionAnchor): void; // replace 到 #/content/<anchor>，depth=0
  back(): void;                  // depth>0 → history.back()；否则 replace(parentOf)；
  goHome(): void;                // replace today，depth=0
}
```

`commit` 伪代码：

```ts
function commit(next: NavState, mode: 'push' | 'replace') {
  const hash = toHash(next);
  if (mode === 'push') {
    depthRef.current += 1;
    history.pushState({ dshNav: { depth: depthRef.current } }, '', hash);
  } else {
    if (!next.sub && !next.anchor) depthRef.current = 0; // tab 根
    // 同屏参数/规范化保持 depth
    history.replaceState({ dshNav: { depth: depthRef.current } }, '', hash);
  }
  setState(next);
}
```

- `open(sub)`：`if (sameRoute(current, {tab: current.tab, sub})) return;`；管理台强制 `tab:'profile'`；其余 `commit({tab: current.tab, sub}, 'push')`。
- `back()`：`if (depthRef.current > 0) history.back(); else { const parent = parentOf(state); if (parent) commit(parent,'replace'); }`。
- `popstate`：`const d = event.state?.dshNav?.depth; depthRef.current = typeof d === 'number' ? d : 0; setState(canonicalize(parseRoute(location.hash)))`。
- `hashchange`：处理手改地址；视为外部进入，depth=0；canonical 化。`hashchange` 与 `popstate` 可能对同一次后退都触发，处理必须幂等（同一 hash 不重复 setState、不重复 toast）。
- 初次 mount：`parseRoute` + `resolveRoute`；legacy → replaceState canonical；invalid → replaceState today + 一次性 toast；depth=0；写入 `dshNav` 标记。
- **不要**根据 `history.length` 推断可返回。
- 路由变化回调里统一关闭覆盖层（词卡/ChannelVideoList/对话框）；`App` 的 `wordLookup`/`selectedChannel` 在 `state` 变化时清空。

### 12.4 App 侧渲染映射

- `state.sub` 的 switch 不再需要 `TASK_SUB_KINDS` 的重复定义；`isTaskView` 从 `nav.ts` 读取。
- `subLabel`、`featureLabel` 仍由 App 提供；面包屑的父级 tab 名从 `state.tab` 取。
- `reports/review/placement` 打开时不再调用 `tabForSub` 改写 tab；`open(sub)` 直接使用当前 tab。
- `closeWordbookForJump` 删除；单词本来源跳转直接 `open(target)`（push）。
- `handleOpenEvidence` 直接 `open({kind:'learn',...})`（push），不再依赖 `handleUrlSubmit` 的 replace 分支；若数据未准备好，先 push 学习路由 + 骨架。
- `handleDiscoverStart` 直接 `open({kind:'learn',...})`，不再先 `replace(content)`。
- `handleOpenLibraryVideo/Article` 先 `open({kind:'learn', source:'library', itemId})`，再在目标页加载（I-14）。
- `navigateTab`：当前 tab 且无 sub/anchor → 回顶；否则 `go(tab)`。
- `handleSelectSentenceLevel` 保持 `replace`（同屏参数）。
- `handleOpenPlacement('profile'|'intro')` 同屏用 replace；从今日/练习进入用 open。

### 12.5 验收/门禁

- `parseRoute(toHash(s)) === s` 对所有合法 `NavState` 成立（属性测试或手写用例）。
- 关键路径 QA（§13）全绿。
- `npx tsc -b` 通过；不引入新依赖。

---

<a id="nm-17"></a>
## 13. QA 判定项（可直接勾）

| ID | 检查项（是/否） | 依据 |
|---|---|---|
| QA-NAV-A3-01 | 在 tab 根页连续点不同 tab，浏览器后退**不会**逐个回退这些 tab（tab 切换不堆历史）；经子视图后切 tab 的落点按 §3.1 复盘 | NM-04 |
| QA-NAV-A3-02 | 从任意子视图点 BackButton，回到**刚才那一屏**（有历史时）；不是「归属 tab」 | NM-04/§4 |
| QA-NAV-A3-03 | 连续打开 A→B→C，连续返回按 C→B→A 退，不跳层 | D-02/N-03 |
| QA-NAV-A3-04 | 深链/刷新子视图后点 BackButton，停在本应用父级/列表，不离开站点 | §4 |
| QA-NAV-A3-05 | 今日打开报告→证据视频→返回，落回报告；报告→复习→返回，落回报告 | J24/J25/N-03 |
| QA-NAV-A3-06 | 内容页打开报告，URL 是 `#/content/report`，关闭回内容（不是今日） | N-02 |
| QA-NAV-A3-07 | 今日/内容/练习/我的打开学习页，URL 第一段分别是 today/content/practice/profile；刷新后返回落点一致 | N-04 |
| QA-NAV-A3-08 | 博客列表→文章→刷新，仍在文章；分享链接打开是文章；返回回列表 | N-01/N-08 |
| QA-NAV-A3-09 | 阅读器列表→文章→刷新，仍在文章；返回回列表 | N-08 |
| QA-NAV-A3-10 | 单词本→文章/书→返回，落回单词本；不是「我的」 | N-18 |
| QA-NAV-A3-11 | 报告→复习→返回，落回报告；不越过报告 | N-03 |
| QA-NAV-A3-12 | `#/content/library` 打开后停在免费库区块；侧栏「免费库」也落到该 URL | N-06 |
| QA-NAV-A3-13 | 旧 `#/learn/...`/`#/lesson/...`/`#profile/favorites`/`#admin` 均能打开并规范化为新 URL | §2.3 |
| QA-NAV-A3-14 | 非法 hash 回今日并出现一次可读提示，不静默 | N-11 |
| QA-NAV-A3-15 | 匿名访问 `#/content/discover`，登录后仍去发现页；`#/login?next=...` 生效 | N-15 |
| QA-NAV-A3-16 | 管理台非管理员在 auth ready 后立即被拦（无固定 500ms 白屏），toast 一次 | N-14 |
| QA-NAV-A3-17 | 切 tab 再切回，滚动位置恢复；点当前 tab 才回顶 | N-16 |
| QA-NAV-A3-18 | 桌面博客/报告/单词本：侧栏仍可用，页内 BackButton 回局部父级；视频/阅读器无侧栏 | N-17/D-03 |
| QA-NAV-A3-19 | 刷新学习页 10 次，网络面板中 process/estimate 调用为 0 | IA R7 |
| QA-NAV-A3-20 | 面板型/任务型/公开页/管理台的 BackButton 尺寸、位置、aria-label 一致 | I-11/D-04 |

---

## 14. 附：旧→新对照速查

| 旧行为 | 新行为 |
|---|---|
| `openSub` 有 sub 就 replace | 一律 push（同屏参数才 replace） |
| `back()` 看 `history.length` | 看 `history.state.dshNav.depth` |
| `#/learn/...` 不携带 tab | `#/<tab>/learn/...`；旧 URL 重写 content |
| `#/lesson/...` 不携带 tab | `#/<tab>/lesson/...`；旧 URL 重写 today |
| 报告只允许 today/profile | 任意来源 tab；`#/content/report` 合法 |
| 复习只允许 today/practice | 任意来源 tab；`#/content/review` 合法 |
| 定位固定 practice | 任意来源 tab；`#/today/placement` 合法 |
| 单词本固定 profile | 任意来源 tab；从视频打开是 `#/<tab>/vocabulary` |
| `#/content/library` 丢弃 | content 锚点，滚动到免费库 |
| 博客不传 slug | 列表/文章双向 URL；push/replace 按详情 |
| `closeWordbookForJump` | 删除；直接 push 目标 |
| 页面 X / 箭头混用 | 页面统一 BackButton；X 只给覆盖层 |
| 管理台 500ms 守卫 | auth ready + isAdmin 立即判定 |
