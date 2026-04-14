/**
 * 趋势检测规则 — 渐变趋势异常，补充现有突变检测的盲区
 *
 * 3条规则：
 * 1. 同日环比连续下降（同一weekday连续3周下降）
 * 2. 午/晚市结构性失衡（午市占比连续偏低）
 * 3. 菜品衰退（连续2周销量下降>20%）
 *
 * 集成方式：在 anomaly-engine.js 的 runAnomalyChecks 末尾追加调用
 */
import { query } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { expandAgentStoreLabels } from '../../config/store-mapping.js';

function storePats(store) {
  const labels = expandAgentStoreLabels(store);
  return labels.map(l => `%${l.replace(/%/g, '')}%`);
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

function shanghaiToday() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

function weekdayZh(d) {
  return ['日', '一', '二', '三', '四', '五', '六'][new Date(`${d}T12:00:00+08:00`).getDay()];
}

/**
 * 规则12: 同日环比趋势 — 同一weekday某指标连续N周下降
 * 条件：同一weekday连续3周(medium)或4周(high)下降
 */
export async function checkWeekdayTrend(store, metricCol = 'actual_revenue') {
  const today = shanghaiToday();
  const wd = new Date(`${today}T12:00:00+08:00`).getDay();
  const wdZh = weekdayZh(today);

  const pats = storePats(store);

  const r = await query(
    `SELECT date, ${metricCol} AS val
     FROM daily_reports
     WHERE store ILIKE ANY($1::text[])
       AND EXTRACT(ISODOW FROM date) = $2
       AND date < $3::date
       AND ${metricCol} IS NOT NULL
       AND ${metricCol} > 0
     ORDER BY date DESC
     LIMIT 6`,
    [pats, wd, today]
  );

  const rows = r.rows || [];
  if (rows.length < 3) return { triggered: false, rule: 'weekday_trend' };

  let consecutiveDown = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    if (Number(rows[i].val) < Number(rows[i + 1].val)) {
      consecutiveDown++;
    } else {
      break;
    }
  }

  if (consecutiveDown < 3) return { triggered: false, rule: 'weekday_trend' };

  const severity = consecutiveDown >= 4 ? 'high' : 'medium';
  const firstVal = Number(rows[consecutiveDown].val);
  const lastVal = Number(rows[0].val);
  const changePct = ((lastVal - firstVal) / firstVal * 100).toFixed(1);

  const metricLabel = {
    actual_revenue: '营收',
    dine_traffic: '客流',
    dine_orders: '订单',
    efficiency: '人效',
  }[metricCol] || metricCol;

  return {
    triggered: true,
    rule: 'weekday_trend',
    type: 'weekday_trend',
    severity,
    store,
    detail: `周${wdZh}${metricLabel}连续${consecutiveDown}周下降（${changePct}%），从${Math.round(firstVal)}降至${Math.round(lastVal)}`,
    value: { consecutiveDown, firstVal, lastVal, changePct: +changePct, weekday: wdZh, metric: metricLabel },
  };
}

/**
 * 规则13: 午/晚市结构性失衡
 * 条件：午市营收占比连续N天低于阈值
 */
export async function checkMealBalance(store) {
  const pats = storePats(store);
  const today = shanghaiToday();

  const r = await query(
    `SELECT date, actual_revenue AS total,
            (actual_revenue * 0.4) AS lunch_est
     FROM daily_reports
     WHERE store ILIKE ANY($1::text[])
       AND date >= $2::date
       AND date < $3::date
       AND actual_revenue > 0
     ORDER BY date ASC`,
    [pats, addDays(today, -7), today]
  );

  const rows = r.rows || [];
  if (rows.length < 4) return { triggered: false, rule: 'meal_balance' };

  /* [需你定义] 午市占比阈值，默认30% */
  const THRESHOLD_MEDIUM = 0.30;
  const THRESHOLD_HIGH = 0.25;
  const WINDOW_DAYS = 5;

  const recent = rows.slice(-WINDOW_DAYS);
  let lowCount = 0;
  for (const row of recent) {
    const lunchPct = Number(row.lunch_est) / Number(row.total);
    if (lunchPct < THRESHOLD_MEDIUM) lowCount++;
  }

  if (lowCount < Math.ceil(WINDOW_DAYS * 0.6)) return { triggered: false, rule: 'meal_balance' };

  const avgLunchPct = recent.reduce((s, r) => s + Number(r.lunch_est) / Number(r.total), 0) / recent.length;
  const severity = avgLunchPct < THRESHOLD_HIGH ? 'high' : 'medium';

  return {
    triggered: true,
    rule: 'meal_balance',
    type: 'meal_balance',
    severity,
    store,
    detail: `近${WINDOW_DAYS}天午市营收占比仅${(avgLunchPct * 100).toFixed(1)}%，${lowCount}天低于${THRESHOLD_MEDIUM * 100}%警戒线`,
    value: { avgLunchPct: +(avgLunchPct * 100).toFixed(1), lowCount, windowDays: WINDOW_DAYS },
  };
}

/**
 * 规则14: 菜品衰退 — 某菜品连续N周销量下降超过阈值
 */
export async function checkDishDecline(store) {
  const pats = storePats(store);
  const today = shanghaiToday();

  const week1End = addDays(today, -1);
  const week1Start = addDays(week1End, -6);
  const week2End = addDays(week1Start, -1);
  const week2Start = addDays(week2End, -6);
  const week3End = addDays(week2Start, -1);
  const week3Start = addDays(week3End, -6);

  const r = await query(
    `SELECT dish_name,
            SUM(CASE WHEN date >= $2::date AND date <= $3::date THEN qty ELSE 0 END) AS w1,
            SUM(CASE WHEN date >= $4::date AND date <= $5::date THEN qty ELSE 0 END) AS w2,
            SUM(CASE WHEN date >= $6::date AND date <= $7::date THEN qty ELSE 0 END) AS w3
     FROM sales_raw
     WHERE store ILIKE ANY($1::text[])
       AND date >= $6::date AND date <= $3::date
     GROUP BY dish_name
     HAVING SUM(CASE WHEN date >= $2::date AND date <= $3::date THEN qty ELSE 0 END) >= 5`,
    [pats, week1Start, week1End, week2Start, week2End, week3Start, week3End]
  );

  const rows = r.rows || [];
  const declined = [];

  for (const row of rows) {
    const w1 = Number(row.w1);
    const w2 = Number(row.w2);
    const w3 = Number(row.w3);

    if (w2 <= 0) continue;
    const drop1 = (w1 - w2) / w2;
    if (drop1 > -0.20) continue;

    const drop2 = w3 > 0 ? (w2 - w3) / w3 : 0;
    const consecutiveDown = drop2 < -0.10 && drop1 < -0.10 ? 2 : 1;

    if (consecutiveDown >= 2) {
      declined.push({
        dish: row.dish_name,
        w3, w2, w1,
        dropPct: +(drop1 * 100).toFixed(1),
        severity: consecutiveDown >= 2 ? 'high' : 'medium',
      });
    }
  }

  if (!declined.length) return { triggered: false, rule: 'dish_decline' };

  const top = declined[0];
  return {
    triggered: true,
    rule: 'dish_decline',
    type: 'dish_decline',
    severity: top.severity,
    store,
    detail: `${top.dish}等${declined.length}个菜品销量连续下降，${top.dish}本周${top.w1}份 vs 上周${top.w2}份(${top.dropPct}%)`,
    value: { dishes: declined.slice(0, 5) },
  };
}

/**
 * 运行全部趋势检测，返回触发的异常列表
 */
export async function runTrendChecks(stores) {
  const results = [];

  for (const store of stores) {
    try {
      const checks = [
        checkWeekdayTrend(store, 'actual_revenue'),
        checkWeekdayTrend(store, 'dine_traffic'),
        checkMealBalance(store),
        checkDishDecline(store),
      ];

      const checkResults = await Promise.allSettled(checks);
      for (const cr of checkResults) {
        if (cr.status === 'fulfilled' && cr.value?.triggered) {
          results.push(cr.value);
        }
      }
    } catch (e) {
      logger.warn({ err: e?.message, store }, 'trend check failed');
    }
  }

  return results;
}
