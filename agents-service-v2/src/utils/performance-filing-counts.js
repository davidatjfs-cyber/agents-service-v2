/**
 * 绩效备案累计次数（执行力 / 工作态度）— 供日评、任务催办、月报等多处复用
 */
import { query } from './db.js';

const ATTITUDE_FILING_SOURCES = ['random_inspection', 'scheduled_inspection', 'bi_anomaly', 'auto_collab', 'data_auditor'];

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
    const r = await query(
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
      [username, ATTITUDE_FILING_SOURCES, monthStart, dateYmd]
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
    const r = await query(
      `SELECT COUNT(DISTINCT task_id)::int AS cnt
       FROM master_tasks
       WHERE lower(trim(coalesce(assignee_username, ''))) = lower(trim($1))
         AND lower(trim(coalesce(store, ''))) = lower(trim($5))
         AND source = ANY($2::text[])
         AND coalesce(hr_performance_recorded, false) = true
         AND NOT EXISTS (
           SELECT 1 FROM performance_invalidation_records pir
           WHERE pir.source_type = 'master_tasks_filing'
             AND pir.source_id = master_tasks.task_id
         )
         AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date >= $3::date
         AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date <= $4::date`,
      [username, ATTITUDE_FILING_SOURCES, monthStart, dateYmd, String(store || '').trim()]
    );
    return Number(r.rows?.[0]?.cnt || 0);
  } catch (_e) {
    return 0;
  }
}

/** 执行力备案明细（与计数同口径） */
export async function listMonthlyExecutionFilings(username, store, dateYmd, limit = 120) {
  try {
    const monthStart = String(dateYmd).slice(0, 7) + '-01';
    const lim = Math.min(300, Math.max(1, Number(limit) || 120));
    const r = await query(
      `SELECT biz_date, title, status, evidence_urls, created_at, dedupe_key
       FROM ops_tasks
       WHERE lower(trim(assignee_username)) = lower(trim($1))
         AND trim(store) = trim($2)
         AND task_type = 'execution_rating_daily'
         AND biz_date >= $3::date
         AND biz_date <= $4::date
       ORDER BY biz_date DESC NULLS LAST, created_at DESC
       LIMIT $5`,
      [username, store, monthStart, dateYmd, lim]
    );
    return (r.rows || []).map((row) => ({
      biz_date: row.biz_date ? String(row.biz_date).slice(0, 10) : null,
      title: String(row.title || ''),
      status: String(row.status || ''),
      evidence_urls: row.evidence_urls,
      created_at: row.created_at,
      dedupe_key: String(row.dedupe_key || '')
    }));
  } catch (_e) {
    return [];
  }
}

/** 工作态度备案明细（与 getMonthlyAttitudeFilingCount 同口径：本人、全门店） */
export async function listMonthlyAttitudeFilings(username, dateYmd, limit = 120) {
  try {
    const monthStart = String(dateYmd).slice(0, 7) + '-01';
    const lim = Math.min(300, Math.max(1, Number(limit) || 120));
    const r = await query(
      `SELECT task_id, title, status, source, store,
              (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date AS dispatch_date,
              dispatched_at,
              LEFT(COALESCE(detail, ''), 800) AS detail_preview
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
         AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date <= $4::date
       ORDER BY dispatched_at DESC NULLS LAST
       LIMIT $5`,
      [username, ATTITUDE_FILING_SOURCES, monthStart, dateYmd, lim]
    );
    return (r.rows || []).map((row) => ({
      task_id: String(row.task_id || ''),
      title: String(row.title || ''),
      status: String(row.status || ''),
      source: String(row.source || ''),
      store: String(row.store || ''),
      dispatch_date: row.dispatch_date ? String(row.dispatch_date).slice(0, 10) : null,
      dispatched_at: row.dispatched_at,
      detail_preview: String(row.detail_preview || '')
    }));
  } catch (_e) {
    return [];
  }
}
