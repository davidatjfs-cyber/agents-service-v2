#!/bin/bash
# 每日健康检查：日备/周备文件存在且足够新（archive_mode 已关闭，不再检查 WAL 归档）
set -euo pipefail

LOG="${LOG:-/opt/pg_pitr/logs/backup-health.log}"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

echo "=== $(TZ=Asia/Shanghai date) backup health ==="

# 检查日备（最晚不超过 36 小时）
daily="$(ls -1t /opt/pg_pitr/daily_export/hrms_daily_*.dump 2>/dev/null | head -1 || true)"
if [[ -z "${daily}" ]]; then
  /opt/pg_pitr/scripts/pg-pitr-alert.sh send "健康检查失败: 无日备文件 /opt/pg_pitr/daily_export/hrms_daily_*.dump"
  exit 1
fi
dmtime="$(stat -c '%Y' "$daily" 2>/dev/null || stat -f '%m' "$daily")"
dnow="$(date +%s)"
dage=$(( (dnow - dmtime) / 3600 ))
if (( dage > 36 )); then
  /opt/pg_pitr/scripts/pg-pitr-alert.sh send "健康检查失败: 最新日备已 ${dage} 小时未更新: ${daily}"
  exit 1
fi

# 检查周备（最晚不超过 9 天）
weekly="$(ls -1t /opt/pg_pitr/weekly_export/hrms_weekly_*.dump 2>/dev/null | head -1 || true)"
if [[ -z "${weekly}" ]]; then
  /opt/pg_pitr/scripts/pg-pitr-alert.sh send "健康检查失败: 无周备文件 /opt/pg_pitr/weekly_export/hrms_weekly_*.dump"
  exit 1
fi
wmtime="$(stat -c '%Y' "$weekly" 2>/dev/null || stat -f '%m' "$weekly")"
wnow="$(date +%s)"
wage=$(( (wnow - wmtime) / 86400 ))
if (( wage > 9 )); then
  /opt/pg_pitr/scripts/pg-pitr-alert.sh send "健康检查失败: 最新周备已 ${wage} 天未更新: ${weekly}"
  exit 1
fi

echo "OK daily_age=${dage}h weekly_age=${wage}d file=${daily##*/}"
echo "=== $(TZ=Asia/Shanghai date) health done ==="
