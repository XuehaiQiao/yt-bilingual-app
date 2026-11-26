"""P2-51：认证 API 默认缓存头 + 无身份 `/api/history` 回落隔离（离线）。

覆盖任务卡的验收：

1. 身份相关 `/api/*`（history / favorites / subscriptions / auth/me / quota）
   在**没有显式策略**时由 `main.default_api_cache_policy` 补
   `Cache-Control: private, no-store` + `Vary: Cookie`；
2. 同一 URL（`/api/history`）两个账号 body 不同，响应头完全一致地不可缓存；
3. 公开/显式策略不被覆盖：`/api/library`（public 300）、`/api/books`（public
   300）、`/api/library/videos/{id}`（public 3600）、`/api/recommendations`
   （private 600）；
4. 无 Cookie 的 `/api/history` 返回空，且不读全局 `config.HISTORY_DIR`
   （遗留全站目录里放标记文件，响应体不得出现）；直接调用路由（无身份
   ContextVar）也返回空，连 `storage.history_dir()` 都不调用；
5. 错误响应（历史 404 / 管理端点 403）同样 `no-store`；
6. 退出登录清会话 Cookie，响应 `no-store` + `Clear-Site-Data: "cache"`。

完全离线：迁移走真实 Alembic CLI，数据库/目录都在 `tmp_path` 下。
"""
from __future__ import annotations

import json
from pathlib import Path

import config
import routes_videos
import storage
from tests.migration_utils import assert_alembic_ok, run_alembic

SECOND_USER_EMAIL = "cache-headers-b@example.com"
SECOND_USER_PASSWORD = "cache-headers-b-password"
QUOTA_EMAIL = "cache-headers-quota@example.com"
QUOTA_PASSWORD = "cache-headers-quota-password"

PRIVATE_GET_ENDPOINTS = (
    "/api/history",
    "/api/favorites",
    "/api/subscriptions",
    "/api/auth/me",
)


def _assert_private_no_store(response) -> None:
    """私有响应必须禁止任何缓存，并声明按 Cookie 区分。"""
    cache_control = response.headers.get("cache-control", "")
    assert "private" in cache_control, response.headers
    assert "no-store" in cache_control, response.headers
    vary = response.headers.get("vary", "")
    assert "cookie" in vary.lower(), response.headers


def _write_history(directory: Path, filename: str, *, title: str) -> None:
    """在指定用户（或遗留全局）history 目录写一份能被列表读出的缓存。"""
    directory.mkdir(parents=True, exist_ok=True)
    payload = {
        "videoId": "dQw4w9WgXcQ",
        "metadata": {"title": title},
        "transcript": [],
        "summary": "",
        "model": "deepseek-chat",
        "studyCount": 0,
    }
    (directory / filename).write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


def test_private_get_endpoints_are_private_no_store(client):
    """核心读端点：中间件默认值必须同时含 private / no-store / Vary: Cookie。"""
    for path in PRIVATE_GET_ENDPOINTS:
        response = client.get(path)
        assert response.status_code == 200, (path, response.status_code, response.text)
        _assert_private_no_store(response)


def test_quota_endpoint_is_private_no_store(make_client):
    """quota 是身份相关读端点（需要迁移后的 ai_quota / quota_overrides）。"""
    assert_alembic_ok(
        run_alembic(config.AUTH_DB_PATH, "upgrade", "head"),
        "upgrade head (cache headers)",
    )
    with make_client() as quota_client:
        signup = quota_client.post(
            "/api/auth/signup",
            json={"email": QUOTA_EMAIL, "password": QUOTA_PASSWORD},
        )
        assert signup.status_code == 201, signup.text
        response = quota_client.get("/api/quota")
        assert response.status_code == 200, response.text
        _assert_private_no_store(response)


def test_two_accounts_same_url_different_body_are_not_cacheable(client, make_client):
    """同一 URL、不同账号、不同 body：响应头一致地不可缓存（共享缓存投毒形状）。"""
    a_history = Path(storage.user_history_dir(client.user_id))
    _write_history(a_history, "A_ONLY_20240101_aaaaaaaaaaa.json", title="A-ONLY-VIDEO")

    a_response = client.get("/api/history")
    assert a_response.status_code == 200
    with make_client() as b_client:
        signup = b_client.post(
            "/api/auth/signup",
            json={"email": SECOND_USER_EMAIL, "password": SECOND_USER_PASSWORD},
        )
        assert signup.status_code == 201, signup.text
        b_response = b_client.get("/api/history")
        assert b_response.status_code == 200

    a_items = a_response.json()
    b_items = b_response.json()
    assert [item["filename"] for item in a_items] == [
        "A_ONLY_20240101_aaaaaaaaaaa.json"
    ]
    assert b_items == []
    assert a_items != b_items, "两个账号的历史必须真正不同，才有缓存串号风险"

    _assert_private_no_store(a_response)
    _assert_private_no_store(b_response)
    # 同一 URL 的缓存策略不能随账号变化（否则共享缓存会按第一个账号缓存）。
    assert (
        a_response.headers["cache-control"] == b_response.headers["cache-control"]
    )


def test_public_and_explicit_cache_policies_are_preserved(client):
    """中间件只补「没写」的响应：公开/显式策略原样保留。"""
    library = client.get("/api/library")
    assert library.status_code == 200
    assert library.headers.get("cache-control") == "public, max-age=300"

    books = client.get("/api/books")
    assert books.status_code == 200
    assert books.headers.get("cache-control") == "public, max-age=300"

    video_id = library.json()["videos"][0]["id"]
    video = client.get(f"/api/library/videos/{video_id}")
    assert video.status_code == 200
    assert video.headers.get("cache-control") == "public, max-age=3600"

    recommendations = client.get("/api/recommendations")
    assert recommendations.status_code == 200, recommendations.text
    assert recommendations.headers.get("cache-control") == "private, max-age=600"


def test_history_without_cookie_is_empty_and_ignores_legacy_global_dir(make_client):
    """无 Cookie 访问：只看到自己的（空）游客目录，遗留全局目录不泄露。

    `config.HISTORY_DIR` 是旧版全站共享目录；HTTP 路径中间件会给匿名客户端
    签发游客身份，因此这里必须是空列表，标记文件绝不能出现在响应里。
    """
    legacy = Path(config.HISTORY_DIR)
    marker = legacy / "GLOBAL_ONLY_marker.json"
    _write_history(legacy, marker.name, title="LEGACY-GLOBAL-ONLY")

    with make_client() as anonymous:
        response = anonymous.get("/api/history")

    assert response.status_code == 200
    assert response.json() == []
    assert "GLOBAL_ONLY_marker" not in response.text
    _assert_private_no_store(response)


def test_history_route_guard_never_touches_global_dir(monkeypatch):
    """绕过身份中间件的直接调用（脚本/异常路径）也不得读全局目录。"""
    legacy = Path(config.HISTORY_DIR)
    _write_history(legacy, "GLOBAL_ONLY_marker.json", title="LEGACY-GLOBAL-ONLY")

    user_token = storage.current_user_id.set(None)
    guest_token = storage.current_guest_hash.set(None)
    calls: list[tuple] = []

    def _forbidden(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("无身份时 list_history() 不得调用 storage.history_dir()")

    monkeypatch.setattr(storage, "history_dir", _forbidden)
    try:
        assert routes_videos.list_history(targetLang=None) == []
    finally:
        storage.current_guest_hash.reset(guest_token)
        storage.current_user_id.reset(user_token)
    assert calls == []


def test_error_responses_are_not_cacheable(client):
    """404/403 也是可被启发式缓存的状态码：错误响应同样 no-store。"""
    missing = client.get("/api/history/no-such-file.json")
    assert missing.status_code == 404
    _assert_private_no_store(missing)

    forbidden = client.get("/api/admin/stats")
    assert forbidden.status_code == 403
    _assert_private_no_store(forbidden)


def test_logout_clears_session_cookie_and_cache(client):
    """退出登录：清会话 Cookie + 私有 no-store + 清浏览器 HTTP 缓存。"""
    logout = client.post("/api/auth/logout")
    assert logout.status_code == 200
    assert logout.json() == {"ok": True}

    set_cookie = logout.headers.get("set-cookie", "").lower()
    assert "ln_session=" in set_cookie
    assert "max-age=0" in set_cookie, set_cookie

    assert logout.headers.get("cache-control") == "private, no-store"
    assert "cache" in logout.headers.get("clear-site-data", "")

    after = client.get("/api/auth/me")
    assert after.status_code == 200
    assert after.json() == {"user": None, "guest": True}
