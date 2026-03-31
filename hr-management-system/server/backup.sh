#!/bin/bash
# ================================================================
# HRMS 数据库每日自动备份脚本
# 位置: /opt/hrms/hr-management-system/server/backup.sh
# 执行: crontab -e  →  0 3 * * * /opt/hrms/hr-management-system/server/backup.sh
# ================================================================

set -euo pipefail

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/opt/hrms/backups
LOG=/var/log/hrms-backup.log
DB_NAME=hrms
KEEP_DAYS=7

mkdir -p "$BACKUP_DIR"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] ▶ 开始备份 ${DB_NAME}..." | tee -a "$LOG"

# 执行备份（使用 TCP localhost 连接，pg_hba.conf 配置为 trust）
BACKUP_FILE="${BACKUP_DIR}/${DB_NAME}_${DATE}.sql"
if pg_dump -h 127.0.0.1 -U postgres "$DB_NAME" > "$BACKUP_FILE"; then
  gzip "$BACKUP_FILE"
  SIZE=$(du -sh "${BACKUP_FILE}.gz" | cut -f1)
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ 备份成功: ${BACKUP_FILE}.gz (${SIZE})" | tee -a "$LOG"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ 备份失败！" | tee -a "$LOG"
  exit 1
fi

# 清理超过 7 天的旧备份
DELETED=$(find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -mtime "+${KEEP_DAYS}" -print -delete | wc -l)
if [ "$DELETED" -gt 0 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 🗑  已清理 ${DELETED} 个旧备份文件" | tee -a "$LOG"
fi

# 统计当前备份数量
COUNT=$(find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" | wc -l)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 📦 当前保留备份数: ${COUNT}" | tee -a "$LOG"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✔ 备份任务完成" | tee -a "$LOG"
