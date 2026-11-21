"""单词本词表/等级 API 离线验收（routes_vocabulary.py / vocabulary.py）。

覆盖：公开只读、目录 10 项（合并 cefr + 6 个兼容 CEFR 单级 + GRE/CET4/CET6）、
合并 CEFR 的分页/搜索/等级筛选、C2 unavailable、分页/搜索/前缀优先、
等级映射/C1+/非法 token、大小限制、404/503/400、缓存头、合并列表缓存、
``POST /classify`` 契约（等级 + 专名 + sentenceStart + 200 上限 + 游客可用）、
公开端点不签发游客 Cookie。
"""
from __future__ import annotations

import json
import shutil
from types import SimpleNamespace

import pytest

import config
import difficulty
import vocabulary
import word_rules
from tests.vocab_fixtures import (
    build_phrases,
    copy_frequency,
    load_builder,
    write_tiny_ecdict,
)

builder = load_builder()
LIST_IDS = [
    "phrases",
    "cefr",
    "cefr-a1",
    "cefr-a2",
    "cefr-b1",
    "cefr-b2",
    "cefr-c1",
    "cefr-c2",
    "gre",
    "cet4",
    "cet6",
]


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    """用迷你 ECDICT CSV + 真实频表副本构建一套 API 测试数据（模块级只建一次）。"""
    root = tmp_path_factory.mktemp("vocab-api")
    frequency = copy_frequency(root / "frequency_bands.v1.json")
    csv_path = write_tiny_ecdict(root / "ecdict.csv")
    out_dir = root / "wordlists"
    code = builder.main(
        [
            "--ecdict-csv",
            str(csv_path),
            "--frequency",
            str(frequency),
            "--out-dir",
            str(out_dir),
            "--allow-small",
        ]
    )
    assert code == 0
    report = root / "phrases-report.json"
    assert build_phrases(out_dir, csv_path, frequency, report) == 0
    return SimpleNamespace(
        root=root, frequency=frequency, csv=csv_path, out=out_dir, report=report
    )


@pytest.fixture(autouse=True)
def _reset_vocabulary_caches():
    difficulty.reset_wordlist_cache()
    vocabulary.reset_cache()
    yield
    difficulty.reset_wordlist_cache()
    vocabulary.reset_cache()


@pytest.fixture()
def vocab_env(built, monkeypatch):
    monkeypatch.setattr(config, "WORDLIST_PATH", str(built.frequency), raising=False)
    monkeypatch.setattr(config, "VOCABULARY_DIR", str(built.out), raising=False)
    return built


# ---------------------------------------------------------------------------
# 词表目录
# ---------------------------------------------------------------------------

def test_lists_catalog_has_merged_cefr_plus_legacy_lists(vocab_env, make_client):
    with make_client() as client:
        response = client.get("/api/vocabulary/lists")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "public, max-age=3600"
    catalog = response.json()
    assert [item["id"] for item in catalog] == LIST_IDS
    by_id = {item["id"]: item for item in catalog}

    phrases = by_id["phrases"]
    assert phrases["label"] == "短语"
    assert phrases["count"] == 570
    assert phrases["available"] is True
    assert phrases["approximate"] is True
    assert phrases["notice"] == "content/wordlists/PHRASES-NOTICE.md"
    assert phrases["note"] == "A2–C1 近似，非官方 CEFR 短语表"
    assert phrases["source"].startswith("LinguaTrek")

    merged = by_id["cefr"]
    assert merged["label"] == "CEFR 词表"
    assert merged["count"] == 10_000
    assert merged["byLevel"] == {
        "A1": 1_000,
        "A2": 1_000,
        "B1": 2_000,
        "B2": 3_000,
        "C1": 3_000,
    }
    assert merged["available"] is True
    assert merged["approximate"] is True
    assert merged["license"] == "CC-BY-SA-4.0"
    assert merged["notice"] == "content/wordlist/NOTICE.md"
    assert merged["source"].startswith("wordfreq")
    assert merged["version"]
    assert "C2" in merged["note"] and "未建模" in merged["note"]
    assert set(merged) == {
        "id",
        "label",
        "count",
        "byLevel",
        "source",
        "license",
        "notice",
        "approximate",
        "available",
        "version",
        "note",
    }

    for level, count in (
        ("cefr-a1", 1_000),
        ("cefr-a2", 1_000),
        ("cefr-b1", 2_000),
        ("cefr-b2", 3_000),
        ("cefr-c1", 3_000),
    ):
        item = by_id[level]
        assert item["count"] == count
        assert item["available"] is True
        assert item["approximate"] is True
        assert item["license"] == "CC-BY-SA-4.0"
        assert item["notice"] == "content/wordlist/NOTICE.md"
        assert item["source"].startswith("wordfreq")
        assert item["note"]

    c2 = by_id["cefr-c2"]
    assert c2["count"] == 0
    assert c2["available"] is False
    assert c2["source"] is None
    assert c2["license"] is None
    assert "未建模" in c2["note"]
    assert "GRE" in c2["note"]

    assert by_id["gre"]["count"] == 4
    assert by_id["cet4"]["count"] == 4
    assert by_id["cet6"]["count"] == 2
    for list_id in ("gre", "cet4", "cet6"):
        item = by_id[list_id]
        assert item["approximate"] is False
        assert item["available"] is True
        assert item["source"] == f"ECDICT tag={list_id}"
        assert "MIT" in item["license"]
        assert item["notice"] == "content/wordlists/NOTICE.md"
        assert item["version"]


def test_lists_public_endpoint_does_not_issue_guest_cookie(make_client):
    with make_client() as client:
        response = client.get("/api/vocabulary/lists")
        detail = client.get("/api/vocabulary/lists/cefr-a1", params={"pageSize": 1})
        phrases = client.get("/api/vocabulary/phrases", params={"pageSize": 1})
    assert response.status_code == 200
    assert detail.status_code == 200
    assert phrases.status_code == 200
    for result in (response, detail, phrases):
        assert "ln_guest" not in result.cookies
        assert all(
            "ln_guest" not in header
            for header in result.headers.get_list("set-cookie")
        )
    assert detail.headers["cache-control"] == "public, max-age=3600"


# ---------------------------------------------------------------------------
# 分页与搜索
# ---------------------------------------------------------------------------

def test_cefr_a1_pagination(vocab_env, make_client):
    with make_client() as client:
        first = client.get(
            "/api/vocabulary/lists/cefr-a1", params={"page": 1, "pageSize": 2}
        )
        second = client.get(
            "/api/vocabulary/lists/cefr-a1", params={"page": 2, "pageSize": 2}
        )
        beyond = client.get(
            "/api/vocabulary/lists/cefr-a1", params={"page": 501, "pageSize": 2}
        )
        max_page = client.get(
            "/api/vocabulary/lists/cefr-a1", params={"page": 1, "pageSize": 200}
        )
    assert first.status_code == 200
    payload = first.json()
    assert payload["total"] == 1_000
    assert payload["page"] == 1
    assert payload["pageSize"] == 2
    assert payload["hasMore"] is True
    assert len(payload["items"]) == 2
    assert payload["items"][0]["word"] == "the"
    assert payload["items"][0]["cefrLevel"] == "A1"
    assert set(payload["items"][0]) == {
        "word",
        "phonetic",
        "translation",
        "cefrLevel",
    }
    second_payload = second.json()
    assert second_payload["page"] == 2
    assert second_payload["items"] != payload["items"]
    assert second_payload["hasMore"] is True
    beyond_payload = beyond.json()
    assert beyond_payload["items"] == []
    assert beyond_payload["total"] == 1_000
    assert beyond_payload["hasMore"] is False
    assert len(max_page.json()["items"]) == 200


def test_merged_cefr_pagination(vocab_env, make_client):
    with make_client() as client:
        first = client.get(
            "/api/vocabulary/lists/cefr", params={"page": 1, "pageSize": 3}
        )
        second = client.get(
            "/api/vocabulary/lists/cefr", params={"page": 2, "pageSize": 3}
        )
        last = client.get(
            "/api/vocabulary/lists/cefr", params={"page": 5_000, "pageSize": 2}
        )
        beyond = client.get(
            "/api/vocabulary/lists/cefr", params={"page": 5_001, "pageSize": 2}
        )
        max_page = client.get(
            "/api/vocabulary/lists/cefr", params={"page": 1, "pageSize": 200}
        )
    assert first.status_code == 200, first.text
    payload = first.json()
    assert payload["total"] == 10_000
    assert payload["page"] == 1
    assert payload["pageSize"] == 3
    assert payload["hasMore"] is True
    assert payload["items"][0]["word"] == "the"
    assert payload["items"][0]["cefrLevel"] == "A1"
    assert set(payload["items"][0]) == {
        "word",
        "phonetic",
        "translation",
        "cefrLevel",
    }
    # A1→C1 连续频带：按频秩排序等价于按等级顺序。
    assert [item["cefrLevel"] for item in payload["items"]] == ["A1", "A1", "A1"]
    second_payload = second.json()
    assert second_payload["page"] == 2
    assert second_payload["hasMore"] is True
    assert second_payload["items"] != payload["items"]
    last_payload = last.json()
    assert last_payload["hasMore"] is False
    assert len(last_payload["items"]) == 2
    assert all(item["cefrLevel"] == "C1" for item in last_payload["items"])
    beyond_payload = beyond.json()
    assert beyond_payload["items"] == []
    assert beyond_payload["total"] == 10_000
    assert beyond_payload["hasMore"] is False
    assert len(max_page.json()["items"]) == 200


def test_merged_cefr_level_filter(vocab_env, make_client):
    with make_client() as client:
        a1 = client.get(
            "/api/vocabulary/lists/cefr",
            params={"level": "A1", "pageSize": 200},
        ).json()
        b2 = client.get(
            "/api/vocabulary/lists/cefr",
            params={"level": "b2", "pageSize": 200},
        ).json()
        c1 = client.get(
            "/api/vocabulary/lists/cefr",
            params={"level": "C1", "pageSize": 200},
        ).json()
        blank = client.get(
            "/api/vocabulary/lists/cefr", params={"level": "", "pageSize": 1}
        ).json()
        combined = client.get(
            "/api/vocabulary/lists/cefr",
            params={"level": "B1", "q": "abandon"},
        ).json()
        combined_miss = client.get(
            "/api/vocabulary/lists/cefr",
            params={"level": "A1", "q": "abandon"},
        ).json()
    assert a1["total"] == 1_000
    assert b2["total"] == 3_000
    assert c1["total"] == 3_000
    assert all(item["cefrLevel"] == "A1" for item in a1["items"])
    assert all(item["cefrLevel"] == "B2" for item in b2["items"])
    assert all(item["cefrLevel"] == "C1" for item in c1["items"])
    assert a1["items"][0]["word"] == "the"
    assert blank["total"] == 10_000
    assert combined["total"] == 1
    assert combined["items"][0]["word"] == "abandon"
    assert combined["items"][0]["cefrLevel"] == "B1"
    assert combined_miss["total"] == 0
    assert combined_miss["items"] == []


def test_merged_cefr_level_filter_validation(vocab_env, make_client):
    with make_client() as client:
        for bad in ("C2", "B3", "C1+", "all"):
            response = client.get(
                "/api/vocabulary/lists/cefr", params={"level": bad}
            )
            assert response.status_code == 400, bad
            assert "level" in response.json()["detail"]
        legacy_bad = client.get(
            "/api/vocabulary/lists/cefr-a1", params={"level": "C2"}
        )
    assert legacy_bad.status_code == 400


def test_merged_cefr_search_across_levels(vocab_env, make_client):
    with make_client() as client:
        abandon = client.get(
            "/api/vocabulary/lists/cefr", params={"q": "aband"}
        ).json()
        africa = client.get(
            "/api/vocabulary/lists/cefr", params={"q": "afr"}
        ).json()
        no_match = client.get(
            "/api/vocabulary/lists/cefr", params={"q": "zzzz"}
        ).json()
    assert abandon["total"] == 1
    assert abandon["items"][0]["word"] == "abandon"
    assert abandon["items"][0]["cefrLevel"] == "B1"
    assert abandon["items"][0]["translation"] == "vt. 放弃, 抛弃"
    # 搜索跨等级：A2 词也能在合并表里被搜到。
    assert [item["word"] for item in africa["items"]] == [
        "africa",
        "african",
        "afraid",
    ]
    assert [item["cefrLevel"] for item in africa["items"]] == ["A2", "A2", "A2"]
    assert no_match == {
        "items": [],
        "total": 0,
        "page": 1,
        "pageSize": 50,
        "hasMore": False,
    }


def test_merged_cefr_items_are_cached(vocab_env, monkeypatch, make_client):
    calls = {"count": 0}
    original = vocabulary._build_cefr_merged_items

    def counting(*args, **kwargs):
        calls["count"] += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(vocabulary, "_build_cefr_merged_items", counting)
    with make_client() as client:
        first = client.get(
            "/api/vocabulary/lists/cefr", params={"pageSize": 1}
        )
        second = client.get(
            "/api/vocabulary/lists/cefr",
            params={"pageSize": 1, "level": "C1"},
        )
    assert first.status_code == 200
    assert second.status_code == 200
    assert calls["count"] == 1


def test_legacy_cefr_level_lists_remain_compatible(vocab_env, make_client):
    with make_client() as client:
        catalog = client.get("/api/vocabulary/lists").json()
        ids = [item["id"] for item in catalog]
        a1 = client.get(
            "/api/vocabulary/lists/cefr-a1", params={"pageSize": 2}
        )
        c1 = client.get(
            "/api/vocabulary/lists/cefr-c1", params={"pageSize": 200}
        )
    for level in ("cefr-a1", "cefr-a2", "cefr-b1", "cefr-b2", "cefr-c1"):
        assert level in ids
    assert a1.status_code == 200
    assert a1.json()["total"] == 1_000
    assert a1.json()["items"][0]["word"] == "the"
    assert c1.status_code == 200
    assert c1.json()["total"] == 3_000
    assert all(item["cefrLevel"] == "C1" for item in c1.json()["items"])


def test_search_is_case_insensitive_and_prefix_first(vocab_env, make_client):
    with make_client() as client:
        b1 = client.get(
            "/api/vocabulary/lists/cefr-b1", params={"q": "aband"}
        ).json()
        gre = client.get(
            "/api/vocabulary/lists/gre", params={"q": "AB"}
        ).json()
        contains = client.get(
            "/api/vocabulary/lists/gre", params={"q": "wert"}
        ).json()
        cet4 = client.get(
            "/api/vocabulary/lists/cet4", params={"q": "afr"}
        ).json()
        no_match = client.get(
            "/api/vocabulary/lists/gre", params={"q": "zzzz"}
        ).json()
    assert b1["total"] == 1
    assert b1["items"][0]["word"] == "abandon"
    assert b1["items"][0]["cefrLevel"] == "B1"
    assert b1["items"][0]["phonetic"] == "ә'bændәn"
    assert b1["items"][0]["translation"] == "vt. 放弃, 抛弃"
    assert b1["hasMore"] is False

    assert gre["total"] == 2
    assert [item["word"] for item in gre["items"]] == ["abandon", "abate"]
    assert all(item["word"].casefold().startswith("ab") for item in gre["items"])

    assert contains["total"] == 1
    assert contains["items"][0]["word"] == "qwerty"

    assert cet4["total"] == 1
    assert cet4["items"][0]["word"] == "Africa"
    assert cet4["items"][0]["cefrLevel"] == "A2"

    assert no_match == {
        "items": [],
        "total": 0,
        "page": 1,
        "pageSize": 50,
        "hasMore": False,
    }


def test_exam_items_include_details_and_cefr_level(vocab_env, make_client):
    with make_client() as client:
        gre = client.get(
            "/api/vocabulary/lists/gre", params={"pageSize": 10}
        ).json()
        cet4 = client.get(
            "/api/vocabulary/lists/cet4", params={"pageSize": 10}
        ).json()
    assert gre["total"] == 4
    assert [item["word"] for item in gre["items"]] == [
        "abandon",
        "running",
        "qwerty",
        "abate",
    ]
    by_word = {item["word"]: item for item in gre["items"]}
    assert by_word["abandon"]["cefrLevel"] == "B1"
    assert by_word["running"]["cefrLevel"] == "A1"  # forms 折回 run
    assert by_word["qwerty"]["cefrLevel"] is None
    assert by_word["qwerty"]["phonetic"] == ""
    assert by_word["qwerty"]["translation"] == "n. 键盘布局"
    assert by_word["abate"]["translation"] == "vt. 减弱, 减轻"
    assert [item["word"] for item in cet4["items"]] == [
        "ability",
        "abandon",
        "Africa",
        "zebra",
    ]


def test_pagination_and_query_limits(vocab_env, make_client):
    with make_client() as client:
        assert (
            client.get(
                "/api/vocabulary/lists/cefr-a1", params={"pageSize": 201}
            ).status_code
            == 422
        )
        assert (
            client.get(
                "/api/vocabulary/lists/cefr-a1", params={"page": 0}
            ).status_code
            == 422
        )
        assert (
            client.get(
                "/api/vocabulary/lists/cefr-a1", params={"pageSize": 0}
            ).status_code
            == 422
        )
        too_long = client.get(
            "/api/vocabulary/lists/cefr-a1", params={"q": "x" * 65}
        )
        assert too_long.status_code == 400
        assert "64" in too_long.json()["detail"]


def test_unknown_list_and_c2_return_404(vocab_env, make_client):
    with make_client() as client:
        unknown = client.get("/api/vocabulary/lists/not-a-list")
        c2 = client.get("/api/vocabulary/lists/cefr-c2")
        phrases_as_word_list = client.get("/api/vocabulary/lists/phrases")
    assert unknown.status_code == 404
    assert c2.status_code == 404
    assert "C2" in c2.json()["detail"]
    assert phrases_as_word_list.status_code == 404
    assert "/api/vocabulary/phrases" in phrases_as_word_list.json()["detail"]


# ---------------------------------------------------------------------------
# 等级映射
# ---------------------------------------------------------------------------

def test_level_mapping_and_c1_plus(vocab_env, make_client):
    with make_client() as client:
        response = client.get(
            "/api/vocabulary/level",
            params={"words": "abandon,running,ubiquitous,qwerty!,ability,the"},
        )
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "public, max-age=3600"
    payload = response.json()
    assert payload == {
        "abandon": "B1",
        "running": "A1",
        "ubiquitous": "C1+",
        "qwerty!": None,
        "ability": "A1",
        "the": "A1",
    }


def test_level_preserves_case_and_supports_repeated_words(vocab_env, make_client):
    with make_client() as client:
        response = client.get(
            "/api/vocabulary/level",
            params=[("words", "Abandon"), ("words", "Running")],
        )
    assert response.status_code == 200
    assert response.json() == {"Abandon": "B1", "Running": "A1"}


def test_level_invalid_tokens_are_null_and_valid_unknowns_are_c1_plus(
    vocab_env, make_client
):
    with make_client() as client:
        response = client.get(
            "/api/vocabulary/level",
            params={
                "words": "123,!!!," + "x" * 65 + ",zzzunknownword"
            },
        )
    assert response.status_code == 200
    payload = response.json()
    assert payload["123"] is None
    assert payload["!!!"] is None
    assert payload["x" * 65] is None
    assert payload["zzzunknownword"] == "C1+"


def test_level_does_not_split_hyphen_compounds(vocab_env, make_client):
    with make_client() as client:
        response = client.get(
            "/api/vocabulary/level",
            params={"words": "state-of-the-art,never-in-frequency,well-known"},
        )
    assert response.status_code == 200
    assert response.json() == {
        "state-of-the-art": "C1+",
        "never-in-frequency": "C1+",
        "well-known": "C1+",
    }


def test_level_word_count_limits(vocab_env, make_client):
    words = ",".join(["the"] * 100)
    too_many = ",".join(["the"] * 101)
    with make_client() as client:
        ok = client.get("/api/vocabulary/level", params={"words": words})
        over = client.get("/api/vocabulary/level", params={"words": too_many})
        empty = client.get("/api/vocabulary/level", params={"words": ""})
        missing = client.get("/api/vocabulary/level")
    assert ok.status_code == 200
    assert ok.json() == {"the": "A1"}
    assert over.status_code == 400
    assert "100" in over.json()["detail"]
    assert empty.status_code == 400
    assert missing.status_code == 400


# ---------------------------------------------------------------------------
# 标亮判定 POST /api/vocabulary/classify（specs/004 / 028）
# ---------------------------------------------------------------------------

def test_classify_returns_levels_and_proper_flags(vocab_env, make_client):
    items = [
        {"text": "abandon"},
        {"text": "the"},
        # 非句首 Georgie：名单外 + 首字母大写 → 专名
        {"text": "Georgie", "sentenceStart": False},
        # 同名在句首：不能按大写判专名（名单外），仍返回等级
        {"text": "Georgie", "sentenceStart": True},
        # 名单命中任何位置（含句首）都是专名
        {"text": "London", "sentenceStart": False},
        {"text": "London", "sentenceStart": True},
        # 句首普通词不是专名
        {"text": "The", "sentenceStart": True},
        # 非法 token：level=null，不报错
        {"text": "qwerty!"},
        {"text": "123"},
    ]
    with make_client() as client:
        response = client.post("/api/vocabulary/classify", json={"items": items})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "public, max-age=3600"
    payload = response.json()
    assert [item["text"] for item in payload["items"]] == [
        item["text"] for item in items
    ]
    assert len(payload["items"]) == len(items)

    by_index = payload["items"]
    assert by_index[0] == {"text": "abandon", "level": "B1", "proper": False}
    assert by_index[1] == {"text": "the", "level": "A1", "proper": False}
    assert by_index[2]["proper"] is True
    assert by_index[3]["proper"] is False
    assert isinstance(by_index[3]["level"], str)  # 句首也照常查等级
    assert by_index[4]["proper"] is True
    assert by_index[5]["proper"] is True
    assert by_index[6] == {"text": "The", "level": "A1", "proper": False}
    assert by_index[7]["level"] is None
    assert by_index[7]["proper"] is False
    assert by_index[8]["level"] is None
    assert by_index[8]["proper"] is False


def test_classify_keeps_duplicate_texts_and_rejects_bad_shape(vocab_env, make_client):
    """同一 text 可在不同 sentenceStart 下出现两次；坏请求体 422。"""
    with make_client() as client:
        duplicated = client.post("/api/vocabulary/classify", json={"items": [
            {"text": "Georgie", "sentenceStart": False},
            {"text": "Georgie", "sentenceStart": True},
        ]})
        missing_items = client.post("/api/vocabulary/classify", json={})
        wrong_type = client.post("/api/vocabulary/classify", json={"items": "nope"})
    assert duplicated.status_code == 200
    first, second = duplicated.json()["items"]
    assert (first["text"], first["proper"]) == ("Georgie", True)
    assert (second["text"], second["proper"]) == ("Georgie", False)
    assert missing_items.status_code == 422
    assert wrong_type.status_code == 422


def test_classify_accepts_corpus_facts_in_camel_and_snake_case(vocab_env, make_client):
    """classify 透传两条语料级观察事实（specs/004 v1.1 句首专名兜底）。"""
    items = [
        # Toto 型：句首出现，但全文从未小写、且另有非句首大写 → 专名。
        {"text": "Toto", "sentenceStart": True,
         "hasLowercase": False, "hasNonInitialCapital": True},
        # The 型：句首出现但全文有小写 → 普通词（照常返回等级）。
        {"text": "The", "sentenceStart": True,
         "hasLowercase": True, "hasNonInitialCapital": True},
        # 只出现在句首、没有非句首大写 → 词形信息不足，仍按普通词。
        {"text": "Toto", "sentenceStart": True,
         "hasLowercase": False, "hasNonInitialCapital": False},
        # 蛇形入参同样接受。
        {"text": "Toto", "sentence_start": True,
         "has_non_initial_capital": True, "has_lowercase": False},
        # 非句首大写本来就是专名，两条事实不会把它变回普通词。
        {"text": "Toto", "sentenceStart": False},
    ]
    with make_client() as client:
        response = client.post("/api/vocabulary/classify", json={"items": items})
    assert response.status_code == 200, response.text
    proper = [item["proper"] for item in response.json()["items"]]
    assert proper == [True, False, False, True, True]
    assert response.json()["items"][1]["level"] == "A1"


def test_classify_limit_and_empty_items(vocab_env, make_client):
    ok_items = [{"text": f"w{i}"} for i in range(200)]
    too_many = [{"text": f"w{i}"} for i in range(201)]
    with make_client() as client:
        ok = client.post("/api/vocabulary/classify", json={"items": ok_items})
        over = client.post("/api/vocabulary/classify", json={"items": too_many})
        empty = client.post("/api/vocabulary/classify", json={"items": []})
    assert ok.status_code == 200, ok.text
    assert len(ok.json()["items"]) == 200
    assert over.status_code == 400
    assert "200" in over.json()["detail"]
    assert empty.status_code == 200
    assert empty.json() == {"items": []}


def test_classify_public_endpoint_does_not_issue_guest_cookie(vocab_env, make_client):
    with make_client() as client:
        response = client.post(
            "/api/vocabulary/classify", json={"items": [{"text": "the"}]}
        )
    assert response.status_code == 200
    assert "ln_guest" not in response.cookies
    assert all(
        "ln_guest" not in header
        for header in response.headers.get_list("set-cookie")
    )


def test_classify_rule_matches_word_rules_module(vocab_env, make_client):
    """端点只是 word_rules 的 HTTP 封装：专名判定（含语料事实）与纯函数一致。"""
    tokens = [
        # (text, sentence_start, has_lowercase, has_non_initial_capital)
        ("George", False, False, True),
        ("George", True, True, True),
        ("Toto", True, False, True),
        ("Toto", True, False, False),
        ("London", False, False, False),
        ("The", True, True, True),
        ("museum", False, True, False),
    ]
    with make_client() as client:
        response = client.post(
            "/api/vocabulary/classify",
            json={"items": [
                {
                    "text": text,
                    "sentenceStart": sentence_start,
                    "hasLowercase": has_lowercase,
                    "hasNonInitialCapital": has_non_initial_capital,
                }
                for text, sentence_start, has_lowercase, has_non_initial_capital in tokens
            ]},
        )
    assert response.status_code == 200
    for item, (text, sentence_start, has_lowercase, has_non_initial_capital) in zip(
        response.json()["items"], tokens
    ):
        assert item["proper"] is word_rules.is_proper_token(
            text,
            sentence_start=sentence_start,
            has_lowercase=has_lowercase,
            has_non_initial_capital=has_non_initial_capital,
        )


# ---------------------------------------------------------------------------
# 503 / 数据文件边界
# ---------------------------------------------------------------------------

def test_missing_frequency_returns_503(vocab_env, tmp_path, monkeypatch, make_client):
    monkeypatch.setattr(
        config, "WORDLIST_PATH", str(tmp_path / "no-such-frequency.json"), raising=False
    )
    difficulty.reset_wordlist_cache()
    vocabulary.reset_cache()
    with make_client() as client:
        lists = client.get("/api/vocabulary/lists")
        detail = client.get("/api/vocabulary/lists/cefr-a1")
        level = client.get("/api/vocabulary/level", params={"words": "the"})
        classify = client.post(
            "/api/vocabulary/classify", json={"items": [{"text": "the"}]}
        )
    assert lists.status_code == 503
    assert detail.status_code == 503
    assert level.status_code == 503
    assert classify.status_code == 503
    assert "频表" in lists.json()["detail"]


def test_missing_exam_and_lexicon_returns_503(
    vocab_env, tmp_path, monkeypatch, make_client
):
    empty = tmp_path / "empty-wordlists"
    empty.mkdir()
    monkeypatch.setattr(config, "VOCABULARY_DIR", str(empty), raising=False)
    vocabulary.reset_cache()
    with make_client() as client:
        lists = client.get("/api/vocabulary/lists")
        gre = client.get("/api/vocabulary/lists/gre")
        cefr = client.get("/api/vocabulary/lists/cefr-a1")
    assert lists.status_code == 503
    assert gre.status_code == 503
    assert cefr.status_code == 503


def test_level_only_requires_frequency_not_exam_files(
    vocab_env, tmp_path, monkeypatch, make_client
):
    empty = tmp_path / "empty-wordlists"
    empty.mkdir()
    monkeypatch.setattr(config, "VOCABULARY_DIR", str(empty), raising=False)
    vocabulary.reset_cache()
    with make_client() as client:
        level = client.get("/api/vocabulary/level", params={"words": "abandon"})
        lists = client.get("/api/vocabulary/lists")
    assert level.status_code == 200
    assert level.json() == {"abandon": "B1"}
    assert lists.status_code == 503


def test_corrupt_artifact_integrity_returns_503(
    vocab_env, tmp_path, monkeypatch, make_client
):
    corrupt = tmp_path / "corrupt-wordlists"
    shutil.copytree(vocab_env.out, corrupt)
    exam_path = corrupt / "exam-bands.v1.json"
    document = json.loads(exam_path.read_text(encoding="utf-8"))
    document["entries"][0][2] += 1
    exam_path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(config, "VOCABULARY_DIR", str(corrupt), raising=False)
    vocabulary.reset_cache()
    with make_client() as client:
        lists = client.get("/api/vocabulary/lists")
        gre = client.get("/api/vocabulary/lists/gre")
    assert lists.status_code == 503
    assert gre.status_code == 503
    assert "完整性" in lists.json()["detail"]

