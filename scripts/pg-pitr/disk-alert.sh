#!/bin/bash
# 磁盘空间告警：使用率 ≥90% 时发飞书通知
set -uo pipefail

WARN=90
ALERT_ENV=/opt/pg_pitr/alert.env
WEBHOOK="${BACKUP_ALERT_WEBHOOK:-}"

USED=$(df / | awk 'NR==2 {gsub(/%/,""); print $5}')
TOTAL=$(df -h / | awk 'NR==2 {print $2}')
USED_H=$(df -h / | awk 'NR==2 {print $3}')
AVAIL=$(df -h / | awk 'NR==2 {print $4}')

if [[ "$USED" -ge "$WARN" ]]; then
  MSG="⚠️ 磁盘空间告警\n使用率: ${USED}% (${USED_H}/${TOTAL})\n剩余: ${AVAIL}\n服务器: ECS (47.100.96.30)\n建议: 检查 WAL 归档和备份文件"
  logger -t hrms-disk-alert "$MSG"
  if [[ -f "$ALERT_ENV" ]]; then
    source "$ALERT_ENV"
    if [[ -n "${BACKUP_ALERT_WEBHOOK:-}" ]]; then
      curl -s -X POST "$BACKUP_ALERT_WEBHOOK" \
        -H 'Content-Type: application/json' \
        -d "{\"msg_type\":\"text\",\"content\":{\"text\":\"$MSG\"}}" >/dev/null 2>&1 || true
    fi
  fi
fi
