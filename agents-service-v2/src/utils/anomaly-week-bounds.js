/**
 * 上海时区「自然周」周一～周日边界（用于周度异常，周与周之间不累计）。
 *
 * ## shanghaiLastCompletedWeekBounds（周度 BI / 周评核心）
 * 取「上一完整自然周」= **上周一 00:00 起至上周日 止** 对应的 yyyy-mm-dd 闭区间。
 *
 * 算法：`today`（上海日历）→ `yesterday` → `shanghaiWeekMonSunContaining(yesterday)`。
 * - **每周一 05:00（上海）触发周评时**：`today`=周一，`yesterday`=**上周日**，所含周为 **上周一～上周日**。
 *   不会出现「周二～本周一」这种错位窗口。
 * - 若在周二及之后调用，得到的是「含昨天的那一整周」；周度 BI 任务应仅在周一凌晨调度，与此口径一致。
 *
 * 与 `rhythm-engine` 周巡检、`anomaly-engine` 周频规则、`periodic-scoring.previousWeekMonday()` 同源。
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
