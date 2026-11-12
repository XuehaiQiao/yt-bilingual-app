"""本地词典优先链路（全离线）。

覆盖：
- 本地词典命中：`/api/define` 不调用大模型、返回字段正确、不写 LLM 缓存；
- 本地未命中：照旧走大模型候选链，并把结果写回 `dictionary_cache.json`；
- 没有数据文件 / 文件损坏：优雅回落到大模型，不 500；
- 优先级：LLM 语境缓存 → 本地词典 → 大模型。
"""
import json
import os
import sqlite3

import pytest

import llm
import local_dict
import routes_user

DICT_PAYLOAD = {
    "word": "serendipity",
    "lemma": "serendipity",
    "ipa": "/ˌserənˈdɪpəti/",
    "pos": "n.",
    "zh": "意外发现美好事物的运气",
    "definition_en": "The luck of finding something good without looking for it.",
    "example": "It was pure serendipity that we met.",
}

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
    # 常规词：命中，词性/音标/英文释义都能从 ECDICT 字段拆出来
    ("hello", "hello", "həˈləʊ", "n. an expression of greeting",
     "interj. 喂, 嘿", "s:hellos"),
    # 屈折词：exchange 的 0: 项还原原型
    ("running", "running", "'rʌniŋ",
     "n. the state of being in operation",
     "n. 赛跑, 流出, 运转", "0:run/1:i/i:running/s:runnings"),
    # 词组 / 行首无词性
    ("give up", "give up", "", "", "放弃；认输", ""),
    # 只有英文释义的条目：视为未命中，交给大模型补中文
    ("englishonly", "englishonly", "", "n. an entry without Chinese", "", ""),
    # ECDICT 用字面量 "\\n" 分隔义项（反斜杠 + n），不是真换行
    ("multi", "multi", "", "n. first sense\\nsecond sense",
     "n. 第一义\\n第二义", ""),
    # 极少数词条第一条义项是英文说明，应取第一条含中文的
    ("mixed", "mixed", "", "", "English gloss\\n[计] 混合", ""),
    # 整条 translation 都是英文（Wiktionary 转写）：视为未命中
    ("nocjk", "nocjk", "", "", "just English text, no Chinese", ""),
]


def _make_db(path, rows=ROWS):
    conn = sqlite3.connect(str(path))
    conn.executescript(SCHEMA)
    conn.executemany("INSERT INTO stardict VALUES (?, ?, ?, ?, ?, ?)", rows)
    conn.commit()
    conn.close()


@pytest.fixture()
def local_db(tmp_path, monkeypatch):
    """造一个小 sqlite，并把 LOCAL_DICT_PATH 指过去（同时验证 env 覆盖生效）。"""
    path = tmp_path / "local-test.db"
    _make_db(path)
    monkeypatch.setenv("LOCAL_DICT_PATH", str(path))
    local_dict.reset()
    yield path
    local_dict.reset()


def _fake_llm(monkeypatch, calls):
    def fake_generate_json(prompt, model=None):
        calls.append({"prompt": prompt, "model": model})
        return json.dumps(DICT_PAYLOAD, ensure_ascii=False)

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)


# ---------------------------------------------------------------------------
# local_dict.lookup 本身
# ---------------------------------------------------------------------------

def test_lookup_maps_ecdict_fields(local_db):
    entry = local_dict.lookup("Running")
    assert entry == {
        "word": "Running",          # 查询词大小写与词条一致时保留用户输入
        "lemma": "run",             # exchange 的 0:run
        "ipa": "/'rʌniŋ/",
        "pos": "n.",
        "zh": "赛跑, 流出, 运转",
        "definition_en": "the state of being in operation",
        "example": "",              # ECDICT 不提供例句
        "senses": [
            {
                "pos": "n.",
                "zh": "赛跑, 流出, 运转",
                "definition_en": "the state of being in operation",
            }
        ],
    }


def test_lookup_is_case_insensitive_and_handles_phrases(local_db):
    assert local_dict.lookup("HELLO")["zh"] == "喂, 嘿"
    assert local_dict.lookup("  Give   UP ")["word"] == "give up"
    assert local_dict.lookup("  Give   UP ")["zh"] == "放弃；认输"
    assert local_dict.lookup("give-up") is None


def test_lookup_treats_missing_chinese_as_miss(local_db):
    assert local_dict.lookup("englishonly") is None
    assert local_dict.lookup("not-in-dictionary") is None


def test_lookup_skips_non_chinese_translation(local_db):
    assert local_dict.lookup("mixed")["zh"] == "[计] 混合"
    assert local_dict.lookup("nocjk") is None


def test_lookup_splits_escaped_newlines(local_db):
    entry = local_dict.lookup("multi")
    assert entry["pos"] == "n."
    assert entry["zh"] == "第一义"
    assert entry["definition_en"] == "first sense"


def test_lookup_without_data_file_returns_none(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_DICT_PATH", str(tmp_path / "missing.db"))
    local_dict.reset()

    assert local_dict.is_available() is False
    assert local_dict.lookup("hello") is None  # 不抛异常


def test_lookup_with_corrupt_data_file_returns_none(tmp_path, monkeypatch):
    broken = tmp_path / "broken.db"
    broken.write_bytes(b"this is not a sqlite database")
    monkeypatch.setenv("LOCAL_DICT_PATH", str(broken))
    local_dict.reset()

    assert local_dict.is_available() is False
    assert local_dict.lookup("hello") is None


def test_dict_path_defaults_and_env_override(tmp_path, monkeypatch):
    override = tmp_path / "custom.db"
    monkeypatch.setenv("LOCAL_DICT_PATH", str(override))
    assert local_dict.dict_path() == str(override)

    monkeypatch.delenv("LOCAL_DICT_PATH")
    assert local_dict.dict_path().endswith(os.path.join("data", "ecdict.db"))


# ---------------------------------------------------------------------------
# /api/define 链路
# ---------------------------------------------------------------------------

def test_define_hits_local_dict_without_llm(client, history_dir, local_db, monkeypatch):
    calls = []
    _fake_llm(monkeypatch, calls)

    response = client.post(
        "/api/define",
        json={"word": "Hello", "context": "Hello world. This is a greeting."},
    )

    assert response.status_code == 200
    data = response.json()
    assert set(data) == {
        "word", "lemma", "ipa", "pos", "zh", "definition_en", "example", "senses",
    }
    assert data["word"] == "Hello"
    assert data["zh"] == "喂, 嘿"
    assert data["pos"] == "interj."
    assert data["definition_en"] == ""
    assert data["senses"] == [
        {"pos": "interj.", "zh": "喂, 嘿", "definition_en": ""}
    ]
    assert calls == [], "本地命中时不应调用大模型"
    assert not (history_dir / "dictionary_cache.json").exists(), (
        "本地命中的静态释义不应写进 LLM 的 dictionary_cache.json"
    )


def test_define_falls_back_to_llm_and_caches(client, history_dir, local_db, monkeypatch):
    calls = []
    _fake_llm(monkeypatch, calls)
    monkeypatch.setattr(routes_user, "_dict_model_candidates", lambda: ["gemini-2.5-flash"])

    response = client.post(
        "/api/define",
        json={"word": "serendipity", "context": "It was pure serendipity that we met."},
    )

    assert response.status_code == 200
    assert response.json()["zh"] == DICT_PAYLOAD["zh"]
    assert len(calls) == 1
    assert "serendipity" in calls[0]["prompt"]

    cache_file = history_dir / "dictionary_cache.json"
    assert cache_file.exists(), "大模型结果应写回缓存"
    cached = json.loads(cache_file.read_text(encoding="utf-8"))
    assert cached["serendipity"]["zh"] == DICT_PAYLOAD["zh"]


def test_define_without_dict_file_works(client, history_dir, monkeypatch, tmp_path):
    # autouse 夹具已把 LOCAL_DICT_PATH 指到不存在的路径，这里再显式确认一次
    monkeypatch.setenv("LOCAL_DICT_PATH", str(tmp_path / "nope.db"))
    local_dict.reset()

    calls = []
    _fake_llm(monkeypatch, calls)
    monkeypatch.setattr(routes_user, "_dict_model_candidates", lambda: ["gemini-2.5-flash"])

    response = client.post("/api/define", json={"word": "hello"})

    assert response.status_code == 200, "没有词典数据也应正常回落，不能 500"
    assert response.json()["zh"] == DICT_PAYLOAD["zh"]
    assert len(calls) == 1


def test_define_with_corrupt_dict_file_works(client, history_dir, tmp_path, monkeypatch):
    broken = tmp_path / "corrupt.db"
    broken.write_bytes(b"\x00\x01 not a database")
    monkeypatch.setenv("LOCAL_DICT_PATH", str(broken))
    local_dict.reset()

    calls = []
    _fake_llm(monkeypatch, calls)
    monkeypatch.setattr(routes_user, "_dict_model_candidates", lambda: ["gemini-2.5-flash"])

    response = client.post("/api/define", json={"word": "hello"})

    assert response.status_code == 200
    assert response.json()["zh"] == DICT_PAYLOAD["zh"]
    assert len(calls) == 1


def test_llm_cache_takes_precedence_over_local_dict(
    client, history_dir, local_db, monkeypatch
):
    cached_entry = dict(DICT_PAYLOAD, word="hello", zh="语境缓存释义")
    (history_dir / "dictionary_cache.json").write_text(
        json.dumps({"hello": cached_entry}, ensure_ascii=False), encoding="utf-8"
    )

    calls = []
    _fake_llm(monkeypatch, calls)

    response = client.post("/api/define", json={"word": "hello"})

    assert response.status_code == 200
    assert response.json()["zh"] == "语境缓存释义", "语境缓存应先于静态本地词典"
    assert calls == []
