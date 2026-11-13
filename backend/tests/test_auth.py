"""用户体系契约测试（全离线）。

覆盖冻结契约：注册 / 重复注册 / 参数校验 / 登录 / 错密码 / 登出 /
未登录 401 / 会话过期 / 会话 token 只存哈希 / 每用户数据隔离 /
API_AUTH_KEY 与会话共存 / 登录失败限流 / Cookie 安全属性。
"""
import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

import config
import llm
import routes_auth
import routes_user
import routes_videos
import storage

PASSWORD = "correct-horse-battery"
EMAIL = "alice@example.com"

DICT_PAYLOAD = {
    "word": "isolationword",
    "lemma": "isolationword",
    "ipa": "/ˌaɪsəˈleɪʃənwɜːrd/",
    "pos": "n.",
    "zh": "隔离词",
    "definition_en": "A word used to test per-user caches.",
    "example": "This is an isolationword.",
}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _signup(client, email=EMAIL, password=PASSWORD):
    return client.post(
        "/api/auth/signup", json={"email": email, "password": password}
    )


def _cookie_name_value(response) -> str:
    raw = response.headers.get("set-cookie", "")
    return raw.split(";", 1)[0]


def _cookie_attributes(response) -> dict:
    raw = response.headers.get("set-cookie", "")
    parts = [part.strip() for part in raw.split(";")][1:]
    attrs = {}
    for part in parts:
        key, _, value = part.partition("=")
        attrs[key.strip().lower()] = value.strip()
    return attrs


def _token_from_response(response) -> str:
    name_value = _cookie_name_value(response)
    name, _, token = name_value.partition("=")
    assert name == "ln_session"
    return token


def _db_query(sql: str, params: tuple = ()) -> list[dict]:
    conn = sqlite3.connect(config.AUTH_DB_PATH)
    try:
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# signup
# ---------------------------------------------------------------------------

def test_signup_returns_user_and_sets_cookie(make_client):
    with make_client() as client:
        response = _signup(client, email="  Alice@Example.COM  ")

        assert response.status_code == 201
        body = response.json()
        assert set(body) == {"user"}
        assert set(body["user"]) == {"id", "email"}
        assert body["user"]["email"] == "alice@example.com", "email 必须统一小写"
        assert isinstance(body["user"]["id"], str) and body["user"]["id"]

        # Cookie 契约：httpOnly / SameSite=Lax / Path=/ / 30 天 / 本地默认不 Secure
        assert _cookie_name_value(response).startswith("ln_session=")
        attrs = _cookie_attributes(response)
        assert "httponly" in attrs
        assert attrs["samesite"].lower() == "lax"
        assert attrs["path"] == "/"
        assert attrs["max-age"] == str(30 * 24 * 60 * 60)
        assert "secure" not in attrs

        token = _token_from_response(response)
        assert len(token) >= 32, "token 至少 32 字节熵（token_urlsafe(32) 为 43 字符）"
        assert token == client.cookies.get("ln_session")

        me = client.get("/api/auth/me")
        assert me.status_code == 200
        assert me.json()["user"] == body["user"]


def test_signup_secure_cookie_follows_config(make_client, monkeypatch):
    monkeypatch.setattr(config, "COOKIE_SECURE", True, raising=False)
    with make_client() as client:
        response = _signup(client, email="secure@example.com")
        assert response.status_code == 201
        assert "secure" in _cookie_attributes(response)


def test_signup_duplicate_email_is_409_case_insensitive(make_client):
    with make_client() as client:
        assert _signup(client).status_code == 201
        duplicate = _signup(client, email="ALICE@example.com")
        assert duplicate.status_code == 409
        assert duplicate.json().get("detail")


@pytest.mark.parametrize(
    ("email", "password"),
    [
        ("not-an-email", PASSWORD),
        ("a@b", PASSWORD),  # 没有顶级域
        ("a b@example.com", PASSWORD),
        ("", PASSWORD),
        ("short-password@example.com", "1234567"),  # 差一个字符
    ],
)
def test_signup_rejects_invalid_credentials(make_client, email, password):
    with make_client() as client:
        response = _signup(client, email=email, password=password)
        assert response.status_code == 400
        assert response.json().get("detail")
        assert client.cookies.get("ln_session") is None


def test_signup_accepts_exactly_eight_character_password(make_client):
    with make_client() as client:
        response = _signup(
            client, email="min-length@example.com", password="12345678"
        )
        assert response.status_code == 201


def test_signup_stores_only_argon2_hash(make_client):
    with make_client() as client:
        response = _signup(client)
        assert response.status_code == 201

    rows = _db_query("SELECT email, password_hash, created_at FROM users")
    assert len(rows) == 1
    row = rows[0]
    assert row["email"] == EMAIL
    assert row["password_hash"].startswith("$argon2id$")
    assert row["password_hash"] != PASSWORD
    assert PASSWORD not in row["password_hash"], "禁止明文/可逆存储密码"
    assert isinstance(row["created_at"], int)


# ---------------------------------------------------------------------------
# login
# ---------------------------------------------------------------------------

def test_login_success_sets_cookie(make_client):
    # 先注册 alice；再用另一个干净客户端登录（邮箱大小写不敏感）
    with make_client() as setup:
        assert _signup(setup).status_code == 201
    with make_client() as fresh:
        response = fresh.post(
            "/api/auth/login",
            json={"email": "ALICE@EXAMPLE.COM", "password": PASSWORD},
        )
        assert response.status_code == 200
        user = response.json()["user"]
        assert user["email"] == EMAIL
        assert _cookie_name_value(response).startswith("ln_session=")
        assert fresh.get("/api/auth/me").json()["user"] == user


def test_login_wrong_password_and_unknown_email_are_same_401(make_client):
    with make_client() as setup:
        assert _signup(setup).status_code == 201
    with make_client() as fresh:
        wrong = fresh.post(
            "/api/auth/login", json={"email": EMAIL, "password": "wrong-password"}
        )
        unknown = fresh.post(
            "/api/auth/login",
            json={"email": "nobody@example.com", "password": PASSWORD},
        )
        assert wrong.status_code == unknown.status_code == 401
        assert wrong.json() == unknown.json(), "不能泄露邮箱是否已注册"
        assert fresh.cookies.get("ln_session") is None


# ---------------------------------------------------------------------------
# logout / session
# ---------------------------------------------------------------------------

def test_logout_clears_cookie_and_invalidates_session(make_client):
    with make_client() as client:
        signup = _signup(client)
        token = _token_from_response(signup)

        logout = client.post("/api/auth/logout")
        assert logout.status_code == 200
        assert logout.json() == {"ok": True}
        attrs = _cookie_attributes(logout)
        assert attrs.get("max-age") == "0", "登出必须让浏览器删除 Cookie"

        assert client.get("/api/auth/me").status_code == 401

        # 即使有人保存了旧 token 手工重放，服务端会话也已删除
        with make_client() as replay:
            replay.cookies.set("ln_session", token)
            assert replay.get("/api/auth/me").status_code == 401


def test_logout_without_session_is_still_ok(make_client):
    with make_client() as client:
        response = client.post("/api/auth/logout")
        assert response.status_code == 200
        assert response.json() == {"ok": True}


def test_me_requires_login(make_client):
    with make_client() as client:
        response = client.get("/api/auth/me")
        assert response.status_code == 401
        assert response.json() == {"detail": "未登录"}


@pytest.mark.parametrize(
    "path",
    ["/api/models", "/api/favorites", "/api/subscriptions", "/api/history"],
)
def test_protected_api_requires_login(make_client, path):
    with make_client() as client:
        response = client.get(path)
        assert response.status_code == 401
        assert response.json() == {"detail": "未登录"}


def test_health_stays_public(make_client):
    with make_client() as client:
        assert client.get("/health").json() == {"status": "ok"}


def test_session_expiry_is_rejected_and_cleaned(make_client):
    with make_client() as client:
        signup = _signup(client)
        token = _token_from_response(signup)

        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        conn = sqlite3.connect(config.AUTH_DB_PATH)
        try:
            conn.execute(
                "UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
                (int(time.time()) - 10, token_hash),
            )
            conn.commit()
        finally:
            conn.close()

        response = client.get("/api/auth/me")
        assert response.status_code == 401
        assert response.json() == {"detail": "未登录"}

    remaining = _db_query("SELECT token_hash FROM sessions WHERE token_hash = ?", (token_hash,))
    assert remaining == [], "过期会话应在读取时被清理"


def test_session_token_is_stored_as_sha256(make_client):
    with make_client() as client:
        signup = _signup(client)
        token = _token_from_response(signup)

    sessions = _db_query("SELECT token_hash, user_id, expires_at FROM sessions")
    assert len(sessions) == 1
    row = sessions[0]
    assert row["token_hash"] == hashlib.sha256(token.encode("utf-8")).hexdigest()
    assert row["token_hash"] != token
    assert len(row["token_hash"]) == 64
    assert abs(row["expires_at"] - (int(time.time()) + 30 * 24 * 60 * 60)) < 30

    # Cookie 里是随机 token，不是用户 id
    assert token != row["user_id"]


# ---------------------------------------------------------------------------
# 多用户数据隔离
# ---------------------------------------------------------------------------

def test_two_users_data_is_isolated(make_client):
    with make_client() as alice, make_client() as bob:
        alice_login = _signup(alice, email=EMAIL)
        bob_login = _signup(bob, email="bob@example.com", password="bob-password-123")
        alice_id = alice_login.json()["user"]["id"]
        bob_id = bob_login.json()["user"]["id"]
        assert alice_id != bob_id

        # 收藏隔离
        alice.put("/api/favorites", json={"favorites": [{"word": "alpha"}]})
        assert bob.get("/api/favorites").json() == []
        bob.put("/api/favorites", json={"favorites": [{"word": "beta"}]})
        assert alice.get("/api/favorites").json() == [{"word": "alpha"}]
        assert bob.get("/api/favorites").json() == [{"word": "beta"}]

        # 订阅隔离
        alice.put("/api/subscriptions", json={"subscriptions": [{"channel": "A"}]})
        assert bob.get("/api/subscriptions").json() == []

        # 历史缓存隔离：直接往 Alice 的用户目录写一个缓存文件
        alice_history = Path(storage.user_history_dir(alice_id))
        alice_history.mkdir(parents=True, exist_ok=True)
        filename = "Alice_20240101_abc123xyz.json"
        (alice_history / filename).write_text(
            json.dumps(
                {
                    "videoId": "abc123xyz",
                    "metadata": {"title": "Alice only"},
                    "transcript": [],
                    "summary": "",
                    "studyCount": 0,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        alice_list = alice.get("/api/history").json()
        bob_list = bob.get("/api/history").json()
        assert [item["filename"] for item in alice_list] == [filename]
        assert bob_list == [], "Bob 不能看到 Alice 的历史记录"
        assert bob.get(f"/api/history/{filename}").status_code == 404
        assert alice.get(f"/api/history/{filename}").status_code == 200

        # 落盘位置确实按 user_id 分目录
        assert os.path.exists(
            os.path.join(config.USER_DATA_DIR, alice_id, "favorites.json")
        )
        assert os.path.exists(
            os.path.join(config.USER_DATA_DIR, bob_id, "favorites.json")
        )
        assert not os.path.exists(
            os.path.join(config.USER_DATA_DIR, bob_id, "history", filename)
        )


def test_dictionary_cache_is_per_user(make_client, monkeypatch):
    calls = []

    def fake_generate_json(prompt, model=None):
        calls.append(model)
        return json.dumps(DICT_PAYLOAD, ensure_ascii=False)

    monkeypatch.setattr(llm, "generate_json", fake_generate_json)
    monkeypatch.setattr(routes_user, "_dict_model_candidates", lambda: ["gemini-2.5-flash"])

    with make_client() as alice, make_client() as bob:
        alice_signup = _signup(alice, email=EMAIL)
        bob_signup = _signup(bob, email="bob@example.com", password="bob-password-123")
        alice_id = alice_signup.json()["user"]["id"]
        bob_id = bob_signup.json()["user"]["id"]

        payload = {"word": "isolationword"}
        assert alice.post("/api/define", json=payload).status_code == 200
        assert bob.post("/api/define", json=payload).status_code == 200

    assert len(calls) == 2, "词典缓存按用户隔离：Bob 不应命中 Alice 的缓存"
    for user_id in (alice_id, bob_id):
        cache_file = Path(storage.user_history_dir(user_id)) / "dictionary_cache.json"
        assert cache_file.exists()
        assert "isolationword" in json.loads(cache_file.read_text(encoding="utf-8"))


def test_streaming_pipeline_writes_to_user_history_only(client, history_dir, monkeypatch):
    """SSE 生成器在中间件返回后继续跑，ContextVar 仍必须指向当前用户。"""
    url = "https://www.youtube.com/watch?v=abc123xyz"
    video_id = "abc123xyz"

    monkeypatch.setattr(
        routes_videos,
        "fetch_english_transcript",
        lambda _video_id: [SimpleNamespace(text="Hello world.", start=0.0, duration=1.0)],
    )
    monkeypatch.setattr(
        routes_videos,
        "get_video_metadata",
        lambda _url: {
            "title": "Streamed",
            "channel": "Test Channel",
            "upload_date": "20240101",
            "thumbnail": "",
        },
    )
    monkeypatch.setattr(
        llm,
        "generate_json",
        lambda prompt, model=None: json.dumps(
            {"blocks": [{"id": 1, "zh_text": "你好，世界。", "highlights": []}]},
            ensure_ascii=False,
        ),
    )
    monkeypatch.setattr(llm, "generate_text", lambda prompt, model=None: "流式总结")
    monkeypatch.setattr(llm, "batch_pause", lambda model=None: 0)

    response = client.post(
        "/api/process-video-stream", json={"url": url, "model": "deepseek-chat"}
    )
    assert response.status_code == 200
    assert "event: done" in response.text

    files = list(history_dir.glob("*.json"))
    assert len(files) == 1, "流式结果必须写到当前用户目录"
    assert json.loads(files[0].read_text(encoding="utf-8"))["videoId"] == video_id
    # 未登录回落目录不能被写入
    assert list(Path(config.HISTORY_DIR).glob("*.json")) == []


# ---------------------------------------------------------------------------
# API_AUTH_KEY 与会话共存
# ---------------------------------------------------------------------------
def test_api_key_and_session_are_both_required(make_client, monkeypatch):
    monkeypatch.setattr(config, "API_AUTH_KEY", "deploy-secret", raising=False)

    # 只有会话 Cookie、没有（正确）X-API-Key：仍然被部署闸门拦下
    with make_client() as session_only:
        signup = _signup(session_only, email=EMAIL)
        assert signup.status_code == 201
        token = _token_from_response(signup)
    with make_client(headers={"x-api-key": "wrong-key"}) as no_key:
        no_key.cookies.set("ln_session", token)
        blocked = no_key.get("/api/models")
        assert blocked.status_code == 401
        assert "API Key" in blocked.json()["detail"]

    # 有正确 API Key、没有会话：仍要求登录；登录后才放行
    with make_client(headers={"x-api-key": "deploy-secret"}) as keyed:
        assert keyed.get("/api/models").json() == {"detail": "未登录"}
        assert _signup(keyed, email="key-only@example.com").status_code == 201
        assert keyed.get("/api/auth/me").status_code == 200
        assert keyed.get("/api/models").status_code == 200

    # 两者都满足才放行
    with make_client(headers={"x-api-key": "deploy-secret"}) as ok:
        assert _signup(ok, email="both@example.com").status_code == 201
        assert ok.get("/api/models").status_code == 200


# ---------------------------------------------------------------------------
# 登录失败限流 / CORS
# ---------------------------------------------------------------------------

def test_login_failures_are_rate_limited(make_client, monkeypatch):
    monkeypatch.setattr(routes_auth, "LOGIN_MAX_FAILURES", 3, raising=False)
    with make_client() as client:
        assert _signup(client).status_code == 201
        for _ in range(3):
            wrong = client.post(
                "/api/auth/login",
                json={"email": EMAIL, "password": "definitely-wrong"},
            )
            assert wrong.status_code == 401
        limited = client.post(
            "/api/auth/login", json={"email": EMAIL, "password": PASSWORD}
        )
        assert limited.status_code == 429, "同一 IP 连续失败后应限流"


def test_cors_headers_survive_auth_401(make_client):
    origin = (
        "http://localhost:5173"
        if config.ALLOWED_ORIGINS == ["*"]
        else config.ALLOWED_ORIGINS[0]
    )
    with make_client() as anon:
        response = anon.get("/api/models", headers={"Origin": origin})
        assert response.status_code == 401
        # 带凭据的 CORS 必须回显具体 Origin，不能用 `*`（浏览器会拒绝）。
        assert response.headers["access-control-allow-origin"] == origin
        assert response.headers["access-control-allow-credentials"] == "true"

        preflight = anon.options(
            "/api/auth/login",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        assert preflight.status_code == 200
        assert preflight.headers["access-control-allow-origin"] == origin
        assert preflight.headers["access-control-allow-credentials"] == "true"

    with make_client() as signup_client:
        # 首个带凭据的 auth 请求（还没有 Cookie）也必须回显 Origin，
        # 否则浏览器会拦截 login/signup 的响应。
        signup = signup_client.post(
            "/api/auth/signup",
            headers={"Origin": origin},
            json={"email": "cors@example.com", "password": PASSWORD},
        )
        assert signup.status_code == 201
        assert signup.headers["access-control-allow-origin"] == origin
