"""回填脚本离线验收（M2，计划书 §7.3 / specs/026）。

覆盖：serving + curated 字幕缓存的枚举、幂等 upsert、报告字段、
缺字幕时失败原因（不静默跳过）。全部在 tmp content/ + tmp DB 下跑。
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

import config
from tests.migration_utils import assert_alembic_ok, run_alembic

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "backfill_content_difficulty.py"


def _load_script():
    spec = importlib.util.spec_from_file_location("backfill_content_difficulty", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _blocks() -> list[dict]:
    return [
        {"start": index * 10.0, "end": (index + 1) * 10.0, "text": text, "en_text": text}
        for index, text in enumerate(
            [
                "The family walked to the market and bought fresh bread.",
                "My sister likes to read books about life in small towns.",
                "We visited our parents and had dinner together last week.",
            ]
        )
    ]


@pytest.fixture()
def backfill_env(client, tmp_path, monkeypatch):
    assert_alembic_ok(run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head")
    library = tmp_path / "library"
    _write(
        library / "videos.json",
        {"_meta": {"version": 1, "count": 2}, "videos": ["video-a", "video-b"]},
    )
    for video_id in ("video-a", "video-b"):
        _write(
            library / "videos" / f"{video_id}.json",
            {
                "id": video_id,
                "title": video_id,
                "duration": 30,
                "level": "B1",
                "subtitleSource": "manual",
                "blocks": _blocks(),
            },
        )
    _write(
        library / "articles.json",
        {"_meta": {"version": 1, "count": 2}, "articles": ["article-a", "article-b"]},
    )
    for article_id in ("article-a", "article-b"):
        _write(
            library / "articles" / f"{article_id}.json",
            {
                "id": article_id,
                "title": article_id,
                "level": "A2",
                "paragraphs": [
                    {"en": "My sister lives in a small town near the river.", "zh": "译文"},
                    {"en": "Every morning she walks to the market and buys bread.", "zh": "译文"},
                ],
            },
        )
    curated = {
        "_meta": {"notice": "人工精选草稿，待运营复核", "count": 2},
        "items": [
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
        ],
    }
    _write(tmp_path / "curated.json", curated)
    subtitles = tmp_path / "curated-subtitles"
    _write(
        subtitles / "aaaaaaaaaaa.json",
        {
            "videoId": "aaaaaaaaaaa",
            "subtitleSource": "manual",
            "blocks": _blocks(),
        },
    )
    # bbbbbbbbbbb 故意缺字幕缓存 → 报告里必须出现失败原因。
    monkeypatch.setattr(config, "LIBRARY_DIR", str(library), raising=False)
    monkeypatch.setattr(config, "CURATED_CONTENT_PATH", str(tmp_path / "curated.json"), raising=False)
    monkeypatch.setattr(config, "CURATED_SUBTITLES_DIR", str(subtitles), raising=False)
    return client


def test_enumerates_serving_and_curated(backfill_env):
    module = _load_script()
    serving = module.serving_items()
    curated = module.curated_items()
    assert len(serving) == 4  # 2 视频 + 2 文章
    assert len(curated) == 2
    assert {kind for kind, _ref in serving} == {"video", "article"}


def test_backfill_is_idempotent_and_reports_failures(backfill_env, tmp_path):
    module = _load_script()
    items = module.serving_items() + module.curated_items()
    first = module.backfill(items)
    assert first["total"] == 6
    assert first["computed"] == 5
    assert first["failed"] == 1
    assert first["written"] == 5
    assert first["coverage"] == pytest.approx(5 / 6, abs=0.001)
    failure = first["failures"][0]
    assert failure["ref"] == "bbbbbbbbbbb"
    assert "字幕" in failure["error"]
    assert first["byBand"]

    second = module.backfill(items)
    assert second["computed"] == 0
    assert second["skipped"] == 5
    assert second["failed"] == 1
    assert second["written"] == 0


def test_cli_writes_report_and_returns_nonzero_on_failure(backfill_env, tmp_path):
    module = _load_script()
    report_path = tmp_path / "report.json"
    code = module.main(["--report", str(report_path)])
    assert code == 1  # 有 1 条失败
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["total"] == 6
    assert report["coverage"] > 0.8
    assert report["schema"] == "content-difficulty-backfill.v1"
    assert report["items"]
    assert report["failures"]

    # 第二次跑：幂等，仍然只写报告、不重复插入。
    code = module.main(["--report", str(report_path)])
    assert code == 1
    second = json.loads(report_path.read_text(encoding="utf-8"))
    assert second["skipped"] == 5
