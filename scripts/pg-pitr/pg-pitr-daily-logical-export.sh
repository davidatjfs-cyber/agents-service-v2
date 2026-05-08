#!/bin/bash
# 每日逻辑全库（hrms）自定义格式压缩；保留最近 7 份
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/pg-pitr-common.sh"
pg_pitr_register_exit_alert "pg-pitr-daily-logical-export"

EXPORT_DIR="/opt/pg_pitr/daily_export"
EXPORT_KEEP="${EXPORT_KEEP:-7}"
LOG="${LOG:-/opt/pg_pitr/logs/daily-export.log}"
ALERT_ENV=/opt/pg_pitr/alert.env

mkdir -p "$EXPORT_DIR" "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "=== $(TZ=Asia/Shanghai date) daily pg_dump -Fc hrms start ==="

TS=$(TZ=Asia/Shanghai date +%Y%m%d_%H%M%S)
FILE="${EXPORT_DIR}/hrms_daily_${TS}.dump"
META="${EXPORT_DIR}/hrms_daily_${TS}.manifest.txt"

# 直接连接 pg_dump（peer auth via sudo）
sudo -u postgres pg_dump -h 127.0.0.1 -U postgres -Fc -Z9 -d hrms -f "$FILE.tmp" 2>&1 || {
  echo "[export] pg_dump FAILED"
  # 飞书告警
  if [[ -f "$ALERT_ENV" ]]; then
    source "$ALERT_ENV"
    if [[ -n "${BACKUP_ALERT_WEBHOOK:-}" ]]; then
      MSG="⚠️ 每日备份失败\n数据库: hrms\n时间: $(TZ=Asia/Shanghai date)\n任务: pg-pitr-daily-logical-export\n请检查磁盘空间和数据库连接"
      curl -s -X POST "$BACKUP_ALERT_WEBHOOK" -H 'Content-Type: application/json' \
        -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"$MSG\"}}" >/dev/null 2>&1 || true
    fi
  fi
  exit 1
}
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

# 保留最近 EXPORT_KEEP 份
mapfile -t DUMPS < <(ls -1t "${EXPORT_DIR}"/hrms_daily_*.dump 2>/dev/null || true)
count=${#DUMPS[@]}
if (( count > EXPORT_KEEP )); then
  for (( i = EXPORT_KEEP; i < count; i++ )); do
    old="${DUMPS[$i]}"
    echo "[export] remove old $old"
    rm -f "$old" "${old%.dump}.manifest.txt"
  done
fi

echo "=== $(TZ=Asia/Shanghai date) daily pg_dump done ==="
