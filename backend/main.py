"""应用装配（入口不变：uvicorn main:app --port 8000）。

模块分工见 backend/README.md：
- config.py          环境、路径、安全、模型目录、词汇水平
- auth_db.py         用户/会话 SQLite 存储 + Argon2 密码哈希
- events.py          学习事件日志（append-only；表由 Alembic 迁移创建）
- routes_auth.py     注册 / 登录 / 登出 / 当前用户
- auth_lockout.py    登录失败锁定（账号 + IP，进程内存）
- storage.py         当前用户的数据根目录（ContextVar，多用户隔离 + 按目标语言分目录）
- languages.py       目标语言注册表（targetLang 校验/NFC/prompt 语言名）
- transcripts.py     字幕获取与切句（YouTube / SRT / Whisper 兜底）
- translate.py       Gemini 翻译、id 对齐、自愈续译、流式生成、总结
- routes_videos.py   估价 / 处理 / 流式 / 历史 / 频道更新
- routes_content.py  本地剧集 + 句子精背
- routes_user.py     词典 / 收藏 / 订阅
- routes_review.py   生词复习队列 / 作答 / 暂停 / 统计（M2）
- routes_quiz.py     理解题出题 / 作答 / 结果（M3）
- routes_events.py   学习事件上报 / 周报（M5）
- routes_placement.py 能力定位测 / 能力画像（M4）
- discover.py        内容发现：意图改写 / 搜索 / 字幕探测 / 重排 / 24h 缓存（V1）
- routes_discover.py POST /api/discover（需登录）
- recommend.py       规则推荐：画像区间 + 已看历史 + 人工精选池（V1）
- routes_recommend.py GET /api/recommendations（游客可用）
- routes_blog.py     官方博客：只读 content/blog/*.md + 安全 Markdown + RSS（V1）
- routes_admin.py    后台止血台：只读聚合用户/花费/任务/健康（需管理员，M1 ⑥）
- reports.py         观看事件 + 周报 SQL 聚合（M5）
- placement.py       定位测题库抽样 / 加权评分 / CEFR 区间 / 画像（M4）
- observability.py   结构化访问日志 / request_id / 只读 /healthz

请求链路（从外到内）：CORS → 访问日志（request_id）→ API_AUTH_KEY → 身份
（会话 Cookie / 游客 Cookie，含进程内限速 429）→ 路由。

身份规则（M1 ⑧ 游客态，见 guest.py）：

- 有有效 `ln_session` → 登录用户，数据写 `data/users/<id>/`；
- 无会话、有合法 `ln_guest` → 游客，数据写 `data/guests/<sha256>/`；
- 都没有 → 中间件下发新的 32 字节随机 `ln_guest`，本请求即游客（所以
  `GET /api/auth/me` 首次访问就能返回 `{user:null, guest:true}`）；
- 除认证路由自己要求的登录（如 `claim-guest`）外，`/api/*` 均允许游客访问；
  游客的估价/处理/查词走更紧的进程内限速（见 ratelimit.py），翻译总量也
  有累计上限（见 routes_videos.py / routes_content.py）。
- `/api/blog/*` 是**公开只读**内容（与 /api/auth、/health 同列）：不需要登录，
  中间件也不为它创建游客身份、不下发 `ln_guest`；文章只来自仓库内 Markdown。

Starlette 里后注册的中间件更靠外层，所以 CORS 放在文件最后注册。
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import auth_db
import config
import events
import guest
import observability
import ratelimit
import routes_admin
import routes_auth
import routes_blog
import routes_content
import routes_discover
import routes_events
import routes_placement
import routes_quiz
import routes_reading
import routes_recommend
import routes_review
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
    observability.configure_logging()
    events.log_schema_status()
    yield


app = FastAPI(lifespan=lifespan)


def _is_api_path(path: str) -> bool:
    return path == "/api" or path.startswith("/api/")


def _is_public_api_path(path: str) -> bool:
    """公开只读端点：不需要登录，也不创建游客身份（/api/blog/*）。"""
    return path == "/api/blog" or path.startswith("/api/blog/")


@app.middleware("http")
async def resolve_identity(request, call_next):
    """解析会话/游客 Cookie → request.state + ContextVar；游客首次访问下发 Cookie。

    - 会话优先：有有效 `ln_session` 时忽略 `ln_guest`（登录用户的数据目录唯一）；
    - 游客 Cookie 只做形状校验，服务端用 sha256(token) 当目录名；非法/缺失时
      重新下发，**绝不把 Cookie 原文当路径**；
    - `/api/blog/*` 公开只读：跳过游客签发（不往公开页面塞身份 Cookie）；
    - 其余 `/api/*` 不再 401：游客可以估价、看视频、查词，但限速更紧。
    """
    if request.method == "OPTIONS":  # 让 CORS 预检通过
        return await call_next(request)

    user = None
    token = request.cookies.get(routes_auth.COOKIE_NAME)
    if token:
        user = auth_db.get_session(token)
    request.state.user = user

    guest_hash = None
    issued_guest_token = None
    if (
        user is None
        and _is_api_path(request.url.path)
        and not _is_public_api_path(request.url.path)
    ):
        candidate = request.cookies.get(guest.COOKIE_NAME)
        if guest.is_valid_token(candidate):
            guest_hash = guest.hash_token(candidate)
        else:
            # 首次访问（或非法/伪造形状）：服务端签发新游客，本请求先按新身份处理。
            issued_guest_token = guest.new_token()
            guest_hash = guest.hash_token(issued_guest_token)
    request.state.guest_hash = guest_hash
    request.state.is_guest = bool(guest_hash)
    request.state.issued_guest_token = issued_guest_token

    # 数据隔离的关键：本请求内所有 storage.*() 都指向该用户/游客自己的目录。
    user_token = storage.current_user_id.set(user["id"] if user else None)
    guest_token = storage.current_guest_hash.set(guest_hash if user is None else None)
    try:
        # 安全最小集（M1 ⑦）：注册/登录按 IP，估价/处理/查词按用户；游客同桶、
        # 更紧的上限，按 sha256 计数。超限统一 429 + Retry-After。
        retry_after = ratelimit.check_request(
            request, user, guest_hash=None if user else guest_hash
        )
        if retry_after is not None:
            response = ratelimit.rate_limited_response(retry_after)
        else:
            response = await call_next(request)
        # 新游客的 Cookie 必须在响应发出前挂上；带上它的前端下一次请求才能找回
        # 同一个游客目录（估价/处理/查词产生的数据才不会丢）。
        if issued_guest_token is not None:
            guest.set_guest_cookie(response, issued_guest_token)
        return response
    finally:
        storage.current_guest_hash.reset(guest_token)
        storage.current_user_id.reset(user_token)


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


@app.middleware("http")
async def structured_access_log(request, call_next):
    """每请求一行 JSON + ``X-Request-ID``；敏感值不落日志（见 observability.py）。

    注册在认证中间件之后、CORS 之前：这样 401/403 也会被记录，CORS 又能在
    最外层给所有响应（含异常兜底的 500）补上跨域头。
    """
    return await observability.record_request(request, call_next)


app.include_router(routes_auth.router)
app.include_router(routes_admin.router)
app.include_router(routes_videos.router)
app.include_router(routes_content.router)
app.include_router(routes_user.router)
app.include_router(routes_review.router)
app.include_router(routes_quiz.router)
app.include_router(routes_events.router)
app.include_router(routes_placement.router)
app.include_router(routes_discover.router)
app.include_router(routes_reading.router)
app.include_router(routes_recommend.router)
app.include_router(routes_blog.router)

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
    """存活探针：只说明进程还在，不碰数据库。"""
    return {"status": "ok"}


@app.get("/healthz")
def health_check_detailed():
    """就绪探针：版本、只读 DB 检查、迁移版本、uptime、时间。

    - DB 可读时 ``status=ok``（HTTP 200），否则 ``status=degraded``（HTTP 503）；
    - 任何检查失败都不抛 500，也不创建/修改数据库文件；
    - ``db.migrations.current != head`` 表示库已可读但迁移未跟上，按字段展示，
      由运维/告警判断，不阻断进程存活。
    """
    snapshot = observability.health_snapshot()
    return JSONResponse(
        status_code=200 if snapshot["status"] == "ok" else 503,
        content=snapshot,
        headers={"Cache-Control": "no-store"},
    )
