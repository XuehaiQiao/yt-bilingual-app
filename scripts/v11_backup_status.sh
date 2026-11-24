#!/usr/bin/env bash
# 备份新鲜度检查（只读）—— P2-41 上线观测：把"备份失败/备份缺失"变成可告警的退出码。
#
# 做什么：
#   1) 在备份目录里找最新的 linguatrek-backup-*.tar.gz；
#   2) 检查包是否可读（tar -tzf）、是否含 app.db / users/ / manifest.env / SHA256SUMS；
#   3) 检查包龄是否超过阈值（默认 26 小时：每日 03:17 备份，留 2 小时余量）；
#   4) 可选 --offsite-check 只做"本地最新包存在且新鲜"的判断（离机由 rclone check 负责）。
#
# 用法：
#   scripts/v11_backup_status.sh                         # 默认 <repo>/backups，26h
#   scripts/v11_backup_status.sh --backup-root /srv/ln/backups --max-age-hours 26
#   scripts/v11_backup_status.sh --json                  # 一行 JSON，便于 cron 汇聚
#
# 接告警（与 scripts/check-alerts.py 组合；P0/P1 级别由值班表定）：
#   scripts/v11_backup_status.sh || backend/venv/bin/python scripts/check-alerts.py \
#       --event backup_failed --level P1 --summary "备份缺失/过期/不可读" --key backup
#
# 退出码：0 = 有最新包且未过期且可读；1 = 缺失/过期/不可读；2 = 参数错误。
# 本脚本只读：不删包、不跑备份、不写任何文件。
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

BACKUP_ROOT="${BACKUP_ROOT:-$REPO_ROOT/backups}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-26}"
MIN_ARCHIVES="${MIN_ARCHIVES:-1}"
JSON=0
PREFIX="linguatrek-backup"

usage() {
  cat <<'EOF'
备份新鲜度检查（只读）

用法：
  scripts/v11_backup_status.sh [--backup-root DIR] [--max-age-hours H] [--min-archives N] [--json]

  --backup-root DIR   备份目录（默认 $BACKUP_ROOT 或 <repo>/backups）
  --max-age-hours H   最新包允许的最大包龄（默认 26）
  --min-archives N    至少保留的归档数（默认 1）
  --json              输出一行 JSON
退出码：0=正常；1=缺失/过期/不可读；2=参数错误。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --backup-root) [ $# -ge 2 ] || { usage >&2; exit 2; }; BACKUP_ROOT="$2"; shift 2 ;;
    --backup-root=*) BACKUP_ROOT="${1#*=}"; shift ;;
    --max-age-hours) [ $# -ge 2 ] || { usage >&2; exit 2; }; MAX_AGE_HOURS="$2"; shift 2 ;;
    --max-age-hours=*) MAX_AGE_HOURS="${1#*=}"; shift ;;
    --min-archives) [ $# -ge 2 ] || { usage >&2; exit 2; }; MIN_ARCHIVES="$2"; shift 2 ;;
    --min-archives=*) MIN_ARCHIVES="${1#*=}"; shift ;;
    --json) JSON=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf '[backup-status] 未知参数：%s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$MAX_AGE_HOURS" in ''|*[!0-9]*) printf '[backup-status] --max-age-hours 需正整数\n' >&2; exit 2 ;; esac
case "$MIN_ARCHIVES" in ''|*[!0-9]*) printf '[backup-status] --min-archives 需正整数\n' >&2; exit 2 ;; esac

emit() {
  # emit <status> <message>
  local status="$1" message="$2"
  if [ "$JSON" -eq 1 ]; then
    printf '{"ok":%s,"status":"%s","message":"%s","backup_root":"%s","latest":"%s","age_hours":%s,"archives":%s,"size_bytes":%s}\n' \
      "$([ "$status" = "ok" ] && echo true || echo false)" \
      "$status" "$message" "$BACKUP_ROOT" "${LATEST_NAME:-}" "${LATEST_AGE:-0}" \
      "${ARCHIVE_COUNT:-0}" "${LATEST_SIZE:-0}"
  else
    printf '[backup-status] %s：%s\n' "$status" "$message"
  fi
}

if [ ! -d "$BACKUP_ROOT" ]; then
  emit "fail" "备份目录不存在：$BACKUP_ROOT"
  exit 1
fi

ARCHIVE_COUNT="$(find "$BACKUP_ROOT" -maxdepth 1 -type f -name "${PREFIX}-*.tar.gz" | wc -l | tr -d '[:space:]')"
if [ "$ARCHIVE_COUNT" -lt "$MIN_ARCHIVES" ]; then
  emit "fail" "归档数 ${ARCHIVE_COUNT} < 期望 ${MIN_ARCHIVES}（目录：$BACKUP_ROOT）"
  exit 1
fi

LATEST="$(find "$BACKUP_ROOT" -maxdepth 1 -type f -name "${PREFIX}-*.tar.gz" -print \
  | LC_ALL=C sort | tail -n 1)"
LATEST_NAME="$(basename "$LATEST")"
LATEST_SIZE="$(wc -c < "$LATEST" | tr -d '[:space:]')"

if stat -f '%m' "$LATEST" >/dev/null 2>&1; then
  MTIME="$(stat -f '%m' "$LATEST")"
else
  MTIME="$(stat -c '%Y' "$LATEST")"
fi
NOW="$(date +%s)"
AGE_SECONDS=$((NOW - MTIME))
[ "$AGE_SECONDS" -ge 0 ] || AGE_SECONDS=0
LATEST_AGE="$(awk -v s="$AGE_SECONDS" 'BEGIN { printf "%.2f", s / 3600.0 }')"

if ! tar -tzf "$LATEST" >/dev/null 2>&1; then
  emit "fail" "最新包不可读（tar -tzf 失败）：$LATEST_NAME"
  exit 1
fi
LISTING="$(tar -tzf "$LATEST" 2>/dev/null || true)"
for required in 'manifest.env' 'SHA256SUMS' 'app.db'; do
  if ! printf '%s\n' "$LISTING" | grep -q -e "/${required}\$"; then
    emit "fail" "最新包缺少 ${required}：$LATEST_NAME"
    exit 1
  fi
done

OVERDUE="$(awk -v a="$LATEST_AGE" -v m="$MAX_AGE_HOURS" 'BEGIN { print (a > m) ? 1 : 0 }')"
if [ "$OVERDUE" -eq 1 ]; then
  emit "fail" "最新包已过期：${LATEST_NAME} 距今 ${LATEST_AGE}h > ${MAX_AGE_HOURS}h"
  exit 1
fi

emit "ok" "最新包 ${LATEST_NAME}（${LATEST_SIZE} 字节，${LATEST_AGE}h 前；共 ${ARCHIVE_COUNT} 份）"
exit 0
