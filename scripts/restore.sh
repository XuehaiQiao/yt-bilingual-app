#!/usr/bin/env bash
# LinguaTrek（语途）恢复脚本 —— M1 ③ 备份部分。
#
# 做什么：
#   1. 解压 backup.sh 生成的 .tar.gz（app.db + users/ + manifest.env + SHA256SUMS）；
#   2. 先校验 SHA256SUMS，再对 app.db 做 PRAGMA integrity_check，并统计表/用户/文件；
#   3. 与 manifest.env 中的快照记录逐项比对（表清单、用户数、用户文件数、聚合哈希）；
#   4. 全部通过后才写入目标目录；默认拒绝非空目标，--force 时把旧数据移到 .pre-restore-*。
#
# 用法：
#   scripts/restore.sh <备份包.tar.gz>                 # 恢复到临时目录，打印路径
#   scripts/restore.sh <备份包.tar.gz> --to /srv/ln/data
#   scripts/restore.sh <备份包.tar.gz> --to ./restore --force
#
# 目标目录约定：该目录将成为“数据根目录”，即包含 app.db、users/、backup-meta/。
# 恢复大目录前先停服务；脚本本身不会启动/停止服务，也不会写入 .env。
#
# 环境变量：
#   SQLITE3_BIN  sqlite3 可执行文件（默认 sqlite3；恢复校验必须有 sqlite3）
#
# 退出码：0 成功；非 0 失败（目标目录保持安装前的状态，除非已开始安装）。
set -euo pipefail
umask 077  # 备份含 PII/口令哈希：新建文件默认仅属主可读写

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SQLITE3_BIN="${SQLITE3_BIN:-sqlite3}"
TMP_BASE="${TMPDIR:-/tmp}"; TMP_BASE="${TMP_BASE%/}"

ARCHIVE=""
TARGET=""
FORCE=0
TARGET_AUTO=0
RESTORE_OK=0
WORK=""

log() { printf '[restore] %s\n' "$*"; }
warn() { printf '[restore] 警告：%s\n' "$*" >&2; }
fail() {
  trap - ERR
  printf '[restore] 恢复结果：FAIL（%s）\n' "$*" >&2
  exit 1
}

on_error() {
  local rc=$?
  trap - ERR
  printf '[restore] 恢复结果：FAIL（意外错误 rc=%s）\n' "$rc" >&2
  exit "$rc"
}
trap on_error ERR

usage() {
  cat <<'EOF'
LinguaTrek 恢复脚本

用法：
  scripts/restore.sh <备份包.tar.gz>                 # 恢复到临时目录，打印路径
  scripts/restore.sh <备份包.tar.gz> --to /srv/ln/data
  scripts/restore.sh <备份包.tar.gz> --to ./restore --force

目标目录 = 新的数据根目录（app.db、users/、backup-meta/）。恢复前请停服务。
  --force   目标非空时先把旧 app.db/users/backup-meta 移到 .pre-restore-*
环境变量：SQLITE3_BIN（默认 sqlite3；校验必须）
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --to)
      [ $# -ge 2 ] || fail "--to 需要一个目标目录"
      TARGET="$2"
      shift 2
      ;;
    --to=*)
      TARGET="${1#*=}"
      shift
      ;;
    --force|-f)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      fail "未知参数：$1（--help 查看用法）"
      ;;
    *)
      if [ -z "$ARCHIVE" ]; then
        ARCHIVE="$1"
      else
        fail "只接受一个备份包路径（多余参数：$1）"
      fi
      shift
      ;;
  esac
done

[ -n "$ARCHIVE" ] || fail "缺少备份包路径。用法：scripts/restore.sh <备份包.tar.gz> [--to DIR] [--force]"
[ -f "$ARCHIVE" ] || fail "找不到备份包：$ARCHIVE"
command -v "$SQLITE3_BIN" >/dev/null 2>&1 || fail "恢复校验需要 sqlite3（当前：$SQLITE3_BIN）；请先安装 sqlite3"

if command -v shasum >/dev/null 2>&1; then
  SHA_TOOL="shasum"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA_TOOL="sha256sum"
else
  fail "需要 shasum 或 sha256sum 来校验备份包"
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

# 只读查询，避免为了检查而改动恢复出来的数据库。
sqlite_scalar() {
  "$SQLITE3_BIN" -readonly -noheader -batch "$1" "$2"
}

if ! WORK="$(mktemp -d "$TMP_BASE/linguatrek-restore-work.XXXXXX")"; then
  fail "无法创建临时工作目录（检查 TMPDIR 可写/磁盘空间）"
fi

cleanup() {
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then
    rm -rf "$WORK" || true
  fi
  if [ "$TARGET_AUTO" -eq 1 ] && [ "$RESTORE_OK" -ne 1 ] && [ -d "$TARGET" ]; then
    # 只删空目录；失败时保留现场便于排查。
    rmdir "$TARGET" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [ -z "$TARGET" ]; then
  if ! TARGET="$(mktemp -d "$TMP_BASE/linguatrek-restore.XXXXXX")"; then
    fail "无法创建临时恢复目录（检查 TMPDIR 可写/磁盘空间）"
  fi
  TARGET_AUTO=1
  log "未指定 --to，使用临时目录：$TARGET"
else
  case "$TARGET" in
    /*) ;;
    *) TARGET="$PWD/$TARGET" ;;
  esac
fi

[ "$TARGET" != "/" ] || fail "拒绝恢复到根目录"
if [ -e "$TARGET" ] && [ ! -d "$TARGET" ]; then
  fail "目标路径不是目录：$TARGET"
fi
if [ -d "$TARGET" ] && [ "$FORCE" -ne 1 ]; then
  if [ -n "$(find "$TARGET" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    fail "目标目录非空：$TARGET（确认覆盖请加 --force；旧 app.db/users 会移到 .pre-restore-*）"
  fi
fi

# ---- 解压 ----
log "读取并解压：$ARCHIVE"
if ! TAR_LIST="$(tar -tzf "$ARCHIVE" 2>/dev/null)"; then
  fail "无法读取备份包：文件损坏或不是 .tar.gz"
fi
if grep -Eq '(^/|(^|/)\.\.(/|$))' <<< "$TAR_LIST"; then
  fail "备份包包含绝对路径或 .. 路径，拒绝解压"
fi
if ! tar -xzf "$ARCHIVE" -C "$WORK"; then
  fail "解压失败：备份包损坏或不是 .tar.gz"
fi

PAYLOAD="$WORK"
if [ ! -f "$PAYLOAD/app.db" ]; then
  for p in "$WORK"/*; do
    if [ -d "$p" ] && [ -f "$p/app.db" ]; then
      PAYLOAD="$p"
      break
    fi
  done
fi
[ -f "$PAYLOAD/app.db" ] || fail "备份包中找不到 app.db（可能不是 backup.sh 生成的包）"

# 记录归档里原本是否带 WAL 侧文件：校验过程可能会生成空的 -wal/-shm，安装时不能误带。
PAYLOAD_HAD_WAL=0
if [ -f "$PAYLOAD/app.db-wal" ]; then PAYLOAD_HAD_WAL=1; fi

MF="$PAYLOAD/manifest.env"
manifest_get() {
  if [ -f "$MF" ]; then
    awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' "$MF"
  fi
}

# ---- 文件哈希 ----
if [ -f "$PAYLOAD/SHA256SUMS" ]; then
  CHECKED_FILES="$(wc -l < "$PAYLOAD/SHA256SUMS" | tr -d '[:space:]')"
  log "校验 SHA256SUMS（${CHECKED_FILES} 个数据文件）..."
  if [ "$SHA_TOOL" = "shasum" ]; then
    if ! OUT="$(cd "$PAYLOAD" && shasum -a 256 -c SHA256SUMS 2>&1)"; then
      printf '%s\n' "$OUT" | grep -v ': OK$' | head -n 5 >&2 || true
      fail "文件哈希校验失败：备份包内容损坏或被改动"
    fi
  else
    if ! OUT="$(cd "$PAYLOAD" && sha256sum -c SHA256SUMS 2>&1)"; then
      printf '%s\n' "$OUT" | grep -v ': OK$' | head -n 5 >&2 || true
      fail "文件哈希校验失败：备份包内容损坏或被改动"
    fi
  fi
else
  CHECKED_FILES="0"
  warn "备份包没有 SHA256SUMS，跳过文件哈希校验"
fi

# ---- 数据库完整性 ----
log "校验数据库：PRAGMA integrity_check ..."
if ! INTEGRITY="$("$SQLITE3_BIN" -readonly "$PAYLOAD/app.db" 'PRAGMA integrity_check;' 2>&1)"; then
  printf '%s\n' "$INTEGRITY" >&2
  fail "数据库无法打开（文件损坏或不是 SQLite 数据库）"
fi
if [ "$INTEGRITY" != "ok" ]; then
  printf '%s\n' "$INTEGRITY" | awk 'NR <= 5' >&2
  fail "PRAGMA integrity_check 未通过"
fi

if [ ! -d "$PAYLOAD/users" ]; then
  warn "备份包没有 users/ 目录，按空用户目录恢复"
  mkdir -p "$PAYLOAD/users"
fi

TABLE_COUNT="$(sqlite_scalar "$PAYLOAD/app.db" \
  "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")"
TABLES="$(sqlite_scalar "$PAYLOAD/app.db" \
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;" \
  | tr '\n' ',' | sed 's/,$//')"
HAS_USERS_TABLE="$(sqlite_scalar "$PAYLOAD/app.db" \
  "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='users';")"
if [ "$HAS_USERS_TABLE" = "1" ]; then
  USER_COUNT="$(sqlite_scalar "$PAYLOAD/app.db" 'SELECT count(*) FROM users;')"
else
  USER_COUNT="0"
fi
ALEMBIC_VERSION="$( { sqlite_scalar "$PAYLOAD/app.db" \
  "SELECT group_concat(version_num, ',') FROM alembic_version;" 2>/dev/null || true; } )"
FILE_COUNT="$(count_files "$PAYLOAD/users")"
USERS_TREE_SHA="$(hash_tree "$PAYLOAD/users")"

M_BACKUP_METHOD="$(manifest_get BACKUP_METHOD)"
M_TABLE_COUNT="$(manifest_get TABLE_COUNT)"
M_TABLES="$(manifest_get TABLES)"
M_HAS_USERS_TABLE="$(manifest_get HAS_USERS_TABLE)"
M_USER_COUNT="$(manifest_get USER_COUNT)"
M_USER_FILE_COUNT="$(manifest_get USER_FILE_COUNT)"
M_USERS_TREE_SHA="$(manifest_get USERS_TREE_SHA256)"
M_ALEMBIC_VERSION="$(manifest_get ALEMBIC_VERSION)"

log "=== 恢复校验 ==="
M_APP="$(manifest_get APP)"
if [ -f "$MF" ] && [ -n "$M_APP" ] && [ "$M_APP" != "linguatrek" ]; then
  fail "不是 LinguaTrek 备份（manifest APP=${M_APP}）"
fi
if [ -f "$MF" ]; then
  log "[PASS] 文件哈希：${CHECKED_FILES} 个数据文件通过（SHA256SUMS）"
else
  log "[SKIP] 文件哈希：备份包没有 manifest.env/SHA256SUMS（旧格式？）"
fi
log "[PASS] PRAGMA integrity_check：ok"
log "[INFO] 备份方式：${M_BACKUP_METHOD:-未知}"
log "[INFO] 表清单（${TABLE_COUNT}）：${TABLES:-（空）}"
log "[INFO] 用户数：${USER_COUNT}；data/users 文件数：${FILE_COUNT}"
log "[INFO] users 聚合 SHA256：${USERS_TREE_SHA}"
log "[INFO] alembic_version：${ALEMBIC_VERSION:-（无）}"

MISMATCHES=0
check_match() {
  # $1=标签 $2=恢复出的实际值 $3=备份记录值
  local label="$1" actual="$2" expected="$3"
  if [ -z "$expected" ]; then
    log "[SKIP] ${label}：备份包未提供期望值"
    return 0
  fi
  if [ "$actual" = "$expected" ]; then
    log "[PASS] ${label}：${actual}"
  else
    log "[FAIL] ${label}：恢复 ${actual}，备份记录 ${expected}"
    MISMATCHES=$((MISMATCHES + 1))
  fi
}

if [ -f "$MF" ]; then
  check_match "表数量" "$TABLE_COUNT" "$M_TABLE_COUNT"
  check_match "表清单" "$TABLES" "$M_TABLES"
  check_match "users 表存在" "$HAS_USERS_TABLE" "$M_HAS_USERS_TABLE"
  check_match "用户数" "$USER_COUNT" "$M_USER_COUNT"
  check_match "data/users 文件数" "$FILE_COUNT" "$M_USER_FILE_COUNT"
  check_match "users 聚合 SHA256" "$USERS_TREE_SHA" "$M_USERS_TREE_SHA"
  if [ -n "$M_ALEMBIC_VERSION" ] && [ "$ALEMBIC_VERSION" != "$M_ALEMBIC_VERSION" ]; then
    log "[WARN] alembic_version：恢复 ${ALEMBIC_VERSION:-（无）}，备份记录 ${M_ALEMBIC_VERSION}"
  fi
else
  log "[SKIP] manifest.env 缺失：跳过与备份记录的一致性比对（完整性校验仍已执行）"
fi

if [ "$MISMATCHES" -ne 0 ]; then
  fail "一致性校验未通过（${MISMATCHES} 项不一致）；目标目录未被写入"
fi
if [ "$TABLE_COUNT" -eq 0 ]; then
  warn "恢复出的数据库没有任何表；请确认这是预期的空库"
fi

# 校验过程会为 WAL 模式数据库生成空的 -wal/-shm；只保留归档里原本存在的 WAL。
if [ "$PAYLOAD_HAD_WAL" -eq 0 ]; then
  rm -f "$PAYLOAD/app.db-wal"
fi
rm -f "$PAYLOAD/app.db-shm"

# ---- 写入目标目录（先移走旧数据，再复制） ----
if [ "$FORCE" -eq 1 ]; then
  PRE="$TARGET/.pre-restore-$(date '+%Y%m%d-%H%M%S')"
  while [ -e "$PRE" ]; do PRE="${PRE}-$$"; done
  MOVED=0
  for item in app.db app.db-wal app.db-shm users backup-meta; do
    if [ -e "$TARGET/$item" ]; then
      mkdir -p "$PRE"
      mv "$TARGET/$item" "$PRE/$item"
      MOVED=1
    fi
  done
  if [ "$MOVED" -eq 1 ]; then
    log "旧数据已移到：$PRE"
  fi
fi

log "写入目标目录：$TARGET"
if ! mkdir -p "$TARGET"; then
  fail "无法创建目标目录：$TARGET"
fi
if ! cp -p "$PAYLOAD/app.db" "$TARGET/app.db"; then
  fail "复制 app.db 失败"
fi
if [ "$PAYLOAD_HAD_WAL" -eq 1 ] && [ -f "$PAYLOAD/app.db-wal" ]; then
  if ! cp -p "$PAYLOAD/app.db-wal" "$TARGET/app.db-wal"; then
    fail "复制 app.db-wal 失败"
  fi
fi

mkdir -p "$TARGET/users"
if ! cp -Rp "$PAYLOAD/users/." "$TARGET/users/"; then
  fail "复制用户数据失败"
fi
mkdir -p "$TARGET/backup-meta"
if [ -f "$PAYLOAD/manifest.env" ]; then
  cp -p "$PAYLOAD/manifest.env" "$TARGET/backup-meta/manifest.env"
fi
if [ -f "$PAYLOAD/SHA256SUMS" ]; then
  cp -p "$PAYLOAD/SHA256SUMS" "$TARGET/backup-meta/SHA256SUMS"
fi
if [ -d "$PAYLOAD/config" ]; then
  mkdir -p "$TARGET/backup-meta/config"
  cp -Rp "$PAYLOAD/config/." "$TARGET/backup-meta/config/"
fi

INSTALLED_FILES="$(count_files "$TARGET/users")"
if [ "$INSTALLED_FILES" != "$FILE_COUNT" ]; then
  fail "写入后 users 文件数不一致（${INSTALLED_FILES} != ${FILE_COUNT}）"
fi
DB_SHA256="$(awk '$2 == "app.db" {print $1; exit}' "$PAYLOAD/SHA256SUMS" 2>/dev/null || true)"
if [ -n "$DB_SHA256" ]; then
  INSTALLED_DB_SHA="$(sha256_file "$TARGET/app.db" | awk '{print $1}')"
  if [ "$INSTALLED_DB_SHA" != "$DB_SHA256" ]; then
    fail "写入后 app.db 哈希不一致（复制不完整或磁盘错误）"
  fi
fi
chmod 700 "$TARGET/users" 2>/dev/null || true
chmod 700 "$TARGET/backup-meta" 2>/dev/null || true
chmod 600 "$TARGET/app.db" 2>/dev/null || true

RESTORE_OK=1
log "恢复结果：PASS"
log "恢复目录：$TARGET"
log "  app.db：$(wc -c < "$TARGET/app.db" | tr -d '[:space:]') 字节"
log "  users/：${INSTALLED_FILES} 个文件"
log "  backup-meta/：manifest.env、SHA256SUMS、config/env.keys（供核对，不参与运行）"
log "下一步：按 backup-meta/env.keys 重新配置环境变量（.env 与密钥不在备份中）；确认文件属主后启动服务。"
if [ "$TARGET_AUTO" -eq 1 ]; then
  log "提示：这是自动创建的临时恢复目录；需要保留请自行备份，不需要可 rm -rf。"
fi
