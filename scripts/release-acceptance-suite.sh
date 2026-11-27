#!/usr/bin/env bash
# 固定全量浏览器验收：逐個 scripts/*acceptance*.mjs，单脚本 300s。
# 用法：bash scripts/release-acceptance-suite.sh
# 输出：<OUT>/acceptance.tsv，默认 /tmp/release/acceptance
set -u
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
OUT="${OUT:-/tmp/release/acceptance}"
WEB="${APP_URL:-http://127.0.0.1:5173}"
WEB="${WEB%/}/"
API="${API_URL:-http://127.0.0.1:8000}"
mkdir -p "$OUT/logs"
TSV="$OUT/acceptance.tsv"
: > "$TSV"
pass=0; fail=0; skip=0
for f in "$ROOT"/scripts/*acceptance*.mjs; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  log="$OUT/logs/${name%.mjs}.log"
  start=$(date +%s)
  python3 - "$f" "$log" "$WEB" "$API" <<'PY'
import os, subprocess, sys
script, log, web, api = sys.argv[1:5]
env = dict(os.environ, APP_URL=web, APP_BASE=web, API_URL=api)
with open(log, 'wb') as fh:
    try:
        p = subprocess.run(['node', script], stdout=fh, stderr=subprocess.STDOUT,
                           env=env, timeout=300)
        sys.exit(p.returncode)
    except subprocess.TimeoutExpired:
        fh.write(b'\n[release-suite] TIMEOUT after 300s\n')
        sys.exit(124)
PY
  code=$?
  elapsed=$(( $(date +%s) - start ))
  if [ "$code" -eq 0 ]; then status=PASS; pass=$((pass+1));
  elif [ "$code" -eq 124 ]; then status=TIMEOUT; fail=$((fail+1));
  else status=FAIL; fail=$((fail+1)); fi
  printf '%s\t%s\t%ss\t%s\n' "$status" "$name" "$elapsed" "$log" | tee -a "$TSV"
done
printf '\nPASS=%s FAIL=%s SKIP=%s\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ]
