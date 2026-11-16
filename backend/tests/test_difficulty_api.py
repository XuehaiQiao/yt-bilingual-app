"""内容难度 API 离线验收（M2，计划书 §7.4 / specs/026）。

覆盖：单条 computed/legacy 回退、404/400、公开缓存头与游客 Cookie、
批量 ≤50、band→utrBand/bucket、admin recompute 鉴权与幂等、未迁移回退。
全部离线：tmp 数据库 + tmp content/ 副本。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import config
import difficulty
from tests.conftest import TEST_USER_EMAIL
from tests.migration_utils import assert_alembic_ok, run_alembic

VIDEO_ID = "test-video"
ARTICLE_ID = "test-article"
CURATED_ID = "abcdefghijk"


def _write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


@pytest.fixture()
def migrated(client):
    assert_alembic_ok(run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head")
    return client


@pytest.fixture()
def difficulty_env(migrated, tmp_path, monkeypatch):
    """tmp content/（1 视频 + 1 文章 + 1 curated + 字幕缓存）+ 已迁移 DB。"""
    library = tmp_path / "library"
    _write(
        library / "videos.json",
        {"_meta": {"version": 1, "count": 1}, "videos": [VIDEO_ID]},
    )
    blocks = [
        {
            "id": index + 1,
            "start": index * 10.0,
            "end": (index + 1) * 10.0,
            "en_text": text,
            "zh_text": "译文",
        }
        for index, text in enumerate(
            [
                "The family walked to the market and bought fresh bread.",
                "My sister likes to read books about life in small towns.",
                "We visited our parents and had dinner together last week.",
                "The children played in the garden until the sun went down.",
                "It was a good day for the whole family and we felt happy.",
                "Tomorrow we will go back and bring some food for them.",
            ]
        )
    ]
    _write(
        library / "videos" / f"{VIDEO_ID}.json",
        {
            "id": VIDEO_ID,
            "youtubeId": "h-NZcQF7jgI",
            "title": "Test video",
            "channel": "Test channel",
            "duration": 60,
            "level": "B1",
            "free": True,
            "source": "youtube",
            "subtitleSource": "manual",
            "blocks": blocks,
        },
    )
    _write(
        library / "articles.json",
        {"_meta": {"version": 1, "count": 1}, "articles": [ARTICLE_ID]},
    )
    _write(
        library / "articles" / f"{ARTICLE_ID}.json",
        {
            "id": ARTICLE_ID,
            "title": "Test article",
            "level": "A2",
            "wordCount": 40,
            "author": "LinguaTrek 编辑部",
            "license": "原创，免费使用",
            "paragraphs": [
                {"en": "My sister lives in a small town near the river.", "zh": "我妹妹住在河边的小镇。"},
                {"en": "Every morning she walks to the market and buys fresh bread.", "zh": "她每天早上去市场买面包。"},
            ],
        },
    )
    curated_path = tmp_path / "curated.json"
    _write(
        curated_path,
        {
            "_meta": {"notice": "人工精选草稿，待运营复核", "count": 1},
            "items": [
                {
                    "videoId": CURATED_ID,
                    "title": "Curated video",
                    "channel": "Channel",
                    "duration": 300,
                    "thumbnail": f"https://i.ytimg.com/vi/{CURATED_ID}/hqdefault.jpg",
                    "topic": "technology",
                    "level": "B2",
                    "publishedAt": "2024-01-01",
                    "reason": "测试",
                }
            ],
        },
    )
    subtitles = tmp_path / "curated-subtitles"
    _write(
        subtitles / f"{CURATED_ID}.json",
        {
            "videoId": CURATED_ID,
            "subtitleSource": "manual",
            "duration": 300,
            "blocks": blocks,
        },
    )
    monkeypatch.setattr(config, "LIBRARY_DIR", str(library), raising=False)
    monkeypatch.setattr(config, "CURATED_CONTENT_PATH", str(curated_path), raising=False)
    monkeypatch.setattr(config, "CURATED_SUBTITLES_DIR", str(subtitles), raising=False)
    return migrated


def _recommend_admin_env(monkeypatch, admin: bool = True):
    monkeypatch.setattr(
        config,
        "ADMIN_EMAILS",
        frozenset({TEST_USER_EMAIL}) if admin else frozenset(),
        raising=False,
    )


# ---------------------------------------------------------------------------
# 单条
# ---------------------------------------------------------------------------

def test_legacy_fallback_before_backfill(difficulty_env):
    response = difficulty_env.get(f"/api/content/difficulty?kind=video&ref={VIDEO_ID}")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["source"] == "legacy"
    assert payload["level"] == "B1"
    assert payload["cefrInput"] is None
    assert payload["features"] is None
    assert payload["estimated"] is False
    assert response.headers["cache-control"] == "public, max-age=3600"


def test_computed_payload_after_recompute(difficulty_env):
    first = difficulty.recompute("video", VIDEO_ID)
    assert first["cefrInput"] in {"A2", "B1", "B2"}

    response = difficulty_env.get(
        f"/api/content/difficulty?kind=video&ref={VIDEO_ID}&band=A2"
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["source"] == "computed"
    assert payload["schema"] == "difficulty.v1"
    assert payload["version"] == "v1"
    assert payload["method"] == "rule"
    assert payload["features"]["schema"] == "difficulty.v1"
    assert payload["features"]["support"]["subtitle"] == "human"
    assert payload["support"]["subtitle"] == "human"
    assert payload["cefrInput"] == first["cefrInput"]
    assert payload["utrBand"] is not None
    assert payload["bucket"] in {"<1%", "1–3%", "3–5%", "5–8%", ">8%"}
    assert payload["estimated"] is True


def test_article_computed_has_text_support(difficulty_env):
    difficulty.recompute("article", ARTICLE_ID)
    payload = difficulty_env.get(
        f"/api/content/difficulty?kind=article&ref={ARTICLE_ID}"
    ).json()
    assert payload["source"] == "computed"
    assert payload["cefrInput"] is not None
    assert payload["features"]["kind"] == "article"
    assert payload["support"]["subtitle"] == "none"
    assert payload["support"]["text"] is True


def test_curated_computed(difficulty_env):
    difficulty.recompute("curated", CURATED_ID)
    payload = difficulty_env.get(
        f"/api/content/difficulty?kind=curated&ref={CURATED_ID}"
    ).json()
    assert payload["source"] == "computed"
    assert payload["features"]["kind"] == "video"
    assert payload["features"]["speed"]["wpm"] == 66


def test_missing_content_404(difficulty_env):
    response = difficulty_env.get("/api/content/difficulty?kind=video&ref=nope")
    assert response.status_code == 404


@pytest.mark.parametrize(
    "query",
    [
        "kind=podcast&ref=x",
        "kind=video&ref=",
        "kind=video&ref=test-video&band=Z9",
    ],
)
def test_invalid_params_400(difficulty_env, query):
    response = difficulty_env.get(f"/api/content/difficulty?{query}")
    assert response.status_code == 400


def test_legacy_fallback_when_table_missing(make_client):
    """库没迁移也要回退旧 level，不 503（计划书 §7.3）。"""
    with make_client() as anonymous:
        response = anonymous.get("/api/content/difficulty?kind=article&ref=ocean-noise")
        assert response.status_code == 200
        payload = response.json()
        assert payload["source"] == "legacy"
        assert payload["level"] == "B1"


# ---------------------------------------------------------------------------
# 批量 / 公开路径
# ---------------------------------------------------------------------------

def test_batch_returns_all_items(difficulty_env):
    difficulty.recompute("video", VIDEO_ID)
    difficulty.recompute("article", ARTICLE_ID)
    response = difficulty_env.get(
        "/api/content/difficulty/batch"
        f"?items=video:{VIDEO_ID},article:{ARTICLE_ID}&band=A2"
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["schema"] == "difficulty.v1"
    assert len(payload["items"]) == 2
    assert {item["kind"] for item in payload["items"]} == {"video", "article"}
    for item in payload["items"]:
        assert item["utrBand"] is not None
        assert item["bucket"]
    assert response.headers["cache-control"] == "public, max-age=3600"


def test_batch_repeated_query_items_supported(difficulty_env):
    response = difficulty_env.get(
        "/api/content/difficulty/batch",
        params=[("items", f"video:{VIDEO_ID}"), ("items", f"article:{ARTICLE_ID}")],
    )
    assert response.status_code == 200
    assert len(response.json()["items"]) == 2


def test_batch_limit_and_missing(difficulty_env):
    too_many = ",".join([f"video:{VIDEO_ID}"] * 51)
    assert difficulty_env.get(
        "/api/content/difficulty/batch", params={"items": too_many}
    ).status_code == 400

    response = difficulty_env.get(
        "/api/content/difficulty/batch", params={"items": "video:nope"}
    )
    assert response.status_code == 404


def test_public_endpoint_does_not_issue_guest_cookie(make_client):
    with make_client() as anonymous:
        response = anonymous.get(
            "/api/content/difficulty?kind=article&ref=ocean-noise"
        )
        assert response.status_code == 200
        cookies = ";".join(response.headers.get_list("set-cookie"))
        assert "ln_guest" not in cookies


# ---------------------------------------------------------------------------
# 管理员重算
# ---------------------------------------------------------------------------

def test_admin_recompute_requires_admin(difficulty_env, monkeypatch, make_client):
    body = {"items": [{"kind": "video", "ref": VIDEO_ID}]}
    _recommend_admin_env(monkeypatch, admin=False)
    response = difficulty_env.post("/api/admin/content-difficulty/recompute", json=body)
    assert response.status_code == 403

    with make_client() as anonymous:
        unauth = anonymous.post(
            "/api/admin/content-difficulty/recompute", json=body
        )
        assert unauth.status_code == 401


def test_admin_recompute_success_and_idempotent(difficulty_env, monkeypatch):
    _recommend_admin_env(monkeypatch, admin=True)
    body = {"items": [{"kind": "video", "ref": VIDEO_ID}, {"kind": "curated", "ref": CURATED_ID}]}
    first = difficulty_env.post("/api/admin/content-difficulty/recompute", json=body)
    assert first.status_code == 200, first.text
    payload = first.json()
    assert payload["counts"]["computed"] == 2
    assert all(item["status"] == "computed" for item in payload["results"])

    second = difficulty_env.post("/api/admin/content-difficulty/recompute", json=body)
    assert second.status_code == 200
    assert second.json()["counts"]["computed"] == 2

    single_missing = difficulty_env.post(
        "/api/admin/content-difficulty/recompute",
        json={"kind": "video", "ref": "nope"},
    )
    assert single_missing.status_code == 404


