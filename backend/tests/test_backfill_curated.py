"""curated 字幕抓取回填离线验收（M2，计划书 §7.3）。

覆盖：transcripts.py 成功/无字幕/超时三种结果、占位行 available=false、
不落字幕原文、幂等、dry-run；全部在 tmp curated/DB 下跑，不联网。
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

import config
from tests.migration_utils import assert_alembic_ok, run_alembic

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "backfill_curated_transcripts.py"


def _load_script():
    spec = importlib.util.spec_from_file_location("backfill_curated_transcripts", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class _Snippet:
    def __init__(self, text: str, start: float, duration: float) -> None:
        self.text = text
        self.start = start
        self.duration = duration


class _Transcript(list):
    def __init__(self, snippets, subtitle_source: str = "manual") -> None:
        super().__init__(snippets)
        self.subtitle_source = subtitle_source
        self.auto_generated = subtitle_source.startswith("auto")


def _success_transcript() -> _Transcript:
    return _Transcript(
        [
            _Snippet("The family walked to the market and bought fresh bread.", 0.0, 3.0),
            _Snippet("My sister likes to read books about life in small towns.", 3.0, 3.0),
            _Snippet("We visited our parents and had dinner together last week.", 6.0, 3.0),
        ]
    )


@pytest.fixture()
def curated_env(client, tmp_path, monkeypatch):
    assert_alembic_ok(run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head")
    items = [
        {
            "videoId": "aaaaaaaaaaa",
            "title": "curated-a",
            "channel": "c",
            "duration": 300,
            "thumbnail": "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg",
            "topic": "technology",
            "level": "B1",
            "publishedAt": "2024-01-01",
            "reason": "r",
        },
        {
            "videoId": "bbbbbbbbbbb",
            "title": "curated-b",
            "channel": "c",
            "duration": 300,
            "thumbnail": "https://i.ytimg.com/vi/bbbbbbbbbbb/hqdefault.jpg",
            "topic": "culture",
            "level": "B2",
            "publishedAt": "2024-01-01",
            "reason": "r",
        },
        {
            "videoId": "ccccccccccc",
            "title": "curated-c",
            "channel": "c",
            "duration": 300,
            "thumbnail": "https://i.ytimg.com/vi/ccccccccccc/hqdefault.jpg",
            "topic": "psychology",
            "level": "A2",
            "publishedAt": "2024-01-01",
            "reason": "r",
        },
    ]
    path = tmp_path / "curated.json"
    path.write_text(
        json.dumps({"_meta": {"count": len(items)}, "items": items}, ensure_ascii=False),
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "CURATED_CONTENT_PATH", str(path), raising=False)
    return items


def _stub_fetch(monkeypatch, behaviours: dict[str, object]) -> None:
    import transcripts

    def _fetch(video_id: str):
        result = behaviours[video_id]
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(transcripts, "fetch_english_transcript", _fetch)


def test_success_writes_computed_row_without_storing_text(curated_env, monkeypatch):
    module = _load_script()
    import difficulty

    _stub_fetch(monkeypatch, {"aaaaaaaaaaa": _success_transcript()})
    report = module.backfill(curated_env[:1])
    assert report["computed"] == 1
    assert report["unavailable"] == 0
    assert report["written"] == 1
    assert report["items"][0]["available"] is True

    row = difficulty.get_row("curated", "aaaaaaaaaaa")
    assert row is not None
    assert row["cefrInput"] in difficulty.LEVEL_OUTPUTS
    assert row["method"] == "rule"
    assert row["support"]["subtitle"] == "human"
    assert row["features"]["size"]["tokens"] > 0
    # 只落统计特征，不落字幕原文。
    assert "The family walked to the market" not in json.dumps(row, ensure_ascii=False)


def test_no_subtitles_writes_available_false_placeholder(curated_env, monkeypatch):
    module = _load_script()
    import difficulty

    _stub_fetch(
        monkeypatch,
        {"bbbbbbbbbbb": HTTPException(status_code=422, detail="该视频没有英文字幕（含自动生成）。")},
    )
    report = module.backfill([curated_env[1]])
    assert report["unavailable"] == 1
    assert report["byReason"] == {"no_english_subtitles": 1}
    assert report["failures"][0]["available"] is False
    assert report["written"] == 1

    row = difficulty.get_row("curated", "bbbbbbbbbbb")
    assert row is not None
    assert row["cefrInput"] is None
    assert row["confidence"] == 0.0
    assert row["features"]["available"]["asl"] is False
    assert row["features"]["available"]["wpm"] is False
    assert row["support"]["subtitle"] == "none"


def test_timeout_is_reported_and_does_not_fabricate_level(curated_env, monkeypatch):
    module = _load_script()
    import difficulty

    _stub_fetch(
        monkeypatch,
        {"ccccccccccc": HTTPException(status_code=504, detail="抓取字幕超时（超过 15 秒），请稍后再试。")},
    )
    report = module.backfill([curated_env[2]])
    assert report["byReason"] == {"timeout": 1}
    row = difficulty.get_row("curated", "ccccccccccc")
    assert row["cefrInput"] is None
    assert row["level"] == "A2"
    public = difficulty.payload_to_public(row)
    assert public["estimated"] is False
    assert public["bucket"] is None


def test_mixed_batch_and_idempotent(curated_env, monkeypatch):
    module = _load_script()
    _stub_fetch(
        monkeypatch,
        {
            "aaaaaaaaaaa": _success_transcript(),
            "bbbbbbbbbbb": HTTPException(status_code=422, detail="no subtitles"),
            "ccccccccccc": HTTPException(status_code=504, detail="timeout"),
        },
    )
    first = module.backfill(curated_env)
    assert first["total"] == 3
    assert first["computed"] == 1
    assert first["unavailable"] == 2
    assert first["written"] == 3

    second = module.backfill(curated_env)
    assert second["computed"] == 0
    # 两条失败条目仍标记 unavailable，但占位行未变化 → skipped、不重写。
    assert second["unavailable"] == 2
    assert second["skipped"] == 3
    assert second["written"] == 0


def test_dry_run_writes_nothing(curated_env, monkeypatch):
    module = _load_script()
    import difficulty

    _stub_fetch(monkeypatch, {"aaaaaaaaaaa": _success_transcript()})
    report = module.backfill([curated_env[0]], dry_run=True)
    assert report["computed"] == 1
    assert report["written"] == 0
    assert difficulty.get_row("curated", "aaaaaaaaaaa") is None


def test_auto_transcript_marks_syntax_unavailable(curated_env, monkeypatch):
    module = _load_script()
    import difficulty

    transcript = _success_transcript()
    transcript.subtitle_source = "auto"
    _stub_fetch(monkeypatch, {"aaaaaaaaaaa": transcript})
    report = module.backfill([curated_env[0]])
    assert report["computed"] == 1
    row = difficulty.get_row("curated", "aaaaaaaaaaa")
    assert row["support"]["subtitle"] == "auto"
    assert row["features"]["available"]["asl"] is False
    assert row["features"]["available"]["wpm"] is True


def test_rate_limited_is_reported(curated_env, monkeypatch):
    module = _load_script()
    _stub_fetch(
        monkeypatch,
        {"bbbbbbbbbbb": HTTPException(status_code=429, detail="YouTube 暂时限制了当前 IP 的字幕请求。")},
    )
    report = module.backfill([curated_env[1]])
    assert report["byReason"] == {"rate_limited": 1}
    assert report["items"][0]["available"] is False


def test_transcript_blocks_ignore_empty_text():
    module = _load_script()
    blocks = module.transcript_blocks(
        [
            _Snippet("Hello world.", 1.0, 2.0),
            _Snippet("   ", 3.0, 1.0),
        ]
    )
    assert blocks == [{"start": 1.0, "end": 3.0, "text": "Hello world."}]


def test_failure_keeps_existing_computed_row(curated_env, monkeypatch):
    """网络失败不能把已有可算行降级成占位行（自愈，不自毁）。"""
    module = _load_script()
    import difficulty

    _stub_fetch(monkeypatch, {"aaaaaaaaaaa": _success_transcript()})
    assert module.backfill([curated_env[0]])["computed"] == 1
    before = difficulty.get_row("curated", "aaaaaaaaaaa")
    assert before["cefrInput"]

    _stub_fetch(
        monkeypatch,
        {"aaaaaaaaaaa": HTTPException(status_code=429, detail="YouTube 暂时限制了当前 IP 的字幕请求。")},
    )
    report = module.backfill([curated_env[0]], refresh=True)
    assert report["kept"] == 1
    assert report["unavailable"] == 0
    assert report["written"] == 0
    assert report["keptReasons"] == {"rate_limited": 1}
    assert report["items"][0]["available"] is True
    after = difficulty.get_row("curated", "aaaaaaaaaaa")
    assert after["cefrInput"] == before["cefrInput"]


def test_thirty_curated_items_mixed_outcomes(curated_env, monkeypatch):
    """30 条 curated 批量 mock：20 成功 / 5 无字幕 / 5 超时。"""
    module = _load_script()
    items = [
        {
            "videoId": f"vid{index:08d}",
            "title": f"curated-{index}",
            "channel": "c",
            "duration": 300,
            "level": "B1",
        }
        for index in range(30)
    ]
    behaviours: dict[str, object] = {}
    for index in range(20):
        behaviours[f"vid{index:08d}"] = _success_transcript()
    for index in range(20, 25):
        behaviours[f"vid{index:08d}"] = HTTPException(status_code=422, detail="no subtitles")
    for index in range(25, 30):
        behaviours[f"vid{index:08d}"] = HTTPException(status_code=504, detail="timeout")
    _stub_fetch(monkeypatch, behaviours)

    report = module.backfill(items)
    assert report["total"] == 30
    assert report["computed"] == 20
    assert report["unavailable"] == 10
    assert report["written"] == 30
    assert report["byReason"] == {"no_english_subtitles": 5, "timeout": 5}
