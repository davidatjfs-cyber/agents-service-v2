#!/bin/bash
# 删除超过 WAL_KEEP_DAYS 天的已归档 WAL 段（仅 /opt/pg_pitr/wal_archive）
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pg-pitr-common.sh
source "${SCRIPT_DIR}/pg-pitr-common.sh"
pg_pitr_register_exit_alert "pg-pitr-prune-wal"

WAL_KEEP_DAYS="${WAL_KEEP_DAYS:-35}"
WAL_DIR="/opt/pg_pitr/wal_archive"
LOG="${LOG:-/opt/pg_pitr/logs/prune-wal.log}"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "=== $(TZ=Asia/Shanghai date) prune wal mtime+${WAL_KEEP_DAYS}d ==="

if [[ ! -d "$WAL_DIR" ]]; then
  echo "WARN: missing $WAL_DIR"
  exit 0
fi

BEFORE=$(find "$WAL_DIR" -type f | wc -l)
find "$WAL_DIR" -type f -mtime +"$WAL_KEEP_DAYS" -delete
AFTER=$(find "$WAL_DIR" -type f | wc -l)
echo "[wal] files before=${BEFORE} after=${AFTER}"
du -sh "$WAL_DIR" 2>/dev/null || true
