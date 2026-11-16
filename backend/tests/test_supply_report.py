"""内容供给报告离线验收（M2，计划书 §4.8 / §10.2 #6）。

覆盖：按 kind 计数、缺失行/占位行归入 failures、总缺口、gate 开关。
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

import config
import difficulty
import recommend
from tests.migration_utils import assert_alembic_ok, run_alembic

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "content_supply_report.py"


def _load_script():
    spec = importlib.util.spec_from_file_location("content_supply_report", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _insert(kind: str, ref: str, cefr_input: str | None) -> None:
    features = {
        "schema": "difficulty.v1",
        "utr_band": {"A1": 0.2, "A2": 0.1, "B1": 0.05, "B2": 0.02, "C1": 0.005},
        "support": {"subtitle": "human" if kind != "article" else "none"},
    }
    difficulty.upsert_payloads(
        [
            {
                "content_ref": ref,
                "content_kind": kind,
                "version": "v1",
                "level": "B1",
                "cefr_input": cefr_input,
                "cefr_task": None,
                "lexical_band": cefr_input,
                "syntax_band": None,
                "discourse_band": None,
                "features": features,
                "support": {"subtitle": "none", "translation": False, "glossary": False, "text": True},
                "method": "rule",
                "confidence": 0.8 if cefr_input else 0.0,
            }
        ]
    )


@pytest.fixture()
def supply_env(client, tmp_path, monkeypatch):
    assert_alembic_ok(run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head")
    library = tmp_path / "library"
    _write(library / "videos.json", {"videos": ["v1"]})
    _write(library / "articles.json", {"articles": ["a1", "a2"]})
    _write(
        tmp_path / "curated.json",
        {"items": [{"videoId": "c1", "title": "c1", "duration": 300, "level": "B1"}]},
    )
    monkeypatch.setattr(config, "LIBRARY_DIR", str(library), raising=False)
    monkeypatch.setattr(config, "CURATED_CONTENT_PATH", str(tmp_path / "curated.json"), raising=False)
    module = _load_script()
    monkeypatch.setattr(module, "_curated_failure_report", lambda: None)
    return module


def test_report_counts_by_kind_and_gate(supply_env):
    _insert("video", "v1", "B1")
    _insert("article", "a1", None)  # 占位行：available=false
    # article:a2 没有行；curated:c1 没有行。
    report = supply_env.build_report()

    assert report["totalContents"] == 4
    assert report["totalEligible"] == 1
    assert report["shortfall"] == 99
    assert report["byKind"]["video"] == {
        "content": 1,
        "difficultyRows": 1,
        "eligible": 1,
        "missingRows": 0,
        "unavailableRows": 0,
    }
    assert report["byKind"]["article"] == {
        "content": 2,
        "difficultyRows": 1,
        "eligible": 0,
        "missingRows": 1,
        "unavailableRows": 1,
    }
    assert report["byKind"]["curated"] == {
        "content": 1,
        "difficultyRows": 0,
        "eligible": 0,
        "missingRows": 1,
        "unavailableRows": 0,
    }
    reasons = {(item["kind"], item["ref"], item["reason"]) for item in report["failures"]}
    assert ("article", "a1", "unavailable") in reasons
    assert ("article", "a2", "missing_difficulty_row") in reasons
    assert ("curated", "c1", "missing_difficulty_row") in reasons
    assert report["gate"]["open"] is False
    assert report["gate"]["mode"] == "legacy"


def test_report_gate_turns_on_at_threshold(supply_env, monkeypatch):
    _insert("video", "v1", "B1")
    monkeypatch.setattr(recommend, "SUPPLY_GATE_MIN", 1, raising=False)
    report = supply_env.build_report()
    assert report["totalEligible"] == 1
    assert report["shortfall"] == 0
    assert report["gate"]["open"] is True
    assert report["gate"]["mode"] == "match_v0"


def test_committed_report_reaches_supply_target():
    """仓库里交付的供给报告必须与 100 条目标一致，gate 已开。"""
    path = ROOT / "docs" / "reports" / "content-supply-2026-11-17.json"
    report = json.loads(path.read_text(encoding="utf-8"))
    assert report["totalEligible"] >= 100
    assert report["shortfall"] == 0
    assert report["gate"]["open"] is True
    assert report["gate"]["mode"] == "match_v0"
    assert report["byKind"]["video"]["eligible"] == 3
    assert report["byKind"]["article"]["eligible"] == 67
    assert report["byKind"]["curated"]["eligible"] == 30
    assert report["gutenberg"]["articles"] == 64
    assert report["failures"] == []
