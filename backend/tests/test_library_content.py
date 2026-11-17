"""免费视频扩容（3 → 55，A1–C2）内容验收。

覆盖：清单规模与唯一性、等级分布、真实 YouTube 元数据、可嵌入/时长/缩略图、
双语 blocks 的 id 对齐与时间轴、无视频文件入库、平均词数预算、字幕来源、
翻译 manifest（prompt/模型/时间/token/成本）、API 数量与等级分布，
以及 M2 难度行：非 C2 全部落库、C2 明确不建行。

全部离线：只读仓库内 JSON；难度用例在 tmp 迁移库上重算，不碰 data/app.db。
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from pathlib import Path

import pytest

import config
import difficulty
import routes_library
from tests.migration_utils import assert_alembic_ok, run_alembic

REPO_ROOT = Path(__file__).resolve().parents[2]
LIBRARY_DIR = REPO_ROOT / "content" / "library"
VIDEO_DIR = LIBRARY_DIR / "videos"
MANIFEST_PATH = LIBRARY_DIR / "videos.json"
TRANSLATION_MANIFEST_PATH = LIBRARY_DIR / "translation-manifest.json"

VIDEO_MANIFEST = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
VIDEO_IDS = VIDEO_MANIFEST["videos"]
TRANSLATION_MANIFEST = json.loads(TRANSLATION_MANIFEST_PATH.read_text(encoding="utf-8"))
TRANSLATION_ITEMS = {item["id"]: item for item in TRANSLATION_MANIFEST["items"]}

LEVEL_TARGET = {"A1": 6, "A2": 10, "B1": 14, "B2": 12, "C1": 8, "C2": 5}
LEGACY_IDS = {
    "bbc-learning-different-generations",
    "teded-better-economy",
    "kurzgesagt-ai-slop",
}
AUTO_IDS = {
    "eci-stand-verb",
    "eci-cut-verb",
    "eci-play-verb",
    "eci-bob-wants-swim",
}
VIDEO_SUFFIXES = {".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi", ".flv", ".ts"}
WORD_RE = re.compile(r"[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*")
YOUTUBE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
DOMAIN_RE = re.compile(r"^(?:https?://)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:/\S*)?$", re.I)
ACRONYM_RE = re.compile(r"^[A-Z0-9][A-Z0-9.&/'-]*s?$")


@pytest.fixture(autouse=True)
def real_library(monkeypatch):
    monkeypatch.setattr(config, "LIBRARY_DIR", str(LIBRARY_DIR), raising=False)


def load_video(video_id: str) -> dict:
    return json.loads((VIDEO_DIR / f"{video_id}.json").read_text(encoding="utf-8"))


def words_of(video: dict) -> int:
    return sum(len(WORD_RE.findall(block["en_text"])) for block in video["blocks"])


def has_translatable_prose(text: str) -> bool:
    """HTTP 域名、纯缩写不算「必须译出中文」的正文。"""
    for token in re.split(r"\s+", text):
        word = token.strip(".,!?;:\"'()[]—–-…")
        if not word or word.isdigit() or ACRONYM_RE.match(word):
            continue
        if DOMAIN_RE.match(word) or "@" in word:
            continue
        if any(char.isalpha() for char in word):
            return True
    return False


# ---------------------------------------------------------------------------
# 1. 清单 / 等级分布
# ---------------------------------------------------------------------------

def test_video_manifest_is_expanded_and_unique():
    assert len(VIDEO_IDS) >= 50, "免费视频必须 ≥50"
    assert len(VIDEO_IDS) == len(set(VIDEO_IDS)), "id 不能重复"
    assert VIDEO_MANIFEST["_meta"]["count"] == len(VIDEO_IDS)
    assert all((VIDEO_DIR / f"{video_id}.json").is_file() for video_id in VIDEO_IDS)


def test_level_distribution_covers_all_cefr_bands():
    counts = {level: 0 for level in routes_library.LEVEL_ORDER}
    for video_id in VIDEO_IDS:
        counts[load_video(video_id)["level"]] += 1
    assert counts == LEVEL_TARGET
    # 每个等级都要有真实条目，不能只靠 manifest 里的空位凑数。
    assert all(count > 0 for count in counts.values())
    assert set(counts) == set(routes_library.LEVELS)


# ---------------------------------------------------------------------------
# 2. 真实 YouTube 元数据 / 双语 blocks
# ---------------------------------------------------------------------------

def test_every_video_has_real_youtube_metadata():
    for video_id in VIDEO_IDS:
        video = load_video(video_id)
        assert video["id"] == video_id
        assert YOUTUBE_ID_RE.fullmatch(video["youtubeId"]), video_id
        assert video["free"] is True and video["source"] == "youtube"
        assert video["title"].strip() and len(video["title"]) <= 300
        assert video["channel"].strip() and len(video["channel"]) <= 120
        assert isinstance(video["duration"], int)
        assert 180 <= video["duration"] <= 900, f"{video_id} 时长超出 3–15 分钟"
        assert video["level"] in routes_library.LEVELS
        thumbnail = video.get("thumbnail", "")
        assert re.match(r"^https://i\.ytimg\.com/vi(?:_webp)?/", thumbnail), video_id
        assert video["youtubeId"] in thumbnail
        assert video.get("subtitleSource") in {"manual", "auto"}


def test_blocks_are_bilingual_and_id_aligned():
    for video_id in VIDEO_IDS:
        video = load_video(video_id)
        blocks = video["blocks"]
        assert blocks, video_id
        assert [block["id"] for block in blocks] == list(range(1, len(blocks) + 1)), video_id
        for block in blocks:
            assert block["en_text"].strip(), (video_id, block["id"])
            assert block["zh_text"].strip(), (video_id, block["id"])
            assert block["zh_text"] != "[未翻译]", (video_id, block["id"])
            assert isinstance(block["highlights"], list)
            if has_translatable_prose(block["en_text"]):
                assert CJK.search(block["zh_text"]), (
                    f"{video_id} block {block['id']} 译文没有中文：{block['zh_text']}"
                )


def test_block_timeline_is_monotonic_and_covers_video():
    for video_id in VIDEO_IDS:
        video = load_video(video_id)
        blocks = video["blocks"]
        assert blocks[0]["start"] < 60, f"{video_id} 开头空太久"
        assert blocks[-1]["end"] >= video["duration"] * 0.8, f"{video_id} 字幕没覆盖到结尾"
        for index, block in enumerate(blocks):
            assert block["start"] >= 0
            assert block["end"] >= block["start"]
            if index:
                assert block["start"] >= blocks[index - 1]["start"], (video_id, index)


def test_no_video_files_are_checked_in():
    offenders = [
        str(path.relative_to(LIBRARY_DIR))
        for path in LIBRARY_DIR.rglob("*")
        if path.is_file() and path.suffix.lower() in VIDEO_SUFFIXES
    ]
    assert offenders == [], f"免费资源库不允许放视频文件：{offenders}"
    for video_id in VIDEO_IDS:
        video = load_video(video_id)
        assert "localVideoFile" not in video
        assert "videoFile" not in video
        assert "media" not in video


# ---------------------------------------------------------------------------
# 3. 词数预算 / 字幕来源 / 翻译 manifest
# ---------------------------------------------------------------------------

def test_average_english_words_stay_within_budget():
    totals = [words_of(load_video(video_id)) for video_id in VIDEO_IDS]
    assert max(totals) <= 4000
    average = sum(totals) / len(totals)
    assert average <= 1200, f"平均 {average:.1f} 词/视频，超过 1,200 的目标"


def test_subtitle_sources_are_declared():
    auto_ids = {video_id for video_id in VIDEO_IDS
                if load_video(video_id)["subtitleSource"] == "auto"}
    assert auto_ids == AUTO_IDS
    assert all(load_video(video_id)["level"] == "A1" for video_id in AUTO_IDS)
    manual = len(VIDEO_IDS) - len(auto_ids)
    assert manual >= 45, "人工字幕应占绝大多数"


def test_translation_manifest_covers_every_new_video():
    meta = TRANSLATION_MANIFEST["_meta"]
    prompt = TRANSLATION_MANIFEST["prompt"]
    assert hashlib.sha256(prompt.encode("utf-8")).hexdigest() == meta["promptSha256"]
    assert "{payload}" in prompt and "json" in prompt.lower()
    assert meta["model"] == "deepseek-chat" and meta["provider"] == "DeepSeek"
    datetime.fromisoformat(meta["generatedAt"])

    new_ids = set(VIDEO_IDS) - LEGACY_IDS
    manifest_ids = {item_id for item_id, item in TRANSLATION_ITEMS.items() if not item.get("legacy")}
    assert manifest_ids == new_ids
    total_input = total_output = total_words = 0
    for video_id in new_ids:
        item = TRANSLATION_ITEMS[video_id]
        video = load_video(video_id)
        assert item["blocks"] == len(video["blocks"])
        assert item["enWords"] == words_of(video)
        assert item["inputTokens"] > 0 and item["outputTokens"] > 0 and item["calls"] > 0
        assert item["promptVersion"] == meta["promptVersion"]
        datetime.fromisoformat(item["translatedAt"])
        total_input += item["inputTokens"]
        total_output += item["outputTokens"]
        total_words += item["enWords"]
    assert meta["usage"] == {"inputTokens": total_input, "outputTokens": total_output,
                             "calls": sum(item["calls"] for item in TRANSLATION_ITEMS.values()
                                         if not item.get("legacy"))}
    assert meta["totalEnglishWords"] == total_words
    assert total_words / len(new_ids) <= 1200
    assert meta["costEstimate"]["totalUsd"] > 0


def test_legacy_videos_are_labelled_not_rebilled():
    for video_id in LEGACY_IDS:
        assert TRANSLATION_ITEMS[video_id]["legacy"] is True
        assert TRANSLATION_ITEMS[video_id]["blocks"] == len(load_video(video_id)["blocks"])


# ---------------------------------------------------------------------------
# 4. API：数量与等级分布
# ---------------------------------------------------------------------------

def test_library_api_exposes_counts_and_level_distribution(make_client):
    with make_client() as client:
        payload = client.get("/api/library").json()
    assert payload["counts"]["videos"] == len(payload["videos"]) == 55
    assert payload["counts"]["articles"] == len(payload["articles"]) == 67
    assert payload["videoLevels"] == LEVEL_TARGET
    for video in payload["videos"]:
        assert video["level"] in routes_library.LEVELS
        assert 180 <= video["duration"] <= 900


def test_api_serves_new_videos_with_bilingual_blocks(make_client):
    samples = ["eci-play-verb", "ted-next-outbreak", "ted-addiction-wrong"]
    with make_client() as client:
        for video_id in samples:
            response = client.get(f"/api/library/videos/{video_id}")
            assert response.status_code == 200, (video_id, response.text)
            payload = response.json()
            assert payload["id"] == video_id
            assert payload["youtubeId"]
            assert payload["subtitleSource"] in {"manual", "auto"}
            blocks = payload["blocks"]
            assert len(blocks) >= 60
            assert all(block["en_text"].strip() and block["zh_text"].strip() for block in blocks)
            assert all(CJK.search(block["zh_text"]) for block in blocks if has_translatable_prose(block["en_text"]))


# ---------------------------------------------------------------------------
# 5. M2 难度：非 C2 落库，C2 回退编辑等级
# ---------------------------------------------------------------------------

def test_difficulty_rows_exist_for_non_c2_videos_only(client):
    """在 tmp 迁移库上重算 50 条非 C2 视频；C2 明确不建行（回退编辑等级）。"""
    assert_alembic_ok(run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head")
    non_c2 = [video_id for video_id in VIDEO_IDS if load_video(video_id)["level"] != "C2"]
    c2 = [video_id for video_id in VIDEO_IDS if load_video(video_id)["level"] == "C2"]
    assert len(non_c2) == 50 and len(c2) == 5

    for video_id in non_c2:
        payload = difficulty.recompute("video", video_id)
        assert payload["ref"] == video_id
        assert payload["kind"] == "video"
        assert payload["cefrInput"], f"{video_id} 缺少计算结果"

    rows = difficulty.get_rows([("video", video_id) for video_id in non_c2])
    assert len(rows) == len(non_c2)
    for video_id in non_c2:
        row = rows[("video", video_id)]
        assert row["level"] == load_video(video_id)["level"]
        assert row["cefrInput"]
    for video_id in c2:
        assert difficulty.get_row("video", video_id) is None
