#!/bin/sh
# 语途（LinguaTrek）容器入口。
#
# - 无参数：确认 /data 可写后，以单进程 uvicorn 启动 API + 静态文件；
# - 有参数：直接 exec 该命令，供一次性运维任务使用，例如：
#     docker compose run --rm app alembic upgrade head
#     docker compose run --rm app alembic current
#
# 单 worker 是硬约束：SQLite 单写进程 + 进程内限流/缓存（见 docs/计划-上线部署.md C13）。
set -eu

if [ "$#" -gt 0 ]; then
    exec "$@"
fi

: "${DATA_DIR:=/data}"
: "${AUTH_DB_PATH:=/data/app.db}"
: "${USER_DATA_DIR:=/data/users}"
: "${GUEST_DATA_DIR:=/data/guests}"
: "${HISTORY_DIR:=/data/history}"
: "${SUBTITLES_DIR:=/data/subtitles}"
: "${FRONTEND_DIST:=/app/frontend/dist}"

mkdir -p "$HISTORY_DIR" "$SUBTITLES_DIR" "$USER_DATA_DIR" "$GUEST_DATA_DIR" \
    "$(dirname "$AUTH_DB_PATH")"

if [ ! -w "$DATA_DIR" ]; then
    echo "ERROR: 数据目录不可写：$DATA_DIR" >&2
    echo "  命名卷：通常会自动继承镜像里 /data 的属主（UID 1000）。" >&2
    echo "  bind mount：在宿主机执行 sudo chown -R 1000:1000 <宿主数据目录>。" >&2
    exit 1
fi

if [ ! -f "$FRONTEND_DIST/index.html" ]; then
    echo "ERROR: 前端构建产物缺失：$FRONTEND_DIST/index.html" >&2
    echo "  请用仓库根 Dockerfile 重建镜像（node 阶段会生成 dist）。" >&2
    exit 1
fi

cd /app/backend

# --forwarded-allow-ips='*'：容器内看到的是 Docker 网桥网关地址，不是 127.0.0.1；
# compose 只把端口发布到宿主机 127.0.0.1，前面必须再放一层 TLS 反代（Caddy），
# 因此信任上游 X-Forwarded-* 是安全的。裸机 systemd 版本则只信任 127.0.0.1。
exec uvicorn serve:app \
    --host 0.0.0.0 \
    --port 8000 \
    --workers 1 \
    --proxy-headers \
    --forwarded-allow-ips='*' \
    --timeout-keep-alive 75
