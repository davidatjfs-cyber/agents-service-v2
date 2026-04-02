#!/bin/bash
# 部署前自动备份脚本 - 生产环境使用
BACKUP_DIR="/opt/deploy-backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$BACKUP_DIR/backup_${TIMESTAMP}.log"

mkdir -p "$BACKUP_DIR/agents"
mkdir -p "$BACKUP_DIR/hrms"
mkdir -p "$BACKUP_DIR/database"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始部署前备份..." | tee -a "$LOG_FILE"

# 1. 备份agents-service-v2代码
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 备份agents代码..." | tee -a "$LOG_FILE"
cd /opt/agents-service-v2
tar -czf "$BACKUP_DIR/agents/agents_${TIMESTAMP}.tar.gz" \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.env' \
    --exclude='*.log' \
    . 2>/dev/null
echo "✅ agents代码备份完成: agents_${TIMESTAMP}.tar.gz" | tee -a "$LOG_FILE"

# 2. 备份hrms代码
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 备份hrms代码..." | tee -a "$LOG_FILE"
cd /opt/hrms/server
tar -czf "$BACKUP_DIR/hrms/hrms_${TIMESTAMP}.tar.gz" \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.env' \
    --exclude='*.log' \
    . 2>/dev/null
echo "✅ hrms代码备份完成: hrms_${TIMESTAMP}.tar.gz" | tee -a "$LOG_FILE"

# 3. 备份配置文件
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 备份配置文件..." | tee -a "$LOG_FILE"
cp /opt/agents-service-v2/.env.production "$BACKUP_DIR/agents/env_${TIMESTAMP}.production" 2>/dev/null || \
cp /opt/agents-service-v2/.env "$BACKUP_DIR/agents/env_${TIMESTAMP}" 2>/dev/null
cp /opt/hrms/server/.env "$BACKUP_DIR/hrms/env_${TIMESTAMP}" 2>/dev/null
echo "✅ 配置文件备份完成" | tee -a "$LOG_FILE"

# 4. 数据库备份（使用正确的数据库配置和环境变量）
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 备份数据库..." | tee -a "$LOG_FILE"

DATABASE_BACKUP_SUCCESS=0

# 使用正确的数据库配置和环境变量
export PGPASSWORD='Abc1234567!'

echo "尝试备份hrms数据库..." | tee -a "$LOG_FILE"
if pg_dump -h 127.0.0.1 -U hrms -d hrms > "$BACKUP_DIR/database/hrms_${TIMESTAMP}.sql" 2>>"$LOG_FILE"; then
    BACKUP_SIZE=$(ls -lh "$BACKUP_DIR/database/hrms_${TIMESTAMP}.sql" | awk '{print $5}')
    echo "✅ hrms数据库备份完成: hrms_${TIMESTAMP}.sql (大小: $BACKUP_SIZE)" | tee -a "$LOG_FILE"
    DATABASE_BACKUP_SUCCESS=1
else
    echo "❌ hrms数据库备份失败，尝试schema-only备份..." | tee -a "$LOG_FILE"
    # 如果完整备份失败，尝试仅备份结构
    if pg_dump -h 127.0.0.1 -U hrms -d hrms --schema-only > "$BACKUP_DIR/database/hrms_schema_${TIMESTAMP}.sql" 2>>"$LOG_FILE"; then
        BACKUP_SIZE=$(ls -lh "$BACKUP_DIR/database/hrms_schema_${TIMESTAMP}.sql" | awk '{print $5}')
        echo "⚠️  hrms数据库结构备份完成: hrms_schema_${TIMESTAMP}.sql (大小: $BACKUP_SIZE)" | tee -a "$LOG_FILE"
        DATABASE_BACKUP_SUCCESS=1
    else
        echo "❌ 数据库备份失败" | tee -a "$LOG_FILE"
    fi
fi

if [ "$DATABASE_BACKUP_SUCCESS" -eq 0 ]; then
    echo "❌ 数据库备份失败，请检查数据库配置" | tee -a "$LOG_FILE"
    echo "⚠️  部署将无法包含数据库备份，继续部署存在风险！" | tee -a "$LOG_FILE"
else
    echo "✅ 数据库备份成功" | tee -a "$LOG_FILE"
fi

# 5. 清理旧备份 (保留最近10个)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 清理旧备份..." | tee -a "$LOG_FILE"
find "$BACKUP_DIR/agents" -name "*.tar.gz" -mtime +10 -delete 2>/dev/null
find "$BACKUP_DIR/hrms" -name "*.tar.gz" -mtime +10 -delete 2>/dev/null
find "$BACKUP_DIR/database" -name "*.sql" -mtime +10 -delete 2>/dev/null

# 6. 更新最新备份标记
echo "$TIMESTAMP" > "$BACKUP_DIR/latest.txt"
echo "✅ 最新备份标记: $TIMESTAMP" | tee -a "$LOG_FILE"

# 7. 显示备份摘要
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 备份摘要:" | tee -a "$LOG_FILE"
echo "备份目录: $BACKUP_DIR" | tee -a "$LOG_FILE"
echo "备份时间: $TIMESTAMP" | tee -a "$LOG_FILE"
du -sh "$BACKUP_DIR" | tee -a "$LOG_FILE"
ls -lh "$BACKUP_DIR/agents/" | tail -5 | tee -a "$LOG_FILE"
ls -lh "$BACKUP_DIR/hrms/" | tail -5 | tee -a "$LOG_FILE"
ls -lh "$BACKUP_DIR/database/" | tail -5 | tee -a "$LOG_FILE"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ 备份流程完成！" | tee -a "$LOG_FILE"
echo "日志文件: $LOG_FILE"