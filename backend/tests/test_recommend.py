"""按能力画像推荐内容离线验收（用户需求 #10 / specs/018）。

覆盖：

1. 精选池内容闸门：24–30 条、videoId 唯一且 11 位、A2/B1/B2/C1 与 4–5 个主题、
   时长 3–40 分钟、缩略图/推荐语/「待运营复核」标记齐全；
2. 有画像：CEFR 区间内优先、理由带「适合你的」、basis.source=profile；
3. 无画像（含库未迁移）：默认 A2–B1、preliminary=true、游客也可用；
4. 游客即使有画像也用默认区间（任务口径）；
5. 排除已看/已缓存 videoId；历史主题用于「你最近在看科技类」；
6. 主题多样性：limit=5 时五个主题各一条、任何主题不超过 2 条；
7. limit、seed（换一批）、targetLang（越南语理由不含中文）；
8. 画像区间无候选时回退默认 band；
9. 空精选池 → 200 空数组；文件缺失/坏内容 → 503；
10. 10 分钟缓存命中与历史变化后的缓存失效。

所有用例离线：数据库在 conftest 的 tmp_path 下通过真实 Alembic CLI 迁移；
精选池读仓库内静态 JSON（或 tmp 副本），不联网、不碰 data/app.db。
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
from pathlib import Path

import pytest

import config
import difficulty
import placement
import recommend
import storage
from tests.migration_utils import assert_alembic_ok, run_alembic

PASSWORD = "recommend-password-123"
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")


# ---------------------------------------------------------------------------
# 夹具 / 工具
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _clear_recommend_cache():
    """进程内缓存不能跨用例串味（历史目录/精选池都可能被替换）。"""
    recommend.reset_cache()
    yield
    recommend.reset_cache()


@pytest.fixture()
def supply_gate_open(monkeypatch):
    """M2 match_v0 用例：把供给阈值临时降到 0（等价于已满 100 条）。"""
    monkeypatch.setattr(recommend, "SUPPLY_GATE_MIN", 0, raising=False)
    recommend.reset_cache()
    yield
    recommend.reset_cache()


def _upgrade() -> None:
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"), "upgrade head (recommend)"
    )


@pytest.fixture()
def profile_db(client):
    """已迁移到 head 的登录客户端（user_profiles 可直接写入）。"""
    _upgrade()
    return client


def _insert_profile(
    user_id: str,
    low: str = "B1",
    high: str = "B2",
    *,
    confidence: float = 0.8,
) -> None:
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    try:
        conn.execute(
            "INSERT INTO user_profiles "
            "(user_id, cefr, level_band_low, level_band_high, vocab_estimate, "
            " reading_estimate, confidence, pseudo_word_suspicion, updated_at, source) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'placement')",
            (
                user_id,
                f"{low}–{high}",
                low,
                high,
                4000,
                high,
                confidence,
                0.0,
                int(time.time() * 1000),
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _write_history(
    user_id: str,
    video_id: str,
    *,
    title: str = "",
    channel: str = "",
    target_lang: str = "zh-CN",
) -> None:
    root = Path(storage.user_history_dir(user_id, target_lang))
    root.mkdir(parents=True, exist_ok=True)
    payload = {
        "videoId": video_id,
        "metadata": {"title": title or f"video {video_id}", "channel": channel},
        "transcript": [],
    }
    (root / f"test_{video_id}.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


def _catalog() -> list[dict]:
    return recommend.load_catalog()["items"]


def _levels_of(items: list[dict]) -> set[str]:
    return {item["level"] for item in items}


def _topic_counts(items: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        counts[item["topic"]] = counts.get(item["topic"], 0) + 1
    return counts


def _distance_ok(items: list[dict], band: tuple[str, str]) -> bool:
    return all(recommend.level_distance(item["level"], band) <= 1 for item in items)


def _get(client, query: str = "limit=6"):
    return client.get(f"/api/recommendations?{query}")


# ---------------------------------------------------------------------------
# 1. 精选池内容闸门
# ---------------------------------------------------------------------------

def test_curated_pool_is_complete_and_valid():
    catalog = recommend.load_catalog()
    items = catalog["items"]

    assert 24 <= len(items) <= 30
    assert "待运营复核" in catalog["meta"]["notice"]
    assert catalog["meta"]["count"] == len(items)
    ids = [item["videoId"] for item in items]
    assert len(ids) == len(set(ids))
    assert all(re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id) for video_id in ids)

    assert _levels_of(items) == {"A2", "B1", "B2", "C1"}
    topics = {item["topic"] for item in items}
    assert 4 <= len(topics) <= 5
    assert topics <= set(recommend.TOPIC_LABELS)

    for item in items:
        assert 180 <= item["duration"] <= 2400
        assert item["thumbnail"] == (
            f"https://i.ytimg.com/vi/{item['videoId']}/hqdefault.jpg"
        )
        assert item["reason"].strip()
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", item["publishedAt"])
    # 每个难度带至少 3 条，保证区间内/±1 都有可选项。
    for level in ("A2", "B1", "B2", "C1"):
        assert sum(1 for item in items if item["level"] == level) >= 3


def test_curated_pool_rejects_bad_content(tmp_path, monkeypatch):
    """内容闸门：缺 notice / 假 id / 时长越界 / 未知主题都直接 503。"""
    base = json.loads((Path(config.CURATED_CONTENT_PATH)).read_text(encoding="utf-8"))
    item = dict(base["items"][0])

    cases = []
    no_notice = {"_meta": {"count": 1}, "items": [item]}
    cases.append(no_notice)
    bad_id = {"_meta": {"notice": "人工精选草稿，待运营复核", "count": 1},
              "items": [{**item, "videoId": "not-a-youtube-id"}]}
    cases.append(bad_id)
    short = {"_meta": {"notice": "人工精选草稿，待运营复核", "count": 1},
             "items": [{**item, "duration": 30}]}
    cases.append(short)
    bad_topic = {"_meta": {"notice": "人工精选草稿，待运营复核", "count": 1},
                 "items": [{**item, "topic": "politics"}]}
    cases.append(bad_topic)

    for index, payload in enumerate(cases):
        path = tmp_path / f"curated-bad-{index}.json"
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        monkeypatch.setattr(config, "CURATED_CONTENT_PATH", str(path), raising=False)
        recommend.reset_cache()
        with pytest.raises(recommend.RecommendationUnavailable):
            recommend.load_catalog()


# ---------------------------------------------------------------------------
# 2. 有画像：区间匹配 + 理由 + basis
# ---------------------------------------------------------------------------

def test_profile_band_matches_and_explains(profile_db):
    _insert_profile(profile_db.user_id, "B1", "B2")
    response = _get(profile_db, "limit=6")
    assert response.status_code == 200, response.text
    data = response.json()

    assert data["basis"] == {"band": "B1–B2", "source": "profile"}
    assert data["preliminary"] is True  # 样本 <100
    items = data["items"]
    assert len(items) == 6
    # 画像区间内有 20 条候选，足够填满 6 条，因此全是精确区间（B1/B2）。
    assert _levels_of(items) <= {"B1", "B2"}
    for item in items:
        assert set(item) >= {
            "videoId", "title", "channel", "duration", "thumbnail",
            "level", "reason", "url",
        }
        assert item["url"] == f"https://www.youtube.com/watch?v={item['videoId']}"
        assert "适合你的" in item["reason"]
    assert len({item["videoId"] for item in items}) == 6
    assert response.headers.get("cache-control") == "private, max-age=600"


def test_profile_c1_band_prioritises_c1(profile_db):
    _insert_profile(profile_db.user_id, "C1", "C1")
    data = _get(profile_db).json()
    assert data["basis"] == {"band": "C1–C1", "source": "profile"}
    # 精选池恰有 6 条 C1，全部精确命中；不应先用 B2 的相邻候选。
    assert len(data["items"]) == 6
    assert _levels_of(data["items"]) == {"C1"}


# ---------------------------------------------------------------------------
# 3. 无画像：默认 band / 库未迁移 / 游客
# ---------------------------------------------------------------------------

def test_no_profile_uses_default_band(client):
    # 没有迁移、没有 user_profiles：推荐仍可用，不 503。
    response = _get(client, "limit=6")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["basis"] == {"band": "A2–B1", "source": "default"}
    assert data["preliminary"] is True
    assert len(data["items"]) == 6
    assert _distance_ok(data["items"], recommend.DEFAULT_BAND)
    assert all("入门区间" in item["reason"] for item in data["items"])


def test_guest_uses_default_band_even_with_profile(make_client):
    with make_client() as guest_client:
        me = guest_client.get("/api/auth/me")
        assert me.status_code == 200 and me.json()["guest"] is True
        # 先迁移，再给游客身份写一条画像：推荐仍必须用默认 band（任务口径）。
        _upgrade()
        token = guest_client.cookies.get("ln_guest")
        assert token
        import guest as guest_module

        identity = guest_module.guest_id(guest_module.hash_token(token))
        _insert_profile(identity, "C1", "C1")
        recommend.reset_cache()

        response = guest_client.get("/api/recommendations?limit=6")
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["basis"] == {"band": "A2–B1", "source": "default"}
        assert any(item["level"] != "C1" for item in data["items"])


def test_vi_reason_has_no_chinese(make_client):
    with make_client() as guest_client:
        response = guest_client.get("/api/recommendations?limit=6&targetLang=vi-VN")
        assert response.status_code == 200, response.text
        data = response.json()
        assert len(data["items"]) == 6
        for item in data["items"]:
            assert not CJK_RE.search(item["reason"]), item["reason"]
            assert "Trình độ" in item["reason"]


def test_invalid_target_lang_is_400(client):
    response = client.get("/api/recommendations?limit=6&targetLang=xx-XX")
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# 4. 排除已看 / 主题偏好
# ---------------------------------------------------------------------------

def test_watched_videos_are_excluded(client):
    items = _catalog()
    watched = [items[0], items[5]]
    for item in watched:
        _write_history(client.user_id, item["videoId"], title=item["title"])
    recommend.reset_cache()

    data = _get(client).json()
    result_ids = {item["videoId"] for item in data["items"]}
    assert not result_ids & {item["videoId"] for item in watched}


def test_recent_topic_drives_reason(client):
    # 科技类历史（该视频本身会被排除，但主题仍应命中理由）。
    tech = next(item for item in _catalog() if item["topic"] == "technology")
    _write_history(
        client.user_id,
        tech["videoId"],
        title=tech["title"],
        channel=tech["channel"],
    )
    recommend.reset_cache()

    data = _get(client).json()
    assert any("你最近在看科技类" in item["reason"] for item in data["items"])
    # 同一屏不能重复推同一个 videoId。
    ids = [item["videoId"] for item in data["items"]]
    assert len(ids) == len(set(ids))


# ---------------------------------------------------------------------------
# 5. 主题多样性 / limit / seed
# ---------------------------------------------------------------------------

def test_topic_diversity_and_limit(client):
    data = _get(client, "limit=5").json()
    assert len(data["items"]) == 5
    counts = _topic_counts(data["items"])
    assert len(counts) == 5  # 五个主题各一条
    assert max(counts.values()) == 1

    data = _get(client, "limit=6").json()
    counts = _topic_counts(data["items"])
    assert max(counts.values()) <= 2  # 同主题最多 2 条
    assert len(counts) >= 4

    data = _get(client, "limit=1").json()
    assert len(data["items"]) == 1


def test_limit_out_of_range_is_422(client):
    assert client.get("/api/recommendations?limit=0").status_code == 422
    assert client.get("/api/recommendations?limit=100").status_code == 422


def test_seed_changes_batch(client):
    first = _get(client, "limit=6&seed=0").json()
    second = _get(client, "limit=6&seed=3").json()
    assert first["items"]
    assert second["items"]
    assert {item["videoId"] for item in first["items"]} != {
        item["videoId"] for item in second["items"]
    }


# ---------------------------------------------------------------------------
# 6. 回退 / 空数据 / 缓存
# ---------------------------------------------------------------------------

def test_profile_with_no_candidates_falls_back_to_default(profile_db):
    _insert_profile(profile_db.user_id, "C1", "C1")
    # 把 C1 + B2 的候选全部标记为已看：C1–C1 的 ±1 内不再有候选。
    for item in _catalog():
        if item["level"] in {"B2", "C1"}:
            _write_history(profile_db.user_id, item["videoId"], title=item["title"])
    recommend.reset_cache()

    data = _get(profile_db).json()
    assert data["basis"] == {"band": "A2–B1", "source": "default"}
    assert data["items"]
    assert all(item["level"] in {"A1", "A2", "B1", "B2"} for item in data["items"])


def test_empty_pool_returns_empty_not_fake(client, tmp_path, monkeypatch):
    path = tmp_path / "curated-empty.json"
    path.write_text(
        json.dumps(
            {
                "_meta": {"notice": "人工精选草稿，待运营复核", "count": 0},
                "items": [],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "CURATED_CONTENT_PATH", str(path), raising=False)
    recommend.reset_cache()

    response = _get(client)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "items": [],
        "basis": {"band": "A2–B1", "source": "default"},
        "preliminary": True,
    }


def test_missing_pool_is_503(client, tmp_path, monkeypatch):
    monkeypatch.setattr(
        config, "CURATED_CONTENT_PATH", str(tmp_path / "missing.json"), raising=False
    )
    recommend.reset_cache()
    response = _get(client)
    assert response.status_code == 503
    assert "推荐内容" in response.json()["detail"]


def test_cache_ten_minutes_and_invalidates_on_history(client):
    first = _get(client, "limit=6")
    assert first.status_code == 200
    assert first.headers["cache-control"] == "private, max-age=600"
    first_data = first.json()

    # 同参数第二次：命中进程内缓存，结果完全一致。
    second_data = _get(client, "limit=6").json()
    assert second_data == first_data

    # 看过第一条后再请求：历史指纹变化，缓存键不同，该视频被排除。
    watched_id = first_data["items"][0]["videoId"]
    _write_history(client.user_id, watched_id)
    third_data = _get(client, "limit=6").json()
    assert watched_id not in {item["videoId"] for item in third_data["items"]}
    assert third_data != first_data


# ---------------------------------------------------------------------------
# 11. M2：content_difficulty → match_score / 理由 / 徽章数据
# ---------------------------------------------------------------------------

def _insert_difficulty(
    video_id: str,
    *,
    cefr_input: str | None = "B1",
    level: str | None = None,
    subtitle: str = "human",
    kind: str = "curated",
) -> None:
    features = {
        "schema": "difficulty.v1",
        "utr_band": {"A1": 0.2, "A2": 0.1, "B1": 0.05, "B2": 0.02, "C1": 0.005},
        "support": {"subtitle": subtitle},
    }
    difficulty.upsert_payloads(
        [
            {
                "content_ref": video_id,
                "content_kind": kind,
                "version": "v1",
                "level": level or cefr_input,
                "cefr_input": cefr_input,
                "cefr_task": None,
                "lexical_band": cefr_input,
                "syntax_band": None,
                "discourse_band": None,
                "features": features,
                "support": {
                    "subtitle": subtitle,
                    "translation": False,
                    "glossary": False,
                    "text": True,
                },
                "method": "rule",
                "confidence": 0.8,
            }
        ]
    )


def test_match_score_rewards_band_closeness_and_support():
    assert recommend.match_score(None) == 0.0
    assert recommend.match_score(0, {"subtitle": "human"}) == 1.0
    assert recommend.match_score(0, {"subtitle": "none"}) < 1.0
    assert recommend.match_score(1) < recommend.match_score(0)
    assert recommend.match_score(2) < recommend.match_score(1)
    assert recommend.match_score(9) >= 0.0
    assert 0.0 <= recommend.match_score(1, None) <= 1.0


def test_difficulty_rows_drive_reason_and_badge(profile_db, supply_gate_open):
    _insert_profile(profile_db.user_id, "B1", "B2")
    catalog = _catalog()
    targets = [item for item in catalog if item["level"] in {"B1", "B2"}][:6]
    for item in targets:
        _insert_difficulty(item["videoId"], cefr_input="B1")
    recommend.reset_cache()

    data = _get(profile_db, "limit=6").json()
    assert data["basis"] == {"band": "B1–B2", "source": "profile"}
    selected = {item["videoId"]: item for item in data["items"]}
    assert selected
    for item in data["items"]:
        assert "个性化" not in item["reason"]
        if item["videoId"] in {target["videoId"] for target in targets}:
            assert "difficulty" in item
            assert item["difficulty"]["cefrInput"]
            assert item["difficulty"]["bucket"]
            assert item["difficulty"]["estimated"] is True
            assert "与你当前词汇区间接近" in item["reason"]
        else:
            # 没有难度行的条目照旧回退 band 规则，不伪造难度。
            assert "difficulty" not in item


def test_difficulty_overrides_editorial_level_for_selection(profile_db, supply_gate_open):
    _insert_profile(profile_db.user_id, "B1", "B2")
    catalog = _catalog()
    editorial_b1 = next(item for item in catalog if item["level"] == "B1")
    editorial_c1 = next(item for item in catalog if item["level"] == "C1")
    # 编辑标注 C1，但实际难度 B1 → 应进入 B1–B2 的精确区间；
    # 编辑标注 B1，但实际难度 C1+ → 超出 band±1 粗筛，不应被推荐。
    _insert_difficulty(editorial_c1["videoId"], cefr_input="B1", level="C1")
    _insert_difficulty(editorial_b1["videoId"], cefr_input="C1+", level="B1")
    recommend.reset_cache()

    data = _get(profile_db, "limit=6").json()
    ids = {item["videoId"] for item in data["items"]}
    assert editorial_c1["videoId"] in ids
    assert editorial_b1["videoId"] not in ids
    c1_item = next(item for item in data["items"] if item["videoId"] == editorial_c1["videoId"])
    assert c1_item["level"] == "C1"  # 编辑等级保留
    assert c1_item["difficulty"]["cefrInput"] == "B1"


def test_no_difficulty_rows_keeps_legacy_reason(profile_db):
    _insert_profile(profile_db.user_id, "B1", "B2")
    recommend.reset_cache()
    data = _get(profile_db, "limit=6").json()
    assert all("difficulty" not in item for item in data["items"])
    assert any("适合你的" in item["reason"] for item in data["items"])


def test_vi_reason_with_difficulty_has_no_chinese_or_individualization(client, supply_gate_open):
    _upgrade()
    catalog = _catalog()
    for item in catalog:
        _insert_difficulty(item["videoId"], cefr_input="B1")
    recommend.reset_cache()

    data = _get(client, "limit=6&targetLang=vi-VN").json()
    assert data["items"]
    for item in data["items"]:
        assert not CJK_RE.search(item["reason"])
        assert "个性化" not in item["reason"]
        assert "khoảng từ vựng hiện tại" in item["reason"]


def test_difficulty_change_invalidates_result_cache(profile_db, supply_gate_open):
    _insert_profile(profile_db.user_id, "B1", "B2")
    catalog = _catalog()
    for item in catalog:
        _insert_difficulty(item["videoId"], cefr_input="B1")
    recommend.reset_cache()
    first = _get(profile_db, "limit=6").json()
    assert first["items"]
    target = first["items"][0]
    assert target["difficulty"]["cefrInput"] == "B1"

    # 同一 videoId 的难度改到 C1+（距离 2）→ 缓存键含难度指纹，必须换结果。
    _insert_difficulty(target["videoId"], cefr_input="C1+")
    second = _get(profile_db, "limit=6").json()
    assert target["videoId"] not in {item["videoId"] for item in second["items"]}


# ---------------------------------------------------------------------------
# 12. 内容供给 gate：eligible ≥100 才启用 match_v0，否则完全回退旧规则
# ---------------------------------------------------------------------------

def test_supply_gate_closed_falls_back_to_legacy(client):
    _upgrade()
    for item in _catalog():
        _insert_difficulty(item["videoId"], cefr_input="B1")
    recommend.reset_cache()

    state = recommend.supply_gate_state()
    assert state["threshold"] == 100
    assert state["eligible"] == 30
    assert state["open"] is False

    data = _get(client).json()
    assert data["items"]
    assert all("difficulty" not in item for item in data["items"])
    assert all("与你当前词汇区间接近" not in item["reason"] for item in data["items"])
    assert any("入门区间" in item["reason"] for item in data["items"])


def test_supply_gate_counts_only_computed_recommendable_rows(client):
    _upgrade()
    for index in range(99):
        _insert_difficulty(f"vid{index:08d}", cefr_input="B1")
    # 占位行（cefr_input=None）不计入；local_show 不在推荐池，也不计入。
    _insert_difficulty("vid-placeholder", cefr_input=None)
    _insert_difficulty("show-1", cefr_input="B1", kind="local_show")

    state = recommend.supply_gate_state()
    assert state["byKind"] == {"video": 0, "article": 0, "curated": 99}
    assert state["eligible"] == 99
    assert state["open"] is False

    # 第 100 条可算内容（article，C1+ 也算）才把 gate 打开。
    _insert_difficulty("article-100", cefr_input="C1+", kind="article")
    state = recommend.supply_gate_state()
    assert state["byKind"] == {"video": 0, "article": 1, "curated": 99}
    assert state["eligible"] == 100
    assert state["open"] is True


def test_supply_gate_threshold_is_exactly_one_hundred():
    assert recommend.SUPPLY_GATE_MIN == 100


def test_supply_gate_opening_invalidates_cached_legacy_result(client, monkeypatch):
    _upgrade()
    for item in _catalog():
        _insert_difficulty(item["videoId"], cefr_input="B1")
    recommend.reset_cache()

    legacy = _get(client).json()
    assert all("difficulty" not in item for item in legacy["items"])

    # 供给达到阈值：缓存键里的 gate 标志变化，必须重新走 match_v0。
    monkeypatch.setattr(recommend, "SUPPLY_GATE_MIN", 30, raising=False)
    matched = _get(client).json()
    assert recommend.supply_gate_state()["open"] is True
    assert any("difficulty" in item for item in matched["items"])


def test_supply_gate_without_difficulty_table_is_closed(client):
    # 没有迁移 content_difficulty 时按 0 处理，不能把推荐接口打挂。
    state = recommend.supply_gate_state()
    assert state["eligible"] == 0
    assert state["open"] is False
