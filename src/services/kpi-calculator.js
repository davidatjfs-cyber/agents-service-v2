/**
 * KPI Calculator — 每日计算KPI指标写入kpi_snapshots
 * 
 * KPI-A: TTFR P90, TTC P90, 超时率
 * KPI-B: 误报率, 证据链完整率
 * KPI-C: 一次通过率, 平均提醒次数, 升级率+升级解决率
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';

/**
 * 计算某门店某日的KPI快照
 */
export async function calculateDailyKPI(store, date = 'yesterday') {
  const dateFilter = date === 'yesterday' ? 'CURRENT_DATE - 1' : `'${date}'::date`;

  try {
    // ── KPI-A: 闭环效率 ──

    // TTFR P90 (首次响应时长，分钟)
    const ttfrR = await query(`
      SELECT PERCENTILE_CONT(0.9) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (COALESCE(first_response_at, dispatched_at) - created_at)) / 60
      ) AS p90
      FROM master_tasks
      WHERE store = $1 AND created_at::date = ${dateFilter}
        AND (first_response_at IS NOT NULL OR dispatched_at IS NOT NULL)
    `, [store]);

    // TTC P90 (闭环时长，小时)
    const ttcR = await query(`
      SELECT PERCENTILE_CONT(0.9) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (closed_at - created_at)) / 3600
      ) AS p90
      FROM master_tasks
      WHERE store = $1 AND closed_at::date = ${dateFilter}
    `, [store]);

    // 超时率
    const timeoutR = await query(`
      SELECT
        COUNT(*) FILTER (WHERE timeout_at < now() AND status NOT IN ('closed','settled')) AS overdue,
        COUNT(*) AS total
      FROM master_tasks
      WHERE store = $1 AND created_at::date >= ${dateFilter} - 7
    `, [store]);
    const overdue = parseInt(timeoutR.rows[0]?.overdue || 0);
    const total = parseInt(timeoutR.rows[0]?.total || 0);
    const timeoutRate = total ? (overdue / total * 100) : 0;

    // ── KPI-B: 管理质量 ──

    // 误报率 (resolution_code = 'false_positive')
    const fpR = await query(`
      SELECT
        COUNT(*) FILTER (WHERE resolution_code = 'false_positive') AS fp,
        COUNT(*) FILTER (WHERE resolution_code IS NOT NULL) AS resolved
      FROM master_tasks
      WHERE store = $1 AND resolved_at::date >= ${dateFilter} - 30
    `, [store]);
    const fpCount = parseInt(fpR.rows[0]?.fp || 0);
    const resolvedCount = parseInt(fpR.rows[0]?.resolved || 0);
    const fpRate = resolvedCount ? (fpCount / resolvedCount * 100) : 0;

    // 证据链完整率
    const evidenceR = await query(`
      SELECT
        COUNT(*) FILTER (WHERE evidence_refs IS NOT NULL AND evidence_refs != '[]'::jsonb) AS with_evidence,
        COUNT(*) AS total
      FROM master_tasks
      WHERE store = $1 AND created_at::date >= ${dateFilter} - 30
        AND status IN ('closed', 'settled')
    `, [store]);
    const withEvidence = parseInt(evidenceR.rows[0]?.with_evidence || 0);
    const evidenceTotal = parseInt(evidenceR.rows[0]?.total || 0);
    const evidenceCoverage = evidenceTotal ? (withEvidence / evidenceTotal * 100) : 0;

    // ── KPI-C: 管理动作 ──

    // 一次通过率
    const passR = await query(`
      SELECT
        COUNT(*) FILTER (WHERE (review_result->>'pass')::boolean = true AND remind_count <= 1) AS first_pass,
        COUNT(*) FILTER (WHERE review_result IS NOT NULL) AS reviewed
      FROM master_tasks
      WHERE store = $1 AND resolved_at::date >= ${dateFilter} - 30
    `, [store]);
    const firstPass = parseInt(passR.rows[0]?.first_pass || 0);
    const reviewed = parseInt(passR.rows[0]?.reviewed || 0);
    const firstPassRate = reviewed ? (firstPass / reviewed * 100) : 0;

    // 平均提醒次数
    const remindR = await query(`
      SELECT AVG(remind_count) AS avg_remind
      FROM master_tasks
      WHERE store = $1 AND created_at::date >= ${dateFilter} - 30 AND remind_count > 0
    `, [store]);
    const avgRemind = parseFloat(remindR.rows[0]?.avg_remind || 0);

    // 升级率 + 升级解决率
    const escR = await query(`
      SELECT
        COUNT(*) FILTER (WHERE escalation_level > 0) AS escalated,
        COUNT(*) FILTER (WHERE escalation_level > 0 AND status IN ('closed','settled')) AS esc_resolved,
        COUNT(*) AS total
      FROM master_tasks
      WHERE store = $1 AND created_at::date >= ${dateFilter} - 30
    `, [store]);
    const escalated = parseInt(escR.rows[0]?.escalated || 0);
    const escTotal = parseInt(escR.rows[0]?.total || 0);
    const escResolved = parseInt(escR.rows[0]?.esc_resolved || 0);
    const escalationRate = escTotal ? (escalated / escTotal * 100) : 0;
    const escResolveRate = escalated ? (escResolved / escalated * 100) : 0;

    // 任务计数
    const countsR = await query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status IN ('closed','settled')) AS closed,
        COUNT(*) FILTER (WHERE timeout_at < now() AND status NOT IN ('closed','settled')) AS overdue
      FROM master_tasks
      WHERE store = $1 AND created_at::date >= ${dateFilter} - 7
    `, [store]);

    // ── 写入 kpi_snapshots ──
    const snapshotDate = date === 'yesterday'
      ? new Date(Date.now() - 86400000).toISOString().slice(0, 10)
      : date;

    await query(`
      INSERT INTO kpi_snapshots (
        snapshot_date, store, brand,
        ttfr_p90_minutes, ttc_p90_hours, timeout_rate,
        false_positive_rate, evidence_coverage_rate,
        first_pass_rate, avg_remind_count, escalation_rate, escalation_resolve_rate,
        total_tasks, closed_tasks, overdue_tasks
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (snapshot_date, store) DO UPDATE SET
        ttfr_p90_minutes = EXCLUDED.ttfr_p90_minutes,
        ttc_p90_hours = EXCLUDED.ttc_p90_hours,
        timeout_rate = EXCLUDED.timeout_rate,
        false_positive_rate = EXCLUDED.false_positive_rate,
        evidence_coverage_rate = EXCLUDED.evidence_coverage_rate,
        first_pass_rate = EXCLUDED.first_pass_rate,
        avg_remind_count = EXCLUDED.avg_remind_count,
        escalation_rate = EXCLUDED.escalation_rate,
        escalation_resolve_rate = EXCLUDED.escalation_resolve_rate,
        total_tasks = EXCLUDED.total_tasks,
        closed_tasks = EXCLUDED.closed_tasks,
        overdue_tasks = EXCLUDED.overdue_tasks
    `, [
      snapshotDate, store, getBrandForStore(store),
      parseFloat(ttfrR.rows[0]?.p90 || 0).toFixed(1),
      parseFloat(ttcR.rows[0]?.p90 || 0).toFixed(1),
      timeoutRate.toFixed(2),
      fpRate.toFixed(2),
      evidenceCoverage.toFixed(2),
      firstPassRate.toFixed(2),
      avgRemind.toFixed(2),
      escalationRate.toFixed(2),
      escResolveRate.toFixed(2),
      parseInt(countsR.rows[0]?.total || 0),
      parseInt(countsR.rows[0]?.closed || 0),
      parseInt(countsR.rows[0]?.overdue || 0)
    ]);

    logger.info({ store, date: snapshotDate, timeoutRate: timeoutRate.toFixed(1), evidenceCoverage: evidenceCoverage.toFixed(1) }, 'KPI snapshot saved');
    return { store, date: snapshotDate, timeoutRate, evidenceCoverage, firstPassRate, escalationRate };
  } catch (err) {
    logger.error({ err, store }, 'KPI calculation failed');
    throw err;
  }
}

function getBrandForStore(store) {
  if (/洪潮/.test(store)) return '洪潮';
  if (/马己仙/.test(store)) return '马己仙';
  return null;
}

/**
 * 计算所有活跃门店的KPI快照
 */
export async function calculateAllStoresKPI(date = 'yesterday') {
  const storesR = await query(
    `SELECT DISTINCT store FROM daily_reports WHERE date >= CURRENT_DATE - 30 AND store IS NOT NULL`
  );
  const results = [];
  for (const row of storesR.rows) {
    try {
      const r = await calculateDailyKPI(row.store, date);
      results.push(r);
    } catch (e) {
      results.push({ store: row.store, error: e.message });
    }
  }
  return results;
}
