# 最终验收复核（2026-11-19）

> 依据：A1–A5 交叉审阅、`remediation-plan.md`、`remediation-status.md`、`reports/coverage-2026-11-19.md`、`design-gate.md` v1.2、`design-qa-checklist.md` v1.2
> HEAD 验证点：`60ff0c4` + 最终修复；本轮所有验证为本地（无部署/无公开上线）

## 1. 四项验收

| # | 标准 | 结论 | 证据 / 剩余例外 |
|---|---|---|---|
| 1 | audit 的 P0/P1 都有规范条目或修复计划 | **PASS（带例外）** | **7/7 P0 已关闭**；51/51 P0/P1 有规范/映射；剩余 P1/P2 有 W3–W5 排期与 issue 归属。V-06 31/31 已中文化，14 死键已清零 |
| 2 | 令牌/组件覆盖 ≥80% UI | **PASS** | 元素 **594/596 = 99.7%**；屏级 **26/27 = 96.3%**；文件级 ≥80.6%（未重算，按上次口径）。唯一屏级例外是 reader 分栏拖拽 |
| 3 | design-gate 已嵌入 PR/合并流程 | **PASS（基础）** | `.github/pull_request_template.md` 8 项 + SHA 证据；CI 已跑 `check:i18n`；`design-scan` report-only；`gate-receipt` report-only。token/selector 自动 fail 尚未开，避免 846 条基线直接爆红 |
| 4 | QA 清单逐条对应审计问题，且可勾选 | **PASS（带例外）** | QA v1.2：**119 项**，51/51 P0/P1 覆盖（P0 7/7）；组件矩阵/对比度报告已存在。3 个不可判定项已改写/迁出；剩余 P2 抽样 |

**最终结论：四项验收均达到“通过”线；但第 1/3/4 项带明确例外，不能解读为“零遗留 UI 债务”。**

## 2. 已关闭的 P0

| ID | 修复 | 验证 |
|---|---|---|
| V-06 | 31 键中文化 + zh CJK 规则 + 死键清零 | check:i18n 1677 keys；V-06 31/31 |
| I-01 | StateView；失败→错误面板+重试 | Playwright 32/32 |
| I-02 | 频道弹窗 → 共享 Dialog | 键盘/焦点/滚动锁实测 |
| N-01 | 博客 URL slug + 刷新/分享/返回 | 8/8 |
| N-02/N-03 | 全前缀 URL + push/back/depth | 12/12 + 10/10 |
| L-01 | 移动学习页单滚动 | 375/390/430 200/200 |

## 3. 本轮已完成的其他收敛

- B2：ConfirmDialog、5 个基础弹窗、9 处复杂覆盖层、Toast 规范、原生 confirm 清零
- B3：BackButton/SubHeader/PageHeader，20 处返回 + 4 个一级页
- B4：Card/ListRow/Badge，迁移 6 页
- B5：Tabs/Segmented，8 处调用点
- Menu / Table / Switch / FilterChip / Axis / ShareCardCanvas
- 公开页 PublicShell；`#/dev/ui` 组件矩阵；13/13 对比度 token PASS
- W5b token/selector 扫描器 + 基线；CI `design-scan` report-only
- 死键 1691→1677；`i18n-allowlist` deadKeys=0

## 4. 仍需跟进（不阻塞本次验收）

| 项 | 原因 | 建议 |
|---|---|---|
| reader 分栏拖拽 | 高风险交互，A4 明示保留；唯一屏级例外 | 单独抽 `SplitPane`，补 27/27 |
| 单词本移动端词表 menu | B5 未做（需新 i18n 文案） | 下一迭代 |
| token/selector 自动 fail | 基线 846/53，直接开会让 CI 红 | 分批清到 0 后 `--fail` |
| 对比度 P2 观测 | `fg-muted` 在 raised ListRow 3.87/3.56 | 设计裁决后改 token 或用途 |
| 真机/iOS Safari/软键盘 | 本机 Chromium/mock | 发布前 QA |
| 管理员生产访问 `#/dev/ui` | 无管理员凭据 | 发布前人工验证 |
| 全局 banner 2 处 | 不摊单屏；仍非共享组件 | 后续壳层收敛 |

## 5. 门禁有效性

- `design-gate` 8 项：G1 字面量、G2 组件重复、G3 三态、G4 Dialog/键盘、G5 导航、G6 移动、G7 i18n、G8 写操作。
- PR 模板要求 `HEAD <sha7>` + 证据 `@<sha7>` + receipt；P0 阻断、P1 issue+owner+7 天。
- `check:i18n` 已进 CI；`design-scan` 只报告，不阻断。
- 本次验收不把 report-only 说成“自动门禁已全部落地”。

## 6. 复核命令

```bash
cd frontend && npx tsc -b && npm run build && npm run check:i18n
node --test scripts/check-i18n.test.mjs
node scripts/check-nav-e2e.mjs
node scripts/check-blog-deeplink.mjs
node ../scripts/gate-receipt.mjs --no-i18n
node ../scripts/contrast-audit.mjs --fail
```
