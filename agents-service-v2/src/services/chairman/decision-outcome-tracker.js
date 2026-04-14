/**
 * 决策效果追踪器 — 任务完成后自动对比前后数据变化
 *
 * 纯规则打分，不依赖LLM：
 * - 方向对了: +1
 * - 达到目标: +1
 * - 异常消失: +1
 * 总分 0-3 → 无效/部分有效/有效/高效
 */
import { query } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveAgentCanonicalStore, expandAgentStoreLabels } from '../../config/store-mapping.js';

const METRIC_EXTRACTORS = {
  revenue: {
    label: '营收',
    sql: (storePats, start, end) => [
      `SELECT COALESCE(SUM(actual_revenue), 0) AS val FROM daily_reports WHERE store ILIKE ANY($1::text[]) AND date >= $2::date AND date <= $3::date`,
      [storePats, start, end]
    ],
    higher: true,
  },
  traffic: {
    label: '客流',
    sql: (storePats, start, end) => [
      `SELECT COALESCE(SUM(dine_traffic), 0) AS val FROM daily_reports WHERE store ILIKE ANY($1::text[]) AND date >= $2::date AND date <= $3::date`,
      [storePats, start, end]
    ],
    higher: true,
  },
  orders: {
    label: '订单',
    sql: (storePats, start, end) => [
      `SELECT COALESCE(SUM(dine_orders), 0) AS val FROM daily_reports WHERE store ILIKE ANY($1::text[]) AND date >= $2::date AND date <= $3::date`,
      [storePats, start, end]
    ],
    higher: true,
  },
  efficiency: {
    label: '人效',
    sql: (storePats, start, end) => [
      `SELECT COALESCE(AVG(efficiency), 0) AS val FROM daily_reports WHERE store ILIKE ANY($1::text[]) AND date >= $2::date AND date <= $3::date`,
      [storePats, start, end]
    ],
    higher: true,
  },
  margin: {
    label: '毛利率',
    sql: (storePats, start, end) => [
      `SELECT COALESCE(AVG(actual_margin), 0) AS val FROM daily_reports WHERE store ILIKE ANY($1::text[]) AND date >= $2::date AND date <= $3::date`,
      [storePats, start, end]
    ],
    higher: true,
  },
};

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

function shanghaiToday() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

function storePats(store) {
  const labels = expandAgentStoreLabels(store);
  return labels.map(l => `%${l.replace(/%/g, '')}%`);
}

async function getMetricValue(metricKey, store, start, end) {
  const ext = METRIC_EXTRACTORS[metricKey];
  if (!ext) return null;
  const [sql, baseParams] = ext.sql(storePats(store), start, end);
  try {
    const r = await query(sql, baseParams);
    const val = Number(r.rows?.[0]?.val ?? 0);
    const days = Math.max(1, Math.round((new Date(end) - new Date(start)) / 86400000) + 1);
    return { total: val, daily: val / days, days };
  } catch (e) {
    logger.warn({ err: e?.message, metricKey }, 'outcome metric query failed');
    return null;
  }
}

function inferMetricFocus(task) {
  const t = String(task.title || '') + String(task.detail || '') + String(task.source_data ? JSON.stringify(task.source_data) : '');
  const tl = t.toLowerCase();
  if (/营收|revenue|营业额/.test(tl)) return 'revenue';
  if (/客流|traffic|到店/.test(tl)) return 'traffic';
  if (/订单|order|桌数/.test(tl)) return 'orders';
  if (/人效|效率|efficiency/.test(tl)) return 'efficiency';
  if (/毛利|margin|成本/.test(tl)) return 'margin';
  return 'revenue';
}

async function checkAnomalyResolved(store, anomalyKey, afterDate) {
  try {
    const r = await query(
      `SELECT 1 FROM anomaly_triggers WHERE store ILIKE ANY($1::text[]) AND anomaly_key = $2 AND trigger_date >= $3::date LIMIT 1`,
      [storePats(store), anomalyKey, afterDate]
    );
    return r.rows?.length === 0;
  } catch {
    return false;
  }
}

function getTaskAnomalyKey(task) {
  const sd = task.source_data || {};
  return sd.anomaly_key || sd.rule_key || sd.rule || null;
}

/**
 * 评估单个任务的执行效果
 */
export async function evaluateTaskOutcome(taskId) {
  const r = await query(
    `SELECT task_id, store, title, detail, source, source_data, status,
            dispatched_at, resolved_at, closed_at, created_at
     FROM master_tasks WHERE task_id = $1`,
    [taskId]
  );
  const task = r.rows?.[0];
  if (!task) return { ok: false, error: 'task_not_found' };

  if (!task.store) return { ok: false, error: 'no_store' };

  const resolvedAt = task.resolved_at || task.closed_at || task.updated_at;
  if (!resolvedAt) return { ok: false, error: 'not_resolved' };

  const taskStart = addDays(String((task.dispatched_at || task.created_at)).slice(0, 10), 0);
  const taskEnd = String(resolvedAt).slice(0, 10);

  const beforeStart = addDays(taskStart, -7);
  const beforeEnd = addDays(taskStart, -1);
  const afterStart = taskStart;
  const afterEnd = addDays(taskEnd, 3);
  const today = shanghaiToday();
  const finalAfterEnd = afterEnd > today ? today : afterEnd;

  if (finalAfterEnd <= afterStart) {
    return { ok: false, error: 'too_early', message: '任务完成后不足3天，暂无法评估' };
  }

  const metricKey = inferMetricFocus(task);
  const before = await getMetricValue(metricKey, task.store, beforeStart, beforeEnd);
  const after = await getMetricValue(metricKey, task.store, afterStart, finalAfterEnd);

  if (!before || !after || before.daily <= 0) {
    return { ok: false, error: 'no_data', metricKey };
  }

  const changePct = (after.daily - before.daily) / before.daily;
  const extractor = METRIC_EXTRACTORS[metricKey];
  const directionGood = extractor.higher ? changePct > 0 : changePct < 0;

  let score = 0;
  const reasons = [];

  if (directionGood) {
    score += 1;
    reasons.push(`方向正确: ${extractor.label}${changePct > 0 ? '+' : ''}${(changePct * 100).toFixed(1)}%`);
  } else {
    reasons.push(`方向未改善: ${extractor.label}${(changePct * 100).toFixed(1)}%`);
  }

  const targetChange = 0.05;
  if (directionGood && Math.abs(changePct) >= targetChange) {
    score += 1;
    reasons.push(`达到效果阈值: ${extractor.label}变化${(changePct * 100).toFixed(1)}%`);
  }

  const anomalyKey = getTaskAnomalyKey(task);
  if (anomalyKey) {
    const resolved = await checkAnomalyResolved(task.store, anomalyKey, afterStart);
    if (resolved) {
      score += 1;
      reasons.push(`异常已消失: ${anomalyKey}`);
    }
  }

  const scoreLabel = score === 0 ? '无效' : score === 1 ? '部分有效' : score === 2 ? '有效' : '高效';

  const outcome = {
    task_id: taskId,
    store: task.store,
    metric: metricKey,
    metric_label: extractor.label,
    before_daily: Math.round(before.daily),
    after_daily: Math.round(after.daily),
    change_pct: +(changePct * 100).toFixed(1),
    score,
    score_label: scoreLabel,
    reasons,
    window: { before: [beforeStart, beforeEnd], after: [afterStart, finalAfterEnd] },
  };

  try {
    await query(
      `UPDATE master_tasks SET
         source_data = COALESCE(source_data, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
       WHERE task_id = $1`,
      [taskId, JSON.stringify({ outcome_evaluation: outcome })]
    );
  } catch (e) {
    logger.warn({ err: e?.message, taskId }, 'outcome save to task failed');
  }

  return { ok: true, outcome };
}

/**
 * 批量评估：找出所有已关闭但未评估的任务
 */
export async function evaluateAllPendingOutcomes() {
  const r = await query(
    `SELECT task_id FROM master_tasks
     WHERE status IN ('closed', 'settled', 'resolved')
       AND dispatched_at IS NOT NULL
       AND (resolved_at IS NOT NULL OR closed_at IS NOT NULL)
       AND (source_data->>'outcome_evaluation') IS NULL
       AND (source_data->>'outcome_evaluation_pending') IS NULL
       AND resolved_at <= NOW() - INTERVAL '3 days'
       AND resolved_at >= NOW() - INTERVAL '30 days'
     ORDER BY resolved_at DESC
     LIMIT 50`
  );

  const results = [];
  for (const row of (r.rows || [])) {
    try {
      const res = await evaluateTaskOutcome(row.task_id);
      results.push(res);
    } catch (e) {
      logger.warn({ err: e?.message, taskId: row.task_id }, 'batch outcome eval failed');
    }
  }

  logger.info({ total: results.length, ok: results.filter(r => r.ok).length }, 'outcome evaluation batch done');
  return results;
}
