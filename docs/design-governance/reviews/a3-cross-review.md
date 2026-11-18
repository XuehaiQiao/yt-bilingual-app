# A3 阶段 4 交叉审阅：交互与导航
> 只读评审；未改代码。

## 结论
**有条件通过。** A2 的 Dialog（焦点陷阱/滚动锁/inert/Esc/焦点回填）、BackButton、Toast 位置、非模态词卡、Tabs/Segmented 键盘均有契约；A4 落位正确，「组件不碰 history」在 `ui/` 契约层成立（只发 `onBack/onChange/onClose`）。A5 对 I/N 的 P0/P1 在 ID 层可逐条对应：N-01→DSC-03、N-02→NAV-03、N-03→NAV-01/02、N-18→NAV-07、I-01/02→X-01/02。A4 把 Dialog/Confirm/Toast 放 B2、BackButton/NavShell 放 B3、Tabs/Segmented 放 B5、WordCard 放 B4/B5，落位正确。G5 可人工执行，但当前基线（前缀/锚点/子→子 replace）不通过，需 B0 后启用。真问题是 **D-01/D-02 无实施批次，IA §7 旧模型仍在，现有 nav.ts/useNav/App 就是旧实现**。共发现 7 项（P0 1 / P1 5 / P2 1）。

## 冲突与漏项
1. **P0 · D-01/D-02 漏在批次外。** A4 B1–B5 共 217 行无 nav.ts/useNav；A4 明写「归 A3」，B1 入口却要求 A3 改造「未开始或已冻结」，B3 入口又依赖 `parentOf/backLabelFor`——无 B0 便无 owner/顺序，B1–B5 全做完仍剩 N-01/02/03 三个 P0 与 N-18。证据：nav.ts 的 learn/lesson 无 tab 前缀、`#/content/library` 被丢弃；useNav 用 `history.length` 判可回退、无 `dshNav.depth`；App `openSub` 遇 sub 即 replace、`closeWordbookForJump` 仍在（App.tsx:989/1001/1046/1048）。
2. **P1 · IA 修订只写在文首，§7/§8.2 旧文未废止。** §7.2/§7.5/§8.2 仍列 `#/learn/...`（无前缀），§8.2 旧挂载表仍按固定归属 tab；§7.3 仍「子视图栈深恒为 1」、子→子 replace、返回回前缀 tab；§7.2 阅读器「未登录回 `#/content`」与 D-09/IX-17 冲突；§7.1 `tabOfSub(sub)` 单参、useNav 无 `replace`。当前代码正按 §7 实现，说明文首的「优先」没有生效。
3. **P1 · A2 与 A3 的 Toast 数值冲突。** A2 C8：info 4s、同 key 2s 去重、超 3 条丢最旧；A3 IX-08：info 5s、5s 去重、超出排队。A4 取 A3，QA-X-07 只写「TTL/去重/上限」无法仲裁。
4. **P1 · BackButton aria 契约不一致。** A2 C12 只 `aria-label={t('nav.back')}`；A3 NM §5.1 要「返回<父级>」由 `backLabelFor` 给出。A4 已补 `parentLabel`，A2 未回写；QA-NAV-12 会抓，但组件源头错误。
5. **P1 · QA-X-02 把词卡当模态。** 「所有浮层」要求焦点陷阱、背景滚动锁、`aria-modal`，与 A3 IX-21 词卡 `aria-modal=false`、不锁滚动、不做焦点陷阱冲突——会误判或诱导错实现。
6. **P1 · A5 有 3 个洞。** ① Tabs/Segmented 的方向键/Home/End/roving/`aria-selected/checked` 无 QA，QA-X-12 只查视觉；② A3 §3.3 新增约束（估价失败先确认、路由变化关覆盖层、词卡键盘）与 IX-10 的路由切换焦点未转 QA；③ QA-X-12 的 Segmented 仍是 `bg-surface-2/60`/`text-xs`，A2/A4 已改 `.../80`/`text-caption`。
7. **P2 · A2 C12 / A4 G8-17 内部矛盾。** L-09 说考试头保留「返回+标题+关闭」，API 又规定 `onClose` 只给 Dialog；与 A3 D-04/I-11「Exam 等页面级 X 全换 BackButton」冲突，需裁决「关闭」是业务退出（IX-24）还是删除。

## 实施顺序
**B0（新增，阻塞 B3）**：先修文档（IA §7 标作废、A2 Toast/aria、A5 三条），再改契约。① nav.ts：全前缀 `parse/toHash`、`SectionAnchor`、`parentOf/backLabelFor/resolveRoute/sameRoute`，加互逆属性测试；② useNav：`dshNav.depth`、push/replace/back、深链按 `parentOf` 兜底、legacy 表、非法路由一次 toast、路由变化关层；③ App：`openSub` 一律 push、删 `closeWordbookForJump`、report/review 任意来源 tab、`#/content/library` 滚动、登录 `next`。完成后再 B3→B4→B5；B0 可与 B1 并行（B2 仍依赖 B1），但 B1 入口「A3 未开始或已冻结」应改为「契约冻结、文件不重叠」。最后跑 QA-NAV-01–08/12 与 G5。

## Remediation / 上线前
- **P0 闸**：I-01、I-02、N-01、N-02、N-03 + B0 契约。
- **P1 上线前**：N-18、I-03/I-04、I-11/D-04（X→BackButton 含父级 aria）、I-05、I-10（5/3/8s、避底栏、离线标记上移）、I-14/N-05。
- **QA/门禁修补**：QA-X-02 增非模态词卡例外；QA-X-12 改 A2 token 并加键盘/ARIA 项；新增词卡 roving、估价失败确认、路由变化关层/焦点三项；G5 增「深链打开后 BackButton 留应用内父级/列表」，并把 N-02/N-03 的落点偏差按 P0 处理。
- **A4 验证**：`grep "history\\.\\|location.hash" frontend/src/components/ui/` 待 `ui/` 落地后跑；当前目录不存在，A4 的 0 只是契约声明。
