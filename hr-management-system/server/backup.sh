#!/bin/bash
# HRMS PostgreSQL daily backup
# Runs at 3:00 AM Shanghai time (19:00 UTC)
# Keeps 30 days of local backups on ECS + uploads to Alibaba Cloud OSS for offsite retention

set -uo pipefail

BACKUP_DIR="/opt/hrms/backups"
LOG_FILE="/var/log/hrms-backup.log"
KEEP_DAYS=30
DATE=$(TZ="Asia/Shanghai" date +%Y%m%d_%H%M%S)
OSS_BUCKET="oss://xdsha/hrms-db-backups"
OSSUTIL="/usr/local/bin/ossutil"
CRITICAL_BACKUP="${BACKUP_DIR}/hrms_critical_${DATE}.sql.gz"
STATE_SNAPSHOT="${BACKUP_DIR}/hrms_state_${DATE}.json.gz"

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
echo "[1/3] Critical tables dump → ${CRITICAL_BACKUP}"
pg_dump "$DATABASE_URL" \
  -t hrms_state \
  -t daily_reports \
  -t approval_requests \
  -t agent_scores \
  -t checkin_records \
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
echo "[2/3] hrms_state JSON snapshot → ${STATE_SNAPSHOT}"
psql "$DATABASE_URL" -t -A -c "SELECT data FROM hrms_state WHERE key='default' LIMIT 1" 2>/dev/null | gzip > "$STATE_SNAPSHOT"
SIZE2=$(du -sh "$STATE_SNAPSHOT" 2>/dev/null | cut -f1)
echo "  State snapshot: ${SIZE2}"

# 3. pointRecords + dailyReports quick verification
echo "[3/3] Verification..."
PR_COUNT=$(psql "$DATABASE_URL" -t -A -c "SELECT jsonb_array_length(COALESCE(data->'pointRecords','[]'::jsonb)) FROM hrms_state WHERE key='default'" 2>/dev/null || echo "?")
DR_COUNT=$(psql "$DATABASE_URL" -t -A -c "SELECT jsonb_array_length(COALESCE(data->'dailyReports','[]'::jsonb)) FROM hrms_state WHERE key='default'" 2>/dev/null || echo "?")
DR_TABLE=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM daily_reports" 2>/dev/null || echo "?")
echo "  pointRecords in state: ${PR_COUNT}"
echo "  dailyReports in state: ${DR_COUNT} | daily_reports table: ${DR_TABLE}"

# 4. Upload to OSS (offsite backup)
if [[ -x "$OSSUTIL" ]]; then
  echo "[4/5] Uploading to OSS ${OSS_BUCKET}..."
  "$OSSUTIL" cp "$CRITICAL_BACKUP" "${OSS_BUCKET}/critical/" -f 2>&1 && echo "  critical dump → OSS OK" || echo "  WARNING: critical dump OSS upload failed"
  "$OSSUTIL" cp "$STATE_SNAPSHOT"  "${OSS_BUCKET}/state/"    -f 2>&1 && echo "  state snapshot → OSS OK" || echo "  WARNING: state snapshot OSS upload failed"
  # Remove OSS files older than 30 days
  "$OSSUTIL" rm "${OSS_BUCKET}/critical/" --include "hrms_critical_$(TZ=Asia/Shanghai date -d '-30 days' +%Y%m%d)*" -r -f 2>/dev/null || true
  "$OSSUTIL" rm "${OSS_BUCKET}/state/"    --include "hrms_state_$(TZ=Asia/Shanghai date -d '-30 days' +%Y%m%d)*"    -r -f 2>/dev/null || true
else
  echo "[4/5] SKIPPED: ossutil not found at ${OSSUTIL}"
fi

# 5. Cleanup old local backups
echo "[5/5] Cleanup old local backups..."
find "$BACKUP_DIR" -name "hrms_*.gz" -mtime +${KEEP_DAYS} -delete 2>/dev/null || true
BACKUP_COUNT=$(find "$BACKUP_DIR" -name "*.gz" | wc -l)
echo "[cleanup] Remaining local backups: ${BACKUP_COUNT} files"

echo "=== Backup COMPLETED at $(TZ=Asia/Shanghai date) ==="
echo ""
