#!/bin/bash
# 安装 Mac 每周一 23:00 自动从 ECS 拉取周备到「hrms backup」
# 使用当前用户 LaunchAgents，需已配置 ssh root@47.100.96.30 免密
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PLIST_SRC="$ROOT/scripts/mac-launchd/com.hrms.weekly-backup-pull.plist"
AGENT_DIR="${HOME}/Library/LaunchAgents"
PLIST_DST="$AGENT_DIR/com.hrms.weekly-backup-pull.plist"
BACKUP_META="${HRMS_MAC_BACKUP_DIR:-$HOME/hrms backup}/_meta"

mkdir -p "$BACKUP_META"
install -m 644 "$PLIST_SRC" "$PLIST_DST"

UID_NUM="$(id -u)"
# 先卸载再注册（避免改 plist 后不生效）
launchctl bootout "gui/${UID_NUM}/com.hrms.weekly-backup-pull" 2>/dev/null || true
launchctl bootstrap "gui/${UID_NUM}" "$PLIST_DST"
launchctl enable "gui/${UID_NUM}/com.hrms.weekly-backup-pull"

echo "已安装: $PLIST_DST"
echo "计划: 每周一 23:00（本机时区）rsync ECS → ${BACKUP_META%/}/.." 
echo "日志: $BACKUP_META/launchd-weekly-pull.{log,err.log}"
