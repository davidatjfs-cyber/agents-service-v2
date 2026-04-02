/**
 * 异常检测引擎 — 10类异常规则的核心计算逻辑
 * 
 * 每个检测函数返回: { triggered: boolean, severity: 'medium'|'high', value: any, threshold: any, detail: string }
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getAnomalyRules, getSlaConfig, toFeishuStoreName, getBrandForStore as getBrandFromConfig } from './config-service.js';
import { onAnomalyTriggered } from './agent-collaboration.js';

// ─── 工具函数 ───
function getMonthDays(year, month) {
  return new Date(year, month, 0).getDate();
}

function getMonthStart(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

async function getBrandForStore(store) {
  return await getBrandFromConfig(store);
}

// ─── 1. 实收营收异常 ───
export async function checkRevenueAchievement(store) {
  const rules = await getAnomalyRules();
  const ruleConfig = rules?.revenue_achievement;
  if (!ruleConfig?.enabled) return { triggered: false, detail: '规则已禁用' };

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const totalDays = getMonthDays(year, month);
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const yesterdayStr = formatDate(yesterday);
  const monthStart = getMonthStart(now);
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;

  const revR = await query(
    `SELECT COALESCE(SUM(actual_revenue), 0) AS total_rev, COUNT(*) AS days_reported
     FROM daily_reports WHERE store = $1 AND date >= $2 AND date <= $3`,
    [store, monthStart, yesterdayStr]
  );
  const totalRev = parseFloat(revR.rows[0]?.total_rev || 0);
  const daysReported = parseInt(revR.rows[0]?.days_reported || 0);

  const tgtR = await query(
    `SELECT target_revenue FROM revenue_targets
     WHERE lower(regexp_replace(coalesce(store,''), '\\s+', '', 'g'))
           LIKE '%' || lower(regexp_replace($1, '\\s+', '', 'g')) || '%'
     AND period = $2 LIMIT 1`,
    [store, monthKey]
  );
  const monthTarget = parseFloat(tgtR.rows[0]?.target_revenue || 0);
  if (!monthTarget) return { triggered: false, detail: '无月目标数据' };

  const actualRate = totalRev / monthTarget;
  const theoreticalRate = daysReported / totalDays;
  const gap = (theoreticalRate - actualRate) * 100;

  const thresholds = ruleConfig.threshold;
  let severity = null;
  if (gap >= (thresholds.high?.achievement_gap_pct || 15)) severity = 'high';
  else if (gap >= (thresholds.medium?.achievement_gap_pct || 10)) severity = 'medium';

  return {
    triggered: !!severity,
    severity,
    value: { totalRev, actualRate: (actualRate * 100).toFixed(1), theoreticalRate: (theoreticalRate * 100).toFixed(1), gap: gap.toFixed(1) },
    threshold: thresholds,
    detail: severity
      ? `实际达成率${(actualRate*100).toFixed(1)}% vs 理论${(theoreticalRate*100).toFixed(1)}%，差距${gap.toFixed(1)}%`
      : `营收达成正常 (差距${gap.toFixed(1)}%)`
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

  // 本周人效 (过去7天)
  const r = await query(
    `SELECT AVG(efficiency) AS avg_eff, COUNT(*) AS days
     FROM daily_reports WHERE store = $1 AND date >= CURRENT_DATE - 7 AND efficiency > 0`,
    [store]
  );
  const avgEff = parseFloat(r.rows[0]?.avg_eff || 0);
  if (!avgEff) return { triggered: false, detail: '无人效数据' };

  let severity = null;
  if (avgEff < brandThresholds.high.below) severity = 'high';
  else if (avgEff < brandThresholds.medium.below) severity = 'medium';

  return {
    triggered: !!severity,
    severity,
    value: { avgEfficiency: avgEff.toFixed(0), brand },
    threshold: brandThresholds,
    detail: severity
      ? `${brand}人效${avgEff.toFixed(0)}元/人，低于${severity==='high'?brandThresholds.high.below:brandThresholds.medium.below}`
      : `人效正常 ${avgEff.toFixed(0)}元/人`
  };
}

// ─── 3. 充值异常 ───
// ⚠️ daily_reports 目前无 recharge_count/recharge_amount 字段
// 需要在营业日报中新增充值数据输入，或从飞书多维表格获取
export async function checkRechargeZero(store) {
  // 先检查字段是否存在
  try {
    const colCheck = await query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'daily_reports' AND column_name = 'recharge_count' LIMIT 1`
    );
    if (colCheck.rows.length === 0) {
      return { triggered: false, detail: '⚠️ daily_reports缺少recharge_count字段，需新增充值数据输入渠道' };
    }

    const r = await query(
      `SELECT date, COALESCE(recharge_count, 0) AS cnt
       FROM daily_reports WHERE store = $1 AND date >= CURRENT_DATE - 2
       ORDER BY date DESC LIMIT 2`,
      [store]
    );
    const rows = r.rows || [];
    if (rows.length === 0) return { triggered: false, detail: '无充值数据' };

    const todayCnt = parseInt(rows[0]?.cnt || 0);
    const yesterdayCnt = rows.length > 1 ? parseInt(rows[1]?.cnt || 0) : -1;

    let severity = null;
    if (todayCnt === 0 && yesterdayCnt === 0) severity = 'high';
    else if (todayCnt === 0) severity = 'medium';

    return {
      triggered: !!severity,
      severity,
      value: { today: todayCnt, yesterday: yesterdayCnt },
      threshold: { medium: '当日0', high: '连续2日0' },
      detail: severity === 'high' ? '连续2天充值为0' : severity === 'medium' ? '当日充值为0' : '充值正常'
    };
  } catch (err) {
    return { triggered: false, detail: `充值检测异常: ${err.message}` };
  }
}

// ─── 4. 桌访产品异常 ───
export async function checkTableVisitProduct(store) {
  const feishuStore = await toFeishuStoreName(store);
  // 固定7天窗口（不滚动）
  const now = new Date();
  const dayOfMonth = now.getDate();
  const windowStart = Math.floor((dayOfMonth - 1) / 7) * 7 + 1;
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const startDate = `${year}-${String(month).padStart(2, '0')}-${String(windowStart).padStart(2, '0')}`;
  const endDay = Math.min(windowStart + 6, getMonthDays(year, month));
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;

  const r = await query(
    `SELECT fields->>'今天有问题的菜品' AS complaint, COUNT(*) AS cnt
     FROM feishu_generic_records
     WHERE config_key = 'table_visit' AND fields->>'所属门店' = $1
       AND to_timestamp((fields->>'日期')::bigint / 1000)::date >= $2::date
       AND to_timestamp((fields->>'日期')::bigint / 1000)::date <= $3::date
       AND fields->>'今天有问题的菜品' IS NOT NULL
       AND fields->>'今天有问题的菜品' != ''
     GROUP BY fields->>'今天有问题的菜品'
     HAVING COUNT(*) >= 2
     ORDER BY cnt DESC`,
    [feishuStore, startDate, endDate]
  );

  const products = r.rows || [];
  if (products.length === 0) return { triggered: false, detail: '无产品投诉重复' };

  const maxCnt = Math.max(...products.map(p => parseInt(p.cnt)));
  let severity = null;
  if (maxCnt >= 4) severity = 'high';
  else if (maxCnt >= 2) severity = 'medium';

  return {
    triggered: !!severity,
    severity,
    value: { products, window: `${startDate}~${endDate}` },
    threshold: { medium: '同产品>=2次', high: '同产品>=4次' },
    detail: `${products[0]?.complaint}被投诉${maxCnt}次（${startDate}~${endDate}）`
  };
}

// ─── 5. 桌访占比异常 ───
export async function checkTableVisitRatio(store) {
  const feishuStore = await toFeishuStoreName(store);
  // 本周桌访数
  const tvR = await query(
    `SELECT COUNT(*) AS visit_count
     FROM feishu_generic_records
     WHERE config_key = 'table_visit' AND fields->>'所属门店' = $1
       AND to_timestamp((fields->>'日期')::bigint / 1000)::date >= CURRENT_DATE - 7`,
    [feishuStore]
  );
  // 本周堂食订单数
  const drR = await query(
    `SELECT COALESCE(SUM(dine_orders), 0) AS total_orders
     FROM daily_reports WHERE store = $1 AND date >= CURRENT_DATE - 7`,
    [store]
  );
  const visitCount = parseInt(tvR.rows[0]?.visit_count || 0);
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

  // 上月毛利率（每月5号前统计）
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

  const r = await query(
    `SELECT AVG(actual_margin) AS avg_margin
     FROM daily_reports WHERE store = $1 AND date >= $2 AND date <= $3 AND actual_margin > 0`,
    [store, formatDate(lastMonth), formatDate(lastMonthEnd)]
  );
  const avgMargin = parseFloat(r.rows[0]?.avg_margin || 0);
  if (!avgMargin) return { triggered: false, detail: '无毛利率数据（需新增输入渠道）' };

  let severity = null;
  if (avgMargin < brandThresholds.high.below_pct) severity = 'high';
  else if (avgMargin < brandThresholds.medium.below_pct) severity = 'medium';

  return {
    triggered: !!severity,
    severity,
    value: { avgMargin: avgMargin.toFixed(1), brand },
    threshold: brandThresholds,
    detail: severity
      ? `${brand}实收毛利率${avgMargin.toFixed(1)}%，低于${severity==='high'?brandThresholds.high.below_pct:brandThresholds.medium.below_pct}%`
      : `毛利率正常 ${avgMargin.toFixed(1)}%`
  };
}

// ─── 7. 差评报告产品异常 ───
export async function checkBadReviewProduct(store) {
  const feishuStore = await toFeishuStoreName(store);
  const r = await query(
    `SELECT COUNT(*) AS cnt
     FROM feishu_generic_records
     WHERE config_key = 'bad_review' AND fields->>'所属门店' = $1
       AND created_at >= CURRENT_DATE - 7
       AND (fields->>'差评类型' ILIKE '%产品%'
            OR fields->>'差评类型' ILIKE '%出品%'
            OR fields->>'差评类型' ILIKE '%菜品%')`,
    [feishuStore]
  );
  const cnt = parseInt(r.rows[0]?.cnt || 0);
  let severity = null;
  if (cnt >= 2) severity = 'high';
  else if (cnt >= 1) severity = 'medium';

  return {
    triggered: !!severity,
    severity,
    value: { count: cnt },
    threshold: { medium: '>=1条/周', high: '>=2条/周' },
    detail: severity ? `本周产品差评${cnt}条` : '无产品差评'
  };
}

// ─── 8. 差评报告服务异常 ───
export async function checkBadReviewService(store) {
  const feishuStore = await toFeishuStoreName(store);
  // 本周
  const thisWeek = await query(
    `SELECT COUNT(*) AS cnt
     FROM feishu_generic_records
     WHERE config_key = 'bad_review' AND fields->>'所属门店' = $1
       AND created_at >= CURRENT_DATE - 7
       AND (fields->>'差评类型' ILIKE '%服务%')`,
    [feishuStore]
  );
  // 上周（用于2周跨度判断）
  const lastWeek = await query(
    `SELECT COUNT(*) AS cnt
     FROM feishu_generic_records
     WHERE config_key = 'bad_review' AND fields->>'所属门店' = $1
       AND created_at >= CURRENT_DATE - 14 AND created_at < CURRENT_DATE - 7
       AND (fields->>'差评类型' ILIKE '%服务%')`,
    [feishuStore]
  );
  const thisWeekCnt = parseInt(thisWeek.rows[0]?.cnt || 0);
  const lastWeekCnt = parseInt(lastWeek.rows[0]?.cnt || 0);
  const twoWeekTotal = thisWeekCnt + lastWeekCnt;

  // 2周内仅1条不触发
  if (twoWeekTotal <= 1 && thisWeekCnt <= 1) {
    return { triggered: false, detail: `2周内服务差评${twoWeekTotal}条，不触发` };
  }

  let severity = null;
  if (thisWeekCnt >= 2) severity = 'high';
  else if (thisWeekCnt >= 1) severity = 'medium';

  return {
    triggered: !!severity,
    severity,
    value: { thisWeek: thisWeekCnt, lastWeek: lastWeekCnt },
    threshold: { medium: '>=1条/周(且2周>1条)', high: '>=2条/周' },
    detail: severity ? `本周服务差评${thisWeekCnt}条` : '服务差评正常'
  };
}

// ─── 9. 食品安全评价异常 ───
export async function checkFoodSafety(store, textContent = '') {
  const keywords = ['异物', '异味', '不舒服', '拉肚子', '头发', '虫', '变质', '过期', '发霉', '食物中毒', '苍蝇', '蟑螂', '生的', '没熟'];
  const matched = keywords.filter(kw => textContent.includes(kw));

  if (matched.length === 0) {
    return { triggered: false, detail: '未检测到食安关键词' };
  }

  return {
    triggered: true,
    severity: 'high',
    value: { matchedKeywords: matched, content: textContent.slice(0, 200) },
    threshold: { high: '任何食安关键词命中' },
    detail: `食品安全预警：检测到「${matched.join('、')}」`,
    redChannel: true
  };
}

// ─── 10. 客流量/订单数异常 ───
export async function checkTrafficDecline(store) {
  // 本周
  const thisWeek = await query(
    `SELECT COALESCE(SUM(dine_traffic), 0) AS traffic, COALESCE(SUM(dine_orders), 0) AS orders
     FROM daily_reports WHERE store = $1 AND date >= CURRENT_DATE - 7`,
    [store]
  );
  // 上周
  const lastWeek = await query(
    `SELECT COALESCE(SUM(dine_traffic), 0) AS traffic, COALESCE(SUM(dine_orders), 0) AS orders
     FROM daily_reports WHERE store = $1 AND date >= CURRENT_DATE - 14 AND date < CURRENT_DATE - 7`,
    [store]
  );
  const tw = { traffic: parseInt(thisWeek.rows[0]?.traffic || 0), orders: parseInt(thisWeek.rows[0]?.orders || 0) };
  const lw = { traffic: parseInt(lastWeek.rows[0]?.traffic || 0), orders: parseInt(lastWeek.rows[0]?.orders || 0) };

  if (!lw.traffic && !lw.orders) return { triggered: false, detail: '上周无数据' };

  const trafficDecline = lw.traffic ? ((lw.traffic - tw.traffic) / lw.traffic) * 100 : 0;
  const ordersDecline = lw.orders ? ((lw.orders - tw.orders) / lw.orders) * 100 : 0;
  const maxDecline = Math.max(trafficDecline, ordersDecline);

  let severity = null;
  if (maxDecline >= 20) severity = 'high';
  else if (maxDecline >= 10) severity = 'medium';

  return {
    triggered: !!severity,
    severity,
    value: { thisWeek: tw, lastWeek: lw, trafficDecline: trafficDecline.toFixed(1), ordersDecline: ordersDecline.toFixed(1) },
    threshold: { medium: '环比下降>=10%', high: '环比下降>=20%' },
    detail: severity
      ? `客流环比下降${trafficDecline.toFixed(1)}%，订单下降${ordersDecline.toFixed(1)}%`
      : '客流/订单正常'
  };
}

// ─── 统一调度：按频率跑全部规则 ───
const CHECK_FN_MAP = {
  revenue_achievement: checkRevenueAchievement,
  labor_efficiency: checkLaborEfficiency,
  recharge_zero: checkRechargeZero,
  table_visit_product: checkTableVisitProduct,
  table_visit_ratio: checkTableVisitRatio,
  gross_margin: checkGrossMargin,
  bad_review_product: checkBadReviewProduct,
  bad_review_service: checkBadReviewService,
  food_safety: null, // realtime, triggered by message content
  traffic_decline: checkTrafficDecline
};

/**
 * 运行指定频率的全部异常检测
 * @param {string} frequency - 'daily' | 'weekly' | 'monthly'
 * @param {string[]} stores - 门店列表
 */
export async function runAnomalyChecks(frequency, stores) {
  const allRules = await getAnomalyRules();
  if (!allRules) return [{ error: 'anomaly_rules config not found in DB' }];

  // 按frequency过滤启用的规则
  const ruleEntries = Object.entries(allRules).filter(
    ([, cfg]) => cfg.enabled && cfg.frequency === frequency
  );
  const results = [];

  for (const store of stores) {
    const brand = await getBrandForStore(store);
    for (const [ruleKey, ruleCfg] of ruleEntries) {
      const checkFn = CHECK_FN_MAP[ruleKey];
      if (!checkFn) continue;

      try {
        const result = await checkFn(store);
        if (result.triggered) {
          await query(
            `INSERT INTO anomaly_triggers (anomaly_key, store, brand, severity, trigger_date, trigger_value, threshold_value, assigned_role, notify_target_role)
             VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6, $7, $8)`,
            [
              ruleKey, store, brand, result.severity,
              JSON.stringify(result.value), JSON.stringify(result.threshold),
              ruleCfg.assign_to || 'store_manager',
              ruleCfg.assign_to || 'store_manager'
            ]
          );
          logger.warn({ anomaly: ruleKey, store, severity: result.severity, detail: result.detail }, 'Anomaly triggered');
          // 触发Agent协作链
          onAnomalyTriggered(ruleKey, store, result.severity, result.detail, result.value).catch(e =>
            logger.warn({ err: e?.message, rule: ruleKey, store }, 'collab chain err'));
        }
        results.push({ store, rule: ruleKey, name: ruleCfg.name, ...result });
      } catch (err) {
        logger.error({ err, rule: ruleKey, store }, 'Anomaly check failed');
        results.push({ store, rule: ruleKey, name: ruleCfg.name, triggered: false, error: err.message });
      }
    }
  }
  return results;
}

/**
 * 检测食品安全（实时，从消息内容触发）
 */
export async function checkFoodSafetyFromMessage(store, content) {
  const result = await checkFoodSafety(store, content);
  if (result.triggered) {
    const brand = await getBrandForStore(store);
    await query(
      `INSERT INTO anomaly_triggers (anomaly_key, store, brand, severity, trigger_date, trigger_value, threshold_value, assigned_role, notify_target_role)
       VALUES ('food_safety', $1, $2, 'high', CURRENT_DATE, $3, $4, 'hq_manager', 'store_manager,kitchen_manager')`,
      [store, brand, JSON.stringify(result.value), JSON.stringify(result.threshold)]
    );
    logger.error({ store, keywords: result.value.matchedKeywords }, '🚨 FOOD SAFETY ALERT');
  }
  return result;
}
