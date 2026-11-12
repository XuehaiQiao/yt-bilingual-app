"""离线冒烟测试的公共夹具。

两条硬约束：

1. **目录隔离**：每个用例都把 HISTORY_DIR 指到 pytest 的 tmp_path。
   config.py 在 import 时就算好目录并 makedirs，所以只设环境变量不够；
   这里直接覆盖已经 import 进各模块的模块级属性（routes_user 还把
   DICT_CACHE_FILE 等派生路径在 import 时算死了，一并覆盖）。
2. **完全离线**：llm.generate_json / generate_text、字幕抓取、视频元数据
   全部 monkeypatch；底层的真实传输函数也换成断言，任何漏掉的真实调用
   都会让用例失败，而不是悄悄连网。

另外：venv 里 fastapi 0.110 固定 starlette 0.36.3，而 httpx 已升到 0.28.1，
httpx 0.28 移除了 Client(app=...) 参数，starlette 0.36.3 的 TestClient 仍会
传它（starlette/testclient.py:429）。这里只在构造 TestClient 期间丢掉该
参数——starlette 自己用 transport 连 ASGI app，不依赖它。
"""
import contextlib
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import config  # noqa: E402
import llm  # noqa: E402
import local_dict  # noqa: E402
import routes_content  # noqa: E402
import routes_user  # noqa: E402
import routes_videos  # noqa: E402
import transcripts  # noqa: E402
import translate  # noqa: E402


@pytest.fixture(autouse=True)
def history_dir(tmp_path, monkeypatch):
    """每个用例独立的 HISTORY_DIR，返回 tmp_path 供断言落盘文件。"""
    monkeypatch.setattr(config, "HISTORY_DIR", str(tmp_path), raising=False)
    for mod in (routes_videos, routes_content, translate):
        monkeypatch.setattr(mod, "HISTORY_DIR", str(tmp_path), raising=False)
    monkeypatch.setattr(routes_user, "HISTORY_DIR", str(tmp_path), raising=False)
    # routes_user 的这些路径在 import 时就拼好了，必须单独覆盖
    monkeypatch.setattr(
        routes_user, "DICT_CACHE_FILE", str(tmp_path / "dictionary_cache.json")
    )
    monkeypatch.setattr(routes_user, "FAVORITES_FILE", str(tmp_path / "favorites.json"))
    monkeypatch.setattr(routes_user, "SUBS_FILE", str(tmp_path / "subscriptions.json"))

    # 本地词典也隔离：默认指向不存在的临时路径。否则只要本机下载过
    # data/ecdict.db，查词就会命中本地词典，让「走 LLM」的用例失去意义。
    # 需要测本地词典的用例再把它指到自建的小 sqlite。
    monkeypatch.setenv("LOCAL_DICT_PATH", str(tmp_path / "ecdict.db"))
    local_dict.reset()

    # 模块级全局缓存，用例之间要清干净，避免串味
    routes_videos._prefetch_cache.clear()

    # 让「模型是否可用」与本机 .env 无关，断言可重复
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-deepseek-key")

    yield tmp_path

    routes_videos._prefetch_cache.clear()
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
def client(history_dir):
    from fastapi.testclient import TestClient

    import main

    headers = {}
    if config.API_AUTH_KEY:  # .env 若开了 key 校验，测试也要带上
        headers["x-api-key"] = config.API_AUTH_KEY

    with _httpx_app_kwarg_compat():
        test_client = TestClient(main.app, headers=headers)
    with test_client:
        yield test_client
