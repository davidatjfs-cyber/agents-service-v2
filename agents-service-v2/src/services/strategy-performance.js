/**
 * 按 strategy 三元组（scenario + root_cause + action）聚合 agent_experience 表现。
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

/** action 历史加减分至少需要的有分样本数 */
export const MIN_SAMPLES_ACTION_BONUS = 5;

function expandScenarioKeys(scenario) {
  const s = String(scenario || '').trim();
  if (!s) return [];
  const out = new Set([s]);
  if (s === 'bad_reviews_increase') out.add('bad_reviews');
  if (s === 'bad_reviews') out.add('bad_reviews_increase');
  return [...out];
}

/**
 * @param {{ success_rate: number|null, sample_count: number }} perf
 * @param {number} [minN]
 * @returns {number} ∈ [-0.3, +0.2]，样本不足时为 0
 */
export function computeActionBonusFromPerformance(perf, minN = MIN_SAMPLES_ACTION_BONUS) {
  const n = Number(perf?.sample_count) || 0;
  const sr = perf?.success_rate != null && Number.isFinite(Number(perf.success_rate)) ? Number(perf.success_rate) : null;
  if (n < minN || sr == null) return 0;
  let raw = 0;
  if (sr >= 0.7) {
    raw = (sr - 0.7) * 0.8;
  } else if (sr <= 0.4) {
    raw = -(0.4 - sr) * 0.8;
  } else {
    raw = 0;
  }
  return Number(Math.max(-0.3, Math.min(0.2, raw)).toFixed(4));
}

/**
 * @param {string|null|undefined} scenario
 * @param {string|null|undefined} root_cause
 * @param {string|null|undefined} action
 * @returns {Promise<{ avg_score: number|null, success_rate: number|null, sample_count: number }>}
 */
export async function getStrategyPerformance(scenario, root_cause, action) {
  const keys = expandScenarioKeys(scenario);
  const act = String(action || '').trim();
  const empty = { avg_score: null, success_rate: null, sample_count: 0 };
  if (!keys.length || !act) return empty;

  const rc = root_cause != null ? String(root_cause) : null;

  try {
    const r = await query(
      `WITH matched AS (
         SELECT
           CASE
             WHEN score IS NULL THEN NULL
             WHEN score::float > 1 THEN LEAST(1, GREATEST(0, score::float / 10.0))
             ELSE LEAST(1, GREATEST(0, score::float))
           END AS ns
         FROM agent_experience
         WHERE scenario = ANY($1::text[])
           AND root_cause IS NOT DISTINCT FROM $2
           AND action = $3
       )
       SELECT
         AVG(ns)::float AS avg_score,
         (COUNT(*) FILTER (WHERE ns > 0.7))::float
           / NULLIF(COUNT(*) FILTER (WHERE ns IS NOT NULL), 0) AS success_rate,
         (COUNT(*) FILTER (WHERE ns IS NOT NULL))::int AS sample_count
       FROM matched`,
      [keys, rc, act]
    );
    const row = r.rows?.[0];
    const n = row?.sample_count != null ? Number(row.sample_count) : 0;
    if (!n) return empty;
    const avg = row.avg_score != null ? Number(row.avg_score) : null;
    const sr = row.success_rate != null ? Number(row.success_rate) : null;
    return {
      avg_score: avg != null && Number.isFinite(avg) ? Number(avg.toFixed(4)) : null,
      success_rate: sr != null && Number.isFinite(sr) ? Number(sr.toFixed(4)) : null,
      sample_count: n
    };
  } catch (e) {
    logger.warn({ err: e?.message, scenario: keys[0], root_cause: rc }, 'getStrategyPerformance failed');
    return empty;
  }
}
