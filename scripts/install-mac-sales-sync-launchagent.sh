#!/bin/bash
# 一键安装 macOS LaunchAgent：定时将 ~/Desktop/HRMS 下 xlsx 同步到 ECS 并导入 sales_raw。
# 用法：bash scripts/install-mac-sales-sync-launchagent.sh
# 可选：SALES_SYNC_INTERVAL_SEC=3600 bash ...  （默认 43200 = 12 小时）
set -euo pipefail

INTERVAL_SEC="${SALES_SYNC_INTERVAL_SEC:-43200}"
LABEL="com.hrms.sales-sync"
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/sync_to_db.sh"
AGENT_PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [[ ! -x "$SCRIPT_PATH" ]] && [[ -f "$SCRIPT_PATH" ]]; then
  chmod +x "$SCRIPT_PATH"
fi
if [[ ! -f "$SCRIPT_PATH" ]]; then
  echo "找不到 sync_to_db.sh: $SCRIPT_PATH" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"

# ProcessType=Background 降低对前台干扰；StartInterval 到期即跑；RunAtLoad 登录后尽快跑一次
cat > "$AGENT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${SCRIPT_PATH}</string>
  </array>
  <key>StartInterval</key>
  <integer>${INTERVAL_SEC}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/tmp/hrms_sync_launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/hrms_sync_launchd.err.log</string>
</dict>
</plist>
EOF

UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/${UID_NUM}" "$AGENT_PLIST"
launchctl enable "gui/${UID_NUM}/${LABEL}"
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true

echo "已安装并加载 LaunchAgent：${LABEL}"
echo "  脚本: ${SCRIPT_PATH}"
echo "  间隔: 每 ${INTERVAL_SEC} 秒（约 $((INTERVAL_SEC / 60)) 分钟）"
echo "  日志: /tmp/hrms_sync_launchd.out.log / /tmp/hrms_sync_launchd.err.log 及 /tmp/hrms_sync.log"
echo "卸载: launchctl bootout gui/${UID_NUM}/${LABEL} && rm -f \"$AGENT_PLIST\""
