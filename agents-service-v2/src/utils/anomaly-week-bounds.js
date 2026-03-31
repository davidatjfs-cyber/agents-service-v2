/**
 * 上海时区「自然周」周一～周日边界（用于周度异常，周与周之间不累计）。
 */

/** @returns {{ ymd: string, y: number, m: number, d: number }} */
export function getShanghaiYmdParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const s = fmt.format(date);
  const [y, m, d] = s.split('-').map(Number);
  return { ymd: s, y, m, d };
}

export function addDaysYmdShanghai(ymd, deltaDays) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  return new Date(utc).toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

function shanghaiWeekdayShort(ymd) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short'
  }).format(new Date(`${ymd}T12:00:00+08:00`));
}

/** 给定上海日期 ymd，返回该日期所在周的周一、周日（yyyy-mm-dd） */
export function shanghaiWeekMonSunContaining(ymd) {
  let cur = ymd;
  for (let i = 0; i < 8; i++) {
    if (shanghaiWeekdayShort(cur) === 'Mon') break;
    cur = addDaysYmdShanghai(cur, -1);
  }
  const weekStart = cur;
  const weekEnd = addDaysYmdShanghai(weekStart, 6);
  return { weekStart, weekEnd };
}

/** 上一完整自然周（周一至周日），以「今天上海日期」为锚 */
export function shanghaiLastCompletedWeekBounds() {
  const { ymd: today } = getShanghaiYmdParts();
  const yesterday = addDaysYmdShanghai(today, -1);
  return shanghaiWeekMonSunContaining(yesterday);
}

/** 与 periodic-scoring 一致：上周一（用于周评分 period） */
export function previousWeekMondayFromToday() {
  const { weekStart } = shanghaiLastCompletedWeekBounds();
  return weekStart;
}
