#!/bin/bash
# 自动同步 Mac Desktop/HRMS 的 Excel 销售数据到 ECS 服务器
# 由 launchd 定时调用，或手动执行
# 用法：bash sync-sales-to-ecs.sh

set -e

# 配置
REMOTE_USER="root"
REMOTE_HOST="47.100.96.30"
REMOTE_DIR="/opt/hrms/incoming-sales"
LOCAL_DIR="/Users/magainze/Desktop/HRMS"
LOCK_FILE="/tmp/sync-sales-to-ecs.lock"

# 防止重复运行
if [ -f "$LOCK_FILE" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCK_FILE" 2>/dev/null || echo 0) ))
  if [ "$LOCK_AGE" -lt 300 ]; then
    exit 0  # 5分钟内不重复运行
  fi
fi
touch "$LOCK_FILE"
trap "rm -f $LOCK_FILE" EXIT

# 检查本地目录是否存在
if [ ! -d "$LOCAL_DIR" ]; then
  exit 0
fi

# 检查是否有 Excel 文件
XLSX_COUNT=$(ls "$LOCAL_DIR"/*.xlsx 2>/dev/null | wc -l | tr -d ' ')
if [ "$XLSX_COUNT" -eq 0 ]; then
  exit 0
fi

# 同步文件到服务器（只同步新文件）
rsync -avz --exclude='~$*' "$LOCAL_DIR"/*.xlsx "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/" >/dev/null 2>&1

# 触发服务器导入（通过 PM2 日志检查是否已自动导入）
# 服务器每15分钟自动扫描一次，无需手动触发

exit 0
