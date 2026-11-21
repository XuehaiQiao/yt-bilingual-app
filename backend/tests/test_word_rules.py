"""标亮候选规则（word_rules.py）离线单元测试（specs/004 / specs/028）。

覆盖：专名名单（名单命中任何位置）、非句首首字母大写、句首普通词、
小写词、空/纯数字/标点 token、所有格、句首判定（句末标点 / 不结束句子的
缩写 / 换行）。

这些向量是「前端 classify 与 028 候选同源」的共同锚点：同一 token +
sentence_start 在 ``is_proper_token`` 上的结果，就是两个消费方的过滤结果。
"""
from __future__ import annotations

import pytest

import word_rules


# ---------------------------------------------------------------------------
# 专名
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("token", ["Georgie", "Gridley", "Georgie's"])
def test_non_sentence_initial_capital_is_proper(token):
    """非句首首字母大写 → 专名（用户实测里的两个人名）。"""
    assert word_rules.is_proper_token(token, sentence_start=False) is True


def test_sentence_initial_capital_is_not_proper():
    """句首大小写不放行专名判断：The / This 是普通词，仍按阈值判。"""
    assert word_rules.is_proper_token("The", sentence_start=True) is False
    assert word_rules.is_proper_token("This", sentence_start=True) is False


@pytest.mark.parametrize("sentence_start", [False, True])
def test_listed_proper_noun_matches_at_any_position(sentence_start):
    """名单命中任何位置（含句首）都算专名——句首专名的唯一兜底。"""
    assert word_rules.is_proper_token("London", sentence_start=sentence_start) is True


def test_listed_proper_noun_is_case_insensitive_and_handles_possessive():
    assert word_rules.is_proper_token("london", sentence_start=False) is True
    assert word_rules.is_proper_token("EINSTEIN", sentence_start=True) is True
    assert word_rules.is_proper_token("Einstein's", sentence_start=False) is True


def test_lowercase_ordinary_word_is_not_proper():
    assert word_rules.is_proper_token("museum", sentence_start=False) is False
    assert word_rules.is_proper_token("the", sentence_start=False) is False


def test_empty_and_numeric_tokens_are_not_proper():
    assert word_rules.is_proper_token("", sentence_start=False) is False
    assert word_rules.is_proper_token("123", sentence_start=False) is False
    assert word_rules.is_proper_token("...", sentence_start=True) is False
    assert word_rules.is_proper_token("A", sentence_start=False) is False


def test_cleans_surrounding_punctuation_before_classifying():
    assert word_rules.is_proper_token('"Georgie,"', sentence_start=False) is True
    assert word_rules.is_proper_token("(London)", sentence_start=True) is True


# ---------------------------------------------------------------------------
# Token 化 + 句首判定
# ---------------------------------------------------------------------------

def test_iter_words_tracks_sentence_starts():
    words = list(word_rules.iter_words(
        "Georgie met Gridley near the river. The town was quiet."
    ))
    assert words[0] == ("Georgie", True)
    assert ("Gridley", False) in words
    # 句末标点后的 The 算句首 → 它不是专名，仍可参与阈值判定。
    assert ("The", True) in words


def test_iter_words_does_not_end_sentence_on_common_abbreviations():
    words = list(word_rules.iter_words("Mr. Smith came late."))
    assert ("Mr", True) in words
    # Mr. 不结束句子，Smith 仍是「非句首」，所以按大写规则算专名。
    assert ("Smith", False) in words
    assert word_rules.is_proper_token("Smith", sentence_start=False) is True


def test_iter_words_resets_sentence_start_each_line():
    """每个换行（block 边界）算句首——与前端 collectReadingTokens 口径一致。"""
    words = list(word_rules.iter_words("early first line\nsecond line"))
    assert ("first", False) in words
    assert ("second", True) in words


def test_iter_words_skips_numbers_and_punctuation_but_keeps_sentence_state():
    words = list(word_rules.iter_words("... The 123 end."))
    # 纯标点/数字不产出；句末标点仍然结束句子。
    assert [word for word, _ in words] == ["The", "end"]
    assert words[0] == ("The", True)
    assert words[1] == ("end", False)
