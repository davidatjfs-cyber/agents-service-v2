/**
 * Proactive LLM 任务闭环后：用 daily_reports 对比执行前后，计算 improvement → outcome_score → saveProactiveActionOutcome
 */

import { query } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { saveProactiveActionOutcome } from '../agent-memory.js';

const TERMINAL_STATUSES = new Set(['closed', 'resolved', 'settled', 'completed']);

function shYmd(ts) {
  if (!ts) return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

/** 纯日历 YYYY-MM-DD + n 天（按 UTC 日历日计算，避免本地时区扭曲） */
function addCalendarDays(ymdStr, n) {
  const [y, m, d] = String(ymdStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function minYmd(a, b) {
  return a <= b ? a : b;
}

function parseSourceData(row) {
  const raw = row?.source_data;
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return {};
  }
}

async function aggregateWindow(storeLike, startYmd, endYmd) {
  const r = await query(
    `SELECT
       COALESCE(SUM(actual_revenue), 0)::numeric AS rev,
       COALESCE(SUM(dine_traffic), 0)::numeric AS traffic,
       COALESCE(SUM(bad_reviews_dianping), 0)::numeric AS bad_n,
       COALESCE(SUM(dine_orders), 0)::numeric AS ord_n,
       COUNT(*)::int AS day_cnt
     FROM daily_reports
     WHERE store ILIKE $1 AND date >= $2::date AND date <= $3::date`,
    [storeLike, startYmd, endYmd]
  );
  return (
    r.rows?.[0] || {
      rev: 0,
      traffic: 0,
      bad_n: 0,
      ord_n: 0,
      day_cnt: 0
    }
  );
}

function safeDiv(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return null;
  return x / y;
}

function rateBadReview(agg) {
  return safeDiv(agg.bad_n, agg.ord_n);
}

/** improvement：营收/客流为 (after-before)/before；差评率为 (before-after)/before（降低为好） */
function improvementRevenueOrTraffic(beforeAgg, afterAgg, key) {
  const b = Number(beforeAgg[key] || 0);
  const a = Number(afterAgg[key] || 0);
  const db = Math.max(1, Number(beforeAgg.day_cnt || 0));
  const da = Math.max(1, Number(afterAgg.day_cnt || 0));
  const bAvg = b / db;
  const aAvg = a / da;
  if (bAvg <= 0) return null;
  return (aAvg - bAvg) / bAvg;
}

function improvementBadRate(beforeAgg, afterAgg) {
  const br = rateBadReview(beforeAgg);
  const ar = rateBadReview(afterAgg);
  if (br == null || br <= 0) {
    if ((ar || 0) > 0) return -0.5;
    return null;
  }
  return (br - (ar || 0)) / br;
}

function combineImprovement(metricFocus, impRev, impTr, impBad) {
  const focus = String(metricFocus || 'mixed').toLowerCase();
  let num = 0;
  let den = 0;
  const push = (w, v) => {
    if (v == null || !Number.isFinite(v)) return;
    num += w * v;
    den += w;
  };
  if (focus === 'revenue') {
    push(1, impRev);
    push(0.35, impTr);
    push(0.35, impBad);
  } else if (focus === 'traffic') {
    push(1, impTr);
    push(0.35, impRev);
    push(0.35, impBad);
  } else if (focus === 'conversion') {
    push(1, impBad);
    push(0.35, impRev);
    push(0.35, impTr);
  } else {
    push(1, impRev);
    push(1, impTr);
    push(1, impBad);
  }
  if (den <= 0) return null;
  return num / den;
}

/** improvement 为小数，如 0.15 = 15% */
function improvementToOutcomeScore(improvement) {
  const pct = improvement * 100;
  if (pct > 20) return 9.5;
  if (pct >= 10) return 7.5;
  if (pct >= 0) return 5.5;
  if (pct >= -10) return 3.5;
  return 2;
}

/**
 * @param {string} taskId
 * @param {{ newStatus?: string }} [opts]
 */
export async function recordProactiveOutcomeOnTaskClose(taskId, opts = {}) {
  const tid = String(taskId || '').trim();
  if (!tid) return { ok: false, skip: 'no_task_id' };

  const status = String(opts.newStatus || '').toLowerCase();
  if (status && !TERMINAL_STATUSES.has(status)) {
    return { ok: false, skip: 'not_terminal' };
  }

  try {
    const claim = await query(
      `UPDATE master_tasks SET
         source_data = COALESCE(source_data, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
       WHERE task_id = $1
         AND source = 'proactive_llm'
         AND status IN ('closed', 'resolved', 'settled', 'completed')
         AND (source_data->>'proactive_outcome_recorded_at') IS NULL
         AND (source_data->>'proactive_outcome_processing') IS NULL
       RETURNING task_id, store, source, source_data, title, dispatched_at, created_at, closed_at, resolved_at, updated_at, status`,
      [tid, JSON.stringify({ proactive_outcome_processing: true })]
    );
    const row = claim.rows?.[0];
    if (!row) {
      return { ok: false, skip: 'not_claimable' };
    }

    const sd = parseSourceData(row);
    const action = String(sd.original_line || '').trim() || String(row.title || '').trim();
    const store = String(row.store || '').trim();
    if (!store || !action) {
      await query(`UPDATE master_tasks SET source_data = COALESCE(source_data,'{}'::jsonb) || $2::jsonb WHERE task_id = $1`, [
        tid,
        JSON.stringify({ proactive_outcome_processing: false })
      ]).catch(() => {});
      return { ok: false, skip: 'missing_store_or_action' };
    }

    const tEnd = row.closed_at || row.resolved_at || row.updated_at || new Date();
    const tStart = row.dispatched_at || row.created_at;
    const d0 = shYmd(tStart);
    const dClose = shYmd(tEnd);
    if (!d0 || !dClose) {
      await query(`UPDATE master_tasks SET source_data = COALESCE(source_data,'{}'::jsonb) || $2::jsonb WHERE task_id = $1`, [
        tid,
        JSON.stringify({ proactive_outcome_processing: false })
      ]).catch(() => {});
      return { ok: false, skip: 'bad_dates' };
    }

    const beforeStart = addCalendarDays(d0, -7);
    const beforeEnd = addCalendarDays(d0, -1);
    const afterStart = d0;
    let afterEnd = minYmd(dClose, addCalendarDays(d0, 13));
    if (afterEnd < afterStart) afterEnd = afterStart;

    const storeLike = `%${store}%`;
    const beforeAgg = await aggregateWindow(storeLike, beforeStart, beforeEnd);
    const afterAgg = await aggregateWindow(storeLike, afterStart, afterEnd);

    const impRev = improvementRevenueOrTraffic(beforeAgg, afterAgg, 'rev');
    const impTr = improvementRevenueOrTraffic(beforeAgg, afterAgg, 'traffic');
    const impBad = improvementBadRate(beforeAgg, afterAgg);

    const improvement = combineImprovement(sd.metric_focus, impRev, impTr, impBad);
    let outcomeScore = 5;
    let outcomeNote = 'insufficient_data';
    if (improvement != null && Number.isFinite(improvement)) {
      outcomeScore = improvementToOutcomeScore(improvement);
      outcomeNote = `improvement_weighted=${(improvement * 100).toFixed(2)}%`;
    }

    await saveProactiveActionOutcome({
      action,
      outcome_score: outcomeScore,
      store,
      outcome: outcomeNote,
      options: {
        tags: [
          'proactive_llm',
          'outcome_on_close',
          `task_id:${tid}`,
          `metric:${String(sd.metric_focus || 'mixed')}`,
          `before:${beforeStart}_${beforeEnd}`,
          `after:${afterStart}_${afterEnd}`
        ]
      }
    });

    const patch = {
      proactive_outcome_processing: false,
      proactive_outcome_recorded_at: new Date().toISOString(),
      proactive_outcome_improvement: improvement,
      proactive_outcome_score: outcomeScore,
      proactive_outcome_windows: { before: [beforeStart, beforeEnd], after: [afterStart, afterEnd] }
    };

    await query(`UPDATE master_tasks SET source_data = COALESCE(source_data, '{}'::jsonb) || $2::jsonb WHERE task_id = $1`, [
      tid,
      JSON.stringify(patch)
    ]).catch((e) => logger.warn({ err: e?.message, tid }, 'proactive outcome: source_data patch failed'));

    logger.info(
      { taskId: tid, store, outcomeScore, improvement, metric_focus: sd.metric_focus },
      'proactive_llm: outcome recorded on task close'
    );

    return { ok: true, outcomeScore, improvement };
  } catch (e) {
    await query(`UPDATE master_tasks SET source_data = COALESCE(source_data,'{}'::jsonb) || $2::jsonb WHERE task_id = $1`, [
      tid,
      JSON.stringify({ proactive_outcome_processing: false })
    ]).catch(() => {});
    logger.warn({ err: e?.message, taskId: tid }, 'recordProactiveOutcomeOnTaskClose failed');
    return { ok: false, error: e?.message };
  }
}

export function scheduleProactiveOutcomeOnClose(taskId, opts = {}) {
  const tid = String(taskId || '').trim();
  if (!tid) return;
  setImmediate(() => {
    recordProactiveOutcomeOnTaskClose(tid, opts).catch(() => {});
  });
}

export { TERMINAL_STATUSES };
