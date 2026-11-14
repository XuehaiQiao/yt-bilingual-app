"""AI 成本账本、三层配额与模型降级链（M1 地基）。

- ``ai.ledger``：``ai_usage`` 账本（只追加）+ ``ai_quota`` 日配额原子计数；
  价格表来自 ``config.MODEL_CATALOG``，未知价格按「已知最贵」计。
- ``ai.quota``：每用户/每功能日限额 + 每用户日预算 + 全局日预算三层硬闸，
  以及「同 provider 更便宜 → 另一个可用 provider」的降级链。

运行时只读写这两张表，schema 由 Alembic ``0003_cost_ledger`` 创建。
"""
