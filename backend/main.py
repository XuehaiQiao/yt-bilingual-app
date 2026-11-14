"""应用装配（入口不变：uvicorn main:app --port 8000）。

模块分工见 backend/README.md：
- config.py          环境、路径、安全、模型目录、词汇水平
- auth_db.py         用户/会话 SQLite 存储 + Argon2 密码哈希
- events.py          学习事件日志（append-only；表由 Alembic 迁移创建）
- routes_auth.py     注册 / 登录 / 登出 / 当前用户
- storage.py         当前用户的数据根目录（ContextVar，多用户隔离）
- transcripts.py     字幕获取与切句（YouTube / SRT / Whisper 兜底）
- translate.py       Gemini 翻译、id 对齐、自愈续译、流式生成、总结
- routes_videos.py   估价 / 处理 / 流式 / 历史 / 频道更新
- routes_content.py  本地剧集 + 句子精背
- routes_user.py     词典 / 收藏 / 订阅

请求链路（从外到内）：CORS → API_AUTH_KEY → 用户会话 → 路由。
Starlette 里后注册的中间件更靠外层，所以 CORS 放在文件最后注册。
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import auth_db
import config
import events
import routes_auth
import routes_content
import routes_user
import routes_videos
import storage


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """启动时只读检查迁移状态：只告警，不建表、不阻断启动。

    users/sessions 仍保留 auth_db 的「连库即建表」兼容路径；learning_events 等新表
    一律由 Alembic 创建（backend/migrations/）。这里把「库存在但没迁移」显式说出来，
    否则事件会静默写不进去。
    """
    events.log_schema_status()
    yield


app = FastAPI(lifespan=lifespan)


def _is_public_api_path(path: str) -> bool:
    """/api/auth/* 由路由自己处理（me/logout 需要读会话，但不强制登录）。"""
    return path == "/api/auth" or path.startswith("/api/auth/")


@app.middleware("http")
async def require_user_session(request, call_next):
    """解析 Cookie → 查会话 → request.state.user + ContextVar；未登录拦截 /api。"""
    if request.method == "OPTIONS":  # 让 CORS 预检通过
        return await call_next(request)

    user = None
    token = request.cookies.get(routes_auth.COOKIE_NAME)
    if token:
        user = auth_db.get_session(token)
    request.state.user = user

    # 数据隔离的关键：本请求内所有 storage.*() 都指向该用户自己的目录。
    context_token = storage.current_user_id.set(user["id"] if user else None)
    try:
        if (
            request.url.path.startswith("/api")
            and not _is_public_api_path(request.url.path)
            and user is None
        ):
            return JSONResponse(status_code=401, content={"detail": "未登录"})
        return await call_next(request)
    finally:
        storage.current_user_id.reset(context_token)


@app.middleware("http")
async def require_api_key(request, call_next):
    """公网部署的可选额外门禁：设了 API_AUTH_KEY 就仍要求 X-API-Key。

    它与用户会话共存、互不替代：两者都满足才放行。CORS 预检永远放行。
    """
    if (
        config.API_AUTH_KEY
        and request.url.path.startswith("/api")
        and request.method != "OPTIONS"
        and request.headers.get("x-api-key") != config.API_AUTH_KEY
    ):
        return JSONResponse(
            status_code=401, content={"detail": "缺少或错误的 API Key。"}
        )
    return await call_next(request)


app.include_router(routes_auth.router)
app.include_router(routes_videos.router)
app.include_router(routes_content.router)
app.include_router(routes_user.router)

# 必须最后注册：Starlette 后注册的中间件在最外层，401 响应才能带上 CORS 头，
# 浏览器里的前端才看得到真正的错误信息。
#
# 浏览器不允许「带凭据的跨域请求」使用 Access-Control-Allow-Origin: *。
# 默认 CORS_ORIGINS=* 时改用匹配所有 Origin 的正则，让 Starlette 回显请求的
# Origin——否则本地前后端分离（5173 → 8000）时，首个 login/signup 响应会因为
# credentials: include 被浏览器 CORS 拦截。公网部署仍应设置 CORS_ORIGINS。
if config.ALLOWED_ORIGINS == ["*"]:
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=".*",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.ALLOWED_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.get("/health")
def health_check():
    return {"status": "ok"}
