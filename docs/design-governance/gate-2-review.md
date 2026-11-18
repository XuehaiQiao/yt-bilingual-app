# 门禁 2 评审：组件收敛方案

> 日期：2026-11-19 ｜ 评审：lead ｜ 输入：A4 `component-consolidation.md` + A2/A3 规范
> 结论：**通过**；阶段 2 交付的是映射与迁移方案，尚未改业务代码。下一步进入阶段 3（A5 门禁/QA 最终化）。

## 1. 交付规模

- 重复组：**23 组（G0–G22）**
- 映射行：**217 行**，8 列完整（旧实现/新组件/动作/依赖/优先级/预估/验证 + ID）
  > W6 修订（2026-11-19）：映射修正为 **222 行**（补 8 漏项 + 7 个 G0 键、删 3 重复、G22 7 行移出计数），见 `component-consolidation.md` 文首与 `remediation-status.md`。
- 未归属项：**0**
- 目标：**15 个 `components/ui/*` + 6 个新增 `lib/*`**（另扩展 `lib/favoriteSource.ts`）
- 批次：**5 批**，合计 **18.5 人日 + 1.5 人日视觉/回归**
- 自查：`rows=217 bad=0`；批次归集 217/217

## 2. 门禁 2 检查

| 检查项 | 结论 | 证据 |
|---|---|---|
| A1 C-01–C-16 全部有归属 | ✅ | §6.1；23 组覆盖 C/I/N 的组件实现部分 |
| 每个旧实现有迁移步骤 | ✅ | 217 行全部 8 列；动作限定为替换/包裹/保留别名/改名/保留/删除（W6 后 222 行，`rows=222 bad=0 dup=0 out_of_range=0`） |
| 目标组件与 A2/A3 无冲突 | ✅ | 6 个缺口已裁决并回写 A2（`371f854`） |
| 首批可独立执行 | ✅ | B1 不依赖 A3 URL 改造；前置 token 配置可单独合并/回滚 |
| 未归属项 | ✅ 0 | 导航/守卫/URL 条目明确归 A3，不算遗漏 |

## 3. A4 发现的 6 个 A2 缺口（已解决）

| ID | 裁决 | 回写 |
|---|---|---|
| Q-A4-01 `bg-zinc-100` 无 token | 新增 `colors.control = #f4f4f5` → `bg-control` | `tokens.md` 已加 |
| Q-A4-02 `OPTION_BASE` 无组件 | 登记为 `C2b OptionCard`（C2 子组件） | `components.md` 已加 |
| Q-A4-03 `resolveFavoriteSource` 路径错 | 指向 `lib/favoriteSource.ts`，扩展 `canOpen` | `components.md` 已改 |
| Q-A4-04 Pagination offset | 组件保持 `page/pages`，调用方换算 | A4 已定 |
| Q-A4-05 BottomBar 不适合 Tabs | BottomBar 保留自有布局，只用 CountBadge/token | A4 已定 |
| Q-A4-06 浮层 13 vs 14 | 以实测 **14** 为准（含 ProcessingOverlay/guest-auth） | `components.md` 已改 |

## 4. 风险与顺序

1. **视觉风险**：卡片 24→16px、按钮 h-11→40、`zinc-50→fg-primary`、`zinc-600` 提亮；B4/B5 必须逐屏截图对比。
2. **导航风险**：D-01/D-02 的 URL/返回由 A3 实施；A4 组件只接 `onBack`/`onChange`/`onClose`，不碰 history。
3. **测试选择器**：`data-word-hit`、`data-lookup-context`、`data-lookup-start`、`data-highlight` 冻结；`start-mode-select` 原生 select→Segmented 需同批改 Playwright。
4. **批次顺序**：B1 基座 → B2 覆盖层 → B3 导航壳 → B4 状态/卡片/分页/词卡 → B5 高风险交互件。禁止大爆炸重写。
5. **实施未开始**：本阶段只交方案；代码收敛按批次执行，阶段 4 的 remediation-plan 决定上线前做到哪一批。

## 5. 门禁 2 结论

- ✅ 映射完整、迁移步骤可逐行执行、未归属 0。
- ✅ A2/A3/A4 无相互冲突；6 个缺口已登记并回写。
- ✅ B1 可独立开始，回滚路径明确。
- ⚠️ 阶段 2 没有改代码；实际收敛与视觉回归是后续实施任务，不得把「方案存在」当成「组件已统一」。

**建议：门禁 2 通过，进入阶段 3（A5 将规范转成 PR 门禁 + 模块化 QA 清单）。**
