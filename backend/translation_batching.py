"""翻译分批策略（P2-33）：首批小批 + 稳定期按「条数 + 源 token 预算」切批。

调优报告（docs/reports/translation-tuning-2026-11-24.md §5.1）的双阈值：
首个批次小（抢首屏），稳定期批量大（总成本/吞吐）；条数不是唯一上限，
同一批的源 token 也要有预算，避免长段落/长 block 让单批 token 波动 10×。

token 估算只是**英文字符近似**（4 chars ≈ 1 token），不是分词器：
- CJK、emoji、URL、代码、连字符等会偏离真实 token；
- 只用来提前切批，不用于计费、配额、缓存键或质量判断。

本模块不依赖 app 其他模块，便于单测。
"""
from __future__ import annotations

import math
from collections.abc import Callable, Iterable
from typing import TypeVar

T = TypeVar("T")

# 视频（SSE 流式 + 经典路径）：首批 10 blocks 抢首屏；稳定期 40 blocks。
VIDEO_FIRST_BATCH_SIZE = 10
VIDEO_STEADY_BATCH_SIZE = 40
VIDEO_MAX_SOURCE_TOKENS = 2000

# 文章：段落可能长达 4,000 字符，所以首批 5 段、稳定期 20 段，预算同上。
ARTICLE_FIRST_BATCH_SIZE = 5
ARTICLE_STEADY_BATCH_SIZE = 20
ARTICLE_MAX_SOURCE_TOKENS = 2000

CHARS_PER_TOKEN = 4


def estimate_tokens(text: str) -> int:
    """英文源文本的近似 token 数：``max(1, ceil(len(text) / 4))``。

    空串也按 1 计（送模型总有最小开销）。局限见模块 docstring：这是字符
    粗估，不是真实 tokenizer，只用于切批。
    """
    return max(1, math.ceil(len(text) / CHARS_PER_TOKEN))


def chunk_by_budget(
    items: Iterable[T],
    text_fn: Callable[[T], str],
    first_size: int,
    steady_size: int,
    max_tokens: int,
) -> list[list[T]]:
    """按「条数 + 源 token 预算」把 items 切成有序批次。

    规则：
    - 首批最多 ``first_size`` 条；之后每批最多 ``steady_size`` 条；
    - 每批累计源 token（``estimate_tokens``）不超过 ``max_tokens``；
      下一批会超预算时，在超预算项之前切；
    - 单条自身就超预算时仍**单独成批**（不丢弃、不拆条）；
    - 不产生空批；返回顺序与输入顺序一致。

    输入为空时返回 ``[]``；参数必须为正整数，否则 ``ValueError``。
    """
    if first_size < 1 or steady_size < 1 or max_tokens < 1:
        raise ValueError("first_size / steady_size / max_tokens 必须 ≥ 1")

    batches: list[list[T]] = []
    current: list[T] = []
    current_tokens = 0
    size_limit = first_size

    for item in items:
        tokens = estimate_tokens(text_fn(item) or "")
        if current and (
            len(current) >= size_limit or current_tokens + tokens > max_tokens
        ):
            batches.append(current)
            current = []
            current_tokens = 0
            size_limit = steady_size
        current.append(item)
        current_tokens += tokens

    if current:
        batches.append(current)
    return batches
