/**
 * monthly-comprehensive-rating.js
 * 每月10号凌晨01:18（上海时区）执行月度综合评级（与 KPI 01:03、加分 00:30 错开）
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
import {
  countDistinctOpeningBizDays,
  countDistinctClosingBizDays,
  countDistinctMaterialBizDays
} from './pm-execution-report-coverage.js';
import {
  isMajixianStore,
  sortFeishuScoringRows,
  resolveMajixianProductionManagersForScoring
} from '../utils/scoring-assignee.js';

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
    default: return '—';
  }
}

function getPrevMonthPeriod() {
  const now = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const year = prevMonth.getFullYear();
  const month = String(prevMonth.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
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
  const endDate = `${year}-${month}-31`;

  const result = await query(
    `SELECT COALESCE(SUM(total_score), 0) as total,
            COUNT(*) as week_count
     FROM agent_scores
     WHERE username = $1
       AND score_model = 'anomaly_rollups_v2'
       AND substring(period from 6 for 10)::date >= $2::date
       AND substring(period from 6 for 10)::date <= $3::date`,
    [username, startDate, endDate]
  );

  const total = Number(result.rows[0]?.total || 0);
  const weekCount = Number(result.rows[0]?.week_count || 0);

  // 满分100，按周汇总后取平均
  return weekCount > 0 ? Math.round(total / weekCount) : 100;
}

// ─────────────────────────────────────────────
// 3. 工作态度评级
// ─────────────────────────────────────────────

async function getAttitudeRating(username, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-31`;

  const sources = ['random_inspection', 'scheduled_inspection', 'bi_anomaly', 'auto_collab', 'data_auditor'];

  const result = await query(
    `SELECT COUNT(DISTINCT id)::int as incomplete_count
     FROM ops_tasks
     WHERE assignee_username = $1
       AND source = ANY($2::text[])
       AND status IN ('pending_response', 'pending_review', 'pending_dispatch', 'dispatched', 'overdue')
       AND created_at >= $3::date
       AND created_at <= $4::date`,
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
 * 数据源：开档/收档 agent_messages + 原料 feishu_generic_records；均按表内业务日期统计（与执行力日评/聊天一致）
 */
async function getPMExecutionRating(store, brand, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-31`;

  const daysInMonth = getDaysInMonth(period);
  const expectedTotal = daysInMonth * 3;

  const brandZh = String(brand || '').includes('马己') ? '马己仙' : String(brand || '').includes('洪') ? '洪潮' : brand;

  const [openingCount, closingCount, materialCount] = await Promise.all([
    countDistinctOpeningBizDays(store, startDate, endDate),
    countDistinctClosingBizDays(store, startDate, endDate),
    countDistinctMaterialBizDays(store, brandZh, startDate, endDate)
  ]);

  const totalSubmitted = openingCount + closingCount + materialCount;
  const totalMissing = Math.max(0, expectedTotal - totalSubmitted);

  let rating;
  if (totalMissing <= 6) rating = 'A';
  else if (totalMissing <= 13) rating = 'B';
  else if (totalMissing <= 20) rating = 'C';
  else rating = 'D';

  return {
    rating,
    value: totalMissing,
    detail: {
      opening_days: openingCount,
      closing_days: closingCount,
      material_days: materialCount,
      expected_days: daysInMonth,
      total_missing: totalMissing
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
  const endDate = `${year}-${month}-31`;

  const result = await query(
    `SELECT COALESCE(SUM(new_wechat_members), 0) AS total
     FROM daily_reports
     WHERE TRIM(store) = TRIM($1::text) AND date >= $2::date AND date <= $3::date`,
    [store, startDate, endDate]
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
 * 数据源：feishu_generic_records (meeting_reports)
 */
async function getMajixianManagerExecutionRating(store, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-31`;

  const result = await query(
    `SELECT COUNT(*)::int as total_meetings,
            COUNT(*) FILTER (WHERE (fields->>'得分')::int >= 7) as qualified_meetings,
            COUNT(*) FILTER (WHERE (fields->>'得分')::int < 7 OR (fields->>'得分')::int IS NULL OR (fields->>'得分') = '0') as unqualified_meetings
     FROM feishu_generic_records 
     WHERE config_key = 'meeting_reports'
       AND created_at >= $1::date AND created_at <= $2::date`,
    [startDate, endDate]
  );

  const totalMeetings = Number(result.rows[0]?.total_meetings || 0);
  const unqualifiedMeetings = Number(result.rows[0]?.unqualified_meetings || 0);
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
      qualified_meetings: result.rows[0]?.qualified_meetings || 0,
      unqualified_meetings: unqualifiedMeetings,
      missing_days: missingCount
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
    '洪潮大宁久光店': '洪潮久光店',
    '马己仙上海音乐广场店': '马己仙大宁店'
  };
  const storeInData = storeMapping[store] || store;

  // 实际毛利率（从 monthly_margins）
  const actualResult = await query(
    `SELECT actual_margin FROM monthly_margins 
     WHERE store = $1 AND period = $2
     LIMIT 1`,
    [storeInData, period]
  );

  const actual = Number(actualResult.rows[0]?.actual_margin || null);

  // 目标毛利率（从BI异常触发条件：洪潮69%，马己仙64%）
  const brandLower = store.includes('洪潮') ? '洪潮' : store.includes('马己仙') ? '马己仙' : null;
  const targetMargin = brandLower === '洪潮' ? 69 : brandLower === '马己仙' ? 64 : null;

  if (!actual || !targetMargin) {
    return { rating: 'C', value: null, detail: { reason: '无毛利率数据', actual, target: targetMargin, store: storeInData, period, brand: brandLower } };
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

  const result = await query(
    `SELECT dianping_rating FROM daily_reports 
     WHERE store ILIKE $1 AND date = $2::date AND dianping_rating IS NOT NULL
     LIMIT 1`,
    [`%${store}%`, targetDate]
  );

  if (!result.rows.length || !result.rows[0].dianping_rating) {
    return { rating: 'C', value: null, detail: { reason: '无点评星级数据', target_date: targetDate } };
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
  const endDate = `${year}-${month}-31`;

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
 * 月度综合评级人选：禁止 DISTINCT ON + username 排序误选马己仙「测试/nnyxcs35」账号；
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
      for (const pm of pmList) {
        const row = rows.find((x) => String(x.username || '').toLowerCase() === String(pm.username || '').toLowerCase());
        staff.push({
          username: pm.username,
          name: pm.name || row?.name || pm.username,
          role: 'store_production_manager',
          store,
          open_id: row?.open_id ?? null,
          brand: brandMj
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
// 7. 主函数：月度综合评级
// ─────────────────────────────────────────────

export async function runMonthlyComprehensiveRating(period) {
  try {
    period = period || getPrevMonthPeriod();
    logger.info({ period }, 'monthly comprehensive rating: starting');

    const staff = await loadMonthlyComprehensiveStaff();
    if (!staff.length) {
      logger.warn('monthly comprehensive rating: no staff found');
      return { period, evaluated: 0, results: [] };
    }

    const results = [];

    for (const s of staff) {
      const { username, name, role, store, open_id, brand } = s;

      try {
        // 1. 绩效得分
        const performanceScore = await getMonthlyPerformanceScore(username, period);

        // 2. 工作态度评级
        const attitudeResult = await getAttitudeRating(username, period);

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
          execution_rating: executionResult?.rating || 'C',
          attitude_rating: attitudeResult.rating,
          ability_rating: abilityResult?.rating || 'C'
        };

        const executionData = executionResult?.detail || {};
        const attitudeData = { incomplete_tasks: attitudeResult.value };
        const abilityData = abilityResult?.detail || {};

        const summary = `月度综合评级（${period}）：执行力 ${executionResult?.rating || '—'}，态度 ${attitudeResult.rating}，能力 ${abilityResult?.rating || '—'}，门店 ${fmtStoreLevelLabel(storeRatingResult.rating)}。`;

        await query(
          `INSERT INTO agent_scores (brand, store, username, name, role, period, score_model, total_score, breakdown, deductions, summary)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)
           ON CONFLICT (brand, store, username, period)
           DO UPDATE SET
             name = EXCLUDED.name,
             total_score = EXCLUDED.total_score,
             breakdown = EXCLUDED.breakdown,
             deductions = EXCLUDED.deductions,
             summary = EXCLUDED.summary,
             feishu_notified = FALSE,
             updated_at = NOW()`,
          [
            brand, store, username, name, role, period,
            'new_model_monthly',
            performanceScore,
            JSON.stringify(breakdown),
            JSON.stringify({ execution_data: executionData, attitude_data: attitudeData, ability_data: abilityData }),
            summary
          ]
        );

        results.push({
          username, name, role, store, brand, open_id,
          performance_score: performanceScore,
          execution_rating: executionResult?.rating || 'C',
          attitude_rating: attitudeResult.rating,
          ability_rating: abilityResult?.rating || 'C',
          store_rating: storeRatingResult.rating,
          execution_detail: executionData,
          attitude_detail: attitudeData,
          ability_detail: abilityData
        });

        logger.info({ username, store, role, period, breakdown }, 'monthly comprehensive rating: evaluated');

      } catch (e) {
        logger.error({ err: e?.message, username, store, role }, 'monthly comprehensive rating: failed for user');
      }
    }

    // 7. 工作能力月评备案（未达 A：飞书 + HRMS，与执行力日评备案同思路）
    await sendAbilityMonthlyFiling(results, period);

    // 8. 发送飞书通知（月度综合评级卡）
    await sendMonthlyRatingNotifications(results, period);

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
    if (d.reason === '无毛利率数据') {
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
    ar === 'A' ? 'green' : ar === 'B' ? 'blue' : ar === 'C' ? 'orange' : ar === 'D' ? 'red' : 'blue';
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
              '数据来源：monthly_margins / daily_reports（店长取当月9号点评星级）· 与月度综合评级同批触发'
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
        elements: [{ tag: 'plain_text', content: '全员工作能力月评备案（含 A 级）· 与月度综合评级同批触发' }]
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
       AND role IN ('admin', 'hq_manager')`
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
// 9. 飞书通知（月度综合评级）
// ─────────────────────────────────────────────

async function sendMonthlyRatingNotifications(results, period) {
  let sentCount = 0;
  let failedCount = 0;
  const runYmd = getShanghaiYmd();

  // 1. 个人通知
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

  // 2. 汇总通知给管理员和总部营运
  const adminRecipients = await query(
    `SELECT open_id, username, role FROM feishu_users 
     WHERE registered = true AND open_id IS NOT NULL AND open_id != ''
     AND role IN ('admin', 'hq_manager')`
  );

  if (adminRecipients.rows.length > 0 && results.length > 0) {
    const summaryCard = buildMonthlySummaryCard(results, period);
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
            const textRes = await sendText(recipient.open_id, buildMonthlySummaryText(results, period), 'open_id');
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
  const content = `**门店**：${r.store}
**岗位**：${roleLabel} · ${r.name || r.username}
**周期**：${period}

**绩效得分**：**${r.performance_score}** 分

**核心评级**
• 执行力：${r.execution_rating}级
• 工作态度：${r.attitude_rating}级
• 工作能力：${r.ability_rating}级
• 门店级别：${fmtStoreLevelLabel(r.store_rating)}`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📊 ${period} 月度综合评级` },
      template: 'blue'
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '数据来源：周度异常汇总 + 每日执行力 + 月度毛利率/点评 · 每月10号01:18自动生成' }] }
    ]
  };
}

function buildMonthlyRatingText(r, period) {
  const roleLabel = roleLabelZh(r.role);
  return `${period} 月度综合评级

${r.store} · ${roleLabel} ${r.name || r.username}

绩效得分：${r.performance_score}分
执行力：${r.execution_rating}级
工作态度：${r.attitude_rating}级
工作能力：${r.ability_rating}级
门店级别：${fmtStoreLevelLabel(r.store_rating)}`;
}

function buildMonthlySummaryCard(results, period) {
  const lines = results.map(r => {
    const roleLabel = roleLabelZh(r.role);
    return `• **${r.store}** · ${roleLabel} ${r.name || r.username}：${r.performance_score}分 | 执行${r.execution_rating} 态度${r.attitude_rating} 能力${r.ability_rating} 门店${r.store_rating}`;
  });

  const content = `**${period} 月度综合评级汇总**

${lines.join('\n')}`;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `📊 ${period} 月度评级汇总` },
      template: 'blue'
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '数据来源：周度异常汇总 + 每日执行力 + 月度毛利率/点评 · 每月10号01:18自动生成' }] }
    ]
  };
}

function buildMonthlySummaryText(results, period) {
  const lines = results.map(r => {
    const roleLabel = roleLabelZh(r.role);
    return `• ${r.store} · ${roleLabel} ${r.name || r.username}：${r.performance_score}分 | 执行${r.execution_rating} 态度${r.attitude_rating} 能力${r.ability_rating} 门店${r.store_rating}`;
  });

  return `${period} 月度综合评级汇总

${lines.join('\n')}`;
}
