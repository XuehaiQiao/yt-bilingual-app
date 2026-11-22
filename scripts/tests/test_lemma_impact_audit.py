"""``scripts/lemma_impact_audit.py`` 的隔离单测（临时 ecdict/app.db/fixtures）。

不读真实 `data/`：每个用例在 tmp_path 里建最小 ECDICT 与 app.db，覆盖
exchange 解析、lemma 分组、歧义/专名/短语分类、只读哈希证明与 JSON CLI。
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import lemma_impact_audit as audit  # noqa: E402

USER_ID = "u-lemma-test"
GUEST_ID = "guest:u-lemma-test"


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

def _make_ecdict(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE stardict ("
        "word TEXT NOT NULL, sw TEXT, phonetic TEXT, definition TEXT, "
        "translation TEXT, exchange TEXT)"
    )
    rows = [
        # word, exchange, translation
        ("leaf", "s:leaves/i:leafing/p:leafed/d:leafed", "n. 叶子"),
        ("leave", "3:leaves/d:left/i:leaving", "v. 离开"),
        ("leaves", "0:leave/1:3s", "n. 叶子（复数）"),
        ("axe", "3:axes", "n. 斧头"),
        ("ax", "3:axes", "n. 斧头"),
        ("axes", "0:ax/1:s3", "n. 斧头（复数）"),
        ("guardrail", "s:guardrails", "n. 护栏"),
        ("guardrails", "0:guardrail/1:s", "n. 护栏（复数）"),
        ("include", "3:includes/i:including/p:included", "v. 包括"),
        ("including", "0:include/1:i", "prep. 包括"),
        ("number", "0:numb/1:r", "n. 数字"),
        ("numb", "r:number", "a. 麻木的"),
        ("fix", "d:fixed/p:fixed", "v. 修理"),
        ("fixed", "0:fix/1:dp", "a. 固定的"),
        ("be", "p:was/3:is", "v. 是"),
        ("was", "", "v. 是（过去式）"),
        ("Kansas", "", "n. 堪萨斯州"),
        ("cyclone cellar", "", "n. 龙卷风地窖"),
        ("get up", "", "phr. 起床"),
    ]
    conn.executemany(
        "INSERT INTO stardict (word, exchange, translation) VALUES (?, ?, ?)",
        rows,
    )
    conn.commit()
    conn.close()


def _make_app_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE word_states (
            id TEXT PRIMARY KEY, user_id TEXT, lemma TEXT, target_lang TEXT,
            state TEXT, due_at INTEGER, stability FLOAT, difficulty FLOAT,
            reps INTEGER, lapses INTEGER, step INTEGER, fail_streak INTEGER,
            last_reviewed_at INTEGER, created_at INTEGER, mastered INTEGER,
            definition TEXT
        );
        CREATE TABLE word_sources (
            word_state_id TEXT, content_ref TEXT, sentence_id TEXT,
            created_at INTEGER
        );
        CREATE TABLE learning_events (
            id INTEGER PRIMARY KEY, user_id TEXT, device_id TEXT,
            session_id TEXT, event_type TEXT, content_ref TEXT, payload TEXT,
            occurred_at INTEGER, created_at INTEGER, pseudonym_id TEXT,
            client_event_id TEXT
        );
        CREATE TABLE review_logs (
            id INTEGER PRIMARY KEY, user_id TEXT, lemma TEXT, target_lang TEXT,
            rating TEXT, state_before TEXT, state_after TEXT,
            reviewed_at INTEGER, elapsed_ms INTEGER
        );
        CREATE TABLE weekly_reports (
            id INTEGER PRIMARY KEY, user_id TEXT, week_start DATE,
            payload TEXT, created_at INTEGER
        );
        CREATE TABLE user_wordlists (
            id TEXT PRIMARY KEY, user_id TEXT, name TEXT,
            source_filename TEXT, item_count INTEGER, created_at INTEGER
        );
        CREATE TABLE user_wordlist_items (
            id TEXT PRIMARY KEY, list_id TEXT, word TEXT, word_key TEXT,
            translation TEXT, phonetic TEXT, cefr TEXT, example TEXT,
            position INTEGER
        );
        """
    )
    conn.executemany(
        "INSERT INTO word_states (id, user_id, lemma, target_lang, state, "
        "due_at, reps, lapses, last_reviewed_at, created_at, mastered, "
        "definition) VALUES (?, ?, ?, 'zh-CN', 'review', ?, ?, ?, ?, ?, ?, ?)",
        [
            ("w-guardrail", USER_ID, "guardrail", 1000, 1, 0, 50, 10, 0, None),
            ("w-guardrails", USER_ID, "guardrails", 2000, 5, 2, 100, 20, 1, "护栏"),
            ("w-was", USER_ID, "was", 3000, 2, 0, 30, 30, 0, None),
            ("w-number", USER_ID, "number", 4000, 0, 0, 40, 40, 0, None),
        ],
    )
    events = [
        ("e1", USER_ID, "including", 1),
        ("e2", USER_ID, "including", 2),
        ("e3", USER_ID, "include", 3),
        ("e4", USER_ID, "was", 4),
        ("e5", USER_ID, "fixed", 5),
        ("e6", USER_ID, "number", 6),
        ("e7", USER_ID, "leaves", 7),
        ("e8", USER_ID, "Kansas", 8),
        ("e9", USER_ID, "Tippetarius", 9),
        ("e10", GUEST_ID, "including", 10),
    ]
    conn.executemany(
        "INSERT INTO learning_events (id, user_id, event_type, payload, "
        "occurred_at) VALUES (?, ?, 'dict_lookup', ?, ?)",
        [(int(eid[1:]), user, json.dumps({"word": word, "source": "test"}), at)
         for eid, user, word, at in events],
    )
    # 2026-11-16 是周一；两条 review_logs 同一个 lemma -> 周报 distinct=1。
    base_ms = 1794900000000  # 2026-11-17T…Z 附近
    conn.executemany(
        "INSERT INTO review_logs (user_id, lemma, target_lang, reviewed_at) "
        "VALUES (?, ?, 'zh-CN', ?)",
        [(USER_ID, "guardrail", base_ms), (USER_ID, "guardrail", base_ms + 1)],
    )
    payload = {
        "version": 1,
        "report": {
            "weekStart": "2026-11-16",
            "weekEnd": "2026-11-23",
            "numbers": {"reviewedWords": 0, "passiveMinutes": 0.0},
            "words": {"new": 0, "reviewed": 0, "dueTomorrow": 0},
        },
    }
    conn.execute(
        "INSERT INTO weekly_reports (user_id, week_start, payload, created_at) "
        "VALUES (?, '2026-11-16', ?, ?)",
        (USER_ID, json.dumps(payload), base_ms),
    )
    conn.commit()
    conn.close()


def _make_repo(root: Path) -> None:
    (root / "content" / "wordlist").mkdir(parents=True)
    (root / "content" / "wordlists").mkdir(parents=True)
    (root / "content" / "library" / "videos").mkdir(parents=True)
    (root / "content" / "library" / "articles").mkdir(parents=True)
    (root / "data" / "users" / USER_ID).mkdir(parents=True)
    (root / "data" / "users" / "u-other").mkdir(parents=True)
    (root / "data" / "guests" / "guest-a").mkdir(parents=True)

    frequency = {
        "schema": "linguatrek.wordlist.v1",
        "version": "test",
        "counts": {"lemmas": 7},
        "entries": [
            ["leaf", 1], ["leaves", 2], ["number", 3], ["was", 4],
            ["including", 5], ["guardrails", 6], ["guardrail", 7],
        ],
        "forms": {"leaves": "leave", "including": "include",
                  "guardrails": "guardrail"},
    }
    exam = {
        "schema": "linguatrek.exam-bands.v1",
        "version": "test",
        "entries": [
            ["leaf", 4, 1], ["leaves", 4, 2], ["France", 4, 3],
            ["was", 4, 4], ["including", 4, 5],
        ],
    }
    phrases = {
        "schema": "linguatrek.phrases.v1",
        "version": "test",
        "counts": {"total": 2},
        "approximate": True,
        "entries": [
            {"id": "get-up", "headword": "get up", "type": "phrasal_verb",
             "cefr": "A2", "translation": "起床", "example": "I get up.",
             "source": "curated"},
            {"id": "leave-it", "headword": "leave it", "type": "idiom",
             "cefr": "B1", "translation": "别管了", "example": "Leave it.",
             "source": "curated"},
        ],
    }
    (root / "content" / "wordlist" / "frequency_bands.v1.json").write_text(
        json.dumps(frequency, ensure_ascii=False), encoding="utf-8")
    (root / "content" / "wordlists" / "exam-bands.v1.json").write_text(
        json.dumps(exam, ensure_ascii=False), encoding="utf-8")
    (root / "content" / "wordlists" / "phrases.v1.json").write_text(
        json.dumps(phrases, ensure_ascii=False), encoding="utf-8")
    video = {"id": "v-test", "blocks": [
        {"id": 1, "en_text": "The leaves fall. Axes are sharp. "
                             "Including guardrails and Kansas."},
    ]}
    article = {"id": "a-test", "paragraphs": [
        {"en": "The leaves fall; guardrails help. Including this. Kansas."},
    ]}
    (root / "content" / "library" / "videos" / "v-test.json").write_text(
        json.dumps(video, ensure_ascii=False), encoding="utf-8")
    (root / "content" / "library" / "articles" / "a-test.json").write_text(
        json.dumps(article, ensure_ascii=False), encoding="utf-8")

    favorites = [
        {"id": "f-leaves", "type": "vocabulary", "en_text": "leaves",
         "source_kind": "video", "source_ref": "v1", "source_title": "T",
         "added_at": 1000},
        {"id": "f-leaf", "type": "vocabulary", "en_text": "leaf",
         "source_kind": "book", "source_ref": "b1", "source_title": "B",
         "added_at": 2000},
        {"id": "f-guardrails", "type": "vocabulary", "en_text": "guardrails",
         "source_kind": "video", "source_ref": "v2", "source_title": "T2",
         "added_at": 3000},
        {"id": "f-guardrail", "type": "vocabulary", "en_text": "guardrail",
         "source_kind": "wordlist", "source_ref": "gre", "source_title": "GRE",
         "added_at": 4000},
        {"id": "f-number", "type": "vocabulary", "en_text": "number",
         "source_kind": "video", "source_ref": "v3", "source_title": "T3",
         "added_at": 5000},
        {"id": "f-numb", "type": "vocabulary", "en_text": "numb",
         "source_kind": "book", "source_ref": "b2", "source_title": "B2",
         "added_at": 6000},
        {"id": "f-include", "type": "vocabulary", "en_text": "include",
         "source_kind": "video", "source_ref": "v4", "source_title": "T4",
         "added_at": 7000},
        {"id": "f-kansas", "type": "vocabulary", "en_text": "Kansas",
         "source_kind": "book", "source_ref": "b3", "source_title": "B3",
         "added_at": 8000},
        {"id": "f-phrase", "type": "vocabulary", "en_text": "cyclone cellar",
         "source_kind": "book", "source_ref": "b4", "source_title": "B4",
         "added_at": 9000},
        {"id": "f-uncovered", "type": "vocabulary", "en_text": "pumpkinhead",
         "source_kind": "book", "source_ref": "b5", "source_title": "B5",
         "added_at": 10000},
        {"id": "sentence-1", "type": "sentence", "en_text": "ignored",
         "added_at": 11000},
    ]
    (root / "data" / "users" / USER_ID / "favorites.json").write_text(
        json.dumps(favorites, ensure_ascii=False), encoding="utf-8")
    (root / "data" / "users" / "u-other" / "favorites.json").write_text(
        "[]", encoding="utf-8")


@pytest.fixture()
def fixture(tmp_path: Path) -> dict:
    root = tmp_path / "repo"
    _make_repo(root)
    _make_ecdict(root / "data" / "ecdict.db")
    _make_app_db(root / "data" / "app.db")
    return {
        "root": str(root),
        "db": str(root / "data" / "app.db"),
        "ecdict": str(root / "data" / "ecdict.db"),
    }


# ---------------------------------------------------------------------------
# 解析 / 分类
# ---------------------------------------------------------------------------

def test_parse_exchange_base() -> None:
    assert audit.parse_exchange_base("0:leave/1:3s") == "leave"
    assert audit.parse_exchange_base("1:dp/0:call") == "call"
    assert audit.parse_exchange_base("s:leaves/i:leafing") is None
    assert audit.parse_exchange_base("0:") is None
    assert audit.parse_exchange_base("") is None
    assert audit.parse_exchange_base(None) is None
    assert audit.parse_exchange_base("0:LEAVE") == "leave"


def test_parse_exchange_forms_skips_metadata() -> None:
    forms = audit.parse_exchange_forms("0:leave/1:3s/s:leaves/i:leaving")
    assert forms == [("s", "leaves"), ("i", "leaving")]
    assert audit.parse_exchange_forms("0:leave/1:3s") == []
    assert audit.parse_exchange_forms("s:leaves/f:Leaves") == [
        ("s", "leaves"), ("f", "leaves"),
    ]


def test_normalize_word_nfc_and_lower() -> None:
    assert audit.normalize_word("  HeLLo ") == "hello"
    # e + combining acute -> NFC 单码位
    assert audit.normalize_word("e\u0301") == "\u00e9"
    assert audit.normalize_word(None) == ""


def test_ecdict_lemma_and_ambiguity(fixture: dict) -> None:
    needed = {"leaves", "leaf", "axes", "axe", "guardrails", "guardrail",
              "was", "number", "numb", "including", "include"}
    index = audit.EcdictIndex(fixture["ecdict"], needed)
    leaves = index.inspect("leaves")
    assert leaves.base == "leave"
    assert set(leaves.candidates) == {"leaf", "leave"}
    assert len(index.ambiguity("leaves")) == 2
    axes = index.inspect("axes")
    assert axes.base == "ax"
    assert set(axes.candidates) == {"ax", "axe"}
    assert index.lemma("guardrails") == "guardrail"
    assert index.inspect("guardrails").candidates == ("guardrail",)
    # 没有 0: 的 was 回退原词，但反查能看到 be。
    assert index.lemma("was") == "was"
    assert index.reverse_bases("was") == ("be",)
    assert index.lemma("number") == "numb"
    assert index.inspect("number").candidates == ("numb",)


def test_build_record_blockers(fixture: dict) -> None:
    index = audit.EcdictIndex(
        fixture["ecdict"],
        {"leaves", "guardrails", "cyclone cellar", "pumpkinhead",
         "Kansas", "number", "was"},
    )
    leaves = audit.build_record("favorites", USER_ID, "leaves", index)
    assert leaves.base == "leave"
    assert "ambiguous" in leaves.blockers
    assert not leaves.auto_merge_ok

    guardrails = audit.build_record("favorites", USER_ID, "guardrails", index)
    assert guardrails.auto_merge_ok
    assert guardrails.safe_key == "guardrail"

    phrase = audit.build_record("favorites", USER_ID, "cyclone cellar", index)
    assert phrase.phrase and "phrase" in phrase.blockers
    assert phrase.lemma == "cyclone cellar"

    uncovered = audit.build_record("favorites", USER_ID, "pumpkinhead", index)
    assert not uncovered.covered
    assert "uncovered" in uncovered.blockers

    proper = audit.build_record("favorites", USER_ID, "Kansas", index)
    assert proper.proper and "proper" in proper.blockers

    homograph = audit.build_record("favorites", USER_ID, "number", index)
    assert "homograph" in homograph.blockers
    assert homograph.lemma == "numb"


# ---------------------------------------------------------------------------
# 端到端
# ---------------------------------------------------------------------------

def test_audit_fixture_end_to_end(fixture: dict) -> None:
    result = audit.audit(fixture["root"], user_id=USER_ID, include_events=True)

    # 只读证明
    assert result["integrity"]["diff"]["all_unchanged"] is True
    assert result["integrity"]["diff"]["changed"] == []
    # 分析结果键与 JSON 可序列化
    json.dumps(result, ensure_ascii=False)

    favorites = result["coverage"]["favorites"]
    assert favorites["records"] == 10
    assert favorites["distinct_surface_forms"] == 10
    assert favorites["distinct_lemmas_rule"] == 8
    assert favorites["mergeable_groups_rule"] == 2  # guardrail + numb
    assert favorites["mergeable_groups_safe"] == 1  # number 被同形词挡住
    assert favorites["rows_with_any_rewrite"] == 3  # leaves/guardrails/number

    states = result["coverage"]["wordStates"]
    assert states["records"] == 4
    assert states["mergeable_groups_rule"] == 1  # guardrail/guardrails
    assert result["conflicts"]["favorites_same_lemma"]["count"] == 2  # guardrail + numb
    assert result["conflicts"]["word_states_same_lemma"]["count"] == 1
    guard = result["conflicts"]["favorites_same_lemma"]["groups"][0]
    assert guard["lemma"] == "guardrail"
    assert {item["word"] for item in guard["forms"]} == {"guardrail", "guardrails"}
    suggestion = result["conflicts"]["word_states_same_lemma"]["groups"][0]["suggestion"]
    assert suggestion["keep_id"] == "w-guardrails"  # reps 5 > 1
    assert result["conflicts"]["cross_source_same_lemma"]["count"] >= 2

    events = result["coverage"]["dictLookupEvents"]
    assert events["records"] == 10  # 焦点用户 9 + guest 1
    assert events["seen_counts"]["events"] == 10
    assert events["seen_counts"]["distinct_surface"] == 8
    assert events["seen_counts"]["distinct_lemma"] == 7
    assert events["mergeable_groups_rule"] == 1  # including/include
    assert events["blocked_with_base_rows"] == 3  # leaves/fixed/number
    assert events["uncovered_distinct"] == 1  # tippetarius
    focus_seen = result["crossModule"]["seenCounts"]["focus"]
    assert focus_seen["events"] == 9
    assert focus_seen["distinct_surface"] == 8

    candidates = result["misMergeCandidates"]
    assert candidates["proper_noun_candidates"]["count"] >= 1
    assert candidates["ambiguous_multi_base"]["count"] >= 2  # leaves/axes
    assert candidates["ecd_suspect_bases"]["count"] >= 1     # number
    assert candidates["phrase_candidates"]["count"] >= 3     # 2 短语表 + cyclone cellar
    assert candidates["builtin_wordlist_uppercase_rows"]["count"] == 1  # France
    assert any(
        item["word"] == "was"
        for item in candidates["rule_blind_spots"]["examples"]
    )

    wordlists = result["crossModule"]["builtinWordlists"]
    assert wordlists["exam"]["unique"]["inflected_rows"] >= 1
    assert wordlists["exam"]["unique"]["rows"] == 5
    assert wordlists["exam"]["uppercase_rows"] == 1
    assert wordlists["cefr"]["rows"] == 7
    assert wordlists["phrases"]["auto_merge_candidates"] == 0
    assert wordlists["phrases"]["multiword_rows"] == 2

    highlight = result["crossModule"]["highlight"]
    assert highlight["favorites"]["gain_forms"] >= 1  # including -> include
    assert highlight["corpus"]["tokens_distinct"] > 0

    weekly = result["crossModule"]["weeklyAndEvents"]
    assert weekly["weekly_reports"][0]["lemma_effect_if_recanonicalized"] == 0
    assert weekly["weekly_reports"][0]["snapshot_drift"] == -1

    assert result["plans"]["A"]["affected_records"] > 0
    assert result["plans"]["B"]["favorites_untouched"] == 10
    assert result["guestData"]["guest_dict_lookup_events"] == 1
    assert result["guestData"]["server_side_auditable"] is False


def test_audit_hashes_files_and_does_not_write(fixture: dict) -> None:
    paths = [fixture["db"], fixture["ecdict"],
             str(Path(fixture["root"]) / "data" / "users" / USER_ID / "favorites.json")]
    before = {path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
              for path in paths}
    result = audit.audit(fixture["root"], user_id=USER_ID, include_events=True)
    after = {path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
             for path in paths}
    assert before == after
    assert result["integrity"]["diff"]["all_unchanged"] is True
    assert not (Path(fixture["db"]).parent / "app.db-wal").exists()
    assert not (Path(fixture["db"]).parent / "app.db-shm").exists()


def test_cli_json_output(fixture: dict, capsys: pytest.CaptureFixture[str]) -> None:
    code = audit.main([
        "--json", "--include-events",
        "--root", fixture["root"],
        "--db", fixture["db"],
        "--ecdict", fixture["ecdict"],
        "--user-id", USER_ID,
    ])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["schema"] == audit.SCHEMA
    assert payload["params"]["userId"] == USER_ID
    assert payload["integrity"]["diff"]["all_unchanged"] is True


def test_skip_events(fixture: dict) -> None:
    result = audit.audit(fixture["root"], user_id=USER_ID, include_events=False)
    assert result["coverage"]["dictLookupEvents"] is None
    assert result["crossModule"]["seenCounts"] is None
    assert result["datasets"]["dictLookupEvents"]["skipped"] is True
