# P2-14 观影模式体验设计稿（先设计，后实现）

- status: claimed
- owner: {designer: lead, reviewer: 用户, integrator: lead}
- base_sha: e506450

## goal
把观影模式从“功能可用”提升为“体验成立”。本卡只产出设计规格 + 3 张目标稿（桌面/移动/空态），不改业务代码。

## write_scope
- `specs/045-watch-mode-experience/spec.md`
- `docs/design/watch-mode/index.html`
- `docs/design/watch-mode/mock-desktop.png`
- `docs/design/watch-mode/mock-mobile.png`
- `docs/design/watch-mode/mock-empty.png`
- `docs/design/watch-mode/README.md`
- `TASKS/board.json`、本卡

## acceptance
1. 规格覆盖：层级、舞台、字幕、词条、控制、状态、移动端、可访问性、验收指标。
2. 3 张目标稿：1440 桌面 / 375 移动 / 无分析空态；与实际尺寸一致，可直接对照实现。
3. 明确“保留/移除/新增”清单与实施顺序；不直接改 `frontend/`。
4. 用户确认视觉方向后，另开实现卡。
