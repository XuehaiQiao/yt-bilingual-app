"""可观测性（M1c）：结构化日志、request_id 与只读健康检查。

设计约束：

- **零新依赖**：JSON 日志用标准库 ``logging``/``json``；迁移版本用随 Alembic
  引入的 SQLAlchemy + Alembic 只读接口（``ScriptDirectory`` / ``MigrationContext``）。
- **访问日志只记元数据**：method / path / status / duration_ms / request_id
  / user_id（已登录时）。**不记 query、body、Cookie、请求头**，所以密码、
  API Key、``X-API-Key`` 不会进日志；``path`` 本身不含 query。
- **一行一个 JSON**：访问日志的 message 就是 JSON 对象，``JsonFormatter`` 会
  把它摊平成一行（附 time/level/logger）；异常日志同样是单行 JSON，并带
  ``request_id`` 与完整堆栈。
- **健康检查只读**：SQLite 用 ``mode=ro`` 打开；迁移版本只读
  ``alembic_version``。读取失败返回 degraded，绝不让 ``/healthz`` 抛 500，
  也不会因为一次自检建出空库。
"""
from __future__ import annotations

import json
import logging
import re
import time
import uuid
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from alembic.config import Config as AlembicConfig
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from fastapi.responses import JSONResponse
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool

import config

REQUEST_ID_HEADER = "X-Request-ID"

_BACKEND_DIR = Path(__file__).resolve().parent
_ALEMBIC_INI = _BACKEND_DIR / "alembic.ini"

# 进程启动时刻：用于 /healthz 的 uptime_seconds（monotonic，不受系统时钟回拨影响）。
_PROCESS_STARTED = time.monotonic()

# 请求级上下文：异常日志与访问日志都从这里取 request_id，不靠调用方层层传参。
_request_id_ctx: ContextVar[str | None] = ContextVar("request_id", default=None)

# 接受客户端传入的 request_id（便于和反代/前端日志对齐），但只接受安全字符；
# 不合法就换新 id，避免把换行/控制字符带进日志。
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{8,64}$")

access_logger = logging.getLogger("linguatrek.access")
error_logger = logging.getLogger("linguatrek.error")
health_logger = logging.getLogger("linguatrek.health")

_configured = False


def _iso_utc(ts: float | None = None) -> str:
    """UTC ISO8601（毫秒精度，Z 结尾）。"""
    moment = (
        datetime.fromtimestamp(ts, timezone.utc)
        if ts is not None
        else datetime.now(timezone.utc)
    )
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


class JsonFormatter(logging.Formatter):
    """把日志记录输出为一行 JSON。

    访问日志的 message 本身就是 JSON 对象（见 ``_emit_access``），这里把它
    摊平成顶层字段；其它日志则包成 ``{message, ...}``。异常堆栈放在 ``stack``
    字段里，JSON 转义后仍是一行。
    """

    def format(self, record: logging.LogRecord) -> str:
        message = record.getMessage()
        payload: dict | None = None
        if message.startswith("{"):
            try:
                candidate = json.loads(message)
            except (TypeError, ValueError):
                candidate = None
            if isinstance(candidate, dict):
                payload = candidate

        if payload is None:
            payload = {"message": message}

        payload.setdefault("time", _iso_utc(record.created))
        payload.setdefault("level", record.levelname.lower())
        payload.setdefault("logger", record.name)

        request_id = getattr(record, "request_id", None) or _request_id_ctx.get()
        if request_id and "request_id" not in payload:
            payload["request_id"] = request_id

        if record.exc_info:
            payload["stack"] = self.formatException(record.exc_info)

        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging() -> None:
    """按 ``LOG_LEVEL`` / ``LOG_JSON`` 配置一次应用日志。"""
    global _configured
    if _configured:
        return

    level = getattr(logging, str(config.LOG_LEVEL).upper(), logging.INFO)
    app_logger = logging.getLogger("linguatrek")
    app_logger.setLevel(level)

    handler = logging.StreamHandler()
    if config.LOG_JSON:
        handler.set_name("linguatrek-json")
        handler.setFormatter(JsonFormatter())
    else:
        handler.set_name("linguatrek-text")
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
        )
    app_logger.addHandler(handler)

    # 应用内中间件已经每请求记一行（JSON 或文本）；关掉 uvicorn 的纯文本
    # access log，避免同一请求打两行（uvicorn 的 error / startup 日志保留）。
    logging.getLogger("uvicorn.access").disabled = True

    # HTTP 客户端会把完整 URL（含 query）打到 INFO；query 里可能带 API Key。
    # 这里压到 WARNING，避免第三方日志绕过「访问日志只记 path」的脱敏约定。
    for noisy in ("httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    _configured = True


def _duration_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 2)


def _request_id_from(raw: str | None) -> str:
    candidate = (raw or "").strip()
    if _REQUEST_ID_RE.fullmatch(candidate):
        return candidate
    return uuid.uuid4().hex


def _access_payload(
    request, request_id: str, status: int, duration_ms: float
) -> dict:
    payload = {
        "event": "http_request",
        "request_id": request_id,
        "method": request.method,
        "path": request.url.path,
        "status": status,
        "duration_ms": duration_ms,
    }
    user = getattr(request.state, "user", None)
    if isinstance(user, dict) and user.get("id"):
        payload["user_id"] = user["id"]
    return payload


def _emit_access(payload: dict) -> None:
    """访问日志：4xx 记 warning、5xx 记 error，其余 info。"""
    status = int(payload.get("status", 0))
    level = (
        logging.ERROR
        if status >= 500
        else logging.WARNING
        if status >= 400
        else logging.INFO
    )
    access_logger.log(
        level,
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str),
    )


async def record_request(request, call_next):
    """访问日志中间件：设置 request_id、记录一行 JSON、兜底未处理异常。

    只记录 ``request.url.path``——**不含 query**、不读 body/header，因此
    登录密码、``X-API-Key``、API Key 查询参数都不会落日志。
    """
    request_id = _request_id_from(request.headers.get(REQUEST_ID_HEADER))
    request.state.request_id = request_id
    token = _request_id_ctx.set(request_id)
    started = time.perf_counter()

    try:
        try:
            response = await call_next(request)
        except Exception:
            duration_ms = _duration_ms(started)
            error_logger.exception(
                "未处理的异常：%s %s",
                request.method,
                request.url.path,
                extra={"request_id": request_id},
            )
            _emit_access(
                _access_payload(request, request_id, 500, duration_ms)
            )
            response = JSONResponse(
                status_code=500,
                content={"detail": "服务器内部错误", "request_id": request_id},
            )
        else:
            _emit_access(
                _access_payload(
                    request, request_id, response.status_code, _duration_ms(started)
                )
            )
        response.headers[REQUEST_ID_HEADER] = request_id
        return response
    finally:
        _request_id_ctx.reset(token)


# --- /healthz 的只读检查 ---------------------------------------------------


def alembic_head() -> str | None:
    """当前代码里的迁移 head（只读脚本目录，不执行迁移、不碰数据库）。"""
    config_file = AlembicConfig(str(_ALEMBIC_INI))
    return ScriptDirectory.from_config(config_file).get_current_head()


def _migration_current(db_path: Path) -> str | None:
    """以只读方式读取 ``alembic_version``，不建库、不建表、不写版本号。"""
    url = f"sqlite:///file:{quote(str(db_path), safe='/')}?mode=ro&uri=true"
    engine = create_engine(url, poolclass=NullPool, connect_args={"timeout": 2})
    try:
        with engine.connect() as connection:
            return MigrationContext.configure(connection).get_current_revision()
    finally:
        engine.dispose()


def check_database() -> dict:
    """只读检查数据库；任何失败都转成 ``ok=False``，不向上抛。"""
    try:
        head = alembic_head()
    except Exception as exc:  # 配置/脚本目录损坏：健康检查也不能 500
        health_logger.warning("读取 Alembic head 失败：%s", exc)
        head = None

    path = Path(config.AUTH_DB_PATH)
    current = None
    ok = False
    if path.is_file():
        try:
            current = _migration_current(path)
            ok = True
        except Exception as exc:  # 文件损坏/无权限/不是 SQLite：degraded
            health_logger.warning("健康检查读取数据库失败（只读）：%s", exc)

    return {"ok": ok, "migrations": {"current": current, "head": head}}


def health_snapshot() -> dict:
    """``/healthz`` 的响应体；保证只读且不抛 500。"""
    try:
        db = check_database()
    except Exception as exc:  # 最后一道保险
        health_logger.warning("健康检查失败：%s", exc)
        db = {"ok": False, "migrations": {"current": None, "head": None}}

    return {
        "status": "ok" if db["ok"] else "degraded",
        "version": config.APP_VERSION,
        "db": db,
        "uptime_seconds": round(time.monotonic() - _PROCESS_STARTED, 3),
        "time": _iso_utc(),
    }
