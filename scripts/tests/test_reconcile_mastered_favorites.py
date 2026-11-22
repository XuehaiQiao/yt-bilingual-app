"""`scripts/reconcile_mastered_favorites.py` 的隔离单测（临时目录，不碰真实数据）。

每个用例把 `config.USER_DATA_DIR` / `config.AUTH_DB_PATH` / `config.DATA_DIR`
指向 `tmp_path`；DB 用最小 schema 现场建，收藏文件按真实布局写 16 条
（15 vocabulary + 1 sentence，其中 3 条与 mastered 重叠）。
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import reconcile_mastered_favorites as reconcile  # noqa: E402

USER_ID = "u-p0-02-test"

OVERLAP_IDS = (
    "vocab-jLlBm-fYi9s-Affordability",
    "vocab-_j4Ru918V4w-intimately",
    "vocab-alice-through-the-looking-glass-thorny",
)

MASTERED_ROWS = (
    ("w-thorny", "thorny", 1795279882919),
    ("w-intimately", "intimately", 1795280058444),
    ("w-affordability", "affordability", 1795309439487),
)


def _favorites_records() -> list[dict]:
    """真实布局的 16 条：15 vocabulary（含 3 条重叠）+ 1 sentence。"""
    records = [
        {
            "id": "vocab-jLlBm-fYi9s-Affordability",
            "type": "vocabulary",
            "en_text": "Affordability",
            "zh_text": "负担能力",
            "added_at": 1794574426084,
            "context_en": "Affordability has become the main issue this election season.",
            "context_zh": "",
            "highlights": [],
        },
        {
            "id": "vocab-_j4Ru918V4w-intimately",
            "type": "vocabulary",
            "en_text": "intimately",
            "zh_text": "密切地",
            "added_at": 1794765922857,
            "context_en": "So these are intimately related.",
            "source_kind": "video",
            "source_ref": "_j4Ru918V4w",
            "source_title": "How China's Economy Actually Works",
        },
        {
            "id": "Z6pHAPhiQqM-13",
            "type": "sentence",
            "en_text": "the countryside is the green area outside of the city",
            "zh_text": "乡村是城市之外的绿色区域",
            "added_at": 1794926935814,
            "source_kind": "video",
            "source_ref": "Z6pHAPhiQqM",
        },
    ]
    others = [
        ("decentralized", 1794765971331, "video", "_j4Ru918V4w"),
        ("chlorine", 1794938321110, "video", "eXdVDhOGqoE"),
        ("doomsday", 1794938324109, "video", "eXdVDhOGqoE"),
        ("singularity", 1794938354051, "video", "eXdVDhOGqoE"),
        ("tangible", 1794938470224, "video", "eXdVDhOGqoE"),
        ("infringement", 1794938542581, "video", "eXdVDhOGqoE"),
        ("perpetrator", 1794938614467, "video", "eXdVDhOGqoE"),
        ("masculinity", 1794938655861, "video", "eXdVDhOGqoE"),
        ("guardrails", 1794939093613, "video", "eXdVDhOGqoE"),
        ("Pumpkinhead", 1794956601016, "book", "oz-the-marvelous-land-of-oz"),
        ("ecstacy", 1794956612266, "book", "oz-the-marvelous-land-of-oz"),
        ("cyclone cellar", 1795276271305, "book", "oz-the-wonderful-wizard-of-oz"),
    ]
    for index, (word, added_at, kind, ref) in enumerate(others):
        records.append(
            {
                "id": f"vocab-other-{index}",
                "type": "vocabulary",
                "en_text": word,
                "zh_text": "释义",
                "added_at": added_at,
                "context_en": f"context for {word}",
                "source_kind": kind,
                "source_ref": ref,
            }
        )
    records.append(
        {
            "id": "vocab-alice-through-the-looking-glass-thorny",
            "type": "vocabulary",
            "en_text": "thorny",
            "zh_text": "棘手的",
            "added_at": 1795279877076,
            "context_en": "“She's one of the thorny kind.”",
            "source_kind": "book",
            "source_ref": "alice-through-the-looking-glass",
        }
    )
    return records


def _create_word_states(db_path: Path) -> None:
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
        for word_state_id, lemma, created_at in MASTERED_ROWS:
            conn.execute(
                "INSERT INTO word_states (id, user_id, lemma, target_lang, state, "
                "created_at, mastered) VALUES (?, ?, ?, 'zh-CN', 'review', ?, 1)",
                (word_state_id, USER_ID, lemma, created_at),
            )
        conn.commit()
    finally:
        conn.close()


def _snapshot_tree(root: Path) -> dict[str, tuple[int, str]]:
    """目录快照：路径 → (大小, sha256)。用于断言 dry-run 零写入。"""
    snapshot: dict[str, tuple[int, str]] = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            snapshot[str(path.relative_to(root))] = (
                path.stat().st_size,
                hashlib.sha256(path.read_bytes()).hexdigest(),
            )
    return snapshot


def _mastered_rows(db_path: Path) -> list[tuple]:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        return [
            tuple(row)
            for row in conn.execute(
                "SELECT id, user_id, lemma, created_at, mastered "
                "FROM word_states WHERE mastered = 1 ORDER BY id"
            )
        ]
    finally:
        conn.close()


@pytest.fixture()
def env(tmp_path, monkeypatch):
    users_dir = tmp_path / "users"
    user_root = users_dir / USER_ID
    user_root.mkdir(parents=True)
    favorites_path = user_root / "favorites.json"
    records = _favorites_records()
    favorites_path.write_text(
        json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    db_path = tmp_path / "app.db"
    _create_word_states(db_path)
    backups_dir = tmp_path / "backups"

    monkeypatch.setattr(reconcile.config, "USER_DATA_DIR", str(users_dir))
    monkeypatch.setattr(reconcile.config, "AUTH_DB_PATH", str(db_path))
    monkeypatch.setattr(reconcile.config, "DATA_DIR", str(tmp_path))

    return SimpleNamespace(
        root=tmp_path,
        users_dir=users_dir,
        user_root=user_root,
        favorites_path=favorites_path,
        db_path=db_path,
        backups_dir=backups_dir,
        records=records,
    )


def _run(capsys, argv):
    code = reconcile.main(argv)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def _load_favorites(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))


def test_normalization_matches_product_and_documents_surface_form_limit():
    # 产品前端 normalizeMasteryWord = trim().toLowerCase()；后端另加 NFC。
    assert reconcile.normalize_word_key("Affordability") == "affordability"
    assert reconcile.normalize_word_key("  Thorny ") == "thorny"
    assert reconcile.normalize_word_key("intimately") == "intimately"
    # 已知局限：不做词形还原，单复数/屈折不会被判为重叠（写进回执）。
    assert reconcile.normalize_word_key("guardrails") != reconcile.normalize_word_key(
        "guardrail"
    )


def test_dry_run_is_read_only_and_reports_exactly_three(env, capsys):
    before = _snapshot_tree(env.root)
    code, out, err = _run(
        capsys,
        ["--user-id", USER_ID, "--expect", "3"],
    )
    assert code == 0, err
    assert "overlap_count=3" in out
    assert "assert overlap_count == 3: OK" in out
    for expected in ("Affordability", "intimately", "thorny"):
        assert expected in out
    for favorite_id in OVERLAP_IDS:
        assert favorite_id in out
    # source_kind/source_ref 缺失的那条（Affordability）也要能打印，不能崩。
    assert "video/_j4Ru918V4w" in out
    assert "book/alice-through-the-looking-glass" in out
    assert "0 写入" in out
    # 零写入：文件集合、大小、内容哈希都不变；也没有备份/审计/锁文件。
    assert _snapshot_tree(env.root) == before
    assert not env.backups_dir.exists()
    assert not (env.user_root / "favorites.json.lock").exists()
    assert _load_favorites(env.favorites_path) == env.records


def test_dry_run_wal_without_frames_leaves_no_sidecars(env, capsys):
    """真实库是 WAL：边车为空时必须走 immutable，dry-run 连 -wal/-shm 都不建。"""
    conn = sqlite3.connect(env.db_path)
    try:
        assert conn.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
    finally:
        conn.close()  # 干净关闭会 checkpoint 并移除 -wal/-shm
    assert not (env.root / "app.db-wal").exists()
    assert reconcile._db_is_wal(str(env.db_path)) is True

    before = _snapshot_tree(env.root)
    code, out, err = _run(capsys, ["--user-id", USER_ID, "--expect", "3"])
    assert code == 0, err
    assert "overlap_count=3" in out
    assert _snapshot_tree(env.root) == before
    assert not (env.root / "app.db-wal").exists()
    assert not (env.root / "app.db-shm").exists()


def test_dry_run_with_live_wal_reads_latest_and_keeps_sidecars(env, capsys):
    """-wal 有未 checkpoint 数据时不能 immutable：必须看到最新提交。"""
    writer = sqlite3.connect(env.db_path)
    try:
        assert writer.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
        writer.execute(
            "INSERT INTO word_states (id, user_id, lemma, target_lang, state, "
            "created_at, mastered) VALUES ('w-chlorine', ?, 'chlorine', "
            "'zh-CN', 'review', 1795000000000, 1)",
            (USER_ID,),
        )
        writer.commit()
        assert (env.root / "app.db-wal").stat().st_size > 0

        code, out, err = _run(capsys, ["--user-id", USER_ID, "--expect", "4"])
        assert code == 0, err
        assert "overlap_count=4" in out
        assert "chlorine" in out
        assert "-wal 非空" in err
        # 只读连接不 checkpoint、不删除边车。
        assert (env.root / "app.db-wal").stat().st_size > 0
    finally:
        writer.close()


def test_dry_run_json_output_is_parseable(env, capsys):
    code, out, err = _run(capsys, ["--user-id", USER_ID, "--json"])
    assert code == 0, err
    payload = json.loads(out)  # import 期 config 警告不得污染 stdout
    assert payload["mode"] == "dry-run"
    assert payload["user_id"] == USER_ID
    assert payload["overlap_count"] == 3
    assert payload["favorites_total"] == 16
    assert payload["vocabulary_count"] == 15
    assert payload["mastered_count"] == 3
    assert {item["favorite_id"] for item in payload["overlaps"]} == set(OVERLAP_IDS)
    favorability = next(
        item for item in payload["overlaps"] if item["lemma"] == "affordability"
    )
    assert favorability["source_kind"] is None
    assert favorability["source_ref"] is None


def test_check_reports_violation_then_ok(env, capsys):
    code, out, _ = _run(capsys, ["--check", "--user-id", USER_ID])
    assert code == 1
    assert "overlap_total=3" in out

    code, out, _ = _run(
        capsys,
        ["--apply", "--user-id", USER_ID, "--yes", "--backup-dir", str(env.backups_dir)],
    )
    assert code == 0

    code, out, _ = _run(capsys, ["--check", "--user-id", USER_ID])
    assert code == 0
    assert "overlap_total=0" in out


def test_apply_deletes_three_with_backup_audit_and_tombstones(env, capsys):
    mastered_before = _mastered_rows(env.db_path)
    code, out, err = _run(
        capsys,
        ["--apply", "--user-id", USER_ID, "--yes", "--backup-dir", str(env.backups_dir)],
    )
    assert code == 0, err
    assert "overlap_before=3" in out
    assert "favorites_total: 16 -> 13 (vocabulary 15 -> 12)" in out
    assert "overlap_after=0" in out
    assert "word_states: unchanged=True" in out

    # favorites：vocabulary 15→12，sentence 保持不变，3 条重叠已删除。
    after = _load_favorites(env.favorites_path)
    assert len(after) == 13
    vocabulary = [item for item in after if item.get("type") == "vocabulary"]
    assert len(vocabulary) == 12
    assert len([item for item in after if item.get("type") == "sentence"]) == 1
    remaining_ids = {item.get("id") for item in after}
    assert remaining_ids.isdisjoint(OVERLAP_IDS)

    # word_states：3 条 mastered 原样不变（不改学习状态）。
    assert _mastered_rows(env.db_path) == mastered_before
    assert len(mastered_before) == 3

    # tombstones：3 条 id 都有删除墓碑。
    tombstones = json.loads(
        (env.user_root / "favorites_tombstones.json").read_text(encoding="utf-8")
    )
    assert set(tombstones) == set(OVERLAP_IDS)
    assert all(isinstance(value, int) and value > 0 for value in tombstones.values())

    # 备份：完整 16 条原样，先于任何删除写入。
    backup_files = sorted(env.backups_dir.glob("favorites-*.json"))
    assert len(backup_files) == 1
    assert json.loads(backup_files[0].read_text(encoding="utf-8")) == env.records

    # 审计 JSONL：header + 3 条 deleted（原记录全文 + 依据 + 时间）+ result。
    audit_files = sorted(env.backups_dir.glob("reconcile-audit-*.jsonl"))
    assert len(audit_files) == 1
    lines = [
        json.loads(line)
        for line in audit_files[0].read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert lines[0]["type"] == "header"
    assert lines[0]["user_id"] == USER_ID
    assert lines[0]["backup_path"] == str(backup_files[0])
    deleted = [line for line in lines if line["type"] == "deleted"]
    assert {line["favorite_id"] for line in deleted} == set(OVERLAP_IDS)
    for line in deleted:
        assert line["reason"] == "mastered_favorite_overlap"
        assert line["user_id"] == USER_ID
        assert "deleted_at" in line and "deleted_at_ms" in line
        assert line["lemma"] in {"affordability", "intimately", "thorny"}
        original = next(
            record for record in env.records if record["id"] == line["favorite_id"]
        )
        assert line["favorite"] == original  # 原记录全文
        assert line["basis"]["en_text"] == original["en_text"]
        assert line["basis"]["mastered_created_at"] > 0
    result = lines[-1]
    assert result["type"] == "result"
    assert result["deleted_count"] == 3
    assert result["overlap_after"] == 0
    assert result["word_states_unchanged"] is True


def test_apply_requires_user_id_and_yes(env, capsys):
    before = _snapshot_tree(env.root)
    code, _, err = _run(capsys, ["--apply", "--yes", "--backup-dir", str(env.backups_dir)])
    assert code == 2
    assert "--user-id" in err
    code, _, err = _run(capsys, ["--apply", "--user-id", USER_ID])
    assert code == 2
    assert "--yes" in err
    assert _snapshot_tree(env.root) == before
    assert _load_favorites(env.favorites_path) == env.records
    assert not env.backups_dir.exists()


def test_apply_is_idempotent_and_writes_nothing_second_time(env, capsys):
    argv = ["--apply", "--user-id", USER_ID, "--yes", "--backup-dir", str(env.backups_dir)]
    code, _, err = _run(capsys, argv)
    assert code == 0, err
    after_first = _load_favorites(env.favorites_path)
    backup_files_after_first = sorted(env.backups_dir.glob("favorites-*.json"))
    audit_files_after_first = sorted(env.backups_dir.glob("reconcile-audit-*.jsonl"))
    snapshot_after_first = _snapshot_tree(env.root)

    code, out, err = _run(capsys, argv)
    assert code == 0, err
    assert "overlap_count=0" in out
    assert _load_favorites(env.favorites_path) == after_first
    assert sorted(env.backups_dir.glob("favorites-*.json")) == backup_files_after_first
    assert (
        sorted(env.backups_dir.glob("reconcile-audit-*.jsonl"))
        == audit_files_after_first
    )
    assert _snapshot_tree(env.root) == snapshot_after_first


def test_rollback_restores_and_is_idempotent(env, capsys):
    code, _, err = _run(
        capsys,
        ["--apply", "--user-id", USER_ID, "--yes", "--backup-dir", str(env.backups_dir)],
    )
    assert code == 0, err
    assert len(_load_favorites(env.favorites_path)) == 13
    (audit_path,) = env.backups_dir.glob("reconcile-audit-*.jsonl")

    code, out, err = _run(capsys, ["--rollback", str(audit_path)])
    assert code == 0, err
    assert "restored=3" in out
    restored = _load_favorites(env.favorites_path)
    assert len(restored) == 16
    assert len([item for item in restored if item.get("type") == "vocabulary"]) == 15
    restored_by_id = {item.get("id"): item for item in restored}
    for original in env.records:
        assert restored_by_id[original["id"]] == original
    # 回滚清掉墓碑：3 条 id 不再记为已删除。
    tombstones_path = env.user_root / "favorites_tombstones.json"
    tombstones = (
        json.loads(tombstones_path.read_text(encoding="utf-8"))
        if tombstones_path.exists()
        else {}
    )
    assert set(tombstones).isdisjoint(OVERLAP_IDS)

    # 再跑一次：幂等，不产生重复记录。
    code, out, err = _run(capsys, ["--rollback", str(audit_path)])
    assert code == 0, err
    assert "restored=0" in out
    assert "already_present=3" in out
    assert len(_load_favorites(env.favorites_path)) == 16
    assert len({item.get("id") for item in _load_favorites(env.favorites_path)}) == 16


def test_rollback_skips_planned_but_undeleted_item(env, capsys, tmp_path):
    """审计先于删除：即使某条只写了审计、实际没删，回滚也幂等跳过。"""
    existing = env.records[0]
    audit = tmp_path / "audit.jsonl"
    lines = [
        {
            "type": "header",
            "script": reconcile.SCRIPT_NAME,
            "audit_version": reconcile.AUDIT_VERSION,
            "user_id": USER_ID,
            "backup_path": str(tmp_path / "favorites-backup.json"),
        },
        {
            "type": "deleted",
            "phase": "before_delete",
            "user_id": USER_ID,
            "favorite_id": existing["id"],
            "favorite": existing,
            "lemma": "affordability",
        },
    ]
    audit.write_text(
        "\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n",
        encoding="utf-8",
    )
    code, out, err = _run(capsys, ["--rollback", str(audit)])
    assert code == 0, err
    assert "restored=0" in out
    assert "already_present=1" in out
    assert _load_favorites(env.favorites_path) == env.records


def test_rollback_rejects_mismatched_user_id(env, capsys):
    code, _, err = _run(
        capsys,
        ["--apply", "--user-id", USER_ID, "--yes", "--backup-dir", str(env.backups_dir)],
    )
    assert code == 0, err
    (audit_path,) = env.backups_dir.glob("reconcile-audit-*.jsonl")
    code, _, err = _run(
        capsys, ["--rollback", str(audit_path), "--user-id", "someone-else"]
    )
    assert code == 2
    assert "不一致" in err


def test_overlap_only_counts_vocabulary_favorites():
    mastered = {"thorny": {"id": "w", "lemma": "thorny", "created_at": 1}}
    sentence = {
        "id": "s1",
        "type": "sentence",
        "en_text": "thorny",
        "added_at": 1,
    }
    vocabulary = {
        "id": "v1",
        "type": "vocabulary",
        "en_text": "Thorny",
        "added_at": 2,
    }
    overlaps, vocabulary_records = reconcile.collect_overlaps(
        [sentence, vocabulary], [sentence, vocabulary], mastered
    )
    assert [item["favorite_id"] for item in overlaps] == ["v1"]
    # 第二个返回值是参与比较的 vocabulary 收藏（原记录），sentence 被排除。
    assert [item["id"] for item in vocabulary_records] == ["v1"]


def test_rollback_rejects_audit_without_header(env, capsys, tmp_path):
    # 没有 header 的 JSONL = 不可信审计文件，拒绝回滚。
    bogus = tmp_path / "bogus.jsonl"
    bogus.write_text(
        json.dumps({"type": "deleted", "favorite": {"id": "x"}}) + "\n",
        encoding="utf-8",
    )
    code, _, err = _run(capsys, ["--rollback", str(bogus)])
    assert code == 2
    assert "header" in err
