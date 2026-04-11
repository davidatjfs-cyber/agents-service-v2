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

/**
 * 工作态度备案累计（**仅统计传入的 assignee_username 本人**，不含他人、不含执行力备案）。
 * - 表：master_tasks
 * - 条件：该行的 assignee_username（trim+lower 匹配）= 传入账号；source ∈ 定时巡检/抽检/BI/协作/数据审计；
 *   hr_performance_recorded=true；任务派发日（上海日历）落在 [当月1日, dateYmd]
 * - 计数：COUNT(DISTINCT task_id) → **不同任务各计 1 次**，同一任务不会重复累加
 */
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
 * 同上，但在「本人」前提下 **再加门店筛选**（trim+lower 精确匹配 store 字符串）。
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
