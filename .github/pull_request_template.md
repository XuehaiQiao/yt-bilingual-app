## 变更摘要

<!-- 一句话：改了什么、为什么。 -->

- 关联 issue / spec：
- 影响范围：<!-- 前端 UI / 前端非 UI / 后端 / 文档 / 其他 -->

## 机器门禁

- [ ] `cd frontend && npx tsc -b` 通过（CI 自动跑）
- [ ] `npx vite build` 通过（CI 自动跑）
- [ ] `npm run check:i18n` 通过（CI 自动跑）

<details><summary>check:i18n 输出</summary>

```text
（粘贴最后一行：i18n check passed: …）
```

</details>

## 设计门禁（仅 UI 改动填写；非 UI 改动勾本节最后一行跳过）

> 8 项全「是」或例外已登记才可合并；**没有证据的勾选视为未通过**。判据：`docs/design-governance/design-gate.md`。

- [ ] **G1 令牌**：无新增裸色值 / 任意字号 / 任意 z-index / 任意阴影；例外已注释并登记（例外数：__）
- [ ] **G2 组件**：复用 Button / Card / Dialog / Tabs / Segmented / Badge / EmptyState / Pagination；未复制第二份实现
- [ ] **G3 三态**：加载 / 空 / 错误齐全；失败不渲染成空态，有重试入口
- [ ] **G4 对话框与键盘**：Escape / 遮罩 / X 可关；role + 焦点回填 + 滚动锁；焦点可见；无新增 `window.confirm`
- [ ] **G5 导航**：URL 可分享可刷新；返回回来源；切 tab 不堆历史；刷新不自动触发处理 / 付费
- [ ] **G6 移动端**：375 无横向滚动；单滚动容器；`dvh`；底栏与安全区不挡主操作
- [ ] **G7 文案**：走 `t()`；zh-CN / vi-VN 同步；中文界面无英文文案
- [ ] **G8 写操作**：按钮内 loading + 成功反馈 + 失败可回滚；危险操作二次确认；游客门禁在入口

### 设计走查证据

| 证据 | 链接 / 说明 |
|---|---|
| 1440 截图 | |
| 375 截图 | |
| 1024 / 768 截图（改了导航壳或断点才需要） | |
| 键盘走查（Tab / Enter / Esc + 焦点截图） | |
| 语言切换（zh-CN ↔ vi-VN） | |
| 异常态（断网 / 500 的空态、加载、错误） | |
| G1 / G2 命令输出（0 行 = 通过；命令见 `docs/design-governance/design-gate.md` 附录 C） | |
| 例外登记（`design-exception` 行号 + 原因） | 无 |

## 遗留 P1（可合并，需 issue + 负责人，7 天内修）

| 检查项 | 现象 | issue | 负责人 |
|---|---|---|---|
|  |  |  |  |

## 合并声明

- [ ] 无未解决的 P0；P1 已登记 issue 与负责人（到期 ≤7 天）
- [ ] 本次为纯后端 / 文档 / 无用户可见改动，跳过设计门禁（原因：__）
