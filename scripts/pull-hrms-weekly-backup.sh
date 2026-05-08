#!/bin/bash
# 从 ECS 拉取日备/周备逻辑全库 (.dump + manifest) 到本机
# 用法：
#   本机 cron 每日一次：0 7 * * * /path/to/pull-hrms-weekly-backup.sh
#   或通过 launchd（见 scripts/mac-launchd/ 下的 plist）
set -euo pipefail

ECS="${ECS_USER_HOST:-root@47.100.96.30}"
REMOTE_WEEKLY="/opt/pg_pitr/weekly_export"
REMOTE_DAILY="/opt/pg_pitr/daily_export"
DEST="${HRMS_MAC_BACKUP_DIR:-$HOME/hrms backup}"

mkdir -p "$DEST/weekly_export" "$DEST/daily_export" "$DEST/_meta"
TS="$(date +%Y%m%d_%H%M%S)"
LOG="$DEST/_meta/pull_${TS}.log"
exec > >(tee -a "$LOG") 2>&1

echo "=== pull start $(date) dest=$DEST ==="

# 同步周备
echo "--- weekly_export ---"
rsync -avz --progress "${ECS}:${REMOTE_WEEKLY}/" "$DEST/weekly_export/"

# 同步日备
echo "--- daily_export ---"
rsync -avz --progress "${ECS}:${REMOTE_DAILY}/" "$DEST/daily_export/"

rsync -avz "${ECS}:/opt/pg_pitr/README_PITR.txt" "$DEST/_meta/" 2>/dev/null || true

echo ""
echo "=== 本机备份体积 ==="
du -sh "$DEST" "$DEST/weekly_export" "$DEST/daily_export" 2>/dev/null || true
echo "最新备份文件:"
ls -lth "$DEST/weekly_export" 2>/dev/null | head -3
ls -lth "$DEST/daily_export" 2>/dev/null | head -3
echo "=== pull done $(date) ==="
