"""标亮候选规则（specs/004 / specs/028）：**唯一一份**专名名单与大小写规则。

为什么放在后端：视频学习页、四个阅读器（文章 / 免费文章 / 公版书 / 导入书）
以及 028 教学分析的候选词，都必须用同一套「哪些词可以按 CEFR 阈值标亮」的
规则。前端不得再维护第二份专名名单或第二套大小写判断（grep 可证）；
``POST /api/vocabulary/classify`` 与 ``teaching_analysis._candidate_words_for_blocks``
都只调用本模块。

规则（纯函数、无依赖、无副作用）：

1. 内置常见专名名单（人名 / 地名 / 国家民族语言 / 机构品牌缩写）**命中即
   不标亮，与出现位置无关**；
2. 非句首的「首字母大写」token 视为专名，不标亮；
3. 其余 token 交给 CEFR 阈值判定（前端的难度标亮、028 的候选词）。

收录口径与前端旧名单一致：

- 只收「词形本身不和普通英文单词混淆」的常见专名。像 May / Mark / Bill /
  Will / Rose / Grace / Jack / Lily / Turkey / Polish / Oracle / Zoom 这类
  兼作普通词的故意不收，否则会把正常词汇一起静音（名单匹配不区分大小写）。
- 多词专名（New York / Hong Kong / Eiffel Tower）不在此处理：读取时它们是
  两个 token，按单 token 匹配，不拼合。
- 不做词形推断（不处理复数、派生词），只兼容所有格写法（Einstein's）。
- 名单只求覆盖常见项，不求完整；词级查不到的词后端本来也会返回 ``null``。

已知限制（不假装解决，改规则时请保留本段）：

- **句首专名必漏**：block 是句/段级，句首专名与句首普通词在词形上无法区分；
  句首专名只能靠上面这份名单兜底，名单外的句首专名必然漏判（会被当成普通
  词按阈值标亮）。完整句法句首判定不在本规则范围内。
- 同一词形若在文中另处小写/句首出现，非句首大写实例仍可能被判到（调用方
  只能按全词形判断）；误差方向是「多标」而不是「漏标」，可接受。
- 缩写后接普通词可能误判句首（Mr./Mrs./Dr. 等已处理，etc. 等未处理）；
  驼峰词（eBay）首字母小写，按普通词处理。
"""
from __future__ import annotations

import re
from typing import Iterator

# 常见英文专名小名单（141 条）。与已删除的旧前端专名名单完全一致；
# 迁移后前端不再保留这份名单。
PROPER_NOUNS = frozenset({
    # —— 常见英文人名 ——
    'john', 'mary', 'james', 'michael', 'william', 'david', 'thomas', 'daniel',
    'peter', 'george', 'henry', 'tom', 'alex', 'harry', 'andrew', 'brian',
    'sarah', 'emily', 'alice', 'anna', 'emma', 'lucy', 'kate', 'jane',
    'elizabeth', 'victoria',
    # —— 常见姓氏 / 名人 ——
    'einstein', 'newton', 'darwin', 'shakespeare', 'beethoven', 'mozart',
    'dickens', 'austen', 'hemingway', 'orwell', 'lincoln', 'washington',
    'gandhi', 'sherlock', 'holmes',

    # —— 常见城市 / 地区 ——
    'london', 'paris', 'berlin', 'madrid', 'rome', 'moscow', 'beijing',
    'shanghai', 'tokyo', 'seoul', 'sydney', 'toronto', 'chicago', 'boston',
    'california', 'texas', 'florida', 'york', 'oxford', 'cambridge',
    'manchester', 'edinburgh', 'amsterdam', 'vienna', 'athens', 'singapore',
    # —— 常见地标 / 自然地物 ——
    'sahara', 'thames', 'eiffel', 'hollywood', 'amazon',

    # —— 国家 / 民族 / 语言 ——
    'america', 'american', 'britain', 'british', 'england', 'english',
    'scotland', 'wales', 'ireland', 'irish', 'france', 'french', 'germany',
    'german', 'spain', 'spanish', 'italy', 'italian', 'russia', 'russian',
    'china', 'chinese', 'japan', 'japanese', 'korea', 'korean', 'india',
    'indian', 'canada', 'canadian',

    # —— 机构 / 品牌 / 技术缩写 ——
    'youtube', 'google', 'facebook', 'instagram', 'twitter', 'tiktok',
    'netflix', 'microsoft', 'samsung', 'sony', 'nike', 'wikipedia', 'openai',
    'chatgpt', 'deepseek', 'iphone', 'ipad', 'macbook', 'android', 'linux',
    'nasa', 'nato', 'fbi', 'cia', 'bbc', 'cnn', 'ceo', 'dna', 'html', 'api',
    'url', 'usb', 'pdf', 'gps', 'uk', 'usa', 'eu', 'toefl', 'ielts',
})

# 与前端 cleanReadingWord 相同的清洗：去掉首尾非字母数字（保留词内撇号）。
_EDGE_RE = re.compile(r"^[^A-Za-z0-9']+|[^A-Za-z0-9']+$")
# 名单匹配用「只留字母数字」的两端（所有格 / 引号包裹都能命中）。
_LIST_EDGE_RE = re.compile(r"^[^A-Za-z0-9]+|[^A-Za-z0-9]+$")
_HAS_LETTER_RE = re.compile(r"[A-Za-z]")

# 句末标点（后面可再跟收尾引号/括号）：其后的首个实词算「句首」。
_SENTENCE_END_RE = re.compile(r"""[.!?…。！？]["'”’)\]}]*$""")
# 不结束句子的常见缩写，避免把 Mr. Darcy / e.g. this 的后一个词误判成句首。
_NON_TERMINAL_ABBREVIATIONS = frozenset({
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs',
    'e.g', 'i.e', 'a.m', 'p.m', 'u.s', 'u.k',
})


def clean_token(token: str) -> str:
    """去掉 token 首尾的非字母数字（保留词内撇号），与前端 cleanReadingWord 一致。"""
    return _EDGE_RE.sub("", str(token or ""))


def is_listed_proper_noun(token: str) -> bool:
    """token 是否命中内置专名名单（不区分大小写、兼容所有格；与出现位置无关）。"""
    word = _LIST_EDGE_RE.sub("", str(token or "")).casefold()
    if len(word) < 2:
        return False
    if word in PROPER_NOUNS:
        return True
    # 所有格：Einstein's / NASA's → 去掉 's 再查。
    return word.endswith("'s") and word[:-2] in PROPER_NOUNS


def is_proper_token(token: str, sentence_start: bool = False) -> bool:
    """这个 token 是否按「专名」处理（专名不参与标亮；规则见模块 docstring）。

    - 名单命中 → 任何位置都是专名（含句首；这是句首专名的唯一兜底）；
    - 非句首的「首字母大写」→ 专名；
    - 句首 token 仍按普通词处理（否则句首普通词会被整片放过）——**句首专名
      必漏**：句首专名与句首普通词词形上无法区分，名单外的句首专名必然漏判。
    - 少于 2 个字符、或没有字母的 token（数字/标点）不算专名。
    """
    word = clean_token(token)
    if len(word) < 2 or not _HAS_LETTER_RE.search(word):
        return False
    if is_listed_proper_noun(word):
        return True
    if sentence_start:
        return False
    return "A" <= word[0] <= "Z"


def _ends_sentence(raw_token: str) -> bool:
    """raw token 是否结束句子（句末缩写不结束句子）。"""
    if not _SENTENCE_END_RE.search(raw_token):
        return False
    return clean_token(raw_token).casefold() not in _NON_TERMINAL_ABBREVIATIONS


def iter_words(text: str) -> Iterator[tuple[str, bool]]:
    """按空白切 token，逐条产出 ``(清洗后的词, 是否句首)``。

    与前端 collectReadingTokens 同一套句首口径：每个换行（调用方的句/段
    block）算句首；行内第一个实词、以及句末标点后的第一个实词算句首；
    ``Mr.`` 等常见缩写不结束句子。只产出去掉首尾标点后「至少 2 字符且含
    字母」的 token；纯数字 / 标点 token 不产出，但会更新句首状态。

    028 的候选词与前端 ``/api/vocabulary/classify`` 共用这里的 token 与
    句首判定，避免两边各写一套后慢慢分叉。
    """
    for line in str(text or "").split("\n"):
        sentence_start = True
        for raw in line.split():
            token = clean_token(raw)
            is_word = len(token) >= 2 and _HAS_LETTER_RE.search(token) is not None
            if is_word:
                yield token, sentence_start
                sentence_start = False
            if _ends_sentence(raw):
                sentence_start = True
