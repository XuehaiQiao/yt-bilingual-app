# A4 交叉审阅：组件收敛方案

**结论**：映射主体可执行，但门禁 2 的「未归属 0」不成立；B1–B5 有多处依赖倒置与假兼容；A5 只能验证页面一致性，不能证明组件收敛。建议按风险重切批次。共 17 项（4 阻断：G0 31 键、映射漏行、批次依赖、Dialog 契约；10 重要 / 3 轻微）。

## 1. 映射与批次
- 复跑自查 `rows=217 bad=0`；但脚本只验每行动词，39 行动作仅「替换/替换；常量删除」，未含步骤。
- 抽查至少 3 组漏行：`DiscoverScreen:371/382/392/474/483`（错误/空态 retry、login、back）、`StartLearning:162`（compact 提交）无映射；`Placement:975/1245` 仅由 G22-04「抽 Button」兜底。未归属只在文件级成立，不能按实现点验收。
- 217 含 G22-01..07「保留/0 人日」与 2 行别名，实际迁移 208 行。
- B1 的 G1-16（随 B2）无法在 B1 收口，G16-13/14 与 B3 的 G11-09/10 重叠；B2 的 G3-02 用 B4 的 LoadingState；B4 入口反写「B2 的 ErrorPanel」。B3/B4 称可并行，但 B4 G7-03 用 B3 的 Badge，且都改 VocabularyBookScreen。
- 别名不成立：WordPopover 旧 props 是 `word/context/x/y/onSwitchWord`，WordCard 要 `target/onRetarget`；VocabPagination 无 `summary`，Pagination 必填。漏一个调用点即 tsc 红。

## 2. 首批契约缺口（Button/Dialog/BackButton/Toast/词卡）

已足够：Button 的尺寸/禁用/loading、BackButton 的 parentOf/backLabelFor、Toast 的 8s/去重/位置、词卡的定位/焦点/非模态规则。缺口如下：
- Dialog：C4 固定 `role="dialog"`，G3-13 又要 `alertdialog`；无 fullscreen（G3-14）；状态矩阵有 loading/error，props 没有；无 dirty/onBeforeClose，IX-15 的放弃确认与 IX-09「禁止嵌套」无落点（G3-02 失败→ConfirmDialog 须写明先关再开）。
- Button/IconButton：`onClick:()=>void` 与 G14-10 `handleDelete(e,…)` 不兼容，需 wrapper；`type` 默认值未定，建议默认 `button`、submit 显式。
- Toast：A3 要求 >3 排队，A4 只写最多 3 条。
- 词卡：loading/ready/error 无 props，取数归属未写；alias 见上。
- BackButton：A3 有 parentOf/backLabelFor，可用；但 dirty 拦截归 A3 还是 A4 未写。

## 3. A5 QA 与 G1/G2
- QA 131 条以页面为主；源码收敛仅 QA-X-11/12/13/19/25/26，均 P1/P2，无 P0。QA-X-11 只 grep「新增常量」，不查存量；QA-X-25 又要求拆 >1000 行，与 A4「留上线后」冲突。
- 除 QA-X-13/25 零散项外，没有系统对应 A4 批次出口的收敛断言（旧常量=0、弹窗壳=1、ruby=1、别名=0、导入图）。B2 出口 14 个弹窗，QA-X-02 只抽 5 个。
- G2 只匹配固定 const 名，内联 class、改名常量、新文件另起实现都能绕过；同屏两壳只靠人工 P0 判断；迁移豁免无到期；G1/G2 仍人工 5 分钟、CI 未接。→ 不能防重复实现。

## 4. 顺序与 B1 最小切片
- 原序把 I-01（P0）压到 B4，先做 B3 的 P1 一致性，风险/价值错配。建议 B0 底座（tokens、Badge/CountBadge、StateView、Dialog 骨架）→ B1（G0 24 键+Button，另 7 键随 B2/B4）→ B2 → B4-P0（G12-17..20）→ B3 → B4 其余 → B5；倒置消除，B0 独立可回滚。
- 五个「首批组件」实际跨 B1/B2/B3/B4，按字面同批做会违反依赖；首刀应只用 B1 切片：token 配置 PR + `lib/cn.ts` + `ui/Button.tsx` + AccountScreen 的两个常量（87/89）及 3 个调用点（309/550/715）。
- 验收：`cd frontend && npx tsc -b && npx vite build && npm run check:i18n`；`! grep -nE 'PRIMARY_BUTTON|SECONDARY_BUTTON' src/components/AccountScreen.tsx`；`grep -c 'ui/Button' src/components/AccountScreen.tsx` 为 1；`npx eslint src/components/ui/Button.tsx`；375/1440 账户页截图只允许已登记圆角 12→8；焦点环、44 命中通过。
- 先修 G0：A1/A5 已复核 31 键（新增 7 键），A4 仍写 24；B1 至少做 24，另 7 键登记到 B2/B4，上线门禁按 31。

## 5. 上线前后
- 上线前必须：V-06（31 键）+ I-02（频道弹窗）+ I-01（G12-17..20 失败不当空）；依赖 B1、B2、B4-P0（A3 的 N-01..03 另计）。B2 全批（3 处 window.confirm、Toast 位置）建议随上线；B1 的 G6 点词/G16 时间格式可后置。
- 可上线后：B3（BackButton/页头）、B5（Tabs/Segmented/ruby/Progress/Field/Vocab）、B4 其余（卡片/列表/分页）、G22 拆分、61 处内联卡片；均 P1/P2，不阻主流程。若延后，A3/A5 保留例外，不当作已完成。若必须上线前统一返回，只提前 B3 的 BackButton 子集（不搬页头）。

## remediation（交 A4）
1. 补 3 处漏行与 31 键（7 键分配批次）；G22 保留行移出 217；B1 去掉/移走 3 行跨批项。
2. 提供 WordCard/VocabPagination 兼容适配器，或撤回「props 兼容」承诺。
3. Dialog 补 role/fullscreen/loading/error/onBeforeClose；G14-10 用 wrapper，Button 明确默认 type=button；Toast 补 queue；词卡写清取数。
4. 批次出口脚本化并挂 CI（先 warn 后 error）。
5. A5 增「组件收敛」P0 项；QA-X-25 拆分；G2 增内联/新文件检测。
