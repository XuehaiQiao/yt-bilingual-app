"""容器内单进程入口：FastAPI + 前端静态文件（SPA fallback）。

为什么需要这个文件
------------------
后端 ``backend/main.py`` 只提供 API（``/api/*``、``/health``、``/healthz``），
不托管前端。本地开发是 Vite 5173 + uvicorn 8000；生产镜像里没有 Node，也不想
为了几个静态文件再塞一个 Caddy，所以由这个 **部署层** 小包装把 ``frontend/dist``
挂到同一个 uvicorn 进程：

- ``/api``、``/api/*``、``/health``、``/healthz``、``/openapi.json``、``/docs``
  原样交给 FastAPI；
- 其它路径优先按文件返回；``/assets/*`` 缺失返回 404（避免把 JS 请求回成 HTML）；
- 其余未命中路径返回 ``index.html``（React Router 深链刷新不 404）。

它不修改业务代码，本地开发方式也不变；只在镜像里由
``uvicorn serve:app`` 使用（见 Dockerfile / entrypoint.sh）。
"""

from __future__ import annotations

import os
from pathlib import Path

from starlette.datastructures import MutableHeaders
from starlette.responses import FileResponse, PlainTextResponse
from starlette.staticfiles import StaticFiles
from starlette.types import Receive, Scope, Send

# backend/ 在 PYTHONPATH 里（Dockerfile 设置），这里导入的是同一个 FastAPI app。
import main as api

DIST = Path(os.environ.get("FRONTEND_DIST", "/app/frontend/dist")).resolve()
INDEX = DIST / "index.html"

# StaticFiles 初始化时会检查目录存在；缺 dist 时让容器启动失败，比线上 404 好排查。
_static = StaticFiles(directory=str(DIST))

_API_EXACT = {"/api", "/health", "/healthz", "/openapi.json"}
_API_PREFIXES = ("/api/", "/docs", "/redoc")


def _is_api_path(path: str) -> bool:
    return path in _API_EXACT or path.startswith(_API_PREFIXES)


async def _send_with_cache(message: dict, path: str, send: Send) -> None:
    """给静态响应补 Cache-Control：带 hash 的 assets 长缓存，入口文件不缓存。"""
    if message["type"] == "http.response.start":
        headers = MutableHeaders(scope=message)
        if path.startswith("/assets/"):
            headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif path == "/sw.js" or path.endswith(".html"):
            # Service Worker 与 HTML 必须每次回源，否则发版后用户拿旧壳。
            headers["Cache-Control"] = "no-cache"
        else:
            headers.setdefault("Cache-Control", "public, max-age=3600")
    await send(message)


class App:
    """把静态文件请求分流到 StaticFiles，其余交给 FastAPI 的 ASGI app。

    顶层对象不是 Starlette App，所以 lifespan 原样转发给 FastAPI —— 后端的
    ``configure_logging()`` / 迁移状态告警都照常执行。
    """

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await api.app(scope, receive, send)
            return

        path = scope.get("path") or "/"
        if _is_api_path(path):
            await api.app(scope, receive, send)
            return

        rel = path.lstrip("/")
        candidate = (DIST / rel).resolve()
        try:
            candidate.relative_to(DIST)
        except ValueError:
            # 路径穿越（..）或绝对路径逃出 dist：按 404 处理，绝不读目录外文件。
            await PlainTextResponse("Not Found", status_code=404)(scope, receive, send)
            return

        if candidate.is_file():
            await _static(scope, receive, lambda message: _send_with_cache(message, path, send))
            return

        if path.startswith("/assets/"):
            await PlainTextResponse("Not Found", status_code=404)(scope, receive, send)
            return

        if not INDEX.is_file():
            await PlainTextResponse(
                "frontend/dist/index.html 不存在；镜像构建不完整。",
                status_code=500,
            )(scope, receive, send)
            return

        await FileResponse(INDEX, headers={"Cache-Control": "no-cache"})(
            scope, receive, send
        )


app = App()
