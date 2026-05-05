#!/bin/bash
# 每周物理基础备份（pg_basebackup），仅保留最近 BASE_KEEP 份
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pg-pitr-common.sh
source "${SCRIPT_DIR}/pg-pitr-common.sh"
pg_pitr_register_exit_alert "pg-pitr-weekly-base"

BASE_DIR="/opt/pg_pitr/base"
BASE_KEEP="${BASE_KEEP:-2}"
LOG="${LOG:-/opt/pg_pitr/logs/basebackup.log}"

mkdir -p "$BASE_DIR" "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "=== $(TZ=Asia/Shanghai date) pg_basebackup start ==="

TS=$(TZ=Asia/Shanghai date +%Y%m%d_%H%M%S)
OUT="${BASE_DIR}/base_${TS}"

install -d -m 700 -o postgres -g postgres "$OUT"

sudo -u postgres pg_basebackup \
  -h 127.0.0.1 -U postgres \
  -D "$OUT" \
  -Ft -z -P \
  -X stream

echo "[base] wrote $OUT"
du -sh "$OUT" || true

# 保留最新 BASE_KEEP 个 base_* 目录
while IFS= read -r d; do
  [[ -d "$d" ]] || continue
  echo "[base] remove old $d"
  rm -rf "$d"
done < <(ls -1dt "${BASE_DIR}"/base_* 2>/dev/null | tail -n +"$((BASE_KEEP + 1))")

echo "=== $(TZ=Asia/Shanghai date) pg_basebackup done ==="
