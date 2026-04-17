#!/bin/bash
# 部署前自动备份脚本 - 生产环境使用
set -u
BACKUP_DIR="/opt/deploy-backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$BACKUP_DIR/backup_${TIMESTAMP}.log"
ALLOW_NO_DB_BACKUP="${ALLOW_NO_DB_BACKUP:-false}"

mkdir -p "$BACKUP_DIR/agents" "$BACKUP_DIR/hrms" "$BACKUP_DIR/database"

# 根分区可用过低时先裁剪旧备份（仅靠 mtime+10 在频繁部署 + 大库 dump 时会堆积满盘，曾导致 PostgreSQL 崩溃无法登录）
avail_kb() { df -Pk / 2>/dev/null | tail -1 | awk '{print $4}'; }
prune_backups_by_count() {
  local keep_hrms_tar="${1:-8}"
  local keep_db_sql="${2:-6}"
  (cd "$BACKUP_DIR/hrms" 2>/dev/null && ls -1t hrms_*.tar.gz 2>/dev/null | tail -n +$((keep_hrms_tar + 1)) | xargs -r rm -f)
  (cd "$BACKUP_DIR/hrms" 2>/dev/null && ls -1t hrms_*.sql hrms_schema_*.sql 2>/dev/null | tail -n +$((keep_db_sql + 1)) | xargs -r rm -f)
  (cd "$BACKUP_DIR/database" 2>/dev/null && ls -1t hrms_*.sql hrms_schema_*.sql 2>/dev/null | tail -n +$((keep_db_sql + 1)) | xargs -r rm -f)
}
PRE_AVAIL=$(avail_kb)
if [ "${PRE_AVAIL:-0}" -lt 3145728 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ 根分区可用不足约 3GiB（${PRE_AVAIL} KiB），紧急按数量裁剪旧 HRMS/DB 备份..." | tee -a "$LOG_FILE"
  prune_backups_by_count 4 3
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始部署前备份..." | tee -a "$LOG_FILE"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 备份agents代码..." | tee -a "$LOG_FILE"
cd /opt/agents-service-v2 || exit 1
tar -czf "$BACKUP_DIR/agents/agents_${TIMESTAMP}.tar.gz" --exclude='node_modules' --exclude='.git' --exclude='.env' --exclude='*.log' . 2>/dev/null
echo "✅ agents代码备份完成: agents_${TIMESTAMP}.tar.gz" | tee -a "$LOG_FILE"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 备份hrms代码..." | tee -a "$LOG_FILE"
cd /opt/hrms/server || exit 1
tar -czf "$BACKUP_DIR/hrms/hrms_${TIMESTAMP}.tar.gz" --exclude='node_modules' --exclude='.git' --exclude='.env' --exclude='*.log' . 2>/dev/null
echo "✅ hrms代码备份完成: hrms_${TIMESTAMP}.tar.gz" | tee -a "$LOG_FILE"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 备份配置文件..." | tee -a "$LOG_FILE"
cp /opt/agents-service-v2/.env.production "$BACKUP_DIR/agents/env_${TIMESTAMP}.production" 2>/dev/null || cp /opt/agents-service-v2/.env "$BACKUP_DIR/agents/env_${TIMESTAMP}" 2>/dev/null || true
cp /opt/hrms/server/.env "$BACKUP_DIR/hrms/env_${TIMESTAMP}" 2>/dev/null || true
echo "✅ 配置文件备份完成" | tee -a "$LOG_FILE"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 备份数据库..." | tee -a "$LOG_FILE"
DATABASE_BACKUP_SUCCESS=0

DB_HOST="127.0.0.1"; DB_PORT="5432"; DB_NAME="hrms"; DB_USER="hrms"; DB_PASSWORD='Abc1234567!'; DB_BACKUP_USER='postgres'; DB_BACKUP_PASSWORD=''
if [ -f /opt/hrms/server/.env ]; then
  DB_HOST=$(grep -E '^DB_HOST=' /opt/hrms/server/.env | tail -1 | cut -d= -f2-)
  DB_PORT=$(grep -E '^DB_PORT=' /opt/hrms/server/.env | tail -1 | cut -d= -f2-)
  DB_NAME=$(grep -E '^DB_NAME=' /opt/hrms/server/.env | tail -1 | cut -d= -f2-)
  DB_USER=$(grep -E '^DB_USER=' /opt/hrms/server/.env | tail -1 | cut -d= -f2-)
  DB_PASSWORD=$(grep -E '^DB_PASSWORD=' /opt/hrms/server/.env | tail -1 | cut -d= -f2-)
  DB_BACKUP_USER=$(grep -E '^DB_BACKUP_USER=' /opt/hrms/server/.env | tail -1 | cut -d= -f2-)
  DB_BACKUP_PASSWORD=$(grep -E '^DB_BACKUP_PASSWORD=' /opt/hrms/server/.env | tail -1 | cut -d= -f2-)
fi
[ -z "$DB_HOST" ] && DB_HOST="127.0.0.1"
[ -z "$DB_PORT" ] && DB_PORT="5432"
[ -z "$DB_NAME" ] && DB_NAME="hrms"
[ -z "$DB_USER" ] && DB_USER="hrms"
[ -z "$DB_PASSWORD" ] && DB_PASSWORD='Abc1234567!'
[ -z "$DB_BACKUP_USER" ] && DB_BACKUP_USER='postgres'
[ -z "$DB_BACKUP_PASSWORD" ] && DB_BACKUP_PASSWORD="$DB_PASSWORD"

DUMP_USER="$DB_BACKUP_USER"
DUMP_PASSWORD="$DB_BACKUP_PASSWORD"
EXCLUDE_ARGS=()

export PGPASSWORD="$DUMP_PASSWORD"
if ! psql -h "$DB_HOST" -p "$DB_PORT" -U "$DUMP_USER" -d "$DB_NAME" -Atc "SELECT 1" >/dev/null 2>>"$LOG_FILE"; then
  echo "⚠️ 备份账号 ${DUMP_USER} 不可用，回退到应用账号 ${DB_USER}" | tee -a "$LOG_FILE"
  DUMP_USER="$DB_USER"
  DUMP_PASSWORD="$DB_PASSWORD"
  export PGPASSWORD="$DUMP_PASSWORD"
fi

echo "尝试备份 ${DB_NAME} 数据库（${DUMP_USER}@${DB_HOST}:${DB_PORT}）..." | tee -a "$LOG_FILE"

if [ "$DUMP_USER" = "$DB_USER" ]; then
  MISSING_TABLES=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -At <<'SQL' 2>>"$LOG_FILE"
SELECT schemaname || '.' || tablename
FROM pg_tables
WHERE schemaname='public'
  AND NOT has_table_privilege(current_user, quote_ident(schemaname)||'.'||quote_ident(tablename), 'SELECT')
ORDER BY 1;
SQL
)
  if [ -n "$MISSING_TABLES" ]; then
    while IFS= read -r t; do [ -n "$t" ] && EXCLUDE_ARGS+=("--exclude-table=$t"); done <<< "$MISSING_TABLES"
    echo "⚠️ 检测到无权限表，备份将排除：$(echo "$MISSING_TABLES" | tr '\n' ' ' )" | tee -a "$LOG_FILE"
  fi

  MISSING_SEQS=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -At <<'SQL' 2>>"$LOG_FILE"
SELECT n.nspname || '.' || c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'S'
  AND n.nspname = 'public'
  AND NOT has_sequence_privilege(current_user, quote_ident(n.nspname)||'.'||quote_ident(c.relname), 'SELECT')
ORDER BY 1;
SQL
)
  if [ -n "$MISSING_SEQS" ]; then
    while IFS= read -r seq; do [ -n "$seq" ] && EXCLUDE_ARGS+=("--exclude-table=$seq"); done <<< "$MISSING_SEQS"
    echo "⚠️ 检测到无权限序列，备份将排除：$(echo "$MISSING_SEQS" | tr '\n' ' ' )" | tee -a "$LOG_FILE"
  fi
fi

if pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DUMP_USER" -d "$DB_NAME" "${EXCLUDE_ARGS[@]}" > "$BACKUP_DIR/database/hrms_${TIMESTAMP}.sql" 2>>"$LOG_FILE"; then
  BACKUP_SIZE=$(ls -lh "$BACKUP_DIR/database/hrms_${TIMESTAMP}.sql" | awk '{print $5}')
  if [ -s "$BACKUP_DIR/database/hrms_${TIMESTAMP}.sql" ]; then
    echo "✅ hrms数据库备份完成: hrms_${TIMESTAMP}.sql (大小: $BACKUP_SIZE)" | tee -a "$LOG_FILE"
    DATABASE_BACKUP_SUCCESS=1
  else
    echo "❌ 数据库备份文件为空" | tee -a "$LOG_FILE"
  fi
else
  echo "❌ hrms数据库备份失败，尝试schema-only备份..." | tee -a "$LOG_FILE"
  if pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DUMP_USER" -d "$DB_NAME" --schema-only "${EXCLUDE_ARGS[@]}" > "$BACKUP_DIR/database/hrms_schema_${TIMESTAMP}.sql" 2>>"$LOG_FILE"; then
    BACKUP_SIZE=$(ls -lh "$BACKUP_DIR/database/hrms_schema_${TIMESTAMP}.sql" | awk '{print $5}')
    if [ -s "$BACKUP_DIR/database/hrms_schema_${TIMESTAMP}.sql" ]; then
      echo "⚠️ hrms数据库结构备份完成: hrms_schema_${TIMESTAMP}.sql (大小: $BACKUP_SIZE)" | tee -a "$LOG_FILE"
      DATABASE_BACKUP_SUCCESS=1
    else
      echo "❌ 数据库结构备份文件为空" | tee -a "$LOG_FILE"
    fi
  else
    echo "❌ 数据库备份失败" | tee -a "$LOG_FILE"
  fi
fi

if [ "$DATABASE_BACKUP_SUCCESS" -eq 0 ]; then
  echo "❌ 数据库备份失败，请检查数据库配置与权限" | tee -a "$LOG_FILE"
  if [ "$ALLOW_NO_DB_BACKUP" = "true" ]; then
    echo "⚠️ ALLOW_NO_DB_BACKUP=true，继续部署（有风险）" | tee -a "$LOG_FILE"
  else
    echo "❌ 默认严格模式：终止部署（可设置 ALLOW_NO_DB_BACKUP=true 强制继续）" | tee -a "$LOG_FILE"
    exit 2
  fi
else
  echo "✅ 数据库备份成功" | tee -a "$LOG_FILE"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 清理旧备份..." | tee -a "$LOG_FILE"
find "$BACKUP_DIR/agents" -name "*.tar.gz" -mtime +10 -delete 2>/dev/null
find "$BACKUP_DIR/hrms" -name "*.tar.gz" -mtime +10 -delete 2>/dev/null
find "$BACKUP_DIR/database" -name "*.sql" -mtime +10 -delete 2>/dev/null
# 按数量上限保留（防止 10 天内高频部署 + 大体积 pg_dump 占满磁盘）
prune_backups_by_count 8 6
POST_AVAIL=$(avail_kb)
if [ "${POST_AVAIL:-0}" -lt 1048576 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ 清理后根分区仍不足约 1GiB，进一步只保留最新 3 份 HRMS tar 与 2 份 SQL" | tee -a "$LOG_FILE"
  prune_backups_by_count 3 2
fi

echo "$TIMESTAMP" > "$BACKUP_DIR/latest.txt"
echo "✅ 最新备份标记: $TIMESTAMP" | tee -a "$LOG_FILE"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 备份摘要:" | tee -a "$LOG_FILE"
echo "备份目录: $BACKUP_DIR" | tee -a "$LOG_FILE"
echo "备份时间: $TIMESTAMP" | tee -a "$LOG_FILE"
du -sh "$BACKUP_DIR" | tee -a "$LOG_FILE"
ls -lh "$BACKUP_DIR/agents/" | tail -5 | tee -a "$LOG_FILE"
ls -lh "$BACKUP_DIR/hrms/" | tail -5 | tee -a "$LOG_FILE"
ls -lh "$BACKUP_DIR/database/" | tail -5 | tee -a "$LOG_FILE"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ 备份流程完成！" | tee -a "$LOG_FILE"
echo "日志文件: $LOG_FILE"
