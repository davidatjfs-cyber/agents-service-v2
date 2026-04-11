/**
 * 绩效备案累计次数（执行力 / 工作态度）— 供日评、任务催办、月报等多处复用
 */
import { query } from './db.js';

/** 执行力：ops_tasks 日频备案条数（按人+门店+自然月） */
export async function getMonthlyExecutionFilingCount(username, store, dateYmd) {
  try {
    const monthStart = String(dateYmd).slice(0, 7) + '-01';
    const r = await query(
      `SELECT COUNT(*)::int AS cnt
       FROM ops_tasks
       WHERE lower(trim(assignee_username)) = lower(trim($1))
         AND trim(store) = trim($2)
         AND task_type = 'execution_rating_daily'
         AND biz_date >= $3::date
         AND biz_date <= $4::date`,
      [username, store, monthStart, dateYmd]
    );
    return Number(r.rows?.[0]?.cnt || 0);
  } catch (_e) {
    return 0;
  }
}

/** 工作态度：master_tasks 已 HR 备案任务数（按人+自然月，distinct task_id） */
export async function getMonthlyAttitudeFilingCount(username, dateYmd) {
  try {
    const monthStart = String(dateYmd).slice(0, 7) + '-01';
    const sources = ['random_inspection', 'scheduled_inspection', 'bi_anomaly', 'auto_collab', 'data_auditor'];
    const r = await query(
      `SELECT COUNT(DISTINCT task_id)::int AS cnt
       FROM master_tasks
       WHERE lower(trim(coalesce(assignee_username, ''))) = lower(trim($1))
         AND source = ANY($2::text[])
         AND coalesce(hr_performance_recorded, false) = true
         AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date >= $3::date
         AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date <= $4::date`,
      [username, sources, monthStart, dateYmd]
    );
    return Number(r.rows?.[0]?.cnt || 0);
  } catch (_e) {
    return 0;
  }
}

/**
 * 同上，但仅统计指定门店（卡片上常只展示一家店，需与「全门店合计」区分以免误解）
 */
export async function getMonthlyAttitudeFilingCountForStore(username, store, dateYmd) {
  try {
    const monthStart = String(dateYmd).slice(0, 7) + '-01';
    const sources = ['random_inspection', 'scheduled_inspection', 'bi_anomaly', 'auto_collab', 'data_auditor'];
    const r = await query(
      `SELECT COUNT(DISTINCT task_id)::int AS cnt
       FROM master_tasks
       WHERE lower(trim(coalesce(assignee_username, ''))) = lower(trim($1))
         AND lower(trim(coalesce(store, ''))) = lower(trim($5))
         AND source = ANY($2::text[])
         AND coalesce(hr_performance_recorded, false) = true
         AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date >= $3::date
         AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date <= $4::date`,
      [username, sources, monthStart, dateYmd, String(store || '').trim()]
    );
    return Number(r.rows?.[0]?.cnt || 0);
  } catch (_e) {
    return 0;
  }
}
