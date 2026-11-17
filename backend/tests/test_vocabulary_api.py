"""单词本词表/等级 API 离线验收（routes_vocabulary.py / vocabulary.py）。

覆盖：公开只读、目录 9 项（6 CEFR + GRE/CET4/CET6）、C2 unavailable、
分页/搜索/前缀优先、等级映射/C1+/非法 token、大小限制、404/503、缓存头、
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
from tests.vocab_fixtures import (
    build_phrases,
    copy_frequency,
    load_builder,
    write_tiny_ecdict,
)

builder = load_builder()
LIST_IDS = [
    "phrases",
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

def test_lists_catalog_has_6_cefr_plus_3_exam_lists(vocab_env, make_client):
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
    assert lists.status_code == 503
    assert detail.status_code == 503
    assert level.status_code == 503
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

