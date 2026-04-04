#!/bin/bash
# HRMS PostgreSQL 本地备份（含 hrms_state、积分 pointRecords JSONL 等）
# 调度由 crontab 决定；仓库示例见 backup-schedule.crontab（建议上海 12:00 + 0:00 各一次）
# 防积分等丢失：服务端 PUT /api/state 已对 pointRecords 等与 DB 合并；勿用陈旧 localStorage 整包覆盖；
# 极端恢复：server/scripts/merge-point-records-from-backup.mjs（只补缺失 id）
# Keeps 30 days of local backups on ECS；OSS 上传已关闭时仅本地保留

set -uo pipefail

BACKUP_DIR="/opt/hrms/backups"
LOG_FILE="/var/log/hrms-backup.log"
KEEP_DAYS=30
DATE=$(TZ="Asia/Shanghai" date +%Y%m%d_%H%M%S)
OSS_BUCKET="oss://xdsha/hrms-db-backups"
OSSUTIL="/usr/local/bin/ossutil"
CRITICAL_BACKUP="${BACKUP_DIR}/hrms_critical_${DATE}.sql.gz"
STATE_SNAPSHOT="${BACKUP_DIR}/hrms_state_${DATE}.json.gz"
# 积分记录：与全量 state 一致的数据源，按行一条 JSON（JSONL），便于 diff/单条恢复/对账
POINT_RECORDS_JSONL="${BACKUP_DIR}/hrms_pointRecords_${DATE}.jsonl.gz"
# 薪资相关 state 切片（工资调整、审计、月度考勤确认等），与 hrms_state 全量快照互补
PAYROLL_STATE_JSON="${BACKUP_DIR}/hrms_payroll_state_${DATE}.json.gz"

mkdir -p "$BACKUP_DIR"
exec >> "$LOG_FILE" 2>&1
echo "=== HRMS Backup started at $(TZ=Asia/Shanghai date) ==="

if [[ -f /opt/hrms/server/.env ]]; then
  set -a
  source <(grep -E '^DATABASE_URL=' /opt/hrms/server/.env | head -1)
  set +a
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL not set. Aborting."
  exit 1
fi

# 1. Critical tables dump (all business data)
echo "[1/7] Critical tables dump → ${CRITICAL_BACKUP}"
pg_dump "$DATABASE_URL" \
  -t hrms_state \
  -t daily_reports \
  -t point_records \
  -t employees \
  -t approval_requests \
  -t agent_scores \
  -t checkin_records \
  -t employee_attendance_records \
  -t hrms_payroll_domain \
  -t master_tasks \
  -t feishu_users \
  -t users \
  -t attendance_records \
  -t schedules \
  -t sales_raw \
  -t store_ratings \
  -t kpi_snapshots \
  -t kpi_targets \
  -t marketing_campaigns \
  -t bad_reviews \
  -t table_visit_records \
  2>&1 | gzip > "$CRITICAL_BACKUP"
SIZE=$(du -sh "$CRITICAL_BACKUP" 2>/dev/null | cut -f1)
echo "  Critical dump: ${SIZE}"

# 2. JSON snapshot of hrms_state only (fast restore for in-memory state)
echo "[2/7] hrms_state JSON snapshot → ${STATE_SNAPSHOT}"
psql "$DATABASE_URL" -t -A -c "SELECT data FROM hrms_state WHERE key='default' LIMIT 1" 2>/dev/null | gzip > "$STATE_SNAPSHOT"
SIZE2=$(du -sh "$STATE_SNAPSHOT" 2>/dev/null | cut -f1)
echo "  State snapshot: ${SIZE2}"

# 3. pointRecords only — 每行一条积分记录（JSONL），定时与全库备份同源
echo "[3/7] pointRecords JSONL → ${POINT_RECORDS_JSONL}"
psql "$DATABASE_URL" -t -A -c \
  "SELECT elem::text FROM hrms_state, LATERAL jsonb_array_elements(COALESCE(data->'pointRecords','[]'::jsonb)) AS elem WHERE key='default'" \
  2>/dev/null | gzip > "${POINT_RECORDS_JSONL}.tmp" && mv "${POINT_RECORDS_JSONL}.tmp" "$POINT_RECORDS_JSONL" || true
# 若无 default 行，上面可能产出空文件；仍保留占位便于 cron 监控
if [[ ! -s "$POINT_RECORDS_JSONL" ]]; then
  echo "  WARN: pointRecords JSONL empty or export failed (check psql / hrms_state)"
else
  SIZE3=$(du -sh "$POINT_RECORDS_JSONL" 2>/dev/null | cut -f1)
  echo "  pointRecords JSONL: ${SIZE3}"
fi

# 4. 薪资域 state 切片（考勤确认、工资调整、审计等）
echo "[4/7] payroll-related state slice → ${PAYROLL_STATE_JSON}"
psql "$DATABASE_URL" -t -A -c \
  "SELECT jsonb_strip_nulls(jsonb_build_object(
     'payrollAdjustments', data->'payrollAdjustments',
     'payrollAudits', data->'payrollAudits',
     'salaryAdjustments', data->'salaryAdjustments',
     'monthlyConfirmations', data->'monthlyConfirmations'
   ))::text FROM hrms_state WHERE key='default' LIMIT 1" \
  2>/dev/null | gzip > "${PAYROLL_STATE_JSON}.tmp" && mv "${PAYROLL_STATE_JSON}.tmp" "$PAYROLL_STATE_JSON" || true
if [[ ! -s "$PAYROLL_STATE_JSON" ]]; then
  echo "  WARN: payroll state slice empty or export failed"
else
  SIZE4=$(du -sh "$PAYROLL_STATE_JSON" 2>/dev/null | cut -f1)
  echo "  payroll state slice: ${SIZE4}"
fi

# 5. pointRecords + dailyReports + 考勤 quick verification
echo "[5/7] Verification..."
PR_COUNT=$(psql "$DATABASE_URL" -t -A -c "SELECT jsonb_array_length(COALESCE(data->'pointRecords','[]'::jsonb)) FROM hrms_state WHERE key='default'" 2>/dev/null || echo "?")
DR_COUNT=$(psql "$DATABASE_URL" -t -A -c "SELECT jsonb_array_length(COALESCE(data->'dailyReports','[]'::jsonb)) FROM hrms_state WHERE key='default'" 2>/dev/null || echo "?")
DR_TABLE=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM daily_reports" 2>/dev/null || echo "?")
CK_COUNT=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM checkin_records" 2>/dev/null || echo "?")
AT_COUNT=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM attendance_records" 2>/dev/null || echo "?")
echo "  pointRecords in state: ${PR_COUNT}"
echo "  dailyReports in state: ${DR_COUNT} | daily_reports table: ${DR_TABLE}"
echo "  checkin_records: ${CK_COUNT} | attendance_records: ${AT_COUNT}"

# 6. OSS upload DISABLED to reduce costs
echo "[6/7] OSS upload DISABLED - backups remain local only"

# 7. Cleanup old local backups（含 hrms_pointRecords_*.jsonl.gz、hrms_payroll_state_*.json.gz）
echo "[7/7] Cleanup old local backups..."
find "$BACKUP_DIR" -name "hrms_*.gz" -mtime +${KEEP_DAYS} -delete 2>/dev/null || true
BACKUP_COUNT=$(find "$BACKUP_DIR" -name "*.gz" | wc -l)
echo "[cleanup] Remaining local backups: ${BACKUP_COUNT} files"

echo "=== Backup COMPLETED at $(TZ=Asia/Shanghai date) ==="
echo ""
