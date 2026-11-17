"""G1 concierge 观察表汇总脚本的离线测试。"""
from __future__ import annotations

import csv
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "g1_report.py"
FIELDS = [
    "participant_id", "level_self", "device", "start_time", "s1_done",
    "s2_done", "s3_done", "s4_done", "s5_done", "completed_main",
    "duration_min", "drop_stage", "help_count", "output_words",
    "output_submitted", "second_booked", "second_time", "willingness_1_5",
    "top_reason", "quote", "notes",
]


def _load_script():
    spec = importlib.util.spec_from_file_location("g1_report", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _write(path: Path, rows: list[dict]) -> Path:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        for index, row in enumerate(rows, 1):
            base = {key: "" for key in FIELDS}
            base.update({"participant_id": f"P{index:02d}", "duration_min": "12", "willingness_1_5": "3", "top_reason": "其他", "drop_stage": "none"})
            base.update(row)
            writer.writerow(base)
    return path


def test_pass_when_all_three_thresholds_met(tmp_path):
    rows = [
        {"completed_main": "1", "second_booked": "1", "output_submitted": "1", "output_words": "40", "willingness_1_5": "5"}
        for _ in range(10)
    ]
    summary = _load_script().summarize(_load_script().load_rows(_write(tmp_path / "obs.csv", rows)))
    assert summary["verdict"] == "pass"
    assert summary["completed"]["count"] == 10
    assert summary["booked"]["count"] == 10
    assert summary["submitted"]["count"] == 10
    assert summary["willing_ge_4"] == 10
    assert summary["insufficient_data"] is False


def test_conditional_when_two_of_three(tmp_path):
    rows = []
    for i in range(10):
        rows.append({
            "completed_main": "1" if i < 6 else "0",
            "second_booked": "1" if i < 5 else "0",
            "output_submitted": "1" if i < 2 else "0",
            "drop_stage": "S4",
            "top_reason": "太麻烦",
        })
    summary = _load_script().summarize(_load_script().load_rows(_write(tmp_path / "obs.csv", rows)))
    assert summary["verdict"] == "conditional"
    assert summary["completed"]["met"] is True
    assert summary["booked"]["met"] is True
    assert summary["submitted"]["met"] is False
    assert summary["drop_stages"]["S4"] == 4


def test_insufficient_and_malformed_values(tmp_path):
    rows = [
        {"completed_main": "", "second_booked": "maybe", "output_submitted": "0", "willingness_1_5": "not-a-number"},
        {"completed_main": "true", "second_booked": "yes", "output_submitted": "y", "willingness_1_5": "4"},
    ]
    summary = _load_script().summarize(_load_script().load_rows(_write(tmp_path / "obs.csv", rows)))
    assert summary["row_count"] == 2
    assert summary["insufficient_data"] is True
    assert summary["verdict"] == "fail"
    assert summary["completed"]["count"] == 1
    assert summary["booked"]["count"] == 1
    assert summary["submitted"]["count"] == 1
    assert summary["willing_ge_4"] == 1


def test_markdown_contains_thresholds_and_verdict(tmp_path):
    module = _load_script()
    rows = [{"completed_main": "0", "second_booked": "0", "output_submitted": "0", "top_reason": "太难"} for _ in range(10)]
    summary = module.summarize(module.load_rows(_write(tmp_path / "obs.csv", rows)))
    text = module.to_markdown(summary)
    assert "走完主体" in text
    assert "**fail**" in text
    assert "| 太难 | 10 |" in text
