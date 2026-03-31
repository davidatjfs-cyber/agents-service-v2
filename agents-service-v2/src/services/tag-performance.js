/**
 * 按标签聚合 agent_experience 中的 outcome score（需行上带 tags）。
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

const MIN_SAMPLES_FOR_BONUS = 3;

export { MIN_SAMPLES_FOR_BONUS };

/**
 * @param {string} tag 白名单内标签名
 * @returns {Promise<{ tag: string, avg_score: number|null, success_rate: number|null, sample_count: number }>}
 */
export async function getTagPerformance(tag) {
  const t = String(tag || '').trim();
  const empty = { tag: t, avg_score: null, success_rate: null, sample_count: 0 };
  if (!t) return empty;

  try {
    // outcome 多为 0–10；统一归一化到 0–1 再算均值与「>0.7」成功率
    const r = await query(
      `WITH tagged AS (
         SELECT
           CASE
             WHEN score IS NULL THEN NULL
             WHEN score::float > 1 THEN LEAST(1, GREATEST(0, score::float / 10.0))
             ELSE LEAST(1, GREATEST(0, score::float))
           END AS ns
         FROM agent_experience
         WHERE tags IS NOT NULL
           AND jsonb_typeof(tags) = 'array'
           AND tags @> jsonb_build_array($1::text)
       )
       SELECT
         AVG(ns)::float AS avg_score,
         (COUNT(*) FILTER (WHERE ns > 0.7))::float
           / NULLIF(COUNT(*) FILTER (WHERE ns IS NOT NULL), 0) AS success_rate,
         (COUNT(*) FILTER (WHERE ns IS NOT NULL))::int AS n
       FROM tagged`,
      [t]
    );
    const row = r.rows?.[0];
    const n = row?.n != null ? Number(row.n) : 0;
    if (!n) {
      return { tag: t, avg_score: null, success_rate: null, sample_count: 0 };
    }
    const avg = row.avg_score != null ? Number(row.avg_score) : null;
    const sr = row.success_rate != null ? Number(row.success_rate) : null;
    return {
      tag: t,
      avg_score: avg != null && Number.isFinite(avg) ? Number(avg.toFixed(4)) : null,
      success_rate: sr != null && Number.isFinite(sr) ? Number(sr.toFixed(4)) : null,
      sample_count: n
    };
  } catch (e) {
    logger.warn({ err: e?.message, tag: t }, 'getTagPerformance failed');
    return empty;
  }
}
