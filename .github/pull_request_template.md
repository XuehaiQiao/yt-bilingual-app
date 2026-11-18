HEAD <sha7>

<!-- 首行必填：HEAD <sha7> = `git rev-parse --short=7 HEAD`。
     截图 / 录屏 / 回执文件名必须带 @<sha7>（例：reader-375-vi-error@a1b2c3d.png）。
     首行 SHA 与证据文件名不一致 = 旧证据，按未提供处理。 -->

## 变更摘要

<!-- 一句话：改了什么、为什么。 -->

- 关联 issue / spec：
- 影响范围：<!-- 前端 UI / 前端非 UI / 后端 / 文档 / 门禁自身 / 其他 -->
- 门禁自身改动（CI / PR 模板 / `gate-receipt` / i18n 脚本）：是 / 否

## 机器门禁

- [ ] `cd frontend && npx tsc -b` 通过（CI 自动跑）
- [ ] `npx vite build` 通过（CI 自动跑）
- [ ] `npm run check:i18n` 通过（CI 自动跑）
- [ ] `node scripts/gate-receipt.mjs` 已跑（**report-only，不阻断**；回执贴下方）
- [ ] 证据文件名带 `@<sha7>`，与首行 HEAD 一致

<details><summary>check:i18n 输出</summary>

```text
（粘贴最后一行：i18n check passed: …）
```

</details>

<details><summary>gate-receipt 回执（HEAD <sha7>）</summary>

```text
（粘贴 node scripts/gate-receipt.mjs 的 [G1] / [G2] / [G4] / [G6] / [i18n] 段；完整输出更佳）
```

</details>

## 设计门禁（仅 UI 改动填写；非 UI 改动勾本节最后一行跳过）

> 8 项全「是」或例外已登记才可合并；**没有证据的勾选视为未通过**。判据：`docs/design-governance/design-gate.md`（v1.2）。
>
> **证据绑 SHA**：PR 首行写 `HEAD <sha7>`；所有截图 / 录屏 / 回执文件名加 `@<sha7>`；评审 3 秒核对首行与后缀一致。SHA 不符 = 旧证据，按未提供处理。
>
> **P0 阻断**：P0（`design-gate.md` §3.1）不合并。`gate-receipt` 只给机械计数，不判定 P0；评审仍按 G1–G8 判。

- [ ] **G1 令牌**：无新增裸色值 / 任意字号 / 任意 z-index / 任意阴影（A2 T-01…T-15）；例外已注释并登记（例外数：__）
- [ ] **G2 组件**：复用 Button / Card / Dialog / Tabs / Segmented / Badge / EmptyState / Pagination；新共享组件只在 `components/ui/`；无旧常量 / 新文件重复实现
- [ ] **G3 三态**：加载 / 空 / 错误齐全；失败不渲染成空态，有重试入口
- [ ] **G4 对话框与键盘**：Escape / 遮罩 / X 可关；role + 焦点回填 + 滚动锁；焦点可见；无新增 `window.confirm`；裸 `outline-none` 例外仅限 `focus-within` 输入壳
- [ ] **G5 导航**：URL 可分享可刷新；返回回来源；切 tab 不堆历史；刷新不自动触发处理 / 付费
- [ ] **G6 移动端**：375 无横向滚动；单滚动容器；`dvh`；底栏与安全区不挡主操作
- [ ] **G7 文案**：走 `t()`；zh-CN / vi-VN 同步；中文界面无英文文案
- [ ] **G8 写操作**：按钮内 loading + 成功反馈 + 失败可回滚；危险操作二次确认；游客门禁在入口

### 设计走查证据

> 文件名统一 `<screen>-<width>-<lang>[-<state>]@<sha7>.png`；链接不带后缀或后缀不符的，按旧证据处理。

| 证据 | 链接 / 说明（文件名带 @<sha7>） |
|---|---|
| 1440 截图 | |
| 375 截图 | |
| 1024 / 768 截图（改了导航壳或断点才需要） | |
| 键盘走查（Tab / Enter / Esc + 焦点截图） | |
| 语言切换（zh-CN ↔ vi-VN） | |
| 异常态（断网 / 500 的空态、加载、错误） | |
| 门禁回执（G1/G2/G4/G6 计数 + i18n 末行） | |
| 组件矩阵 `/dev/ui`（W3 后续；未实现前不勾） | |
| G1 / G2 / G4 / G6 命令输出（0 行 = 通过；优先贴 receipt） | |
| 例外登记（`design-exception` 行号 + 原因） | 无 |

## 遗留 P1（可合并，需 issue + 负责人，7 天内修）

| 检查项 | 现象 | issue | 负责人 |
|---|---|---|---|
|  |  |  |  |

## 合并声明

- [ ] 首行 `HEAD <sha7>` 与所有证据的 `@<sha7>` 一致（不一致 = 旧证据，按未提供处理）
- [ ] 无未解决的 P0；`gate-receipt` 命中为 0，或命中已按 §5 登记例外并在 PR 说明
- [ ] P1 已登记 issue 与负责人（到期 ≤7 天）
- [ ] 本次为纯后端 / 文档 / 无用户可见改动，跳过设计门禁（原因：__）
