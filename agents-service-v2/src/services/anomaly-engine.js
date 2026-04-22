/**
 * 异常检测引擎 — 10类异常规则的核心计算逻辑
 * 
 * 每个检测函数返回: { triggered: boolean, severity: 'medium'|'high', value: any, threshold: any, detail: string }
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getAnomalyRules, toFeishuStoreName, getBrandForStore as getBrandFromConfig } from './config-service.js';
import { enqueueNotifyJob, enqueueCollabJob } from './anomaly-queue.js';
import { runBiAnomalyNotifyPipeline } from './anomaly-notify-pipeline.js';
import {
  fetchMergedTableVisitEntries,
  tableVisitEntryEligibleForTableVisitProductBi,
  dissatisfactionDishForTableVisitProductBi,
  fetchActualGrossMarginForStorePeriod,
  visitEntryStoreMatches
} from './deterministic-replies.js';
import { expandAgentStoreLabels } from '../config/store-mapping.js';
import { shanghaiLastCompletedWeekBounds, shanghaiCurrentWeekBounds } from '../utils/anomaly-week-bounds.js';
import { ANOMALY_RULES } from '../config/anomaly-rules.js';

function badReviewStoreCond(store) {
  const labels = expandAgentStoreLabels(store);
  if (labels.length === 0) return { sql: '1=0', params: [] };
  const conds = [];
  const params = [];
  for (const label of labels) {
    params.push(`%${label}%`);
    conds.push(`(fields->>'差评门店' ILIKE $${params.length} OR fields->>'所属门店' ILIKE $${params.length} OR fields->>'门店' ILIKE $${params.length})`);
  }
  return { sql: `(${conds.join(' OR ')})`, params };
}

async function notifyAdminsOnBadReviewCheckFailure(ruleKey, store, err) {
  try {
    const { sendText } = await import('./feishu-client.js');
    const r = await query(
      `SELECT open_id FROM feishu_users
       WHERE registered = true AND open_id IS NOT NULL AND role = 'admin'
       LIMIT 20`
    );
    const label = ruleKey === 'bad_review_product' ? '差评产品异常' : '差评服务异常';
    const msg = `🚨 【差评检测失败告警】\n规则：${label}\n门店：${store || '—'}\n错误：${String(err?.message || err).slice(0, 800)}\n\n请检查差评数据源和服务运行状态。`;
    for (const row of (r.rows || [])) {
      await sendText(row.open_id, msg, 'open_id').catch(() => {});
    }
  } catch (e) {
    logger.warn({ err: e?.message, ruleKey, store }, 'notifyAdminsOnBadReviewCheckFailure failed');
  }
}

// ─── 工具函数 ───
function getMonthDays(year, month) {
  return new Date(year, month, 0).getDate();
}

/** 上海日历当天 Y/M/D（与巡检、确定性桌访回复一致） */
function getShanghaiYmdParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const s = fmt.format(date);
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d, ymd: s };
}

function shanghaiTodayYmd() {
  return getShanghaiYmdParts().ymd;
}

/** 与 anomaly-rules.js 一致：防止 DB 将 monthly/weekly 误配为 daily 后在巡检日频重复触发 */
function canonicalAnomalyFrequency(ruleKey) {
  const r = ANOMALY_RULES.find((x) => x.key === ruleKey);
  return r?.frequency || null;
}

function addDaysYmdShanghai(ymd, deltaDays) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d) + deltaDays * 86400000;
  return new Date(utc).toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
}

/** 与桌访 KPI / deterministic-replies 一致：多别名 ILIKE ANY，避免「全称 vs 飞书简称」漏加总 dine_orders */
function dailyReportIlikePatterns(store) {
  const labs = expandAgentStoreLabels(String(store || '').trim());
  const pats = labs.map((lab) => `%${String(lab).replace(/%/g, '')}%`);
  return pats.length ? pats : [`%${String(store || '').replace(/%/g, '')}%`];
}

/** 上海「今天」起往前 n 天（含今天）的 date 区间，用于替换 CURRENT_DATE（避免服务器 UTC 错位） */
function shanghaiRollingDateRange(numDaysInclusive) {
  const { ymd: end } = getShanghaiYmdParts();
  const start = addDaysYmdShanghai(end, -(numDaysInclusive - 1));
  return { start, end };
}

/**
 * 近 n 个已满日（不含上海「今天」），避免当日日报未齐导致桌访占比、客流环比等误判。
 */
function shanghaiCompletedRollingDateRange(numDaysInclusive) {
  const today = shanghaiTodayYmd();
  const end = addDaysYmdShanghai(today, -1);
  const start = addDaysYmdShanghai(end, -(numDaysInclusive - 1));
  return { start, end };
}

/** 以上海日历为准的上月首尾 yyyy-mm-dd */
function shanghaiPrevCalendarMonthBounds() {
  const { y, m } = getShanghaiYmdParts();
  let py = y;
  let pm = m - 1;
  if (pm < 1) {
    pm = 12;
    py -= 1;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const first = `${py}-${pad(pm)}-01`;
  const lastD = getMonthDays(py, pm);
  const last = `${py}-${pad(pm)}-${String(lastD).padStart(2, '0')}`;
  return { first, last };
}

async function getBrandForStore(store) {
  return await getBrandFromConfig(store);
}

// ─── 1a. 实收营收异常（自然周独立：仅统计上周一～上周日，不与其它周累计；周目标=月目标×7/当月天数）───
export async function checkRevenueAchievement(store) {
  const rules = await getAnomalyRules();
  const ruleConfig = rules?.revenue_achievement;
  if (!ruleConfig?.enabled) return { triggered: false, detail: '规则已禁用' };

  const { weekStart, weekEnd } = shanghaiLastCompletedWeekBounds();
  const midYmd = addDaysYmdShanghai(weekStart, 3);
  const [y, m] = midYmd.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const monthKey = `${y}-${pad(m)}`;
  const monthDays = getMonthDays(y, m);

  const revR = await query(
    `SELECT COALESCE(SUM(actual_revenue), 0) AS total_rev
     FROM daily_reports WHERE store ILIKE ANY($1::text[]) AND date >= $2::date AND date <= $3::date`,
    [dailyReportIlikePatterns(store), weekStart, weekEnd]
  );
  const weekRev = parseFloat(revR.rows[0]?.total_rev || 0);

  const tgtR = await query(
    `SELECT target_revenue FROM revenue_targets
     WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g'))
           LIKE '%' || lower(regexp_replace($1, '\\s+', '', 'g')) || '%'
     AND period = $2 LIMIT 1`,
    [store, monthKey]
  );
  const monthTarget = parseFloat(tgtR.rows[0]?.target_revenue || 0);
  if (!monthTarget) return { triggered: false, detail: '无月目标数据' };

  const weekTarget = (monthTarget * 7) / monthDays;
  if (weekTarget <= 0) return { triggered: false, detail: '周目标无效' };

  const gapPct = weekRev < weekTarget ? ((weekTarget - weekRev) / weekTarget) * 100 : 0;

  const thresholds = ruleConfig.threshold || {};
  let severity = null;
  if (gapPct >= (thresholds.high?.achievement_gap_pct || 15)) severity = 'high';
  else if (gapPct >= (thresholds.medium?.achievement_gap_pct || 10)) severity = 'medium';

  return {
    triggered: !!severity,
    severity,
    value: {
      weekRev,
      weekTarget: +weekTarget.toFixed(0),
      weekStart,
      weekEnd,
      gapPct: +gapPct.toFixed(2)
    },
    threshold: thresholds,
    detail: severity
      ? `周实收¥${weekRev.toFixed(0)} vs 周目标≈¥${weekTarget.toFixed(0)}（${weekStart}~${weekEnd}，缺口${gapPct.toFixed(1)}%）`
      : `周营收正常（${weekStart}~${weekEnd}）`
  };
}

// ─── 1b. 实收营收异常（整月维度，上月全月实收 vs 月目标）───
export async function checkRevenueAchievementMonthly(store) {
  const rules = await getAnomalyRules();
  const ruleConfig = rules?.revenue_achievement_monthly;
  if (!ruleConfig?.enabled) return { triggered: false, detail: '规则已禁用或未配置' };

  const { first: ms, last: me } = shanghaiPrevCalendarMonthBounds();
  const periodYm = ms.slice(0, 7);

  const revR = await query(
    `SELECT COALESCE(SUM(actual_revenue), 0) AS total_rev
     FROM daily_reports WHERE store ILIKE ANY($1::text[]) AND date >= $2::date AND date <= $3::date`,
    [dailyReportIlikePatterns(store), ms, me]
  );
  const monthRev = parseFloat(revR.rows[0]?.total_rev || 0);

  const tgtR = await query(
    `SELECT target_revenue FROM revenue_targets
     WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g'))
           LIKE '%' || lower(regexp_replace($1, '\\s+', '', 'g')) || '%'
     AND period = $2 LIMIT 1`,
    [store, periodYm]
  );
  const monthTarget = parseFloat(tgtR.rows[0]?.target_revenue || 0);
  if (!monthTarget) return { triggered: false, detail: '无月目标数据' };

  const gapPct = monthRev < monthTarget ? ((monthTarget - monthRev) / monthTarget) * 100 : 0;
  const thresholds = ruleConfig.threshold || {};
  let severity = null;
  if (gapPct >= (thresholds.high?.achievement_gap_pct || 15)) severity = 'high';
  else if (gapPct >= (thresholds.medium?.achievement_gap_pct || 10)) severity = 'medium';

  return {
    triggered: !!severity,
    severity,
    value: { monthRev, monthTarget, periodYm, gapPct: +gapPct.toFixed(2) },
    threshold: thresholds,
    detail: severity
      ? `${periodYm}月实收¥${monthRev.toFixed(0)} vs 目标¥${monthTarget.toFixed(0)}，缺口${gapPct.toFixed(1)}%`
      : `${periodYm}月营收达成正常`
  };
}

// ─── 2. 人效值异常 ───
export async function checkLaborEfficiency(store) {
  const brand = await getBrandForStore(store);
  const rules = await getAnomalyRules();
  const ruleConfig = rules?.labor_efficiency;
  if (!ruleConfig?.enabled) return { triggered: false, detail: '规则已禁用' };
  const brandThresholds = ruleConfig.threshold[brand] || ruleConfig.threshold.default;
  if (!brandThresholds) return { triggered: false, detail: `品牌${brand}无阈值配置` };

  // 与营收周度一致：上一完整自然周（周一至周日）日均人效
  const { weekStart, weekEnd } = shanghaiLastCompletedWeekBounds();
  const r = await query(
    `SELECT AVG(efficiency) AS avg_eff, COUNT(*) AS days
     FROM daily_reports
     WHERE store ILIKE ANY($1::text[]) AND date >= $2::date AND date <= $3::date AND efficiency > 0`,
    [dailyReportIlikePatterns(store), weekStart, weekEnd]
  );
  const avgEff = parseFloat(r.rows[0]?.avg_eff || 0);
  if (!avgEff) return { triggered: false, detail: '无人效数据（近7天日报未提交或 efficiency 为空）' };

  let severity = null;
  if (avgEff < brandThresholds.high.below) severity = 'high';
  else if (avgEff < brandThresholds.medium.below) severity = 'medium';

  return {
    triggered: !!severity,
    severity,
    value: { avgEfficiency: avgEff.toFixed(0), brand, weekStart, weekEnd },
    threshold: brandThresholds,
    detail: severity
      ? `${brand}人效${avgEff.toFixed(0)}元/人，低于${severity==='high'?brandThresholds.high.below:brandThresholds.medium.below}`
      : `人效正常 ${avgEff.toFixed(0)}元/人`
  };
}

// ─── 3. 充值异常 ───
// 连续无充值（自然月内 streak，遇有充值日则 streak 归零；不跨月向回数）— 与业务约定一致：
//   第 1 个连续无充值日 → 扣 2 分；第 2 个及以后连续无充值日 → 每日均扣 4 分，直至出现「有充值」日（该日不扣分）。
// 例：D1 无充 2 分，D2 无充 4 分，D3 有充 0 分并重置，D4 无充 2 分，D5 无充 4 分，D6 无充 4 分……
// 实现：`penalty_points = streak >= 2 ? 4 : 2`（streak 为从判定日连续向回数的无充值满报日数）。
// 周度绩效汇总 **不得** 对多条 anomaly_triggers 的 penalty_points 简单相加（同日多次日检会重复；须以 daily_reports 按日重算）；
// 见 `sumRechargePenaltyPointsForClosedDaysInRange`（按 daily_reports 重算）。
//
// 判定基准日 = 上海「昨日」完整营业日（不是「今天」）。避免当日日报尚未关账、充值字段仍为 0 时误派单
//（典型客诉：昨日营业日已有充值，但任务仍发「充值异常」——实为在评判「今天」的不完整日报）。
function monthStartForYmd(ymd) {
  return String(ymd || '').slice(0, 7) + '-01';
}

function hasRechargeRow(rec) {
  return rec && (rec.cnt > 0 || rec.amt > 0);
}

/** 日报充值按日聚合（与 checkRechargeZero / 周汇总同源） */
export async function fetchDailyReportRechargeByDayMap(store, dateFromInclusive, dateToInclusive) {
  const r = await query(
    `SELECT date::date::text AS d,
            COALESCE(SUM(COALESCE(recharge_count, 0)), 0)::int AS cnt,
            COALESCE(SUM(COALESCE(recharge_amount, 0)), 0)::numeric AS amt
     FROM daily_reports
     WHERE store ILIKE ANY($1::text[])
       AND date::date >= $2::date
       AND date::date <= $3::date
     GROUP BY date::date
     ORDER BY date::date ASC`,
    [dailyReportIlikePatterns(store), dateFromInclusive, dateToInclusive]
  );
  const byDay = new Map();
  for (const row of r.rows || []) {
    const key = String(row.d || '').slice(0, 10);
    byDay.set(key, { cnt: parseInt(row.cnt || 0, 10), amt: parseFloat(row.amt || 0) });
  }
  return byDay;
}

/**
 * 单日营业日 evalSh：无日报→不扣；有充值→不触发；零充值则按当月 streak 得 2 或 4 分（与 checkRechargeZero 一致）。
 * @returns {{ triggered:boolean, penalty_points:number, streak:number, month_start:string, evaluated_day_recharge?:{count:number,amount:number} }}
 */
export function evaluateRechargeZeroForDayFromMap(evalSh, byDay) {
  const monthStart = monthStartForYmd(evalSh);
  const evalR = byDay.get(evalSh);
  if (!evalR) {
    return { triggered: false, penalty_points: 0, streak: 0, month_start: monthStart, evaluated_day_recharge: null };
  }
  if (hasRechargeRow(evalR)) {
    return {
      triggered: false,
      penalty_points: 0,
      streak: 0,
      month_start: monthStart,
      evaluated_day_recharge: { count: evalR.cnt, amount: evalR.amt }
    };
  }
  let streak = 0;
  for (let i = 0; i < 31; i++) {
    const d = addDaysYmdShanghai(evalSh, -i);
    if (d < monthStart) break;
    const rec = byDay.get(d);
    if (!rec) break;
    if (hasRechargeRow(rec)) break;
    streak++;
  }
  const penalty_points = streak >= 2 ? 4 : 2;
  return {
    triggered: true,
    penalty_points,
    streak,
    month_start: monthStart,
    evaluated_day_recharge: { count: evalR.cnt, amount: evalR.amt }
  };
}

/**
 * 自然周（或月段）内每个「已满」营业日按 daily_reports 重算充值扣分并求和。
 * 不含「今天」：lastClosed = min(rangeEnd, 上海昨日)，避免未关账日误算。
 * 解决：多条 recharge_zero trigger（含不同 trigger_date 指向同一营业日）在周汇总里被 **累加 penalty_points** 导致多扣。
 */
export async function sumRechargePenaltyPointsForClosedDaysInRange(store, rangeStartYmd, rangeEndYmd) {
  const todaySh = shanghaiTodayYmd();
  const yesterdaySh = addDaysYmdShanghai(todaySh, -1);
  const lastClosed = String(rangeEndYmd) < todaySh ? String(rangeEndYmd) : yesterdaySh;
  if (String(rangeStartYmd) > lastClosed) {
    return { sum: 0, lineDays: [] };
  }
  const msA = monthStartForYmd(rangeStartYmd);
  const msB = monthStartForYmd(lastClosed);
  const qStart = msA < msB ? msA : msB;
  const byDay = await fetchDailyReportRechargeByDayMap(store, qStart, lastClosed);
  let sum = 0;
  const lineDays = [];
  for (let d = String(rangeStartYmd); d <= lastClosed; d = addDaysYmdShanghai(d, 1)) {
    const ev = evaluateRechargeZeroForDayFromMap(d, byDay);
    if (ev.triggered && ev.penalty_points > 0) {
      sum += ev.penalty_points;
      lineDays.push({ d, penalty: ev.penalty_points, streak: ev.streak });
    }
  }
  return { sum, lineDays };
}

export async function checkRechargeZero(store) {
  try {
    const todaySh = shanghaiTodayYmd();
    const evalSh = addDaysYmdShanghai(todaySh, -1);
    const monthStart = monthStartForYmd(evalSh);
    const byDay = await fetchDailyReportRechargeByDayMap(store, monthStart, todaySh);
    const evalR = byDay.get(evalSh);
    if (!evalR) {
      return { triggered: false, detail: `${evalSh} 无营业日报，跳过充值判定（口径：上海昨日）` };
    }
    if (hasRechargeRow(evalR)) {
      return { triggered: false, detail: `${evalSh} 有充值，正常（口径：上海昨日）` };
    }
    const ev = evaluateRechargeZeroForDayFromMap(evalSh, byDay);
    const streak = ev.streak;
    const penalty_points = ev.penalty_points;
    const severity = penalty_points >= 4 ? 'high' : 'medium';

    return {
      triggered: true,
      severity,
      value: {
        /** 被判定「有无充值」的营业日 = 上海「昨日」，与 trigger_date 一致；不是任务运行当日 */
        evaluated_business_day: evalSh,
        evaluationYmd: evalSh,
        /** @deprecated 易误解为「今天」；请用 evaluated_business_day */
        dateToday: evalSh,
        run_calendar_ymd: todaySh,
        runCalendarYmd: todaySh,
        consecutive_zero_days: streak,
        penalty_points,
        month_start: monthStart,
        evaluated_day_recharge: { count: evalR.cnt, amount: evalR.amt },
        today: { count: evalR.cnt, amount: evalR.amt }
      },
      threshold: { medium: '2分（连续无充值第1日）', high: '4分（连续无充值第2日起每日）' },
      detail: `判定营业日 ${evalSh}（以上海昨日为准，避免当日未关账误报）：该日日报充值笔数与金额为 0；${monthStart} 起不跨月连续无充值 ${streak} 日，绩效扣分 ${penalty_points} 分`
    };
  } catch (err) {
    return { triggered: false, detail: `充值检测异常: ${err.message}` };
  }
}

// ─── 4. 桌访产品异常 ───
/**
 * 周频 BI 仅在**每周一**调度（rhythm-engine 05:00 上海）；窗口为 **shanghaiLastCompletedWeekBounds() = 上周一～上周日**（不以「本周」为锚）。
 * 菜品名**严格**取自桌访表/多维表独立列「今天不满意菜品」（及「今天 不满意菜品」空格变体），见 dissatisfactionDishForTableVisitProductBi；
 * 不读取其它「不满意」类列名，不回落 e.dish。行须 tableVisitEntryEligibleForTableVisitProductBi（满意度为好则排除；未填满意度时须本列有菜名且有不满意主要原因）。
 */
export async function checkTableVisitProduct(store) {
  const { weekStart: startDate, weekEnd: endDate } = shanghaiLastCompletedWeekBounds();

  let entries = [];
  try {
    entries = await fetchMergedTableVisitEntries(store, startDate, endDate);
  } catch (err) {
    return { triggered: false, detail: `桌访产品检测异常: ${err.message}` };
  }

  const byCanon = new Map();
  for (const e of entries.filter(tableVisitEntryEligibleForTableVisitProductBi)) {
    const raw = String(dissatisfactionDishForTableVisitProductBi(e) || '').trim();
    if (!raw) continue;
    // 拆分：支持中英文逗号、顿号、斜杠作为分隔符
    const dishes = raw.split(/[,，、\/]/).map((s) => s.trim()).filter(Boolean);
    for (const dish of dishes) {
      const canon = dish.toLowerCase().replace(/\s+/g, '');
      if (!canon) continue;
      const prev = byCanon.get(canon);
      if (prev) prev.cnt += 1;
      else byCanon.set(canon, { complaint: dish, cnt: 1 });
    }
  }

  const productsAll = [...byCanon.values()]
    .sort((a, b) => b.cnt - a.cnt)
    .map((p) => ({ complaint: p.complaint, cnt: String(p.cnt) }));

  if (productsAll.length === 0) {
    return {
      triggered: false,
      detail: `本窗口（${startDate}~${endDate}，上周）无「今天不满意菜品」列可统计的有效记录；请确认飞书/同步字段名与该列一致。`
    };
  }

  /** 周度绩效扣分：按产品维度分别计分后相加（≥4次10分，≥2次5分；多产品分别触发则累加，如4个产品各≥2次共20分） */
  const productsScored = [];
  let deductionPointsTotal = 0;
  for (const p of productsAll) {
    const cnt = parseInt(p.cnt, 10) || 0;
    let deduction_points = 0;
    let tier = null;
    if (cnt >= 4) {
      deduction_points = 10;
      tier = 'high';
    } else if (cnt >= 2) {
      deduction_points = 5;
      tier = 'medium';
    }
    if (deduction_points > 0) {
      deductionPointsTotal += deduction_points;
      productsScored.push({
        complaint: p.complaint,
        cnt: p.cnt,
        deduction_points,
        tier
      });
    }
  }

  if (productsScored.length === 0) return { triggered: false, detail: '本窗口无达扣分阈值的产品（单产品须≥2次不满意）' };

  const hasHighTier = productsScored.some((x) => x.tier === 'high');
  const severity = hasHighTier ? 'high' : 'medium';
  const topNames = productsScored.slice(0, 4).map((x) => `${x.complaint}×${x.cnt}（-${x.deduction_points}）`);
  const detail = `桌访产品：${productsScored.length} 个产品触发扣分，合计扣 ${deductionPointsTotal} 分（单产品≥4次10分、≥2次5分，按产品累计；自然周 ${startDate}~${endDate}）。${topNames.join('；')}${productsScored.length > 4 ? '…' : ''}`;

  return {
    triggered: true,
    severity,
    value: {
      products: productsScored,
      deduction_points_total: deductionPointsTotal,
      window: `${startDate}~${endDate}`,
      weekStart: startDate,
      weekEnd: endDate,
      dataSource: 'merged_table_visit_bi_strict_field_今天不满意菜品_last_completed_week'
    },
    threshold: {
      medium: '单产品≥2次：该产品扣5分（多产品分别计）',
      high: '单产品≥4次：该产品扣10分（与2次档不重复累计，取较高档）'
    },
    detail
  };
}

// ─── 5. 桌访占比异常 ───
export async function checkTableVisitRatio(store) {
  // 与 KPI 一致：已满 7 日（不含今日），且 dine_orders 按门店别名汇总，避免占比失真
  const { start: twStart, end: twEnd } = shanghaiCompletedRollingDateRange(7);
  // 桌访条数：与飞书问答同源（table_visit_records + feishu_generic_records 合并去重），禁止仅用「所属门店=」精确匹配漏数
  let visitCount = 0;
  try {
    const merged = await fetchMergedTableVisitEntries(store, twStart, twEnd);
    visitCount = merged.length;
  } catch (err) {
    return { triggered: false, detail: `桌访占比检测异常: ${err.message}` };
  }
  // 近7天堂食订单数：营业日报 dine_orders 汇总（与用户口径一致）
  const drR = await query(
    `SELECT COALESCE(SUM(dine_orders), 0) AS total_orders
     FROM daily_reports
     WHERE store ILIKE ANY($1::text[]) AND date >= $2::date AND date <= $3::date`,
    [dailyReportIlikePatterns(store), twStart, twEnd]
  );
  const totalOrders = parseInt(drR.rows[0]?.total_orders || 0);
  if (!totalOrders) return { triggered: false, detail: '无堂食订单数据' };

  const ratio = (visitCount / totalOrders) * 100;
  let severity = null;
  if (ratio < 40) severity = 'high';
  else if (ratio < 50) severity = 'medium';

  return {
    triggered: !!severity,
    severity,
    value: { visitCount, totalOrders, ratio: ratio.toFixed(1) },
    threshold: { medium: '<50%', high: '<40%' },
    detail: severity
      ? `桌访率${ratio.toFixed(1)}%（${visitCount}/${totalOrders}），低于${severity==='high'?'40%':'50%'}`
      : `桌访率正常 ${ratio.toFixed(1)}%`
  };
}

// ─── 6. 总实收毛利率异常 ───
export async function checkGrossMargin(store) {
  const brand = await getBrandForStore(store);
  const rules = await getAnomalyRules();
  const ruleConfig = rules?.gross_margin;
  if (!ruleConfig?.enabled) return { triggered: false, detail: '规则已禁用' };
  const brandThresholds = ruleConfig.threshold[brand] || ruleConfig.threshold.default;
  if (!brandThresholds) return { triggered: false, detail: `品牌${brand}无阈值配置` };

  // 业务固定：仅每月 10 日（上海日历）做一次上月毛利率判定与派单，与 08:20 月规复检 cron 对齐；其它日期直接跳过，避免与周报/日巡检误触发混淆
  const { d: shanghaiDom } = getShanghaiYmdParts();
  if (shanghaiDom !== 10) {
    return {
      triggered: false,
      detail: `总实收毛利率为月度项，仅在每月10日统计上月结（今日${shanghaiTodayYmd()}已跳过）`
    };
  }

  // 上月实收毛利率：优先 monthly_margins（飞书「实际毛利率表」同步），其次多维表行，最后日报均值
  const { first: lmFirst, last: lmLast } = shanghaiPrevCalendarMonthBounds();
  const periodYm = lmFirst.slice(0, 7);

  let avgMargin = 0;
  const mm = await query(
    `SELECT actual_margin::float AS m FROM monthly_margins
     WHERE period = $1 AND store ILIKE ANY($2::text[])
     ORDER BY length(store) DESC
     LIMIT 1`,
    [periodYm, dailyReportIlikePatterns(store)]
  );
  avgMargin = parseFloat(mm.rows[0]?.m || 0);

  if (!avgMargin) {
    const bit = await fetchActualGrossMarginForStorePeriod(store, periodYm);
    const v = bit?.actualReceivedMarginPct ?? bit?.preDiscountMarginPct;
    if (v != null && !Number.isNaN(Number(v))) avgMargin = Number(v);
  }

  if (!avgMargin) {
    const r = await query(
      `SELECT AVG(actual_margin) AS avg_margin
       FROM daily_reports
       WHERE store ILIKE ANY($1::text[]) AND date >= $2::date AND date <= $3::date AND actual_margin > 0`,
      [dailyReportIlikePatterns(store), lmFirst, lmLast]
    );
    avgMargin = parseFloat(r.rows[0]?.avg_margin || 0);
  }

  if (!avgMargin) return { triggered: false, detail: '无毛利率数据（请同步飞书「实际毛利率表」或维护日报 actual_margin）' };

  let severity = null;
  if (avgMargin < brandThresholds.high.below_pct) severity = 'high';
  else if (avgMargin < brandThresholds.medium.below_pct) severity = 'medium';

  return {
    triggered: !!severity,
    severity,
    deferred: false,
    value: {
      avgMargin: avgMargin.toFixed(1),
      brand,
      period: periodYm
    },
    threshold: brandThresholds,
    detail: severity
      ? `${brand}实收毛利率${avgMargin.toFixed(1)}%，低于${severity==='high'?brandThresholds.high.below_pct:brandThresholds.medium.below_pct}%（${periodYm} 月结｜每月10日检测）`
      : `毛利率正常 ${avgMargin.toFixed(1)}%（${periodYm}）`
  };
}

/** 仅大众点评（排除外卖差评） */
function badReviewDianpingCond(alias = 'fields') {
  return `(
    (COALESCE(${alias}->>'差评平台','') ILIKE '%大众%' OR COALESCE(${alias}->>'差评平台','') ILIKE '%美团点评%')
    AND COALESCE(${alias}->>'差评平台','') NOT ILIKE '%外卖%'
    AND COALESCE(${alias}->>'平台','') NOT ILIKE '%外卖%'
  )`;
}

// ─── 7. 差评报告产品异常（大众点评 only，每日触发，自然周递进扣分）───
// 产品差评判定：差评产品去除服务/环境/态度等非产品标签后仍有实质内容 + 差评类型含产品/出品/菜品
export async function checkBadReviewProduct(store) {
  const { weekStart, weekEnd } = shanghaiCurrentWeekBounds();
  const sc = badReviewStoreCond(store);
  const r = await query(
    `SELECT COUNT(*)::int AS cnt
     FROM feishu_generic_records
     WHERE config_key = 'bad_review' AND ${sc.sql}
       AND (timezone('Asia/Shanghai', created_at))::date >= $${sc.params.length + 1}::date
       AND (timezone('Asia/Shanghai', created_at))::date <= $${sc.params.length + 2}::date
       AND ${badReviewDianpingCond('fields')}
       AND (
         (fields->>'差评产品' IS NOT NULL AND TRIM(fields->>'差评产品') <> ''
          AND TRIM(regexp_replace(
            regexp_replace(
              regexp_replace(fields->>'差评产品', '(^|、|,)\\s*(服务|环境|态度|全品类菜品|全店菜品)\\s*(?=(、|,|$))', E'\\1', 'g'),
              '(^|、|,)\\s*(服务|环境|态度|全品类菜品|全店菜品)\\s*(?=(、|,|$))', E'\\1', 'g'
            ),
            '(^、+|、+$|,{1,}|、{2,})', '', 'g'
          )) <> '')
         OR fields->>'差评类型' ILIKE '%产品%'
         OR fields->>'差评类型' ILIKE '%出品%'
         OR fields->>'差评类型' ILIKE '%菜品%'
       )`,
    [...sc.params, weekStart, weekEnd]
  );
  const cnt = parseInt(r.rows[0]?.cnt || 0);
  if (cnt <= 0) {
    return { triggered: false, detail: `大众点评产品差评 0 条（${weekStart}~${weekEnd}）` };
  }
  const deduction_production = cnt === 1 ? 5 : cnt * 10;
  const severity = cnt >= 2 ? 'high' : 'medium';
  return {
    triggered: true,
    severity,
    value: { count: cnt, weekStart, weekEnd, deduction_production, platform: 'dianping_only' },
    threshold: { one: '本周第1条5分', multi: '本周≥2条每条10分' },
    detail: `大众点评产品差评${cnt}条（${weekStart}~${weekEnd}），出品扣${deduction_production}分`
  };
}

// ─── 8. 差评报告服务异常（大众点评 only，每日触发，自然周递进扣分）───
// 服务差评判定：差评类型含服务 + 差评关键词含服务 + 差评产品字段值为"服务" + 差评原因含服务且无产品
export async function checkBadReviewService(store) {
  const { weekStart, weekEnd } = shanghaiCurrentWeekBounds();
  const sc = badReviewStoreCond(store);
  const r = await query(
    `SELECT COUNT(*)::int AS cnt
     FROM feishu_generic_records
     WHERE config_key = 'bad_review' AND ${sc.sql}
       AND (timezone('Asia/Shanghai', created_at))::date >= $${sc.params.length + 1}::date
       AND (timezone('Asia/Shanghai', created_at))::date <= $${sc.params.length + 2}::date
       AND ${badReviewDianpingCond('fields')}
       AND (
         fields->>'差评类型' ILIKE '%服务%'
         OR fields->>'差评关键词' ILIKE '%服务%'
         OR (fields->>'差评产品' ILIKE '%服务%')
         OR (fields->>'差评原因' ILIKE '%服务%' AND (fields->>'差评产品' IS NULL OR TRIM(fields->>'差评产品') = ''))
       )`,
    [...sc.params, weekStart, weekEnd]
  );
  const cnt = parseInt(r.rows[0]?.cnt || 0);
  if (cnt <= 0) {
    return { triggered: false, detail: `大众点评服务差评 0 条（${weekStart}~${weekEnd}）` };
  }
  const deduction_manager = cnt === 1 ? 5 : cnt * 10;
  const severity = cnt >= 2 ? 'high' : 'medium';
  return {
    triggered: true,
    severity,
    value: { count: cnt, weekStart, weekEnd, deduction_manager, platform: 'dianping_only' },
    threshold: { one: '本周第1条5分', multi: '本周≥2条每条10分' },
    detail: `大众点评服务差评${cnt}条（${weekStart}~${weekEnd}），店长扣${deduction_manager}分`
  };
}

// ─── 9. 洪潮久光包房使用异常（营业日报 private_room_uses，2间包房周度合计）───
export async function checkPrivateRoomJiuguang(store) {
  const rules = await getAnomalyRules();
  const ruleConfig = rules?.hongchao_jiuguang_private_room;
  if (!ruleConfig?.enabled) return { triggered: false, detail: '规则未启用' };

  const s = String(store || '');
  if (!/(大宁久光|洪潮久光)/.test(s)) {
    return { triggered: false, detail: '仅适用于洪潮久光门店' };
  }
  const brand = await getBrandForStore(store);
  if (brand !== '洪潮') return { triggered: false, detail: '非洪潮品牌' };

  const { weekStart, weekEnd } = shanghaiLastCompletedWeekBounds();
  const sumR = await query(
    `SELECT COALESCE(SUM(COALESCE(private_room_uses, 0)), 0)::int AS u
     FROM daily_reports
     WHERE store ILIKE ANY($1::text[]) AND date >= $2::date AND date <= $3::date`,
    [dailyReportIlikePatterns(store), weekStart, weekEnd]
  );
  const uses = parseInt(sumR.rows[0]?.u || 0, 10);
  const th = ruleConfig.threshold || {};
  const target = Number(th.target_uses ?? 28);
  const med = Number(th.medium_below ?? 22);
  const hi = Number(th.high_below ?? 20);

  let severity = null;
  if (uses < hi) severity = 'high';
  else if (uses < med) severity = 'medium';

  return {
    triggered: !!severity,
    severity,
    value: { uses, target, weekStart, weekEnd },
    threshold: { target, medium_below: med, high_below: hi },
    detail: severity
      ? `包房周使用${uses}次（目标${target}，${weekStart}~${weekEnd}），低于${severity === 'high' ? hi : med}触发`
      : `包房周使用正常（${uses}次）`
  };
}

// ─── 10. 食品安全评价异常 ───
const FOOD_SAFETY_KEYWORDS = [
  '不新鲜',
  '有异味',
  '有异物',
  '异物',
  '异味',
  '不舒服',
  '拉肚子',
  '腹泻',
  '呕吐',
  '头发',
  '虫',
  '变质',
  '过期',
  '发霉',
  '食物中毒',
  '苍蝇',
  '蟑螂',
  '生的',
  '没熟'
];

function collectFoodSafetyKeywordHits(textContent) {
  return FOOD_SAFETY_KEYWORDS.filter((kw) => String(textContent).includes(kw));
}

/** 截取首个命中词附近的上下文，便于飞书卡片内人工核对 */
function buildFoodSafetyTextExcerpt(text, keywords, maxLen = 360) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  let idx = -1;
  let kw = '';
  for (const k of keywords) {
    const i = t.indexOf(k);
    if (i >= 0 && (idx < 0 || i < idx)) {
      idx = i;
      kw = k;
    }
  }
  if (idx < 0) {
    return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
  }
  const before = 80;
  const after = 220;
  const start = Math.max(0, idx - before);
  const end = Math.min(t.length, idx + kw.length + after);
  const frag =
    (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '');
  return frag.length > maxLen ? `${frag.slice(0, maxLen)}…` : frag;
}

function shanghaiYmdFromTs(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 10);
  } catch (_e) {
    return '';
  }
}

function pickBadReviewBusinessDate(fields, createdAt) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const keys = ['评价日期', '日期', '反馈日期', '评论日期', '点评日期', '发生日期'];
  for (const k of keys) {
    const s = String(f[k] ?? '').trim();
    if (s) return s.slice(0, 10);
  }
  return shanghaiYmdFromTs(createdAt);
}

/** yyyy-mm-dd → 2026年3月30日（便于飞书里一眼定位） */
function formatChineseCalendarDate(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(ymd || '').trim() || '（日期未填）';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return `${y}年${mo}月${d}日`;
}

/** 每条一行：x月x日的某报告 + 记录号 + 「记录显示：关键词」 */
function buildFoodSafetySourceFingerprintLine(e, index1) {
  const dateZh = formatChineseCalendarDate(e.record_date);
  const reportName =
    e.source_kind === 'table_visit' ? '桌访巡台报告' : e.source_kind === 'bad_review' ? '差评报告（飞书同步）' : '业务报告';
  const ref = e.record_ref ? `记录号 ${e.record_ref}` : '无单独记录号（请用日期+门店在表中筛选）';
  const hits = e.matched_keywords.join('、');
  const plat = e.platform ? `；渠道：${e.platform}` : '';
  return `${index1}）**${dateZh}**《${reportName}》（${ref}）里的记录显示：**${hits}**${plat}`;
}

function formatFoodSafetyRichDetail(scanYmd, matchedKeywords, evidence) {
  const header = `食品安全预警：命中关键词「${matchedKeywords.join('、')}」`;
  const scanZh = formatChineseCalendarDate(scanYmd);
  const intro = `**系统扫描日**：${scanZh}（上海时区，对应库内「按日扫描」基准日）。\n请先对照下方**【数据来源速览】**到对应表逐条打开记录；再看**【原文摘录】**核对上下文。`;
  const fingerprints = evidence.map((e, i) => buildFoodSafetySourceFingerprintLine(e, i + 1)).join('\n');
  const quick = `**【数据来源速览】**\n${fingerprints}`;
  const blocks = evidence.map((e, i) => {
    const plat = e.platform ? `｜渠道/平台：**${e.platform}**` : '';
    const ref = e.record_ref ? `｜记录号：\`${e.record_ref}\`` : '';
    return (
      `**${i + 1}. ${e.source_label}**\n` +
      `- 业务/评价日期：**${formatChineseCalendarDate(e.record_date)}**（${e.record_date}）${plat}${ref}\n` +
      `- 命中词：${e.matched_keywords.join('、')}\n` +
      `- 原文摘录：${e.excerpt}`
    );
  });
  const excerpts = `**【原文摘录】**\n\n${blocks.join('\n\n')}`;
  return `${header}\n\n${intro}\n\n${quick}\n\n${excerpts}`;
}

/**
 * 按「单条记录」收集食安命中证据（桌访 / 差评同步表），避免合并全文后无法追溯来源。
 */
async function collectFoodSafetyEvidenceForStore(store, scanYmd) {
  const evidence = [];
  try {
    const tvr = await query(
      `SELECT id, store, date, created_at, feedback, dissatisfaction_dish, unsatisfied_items
       FROM table_visit_records
       WHERE date = $1::date
          OR (date IS NULL AND (timezone('Asia/Shanghai', created_at))::date = $1::date)
       LIMIT 8000`,
      [scanYmd]
    );
    for (const row of tvr.rows || []) {
      if (!visitEntryStoreMatches(String(row.store || '').trim(), store)) continue;
      const text = [row.feedback, row.dissatisfaction_dish, row.unsatisfied_items].filter(Boolean).join('\n');
      const matched = collectFoodSafetyKeywordHits(text);
      if (!matched.length) continue;
      const recordDate = row.date
        ? String(row.date).slice(0, 10)
        : shanghaiYmdFromTs(row.created_at) || scanYmd;
      evidence.push({
        source_kind: 'table_visit',
        source_label: '桌访记录（巡台反馈，非线上差评）',
        record_date: recordDate,
        platform: '',
        record_ref: row.id ? String(row.id) : '',
        matched_keywords: [...new Set(matched)],
        excerpt: buildFoodSafetyTextExcerpt(text, matched)
      });
    }
  } catch (_e) {
    /* ignore */
  }

  try {
    const sc2 = badReviewStoreCond(store);
    const brr = await query(
      `SELECT record_id, created_at, fields
       FROM feishu_generic_records
       WHERE config_key = 'bad_review'
         AND (timezone('Asia/Shanghai', created_at))::date = $${sc2.params.length + 1}::date
         AND ${sc2.sql}`,
      [...sc2.params, scanYmd]
    );
    for (const row of brr.rows || []) {
      const f = row.fields || {};
      const text = [
        f['评价内容'],
        f['差评内容'],
        f['备注'],
        f['差评原因'],
        f['content'],
        f['用户评论']
      ]
        .filter(Boolean)
        .join('\n');
      const matched = collectFoodSafetyKeywordHits(text);
      if (!matched.length) continue;
      const recordDate = pickBadReviewBusinessDate(f, row.created_at) || scanYmd;
      const platform =
        [f['平台'], f['来源'], f['渠道']].filter(Boolean).join(' / ') || '';
      evidence.push({
        source_kind: 'bad_review',
        source_label: '差评报告（飞书「差评」多维表同步）',
        record_date: recordDate,
        platform,
        record_ref: row.record_id ? String(row.record_id) : '',
        matched_keywords: [...new Set(matched)],
        excerpt: buildFoodSafetyTextExcerpt(text, matched)
      });
    }
  } catch (_e) {
    /* ignore */
  }

  return evidence;
}

export async function checkFoodSafety(store, textContent = '') {
  void store;
  const matched = collectFoodSafetyKeywordHits(textContent);

  if (matched.length === 0) {
    return { triggered: false, detail: '未检测到食安关键词' };
  }

  const excerpt = buildFoodSafetyTextExcerpt(textContent, matched, 420);
  const todayYmd = shanghaiTodayYmd();
  const todayZh = formatChineseCalendarDate(todayYmd);
  return {
    triggered: true,
    severity: 'high',
    value: {
      matchedKeywords: matched,
      contentPreview: excerpt,
      source: 'text_probe',
      trigger_calendar_day: todayYmd
    },
    threshold: { high: '任何食安关键词命中' },
    detail:
      `食品安全预警：检测到「${matched.join('、')}」\n\n` +
      `**【数据来源】** ${todayZh}《实时消息/对话核查》（非定时扫描落库；无结构化记录号时请凭原文核对）\n` +
      `**记录显示：**${matched.join('、')}\n\n` +
      `**【原文摘录】**\n${excerpt}`,
    redChannel: true
  };
}

async function commitFoodSafetyTrigger(store, triggerDate, { detail, value }) {
  const brand = await getBrandForStore(store);
  const ins = await query(
    `INSERT INTO anomaly_triggers (anomaly_key, store, brand, severity, trigger_date, trigger_value, threshold_value, assigned_role, notify_target_role)
     VALUES ('food_safety', $1, $2, 'high', $3::date, $4, $5, 'hq_manager', 'store_manager,store_production_manager,hq_manager,admin')
     ON CONFLICT (anomaly_key, store, trigger_date) DO NOTHING
     RETURNING id`,
    [store, brand, triggerDate, JSON.stringify(value), JSON.stringify({ high: '任何食安关键词命中' })]
  );
  if (!(ins.rows && ins.rows.length)) {
    return { skipped: 'duplicate_store_day' };
  }
  logger.error(
    { store, keywords: value.matchedKeywords, triggerDate, evidenceCount: value.evidence?.length || 0 },
    '🚨 FOOD SAFETY ALERT'
  );
  runBiAnomalyNotifyPipeline({
    store,
    brand,
    ruleKey: 'food_safety',
    severity: 'high',
    detail,
    value
  }).catch((e) => logger.warn({ err: e?.message, store }, 'food_safety pipeline failed'));
  return { committed: true };
}

// ─── 统一调度：按频率跑全部规则（客流/订单异常已下线）───
const CHECK_FN_MAP = {
  revenue_achievement: checkRevenueAchievement,
  revenue_achievement_monthly: checkRevenueAchievementMonthly,
  labor_efficiency: checkLaborEfficiency,
  recharge_zero: checkRechargeZero,
  table_visit_product: checkTableVisitProduct,
  table_visit_ratio: checkTableVisitRatio,
  gross_margin: checkGrossMargin,
  bad_review_product: checkBadReviewProduct,
  bad_review_service: checkBadReviewService,
  hongchao_jiuguang_private_room: checkPrivateRoomJiuguang,
  food_safety: null // realtime / 扫描任务
};

/**
 * 运行指定频率的全部异常检测
 * @param {string} frequency - 'daily' | 'weekly' | 'monthly'
 * @param {string[]} stores - 门店列表
 */
export async function runAnomalyChecks(frequency, stores, options = {}) {
  /** Proactive 联调：不跑真实规则，仅返回一条桩数据（需命令行 PROACTIVE_TEST_MODE=true） */
  if (process.env.PROACTIVE_TEST_MODE === 'true') {
    return [
      {
        triggered: true,
        type: 'revenue_drop',
        rule: 'revenue_drop',
        store: '测试门店',
        severity: 'high',
        value: 0.6,
        name: 'PROACTIVE_TEST_MODE stub'
      }
    ];
  }

  const allRules = await getAnomalyRules();
  if (!allRules) return [{ error: 'anomaly_rules config not found in DB' }];

  // 按frequency过滤启用的规则；并以静态 anomaly-rules 为准校正频率（避免 gross_margin 等被错配成 daily）
  const ruleEntries = Object.entries(allRules).filter(([ruleKey, cfg]) => {
    if (!cfg?.enabled) return false;
    if (cfg.frequency !== frequency) return false;
    const canon = canonicalAnomalyFrequency(ruleKey);
    if (canon && canon !== frequency) return false;
    return true;
  });
  const results = [];

  for (const storeRaw of stores) {
    const store = String(storeRaw || '').trim();
    if (!store) continue;
    const brand = await getBrandForStore(store);
    for (const [ruleKey, ruleCfg] of ruleEntries) {
      const checkFn = CHECK_FN_MAP[ruleKey];
      if (!checkFn) continue;

      try {
        const result = await checkFn(store);
        if (result.triggered) {
          let triggerDate;
          if (ruleKey === 'recharge_zero') {
            triggerDate = result.value?.evaluationYmd || result.value?.evaluated_business_day;
            if (!triggerDate) {
              logger.error({ store, ruleKey, value: result.value }, 'recharge_zero: evaluationYmd missing, cannot assign trigger_date');
              results.push({ store, rule: ruleKey, name: ruleCfg.name, ...result, skipped: 'missing_eval_date' });
              continue;
            }
          } else if (ruleKey === 'bad_review_product' || ruleKey === 'bad_review_service') {
            triggerDate = shanghaiTodayYmd();
          } else if (result.value?.weekEnd) {
            triggerDate = result.value.weekEnd;
          } else if (ruleKey === 'revenue_achievement_monthly' || ruleKey === 'gross_margin') {
            triggerDate = shanghaiPrevCalendarMonthBounds().last;
          } else {
            triggerDate = shanghaiTodayYmd();
          }

          if (ruleKey === 'recharge_zero') {
            const todaySh = shanghaiTodayYmd();
            if (triggerDate >= todaySh) {
              logger.error(
                { store, ruleKey, triggerDate, todaySh, evaluationYmd: result.value?.evaluationYmd },
                'recharge_zero: trigger_date >= today (should be yesterday business day), aborting'
              );
              results.push({ store, rule: ruleKey, name: ruleCfg.name, ...result, skipped: 'premature_trigger_date' });
              continue;
            }
          }

          const isDeferred = !!result.deferred;

          // 月维度（毛利率、月营收达成）：同一统计期只正式落库/通知一次，防止错误调度重复派单
          if (
            result.triggered &&
            !isDeferred &&
            (ruleKey === 'gross_margin' || ruleKey === 'revenue_achievement_monthly')
          ) {
            const dupFinal = await query(
              `SELECT 1 FROM anomaly_triggers
               WHERE anomaly_key = $1 AND store = $2 AND trigger_date = $3::date
                 AND COALESCE(status, '') NOT IN ('pending_data', 'superseded')
               LIMIT 1`,
              [ruleKey, store, triggerDate]
            );
            if (dupFinal.rows?.length) {
              results.push({
                store,
                rule: ruleKey,
                name: ruleCfg.name,
                ...result,
                skipped: 'duplicate_period'
              });
              continue;
            }
          }

          if (isDeferred) {
            // 10号前仅落库为 pending_data，避免提前计分/派单；同店同规则同触发日只保留一条
            const dupPending = await query(
              `SELECT 1
               FROM anomaly_triggers
               WHERE anomaly_key = $1
                 AND store = $2
                 AND trigger_date = $3::date
                 AND status = 'pending_data'
               LIMIT 1`,
              [ruleKey, store, triggerDate]
            );
            if (!dupPending.rows?.length) {
              await query(
                `INSERT INTO anomaly_triggers (anomaly_key, store, brand, severity, trigger_date, trigger_value, threshold_value, assigned_role, notify_target_role, status)
                 VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, 'pending_data')
                 ON CONFLICT (anomaly_key, store, trigger_date) DO UPDATE SET
                   brand = EXCLUDED.brand,
                   severity = EXCLUDED.severity,
                   trigger_value = EXCLUDED.trigger_value,
                   threshold_value = EXCLUDED.threshold_value,
                   assigned_role = EXCLUDED.assigned_role,
                   notify_target_role = EXCLUDED.notify_target_role,
                   status = 'pending_data',
                   updated_at = NOW()
                 WHERE anomaly_triggers.status = 'pending_data'`,
                [
                  ruleKey,
                  store,
                  brand,
                  result.severity,
                  triggerDate,
                  JSON.stringify(result.value),
                  JSON.stringify(result.threshold),
                  ruleCfg.assign_to || 'store_manager',
                  ruleCfg.notify_target_role || ruleCfg.assign_to || 'store_manager'
                ]
              );
            }
            results.push({ store, rule: ruleKey, name: ruleCfg.name, ...result, skipped: 'pending_data' });
            continue;
          }

          // Use upsert with unique index (anomaly_key, store, trigger_date) for ALL anomaly types
          const insParams = [
            ruleKey,
            store,
            brand,
            result.severity,
            triggerDate,
            JSON.stringify(result.value),
            JSON.stringify(result.threshold),
            ruleCfg.assign_to || 'store_manager',
            ruleCfg.notify_target_role || ruleCfg.assign_to || 'store_manager'
          ];
          const ins = await query(
            `INSERT INTO anomaly_triggers (anomaly_key, store, brand, severity, trigger_date, trigger_value, threshold_value, assigned_role, notify_target_role)
             VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9)
             ON CONFLICT (anomaly_key, store, trigger_date) DO UPDATE SET
               brand = EXCLUDED.brand,
               severity = EXCLUDED.severity,
               trigger_value = EXCLUDED.trigger_value,
               threshold_value = EXCLUDED.threshold_value,
               assigned_role = EXCLUDED.assigned_role,
               notify_target_role = EXCLUDED.notify_target_role,
               status = CASE
                 WHEN anomaly_triggers.status IN ('pending_data', 'superseded') THEN 'open'
                 ELSE anomaly_triggers.status
               END,
               updated_at = NOW()
             WHERE anomaly_triggers.status IN ('pending_data', 'superseded')
             RETURNING id`,
            insParams
          );
          if (!(ins.rows && ins.rows.length)) {
            results.push({ store, rule: ruleKey, name: ruleCfg.name, ...result, skipped: 'duplicate_day' });
            continue;
          }

          // deferred -> open 的场景：清理同触发日 pending_data，避免一条待数据一条正式并存造成统计混乱
          if (ruleKey === 'gross_margin') {
            await query(
              `UPDATE anomaly_triggers
               SET status = 'superseded', updated_at = NOW()
               WHERE anomaly_key = $1
                 AND store = $2
                 AND trigger_date = $3::date
                 AND status = 'pending_data'`,
              [ruleKey, store, triggerDate]
            ).catch(() => {});
          }
          if (ruleKey === 'recharge_zero') {
            try {
              const { refreshWeeklyRollupAfterRechargeTrigger } = await import('./periodic-scoring.js');
              await refreshWeeklyRollupAfterRechargeTrigger(store, triggerDate);
            } catch (e) {
              logger.warn(
                { err: e?.message, store, triggerDate },
                'recharge_zero: refreshWeeklyRollupAfterRechargeTrigger failed'
              );
            }
          }
          logger.warn({ anomaly: ruleKey, store, severity: result.severity, detail: result.detail }, 'Anomaly triggered');

          // 立刻通知责任人 + 建任务 + Planner + OP 跟进（不再等固定巡检时刻）
          enqueueNotifyJob({
            store,
            brand,
            ruleKey,
            severity: result.severity,
            detail: result.detail,
            value: result.value
          }).catch((e) => logger.warn({ err: e?.message, rule: ruleKey, store }, 'bi anomaly queue enqueue failed'));

          // 触发Agent协作链（营销类异常等）
          enqueueCollabJob({
            ruleKey,
            store,
            severity: result.severity,
            detail: result.detail,
            value: result.value
          }).catch((e) => logger.warn({ err: e?.message, rule: ruleKey, store }, 'collab queue enqueue failed'));
        }
        results.push({ store, rule: ruleKey, name: ruleCfg.name, ...result });
      } catch (err) {
        logger.error({ err, rule: ruleKey, store }, 'Anomaly check failed');
        results.push({ store, rule: ruleKey, name: ruleCfg.name, triggered: false, error: err.message });
        if (ruleKey === 'bad_review_product' || ruleKey === 'bad_review_service') {
          notifyAdminsOnBadReviewCheckFailure(ruleKey, store, err).catch(() => {});
        }
      }
    }
  }

  // Proactive 桥接：由 proactive-runner 定时驱动时可 skip，避免与 runner 内 handleAnomalies 重复执行
  if (!options.skipProactiveBridge) {
    try {
      const bridgeMod = await import('./proactive-v2/anomaly-bridge.js');
      const handleAnomalies = bridgeMod.default?.handleAnomalies ?? bridgeMod.handleAnomalies;
      if (typeof handleAnomalies === 'function') {
        await handleAnomalies(results.filter((r) => r.triggered));
      }
    } catch (err) {
      logger.error({ err: err?.message }, '[Proactive] anomaly bridge error');
    }
  }

  // Chairman: 趋势检测（weekly频率时追加）
  if (frequency === 'weekly') {
    try {
      const { runTrendChecks } = await import('./chairman/trend-rules.js');
      const trendResults = await runTrendChecks(stores);
      for (const t of trendResults) {
        results.push({ ...t, name: t.rule, source: 'chairman_trend' });
      }
      logger.info({ trendCount: trendResults.length }, 'Chairman trend checks done');
    } catch (err) {
      logger.warn({ err: err?.message }, 'Chairman trend checks failed (non-fatal)');
    }
  }

  return results;
}

/**
 * 食安落库 + 通知（可按指定 trigger_date 去重：每店每日最多一条）
 */
export async function checkFoodSafetyFromMessage(store, content, options = {}) {
  const result = await checkFoodSafety(store, content);
  if (!result.triggered) return result;

  const triggerDate = options.triggerDate || shanghaiTodayYmd();
  const value = { ...result.value, source: 'realtime_message' };
  const commit = await commitFoodSafetyTrigger(store, triggerDate, { detail: result.detail, value });
  if (commit.skipped) return { ...result, skipped: commit.skipped };
  return result;
}

/**
 * 每日扫描：昨日桌访文本 + 昨日差评（含外卖/大众）中的食安关键词；与业务「仅大众点评计入差评绩效」规则独立。
 */
export async function runFoodSafetyDailyScan(stores) {
  const yest = addDaysYmdShanghai(shanghaiTodayYmd(), -1);
  let triggered = 0;
  for (const store of stores) {
    const evidence = await collectFoodSafetyEvidenceForStore(store, yest);
    if (!evidence.length) continue;
    const matchedKeywords = [...new Set(evidence.flatMap((e) => e.matched_keywords))];
    const detail = formatFoodSafetyRichDetail(yest, matchedKeywords, evidence);
    const value = {
      matchedKeywords,
      evidence,
      scanDate: yest,
      source: 'daily_scan'
    };
    const commit = await commitFoodSafetyTrigger(store, yest, { detail, value });
    if (commit.committed) triggered++;
  }
  logger.info({ date: yest, stores: stores.length, triggered }, 'food_safety daily scan');
  return { date: yest, triggered };
}
