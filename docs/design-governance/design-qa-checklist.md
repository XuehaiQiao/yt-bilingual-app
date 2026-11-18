# 设计 QA 清单（按功能模块）v1.0

> 版本：**v1.0**（2026-11-19 定稿）｜责任人：A5（质量门禁与 QA）｜审批：lead
> 输入：A1 [`audit-report.md`](./audit-report.md)（90 条：P0 7 / P1 44 / P2 39）、A2 [`design-system/`](./design-system/tokens.md)、A3 [`interaction-spec.md`](./interaction-spec.md) / [`navigation-model.md`](./navigation-model.md)、A4 [`component-consolidation.md`](./component-consolidation.md)。
> 与 [`design-gate.md`](./design-gate.md) 的分工：门禁是**每个 UI PR 的 8 项 5 分钟最小集**；本清单是**模块级全量回归 / 发布前验收**。本清单不替代门禁，也不检查后端正确性。

---

## 0. 怎么用

### 0.1 三种用法

| 用法 | 何时 | 跑什么 | 耗时 |
|---|---|---|---|
| **PR 快速走查** | 每个 UI PR | **不跑本清单**，只跑 `design-gate.md` 的 G1–G8 | 5 分钟 |
| **阶段回归** | 改动了某模块，或 A4 批次（B1–B5）出口 | 本次改动模块的**全部 P0/P1 项** + 横切 P0 + 相关横切 P1 | 20–40 分钟 |
| **发布前全量** | 上线前 / 门禁 3、门禁 4 | 12 个模块的全部 P0/P1 + P2 抽样 13 条 + 附录 B 覆盖表逐条勾 | 2.5–3.5 小时（2 人） |

### 0.2 最小必跑集（任何发布阻塞场景的下限）

**12 条 P0** + 本次改动模块的全部 P1：

`QA-NAV-01`、`QA-NAV-02`、`QA-NAV-03`、`QA-NAV-04`、`QA-VID-01`、`QA-VID-02`、`QA-VID-03`、`QA-DSC-03`、`QA-DSC-05`、`QA-MOB-01`、`QA-X-01`、`QA-X-02`

追加规则：改文案 → 加 `QA-X-17`；改共享组件（Button/Dialog/Tabs/Segmented/Badge/EmptyState）→ 加 `QA-X-11`、`QA-X-12`；改导航壳 → 加 `QA-NAV-12`、`QA-NAV-13`、`QA-NAV-19`。

### 0.3 判定与证据规则

- 每项只有 **是 / 否**；不适用写 `N/A` **并给一句理由**（无理由的 N/A 视为未通过）。**没跑过的项不许勾「是」**。
- 「否」→ 记 `ID + 一句现象 + 等级 + 负责人`；在 PR 或发布清单里可搜索。
- 证据优先级：截图 / 录屏 > 命令输出 > `data-testid` DOM 片段 > 一句人工说明。截图文件名带**宽度 + 语言 + 状态**（`reader-375-vi-error.png`）。
- **级别**默认对齐 A1；若因壳级 / 阻断性影响上调，标 `↑`（例：`L-13（↑P0）`）并给一句理由；下调标 `↓`。上调只影响本项目内的排期，不改变审计结论。
- 判定口径以**用户可见结果**为准，不以「代码里有没有这个类」为准；命令只用来找漏项。

### 0.4 环境矩阵

| 维度 | 取值 | 何时必测 |
|---|---|---|
| 宽度 | 375×667 / 390×844 / 430×932 / 768 / 1024 / 1280 / 1440 | 每次 375 + 1440；改壳/断点加 768/1024/1280；发布前手机三档 |
| 语言 | zh-CN / vi-VN | 改文案、布局、日期/数字格式时 |
| 身份 | 游客 / 登录用户 / 管理员 | 门禁、账户、管理台、写操作 |
| 数据 | 空 / 加载 / 错误 / 离线 / 有历史 | 列表、异步请求、今日页 |
| 输入 | 键盘 / 触屏 / `prefers-reduced-motion` | 交互、弹窗、动效 |
| 浏览器 | Chrome（主）+ iOS Safari（发布前真机） | 移动裁切类问题只在真机判定 |

### 0.5 范围边界

- 覆盖 **Web 端**（含 375 响应式）。`mobile/` Expo 原生 app 不在本轮（章程 §1）。
- **课程模块**（§6）功能已存在但按章程推迟到上线后，**不作为本轮发布阻塞**；恢复投入时启用。
- 后端行为正确性由 `specs/` + 后端测试负责；本清单只看用户可见结果。
- A1 审计是静态的：本清单中涉及移动端裁切/双滚动、键盘、对比度的项，**必须运行时验证**（补 A1 盲区）。

---

## 1. 全局壳 / 导航（含四个一级页）

| ID | 检查项（是 / 否可判定） | 关联审计 ID | 级别 | 证据 / 操作步骤 |
|---|---|---|---|---|
| QA-NAV-01 | 在 4 个 tab 根页连续切换（今日→内容→练习→我的→今日）后按一次浏览器后退，**不会**逐个回退这 4 次 tab 切换（tab 切换是 replace，不堆历史） | N-03 | P0 | 先从外部页进入应用再切 4 个 tab，后退 1 次回外部页（不是回上一个 tab）；并记录 hash 序列 |
| QA-NAV-02 | 子视图连续前进 A→B→C 后连续返回，按 C→B→A 逐层退出；「今日→报告→去复习→返回」回到**报告**，不越过一层 | N-03 | P0 | 3 行 hash 序列截图或 15s 录屏 |
| QA-NAV-03 | 内容页右栏打开「本周报告/复习」，URL 前缀仍含 `content`（`#/content/report` 等），关闭后回**内容页**而不是今日/练习 | N-02 | P0 | 打开前 / 跳转后 / 关闭后 3 张截图 + hash |
| QA-NAV-04 | 从今日/内容/练习/我的打开学习页或课程页，URL 第一段分别是 today/content/practice/profile；刷新后点返回，落点与刷新前一致 | N-04 | P0 | 4 组 hash + 每组刷新截图 |
| QA-NAV-05 | 打开无缓存的本地剧集深链，停在「该剧集尚未处理，是否现在开始」的页面态（有主按钮），不是 toast + 弹回内容页 | N-05 | P1 | 输入 `#/learn/local/<show>/S01E02`（无缓存）+ 截图；确认无「已回内容页」 |
| QA-NAV-06 | `#/content/library` 直达后停在免费库区块（该区块滚入视口），地址栏不被改写；侧栏「免费库」落到同一 URL | N-06 | P1 | 2 张截图 + 前后 hash 相同 |
| QA-NAV-07 | 单词本 → 文章/书/句包 → 返回，落回**单词本**（不是「我的」） | N-18 | P1 | 3 行 hash + 返回截图 |
| QA-NAV-08 | 旧入口均可用并规范化为新 URL：`#/learn/...`、`#/lesson/...`、`#/profile/favorites`、`#admin`、`/admin`；管理台在 auth ready 后判定，无固定 500ms 白屏 | N-13、N-14 | P1（↑） | 5 条 URL 截图 + 录屏计时（进入/拦截 ≤200ms） |
| QA-NAV-09 | 非法 hash（`#/nonsense`、`#/content/sentences/0`、`#/practice/report`）回今日并出现**一次**可读提示，不静默 | N-11 | P1（↑） | 3 条 URL 截图 + 提示文案 |
| QA-NAV-10 | 匿名新标签打开深链（如 `#/content/discover`）先看到登录；登录成功后回到**原目标页**，不丢 `next` | N-15 | P1 | 登录前/后 2 张截图 + hash |
| QA-NAV-11 | 内容页滚到免费库 → 切今日 → 切回内容，滚动位置恢复；点**当前** tab 才平滑回顶 | N-16 | P1（↑） | 2 张截图；控制台读 `scrollTop` 不为 0 |
| QA-NAV-12 | 全部子视图返回控件统一：`h-9`、`-ml-2`、≥sm 显示文字、`aria-label` 含父级名；不存在 `h-7/h-8` 返回、带边框返回按钮 | I-11 | P1 | 至少 5 屏拼图（学习/阅读器/书/复习/报告）+ DOM 检查 |
| QA-NAV-13 | 桌面：任务型子视图（视频/阅读器/复习/考试）隐藏侧栏与底部 tab；面板型（单词本/报告/博客/发现/能力/管理台）保留侧栏且页内返回回局部父级；同一屏不同时出现两套冲突出口 | N-17 | P1（↑） | 1440 下任务型/面板型各 1 张截图 |
| QA-NAV-14 | 打开内容「先出目标页与 URL、再加载数据」，失败在目标页内重试；4 类入口（库视频/库文章/发现/单词本来源）行为一致，不再出现「停原页等全屏遮罩」 | I-14 | P1 | 4 段 10s 录屏或截图序列 |
| QA-NAV-15 | 今日页主操作（粘贴框）固定在**页头**：无历史为 hero、有历史为 compact，只换形态不换位置；页尾无第二个输入；顶栏「开始学习」跳今日并聚焦输入框 | L-04 | P1 | 有/无历史 2 张截图 + 点顶栏后截图 |
| QA-NAV-16 | 练习页三卡同构：同一栅格列数、等宽、动作在卡底部；定位卡不跨列、不换向 | L-06 | P1 | 768 / 1440 两张截图 |
| QA-NAV-17 | 同一视口只有一个 `<h1>`；四个一级页外层容器宽度与左右内边距一致；桌面页内不渲染大标题（标题在顶栏） | V-15、V-16、V-17 | P2 | 4 页截图对比左缘 + DOM 统计 `h1` 数 = 1 |
| QA-NAV-18 | 导航 tab 只有两种皮肤（顶栏下划线 / 内容白滑块）；侧栏、顶栏、底栏、单词本四处计数徽章 ≥11px、>99 显示 `99+`、`aria-label` 带完整数字 | C-05、C-07、N-10 | P1 | 4 处截图；把计数改成 128 后看格式 |
| QA-NAV-19 | 断点形态正确：<768 底栏 4 tab；768–1023 顶栏 tabs 无侧栏；≥1024 侧栏 + 顶栏标题；1280 只加宽；同一断点无重复出口 | L-11 | P1（↑） | 375 / 768 / 1024 / 1280 四张截图 |
| QA-NAV-20 | 页面底色统一：`index.html` theme-color、`manifest.webmanifest`、`index.css --app-bg` 三处同值；页面类名用 `bg-app`（无 `bg-[#09090b]` 新增） | V-01 | P2 | 3 处 grep + 1 张截图 |

## 2. 视频学习

| ID | 检查项（是 / 否可判定） | 关联审计 ID | 级别 | 证据 / 操作步骤 |
|---|---|---|---|---|
| QA-VID-01 | 375/390/430 学习页**只有一个滚动容器**：字幕区上下滑动只滚这一层；滚到底无链式滚动；最后一句完整可见；视频不 sticky | L-01 | P0 | 三档录屏 + DOM 统计滚动容器 = 1；滚到末句截图 |
| QA-VID-02 | 处理/翻译/估价失败显示错误面板 + 重试，不显示「暂无」；重试不重复扣费；刷新页面 10 次，Network 中 `process/estimate` 调用为 0 | I-01 | P0 | 断网截图 + Network 截图（10 次刷新 0 请求） |
| QA-VID-03 | 中文界面主链路无英文：处理遮罩 → 估价弹窗 → 本地剧集空态 → 删除历史 toast（31 键清单见附录 A） | V-06 | P0 | 5 张截图 + 逐键核对附录 A |
| QA-VID-04 | 加载态为骨架或行内进度，不是全屏 spinner；翻译中占位文案对比度足够（`fg-secondary`，非 `zinc-600`），流式出现 | I-07、V-03 | P1 | 3G 限速截图 + 占位行截图 |
| QA-VID-05 | 点词：单击开卡、点空白/Esc 关闭、切词不关；右侧 1/3 处点词卡片不越界；收藏词 `source_ref` 写入视频 id，单词本可回跳 | I-12、C-03、I-15 | P1 | 3 张截图 + 单词本来源行截图 + 跳转 |
| QA-VID-06 | 触屏上收藏星常显可点（不依赖 hover）；点击立即变「已收藏」；游客点击打开登录浮层且星标不假成功；失败回滚 + toast | I-06、I-16 | P1 | 375 录屏 2 段（登录/断网） |
| QA-VID-07 | 紫色只用于 AI 生词高亮：文本选中、注释 `rt`、词性徽章不再用紫 | V-05 | P1 | 选中文本截图 + 词卡截图 + 新增 `purple-` 为 0 |
| QA-VID-08 | 学习页头部只放返回/标题/单词本；PiP/字号/译文/听写放内容区第二行、横向可滚不换行；快捷键在输入框内不触发 | L-12 | P1（↑） | 375/1440 截图 + 输入框内按键测试 |
| QA-VID-09 | 开启 `prefers-reduced-motion` 后字幕高亮、词卡、进度动效降级或静止（全局 `MotionConfig reducedMotion="user"` 生效） | V-21 | P2 | 系统设置 + 2 段录屏 |

## 3. 文章阅读

| ID | 检查项（是 / 否可判定） | 关联审计 ID | 级别 | 证据 / 操作步骤 |
|---|---|---|---|---|
| QA-RDR-01 | 阅读器列表 → 文章写入 `#/content/reader/<articleId>`；刷新仍在文章；返回回列表且列表滚动/筛选保留 | N-08 | P1 | 3 行 hash + 刷新截图 |
| QA-RDR-02 | 游客点两个「读文章」入口（粘贴框模式、蓝色链接）都在**入口**弹登录，不进入带登录块的「假阅读器」；门禁与发现页一致 | I-13 | P1 | 2 张截图（两个入口各 1） |
| QA-RDR-03 | 删除文章用自绘 ConfirmDialog（Escape/取消可用），无 `window.confirm`；取消后文章仍在 | I-05 | P1 | 截图 + 新增 `window.confirm` = 0 |
| QA-RDR-04 | 缺译文段落可单独重试；已成功段不重复请求（Network 观察）；失败段可读可重试，占位色为 `fg-secondary` | I-09、V-03 | P1 | 断网截图 + Network 截图 |
| QA-RDR-05 | 阅读器 ruby / 点词与字幕同一实现（注释色、字号、可点范围一致）；点词来源带 article id/title，单词本可跳回原文 | C-04、I-12 | P1 | 两屏对照截图 + 单词本来源 |
| QA-RDR-06 | ≥lg 双语左右两栏，<lg 上下单栏；隐藏译文后单栏无空列；正文 `max-w-reading`（720）单栏 | C-04（布局契约） | P1 | 1024 / 1440 / 375 三张截图 |
| QA-RDR-07 | 导入 URL / 正文：超限、SSRF 拒绝、网络错误、解析失败都在页内给可读错误 + 重试，不白屏、不只 toast 一闪 | I-09 | P1 | 4 种错误截图 |
| QA-RDR-08 | 阅读器选区「分享本段」与分享卡：浮层外观、遮罩、按钮文案一致；选区浮层有边界夹取 | C-14 | P2 | 2 张截图 |
| QA-RDR-09 | 阅读进度节流保存并在重进时恢复；切语言/刷新不丢当前文章 | N-08（扩展） | P2 | 重进截图 |

## 4. 公版书 / 导入书

| ID | 检查项（是 / 否可判定） | 关联审计 ID | 级别 | 证据 / 操作步骤 |
|---|---|---|---|---|
| QA-BOOK-01 | 书架 → 书系 → 书 → 另一本书：每次前进 push；返回逐级（书→书系→书架），不一次跳回内容页；URL 不被递归覆盖 | N-07 | P1 | 4 行 hash + 连续返回录屏 |
| QA-BOOK-02 | 书内切章 / 换书写入 URL；刷新仍在该书该章；返回回上一级 | N-08 | P1 | 3 行 hash + 刷新截图 |
| QA-BOOK-03 | 导入失败 / 超限 / 格式不支持 / 网络错误：页内可读错误 + 重试，不白屏；支持格式说明与实际一致 | I-09 | P1 | 4 种错误截图 |
| QA-BOOK-04 | 删除/移除书与书系使用 ConfirmDialog；取消不删；成功有反馈 | I-05 | P1 | 截图 2 张 |
| QA-BOOK-05 | 公版书 / 导入书 / 免费库文章 / 阅读器四种阅读器共用 ruby 与点词；来源写 book id；句子包来源（`L<levelId>`）可回跳 | C-04、I-12 | P1 | 4 屏点词截图 + 单词本来源 |
| QA-BOOK-06 | 书架与导入书架三态齐全；空态有动作（导入 / 去免费库），不是纯文字；空态 `py-16` 配方 | I-08、L-10 | P1 | 空/加载/错误 3 张截图 |
| QA-BOOK-07 | 书架卡/行复用 Card/ListRow；无 `CARD` 常量；卡片圆角一档（16） | C-01、C-11 | P1 | grep 新增常量 = 0 + 截图 |

## 5. 单词本

| ID | 检查项（是 / 否可判定） | 关联审计 ID | 级别 | 证据 / 操作步骤 |
|---|---|---|---|---|
| QA-VOC-01 | 移动端 tab 不再 8+ 横滚：2 个固定 tab + 词表菜单；选中项自动滚入视口；桌面可换行 | L-07 | P1 | 375 / 1440 截图 |
| QA-VOC-02 | 来源列显示可读来源并可跳回原文；`vocab.source.unknown` 不出现；句子包来源可回跳 | I-12、C-03 | P1 | 3 条来源行截图 + 跳转录屏 |
| QA-VOC-03 | tab 视觉为白滑块；计数徽章统一 11px / `99+`；四个入口计数一致 | C-05、C-07、N-10 | P1 | 3 处截图 |
| QA-VOC-04 | 字号只在 11/13/15/17 档；无 9/10px；`zinc-600` 不再用于信息类文字（提亮到 `fg-secondary`） | V-02、V-03 | P1 | grep + 截图 |
| QA-VOC-05 | 分页统一「页码条 + 状态文案」；步骤型改称「上一步/下一步」，不叫分页 | I-18 | P2 | 4 处截图 |
| QA-VOC-06 | 来源/免费/等级标签用 Badge 五语义色；无逐处写色；中文不被 uppercase | C-13 | P2 | 截图 + grep |
| QA-VOC-07 | 删除收藏有确认或可撤销 + 成功反馈；失败回滚；命中区 ≥32 | C-15、I-19 | P1 | 录屏 1 段 |
| QA-VOC-08 | 空/加载/错误重试齐全；桌面表格与 375 单列不撑破、不横向滚动 | I-07、I-08 | P1 | 3 态 + 2 宽度截图 |
| QA-VOC-09 | C2 档禁用并说明原因；短语搜索 / level / type 筛选 / 每页 50 可用；「全局隐藏中文」记忆生效、点行临时显示 | 新增（specs/004） | P1 | 4 张截图 |

## 6. 课程（本轮**不阻塞发布**，恢复投入时启用）

| ID | 检查项（是 / 否可判定） | 关联审计 ID | 级别 | 证据 / 操作步骤 |
|---|---|---|---|---|
| QA-CRS-01 | 刷新或重进按 attempt 恢复到原步骤与已填答案，不从头开始 | 新增（specs/029） | P1 | 刷新前后 2 张截图 |
| QA-CRS-02 | 12:00 倒计时只做展示，不催交、不跳步、不丢已答内容 | 新增（specs/029） | P1 | 倒计时到期截图 + 已答内容仍在 |
| QA-CRS-03 | 游客进入有登录提示且不阻断试看；登录后进度保留 | I-13 | P1 | 2 张截图 |
| QA-CRS-04 | 按钮 / OptionCard 复用；无 `h-10 sm:h-11` 变体；选项键盘可选 | C-01 | P1 | 截图 + 键盘操作 |
| QA-CRS-05 | 完成页 score / 产出 / 参考样例可读，返回入口清晰；生成入口 409/502/429 为行内错误 | 新增（specs/030） | P2 | 2 张截图 |

## 7. 能力定位 / 考试

| ID | 检查项（是 / 否可判定） | 关联审计 ID | 级别 | 证据 / 操作步骤 |
|---|---|---|---|---|
| QA-ASM-01 | 定位 12 分钟倒计时、超时自动交卷、退出作废确认（自绘 ConfirmDialog，Escape/取消可用） | I-05 | P1 | 超时截图 + 确认框截图 |
| QA-ASM-02 | 结果页显示 CEFR 区间、置信度、免责声明；文案不出现「预测分数 / 保证」 | 新增（specs/016） | P1 | 结果页截图 |
| QA-ASM-03 | 游客可测并提示「登录后结果保存更久」；登录后结果不丢 | I-13 | P1 | 2 张截图 |
| QA-ASM-04 | 键盘 1–4 / Enter 可完成全部题；焦点可见；Tab 顺序与视觉顺序一致 | V-14 | P1 | 无鼠标录屏 1 段 |
| QA-ASM-05 | 选项用 OptionCard（`role=radio` / `aria-checked`）；分段控件同一度量；无原生 `select` | C-06 | P1 | DOM 片段 + 截图 |
| QA-ASM-06 | 考试头只留返回/标题/关闭；SubHeader 固定 `h-12`；窄屏不换行；eyebrow/副标题/历史/进度下沉 | L-09、L-12 | P1（↑） | 375 / 1440 截图 |
| QA-ASM-07 | 「我的 CEFR」单一数据源；今日/练习/我的只做入口；三处 CEFR 档位与置信度数字、文案完全相同 | L-08 | P2 | 3 处截图对比 |

## 8. 内容发现 / 博客

| ID | 检查项（是 / 否可判定） | 关联审计 ID | 级别 | 证据 / 操作步骤 |
|---|---|---|---|---|
| QA-DSC-01 | 内容页分两层：主操作面板 + 货架区；货架用同一 `SectionHeader`（17px）；首屏可见主操作与素材库标题；无 9 个同权重区块 | L-02 | P1 | 1440 首屏截图 + 标题字号 DOM |
| QA-DSC-02 | 1024–1279 rail 置顶横排（不整宽）；≥1280 两栏；主列 ≥420/600；无横向溢出 | L-03 | P1 | 1024 / 1280 / 1440 截图 |
| QA-DSC-03 | 博客文章深链 `#/content/blog/<slug>` 直接打开文章；列表点文章 URL 变化；刷新仍在文章；分享链接打开是文章；返回回列表 | N-01 | P0 | 4 步截图 + 4 行 hash |
| QA-DSC-04 | 博客/发现的内部层级写 URL（列表↔文章、query）；刷新恢复；后退逐层 | N-08 | P1 | 3 行 hash + 刷新 |
| QA-DSC-05 | 订阅更新 / 推荐请求失败显示错误面板 + 重试，不显示「暂无更新」；断网可复现 | I-01 | P0 | 断网截图 + 重试成功截图 |
| QA-DSC-06 | 发现等待 10–20s 有进度/阶段说明；失败、degraded 有说明与重试；换一批不重复当前批次；空结果有说明 | 新增（specs/017） | P1 | 4 张截图 |
| QA-DSC-07 | 候选卡信息完整（缩略图、频道、时长、CEFR、推荐理由、字幕状态）；缺字段有占位不塌 | 新增（specs/017） | P1 | 1 张完整卡 + 1 张缺字段卡 |
| QA-DSC-08 | 空态给「最有价值的一次操作」：发现给 3 个示例主题、博客空列表给 RSS、报告空周给去复习 | L-10 | P2 | 3 张截图 |
| QA-DSC-09 | Giscus 未配置时显示占位而非报错；RSS 链接可达 | 新增（specs/020） | P2 | 截图 + 打开 RSS |
| QA-DSC-10 | 内容页右栏「本周报告」关闭后回内容页（NAV-03 的实例复核） | N-02 | P1 | 2 张截图 |

## 9. 登录 / 账户 / 设置

| ID | 检查项（是 / 否可判定） | 关联审计 ID | 级别 | 证据 / 操作步骤 |
|---|---|---|---|---|
| QA-ACC-01 | 「我的」分三组（学习数据 / 偏好 / 关于账户），组标题 17；退出在组尾、删除账号最后且有确认；危险/低频不再与高频同权重 | L-05 | P1 | 1440 / 375 截图 |
| QA-ACC-02 | 登录页返回是统一 BackButton（`h-9` / `-ml-2` / 文字），不再出现全应用唯一的带边框返回 | I-11 | P1 | 登录页截图 + 对比子视图 |
| QA-ACC-03 | 语言切换即时生效 + 持久化；vi 下无中文残留；切语言关闭依赖语言的子视图并 replace 回 tab 根 | V-06、新增（D-11） | P1 | 切换前后截图 + 刷新后仍为 vi |
| QA-ACC-04 | 表单错误在字段旁内联（用户名长度 / 密码 / 确认密码），不用 toast；提交失败不丢输入 | I-09 | P1 | 3 种错误截图 |
| QA-ACC-05 | 改名/刷新等写操作：按钮内转圈 + 成功 toast + 失败回滚/内联；无假成功 | I-19 | P1 | 3 张截图（提交中/成功/失败） |
| QA-ACC-06 | 焦点只用全局 `:focus-visible`；输入壳用 `focus-within`；无组件级 `outline-none` 吞环 | V-14 | P1 | Tab 走查截图 + grep |
| QA-ACC-07 | 词汇等级轴改「灰轨 + brand 当前档」，去掉 sky→violet→pink 渐变与外发光；全页无新增 violet/sky/pink | V-07 | P1 | 设置页截图 + grep |
| QA-ACC-08 | 未配置 Key 的模型置灰 + 原因说明；选择结果持久化；重启后仍生效 | 新增（specs/001） | P1 | 2 张截图 |
| QA-ACC-09 | 退出登录清空登录态与相关缓存；游客账户页降级正确（不显示写操作） | 新增 | P1 | 退出前后截图 |
| QA-ACC-10 | 设置入口不重复（侧栏/顶栏/我的）；同一设置在各入口值一致 | 新增（IA §3.4） | P2 | 3 处截图 |

## 10. 管理台

| ID | 检查项（是 / 否可判定） | 关联审计 ID | 级别 | 证据 / 操作步骤 |
|---|---|---|---|---|
| QA-ADM-01 | 非管理员在 auth ready 后**立即**拦截 + 一次 toast；无固定 500ms 白屏 ×2；管理员书签 `/admin` 进入 ≤200ms | N-14 | P1 | 录屏计时 + toast 截图 |
| QA-ADM-02 | 管理台 tab 用白滑块（内容级），不再第三套视觉；`role=tablist/tabpanel` 存在 | C-05 | P1 | 截图 + DOM 片段 |
| QA-ADM-03 | 调余额 / 封禁 / 删除用 ConfirmDialog；不能操作自己或最后一个管理员（按钮禁用 + 后端拒绝可读） | I-05、新增（specs/021） | P1 | 3 张截图 |
| QA-ADM-04 | 维护模式 / 公告 / 保存：即时反馈，失败不留「假已保存」；成功后刷新仍正确 | I-19 | P1 | 成功/失败/刷新后 3 张截图 |
| QA-ADM-05 | 分页统一 Pagination（每页 20）；offset 换算收在组件内；空结果有空态 | I-18 | P2 | 截图 + 翻页 |
| QA-ADM-06 | 宽表各自横向滚动；375 不撑破页面、不重叠操作列；容器 `max-w-admin` | V-16 | P1（↑） | 1440 / 375 截图 |
| QA-ADM-07 | 头部固定 `h-12`，只留返回/标题/关闭，不换行；面包屑在顶栏 | L-12 | P1（↑） | 375 / 1440 截图 |
| QA-ADM-08 | 桌面内边距 16/24/32 与一级页一致；移动 16 | V-17 | P2 | 4 处截图对比 |

## 11. 移动端（Web <768，主测 375）

| ID | 检查项（是 / 否可判定） | 关联审计 ID | 级别 | 证据 / 操作步骤 |
|---|---|---|---|---|
| QA-MOB-01 | 每个页面**恰好一个** `data-page-scroll` 容器（Dialog/词卡/代码块除外）；375 滚到最底部最后一张卡完整可见、底栏不重叠、间距 ≥16 | L-01、L-13 | P0 | 三档机型逐页录屏 + DOM 统计滚动容器 |
| QA-MOB-02 | 375/390/430 无横向滚动（表格、tab 条容器除外）；长列表滚动流畅，跟随与分页不打架 | L-13 | P1（↑） | 3 档截图 + 手势录屏 |
| QA-MOB-03 | 底栏 56 + safe；Toast 在底栏上方；离线标记移到顶栏下方，二者不重叠、不遮 tab | I-10 | P1 | 断网 + 触发 toast 截图 |
| QA-MOB-04 | 触控目标 ≥44；hover 才出现的操作在 coarse pointer 常显；无两个操作挤在 8px 内 | I-16 | P1 | 375 截图 + DevTools 触摸模拟 |
| QA-MOB-05 | 软键盘弹出不遮输入框与提交按钮；输入字号 ≥16px（iOS 不缩放） | 新增（键盘遮挡）、L-13 | P1 | iOS Safari 截图（发布前） |
| QA-MOB-06 | 只用 `dvh`；地址栏展开/收起不裁切、无双滚动条；`viewport-fit=cover` 保留 | V-11 | P1 | iOS Safari 展开/收起 2 张截图 |
| QA-MOB-07 | 右侧 1/3 点词卡片不越界（clamp 8px + 上下翻转）；375 下卡片可完整阅读 | I-15 | P1 | 3 个点位截图 |
| QA-MOB-08 | 底栏 4 tab 与徽章可点（≥44）；点当前 tab 平滑回顶；计数 `99+` | C-07、N-16 | P1 | 截图 + 录屏 |
| QA-MOB-09 | 安卓返回键在子视图内有效；一级页不直接退出（PWA standalone 提示「再按一次」或占位） | I-20 | P2 | 安卓录屏（发布前） |

## 12. 横切项（每个触及的屏都要过）

| ID | 检查项（是 / 否可判定） | 关联审计 ID | 级别 | 证据 / 操作步骤 |
|---|---|---|---|---|
| QA-X-01 | 任何请求失败都**不得**渲染成空态（今日历史、内容右栏、订阅更新、推荐等）；显示 ErrorPanel + 重试；断网可复现 | I-01 | P0 | 断网逐页截图 + 恢复后重试成功 |
| QA-X-02 | 所有浮层具备：Escape、遮罩点击、X、`role=dialog`、`aria-modal`、焦点陷阱、关闭回焦点、背景滚动锁；频道列表弹窗可键盘关闭 | I-02、I-03、I-04、C-02 | P0 | 键盘录屏 + DOM 片段（14 个浮层抽 5 个） |
| QA-X-03 | 全站无 `window.confirm/alert`；删除/退出考试/重置定位用 ConfirmDialog；取消无副作用 | I-05 | P1 | grep 新增 = 0 + 3 张确认框截图 |
| QA-X-04 | 反馈层级：字段校验内联；操作失败 toast；页面级加载失败 ErrorPanel；同一错误不同时出现两处 | I-09 | P1 | 3 类错误截图 |
| QA-X-05 | 加载态统一：首屏列表骨架（最小高度 240）、局部行内 spinner、阻断遮罩只用于付费/处理；spinner 三档 | I-07 | P1 | 3 处截图 |
| QA-X-06 | 空态只在「成功且为空」出现；EmptyState 四槽（icon/title/hint/action）+ `py-16`；虚线边框只用于可放置区 | I-08 | P1 | 4 处空态截图 |
| QA-X-07 | Toast：TTL/去重/上限/位置/`aria-live`；错误可关闭或延长；连续 5 个错误不叠 5 条；不遮底栏与离线标记 | I-10 | P1 | 连发 5 个错误截图 + 读屏/aria 检查 |
| QA-X-08 | 收藏/取消乐观更新，失败回滚 + 错误 toast；游客点收藏不改变星标且打开登录浮层 | I-06 | P1 | 断网/游客 2 段录屏 |
| QA-X-09 | 写操作三件套（按钮内 loading + 成功 toast + 失败 toast/内联）；高风险动作确认后仍失败有可读原因 | I-19 | P1 | 3 张截图 |
| QA-X-10 | 全局 `:focus-visible` 唯一；无组件级 focus ring/`outline-none`；输入容器用 `focus-within`；焦点顺序与视觉一致 | V-14 | P1 | 键盘走查 + grep |
| QA-X-11 | Button/Card/ListRow/Dialog 单一来源；无 `PRIMARY_BUTTON`/`CARD` 常量；删除类图标 hover/focus 变红 + 确认 + ≥32 | C-01、C-02、C-11、C-15 | P1 | grep 新增常量 = 0 + 截图 |
| QA-X-12 | Tabs 两皮肤；Segmented 唯一度量（容器 `rounded-lg bg-surface-2/60 p-0.5`、选项 `px-2.5 py-1 text-xs`）；Badge 五语义色；CountBadge 11px/99+ | C-05、C-06、C-07、C-13 | P1 | 4 处截图 + DOM |
| QA-X-13 | `formatClock/formatCountdown/formatCount` 单一来源；>1h 输出 `h:mm:ss`；计数统一 `99+` | C-08、N-10 | P1 | grep 副本 = 0 + 128 计数截图 |
| QA-X-14 | `brand` 是唯一交互强调色；无新增 `blue-*`；紫只用于 AI 高亮；无 violet/sky/pink 新增；进度只用 brand/success | V-04、V-05、V-07、V-08 | P1 | diff grep + 4 处截图 |
| QA-X-15 | 字号只用 11/13/15/17/24/30… 阶梯；中文 ≥11px；`zinc-600` 不再用于信息类文字（占位/空态/说明 → `fg-secondary`） | V-02、V-03 | P1 | grep + 空态/占位截图 |
| QA-X-16 | 圆角按高度硬映射；材质 6 配方整选；阴影只 `elev-1/2/3`；z-index 只用 8 个 token（7 层 + `z-raised`），无 `z-[N]` | V-09、V-10、V-12、V-13 | P1 | grep + 弹窗/词卡截图 |
| QA-X-17 | i18n：无硬编码文案；zh/vi 同键；zh 值必须含 CJK（白名单 14 键）；`check:i18n` 绿；31 键清单见附录 A | V-06 | P1 | `npm run check:i18n` 末行 + 附录 A 逐键 |
| QA-X-18 | 无裸 `transition` / `transition-all`（只颜色/transform）；默认 200ms + `ease-apple` 用于位移/缩放；`MotionConfig reducedMotion="user"` 全局兜底 | V-21 | P1 | grep + reduced-motion 录屏 |
| QA-X-19 | 共享函数在 `lib/`（`cn` / `reading-layout` / `time`）；组件不反向 import 业务组件 | C-09 | P2 | import 图 + grep |
| QA-X-20 | 分页形态统一（页码条 + 状态）；步骤型不叫分页 | I-18 | P2 | 4 处截图 |
| QA-X-21 | 模式选择用 Segmented，不用原生 `select`；输入类控件统一高度与圆角 | I-17 | P2 | 截图 + DOM |
| QA-X-22 | 触屏可见性规则落地（coarse pointer 常显次要操作），不再靠单点特例 | I-16 | P2 | 375 全页扫一遍次要操作 |
| QA-X-23 | 平台返回/手势兜底按 `navigation-model.md` §10 | I-20 | P2 | 安卓/PWA 录屏 |
| QA-X-24 | 删除图标统一（`Trash2`/`X`），命中区与颜色一致 | C-15 | P2 | 4 处截图 |
| QA-X-25 | 删除 `InputScreen.tsx` 死代码；>1000 行组件按 shell/section/原子拆分，无未使用导出 | C-10、C-16 | P2 | `grep -r InputScreen` = 0 + 文件行数 |
| QA-X-26 | testid 契约：`data-testid` 只增不删；4 个契约属性保留；改名同 commit 改脚本（674 唯一 testid / 77 脚本依赖） | 新增（A4 §5.4） | P1 | diff grep testid + 跑 `scripts/*.mjs` 相关脚本 |
| QA-X-27 | 底色三处一致（`index.html` theme-color / manifest / `index.css --app-bg`） | V-01 | P2 | 3 处 grep |
| QA-X-28 | 间距五档（4/8/12/16/24）；按压只 0.98/0.99；无 `hover:scale` | V-19、V-20 | P2 | grep + 录屏 |

---

> **级别上调理由（`↑`）**：`QA-NAV-08/09/11/13/19`、`QA-VID-08`、`QA-MOB-02`、`QA-ASM-06`、`QA-ADM-06/07` 涉及壳、权限、返回主路径或窄屏骨架，失败会从单页放大到全站，故在审计 P2 基础上升为 P1；审计结论不变，排期按本清单执行。

## 附录 A：V-06 文案清单与 CI 检查项

### A.1 审计 24 键（P0，A4 G0 迁移）

| 组 | 键（zh-CN 现值） | 渲染点 | 处理 |
|---|---|---|---|
| 处理遮罩（7） | `home.loading.loading` "Loading…"、`home.loading.processing` "Fetching subtitles…"、`home.loading.asr` "Transcribing locally…"、`home.loading.processingHint`、`home.loading.asrHint`、`home.analyzing` "Analyzing video…"、`home.analyzingHint` | `App.tsx:3396-3402`、`EstimateDialog.tsx:95-97` | 中文改写；保留「翻译会流式出现」「无字幕自动转写」说明 |
| 估价弹窗（5） | `estimate.title` / `estimate.subtitle` / `estimate.words` / `estimate.tokens` / `estimate.confirm` | `ModelSelectionModal.tsx:68/71/100/101/186` | 中文；标题与按钮不再同词 |
| 本地剧集（4） | `shows.empty` "No local shows yet"、`shows.emptyHint`（含「把 .srt 放进 subtitles/」开发者说明）、`shows.back` "Back"、`shows.pickSeason` | `ShowBrowser.tsx:83/84/100/201` | 中文；`emptyHint` 改成用户动作（设置/免费资源） |
| 通用控件（4） | `common.cancel` "Cancel"、`topbar.popOut` "Pop Out"、`topbar.closePopOut` "Close Pop-out"、`topbar.logoAlt` "Logo"（aria） | `ModelSelectionModal.tsx:180`、`LearningHeader.tsx:79-85`、`AppShell.tsx:130` | 中文；aria 也算用户可见 |
| 未知态（4） | `common.unknownVideo`、`common.unknownChannel`、`common.noThumbnail`、`home.deletedToast` "Removed from Continue Learning" | `App.tsx`（6 处）、`ModelSelectionModal.tsx`、`TodayScreen.tsx:151` | 中文 |

### A.2 A5 复核追加（同属 V-06，不新增问题号）

复核方法：`zh-CN.json` 1691 键中 67 键不含 CJK；排除死代码 `InputScreen.tsx` 后仍有 46 键被引用，其中 **7 键**同样出现在默认中文界面：

| 键 | 现值 | 渲染点 | 处理 |
|---|---|---|---|
| `home.removeHistoryTitle` | "Remove from Continue Learning" | `RecentLearning.tsx` | 中文 |
| `home.deleteConfirm` | "Remove \"{{title}}\" from Continue Learning?" | `TodayScreen.tsx:145`（`window.confirm`） | 中文，随 `ConfirmDialog` 迁移 |
| `home.noUploads` | "No new uploads yet" | `ContentScreen.tsx` | 中文 |
| `common.localFile` | "Local File" | `RecentLearning.tsx`、`TodayWorkbench.tsx` | 中文 |
| `shows.season` | "Season {{number}}" | `ShowBrowser.tsx:163` | 中文 |
| `shows.episodesShort` | "({{count}} ep)" | `ShowBrowser.tsx` | 中文 |
| `shows.seasonsEpisodes` | "{{seasons}} seasons · {{episodes}} episodes" | `ShowBrowser.tsx` | 中文 |

**合计 31 键**（24 + 7）+ **1 键待裁决**：`sentences.day` "Day {{day}}"（`SentenceView.tsx:197`，建议「第 N 天」）。

### A.3 CJK 白名单（14 键，CI 规则用）

`brand.engine`、`welcome.footer.github`、`library.article.license`、`vocab.cefr.levelCount`、`vocab.col.level`（CEFR）、`reader.import.urlPlaceholder`、`exam.result.correctValue`、`ability.assess.itemSkill`、`ability.assess.ratingAria`、`books.license`、`importedBooks.sourceGutenberg`、`importedBooks.sourceStandardEbooks`、`importedBooks.dialog.urlPlaceholder`、`novel.entry.title`（书名）。

### A.4 CI 检查项（阶段 4 开启，**不得现在开**）

```js
// frontend/scripts/check-i18n.mjs 追加（草案）
const WHITELIST = new Set([/* A.3 的 14 键 */]);
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
for (const [key, value] of Object.entries(base)) {
  if (WHITELIST.has(key)) continue;
  if (!CJK.test(value)) problems.push(`zh-CN: no CJK in "${key}": ${value}`);
}
```

- **开启条件**：A.1 + A.2 的 31 键中文落地、`sentences.day` 裁决完成、`npm run check:i18n` 通过。
- **现在开会发生什么**：31 条直接失败 → CI/本地红。所以本阶段只在 QA 里人工勾 `QA-X-17`，不接 CI。
- **判定口径**：以「中文界面主链路无英文」为准，不以「白名单键数」为准；新增英文键按 P0 处理。

## 附录 B：审计覆盖核对表（51 条 P0/P1，缺失 = 0）

> 自检命令（在 `docs/design-governance/` 下跑）：

```bash
grep -oE '^#### (V|I|N|C|L)-[0-9]+ · (\*\*P0\*\*|P1)' audit-report.md \
  | grep -oE '(V|I|N|C|L)-[0-9]+' | sort -u > /tmp/p01.txt
wc -l < /tmp/p01.txt            # 必须是 51
while read id; do grep -q -- "$id" design-qa-checklist.md || echo "MISSING $id"; done < /tmp/p01.txt
# 无输出 = 覆盖完整
```

| 审计 ID | 级别 | 主 QA 项 | 补充 / 说明 |
|---|---|---|---|
| V-02 | P1 | QA-X-15 | QA-VOC-04 |
| V-03 | P1 | QA-X-15 | QA-VID-04、QA-RDR-04 |
| V-04 | P1 | QA-X-14 | 阶段 4 正则 T-04 |
| V-05 | P1 | QA-X-14 | QA-VID-07 |
| V-06 | **P0** | QA-VID-03 | QA-X-17 + 附录 A（31 键 + CI 规则草案） |
| V-07 | P1 | QA-X-14 | QA-ACC-07 |
| V-09 | P1 | QA-X-16 | — |
| V-10 | P1 | QA-X-16 | — |
| V-11 | P1 | QA-MOB-06 | —（`viewport-fit=cover` 已存在，复核时勿重复添加） |
| V-12 | P1 | QA-X-16 | — |
| V-13 | P1 | QA-X-16 | — |
| V-14 | P1 | QA-X-10 | QA-ASM-04、QA-ACC-06 |
| I-01 | **P0** | QA-X-01 | QA-VID-02、QA-DSC-05 |
| I-02 | **P0** | QA-X-02 | 实例：频道列表弹窗（14 个浮层之一） |
| I-03 | P1 | QA-X-02 | — |
| I-04 | P1 | QA-X-02 | — |
| I-05 | P1 | QA-X-03 | QA-RDR-03、QA-BOOK-04、QA-ADM-03、QA-ASM-01 |
| I-06 | P1 | QA-X-08 | QA-VID-06 |
| I-07 | P1 | QA-X-05 | QA-VOC-08、QA-BOOK-06 |
| I-08 | P1 | QA-X-06 | QA-VOC-08、QA-BOOK-06 |
| I-09 | P1 | QA-X-04 | QA-RDR-04、QA-RDR-07、QA-BOOK-03、QA-ACC-04 |
| I-10 | P1 | QA-X-07 | QA-MOB-03 |
| I-11 | P1 | QA-NAV-12 | QA-ACC-02 |
| I-12 | P1 | QA-VID-05 | QA-VOC-02、QA-BOOK-05、QA-RDR-05 |
| I-13 | P1 | QA-RDR-02 | QA-ASM-03、QA-CRS-03、QA-ACC-09 |
| I-14 | P1 | QA-NAV-14 | — |
| N-01 | **P0** | QA-DSC-03 | QA-DSC-04（同源） |
| N-02 | **P0** | QA-NAV-03 | QA-DSC-10 |
| N-03 | **P0** | QA-NAV-01、QA-NAV-02 | — |
| N-04 | P1 | QA-NAV-04 | — |
| N-05 | P1 | QA-NAV-05 | — |
| N-06 | P1 | QA-NAV-06 | — |
| N-07 | P1 | QA-BOOK-01 | — |
| N-08 | P1 | QA-RDR-01 | QA-DSC-04、QA-BOOK-02、QA-RDR-09 |
| N-18 | P1 | QA-NAV-07 | — |
| C-01 | P1 | QA-X-11 | QA-BOOK-07、QA-CRS-04 |
| C-02 | P1 | QA-X-02 | QA-X-11 |
| C-03 | P1 | QA-VID-05 | QA-VOC-02 |
| C-04 | P1 | QA-RDR-05 | QA-VID-07、QA-BOOK-05 |
| C-05 | P1 | QA-X-12 | QA-NAV-18、QA-VOC-03、QA-ADM-02 |
| C-06 | P1 | QA-X-12 | QA-ASM-05 |
| C-07 | P1 | QA-X-12 | QA-NAV-18、QA-VOC-03、QA-MOB-08 |
| C-08 | P1 | QA-X-13 | — |
| C-09 | P1 | QA-X-19 | — |
| L-01 | **P0** | QA-VID-01 | QA-MOB-01 |
| L-02 | P1 | QA-DSC-01 | — |
| L-03 | P1 | QA-DSC-02 | — |
| L-04 | P1 | QA-NAV-15 | — |
| L-05 | P1 | QA-ACC-01 | — |
| L-06 | P1 | QA-NAV-16 | — |
| L-07 | P1 | QA-VOC-01 | — |

**统计**：V 12/12、I 14/14、N 9/9、C 9/9、L 7/7 → **51/51 覆盖，缺失 0**；其中 P0 7/7。V-06 有明确例外路径（31 键 + CI 规则草案 + 上线前 QA 勾选）。

## 附录 C：P2 抽样（13 条，发布前跑）

| 审计 ID | 抽样项 | 对应 QA 项 |
|---|---|---|
| V-01 | 底色 hex → `bg-app`；三处同值 | QA-NAV-20、QA-X-27 |
| V-08 | 进度条三套配色 → brand/success | QA-X-14 |
| V-18 | 图标容器 5 种 → IconTile 36/40/48 | QA-X-11 |
| V-19 | 间距网格 → 4/8/12/16/24 | QA-X-28 |
| I-17 | 原生 select → Segmented | QA-X-21 |
| I-18 | 分页 4 套 → Pagination | QA-X-20 |
| N-10 | 单词本 4 入口计数 → `formatCount` | QA-X-13 |
| N-16 | 切 tab 滚动恢复 | QA-MOB-08 |
| C-10 | 删除 `InputScreen.tsx` | QA-X-25 |
| L-08 | CEFR 单一数据源 | QA-ASM-07 |
| L-10 | 空态给下一步动作 | QA-X-06 |
| L-11 | 三档布局契约 | QA-NAV-19 |
| L-14 | 后台恢复/网络恢复静默刷新 | QA-DSC-06 |

## 附录 D：证据锚点与命名

- **data-testid**：全仓 821 处、去重 674 个；`scripts/*.mjs` 依赖 77 个。优先用 `data-testid` 定位，不靠 CSS 选择器。
- **冻结的契约属性**（A4 §5.4，改名视为回归）：`data-word-hit`、`data-lookup-context`、`data-lookup-start`、`data-highlight`。
- **已知改名**（B3 起）：`review-close` / `report-close` / `ability-close` → `*-back`；现有脚本 0 引用，QA 需同步。
- **截图命名**：`<screen>-<width>-<lang>[-<state>].png`，例：`reader-375-vi-error.png`、`today-1440-zh-loading.png`。
- **命令输出**：贴最后一行即可（如 `i18n check passed: 1691 keys × 2 languages`）。

## 变更记录

| 日期 | 版本 | 变更 | 作者 |
|---|---|---|---|
| 2026-11-19 | v0.1 | 初稿：11 个模块 + 5 条横切检查项（已被 v1.0 取代） | A5 |
| 2026-11-19 | **v1.0** | 去掉初稿占位：12 个模块共 131 条可判定项；逐条挂审计 ID；补三种用法/最小必跑集/环境矩阵；加 V-06 31 键清单与 CI 规则草案；51 条 P0/P1 覆盖核对（缺失 0）；P2 抽样 13 条；testid 契约 | A5 |
