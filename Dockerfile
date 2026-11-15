# =============================================================================
# 语途（LinguaTrek）生产镜像 —— 多阶段构建
#
#   node 阶段：构建 frontend/dist（VITE_API_BASE 在构建期写死，改域名必须重建）
#   python 阶段：python:3.12-slim + FastAPI/uvicorn + dist 静态文件，单进程
#
# 构建（生产域名必须显式传入，否则浏览器会去请求 127.0.0.1:8000）：
#   docker build --build-arg VITE_API_BASE=https://ln.example.com -t linguatrek .
#
# 本地同域预览（浏览器访问 http://127.0.0.1:8000）：
#   docker build --build-arg VITE_API_BASE=http://127.0.0.1:8000 -t linguatrek .
#
# 运行时环境变量不要 COPY .env 进镜像；用：
#   docker run --env-file .env ...        # 或 docker compose 的 env_file
# 完整步骤见 docs/部署指南.md。
# =============================================================================

# ---------- 1) 前端构建 ----------
FROM node:22-bookworm-slim AS web

WORKDIR /web

# 先只复制锁文件，利用 Docker 层缓存：源码改动不会重新 npm ci。
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./

# 前端 api.ts 在构建期读取 VITE_API_BASE；空值会回落到 http://127.0.0.1:8000。
# 这里强制要求显式传入，避免生产镜像带着 localhost 上线。
ARG VITE_API_BASE
RUN test -n "$VITE_API_BASE" || \
    (echo "ERROR: --build-arg VITE_API_BASE=https://your.domain 必填" >&2; exit 1)
ENV VITE_API_BASE=${VITE_API_BASE}
# tsc -b && vite build
RUN npm run build

# ---------- 2) Python 运行时 ----------
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app:/app/backend \
    FRONTEND_DIST=/app/frontend/dist

# sqlite3：scripts/backup.sh / restore.sh 的一致性快照与恢复校验需要它；
# curl：HEALTHCHECK 与排障用。装完立即清 apt 列表，保持镜像小。
RUN apt-get update \
 && apt-get install -y --no-install-recommends sqlite3 curl \
 && rm -rf /var/lib/apt/lists/*

# 非 root 运行。UID/GID 固定为 1000：命名卷会继承 /data 的属主；
# 若改用宿主机 bind mount，需在宿主机 chown 1000:1000（见部署指南）。
RUN groupadd --gid 1000 ln \
 && useradd --uid 1000 --gid 1000 --create-home --shell /usr/sbin/nologin ln

WORKDIR /app/backend

# 先装依赖，再拷源码，保持缓存命中。
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
# content/ 是运行期只读数据（句子精背、定位测、考试题库、博客等），必须进镜像。
COPY content/ /app/content/
# 前端构建产物与容器内静态服务入口。
COPY --from=web /web/dist /app/frontend/dist
COPY deploy/serve.py /app/serve.py
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh

# /data 是唯一持久化位置：app.db（用户/会话/迁移）+ users/ + guests/ + history/ ...
# 命名卷首次创建时会继承这里的属主（ln:ln）；镜像本身不包含任何业务数据。
RUN chmod 755 /usr/local/bin/entrypoint.sh \
 && mkdir -p /data/history /data/subtitles /data/users /data/guests \
 && chown -R ln:ln /data

# 数据根与静态内容路径。密钥、CORS、COOKIE_SECURE 等由 env 文件注入，
# 不写进镜像（更不要写死密钥）。
ENV DATA_DIR=/data \
    AUTH_DB_PATH=/data/app.db \
    USER_DATA_DIR=/data/users \
    GUEST_DATA_DIR=/data/guests \
    HISTORY_DIR=/data/history \
    SUBTITLES_DIR=/data/subtitles \
    SENTENCES_DIR=/app/content/sentences \
    PLACEMENT_DIR=/app/content/placement \
    EXAM_DIR=/app/content/exam \
    CURATED_CONTENT_PATH=/app/content/curated.json \
    BLOG_DIR=/app/content/blog \
    LOCAL_DICT_PATH=/data/ecdict.db

EXPOSE 8000
VOLUME ["/data"]

# /healthz 是就绪检查（DB 只读检查 + 迁移版本）；503 时 curl -f 退出非 0。
# start-period 给首次迁移/冷启动留时间。Docker 的 HEALTHCHECK 只标记状态，
# 不会自动重启容器；监控请另接（见部署指南）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS -o /dev/null http://127.0.0.1:8000/healthz || exit 1

STOPSIGNAL SIGTERM
USER ln

# 无参数 -> 启动服务；有参数 -> 直接执行（如 `alembic upgrade head`）。
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
