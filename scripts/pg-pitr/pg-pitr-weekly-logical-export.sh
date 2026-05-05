#!/bin/bash
# 每周逻辑全库（hrms）自定义格式压缩，供 rsync 到个人电脑；服务端仅保留 EXPORT_KEEP 份
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pg-pitr-common.sh
source "${SCRIPT_DIR}/pg-pitr-common.sh"
pg_pitr_register_exit_alert "pg-pitr-weekly-logical-export"

EXPORT_DIR="/opt/pg_pitr/weekly_export"
EXPORT_KEEP="${EXPORT_KEEP:-3}"
LOG="${LOG:-/opt/pg_pitr/logs/weekly-export.log}"

mkdir -p "$EXPORT_DIR" "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "=== $(TZ=Asia/Shanghai date) pg_dump -Fc hrms start ==="

TS=$(TZ=Asia/Shanghai date +%Y%m%d_%H%M%S)
FILE="${EXPORT_DIR}/hrms_weekly_${TS}.dump"
META="${EXPORT_DIR}/hrms_weekly_${TS}.manifest.txt"

sudo -u postgres pg_dump -h 127.0.0.1 -U postgres -Fc -Z9 -d hrms -f "$FILE.tmp"
mv "$FILE.tmp" "$FILE"

BYTES=$(stat -c%s "$FILE" 2>/dev/null || stat -f%z "$FILE")
{
  echo "created_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "created_shanghai=$(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "file=$FILE"
  echo "bytes=$BYTES"
  echo "human=$(du -h "$FILE" | cut -f1)"
} >"$META"

echo "[export] $FILE ($(du -h "$FILE" | cut -f1))"

# 按修改时间保留最新 EXPORT_KEEP 对 (.dump + .manifest)
mapfile -t DUMPS < <(ls -1t "${EXPORT_DIR}"/hrms_weekly_*.dump 2>/dev/null || true)
count=${#DUMPS[@]}
if (( count > EXPORT_KEEP )); then
  for (( i = EXPORT_KEEP; i < count; i++ )); do
    old="${DUMPS[$i]}"
    echo "[export] remove old $old"
    rm -f "$old" "${old%.dump}.manifest.txt"
  done
fi

echo "=== $(TZ=Asia/Shanghai date) pg_dump done ==="
