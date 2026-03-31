#!/bin/bash
# 本地 Desktop/HRMS（或 HRMS_DIR）中的 xlsx → rsync 到 ECS /opt/hrms/incoming-sales/ → 服务端自动导入 sales_raw。
#
# 自动化：在本机执行 install-mac-sales-sync-launchagent.sh，由 launchd 定时执行（默认每 12 小时）。
# 前提：本机 ~/.ssh/id_ed25519（或 SSH_KEY_PATH 指定的密钥）可登录 ECS。
#
# 环境变量（可选）：
#   HRMS_DIR   默认 $HOME/Desktop/HRMS
#   ECS_HOST   默认 root@47.100.96.30
#   SSH_KEY_PATH 默认 $HOME/.ssh/id_ed25519
#   LOG_FILE   默认 /tmp/hrms_sync.log
#   REMOTE_INCOMING  默认 /opt/hrms/incoming-sales
#
set -euo pipefail

HRMS_DIR="${HRMS_DIR:-$HOME/Desktop/HRMS}"
ECS_HOST="${ECS_HOST:-root@47.100.96.30}"
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/id_ed25519}"
REMOTE_INCOMING="${REMOTE_INCOMING:-/opt/hrms/incoming-sales}"
LOG_FILE="${LOG_FILE:-/tmp/hrms_sync.log}"

# 使用显式密钥文件避免 launchd 环境中 SSH agent 不可用的问题
SSH_OPTS="-i ${SSH_KEY_PATH} -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ConnectTimeout=20"
export RSYNC_RSH="ssh ${SSH_OPTS}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG_FILE"; }

log "===== HRMS sales_raw 同步开始 ====="
log "源目录: $HRMS_DIR"
log "SSH密钥: $SSH_KEY_PATH"

if [[ ! -d "$HRMS_DIR" ]]; then
  log "目录不存在，退出: $HRMS_DIR"
  exit 0
fi

if [[ ! -f "$SSH_KEY_PATH" ]]; then
  log "SSH密钥不存在: $SSH_KEY_PATH（无法连接ECS，退出）"
  exit 1
fi

XLSX_COUNT=$(find "$HRMS_DIR" -maxdepth 2 -name "*.xlsx" ! -name "~*" ! -name ".*" 2>/dev/null | wc -l | tr -d ' ')
log "本地 xlsx 文件数: $XLSX_COUNT"
if [[ "$XLSX_COUNT" -eq 0 ]]; then
  log "没有找到 xlsx，退出"
  exit 0
fi

# 确保远端目录存在
ssh $SSH_OPTS "$ECS_HOST" "mkdir -p ${REMOTE_INCOMING}" 2>&1 | tee -a "$LOG_FILE" || {
  log "SSH 连接失败，请检查密钥权限：$SSH_KEY_PATH"
  exit 1
}

# rsync xlsx 文件到服务端 incoming-sales 目录，服务端会自动扫描并导入
log "开始 rsync 到 ${ECS_HOST}:${REMOTE_INCOMING}/"
rsync -avz --include="*.xlsx" --exclude="*" \
  "$HRMS_DIR/" \
  "$ECS_HOST:$REMOTE_INCOMING/" \
  2>&1 | tee -a "$LOG_FILE"

log "rsync 完成，服务端将在15分钟内自动扫描导入"

# 可选：触发服务端立即扫描（如果知道 admin token 可取消注释）
# ADMIN_TOKEN="${HRMS_ADMIN_TOKEN:-}"
# if [[ -n "$ADMIN_TOKEN" ]]; then
#   curl -s -X POST "https://47.100.96.30:3101/api/admin/sales-raw/run-folder-import" \
#     -H "Authorization: Bearer $ADMIN_TOKEN" --max-time 30 &
# fi

log "===== 同步完成 ====="
log "日志: $LOG_FILE"
