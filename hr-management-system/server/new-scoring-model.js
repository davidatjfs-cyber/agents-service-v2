/**
 * 新评分模型
 * 包含门店评级和员工评分
 */

import { pool } from './utils/database.js';
import { inferBrandFromStoreName } from './agents.js';
import { safeExecute, safeErrorLog } from './utils/error-handler.js';
import {
  dailyReportIlikePatterns,
  feishuStoreSearchPatterns,
  resolveAgentCanonicalStore
} from './v2-store-alignment.js';

/** 评分用门店匹配：合并日报口径 + 飞书/目标表常见简称（洪潮目标行常为「洪潮久光」等，仅 daily 模式会漏） */
function scoringStoreMatchPatterns(storeLabel) {
  const s = String(storeLabel || '').trim();
  if (!s) return ['%'];
  return [...new Set([...dailyReportIlikePatterns(s), ...feishuStoreSearchPatterns(s)])];
}

// ─────────────────────────────────────────────
// 1. 门店评级模型配置
// ─────────────────────────────────────────────
export const STORE_RATING_CONFIG = {
  name: '门店评级模型',
  type: 'store_rating',
  period: 'monthly', // 按月评级
  rules: {
    'A': { min_rate: 95.01, description: '达成率>95%' },
    'B': { min_rate: 90.01, max_rate: 95.00, description: '达成率>90%' },
    'C': { min_rate: 85.00, max_rate: 90.00, description: '达成率>=85%' },
    'D': { max_rate: 85.00, description: '达成率<85%' }
  },
  data_sources: {
    actual_revenue: 'daily_reports',
    target_revenue: 'revenue_targets'
  },
  new_store_grace_period: 1 // 第一个月不评级
};

// 奖金配置
export const BONUS_CONFIG = {
  '马己仙': { base: 1500 },
  '洪潮': { base: 2000 },
  // 门店A/B级：奖金 = 得分/100 * base
  // 门店C级：奖金归0
  // 门店D级：工资8折
};

// ─────────────────────────────────────────────
// 2. 员工评分模型配置
// ─────────────────────────────────────────────
export const EMPLOYEE_SCORE_CONFIG = {
  name: '员工评分模型',
  type: 'employee_score',
  period: 'monthly', // 按月评分
  base_score: 100,
  scoring: {
    base_score: 100,
    exception_bonus: '零异常加分',
    exception_deduction: '异常扣分'
  },
  execution_rules: {
    store_production_manager: {
      // 马己仙和洪潮出品经理相同：收档报告+开档报告+原料收货日报，每天各提交1次
      data_sources: ['收档报告DB', '开档报告', '原料收货日报'],
      expected_frequency: 'daily',
      rating_thresholds: {
        'A': { max_missing: 6 },  // <7次得A
        'B': { max_missing: 13 }, // <14次得B
        'C': { max_missing: 20 }, // <21次得C
        'D': { min_missing: 21 }  // >=21次得D
      }
    },
    store_manager: {
      // 按品牌区分
      '马己仙': {
        data_sources: ['例会报告'],
        expected_frequency: 'daily',
        score_threshold: 7,
        // 未提交次数和得分低于7分次数同时满足
        rating_thresholds: {
          'A': { max_missing: 2, max_low_score: 2 },
          'B': { max_missing: 4, max_low_score: 4 },
          'C': { max_missing: 6, max_low_score: 6 },
          'D': { default: true }
        }
      },
      '洪潮': {
        data_sources: ['企微会员'],
        // 企微会员每月新增数量
        rating_thresholds: {
          'A': { min_new_members: 300 },
          'B': { min_new_members: 249 },
          'C': { min_new_members: 200 },
          'D': { default: true }
        }
      }
    }
  },
  attitude_rules: {
    data_source: 'master_tasks',
    reminder_count: 3,
    rating_thresholds: {
      'A': { max_incomplete: 2 },
      'B': { max_incomplete: 4 },
      'C': { default: true }
    }
  },
  ability_rules: {
    store_production_manager: {
      // 不分品牌，基于实际毛利率与目标的差值
      data_source: 'monthly_margins',
      rating_thresholds: {
        'A': { min_diff: 1.01 },    // 实际>目标+1个点
        'B': { min_diff: -1.00, max_diff: 1.00 }, // 目标±1个点以内
        'C': { min_diff: -2.00, max_diff: -1.01 }, // 少于1个点以上
        'D': { max_diff: -2.00 }    // 少于2个点及以上
      }
    },
    store_manager: {
      // 基于大众点评星级，按品牌区分
      data_source: 'daily_reports',
      rating_thresholds: {
        '洪潮': {
          'A': { min_rating: 4.6 },
          'B': { min_rating: 4.5 },
          'C': { min_rating: 4.3 },
          'D': { max_rating: 4.3 }
        },
        '马己仙': {
          'A': { min_rating: 4.5 },
          'B': { min_rating: 4.4 },
          'C': { min_rating: 4.0 },
          'D': { max_rating: 4.0 }
        }
      }
    }
  }
};

const DEFAULT_EMPLOYEE_RATING_CONFIG = {
  levelLabels: { A: 'A', B: 'B', C: 'C', D: 'D' },
  execution: {
    store_production_manager: { A_max_missing: 6, B_max_missing: 13, C_max_missing: 20, D_min_missing: 21 },
    store_manager: {
      hongchao: { A_min_new_members: 300, B_min_new_members: 249, C_min_new_members: 200, D_max_new_members: 199 },
      majixian: { low_score_threshold: 7, A_max_missing: 2, A_max_low_score: 2, B_max_missing: 4, B_max_low_score: 4, C_max_missing: 6, C_max_low_score: 6, D_min_missing: 7, D_min_low_score: 7 }
    }
  },
  attitude: { A_max_incomplete: 2, B_max_incomplete: 4, C_max_incomplete: 8 },
  ability: {
    store_production_manager: { A_min_diff: 1.01, B_min_diff: -1, B_max_diff: 1, C_min_diff: -2, C_max_diff: -1.01, D_max_diff: -2 },
    store_manager: {
      hongchao: { A_min_rating: 4.6, B_min_rating: 4.5, C_min_rating: 4.3, D_max_rating: 4.2 },
      majixian: { A_min_rating: 4.5, B_min_rating: 4.4, C_min_rating: 4.0, D_max_rating: 3.9 }
    }
  }
};

async function getRuntimeEmployeeRatingConfig() {
  try {
    const r = await pool().query(
      `select config from hr_rating_configs where config_key = 'employee_rating' and enabled = true limit 1`
    );
    const cfg = r.rows?.[0]?.config;
    return cfg && typeof cfg === 'object' ? cfg : DEFAULT_EMPLOYEE_RATING_CONFIG;
  } catch (_) {
    return DEFAULT_EMPLOYEE_RATING_CONFIG;
  }
}

// ─────────────────────────────────────────────
// 3. 门店评级计算函数
// ─────────────────────────────────────────────
export async function calculateStoreRating(store, brand, period) {
  try {
    const canon = String(resolveAgentCanonicalStore(String(store || '').trim()) || String(store || '').trim()).trim();
    if (!canon) {
      return { rating: null, reason: '门店名为空' };
    }
    const brandUse = String(brand || '').trim() || inferBrandFromStoreName(canon);

    // 1. 新门店原规则：第一个月不评级
    // 为满足 4/1 起正式执行时「门店评级必须能显示」，这里不再早退。
    // （仍保留 checkIfNewStore 供后续扩展/审计使用）
    await checkIfNewStore(canon, period);
    
    // 2. 获取实际营业额（从daily_reports汇总）
    const actualRevenue = await getMonthlyActualRevenue(canon, period);
    
    // 3. 获取目标营业额（从revenue_targets；门店名多种写法 + 按品牌回退）
    let targetRevenue = await getMonthlyTargetRevenue(canon, period);
    if (!targetRevenue || targetRevenue <= 0) {
      targetRevenue = await getMonthlyTargetRevenueByBrand(brandUse, period, canon);
    }
    
    if (!targetRevenue || targetRevenue <= 0) {
      return { rating: null, reason: '目标营业额未设置或为0' };
    }
    
    // 4. 计算达成率
    const achievementRate = Number((actualRevenue / targetRevenue * 100).toFixed(2));
    
    // 5. 确定评级
    let rating = 'D';
    if (achievementRate > 95) rating = 'A';
    else if (achievementRate > 90) rating = 'B';
    else if (achievementRate >= 85) rating = 'C';
    
    // 6. 保存结果（统一规范门店名，避免飞书简称与日报全称各写一行导致「我的档案」读不到）
    await saveStoreRating(canon, brandUse, period, actualRevenue, targetRevenue, achievementRate, rating);
    
    return { rating, achievementRate, actualRevenue, targetRevenue };
    
  } catch (error) {
    console.error('[store_rating] 计算失败:', error);
    return { rating: null, reason: error.message };
  }
}

// ─────────────────────────────────────────────
// 4. 员工评分计算函数
// ─────────────────────────────────────────────
export async function calculateEmployeeScore(store, username, role, period) {
  try {
    // 1. 基础得分计算
    const baseScore = 100;
    const exceptionBonus = await calculateExceptionBonus(username, period);
    const exceptionDeduction = await calculateExceptionDeduction(username, period);
    // 满分100：异常加分/扣分计算结果可能会超出100，这里做上限保护，避免前端/文案出现“满分100却打到110”的困惑
    const totalScore = Math.min(100, Math.max(0, baseScore + exceptionBonus - exceptionDeduction));
    
    // 2. 执行力评级（数据不足时返回NULL）
    let executionRating = null;
    try {
      executionRating = await calculateExecutionRating(store, username, role, period);
    } catch (e) { console.warn('[employee_score] execution rating error:', e?.message); }
    
    // 3. 工作态度评级（数据不足时返回NULL）
    let attitudeRating = null;
    try {
      attitudeRating = await calculateAttitudeRating(username, period);
    } catch (e) { console.warn('[employee_score] attitude rating error:', e?.message); }
    
    // 4. 工作能力评级（数据不足时返回NULL）
    let abilityRating = null;
    try {
      abilityRating = await calculateAbilityRating(store, username, role, period);
    } catch (e) { console.warn('[employee_score] ability rating error:', e?.message); }
    
    // 5. 保存结果
    try {
      await saveEmployeeScore(store, username, role, period, {
        base_score: baseScore,
        exception_bonus: exceptionBonus,
        exception_deduction: exceptionDeduction,
        total_score: totalScore,
        execution_rating: executionRating,
        attitude_rating: attitudeRating,
        ability_rating: abilityRating
      });
    } catch (e) { console.warn('[employee_score] save error:', e?.message); }
    
    return {
      total_score: totalScore,
      execution_rating: executionRating,
      attitude_rating: attitudeRating,
      ability_rating: abilityRating
    };
    
  } catch (error) {
    console.error('[employee_score] 计算失败:', error);
    // 返回NULL评级表示数据不足
    return {
      total_score: 100,
      execution_rating: null,
      attitude_rating: null,
      ability_rating: null
    };
  }
}

// ─────────────────────────────────────────────
// 5. 执行力评级计算
// ─────────────────────────────────────────────
export async function calculateExecutionRating(store, username, role, period) {
  try {
    const cfg = await getRuntimeEmployeeRatingConfig();
    if (role === 'store_production_manager') {
      // 出品经理：检查3种申报报表的提交情况
      const openingReports = await getKitchenReportsCount(store, period, 'opening');
      const closingReports = await getKitchenReportsCount(store, period, 'closing');
      const receivingReports = await getMaterialReceivingReportsCount(store, period);
      
      const expectedDays = getDaysInPeriod(period); // 30天或31天
      const totalExpected = expectedDays * 3; // 每天3种报告
      const totalSubmitted = openingReports + closingReports + receivingReports;
      const totalMissing = totalExpected - totalSubmitted;
      const t = cfg?.execution?.store_production_manager || DEFAULT_EMPLOYEE_RATING_CONFIG.execution.store_production_manager;
      
      // 根据缺提交次数确定评级
      if (totalMissing <= Number(t.A_max_missing)) return 'A';
      else if (totalMissing <= Number(t.B_max_missing)) return 'B';
      else if (totalMissing <= Number(t.C_max_missing)) return 'C';
      else return 'D';
    }
    
    if (role === 'store_manager') {
      const brand = inferBrandFromStoreName(store);
      
      if (brand === '洪潮') {
        // 洪潮店长：企微会员每月新增数量
        const newMembers = await getMonthlyNewWechatMembers(store, period);
        const t = cfg?.execution?.store_manager?.hongchao || DEFAULT_EMPLOYEE_RATING_CONFIG.execution.store_manager.hongchao;
        if (newMembers >= Number(t.A_min_new_members)) return 'A';
        else if (newMembers >= Number(t.B_min_new_members)) return 'B';
        else if (newMembers >= Number(t.C_min_new_members)) return 'C';
        else return 'D';
      } else {
        // 马己仙店长：例会报告每天提交1次且得分>=7分
        const meetingReports = await getStoreMeetingReports(store, period);
        const expectedDays = getDaysInPeriod(period);
        const submittedCount = meetingReports.filter(r => r.submitted).length;
        const totalMissing = expectedDays - submittedCount;
        const t = cfg?.execution?.store_manager?.majixian || DEFAULT_EMPLOYEE_RATING_CONFIG.execution.store_manager.majixian;
        const lowScoreCount = meetingReports.filter(r => r.submitted && r.meeting_score < Number(t.low_score_threshold)).length;
        
        if (totalMissing <= Number(t.A_max_missing) && lowScoreCount <= Number(t.A_max_low_score)) return 'A';
        else if (totalMissing <= Number(t.B_max_missing) && lowScoreCount <= Number(t.B_max_low_score)) return 'B';
        else if (totalMissing <= Number(t.C_max_missing) && lowScoreCount <= Number(t.C_max_low_score)) return 'C';
        else return 'D';
      }
    }
    
    return 'C'; // 默认评级
    
  } catch (error) {
    console.error('[execution_rating] 计算失败:', error);
    return 'C';
  }
}

// ─────────────────────────────────────────────
// 6. 工作态度评级计算
// ─────────────────────────────────────────────
export async function calculateAttitudeRating(username, period) {
  try {
    const cfg = await getRuntimeEmployeeRatingConfig();
    const t = cfg?.attitude || DEFAULT_EMPLOYEE_RATING_CONFIG.attitude;
    // 获取该用户在period期间未完成的agent任务次数
    const incompleteCount = await getIncompleteTaskCount(username, period);
    
    // 根据未完成任务次数确定评级
    if (incompleteCount <= Number(t.A_max_incomplete)) return 'A';
    else if (incompleteCount <= Number(t.B_max_incomplete)) return 'B';
    else if (incompleteCount <= Number(t.C_max_incomplete ?? 8)) return 'C';
    else return 'D';
    
  } catch (error) {
    console.error('[attitude_rating] 计算失败:', error);
    return 'D';
  }
}

// ─────────────────────────────────────────────
// 7. 工作能力评级计算
// ─────────────────────────────────────────────
export async function calculateAbilityRating(store, username, role, period) {
  try {
    const cfg = await getRuntimeEmployeeRatingConfig();
    if (role === 'store_production_manager') {
      // 出品经理：基于毛利率
      const marginData = await getMarginData(store, period);
      if (!marginData.actual_margin || !marginData.target_margin) {
        return 'C'; // 默认评级
      }
      
      const diff = marginData.actual_margin - marginData.target_margin;
      const t = cfg?.ability?.store_production_manager || DEFAULT_EMPLOYEE_RATING_CONFIG.ability.store_production_manager;
      
      if (diff >= Number(t.A_min_diff)) return 'A';
      else if (diff >= Number(t.B_min_diff) && diff <= Number(t.B_max_diff)) return 'B';
      else if (diff >= Number(t.C_min_diff) && diff <= Number(t.C_max_diff)) return 'C';
      else return 'D';
    }
    
    if (role === 'store_manager') {
      // 店长：基于大众点评星级
      const rating = await getMonthlyDianpingRating(store, period);
      const brand = inferBrandFromStoreName(store);
      
      if (!rating) return 'C';

      const key = brand === '洪潮' ? 'hongchao' : 'majixian';
      const rules = cfg?.ability?.store_manager?.[key] || DEFAULT_EMPLOYEE_RATING_CONFIG.ability.store_manager[key];
      if (!rules) return 'C';
      
      if (rating >= Number(rules.A_min_rating)) return 'A';
      else if (rating >= Number(rules.B_min_rating)) return 'B';
      else if (rating >= Number(rules.C_min_rating)) return 'C';
      else return 'D';
    }
    
    return 'C'; // 默认评级
    
  } catch (error) {
    console.error('[ability_rating] 计算失败:', error);
    return 'C';
  }
}

// ─────────────────────────────────────────────
// 8. 辅助函数
// ─────────────────────────────────────────────

// 检查是否为新门店
async function checkIfNewStore(store, period) {
  // 旧逻辑：仅依赖 store_ratings 是否已有更早月份记录。
  // 但如果历史 store_ratings 表未回填/未生成，会把“实际有经营数据的老门店”误判为新门店，从而导致本月 store_rating 空值。
  // 新逻辑：检查 daily_reports 在该月开始日期之前是否已有数据。
  const [year, month] = String(period || '').split('-');
  if (!year || !month) return true;
  const startDate = `${year}-${month}-01`;
  const pats = scoringStoreMatchPatterns(store);
  const result = await pool().query(
    `SELECT COUNT(*)::int AS count
     FROM daily_reports
     WHERE date < $1::date
       AND store ILIKE ANY($2::text[])`,
    [startDate, pats]
  );

  return Number(result.rows[0]?.count || 0) === 0;
}

// 获取月度实际营业额
async function getMonthlyActualRevenue(store, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-31`;
  const pats = scoringStoreMatchPatterns(store);

  const result = await pool().query(`
    SELECT COALESCE(SUM(actual_revenue), 0) as total_revenue
    FROM daily_reports 
    WHERE date >= $1 AND date <= $2
      AND store ILIKE ANY($3::text[])
  `, [startDate, endDate, pats]);
  
  return Number(result.rows[0]?.total_revenue || 0);
}

// 获取月度目标营业额
async function getMonthlyTargetRevenue(store, period) {
  const pats = scoringStoreMatchPatterns(store);
  const result = await pool().query(`
    SELECT target_revenue FROM revenue_targets 
    WHERE period = $1 AND store ILIKE ANY($2::text[])
    ORDER BY LENGTH(store) DESC NULLS LAST
    LIMIT 1
  `, [period, pats]);
  
  return Number(result.rows[0]?.target_revenue || 0);
}

/** revenue_targets 仅按品牌维护一行或简称与规范店名不一致时的兜底 */
async function getMonthlyTargetRevenueByBrand(brand, period, canonStore) {
  const b = String(brand || '').trim();
  if (!b) return 0;
  const needle = String(canonStore || '').replace(/%/g, '').trim();
  const r = await pool().query(
    `SELECT target_revenue, store FROM revenue_targets
     WHERE period = $1 AND brand = $2
     ORDER BY
       CASE WHEN $3 <> '' AND store ILIKE '%' || $3 || '%' THEN 0 ELSE 1 END,
       LENGTH(store) DESC NULLS LAST
     LIMIT 1`,
    [period, b, needle]
  );
  return Number(r.rows[0]?.target_revenue || 0);
}

// 保存门店评级
async function saveStoreRating(store, brand, period, actualRevenue, targetRevenue, achievementRate, rating) {
  await pool().query(`
    INSERT INTO store_ratings 
    (store, brand, period, actual_revenue, target_revenue, achievement_rate, rating)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (store, brand, period)
    DO UPDATE SET 
      actual_revenue = EXCLUDED.actual_revenue,
      target_revenue = EXCLUDED.target_revenue,
      achievement_rate = EXCLUDED.achievement_rate,
      rating = EXCLUDED.rating
  `, [store, brand, period, actualRevenue, targetRevenue, achievementRate, rating]);
}

// 保存员工评分
async function saveEmployeeScore(store, username, role, period, scoreData) {
  await pool().query(`
    INSERT INTO employee_scores 
    (store, brand, username, name, role, period, base_score, exception_bonus, exception_deduction, 
     total_score, execution_rating, attitude_rating, ability_rating, execution_data, attitude_data, ability_data)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    ON CONFLICT (store, username, role, period)
    DO UPDATE SET 
      base_score = EXCLUDED.base_score,
      exception_bonus = EXCLUDED.exception_bonus,
      exception_deduction = EXCLUDED.exception_deduction,
      total_score = EXCLUDED.total_score,
      execution_rating = EXCLUDED.execution_rating,
      attitude_rating = EXCLUDED.attitude_rating,
      ability_rating = EXCLUDED.ability_rating,
      execution_data = EXCLUDED.execution_data,
      attitude_data = EXCLUDED.attitude_data,
      ability_data = EXCLUDED.ability_data,
      updated_at = NOW()
  `, [
    store, inferBrandFromStoreName(store), username, null, role, period,
    scoreData.base_score, scoreData.exception_bonus, scoreData.exception_deduction,
    scoreData.total_score, scoreData.execution_rating, scoreData.attitude_rating, scoreData.ability_rating,
    JSON.stringify(scoreData.execution_data || {}), JSON.stringify(scoreData.attitude_data || {}), JSON.stringify(scoreData.ability_data || {})
  ]);
}

// 获取厨房报告数量
async function getKitchenReportsCount(store, period, reportType) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-31`;
  
  const result = await pool().query(`
    SELECT COUNT(*) as count FROM kitchen_reports 
    WHERE store = $1 AND report_date >= $2 AND report_date <= $3 AND report_type = $4
  `, [store, startDate, endDate, reportType]);
  
  return Number(result.rows[0]?.count || 0);
}

// 获取原料收货报告数量
async function getMaterialReceivingReportsCount(store, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-31`;
  
  const result = await pool().query(`
    SELECT COUNT(*) as count FROM material_receiving_reports 
    WHERE store = $1 AND report_date >= $2 AND report_date <= $3
  `, [store, startDate, endDate]);
  
  return Number(result.rows[0]?.count || 0);
}

// 获取门店例会报告
async function getStoreMeetingReports(store, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-31`;
  
  const result = await pool().query(`
    SELECT submitted, meeting_score FROM store_meeting_reports 
    WHERE store = $1 AND meeting_date >= $2 AND meeting_date <= $3
  `, [store, startDate, endDate]);
  
  return result.rows;
}

/**
 * 当月「工作态度」关联任务备案数（与 agents-service-v2 催办/审核链路一致）：
 * master_tasks 中 assignee 命中、来源含抽检/定时/BI 任务卡/数据审计/协作，且已打标 hr_performance_recorded
 *（满 3 次催办仍未闭环、或审核 3 次不通过等；催办路径不向 agent_scores 扣分，仅态度统计）。
 */
async function getIncompleteTaskCount(username, period) {
  const un = String(username || '').trim();
  if (!un) return 0;
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-31`;
  const sources = ['random_inspection', 'scheduled_inspection', 'bi_anomaly', 'auto_collab', 'data_auditor'];
  try {
    const result = await pool().query(
      `SELECT COUNT(DISTINCT task_id)::int AS c
       FROM master_tasks
       WHERE LOWER(TRIM(COALESCE(assignee_username, ''))) = LOWER(TRIM($1))
         AND source = ANY($2::text[])
         AND COALESCE(hr_performance_recorded, false) = true
         AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date >= $3::date
         AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date <= $4::date`,
      [un, sources, startDate, endDate]
    );
    return Number(result.rows[0]?.c || 0);
  } catch (e) {
    safeErrorLog('[attitude] getIncompleteTaskCount', e);
    return 0;
  }
}

// 获取毛利率数据
async function getMarginData(store, period) {
  const result = await pool().query(`
    SELECT actual_margin, target_margin 
    FROM monthly_margins m
    LEFT JOIN margin_targets t ON m.store = t.store AND m.period = t.period
    WHERE m.store = $1 AND m.period = $2
  `, [store, period]);
  
  return result.rows[0] || { actual_margin: null, target_margin: null };
}

// 获取大众点评星级
async function getMonthlyDianpingRating(store, period) {
  const [year, month] = period.split('-');
  // 获取该月最后一天
  const lastDay = new Date(year, month, 0).getDate();
  const lastDate = `${year}-${month}-${lastDay.toString().padStart(2, '0')}`;
  
  const result = await pool().query(`
    SELECT dianping_rating FROM daily_reports 
    WHERE store = $1 AND date = $2 AND dianping_rating IS NOT NULL
    LIMIT 1
  `, [store, lastDate]);
  
  return Number(result.rows[0]?.dianping_rating) || null;
}

// 获取时间段天数
function getDaysInPeriod(period) {
  const [year, month] = period.split('-');
  return new Date(year, month, 0).getDate();
}

function periodDateRange(period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-${String(getDaysInPeriod(period)).padStart(2, '0')}`;
  return { startDate, endDate };
}

function parseJsonArrayMaybe(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const j = JSON.parse(v);
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }
  return [];
}

// 计算零异常加分
async function calculateExceptionBonus(username, period) {
  // 检查该用户在period期间是否有异常
  const result = await pool().query(`
    SELECT COUNT(*) as count FROM agent_issues 
    WHERE assignee_username = $1 AND created_at >= $2 AND created_at <= $3
  `, [username, `${period}-01`, `${period}-31`]);
  
  const exceptionCount = Number(result.rows[0]?.count || 0);
  if (exceptionCount > 0) return 0;

  // 兜底：当前业务主链路异常主要落在 anomaly_triggers -> 周度 anomaly_rollups_v2
  // 若本月周度扣分明细已有异常，不应再给“零异常+10”。
  const { startDate, endDate } = periodDateRange(period);
  const weekly = await pool().query(
    `SELECT deductions
     FROM agent_scores
     WHERE lower(username) = lower($1)
       AND score_model = 'anomaly_rollups_v2'
       AND period LIKE 'week_%'
       AND substring(period from 6 for 10)::date >= $2::date
       AND substring(period from 6 for 10)::date <= $3::date`,
    [username, startDate, endDate]
  );
  for (const row of weekly.rows || []) {
    const arr = parseJsonArrayMaybe(row.deductions);
    const hasPositive = arr.some((d) => Number(d?.points || 0) > 0);
    if (hasPositive) return 0;
  }
  return 10; // 零异常加10分
}

// 异常扣分规则：按类别+严重度+频率计算
// frequency: daily=每天最多扣1次, weekly=每周最多扣1次, monthly=每月最多扣1次
const DEDUCTION_RULES = {
  '实收营收异常':     { high: 40, medium: 20, low: 0, frequency: 'monthly' },
  '人效值异常':       { high: 20, medium: 10, low: 0, frequency: 'monthly' },
  '充值异常':         { high: 2,  medium: 1,  low: 0, frequency: 'daily' },
  '桌访异常':         { high: 10, medium: 5,  low: 0, frequency: 'weekly' },
  '桌访占比异常':     { high: 20, medium: 10, low: 0, frequency: 'monthly' },
  '总实收毛利率异常': { high: 40, medium: 20, low: 0, frequency: 'monthly' },
  '产品差评异常':     { high: 10, medium: 5,  low: 0, frequency: 'weekly' },
  '服务差评异常':     { high: 10, medium: 5,  low: 0, frequency: 'weekly' },
};

// 根据频率计算一个月内最多触发次数
function getMaxTriggers(frequency, period) {
  const days = getDaysInPeriod(period);
  if (frequency === 'daily') return days;        // 每天1次
  if (frequency === 'weekly') return Math.ceil(days / 7); // 每周1次（约4-5次）
  return 1; // monthly: 每月1次
}

// 计算异常扣分
async function calculateExceptionDeduction(username, period) {
  // 按类别+严重度分组查询
  const result = await pool().query(`
    SELECT category, severity, COUNT(*) as count FROM agent_issues 
    WHERE assignee_username = $1 AND created_at >= $2 AND created_at <= $3
    GROUP BY category, severity
  `, [username, `${period}-01`, `${period}-31`]);
  
  let totalDeduction = 0;
  for (const row of result.rows) {
    const rule = DEDUCTION_RULES[row.category];
    if (!rule) continue;
    const sev = String(row.severity || '').toLowerCase();
    if (sev === 'low') continue; // low不扣分
    const pointsPerTrigger = rule[sev] || 0;
    if (pointsPerTrigger === 0) continue;
    // 按频率限制最多触发次数
    const maxTriggers = getMaxTriggers(rule.frequency, period);
    const actualTriggers = Math.min(Number(row.count), maxTriggers);
    totalDeduction += actualTriggers * pointsPerTrigger;
  }

  return totalDeduction;
}

  // 兜底：agent_issues 没有数据时，从周度 anomaly_rollups_v2 汇总扣分，避免“整月无扣分”失真
  if (totalDeduction <= 0) {
    const { startDate, endDate } = periodDateRange(period);
    const weekly = await pool().query(
      `SELECT deductions
       FROM agent_scores
       WHERE lower(username) = lower($1)
         AND score_model = 'anomaly_rollups_v2'
         AND period LIKE 'week_%'
         AND substring(period from 6 for 10)::date >= $2::date
         AND substring(period from 6 for 10)::date <= $3::date`,
      [username, startDate, endDate]
    );
    let fallbackDeduction = 0;
    for (const row of weekly.rows || []) {
      const arr = parseJsonArrayMaybe(row.deductions);
      for (const d of arr) {
        const pts = Number(d?.points || 0);
        if (Number.isFinite(pts) && pts > 0) fallbackDeduction += pts;
      }
    }
    totalDeduction = fallbackDeduction;
  }

  return totalDeduction;
}

// 获取企微会员每月新增数量（洪潮店长执行力评级用）
async function getMonthlyNewWechatMembers(store, period) {
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = `${year}-${month}-31`;
  
  try {
    const result = await pool().query(`
      SELECT COALESCE(SUM(new_wechat_members), 0) as total
      FROM daily_reports 
      WHERE store = $1 AND date >= $2 AND date <= $3
    `, [store, startDate, endDate]);
    
    return Number(result.rows[0]?.total || 0);
  } catch (e) {
    console.warn('[wechat_members] query error:', e?.message);
    return 0;
  }
}

// ─────────────────────────────────────────────
// 9. 奖金计算函数
// ─────────────────────────────────────────────
export function calculateBonus(brand, storeRating, employeeScore) {
  const bonusBase = brand === '洪潮' ? 2000 : 1500; // 马己仙1500, 洪潮2000
  
  if (!storeRating || storeRating === 'D') {
    // D级：工资8折（返回特殊标记，由薪资模块处理）
    return { bonus: 0, salaryMultiplier: 0.8, reason: '门店D级，工资8折' };
  }
  
  if (storeRating === 'C') {
    // C级：奖金归0
    return { bonus: 0, salaryMultiplier: 1.0, reason: '门店C级，奖金归0' };
  }
  
  // A/B级：按个人得分比例拿奖金
  const scoreRatio = (employeeScore || 100) / 100;
  const bonus = Math.round(scoreRatio * bonusBase);
  return { bonus, salaryMultiplier: 1.0, reason: `门店${storeRating}级，得分${employeeScore}，系数${scoreRatio.toFixed(2)}` };
}
