#!/usr/bin/env bash
# LinguaTrek（语途）本地备份脚本 —— M1 ③ 备份部分。
#
# 做什么：
#   1. 用 sqlite3 .backup 生成 WAL 安全的 app.db 快照（没有 sqlite3 时退化为文件复制）；
#   2. 复制用户数据目录（默认 data/users，支持 USER_DATA_DIR）；
#   3. 只收集“配置键名”与 .env.example 模板（不备份 .env 的值、不打印任何密钥）；
#   4. 打成 backups/linguatrek-backup-YYYYmmdd-HHMMSS.tar.gz，默认只保留最近 7 份。
#
# 用法：
#   scripts/backup.sh                 # 使用仓库默认 data/ 与 backups/
#   scripts/backup.sh --keep 14       # 保留最近 14 份
#   BACKUP_ROOT=/srv/ln/backups DATA_DIR=/srv/ln/data scripts/backup.sh
#
# 环境变量：
#   DATA_DIR       数据根目录（默认 <repo>/data）
#   AUTH_DB_PATH   SQLite 路径（默认 $DATA_DIR/app.db，优先级高于 DATA_DIR）
#   USER_DATA_DIR  用户数据根目录（默认 $DATA_DIR/users）
#   BACKUP_ROOT    备份输出目录（默认 <repo>/backups）
#   BACKUP_KEEP    保留份数（默认 7，可被 --keep 覆盖）
#   SQLITE3_BIN    sqlite3 可执行文件（默认 sqlite3，测试时可指向不存在以演练退化路径）
#   ENV_FILE       .env 路径（只读取键名；默认 <repo>/.env）
#   ENV_EXAMPLE    .env.example 路径（默认 <repo>/.env.example）
#
# 退出码：0 成功；非 0 失败。脚本不会修改 data/ 下的业务数据。
set -euo pipefail
umask 077  # 备份含 PII/口令哈希：新建文件默认仅属主可读写

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

DATA_DIR="${DATA_DIR:-$REPO_ROOT/data}"
DB_PATH="${AUTH_DB_PATH:-$DATA_DIR/app.db}"
USERS_DIR="${USER_DATA_DIR:-$DATA_DIR/users}"
BACKUP_ROOT="${BACKUP_ROOT:-$REPO_ROOT/backups}"
KEEP="${BACKUP_KEEP:-7}"
SQLITE3_BIN="${SQLITE3_BIN:-sqlite3}"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"
ENV_EXAMPLE="${ENV_EXAMPLE:-$REPO_ROOT/.env.example}"
PREFIX="linguatrek-backup"

# sqlite3 .backup 在 STAGE 中执行，路径必须绝对，避免相对路径指错位置。
case "$DATA_DIR" in /*) ;; *) DATA_DIR="$PWD/$DATA_DIR" ;; esac
case "$DB_PATH" in /*) ;; *) DB_PATH="$PWD/$DB_PATH" ;; esac
case "$USERS_DIR" in /*) ;; *) USERS_DIR="$PWD/$USERS_DIR" ;; esac
case "$BACKUP_ROOT" in /*) ;; *) BACKUP_ROOT="$PWD/$BACKUP_ROOT" ;; esac
case "$ENV_FILE" in /*) ;; *) ENV_FILE="$PWD/$ENV_FILE" ;; esac
case "$ENV_EXAMPLE" in /*) ;; *) ENV_EXAMPLE="$PWD/$ENV_EXAMPLE" ;; esac

log() { printf '[backup] %s\n' "$*"; }
warn() { printf '[backup] 警告：%s\n' "$*" >&2; }
die() { printf '[backup] 错误：%s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
LinguaTrek 备份脚本

用法：
  scripts/backup.sh                 # 使用仓库默认 data/ 与 backups/
  scripts/backup.sh --keep 14       # 保留最近 14 份
  BACKUP_ROOT=/srv/ln/backups DATA_DIR=/srv/ln/data scripts/backup.sh

环境变量：
  DATA_DIR       数据根目录（默认 <repo>/data）
  AUTH_DB_PATH   SQLite 路径（默认 $DATA_DIR/app.db，优先级高于 DATA_DIR）
  USER_DATA_DIR  用户数据根目录（默认 $DATA_DIR/users）
  BACKUP_ROOT    备份输出目录（默认 <repo>/backups）
  BACKUP_KEEP    保留份数（默认 7，可被 --keep 覆盖）
  SQLITE3_BIN    sqlite3 可执行文件（默认 sqlite3；设为不存在的路径可演练退化）
  ENV_FILE       .env 路径（只读取键名；默认 <repo>/.env）
  ENV_EXAMPLE    .env.example 路径（默认 <repo>/.env.example）
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --keep|-k)
      [ $# -ge 2 ] || die "--keep 需要一个正整数"
      KEEP="$2"
      shift 2
      ;;
    --keep=*)
      KEEP="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1（--help 查看用法）"
      ;;
  esac
done

case "$KEEP" in
  ''|*[!0-9]*) die "--keep 必须是正整数（当前：$KEEP）" ;;
esac
[ "$KEEP" -ge 1 ] || die "--keep 必须 >= 1"

[ -f "$DB_PATH" ] || die "找不到数据库：$DB_PATH（检查 DATA_DIR / AUTH_DB_PATH）"
[ -d "$USERS_DIR" ] || warn "用户数据目录不存在：$USERS_DIR（将按空目录备份）"
command -v "$SQLITE3_BIN" >/dev/null 2>&1 || warn "未找到 sqlite3（$SQLITE3_BIN），退化为文件复制"

if command -v shasum >/dev/null 2>&1; then
  SHA_TOOL="shasum"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA_TOOL="sha256sum"
else
  die "需要 shasum 或 sha256sum 来计算校验和"
fi

sha256_file() {
  if [ "$SHA_TOOL" = "shasum" ]; then
    shasum -a 256 "$1"
  else
    sha256sum "$1"
  fi
}

sha256_stdin() {
  if [ "$SHA_TOOL" = "shasum" ]; then
    shasum -a 256 | awk '{print $1}'
  else
    sha256sum | awk '{print $1}'
  fi
}

count_files() {
  if [ -d "$1" ]; then
    find "$1" -type f -print | wc -l | tr -d '[:space:]'
  else
    printf '0'
  fi
}

# 对目录做“相对路径 + 内容”的聚合哈希，源与恢复端用同一算法即可比较。
hash_tree() {
  local dir="$1"
  if [ ! -d "$dir" ]; then
    printf '' | sha256_stdin
    return 0
  fi
  (
    cd "$dir"
    find . -type f -print | LC_ALL=C sort | while IFS= read -r f; do
      sha256_file "$f"
    done
  ) | sha256_stdin
}

[ -d "$BACKUP_ROOT" ] || mkdir -p "$BACKUP_ROOT"
[ -w "$BACKUP_ROOT" ] || die "备份目录不可写：$BACKUP_ROOT"

CREATED_AT="$(date '+%Y-%m-%dT%H:%M:%S%z')"
STAMP="$(date '+%Y%m%d-%H%M%S')"
ARCHIVE="$BACKUP_ROOT/${PREFIX}-${STAMP}.tar.gz"

# 同一秒内重复运行：等到文件名不冲突，保持 YYYYmmdd-HHMMSS 命名。
while [ -e "$ARCHIVE" ]; do
  sleep 1
  CREATED_AT="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  STAMP="$(date '+%Y%m%d-%H%M%S')"
  ARCHIVE="$BACKUP_ROOT/${PREFIX}-${STAMP}.tar.gz"
done

STAGE_PARENT="$BACKUP_ROOT/.staging"
STAGE="$STAGE_PARENT/${PREFIX}-${STAMP}"
ARCHIVE_COMPLETE=0

cleanup() {
  rm -rf "$STAGE"
  rmdir "$STAGE_PARENT" 2>/dev/null || true
  if [ "$ARCHIVE_COMPLETE" -ne 1 ] && [ -f "$ARCHIVE" ]; then
    rm -f "$ARCHIVE"
  fi
}
trap cleanup EXIT

mkdir -p "$STAGE/users"
mkdir -p "$STAGE/config"

log "数据库：$DB_PATH"
DB_METHOD="file-copy"

if command -v "$SQLITE3_BIN" >/dev/null 2>&1; then
  log "使用 sqlite3 .backup 生成一致性快照（WAL 安全，可在服务运行时执行）"
  if ! ( cd "$STAGE" && "$SQLITE3_BIN" "$DB_PATH" ".timeout 10000" ".backup app.db" ); then
    die "sqlite3 .backup 失败（数据库被锁、磁盘满或文件损坏？）"
  fi
  [ -f "$STAGE/app.db" ] || die "sqlite3 .backup 未生成 app.db"
  DB_METHOD="sqlite3-backup"

  INTEGRITY="$("$SQLITE3_BIN" -readonly "$STAGE/app.db" 'PRAGMA integrity_check;')"
  if [ "$INTEGRITY" != "ok" ]; then
    printf '%s\n' "$INTEGRITY" >&2
    die "备份数据库 PRAGMA integrity_check 未通过"
  fi
  # SQLite 的 WAL 模式在只读打开时也可能留下空的 -wal/-shm；.backup 文件本身自包含，删掉。
  rm -f "$STAGE/app.db-wal" "$STAGE/app.db-shm"
else
  warn "没有 sqlite3：退化为文件复制，无法保证 WAL 一致性。"
  warn "在线恢复可能丢失最近事务；建议先停止服务，或安装 sqlite3 后重跑。"
  cp -p "$DB_PATH" "$STAGE/app.db"
  for suffix in -wal -shm; do
    if [ -f "$DB_PATH$suffix" ]; then
      cp -p "$DB_PATH$suffix" "$STAGE/app.db$suffix"
    fi
  done
  DB_METHOD="file-copy"
fi

# ---- 数据库元信息（无 sqlite3 时留空，restore 会按“无预期值”跳过比对） ----
TABLE_COUNT=""
TABLES=""
HAS_USERS_TABLE=""
USER_COUNT=""
ALEMBIC_VERSION=""

if command -v "$SQLITE3_BIN" >/dev/null 2>&1; then
  TABLE_COUNT="$("$SQLITE3_BIN" -readonly -noheader -batch "$STAGE/app.db" \
    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")"
  TABLES="$("$SQLITE3_BIN" -readonly -noheader -batch "$STAGE/app.db" \
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;" \
    | tr '\n' ',' | sed 's/,$//')"
  HAS_USERS_TABLE="$("$SQLITE3_BIN" -readonly -noheader -batch "$STAGE/app.db" \
    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='users';")"
  if [ "$HAS_USERS_TABLE" = "1" ]; then
    USER_COUNT="$("$SQLITE3_BIN" -readonly -noheader -batch "$STAGE/app.db" \
      'SELECT count(*) FROM users;')"
  else
    USER_COUNT="0"
  fi
  ALEMBIC_VERSION="$("$SQLITE3_BIN" -readonly -noheader -batch "$STAGE/app.db" \
    "SELECT group_concat(version_num, ',') FROM alembic_version;" 2>/dev/null || true)"
  # 元信息查询同样可能留下空的 WAL 侧文件。
  if [ "$DB_METHOD" != "file-copy" ]; then
    rm -f "$STAGE/app.db-wal" "$STAGE/app.db-shm"
  fi
fi

# ---- 用户数据 ----
SRC_USER_FILE_COUNT="$(count_files "$USERS_DIR")"
if [ -d "$USERS_DIR" ]; then
  log "用户数据：$USERS_DIR"
  cp -Rp "$USERS_DIR/." "$STAGE/users/"
else
  warn "按空用户目录备份"
fi
USER_FILE_COUNT="$(count_files "$STAGE/users")"
if [ "$USER_FILE_COUNT" != "$SRC_USER_FILE_COUNT" ]; then
  warn "复制期间源用户文件数发生变化（源 ${SRC_USER_FILE_COUNT}，备份 ${USER_FILE_COUNT}）；建议停写后重跑"
fi
USERS_TREE_SHA="$(hash_tree "$STAGE/users")"

# ---- 非敏感配置：只存键名与模板，绝不复制 .env 的值 ----
ENV_KEYS=""
if [ -f "$ENV_FILE" ]; then
  ENV_KEYS="$(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' "$ENV_FILE" \
    | LC_ALL=C sort -u | tr '\n' ',' | sed 's/,$//')"
  printf '%s\n' "$ENV_KEYS" | tr ',' '\n' | sed '/^$/d' > "$STAGE/config/env.keys"
else
  : > "$STAGE/config/env.keys"
  warn "未找到 $ENV_FILE，跳过配置键名清单（这不影响数据备份）"
fi
if [ -f "$ENV_EXAMPLE" ]; then
  cp -p "$ENV_EXAMPLE" "$STAGE/config/env.example"
fi
cat > "$STAGE/config/README.txt" <<'EOF'
本目录只含配置“键名”（env.keys）与模板（env.example），不含 .env 的值或任何密钥。
恢复后请按 env.keys 在目标机器重新配置环境变量；密钥请从密码管理器/密钥托管取。
EOF
ENV_KEY_COUNT="$(wc -l < "$STAGE/config/env.keys" | tr -d '[:space:]')"

# ---- 校验和（数据文件；manifest/config 不参与，避免自引用） ----
log "计算 SHA256 校验和..."
(
  cd "$STAGE"
  : > .checksum-files
  if [ -f app.db ]; then printf 'app.db\n' >> .checksum-files; fi
  if [ -f app.db-wal ]; then printf 'app.db-wal\n' >> .checksum-files; fi
  if [ -f app.db-shm ]; then printf 'app.db-shm\n' >> .checksum-files; fi
  if [ -d users ]; then find users -type f -print >> .checksum-files; fi
  LC_ALL=C sort -o .checksum-files .checksum-files
  : > SHA256SUMS
  while IFS= read -r f; do
    sha256_file "$f" >> SHA256SUMS
  done < .checksum-files
  rm -f .checksum-files
)

DB_SHA256="$(awk '$2 == "app.db" {print $1; exit}' "$STAGE/SHA256SUMS" 2>/dev/null || true)"
DB_SIZE="$(wc -c < "$STAGE/app.db" | tr -d '[:space:]')"

# ---- 元数据 ----
GIT_COMMIT="unknown"
GIT_DIRTY="unknown"
if command -v git >/dev/null 2>&1 && [ -d "$REPO_ROOT/.git" ]; then
  GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null || true)" ]; then
    GIT_DIRTY="yes"
  else
    GIT_DIRTY="no"
  fi
fi

cat > "$STAGE/manifest.env" <<EOF
BACKUP_FORMAT=1
APP=linguatrek
STAMP=$STAMP
CREATED_AT=$CREATED_AT
BACKUP_METHOD=$DB_METHOD
DB_FILE=app.db
DB_SIZE=$DB_SIZE
DB_SHA256=$DB_SHA256
TABLE_COUNT=$TABLE_COUNT
TABLES=$TABLES
HAS_USERS_TABLE=$HAS_USERS_TABLE
USER_COUNT=$USER_COUNT
USER_FILE_COUNT=$USER_FILE_COUNT
USERS_TREE_SHA256=$USERS_TREE_SHA
ALEMBIC_VERSION=$ALEMBIC_VERSION
GIT_COMMIT=$GIT_COMMIT
GIT_DIRTY=$GIT_DIRTY
ENV_KEY_COUNT=$ENV_KEY_COUNT
ENV_KEYS=$ENV_KEYS
EOF

# ---- 打包 ----
log "打包：$ARCHIVE"
# macOS 的 bsdtar 默认可能写入 ._ AppleDouble 文件；关掉，保证跨平台文件数一致。
if ! COPYFILE_DISABLE=1 tar -czf "$ARCHIVE" -C "$STAGE_PARENT" "${PREFIX}-${STAMP}"; then
  die "tar 打包失败"
fi
if ! tar -tzf "$ARCHIVE" >/dev/null 2>&1; then
  rm -f "$ARCHIVE"
  die "备份包自检失败（tar -tzf）"
fi
ARCHIVE_COMPLETE=1

SIZE_BYTES="$(wc -c < "$ARCHIVE" | tr -d '[:space:]')"
SIZE_HUMAN="$(du -h "$ARCHIVE" | awk '{print $1}')"

# ---- 保留策略：只清理本脚本命名的归档，不碰其他文件 ----
PRUNED=0
SEEN=0
while IFS= read -r old; do
  SEEN=$((SEEN + 1))
  if [ "$SEEN" -gt "$KEEP" ]; then
    rm -f "$old"
    PRUNED=$((PRUNED + 1))
    log "清理旧备份：$(basename "$old")"
  fi
done < <(find "$BACKUP_ROOT" -maxdepth 1 -type f -name "${PREFIX}-*.tar.gz" -print \
  | LC_ALL=C sort -r)

REMAIN="$SEEN"
if [ "$REMAIN" -gt "$KEEP" ]; then
  REMAIN="$KEEP"
fi

log "备份完成：$ARCHIVE"
log "大小：${SIZE_HUMAN}（${SIZE_BYTES} 字节）"
log "内容：app.db（${DB_METHOD}） + users（${USER_FILE_COUNT} 个文件） + 配置键名 ${ENV_KEY_COUNT} 个（.env 未备份）"
if [ "$DB_METHOD" = "sqlite3-backup" ]; then
  log "校验：integrity_check=ok；表 ${TABLE_COUNT:-未知}；用户 ${USER_COUNT:-未知}"
else
  log "校验：未执行（无 sqlite3，文件复制模式）；表 ${TABLE_COUNT:-未知}；用户 ${USER_COUNT:-未知}"
fi
log "保留：最近 ${KEEP} 份（当前 ${REMAIN} 份，本次清理 ${PRUNED} 份）"
