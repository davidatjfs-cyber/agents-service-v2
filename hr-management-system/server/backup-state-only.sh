#!/bin/bash
# 每日仅导出 hrms_state / 积分 JSONL / 薪资切片（大表全量改由 PITR + 周备）
set -uo pipefail

if [[ -f /opt/pg_pitr/scripts/pg-pitr-common.sh ]]; then
  # shellcheck disable=SC1091
  source /opt/pg_pitr/scripts/pg-pitr-common.sh
  pg_pitr_register_exit_alert "backup-state-only"
fi

BACKUP_DIR="/opt/hrms/backups"
LOG_FILE="/var/log/hrms-backup-state.log"
KEEP_DAYS="${HRMS_STATE_BACKUP_KEEP_DAYS:-14}"
DATE=$(TZ="Asia/Shanghai" date +%Y%m%d_%H%M%S)
STATE_SNAPSHOT="${BACKUP_DIR}/hrms_state_${DATE}.json.gz"
POINT_RECORDS_JSONL="${BACKUP_DIR}/hrms_pointRecords_${DATE}.jsonl.gz"
PAYROLL_STATE_JSON="${BACKUP_DIR}/hrms_payroll_state_${DATE}.json.gz"

mkdir -p "$BACKUP_DIR"
exec >>"$LOG_FILE" 2>&1
echo "=== HRMS state-only backup at $(TZ=Asia/Shanghai date) ==="

if [[ -f /opt/hrms/server/.env ]]; then
  set -a
  # shellcheck disable=SC1090
  source <(grep -E '^DATABASE_URL=' /opt/hrms/server/.env | head -1)
  set +a
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL not set. Aborting."
  exit 1
fi

echo "[1/4] hrms_state JSON snapshot → ${STATE_SNAPSHOT}"
if ! psql "$DATABASE_URL" -t -A -c "SELECT data FROM hrms_state WHERE key='default' LIMIT 1" 2>/dev/null | gzip >"$STATE_SNAPSHOT"; then
  echo "ERROR: hrms_state snapshot psql failed"
  exit 1
fi
if [[ ! -s "$STATE_SNAPSHOT" ]]; then
  echo "ERROR: hrms_state snapshot empty"
  exit 1
fi
echo "  State snapshot: $(du -sh "$STATE_SNAPSHOT" 2>/dev/null | cut -f1)"

echo "[2/4] pointRecords JSONL → ${POINT_RECORDS_JSONL}"
psql "$DATABASE_URL" -t -A -c \
  "SELECT elem::text FROM hrms_state, LATERAL jsonb_array_elements(COALESCE(data->'pointRecords','[]'::jsonb)) AS elem WHERE key='default'" \
  2>/dev/null | gzip >"${POINT_RECORDS_JSONL}.tmp" && mv "${POINT_RECORDS_JSONL}.tmp" "$POINT_RECORDS_JSONL" || true
if [[ ! -s "$POINT_RECORDS_JSONL" ]]; then
  echo "  WARN: pointRecords JSONL empty or export failed"
else
  echo "  pointRecords JSONL: $(du -sh "$POINT_RECORDS_JSONL" 2>/dev/null | cut -f1)"
fi

echo "[3/4] payroll-related state slice → ${PAYROLL_STATE_JSON}"
psql "$DATABASE_URL" -t -A -c \
  "SELECT jsonb_strip_nulls(jsonb_build_object(
     'payrollAdjustments', data->'payrollAdjustments',
     'payrollAudits', data->'payrollAudits',
     'salaryAdjustments', data->'salaryAdjustments',
     'monthlyConfirmations', data->'monthlyConfirmations'
   ))::text FROM hrms_state WHERE key='default' LIMIT 1" \
  2>/dev/null | gzip >"${PAYROLL_STATE_JSON}.tmp" && mv "${PAYROLL_STATE_JSON}.tmp" "$PAYROLL_STATE_JSON" || true

echo "[4/4] Verification counts..."
PR_COUNT=$(psql "$DATABASE_URL" -t -A -c "SELECT jsonb_array_length(COALESCE(data->'pointRecords','[]'::jsonb)) FROM hrms_state WHERE key='default'" 2>/dev/null || echo "?")
echo "  pointRecords in state: ${PR_COUNT}"

echo "[cleanup] state-only gz older than ${KEEP_DAYS}d"
find "$BACKUP_DIR" \( -name 'hrms_state_*.json.gz' -o -name 'hrms_pointRecords_*.jsonl.gz' -o -name 'hrms_payroll_state_*.json.gz' \) -mtime +"${KEEP_DAYS}" -delete 2>/dev/null || true
echo "=== state-only COMPLETED at $(TZ=Asia/Shanghai date) ==="
echo ""
