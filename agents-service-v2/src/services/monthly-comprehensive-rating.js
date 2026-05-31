/**
 * monthly-comprehensive-rating.js
 * 每月10号凌晨01:18（上海时区）执行月度绩效成绩单（与 KPI 01:03、加分 00:30 错开）
 * 
 * 功能：
 * 1. 绩效得分统计（上月 anomaly_rollups_v2 汇总）
 * 2. 工作态度评级（上月备案任务未完成数）
 * 3. 工作执行力评级（上月每日未达成项汇总）
 * 4. 工作能力评级（上月毛利率 + 点评星级）
 * 5. 门店级别（上月营收达成率）
 * 6. 写入 agent_scores (new_model_monthly)
 * 7. 飞书卡片通知个人 + 管理员/总部营运汇总
 */
import { query } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { ensureHrmsUserNotificationsTable } from '../utils/hrms-user-notifications.js';
import { sendCard, sendText } from './feishu-client.js';
import { getShanghaiYmd, sendReportToRecipient } from './report-delivery.js';
import { countFullyCompliantPMDaysInRange, getMajixianMeetingExecutionStatsForStore } from './pm-execution-report-coverage.js';
import {
  isMajixianStore,
  sortFeishuScoringRows,
  resolveMajixianProductionManagersForScoring,
  isMajixianPmObserverUsername
} from '../utils/scoring-assignee.js';
import { expandAgentStoreLabels } from '../config/store-mapping.js';
import { getShanghaiYmdParts } from '../utils/anomaly-week-bounds.js';
import {
  getMonthlyExecutionFilingCount,
  getMonthlyAttitudeFilingCount
} from '../utils/performance-filing-counts.js';
import { getBadReviewRowsForStoreDateRange } from './deterministic-replies.js';
import { resolveStoreManagerAccountable } from './store-duty-bindings.js';

const MONTHLY_RATING_PENDING = '待定';

/** period 形如 YYYY-MM（统计月闭合日，用于与周报一致的「备案」计数） */
function lastYmdOfRatingPeriodYm(periodYm) {
  const parts = String(periodYm || '').split('-');
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (!y || !m || m < 1 || m > 12) return `${String(periodYm || '').slice(0, 7)}-01`;
  const last = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

/** 单店汇总：仅用规范名+飞书别名，避免 `%洪潮%` 把多店企微加总进一家 */
function aggregateIlikePatternsForStoreName(storeLabel) {
  const labs = expandAgentStoreLabels(String(storeLabel || '').trim());
  const uniq = [...new Set(labs.filter(Boolean))];
  if (!uniq.length) return ['%'];
  return uniq.map((lab) => `%${String(lab).replace(/%/g, '')}%`);
}

/** 月度综合里 nnyxcs35 不在主查询 rows 时补 open_id / 姓名 */
async function fetchFeishuStaffRowForUsername(username) {
  const u = String(username || '').trim();
  if (!u) return null;
  try {
    const r = await query(
      `SELECT fu.username,
              COALESCE(NULLIF(TRIM(fu.name), ''), fu.username) AS name,
              fu.role,
              TRIM(fu.store) AS store,
              fu.open_id,
              CASE
                WHEN fu.store ILIKE '%洪潮%' THEN '洪潮'
                WHEN fu.store ILIKE '%马己仙%' THEN '马己仙'
                ELSE '未知'
              END AS brand
       FROM feishu_users fu
       WHERE fu.registered = true AND LOWER(TRIM(fu.username)) = LOWER($1)
       LIMIT 1`,
      [u]
    );
    return r.rows?.[0] || null;
  } catch (_e) {
    return null;
  }
}

// ─────────────────────────────────────────────
// 1. 工具函数
// ─────────────────────────────────────────────

function roleLabelZh(role) {
  switch (role) {
    case 'store_manager': return '店长';
    case 'store_production_manager': return '出品经理';
    default: return role || '';
  }
}

function fmtStoreLevelLabel(level) {
  switch (level) {
    case 'A': return 'A级';
    case 'B': return 'B级';
    case 'C': return 'C级';
    case 'D': return 'D级';
    case MONTHLY_RATING_PENDING:
      return '待定';
    default: return '—';
  }
}

/** 以上海日历的「当前月」算上月，避免服务器 UTC 在月初/月末与业务日错位 */
function getPrevMonthPeriod() {
  const { y, m } = getShanghaiYmdParts();
  let pm = m - 1;
  let py = y;
  if (pm < 1) {
    pm = 12;
    py -= 1;
  }
  return `${py}-${String(pm).padStart(2, '0')}`;
}

function getDaysInMonth(period) {
  const [year, month] = period.split('-');
  return new Date(Number(year), Number(month), 0).getDate();
}

// ─────────────────────────────────────────────
// 2. 绩效得分（周度异常汇总）
// ─────────────────────────────────────────────

async function getMonthlyPerformanceScore(username, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-${String(getDaysInMonth(period)).padStart(2, '0')}`;
  const monthKey = `${year}${month}`;

  const result = await query(
    `SELECT total_score, period
     FROM agent_scores
     WHERE LOWER(TRIM(username)) = LOWER(TRIM($1))
       AND score_model = 'anomaly_rollups_v2'
       AND COALESCE(is_invalidated, false) = false
       AND (store IS NULL OR store !~* '(测试门店|SAFE_TEST|_SAFE_TEST|沙箱|sandbox)')
       AND COALESCE(username,'') NOT LIKE '__periodic%'
       AND LOWER(TRIM(COALESCE(username,''))) <> 'nnyxcs35'
       AND (
         (POSITION('__' IN period) = 0
           AND substring(period from 6 for 10)::date >= $2::date
           AND substring(period from 6 for 10)::date <= $3::date)
         OR
         (POSITION('__' IN period) > 0 AND split_part(period, '__', 2) = $4)
       )
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [username, startDate, endDate, monthKey]
  );

  if (result.rows.length > 0) {
    return Number(result.rows[0].total_score);
  }

  return 100;
}

const EXCEPTION_DEDUCTION_RULES = {
  '总实收毛利率异常': { high: 40, medium: 20, low: 0, frequency: 'monthly' },
};

const LABOR_EFFICIENCY_THRESHOLDS = {
  '洪潮': { high: { below: 1000, points: 20 }, medium: { below: 1100, points: 10 } },
  '马己仙': { high: { below: 1400, points: 20 }, medium: { below: 1500, points: 10 } },
};

function inferBrandFromStore(store) {
  if (/洪潮/.test(store)) return '洪潮';
  return '马己仙';
}

async function getLaborEfficiencyDeduction(store, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-${String(getDaysInMonth(period)).padStart(2, '0')}`;
  const pats = expandAgentStoreLabels(String(store || '').trim());
  const likeConditions = pats.map((_, i) => `store ILIKE ANY($${1}::text[])`).join(' OR ');
  const result = await query(
    `SELECT AVG(efficiency) AS avg_eff FROM daily_reports WHERE store ILIKE ANY($1::text[]) AND date >= $2::date AND date <= $3::date AND efficiency > 0`,
    [pats.map(l => `%${String(l).replace(/%/g, '')}%`), startDate, endDate]
  );
  const avgEff = parseFloat(result.rows[0]?.avg_eff || 0);
  if (!avgEff) return { deduction: 0, severity: null, avgEff: 0 };
  const brand = inferBrandFromStore(store);
  const thresholds = LABOR_EFFICIENCY_THRESHOLDS[brand];
  if (!thresholds) return { deduction: 0, severity: null, avgEff: Math.round(avgEff) };
  if (avgEff < thresholds.high.below) return { deduction: thresholds.high.points, severity: 'high', avgEff: Math.round(avgEff) };
  if (avgEff < thresholds.medium.below) return { deduction: thresholds.medium.points, severity: 'medium', avgEff: Math.round(avgEff) };
  return { deduction: 0, severity: null, avgEff: Math.round(avgEff) };
}

async function getExceptionDeduction(username, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-${String(getDaysInMonth(period)).padStart(2, '0')}`;
  const result = await query(
    `SELECT category, severity, COUNT(*) as count
     FROM agent_issues
     WHERE assignee_username = $1
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= $2::date
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= $3::date
     GROUP BY category, severity`,
    [username, startDate, endDate]
  );
  let totalDeduction = 0;
  for (const row of result.rows) {
    const rule = EXCEPTION_DEDUCTION_RULES[row.category];
    if (!rule) continue;
    const sev = String(row.severity || '').toLowerCase();
    if (sev === 'low') continue;
    const pointsPerTrigger = rule[sev] || 0;
    if (pointsPerTrigger === 0) continue;
    const days = getDaysInMonth(period);
    let maxTriggers = 1;
    if (rule.frequency === 'daily') maxTriggers = days;
    else if (rule.frequency === 'weekly') maxTriggers = Math.ceil(days / 7);
    const actualTriggers = Math.min(Number(row.count), maxTriggers);
    totalDeduction += actualTriggers * pointsPerTrigger;
  }
  return totalDeduction;
}

async function getExceptionBonus(username, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-${String(getDaysInMonth(period)).padStart(2, '0')}`;
  const issueResult = await query(
    `SELECT COUNT(*) as count FROM agent_issues
     WHERE assignee_username = $1
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date >= $2::date
       AND (created_at AT TIME ZONE 'Asia/Shanghai')::date <= $3::date`,
    [username, startDate, endDate]
  );
  const issueCount = Number(issueResult.rows[0]?.count || 0);
  if (issueCount > 0) return 0;
  const weekResult = await query(
    `SELECT deductions
     FROM agent_scores
     WHERE lower(username) = lower($1)
       AND score_model = 'anomaly_rollups_v2'
       AND COALESCE(is_invalidated, false) = false
       AND period LIKE 'week_%'
       AND substring(period from 6 for 10)::date >= $2::date
       AND substring(period from 6 for 10)::date <= $3::date`,
    [username, startDate, endDate]
  );
  for (const row of weekResult.rows || []) {
    let arr = row.deductions;
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (_e) { arr = []; } }
    if (!Array.isArray(arr)) continue;
    if (arr.some(d => Number(d?.points || 0) > 0)) return 0;
  }
  return 10;
}

// ─────────────────────────────────────────────
// 3. 工作态度评级
// ─────────────────────────────────────────────

/**
 * 与 HRMS `new-scoring-model.getIncompleteTaskCount` 一致：仅以 **master_tasks** 且
 * **hr_performance_recorded = true** 的备案为态度统计唯一来源（任务未完成经 HR 备案记入态度）。
 */
async function getAttitudeRating(username, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-${String(getDaysInMonth(period)).padStart(2, '0')}`;

  const sources = ['random_inspection', 'scheduled_inspection', 'bi_anomaly', 'auto_collab', 'data_auditor'];

  const result = await query(
    `SELECT COUNT(DISTINCT task_id)::int AS incomplete_count
     FROM master_tasks
     WHERE LOWER(TRIM(COALESCE(assignee_username, ''))) = LOWER(TRIM($1))
       AND source = ANY($2::text[])
       AND COALESCE(hr_performance_recorded, false) = true
       AND NOT EXISTS (
         SELECT 1 FROM performance_invalidation_records pir
         WHERE pir.source_type = 'master_tasks_filing'
           AND pir.source_id = master_tasks.task_id
       )
       AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date >= $3::date
       AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date <= $4::date`,
    [username, sources, startDate, endDate]
  );

  const incomplete = Number(result.rows[0]?.incomplete_count || 0);

  if (incomplete <= 2) return { rating: 'A', value: incomplete };
  if (incomplete <= 4) return { rating: 'B', value: incomplete };
  if (incomplete <= 8) return { rating: 'C', value: incomplete };
  return { rating: 'D', value: incomplete };
}

// ─────────────────────────────────────────────
// 4. 工作执行力评级（月度汇总）
// ─────────────────────────────────────────────

/**
 * 出品经理执行力（月度）
 * 按业务日逐日判定；每日未完全达标计为 1 次不合格（与 ops_tasks 日频备案一致），月度汇总为「不合格次数」。
 */
async function getPMExecutionRating(store, brand, period) {
  const [year, month] = period.split('-');
  const daysInMonth = getDaysInMonth(period);
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-${String(daysInMonth).padStart(2, '0')}`;

  const brandZh = String(brand || '').includes('马己') ? '马己仙' : String(brand || '').includes('洪') ? '洪潮' : brand;

  const compliantDays = await countFullyCompliantPMDaysInRange(store, brandZh, startDate, endDate);
  const nonCompliantDays = Math.max(0, daysInMonth - compliantDays);

  let rating;
  if (nonCompliantDays <= 2) rating = 'A';
  else if (nonCompliantDays <= 4) rating = 'B';
  else if (nonCompliantDays <= 6) rating = 'C';
  else rating = 'D';

  return {
    rating,
    value: nonCompliantDays,
    detail: {
      days_in_month: daysInMonth,
      compliant_days: compliantDays,
      non_compliant_days: nonCompliantDays,
      /** 与「未达标天数」同值；对外文案统一称「次数」 */
      non_compliant_count: nonCompliantDays
    }
  };
}

/**
 * 洪潮店长执行力（月度）
 * 数据源：daily_reports (new_wechat_members)
 */
async function getHongchaoManagerExecutionRating(store, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-${String(getDaysInMonth(period)).padStart(2, '0')}`;

  const pats = aggregateIlikePatternsForStoreName(store);
  const result = await query(
    `SELECT COALESCE(SUM(new_wechat_members), 0) AS total
     FROM daily_reports
     WHERE date >= $1::date AND date <= $2::date
       AND store ILIKE ANY($3::text[])`,
    [startDate, endDate, pats]
  );

  const totalMembers = Number(result.rows[0]?.total || 0);

  let rating;
  if (totalMembers >= 400) rating = 'A';
  else if (totalMembers >= 349) rating = 'B';
  else if (totalMembers >= 300) rating = 'C';
  else rating = 'D';

  return { rating, value: totalMembers, detail: { total_wechat_members: totalMembers } };
}

/**
 * 马己仙店长执行力（月度）
 * 数据源：agent_messages.meeting_report（飞书例会表经 bitable 轮询写入，与出品/开收档同源）
 */
async function getMajixianManagerExecutionRating(store, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-${String(getDaysInMonth(period)).padStart(2, '0')}`;

  const stats = await getMajixianMeetingExecutionStatsForStore(store, startDate, endDate);
  const totalMeetings = stats.totalMeetings;
  const unqualifiedMeetings = stats.unqualifiedMeetings;
  const daysInMonth = getDaysInMonth(period);
  const missingCount = Math.max(0, daysInMonth - totalMeetings);

  let rating;
  if (missingCount <= 2 && unqualifiedMeetings <= 2) rating = 'A';
  else if (missingCount <= 4 && unqualifiedMeetings <= 4) rating = 'B';
  else if (missingCount <= 6 && unqualifiedMeetings <= 6) rating = 'C';
  else rating = 'D';

  return {
    rating,
    value: missingCount,
    detail: {
      total_meetings: totalMeetings,
      qualified_meetings: stats.qualifiedMeetings,
      unqualified_meetings: unqualifiedMeetings,
      missing_days: missingCount,
      missing_meeting_count: missingCount
    }
  };
}

// ─────────────────────────────────────────────
// 5. 工作能力评级（月度）
// ─────────────────────────────────────────────

/**
 * 出品经理工作能力（月度）
 * 数据源：monthly_margins (实际) + anomaly-rules.js (目标)
 * 毛利率目标从BI异常触发条件中获取：洪潮69%，马己仙64%
 */
async function getPMAbilityRating(store, period) {
  const storeMapping = {
    洪潮大宁久光店: '洪潮久光店',
    马己仙上海音乐广场店: '马己仙大宁店'
  };
  const storeInData = storeMapping[store] || store;
  const storeCandidates = [...new Set([String(store || '').trim(), storeInData].filter(Boolean))];

  let actual = NaN;
  for (const st of storeCandidates) {
    const actualResult = await query(
      `SELECT actual_margin FROM monthly_margins WHERE store = $1 AND period = $2 LIMIT 1`,
      [st, period]
    );
    const v = Number(actualResult.rows[0]?.actual_margin);
    if (Number.isFinite(v)) {
      actual = v;
      break;
    }
  }

  const brandLower = store.includes('洪潮') ? '洪潮' : store.includes('马己仙') ? '马己仙' : null;
  const targetMargin = brandLower === '洪潮' ? 69 : brandLower === '马己仙' ? 64 : null;

  if (!Number.isFinite(actual) || targetMargin == null) {
    return {
      rating: MONTHLY_RATING_PENDING,
      value: null,
      detail: { reason: '无毛利率数据或无法推断目标', actual, target: targetMargin, store: storeInData, period, brand: brandLower }
    };
  }

  const diff = actual - targetMargin;

  let rating;
  if (diff >= 1.01) rating = 'A';
  else if (diff >= -1.0 && diff <= 1.0) rating = 'B';
  else if (diff >= -2.0 && diff <= -1.01) rating = 'C';
  else rating = 'D';

  return { rating, value: diff, detail: { actual_margin: actual, target_margin: targetMargin, diff } };
}

/**
 * 店长工作能力（月度）
 * 数据源：daily_reports (dianping_rating) - 以9号那天的数据为准
 */
async function getManagerAbilityRating(store, period, brand) {
  const [year, month] = period.split('-');
  // 以9号那天的营业日报数据为准
  const targetDate = `${year}-${month}-09`;

  const pats = aggregateIlikePatternsForStoreName(store);
  const result = await query(
    `SELECT dianping_rating FROM daily_reports
     WHERE date = $1::date AND dianping_rating IS NOT NULL
       AND store ILIKE ANY($2::text[])
     LIMIT 1`,
    [targetDate, pats]
  );

  if (!result.rows.length || !result.rows[0].dianping_rating) {
    return { rating: MONTHLY_RATING_PENDING, value: null, detail: { reason: '无点评星级数据', target_date: targetDate } };
  }

  const rating = Number(result.rows[0].dianping_rating);
  const brandKey = brand === '洪潮' ? 'hongchao' : 'majixian';

  const rules = {
    hongchao: { A: 4.6, B: 4.5, C: 4.3 },
    majixian: { A: 4.5, B: 4.4, C: 4.0 }
  };

  const r = rules[brandKey] || rules.hongchao;
  let level;
  if (rating >= r.A) level = 'A';
  else if (rating >= r.B) level = 'B';
  else if (rating >= r.C) level = 'C';
  else level = 'D';

  return { rating: level, value: rating, detail: { dianping_rating: rating, target_date: targetDate, brand: brandKey } };
}

// ─────────────────────────────────────────────
// 6. 门店级别（月度）
// ─────────────────────────────────────────────

async function getStoreRating(store, period) {
  const result = await query(
    `SELECT rating, achievement_rate, actual_revenue, target_revenue
     FROM store_ratings 
     WHERE store ILIKE $1 AND period = $2
     ORDER BY created_at DESC LIMIT 1`,
    [`%${store}%`, period]
  );

  if (result.rows.length) {
    return {
      rating: result.rows[0].rating,
      achievement_rate: Number(result.rows[0].achievement_rate || 0),
      actual_revenue: Number(result.rows[0].actual_revenue || 0),
      target_revenue: Number(result.rows[0].target_revenue || 0)
    };
  }

  // 如果没有 store_ratings 记录，从 daily_reports 计算
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-${String(getDaysInMonth(period)).padStart(2, '0')}`;

  const revenueResult = await query(
    `SELECT COALESCE(SUM(actual_revenue), 0) as actual
     FROM daily_reports 
     WHERE store ILIKE $1 AND date >= $2::date AND date <= $3::date`,
    [`%${store}%`, startDate, endDate]
  );

  const actualRevenue = Number(revenueResult.rows[0]?.actual || 0);

  const targetResult = await query(
    `SELECT target_revenue FROM revenue_targets 
     WHERE period = $1 AND store ILIKE $2
     ORDER BY LENGTH(store) DESC NULLS LAST LIMIT 1`,
    [period, `%${store}%`]
  );

  const targetRevenue = Number(targetResult.rows[0]?.target_revenue || 0);
  const achievementRate = targetRevenue > 0 ? (actualRevenue / targetRevenue * 100) : 0;

  let rating;
  if (achievementRate > 95) rating = 'A';
  else if (achievementRate > 90) rating = 'B';
  else if (achievementRate >= 85) rating = 'C';
  else rating = 'D';

  return { rating, achievement_rate: achievementRate, actual_revenue: actualRevenue, target_revenue: targetRevenue };
}

/**
 * 月度绩效成绩单人选：禁止 DISTINCT ON + username 排序误选马己仙「测试/nnyxcs35」账号；
 * 马己仙出品经理与周度绩效一致，走 resolveMajixianProductionManagersForScoring（黎永荣 NNYXLYR04 优先）。
 */
async function loadMonthlyComprehensiveStaff() {
  const r = await query(
    `SELECT fu.username,
            COALESCE(NULLIF(TRIM(fu.name), ''), fu.username) AS name,
            fu.role,
            TRIM(fu.store) AS store,
            fu.open_id,
            CASE
              WHEN fu.store ILIKE '%洪潮%' THEN '洪潮'
              WHEN fu.store ILIKE '%马己仙%' THEN '马己仙'
              ELSE '未知'
            END AS brand
     FROM feishu_users fu
     WHERE fu.registered = true
       AND fu.role IN ('store_manager', 'store_production_manager')
       AND TRIM(COALESCE(fu.store, '')) <> ''
       AND LOWER(TRIM(fu.username)) <> 'nnyxcs35'
       AND fu.username NOT ILIKE '%测试%'
       AND COALESCE(TRIM(fu.name), '') NOT ILIKE '%测试%'`
  );

  const rows = (r.rows || []).filter((row) => {
    const nm = String(row.name || '');
    if (nm.includes('测试')) return false;
    return true;
  });

  const byStore = new Map();
  for (const row of rows) {
    const st = String(row.store || '').trim();
    if (!st) continue;
    if (!byStore.has(st)) byStore.set(st, { managers: [], pms: [] });
    const b = byStore.get(st);
    if (row.role === 'store_manager') b.managers.push(row);
    else if (row.role === 'store_production_manager') b.pms.push(row);
  }

  // 店长岗无 feishu_users 覆盖时，取「绩效责任人」（执行人≠责任人时归集，如马己仙店长岗绩效记在喻烽名下）
  const allKnownStores = ['洪潮大宁久光店', '马己仙上海音乐广场店'];
  for (const st of allKnownStores) {
    if (!byStore.has(st)) byStore.set(st, { managers: [], pms: [] });
    const b = byStore.get(st);
    if (b.managers.length === 0) {
      const acc = await resolveStoreManagerAccountable(st).catch(() => null);
      if (acc && acc.username) {
        const brand = st.includes('洪潮') ? '洪潮' : st.includes('马己仙') ? '马己仙' : '未知';
        b.managers.push({ username: acc.username, name: acc.name || acc.username, open_id: acc.open_id || '', role: 'store_manager', store: st, brand });
      }
    }
  }

  const staff = [];
  for (const [store, { managers, pms }] of byStore) {
    const sortedSm = sortFeishuScoringRows(store, 'store_manager', managers);
    if (sortedSm[0]) {
      const x = sortedSm[0];
      staff.push({
        username: x.username,
        name: x.name,
        role: 'store_manager',
        store: x.store,
        open_id: x.open_id,
        brand: x.brand
      });
    }

    const brandMj = pms[0]?.brand || managers[0]?.brand || (isMajixianStore(store) ? '马己仙' : '未知');

    if (isMajixianStore(store)) {
      const pmList = await resolveMajixianProductionManagersForScoring(store);
      const canonicalUsername = pmList[0]?.username;
      for (const pm of pmList) {
        let row = rows.find(
          (x) => String(x.username || '').toLowerCase() === String(pm.username || '').toLowerCase()
        );
        if (!row) {
          const fx = await fetchFeishuStaffRowForUsername(pm.username);
          if (fx) row = fx;
        }
        const isObs = isMajixianPmObserverUsername(pm.username);
        const ratingSubjectUsername =
          isObs &&
          canonicalUsername &&
          String(canonicalUsername).trim() &&
          !isMajixianPmObserverUsername(canonicalUsername)
            ? String(canonicalUsername).trim()
            : String(pm.username || '').trim();
        staff.push({
          username: pm.username,
          name: pm.name || row?.name || pm.username,
          role: 'store_production_manager',
          store,
          open_id: row?.open_id ?? null,
          brand: brandMj,
          ratingSubjectUsername
        });
      }
    } else {
      const sortedPm = sortFeishuScoringRows(store, 'store_production_manager', pms);
      if (sortedPm[0]) {
        const x = sortedPm[0];
        staff.push({
          username: x.username,
          name: x.name,
          role: 'store_production_manager',
          store: x.store,
          open_id: x.open_id,
          brand: x.brand
        });
      }
    }
  }

  return staff;
}

// ─────────────────────────────────────────────
// 7. 主函数：月度绩效成绩单
// ─────────────────────────────────────────────

export async function runMonthlyComprehensiveRating(period) {
  try {
    period = period || getPrevMonthPeriod();
    const { y: curY, m: curM } = getShanghaiYmdParts();
    const currentMonth = `${curY}-${String(curM).padStart(2, '0')}`;
    if (period >= currentMonth) {
      logger.warn({ period, currentMonth }, 'monthly comprehensive rating: cannot rate current or future month, aborting');
      return { period, evaluated: 0, results: [], error: 'cannot rate current or future month' };
    }
    logger.info({ period }, 'monthly comprehensive rating: starting');

    const staff = await loadMonthlyComprehensiveStaff();
    if (!staff.length) {
      logger.warn('monthly comprehensive rating: no staff found');
      return { period, evaluated: 0, results: [] };
    }

    const results = [];

    for (const s of staff) {
      const { username, name, role, store, open_id, brand } = s;
      const ratingU = String(s.ratingSubjectUsername || username || '').trim() || username;

      try {
        // 1. 绩效得分（月度最新周 anomaly 分数 + exception bonus - exception deduction - 人效值扣分）
        const latestWeekScore = await getMonthlyPerformanceScore(ratingU, period);
        const exceptionBonus = await getExceptionBonus(ratingU, period);
        const exceptionDeduction = await getExceptionDeduction(ratingU, period);
        const laborEffResult = await getLaborEfficiencyDeduction(store, period);
        const performanceScore = Math.round(latestWeekScore + exceptionBonus - exceptionDeduction - laborEffResult.deduction);

        // 2. 工作态度评级
        const attitudeResult = await getAttitudeRating(ratingU, period);

        // 3. 工作执行力评级
        let executionResult;
        if (role === 'store_production_manager') {
          executionResult = await getPMExecutionRating(store, brand, period);
        } else if (role === 'store_manager') {
          if (brand === '洪潮') {
            executionResult = await getHongchaoManagerExecutionRating(store, period);
          } else {
            executionResult = await getMajixianManagerExecutionRating(store, period);
          }
        }

        // 4. 工作能力评级
        let abilityResult;
        if (role === 'store_production_manager') {
          abilityResult = await getPMAbilityRating(store, period);
        } else {
          abilityResult = await getManagerAbilityRating(store, period, brand);
        }

        // 5. 门店级别
        const storeRatingResult = await getStoreRating(store, period);

        // 6. 写入 agent_scores
        const breakdown = {
          store_rating: storeRatingResult.rating,
          execution_rating: executionResult?.rating || MONTHLY_RATING_PENDING,
          attitude_rating: attitudeResult.rating,
          ability_rating: abilityResult?.rating || MONTHLY_RATING_PENDING
        };

        const executionData = executionResult?.detail || {};
        const attitudeData = { incomplete_tasks: attitudeResult.value };
        const abilityData = abilityResult?.detail || {};

        const periodLastYmd = lastYmdOfRatingPeriodYm(period);
        let filingExecOps = 0;
        let filingAttMt = 0;
        try {
          filingExecOps = await getMonthlyExecutionFilingCount(ratingU, store, periodLastYmd);
          filingAttMt = await getMonthlyAttitudeFilingCount(ratingU, periodLastYmd);
        } catch (_e) {
          /* ignore */
        }

        const summary = `月度绩效成绩单（${period}）：执行力 ${executionResult?.rating || '—'}，态度 ${attitudeResult.rating}，能力 ${abilityResult?.rating || '—'}，门店 ${fmtStoreLevelLabel(storeRatingResult.rating)}。`;

        await query(
          `INSERT INTO agent_scores (brand, store, username, name, role, period, score_model, base_score, total_score, breakdown, deductions, summary)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)
           ON CONFLICT (brand, store, username, period)
           DO UPDATE SET
             name = EXCLUDED.name,
             base_score = EXCLUDED.base_score,
             total_score = EXCLUDED.total_score,
             breakdown = EXCLUDED.breakdown,
             deductions = EXCLUDED.deductions,
             summary = EXCLUDED.summary,
             feishu_notified = FALSE,
             updated_at = NOW()`,
          [
            brand, store, username, name, role, period,
            'new_model_monthly',
            latestWeekScore,
            performanceScore,
            JSON.stringify(breakdown),
            JSON.stringify({ execution_data: executionData, attitude_data: attitudeData, ability_data: abilityData, exception_bonus: exceptionBonus, exception_deduction: exceptionDeduction, labor_efficiency_deduction: laborEffResult.deduction, labor_efficiency_avg: laborEffResult.avgEff, labor_efficiency_severity: laborEffResult.severity }),
            summary
          ]
        );

        await query(
          `INSERT INTO employee_scores (store, brand, username, name, role, period, base_score, exception_bonus, exception_deduction, total_score, execution_rating, attitude_rating, ability_rating)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (store, username, role, period)
           DO UPDATE SET
             brand = EXCLUDED.brand,
             name = EXCLUDED.name,
             base_score = EXCLUDED.base_score,
             exception_bonus = EXCLUDED.exception_bonus,
             exception_deduction = EXCLUDED.exception_deduction,
             total_score = EXCLUDED.total_score,
             execution_rating = EXCLUDED.execution_rating,
             attitude_rating = EXCLUDED.attitude_rating,
             ability_rating = EXCLUDED.ability_rating,
             updated_at = NOW()`,
          [
            store, brand, username, name, role, period,
            latestWeekScore,
            exceptionBonus,
            exceptionDeduction + laborEffResult.deduction,
            performanceScore,
            executionResult?.rating || MONTHLY_RATING_PENDING,
            attitudeResult.rating,
            abilityResult?.rating || MONTHLY_RATING_PENDING
          ]
        );

        results.push({
          username, name, role, store, brand, open_id,
          performance_score: performanceScore,
          execution_rating: executionResult?.rating || MONTHLY_RATING_PENDING,
          attitude_rating: attitudeResult.rating,
          ability_rating: abilityResult?.rating || MONTHLY_RATING_PENDING,
          store_rating: storeRatingResult.rating,
          execution_detail: executionData,
          attitude_detail: attitudeData,
          ability_detail: abilityData,
          labor_efficiency_deduction: laborEffResult.deduction,
          labor_efficiency_severity: laborEffResult.severity,
          labor_efficiency_avg: laborEffResult.avgEff,
          filing_exec_ops: filingExecOps,
          filing_attitude_mt: filingAttMt
        });

        logger.info({ username, store, role, period, breakdown }, 'monthly comprehensive rating: evaluated');

      } catch (e) {
        logger.error({ err: e?.message, username, store, role }, 'monthly comprehensive rating: failed for user');
      }
    }

    // 7. 工作能力月评备案（未达 A：飞书 + HRMS，与执行力日评备案同思路）
    await sendAbilityMonthlyFiling(results, period);

    // 8. 补充数据：包房使用数 + 差评数
    let supplementaryData = {};
    try {
      const { y, m } = getShanghaiYmdParts();
      const endDate = `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
      const prR = await query(
        `SELECT store, SUM(COALESCE(private_room_uses, 0))::int AS total
         FROM daily_reports
         WHERE date >= $1::date AND date <= $2::date AND private_room_uses IS NOT NULL
         GROUP BY store`,
        [`${period}-01`, endDate]
      );
      const prMap = {};
      let prTotal = 0;
      for (const row of prR.rows || []) {
        prMap[row.store] = Number(row.total) || 0;
        prTotal += Number(row.total) || 0;
      }
      supplementaryData.privateRoomUses = prMap;
      supplementaryData.privateRoomUsesTotal = prTotal;
    } catch (e) { logger.warn({ err: e?.message }, 'monthly private_room_uses query failed'); }

    try {
      const stores = [...new Set(results.map(r => r.store).filter(Boolean))];
      const periodEnd = `${period}-${String(getDaysInMonth(period)).padStart(2, '0')}`;
      const brMap = {};
      let brTotal = 0;
      for (const store of stores) {
        const rows = await getBadReviewRowsForStoreDateRange(store, `${period}-01`, periodEnd);
        brMap[store] = rows.length;
        brTotal += rows.length;
      }
      supplementaryData.badReviews = brMap;
      supplementaryData.badReviewsTotal = brTotal;
    } catch (e) { logger.warn({ err: e?.message }, 'monthly bad_review query failed'); }

    // 9. 发送飞书通知（月度绩效成绩单卡）
    await sendMonthlyRatingNotifications(results, period, supplementaryData);

    logger.info({ period, evaluated: results.length }, 'monthly comprehensive rating: completed');
    return { period, evaluated: results.length, results };

  } catch (e) {
    logger.error({ err: e?.message }, 'monthly comprehensive rating: failed');
    throw e;
  }
}

// ─────────────────────────────────────────────
// 8. 工作能力月评备案（飞书 + HRMS）
// ─────────────────────────────────────────────

function formatAbilityDetailMarkdown(r) {
  const d = r.ability_detail || {};
  if (r.role === 'store_production_manager') {
    if (d.reason && String(d.reason).includes('无毛利率')) {
      return `• ${d.reason || '无毛利率数据'}`;
    }
    const diff = d.diff != null && typeof d.diff === 'number' ? d.diff.toFixed(2) : d.diff;
    return `• 实际毛利率 **${d.actual_margin}%** / 目标 **${d.target_margin}%**（差 ${diff}）`;
  }
  if (d.reason === '无点评星级数据') {
    return `• ${d.reason || '无点评星级数据'}`;
  }
  return `• 大众点评星级 **${d.dianping_rating}**（营业日报日期 **${d.target_date}**）`;
}

function buildAbilityMonthlyFilingCard(r, period) {
  const roleLabel = roleLabelZh(r.role);
  const ar = r.ability_rating || '—';
  const ratingColor =
    ar === 'A'
      ? 'green'
      : ar === 'B'
        ? 'blue'
        : ar === 'C'
          ? 'orange'
          : ar === 'D'
            ? 'red'
            : ar === MONTHLY_RATING_PENDING
              ? 'blue'
              : 'blue';
  const detailMd = formatAbilityDetailMarkdown(r);

  const content = `**备案类型**：工作能力月评
**门店**：${r.store}
**岗位**：${roleLabel} · ${r.name || r.username}
**统计月**：${period}（上月自然月）
**工作能力评级**：**${ar}** 级

**明细**
${detailMd}`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📋 工作能力月评备案 · ${period}` },
      template: ratingColor
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content:
              '数据来源：monthly_margins / daily_reports（店长取当月9号点评星级）· 与月度绩效成绩单同批触发'
          }
        ]
      }
    ]
  };
}

function buildAbilityMonthlyAdminSummaryCard(allResults, period) {
  let md = `**统计月**：${period}\n**备案人数**：${allResults.length}（全员留痕）\n\n**备案明细**\n`;
  for (const r of allResults) {
    const roleLabel = roleLabelZh(r.role);
    md += `\n• **${r.store}** · ${roleLabel} ${r.name || r.username}：**${r.ability_rating}** 级`;
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📋 工作能力月评备案汇总 · ${period}` },
      template: 'blue'
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: md } },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: '全员工作能力月评备案（含 A 级）· 与月度绩效成绩单同批触发' }]
      }
    ]
  };
}

async function sendAbilityMonthlyFiling(results, period) {
  if (!results.length) {
    logger.info({ period }, 'ability monthly filing: no staff');
    return 0;
  }

  await ensureHrmsUserNotificationsTable();
  let sent = 0;
  let failed = 0;
  const runYmd = getShanghaiYmd();

  for (const r of results) {
    const card = buildAbilityMonthlyFilingCard(r, period);
    const roleLabel = roleLabelZh(r.role);
    const detailText = formatAbilityDetailMarkdown(r).replace(/\*\*/g, '');

    if (r.open_id) {
      try {
        const deliver = await sendReportToRecipient({
          jobKey: 'monthly_comprehensive_rating',
          runYmd,
          username: r.username || r.open_id,
          scope: 'ability_individual',
          sendFn: async () => {
            const res = await sendCard(r.open_id, card, 'open_id');
            return { ok: !!res?.ok, error: res?.error || '' };
          }
        });
        if (deliver?.ok && !deliver?.skipped) sent++;
        if (!deliver?.ok) failed++;
      } catch (e) {
        failed++;
        logger.warn({ err: e?.message, u: r.username }, 'ability filing feishu failed');
      }
    }

    try {
      await query(
        `INSERT INTO hrms_user_notifications (target_username, title, message, type, meta)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          r.username,
          '工作能力月评备案',
          `统计月 ${period}，工作能力评级为 ${r.ability_rating} 级。\n门店：${r.store}\n岗位：${roleLabel} · ${r.name || r.username}\n${detailText}`,
          'ability_rating_monthly',
          JSON.stringify({
            period,
            ability_rating: r.ability_rating,
            ability_detail: r.ability_detail,
            store: r.store,
            role: r.role
          })
        ]
      );
      sent++;
    } catch (e) {
      logger.warn({ err: e?.message, u: r.username }, 'ability filing hrms failed');
    }
  }

  const adminRecipients = await query(
    `SELECT open_id, username FROM feishu_users
     WHERE registered = true AND open_id IS NOT NULL
       AND role IN ('admin', 'hq_manager') AND open_id NOT LIKE '%probe%'`
  );
  const summaryCard = buildAbilityMonthlyAdminSummaryCard(results, period);
  for (const rec of adminRecipients.rows || []) {
    try {
      const deliver = await sendReportToRecipient({
        jobKey: 'monthly_comprehensive_rating',
        runYmd,
        username: rec.username || rec.open_id,
        scope: 'ability_admin_summary',
        sendFn: async () => {
          const res = await sendCard(rec.open_id, summaryCard, 'open_id');
          return { ok: !!res?.ok, error: res?.error || '' };
        }
      });
      if (deliver?.ok && !deliver?.skipped) sent++;
      if (!deliver?.ok) failed++;
    } catch (e) {
      failed++;
      logger.warn({ err: e?.message, u: rec.username }, 'ability filing admin card failed');
    }
  }

  logger.info({ period, filingCount: results.length }, 'ability monthly filing done');
  if (failed > 0) throw new Error(`ability monthly filing has ${failed} failed recipients`);
  return sent;
}

// ─────────────────────────────────────────────
// 9. 飞书通知（月度绩效成绩单）
// ─────────────────────────────────────────────

async function sendMonthlyRatingNotifications(results, period, supplementaryData = {}) {
  let sentCount = 0;
  let failedCount = 0;
  const runYmd = getShanghaiYmd();

  // 1. 工作态度HRMS备案通知（逐人单独写入，含本月累计次数）
  await ensureHrmsUserNotificationsTable();
  for (const r of results) {
    const attitudeCount = r.attitude_detail?.incomplete_tasks ?? 0;
    const roleLabel = roleLabelZh(r.role);
    if (attitudeCount > 0) {
      try {
        const dup = await query(
          `SELECT 1 FROM hrms_user_notifications
           WHERE lower(trim(target_username)) = lower(trim($1))
             AND type = 'attitude_rating_monthly'
             AND (meta->>'period') = $2
             AND (meta->>'store') = $3
           LIMIT 1`,
          [r.username, period, String(r.store || '')]
        );
        if (!dup.rows?.length) {
          await query(
            `INSERT INTO hrms_user_notifications (target_username, title, message, type, meta)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [
              r.username,
              `工作态度备案｜${r.name || r.username}（${r.username}）·${period}月·本人${attitudeCount}次`,
              [
                `【工作态度备案】${period} 月度`,
                `门店：${r.store}`,
                `岗位：${roleLabel} · ${r.name || r.username}（账号 **${r.username}**）`,
                `**本人**本月（${period}）工作态度备案累计：**${attitudeCount}** 次（与系统月度评级同一 SQL：仅计该账号名下 master_tasks 已备案任务，全门店去重；不含他人）`,
                `态度评级：${r.attitude_rating} 级（≤2次A / ≤4次B / ≤8次C / >8次D）`
              ].join('\n'),
              'attitude_rating_monthly',
              JSON.stringify({
                period,
                attitude_rating: r.attitude_rating,
                monthly_attitude_count: attitudeCount,
                store: r.store,
                role: r.role
              })
            ]
          );
        }
      } catch (e) {
        logger.warn({ err: e?.message, u: r.username }, 'attitude filing hrms notification failed');
      }
    }
  }

  // 2. 个人月度绩效成绩单飞书通知（含执行力和态度累计次数）
  for (const r of results) {
    const card = buildMonthlyRatingCard(r, period);
    if (r.open_id) {
      try {
        const deliver = await sendReportToRecipient({
          jobKey: 'monthly_comprehensive_rating',
          runYmd,
          username: r.username || r.open_id,
          scope: 'monthly_individual',
          sendFn: async () => {
            const res = await sendCard(r.open_id, card, 'open_id');
            if (res?.ok) return { ok: true };
            const textRes = await sendText(r.open_id, buildMonthlyRatingText(r, period), 'open_id');
            return { ok: !!textRes?.ok, error: textRes?.error || res?.error || '' };
          }
        });
        if (deliver?.ok && !deliver?.skipped) {
          sentCount++;
          logger.info({ recipient: r.username }, 'monthly rating card sent to individual');
        } else if (!deliver?.ok) {
          failedCount++;
        }
      } catch (e) {
        failedCount++;
        logger.warn({ err: e?.message, recipient: r.username }, 'monthly rating card send failed');
      }
    }
  }

  // 3. 汇总通知给管理员和总部营运
  const adminRecipients = await query(
    `SELECT open_id, username, role FROM feishu_users 
     WHERE registered = true AND open_id IS NOT NULL AND open_id != ''
     AND role IN ('admin', 'hq_manager') AND open_id NOT LIKE '%probe%'`
  );

  if (adminRecipients.rows.length > 0 && results.length > 0) {
    const summaryCard = buildMonthlySummaryCard(results, period, supplementaryData);
    for (const recipient of adminRecipients.rows) {
      try {
        const deliver = await sendReportToRecipient({
          jobKey: 'monthly_comprehensive_rating',
          runYmd,
          username: recipient.username || recipient.open_id,
          scope: 'monthly_admin_summary',
          sendFn: async () => {
            const res = await sendCard(recipient.open_id, summaryCard, 'open_id');
            if (res?.ok) return { ok: true };
            const textRes = await sendText(recipient.open_id, buildMonthlySummaryText(results, period, supplementaryData), 'open_id');
            return { ok: !!textRes?.ok, error: textRes?.error || res?.error || '' };
          }
        });
        if (deliver?.ok && !deliver?.skipped) {
          sentCount++;
          logger.info({ recipient: recipient.username, role: recipient.role }, 'monthly summary card sent to admin');
        } else if (!deliver?.ok) {
          failedCount++;
        }
      } catch (e) {
        failedCount++;
        logger.warn({ err: e?.message, recipient: recipient.username }, 'monthly summary card send failed');
      }
    }
  }

  // 3. 标记已通知
  if (results.length > 0) {
    await query(
      `UPDATE agent_scores SET feishu_notified = TRUE
       WHERE period = $1 AND score_model = 'new_model_monthly'`,
      [period]
    ).catch(() => {});
  }

  if (failedCount > 0) {
    throw new Error(`monthly comprehensive rating has ${failedCount} failed recipients`);
  }
  return sentCount;
}

function buildMonthlyRatingCard(r, period) {
  const roleLabel = roleLabelZh(r.role);
  const execCount =
    r.execution_detail?.non_compliant_count ??
    r.execution_detail?.missing_meeting_count ??
    r.execution_detail?.non_compliant_days ??
    r.execution_detail?.missing_days ??
    r.execution_detail?.value ??
    '—';
  const attitudeCount = r.attitude_detail?.incomplete_tasks ?? '—';
  const filingEx = Number(r.filing_exec_ops);
  const filingAt = Number(r.filing_attitude_mt);
  const filingExecLine = Number.isFinite(filingEx) ? filingEx : 0;
  const filingAttLine = Number.isFinite(filingAt) ? filingAt : 0;

  const execLine = r.role === 'store_production_manager'
    ? `• 执行力：**${r.execution_rating}级**（本月不合格 **${execCount}** 次 | ≤2次A / ≤4次B / ≤6次C / >6次D）`
    : `• 执行力：**${r.execution_rating}级**（本月不合格 **${execCount}** 次）`;

  const content = `**门店**：${r.store}
**岗位**：${roleLabel} · ${r.name || r.username}
**统计月**：${period}

**绩效得分**：**${r.performance_score}** 分

**本月累计备案**（与周报同源，统计至 ${period} 月末）
• 工作执行力：**${filingExecLine}** 次
• 工作态度：**${filingAttLine}** 次

**核心评级**
${execLine}
• 工作态度：**${r.attitude_rating}级**（**本人**本月工作态度备案 **${attitudeCount}** 次 | ≤2次A / ≤4次B / ≤8次C / >8次D）
• 工作能力：**${r.ability_rating}级**
• 门店级别：${fmtStoreLevelLabel(r.store_rating)}`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📊 ${period} 月度绩效成绩单` },
      template: 'blue'
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '数据来源：周度异常汇总 + 每日执行力备案 + 月度毛利率/点评 · 每月10号01:18自动生成' }] }
    ]
  };
}

function buildMonthlyRatingText(r, period) {
  const roleLabel = roleLabelZh(r.role);
  const execCount =
    r.execution_detail?.non_compliant_count ??
    r.execution_detail?.missing_meeting_count ??
    r.execution_detail?.non_compliant_days ??
    r.execution_detail?.missing_days ??
    '—';
  const attitudeCount = r.attitude_detail?.incomplete_tasks ?? '—';
  const fe = Number.isFinite(Number(r.filing_exec_ops)) ? Number(r.filing_exec_ops) : 0;
  const fa = Number.isFinite(Number(r.filing_attitude_mt)) ? Number(r.filing_attitude_mt) : 0;
  return `${period} 月度绩效成绩单

${r.store} · ${roleLabel} ${r.name || r.username}

绩效得分：${r.performance_score}分
本月累计备案：工作执行力${fe}次，工作态度${fa}次
执行力：${r.execution_rating}级（本月不合格${execCount}次）
工作态度：${r.attitude_rating}级（本人本月工作态度备案${attitudeCount}次）
工作能力：${r.ability_rating}级
门店级别：${fmtStoreLevelLabel(r.store_rating)}`;
}

function buildMonthlySummaryCard(results, period, supplementaryData = {}) {
  const lines = results.map(r => {
    const roleLabel = roleLabelZh(r.role);
    const execCount =
      r.execution_detail?.non_compliant_count ??
      r.execution_detail?.missing_meeting_count ??
      r.execution_detail?.non_compliant_days ??
      r.execution_detail?.missing_days ??
      '—';
    const attCount = r.attitude_detail?.incomplete_tasks ?? '—';
    const fe = Number.isFinite(Number(r.filing_exec_ops)) ? Number(r.filing_exec_ops) : 0;
    const fa = Number.isFinite(Number(r.filing_attitude_mt)) ? Number(r.filing_attitude_mt) : 0;
    return `• **${r.store}** · ${roleLabel} ${r.name || r.username}：${r.performance_score}分 | 执行${r.execution_rating}(${execCount}次) 态度${r.attitude_rating}(${attCount}次) 能力${r.ability_rating} 门店${r.store_rating} | 备案执${fe}/态${fa}`;
  });

  let content = `**${period} 月度绩效成绩单汇总**\n\n${lines.join('\n')}`;

  const sd = supplementaryData || {};
  if (sd.privateRoomUses && Object.keys(sd.privateRoomUses).length) {
    content += '\n\n**🏠 包房使用（上月）**\n';
    for (const [store, cnt] of Object.entries(sd.privateRoomUses)) {
      content += `  ${store}: ${cnt}次\n`;
    }
    content += `  **合计: ${sd.privateRoomUsesTotal || 0}次**`;
  }
  if (sd.badReviews && Object.keys(sd.badReviews).length) {
    content += '\n\n**💬 差评数（上月）**\n';
    for (const [store, cnt] of Object.entries(sd.badReviews)) {
      content += `  ${store}: ${cnt}条\n`;
    }
    content += `  **合计: ${sd.badReviewsTotal || 0}条**`;
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📊 ${period} 月度绩效成绩单汇总` },
      template: 'blue'
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '数据来源：周度异常汇总 + 每日执行力备案 + 月度毛利率/点评 + 包房使用 + 差评 · 每月10号01:18自动生成' }] }
    ]
  };
}

function buildMonthlySummaryText(results, period, supplementaryData = {}) {
  const lines = results.map(r => {
    const roleLabel = roleLabelZh(r.role);
    const execCount =
      r.execution_detail?.non_compliant_count ??
      r.execution_detail?.missing_meeting_count ??
      r.execution_detail?.non_compliant_days ??
      r.execution_detail?.missing_days ??
      '—';
    const attCount = r.attitude_detail?.incomplete_tasks ?? '—';
    return `• ${r.store} · ${roleLabel} ${r.name || r.username}：${r.performance_score}分 | 执行${r.execution_rating}(${execCount}次) 态度${r.attitude_rating}(${attCount}次) 能力${r.ability_rating} 门店${r.store_rating}`;
  });

  let text = `${period} 月度绩效成绩单汇总\n\n${lines.join('\n')}`;

  const sd = supplementaryData || {};
  if (sd.privateRoomUses && Object.keys(sd.privateRoomUses).length) {
    text += '\n\n包房使用（上月）:';
    for (const [store, cnt] of Object.entries(sd.privateRoomUses)) {
      text += `\n  ${store}: ${cnt}次`;
    }
    text += `\n  合计: ${sd.privateRoomUsesTotal || 0}次`;
  }
  if (sd.badReviews && Object.keys(sd.badReviews).length) {
    text += '\n\n差评数（上月）:';
    for (const [store, cnt] of Object.entries(sd.badReviews)) {
      text += `\n  ${store}: ${cnt}条`;
    }
    text += `\n  合计: ${sd.badReviewsTotal || 0}条`;
  }

  return text;
}
