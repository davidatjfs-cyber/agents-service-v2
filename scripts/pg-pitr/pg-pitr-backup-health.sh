#!/bin/bash
# 每日健康检查：archive_mode 开启、周备文件存在且足够新（不依赖 pg_stat_archiver 累计失败次数字段，以免误报）
set -euo pipefail

LOG="${LOG:-/opt/pg_pitr/logs/backup-health.log}"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

echo "=== $(TZ=Asia/Shanghai date) backup health ==="

am="$(psql -h 127.0.0.1 -U postgres -d postgres -t -A -c "SHOW archive_mode;" 2>/dev/null | tr -d '[:space:]')"
if [[ "${am}" != "on" ]]; then
  /opt/pg_pitr/scripts/pg-pitr-alert.sh send "健康检查失败: archive_mode=${am:-?}（应为 on）"
  exit 1
fi

latest="$(ls -1t /opt/pg_pitr/weekly_export/hrms_weekly_*.dump 2>/dev/null | head -1 || true)"
if [[ -z "${latest}" ]]; then
  /opt/pg_pitr/scripts/pg-pitr-alert.sh send "健康检查失败: 无周备文件 /opt/pg_pitr/weekly_export/hrms_weekly_*.dump"
  exit 1
fi

mtime="$(stat -c '%Y' "$latest" 2>/dev/null || stat -f '%m' "$latest")"
now="$(date +%s)"
age_day=$(( (now - mtime) / 86400 ))
if (( age_day > 9 )); then
  /opt/pg_pitr/scripts/pg-pitr-alert.sh send "健康检查失败: 最新周备已 ${age_day} 天未更新: ${latest}"
  exit 1
fi

echo "OK archive_mode=on last_dump_age_days=${age_day} file=${latest}"
echo "=== $(TZ=Asia/Shanghai date) health done ==="
