"""离线冒烟测试的公共夹具。

三条硬约束：

1. **目录与数据库隔离**：每个用例都把 `HISTORY_DIR`、`USER_DATA_DIR`
   指到 pytest 的 `tmp_path`，`AUTH_DB_PATH` 也指向 tmp 下的临时 SQLite。
   config.py 在 import 时就算好路径，所以这里直接覆盖模块级属性；
   storage.py / auth_db.py 在运行时读取这些属性，覆盖即生效。
2. **认证**：`client` 夹具会先 `POST /api/auth/signup` 注册并登录一个测试
   用户，Cookie 自动由 TestClient 保存并随请求发送；`history_dir` 返回该
   用户隔离后的 history 目录，既有用例照常读写。需要匿名请求时用
   `make_client()` 自行创建不带 Cookie 的客户端。
3. **完全离线**：llm.generate_json / generate_text、字幕抓取、视频元数据
   全部 monkeypatch；底层的真实传输函数也换成断言，任何漏掉的真实调用
   都会让用例失败，而不是悄悄连网。

另外：venv 里 fastapi 0.110 固定 starlette 0.36.3，而 httpx 已升到 0.28.1，
httpx 0.28 移除了 Client(app=...) 参数，starlette 0.36.3 的 TestClient 仍会
传它（starlette/testclient.py:429）。这里只在构造 TestClient 期间丢掉该
参数——starlette 自己用 transport 连 ASGI app，不依赖它。
"""
import contextlib
import os
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import config  # noqa: E402
import llm  # noqa: E402
import local_dict  # noqa: E402
import routes_auth  # noqa: E402
import routes_content  # noqa: E402
import routes_user  # noqa: E402
import routes_videos  # noqa: E402
import storage  # noqa: E402
import transcripts  # noqa: E402
import translate  # noqa: E402

TEST_USER_EMAIL = "test-user@example.com"
TEST_USER_PASSWORD = "test-password-123"
SECOND_USER_EMAIL = "second-user@example.com"
SECOND_USER_PASSWORD = "second-password-123"


@pytest.fixture(autouse=True)
def isolated_data(tmp_path, monkeypatch):
    """每个用例独立的历史目录、用户目录与认证数据库。"""
    legacy_history = tmp_path / "legacy_history"
    legacy_history.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config, "HISTORY_DIR", str(legacy_history), raising=False)

    data_dir = tmp_path / "data"
    monkeypatch.setattr(config, "DATA_DIR", str(data_dir), raising=False)
    monkeypatch.setattr(config, "USER_DATA_DIR", str(data_dir / "users"), raising=False)
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(data_dir / "app.db"), raising=False)
    monkeypatch.setattr(config, "COOKIE_SECURE", False, raising=False)

    # 本地词典也隔离：默认指向不存在的临时路径。否则只要本机下载过
    # data/ecdict.db，查词就会命中本地词典，让「走 LLM」的用例失去意义。
    # 需要测本地词典的用例再把它指到自建的小 sqlite。
    monkeypatch.setenv("LOCAL_DICT_PATH", str(tmp_path / "ecdict.db"))
    local_dict.reset()

    # 模块级全局缓存，用例之间要清干净，避免串味
    routes_videos._prefetch_cache.clear()
    routes_auth.reset_login_throttle()

    # 让「模型是否可用」与本机 .env 无关，断言可重复
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-deepseek-key")

    yield tmp_path

    routes_videos._prefetch_cache.clear()
    routes_auth.reset_login_throttle()
    local_dict.reset()


@pytest.fixture(autouse=True)
def offline_guard(monkeypatch):
    """底线：真实外部调用一律失败（具体用例再按需覆盖成正常 stub）。"""

    def _blocked(*args, **kwargs):
        raise AssertionError("离线测试中禁止真实外部调用")

    monkeypatch.setattr(llm, "_generate_google", _blocked)
    monkeypatch.setattr(llm, "_generate_openai_compatible", _blocked)
    monkeypatch.setattr(transcripts, "fetch_english_transcript", _blocked)
    monkeypatch.setattr(transcripts, "get_video_metadata", _blocked)
    # routes_videos 是 from transcripts import ...，模块里存的是独立引用
    monkeypatch.setattr(routes_videos, "fetch_english_transcript", _blocked)
    monkeypatch.setattr(routes_videos, "get_video_metadata", _blocked)


@contextlib.contextmanager
def _httpx_app_kwarg_compat():
    """兼容 httpx>=0.28：客户端构造时忽略 starlette 传的 app= 参数。"""
    import httpx

    original_init = httpx.Client.__init__

    def compat_init(self, *args, **kwargs):
        kwargs.pop("app", None)
        return original_init(self, *args, **kwargs)

    httpx.Client.__init__ = compat_init
    try:
        yield
    finally:
        httpx.Client.__init__ = original_init


@pytest.fixture()
def make_client():
    """创建未登录的 TestClient（上下文管理器工厂）。

    用法：``with make_client() as c:``；需要带 API Key 时传 headers。
    """
    @contextlib.contextmanager
    def _make(headers: dict | None = None):
        from fastapi.testclient import TestClient

        import main

        request_headers = dict(headers or {})
        if config.API_AUTH_KEY:  # .env 若开了 key 校验，测试也要带上
            request_headers.setdefault("x-api-key", config.API_AUTH_KEY)

        with _httpx_app_kwarg_compat():
            test_client = TestClient(main.app, headers=request_headers)
        with test_client:
            yield test_client

    return _make


@pytest.fixture()
def client(make_client):
    """已注册并登录的 TestClient；Cookie 由客户端自动保存。"""
    with make_client() as test_client:
        response = test_client.post(
            "/api/auth/signup",
            json={"email": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD},
        )
        assert response.status_code == 201, response.text
        user = response.json()["user"]
        test_client.user_id = user["id"]
        test_client.user_email = user["email"]
        yield test_client


@pytest.fixture()
def history_dir(client):
    """当前登录用户隔离后的 history 目录（真实落盘位置）。"""
    path = Path(storage.user_history_dir(client.user_id))
    path.mkdir(parents=True, exist_ok=True)
    return path
