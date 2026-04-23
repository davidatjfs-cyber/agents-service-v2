/**
 * 与 agents-service-v2 `utils/performance-filing-counts.js` 同源 SQL，
 * 供 HRMS（如 pushScoresToFeishu）在无法 import v2 包时使用。
 */

export async function pgGetMonthlyExecutionFilingCount(pool, username, store, dateYmd) {
  const u = String(username || '').trim();
  const st = String(store || '').trim();
  const d = String(dateYmd || '').slice(0, 10);
  if (!u || !st || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return 0;
  const monthStart = d.slice(0, 7) + '-01';
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM ops_tasks
       WHERE lower(trim(assignee_username)) = lower(trim($1))
         AND trim(store) = trim($2)
         AND task_type = 'execution_rating_daily'
         AND biz_date >= $3::date
         AND biz_date <= $4::date`,
      [u, st, monthStart, d]
    );
    return Number(r.rows?.[0]?.cnt || 0);
  } catch {
    return 0;
  }
}

export async function pgGetMonthlyAttitudeFilingCount(pool, username, dateYmd) {
  const u = String(username || '').trim();
  const d = String(dateYmd || '').slice(0, 10);
  if (!u || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return 0;
  const monthStart = d.slice(0, 7) + '-01';
  const sources = ['random_inspection', 'scheduled_inspection', 'bi_anomaly', 'auto_collab', 'data_auditor'];
  try {
    const r = await pool.query(
      `SELECT COUNT(DISTINCT task_id)::int AS cnt
       FROM master_tasks
       WHERE lower(trim(coalesce(assignee_username, ''))) = lower(trim($1))
         AND source = ANY($2::text[])
         AND coalesce(hr_performance_recorded, false) = true
         AND NOT EXISTS (
           SELECT 1 FROM performance_invalidation_records pir
           WHERE pir.source_type = 'master_tasks_filing'
             AND pir.source_id = master_tasks.task_id
         )
         AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date >= $3::date
         AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date <= $4::date`,
      [u, sources, monthStart, d]
    );
    return Number(r.rows?.[0]?.cnt || 0);
  } catch {
    return 0;
  }
}
