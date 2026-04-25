#!/bin/bash
# 部署前自动备份脚本 - 生产环境使用
#
# 备份保留策略（可调环境变量，默认偏保守以保磁盘）：
#   DEPLOY_BACKUP_KEEP_HRMS_TGZ   保留 HRMS 代码包数量（默认 3）
#   DEPLOY_BACKUP_KEEP_DB_SQL     保留数据库全量/结构 SQL 数量（默认 3）
#   DEPLOY_BACKUP_KEEP_AGENTS_TGZ 保留 agents 代码包数量（默认 5）
#   DEPLOY_BACKUP_KEEP_DAYS       超过该天数的 tar/sql 由 find 删除（默认 7）
#   DEPLOY_BACKUP_KEEP_LOGS       保留 backup_*.log 条数（默认 25）
#   DEPLOY_BACKUP_KEEP_ENV        每目录保留 env_* 快照条数（默认 30）
# 紧急裁剪阈值（KiB，df -Pk 第4列）：
#   DEPLOY_BACKUP_WARN_FREE_KIB   低于此值先裁剪一轮（默认约 5GiB）
#   DEPLOY_BACKUP_CRIT_FREE_KIB   清理后仍低于此值再收紧（默认约 1GiB）
#
# 仅执行保留策略（不写新备份），便于 cron 周清理：
#   /opt/scripts/deploy-backup.sh --retention-only
set -u
BACKUP_DIR="/opt/deploy-backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$BACKUP_DIR/backup_${TIMESTAMP}.log"
ALLOW_NO_DB_BACKUP="${ALLOW_NO_DB_BACKUP:-false}"

DEPLOY_BACKUP_KEEP_HRMS_TGZ="${DEPLOY_BACKUP_KEEP_HRMS_TGZ:-3}"
DEPLOY_BACKUP_KEEP_DB_SQL="${DEPLOY_BACKUP_KEEP_DB_SQL:-3}"
DEPLOY_BACKUP_KEEP_AGENTS_TGZ="${DEPLOY_BACKUP_KEEP_AGENTS_TGZ:-5}"
DEPLOY_BACKUP_KEEP_DAYS="${DEPLOY_BACKUP_KEEP_DAYS:-7}"
DEPLOY_BACKUP_KEEP_LOGS="${DEPLOY_BACKUP_KEEP_LOGS:-25}"
DEPLOY_BACKUP_KEEP_ENV="${DEPLOY_BACKUP_KEEP_ENV:-30}"
# 5GiB / 1GiB
DEPLOY_BACKUP_WARN_FREE_KIB="${DEPLOY_BACKUP_WARN_FREE_KIB:-5242880}"
DEPLOY_BACKUP_CRIT_FREE_KIB="${DEPLOY_BACKUP_CRIT_FREE_KIB:-1048576}"

mkdir -p "$BACKUP_DIR/agents" "$BACKUP_DIR/hrms" "$BACKUP_DIR/database"

# 根分区可用过低时先裁剪旧备份（仅靠 mtime 在频繁部署 + 大库 dump 时会堆积满盘，曾导致 PostgreSQL 崩溃无法登录）
avail_kb() { df -Pk / 2>/dev/null | tail -1 | awk '{print $4}'; }

# 参数：保留 HRMS tar 份数、保留 DB SQL 份数、保留 agents tar 份数
prune_backups_by_count() {
  local keep_hrms_tar="${1:-$DEPLOY_BACKUP_KEEP_HRMS_TGZ}"
  local keep_db_sql="${2:-$DEPLOY_BACKUP_KEEP_DB_SQL}"
  local keep_agents="${3:-$DEPLOY_BACKUP_KEEP_AGENTS_TGZ}"
  (cd "$BACKUP_DIR/agents" 2>/dev/null && ls -1t agents_*.tar.gz 2>/dev/null | tail -n +$((keep_agents + 1)) | xargs -r rm -f)
  (cd "$BACKUP_DIR/hrms" 2>/dev/null && ls -1t hrms_*.tar.gz 2>/dev/null | tail -n +$((keep_hrms_tar + 1)) | xargs -r rm -f)
  (cd "$BACKUP_DIR/hrms" 2>/dev/null && ls -1t hrms_*.sql hrms_schema_*.sql 2>/dev/null | tail -n +$((keep_db_sql + 1)) | xargs -r rm -f)
  (cd "$BACKUP_DIR/database" 2>/dev/null && ls -1t hrms_*.sql hrms_schema_*.sql 2>/dev/null | tail -n +$((keep_db_sql + 1)) | xargs -r rm -f)
}

prune_backup_logs_by_count() {
  local keep="${1:-$DEPLOY_BACKUP_KEEP_LOGS}"
  (cd "$BACKUP_DIR" 2>/dev/null && ls -1t backup_*.log 2>/dev/null | tail -n +$((keep + 1)) | xargs -r rm -f)
}

prune_env_snippets_by_count() {
  local keep="${1:-$DEPLOY_BACKUP_KEEP_ENV}"
  for sub in agents hrms; do
    (cd "$BACKUP_DIR/$sub" 2>/dev/null && ls -1t env_* 2>/dev/null | tail -n +$((keep + 1)) | xargs -r rm -f)
  done
}

run_deploy_backup_retention() {
  find "$BACKUP_DIR/agents" -name "agents_*.tar.gz" -mtime +"$DEPLOY_BACKUP_KEEP_DAYS" -delete 2>/dev/null
  find "$BACKUP_DIR/hrms" -name "hrms_*.tar.gz" -mtime +"$DEPLOY_BACKUP_KEEP_DAYS" -delete 2>/dev/null
  find "$BACKUP_DIR/database" -name "*.sql" -mtime +"$DEPLOY_BACKUP_KEEP_DAYS" -delete 2>/dev/null
  prune_backups_by_count "$DEPLOY_BACKUP_KEEP_HRMS_TGZ" "$DEPLOY_BACKUP_KEEP_DB_SQL" "$DEPLOY_BACKUP_KEEP_AGENTS_TGZ"
  prune_backup_logs_by_count "$DEPLOY_BACKUP_KEEP_LOGS"
  prune_env_snippets_by_count "$DEPLOY_BACKUP_KEEP_ENV"
}

# 仅裁剪备份目录（不写新备份），供 cron 使用，例如：
#   0 3 * * 0 /bin/bash /opt/scripts/deploy-backup.sh --retention-only
if [ "${1:-}" = "--retention-only" ]; then
  PRUNE_LOG="$BACKUP_DIR/prune_$(date +%Y%m%d_%H%M%S).log"
  {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 仅执行 $BACKUP_DIR 保留策略（无新备份）"
    echo "HRMS包≤${DEPLOY_BACKUP_KEEP_HRMS_TGZ}, SQL≤${DEPLOY_BACKUP_KEEP_DB_SQL}, agents≤${DEPLOY_BACKUP_KEEP_AGENTS_TGZ}, 超${DEPLOY_BACKUP_KEEP_DAYS}天删除, backup日志≤${DEPLOY_BACKUP_KEEP_LOGS}, env≤${DEPLOY_BACKUP_KEEP_ENV}"
    echo "[before]"
    df -h /
    run_deploy_backup_retention
    POST_AVAIL=$(avail_kb)
    if [ "${POST_AVAIL:-0}" -lt "$DEPLOY_BACKUP_CRIT_FREE_KIB" ]; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ 仍低于临界可用空间，二次收紧为 2/2/2"
      prune_backups_by_count 2 2 2
      prune_backup_logs_by_count 15
      prune_env_snippets_by_count 15
    fi
    echo "[after]"
    df -h /
    du -sh "$BACKUP_DIR" "$BACKUP_DIR/database" "$BACKUP_DIR/hrms" "$BACKUP_DIR/agents" 2>/dev/null || true
  } | tee -a "$PRUNE_LOG"
  echo "日志: $PRUNE_LOG"
  exit 0
fi

PRE_AVAIL=$(avail_kb)
if [ "${PRE_AVAIL:-0}" -lt "$DEPLOY_BACKUP_WARN_FREE_KIB" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ 根分区可用偏低（${PRE_AVAIL} KiB < ${DEPLOY_BACKUP_WARN_FREE_KIB} KiB），先按数量裁剪旧备份..." | tee -a "$LOG_FILE"
  prune_backups_by_count 3 2 3
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

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 清理旧备份（保留策略: HRMS包≤${DEPLOY_BACKUP_KEEP_HRMS_TGZ}, SQL≤${DEPLOY_BACKUP_KEEP_DB_SQL}, agents包≤${DEPLOY_BACKUP_KEEP_AGENTS_TGZ}, 超过${DEPLOY_BACKUP_KEEP_DAYS}天删除）..." | tee -a "$LOG_FILE"
run_deploy_backup_retention
POST_AVAIL=$(avail_kb)
if [ "${POST_AVAIL:-0}" -lt "$DEPLOY_BACKUP_CRIT_FREE_KIB" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ 清理后根分区仍不足约 1GiB（${POST_AVAIL} KiB），进一步只保留最新 2 份 HRMS tar、2 份 SQL、2 份 agents" | tee -a "$LOG_FILE"
  prune_backups_by_count 2 2 2
  prune_backup_logs_by_count 15
  prune_env_snippets_by_count 15
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
