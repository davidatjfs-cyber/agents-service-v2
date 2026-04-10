/**
 * HRMS agents.js 周度绩效 period 与 agents-service periodic-scoring 的 week_YYYY-MM-DD 并存；
 * 管理汇总需同时命中两种写法。
 */

import { addDaysYmdShanghai } from './anomaly-week-bounds.js';

export { addDaysYmdShanghai };

/**
 * 自然周跨两个自然月时，周度 anomaly_rollups_v2 按「触发日所在月」拆成两行 period：
 *   week_2026-03-30__202603 与 week_2026-03-30__202604
 * 同月整周仍为 week_2026-04-07。
 * anchorYmd：用于跨月周判断「写哪一段」时的锚点（如 HQ 判罚当日、trigger_date）。
 */
export function anomalyRollupPeriodKey(weekMonday, anchorYmd) {
  const wk = String(weekMonday || '').slice(0, 10);
  const weekEnd = addDaysYmdShanghai(wk, 6);
  const wm = wk.slice(0, 7);
  const em = weekEnd.slice(0, 7);
  if (wm === em) return `week_${wk}`;
  const a = String(anchorYmd || wk).slice(0, 10);
  const ymKey = `${a.slice(0, 4)}${a.slice(5, 7)}`;
  return `week_${wk}__${ymKey}`;
}

/**
 * 复刻 hr-management-system/server/agents.js evalTick 的 period：
 * `${year}-W${weekNum}`，weekNum = ceil((dayOfMonth + firstDayOfMonth.getDay()) / 7)
 */
export function hrmsLegacyWeekPeriodForYmd(ymd) {
  const c = new Date(new Date(`${ymd}T12:00:00`).toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const weekNum = Math.ceil(
    (c.getDate() + new Date(c.getFullYear(), c.getMonth(), 1).getDay()) / 7
  );
  return `${c.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * 绩效周：周一 periodMonday～周日；HRMS 在「下周一」9 点跑 chief evaluator，period 按「下周一」日期算出的 Wxx。
 */
export function weeklyAgentScorePeriodKeys(periodMonday) {
  const weekTag = `week_${periodMonday}`;
  const evalMonday = addDaysYmdShanghai(periodMonday, 7);
  const legacy = hrmsLegacyWeekPeriodForYmd(evalMonday);
  return [...new Set([weekTag, legacy])];
}
