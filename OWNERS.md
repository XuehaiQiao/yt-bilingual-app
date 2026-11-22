# 所有权（OWNERS）

> 每个目录/契约有一个 Owner；共享文件只有 Integrator 能写。
> 本文件随架构批准生效；Owner 变更必须改本文件并说明原因。

| 资产 | Owner | 审批 | 覆盖路径 |
|---|---|---|---|
| 词汇（我的单词/已掌握/自定义词表） | vocabulary-owner | Architect | `frontend/src/domains/vocabulary/**`（迁移后）、`frontend/src/components/Vocabulary*.tsx`、`frontend/src/lib/{favorites,wordlists,review}.ts`、`backend/{wordlists.py,routes_wordlists.py,srs.py}` |
| 阅读与教学分析 | reading-owner | Architect | `frontend/src/core/reading/**`、`frontend/src/components/{ReaderScreen,LibraryArticleReader,BookReaderScreen,ImportedBookReaderScreen}.tsx`、`backend/{teaching_analysis.py,routes_reading.py,routes_library.py,routes_videos.py,routes_books.py}` |
| 播放/听读 | playback-owner | Architect | `frontend/src/lib/{tts.ts,useReadingAudio.ts}`、`frontend/src/components/ReadingAudio*.tsx`、播放器组件 |
| 计费/配额 | billing-owner | 负责人 | `backend/{billing.py,config.py}`、`backend/ai/**`、`scripts/warm_library_analysis.py` |
| 契约与 Flag | contract-owner | 负责人 | `CONTRACTS/**`、`docs/flags.md`、`docs/data-map.md` |
| 设计系统 | design-owner | 负责人 | `frontend/src/components/ui/**`、`docs/design-governance/**` |
| 共享文件 | **仅 Integrator** | 负责人 | `frontend/src/App.tsx`、`frontend/src/i18n/*.json`、`package*.json`、`frontend/src/lib/nav*`、`backend/migrations/**`、`.github/**`、`scripts/gate-receipt.mjs`、`specs/README.md` |
| 架构与 ADR | architect | 负责人 | `ARCHITECTURE.md`、`ADR/**`、`TASKS/**`、`docs/多agent协作工作流.md` |

## 写规则

1. 任务卡 `write_scope` 是唯一写权限；白名单外 1 行即失败。
2. 共享文件只能由 Integrator 按任务卡 `shared_writes` 修改；其他 agent 只能提交 patch 建议。
3. 契约、迁移、i18n key、flag 默认值变更需要 Architect/负责人审批。
4. 任何人不得绕过门禁（`tsc/build/pytest/i18n/gate-receipt`）合并。
