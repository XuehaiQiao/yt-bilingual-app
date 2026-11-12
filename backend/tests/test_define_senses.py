"""多义项（senses）契约与兼容性测试（全离线）。

覆盖：
- 本地 ECDICT 多行/多词性解析成 senses，definition 按词性补英文释义；
- 路由对本地命中返回 senses，首条与顶层字段一致；
- LLM 路径返回并缓存 senses；模型漏返时用顶层字段补一条；
- 旧版 `dictionary_cache.json` 没有 senses 时读取补全（不报错、不返回空）；
- senses 最多 12 条（本地词典与缓存中的超长列表都截断）。
"""
import json
import sqlite3

import pytest

import llm
import local_dict
import routes_user

SCHEMA = """
CREATE TABLE stardict (
    word TEXT NOT NULL,
    sw TEXT NOT NULL,
    phonetic TEXT,
    definition TEXT,
    translation TEXT,
    exchange TEXT
);
CREATE INDEX idx_stardict_sw ON stardict(sw);
"""

ROWS = [
    # 多词性：两行分别对齐 definition 里同词性的两行
    (
        "hood",
        "hood",
        "hʊd",
        "n. a covering for the head\nv. to cover with a hood",
        "n. 罩；风帽\\nv. 包起来",
        "",
    ),
    # definition 只有 n.：v. 义项对不齐，英文释义留空
    (
        "partial",
        "partial",
        "",
        "n. only the first definition",
        "n. 甲\\nv. 乙",
        "",
    ),
    # 15 条义项：响应契约最多 12 条
    (
        "many",
        "many",
        "",
        "",
        "\\n".join(f"n. 义{i}" for i in range(1, 16)),
        "",
    ),
]

LLM_PAYLOAD = {
    "word": "serendipity",
    "lemma": "serendipity",
    "ipa": "/ˌserənˈdɪpəti/",
    "pos": "n.",
    "zh": "意外发现美好事物的运气",
    "definition_en": "The luck of finding something good without looking for it.",
    "example": "It was pure serendipity that we met.",
    "senses": [
        {
            "pos": "n.",
            "zh": "意外发现美好事物的运气",
            "definition_en": "The luck of finding something good without looking for it.",
        },
        {
            "pos": "n.",
            "zh": "（偶然的）好运",
            "definition_en": "Good luck that happens by chance.",
        },
    ],
}


def _make_db(path, rows=ROWS):
    conn = sqlite3.connect(str(path))
    conn.executescript(SCHEMA)
    conn.executemany("INSERT INTO stardict VALUES (?, ?, ?, ?, ?, ?)", rows)
    conn.commit()
    conn.close()


@pytest.fixture()
def local_db(tmp_path, monkeypatch):
    path = tmp_path / "senses-test.db"
    _make_db(path)
    monkeypatch.setenv("LOCAL_DICT_PATH", str(path))
    local_dict.reset()
    yield path
    local_dict.reset()


def _fake_llm(monkeypatch, payload, calls):
    def fake_generate_json(prompt, model=None):
        calls.append({"prompt": prompt, "model": model})
        return json.dumps(payload, ensure_ascii=False)

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)


def _use_one_model(monkeypatch):
    monkeypatch.setattr(
        routes_user, "_dict_model_candidates", lambda: ["gemini-2.5-flash"]
    )


# ---------------------------------------------------------------------------
# 本地词典：多义项解析
# ---------------------------------------------------------------------------

def test_local_dict_parses_multi_pos_senses(local_db):
    entry = local_dict.lookup("hood")

    assert entry["senses"] == [
        {
            "pos": "n.",
            "zh": "罩；风帽",
            "definition_en": "a covering for the head",
        },
        {
            "pos": "v.",
            "zh": "包起来",
            "definition_en": "to cover with a hood",
        },
    ]
    # 顶层字段取首条，保持旧契约
    assert (entry["pos"], entry["zh"], entry["definition_en"]) == (
        "n.",
        "罩；风帽",
        "a covering for the head",
    )


def test_local_dict_unmatched_definition_is_empty(local_db):
    senses = local_dict.lookup("partial")["senses"]

    assert senses[0] == {
        "pos": "n.",
        "zh": "甲",
        "definition_en": "only the first definition",
    }
    assert senses[1] == {"pos": "v.", "zh": "乙", "definition_en": ""}


def test_local_dict_senses_capped_at_12(local_db):
    senses = local_dict.lookup("many")["senses"]

    assert len(senses) == routes_user.MAX_SENSES == 12
    assert senses[0]["zh"] == "义1"
    assert senses[-1]["zh"] == "义12"


def test_define_returns_multi_senses_from_local_dict(client, local_db):
    response = client.post("/api/define", json={"word": "hood"})

    assert response.status_code == 200
    data = response.json()
    assert len(data["senses"]) == 2
    assert data["senses"][0] == {
        "pos": data["pos"],
        "zh": data["zh"],
        "definition_en": data["definition_en"],
    }
    assert [sense["pos"] for sense in data["senses"]] == ["n.", "v."]


# ---------------------------------------------------------------------------
# 大模型：返回 senses / 漏返时补一条
# ---------------------------------------------------------------------------

def test_llm_path_returns_senses_and_caches(client, history_dir, monkeypatch):
    calls = []
    _fake_llm(monkeypatch, LLM_PAYLOAD, calls)
    _use_one_model(monkeypatch)

    response = client.post(
        "/api/define",
        json={"word": "Serendipity", "context": "It was pure serendipity that we met."},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["senses"] == LLM_PAYLOAD["senses"]
    assert data["senses"][0] == {
        "pos": data["pos"],
        "zh": data["zh"],
        "definition_en": data["definition_en"],
    }
    # 提示词确实要求多义项与排序
    assert '"senses"' in calls[0]["prompt"]
    assert "2-5" in calls[0]["prompt"]

    cached = json.loads(
        (history_dir / "dictionary_cache.json").read_text(encoding="utf-8")
    )
    assert cached["serendipity"]["senses"] == LLM_PAYLOAD["senses"]


def test_llm_without_senses_falls_back_to_top_level(client, history_dir, monkeypatch):
    payload = {k: v for k, v in LLM_PAYLOAD.items() if k != "senses"}
    calls = []
    _fake_llm(monkeypatch, payload, calls)
    _use_one_model(monkeypatch)

    response = client.post("/api/define", json={"word": "serendipity"})

    assert response.status_code == 200
    data = response.json()
    assert data["senses"] == [
        {
            "pos": payload["pos"],
            "zh": payload["zh"],
            "definition_en": payload["definition_en"],
        }
    ]


# ---------------------------------------------------------------------------
# 旧缓存兼容 / 上限
# ---------------------------------------------------------------------------

OLD_CACHE_ENTRY = {
    "word": "elephant",
    "lemma": "elephant",
    "ipa": "/ˈelɪfənt/",
    "pos": "n.",
    "zh": "象，大象",
    "definition_en": "A very large grey mammal with a trunk.",
    "example": "We saw a big elephant at the zoo.",
}


def test_old_cache_without_senses_is_backfilled(client, history_dir, monkeypatch):
    (history_dir / "dictionary_cache.json").write_text(
        json.dumps({"elephant": OLD_CACHE_ENTRY}, ensure_ascii=False),
        encoding="utf-8",
    )
    calls = []
    _fake_llm(monkeypatch, LLM_PAYLOAD, calls)

    response = client.post("/api/define", json={"word": "Elephant"})

    assert response.status_code == 200, "旧缓存不应报错"
    data = response.json()
    assert data["senses"] == [
        {
            "pos": OLD_CACHE_ENTRY["pos"],
            "zh": OLD_CACHE_ENTRY["zh"],
            "definition_en": OLD_CACHE_ENTRY["definition_en"],
        }
    ]
    assert data["example"] == OLD_CACHE_ENTRY["example"]
    assert calls == [], "命中旧缓存时不应调用大模型"


def test_cached_senses_capped_at_12(client, history_dir):
    senses = [
        {"pos": "n.", "zh": f"义{i}", "definition_en": ""} for i in range(1, 21)
    ]
    entry = dict(
        OLD_CACHE_ENTRY,
        pos=senses[0]["pos"],
        zh=senses[0]["zh"],
        definition_en=senses[0]["definition_en"],
        senses=senses,
    )
    (history_dir / "dictionary_cache.json").write_text(
        json.dumps({"elephant": entry}, ensure_ascii=False), encoding="utf-8"
    )

    data = client.post("/api/define", json={"word": "elephant"}).json()

    assert len(data["senses"]) == 12
    assert data["senses"][0]["zh"] == "义1"
    assert data["senses"][-1]["zh"] == "义12"
