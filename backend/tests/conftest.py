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

import account  # noqa: E402
import account_export  # noqa: E402
import account_lifecycle  # noqa: E402
import alerts  # noqa: E402
import config  # noqa: E402
import discover  # noqa: E402
import jobs  # noqa: E402
import llm  # noqa: E402
import local_dict  # noqa: E402
import ratelimit  # noqa: E402
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
    # 导出临时文件（M2a）也必须在 tmp 下，绝不能写到仓库的 data/exports/。
    monkeypatch.setattr(config, "EXPORTS_DIR", str(data_dir / "exports"), raising=False)
    monkeypatch.setattr(config, "AUTH_DB_PATH", str(data_dir / "app.db"), raising=False)
    # 游客目录（M1 ⑧）也必须在 tmp_path 下，绝不能写到仓库的 data/guests/。
    monkeypatch.setattr(config, "GUEST_DATA_DIR", str(data_dir / "guests"), raising=False)
    monkeypatch.setattr(config, "COOKIE_SECURE", False, raising=False)
    # 生产默认 REGISTRATION_OPEN=false（G1 邀请制）；测试夹具显式打开公开注册，
    # 让既有用例继续用「直接 signup」登录。邀请/关闭场景由规格 032 的测试
    # 自行 monkeypatch 回 false，绝不把生产默认改成 true。
    monkeypatch.setattr(config, "REGISTRATION_OPEN", True, raising=False)
    monkeypatch.setattr(config, "INVITE_SIGNUP_ENABLED", True, raising=False)
    # 飞书告警（M5）：默认关闭 + 空 webhook，任何用例都不会真的发消息；
    # 需要测发送的用例自己 monkeypatch 配置并注入假 transport。
    monkeypatch.setattr(config, "FEISHU_ALERTS_ENABLED", False, raising=False)
    monkeypatch.setattr(config, "FEISHU_WEBHOOK_URL", "", raising=False)
    monkeypatch.setattr(config, "FEISHU_WEBHOOK_SECRET", "", raising=False)
    alerts.reset_state()
    # 邀请码测试统一用空 pepper（生产由 env 决定）；避免本机 .env 影响摘要。
    monkeypatch.setattr(config, "INVITE_CODE_PEPPER", "", raising=False)

    # 本地词典也隔离：默认指向不存在的临时路径。否则只要本机下载过
    # data/ecdict.db，查词就会命中本地词典，让「走 LLM」的用例失去意义。
    # 需要测本地词典的用例再把它指到自建的小 sqlite。
    monkeypatch.setenv("LOCAL_DICT_PATH", str(tmp_path / "ecdict.db"))
    local_dict.reset()

    # 模块级全局缓存，用例之间要清干净，避免串味
    routes_videos._prefetch_cache.clear()
    routes_auth.reset_login_throttle()
    # 任务表执行权/告警标记是进程内状态，按用例隔离。
    jobs.reset_active_jobs()
    jobs.reset_warned_state()
    # 安全最小集的进程内状态：限速计数与 LLM 并发闸统计按用例隔离。
    ratelimit.reset_rate_limits()
    llm.reset_concurrency_gate()
    # 账号生命周期（M2a）的进程内密码失败限流/导出生成标记按用例隔离。
    account_lifecycle.reset_password_throttle()
    account_export.reset_export_state()

    # 维护模式的 5 秒进程内缓存也属于模块级全局状态。
    account.reset_settings_cache()
    # 让「模型是否可用」与本机 .env 无关，断言可重复。
    # Qwen 的端点必须同时给（openai_compatible 模型只有 Key、没有 base_url 时
    # 视为不可用），见 llm.is_available。
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-deepseek-key")
    monkeypatch.setenv("QWEN_API_KEY", "test-qwen-key")
    monkeypatch.setenv("QWEN_BASE_URL", "https://example.invalid/v1")

    yield tmp_path

    routes_videos._prefetch_cache.clear()
    routes_auth.reset_login_throttle()
    # 任务表执行权/告警标记是进程内状态，按用例隔离。
    jobs.reset_active_jobs()
    jobs.reset_warned_state()
    ratelimit.reset_rate_limits()
    llm.reset_concurrency_gate()
    local_dict.reset()
    account.reset_settings_cache()
    account_lifecycle.reset_password_throttle()
    account_export.reset_export_state()
    alerts.reset_state()


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

    # 内容发现：yt-dlp / 字幕轨道 / LLM 三处外部调用也必须显式 mock；
    # _call_llm 是异步入口，用 async 断言版本。
    async def _blocked_async(*args, **kwargs):
        raise AssertionError("离线测试中禁止真实外部调用")

    monkeypatch.setattr(discover, "_search_ytdlp", _blocked)
    monkeypatch.setattr(discover, "_probe_caption", _blocked)
    monkeypatch.setattr(discover, "_call_llm", _blocked_async)

    # 飞书告警的默认传输也换成断言：即使某用例误开告警，也不会真的连网。
    def _blocked_transport(*args, **kwargs):
        raise AssertionError("离线测试中禁止真实外部调用")

    monkeypatch.setattr(alerts, "_default_transport", _blocked_transport)


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
