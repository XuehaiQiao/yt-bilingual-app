# 任务卡（TASKS）

每张卡是一份可执行契约：目标、非目标、**可写文件白名单**、只读上下文、验收命令、依赖、Owner、回滚。
派活时只给卡路径；实现者先读卡，再读卡内 `read_only` 文档。

状态：`proposed → ready → claimed → in_review → approved → merged → closed`。
