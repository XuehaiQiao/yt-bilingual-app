"""P2-33 token-aware 分批（``translation_batching``）的离线单元测试。

覆盖：
1. ``estimate_tokens`` 的近似口径与边界（空串、4 字符、非整除）；
2. 视频/文章的首批与稳定批边界：40 块 → 10+30、20 段 → 5+15；
3. token 预算提前切批（条数未到上限也切）；
4. 单条超预算仍单独成批、不丢弃、不拆条；
5. 不产生空批、顺序保持、参数校验。
"""
from __future__ import annotations

import pytest

import translation_batching as batching


def _items(count: int, *, chars: int | None = None) -> list[dict]:
    return [
        {
            "id": index + 1,
            "text": ("x" * chars) if chars is not None else f"Sentence number {index + 1}.",
        }
        for index in range(count)
    ]


def _text(item: dict) -> str:
    return item["text"]


def _sizes(
    items: list[dict],
    first: int,
    steady: int,
    max_tokens: int,
) -> list[int]:
    return [
        len(batch)
        for batch in batching.chunk_by_budget(items, _text, first, steady, max_tokens)
    ]


def _ids(batches: list[list[dict]]) -> list[list[int]]:
    return [[item["id"] for item in batch] for batch in batches]


# ---------------------------------------------------------------------------
# 1. token 估算
# ---------------------------------------------------------------------------

def test_estimate_tokens_is_chars_over_four_with_floor_one():
    assert batching.estimate_tokens("") == 1  # 空串也按最小 1 token 计
    assert batching.estimate_tokens("a") == 1
    assert batching.estimate_tokens("abcd") == 1
    assert batching.estimate_tokens("abcde") == 2
    assert batching.estimate_tokens("x" * 4000) == 1000
    assert batching.estimate_tokens("x" * 4001) == 1001


def test_chars_per_token_is_four():
    assert batching.CHARS_PER_TOKEN == 4


# ---------------------------------------------------------------------------
# 2. 首批/稳定批边界（视频 10/40、文章 5/20）
# ---------------------------------------------------------------------------

def test_video_40_blocks_become_10_plus_30():
    items = _items(40)
    batches = batching.chunk_by_budget(
        items,
        _text,
        batching.VIDEO_FIRST_BATCH_SIZE,
        batching.VIDEO_STEADY_BATCH_SIZE,
        batching.VIDEO_MAX_SOURCE_TOKENS,
    )
    assert _sizes(items, 10, 40, 2000) == [10, 30]
    assert _ids(batches) == [list(range(1, 11)), list(range(11, 41))]


def test_article_20_paragraphs_become_5_plus_15():
    items = _items(20)
    batches = batching.chunk_by_budget(
        items,
        _text,
        batching.ARTICLE_FIRST_BATCH_SIZE,
        batching.ARTICLE_STEADY_BATCH_SIZE,
        batching.ARTICLE_MAX_SOURCE_TOKENS,
    )
    assert _sizes(items, 5, 20, 2000) == [5, 15]
    assert _ids(batches) == [list(range(1, 6)), list(range(6, 21))]


def test_steady_batch_never_exceeds_configured_size():
    assert _sizes(_items(100), 10, 40, 2000) == [10, 40, 40, 10]
    assert _sizes(_items(50), 5, 20, 2000) == [5, 20, 20, 5]


def test_short_input_fits_in_single_first_batch():
    assert _sizes(_items(3), 10, 40, 2000) == [3]
    assert _sizes(_items(5), 5, 20, 2000) == [5]


def test_empty_input_returns_no_batches():
    assert batching.chunk_by_budget([], _text, 10, 40, 2000) == []


# ---------------------------------------------------------------------------
# 3. token 预算：条数未到上限也提前切批
# ---------------------------------------------------------------------------

def test_token_budget_splits_before_count_limit():
    # 1600 字符 ≈ 400 token/条；2,000 预算 → 每批最多 5 条（远小于 10/40）。
    items = _items(12, chars=1600)
    assert _sizes(items, 10, 40, 2000) == [5, 5, 2]


def test_token_budget_equality_is_allowed():
    # 4000 字符 ≈ 1000 token/条：两条刚好 2,000，不提前切。
    items = _items(3, chars=4000)
    assert _sizes(items, 10, 40, 2000) == [2, 1]


def test_token_budget_can_force_single_item_batches():
    # 28 字符 ≈ 7 token/条，预算 10 → 每批只能放 1 条。
    items = _items(4, chars=28)
    assert _sizes(items, 10, 40, 10) == [1, 1, 1, 1]


# ---------------------------------------------------------------------------
# 4. 单条超预算：仍单独成批，不丢弃
# ---------------------------------------------------------------------------

def test_single_over_budget_item_gets_its_own_batch():
    over = {"id": 99, "text": "x" * 8004}  # ≈ 2001 token > 2,000
    items = [over, {"id": 1, "text": "small"}, {"id": 2, "text": "small"}]
    batches = batching.chunk_by_budget(items, _text, 10, 40, 2000)
    assert _ids(batches) == [[99], [1, 2]]
    assert sum(len(batch) for batch in batches) == len(items), "不得丢弃超预算条"


def test_consecutive_over_budget_items_each_get_a_batch():
    items = [
        {"id": 1, "text": "x" * 8004},
        {"id": 2, "text": "x" * 8004},
    ]
    assert _ids(batching.chunk_by_budget(items, _text, 10, 40, 2000)) == [[1], [2]]


def test_over_budget_item_does_not_swallow_following_items():
    items = [
        {"id": 1, "text": "small"},
        {"id": 2, "text": "x" * 9000},  # ≈ 2250 token，超预算
        {"id": 3, "text": "small"},
    ]
    batches = batching.chunk_by_budget(items, _text, 10, 40, 2000)
    assert _ids(batches) == [[1], [2], [3]]
    assert [len(batch) for batch in batches] == [1, 1, 1]


# ---------------------------------------------------------------------------
# 5. 顺序 / 不产生空批 / 参数校验
# ---------------------------------------------------------------------------

def test_order_is_preserved_and_no_empty_batches():
    items = _items(97, chars=200)  # 50 token/条 → 每批 ≤40 条（2,000 预算）
    batches = batching.chunk_by_budget(items, _text, 10, 40, 2000)
    flattened = [item["id"] for batch in batches for item in batch]
    assert flattened == list(range(1, 98))
    assert all(batch for batch in batches)
    assert [len(batch) for batch in batches] == [10, 40, 40, 7]


def test_empty_text_counts_as_one_token():
    items = [{"id": 1, "text": ""}, {"id": 2, "text": ""}]
    assert _ids(batching.chunk_by_budget(items, _text, 10, 40, 1)) == [[1], [2]]


@pytest.mark.parametrize(
    "first,steady,max_tokens",
    [(0, 40, 2000), (10, 0, 2000), (10, 40, 0), (-1, 40, 2000)],
)
def test_invalid_limits_raise_value_error(first, steady, max_tokens):
    with pytest.raises(ValueError):
        batching.chunk_by_budget(_items(1), _text, first, steady, max_tokens)


def test_constants_match_tuning_report():
    assert batching.VIDEO_FIRST_BATCH_SIZE == 10
    assert batching.VIDEO_STEADY_BATCH_SIZE == 40
    assert batching.VIDEO_MAX_SOURCE_TOKENS == 2000
    assert batching.ARTICLE_FIRST_BATCH_SIZE == 5
    assert batching.ARTICLE_STEADY_BATCH_SIZE == 20
    assert batching.ARTICLE_MAX_SOURCE_TOKENS == 2000
