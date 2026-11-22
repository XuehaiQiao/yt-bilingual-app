# AI 开发者入口（AGENTS.md）

> 你是来二次开发这个项目的 AI agent？**只读 md 文件就能上手。** 按下面的顺序读，别先扎进代码。

## 这是什么项目

**语途（LinguaTrek）**：帮中文用户通过 YouTube 视频学英语的本地应用。三种学习模式：看视频（AI 双语字幕流式生成）、本地剧集（SRT）、句子精背。React 19 + FastAPI + Gemini / DeepSeek（多模型，模型适配层见 `backend/llm.py`、清单见 `MODEL_CATALOG`）。

## 读文档的顺序

1. **[CONSTITUTION.md](CONSTITUTION.md)** —— 项目宪法，7 条产品/工程原则。所有决策的最高依据，改代码前必读。
2. **[docs/架构.md](docs/架构.md)** —— 系统怎么运转：数据流、目录结构、前后端模块分工。
3. **[specs/README.md](specs/README.md)** —— 35 个功能各一份规格（做什么/为什么；`ls specs` 共 36 项 = 35 个规格目录 + 索引 README）。改哪个功能就读哪份，改完同步更新它。
4. **[docs/开发指南.md](docs/开发指南.md)** —— 怎么跑起来、怎么验证、规格驱动工作流。
5. 改 UI 才读 **[docs/设计语言.md](docs/设计语言.md)** —— 排版/颜色/材质/动效的配方，直接复制类名用。
6. 改 UI 或改数据契约 → 必读 **[docs/design-governance/](docs/design-governance/00-team-charter.md)**（门禁与交互规范，见下节「改 UI / 改数据之前」）。

每个代码文件夹里都有 `README.md` 描述该目录的文件与职责——进目录先读它。

## 硬性规则（违反即错误）

- **先规格后代码**：较大的新功能先在 `specs/` 写 spec（用 [.specify/templates/](.specify/templates/)），再实现；实现后把规格状态改为"已实现"并回填代码路径。
- **提交门禁**：前端 `cd frontend && npx tsc -b` 必须通过；后端 `cd backend && venv/bin/python -m py_compile *.py` 必须通过；UI 改动必须在浏览器实测过。
- **花钱/耗时的结果必须落盘缓存**（宪法原则 4）；失败要能自愈，不是报错了事。
- **不要提交**：`history/`（个人数据）、`subtitles/`（版权内容）、`.env`（密钥）——已在 .gitignore，别绕过。
- **UI 复用既有配方**（设计语言.md），不发明新样式；动效尊重 `prefers-reduced-motion`。
- **中文文档**：除根 README 外所有文档用简洁中文；提交信息用英文。
- **勤提交**：每完成一个子任务就 commit + push。

## 改 UI / 改数据之前（必读；跳过不算完成）

**任何用户可见改动**（`frontend/src/components/**`、`App.tsx`、`*.css`、`tailwind.config.*`、`i18n/*.json`、`lib/nav*.ts`，以及任何改变界面层级/跳转/操作方式的改动）先读：

1. [design-gate.md](docs/design-governance/design-gate.md) —— T1–T8 触发条件 + **G1–G8 八项门禁**（无新设计字面量 / 组件不出第二份 / 三态齐全 / Dialog 与键盘 / 导航与返回 / 移动端 / i18n / 写操作）；证据绑 `HEAD <sha7>`。
2. [interaction-spec.md](docs/design-governance/interaction-spec.md) §0.3 十条不变量：失败不得当空态、页面级导航不得用全屏遮罩、Dialog 完整契约、**路由是页面状态唯一事实源**、同一语义一种反馈层级……
3. [navigation-model.md](docs/design-governance/navigation-model.md)：页面目的地必须进路由；浮层只给临时态（登录 / 词卡 / 确认）。
4. [design-qa-checklist.md](docs/design-governance/design-qa-checklist.md) 里对应模块的检查条目。
5. 只复用 [design-system/](docs/design-governance/design-system/tokens.md) 的 token 与 `frontend/src/components/ui/*`；**同一语义只允许一个来源**（[团队章程 §4.5](docs/design-governance/00-team-charter.md)）。

**改数据契约 / 迁移 / 缓存键**：先 `grep` 全部消费方；空值/缺省路径要有测试；新迁移写清回滚；行为变化同步对应 `specs/00X`。**新增或拉取到新迁移后，本地验证前必须先跑 `cd backend && venv/bin/python -m alembic upgrade head`**——应用启动不会自动迁移，缺表只会 503/「未跑迁移」。

**提交前证据**：

```bash
cd frontend && npx tsc -b && npm run build && npm run check:i18n
node ../scripts/gate-receipt.mjs     # report-only，但必须跑并贴结果
```

UI 改动必须在浏览器实测，截图命名带 `@<sha7>`；**不得**宣称「UI/UX 治理完成 / 已达标可上线」——屏级覆盖仍未达 80%，见 [acceptance-review.md](docs/design-governance/acceptance-review.md)。

## 常用命令

```bash
./setup.sh                                   # 首次安装依赖
./start_app.command                          # 一键启动（macOS）
cd backend && source venv/bin/activate && uvicorn main:app --port 8000   # 后端
cd frontend && npm run dev                   # 前端 http://localhost:5173
cd frontend && npx tsc -b                    # 类型检查（提交门禁）
cd scripts && APP_URL=http://localhost:5173 node capture.mjs all         # 重录 README 动图
```

## 目录速查

| 目录 | 是什么 | 有 README |
|---|---|---|
| `backend/` | FastAPI 后端（模块分工见 `backend/README.md`，含 `llm.py` 模型适配层） | ✓ |
| `frontend/src/components/` | React UI 组件 | ✓ |
| `frontend/src/lib/` | 纯逻辑（无 UI） | ✓ |
| `content/sentences/` | 句子精背静态数据 | ✓ |
| `specs/` | 功能规格（35 份 + 索引） | ✓ 索引 |
| `docs/` | 架构/设计/开发文档 | ✓ 导航 |
| `scripts/` | 媒体录制、字幕下载工具 | ✓ |
| `mobile/` | Expo 移动端（对接经典 API，未跟进流式） | ✓ |
| `.specify/` | 规格/方案/任务模板 | ✓ |
| `history/`、`subtitles/` | 运行时数据（不入库） | — |
