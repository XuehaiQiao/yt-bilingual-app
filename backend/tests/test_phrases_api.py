"""短语词表 API 验收（backend/routes_vocabulary.py / vocabulary.py）。

覆盖：目录新增 phrases、分页、headword/中文释义搜索、level/type 筛选、详情、
404/400/422/503、缓存头、公开端点不签发游客 Cookie。
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
ITEM_KEYS = {
    "id",
    "headword",
    "type",
    "cefr",
    "translation",
    "example",
    "source",
}


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    """迷你单词表 + 真实精选短语（570 条）的离线产物。"""
    root = tmp_path_factory.mktemp("phrases-api")
    frequency = copy_frequency(root / "frequency_bands.v1.json")
    csv_path = write_tiny_ecdict(root / "ecdict.csv")
    out_dir = root / "wordlists"
    assert builder.main(
        [
            "--ecdict-csv",
            str(csv_path),
            "--frequency",
            str(frequency),
            "--out-dir",
            str(out_dir),
            "--allow-small",
        ]
    ) == 0
    report = root / "phrases-report.json"
    assert build_phrases(out_dir, csv_path, frequency, report) == 0
    return SimpleNamespace(root=root, frequency=frequency, csv=csv_path, out=out_dir)


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


def _artifact(built) -> dict:
    return json.loads((built.out / "phrases.v1.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# 目录
# ---------------------------------------------------------------------------

def test_catalog_has_phrases_entry_first(vocab_env, make_client):
    with make_client() as client:
        response = client.get("/api/vocabulary/lists")
    assert response.status_code == 200
    catalog = response.json()
    assert catalog[0]["id"] == "phrases"
    phrases = catalog[0]
    assert phrases["label"] == "短语"
    assert phrases["count"] == 570
    assert phrases["available"] is True
    assert phrases["approximate"] is True
    assert phrases["note"] == "A2–C1 近似，非官方 CEFR 短语表"
    assert phrases["notice"] == "content/wordlists/PHRASES-NOTICE.md"
    assert phrases["source"] == "LinguaTrek 原创精选（ECDICT 短语 tag=0）"
    assert phrases["license"]
    assert phrases["version"] == "2026.11.17"
    # 单词表条目保持原协议字段，不被短语字段污染。
    cefr_a1 = next(item for item in catalog if item["id"] == "cefr-a1")
    assert set(cefr_a1) == {
        "id",
        "label",
        "count",
        "source",
        "license",
        "notice",
        "approximate",
        "available",
        "version",
        "note",
    }


def test_lists_phrases_route_points_to_dedicated_endpoint(vocab_env, make_client):
    with make_client() as client:
        response = client.get("/api/vocabulary/lists/phrases")
    assert response.status_code == 404
    assert "/api/vocabulary/phrases" in response.json()["detail"]


# ---------------------------------------------------------------------------
# 分页
# ---------------------------------------------------------------------------

def test_phrases_pagination(vocab_env, make_client):
    with make_client() as client:
        first = client.get(
            "/api/vocabulary/phrases", params={"page": 1, "pageSize": 50}
        )
        last = client.get(
            "/api/vocabulary/phrases", params={"page": 12, "pageSize": 50}
        )
        beyond = client.get(
            "/api/vocabulary/phrases", params={"page": 13, "pageSize": 50}
        )
        max_page = client.get(
            "/api/vocabulary/phrases", params={"page": 1, "pageSize": 200}
        )
    assert first.status_code == 200, first.text
    payload = first.json()
    assert payload["total"] == 570
    assert payload["page"] == 1
    assert payload["pageSize"] == 50
    assert payload["hasMore"] is True
    assert len(payload["items"]) == 50
    for item in payload["items"]:
        assert set(item) == ITEM_KEYS
        assert item["type"] in vocabulary.PHRASE_TYPES
        assert item["cefr"] in vocabulary.PHRASE_LEVELS
        assert item["source"] == "curated"
    last_payload = last.json()
    assert len(last_payload["items"]) == 20
    assert last_payload["hasMore"] is False
    beyond_payload = beyond.json()
    assert beyond_payload["items"] == []
    assert beyond_payload["total"] == 570
    assert beyond_payload["hasMore"] is False
    assert len(max_page.json()["items"]) == 200


# ---------------------------------------------------------------------------
# 搜索 / 筛选
# ---------------------------------------------------------------------------

def test_phrase_search_headword_and_chinese(vocab_env, make_client):
    with make_client() as client:
        look = client.get("/api/vocabulary/phrases", params={"q": "look"}).json()
        upper = client.get("/api/vocabulary/phrases", params={"q": "LOOK"}).json()
        chinese = client.get("/api/vocabulary/phrases", params={"q": "照顾"}).json()
        none = client.get("/api/vocabulary/phrases", params={"q": "zzzz"}).json()
    assert look["total"] == 16
    assert upper["total"] == 16
    assert look["items"][0]["headword"].startswith("look")
    assert all("look" in item["headword"] for item in look["items"])
    # 前缀优先：look after/look at 等排在 look forward to 之前。
    headwords = [item["headword"] for item in look["items"]]
    assert headwords[0] == "look at"
    assert "look after" in headwords
    meanings = [item["headword"] for item in chinese["items"]]
    assert "look after" in meanings
    assert "take care of" in meanings
    assert chinese["total"] >= 3
    assert none == {
        "items": [],
        "total": 0,
        "page": 1,
        "pageSize": 50,
        "hasMore": False,
    }


def test_phrase_level_and_type_filters(vocab_env, make_client):
    counts = _artifact(vocab_env)["counts"]
    with make_client() as client:
        a2 = client.get(
            "/api/vocabulary/phrases", params={"level": "A2", "pageSize": 200}
        ).json()
        pv = client.get(
            "/api/vocabulary/phrases",
            params={"type": "phrasal_verb", "pageSize": 200},
        ).json()
        b2_idiom = client.get(
            "/api/vocabulary/phrases",
            params={"level": "B2", "type": "idiom", "pageSize": 200},
        ).json()
        c1_plus = client.get(
            "/api/vocabulary/phrases",
            params={"level": "C1+", "pageSize": 200},
        ).json()
        combined_empty = client.get(
            "/api/vocabulary/phrases",
            params={"level": "A2", "type": "idiom", "q": "zzzz"},
        ).json()
    assert a2["total"] == counts["byCefr"]["A2"]
    assert all(item["cefr"] == "A2" for item in a2["items"])
    assert pv["total"] == counts["byType"]["phrasal_verb"]
    assert all(item["type"] == "phrasal_verb" for item in pv["items"])
    assert b2_idiom["total"] == sum(
        1
        for entry in _artifact(vocab_env)["entries"]
        if entry["cefr"] == "B2" and entry["type"] == "idiom"
    )
    assert all(
        item["cefr"] == "B2" and item["type"] == "idiom"
        for item in b2_idiom["items"]
    )
    # C1+ 表示 C1 及以上（C2 未建模）。
    assert c1_plus["total"] == counts["byCefr"]["C1"] + counts["byCefr"]["C1+"]
    assert all(item["cefr"] in {"C1", "C1+"} for item in c1_plus["items"])
    assert combined_empty["total"] == 0


def test_phrase_filters_are_case_insensitive(vocab_env, make_client):
    with make_client() as client:
        lower = client.get(
            "/api/vocabulary/phrases", params={"type": "Phrasal_Verb"}
        )
        upper = client.get(
            "/api/vocabulary/phrases", params={"type": "PHRASAL_VERB"}
        )
        level = client.get(
            "/api/vocabulary/phrases", params={"level": "b2"}
        )
    assert lower.status_code == 200
    assert upper.status_code == 200
    assert level.status_code == 200
    assert lower.json()["total"] == upper.json()["total"] == 302
    assert all(item["cefr"] == "B2" for item in level.json()["items"])


def test_phrase_invalid_filters_and_limits(vocab_env, make_client):
    with make_client() as client:
        bad_level = client.get(
            "/api/vocabulary/phrases", params={"level": "A1"}
        )
        bad_type = client.get(
            "/api/vocabulary/phrases", params={"type": "phrasal"}
        )
        too_long = client.get(
            "/api/vocabulary/phrases", params={"q": "x" * 65}
        )
        page_zero = client.get(
            "/api/vocabulary/phrases", params={"page": 0}
        )
        size_zero = client.get(
            "/api/vocabulary/phrases", params={"pageSize": 0}
        )
        size_over = client.get(
            "/api/vocabulary/phrases", params={"pageSize": 201}
        )
    assert bad_level.status_code == 400
    assert "level" in bad_level.json()["detail"]
    assert bad_type.status_code == 400
    assert "type" in bad_type.json()["detail"]
    assert too_long.status_code == 400
    assert "64" in too_long.json()["detail"]
    assert page_zero.status_code == 422
    assert size_zero.status_code == 422
    assert size_over.status_code == 422


# ---------------------------------------------------------------------------
# 详情
# ---------------------------------------------------------------------------

def test_phrase_detail(vocab_env, make_client):
    with make_client() as client:
        listing = client.get("/api/vocabulary/phrases", params={"pageSize": 1}).json()
        phrase_id = listing["items"][0]["id"]
        response = client.get(f"/api/vocabulary/phrases/{phrase_id}")
        missing = client.get("/api/vocabulary/phrases/no-such-phrase")
    assert response.status_code == 200
    payload = response.json()
    assert payload["id"] == phrase_id
    assert payload["headword"] == listing["items"][0]["headword"]
    assert payload["translation"] and payload["example"]
    assert payload["source"] == "curated"
    assert payload["license"] == "LinguaTrek 原创整理"
    assert "notes" in payload
    assert response.headers["cache-control"] == "public, max-age=3600"
    assert missing.status_code == 404
    assert "不存在" in missing.json()["detail"]


def test_phrase_endpoints_are_public_and_do_not_issue_guest_cookie(make_client):
    with make_client() as client:
        listing = client.get("/api/vocabulary/phrases", params={"pageSize": 1})
        detail = client.get(
            f"/api/vocabulary/phrases/{listing.json()['items'][0]['id']}"
        )
    assert listing.status_code == 200
    assert detail.status_code == 200
    for result in (listing, detail):
        assert "ln_guest" not in result.cookies
        assert all(
            "ln_guest" not in header
            for header in result.headers.get_list("set-cookie")
        )
        assert result.headers["cache-control"] == "public, max-age=3600"


# ---------------------------------------------------------------------------
# 503 / 数据文件边界
# ---------------------------------------------------------------------------

def test_missing_phrases_artifact_returns_503(vocab_env, tmp_path, monkeypatch, make_client):
    empty = tmp_path / "empty-wordlists"
    empty.mkdir()
    monkeypatch.setattr(config, "VOCABULARY_DIR", str(empty), raising=False)
    vocabulary.reset_cache()
    with make_client() as client:
        listing = client.get("/api/vocabulary/phrases")
        detail = client.get("/api/vocabulary/phrases/look-after")
        catalog = client.get("/api/vocabulary/lists")
    assert listing.status_code == 503
    assert "短语词表" in listing.json()["detail"]
    assert detail.status_code == 503
    assert catalog.status_code == 503


def test_corrupt_phrases_integrity_returns_503(vocab_env, tmp_path, monkeypatch, make_client):
    corrupt = tmp_path / "corrupt-phrases"
    shutil.copytree(vocab_env.out, corrupt)
    phrases_path = corrupt / "phrases.v1.json"
    document = json.loads(phrases_path.read_text(encoding="utf-8"))
    document["entries"][0]["translation"] = "被篡改"
    phrases_path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(config, "VOCABULARY_DIR", str(corrupt), raising=False)
    vocabulary.reset_cache()
    with make_client() as client:
        listing = client.get("/api/vocabulary/phrases")
        detail = client.get(f"/api/vocabulary/phrases/{document['entries'][0]['id']}")
    assert listing.status_code == 503
    assert detail.status_code == 503
    assert "完整性" in listing.json()["detail"]
