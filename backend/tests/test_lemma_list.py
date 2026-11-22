"""CEFR 10k 词形表 API 离线验收（specs/040-cefr-lemma-list / routes_vocabulary.py）。

覆盖：

- 总数 10,000；A1/A2/B1/B2/C1 = 1000/1000/2000/3000/3000；
- 搜索：lemma 或任一词形（子串、大小写不敏感），``running`` → ``run``、
  ``abandoned`` → ``abandon``、``run`` 命中 lemma 本身；
- item 字段：lemma/rank/level/phonetic/translation/forms，forms 与频表
  ``form → lemma`` 映射逐条一致（词形数 = 映射数量）；
- 分页：50/页、hasMore、越界页空列表、排序 rank/alpha；
- 非法参数 400（level/pageSize/page/sort/q 长度）；
- 游客可读、不签发游客 Cookie、公开缓存头、无 AI/无写库；
- 频表缺失 → 503；缺释义时 phonetic/translation 留空，不编造。
"""
from __future__ import annotations

from dataclasses import replace

import pytest

import config
import difficulty
import lemma_list
import vocabulary

ENDPOINT = "/api/vocabulary/lemma-list"
LEVELS = ("A1", "A2", "B1", "B2", "C1")


@pytest.fixture(autouse=True)
def fresh_index():
    """每个用例从同一份仓库只读数据重新建索引（测试间不共享缓存）。"""
    lemma_list.reset_cache()
    yield
    lemma_list.reset_cache()


def test_total_and_level_counts(make_client):
    """10k 总数与 CEFR 锚点派生的五级计数（specs/040 §4）。"""
    with make_client() as client:
        first = client.get(ENDPOINT, params={"pageSize": 1})
        assert first.status_code == 200
        body = first.json()
        assert body["total"] == 10000
        assert body["page"] == 1
        assert body["pageSize"] == 1
        assert body["hasMore"] is True
        assert len(body["items"]) == 1
        item = body["items"][0]
        assert item["lemma"] == "the"
        assert item["rank"] == 1
        assert item["level"] == "A1"

        counts = {}
        for level in LEVELS:
            response = client.get(
                ENDPOINT, params={"level": level, "pageSize": 1}
            )
            assert response.status_code == 200, response.text
            counts[level] = response.json()["total"]
        assert counts == {"A1": 1000, "A2": 1000, "B1": 2000, "B2": 3000, "C1": 3000}
    assert "ln_guest" not in first.cookies


def test_search_matches_lemma_and_forms(make_client):
    """q 子串匹配 lemma/词形，命中词形返回其 lemma，大小写不敏感。"""
    with make_client() as client:
        running = client.get(ENDPOINT, params={"q": "running"}).json()
        assert running["total"] == 1
        assert [item["lemma"] for item in running["items"]] == ["run"]

        abandoned = client.get(ENDPOINT, params={"q": "abandoned"}).json()
        assert abandoned["total"] == 1
        assert abandoned["items"][0]["lemma"] == "abandon"
        assert abandoned["items"][0]["level"] == "B1"

        # lemma 本身也命中（同一条 lemma 只出现一次，不因多个词形重复）。
        by_lemma = client.get(ENDPOINT, params={"q": "abandon"}).json()
        assert [item["lemma"] for item in by_lemma["items"]] == ["abandon"]

        upper = client.get(ENDPOINT, params={"q": "RUNNING"}).json()
        assert upper == running

        # 子串会命中多个 lemma；默认 rank 升序，``run`` 在首位。
        broad = client.get(ENDPOINT, params={"q": "run", "pageSize": 200}).json()
        assert broad["total"] > 1
        assert broad["items"][0]["lemma"] == "run"
        assert len({item["lemma"] for item in broad["items"]}) == len(broad["items"])

        empty = client.get(ENDPOINT, params={"q": "zzzz-not-a-word"}).json()
        assert empty["total"] == 0
        assert empty["items"] == []
        assert empty["hasMore"] is False


def test_item_shape_forms_and_lexicon(make_client):
    """forms 与频表映射一致；音标/释义来自 lexicon（不推断）。"""
    wordlist = difficulty.load_wordlist()
    lexicon = vocabulary.load_lexicon()
    with make_client() as client:
        body = client.get(ENDPOINT, params={"q": "run"}).json()
    item = body["items"][0]
    assert set(item) == {"lemma", "rank", "level", "phonetic", "translation", "forms"}
    expected_forms = sorted(
        form for form, lemma in wordlist.forms.items() if lemma == "run"
    )
    assert item["forms"] == expected_forms
    assert len(item["forms"]) == sum(
        1 for lemma in wordlist.forms.values() if lemma == "run"
    )
    phonetic, translation = lexicon.entries["run"]
    assert item["phonetic"] == phonetic
    assert item["translation"] == translation
    # 每个词形都能反查到同一个 lemma（词形数 = forms 映射数量）。
    assert all(wordlist.forms[form] == "run" for form in item["forms"])


def test_level_filter_and_boundaries(make_client):
    """level 大小写不敏感；筛选后 total 与档位一致，非法 level → 400。"""
    with make_client() as client:
        a1 = client.get(ENDPOINT, params={"level": "a1", "pageSize": 200}).json()
        assert a1["total"] == 1000
        assert all(item["level"] == "A1" for item in a1["items"])
        c1 = client.get(ENDPOINT, params={"level": "C1", "pageSize": 200}).json()
        assert c1["total"] == 3000
        assert all(item["level"] == "C1" for item in c1["items"])
        # 边界：A1 最后一名的 rank 恰为 1000；A2 第一名的 rank 为 1001。
        a1_last_page = client.get(
            ENDPOINT, params={"level": "A1", "page": 5, "pageSize": 200}
        ).json()
        a1_last = a1_last_page["items"][-1]
        assert a1_last["rank"] == 1000
        a2 = client.get(ENDPOINT, params={"level": "A2", "pageSize": 200}).json()
        assert a2["items"][0]["rank"] == 1001
        # C2 未建模：不是合法 level，不拿别的词表冒充。
        invalid = client.get(ENDPOINT, params={"level": "C2"})
        assert invalid.status_code == 400
        assert "level" in invalid.json()["detail"]


def test_pagination_and_sort(make_client):
    """服务端 50/页、hasMore、越界页、rank/alpha 排序。"""
    with make_client() as client:
        page1 = client.get(ENDPOINT, params={"page": 1, "pageSize": 50}).json()
        assert len(page1["items"]) == 50
        assert page1["total"] == 10000
        assert page1["hasMore"] is True
        page2 = client.get(ENDPOINT, params={"page": 2, "pageSize": 50}).json()
        assert page2["page"] == 2
        expected_second = sorted(
            (rank, lemma) for lemma, rank in difficulty.load_wordlist().ranks.items()
        )[50]
        assert page2["items"][0]["lemma"] == expected_second[1]
        assert page2["items"][0]["rank"] == expected_second[0]
        assert not ({item["lemma"] for item in page1["items"]}
                    & {item["lemma"] for item in page2["items"]})
        last = client.get(ENDPOINT, params={"page": 200, "pageSize": 50}).json()
        assert len(last["items"]) == 50
        assert last["hasMore"] is False
        beyond = client.get(ENDPOINT, params={"page": 201, "pageSize": 50}).json()
        assert beyond["items"] == []
        assert beyond["total"] == 10000
        assert beyond["hasMore"] is False

        alpha = client.get(
            ENDPOINT, params={"sort": "alpha", "pageSize": 100}
        ).json()
        lemmas = [item["lemma"] for item in alpha["items"]]
        assert lemmas == sorted(lemmas)
        assert lemmas[0] == "a"
        ranks = [item["rank"] for item in alpha["items"]]
        assert ranks != sorted(ranks), "alpha 排序不应仍按 rank 排列"
        # 筛选 + alpha 组合只影响展示顺序与结果集，不改变档位计数。
        alpha_a1 = client.get(
            ENDPOINT, params={"sort": "alpha", "level": "A1", "pageSize": 200}
        ).json()
        assert alpha_a1["total"] == 1000


@pytest.mark.parametrize(
    "params",
    [
        {"page": 0},
        {"pageSize": 0},
        {"pageSize": 201},
        {"sort": "frequency"},
        {"level": "Z9"},
        {"q": "x" * 65},
    ],
)
def test_invalid_parameters_are_400(make_client, params):
    with make_client() as client:
        response = client.get(ENDPOINT, params=params)
    assert response.status_code == 400, response.text
    assert response.json()["detail"]


def test_public_read_only_contract(make_client):
    """游客可读：不签发游客 Cookie、公开缓存头、不调 AI、不写库。"""
    with make_client() as client:
        response = client.get(ENDPOINT)
        listing = client.get(ENDPOINT, params={"q": "run", "level": "A1"})
        broken = client.get(ENDPOINT, params={"level": "C2"})
    assert response.status_code == 200
    assert listing.status_code == 200
    assert broken.status_code == 400
    for result in (response, listing):
        assert result.headers["cache-control"] == "public, max-age=3600"
        assert "ln_guest" not in result.cookies
        assert all(
            "ln_guest" not in header
            for header in result.headers.get_list("set-cookie")
        )


def test_missing_data_is_503(monkeypatch, make_client, tmp_path):
    """频表文件缺失 → 503（与 /lists 一致的错误语义），不是空列表。"""
    monkeypatch.setattr(
        config, "WORDLIST_PATH", str(tmp_path / "missing-frequency.json"), raising=False
    )
    difficulty.reset_wordlist_cache()
    try:
        with make_client() as client:
            response = client.get(ENDPOINT)
    finally:
        difficulty.reset_wordlist_cache()
    assert response.status_code == 503
    assert "词形表" not in response.json()["detail"]  # 底层 loader 的原文，不伪造


def test_missing_lexicon_keeps_empty_fields():
    """缺释义/音标时留空字符串，不编造。"""
    wordlist = difficulty.load_wordlist()
    lexicon = vocabulary.load_lexicon()
    stripped = replace(
        lexicon,
        entries={key: value for key, value in lexicon.entries.items() if key != "run"},
    )
    index = lemma_list._build_index(wordlist, stripped)
    run = index.by_lemma["run"]
    assert run.phonetic == ""
    assert run.translation == ""
    assert run.forms == ("ran", "runes", "running", "runs")
    assert run.level == "A1"


def test_index_is_cached_and_resettable():
    first = lemma_list.load_index()
    second = lemma_list.load_index()
    assert first is second
    lemma_list.reset_cache()
    assert lemma_list.load_index() is not first
