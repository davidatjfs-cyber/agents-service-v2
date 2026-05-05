#!/bin/bash
# 备份失败告警：写 syslog + 可选飞书自定义机器人 Webhook
# 配置：在 ECS 创建 /opt/pg_pitr/alert.env（可复制本目录 alert.env.example），至少设置：
#   BACKUP_ALERT_WEBHOOK='https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx'
# 用法：/opt/pg_pitr/scripts/pg-pitr-alert.sh send "消息内容"

set -euo pipefail

if [[ -f /opt/pg_pitr/alert.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /opt/pg_pitr/alert.env
  set +a
fi

send() {
  local text="$*"
  local host
  host="$(hostname -f 2>/dev/null || hostname)"
  text="[HRMS备份 ${host}] ${text}"
  logger -t hrms-backup-alert "${text}" 2>/dev/null || true
  if [[ -z "${BACKUP_ALERT_WEBHOOK:-}" ]]; then
    echo "${text}" >&2
    return 0
  fi
  local payload
  payload="$(python3 -c 'import json,sys; print(json.dumps({"msg_type":"text","content":{"text":sys.argv[1]}},ensure_ascii=False))' "${text}")"
  if ! curl -sS --connect-timeout 5 --max-time 25 -X POST "${BACKUP_ALERT_WEBHOOK}" \
    -H 'Content-Type: application/json' \
    -d "${payload}"; then
    echo "[pg-pitr-alert] curl webhook failed" >&2
  fi
}

case "${1:-}" in
  send) shift; send "$*" ;;
  *) echo "usage: $0 send <message>" >&2; exit 1 ;;
esac
