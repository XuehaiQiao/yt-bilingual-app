"""本地免费资源库离线验收（用户需求 #11）。

覆盖：

1. 公开可访问：未登录 GET 清单 / 视频详情 / 文章详情均 200，且不新发游客 Cookie；
2. 清单形状：3 个视频 + 3 篇原创 + 64 篇 Gutenberg 公版短文、字段齐全、
   时长 3–20 分钟、等级 A1–C2；
3. 视频详情：真实 youtubeId、free/source 标记、双语 blocks（en/zh 均非空）、高亮数组；
4. 文章详情：原创作者/许可、逐段 en+zh、词数 250–350 且由后端实算；
   Gutenberg 文章另验来源/链接/PD 依据、250–400 词、自译中文；
5. 缓存头：清单 300 秒、详情 3600 秒；
6. 404：未知 id、非法 id、缺失条目文件；503：目录/清单缺失、条目损坏；
7. 零 LLM/零处理管线：模块源码不 import llm、不连数据库，请求期间 LLM 无调用。

全部离线：只读仓库内 JSON 或 tmp 副本，不碰数据库、不联网。
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import pytest

import config
import llm
import routes_library

REPO_ROOT = Path(__file__).resolve().parents[2]
LIBRARY_DIR = REPO_ROOT / "content" / "library"
VIDEO_MANIFEST = json.loads((LIBRARY_DIR / "videos.json").read_text(encoding="utf-8"))
EXPECTED_VIDEO_IDS = set(VIDEO_MANIFEST["videos"])
EXPECTED_VIDEO_LEVELS = {"A1": 6, "A2": 10, "B1": 14, "B2": 12, "C1": 8, "C2": 5}
EXPECTED_ARTICLE_IDS = {
    "ocean-noise",
    "free-app-hidden-cost",
    "case-for-doing-nothing",
}
GUTENBERG_MANIFEST = LIBRARY_DIR / "gutenberg-manifest.json"
GUTENBERG_ARTICLE_IDS = {
    item["id"] for item in json.loads(GUTENBERG_MANIFEST.read_text(encoding="utf-8"))["items"]
}
# 2026-11-17 第二轮内容供给新增的 30 篇（Aesop / Jataka / 短寓言）。
NEW_GUTENBERG_ARTICLE_IDS = {
    "pg-the-mice-in-council",
    "pg-the-fox-and-the-goat",
    "pg-the-mouse-the-frog-and-the-hawk",
    "pg-the-shepherds-boy-and-the-wolf",
    "pg-the-two-frogs",
    "pg-the-lion-and-the-mouse",
    "pg-the-mouse-the-cat-and-the-cock",
    "pg-the-arab-and-his-camel",
    "pg-the-fox-who-had-lost-his-tail",
    "pg-the-man-his-son-and-his-donkey",
    "pg-the-wolf-and-the-cat",
    "pg-the-fox-in-the-ice",
    "pg-the-hares-and-the-frogs",
    "pg-the-three-fishes",
    "pg-the-tricky-wolf-and-the-rats",
    "pg-the-golden-goose",
    "pg-the-stupid-monkeys",
    "pg-the-cunning-wolf",
    "pg-the-red-bud-tree",
    "pg-the-woodpecker-and-the-lion",
    "pg-the-otters-and-the-wolf",
    "pg-beauty-and-brownie",
    "pg-the-caliph-and-the-poet",
    "pg-read-and-you-will-know",
    "pg-which-was-the-king",
    "pg-the-golden-arm",
    "pg-the-turtle-who-couldnt-stop-talking",
    "pg-the-fox-and-the-crow",
    "pg-news",
    "pg-the-eagle-and-the-fox",
}
WORD_RE = re.compile(r"[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*")


@pytest.fixture(autouse=True)
def repo_library(monkeypatch):
    """默认读仓库内真实资源；单个用例可覆盖 LIBRARY_DIR 验证异常分支。"""
    monkeypatch.setattr(config, "LIBRARY_DIR", str(LIBRARY_DIR), raising=False)


def _copy_library(tmp_path: Path) -> Path:
    target = tmp_path / "library"
    shutil.copytree(LIBRARY_DIR, target)
    return target


# ---------------------------------------------------------------------------
# 1. 公开可访问
# ---------------------------------------------------------------------------

def test_library_is_public_and_does_not_issue_guest_cookie(make_client):
    with make_client() as client:
        for path in (
            "/api/library",
            "/api/library/videos/bbc-learning-different-generations",
            "/api/library/articles/ocean-noise",
        ):
            response = client.get(path)
            assert response.status_code == 200, (path, response.text)
            assert "ln_guest" not in response.headers.get("set-cookie", "")


# ---------------------------------------------------------------------------
# 2. 清单形状
# ---------------------------------------------------------------------------

def test_index_lists_expanded_video_catalog_and_all_articles(make_client):
    with make_client() as client:
        response = client.get("/api/library")
    assert response.status_code == 200
    payload = response.json()
    videos = payload["videos"]
    articles = payload["articles"]

    # 扩容后：55 条视频（A1–C2），清单与文件一一对应。
    assert len(videos) == 55
    assert VIDEO_MANIFEST["_meta"]["count"] == len(videos)
    assert {video["id"] for video in videos} == EXPECTED_VIDEO_IDS
    assert all(
        {"id", "title", "channel", "duration", "level"} <= set(video)
        for video in videos
    )
    assert all(180 <= video["duration"] <= 900 for video in videos)
    assert all(video["level"] in routes_library.LEVELS for video in videos)
    level_counts = {level: 0 for level in routes_library.LEVEL_ORDER}
    for video in videos:
        level_counts[video["level"]] += 1
    assert level_counts == EXPECTED_VIDEO_LEVELS
    # 服务端同时返回数量与等级分布（前端 chips 直接显示）。
    assert payload["counts"] == {"videos": 55, "articles": 67}
    assert payload["videoLevels"] == EXPECTED_VIDEO_LEVELS

    assert len(articles) == 3 + len(GUTENBERG_ARTICLE_IDS) == 67
    ids = {article["id"] for article in articles}
    assert ids == EXPECTED_ARTICLE_IDS | GUTENBERG_ARTICLE_IDS
    assert all(
        {"id", "title", "level", "wordCount"} <= set(article) for article in articles
    )
    assert all(article["level"] in routes_library.LEVELS for article in articles)
    for article in articles:
        if article["id"] in EXPECTED_ARTICLE_IDS:
            assert 250 <= article["wordCount"] <= 350
        else:
            assert 250 <= article["wordCount"] <= 400


# ---------------------------------------------------------------------------
# 3. 视频详情 + 双语字幕
# ---------------------------------------------------------------------------

def test_video_detail_has_bilingual_blocks(make_client):
    with make_client() as client:
        for video_id in EXPECTED_VIDEO_IDS:
            response = client.get(f"/api/library/videos/{video_id}")
            assert response.status_code == 200, (video_id, response.text)
            payload = response.json()
            assert payload["id"] == video_id
            assert len(payload["youtubeId"]) == 11
            assert payload["free"] is True
            assert payload["source"] == "youtube"
            assert 180 <= payload["duration"] <= 1200
            blocks = payload["blocks"]
            assert len(blocks) >= 20
            assert all(
                {"id", "start", "end", "en_text", "zh_text", "highlights"} <= set(block)
                for block in blocks
            )
            assert all(block["en_text"].strip() for block in blocks)
            assert all(block["zh_text"].strip() for block in blocks)
            assert all(isinstance(block["highlights"], list) for block in blocks)
            assert all(block["end"] >= block["start"] >= 0 for block in blocks)
            # 时间轴单调；TED-Ed 等视频有片头留白，字幕覆盖 80% 以上即视为完整。
            assert blocks[0]["start"] < 60
            assert blocks[-1]["end"] >= payload["duration"] * 0.8
            assert all(
                blocks[index + 1]["start"] >= blocks[index]["start"]
                for index in range(len(blocks) - 1)
            )


def test_highlight_shape_is_stable(make_client):
    with make_client() as client:
        payload = client.get("/api/library/videos/kurzgesagt-ai-slop").json()
    highlighted = [block for block in payload["blocks"] if block["highlights"]]
    assert highlighted, "至少一个视频应保留可点击高亮，证明结构完整"
    for block in highlighted:
        for item in block["highlights"]:
            assert set(item) == {"en_word", "zh_word", "color"}
            assert item["en_word"] and item["zh_word"] and item["color"]


# ---------------------------------------------------------------------------
# 4. 文章详情（原创 + 译文）
# ---------------------------------------------------------------------------

def test_article_detail_is_original_bilingual_and_counted(make_client):
    topics = set()
    with make_client() as client:
        for article_id in EXPECTED_ARTICLE_IDS:
            response = client.get(f"/api/library/articles/{article_id}")
            assert response.status_code == 200, (article_id, response.text)
            payload = response.json()
            assert payload["id"] == article_id
            assert payload["author"] == "LinguaTrek 编辑部"
            assert payload["license"] == "原创，免费使用"
            assert payload["level"] in routes_library.LEVELS
            paragraphs = payload["paragraphs"]
            assert len(paragraphs) >= 3
            assert all(set(paragraph) == {"en", "zh"} for paragraph in paragraphs)
            assert all(paragraph["en"].strip() for paragraph in paragraphs)
            assert all(paragraph["zh"].strip() for paragraph in paragraphs)
            actual = sum(len(WORD_RE.findall(paragraph["en"])) for paragraph in paragraphs)
            assert payload["wordCount"] == actual
            assert 250 <= actual <= 350
            topics.add(payload.get("topic"))
    assert topics == {"science", "technology", "life"}


def test_article_api_level_is_editorial_not_computed(make_client):
    """P2-46：``/api/library`` 的 level 永远来自内容 JSON 的编辑级。

    算法级 cefrInput 只由 ``/api/content/difficulty`` 提供；即使本地库已有
    ``free-app-hidden-cost`` 的 B1 算法行，文章详情也必须返回编辑级 B2，
    否则前端无法区分「编辑级」与「算法级」两套口径。
    """
    article_id = "free-app-hidden-cost"
    source = json.loads(
        (LIBRARY_DIR / "articles" / f"{article_id}.json").read_text(encoding="utf-8")
    )
    with make_client() as client:
        detail = client.get(f"/api/library/articles/{article_id}").json()
        index = client.get("/api/library").json()
    assert detail["level"] == source["level"]
    assert "cefrInput" not in detail
    summary = next(article for article in index["articles"] if article["id"] == article_id)
    assert summary["level"] == source["level"]


def test_gutenberg_articles_have_provenance_and_own_translation(make_client):
    manifest = json.loads(GUTENBERG_MANIFEST.read_text(encoding="utf-8"))
    items = manifest["items"]
    assert len(items) == 64
    assert len({item["id"] for item in items}) == 64
    assert len({item["gutenbergId"] for item in items}) == 8  # +49010/7518/62514

    with make_client() as client:
        for item in items:
            response = client.get(f"/api/library/articles/{item['id']}")
            assert response.status_code == 200, (item["id"], response.text)
            payload = response.json()
            assert payload["source"] == "public-domain"
            assert payload["gutenbergId"] == item["gutenbergId"]
            assert payload["sourceUrl"] == item["sourceUrl"]
            assert payload["sourceUrl"].startswith("https://www.gutenberg.org/ebooks/")
            assert payload["publicDomainBasis"]
            assert payload["author"]
            assert "Project Gutenberg" in payload["license"]
            assert payload["level"] in routes_library.LEVELS
            paragraphs = payload["paragraphs"]
            assert len(paragraphs) >= 2
            assert all(p["en"].strip() and p["zh"].strip() for p in paragraphs)
            actual = sum(len(WORD_RE.findall(p["en"])) for p in paragraphs)
            assert payload["wordCount"] == actual
            assert 250 <= actual <= 400


def test_second_wave_adds_thirty_new_gutenberg_articles(make_client):
    """第二轮 30 篇：清单/文件/来源字段/双语/250–400 词全部到位且不重复旧篇。"""
    manifest = json.loads(GUTENBERG_MANIFEST.read_text(encoding="utf-8"))
    items = {item["id"]: item for item in manifest["items"]}
    assert len(NEW_GUTENBERG_ARTICLE_IDS) == 30
    assert NEW_GUTENBERG_ARTICLE_IDS <= set(items)
    assert not (NEW_GUTENBERG_ARTICLE_IDS & EXPECTED_ARTICLE_IDS)
    # 新增篇目来自本轮补充的三本书 + 既有书中此前未选的短篇。
    new_books = {6168, 7439, 14241, 49010, 7518, 62514}
    assert {
        items[article_id]["gutenbergId"] for article_id in NEW_GUTENBERG_ARTICLE_IDS
    } <= new_books

    with make_client() as client:
        for article_id in NEW_GUTENBERG_ARTICLE_IDS:
            payload = client.get(f"/api/library/articles/{article_id}").json()
            assert payload["source"] == "public-domain"
            assert payload["gutenbergId"] in new_books
            assert payload["publicDomainBasis"].strip()
            assert payload["license"].startswith("Public domain (Project Gutenberg #")
            paragraphs = payload["paragraphs"]
            assert len(paragraphs) >= 2
            assert all(paragraph["en"].strip() and paragraph["zh"].strip() for paragraph in paragraphs)
            actual = sum(len(WORD_RE.findall(paragraph["en"])) for paragraph in paragraphs)
            assert payload["wordCount"] == actual
            assert 250 <= actual <= 400


def test_articles_manifest_matches_files():
    data = json.loads((LIBRARY_DIR / "articles.json").read_text(encoding="utf-8"))
    ids = data["articles"]
    assert data["_meta"]["count"] == len(ids) == 67
    assert len(set(ids)) == len(ids)
    for article_id in ids:
        assert (LIBRARY_DIR / "articles" / f"{article_id}.json").is_file(), article_id


# ---------------------------------------------------------------------------
# 5. 缓存头
# ---------------------------------------------------------------------------

def test_cache_control_headers(make_client):
    with make_client() as client:
        index = client.get("/api/library")
        video = client.get("/api/library/videos/teded-better-economy")
        article = client.get("/api/library/articles/ocean-noise")
    assert "max-age=300" in index.headers.get("cache-control", "")
    assert "max-age=3600" in video.headers.get("cache-control", "")
    assert "max-age=3600" in article.headers.get("cache-control", "")


# ---------------------------------------------------------------------------
# 6. 404 / 503
# ---------------------------------------------------------------------------

def test_unknown_and_invalid_ids_are_404(make_client):
    with make_client() as client:
        for path in (
            "/api/library/videos/does-not-exist",
            "/api/library/videos/UPPER-CASE",
            "/api/library/videos/../README",
            "/api/library/articles/does-not-exist",
            "/api/library/articles/ocean-noise-extra",
        ):
            response = client.get(path)
            assert response.status_code == 404, (path, response.text)


def test_missing_entry_file_is_404(monkeypatch, tmp_path, make_client):
    directory = _copy_library(tmp_path)
    (directory / "videos" / "teded-better-economy.json").unlink()
    monkeypatch.setattr(config, "LIBRARY_DIR", str(directory), raising=False)
    with make_client() as client:
        assert client.get("/api/library/videos/teded-better-economy").status_code == 404
        # 清单引用了缺失文件：宁可报错，也不悄悄少一条。
        assert client.get("/api/library").status_code == 404


def test_missing_directory_is_503(tmp_path, monkeypatch, make_client):
    monkeypatch.setattr(config, "LIBRARY_DIR", str(tmp_path / "nope"), raising=False)
    with make_client() as client:
        assert client.get("/api/library").status_code == 503
        assert (
            client.get("/api/library/videos/bbc-learning-different-generations").status_code
            == 404
        )


def test_corrupt_entry_is_503(monkeypatch, tmp_path, make_client):
    directory = _copy_library(tmp_path)
    (directory / "videos" / "teded-better-economy.json").write_text(
        "{ not json", encoding="utf-8"
    )
    monkeypatch.setattr(config, "LIBRARY_DIR", str(directory), raising=False)
    with make_client() as client:
        assert client.get("/api/library").status_code == 503
        assert client.get("/api/library/videos/teded-better-economy").status_code == 503


def test_bad_fields_are_503(monkeypatch, tmp_path, make_client):
    directory = _copy_library(tmp_path)
    path = directory / "videos" / "teded-better-economy.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["blocks"][0]["zh_text"] = ""
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(config, "LIBRARY_DIR", str(directory), raising=False)
    with make_client() as client:
        assert client.get("/api/library/videos/teded-better-economy").status_code == 503
        assert client.get("/api/library").status_code == 503


# ---------------------------------------------------------------------------
# 7. 零 LLM / 零处理管线
# ---------------------------------------------------------------------------

def test_requests_never_call_llm(monkeypatch, make_client):
    calls: list[str] = []

    def _record(*args, **kwargs):
        calls.append("llm")
        raise AssertionError("免费资源库不允许调用 LLM")

    async def _record_async(*args, **kwargs):
        calls.append("llm")
        raise AssertionError("免费资源库不允许调用 LLM")

    monkeypatch.setattr(llm, "generate_text", _record)
    monkeypatch.setattr(llm, "generate_json", _record)
    monkeypatch.setattr(llm, "generate_text_async", _record_async)
    monkeypatch.setattr(llm, "generate_json_async", _record_async)

    with make_client() as client:
        assert client.get("/api/library").status_code == 200
        assert client.get(
            "/api/library/videos/bbc-learning-different-generations"
        ).status_code == 200
        assert client.get("/api/library/articles/free-app-hidden-cost").status_code == 200
    assert calls == []


def test_module_has_no_llm_or_database_dependency():
    source = Path(routes_library.__file__).read_text(encoding="utf-8")
    for forbidden in ("import llm", "import sqlite3", "auth_db", "routes_videos", "process-video"):
        assert forbidden not in source
