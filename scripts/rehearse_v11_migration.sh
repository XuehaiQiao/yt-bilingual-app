#!/usr/bin/env bash
# v1.1 迁移演练（P2-41）：只碰临时区副本，不碰真实 data/。
#
# 流程（7 步）：
#   [0] 用 sqlite3 .backup 从源库取一致快照到 $WORK/data/app.db，并复制 users/；
#   [1] 对副本跑 scripts/backup.sh，得到可回滚的备份包（记录大小/耗时/SHA256）；
#   [2] 迁移前基线快照（scripts/v11_data_snapshot.py）；
#   [3] `alembic upgrade head`（v1.0 -> v1.1），校验：旧表行数/内容哈希/用户目录不变，
#       只多出 v1.1 预期的新表（auth_tokens / feedback）与 users.email_verified_at；
#   [4] `alembic downgrade <head 的上一个 revision>`（回滚演练），校验：完全退回基线
#       （表清单/行数/哈希/users 目录全一致；会重建 users 表以删列，属真实回滚路径）；
#   [5] 再 `upgrade head` + 重复 upgrade（幂等），校验与 [3] 相同；
#   [6] 用 [1] 的备份包 `scripts/restore.sh` 整库恢复到另一临时目录，校验与基线一致
#       （证明"整库恢复"这条兜底回滚可行）；
#   [7] 复核真实 data/ 的 SHA256/mtime 在演练前后不变（只读证据），打印汇总。
#
# 用法：
#   scripts/rehearse_v11_migration.sh                # 用仓库 data/ 做源（只读），工作目录 mktemp
#   scripts/rehearse_v11_migration.sh --keep         # 保留工作目录（打印路径）
#   scripts/rehearse_v11_migration.sh --source-data /tmp/copy/data --work /tmp/drill
#   scripts/rehearse_v11_migration.sh --from-rev 0031_quota_overrides
#
# 退出码：0 = 全部 PASS；1 = 有步骤 FAIL；2 = 参数/环境错误。
# 依赖：sqlite3、shasum/sha256sum、python3（≥3.8）、backend/venv 里的 alembic。
#
# 注意：
#   - 演练期间请避免迁移以外的写入；若源服务在跑，[0] 取的是 .backup 一致快照，
#     [7] 的"源指纹不变"可能因服务自身写入而变成 WARN（不是演练写的）。
#   - 本脚本**不会**对真实 data/ 执行 alembic（AUTH_DB_PATH 始终指向 $WORK）。
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
VENV_PY="$BACKEND_DIR/venv/bin/python"
TMP_BASE="${TMPDIR:-/tmp}"; TMP_BASE="${TMP_BASE%/}"

SRC_DATA="$REPO_ROOT/data"
WORK=""
FROM_REV=""
KEEP=0
FAILED=0
SECONDS=0

log() { printf '[rehearse] %s\n' "$*"; }
warn() { printf '[rehearse] 警告：%s\n' "$*" >&2; }
fail() { printf '[rehearse] FAIL：%s\n' "$*" >&2; exit 1; }
step_fail() {
  printf '[rehearse] FAIL：%s\n' "$*" >&2
  FAILED=$((FAILED + 1))
}

usage() {
  cat <<'EOF'
v1.1 迁移演练（只碰临时区副本）

用法：
  scripts/rehearse_v11_migration.sh [--source-data DIR] [--work DIR] [--from-rev REV] [--keep]

  --source-data DIR  只读来源数据根目录（默认 <repo>/data；内含 app.db、users/）
  --work DIR         工作目录（默认 mktemp -d；必须位于 TMPDIR 或 /tmp 下）
  --from-rev REV     降级目标 revision（默认取当前 head 的 down_revision）
  --keep             保留工作目录（结束后打印路径）

退出码：0=全 PASS；1=有 FAIL；2=参数/环境错误。
EOF
}

now_ms() { "$VENV_PY" -c 'import time;print(int(time.time()*1000))'; }
elapsed_ms() { printf '%s' "$(( $(now_ms) - $1 ))"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --source-data) [ $# -ge 2 ] || { usage >&2; exit 2; }; SRC_DATA="$2"; shift 2 ;;
    --source-data=*) SRC_DATA="${1#*=}"; shift ;;
    --work) [ $# -ge 2 ] || { usage >&2; exit 2; }; WORK="$2"; shift 2 ;;
    --work=*) WORK="${1#*=}"; shift ;;
    --from-rev) [ $# -ge 2 ] || { usage >&2; exit 2; }; FROM_REV="$2"; shift 2 ;;
    --from-rev=*) FROM_REV="${1#*=}"; shift ;;
    --keep|-k) KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf '[rehearse] 未知参数：%s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

# ---- 环境检查 ----
[ -f "$VENV_PY" ] || fail "找不到 $VENV_PY（先 ./setup.sh 或建 backend/venv）"
command -v sqlite3 >/dev/null 2>&1 || fail "需要 sqlite3"
if command -v shasum >/dev/null 2>&1; then
  SHA_TOOL="shasum"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA_TOOL="sha256sum"
else
  fail "需要 shasum 或 sha256sum"
fi
sha256_file() {
  if [ "$SHA_TOOL" = "shasum" ]; then shasum -a 256 "$1" | awk '{print $1}';
  else sha256sum "$1" | awk '{print $1}'; fi
}

SRC_DATA="$(CDPATH= cd -- "$SRC_DATA" 2>/dev/null && pwd)" || fail "源数据目录不存在：$SRC_DATA"
SRC_DB="$SRC_DATA/app.db"
SRC_USERS="$SRC_DATA/users"
[ -f "$SRC_DB" ] || fail "源库不存在：$SRC_DB"
[ -d "$SRC_USERS" ] || warn "源 users 目录不存在：$SRC_USERS（按空目录演练）"

if [ -z "$WORK" ]; then
  WORK="$(mktemp -d "$TMP_BASE/linguatrek-v11-drill.XXXXXX")"
else
  mkdir -p "$WORK"
  WORK="$(CDPATH= cd -- "$WORK" && pwd)"
fi

# 硬护栏：工作目录必须在临时区，且不能指向真实 data/。
case "$WORK/" in
  "$TMP_BASE"/*|/tmp/*) ;;
  *) fail "拒绝在临时区之外演练：WORK=$WORK（需位于 $TMP_BASE 或 /tmp 下）" ;;
esac
if [ "$(CDPATH= cd -- "$WORK" && pwd -P)" = "$(CDPATH= cd -- "$REPO_ROOT/data" && pwd -P)" ]; then
  fail "WORK 不能是仓库真实 data/：$WORK"
fi

cleanup() {
  if [ "$KEEP" -eq 0 ] && [ -n "$WORK" ] && [ -d "$WORK" ]; then
    rm -rf "$WORK" || true
  fi
}
trap cleanup EXIT

DRILL_DATA="$WORK/data"
DRILL_DB="$DRILL_DATA/app.db"
DRILL_USERS="$DRILL_DATA/users"
DRILL_BACKUPS="$WORK/backups"
SNAP="$SCRIPT_DIR/v11_data_snapshot.py"
[ -f "$SNAP" ] || fail "找不到 $SNAP"

mkdir -p "$DRILL_DATA" "$DRILL_USERS" "$DRILL_BACKUPS"

log "工作目录：$WORK"
log "源数据：${SRC_DATA}（只读；演练用 .backup 快照 + 目录复制）"

# 真实数据指纹（演练前后对照，证明"没碰真实数据"）。
SRC_DB_SHA_BEFORE="$(sha256_file "$SRC_DB")"
SRC_DB_MTIME_BEFORE="$(stat -f '%m' "$SRC_DB" 2>/dev/null || stat -c '%Y' "$SRC_DB")"

T0=$(now_ms)
echo
printf '[0/7] 只读复制源库到副本 ... '
if ! sqlite3 -readonly "$SRC_DB" ".timeout 10000" ".backup '$DRILL_DB'" >"$WORK/0-copy.log" 2>&1; then
  printf 'FAIL\n'; cat "$WORK/0-copy.log" >&2
  fail "sqlite3 .backup 失败"
fi
if [ -d "$SRC_USERS" ]; then
  cp -Rp "$SRC_USERS/." "$DRILL_USERS/"
fi
SRC_USERS_COUNT="$(find "$SRC_USERS" -type f 2>/dev/null | wc -l | tr -d '[:space:]')"
DRILL_USERS_COUNT="$(find "$DRILL_USERS" -type f | wc -l | tr -d '[:space:]')"
COPY_MS="$(elapsed_ms "$T0")"
if [ "$SRC_USERS_COUNT" != "$DRILL_USERS_COUNT" ]; then
  printf '警告（%s ms）\n' "$COPY_MS"
  warn "复制期间 users 文件数变化（源 ${SRC_USERS_COUNT}，副本 ${DRILL_USERS_COUNT}）"
else
  printf 'OK（%s 个用户文件，%s ms）\n' "$DRILL_USERS_COUNT" "$COPY_MS"
fi

# ---- 1/7 备份（对副本执行 backup.sh）----
echo
printf '[1/7] 备份副本（scripts/backup.sh）... '
T1=$(now_ms)
BACKUP_LOG="$WORK/1-backup.log"
if ! DATA_DIR="$DRILL_DATA" BACKUP_ROOT="$DRILL_BACKUPS" \
     "$SCRIPT_DIR/backup.sh" >"$BACKUP_LOG" 2>&1; then
  printf 'FAIL\n'; cat "$BACKUP_LOG" >&2
  fail "备份失败"
fi
ARCHIVE="$(find "$DRILL_BACKUPS" -maxdepth 1 -type f -name 'linguatrek-backup-*.tar.gz' \
  | LC_ALL=C sort | tail -n 1)"
[ -n "$ARCHIVE" ] || fail "备份未生成归档"
ARCHIVE_BYTES="$(wc -c < "$ARCHIVE" | tr -d '[:space:]')"
ARCHIVE_SHA="$(sha256_file "$ARCHIVE")"
BACKUP_MS="$(elapsed_ms "$T1")"
printf 'OK（%s，%s 字节，%s ms）\n' "$(basename "$ARCHIVE")" "$ARCHIVE_BYTES" "$BACKUP_MS"

read_manifest() {
  tar -xzOf "$ARCHIVE" '*/manifest.env' 2>/dev/null \
    | awk -F= -v k="$1" '$1 == k {print substr($0, length(k) + 2); exit}'
}
if ! tar -tzf "$ARCHIVE" >/dev/null 2>&1; then
  fail "备份包自检失败（tar -tzf）"
fi
M_TABLES="$(read_manifest TABLE_COUNT)"
M_USERS="$(read_manifest USER_COUNT)"
M_USER_FILES="$(read_manifest USER_FILE_COUNT)"
M_DB_SHA="$(read_manifest DB_SHA256)"
M_ALEMBIC="$(read_manifest ALEMBIC_VERSION)"
M_METHOD="$(read_manifest BACKUP_METHOD)"
log "备份包：方式=${M_METHOD:-?}；表=${M_TABLES:-?}；用户=${M_USERS:-?}；users 文件=${M_USER_FILES:-?}；alembic=${M_ALEMBIC:-?}"

# ---- 2/7 迁移前基线快照 ----
echo
printf '[2/7] 迁移前基线快照 ... '
T2=$(now_ms)
BASELINE="$WORK/snapshot-baseline.json"
"$VENV_PY" "$SNAP" --db "$DRILL_DB" --users "$DRILL_USERS" --out "$BASELINE" \
  >"$WORK/2-baseline.log" 2>&1 || { printf 'FAIL\n'; cat "$WORK/2-baseline.log" >&2; fail "基线快照失败"; }
grep -E '^\[INFO\]' "$WORK/2-baseline.log" | sed 's/^\[INFO\] //' | sed 's/^/    /'
printf 'OK（%s 字节快照，%s ms）\n' "$(wc -c < "$BASELINE" | tr -d '[:space:]')" "$(elapsed_ms "$T2")"
BASELINE_MS="$(elapsed_ms "$T2")"
BASELINE_ROWS="$("$VENV_PY" -c "
import json
s = json.load(open('$BASELINE'))
print(sum(t['rows'] for t in s['tables'].values()))
")"
BASELINE_TABLES="$("$VENV_PY" -c "
import json
print(json.load(open('$BASELINE'))['table_count'])
")"

# ---- 迁移命令 ----
run_alembic() {
  ( cd "$BACKEND_DIR" && AUTH_DB_PATH="$DRILL_DB" venv/bin/python -m alembic "$@" 2>&1 )
}
rev_of() {
  run_alembic "$1" 2>/dev/null | grep -E '^[0-9]{4}_[A-Za-z0-9_]+' | head -n 1 | awk '{print $1}'
}
CURRENT_REV="$(rev_of current)"
[ -n "$CURRENT_REV" ] || fail "读不到副本的 alembic current"
HEAD_REV="$(rev_of heads)"
[ -n "$HEAD_REV" ] || fail "读不到 alembic heads"
[ "$CURRENT_REV" = "$HEAD_REV" ] || warn "副本不是 head（current=${CURRENT_REV}，head=${HEAD_REV}）"

if [ -z "$FROM_REV" ]; then
  HEAD_FILE="$(grep -l "revision: str = \"$HEAD_REV\"" "$BACKEND_DIR"/migrations/versions/*.py | head -n 1)"
  [ -n "$HEAD_FILE" ] || fail "找不到 head revision 的迁移文件：$HEAD_REV"
  FROM_REV="$(sed -n 's/^down_revision: str = "\([^"]*\)".*/\1/p' "$HEAD_FILE" | head -n 1)"
  [ -n "$FROM_REV" ] || fail "读不到 $HEAD_REV 的 down_revision"
fi
if [ "$FROM_REV" = "$HEAD_REV" ]; then
  fail "--from-rev 不能等于 head（${HEAD_REV}）"
fi

# ---- 3/7 升级到 head + 校验 ----
echo
printf '[3/7] 升级到 head（%s -> %s）... ' "$CURRENT_REV" "$HEAD_REV"
T3=$(now_ms)
if ! run_alembic upgrade head >"$WORK/3-upgrade.log" 2>&1; then
  printf 'FAIL\n'; cat "$WORK/3-upgrade.log" >&2
  fail "alembic upgrade head 失败"
fi
MIGRATE_MS="$(elapsed_ms "$T3")"
printf 'OK（%s ms）\n' "$MIGRATE_MS"
AFTER_REV="$(rev_of current)"
[ "$AFTER_REV" = "$HEAD_REV" ] || fail "升级后 current=${AFTER_REV}，期望 $HEAD_REV"
POST="$WORK/snapshot-post.json"
"$VENV_PY" "$SNAP" --db "$DRILL_DB" --users "$DRILL_USERS" --out "$POST" \
  >"$WORK/3-post.log" 2>&1 || fail "迁移后快照失败"
printf '[3/7] 校验 A：迁移后 vs 迁移前（新增表/列按白名单放行）... '
if "$VENV_PY" "$SNAP" --db "$DRILL_DB" --users "$DRILL_USERS" \
     --compare "$BASELINE" >"$WORK/3a-compare.log" 2>&1; then
  printf 'PASS\n'
  grep -E '^\[(PASS|WARN|FAIL)\]|^\[SUMMARY\]' "$WORK/3a-compare.log" | sed 's/^/    /'
else
  printf 'FAIL\n'; cat "$WORK/3a-compare.log" >&2
  step_fail "升级后与迁移前基线不一致"
fi

# ---- 4/7 降级回滚 + 校验 ----
echo
printf '[4/7] 回滚演练：downgrade -> %s ... ' "$FROM_REV"
T4=$(now_ms)
if ! run_alembic downgrade "$FROM_REV" >"$WORK/4-downgrade.log" 2>&1; then
  printf 'FAIL\n'; cat "$WORK/4-downgrade.log" >&2
  fail "alembic downgrade 失败"
fi
ROLLBACK_MS="$(elapsed_ms "$T4")"
printf 'OK（%s ms）\n' "$ROLLBACK_MS"
ROLLBACK_REV="$(rev_of current)"
[ "$ROLLBACK_REV" = "$FROM_REV" ] || fail "回滚后 current=${ROLLBACK_REV}，期望 $FROM_REV"
printf '[4/7] 校验 B：回滚后应完全退回基线（相对迁移前无任何缺失/变化）... '
if "$VENV_PY" "$SNAP" --db "$DRILL_DB" --users "$DRILL_USERS" \
     --compare "$BASELINE" --allow-new "" >"$WORK/4-compare.log" 2>&1; then
  printf 'PASS\n'
  grep -E '^\[(PASS|WARN|FAIL)\]|^\[SUMMARY\]' "$WORK/4-compare.log" | sed 's/^/    /'
else
  printf 'FAIL\n'; cat "$WORK/4-compare.log" >&2
  step_fail "downgrade 后数据/表未完全退回基线"
fi

# ---- 5/7 再升级 + 幂等 ----
echo
printf '[5/7] 再升级到 head + 重复 upgrade（幂等）... '
T5=$(now_ms)
if ! run_alembic upgrade head >"$WORK/5-upgrade.log" 2>&1; then
  printf 'FAIL\n'; cat "$WORK/5-upgrade.log" >&2
  fail "第二次 alembic upgrade head 失败"
fi
if ! run_alembic upgrade head >"$WORK/5-upgrade-again.log" 2>&1; then
  printf 'FAIL\n'; cat "$WORK/5-upgrade-again.log" >&2
  fail "重复 upgrade 失败"
fi
REUP_MS="$(elapsed_ms "$T5")"
printf 'OK（%s ms）\n' "$REUP_MS"
[ "$(rev_of current)" = "$HEAD_REV" ] || fail "重复升级后 current 不是 head"
printf '[5/7] 校验 C：重复升级后仍与迁移前基线一致... '
if "$VENV_PY" "$SNAP" --db "$DRILL_DB" --users "$DRILL_USERS" \
     --compare "$BASELINE" >"$WORK/5-compare.log" 2>&1; then
  printf 'PASS\n'
  grep -E '^\[SUMMARY\]' "$WORK/5-compare.log" | sed 's/^/    /'
else
  printf 'FAIL\n'; cat "$WORK/5-compare.log" >&2
  step_fail "重复升级后数据不一致"
fi

# ---- 6/7 整库恢复 ----
echo
printf '[6/7] 从备份包整库恢复（scripts/restore.sh）... '
T6=$(now_ms)
RESTORED="$WORK/restored"
if ! "$SCRIPT_DIR/restore.sh" "$ARCHIVE" --to "$RESTORED" >"$WORK/6-restore.log" 2>&1; then
  printf 'FAIL\n'; cat "$WORK/6-restore.log" >&2
  step_fail "restore.sh 失败"
else
  printf 'OK（%s ms）\n' "$(elapsed_ms "$T6")"
  grep -E '^\[restore\] \[(PASS|FAIL|WARN)\]|恢复结果' "$WORK/6-restore.log" | sed 's/^/    /'
  printf '[6/7] 校验 D：恢复结果 vs 迁移前基线... '
  if "$VENV_PY" "$SNAP" --db "$RESTORED/app.db" --users "$RESTORED/users" \
       --compare "$BASELINE" --allow-new "" >"$WORK/6-compare.log" 2>&1; then
    printf 'PASS\n'
    grep -E '^\[SUMMARY\]' "$WORK/6-compare.log" | sed 's/^/    /'
  else
    printf 'FAIL\n'; cat "$WORK/6-compare.log" >&2
    step_fail "恢复结果与迁移前基线不一致"
  fi
fi
RESTORE_MS="$(elapsed_ms "$T6")"

# ---- 7/7 真实数据未被改动 ----
echo
printf '[7/7] 复核真实 data/ 指纹 ... '
SRC_DB_SHA_AFTER="$(sha256_file "$SRC_DB")"
SRC_DB_MTIME_AFTER="$(stat -f '%m' "$SRC_DB" 2>/dev/null || stat -c '%Y' "$SRC_DB")"
if [ "$SRC_DB_SHA_BEFORE" = "$SRC_DB_SHA_AFTER" ] && \
   [ "$SRC_DB_MTIME_BEFORE" = "$SRC_DB_MTIME_AFTER" ]; then
  printf 'PASS（源库 SHA256 与 mtime 均未变）\n'
else
  printf 'WARN\n'
  warn "源库在演练期间发生变化（SHA/mtime）：若线上服务在写，这是服务写入而非演练写入；纯演练证据请停写后重跑"
fi

# ---- 汇总 ----
DB_BYTES="$(wc -c < "$DRILL_DB" | tr -d '[:space:]')"
USERS_SHA="$("$VENV_PY" -c "
import json
print(json.load(open('$BASELINE'))['users_dir']['sha256'])
")"

echo
echo '================ 演练汇总 ================'
printf '结论          : %s\n' "$([ "$FAILED" -eq 0 ] && echo 'PASS（全部步骤通过）' || echo "FAIL（$FAILED 项）")"
printf '版本          : %s -> %s（head）；回滚目标 %s\n' "$CURRENT_REV" "$HEAD_REV" "$FROM_REV"
printf '耗时          : 总 %ss（复制 %sms / 备份 %sms / 基线 %sms / 升级 %sms / 回滚 %sms / 再升级 %sms / 恢复 %sms）\n' \
  "$SECONDS" "$COPY_MS" "$BACKUP_MS" "$BASELINE_MS" "$MIGRATE_MS" \
  "${ROLLBACK_MS:-?}" "${REUP_MS:-?}" "$RESTORE_MS"
printf '数据体量      : app.db %s 字节；users %s 文件；迁移前 %s 表 / %s 行\n' \
  "$DB_BYTES" "$DRILL_USERS_COUNT" "$BASELINE_TABLES" "$BASELINE_ROWS"
printf '备份包        : %s（%s 字节）\n' "$(basename "$ARCHIVE")" "$ARCHIVE_BYTES"
printf '备份包 SHA256 : %s\n' "$ARCHIVE_SHA"
printf '备份内 app.db : SHA256=%s（sqlite .backup 会重写库头，与源文件 SHA 不同属正常）\n' "${M_DB_SHA:0:16}..."
printf 'users 聚合 SHA: %s\n' "$USERS_SHA"
printf 'alembic       : 备份时=%s；演练后=%s\n' "${M_ALEMBIC:-?}" "$HEAD_REV"
if [ "$KEEP" -eq 1 ]; then
  printf '工作目录保留  : %s\n' "$WORK"
else
  printf '工作目录      : 已清理（--keep 可保留）\n'
fi
echo '=========================================='

[ "$FAILED" -eq 0 ] || exit 1
exit 0
