"""M1 ⑧ 游客态（隔离目录 + 随机 Cookie + 幂等认领）离线验收。

覆盖：

1. 首次访问 `/api/auth/me` 下发 `ln_guest`（32 字节随机、httpOnly、SameSite=Lax、
   30 天），返回 `{user:null, guest:true}`；再次访问不换 Cookie；
2. 游客估价/查词可用，写入 `data/guests/<sha256>/`，不写旧 `HISTORY_DIR`、
   不写任何用户目录；目录名是 sha256(token) 而不是 token 原文；
3. 游客之间数据隔离；非法形状/伪造的 `ln_guest` 不会变成有效身份，也读不到
   别人的数据；
4. 游客更紧的限速（估价/处理/查词各自单独配置）与累计「1 个视频」试译上限：
   新视频 403 提示登录，已缓存视频仍可打开；
5. 登录后 `POST /api/auth/claim-guest` 合并 history / favorites / subscriptions：
   同 videoId、同收藏指纹、同订阅键去重且用户数据优先；游客目录删除、Cookie
   清除；重复 claim 幂等（claimed=false、计数全 0）；
6. 游客的 AI 用量归属 `guest:<sha256>`（计入配额/全站预算，不匿名绕过）。

全部离线：字幕/元数据/LLM 全部 monkeypatch；目录与数据库都在 tmp_path。
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

import config
import guest
import llm
import ratelimit
import routes_user
import routes_videos
import storage

VIDEO_ID = "guestvid001"  # 11 位，合法 YouTube id
VALID_URL = f"https://www.youtube.com/watch?v={VIDEO_ID}"
OTHER_VIDEO_ID = "guestvid002"
OTHER_URL = f"https://www.youtube.com/watch?v={OTHER_VIDEO_ID}"

TRANSCRIPT = [SimpleNamespace(text="Hello world.", start=0.0, duration=1.0)]
METADATA = {
    "title": "Guest Test",
    "channel": "Test Channel",
    "upload_date": "20260101",
    "thumbnail": "",
}
TRANSLATION_PAYLOAD = {
    "blocks": [
        {
            "id": 1,
            "en_text": "Hello world.",
            "zh_text": "你好，世界。",
            "highlights": [],
        }
    ]
}
DICT_PAYLOAD = {
    "word": "guestword",
    "pos": "n.",
    "zh": "游客词",
    "definition_en": "A word looked up by a guest.",
}
SAMPLE_FAVORITE = {
    "type": "sentence",
    "text": "Hello world.",
    "translation": "你好，世界。",
    "videoId": VIDEO_ID,
    "time": 12.5,
    "meta": {"highlights": [], "context_en": "Hello world.", "context_zh": "你好，世界。"},
}
OTHER_FAVORITE = {**SAMPLE_FAVORITE, "text": "Another sentence."}


# ---------------------------------------------------------------------------
# helpers / stubs
# ---------------------------------------------------------------------------

def _install_video_fakes(monkeypatch):
    monkeypatch.setattr(
        routes_videos, "fetch_english_transcript", lambda _video_id: list(TRANSCRIPT)
    )
    monkeypatch.setattr(routes_videos, "get_video_metadata", lambda _url: dict(METADATA))
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)
    monkeypatch.setattr(
        llm,
        "generate_json",
        lambda prompt, model=None: json.dumps(TRANSLATION_PAYLOAD, ensure_ascii=False),
    )
    monkeypatch.setattr(llm, "generate_text", lambda prompt, model=None: "游客总结")


def _install_define_fakes(monkeypatch):
    monkeypatch.setattr(
        routes_user, "_dict_models_for_request", lambda preferred, lang=None: ["deepseek-chat"]
    )
    monkeypatch.setattr(
        llm,
        "generate_json",
        lambda prompt, model=None: json.dumps(DICT_PAYLOAD, ensure_ascii=False),
    )


def _guest_token(client) -> str:
    token = client.cookies.get(guest.COOKIE_NAME)
    assert guest.is_valid_token(token), f"没有合法 ln_guest：{token!r}"
    return token


def _guest_hash(client) -> str:
    return guest.hash_token(_guest_token(client))


def _guest_dir(client) -> Path:
    return Path(config.GUEST_DATA_DIR) / _guest_hash(client)


def _set_cookie_lines(response) -> list[str]:
    return response.headers.get_list("set-cookie")


def _guest_cookie_lines(response) -> list[str]:
    return [
        raw for raw in _set_cookie_lines(response)
        if raw.lower().startswith(f"{guest.COOKIE_NAME}=")
    ]


def _set_guest_cookie(client, value: str) -> None:
    """手动塞 Cookie 时带上 TestClient 的 host，避免 httpx 的 CookieConflict。"""
    client.cookies.set(guest.COOKIE_NAME, value, domain="testserver.local", path="/")


def _cookie_attrs(raw: str) -> dict[str, str]:
    parts = [part.strip() for part in raw.split(";")][1:]
    attrs = {}
    for part in parts:
        key, _, value = part.partition("=")
        attrs[key.strip().lower()] = value.strip()
    return attrs


# ---------------------------------------------------------------------------
# 1. Cookie / 游客态
# ---------------------------------------------------------------------------

def test_first_visit_issues_guest_cookie_and_me_returns_guest(make_client):
    with make_client() as client:
        response = client.get("/api/auth/me")
        assert response.status_code == 200
        assert response.json() == {"user": None, "guest": True}

        lines = _guest_cookie_lines(response)
        assert len(lines) == 1, lines
        attrs = _cookie_attrs(lines[0])
        assert attrs.get("httponly") == ""
        assert attrs.get("samesite", "").lower() == "lax"
        assert attrs.get("path") == "/"
        assert attrs.get("max-age") == str(30 * 24 * 60 * 60)
        token = lines[0].split(";", 1)[0].partition("=")[2]
        assert len(token) == 43, "32 字节随机 → token_urlsafe(32) = 43 字符"

        # 目录名 = sha256(token)，原始 token 永远不会成为路径
        assert guest.hash_token(token) != token
        assert not (_guest_dir(client)).exists(), "只访问 /me 不应写盘"

        # 同一游客的后续请求不再换 Cookie
        second = client.get("/api/auth/me")
        assert second.status_code == 200
        assert _guest_cookie_lines(second) == []
        assert client.cookies.get(guest.COOKIE_NAME) == token


def test_invalid_or_forged_guest_cookie_is_replaced_and_isolated(make_client):
    with make_client() as client:
        # 非法形状：中间件必须丢弃并下发新的合法 token
        _set_guest_cookie(client, "not-a-valid-token")
        response = client.get("/api/auth/me")
        assert response.status_code == 200
        new_token = client.cookies.get(guest.COOKIE_NAME)
        assert guest.is_valid_token(new_token)
        assert new_token != "not-a-valid-token"
        assert len(_guest_cookie_lines(response)) == 1
        bad_hash = guest.hash_token("not-a-valid-token")
        assert bad_hash != _guest_hash(client)
        assert not (Path(config.GUEST_DATA_DIR) / bad_hash).exists()

    # 形状合法但伪造的 token：只会得到自己的空游客目录，读不到真实游客数据
    with make_client() as real_guest:
        real_guest.get("/api/auth/me")
        real_hash = _guest_hash(real_guest)
        real_history = Path(config.GUEST_DATA_DIR) / real_hash / "history"
        real_history.mkdir(parents=True, exist_ok=True)
        (real_history / "real_guest_only.json").write_text(
            json.dumps({"videoId": "realguest01", "metadata": {}, "transcript": []}),
            encoding="utf-8",
        )

    forged_token = "A" * 43
    assert guest.hash_token(forged_token) != real_hash
    with make_client() as forger:
        _set_guest_cookie(forger, forged_token)
        assert forger.get("/api/history").json() == []
        assert forger.get("/api/auth/me").json() == {"user": None, "guest": True}
        # 伪造值不会被映射成别人的目录；它只能得到自己的空目录。
        forged_dir = Path(config.GUEST_DATA_DIR) / guest.hash_token(forged_token)
        assert not forged_dir.exists() or not any(forged_dir.rglob("*.json"))


# ---------------------------------------------------------------------------
# 2. 写入位置 / 游客隔离
# ---------------------------------------------------------------------------

def test_guest_define_writes_under_guests_and_not_legacy_dir(make_client, monkeypatch):
    _install_define_fakes(monkeypatch)
    with make_client() as client:
        client.get("/api/auth/me")
        response = client.post("/api/define", json={"word": "guestword"})
        assert response.status_code == 200, response.text

        cache_file = _guest_dir(client) / "history" / "dictionary_cache.json"
        assert cache_file.exists(), "游客查词缓存必须落在 data/guests/<sha256>/"
        assert "guestword" in json.loads(cache_file.read_text(encoding="utf-8"))

        # 不能写共享回落目录，也不能写任何用户目录
        assert list(Path(config.HISTORY_DIR).glob("*.json")) == []
        user_root = Path(config.USER_DATA_DIR)
        assert not user_root.exists() or not any(user_root.iterdir())


def test_guest_and_user_data_are_isolated(make_client, monkeypatch):
    _install_video_fakes(monkeypatch)
    with make_client() as guest_client:
        guest_client.get("/api/auth/me")
        # 换游客专属限速，避免下面的两段请求撞到默认 2 次/分钟
        monkeypatch.setattr(
            config, "RATE_LIMIT_GUEST_PROCESS_VIDEO_PER_MINUTE", 10, raising=False
        )
        ratelimit.reset_rate_limits()
        processed = guest_client.post("/api/process-video", json={"url": VALID_URL})
        assert processed.status_code == 200, processed.text
        guest_files = list((_guest_dir(guest_client) / "history").glob("*.json"))
        assert len(guest_files) == 1

        another_guest_token = guest.new_token()
        with make_client() as other_guest:
            _set_guest_cookie(other_guest, another_guest_token)
            assert other_guest.get("/api/history").json() == [], "游客之间不能互相看到历史"

        with make_client() as user_client:
            signup = user_client.post(
                "/api/auth/signup",
                json={"email": "isolated@example.com", "password": "password-123"},
            )
            assert signup.status_code == 201, signup.text
            # 登录用户没有认领前，看不到游客的历史（数据目录按身份切换）
            assert user_client.get("/api/history").json() == []
            user_history = Path(storage.user_history_dir(signup.json()["user"]["id"]))
            assert list(user_history.glob("*.json")) == []


# ---------------------------------------------------------------------------
# 3. 限速 / 试译上限
# ---------------------------------------------------------------------------

def test_guest_limits_use_dedicated_tighter_config(monkeypatch):
    monkeypatch.setattr(config, "RATE_LIMIT_GUEST_DEFINE_PER_MINUTE", 3, raising=False)
    monkeypatch.setattr(config, "RATE_LIMIT_DEFINE_PER_MINUTE", 99, raising=False)
    assert ratelimit.limit_for("define", guest=True) == 3
    assert ratelimit.limit_for("define", guest=False) == 99
    assert ratelimit.limit_for("process_video", guest=True) == int(
        config.RATE_LIMIT_GUEST_PROCESS_VIDEO_PER_MINUTE
    )
    # auth 桶没有游客专用上限：爆破防护仍按 IP 的通用上限。
    assert ratelimit.limit_for("auth", guest=True) == int(
        config.RATE_LIMIT_AUTH_PER_MINUTE
    )


def test_guest_estimate_is_available_and_rate_limited(make_client, monkeypatch):
    _install_video_fakes(monkeypatch)
    monkeypatch.setattr(
        config, "RATE_LIMIT_GUEST_ESTIMATE_COST_PER_MINUTE", 1, raising=False
    )
    ratelimit.reset_rate_limits()
    with make_client() as client:
        client.get("/api/auth/me")
        first = client.get("/api/estimate-cost", params={"url": VALID_URL})
        assert first.status_code == 200, first.text
        second = client.get("/api/estimate-cost", params={"url": VALID_URL})
        assert second.status_code == 429
        assert int(second.headers["Retry-After"]) >= 1


def test_guest_define_is_rate_limited(make_client, monkeypatch):
    _install_define_fakes(monkeypatch)
    monkeypatch.setattr(config, "RATE_LIMIT_GUEST_DEFINE_PER_MINUTE", 1, raising=False)
    ratelimit.reset_rate_limits()
    with make_client() as client:
        client.get("/api/auth/me")
        assert client.post("/api/define", json={"word": "guestword"}).status_code == 200
        limited = client.post("/api/define", json={"word": "another"})
        assert limited.status_code == 429
        assert int(limited.headers["Retry-After"]) >= 1


def test_guest_process_video_is_rate_limited(make_client, monkeypatch):
    _install_video_fakes(monkeypatch)
    monkeypatch.setattr(
        config, "RATE_LIMIT_GUEST_PROCESS_VIDEO_PER_MINUTE", 1, raising=False
    )
    ratelimit.reset_rate_limits()
    with make_client() as client:
        client.get("/api/auth/me")
        assert client.post("/api/process-video", json={"url": VALID_URL}).status_code == 200
        limited = client.post("/api/process-video", json={"url": OTHER_URL})
        assert limited.status_code == 429
        assert int(limited.headers["Retry-After"]) >= 1


def test_guest_can_translate_one_video_then_must_login(make_client, monkeypatch):
    _install_video_fakes(monkeypatch)
    monkeypatch.setattr(
        config, "RATE_LIMIT_GUEST_PROCESS_VIDEO_PER_MINUTE", 10, raising=False
    )
    monkeypatch.setattr(config, "GUEST_MAX_TRANSLATED_VIDEOS", 1, raising=False)
    ratelimit.reset_rate_limits()
    with make_client() as client:
        client.get("/api/auth/me")

        first = client.post("/api/process-video", json={"url": VALID_URL})
        assert first.status_code == 200, first.text
        assert guest.count_translated_videos(_guest_hash(client)) == 1

        second = client.post("/api/process-video", json={"url": OTHER_URL})
        assert second.status_code == 403
        assert "登录" in second.json()["detail"]
        assert second.headers.get("X-Guest-Limit") == "translate"

        # 已试译的视频仍能打开（命中缓存，不再花钱/不再拦）
        cached = client.post("/api/process-video", json={"url": VALID_URL})
        assert cached.status_code == 200, cached.text


def test_guest_translation_cap_counts_youtube_and_local_episode_files(
    make_client, monkeypatch
):
    monkeypatch.setattr(config, "GUEST_MAX_TRANSLATED_VIDEOS", 1, raising=False)
    with make_client() as client:
        client.get("/api/auth/me")
        history = _guest_dir(client) / "history"
        (history / "vi-VN").mkdir(parents=True, exist_ok=True)
        (history / "Test_20260101_vid00000001.json").write_text(
            json.dumps({"videoId": "vid00000001"}), encoding="utf-8"
        )
        (history / "vi-VN" / "Test_20260101_vid00000002.json").write_text(
            json.dumps({"videoId": "vid00000002"}), encoding="utf-8"
        )
        (history / "dictionary_cache.json").write_text("{}", encoding="utf-8")
        assert guest.count_translated_videos(_guest_hash(client)) == 2
        with pytest.raises(guest.GuestLimitError):
            guest.ensure_can_translate(_guest_hash(client))


def test_guest_usage_is_attributed_to_hashed_guest_identity(make_client, monkeypatch):
    _install_define_fakes(monkeypatch)
    captured: dict[str, str] = {}

    def fake_quota(user_id, feature, units=1, **kwargs):
        captured["user_id"] = user_id
        captured["feature"] = feature
        return {"allowed": True, "feature": feature}

    monkeypatch.setattr(routes_user.quota, "check_and_consume_quota", fake_quota)
    with make_client() as client:
        client.get("/api/auth/me")
        response = client.post("/api/define", json={"word": "guestword"})
        assert response.status_code == 200, response.text
        assert captured["user_id"] == guest.guest_id(_guest_hash(client))
        assert guest.parse_guest_id(captured["user_id"]) == _guest_hash(client)


# ---------------------------------------------------------------------------
# 4. 认领：合并 / 去重 / 幂等
# ---------------------------------------------------------------------------

def _signup_same_client(client, email: str):
    response = client.post(
        "/api/auth/signup", json={"email": email, "password": "password-123"}
    )
    assert response.status_code == 201, response.text
    return response.json()["user"]["id"]


def test_claim_merges_data_and_clears_guest(make_client, monkeypatch):
    _install_video_fakes(monkeypatch)
    monkeypatch.setattr(
        config, "RATE_LIMIT_GUEST_PROCESS_VIDEO_PER_MINUTE", 10, raising=False
    )
    ratelimit.reset_rate_limits()
    with make_client() as client:
        client.get("/api/auth/me")
        guest_hash = _guest_hash(client)
        assert client.post("/api/favorites", json=SAMPLE_FAVORITE).status_code == 201
        assert client.put(
            "/api/subscriptions",
            json={"subscriptions": [{"id": "chan-1", "name": "Channel One"}]},
        ).status_code == 200
        assert client.post("/api/process-video", json={"url": VALID_URL}).status_code == 200
        guest_history_files = list((Path(config.GUEST_DATA_DIR) / guest_hash / "history").glob("*.json"))
        assert len(guest_history_files) == 1

        user_id = _signup_same_client(client, "claim@example.com")
        user_root = Path(storage.user_data_dir(user_id))

        claimed = client.post("/api/auth/claim-guest")
        assert claimed.status_code == 200, claimed.text
        body = claimed.json()
        assert body["ok"] is True
        assert body["claimed"] is True
        assert body["merged"]["history"] == 1
        assert body["merged"]["favorites"] == 1
        assert body["merged"]["subscriptions"] == 1

        # 用户目录出现数据
        assert len(list((user_root / "history").glob("*.json"))) == 1
        assert len(json.loads((user_root / "favorites.json").read_text(encoding="utf-8"))) == 1
        assert json.loads(
            (user_root / "subscriptions.json").read_text(encoding="utf-8")
        ) == [{"id": "chan-1", "name": "Channel One"}]

        # 游客目录删除 + Cookie 清除
        assert not (Path(config.GUEST_DATA_DIR) / guest_hash).exists()
        clear_lines = _guest_cookie_lines(claimed)
        assert clear_lines, "认领成功后必须清 ln_guest"
        assert _cookie_attrs(clear_lines[0]).get("max-age") == "0"
        assert client.cookies.get(guest.COOKIE_NAME) is None

        # 接口视角：历史/收藏/订阅都指向用户目录
        assert len(client.get("/api/history").json()) == 1
        assert len(client.get("/api/favorites").json()) == 1
        assert client.get("/api/subscriptions").json() == [
            {"id": "chan-1", "name": "Channel One"}
        ]

        # 幂等：重复 claim 返回 0，数据不变
        repeated = client.post("/api/auth/claim-guest")
        assert repeated.status_code == 200
        assert repeated.json()["claimed"] is False
        assert repeated.json()["merged"] == {
            "history": 0,
            "favorites": 0,
            "subscriptions": 0,
        }
        assert len(client.get("/api/favorites").json()) == 1
        assert len(list((user_root / "history").glob("*.json"))) == 1


def test_claim_dedupes_by_video_id_and_favorite_fingerprint_with_user_priority(
    make_client, monkeypatch
):
    _install_video_fakes(monkeypatch)
    monkeypatch.setattr(
        config, "RATE_LIMIT_GUEST_PROCESS_VIDEO_PER_MINUTE", 10, raising=False
    )
    ratelimit.reset_rate_limits()
    with make_client() as client:
        client.get("/api/auth/me")
        guest_hash = _guest_hash(client)
        first_favorite = client.post("/api/favorites", json=SAMPLE_FAVORITE)
        assert first_favorite.status_code == 201
        second_favorite = client.post("/api/favorites", json=OTHER_FAVORITE)
        assert second_favorite.status_code == 201
        assert client.post("/api/process-video", json={"url": VALID_URL}).status_code == 200
        guest_history_file = next(
            (Path(config.GUEST_DATA_DIR) / guest_hash / "history").glob("*.json")
        )

        user_id = _signup_same_client(client, "dedupe@example.com")
        user_root = Path(storage.user_data_dir(user_id))
        user_history = user_root / "history"
        user_history.mkdir(parents=True, exist_ok=True)
        # 用户已经用另一个文件名存了同一个 videoId：用户数据优先，游客文件跳过
        user_priority_file = user_history / "UserPriority_20260101_guestvid001.json"
        user_priority_file.write_text(
            json.dumps(
                {
                    "videoId": VIDEO_ID,
                    "metadata": {"title": "user priority"},
                    "transcript": [],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        # 用户先收藏了与游客相同的内容（不同 id）：按内容指纹去重
        assert client.post("/api/favorites", json=SAMPLE_FAVORITE).status_code == 201

        claimed = client.post("/api/auth/claim-guest")
        assert claimed.status_code == 200, claimed.text
        body = claimed.json()
        assert body["claimed"] is True
        assert body["merged"]["history"] == 0
        assert body["skipped"]["history"] >= 1
        assert body["merged"]["favorites"] == 1, "只合并游客独有的第二条收藏"
        assert body["skipped"]["favorites"] >= 1

        # 用户文件原样保留，没有因为游客同名视频被覆盖/复制
        assert user_priority_file.exists()
        assert list(user_history.glob("*.json")) == [user_priority_file]
        favorites = client.get("/api/favorites").json()
        assert len(favorites) == 2
        fingerprints = {
            routes_user._favorite_fingerprint(item) for item in favorites
        }
        assert len(fingerprints) == 2, "收藏不能有重复指纹"

        # 游客目录已删除；重复 claim 仍幂等
        assert not (Path(config.GUEST_DATA_DIR) / guest_hash).exists()
        assert client.post("/api/auth/claim-guest").json()["claimed"] is False


def test_claim_requires_login(make_client):
    with make_client() as client:
        client.get("/api/auth/me")
        response = client.post("/api/auth/claim-guest")
        assert response.status_code == 401
        assert response.json() == {"detail": "未登录"}


def test_guest_dir_path_validation_rejects_traversal():
    with pytest.raises(ValueError):
        guest.guest_dir("../users")
    with pytest.raises(ValueError):
        guest.guest_dir("a" * 63)
    with pytest.raises(ValueError):
        guest.guest_dir("Z" * 64)
    # 合法哈希只能在 data/guests/ 下
    valid = "a" * 64
    path = guest.guest_dir(valid)
    assert os.path.basename(path) == valid
    assert os.path.dirname(os.path.realpath(path)) == os.path.realpath(
        config.GUEST_DATA_DIR
    )
