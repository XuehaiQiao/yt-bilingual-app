"""应用装配（入口不变：uvicorn main:app --port 8000）。

模块分工见 backend/README.md：
- config.py          环境、路径、安全、模型目录、词汇水平
- auth_db.py         用户/会话 SQLite 存储 + Argon2 密码哈希
- events.py          学习事件日志（append-only；表由 Alembic 迁移创建）
- behavior_events.py CEFR M2 #7 行为埋点校验/幂等/去重（写 learning_events）
- routes_auth.py     注册 / 登录 / 登出 / 当前用户
- account.py         用户名 / 余额调账 / 用户页摘要 / app_settings + 维护模式
- routes_account.py  PATCH /api/user/profile、GET /api/user/summary（需登录）
- account_lifecycle.py 删除冷静期 / 硬删除 / 管理员审计（specs/033）
- account_export.py  数据导出 ZIP / 限流 / 下载 token / 过期清理（specs/033）
- routes_account_lifecycle.py /api/account/*（删除/导出；pending 账号可用）
- routes_admin_lifecycle.py  /api/admin/deletion-requests、/api/admin/audit
- auth_lockout.py    登录失败锁定（账号 + IP，进程内存）
- storage.py         当前用户的数据根目录（ContextVar，多用户隔离 + 按目标语言分目录）
- languages.py       目标语言注册表（targetLang 校验/NFC/prompt 语言名）
- transcripts.py     字幕获取与切句（YouTube / SRT / Whisper 兜底）
- translate.py       Gemini 翻译、id 对齐、自愈续译、流式生成、总结
- routes_videos.py   估价 / 处理 / 流式 / 历史 / 频道更新
- routes_content.py  本地剧集 + 句子精背
- routes_user.py     词典 / 收藏 / 订阅
- routes_vocabulary.py 单词本词表目录 / 分页搜索 / 词级 CEFR（公开只读）
- routes_review.py   生词复习队列 / 作答 / 暂停 / 统计（M2）
- routes_quiz.py     理解题出题 / 作答 / 结果（M3）
- course.py          课程 MVP：课程包校验/脱敏、attempt 进度、判分、埋点（specs/029）
- routes_course.py   课程 MVP 路由（需登录）：课程/attempt/答题/步骤/产出/完成/事件
- teaching_analysis.py AI 教学分析（高亮/习语/文化点）按内容+等级+语言缓存（specs/028）
- routes_teaching_analysis.py 教学分析只读端点（GET /api/teaching-analysis/{ref}）
- routes_events.py   学习事件上报 / 周报（M5）
- routes_placement.py 能力定位测 / 能力画像（M4）
- routes_exam.py     考试练习：题型 / 抽题 / 提交 / 历史（V2）
- discover.py        内容发现：意图改写 / 搜索 / 字幕探测 / 重排 / 24h 缓存（V1）
- routes_discover.py POST /api/discover（需登录）
- recommend.py       规则推荐：画像区间 + 已看历史 + 人工精选池（V1）
- routes_recommend.py GET /api/recommendations（游客可用）
- routes_blog.py     官方博客：只读 content/blog/*.md + 安全 Markdown + RSS（V1）
- routes_book_import.py / routes_book_upload.py 我的书：公版书链接导入 / 本地 EPUB 上传（需登录）
- routes_admin.py    后台止血台：只读聚合用户/花费/任务/健康（需管理员，M1 ⑥）
- reports.py         观看事件 + 周报 SQL 聚合（M5）
- placement.py       定位测题库抽样 / 加权评分 / CEFR 区间 / 画像（M4）
- exam.py            考试题库校验 / 抽题 / 评分 / 历史（V2）
- observability.py   结构化访问日志 / request_id / 只读 /healthz

请求链路（从外到内）：CORS → 缓存默认值（P2-51）→ 访问日志（request_id）→
API_AUTH_KEY → 身份（会话 Cookie / 游客 Cookie，含进程内限速 429）→ 路由。
未显式声明 `Cache-Control` 的 `/api/*` 响应统一补 `private, no-store` +
`Vary: Cookie`（见下方 `default_api_cache_policy`）。

身份规则（M1 ⑧ 游客态，见 guest.py）：

- 有有效 `ln_session` → 登录用户，数据写 `data/users/<id>/`；
- 无会话、有合法 `ln_guest` → 游客，数据写 `data/guests/<sha256>/`；
- 都没有 → 中间件下发新的 32 字节随机 `ln_guest`，本请求即游客（所以
  `GET /api/auth/me` 首次访问就能返回 `{user:null, guest:true}`）；
- 除认证路由自己要求的登录（如 `claim-guest`）外，纯读取 `/api/*` 允许游客
  访问；**所有会触发 AI 的入口（查词/视频/字幕/本地视频/书籍翻译）游客一律
  403 `login_required`**（M7a，specs/036）：中间件在认证后、限流前统一拦，
  路由里的 `ai_auth.require_ai_user` 是第二道防线。游客的估价仍走更紧的
  进程内限速（见 ratelimit.py）。
- `/api/blog/*`、`/api/library/*`、`/api/books*` 是**公开只读**内容（与
  /api/auth、/health 同列）：不需要登录，中间件也不为它们创建游客身份、
  不下发 `ln_guest`；博客只来自仓库内 Markdown，免费资源库只来自仓库内 JSON，
  公版书只存书目与中译文，英文原文按请求从公版源实时抓取。
  其中 `/api/books/import*`、`/api/books/upload*` 与 `/api/books/imported*` 是
  **登录用户**的导入/上传功能（路由内 401），沿用公开前缀只是为了避免给这些
  端点签发游客 Cookie。

Starlette 里后注册的中间件更靠外层，所以 CORS 放在文件最后注册。
"""
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import account
import auth_db
import billing
import config
import events
import guest
import observability
import ratelimit
from ai.ledger import QuotaExceeded
import routes_ability
import routes_account
import routes_account_lifecycle
import routes_admin
import routes_admin_lifecycle
import routes_auth
import routes_blog
import routes_book_import
import routes_book_upload
import routes_books
import routes_content
import routes_course
import routes_difficulty
import routes_discover
import routes_events
import routes_exam
import routes_feedback
import routes_library
import routes_local_video
import routes_placement
import routes_quiz
import routes_reading
import routes_recommend
import routes_review
import routes_teaching_analysis
import routes_user
import routes_videos
import routes_vocabulary
import routes_wordlists
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


@app.exception_handler(billing.BillingError)
async def billing_error_handler(_request, exc: billing.BillingError):
    """计费域异常统一映射（M3a）：余额不足 402、未迁移 503、冲突 409、404。

    402 响应体固定包含 ``code=insufficient_balance`` 与
    ``balanceMicroUsd`` / ``requiredMicroUsd``（前端 M3b 直接读，不解析中文）。
    余额（402）与日配额/预算（429）语义独立，不要混成 500。
    """
    payload = (
        exc.payload()
        if hasattr(exc, "payload")
        else {"detail": str(exc), "code": getattr(exc, "code", "billing_error")}
    )
    return JSONResponse(
        status_code=int(getattr(exc, "status_code", 500)),
        content=payload,
        headers={"Cache-Control": "no-store"},
    )


@app.exception_handler(QuotaExceeded)
async def quota_exceeded_handler(_request, exc: QuotaExceeded):
    """配额/预算超限统一映射（M7a）：429 + 稳定 ``code``。

    ``code=quota_exceeded``（功能日配额）/``budget_exceeded``（用户/全站日预算）
    与 402 ``insufficient_balance`` 是三个独立语义，前端 M7b 直接读 code。
    以前各路由各自转 HTTPException，响应体只有中文 detail，前端无法稳定判断。
    """
    payload = (
        exc.payload()
        if hasattr(exc, "payload")
        else {"detail": str(exc), "code": "quota_exceeded"}
    )
    return JSONResponse(
        status_code=int(getattr(exc, "status_code", 429)),
        content=payload,
        headers={"Cache-Control": "no-store"},
    )


def _is_api_path(path: str) -> bool:
    return path == "/api" or path.startswith("/api/")


_PUBLIC_API_PREFIXES = (
    "/api/blog/",
    "/api/library/",
    "/api/books/",
    "/api/content/difficulty/",
    "/api/vocabulary/",
)
_PUBLIC_API_EXACT = frozenset(
    {
        "/api/blog",
        "/api/library",
        "/api/books",
        # can-do 是仓库内只读内容（A1–C1 × 4 技能），公开且不签发游客 Cookie。
        "/api/ability/can-do",
        # 内容难度公开只读（M2）：不需要登录，也不签发游客 Cookie。
        "/api/content/difficulty",
    }
)


# M7a：会调用大模型的入口（游客/匿名必须在**路由解析/限流之前** 403）。
# 这里的路径判定只做「明显会生成」的入口；路由内的 ai_auth.require_ai_user
# 是第二道防线（覆盖未来新增入口与 GET 触发生成的场景）。
_AI_GATE_EXACT = frozenset(
    {
        "/api/define",
        "/api/process-video",
        "/api/process-video-stream",
        "/api/process-subtitle",
        "/api/local-video/process",
    }
)
_AI_BOOK_TRANSLATE_RE = re.compile(r"^/api/books/[^/]+/chapters/[^/]+/translate$")
_AI_BOOK_CHAPTER_RE = re.compile(r"^/api/books/[^/]+/chapters/[^/]+$")


def _is_ai_generation_request(request) -> bool:
    """请求是否会触发 AI 生成（仅用于登录闸；缓存/公开读不在其中）。"""
    path = request.url.path
    if request.method == "OPTIONS":
        return False
    if path in _AI_GATE_EXACT:
        return True
    if request.method == "POST" and _AI_BOOK_TRANSLATE_RE.match(path):
        return True
    # 公版书章节 GET 默认只读；显式带 ?level= 才生成教学分析。
    if (
        request.method == "GET"
        and _AI_BOOK_CHAPTER_RE.match(path)
        and request.query_params.get("level")
    ):
        return True
    return False


def _is_public_api_path(path: str) -> bool:
    """公开只读端点：不需要登录，也不创建游客身份（博客/资源库/can-do）。"""
    if path in _PUBLIC_API_EXACT:
        return True
    return any(path.startswith(prefix) for prefix in _PUBLIC_API_PREFIXES)


# 维护模式白名单：认证（让管理员/用户能登录）、后台（管理员处置）、健康探针
# 不受影响；其余 /api/* 一律 503（管理员本人不受影响，见中间件）。
# 删除冷静期白名单：只允许认证与账号生命周期（取消/导出）；登录路由必须放行，
# 否则用户无法回来取消。其它 /api/*（含 AI/写学习数据）一律 403。
_PENDING_EXEMPT_PREFIXES = ("/api/auth/", "/api/account/")
_PENDING_EXEMPT_EXACT = {"/api/auth", "/api/account"}


def _is_pending_exempt(path: str) -> bool:
    if path in _PENDING_EXEMPT_EXACT:
        return True
    return any(path.startswith(prefix) for prefix in _PENDING_EXEMPT_PREFIXES)


_MAINTENANCE_EXEMPT_PREFIXES = ("/api/auth/", "/api/admin/")
_MAINTENANCE_EXEMPT_EXACT = {
    "/api/auth",
    "/api/admin",
    "/health",
    "/healthz",
}


def _is_maintenance_exempt(path: str) -> bool:
    if path in _MAINTENANCE_EXEMPT_EXACT:
        return True
    return any(path.startswith(prefix) for prefix in _MAINTENANCE_EXEMPT_PREFIXES)


@app.middleware("http")
async def resolve_identity(request, call_next):
    """解析会话/游客 Cookie → request.state + ContextVar；游客首次访问下发 Cookie。

    - 会话优先：有有效 `ln_session` 时忽略 `ln_guest`（登录用户的数据目录唯一）；
    - 游客 Cookie 只做形状校验，服务端用 sha256(token) 当目录名；非法/缺失时
      重新下发，**绝不把 Cookie 原文当路径**；
    - `/api/blog/*` 公开只读：跳过游客签发（不往公开页面塞身份 Cookie）；
    - 其余 `/api/*` 不再 401：游客可以估价、看视频、查词，但限速更紧；
    - 账号状态：``users.status='banned'`` 的旧会话在**下一次 /api 请求**直接
      403「账号已被停用」（不删会话，解封后原 Cookie 恢复）；
    - 维护模式：``app_settings.maintenance_mode=1`` 时非管理员访问非白名单
      ``/api/*`` 返回 503；管理员不受影响（可在后台关闭维护）。
    """
    if request.method == "OPTIONS":  # 让 CORS 预检通过
        return await call_next(request)

    user = None
    token = request.cookies.get(routes_auth.COOKIE_NAME)
    if token:
        user = auth_db.get_session(token)
    request.state.user = user

    path = request.url.path
    if user and (user.get("status") or account.STATUS_ACTIVE) == account.STATUS_BANNED:
        if _is_api_path(path):
            return JSONResponse(
                status_code=403,
                content={"detail": "账号已被停用"},
                headers={"Cache-Control": "no-store"},
            )

    if (
        user
        and (user.get("status") or account.STATUS_ACTIVE)
        == account.STATUS_DELETION_PENDING
        and _is_api_path(path)
        and not _is_pending_exempt(path)
    ):
        return JSONResponse(
            status_code=403,
            content={
                "detail": "账号正在删除冷静期，仅可取消删除或导出数据。",
                "code": "account_pending_deletion",
            },
            headers={"Cache-Control": "no-store"},
        )

    if (
        _is_api_path(path)
        and not _is_maintenance_exempt(path)
        and not (user and config.is_admin_email(user.get("email")))
        and account.maintenance_enabled()
    ):
        return JSONResponse(
            status_code=503,
            content={"detail": "系统维护中，请稍后重试。"},
            headers={"Cache-Control": "no-store"},
        )

    # 认证先于限流（M7a / 项目提案 §5.5）：游客/匿名访问 AI 生成入口一律 403
    # login_required，不再先消耗限速额度、也不会变成 429。不用 401：前端把 401
    # 当成会话过期并登出。
    if user is None and _is_ai_generation_request(request):
        return JSONResponse(
            status_code=403,
            content=billing.LoginRequired().payload(),
            headers={"Cache-Control": "no-store"},
        )

    guest_hash = None
    issued_guest_token = None
    if (
        user is None
        and _is_api_path(path)
        and not _is_public_api_path(path)
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


# P2-51：认证 API 的缓存默认值。只在响应**没有**显式 `Cache-Control` 时补，
# 所以 /api/library（public, max-age=300）、/api/books（public, max-age=300）、
# /api/recommendations（private, max-age=600）、SSE（no-cache）等既有策略不受
# 影响。注册在访问日志之后（比它更外层），才能覆盖身份中间件的 401/403/503；
# CORS 仍最后注册、在最外层，由它继续追加 Vary: Origin。
_DEFAULT_PRIVATE_CACHE_CONTROL = "private, no-store"
_LOGOUT_PATH = "/api/auth/logout"


@app.middleware("http")
async def default_api_cache_policy(request, call_next):
    """给未声明缓存策略的 `/api/*` 响应补「私有、不存储」默认值（P2-51）。

    认证 API 过去依赖「没写指令所以不会被共享缓存」这一默认结果；一旦前置
    CDN / 代理 / 中间盒开始缓存，同一 URL 不同用户的响应就会串号。这里在响应
    层兜底：未显式写 `Cache-Control` 的 `/api/*` 一律 `private, no-store` +
    `Vary: Cookie`，已显式写的不覆盖（公开只读端点保持 public 缓存）。错误
    响应（401/403/404/503）同样适用；静态资源与 `/health*` 不在范围内。

    退出登录额外补 `Clear-Site-Data: "cache"`：清掉浏览器里的私有 HTTP 缓存，
    但**不带** `"storage"`（localStorage / IndexedDB 由前端 storageScope 管理，
    见 P2-50），避免误清偏好与学习进度。
    """
    response = await call_next(request)
    path = request.url.path
    if not _is_api_path(path):
        return response
    if "cache-control" not in response.headers:
        response.headers["Cache-Control"] = _DEFAULT_PRIVATE_CACHE_CONTROL
        vary = response.headers.get("vary")
        if not vary:
            response.headers["Vary"] = "Cookie"
        elif "cookie" not in vary.lower():
            response.headers["Vary"] = f"{vary}, Cookie"
    if request.method == "POST" and path == _LOGOUT_PATH:
        response.headers.setdefault("Clear-Site-Data", '"cache"')
    return response


app.include_router(routes_auth.router)
app.include_router(routes_account.router)
app.include_router(routes_account_lifecycle.router)
app.include_router(routes_admin.router)
app.include_router(routes_admin_lifecycle.router)
app.include_router(routes_feedback.router)
app.include_router(routes_videos.router)
app.include_router(routes_content.router)
app.include_router(routes_difficulty.router)
app.include_router(routes_user.router)
app.include_router(routes_vocabulary.router)
app.include_router(routes_review.router)
app.include_router(routes_wordlists.router)
app.include_router(routes_quiz.router)
app.include_router(routes_course.router)
app.include_router(routes_teaching_analysis.router)
app.include_router(routes_events.router)
app.include_router(routes_placement.router)
app.include_router(routes_ability.router)
app.include_router(routes_exam.router)
app.include_router(routes_discover.router)
app.include_router(routes_reading.router)
app.include_router(routes_recommend.router)
app.include_router(routes_blog.router)
app.include_router(routes_library.router)
# 先注册「我的导入」：`GET /api/books/imported` 必须排在公开的
# `GET /api/books/{book_id}` 之前，否则会被当成 book_id="imported" 吞掉。
app.include_router(routes_book_import.router)
# 本地 EPUB 上传（specs/031）：`/api/books/upload*` 与 `/api/books/imported/*/cover`
# 均需登录；同样要排在公开的 `/api/books/{book_id}` 之前。
app.include_router(routes_book_upload.router)
app.include_router(routes_local_video.router)
app.include_router(routes_books.router)

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
