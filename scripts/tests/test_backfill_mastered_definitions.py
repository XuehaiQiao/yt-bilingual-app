"""`scripts/backfill_mastered_definitions.py` 的隔离单测（临时目录，不碰真实数据）。

每个用例把 config.DATA_DIR / AUTH_DB_PATH 指到 tmp_path；DB 用最小 schema
现场建（含 mastered + definition + word_sources），备份按 reconcile 的真实
文件名与记录形状写。覆盖：dry-run 零写入、apply 只填空不覆盖、--check、
--rollback 幂等与冲突保护。
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

import backfill_mastered_definitions as backfill  # noqa: E402

USER_ID = "581d15fe48e44d24be36f06f9926a014"
STAMP = "20261122-142825"

EMPTY_ROWS = (
    ("w-affordability", "affordability"),
    ("w-intimately", "intimately"),
    ("w-thorny", "thorny"),
    ("w-ecstacy", "ecstacy"),
)
EXISTING = ("w-existing", "existing", "已有释义，不许覆盖")

EXPECTED = {
    "affordability": "支付能力；负担能力；可购性",
    "intimately": "亲切地, 亲密地, 个人性地",
    "thorny": "多刺的, 令人苦恼的",
    "ecstacy": "（多用于参加舞会的）狂喜迷幻药",
}

BACKUP_RECORDS = [
    {
        "id": "vocab-aff",
        "type": "vocabulary",
        "en_text": "Affordability",
        "zh_text": "/əˌfɔdɚ'bɪlətɪ/ 支付能力；负担能力；可购性",
    },
    {
        "id": "vocab-int",
        "type": "vocabulary",
        "en_text": "intimately",
        "zh_text": "/'intimitli/ 亲切地, 亲密地, 个人性地",
    },
    {
        "id": "vocab-thorny",
        "type": "vocabulary",
        "en_text": "thorny",
        "zh_text": "/'θɒ:ni/ 多刺的, 令人苦恼的",
    },
    {
        "id": "vocab-ecstacy",
        "type": "vocabulary",
        "en_text": "ecstacy",
        "zh_text": "（多用于参加舞会的）狂喜迷幻药",
    },
    {
        "id": "vocab-existing",
        "type": "vocabulary",
        "en_text": "existing",
        "zh_text": "不应覆盖",
    },
    # sentence 记录不能参与回填（即使 en_text 与已掌握词相同）。
    {
        "id": "sentence-thorny",
        "type": "sentence",
        "en_text": "thorny",
        "zh_text": "句子释义",
    },
]


def _create_db(db_path: Path) -> None:
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE word_states (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                lemma TEXT NOT NULL,
                target_lang TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'new',
                due_at INTEGER NOT NULL DEFAULT 0,
                stability REAL,
                difficulty REAL,
                reps INTEGER NOT NULL DEFAULT 0,
                lapses INTEGER NOT NULL DEFAULT 0,
                step INTEGER NOT NULL DEFAULT 0,
                fail_streak INTEGER NOT NULL DEFAULT 0,
                last_reviewed_at INTEGER,
                created_at INTEGER NOT NULL,
                mastered INTEGER NOT NULL DEFAULT 0,
                definition TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE word_sources (
                word_state_id TEXT NOT NULL,
                content_ref TEXT,
                sentence_id TEXT,
                created_at INTEGER NOT NULL
            )
            """
        )
        for index, (word_id, lemma) in enumerate(EMPTY_ROWS, start=1):
            conn.execute(
                "INSERT INTO word_states (id, user_id, lemma, target_lang, state, "
                "created_at, mastered, definition) VALUES (?, ?, ?, 'zh-CN', 'new', ?, 1, NULL)",
                (word_id, USER_ID, lemma, 1795000000000 + index),
            )
        existing_id, existing_lemma, existing_definition = EXISTING
        conn.execute(
            "INSERT INTO word_states (id, user_id, lemma, target_lang, state, "
            "created_at, mastered, definition) VALUES (?, ?, ?, 'zh-CN', 'new', ?, 1, ?)",
            (existing_id, USER_ID, existing_lemma, 1795000000100, existing_definition),
        )
        # 未掌握的词即使 definition 为空也绝不参与回填。
        conn.execute(
            "INSERT INTO word_states (id, user_id, lemma, target_lang, state, "
            "created_at, mastered, definition) VALUES ('w-unmastered', ?, 'lonely', "
            "'zh-CN', 'new', 1795000000200, 0, NULL)",
            (USER_ID,),
        )
        conn.commit()
    finally:
        conn.close()


def _snapshot_tree(root: Path) -> dict[str, tuple[int, str]]:
    snapshot: dict[str, tuple[int, str]] = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            snapshot[str(path.relative_to(root))] = (
                path.stat().st_size,
                hashlib.sha256(path.read_bytes()).hexdigest(),
            )
    return snapshot


def _definitions(db_path: Path) -> dict[str, str | None]:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return {
            row[0]: row[1]
            for row in conn.execute("SELECT lemma, definition FROM word_states")
        }
    finally:
        conn.close()


def _audit_lines(path: Path) -> list[dict]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


@pytest.fixture()
def env(tmp_path, monkeypatch):
    db_path = tmp_path / "app.db"
    _create_db(db_path)
    backups = tmp_path / "backups"
    backups.mkdir()
    backup_path = backups / f"favorites-{USER_ID}-{STAMP}.json"
    backup_path.write_text(
        json.dumps(BACKUP_RECORDS, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    monkeypatch.setattr(backfill.config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(backfill.config, "AUTH_DB_PATH", str(db_path))
    monkeypatch.setattr(backfill.config, "USER_DATA_DIR", str(tmp_path / "users"))

    return {
        "root": tmp_path,
        "db": db_path,
        "backups": backups,
        "backup": backup_path,
    }


def _run(capsys, argv):
    code = backfill.main(argv)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def test_dry_run_lists_four_sources_and_writes_nothing(env, capsys):
    before = _snapshot_tree(env["root"])
    code, out, err = _run(
        capsys, ["--user-id", USER_ID, "--backup-dir", str(env["backups"])]
    )
    assert code == 0, err
    assert "empty_definition=4" in out
    assert "fillable=4 unresolved=0" in out
    for lemma in EXPECTED:
        assert lemma in out
    assert "支付能力；负担能力；可购性" in out
    assert "（多用于参加舞会的）狂喜迷幻药" in out
    assert "0 写入" in out
    # dry-run 零写入：DB、备份、目录集合/哈希全部不变；不新建审计/备份。
    assert _snapshot_tree(env["root"]) == before
    assert not list(env["backups"].glob("backfill-mastered-definitions-audit-*.jsonl"))
    assert not list(env["backups"].glob("word-states-mastered-definitions-*.json"))
    assert list(env["backups"].glob("favorites-*.json")) == [env["backup"]]


def test_dry_run_json_exposes_original_zh_text_and_meaning(env, capsys):
    code, out, err = _run(
        capsys,
        ["--user-id", USER_ID, "--backup-dir", str(env["backups"]), "--json"],
    )
    assert code == 0, err
    payload = json.loads(out)
    assert payload["mode"] == "dry-run"
    assert payload["empty_definition"] == 4
    assert payload["fillable_count"] == 4
    assert payload["write_files"] == 0
    by_lemma = {item["lemma"]: item for item in payload["rows"]}
    assert by_lemma["thorny"]["source_zh_text"] == "/'θɒ:ni/ 多刺的, 令人苦恼的"
    assert by_lemma["thorny"]["definition_to_write"] == "多刺的, 令人苦恼的"
    # 音标不会被写进 definition（与前端标记时只传 meaning 一致）。
    assert by_lemma["affordability"]["definition_to_write"] == EXPECTED["affordability"]
    assert by_lemma["ecstacy"]["source_zh_text"] == EXPECTED["ecstacy"]


def test_apply_fills_only_empty_definitions_with_backup_and_audit(env, capsys):
    code, out, err = _run(
        capsys,
        [
            "--apply",
            "--user-id",
            USER_ID,
            "--yes",
            "--backup-dir",
            str(env["backups"]),
        ],
    )
    assert code == 0, err
    assert "empty_definition: 4 -> 0" in out

    definitions = _definitions(env["db"])
    for lemma, meaning in EXPECTED.items():
        assert definitions[lemma] == meaning
    # 已有快照绝不覆盖。
    assert definitions["existing"] == EXISTING[2]
    # 未掌握行不参与。
    assert definitions["lonely"] is None

    (backup_path,) = env["backups"].glob("word-states-mastered-definitions-*.json")
    payload = json.loads(backup_path.read_text(encoding="utf-8"))
    assert payload["script"] == backfill.SCRIPT_NAME
    assert payload["user_id"] == USER_ID
    assert {item["lemma"] for item in payload["planned"]} == set(EXPECTED)
    assert len(payload["word_states"]) == 4

    (audit_path,) = env["backups"].glob("backfill-mastered-definitions-audit-*.jsonl")
    lines = _audit_lines(audit_path)
    assert lines[0]["type"] == "header"
    assert lines[0]["empty_definition_before"] == 4
    fills = [line for line in lines if line.get("type") == "fill"]
    assert {line["lemma"] for line in fills} == set(EXPECTED)
    for line in fills:
        assert line["definition_before"] is None
        assert line["definition_after"] == EXPECTED[line["lemma"]]
        assert line["source_backup"] == str(env["backup"])
    assert lines[-1]["type"] == "result"
    assert lines[-1]["empty_definition_after"] == 0


def test_check_reports_violation_then_ok(env, capsys):
    code, out, _ = _run(capsys, ["--check", "--user-id", USER_ID])
    assert code == 1
    assert "empty_definition=4" in out

    code, _, err = _run(
        capsys,
        [
            "--apply",
            "--user-id",
            USER_ID,
            "--yes",
            "--backup-dir",
            str(env["backups"]),
        ],
    )
    assert code == 0, err

    code, out, _ = _run(capsys, ["--check", "--user-id", USER_ID])
    assert code == 0
    assert "empty_definition=0" in out
    assert "OK" in out


def test_rollback_restores_then_is_idempotent(env, capsys):
    code, _, err = _run(
        capsys,
        [
            "--apply",
            "--user-id",
            USER_ID,
            "--yes",
            "--backup-dir",
            str(env["backups"]),
        ],
    )
    assert code == 0, err
    (audit_path,) = env["backups"].glob("backfill-mastered-definitions-audit-*.jsonl")

    code, out, err = _run(capsys, ["--rollback", str(audit_path)])
    assert code == 0, err
    assert "restored=4" in out
    definitions = _definitions(env["db"])
    for lemma in EXPECTED:
        assert definitions[lemma] is None
    assert definitions["existing"] == EXISTING[2]

    code, out, err = _run(capsys, ["--rollback", str(audit_path)])
    assert code == 0, err
    assert "restored=0 already_before=4" in out

    # 备份 JSON 也能回滚（apply 后直接用它恢复）。
    code, _, err = _run(
        capsys,
        [
            "--apply",
            "--user-id",
            USER_ID,
            "--yes",
            "--backup-dir",
            str(env["backups"]),
        ],
    )
    assert code == 0, err
    backup_path = max(
        env["backups"].glob("word-states-mastered-definitions-*.json"),
        key=lambda path: path.stat().st_mtime_ns,
    )
    code, out, err = _run(capsys, ["--rollback", str(backup_path)])
    assert code == 0, err
    assert "restored=4" in out
    assert all(_definitions(env["db"])[lemma] is None for lemma in EXPECTED)


def test_rollback_does_not_overwrite_user_edited_definition(env, capsys):
    code, _, err = _run(
        capsys,
        [
            "--apply",
            "--user-id",
            USER_ID,
            "--yes",
            "--backup-dir",
            str(env["backups"]),
        ],
    )
    assert code == 0, err
    (audit_path,) = env["backups"].glob("backfill-mastered-definitions-audit-*.jsonl")
    conn = sqlite3.connect(env["db"])
    try:
        conn.execute(
            "UPDATE word_states SET definition = '用户手改' WHERE lemma = 'thorny'"
        )
        conn.commit()
    finally:
        conn.close()

    code, out, err = _run(capsys, ["--rollback", str(audit_path)])
    assert code == 1
    assert "restored=3" in out
    assert "conflicts=1" in out
    assert "thorny" in err
    definitions = _definitions(env["db"])
    assert definitions["thorny"] == "用户手改"
    assert definitions["affordability"] is None


def test_apply_requires_user_id_and_yes(env, capsys):
    code, _, err = _run(
        capsys, ["--apply", "--user-id", USER_ID, "--backup-dir", str(env["backups"])]
    )
    assert code == 2
    assert "--yes" in err

    code, _, err = _run(
        capsys, ["--apply", "--yes", "--backup-dir", str(env["backups"])]
    )
    assert code == 2
    assert "--user-id" in err
    assert _definitions(env["db"])["affordability"] is None


def test_unresolved_rows_are_reported_and_never_invented(env, capsys):
    conn = sqlite3.connect(env["db"])
    try:
        conn.execute(
            "INSERT INTO word_states (id, user_id, lemma, target_lang, state, "
            "created_at, mastered, definition) VALUES ('w-missing', ?, 'missing', "
            "'zh-CN', 'new', 1795000000300, 1, NULL)",
            (USER_ID,),
        )
        conn.commit()
    finally:
        conn.close()

    code, out, err = _run(
        capsys, ["--user-id", USER_ID, "--backup-dir", str(env["backups"]), "--json"]
    )
    assert code == 1
    payload = json.loads(out)
    assert payload["unresolved_count"] == 1
    missing = next(item for item in payload["rows"] if item["lemma"] == "missing")
    assert missing["reason"] == "no_backup_favorite"

    code, out, err = _run(
        capsys,
        [
            "--apply",
            "--user-id",
            USER_ID,
            "--yes",
            "--backup-dir",
            str(env["backups"]),
        ],
    )
    assert code == 1
    assert "unresolved=1" in out
    assert _definitions(env["db"])["missing"] is None
    assert _definitions(env["db"])["thorny"] == EXPECTED["thorny"]
