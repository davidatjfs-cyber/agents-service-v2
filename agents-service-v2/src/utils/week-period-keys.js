/**
 * HRMS agents.js 周度绩效 period 与 agents-service periodic-scoring 的 week_YYYY-MM-DD 并存；
 * 管理汇总需同时命中两种写法。
 */

/** 上海日历日 + n 天 → YYYY-MM-DD */
export function addDaysYmdShanghai(ymd, deltaDays) {
  const t = new Date(`${ymd}T12:00:00+08:00`);
  t.setUTCDate(t.getUTCDate() + deltaDays);
  return t.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
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
