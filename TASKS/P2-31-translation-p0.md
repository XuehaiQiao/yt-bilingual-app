# P2-31 翻译 P0：thinking off + prompt 瘦身 + 稳定性

- status: claimed
- owner: {implementer: trans-p0-impl, reviewer: lead, integrator: lead}
- base_sha: e891f15
- evidence: docs/reports/translation-tuning-2026-11-24.md

## goal
按调优报告 P0 实施：
1) Qwen 翻译请求显式关闭 thinking（`thinking:{type:disabled}`，仅 Qwen 目录项）
2) 视频翻译 prompt 瘦身：输入 `{i,t}`、输出 `{r:[{i,t}]}`；去掉 start/end 与 en_text 回显；parser 兼容旧格式
3) 空/纯空白响应同候选重试 1 次；JSON/ID 对齐硬校验
4) 每批 90s deadline（provider 超时），超时进入降级
5) 保持旧 API/缓存/配额/降级语义；新 prompt version

## write_scope
- `backend/llm.py`
- `backend/translate.py`
- `backend/config.py`（Qwen thinking 标记/超时若需要）
- `backend/tests/test_translation_hardening.py`（新建）
- `backend/tests/test_ai_ledger.py`（payload 断言如涉及）
- `specs/001-streaming-pipeline/spec.md`
- `docs/reports/translation-tuning-2026-11-24.md`（状态回填）

## acceptance
1. Qwen 请求 payload 含 `thinking:{type:disabled}`；DeepSeek 不带未知参数；可用 mock/client 断言。
2. 新 prompt 输入无 start/end、输出不要求 en_text；真实/桩响应 `r/i/t` 正确对齐；旧 `blocks/id/en_text/zh_text` 仍可解析。
3. 空响应：同候选最多 2 次，再降级；不重复扣配额。
4. 90s 超时：单批超时取消/降级，不挂 180s。
5. JSON 解析/ID 覆盖/空译文/语言错误测试；全量 pytest；preflight。

## deps
- 无
