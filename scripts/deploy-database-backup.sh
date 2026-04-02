#!/bin/bash
# 修正的数据库备份脚本 - 专门针对您的数据库配置
BACKUP_DIR="/opt/deploy-backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S")
LOG_FILE="$BACKUP_DIR/backup_${TIMESTAMP}.log"

mkdir -p "$BACKUP_DIR/database"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始数据库备份..." | tee -a "$LOG_FILE"

# 使用正确的数据库配置
DATABASE_URL="postgres://hrms:Abc1234567!@127.0.0.1:5432/hrms"

echo "尝试使用数据库配置备份..." | tee -a "$LOG_FILE"
if pg_dump "$DATABASE_URL" > "$BACKUP_DIR/database/hrms_${TIMESTAMP}.sql" 2>>"$LOG_FILE"; then
    echo "✅ hrms数据库备份完成: hrms_${TIMESTAMP}.sql" | tee -a "$LOG_FILE"
    DATABASE_BACKUP_SUCCESS=1
else
    echo "❌ 数据库备份失败" | tee -a "$LOG_FILE"
    DATABASE_BACKUP_SUCCESS=0
fi

if [ "$DATABASE_BACKUP_SUCCESS" -eq 1 ]; then
    echo "✅ 数据库备份成功" | tee -a "$LOG_FILE"
else
    echo "❌ 数据库备份失败，请检查数据库配置" | tee -a "$LOG_FILE"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ 数据库备份流程完成！" | tee -a "$LOG_FILE"
echo "备份文件: $BACKUP_DIR/database/hrms_${TIMESTAMP}.sql" | tee -a "$LOG_FILE"