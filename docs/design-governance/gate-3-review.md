# 门禁 3 评审：设计门禁与 QA 落地

> 日期：2026-11-19 ｜ 评审：lead ｜ 输入：A5 `design-gate.md` / `design-qa-checklist.md` / PR 模板
> 结论：**通过**；门禁已嵌入 PR 流程，`check:i18n` 已接入 CI；进入阶段 4（交叉验证 + remediation plan）。

## 1. 交付规模

| 项 | 结果 |
|---|---:|
| 设计门禁检查项 | **8 项**（G1–G8），5 分钟时间盒 |
| 触发源 | **T1–T8**，精确到路径/变更类型 |
| QA 模块 | **12 个**（11 功能 + 横切） |
| QA 检查项 | **131 项**（全部是/否可判定） |
| QA P0 项 | **12 项** |
| P0/P1 覆盖 | **51/51，缺失 0**（V 12 / I 14 / N 9 / C 9 / L 7） |
| P0 覆盖 | **7/7** |
| V-06 例外 | 31 键 + 白名单 14 键 + CI 规则草案；`sentences.day` 待裁决 |
| P2 抽样 | 13 条 |

## 2. 门禁 3 检查

| 检查项 | 结论 | 证据 |
|---|---|---|
| 门禁触发条件明确 | ✅ | `design-gate.md` §1：T1–T8；不触发项列明 |
| 检查项可执行、不冗长 | ✅ | 8 项是/否 + 证据 + 失败等级 + 豁免，5 分钟 |
| 已嵌入 PR 流程 | ✅ | 新建 `.github/pull_request_template.md`：机器门禁 + 设计门禁 + 截图/键盘/i18n/异常态证据 + P1 遗留表 |
| 已嵌入 CI | ✅ | `.github/workflows/ci.yml` 前端 job 新增 `npm run check:i18n`；tsc/build 原有 |
| QA 按模块组织 | ✅ | 12 模块：NAV/VID/RDR/BOOK/VOC/CRS/ASM/DSC/ACC/ADM/MOB/X |
| QA 全部可勾选 | ✅ | 每项「是/否 + 关联审计 ID + 级别 + 证据/步骤」 |
| P0/P1 逐条对应 | ✅ | 附录覆盖核对表 51/51；P0 7/7 |
| 不伪造已完成 | ✅ | 90 条存量问题、31 键文案、token 自动检查均明确未完成 |

## 3. 本轮实际改动

| 文件 | 说明 |
|---|---|
| `docs/design-governance/design-gate.md` | v1.1：8 项门禁、触发源、合并规则、证据、度量、阶段 4 计划 |
| `docs/design-governance/design-qa-checklist.md` | v1.0：131 项、12 模块、最小必跑集、V-06 31 键清单 |
| `.github/pull_request_template.md` | 新建：PR 勾选 + 证据 + 例外 + P1 遗留 |
| `.github/workflows/ci.yml` | 前端 job 增加 `npm run check:i18n` |
| `docs/design-governance/audit-report.md` | V-06 备注：A5 复核为 31 键（初审计 24） |

## 4. 尚未完成（不能误报）

1. **90 条存量问题未修**：本阶段只建门禁，不修 UI。
2. **31 个中文英文键未改**：V-06 仍是上线前 P0；`check:i18n` 只能防结构漂移，测不出「zh 值仍是英文」。
3. **token/选择器自动扫描未接**：阶段 4 设计；需先清基线，避免当前仓库直接爆红。
4. **组件收敛未实施**：A4 只交 217 行映射（W6 修正为 222 行，见 `remediation-status.md`），B1–B5 尚未开始。
5. **真机/无障碍未实测**：iOS Safari、软键盘、VoiceOver 留给发布前 QA。

## 5. 门禁 3 结论

- ✅ A5 交付完整：PR 门禁 + 模块 QA + 覆盖核对 + PR 模板 + CI i18n。
- ✅ 门禁轻量：8 项 + 5 分钟，不加审批人。
- ✅ QA 可防复发：131 项逐条挂审计 ID。
- ⚠️ 门禁通过只证明「以后能挡住同类问题」，不证明「现有问题已修」。

**建议：门禁 3 通过，进入阶段 4：五角色交叉验证 + `remediation-plan.md`（上线前必须 vs 上线后迭代）。**
