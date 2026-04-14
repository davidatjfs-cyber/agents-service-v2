-- 将已通过且尚未双写到 hrms_leave_records 的休假审批补入独立表（幂等）
-- 原因：历史双写失败、表后建、或 start/end 为空导致 INSERT 失败等

INSERT INTO hrms_leave_records (
  id, username, name, store, brand, start_date, end_date, days, type, reason, status,
  approval_id, approved_by, approved_at, submitted_by
)
SELECT
  gen_random_uuid(),
  trim(ar.applicant_username),
  left(coalesce(nullif(trim(ar.payload->>'applicantName'), ''), trim(ar.applicant_username)), 200),
  left(coalesce(nullif(trim(ar.payload->>'store'), ''), ''), 200),
  left(coalesce(nullif(trim(ar.payload->>'brand'), ''), ''), 120),
  (nullif(trim(ar.payload->>'startDate'), ''))::date,
  coalesce(
    nullif(trim(ar.payload->>'endDate'), '')::date,
    (nullif(trim(ar.payload->>'startDate'), ''))::date
  ),
  coalesce(nullif(trim(ar.payload->>'days'), '')::numeric, 0),
  left(coalesce(nullif(trim(ar.payload->>'type'), ''), 'leave'), 30),
  coalesce(ar.payload->>'reason', ''),
  'approved',
  ar.id,
  'backfill',
  coalesce(ar.updated_at, ar.created_at, current_timestamp),
  trim(ar.applicant_username)
FROM approval_requests ar
WHERE ar.type = 'leave'
  AND ar.status = 'approved'
  AND trim(coalesce(ar.applicant_username, '')) <> ''
  AND (ar.payload->>'startDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  AND NOT EXISTS (SELECT 1 FROM hrms_leave_records h WHERE h.approval_id = ar.id);
