#!/bin/bash
# 从 ECS 拉取周备逻辑全库 (.dump + manifest) 与 PITR 说明到本机
# 用法：本机 cron 每周一次，例如：0 6 * * 0 /path/to/pull-hrms-weekly-backup.sh
set -euo pipefail

ECS="${ECS_USER_HOST:-root@47.100.96.30}"
REMOTE_EXPORT="/opt/pg_pitr/weekly_export"
# 路径含空格时需引号；可通过环境变量 HRMS_MAC_BACKUP_DIR 覆盖
DEST="${HRMS_MAC_BACKUP_DIR:-$HOME/hrms backup}"

mkdir -p "$DEST/weekly_export" "$DEST/_meta"
TS="$(date +%Y%m%d_%H%M%S)"
LOG="$DEST/_meta/pull_${TS}.log"
exec > >(tee -a "$LOG") 2>&1

echo "=== pull start $(date) dest=$DEST ==="
rsync -avz --progress "${ECS}:${REMOTE_EXPORT}/" "$DEST/weekly_export/"
rsync -avz "${ECS}:/opt/pg_pitr/README_PITR.txt" "$DEST/_meta/" 2>/dev/null || true

echo ""
echo "=== 本机备份体积 ==="
du -sh "$DEST" "$DEST/weekly_export" 2>/dev/null || true
echo "最新周备文件:"
ls -lth "$DEST/weekly_export" 2>/dev/null | head -6
echo "=== pull done $(date) ==="
