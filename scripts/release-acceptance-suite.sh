#!/usr/bin/env bash
# 固定全量浏览器验收：逐个 scripts/*acceptance*.mjs，单脚本 300s。
# 用法：bash scripts/release-acceptance-suite.sh
#       ONLY=admin-feedback bash scripts/release-acceptance-suite.sh   # debug subset
# 输出：<OUT>/acceptance.tsv，默认 /tmp/release/acceptance
set -u
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUT="${OUT:-/tmp/release/acceptance}"
WEB="${APP_URL:-http://127.0.0.1:5173}"
WEB="${WEB%/}/"
API="${API_URL:-http://127.0.0.1:8000}"
ONLY="${ONLY:-}"
SKIP="${SKIP:-}"
SKIP_REASON="${SKIP_REASON:-}"
# Prefer an explicitly configured browser; otherwise use a local Chrome if one
# exists. Scripts that use Playwright's bundled chromium still work without it.
if [ -z "${CHROME_PATH:-}" ]; then
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$(command -v google-chrome 2>/dev/null || true)" \
    "$(command -v chromium 2>/dev/null || true)" \
    "$(command -v chromium-browser 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      CHROME_PATH="$candidate"
      break
    fi
  done
fi
if [ -z "${CHROME_PATH:-}" ] && [ -d "$ROOT/scripts/node_modules" ]; then
  CHROME_PATH="$(cd "$ROOT/scripts" && node -e 'console.log(require("playwright").chromium.executablePath())' 2>/dev/null || true)"
fi
export CHROME_PATH="${CHROME_PATH:-}"
export PLAYWRIGHT_CHROMIUM_EXECUTABLE="${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-$CHROME_PATH}"

mkdir -p "$OUT/logs"
TSV="$OUT/acceptance.tsv"
META="$OUT/meta.txt"
: > "$TSV"
{
  echo "suite=release-acceptance"
  echo "app_url=$WEB"
  echo "api_url=$API"
  echo "repo_head=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$META"
pass=0; fail=0; skip=0; total=0

if ! command -v timeout >/dev/null 2>&1; then
  echo "ERROR: timeout not found (install coreutils)" >&2
  exit 2
fi

for f in "$ROOT"/scripts/*acceptance*.mjs; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  if [ -n "$ONLY" ] && ! printf '%s\n' "$name" | grep -Eq "$ONLY"; then
    continue
  fi
  total=$((total+1))
  if [ -n "$SKIP" ] && printf '%s\n' "$name" | grep -Eq "$SKIP"; then
    if [ -z "$SKIP_REASON" ]; then
      printf 'FAIL\t%s\t0s\t-\tskip requested without reason\n' "$name" | tee -a "$TSV"
      fail=$((fail+1))
    else
      printf 'SKIP\t%s\t0s\t-\t%s\n' "$name" "$SKIP_REASON" | tee -a "$TSV"
      skip=$((skip+1))
    fi
    continue
  fi
  log="$OUT/logs/${name%.mjs}.log"
  start=$(date +%s)
  attempt=0
  code=1
  RETRY="${RETRY:-1}"
  while [ "$attempt" -le "$RETRY" ]; do
    if [ "$attempt" -gt 0 ]; then
      log="${log%.log}.retry${attempt}.log"
    fi
    ( cd "$ROOT" && APP_URL="$WEB" APP_BASE="$WEB" API_URL="$API" \
        timeout 300 node "$f" >"$log" 2>&1 )
    code=$?
    [ "$code" -eq 0 ] && break
    attempt=$((attempt + 1))
  done
  elapsed=$(( $(date +%s) - start ))
  if [ "$code" -eq 0 ]; then
    status=PASS
    [ "$attempt" -gt 0 ] && note="retry-pass" || note="-"
    pass=$((pass+1))
  elif [ "$code" -eq 124 ]; then status=TIMEOUT; note="-"; fail=$((fail+1));
  else status=FAIL; note="-"; fail=$((fail+1)); fi
  printf '%s\t%s\t%ss\t%s\t%s\n' "$status" "$name" "$elapsed" "$log" "$note" | tee -a "$TSV"
done
printf '\nTOTAL=%s PASS=%s FAIL=%s SKIP=%s\n' "$total" "$pass" "$fail" "$skip"
# A release gate requires at least one executed acceptance and zero SKIP.
# SKIP exists only for local debugging; it can never produce a GO report.
[ "$total" -gt 0 ] && [ "$fail" -eq 0 ] && [ "$skip" -eq 0 ]
