# P2-34 P1：配额单位改为 blocks/段落

- status: pending（等 P2-33 合并）
- owner: {implementer: quota-units-impl, reviewer: lead, integrator: lead}
- base_sha: bf3e7e4

## 目标
当前按“批”扣配额，与内容长度脱钩（60 批=1,200 blocks，1,372-block 视频必 429）。改为按内容量：
- `translate` / `local_show`：**1 单位 = 100 blocks**（每批 `ceil(blocks/100)`，至少 1）
- `reading`：**1 单位 = 10 段**（每批 `ceil(paragraphs/10)`，至少 1）
- `analysis`/其他：保持 1 次=1 单位
- 现有 env 默认 60 单位语义变为 60×100 blocks / 60×10 段；管理台/文档同步
- 不动 ai_quota 表结构；每批仍只扣一次（单位数变化）

## write_scope
- `backend/ai/quota.py`（单位换算 helper）
- `backend/translate.py`（process_llm_batch 单位）
- `backend/reading.py`（article 单位）
- `backend/config.py`（默认/文案如需要）
- `backend/tests/test_quota_admin.py`、`test_reading.py`、`test_translation_hardening.py`、相关
- `frontend/src/components/AdminQuotasPanel.tsx`（单位说明）
- `specs/034-balance-billing/spec.md`、`specs/001`、`specs/019`

## acceptance
1. 1,372-block 视频不再因 60 单位中途 429（按 14 单位计）。
2. 20 段文章 2 单位、10 段 1 单位；行为/配额头同步。
3. 400/429 文案与管理台单位说明一致；不改变预算/ops 语义。
4. 测试覆盖单位换算/边界/0 关闭；全量 pytest；preflight。
