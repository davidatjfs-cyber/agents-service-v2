#!/bin/bash
# 删除超过 WAL_KEEP_DAYS 天的已归档 WAL 段（仅 /opt/pg_pitr/wal_archive）
# 当磁盘使用率超过 DISK_WARN_PCT 时强制清理最旧 WAL 到安全水位
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pg-pitr-common.sh
source "${SCRIPT_DIR}/pg-pitr-common.sh"
pg_pitr_register_exit_alert "pg-pitr-prune-wal"

WAL_KEEP_DAYS="${WAL_KEEP_DAYS:-3}"
WAL_DIR="/opt/pg_pitr/wal_archive"
LOG="${LOG:-/opt/pg_pitr/logs/prune-wal.log}"
DISK_WARN_PCT=85

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

# 按文件 mtime 删除过期 WAL
echo "=== $(TZ=Asia/Shanghai date) prune wal mtime+${WAL_KEEP_DAYS}d ==="

if [[ ! -d "$WAL_DIR" ]]; then
  echo "WARN: missing $WAL_DIR"
  exit 0
fi

BEFORE=$(find "$WAL_DIR" -type f | wc -l)
find "$WAL_DIR" -type f -mtime +"$WAL_KEEP_DAYS" -delete
AFTER=$(find "$WAL_DIR" -type f | wc -l)
echo "[wal] files before=${BEFORE} after=${AFTER} (deleted $((BEFORE - AFTER)))"
du -sh "$WAL_DIR" 2>/dev/null || true

# 磁盘水位安全阀：使用率超过 DISK_WARN_PCT 时强制删除最旧 WAL 直到低于阈值
USAGE=$(df / | awk 'NR==2 {gsub(/%/,""); print $5}')
if [[ "$USAGE" -ge "$DISK_WARN_PCT" ]]; then
  echo "[disk] usage ${USAGE}% >= ${DISK_WARN_PCT}%, activating emergency WAL purge"
  while true; do
    NEW_USAGE=$(df / | awk 'NR==2 {gsub(/%/,""); print $5}')
    if [[ "$NEW_USAGE" -lt "$DISK_WARN_PCT" ]]; then break; fi
    OLDEST=$(ls -t "$WAL_DIR" 2>/dev/null | tail -1)
    [[ -z "$OLDEST" ]] && break
    rm -f "${WAL_DIR}/${OLDEST}"
  done
  AFTER_EMERGENCY=$(find "$WAL_DIR" -type f | wc -l)
  echo "[emergency] files after emergency purge: ${AFTER_EMERGENCY} (removed $((AFTER - AFTER_EMERGENCY)))"
  du -sh "$WAL_DIR" 2>/dev/null || true
fi
