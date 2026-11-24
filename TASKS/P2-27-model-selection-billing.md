# P2-27 修复：显式选 Qwen 后仍走 DeepSeek

- status: claimed
- owner: {implementer: lead, reviewer: lead, integrator: lead}
- base_sha: bcb89d9

## 现象
用户把模型改为 Qwen 3.8 Flash 后：
1. 出现 Qwen-plus 调用（2 次 34 tokens）
2. 管理台计费仍显示 deepseek-chat

## 根因
`ai/quota.py::degradation_chain(preferred_model=...)` 只在「首选缺价」时把它放到链首；
**首选可用且有价时被忽略**，链首回落到 `DEFAULT_MODEL`（deepseek-chat）。
所以 translation/analysis/summary/define 等经 degradation_chain 的调用全部走 DeepSeek；
管理台按实际 model_id 记账，自然显示 deepseek-chat。Qwen-plus 的零散调用可能是另一次
显式选择/旧记录，修复后需复测确认。

## 修复
- `degradation_chain`：若 `preferred_model` 在目录且 `llm.is_usable` → 链首=它；
  否则才走 explicit_unpriced / DEFAULT_MODEL / 最便宜可用。
- 保持缺价显式模型仍在链首（严格计费 503 语义）。
- 测试：preferred != DEFAULT 时链首=preferred；缺价显式仍第一；默认路径不变。
- 用真实请求复测 ai_usage.model_id = qwen-flash（或实际选中模型），管理台同步。

## write_scope
- `backend/ai/quota.py`
- `backend/tests/test_ai_ledger.py`
- `backend/tests/` 相关 model selection 测试（如需要）
- `specs/034-balance-billing/spec.md`（说明实际模型记账）

## acceptance
1. preferred=qwen-flash 且可用有价 → chain[0]=qwen-flash。
2. 缺价显式模型仍 chain[0]=它；DEFAULT 回落路径不变。
3. 调用一次翻译/分析后 ai_usage.model_id 与请求模型一致；管理台按模型显示。
4. 全量 pytest；preflight。
