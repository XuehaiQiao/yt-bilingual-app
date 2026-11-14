#!/usr/bin/env bash
# LinguaTrek（语途）恢复演练脚本 —— M1 ③ 备份部分。
#
# 流程：备份 → 恢复到临时目录 → 与源数据比对 → 清理临时目录。
# 不写真实 data/，不启动服务，不占用 8000 端口；源库只做只读查询。
#
# 用法：
#   scripts/restore_drill.sh                 # 演练默认 data/（当前仓库）
#   scripts/restore_drill.sh --data-dir /tmp/fake/data
#   scripts/restore_drill.sh --keep-temp     # 失败/成功后都保留临时目录用于排查
#
# 环境变量：与 backup.sh 相同（DATA_DIR / AUTH_DB_PATH / USER_DATA_DIR / SQLITE3_BIN）。
# 注意：演练期间最好暂停写入；若源数据在备份后变化，比对会失败（这本身是预期行为）。
#
# 输出：PASS/FAIL + 耗时；退出码 0=通过，非 0=失败。
set -Eeuo pipefail
umask 077  # 备份含 PII/口令哈希：新建文件默认仅属主可读写

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="${DATA_DIR:-$REPO_ROOT/data}"
DB_PATH="${AUTH_DB_PATH:-$DATA_DIR/app.db}"
USERS_DIR="${USER_DATA_DIR:-$DATA_DIR/users}"
SQLITE3_BIN="${SQLITE3_BIN:-sqlite3}"
TMP_BASE="${TMPDIR:-/tmp}"; TMP_BASE="${TMP_BASE%/}"
KEEP_TEMP=0
DRILL_TMP=""
SECONDS=0

log() { printf '[drill] %s\n' "$*"; }
warn() { printf '[drill] 警告：%s\n' "$*" >&2; }

fail() {
  trap - ERR
  printf 'FAIL 恢复演练失败：%s（耗时 %ss）\n' "$*" "$SECONDS" >&2
  if [ "$KEEP_TEMP" -eq 1 ] && [ -n "$DRILL_TMP" ]; then
    printf '临时目录已保留：%s\n' "$DRILL_TMP" >&2
  fi
  exit 1
}

on_error() {
  local rc=$?
  trap - ERR
  printf 'FAIL 恢复演练失败：意外错误（rc=%s，耗时 %ss）\n' "$rc" "$SECONDS" >&2
  if [ "$KEEP_TEMP" -eq 1 ] && [ -n "$DRILL_TMP" ]; then
    printf '临时目录已保留：%s\n' "$DRILL_TMP" >&2
  fi
  exit "$rc"
}

cleanup() {
  if [ "$KEEP_TEMP" -eq 0 ] && [ -n "$DRILL_TMP" ] && [ -d "$DRILL_TMP" ]; then
    rm -rf "$DRILL_TMP" || true
  fi
}
trap on_error ERR
trap cleanup EXIT

usage() {
  cat <<'EOF'
LinguaTrek 恢复演练脚本

用法：
  scripts/restore_drill.sh                 # 演练默认 data/（当前仓库）
  scripts/restore_drill.sh --data-dir /tmp/fake/data
  scripts/restore_drill.sh --keep-temp     # 保留临时目录用于排查

流程：备份 → 临时恢复 → 与源数据比对（表/用户/文件/哈希）→ 清理。
输出 PASS/FAIL 与耗时；退出码 0=通过，非 0=失败。
环境变量：DATA_DIR / AUTH_DB_PATH / USER_DATA_DIR / SQLITE3_BIN。
EOF
}

DATA_DIR_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir)
      [ $# -ge 2 ] || fail "--data-dir 需要一个目录"
      DATA_DIR_OVERRIDE="$2"
      shift 2
      ;;
    --data-dir=*)
      DATA_DIR_OVERRIDE="${1#*=}"
      shift
      ;;
    --keep-temp)
      KEEP_TEMP=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "未知参数：$1（--help 查看用法）"
      ;;
  esac
done

if [ -n "$DATA_DIR_OVERRIDE" ]; then
  DATA_DIR="$DATA_DIR_OVERRIDE"
  DB_PATH="$DATA_DIR/app.db"
  USERS_DIR="$DATA_DIR/users"
  export DATA_DIR
  unset AUTH_DB_PATH USER_DATA_DIR
fi

case "$DATA_DIR" in /*) ;; *) DATA_DIR="$PWD/$DATA_DIR" ;; esac
case "$DB_PATH" in /*) ;; *) DB_PATH="$PWD/$DB_PATH" ;; esac
case "$USERS_DIR" in /*) ;; *) USERS_DIR="$PWD/$USERS_DIR" ;; esac

[ -f "$SCRIPT_DIR/backup.sh" ] || fail "找不到 $SCRIPT_DIR/backup.sh"
[ -f "$SCRIPT_DIR/restore.sh" ] || fail "找不到 $SCRIPT_DIR/restore.sh"
[ -f "$DB_PATH" ] || fail "找不到源数据库：$DB_PATH（检查 DATA_DIR / AUTH_DB_PATH）"
[ -d "$USERS_DIR" ] || warn "源用户目录不存在：$USERS_DIR（按 0 个文件演练）"
command -v "$SQLITE3_BIN" >/dev/null 2>&1 || fail "演练需要 sqlite3（当前：$SQLITE3_BIN）"

if command -v shasum >/dev/null 2>&1; then
  SHA_TOOL="shasum"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA_TOOL="sha256sum"
else
  fail "需要 shasum 或 sha256sum 来计算用户数据哈希"
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

sqlite_scalar() {
  "$SQLITE3_BIN" -readonly -noheader -batch "$1" "$2"
}

HAS_USERS_TABLE="$(sqlite_scalar "$DB_PATH" \
  "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='users';")"
[ "$HAS_USERS_TABLE" = "1" ] || fail "源库缺少 users 表，无法按 LinguaTrek 数据演练"

# 先取源快照（备份前），再跑备份，最后与恢复结果比对。
SRC_TABLE_COUNT="$(sqlite_scalar "$DB_PATH" \
  "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")"
SRC_TABLES="$(sqlite_scalar "$DB_PATH" \
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;" \
  | tr '\n' ',' | sed 's/,$//')"
SRC_USER_COUNT="$(sqlite_scalar "$DB_PATH" 'SELECT count(*) FROM users;')"
SRC_FILE_COUNT="$(count_files "$USERS_DIR")"
SRC_USERS_SHA="$(hash_tree "$USERS_DIR")"

DRILL_TMP="$(mktemp -d "$TMP_BASE/linguatrek-drill.XXXXXX")"
DRILL_BACKUP_ROOT="$DRILL_TMP/backups"
mkdir -p "$DRILL_BACKUP_ROOT"

# ---- 1/4 备份 ----
printf '[1/4] 备份 ... '
BACKUP_LOG="$DRILL_TMP/backup.log"
if ! BACKUP_ROOT="$DRILL_BACKUP_ROOT" "$SCRIPT_DIR/backup.sh" >"$BACKUP_LOG" 2>&1; then
  printf 'FAIL\n'
  cat "$BACKUP_LOG" >&2
  fail "备份脚本执行失败"
fi
ARCHIVE="$(find "$DRILL_BACKUP_ROOT" -maxdepth 1 -type f -name 'linguatrek-backup-*.tar.gz' -print \
  | LC_ALL=C sort | tail -n 1)"
[ -n "$ARCHIVE" ] || fail "备份脚本未生成归档"
printf 'OK（%s）\n' "$(basename "$ARCHIVE")"
grep '\[backup\] 警告' "$BACKUP_LOG" >&2 || true

# ---- 2/4 恢复 ----
printf '[2/4] 恢复到临时目录 ... '
RESTORE_TARGET="$DRILL_TMP/restored"
mkdir -p "$RESTORE_TARGET"
RESTORE_LOG="$DRILL_TMP/restore.log"
if ! "$SCRIPT_DIR/restore.sh" "$ARCHIVE" --to "$RESTORE_TARGET" >"$RESTORE_LOG" 2>&1; then
  printf 'FAIL\n'
  cat "$RESTORE_LOG" >&2
  fail "恢复脚本执行失败"
fi
printf 'OK\n'
grep -E '^\[restore\] \[(PASS|FAIL)\]' "$RESTORE_LOG" || true

# ---- 3/4 校验（独立于 restore 的源数据对比） ----
printf '[3/4] 校验源数据与恢复结果 ... '
DST_DB="$RESTORE_TARGET/app.db"
DST_USERS="$RESTORE_TARGET/users"
[ -f "$DST_DB" ] || fail "恢复目录缺少 app.db"
[ -d "$DST_USERS" ] || fail "恢复目录缺少 users/"
DST_TABLE_COUNT="$(sqlite_scalar "$DST_DB" \
  "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")"
DST_TABLES="$(sqlite_scalar "$DST_DB" \
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;" \
  | tr '\n' ',' | sed 's/,$//')"
DST_USER_COUNT="$(sqlite_scalar "$DST_DB" 'SELECT count(*) FROM users;')"
DST_FILE_COUNT="$(count_files "$DST_USERS")"
DST_USERS_SHA="$(hash_tree "$DST_USERS")"

require_equal() {
  # $1=标签 $2=源值 $3=恢复值
  if [ "$2" != "$3" ]; then
    printf 'FAIL\n'
    fail "$1 不一致（源：$2，恢复：$3）"
  fi
}
require_equal "表数量" "$SRC_TABLE_COUNT" "$DST_TABLE_COUNT"
require_equal "表清单" "$SRC_TABLES" "$DST_TABLES"
require_equal "用户数" "$SRC_USER_COUNT" "$DST_USER_COUNT"
require_equal "data/users 文件数" "$SRC_FILE_COUNT" "$DST_FILE_COUNT"
require_equal "users 聚合 SHA256" "$SRC_USERS_SHA" "$DST_USERS_SHA"
printf 'OK（表 %s、用户 %s、文件 %s、users 哈希一致）\n' "$SRC_TABLE_COUNT" "$SRC_USER_COUNT" "$SRC_FILE_COUNT"

# ---- 4/4 清理 ----
printf '[4/4] 清理临时目录 ... '
if [ "$KEEP_TEMP" -eq 1 ]; then
  printf 'SKIP（--keep-temp）\n'
  RETAINED_DIR="$DRILL_TMP"
else
  rm -rf "$DRILL_TMP"
  DRILL_TMP=""
  printf 'OK\n'
fi

if [ "$KEEP_TEMP" -eq 1 ]; then
  printf 'PASS 恢复演练通过：表 %s、用户 %s、文件 %s、users 哈希一致；耗时 %ss\n' \
    "$SRC_TABLE_COUNT" "$SRC_USER_COUNT" "$SRC_FILE_COUNT" "$SECONDS"
  printf '临时目录：%s\n' "${RETAINED_DIR:-}"
else
  printf 'PASS 恢复演练通过：表 %s、用户 %s、文件 %s、users 哈希一致；耗时 %ss\n' \
    "$SRC_TABLE_COUNT" "$SRC_USER_COUNT" "$SRC_FILE_COUNT" "$SECONDS"
fi
exit 0
