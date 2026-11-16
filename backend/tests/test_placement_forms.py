"""M2 定位测题库：Form A/B、锚题等值、rasch.eap.v2、抽题与回退。

覆盖：

1. 两套 64 题（40 真词 + 4 伪词 = 44 词汇槽 + 20 阅读）、4 篇 × 5 题、
   选项/答案/带覆盖合法；
2. 10 道共享锚题同题同参数；service 加载时锚题不一致直接 503；
3. 伪词不在仓库词表；
4. v2 抽题 24+3+5、10 锚题必出、阅读覆盖 4 篇、同一 sessionId 确定性；
5. start 开关：默认 v1 旧流程；PLACEMENT_BANK_VERSION=v2 出新题；
   会话 id 前缀保护「升级中途的旧会话」；
6. v2 评分：A/B 同一 θ 尺度、锚题计数、calibration_version 落库；
7. 质量脚本 build_report：p 值全 null、锚题一致、CLI 退出 0。
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

import assessment
import config
import placement
from tests.migration_utils import assert_alembic_ok, run_alembic

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "check_placement_bank.py"
WORDLIST_PATH = REPO_ROOT / "content" / "wordlist" / "frequency_bands.v1.json"
PASSWORD = "placement-forms-password-123"


# ---------------------------------------------------------------------------
# 夹具 / 工具
# ---------------------------------------------------------------------------

def _upgrade() -> None:
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"),
        "upgrade head (placement forms)",
    )


@pytest.fixture()
def placement_db(client):
    _upgrade()
    return client


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _start(client) -> dict:
    response = client.get("/api/placement/start")
    assert response.status_code == 200, response.text
    return response.json()


def _submit(client, data: dict, answers: list[dict], duration_ms: int = 600_000):
    return client.post(
        "/api/placement/submit",
        json={
            "sessionId": data["sessionId"],
            "answers": answers,
            "durationMs": duration_ms,
        },
    )


def _answers_for(session_id: str) -> list[dict]:
    """用服务端确定性卷面生成「全对」答案（伪词诚实跳过）。"""
    served = placement.served_item_id
    answers: list[dict] = []
    items = placement.sample_items(session_id)
    for index, item in enumerate(items, start=1):
        item_id = served(index)
        if item.type == "pseudo":
            answers.append({"itemId": item_id, "chosenIndex": -1})
        else:
            answers.append({"itemId": item_id, "chosenIndex": item.answer_index})
    return answers


def _load_script():
    spec = importlib.util.spec_from_file_location(
        "check_placement_bank_for_tests", SCRIPT_PATH
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# 题库结构
# ---------------------------------------------------------------------------

def test_form_banks_are_draft_and_have_64_items_each():
    for form in ("A", "B"):
        bank = placement.load_form_bank(form)
        assert bank.form == form
        assert bank.version == "placement.bank.v2"
        assert len(bank.vocab) == 40
        assert len(bank.reading) == 20
        assert len(bank.pseudo) == 4
        assert len(bank.all_items) == 64
        # 44 词汇槽 = 40 真词 + 4 伪词；20 阅读；合计 64。
        assert len(bank.vocab) + len(bank.pseudo) == 44
        assert 8 <= len(bank.anchor_ids) <= 10
        assert len(bank.anchor_ids) == 10
        assert bank.parameter_status == "uncalibrated"
        with open(
            REPO_ROOT / "content" / "placement" / "forms" / f"form-{form.lower()}"
            / "vocab.json",
            encoding="utf-8",
        ) as handle:
            payload = json.load(handle)
        assert "待教研审校" in payload["_meta"]["notice"]
        assert "pilot" in payload["_meta"]["notice"]


def test_form_items_options_answers_and_band_coverage():
    for form in ("A", "B"):
        bank = placement.load_form_bank(form)
        assert {item.band for item in bank.vocab} == set(placement.CEFR_BANDS)
        counts = {
            band: sum(1 for item in bank.vocab if item.band == band)
            for band in placement.CEFR_BANDS
        }
        assert counts == {band: 8 for band in placement.CEFR_BANDS}
        anchors = [item for item in bank.vocab if item.anchor]
        assert len(anchors) == 10
        assert {
            band: sum(1 for item in anchors if item.band == band)
            for band in placement.CEFR_BANDS
        } == {band: 2 for band in placement.CEFR_BANDS}
        assert len({item.prompt.lower() for item in bank.vocab}) == 40

        for item in bank.vocab + bank.reading:
            assert len(item.options) == 4
            assert len(set(item.options)) == 4
            assert isinstance(item.answer_index, int)
            assert 0 <= item.answer_index <= 3
            assert item.b is not None
            assert math_isclose(item.b, assessment.BAND_CENTERS[item.band])
        for item in bank.pseudo:
            assert item.answer_index is None
            assert len(item.options) == 4
            assert len(set(item.options)) == 4
            assert item.b is not None


def test_form_reading_has_four_passages_of_five_questions():
    for form in ("A", "B"):
        bank = placement.load_form_bank(form)
        groups: dict[str, list] = {}
        for item in bank.reading:
            assert item.passage_id
            assert item.evidence
            groups.setdefault(item.passage_id, []).append(item)
        assert len(groups) == 4
        assert all(len(group) == 5 for group in groups.values())
        assert len({item.prompt for item in bank.reading}) == 20
        assert {item.band for item in bank.reading} == {"A2", "B1", "B2", "C1"}


def test_anchors_share_identity_and_parameters_across_forms():
    bank_a = placement.load_form_bank("A")
    bank_b = placement.load_form_bank("B")
    assert bank_a.anchor_ids == bank_b.anchor_ids
    a_by = {item.id: item for item in bank_a.vocab if item.anchor}
    b_by = {item.id: item for item in bank_b.vocab if item.anchor}
    assert set(a_by) == set(b_by) == set(bank_a.anchor_ids)
    for anchor_id in bank_a.anchor_ids:
        left, right = a_by[anchor_id], b_by[anchor_id]
        assert left.prompt == right.prompt
        assert left.band == right.band
        assert left.options == right.options
        assert left.answer_index == right.answer_index
        assert left.b == right.b
        assert left.anchor and right.anchor


def test_pseudo_words_are_not_in_committed_wordlist():
    payload = json.loads(WORDLIST_PATH.read_text(encoding="utf-8"))
    entry_words = {str(row[0]).lower() for row in payload["entries"]}
    form_words = {str(word).lower() for word in payload["forms"]}
    for form in ("A", "B"):
        for item in placement.load_form_bank(form).pseudo:
            word = item.prompt.lower()
            assert word not in entry_words
            assert word not in form_words


def test_anchor_gate_rejects_inconsistent_forms(tmp_path, monkeypatch):
    target = tmp_path / "placement"
    shutil.copytree(REPO_ROOT / "content" / "placement" / "forms", target / "forms")
    path = target / "forms" / "form-b" / "vocab.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    anchor = next(item for item in payload["items"] if item.get("anchor"))
    anchor["b"] = float(anchor["b"]) + 0.1
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(config, "PLACEMENT_DIR", str(target), raising=False)
    placement._load_forms_bank.cache_clear()
    with pytest.raises(placement.PlacementUnavailable, match="锚题"):
        placement.load_forms_bank()


# ---------------------------------------------------------------------------
# 抽题
# ---------------------------------------------------------------------------

def test_v2_sampling_is_32_items_with_all_anchors_and_four_passages():
    for form in ("A", "B"):
        bank = placement.load_form_bank(form)
        items = placement.sample_items(f"p2{form.lower()}-sample", version="v2", form=form)
        assert len(items) == placement.SERVED_TOTAL == 32
        assert sum(1 for item in items if item.type == "vocab") == 24
        assert sum(1 for item in items if item.type == "pseudo") == 3
        assert sum(1 for item in items if item.type == "reading") == 5
        assert sum(1 for item in items if item.anchor) == len(bank.anchor_ids) == 10
        assert {
            band: sum(1 for item in items if item.type == "vocab" and item.band == band)
            for band in placement.CEFR_BANDS
        } == placement._VOCAB_QUOTAS
        passages = {item.passage_id for item in items if item.type == "reading"}
        assert len(passages) == 4
        assert all(item.form == form for item in items)
        # 同一 sessionId 确定性；不同 sessionId 抽样不同。
        assert [item.id for item in items] == [
            item.id
            for item in placement.sample_items(
                f"p2{form.lower()}-sample", version="v2", form=form
            )
        ]
        other = placement.sample_items(
            f"p2{form.lower()}-other", version="v2", form=form
        )
        assert [item.id for item in items] != [item.id for item in other]


def test_form_public_payload_never_leaks_answers_or_parameters():
    for form in ("A", "B"):
        for item in placement.load_form_bank(form).all_items:
            payload = placement._public_item("q-01", item)
            dumped = json.dumps(payload, ensure_ascii=False)
            assert "answerIndex" not in dumped
            assert "answer_index" not in dumped
            assert '"b"' not in dumped
            assert "anchor" not in dumped
            assert payload["type"] in ("vocab", "reading")
            assert len(payload["options"]) == 4
            if item.type == "reading":
                assert payload["passage"] == item.passage
            else:
                assert "passage" not in payload


def test_session_id_prefix_decides_bank_version_and_form(monkeypatch):
    assert placement.session_bank_version("p1-abc") == "v1"
    assert placement.session_form("p1-abc") is None
    assert placement.session_bank_version("old-uuid-without-prefix") == "v1"
    assert placement.session_form("p2a-abc") == "A"
    assert placement.session_form("p2b-abc") == "B"
    assert placement.session_bank_version("p2a-abc") == "v2"
    assert placement.session_form("plain") is None

    sid, form = placement.new_session_id("v2")
    assert sid.startswith(f"p2{form.lower()}-")
    assert placement.session_form(sid) == form
    sid_v1, form_v1 = placement.new_session_id("v1")
    assert sid_v1.startswith("p1-")
    assert form_v1 is None
    # 显式 v2 + 无前缀 id：也能确定性分卷（测试/脚本入口）。
    derived = placement.session_form("plain", version="v2")
    assert derived in ("A", "B")
    assert placement.session_form("plain", version="v2") == derived


def test_configured_bank_version_aliases(monkeypatch):
    for raw, expected in (("v1", "v1"), ("legacy", "v1"), ("1", "v1"),
                          ("v2", "v2"), ("forms", "v2"), ("2", "v2")):
        monkeypatch.setattr(config, "PLACEMENT_BANK_VERSION", raw, raising=False)
        assert placement.configured_bank_version() == expected
    monkeypatch.setattr(config, "PLACEMENT_BANK_VERSION", "v9", raising=False)
    with pytest.raises(placement.PlacementUnavailable, match="PLACEMENT_BANK_VERSION"):
        placement.configured_bank_version()


# ---------------------------------------------------------------------------
# API 开关 / 回退 / 评分
# ---------------------------------------------------------------------------

def test_start_default_is_legacy_v1(placement_db):
    data = _start(placement_db)
    assert data["bankVersion"] == "placement.bank.v1"
    assert data["form"] is None
    assert data["anchorCount"] == 0
    assert data["calibrationVersion"] == "rasch.eap.v1"
    assert data["sessionId"].startswith("p1-")
    assert data["itemCount"] == 32


def test_start_v2_serves_form_and_submit_scores_on_v2(
    placement_db, monkeypatch
):
    monkeypatch.setattr(config, "PLACEMENT_BANK_VERSION", "v2", raising=False)
    data = _start(placement_db)
    assert data["bankVersion"] == "placement.bank.v2"
    assert data["form"] in ("A", "B")
    assert data["anchorCount"] == 10
    assert data["calibrationVersion"] == "rasch.eap.v2"
    assert data["sessionId"].startswith(f"p2{data['form'].lower()}-")
    assert data["itemCount"] == 32

    # 卷面来自新题库：至少一个题目不是旧 39 题里的。
    legacy_prompts = {item.prompt for item in placement.load_bank().all_items}
    assert any(item["prompt"] not in legacy_prompts for item in data["items"])

    result = _submit(placement_db, data, _answers_for(data["sessionId"]))
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["bankVersion"] == "placement.bank.v2"
    assert body["form"] == data["form"]
    assert body["anchorCount"] == 10
    assert body["cefr"]["point"] == "C1"
    assert body["calibration"]["version"] == "rasch.eap.v2"
    assert body["calibration"]["form"] == data["form"]
    assert body["calibration"]["anchorCount"] == 10
    assert body["calibration"]["scale"]["status"] == "uncalibrated"
    assert body["breakdown"]["vocab"]["form"] == data["form"]
    assert body["breakdown"]["calibrationVersion"] == "rasch.eap.v2"
    assert body["profile"]["cefr"] == "B2–C1"
    # 阅读仍降级：任何用户可见 payload 不带阅读带。
    assert "band" not in body["breakdown"]["reading"]

    with _db() as conn:
        row = conn.execute(
            "SELECT breakdown FROM placement_sessions WHERE id=?",
            (data["sessionId"],),
        ).fetchone()
        stored = json.loads(row["breakdown"])
        assert stored["calibration"]["version"] == "rasch.eap.v2"
        profile = conn.execute(
            "SELECT calibration_version FROM user_skill_profiles "
            "WHERE skill='vocabulary'"
        ).fetchone()
        assert profile["calibration_version"] == "rasch.eap.v2"


def test_v2_session_still_submits_after_switch_to_v1(placement_db, monkeypatch):
    monkeypatch.setattr(config, "PLACEMENT_BANK_VERSION", "v2", raising=False)
    data = _start(placement_db)
    assert data["sessionId"].startswith(f"p2{data['form'].lower()}-")
    monkeypatch.setattr(config, "PLACEMENT_BANK_VERSION", "v1", raising=False)
    result = _submit(placement_db, data, _answers_for(data["sessionId"]))
    assert result.status_code == 200, result.text
    assert result.json()["calibration"]["version"] == "rasch.eap.v2"


def test_v1_session_still_submits_after_switch_to_v2(placement_db, monkeypatch):
    data = _start(placement_db)
    assert data["sessionId"].startswith("p1-")
    monkeypatch.setattr(config, "PLACEMENT_BANK_VERSION", "v2", raising=False)
    result = _submit(placement_db, data, _answers_for(data["sessionId"]))
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["calibration"]["version"] == "rasch.eap.v1"
    assert body["bankVersion"] == "placement.bank.v1"
    assert body["form"] is None


def test_v2_broken_bank_returns_503_without_creating_session(
    placement_db, tmp_path, monkeypatch
):
    monkeypatch.setattr(config, "PLACEMENT_BANK_VERSION", "v2", raising=False)
    monkeypatch.setattr(config, "PLACEMENT_DIR", str(tmp_path / "missing"), raising=False)
    response = placement_db.get("/api/placement/start")
    assert response.status_code == 503, response.text
    assert "题库" in response.text
    with _db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM placement_sessions").fetchone()[0] == 0


def test_v2_bad_switch_returns_503(placement_db, monkeypatch):
    monkeypatch.setattr(config, "PLACEMENT_BANK_VERSION", "v9", raising=False)
    response = placement_db.get("/api/placement/start")
    assert response.status_code == 503, response.text
    assert "PLACEMENT_BANK_VERSION" in response.text


def test_v2_score_session_puts_both_forms_on_same_theta_scale():
    results = {}
    for form in ("A", "B"):
        items = placement.sample_items(
            f"p2{form.lower()}-scale", version="v2", form=form
        )
        # 同一作答模式：24 词汇题全对；伪词/阅读不参与 θ。
        chosen = {
            item.id: (item.answer_index if item.answer_index is not None else -1)
            for item in items
        }
        results[form] = placement.score_session(
            items, chosen, duration_ms=600_000, sample_size=1
        )
    assert results["A"]["calibration"]["theta"] == pytest.approx(
        results["B"]["calibration"]["theta"], abs=1e-9
    )
    assert results["A"]["calibration"]["version"] == results["B"]["calibration"]["version"] == "rasch.eap.v2"
    assert results["A"]["cefr"] == results["B"]["cefr"]
    assert results["A"]["calibration"]["anchorCount"] == 10
    assert results["B"]["calibration"]["anchorCount"] == 10


# ---------------------------------------------------------------------------
# 质量脚本
# ---------------------------------------------------------------------------

def test_quality_report_has_null_p_values_and_consistent_anchors():
    module = _load_script()
    report = module.build_report(generated_at="2026-11-17T00:00:00+00:00")
    assert report["schema"] == "placement-items-report.v1"
    assert report["checks"] == {
        "passed": True,
        "issueCount": 0,
        "warningCount": 0,
    }
    assert report["forms"]["A"]["items"]["total"] == 64
    assert report["forms"]["B"]["items"]["total"] == 64
    assert report["forms"]["A"]["items"]["vocab"]["slots"] == 44
    assert report["forms"]["A"]["items"]["reading"]["passages"] == 4
    assert report["anchors"]["count"] == 10
    assert report["anchors"]["identicalAcrossForms"] is True
    assert report["pValues"]["status"] == "pending_pilot"
    assert len(report["pValues"]["items"]) == 128
    assert all(row["pValue"] is None for row in report["pValues"]["items"])
    assert report["equating"]["status"] == "structure_ready_uncalibrated"
    assert report["status"] == "draft_uncalibrated"


def test_quality_script_writes_report_and_cli_check_exits_zero(tmp_path):
    module = _load_script()
    out = tmp_path / "report.json"
    module.write_report(module.build_report(), out)
    payload = json.loads(out.read_text(encoding="utf-8"))
    assert payload["checks"]["passed"] is True
    assert payload["pValues"]["status"] == "pending_pilot"

    completed = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), "--check"],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert completed.returncode == 0, completed.stderr or completed.stdout
    assert "PASS" in completed.stdout


def math_isclose(value: float, expected: float) -> bool:
    return abs(float(value) - float(expected)) < 1e-9


def test_v2_submit_is_idempotent_and_keeps_v2_version(placement_db, monkeypatch):
    monkeypatch.setattr(config, "PLACEMENT_BANK_VERSION", "v2", raising=False)
    data = _start(placement_db)
    first = _submit(placement_db, data, _answers_for(data["sessionId"]))
    assert first.status_code == 200, first.text
    body = first.json()
    again = _submit(placement_db, data, [])
    assert again.status_code == 200, again.text
    repeated = again.json()
    assert repeated["reused"] is True
    assert repeated["calibration"]["version"] == "rasch.eap.v2"
    assert repeated["calibration"]["form"] == body["calibration"]["form"]
    assert repeated["cefr"] == body["cefr"]
    with _db() as conn:
        assert conn.execute("SELECT COUNT(*) FROM placement_answers").fetchone()[0] == 32
        assert conn.execute("SELECT COUNT(*) FROM placement_sessions").fetchone()[0] == 1
